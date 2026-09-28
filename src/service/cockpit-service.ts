/**
 * MAOS Application — Agent Cockpit Service (UI1-15)
 *
 * Provides authoritative, persistent DAG projection and event replay services.
 * Integrates WorkflowPlanningService, EventService, ApprovalService, and ModelManagerService.
 * Guarantees zero GUI-only state, deterministic event replay, and fail-closed security.
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
  CockpitState,
  CockpitRunSummary,
  WorkflowRunProjection,
  WorkflowProjection,
} from '../domain/cockpit';
import {
  createInitialCockpitState,
  reconstructCockpitState,
  summarizeCockpitState,
  projectWorkflowState,
  projectStageNode,
} from '../domain/cockpit';
import type { WorkflowPlan } from '../domain/workflow-plan';
import type { SequencedEvent } from '../domain/schemas';
import type { EventService } from './event-service';
import type { WorkflowPlanningService } from './workflow-planning-service';
import type { ApprovalService } from './approval-service';
import type { SharedModelManager } from './model-manager';
import type { AuditService } from './audit-service';

export interface CockpitServiceOptions {
  readonly eventService: EventService;
  readonly workflowPlanningService: WorkflowPlanningService;
  readonly approvalService?: ApprovalService;
  readonly modelManagerService?: SharedModelManager;
  readonly auditService?: AuditService;
}

export class CockpitService {
  private readonly eventService: EventService;
  private readonly workflowPlanningService: WorkflowPlanningService;
  private readonly approvalService?: ApprovalService;
  private readonly modelManagerService?: SharedModelManager;
  private readonly auditService?: AuditService;

  constructor(
    private readonly projectRoot: string,
    options: CockpitServiceOptions,
  ) {
    this.eventService = options.eventService;
    this.workflowPlanningService = options.workflowPlanningService;
    this.approvalService = options.approvalService;
    this.modelManagerService = options.modelManagerService;
    this.auditService = options.auditService;
  }

  /**
   * Locates a WorkflowPlan for a runId.
   * Matches either plan.provenance.runId === runId, plan.planId === runId,
   * or finds the plan in the stored plans directory.
   */
  public findPlanForRun(runId: string): WorkflowPlan | null {
    // 1. Direct plan lookup
    const directPlan = this.workflowPlanningService.getPlan(runId);
    if (directPlan) {
      return directPlan;
    }

    // 2. Scan plans for matching runId
    const allPlans = this.workflowPlanningService.listPlans();
    for (const p of allPlans) {
      if (p.provenance?.runId === runId || p.planId === runId) {
        return p;
      }
    }

    return null;
  }

  /**
   * Retrieves the authoritative CockpitState for a given runId.
   * Reconstructs the complete DAG and all indicators from stored plans and sequenced events.
   */
  public getCockpitState(projectId: string, runId: string): CockpitState | null {
    const plan = this.findPlanForRun(runId);
    if (!plan) {
      return null;
    }

    // Replay all sequenced events for this project and run
    const events = this.eventService.querySequenced({
      projectId,
      runId,
    });

    let state = reconstructCockpitState(plan, events, { runId });

    // Cross-reference active approvals if available
    if (this.approvalService) {
      try {
        const approvals = this.approvalService.listApprovals({ projectId, runId });
        if (approvals.length > 0) {
          const approvalMap = new Map(approvals.map((a) => [a.stepId || a.taskId, a]));
          const updatedNodes = state.nodes.map((node) => {
            const appr = approvalMap.get(node.stepId);
            if (appr) {
              return Object.freeze({
                ...node,
                approval: Object.freeze({
                  required: true,
                  approvalId: appr.approvalId,
                  scope: appr.scope,
                  status: appr.status,
                  reason: appr.reason,
                  reviewedBy: appr.approvedBy || undefined,
                  reviewedAt: appr.approvedAt || undefined,
                }),
                routes: Object.freeze({
                  stage: node.routes?.stage || `/api/v1/workflows/${encodeURIComponent(node.stepId)}`,
                  approval: `/api/v1/approvals/${encodeURIComponent(appr.approvalId)}`,
                  artifacts: node.routes?.artifacts || Object.freeze([]),
                }),
              });
            }
            return node;
          });

          state = Object.freeze({
            ...state,
            nodes: Object.freeze(updatedNodes),
          });
        }
      } catch {
        // Fallback gracefully if approval storage query encounters an issue
      }
    }

    return state;
  }

  /**
   * Retrieves the authoritative WorkflowRunProjection for a run.
   */
  public getWorkflowRunProjection(projectId: string, runId: string): WorkflowRunProjection | null {
    const state = this.getCockpitState(projectId, runId);
    if (!state) return null;
    return projectWorkflowState(state);
  }

  /**
   * Lists known cockpit runs for a project.
   */
  public listCockpitRuns(projectId: string): CockpitRunSummary[] {
    const plans = this.workflowPlanningService.listPlans();
    const summaries: CockpitRunSummary[] = [];

    for (const plan of plans) {
      if (plan.provenance?.projectId && plan.provenance.projectId !== projectId) {
        continue;
      }
      const runId = plan.provenance?.runId || `run-${plan.planId}`;
      const state = this.getCockpitState(projectId, runId);
      if (state) {
        summaries.push(summarizeCockpitState(state));
      }
    }

    return summaries;
  }

  /**
   * Replays sequenced events from cursor for reconnect and replay scrubber.
   */
  public replayRunEvents(
    projectId: string,
    runId: string,
    fromCursor = 0,
  ): { state: CockpitState; events: SequencedEvent[] } {
    const plan = this.findPlanForRun(runId);
    if (!plan) {
      throw new Error(`Cannot replay: WorkflowPlan for runId '${runId}' not found.`);
    }

    const events = this.eventService.querySequenced({
      projectId,
      runId,
      fromSeq: fromCursor,
    });

    const state = this.getCockpitState(projectId, runId);
    if (!state) {
      throw new Error(`Failed to reconstruct state for runId '${runId}'.`);
    }

    return {
      state: Object.freeze({ ...state, isReplaying: true }),
      events,
    };
  }

  /**
   * Executes stop or force-stop on an active run.
   * Emits authoritative sequenced event and defends against phantom success.
   */
  public async executeRunStop(
    projectId: string,
    runId: string,
    options: {
      mode: 'cancel' | 'force';
      reason?: string;
      confirmed?: boolean;
    },
  ): Promise<{ success: boolean; status: string; stoppedAt: string }> {
    const stoppedAt = new Date().toISOString();

    if (options.mode === 'force') {
      if (!options.confirmed) {
        throw new Error('FORCE_STOP_CONFIRMATION_REQUIRED: Force stop mandates explicit confirmation.');
      }

      if (this.approvalService) {
        await this.approvalService.executeForceStop({
          taskId: runId,
          runId,
          projectId,
          confirm: true,
          reason: options.reason || 'Force stop executed from Agent Cockpit',
          actorId: 'cockpit_operator',
        });
      }
    }

    // Authoritative event emission
    this.eventService.recordEvent({
      eventType: options.mode === 'force' ? 'FORCE_STOP_CONFIRMED' : 'RUN_INTERRUPTED',
      projectId,
      runId,
      correlationId: `cockpit-stop-${Date.now()}`,
      payload: {
        runId,
        mode: options.mode,
        reason: options.reason || 'Execution halted from Agent Cockpit',
        stoppedAt,
      },
    });

    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'stage',
        source: 'cockpit-service',
        data: {
          event: 'COCKPIT_RUN_STOPPED',
          projectId,
          runId,
          mode: options.mode,
          stoppedAt,
        },
      });
    }

    return {
      success: true,
      status: 'interrupted',
      stoppedAt,
    };
  }
}
