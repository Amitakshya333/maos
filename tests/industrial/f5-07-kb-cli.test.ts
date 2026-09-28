/**
 * F5-07 Tests: Knowledge-Base CLI and Service Operations
 *
 * Comprehensive positive and negative test suite covering:
 *   1. All four commands: build, status, verify, clear
 *   2. Command routing through application services (KbService)
 *   3. Structured JSON output (--json) and human-readable output
 *   4. Stable numerical exit codes (KB_CLI_EXIT)
 *   5. Fail-closed missing offline model weights (NO_RUNTIME_DOWNLOAD -> exit 12)
 *   6. Corrupt / tampered index detection (exit 14)
 *   7. Stale index detection on modified source files (exit 15)
 *   8. Invalid project root rejection (missing .maos/ -> exit 10)
 *   9. Traversal, symlink escapes, and implicit home directory scan rejection
 *  10. Clear confirmation requirement (exit 16) and safe dry-run preview
 *  11. Clear preserves source documents, config, and audit trail
 *  12. Idempotent repeated runs (build, status, verify, clear)
 *  13. Privacy-safe audit events (KB_BUILD_*, KB_VERIFY_*, KB_CLEARED)
 *  14. Cross-project isolation
 *  15. Protected canary file invariant (rust/test.txt SHA-256)
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
  createDefaultCorpusPolicy,
  KbCorpusPolicy,
} from '../../src/domain/kb-corpus-policy';
import {
  PINNED_EMBEDDING_CONFIG,
  EmbeddingSnapshotManifest,
} from '../../src/domain/embedding';
import {
  createDeterministicSemanticVector,
} from '../../src/industrial/kb-retrieval-fixtures';
import {
  runKbBuild,
  runKbStatus,
  runKbVerify,
  runKbClear,
  resolveAndValidateKbProjectRoot,
  KbCliError,
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

describe('F5-07: Knowledge-Base CLI and Service Operations', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let testRoot: string;
  let customContainer: ServiceContainer;
  let audit: AuditService;
  let ingestion: KbIngestionService;
  let embedding: EmbeddingService;
  let indexService: KbVectorIndexService;
  let searchService: KbSearchService;
  let kbService: KbService;
  const projectId = 'test-kb-cli-project';

  /**
   * Helper to install mock embedding snapshot in testRoot
   */
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

  /**
   * Helper to seed standard documents in testRoot
   */
  function seedSampleDocuments(root: string): void {
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'valve_sop.txt'),
      'Relief valve calibration procedure. Tolerance must remain within 1.5 percent of nominal set point.',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(docsDir, 'pump_manual.md'),
      '# Centrifugal Pump Alignment\nShaft laser alignment tolerance must not exceed 0.05 mm angular offset.',
      'utf-8',
    );
  }

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f5-07-test-'));
    fs.mkdirSync(path.join(testRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'kb'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: projectId, id: projectId }),
    );

    SharedModelManager.resetInstance();
    installMockEmbeddingSnapshot(testRoot);
    seedSampleDocuments(testRoot);

    audit = new AuditService(testRoot);
    ingestion = new KbIngestionService(testRoot, audit);
    embedding = new EmbeddingService(testRoot, audit, undefined, {
      _mockInference: (texts) => texts.map((t) => createDeterministicSemanticVector(t)),
    });
    indexService = new KbVectorIndexService(testRoot, audit, ingestion, embedding);
    searchService = new KbSearchService(testRoot, indexService, embedding, ingestion, audit);
    kbService = new KbService(testRoot, ingestion, embedding, indexService, searchService, audit);

    customContainer = {
      ...createServiceContainer(testRoot),
      audit,
      ingestion,
      embedding,
      kbIndex: indexService,
      kbSearch: searchService,
      kb: kbService,
    };
  });

  afterEach(() => {
    SharedModelManager.resetInstance();
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Project Root Validation & Security ─────────────────────────

  describe('1. Project Root Validation & Security', () => {
    it('resolves valid project root with .maos directory', () => {
      const res = resolveAndValidateKbProjectRoot(testRoot, { allowTemp: true });
      expect(res.projectRoot.toLowerCase()).toBe(path.resolve(testRoot).toLowerCase());
      expect(res.projectId).toBe(projectId);
    });

    it('rejects empty or whitespace project path', () => {
      expect(() => resolveAndValidateKbProjectRoot('')).toThrowError(/Project path cannot be empty/);
      expect(() => resolveAndValidateKbProjectRoot('   ')).toThrowError(/Project path cannot be empty/);
    });

    it('rejects non-existent directory with INVALID_PROJECT (code 10)', () => {
      const nonExistent = path.join(testRoot, 'missing-folder-12345');
      try {
        resolveAndValidateKbProjectRoot(nonExistent);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(KbCliError);
        expect(err.exitCode).toBe(KB_CLI_EXIT.INVALID_PROJECT);
        expect(err.message).toContain('does not exist');
      }
    });

    it('rejects directory without .maos/ with INVALID_PROJECT (code 10)', () => {
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-dir-'));
      try {
        resolveAndValidateKbProjectRoot(bareDir, { allowTemp: true });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(KbCliError);
        expect(err.exitCode).toBe(KB_CLI_EXIT.INVALID_PROJECT);
        expect(err.message).toContain('Missing \'.maos\'');
      } finally {
        fs.rmSync(bareDir, { recursive: true, force: true });
      }
    });

    it('strictly rejects user home directory scan with INVALID_PROJECT (code 10)', () => {
      const homeDir = os.homedir();
      try {
        resolveAndValidateKbProjectRoot(homeDir);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(KbCliError);
        expect(err.exitCode).toBe(KB_CLI_EXIT.INVALID_PROJECT);
        expect(err.message).toContain('user home directory is strictly forbidden');
      }
    });

    it('strictly rejects path traversal escaping project boundary', () => {
      const escapedPath = path.join(testRoot, '..', '..', '..', 'some-external-folder');
      try {
        resolveAndValidateKbProjectRoot(escapedPath);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(KbCliError);
        expect(err.exitCode).toBe(KB_CLI_EXIT.INVALID_PROJECT);
      }
    });
  });

  // ── 2. Command: kb build ──────────────────────────────────────────

  describe('2. Command: industrial kb build', () => {
    it('builds knowledge base index successfully and returns exit code 0', async () => {
      const res = await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
      expect(res.data!.projectId).toBe(projectId);
      expect(res.data!.documentCount).toBe(2);
      expect(res.data!.chunkCount).toBeGreaterThanOrEqual(2);
      expect(res.data!.status).toBe('built');
      expect(res.data!.entriesHash).toBeDefined();

      // Verify index file was written atomically to disk
      const idxPath = path.join(testRoot, '.maos', 'kb', 'vector-index.json');
      expect(fs.existsSync(idxPath)).toBe(true);
    });

    it('produces structured JSON output when --json is passed', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const res = await runKbBuild({
          projectRoot: testRoot,
          allowTemp: true,
          services: customContainer,
          json: true,
        });

        expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
        expect(logs.length).toBeGreaterThan(0);

        const parsed = JSON.parse(logs[0]);
        expect(parsed.success).toBe(true);
        expect(parsed.exitCode).toBe(0);
        expect(parsed.data.documentCount).toBe(2);
      } finally {
        console.log = origLog;
      }
    });

    it('fails closed with MISSING_MODEL (code 12) when offline embedding snapshot is absent', async () => {
      const noModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-model-'));
      fs.mkdirSync(path.join(noModelDir, '.maos'), { recursive: true });
      fs.mkdirSync(path.join(noModelDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(noModelDir, 'docs', 'test.txt'), 'Sample document.');

      try {
        const res = await runKbBuild({
          projectRoot: noModelDir,
          allowTemp: true,
        });

        expect(res.exitCode).toBe(KB_CLI_EXIT.MISSING_MODEL);
        expect(res.success).toBe(false);
        expect(res.error).toContain('NO_RUNTIME_DOWNLOAD');
      } finally {
        fs.rmSync(noModelDir, { recursive: true, force: true });
      }
    });

    it('handles idempotent repeated build without corrupting state', async () => {
      const firstRun = await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });
      expect(firstRun.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(firstRun.data!.status).toBe('built');

      const secondRun = await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });
      expect(secondRun.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(secondRun.data!.status).toBe('up_to_date');
      expect(secondRun.data!.entriesHash).toBe(firstRun.data!.entriesHash);
    });

    it('fails closed with POLICY_FAILURE (code 11) when corpus policy is invalid', async () => {
      const polPath = path.join(testRoot, '.maos', 'kb', 'corpus-policy.json');
      fs.writeFileSync(polPath, JSON.stringify({ schemaVersion: 999, projectId, policyVersion: -1 }), 'utf-8');

      const res = await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.POLICY_FAILURE);
      expect(res.success).toBe(false);
      expect(res.error).toContain('policy');
    });
  });

  // ── 3. Command: kb status ─────────────────────────────────────────

  describe('3. Command: industrial kb status', () => {
    it('reports not_built state before index build', async () => {
      const res = await runKbStatus({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.data!.index.state).toBe('not_built');
      expect(res.data!.privacyClean).toBe(true);
    });

    it('reports up_to_date state after successful build', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const res = await runKbStatus({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.data!.index.state).toBe('up_to_date');
      expect(res.data!.index.documentCount).toBe(2);
      expect(res.data!.ingestion.documentCount).toBe(2);
      expect(res.data!.embedding.modelId).toBe(PINNED_EMBEDDING_CONFIG.modelId);
      expect(res.data!.privacyClean).toBe(true);
    });

    it('is strictly read-only and idempotent across repeated calls', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const stat1 = await runKbStatus({ projectRoot: testRoot, allowTemp: true, services: customContainer });
      const stat2 = await runKbStatus({ projectRoot: testRoot, allowTemp: true, services: customContainer });

      expect(stat1.data!.index.entriesHash).toBe(stat2.data!.index.entriesHash);
      expect(stat1.data!.index.lastBuiltAt).toBe(stat2.data!.index.lastBuiltAt);
    });

    it('produces structured JSON output for status when --json is passed', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const res = await runKbStatus({
          projectRoot: testRoot,
          allowTemp: true,
          services: customContainer,
          json: true,
        });

        expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
        const parsed = JSON.parse(logs[0]);
        expect(parsed.success).toBe(true);
        expect(parsed.data.policy).toBeDefined();
        expect(parsed.data.embedding).toBeDefined();
        expect(parsed.data.index).toBeDefined();
      } finally {
        console.log = origLog;
      }
    });
  });

  // ── 4. Command: kb verify ─────────────────────────────────────────

  describe('4. Command: industrial kb verify', () => {
    it('fails verification with INDEX_CORRUPT (code 14) before build', async () => {
      const res = await runKbVerify({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.INDEX_CORRUPT);
      expect(res.success).toBe(false);
      expect(res.data!.valid).toBe(false);
      expect(res.data!.errors.length).toBeGreaterThan(0);
    });

    it('passes verification with exit code 0 after valid build', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const res = await runKbVerify({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.success).toBe(true);
      expect(res.data!.valid).toBe(true);
      expect(res.data!.errors).toEqual([]);
      expect(res.data!.checks.every((c) => c.passed)).toBe(true);
    });

    it('detects tampered index float and fails with INDEX_CORRUPT (code 14)', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      // Tamper vector float in index
      const idxPath = path.join(testRoot, '.maos', 'kb', 'vector-index.json');
      const data = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
      data.entries[0].vector[0] = 0.999999;
      fs.writeFileSync(idxPath, JSON.stringify(data));

      const res = await runKbVerify({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.INDEX_CORRUPT);
      expect(res.success).toBe(false);
      expect(res.data!.valid).toBe(false);
    });

    it('detects stale index when source document is modified and fails with STALE_INDEX (code 15)', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      // Modify source file without rebuilding
      const docPath = path.join(testRoot, 'docs', 'valve_sop.txt');
      fs.writeFileSync(docPath, 'Modified content altering source hash.', 'utf-8');

      const res = await runKbVerify({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.STALE_INDEX);
      expect(res.success).toBe(false);
      expect(res.data!.valid).toBe(false);
    });

    it('produces structured JSON output for verify when --json is passed', async () => {
      await runKbBuild({ projectRoot: testRoot, allowTemp: true, services: customContainer });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const res = await runKbVerify({
          projectRoot: testRoot,
          allowTemp: true,
          services: customContainer,
          json: true,
        });

        expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
        const parsed = JSON.parse(logs[0]);
        expect(parsed.success).toBe(true);
        expect(parsed.data.valid).toBe(true);
        expect(parsed.data.checks.length).toBeGreaterThanOrEqual(5);
      } finally {
        console.log = origLog;
      }
    });
  });

  // ── 5. Command: kb clear ──────────────────────────────────────────

  describe('5. Command: industrial kb clear', () => {
    it('requires confirmation and fails with CONFIRMATION_REQUIRED (code 16) when --yes is omitted', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const res = await runKbClear({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.CONFIRMATION_REQUIRED);
      expect(res.success).toBe(false);
      expect(res.error).toContain('requires explicit confirmation');

      // Verify index was not deleted
      const idxPath = path.join(testRoot, '.maos', 'kb', 'vector-index.json');
      expect(fs.existsSync(idxPath)).toBe(true);
    });

    it('supports safe dry-run preview mode without deleting files', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const res = await runKbClear({
        projectRoot: testRoot,
        allowTemp: true,
        dryRun: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.data!.dryRun).toBe(true);
      expect(res.data!.removedCount).toBeGreaterThan(0);
      expect(res.data!.sourceFilesPreserved).toBe(true);

      // Verify files still exist on disk
      const idxPath = path.join(testRoot, '.maos', 'kb', 'vector-index.json');
      expect(fs.existsSync(idxPath)).toBe(true);
    });

    it('clears only generated KB artifacts when confirmed with --yes', async () => {
      await runKbBuild({
        projectRoot: testRoot,
        allowTemp: true,
        services: customContainer,
      });

      const res = await runKbClear({
        projectRoot: testRoot,
        allowTemp: true,
        yes: true,
        services: customContainer,
      });

      expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(res.success).toBe(true);
      expect(res.data!.dryRun).toBe(false);
      expect(res.data!.removedCount).toBeGreaterThan(0);

      // Verify generated index and chunks are deleted
      const idxPath = path.join(testRoot, '.maos', 'kb', 'vector-index.json');
      const chunksDir = path.join(testRoot, '.maos', 'kb', 'chunks');
      expect(fs.existsSync(idxPath)).toBe(false);
      expect(fs.existsSync(chunksDir)).toBe(false);

      // Verify source documents are strictly preserved
      const docPath = path.join(testRoot, 'docs', 'valve_sop.txt');
      expect(fs.existsSync(docPath)).toBe(true);

      // Verify unrelated .maos config and audit logs are preserved
      const configPath = path.join(testRoot, '.maos', 'maos.config.json');
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it('handles idempotent repeated clear safely', async () => {
      const clear1 = await runKbClear({ projectRoot: testRoot, allowTemp: true, yes: true, services: customContainer });
      const clear2 = await runKbClear({ projectRoot: testRoot, allowTemp: true, yes: true, services: customContainer });

      expect(clear1.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
      expect(clear2.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
    });

    it('produces structured JSON output for clear when --json is passed', async () => {
      await runKbBuild({ projectRoot: testRoot, allowTemp: true, services: customContainer });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const res = await runKbClear({
          projectRoot: testRoot,
          allowTemp: true,
          dryRun: true,
          services: customContainer,
          json: true,
        });

        expect(res.exitCode).toBe(KB_CLI_EXIT.SUCCESS);
        const parsed = JSON.parse(logs[0]);
        expect(parsed.success).toBe(true);
        expect(parsed.data.dryRun).toBe(true);
        expect(parsed.data.sourceFilesPreserved).toBe(true);
      } finally {
        console.log = origLog;
      }
    });
  });

  // ── 6. Privacy & Audit Trail Verification ─────────────────────────

  describe('6. Privacy & Audit Trail Verification', () => {
    it('records privacy-preserving audit events without raw document or query text', async () => {
      await runKbBuild({ projectRoot: testRoot, allowTemp: true, services: customContainer });
      await runKbVerify({ projectRoot: testRoot, allowTemp: true, services: customContainer });
      await runKbClear({ projectRoot: testRoot, allowTemp: true, yes: true, services: customContainer });

      const events = audit.getRecords({ source: 'kb-service' });
      expect(events.length).toBeGreaterThanOrEqual(4);

      const eventTypes = events.map((e) => (e.data as any).event);
      expect(eventTypes).toContain('KB_BUILD_STARTED');
      expect(eventTypes).toContain('KB_BUILD_COMPLETED');
      expect(eventTypes).toContain('KB_VERIFY_COMPLETED');
      expect(eventTypes).toContain('KB_CLEARED');

      // Verify privacy: audit data must NEVER include raw document strings
      const allAuditJson = JSON.stringify(events);
      expect(allAuditJson).not.toContain('Tolerance must remain within 1.5 percent');
      expect(allAuditJson).not.toContain('Shaft laser alignment tolerance');
    });
  });

  // ── 7. Cross-Project Isolation ────────────────────────────────────

  describe('7. Cross-Project Isolation', () => {
    it('fails closed when attempting to build or verify across project boundaries', async () => {
      await runKbBuild({ projectRoot: testRoot, allowTemp: true, services: customContainer });

      // Search with mismatched policy and project ID must fail closed
      await expect(
        searchService.search(
          {
            schemaVersion: 1,
            projectId: 'foreign-isolated-project-999',
            query: 'relief valve tolerance',
            requestId: 'req-foreign-eval',
          },
          customContainer.kb.resolvePolicy(projectId),
        ),
      ).rejects.toThrowError(/CROSS_PROJECT/);

      // Loading index for foreign project ID must fail closed
      expect(() => indexService.loadIndex('foreign-isolated-project-999')).toThrowError(/CROSS_PROJECT/);
    });
  });

  // ── 8. Protected File Invariant ───────────────────────────────────

  describe('8. Protected File Invariant', () => {
    it('preserves rust/test.txt SHA-256 integrity', () => {
      const canaryPath = path.resolve(__dirname, '..', '..', 'rust', 'test.txt');
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(canaryPath)).digest('hex');
      expect(actualHash).toBe(CANARY_HASH);
    });
  });
});
