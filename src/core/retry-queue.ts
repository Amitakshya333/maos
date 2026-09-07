/**
 * MAOS Retry Queue
 *
 * Dead-letter queue and retry policy for failed tasks.
 *
 * Before: failed = gone. One transient 504 → permanent failure.
 * After:  failed tasks go to .maos/queue/retry/ with backoff metadata.
 *         On each poll, the orchestrator checks for retry-eligible tasks
 *         and moves them back to pending with error context injected.
 *
 * Retry Policy (per agent in config):
 *   maxRetries: 3        (default) — attempts before dead-lettering
 *   retryDelayMs: 30000  (default) — minimum wait before retry
 *   retryBackoff: 2.0    (default) — multiply delay by this each attempt
 *
 * Retry Tiers:
 *   Attempt 1 → wait 30s  (transient error, likely a 504)
 *   Attempt 2 → wait 60s  (service degraded)
 *   Attempt 3 → wait 120s (last chance)
 *   Attempt 4+ → dead-letter (move to .maos/queue/failed/)
 *
 * Context injection on retry:
 *   The agent gets a "PREVIOUS ATTEMPT FAILED" note prepended to the task,
 *   so it can avoid the same mistakes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMaosRoot, getPendingDir, getDoneDir } from '../utils/paths';
import { TaskFile } from './queue';

// ---- Retry Directory ----

export function getRetryDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'queue', 'retry');
}

export function getFailedDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'queue', 'failed');
}

function ensureRetryDirs(cwd?: string): void {
  for (const dir of [getRetryDir(cwd), getFailedDir(cwd)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ---- Types ----

export interface RetryRecord {
  taskId: string;
  agentId: string;
  attemptNumber: number;
  maxRetries: number;
  lastError: string;
  lastErrorType:
    'timeout' | 'provider_error' | 'auth_failure' | 'scope_violation' | 'max_iterations' | 'crash' | 'unknown';
  retryAfterMs: number; // Epoch ms — don't retry before this time
  retryDelayMs: number; // How long we're waiting this round
  createdAt: number;
  lastAttemptAt: number;
  filesChangedSoFar: string[];
  iterationsCompleted: number;
  /**
   * When true, the orchestrator should blacklist this agent on retry
   * and let the router pick an alternate runtime.
   *
   * Set when: errorType === 'crash' OR attemptNumber >= 2.
   * If no alternate runtime exists, falls back to original agent.
   */
  preferAlternateRuntime: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 30_000, // 30s first retry
  backoffMultiplier: 2.0, // 30s → 60s → 120s
};

// ---- Error Classification ----

/**
 * Classify an error to determine if it's worth retrying and how.
 */
export function classifyError(errorMessage: string): RetryRecord['lastErrorType'] {
  const msg = errorMessage.toLowerCase();

  // Auth failures — NEVER retry (key is wrong, not transient)
  if (
    msg.includes('401') ||
    msg.includes('authentication failed') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid.*key') ||
    msg.includes('check your api key') ||
    msg.includes('api key is') ||
    msg.includes('not authenticated')
  ) {
    return 'auth_failure';
  }

  if (
    msg.includes('504') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('gateway') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up')
  ) {
    return 'timeout';
  }

  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('provider') ||
    msg.includes('api error') ||
    msg.includes('model error')
  ) {
    return 'provider_error';
  }

  if (msg.includes('scope violation') || msg.includes('write_blocked') || msg.includes('file_locked')) {
    return 'scope_violation';
  }

  if (msg.includes('max_iterations') || msg.includes('max iterations')) {
    return 'max_iterations';
  }

  if (msg.includes('crash') || msg.includes('uncaught') || msg.includes('unhandled')) {
    return 'crash';
  }

  return 'unknown';
}

/**
 * Decide if this error type should be retried at all.
 * Scope violations are NOT retried — the task itself is wrong.
 */
