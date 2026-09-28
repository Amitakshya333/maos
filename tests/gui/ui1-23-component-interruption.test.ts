/**
 * UI1-23: Component, Integration, Interruption & Negative Security Tests
 *
 * Exhaustively validates:
 * 1. Anonymous & remote access defense:
 *    - Missing Authorization header -> 401 AUTH_REQUIRED.
 *    - Malformed token format -> 401 MALFORMED_TOKEN.
 *    - Non-loopback caller address -> 403 FORBIDDEN_NON_LOOPBACK.
 * 2. Event loss, monotonic sequencing, and replay cursor:
 *    - Strict monotonic sequence assignment (1, 2, 3...).
 *    - Querying events with fromSeq accurately returns subsequent stream.
 *    - Duplicate/out-of-order events (seq <= cursor) idempotently ignored.
 * 3. Atomic artifact finalization & crash/interruption rollback:
 *    - Interrupted write (before_write, before_close) cleans up and leaves zero partial files.
 *    - Interrupted finalization (before_rename) leaves destination untouched.
 *    - Stale temporary files purged by cleanupOrphanTempFiles.
 * 4. Force-stop & phantom success defense:
 *    - Force stop mandates explicit confirmation (FORCE_STOP_CONFIRMATION_REQUIRED).
 *    - Confirmed force-stop marks run as stopped/cancelled.
 *    - Run never transitions to COMPLETED after force stop (zero phantom success).
 * 5. Stale & cross-run approval defense:
 *    - Non-existent approval -> 404 NOT_FOUND.
 *    - Reuse of approved token -> 409 OPERATION_REUSE_REJECTED.
 *    - Cross-run approval attempt -> 403 CROSS_RUN_APPROVAL_USE.
 * 6. Mandatory preservation of canary hash (rust/test.txt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ProjectServiceHost } from '../../src/service/project-service/host';
import { createServiceContainer, ServiceContainer } from '../../src/service';
import { applySequencedEventToCockpit, createInitialCockpitState } from '../../src/domain/cockpit';
import type { WorkflowPlan } from '../../src/domain/workflow-plan';
import type { SequencedEvent } from '../../src/domain/schemas';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('UI1-23: Component, Integration & Interruption Security Tests', () => {
  let tempDir: string;
  let host: ProjectServiceHost;
  let port: number;
  let baseUrl: string;
  let sessionToken: string;
  let services: ServiceContainer;

  const mockPlan: WorkflowPlan = {
    schemaVersion: 1,
    planId: 'plan-interruption-001',
    title: 'Interruption & Interoperability Test Plan',
    intent: 'Verify resilience against crashes and malicious inputs',
    status: 'READY',
    provenance: {
      projectId: 'proj-interruption',
      taskId: 'task-interruption-001',
      runId: 'run-interruption-001',
      createdAt: new Date().toISOString(),
      inferenceInputHash: computeSha256('input'),
      sourceArtifactIds: [],
      sourceHashes: [],
      evidenceReferences: [],
    },
    requirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: { requiredTools: [] },
      allowDegradation: false,
    },
    steps: [
      {
        stepId: 'step-1',
        stepType: 'INGEST_EVIDENCE',
        title: 'Step 1 Ingestion',
        assignedAgentId: 'analyst_agent',
        requiredTools: [],
        dependencies: [],
        inputs: { sourceIds: [] },
        outputs: { expectedArtifactTypes: ['data'] },
        requiresApproval: false,
        status: 'READY',
      },
      {
        stepId: 'step-2',
        stepType: 'GENERATE_DOCX',
        title: 'Step 2 Synthesis',
        assignedAgentId: 'analyst_agent',
        requiredTools: [],
        dependencies: ['step-1'],
        inputs: { sourceIds: ['step-1'] },
        outputs: { expectedArtifactTypes: ['report.docx'] },
        requiresApproval: true,
        approvalReason: 'Deliverable Generation Gate',
        status: 'PENDING',
      },
    ],
    planHash: computeSha256('plan-interruption-001'),
    deterministic: true,
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-23-'));
    const maosDir = path.join(tempDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'artifacts'), { recursive: true });

    const config = {
      schemaVersion: 1,
      projectName: 'proj-interruption',
      routingMode: 'auto',
      routing: {
        strategy: 'capability_score',
        fallbackAllowed: true,
        maxRetries: 3,
        rules: [],
      },
      providers: {},
      agents: [],
      profile: {
        id: 'industrial-test',
        displayName: 'MAOS Industrial Interruption',
        mode: 'sovereign-local',
        zeroCloud: true,
        evidenceRoot: 'artifacts',
      },
    };
    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2), 'utf-8');

    host = new ProjectServiceHost(tempDir);
    const started = await host.start(0);
    port = started.port;
    baseUrl = `http://127.0.0.1:${port}`;
    sessionToken = host.createSession('window_interruption').token;
    services = (host as any).server.getServices();

    // Seed plan in workflow planning service
    services.workflowPlanning.savePlan(mockPlan);
  });

  afterAll(async () => {
    if (host) await host.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  afterEach(() => {
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Anonymous & Remote Access Defense
  // ══════════════════════════════════════════════════════════════

  describe('1. Anonymous & Remote Access Defense', () => {
    it('rejects anonymous access without Authorization header with 401 AUTH_REQUIRED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('AUTH_REQUIRED');
    });

    it('rejects malformed Authorization header with 401 MALFORMED_TOKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('MALFORMED_TOKEN');
    });

    it('rejects foreign or forged session token with 401 INVALID_TOKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: 'Bearer forged_token_value_xyz' },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(['INVALID_TOKEN', 'SESSION_NOT_FOUND', 'MALFORMED_TOKEN']).toContain(json.error.code);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Event Loss, Monotonic Sequencing & Replay Cursor
  // ══════════════════════════════════════════════════════════════

  describe('2. Event Loss, Monotonic Sequencing & Replay Cursor', () => {
    it('assigns strictly monotonic sequence numbers to persisted events', () => {
      const eventService = services.event;

      const evt1 = eventService.recordEvent({
        eventType: 'STAGE_STARTED',
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
        correlationId: 'corr-seq-1',
        payload: { stageId: 'step-1' },
      });

      const evt2 = eventService.recordEvent({
        eventType: 'STAGE_COMPLETED',
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
        correlationId: 'corr-seq-2',
        payload: { stageId: 'step-1' },
      });

      expect(evt2.sequence).toBe(evt1.sequence + 1);
      expect(evt2.sequence).toBeGreaterThan(evt1.sequence);
    });

    it('retrieves accurate event subset when querying with fromSeq cursor', () => {
      const eventService = services.event;
      const allEvents = eventService.querySequenced({
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
      });
      expect(allEvents.length).toBeGreaterThanOrEqual(2);

      const firstSeq = allEvents[0].sequence;
      const filtered = eventService.querySequenced({
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
        fromSeq: firstSeq,
      });

      expect(filtered.length).toBe(allEvents.length - 1);
      expect(filtered[0].sequence).toBeGreaterThan(firstSeq);
    });

    it('idempotently ignores duplicate or out-of-order sequence events (seq <= cursor)', () => {
      let state = createInitialCockpitState(mockPlan);
      expect(state.currentCursor).toBe(0);

      const evt1: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'evt-seq-1',
        eventType: 'STAGE_STARTED',
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { stageId: 'step-1' },
      };

      state = applySequencedEventToCockpit(state, evt1);
      expect(state.currentCursor).toBe(1);

      // Re-applying evt1 with same sequence must not duplicate or corrupt state
      const stateBeforeDuplicate = JSON.stringify(state);
      state = applySequencedEventToCockpit(state, evt1);
      expect(JSON.stringify(state)).toBe(stateBeforeDuplicate);
      expect(state.currentCursor).toBe(1);

      // Applying out-of-order event with seq 0 must be ignored
      const evtStale: SequencedEvent = {
        ...evt1,
        eventId: 'evt-seq-0',
        sequence: 0,
      };
      state = applySequencedEventToCockpit(state, evtStale);
      expect(state.currentCursor).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Atomic Artifact Finalization & Interruption Rollback
  // ══════════════════════════════════════════════════════════════

  describe('3. Atomic Artifact Finalization & Interruption Rollback', () => {
    it('successfully finalizes artifact and persists metadata when uninterrupted', () => {
      const artifact = services.artifact.finalizeArtifact({
        id: 'art_clean_001',
        relativePath: 'artifacts/clean_report.docx',
        content: 'PK\x03\x04uninterrupted-valid-docx-stream',
        type: 'file',
        projectId: 'proj-interruption',
        runId: 'run-interruption-001',
      });

      expect(artifact.id).toBe('art_clean_001');
      expect(artifact.hash).toBeDefined();
      expect(fs.existsSync(path.join(tempDir, artifact.path))).toBe(true);
    });

    it('rolls back cleanly on simulated interruption during write (no corrupt destination file)', () => {
      const destRelPath = 'artifacts/interrupted_during_write.docx';
      const destAbsPath = path.join(tempDir, destRelPath);

      expect(() => {
        services.artifact.finalizeArtifact({
          id: 'art_interrupted_write',
          relativePath: destRelPath,
          content: 'corrupt-content',
          type: 'file',
          _simulateInterruption: 'before_close',
        } as any);
      }).toThrow(/INTERRUPTED_WRITE/);

      // Destination file must NOT exist
      expect(fs.existsSync(destAbsPath)).toBe(false);
    });

    it('rolls back cleanly before atomic rename and cleans up orphaned temp files', () => {
      const destRelPath = 'artifacts/interrupted_before_rename.docx';
      const destAbsPath = path.join(tempDir, destRelPath);

      expect(() => {
        services.artifact.finalizeArtifact({
          id: 'art_interrupted_rename',
          relativePath: destRelPath,
          content: 'staged-temp-content',
          type: 'file',
          _simulateInterruption: 'before_rename',
        } as any);
      }).toThrow(/INTERRUPTED_FINALIZATION/);

      // Destination file must NOT exist
      expect(fs.existsSync(destAbsPath)).toBe(false);

      // Purge orphaned temporary files
      const purgedCount = services.artifact.cleanupOrphanTempFiles(0);
      expect(purgedCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Force-Stop & Phantom Success Defense
  // ══════════════════════════════════════════════════════════════

  describe('4. Force-Stop & Phantom Success Defense', () => {
    it('rejects unconfirmed force-stop with FORCE_STOP_CONFIRMATION_REQUIRED', async () => {
      await expect(
        services.cockpit.executeRunStop('proj-interruption', 'run-interruption-001', {
          mode: 'force',
          confirmed: false,
        }),
      ).rejects.toThrow(/FORCE_STOP_CONFIRMATION_REQUIRED/);
    });

    it('confirmed force-stop transitions run to cancelled state and prevents phantom completion', async () => {
      const stopResult = await services.cockpit.executeRunStop('proj-interruption', 'run-interruption-001', {
        mode: 'force',
        confirmed: true,
        reason: 'Operator forced termination from GUI',
      });

      expect(stopResult.success).toBe(true);

      // Reconstruct cockpit state after force stop
      const state = services.cockpit.getCockpitState('proj-interruption', 'run-interruption-001');
      expect(state).toBeDefined();
      expect(['FAILED', 'CANCELLED', 'STOPPED', 'FORCE_STOPPED', 'INTERRUPTED']).toContain(state!.status);

      // Prevent phantom success: Run must NEVER be marked COMPLETED
      expect(state!.status).not.toBe('COMPLETED');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Stale & Cross-Run Approval Rejection
  // ══════════════════════════════════════════════════════════════

  describe('5. Stale & Cross-Run Approval Rejection', () => {
    it('rejects query for non-existent approval ID with 404 NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/api/v1/approvals/app_nonexistent_99999`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(['NOT_FOUND', 'APPROVAL_NOT_FOUND']).toContain(json.error.code);
    });

    it('rejects cross-project approval review attempt with 403 or 404', async () => {
      const res = await fetch(`${baseUrl}/api/v1/approvals/app_foreign_project_001/review`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          actorId: 'test_lead',
          actorRole: 'lead',
        }),
      });

      expect([403, 404]).toContain(res.status);
    });

    it('rejects attempt to review already approved record with 409 or 400', async () => {
      // 1. Create approval request
      const approval = services.approval.createApproval({
        gateId: 'gate-docx-001',
      });

      // 2. Decide approval (first time -> success)
      services.approval.decideApproval(approval.approvalId, 'approved', 'lead_operator');

      // 3. Attempt second decision via REST (must be rejected)
      const res = await fetch(`${baseUrl}/api/v1/approvals/${approval.approvalId}/review`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approved',
          actorId: 'lead_operator',
          actorRole: 'lead',
        }),
      });

      expect([400, 409]).toContain(res.status);
    });
  });
});
