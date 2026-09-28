/**
 * MAOS Health Service
 *
 * Wraps diagnostics, pool management, agent health, and retry queues.
 * Extracted from: cli/doctor.ts, cli/pool.ts, core/health-monitor.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStatusDir, getPoolPath } from '../utils/paths';
import { getRetryQueueStatus, getDeadLetterQueue } from '../core/retry-queue';
import type { AgentPoolEntry, RetryEntry, DeadLetterEntry, AgentStatus, DiagnosticResult } from '../domain/schemas';

export class HealthService {
  constructor(private readonly projectRoot: string) {}

  /**
   * Get all agents with their current pool/status state.
   */
  getAgentPool(agents: Array<{ id: string; capabilities: string[]; provider?: string; model?: string }>): AgentPoolEntry[] {
    const poolPath = getPoolPath(this.projectRoot);
    let pool: Record<string, boolean> = {};
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }

    const statusDir = getStatusDir(this.projectRoot);
    return agents.map((agent) => {
      let status: AgentStatus = 'IDLE';
      let detail = '';
      const statusFile = path.join(statusDir, `${agent.id}.status`);
      if (fs.existsSync(statusFile)) {
        const content = fs.readFileSync(statusFile, 'utf-8').trim();
        const [s, ...rest] = content.split(':');
        status = s.trim() as AgentStatus;
        detail = rest.join(':').trim();
      }

      return {
        agentId: agent.id,
        status,
        detail,
        enabled: pool[agent.id] !== false,
        provider: agent.provider,
        model: agent.model,
        capabilities: agent.capabilities,
      };
    });
  }

  /**
   * Enable an agent in the pool.
   */
  enableAgent(agentId: string): void {
    this.setPoolState(agentId, true);
  }

  /**
   * Disable an agent in the pool.
   */
  disableAgent(agentId: string): void {
    this.setPoolState(agentId, false);
  }

  /**
   * Get the retry queue status.
   */
  getRetryQueueStatus(): RetryEntry[] {
    const entries = getRetryQueueStatus(this.projectRoot);
    return entries.map((r: any) => ({
      taskId: r.taskId,
      attemptNumber: r.attemptNumber,
      maxRetries: r.maxRetries,
      lastErrorType: r.lastErrorType,
      readyInMs: r.readyInMs,
    }));
  }

  /**
   * Get the dead letter queue.
   */
  getDeadLetterQueue(): DeadLetterEntry[] {
    const entries = getDeadLetterQueue(this.projectRoot);
    return entries.map((d: any) => ({
      taskId: d.taskId,
      failedAt: d.failedAt ?? '',
      lastError: d.lastError ?? '',
    }));
  }

  /**
   * Run basic health and environment diagnostics.
   */
  runDiagnostics(): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const maosDir = path.join(this.projectRoot, '.maos');

    results.push({
      check: 'project_initialized',
      passed: fs.existsSync(maosDir),
      message: fs.existsSync(maosDir) ? 'MAOS directory present' : 'MAOS directory missing',
    });

    const configPath = path.join(maosDir, 'maos.config.json');
    results.push({
      check: 'config_present',
      passed: fs.existsSync(configPath),
      message: fs.existsSync(configPath) ? 'Configuration file present' : 'Configuration file missing',
    });

    const retryCount = this.getRetryQueueStatus().length;
    results.push({
      check: 'retry_queue_clean',
      passed: retryCount === 0,
      message: retryCount === 0 ? 'Retry queue empty' : `${retryCount} tasks retrying`,
    });

    const deadCount = this.getDeadLetterQueue().length;
    results.push({
      check: 'dead_letter_clean',
      passed: deadCount === 0,
      message: deadCount === 0 ? 'Dead letter queue empty' : `${deadCount} dead tasks`,
    });

    return results;
  }

  // ── Internal ──────────────────────────────────────────────────

  private setPoolState(agentId: string, enabled: boolean): void {
    const poolPath = getPoolPath(this.projectRoot);
    let pool: Record<string, boolean> = {};
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }
    pool[agentId] = enabled;
    const dir = path.dirname(poolPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');
  }
}
