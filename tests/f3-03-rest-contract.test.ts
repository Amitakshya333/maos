/**
 * F3-03 — OpenAPI REST Contract Tests
 *
 * Verifies:
 *   - OpenAPI 3.1.0 spec publication (/api/v1/openapi.json)
 *   - All 10 required domain API areas over HTTP loopback
 *   - Standard error envelopes and correlation IDs
 *   - Idempotency key handling and conflict detection
 *   - Critical negative tests:
 *       * Undocumented routes (404)
 *       * Incompatible schemaVersion (400)
 *       * Malformed request bodies (400)
 *       * Oversized payloads > 1MB (413)
 *       * Path traversal (400)
 *       * Cross-project scope mismatch (400)
 *       * Unauthorized approval transition (400)
 *       * Non-loopback caller rejection (403)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';
import { createRestApiServer, RestApiServer } from '../src/api/server';
import { MaosRestClient } from '../src/api/client';
import { checkLoopback, sendError } from '../src/api/middleware';

describe('F3-03 OpenAPI REST Contract', () => {
  let testDir: string;
  let server: RestApiServer;
  let client: MaosRestClient;
  let port: number;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-rest-test-'));

    // Create minimal MAOS project layout
    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });


    const config = {
      projectName: 'test-rest-project',
      routingMode: 'auto',
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
        evidenceRoot: 'artifacts',
      },
      providers: {
        ollama: { baseURL: 'http://127.0.0.1:8000/v1', costPerMillionTokens: 0 },
      },
      agents: [
        {
          id: 'TEST_CODER',
          role: 'coder',
          provider: 'ollama',
          model: 'qwen2.5-3b-instruct-local',
          capabilities: ['coding'],
          scope: ['src/'],
        },
      ],
      routing: {
        strategy: 'capability_score',
        costWeight: 0.2,
        capabilityWeight: 0.8,
        maxParallelAgents: 2,
        fallbackProvider: 'ollama',
      },
    };

    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

    server = createRestApiServer(testDir);
    server.getServices().artifact.finalizeArtifact({
      id: 'sample_report',
      relativePath: 'artifacts/sample-report.md',
      content: '# Safety Report\nAll clear.',
      type: 'report',
      projectId: 'test-rest-project',
      runId: 'run_default',
    });

    // Register an explicit verified local fixture. Production model leases must
    // never succeed for dynamically invented or unverified model identities.
    const snapshotRelativePath = 'rest-contract-model';
    const snapshotPath = path.join(testDir, 'offline-stores', 'model-snapshot', snapshotRelativePath);
    fs.mkdirSync(snapshotPath, { recursive: true });
    const modelBytes = Buffer.from('verified-rest-contract-model');
    fs.writeFileSync(path.join(snapshotPath, 'model.bin'), modelBytes);
    const manifestPath = path.join(testDir, 'rest-contract-model-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      model: 'ollama/qwen2.5-3b-instruct-local',
      revision: 'test-revision',
      quantization: 'fp16',
      snapshotRelativePath,
      files: [{
        path: 'model.bin',
        size: modelBytes.length,
        sha256: crypto.createHash('sha256').update(modelBytes).digest('hex'),
      }],
    }, null, 2));
    server.getServices().modelManager.registerModel({
      modelId: 'ollama/qwen2.5-3b-instruct-local',
      modelName: 'rest-contract-model',
      revision: 'test-revision',
      architecture: 'TestOnlyModel',
      quantization: 'fp16',
      vramRequiredMb: 1,
      device: 'cpu',
      port: 8000,
      manifestPath,
      snapshotPath,
      isHealthy: true,
    });

    port = await server.start(0);

    client = new MaosRestClient({
      baseUrl: `http://127.0.0.1:${port}`,
      projectRoot: testDir,
    });
  });

  afterAll(async () => {
    await server.stop();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ── OpenAPI Specification ─────────────────────────────────────

  it('GET /api/v1/openapi.json: should return OpenAPI 3.1.0 specification', async () => {
    const res = await client.getOpenApiSpec();
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(res.data?.openapi).toBe('3.1.0');
    expect(res.data?.info).toHaveProperty('title', 'MAOS Industrial REST API');
    expect(res.data?.paths).toHaveProperty('/api/v1/tasks');
    expect(res.data?.components).toHaveProperty('schemas');
  });

  // ── Project, Settings, Sovereignty ────────────────────────────

  it('GET /api/v1/project: should return project configuration', async () => {
    const res = await client.getProject();
    expect(res.status).toBe(200);
    expect(res.data?.schemaVersion).toBe(1);
    expect(res.data?.projectName).toBe('test-rest-project');
    expect(res.data?.profile?.mode).toBe('sovereign-local');
  });

  it('GET & PATCH /api/v1/settings: should retrieve and update settings', async () => {
    const initial = await client.getSettings();
    expect(initial.status).toBe(200);
    expect(initial.data?.projectName).toBe('test-rest-project');

    const updated = await client.updateSettings({ customKey: 'customValue' });
    expect(updated.status).toBe(200);
    expect(updated.data?.customKey).toBe('customValue');
  });

  it('GET /api/v1/security/sovereignty: should return sovereignty status', async () => {
    const res = await client.getSovereigntyStatus();
    expect(res.status).toBe(200);
    expect(res.data?.zeroCloud).toBe(true);
    expect(res.data?.allLocalProviders).toBe(true);
    expect(res.data?.loopbackEnforced).toBe(true);
  });

  // ── Conversations & Messages ──────────────────────────────────

  it('Conversations API: should create, list, and append messages', async () => {
    const createRes = await client.createConversation({
      projectId: 'test-rest-project',
      agentId: 'TEST_CODER',
    });
    expect(createRes.status).toBe(201);
    const convId = createRes.data?.id;
    expect(convId).toBeTruthy();

    const listRes = await client.listConversations();
    expect(listRes.status).toBe(200);
    expect(listRes.data?.some((c) => c.id === convId)).toBe(true);

    const detailRes = await client.getConversation(convId!);
    expect(detailRes.status).toBe(200);
    expect(detailRes.data?.id).toBe(convId);

    const msgRes = await client.addMessage(convId!, {
      role: 'user',
      content: 'Hello agent',
    });
    expect(msgRes.status).toBe(201);
    expect(msgRes.data?.schemaVersion).toBe(1);
    expect(msgRes.data?.content).toBe('Hello agent');
  });

  // ── Tasks ─────────────────────────────────────────────────────

  it('Tasks API: should create, list, and get tasks', async () => {
    const createRes = await client.createTask({
      description: 'Implement secure login endpoint',
      agent: 'TEST_CODER',
      complexity: 'medium',
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.data?.id;
    expect(taskId).toBeTruthy();

    const listRes = await client.listTasks({ status: 'pending' });
    expect(listRes.status).toBe(200);
    expect(listRes.data?.some((t) => t.id === taskId)).toBe(true);

    const detailRes = await client.getTask(taskId!);
    expect(detailRes.status).toBe(200);
    expect(detailRes.data?.id).toBe(taskId);
    expect(detailRes.data?.schemaVersion).toBe(1);
  });

  // ── Workflows & Runs ──────────────────────────────────────────

  it('Workflows API: should create and retrieve workflow stage', async () => {
    const createRes = await client.createWorkflow({
      goal: 'Audit turbine bearing temperature',
      plannerAgentId: 'ARCHITECT',
    });
    expect(createRes.status).toBe(201);
    const wfId = createRes.data?.id;
    expect(wfId).toBeTruthy();

    const detailRes = await client.getWorkflow(wfId!);
    expect(detailRes.status).toBe(200);
    expect(detailRes.data?.id).toBe(wfId);
    expect(detailRes.data?.goal).toBe('Audit turbine bearing temperature');
  });

  it('Runs API: should list runs and get timeline', async () => {
    const listRes = await client.listRuns();
    expect(listRes.status).toBe(200);

    const timelineRes = await client.getRun('nonexistent_run');
    expect(timelineRes.status).toBe(200);
    expect(timelineRes.data).toEqual([]);
  });

  // ── Approvals ─────────────────────────────────────────────────

  it('Approvals API: should create approval and execute valid decision transition', async () => {
    const createRes = await client.createApproval({
      gateId: 'G3',
      conditions: ['All contract tests pass'],
    });
    expect(createRes.status).toBe(201);
    const apprId = createRes.data?.id;
    expect(apprId).toBeTruthy();
    expect(createRes.data?.status).toBe('pending');

    const detailRes = await client.getApproval(apprId!);
    expect(detailRes.status).toBe(200);
    expect(detailRes.data?.status).toBe('pending');

    const decideRes = await client.decideApproval(apprId!, 'approved', 'auditor');
    expect(decideRes.status).toBe(200);
    expect(decideRes.data?.status).toBe('approved');
    expect(decideRes.data?.approvedBy).toBe('auditor');
  });

  // ── Artifacts ─────────────────────────────────────────────────

  it('Artifacts API: should list artifacts and safely retrieve content', async () => {
    const listRes = await client.listArtifacts();
    expect(listRes.status).toBe(200);
    expect(listRes.data?.length).toBeGreaterThan(0);

    const sample = listRes.data?.find((a) => a.path.includes('sample-report.md'));
    expect(sample).toBeDefined();

    const contentRes = await client.getArtifactContent(sample!.id);
    expect(contentRes.status).toBe(200);
    expect(typeof contentRes.data).toBe('string');
    expect(contentRes.data).toContain('# Safety Report');
  });

  // ── Models & Leases ───────────────────────────────────────────

  it('Models API: should list models, acquire lease, and release lease', async () => {
    const modelsRes = await client.listModels();
    expect(modelsRes.status).toBe(200);
    expect(modelsRes.data?.length).toBeGreaterThan(0);

    const leaseRes = await client.acquireModelLease({
      modelId: 'ollama/qwen2.5-3b-instruct-local',
      agentId: 'TEST_CODER',
      port: 8000,
    });
    expect(leaseRes.status).toBe(201);
    const leaseId = leaseRes.data?.id;
    expect(leaseId).toBeTruthy();

    const activeLeases = await client.listModelLeases();
    expect(activeLeases.status).toBe(200);
    expect(activeLeases.data?.some((l) => l.id === leaseId)).toBe(true);

    const releaseRes = await client.releaseModelLease(leaseId!);
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.data?.released).toBe(true);
  });

  // ── Health & Diagnostics ──────────────────────────────────────

  it('Health & Diagnostics API: should return status and diagnostic checks', async () => {
    const healthRes = await client.getHealth();
    expect(healthRes.status).toBe(200);
    expect(healthRes.data?.status).toBe('HEALTHY');
    expect(healthRes.data?.agentPool).toBeInstanceOf(Array);

    const diagRes = await client.getDiagnostics();
    expect(diagRes.status).toBe(200);
    expect(diagRes.data?.length).toBeGreaterThan(0);
    expect(diagRes.data?.every((d) => d.passed)).toBe(true);
  });

  // ── Correlation ID & Idempotency Keys ─────────────────────────

  it('Correlation ID: should echo provided X-Correlation-ID in response', async () => {
    const customCorrelationId = 'corr_test_explicit_12345';
    const res = await client.rawRequest('GET', '/api/v1/project', undefined, {
      'X-Correlation-ID': customCorrelationId,
    });
    expect(res.status).toBe(200);
    expect(res.correlationId).toBe(customCorrelationId);
  });

  it('Idempotency: duplicate request with same key should return cached response', async () => {
    const idempotencyKey = 'idem_key_abc_123';
    const payload = { description: 'Idempotent task', agent: 'TEST_CODER' };

    const first = await client.createTask(payload, idempotencyKey);
    expect(first.status).toBe(201);
    expect(first.isReplay).toBe(false);

    const second = await client.createTask(payload, idempotencyKey);
    expect(second.status).toBe(201);
    expect(second.isReplay).toBe(true);
    expect(second.data?.id).toBe(first.data?.id);
  });

  // ── Critical Negative Tests ───────────────────────────────────

  it('Negative: Undocumented route should return 404 with error envelope', async () => {
    const res = await client.rawRequest('GET', '/api/v1/nonexistent/endpoint');
    expect(res.status).toBe(404);
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe('UNDOCUMENTED_ROUTE');
    expect(res.error?.correlationId).toBeTruthy();
  });

  it('Negative: Unknown or incompatible schemaVersion should return 400', async () => {
    const res = await client.createTask({
      schemaVersion: 99,
      description: 'Invalid version task',
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('INCOMPATIBLE_SCHEMA_VERSION');
  });

  it('Negative: Malformed request body should return 400', async () => {
    const res = await client.rawRequest('POST', '/api/v1/tasks', { description: 12345 });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('VALIDATION_FAILED');
  });

  it('Negative: Oversized request body > 1MB should return 413', async () => {
    const oversizedString = 'x'.repeat(1024 * 1024 + 1024);
    const res = await client.rawRequest('POST', '/api/v1/tasks', { description: oversizedString });
    expect(res.status).toBe(413);
    expect(res.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('Negative: Path traversal in artifact content should return 400', async () => {
    const res = await client.rawRequest('GET', '/api/v1/artifacts/..%2F..%2Fsecret.txt/content');
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('PATH_TRAVERSAL');
  });

  it('Negative: Cross-project scope mismatch in X-Project-Root should return 400', async () => {
    const foreignProjectRoot = path.join(os.tmpdir(), 'other-foreign-project');
    const res = await client.rawRequest('GET', '/api/v1/project', undefined, {
      'X-Project-Root': foreignProjectRoot,
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('PROJECT_SCOPE_MISMATCH');
  });

  it('Negative: Unauthorized approval transition should return 400', async () => {
    const createRes = await client.createApproval({ gateId: 'G1' });
    const apprId = createRes.data?.id;

    // First transition is valid
    const firstDecide = await client.decideApproval(apprId!, 'approved');
    expect(firstDecide.status).toBe(200);

    // Second transition is unauthorized
    const secondDecide = await client.decideApproval(apprId!, 'rejected');
    expect(secondDecide.status).toBe(400);
    expect(secondDecide.error?.code).toBe('UNAUTHORIZED_TRANSITION');
  });

  it('Negative: Idempotency conflict (same key, different body) should return 409', async () => {
    const conflictKey = 'idem_conflict_key_999';
    const first = await client.createTask({ description: 'Task 1' }, conflictKey);
    expect(first.status).toBe(201);

    // Same key with different payload
    const second = await client.createTask({ description: 'Completely different task' }, conflictKey);
    expect(second.status).toBe(409);
    expect(second.error?.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('Negative: Non-loopback caller simulation should return 403', () => {
    // Unit test middleware verification of non-loopback IP
    const fakeReq: any = {
      headers: {},
      socket: { remoteAddress: '192.168.1.100' },
    };
    let writtenStatus = 0;
    let writtenBody = '';
    const fakeRes: any = {
      writeHead: (status: number) => {
        writtenStatus = status;
      },
      end: (data: string) => {
        writtenBody = data;
      },
    };

    const allowed = checkLoopback(fakeReq, fakeRes, 'corr_test');
    expect(allowed).toBe(false);
    expect(writtenStatus).toBe(403);
    expect(writtenBody).toContain('FORBIDDEN_NON_LOOPBACK');
  });
});
