/**
 * MAOS Objective Store
 *
 * Manages the lifecycle of high-level objectives — the "project-level"
 * tasks that get decomposed into subtasks by the ARCHITECT agent.
 *
 * State is persisted to .maos/queue/objectives/{objectiveId}.json
 *
 * Objective lifecycle:
 *   planning → executing → replanning? → reviewing? → done | failed
 *
 * Each objective tracks:
 *   - The original goal
 *   - All child subtask IDs
 *   - Completion / failure of each child
 *   - Plan history (for replanning audit trail)
 *   - Replan counter (capped at maxReplanAttempts)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getObjectivesDir } from '../utils/paths';

// ── Types ─────────────────────────────────────────────────────

export type ObjectiveStatus =
  | 'planning' // ARCHITECT is decomposing
  | 'executing' // Subtasks are being worked on
  | 'replanning' // A subtask failed and ARCHITECT is redesigning
  | 'reviewing' // All subtasks done, final review in progress
  | 'done' // All children completed successfully
  | 'failed'; // Unrecoverable failure

export interface PlanHistoryEntry {
  /** Plan version (1-indexed, increments on replan) */
  version: number;
  /** When this plan was created */
  createdAt: string;
  /** Task IDs created by this plan version */
  taskIds: string[];
  /** Why this plan was created (initial / replan reason) */
  reason: string;
}

export interface ObjectiveState {
  /** Unique objective ID (matches the objective task's ID) */
  id: string;
  /** The original high-level goal from the user */
  goal: string;
  /** Current lifecycle status */
  status: ObjectiveStatus;
  /** Current plan version (increments on replan) */
  version: number;
  /** All child task IDs across all plan versions */
  childTaskIds: string[];
  /** Subset of childTaskIds that completed successfully */
  completedChildIds: string[];
  /** Subset of childTaskIds that failed permanently */
  failedChildIds: string[];
  /** Subset of childTaskIds that were cancelled (e.g., on replan) */
  cancelledChildIds: string[];
  /** Which agent did the planning */
  plannerAgentId: string;
  /** Full plan history for audit trail */
  planHistory: PlanHistoryEntry[];
  /** When the objective was created */
  createdAt: string;
  /** When planning completed (null if still planning) */
  planCompletedAt: string | null;
  /** When the objective reached done/failed (null if still active) */
  doneAt: string | null;
  /** Maximum replan attempts before giving up */
  maxReplanAttempts: number;
  /** How many times we've replanned so far */
  replanCount: number;
}

// ── CRUD ──────────────────────────────────────────────────────

/**
 * Create a new objective and persist it.
 */
export function createObjective(opts: {
  id: string;
  goal: string;
  plannerAgentId: string;
  maxReplanAttempts?: number;
  cwd?: string;
}): ObjectiveState {
  const obj: ObjectiveState = {
    id: opts.id,
    goal: opts.goal,
    status: 'planning',
    version: 0,
    childTaskIds: [],
    completedChildIds: [],
    failedChildIds: [],
    cancelledChildIds: [],
    plannerAgentId: opts.plannerAgentId,
    planHistory: [],
    createdAt: new Date().toISOString(),
    planCompletedAt: null,
    doneAt: null,
    maxReplanAttempts: opts.maxReplanAttempts ?? 2,
    replanCount: 0,
  };

  saveObjective(obj, opts.cwd);
  return obj;
}

/**
 * Load an objective by ID. Returns null if not found.
 */
export function loadObjective(id: string, cwd?: string): ObjectiveState | null {
  const filePath = getObjectiveFilePath(id, cwd);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ObjectiveState;
  } catch {
    return null;
  }
}

/**
 * Save an objective state to disk (atomic write-then-rename).
 */
export function saveObjective(obj: ObjectiveState, cwd?: string): void {
  const dir = getObjectivesDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = getObjectiveFilePath(obj.id, cwd);
  const tmpPath = filePath + '.tmp';

  // Atomic write: write to temp file, then rename
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Load all objectives (all statuses).
 */
export function loadAllObjectives(cwd?: string): ObjectiveState[] {
  const dir = getObjectivesDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        return JSON.parse(content) as ObjectiveState;
      } catch {
        return null;
      }
    })
    .filter((o): o is ObjectiveState => o !== null);
}

