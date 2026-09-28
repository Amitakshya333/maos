/**
 * MAOS Task Service
 *
 * Wraps task CRUD, queue management, and status queries.
 * Extracted from: cli/task.ts, cli/status.ts, cli/index.ts (clean), core/queue.ts wiring.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createTask as coreCreateTask,
  getPendingTasks,
  getActiveTasks,
  getDoneTasks,
  getQueueCounts,
  moveToActive as coreMoveToActive,
  moveToDone as coreMoveToDone,
  TaskFile,
} from '../core/queue';
import type { Task, QueueCounts, CreateTaskInput, TaskFilter, CleanResult } from '../domain/schemas';

/**
 * Convert a core TaskFile to a domain Task.
 */
function toTask(tf: TaskFile): Task {
  return {
    schemaVersion: 1,
    id: tf.id,
    type: tf.type,
    agent: tf.agent,
    branch: tf.branch,
    description: tf.description,
    capabilities: tf.capabilities,
    complexity: tf.complexity,
    status: tf.status,
    category: tf.category,
    dependsOn: tf.dependsOn,
    objectiveId: tf.objectiveId,
    depth: tf.depth,
    reviewRequired: tf.reviewRequired,
    fixAttempts: tf.fixAttempts,
    parentTaskId: tf.parentTaskId,
    createdAt: tf.createdAt,
    filePath: tf.filePath,
    requirements: tf.requirements,
  };
}

export class TaskService {
  constructor(private readonly projectRoot: string) {}

  /**
   * Create a new task and place it in the pending queue.
   */
  createTask(input: CreateTaskInput): Task {
    const tf = coreCreateTask({
      description: input.description,
      agent: input.agent,
      branch: input.branch,
      capabilities: input.capabilities,
      complexity: input.complexity,
      category: input.category,
      type: input.type,
      objectiveId: input.objectiveId,
      depth: input.depth,
      reviewRequired: input.reviewRequired,
      dependsOn: input.dependsOn,
      requirements: input.requirements,
      cwd: this.projectRoot,
    });
    return toTask(tf);
  }

  /**
   * List tasks with optional filtering.
   */
  listTasks(filter?: TaskFilter): Task[] {
    const cwd = this.projectRoot;
    let tasks: TaskFile[] = [];

    if (!filter?.status || filter.status === 'pending') {
      tasks = tasks.concat(getPendingTasks(cwd));
    }
    if (!filter?.status || filter.status === 'active' || filter.status === 'interrupted') {
      tasks = tasks.concat(getActiveTasks(cwd));
    }
    if (!filter?.status || filter.status === 'done') {
      tasks = tasks.concat(getDoneTasks(cwd));
    }

    let result = tasks.map(toTask);

    if (filter?.type) {
      result = result.filter((t) => t.type === filter.type);
    }
    if (filter?.agentId) {
      result = result.filter((t) => t.agent === filter.agentId);
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }

  /**
   * Get a task by ID.
   */
  getTask(id: string): Task | null {
    const tasks = this.listTasks();
    return tasks.find((t) => t.id === id) || null;
  }

  /**
   * Get queue counts.
   */
  getQueueCounts(): QueueCounts {
    const counts = getQueueCounts(this.projectRoot);
    return {
      pending: counts.pending,
      active: counts.active,
      done: counts.done,
      failed: 0,
      retry: 0,
    };
  }

  /**
   * Move a task to the active queue.
   * Requires the full TaskFile object from core queue.
   */
  moveToActive(task: import('../core/queue').TaskFile): void {
    coreMoveToActive(task, this.projectRoot);
  }

  /**
   * Move a task to the done queue.
   * Requires the full TaskFile object from core queue.
   */
  moveToDone(task: import('../core/queue').TaskFile): void {
    coreMoveToDone(task, this.projectRoot);
  }

  /**
   * Mark all active tasks as interrupted.
   * Prevents phantom success after service interruption or force stop.
   */
  interruptActiveTasks(reason = 'Service force-stopped'): Task[] {
    const activeFiles = getActiveTasks(this.projectRoot);
    const interrupted: Task[] = [];

    for (const tf of activeFiles) {
      try {
        if (!fs.existsSync(tf.filePath)) continue;
        const content = fs.readFileSync(tf.filePath, 'utf-8');
        const updated = content.replace(/^status:\s*\w+$/m, 'status: interrupted')
          + `\n\n## Interruption\n\n${reason} at ${new Date().toISOString()}\n`;
        fs.writeFileSync(tf.filePath, updated, 'utf-8');
        interrupted.push({
          ...toTask(tf),
          status: 'interrupted',
        });
      } catch {}
    }

    return interrupted;
  }

  /**
   * Mark a specific task as interrupted by ID.
   * Prevents phantom success after force-stop.
   */
  interruptTask(taskId: string, reason = 'Force-stopped'): Task | null {
    const activeFiles = getActiveTasks(this.projectRoot);
    const tf = activeFiles.find((f) => f.id === taskId);
    if (!tf) return null;

    try {
      if (!fs.existsSync(tf.filePath)) return null;
      const content = fs.readFileSync(tf.filePath, 'utf-8');
      const updated = content.replace(/^status:\s*\w+$/m, 'status: interrupted')
        + `\n\n## Interruption\n\n${reason} at ${new Date().toISOString()}\n`;
      fs.writeFileSync(tf.filePath, updated, 'utf-8');
      return {
        ...toTask(tf),
        status: 'interrupted',
      };
    } catch {
      return null;
    }
  }

  /**
   * Clean all queue directories, statuses, checkpoints, and logs.
   */
  clean(): CleanResult {
    const maosDir = path.join(this.projectRoot, '.maos');
    if (!fs.existsSync(maosDir)) {
      return { tasksRemoved: 0, statusesReset: false, logsCleared: false };
    }

    // Clear queue directories
    const queueDirs = ['pending', 'active', 'done', 'retry', 'failed'];
    let cleared = 0;
    for (const dir of queueDirs) {
      const dirPath = path.join(maosDir, 'queue', dir);
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          fs.unlinkSync(path.join(dirPath, file));
          cleared++;
        }
      }
    }

    // Clear checkpoints
    const checkpointDir = path.join(maosDir, 'checkpoints');
    if (fs.existsSync(checkpointDir)) {
      for (const file of fs.readdirSync(checkpointDir)) {
        fs.unlinkSync(path.join(checkpointDir, file));
      }
    }

    // Clear status files
    let statusesReset = false;
    const statusDir = path.join(maosDir, 'status');
    if (fs.existsSync(statusDir)) {
      const files = fs.readdirSync(statusDir).filter((f) => f.endsWith('.status'));
      for (const file of files) {
        fs.unlinkSync(path.join(statusDir, file));
      }
      statusesReset = files.length > 0;
    }

    // Clear logs
    let logsCleared = false;
    const logFile = path.join(maosDir, 'logs', 'orchestrator.log');
    if (fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf-8');
      logsCleared = true;
    }

    return { tasksRemoved: cleared, statusesReset, logsCleared };
  }
}
