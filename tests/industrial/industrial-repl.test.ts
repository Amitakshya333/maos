import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runIndustrialRepl } from '../../src/industrial/industrial-repl';
import { ProjectServiceHost } from '../../src/service/project-service/host';

const roots: string[] = [];
const servers: http.Server[] = [];
const hosts: ProjectServiceHost[] = [];
const repoRoot = path.resolve(__dirname, '../..');

function makeCompletion(name: string, args: Record<string, unknown>, id: string, content?: string) {
  return {
    id: 'chatcmpl-industrial-repl',
    object: 'chat.completion',
    created: 1,
    model: 'mock-repl-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content ?? null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

async function startMockInference(hang = false): Promise<{ baseURL: string; waitForFirstRequest(): Promise<void> }> {
  let requestCount = 0;
  let resolveFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requestCount++;
      if (requestCount === 1) resolveFirstRequest();
      if (hang) return;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (requestCount % 2 === 1) {
        const user = body.messages.find((message: any) => message.role === 'user');
        const sourcePath = String(user?.content).match(/Analyze only this user-selected project file: ([^\r\n]+)/)?.[1];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(makeCompletion('analyze_telemetry_csv', { sourcePath }, `call-analysis-${requestCount}`)),
        );
        return;
      }

      const callId = `call-analysis-${requestCount - 1}`;
      const tool = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === callId);
      const evidence = JSON.parse(tool.content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          makeCompletion(
            'task_complete',
            {
              summary: `Replay found ${evidence.result.rowsAnalyzed} rows with verdict ${evidence.result.verdict}; receipt ${evidence.analysisId}.`,
            },
            `call-complete-${requestCount}`,
          ),
        ),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    waitForFirstRequest: () => firstRequest,
  };
}

function createProject(baseURL: string): { root: string; sourcePath: string } {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-industrial-repl-'));
  let root = rawRoot;
  try {
    root = fs.realpathSync(rawRoot);
  } catch {}
  roots.push(root);
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify({
      projectName: 'industrial-repl-test',
      agents: [{ id: 'ANALYST_AGENT', provider: 'mock', model: 'fixture-model', timeoutMs: 2_000 }],
      providers: { mock: { baseURL } },
    }),
  );
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'demo', 'industrial', 'safety_thresholds.json'),
    path.join(root, 'demo', 'industrial', 'safety_thresholds.json'),
  );
  const sourcePath = 'commissioning/bearing-ramp.csv';
  fs.mkdirSync(path.dirname(path.join(root, sourcePath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, sourcePath),
    [
      'sample_time,vibration_rms_mm_s,bearing_temperature_c',
      '2026-02-11T08:00:00Z,1.2,70',
      '2026-02-11T08:01:00Z,4.8,88',
      '2026-02-11T08:02:00Z,8.2,96',
      '2026-02-11T08:03:00Z,3.0,82',
    ].join('\n'),
  );
  return { root, sourcePath };
}

