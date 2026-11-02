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
        const mark = p.status === 'done' ? '[x]' : '[ ]';
        return `${mark} ${p.step}`;
      });
      return lines.length ? safeTerminalText(lines.join('\n')) : undefined;
    }
    case 'tool.call':
      return `▸ ${safeTerminalText(event.tool ?? 'tool')}${safeTerminalText(summarizeArgs(event.argsSummary))} …`;
    case 'tool.result': {
      const verdict =
        typeof event.verdict === 'string' ? ` · ${event.verdict}` : '';
      const rms =
        typeof event.overallRms === 'number' && Number.isFinite(event.overallRms)
          ? ` · RMS ${event.overallRms.toFixed(3)}`
          : '';
      const summary =
        typeof event.resultSummary === 'string' && event.resultSummary
          ? ` · ${event.resultSummary.slice(0, 200)}`
          : '';
      return `✓ ${safeTerminalText(event.tool ?? 'tool')}${safeTerminalText(verdict)}${safeTerminalText(rms)}${safeTerminalText(summary)}`;
    }
    case 'artifact.created':
      return event.artifact && typeof event.artifact.path === 'string'
        ? `artifact: ${safeTerminalText(event.artifact.path)}`
        : undefined;
    case 'memory.saved':
      return event.memory && typeof event.memory.summary === 'string'
        ? `memory saved: ${safeTerminalText(event.memory.summary.slice(0, 200))}`
        : undefined;
    case 'skill.prefetch':
      return Array.isArray(event.skills) && event.skills.length
        ? `prefetch: ${event.skills.map((s) => safeTerminalText(s)).join(', ')}`
        : undefined;
    default:
      return undefined;
  }
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
          output.write(
            `Approve "${safeTerminalText(pending?.toolName ?? 'unknown')} — ${safeTerminalText(pending?.summary ?? '')}"? [y/N]\n`,
          );
          output.write(
            `Run ${runId} is awaiting approval (headless never auto-approves). Resume with: ${resumeHint(runId)}\n`,
          );
        }
        return { exitCode: RING_CLI_EXIT.AWAITING_APPROVAL, runId };
      }
      if (snap.status === 'completed') {
        if (opts.json) {
          output.write(
            `${JSON.stringify({ type: 'run.completed', runId, finalAnswer: snap.finalAnswer })}\n`,
          );
        } else if (snap.finalAnswer) {
          output.write(`${safeTerminalText(snap.finalAnswer)}\n`);
        }
        return { exitCode: ringExitForSnapshot(snap), runId };
      }
      if (snap.status === 'cancelled') {
        if (opts.json) output.write(`${JSON.stringify({ type: 'run.cancelled', runId })}\n`);
        else output.write(`Run ${runId} was cancelled.\n`);
        return { exitCode: RING_CLI_EXIT.REFUSED_OR_CANCELLED, runId };
      }
      if (opts.json) {
        output.write(
          `${JSON.stringify({ type: 'run.failed', runId, error: snap.error })}\n`,
        );
      } else {
        output.write(
          `Run ${runId} failed: ${safeTerminalText(snap.error ?? 'unknown error')}\n`,
        );
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
  output.write(
    [...REPL_COMMANDS_HELP, `Mode: ${mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY'} · Role: ${safeTerminalText(role)}`].join(
      '\n',
    ) + '\n',
  );
}

interface ReplSession {
  role: RingRole;
  threadId?: string;
  activeRunId?: string;
  /** Ctrl+C arrival count while a run is active (1 = cancel, 2 = exit). */
  cancelCount?: number;
}

function skillAllowedForRole(skill: RingSkill, role: RingRole): boolean {
  return !skill.roles || skill.roles.includes(role);
}

/**
 * Interactive Ring REPL: plain readline + chalk (no Ink/TUI).
 * Driven by injected stdin/stdout in tests (IndustrialReplOptions pattern).
 *
 * Streaming: streamed model text prints as it arrives (real model.delta
 * only); when the provider does not stream, the whole text prints once,
 * labelled. Plan checklists redraw as [x]/[ ] lines; tool lines render as
 * `▸ analyze_telemetry … ✓ CRITICAL · RMS 2.637`; the approval prompt
 * `Approve "…" ? [y/N]` defaults to No and is recorded in audit; artifact
 * lines carry absolute paths. Ctrl+C once cancels the run, twice exits.
 */
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

  writeLine(
    `Ring · ${badge} · role ${session.role}. Type /help for commands.`,
  );
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
      const handleEvent = (event: RingAgentWireEvent): void => {
        if (event.type === 'model.delta') {
          sawDelta = true;
          if (typeof event.delta === 'string' && event.delta) {
            output.write(safeTerminalText(event.delta));
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
        const line = renderWireHuman(event);
        if (line !== undefined) {
          const fixed =
            event.type === 'artifact.created' &&
            event.artifact &&
            typeof event.artifact.path === 'string'
              ? `artifact: ${safeTerminalText(path.resolve(projectRoot, event.artifact.path))}`
              : line;
          writeLine(fixed);
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
            const pending = snap.pendingApproval;
            if (!pending) {
              writeLine(chalk.red('Run is awaiting approval with no pending approval.'));
              return;
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
            // Hosted streaming already printed deltas live; hosted
            // non-streamed whole text printed via `model.turn`. Only
            // evidence-only (never streamed) prints the final answer here.
            if (snap.finalAnswer && mode === 'evidence-only') {
              writeLine(safeTerminalText(snap.finalAnswer));
            }
            if (snap.finalAnswer && sawDelta) {
              // Final answer already streamed live; nothing more to print.
            }
            return;
          }
          if (snap.status === 'cancelled') {
            writeLine(chalk.yellow('Run cancelled.'));
            return;
          }
          writeLine(
            chalk.red(`Run failed: ${safeTerminalText(snap.error ?? 'unknown error')}`),
          );
          return;
        }
      } finally {
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
        return;
      }
      session.activeRunId = runId;
      const snap = services.ringAgent.getRun(runId);
      if (snap) writeLine(`run ${runId} · ${snap.mode === 'hosted' ? 'HOSTED' : 'EVIDENCE-ONLY'}`);
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
        if (ids.length === 0) {
          writeLine('(no threads yet — use /new to start one)');
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
        writeLine(
          `thread ${safeTerminalText(thread.threadId)} (${safeTerminalText(thread.role)})`,
        );
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
          writeLine(
            `resumed ${safeTerminalText(thread.threadId)} (${safeTerminalText(thread.role)})`,
          );
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
        return true;
      }
      if (trimmed === '/verify') {
        const chain = services.audit.verifyChain();
        writeLine(`Audit chain: ${chain.valid ? 'valid' : 'invalid'}`);
        if (!chain.valid) {
          for (const e of chain.errors) writeLine(safeTerminalText(e));
        }
        if (session.threadId) {
          const thread = services.ringThread.getThread(session.threadId);
          writeLine(
            thread
              ? `Thread ${thread.threadId}: ${thread.runs.length} run(s), role ${thread.role}`
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
        if ((t === 'cancel' || t === '/cancel') && session.activeRunId) {
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
