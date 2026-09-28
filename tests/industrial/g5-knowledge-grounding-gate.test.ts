/**
 * Gate G5: Knowledge Grounding Readiness Verification Suite
 *
 * Validates the core criteria for Gate G5:
 *   1. Production Offline Gate Verification:
 *      - Honestly confirms that real production offline weights are absent
 *      - Confirms fail-closed behavior (NO_RUNTIME_DOWNLOAD -> exit code 12)
 *      - G5 gate remains conditional pending offline weight staging
 *   2. Full Retrieval Benchmark (Controlled Fixture Mode):
 *      - 24 frozen queries across 13 classes
 *      - 3 iterations with 100% determinism
 *      - Average Recall@1 target >= 0.70 on answerable queries
 *      - 100% accuracy on no-answer queries
 *      - Exact citations with full provenance (sourceHash, chunkId, documentVersion, sectionHeading)
 *      - Strict prompt injection exclusion / data-only containment
 *      - All 9 negative guardrails pass
 *   3. Strict Multi-Project Isolation:
 *      - Two independent project roots (Project Alpha vs Project Beta)
 *      - Cross-project queries fail closed with CROSS_PROJECT
 *      - Clearing one project does not alter or corrupt the other
 *   4. Full CLI / Service Parity:
 *      - build, status, verify, clear via CLI runner functions with identical exit codes and JSON schemas
 *   5. Privacy-Preserving Audit Trail:
 *      - Cryptographic queryHash only; zero raw text or secrets logged
 *   6. Protected File Invariant:
 *      - rust/test.txt SHA-256 remains unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  KB_CLI_EXIT,
  KbBuildResult,
  KbStatusResult,
  KbVerifyResult,
  KbClearResult,
} from '../../src/domain/kb-cli-types';
import {
  PINNED_EMBEDDING_CONFIG,
  EmbeddingError,
  EmbeddingSnapshotManifest,
} from '../../src/domain/embedding';
import {
  createDefaultCorpusPolicy,
} from '../../src/domain/kb-corpus-policy';
import {
  KbRetrievalBenchmarkRunner,
} from '../../src/industrial/kb-retrieval-benchmark';
import {
  setupKbRetrievalFixtures,
  createDeterministicSemanticVector,
} from '../../src/industrial/kb-retrieval-fixtures';
import {
  runKbBuild,
  runKbStatus,
  runKbVerify,
  runKbClear,
} from '../../src/industrial/kb-cli';
import {
  createServiceContainer,
  ServiceContainer,
  AuditService,
  KbIngestionService,
  EmbeddingService,
  KbVectorIndexService,
  KbSearchService,
  KbService,
  SharedModelManager,
} from '../../src/service';
import {
  executeSearchKnowledgeBaseToolAsync,
} from '../../src/integrations/tools';

describe('Gate G5: Knowledge Grounding Readiness Verification', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectAlphaRoot: string;
  let projectBetaRoot: string;

  function installMockEmbeddingSnapshot(root: string): void {
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
      const filePath = path.join(snapshotDir, f.name);
      fs.writeFileSync(filePath, f.content);
      manifestFiles.push({
        path: f.name,
        size: f.content.length,
        sha256: crypto.createHash('sha256').update(f.content).digest('hex'),
      });
    }

    const manifest: EmbeddingSnapshotManifest = {
      schemaVersion: 1,
      model: PINNED_EMBEDDING_CONFIG.modelId,
      modelName: PINNED_EMBEDDING_CONFIG.modelName,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      dimension: PINNED_EMBEDDING_CONFIG.dimension,
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
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  beforeEach(() => {
    projectAlphaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-g5-alpha-'));
    projectBetaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-g5-beta-'));

    fs.mkdirSync(path.join(projectAlphaRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectAlphaRoot, '.maos', 'kb'), { recursive: true });
    fs.mkdirSync(path.join(projectAlphaRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(projectAlphaRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'alpha-corp-kb', id: 'alpha-corp-kb' }),
    );

    fs.mkdirSync(path.join(projectBetaRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectBetaRoot, '.maos', 'kb'), { recursive: true });
    fs.mkdirSync(path.join(projectBetaRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(projectBetaRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'beta-corp-kb', id: 'beta-corp-kb' }),
    );

    SharedModelManager.resetInstance();
  });

  afterEach(() => {
    SharedModelManager.resetInstance();
    try { fs.rmSync(projectAlphaRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectBetaRoot, { recursive: true, force: true }); } catch {}
  });

  // ── 1. Production Offline Gate & Blocker Honest Reporting ─────────

  describe('1. Production Offline Gate Verification', () => {
    it('honestly marks productionLiveBlocked = true when offline weights are absent', () => {
      const runner = new KbRetrievalBenchmarkRunner({
        projectRoot: projectAlphaRoot,
        projectId: 'alpha-corp-kb',
      });
      expect(runner.isProductionLiveAvailable()).toBe(false);
    });

    it('production build fails closed with NO_RUNTIME_DOWNLOAD (code 12) without mock', async () => {
      // In project without staged model snapshot
      fs.writeFileSync(path.join(projectAlphaRoot, 'docs', 'manual.txt'), 'Operating manual.');
      const res = await runKbBuild({
        projectRoot: projectAlphaRoot,
        allowTemp: true,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.MISSING_MODEL);
      expect(res.success).toBe(false);
      expect(res.error).toContain('NO_RUNTIME_DOWNLOAD');
    });

    it('production search fails closed with NO_RUNTIME_DOWNLOAD when weights are absent', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      const pol = createDefaultCorpusPolicy('alpha-corp-kb', ['docs']);
      const audit = new AuditService(projectAlphaRoot);
      const ing = new KbIngestionService(projectAlphaRoot, audit);
      const mockEmb = new EmbeddingService(projectAlphaRoot, audit, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const idx = new KbVectorIndexService(projectAlphaRoot, audit, ing, mockEmb);
      fs.writeFileSync(path.join(projectAlphaRoot, 'docs', 'manual.txt'), 'Operating manual for alpha.');
      ing.ingest({ sourcePath: 'docs/manual.txt', projectId: 'alpha-corp-kb' }, pol);
      await idx.buildIndex('alpha-corp-kb', pol);

      // Create an isolated root without offline weights snapshot
      const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-no-weights-'));
      const emptyAudit = new AuditService(emptyRoot);
      const realOfflineEmbedding = new EmbeddingService(emptyRoot, emptyAudit);

      const searchWithRealEmbedding = new KbSearchService(
        projectAlphaRoot,
        idx,
        realOfflineEmbedding,
        ing,
        audit,
      );

      await expect(
        searchWithRealEmbedding.search({
          schemaVersion: 1,
          projectId: 'alpha-corp-kb',
          query: 'calibration tolerance',
          requestId: 'req-prod-fail-closed',
        }, pol),
      ).rejects.toThrowError(/NO_RUNTIME_DOWNLOAD/);

      fs.rmSync(emptyRoot, { recursive: true, force: true });
    });
  });

  // ── 2. Retrieval Evaluation Benchmark (Controlled Fixture Mode) ───

  describe('2. Retrieval Evaluation Benchmark & Determinism', () => {
    it('executes full 24-query benchmark meeting recall targets and 100% determinism', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      const policy = createDefaultCorpusPolicy('alpha-corp-kb', ['docs']);
      const audit = new AuditService(projectAlphaRoot);
      const ingestion = new KbIngestionService(projectAlphaRoot, audit);
      const embedding = new EmbeddingService(projectAlphaRoot, audit, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const indexService = new KbVectorIndexService(projectAlphaRoot, audit, ingestion, embedding);
      const searchService = new KbSearchService(projectAlphaRoot, indexService, embedding, ingestion, audit);

      await setupKbRetrievalFixtures(projectAlphaRoot, 'alpha-corp-kb', policy, ingestion, indexService);

      const customContainer = {
        ...createServiceContainer(projectAlphaRoot),
        audit,
        ingestion,
        embedding,
        kbIndex: indexService,
        kbSearch: searchService,
      } as ServiceContainer;

      const runner = new KbRetrievalBenchmarkRunner({
        projectRoot: projectAlphaRoot,
        projectId: 'alpha-corp-kb',
        services: customContainer,
        policy,
        iterations: 3,
      });

      const report = await runner.runBenchmark();
      expect(report.schemaVersion).toBe(1);
      expect(report.iterations.length).toBe(3);
      expect(report.summary.rankingDeterminismRate).toBe(1.0);
      expect(report.summary.avgRecallAt1).toBeGreaterThanOrEqual(0.70);
      expect(report.summary.noAnswerAccuracy).toBe(1.0);
      expect(report.summary.passedQueries).toBeGreaterThanOrEqual(20);
      expect(report.summary.productionLiveBlocked).toBe(true);

      // Verify evidence report saved atomically
      const evidenceDir = path.join(projectAlphaRoot, '.maos', 'verification', 'evidence');
      const files = fs.readdirSync(evidenceDir);
      expect(files.some((f) => f.startsWith('kb-retrieval-benchmark-'))).toBe(true);
    });

    it('passes all 9 negative security and failure guardrails', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      const policy = createDefaultCorpusPolicy('alpha-corp-kb', ['docs']);
      const audit = new AuditService(projectAlphaRoot);
      const ingestion = new KbIngestionService(projectAlphaRoot, audit);
      const embedding = new EmbeddingService(projectAlphaRoot, audit, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const indexService = new KbVectorIndexService(projectAlphaRoot, audit, ingestion, embedding);
      const searchService = new KbSearchService(projectAlphaRoot, indexService, embedding, ingestion, audit);

      await setupKbRetrievalFixtures(projectAlphaRoot, 'alpha-corp-kb', policy, ingestion, indexService);

      const customContainer = {
        ...createServiceContainer(projectAlphaRoot),
        audit,
        ingestion,
        embedding,
        kbIndex: indexService,
        kbSearch: searchService,
      } as ServiceContainer;

      const runner = new KbRetrievalBenchmarkRunner({
        projectRoot: projectAlphaRoot,
        projectId: 'alpha-corp-kb',
        services: customContainer,
        policy,
      });

      const missingSnap = await runner.evaluateMissingSnapshotGuard();
      expect(missingSnap.passed).toBe(true);

      const runtimeDl = runner.evaluateRuntimeDownloadGuard();
      expect(runtimeDl.passed).toBe(true);

      const staleIdx = await runner.evaluateStaleIndexGuard(indexService, policy);
      expect(staleIdx.passed).toBe(true);

      const tamperedIdx = await runner.evaluateTamperedIndexGuard();
      expect(tamperedIdx.passed).toBe(true);

      const wrongRev = await runner.evaluateWrongModelRevisionGuard();
      expect(wrongRev.passed).toBe(true);

      const crossProj = await runner.evaluateCrossProjectGuard();
      expect(crossProj.passed).toBe(true);

      const pathTrav = await runner.evaluatePathTraversalGuard();
      expect(pathTrav.passed).toBe(true);

      const promptInj = await runner.evaluatePromptInjectionGuard();
      expect(promptInj.passed).toBe(true);

      const oversized = await runner.evaluateOversizedQueryGuard();
      expect(oversized.passed).toBe(true);
    });
  });

  // ── 3. Strict Multi-Project Isolation ──────────────────────────────

  describe('3. Strict Multi-Project Isolation', () => {
    it('strictly isolates corpora between Project Alpha and Project Beta', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      installMockEmbeddingSnapshot(projectBetaRoot);

      // Seed Alpha with valve documentation
      fs.writeFileSync(
        path.join(projectAlphaRoot, 'docs', 'alpha_spec.txt'),
        'Alpha Project: Safety valve calibration is 1.5 percent tolerance.',
      );

      // Seed Beta with chemical dosing documentation
      fs.writeFileSync(
        path.join(projectBetaRoot, 'docs', 'beta_spec.txt'),
        'Beta Project: Coagulant dosing set point is 25 mg/L optimum.',
      );

      const auditA = new AuditService(projectAlphaRoot);
      const ingA = new KbIngestionService(projectAlphaRoot, auditA);
      const embA = new EmbeddingService(projectAlphaRoot, auditA, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const idxA = new KbVectorIndexService(projectAlphaRoot, auditA, ingA, embA);
      const searchA = new KbSearchService(projectAlphaRoot, idxA, embA, ingA, auditA);
      const kbA = new KbService(projectAlphaRoot, ingA, embA, idxA, searchA, auditA);

      const auditB = new AuditService(projectBetaRoot);
      const ingB = new KbIngestionService(projectBetaRoot, auditB);
      const embB = new EmbeddingService(projectBetaRoot, auditB, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const idxB = new KbVectorIndexService(projectBetaRoot, auditB, ingB, embB);
      const searchB = new KbSearchService(projectBetaRoot, idxB, embB, ingB, auditB);
      const kbB = new KbService(projectBetaRoot, ingB, embB, idxB, searchB, auditB);

      // Build both projects
      const buildA = await kbA.build({ projectId: 'alpha-corp-kb' });
      const buildB = await kbB.build({ projectId: 'beta-corp-kb' });
      expect(buildA.success).toBe(true);
      expect(buildB.success).toBe(true);

      // Search Alpha for valve tolerance
      const resA = await searchA.search({
        schemaVersion: 1,
        projectId: 'alpha-corp-kb',
        query: 'safety valve calibration tolerance',
        requestId: 'req-alpha-search-1',
      }, kbA.resolvePolicy('alpha-corp-kb'));
      expect(resA.answered).toBe(true);
      expect(resA.citations[0].snippet).toContain('1.5 percent');

      // Attempt querying Alpha using Beta's project ID -> Must be rejected with CROSS_PROJECT
      await expect(
        searchA.search({
          schemaVersion: 1,
          projectId: 'beta-corp-kb',
          query: 'safety valve calibration tolerance',
          requestId: 'req-alpha-cross-attempt',
        }, kbA.resolvePolicy('alpha-corp-kb')),
      ).rejects.toThrowError(/CROSS_PROJECT/);

      // Attempt loading Beta index from Alpha root -> Must be rejected with CROSS_PROJECT
      expect(() => idxA.loadIndex('beta-corp-kb')).toThrowError(/CROSS_PROJECT/);

      // Clearing Alpha must not affect Beta's vector index or chunks
      await kbA.clear({ projectId: 'alpha-corp-kb', confirmed: true });
      expect(fs.existsSync(path.join(projectAlphaRoot, '.maos', 'kb', 'vector-index.json'))).toBe(false);
      expect(fs.existsSync(path.join(projectBetaRoot, '.maos', 'kb', 'vector-index.json'))).toBe(true);

      // Beta status remains valid
      const statusB = await kbB.status({ projectId: 'beta-corp-kb' });
      expect(statusB.index.state).toBe('up_to_date');
      expect(statusB.index.documentCount).toBe(1);
    });
  });

  // ── 4. Full CLI / Service Parity ──────────────────────────────────

  describe('4. Full CLI / Service Operations Parity', () => {
    it('executes build -> status -> verify -> clear through CLI with machine-readable JSON', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      fs.writeFileSync(path.join(projectAlphaRoot, 'docs', 'sop.txt'), 'Standard Operating Procedure.');

      const auditA = new AuditService(projectAlphaRoot);
      const ingA = new KbIngestionService(projectAlphaRoot, auditA);
      const embA = new EmbeddingService(projectAlphaRoot, auditA, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const idxA = new KbVectorIndexService(projectAlphaRoot, auditA, ingA, embA);
      const searchA = new KbSearchService(projectAlphaRoot, idxA, embA, ingA, auditA);
      const kbA = new KbService(projectAlphaRoot, ingA, embA, idxA, searchA, auditA);

      const container = {
        ...createServiceContainer(projectAlphaRoot),
        audit: auditA,
        ingestion: ingA,
        embedding: embA,
        kbIndex: idxA,
        kbSearch: searchA,
        kb: kbA,
      };

      // 1. Build
      const buildRes = await runKbBuild({
        projectRoot: projectAlphaRoot,
        allowTemp: true,
        services: container,
        json: true,
      });
      expect(buildRes.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(buildRes.data!.documentCount).toBe(1);

      // 2. Status
      const statusRes = await runKbStatus({
        projectRoot: projectAlphaRoot,
        allowTemp: true,
        services: container,
        json: true,
      });
      expect(statusRes.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(statusRes.data!.index.state).toBe('up_to_date');

      // 3. Verify
      const verifyRes = await runKbVerify({
        projectRoot: projectAlphaRoot,
        allowTemp: true,
        services: container,
        json: true,
      });
      expect(verifyRes.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(verifyRes.data!.valid).toBe(true);

      // 4. Clear
      const clearRes = await runKbClear({
        projectRoot: projectAlphaRoot,
        allowTemp: true,
        services: container,
        yes: true,
        json: true,
      });
      expect(clearRes.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(clearRes.data!.removedCount).toBeGreaterThanOrEqual(2);
      expect(clearRes.data!.sourceFilesPreserved).toBe(true);
    });
  });

  // ── 5. Privacy & Audit Trail Verification ─────────────────────────

  describe('5. Privacy & Audit Trail Verification', () => {
    it('verifies audit trail contains query hashes without sensitive text', async () => {
      installMockEmbeddingSnapshot(projectAlphaRoot);
      fs.writeFileSync(path.join(projectAlphaRoot, 'docs', 'valve.txt'), 'Secret valve tolerance is 0.05 percent.');

      const auditA = new AuditService(projectAlphaRoot);
      const ingA = new KbIngestionService(projectAlphaRoot, auditA);
      const embA = new EmbeddingService(projectAlphaRoot, auditA, undefined, {
        _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
      });
      const idxA = new KbVectorIndexService(projectAlphaRoot, auditA, ingA, embA);
      const searchA = new KbSearchService(projectAlphaRoot, idxA, embA, ingA, auditA);
      const kbA = new KbService(projectAlphaRoot, ingA, embA, idxA, searchA, auditA);

      await kbA.build({ projectId: 'alpha-corp-kb' });

      // Run search tool
      await searchA.search({
        schemaVersion: 1,
        projectId: 'alpha-corp-kb',
        query: 'What is the secret valve tolerance?',
        requestId: 'req-privacy-audit-test',
      }, kbA.resolvePolicy('alpha-corp-kb'));

      const events = auditA.getRecords();
      const allEventsString = JSON.stringify(events);

      // Must NOT contain sensitive query text or document text
      expect(allEventsString).not.toContain('What is the secret valve tolerance?');
      expect(allEventsString).not.toContain('Secret valve tolerance is 0.05 percent');

      // MUST contain queryHash and event types
      expect(allEventsString).toContain('KB_SEARCH_EXECUTED');
      expect(allEventsString).toContain('queryHash');
    });
  });

  // ── 6. Protected File Invariant ───────────────────────────────────

  describe('6. Protected File Invariant', () => {
    it('preserves rust/test.txt SHA-256 integrity', () => {
      const canaryPath = path.resolve(__dirname, '..', '..', 'rust', 'test.txt');
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(canaryPath)).digest('hex');
      expect(actualHash).toBe(CANARY_HASH);
    });
  });
});
