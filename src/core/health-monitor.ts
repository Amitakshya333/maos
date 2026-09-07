/**
 * MAOS Health Monitor
 *
 * Watches agent heartbeats on the MessageBus and detects TRULY dead agents.
 *
 * How it works:
 *   1. agent-runner.ts emits HEARTBEAT on a dedicated setInterval (every 20s).
 *      This timer is INDEPENDENT of the provider.generate() call, so long
 *      LLM inference periods do NOT cause false-positive DEAD states.
 *   2. AGENT_PHASE events update the agent's current execution phase.
 *      When providerActive=true, thresholds are extended 3× to avoid
 *      declaring an agent dead while it is waiting for a slow model.
 *   3. A periodic sweep (every 15s) escalates: HEALTHY → DEGRADED → DEAD.
 *      Recovery: DEAD → HEALTHY automatically when a new heartbeat arrives.
 *   4. Dead agents emit HEALTH_ALERT (visible in dashboard + logs).
 *
 * Health states (base):
 *   IDLE      — agent not assigned to a task
 *   HEALTHY   — heartbeat received within threshold
 *   DEGRADED  — heartbeat late, task still running
 *   DEAD      — no heartbeat for > deadThresholdMs (extended when providerActive)
 *
 * Execution phase states (informational, not used for dead detection):
 *   THINKING           — agent is constructing next request
 *   WAITING_ON_PROVIDER — agent is blocked inside provider.generate()
 *   EXECUTING_TOOL     — agent is running a tool call result
 *   RETRYING           — agent is in retry backoff
 *
 * Thresholds (configurable, defaults):
 *   heartbeatIntervalMs  : 20_000  (background scheduler fires every 20s)
 *   degradedThresholdMs  : 90_000  (warn at 90s without heartbeat)
 *   deadThresholdMs      : 270_000 (declare dead at 4.5 min without heartbeat)
 *   providerMultiplier   : 3       (extend thresholds × 3 when providerActive=true)
 *
 * Incident Lifecycle:
 *   ACTIVE     — crash/dead alert just fired, runtime is not yet recovering
 *   RECOVERING — heartbeat resumed after DEAD, waiting for stability window
 *   RECOVERED  — stable for recoveryStabilityMs, incident auto-archived
 *   ARCHIVED   — historical record only, NOT shown in active alert panel
 */

import * as fs from 'fs';
import * as path from 'path';
import { MessageBus, BusEvent, createEvent, EventType } from './message-bus';

// ---- Types ----

/** Base lifecycle states used for dead detection and alerting */
export type AgentHealthBase = 'IDLE' | 'HEALTHY' | 'DEGRADED' | 'DEAD';

/** Execution phase states (informational, set by AGENT_PHASE events) */
export type AgentExecutionPhase =
  | 'THINKING' // Agent computing next request
  | 'WAITING_ON_PROVIDER' // Blocked inside provider.generate()
  | 'EXECUTING_TOOL' // Running tool call
  | 'RETRYING'; // In retry backoff

/** All possible states surfaced to the dashboard */
export type AgentHealthState = AgentHealthBase | AgentExecutionPhase;

/**
 * Incident lifecycle state machine.
 *
 *   ACTIVE → (heartbeat resumes) → RECOVERING → (stable for stabilityMs) → RECOVERED → ARCHIVED
 *
 * Only ACTIVE incidents appear in the active alert panel.
 * RECOVERED/ARCHIVED incidents go into the historical log only.
 */
export type IncidentState = 'ACTIVE' | 'RECOVERING' | 'RECOVERED' | 'ARCHIVED';

/**
 * A single crash/dead incident with full lifecycle tracking.
 * Replaces the simple HealthAlert for RUNTIME_CRASHED and sweep-detected DEAD events.
 */
export interface HealthIncident {
  /** Unique incident ID */
  id: string;
  agentId: string;
  taskId?: string;
  /** State when the incident was created (DEAD / DEGRADED) */
  triggerState: AgentHealthState;
  /** Human-readable description of what happened */
  message: string;
  /** When the incident was first detected (ms epoch) */
  createdAt: number;
  /** Current position in the incident lifecycle */
  incidentState: IncidentState;
  /** When the agent's heartbeat first resumed after going DEAD */
  recoveryStartedAt?: number;
  /** When the incident was marked RECOVERED (stable after stability window) */
  recoveredAt?: number;
  /** When the incident was archived */
  archivedAt?: number;
  /** Whether this was triggered by an explicit RUNTIME_CRASHED event */
  isCrash: boolean;
}

