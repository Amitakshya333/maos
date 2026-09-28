import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createServiceContainer } from '../../src/service';
import { RestApiRouter } from '../../src/api';
import {
  createInitialCockpitState,
  reconstructCockpitState,
  projectStageNode,
  projectWorkflowState,
  projectWorkflowStage,
  WorkflowProjection,
  WorkflowRunProjection,
} from '../../src/domain/cockpit';
import type { WorkflowPlan } from '../../src/domain/workflow-plan';
import type { SequencedEvent, WorkflowStage } from '../../src/domain/schemas';

describe('F10-03: Typed Workflow Projections', () => {
  const testRoot = path.resolve(__dirname, '../../.maos/test-temp-f10-03-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'objectives'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'events'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'approvals'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  const samplePlan: WorkflowPlan = {
    schemaVersion: 1,
    planId: 'plan-industrial-safety-001',
    title: 'Industrial Safety Audit',
    intent: 'execute',
    recipeId: 'industrial-safety-audit-v1',
    planHash: 'd41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000000',
    status: 'READY',
    deterministic: true,
    requirements: {
      schemaVersion: 1,
      modalities: ['text', 'vision'],
      primaryModality: 'text',
      safetyCritical: true,
      maxBudgetUsd: 1.0,
      tools: {
        requiredTools: ['artifact_read'],
        forbiddenTools: [],
      },
    },
    provenance: {
      projectId: 'proj-turbo-01',
      taskId: 'task-001',
      runId: 'run-turbo-001',
      inferenceInputHash: '0'.repeat(64),
      sourceArtifactIds: ['telemetry.csv', 'maintenance.pdf'],
      sourceHashes: ['0'.repeat(64), '1'.repeat(64)],
      evidenceReferences: [],
      createdAt: '2026-09-24T18:00:00.000Z',
    },
    steps: [
      {
        stepId: 'step-1-ingest',
        stepType: 'INGEST_EVIDENCE',
        title: 'Ingest Telemetry and Maintenance PDF',
        assignedAgentId: 'INGEST_AGENT',
        dependencies: [],
        requiredTools: ['artifact_read'],
        status: 'READY',
        requiredModel: {
          modelFamily: 'qwen2.5-coder-7b',
          requiredRevision: 'rev-qwen-7b-frozen',
          devicePreference: 'gpu',
        },
        inputs: {
          sourceIds: ['telemetry.csv', 'maintenance.pdf'],
        },
        outputs: {
          expectedArtifactTypes: ['raw_telemetry', 'extracted_report'],
        },
        requiresApproval: false,
      },
      {
        stepId: 'step-2-analysis',
        stepType: 'REVIEW_CONFLICT',
        title: 'Vibration Anomaly & ISO Threshold Analysis',
        assignedAgentId: 'ANALYST_AGENT',
        dependencies: ['step-1-ingest'],
        requiredTools: ['artifact_read'],
        status: 'PENDING',
        requiredModel: {
          modelFamily: 'qwen2.5-coder-7b',
          requiredRevision: 'rev-qwen-7b-frozen',
          devicePreference: 'gpu',
        },
        inputs: {
          sourceIds: ['step-1-ingest'],
        },
        outputs: {
          expectedArtifactTypes: ['analysis_findings'],
        },
        requiresApproval: false,
      },
      {
        stepId: 'step-3-deliverable',
        stepType: 'GENERATE_DOCX',
        title: 'Generate Sovereign Safety DOCX Deliverable',
        assignedAgentId: 'SYNTHESIZER_AGENT',
        dependencies: ['step-2-analysis'],
        requiredTools: ['artifact_read', 'approval_request'],
        status: 'PENDING',
        requiredModel: {
          modelFamily: 'deepseek-r1-distill-qwen-14b',
          requiredRevision: 'rev-deepseek-14b-frozen',
          devicePreference: 'gpu',
        },
        inputs: {
          sourceIds: ['step-2-analysis'],
        },
        outputs: {
          expectedArtifactTypes: ['docx_deliverable'],
        },
        requiresApproval: true,
        approvalReason: 'Official deliverable generation requires human review',
      },
    ],
  };

  describe('Pure Projection Helpers', () => {
    it('projects all 9 required fields for stage node: state, dependencies, tool, retry, review, model, timing, artifacts, routes', () => {
      const state = createInitialCockpitState(samplePlan);
      expect(state.nodes).toHaveLength(3);

      const node1 = state.nodes[0];
      const proj = projectStageNode(node1, state.projectId, state.runId);

      // 1. state
      expect(proj.state).toBe('READY'); // no dependencies -> READY

      // 2. dependencies
      expect(proj.dependencies).toEqual([]);

      // 3. tool
      expect(proj.tools).toEqual([]);

      // 4. retry
      expect(proj.retries.count).toBe(0);
      expect(proj.retries.maxRetries).toBe(3);

      // 5. review
      expect(proj.review.required).toBe(false);

      // 6. model
      expect(proj.model).toBeDefined();
      expect(proj.model?.modelId).toBe('qwen2.5-coder-7b');
      expect(proj.model?.revision).toBe('rev-qwen-7b-frozen');
      expect(proj.model?.device).toBe('gpu');
      expect(proj.model?.isFallbackCpu).toBe(false);

      // 7. timing
      expect(proj.timing.latencyMs).toBe(0);
      expect(proj.timing.totalTokens).toBe(0);

      // 8. artifacts
      expect(proj.artifacts.sourceIds).toContain('telemetry.csv');
      expect(proj.artifacts.expectedArtifactTypes).toContain('raw_telemetry');

      // 9. routes
      expect(proj.routes.stage).toBe(`/api/v1/workflows/${encodeURIComponent('step-1-ingest')}`);
      expect(proj.routes.artifacts).toEqual([]);
      expect(proj.routes.approval).toBeUndefined();
    });

    it('projects approval review details and routes when step requires approval', () => {
      const state = createInitialCockpitState(samplePlan);
      const step3 = state.nodes[2];
      const proj = projectStageNode(step3, state.projectId, state.runId);

      expect(proj.review.required).toBe(true);
      expect(proj.review.reason).toContain('Official deliverable generation requires human review');
      expect(proj.routes.approval).toBeUndefined(); // approval not yet requested
    });

    it('projects complete run-level projection via projectWorkflowState', () => {
      const state = createInitialCockpitState(samplePlan);
      const runProj: WorkflowRunProjection = projectWorkflowState(state);

      expect(runProj.schemaVersion).toBe(1);
      expect(runProj.projectId).toBe(samplePlan.provenance.projectId);
      expect(runProj.runId).toBe(samplePlan.provenance.runId);
      expect(runProj.planId).toBe(samplePlan.planId);
      expect(runProj.state).toBe('PENDING');
      expect(runProj.stages).toHaveLength(3);
      expect(runProj.dependencies).toHaveLength(2); // step1 -> step2, step2 -> step3

      // Verify state routes
      expect(runProj.routes.run).toBe(`/api/v1/cockpit/${encodeURIComponent(state.runId)}`);
      expect(runProj.routes.replay).toBe(`/api/v1/cockpit/${encodeURIComponent(state.runId)}/replay`);
      expect(runProj.routes.stop).toBe(`/api/v1/cockpit/${encodeURIComponent(state.runId)}/stop`);
      expect(runProj.routes.stages).toBe(`/api/v1/workflows?runId=${encodeURIComponent(state.runId)}`);
      expect(runProj.routes.approvals).toBe(`/api/v1/approvals?runId=${encodeURIComponent(state.runId)}`);
      expect(runProj.routes.audit).toBe(`/api/v1/audit/export?runId=${encodeURIComponent(state.runId)}`);
    });

    it('projects standalone WorkflowStage from WorkflowService', () => {
      const stage: WorkflowStage = {
        schemaVersion: 1,
        id: 'obj-standalone-001',
        goal: 'Turbine Vibration Baseline',
        status: 'executing',
        version: 1,
        childTaskIds: ['task-sub-1', 'task-sub-2'],
        completedChildIds: ['task-sub-1'],
        failedChildIds: [],
        cancelledChildIds: [],
        plannerAgentId: 'AUTO',
        planHistory: [],
        createdAt: '2026-09-24T18:10:00.000Z',
        planCompletedAt: null,
        doneAt: null,
        maxReplanAttempts: 3,
        replanCount: 1,
      };

      const proj = projectWorkflowStage(stage, 'proj-turbo-01');
      expect(proj.schemaVersion).toBe(1);
      expect(proj.projectId).toBe('proj-turbo-01');
      expect(proj.runId).toBe('obj-standalone-001');
      expect(proj.stageId).toBe('obj-standalone-001');
      expect(proj.title).toBe('Turbine Vibration Baseline');
      expect(proj.state).toBe('RUNNING'); // executing -> RUNNING
      expect(proj.dependencies).toEqual(['task-sub-1', 'task-sub-2']);
      expect(proj.retries.count).toBe(1);
      expect(proj.retries.maxRetries).toBe(3);
      expect(proj.timing.startedAt).toBe('2026-09-24T18:10:00.000Z');
      expect(proj.routes.stage).toBe(`/api/v1/workflows/${encodeURIComponent('obj-standalone-001')}`);
    });
  });

  describe('Event-driven Runtime Evolution of Projections', () => {
    it('evolves tool executions, latency, artifacts, and approvals through sequenced replay', () => {
      const events: SequencedEvent[] = [
        {
          schemaVersion: 1,
          sequence: 1,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'STAGE_STARTED',
          occurredAt: '2026-09-24T18:01:00.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: {},
        },
        {
          schemaVersion: 1,
          sequence: 2,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'TOOL_INVOKED',
          occurredAt: '2026-09-24T18:01:05.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: {
            toolName: 'ocr_document',
            durationMs: 450,
            status: 'success',
          },
        },
        {
          schemaVersion: 1,
          sequence: 3,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'ARTIFACT_FINALIZED',
          occurredAt: '2026-09-24T18:01:10.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: {
            artifactId: 'art-telemetry-clean-001',
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        },
        {
          schemaVersion: 1,
          sequence: 4,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'STAGE_COMPLETED',
          occurredAt: '2026-09-24T18:01:15.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: {
            tokens: { prompt: 150, completion: 50, total: 200 },
            latencyMs: 15000,
          },
        },
      ];

      const state = reconstructCockpitState(samplePlan, events);
      const proj = projectWorkflowState(state);

      const step1 = proj.stages[0];
      expect(step1.state).toBe('COMPLETED');
      expect(step1.tools).toHaveLength(1);
      expect(step1.tools[0].toolName).toBe('ocr_document');
      expect(step1.tools[0].invocations).toBe(1);
      expect(step1.tools[0].lastStatus).toBe('success');
      expect(step1.tools[0].totalDurationMs).toBe(450);

      // Verify artifacts & derived routes
      expect(step1.artifacts.artifactIds).toContain('art-telemetry-clean-001');
      expect(step1.routes.artifacts).toContain('/api/v1/artifacts/art-telemetry-clean-001');

      // Verify telemetry timing
      expect(step1.timing.totalTokens).toBe(200);
      expect(step1.timing.latencyMs).toBe(15450);
      expect(step1.timing.startedAt).toBe('2026-09-24T18:01:00.000Z');
      expect(step1.timing.completedAt).toBe('2026-09-24T18:01:15.000Z');

      // Dependent step2 should now transition to READY
      const step2 = proj.stages[1];
      expect(step2.state).toBe('READY');
    });
  });

  describe('Service & REST API Integration', () => {
    it('WorkflowService provides typed projection via getWorkflowProjection', () => {
      const services = createServiceContainer(testRoot);
      const stage = services.workflow.createObjective({
        id: 'obj-proj-test-1',
        goal: 'Perform Acoustic Emission ISO Audit',
        plannerAgentId: 'AUDITOR_AGENT',
      });

      const proj = services.workflow.getWorkflowProjection('obj-proj-test-1');
      expect(proj).not.toBeNull();
      expect(proj?.stageId).toBe(stage.id);
      expect(proj?.title).toBe(stage.goal);
      expect(proj?.assignedAgentId).toBe('AUDITOR_AGENT');
      expect(proj?.state).toBe('READY'); // planning -> READY
      expect(proj?.routes.stage).toBe(`/api/v1/workflows/${encodeURIComponent(stage.id)}`);
    });

    it('CockpitService provides run projection via getWorkflowRunProjection', () => {
      const services = createServiceContainer(testRoot);
      services.workflowPlanning.savePlan(samplePlan);

      const runProj = services.cockpit.getWorkflowRunProjection('proj-turbo-01', samplePlan.provenance.runId!);
      expect(runProj).not.toBeNull();
      expect(runProj?.runId).toBe(samplePlan.provenance.runId);
      expect(runProj?.stages).toHaveLength(3);
      expect(runProj?.routes.run).toBe(`/api/v1/cockpit/${encodeURIComponent(samplePlan.provenance.runId!)}`);
    });

    it('serves GET /api/v1/workflows/:id/projection via RestApiRouter', async () => {
      const services = createServiceContainer(testRoot);
      services.workflow.createObjective({
        id: 'obj-rest-projection-01',
        goal: 'Examine Bearing Temperature Logs',
        plannerAgentId: 'AUTO',
      });

      const router = new RestApiRouter(services, testRoot);
      const server = http.createServer((req, res) => router.handle(req, res));

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address() as { port: number };

      try {
        const res = await fetch(
          `http://127.0.0.1:${address.port}/api/v1/workflows/obj-rest-projection-01/projection`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: WorkflowProjection };
        expect(body.data).toBeDefined();
        expect(body.data.stageId).toBe('obj-rest-projection-01');
        expect(body.data.title).toBe('Examine Bearing Temperature Logs');
        expect(body.data.routes.stage).toBe('/api/v1/workflows/obj-rest-projection-01');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('serves GET /api/v1/workflows/runs/:runId/stages via RestApiRouter', async () => {
      const services = createServiceContainer(testRoot);
      services.workflow.createObjective({
        id: 'run-multi-stage-01',
        goal: 'Multi-stage root workflow',
        plannerAgentId: 'AUTO',
      });

      const router = new RestApiRouter(services, testRoot);
      const server = http.createServer((req, res) => router.handle(req, res));

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address() as { port: number };

      try {
        const res = await fetch(
          `http://127.0.0.1:${address.port}/api/v1/workflows/runs/run-multi-stage-01/stages`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: WorkflowStage[] };
        expect(body.data).toBeDefined();
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.data[0].id).toBe('run-multi-stage-01');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('Negative Invariants', () => {
    it('never uses static placeholder values or synthetic completion', () => {
      const state = createInitialCockpitState(samplePlan);
      const proj = projectWorkflowState(state);

      // Verify no static fake "100%" or placeholder status exists
      for (const stage of proj.stages) {
        expect(['PENDING', 'READY']).toContain(stage.state);
        expect(stage.state).not.toBe('COMPLETED');
        expect(stage.state).not.toBe('DONE');
        expect(stage.title).not.toContain('placeholder');
        expect(stage.assignedAgentId).not.toBe('placeholder');
      }
    });

    it('prevents phantom completion when step is interrupted', () => {
      const events: SequencedEvent[] = [
        {
          schemaVersion: 1,
          sequence: 1,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'STEP_STARTED',
          occurredAt: '2026-09-24T18:01:00.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: {},
        },
        {
          schemaVersion: 1,
          sequence: 2,
          projectId: 'proj-turbo-01',
          runId: 'run-turbo-001',
          type: 'STEP_INTERRUPTED',
          occurredAt: '2026-09-24T18:01:10.000Z',
          stepId: 'step-1-ingest',
          agentId: 'INGEST_AGENT',
          payload: { reason: 'Emergency force stop executed' },
        },
      ];

      const state = reconstructCockpitState(samplePlan, events);
      const proj = projectWorkflowState(state);

      const step1 = proj.stages[0];
      expect(step1.state).toBe('INTERRUPTED');
      expect(step1.error?.message).toContain('Emergency force stop executed');

      // Downstream step cannot be READY or COMPLETED
      const step2 = proj.stages[1];
      expect(step2.state).toBe('PENDING');
    });
  });
});
