/**
 * TASK RING-TUI-01: MAOS Industrial home TUI + embedded Ring `/ring` mode.
 * TASK RING-TUI-LAYOUT-01: centered-stage layout grammar (rendering only).
 *
 * Home screen: the CEO-designed ASCII banner (byte-identical, never edited),
 * `MAOS Industrial · v0.4.0` + the tagline, an operator input card styled after
 * `src/cli/repl.ts` (rounded border, status badges), a Systems panel whose
 * values are read from the real health/boundary/audit/telemetry paths (never
 * hardcoded verdicts), a slash-command hint row, and a pinned status bar.
 * Stage: ~90% of terminal width, max 100 cols, min margin 2; below 80 cols
 * full-width with 1-col margins. Ring accent: amber #F59E0B (plant-floor).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import chalk from 'chalk';
import {
  RING_CLI_EXIT,
  RingCliServiceOverrides,
  detectRingMode,
  extractRingVerdict,
  isRingRefusalAnswer,
  ringExitForSnapshot,
  runRingHeadless,
  safeTerminalText,
} from './ring-cli';
import type { RingCliExitCode } from './ring-cli';
import { RingAgentService } from '../service/ring-agent-service';
import { RingThreadService } from '../service/ring-thread-service';
import { DEFAULT_RING_ROLE, isRingRole, isRingThreadId } from '../service/ring-contract';
import type { RingRole } from '../service/ring-contract';
import type { RingAgentWireEvent } from '../service/ring-agent-service';
import { getRingRolePersona } from '../service/ring-roles';
import { listRingSkills, parseRingSkillCommand } from '../service/ring-skills';
import { createServiceContainer } from '../service';
import type { ServiceContainer } from '../service';
import { analyzeTelemetryCsv, loadTelemetryDemoThresholds } from './telemetry-analysis';

export const INDUSTRIAL_TUI_VERSION = '0.4.0';

// -- CEO banner (byte-identical - NEVER edit). The CEO designed this
// -- ASCII banner himself. Asserted byte-for-byte in tests.
export const INDUSTRIAL_TUI_BANNER: readonly string[] = [
  '██╗███╗   ██╗██████╗ ██╗   ██╗███████╗',
  '██║████╗  ██║██╔══██╗██║   ██║██╔════╝',
  '██║██╔██╗ ██║██║  ██║██║   ██║███████╗',
  '██║██║╚██╗██║██║  ██║██║   ██║╚════██║',
  '██║██║ ╚████║██████╔╝╚██████╔╝███████║',
  '╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝ ╚══════╝',
];

export const INDUSTRIAL_TUI_TAGLINE = 'Your plant. Your data. Your rules.';

export interface IndustrialTuiOptions {
  projectRoot?: string;
  input?: Readable;
  output?: Writable;
  services?: RingCliServiceOverrides;
  container?: ServiceContainer;
  /** Test hook: answers to Ring approval prompts, consumed in order. Default: deny. */
  approvalAnswers?: string[];
}

export interface TuiCapabilities {
  readonly unicode: boolean;
  readonly emoji: boolean;
  readonly color: boolean;
  readonly narrow: boolean;
  readonly width: number;
  /** Terminal rows when known (TTY stdout.rows); 0 = unknown (piped/tests). */
  readonly height: number;
}

function envFlag(name: string): string {
  try {
    return String(process.env[name] ?? '');
  } catch {
    return '';
  }
}

function terminalHeight(output: Writable): number {
  const fromOutput = (output as Writable & { rows?: unknown }).rows;
  if (typeof fromOutput === 'number' && Number.isFinite(fromOutput) && fromOutput > 0) {
    return Math.floor(fromOutput);
  }
  try {
    const rows = (process.stdout as unknown as { rows?: unknown }).rows;
    if (typeof rows === 'number' && Number.isFinite(rows) && rows > 0) return Math.floor(rows);
  } catch {
    /* stdout unavailable under test harnesses */
  }
  return 0;
}

/**
 * Centered stage geometry (RING-TUI-LAYOUT-01 rule 1 + 7).
 * >= 80 cols: stage = clamp(round(0.9 * width), 40, 100), centered, margin >= 2.
 * < 80 cols: full-width stage with 1-col margins. Pad is the left offset.
 */
export function stageWidth(termWidth: number): { stage: number; pad: number } {
  const w = Math.max(1, Math.floor(termWidth) || 80);
  if (w < 80) return { stage: Math.max(1, w - 2), pad: 1 };
  const stage = Math.min(100, Math.max(40, Math.round(w * 0.9)));
  return { stage, pad: Math.max(2, Math.floor((w - stage) / 2)) };
}