export function isRetryable(errorType: RetryRecord['lastErrorType']): boolean {
  switch (errorType) {
    case 'timeout':
    case 'provider_error':
    case 'crash':
      return true;
    case 'max_iterations':
      return true; // Worth retrying — agent might do better with retry context
    case 'auth_failure':
      return false; // Credential error — retrying won't help, dead-letter immediately
    case 'scope_violation':
      return false; // Task configuration error, not a transient failure
    case 'unknown':
      return true; // Give it a chance
  }
}

// ---- Retry Queue Operations ----

function getRetryRecordPath(cwd: string | undefined, taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getRetryDir(cwd), `${safe}.json`);
}

function getRetryTaskPath(cwd: string | undefined, taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getRetryDir(cwd), `${safe}.md`);
}

/**
 * Move a failed task to the retry queue with backoff.
 * Returns the retry record, or null if the task should be dead-lettered.
 */
export function enqueueRetry(
  taskFile: TaskFile,
  taskContent: string,
  error: string,
  filesChangedSoFar: string[],
  iterationsCompleted: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  cwd?: string,
): RetryRecord | null {
  ensureRetryDirs(cwd);

  const errorType = classifyError(error);

  if (!isRetryable(errorType)) {
    deadLetter(taskFile, taskContent, error, 'not_retryable', cwd);
    return null;
  }

  // Load existing retry record (if any)
  const recordPath = getRetryRecordPath(cwd, taskFile.id);
  let record: RetryRecord | null = null;

  if (fs.existsSync(recordPath)) {
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    } catch {
      /* corrupted, start fresh */
    }
  }

  const attemptNumber = (record?.attemptNumber ?? 0) + 1;

  if (attemptNumber > policy.maxRetries) {
    deadLetter(taskFile, taskContent, error, 'max_retries_exceeded', cwd);
    // Clean up retry record
    if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
    const taskPath = getRetryTaskPath(cwd, taskFile.id);
    if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
    return null;
  }

  // Calculate backoff delay
  const delayMs = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attemptNumber - 1);
  const retryAfterMs = Date.now() + delayMs;

  const newRecord: RetryRecord = {
    taskId: taskFile.id,
    agentId: taskFile.agent,
    attemptNumber,
    maxRetries: policy.maxRetries,
    lastError: error.substring(0, 500),
    lastErrorType: errorType,
    retryAfterMs,
    retryDelayMs: delayMs,
    createdAt: record?.createdAt ?? Date.now(),
    lastAttemptAt: Date.now(),
    filesChangedSoFar,
    iterationsCompleted,
    // Reroute to alternate runtime if this was a crash or repeated failure
    preferAlternateRuntime: errorType === 'crash' || attemptNumber >= 2,
  };

  // Save retry record
  fs.writeFileSync(recordPath, JSON.stringify(newRecord, null, 2), 'utf-8');

  // Save task content in retry dir (with retry context injected)
  const enrichedContent = injectRetryContext(taskContent, newRecord);
  const taskPath = getRetryTaskPath(cwd, taskFile.id);
  fs.writeFileSync(taskPath, enrichedContent, 'utf-8');

  return newRecord;
}

/**
 * Move a task to the dead-letter queue (permanently failed).
 */
export function deadLetter(taskFile: TaskFile, taskContent: string, error: string, reason: string, cwd?: string): void {
  ensureRetryDirs(cwd);
  const failedDir = getFailedDir(cwd);
  const safe = taskFile.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = path.join(failedDir, `${safe}.md`);

  const content =
    taskContent +
    `\n\n---\n\n## ❌ Dead Letter\n\n` +
    `**Reason**: ${reason}\n` +
    `**Error**: ${error.substring(0, 300)}\n` +
    `**Time**: ${new Date().toISOString()}\n`;

  fs.writeFileSync(outPath, content, 'utf-8');
}

/**
 * Check if any retry-eligible tasks are ready to be re-queued.
 * Called by the orchestrator poll loop.
 *
 * Returns the number of tasks moved to pending.
 */
