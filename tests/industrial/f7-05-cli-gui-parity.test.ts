/**
 * F7-05: 4-Way Interface Parity & Idempotency Hardening Tests
 *
 * Verifies strict parity across:
 *   1. Direct ServiceContainer (services.inference, services.workflowPlanning, services.toolApprovalPlanning)
 *   2. Core Orchestrator wrappers (planTaskWorkflow, planStepToolExecution, verifyStepToolPreExecution)
 *   3. REST API endpoints via MaosRestClient
 *   4. GUI client adapter via GuiApiAdapter
 *
 * Ensures identical status codes, error behaviors, durable idempotency replay/conflict,
 * zero credential leakage in audit logs, and unmodified canary hash.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { createRestApiServer, RestApiServer } from '../../src/api/server';
import { MaosRestClient } from '../../src/api/client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import { ServiceContainer } from '../../src/service';
import {
  planTaskWorkflow,
  planStepToolExecution,
  verifyStepToolPreExecution,
} from '../../src/core/orchestrator';
import {
  InferenceInput,
  TaskFile,
} from '../../src/domain';
import { AgentProfile } from '../../src/core/router';
import { ToolPreExecutionContext } from '../../src/industrial/tool-approval-planner';

describe('F7-05: 4-Way Interface Parity & Idempotency Hardening', () => {
  let tmpDir: string;
  let server: RestApiServer;
  let services: ServiceContainer;
  let client: MaosRestClient;
  let guiAdapter: GuiApiAdapter;
  let port: number;

  const testFleet: AgentProfile[] = [
    {
      id: 'office-docx-builder',
      role: 'document_generation',
      provider: 'local',
      model: 'qwen2.5-coder-7b',
      capabilities: ['text', 'docx', 'generate_docx', 'artifact_read', 'artifact_write'],
      costTier: 'low',
      maxIterations: 10,
      idle: true,
      enabled: true,
      modalities: ['text'],
      allowedTools: ['generate_docx', 'artifact_read', 'artifact_write', 'approval_request'],
      runtimeStats: { modelRevision: '2026-09-PINNED-REVISION' } as any,
    },
    {
      id: 'office-xlsx-builder',
      role: 'spreadsheet_generation',
      provider: 'local',
      model: 'qwen2.5-coder-7b',
      capabilities: ['text', 'xlsx', 'generate_xlsx', 'artifact_read', 'artifact_write'],
      costTier: 'low',
      maxIterations: 10,
      idle: true,
      enabled: true,
      modalities: ['text'],
      allowedTools: ['generate_xlsx', 'artifact_read', 'artifact_write', 'approval_request'],
      runtimeStats: { modelRevision: '2026-09-PINNED-REVISION' } as any,
    },
    {
      id: 'text-assistant',
      role: 'general',
      provider: 'local',
      model: 'qwen-text-only',
      capabilities: ['text', 'artifact_read'],
      costTier: 'low',
      maxIterations: 10,
      idle: true,
      enabled: true,
      modalities: ['text'],
      allowedTools: ['artifact_read'],
      runtimeStats: { modelRevision: '2026-09-PINNED-REVISION' } as any,
    },
  ];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f705-parity-'));
    const maosDir = path.join(tmpDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'execution-plans'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });

    // Minimal project configuration
    const config = {
      projectName: 'parity-test-project',
      routingMode: 'local',
      providers: {
        local: { type: 'local', host: '127.0.0.1', port: 11434 },
      },
      agents: testFleet,
      routing: {
        strategy: 'cost_first',
        costWeight: 0.5,
        capabilityWeight: 0.5,
        maxParallelAgents: 2,
        fallbackProvider: 'local',
      },
    };
    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

    server = createRestApiServer(tmpDir);
    port = await server.start(0);
    services = server.getServices();

    const baseUrl = `http://127.0.0.1:${port}`;
    client = new MaosRestClient({ baseUrl, projectRoot: tmpDir });
    guiAdapter = new GuiApiAdapter({ baseUrl, projectRoot: tmpDir });
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── 1. Inference Parity across Direct, REST, and GUI ─────────────

  describe('1. Inference Parity across Direct, REST, and GUI', () => {
    it('returns identical MATCHED result and hash for valid DOCX generation input', async () => {
      const input: InferenceInput = {
        text: 'Generate DOCX project charter report for client sign-off',
      };

      // 1. Direct Service
      const directResult = services.inference.infer(input);
      expect(directResult.status).toBe('MATCHED');
      expect(directResult.inferredIntent).toBe('generate_docx');

      // 2. REST Client
      const restResponse = await client.infer(input);
      expect(restResponse.status).toBe(200);
      expect(restResponse.data).toBeDefined();
      const restResult = restResponse.data!;

      // 3. GUI Adapter
      const guiResult = await guiAdapter.infer(input);
      expect(guiResult).toBeDefined();

      // Verify exact parity
      expect(restResult.status).toBe(directResult.status);
      expect(guiResult.status).toBe(directResult.status);
      expect(restResult.inputHash).toBe(directResult.inputHash);
      expect(guiResult.inputHash).toBe(directResult.inputHash);
      expect(restResult.inferredIntent).toBe(directResult.inferredIntent);
      expect(guiResult.inferredIntent).toBe(directResult.inferredIntent);
      expect(restResult.selectedAgent).toBe(directResult.selectedAgent);
      expect(guiResult.selectedAgent).toBe(directResult.selectedAgent);
    });

    it('returns identical CLARIFICATION_REQUIRED across Direct, REST, and GUI for vague prompt', async () => {
      const vagueInput: InferenceInput = {
        text: 'help',
      };

      // 1. Direct Service
      const directResult = services.inference.infer(vagueInput);
      expect(directResult.status).toBe('CLARIFICATION_REQUIRED');
      expect(directResult.clarificationPrompt).toBeDefined();

      // 2. REST Client
      const restResponse = await client.infer(vagueInput);
      expect(restResponse.status).toBe(200);
      const restResult = restResponse.data!;

      // 3. GUI Adapter
      const guiResult = await guiAdapter.infer(vagueInput);

      // Verify parity
      expect(restResult.status).toBe('CLARIFICATION_REQUIRED');
      expect(guiResult.status).toBe('CLARIFICATION_REQUIRED');
      expect(restResult.clarificationPrompt).toBe(directResult.clarificationPrompt);
      expect(guiResult.clarificationPrompt).toBe(directResult.clarificationPrompt);
      expect(restResult.inputHash).toBe(directResult.inputHash);
      expect(guiResult.inputHash).toBe(directResult.inputHash);
    });

    it('returns identical UNSUPPORTED status across Direct, REST, and GUI for cloud egress attempt', async () => {
      const unsupportedInput: InferenceInput = {
        text: 'deploy to aws cloud cluster now',
      };

      const directResult = services.inference.infer(unsupportedInput);
      expect(directResult.status).toBe('UNSUPPORTED');

      const restResponse = await client.infer(unsupportedInput);
      expect(restResponse.status).toBe(200);
      expect(restResponse.data?.status).toBe('UNSUPPORTED');

      const guiResult = await guiAdapter.infer(unsupportedInput);
      expect(guiResult.status).toBe('UNSUPPORTED');
    });
  });

  // ── 2. Workflow Planning Parity across 4 Interfaces ──────────────

  describe('2. Workflow Planning Parity across Direct, Orchestrator, REST, and GUI', () => {
    it('produces identical workflow plan and planHash across all 4 interfaces', async () => {
      const input: InferenceInput = {
        text: 'Generate DOCX formal assessment report',
      };
      const directInference = services.inference.infer(input);

      const taskRequirements = {
        capabilities: ['text', 'generate_docx'],
        extended: {
          schemaVersion: 1 as const,
          modalities: ['text'] as any,
          tools: {
            requiredTools: ['generate_docx', 'artifact_read', 'artifact_write', 'approval_request'],
          },
          allowDegradation: false,
        },
      };

      const planInput = {
        projectId: 'parity-proj-01',
        taskId: 'parity-task-01',
        runId: 'run-01',
        inference: directInference,
        taskRequirements,
        availableAgents: testFleet,
      };

      // 1. Direct ServiceContainer
      const directPlanOutcome = services.workflowPlanning.createPlan(planInput);
      expect(directPlanOutcome.success).toBe(true);
      if (!directPlanOutcome.success) return;
      const directPlan = directPlanOutcome.plan;

      // 2. Core Orchestrator wrapper
      const dummyTaskFile: any = {
        id: 'parity-task-01',
        taskId: 'parity-task-01',
        title: 'DOCX report task',
        description: 'Generate docx report',
        type: 'task',
        status: 'pending',
        priority: 'high',
        capabilities: ['text', 'generate_docx'],
        requirements: taskRequirements.extended,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      const orchPlanOutcome = planTaskWorkflow(
        dummyTaskFile,
        directInference,
        testFleet,
        'parity-proj-01',
        'run-01',
      );
      expect(orchPlanOutcome.success).toBe(true);
      if (!orchPlanOutcome.success) return;
      const orchPlan = orchPlanOutcome.plan;

      // 3. REST API Client
      const restPlanResponse = await client.createWorkflowPlan(planInput);
      expect(restPlanResponse.status).toBe(201);
      const restPlan = restPlanResponse.data!;

      // 4. GUI Adapter
      const guiPlan = await guiAdapter.createWorkflowPlan(planInput);
      expect(guiPlan).toBeDefined();

      // Parity assertions
      expect(orchPlan.planHash).toBe(directPlan.planHash);
      expect(restPlan.planHash).toBe(directPlan.planHash);
      expect(guiPlan.planHash).toBe(directPlan.planHash);

      expect(restPlan.steps.length).toBe(directPlan.steps.length);
      expect(guiPlan.steps.length).toBe(directPlan.steps.length);
      expect(orchPlan.steps.length).toBe(directPlan.steps.length);

      for (let i = 0; i < directPlan.steps.length; i++) {
        expect(restPlan.steps[i].stepType).toBe(directPlan.steps[i].stepType);
        expect(guiPlan.steps[i].stepType).toBe(directPlan.steps[i].stepType);
        expect(orchPlan.steps[i].stepType).toBe(directPlan.steps[i].stepType);
        expect(restPlan.steps[i].assignedAgent).toBe(directPlan.steps[i].assignedAgent);
      }
    });
  });

  // ── 3. Tool Execution Contract & Pre-Execution Parity ────────────

  describe('3. Tool Execution Contract & Pre-Execution Parity', () => {
    it('creates identical execution contracts and enforces fail-closed pre-execution evaluation', async () => {
      const input: InferenceInput = {
        text: 'Generate DOCX executive summary',
      };
      const directInference = services.inference.infer(input);

      const planOutcome = services.workflowPlanning.createPlan({
        projectId: 'parity-proj-01',
        taskId: 'parity-task-tool-01',
        runId: 'run-01',
        inference: directInference,
        taskRequirements: {
          capabilities: ['text', 'generate_docx'],
          extended: {
            schemaVersion: 1 as const,
            modalities: ['text'] as any,
            tools: {
              requiredTools: ['generate_docx', 'artifact_read', 'artifact_write', 'approval_request'],
            },
            allowDegradation: false,
          },
        },
        availableAgents: testFleet,
      });

      expect(planOutcome.success).toBe(true);
      if (!planOutcome.success) return;
      const plan = planOutcome.plan;

      const docxStep = plan.steps.find((s) => s.stepType === 'GENERATE_DOCX')!;
      expect(docxStep).toBeDefined();

      // 1. Direct ServiceContainer contract
      const directContract = services.toolApprovalPlanning.createContract(docxStep, plan);

      // 2. Core Orchestrator contract
      const orchContract = planStepToolExecution(docxStep, plan);

      // 3. REST Client contract
      const restContractRes = await client.createExecutionContract({ step: docxStep, plan });
      expect(restContractRes.status).toBe(201);
      const restContract = restContractRes.data!;

      // 4. GUI Adapter contract
      const guiContract = await guiAdapter.createExecutionContract({ step: docxStep, plan });
      expect(guiContract).toBeDefined();

      // Contract Parity assertions
      expect(orchContract.contractHash).toBe(directContract.contractHash);
      expect(restContract.contractHash).toBe(directContract.contractHash);
      expect(guiContract.contractHash).toBe(directContract.contractHash);
      expect(restContract.allowedTool).toBe('generate_docx');
      expect(guiContract.allowedTool).toBe('generate_docx');

      // Pre-Execution Evaluation Parity: Unapproved evaluation fails closed with MISSING_APPROVAL
      const executingAgent = testFleet.find((a) => a.id === directContract.authorizedAgent)!;
      const evalContext: ToolPreExecutionContext = {
        projectRoot: tmpDir,
        executingAgent,
        requestedTool: 'generate_docx',
        inputArgs: { template: 'standard.docx' },
        humanReviewSignOff: {
          reviewerId: 'reviewer-01',
          timestamp: new Date().toISOString(),
          verdict: 'APPROVED',
        },
      };

      // Direct Service
      const directEval = services.toolApprovalPlanning.evaluatePreExecution(directContract, evalContext);
      expect(directEval.success).toBe(false);
      expect(directEval.code).toBe('MISSING_APPROVAL');

      // Core Orchestrator
      const orchEval = verifyStepToolPreExecution(orchContract, evalContext);
      expect(orchEval.success).toBe(false);
      expect(orchEval.code).toBe('MISSING_APPROVAL');

      // REST Client
      const restEvalRes = await client.evaluateExecutionContract(restContract, evalContext);
      expect(restEvalRes.status).toBe(200);
      expect(restEvalRes.data?.success).toBe(false);
      expect(restEvalRes.data?.code).toBe('MISSING_APPROVAL');

      // GUI Adapter
      const guiEval = await guiAdapter.evaluateExecutionContract(guiContract, evalContext);
      expect(guiEval.success).toBe(false);
      expect(guiEval.code).toBe('MISSING_APPROVAL');
    });
  });

  // ── 4. Durable Idempotency Replay & Conflict Detection ───────────

  describe('4. Durable Idempotency Replay & Conflict Detection', () => {
    it('returns replay on identical idempotency key and conflict on modified payload', async () => {
      const idempotencyKey = `idem-plan-parity-${Date.now()}`;
      const input: InferenceInput = {
        text: 'Generate DOCX financial audit summary report',
      };
      const inference = services.inference.infer(input);

      const planPayload = {
        projectId: 'parity-proj-idem',
        taskId: 'parity-task-idem',
        runId: 'run-01',
        inference,
        taskRequirements: {
          capabilities: ['text', 'generate_docx'],
          extended: {
            schemaVersion: 1 as const,
            modalities: ['text'] as any,
            tools: {
              requiredTools: ['generate_docx', 'artifact_read', 'artifact_write', 'approval_request'],
            },
            allowDegradation: false,
          },
        },
        availableAgents: testFleet,
      };

      // 1. Initial Plan Creation via REST
      const firstRes = await client.createWorkflowPlan(planPayload, idempotencyKey);
      expect(firstRes.status).toBe(201);
      const originalPlan = firstRes.data!;

      // 2. Replay with identical payload and key
      const replayRes = await client.createWorkflowPlan(planPayload, idempotencyKey);
      expect(replayRes.status).toBe(201); // 201 Created replayed
      expect(replayRes.data?.planHash).toBe(originalPlan.planHash);

      // 3. Conflict: Different payload with same idempotency key
      const conflictingPayload = {
        ...planPayload,
        projectId: 'completely-different-project-id',
      };
      const conflictRes = await client.createWorkflowPlan(conflictingPayload, idempotencyKey);
      expect(conflictRes.status).toBe(409); // 409 Conflict
      expect(JSON.stringify(conflictRes.error)).toMatch(/conflict/i);
    });
  });

  // ── 5. Privacy-Safe Audit Trail ──────────────────────────────────

  describe('5. Privacy-Safe Audit Trail', () => {
    it('records structured audit events without leaking bearer tokens, secrets, or raw prose', async () => {
      const auditDir = path.join(tmpDir, '.maos', 'audit');
      if (!fs.existsSync(auditDir)) return;

      const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      let totalAuditRecords = 0;
      for (const file of files) {
        const content = fs.readFileSync(path.join(auditDir, file), 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);

        for (const line of lines) {
          totalAuditRecords++;
          const lower = line.toLowerCase();

          // Must never contain sensitive credential leaks
          expect(lower).not.toContain('bearer ');
          expect(lower).not.toContain('authorization:');
          expect(lower).not.toContain('secret_key');
          expect(lower).not.toContain('api_key');
          expect(lower).not.toContain('password');
          expect(lower).not.toContain('private_key');
        }
      }

      expect(totalAuditRecords).toBeGreaterThan(0);
    });
  });

  // ── 6. Canary Invariant ──────────────────────────────────────────

  describe('6. Protected Canary Invariant', () => {
    it('confirms rust/test.txt SHA-256 hash is unmodified', () => {
      const canaryPath = path.join('c:\\maos', 'rust', 'test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const EXPECTED_CANARY_SHA256 = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

      expect(hash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
