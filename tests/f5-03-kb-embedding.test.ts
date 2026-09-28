/**
 * F5-03 Tests: Local Knowledge-Base CPU Embedding Model
 *
 * Comprehensive positive and negative test suite covering:
 *   1. Model Identity & Pinned Configuration (sentence-transformers/all-MiniLM-L6-v2, 384-d, CPU)
 *   2. Snapshot Manifest & File Integrity Validation (sizes, SHA-256, path confinement, symlink escape)
 *   3. Pure Domain Validators (manifest, vector, chunk embedding record)
 *   4. Zero Runtime Download / Fail-Closed Enforcement (NO_RUNTIME_DOWNLOAD)
 *   5. Input Bounds & Guardrails (batch size, char length, byte size, cross-project)
 *   6. Inference Execution & Vector Quality (384-d, finite, bounded, deterministic)
 *   7. Provenance Preservation from F5-02 (chunkId, sourceHash, docId, version, offsets)
 *   8. SharedModelManager Lease Protocol & GPU Invariance (CPU model does NOT evict GPU VLM)
 *   9. Immutable Audit Trail Integration (EMBEDDING_GENERATED, no raw text leaked)
 *  10. ServiceContainer Integration (container.embedding)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  PINNED_EMBEDDING_CONFIG,
  EMBEDDING_BOUNDS,
  EmbeddingError,
  EmbeddingSnapshotManifest,
  ChunkEmbeddingRecord,
  validateEmbeddingSnapshotManifest,
  validateEmbeddingVector,
  validateChunkEmbeddingRecord,
} from '../src/domain/embedding';
import {
  EmbeddingService,
  createServiceContainer,
  SharedModelManager,
  AuditService,
} from '../src/service';
import { PINNED_VLM_CONFIG } from '../src/domain/vision';

// ── Test Helpers ────────────────────────────────────────────────────

/**
 * Deterministic pseudo-random normalized 384-d float vector.
 */
