/**
 * TASK RING-TUI-01: MAOS Industrial home TUI + embedded Ring `/ring` mode.
 *
 * Home screen: the CEO-designed ASCII banner (byte-identical, never edited),
 * `MAOS Industrial · v0.3.0` + the tagline, an operator input card styled after
 * `src/cli/repl.ts` (rounded border, status badges), a Systems panel whose
 * values are read from the real health/boundary/audit/telemetry paths (never
 * hardcoded verdicts), a slash-command hint row, and a pinned footer.
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

export const INDUSTRIAL_TUI_VERSION = '0.3.0';

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
}

function envFlag(name: string): string {
  try {
    return String(process.env[name] ?? '');
  } catch {
    return '';
  }
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
    return `ENGINE DEGRADED (${failed.map((d) => String(d.check)).join(', ')})`;
  } catch {
    return 'ENGINE STATUS UNAVAILABLE';
  }
}

async function boundaryLine(container: ServiceContainer): Promise<string> {
  try {
    const status = await container.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
    if (status.overallStatus === 'VERIFIED') return 'BOUNDARY ENFORCED';
    const reason = status.blockingReason ? ` (${status.blockingReason})` : '';
    return `BOUNDARY ${status.overallStatus}${reason}`;
  } catch (err) {
    return `BOUNDARY CHECK FAILED (${err instanceof Error ? err.message : String(err)})`;
  }
}

function auditLine(container: ServiceContainer): string {
  try {
    const chain = container.audit.verifyChain();
    if (chain.valid) return 'AUDIT LOGGING';
    const first = chain.errors[0] ? ` (${chain.errors[0]})` : '';
    return `AUDIT CHAIN INVALID${first}`;
  } catch (err) {
    return `AUDIT CHECK FAILED (${err instanceof Error ? err.message : String(err)})`;
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
}

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

export function renderIndustrialTuiHome(model: IndustrialTuiHomeModel): string {
  const { systems, caps, projectLabel, branch } = model;
  const W = Math.max(40, Math.min(caps.width || 80, 100));
  const b = borderChars(caps.unicode);
  const lines: string[] = [];

  for (const row of INDUSTRIAL_TUI_BANNER) lines.push(row);
  lines.push(`MAOS Industrial · v${INDUSTRIAL_TUI_VERSION}`);
  lines.push(INDUSTRIAL_TUI_TAGLINE);
  lines.push('');

  const cardW = Math.max(36, Math.min(caps.narrow ? W - 4 : 62, W - 4));
  const pad = ' '.repeat(Math.max(0, Math.floor((W - cardW) / 2)));
  const amberBar = chalk.hex('#F59E0B')('┃');
  const edge = chalk.hex('#334155');
  const placeholder = 'Ask your plant anything...';
  const opBadge = `${chalk.bold.white('Operator')} ${chalk.gray('·')} ${chalk.yellow('evidence-only')} ${chalk.gray('·')} ${chalk.cyan('T-07')}`;
  lines.push(pad + edge(b.tl + b.h.repeat(cardW - 2) + b.tr));
  lines.push(
    pad +
      edge(b.v + ' ') +
      amberBar +
      chalk.gray(` ${placeholder}`) +
      ' '.repeat(Math.max(0, cardW - 5 - placeholder.length)) +
      edge(' ' + b.v),
  );
  lines.push(pad + edge(b.v + ' ') + amberBar + ' '.repeat(Math.max(0, cardW - 5)) + edge(' ' + b.v));
  const opLen = stripAnsiForWidth(opBadge).length;
  lines.push(
    pad + edge(b.v + ' ') + amberBar + ` ${opBadge}` + ' '.repeat(Math.max(0, cardW - 5 - opLen)) + edge(' ' + b.v),
  );
  lines.push(pad + edge(b.bl + b.h.repeat(cardW - 2) + b.br));
  lines.push('');

  const engineBad = /FAILED|INVALID|DEGRADED|UNAVAILABLE/.test(systems.engine);
  const boundaryBad = systems.boundary !== 'BOUNDARY ENFORCED';
  const auditBad = systems.audit !== 'AUDIT LOGGING';
  const telemetryBad = !/RMS/.test(systems.telemetry);
  const rows: Array<[string, boolean]> = [
    [`${badge(caps.emoji, 'OK', !engineBad)} ${systems.engine}`, engineBad],
    [`${badge(caps.emoji, 'OK', !boundaryBad)} ${systems.boundary}`, boundaryBad],
    [`${badge(caps.emoji, 'OK', !auditBad)} ${systems.audit}`, auditBad],
    [`${badge(caps.emoji, 'OK', !telemetryBad)} ${systems.telemetry}`, telemetryBad],
  ];
  lines.push('Systems');
  for (const [text, isBad] of rows) {
    lines.push(`  ${(isBad ? chalk.yellow : chalk.green)(safeTerminalText(text))}`);
  }
  lines.push(`  Mode: ${systems.mode === 'HOSTED' ? chalk.green(systems.mode) : chalk.yellow(systems.mode)}`);
  lines.push('');

  lines.push(chalk.gray('/ring · /verify · /help   — type /ring to talk to Ring, /back returns here'));
  lines.push('');

  const left = `${projectLabel}${branch ? `:${branch}` : ''}`;
  lines.push(
    `${chalk.bold.white('tab')} ${chalk.gray('complete')}   ${chalk.bold.white('ctrl+c')} ${chalk.gray('quit')}   ${chalk.gray(left)}   ${chalk.gray(`v${INDUSTRIAL_TUI_VERSION}`)}`,
  );
  return lines.join('\n');
}

export function renderRingModeHeader(caps: TuiCapabilities, mode: 'HOSTED' | 'EVIDENCE-ONLY', thread?: string): string {
  const b = borderChars(caps.unicode);
  const width = Math.max(36, Math.min(caps.narrow ? caps.width - 2 : 64, caps.width - 2));
  const title = `${chalk.bold.hex('#F59E0B')('RING')} ${mode === 'HOSTED' ? chalk.green(mode) : chalk.yellow(mode)}`;
  const stripped = stripAnsiForWidth(title).length;
  const threadLine = thread
    ? chalk.gray(`thread ${safeTerminalText(thread)} · /back returns home`)
    : chalk.gray('/back returns home · /help commands');
  const top = chalk.hex('#F59E0B')(b.tl + b.h.repeat(width - 2) + b.tr);
  const bottom = chalk.hex('#F59E0B')(b.bl + b.h.repeat(width - 2) + b.br);
  return [top, ` ${title}` + ' '.repeat(Math.max(0, width - 3 - stripped)), ` ${threadLine}`, bottom].join('\n');
}

/** Impossible-to-miss approval card. The `[y/N]` question below still defaults to No. */
export function renderIndustrialTuiApprovalCard(event: { tool?: unknown; approvalId?: unknown }): string {
  const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
  const approvalId = typeof event.approvalId === 'string' ? event.approvalId : '';
  const bar = '='.repeat(56);
  const title = `APPROVAL NEEDED: ${safeTerminalText(tool)}`;
  const warnLine = 'Reply y to approve, anything else denies. Default is No.';
  const top = chalk.yellow(`+${bar}+`);
  const bottom = chalk.yellow(`+${bar}+`);
  const row = (text: string): string => chalk.yellow('| ') + chalk.bold(text) + chalk.yellow(' |');
  return [
    top,
    row(title),
    approvalId ? chalk.yellow('| ') + chalk.gray(`approval ${safeTerminalText(approvalId)}`) + chalk.yellow(' |') : '',
    row(warnLine),
    bottom,
  ]
    .filter(Boolean)
    .join('\n');
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

  const showHome = async (): Promise<void> => {
    writeLine(
      renderIndustrialTuiHome({
        systems: await readIndustrialTuiSystems(container, projectRoot, mode),
        caps,
        projectLabel,
        branch,
      }),
    );
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
        writeLine(renderIndustrialTuiApprovalCard({ tool: event.tool, approvalId: event.approvalId }));
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
          writeLine(renderIndustrialTuiApprovalCard({ tool: pending.toolName, approvalId: pending.approvalId }));
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