// ── State Transitions ─────────────────────────────────────────

/**
 * Record that planning completed and subtasks were created.
 */
export function recordPlanCompletion(objectiveId: string, subtaskIds: string[], reason: string, cwd?: string): void {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return;

  obj.version++;
  obj.planHistory.push({
    version: obj.version,
    createdAt: new Date().toISOString(),
    taskIds: subtaskIds,
    reason,
  });
  obj.childTaskIds = [...obj.childTaskIds, ...subtaskIds];
  obj.status = 'executing';
  obj.planCompletedAt = new Date().toISOString();

  saveObjective(obj, cwd);
}

/**
 * Record a subtask completion.
 */
export function recordChildCompletion(objectiveId: string, taskId: string, cwd?: string): void {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return;

  if (!obj.completedChildIds.includes(taskId)) {
    obj.completedChildIds.push(taskId);
  }

  // Check if all active children are done
  const activeChildren = obj.childTaskIds.filter(
    (id) =>
      !obj.completedChildIds.includes(id) && !obj.failedChildIds.includes(id) && !obj.cancelledChildIds.includes(id),
  );

  if (activeChildren.length === 0 && obj.completedChildIds.length > 0) {
    obj.status = 'done';
    obj.doneAt = new Date().toISOString();
  }

  saveObjective(obj, cwd);
}

/**
 * Record a subtask failure (after retries exhausted / dead-lettered).
 */
export function recordChildFailure(objectiveId: string, taskId: string, cwd?: string): void {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return;

  if (!obj.failedChildIds.includes(taskId)) {
    obj.failedChildIds.push(taskId);
  }

  saveObjective(obj, cwd);
}

/**
 * Cancel pending subtasks of an objective (used during replanning).
 */
export function cancelObjectiveSubtasks(objectiveId: string, taskIds: string[], cwd?: string): void {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return;

  for (const id of taskIds) {
    if (!obj.cancelledChildIds.includes(id)) {
      obj.cancelledChildIds.push(id);
    }
  }

  saveObjective(obj, cwd);
}

/**
 * Mark an objective as replanning.
 */
export function startReplan(objectiveId: string, cwd?: string): ObjectiveState | null {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return null;

  if (obj.replanCount >= obj.maxReplanAttempts) {
    obj.status = 'failed';
    obj.doneAt = new Date().toISOString();
    saveObjective(obj, cwd);
    return obj;
  }

  obj.status = 'replanning';
  obj.replanCount++;
  saveObjective(obj, cwd);
  return obj;
}

/**
 * Mark an objective as failed.
 */
export function failObjective(objectiveId: string, reason: string, cwd?: string): void {
  const obj = loadObjective(objectiveId, cwd);
  if (!obj) return;

  obj.status = 'failed';
  obj.doneAt = new Date().toISOString();
  saveObjective(obj, cwd);
}

// ── Query Helpers ─────────────────────────────────────────────

/**
 * Get all active objectives (not done or failed).
 */
export function getActiveObjectives(cwd?: string): ObjectiveState[] {
  return loadAllObjectives(cwd).filter((o) => o.status !== 'done' && o.status !== 'failed');
}

/**
 * Check if an objective has remaining work.
 */
export function hasActiveChildren(obj: ObjectiveState): boolean {
  return obj.childTaskIds.some(
    (id) =>
      !obj.completedChildIds.includes(id) && !obj.failedChildIds.includes(id) && !obj.cancelledChildIds.includes(id),
  );
}

/**
 * Calculate objective progress as a percentage.
 */
export function getObjectiveProgress(obj: ObjectiveState): number {
  if (obj.childTaskIds.length === 0) return 0;
  const completed = obj.completedChildIds.length;
  const total = obj.childTaskIds.filter((id) => !obj.cancelledChildIds.includes(id)).length;
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

// ── Internal ──────────────────────────────────────────────────

function getObjectiveFilePath(id: string, cwd?: string): string {
  return path.join(getObjectivesDir(cwd), `${id}.json`);
}
