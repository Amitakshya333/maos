import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AddressInfo } from 'net';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { seedEngineFixture } from './ring-dev-audit-proxy.test';
import { validateRingRunState } from '../../src/gui/src/api/ring-run-types';
import { AuditService } from '../../src/service/audit-service';

describe('TASK RING-AGENT-LOOP-01: Ring Agent Service', () => {
  let tempProjectRoot: string;
  let mockServer: http.Server | null = null;
  let mockServerPort = 0;
  let capturedRequests: Array<{ url: string; body: any }> = [];
  let restoreFetch: (() => void) | null = null;

  const completion = (content: string | null, toolCalls?: any[], finishReason = 'stop') => ({
    id: 'chatcmpl-ring-agent',
    object: 'chat.completion',
    created: 1730000000,
    model: BASETEN_API_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls ? 'tool_calls' : finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });

  beforeEach(() => {
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-agent-test-'));
    try {
      tempProjectRoot = fs.realpathSync(raw);
    } catch {
      tempProjectRoot = raw;
    }
    const repoRoot = path.resolve(__dirname, '../..');
    fs.mkdirSync(path.join(tempProjectRoot, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(tempProjectRoot, 'demo', 'industrial'), { recursive: true });
    for (const f of [
      'sop_turbine_vibration_monitoring.md',
      'maintenance_report.txt',
      'safety_thresholds.json',
      'turbine_vibration_log.csv',
    ]) {
      fs.copyFileSync(
        path.join(repoRoot, 'demo', 'industrial', f),
        path.join(tempProjectRoot, 'demo', 'industrial', f),
      );
    }
    fs.writeFileSync(
      path.join(tempProjectRoot, '.maos', 'maos.config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'ring-agent-test',
          profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
          providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
          agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }],
        },
        null,
        2,
      ),
    );
    capturedRequests = [];
  });

  afterEach(async () => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    if (mockServer) {
      await new Promise<void>((r) => mockServer!.close(() => r()));
      mockServer = null;
    }
    delete process.env[BASETEN_API_KEY_ENV];
    try {
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {}
  });

  /**
   * TASK RING-DEV-A-DAY2: dual-mode mock. `stream: true` requests get a real
   * SSE body (content split in two, tool-call args split in two, empty
   * heartbeat, terminal finish chunk); plain requests keep the legacy whole
   * JSON body. Both modes answer from the SAME handler completion, so one
   * request always equals one model turn again.
   */
  const toSSEChunks = (out: any): Array<{ delta: any; finish?: string | null }> => {
    const choice = out.choices[0];
    const msg = choice.message || {};
    const chunks: Array<{ delta: any; finish?: string | null }> = [];
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content) {
      const mid = Math.max(1, Math.ceil(content.length / 2));
      chunks.push({ delta: { role: 'assistant', content: content.slice(0, mid) } });
      chunks.push({ delta: { content: content.slice(mid) } });
    } else {
      chunks.push({ delta: { role: 'assistant' } });
    }
    for (const tc of msg.tool_calls || []) {
      const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}';
      const mid = Math.max(1, Math.ceil(args.length / 2));
      chunks.push({
        delta: {
          tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: '' } }],
        },
      });
      chunks.push({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] } });
      chunks.push({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } });
    }
    chunks.push({ delta: {}, finish: choice.finish_reason || (msg.tool_calls?.length ? 'tool_calls' : 'stop') });
    return chunks;
  };
  const startMock = (handler: (body: any) => any, opts?: { delayMs?: number }): Promise<string> =>
    new Promise((resolve, reject) => {
      mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          let body: any;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined;
          }
          capturedRequests.push({ url: req.url || '', body });
          const send = () => {
            const out = handler(body);
            if (body && body.stream === true) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });
              for (const c of toSSEChunks(out)) {
                res.write(
                  `data: ${JSON.stringify({ id: 'chatcmpl-ring-agent-mock', object: 'chat.completion.chunk', created: 1730000000, model: BASETEN_API_MODEL, choices: [{ index: 0, delta: c.delta, finish_reason: c.finish ?? null }] })}\n\n`,
                );
              }
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
          };
          if (opts?.delayMs) setTimeout(send, opts.delayMs);
          else send();
        });
      });
      mockServer.once('error', reject);
      mockServer.listen(0, '127.0.0.1', () => {
        mockServerPort = (mockServer!.address() as AddressInfo).port;
        const mockBase = `http://127.0.0.1:${mockServerPort}`;
        const originalFetch = globalThis.fetch;
        const nativeFetch = originalFetch.bind(globalThis);
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const target = String(input);
          if (target.startsWith(`${BASETEN_API_BASE_URL}/chat/completions`))
            return nativeFetch(`${mockBase}/chat/completions`, { ...init, redirect: 'error' });
          return nativeFetch(input, init);
        }) as typeof globalThis.fetch;
        restoreFetch = () => {
          globalThis.fetch = originalFetch;
        };
        resolve(mockBase);
      });
    });

  it('(a) full loop: tool call then final answer completes with telemetry in transcript', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    let call = 0;
    await startMock(() => {
      call++;
      if (call === 1)
        return completion(null, [
          { id: 'call_1', type: 'function', function: { name: 'analyze_telemetry', arguments: '{}' } },
        ]);
      return completion('Turbine T-07 is CRITICAL: RMS 2.637 mm/s from the deterministic telemetry tool.');
    });
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const events: string[] = [];
    service.onEvent((e) => events.push(e.type));
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('hosted');
    expect(snap.finalAnswer).toContain('CRITICAL');
    const types = snap.transcript.map((e) => e.type);
    expect(types).toContain('run.started');
    expect(types).toContain('model.turn');
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types).toContain('run.completed');
    const toolResults = snap.transcript.filter((e) => e.type === 'tool.result' && e.toolName === 'analyze_telemetry');
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].ok).toBe(true);
    // TASK RING-ADAPTER-01 (A2): tool.result summary is the short verdict
    // line (structured RMS travels on the internal projection / wire
    // overallRms, not re-parsed from JSON). Full JSON stays in the JSONL only
    // transitively; the summary itself no longer embeds raw metrics.
    expect(String(toolResults[0].summary)).toContain('CRITICAL');
    expect(snap.events.some((e) => e.type === 'tool.result' && e.overallRms === 2.637)).toBe(true);
    expect(events).toContain('tool.call');
    const filePath = path.join(tempProjectRoot, '.maos', 'ring-runs', `${runId}.jsonl`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('CRITICAL');
    expect(capturedRequests.length).toBe(2);
  });

  it('(b) approval: consequential draft pauses, deny writes nothing, approve writes and completes', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    const noteArgs = JSON.stringify({
      title: 'Vibration Alert',
      content: 'Turbine T-07 CRITICAL vibration requires inspection.',
      filename: 'safety-note.md',
    });
    // deny branch
    let denyCall = 0;
    await startMock(() => {
      denyCall++;
      if (denyCall === 1)
        return completion(null, [
          { id: 'call_draft', type: 'function', function: { name: 'draft_safety_note', arguments: noteArgs } },
        ]);
      return completion('should not be used after denial');
    });
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId = service.startRun('Draft a safety note about turbine vibration');
    const awaiting = await service.waitForRun(runId);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.pendingApproval?.toolName).toBe('draft_safety_note');
    expect(awaiting.transcript.some((e) => e.type === 'approval.pending')).toBe(true);
    const draftsDir = path.join(tempProjectRoot, '.maos', 'ring-runs', 'drafts');
    expect(fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).length : 0).toBe(0);
    const approvalId = awaiting.pendingApproval!.approvalId;
    service.resolveApproval(runId, approvalId, 'denied');
    const denied = await service.waitForCompletion(runId);
    expect(denied.status).toBe('completed');
    expect(denied.finalAnswer).toContain('Approval denied');
    expect(fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).length : 0).toBe(0);
    expect(denied.transcript.some((e) => e.type === 'approval.resolved' && e.decision === 'denied')).toBe(true);
    // approve branch (fresh mock)
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    if (mockServer) {
      await new Promise<void>((r) => mockServer!.close(() => r()));
      mockServer = null;
    }
    capturedRequests = [];
    let approveCall = 0;
    await startMock(() => {
      approveCall++;
      if (approveCall === 1)
        return completion(null, [
          { id: 'call_draft2', type: 'function', function: { name: 'draft_safety_note', arguments: noteArgs } },
        ]);
      return completion('Safety note drafted after approval.');
    });
    const service2 = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId2 = service2.startRun('Draft a safety note about turbine vibration');
    const awaiting2 = await service2.waitForRun(runId2);
    expect(awaiting2.status).toBe('awaiting_approval');
    service2.resolveApproval(runId2, awaiting2.pendingApproval!.approvalId, 'approved');
    const approved = await service2.waitForCompletion(runId2);
    expect(approved.status).toBe('completed');
    expect(approved.finalAnswer).toContain('Safety note drafted after approval');
    expect(fs.existsSync(draftsDir)).toBe(true);
    expect(fs.readdirSync(draftsDir).length).toBe(1);
    const draftFile = path.join(draftsDir, fs.readdirSync(draftsDir)[0]);
    expect(fs.readFileSync(draftFile, 'utf-8')).toContain('Vibration Alert');
    expect(
      approved.transcript.some((e) => e.type === 'tool.result' && e.toolName === 'draft_safety_note' && e.ok === true),
    ).toBe(true);
  });

  it('(c) cancellation: cancel during pending model call marks cancelled', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    await startMock(() => completion('late answer should be ignored'), { delayMs: 400 });
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId = service.startRun('Analyze turbine vibration telemetry slowly');
    await new Promise((r) => setTimeout(r, 30));
    expect(service.getRun(runId)?.status).toBe('running');
    expect(service.cancelRun(runId)).toBe(true);
    const snap = await service.waitForCompletion(runId, 5000);
    expect(snap.status).toBe('cancelled');
    expect(snap.transcript.some((e) => e.type === 'run.cancelled')).toBe(true);
    expect(service.cancelRun(runId)).toBe(false);
  });

  it('(d) evidence-only: no key runs deterministic tools with zero model requests', async () => {
    delete process.env[BASETEN_API_KEY_ENV];
    await startMock(() => completion('model must never be called'));
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId = service.startRun('Analyze turbine vibration telemetry and give the verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(snap.mode).toBe('evidence-only');
    expect(snap.finalAnswer).toContain('CRITICAL');
    expect(snap.finalAnswer).toContain('2.637');
    expect(snap.finalAnswer).toContain('evidence-only');
    expect(snap.transcript.some((e) => e.type === 'mode.evidence-only')).toBe(true);
    expect(
      snap.transcript.some((e) => e.type === 'tool.result' && e.toolName === 'analyze_telemetry' && e.ok === true),
    ).toBe(true);
    expect(capturedRequests.length).toBe(0);
  });

  it('approval then artifacts for a work-order+handover ask without telemetry wording', async () => {
    // TASK APPROVAL-ARTIFACT-FIX-01: the overlay demo instruction names no
    // telemetry keyword, so evidence-only must still establish the
    // deterministic telemetry summary before the approval-gated generation
    // (work-order findings require a tool-hashed citation), and the
    // handover half of the ask must run its own approval + twin artifacts.
    const haveEngine = seedEngineFixture(tempProjectRoot);
    delete process.env[BASETEN_API_KEY_ENV];
    const { createServiceContainer } = await import('../../src/service');
    const services = createServiceContainer(tempProjectRoot);
    const audit = new AuditService(tempProjectRoot);
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: audit,
      memoryService: services.memory,
      ocrService: services.ocr,
      visionService: services.vision,
      docxGenerator: services.docxGenerator,
      xlsxGenerator: services.xlsxGenerator,
      kbSearch: services.kbSearch,
    });
    const runId = service.startRun('Raise a work order and draft my handover');
    const awaiting = await service.waitForRun(runId, 30000);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.pendingApproval?.toolName).toBe('create_work_order');
    service.resolveApproval(runId, awaiting.pendingApproval!.approvalId, 'approved');
    for (let i = 0; i < 5; i++) {
      const snap = await service.waitForRun(runId, 30000);
      if (snap.status === 'awaiting_approval' && snap.pendingApproval) {
        service.resolveApproval(runId, snap.pendingApproval.approvalId, 'approved');
      } else break;
    }
    const done = await service.waitForCompletion(runId, 30000);
    expect(done.status).toBe('completed');
    if (haveEngine) {
      const created = done.events.filter((e) => e.type === 'artifact.created');
      // work-order docx+md twins plus handover docx+md twins
      expect(created.length).toBe(4);
      const kinds = created.map((e) => e.artifact?.kind).sort();
      expect(kinds).toEqual(['docx', 'docx', 'markdown', 'markdown']);
      for (const e of created) {
        const abs = path.resolve(tempProjectRoot, e.artifact!.path);
        expect(fs.existsSync(abs)).toBe(true);
      }
      expect(String(done.finalAnswer)).toContain('Work order:');
      expect(String(done.finalAnswer)).toContain('Handover:');
    } else {
      expect(String(done.finalAnswer)).toContain('Engine executable not found');
    }
    expect(validateRingRunState(done as unknown).status).toBe('completed');
  });

  it('(e) prompt safety: model request contains summary and not raw CSV rows', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    await startMock(() => completion('Summary reviewed.'));
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId = service.startRun('Explain the turbine vibration verdict');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);
    const bodyText = JSON.stringify(capturedRequests[0].body);
    expect(bodyText).toContain('CRITICAL');
    expect(bodyText).toContain('2.637');
    expect(bodyText).not.toContain('timestamp,asset_id,vibration_rms_mm_s');
    expect(bodyText).not.toContain('2026-08-22T09:00:00+05:30,T-07,2.82,74.5');
    expect(bodyText).not.toContain('2026-08-22T09:00:15+05:30,T-07,2.77,76.6');
  });

  it('(f) path safety: read_company_document outside evidence root is refused', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    let call = 0;
    await startMock(() => {
      call++;
      if (call === 1)
        return completion(null, [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read_company_document', arguments: JSON.stringify({ path: '../maos.config.json' }) },
          },
        ]);
      return completion('Outside-root read was refused as expected.');
    });
    const service = new RingAgentService({
      projectRoot: tempProjectRoot,
      auditService: new AuditService(tempProjectRoot),
    });
    const runId = service.startRun('Read the document at ../maos.config.json');
    const snap = await service.waitForCompletion(runId);
    expect(snap.status).toBe('completed');
    const refusing = snap.transcript.filter((e) => e.type === 'tool.result' && e.toolName === 'read_company_document');
    expect(refusing.length).toBe(1);
    expect(refusing[0].ok).toBe(false);
    expect(String(refusing[0].summary)).toContain('PATH_OUTSIDE_EVIDENCE_ROOT');
  });
});

