/**
 * Audit Application Service (F3-06)
 *
 * Implements an append-only, tamper-evident audit log backed by the Rust
 * industrial engine.
 *
 * Guarantees:
 * - Strictly sequential sequence numbering (0..N-1)
 * - Canonical SHA-256 hash linking (previous_hash -> hash)
 * - Automatic sensitive data redaction (passwords, tokens, keys)
 * - Bounded disk persistence with durable fsync
 * - Rust engine authoritative chain verification
 * - Fail-closed on missing binary, tampered binary, or corrupted chain
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AuditCategory,
  AuditRecord,
  AuditChainVerification,
  AuditEventParams,
  AuditFilter,
  validateAuditCategory,
  validateAuditRecord,
} from '../domain';
import { redactSensitive } from '../core/redaction';
import {
  verifyExecutable,
  engineChainAppend,
  engineChainVerify,
  engineChainVerifyRequestSizeBytes,
  getDefaultEnginePath,
  EngineManifest,
  MAX_ENGINE_REQUEST_BYTES,
} from '../industrial/rust-engine-bridge';
import { isProcessAlive } from '../industrial/service-startup';

/**
 * Inter-process append lock.
 *
 * The chain append is read-modify-write: read the log, derive `sequence` from the
 * record count, compute the hash (which spawns the Rust engine, taking
 * milliseconds), then append and update the head. Two processes interleaving in
 * that window both derive the same sequence and both link to the same
 * predecessor, forking the chain and desynchronising the head — after which every
 * subsequent append throws `CORRUPT_AUDIT_LOG` and the chain can no longer be
 * extended or verified.
 *
 * The window cannot be closed by atomicity inside one process, so it is closed
 * across processes instead.
 */
