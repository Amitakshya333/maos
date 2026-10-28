import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly runId: string;
}

const projectOutputContext = new AsyncLocalStorage<Set<string>>();

export class JudgedRunBusyError extends Error {
  readonly code = 'JUDGED_RUN_BUSY';

  constructor(runId: string) {
    super(`Judged-run resource '${runId}' is already being changed; retry after the active operation finishes.`);
    this.name = 'JudgedRunBusyError';
  }
}

export class JudgedRunLockError extends Error {
  readonly code = 'JUDGED_RUN_LOCK_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'JudgedRunLockError';
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Unknown permission/platform errors are treated as alive so a lock is never
    // removed unless this process can establish that its owner has exited.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function publishLock(lockPath: string, owner: LockOwner): boolean {
  const temporaryPath = `${lockPath}.tmp-${owner.token}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
    try {
      fs.linkSync(temporaryPath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* The published hard link is independent. */ }
  }
}

function readOwner(lockPath: string): LockOwner {
  let owner: Partial<LockOwner>;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
  } catch (error) {
    throw new JudgedRunLockError(`Cannot verify judged-run lock '${lockPath}': ${String(error)}. Leave it in place and inspect it before recovery.`);
  }
  if (!Number.isSafeInteger(owner.pid) || typeof owner.host !== 'string' || typeof owner.token !== 'string' || typeof owner.runId !== 'string') {
    throw new JudgedRunLockError(`Cannot verify judged-run lock '${lockPath}': owner record is malformed. Leave it in place and inspect it before recovery.`);
  }
  return owner as LockOwner;
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  if (!fs.existsSync(lockPath)) return;
  const current = readOwner(lockPath);
  if (current.token !== owner.token) {
    throw new JudgedRunLockError(`Judged-run lock '${lockPath}' changed owner before release; refusing to remove it.`);
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (fs.existsSync(lockPath)) {
      throw new JudgedRunLockError(`Could not release judged-run lock '${lockPath}': ${String(error)}`);
    }
  }
}

function reclaimAbandonedLock(lockPath: string, runId: string): void {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimOwner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: crypto.randomUUID(),
    runId,
  };
  try {
    if (!publishLock(reclaimPath, reclaimOwner)) throw new JudgedRunBusyError(runId);
  } catch (error) {
    if (error instanceof JudgedRunBusyError || error instanceof JudgedRunLockError) throw error;
    throw new JudgedRunLockError(`Could not serialize judged-run lock recovery: ${String(error)}`);
  }

  try {
    if (!fs.existsSync(lockPath)) return;
    const owner = readOwner(lockPath);
    if (owner.runId !== runId || owner.host !== os.hostname() || processIsAlive(owner.pid)) {
      throw new JudgedRunBusyError(runId);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (fs.existsSync(lockPath)) throw new JudgedRunLockError(`Could not reclaim abandoned judged-run lock '${lockPath}': ${String(error)}`);
    }
  } finally {
    releaseLock(reclaimPath, reclaimOwner);
  }
}

function acquireLock(projectRoot: string, runId: string): { path: string; owner: LockOwner } {
  if (!/^judged-run-[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid judged run ID.');
  const lockPath = path.join(projectRoot, '.maos', 'industrial-runs', `${runId}.lock`);
  const owner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: crypto.randomUUID(),
    runId,
  };

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (!publishLock(lockPath, owner)) {
      reclaimAbandonedLock(lockPath, runId);
      if (!publishLock(lockPath, owner)) throw new JudgedRunBusyError(runId);
    }
  } catch (error) {
    if (error instanceof JudgedRunBusyError || error instanceof JudgedRunLockError) throw error;
    throw new JudgedRunLockError(`Could not acquire judged-run lock '${lockPath}': ${String(error)}`);
  }
  return { path: lockPath, owner };
}

/** Serializes one logical run across local API/CLI processes; lock failures fail closed. */
export function withJudgedRunLock<T>(projectRoot: string, runId: string, operation: () => T): T {
  // shortcut: this lock coordinates one host's local filesystem only; upgrade if projects move to shared multi-host storage.
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(projectRoot);
  } catch (error) {
    throw new JudgedRunLockError(`Could not resolve judged-run project root '${projectRoot}': ${String(error)}`);
  }
  const held = acquireLock(canonicalRoot, runId);
  let result: T;
  try {
    result = operation();
  } catch (error) {
    releaseLock(held.path, held.owner);
    throw error;
  }

  if (result && typeof (result as any).then === 'function') {
    return Promise.resolve(result).finally(() => releaseLock(held.path, held.owner)) as T;
  }
  releaseLock(held.path, held.owner);
  return result;
}

/** Acquire this before shared-output or per-run locks whenever generated output may change. */
export function withJudgedRunOutputLock<T>(projectRoot: string, operation: () => T): T {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(projectRoot);
  } catch (error) {
    throw new JudgedRunLockError(`Could not resolve project output root '${projectRoot}': ${String(error)}`);
  }

  const held = projectOutputContext.getStore();
  if (held?.has(canonicalRoot)) return operation();

  const next = new Set(held || []);
  next.add(canonicalRoot);
  return withJudgedRunLock(canonicalRoot, 'judged-run-project-output', () =>
    projectOutputContext.run(next, operation));
}
