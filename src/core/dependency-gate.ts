/**
 * MAOS Dependency Gate
 *
 * Controls task dispatch order based on `dependsOn` relationships.
 * Tasks are only dispatchable when ALL their dependencies are in done/.
 *
 * Also provides cycle detection using Kahn's algorithm to prevent
 * deadlocks where A depends on B and B depends on A.
 *
 * Used by the orchestrator's poll() to filter pending tasks before routing.
 */

import { TaskFile, getDoneTasks } from './queue';

// ── Public API ────────────────────────────────────────────────

/**
 * Filter pending tasks to only those whose dependencies are satisfied.
 * A task with no dependsOn is always dispatchable.
 * A task whose ALL dependsOn IDs exist in done/ is dispatchable.
 *
 * Note: `doneTaskIds` is computed once per poll tick and passed in
 * to avoid repeated filesystem reads.
 */
export function getDispatchableTasks(pending: TaskFile[], doneTaskIds: Set<string>): TaskFile[] {
  return pending.filter((task) => {
    if (task.dependsOn.length === 0) return true;
    return task.dependsOn.every((depId) => doneTaskIds.has(depId));
  });
}

/**
 * Build the set of done task IDs for dependency checking.
 * Called once per poll tick, result shared across all task checks.
 */
export function buildDoneIdSet(cwd?: string): Set<string> {
  return new Set(getDoneTasks(cwd).map((t) => t.id));
}

// ── Cycle Detection ───────────────────────────────────────────

/**
 * Detect dependency cycles using Kahn's algorithm (topological sort).
 *
 * Returns an array of cycle chains. Empty array = no cycles.
 * Each chain is the list of task IDs forming a cycle.
 *
 * This should be called:
 *   1. When ARCHITECT creates a plan (before inserting subtasks)
 *   2. As a safety check in the orchestrator on startup
 *
 * Input is an array of { id, dependsOn } — does not need to be TaskFile.
 */
export function detectCycles(tasks: Array<{ id: string; dependsOn: string[] }>): string[][] {
  // Build adjacency and in-degree maps
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const taskIds = new Set<string>();

  for (const task of tasks) {
    taskIds.add(task.id);
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0);
    if (!adjacency.has(task.id)) adjacency.set(task.id, []);

    for (const dep of task.dependsOn) {
      // Only count dependencies that are within this task set
      if (!taskIds.has(dep)) {
        // Dependency is external (already done) — skip
        // We'll add it after the initial pass
      }
    }
  }

  // Second pass: now that we know all task IDs, wire up edges
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (taskIds.has(dep)) {
        // dep → task (dep must finish before task can start)
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
      }
      // External deps are ignored for cycle detection
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // If sorted doesn't contain all nodes, there are cycles
  if (sorted.length === taskIds.size) return []; // No cycles

  // Find the nodes involved in cycles
  const cyclicNodes = [...taskIds].filter((id) => !sorted.includes(id));

  // Return them as a single cycle chain (simplified — exact cycle
  // extraction is complex and unnecessary for our error reporting)
  return [cyclicNodes];
}

/**
 * Get tasks in topological order (dependencies first).
 * Useful for display in `maos plan` and `maos replay`.
 * Returns null if cycles are detected.
 */
export function topologicalSort(tasks: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const cycles = detectCycles(tasks);
  if (cycles.length > 0) return null;

  // Simple stable topological sort
  const done = new Set<string>();
  const result: string[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  function visit(id: string): void {
    if (done.has(id)) return;
    const task = taskMap.get(id);
    if (!task) return;
    for (const dep of task.dependsOn) {
      if (taskMap.has(dep)) visit(dep);
    }
    done.add(id);
    result.push(id);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}
