/**
 * TASK DEV-A-CLI-01: Ring CLI core (REPL + headless).
 *
 * New subcommand on bin maos-industrial: `maos-industrial ring`.
 * Does NOT add a new agent engine: calls RingAgentService in-process
 * (threads via RingThreadService, skills via parse/render + skillName
 * context, approvals via resolveApproval, streaming via onStreamEvent),
 * sharing the same `.maos/ring-runs` store as the GUI. Frozen contracts
 * apply (ring-contract.ts, tool registry, event union, thread shapes).
 *
 * Text sanitising: model output never injects terminal control sequences;
 * every rendered value passes through safeTerminalText (reused from
 * industrial-repl.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import chalk from 'chalk';
import { BASETEN_API_KEY_ENV } from '../backends/meta-api-policy';
import {
  isRingRole,
  isRingThreadId,
  DEFAULT_RING_ROLE,
} from '../service/ring-contract';
import type { RingRole } from '../service/ring-contract';
import type {
  RingAgentRunSnapshot,
  RingAgentWireEvent,
} from '../service/ring-agent-service';
import { RingAgentService } from '../service/ring-agent-service';
import { RingThreadService } from '../service/ring-thread-service';
import {
  listRingSkills,
  parseRingSkillCommand,
} from '../service/ring-skills';
import type { RingSkill } from '../service/ring-skills';
import { getRingRolePersona } from '../service/ring-roles';
import { createServiceContainer } from '../service';
import type { ServiceContainer } from '../service';
import { safeTerminalText } from './industrial-repl';
import type { AuditService } from '../service/audit-service';

export { safeTerminalText };

/** Headless exit codes (frozen by task spec). */
export const RING_CLI_EXIT = {
  COMPLETED: 0,
  FAILED: 1,
  REFUSED_OR_CANCELLED: 2,
  AWAITING_APPROVAL: 3,
} as const;

export type RingCliExitCode =
  (typeof RING_CLI_EXIT)[keyof typeof RING_CLI_EXIT];

export interface RingCliAudit {
  verifyChain: AuditService['verifyChain'];
  recordAuditEvent: AuditService['recordAuditEvent'];
}

export interface RingCliServices {
  ringAgent: RingAgentService;
  ringThread: RingThreadService;
  audit: RingCliAudit;
}

export interface RingCliServiceOverrides {
  ringAgent?: RingAgentService;
  ringThread?: RingThreadService;
  audit?: RingCliAudit;
  container?: ServiceContainer;
}

function resolveServices(
  projectRoot: string,
  injected?: RingCliServiceOverrides,
): RingCliServices {
  const container =
    injected?.container ?? createServiceContainer(projectRoot);
  return {
    ringAgent: injected?.ringAgent ?? container.ringAgent,
    ringThread: injected?.ringThread ?? container.ringThread,
    audit: injected?.audit ?? container.audit,
  };
}

export type RingMode = 'hosted' | 'evidence-only';

/** Badge-grade mode detection (mirrors the service arming rule, read-only). */
export function detectRingMode(projectRoot: string): RingMode {
  try {
    const raw = fs.readFileSync(
      path.resolve(projectRoot, '.maos', 'maos.config.json'),
      'utf-8',
    );
    const cfg = JSON.parse(raw) as {
      providers?: { baseten?: { basetenApiEnabled?: boolean } };
    };
    const enabled = cfg?.providers?.baseten?.basetenApiEnabled === true;
    const key = process.env[BASETEN_API_KEY_ENV];
    if (enabled && key && key.trim()) return 'hosted';
  } catch {
    /* unreadable config: fail closed to evidence-only */
  }
  return 'evidence-only';
}

/**
 * Refusal heuristic: the service completes refusals as `completed` carrying
 * the frozen refusal copy (no refusal marker on the transcript), so the CLI
 * matches that copy to map safety refusals to exit code 2.
 */
export function isRingRefusalAnswer(finalAnswer: string): boolean {
  const text = finalAnswer || '';
  return (
    text.includes('I cannot approve equipment restart') ||
    text.includes('I cannot certify safety') ||
    text.includes("I can't approve a restart or operation")
  );
}

export function ringExitForSnapshot(
  snap: RingAgentRunSnapshot,
): RingCliExitCode {
  if (snap.status === 'completed') {
    return snap.finalAnswer && isRingRefusalAnswer(snap.finalAnswer)
      ? RING_CLI_EXIT.REFUSED_OR_CANCELLED
      : RING_CLI_EXIT.COMPLETED;
  }
  if (snap.status === 'awaiting_approval') return RING_CLI_EXIT.AWAITING_APPROVAL;
  if (snap.status === 'cancelled') return RING_CLI_EXIT.REFUSED_OR_CANCELLED;
  return RING_CLI_EXIT.FAILED;
}

function resumeHint(runId: string): string {
  return `maos-industrial ring --resume ${runId}`;
}

// ─── Headless ───────────────────────────────────────────────────

export interface RingHeadlessOptions {
  projectRoot?: string;
  /** Instruction to run. Omit when resuming an existing run. */
  instruction?: string;
  /** Attach to an existing run (status poll; never approves). */
  resumeRunId?: string;
  thread?: string;
  json?: boolean;
  /** Only accepted value: 'none'. There is no --yes for consequential tools. */
  yesTo?: string;
  services?: RingCliServiceOverrides;
  output?: Writable;
}