function terminalWidth(output: Writable): number {
  const fromOutput = (output as Writable & { columns?: unknown }).columns;
  if (typeof fromOutput === 'number' && Number.isFinite(fromOutput) && fromOutput > 0) {
    return Math.floor(fromOutput);
  }
  const fromEnv = Number.parseInt(envFlag('COLUMNS'), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 80;
}

/** Visible width of a rendered row: strip ANSI, count code points (no wcwidth dep). */
function visibleWidth(s: string): number {
  return [...stripAnsiForWidth(s)].length;
}

/** Process stdout column budget the layout may use (never the raw banner width). */
function stdoutColumns(fallback: number): number {
  try {
    const cols = (process.stdout as unknown as { columns?: unknown }).columns;
    if (typeof cols === "number" && Number.isFinite(cols) && cols > 0) return Math.floor(cols);
  } catch {
    /* stdout unavailable under test harnesses - fall through */
  }
  const fromEnv = Number.parseInt(envFlag("COLUMNS"), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return fallback;
}

/** Clamp a rendered line to the terminal width (truncate, never wrap the border). */
function fitLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  const chars = [...stripAnsiForWidth(line)];
  return chars.slice(0, Math.max(0, width)).join('');
}

/** Left-pad a banner row so a fixed-width block sits centered in the used width. */
function centerPad(rowWidth: number, usedWidth: number): string {
  return ' '.repeat(Math.max(0, Math.floor((usedWidth - rowWidth) / 2)));
}


/** Capability detection via env/columns only. No platform branch here. */
export function detectTuiCapabilities(output: Writable): TuiCapabilities {
  const width = terminalWidth(output);
  const lang = `${envFlag('LANG')}${envFlag('LC_ALL')}${envFlag('LC_CTYPE')}`.toUpperCase();
  const asciiLocale = /^(C|POSIX)([.:]|$)/.test(lang) || /ANSI_X3\.4|US-ASCII|ASCII/.test(lang);
  const noUnicode = /^(0|no|off|false)$/i.test(envFlag('NO_UNICODE')) || asciiLocale;
  const noEmoji = /^(0|no|off|false)$/i.test(envFlag('NO_EMOJI')) || noUnicode;
  const noColor = /^(0|no|off|false)$/i.test(envFlag('NO_COLOR'));
  const isTty = Boolean((output as Writable & { isTTY?: unknown }).isTTY);
  return {
    unicode: !noUnicode && (isTty || !asciiLocale),
    emoji: !noEmoji && (isTty || !asciiLocale),
    color: !noColor,
    narrow: width < 80,
    width,
    height: terminalHeight(output),
  };
}

export interface IndustrialTuiSystems {
  engine: string;
  boundary: string;
  audit: string;
  telemetry: string;
  mode: 'HOSTED' | 'EVIDENCE-ONLY';
}

function engineLine(container: ServiceContainer): string {
  try {
    const diags = container.health.runDiagnostics();
    const failed = diags.filter((d) => !d.passed);
    if (failed.length === 0) return 'ENGINE HEALTHY';
    return 'ENGINE NOT CHECKED IN THIS SESSION';
  } catch {
    return 'ENGINE NOT CHECKED IN THIS SESSION';
  }
}

async function boundaryLine(container: ServiceContainer): Promise<string> {
  try {
    const status = await container.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
    if (status.overallStatus === 'VERIFIED') return 'BOUNDARY ENFORCED';
    return 'BOUNDARY NOT CHECKED IN THIS SESSION';
  } catch {
    return 'BOUNDARY NOT CHECKED IN THIS SESSION';
  }
}

function auditLine(container: ServiceContainer): string {
  try {
    const chain = container.audit.verifyChain();
    if (chain.valid) return 'AUDIT LOGGING';
    return 'AUDIT NOT CHECKED IN THIS SESSION';
  } catch {
    return 'AUDIT NOT CHECKED IN THIS SESSION';
  }
}

/** Deterministic RMS recomputed from the shipped T-07 CSV. Never hardcoded. */
export function readIndustrialTuiTelemetry(projectRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'));
    const metrics = analyzeTelemetryCsv(raw, loadTelemetryDemoThresholds(projectRoot));
    return `T-07 ${metrics.verdict} RMS ${metrics.overallVibrationRms.toFixed(3)}`;
  } catch {
    return 'T-07 TELEMETRY UNAVAILABLE';
  }
}

export async function readIndustrialTuiSystems(
  container: ServiceContainer,
  projectRoot: string,
  mode: 'hosted' | 'evidence-only',
): Promise<IndustrialTuiSystems> {
  return {
    engine: safeTerminalText(engineLine(container)),
    boundary: safeTerminalText(await boundaryLine(container)),
    audit: safeTerminalText(auditLine(container)),
    telemetry: safeTerminalText(readIndustrialTuiTelemetry(projectRoot)),
    mode: mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY',
  };
}
function borderChars(unicode: boolean): { tl: string; tr: string; bl: string; br: string; h: string; v: string } {
  return unicode
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
}

function badge(emoji: boolean, okText: string, ok: boolean): string {
  if (!emoji) return ok ? '[OK]' : '[!!]';
  return ok ? okText : '!!';
}

function stripAnsiForWidth(s: string): string {
  return s.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}

export interface IndustrialTuiHomeModel {
  systems: IndustrialTuiSystems;
  caps: TuiCapabilities;
  projectLabel: string;
  branch: string;
  /** Status-bar role segment. Default: operator. */
  role?: string;
  /** Terminal rows when known; enables the pinned-footer filler. Default 0. */
  height?: number;
  /** False once a run has produced transcript; hides the ghost rows. Default true. */
  empty?: boolean;
}

/** Empty-state ghost rows (rule 6): plant-floor invitations, never dead space. */
export const INDUSTRIAL_TUI_SUGGESTIONS: readonly string[] = [
  'Check T-07 vibration and tell me if it is safe to keep running',
  '/handover — shift handover brief for the next crew',
  '/sop T-07 — pull the standard procedure for this turbine',
];

function gitBranchLabel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('child_process');
    return String(
      cp.execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).trim();
  } catch {
    return '';
  }
}

/** Narrow-terminal ASCII fallback banner (layout only; CEO bytes stay untouched). */
const INDUSTRIAL_TUI_BANNER_FALLBACK: readonly string[] = [
  'MAOS',
  'INDUSTRIAL',
];