function waitFor(output: PassThrough, readText: () => string, text: string, after = 0): Promise<void> {
  if (readText().slice(after).includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for REPL output: ${text}\n${readText()}`)),
      5_000,
    );
    const onData = () => {
      if (readText().slice(after).includes(text)) finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      output.off('data', onData);
      if (error) reject(error);
      else resolve();
    };
    output.on('data', onData);
  });
}

async function sendCommand(
  input: PassThrough,
  output: PassThrough,
  readText: () => string,
  command: string,
  expected: string,
): Promise<void> {
  const start = readText().length;
  input.write(`${command}\n`);
  await waitFor(output, readText, expected, start);
  const completed = readText().length;
  await waitFor(output, readText, 'maos-industrial> ', completed);
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MAOS Industrial bounded REPL', () => {
  it('runs the selected-file mock analysis through persisted review, report and verification', async () => {
    const mock = await startMockInference();
    const project = createProject(mock.baseURL);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runIndustrialRepl({ projectRoot: project.root, input, output });

    await sendCommand(input, output, () => transcript, 'shell echo forbidden', 'Unknown command');
    await sendCommand(
      input,
      output,
      () => transcript,
      'report ../HACKATHON_SUBMISSION.md',
      'Run ID must contain only letters, numbers, dots, underscores, or hyphens.',
    );
    await sendCommand(
      input,
      output,
      () => transcript,
      'analyze commissioning/bearing-ramp.csv "Review this held-out bearing sample"',
      'Review run: judged-run-agent-',
    );
    const runId = transcript.match(/Review run: (judged-run-agent-[^\s]+) \(pending_approval\)/)?.[1];
    expect(runId).toBeTruthy();
    expect(transcript).toContain('Provider-reported model: mock-repl-model');
    expect(transcript).toContain('Engineering verdict: CRITICAL');
    expect(transcript).toContain('Model-generated explanation — UNVERIFIED');
    expect(transcript).toContain('Replay-verified numeric findings:');

    const host = new ProjectServiceHost(project.root, { port: 0, allowedOrigins: ['http://127.0.0.1:47123'] });
    hosts.push(host);
    const started = await host.start();
    const session = host.createSession('industrial-repl-state-test-window');
    const guiRunResponse = await fetch(
      `http://127.0.0.1:${started.port}/api/v1/industrial/judged-runs/${encodeURIComponent(runId!)}`,
      {
        headers: {
          Origin: 'http://127.0.0.1:47123',
          Authorization: `Bearer ${session.token}`,
          'X-Project-Root': project.root,
          'X-Project-ID': 'industrial-repl-test',
        },
      },
    );
    const guiRun = (await guiRunResponse.json()) as { data: { runId: string; status: string; verdict: string } };
    expect(guiRunResponse.status).toBe(200);
    expect(guiRun.data).toMatchObject({ runId, status: 'pending_approval', verdict: 'FAIL' });

    await sendCommand(input, output, () => transcript, `status ${runId}`, 'Current accepted deliverable: no');
    expect(transcript).toContain(`Persisted status: ${guiRun.data.status}`);
    const beforeApproval = transcript.length;
    await sendCommand(
      input,
      output,
      () => transcript,
      `approve ${runId} "Shift Engineer" "Reviewed the replay evidence"`,
      'Current accepted deliverable: yes',
    );
    expect(transcript.slice(beforeApproval)).toContain(
      'Local CLI reviewer identity is operator-supplied and is not independently authenticated.',
    );
    await sendCommand(input, output, () => transcript, `report ${runId}`, 'Accepted report:');
    await sendCommand(input, output, () => transcript, `verify ${runId}`, 'Verification: VERIFIED');
    await sendCommand(
      input,
      output,
      () => transcript,
      'analyze commissioning/bearing-ramp.csv "Reject this second synthetic review"',
      'Review run: judged-run-agent-',
    );
    const reviewRuns = Array.from(transcript.matchAll(/Review run: (judged-run-agent-[^\s]+) \(pending_approval\)/g));
    const rejectedRunId = reviewRuns[reviewRuns.length - 1]?.[1];
    expect(rejectedRunId).toBeTruthy();
    const beforeRejection = transcript.length;
    await sendCommand(
      input,
      output,
      () => transcript,
      `reject ${rejectedRunId} "Shift Engineer" "Evidence was not approved"`,
      'Run status: rejected',
    );
    expect(transcript.slice(beforeRejection)).toContain(
      'Local CLI reviewer identity is operator-supplied and is not independently authenticated.',
    );
    await sendCommand(input, output, () => transcript, `report ${rejectedRunId}`, 'has no currently accepted report');
    input.write('exit\n');
    input.end();
    await repl;

    expect(transcript).toContain('Run status: completed');
    expect(transcript).toContain('Run status: rejected');
    expect(transcript).toContain('Engineering verdict: FAIL');
    expect(transcript).not.toMatch(/Unknown command[^\n]*echo/);
  });

  it('cancels a hanging mock analysis without preparing a review run or accepted report', async () => {
    const mock = await startMockInference(true);
    const project = createProject(mock.baseURL);
    const otherProject = createProject(mock.baseURL);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runIndustrialRepl({ projectRoot: project.root, input, output });

    const after = transcript.length;
    input.write('analyze commissioning/bearing-ramp.csv "Cancel this local mock request"\n');
    await mock.waitForFirstRequest();
    await waitFor(output, () => transcript, 'maos-industrial> ', after);
    const beforeSwitch = transcript.length;
    input.write(`project ${otherProject.root}\n`);
    await waitFor(output, () => transcript, 'An operation is in progress.', beforeSwitch);
    const beforeCancel = transcript.length;
    input.write('cancel\n');
    await waitFor(output, () => transcript, 'Cancellation requested', beforeCancel);
    await waitFor(output, () => transcript, 'AGENT_CANCELLED', beforeCancel);
    await waitFor(output, () => transcript, 'maos-industrial> ', transcript.length);
    const beforeProjectCheck = transcript.length;
    input.write('project\n');
    await waitFor(output, () => transcript, `Active project: ${project.root}`, beforeProjectCheck);
    expect(transcript.slice(beforeSwitch)).not.toContain(otherProject.root);
    input.write('exit\n');
    input.end();
    await repl;

    const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
    expect(fs.existsSync(path.join(analysisRoot, 'agent-reports'))).toBe(false);
    expect(fs.existsSync(path.join(project.root, '.maos', 'industrial', 'judged-runs'))).toBe(false);
  });
});
