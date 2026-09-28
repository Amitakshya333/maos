/**
 * F5-04: Local Knowledge-Base Bounded Vector Index Service
 *
 * Implements bounded, project-isolated, tamper-evident vector index management
 * for knowledge-base chunks using the pinned offline sentence-transformers/all-MiniLM-L6-v2 model.
 *
 * Core Invariants:
 * 1. Pinned Model: strictly all-MiniLM-L6-v2 (384-d, float32, CPU).
 * 2. Strict Project Isolation: cross-project access or path traversal is rejected.
 * 3. Crash-Safe Atomic Persistence: temp file -> fsync -> atomic rename.
 * 4. Tamper-Evident Integrity: recomputes and checks canonical entryHash and entriesHash.
 * 5. Deterministic Rebuild: identical inputs produce identical logical index and hashes.
 * 6. Zero Synthetic Vectors: relies strictly on verified offline embedding service.
 * 7. Source Preservation: original source files and chunk files are never mutated or deleted.
 * 8. Audited Operations: records build, rebuild, load, rejection, and invalidation without leaking raw text.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  KbVectorIndex,
  KbVectorIndexEntry,
  KbVectorIndexBuildStatus,
  KB_INDEX_BOUNDS,
  KbIndexError,
  KbIndexErrorCode,
  computeEntryHash,
  computeEntriesHash,
  validateVectorIndex,
  validateVectorIndexEntry,
} from '../domain/kb-vector-index';
import {
  KbCorpusPolicy,
  KbCorpusDocumentEntry,
  validateCorpusPolicy,
  validateCorpusPath,
  canonicalizeCorpusPath,
} from '../domain/kb-corpus-policy';
import {
  KbTextChunk,
  KbIngestionManifest,
  validateKbIngestionManifest,
} from '../domain/kb-ingestion';
import {
  PINNED_EMBEDDING_CONFIG,
  EMBEDDING_BOUNDS,
  EmbeddingBatchInput,
} from '../domain/embedding';
import { AuditService } from './audit-service';
import { KbIngestionService } from './kb-ingestion-service';
import { EmbeddingService } from './embedding-service';

export interface KbVectorIndexServiceOptions {
  skipAudit?: boolean;
  /** Test hook to simulate interruptions during atomic file operations. */
  _simulateInterruption?: 'before_persist' | 'before_rename' | 'before_audit';
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export class KbVectorIndexService {
  private readonly kbDir: string;
  private readonly indexFilePath: string;
  private readonly tmpDir: string;
  private readonly chunksDir: string;
  private readonly manifestPath: string;

  constructor(
    private readonly projectRoot: string,
    private readonly audit?: AuditService,
    private readonly ingestionService?: KbIngestionService,
    private readonly embeddingService?: EmbeddingService,
    private readonly options: KbVectorIndexServiceOptions = {},
  ) {
    this.kbDir = path.join(this.projectRoot, '.maos', 'kb');
    this.indexFilePath = path.join(this.projectRoot, KB_INDEX_BOUNDS.indexPath);
    this.tmpDir = path.join(this.projectRoot, KB_INDEX_BOUNDS.tmpDir);
    this.chunksDir = path.join(this.kbDir, 'chunks');
    this.manifestPath = path.join(this.kbDir, 'ingestion-manifest.json');
  }

  private ensureDirs(): void {
    for (const dir of [this.kbDir, this.tmpDir, this.chunksDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Return the path to the vector index file.
   */
  public getIndexFilePath(): string {
    return this.indexFilePath;
  }

  /**
   * Build or rebuild the vector index for the specified project.
   * Deterministically processes ingested non-quarantined chunks, computes embeddings,
   * generates tamper-evident hashes, and atomically persists the index.
   */
  public async buildIndex(
    projectId: string,
    policy: KbCorpusPolicy,
    forceRebuild = false,
  ): Promise<KbVectorIndexBuildStatus> {
    const startTime = Date.now();

    // 1. Validate policy & project isolation
    if (!projectId || typeof projectId !== 'string') {
      throw new KbIndexError('CROSS_PROJECT', 'projectId must be a non-empty string');
    }

    const policyValidation = validateCorpusPolicy(policy);
    if (!policyValidation.valid) {
      throw new KbIndexError(
        'POLICY_VERSION_MISMATCH',
        `Corpus policy is invalid: ${policyValidation.errors.join('; ')}`,
      );
    }

    if (policy.projectId !== projectId) {
      throw new KbIndexError(
        'CROSS_PROJECT',
        `Policy project ID "${policy.projectId}" does not match request project ID "${projectId}"`,
      );
    }

    // 2. Read ingestion manifest
    const manifest = this.readIngestionManifest();
    if (!manifest || manifest.documentCount === 0 || Object.keys(manifest.entries).length === 0) {
      return {
        status: 'empty',
        reason: 'No ingested documents found in knowledge-base manifest',
        documentCount: 0,
        chunkCount: 0,
        totalVectorBytes: 0,
        durationMs: Date.now() - startTime,
      };
    }

    if (manifest.projectId !== projectId) {
      throw new KbIndexError(
        'CROSS_PROJECT',
        `Ingestion manifest project "${manifest.projectId}" does not match requested project "${projectId}"`,
      );
    }

    // 3. Check existing index to see if it is up to date
    let isRebuild = Boolean(forceRebuild || fs.existsSync(this.indexFilePath));
    let existingIndex: KbVectorIndex | null = null;
    if (fs.existsSync(this.indexFilePath)) {
      try {
        existingIndex = this.loadIndex(projectId);
      } catch (err: any) {
        // Corrupted, tampered, or mismatched index triggers a rebuild
      }
    }

    if (existingIndex && !forceRebuild) {
      const staleness = this.checkStaleness(existingIndex, manifest, policy);
      if (!staleness.stale) {
        return {
          status: 'up_to_date',
          reason: 'Vector index is already up to date with corpus and policy',
          documentCount: existingIndex.documentCount,
          chunkCount: existingIndex.chunkCount,
          totalVectorBytes: existingIndex.totalVectorBytes,
          indexBuildId: existingIndex.indexBuildId,
          entriesHash: existingIndex.entriesHash,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 4. Collect active (non-quarantined) chunks
    // Sort documents deterministically by canonicalPath
    const activeDocEntries: KbCorpusDocumentEntry[] = Object.values(manifest.entries)
      .map((e) => e.entry)
      .filter((doc) => doc.status === 'indexed') // Never index quarantined or failed documents!
      .sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));

    if (activeDocEntries.length === 0) {
      return {
        status: 'empty',
        reason: 'No indexed, non-quarantined documents available for indexing',
        documentCount: 0,
        chunkCount: 0,
        totalVectorBytes: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Read all chunks for each document
    interface ChunkWithDoc {
      doc: KbCorpusDocumentEntry;
      chunk: KbTextChunk;
    }
    const allChunks: ChunkWithDoc[] = [];

    for (const doc of activeDocEntries) {
      const chunkFilePath = path.join(this.chunksDir, `${doc.id}.json`);
      if (!fs.existsSync(chunkFilePath)) {
        throw new KbIndexError(
          'CORRUPTED_INDEX',
          `Missing chunk file for indexed document: ${chunkFilePath}`,
          { documentId: doc.id },
        );
      }
      let chunkData: { chunks: KbTextChunk[] };
      try {
        chunkData = JSON.parse(fs.readFileSync(chunkFilePath, 'utf-8'));
      } catch (err: any) {
        throw new KbIndexError(
          'CORRUPTED_INDEX',
          `Malformed chunk JSON for document ${doc.id}: ${err.message}`,
        );
      }
      if (!Array.isArray(chunkData.chunks)) {
        throw new KbIndexError(
          'CORRUPTED_INDEX',
          `Missing chunks array in chunk file for document ${doc.id}`,
        );
      }
      for (const chk of chunkData.chunks) {
        allChunks.push({ doc, chunk: chk });
      }
    }

    // Sort chunks deterministically: by doc.canonicalPath, then by chunk.chunkIndex
    allChunks.sort((a, b) => {
      const cmp = a.doc.canonicalPath.localeCompare(b.doc.canonicalPath);
      if (cmp !== 0) return cmp;
      return a.chunk.chunkIndex - b.chunk.chunkIndex;
    });

    // Check bounds
    if (activeDocEntries.length > KB_INDEX_BOUNDS.maxDocuments) {
      throw new KbIndexError(
        'INDEX_TOO_LARGE',
        `Active document count (${activeDocEntries.length}) exceeds index limit (${KB_INDEX_BOUNDS.maxDocuments})`,
      );
    }
    if (allChunks.length > KB_INDEX_BOUNDS.maxChunks) {
      throw new KbIndexError(
        'INDEX_TOO_LARGE',
        `Active chunk count (${allChunks.length}) exceeds index limit (${KB_INDEX_BOUNDS.maxChunks})`,
      );
    }

    // 5. Ensure embedding service is available
    if (!this.embeddingService) {
      throw new KbIndexError(
        'NO_RUNTIME_DOWNLOAD',
        'EmbeddingService is not provided to KbVectorIndexService',
      );
    }

    // 6. Generate embeddings in bounded batches (maxBatchSize = 32)
    const batchSize = KB_INDEX_BOUNDS.maxBatchSize;
    const entries: KbVectorIndexEntry[] = [];

    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batchSlice = allChunks.slice(i, i + batchSize);
      const batchInput: EmbeddingBatchInput = {
        projectId,
        items: batchSlice.map(({ chunk, doc }) => ({
          text: chunk.chunkText,
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          documentId: doc.id,
          sourceHash: doc.sourceHash,
          documentVersion: doc.indexVersion,
          charOffsetStart: chunk.charOffsetStart,
          charOffsetEnd: chunk.charOffsetEnd,
        })),
      };

      const embeddingResult = await this.embeddingService.generateEmbeddings(batchInput);

      for (let j = 0; j < batchSlice.length; j++) {
        const { chunk, doc } = batchSlice[j];
        const record = embeddingResult.records[j];

        const rawEntry: Omit<KbVectorIndexEntry, 'entryHash'> = {
          chunkId: chunk.chunkId,
          documentId: doc.id,
          sourcePath: doc.canonicalPath,
          sourceHash: doc.sourceHash,
          documentVersion: doc.indexVersion,
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber ?? undefined,
          sectionHeading: chunk.sectionHeading ?? undefined,
          charOffsetStart: chunk.charOffsetStart,
          charOffsetEnd: chunk.charOffsetEnd,
          vector: record.vector,
        };

        const entryHash = computeEntryHash(rawEntry);
        const fullEntry: KbVectorIndexEntry = {
          ...rawEntry,
          entryHash,
        };

        const entryValidation = validateVectorIndexEntry(fullEntry, KB_INDEX_BOUNDS.dimension);
        if (!entryValidation.valid) {
          throw new KbIndexError(
            'INVALID_VECTOR',
            `Vector validation failed for chunk ${chunk.chunkId}: ${entryValidation.errors.join('; ')}`,
          );
        }

        entries.push(fullEntry);
      }
    }

    // 7. Assemble index object with tamper-evident entriesHash
    const indexBuildId = crypto.randomBytes(16).toString('hex');
    const entriesHash = computeEntriesHash(entries.map((e) => e.entryHash));
    const now = new Date().toISOString();
    const totalVectorBytes = entries.length * KB_INDEX_BOUNDS.dimension * 4;

    const index: KbVectorIndex = {
      schemaVersion: 1,
      projectId,
      policyVersion: policy.policyVersion,
      embeddingModelId: PINNED_EMBEDDING_CONFIG.modelId,
      embeddingModelRevision: PINNED_EMBEDDING_CONFIG.revision,
      embeddingDimension: KB_INDEX_BOUNDS.dimension,
      precision: 'float32',
      indexBuildId,
      entriesHash,
      documentCount: activeDocEntries.length,
      chunkCount: entries.length,
      totalVectorBytes,
      entries,
      createdAt: existingIndex?.createdAt || now,
      updatedAt: now,
    };

    // 8. Validate assembled index before persistence
    const indexValidation = validateVectorIndex(index, KB_INDEX_BOUNDS.dimension);
    if (!indexValidation.valid) {
      throw new KbIndexError(
        'INDEX_MALFORMED',
        `Built index validation failed: ${indexValidation.errors.join('; ')}`,
      );
    }

    // 9. Atomic Persistence (temp -> fsync -> rename)
    this.persistIndexAtomically(index);

    const durationMs = Date.now() - startTime;

    // 10. Append audit event
    if (this.audit && !this.options.skipAudit) {
      try {
        if (this.options._simulateInterruption === 'before_audit') {
          throw new Error('SIMULATED_INTERRUPTION_BEFORE_AUDIT');
        }
        this.audit.recordAuditEvent({
          source: 'kb-vector-index-service',
          category: 'model',
          data: {
            event: isRebuild ? 'INDEX_REBUILT' : 'INDEX_BUILT',
            projectId,
            indexBuildId,
            entriesHash,
            documentCount: activeDocEntries.length,
            chunkCount: entries.length,
            totalVectorBytes,
            durationMs,
          },
        });
      } catch (err: any) {
        if (err.message === 'SIMULATED_INTERRUPTION_BEFORE_AUDIT') {
          // allow simulation to complete without re-throwing
        }
      }
    }

    return {
      status: isRebuild ? 'rebuilt' : 'built',
      documentCount: activeDocEntries.length,
      chunkCount: entries.length,
      totalVectorBytes,
      indexBuildId,
      entriesHash,
      durationMs,
    };
  }

  /**
   * Load and verify the vector index for a project.
   * Fails closed if missing, malformed, tampered, or mismatched.
   */
  public loadIndex(projectId: string): KbVectorIndex {
    if (!projectId || typeof projectId !== 'string') {
      throw new KbIndexError('CROSS_PROJECT', 'projectId must be a non-empty string');
    }

    if (!fs.existsSync(this.indexFilePath)) {
      throw new KbIndexError('INDEX_NOT_FOUND', `Vector index not found at ${this.indexFilePath}`);
    }

    // Size check
    const stat = fs.statSync(this.indexFilePath);
    if (stat.size > KB_INDEX_BOUNDS.maxIndexFileSizeBytes) {
      this.recordAuditRejection(projectId, 'INDEX_TOO_LARGE', `Index file size (${stat.size}) exceeds limit`);
      throw new KbIndexError(
        'INDEX_TOO_LARGE',
        `Index file size (${stat.size} bytes) exceeds maximum limit (${KB_INDEX_BOUNDS.maxIndexFileSizeBytes})`,
      );
    }

    // Parse JSON
    let rawIndex: unknown;
    try {
      rawIndex = JSON.parse(fs.readFileSync(this.indexFilePath, 'utf-8'));
    } catch (err: any) {
      this.recordAuditRejection(projectId, 'INDEX_MALFORMED', `JSON parse error: ${err.message}`);
      throw new KbIndexError('INDEX_MALFORMED', `Failed to parse vector index JSON: ${err.message}`);
    }

    // Validate index object
    const validation = validateVectorIndex(rawIndex, KB_INDEX_BOUNDS.dimension);
    if (!validation.valid) {
      const errorMsg = validation.errors.join('; ');
      this.recordAuditRejection(projectId, 'CORRUPTED_INDEX', errorMsg);
      if (errorMsg.includes('schemaVersion')) {
        throw new KbIndexError('UNSUPPORTED_SCHEMA_VERSION', errorMsg);
      }
      if (errorMsg.includes('Duplicate chunkId')) {
        throw new KbIndexError('DUPLICATE_CHUNK_ID', errorMsg);
      }
      if (errorMsg.includes('Duplicate source chunk')) {
        throw new KbIndexError('DUPLICATE_SOURCE_ENTRY', errorMsg);
      }
      if (errorMsg.includes('mismatch')) {
        throw new KbIndexError('HASH_MISMATCH', errorMsg);
      }
      throw new KbIndexError('CORRUPTED_INDEX', `Index validation failed: ${errorMsg}`);
    }

    const index = rawIndex as KbVectorIndex;

    // Cross-project check
    if (index.projectId !== projectId) {
      this.recordAuditRejection(
        projectId,
        'CROSS_PROJECT',
        `Index belongs to "${index.projectId}", not "${projectId}"`,
      );
      throw new KbIndexError(
        'CROSS_PROJECT',
        `Index belongs to project "${index.projectId}", not requested project "${projectId}"`,
      );
    }

    // Record loaded audit event
    if (this.audit && !this.options.skipAudit) {
      try {
        this.audit.recordAuditEvent({
          source: 'kb-vector-index-service',
          category: 'model',
          data: {
            event: 'INDEX_LOADED',
            projectId,
            indexBuildId: index.indexBuildId,
            entriesHash: index.entriesHash,
            documentCount: index.documentCount,
            chunkCount: index.chunkCount,
          },
        });
      } catch {
        // Non-fatal
      }
    }

    return deepFreeze(index);
  }

  /**
   * Check whether an existing vector index is valid, missing, or needs a rebuild.
   */
  public checkIndexStatus(
    projectId: string,
    policy: KbCorpusPolicy,
  ): { status: 'valid' | 'missing' | 'stale' | 'corrupt'; reason?: string; errors: string[] } {
    if (!fs.existsSync(this.indexFilePath)) {
      return { status: 'missing', errors: ['Index file does not exist'] };
    }

    let index: KbVectorIndex;
    try {
      index = this.loadIndex(projectId);
    } catch (err: any) {
      return { status: 'corrupt', reason: err.message, errors: [err.message] };
    }

    const manifest = this.readIngestionManifest();
    if (!manifest) {
      return { status: 'stale', reason: 'No ingestion manifest found', errors: [] };
    }

    const staleness = this.checkStaleness(index, manifest, policy);
    if (staleness.stale) {
      return { status: 'stale', reason: staleness.reason, errors: [] };
    }

    return { status: 'valid', errors: [] };
  }

  /**
   * Clear the index file. Leaves source files and chunks completely untouched.
   */
  public clearIndex(projectId: string): boolean {
    if (!projectId || typeof projectId !== 'string') {
      throw new KbIndexError('CROSS_PROJECT', 'projectId must be a non-empty string');
    }

    if (fs.existsSync(this.indexFilePath)) {
      // Validate project before deletion if index is readable
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexFilePath, 'utf-8'));
        if (raw.projectId && raw.projectId !== projectId) {
          throw new KbIndexError('CROSS_PROJECT', 'Cannot clear index belonging to another project');
        }
      } catch (err) {
        if (err instanceof KbIndexError) throw err;
        // If file is corrupt JSON, allow unlinking
      }

      fs.unlinkSync(this.indexFilePath);

      // Clean up temporary files
      if (fs.existsSync(this.tmpDir)) {
        try {
          const tmpFiles = fs.readdirSync(this.tmpDir);
          for (const f of tmpFiles) {
            try { fs.unlinkSync(path.join(this.tmpDir, f)); } catch {}
          }
        } catch {}
      }

      // Record audit event
      if (this.audit && !this.options.skipAudit) {
        try {
          this.audit.recordAuditEvent({
            source: 'kb-vector-index-service',
            category: 'model',
            data: {
              event: 'INDEX_INVALIDATED',
              projectId,
              action: 'cleared',
            },
          });
        } catch {}
      }

      return true;
    }

    return false;
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private readIngestionManifest(): KbIngestionManifest | null {
    if (!fs.existsSync(this.manifestPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
      const validation = validateKbIngestionManifest(parsed);
      if (!validation.valid) return null;
      return parsed as KbIngestionManifest;
    } catch {
      return null;
    }
  }

  private checkStaleness(
    index: KbVectorIndex,
    manifest: KbIngestionManifest,
    policy: KbCorpusPolicy,
  ): { stale: boolean; reason?: string } {
    // 1. Policy version check
    if (index.policyVersion !== policy.policyVersion) {
      return { stale: true, reason: `Policy version changed from ${index.policyVersion} to ${policy.policyVersion}` };
    }

    // 2. Model configuration check
    if (
      index.embeddingModelId !== PINNED_EMBEDDING_CONFIG.modelId ||
      index.embeddingModelRevision !== PINNED_EMBEDDING_CONFIG.revision ||
      index.embeddingDimension !== KB_INDEX_BOUNDS.dimension
    ) {
      return { stale: true, reason: 'Embedding model configuration or revision changed' };
    }

    // 3. Document count alignment
    const activeDocs = Object.values(manifest.entries)
      .map((e) => e.entry)
      .filter((d) => d.status === 'indexed');

    if (index.documentCount !== activeDocs.length) {
      return { stale: true, reason: `Document count changed: index=${index.documentCount}, manifest=${activeDocs.length}` };
    }

    // Map index entries by chunkId
    const indexEntryMap = new Map<string, KbVectorIndexEntry>();
    for (const e of index.entries) {
      indexEntryMap.set(e.chunkId, e);
    }

    for (const doc of activeDocs) {
      const chunkFilePath = path.join(this.chunksDir, `${doc.id}.json`);
      if (!fs.existsSync(chunkFilePath)) {
        return { stale: true, reason: `Missing chunk file for document ${doc.canonicalPath}` };
      }
      let chunkData: { chunks: KbTextChunk[] };
      try {
        chunkData = JSON.parse(fs.readFileSync(chunkFilePath, 'utf-8'));
      } catch {
        return { stale: true, reason: `Corrupt chunk file for document ${doc.canonicalPath}` };
      }
      if (!Array.isArray(chunkData.chunks)) {
        return { stale: true, reason: `Invalid chunk file structure for document ${doc.canonicalPath}` };
      }
      for (const chunk of chunkData.chunks) {
        const entry = indexEntryMap.get(chunk.chunkId);
        if (!entry) {
          return { stale: true, reason: `Missing chunk ${chunk.chunkId} in vector index` };
        }
        if (entry.sourceHash !== doc.sourceHash) {
          return { stale: true, reason: `Source hash changed for document ${doc.canonicalPath}` };
        }
        if (entry.documentVersion !== doc.indexVersion) {
          return { stale: true, reason: `Document version changed for ${doc.canonicalPath}` };
        }
      }
    }

    return { stale: false };
  }

  private persistIndexAtomically(index: KbVectorIndex): void {
    this.ensureDirs();

    if (this.options._simulateInterruption === 'before_persist') {
      throw new KbIndexError('PERSIST_FAILED', 'Simulated failure before persist');
    }

    const jsonString = JSON.stringify(index, null, 2);
    const byteSize = Buffer.byteLength(jsonString, 'utf-8');
    if (byteSize > KB_INDEX_BOUNDS.maxIndexFileSizeBytes) {
      throw new KbIndexError(
        'INDEX_TOO_LARGE',
        `Serialized index size (${byteSize} bytes) exceeds limit (${KB_INDEX_BOUNDS.maxIndexFileSizeBytes})`,
      );
    }

    const uniqueId = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const tmpFile = path.join(this.tmpDir, `index_${uniqueId}.tmp`);

    try {
      const fd = fs.openSync(tmpFile, 'w');
      try {
        fs.writeSync(fd, jsonString, undefined, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      if (this.options._simulateInterruption === 'before_rename') {
        throw new KbIndexError('PERSIST_FAILED', 'Simulated failure before rename');
      }

      fs.renameSync(tmpFile, this.indexFilePath);
    } catch (err: any) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
      if (err instanceof KbIndexError) throw err;
      throw new KbIndexError('PERSIST_FAILED', `Failed to atomically persist vector index: ${err.message}`);
    }
  }

  private recordAuditRejection(projectId: string, code: string, reason: string): void {
    if (this.audit && !this.options.skipAudit) {
      try {
        this.audit.recordAuditEvent({
          source: 'kb-vector-index-service',
          category: 'model',
          data: {
            event: 'INDEX_REJECTED',
            projectId,
            errorCode: code,
            reason,
          },
        });
      } catch {}
    }
  }
}
