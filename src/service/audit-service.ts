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
const AUDIT_LOCK_RECLAIM_FILE = `${AUDIT_LOCK_FILE}.reclaim`;
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
   * The complete owner record is atomically published, so a contender cannot
   * observe a partially written lock. A lock whose owner PID is no longer alive
   * is reclaimed under a separate marker; malformed locks fail closed because
   * no trustworthy owner can be established.
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
        held = this.createExclusiveLockFile(this.auditLockPath);
      } catch (err: any) {
        throw new Error(`AUDIT_LOCK_FAILED: ${err.message}`);
      }

      if (!held) {
        // The owner record is atomically published (via hard link), so an
        // unreadable lock is corruption rather than an in-progress write. Fail
        // closed on that ambiguity instead of deleting a possibly-live lock.
        this.tryReclaimAbandonedLock();
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

  /**
   * Publish a fully-written lock record in one atomic filesystem operation.
   * `writeFileSync(..., { flag: 'wx' })` creates the destination before writing
   * its contents; a competing process can observe an empty/partial file and
   * mistakenly reclaim a live lock. A same-directory hard link is atomic and
   * only succeeds if the destination does not already exist.
   */
  private createExclusiveLockFile(lockPath: string): boolean {
    const tempPath = `${lockPath}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      try {
        fs.linkSync(tempPath, lockPath);
        return true;
      } catch (err: any) {
        if (err.code === 'EEXIST') return false;
        throw err;
      }
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // A leftover unique temp file is harmless; the published link, if any,
        // owns the lock record independently.
      }
    }
  }

  /**
   * Reclaim a dead owner's lock while serializing reclaimers. A malformed lock
   * or an interrupted reclaim marker is never deleted automatically: that is
   * safer than guessing and allowing two writers into the critical section.
   */
  private tryReclaimAbandonedLock(): void {
    let reclaimHeld = false;
    try {
      reclaimHeld = this.createExclusiveLockFile(path.join(this.auditDir, AUDIT_LOCK_RECLAIM_FILE));
    } catch {
      // Reclamation is best effort. The append loop will fail closed on timeout.
      return;
    }
    if (!reclaimHeld) return;

    const reclaimPath = path.join(this.auditDir, AUDIT_LOCK_RECLAIM_FILE);
    try {
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(fs.readFileSync(this.auditLockPath, 'utf-8')) as { pid?: unknown };
      } catch {
        // The lock is absent or malformed. Do not unlink an unknown owner.
        return;
      }

      if (!Number.isSafeInteger(owner.pid) || isProcessAlive(Number(owner.pid))) return;
      try {
        fs.unlinkSync(this.auditLockPath);
      } catch {
        // Another process already removed it; the outer loop retries.
      }
    } finally {
      try {
        fs.unlinkSync(reclaimPath);
      } catch {
        // Best effort; a leftover marker causes future writers to fail closed.
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
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            schemaVersion: 1,
            recordCount,
            latestHash,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
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
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* best effort */
        }
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
      errors.push(
        `AUDIT_HEAD_HASH_MISMATCH: expected ${head.latestHash || '<empty>'}, found ${latestHash || '<empty>'}`,
      );
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
  public recordAuditEvent(params: AuditEventParams, mockRustFailure = false): AuditRecord {
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
    const dataObj = params.data && typeof params.data === 'object' && !Array.isArray(params.data) ? params.data : {};

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

    const chainRes = this.verifyChainRecords(records);
    const errors = [...headErrors, ...chainRes.errors];

    return {
      valid: chainRes.valid && headErrors.length === 0,
      recordCount: records.length,
      errors,
      verifiedAt: chainRes.verifiedAt,
      latestHash: records[records.length - 1].hash,
      executableHash: manifest.executableHash,
    };
  }

  /**
   * Authoritative Rust-backed chain verification for an arbitrary list of audit records.
   * Validates structural continuity, schema integrity, and cryptographic record hashes.
   */
  public verifyChainRecords(records: AuditRecord[]): AuditChainVerification {
    const manifest = this.getEngineManifest();
    const verifiedAt = new Date().toISOString();

    if (!Array.isArray(records) || records.length === 0) {
      return {
        valid: false,
        recordCount: 0,
        errors: ['Audit record list is empty or not an array.'],
        verifiedAt,
        latestHash: '',
        executableHash: manifest.executableHash,
      };
    }

    const structureErrors: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (typeof r !== 'object' || r === null) {
        structureErrors.push(`Record at index ${i} is not a valid object.`);
        continue;
      }
      if (r.sequence !== i) {
        structureErrors.push(`Sequence continuity break at index ${i}: expected sequence ${i}, found ${r.sequence}.`);
      }
      if (i === 0) {
        if (r.previous_hash !== '') {
          structureErrors.push(`Genesis record 0 has non-empty previous_hash: '${r.previous_hash}'.`);
        }
      } else {
        const expectedPrev = records[i - 1]?.hash;
        if (r.previous_hash !== expectedPrev) {
          structureErrors.push(
            `Hash chain link break at sequence ${i}: previous_hash '${r.previous_hash}' does not match record ${i - 1} hash '${expectedPrev}'.`,
          );
        }
      }
      if (!validateAuditCategory(r.category)) {
        structureErrors.push(`Record at sequence ${i} has invalid audit category: '${r.category}'.`);
      }
      if (typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(r.hash)) {
        structureErrors.push(`Record at sequence ${i} has malformed hash: '${r.hash}'.`);
      }
    }

    if (structureErrors.length > 0) {
      return {
        valid: false,
        recordCount: records.length,
        errors: structureErrors,
        verifiedAt,
        latestHash: records[records.length - 1]?.hash ?? '',
        executableHash: manifest.executableHash,
      };
    }

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

    return {
      valid: engineErrors.length === 0,
      recordCount: records.length,
      errors: engineErrors,
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
