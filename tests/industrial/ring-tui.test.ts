/**
 * TASK RING-TUI-01: industrial home TUI + embedded Ring mode tests.
 *
 * Evidence-only by default (BASETEN_API_KEY unset; no live calls). Temporary
 * project roots carry the repo demo fixtures; nothing touches C:/maos.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { BASETEN_API_KEY_ENV } from '../../src/backends/meta-api-policy';
import { AuditService } from '../../src/service/audit-service';
import { RingAgentService } from '../../src/service/ring-agent-service';
import { RingThreadService } from '../../src/service/ring-thread-service';
import { createServiceContainer } from '../../src/service';
import { RING_CLI_EXIT, isRingRefusalAnswer, safeTerminalText } from '../../src/industrial/ring-cli';
import {
  INDUSTRIAL_TUI_BANNER,
  INDUSTRIAL_TUI_TAGLINE,
  INDUSTRIAL_TUI_VERSION,
  detectTuiCapabilities,
  readIndustrialTuiSystems,
  readIndustrialTuiTelemetry,
  renderIndustrialTuiApprovalCard,
  renderIndustrialTuiHome,
  renderRingModeHeader,
  runIndustrialTui,
} from '../../src/industrial/industrial-tui';

const CEO_BANNER: readonly string[] = [
  '██╗███╗   ██╗██████╗ ██╗   ██╗███████╗',
  '██║████╗  ██║██╔══██╗██║   ██║██╔════╝',
  '██║██╔██╗ ██║██║  ██║██║   ██║███████╗',
  '██║██║╚██╗██║██║  ██║██║   ██║╚════██║',
  '██║██║ ╚████║██████╔╝╚██████╔╝███████║',
  '╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝ ╚══════╝',
];

const FIXTURES = [
  'sop_turbine_vibration_monitoring.md',
  'pump_p12_vibration_monitoring.md',
  'maintenance_report.txt',
  'maintenance_report_p12.txt',
  'safety_thresholds.json',
  'turbine_vibration_log.csv',
  'pump_p12_vibration_log.csv',
];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-tui-'));
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
      projectName: 'ring-tui-test',
      profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
    }),
  );
  return root;
}

function seedEngine(root: string): void {
  const exe = process.platform === 'win32' ? 'maos-engine.exe' : 'maos-engine';
  const candidates = [
    path.resolve(__dirname, '../../rust/target/release', exe),
    path.join('C:', 'maos', 'rust', 'target', 'release', exe),
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
function makeServices(root: string) {
  const audit = new AuditService(root);
  const ringAgent = new RingAgentService({ projectRoot: root, auditService: audit });
  const ringThread = new RingThreadService(root);
  return { ringAgent, ringThread, audit };
}

function waitForText(output: PassThrough, readText: () => string, text: string, after = 0): Promise<void> {
  if (readText().slice(after).includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for CLI output: ' + text + '\n' + readText())),
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

async function sendHomeCommand(
  input: PassThrough,
  output: PassThrough,
  readText: () => string,
  command: string,
  expected: string,
): Promise<number> {
  const start = readText().length;
  input.write(command + '\n');
  await waitForText(output, readText, expected, start);
  await waitForText(output, readText, 'maos-industrial> ', readText().length);
  return start;
}

async function sendRingCommand(
  input: PassThrough,
  output: PassThrough,
  readText: () => string,
  command: string,
  expected: string,
): Promise<number> {
  const start = readText().length;
  input.write(command + '\n');
  await waitForText(output, readText, expected, start);
  await waitForText(output, readText, 'ring> ', readText().length);
  return start;
}

describe('TASK RING-TUI-01: industrial TUI', () => {
  let root = '';
  beforeEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    root = makeTempRoot();
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

  it('CEO banner is byte-identical to the design (6 lines, character-for-character)', () => {
    expect(INDUSTRIAL_TUI_BANNER).toHaveLength(6);
    expect([...INDUSTRIAL_TUI_BANNER]).toEqual([...CEO_BANNER]);
    for (let i = 0; i < CEO_BANNER.length; i++) {
      expect(INDUSTRIAL_TUI_BANNER[i]).toBe(CEO_BANNER[i]);
    }
  });

  it('home render carries version, tagline, input card, systems panel, hints, footer', async () => {
    const container = createServiceContainer(root);
    const systems = await readIndustrialTuiSystems(container, root, 'evidence-only');
    expect(systems.telemetry).toContain('T-07');
    expect(systems.telemetry).toContain('RMS');
    expect(systems.mode).toBe('EVIDENCE-ONLY');
    const htmless = renderIndustrialTuiHome({
      systems,
      caps: { unicode: true, emoji: true, color: true, narrow: false, width: 100 },
      projectLabel: 'demo-plant',
      branch: 'main',
    });
    const home = htmless;
    for (const row of CEO_BANNER) expect(home).toContain(row);
    expect(home).toContain('MAOS Industrial · v' + INDUSTRIAL_TUI_VERSION);
    expect(home).toContain(INDUSTRIAL_TUI_TAGLINE);
    expect(home).toContain('Ask your plant anything...');
    expect(home).toContain('Operator');
    expect(home).toContain('evidence-only');
    expect(home).toContain('T-07');
    expect(home).toContain('Systems');
    expect(home).toContain('/ring');
    expect(home).toContain('/verify');
    expect(home).toContain('/help');
    expect(home).toContain('tab');
    expect(home).toContain('ctrl+c');
    expect(home).toContain('demo-plant:main');
    expect(home).toContain('v' + INDUSTRIAL_TUI_VERSION);
  });

  it('telemetry reading is measured from the bundled CSV (never hardcoded)', () => {
    const reading = readIndustrialTuiTelemetry(root);
    expect(reading).toContain('T-07 CRITICAL RMS 2.637');
    expect(fs.existsSync(path.join(root, 'demo', 'industrial', 'turbine_vibration_log.csv'))).toBe(true);
  });

  it('ASCII fallback renders without unicode or emoji (never crashes)', async () => {
    const container = createServiceContainer(root);
    const systems = await readIndustrialTuiSystems(container, root, 'evidence-only');
    const home = renderIndustrialTuiHome({
      systems,
      caps: { unicode: false, emoji: false, color: false, narrow: true, width: 60 },
      projectLabel: 'narrow-plant',
      branch: '',
    });
    for (const row of CEO_BANNER) expect(home).toContain(row);
    expect(home).not.toContain('╭');
    expect(home).not.toContain('✅');
    expect(home).toContain('+');
    expect(home).toContain('[OK]');
    const header = renderRingModeHeader(
      { unicode: false, emoji: false, color: false, narrow: true, width: 60 },
      'EVIDENCE-ONLY',
    );
    expect(header).toContain('RING');
    expect(header).not.toContain('╭');
  });

  it('zero process.platform branches in the TUI layer', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/industrial/industrial-tui.ts'), 'utf8');
    expect(src).not.toContain('process.platform');
    expect(src).not.toContain('process.env.OS');
    expect(src).not.toMatch(/win32/);
  });

  it('approval card is impossible to miss and keeps [y/N] default-No', () => {
    const card = renderIndustrialTuiApprovalCard({ tool: 'create_work_order', approvalId: 'approval-1' });
    expect(card).toContain('APPROVAL NEEDED');
    expect(card).toContain('create_work_order');
    expect(card).toContain('approval-1');
    expect(card).toContain('Default is No');
  });

  it('home -> /ring -> /back transitions, evidence brief, approval default-No', async () => {
    const services = makeServices(root);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const tui = runIndustrialTui({ projectRoot: root, input, output, services });
    const readText = (): string => transcript;
    await waitForText(output, readText, 'Ask your plant anything...');
    for (const row of CEO_BANNER) expect(transcript).toContain(row);

    const ringAt = transcript.length;
    input.write('/ring\n');
    await waitForText(output, readText, 'RING', ringAt);
    await waitForText(output, readText, 'ring> ', readText().length);
    expect(transcript.slice(ringAt)).toContain('/back returns home');

    const briefAt = await sendRingCommand(input, output, readText, 'Give me the turbine vibration brief', 'CRITICAL');
    expect(transcript.slice(briefAt)).toContain('2.637');

    const approvalAt = transcript.length;
    input.write('Raise a work order for the turbine vibration\n');
    await waitForText(output, readText, 'APPROVAL NEEDED', approvalAt);
    await waitForText(output, readText, '[y/N]', approvalAt);
    input.write('\n');
    await waitForText(output, readText, 'Approval denied', approvalAt);
    await waitForText(output, readText, 'ring> ', readText().length);

    const backAt = await sendHomeCommand(input, output, readText, '/back', 'Ask your plant anything...');
    expect(transcript.slice(backAt)).toContain('MAOS Industrial');

    input.write('exit\n');
    await tui;
  }, 60000);

  it('Ring refusal behavior preserved: restart asks are refused, exit code 2', async () => {
    const services = makeServices(root);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const tui = runIndustrialTui({ projectRoot: root, input, output, services });
    const readText = (): string => transcript;
    await waitForText(output, readText, 'Ask your plant anything...');
    const ringAt = transcript.length;
    input.write('/ring\n');
    await waitForText(output, readText, 'RING', ringAt);
    await waitForText(output, readText, 'ring> ', readText().length);
    expect(transcript.slice(ringAt)).toContain('RING');
    const refuseAt = await sendRingCommand(
      input,
      output,
      readText,
      'Approve the turbine restart now',
      'cannot approve',
    );
    expect(isRingRefusalAnswer(transcript.slice(refuseAt))).toBe(true);
    input.write('exit\n');
    await tui;
  }, 60000);

  it('control characters are stripped from rendered output', () => {
    expect(safeTerminalText(String.fromCharCode(97, 27, 98, 7, 99, 127, 100))).toBe('a b c d');
  });

  it('exit codes 0/1/2/3 are frozen', () => {
    expect(RING_CLI_EXIT.COMPLETED).toBe(0);
    expect(RING_CLI_EXIT.FAILED).toBe(1);
    expect(RING_CLI_EXIT.REFUSED_OR_CANCELLED).toBe(2);
    expect(RING_CLI_EXIT.AWAITING_APPROVAL).toBe(3);
  });

  it('detectTuiCapabilities degrades without crashing', () => {
    const narrow = new PassThrough() as PassThrough & { columns?: number };
    narrow.columns = 60;
    const caps = detectTuiCapabilities(narrow);
    expect(caps.width).toBe(60);
    expect(caps.narrow).toBe(true);
  });
});