interface PrintedKeys {
  seen: Set<string>;
}

function eventKey(event: RingAgentWireEvent): string {
  return `${event.type} ${event.ts} ${event.toolCallId ?? ''} ${event.approvalId ?? ''}`;
}

function printWireJson(
  output: Writable,
  event: RingAgentWireEvent,
  printed: PrintedKeys,
): void {
  const key = eventKey(event);
  if (printed.seen.has(key)) return;
  printed.seen.add(key);
  output.write(`${JSON.stringify(event)}\n`);
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args ? ` ${args}` : '';
  if (typeof args !== 'object') return ` ${String(args)}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Human-readable one-line render of a wire event (sanitised). */
function renderWireHuman(event: RingAgentWireEvent): string | undefined {
  switch (event.type) {
    case 'model.delta':
      return typeof event.delta === 'string' && event.delta
        ? safeTerminalText(event.delta)
        : undefined;
    case 'model.turn':
      return typeof event.text === 'string' && event.text
        ? `(whole text \u2014 provider does not stream) ${safeTerminalText(event.text)}`
        : undefined;
    case 'plan.updated': {
      const plan = Array.isArray(event.plan) ? event.plan : [];
      const lines = plan.map((p) => {
        // done = green, running = yellow, pending = grey (house style).
        if (p.status === 'done') return chalk.green(`[x] ${safeTerminalText(p.step)}`);
        if (p.status === 'in_progress') return chalk.yellow(`[ ] ${safeTerminalText(p.step)} (running)`);
        return chalk.gray(`[ ] ${safeTerminalText(p.step)}`);
      });
      return lines.length
        ? `${chalk.bold('Plan')}\n` + lines.join('\n')
        : undefined;
    }
    case 'tool.call':
      return `${chalk.cyan('▸')} ${chalk.bold(safeTerminalText(event.tool ?? 'tool'))}${chalk.gray(safeTerminalText(summarizeArgs(event.argsSummary)))} ${chalk.gray('…')}`;
    case 'tool.result': {
      const name = chalk.green(`✓ ${safeTerminalText(event.tool ?? 'tool')}`);
      const verdictLine = typeof event.verdict === 'string' && event.verdict ? ` ${chalk.bold(event.verdict)}` : '';
      const rmsLine = typeof event.overallRms === 'number' && Number.isFinite(event.overallRms) ? chalk.cyan(` · RMS ${event.overallRms.toFixed(3)}`) : '';
      const summaryLine = typeof event.resultSummary === 'string' && event.resultSummary ? chalk.gray(` · ${safeTerminalText(event.resultSummary.slice(0, 200))}`) : '';
      return `${name}${verdictLine}${rmsLine}${summaryLine}`;
    }
    case 'artifact.created':
      return event.artifact && typeof event.artifact.path === 'string'
        ? `${chalk.bold('Artifact:')} ${chalk.cyan(safeTerminalText(event.artifact.path))}`
        : undefined;
    case 'memory.saved':
      return event.memory && typeof event.memory.summary === 'string'
        ? `${chalk.gray('Memory saved:')} ${safeTerminalText(event.memory.summary.slice(0, 200))}`
        : undefined;
    case 'skill.prefetch':
      return Array.isArray(event.skills) && event.skills.length
        ? `prefetch: ${event.skills.map((s) => safeTerminalText(s)).join(', ')}`
        : undefined;
    default:
      return undefined;
  }
}

const RING_HEADLINE_RULE = '-'.repeat(56);

function ringHeadline(title: string): string {
  return `${chalk.bold.cyan(title)}\n${chalk.gray(RING_HEADLINE_RULE)}`;
}

function ringVerdictLine(label: string, value: string): string {
  return `${chalk.bold(label)} ${chalk.cyan(safeTerminalText(value))}`;
}

function ringTable(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows
    .map(
      ([label, value]) =>
        `${chalk.gray(label.padEnd(width))}  ${safeTerminalText(value)}`,
    )
    .join(`\n`);
}
const RING_VERDICT_WORDS = ['CRITICAL', 'WARNING', 'NORMAL', 'OK', 'PASS', 'FAIL', 'VERIFIED', 'MISMATCH'];

/** Bottom-line-first verdict: pulls CRITICAL/WARNING/NORMAL-style tokens from the
 *  final answer or tool verdicts (first hit wins). Rendering-only: the exit code
 *  still comes from ringExitForSnapshot. */
export function extractRingVerdict(finalAnswer: string, events?: Array<{ verdict?: string }>): string | undefined {
  const hay = [finalAnswer || '', ...((events || []).map((e) => (typeof e?.verdict === 'string' ? e.verdict : '')))].join(' ');
  const upper = hay.toUpperCase();
  for (const word of RING_VERDICT_WORDS) {
    const hit = upper.indexOf(word);
    if (hit >= 0) {
      const around = hay.slice(Math.max(0, hit - 40), hit + word.length + 60).replace(/\s+/g, ' ').trim();
      return around || word;
    }
  }
  return undefined;
}

/**
 * Headless mode (`maos-industrial ring -p "<instruction>" [--json]
 * [--thread <id>] [--yes-to none]`, or `--resume <runId>` to poll).
 * Never auto-approves: consequential steps end as awaiting_approval,
 * exit code 3, with a resume hint. There is deliberately NO --yes flag
 * for consequential tools.
 *
 * Exit codes: 0 completed, 1 failed, 2 refused/cancelled, 3 awaiting approval.
 */
// Snapshot alias for wire-shape assertions in tests.
export type { RingAgentWireEvent as RingHeadlessWireEvent };

export async function runRingHeadless(
  options: RingHeadlessOptions,
): Promise<{ exitCode: RingCliExitCode; runId?: string }> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const output = options.output || process.stdout;
  if (options.yesTo !== undefined && options.yesTo !== 'none') {
    throw new Error(
      "Headless mode never auto-approves: only '--yes-to none' is accepted.",
    );
  }
  const services = resolveServices(projectRoot, options.services);

  if (options.resumeRunId) {
    return pollExistingRun(services, options.resumeRunId, {
      json: options.json,
      output,
    });
  }

  const instruction = (options.instruction || '').trim();
  if (!instruction) {
    throw new Error('instruction is required and must be a non-empty string.');
  }

  let context: Record<string, unknown> = {};
  const parsed = parseRingSkillCommand(instruction);
  if (parsed) {
    // Same server-side skill path the GUI uses: skillName/skillArg/skillRole.
    context = {
      skillName: parsed.skill.name,
      skillArg: parsed.arg,
      skillRole: 'operator',
    };
  }
  if (options.thread !== undefined) {
    if (!isRingThreadId(options.thread)) {
      throw new Error(`Thread '${options.thread}' was not found.`);
    }
    const thread = services.ringThread.getThread(options.thread);
    if (!thread) throw new Error(`Thread '${options.thread}' was not found.`);
    context.threadId = options.thread;
  }

  const runId = services.ringAgent.startRun(instruction, {
    ...(context as {
      skillName?: string;
      skillArg?: string;
      skillRole?: string;
      threadId?: string;
    }),
  });
  const terminal = await pollExistingRun(services, runId, {
    json: options.json,
    output,
    live: true,
  });
  return { exitCode: terminal.exitCode, runId };
}

async function pollExistingRun(
  services: RingCliServices,
  runId: string,
  opts: { json?: boolean; output: Writable; live?: boolean },
): Promise<{ exitCode: RingCliExitCode; runId: string }> {
  const { output } = opts;
  const printed: PrintedKeys = { seen: new Set<string>() };

  const emitHuman = (event: RingAgentWireEvent): void => {
    if (opts.json) {
      printWireJson(output, event, printed);
      return;
    }
    const line = renderWireHuman(event);
    if (line !== undefined) output.write(`${line}\n`);
  };

  // Replay events already recorded before we subscribed (run.started fires
  // synchronously inside startRun), then follow the live stream. The
  // printed-key set dedupes the overlap window.
  const replay = (): void => {
    const snap = services.ringAgent.getRun(runId);
    if (!snap) return;
    for (const event of snap.events) emitHuman(event);
  };

  let unsubscribe: (() => void) | undefined;
  if (opts.live) {
    unsubscribe = services.ringAgent.onStreamEvent((emittedRunId, event) => {
      if (emittedRunId !== runId) return;
      emitHuman(event);
    });
    replay();
  } else {
    replay();
  }

  try {
    for (;;) {
      const snap = await services.ringAgent.waitForRun(runId, 60000);
      if (!snap) throw new Error(`Ring run '${runId}' was not found.`);
      if (snap.status === 'running') continue;
      if (snap.status === 'awaiting_approval') {
        const pending = snap.pendingApproval;
        if (opts.json) {
          output.write(
            `${JSON.stringify({
              type: 'run.awaiting_approval',
              runId,
              approvalId: pending?.approvalId,
              tool: pending?.toolName,
              resumeHint: resumeHint(runId),
            })}\n`,
          );
        } else {
          output.write(`${ringHeadline('Approval needed')}\n`);
          output.write(`${ringVerdictLine('Tool:', pending?.toolName ?? 'unknown')}\n`);
          output.write(ringTable([['Summary', pending?.summary ?? ''], ['Approval', pending?.approvalId ?? '']]) + `\n`);
          output.write(
            `Approve "${safeTerminalText(pending?.toolName ?? 'unknown')} \u2014 ${safeTerminalText(pending?.summary ?? '')}"? [y/N]\n`,
          );
          output.write(`${ringVerdictLine('Run:', runId + ' is awaiting approval (headless never auto-approves).')}\n`);
          output.write(`Resume with: ${resumeHint(runId)}\n`);
        }
        return { exitCode: RING_CLI_EXIT.AWAITING_APPROVAL, runId };
      }
      if (snap.status === 'completed') {
        if (opts.json) {
          output.write(
            `${JSON.stringify({ type: 'run.completed', runId, finalAnswer: snap.finalAnswer })}\n`,
          );
        } else if (snap.finalAnswer) {
          if (isRingRefusalAnswer(snap.finalAnswer)) {
            // Fail-closed refusal: calm house text, no verdict banner.
            output.write(chalk.yellow(safeTerminalText(snap.finalAnswer)) + `\n`);
          } else {
            const doneVerdict = extractRingVerdict(snap.finalAnswer, snap.events) ?? 'answer ready';
            output.write(`${ringHeadline('Answer')}\n`);
            output.write(`${ringVerdictLine('Verdict:', doneVerdict)}\n`);
            output.write(safeTerminalText(snap.finalAnswer) + `\n`);
          }
        }
        return { exitCode: ringExitForSnapshot(snap), runId };
      }
      if (snap.status === 'cancelled') {
        if (opts.json) output.write(`${JSON.stringify({ type: 'run.cancelled', runId })}\n`);
        else {
          output.write(`${ringHeadline('Run cancelled')}\n`);
          output.write(`${ringVerdictLine('Run:', runId)}\n`);
          output.write(chalk.yellow('Re-run the same prompt; nothing was written.') + `\n`);
        }
        return { exitCode: RING_CLI_EXIT.REFUSED_OR_CANCELLED, runId };
      }
      if (opts.json) {
        output.write(
          `${JSON.stringify({ type: 'run.failed', runId, error: snap.error })}\n`,
        );
      } else {
        output.write(`${ringHeadline('Run failed')}\n`);
        output.write(`${ringVerdictLine('Error:', snap.error ?? 'unknown error')}\n`);
        output.write(ringTable([[ 'Run', runId ], [ 'Resume', resumeHint(runId) ]]) + '\n');
      }
      return { exitCode: RING_CLI_EXIT.FAILED, runId };
    }
  } finally {
    if (unsubscribe) unsubscribe();
  }
}

// ─── Interactive REPL ─────────────────────────────────────────

export interface RingReplOptions {
  projectRoot?: string;
  input?: Readable;
  output?: Writable;
  services?: RingCliServiceOverrides;
  /** Test hook: answers to approval prompts, consumed in order. Default: deny. */
  approvalAnswers?: string[];
}

const REPL_COMMANDS_HELP = [
  'Ring agent — same runs, threads and approvals as the GUI.',
  'Type a question or instruction, or one of:',
  '  /handover   shift handover note (needs approval to save)',
  '  /rca        root-cause starter (5 Whys + fishbone)',
  '  /permit     permit-to-work checklist',
  '  /loto       lockout/tagout steps (verify against your site procedure)',
  '  /sop <eq>   read the SOP for equipment (e.g. /sop T-07)',
  '  /report     shift report draft (needs approval to save)',
  '  /threads    list threads in this project',
  '  /new [title] [role]  start a new thread',
  '  /resume <id>         resume a thread (or attach to a pending ring run)',
  '  /role <r>            set role (operator|maintenance|safety|manager)',
  '  /verify              audit chain + current thread state',
  '  /help                this help',
  '  cancel      cancel the running run (Ctrl+C once does the same)',
  '  exit        leave the Ring REPL',
];

function showRingHelp(output: Writable, mode: RingMode, role: string): void {
  output.write(ringHeadline('Ring commands') + '\n');
  output.write(REPL_COMMANDS_HELP.join('\n') + '\n');
  output.write(ringTable([[ 'Mode', mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY' ], [ 'Role', role ]]) + '\n');
}
interface ReplSession {
  role: RingRole;
  threadId?: string;
  activeRunId?: string;
  /** Ctrl+C arrival count while a run is active (1 = cancel, 2 = exit). */
  cancelCount?: number;
}

function renderRingThreadLine(writeLine: (value: string) => void, session: ReplSession): void {
  const thread = session.threadId ? session.threadId : 'none (use /new)';
  writeLine(chalk.gray('Thread: ' + safeTerminalText(thread)));
}

function isRingStatusLineRenderable(output: unknown): boolean {
  try {
    const out = output as { isTTY?: boolean; columns?: number };
    return Boolean(out && out.isTTY);
  } catch {
    return false;
  }
}

function skillAllowedForRole(skill: RingSkill, role: RingRole): boolean {
  return !skill.roles || skill.roles.includes(role);
}

/**
 * Interactive Ring REPL: plain readline + chalk (no Ink/TUI).
 * Driven by injected stdin/stdout in tests (IndustrialReplOptions pattern).
 *
 * Live progress (rendering-only): streamed model text prints as it arrives
 * (real model.delta only); when the provider does not stream, the whole text
 * prints once, labelled. One updating status line per tool step on TTYs
 * (elapsed timer; settled `✓ tool · VERDICT · RMS` lines when each step ends,
 * plain lines when piped); plan checklists redraw as [x]/[ ] lines on change
 * only; approvals render as a bordered card above the byte-identical
 * `Approve "…" [y/N]` prompt (defaults to No, recorded in audit); final
 * answers print verdict-line-first (`Answer` headline + `Verdict:` line);
 * artifact lines carry absolute paths. Ctrl+C once cancels the run, twice exits.
 */
/**
 * Bordered approval card (rendering-only): the Approve "[y/N] question stays
 * byte-identical below the card and still defaults to No.
 */
function renderRingApprovalCard(event: { tool?: unknown; approvalId?: unknown; argsSummary?: unknown }): string {
  const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
  const approvalId = typeof event.approvalId === 'string' ? event.approvalId : '';
  const args = summarizeArgs(event.argsSummary);
  const top = chalk.yellow('┌' + '─'.repeat(58) + '┐');
  const bottom = chalk.yellow('└' + '─'.repeat(58) + '┐'.replace('┐', '┘'));
  const title = chalk.yellow('│ ') + chalk.bold('Approval needed: ' + safeTerminalText(tool)) + ' '.repeat(Math.max(0, 56 - ('Approval needed: '.length + String(tool).length))) + chalk.yellow(' │');
  const idLine = approvalId
    ? chalk.yellow('│ ') + chalk.gray('approval ' + safeTerminalText(approvalId) + safeTerminalText(args)) + chalk.yellow(' │')
    : '';
  return [top, title, idLine, bottom].filter(Boolean).join('\n');
}

/**
 * Calm house-style refusal for the evidence-only REPL (rendering-only): keeps
 * the frozen service refusal copy verbatim, then names the exact remediation.
 */
function ringEvidenceOnlyRefusal(finalAnswer: string): string {
  return (
    chalk.yellow(safeTerminalText(finalAnswer)) + '\n' +
    chalk.gray(
      'Fail-closed: no action was taken and no files were written. ' +
        'Re-run with an evidence question (e.g. /sop T-07) or ask for a verdict summary.',
    )
  );
}

export function runRingRepl(options: RingReplOptions = {}): Promise<void> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const services = resolveServices(projectRoot, options.services);
  const approvalAnswers = options.approvalAnswers
    ? [...options.approvalAnswers]
    : [];

  const writeLine = (value: string): void => {
    output.write(`${value}\n`);
  };

  const session: ReplSession = { role: DEFAULT_RING_ROLE };
  const mode = detectRingMode(projectRoot);
  const badge = mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY';

  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean(
      (output as Writable & { isTTY?: boolean }).isTTY,
    ),
  });

  // Quiet startup: one mode badge line, one slash-command hint row with
  // Ctrl+C semantics, one thread-context line. Evidence-only banner text
  // below is frozen copy: keep the exact sentence.
  writeLine(`${chalk.bold.cyan('Ring')} · ${badge === 'HOSTED' ? chalk.green(badge) : chalk.yellow(badge)}`);
  writeLine(chalk.gray('/help commands · /threads list · exit leaves · Ctrl+C cancels the run, twice exits'));
  writeLine(chalk.gray('Evidence-only mode: answers cite deterministic evidence; nothing here authorizes operating the plant.'));
  renderRingThreadLine(writeLine, session);
  rl.setPrompt('ring> ');

  return new Promise((resolve) => {
    let busy = false;
    let closing = false;
    let sigintCount = 0;

    const finish = (): void => {
      closing = true;
      rl.close();
    };

    const recordApprovalAudit = (data: Record<string, unknown>): void => {
      try {
        services.audit.recordAuditEvent(
          {
            category: 'approval',
            source: 'ring-cli',
            data,
          } as never,
          false,
        );
      } catch {
        /* audit must not break the CLI */
      }
    };

    const askApproval = (question: string): Promise<boolean> => {
      const canned = approvalAnswers.shift();
      if (canned !== undefined) {
        return Promise.resolve(/^y(es)?$/i.test(canned.trim()));
      }
      rl.pause();
      return new Promise((res) => {
        const q = readline.createInterface({ input, output });
        q.question(`${question} `, (answer) => {
          q.close();
          rl.resume();
          res(/^y(es)?$/i.test(answer.trim()));
        });
      });
    };

    /** Drive a run to a terminal state (or approval pause), rendering events. */
    const driveRun = async (runId: string): Promise<void> => {
      let sawDelta = false;
      // Live progress state: one updating status line per tool step (TTY only);
      // plan checklists redraw on change only; completed lines stay printed.
      const statusTty = isRingStatusLineRenderable(output);
      const statusState = {
        active: false,
        tool: '',
        startedAt: 0,
        timer: undefined as ReturnType<typeof setInterval> | undefined,
        planKey: '',
        planRendered: false,
        lastApproval: '',
      };
      const statusStop = (): void => {
        if (statusState.timer) { clearInterval(statusState.timer); statusState.timer = undefined; }
        statusState.active = false;
      };
      const statusErase = (): void => {
        if (!statusTty || !statusState.active) return;
        statusState.active = false;
        try { (output as NodeJS.WriteStream).clearLine(0); (output as NodeJS.WriteStream).cursorTo(0); } catch { /* best effort */ }
      };
      const statusWrite = (text: string): void => {
        if (!statusTty) return;
        try {
          const stream = output as NodeJS.WriteStream;
          stream.clearLine(0);
          stream.cursorTo(0);
          stream.write(text);
          statusState.active = true;
        } catch { /* best effort: fall through to plain lines */ }
      };
      const statusTick = (): void => {
        if (!statusTty || !statusState.tool) return;
        const elapsed = ((Date.now() - statusState.startedAt) / 1000).toFixed(1);
        statusWrite(chalk.cyan(`▸ ${safeTerminalText(statusState.tool)} · ${elapsed}s`));
      };
      const statusStart = (tool: string): void => {
        statusErase();
        statusState.tool = tool;
        statusState.startedAt = Date.now();
        if (!statusTty) return;
        statusTick();
        if (statusState.timer) clearInterval(statusState.timer);
        statusState.timer = setInterval(statusTick, 250);
      };
      const statusDone = (tool: string, verdict?: string, rms?: number): void => {
        statusStop();
        statusErase();
        const tail = typeof rms === 'number' && Number.isFinite(rms)
          ? chalk.cyan(` · RMS ${rms.toFixed(3)}`)
          : '';
        writeLine(chalk.green(`✓ ${safeTerminalText(tool)}`) + (verdict ? ` · ${safeTerminalText(verdict)}` : '') + tail);
      };
      const renderPlan = (event: RingAgentWireEvent): void => {
        const plan = Array.isArray(event.plan) ? event.plan : [];
        if (!plan.length) return;
        const key = plan.map((s) => (s.status === 'done' ? 'x' : s.status === 'in_progress' ? '>' : ' ') + ':' + String(s.step)).join('|');
        if (statusState.planRendered && key === statusState.planKey) return;
        statusErase();
        const lines = plan.map((s) =>
          s.status === 'done'
            ? chalk.green(`[x] ${safeTerminalText(s.step)}`)
            : s.status === 'in_progress'
              ? chalk.yellow(`[ ] ${safeTerminalText(s.step)} (running)`)
              : chalk.gray(`[ ] ${safeTerminalText(s.step)}`),
        );
        for (const planLine of lines) writeLine('  ' + planLine);
        statusState.planKey = key;
        statusState.planRendered = true;
        if (statusState.tool) statusTick();
      };
      const handleEvent = (event: RingAgentWireEvent): void => {
        if (event.type === 'model.delta') {
          sawDelta = true;
          if (typeof event.delta === 'string' && event.delta) {
            statusErase();
            output.write(safeTerminalText(event.delta));
            if (statusState.tool) statusTick();
          }
          return;
        }
        if (event.type === 'model.turn') {
          // Whole text when the provider doesn't stream (labelled); skip
          // when deltas already streamed this text live.
          if (!sawDelta && typeof event.text === 'string' && event.text) {
            writeLine(
              safeTerminalText(
                `(whole text — provider does not stream) ${event.text}`,
              ),
            );
          }
          return;
        }
        // Routed render: plan checklists redraw on change only, tool steps
        // collapse into one live status line while running, approvals render
        // as a bordered card. Pipe mode (no TTY) prints one settled line per
        // event so transcripts stay greppable.
        if (event.type === 'plan.updated') {
          renderPlan(event);
          return;
        }
        if (event.type === 'tool.call') {
          statusStart(typeof event.tool === 'string' && event.tool ? event.tool : 'tool');
          if (!statusTty) writeLine(`${chalk.cyan('▸')} ${chalk.bold(safeTerminalText(typeof event.tool === 'string' && event.tool ? event.tool : 'tool'))}`);
          return;
        }
        if (event.type === 'tool.result') {
          statusDone(
            typeof event.tool === 'string' && event.tool ? event.tool : 'tool',
            typeof event.verdict === 'string' ? event.verdict : undefined,
            typeof event.overallRms === 'number' ? event.overallRms : undefined,
          );
          return;
        }
        if (event.type === 'approval.pending') {
          statusStop();
          statusErase();
          writeLine(renderRingApprovalCard(event));
          statusState.lastApproval = typeof event.approvalId === 'string' ? event.approvalId : '';
          return;
        }
        if (event.type === 'artifact.created' && event.artifact && typeof event.artifact.path === 'string') {
          statusErase();
          writeLine(`${chalk.bold('Artifact:')} ${chalk.cyan(safeTerminalText(path.resolve(projectRoot, event.artifact.path)))}`);
          if (statusState.tool) statusTick();
          return;
        }
        if (event.type === 'memory.saved') {
          statusErase();
          const line = renderWireHuman(event);
          if (line !== undefined) writeLine(line);
          if (statusState.tool) statusTick();
          return;
        }
        const line = renderWireHuman(event);
        if (line !== undefined) {
          statusErase();
          writeLine(line);
          if (statusState.tool) statusTick();
        }
      };
      const unsubscribe = services.ringAgent.onStreamEvent(
        (emittedRunId, event) => {
          if (emittedRunId !== runId) return;
          handleEvent(event);
        },
      );
      // Replay events recorded before we subscribed: a provider whose
      // generateStream observes deltas synchronously (loopback mocks) emits
      // model.delta inside startRun, before this subscription exists. The
      // replay keeps those deltas (and sets sawDelta) so the labelled
      // whole-text fallback never double-prints them.
      try {
        const before = services.ringAgent.getRun(runId);
        if (before) {
          for (const event of before.events) handleEvent(event);
        }
      } catch {
        /* replay is best effort; the live stream still follows */
      }
      try {
        for (;;) {
          const snap = await services.ringAgent.waitForRun(runId, 60000);
          if (!snap) {
            writeLine(chalk.red(`Run '${safeTerminalText(runId)}' was not found.`));
            return;
          }
          if (snap.status === 'running') continue;
          if (snap.status === 'awaiting_approval') {
            let pending = snap.pendingApproval;
            if (!pending) {
              // Resolve-then-poll race: the gate just settled (denied) and the
              // completion record lands on the next poll — never fail a real run.
              const settled = await services.ringAgent.waitForCompletion(runId, 60000);
              if (settled.status === 'completed' && settled.finalAnswer) {
                if (isRingRefusalAnswer(settled.finalAnswer)) {
                  writeLine(ringEvidenceOnlyRefusal(settled.finalAnswer));
                } else {
                  const verdict = extractRingVerdict(settled.finalAnswer, settled.events) ?? 'answer ready';
                  writeLine(ringHeadline('Answer'));
                  writeLine(ringVerdictLine('Verdict:', verdict));
                  writeLine(safeTerminalText(settled.finalAnswer));
                }
                return;
              }
              if (settled.status === 'cancelled') {
                writeLine(ringHeadline('Run cancelled'));
                writeLine(ringVerdictLine('Run:', runId));
                writeLine(chalk.yellow('Re-run the same prompt; nothing was written.'));
                return;
              }
              pending = settled.pendingApproval;
              if (!pending) {
                writeLine(chalk.red('Run is awaiting approval with no pending approval.'));
                return;
              }
            }
            if (statusState.lastApproval !== pending.approvalId) {
              writeLine(
              renderRingApprovalCard({ tool: pending.toolName, approvalId: pending.approvalId, argsSummary: pending.argsSummary }),
              );
              statusState.lastApproval = pending.approvalId;
            }
            const answer = await askApproval(
              `Approve "${pending.toolName} — ${pending.summary}"? [y/N]`,
            );

            // Default No: anything but an explicit yes denies. Recorded in audit.
            recordApprovalAudit({
              event: 'RING_CLI_APPROVAL_PROMPT',
              runId,
              approvalId: pending.approvalId,
              toolName: pending.toolName,
              decision: answer ? 'approved' : 'denied',
            });
            services.ringAgent.resolveApproval(
              runId,
              pending.approvalId,
              answer ? 'approved' : 'denied',
            );
            continue;
          }
          if (snap.status === 'completed') {
            statusStop();
            statusErase();
            if (snap.finalAnswer && mode === 'evidence-only') {
              if (isRingRefusalAnswer(snap.finalAnswer)) {
                // Bottom-line-first refusal: frozen copy verbatim + calm remediation.
                writeLine(ringEvidenceOnlyRefusal(snap.finalAnswer));
              } else {
                // Bottom-line-first: verdict line, then the deterministic evidence answer.
                const verdict = extractRingVerdict(snap.finalAnswer, snap.events) ?? 'answer ready';
                writeLine(ringHeadline('Answer'));
                writeLine(ringVerdictLine('Verdict:', verdict));
                writeLine(safeTerminalText(snap.finalAnswer));
              }
            }
            return;
          }
          if (snap.status === 'cancelled') {
            statusStop();
            statusErase();
            writeLine(ringHeadline('Run cancelled'));
            writeLine(ringVerdictLine('Run:', runId));
            writeLine(chalk.yellow('Re-run the same prompt; nothing was written.'));
            return;
          }
          statusStop();
          statusErase();
          writeLine(ringHeadline('Run failed'));
          writeLine(ringVerdictLine('Error:', snap.error ?? 'unknown error'));
          writeLine(chalk.gray(`Resume with: ${resumeHint(runId)}`));
          return;
        }
      } finally {
        statusStop();
        statusErase();
        unsubscribe();
        if (session.activeRunId === runId) session.activeRunId = undefined;
        sigintCount = 0;
      }
    };

    const startInstruction = async (
      instruction: string,
      startContext: Record<string, unknown>,
    ): Promise<void> => {
      let runId: string;
      try {
        runId = services.ringAgent.startRun(instruction, {
          ...(startContext as {
            skillName?: string;
            skillArg?: string;
            skillRole?: string;
            threadId?: string;
            role?: string;
          }),
        });
      } catch (err) {
        writeLine(
          chalk.red(
            `Error: ${safeTerminalText(err instanceof Error ? err.message : String(err))}`,
          ),
        );
        writeLine(chalk.gray('Fail-closed: nothing was started and no files were written.'));
        return;
      }
      session.activeRunId = runId;
      const snap = services.ringAgent.getRun(runId);
      if (snap) {
        writeLine(ringHeadline(`Run ${runId}`));
        writeLine(ringTable([[ 'Mode', snap.mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY' ], [ 'Thread', session.threadId ?? 'none' ]]));
      }
      await driveRun(runId);
    };

    const handleLocal = async (line: string): Promise<boolean> => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed === 'exit' || trimmed === 'quit') {
        finish();
        return false;
      }
      if (trimmed === 'cancel' || trimmed === '/cancel') {
        if (session.activeRunId) {
          services.ringAgent.cancelRun(session.activeRunId);
          writeLine(chalk.yellow('Cancellation requested.'));
        } else {
          writeLine('No run is currently active.');
        }
        return true;
      }
      if (trimmed === '/help' || trimmed === 'help' || trimmed === '?') {
        showRingHelp(output, mode, session.role);
        return true;
      }
      if (trimmed === '/threads') {
        const ids = services.ringThread.listThreadIds();
        writeLine(ringHeadline('Threads'));
        if (ids.length === 0) {
          writeLine('(no threads yet — use /new to start one)');
          return true;
        }
        for (const id of ids) {
          writeLine(`${safeTerminalText(id)}${id === session.threadId ? ' *' : ''}`);
        }
        return true;
      }
      if (trimmed === '/new' || trimmed.startsWith('/new ')) {
        const rest = trimmed
          .slice('/new'.length)
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        let title: string | undefined;
        let role: RingRole = session.role;
        for (const part of rest) {
          if (isRingRole(part)) role = part;
          else title = title === undefined ? part : `${title} ${part}`;
        }
        const thread = services.ringThread.createThread(title, role);
        session.threadId = thread.threadId;
        session.role = thread.role;
        writeLine(`thread ${safeTerminalText(thread.threadId)} (${safeTerminalText(thread.role)})`);
        writeLine(ringVerdictLine('Thread:', `${thread.threadId} (${thread.role})`));
        renderRingThreadLine(writeLine, session);
        return true;
      }
      if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
        const id = trimmed.slice('/resume'.length).trim().split(/\s+/)[0];
        if (!id) {
          writeLine(chalk.red('Usage: /resume <thread-id|run-id>'));
          return true;
        }
        if (isRingThreadId(id)) {
          const thread = services.ringThread.getThread(id);
          if (!thread) {
            writeLine(chalk.red(`Thread '${safeTerminalText(id)}' was not found.`));
            return true;
          }
          session.threadId = thread.threadId;
          session.role = thread.role;
          writeLine(`resumed ${safeTerminalText(thread.threadId)} (${safeTerminalText(thread.role)})`);
          writeLine(ringVerdictLine('Thread:', `${thread.threadId} (${thread.role})`));
          renderRingThreadLine(writeLine, session);
          return true;
        }
        // Attach to an existing run (e.g. left awaiting_approval by headless).
        const snap = services.ringAgent.getRun(id);
        if (!snap) {
          writeLine(chalk.red(`No thread or run '${safeTerminalText(id)}' was found.`));
          return true;
        }
        session.activeRunId = id;
        await driveRun(id);
        return true;
      }
      if (trimmed === '/role' || trimmed.startsWith('/role ')) {
        const want = trimmed.slice('/role'.length).trim().split(/\s+/)[0];
        if (!want || !isRingRole(want)) {
          writeLine(chalk.red('Usage: /role <operator|maintenance|safety|manager>'));
          return true;
        }
        session.role = (getRingRolePersona(want)?.role ?? DEFAULT_RING_ROLE) as RingRole;
        writeLine(`role ${safeTerminalText(session.role)}`);
        writeLine(ringVerdictLine('Role:', session.role));
        renderRingThreadLine(writeLine, session);
        return true;
      }
      if (trimmed === '/verify') {
        const chain = services.audit.verifyChain();
        writeLine(ringHeadline('Verify'));
        writeLine(chain.valid ? chalk.green('Audit chain: valid') : chalk.red('Audit chain: invalid'));
        if (!chain.valid) {
          for (const e of chain.errors) writeLine(safeTerminalText(e));
        }
        if (session.threadId) {
          const thread = services.ringThread.getThread(session.threadId);
          writeLine(
            thread
              ? ringVerdictLine('Thread:', `${thread.threadId} · ${thread.runs.length} run(s) · role ${thread.role}`)
              : `Thread '${session.threadId}' was not found.`,
          );
        } else {
          writeLine('No active thread.');
        }
        return true;
      }
      const skillParsed = parseRingSkillCommand(trimmed);
      if (skillParsed) {
        if (!skillAllowedForRole(skillParsed.skill, session.role)) {
          writeLine(
            chalk.red(
              `Skill /${skillParsed.skill.name} is not available to role ${session.role}.`,
            ),
          );
          return true;
        }
        if (skillParsed.skill.name === 'sop' && !skillParsed.arg) {
          writeLine(chalk.red('Usage: /sop <equipment> — for example /sop T-07.'));
          return true;
        }
        await startInstruction(trimmed, {
          skillName: skillParsed.skill.name,
          skillArg: skillParsed.arg,
          skillRole: session.role,
          ...(session.threadId ? { threadId: session.threadId } : {}),
        });
        return true;
      }
      if (trimmed.startsWith('/')) {
        const name = trimmed.split(/\s+/)[0];
        const known = listRingSkills().some((s) => `/${s.name}` === name);
        if (!known) {
          writeLine(
            chalk.red(`Unknown command '${safeTerminalText(name)}'. Type /help for supported commands.`),
          );
          return true;
        }
        // Known skill that slipped past the parse above (should not happen):
        // run it as a plain instruction so the model path handles it.
      }
      await startInstruction(trimmed, {
        role: session.role,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
      return true;
    };

    rl.prompt();
    rl.on('line', (line) => {
      if (busy) {
        const t = line.trim();
        if (t === '' || /^[yn](es|o)?$/i.test(t)) {
          // Buffered approval answer (piped stdin echoed while awaiting_approval):
          // the live approval prompt already consumed it — swallow, don't re-ask.
        } else if ((t === 'cancel' || t === '/cancel') && session.activeRunId) {
          services.ringAgent.cancelRun(session.activeRunId);
          writeLine(chalk.yellow('Cancellation requested.'));
        } else {
          writeLine('A run is in progress. Type `cancel` to stop it.');
        }
        return;
      }
      busy = true;
      void handleLocal(line)
        .catch((err) => {
          writeLine(
            chalk.red(
              `Error: ${safeTerminalText(err instanceof Error ? err.message : String(err))}`,
            ),
          );
          writeLine(chalk.gray('Fail-closed: nothing was started and no files were written.'));
        })
        .finally(() => {
          busy = false;
          if (!closing) rl.prompt();
        });
    });

    // Ctrl+C once cancels the active run (existing cancel path); twice exits.
    rl.on('SIGINT', () => {
      sigintCount += 1;
      if (session.activeRunId) {
        try {
          services.ringAgent.cancelRun(session.activeRunId);
        } catch {
          /* best effort */
        }
        if (sigintCount >= 2) {
          finish();
          return;
        }
        writeLine(chalk.yellow('Cancellation requested (Ctrl+C again to exit).'));
        return;
      }
      finish();
    });

    rl.on('close', () => {
      if (session.activeRunId) {
        try {
          services.ringAgent.cancelRun(session.activeRunId);
        } catch {
          /* best effort */
        }
      }
      resolve();
    });
  });
}
