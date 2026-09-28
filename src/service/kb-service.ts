/**
 * F5-07: Local Knowledge-Base Shared Application Service
 *
 * Implements high-level operations for the local knowledge base:
 *   - build: scans approved roots, ingests documents, and builds the bounded vector index
 *   - status: read-only inspection of policy, ingestion, model, and index states
 *   - verify: rigorous verification of schemas, hashes, chunk files, and model snapshot
 *   - clear: safe destructive clearance of generated KB state (requires confirmation)
 *
 * Invariants:
 *   1. Routes all operations through existing typed services (KbIngestionService,
 *      EmbeddingService, KbVectorIndexService, KbSearchService). Zero duplicate logic.
 *   2. Strict project isolation: confined within project root, rejects traversal and symlink escapes.
 *   3. Safe clearance: removes only .maos/kb/ generated state; source files, audit logs,
 *      and unrelated project metadata are strictly preserved.
 *   4. Read-only status & verify: status and verify never mutate index, manifest, or files.
 *   5. Fail-closed: missing offline weights throw typed NO_RUNTIME_DOWNLOAD error.
 *   6. Privacy-preserving audit logging: zero raw document text, queries, or credentials logged.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  KbCorpusPolicy,
  createDefaultCorpusPolicy,
  validateCorpusPolicy,
  isSupportedMimeType,
  resolveDocumentMimeType,
  KB_SUPPORTED_DOCUMENT_TYPES,
} from '../domain/kb-corpus-policy';
import {
  validateKbIngestionManifest,
  KbIngestionManifest,
} from '../domain/kb-ingestion';
import {
  PINNED_EMBEDDING_CONFIG,
  EmbeddingError,
} from '../domain/embedding';
import {
  validateVectorIndex,
  KbVectorIndex,
  KbIndexError,
} from '../domain/kb-vector-index';
import {
  KbBuildOptions,
  KbBuildResult,
  KbStatusOptions,
  KbStatusResult,
  KbVerifyOptions,
  KbVerifyResult,
  KbVerifyCheckItem,
  KbClearOptions,
  KbClearResult,
} from '../domain/kb-cli-types';
import { AuditService } from './audit-service';
import { KbIngestionService } from './kb-ingestion-service';
import { EmbeddingService } from './embedding-service';
import { KbVectorIndexService } from './kb-vector-index-service';
import { KbSearchService } from './kb-search-service';

export class KbService {
  private readonly kbDir: string;
  private readonly chunksDir: string;
  private readonly manifestPath: string;
  private readonly indexFilePath: string;
  private readonly policyFilePath: string;

  constructor(
    private readonly projectRoot: string,
    private readonly ingestionService: KbIngestionService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexService: KbVectorIndexService,
    private readonly searchService: KbSearchService,
    private readonly audit?: AuditService,
  ) {
    this.kbDir = path.join(this.projectRoot, '.maos', 'kb');
    this.chunksDir = path.join(this.kbDir, 'chunks');
    this.manifestPath = path.join(this.kbDir, 'ingestion-manifest.json');
    this.indexFilePath = path.join(this.kbDir, 'vector-index.json');
    this.policyFilePath = path.join(this.kbDir, 'corpus-policy.json');
  }

  // ── Project & Policy Resolution ─────────────────────────────────────

  public resolveProjectId(explicitId?: string): string {
    if (explicitId && explicitId.trim().length > 0) {
      return explicitId.trim();
    }
    // Attempt reading from .maos/maos.config.json
    const configPath = path.join(this.projectRoot, '.maos', 'maos.config.json');
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (raw.projectName && typeof raw.projectName === 'string') {
          return raw.projectName;
        }
        if (raw.id && typeof raw.id === 'string') {
          return raw.id;
        }
      } catch {}
    }
    // Attempt reading from existing manifest
    if (fs.existsSync(this.manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
        if (manifest.projectId && typeof manifest.projectId === 'string') {
          return manifest.projectId;
        }
      } catch {}
    }
    // Fallback to project root folder basename
    return path.basename(path.resolve(this.projectRoot)) || 'default-project';
  }

  public resolvePolicy(projectId: string): KbCorpusPolicy {
    if (fs.existsSync(this.policyFilePath)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(this.policyFilePath, 'utf-8'));
      } catch (err: any) {
        const parseErr = new Error(`Corrupt corpus-policy.json: ${err.message}`);
        (parseErr as any).code = 'POLICY_FAILURE';
        throw parseErr;
      }
      const validation = validateCorpusPolicy(raw);
      if (!validation.valid) {
        const valErr = new Error(`Invalid corpus policy in corpus-policy.json: ${validation.errors.join('; ')}`);
        (valErr as any).code = 'POLICY_FAILURE';
        throw valErr;
      }
      return raw as KbCorpusPolicy;
    }
    return createDefaultCorpusPolicy(projectId, ['docs', 'manuals', 'sops', 'correspondence']);
  }

  // ── 1. Build Knowledge Base ─────────────────────────────────────────

  public async build(options: KbBuildOptions = {}): Promise<KbBuildResult> {
    const startTime = Date.now();
    const projectId = this.resolveProjectId(options.projectId);
    const policy = this.resolvePolicy(projectId);

    // Validate policy
    const policyValidation = validateCorpusPolicy(policy);
    if (!policyValidation.valid) {
      const err = new Error(`Invalid corpus policy: ${policyValidation.errors.join('; ')}`);
      (err as any).code = 'POLICY_FAILURE';
      throw err;
    }

    // Record start audit event
    if (this.audit) {
      this.audit.recordAuditEvent({
        source: 'kb-service',
        category: 'tool',
        data: {
          event: 'KB_BUILD_STARTED',
          projectId,
          policyVersion: policy.policyVersion,
          approvedRoots: policy.approvedRoots,
          force: options.force ?? false,
        },
      });
    }

    try {
      // 1. Discover all candidate documents in approved roots
      const candidateFiles = this.discoverDocuments(options.approvedRoots || policy.approvedRoots);

      // 2. Ingest candidate documents through KbIngestionService
      const warnings: string[] = [];
      let ingestedCount = 0;

      for (const relPath of candidateFiles) {
        try {
          const result = this.ingestionService.ingest(
            {
              sourcePath: relPath,
              projectId,
              forceReingest: options.force,
            },
            policy,
          );
          ingestedCount++;
          if (result.warnings && result.warnings.length > 0) {
            warnings.push(...result.warnings.map((w) => `[${relPath}] ${w}`));
          }
        } catch (ingestErr: any) {
          warnings.push(`[${relPath}] Skipped ingestion: ${ingestErr.message}`);
        }
      }

      // 3. Build bounded vector index through KbVectorIndexService
      const buildResult = await this.indexService.buildIndex(projectId, policy, options.force);
      const durationMs = Date.now() - startTime;

      // 4. Record completion audit event
      if (this.audit) {
        this.audit.recordAuditEvent({
          source: 'kb-service',
          category: 'tool',
          data: {
            event: 'KB_BUILD_COMPLETED',
            projectId,
            indexBuildId: buildResult.indexBuildId,
            entriesHash: buildResult.entriesHash,
            documentCount: buildResult.documentCount,
            chunkCount: buildResult.chunkCount,
            totalVectorBytes: buildResult.totalVectorBytes,
            durationMs,
          },
        });
      }

      return {
        success: true,
        projectId,
        status: buildResult.status,
        documentCount: buildResult.documentCount,
        chunkCount: buildResult.chunkCount,
        totalVectorBytes: buildResult.totalVectorBytes,
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        modelRevision: PINNED_EMBEDDING_CONFIG.revision,
        indexBuildId: buildResult.indexBuildId || `bld-${projectId}`,
        entriesHash: buildResult.entriesHash || '',
        durationMs,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (this.audit) {
        this.audit.recordAuditEvent({
          source: 'kb-service',
          category: 'tool',
          data: {
            event: 'KB_BUILD_FAILED',
            projectId,
            error: err.message,
            errorCode: err.code || 'BUILD_FAILED',
            durationMs,
          },
        });
      }
      throw err;
    }
  }

  // ── 2. Status (Read-Only) ───────────────────────────────────────────

  public async status(options: KbStatusOptions = {}): Promise<KbStatusResult> {
    const projectId = this.resolveProjectId(options.projectId);
    const policy = this.resolvePolicy(projectId);

    // 1. Ingestion status from manifest
    const manifest = this.ingestionService.readManifest();
    let ingestionDocCount = 0;
    let totalSourceBytes = 0;
    let totalChunks = 0;
    let quarantinedCount = 0;
    let lastIngestedAt: string | undefined;

    if (manifest && manifest.entries) {
      lastIngestedAt = manifest.updatedAt;
      for (const record of Object.values(manifest.entries)) {
        totalSourceBytes += record.entry.sourceBytes;
        totalChunks += record.chunkCount;
        if (record.entry.status === 'quarantined') {
          quarantinedCount++;
        } else if (record.entry.status === 'indexed') {
          ingestionDocCount++;
        }
      }
    }

    // 2. Embedding model status
    const snapshotCheck = this.embeddingService.validateSnapshot();
    const weightsFile = path.join(
      this.projectRoot,
      'offline-stores',
      'model-snapshot',
      PINNED_EMBEDDING_CONFIG.snapshotRelativePath,
      'model.safetensors',
    );
    let realWeightsPresent = false;
    if (fs.existsSync(weightsFile)) {
      try {
        const stat = fs.statSync(weightsFile);
        realWeightsPresent = stat.size >= 10_000_000;
      } catch {}
    }

    const embeddingAvailable = snapshotCheck.valid && realWeightsPresent;
    const blockerReason = !embeddingAvailable
      ? snapshotCheck.valid && !realWeightsPresent
        ? 'Offline weights file model.safetensors is absent or a placeholder stub'
        : snapshotCheck.errors.join('; ')
      : undefined;

    // 3. Index status
    const checkStatus = await this.indexService.checkIndexStatus(projectId, policy);
    let indexState: 'not_built' | 'stale' | 'up_to_date' | 'empty' | 'corrupt';

    if (checkStatus.status === 'missing') {
      indexState = 'not_built';
    } else if (checkStatus.status === 'stale') {
      indexState = 'stale';
    } else if (checkStatus.status === 'corrupt') {
      indexState = 'corrupt';
    } else {
      indexState = ingestionDocCount === 0 ? 'empty' : 'up_to_date';
    }

    let indexFileSizeBytes = 0;
    let indexBuildId: string | undefined;
    let entriesHash: string | undefined;
    let lastBuiltAt: string | undefined;
    let indexedDocCount = 0;
    let indexedChunkCount = 0;
    let totalVectorBytes = 0;

    if (fs.existsSync(this.indexFilePath)) {
      try {
        const stat = fs.statSync(this.indexFilePath);
        indexFileSizeBytes = stat.size;
        const raw = JSON.parse(fs.readFileSync(this.indexFilePath, 'utf-8'));
        indexBuildId = raw.indexBuildId;
        entriesHash = raw.entriesHash;
        lastBuiltAt = raw.updatedAt || raw.createdAt;
        indexedDocCount = raw.documentCount ?? 0;
        indexedChunkCount = raw.chunkCount ?? 0;
        totalVectorBytes = raw.totalVectorBytes ?? 0;
      } catch {}
    }

    return {
      projectId,
      projectRoot: this.projectRoot,
      policy: {
        policyVersion: policy.policyVersion,
        approvedRoots: policy.approvedRoots,
        supportedTypes: policy.supportedTypes,
        maxSourceBytes: policy.limits.maxSourceBytes,
        maxDocumentCount: policy.limits.maxDocumentCount,
      },
      ingestion: {
        documentCount: ingestionDocCount,
        totalSourceBytes,
        totalChunks,
        quarantinedCount,
        lastIngestedAt,
      },
      embedding: {
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        modelName: PINNED_EMBEDDING_CONFIG.modelName,
        revision: PINNED_EMBEDDING_CONFIG.revision,
        dimension: PINNED_EMBEDDING_CONFIG.dimension,
        available: embeddingAvailable,
        offlineSnapshotValid: snapshotCheck.valid,
        blockerReason,
      },
      index: {
        state: indexState,
        documentCount: indexedDocCount,
        chunkCount: indexedChunkCount,
        totalVectorBytes,
        indexBuildId,
        entriesHash,
        lastBuiltAt,
        indexFileSizeBytes,
      },
      privacyClean: true,
    };
  }

  // ── 3. Verify (Read-Only) ───────────────────────────────────────────

  public async verify(options: KbVerifyOptions = {}): Promise<KbVerifyResult> {
    const projectId = this.resolveProjectId(options.projectId);
    const policy = this.resolvePolicy(projectId);
    const checks: KbVerifyCheckItem[] = [];
    const errors: string[] = [];

    // Check 1: Corpus policy validation
    const policyVal = validateCorpusPolicy(policy);
    checks.push({
      name: 'corpus_policy',
      passed: policyVal.valid,
      details: policyVal.valid ? `Policy v${policy.policyVersion} is valid` : policyVal.errors.join('; '),
    });
    if (!policyVal.valid) {
      errors.push(...policyVal.errors.map((e) => `[policy] ${e}`));
    }

    // Check 2: Ingestion manifest validation
    const manifest = this.ingestionService.readManifest();
    if (!manifest) {
      if (fs.existsSync(this.indexFilePath)) {
        checks.push({
          name: 'ingestion_manifest',
          passed: false,
          details: 'Vector index exists but ingestion manifest is missing',
        });
        errors.push('Vector index exists without ingestion manifest');
      } else {
        checks.push({
          name: 'ingestion_manifest',
          passed: false,
          details: 'Knowledge base has not been ingested or built',
        });
        errors.push('Ingestion manifest not found — run `maos industrial kb build` first');
      }
    } else {
      const manifestVal = validateKbIngestionManifest(manifest);
      checks.push({
        name: 'ingestion_manifest',
        passed: manifestVal.valid,
        details: manifestVal.valid ? `Manifest valid with ${manifest.documentCount} document(s)` : manifestVal.errors.join('; '),
      });
      if (!manifestVal.valid) {
        errors.push(...manifestVal.errors.map((e) => `[manifest] ${e}`));
      }

      // Check 3: Chunk files on disk
      let missingChunkFiles = 0;
      let totalChunksVerified = 0;
      for (const [docId, record] of Object.entries(manifest.entries)) {
        if (record.entry.status === 'indexed') {
          const chunkPath = path.join(this.chunksDir, `${docId}.json`);
          if (!fs.existsSync(chunkPath)) {
            missingChunkFiles++;
          } else {
            try {
              const chunkData = JSON.parse(fs.readFileSync(chunkPath, 'utf-8'));
              if (Array.isArray(chunkData.chunks)) {
                totalChunksVerified += chunkData.chunks.length;
              }
            } catch {
              missingChunkFiles++;
            }
          }
        }
      }

      const chunkFilesOk = missingChunkFiles === 0;
      checks.push({
        name: 'chunk_provenance',
        passed: chunkFilesOk,
        details: chunkFilesOk
          ? `All chunk files verified (${totalChunksVerified} total chunks)`
          : `Missing or corrupt chunk files for ${missingChunkFiles} document(s)`,
      });
      if (!chunkFilesOk) {
        errors.push(`Missing or corrupt chunk files for ${missingChunkFiles} document(s)`);
      }

      // Check 3b: Source files on disk freshness (detect modified or deleted source files)
      let staleSourceCount = 0;
      for (const record of Object.values(manifest.entries)) {
        if (record.entry.status === 'indexed') {
          const fullSourcePath = path.resolve(this.projectRoot, record.entry.canonicalPath);
          if (!fs.existsSync(fullSourcePath)) {
            staleSourceCount++;
            errors.push(`Vector index is stale: indexed source file missing on disk (${record.entry.canonicalPath})`);
          } else {
            try {
              const currentContent = fs.readFileSync(fullSourcePath);
              const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
              if (currentHash.toLowerCase() !== record.entry.sourceHash.toLowerCase()) {
                staleSourceCount++;
                errors.push(`Vector index is stale: source document modified on disk (${record.entry.canonicalPath})`);
              }
            } catch {
              staleSourceCount++;
              errors.push(`Vector index is stale: cannot read source file (${record.entry.canonicalPath})`);
            }
          }
        }
      }

      const sourceFilesFresh = staleSourceCount === 0;
      checks.push({
        name: 'source_file_freshness',
        passed: sourceFilesFresh,
        details: sourceFilesFresh
          ? 'All indexed source files match disk content and hashes'
          : `Detected ${staleSourceCount} modified or missing source file(s)`,
      });
    }

    // Check 4: Embedding snapshot integrity
    const snapshotCheck = this.embeddingService.validateSnapshot();
    checks.push({
      name: 'embedding_snapshot',
      passed: snapshotCheck.valid,
      details: snapshotCheck.valid
        ? `Snapshot intact for ${PINNED_EMBEDDING_CONFIG.modelId}`
        : snapshotCheck.errors.join('; '),
    });
    if (!snapshotCheck.valid) {
      errors.push(...snapshotCheck.errors.map((e) => `[embedding] ${e}`));
    }

    // Check 5: Vector index schema, entry hashes, and staleness
    let indexBuildId: string | undefined;
    let entriesHash: string | undefined;
    let indexedDocs: number | undefined;
    let indexedChunks: number | undefined;

    if (!fs.existsSync(this.indexFilePath)) {
      checks.push({
        name: 'vector_index',
        passed: false,
        details: 'Vector index file vector-index.json does not exist',
      });
      errors.push('Vector index not found — run `maos industrial kb build`');
    } else {
      const indexStatus = await this.indexService.checkIndexStatus(projectId, policy);
      if (indexStatus.status === 'stale') {
        checks.push({
          name: 'vector_index_freshness',
          passed: false,
          details: `Vector index is stale: ${indexStatus.reason || 'Source documents or policy changed'}`,
        });
        errors.push(`Vector index is stale: ${indexStatus.reason || 'Rebuild required'}`);
      } else if (indexStatus.status === 'corrupt') {
        checks.push({
          name: 'vector_index_freshness',
          passed: false,
          details: `Vector index is corrupt: ${indexStatus.errors.join('; ')}`,
        });
        errors.push(`Vector index is corrupt: ${indexStatus.errors.join('; ')}`);
      } else {
        checks.push({
          name: 'vector_index_freshness',
          passed: true,
          details: 'Vector index is up to date and valid',
        });
      }

      try {
        const index = this.indexService.loadIndex(projectId);
        indexBuildId = index.indexBuildId;
        entriesHash = index.entriesHash;
        indexedDocs = index.documentCount;
        indexedChunks = index.chunkCount;

        const indexVal = validateVectorIndex(index);
        checks.push({
          name: 'vector_index_schema',
          passed: indexVal.valid,
          details: indexVal.valid ? `Index valid with ${index.chunkCount} entry(s)` : indexVal.errors.join('; '),
        });
        if (!indexVal.valid) {
          errors.push(...indexVal.errors.map((e) => `[index] ${e}`));
        }
      } catch (loadErr: any) {
        checks.push({
          name: 'vector_index_schema',
          passed: false,
          details: `Failed to load index: ${loadErr.message}`,
        });
        errors.push(`Failed to load vector index: ${loadErr.message}`);
      }
    }

    const valid = errors.length === 0;

    // Record audit event
    if (this.audit) {
      if (valid) {
        this.audit.recordAuditEvent({
          source: 'kb-service',
          category: 'tool',
          data: {
            event: 'KB_VERIFY_COMPLETED',
            projectId,
            indexBuildId,
            entriesHash,
            documentCount: indexedDocs,
            chunkCount: indexedChunks,
            checkCount: checks.length,
          },
        });
      } else {
        this.audit.recordAuditEvent({
          source: 'kb-service',
          category: 'tool',
          data: {
            event: 'KB_VERIFY_FAILED',
            projectId,
            failures: errors,
            errorCount: errors.length,
          },
        });
      }
    }

    return {
      valid,
      projectId,
      checks,
      errors,
      indexBuildId,
      entriesHash,
      documentCount: indexedDocs,
      chunkCount: indexedChunks,
    };
  }

  // ── 4. Clear Knowledge Base ─────────────────────────────────────────

  public async clear(options: KbClearOptions = {}): Promise<KbClearResult> {
    const projectId = this.resolveProjectId(options.projectId);

    // Destructive confirmation safety gate
    if (!options.confirmed && !options.dryRun) {
      const err = new Error(
        'Confirmation required for destructive clear operation. Pass confirmed: true or use --yes.',
      );
      (err as any).code = 'CONFIRMATION_REQUIRED';
      throw err;
    }

    // Identify candidate generated files to remove
    const candidateFiles: string[] = [];

    if (fs.existsSync(this.indexFilePath)) {
      candidateFiles.push(path.relative(this.projectRoot, this.indexFilePath));
    }
    if (fs.existsSync(this.manifestPath)) {
      candidateFiles.push(path.relative(this.projectRoot, this.manifestPath));
    }

    // Inspect chunk files
    if (fs.existsSync(this.chunksDir)) {
      try {
        const chunkFiles = fs.readdirSync(this.chunksDir);
        for (const cf of chunkFiles) {
          candidateFiles.push(path.relative(this.projectRoot, path.join(this.chunksDir, cf)));
        }
      } catch {}
    }

    // Inspect temporary files in .maos/kb/
    if (fs.existsSync(this.kbDir)) {
      try {
        const kbFiles = fs.readdirSync(this.kbDir);
        for (const kbf of kbFiles) {
          if (kbf.startsWith('.tmp') || kbf.endsWith('.tmp')) {
            candidateFiles.push(path.relative(this.projectRoot, path.join(this.kbDir, kbf)));
          }
        }
      } catch {}
    }

    // If dry run, return preview without deleting
    if (options.dryRun) {
      return {
        success: true,
        projectId,
        dryRun: true,
        removedFiles: candidateFiles,
        removedCount: candidateFiles.length,
        sourceFilesPreserved: true,
        auditPreserved: true,
        message: `Dry run: ${candidateFiles.length} generated KB file(s) would be removed.`,
      };
    }

    // Execute deletion of generated KB state only
    let removedCount = 0;
    const removedFiles: string[] = [];

    // 1. Remove vector index
    if (fs.existsSync(this.indexFilePath)) {
      try {
        fs.unlinkSync(this.indexFilePath);
        removedCount++;
        removedFiles.push(path.relative(this.projectRoot, this.indexFilePath));
      } catch {}
    }

    // 2. Remove ingestion manifest
    if (fs.existsSync(this.manifestPath)) {
      try {
        fs.unlinkSync(this.manifestPath);
        removedCount++;
        removedFiles.push(path.relative(this.projectRoot, this.manifestPath));
      } catch {}
    }

    // 3. Remove chunk files and chunks directory
    if (fs.existsSync(this.chunksDir)) {
      try {
        const chunkFiles = fs.readdirSync(this.chunksDir);
        for (const cf of chunkFiles) {
          const chunkPath = path.join(this.chunksDir, cf);
          fs.unlinkSync(chunkPath);
          removedCount++;
          removedFiles.push(path.relative(this.projectRoot, chunkPath));
        }
        fs.rmdirSync(this.chunksDir);
      } catch {}
    }

    // 4. Remove temporary files
    if (fs.existsSync(this.kbDir)) {
      try {
        const kbFiles = fs.readdirSync(this.kbDir);
        for (const kbf of kbFiles) {
          if (kbf.startsWith('.tmp') || kbf.endsWith('.tmp')) {
            const tmpPath = path.join(this.kbDir, kbf);
            fs.unlinkSync(tmpPath);
            removedCount++;
            removedFiles.push(path.relative(this.projectRoot, tmpPath));
          }
        }
      } catch {}
    }

    // Record audit event
    if (this.audit) {
      this.audit.recordAuditEvent({
        source: 'kb-service',
        category: 'tool',
        data: {
          event: 'KB_CLEARED',
          projectId,
          removedFilesCount: removedCount,
        },
      });
    }

    return {
      success: true,
      projectId,
      dryRun: false,
      removedFiles,
      removedCount,
      sourceFilesPreserved: true,
      auditPreserved: true,
      message: `Successfully cleared ${removedCount} generated KB artifact(s). Source documents preserved.`,
    };
  }

  // ── Document Discovery Helper ───────────────────────────────────────

  private discoverDocuments(approvedRoots: readonly string[]): string[] {
    const discovered: string[] = [];

    for (const root of approvedRoots) {
      const cleanRoot = root.replace(/\/+$/, '');
      const absoluteRoot = path.resolve(this.projectRoot, cleanRoot);

      if (!fs.existsSync(absoluteRoot)) {
        continue;
      }

      try {
        const stat = fs.statSync(absoluteRoot);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      this.scanDirectoryRecursive(absoluteRoot, discovered);
    }

    return discovered;
  }

  private scanDirectoryRecursive(dir: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Ignore hidden files / directories
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this.scanDirectoryRecursive(fullPath, results);
      } else if (entry.isFile()) {
        const relPath = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');
        const mimeType = resolveDocumentMimeType(relPath);
        if (mimeType && isSupportedMimeType(mimeType)) {
          results.push(relPath);
        }
      }
    }
  }
}
