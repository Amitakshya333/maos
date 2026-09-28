/**
 * F5-03: Local Knowledge-Base CPU Embedding Service
 *
 * Implements bounded, provenance-preserving sentence embeddings for knowledge-base
 * chunks using the pinned offline sentence-transformers/all-MiniLM-L6-v2 CPU model.
 *
 * Core Invariants:
 * 1. Pinned Model: strictly all-MiniLM-L6-v2 (384-d, float32, CPU).
 * 2. Zero Synthetic Embeddings: random, hash-derived, or keyword vectors are prohibited.
 * 3. Air-Gapped / Offline: fails closed if offline snapshot assets are missing or tampered;
 *    zero runtime network downloads.
 * 4. F5-02 Provenance Preserved: every vector retains project ID, document ID, chunk ID,
 *    source hash, document version, model ID, revision, and dimension.
 * 5. Bounded Vectors: exactly 384 finite numbers, strictly no NaN, Infinity, or unbounded magnitude.
 * 6. Audited Operations: records model load/inference events without logging raw sensitive text.
 * 7. ModelManager Integration: leases CPU model cleanly without interfering with GPU VLM residency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  PINNED_EMBEDDING_CONFIG,
  EMBEDDING_BOUNDS,
  EmbeddingError,
  EmbeddingErrorCode,
  EmbeddingSnapshotManifest,
  ChunkEmbeddingRecord,
  EmbeddingInput,
  EmbeddingBatchInput,
  EmbeddingBatchResult,
  validateEmbeddingSnapshotManifest,
  validateEmbeddingVector,
  validateChunkEmbeddingRecord,
} from '../domain/embedding';
import { AuditService } from './audit-service';
import { SharedModelManager } from './model-manager';

export interface EmbeddingServiceOptions {
  pythonExecutable?: string;
  engineScriptPath?: string;
  customManifestPath?: string;
  customSnapshotDir?: string;
  skipAudit?: boolean;
  /** Test hook to provide simulated/fixture model inference output without external Python. */
  _mockInference?: (texts: string[]) => number[][];
}

export class EmbeddingService {
  private readonly manifestPath: string;
  private readonly snapshotDir: string;
  private readonly pythonExecutable: string;
  private readonly engineScriptPath: string;

  constructor(
    private readonly projectRoot: string,
    private readonly audit?: AuditService,
    private readonly modelManager?: SharedModelManager,
    private readonly options: EmbeddingServiceOptions = {},
  ) {
    this.manifestPath =
      options.customManifestPath ||
      path.join(this.projectRoot, PINNED_EMBEDDING_CONFIG.manifestPath);
    this.snapshotDir =
      options.customSnapshotDir ||
      path.join(
        this.projectRoot,
        'offline-stores',
        'model-snapshot',
        PINNED_EMBEDDING_CONFIG.snapshotRelativePath,
      );
    this.pythonExecutable = options.pythonExecutable || 'python';
    this.engineScriptPath =
      options.engineScriptPath ||
      path.resolve(__dirname, '..', 'industrial', 'python', 'embedding_engine.py');
  }

  /**
   * Return immutable model metadata and configuration.
   */
  public getModelInfo() {
    return {
      modelId: PINNED_EMBEDDING_CONFIG.modelId,
      modelName: PINNED_EMBEDDING_CONFIG.modelName,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      architecture: PINNED_EMBEDDING_CONFIG.architecture,
      dimension: PINNED_EMBEDDING_CONFIG.dimension,
      device: PINNED_EMBEDDING_CONFIG.device,
      quantization: PINNED_EMBEDDING_CONFIG.quantization,
      maxInputTokens: PINNED_EMBEDDING_CONFIG.maxInputTokens,
      maxInputChars: PINNED_EMBEDDING_CONFIG.maxInputChars,
      maxBatchSize: EMBEDDING_BOUNDS.maxBatchSize,
      license: PINNED_EMBEDDING_CONFIG.license,
    };
  }

  /**
   * Verify an offline snapshot directory against its manifest.
   * Fails closed if missing, malformed, tampered, or escaping path boundaries.
   */
  public validateSnapshot(
    manifestPath: string = this.manifestPath,
    snapshotDir: string = this.snapshotDir,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!fs.existsSync(manifestPath)) {
      return { valid: false, errors: [`Manifest not found at ${manifestPath}`] };
    }

