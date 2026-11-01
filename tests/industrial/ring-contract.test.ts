/**
 * TASK RING-CONTRACT-01: frozen contract test (PM-owned).
 *
 * Proves the frozen surface the three dev lanes build against:
 *  1. Thread contract shape: RingThread validates via
 *     validateRingThreadState; default role operator exists.
 *  2. Restart-reload: thread JSON under .maos/ring-runs/threads/ plus
 *     the per-run JSONL history is the system of record.
 *  3. Event union: the four streaming events validate; unknown types
 *     still fail closed; existing nine types still validate.
 *  4. Registry gate: consequential enforcement lives in the registry.
 *  5. Streaming hook: onStreamEvent receives mapped wire copies.
 *
 * Evidence-only; no live Baseten calls (no key is set in this file).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { AuditService } from '../../src/service/audit-service';
import { RingToolRegistry } from '../../src/service/ring-tool-registry';
import { DEFAULT_RING_ROLE, isRingRole, isRingThreadId } from '../../src/service/ring-contract';
import { validateRingRunState, validateRingThreadState, validateRingRunEvent } from '../../src/gui/src/api/ring-run-types';

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-contract-'));
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  const repoRoot = path.resolve(__dirname, '../..');
  for (const f of ['sop_turbine_vibration_monitoring.md', 'maintenance_report.txt', 'safety_thresholds.json', 'turbine_vibration_log.csv']) {
    fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(root, 'demo', 'industrial', f));
  }
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({ schemaVersion: 1, projectName: 'ring-contract-test', profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true } }));
  return root;
}

describe('TASK RING-CONTRACT-01: frozen contract', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { delete process.env.BASETEN_API_KEY; try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('thread shape validates; default role exists; unknown roles fail closed', () => {
    expect(DEFAULT_RING_ROLE).toBe('operator');
    expect(isRingRole('operator')).toBe(true);
    expect(isRingRole('maintenance')).toBe(true);
    expect(isRingRole('safety')).toBe(true);
    expect(isRingRole('manager')).toBe(true);
    expect(isRingRole('admin')).toBe(false);
    expect(isRingThreadId('thread-1730000000000-abcdef12')).toBe(true);
    expect(isRingThreadId('ring-1730000000000-abcdef12')).toBe(false);
    const thread = { threadId: 'thread-1730000000000-abcdef12', title: 'Turbine review', role: 'operator', createdAt: new Date().toISOString(), runs: ['ring-abc123'] };
    expect(validateRingThreadState(thread)).toEqual(thread);
    expect(() => validateRingThreadState({ ...thread, role: 'admin' })).toThrow('RING_RUN_INVALID');
    expect(() => validateRingThreadState({ ...thread, runs: 'ring-abc123' })).toThrow('RING_RUN_INVALID');
  });

  it('restart-reload: thread JSON plus JSONL history rebuild without in-memory state', async () => {
    delete process.env.BASETEN_API_KEY;
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const runId = service.startRun('Analyze turbine vibration telemetry and give the verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    const threadsDir = path.join(root, '.maos', 'ring-runs', 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    const thread = { threadId: 'thread-1730000000000-abcdef12', title: 'Turbine review', role: 'operator', createdAt: new Date().toISOString(), runs: [runId] };
    fs.writeFileSync(path.join(threadsDir, thread.threadId + '.json'), JSON.stringify(thread, null, 2));
    const reloadedThread = JSON.parse(fs.readFileSync(path.join(threadsDir, thread.threadId + '.json'), 'utf-8'));
    expect(validateRingThreadState(reloadedThread).runs).toEqual([runId]);
    const freshService = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const history = freshService.getTranscript(runId);
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((e) => e.type === 'run.started')).toBe(true);
    expect(history.some((e) => e.type === 'run.completed')).toBe(true);
  });

  it('event union: four streaming events validate; unknown types fail closed', () => {
    const ts = new Date().toISOString();
    const delta = validateRingRunEvent({ type: 'model.delta', ts, delta: 'Turbine ' });
    expect(delta.delta).toBe('Turbine ');
    const plan = validateRingRunEvent({ type: 'plan.updated', ts, plan: [{ step: 'Read SOP', status: 'done' }] });
    expect(plan.plan).toEqual([{ step: 'Read SOP', status: 'done' }]);
    const artifact = validateRingRunEvent({ type: 'artifact.created', ts, artifact: { path: 'a/b/note.md', kind: 'note', size: 42, sha256: 'abc' } });
    expect(artifact.artifact && artifact.artifact.size).toBe(42);
    const memory = validateRingRunEvent({ type: 'memory.saved', ts, memory: { noteId: 'n1', summary: 'T-07 critical' } });
    expect(memory.memory && memory.memory.noteId).toBe('n1');
    expect(() => validateRingRunEvent({ type: 'model.ghost', ts })).toThrow('RING_RUN_INVALID');
    expect(() => validateRingRunEvent({ type: 'plan.updated', ts, plan: [{ step: 'x', status: 'maybe' }] })).toThrow('RING_RUN_INVALID');
    const existing = ['run.started', 'model.turn', 'tool.call', 'tool.result', 'approval.pending', 'approval.resolved', 'run.completed', 'run.failed', 'run.cancelled'];
    for (const type of existing) {
      expect(validateRingRunEvent({ type, ts }).type).toBe(type);
    }
  });

  it('registry gate: consequential enforcement is registry-owned and fails closed', async () => {
    const registry = new RingToolRegistry();
    registry.register({ name: 'analyze_telemetry', description: 't', parameters: {}, consequential: false, execute: () => ({ ok: true }) });
    registry.register({ name: 'draft_safety_note', description: 't', parameters: {}, consequential: true, execute: () => ({ ok: true }) });
    registry.register({ name: 'request_approval', description: 't', parameters: {}, consequential: true, execute: () => ({ ok: true }) });
    expect(registry.isConsequential('analyze_telemetry')).toBe(false);
    expect(registry.isConsequential('draft_safety_note')).toBe(true);
    expect(registry.isConsequential('request_approval')).toBe(true);
    expect(registry.isConsequential('mystery_tool')).toBe(true);
    expect(() => registry.register({ name: 'analyze_telemetry', description: 'dup', parameters: {}, consequential: false, execute: () => ({ ok: true }) })).toThrow('RING_TOOL_DUPLICATE');
    const out = await registry.execute('analyze_telemetry', { projectRoot: root, evidenceRoot: root, runId: 'ring-x', runContext: {} }, {});
    expect(out.ok).toBe(true);
    const unknown = await registry.execute('mystery_tool', { projectRoot: root, evidenceRoot: root, runId: 'ring-x', runContext: {} }, {});
    expect(unknown.ok).toBe(false);
  });

  it('streaming hook: wire copies fan out without disturbing the run or JSONL', async () => {
    delete process.env.BASETEN_API_KEY;
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const seen: Array<{ runId: string; type: string }> = [];
    const off = service.onStreamEvent((runId, event) => { seen.push({ runId, type: event.type }); });
    const runId = service.startRun('Analyze turbine vibration telemetry and give the verdict');
    const snap = await service.waitForCompletion(runId);
    off();
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('evidence-only');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.runId === runId)).toBe(true);
    expect(seen.some((e) => e.type === 'run.started')).toBe(true);
    expect(seen.some((e) => e.type === 'run.completed')).toBe(true);
    expect(seen.some((e) => e.type === 'mode.evidence-only')).toBe(false);
    expect(validateRingRunState(snap as unknown).status).toBe('completed');
    const jsonl = fs.readFileSync(path.join(root, '.maos', 'ring-runs', runId + '.jsonl'), 'utf-8');
    expect(jsonl.includes('run.started')).toBe(true);
  });
});