function bannerRowsForWidth(bannerWidth: number): readonly string[] {
  if (bannerWidth >= 38) return INDUSTRIAL_TUI_BANNER;
  return INDUSTRIAL_TUI_BANNER_FALLBACK;
}

/** Wrap words to fit a width; overlong words are hard-cut. Never returns an empty array. */
function wrapCellText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const rows: string[] = [];
  let current = '';
  for (const word of words) {
    let rest = word;
    while (visibleWidth(rest) > w) {
      if (current) {
        rows.push(current);
        current = '';
      }
      rows.push([...rest].slice(0, w).join(''));
      rest = [...rest].slice(w).join('');
    }
    const candidate = current ? current + ' ' + rest : rest;
    if (visibleWidth(candidate) <= w) {
      current = candidate;
    } else {
      if (current) rows.push(current);
      current = rest;
    }
  }
  rows.push(current);
  return rows;
}

/** Bordered stage row without the amber bar: borders close at `outerWidth`. */
function plainRow(
  b: { tl: string; tr: string; bl: string; br: string; h: string; v: string },
  edge: (s: string) => string,
  inner: string,
  outerWidth: number,
): string {
  const innerWidth = Math.max(1, outerWidth - 4);
  const padded = inner + ' '.repeat(Math.max(0, innerWidth - visibleWidth(inner)));
  return edge(b.v + ' ') + padded + edge(' ' + b.v);
}

/** Render one bordered card row whose borders always close at the given width. */
function cardRow(
  b: { tl: string; tr: string; bl: string; br: string; h: string; v: string },
  edge: (s: string) => string,
  inner: string,
  innerWidth: number,
): string {
  const padded = inner + ' '.repeat(Math.max(0, innerWidth - visibleWidth(inner)));
  return edge(b.v + ' ') + padded + edge(' ' + b.v);
}

