import * as fs from 'fs';
import * as path from 'path';
import { getPendingDir, getActiveDir, getDoneDir } from '../utils/paths';

// ─── Task Types ───────────────────────────────────────────────
// task       = standalone task (backward compat, default)
// objective  = high-level goal that gets decomposed by ARCHITECT
// subtask    = child task created by ARCHITECT for an objective
// review     = code review task for a completed subtask
export type TaskType = 'task' | 'objective' | 'subtask' | 'review';

export interface TaskFile {
  id: string;
  agent: string;
  branch: string;
  description: string;
  capabilities: string[];
  complexity: 'low' | 'medium' | 'high';
  category: string;
  dependsOn: string[];
  status: 'pending' | 'active' | 'done' | 'failed';
  createdAt: string;
  filePath: string;

  // ── v0.3 Multi-Agent Fields (all optional, backward-compatible) ──

  /** Task type: objective, subtask, review, or plain task */
  type: TaskType;
  /** Parent objective ID (set on subtasks and review tasks) */
  objectiveId: string;
  /** Decomposition depth (0 = root objective, 1 = subtask, prevents recursion) */
  depth: number;
  /** Whether this task should trigger a REVIEWER after completion */
  reviewRequired: boolean;
  /** How many review-fix cycles this task has been through */
  fixAttempts: number;
  /** For review tasks: the ID of the task being reviewed */
  parentTaskId: string;
}

/**
 * Generate a unique task ID based on agent + timestamp.
 */
function generateTaskId(agent: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  const slug = agent.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `${slug}__${ts}_${rand}`;
}

/**
 * Build the markdown content for a task file.
 * Uses YAML frontmatter for structured metadata.
 */
function buildTaskContent(task: Omit<TaskFile, 'filePath' | 'status'>): string {
  // Build optional v0.3 frontmatter lines (only include when non-default)
  const v03Lines: string[] = [];
  if (task.type && task.type !== 'task') v03Lines.push(`type: ${task.type}`);
  if (task.objectiveId) v03Lines.push(`objective_id: ${task.objectiveId}`);
  if (task.depth > 0) v03Lines.push(`depth: ${task.depth}`);
  if (task.reviewRequired) v03Lines.push(`review_required: true`);
  if (task.fixAttempts > 0) v03Lines.push(`fix_attempts: ${task.fixAttempts}`);
  if (task.parentTaskId) v03Lines.push(`parent_task_id: ${task.parentTaskId}`);
  const v03Block = v03Lines.length > 0 ? v03Lines.join('\n') + '\n' : '';

  return `---
id: ${task.id}
agent: ${task.agent}
branch: ${task.branch}
status: pending
capabilities: [${task.capabilities.join(', ')}]
complexity: ${task.complexity}
category: ${task.category}
depends_on: [${task.dependsOn.join(', ')}]
created_at: ${task.createdAt}
${v03Block}---

# Task: ${task.id}

## Description

${task.description}

## Instructions

1. Read existing code in your scope before writing new code.
2. Follow the project's existing patterns and conventions.
3. Write clean, production-quality code.
4. When done, commit your changes with a descriptive message.
5. Do NOT merge to main. Leave your work on your branch: \`${task.branch}\`.
`;
}

/**
 * Parse a task file from its markdown content.
 */
function parseTaskFile(filePath: string): TaskFile | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];
    const get = (key: string): string => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return match ? match[1].trim() : '';
    };

    const getArray = (key: string): string[] => {
      const raw = get(key);
      const match = raw.match(/\[([^\]]*)\]/);
      if (!match || !match[1].trim()) return [];
      return match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    };

    return {
      id: get('id'),
      agent: get('agent'),
      branch: get('branch'),
      description: content.split('## Description')[1]?.split('## Instructions')[0]?.trim() || '',
      capabilities: getArray('capabilities'),
      complexity: (get('complexity') as TaskFile['complexity']) || 'medium',
      category: get('category') || 'general',
      dependsOn: getArray('depends_on'),
      status: (get('status') as TaskFile['status']) || 'pending',
      createdAt: get('created_at'),
      filePath,
      // v0.3 fields — backward-compatible defaults
      type: (get('type') as TaskType) || 'task',
      objectiveId: get('objective_id') || '',
      depth: parseInt(get('depth') || '0', 10) || 0,
      reviewRequired: get('review_required') === 'true',
      fixAttempts: parseInt(get('fix_attempts') || '0', 10) || 0,
      parentTaskId: get('parent_task_id') || '',
    };
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Create a new task and write it to the pending queue.
 */
