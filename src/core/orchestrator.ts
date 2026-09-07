import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getConfigPath, getStatusDir, getPoolPath, getLogsDir, ensureMaosDirectories } from '../utils/paths';
import { createTask, getPendingTasks, moveToActive, moveToDone, getQueueCounts, TaskFile } from './queue';
import { runAgent, AgentConfig, AgentTask, AgentRunResult } from './agent-runner';
import { RuntimeFactory } from '../backends/factory';
import { IRuntime, AgentRuntimeConfig } from '../backends/runtime';
import { ProviderConfig } from '../backends/provider';
import { createLogger, Logger } from '../utils/logger';
import { createRouter, Router, AgentProfile, TaskRequirements, RoutingDecision } from './router';
import { prepareAgentBranch, tagAgentWork, getCurrentBranch } from '../integrations/git';
import { recordTelemetry, TelemetryRecord } from './telemetry';
import { MessageBus, getMessageBus, createEvent } from './message-bus';
import { recoverOrphanedTasks } from './checkpoint';
import { enqueueRetry, drainRetryQueue, DEFAULT_RETRY_POLICY, getRetryQueueStatus } from './retry-queue';
import { wireEventStore } from './event-store';
import { createHealthMonitor, HealthMonitor } from './health-monitor';
import { createMemoryStore } from './context-memory';
import { createRuntimeStatsStore, RuntimeStatsStore } from './runtime-stats';
// v0.3 Multi-Agent Systems
import { getDispatchableTasks, buildDoneIdSet } from './dependency-gate';
import { createCoordinator, Coordinator } from './coordinator';
import { Supervisor } from './supervisor';
import { createObjective, loadObjective, recordPlanCompletion } from './objective-store';

// ─── Types ────────────────────────────────────────────────────

interface MaosConfig {
  projectName: string;
  routingMode: string;
  providers: Record<string, ProviderConfig & { costPerMillionTokens?: number }>;
  agents: Array<
    AgentRuntimeConfig & {
      provider: string;
      model: string;
      maxIterations: number;
      costTier: string;
    }
  >;
  routing: {
    strategy: string;
    costWeight: number;
    capabilityWeight: number;
    maxParallelAgents: number;
    fallbackProvider: string;
  };
}

type AgentStatus = 'IDLE' | 'BUSY' | 'DONE' | 'FAILED' | 'STUCK';

interface OrchestratorState {
  running: boolean;
  activeAgents: Map<string, { taskId: string; startedAt: number }>;
  completedTasks: number;
  failedTasks: number;
  totalTokensUsed: number;
  totalCostUSD: number;
}

export interface OrchestratorOptions {
  /** Override default provider for all agents */
  providerOverride?: string;
  /** Poll interval in ms (default: 3000) */
  pollIntervalMs?: number;
  /** Project root (default: process.cwd()) */
  cwd?: string;
  /** Callback for live status updates */
  onStatusUpdate?: (state: OrchestratorState) => void;
  /** Force start with reduced fleet even if credentials are missing */
  force?: boolean;
}

// ─── Status File I/O ──────────────────────────────────────────

function writeAgentStatus(agentId: string, status: AgentStatus, detail: string, cwd?: string): void {
  const statusDir = getStatusDir(cwd);
  if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });
  const statusFile = path.join(statusDir, `${agentId}.status`);
  const content = detail ? `${status}: ${detail}` : status;
  fs.writeFileSync(statusFile, content, 'utf-8');
}

function readAgentStatus(agentId: string, cwd?: string): string {
  const statusFile = path.join(getStatusDir(cwd), `${agentId}.status`);
  if (fs.existsSync(statusFile)) {
    return fs.readFileSync(statusFile, 'utf-8').trim();
  }
  return 'IDLE';
}

// ─── Pool ─────────────────────────────────────────────────────

function loadPool(cwd?: string): Record<string, boolean> {
  const poolPath = getPoolPath(cwd);
  if (fs.existsSync(poolPath)) {
    return JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
  }
  return {};
}

// ─── Config ───────────────────────────────────────────────────

