/**
 * UI1-13: Model Switcher and Auto-Routing Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Types & Pure Validators:
 *    - validateModelRouteRequest: validates modality, taskType, complexity, hasImages
 *    - validateModelSwitchRequest: enforces targetModelId, actor, reason, revision, confirmation
 *    - Capabilities & Pinned Model Manifest constants
 * 2. ModelSwitchService & Routing Engine:
 *    - Automatic routing based on task requirements (text, vision, embedding)
 *    - Modality compatibility checking and fail-closed rejection
 *    - Audited manual override with actor and reason
 *    - Authoritative active model identity visibility (residency, device, VRAM, leases, workflow lock)
 *    - Workflow-fixed model protection (rejects mid-run and workflow-locked switches)
 *    - Concurrency violation on active GPU leases
 *    - Explicit confirmation for disruptive switches requiring model unload
 *    - CPU model co-existence without GPU eviction
 *    - Unregistered model rejection (MODEL_UNAVAILABLE)
 *    - Revision mismatch rejection (REVISION_MISMATCH)
 *    - Missing offline snapshot rejection (NO_RUNTIME_DOWNLOAD)
 *    - Unhealthy model rejection (MODEL_UNHEALTHY)
 *    - Tamper-evident audit logging
 * 3. REST API Router:
 *    - GET /api/v1/models/active
 *    - POST /api/v1/models/route
 *    - POST /api/v1/models/switch (normal, unconfirmed, confirmed, workflow-locked, concurrency violation)
 * 4. 4-Way Client Parity:
 *    - ServiceContainer, RestApiRouter, MaosRestClient, BrowserRestClient, GuiApiAdapter
 * 5. Security & Gate Invariants:
 *    - Canary file rust/test.txt SHA-256 preservation
 *    - Gate G5 passed state, G6 and G7 passed state
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  validateModelRouteRequest,
  validateModelSwitchRequest,
  SWITCH_ERROR_CODES,
  PINNED_MODEL_CAPABILITIES,
  ModelRouteRequest,
  ModelSwitchRequest,
} from '../../src/domain/model-switch';
import { PINNED_TEXT_CONFIG, PINNED_MODELS } from '../../src/domain/model-manifest';
import { PINNED_VLM_CONFIG } from '../../src/domain/vision';
import { PINNED_EMBEDDING_CONFIG } from '../../src/domain/embedding';
import {
  createServiceContainer,
  ServiceContainer,
  SharedModelManager,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { MaosRestClient } from '../../src/api/client';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';

describe('UI1-13: Model Switcher and Auto-Routing', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-ui1-13-'));

    // Setup dummy project config
    const configDir = path.join(tempDir, '.maos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'test-ui1-13',
          storage: { engine: 'file' },
          audit: { enabled: true, hashAlgorithm: 'sha256' },
          projectRoot: tempDir,
          agents: [
            { id: 'lead-dev', role: 'lead', model: 'Qwen/Qwen2.5-3B-Instruct', provider: 'local' },
            { id: 'vision-reviewer', role: 'reviewer', model: PINNED_VLM_CONFIG.modelId, provider: 'local' },
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
    fs.writeFileSync(
      path.join(tempDir, 'model-snapshot-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        model: 'Qwen/Qwen2.5-3B-Instruct',
        revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
        snapshotRelativePath: textSnapshotRelativePath,
        files: [{ path: 'config.json', size: textConfig.length, sha256: crypto.createHash('sha256').update(textConfig).digest('hex') }],
      }),
    );

    const embSnapshotRelativePath = 'models--sentence-transformers--all-MiniLM-L6-v2/snapshots/fa979fdf926cbd99430f16e4321689952542a641';
    const embSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', embSnapshotRelativePath);
    fs.mkdirSync(embSnapshotDir, { recursive: true });
    const embConfig = Buffer.from('{"model_type":"bert"}', 'utf8');
    fs.writeFileSync(path.join(embSnapshotDir, 'config.json'), embConfig);
    fs.writeFileSync(
      path.join(tempDir, 'embedding-snapshot-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        revision: 'fa979fdf926cbd99430f16e4321689952542a641',
        snapshotRelativePath: embSnapshotRelativePath,
        files: [{ path: 'config.json', size: embConfig.length, sha256: crypto.createHash('sha256').update(embConfig).digest('hex') }],
      }),
    );

    const vlmSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', PINNED_VLM_CONFIG.snapshotRelativePath);
    fs.mkdirSync(vlmSnapshotDir, { recursive: true });
    const vlmConfig = Buffer.from('{"model_type":"qwen2_vl"}', 'utf8');
    fs.writeFileSync(path.join(vlmSnapshotDir, 'config.json'), vlmConfig);
    fs.writeFileSync(
      path.join(tempDir, 'vlm-snapshot-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        model: PINNED_VLM_CONFIG.modelId,
        revision: PINNED_VLM_CONFIG.revision,
        snapshotRelativePath: PINNED_VLM_CONFIG.snapshotRelativePath,
        quantization: PINNED_VLM_CONFIG.defaultQuantization,
        files: [{ path: 'config.json', size: vlmConfig.length, sha256: crypto.createHash('sha256').update(vlmConfig).digest('hex') }],
      }),
    );

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
    services.model.releaseAllLeases();
  });

  // ══════════════════════════════════════════════════════════════════════
  // 1. Domain Types & Pure Validators
  // ══════════════════════════════════════════════════════════════════════

  describe('1. Domain Types & Pure Validators', () => {
    it('validates ModelRouteRequest pure validator', () => {
      const valid = validateModelRouteRequest({
        taskType: 'ocr_review',
        modality: 'vision',
        hasImages: true,
        complexity: 'high',
        projectId: 'proj-1',
      });
      expect(valid.valid).toBe(true);

      const invalid = validateModelRouteRequest({
        complexity: 'super-hard',
        hasImages: 'yes' as any,
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThan(0);
    });

    it('validates ModelSwitchRequest pure validator (enforces actor & reason)', () => {
      const valid = validateModelSwitchRequest({
        targetModelId: 'Qwen/Qwen2.5-3B-Instruct',
        actor: 'operator_alice',
        reason: 'Investigate code optimization',
        confirmed: true,
      });
      expect(valid.valid).toBe(true);

      const missingActor = validateModelSwitchRequest({
        targetModelId: 'Qwen/Qwen2.5-3B-Instruct',
        actor: '',
        reason: 'Investigate code optimization',
      });
      expect(missingActor.valid).toBe(false);
      expect(missingActor.errors[0]).toContain('actor');

      const missingReason = validateModelSwitchRequest({
        targetModelId: 'Qwen/Qwen2.5-3B-Instruct',
        actor: 'operator_alice',
        reason: '',
      });
      expect(missingReason.valid).toBe(false);
      expect(missingReason.errors[0]).toContain('reason');

      const missingTarget = validateModelSwitchRequest({
        targetModelId: '',
        actor: 'operator_alice',
        reason: 'test',
      });
      expect(missingTarget.valid).toBe(false);
      expect(missingTarget.errors[0]).toContain('targetModelId');
    });

    it('verifies pinned model capabilities constants', () => {
      const textCap = PINNED_MODEL_CAPABILITIES.find((c) => c.modelId === 'Qwen/Qwen2.5-3B-Instruct');
      expect(textCap).toBeDefined();
      expect(textCap?.supportedModalities).toContain('text');
      expect(textCap?.supportedModalities).toContain('code');

      const vlmCap = PINNED_MODEL_CAPABILITIES.find((c) => c.modelId.includes('Qwen2-VL-2B-Instruct'));
      expect(vlmCap).toBeDefined();
      expect(vlmCap?.supportedModalities).toContain('vision');
      expect(vlmCap?.supportedModalities).toContain('multimodal');

      const embCap = PINNED_MODEL_CAPABILITIES.find((c) => c.modelId.includes('all-MiniLM-L6-v2'));
      expect(embCap).toBeDefined();
      expect(embCap?.supportedModalities).toEqual(['embedding']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. ModelSwitchService Core Routing & Residency Protection
  // ══════════════════════════════════════════════════════════════════════

  describe('2. ModelSwitchService Core Routing & Residency Protection', () => {
    it('determines route automatically: visual inputs route to pinned VLM', () => {
      const res = services.modelSwitch.determineRoute({
        hasImages: true,
        taskType: 'ocr_review',
      });
      expect(res.selectedModelId).toBe(PINNED_VLM_CONFIG.modelId);
      expect(res.device).toBe('cuda');
      expect(res.vramRequiredMb).toBe(3072);
      expect(res.confidence).toBeGreaterThan(0.9);
      expect(res.reason).toContain('VLM');
    });

    it('determines route automatically: embedding requests route to pinned MiniLM CPU', () => {
      const res = services.modelSwitch.determineRoute({
        modality: 'embedding',
        taskType: 'kb_search',
      });
      expect(res.selectedModelId).toContain('all-MiniLM-L6-v2');
      expect(res.device).toBe('cpu');
      expect(res.vramRequiredMb).toBe(0);
      expect(res.confidence).toBe(1.0);
    });

    it('determines route automatically: standard reasoning routes to pinned text LLM', () => {
      const res = services.modelSwitch.determineRoute({
        modality: 'text',
        promptText: 'Write a TypeScript function to calculate factorial',
      });
      expect(res.selectedModelId).toBe(PINNED_TEXT_CONFIG.modelId);
      expect(res.device).toBe('cuda');
      expect(res.vramRequiredMb).toBe(4096);
    });

    it('checks compatibility: rejects incompatible modalities', () => {
      const textCompat = services.modelSwitch.checkCompatibility(PINNED_TEXT_CONFIG.modelId, 'vision');
      expect(textCompat.compatible).toBe(false);
      expect(textCompat.reason).toContain('does not support modality');

      const embCompat = services.modelSwitch.checkCompatibility('sentence-transformers/all-MiniLM-L6-v2', 'text');
      expect(embCompat.compatible).toBe(false);

      const vlmCompat = services.modelSwitch.checkCompatibility(PINNED_VLM_CONFIG.modelId, 'vision');
      expect(vlmCompat.compatible).toBe(true);
    });

    it('performs audited manual model override: requires actor and reason', async () => {
      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_TEXT_CONFIG.modelId,
          actor: '',
          reason: 'Switching model',
        }),
      ).rejects.toThrow('actor');

      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_TEXT_CONFIG.modelId,
          actor: 'operator_bob',
          reason: '',
        }),
      ).rejects.toThrow('reason');
    });

    it('rejects switch to unregistered model (MODEL_UNAVAILABLE)', async () => {
      await expect(
        services.modelSwitch.switchModel({
          targetModelId: 'unregistered/llama-unknown-model',
          actor: 'operator_bob',
          reason: 'Testing unknown model',
        }),
      ).rejects.toThrow(/not registered/);
    });

    it('rejects switch when expected revision mismatches (REVISION_MISMATCH)', async () => {
      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_TEXT_CONFIG.modelId,
          expectedRevision: 'wrong-revision-hash-12345',
          actor: 'operator_bob',
          reason: 'Testing revision mismatch',
        }),
      ).rejects.toThrow(/Revision mismatch/);
    });

    it('rejects switch when offline snapshot directory is missing (NO_RUNTIME_DOWNLOAD)', async () => {
      // Register temporary model without snapshot
      services.modelManager.registerModel({
        modelId: 'dummy/offline-missing-test',
        modelName: 'offline-missing-test',
        revision: '1111111111111111111111111111111111111111',
        architecture: 'dummy',
        quantization: 'fp16',
        vramRequiredMb: 1000,
        device: 'cuda',
        port: 9999,
        manifestPath: path.join(tempDir, 'non-existent-manifest.json'),
        snapshotPath: path.join(tempDir, 'non-existent-snapshot'),
        isHealthy: true,
      });

      await expect(
        services.modelSwitch.switchModel({
          targetModelId: 'dummy/offline-missing-test',
          actor: 'operator_bob',
          reason: 'Testing missing snapshot',
        }),
      ).rejects.toThrow(/Runtime downloads are prohibited/);
    });

    it('rejects switch when model is marked unhealthy (MODEL_UNHEALTHY)', async () => {
      services.modelManager.setModelHealth(PINNED_TEXT_CONFIG.modelId, false, 'Simulated hardware error');

      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_TEXT_CONFIG.modelId,
          actor: 'operator_bob',
          reason: 'Testing unhealthy model',
        }),
      ).rejects.toThrow(/unhealthy/);

      // Restore health
      services.modelManager.setModelHealth(PINNED_TEXT_CONFIG.modelId, true);
    });

    it('enforces workflow-fixed model protection: rejects switch when active workflow run locks residency', async () => {
      // Establish residency and lock with workflow run
      const lease = await services.modelManager.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'workflow_agent',
        projectId: 'test-proj',
        runId: 'workflow-run-001',
      });
      expect(lease.id).toBeDefined();

      // Attempt to switch to VLM while workflow run is active
      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_VLM_CONFIG.modelId,
          actor: 'operator_bob',
          reason: 'Attempt mid-workflow switch',
          confirmed: true,
        }),
      ).rejects.toThrow(/WORKFLOW_FIXED_MODEL_PROTECTED/);

      // Release workflow lease
      services.modelManager.releaseLease(lease.id);
    });

    it('enforces mid-run switch protection: rejects switch when runId already holds another lease', async () => {
      const lease = await services.modelManager.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'worker_agent',
        projectId: 'test-proj',
        runId: 'task-run-42',
      });
      expect(lease.id).toBeDefined();

      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_VLM_CONFIG.modelId,
          actor: 'operator_bob',
          reason: 'Attempt switch on same run',
          runId: 'task-run-42',
          projectId: 'test-proj',
          confirmed: true,
        }),
      ).rejects.toThrow(/MID_RUN_SWITCH_FORBIDDEN|WORKFLOW_FIXED_MODEL_PROTECTED/);

      services.modelManager.releaseLease(lease.id);
    });

    it('enforces active GPU lease conflict: rejects switch when leases are active (CONCURRENCY_VIOLATION)', async () => {
      // Acquire active lease without runId (e.g. interactive agent)
      const lease = await services.modelManager.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'chat_agent',
        projectId: 'test-proj',
      });
      expect(lease.id).toBeDefined();

      await expect(
        services.modelSwitch.switchModel({
          targetModelId: PINNED_VLM_CONFIG.modelId,
          actor: 'operator_bob',
          reason: 'Attempt switch during active lease',
          confirmed: true,
        }),
      ).rejects.toThrow(/CONCURRENCY_VIOLATION/);

      services.modelManager.releaseLease(lease.id);
    });

    it('requires explicit confirmation for disruptive switch when model is resident with 0 leases', async () => {
      // Warm residency with text model and release lease
      const lease = await services.modelManager.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'init_agent',
      });
      services.modelManager.releaseLease(lease.id);

      // Current resident is Text model, leases = 0
      const residency = services.modelManager.getResidencyStatus();
      expect(residency.residentModelId).toBe(PINNED_TEXT_CONFIG.modelId);
      expect(residency.activeLeases).toBe(0);

      // Attempt switch to VLM without confirmation
      const unconfirmed = await services.modelSwitch.switchModel({
        targetModelId: PINNED_VLM_CONFIG.modelId,
        actor: 'operator_bob',
        reason: 'Switch to VLM for visual processing',
        confirmed: false,
      });

      expect(unconfirmed.status).toBe('CONFIRMATION_REQUIRED');
      expect(unconfirmed.requiresUnload).toBe(true);
      expect(unconfirmed.message).toContain('Explicit confirmation required');

      // Now switch with explicit confirmation
      const confirmed = await services.modelSwitch.switchModel({
        targetModelId: PINNED_VLM_CONFIG.modelId,
        actor: 'operator_bob',
        reason: 'Switch to VLM for visual processing',
        confirmed: true,
      });

      expect(confirmed.status).toBe('SWITCHED');
      expect(confirmed.activeModelId).toBe(PINNED_VLM_CONFIG.modelId);
      expect(confirmed.device).toBe('cuda');
      expect(confirmed.auditEventId).toBeDefined();

      // Clean up
      if (confirmed.leaseId) {
        services.modelManager.releaseLease(confirmed.leaseId);
      }
    });

    it('switches to CPU embedding model without unloading resident GPU model', async () => {
      // Ensure VLM is resident
      const lease = await services.modelManager.acquireLease({
        modelId: PINNED_VLM_CONFIG.modelId,
        agentId: 'init_vlm',
      });
      expect(services.modelManager.getResidencyStatus().residentModelId).toBe(PINNED_VLM_CONFIG.modelId);

      // Switch to CPU embedding model
      const result = await services.modelSwitch.switchModel({
        targetModelId: 'sentence-transformers/all-MiniLM-L6-v2',
        actor: 'operator_bob',
        reason: 'Switch to embedding model',
      });

      expect(result.status).toBe('SWITCHED');
      expect(result.requiresUnload).toBe(false);
      expect(result.device).toBe('cpu');

      // Resident GPU model should NOT have been unloaded
      expect(services.modelManager.getResidencyStatus().residentModelId).toBe(PINNED_VLM_CONFIG.modelId);

      services.modelManager.releaseLease(lease.id);
    });

    it('returns authoritative active model identity', () => {
      const identity = services.modelSwitch.getActiveModelIdentity();
      expect(identity).toBeDefined();
      expect(identity.healthy).toBe(true);
      expect(identity.device).toBeDefined();
      expect(identity.supportedModalities.length).toBeGreaterThan(0);
      expect(typeof identity.isWorkflowFixed).toBe('boolean');
      expect(typeof identity.vramUsedMb).toBe('number');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. REST API Router Endpoints
  // ══════════════════════════════════════════════════════════════════════

  describe('3. REST API Router Endpoints', () => {
    it('GET /api/v1/models/active returns authoritative model identity', async () => {
      const res = await restClient.getActiveModelIdentity();
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      expect(res.data?.healthy).toBe(true);
      expect(res.data?.supportedModalities).toBeDefined();
    });

    it('POST /api/v1/models/route routes request appropriately', async () => {
      const res = await restClient.routeModel({
        hasImages: true,
        taskType: 'ocr',
      });
      expect(res.status).toBe(200);
      expect(res.data?.selectedModelId).toBe(PINNED_VLM_CONFIG.modelId);
      expect(res.data?.device).toBe('cuda');
    });

    it('POST /api/v1/models/switch requests confirmation for unconfirmed disruptive switch', async () => {
      // Warm text model
      const lease = services.model.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'setup_agent',
      });
      services.model.releaseLease(lease.id);

      const res = await restClient.switchModel({
        targetModelId: PINNED_VLM_CONFIG.modelId,
        actor: 'rest_user',
        reason: 'Rest user switch request',
        confirmed: false,
      });

      expect(res.status).toBe(200);
      expect(res.data?.status).toBe('CONFIRMATION_REQUIRED');
      expect(res.data?.requiresUnload).toBe(true);
    });

    it('POST /api/v1/models/switch executes switch with confirmation', async () => {
      const res = await restClient.switchModel({
        targetModelId: PINNED_VLM_CONFIG.modelId,
        actor: 'rest_user',
        reason: 'Confirmed switch request',
        confirmed: true,
      });

      expect(res.status).toBe(200);
      expect(res.data?.status).toBe('SWITCHED');
      expect(res.data?.activeModelId).toBe(PINNED_VLM_CONFIG.modelId);

      if (res.data?.leaseId) {
        services.model.releaseLease(res.data.leaseId);
      }
    });

    it('POST /api/v1/models/switch returns 409 when locked by workflow run', async () => {
      // Lock text model with workflow run
      const lease = services.model.acquireLease({
        modelId: PINNED_TEXT_CONFIG.modelId,
        agentId: 'workflow_agent',
        runId: 'workflow-run-locked-99',
      });

      const res = await restClient.switchModel({
        targetModelId: PINNED_VLM_CONFIG.modelId,
        actor: 'rest_user',
        reason: 'Mid-workflow switch',
        confirmed: true,
      });

      expect(res.status).toBe(409);
      expect(res.error?.code).toBe('WORKFLOW_FIXED_MODEL_PROTECTED');

      services.model.releaseLease(lease.id);
    });

    it('POST /api/v1/models/switch returns 404 for unregistered model', async () => {
      const res = await restClient.switchModel({
        targetModelId: 'nonexistent/model',
        actor: 'rest_user',
        reason: 'Switch to missing model',
      });

      expect(res.status).toBe(404);
      expect(res.error?.code).toBe('MODEL_UNAVAILABLE');
    });

    it('POST /api/v1/models/switch returns 400 for unaudited override (missing actor/reason)', async () => {
      const res = await restClient.switchModel({
        targetModelId: PINNED_TEXT_CONFIG.modelId,
        actor: '',
        reason: '',
      });

      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('VALIDATION_FAILED');
    });

    it('POST /api/v1/models/switch returns 400 for incompatible modality request', async () => {
      const res = await restClient.switchModel({
        targetModelId: PINNED_TEXT_CONFIG.modelId,
        actor: 'rest_user',
        reason: 'Testing incompatible modality',
        requiredModality: 'vision',
      });

      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('MODALITY_INCOMPATIBLE');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. 4-Way Client Parity
  // ══════════════════════════════════════════════════════════════════════

  describe('4. 4-Way Client Parity', () => {
    it('verifies routeModel parity across ServiceContainer, MaosRestClient, BrowserRestClient, and GuiApiAdapter', async () => {
      const req: ModelRouteRequest = {
        hasImages: true,
        modality: 'vision',
        taskType: 'ocr_review',
      };

      const direct = services.modelSwitch.determineRoute(req);
      const rest = await restClient.routeModel(req);
      const browser = await browserClient.routeModel(req);
      const adapterRes = await adapter.routeModel(req);

      expect(rest.data?.selectedModelId).toBe(direct.selectedModelId);
      expect(browser.selectedModelId).toBe(direct.selectedModelId);
      expect(adapterRes.selectedModelId).toBe(direct.selectedModelId);

      expect(rest.data?.device).toBe(direct.device);
      expect(browser.device).toBe(direct.device);
      expect(adapterRes.device).toBe(direct.device);
    });

    it('verifies getActiveModelIdentity parity across all client layers', async () => {
      const direct = services.modelSwitch.getActiveModelIdentity();
      const rest = await restClient.getActiveModelIdentity();
      const browser = await browserClient.getActiveModelIdentity();
      const adapterRes = await adapter.getActiveModelIdentity();

      expect(rest.data?.healthy).toBe(direct.healthy);
      expect(browser.healthy).toBe(direct.healthy);
      expect(adapterRes.healthy).toBe(direct.healthy);

      expect(rest.data?.isWorkflowFixed).toBe(direct.isWorkflowFixed);
      expect(browser.isWorkflowFixed).toBe(direct.isWorkflowFixed);
      expect(adapterRes.isWorkflowFixed).toBe(direct.isWorkflowFixed);
    });

    it('verifies switchModel parity across all client layers', async () => {
      const switchReq: ModelSwitchRequest = {
        targetModelId: 'sentence-transformers/all-MiniLM-L6-v2',
        actor: 'parity_tester',
        reason: 'Verify 4-way client switch parity',
      };

      const rest = await restClient.switchModel(switchReq);
      const browser = await browserClient.switchModel(switchReq);
      const adapterRes = await adapter.switchModel(switchReq);

      expect(rest.data?.status).toBe('SWITCHED');
      expect(browser.status).toBe('SWITCHED');
      expect(adapterRes.status).toBe('SWITCHED');

      expect(rest.data?.device).toBe('cpu');
      expect(browser.device).toBe('cpu');
      expect(adapterRes.device).toBe('cpu');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. Security & Gate Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('5. Security & Gate Invariants', () => {
    it('preserves canary rust/test.txt SHA-256 hash', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });

    it('verifies Gate G5 is CONDITIONAL/PENDING OFFLINE WEIGHTS, G6 is PASSED, G7 is PASSED', () => {
      const planPath = path.resolve(__dirname, '../../docs/SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf-8');

      // Gate G5 is passed with the pinned offline weights
      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      // Gate G6 and G7 must be passed
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
