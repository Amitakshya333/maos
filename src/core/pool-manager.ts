import * as fs from 'fs';
import { getPoolPath, getConfigPath, getStatusDir } from '../utils/paths';
import * as path from 'path';

/**
 * MAOS Agent Pool Manager
 *
 * Controls which agents are enabled/disabled in the fleet.
 * The orchestrator checks pool state before dispatching.
 * Think of it like docker-compose's `profiles` — you choose
 * which services are active.
 */

export interface PoolState {
  [agentId: string]: boolean;
}

export interface AgentPoolInfo {
  id: string;
  role: string;
  provider: string;
  model: string;
  enabled: boolean;
  status: string;
  capabilities: string[];
}

// ─── Pool I/O ─────────────────────────────────────────────────

/**
 * Load the current pool state from disk.
 */
export function loadPool(cwd?: string): PoolState {
  const poolPath = getPoolPath(cwd);
  if (fs.existsSync(poolPath)) {
    try {
      return JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save pool state to disk.
 */
export function savePool(pool: PoolState, cwd?: string): void {
  const poolPath = getPoolPath(cwd);
  const dir = path.dirname(poolPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');
}

// ─── Pool Operations ──────────────────────────────────────────

/**
 * Enable an agent in the pool.
 * Returns false if the agent doesn't exist in config.
 */
export function enableAgent(agentId: string, cwd?: string): boolean {
  const config = loadConfig(cwd);
  const agentExists = config.agents.some((a: any) => a.id === agentId);
  if (!agentExists) return false;

  const pool = loadPool(cwd);
  pool[agentId] = true;
  savePool(pool, cwd);
  return true;
}

/**
 * Disable an agent in the pool.
 * Returns false if the agent doesn't exist in config.
 */
export function disableAgent(agentId: string, cwd?: string): boolean {
  const config = loadConfig(cwd);
  const agentExists = config.agents.some((a: any) => a.id === agentId);
  if (!agentExists) return false;

  const pool = loadPool(cwd);
  pool[agentId] = false;
  savePool(pool, cwd);
  return true;
}

/**
 * Toggle an agent's pool state.
 * Returns the new state.
 */
export function toggleAgent(agentId: string, cwd?: string): boolean {
  const pool = loadPool(cwd);
  const currentState = pool[agentId] !== false; // default is ON
  pool[agentId] = !currentState;
  savePool(pool, cwd);
  return !currentState;
}

/**
 * Enable all agents.
 */
export function enableAll(cwd?: string): void {
  const config = loadConfig(cwd);
  const pool: PoolState = {};
  for (const agent of config.agents) {
    pool[agent.id] = true;
  }
  savePool(pool, cwd);
}

/**
 * Disable all agents.
 */
export function disableAll(cwd?: string): void {
  const config = loadConfig(cwd);
  const pool: PoolState = {};
  for (const agent of config.agents) {
    pool[agent.id] = false;
  }
  savePool(pool, cwd);
}

/**
 * Check if an agent is enabled.
 */
export function isAgentEnabled(agentId: string, cwd?: string): boolean {
  const pool = loadPool(cwd);
  return pool[agentId] !== false; // default: enabled
}

/**
 * Get the number of enabled agents.
 */
export function getEnabledCount(cwd?: string): number {
  const config = loadConfig(cwd);
  const pool = loadPool(cwd);
  return config.agents.filter((a: any) => pool[a.id] !== false).length;
}

// ─── Pool Dashboard ───────────────────────────────────────────

/**
 * Get full pool info for the dashboard.
 * Combines config, pool state, and live agent status.
 */
export function getPoolDashboard(cwd?: string): AgentPoolInfo[] {
  const config = loadConfig(cwd);
  const pool = loadPool(cwd);
  const statusDir = getStatusDir(cwd);

  return config.agents.map((agent: any) => {
    const enabled = pool[agent.id] !== false;

    // Read agent status file
    let status = 'IDLE';
    const statusFile = path.join(statusDir, `${agent.id}.status`);
    if (fs.existsSync(statusFile)) {
      status = fs.readFileSync(statusFile, 'utf-8').trim();
    }

    return {
      id: agent.id,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      enabled,
      status,
      capabilities: agent.capabilities || [],
    };
  });
}

// ─── Helpers ──────────────────────────────────────────────────

function loadConfig(cwd?: string): any {
  const configPath = getConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    throw new Error('MAOS is not initialized. Run: maos init');
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}