describe('TASK RING-AGENT-LOOP-01: Ring Agent REST API (g)', () => {
  it('REST start/get/approve, bad body and missing run', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-ring-agent-key';
    const repoRoot = path.resolve(__dirname, '../..');
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-api2-'));
    fs.mkdirSync(path.join(root2, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(root2, 'demo', 'industrial'), { recursive: true });
    for (const f of [
      'sop_turbine_vibration_monitoring.md',
      'maintenance_report.txt',
      'safety_thresholds.json',
      'turbine_vibration_log.csv',
    ]) {
      fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(root2, 'demo', 'industrial', f));
    }
    fs.writeFileSync(
      path.join(root2, '.maos', 'maos.config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'ring-api2',
          profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
          providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
          agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }],
        },
        null,
        2,
      ),
    );
    // Mock is installed via a fresh service test would need fetch bridge; instead test service directly via container router with evidence-only fallback by deleting key.
    delete process.env[BASETEN_API_KEY_ENV];
    const svcMod = await import('../../src/service');
    const routerMod = await import('../../src/api/router');
    const services = svcMod.createServiceContainer(root2);
    const router = new routerMod.RestApiRouter(services, root2);
    const exec = async (method: string, url: string, payload?: any) => {
      const payloadBuf = Buffer.from(payload === undefined ? '' : JSON.stringify(payload));
      const req = {
        method,
        url,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' },
        on: () => {},
      } as any;
      (req as any)[Symbol.asyncIterator] = async function* () {
        if (payloadBuf.length) yield payloadBuf;
      };
      let statusCode = 0;
      let resBody = '';
      const res = {
        writeHead: (s: number) => {
          statusCode = s;
        },
        setHeader: () => {},
        end: (d: string) => {
          resBody = d;
        },
      } as any;
      await router.handle(req, res);
      return { status: statusCode, body: resBody ? JSON.parse(resBody) : {} };
    };
    try {
      const bad = await exec('POST', '/api/v1/ring/runs', {});
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const started = await exec('POST', '/api/v1/ring/runs', {
        instruction: 'Analyze turbine vibration telemetry and give the verdict',
      });
      expect(started.status).toBe(201);
      const runId = started.body.data.runId as string;
      expect(typeof runId).toBe('string');
      let finalState: any = null;
      for (let i = 0; i < 50; i++) {
        const f = await exec('GET', '/api/v1/ring/runs/' + runId);
        finalState = f;
        if (f.body.data.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(finalState.body.data.status).toBe('completed');
      expect(finalState.body.data.finalAnswer).toContain('CRITICAL');
      expect(finalState.body.data.mode).toBe('evidence-only');
      const missing = await exec('GET', '/api/v1/ring/runs/ring-missing-nope');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
    } finally {
      try {
        fs.rmSync(root2, { recursive: true, force: true });
      } catch {}
    }
  });
});