function layoutIndustrialTuiHome(model: IndustrialTuiHomeModel, stdoutWidth?: number): string[] {
  const { systems, caps, projectLabel, branch } = model;
  const role = model.role || 'operator';
  const termWidth = Math.max(20, Math.floor(stdoutWidth ?? caps.width ?? 80) || 80);
  const height = Math.max(0, Math.floor(model.height ?? caps.height ?? 0) || 0);
  const { stage, pad } = stageWidth(termWidth);
  const P = ' '.repeat(pad);
  const b = borderChars(caps.unicode);
  const slate = chalk.hex('#64748B');
  const dimEdge = chalk.hex('#334155');
  const amber = chalk.hex('#F59E0B');
  const amberBar = amber('\u2503');
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line === '' ? '' : P + line);
  };

  // Banner (display) \u2014 centered in the stage; CEO bytes untouched.
  const bannerRows = bannerRowsForWidth(stage);
  const widestBanner = Math.max(...bannerRows.map((row) => [...row].length));
  if (stage >= widestBanner) {
    const bannerPad = centerPad(widestBanner, stage);
    for (const row of bannerRows) push(bannerPad + row);
  } else {
    for (const row of bannerRows) push([...row].slice(0, stage).join(''));
  }
  // Quiet subline: nameplate + tagline, centered, slate/dim.
  const nameplate = `MAOS Industrial \u00b7 v${INDUSTRIAL_TUI_VERSION}`;
  push(' '.repeat(Math.max(0, Math.floor((stage - visibleWidth(nameplate)) / 2))) + slate(nameplate));
  push(
    ' '.repeat(Math.max(0, Math.floor((stage - INDUSTRIAL_TUI_TAGLINE.length) / 2))) +
      chalk.gray(INDUSTRIAL_TUI_TAGLINE),
  );
  push('');

  // Input card: full stage width, blank inside top+bottom (vertical centering
  // in its region), amber accent for Ring/operator, neutral slate at home.
  const cardW = stage;
  const innerWidth = Math.max(1, cardW - 4);
  const textWidth = Math.max(1, innerWidth - 2);
  const homeNeutral = role !== 'operator';
  const edge = homeNeutral ? dimEdge : amber;
  const badgeMode = systems.mode === 'HOSTED' ? 'hosted' : 'evidence-only';
  const opBadgePlain = 'Operator \u00b7 ' + badgeMode + ' \u00b7 T-07';
  const placeholderRows = wrapCellText('Ask your plant anything...', textWidth);
  const badgeRows = wrapCellText(opBadgePlain, textWidth);
  const richBadge =
    chalk.bold.white('Operator') + ' ' + chalk.gray('\u00b7') + ' ' + chalk.yellow(badgeMode) + ' ' + chalk.gray('\u00b7') + ' ' + chalk.cyan('T-07');
  push(edge(b.tl + b.h.repeat(Math.max(0, cardW - 2)) + b.tr));
  push(cardRow(b, edge, amberBar + ' ', innerWidth));
  for (const row of placeholderRows) {
    push(cardRow(b, edge, amberBar + ' ' + chalk.gray(row), innerWidth));
  }
  // Empty state: ghost suggestions replace dead space inside the card area.
  if (model.empty !== false) {
    push(cardRow(b, edge, amberBar + ' ', innerWidth));
    push(cardRow(b, edge, amberBar + ' ' + slate('Try one of these:'), innerWidth));
    for (const suggestion of INDUSTRIAL_TUI_SUGGESTIONS) {
      for (const row of wrapCellText(suggestion, Math.max(1, textWidth - 3))) {
        push(cardRow(b, edge, amberBar + ' ' + chalk.gray('  ' + row), innerWidth));
      }
    }
  }
  push(cardRow(b, edge, amberBar + ' ', innerWidth));
  if (badgeRows.length === 1 && badgeRows[0] === opBadgePlain) {
    push(cardRow(b, edge, amberBar + ' ' + richBadge, innerWidth));
  } else {
    for (const row of badgeRows) {
      push(cardRow(b, edge, amberBar + ' ' + chalk.gray(row), innerWidth));
    }
  }
  push(cardRow(b, edge, amberBar + ' ', innerWidth));
  push(edge(b.bl + b.h.repeat(Math.max(0, cardW - 2)) + b.br));
  push('');

  // Systems: small-caps dim header, contained in a bordered stage panel.
  const engineBad = systems.engine !== 'ENGINE HEALTHY' && !/NOT CHECKED/.test(systems.engine);
  const boundaryBad = systems.boundary !== 'BOUNDARY ENFORCED' && !/NOT CHECKED/.test(systems.boundary);
  const auditBad = systems.audit !== 'AUDIT LOGGING' && !/NOT CHECKED/.test(systems.audit);
  const telemetryBad = !/RMS/.test(systems.telemetry);
  const sysRows: Array<[string, boolean]> = [
    [badge(caps.emoji, 'OK', !engineBad) + ' ' + systems.engine, engineBad],
    [badge(caps.emoji, 'OK', !boundaryBad) + ' ' + systems.boundary, boundaryBad],
    [badge(caps.emoji, 'OK', !auditBad) + ' ' + systems.audit, auditBad],
    [badge(caps.emoji, 'OK', !telemetryBad) + ' ' + systems.telemetry, telemetryBad],
  ];
  push(slate('SYSTEMS'));
  push(dimEdge(b.tl + b.h.repeat(Math.max(0, cardW - 2)) + b.tr));
  for (const [text, isBad] of sysRows) {
    const paint = isBad ? chalk.yellow : chalk.green;
    for (const wrapped of wrapCellText(safeTerminalText(text), Math.max(1, innerWidth))) {
      push(plainRow(b, dimEdge, paint(wrapped), cardW));
    }
  }
  const modeText = 'Mode: ' + systems.mode;
  push(
    plainRow(b, dimEdge, systems.mode === 'HOSTED' ? chalk.green(modeText) : chalk.yellow(modeText), cardW),
  );
  push(dimEdge(b.bl + b.h.repeat(Math.max(0, cardW - 2)) + b.br));
  push('');

  // Invitation: amber = Ring identity, used sparingly.
  push(amber('Type /ring to talk to Ring'));
  push(chalk.gray('/ring \u00b7 /verify \u00b7 /help   \u2014 type /ring to talk to Ring, /back returns here'));
  push('');

  // Status bar: pinned last, stage width, inverse + dim (smallest type).
  // Narrow degradation drops tab-complete, then role, then version; the
  // project:branch and ctrl+c hint always survive so the bar never clips blind.
  const left = projectLabel + (branch ? ':' + branch : '');
  const barCandidates = [
    `${left} \u00b7 ${badgeMode} \u00b7 ${role} \u00b7 v${INDUSTRIAL_TUI_VERSION} \u00b7 ctrl+c quit \u00b7 tab complete`,
    `${left} \u00b7 ${badgeMode} \u00b7 ${role} \u00b7 v${INDUSTRIAL_TUI_VERSION} \u00b7 ctrl+c quit`,
    `${left} \u00b7 ${badgeMode} \u00b7 v${INDUSTRIAL_TUI_VERSION} \u00b7 ctrl+c quit`,
    `${left} \u00b7 ${badgeMode} \u00b7 ctrl+c quit`,
    `${left} \u00b7 ctrl+c quit`,
  ];
  const barPlain = barCandidates.find((c) => visibleWidth(c) <= stage) ?? barCandidates[barCandidates.length - 1];
  const barBody = fitLine(barPlain, stage);
  const barStyled = chalk.inverse(' ' + barBody.padEnd(Math.max(0, stage - 1)));
  // Pinned footer: filler only when the terminal height is known (real TTY).
  if (height > 0) {
    const filler = Math.max(0, height - lines.length - 1);
    for (let i = 0; i < filler; i++) lines.push('');
  }
  lines.push(P + barStyled);
  return lines.map((line) => (visibleWidth(line) > termWidth ? fitLine(line, termWidth) : line));
}

export function renderIndustrialTuiHome(model: IndustrialTuiHomeModel): string {
  return layoutIndustrialTuiHome(model).join('\n');
}

/** Stage geometry, exported for layout assertions. */
export { stageWidth as industrialTuiStageWidth };

export function renderRingModeHeader(caps: TuiCapabilities, mode: 'HOSTED' | 'EVIDENCE-ONLY', thread?: string): string {
  const b = borderChars(caps.unicode);
  const { stage, pad } = stageWidth(caps.width || 80);
  const P = ' '.repeat(pad);
  const edge = chalk.hex('#F59E0B');
  const title = `${chalk.bold.hex('#F59E0B')('RING')} ${mode === 'HOSTED' ? chalk.green(mode) : chalk.yellow(mode)}`;
  const threadLine = thread
    ? chalk.gray(`thread ${safeTerminalText(thread)} · /back returns home`)
    : chalk.gray('/back returns home · /help commands');
  const top = P + edge(b.tl + b.h.repeat(Math.max(0, stage - 2)) + b.tr);
  const bottom = P + edge(b.bl + b.h.repeat(Math.max(0, stage - 2)) + b.br);
  return [top, P + plainRow(b, edge, title, stage), P + plainRow(b, edge, threadLine, stage), bottom].join('\n');
}