/** Legacy flat alert format — kept for backward compat with old dashboard reads */
export interface HealthAlert {
  agentId: string;
  taskId?: string;
  state: AgentHealthState;
  lastSeen: number;
  silentForMs: number;
  message: string;
  timestamp: number;
  /** Incident lifecycle state — undefined = legacy alert (pre-incident-tracking) */
  incidentState?: IncidentState;
  incidentId?: string;
}

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

  // ── Phase tracking (set by AGENT_PHASE events) ──────────────

  /** Current execution phase — informational, not used for dead detection */
  currentPhase?: AgentExecutionPhase;

  /** True when agent is inside an active provider.generate() call.
   *  When true, dead/degraded thresholds are extended (providerMultiplier). */
  providerActive?: boolean;

  /** Timestamp when the current provider call started */
  lastProviderStartAt?: number;

  /** Total provider calls made by this agent */
  providerCallCount?: number;

  /** Base lifecycle state, separate from phase (for sweep logic) */
  baseState: AgentHealthBase;

  /** Active incident ID if this agent currently has an unresolved crash/dead */
  activeIncidentId?: string;
}

export interface HealthMonitorConfig {
  /** Expected heartbeat interval from agents (ms). Default: 20s — matches background scheduler */
  heartbeatIntervalMs: number;
  /** Warn after this many ms without a heartbeat. Default: 90s */
  degradedThresholdMs: number;
  /** Declare dead after this many ms without a heartbeat. Default: 4.5 min */
  deadThresholdMs: number;
  /** How often to run the sweep. Default: 15s */
  sweepIntervalMs: number;
  /**
   * Threshold multiplier when agent is known to be waiting on a provider call.
   * Prevents false DEAD during long LLM inference (504s, retries, slow models).
   * Default: 3 → 4.5min degraded, 13.5min dead while providerActive=true.
   */
  providerActiveMultiplier: number;
  /**
   * How long an agent must be continuously healthy before a RECOVERING incident
   * is marked RECOVERED and archived. Default: 30s.
   * Prevents flapping: crash → 1 heartbeat → recovered → crash → ...
   */
  recoveryStabilityMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthMonitorConfig = {
  heartbeatIntervalMs: 20_000, // matches agent-runner's background scheduler
  degradedThresholdMs: 90_000, // 90s before DEGRADED (up from 60s)
  deadThresholdMs: 270_000, // 4.5 min before DEAD (up from 3 min)
  sweepIntervalMs: 15_000,
  providerActiveMultiplier: 3, // 3× extension when waiting on provider
  recoveryStabilityMs: 30_000, // 30s of healthy heartbeats before RECOVERED
};

// ---- HealthMonitor class ----

export class HealthMonitor {
  private records = new Map<string, AgentHealthRecord>();

  /**
   * Active incidents — keyed by incidentId.
   * Only ACTIVE and RECOVERING incidents live here.
   * Incidents move to archivedIncidents once RECOVERED.
   */
  private activeIncidents = new Map<string, HealthIncident>();

  /**
   * Historical incident archive — bounded to last 200 incidents.
   * Incidents here are RECOVERED or ARCHIVED.
   */
  private archivedIncidents: HealthIncident[] = [];

  /** Legacy alerts array — populated for backward compat, bounded to 200. */
  private alerts: HealthAlert[] = [];

  private sweepTimer: NodeJS.Timeout | null = null;
  private bus: MessageBus;
  private config: HealthMonitorConfig;
  private onAlert?: (alert: HealthAlert) => void;
  private healthStateFile?: string;

  private _incidentCounter = 0;

