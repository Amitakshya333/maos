/**
 * MAOS Message Bus
 *
 * In-process event bus for agent coordination. No external dependencies.
 *
 * Two-layer architecture:
 *   Layer A (this): Orchestration, coordination, progress, dashboards
 *   Layer B (lifecycle): Completion/crash detection (in each runtime)
 *
 * Both API and CLI runtimes emit events to the same bus.
 * The orchestrator, dashboard, and telemetry all subscribe.
 */

// ---- Event Types ----

export type EventType =
  | 'TASK_STARTED' // Agent began working on a task
  | 'TASK_PROGRESS' // Agent made measurable progress (file written, tool called)
  | 'TASK_COMPLETED' // Agent finished successfully
  | 'TASK_FAILED' // Agent encountered a fatal error
  | 'RUNTIME_CRASHED' // Agent process died abruptly (WT tab killed, SIGKILL, OOM, etc.)
  | 'HEARTBEAT' // Agent is alive and working (periodic, now independent of execution loop)
  | 'AGENT_READY' // Agent is idle and available for work
  | 'AGENT_DISPOSED' // Agent runtime was cleaned up
  | 'CONTEXT_COMPRESSED' // API runtime compressed its context window
  | 'BUDGET_WARNING' // Agent nearing iteration/timeout limit
  | 'HEALTH_ALERT' // Health monitor detected a dead/degraded agent
  | 'AGENT_PHASE' // Agent execution phase changed (THINKING/WAITING_ON_PROVIDER/EXECUTING_TOOL/RETRYING)
  | 'PROVIDER_WAITING' // Agent is currently blocked on a provider call (long-inference signal)
  | 'PROVIDER_FAILING' // Provider repeatedly failing — circuit breaker warning before task abort
  // ── v0.3 Objective Lifecycle ──────────────────────────────────
  | 'OBJECTIVE_CREATED' // New objective entered the system
  | 'OBJECTIVE_PLAN_READY' // ARCHITECT finished decomposing → subtasks queued
  | 'OBJECTIVE_REPLANNING' // Subtask failed → ARCHITECT redesigning approach
  | 'OBJECTIVE_COMPLETED' // All subtasks done → objective finished
  | 'OBJECTIVE_FAILED' // Unrecoverable failure → objective abandoned
  // ── v0.3 Coordination Protocol ────────────────────────────────
  | 'COORD_REQUEST' // Agent requests info from the team
  | 'COORD_RESPONSE' // Agent responds to a team request
  // ── v0.3 Review Pipeline ──────────────────────────────────────
  | 'REVIEW_STARTED' // Reviewer began reviewing a subtask
  | 'REVIEW_APPROVED' // Reviewer approved the subtask
  | 'REVIEW_CHANGES_REQUIRED' // Reviewer found issues → fix task created
  // ── v0.3 Supervisor ──────────────────────────────────────────
  | 'SUPERVISOR_NUDGE'; // Supervisor nudged a stalled agent

// ---- Event Payload ----

export interface BusEvent {
  /** Event type */
  type: EventType;

  /** Which agent emitted this event */
  agentId: string;

  /** Associated task ID (if applicable) */
  taskId?: string;

  /** Event timestamp (epoch ms) */
  timestamp: number;

  /** Runtime type that emitted the event */
  runtimeType?: 'api' | 'cli' | 'local';

  /** Flexible payload — varies by event type */
  data?: Record<string, any>;
}

// ---- Event Handler ----

export type EventHandler = (event: BusEvent) => void;

// ---- Message Bus ----

export class MessageBus {
  private listeners = new Map<EventType, Set<EventHandler>>();
  private allListeners = new Set<EventHandler>();
  private eventLog: BusEvent[] = [];
  private maxLogSize = 1000;

  /**
   * Emit an event to all subscribers.
   */
  emit(event: BusEvent): void {
    // Store in log
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }

    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const handler of typeListeners) {
        try {
          handler(event);
        } catch {
          // Don't let a bad listener crash the bus
        }
      }
    }

    // Notify wildcard listeners
    for (const handler of this.allListeners) {
      try {
        handler(event);
      } catch {
        // Don't let a bad listener crash the bus
      }
    }
  }

  /**
   * Subscribe to a specific event type.
   */
  on(type: EventType, handler: EventHandler): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  /**
   * Subscribe to ALL events (wildcard).
   */
  onAll(handler: EventHandler): void {
    this.allListeners.add(handler);
  }

  /**
   * Unsubscribe from a specific event type.
   */
  off(type: EventType, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  /**
   * Unsubscribe from wildcard.
   */
  offAll(handler: EventHandler): void {
    this.allListeners.delete(handler);
  }

  /**
   * Wait for a specific event (Promise-based).
   * Useful for "wait until agent X finishes".
   */
  waitFor(type: EventType, filter?: (e: BusEvent) => boolean, timeoutMs?: number): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const handler: EventHandler = (event) => {
        if (!filter || filter(event)) {
          this.off(type, handler);
          if (timer) clearTimeout(timer);
          resolve(event);
        }
      };

      this.on(type, handler);

      if (timeoutMs) {
        timer = setTimeout(() => {
          this.off(type, handler);
          reject(new Error(`MessageBus.waitFor(${type}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Get recent events (for dashboard / debugging).
   */
  getRecentEvents(count: number = 50): BusEvent[] {
    return this.eventLog.slice(-count);
  }

  /**
   * Get events for a specific agent.
   */
  getAgentEvents(agentId: string, count: number = 20): BusEvent[] {
    return this.eventLog.filter((e) => e.agentId === agentId).slice(-count);
  }

  /**
   * Clear all listeners and log.
   */
  dispose(): void {
    this.listeners.clear();
    this.allListeners.clear();
    this.eventLog = [];
  }
}

// ---- Singleton helper ----

let _globalBus: MessageBus | null = null;

/**
 * Get or create the global message bus instance.
 */
export function getMessageBus(): MessageBus {
  if (!_globalBus) {
    _globalBus = new MessageBus();
  }
  return _globalBus;
}

/**
 * Helper: create a typed event quickly.
 */
export function createEvent(
  type: EventType,
  agentId: string,
  data?: Record<string, any>,
  taskId?: string,
  runtimeType?: 'api' | 'cli' | 'local',
): BusEvent {
  return {
    type,
    agentId,
    taskId,
    timestamp: Date.now(),
    runtimeType,
    data,
  };
}
