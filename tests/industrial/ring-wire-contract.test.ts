/**
 * TASK RING-ADAPTER-01: wire-contract regression test (C1/C2/C9).
 *
 * Takes REAL service snapshots (hosted + evidence-only, with tool calls and
 * an approval) and runs them through the UI's actual validator
 * (validateRingRunState from src/gui/src/api/ring-run-types.ts). Before the
 * adapter this threw RING_RUN_INVALID on every real poll:
 *  - C1: snapshot had `transcript`, not `events`
 *  - C2: `mode.evidence-only` is not a UI event type
 *  - C9: wire `argsSummary` was an object, the validator requires a string
 * The JSONL transcript on disk must stay untouched (object argsSummary +
 * mode marker); only the snapshot wire projection is mapped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { AuditService } from '../../src/service/audit-service';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { validateRingRunState } from '../../src/gui/src/api/ring-run-types';

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

function makeTempProjectRoot(): string {
  const tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-wire-'));
  const repoRoot = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(tempProjectRoot, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(tempProjectRoot, 'demo', 'industrial'), { recursive: true });
  for (const f of ['sop_turbine_vibration_monitoring.md', 'maintenance_report.txt', 'safety_thresholds.json', 'turbine_vibration_log.csv']) {
    fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(tempProjectRoot, 'demo', 'industrial', f));
  }
  fs.writeFileSync(
    path.join(tempProjectRoot, '.maos', 'maos.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'ring-wire-test',
      profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
      providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
      agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }],
    }),
  );
  return tempProjectRoot;
}

describe('TASK RING-ADAPTER-01: Ring wire contract (service snapshot -> UI validator)', () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = makeTempProjectRoot();
  });

  afterEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    try { fs.rmSync(tempProjectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('hosted: real snapshot with tool call + approval validates and carries mapped fields', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-wire-key';
    const noteArgs = { title: 'Vibration Alert', content: 'Turbine T-07 CRITICAL vibration requires inspection.', filename: 'safety-note.md' };
    const responses: ProviderResponse[] = [
      providerResponse('Checking the deterministic telemetry evidence.', [toolCall('call_telemetry_1', 'analyze_telemetry', {})]),
      // Consequential draft -> the run pauses for approval (A4/C11 path).
      // (Non-empty turn text: the service records tool-only turns with an
      // empty contentSummary, which the mapper drops so the UI invents nothing.)
      providerResponse('Telemetry checked; requesting approval to draft the note.', [toolCall('call_draft_1', 'draft_safety_note', noteArgs)]),
      providerResponse('Safety note drafted after approval.'),
    ];
    let call = 0;
    const providerFactory = (): IProvider => ({
      name: 'fake-baseten',
      generate: async () => responses[Math.min(call++, responses.length - 1)],
    });
    const service = new RingAgentService({ projectRoot: tempProjectRoot, auditService: new AuditService(tempProjectRoot), providerFactory });
    const runId = service.startRun('Draft a safety note about turbine vibration', { agentId: 'ANALYST_AGENT' });
    const awaiting = await service.waitForRun(runId);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.mode).toBe('hosted');
    expect(awaiting.pendingApproval?.toolName).toBe('draft_safety_note');

    // The validator must accept the REAL snapshot (C1: events present).
    const pendingState = validateRingRunState(awaiting as unknown);
    expect(pendingState.status).toBe('awaiting_approval');
    expect(pendingState.mode).toBe('hosted');

    // A1: mode.evidence-only (or any unknown type) never reaches the wire.
    expect(pendingState.events.some((e) => (e.type as string) === 'mode.evidence-only')).toBe(false);
    expect(pendingState.events.length).toBeGreaterThan(0);

    // A2/C7: model.turn carries text (never contentSummary) when non-empty.
    const turns = pendingState.events.filter((e) => e.type === 'model.turn');
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((e) => typeof e.text === 'string' && e.text.length > 0)).toBe(true);

    // A2/C8/C10 + C9: tool.call/result rename tool/toolCallId; argsSummary is
    // a string; tool.result carries resultSummary + structured fields.
    const toolCalls = pendingState.events.filter((e) => e.type === 'tool.call');
    const toolResults = pendingState.events.filter((e) => e.type === 'tool.result');
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);
    for (const e of [...toolCalls, ...toolResults]) {
      expect(typeof e.tool).toBe('string');
      expect(typeof e.toolCallId).toBe('string');
      expect(typeof e.argsSummary === 'string' || e.argsSummary === undefined).toBe(true);
    }
    const telemetry = toolResults.find((e) => e.tool === 'analyze_telemetry');
    expect(telemetry, 'analyze_telemetry tool.result present').toBeTruthy();
    expect(telemetry!.toolCallId).toBe('call_telemetry_1');
    expect(typeof telemetry!.resultSummary).toBe('string');
    expect(telemetry!.resultSummary).toContain('CRITICAL');
    expect(typeof telemetry!.verdict).toBe('string');
    expect(typeof telemetry!.overallRms).toBe('number');
    expect(Array.isArray(telemetry!.sources)).toBe(true);
    expect(telemetry!.sources!.length).toBeGreaterThan(0);

    // A5: call and result pair by toolCallId.
    for (const c of toolCalls) {
      const match = toolResults.find((r) => r.toolCallId === c.toolCallId);
      expect(match, `tool.result pairs with tool.call ${c.toolCallId}`).toBeTruthy();
    }

    // A4: the approval card would show a non-empty action (was summary).
    const pending = pendingState.events.find((e) => e.type === 'approval.pending');
    expect(pending?.approvalId).toBe(awaiting.pendingApproval!.approvalId);
    expect(typeof pending?.action).toBe('string');
    expect(pending?.action).toBeTruthy();
    expect(pending?.action).toContain('Vibration Alert');
    expect(typeof pending?.reason).toBe('string');

    // A6: requested agent id is metadata on run.started; the lead executes.
    const startedEntry = awaiting.transcript.find((e) => e.type === 'run.started');
    expect(startedEntry?.agentId).toBe('ANALYST_AGENT');
    expect(startedEntry?.requestedAgentId).toBe('ANALYST_AGENT');

    service.resolveApproval(runId, awaiting.pendingApproval!.approvalId, 'approved');
    const done = await service.waitForCompletion(runId);
    expect(done.status).toBe('completed');
    const doneState = validateRingRunState(done as unknown);
    expect(doneState.events.some((e) => e.type === 'approval.resolved' && e.decision === 'approved')).toBe(true);
    expect(typeof doneState.finalAnswer).toBe('string');
    expect(fs.readdirSync(path.join(tempProjectRoot, '.maos', 'ring-runs', 'drafts'))).toHaveLength(1);

    // JSONL stays the untouched system of record: object argsSummary and the
    // approval summary live on disk; the wire projection is snapshot-time only.
    const jsonl = fs.readFileSync(path.join(tempProjectRoot, '.maos', 'ring-runs', `${runId}.jsonl`), 'utf-8');
    expect(jsonl).toContain('"type":"run.started"');
    expect(jsonl).toContain('"approvalId"');
  });

  it('evidence-only: real snapshot validates with zero model turns and no mode marker on the wire', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const service = new RingAgentService({ projectRoot: tempProjectRoot, auditService: new AuditService(tempProjectRoot) });
    const runId = service.startRun('Analyze turbine vibration telemetry and give the verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('evidence-only');

    // C2: the transcript keeps the mode marker, the wire must not.
    expect(snap.transcript.some((e) => e.type === 'mode.evidence-only')).toBe(true);
    const state = validateRingRunState(snap as unknown);
    expect(state.mode).toBe('evidence-only');
    expect(state.events.some((e) => (e.type as string) === 'mode.evidence-only')).toBe(false);
    // Honesty: zero model.turn events in evidence-only (validator accepts,
    // the UI renders none).
    expect(state.events.some((e) => e.type === 'model.turn')).toBe(false);

    const telemetry = state.events.find((e) => e.type === 'tool.result' && e.tool === 'analyze_telemetry');
    expect(telemetry, 'analyze_telemetry tool.result present').toBeTruthy();
    expect(typeof telemetry.resultSummary).toBe('string');
    expect(typeof telemetry.verdict).toBe('string');
    expect(typeof telemetry.overallRms).toBe('number');
    expect(Array.isArray(telemetry.sources)).toBe(true);
    expect(typeof state.finalAnswer).toBe('string');
    expect(state.finalAnswer).toContain('evidence-only');
  });
});
