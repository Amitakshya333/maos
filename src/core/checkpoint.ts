/**
 * MAOS Checkpoint System
 *
 * Saves agent progress to disk at every iteration so that if MAOS
 * crashes mid-run, work can be recovered on restart.
 *
 * Checkpoint file: .maos/checkpoints/{taskId}.json
 *
 * What's saved:
 *   - Iteration number
 *   - Files changed so far (snapshot diff)
 *   - Last tool calls
 *   - Total tokens used
 *   - Agent state (idle count, seen files/dirs/searches)
 *   - Timestamp
 *
 * On restart, `maos start` calls recoverOrphanedTasks() which:
 *   1. Scans .maos/queue/active/ for tasks that were running when MAOS died
 *   2. Loads their checkpoint (if any)
 *   3. Moves them to pending with retry context injected
 *   4. Or marks them done if the checkpoint shows partial success
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMaosRoot, getActiveDir, getPendingDir, getDoneDir } from '../utils/paths';

// ---- Types ----

export interface TaskCheckpoint {
  /** Task ID */
  taskId: string;

  /** Agent that was working on this task */
  agentId: string;

  /** Current iteration (how far the agent got) */
  iteration: number;

  /** Max iterations budget */
  maxIterations: number;

  /** Percentage complete (iteration / maxIterations) */
  progressPct: number;

  /** Total tokens consumed so far */
  totalTokens: number;

  /** Files that were changed (relative paths) */
  filesChanged: string[];

  /** Last tool calls made (for context on resume) */
  lastToolCalls: Array<{ name: string; summary: string }>;

  /** Whether the agent was making progress when interrupted */
  wasProductive: boolean;

  /** Idle count from ProgressTracker */
  idleCount: number;

  /** Estimated cost so far */
  costUSD: number;

  /** Epoch ms when checkpoint was saved */
  savedAt: number;

  /** Epoch ms when the task started */
  startedAt: number;

  /** Brief summary of what the agent accomplished so far */
  progressSummary: string;

  /** How many retries this task has had */
  retryCount: number;
}

// ---- Checkpoint Directory ----

function getCheckpointDir(projectRoot: string): string {
  return path.join(getMaosRoot(projectRoot), 'checkpoints');
}

function getCheckpointPath(projectRoot: string, taskId: string): string {
  // Sanitize task ID for filesystem
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getCheckpointDir(projectRoot), `${safe}.json`);
}

