/**
 * MAOS Supervisor — Autonomous Project Manager
 *
 * A periodic sweep that runs inside the orchestrator's poll loop
 * (every 3rd tick ≈ every 9 seconds). It observes all active objectives
 * and makes autonomous decisions:
 *
 *   1. Detects stalled agents (0 progress for N iterations)
 *   2. Nudges stuck agents via inbox messages
 *   3. Checks objective completion (all children done → mark done)
 *   4. Detects bottlenecks (multiple agents requesting same artifact)
 *   5. Alerts on long-running objectives
 *
 * The supervisor does NOT create or dispatch tasks. It only observes
 * and nudges. Replanning is handled by the coordinator.
 */

import { MessageBus, BusEvent, createEvent } from './message-bus';
import {
  loadAllObjectives,
  loadObjective,
  saveObjective,
  hasActiveChildren,
  getObjectiveProgress,
  ObjectiveState,
} from './objective-store';
import { getActiveTasks } from './queue';
import { AgentInbox } from './coordinator';

// ── Types ─────────────────────────────────────────────────────

interface AgentVelocity {
  /** Total progress events in current observation window */
  progressCount: number;
  /** Total heartbeats in current observation window */
  heartbeatCount: number;
  /** Last progress timestamp */
  lastProgressAt: number;
  /** Consecutive heartbeats with no progress */
  stallCount: number;
  /** Whether we've already nudged this agent in this stall */
  nudged: boolean;
}

// ── Constants ─────────────────────────────────────────────────

/** Heartbeats with zero progress before we consider the agent stalled */
const STALL_THRESHOLD = 5;

/** Max time an objective can be executing before we alert (30 minutes) */
const OBJECTIVE_TIMEOUT_MS = 30 * 60 * 1000;

// ── Supervisor ────────────────────────────────────────────────

export class Supervisor {
  private bus: MessageBus;
  private inbox: AgentInbox;
  private cwd: string;
  private logger: {
    info: (...a: any[]) => void;
    warn: (...a: any[]) => void;
    error: (...a: any[]) => void;
    success: (...a: any[]) => void;
  };
  private velocity = new Map<string, AgentVelocity>();
  private alertedObjectives = new Set<string>();

  constructor(
    bus: MessageBus,
    inbox: AgentInbox,
    cwd: string,
    logger: {
      info: (...a: any[]) => void;
      warn: (...a: any[]) => void;
      error: (...a: any[]) => void;
      success: (...a: any[]) => void;
    },
  ) {
    this.bus = bus;
    this.inbox = inbox;
    this.cwd = cwd;
    this.logger = logger;

    this.wireEventTracking();
  }

  // ── Main Sweep ────────────────────────────────────────────

  /**
   * Run the supervisor sweep. Called every 3rd poll tick by the orchestrator.
   */
  sweep(): void {
    this.sweepVelocity();
    this.sweepObjectives();
  }

  // ── Velocity Tracking ─────────────────────────────────────

  private wireEventTracking(): void {
    // Track progress events
    this.bus.on('TASK_PROGRESS', (event: BusEvent) => {
      const vel = this.getOrCreateVelocity(event.agentId);
      vel.progressCount++;
      vel.lastProgressAt = event.timestamp;
      vel.stallCount = 0;
      vel.nudged = false;
    });

    // Track heartbeats (used for stall detection)
    this.bus.on('HEARTBEAT', (event: BusEvent) => {
      const vel = this.getOrCreateVelocity(event.agentId);
      vel.heartbeatCount++;

      // Check if this heartbeat had progress or is waiting for LLM generation
      const hasProgress =
        event.data?.filesChanged > 0 ||
        event.data?.toolCalls > 0 ||
        event.data?.productive === true ||
        event.data?.providerActive === true ||
        event.data?.phase === 'WAITING_ON_PROVIDER';

      if (!hasProgress) {
        vel.stallCount++;
      } else {
        vel.stallCount = 0;
        vel.nudged = false;
      }
    });

    // Reset velocity on task completion/failure
    this.bus.on('TASK_COMPLETED', (event: BusEvent) => {
      this.velocity.delete(event.agentId);
    });

    this.bus.on('TASK_FAILED', (event: BusEvent) => {
      this.velocity.delete(event.agentId);
    });
  }

  private sweepVelocity(): void {
    for (const [agentId, vel] of this.velocity.entries()) {
      if (vel.stallCount >= STALL_THRESHOLD && !vel.nudged) {
        // Agent is stalled — nudge it
        this.nudgeAgent(agentId, vel);
        vel.nudged = true;
      }
    }
  }

  private nudgeAgent(agentId: string, vel: AgentVelocity): void {
    this.inbox.push(agentId, {
      id: `nudge_${Date.now()}`,
      type: 'nudge',
      from: 'SUPERVISOR',
      to: agentId,
      content:
        `You appear stuck (${vel.stallCount} iterations with no visible progress). ` +
        `Consider: (1) Try a different approach, (2) Commit partial work and call task_complete ` +
        `with a summary of what you accomplished and what remains.`,
      timestamp: Date.now(),
    });

    this.bus.emit(
      createEvent('SUPERVISOR_NUDGE', agentId, {
        stallCount: vel.stallCount,
        heartbeats: vel.heartbeatCount,
      }),
    );

    this.logger.warn('SUPERVISOR', `Nudged ${agentId} — stalled for ${vel.stallCount} iterations`);
  }

  // ── Objective Monitoring ──────────────────────────────────

  private sweepObjectives(): void {
    const objectives = loadAllObjectives(this.cwd);

    for (const obj of objectives) {
      if (obj.status === 'done' || obj.status === 'failed') continue;

      // Check for completion (all children done)
      if (obj.status === 'executing' && !hasActiveChildren(obj)) {
        if (obj.completedChildIds.length > 0) {
          obj.status = 'done';
          obj.doneAt = new Date().toISOString();
          saveObjective(obj, this.cwd);

          this.bus.emit(
            createEvent('OBJECTIVE_COMPLETED', 'SUPERVISOR', {
              objectiveId: obj.id,
              goal: obj.goal,
              subtasksCompleted: obj.completedChildIds.length,
              progress: 100,
            }),
          );

          this.logger.success(
            'SUPERVISOR',
            `🎉 Objective COMPLETED: "${obj.goal}" (${obj.completedChildIds.length} subtasks)`,
          );
        }
      }

      // Check for timeout across all active states (executing, planning, replanning)
      const isMonitoredState = obj.status === 'executing' || obj.status === 'planning' || obj.status === 'replanning';
      if (isMonitoredState && !this.alertedObjectives.has(obj.id)) {
        const elapsed = Date.now() - new Date(obj.createdAt).getTime();
        if (elapsed > OBJECTIVE_TIMEOUT_MS) {
          this.alertedObjectives.add(obj.id);
          const progress = getObjectiveProgress(obj);
          this.logger.warn(
            'SUPERVISOR',
            `Objective "${obj.goal}" has been in status "${obj.status}" for ${Math.round(elapsed / 60000)}m ` +
              `(${progress}% complete). Consider manual intervention.`,
          );
        }
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private getOrCreateVelocity(agentId: string): AgentVelocity {
    if (!this.velocity.has(agentId)) {
      this.velocity.set(agentId, {
        progressCount: 0,
        heartbeatCount: 0,
        lastProgressAt: Date.now(),
        stallCount: 0,
        nudged: false,
      });
    }
    return this.velocity.get(agentId)!;
  }

  /**
   * Get velocity stats for dashboard display.
   */
  getVelocityStats(): Map<string, AgentVelocity> {
    return new Map(this.velocity);
  }
}
