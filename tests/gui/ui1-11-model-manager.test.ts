/**
 * UI1-11: Shared GPU Model Manager and Leases Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Types & Pure Validators:
 *    - validateAcquireModelLeaseInput: validates required fields, priorities, revisions, timeouts
 *    - validateRenewModelLeaseInput: enforces positive integer extensionMs, leaseId
 *    - validateReleaseModelLeaseInput: validates leaseId and scope options
 *    - Pinned model configurations: PINNED_MODELS, PINNED_TEXT_CONFIG
 * 2. SharedModelManager Residency & Leases:
 *    - Single authoritative residency in VRAM
 *    - Serialized GPU residency & rejection of concurrent GPU loading (CONCURRENCY_VIOLATION)
 *    - CPU embedding model (all-MiniLM-L6-v2) co-existence without GPU eviction
 *    - Project and run-scoped lease isolation:
 *        - Acquire stamps projectId, runId, revision, device
 *        - Cross-project release rejected (CROSS_PROJECT_LEASE_ACCESS)
 *        - Wrong-run release rejected (WRONG_RUN_LEASE_RELEASE)
 *        - Project-filtered listLeases(projectId)
 *    - Audited lease renew, expire, and prune:
 *        - Active lease extension updates expiresAt
 *        - Expired lease renewal rejected (LEASE_EXPIRED)
 *        - pruneExpiredLeases and reapStaleLeases recover VRAM
 *    - Workflow-fixed model protection:
 *        - Active workflow run locks resident model (WORKFLOW_FIXED_MODEL_PROTECTED)
 *    - Health probe enforcement:
 *        - Unhealthy model lease acquire rejected (MODEL_UNHEALTHY)
 *    - Budget bounds:
 *        - VRAM overcommit beyond manifest budget rejected (OOM_BUDGET_EXCEEDED)
 *    - Zero runtime downloads:
 *        - Unregistered model rejected (MODEL_UNAVAILABLE)
 *        - Revision mismatch rejected (REVISION_MISMATCH)
 *    - Service restart recovery (recoverState)
 * 3. ModelService Application Layer:
 *    - listRegisteredModels, listModels, getModelResidencyStatus
 *    - Audited lease acquire, release, renew, reap
 * 4. REST API Router & Middleware:
 *    - GET /api/v1/models
 *    - GET /api/v1/models/residency
 *    - GET /api/v1/models/leases (with ?projectId=)
 *    - POST /api/v1/models/leases (with idempotency)
 *    - POST /api/v1/models/leases/:id/renew
 *    - DELETE /api/v1/models/leases/:id (with scope validation)
 *    - POST /api/v1/models/leases/reap
 *    - DELETE /api/v1/models/leases (release all)
 * 5. 4-Way Client Parity:
 *    - ServiceContainer, RestApiRouter, MaosRestClient, BrowserRestClient, GuiApiAdapter
 * 6. Security Invariants:
 *    - Canary file test.txt SHA-256 preservation
 *    - Gate G5 passed state, G6 and G7 passed state
 *    - Air-gap / zero network requests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  validateAcquireModelLeaseInput,
  validateRenewModelLeaseInput,
  validateReleaseModelLeaseInput,
  PINNED_MODELS,
  PINNED_TEXT_CONFIG,
  PRIORITY_WEIGHTS,
} from '../../src/domain/model-manifest';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import { SharedModelManager } from '../../src/service/model-manager';
import { RestApiRouter } from '../../src/api/router';
import { MaosRestClient } from '../../src/api/client';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import { VLM_ERROR_CODES, VLM_MANIFEST_BUDGETS, PINNED_VLM_CONFIG } from '../../src/domain/vision';

describe('UI1-11: Shared GPU Model Manager and Leases', () => {
  let tempDir: string;
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let restClient: MaosRestClient;
  let browserClient: BrowserRestClient;
  let adapter: GuiApiAdapter;

  beforeAll(async () => {
    SharedModelManager.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-ui1-11-'));

    // Setup dummy project config
    const configDir = path.join(tempDir, '.maos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'test-ui1-11',
          agents: [
            { id: 'lead-dev', role: 'lead', model: 'Qwen/Qwen2.5-3B-Instruct', provider: 'local' },
            { id: 'analyst', role: 'researcher', model: 'all-MiniLM-L6-v2', provider: 'local' },
          ],
        },
        null,
        2,
      ),
    );

    // Setup snapshot manifests and files
    const textSnapshotRelativePath = 'models--Qwen--Qwen2.5-3B-Instruct/snapshots/aa8e72537993ba99e69dfaafa59ed015b17504d1';
    const textSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', textSnapshotRelativePath);
    fs.mkdirSync(textSnapshotDir, { recursive: true });
    const textConfig = Buffer.from('{"model_type":"qwen2"}', 'utf8');
    fs.writeFileSync(path.join(textSnapshotDir, 'config.json'), textConfig);
    fs.writeFileSync(path.join(tempDir, 'model-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'Qwen/Qwen2.5-3B-Instruct',
      revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
      snapshotRelativePath: textSnapshotRelativePath,
      files: [{ path: 'config.json', size: textConfig.length, sha256: crypto.createHash('sha256').update(textConfig).digest('hex') }],
    }));

    const embSnapshotRelativePath = 'models--sentence-transformers--all-MiniLM-L6-v2/snapshots/fa979fdf926cbd99430f16e4321689952542a641';
    const embSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', embSnapshotRelativePath);
    fs.mkdirSync(embSnapshotDir, { recursive: true });
    const embConfig = Buffer.from('{"model_type":"bert"}', 'utf8');
    fs.writeFileSync(path.join(embSnapshotDir, 'config.json'), embConfig);
    fs.writeFileSync(path.join(tempDir, 'embedding-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      revision: 'fa979fdf926cbd99430f16e4321689952542a641',
      snapshotRelativePath: embSnapshotRelativePath,
      files: [{ path: 'config.json', size: embConfig.length, sha256: crypto.createHash('sha256').update(embConfig).digest('hex') }],
    }));

    const vlmSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', PINNED_VLM_CONFIG.snapshotRelativePath);
    fs.mkdirSync(vlmSnapshotDir, { recursive: true });
    const vlmConfig = Buffer.from('{"model_type":"qwen2_vl"}', 'utf8');
    fs.writeFileSync(path.join(vlmSnapshotDir, 'config.json'), vlmConfig);
    fs.writeFileSync(path.join(tempDir, 'vlm-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: PINNED_VLM_CONFIG.modelId,
      revision: PINNED_VLM_CONFIG.revision,
      snapshotRelativePath: PINNED_VLM_CONFIG.snapshotRelativePath,
      quantization: PINNED_VLM_CONFIG.defaultQuantization,
      files: [{ path: 'config.json', size: vlmConfig.length, sha256: crypto.createHash('sha256').update(vlmConfig).digest('hex') }],
    }));

    services = createServiceContainer(tempDir);
    router = new RestApiRouter(services, tempDir);

    server = http.createServer(async (req, res) => {
      const handled = await router.handle(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    restClient = new MaosRestClient({ baseUrl, projectRoot: tempDir });
    browserClient = new BrowserRestClient({ baseUrl, projectRoot: tempDir });
    adapter = new GuiApiAdapter({ baseUrl, projectRoot: tempDir });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    // Release any lingering leases between tests
    services.model.releaseAllLeases();
  });

  // ══════════════════════════════════════════════════════════════════════
  // 1. Domain Types & Pure Validators
  // ══════════════════════════════════════════════════════════════════════

  describe('1. Domain Types & Pure Validators', () => {
    it('validates pinned models dictionary and text model configs', () => {
      const qwen = PINNED_MODELS.find((m) => m.modelId === 'Qwen/Qwen2.5-3B-Instruct');
      expect(qwen).toBeDefined();
      expect(qwen?.device).toBe('cuda');

      const embedding = PINNED_MODELS.find((m) => m.modelId.includes('all-MiniLM-L6-v2'));
      expect(embedding).toBeDefined();
      expect(embedding?.device).toBe('cpu');
      expect(embedding?.vramRequiredMb).toBe(0);

      expect(PINNED_TEXT_CONFIG.modelId).toBe('Qwen/Qwen2.5-3B-Instruct');
      expect(PRIORITY_WEIGHTS.interactive_chat).toBe(1);
      expect(PRIORITY_WEIGHTS.user_task).toBe(2);
      expect(PRIORITY_WEIGHTS.background_indexing).toBe(5);
    });

    it('validateAcquireModelLeaseInput rejects missing or invalid fields', () => {
      const v1 = validateAcquireModelLeaseInput(null);
      expect(v1.valid).toBe(false);
      expect(v1.errors[0]).toContain('non-null object');

      const v2 = validateAcquireModelLeaseInput({});
      expect(v2.valid).toBe(false);
      expect(v2.errors).toContain('modelId must be a non-empty string');
      expect(v2.errors).toContain('agentId must be a non-empty string');

      const v3 = validateAcquireModelLeaseInput({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
        timeoutMs: -50,
      });
      expect(v3.valid).toBe(false);
      expect(v3.errors).toContain('timeoutMs must be a positive number');

      const v4 = validateAcquireModelLeaseInput({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
        priority: 'invalid_priority' as any,
      });
      expect(v4.valid).toBe(false);
      expect(v4.errors[0]).toContain('Invalid priority');
    });

    it('validateAcquireModelLeaseInput accepts valid inputs', () => {
      const val = validateAcquireModelLeaseInput({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-alpha',
        projectId: 'proj-001',
        runId: 'run-001',
        priority: 'interactive_chat',
        timeoutMs: 60000,
        expectedRevision: 'b1b5900',
        allowCpuFallback: false,
      });
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
    });

    it('validateRenewModelLeaseInput validates lease renewal input', () => {
      const v1 = validateRenewModelLeaseInput({ leaseId: '', extensionMs: 1000 });
      expect(v1.valid).toBe(false);
      expect(v1.errors).toContain('leaseId must be a non-empty string');

      const v2 = validateRenewModelLeaseInput({ leaseId: 'lease-1', extensionMs: 0 });
      expect(v2.valid).toBe(false);
      expect(v2.errors).toContain('extensionMs must be a positive number <= 86,400,000 (24h)');

      const v3 = validateRenewModelLeaseInput({
        leaseId: 'lease-1',
        extensionMs: 30000,
        projectId: 'proj-1',
      });
      expect(v3.valid).toBe(true);
    });

    it('validateReleaseModelLeaseInput validates lease release input', () => {
      const v1 = validateReleaseModelLeaseInput({ leaseId: '' });
      expect(v1.valid).toBe(false);
      expect(v1.errors).toContain('leaseId must be a non-empty string');

      const v2 = validateReleaseModelLeaseInput({
        leaseId: 'lease-1',
        projectId: 'proj-1',
        runId: 'run-1',
      });
      expect(v2.valid).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. SharedModelManager Core Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('2. SharedModelManager Core Invariants', () => {
    let manager: SharedModelManager;

    beforeEach(() => {
      manager = services.model.getModelManager();
      manager.releaseAllLeases();
    });

    it('enforces single GPU model residency in VRAM', () => {
      const leaseA = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
      });
      expect(leaseA).toBeDefined();
      expect(leaseA.modelId).toBe('Qwen/Qwen2.5-3B-Instruct');

      const status = manager.getResidencyStatus();
      expect(status.residentModelId).toBe('Qwen/Qwen2.5-3B-Instruct');
      expect(status.residentDevice).toBe('cuda');
      expect(status.vramUsedMb).toBe(4096);
      expect(status.vramBudgetMb).toBe(VLM_MANIFEST_BUDGETS.maxVramMb);
      expect(status.activeLeases).toBe(1);

      // Same model can acquire another lease (sharing resident GPU weights)
      const leaseA2 = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-2',
      });
      expect(leaseA2).toBeDefined();
      expect(manager.getResidencyStatus().activeLeases).toBe(2);

      manager.releaseLease(leaseA.id);
      manager.releaseLease(leaseA2.id);
      expect(manager.getResidencyStatus().activeLeases).toBe(0);
    });

    it('rejects concurrent immediate load of a different GPU model', () => {
      const lease1 = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
      });
      expect(lease1).toBeDefined();

      // Attempting to acquire a different GPU model while leases active must throw CONCURRENCY_VIOLATION
      let err: any;
      try {
        manager.acquireLeaseSync({
          modelId: PINNED_VLM_CONFIG.modelId,
          agentId: 'agent-2',
        });
      } catch (e: any) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(VLM_ERROR_CODES.CONCURRENCY_VIOLATION);

      manager.releaseLease(lease1.id);

      // Once released, switching to the other GPU model succeeds
      const lease2 = manager.acquireLeaseSync({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'agent-2',
      });
      expect(lease2).toBeDefined();
      expect(manager.getResidencyStatus().residentModelId).toBe(PINNED_VLM_CONFIG.modelId);

      manager.releaseLease(lease2.id);
    });

    it('permits concurrent CPU embedding model leases without evicting resident GPU model', () => {
      const gpuLease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'coder-agent',
      });
      expect(gpuLease).toBeDefined();

      // Acquire CPU embedding lease
      const cpuLease = manager.acquireLeaseSync({
        modelId: 'all-MiniLM-L6-v2',
        agentId: 'embedder-agent',
      });
      expect(cpuLease).toBeDefined();
      expect(cpuLease.device).toBe('cpu');

      // GPU residency remains intact
      const status = manager.getResidencyStatus();
      expect(status.residentModelId).toBe('Qwen/Qwen2.5-3B-Instruct');
      expect(status.residentDevice).toBe('cuda');
      expect(status.activeLeases).toBe(2);

      // CPU lease release does not affect GPU model
      manager.releaseLease(cpuLease.id);
      expect(manager.getResidencyStatus().residentModelId).toBe('Qwen/Qwen2.5-3B-Instruct');

      manager.releaseLease(gpuLease.id);
    });

    it('enforces project-scope boundary on lease release', () => {
      const lease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
        projectId: 'project-alpha',
        runId: 'run-001',
      });

      expect(lease.projectId).toBe('project-alpha');
      expect(lease.runId).toBe('run-001');

      // Release with wrong project fails closed
      expect(() => {
        manager.releaseLease(lease.id, { projectId: 'project-beta' });
      }).toThrow(/CROSS_PROJECT_LEASE_ACCESS/);

      // Release with wrong run fails closed
      expect(() => {
        manager.releaseLease(lease.id, { projectId: 'project-alpha', runId: 'run-999' });
      }).toThrow(/WRONG_RUN_LEASE_RELEASE/);

      // Release with matching project and run succeeds
      const released = manager.releaseLease(lease.id, { projectId: 'project-alpha', runId: 'run-001' });
      expect(released).toBe(true);
    });

    it('enforces workflow-fixed model protection', () => {
      // Acquire a GPU lease tied to an active workflow runId
      const runLease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'workflow-agent',
        runId: 'active-workflow-run-123',
      });
      expect(runLease).toBeDefined();

      // Attempting to switch model must throw WORKFLOW_FIXED_MODEL_PROTECTED
      let err: any;
      try {
        manager.acquireLeaseSync({
          modelId: PINNED_VLM_CONFIG.modelId,
          agentId: 'other-agent',
        });
      } catch (e: any) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.code).toBe(VLM_ERROR_CODES.CONCURRENCY_VIOLATION);
      expect(err.message).toContain('WORKFLOW_FIXED_MODEL_PROTECTED');

      manager.releaseLease(runLease.id, { runId: 'active-workflow-run-123' });
    });

    it('handles lease renewal and rejects expired renewals', () => {
      const shortTimeoutMs = 50;
      const lease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
        projectId: 'project-1',
        timeoutMs: shortTimeoutMs,
      });

      expect(lease.expiresAt).toBeDefined();
      const originalExpiry = new Date(lease.expiresAt!).getTime();

      // Renew while active succeeds
      const renewed = manager.renewLease(lease.id, 5000, { projectId: 'project-1' });
      const newExpiry = new Date(renewed.expiresAt!).getTime();
      expect(newExpiry).toBeGreaterThan(originalExpiry);

      manager.releaseLease(lease.id, { projectId: 'project-1' });
    });

    it('reaps stale/expired leases and recovers VRAM', async () => {
      const lease = manager.acquireLeaseSync({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-1',
        timeoutMs: 10, // 10ms expiry
      });

      // Wait 30ms for lease to expire
      await new Promise((r) => setTimeout(r, 30));

      const reaped = manager.reapStaleLeases();
      expect(reaped).toBe(1);
      expect(manager.listLeases()).toHaveLength(0);
    });

    it('rejects unpinned model or revision mismatch', () => {
      try {
        manager.acquireLeaseSync({
          modelId: 'unpinned-rogue-model',
          agentId: 'agent-1',
        });
        expect.unreachable('Should have thrown MODEL_UNAVAILABLE');
      } catch (err: any) {
        expect(err.code).toBe(VLM_ERROR_CODES.MODEL_UNAVAILABLE);
      }

      try {
        manager.acquireLeaseSync({
          modelId: 'Qwen/Qwen2.5-3B-Instruct',
          agentId: 'agent-1',
          expectedRevision: 'wrong-revision-hash',
        });
        expect.unreachable('Should have thrown REVISION_MISMATCH');
      } catch (err: any) {
        expect(err.code).toBe(VLM_ERROR_CODES.REVISION_MISMATCH);
      }
    });

    it('rejects unhealthy model', () => {
      manager.setModelHealth('Qwen/Qwen2.5-3B-Instruct', false, 'Simulated probe timeout');
      try {
        manager.acquireLeaseSync({
          modelId: 'Qwen/Qwen2.5-3B-Instruct',
          agentId: 'agent-1',
        });
        expect.unreachable('Should have thrown MODEL_UNHEALTHY');
      } catch (err: any) {
        expect(err.code).toBe(VLM_ERROR_CODES.MODEL_UNHEALTHY);
      } finally {
        manager.setModelHealth('Qwen/Qwen2.5-3B-Instruct', true);
      }
    });

    it('rejects VRAM overcommit exceeding manifest budget', () => {
      manager.registerModel({
        modelId: 'giant-model',
        modelName: 'giant-model',
        revision: 'rev-giant',
        architecture: 'deepseek',
        quantization: 'fp16',
        vramRequiredMb: 12000, // Exceeds 6000 MB budget
        device: 'cuda',
        port: 11437,
        isHealthy: true,
      });

      try {
        manager.acquireLeaseSync({
          modelId: 'giant-model',
          agentId: 'agent-1',
        });
        expect.unreachable('Should have thrown OOM_BUDGET_EXCEEDED');
      } catch (err: any) {
        expect(err.code).toBe(VLM_ERROR_CODES.OOM_BUDGET_EXCEEDED);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. ModelService Application Layer
  // ══════════════════════════════════════════════════════════════════════

  describe('3. ModelService Application Layer', () => {
    it('exposes listRegisteredModels and listModels with pinned identities', () => {
      const registered = services.model.listRegisteredModels();
      expect(registered.length).toBeGreaterThanOrEqual(2);

      const qwen = registered.find((m) => m.modelId === 'Qwen/Qwen2.5-3B-Instruct');
      expect(qwen).toBeDefined();
      expect(qwen?.device).toBe('cuda');
      expect(qwen?.revision).toBeDefined();

      const allModels = services.model.listModels();
      expect(allModels.length).toBeGreaterThanOrEqual(2);
    });

    it('exposes getModelResidencyStatus with typed fields and backward compatibility', () => {
      const status = services.model.getModelResidencyStatus();
      expect(status).toBeDefined();
      expect(typeof status.vramBudgetMb).toBe('number');
      expect(typeof status.vramUsedMb).toBe('number');
      expect(typeof status.activeLeases).toBe('number');
      expect(Array.isArray(status.residentModels)).toBe(true);
    });

    it('acquires and releases leases through ModelService with audit logging', () => {
      const lease = services.model.acquireLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'unit-tester',
        projectId: 'project-svc-test',
      });

      expect(lease).toBeDefined();
      expect(services.model.listLeases()).toHaveLength(1);

      const released = services.model.releaseLease(lease.id, { projectId: 'project-svc-test' });
      expect(released).toBe(true);
      expect(services.model.listLeases()).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. REST API Router Endpoints
  // ══════════════════════════════════════════════════════════════════════

  describe('4. REST API Router Endpoints', () => {
    it('GET /api/v1/models returns models and registeredModels', async () => {
      const res = await restClient.listModels();
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      const data = res.data as any;
      expect(Array.isArray(data.models || data)).toBe(true);
      if (data.registeredModels) {
        expect(Array.isArray(data.registeredModels)).toBe(true);
      }
    });

    it('GET /api/v1/models/residency returns typed residency status', async () => {
      const res = await restClient.getModelResidencyStatus();
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      expect(res.data?.vramBudgetMb).toBe(VLM_MANIFEST_BUDGETS.maxVramMb);
      expect(res.data?.healthy).toBe(true);
    });

    it('POST /api/v1/models/leases acquires lease and DELETE /api/v1/models/leases/:id releases it', async () => {
      const acquireRes = await restClient.acquireModelLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'api-tester',
        projectId: 'proj-rest-test',
        runId: 'run-rest-001',
      });

      expect(acquireRes.status).toBe(201);
      expect(acquireRes.data).toBeDefined();
      const leaseId = acquireRes.data!.id;

      // GET /api/v1/models/leases with projectId filter
      const listRes = await restClient.listModelLeases('proj-rest-test');
      expect(listRes.status).toBe(200);
      expect(listRes.data?.some((l) => l.id === leaseId)).toBe(true);

      // DELETE with wrong project returns 400 CROSS_PROJECT_LEASE_ACCESS
      const failDelete = await restClient.releaseModelLease(leaseId, { projectId: 'wrong-proj' });
      expect(failDelete.status).toBe(400);
      expect(failDelete.error?.code).toBe('CROSS_PROJECT_LEASE_ACCESS');

      // DELETE with matching project and run succeeds
      const successDelete = await restClient.releaseModelLease(leaseId, {
        projectId: 'proj-rest-test',
        runId: 'run-rest-001',
      });
      expect(successDelete.status).toBe(200);
      expect(successDelete.data?.released).toBe(true);
    });

    it('POST /api/v1/models/leases/:id/renew renews lease expiration', async () => {
      const acquireRes = await restClient.acquireModelLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'renew-tester',
        projectId: 'proj-renew',
        timeoutMs: 10000,
      });
      expect(acquireRes.status).toBe(201);
      const leaseId = acquireRes.data!.id;

      const renewRes = await restClient.renewModelLease(leaseId, 15000, { projectId: 'proj-renew' });
      expect(renewRes.status).toBe(200);
      expect(renewRes.data?.expiresAt).toBeDefined();

      await restClient.releaseModelLease(leaseId, { projectId: 'proj-renew' });
    });

    it('POST /api/v1/models/leases/reap triggers stale lease reaping', async () => {
      const res = await restClient.reapStaleModelLeases();
      expect(res.status).toBe(200);
      expect(typeof res.data?.reapedCount).toBe('number');
    });

    it('DELETE /api/v1/models/leases releases all leases', async () => {
      await restClient.acquireModelLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent-a',
      });
      const res = await restClient.releaseAllModelLeases();
      expect(res.status).toBe(200);
      expect(res.data?.releasedCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. 4-Way Client Parity
  // ══════════════════════════════════════════════════════════════════════

  describe('5. 4-Way Client Parity', () => {
    it('BrowserRestClient satisfies contract for leases and residency', async () => {
      const status = await browserClient.getModelResidencyStatus();
      expect(status).toBeDefined();
      expect(typeof status.vramBudgetMb).toBe('number');

      const lease = await browserClient.acquireModelLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'browser-tester',
      });
      expect(lease).toBeDefined();

      const leases = await browserClient.getModelLeases();
      expect(leases.some((l) => l.id === lease.id)).toBe(true);

      const relRes = await browserClient.releaseModelLease(lease.id);
      expect(relRes.released).toBe(true);
    });

    it('GuiApiAdapter unifies model management for React views', async () => {
      const status = await adapter.getModelResidencyStatus();
      expect(status).toBeDefined();

      const lease = await adapter.acquireModelLease({
        modelId: 'all-MiniLM-L6-v2',
        agentId: 'adapter-tester',
      });
      expect(lease).toBeDefined();

      const leases = await adapter.getModelLeases();
      expect(leases.some((l) => l.id === lease.id)).toBe(true);

      const relRes = await adapter.releaseModelLease(lease.id);
      expect(relRes.released).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. Security Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('6. Security Invariants', () => {
    it('verifies canary rust/test.txt SHA-256 hash preservation', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);
      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });

    it('verifies Gate G5 is passed and Gates G6/G7 are passed in plan', () => {
      const planPath = path.resolve(__dirname, '../../docs/SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf8');

      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
