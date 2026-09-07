import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../backends/provider';
import { Logger } from '../utils/logger';

// ---- CONTEXT COMPRESSION ----

/**
 * Sliding context window: when conversation gets too large,
 * compress older messages into a summary, keeping:
 * - System prompt (always)
 * - Last 6 message pairs (recent context)
 * - A compressed summary of everything in between
 */
export function compressContext(messages: ChatMessage[], logger: Logger, agentId: string): void {
  // Keep at least system + user + 12 recent messages (6 pairs)
  const KEEP_RECENT = 12;
  if (messages.length <= KEEP_RECENT + 2) return;

  const systemMsg = messages[0]; // System prompt
  const initialTaskMsg = messages[1]; // Original user task prompt
  const hasTaskMsg = initialTaskMsg && initialTaskMsg.role === 'user';
  const startIdx = hasTaskMsg ? 2 : 1;

  const recentMessages = messages.slice(-KEEP_RECENT);
  const middleMessages = messages.slice(startIdx, messages.length - KEEP_RECENT);
  if (middleMessages.length === 0) return;

  // Build a rich compressed summary of the middle messages preserving content excerpts
  const summaryParts: string[] = [];
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  const keyFindings: string[] = [];
  let toolCallCount = 0;

  for (const msg of middleMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallCount++;
        try {
          const args = JSON.parse(tc.function.arguments);
          switch (tc.function.name) {
            case 'read_file':
              filesRead.add(args.path);
              break;
            case 'write_file':
              filesWritten.add(args.path);
              break;
            case 'run_command':
              commandsRun.push(args.command?.substring(0, 80));
              break;
            case 'list_dir':
              filesRead.add(`DIR:${args.path}`);
              break;
          }
        } catch {
          /* skip */
        }
      }
    } else if (msg.role === 'tool') {
      const content = msg.content || '';
      const toolName = msg.name || 'tool';
      if (content.length > 0) {
        if (/error|fail|exception/i.test(content)) {
          const errExcerpt = content.length > 200 ? content.substring(0, 200) + '...' : content;
          keyFindings.push(`[${toolName} warning/error]: ${errExcerpt.replace(/\s+/g, ' ')}`);
        } else if (toolName === 'read_file' || toolName === 'run_command') {
          const excerpt = content.length > 150 ? content.substring(0, 150) + '... [truncated]' : content;
          keyFindings.push(`[${toolName} excerpt]: ${excerpt.replace(/\s+/g, ' ')}`);
        }
      }
    }
  }

  if (filesRead.size > 0) summaryParts.push(`Files read: ${[...filesRead].join(', ')}`);
  if (filesWritten.size > 0) summaryParts.push(`Files written: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) summaryParts.push(`Commands run: ${commandsRun.slice(-5).join('; ')}`);
  if (keyFindings.length > 0) {
    summaryParts.push(`Key discoveries & outputs:\n- ${keyFindings.slice(-6).join('\n- ')}`);
  }
  summaryParts.push(`Total tool calls compressed: ${toolCallCount}`);

  const compressedSummary: ChatMessage = {
    role: 'user',
    content: `[CONTEXT COMPRESSED - Previous ${middleMessages.length} messages summarized with key context preserved]\n${summaryParts.join('\n')}\n\nContinue your current task. The recent messages below are the active working context.`,
  };

  // Replace messages array in-place
  messages.length = 0;
  if (hasTaskMsg) {
    messages.push(systemMsg, initialTaskMsg, compressedSummary, ...recentMessages);
  } else {
    messages.push(systemMsg, compressedSummary, ...recentMessages);
  }

  logger.info(
    agentId,
    `Context compressed: ${middleMessages.length} messages -> 1 summary with key findings preserved. Keeping ${KEEP_RECENT} recent.`,
  );
}

// ---- FILESYSTEM SNAPSHOT ----

/**
 * Snapshot the filesystem state for stuck detection.
 * Returns a hash based on file count + total modification time.
 */
export function snapshotFilesystem(dir: string): number {
  try {
    let hash = 0;
    let count = 0;

    function walk(d: string, depth: number) {
      if (depth > 6) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile()) {
            count++;
            try {
              const stat = fs.statSync(full);
              hash += stat.mtimeMs + stat.size;
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    }

    walk(dir, 0);
    return count * 100000 + Math.round(hash % 1_000_000_000);
  } catch {
    return 0;
  }
}

/**
 * Get list of changed files since initial snapshot.
 * Compares modification times to detect files that were created or modified.
 */
export function getChangedFiles(projectRoot: string, initialSnapshotHash: number): string[] {
  const changed: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 6) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            // Check if file was modified in the last hour (proxy for "during this run")
            if (Date.now() - stat.mtimeMs < 60 * 60 * 1000) {
              changed.push(path.relative(projectRoot, full).replace(/\\/g, '/'));
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  try {
    walk(projectRoot, 0);
  } catch {
    /* skip */
  }

  return changed.slice(0, 50); // Cap at 50 files
}

// ---- RETRY WITH EXPONENTIAL BACKOFF ----

/**
 * Retry on transient errors with exponential backoff.
 * Handles: 429 rate limits, 500/502/503/504 server errors,
 * connection resets, timeouts, and malformed responses.
 *
 * Backoff: 3s, 6s, 12s (doubles each attempt)
 */
export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  logger: Logger,
  agentId: string,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const msg = err.message || '';
      const isTransient =
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('Rate limit') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('Gateway') ||
        msg.includes('gateway') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EPIPE') ||
        msg.includes('timed out') ||
        msg.includes('Request timed out') ||
        msg.includes('timeout') ||
        msg.includes('Timeout') ||
        msg.includes('Empty or malformed response') ||
        msg.includes('socket hang up') ||
        msg.includes('network');

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff: 3s, 6s, 12s
      const delayMs = 3000 * Math.pow(2, attempt);
      logger.warn(
        agentId,
        `Transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.substring(0, 120)}. Retrying in ${delayMs / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry failed');
}
