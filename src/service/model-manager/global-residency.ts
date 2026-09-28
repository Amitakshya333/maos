/**
 * Cross-process residency guard for the shared GPU model pool.
 *
 * Project hosts run in separate Node processes, so an in-memory singleton is
 * not sufficient to serialize model residency. This small registry is not a
 * model server; it is a fail-closed ownership guard. A dedicated model
 * manager can replace it later without changing lease callers.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface GlobalLease {
  leaseId: string;
  modelId: string;
  ownerPid: number;
  ownerInstanceId: string;
}

interface GlobalResidencyState {
  schemaVersion: 1;
  residentModelId: string | null;
  residentRevision: string | null;
  ownerPid: number | null;
  ownerInstanceId: string | null;
  activeLeases: GlobalLease[];
  updatedAt: string;
}

const LOCK_STALE_MS = 5_000;
const EMPTY_STATE: GlobalResidencyState = {
  schemaVersion: 1,
  residentModelId: null,
  residentRevision: null,
  ownerPid: null,
  ownerInstanceId: null,
  activeLeases: [],
  updatedAt: new Date(0).toISOString(),
};

const activeCoordinators = new Set<GlobalResidencyCoordinator>();
let exitHandlerInstalled = false;

function isProcessAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export class GlobalResidencyCoordinator {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly instanceId = crypto.randomBytes(16).toString('hex');

  constructor(statePath = path.join(os.tmpdir(), 'maos-global-model-residency.json')) {
    this.statePath = path.resolve(statePath);
    this.lockPath = `${this.statePath}.lock`;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    activeCoordinators.add(this);
    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.once('exit', () => {
        for (const coordinator of activeCoordinators) coordinator.releaseProcessSync();
      });
    }
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  assertCanAcquire(modelId: string): void {
    this.withLockedState((state) => {
      this.pruneDeadOwner(state);
      if (state.ownerPid === null || state.ownerInstanceId === this.instanceId) return;
      throw new Error(
        `CONCURRENCY_VIOLATION: model residency is owned by another live project service ` +
        `(model '${state.residentModelId || modelId}', pid ${state.ownerPid})`,
      );
    }, false);
  }

  claimLease(modelId: string, revision: string, leaseId: string): void {
    this.withLockedState((state) => {
      this.pruneDeadOwner(state);
      if (state.ownerPid !== null && state.ownerInstanceId !== this.instanceId) {
        throw new Error(
          `CONCURRENCY_VIOLATION: model residency is owned by another live project service (pid ${state.ownerPid})`,
        );
      }
      if (state.ownerPid === null) {
        state.ownerPid = process.pid;
        state.ownerInstanceId = this.instanceId;
      }
      if (state.residentModelId && state.residentModelId !== modelId && state.activeLeases.length > 0) {
        throw new Error(
          `CONCURRENCY_VIOLATION: model '${state.residentModelId}' has active global leases`,
        );
      }
      state.residentModelId = modelId;
      state.residentRevision = revision;
      if (!state.activeLeases.some((lease) => lease.leaseId === leaseId)) {
        state.activeLeases.push({ leaseId, modelId, ownerPid: process.pid, ownerInstanceId: this.instanceId });
      }
    });
  }

  releaseLease(leaseId: string): void {
    this.withLockedState((state) => {
      state.activeLeases = state.activeLeases.filter((lease) =>
        !(lease.leaseId === leaseId && lease.ownerInstanceId === this.instanceId),
      );
      if (state.activeLeases.length === 0 && state.ownerInstanceId === this.instanceId) {
        // Keep residency ownership until the local idle-unload path explicitly
        // releases it. This prevents another process loading while weights may
        // still be resident in this process.
      }
    });
  }

  unload(): void {
    this.withLockedState((state) => {
      if (state.ownerInstanceId !== this.instanceId) return;
      if (state.activeLeases.length > 0) {
        throw new Error('CONCURRENCY_VIOLATION: cannot unload residency with active global leases');
      }
      state.residentModelId = null;
      state.residentRevision = null;
      state.ownerPid = null;
      state.ownerInstanceId = null;
    });
  }

  releaseProcessSync(): void {
    try {
      this.withLockedState((state) => {
        state.activeLeases = state.activeLeases.filter((lease) => lease.ownerInstanceId !== this.instanceId);
        if (state.ownerInstanceId === this.instanceId && state.activeLeases.length === 0) {
          state.residentModelId = null;
          state.residentRevision = null;
          state.ownerPid = null;
          state.ownerInstanceId = null;
        }
      });
    } catch {
      // Process exit is best effort; the next owner prunes a dead PID.
    }
  }

  private pruneDeadOwner(state: GlobalResidencyState): void {
    if (state.ownerPid !== null && !isProcessAlive(state.ownerPid)) {
      state.residentModelId = null;
      state.residentRevision = null;
      state.ownerPid = null;
      state.ownerInstanceId = null;
      state.activeLeases = [];
    }
  }

  private readState(): GlobalResidencyState {
    if (!fs.existsSync(this.statePath)) return { ...EMPTY_STATE, activeLeases: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (err: any) {
      throw new Error(`GLOBAL_RESIDENCY_CORRUPT: cannot parse registry: ${err.message}`);
    }
    const state = parsed as Partial<GlobalResidencyState>;
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.activeLeases) ||
      (state.ownerPid !== null && !Number.isInteger(state.ownerPid)) ||
      (state.ownerInstanceId !== null && typeof state.ownerInstanceId !== 'string') ||
      (state.residentModelId !== null && typeof state.residentModelId !== 'string')
    ) {
      throw new Error('GLOBAL_RESIDENCY_CORRUPT: registry schema is invalid');
    }
    return {
      schemaVersion: 1,
      residentModelId: state.residentModelId ?? null,
      residentRevision: state.residentRevision ?? null,
      ownerPid: state.ownerPid ?? null,
      ownerInstanceId: state.ownerInstanceId ?? null,
      activeLeases: state.activeLeases as GlobalLease[],
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : new Date(0).toISOString(),
    };
  }

  private withLockedState<T>(mutate: (state: GlobalResidencyState) => T, persist = true): T {
    const lockFd = this.acquireLock();
    try {
      const state = this.readState();
      const result = mutate(state);
      state.updatedAt = new Date().toISOString();
      if (persist) this.writeState(state);
      return result;
    } finally {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(this.lockPath); } catch {}
    }
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        return fd;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number; createdAt?: number };
          const stale = typeof lock.createdAt !== 'number' || Date.now() - lock.createdAt > LOCK_STALE_MS;
          if (stale || !isProcessAlive(lock.pid ?? null)) fs.unlinkSync(this.lockPath);
        } catch {
          try { fs.unlinkSync(this.lockPath); } catch {}
        }
        sleepSync(10);
      }
    }
    throw new Error('GLOBAL_RESIDENCY_LOCK_TIMEOUT: could not acquire global residency lock');
  }

  private writeState(state: GlobalResidencyState): void {
    const tempPath = `${this.statePath}.tmp_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      // The state is protected by the lock. On Windows, replace an existing
      // file explicitly because rename does not consistently overwrite it.
      if (process.platform === 'win32' && fs.existsSync(this.statePath)) fs.unlinkSync(this.statePath);
      fs.renameSync(tempPath, this.statePath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }
}
