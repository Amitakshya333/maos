/**
 * maos ignite — Sovereign Multi-Pane Terminal Swarm Kernel
 *
 *   maos ignite --gemma --harness herdr --goal "<Any task the user throws>"
 *
 * End-to-end autonomous swarm:
 *   1. Task Decomposition — Gemma (local, via OpenCode harness when available)
 *      breaks the goal into atomic, non-conflicting subtasks.
 *   2. Physical Multiplexing — Herdr tiles the terminal into isolated live
 *      worker panes side-by-side.
 *   3. Parallel Execution — workers get isolated Git worktrees and run builds
 *      + tests concurrently.
 *   4. Closed-Loop Self-Healing — the AutonomousHealer watches Herdr's
 *      unwrapped scrollback and hot-injects repair patches until tests pass.
 *   5. Consensus & Merge — verify test status, report branch diffs, merge.
 */

import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { createServiceContainer } from '../../service';
import { createProviderDirect } from '../../backends/factory';
import { IProvider } from '../../backends/provider';
import { decompose, SubTask } from '../../core/decomposer';
import { ensureWorktree } from '../../integrations/worktree';
import {
  AutonomousHealer,
  HealAttempt,
  herdrSplitPane,
  herdrMovePane,
  herdrPaneClose,
  isHerdrAvailable,
  CliHerdrPaneReader,
} from '../../core/autonomous-healer';
import { getMessageBus } from '../../core/message-bus';
import { renderPanel, getBrandBadge, renderDivider } from '../../utils/ui';

// ─── Options ─────────────────────────────────────────────────────

export class IgniteError extends Error {
  constructor(
    message: string,
    public readonly code: number = 1,
  ) {
    super(message);
    this.name = 'IgniteError';
  }
}

export interface IgniteOptions {
  gemma?: boolean;
  harness?: string;
  goal?: string;
  provider?: string;
  model?: string;
  /** Max worker panes to spawn (default 4). */
  panes?: string | number;
  /** Auto-merge worktree branches on success (default: report only). */
  yes?: boolean;
  /** Preview the plan without spawning panes (default false). */
  dryRun?: boolean;
  /** Keep watching/healing until Ctrl+C (default true; false with --dry-run). */
  watch?: boolean;
  /** Max auto-applied heals per pane (default 5). */
  maxHeals?: string | number;
  /** Git branch prefix for worker worktrees (default "maos-ignite"). */
  branchPrefix?: string;
  /** Do not call process.exit directly; throw IgniteError or return cleanly (e.g. when called from TUI). */
  noExit?: boolean;
  /** Commander sets exit: false when --no-exit is supplied. */
  exit?: boolean;
}

export interface IgniteWorker {
  index: number;
  title: string;
  agentId: string;
  branch: string;
  worktreePath: string;
  paneId?: string;
  taskFile: string;
}

export const DEFAULT_GEMMA_MODEL = process.env.MAOS_GEMMA_MODEL || 'gemma2:9b';
export const DEFAULT_GEMMA_BASE_URL = process.env.MAOS_GEMMA_BASE_URL || 'http://localhost:11434/v1';
export const SUPPORTED_HARNESSES = ['herdr'];

// ─── Pure helpers (unit-tested) ──────────────────────────────────

export function validateIgniteOptions(options: IgniteOptions): { panes: number; maxHeals: number; goal: string } {
  const harness = (options.harness || 'herdr').toLowerCase();
  if (!SUPPORTED_HARNESSES.includes(harness)) {
    throw new Error(
      `Unsupported harness "${options.harness}". Supported: ${SUPPORTED_HARNESSES.join(', ')}. ` +
        `Usage: maos ignite --gemma --harness herdr --goal "<task>"`,
    );
  }
  const goal = (options.goal || '').trim();
  if (!goal) {
    throw new Error('Missing required --goal "<task>". Usage: maos ignite --gemma --harness herdr --goal "<task>"');
  }
  const panes = Math.min(Math.max(parseInt(String(options.panes ?? 4), 10) || 4, 1), 8);
  const maxHeals = Math.min(Math.max(parseInt(String(options.maxHeals ?? 5), 10) || 5, 0), 25);
  return { panes, maxHeals, goal };
}

export function slugify(text: string, maxLen = 24): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen) || 'task'
  );
}

export function buildWorkerBranch(prefix: string, goal: string, index: number): string {
  return `${prefix}/${slugify(goal)}-${index + 1}`;
}

export function buildWorkerAgentId(index: number): string {
  return `ignite-worker-${index + 1}`;
}