/** Impossible-to-miss approval card. The `[y/N]` question below still defaults to No. */
export function renderIndustrialTuiApprovalCard(
  event: { tool?: unknown; approvalId?: unknown },
  caps?: TuiCapabilities,
): string {
  const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
  const approvalId = typeof event.approvalId === 'string' ? event.approvalId : '';
  const width = caps?.width || 80;
  const { stage, pad } = stageWidth(width);
  const P = ' '.repeat(pad);
  const b = borderChars(caps?.unicode ?? true);
  const edge = chalk.yellow;
  const innerWidth = Math.max(1, stage - 4);
  const rows: string[] = [P + edge(b.tl + '='.repeat(Math.max(0, stage - 2)) + b.tr)];
  const pushRow = (styled: string, plain: string): void => {
    for (const wrapped of wrapCellText(plain, innerWidth)) {
      const styledWrapped = wrapped === plain ? styled : wrapped;
      const padded = styledWrapped + ' '.repeat(Math.max(0, innerWidth - visibleWidth(styledWrapped)));
      rows.push(P + edge(b.v + ' ') + padded + edge(' ' + b.v));
    }
  };
  pushRow(chalk.bold(`APPROVAL NEEDED: ${safeTerminalText(tool)}`), `APPROVAL NEEDED: ${safeTerminalText(tool)}`);
  if (approvalId) pushRow(chalk.gray(`approval ${safeTerminalText(approvalId)}`), `approval ${safeTerminalText(approvalId)}`);
  pushRow(
    chalk.bold('Reply y to approve, anything else denies. Default is No.'),
    'Reply y to approve, anything else denies. Default is No.',
  );
  rows.push(P + edge(b.bl + '='.repeat(Math.max(0, stage - 2)) + b.br));
  return rows.join('\n');
}

type TuiScreen = 'home' | 'ring';