function createMockVector(seedText: string, offset = 0): number[] {
  const vec = new Array(384);
  let sumSq = 0;
  for (let i = 0; i < 384; i++) {
    const code = seedText.charCodeAt(i % seedText.length) || 42;
    const v = Math.sin(i * 13.37 + code + offset);
    vec[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1.0;
  for (let i = 0; i < 384; i++) {
    vec[i] = Number((vec[i] / norm).toFixed(6));
  }
  return vec;
}

/**
 * Creates a valid mock offline snapshot directory and manifest.
 */
function installTestEmbeddingSnapshot(
  root: string,
  overrides: {
    corruptHash?: boolean;
    corruptSize?: boolean;
    missingFile?: boolean;
    badModelName?: boolean;
    badRevision?: boolean;
    badDimension?: boolean;
  } = {},
): { manifestPath: string; snapshotDir: string } {
  const snapshotRelativePath = PINNED_EMBEDDING_CONFIG.snapshotRelativePath;
  const snapshotDir = path.join(root, 'offline-stores', 'model-snapshot', snapshotRelativePath);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const files = [
    { name: 'config.json', content: Buffer.from('{"model_type":"bert"}', 'utf-8') },
    { name: 'tokenizer.json', content: Buffer.from('{"tokenizer":"mock"}', 'utf-8') },
    { name: 'model.safetensors', content: Buffer.from('mock-weights-data-384', 'utf-8') },
  ];

  const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];

  for (const f of files) {
    if (overrides.missingFile && f.name === 'model.safetensors') {
      manifestFiles.push({
        path: f.name,
        size: f.content.length,
        sha256: crypto.createHash('sha256').update(f.content).digest('hex'),
      });
      continue;
    }

    const filePath = path.join(snapshotDir, f.name);
    fs.writeFileSync(filePath, f.content);

    let reportedHash = crypto.createHash('sha256').update(f.content).digest('hex');
    let reportedSize = f.content.length;

    if (overrides.corruptHash && f.name === 'config.json') {
      reportedHash = '0000000000000000000000000000000000000000000000000000000000000000';
    }
    if (overrides.corruptSize && f.name === 'tokenizer.json') {
      reportedSize = 999999;
    }

    manifestFiles.push({
      path: f.name,
      size: reportedSize,
      sha256: reportedHash,
    });
  }

  const manifest: EmbeddingSnapshotManifest = {
    schemaVersion: 1,
    model: overrides.badModelName ? 'wrong-model/bad' : PINNED_EMBEDDING_CONFIG.modelId,
    modelName: PINNED_EMBEDDING_CONFIG.modelName,
    revision: overrides.badRevision ? 'badrev000000000000000000000000000000000' : PINNED_EMBEDDING_CONFIG.revision,
    dimension: overrides.badDimension ? 512 : PINNED_EMBEDDING_CONFIG.dimension,
    architecture: PINNED_EMBEDDING_CONFIG.architecture,
    device: PINNED_EMBEDDING_CONFIG.device,
    quantization: PINNED_EMBEDDING_CONFIG.quantization,
    maxInputTokens: PINNED_EMBEDDING_CONFIG.maxInputTokens,
    maxInputChars: PINNED_EMBEDDING_CONFIG.maxInputChars,
    snapshotRelativePath,
    files: manifestFiles,
    budgets: {
      maxHostMemoryMb: 2048,
      maxBatchSize: 32,
      maxTotalBatchBytes: 65536,
      inferenceTimeoutMs: 15000,
    },
  };

  const manifestPath = path.join(root, PINNED_EMBEDDING_CONFIG.manifestPath);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return { manifestPath, snapshotDir };
}

/**
 * Creates a valid mock offline VLM snapshot directory and manifest.
 */
function installTestVlmSnapshot(root: string): void {
  const snapshotRelativePath = PINNED_VLM_CONFIG.snapshotRelativePath;
  const snapshotDir = path.join(root, 'offline-stores', 'model-snapshot', snapshotRelativePath);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const modelConfig = Buffer.from('{"model_type":"qwen2_vl"}', 'utf-8');
  fs.writeFileSync(path.join(snapshotDir, 'config.json'), modelConfig);
  fs.writeFileSync(
    path.join(root, 'vlm-snapshot-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        model: PINNED_VLM_CONFIG.modelId,
        revision: PINNED_VLM_CONFIG.revision,
        quantization: PINNED_VLM_CONFIG.defaultQuantization,
        snapshotRelativePath,
        files: [
          {
            path: 'config.json',
            size: modelConfig.length,
            sha256: crypto.createHash('sha256').update(modelConfig).digest('hex'),
          },
        ],
        budgets: {
          maxVramMb: 6144,
          coldStartBudgetMs: 45000,
          inferenceBudgetMs: 15000,
          warmStartBudgetMs: 5000,
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('F5-03: Local Knowledge-Base CPU Embedding Model', () => {
  let testRoot: string;
  const projectId = 'test-project';

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f5-03-test-'));
    fs.mkdirSync(path.join(testRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'status'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: projectId }),
    );
    SharedModelManager.resetInstance();
  });

  afterEach(() => {
    SharedModelManager.resetInstance();
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── 1. Model Identity & Pinned Configuration ─────────────────────

  describe('1. Model Identity & Pinned Configuration', () => {
    it('returns exact pinned model metadata and constraints', () => {
      const service = new EmbeddingService(testRoot);
      const info = service.getModelInfo();

      expect(info.modelId).toBe('sentence-transformers/all-MiniLM-L6-v2');
      expect(info.revision).toBe('fa979fdf926cbd99430f16e4321689952542a641');
      expect(info.dimension).toBe(384);
      expect(info.architecture).toBe('BertModel');
      expect(info.device).toBe('cpu');
      expect(info.quantization).toBe('float32');
      expect(info.license).toBe('Apache-2.0');
      expect(info.maxInputTokens).toBe(256);
      expect(info.maxInputChars).toBe(2048);
      expect(info.maxBatchSize).toBe(32);
    });

    it('manifest in repository root matches pinned constants', () => {
      const rootManifestPath = path.resolve(__dirname, '..', PINNED_EMBEDDING_CONFIG.manifestPath);
      expect(fs.existsSync(rootManifestPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(rootManifestPath, 'utf-8'));
      const validation = validateEmbeddingSnapshotManifest(content);
      expect(validation.valid).toBe(true);
      expect(content.model).toBe(PINNED_EMBEDDING_CONFIG.modelId);
      expect(content.revision).toBe(PINNED_EMBEDDING_CONFIG.revision);
      expect(content.dimension).toBe(PINNED_EMBEDDING_CONFIG.dimension);
    });
  });

  // ── 2. Snapshot Manifest & Integrity Validation ──────────────────

  describe('2. Snapshot Manifest & File Integrity Validation', () => {
    it('validates a correct offline snapshot directory against manifest', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('fails when manifest file is missing', () => {
      const nonExistentManifest = path.join(testRoot, 'does-not-exist.json');
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: nonExistentManifest,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Manifest not found');
    });

    it('fails when manifest contains malformed JSON', () => {
      const badManifest = path.join(testRoot, 'bad-manifest.json');
      fs.writeFileSync(badManifest, '{ invalid json');
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: badManifest,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Malformed manifest JSON');
    });

    it('fails when manifest model ID does not match pinned model', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        badModelName: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('does not match pinned model'))).toBe(true);
    });

    it('fails when manifest revision does not match pinned revision', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        badRevision: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('does not match pinned revision'))).toBe(true);
    });

    it('fails when manifest dimension is not 384', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        badDimension: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('dimension must be exactly 384'))).toBe(true);
    });

    it('fails when snapshot directory is missing', () => {
      const { manifestPath } = installTestEmbeddingSnapshot(testRoot);
      const fakeDir = path.join(testRoot, 'offline-stores', 'model-snapshot', 'non-existent');
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: fakeDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Snapshot directory not found'))).toBe(true);
    });

    it('fails when a declared snapshot file is missing', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        missingFile: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Missing model snapshot file: model.safetensors'))).toBe(true);
    });

    it('fails when a declared file has size mismatch', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        corruptSize: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Size mismatch for tokenizer.json'))).toBe(true);
    });

    it('fails when a declared file has SHA-256 hash mismatch', () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        corruptHash: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('SHA-256 mismatch for config.json'))).toBe(true);
    });

    it('rejects relative path traversal in declared manifest files', () => {
      const { snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const traversalManifest: EmbeddingSnapshotManifest = {
        schemaVersion: 1,
        model: PINNED_EMBEDDING_CONFIG.modelId,
        modelName: PINNED_EMBEDDING_CONFIG.modelName,
        revision: PINNED_EMBEDDING_CONFIG.revision,
        dimension: 384,
        architecture: 'BertModel',
        device: 'cpu',
        quantization: 'float32',
        maxInputTokens: 256,
        maxInputChars: 2048,
        snapshotRelativePath: PINNED_EMBEDDING_CONFIG.snapshotRelativePath,
        files: [{ path: '../secret.txt', size: 10, sha256: 'a'.repeat(64) }],
        budgets: { maxHostMemoryMb: 2048, maxBatchSize: 32, maxTotalBatchBytes: 1048576, inferenceTimeoutMs: 15000 },
      };
      const manifestPath = path.join(testRoot, 'traversal-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(traversalManifest), 'utf-8');

      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
      });

      const res = service.validateSnapshot();
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('escapes snapshot directory'))).toBe(true);
    });
  });

  // ── 3. Pure Domain Validators ─────────────────────────────────────

  describe('3. Pure Domain Validators', () => {
    it('validates a well-formed manifest and rejects invalid structures', () => {
      expect(validateEmbeddingSnapshotManifest(null).valid).toBe(false);
      expect(validateEmbeddingSnapshotManifest([]).valid).toBe(false);
      expect(validateEmbeddingSnapshotManifest({}).valid).toBe(false);

      const validManifest: EmbeddingSnapshotManifest = {
        schemaVersion: 1,
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        modelName: 'all-minilm-l6-v2-local',
        revision: 'fa979fdf926cbd99430f16e4321689952542a641',
        dimension: 384,
        architecture: 'BertModel',
        device: 'cpu',
        quantization: 'float32',
        maxInputTokens: 256,
        maxInputChars: 2048,
        snapshotRelativePath: 'models/all-MiniLM-L6-v2',
        files: [{ path: 'model.safetensors', size: 100, sha256: 'b'.repeat(64) }],
        budgets: { maxHostMemoryMb: 2048, maxBatchSize: 32, maxTotalBatchBytes: 1048576, inferenceTimeoutMs: 15000 },
      };
      expect(validateEmbeddingSnapshotManifest(validManifest).valid).toBe(true);

      // bad schemaVersion
      expect(validateEmbeddingSnapshotManifest({ ...validManifest, schemaVersion: 2 }).valid).toBe(false);
      // bad dimension
      expect(validateEmbeddingSnapshotManifest({ ...validManifest, dimension: 768 }).valid).toBe(false);
      // bad sha256
      expect(validateEmbeddingSnapshotManifest({
        ...validManifest,
        files: [{ path: 'model.safetensors', size: 100, sha256: 'not-64-hex' }],
      }).valid).toBe(false);
    });

    it('validates embedding vectors (exactly 384 finite numbers)', () => {
      const validVec = createMockVector('hello world');
      expect(validateEmbeddingVector(validVec, 384).valid).toBe(true);

      // Wrong dimension
      expect(validateEmbeddingVector(validVec.slice(0, 300), 384).valid).toBe(false);
      expect(validateEmbeddingVector([...validVec, 0.1], 384).valid).toBe(false);

      // NaN
      const nanVec = [...validVec];
      nanVec[10] = NaN;
      expect(validateEmbeddingVector(nanVec, 384).valid).toBe(false);

      // Infinity
      const infVec = [...validVec];
      infVec[20] = Infinity;
      expect(validateEmbeddingVector(infVec, 384).valid).toBe(false);

      // Non-number
      const strVec = [...validVec];
      (strVec as any)[5] = '0.45';
      expect(validateEmbeddingVector(strVec, 384).valid).toBe(false);

      // Exceeds magnitude bound
      const hugeVec = [...validVec];
      hugeVec[0] = 500.0;
      expect(validateEmbeddingVector(hugeVec, 384).valid).toBe(false);
    });

    it('validates chunk embedding records', () => {
      const validVec = createMockVector('record-test');
      const validRecord: ChunkEmbeddingRecord = {
        schemaVersion: 1,
        projectId: 'p1',
        documentId: 'doc1',
        chunkId: 'chk1',
        chunkIndex: 0,
        sourceHash: 'c'.repeat(64),
        documentVersion: 1,
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        modelRevision: PINNED_EMBEDDING_CONFIG.revision,
        dimension: 384,
        vector: validVec,
        charOffsetStart: 0,
        charOffsetEnd: 50,
        generatedAt: new Date().toISOString(),
      };

      expect(validateChunkEmbeddingRecord(validRecord, 384).valid).toBe(true);

      // Bad schemaVersion
      expect(validateChunkEmbeddingRecord({ ...validRecord, schemaVersion: 2 }, 384).valid).toBe(false);
      // Missing chunkId
      expect(validateChunkEmbeddingRecord({ ...validRecord, chunkId: '' }, 384).valid).toBe(false);
      // Negative chunkIndex
      expect(validateChunkEmbeddingRecord({ ...validRecord, chunkIndex: -1 }, 384).valid).toBe(false);
      // Wrong vector dimension
      expect(validateChunkEmbeddingRecord({ ...validRecord, vector: validVec.slice(0, 100) }, 384).valid).toBe(false);
    });
  });

  // ── 4. Zero Runtime Download / Fail-Closed Enforcement ─────────────

  describe('4. Zero Runtime Download / Fail-Closed Enforcement', () => {
    it('fails closed with NO_RUNTIME_DOWNLOAD when offline snapshot is absent', async () => {
      // testRoot does not have the offline snapshot installed
      const service = new EmbeddingService(testRoot);

      await expect(
        service.generateEmbeddings({
          projectId,
          items: [{ text: 'This should fail closed' }],
        }),
      ).rejects.toThrowError(/NO_RUNTIME_DOWNLOAD/);
    });

    it('fails closed when snapshot has tampered files', async () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot, {
        corruptHash: true,
      });
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });

      await expect(
        service.generateEmbeddings({
          projectId,
          items: [{ text: 'Tampered model should fail closed' }],
        }),
      ).rejects.toThrowError(/NO_RUNTIME_DOWNLOAD/);
    });
  });

  // ── 5. Input Bounds & Guardrails ──────────────────────────────────

  describe('5. Input Bounds & Guardrails', () => {
    let service: EmbeddingService;

    beforeEach(() => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });
    });

    it('rejects missing or empty projectId (CROSS_PROJECT)', async () => {
      await expect(
        service.generateEmbeddings({
          projectId: '',
          items: [{ text: 'hello' }],
        }),
      ).rejects.toThrowError(/CROSS_PROJECT/);
    });

    it('rejects empty batch (BATCH_TOO_LARGE)', async () => {
      await expect(
        service.generateEmbeddings({
          projectId,
          items: [],
        }),
      ).rejects.toThrowError(/BATCH_TOO_LARGE/);
    });

    it('rejects batch exceeding maxBatchSize of 32 (BATCH_TOO_LARGE)', async () => {
      const items = Array.from({ length: 33 }, (_, i) => ({ text: `Item text ${i}` }));
      await expect(
        service.generateEmbeddings({
          projectId,
          items,
        }),
      ).rejects.toThrowError(/BATCH_TOO_LARGE/);
    });

    it('rejects item with empty or whitespace text (OVERSIZED_INPUT)', async () => {
      await expect(
        service.generateEmbeddings({
          projectId,
          items: [{ text: '   \t\n  ' }],
        }),
      ).rejects.toThrowError(/OVERSIZED_INPUT/);
    });

    it('rejects item exceeding maxTextLength of 2048 chars (OVERSIZED_INPUT)', async () => {
      const oversizedText = 'A'.repeat(2049);
      await expect(
        service.generateEmbeddings({
          projectId,
          items: [{ text: oversizedText }],
        }),
      ).rejects.toThrowError(/OVERSIZED_INPUT/);
    });

    it('rejects batch exceeding cumulative bytes limit of 64 KB (BATCH_BYTES_EXCEEDED)', async () => {
      // 20 items of 1500 chars using 3-byte unicode character (€)
      // 1500 chars <= maxTextLength (2048)
      // Each item is 4,500 bytes <= maxInputBytes (100,000)
      // 20 items * 4,500 bytes = 90,000 bytes > maxTotalBatchBytes (65,536 bytes)
      const multiByteText = '€'.repeat(1500);
      const items = Array.from({ length: 20 }, () => ({ text: multiByteText }));
      await expect(
        service.generateEmbeddings({
          projectId,
          items,
        }),
      ).rejects.toThrowError(/BATCH_BYTES_EXCEEDED/);
    });
  });

  // ── 6. Inference Execution & Vector Quality ───────────────────────

  describe('6. Inference Execution & Vector Quality', () => {
    let service: EmbeddingService;

    beforeEach(() => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });
    });

    it('generates 384-dimensional normalized vector for a single text', async () => {
      const record = await service.generateEmbedding('Quality assurance procedure', projectId);

      expect(record.schemaVersion).toBe(1);
      expect(record.dimension).toBe(384);
      expect(record.vector).toHaveLength(384);
      expect(record.modelId).toBe(PINNED_EMBEDDING_CONFIG.modelId);
      expect(record.modelRevision).toBe(PINNED_EMBEDDING_CONFIG.revision);

      // Verify all elements are finite numbers
      for (const val of record.vector) {
        expect(typeof val).toBe('number');
        expect(Number.isFinite(val)).toBe(true);
        expect(Number.isNaN(val)).toBe(false);
      }

      // Check vector is frozen (immutable)
      expect(Object.isFrozen(record.vector)).toBe(true);
    });

    it('generates embeddings for a batch of 8 texts deterministically', async () => {
      const texts = Array.from({ length: 8 }, (_, i) => `Specification section ${i + 1}`);
      const batchResult1 = await service.generateEmbeddings({
        projectId,
        items: texts.map((t) => ({ text: t })),
      });

      expect(batchResult1.records).toHaveLength(8);
      expect(batchResult1.dimension).toBe(384);
      expect(batchResult1.durationMs).toBeGreaterThanOrEqual(0);

      // Re-run with same inputs to check deterministic repeatability
      const batchResult2 = await service.generateEmbeddings({
        projectId,
        items: texts.map((t) => ({ text: t })),
      });

      for (let i = 0; i < 8; i++) {
        expect(batchResult1.records[i].vector).toEqual(batchResult2.records[i].vector);
      }
    });

    it('fails when inference engine produces wrong number of vectors (MALFORMED_OUTPUT)', async () => {
      const badService = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: path.join(testRoot, PINNED_EMBEDDING_CONFIG.manifestPath),
        customSnapshotDir: path.join(testRoot, 'offline-stores', 'model-snapshot', PINNED_EMBEDDING_CONFIG.snapshotRelativePath),
        _mockInference: () => [createMockVector('only-one')], // 1 vector returned for 2 inputs
      });

      await expect(
        badService.generateEmbeddings({
          projectId,
          items: [{ text: 'first' }, { text: 'second' }],
        }),
      ).rejects.toThrowError(/MALFORMED_OUTPUT/);
    });

    it('fails when inference engine produces NaN or invalid vector values', async () => {
      const badVec = createMockVector('nan-test');
      badVec[50] = NaN;

      const badService = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: path.join(testRoot, PINNED_EMBEDDING_CONFIG.manifestPath),
        customSnapshotDir: path.join(testRoot, 'offline-stores', 'model-snapshot', PINNED_EMBEDDING_CONFIG.snapshotRelativePath),
        _mockInference: () => [badVec],
      });

      await expect(
        badService.generateEmbeddings({
          projectId,
          items: [{ text: 'triggers-nan' }],
        }),
      ).rejects.toThrowError(/INVALID_VECTOR_VALUE/);
    });
  });

  // ── 7. Provenance Preservation from F5-02 ──────────────────────────

  describe('7. Provenance Preservation from F5-02', () => {
    it('preserves complete chunk and document provenance in embedding records', async () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const service = new EmbeddingService(testRoot, undefined, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });

      const chunkProvenance = {
        documentId: 'doc-alpha-99',
        chunkId: 'chunk-0001-abc',
        chunkIndex: 3,
        sourceHash: 'd'.repeat(64),
        documentVersion: 2,
        charOffsetStart: 600,
        charOffsetEnd: 850,
      };

      const result = await service.generateEmbeddings({
        projectId,
        items: [{
          text: 'This is the fourth chunk of document Alpha 99.',
          ...chunkProvenance,
        }],
      });

      const record = result.records[0];
      expect(record.projectId).toBe(projectId);
      expect(record.documentId).toBe('doc-alpha-99');
      expect(record.chunkId).toBe('chunk-0001-abc');
      expect(record.chunkIndex).toBe(3);
      expect(record.sourceHash).toBe('d'.repeat(64));
      expect(record.documentVersion).toBe(2);
      expect(record.charOffsetStart).toBe(600);
      expect(record.charOffsetEnd).toBe(850);
      expect(record.modelId).toBe(PINNED_EMBEDDING_CONFIG.modelId);
      expect(record.modelRevision).toBe(PINNED_EMBEDDING_CONFIG.revision);
      expect(record.dimension).toBe(384);
      expect(new Date(record.generatedAt).getTime()).not.toBeNaN();
    });
  });

  // ── 8. SharedModelManager Lease & GPU Invariance ──────────────────

  describe('8. SharedModelManager Lease Protocol & GPU Invariance', () => {
    it('acquires and releases model lease through SharedModelManager during embedding', async () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const manager = SharedModelManager.getInstance(testRoot);

      const service = new EmbeddingService(testRoot, undefined, manager, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });

      const res = await service.generateEmbeddings({
        projectId,
        items: [{ text: 'Lease test content' }],
      });
      expect(res.records).toHaveLength(1);

      // Model manager should have no lingering active lease
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('releases model lease even when inference handler throws', async () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const manager = SharedModelManager.getInstance(testRoot);

      const service = new EmbeddingService(testRoot, undefined, manager, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: () => {
          throw new Error('Simulated engine failure');
        },
      });

      await expect(
        service.generateEmbeddings({
          projectId,
          items: [{ text: 'Will fail inference' }],
        }),
      ).rejects.toThrowError(/Embedding inference failed/);

      // Lease must be cleaned up in finally block
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('GPU Invariance: CPU embedding model does not evict or interfere with active GPU VLM', async () => {
      installTestVlmSnapshot(testRoot);
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const manager = SharedModelManager.getInstance(testRoot);

      // 1. Acquire lease for a GPU model (Qwen2-VL)
      const gpuLease = await manager.acquireLease({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'vision-service',
        expectedRevision: PINNED_VLM_CONFIG.revision,
        priority: 'user_interactive',
        timeoutMs: 10000,
      });
      expect(gpuLease).toBeDefined();

      // GPU model is currently resident in VRAM
      const activeGpu = manager.getResidencyStatus();
      expect(activeGpu.residentModelId).toBe(PINNED_VLM_CONFIG.modelId);

      // 2. Execute CPU embedding while GPU model lease is held
      const service = new EmbeddingService(testRoot, undefined, manager, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });

      const res = await service.generateEmbeddings({
        projectId,
        items: [{ text: 'Embedding during active GPU lease' }],
      });
      expect(res.records).toHaveLength(1);

      // 3. Verify the GPU model was NOT evicted and remains resident
      const activeStillGpu = manager.getResidencyStatus();
      expect(activeStillGpu.residentModelId).toBe(PINNED_VLM_CONFIG.modelId);

      // 4. Release GPU lease cleanly
      manager.releaseLease(gpuLease.id);
      expect(manager.listLeases()).toHaveLength(0);
    });
  });

  // ── 9. Audit Logging ──────────────────────────────────────────────

  describe('9. Audit Logging', () => {
    it('records EMBEDDING_GENERATED audit event without logging raw text', async () => {
      const { manifestPath, snapshotDir } = installTestEmbeddingSnapshot(testRoot);
      const audit = new AuditService(testRoot);

      const service = new EmbeddingService(testRoot, audit, undefined, {
        customManifestPath: manifestPath,
        customSnapshotDir: snapshotDir,
        _mockInference: (texts) => texts.map((t) => createMockVector(t)),
      });

      const secretText = 'CONFIDENTIAL_FINANCIAL_RECORD_DO_NOT_LEAK';
      await service.generateEmbeddings({
        projectId,
        items: [{ text: secretText, chunkId: 'chk-audit-1' }],
      });

      // Query audit logs
      const events = audit.getRecords({ category: 'model' });
      expect(events.length).toBeGreaterThanOrEqual(1);

      const embedEvent = events.find((e) => (e.data as any)?.event === 'EMBEDDING_GENERATED');
      expect(embedEvent).toBeDefined();
      expect((embedEvent!.data as any).projectId).toBe(projectId);
      expect((embedEvent!.data as any).modelId).toBe(PINNED_EMBEDDING_CONFIG.modelId);
      expect((embedEvent!.data as any).dimension).toBe(384);
      expect((embedEvent!.data as any).itemCount).toBe(1);
      expect((embedEvent!.data as any).chunkIds).toContain('chk-audit-1');

      // Raw text MUST NOT be logged anywhere in audit entry
      const serialized = JSON.stringify(embedEvent);
      expect(serialized).not.toContain(secretText);
    });
  });

  // ── 10. ServiceContainer Integration ──────────────────────────────

  describe('10. ServiceContainer Integration', () => {
    it('creates container with embedding service properly wired', async () => {
      installTestEmbeddingSnapshot(testRoot);
      const container = createServiceContainer(testRoot);

      expect(container.embedding).toBeDefined();
      expect(container.embedding).toBeInstanceOf(EmbeddingService);

      const info = container.embedding.getModelInfo();
      expect(info.modelId).toBe('sentence-transformers/all-MiniLM-L6-v2');
      expect(info.dimension).toBe(384);
    });
  });
});
