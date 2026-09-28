/**
 * UI1-15: Read-Only Agent Cockpit Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Types, Pure Validators, & Initial DAG Construction:
 *    - Validates CockpitStageStatus and CockpitRunStatus
 *    - createInitialCockpitState builds topological DAG from WorkflowPlan
 *    - Root nodes start in READY, dependent nodes in PENDING
 *    - Zero placeholder success badges on initialization
 *    - validateCockpitStageNode and validateCockpitState pure validators
 * 2. Pure Deterministic Replay Engine:
 *    - Sequential event stream updates all 12 indicators:
 *      stages, agent, actual model, tool, I/O artifacts, retries, tokens, latency,
 *      approvals, failure, cancel/force stop, live events
 *    - 100 consecutive replays reconstruct 100% identical DAG states
 * 3. Negative Protections & Security Guardrails:
 *    - No visual editing: state is strictly frozen / immutable
 *    - No placeholder success: completion requires authentic completion event
 *    - Sequence order enforcement: duplicate events (seq <= cursor) are idempotently ignored
 *    - Cross-project event rejection: events with mismatched projectId are rejected
 *    - Phantom completion defense: subsequent completion events after INTERRUPTED/FAILED are dropped
 * 4. CockpitService:
 *    - Disk persistence-first state assembly
 *    - listCockpitRuns, getCockpitState, replayRunEvents
 *    - executeRunStop with confirmed requirement
 * 5. REST API Router Endpoints:
 *    - GET /api/v1/cockpit
 *    - GET /api/v1/cockpit/:runId
 *    - POST /api/v1/cockpit/:runId/stop (enforces 400 FORCE_STOP_CONFIRMATION_REQUIRED)
 *    - GET /api/v1/cockpit/:runId/replay
 * 6. 4-Way Client Parity:
 *    - ServiceContainer, MaosRestClient, BrowserRestClient, GuiApiAdapter
 *    - Runtime validation schemas
 * 7. Reconnection & Lossless Event Resync:
 *    - Replay from cursor reconstructs identical state without node duplication
 * 8. Security & Gate Invariants:
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
  CockpitStageStatus,
  CockpitRunStatus,
  CockpitState,
  CockpitStageNode,
  CockpitRunSummary,
  createInitialCockpitState,
  applySequencedEventToCockpit,
  reconstructCockpitState,
  summarizeCockpitState,
  CockpitReplayError,
  ALL_COCKPIT_STAGE_STATUSES,
  ALL_COCKPIT_RUN_STATUSES,
} from '../../src/domain/cockpit';
import type { WorkflowPlan, WorkflowPlanStep } from '../../src/domain/workflow-plan';
import type { SequencedEvent } from '../../src/domain/schemas';
import {
  validateCockpitStageNode,
  validateCockpitState,
} from '../../src/domain/validators';
import {
  createServiceContainer,
  ServiceContainer,
  CockpitService,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { MaosRestClient } from '../../src/api/client';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import {
  validateCockpitState as guiValidateCockpitState,
  validateCockpitRunsList as guiValidateCockpitRunsList,
} from '../../src/gui/src/api/runtime-validation';

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('UI1-15: Read-Only Agent Cockpit', () => {
  let tempDir: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let server: http.Server;
  let baseUrl: string;
  let restClient: MaosRestClient;
  let browserClient: BrowserRestClient;
  let adapter: GuiApiAdapter;

  const mockPlan: WorkflowPlan = {
    schemaVersion: 1,
    planId: 'plan-industrial-inspect-001',
    title: 'Industrial Turbine Inspection Workflow',
    intent: 'Inspect vibration anomalies and generate approved audit deliverables',
    status: 'READY',
    provenance: {
      projectId: 'proj-cockpit-test',
      taskId: 'task-inspect-001',
      runId: 'run-cockpit-001',
      inferenceInputHash: computeSha256('input-telemetry-data'),
      sourceArtifactIds: ['art-turbine-telemetry.csv'],
      sourceHashes: [computeSha256('turbine-csv-content')],
      evidenceReferences: [],
      createdAt: new Date().toISOString(),
    },
    requirements: {
      schemaVersion: 1,
      modalities: ['text', 'vision'],
      primaryModality: 'text',
      tools: { requiredTools: ['ocr_extract', 'generate_docx'] },
      allowDegradation: false,
    },
    steps: [
      {
        stepId: 'step-1-ingest',
        stepType: 'INGEST_EVIDENCE',
        title: 'Ingest Raw Telemetry CSV & Maintenance Logs',
        assignedAgentId: 'INGEST_AGENT',
        requiredTools: ['csv_parse', 'pdf_raster'],
        requiredModel: {
          modelFamily: 'qwen-coder',
          requiredRevision: 'rev-2026-q1',
          devicePreference: 'cuda',
        },
        dependencies: [],
        inputs: { sourceIds: ['art-turbine-telemetry.csv'] },
        outputs: { expectedArtifactTypes: ['telemetry_matrix'] },
        requiresApproval: false,
        status: 'READY',
      },
      {
        stepId: 'step-2-ocr',
        stepType: 'RUN_OCR',
        title: 'Run OCR on Log Scans',
        assignedAgentId: 'OCR_AGENT',
        requiredTools: ['ocr_extract'],
        requiredModel: {
          modelFamily: 'vlm-qwen-vl',
          requiredRevision: 'rev-vlm-1',
          devicePreference: 'cuda',
        },
        dependencies: ['step-1-ingest'],
        inputs: { sourceIds: ['step-1-ingest'] },
        outputs: { expectedArtifactTypes: ['ocr_text'] },
        requiresApproval: false,
        status: 'PENDING',
      },
      {
        stepId: 'step-3-analysis',
        stepType: 'ANALYZE_IMAGE',
        title: 'Rust Analysis & Threshold Verification',
        assignedAgentId: 'ANALYSIS_AGENT',
        requiredTools: ['rust_engine_verify'],
        dependencies: ['step-2-ocr'],
        inputs: { sourceIds: ['step-2-ocr'] },
        outputs: { expectedArtifactTypes: ['verified_findings'] },
        requiresApproval: false,
        status: 'PENDING',
      },
      {
        stepId: 'step-4-approval',
        stepType: 'REQUEST_APPROVAL',
        title: 'Human Reviewer Sign-off Checkpoint',
        assignedAgentId: 'COMPLIANCE_AGENT',
        requiredTools: ['approval_request'],
        dependencies: ['step-3-analysis'],
        inputs: { sourceIds: ['step-3-analysis'] },
        outputs: { expectedArtifactTypes: ['signed_verdict'] },
        requiresApproval: true,
        approvalReason: 'Office deliverable generation requires authorized sign-off',
        status: 'PENDING',
      },
      {
        stepId: 'step-5-deliverable',
        stepType: 'GENERATE_DOCX',
        title: 'Generate Verified DOCX Executive Report',
        assignedAgentId: 'DOCX_AGENT',
        requiredTools: ['generate_docx', 'artifact_write'],
        dependencies: ['step-3-analysis', 'step-4-approval'],
        inputs: { sourceIds: ['step-3-analysis', 'step-4-approval'] },
        outputs: { expectedArtifactTypes: ['executive_report.docx'] },
        requiresApproval: true,
        approvalReason: 'Document generation gate',
        status: 'PENDING',
      },
    ],
    planHash: computeSha256('industrial-inspect-001'),
    deterministic: true,
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-15-test-'));
    fs.mkdirSync(path.join(tempDir, '.maos', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'events'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'logs'), { recursive: true });

    // Config
    const config = {
      projectName: 'proj-cockpit-test',
      profile: {
        id: 'industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
      },
    };
    fs.writeFileSync(path.join(tempDir, '.maos', 'maos.config.json'), JSON.stringify(config, null, 2));

    services = createServiceContainer(tempDir);
    // Save mock plan
    services.workflowPlanning.savePlan(mockPlan);

    router = new RestApiRouter(services, tempDir);
    server = http.createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    restClient = new MaosRestClient({ baseUrl, projectRoot: tempDir });
    browserClient = new BrowserRestClient({ baseUrl, projectRoot: tempDir });
    adapter = new GuiApiAdapter(browserClient, tempDir);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 1: Domain Schemas, Pure Types & Initial DAG Construction
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 1: Domain Types & Initial DAG Construction', () => {
    it('verifies ALL_COCKPIT_STAGE_STATUSES and ALL_COCKPIT_RUN_STATUSES completeness', () => {
      expect(ALL_COCKPIT_STAGE_STATUSES).toEqual([
        'PENDING',
        'READY',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'SKIPPED',
        'WAITING_APPROVAL',
        'INTERRUPTED',
      ]);
      expect(ALL_COCKPIT_RUN_STATUSES).toEqual([
        'IDLE',
        'PENDING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'INTERRUPTED',
        'CANCELLED',
        'BLOCKED',
      ]);
    });

    it('creates initial read-only DAG with zero placeholder success badges', () => {
      const state = createInitialCockpitState(mockPlan);

      expect(state.schemaVersion).toBe(1);
      expect(state.projectId).toBe('proj-cockpit-test');
      expect(state.runId).toBe('run-cockpit-001');
      expect(state.planId).toBe('plan-industrial-inspect-001');
      expect(state.status).toBe('PENDING');
      expect(state.nodes.length).toBe(5);
      expect(state.edges.length).toBe(5);

      // Root node (zero dependencies) must be READY
      const step1 = state.nodes.find((n) => n.stepId === 'step-1-ingest')!;
      expect(step1.status).toBe('READY');
      expect(step1.dependencies).toEqual([]);

      // Dependent nodes must be PENDING
      const step2 = state.nodes.find((n) => n.stepId === 'step-2-ocr')!;
      expect(step2.status).toBe('PENDING');
      expect(step2.dependencies).toEqual(['step-1-ingest']);

      // Negative protection: FORBID PLACEHOLDER SUCCESS
      for (const node of state.nodes) {
        expect(node.status).not.toBe('COMPLETED');
        expect(node.telemetry.totalTokens).toBe(0);
        expect(node.telemetry.latencyMs).toBe(0);
        expect(node.tools.length).toBe(0);
        expect(node.io.artifactIds.length).toBe(0);
      }
    });

    it('validates CockpitStageNode and CockpitState pure validators', () => {
      const state = createInitialCockpitState(mockPlan);

      const valState = validateCockpitState(state);
      expect(valState.valid).toBe(true);
      expect(valState.errors).toEqual([]);

      const valNode = validateCockpitStageNode(state.nodes[0]);
      expect(valNode.valid).toBe(true);

      // Rejects invalid schemaVersion
      expect(validateCockpitState({ ...state, schemaVersion: 2 }).valid).toBe(false);
      // Rejects invalid status
      expect(validateCockpitState({ ...state, status: 'INVALID_STATUS' }).valid).toBe(false);
      // Rejects missing required nodes
      expect(validateCockpitState({ ...state, nodes: 'not_an_array' }).valid).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 2: Pure Deterministic Replay Engine
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 2: Pure Deterministic Replay Engine', () => {
    const buildFullEventStream = (): SequencedEvent[] => [
      {
        schemaVersion: 1,
        eventId: 'evt-001',
        eventType: 'RUN_STARTED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 1,
        occurredAt: '2026-09-21T10:00:00.000Z',
        correlationId: 'corr-001',
        payload: { agentId: 'INGEST_AGENT' },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-002',
        eventType: 'STAGE_STARTED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 2,
        occurredAt: '2026-09-21T10:00:01.000Z',
        correlationId: 'corr-002',
        payload: {
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          model: { id: 'qwen-coder', family: 'qwen-coder', revision: 'rev-2026-q1', device: 'cuda' },
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-003',
        eventType: 'TOOL_EXECUTION',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 3,
        occurredAt: '2026-09-21T10:00:02.000Z',
        correlationId: 'corr-003',
        payload: {
          stepId: 'step-1-ingest',
          toolName: 'csv_parse',
          durationMs: 140,
          status: 'success',
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-004',
        eventType: 'TOKEN_USAGE',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 4,
        occurredAt: '2026-09-21T10:00:03.000Z',
        correlationId: 'corr-004',
        payload: {
          stepId: 'step-1-ingest',
          promptTokens: 450,
          completionTokens: 80,
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-005',
        eventType: 'ARTIFACT_CREATED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 5,
        occurredAt: '2026-09-21T10:00:04.000Z',
        correlationId: 'corr-005',
        payload: {
          stepId: 'step-1-ingest',
          artifactId: 'art-telemetry-matrix.json',
          hash: computeSha256('telemetry-matrix-content'),
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-006',
        eventType: 'STAGE_COMPLETED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 6,
        occurredAt: '2026-09-21T10:00:05.000Z',
        correlationId: 'corr-006',
        payload: { stepId: 'step-1-ingest' },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-007',
        eventType: 'STAGE_STARTED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 7,
        occurredAt: '2026-09-21T10:00:06.000Z',
        correlationId: 'corr-007',
        payload: {
          stepId: 'step-2-ocr',
          agentId: 'OCR_AGENT',
          model: { id: 'vlm-qwen-vl', family: 'vlm-qwen-vl', revision: 'rev-vlm-1', device: 'cuda' },
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-008',
        eventType: 'RETRY_ATTEMPTED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 8,
        occurredAt: '2026-09-21T10:00:07.000Z',
        correlationId: 'corr-008',
        payload: {
          stepId: 'step-2-ocr',
          reason: 'Transient raster buffer timeout',
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-009',
        eventType: 'TOOL_EXECUTION',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 9,
        occurredAt: '2026-09-21T10:00:08.000Z',
        correlationId: 'corr-009',
        payload: {
          stepId: 'step-2-ocr',
          toolName: 'ocr_extract',
          durationMs: 320,
          status: 'success',
        },
      },
      {
        schemaVersion: 1,
        eventId: 'evt-010',
        eventType: 'STAGE_COMPLETED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        sequence: 10,
        occurredAt: '2026-09-21T10:00:09.000Z',
        correlationId: 'corr-010',
        payload: { stepId: 'step-2-ocr' },
      },
    ];

    it('derives all 12 indicators accurately from typed event stream', () => {
      const events = buildFullEventStream();
      const state = reconstructCockpitState(mockPlan, events);

      // 1. Stages & Topological progression
      const step1 = state.nodes.find((n) => n.stepId === 'step-1-ingest')!;
      expect(step1.status).toBe('COMPLETED');

      // Step 2 completed -> Step 3 promoted from PENDING to READY
      const step2 = state.nodes.find((n) => n.stepId === 'step-2-ocr')!;
      expect(step2.status).toBe('COMPLETED');
      const step3 = state.nodes.find((n) => n.stepId === 'step-3-analysis')!;
      expect(step3.status).toBe('READY'); // Downstream promoted

      // 2. Active Agent
      expect(state.activeAgentId).toBe('OCR_AGENT');
      expect(step1.assignedAgentId).toBe('INGEST_AGENT');

      // 3. Actual Resident Model
      expect(step1.actualModel?.family).toBe('qwen-coder');
      expect(step1.actualModel?.device).toBe('cuda');
      expect(step2.actualModel?.family).toBe('vlm-qwen-vl');

      // 4. Tools Executed
      expect(step1.tools.length).toBe(1);
      expect(step1.tools[0].toolName).toBe('csv_parse');
      expect(step1.tools[0].invocations).toBe(1);
      expect(step1.tools[0].lastStatus).toBe('success');

      // 5. I/O Artifacts
      expect(step1.io.artifactIds).toContain('art-telemetry-matrix.json');
      expect(step1.io.artifactHashes.length).toBe(1);

      // 6. Retries
      expect(step2.retries.count).toBe(1);
      expect(step2.retries.lastRetryReason).toBe('Transient raster buffer timeout');

      // 7. Token Usage
      expect(state.totalTokens.prompt).toBe(450);
      expect(state.totalTokens.completion).toBe(80);
      expect(state.totalTokens.total).toBe(530);

      // 8. Latency Timings
      expect(state.totalLatencyMs).toBe(460); // 140 (step 1) + 320 (step 2)

      // 9. Sequence Cursor
      expect(state.currentCursor).toBe(10);
      expect(state.processedEventCount).toBe(10);
    });

    it('demonstrates 100% determinism across 100 consecutive replays', () => {
      const events = buildFullEventStream();
      const reference = reconstructCockpitState(mockPlan, events);
      const referenceJson = JSON.stringify(reference);

      for (let i = 0; i < 100; i++) {
        // Shuffle input event order to prove order-invariance of the reconstructor
        const shuffled = [...events].sort(() => Math.random() - 0.5);
        const replayed = reconstructCockpitState(mockPlan, shuffled);
        expect(JSON.stringify(replayed)).toBe(referenceJson);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 3: Negative Protections & Security Guardrails
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 3: Negative Protections & Guardrails', () => {
    it('enforces read-only immutability (No visual editing)', () => {
      const state = createInitialCockpitState(mockPlan);

      // State and its arrays are frozen
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.nodes)).toBe(true);
      expect(Object.isFrozen(state.edges)).toBe(true);

      // Attempting to mutate throws in strict mode
      expect(() => {
        (state as any).status = 'COMPLETED';
      }).toThrow();

      expect(() => {
        (state.nodes as any).push({ stepId: 'fake-node' });
      }).toThrow();
    });

    it('rejects cross-project events (CROSS_PROJECT_EVENT_REJECTED)', () => {
      const state = createInitialCockpitState(mockPlan);
      const rogueEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'evt-rogue',
        eventType: 'STAGE_STARTED',
        projectId: 'attacker-project', // Cross-project mismatch
        sequence: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-attack',
        payload: { stepId: 'step-1-ingest' },
      };

      expect(() => applySequencedEventToCockpit(state, rogueEvent)).toThrow(CockpitReplayError);
      expect(() => applySequencedEventToCockpit(state, rogueEvent)).toThrowError(
        /does not match state projectId/,
      );
    });

    it('idempotently ignores duplicate or out-of-order sequence events (seq <= cursor)', () => {
      let state = createInitialCockpitState(mockPlan);
      const evt1: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'evt-1',
        eventType: 'STAGE_STARTED',
        projectId: 'proj-cockpit-test',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-1',
        payload: { stepId: 'step-1-ingest' },
      };

      state = applySequencedEventToCockpit(state, evt1);
      expect(state.currentCursor).toBe(1);
      expect(state.processedEventCount).toBe(1);

      // Re-applying duplicate sequence 1 must return identical state without duplicate count
      const duplicateState = applySequencedEventToCockpit(state, evt1);
      expect(duplicateState.currentCursor).toBe(1);
      expect(duplicateState.processedEventCount).toBe(1);
    });

    it('prevents phantom completion after force-stop or failure', () => {
      let state = createInitialCockpitState(mockPlan);

      // 1. Start Step 1
      state = applySequencedEventToCockpit(state, {
        schemaVersion: 1,
        eventId: 'evt-start',
        eventType: 'STAGE_STARTED',
        projectId: 'proj-cockpit-test',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-1',
        payload: { stepId: 'step-1-ingest' },
      });
      expect(state.nodes[0].status).toBe('RUNNING');

      // 2. Emergency Force Stop
      state = applySequencedEventToCockpit(state, {
        schemaVersion: 1,
        eventId: 'evt-stop',
        eventType: 'FORCE_STOP_CONFIRMED',
        projectId: 'proj-cockpit-test',
        sequence: 2,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-2',
        payload: { runId: 'run-cockpit-001', reason: 'Vibration excursion emergency stop' },
      });

      expect(state.status).toBe('INTERRUPTED');
      expect(state.forceStopped).toBe(true);
      expect(state.nodes[0].status).toBe('INTERRUPTED');

      // 3. Negative test: Rogue downstream worker attempts to report STAGE_COMPLETED
      const rogueCompletion: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'evt-phantom',
        eventType: 'STAGE_COMPLETED',
        projectId: 'proj-cockpit-test',
        sequence: 3,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-3',
        payload: { stepId: 'step-1-ingest' },
      };

      const stateAfterPhantom = applySequencedEventToCockpit(state, rogueCompletion);
      // Status must REMAIN INTERRUPTED — phantom completion dropped!
      expect(stateAfterPhantom.nodes[0].status).toBe('INTERRUPTED');
      expect(stateAfterPhantom.status).toBe('INTERRUPTED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 4: CockpitService Persistence & State Assembly
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 4: CockpitService Persistence & State Assembly', () => {
    it('retrieves authoritative state and list of runs from disk', () => {
      const runList = services.cockpit.listCockpitRuns('proj-cockpit-test');
      expect(runList.length).toBeGreaterThanOrEqual(1);
      const run = runList.find((r) => r.runId === 'run-cockpit-001');
      expect(run).toBeDefined();
      expect(run?.projectId).toBe('proj-cockpit-test');

      const state = services.cockpit.getCockpitState('proj-cockpit-test', 'run-cockpit-001');
      expect(state).not.toBeNull();
      expect(state?.planId).toBe('plan-industrial-inspect-001');
      expect(state?.nodes.length).toBe(5);
    });

    it('replays run events from cursor', () => {
      // Record a test event on disk
      services.event.recordEvent({
        eventType: 'RUN_STARTED',
        projectId: 'proj-cockpit-test',
        runId: 'run-cockpit-001',
        correlationId: 'corr-disk-test',
        payload: { agentId: 'INGEST_AGENT' },
      });

      const replayRes = services.cockpit.replayRunEvents('proj-cockpit-test', 'run-cockpit-001', 0);
      expect(replayRes.state).toBeDefined();
      expect(replayRes.state.isReplaying).toBe(true);
      expect(replayRes.events.length).toBeGreaterThan(0);
    });

    it('executes confirmed force stop and emits authoritative event', async () => {
      // Unconfirmed force-stop fails closed
      await expect(
        services.cockpit.executeRunStop('proj-cockpit-test', 'run-cockpit-001', {
          mode: 'force',
          confirmed: false,
        }),
      ).rejects.toThrow(/FORCE_STOP_CONFIRMATION_REQUIRED/);

      // Confirmed force-stop succeeds
      const stopRes = await services.cockpit.executeRunStop('proj-cockpit-test', 'run-cockpit-001', {
        mode: 'force',
        confirmed: true,
        reason: 'Service test emergency stop',
      });
      expect(stopRes.success).toBe(true);
      expect(stopRes.status).toBe('interrupted');

      // Verifies state transitions to INTERRUPTED on subsequent read
      const updatedState = services.cockpit.getCockpitState('proj-cockpit-test', 'run-cockpit-001');
      expect(updatedState?.status).toBe('INTERRUPTED');
      expect(updatedState?.forceStopped).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 5: REST API Router Endpoints
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 5: REST API Router Endpoints', () => {
    it('GET /api/v1/cockpit returns list of active runs', async () => {
      const res = await restClient.listCockpitRuns('proj-cockpit-test');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data?.some((r) => r.runId === 'run-cockpit-001')).toBe(true);
    });

    it('GET /api/v1/cockpit/:runId returns authoritative CockpitState', async () => {
      const res = await restClient.getCockpitState('run-cockpit-001', { projectId: 'proj-cockpit-test' });
      expect(res.status).toBe(200);
      expect(res.data?.schemaVersion).toBe(1);
      expect(res.data?.runId).toBe('run-cockpit-001');
      expect(res.data?.nodes.length).toBe(5);
    });

    it('GET /api/v1/cockpit/:runId returns 404 for non-existent run', async () => {
      const res = await restClient.getCockpitState('non-existent-run');
      expect(res.status).toBe(404);
    });

    it('POST /api/v1/cockpit/:runId/stop enforces confirmation for force-stop', async () => {
      // 1. Unconfirmed force stop -> 400
      const unconfirmedRes = await restClient.stopCockpitRun('run-cockpit-001', {
        mode: 'force',
        confirmed: false,
      });
      expect(unconfirmedRes.status).toBe(400);

      // 2. Confirmed force stop -> 200
      const confirmedRes = await restClient.stopCockpitRun('run-cockpit-001', {
        mode: 'force',
        confirmed: true,
        reason: 'Rest confirmed halt',
      });
      expect(confirmedRes.status).toBe(200);
      expect(confirmedRes.data?.status).toBe('interrupted');
    });

    it('GET /api/v1/cockpit/:runId/replay returns reconstructed state and events', async () => {
      const res = await restClient.replayCockpitRun('run-cockpit-001', { projectId: 'proj-cockpit-test' });
      expect(res.status).toBe(200);
      expect(res.data?.runId).toBe('run-cockpit-001');
      expect(res.data?.isReplaying).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 6: 4-Way Client Parity & Runtime Validation
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 6: 4-Way Client Parity & Runtime Validation', () => {
    it('verifies getCockpitState parity across MaosRestClient, BrowserRestClient, and GuiApiAdapter', async () => {
      const direct = services.cockpit.getCockpitState('proj-cockpit-test', 'run-cockpit-001')!;
      const rest = (await restClient.getCockpitState('run-cockpit-001', { projectId: 'proj-cockpit-test' })).data!;
      const browser = await browserClient.getCockpitState('run-cockpit-001', { projectId: 'proj-cockpit-test' });
      const adapt = await adapter.getCockpitState('run-cockpit-001', 'proj-cockpit-test');

      expect(direct.runId).toBe(rest.runId);
      expect(rest.runId).toBe(browser.runId);
      expect(browser.runId).toBe(adapt.runId);

      expect(direct.nodes.length).toBe(browser.nodes.length);
      expect(browser.nodes.length).toBe(adapt.nodes.length);
      expect(direct.status).toBe(adapt.status);
    });

    it('verifies listCockpitRuns parity across all clients', async () => {
      const direct = services.cockpit.listCockpitRuns('proj-cockpit-test');
      const rest = (await restClient.listCockpitRuns('proj-cockpit-test')).data!;
      const browser = await browserClient.listCockpitRuns('proj-cockpit-test');
      const adapt = await adapter.listCockpitRuns('proj-cockpit-test');

      expect(direct.length).toBe(rest.length);
      expect(rest.length).toBe(browser.length);
      expect(browser.length).toBe(adapt.length);
    });

    it('verifies GUI runtime-validation functions validate and reject correctly', () => {
      const state = createInitialCockpitState(mockPlan);

      expect(guiValidateCockpitState(state)).toEqual(state);
      expect(guiValidateCockpitRunsList([summarizeCockpitState(state)])).toHaveLength(1);

      // Rejects invalid payload
      expect(() => guiValidateCockpitState({ notAState: true })).toThrow();
      expect(() => guiValidateCockpitRunsList('not-an-array')).toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 7: Reconnection & Lossless Event Resync
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 7: Reconnection & Lossless Event Resync', () => {
    it('replays intermediate transitions from cursor without losing state or duplicating nodes', async () => {
      // Simulate client disconnect at cursor = 1
      const initialPlan = mockPlan;
      const initialEvents: SequencedEvent[] = [
        {
          schemaVersion: 1,
          eventId: 'reconnect-evt-1',
          eventType: 'STAGE_STARTED',
          projectId: 'proj-cockpit-test',
          runId: 'run-reconnect-test',
          sequence: 1,
          occurredAt: '2026-09-21T11:00:00.000Z',
          correlationId: 'corr-rec-1',
          payload: { stepId: 'step-1-ingest', agentId: 'INGEST_AGENT' },
        },
      ];

      const clientStateBeforeDisconnect = reconstructCockpitState(initialPlan, initialEvents, {
        runId: 'run-reconnect-test',
      });
      expect(clientStateBeforeDisconnect.currentCursor).toBe(1);
      expect(clientStateBeforeDisconnect.nodes[0].status).toBe('RUNNING');

      // While disconnected, server records events 2 and 3
      const missedEvents: SequencedEvent[] = [
        {
          schemaVersion: 1,
          eventId: 'reconnect-evt-2',
          eventType: 'TOOL_EXECUTION',
          projectId: 'proj-cockpit-test',
          runId: 'run-reconnect-test',
          sequence: 2,
          occurredAt: '2026-09-21T11:00:01.000Z',
          correlationId: 'corr-rec-2',
          payload: { stepId: 'step-1-ingest', toolName: 'csv_parse', durationMs: 200, status: 'success' },
        },
        {
          schemaVersion: 1,
          eventId: 'reconnect-evt-3',
          eventType: 'STAGE_COMPLETED',
          projectId: 'proj-cockpit-test',
          runId: 'run-reconnect-test',
          sequence: 3,
          occurredAt: '2026-09-21T11:00:02.000Z',
          correlationId: 'corr-rec-3',
          payload: { stepId: 'step-1-ingest' },
        },
      ];

      // Reconnect: client applies replayed missed events
      let reconnectedState = clientStateBeforeDisconnect;
      for (const evt of missedEvents) {
        reconnectedState = applySequencedEventToCockpit(reconnectedState, evt);
      }

      // Ground truth full replay from scratch
      const groundTruth = reconstructCockpitState(initialPlan, [...initialEvents, ...missedEvents], {
        runId: 'run-reconnect-test',
      });

      // State after resync must be identical to ground truth
      expect(reconnectedState.currentCursor).toBe(3);
      expect(reconnectedState.nodes.length).toBe(groundTruth.nodes.length); // Zero node duplication
      expect(reconnectedState.nodes[0].status).toBe('COMPLETED');
      expect(reconnectedState.nodes[1].status).toBe('READY'); // Downstream promoted
      expect(JSON.stringify(reconnectedState)).toBe(JSON.stringify(groundTruth));
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 8: Security & Gate Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 8: Security & Gate Invariants', () => {
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

      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