function loadConfig(cwd?: string): MaosConfig {
  const configPath = getConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    throw new Error('MAOS is not initialized. Run: maos init');
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── Task Matching (via Router) ───────────────────────────────

/**
 * Build AgentProfile array from config + runtime state.
 * Enriches profiles with live runtimeStats and healthState when available.
 */
function buildAgentProfiles(
  config: MaosConfig,
  pool: Record<string, boolean>,
  activeAgents: Map<string, any>,
  statsStore?: RuntimeStatsStore,
  healthMonitor?: HealthMonitor,
): AgentProfile[] {
  return config.agents.map((a) => ({
    id: a.id,
    role: a.role,
    provider: a.provider,
    model: a.model,
    capabilities: a.capabilities,
    costTier: a.costTier,
    maxIterations: a.maxIterations,
    idle: !activeAgents.has(a.id),
    enabled: pool[a.id] !== false,
    // Runtime-aware enrichment (optional — safely absent if not yet initialized)
    runtimeStats: statsStore?.getStats(a.id),
    healthState: healthMonitor?.getAgentHealth(a.id)?.baseState,
    activeTasks: activeAgents.has(a.id) ? 1 : 0,
  }));
}

/**
 * Build TaskRequirements from a TaskFile.
 */
function buildTaskRequirements(task: TaskFile): TaskRequirements {
  return {
    capabilities: task.capabilities,
    complexity: task.complexity,
    category: task.category,
    targetAgent: task.agent,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────

/**
 * Start the MAOS orchestrator loop.
 *
 * This is the main event loop that:
 *   1. Polls .maos/queue/pending/ every N seconds
 *   2. Matches tasks to available agents
 *   3. Dispatches agents in parallel (each in its own async context)
 *   4. Moves tasks through the pipeline: pending → active → done/failed
 *   5. Updates status files for the dashboard
 *   6. Tracks cost + token telemetry
 */
export async function startOrchestrator(options: OrchestratorOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const pollInterval = options.pollIntervalMs || 3000;
  const logger = createLogger(cwd);

  // Ensure dirs exist
  ensureMaosDirectories(cwd);

  // ---- CRASH RECOVERY ----
  // Scan for orphaned active tasks from a previous crashed session.
  // Requeue recoverable tasks, mark partial successes as done.
  const recovery = recoverOrphanedTasks(cwd);
  if (recovery.recovered > 0 || recovery.markedDone > 0) {
    logger.info(
      'RECOVERY',
      `Recovered ${recovery.recovered} tasks (requeued), ${recovery.markedDone} tasks (marked done)`,
    );
    for (const d of recovery.details) {
      logger.info('RECOVERY', `  ${d.taskId}: ${d.action} — ${d.reason}`);
    }
  }

  // Load config
  const config = loadConfig(cwd);
  logger.info('ORCHESTRATOR', `Project: ${config.projectName}`);
  logger.info('ORCHESTRATOR', `Agents: ${config.agents.map((a) => a.id).join(', ')}`);
  logger.info('ORCHESTRATOR', `Poll interval: ${pollInterval}ms`);

  // Initialize message bus
  const bus = getMessageBus();

  // Wire event store — ALL bus events now persisted to .maos/events/events.jsonl
  const eventStore = wireEventStore(bus, cwd);
  logger.info('ORCHESTRATOR', `Event store active → .maos/events/events.jsonl`);

  // Initialize persistent file lock engine
  const { getFileLockRegistry } = require('./scope-guard');
  getFileLockRegistry().init(cwd);

  // Log all bus events for debugging
  bus.onAll((event) => {
    const detail = event.data ? ` | ${JSON.stringify(event.data).substring(0, 100)}` : '';
    logger.info('BUS', `[${event.type}] ${event.agentId}${event.taskId ? ` task:${event.taskId}` : ''}${detail}`);
  });

  // ── CREDENTIAL VALIDATION (v0.3: hard-stop by default) ──
  // Use the new credential store for resolution (checks credentials.json → .env → env vars).
  // If any API agents have missing/placeholder keys, HARD STOP with guidance.
  // Use options.force to bypass (reduced fleet mode).
  const { getAllCredentialStatuses } = require('./credentials');
  const credStatuses = getAllCredentialStatuses(config, cwd);
  const badAgentIds = new Set<string>();

  for (const check of credStatuses) {
    if (check.status === 'valid') {
      logger.info('CREDENTIALS', `✅ ${check.agentId} → ${check.provider}: ${check.detail}`);
    } else {
      logger.error('CREDENTIALS', `❌ ${check.agentId} → ${check.provider}: ${check.detail}`);
      badAgentIds.add(check.agentId);
    }
  }

  // Hard-stop: refuse to start if any agent has credential issues (unless --force)
  if (badAgentIds.size > 0 && !options.force) {
    const badList = credStatuses.filter((c: any) => c.status !== 'valid');

    console.log('');
    console.log(chalk.red.bold('  ❌ MAOS cannot start — credential issues detected:'));
    console.log('');
    for (const c of badList) {
      console.log(chalk.red(`     ${c.agentId} → ${c.provider}: ${c.detail}`));
    }
    console.log('');

    // Auto-launch configure if running interactively
    if (process.stdout.isTTY) {
      const inquirer = require('inquirer');
      const { configureNow } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'configureNow',
          message: 'Configure API keys now?',
          default: true,
        },
      ]);

      if (configureNow) {
        const { runConfigure } = require('../cli/configure');
        await runConfigure([]);
        // Reload and retry
        console.log('');
        console.log(chalk.cyan('  Restarting credential check...'));
        const retryStatuses = getAllCredentialStatuses(config, cwd);
        const stillBad = retryStatuses.filter((c: any) => c.status !== 'valid');
        if (stillBad.length > 0) {
          console.log(chalk.red('  ❌ Some agents still have credential issues.'));
          throw new Error(`Cannot start: ${stillBad.length} agent(s) still have credential issues.`);
        }
        // Clear bad list since we fixed it
        badAgentIds.clear();
        console.log(chalk.green('  ✅ All credentials valid!'));
      } else {
        console.log('');
        console.log(chalk.white('  Options:'));
        console.log(chalk.cyan('    1. Run: maos configure'));
        console.log(chalk.gray('    2. Disable affected agents: pool --disable <agent>'));
        console.log(chalk.gray('    3. Use: start --force  (reduced fleet mode)'));
        console.log('');
        throw new Error(
          `Cannot start: ${badList.length} agent(s) have credential issues. ` +
            `Run "maos configure" or use "start --force" for reduced fleet.`,
        );
      }
    } else {
      // Non-interactive (CI/scripts) — just fail with message
      throw new Error(
        `Cannot start: ${badList.length} agent(s) have credential issues. ` +
          `Run "maos configure" to fix, or use --force flag.`,
      );
    }
  } else if (badAgentIds.size > 0 && options.force) {
    logger.warn(
      'ORCHESTRATOR',
      `--force: ${badAgentIds.size} agent(s) have credential issues, ` + `starting with reduced fleet`,
    );
  }

  // Create runtime instances (API, CLI, or local — per agent config)
  // ── KEY FIX: Enrich providerConfigs with credential-store resolved keys ──
  // The credential store (credentials.json) is the source of truth for keys
  // saved via `maos configure` or `maos init`. The factory's resolveApiKey()
  // only knows about env: references and direct strings in config.json.
  // We bridge the gap here by resolving each provider's key from the full
  // priority chain (credential store → env → config) and injecting it as a
  // direct string so the factory always receives a real key.
  const { resolveCredential } = require('./credentials');
  const enrichedProviders: Record<string, any> = {};
  for (const [providerName, providerConfig] of Object.entries(config.providers || {})) {
    const pc = providerConfig as any;
    const resolved = resolveCredential(providerName, pc.apiKey, cwd);
    if (resolved) {
      enrichedProviders[providerName] = { ...pc, apiKey: resolved.key };
      logger.info('CREDENTIALS', `${providerName}: credential source = ${resolved.source} (key configured)`);
    } else {
      enrichedProviders[providerName] = pc; // fallthrough — factory will throw
    }
  }

  const runtimeMap: Map<string, IRuntime> = new Map();
  for (const agent of config.agents) {
    // Skip agents with bad credentials
    if (badAgentIds.has(agent.id)) {
      logger.warn('ORCHESTRATOR', `${agent.id} is unavailable — no valid API key configured. Run: maos configure`);
      continue;
    }

    // Apply provider override if specified
    const agentConfig = { ...agent };
    if (options.providerOverride && (!agent.runtime || agent.runtime === 'api')) {
      agentConfig.provider = options.providerOverride;
    }

    try {
      // Use enrichedProviders so credential-store keys are used for runtime execution
      const runtime = RuntimeFactory.create(agentConfig, enrichedProviders, bus);
      runtimeMap.set(agent.id, runtime);
      const runtimeType = agent.runtime || 'api';
      logger.info('ORCHESTRATOR', `Runtime: ${agent.id} → ${runtimeType} (${runtime.name}/${runtime.model})`);
    } catch (err: any) {
      logger.error('ORCHESTRATOR', `Failed to create runtime for ${agent.id}: ${err.message}`);
    }
  }

  if (runtimeMap.size === 0) {
    throw new Error(
      'No runtimes could be initialized.\n\n' +
        '  This usually means no valid API keys are configured.\n' +
        '  Run: maos configure\n',
    );
  }

  // Create the router (with telemetry feedback for adaptive scoring)
  const router = createRouter(config.routing, cwd);
  const routerInfo = router.feedback ? 'adaptive (telemetry loaded)' : 'static';
  logger.info(
    'ORCHESTRATOR',
    'Routing strategy: ' + (config.routing.strategy || 'capability_score') + ' [' + routerInfo + ']',
  );

  // ---- HEALTH MONITOR ----
  const healthStateFile = path.join(cwd, '.maos', 'health-state.json');
  const healthMonitor = createHealthMonitor(
    bus,
    {},
    (alert) => {
      if (alert.state === 'DEAD') {
        logger.error('HEALTH', alert.message);
      } else {
        logger.warn('HEALTH', alert.message);
      }
    },
    healthStateFile,
  );

  // ---- RUNTIME STATS STORE ----
  // Bootstrapped from telemetry history on startup. Receives live updates
  // after every task. Drives cooldown, crash-penalty, and load-penalty scoring.
  const statsStore = createRuntimeStatsStore(cwd);
  statsStore.loadFromTelemetry();
  logger.info('ORCHESTRATOR', `Runtime stats store loaded (${statsStore.getAllStats().length} agents from history)`);

  // Subscribe to RUNTIME_CRASHED — apply 120s cooldown immediately
  bus.on('RUNTIME_CRASHED', (event) => {
    const agentId = event.agentId;
    statsStore.applyCooldown(agentId, 120_000);
    logger.warn('SCHEDULER', `Cooldown applied to ${agentId} for 120s after RUNTIME_CRASHED`);
  });

  // State
  const state: OrchestratorState = {
    running: true,
    activeAgents: new Map(),
    completedTasks: 0,
    failedTasks: 0,
    totalTokensUsed: 0,
    totalCostUSD: 0,
  };

  // ── GRACEFUL SHUTDOWN ──
  // Catch SIGINT (Ctrl+C) and SIGTERM to flush state before exit.
  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    logger.info('ORCHESTRATOR', `Received ${signal} — shutting down gracefully...`);
    state.running = false;
    // Dispose message bus to flush pending events
    try {
      bus.dispose();
    } catch {
      /* best effort */
    }
    logger.info('ORCHESTRATOR', 'Shutdown complete. Active tasks will resume on next start.');
  };
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Keep track of tasks currently being finalized to prevent race conditions / double cleanup
  const finalizedTasks = new Set<string>();

  // Track ALL task IDs ever dispatched in this session to prevent re-dispatch loops.
  // Even if a task appears in pending/ again (via retry queue), we won't re-dispatch
  // if we've already completed it successfully in this session.
  const sessionDispatchedTaskIds = new Set<string>();
  // Track task IDs that completed with success (including no_mutation) so they are never retried.
  const sessionCompletedTaskIds = new Set<string>();

  // Initialize all agents as IDLE + register with health monitor
  for (const agent of config.agents) {
    writeAgentStatus(agent.id, 'IDLE', '', cwd);
    const runtimeType = (agent.runtime || 'api') as 'api' | 'cli' | 'local';
    healthMonitor.registerAgent(agent.id, runtimeType);
  }

  // Start health sweeps
  healthMonitor.start();
  logger.info('ORCHESTRATOR', `Health monitor active (sweep every 15s)`);

  // ---- CONTEXT MEMORY ----
  // Initialize shared memory store for inter-agent knowledge transfer.
  // New session = clear previous session's memories.
  const memoryStore = createMemoryStore(cwd);
  memoryStore.clear();
  logger.info('ORCHESTRATOR', `Context memory active (new session, previous entries archived)`);

  // ---- v0.3: COORDINATOR ----
  // Reactive coordination layer: replanning, negotiation, inbox routing.
  const coordinator = createCoordinator(bus, cwd, logger);
  logger.info('ORCHESTRATOR', `Coordinator active (replanning + negotiation)`);

  // ---- v0.3: SUPERVISOR ----
  // Autonomous project manager: velocity tracking, stall detection, completion aggregation.
  const hasPlannerAgent = config.agents.some((a) => a.role === 'planner');
  const supervisor = new Supervisor(bus, coordinator.getInbox(), cwd, logger);
  if (hasPlannerAgent) {
    logger.info('ORCHESTRATOR', `Supervisor active (planner agent detected)`);
  }
  let supervisorTickCounter = 0;

  // ─── Dispatch a single task ─────────────────────────────────
  //
  // The orchestrator no longer cares HOW the task is executed.
  // It calls runtime.execute() and gets back a RuntimeResult.
  // Whether the runtime uses API tool-calling, a CLI subprocess,
  // or a local model is completely transparent.

  async function dispatchTask(task: TaskFile, agentDef: (typeof config.agents)[0], runtime: IRuntime): Promise<void> {
    // Move task to active
    const activeTask = moveToActive(task, cwd);
    // Generate a unique attempt ID for THIS dispatch (not just task ID).
    // This prevents stale guards from blocking legitimate retry re-dispatches.
    const attemptId = `${task.id}__${Date.now()}`;
    // NOTE: state.activeAgents is now set by the CALLER (poll loop) BEFORE
    // this async function is invoked, to prevent the race condition where
    // fire-and-forget dispatch causes the router to see this agent as idle
    // and route multiple tasks to the same agent.

    // Prepare git branch for this agent's work
    const branchName = prepareAgentBranch(agentDef.id, task.id, 'main', cwd);

    // Attempt to create an isolated worktree for this agent
    let agentCwd = cwd;
    try {
      const { isWorktreeSupported, ensureWorktree } = require('../integrations/worktree');
      if (isWorktreeSupported(cwd) && state.activeAgents.size > 1) {
        const wt = ensureWorktree(agentDef.id, branchName, cwd);
        agentCwd = wt.worktreePath;
        logger.info('ORCHESTRATOR', `Worktree created for ${agentDef.id} at ${agentCwd}`);
      }
    } catch {
      /* worktrees optional — fall back to shared directory */
    }

    // Update status
    const runtimeType = agentDef.runtime || 'api';
    writeAgentStatus(agentDef.id, 'BUSY', task.id, cwd);
    logger.info(
      'ORCHESTRATOR',
      `Dispatched ${task.id} → ${agentDef.id} ` +
        `(${runtime.name}/${runtime.model}) ` +
        `[runtime: ${runtimeType}, branch: ${branchName}]`,
    );
    // Emit TASK_STARTED for HealthMonitor + dashboard
    bus.emit(
      createEvent(
        'TASK_STARTED',
        agentDef.id,
        {
          model: runtime.model,
          runtimeType,
          branch: branchName,
        },
        task.id,
        runtimeType as any,
      ),
    );
    options.onStatusUpdate?.(state);

    try {
      // ── THE KEY LINE ──
      // runtime.execute() is the universal interface.
      // ApiRuntime -> calls runAgent() with tool-calling loop
      // CliRuntime -> spawns CLI in Windows Terminal tab
      // Both return the same RuntimeResult.
      const result = await runtime.execute({
        id: task.id,
        description: task.description,
        branch: branchName,
        projectRoot: agentCwd,
        scope: agentDef.scope,
        agentId: agentDef.id,
      });

      // Check if already finalized to prevent race conditions / double cleanup
      if (finalizedTasks.has(attemptId)) {
        logger.warn(
          'ORCHESTRATOR',
          `[FINALIZATION GUARD] Blocked duplicate finalization for ${task.id} (attempt: ${attemptId}, path: success)`,
        );
        return;
      }
      finalizedTasks.add(attemptId);

      // Update telemetry
      state.totalTokensUsed += result.totalTokens || 0;
      state.totalCostUSD += result.costUSD || 0;

      // Safely read content from active file before any moves/deletes
      let taskContent = '';
      if (fs.existsSync(activeTask.filePath)) {
        try {
          taskContent = fs.readFileSync(activeTask.filePath, 'utf-8');
        } catch (err: any) {
          logger.error('ORCHESTRATOR', `Failed to read active task file ${activeTask.filePath}: ${err.message}`);
        }
      }

      if (result.success) {
        state.completedTasks++;
        writeAgentStatus(agentDef.id, 'DONE', result.summary.substring(0, 80), cwd);

        // Mark this task as completed for this session — prevents re-dispatch loops.
        sessionCompletedTaskIds.add(task.id);

        // Log warning for no_mutation (exit 0 but 0 files changed) — this is
        // still a SUCCESS, not a retry candidate. The agent simply decided
        // nothing needed to change (e.g. the work was already done).
        if (result.taskResult === 'no_mutation') {
          logger.warn(
            'ORCHESTRATOR',
            `${agentDef.id} completed ${task.id} with NO file changes (exit code 0). ` +
              `Task is considered done — the agent determined no mutations were needed.`,
          );
        }

        // Move to done
        if (fs.existsSync(activeTask.filePath)) {
          try {
            moveToDone(activeTask, cwd);
          } catch (err: any) {
            logger.error('ORCHESTRATOR', `Failed to move task ${task.id} to done: ${err.message}`);
          }
        }

        // Tag the agent's work with a named branch
        try {
          tagAgentWork(branchName, cwd);
          logger.info('ORCHESTRATOR', `Tagged branch: ${branchName}`);
        } catch (gitErr: any) {
          logger.warn('ORCHESTRATOR', `Git branch tag failed: ${gitErr.message}`);
        }

        const costStr = result.costUSD > 0 ? `$${result.costUSD.toFixed(4)}` : 'subscription';
        const tokenStr = result.totalTokens > 0 ? `${result.totalTokens} tokens` : 'N/A';
        logger.success(
          'ORCHESTRATOR',
          `${agentDef.id} completed ${task.id} [${runtimeType}] — ` +
            `${result.iterations} iters, ${tokenStr}, ${costStr}, ` +
            `${(result.latencyMs / 1000).toFixed(1)}s, ` +
            `${result.filesChanged.length} files`,
        );

        // ─── Update RuntimeStatsStore after success ───────────────────
        statsStore.updateAfterTask(agentDef.id, result, false);

        // Record telemetry
        recordTelemetry(cwd, {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          agentId: agentDef.id,
          provider: agentDef.provider || agentDef.cliCommand || 'unknown',
          model: agentDef.model || agentDef.cliCommand || 'cli',
          routingStrategy: config.routing.strategy || 'capability_score',
          routingScore: 0,
          capabilities: task.capabilities || [],
          complexity: task.complexity || 'medium',
          category: task.category || 'general',
          iterations: result.iterations,
          totalTokens: result.totalTokens,
          costUSD: result.costUSD,
          latencyMs: result.latencyMs,
          success: true,
          filesChanged: result.filesChanged,
          summary: result.summary,
          taskResult: result.taskResult,
          exitCode: result.exitCode,
        });

        // Emit TASK_COMPLETED for HealthMonitor + event store
        bus.emit(
          createEvent(
            'TASK_COMPLETED',
            agentDef.id,
            {
              iterations: result.iterations,
              filesChanged: result.filesChanged.length,
              costUSD: result.costUSD,
              latencyMs: result.latencyMs,
              taskResult: result.taskResult,
              // v0.3: pass objectiveId so coordinator can track completion
              objectiveId: task.objectiveId || undefined,
            },
            task.id,
            runtimeType as any,
          ),
        );

        // ── v0.3: OBJECTIVE-AWARE COMPLETION ──
        if (task.objectiveId && task.type === 'subtask') {
          coordinator.handleSubtaskCompletion(task.id, task.objectiveId);
        }

        // ── v0.3: REVIEW DISPATCH ──
        if (task.type === 'subtask' && task.reviewRequired) {
          const reviewerAgent = config.agents.find((a) => a.role === 'reviewer');
          if (reviewerAgent) {
            createTask({
              type: 'review',
              objectiveId: task.objectiveId,
              parentTaskId: task.id,
              description: `## Code Review: ${task.id}\n\nReview the changes made by ${agentDef.id} for:\n${task.description.substring(0, 500)}\n\n### Summary of Changes\n${result.summary}\n\n### Files Changed\n${result.filesChanged.map((f: string) => '- ' + f).join('\n')}\n\n### Instructions\n1. Review the code for quality, correctness, and adherence to project patterns.\n2. If approved, call task_complete with "APPROVED".\n3. If changes are needed, call task_complete with "CHANGES_REQUIRED: [list of issues]".`,
              capabilities: ['review'],
              complexity: 'low',
              category: 'review',
              cwd,
            });
            logger.info('ORCHESTRATOR', `Review task created for ${task.id}`);
          }
        }
      } else {
        state.failedTasks++;
        writeAgentStatus(agentDef.id, 'FAILED', result.error || 'Unknown error', cwd);
        logger.error('ORCHESTRATOR', `${agentDef.id} failed ${task.id} [${runtimeType}]: ${result.error}`);

        // ─── Update RuntimeStatsStore after failure ─────────────────
        statsStore.updateAfterTask(agentDef.id, result, false);

        // Emit TASK_FAILED for HealthMonitor + event store
        bus.emit(
          createEvent(
            'TASK_FAILED',
            agentDef.id,
            {
              error: (result.error || '').substring(0, 200),
              iterations: result.iterations,
              taskResult: result.taskResult,
              // v0.3: pass objectiveId for coordinator replanning
              objectiveId: task.objectiveId || undefined,
            },
            task.id,
            runtimeType as any,
          ),
        );

        // ---- RETRY QUEUE ----
        // Instead of permanently failing, try to enqueue for retry with backoff.
        const retryPolicy = {
          ...DEFAULT_RETRY_POLICY,
          maxRetries: (agentDef as any).maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
        };
        const retryRecord = enqueueRetry(
          activeTask,
          taskContent,
          result.error || 'Task failed (no error message)',
          result.filesChanged || [],
          result.iterations || 0,
          retryPolicy,
          cwd,
        );
        if (retryRecord) {
          const delaySecs = Math.round(retryRecord.retryDelayMs / 1000);
          logger.warn(
            'ORCHESTRATOR',
            `${task.id} queued for retry #${retryRecord.attemptNumber} ` +
              `(${retryRecord.lastErrorType}) in ${delaySecs}s`,
          );
        } else {
          logger.error('ORCHESTRATOR', `${task.id} dead-lettered — max retries exceeded or not retryable`);

          // ── v0.3: DEAD LETTER → COORDINATOR REPLAN ──
          // When a subtask is permanently dead-lettered, emit a secondary
          // event so the coordinator can trigger replanning.
          if (task.objectiveId && task.type === 'subtask') {
            bus.emit(
              createEvent(
                'TASK_FAILED',
                agentDef.id,
                {
                  error: (result.error || '').substring(0, 200),
                  objectiveId: task.objectiveId,
                  deadLettered: true,
                },
                task.id,
                runtimeType as any,
              ),
            );
          }
        }

        // Clean up the active task file so it doesn't linger in active/
        if (fs.existsSync(activeTask.filePath)) {
          try {
            fs.unlinkSync(activeTask.filePath);
          } catch (err: any) {
            logger.error(
              'ORCHESTRATOR',
              `Failed to delete active task file for failed task ${task.id}: ${err.message}`,
            );
          }
        }

        // Record failure telemetry
        recordTelemetry(cwd, {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          agentId: agentDef.id,
          provider: agentDef.provider || agentDef.cliCommand || 'unknown',
          model: agentDef.model || agentDef.cliCommand || 'cli',
          routingStrategy: config.routing.strategy || 'capability_score',
          routingScore: 0,
          capabilities: task.capabilities || [],
          complexity: task.complexity || 'medium',
          category: task.category || 'general',
          iterations: result.iterations,
          totalTokens: result.totalTokens,
          costUSD: result.costUSD,
          latencyMs: result.latencyMs,
          success: false,
          error: result.error,
          filesChanged: result.filesChanged,
          summary: result.summary || 'Task failed',
          taskResult: result.taskResult,
          exitCode: result.exitCode,
        });
      }
    } catch (err: any) {
      if (finalizedTasks.has(attemptId)) {
        logger.warn(
          'ORCHESTRATOR',
          `[FINALIZATION GUARD] Blocked duplicate finalization for ${task.id} (attempt: ${attemptId}, path: crash)`,
        );
        return;
      }
      finalizedTasks.add(attemptId);

      state.failedTasks++;
      writeAgentStatus(agentDef.id, 'FAILED', err.message, cwd);
      logger.error('ORCHESTRATOR', `${agentDef.id} crashed on ${task.id}: ${err.message}`);

      // Emit TASK_FAILED for HealthMonitor + event store
      bus.emit(
        createEvent(
          'TASK_FAILED',
          agentDef.id,
          {
            error: err.message,
            iterations: 0,
            taskResult: 'failed',
          },
          task.id,
          runtimeType as any,
        ),
      );

      // Safely read content from active file before any moves/deletes
      let taskContent = '';
      if (fs.existsSync(activeTask.filePath)) {
        try {
          taskContent = fs.readFileSync(activeTask.filePath, 'utf-8');
        } catch {}
      }

      // Enqueue crashed tasks for retry too
      try {
        enqueueRetry(activeTask, taskContent, err.message, [], 0, DEFAULT_RETRY_POLICY, cwd);
      } catch (retryErr: any) {
        logger.error('ORCHESTRATOR', `Failed to enqueue crashed task ${task.id} for retry: ${retryErr.message}`);
      }

      // Update stats — mark as crash
      statsStore.updateAfterTask(
        agentDef.id,
        {
          success: false,
          summary: err.message,
          filesChanged: [],
          iterations: 0,
          totalTokens: 0,
          costUSD: 0,
          latencyMs: Date.now() - (state.activeAgents.get(agentDef.id)?.startedAt ?? Date.now()),
          runtimeType: (agentDef.runtime || 'api') as any,
          error: err.message,
          taskResult: 'failed',
          exitCode: -1,
        },
        true,
      );

      // Clean up the active task file
      if (fs.existsSync(activeTask.filePath)) {
        try {
          fs.unlinkSync(activeTask.filePath);
        } catch (unlinkErr: any) {
          logger.error(
            'ORCHESTRATOR',
            `Failed to delete active task file for crashed task ${task.id}: ${unlinkErr.message}`,
          );
        }
      }
    } finally {
      // Release agent
      state.activeAgents.delete(agentDef.id);

      // Release task from sessionDispatchedTaskIds so it can be retried if needed
      sessionDispatchedTaskIds.delete(task.id);

      // Reset to IDLE after a brief delay so dashboard can show DONE/FAILED
      setTimeout(() => {
        const currentStatus = readAgentStatus(agentDef.id, cwd);
        if (currentStatus.startsWith('DONE') || currentStatus.startsWith('FAILED')) {
          writeAgentStatus(agentDef.id, 'IDLE', '', cwd);
        }
      }, 5000);

      options.onStatusUpdate?.(state);
    }
  }

  // ─── Main Poll Loop ─────────────────────────────────────────

  logger.info('ORCHESTRATOR', '🚀 Orchestrator started. Watching for tasks...');

  const poll = async () => {
    if (!state.running) return;

    try {
      // ---- RETRY QUEUE DRAIN ----
      // Check if any retry-eligible tasks are ready to be re-queued.
      const requeued = drainRetryQueue(cwd);
      if (requeued > 0) {
        logger.info('RETRY', `${requeued} task(s) moved from retry queue back to pending`);
      }

      const pool = loadPool(cwd);
      const pending = getPendingTasks(cwd);

      // ── v0.3: DEPENDENCY GATE ──
      // Only dispatch tasks whose dependsOn are ALL in done/.
      const doneIds = buildDoneIdSet(cwd);
      const dispatchable = getDispatchableTasks(pending, doneIds);
      const blocked = pending.length - dispatchable.length;
      if (blocked > 0) {
        logger.info('SCHEDULER', `${blocked} task(s) blocked by unmet dependencies`);
      }

      // ── v0.3: SUPERVISOR SWEEP ──
      supervisorTickCounter++;
      if (supervisorTickCounter % 3 === 0) {
        supervisor.sweep();
      }

      if (dispatchable.length > 0) {
        // Check parallel limit
        const maxParallel = config.routing.maxParallelAgents || config.agents.length;
        const slotsAvailable = maxParallel - state.activeAgents.size;

        if (slotsAvailable > 0) {
          // Try to dispatch up to slotsAvailable tasks
          const toDispatch = dispatchable.slice(0, slotsAvailable);

          for (const task of toDispatch) {
            // ─── SESSION GUARDS ───────────────────────────────────
            // Skip tasks already dispatched or completed in this session.
            // This prevents the infinite loop where:
            //   1. Agent completes with no_mutation (exit 0, 0 files)
            //   2. Retry queue re-creates the pending task
            //   3. Orchestrator picks it up and dispatches again
            //   4. Goto 1
            if (sessionCompletedTaskIds.has(task.id)) {
              logger.info('SCHEDULER', `Skipping ${task.id} — already completed in this session`);
              // Clean it out of pending so it doesn't linger
              try {
                if (fs.existsSync(task.filePath)) fs.unlinkSync(task.filePath);
              } catch {}
              continue;
            }
            if (sessionDispatchedTaskIds.has(task.id)) {
              // Already dispatched and currently running — skip
              continue;
            }
            // Mark as dispatched for this session
            sessionDispatchedTaskIds.add(task.id);

            // Determine retry blacklist (prefer alternate runtime for crashes / repeated failures)
            const retryStatus = getRetryQueueStatus(cwd);
            const retryRecord = retryStatus.find((r) => r.taskId === task.id);
            const blacklist = retryRecord?.preferAlternateRuntime ? [retryRecord.agentId] : [];

            // Use the Router for intelligent task assignment
            // Profiles are enriched with runtimeStats + healthState + activeTasks
            const profiles = buildAgentProfiles(config, pool, state.activeAgents, statsStore, healthMonitor);
            const taskReqs = buildTaskRequirements(task);
            const decision = router.route(taskReqs, profiles, blacklist);

            if (!decision) {
              // No agent available (or all on blacklist) — try without blacklist as fallback
              const fallbackDecision = router.route(taskReqs, profiles, []);
              if (!fallbackDecision) {
                continue; // Truly no agent available
              }
              logger.warn(
                'SCHEDULER',
                `No alternate runtime for ${task.id} — falling back to original agent ` +
                  `(blacklist: [${blacklist.join(', ')}])`,
              );
              const fbAgent = config.agents.find((a) => a.id === fallbackDecision.agentId);
              const fbRuntime = fbAgent ? runtimeMap.get(fbAgent.id) : undefined;
              if (!fbAgent || !fbRuntime) continue;
              // ── PRE-MARK agent as busy BEFORE fire-and-forget dispatch ──
              // This prevents the race condition where the next loop iteration
              // still sees this agent as idle and routes another task to it.
              state.activeAgents.set(fbAgent.id, {
                taskId: task.id,
                startedAt: Date.now(),
              });
              dispatchTask(task, fbAgent, fbRuntime).catch((err) => {
                logger.error('ORCHESTRATOR', `Unhandled dispatch error: ${err.message}`);
              });
              continue;
            }

            const agentDef = config.agents.find((a) => a.id === decision.agentId);
            if (!agentDef) continue;

            const runtime = runtimeMap.get(agentDef.id);
            if (!runtime) {
              logger.warn('ORCHESTRATOR', `No runtime for agent ${agentDef.id} — skipping task ${task.id}`);
              continue;
            }

            // Log routing decision with full runtime-aware breakdown
            const runtimeLabel = agentDef.runtime || 'api';
            const bd = decision.breakdown;
            let routeLog =
              `Routed ${task.id} → ${decision.agentId} [${runtimeLabel}] ` +
              `score:${decision.score.toFixed(3)} | ` +
              `cap:${bd.capabilityScore.toFixed(2)} ` +
              `role:+${bd.roleBonus.toFixed(2)} ` +
              `cost:-${bd.costPenalty.toFixed(3)} ` +
              `cplx:+${bd.complexityBonus.toFixed(2)}`;
            if (bd.healthBonus !== 0) routeLog += ` hlth:${bd.healthBonus > 0 ? '+' : ''}${bd.healthBonus.toFixed(2)}`;
            if (bd.crashPenalty > 0.001) routeLog += ` crash:-${bd.crashPenalty.toFixed(3)}`;
            if (bd.cooldownPenalty > 0) routeLog += ` cool:-${bd.cooldownPenalty.toFixed(2)}`;
            if (bd.loadPenalty > 0.001) routeLog += ` load:-${bd.loadPenalty.toFixed(3)}`;
            if (bd.mutationPenalty > 0.01) routeLog += ` mut:-${bd.mutationPenalty.toFixed(3)}`;
            if (blacklist.length > 0) routeLog += ` [rerouted from: ${blacklist.join(', ')}]`;
            logger.info('SCHEDULER', routeLog);

            // ── PRE-MARK agent as busy BEFORE fire-and-forget dispatch ──
            // This is the critical fix: without this, the router sees the agent
            // as idle on the next loop iteration and routes ALL tasks to CODER_1.
            state.activeAgents.set(agentDef.id, {
              taskId: task.id,
              startedAt: Date.now(),
            });

            // Dispatch in its own async context (fire-and-forget)
            dispatchTask(task, agentDef, runtime).catch((err) => {
              logger.error('ORCHESTRATOR', `Unhandled dispatch error: ${err.message}`);
            });
          }
        }
      }
    } catch (err: any) {
      logger.error('ORCHESTRATOR', `Poll error: ${err.message}`);
    }

    // Schedule next poll
    if (state.running) {
      setTimeout(poll, pollInterval);
    }
  };

  // Handle shutdown
  const shutdown = async () => {
    if (!state.running) return;
    state.running = false;
    logger.info('ORCHESTRATOR', '⏹️ Shutting down...');
    logger.info(
      'ORCHESTRATOR',
      `Session summary: ${state.completedTasks} completed, ${state.failedTasks} failed, ` +
        `${state.totalTokensUsed} tokens, $${state.totalCostUSD.toFixed(4)}`,
    );

    // Dispose all runtimes (kill CLI processes, close connections)
    for (const [agentId, runtime] of runtimeMap) {
      try {
        await runtime.dispose();
      } catch (err: any) {
        logger.warn('ORCHESTRATOR', `Failed to dispose runtime for ${agentId}: ${err.message}`);
      }
    }

    // Stop health monitor sweep
    healthMonitor.stop();

    // Dispose message bus
    bus.dispose();

    // Mark all agents as IDLE
    for (const agent of config.agents) {
      writeAgentStatus(agent.id, 'IDLE', '', cwd);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start polling
  await poll();

  // Keep alive while running
  return new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.running) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}