const AUDIT_LOCK_FILE = 'audit-chain.lock';
/** Total time to wait for a competing writer before failing closed. */
const AUDIT_LOCK_TIMEOUT_MS = 5_000;
/** Backoff between acquisition attempts. */
const AUDIT_LOCK_RETRY_MS = 5;

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export class AuditService {
  private readonly auditDir: string;
  private readonly auditFilePath: string;
  private readonly auditHeadPath: string;
  private readonly auditLockPath: string;
  private readonly auditLockTimeoutMs: number;

  constructor(
    private readonly projectRoot: string,
    private readonly customEnginePath?: string,
    options: { lockTimeoutMs?: number } = {},
  ) {
    this.auditDir = path.join(this.projectRoot, '.maos', 'audit');
    this.auditFilePath = path.join(this.auditDir, 'audit-chain.jsonl');
    this.auditHeadPath = path.join(this.auditDir, 'audit-head.json');
    this.auditLockPath = path.join(this.auditDir, AUDIT_LOCK_FILE);
    this.auditLockTimeoutMs = options.lockTimeoutMs ?? AUDIT_LOCK_TIMEOUT_MS;
    this.ensureDirectory();
    if (!fs.existsSync(this.auditFilePath) && !fs.existsSync(this.auditHeadPath)) {
      this.writeAuditHead(0, '');
    }
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }
  }

  /**
   * Runs `fn` while holding the cross-process audit append lock.
   *
   * The lock is taken with an exclusive create, so acquisition is atomic. A lock
   * whose owner PID is no longer alive is stolen immediately — a dead process
   * cannot be mid-append, and unlike a long-running lifecycle lock there is no
   * legitimate reason for an audit lock to outlive its owner.
   *
   * If the lock cannot be acquired within the budget this throws rather than
   * appending unlocked: a refused append is recoverable, a forked chain is not.
   */
  private withAppendLock<T>(fn: () => T): T {
    const deadline = Date.now() + this.auditLockTimeoutMs;
    const timeoutError = () =>
      new Error(
        'AUDIT_LOCK_TIMEOUT: another process is appending to the audit chain. ' +
          'Refusing to append without the lock, because concurrent appends fork the chain.',
      );

    let held = false;

    while (!held) {
      // Checked at the top of every iteration, including the reclaim path: if
      // removing an abandoned lock keeps failing (for example the file is open
      // without delete-sharing on Windows), the loop must still terminate.
      if (Date.now() >= deadline) {
        throw timeoutError();
      }

      try {
        fs.writeFileSync(
          this.auditLockPath,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          { encoding: 'utf-8', flag: 'wx' },
        );
        held = true;
      } catch (err: any) {
        if (err.code !== 'EEXIST') {
          throw new Error(`AUDIT_LOCK_FAILED: ${err.message}`);
        }

        // Lock exists. Steal it if its owner is dead, or if it is unreadable.
        let stole = false;
        try {
          const data = JSON.parse(fs.readFileSync(this.auditLockPath, 'utf-8'));
          if (!isProcessAlive(Number(data.pid))) stole = true;
        } catch {
          // Corrupt lock file: no live owner can be established, so reclaim it.
          stole = true;
        }

        if (stole) {
          try {
            fs.unlinkSync(this.auditLockPath);
          } catch {
            // Another process reclaimed it first, or it cannot be removed;
            // either way the loop re-checks the deadline before retrying.
          }
          continue;
        }

        sleepSync(AUDIT_LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(this.auditLockPath);
      } catch {
        // Already removed; nothing to release.
      }
    }
  }

  private readAuditHead(): { recordCount: number; latestHash: string } | null {
    if (!fs.existsSync(this.auditHeadPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.auditHeadPath, 'utf8')) as Record<string, unknown>;
      if (
        parsed.schemaVersion !== 1 ||
        !Number.isSafeInteger(parsed.recordCount) ||
        Number(parsed.recordCount) < 0 ||
        typeof parsed.latestHash !== 'string' ||
        (Number(parsed.recordCount) > 0 && !/^[a-f0-9]{64}$/i.test(parsed.latestHash)) ||
        (Number(parsed.recordCount) === 0 && parsed.latestHash !== '')
      ) {
        return null;
      }
      return { recordCount: Number(parsed.recordCount), latestHash: parsed.latestHash };
    } catch {
      return null;
    }
  }

  private writeAuditHead(recordCount: number, latestHash: string): void {
    this.ensureDirectory();
    const tempPath = `${this.auditHeadPath}.tmp_${process.pid}_${Date.now()}`;
    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({
        schemaVersion: 1,
        recordCount,
        latestHash,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tempPath, this.auditHeadPath);
    } catch {
      try {
        if (fs.existsSync(this.auditHeadPath)) {
          fs.unlinkSync(this.auditHeadPath);
        }
        fs.renameSync(tempPath, this.auditHeadPath);
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        throw err;
      }
    }
  }

  private auditHeadErrors(records: readonly AuditRecord[]): string[] {
    const head = this.readAuditHead();
    if (!head) return ['AUDIT_HEAD_MISSING_OR_INVALID'];
    const latestHash = records.length > 0 ? records[records.length - 1].hash : '';
    const errors: string[] = [];
    if (head.recordCount !== records.length) {
      errors.push(`AUDIT_HEAD_COUNT_MISMATCH: expected ${head.recordCount}, found ${records.length}`);
    }
    if (head.latestHash !== latestHash) {
      errors.push(`AUDIT_HEAD_HASH_MISMATCH: expected ${head.latestHash || '<empty>'}, found ${latestHash || '<empty>'}`);
    }
    return errors;
  }

  private resolveEnginePath(): string {
    if (this.customEnginePath) {
      return this.customEnginePath;
    }
    const localPath = getDefaultEnginePath(this.projectRoot);
    if (fs.existsSync(localPath)) {
      return localPath;
    }
    const cwdPath = getDefaultEnginePath(process.cwd());
    if (fs.existsSync(cwdPath)) {
      return cwdPath;
    }
    return localPath;
  }

  private getEngineManifest(): EngineManifest {
    const enginePath = this.resolveEnginePath();
    return verifyExecutable(enginePath);
  }

  /**
   * Read all persisted audit records from disk.
   */
  private readAllRecords(): AuditRecord[] {
    if (!fs.existsSync(this.auditFilePath)) {
      return [];
    }

    const content = fs.readFileSync(this.auditFilePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    const lines = content.trim().split('\n');
    const records: AuditRecord[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as AuditRecord;
        records.push(parsed);
      } catch (err: any) {
        throw new Error(`CORRUPT_AUDIT_LOG: Line ${i + 1} contains invalid JSON: ${err.message}`);
      }
    }

    return records;
  }

  /**
   * Append an audit event to the tamper-evident chain.
   *
   * 1. Validates category and source.
   * 2. Recursively redacts sensitive credentials/tokens/keys from payload.
   * 3. Determines next sequence number and previous record hash.
   * 4. Computes authoritative SHA-256 via Rust engine ('chain-append').
   * 5. Atomically appends and fsyncs record to .maos/audit/audit-chain.jsonl.
   */
  public recordAuditEvent(
    params: AuditEventParams,
    mockRustFailure = false,
  ): AuditRecord {
    // 1. Validate Category
    const catValidation = validateAuditCategory(params.category);
    if (!catValidation.valid) {
      throw new Error(`INVALID_AUDIT_CATEGORY: ${catValidation.errors.join(', ')}`);
    }

    // 2. Validate Source
    if (!params.source || typeof params.source !== 'string' || !params.source.trim()) {
      throw new Error('INVALID_AUDIT_SOURCE: source identifier is required.');
    }

    // 3. Validate Data
    const dataObj =
      params.data && typeof params.data === 'object' && !Array.isArray(params.data)
        ? params.data
        : {};

    // 4. Redact sensitive content
    const { sanitized } = redactSensitive(dataObj);
    const sanitizedData = sanitized as Record<string, unknown>;

    // 5–8. Read-modify-write of the chain, performed under the cross-process
    // append lock. Everything from deriving the sequence to committing the head
    // must be inside the critical section, because the window includes a
    // subprocess call (the Rust engine) during which another process could
    // otherwise derive the same sequence and fork the chain.
    return this.withAppendLock(() => {
      // 5. Read existing records to find sequence & previous_hash
      this.ensureDirectory();
      const existingRecords = this.readAllRecords();
      const headErrors = this.auditHeadErrors(existingRecords);
      if (headErrors.length > 0) {
        throw new Error(`CORRUPT_AUDIT_LOG: ${headErrors.join('; ')}`);
      }
      const sequence = existingRecords.length;
      const previous_hash = sequence === 0 ? '' : existingRecords[sequence - 1].hash;
      const timestamp = params.timestamp || new Date().toISOString();

      // 6. Authoritative Rust Engine Hash
      if (mockRustFailure) {
        throw new Error('RUST_CHAIN_FAILED: Simulated Rust engine failure for audit append');
      }

      const manifest = this.getEngineManifest();
      const engineRes = engineChainAppend(manifest, {
        sequence,
        previous_hash,
        timestamp,
        source: params.source.trim(),
        category: params.category,
        data: sanitizedData,
      });

      if ('error' in engineRes) {
        throw new Error(`RUST_CHAIN_FAILED: ${engineRes.message}`);
      }

      const computed = engineRes.data as { hash?: string };
      if (!computed || typeof computed.hash !== 'string' || !computed.hash) {
        throw new Error('RUST_CHAIN_FAILED: Engine did not return a valid record hash');
      }

      const hash = computed.hash;

      // 7. Assemble Record
      const record: AuditRecord = {
        schemaVersion: 1,
        sequence,
        previous_hash,
        timestamp,
        source: params.source.trim(),
        category: params.category,
        data: sanitizedData,
        hash,
      };

      // Validate assembled record against domain validator
      const recordVal = validateAuditRecord(record);
      if (!recordVal.valid) {
        throw new Error(`INVALID_AUDIT_RECORD: ${recordVal.errors.join(', ')}`);
      }

      // 8. Durable Append to Disk
      const line = JSON.stringify(record) + '\n';
      const fd = fs.openSync(this.auditFilePath, 'a');
      try {
        fs.writeSync(fd, line, undefined, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.writeAuditHead(sequence + 1, hash);

      return record;
    });
  }

  /**
   * Verify the integrity of the audit chain using the Rust engine.
   *
   * Verifies:
   * 1. Sequence continuity starting at 0.
   * 2. Previous hash links.
   * 3. Canonical recomputed SHA-256 for every record.
   * 4. Deletion, insertion, and reordering detection.
   */
  public verifyChain(mockRustFailure = false): AuditChainVerification {
    const manifest = this.getEngineManifest();
    const verifiedAt = new Date().toISOString();

    if (!fs.existsSync(this.auditFilePath)) {
      const headErrors = this.auditHeadErrors([]);
      return {
        valid: headErrors.length === 0,
        recordCount: 0,
        errors: headErrors,
        verifiedAt,
        latestHash: '',
        executableHash: manifest.executableHash,
      };
    }

    let records: AuditRecord[];
    try {
      records = this.readAllRecords();
    } catch (err: any) {
      return {
        valid: false,
        recordCount: 0,
        errors: [err.message],
        verifiedAt,
        latestHash: '',
        executableHash: manifest.executableHash,
      };
    }

    const headErrors = this.auditHeadErrors(records);
    if (records.length === 0) {
      return {
        valid: headErrors.length === 0,
        recordCount: 0,
        errors: headErrors,
        verifiedAt,
        latestHash: '',
        executableHash: manifest.executableHash,
      };
    }

    // Always run the authoritative chain verifier for non-empty logs, even
    // when the local head anchor disagrees. The anchor detects suffix
    // truncation, while Rust provides the actionable sequence/link/hash
    // diagnostics for deletion and reordering.
    if (mockRustFailure) {
      throw new Error('RUST_VERIFY_FAILED: Simulated Rust engine failure for chain verification');
    }

    // Prepare the chain once, then send it to Rust in byte-bounded windows.
    // Each window is anchored to the preceding persisted hash; Rust verifies
    // both that boundary link and every record's absolute sequence/hash.
    const engineChain = records.map((r) => ({
      sequence: r.sequence,
      previous_hash: r.previous_hash,
      timestamp: r.timestamp,
      source: r.source,
      category: r.category,
      data: r.data,
      hash: r.hash,
    }));

    const engineErrors: string[] = [];
    let start = 0;
    while (start < engineChain.length) {
      const previousHash = start === 0 ? '' : engineChain[start - 1].hash;
      const options = { startSequence: start, previousHash };
      // The empty-chain envelope has the same fixed request fields. Add each
      // serialized record and its comma incrementally to avoid repeatedly
      // serializing the growing candidate window while packing it.
      let requestBytes = engineChainVerifyRequestSizeBytes([], options);
      const window: typeof engineChain = [];

      while (start + window.length < engineChain.length) {
        const record = engineChain[start + window.length];
        const recordBytes = Buffer.byteLength(JSON.stringify(record));
        const nextSize = requestBytes + recordBytes + (window.length > 0 ? 1 : 0);
        if (nextSize > MAX_ENGINE_REQUEST_BYTES) break;
        window.push(record);
        requestBytes = nextSize;
      }

      if (window.length === 0) {
        throw new Error(
          `RUST_VERIFY_REQUEST_TOO_LARGE: audit record at sequence ${start} cannot fit within the ${MAX_ENGINE_REQUEST_BYTES}-byte Rust request limit.`,
        );
      }

      const verifyRes = engineChainVerify(manifest, window, options);
      if ('error' in verifyRes) {
        throw new Error(`RUST_VERIFY_FAILED: ${verifyRes.message}`);
      }

      const result = verifyRes.data as {
        valid: boolean;
        record_count: number;
        errors: string[];
      };
      const windowErrors = Array.isArray(result.errors) ? result.errors : [];
      engineErrors.push(...windowErrors);
      if (Number(result.record_count) !== window.length) {
        engineErrors.push(
          `Rust engine verified ${Number(result.record_count)} records for the window starting at sequence ${start}; expected ${window.length}`,
        );
      }
      if (!result.valid && windowErrors.length === 0) {
        engineErrors.push(`Rust engine reported an invalid chain window starting at sequence ${start}`);
      }
      start += window.length;
    }

    const errors = [...headErrors, ...engineErrors];

    return {
      valid: engineErrors.length === 0 && errors.length === 0,
      recordCount: records.length,
      errors,
      verifiedAt,
      latestHash: records[records.length - 1].hash,
      executableHash: manifest.executableHash,
    };
  }

  /**
   * Retrieve filtered audit records from disk.
   */
  public getRecords(filter?: AuditFilter): AuditRecord[] {
    let records = this.readAllRecords();

    if (!filter) {
      return records;
    }

    if (filter.category) {
      records = records.filter((r) => r.category === filter.category);
    }

    if (filter.source) {
      records = records.filter((r) => r.source === filter.source);
    }

    if (filter.fromSeq !== undefined) {
      records = records.filter((r) => r.sequence >= filter.fromSeq!);
    }

    if (filter.toSeq !== undefined) {
      records = records.filter((r) => r.sequence <= filter.toSeq!);
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      records = records.slice(0, filter.limit);
    }

    return records;
  }

  /**
   * Retrieve a specific audit record by sequence number.
   */
  public getRecordBySequence(seq: number): AuditRecord | null {
    const records = this.readAllRecords();
    return records.find((r) => r.sequence === seq) || null;
  }

  /**
   * Export the entire audit trail with current verification status.
   */
  public exportAuditTrail(): {
    records: AuditRecord[];
    verification: AuditChainVerification;
  } {
    const records = this.readAllRecords();
    const verification = this.verifyChain();
    return { records, verification };
  }
}
