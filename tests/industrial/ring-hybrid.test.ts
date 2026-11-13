/**
 * TASK HYBRID-ROUTER-01: hosted hybrid router tests.
 *
 * Decided hybrid (consequence of the live reliability result): in HOSTED
 * mode, bookkeeping (remember/recall/update_plan) is executed by the SERVER
 * first (deterministic skill chain, same registry-direct code as the
 * evidence-only path) and the model writes prose over established facts and
 * proposes - never performs - the consequential step. Evidence tools
 * (analyze_telemetry, read_company_document, search_knowledge, verify_export,
 * ocr_document) stay fully model-driven.
 *
 * Evidence-only/mocks only: hosted runs use an injected loopback-mock
 * provider (no hosted endpoint, no BASETEN_API_KEY, zero live calls).
 * BASETEN_API_KEY is deleted in beforeEach/afterEach and asserted unset.
 *
 * Routing rule under test (exact; see classifyHybridPrefetch in
 * src/service/ring-agent-service.ts): bookkeeping prefetch iff the
 * instruction matches the recall/remember/plan regexes; the evidence path
 * (fully model-driven) covers everything else, including handover /
 * work-order / draft asks (consequential evidence tools the model
 * demonstrably calls).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { AuditService } from '../../src/service/audit-service';
import { MemoryService } from '../../src/service/memory-service';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { validateRingRunState } from '../../src/gui/src/api/ring-run-types';

function makeTempRoot(): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-hybrid-'));
  const root = (() => {
    try {
      return fs.realpathSync(raw);
    } catch {
      return raw;
    }
  })();
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  const repoRoot = path.resolve(__dirname, '../..');
  for (const f of [
    'sop_turbine_vibration_monitoring.md',
    'maintenance_report.txt',
    'safety_thresholds.json',
    'turbine_vibration_log.csv',
    'turbine_inspection_scan.pdf',
  ]) {
    fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(root, 'demo', 'industrial', f));
  }
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'ring-hybrid-test',
      profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
      providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
      agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }],
    }),
  );
  return root;
}

function providerResponse(content: string | null, toolCalls?: ProviderResponse['toolCalls']): ProviderResponse {
  return {
    content,
    toolCalls: toolCalls ?? [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: BASETEN_API_MODEL,
    latencyMs: 1,
    finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

function expectKeyUnset(): void {
  expect(
    process.env[BASETEN_API_KEY_ENV],
    'BASETEN_API_KEY must stay unset (evidence-only/mocks only)',
  ).toBeUndefined();
}

describe('TASK HYBRID-ROUTER-01: hosted hybrid router', () => {
  let root: string;
  beforeEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    root = makeTempRoot();
  });
  afterEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('(a) bookkeeping instruction in hosted-mock mode: server pre-runs skills, model writes prose, model makes ZERO remember/update_plan calls', async () => {
    expectKeyUnset();
    const offeredToolNames: string[][] = [];
    const provider: IProvider = {
      name: 'fake-baseten-loopback',
      model: BASETEN_API_MODEL,
      generate: async (_messages, tools) => {
        offeredToolNames.push((tools || []).map((t) => t.function.name));
        return providerResponse(
          'T-07 status: CRITICAL vibration per the established prefetch facts. The plan now tracks review of T-07. Proposed next step (not performed; needs human approval): raise a work order for the vibration finding.',
        );
      },
    };
    const memory = new MemoryService(root);
    const service = new RingAgentService({
      projectRoot: root,
      auditService: new AuditService(root),
      providerFactory: () => provider,
      memoryService: memory,
    });
    const runId = service.startRun('Remember that T-07 vibration is CRITICAL and update the plan with next steps');
    const snap = await service.waitForCompletion(runId);
    expectKeyUnset();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(String(snap.finalAnswer)).toContain('CRITICAL');
    expect(String(snap.finalAnswer)).toContain('Proposed next step');
    const rememberResults = snap.transcript.filter((e) => e.type === 'tool.result' && e.toolName === 'remember');
    const planResults = snap.transcript.filter((e) => e.type === 'tool.result' && e.toolName === 'update_plan');
    expect(rememberResults.length).toBe(1);
    expect(rememberResults[0].ok).toBe(true);
    expect(planResults.length).toBe(1);
    expect(planResults[0].ok).toBe(true);
    expect(snap.transcript.some((e) => e.type === 'plan.updated')).toBe(true);
    expect(snap.transcript.some((e) => e.type === 'memory.saved')).toBe(true);
    const prefetch = snap.transcript.filter((e) => e.type === 'skill.prefetch');
    expect(prefetch.length).toBe(1);
    expect(prefetch[0].skills).toEqual(['remember', 'update_plan']);
    const modelToolCalls = snap.transcript
      .filter((e) => e.type === 'model.turn')
      .flatMap((e) => (Array.isArray(e.toolCalls) ? (e.toolCalls as unknown[]) : []));
    expect(modelToolCalls).toEqual([]);
    expect(offeredToolNames.length).toBeGreaterThan(0);
    for (const offered of offeredToolNames) {
      expect(offered).not.toContain('remember');
      expect(offered).not.toContain('recall');
      expect(offered).not.toContain('update_plan');
      expect(offered).toContain('analyze_telemetry');
    }
    expect(memory.search('T-07').length).toBeGreaterThan(0);
    const validated = validateRingRunState(snap as unknown);
    expect(validated.status).toBe('completed');
    const wirePrefetch = validated.events.filter((e) => e.type === 'skill.prefetch');
    expect(wirePrefetch.length).toBe(1);
    expect(wirePrefetch[0].skills).toEqual(['remember', 'update_plan']);
  });

  it('(b) evidence instruction stays fully model-driven (analyze_telemetry via model tool call, no prefetch)', async () => {
    expectKeyUnset();
    let call = 0;
    const provider: IProvider = {
      name: 'fake-baseten-loopback',
      model: BASETEN_API_MODEL,
      generate: async () => {
        call++;
        if (call === 1)
          return providerResponse('Checking telemetry.', [toolCall('call_tel_1', 'analyze_telemetry', {})]);
        return providerResponse('Turbine T-07 is CRITICAL: RMS 2.637 mm/s from the deterministic telemetry tool.');
      },
    };
    const service = new RingAgentService({
      projectRoot: root,
      auditService: new AuditService(root),
      providerFactory: () => provider,
    });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId);
    expectKeyUnset();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(String(snap.finalAnswer)).toContain('CRITICAL');
    expect(snap.transcript.some((e) => e.type === 'skill.prefetch')).toBe(false);
    const modelToolCalls = snap.transcript
      .filter((e) => e.type === 'model.turn')
      .flatMap((e) => (Array.isArray(e.toolCalls) ? (e.toolCalls as string[]) : []));
    expect(modelToolCalls).toContain('analyze_telemetry');
    const telCalls = snap.transcript.filter((e) => e.type === 'tool.call' && e.toolName === 'analyze_telemetry');
    expect(telCalls.some((e) => e.toolCallId === 'call_tel_1')).toBe(true);
    const telResults = snap.transcript.filter((e) => e.type === 'tool.result' && e.toolName === 'analyze_telemetry');
    expect(telResults.length).toBe(1);
    expect(telResults[0].ok).toBe(true);
    expect(String(telResults[0].summary)).toContain('CRITICAL');
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });

  it('(c) evidence-only unchanged: no key, no prefetch, deterministic answer', async () => {
    expectKeyUnset();
    const memory = new MemoryService(root);
    const service = new RingAgentService({
      projectRoot: root,
      auditService: new AuditService(root),
      memoryService: memory,
    });
    const runId = service.startRun(
      'Analyze turbine vibration telemetry, remember that T-07 is critical, and update the plan',
    );
    const snap = await service.waitForCompletion(runId);
    expectKeyUnset();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('evidence-only');
    expect(String(snap.finalAnswer)).toContain('CRITICAL');
    expect(String(snap.finalAnswer)).toContain('2.637');
    expect(String(snap.finalAnswer)).toContain('evidence-only');
    expect(snap.transcript.some((e) => e.type === 'skill.prefetch')).toBe(false);
    expect(snap.transcript.some((e) => e.type === 'mode.evidence-only')).toBe(true);
    expect(
      snap.transcript.some((e) => e.type === 'tool.result' && e.toolName === 'analyze_telemetry' && e.ok === true),
    ).toBe(true);
    expect(snap.transcript.some((e) => e.type === 'tool.result' && e.toolName === 'remember' && e.ok === true)).toBe(
      true,
    );
    expect(snap.transcript.some((e) => e.type === 'tool.result' && e.toolName === 'update_plan' && e.ok === true)).toBe(
      true,
    );
    expect(snap.transcript.some((e) => e.type === 'model.turn')).toBe(false);
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });
});
