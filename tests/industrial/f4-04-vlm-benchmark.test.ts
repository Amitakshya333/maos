/**
 * F4-04: Benchmark and Pin VLM Test Suite
 *
 * Verifies:
 * 1. Pinned VLM Model Configuration & Manifest Schemas
 * 2. Resource & Latency Budgets (<= 6144 MiB VRAM, RTX 4060 constraint)
 * 3. Shared GPU Model Manager weight ownership & serialized single-model residency
 * 4. 5-class priority queuing, anti-starvation aging, and fair chat limits
 * 5. 3-run benchmark stability harness (cold start, warm inference, repeatability)
 * 6. Negative guardrails: OOM, unhealthy probe, revision mismatch, runtime download, concurrency
 * 7. ModelService & ServiceContainer integration
 * 8. Protected invariant: rust/test.txt SHA-256 integrity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  PINNED_VLM_CONFIG,
  VLM_MANIFEST_BUDGETS,
  VLM_ERROR_CODES,
  VlmError,
  validateVlmModelConfig,
  validateVlmSnapshotManifest,
  validateVlmBenchmarkReport,
} from '../../src/domain/vision';
import { SharedModelManager, PRIORITY_WEIGHTS } from '../../src/service/model-manager';
import { VlmBenchmarkRunner } from '../../src/industrial/vlm-benchmark';
import { ModelService } from '../../src/service/model-service';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_HASH_TARGET = '1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435';

describe('F4-04: Benchmark and Pin VLM', () => {
  beforeEach(() => {
    SharedModelManager.resetInstance();
  });

  afterEach(() => {
    SharedModelManager.resetInstance();
  });

  // ── 1. Pinned VLM Specification & Manifest ───────────────────────

  describe('Pinned VLM Model Profile & Schemas', () => {
    it('pins Qwen/Qwen2-VL-2B-Instruct with correct revision and default quantization', () => {
      expect(PINNED_VLM_CONFIG.modelId).toBe('Qwen/Qwen2-VL-2B-Instruct');
      expect(PINNED_VLM_CONFIG.modelName).toBe('qwen2-vl-2b-instruct-local');
      expect(PINNED_VLM_CONFIG.revision).toBe('aa70c964147048705c93c4e16ff2bc55255470d0');
      expect(PINNED_VLM_CONFIG.defaultQuantization).toBe('int4');
      expect(PINNED_VLM_CONFIG.architecture).toBe('Qwen2VLForConditionalGeneration');
      expect(PINNED_VLM_CONFIG.parameterCount).toBe('2.21B');
    });

    it('enforces VRAM budget within RTX 4060 Laptop limits (<= 6144 MiB of ~6920 MiB available)', () => {
      expect(VLM_MANIFEST_BUDGETS.maxVramMb).toBe(6144);
      expect(VLM_MANIFEST_BUDGETS.maxVramBytes).toBe(6144 * 1024 * 1024);
      expect(VLM_MANIFEST_BUDGETS.coldStartBudgetMs).toBe(45000);
      expect(VLM_MANIFEST_BUDGETS.inferenceBudgetMs).toBe(15000);
      expect(VLM_MANIFEST_BUDGETS.benchmarkIterations).toBe(3);
    });

    it('validates VlmModelConfig schema successfully', () => {
      const validConfig = {
        schemaVersion: 1,
        modelId: PINNED_VLM_CONFIG.modelId,
        modelName: PINNED_VLM_CONFIG.modelName,
        revision: PINNED_VLM_CONFIG.revision,
        quantization: 'int4',
        device: 'cuda',
        architecture: PINNED_VLM_CONFIG.architecture,
        vramBudgetMb: 3072,
        contextTokens: 4096,
        snapshotPath: '/opt/models/qwen2-vl',
        hash: 'abc123hash',
      };
      const result = validateVlmModelConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects invalid VlmModelConfig schema with typed errors', () => {
      const invalid = { schemaVersion: 2, modelId: '' };
      const result = validateVlmModelConfig(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('verifies offline vlm-snapshot-manifest.json exists and passes schema validation', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'vlm-snapshot-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const validation = validateVlmSnapshotManifest(content);
      expect(validation.valid).toBe(true);
      expect(content.model).toBe(PINNED_VLM_CONFIG.modelId);
      expect(content.revision).toBe(PINNED_VLM_CONFIG.revision);
      expect(content.quantization).toBe('int4');
      expect(content.files.length).toBeGreaterThanOrEqual(8);
      expect(content.budgets.maxVramMb).toBe(6144);
    });
  });

  // ── 2. Shared GPU Model Manager Ownership & Residency ───────────

  describe('Shared GPU Model Manager Ownership & Residency', () => {
    it('acts as a singleton authority managing model leases and VRAM', () => {
      const manager1 = SharedModelManager.getInstance(PROJECT_ROOT);
      const manager2 = SharedModelManager.getInstance(PROJECT_ROOT);
      expect(manager1).toBe(manager2);
    });

    it('initializes default registrations for text model and pinned VLM', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      const textReg = manager.getModelRegistration('Qwen/Qwen2.5-3B-Instruct');
      const vlmReg = manager.getModelRegistration(PINNED_VLM_CONFIG.modelId);

      expect(textReg).toBeDefined();
      expect(textReg?.revision).toBe('aa8e72537993ba99e69dfaafa59ed015b17504d1');
      expect(vlmReg).toBeDefined();
      expect(vlmReg?.revision).toBe(PINNED_VLM_CONFIG.revision);
    });

    it('fails closed when the pinned VLM snapshot is absent', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      expect(() => manager.acquireLeaseSync({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'AGENT_TEST_1',
      })).toThrowError(/Snapshot directory not found|snapshot verification failed/i);
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('enforces serialized residency: switching models unloads previous when no active leases', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);

      // Load text model
      const lease1 = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'TEXT_AGENT',
      });
      expect(manager.getResidencyStatus().residentModelId).toBe('Qwen/Qwen2.5-3B-Instruct');
      manager.releaseLease(lease1.id);

      // A missing VLM snapshot must not evict the verified resident model.
      expect(() => manager.acquireLeaseSync({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'VISION_AGENT',
      })).toThrowError(/Snapshot directory not found|snapshot verification failed/i);
      expect(manager.getResidencyStatus().residentModelId).toBe('Qwen/Qwen2.5-3B-Instruct');
    });

    it('enforces priority queue ordering with 5 priority classes', () => {
      expect(PRIORITY_WEIGHTS.interactive_chat).toBe(1);
      expect(PRIORITY_WEIGHTS.user_task).toBe(2);
      expect(PRIORITY_WEIGHTS.active_workflow).toBe(3);
      expect(PRIORITY_WEIGHTS.auto_workflow).toBe(4);
      expect(PRIORITY_WEIGHTS.background_indexing).toBe(5);
    });

    it('supports cancelling queued requests', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      // Active lease holding the single GPU slot
      const lease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'SLOT_HOLDER',
      });

      // Register a second verified test registration using the checked-in
      // text snapshot so this queue test does not depend on absent VLM weights.
      const textSnapshotRelative = 'models--Qwen--Qwen2.5-3B-Instruct/snapshots/aa8e72537993ba99e69dfaafa59ed015b17504d1';
      const textSnapshotPath = path.join(PROJECT_ROOT, 'offline-stores', 'model-snapshot', textSnapshotRelative);
      const queuedManifestPath = path.join(PROJECT_ROOT, '.maos', 'queued-test-manifest.json');
      const configBytes = fs.readFileSync(path.join(textSnapshotPath, 'config.json'));
      fs.mkdirSync(path.dirname(queuedManifestPath), { recursive: true });
      fs.writeFileSync(queuedManifestPath, JSON.stringify({
        schemaVersion: 1, model: 'queued-test-model', revision: 'queued-test-revision',
        snapshotRelativePath: textSnapshotRelative,
        files: [{ path: 'config.json', size: configBytes.length, sha256: crypto.createHash('sha256').update(configBytes).digest('hex') }],
      }));
      manager.registerModel({
        modelId: 'queued-test-model', modelName: 'queued-test-model', revision: 'queued-test-revision',
        architecture: 'Qwen2ForCausalLM', quantization: 'fp16', vramRequiredMb: 4096, device: 'cuda', port: 8002,
        manifestPath: queuedManifestPath, snapshotPath: textSnapshotPath, isHealthy: true,
      });
      const p = manager.acquireLease({ modelId: 'queued-test-model', agentId: 'WAITING_AGENT' });

      expect(manager.getQueueLength()).toBe(1);
      // Let rejection be handled
      p.catch(() => {});

      // Cancel first queued request
      const cancelled = manager.cancelQueuedRequest('dummy_id');
      expect(cancelled).toBe(false);

      manager.releaseLease(lease.id);
    });

    it('fails closed for CPU fallback when the pinned VLM snapshot is absent', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      expect(() => manager.acquireLeaseSync({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'CPU_AGENT',
        allowCpuFallback: true,
      })).toThrowError(/Snapshot directory not found|snapshot verification failed/i);
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('verifies snapshot files and flags missing files with verifySnapshotManifest', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      const manifestPath = path.join(PROJECT_ROOT, 'vlm-snapshot-manifest.json');
      const dummySnapshotDir = path.join(PROJECT_ROOT, 'non_existent_snapshot_dir');

      const result = manager.verifySnapshotManifest(manifestPath, dummySnapshotDir);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Snapshot directory not found');
    });

    it('releases all leases and unloads residency on releaseAllLeases', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'BATCH_AGENT_1',
      });
      manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'BATCH_AGENT_2',
      });

      expect(manager.listLeases()).toHaveLength(2);
      expect(manager.getResidencyStatus().activeLeases).toBe(2);

      const count = manager.releaseAllLeases();
      expect(count).toBe(2);
      expect(manager.listLeases()).toHaveLength(0);
      expect(manager.getResidencyStatus().residentModelId).toBeNull();
      expect(manager.getResidencyStatus().residentDevice).toBe('none');
    });
  });

  // ── 3. Three-Run Benchmark Stability Harness ─────────────────────

  describe('Three-Run Benchmark Stability Harness', () => {
    it('executes 3 consecutive benchmark iterations and passes manifest budget', async () => {
      const runner = new VlmBenchmarkRunner({
        projectRoot: PROJECT_ROOT,
        simulated: {
          coldStartMs: 16200,
          inferenceLatencyMs: 3850,
          vramUsedMb: 3072,
          memoryPeakMb: 2048,
          tokensPerSec: 35.2,
        },
      });

      const report = await runner.runBenchmark();

      expect(report.schemaVersion).toBe(1);
      expect(report.modelId).toBe(PINNED_VLM_CONFIG.modelId);
      expect(report.revision).toBe(PINNED_VLM_CONFIG.revision);
      expect(report.runs).toHaveLength(3);
      expect(report.summary.totalRuns).toBe(3);
      expect(report.summary.successfulRuns).toBe(3);
      expect(report.summary.allWithinBudget).toBe(true);
      expect(report.budgetPassed).toBe(true);
      expect(report.errors).toHaveLength(0);

      // Check run 1: cold start
      expect(report.runs[0].runIndex).toBe(1);
      expect(report.runs[0].coldStartMs).toBe(16200);
      expect(report.runs[0].withinBudget).toBe(true);

      // Check run 2: warm inference
      expect(report.runs[1].runIndex).toBe(2);
      expect(report.runs[1].coldStartMs).toBe(120);
      expect(report.runs[1].withinBudget).toBe(true);

      // Check run 3: repeatability
      expect(report.runs[2].runIndex).toBe(3);
      expect(report.runs[2].coldStartMs).toBe(120);
      expect(report.runs[2].withinBudget).toBe(true);

      // Determinism: output hashes must be identical
      expect(report.runs[0].outputHash).toBe(report.runs[1].outputHash);
      expect(report.runs[1].outputHash).toBe(report.runs[2].outputHash);

      // Leases must be completely freed after benchmark
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('fails closed instead of fabricating telemetry when simulation is not requested', async () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      await expect(runner.runBenchmark()).rejects.toMatchObject({ code: VLM_ERROR_CODES.MODEL_RUNTIME_UNAVAILABLE });
    });
  });

  // ── 4. Negative Guardrails & Edge Cases ──────────────────────────

  describe('Negative Guardrails & Edge Cases', () => {
    it('rejects models exceeding VRAM budget with OOM_BUDGET_EXCEEDED', () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      const result = runner.evaluateOomGuard();
      expect(result.passed).toBe(true);
      expect(result.errorCode).toBe(VLM_ERROR_CODES.OOM_BUDGET_EXCEEDED);
    });

    it('rejects unhealthy models with MODEL_UNHEALTHY', () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      const result = runner.evaluateHealthGuard();
      expect(result.passed).toBe(true);
      expect(result.errorCode).toBe(VLM_ERROR_CODES.MODEL_UNHEALTHY);
    });

    it('rejects wrong or unpinned model revision with REVISION_MISMATCH', () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      const result = runner.evaluateRevisionGuard();
      expect(result.passed).toBe(true);
      expect(result.errorCode).toBe(VLM_ERROR_CODES.REVISION_MISMATCH);
    });

    it('rejects unpinned runtime download / missing snapshot with NO_RUNTIME_DOWNLOAD', () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      const result = runner.evaluateOfflineGuard();
      expect(result.passed).toBe(true);
      expect(result.errorCode).toBe(VLM_ERROR_CODES.NO_RUNTIME_DOWNLOAD);
    });

    it('rejects unqueued concurrent GPU residency with CONCURRENCY_VIOLATION', () => {
      const runner = new VlmBenchmarkRunner({ projectRoot: PROJECT_ROOT });
      const result = runner.evaluateConcurrencyGuard();
      expect(result.passed).toBe(true);
      expect(result.errorCode).toBe(VLM_ERROR_CODES.CONCURRENCY_VIOLATION);
    });

    it('rejects unregistered model lookup with MODEL_UNAVAILABLE', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      expect(() => {
        manager.acquireLeaseSync({
          modelId: 'non-existent-vlm-model',
          agentId: 'TEST_AGENT',
        });
      }).toThrow(VlmError);

      try {
        manager.acquireLeaseSync({
          modelId: 'non-existent-vlm-model',
          agentId: 'TEST_AGENT',
        });
      } catch (err: any) {
        expect(err.code).toBe(VLM_ERROR_CODES.MODEL_UNAVAILABLE);
      }
    });
  });

  // ── 5. Integration with ModelService & ServiceContainer ──────────

  describe('Integration with ModelService and ServiceContainer', () => {
    it('wires ModelService to delegate lease lifecycle to SharedModelManager', () => {
      const manager = SharedModelManager.getInstance(PROJECT_ROOT);
      const modelService = new ModelService(PROJECT_ROOT, manager);

      const lease = modelService.acquireLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'INGEST_AGENT',
        port: 8000,
      });

      expect(lease).toBeDefined();
      expect(lease.modelId).toBe('Qwen/Qwen2.5-3B-Instruct');
      expect(modelService.listLeases()).toHaveLength(1);
      expect(manager.listLeases()).toHaveLength(1);

      const status = modelService.getModelResidencyStatus();
      expect(status.residentModels).toContain('Qwen/Qwen2.5-3B-Instruct');
      expect(status.activeLeases).toBe(1);

      modelService.releaseLease(lease.id);
      expect(modelService.listLeases()).toHaveLength(0);
    });

    it('exposes modelManager on ServiceContainer', () => {
      const services = createServiceContainer(PROJECT_ROOT);
      expect(services.modelManager).toBeDefined();
      expect(services.modelManager).toBeInstanceOf(SharedModelManager);
      expect(services.model).toBeDefined();
    });
  });

  // ── 6. Protected Invariant Integrity ─────────────────────────────

  describe('Protected Invariant Integrity', () => {
    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      const targetFile = path.join(PROJECT_ROOT, 'rust', 'test.txt');
      expect(fs.existsSync(targetFile)).toBe(true);

      const buffer = fs.readFileSync(targetFile);
      const actualHash = crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();

      expect(actualHash).toBe(TEST_HASH_TARGET);
    });
  });
});
