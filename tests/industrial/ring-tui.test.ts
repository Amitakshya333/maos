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
  INDUSTRIAL_TUI_SUGGESTIONS,
  INDUSTRIAL_TUI_TAGLINE,
  INDUSTRIAL_TUI_VERSION,
  detectTuiCapabilities,
  industrialTuiStageWidth,
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
      caps: { unicode: true, emoji: true, color: true, narrow: false, width: 100, height: 0 },
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
    expect(home).toContain('SYSTEMS');
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
      caps: { unicode: false, emoji: false, color: false, narrow: true, width: 60, height: 0 },
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

  // TASK RING-TUI-FIX-01: the four CEO defects, pinned as regression tests.
  it('banner is centered with left padding and never printed at column 0 raw', () => {
    const systems = { engine: 'ENGINE HEALTHY', boundary: 'BOUNDARY ENFORCED', audit: 'AUDIT LOGGING', telemetry: 'T-07 CRITICAL RMS 2.637', mode: 'EVIDENCE-ONLY' as const };
    const home = renderIndustrialTuiHome({ systems, caps: { unicode: true, emoji: true, color: false, narrow: false, width: 100, height: 0 }, projectLabel: 'demo-plant', branch: 'main' });
    const rows = home.split('\n');
    for (let i = 0; i < CEO_BANNER.length; i++) {
      const row = rows[i];
      expect(row.length).toBeGreaterThan(CEO_BANNER[i].length);
      expect(row.startsWith(' ')).toBe(true);
      expect(row).toContain(CEO_BANNER[i]);
    }
  });

  it('home render at narrow 80 cols keeps every line within bounds', () => {
    const systems = { engine: 'ENGINE HEALTHY', boundary: 'BOUNDARY ENFORCED', audit: 'AUDIT LOGGING', telemetry: 'T-07 CRITICAL RMS 2.637', mode: 'EVIDENCE-ONLY' as const };
    const home = renderIndustrialTuiHome({ systems, caps: { unicode: true, emoji: true, color: false, narrow: false, width: 80, height: 0 }, projectLabel: 'demo-plant', branch: 'main' });
    const rows = home.split('\n');
    const strip = (v: string): string => v.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
    for (const row of rows) expect(strip(row).length).toBeLessThanOrEqual(80);
    for (const row of CEO_BANNER) expect(home).toContain(row);
  });

  it('input card borders always close at 80 cols (rounded corners present)', () => {
    const systems = { engine: 'ENGINE HEALTHY', boundary: 'BOUNDARY NOT CHECKED IN THIS SESSION', audit: 'AUDIT NOT CHECKED IN THIS SESSION', telemetry: 'T-07 CRITICAL RMS 2.637', mode: 'EVIDENCE-ONLY' as const };
    const home = renderIndustrialTuiHome({ systems, caps: { unicode: true, emoji: true, color: false, narrow: false, width: 80, height: 0 }, projectLabel: 'demo-plant', branch: 'main' });
    const strip = (v: string): string => v.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
    const rows = home.split('\n').map(strip);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(80);
    const top = rows.find((r) => r.includes('╭') && r.includes('╮'));
    const bottom = rows.find((r) => r.includes('╰') && r.includes('╯'));
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    const tops = rows.filter((r) => r.includes('╭'));
    const bottoms = rows.filter((r) => r.includes('╰'));
    // RENDERING-ONLY UPDATE (RING-TUI-LAYOUT-01): Systems is now a second
    // bordered stage panel, so two panels close; borders still always close.
    expect(tops).toHaveLength(2);
    expect(bottoms).toHaveLength(2);
    expect(rows.filter((r) => r.includes('│')).length).toBeGreaterThanOrEqual(3);
  });

  it('Systems panel sanitizes firewall/audit failures (no raw adapter text)', async () => {
    const container = createServiceContainer(root);
    const systems = await readIndustrialTuiSystems(container, root, 'evidence-only');
    const home = renderIndustrialTuiHome({ systems, caps: { unicode: true, emoji: true, color: false, narrow: false, width: 100, height: 0 }, projectLabel: 'demo-plant', branch: 'main' });
    for (const leak of ['firewall', 'Firewall', 'ENOENT', 'inactive', 'BLOCKED (', 'CHECK FAILED', 'CHAIN INVALID']) {
      expect(home).not.toContain(leak);
    }
    expect(home).toContain('SYSTEMS');
    expect(home).toContain('T-07 CRITICAL RMS 2.637');
  });

  it('dead layout is alive: breathing room, invitation copy, live status footer', () => {
    const systems = { engine: 'ENGINE HEALTHY', boundary: 'BOUNDARY ENFORCED', audit: 'AUDIT LOGGING', telemetry: 'T-07 CRITICAL RMS 2.637', mode: 'EVIDENCE-ONLY' as const };
    const home = renderIndustrialTuiHome({ systems, caps: { unicode: true, emoji: true, color: false, narrow: false, width: 100, height: 0 }, projectLabel: 'demo-plant', branch: 'main' });
    expect(home).toContain('Type /ring to talk to Ring');
    expect(home).toContain('demo-plant:main');
    expect(home).toContain('v' + INDUSTRIAL_TUI_VERSION);
    expect(home).toContain('\n\n');
  });
  it('detectTuiCapabilities degrades without crashing', () => {
    const narrow = new PassThrough() as PassThrough & { columns?: number };
    narrow.columns = 60;
    const caps = detectTuiCapabilities(narrow);
    expect(caps.width).toBe(60);
    expect(caps.narrow).toBe(true);
  });

  // TASK RING-TUI-LAYOUT-01: centered-stage layout grammar (rendering only).
  describe('RING-TUI-LAYOUT-01: centered stage', () => {
    const sys = {
      engine: 'ENGINE HEALTHY',
      boundary: 'BOUNDARY ENFORCED',
      audit: 'AUDIT LOGGING',
      telemetry: 'T-07 CRITICAL RMS 2.637',
      mode: 'EVIDENCE-ONLY' as const,
    };
    const strip = (v: string): string => v.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
    const renderAt = (w: number, extra: Record<string, unknown> = {}): string[] =>
      strip(
        renderIndustrialTuiHome({
          systems: sys,
          caps: { unicode: true, emoji: false, color: false, narrow: w < 80, width: w, height: 0 },
          projectLabel: 'demo-plant',
          branch: 'main',
          ...extra,
        }),
      ).split('\n');
    const leftPad = (row: string): number => row.length - row.trimStart().length;

    it('stage geometry: ~90% capped at 100, centered; narrow collapses to 1-col margins', () => {
      expect(industrialTuiStageWidth(80)).toEqual({ stage: 72, pad: 4 });
      expect(industrialTuiStageWidth(100)).toEqual({ stage: 90, pad: 5 });
      expect(industrialTuiStageWidth(140)).toEqual({ stage: 100, pad: 20 });
      expect(industrialTuiStageWidth(60)).toEqual({ stage: 58, pad: 1 });
      expect(industrialTuiStageWidth(40)).toEqual({ stage: 38, pad: 1 });
    });

    it('every rendered line fits the terminal at 80, 100 and 140 cols; footer is last', () => {
      for (const w of [80, 100, 140]) {
        const rows = renderAt(w);
        for (const row of rows) expect([...row].length).toBeLessThanOrEqual(w);
        const last = rows[rows.length - 1];
        expect(last).toContain('demo-plant:main');
        expect(last).toContain('evidence-only');
        expect(last).toContain('operator');
        expect(last).toContain('v' + INDUSTRIAL_TUI_VERSION);
        expect(last).toContain('ctrl+c');
        expect(rows[rows.length - 2]).toBe('');
        expect(rows.some((r) => r.includes('SYSTEMS'))).toBe(true);
      }
    });

    it('stage is centered: content never hugs the left edge below the banner', () => {
      for (const w of [80, 100, 140]) {
        const { stage, pad } = industrialTuiStageWidth(w);
        const rows = renderAt(w);
        const cardTop = rows.findIndex((r) => r.includes('\u256d'));
        expect(cardTop).toBeGreaterThan(0);
        expect(leftPad(rows[cardTop])).toBe(pad);
        const cardBottom = rows.findIndex((r, i) => i > cardTop && r.includes('\u2570'));
        expect(leftPad(rows[cardBottom])).toBe(pad);
        // right margin mirrors the left (equal-ish, within rounding)
        const rightMargin = w - [...rows[cardTop]].length;
        expect(Math.abs(rightMargin - pad)).toBeLessThanOrEqual(1);
        expect([...rows[cardTop]].length).toBe(pad + stage);
        // Systems + invitation live inside the stage too
        const systemsHeader = rows.find((r) => r.includes('SYSTEMS'))!;
        expect(leftPad(systemsHeader)).toBe(pad);
        const invitation = rows.find((r) => r.includes('Type /ring'))!;
        expect(leftPad(invitation)).toBe(pad);
        // wide terminals center MORE, lines do not get longer without bound
        expect(stage).toBeLessThanOrEqual(100);
      }
    });

    it('vertical rhythm: no section touches another; input card is vertically centered', () => {
      const rows = renderAt(100);
      const idx = (needle: string): number => rows.findIndex((r) => r.includes(needle));
      const bannerEnd = 5;
      const cardTop = idx('\u256d');
      const cardBottom = idx('\u2570');
      const systemsHeader = idx('SYSTEMS');
      const invitation = idx('Type /ring');
      expect(rows[bannerEnd + 1]).toContain('MAOS Industrial');
      expect(rows[cardTop - 1]).toBe('');
      // card interior: blank row directly inside top and bottom borders
      expect(rows[cardTop + 1]).toContain('\u2502');
      expect(strip(rows[cardTop + 1]).replace(/[\u2502\u2503 ]/g, '')).toBe('');
      expect(strip(rows[cardBottom - 1]).replace(/[\u2502\u2503 ]/g, '')).toBe('');
      const placeholder = idx('Ask your plant anything');
      expect(placeholder).toBeGreaterThan(cardTop + 1);
      expect(placeholder).toBeLessThan(cardBottom - 1);
      expect(rows[cardBottom + 1]).toBe('');
      expect(systemsHeader).toBe(cardBottom + 2);
      expect(rows[invitation - 1]).toBe('');
      expect(rows[invitation + 2]).toBe('');
    });

    it('empty state shows the invitation + 3 ghost rows; first run replaces them', () => {
      expect(INDUSTRIAL_TUI_SUGGESTIONS).toHaveLength(3);
      const empty = renderAt(100).join('\n');
      expect(empty).toContain('Try one of these:');
      for (const suggestion of INDUSTRIAL_TUI_SUGGESTIONS) {
        expect(strip(empty).replace(/\s+/g, ' ')).toContain(suggestion.split(' ').slice(0, 3).join(' '));
      }
      const afterRun = renderAt(100, { empty: false }).join('\n');
      expect(afterRun).not.toContain('Try one of these:');
      expect(afterRun).toContain('Ask your plant anything...');
    });

    it('status bar is inverse-styled and spans the stage when color is on', () => {
      // chalk suppresses ANSI when piped; force a level so styling is observable.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const chalk = require('chalk');
      const prevLevel = chalk.level;
      chalk.level = 1;
      let colored: string;
      try {
        colored = renderIndustrialTuiHome({
        systems: sys,
        caps: { unicode: true, emoji: false, color: true, narrow: false, width: 100, height: 0 },
        projectLabel: 'demo-plant',
        branch: 'main',
        });
      } finally {
        chalk.level = prevLevel;
      }
      const rows = colored!.split('\n');
      const last = rows[rows.length - 1];
      expect(last).toContain('\u001b[7m');
      expect(strip(last).trim().startsWith('demo-plant:main')).toBe(true);
    });

    it('footer pins to the bottom row when the terminal height is known', () => {
      const rows = renderAt(100, { height: 40 });
      expect(rows).toHaveLength(40);
      expect(rows[39]).toContain('demo-plant:main');
      expect(rows[38]).toBe('');
      const short = renderAt(100, { height: 10 });
      expect(short[short.length - 1]).toContain('demo-plant:main');
    });

    it('narrow safety: below 80 cols boxes still close and the banner falls back gracefully', () => {
      for (const w of [40, 60, 79]) {
        const rows = renderAt(w);
        for (const row of rows) expect([...row].length).toBeLessThanOrEqual(w);
        expect(rows.filter((r) => r.includes('\u256d'))).toHaveLength(2);
        expect(rows.filter((r) => r.includes('\u2570'))).toHaveLength(2);
        expect(rows[rows.length - 1]).toContain('ctrl+c');
      }
      const rows40 = renderAt(40);
      // Banner falls back gracefully at 40 cols: stage is 38 wide, so the
      // 38-col CEO banner still fits exactly (never truncated mid-glyph, no crash).
      expect(rows40.join('\n')).toContain('MAOS Industrial');
      for (const row of rows40) expect([...row].length).toBeLessThanOrEqual(40);
    });

    it('Ring header and approval card are stage-centered and close at 3 widths', () => {
      for (const w of [80, 100, 140]) {
        const { pad } = industrialTuiStageWidth(w);
        const header = strip(
          renderRingModeHeader(
            { unicode: true, emoji: false, color: false, narrow: w < 80, width: w, height: 0 },
            'EVIDENCE-ONLY',
          ),
        ).split('\n');
        for (const row of header) expect([...row].length).toBeLessThanOrEqual(w);
        expect(header[0].startsWith(' '.repeat(pad) + '\u256d')).toBe(true);
        expect(header[header.length - 1].includes('\u2570')).toBe(true);
        const card = strip(
          renderIndustrialTuiApprovalCard(
            { tool: 'create_work_order', approvalId: 'approval-1' },
            { unicode: true, emoji: false, color: false, narrow: w < 80, width: w, height: 0 },
          ),
        ).split('\n');
        for (const row of card) expect([...row].length).toBeLessThanOrEqual(w);
        expect(card[0].startsWith(' '.repeat(pad))).toBe(true);
        expect(card.join('\n')).toContain('APPROVAL NEEDED');
        expect(card.join('\n')).toContain('Default is No');
      }
    });

    it('headless --json rendering is untouched by the stage (no layout bytes leak)', () => {
      const home = renderAt(100).join('\n');
      expect(home).not.toContain('"exitCode"');
      expect(home).not.toContain('JSON');
    });
  });
});