function ensureCheckpointDir(projectRoot: string): void {
  const dir = getCheckpointDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---- Save / Load / Delete ----

/**
 * Save a checkpoint to disk.
 * Called after each iteration in the agent runner.
 */
export function saveCheckpoint(projectRoot: string, checkpoint: TaskCheckpoint): void {
  ensureCheckpointDir(projectRoot);
  const filePath = getCheckpointPath(projectRoot, checkpoint.taskId);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${Date.now()}_${Math.random().toString(36).substring(2, 6)}.tmp`,
  );
  fs.writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Load a checkpoint from disk.
 * Returns null if no checkpoint exists for this task.
 */
export function loadCheckpoint(projectRoot: string, taskId: string): TaskCheckpoint | null {
  const filePath = getCheckpointPath(projectRoot, taskId);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Delete a checkpoint (called when task completes successfully).
 */
export function deleteCheckpoint(projectRoot: string, taskId: string): void {
  const filePath = getCheckpointPath(projectRoot, taskId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * List all checkpoint files.
 */
export function listCheckpoints(projectRoot: string): TaskCheckpoint[] {
  const dir = getCheckpointDir(projectRoot);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const checkpoints: TaskCheckpoint[] = [];

  for (const file of files) {
    try {
      const cp = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      checkpoints.push(cp);
    } catch {
      // Skip corrupt checkpoint files
    }
  }

  return checkpoints;
}

// ---- Recovery Logic ----

export interface RecoveryResult {
  recovered: number;
  markedDone: number;
  details: Array<{
    taskId: string;
    action: 'requeued' | 'marked_done' | 'abandoned';
    reason: string;
    checkpoint?: TaskCheckpoint;
  }>;
}

/**
 * Scan for orphaned active tasks and recover them.
 *
 * Called by `maos start` before entering the main loop.
 *
 * Recovery strategy:
 *   1. If checkpoint shows > 60% progress + files changed → mark as DONE (partial success)
 *   2. If checkpoint shows < 60% progress → move back to PENDING (retry)
 *   3. If no checkpoint → move back to PENDING (clean retry)
 *   4. If retry count >= 3 → abandon (move to done with FAILED status)
 */
export function recoverOrphanedTasks(projectRoot: string): RecoveryResult {
  const activeDir = getActiveDir(projectRoot);
  const pendingDir = getPendingDir(projectRoot);
  const doneDir = getDoneDir(projectRoot);
  const result: RecoveryResult = { recovered: 0, markedDone: 0, details: [] };

  if (!fs.existsSync(activeDir)) return result;

  const activeFiles = fs.readdirSync(activeDir).filter((f) => f.endsWith('.md'));
  if (activeFiles.length === 0) return result;

  for (const file of activeFiles) {
    const activeFilePath = path.join(activeDir, file);
    const content = fs.readFileSync(activeFilePath, 'utf-8');

    // Extract task ID from frontmatter
    const idMatch = content.match(/^id:\s*(.+)$/m);
    const taskId = idMatch?.[1]?.trim() || file.replace('.md', '');

    // Load checkpoint if available
    const checkpoint = loadCheckpoint(projectRoot, taskId);

    if (checkpoint) {
      // Check retry count
      if (checkpoint.retryCount >= 3) {
        // Too many retries — abandon
        moveFile(activeFilePath, path.join(doneDir, file));
        appendToFrontmatter(path.join(doneDir, file), 'status', 'failed');
        appendToFrontmatter(path.join(doneDir, file), 'failure_reason', 'max_retries_exceeded');
        deleteCheckpoint(projectRoot, taskId);
        result.details.push({
          taskId,
          action: 'abandoned',
          reason: `Max retries (${checkpoint.retryCount}) exceeded`,
          checkpoint,
        });
        continue;
      }

      if (checkpoint.progressPct >= 0.6 && checkpoint.filesChanged.length > 0) {
        // Significant progress — mark as done (partial success)
        moveFile(activeFilePath, path.join(doneDir, file));
        appendToFrontmatter(path.join(doneDir, file), 'status', 'done');
        appendToFrontmatter(
          path.join(doneDir, file),
          'recovery_note',
          `Recovered from crash at ${checkpoint.progressPct * 100}% progress (${checkpoint.filesChanged.length} files changed)`,
        );
        deleteCheckpoint(projectRoot, taskId);
        result.markedDone++;
        result.details.push({
          taskId,
          action: 'marked_done',
          reason: `${Math.round(checkpoint.progressPct * 100)}% progress with ${checkpoint.filesChanged.length} files changed`,
          checkpoint,
        });
      } else {
        // Not enough progress — requeue for retry
        moveFile(activeFilePath, path.join(pendingDir, file));
        appendToFrontmatter(path.join(pendingDir, file), 'status', 'pending');
        appendToFrontmatter(path.join(pendingDir, file), 'retry_count', String(checkpoint.retryCount + 1));
        appendToFrontmatter(
          path.join(pendingDir, file),
          'retry_context',
          `Previous attempt reached ${Math.round(checkpoint.progressPct * 100)}% (${checkpoint.iteration}/${checkpoint.maxIterations} iterations). Files changed: [${checkpoint.filesChanged.join(', ')}]. Last actions: [${checkpoint.lastToolCalls.map((t) => t.name).join(', ')}]`,
        );

        // Update checkpoint retry count
        checkpoint.retryCount++;
        saveCheckpoint(projectRoot, checkpoint);

        result.recovered++;
        result.details.push({
          taskId,
          action: 'requeued',
          reason: `Only ${Math.round(checkpoint.progressPct * 100)}% progress — requeuing (retry #${checkpoint.retryCount})`,
          checkpoint,
        });
      }
    } else {
      // No checkpoint at all — move back to pending for clean retry
      moveFile(activeFilePath, path.join(pendingDir, file));
      appendToFrontmatter(path.join(pendingDir, file), 'status', 'pending');
      appendToFrontmatter(path.join(pendingDir, file), 'retry_count', '1');
      appendToFrontmatter(
        path.join(pendingDir, file),
        'retry_context',
        'Crashed before any checkpoint was saved. Clean retry.',
      );

      result.recovered++;
      result.details.push({
        taskId,
        action: 'requeued',
        reason: 'No checkpoint — clean retry',
      });
    }
  }

  return result;
}

// ---- Helpers ----

function moveFile(from: string, to: string): void {
  const content = fs.readFileSync(from, 'utf-8');
  fs.writeFileSync(to, content, 'utf-8');
  fs.unlinkSync(from);
}

function appendToFrontmatter(filePath: string, key: string, value: string): void {
  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, 'utf-8');

  // Check if key already exists in frontmatter
  const keyRegex = new RegExp(`^${key}:.*$`, 'm');
  if (keyRegex.test(content)) {
    // Replace existing key
    content = content.replace(keyRegex, `${key}: ${value}`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return;
  }

  // Insert before closing --- of frontmatter
  const lines = content.split('\n');
  let openIndex = -1;
  let closeIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') {
      if (openIndex === -1) {
        openIndex = i;
      } else {
        closeIndex = i;
        break;
      }
    }
  }

  if (openIndex !== -1 && closeIndex !== -1) {
    // Insert key: value right before the closing --- marker
    lines.splice(closeIndex, 0, `${key}: ${value}`);
    content = lines.join('\n');
  } else {
    // Fallback: prepend a fresh frontmatter block if none is present/valid
    content = `---\n${key}: ${value}\n---\n` + content;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}