/** Bare `maos-industrial` home TUI with embedded Ring `/ring` mode. */
export function runIndustrialTui(options: IndustrialTuiOptions = {}): Promise<void> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const container: ServiceContainer = options.container ?? createServiceContainer(projectRoot);
  const services: RingCliServiceOverrides = options.services ?? {
    ringAgent: container.ringAgent,
    ringThread: container.ringThread,
    audit: container.audit,
    container,
  };
  const approvalAnswers = options.approvalAnswers ? [...options.approvalAnswers] : [];
  const mode = detectRingMode(projectRoot);
  const badgeMode = (mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY') as 'HOSTED' | 'EVIDENCE-ONLY';

  const writeLine = (value: string): void => {
    output.write(`${value}\n`);
  };

  const caps = detectTuiCapabilities(output);
  const branch = gitBranchLabel();
  const projectLabel = `${path.basename(projectRoot)}`;
  let screen: TuiScreen = 'home';

  let homeShown = false;
  const showHome = async (): Promise<void> => {
    // Clear-screen on launch; breathing room between sections keeps the dead panels alive.
    if (!homeShown) output.write('c');
    homeShown = true;
    writeLine('');
    writeLine(
      renderIndustrialTuiHome({
        systems: await readIndustrialTuiSystems(container, projectRoot, mode),
        caps,
        projectLabel,
        branch,
        role: ringSession.role,
        height: caps.height,
      }),
    );
    writeLine('');
  };

  const ringSession: { role: RingRole; threadId?: string; activeRunId?: string } = { role: DEFAULT_RING_ROLE };
  const showRingHeader = (): void => {
    writeLine(renderRingModeHeader(caps, badgeMode, ringSession.threadId));
  };

  const recordApprovalAudit = (data: Record<string, unknown>): void => {
    try {
      const svc = services.audit ?? container.audit;
      svc.recordAuditEvent({ category: 'approval', source: 'ring-cli', data } as never, false);
    } catch {
      /* audit must not break the CLI */
    }
  };

  // Main readline handle: assigned below; askApproval pauses it while the
  // approval question owns stdin (same pause/resume pattern as ring-cli).
  let mainRl: readline.Interface | undefined;
  const askApproval = (question: string): Promise<boolean> => {
    const canned = approvalAnswers.shift();
    if (canned !== undefined) return Promise.resolve(/^y(es)?$/i.test(canned.trim()));
    if (mainRl) mainRl.pause();
    return new Promise((res) => {
      const q = readline.createInterface({ input, output });
      q.question(`${question} `, (answer) => {
        q.close();
        if (mainRl) mainRl.resume();
        res(/^y(es)?$/i.test(answer.trim()));
      });
    });
  };

  const ringAgent = (): RingAgentService => services.ringAgent ?? container.ringAgent;
  const ringThread = (): RingThreadService => services.ringThread ?? container.ringThread;

  const driveRingRun = async (runId: string): Promise<RingCliExitCode> => {
    let sawDelta = false;
    const startedAt = Date.now();
    const handleEvent = (event: RingAgentWireEvent): void => {
      if (event.type === 'model.delta') {
        if (typeof event.delta === 'string' && event.delta) {
          sawDelta = true;
          output.write(safeTerminalText(event.delta));
        }
        return;
      }
      if (event.type === 'model.turn') {
        if (!sawDelta && typeof event.text === 'string' && event.text) {
          writeLine(safeTerminalText('(whole text - provider does not stream) ' + event.text));
        }
        return;
      }
      if (event.type === 'plan.updated') {
        const plan = Array.isArray(event.plan) ? event.plan : [];
        for (const step of plan) {
          if (step.status === 'done') writeLine(chalk.green('[x] ' + safeTerminalText(step.step)));
          else if (step.status === 'in_progress')
            writeLine(chalk.yellow('[ ] ' + safeTerminalText(step.step) + ' (running)'));
          else writeLine(chalk.gray('[ ] ' + safeTerminalText(step.step)));
        }
        return;
      }
      if (event.type === 'tool.call') {
        const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        writeLine(chalk.cyan('>') + ' ' + chalk.bold(safeTerminalText(tool)) + ' ' + chalk.gray('- ' + elapsed + 's'));
        return;
      }
      if (event.type === 'tool.result') {
        const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
        const tail =
          typeof event.overallRms === 'number' && Number.isFinite(event.overallRms)
            ? chalk.cyan(' - RMS ' + event.overallRms.toFixed(3))
            : '';
        const verdict =
          typeof event.verdict === 'string' && event.verdict ? ' - ' + safeTerminalText(event.verdict) : '';
        writeLine(chalk.green('ok ' + safeTerminalText(tool)) + verdict + tail);
        return;
      }
      if (event.type === 'approval.pending') {
        writeLine(renderIndustrialTuiApprovalCard({ tool: event.tool, approvalId: event.approvalId }, caps));
        return;
      }
      if (event.type === 'artifact.created' && event.artifact && typeof event.artifact.path === 'string') {
        writeLine(
          chalk.bold('Artifact:') + ' ' + chalk.cyan(safeTerminalText(path.resolve(projectRoot, event.artifact.path))),
        );
      }
    };
    const agent = ringAgent();
    const unsubscribe = agent.onStreamEvent((emittedRunId, event) => {
      if (emittedRunId !== runId) return;
      handleEvent(event);
    });
    try {
      const before = agent.getRun(runId);
      if (before) for (const event of before.events) handleEvent(event);
    } catch {
      /* replay is best effort */
    }
    try {
      for (;;) {
        const snap = await agent.waitForRun(runId, 60000);
        if (!snap) {
          writeLine(chalk.red("Run '" + safeTerminalText(runId) + "' was not found."));
          return RING_CLI_EXIT.FAILED;
        }
        if (snap.status === 'running') continue;
        if (snap.status === 'awaiting_approval') {
          const pending = snap.pendingApproval;
          if (!pending) {
            const settled = await agent.waitForCompletion(runId, 60000);
            if (settled.status === 'completed' && settled.finalAnswer) {
              if (isRingRefusalAnswer(settled.finalAnswer))
                writeLine(chalk.yellow(safeTerminalText(settled.finalAnswer)));
              else {
                const verdict = extractRingVerdict(settled.finalAnswer, settled.events) ?? 'answer ready';
                writeLine(chalk.bold.cyan('Answer'));
                writeLine(chalk.bold('Verdict:') + ' ' + chalk.cyan(safeTerminalText(verdict)));
                writeLine(safeTerminalText(settled.finalAnswer));
              }
              return ringExitForSnapshot(settled);
            }
            writeLine(chalk.red('Run is awaiting approval with no pending approval.'));
            return RING_CLI_EXIT.FAILED;
          }
          writeLine(renderIndustrialTuiApprovalCard({ tool: pending.toolName, approvalId: pending.approvalId }, caps));
          const answer = await askApproval('Approve "' + pending.toolName + ' - ' + pending.summary + '"? [y/N]');
          recordApprovalAudit({
            event: 'RING_CLI_APPROVAL_PROMPT',
            runId,
            approvalId: pending.approvalId,
            toolName: pending.toolName,
            decision: answer ? 'approved' : 'denied',
          });
          agent.resolveApproval(runId, pending.approvalId, answer ? 'approved' : 'denied');
          continue;
        }
        if (snap.status === 'completed') {
          if (snap.finalAnswer && mode === 'evidence-only') {
            if (isRingRefusalAnswer(snap.finalAnswer)) {
              writeLine(chalk.yellow(safeTerminalText(snap.finalAnswer)));
              writeLine(chalk.gray('Fail-closed: no action was taken and no files were written.'));
            } else {
              const verdict = extractRingVerdict(snap.finalAnswer, snap.events) ?? 'answer ready';
              writeLine(chalk.bold.cyan('Answer'));
              writeLine(chalk.bold('Verdict:') + ' ' + chalk.cyan(safeTerminalText(verdict)));
              writeLine(safeTerminalText(snap.finalAnswer));
            }
          }
          return ringExitForSnapshot(snap);
        }
        if (snap.status === 'cancelled') {
          writeLine(chalk.bold('Run cancelled'));
          writeLine(chalk.yellow('Re-run the same prompt; nothing was written.'));
          return RING_CLI_EXIT.REFUSED_OR_CANCELLED;
        }
        writeLine(chalk.bold('Run failed'));
        writeLine(chalk.red(safeTerminalText(snap.error ?? 'unknown error')));
        return RING_CLI_EXIT.FAILED;
      }
    } finally {
      unsubscribe();
      if (ringSession.activeRunId === runId) ringSession.activeRunId = undefined;
    }
  };

  const startRingInstruction = async (instruction: string, context: Record<string, unknown>): Promise<void> => {
    let runId: string;
    try {
      runId = ringAgent().startRun(instruction, context as never);
    } catch (err) {
      writeLine(chalk.red('Error: ' + safeTerminalText(err instanceof Error ? err.message : String(err))));
      writeLine(chalk.gray('Fail-closed: nothing was started and no files were written.'));
      return;
    }
    ringSession.activeRunId = runId;
    await driveRingRun(runId);
  };

  const RING_TUI_HELP = [
    'Ring - same runs, threads and approvals as the GUI.',
    '  /handover, /rca, /permit, /loto, /sop <eq>, /report',
    '  /threads, /new [title] [role], /resume <id>, /role <r>, /verify',
    '  /back leaves Ring and returns home - exit quits',
    '  cancel cancels the running run (Ctrl+C once does the same)',
  ];
  const handleRingLine = async (line: string): Promise<'ring' | 'home' | 'exit'> => {
    const trimmed = line.trim();
    if (!trimmed) return 'ring';
    if (trimmed === '/back' || trimmed === 'back') {
      await showHome();
      return 'home';
    }
    if (trimmed === 'exit' || trimmed === 'quit') return 'exit';
    if (trimmed === 'cancel' || trimmed === '/cancel') {
      if (ringSession.activeRunId) {
        try {
          ringAgent().cancelRun(ringSession.activeRunId);
        } catch {
          /* best effort */
        }
        writeLine(chalk.yellow('Cancellation requested.'));
      } else writeLine('No run is currently active.');
      return 'ring';
    }
    if (trimmed === '/help' || trimmed === 'help' || trimmed === '?') {
      writeLine(RING_TUI_HELP.join('\n'));
      writeLine('Mode: ' + badgeMode + ' - Role: ' + ringSession.role);
      return 'ring';
    }
    if (trimmed === '/threads') {
      const ids = ringThread().listThreadIds();
      writeLine(chalk.bold.cyan('Threads'));
      if (!ids.length) writeLine('(no threads yet - use /new to start one)');
      for (const id of ids) writeLine(safeTerminalText(id) + (id === ringSession.threadId ? ' *' : ''));
      return 'ring';
    }
    if (trimmed === '/new' || trimmed.startsWith('/new ')) {
      const rest = trimmed.slice('/new'.length).trim().split(/\s+/).filter(Boolean);
      let title: string | undefined;
      let role: RingRole = ringSession.role;
      for (const part of rest) {
        if (isRingRole(part)) role = part;
        else title = title === undefined ? part : title + ' ' + part;
      }
      const thread = ringThread().createThread(title, role);
      ringSession.threadId = thread.threadId;
      ringSession.role = thread.role;
      writeLine('thread ' + safeTerminalText(thread.threadId) + ' (' + safeTerminalText(thread.role) + ')');
      showRingHeader();
      return 'ring';
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume'.length).trim().split(/\s+/)[0];
      if (!id) {
        writeLine(chalk.red('Usage: /resume <thread-id|run-id>'));
        return 'ring';
      }
      if (isRingThreadId(id)) {
        const thread = ringThread().getThread(id);
        if (!thread) {
          writeLine(chalk.red("Thread '" + safeTerminalText(id) + "' was not found."));
          return 'ring';
        }
        ringSession.threadId = thread.threadId;
        ringSession.role = thread.role;
        writeLine('resumed ' + safeTerminalText(thread.threadId) + ' (' + safeTerminalText(thread.role) + ')');
        showRingHeader();
        return 'ring';
      }
      const snap = ringAgent().getRun(id);
      if (!snap) {
        writeLine(chalk.red("No thread or run '" + safeTerminalText(id) + "' was found."));
        return 'ring';
      }
      ringSession.activeRunId = id;
      await driveRingRun(id);
      return 'ring';
    }
    if (trimmed === '/role' || trimmed.startsWith('/role ')) {
      const want = trimmed.slice('/role'.length).trim().split(/\s+/)[0];
      if (!want || !isRingRole(want)) {
        writeLine(chalk.red('Usage: /role <operator|maintenance|safety|manager>'));
        return 'ring';
      }
      ringSession.role = (getRingRolePersona(want)?.role ?? DEFAULT_RING_ROLE) as RingRole;
      writeLine('role ' + safeTerminalText(ringSession.role));
      return 'ring';
    }
    if (trimmed === '/verify') {
      const chain = container.audit.verifyChain();
      writeLine(chalk.bold.cyan('Verify'));
      writeLine(chain.valid ? chalk.green('Audit chain: valid') : chalk.red('Audit chain: invalid'));
      if (!chain.valid) for (const e of chain.errors) writeLine(safeTerminalText(e));
      if (ringSession.threadId) {
        const thread = ringThread().getThread(ringSession.threadId);
        writeLine(
          thread
            ? 'Thread: ' + thread.threadId + ' - ' + thread.runs.length + ' run(s) - role ' + thread.role
            : "Thread '" + ringSession.threadId + "' was not found.",
        );
      } else writeLine('No active thread.');
      return 'ring';
    }
    if (trimmed === '/json' || trimmed.startsWith('/json ')) {
      const instruction = trimmed.slice('/json'.length).trim();
      if (!instruction) {
        writeLine(chalk.red('Usage: /json <instruction>'));
        return 'ring';
      }
      const result = await runRingHeadless({ projectRoot, instruction, json: true, services, output });
      writeLine(chalk.gray('exit code: ' + result.exitCode));
      return 'ring';
    }
    const skillParsed = parseRingSkillCommand(trimmed);
    if (skillParsed) {
      if (!skillParsed.skill.roles || skillParsed.skill.roles.includes(ringSession.role)) {
        if (skillParsed.skill.name === 'sop' && !skillParsed.arg) {
          writeLine(chalk.red('Usage: /sop <equipment> - for example /sop T-07.'));
          return 'ring';
        }
        await startRingInstruction(trimmed, {
          skillName: skillParsed.skill.name,
          skillArg: skillParsed.arg,
          skillRole: ringSession.role,
          ...(ringSession.threadId ? { threadId: ringSession.threadId } : {}),
        });
        return 'ring';
      }
      writeLine(chalk.red('Skill /' + skillParsed.skill.name + ' is not available to role ' + ringSession.role + '.'));
      return 'ring';
    }
    if (trimmed.startsWith('/')) {
      const name = trimmed.split(/\s+/)[0];
      const known = listRingSkills().some((s) => '/' + s.name === name);
      if (!known) {
        writeLine(chalk.red("Unknown command '" + safeTerminalText(name) + "'. Type /help for supported commands."));
        return 'ring';
      }
    }
    await startRingInstruction(trimmed, {
      role: ringSession.role,
      ...(ringSession.threadId ? { threadId: ringSession.threadId } : {}),
    });
    return 'ring';
  };
  const handleHomeLine = async (line: string): Promise<'home' | 'ring' | 'exit'> => {
    const trimmed = line.trim();
    if (!trimmed) return 'home';
    if (trimmed === '/ring' || trimmed === 'ring') {
      screen = 'ring';
      showRingHeader();
      writeLine(
        chalk.gray(
          'Evidence-only mode: answers cite deterministic evidence; nothing here authorizes operating the plant.',
        ),
      );
      return 'ring';
    }
    if (trimmed === '/help' || trimmed === 'help' || trimmed === '?') {
      writeLine(
        [
          'Industrial home commands:',
          '  /ring     talk to Ring (evidence-only by default)',
          '  /verify   audit chain + boundary + engine state',
          '  /help     this help',
          '  exit      quit',
        ].join('\n'),
      );
      return 'home';
    }
    if (trimmed === 'exit' || trimmed === 'quit') return 'exit';
    if (trimmed === '/verify' || trimmed === 'verify') {
      const systems = await readIndustrialTuiSystems(container, projectRoot, mode);
      writeLine('Engine:   ' + systems.engine);
      writeLine('Boundary: ' + systems.boundary);
      writeLine('Audit:    ' + systems.audit);
      writeLine('Reading:  ' + systems.telemetry);
      writeLine('Mode:     ' + systems.mode);
      return 'home';
    }
    if (trimmed.startsWith('/')) {
      writeLine(
        chalk.red(
          "Unknown command '" + safeTerminalText(trimmed.split(/\s+/)[0]) + "'. Type /help for supported commands.",
        ),
      );
      return 'home';
    }
    screen = 'ring';
    showRingHeader();
    await startRingInstruction(trimmed, {
      role: ringSession.role,
      ...(ringSession.threadId ? { threadId: ringSession.threadId } : {}),
    });
    return 'ring';
  };

  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean((output as Writable & { isTTY?: boolean }).isTTY),
    completer: (line: string): [string[], string] => {
      const commands = [
        '/ring',
        '/back',
        '/help',
        '/verify',
        '/threads',
        '/new',
        '/resume',
        '/role',
        '/sop',
        '/json',
        'exit',
      ];
      const hits = commands.filter((c) => c.startsWith(line));
      return [hits.length ? hits : commands, line];
    },
  });
  mainRl = rl;

  return new Promise((resolve) => {
    let busy = false;
    let closing = false;
    const finish = (): void => {
      closing = true;
      rl.close();
    };
    rl.setPrompt('maos-industrial> ');
    void showHome().then(() => {
      if (!closing) rl.prompt();
    });

    const setPromptFor = (): void => {
      rl.setPrompt(screen === 'ring' ? 'ring> ' : 'maos-industrial> ');
    };

    rl.on('line', (line) => {
      if (busy) {
        const t = line.trim();
        if (t === 'cancel' || t === '/cancel') {
          if (ringSession.activeRunId) {
            try {
              ringAgent().cancelRun(ringSession.activeRunId);
            } catch {
              /* best effort */
            }
            writeLine(chalk.yellow('Cancellation requested.'));
          } else writeLine('A run is in progress. Type `cancel` to stop it.');
        } else if (t === '' || /^[yn](es|o)?$/i.test(t)) {
          // Buffered approval answer while awaiting_approval consumed it already.
        } else {
          writeLine('A run is in progress. Type `cancel` to stop it.');
        }
        return;
      }
      busy = true;
      const handler = screen === 'ring' ? handleRingLine : handleHomeLine;
      void handler(line)
        .then((next) => {
          if (next === 'exit') finish();
          else {
            screen = next;
            setPromptFor();
          }
        })
        .catch((err) => {
          writeLine(chalk.red('Error: ' + safeTerminalText(err instanceof Error ? err.message : String(err))));
          writeLine(chalk.gray('Fail-closed: nothing was started and no files were written.'));
        })
        .finally(() => {
          busy = false;
          if (!closing) rl.prompt();
        });
    });

    rl.on('SIGINT', () => {
      finish();
    });

    rl.on('close', () => {
      if (ringSession.activeRunId) {
        try {
          ringAgent().cancelRun(ringSession.activeRunId);
        } catch {
          /* best effort */
        }
      }
      resolve();
    });
  });
}

export { RING_CLI_EXIT as INDUSTRIAL_TUI_RING_EXIT };
export type { RingCliExitCode as IndustrialTuiExitCode };
