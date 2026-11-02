/**
 * TASK DEV-A-01 (Dev A): thread persistence service.
 *
 * Disk-backed threads: each thread is one JSON file at
 * `.maos/ring-runs/threads/<threadId>.json`. Every read goes through disk,
 * so a restarted service (or a new instance on the same project root)
 * rebuilds thread state from stored history with no in-memory authority.
 * Run transcripts (`.maos/ring-runs/<runId>.jsonl`) remain the history of
 * record; threads only link run ids.
 *
 * Thread ids match `isRingThreadId`: `thread-<epochMs>-<8 hex>`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_RING_ROLE, RING_THREAD_DIR, isRingRole, isRingThreadId } from './ring-contract';
import type { RingRole, RingThread } from './ring-contract';

export interface RingThreadStore {
  createThread(title?: string, role?: RingRole): RingThread;
  getThread(threadId: string): RingThread | undefined;
  appendRun(threadId: string, runId: string): RingThread;
  listThreadIds(): string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail-closed parse: malformed thread JSON never poisons callers. */
function parseThreadFile(raw: string): RingThread | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (!isRingThreadId(parsed.threadId)) return undefined;
  if (typeof parsed.title !== 'string') return undefined;
  if (!isRingRole(parsed.role)) return undefined;
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) return undefined;
  if (!Array.isArray(parsed.runs) || parsed.runs.some((r) => typeof r !== 'string')) return undefined;
  return {
    threadId: parsed.threadId,
    title: parsed.title,
    role: parsed.role,
    createdAt: parsed.createdAt,
    runs: [...(parsed.runs as string[])],
  };
}

export class RingThreadService implements RingThreadStore {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private threadsDir(): string {
    return path.resolve(this.projectRoot, RING_THREAD_DIR);
  }

  private threadPath(threadId: string): string {
    return path.join(this.threadsDir(), `${threadId}.json`);
  }

  /** Create a thread and persist it. Unknown roles fail closed to `operator`. */
  createThread(title?: string, role?: RingRole): RingThread {
    const safeTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Ring thread';
    const safeRole: RingRole = isRingRole(role) ? role : DEFAULT_RING_ROLE;
    const thread: RingThread = {
      threadId: `thread-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      title: safeTitle,
      role: safeRole,
      createdAt: new Date().toISOString(),
      runs: [],
    };
    fs.mkdirSync(this.threadsDir(), { recursive: true });
    this.writeAtomic(this.threadPath(thread.threadId), `${JSON.stringify(thread, null, 2)}\n`);
    return { ...thread, runs: [] as string[] };
  }

  /** Read-through from disk; undefined when missing or malformed. */
  getThread(threadId: string): RingThread | undefined {
    if (!isRingThreadId(threadId)) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(this.threadPath(threadId), 'utf-8');
    } catch {
      return undefined;
    }
    return parseThreadFile(raw);
  }

  /** Append a run id and persist. Throws when the thread does not exist. */
  appendRun(threadId: string, runId: string): RingThread {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`RING_THREAD_NOT_FOUND: thread '${threadId}' was not found.`);
    }
    if (typeof runId !== 'string' || !runId) {
      throw new Error('RING_THREAD_INVALID: runId is required and must be a non-empty string.');
    }
    if (!thread.runs.includes(runId)) thread.runs.push(runId);
    this.writeAtomic(this.threadPath(thread.threadId), `${JSON.stringify(thread, null, 2)}\n`);
    return thread;
  }

  listThreadIds(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.threadsDir());
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((id) => isRingThreadId(id))
      .sort();
  }

  private writeAtomic(dest: string, content: string): void {
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, dest);
  }
}
