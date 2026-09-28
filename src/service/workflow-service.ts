/**
 * MAOS Workflow Service
 *
 * Wraps objectives, decomposition, and plan history.
 * Extracted from: cli/objective.ts, cli/plan.ts, core/objective-store.ts.
 */

import {
  createObjective as coreCreateObjective,
  loadObjective,
  saveObjective,
  ObjectiveState,
} from '../core/objective-store';
import type { WorkflowStage, PlanHistoryEntry } from '../domain/schemas';
import { type WorkflowProjection, projectWorkflowStage } from '../domain/cockpit';

/**
 * Convert a core ObjectiveState to a domain WorkflowStage.
 */
function toWorkflowStage(obj: ObjectiveState): WorkflowStage {
  return {
    schemaVersion: 1,
    id: obj.id,
    goal: obj.goal,
    status: obj.status,
    version: obj.version,
    childTaskIds: obj.childTaskIds,
    completedChildIds: obj.completedChildIds,
    failedChildIds: obj.failedChildIds,
    cancelledChildIds: obj.cancelledChildIds,
    plannerAgentId: obj.plannerAgentId,
    planHistory: obj.planHistory.map(
      (h): PlanHistoryEntry => ({
        version: h.version,
        createdAt: h.createdAt,
        taskIds: h.taskIds,
        reason: h.reason,
      }),
    ),
    createdAt: obj.createdAt,
    planCompletedAt: obj.planCompletedAt,
    doneAt: obj.doneAt,
    maxReplanAttempts: obj.maxReplanAttempts,
    replanCount: obj.replanCount,
  };
}

export class WorkflowService {
  constructor(private readonly projectRoot: string) {}

  /**
   * Create a new objective (workflow stage).
   */
  createObjective(opts: {
    id: string;
    goal: string;
    plannerAgentId: string;
    maxReplanAttempts?: number;
  }): WorkflowStage {
    const obj = coreCreateObjective({
      ...opts,
      cwd: this.projectRoot,
    });
    return toWorkflowStage(obj);
  }

  /**
   * Load an objective by ID.
   */
  getObjective(id: string): WorkflowStage | null {
    const obj = loadObjective(id, this.projectRoot);
    return obj ? toWorkflowStage(obj) : null;
  }

  /**
   * List all objectives in the project.
   */
  listObjectives(): WorkflowStage[] {
    // Scan the objectives directory for all JSON files
    const objectivesDir = require('path').join(this.projectRoot, '.maos', 'queue', 'objectives');
    const fs = require('fs');
    if (!fs.existsSync(objectivesDir)) return [];
    const files: string[] = fs.readdirSync(objectivesDir).filter((f: string) => f.endsWith('.json'));
    const results: WorkflowStage[] = [];
    for (const file of files) {
      const id = file.replace('.json', '');
      const obj = loadObjective(id, this.projectRoot);
      if (obj) results.push(toWorkflowStage(obj));
    }
    return results;
  }

  /**
   * Get workflow stages associated with a run ID or objective ID.
   */
  getRunStages(runId: string): WorkflowStage[] {
    const all = this.listObjectives();
    return all.filter((obj) => obj.id === runId || obj.id.startsWith(runId) || runId.startsWith(obj.id));
  }

  /**
   * Get typed workflow projection for a stage/objective.
   */
  getWorkflowProjection(stageId: string, projectId = 'default'): WorkflowProjection | null {
    const stage = this.getObjective(stageId);
    if (!stage) return null;
    return projectWorkflowStage(stage, projectId);
  }

  /**
   * Interrupt and cancel an objective/workflow stage.
   * Cancels all uncompleted subtasks, marks active subtasks as interrupted via TaskService,
   * sets status to 'failed', and records the interruption reason.
   */
  interruptObjective(
    id: string,
    reason = 'Workflow cancelled / interrupted',
    taskService?: import('./task-service').TaskService,
  ): WorkflowStage | null {
    const obj = loadObjective(id, this.projectRoot);
    if (!obj) return null;

    const uncompletedIds = obj.childTaskIds.filter(
      (cid) => !obj.completedChildIds.includes(cid),
    );

    for (const cid of uncompletedIds) {
      if (!obj.cancelledChildIds.includes(cid)) {
        obj.cancelledChildIds.push(cid);
      }
      if (taskService) {
        taskService.interruptTask(cid, reason);
      }
    }

    obj.status = 'failed';
    obj.doneAt = new Date().toISOString();
    saveObjective(obj, this.projectRoot);

    return toWorkflowStage(obj);
  }

  /**
   * Interrupt all in-progress, planning, or replanning objectives.
   */
  interruptAllWorkflows(
    reason = 'Emergency interruption / shutdown',
    taskService?: import('./task-service').TaskService,
  ): WorkflowStage[] {
    const all = this.listObjectives();
    const interrupted: WorkflowStage[] = [];

    for (const st of all) {
      if (st.status === 'planning' || st.status === 'replanning' || st.status === 'executing' || st.status === 'reviewing') {
        const res = this.interruptObjective(st.id, reason, taskService);
        if (res) interrupted.push(res);
      }
    }

    return interrupted;
  }
}
