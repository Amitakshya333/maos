import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import {
  getConfigPath,
  getStatusDir,
  getPoolPath,
  getLogsDir,
  ensureMaosDirectories,
} from '../utils/paths';
import {
  getPendingTasks,
  moveToActive,
  moveToDone,
  getQueueCounts,
  TaskFile,
} from './queue';
import { runAgent, AgentConfig, AgentTask, AgentRunResult } from './agent-runner';
import { ProviderFactory } from '../backends/factory';
import { IProvider, ProviderConfig } from '../backends/provider';
import { createLogger, Logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────

interface MaosConfig {
  projectName: string;
  routingMode: string;
  providers: Record<string, ProviderConfig & { costPerMillionTokens?: number }>;
  agents: Array<{
    id: string;
    role: string;
    provider: string;
    model: string;
    capabilities: string[];
    scope: string[];
    maxIterations: number;
    costTier: string;
  }>;
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
}

// ─── Status File I/O ──────────────────────────────────────────

function writeAgentStatus(
  agentId: string,
  status: AgentStatus,
  detail: string,
  cwd?: string,
): void {
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

// ─── Task Matching ────────────────────────────────────────────

/**
 * Find the best available agent for a task.
 * Rules:
 *   1. If the task specifies an agent → use that agent (if idle + enabled)
 *   2. If agent is "AUTO" → score all idle+enabled agents and pick the best
 *   3. Scoring: capability overlap × capabilityWeight - costTier × costWeight
 */
function findBestAgent(
  task: TaskFile,
  config: MaosConfig,
  pool: Record<string, boolean>,
  activeAgents: Map<string, any>,
): typeof config.agents[0] | null {
  // Filter to idle + enabled agents
  const available = config.agents.filter(a => {
    const enabled = pool[a.id] !== false;
    const idle = !activeAgents.has(a.id);
    return enabled && idle;
  });

  if (available.length === 0) return null;

  // If task targets a specific agent
  if (task.agent && task.agent !== 'AUTO') {
    return available.find(a => a.id === task.agent) || null;
  }

  // AUTO routing — score each agent
  const costTierValues: Record<string, number> = {
    free: 0, low: 2, medium: 5, high: 10, premium: 15,
  };

  const scored = available.map(agent => {
    // Capability match score
    const capMatch = task.capabilities.length > 0
      ? task.capabilities.filter(c => agent.capabilities.includes(c)).length /
        Math.max(task.capabilities.length, 1)
      : 0.5; // No required capabilities → neutral score

    // Role bonus (planner for planning tasks, coder for coding, etc.)
    let roleBonus = 0;
    if (task.category === 'planning' && agent.role === 'planner') roleBonus = 0.2;
    if (task.category === 'coding' && agent.role === 'coder') roleBonus = 0.2;
    if (task.category === 'design' && agent.role === 'designer') roleBonus = 0.2;

    // Cost penalty
    const costPenalty = (costTierValues[agent.costTier] || 5) / 100;

    const score =
      capMatch * config.routing.capabilityWeight +
      roleBonus -
      costPenalty * config.routing.costWeight;

    return { agent, score };
  });

  // Sort by score (highest first)
  scored.sort((a, b) => b.score - a.score);

  return scored[0]?.agent || null;
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
export async function startOrchestrator(
  options: OrchestratorOptions = {},
): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const pollInterval = options.pollIntervalMs || 3000;
  const logger = createLogger(cwd);

  // Ensure dirs exist
  ensureMaosDirectories(cwd);

  // Load config
  const config = loadConfig(cwd);
  logger.info('ORCHESTRATOR', `Project: ${config.projectName}`);
  logger.info('ORCHESTRATOR', `Agents: ${config.agents.map(a => a.id).join(', ')}`);
  logger.info('ORCHESTRATOR', `Poll interval: ${pollInterval}ms`);

  // Create provider instances
  const providerMap: Map<string, IProvider> = new Map();
  for (const agent of config.agents) {
    const providerName = options.providerOverride || agent.provider;
    const providerConfig = config.providers[providerName];
    if (!providerConfig) {
      logger.warn('ORCHESTRATOR', `No provider config for "${providerName}" — skipping agent ${agent.id}`);
      continue;
    }
    try {
      const provider = ProviderFactory.create(providerName, providerConfig, agent.model);
      providerMap.set(agent.id, provider);
    } catch (err: any) {
      logger.error('ORCHESTRATOR', `Failed to create provider for ${agent.id}: ${err.message}`);
    }
  }

  if (providerMap.size === 0) {
    throw new Error('No providers could be initialized. Check your config and API keys.');
  }

  // State
  const state: OrchestratorState = {
    running: true,
    activeAgents: new Map(),
    completedTasks: 0,
    failedTasks: 0,
    totalTokensUsed: 0,
    totalCostUSD: 0,
  };

  // Initialize all agents as IDLE
  for (const agent of config.agents) {
    writeAgentStatus(agent.id, 'IDLE', '', cwd);
  }

  // ─── Dispatch a single task ─────────────────────────────────

  async function dispatchTask(
    task: TaskFile,
    agentDef: typeof config.agents[0],
    provider: IProvider,
  ): Promise<void> {
    const agentConfig: AgentConfig = {
      id: agentDef.id,
      role: agentDef.role,
      provider: agentDef.provider,
      model: agentDef.model,
      capabilities: agentDef.capabilities,
      scope: agentDef.scope,
      maxIterations: agentDef.maxIterations,
    };

    const agentTask: AgentTask = {
      id: task.id,
      description: task.description,
      branch: task.branch,
    };

    // Move task to active
    const activeTask = moveToActive(task, cwd);
    state.activeAgents.set(agentDef.id, {
      taskId: task.id,
      startedAt: Date.now(),
    });

    // Update status
    writeAgentStatus(agentDef.id, 'BUSY', task.id, cwd);
    logger.info('ORCHESTRATOR', `Dispatched ${task.id} → ${agentDef.id} (${provider.name}/${provider.model})`);
    options.onStatusUpdate?.(state);

    // Get cost per million tokens
    const providerName = options.providerOverride || agentDef.provider;
    const costPerMillion = config.providers[providerName]?.costPerMillionTokens || 0.50;

    try {
      // Run the agent
      const result: AgentRunResult = await runAgent(
        provider,
        agentConfig,
        agentTask,
        cwd,
        costPerMillion,
        (iteration, action) => {
          writeAgentStatus(agentDef.id, 'BUSY', `${task.id} [iter ${iteration}: ${action}]`, cwd);
        },
      );

      // Move to done
      moveToDone(activeTask, cwd);

      // Update telemetry
      state.totalTokensUsed += result.totalTokens;
      state.totalCostUSD += result.costUSD;

      if (result.success) {
        state.completedTasks++;
        writeAgentStatus(agentDef.id, 'DONE', result.summary.substring(0, 80), cwd);
        logger.success('ORCHESTRATOR',
          `${agentDef.id} completed ${task.id} — ` +
          `${result.iterations} iters, ${result.totalTokens} tokens, $${result.costUSD.toFixed(4)}, ` +
          `${(result.latencyMs / 1000).toFixed(1)}s`
        );
      } else {
        state.failedTasks++;
        writeAgentStatus(agentDef.id, 'FAILED', result.error || 'Unknown error', cwd);
        logger.error('ORCHESTRATOR', `${agentDef.id} failed ${task.id}: ${result.error}`);
      }
    } catch (err: any) {
      state.failedTasks++;
      writeAgentStatus(agentDef.id, 'FAILED', err.message, cwd);
      logger.error('ORCHESTRATOR', `${agentDef.id} crashed on ${task.id}: ${err.message}`);

      // Still move to done so it doesn't stay stuck in active
      try { moveToDone(activeTask, cwd); } catch {}
    } finally {
      // Release agent
      state.activeAgents.delete(agentDef.id);

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
      const pool = loadPool(cwd);
      const pending = getPendingTasks(cwd);

      if (pending.length > 0) {
        // Check parallel limit
        const maxParallel = config.routing.maxParallelAgents || config.agents.length;
        const slotsAvailable = maxParallel - state.activeAgents.size;

        if (slotsAvailable > 0) {
          // Try to dispatch up to slotsAvailable tasks
          const toDispatch = pending.slice(0, slotsAvailable);

          for (const task of toDispatch) {
            const agentDef = findBestAgent(task, config, pool, state.activeAgents);
            if (!agentDef) {
              // No agent available for this task — skip, will retry next poll
              continue;
            }

            const provider = providerMap.get(agentDef.id);
            if (!provider) {
              logger.warn('ORCHESTRATOR', `No provider for agent ${agentDef.id} — skipping task ${task.id}`);
              continue;
            }

            // Dispatch in its own async context (fire-and-forget)
            // This allows multiple agents to work simultaneously
            dispatchTask(task, agentDef, provider).catch(err => {
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
  const shutdown = () => {
    if (!state.running) return;
    state.running = false;
    logger.info('ORCHESTRATOR', '⏹️ Shutting down...');
    logger.info('ORCHESTRATOR',
      `Session summary: ${state.completedTasks} completed, ${state.failedTasks} failed, ` +
      `${state.totalTokensUsed} tokens, $${state.totalCostUSD.toFixed(4)}`
    );

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
