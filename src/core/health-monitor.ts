/**
 * MAOS Health Monitor
 *
 * Watches agent heartbeats on the MessageBus and detects dead/stuck agents.
 *
 * How it works:
 *   1. The API runtime emits HEARTBEAT events every N iterations (already defined in bus).
 *   2. The HealthMonitor subscribes and tracks the last heartbeat time per agent.
 *   3. A periodic sweep checks if any BUSY agent hasn't heartbeated in > deadThresholdMs.
 *   4. Dead agents emit a HEALTH_ALERT event (visible in dashboard + logs).
 *   5. On confirmed death, the orchestrator can be notified to cancel/retry the task.
 *
 * Health states:
 *   HEALTHY   — heartbeat received within threshold
 *   DEGRADED  — heartbeat late but task still running
 *   DEAD      — no heartbeat for > deadThresholdMs AND no progress
 *   IDLE      — agent not assigned to a task
 *
 * Thresholds (configurable):
 *   heartbeatIntervalMs : 30_000  (agent should heartbeat every ~30s)
 *   degradedThresholdMs : 60_000  (warn at 60s without heartbeat)
 *   deadThresholdMs     : 180_000 (declare dead at 3 min without heartbeat)
 */

import { MessageBus, BusEvent, createEvent, EventType } from './message-bus';

// ---- Types ----

export type AgentHealthState = 'IDLE' | 'HEALTHY' | 'DEGRADED' | 'DEAD';

export interface AgentHealthRecord {
  agentId: string;
  state: AgentHealthState;

  /** Current task being worked on (if any) */
  currentTaskId?: string;

  /** Last time a HEARTBEAT event was received */
  lastHeartbeatAt?: number;

  /** Last time ANY event was received from this agent */
  lastEventAt: number;

  /** How many consecutive missed heartbeats */
  missedHeartbeats: number;

  /** When the current task started */
  taskStartedAt?: number;

  /** Runtime type: api / cli / local */
  runtimeType?: 'api' | 'cli' | 'local';

  /** Total heartbeats received (for uptime calculation) */
  totalHeartbeats: number;

  /** Number of health alerts fired for this agent */
  alertCount: number;
}

export interface HealthMonitorConfig {
  /** Expected heartbeat interval from agents (ms). Default: 30s */
  heartbeatIntervalMs: number;
  /** Warn after this many ms without a heartbeat. Default: 60s */
  degradedThresholdMs: number;
  /** Declare dead after this many ms without a heartbeat. Default: 3min */
  deadThresholdMs: number;
  /** How often to run the sweep. Default: 15s */
  sweepIntervalMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthMonitorConfig = {
  heartbeatIntervalMs: 30_000,
  degradedThresholdMs: 60_000,
  deadThresholdMs: 180_000,
  sweepIntervalMs: 15_000,
};

export interface HealthAlert {
  agentId: string;
  taskId?: string;
  state: AgentHealthState;
  lastSeen: number;
  silentForMs: number;
  message: string;
  timestamp: number;
}

// ---- HealthMonitor class ----

export class HealthMonitor {
  private records = new Map<string, AgentHealthRecord>();
  private alerts: HealthAlert[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private bus: MessageBus;
  private config: HealthMonitorConfig;
  private onAlert?: (alert: HealthAlert) => void;

  constructor(
    bus: MessageBus,
    config: Partial<HealthMonitorConfig> = {},
    onAlert?: (alert: HealthAlert) => void,
  ) {
    this.bus = bus;
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.onAlert = onAlert;
    this.subscribe();
  }

  // ---- Public API ----

  /**
   * Start periodic health sweeps.
   */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.config.sweepIntervalMs);
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Get current health status for all agents.
   */
  getStatus(): AgentHealthRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Get health for a specific agent.
   */
  getAgentHealth(agentId: string): AgentHealthRecord | undefined {
    return this.records.get(agentId);
  }

  /**
   * Get recent health alerts.
   */
  getAlerts(limit = 20): HealthAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get a dashboard-friendly summary.
   */
  getSummary(): {
    healthy: number;
    degraded: number;
    dead: number;
    idle: number;
    totalAlerts: number;
  } {
    const counts = { healthy: 0, degraded: 0, dead: 0, idle: 0, totalAlerts: this.alerts.length };
    for (const r of this.records.values()) {
      switch (r.state) {
        case 'HEALTHY':  counts.healthy++; break;
        case 'DEGRADED': counts.degraded++; break;
        case 'DEAD':     counts.dead++; break;
        case 'IDLE':     counts.idle++; break;
      }
    }
    return counts;
  }