export function createTask(opts: {
  id?: string;
  agent?: string;
  branch?: string;
  description: string;
  capabilities?: string[];
  complexity?: 'low' | 'medium' | 'high';
  category?: string;
  dependsOn?: string[];
  cwd?: string;
  // v0.3 multi-agent fields
  type?: TaskType;
  objectiveId?: string;
  depth?: number;
  reviewRequired?: boolean;
  fixAttempts?: number;
  parentTaskId?: string;
}): TaskFile {
  const agent = opts.agent || 'AUTO';
  const taskType = opts.type || 'task';
  // Generate ID with type-aware prefix unless caller provides one.
  const generatedPrefix =
    taskType === 'objective'
      ? 'OBJ'
      : taskType === 'subtask'
        ? 'SUB'
        : taskType === 'review'
          ? 'REV'
          : agent.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const id = opts.id || generateTaskId(generatedPrefix);

  // For subtasks of the same objective, share a feature branch
  const branch =
    opts.branch || (opts.objectiveId ? `maos/objective/${opts.objectiveId}` : `maos/${agent.toLowerCase()}/${id}`);
  const now = new Date().toISOString();

  const task: Omit<TaskFile, 'filePath' | 'status'> = {
    id,
    agent,
    branch,
    description: opts.description,
    capabilities: opts.capabilities || [],
    complexity: opts.complexity || 'medium',
    category: opts.category || 'general',
    dependsOn: opts.dependsOn || [],
    createdAt: now,
    type: taskType,
    objectiveId: opts.objectiveId || '',
    depth: opts.depth ?? 0,
    reviewRequired: opts.reviewRequired ?? false,
    fixAttempts: opts.fixAttempts ?? 0,
    parentTaskId: opts.parentTaskId || '',
  };

  const content = buildTaskContent(task);
  const fileName = `${id}.md`;
  const pendingDir = getPendingDir(opts.cwd);

  if (!fs.existsSync(pendingDir)) {
    fs.mkdirSync(pendingDir, { recursive: true });
  }

  const filePath = path.join(pendingDir, fileName);
  const tempPath = path.join(
    pendingDir,
    `.${fileName}.${Date.now()}_${Math.random().toString(36).substring(2, 6)}.tmp`,
  );
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);

  return {
    ...task,
    status: 'pending',
    filePath,
  };
}

/**
 * Get all tasks in the pending queue.
 */
export function getPendingTasks(cwd?: string): TaskFile[] {
  const dir = getPendingDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Get all tasks in the active queue.
 */
export function getActiveTasks(cwd?: string): TaskFile[] {
  const dir = getActiveDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null);
}

/**
 * Get all tasks in the done queue.
 */
export function getDoneTasks(cwd?: string): TaskFile[] {
  const dir = getDoneDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null);
}

/**
 * Move a task file from pending → active atomically.
 */
export function moveToActive(task: TaskFile, cwd?: string): TaskFile {
  const activeDir = getActiveDir(cwd);
  if (!fs.existsSync(activeDir)) fs.mkdirSync(activeDir, { recursive: true });

  // ── RACE PROTECTION ──
  // Use an exclusive lock file to prevent two poll ticks from claiming the same task.
  // fs.openSync with O_CREAT | O_EXCL atomically fails if the lock already exists.
  const lockPath = task.filePath + '.lock';
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.closeSync(fd);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new Error(`Task ${task.id} already claimed by another dispatch`);
    }
    throw err;
  }

  try {
    const finalPath = path.join(activeDir, path.basename(task.filePath));
    const tempPath = path.join(
      activeDir,
      `.${path.basename(task.filePath)}.${Date.now()}_${Math.random().toString(36).substring(2, 6)}.tmp`,
    );

    // Update status in file content
    const content = fs.readFileSync(task.filePath, 'utf-8');
    const updated = content.replace(/^status:\s*pending$/m, 'status: active');

    // Write to temporary file in the target directory first
    fs.writeFileSync(tempPath, updated, 'utf-8');
    // Atomic rename within target directory
    fs.renameSync(tempPath, finalPath);

    // Clean up source file
    if (fs.existsSync(task.filePath) && task.filePath !== finalPath) {
      try {
        fs.unlinkSync(task.filePath);
      } catch {}
    }

    return { ...task, status: 'active', filePath: finalPath };
  } finally {
    // Always clean up the lock file
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

/**
 * Move a task file from active → done atomically.
 */
export function moveToDone(task: TaskFile, cwd?: string): TaskFile {
  const doneDir = getDoneDir(cwd);
  if (!fs.existsSync(doneDir)) fs.mkdirSync(doneDir, { recursive: true });

  const finalPath = path.join(doneDir, path.basename(task.filePath));
  const tempPath = path.join(
    doneDir,
    `.${path.basename(task.filePath)}.${Date.now()}_${Math.random().toString(36).substring(2, 6)}.tmp`,
  );

  // Update status in file content
  const content = fs.readFileSync(task.filePath, 'utf-8');
  const updated = content.replace(/^status:\s*active$/m, 'status: done');

  // Write to temporary file in the target directory first
  fs.writeFileSync(tempPath, updated, 'utf-8');
  // Atomic rename within target directory
  fs.renameSync(tempPath, finalPath);

  // Clean up source file
  if (fs.existsSync(task.filePath) && task.filePath !== finalPath) {
    try {
      fs.unlinkSync(task.filePath);
    } catch {}
  }

  return { ...task, status: 'done', filePath: finalPath };
}

/**
 * Get counts for all queue states.
 * Uses fast filename-only counting (no file parsing).
 */
export function getQueueCounts(cwd?: string): { pending: number; active: number; done: number } {
  return {
    pending: countTaskFiles(getPendingDir(cwd)),
    active: countTaskFiles(getActiveDir(cwd)),
    done: countTaskFiles(getDoneDir(cwd)),
  };
}

/**
 * Fast count of task files in a directory without parsing contents.
 */
function countTaskFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}
