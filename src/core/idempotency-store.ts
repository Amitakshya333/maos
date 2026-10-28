/**
 * Durable Idempotency Store (F3-07)
 *
 * Implements crash-safe, atomic mutation idempotency on disk.
 *
 * Guarantees:
 * - Atomic claims: prevents two concurrent requests from both executing the same mutation.
 * - Exact replay: replaying with identical payload returns the exact previous result.
 * - Conflict detection: replaying with a different payload returns IDEMPOTENCY_CONFLICT (409).
 * - Authorization safety: replaying with a different authorization context fails closed.
 * - Crash recovery: recovers stale in_progress records after timeout.
 * - Survives service restarts: state is durably written to .maos/idempotency/ with fsync.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { IdempotencyRecord, IdempotencyStatus } from '../domain/schemas';
import { withJudgedRunLock } from '../industrial/judged-run-lock';

export type ClaimOutcome =
  | { outcome: 'claimed'; record: IdempotencyRecord }
  | { outcome: 'replay'; record: IdempotencyRecord }
  | { outcome: 'conflict'; reason: string; message: string }
  | { outcome: 'in_progress'; reason: string; message: string }
  | { outcome: 'auth_mismatch'; reason: string; message: string }
  | { outcome: 'failed'; record: IdempotencyRecord };

export interface ClaimParams {
  key: string;
  requestHash: string;
  operation: string;
  projectId: string;
  requestIdentityHash?: string;
  authContext?: string;
}

export class DurableIdempotencyStore {
  private readonly storeDir: string;
  private readonly staleTimeoutMs: number;

  constructor(private readonly projectRoot: string, staleTimeoutMs = 30_000) {
    this.storeDir = path.join(this.projectRoot, '.maos', 'idempotency');
    this.staleTimeoutMs = staleTimeoutMs;
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  private getRecordPath(key: string): string {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.storeDir, `${keyHash}.json`);
  }

  private withKeyLock<T>(key: string, operation: () => T): T {
    const lockId = `judged-run-idempotency-${crypto.createHash('sha256').update(key).digest('hex')}`;
    return withJudgedRunLock(this.projectRoot, lockId, operation);
  }

  public getCanonicalProjectIdentity(): string {
    const realRoot = fs.realpathSync(this.projectRoot);
    return process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  }

  /**
   * Attempt to claim an idempotency key atomically.
   */
  public claim(params: ClaimParams): ClaimOutcome {
    try {
      return this.withKeyLock(params.key, () => this.claimUnderKeyLock(params));
    } catch (error: any) {
      if (error?.code === 'JUDGED_RUN_BUSY') {
        return {
          outcome: 'in_progress',
          reason: 'CONCURRENT_MUTATION',
          message: `Operation for Idempotency-Key '${params.key}' is currently being claimed.`,
        };
      }
      throw error;
    }
  }

  private claimUnderKeyLock(params: ClaimParams): ClaimOutcome {
    this.ensureDirectory();
    const filePath = this.getRecordPath(params.key);

    if (fs.existsSync(filePath)) {
      let existing: IdempotencyRecord;
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IdempotencyRecord;
      } catch {
        // Corrupt state is removed only while holding the per-key process lock.
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          return { outcome: 'conflict', reason: 'IDEMPOTENCY_STATE_CORRUPT', message: `Idempotency-Key '${params.key}' has unreadable state and cannot be safely reused: ${String(error)}` };
        }
        return this.claimUnderKeyLock(params);
      }

      if (params.requestIdentityHash && !existing.requestIdentityHash) {
        return {
          outcome: 'conflict',
          reason: 'IDEMPOTENCY_CONTEXT_UNAVAILABLE',
          message: `Idempotency-Key '${params.key}' has an older record without the required operation context; use a new key.`,
        };
      }

      if (existing.requestIdentityHash !== params.requestIdentityHash) {
        return {
          outcome: 'conflict',
          reason: 'IDEMPOTENCY_CONFLICT',
          message: `Idempotency-Key '${params.key}' was previously used for a different operation context.`,
        };
      }

      // Check request hash
      if (existing.requestHash !== params.requestHash) {
        return {
          outcome: 'conflict',
          reason: 'IDEMPOTENCY_CONFLICT',
          message: `Idempotency-Key '${params.key}' was previously executed with a different request payload.`,
        };
      }

      // Check authorization context
      if (existing.authContext && params.authContext && existing.authContext !== params.authContext) {
        return {
          outcome: 'auth_mismatch',
          reason: 'AUTHORIZATION_MISMATCH',
          message: `Idempotency-Key '${params.key}' was previously executed with a different authorization context.`,
        };
      }

      if (existing.operation !== params.operation || existing.projectId !== params.projectId) {
        return {
          outcome: 'conflict',
          reason: 'IDEMPOTENCY_CONFLICT',
          message: `Idempotency-Key '${params.key}' was previously used for a different operation or project.`,
        };
      }

      // Check status
      if (existing.status === 'in_progress') {
        const ageMs = Date.now() - new Date(existing.createdAt).getTime();
        if (ageMs < this.staleTimeoutMs) {
          return {
            outcome: 'in_progress',
            reason: 'CONCURRENT_MUTATION',
            message: `Operation for Idempotency-Key '${params.key}' is currently in progress.`,
          };
        }
        // Stale in_progress record (crash recovery) — overwrite with fresh claim
      } else if (existing.status === 'completed') {
        return { outcome: 'replay', record: existing };
      } else if (existing.status === 'failed') {
        return { outcome: 'failed', record: existing };
      } else if (existing.status === 'retryable') {
        // A lock-busy attempt owns no successful result; a fresh claim may retry.
      }
    }

    // Atomic claim via exclusive file creation ('wx')
    const inProgressRecord: IdempotencyRecord = {
      schemaVersion: 1,
      key: params.key,
      requestHash: params.requestHash,
      requestIdentityHash: params.requestIdentityHash,
      claimToken: crypto.randomUUID(),
      operation: params.operation,
      projectId: params.projectId,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      authContext: params.authContext,
    };

    try {
      const fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'w' : 'wx');
      const content = JSON.stringify(inProgressRecord, null, 2);
      fs.writeSync(fd, content, undefined, 'utf-8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return { outcome: 'claimed', record: inProgressRecord };
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Race condition: another caller claimed concurrently
        return this.claimUnderKeyLock(params);
      }
      throw err;
    }
  }

  /**
   * Complete an operation and record the response atomically.
   */
  public complete(
    key: string,
    responseStatus: number,
    responsePayload: unknown,
    resultReference?: string,
  ): IdempotencyRecord {
    return this.withKeyLock(key, () => this.completeUnderKeyLock(key, responseStatus, responsePayload, resultReference));
  }

  private completeUnderKeyLock(
    key: string,
    responseStatus: number,
    responsePayload: unknown,
    resultReference?: string,
  ): IdempotencyRecord {
    this.ensureDirectory();
    const filePath = this.getRecordPath(key);
    let existing: Partial<IdempotencyRecord> = {};

    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {}
    }

    const rawPayload = JSON.stringify(responsePayload ?? null);
    const responseHash = crypto.createHash('sha256').update(rawPayload).digest('hex');

    const completedRecord: IdempotencyRecord = {
      schemaVersion: 1,
      key,
      requestHash: existing.requestHash || '',
      requestIdentityHash: existing.requestIdentityHash,
      claimToken: existing.claimToken,
      operation: existing.operation || 'mutation',
      projectId: existing.projectId || 'default',
      status: 'completed',
      responseStatus,
      responseHash,
      responsePayload,
      resultReference,
      createdAt: existing.createdAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      authContext: existing.authContext,
    };

    // Atomic durable write
    const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, JSON.stringify(completedRecord, null, 2), undefined, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
      } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        throw err;
      }
    }

    return completedRecord;
  }

  /**
   * Mark an operation as failed.
   */
  public fail(key: string, errorMessage: string): void {
    this.withKeyLock(key, () => this.failUnderKeyLock(key, errorMessage));
  }

  private failUnderKeyLock(key: string, errorMessage: string): void {
    this.ensureDirectory();
    const filePath = this.getRecordPath(key);
    if (!fs.existsSync(filePath)) return;

    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const failedRecord: IdempotencyRecord = {
        ...existing,
        status: 'failed',
        resultReference: errorMessage,
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(failedRecord, null, 2), 'utf-8');
    } catch {}
  }

  /** Mark only this request's fresh claim retryable after a contention refusal. */
  public releaseForRetry(key: string, claimToken: string | undefined, reason: string): boolean {
    if (!claimToken) return false;
    return this.withKeyLock(key, () => {
      const filePath = this.getRecordPath(key);
      if (!fs.existsSync(filePath)) return false;
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IdempotencyRecord;
        if (existing.status !== 'in_progress' || existing.claimToken !== claimToken) return false;
        const retryable: IdempotencyRecord = {
          ...existing,
          status: 'retryable',
          resultReference: reason,
          completedAt: undefined,
        };
        const tempPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
        const fd = fs.openSync(tempPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify(retryable, null, 2), undefined, 'utf-8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        try {
          fs.renameSync(tempPath, filePath);
        } catch {
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tempPath, filePath);
          } catch (error) {
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
            throw error;
          }
        }
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Get an existing record by key.
   */
  public getRecord(key: string): IdempotencyRecord | null {
    const filePath = this.getRecordPath(key);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  /**
   * List all stored idempotency records.
   */
  public list(): IdempotencyRecord[] {
    this.ensureDirectory();
    const records: IdempotencyRecord[] = [];
    if (!fs.existsSync(this.storeDir)) return records;
    const files = fs.readdirSync(this.storeDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp'));
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.storeDir, f), 'utf-8'));
        records.push(raw as IdempotencyRecord);
      } catch {}
    }
    return records;
  }

  /**
   * Clear all records (testing/cleanup).
   */
  public clear(): void {
    if (fs.existsSync(this.storeDir)) {
      const files = fs.readdirSync(this.storeDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(this.storeDir, f));
          } catch {}
        }
      }
    }
  }
}
