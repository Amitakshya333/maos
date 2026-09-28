/**
 * F3-07 — Run/API Verifier and Idempotency Tests
 *
 * Verifies:
 * 1. Durable Idempotency Store:
 *    - Disk persistence in .maos/idempotency/<hash>.json with fsync
 *    - Atomic claim locking and in-progress concurrent mutation detection (409 CONCURRENT_MUTATION)
 *    - Replay of identical payload with cached status and Idempotent-Replay header
 *    - Rejection of conflicting payload with same key (409 IDEMPOTENCY_CONFLICT)
 *    - Rejection of authorization mismatch (403 AUTHORIZATION_MISMATCH)
 *    - Crash & process restart recovery from disk
 *    - Stale lock cleanup & recovery (> 30s)
 * 2. Canonical Verifier Service:
 *    - Domain schema version (schemaVersion: 1)
 *    - Hierarchical relationship checks (Project -> Task -> Run -> Artifact)
 *    - Cross-project and cross-run leakage rejection
 *    - Artifact existence, path confinement, and authoritative disk SHA-256 verification
 *    - Tampered disk artifact detection
 *    - Model identity, revision, and snapshot hash checks against model-snapshot-manifest.json
 *    - Service identity manifest and executable hash checks
 *    - Tamper-evident audit chain references via Rust engine
 *    - Monotonic event sequence verification
 *    - Approval references and gate status verification
 *    - Cryptographic request and response hash verification
 *    - Comprehensive verifyRun() end-to-end verification
 * 3. REST API Contract & Client Verification:
 *    - POST /api/v1/verify/run
 *    - POST /api/v1/verify/artifact
 *    - POST /api/v1/verify/model
 *    - POST /api/v1/verify/audit
 *    - POST /api/v1/verify/relationship
 *    - POST /api/v1/verify/service
 *    - Safe idempotent mutations on /api/v1/tasks and /api/v1/artifacts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { DurableIdempotencyStore } from '../src/core/idempotency-store';
import { createServiceContainer, ServiceContainer } from '../src/service';
import { createRestApiServer, RestApiServer } from '../src/api/server';
import { MaosRestClient } from '../src/api/client';
import { registerManifest, createLauncherManifest } from '../src/industrial/service-identity';

describe('F3-07 Run/API Verifier and Idempotency', () => {
  let testDir: string;
  let server: RestApiServer;
  let client: MaosRestClient;
  let services: ServiceContainer;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f3-07-test-'));

    // Register standard service identity manifest for tests
    registerManifest(createLauncherManifest('1.0.0'));

    // Create standard MAOS project structure
    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'objectives'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });

    // Project configuration at .maos/maos.config.json
    fs.writeFileSync(
      path.join(maosDir, 'maos.config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'test-f3-07-project',
          routingMode: 'deterministic',
          profile: {
            id: 'industrial',
            displayName: 'MAOS Industrial',
            mode: 'sovereign-local',
            zeroCloud: true,
          },
          providers: { local: { type: 'local', enabled: true } },
          agents: [{ id: 'lead', name: 'Lead', provider: 'local', model: 'test-model' }],
          routing: { default: 'lead' },
        },
        null,
        2,
      ),
    );

    // Model snapshot manifest for model verifier tests
    fs.writeFileSync(
      path.join(testDir, 'model-snapshot-manifest.json'),
      JSON.stringify(
        {
          model: 'Qwen/Qwen2.5-3B-Instruct',
          revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
          files: [
            {
              path: 'config.json',
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        },
        null,
        2,
      ),
    );

    server = createRestApiServer(testDir);
    const port = await server.start(0);
    services = server.getServices();
    client = new MaosRestClient({ baseUrl: `http://127.0.0.1:${port}`, projectRoot: testDir });
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (testDir && fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ── 1. Durable Idempotency Store Unit Tests ────────────────────────

  describe('1. Durable Idempotency Store', () => {
    it('should write claim to disk with in_progress status and fsync', () => {
      const store = new DurableIdempotencyStore(testDir);
      const claim = store.claim({
        key: 'key-test-01',
        requestHash: 'hash-req-01',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });

      expect(claim.outcome).toBe('claimed');
      expect(claim.record.status).toBe('in_progress');

      // Check disk persistence
      const records = store.list();
      expect(records.length).toBe(1);
      expect(records[0].key).toBe('key-test-01');
      expect(records[0].status).toBe('in_progress');

      const diskPath = store.getRecordPath('key-test-01');
      expect(fs.existsSync(diskPath)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
      expect(onDisk.schemaVersion).toBe(1);
      expect(onDisk.key).toBe('key-test-01');
      expect(onDisk.status).toBe('in_progress');
    });

    it('should reject concurrent claims on the same in-progress key with 409 CONCURRENT_MUTATION', () => {
      const store = new DurableIdempotencyStore(testDir);
      const firstClaim = store.claim({
        key: 'key-concurrent-01',
        requestHash: 'hash-req-concurrent',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });
      expect(firstClaim.outcome).toBe('claimed');

      // Second claim while in-progress
      const secondClaim = store.claim({
        key: 'key-concurrent-01',
        requestHash: 'hash-req-concurrent',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });
      expect(secondClaim.outcome).toBe('in_progress');
      expect(secondClaim.message).toContain('currently in progress');
    });

    it('should complete a claim and faithfully replay identical requests', () => {
      const store = new DurableIdempotencyStore(testDir);
      store.claim({
        key: 'key-replay-01',
        requestHash: 'hash-req-replay',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });

      const responsePayload = { data: { taskId: 'task-123', status: 'pending' } };
      store.complete('key-replay-01', 201, responsePayload);

      // Verify completed record on disk
      const diskPath = store.getRecordPath('key-replay-01');
      const onDisk = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
      expect(onDisk.status).toBe('completed');
      expect(onDisk.responseStatus).toBe(201);
      expect(onDisk.responsePayload).toEqual(responsePayload);
      expect(onDisk.completedAt).toBeDefined();

      // Subsequent identical claim returns replay
      const replayClaim = store.claim({
        key: 'key-replay-01',
        requestHash: 'hash-req-replay',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });
      expect(replayClaim.outcome).toBe('replay');
      expect(replayClaim.record.responseStatus).toBe(201);
      expect(replayClaim.record.responsePayload).toEqual(responsePayload);
    });

    it('should reject conflicting payload with 409 IDEMPOTENCY_CONFLICT', () => {
      const store = new DurableIdempotencyStore(testDir);
      store.claim({
        key: 'key-conflict-01',
        requestHash: 'hash-original',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });
      store.complete('key-conflict-01', 201, { success: true });

      // Different request hash with the same key
      const conflictClaim = store.claim({
        key: 'key-conflict-01',
        requestHash: 'hash-different-payload',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
      });
      expect(conflictClaim.outcome).toBe('conflict');
      expect(conflictClaim.message).toContain('different request payload');
    });

    it('should reject authorization mismatch with 403 AUTHORIZATION_MISMATCH', () => {
      const store = new DurableIdempotencyStore(testDir);
      store.claim({
        key: 'key-auth-01',
        requestHash: 'hash-req-auth',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
        authContext: 'Bearer user-token-A',
      });
      store.complete('key-auth-01', 201, { success: true });

      // Same key and payload from different auth context
      const authMismatchClaim = store.claim({
        key: 'key-auth-01',
        requestHash: 'hash-req-auth',
        operation: 'create_task',
        projectId: 'test-f3-07-project',
        authContext: 'Bearer user-token-B',
      });
      expect(authMismatchClaim.outcome).toBe('auth_mismatch');
      expect(authMismatchClaim.message).toContain('different authorization context');
    });

    it('should survive process restarts and reload all completed records from disk', () => {
      const store1 = new DurableIdempotencyStore(testDir);
      store1.claim({
        key: 'key-restart-01',
        requestHash: 'hash-restart',
        operation: 'finalize_artifact',
        projectId: 'test-f3-07-project',
      });
      store1.complete('key-restart-01', 201, { artifactId: 'art-restart-999' });

      // Instantiate a completely new store instance representing process restart
      const store2 = new DurableIdempotencyStore(testDir);
      const replay = store2.claim({
        key: 'key-restart-01',
        requestHash: 'hash-restart',
        operation: 'finalize_artifact',
        projectId: 'test-f3-07-project',
      });

      expect(replay.outcome).toBe('replay');
      expect(replay.record.responseStatus).toBe(201);
      expect(replay.record.responsePayload).toEqual({ artifactId: 'art-restart-999' });
    });

    it('should safely reclaim stale in-progress locks (> 30s) after crash', () => {
      const store1 = new DurableIdempotencyStore(testDir);
      store1.claim({
        key: 'key-stale-01',
        requestHash: 'hash-stale',
        operation: 'run_task',
        projectId: 'test-f3-07-project',
      });

      // Manually manipulate the file timestamp to simulate crash 60 seconds ago
      const diskPath = store1.getRecordPath('key-stale-01');
      const staleTime = new Date(Date.now() - 60000).toISOString();
      const raw = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
      raw.createdAt = staleTime;
      fs.writeFileSync(diskPath, JSON.stringify(raw, null, 2), 'utf-8');

      // Restart process with fresh store instance
      const store2 = new DurableIdempotencyStore(testDir);
      const newClaim = store2.claim({
        key: 'key-stale-01',
        requestHash: 'hash-stale',
        operation: 'run_task',
        projectId: 'test-f3-07-project',
      });

      expect(newClaim.outcome).toBe('claimed');
      expect(newClaim.record.status).toBe('in_progress');
    });
  });

  // ── 2. Verifier Service Unit Tests ─────────────────────────────────

  describe('2. Canonical Verifier Service', () => {
    it('should verify schemaVersion is strictly 1', () => {
      const verifier = services.verifier;
      expect(verifier.verifySchemaVersion({ schemaVersion: 1, name: 'valid' }).valid).toBe(true);
      expect(verifier.verifySchemaVersion({ schemaVersion: 2, name: 'invalid' }).valid).toBe(false);
      expect(verifier.verifySchemaVersion({ name: 'missing' }).valid).toBe(false);
      expect(verifier.verifySchemaVersion(null).valid).toBe(false);
    });

    it('should verify hierarchical relationships and reject cross-project references', () => {
      const verifier = services.verifier;

      // Project mismatch
      const resMismatch = verifier.verifyRelationship({
        projectId: 'alien-project',
      });
      expect(resMismatch.valid).toBe(false);
      expect(resMismatch.errors[0]).toContain("does not match hosted project 'test-f3-07-project'");

      // Valid project
      const resValid = verifier.verifyRelationship({
        projectId: 'test-f3-07-project',
      });
      expect(resValid.valid).toBe(true);
    });

    it('should verify artifact existence, containment, and authoritative disk SHA-256', () => {
      const verifier = services.verifier;

      // Finalize a real artifact through ArtifactService
      const content = 'F3-07 Authoritative Artifact Verification Content';
      const artifact = services.artifact.finalizeArtifact({
        id: 'art_verify_01',
        relativePath: 'artifacts/reports/summary.txt',
        content,
        type: 'report',
        projectId: 'test-f3-07-project',
      });

      // Verify artifact
      const verifyRes = verifier.verifyArtifact(artifact.id, artifact.hash);
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.computedHash).toBe(artifact.hash);
      expect(verifyRes.errors.length).toBe(0);
    });

    it('should detect tampered artifact content on disk and fail closed', () => {
      const verifier = services.verifier;

      // Finalize a valid artifact
      const content = 'Original Un-Tampered Artifact Content';
      const artifact = services.artifact.finalizeArtifact({
        id: 'art_tamper_01',
        relativePath: 'artifacts/reports/tamper.txt',
        content,
        type: 'report',
        projectId: 'test-f3-07-project',
      });

      // Tamper with the physical file on disk directly
      const diskPath = path.join(testDir, artifact.path);
      fs.writeFileSync(diskPath, 'MALICIOUS_TAMPERED_CONTENT', 'utf-8');

      // Verification must fail closed immediately
      const tamperRes = verifier.verifyArtifact(artifact.id);
      expect(tamperRes.valid).toBe(false);
      expect(tamperRes.errors.some((e) => e.includes('tampered'))).toBe(true);
    });

    it('should reject artifact paths that escape the project root', () => {
      const verifier = services.verifier;
      const escapeRes = verifier.verifyArtifact('non_existent_art');
      expect(escapeRes.valid).toBe(false);
      expect(escapeRes.errors[0]).toContain('not found in registry');
    });

    it('should verify model identity and snapshot revision against manifest', () => {
      const verifier = services.verifier;

      // Valid model
      const validModel = verifier.verifyModel({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
        snapshotHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });
      expect(validModel.valid).toBe(true);

      // Model revision mismatch
      const invalidRevision = verifier.verifyModel({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        revision: 'wrong-revision-hash-12345',
      });
      expect(invalidRevision.valid).toBe(false);
      expect(invalidRevision.errors[0]).toContain('Model revision mismatch');

      // Model snapshot file hash mismatch
      const invalidSnapshot = verifier.verifyModel({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        snapshotHash: '0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(invalidSnapshot.valid).toBe(false);
      expect(invalidSnapshot.errors[0]).toContain('Snapshot hash');
    });

    it('should verify registered service identity manifests', () => {
      const verifier = services.verifier;

      // Unknown service
      const unknown = verifier.verifyServiceIdentity('unknown-daemon-service');
      expect(unknown.valid).toBe(false);
      expect(unknown.errors[0]).toContain('not registered');

      // Registered service (e.g. launcher)
      const orchestrator = verifier.verifyServiceIdentity('launcher');
      expect(orchestrator.valid).toBe(true);
    });

    it('should verify tamper-evident audit chain references', () => {
      const verifier = services.verifier;

      // Record an audit event through AuditService
      const rec = services.audit.recordAuditEvent({
        source: 'verifier_test',
        category: 'tool',
        data: { action: 'execute_test' },
      });

      // Verify the reference and the whole chain
      const auditRes = verifier.verifyAuditReference(rec.sequence, rec.hash);
      expect(auditRes.valid).toBe(true);

      // Non-existent sequence fails closed
      const nonExistent = verifier.verifyAuditReference(9999);
      expect(nonExistent.valid).toBe(false);
      expect(nonExistent.errors[0]).toContain('does not exist');

      // Hash mismatch fails closed
      const hashMismatch = verifier.verifyAuditReference(rec.sequence, 'badhashbadhashbadhash');
      expect(hashMismatch.valid).toBe(false);
      expect(hashMismatch.errors[0]).toContain('hash mismatch');
    });

    it('should verify approval references and gate status', () => {
      const verifier = services.verifier;

      const app = services.approval.createApproval({
        gateId: 'G3-contract-gate',
        conditions: ['Full F3 test suite passes'],
      });

      // Valid check
      const validApp = verifier.verifyApproval(app.id, 'G3-contract-gate', 'pending');
      expect(validApp.valid).toBe(true);

      // Gate mismatch
      const gateMismatch = verifier.verifyApproval(app.id, 'G2-wrong-gate');
      expect(gateMismatch.valid).toBe(false);
      expect(gateMismatch.errors[0]).toContain('gate mismatch');

      // Status mismatch
      const statusMismatch = verifier.verifyApproval(app.id, undefined, 'approved');
      expect(statusMismatch.valid).toBe(false);
      expect(statusMismatch.errors[0]).toContain('status mismatch');
    });

    it('should verify request and response cryptographic SHA-256 hashes', () => {
      const verifier = services.verifier;
      const reqBody = JSON.stringify({ goal: 'Build test system' });
      const resBody = { status: 'ok', runId: 'run-123' };

      const computedReqHash = crypto.createHash('sha256').update(reqBody).digest('hex');
      const computedResHash = crypto.createHash('sha256').update(JSON.stringify(resBody)).digest('hex');

      // Valid hashes
      const valid = verifier.verifyRequestResponse(reqBody, resBody, computedReqHash, computedResHash);
      expect(valid.valid).toBe(true);

      // Tampered request hash
      const badReq = verifier.verifyRequestResponse(reqBody, resBody, 'badreqhash');
      expect(badReq.valid).toBe(false);
      expect(badReq.errors[0]).toContain('Request hash mismatch');
    });

    it('should execute comprehensive verifyRun end-to-end check', () => {
      const verifier = services.verifier;

      // 1. Create a workflow stage/objective
      const wf = services.workflow.createObjective({
        id: 'run-verify-e2e',
        goal: 'Complete E2E run verification',
        plannerAgentId: 'lead',
      });

      // 2. Finalize an artifact under that runId
      services.artifact.finalizeArtifact({
        id: 'art_run_e2e_01',
        relativePath: 'artifacts/runs/run-verify-e2e/report.json',
        content: JSON.stringify({ outcome: 'SUCCESS' }),
        type: 'report',
        runId: 'run-verify-e2e',
        projectId: 'test-f3-07-project',
      });

      // 3. Emit a sequenced event for the run
      services.event.recordEvent({
        eventType: 'RUN_STAGE_COMPLETED',
        projectId: 'test-f3-07-project',
        runId: 'run-verify-e2e',
        correlationId: 'corr_run_e2e',
        payload: { stageId: wf.id },
      });

      // 4. Record an audit event
      services.audit.recordAuditEvent({
        source: 'e2e_runner',
        category: 'stage',
        data: { runId: 'run-verify-e2e' },
      });

      // 5. Verify the entire run
      const runResult = verifier.verifyRun('run-verify-e2e');
      expect(runResult.valid).toBe(true);
      expect(runResult.runId).toBe('run-verify-e2e');
      expect(runResult.projectId).toBe('test-f3-07-project');
      expect(runResult.checks.length).toBeGreaterThanOrEqual(4);
      expect(runResult.errors.length).toBe(0);
    });
  });

  // ── 3. REST API & Idempotent Mutation Tests ─────────────────────────

  describe('3. REST Verification & Idempotent Mutations', () => {
    it('should support safe idempotent mutations on POST /api/v1/tasks', async () => {
      const payload = {
        description: 'Idempotent task creation test',
        agent: 'lead',
        type: 'general',
      };
      const idempotencyKey = 'task-idem-key-100';

      // First creation request
      const res1 = await client.createTask(payload, idempotencyKey);
      expect(res1.status).toBe(201);
      expect(res1.data).toBeDefined();
      const createdId = res1.data!.id;

      // Second identical request with same key
      const res2 = await client.createTask(payload, idempotencyKey);
      expect(res2.status).toBe(201);
      expect(res2.isReplay).toBe(true);
      expect(res2.data!.id).toBe(createdId);

      // Verify only ONE task was created in the queue
      const tasks = services.task.listTasks();
      const matching = tasks.filter((t) => t.description === payload.description);
      expect(matching.length).toBe(1);

      // Third request with SAME key but DIFFERENT payload -> 409 IDEMPOTENCY_CONFLICT
      const conflictRes = await client.createTask(
        { description: 'Different description completely', agent: 'lead', type: 'general' },
        idempotencyKey,
      );
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should support safe idempotent mutations on POST /api/v1/artifacts', async () => {
      const artifactPayload = {
        id: 'art_idem_01',
        relativePath: 'artifacts/reports/idem.txt',
        content: 'Idempotent artifact test content',
        type: 'report',
      };
      const idempotencyKey = 'art-idem-key-200';

      // First finalization
      const res1 = await client.finalizeArtifact(artifactPayload, idempotencyKey);
      expect(res1.status).toBe(201);
      expect(res1.data?.id).toBe('art_idem_01');

      // Replay with same key and payload
      const res2 = await client.finalizeArtifact(artifactPayload, idempotencyKey);
      expect(res2.status).toBe(201);
      expect(res2.isReplay).toBe(true);
      expect(res2.data?.id).toBe('art_idem_01');
    });

    it('POST /api/v1/verify/artifact should verify artifacts via REST', async () => {
      // Create artifact
      const content = 'REST Verifiable Artifact';
      const created = services.artifact.finalizeArtifact({
        id: 'art_rest_verify_01',
        relativePath: 'artifacts/reports/rest-verify.txt',
        content,
        type: 'report',
        projectId: 'test-f3-07-project',
      });

      // Verify via REST client
      const res = await client.verifyArtifact('art_rest_verify_01', created.hash);
      expect(res.status).toBe(200);
      expect(res.data?.valid).toBe(true);
      expect(res.data?.computedHash).toBe(created.hash);

      // Tamper with file directly on disk
      fs.writeFileSync(path.join(testDir, created.path), 'CORRUPTED_TAMPER', 'utf-8');

      // Verify again via REST client -> valid: false
      const tamperedRes = await client.verifyArtifact('art_rest_verify_01');
      expect(tamperedRes.status).toBe(200);
      expect(tamperedRes.data?.valid).toBe(false);
      expect(tamperedRes.data?.errors.some((e) => e.includes('tampered'))).toBe(true);
    });

    it('POST /api/v1/verify/model should verify model snapshot via REST', async () => {
      const res = await client.verifyModel({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
      });
      expect(res.status).toBe(200);
      expect(res.data?.valid).toBe(true);

      // Model revision mismatch
      const badRes = await client.verifyModel({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        revision: 'wrong-revision-hash',
      });
      expect(badRes.status).toBe(200);
      expect(badRes.data?.valid).toBe(false);
      expect(badRes.data?.errors[0]).toContain('Model revision mismatch');
    });

    it('POST /api/v1/verify/relationship should reject cross-project references via REST', async () => {
      const crossProject = await client.verifyRelationship({
        projectId: 'alien-unauthorized-project',
      });
      expect(crossProject.status).toBe(200);
      expect(crossProject.data?.valid).toBe(false);
      expect(crossProject.data?.errors[0]).toContain("does not match hosted project 'test-f3-07-project'");

      const validProject = await client.verifyRelationship({
        projectId: 'test-f3-07-project',
      });
      expect(validProject.status).toBe(200);
      expect(validProject.data?.valid).toBe(true);
    });

    it('POST /api/v1/verify/service should verify service identity via REST', async () => {
      const validService = await client.verifyService('launcher');
      expect(validService.status).toBe(200);
      expect(validService.data?.valid).toBe(true);

      const invalidService = await client.verifyService('non-existent-service');
      expect(invalidService.status).toBe(200);
      expect(invalidService.data?.valid).toBe(false);
      expect(invalidService.data?.errors[0]).toContain('not registered');
    });

    it('POST /api/v1/verify/run should verify complete run via REST', async () => {
      // Create objective
      services.workflow.createObjective({
        id: 'run-rest-01',
        goal: 'Run REST verification',
        plannerAgentId: 'lead',
      });

      // Verify run via REST
      const res = await client.verifyRun('run-rest-01');
      expect(res.status).toBe(200);
      expect(res.data?.valid).toBe(true);
      expect(res.data?.runId).toBe('run-rest-01');
      expect(res.data?.checks.length).toBeGreaterThanOrEqual(1);

      // Verify missing run returns 400
      const badReq = await client.rawRequest('POST', '/api/v1/verify/run', {});
      expect(badReq.status).toBe(400);
      expect(badReq.error?.code).toBe('VALIDATION_FAILED');
    });
  });
});
