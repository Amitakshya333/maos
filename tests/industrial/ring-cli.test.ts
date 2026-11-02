/**
 * TASK DEV-A-CLI-01: Ring CLI tests.
 *
 * Evidence-only by default (BASETEN_API_KEY unset; no live calls). Hosted
 * streaming uses an injected loopback-mock providerFactory. Temporary
 * project roots carry the repo demo fixtures; nothing touches C:/maos.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { BASETEN_API_KEY_ENV } from '../../src/backends/meta-api-policy';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import { AuditService } from '../../src/service/audit-service';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { RingThreadService } from '../../src/service/ring-thread-service';
import {
  RING_CLI_EXIT,
  isRingRefusalAnswer,
  runRingHeadless,
  runRingRepl,
  safeTerminalText,
} from '../../src/industrial/ring-cli';

const FIXTURES = [
  'sop_turbine_vibration_monitoring.md',
  'sop_pump_p12_monitoring.md',
  'maintenance_report.txt',
  'maintenance_report_p12.txt',
  'safety_thresholds.json',
  'turbine_vibration_log.csv',
  'pump_p12_vibration_log.csv',
];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-cli-'));
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  const repoRoot = path.resolve(__dirname, '../..');
  for (const f of FIXTURES) {
    const src = path.join(repoRoot, 'demo', 'industrial', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(root, 'demo', 'industrial', f));
    }
  }
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'ring-cli-test',
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
      },
    }),
  );
  return root;
}

function makeServices(root: string, providerFactory?: () => IProvider) {
  const audit = new AuditService(root);
  const ringAgent = new RingAgentService({
    projectRoot: root,
    auditService: audit,
    ...(providerFactory ? { providerFactory } : {}),
  });
  const ringThread = new RingThreadService(root);
  return { ringAgent, ringThread, audit };
}

function waitForText(
  output: PassThrough,
  readText: () => string,
  text: string,
  after = 0,
): Promise<void> {
  if (readText().slice(after).includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          new Error(`Timed out waiting for CLI output: ${text}\n${readText()}`),
        ),
      15000,
    );
    const onData = (): void => {
      if (readText().slice(after).includes(text)) finish();
    };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      output.off('data', onData);
      if (error) reject(error);
      else resolve();
    };
    output.on('data', onData);
  });
}

function hostedMockProvider(
  onGenerate?: (turn: number) => ProviderResponse,
): () => IProvider {
  let turn = 0;
  const provider: IProvider = {
    name: 'fake-ring-cli-loopback',
    model: BASETEN_API_MODEL,
    generate: async () => {
      turn += 1;
      if (onGenerate) return onGenerate(turn);
      return {
        content: 'Mocked hosted answer citing CRITICAL telemetry.',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: BASETEN_API_MODEL,
        latencyMs: 1,
        finishReason: 'stop',
      };
    },
  };
  return () => provider;
}

function streamingMockProvider(chunks: string[], finalText: string): () => IProvider {
  const provider: IProvider = {
    name: 'fake-ring-cli-stream',
    model: BASETEN_API_MODEL,
    generate: async () => ({
      content: finalText,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: BASETEN_API_MODEL,
      latencyMs: 1,
      finishReason: 'stop',
    }),
    generateStream: async (_messages, _tools, options) => {
      for (const chunk of chunks) {
        options?.onDelta?.(chunk);
      }
      return {
        content: finalText,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: BASETEN_API_MODEL,
        latencyMs: 1,
        finishReason: 'stop',
      };
    },
  };
  return () => provider;
}

async function sendCommand(
  input: PassThrough,
  output: PassThrough,
  readText: () => string,
  command: string,
  expected: string,
): Promise<number> {
  const start = readText().length;
  input.write(`${command}\n`);
  await waitForText(output, readText, expected, start);
  await waitForText(output, readText, 'ring> ', readText().length);
  return start;
}

function seedEngine(root: string): void {
  const exe = process.platform === 'win32' ? 'maos-engine.exe' : 'maos-engine';
  const candidates = [
    path.resolve(__dirname, '../../rust/target/release', exe),
    `C:/maos/rust/target/release/${exe}`,
  ];
  const found = candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
  if (!found) return;
  const dest = path.join(root, 'rust', 'target', 'release');
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(path.join(dest, path.basename(found)))) {
    fs.copyFileSync(found, path.join(dest, path.basename(found)));
  }
}

describe('TASK DEV-A-CLI-01: Ring CLI (evidence-only)', () => {
  let root = '';
  beforeEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    root = makeTempRoot();
    // Same engine fixture the Ring brain-lane tests use: without the release
    // binary the audit chain cannot append and DOCX artifacts cannot build.
    seedEngine(root);
  });
  afterEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('REPL: /help lists slash skills, evidence-only brief runs, approval defaults to No', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runRingRepl({ projectRoot: root, input, output });
    const readText = (): string => transcript;
    await sendCommand(input, output, readText, '/help', '/handover');
    expect(transcript).toContain('/rca');
    expect(transcript).toContain('/permit');
    expect(transcript).toContain('/loto');
    expect(transcript).toContain('/sop');
    expect(transcript).toContain('/report');
    expect(transcript).toContain('/threads');
    expect(transcript).toContain('/verify');
    expect(transcript).toMatch(/EVIDENCE-ONLY/);

    // Evidence-only brief: deterministic telemetry verdict, mode badge.
    const briefAt = await sendCommand(input, output, readText, 'Give me the turbine vibration brief', 'CRITICAL');
    expect(transcript.slice(briefAt)).toContain('2.637');
    expect(transcript.slice(briefAt)).toContain('EVIDENCE-ONLY');

    // Consequential ask pauses for approval; default answer (empty) = No.
    const approvalAt = transcript.length;
    input.write('Raise a work order for the turbine vibration\n');
    await waitForText(output, readText, 'Approve \"', approvalAt);
    expect(transcript.slice(approvalAt)).toMatch(/\[y\/N\]/);
    // The approval prompt consumed the next line; answer empty (default No).
    input.write('\n');
    await waitForText(output, readText, 'Approval denied', approvalAt);
    await waitForText(output, readText, 'ring> ', transcript.length);
    const denied = transcript.slice(approvalAt);
    expect(denied).toContain('was not performed');

    // Audit recorded the prompt with the denial.
    const chainPath = path.join(root, '.maos', 'audit', 'audit-chain.jsonl');
    const chainLines = fs.readFileSync(chainPath, 'utf-8').trim().split('\n');
    const lastRecord = JSON.parse(chainLines.pop() as string) as { data?: Record<string, unknown> };
    const promptRecord = chainLines
      .map((line) => JSON.parse(line) as { source?: unknown; data?: Record<string, unknown> })
      .find((record) => record.data?.['event'] === 'RING_CLI_APPROVAL_PROMPT');
    expect(promptRecord?.data?.['decision']).toBe('denied');
    expect(promptRecord?.source).toBe('ring-cli');

    input.write('exit\n');
    await repl;
  }, 60000);

  it('REPL: /sop + /rca + restart refusal + /verify, all without hosted calls', async () => {
    const services = makeServices(root);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runRingRepl({ projectRoot: root, input, output });
    const readText = (): string => transcript;
    await sendCommand(input, output, readText, '/sop T-07', 'SOP');
    // Skill-run transient: run.started fires before the workflow completes.
    // The sop workflow needs no approval, so no approval prompt may appear.

    await sendCommand(input, output, readText, '/rca turbine vibration', 'ROOT-CAUSE');

    const refuseAt = await sendCommand(input, output, readText, 'Approve the turbine restart now', 'cannot approve');
    expect(
      isRingRefusalAnswer(transcript.slice(refuseAt)),
    ).toBe(true);

    await sendCommand(input, output, readText, '/verify', 'Audit chain: valid');

    input.write('exit\n');
    await repl;
  }, 60000);

  it('REPL: threads /new /threads /resume /role scoping + unknown command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runRingRepl({ projectRoot: root, input, output });
    const readText = (): string => transcript;
    await waitForText(output, readText, 'ring> ');

    const newAt = await sendCommand(input, output, readText, '/new shift-brief safety', 'thread thread-');
    const threadId = transcript.slice(newAt).match(/thread (thread-[0-9]+-[0-9a-f]{8})/)?.[1];
    expect(threadId).toBeTruthy();

    await sendCommand(input, output, readText, '/threads', threadId as string);

    // /loto is not available to the manager role.
    await sendCommand(input, output, readText, '/role manager', 'role manager');
    await sendCommand(input, output, readText, '/loto', 'not available to role manager');

    await sendCommand(input, output, readText, '/role safety', 'role safety');

    await sendCommand(input, output, readText, `/resume ${threadId}`, `resumed ${threadId}`);

    await sendCommand(input, output, readText, '/frobnicate', 'Unknown command');

    input.write('exit\n');
    await repl;
  }, 60000);

  it('REPL: approving with y writes the artifact with an absolute path', async () => {
    const services = makeServices(root);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runRingRepl({
      projectRoot: root,
      input,
      output,
      services,
      approvalAnswers: ['y'],
    });
    const readText = (): string => transcript;
    await waitForText(output, readText, 'ring> ');
    const at = await sendCommand(input, output, readText, '/report turbine vibration', 'artifact: ');
    const absMatch = transcript.slice(at).match(/artifact: ([^\r\n]+)/)?.[1];
    expect(absMatch).toBeTruthy();
    expect(path.isAbsolute((absMatch as string).trim())).toBe(true);
    input.write('exit\n');
    await repl;
  }, 60000);

  it('headless: --json prints wire events as JSONL and completes evidence-only (exit 0)', async () => {
    const services = makeServices(root);
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    const result = await runRingHeadless({
      projectRoot: root,
      instruction: 'Give me the turbine vibration brief',
      json: true,
      services,
      output,
    });
    expect(result.exitCode).toBe(RING_CLI_EXIT.COMPLETED);
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('run.started');
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types).toContain('run.completed');
  }, 60000);

  it('headless: consequential ask ends awaiting_approval with exit 3 and never auto-approves', async () => {
    const services = makeServices(root);
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    const result = await runRingHeadless({
      projectRoot: root,
      instruction: 'Raise a work order for the turbine vibration',
      services,
      output,
    });
    expect(result.exitCode).toBe(RING_CLI_EXIT.AWAITING_APPROVAL);
    expect(text).toContain('awaiting approval');
    expect(text).toMatch(/maos-industrial ring --resume ring-/);
    // Nothing was written before approval.
    const artifactsDir = path.join(root, '.maos', 'ring-runs', 'artifacts');
    expect(fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir).length : 0).toBe(0);
  }, 60000);

  it('headless: --yes-to rejects anything but none; resume hint polls a pending run', async () => {
    const services = makeServices(root);
    await expect(
      runRingHeadless({
        projectRoot: root,
        instruction: 'Raise a work order',
        yesTo: 'all',
        services,
        output: new PassThrough(),
      }),
    ).rejects.toThrow('--yes-to none');

    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    const first = await runRingHeadless({
      projectRoot: root,
      instruction: 'Raise a work order for the turbine vibration',
      services,
      output,
    });
    expect(first.exitCode).toBe(RING_CLI_EXIT.AWAITING_APPROVAL);
    const runId = first.runId;
    expect(runId).toBeTruthy();
    const pollOut = new PassThrough();
    let pollText = '';
    pollOut.on('data', (chunk: Buffer) => {
      pollText += chunk.toString('utf8');
    });
    const second = await runRingHeadless({
      projectRoot: root,
      resumeRunId: runId,
      services,
      output: pollOut,
    });
    expect(second.exitCode).toBe(RING_CLI_EXIT.AWAITING_APPROVAL);
    expect(pollText).toMatch(/maos-industrial ring --resume/);
  }, 60000);

  it('headless: refusal maps to exit 2 and thread scoping works', async () => {
    const services = makeServices(root);
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    const refused = await runRingHeadless({
      projectRoot: root,
      instruction: 'Approve the turbine restart now',
      services,
      output,
    });
    expect(refused.exitCode).toBe(RING_CLI_EXIT.REFUSED_OR_CANCELLED);
    expect(text).toMatch(/cannot approve/i);

    const thread = services.ringThread.createThread('cli-thread', 'operator');
    const out2 = new PassThrough();
    let text2 = '';
    out2.on('data', (chunk: Buffer) => {
      text2 += chunk.toString('utf8');
    });
    const threaded = await runRingHeadless({
      projectRoot: root,
      instruction: 'Summarize the turbine verdict',
      thread: thread.threadId,
      services,
      output: out2,
    });
    expect(threaded.exitCode).toBe(RING_CLI_EXIT.COMPLETED);
    expect(services.ringThread.getThread(thread.threadId)?.runs.length).toBe(1);
    expect(text2).toContain('CRITICAL');
    await expect(
      runRingHeadless({
        projectRoot: root,
        instruction: 'hi',
        thread: 'thread-123-nope',
        services,
        output: new PassThrough(),
      }),
    ).rejects.toThrow('was not found');
  }, 60000);

  it('control characters are stripped from rendered output', () => {
    // Same C0 + DEL guard as the bounded industrial REPL: ESC, BEL, DEL and
    // other C0 controls become spaces so model output cannot inject terminal
    // control sequences.
    expect(safeTerminalText('a\x1bb\x07c\x7fd')).toBe('a b c d');
    // Raw ESC must never survive into approval prompts or answers.
    expect(safeTerminalText('\x1b[2J\x1b[1;1H')).not.toContain('\x1b');
  });

  it('mocked hosted streaming: deltas arrive live, labelled fallback when silent', async () => {
    // Live deltas: streamed text prints as it arrives (no label).
    const streamed = makeServices(root, streamingMockProvider(['Turbine ', 'T-07 CRITICAL.'], 'Turbine T-07 CRITICAL.'));
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const repl = runRingRepl({ projectRoot: root, input, output, services: streamed });
    const readText = (): string => transcript;
    await waitForText(output, readText, 'ring> ');
    const at = await sendCommand(input, output, readText, 'Turbine status?', 'T-07 CRITICAL');
    expect(transcript.slice(at)).not.toContain('provider does not stream');
    input.write('exit\n');
    await repl;

    // Silent provider: whole text prints once, labelled.
    const silentRoot = makeTempRoot();
    try {
      const silent = makeServices(silentRoot, hostedMockProvider());
      const input2 = new PassThrough();
      const output2 = new PassThrough();
      let transcript2 = '';
      output2.on('data', (chunk: Buffer) => {
        transcript2 += chunk.toString('utf8');
      });
      const repl2 = runRingRepl({ projectRoot: silentRoot, input: input2, output: output2, services: silent });
      const readText2 = (): string => transcript2;
      await waitForText(output2, readText2, 'ring> ');
      await sendCommand(input2, output2, readText2, 'Turbine status?', 'provider does not stream');
      input2.write('exit\n');
      await repl2;
    } finally {
      fs.rmSync(silentRoot, { recursive: true, force: true });
    }
  }, 60000);
});
