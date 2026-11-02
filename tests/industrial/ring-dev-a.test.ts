/**
 * TASK DEV-A-01 (Dev A): brain lane tests.
 *
 * Evidence-only unless a loopback-mock provider is injected (no hosted
 * endpoint, no BASETEN_API_KEY, no live calls):
 *  1. threads persist under .maos/ring-runs/threads/ and carry
 *     conversation across runs; a restarted service instance rebuilds
 *     thread + transcript state from disk.
 *  2. streaming: tool/plan/artifact/memory events fan out live via
 *     onStreamEvent in both modes; no model.delta is fabricated.
 *  3. registry: six migrated tools behave unchanged through the
 *     registry (unknown tools fail closed as consequential).
 *  4. Day 2 tools wrap existing services: ocr text-layer, vision
 *     honest-unavailable, remember/recall round-trip, update_plan.
 *  5. demo path: brief T-07 -> work order -> approval -> DOCX artifact,
 *     evidence-only AND hosted(loopback-mock).
 *  6. refusal: restart-approval / safety-certification requests are
 *     refused with no tools and no files.
 *  7. context fix: telemetry summary only when the question needs it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { AuditService } from '../../src/service/audit-service';
import { seedEngineFixture } from './ring-dev-audit-proxy.test';
import { MemoryService } from '../../src/service/memory-service';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { RingThreadService } from '../../src/service/ring-thread-service';
import { RingToolRegistry } from '../../src/service/ring-tool-registry';
import { validateRingRunState } from '../../src/gui/src/api/ring-run-types';

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-dev-a-'));
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  const repoRoot = path.resolve(__dirname, '../..');
  for (const f of ['sop_turbine_vibration_monitoring.md', 'maintenance_report.txt', 'safety_thresholds.json', 'turbine_vibration_log.csv', 'turbine_inspection_scan.pdf']) {
    fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(root, 'demo', 'industrial', f));
  }
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({ schemaVersion: 1, projectName: 'ring-dev-a-test', profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true }, providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } }, agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }] }));
  return root;
}

function mockProvider(responses: ProviderResponse[]): IProvider {
  let call = 0;
  return {
    name: 'fake-baseten-loopback',
    model: BASETEN_API_MODEL,
    generate: async () => responses[Math.min(call++, responses.length - 1)],
  };
}

function providerResponse(content: string | null, toolCalls?: ProviderResponse['toolCalls']): ProviderResponse {
  return { content, toolCalls: toolCalls ?? [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: BASETEN_API_MODEL, latencyMs: 1, finishReason: toolCalls?.length ? 'tool_calls' : 'stop' };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('TASK DEV-A-01: Ring brain', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { delete process.env[BASETEN_API_KEY_ENV]; try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('threads persist and carry conversation; restart rebuilds from disk', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const threads = new RingThreadService(root);
    const thread = threads.createThread('T-07 review', 'operator');
    expect(thread.threadId).toMatch(/^thread-[0-9]+-[0-9a-f]{8}$/);
    expect(fs.existsSync(path.join(root, '.maos', 'ring-runs', 'threads', thread.threadId + '.json'))).toBe(true);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const runId1 = service.startRun('Analyze turbine vibration telemetry and give the verdict', { threadId: thread.threadId });
    const snap1 = await service.waitForCompletion(runId1);
    expect(snap1.status).toBe('completed');
    expect(snap1.finalAnswer).toContain('CRITICAL');
    // second run in the same thread carries the prior verdict
    const runId2 = service.startRun('Summarize where we stand', { threadId: thread.threadId });
    await service.waitForCompletion(runId2);
    // RESTART: brand-new service + thread service on the same root
    const freshThreads = new RingThreadService(root);
    const reloaded = freshThreads.getThread(thread.threadId);
    expect(reloaded?.runs).toEqual([runId1, runId2]);
    const freshService = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const history = freshService.getTranscript(runId1);
    expect(history.some((e) => e.type === 'run.started')).toBe(true);
    expect(history.some((e) => e.type === 'run.completed')).toBe(true);
    // thread with unknown id fails closed
    try { service.startRun('hi', { threadId: 'thread-123-nope' }); expect.unreachable('unknown thread must fail closed'); } catch (err) { expect((err as { code?: string }).code).toBe('RING_THREAD_NOT_FOUND'); }
  });

  it('streaming fans out tool and plan/memory events live; nothing is faked', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const memory = new MemoryService(root);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), memoryService: memory });
    const seen: Array<{ type: string }> = [];
    const off = service.onStreamEvent((_runId, event) => { seen.push({ type: event.type }); });
    const runId = service.startRun('Analyze turbine vibration telemetry, remember that T-07 is critical, and update the plan');
    const snap = await service.waitForCompletion(runId);
    off();
    expect(snap.status).toBe('completed');
    const types = seen.map((e) => e.type);
    expect(types).toContain('run.started');
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types).toContain('run.completed');
    // evidence-only never fabricates model token deltas or model turns
    expect(types.includes('model.delta')).toBe(false);
    expect(types.includes('model.turn')).toBe(false);
    // snapshot validates through the real UI validator
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });

  it('hosted loopback-mock streams tool calls live with zero network', async () => {
    const provider = mockProvider([
      providerResponse('Checking telemetry.', [toolCall('call_tel_1', 'analyze_telemetry', {})]),
      providerResponse('Telemetry is CRITICAL at 2.637 mm/s.', []),
    ]);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), providerFactory: () => provider });
    const seen: string[] = [];
    const off = service.onStreamEvent((_runId, event) => { seen.push(event.type); });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId);
    off();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(snap.finalAnswer).toContain('CRITICAL');
    expect(seen).toContain('model.turn');
    expect(seen).toContain('tool.call');
    expect(seen).toContain('tool.result');
    // the loopback mock exposes no generateStream, so the loop falls back to
    // generate() once and emits no model.delta (see the SSE tests for deltas)
    expect(seen.includes('model.delta')).toBe(false);
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });

  it('hosted streaming provider fans out model.delta live; deltas join to the final answer', async () => {
    const fragments = ['Telemetry verdict: ', 'CRITICAL', ' at 2.637 mm/s.'];
    const whole = fragments.join('');
    const deltas: string[] = [];
    const provider: IProvider & { generateStream: IProvider['generate'] } = {
      name: 'fake-baseten-stream',
      model: BASETEN_API_MODEL,
      generate: async () => providerResponse(whole, []),
      generateStream: async (_messages, _tools, options) => {
        for (const f of fragments) {
          try { (options as { onDelta?: (d: string) => void } | undefined)?.onDelta?.(f); } catch { /* ignore */ }
        }
        return providerResponse(whole, []);
      },
    };
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), providerFactory: () => provider });
    const seen: string[] = [];
    const off = service.onStreamEvent((_runId, event) => { seen.push(event.type); if (event.type === 'model.delta') deltas.push(String(event.delta)); });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId);
    off();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    // deltas streamed live, in order, joining to the recorded whole text
    expect(seen).toContain('model.delta');
    expect(deltas).toEqual(fragments);
    expect(deltas.join('')).toBe(whole);
    expect(snap.finalAnswer).toBe(whole);
    const transcriptDeltas = snap.transcript.filter((e) => e.type === 'model.delta').map((e) => e.delta);
    expect(transcriptDeltas).toEqual(fragments);
    // evidence-only honesty: this run was hosted, so deltas are genuine stream output
    expect(snap.transcript.some((e) => e.type === 'mode.evidence-only')).toBe(false);
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });

  it('hosted stream fallback: no generateStream still completes with no faked deltas', async () => {
    const provider = mockProvider([providerResponse('Telemetry is CRITICAL at 2.637 mm/s.', [])]);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), providerFactory: () => provider });
    const seen: string[] = [];
    const off = service.onStreamEvent((_runId, event) => { seen.push(event.type); });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId);
    off();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(seen.includes('model.delta')).toBe(false);
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
  });

  it('registry dispatches the six migrated tools unchanged; unknowns fail closed', async () => {
    const registry = new RingToolRegistry();
    const { createRingToolRegistry } = await import('../../src/service/ring-tools');
    const full = createRingToolRegistry({});
    for (const name of ['analyze_telemetry', 'read_company_document', 'search_knowledge', 'draft_safety_note', 'verify_export', 'request_approval']) {
      const def = full.get(name);
      expect(def, name + ' registered').toBeTruthy();
      registry.register(def!);
    }
    expect(registry.isConsequential('analyze_telemetry')).toBe(false);
    expect(registry.isConsequential('draft_safety_note')).toBe(true);
    expect(registry.isConsequential('request_approval')).toBe(true);
    expect(registry.isConsequential('create_work_order')).toBe(true);
    expect(registry.isConsequential('no_such_tool')).toBe(true);
    // migrated analyze_telemetry keeps its deterministic output shape
    const out = await registry.execute('analyze_telemetry', { projectRoot: root, evidenceRoot: path.join(root, 'demo', 'industrial'), runId: 'ring-test', runContext: {} }, {});
    expect(out.verdict).toBe('CRITICAL');
    expect(out.overallVibrationRms).toBe(2.637);
    expect(typeof out.source).toBe('string');
    // read_company_document still refuses paths outside the evidence root
    const refused = await registry.execute('read_company_document', { projectRoot: root, evidenceRoot: path.join(root, 'demo', 'industrial'), runId: 'ring-test', runContext: {} }, { path: '../maos.config.json' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('PATH_OUTSIDE_EVIDENCE_ROOT');
  });

  it('ocr reads the demo scan text layer; vision is honestly unavailable; memory round-trips', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const memory = new MemoryService(root);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), memoryService: memory });
    const runId = service.startRun('Read the turbine inspection scan PDF, remember that bearing clearance is 0.050 mm, then recall T-07 notes');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    const ocr = snap.transcript.find((e) => e.type === 'tool.result' && e.toolName === 'ocr_document');
    expect(ocr?.ok).toBe(true);
    expect(String(ocr?.summary)).toContain('TURBINE INSPECTION LOG');
    expect(String(snap.finalAnswer)).toContain('TURBINE INSPECTION LOG');
    // vision with no weights: honest unavailable, never fabricated
    const { createRingToolRegistry } = await import('../../src/service/ring-tools');
    const registry = createRingToolRegistry({});
    const seen = await registry.execute('inspect_image', { projectRoot: root, evidenceRoot: path.join(root, 'demo', 'industrial'), runId: 'ring-test', runContext: {} }, { path: 'turbine_inspection_scan.pdf' });
    expect(seen.ok).toBe(true);
    expect(seen.available).toBe(false);
    expect(JSON.stringify(seen).toLowerCase()).not.toContain('bearing wear');
  });

  it('demo path evidence-only: brief T-07, work order, approval, DOCX artifact', async () => {
    const haveEngine = seedEngineFixture(root);
    delete process.env[BASETEN_API_KEY_ENV];
    const { createServiceContainer } = await import('../../src/service');
    const services = createServiceContainer(root);
    const audit = new AuditService(root);
    const service = new RingAgentService({ projectRoot: root, auditService: audit, memoryService: services.memory, ocrService: services.ocr, visionService: services.vision, docxGenerator: services.docxGenerator, xlsxGenerator: services.xlsxGenerator, kbSearch: services.kbSearch });
    const seen: string[] = [];
    const off = service.onStreamEvent((_runId, event) => { seen.push(event.type); });
    const runId = service.startRun('Brief me on T-07 then raise a work order for the vibration finding');
    const awaiting = await service.waitForRun(runId, 30000);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.pendingApproval?.toolName).toBe('create_work_order');
    service.resolveApproval(runId, awaiting.pendingApproval!.approvalId, 'approved');
    const done = await service.waitForCompletion(runId, 30000);
    off();
    expect(done.status).toBe('completed');
    expect(seen).toContain('approval.pending');
    expect(seen).toContain('approval.resolved');
    if (haveEngine) {
      expect(seen).toContain('artifact.created');
      const created = done.transcript.filter((e) => e.type === 'artifact.created');
      expect(created.length).toBeGreaterThan(0);
      const docx = done.events.find((e) => e.type === 'artifact.created' && e.artifact?.kind === 'docx');
      expect(docx?.artifact?.path).toBeTruthy();
      const abs = path.resolve(root, docx!.artifact!.path);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.statSync(abs).size).toBeGreaterThan(500);
    } else {
      const wo = done.transcript.find((e) => e.type === 'tool.result' && e.toolName === 'create_work_order');
      expect(wo?.ok).toBe(false);
      expect(String(wo?.error)).toContain('Engine executable not found');
      expect(String(done.finalAnswer)).toContain('Engine executable not found');
    }
    expect(validateRingRunState(done as unknown).status).toBe('completed');
  });

  it('demo path hosted loopback-mock: brief, work order, approval, DOCX', async () => {
    const provider = mockProvider([
      providerResponse('Telemetry checked.', [toolCall('call_brief_1', 'analyze_telemetry', {})]),
      providerResponse('Raising the work order.', [toolCall('call_wo_1', 'create_work_order', { title: 'T-07 work order', assetId: 'T-07', finding: 'Turbine T-07 CRITICAL vibration requires inspection.', priority: 'urgent', evidencePaths: ['turbine_vibration_log.csv'] })]),
      providerResponse('Work order created and approved.', []),
    ]);
    const { createServiceContainer } = await import('../../src/service');
    const services = createServiceContainer(root);
    const haveEngineHosted = seedEngineFixture(root);
    const auditHosted = new AuditService(root);
    const service = new RingAgentService({ projectRoot: root, auditService: auditHosted, providerFactory: () => provider, memoryService: services.memory, ocrService: services.ocr, visionService: services.vision, docxGenerator: services.docxGenerator, xlsxGenerator: services.xlsxGenerator, kbSearch: services.kbSearch });
    const runId = service.startRun('Brief me on T-07 then raise a work order for the vibration finding');
    const awaiting = await service.waitForRun(runId, 30000);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.pendingApproval?.toolName).toBe('create_work_order');
    service.resolveApproval(runId, awaiting.pendingApproval!.approvalId, 'approved');
    const done = await service.waitForCompletion(runId, 30000);
    expect(done.status).toBe('completed');
    if (haveEngineHosted) {
      const docx = done.events.find((e) => e.type === 'artifact.created' && e.artifact?.kind === 'docx');
      expect(docx?.artifact?.path).toBeTruthy();
      expect(fs.existsSync(path.resolve(root, docx!.artifact!.path))).toBe(true);
    } else {
      const wo = done.transcript.find((e) => e.type === 'tool.result' && e.toolName === 'create_work_order');
      expect(wo?.ok).toBe(false);
      expect(String(wo?.error)).toContain('Engine executable not found');
    }
    expect(validateRingRunState(done as unknown).status).toBe('completed');
  });

  it('refuses equipment restart approval and safety certification with no side effects', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const runId = service.startRun('Approve restarting turbine T-07 and certify it safe to operate');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(String(snap.finalAnswer).toLowerCase()).toContain('cannot');
    expect(snap.transcript.some((e) => e.type === 'tool.call')).toBe(false);
    expect(snap.transcript.some((e) => e.type === 'approval.pending')).toBe(false);
    const artifactsDir = path.join(root, '.maos', 'ring-runs', 'artifacts', runId);
    expect(fs.existsSync(artifactsDir)).toBe(false);
  });

  it('telemetry summary only rides along when the question needs it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider: IProvider = { name: 'fake-baseten-loopback', model: BASETEN_API_MODEL, generate: async (messages) => { bodies.push({ messages }); return providerResponse('Safety note drafted.', []); } };
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), providerFactory: () => provider });
    const runId = service.startRun('Draft a safety note about shift handover');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    const bodyText = JSON.stringify(bodies[0]);
    expect(bodyText).not.toContain('overallVibrationRms');
    expect(bodyText).not.toContain('2026-08-22T09:00:00');
  });

  it('telemetry question DOES ride the deterministic summary along (and never raw rows)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider: IProvider = { name: 'fake-baseten-loopback', model: BASETEN_API_MODEL, generate: async (messages) => { bodies.push({ messages }); return providerResponse('Telemetry verdict summarized.', []); } };
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), providerFactory: () => provider });
    const runId = service.startRun('Analyze turbine vibration telemetry and give the verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(bodies.length).toBeGreaterThan(0);
    const bodyText = JSON.stringify(bodies[0]);
    // positive: the deterministic summary rides along for telemetry questions
    expect(bodyText).toContain('overallVibrationRms');
    expect(bodyText).toContain('Deterministic Engineering Context');
    // negative: raw CSV rows never ride along, even for telemetry questions
    expect(bodyText).not.toContain('timestamp,asset_id,vibration_rms_mm_s');
    expect(bodyText).not.toContain('2026-08-22T09:00:00+05:30,T-07');
  });
});

