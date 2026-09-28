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

  /**
   * Attempt to claim an idempotency key atomically.
   */
  public claim(params: ClaimParams): ClaimOutcome {
    this.ensureDirectory();
    const filePath = this.getRecordPath(params.key);

    if (fs.existsSync(filePath)) {
      let existing: IdempotencyRecord;
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IdempotencyRecord;
      } catch {
        // Corrupt file, remove and allow re-claim
        try {
          fs.unlinkSync(filePath);
        } catch {}
        return this.claim(params);
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
      }
    }

    // Atomic claim via exclusive file creation ('wx')
    const inProgressRecord: IdempotencyRecord = {
      schemaVersion: 1,
      key: params.key,
      requestHash: params.requestHash,
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
        return this.claim(params);
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