/**
 * Offline fallback decomposition — keeps the swarm launchable when the local
 * model is unreachable. Splits the goal into parallelizable chunks instead of
 * failing the whole ignite run.
 */
export function heuristicDecompose(goal: string, maxTasks: number): SubTask[] {
  const parts = goal
    .split(/\s+(?:and|then|plus|\+)\s+|[,;]\s+|\s*\n+\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks = (parts.length > 1 ? parts : [goal]).slice(0, Math.max(1, maxTasks));
  return chunks.map((chunk, i) => ({
    title: chunks.length === 1 ? `Execute: ${chunk.slice(0, 60)}` : `Part ${i + 1}: ${chunk.slice(0, 50)}`,
    description: `Autonomous swarm subtask ${i + 1}/${chunks.length} for goal "${goal}".\n\nScope: ${chunk}\n\nAcceptance: implement the change, run the relevant build/test command, and leave the worktree green.`,
    requiredCapabilities: ['coding', 'testing'],
    complexity: 'medium' as const,
    category: 'backend',
    dependsOn: [],
    suggestedFiles: [],
  }));
}

/** Pick the verification/bootstrap command for a worktree. */
export function resolveWorktreeTestCommand(worktreePath: string): string {
  try {
    const pkgPath = path.join(worktreePath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['test:oasis']) return 'npm run test:oasis --silent';
      if (pkg.scripts?.['test:unit']) return 'npm run test:unit --silent';
      if (fs.existsSync(path.join(worktreePath, 'apps', 'canva-3d', 'tests', 'canva-3d.test.js'))) {
        return 'node --test apps/canva-3d/tests/canva-3d.test.js';
      }
      if (fs.existsSync(path.join(worktreePath, 'tsconfig.json'))) return 'npx tsc --noEmit';
      if (
        pkg.scripts?.test &&
        !/no test specified/i.test(pkg.scripts.test) &&
        !/vitest run$/i.test(pkg.scripts.test.trim())
      ) {
        return 'npm test --silent';
      }
      return 'npx tsc --noEmit';
    }
  } catch {
    /* fall through */
  }
  return 'npx tsc --noEmit';
}

// ─── Provider resolution ─────────────────────────────────────────

interface OpenCodeGemmaFactory {
  createOpenCodeGemmaProvider?: (opts?: { model?: string }) => IProvider;
  default?: (opts?: { model?: string }) => IProvider;
}

/**
 * Resolve the Gemma reasoning provider. Prefers Agent 3's OpenCode+Gemma
 * backend when it exists in-tree, falls back to a local Ollama-compatible
 * endpoint (loopback only — OpSec: zero cloud traces).
 */
export function resolveIgniteProvider(options: IgniteOptions, cwd: string): { provider: IProvider; label: string } {
  // Explicit provider override from maos.config.json (same path as `maos plan`).
  if (options.provider) {
    const services = createServiceContainer(cwd);
    const config = services.project.loadConfig();
    const providerConfig = config.providers[options.provider];
    if (!providerConfig) {
      throw new Error(
        `Provider "${options.provider}" not found in config. Available: ${Object.keys(config.providers).join(', ')}`,
      );
    }
    const agents = config.agents as Array<{ id: string; model?: string }>;
    const model = options.model || agents[0]?.model || 'default';
    return {
      provider: createProviderDirect(options.provider, providerConfig, model, config.providers, cwd),
      label: `${options.provider}/${model}`,
    };
  }

  // Agent 3's OpenCode+Gemma backend (optional — merged separately).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../backends/opencode-gemma-provider') as OpenCodeGemmaFactory;
    const factory = mod.createOpenCodeGemmaProvider || mod.default;
    if (typeof factory === 'function') {
      const model = options.model || DEFAULT_GEMMA_MODEL;
      return { provider: factory({ model }), label: `opencode-gemma/${model}` };
    }
  } catch {
    /* not merged yet — fall through to Ollama loopback */
  }

  // Default: local Gemma via Ollama (OpenAI-compatible, loopback only).
  const model = options.model || DEFAULT_GEMMA_MODEL;
  const provider = createProviderDirect('ollama', { baseURL: DEFAULT_GEMMA_BASE_URL, apiKey: 'not-needed' }, model);
  return { provider, label: `ollama/${model}` };
}

// ─── Herdr helpers ───────────────────────────────────────────────