  /**
   * Register a known agent (before any events arrive).
   * Call this on orchestrator startup for each agent in config.
   */
  registerAgent(agentId: string, runtimeType?: 'api' | 'cli' | 'local'): void {
    if (!this.records.has(agentId)) {
      this.records.set(agentId, {
        agentId,
        state: 'IDLE',
        lastEventAt: Date.now(),
        missedHeartbeats: 0,
        totalHeartbeats: 0,
        alertCount: 0,
        runtimeType,
      });
    } else {
      const rec = this.records.get(agentId)!;
      if (runtimeType) rec.runtimeType = runtimeType;
    }
  }

  // ---- Event Subscription ----

  private subscribe(): void {
    this.bus.onAll((event) => this.handleEvent(event));
  }

  private handleEvent(event: BusEvent): void {
    const { agentId, type, taskId, timestamp, runtimeType } = event;
    const now = timestamp || Date.now();

    // Get or create record
    let rec = this.records.get(agentId);
    if (!rec) {
      rec = {
        agentId,
        state: 'IDLE',
        lastEventAt: now,
        missedHeartbeats: 0,
        totalHeartbeats: 0,
        alertCount: 0,
        runtimeType: runtimeType ?? undefined,
      };
      this.records.set(agentId, rec);
    }

    rec.lastEventAt = now;
    if (runtimeType) rec.runtimeType = runtimeType;

    switch (type) {
      case 'TASK_STARTED':
        rec.state = 'HEALTHY';
        rec.currentTaskId = taskId;
        rec.taskStartedAt = now;
        rec.missedHeartbeats = 0;
        break;

      case 'HEARTBEAT':
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        rec.totalHeartbeats++;
        // If previously degraded/dead but now heartbeating → recover
        if (rec.state === 'DEGRADED' || rec.state === 'DEAD') {
          rec.state = 'HEALTHY';
        }
        break;

      case 'TASK_PROGRESS':
        // Progress counts as implicit heartbeat
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        if (rec.state === 'DEGRADED') rec.state = 'HEALTHY';
        break;

      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
        rec.state = 'IDLE';
        rec.currentTaskId = undefined;
        rec.taskStartedAt = undefined;
        rec.missedHeartbeats = 0;
        break;

      case 'AGENT_READY':
        rec.state = 'IDLE';
        break;

      case 'AGENT_DISPOSED':
        // Keep record but mark as idle
        rec.state = 'IDLE';
        rec.currentTaskId = undefined;
        break;
    }
  }

  // ---- Health Sweep ----

  private sweep(): void {
    const now = Date.now();

    for (const rec of this.records.values()) {
      // Only check agents that are supposed to be working
      if (rec.state === 'IDLE') continue;

      const lastSeen = rec.lastHeartbeatAt ?? rec.lastEventAt ?? rec.taskStartedAt ?? now;
      const silentForMs = now - lastSeen;

      let newState: AgentHealthState = rec.state;

      if (silentForMs > this.config.deadThresholdMs) {
        newState = 'DEAD';
      } else if (silentForMs > this.config.degradedThresholdMs) {
        newState = 'DEGRADED';
      } else {
        newState = 'HEALTHY';
      }

      // Fire alert on state change (healthy→degraded, degraded→dead)
      if (newState !== rec.state && newState !== 'HEALTHY') {
        rec.missedHeartbeats++;
        const alert: HealthAlert = {
          agentId: rec.agentId,
          taskId: rec.currentTaskId,
          state: newState,
          lastSeen,
          silentForMs,
          message: newState === 'DEAD'
            ? `Agent ${rec.agentId} appears DEAD — no heartbeat for ${Math.round(silentForMs / 1000)}s (task: ${rec.currentTaskId || 'none'})`
            : `Agent ${rec.agentId} DEGRADED — no heartbeat for ${Math.round(silentForMs / 1000)}s`,
          timestamp: now,
        };
        this.alerts.push(alert);
        if (this.alerts.length > 200) this.alerts = this.alerts.slice(-200);
        rec.alertCount++;

        // Fire bus event for dashboard / orchestrator
        this.bus.emit(createEvent(
          'HEALTH_ALERT' as EventType,
          rec.agentId,
          {
            state: newState,
            silentForMs,
            taskId: rec.currentTaskId,
            message: alert.message,
          },
          rec.currentTaskId,
          rec.runtimeType,
        ));

        // Notify callback (orchestrator can cancel/retry dead tasks)
        this.onAlert?.(alert);
      }

      rec.state = newState;
    }
  }
}

// ---- Singleton ----

let _monitor: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor | null {
  return _monitor;
}

export function createHealthMonitor(
  bus: MessageBus,
  config?: Partial<HealthMonitorConfig>,
  onAlert?: (alert: HealthAlert) => void,
): HealthMonitor {
  _monitor = new HealthMonitor(bus, config, onAlert);
  return _monitor;
}