    let manifest: EmbeddingSnapshotManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err: any) {
      return { valid: false, errors: [`Malformed manifest JSON: ${err.message}`] };
    }

    const manifestValidation = validateEmbeddingSnapshotManifest(manifest);
    if (!manifestValidation.valid) {
      return manifestValidation;
    }

    if (manifest.model !== PINNED_EMBEDDING_CONFIG.modelId) {
      errors.push(`Manifest model "${manifest.model}" does not match pinned model "${PINNED_EMBEDDING_CONFIG.modelId}"`);
    }

    if (manifest.revision !== PINNED_EMBEDDING_CONFIG.revision) {
      errors.push(`Manifest revision "${manifest.revision}" does not match pinned revision "${PINNED_EMBEDDING_CONFIG.revision}"`);
    }

    if (manifest.dimension !== PINNED_EMBEDDING_CONFIG.dimension) {
      errors.push(`Manifest dimension "${manifest.dimension}" does not match pinned dimension "${PINNED_EMBEDDING_CONFIG.dimension}"`);
    }

    if (!fs.existsSync(snapshotDir)) {
      errors.push(`Snapshot directory not found: ${snapshotDir}`);
      return { valid: false, errors };
    }

    // Path confinement & symlink escape checks
    let canonicalSnapshot: string;
    try {
      canonicalSnapshot = fs.realpathSync(snapshotDir);
    } catch (err: any) {
      return { valid: false, errors: [`Snapshot path cannot be canonicalized: ${err.message}`] };
    }

    const offlineStoreRoot = path.resolve(this.projectRoot, 'offline-stores', 'model-snapshot');
    if (fs.existsSync(offlineStoreRoot)) {
      try {
        const canonicalStore = fs.realpathSync(offlineStoreRoot);
        const rel = path.relative(canonicalStore, canonicalSnapshot);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          errors.push('Snapshot directory resolves outside the approved offline store');
        }
      } catch (err: any) {
        errors.push(`Offline store root cannot be canonicalized: ${err.message}`);
      }
    }

    // Check each declared file
    for (const file of manifest.files) {
      const filePath = path.resolve(canonicalSnapshot, file.path);
      const relative = path.relative(canonicalSnapshot, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`Snapshot manifest file path escapes snapshot directory: ${file.path}`);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        errors.push(`Missing model snapshot file: ${file.path}`);
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = fs.realpathSync(filePath);
      } catch {
        errors.push(`Model snapshot file cannot be canonicalized: ${file.path}`);
        continue;
      }

      const fileRel = path.relative(canonicalSnapshot, canonicalFile);
      if (!fileRel || fileRel.startsWith('..') || path.isAbsolute(fileRel)) {
        errors.push(`Model snapshot file symlink escapes snapshot directory: ${file.path}`);
        continue;
      }

      const stat = fs.statSync(canonicalFile);
      if (!stat.isFile()) {
        errors.push(`Snapshot entry is not a regular file: ${file.path}`);
        continue;
      }
      if (stat.size !== file.size) {
        errors.push(`Size mismatch for ${file.path}: expected ${file.size}, got ${stat.size}`);
        continue;
      }

      const actualHash = this.hashFile(canonicalFile);
      if (actualHash.toLowerCase() !== file.sha256.toLowerCase()) {
        errors.push(`SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Generate 384-dimensional normalized vectors for a batch of text chunks.
   * Strictly enforces bounds, offline snapshot validation, vector sanity, and F5-02 provenance.
   */
  public async generateEmbeddings(
    batch: EmbeddingBatchInput,
    leaseId?: string,
  ): Promise<EmbeddingBatchResult> {
    const startTime = Date.now();

    // 1. Cross-project validation
    if (!batch.projectId || typeof batch.projectId !== 'string') {
      throw new EmbeddingError('CROSS_PROJECT', 'projectId is required and must be a non-empty string');
    }

    // 2. Batch size bounds
    if (!Array.isArray(batch.items) || batch.items.length === 0) {
      throw new EmbeddingError('BATCH_TOO_LARGE', 'Batch must contain at least 1 item');
    }
    if (batch.items.length > EMBEDDING_BOUNDS.maxBatchSize) {
      throw new EmbeddingError(
        'BATCH_TOO_LARGE',
        `Batch size (${batch.items.length}) exceeds maximum limit (${EMBEDDING_BOUNDS.maxBatchSize})`,
        { count: batch.items.length, max: EMBEDDING_BOUNDS.maxBatchSize },
      );
    }

    // 3. Individual and cumulative bytes bounds
    let totalBatchBytes = 0;
    const texts: string[] = [];
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      if (!item || typeof item.text !== 'string' || item.text.trim().length === 0) {
        throw new EmbeddingError('OVERSIZED_INPUT', `Item at index ${i} has empty or invalid text`);
      }
      if (item.text.length > EMBEDDING_BOUNDS.maxTextLength) {
        throw new EmbeddingError(
          'OVERSIZED_INPUT',
          `Item at index ${i} length (${item.text.length} chars) exceeds maximum (${EMBEDDING_BOUNDS.maxTextLength})`,
          { index: i, length: item.text.length, max: EMBEDDING_BOUNDS.maxTextLength },
        );
      }
      const itemBytes = Buffer.byteLength(item.text, 'utf-8');
      if (itemBytes > EMBEDDING_BOUNDS.maxInputBytes) {
        throw new EmbeddingError(
          'OVERSIZED_INPUT',
          `Item at index ${i} bytes (${itemBytes}) exceeds maximum (${EMBEDDING_BOUNDS.maxInputBytes})`,
          { index: i, bytes: itemBytes, max: EMBEDDING_BOUNDS.maxInputBytes },
        );
      }
      totalBatchBytes += itemBytes;
      texts.push(item.text);
    }

    if (totalBatchBytes > EMBEDDING_BOUNDS.maxTotalBatchBytes) {
      throw new EmbeddingError(
        'BATCH_BYTES_EXCEEDED',
        `Total batch bytes (${totalBatchBytes}) exceeds maximum limit (${EMBEDDING_BOUNDS.maxTotalBatchBytes})`,
        { bytes: totalBatchBytes, max: EMBEDDING_BOUNDS.maxTotalBatchBytes },
      );
    }

    // 4. Offline snapshot verification (zero runtime download)
    const snapshotCheck = this.validateSnapshot();
    if (!snapshotCheck.valid) {
      throw new EmbeddingError(
        'NO_RUNTIME_DOWNLOAD',
        `Offline embedding model snapshot is unavailable: ${snapshotCheck.errors.join('; ')}. Runtime downloads are prohibited.`,
        { errors: snapshotCheck.errors },
      );
    }

    // 5. Acquire lease through SharedModelManager if leaseId was not passed
    let acquiredLeaseId: string | null = null;
    if (this.modelManager) {
      if (!leaseId) {
        try {
          const lease = await this.modelManager.acquireLease({
            modelId: PINNED_EMBEDDING_CONFIG.modelId,
            agentId: 'embedding-service',
            expectedRevision: PINNED_EMBEDDING_CONFIG.revision,
            priority: 'background_indexing',
            timeoutMs: EMBEDDING_BOUNDS.inferenceTimeoutMs,
          });
          acquiredLeaseId = lease.id;
        } catch (err: any) {
          throw new EmbeddingError(
            'LEASE_REQUIRED',
            `Failed to acquire embedding model lease: ${err.message}`,
          );
        }
      }
    }

    // 6. Execute Model Inference
    let rawVectors: number[][];
    try {
      if (this.options._mockInference) {
        rawVectors = this.options._mockInference(texts);
      } else {
        rawVectors = this.runPythonInference(texts);
      }
    } catch (err: any) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        'MALFORMED_OUTPUT',
        `Embedding inference failed: ${err.message}`,
      );
    } finally {
      // Release lease if we acquired it internally
      if (acquiredLeaseId && this.modelManager) {
        try {
          this.modelManager.releaseLease(acquiredLeaseId);
        } catch {
          // best-effort cleanup
        }
      }
    }

    // 7. Validate inference vector counts and dimensions
    if (!Array.isArray(rawVectors) || rawVectors.length !== batch.items.length) {
      throw new EmbeddingError(
        'MALFORMED_OUTPUT',
        `Model returned ${rawVectors?.length ?? 0} vectors for ${batch.items.length} inputs`,
      );
    }

    // 8. Build typed ChunkEmbeddingRecord with F5-02 provenance retention
    const now = new Date().toISOString();
    const records: ChunkEmbeddingRecord[] = [];

    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      const vec = rawVectors[i];

      const vecValidation = validateEmbeddingVector(vec, EMBEDDING_BOUNDS.dimension);
      if (!vecValidation.valid) {
        throw new EmbeddingError(
          'INVALID_VECTOR_VALUE',
          `Vector validation failed for item ${i}: ${vecValidation.errors.join('; ')}`,
        );
      }

      const chunkId =
        item.chunkId ||
        crypto
          .createHash('sha256')
          .update(`${item.sourceHash || 'manual'}:${item.chunkIndex ?? i}`)
          .digest('hex')
          .slice(0, 32);

      const record: ChunkEmbeddingRecord = {
        schemaVersion: 1,
        projectId: batch.projectId,
        documentId: item.documentId || `doc_${chunkId.slice(0, 8)}`,
        chunkId,
        chunkIndex: item.chunkIndex ?? i,
        sourceHash:
          item.sourceHash ||
          crypto.createHash('sha256').update(item.text).digest('hex'),
        documentVersion: item.documentVersion ?? 1,
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        modelRevision: PINNED_EMBEDDING_CONFIG.revision,
        dimension: EMBEDDING_BOUNDS.dimension,
        vector: Object.freeze([...vec]),
        charOffsetStart: item.charOffsetStart ?? 0,
        charOffsetEnd: item.charOffsetEnd ?? item.text.length,
        generatedAt: now,
      };

      const recordValidation = validateChunkEmbeddingRecord(record, EMBEDDING_BOUNDS.dimension);
      if (!recordValidation.valid) {
        throw new EmbeddingError(
          'MALFORMED_OUTPUT',
          `Generated record validation failed: ${recordValidation.errors.join('; ')}`,
        );
      }

      records.push(record);
    }

    const durationMs = Date.now() - startTime;

    // 9. Append audit event (only metadata and chunk identifiers; NEVER raw text or secrets)
    if (this.audit && !this.options.skipAudit) {
      try {
        this.audit.recordAuditEvent({
          source: 'embedding-service',
          category: 'model',
          data: {
            event: 'EMBEDDING_GENERATED',
            projectId: batch.projectId,
            modelId: PINNED_EMBEDDING_CONFIG.modelId,
            modelRevision: PINNED_EMBEDDING_CONFIG.revision,
            dimension: EMBEDDING_BOUNDS.dimension,
            itemCount: records.length,
            durationMs,
            chunkIds: records.map((r) => r.chunkId),
          },
        });
      } catch {
        // Non-fatal audit failure
      }
    }

    return {
      modelId: PINNED_EMBEDDING_CONFIG.modelId,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      dimension: EMBEDDING_BOUNDS.dimension,
      records,
      durationMs,
    };
  }

  /**
   * Convenience method to generate embedding for a single text.
   */
  public async generateEmbedding(
    text: string,
    projectId: string,
    metadata?: Partial<EmbeddingInput>,
  ): Promise<ChunkEmbeddingRecord> {
    const res = await this.generateEmbeddings({
      projectId,
      items: [{ text, ...metadata }],
    });
    return res.records[0];
  }

  /**
   * Synchronous version of generateEmbeddings for synchronous tool execution workflows.
   */
  public generateEmbeddingsSync(
    batch: EmbeddingBatchInput,
    leaseId?: string,
  ): EmbeddingBatchResult {
    const startTime = Date.now();

    // 1. Cross-project validation
    if (!batch.projectId || typeof batch.projectId !== 'string') {
      throw new EmbeddingError('CROSS_PROJECT', 'projectId is required and must be a non-empty string');
    }

    // 2. Batch size bounds
    if (!Array.isArray(batch.items) || batch.items.length === 0) {
      throw new EmbeddingError('BATCH_TOO_LARGE', 'Batch must contain at least 1 item');
    }
    if (batch.items.length > EMBEDDING_BOUNDS.maxBatchSize) {
      throw new EmbeddingError(
        'BATCH_TOO_LARGE',
        `Batch size (${batch.items.length}) exceeds maximum limit (${EMBEDDING_BOUNDS.maxBatchSize})`,
        { count: batch.items.length, max: EMBEDDING_BOUNDS.maxBatchSize },
      );
    }

    // 3. Individual and cumulative bytes bounds
    let totalBatchBytes = 0;
    const texts: string[] = [];
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      if (!item || typeof item.text !== 'string' || item.text.trim().length === 0) {
        throw new EmbeddingError('OVERSIZED_INPUT', `Item at index ${i} has empty or invalid text`);
      }
      if (item.text.length > EMBEDDING_BOUNDS.maxTextLength) {
        throw new EmbeddingError(
          'OVERSIZED_INPUT',
          `Item at index ${i} length (${item.text.length} chars) exceeds maximum (${EMBEDDING_BOUNDS.maxTextLength})`,
          { index: i, length: item.text.length, max: EMBEDDING_BOUNDS.maxTextLength },
        );
      }
      const itemBytes = Buffer.byteLength(item.text, 'utf-8');
      if (itemBytes > EMBEDDING_BOUNDS.maxInputBytes) {
        throw new EmbeddingError(
          'OVERSIZED_INPUT',
          `Item at index ${i} bytes (${itemBytes}) exceeds maximum (${EMBEDDING_BOUNDS.maxInputBytes})`,
          { index: i, bytes: itemBytes, max: EMBEDDING_BOUNDS.maxInputBytes },
        );
      }
      totalBatchBytes += itemBytes;
      texts.push(item.text);
    }

    if (totalBatchBytes > EMBEDDING_BOUNDS.maxTotalBatchBytes) {
      throw new EmbeddingError(
        'BATCH_BYTES_EXCEEDED',
        `Total batch bytes (${totalBatchBytes}) exceeds maximum limit (${EMBEDDING_BOUNDS.maxTotalBatchBytes})`,
        { bytes: totalBatchBytes, max: EMBEDDING_BOUNDS.maxTotalBatchBytes },
      );
    }

    // 4. Offline snapshot verification (zero runtime download)
    const snapshotCheck = this.validateSnapshot();
    if (!snapshotCheck.valid) {
      throw new EmbeddingError(
        'NO_RUNTIME_DOWNLOAD',
        `Offline embedding model snapshot is unavailable: ${snapshotCheck.errors.join('; ')}. Runtime downloads are prohibited.`,
        { errors: snapshotCheck.errors },
      );
    }

    // 5. Acquire lease through SharedModelManager if leaseId was not passed
    let acquiredLeaseId: string | null = null;
    if (this.modelManager) {
      if (!leaseId) {
        try {
          const lease = this.modelManager.acquireLeaseSync({
            modelId: PINNED_EMBEDDING_CONFIG.modelId,
            agentId: 'embedding-service',
            expectedRevision: PINNED_EMBEDDING_CONFIG.revision,
            priority: 'background_indexing',
            timeoutMs: EMBEDDING_BOUNDS.inferenceTimeoutMs,
          });
          acquiredLeaseId = lease.id;
        } catch (err: any) {
          throw new EmbeddingError(
            'LEASE_REQUIRED',
            `Failed to acquire embedding model lease: ${err.message}`,
          );
        }
      }
    }

    // 6. Execute Model Inference
    let rawVectors: number[][];
    try {
      if (this.options._mockInference) {
        rawVectors = this.options._mockInference(texts);
      } else {
        rawVectors = this.runPythonInference(texts);
      }
    } catch (err: any) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        'MALFORMED_OUTPUT',
        `Embedding inference failed: ${err.message}`,
      );
    } finally {
      if (acquiredLeaseId && this.modelManager) {
        try {
          this.modelManager.releaseLease(acquiredLeaseId);
        } catch {
          // best-effort cleanup
        }
      }
    }

    // 7. Validate inference vector counts and dimensions
    if (!Array.isArray(rawVectors) || rawVectors.length !== batch.items.length) {
      throw new EmbeddingError(
        'MALFORMED_OUTPUT',
        `Model returned ${rawVectors?.length ?? 0} vectors for ${batch.items.length} inputs`,
      );
    }

    // 8. Build typed ChunkEmbeddingRecord with F5-02 provenance retention
    const now = new Date().toISOString();
    const records: ChunkEmbeddingRecord[] = [];

    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      const vec = rawVectors[i];

      const vecValidation = validateEmbeddingVector(vec, EMBEDDING_BOUNDS.dimension);
      if (!vecValidation.valid) {
        throw new EmbeddingError(
          'INVALID_VECTOR_VALUE',
          `Vector validation failed for item ${i}: ${vecValidation.errors.join('; ')}`,
        );
      }

      const chunkId =
        item.chunkId ||
        crypto
          .createHash('sha256')
          .update(`${item.text}:${i}`)
          .digest('hex')
          .slice(0, 32);

      const record: ChunkEmbeddingRecord = {
        schemaVersion: 1,
        projectId: batch.projectId,
        documentId: item.documentId || `doc_${chunkId.slice(0, 8)}`,
        chunkId,
        chunkIndex: item.chunkIndex ?? i,
        sourceHash:
          item.sourceHash ||
          crypto.createHash('sha256').update(item.text).digest('hex'),
        documentVersion: item.documentVersion ?? 1,
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        modelRevision: PINNED_EMBEDDING_CONFIG.revision,
        dimension: EMBEDDING_BOUNDS.dimension,
        vector: Object.freeze([...vec]),
        charOffsetStart: item.charOffsetStart ?? 0,
        charOffsetEnd: item.charOffsetEnd ?? item.text.length,
        generatedAt: now,
      };

      const recordValidation = validateChunkEmbeddingRecord(record, EMBEDDING_BOUNDS.dimension);
      if (!recordValidation.valid) {
        throw new EmbeddingError(
          'MALFORMED_OUTPUT',
          `Generated record validation failed: ${recordValidation.errors.join('; ')}`,
        );
      }

      records.push(record);
    }

    const durationMs = Date.now() - startTime;

    // 9. Append audit event
    if (this.audit && !this.options.skipAudit) {
      try {
        this.audit.recordAuditEvent({
          source: 'embedding-service',
          category: 'model',
          data: {
            event: 'EMBEDDING_GENERATED',
            projectId: batch.projectId,
            modelId: PINNED_EMBEDDING_CONFIG.modelId,
            modelRevision: PINNED_EMBEDDING_CONFIG.revision,
            dimension: EMBEDDING_BOUNDS.dimension,
            itemCount: records.length,
            durationMs,
            chunkIds: records.map((r) => r.chunkId),
          },
        });
      } catch {
        // Non-fatal audit failure
      }
    }

    return {
      modelId: PINNED_EMBEDDING_CONFIG.modelId,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      dimension: EMBEDDING_BOUNDS.dimension,
      records,
      durationMs,
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private runPythonInference(texts: string[]): number[][] {
    const tmpDir = path.join(this.projectRoot, '.maos', 'artifacts', '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const inputFile = path.join(tmpDir, `embed_in_${uniqueId}.json`);
    const outputFile = path.join(tmpDir, `embed_out_${uniqueId}.json`);

    try {
      fs.writeFileSync(inputFile, JSON.stringify(texts), 'utf-8');

      execFileSync(
        this.pythonExecutable,
        [
          this.engineScriptPath,
          '--input',
          inputFile,
          '--output',
          outputFile,
          '--model-path',
          this.snapshotDir,
          '--revision',
          PINNED_EMBEDDING_CONFIG.revision,
          '--dimension',
          String(EMBEDDING_BOUNDS.dimension),
          '--device',
          'cpu',
        ],
        {
          timeout: EMBEDDING_BOUNDS.inferenceTimeoutMs,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      if (!fs.existsSync(outputFile)) {
        throw new EmbeddingError('MALFORMED_OUTPUT', 'Engine did not produce an output file');
      }

      const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (!outputData || !Array.isArray(outputData.vectors)) {
        throw new EmbeddingError('MALFORMED_OUTPUT', 'Output JSON missing "vectors" array');
      }

      return outputData.vectors;
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
        throw new EmbeddingError(
          'INFERENCE_TIMEOUT',
          `Embedding inference timed out after ${EMBEDDING_BOUNDS.inferenceTimeoutMs}ms`,
        );
      }
      throw new EmbeddingError(
        'MALFORMED_OUTPUT',
        `Python inference worker failed: ${err.stderr?.toString()?.substring(0, 300) || err.message}`,
      );
    } finally {
      try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch {}
      try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch {}
    }
  }

  private hashFile(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024 * 1024);
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }
}