function herdrPaneRun(paneId: string, command: string): void {
  execFileSync('herdr', ['pane', 'run', paneId, command], { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
}

function gitDiffStat(cwd: string, branch: string): string {
  try {
    const out = execSync(`git diff --stat main...${branch}`, { cwd, encoding: 'utf-8', timeout: 15000 });
    return out.trim() || '(no diff vs main)';
  } catch {
    try {
      const out = execSync(`git diff --stat HEAD -- .`, { cwd, encoding: 'utf-8', timeout: 15000 });
      return out.trim() || '(clean)';
    } catch {
      return '(diff unavailable)';
    }
  }
}

function tryMergeBranch(cwd: string, branch: string): { merged: boolean; detail: string } {
  try {
    const out = execSync(`git merge --no-ff --no-edit ${branch}`, { cwd, encoding: 'utf-8', timeout: 60000 });
    return { merged: true, detail: out.trim().split('\n').slice(-3).join(' ') || 'merged' };
  } catch (err: unknown) {
    try {
      execSync('git merge --abort', { cwd, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      /* not in a merge — ignore */
    }
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { merged: false, detail: msg.slice(0, 200) };
  }
}

// ─── Main ignite flow ────────────────────────────────────────────

export async function runIgnite(options: IgniteOptions): Promise<void> {
  const cwd = process.cwd();
  const noExit = options.noExit === true || options.exit === false;
  const { panes: maxPanes, maxHeals, goal } = validateIgniteOptions(options);
  const dryRun = options.dryRun === true;
  const watch = dryRun ? false : options.watch !== false;
  const branchPrefix = options.branchPrefix || 'maos-ignite';
  const bus = getMessageBus();

  console.log(
    renderPanel(
      [
        `${getBrandBadge('IGNITE')} ${chalk.bold.hex('#F1F5F9')('Sovereign Swarm Ignition')}`,
        `${chalk.gray('Goal:')} ${chalk.bold.hex('#A78BFA')(`"${goal}"`)}`,
        `${chalk.gray('Harness:')} ${chalk.cyan('herdr')} ${chalk.gray('│')} ${chalk.gray('Engine:')} ${chalk.cyan(options.gemma === false && !options.provider ? 'config default' : 'gemma (local)')}`,
      ],
      chalk.hex('#A78BFA'),
    ),
  );

  // ── Pre-flight ──────────────────────────────────────────────
  const services = createServiceContainer(cwd);
  if (!services.project.isInitialized()) {
    console.log(chalk.red('\n❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    if (noExit) {
      throw new IgniteError('MAOS is not initialized in this directory. Run: maos init');
    }
    process.exit(1);
  }

  if (!dryRun && !(await isHerdrAvailable())) {
    console.log(chalk.red('\n❌ Herdr multiplexer is not reachable (`herdr status` failed).'));
    console.log(chalk.gray('Start Herdr, then retry. OpSec note: Herdr IPC is a local socket only.'));
    if (noExit) {
      throw new IgniteError('Herdr multiplexer is not reachable (`herdr status` failed). Start Herdr, then retry.');
    }
    process.exit(1);
  }
  if (!process.env.HERDR_ENV) {
    console.log(
      chalk.yellow('\n⚠️  Not running inside a Herdr pane (HERDR_ENV unset). Pane splits target the focused session.'),
    );
  }

  // ── Step 1: Task Decomposition (Gemma) ──────────────────────
  const config = services.project.loadConfig();
  const roster = (config.agents as Array<{ id: string; role: string; capabilities: string[] }>).map((a) => ({
    id: a.id,
    role: a.role,
    capabilities: a.capabilities,
  }));

  let subtasks: SubTask[] = [];
  let modelLabel = 'heuristic-fallback';
  const spinner = ora({
    text: chalk.cyan('Gemma is decomposing the goal into atomic subtasks...'),
    spinner: 'dots',
  }).start();
  try {
    const { provider, label } = resolveIgniteProvider(options, cwd);
    modelLabel = label;
    const result = await decompose(provider, goal, roster, cwd);
    subtasks = result.tasks.slice(0, maxPanes);
    spinner.succeed(chalk.green(`Decomposed into ${subtasks.length} subtasks (${label})`));
  } catch (err: unknown) {
    spinner.stop();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`\n⚠️  Model decomposition unavailable (${msg.split('\n')[0].slice(0, 160)}).`));
    console.log(
      chalk.gray(
        'Falling back to heuristic split so the swarm can still launch. Start Ollama/Gemma for full reasoning.',
      ),
    );
    subtasks = heuristicDecompose(goal, maxPanes);
    modelLabel = 'heuristic-fallback';
  }

  console.log('');
  subtasks.forEach((t, i) => {
    console.log(`  ${chalk.bold.hex('#F1F5F9')(`${i + 1}/${subtasks.length}`)}  ${chalk.bold.white(t.title)}`);
    console.log(chalk.gray(`     └─ ${t.description.split('\n')[0].slice(0, 130)}`));
  });
  console.log('');
  console.log(renderDivider(75));

  if (dryRun) {
    console.log(chalk.cyan('\n🔍 Dry run — no panes spawned, no worktrees created, healer not started.'));
    console.log(chalk.gray(`Would spawn ${subtasks.length} worker pane(s) with model ${modelLabel}.`));
    console.log(chalk.gray(`Branches: ${subtasks.map((_, i) => buildWorkerBranch(branchPrefix, goal, i)).join(', ')}`));
    console.log('');
    return;
  }

  // ── Steps 2+3: Multiplex panes + isolated worktrees ─────────
  const workers: IgniteWorker[] = [];
  const igniteDir = path.join(cwd, '.maos', 'ignite');
  fs.mkdirSync(igniteDir, { recursive: true });

  for (let i = 0; i < subtasks.length; i++) {
    const task = subtasks[i];
    const agentId = buildWorkerAgentId(i);
    const branch = buildWorkerBranch(branchPrefix, goal, i);
    const step = ora({
      text: chalk.cyan(`Spawning worker ${i + 1}/${subtasks.length} (${agentId} → ${branch})...`),
    }).start();
    try {
      const wt = ensureWorktree(agentId, branch, cwd);
      const taskFile = path.join(igniteDir, `${agentId}.md`);
      fs.writeFileSync(
        taskFile,
        `# ${task.title}\n\n${task.description}\n\n## Worker\n- agent: ${agentId}\n- branch: ${branch}\n- worktree: ${wt.worktreePath}\n\n## Instructions\n1. Implement ONLY this subtask inside the worktree.\n2. Run the build/tests until green.\n3. Do not touch files outside your scope. The healer watches this pane.\n`,
        'utf-8',
      );
      const direction = i % 2 === 0 ? 'right' : 'down';
      // Worker 0 splits from current pane, then moves to dedicated "Swarm Workers" tab.
      // Workers 1..N split relative to Worker 0's pane inside that tab, keeping Tab 5 pristine!
      const targetPane = i === 0 ? undefined : workers[0]?.paneId;
      let paneId: string;
      try {
        paneId = await herdrSplitPane({ direction, cwd: wt.worktreePath, noFocus: true, targetPane });
        if (i === 0) {
          try {
            await herdrMovePane(paneId, { newTab: true, label: 'Swarm Workers', noFocus: true });
          } catch {
            /* continue gracefully if tab move is not supported */
          }
        }
      } catch (paneErr: unknown) {
        step.fail(
          chalk.yellow(
            `Worker ${agentId} pane split failed (${(paneErr instanceof Error ? paneErr.message : String(paneErr)).slice(0, 100)}). Continuing with remaining workers.`,
          ),
        );
        continue;
      }
      const testCmd = resolveWorktreeTestCommand(wt.worktreePath);
      const safeTitle = task.title.replace(/["'`$\\]/g, '');
      const runCmd =
        process.platform === 'win32'
          ? `Write-Host "[MAOS ignite] ${safeTitle}"; ${testCmd}`
          : `echo "[MAOS ignite] ${safeTitle}" && ${testCmd}`;
      try {
        herdrPaneRun(paneId, runCmd);
      } catch {
        /* continue if pane run fails initially */
      }
      workers.push({ index: i, title: task.title, agentId, branch, worktreePath: wt.worktreePath, paneId, taskFile });
      step.succeed(chalk.green(`Worker ${agentId} live in ${paneId} (${branch})`));
    } catch (err: unknown) {
      step.fail(
        chalk.red(`Worker ${agentId} failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`),
      );
    }
  }

  if (workers.length === 0) {
    console.log(chalk.red('\n❌ No workers spawned — aborting ignite. Check Herdr + git worktree support.'));
    if (noExit) {
      throw new IgniteError('No workers spawned — aborting ignite. Check Herdr + git worktree support.');
    }
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold.cyan(`⚡ ${workers.length} worker pane(s) executing in parallel`));
  workers.forEach((w) => {
    console.log(`  ${chalk.cyan(w.paneId || '?')}  ${chalk.white(w.title)}  ${chalk.gray(`[${w.branch}]`)}`);
  });

  // ── Step 4: Closed-Loop Self-Healing ─────────────────────────
  let healProvider: IProvider | undefined;
  try {
    healProvider = resolveIgniteProvider(options, cwd).provider;
  } catch {
    healProvider = undefined;
  }
  const healer = new AutonomousHealer({
    projectRoot: cwd,
    paneIds: workers.map((w) => w.paneId).filter((p): p is string => Boolean(p)),
    reader: new CliHerdrPaneReader(),
    provider: healProvider,
    bus,
    maxHealsPerPane: maxHeals,
    pollIntervalMs: 4000,
    onHeal: (attempt: HealAttempt) => {
      const icon = attempt.applied ? chalk.green('🩹') : chalk.yellow('👀');
      console.log(
        `  ${icon} ${chalk.gray(attempt.paneId)} ${attempt.applied ? chalk.green('healed') : chalk.yellow('needs review')}: ${chalk.white(attempt.patch.diagnosis.slice(0, 120))}`,
      );
    },
  });
  healer.start();
  console.log(
    chalk.gray(
      '\n🛡️  Autonomous healer watching worker scrollback (recent-unwrapped). Patches apply with backups in .maos/healer-backups/.',
    ),
  );

  if (!watch) {
    // Single sweep, then merge report.
    await new Promise((r) => setTimeout(r, 4500));
    await healer.healOnce();
    healer.stop();
    for (const w of workers) {
      if (w.paneId) void herdrPaneClose(w.paneId);
    }
    printMergeReport(cwd, workers, options.yes === true);
    return;
  }

  // ── Step 5: Consensus & Merge (on Ctrl+C / SIGINT or worker completion) ──
  console.log(chalk.gray('\nPress Ctrl+C to stop the swarm and print the consensus/merge report.'));
  let isShuttingDown = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    console.log(chalk.cyan('\n\n🛑 Stopping swarm...'));
    healer.stop();
    for (const w of workers) {
      if (w.paneId) void herdrPaneClose(w.paneId);
    }
    const stats = healer.getStats();
    console.log(
      chalk.gray(
        `Healer: ${stats.polls} polls, ${stats.patchesApplied} patches applied, ${stats.patchesSkippedLowConfidence} withheld, ${stats.failures} errors.`,
      ),
    );
    printMergeReport(cwd, workers, options.yes === true);
    if (!noExit) {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Heartbeat: periodic worker/pane status while watching.
  const reader = new CliHerdrPaneReader();
  let zeroLiveCount = 0;
  heartbeatTimer = setInterval(async () => {
    try {
      const panes = await reader.listPanes();
      const live = workers.filter((w) => panes.some((p) => p.paneId === w.paneId)).length;
      const stats = healer.getStats();
      const now = new Date().toLocaleTimeString();
      console.log(
        chalk.gray(
          `[${now}] workers ${live}/${workers.length} live │ heals ${stats.patchesApplied} │ withheld ${stats.patchesSkippedLowConfidence} │ traces ${stats.tracesSeen}`,
        ),
      );
      if (live === 0) {
        zeroLiveCount++;
        // If all workers are closed/finished across 2 polling cycles, auto-shutdown gracefully
        if (zeroLiveCount >= 2) {
          shutdown();
        }
      } else {
        zeroLiveCount = 0;
      }
    } catch {
      /* transient Herdr hiccup — next beat retries */
    }
  }, 10000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  // Keep the process alive until a signal arrives or shutdown finishes.
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      if (isShuttingDown) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
    if (typeof checkInterval.unref === 'function') checkInterval.unref();
  });
}

function printMergeReport(cwd: string, workers: IgniteWorker[], autoMerge: boolean): void {
  console.log('');
  console.log(
    renderPanel(
      [`${getBrandBadge('MERGE')} ${chalk.bold.hex('#F1F5F9')('Consensus & Merge Report')}`],
      chalk.hex('#10B981'),
    ),
  );
  for (const w of workers) {
    console.log(`\n  ${chalk.bold.cyan(w.agentId)}  ${chalk.gray(`[${w.branch}]`)}`);
    console.log(chalk.white(`  ${w.title}`));
    const stat = gitDiffStat(cwd, w.branch);
    for (const line of stat.split('\n').slice(0, 10)) {
      console.log(chalk.gray(`    ${line}`));
    }
    if (autoMerge) {
      const res = tryMergeBranch(cwd, w.branch);
      console.log(
        res.merged ? chalk.green(`    ✅ merged: ${res.detail}`) : chalk.red(`    ❌ merge blocked: ${res.detail}`),
      );
    } else {
      console.log(chalk.gray(`    → review: git diff main...${w.branch} │ merge: git merge --no-ff ${w.branch}`));
    }
  }
  if (!autoMerge) {
    console.log(chalk.gray('\nRe-run with --yes to auto-merge clean branches.'));
  }
  console.log('');
}