export function drainRetryQueue(cwd?: string): number {
  ensureRetryDirs(cwd);
  const retryDir = getRetryDir(cwd);
  const pendingDir = getPendingDir(cwd);
  const now = Date.now();
  let count = 0;

  // Find all retry records
  const records = fs
    .readdirSync(retryDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(retryDir, f), 'utf-8')) as RetryRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RetryRecord => r !== null);

  for (const record of records) {
    if (now < record.retryAfterMs) continue; // Not ready yet

    const safe = record.taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskPath = path.join(retryDir, `${safe}.md`);
    const recordPath = path.join(retryDir, `${safe}.json`);

    if (!fs.existsSync(taskPath)) {
      // Task file missing — clean up orphaned record
      if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
      continue;
    }

    // Move task to pending
    const pendingPath = path.join(pendingDir, `${safe}.md`);
    const content = fs.readFileSync(taskPath, 'utf-8');
    // Update status back to pending in frontmatter
    const updated = content.replace(/^status:\s*.+$/m, 'status: pending');
    fs.writeFileSync(pendingPath, updated, 'utf-8');

    // Clean up retry files
    fs.unlinkSync(taskPath);
    fs.unlinkSync(recordPath);

    count++;
  }

  return count;
}

/**
 * Get all tasks currently waiting in the retry queue.
 */
export function getRetryQueueStatus(cwd?: string): Array<RetryRecord & { readyInMs: number }> {
  ensureRetryDirs(cwd);
  const retryDir = getRetryDir(cwd);
  const now = Date.now();

  return fs
    .readdirSync(retryDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(retryDir, f), 'utf-8')) as RetryRecord;
        return { ...record, readyInMs: Math.max(0, record.retryAfterMs - now) };
      } catch {
        return null;
      }
    })
    .filter((r): r is RetryRecord & { readyInMs: number } => r !== null);
}

/**
 * Get tasks in the dead-letter (permanently failed) queue.
 */
export function getDeadLetterQueue(cwd?: string): Array<{ taskId: string; file: string }> {
  const failedDir = getFailedDir(cwd);
  if (!fs.existsSync(failedDir)) return [];

  return fs
    .readdirSync(failedDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      taskId: f.replace('.md', ''),
      file: path.join(failedDir, f),
    }));
}

// ---- Context Injection ----

/**
 * Inject retry context into a task file so the agent learns from previous failures.
 */
function injectRetryContext(taskContent: string, record: RetryRecord): string {
  const waitSecs = Math.round(record.retryDelayMs / 1000);

  const retryNote = [
    ``,
    `## ⚠️ RETRY CONTEXT (Attempt ${record.attemptNumber}/${record.maxRetries})`,
    ``,
    `This task was previously attempted and failed. Learn from what happened:`,
    ``,
    `**Previous failure**: ${record.lastErrorType.toUpperCase()}`,
    `**Error**: ${record.lastError.substring(0, 200)}`,
    `**Iterations completed**: ${record.iterationsCompleted}`,
    `**Files changed before failure**: ${record.filesChangedSoFar.length > 0 ? record.filesChangedSoFar.join(', ') : 'none'}`,
    ``,
    `**What to do differently this attempt**:`,
    ...(record.lastErrorType === 'timeout'
      ? [
          `- The previous attempt timed out. Be more focused and efficient.`,
          `- Break the work into smaller steps. Commit early and often.`,
          `- Don't re-read files you've already read unless necessary.`,
        ]
      : []),
    ...(record.lastErrorType === 'max_iterations'
      ? [
          `- The previous attempt ran out of iterations without completing.`,
          `- Start with the most critical parts of the task first.`,
          `- Call task_complete even if not 100% done — partial completion is fine.`,
        ]
      : []),
    ...(record.lastErrorType === 'provider_error'
      ? [
          `- The previous attempt encountered API errors. The service may have been degraded.`,
          `- If you encounter errors, use simpler requests with less context.`,
        ]
      : []),
    `- If you find the files from previous attempts, continue from where they left off.`,
  ].join('\n');

  // Append retry note before the Instructions section
  if (taskContent.includes('## Instructions')) {
    return taskContent.replace('## Instructions', retryNote + '\n\n## Instructions');
  }

  return taskContent + retryNote;
}