  constructor(
    bus: MessageBus,
    config: Partial<HealthMonitorConfig> = {},
    onAlert?: (alert: HealthAlert) => void,
    healthStateFile?: string,
  ) {
    this.bus = bus;
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.onAlert = onAlert;
    this.healthStateFile = healthStateFile;
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
   * Get recent health alerts (legacy format, backward compat).
   * Only returns alerts for ACTIVE incidents — recovered incidents are excluded.
   */
  getAlerts(limit = 20): HealthAlert[] {
    // Only return alerts that correspond to still-ACTIVE incidents
    const activeIncidentIds = new Set(
      Array.from(this.activeIncidents.values())
        .filter((i) => i.incidentState === 'ACTIVE')
        .map((i) => i.id),
    );

    // Filter legacy alerts to only those tied to active incidents
    const activeAlerts = this.alerts.filter((a) => !a.incidentId || activeIncidentIds.has(a.incidentId));
    return activeAlerts.slice(-limit);
  }

  /**
   * Get all currently ACTIVE incidents (unresolved crashes/deaths).
   * These are the alerts that should appear in the active incident panel.
   */
  getActiveIncidents(): HealthIncident[] {
    return Array.from(this.activeIncidents.values()).filter(
      (i) => i.incidentState === 'ACTIVE' || i.incidentState === 'RECOVERING',
    );
  }

  /**
   * Get historical (RECOVERED/ARCHIVED) incidents.
   */
  getArchivedIncidents(limit = 20): HealthIncident[] {
    return this.archivedIncidents.slice(-limit);
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
    activeIncidents: number;
    recoveredIncidents: number;
  } {
    const counts = {
      healthy: 0,
      degraded: 0,
      dead: 0,
      idle: 0,
      totalAlerts: this.alerts.length,
      activeIncidents: this.getActiveIncidents().length,
      recoveredIncidents: this.archivedIncidents.length,
    };
    for (const r of this.records.values()) {
      switch (r.state) {
        case 'HEALTHY':
          counts.healthy++;
          break;
        case 'DEGRADED':
          counts.degraded++;
          break;
        case 'DEAD':
          counts.dead++;
          break;
        case 'IDLE':
          counts.idle++;
          break;
      }
    }
    return counts;
  }

  /**
   * Persist current state to disk so other processes (e.g. dashboard) can read it.
   * Written atomically via a temp-file rename to avoid partial reads.
   */
  private persistToDisk(): void {
    if (!this.healthStateFile) return;
    try {
      const state = {
        updatedAt: Date.now(),
        agents: this.getStatus(),
        summary: this.getSummary(),
        // Active alerts only — never persist stale crash alerts for recovered agents
        alerts: this.getAlerts(50),
        // Full incident picture for dashboard
        activeIncidents: this.getActiveIncidents(),
        archivedIncidents: this.archivedIncidents.slice(-20),
      };
      const tmp = this.healthStateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, this.healthStateFile);
    } catch {
      // Non-fatal: dashboard will just show stale data
    }
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
        baseState: 'IDLE',
        lastEventAt: Date.now(),
        missedHeartbeats: 0,
        totalHeartbeats: 0,
        alertCount: 0,
        runtimeType,
        providerActive: false,
        providerCallCount: 0,
      });
    } else {
      const rec = this.records.get(agentId)!;
      if (runtimeType) rec.runtimeType = runtimeType;
    }
  }

  // ---- Incident Management ----

  private newIncidentId(): string {
    return `inc_${Date.now()}_${++this._incidentCounter}`;
  }

  /**
   * Open a new ACTIVE incident for an agent.
   * If the agent already has an active incident, update it rather than create a duplicate.
   */
  private openIncident(
    rec: AgentHealthRecord,
    triggerState: AgentHealthState,
    message: string,
    isCrash: boolean,
  ): HealthIncident {
    // If agent already has an open incident, update its message and return it
    if (rec.activeIncidentId && this.activeIncidents.has(rec.activeIncidentId)) {
      const existing = this.activeIncidents.get(rec.activeIncidentId)!;
      existing.message = message;
      existing.triggerState = triggerState;
      return existing;
    }

    const incident: HealthIncident = {
      id: this.newIncidentId(),
      agentId: rec.agentId,
      taskId: rec.currentTaskId,
      triggerState,
      message,
      createdAt: Date.now(),
      incidentState: 'ACTIVE',
      isCrash,
    };
    this.activeIncidents.set(incident.id, incident);
    rec.activeIncidentId = incident.id;
    return incident;
  }

  /**
   * Transition an agent's active incident to RECOVERING.
   *
   * IMPORTANT: recovery is keyed on AGENT/RUNTIME identity, NOT task identity.
   * The lookup is through rec.activeIncidentId (agent-scoped pointer), never
   * through taskId. This means the recovery transition fires correctly even when
   * the recovered runtime is executing a completely different task than the one
   * that was running when the crash occurred.
   *
   * Call this whenever any liveness signal arrives for an agent that has an open
   * incident, regardless of what rec.baseState is at that moment. TASK_STARTED
   * may have already flipped baseState to HEALTHY before the first heartbeat.
   */
  private beginRecovery(rec: AgentHealthRecord): void {
    if (!rec.activeIncidentId) return;
    const incident = this.activeIncidents.get(rec.activeIncidentId);
    if (!incident) return;
    if (incident.incidentState !== 'ACTIVE') return; // already recovering or resolved

    incident.incidentState = 'RECOVERING';
    incident.recoveryStartedAt = Date.now();
  }

  /**
   * Check if a RECOVERING incident has been stable long enough to be archived.
   * Called from the sweep loop.
   */
  private maybeArchiveIncident(rec: AgentHealthRecord, now: number): void {
    if (!rec.activeIncidentId) return;
    const incident = this.activeIncidents.get(rec.activeIncidentId);
    if (!incident || incident.incidentState !== 'RECOVERING') return;
    if (!incident.recoveryStartedAt) return;

    const stableForMs = now - incident.recoveryStartedAt;
    if (stableForMs >= this.config.recoveryStabilityMs) {
      // Agent has been stable for the required window — mark as RECOVERED
      incident.incidentState = 'RECOVERED';
      incident.recoveredAt = now;
      incident.archivedAt = now;

      // Move from active to archived
      this.activeIncidents.delete(incident.id);
      this.archivedIncidents.push(incident);
      if (this.archivedIncidents.length > 200) {
        this.archivedIncidents = this.archivedIncidents.slice(-200);
      }

      // Clear agent's active incident pointer
      rec.activeIncidentId = undefined;
      rec.alertCount = 0; // reset alert storm counter after confirmed recovery
    }
  }

  /**
   * Immediately archive an incident when the agent goes IDLE (task completed/failed).
   * A task completing = definitive lifecycle end, no need for stability window.
   */
  private archiveIncidentOnIdle(rec: AgentHealthRecord, now: number): void {
    if (!rec.activeIncidentId) return;
    const incident = this.activeIncidents.get(rec.activeIncidentId);
    if (!incident) return;

    incident.incidentState = 'RECOVERED';
    incident.recoveredAt = now;
    incident.archivedAt = now;
    this.activeIncidents.delete(incident.id);
    this.archivedIncidents.push(incident);
    if (this.archivedIncidents.length > 200) {
      this.archivedIncidents = this.archivedIncidents.slice(-200);
    }
    rec.activeIncidentId = undefined;
    rec.alertCount = 0;
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
        baseState: 'IDLE',
        lastEventAt: now,
        missedHeartbeats: 0,
        totalHeartbeats: 0,
        alertCount: 0,
        runtimeType: runtimeType ?? undefined,
        providerActive: false,
        providerCallCount: 0,
      };
      this.records.set(agentId, rec);
    }

    rec.lastEventAt = now;
    if (runtimeType) rec.runtimeType = runtimeType;

    switch (type) {
      case 'TASK_STARTED':
        rec.baseState = 'HEALTHY';
        rec.state = 'HEALTHY';
        rec.currentTaskId = taskId;
        rec.taskStartedAt = now;
        rec.missedHeartbeats = 0;
        rec.providerActive = false;
        rec.currentPhase = undefined;
        // TASK_STARTED is the first concrete proof that the runtime is alive again
        // after a crash. The orchestrator assigns a new task (new taskId) before
        // any heartbeat arrives, which means HEARTBEAT will see baseState=HEALTHY
        // and skip the DEAD→HEALTHY transition check. We must begin recovery here
        // while we still have the first liveness signal, keyed on agentId.
        this.beginRecovery(rec);
        break;

      case 'HEARTBEAT': {
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        rec.totalHeartbeats++;
        // Update providerActive from heartbeat payload if present
        if (event.data?.providerActive !== undefined) {
          rec.providerActive = event.data.providerActive;
        }
        if (event.data?.phase) {
          rec.currentPhase = event.data.phase as AgentExecutionPhase;
        }
        // Base-state recovery: DEAD or DEGRADED → HEALTHY
        if (rec.baseState === 'DEGRADED' || rec.baseState === 'DEAD') {
          rec.baseState = 'HEALTHY';
          rec.state = rec.currentPhase ?? 'HEALTHY';
        }
        // Incident recovery: decouple from baseState.
        // If an open incident exists (agent crashed previously) begin recovery
        // regardless of what baseState was — TASK_STARTED may have already
        // flipped baseState to HEALTHY before this heartbeat arrived.
        this.beginRecovery(rec);
        break;
      }

      case 'AGENT_PHASE': {
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        const phase = event.data?.phase as AgentExecutionPhase | undefined;
        const providerActive = event.data?.providerActive as boolean | undefined;

        if (phase) rec.currentPhase = phase;
        if (providerActive !== undefined) {
          rec.providerActive = providerActive;
          if (providerActive) {
            rec.lastProviderStartAt = now;
            rec.providerCallCount = (rec.providerCallCount ?? 0) + 1;
          }
        }

        // Base-state recovery: DEAD/DEGRADED → HEALTHY
        if (rec.baseState === 'DEAD' || rec.baseState === 'DEGRADED') {
          rec.baseState = 'HEALTHY';
        }
        rec.state = phase ?? rec.baseState;
        // Incident recovery: agentId-keyed, baseState-independent
        this.beginRecovery(rec);
        break;
      }

      case 'PROVIDER_WAITING': {
        rec.providerActive = true;
        rec.lastProviderStartAt = now;
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        rec.currentPhase = 'WAITING_ON_PROVIDER';
        rec.state = 'WAITING_ON_PROVIDER';
        if (rec.baseState === 'DEAD' || rec.baseState === 'DEGRADED') {
          rec.baseState = 'HEALTHY';
        }
        // Incident recovery: agentId-keyed, baseState-independent
        this.beginRecovery(rec);
        break;
      }

      case 'TASK_PROGRESS':
        rec.lastHeartbeatAt = now;
        rec.missedHeartbeats = 0;
        if (rec.baseState === 'DEGRADED') {
          rec.baseState = 'HEALTHY';
          rec.state = rec.currentPhase ?? 'HEALTHY';
        }
        break;

      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
        // Archive any open incident — task ended, lifecycle is over
        this.archiveIncidentOnIdle(rec, now);
        rec.baseState = 'IDLE';
        rec.state = 'IDLE';
        rec.currentTaskId = undefined;
        rec.taskStartedAt = undefined;
        rec.missedHeartbeats = 0;
        rec.providerActive = false;
        rec.currentPhase = undefined;
        break;

      case 'RUNTIME_CRASHED': {
        // Abrupt process termination (WT tab force-closed, OOM kill, SIGKILL, etc.)
        rec.baseState = 'DEAD';
        rec.state = 'DEAD';
        rec.providerActive = false;

        const crashMsg =
          `Agent ${rec.agentId} RUNTIME_CRASHED — process killed abruptly` +
          ` (task: ${rec.currentTaskId || 'none'}, phase: ${rec.currentPhase ?? 'unknown'})` +
          ` exitType: ${event.data?.exitType ?? 'forced_termination'}`;

        // Open (or update) the incident lifecycle
        const incident = this.openIncident(rec, 'DEAD', crashMsg, true);

        // Legacy alert entry (backward compat)
        const crashAlert: HealthAlert = {
          agentId: rec.agentId,
          taskId: rec.currentTaskId,
          state: 'DEAD',
          lastSeen: rec.lastHeartbeatAt ?? rec.lastEventAt,
          silentForMs: now - (rec.lastHeartbeatAt ?? rec.lastEventAt),
          message: crashMsg,
          timestamp: now,
          incidentState: 'ACTIVE',
          incidentId: incident.id,
        };
        this.alerts.push(crashAlert);
        if (this.alerts.length > 200) this.alerts = this.alerts.slice(-200);
        rec.alertCount++;

        this.bus.emit(
          createEvent(
            'HEALTH_ALERT' as EventType,
            rec.agentId,
            {
              state: 'DEAD',
              exitType: event.data?.exitType ?? 'forced_termination',
              taskId: rec.currentTaskId,
              phase: rec.currentPhase,
              message: crashMsg,
              immediate: true,
              incidentId: incident.id,
            },
            rec.currentTaskId,
            rec.runtimeType,
          ),
        );

        this.onAlert?.(crashAlert);
        break;
      }

      case 'AGENT_READY':
        rec.baseState = 'IDLE';
        rec.state = 'IDLE';
        rec.providerActive = false;
        break;

      case 'AGENT_DISPOSED':
        // Archive any open incident and mark idle
        this.archiveIncidentOnIdle(rec, now);
        rec.baseState = 'IDLE';
        rec.state = 'IDLE';
        rec.currentTaskId = undefined;
        rec.providerActive = false;
        break;
    }

    // Persist to disk so dashboard (separate process) stays in sync
    this.persistToDisk();
  }

  // ---- Health Sweep ----

  private sweep(): void {
    const now = Date.now();

    for (const rec of this.records.values()) {
      if (rec.baseState === 'IDLE') continue;

      const lastSeen = rec.lastHeartbeatAt ?? rec.lastEventAt ?? rec.taskStartedAt ?? now;
      const silentForMs = now - lastSeen;

      const multiplier = rec.providerActive ? this.config.providerActiveMultiplier : 1;
      const effectiveDegradedThreshold = this.config.degradedThresholdMs * multiplier;
      const effectiveDeadThreshold = this.config.deadThresholdMs * multiplier;

      let newBaseState: AgentHealthBase = rec.baseState;

      if (silentForMs > effectiveDeadThreshold) {
        newBaseState = 'DEAD';
      } else if (silentForMs > effectiveDegradedThreshold) {
        newBaseState = 'DEGRADED';
      } else {
        newBaseState = 'HEALTHY';
      }

      // Fire alert on state change (healthy→degraded, degraded→dead)
      if (newBaseState !== rec.baseState && newBaseState !== 'HEALTHY') {
        rec.missedHeartbeats++;
        const providerHint = rec.providerActive ? ` [providerActive=true, thresholds extended ${multiplier}×]` : '';
        const alertMsg =
          newBaseState === 'DEAD'
            ? `Agent ${rec.agentId} appears DEAD — no heartbeat for ${Math.round(silentForMs / 1000)}s` +
              ` (task: ${rec.currentTaskId || 'none'}, phase: ${rec.currentPhase ?? 'unknown'})${providerHint}`
            : `Agent ${rec.agentId} DEGRADED — no heartbeat for ${Math.round(silentForMs / 1000)}s` +
              ` (phase: ${rec.currentPhase ?? 'unknown'})${providerHint}`;

        // Open or update incident
        const incident = this.openIncident(rec, newBaseState, alertMsg, false);

        const alert: HealthAlert = {
          agentId: rec.agentId,
          taskId: rec.currentTaskId,
          state: newBaseState,
          lastSeen,
          silentForMs,
          message: alertMsg,
          timestamp: now,
          incidentState: 'ACTIVE',
          incidentId: incident.id,
        };
        this.alerts.push(alert);
        if (this.alerts.length > 200) this.alerts = this.alerts.slice(-200);
        rec.alertCount++;

        this.bus.emit(
          createEvent(
            'HEALTH_ALERT' as EventType,
            rec.agentId,
            {
              state: newBaseState,
              silentForMs,
              taskId: rec.currentTaskId,
              phase: rec.currentPhase,
              providerActive: rec.providerActive,
              effectiveDeadThresholdMs: effectiveDeadThreshold,
              message: alertMsg,
              incidentId: incident.id,
            },
            rec.currentTaskId,
            rec.runtimeType,
          ),
        );

        this.onAlert?.(alert);
      }

      rec.baseState = newBaseState;
      if (rec.currentPhase && newBaseState === 'HEALTHY') {
        rec.state = rec.currentPhase;
      } else {
        rec.state = newBaseState;
      }

      // Incident lifecycle sweep — agentId-keyed, fully baseState-driven:
      // If the agent is HEALTHY and has an open incident, advance the lifecycle.
      // ACTIVE   → beginRecovery (first time sweep sees HEALTHY after a crash;
      //            covers the case where TASK_STARTED fired but beginRecovery
      //            wasn't called because it wasn't wired to TASK_STARTED in the
      //            previous build, or replay/restart scenarios)
      // RECOVERING → maybeArchiveIncident (stable for recoveryStabilityMs)
      if (newBaseState === 'HEALTHY' && rec.activeIncidentId) {
        const openIncident = this.activeIncidents.get(rec.activeIncidentId);
        if (openIncident) {
          if (openIncident.incidentState === 'ACTIVE') {
            // Sweep caught it — agent is HEALTHY but incident wasn't transitioned
            // by an event handler (e.g. race between TASK_STARTED and sweep)
            this.beginRecovery(rec);
          } else if (openIncident.incidentState === 'RECOVERING') {
            this.maybeArchiveIncident(rec, now);
          }
        }
      }
    }

    this.persistToDisk();
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
  healthStateFile?: string,
): HealthMonitor {
  _monitor = new HealthMonitor(bus, config, onAlert, healthStateFile);
  return _monitor;
}
