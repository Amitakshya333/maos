import * as fs from 'fs';
import * as path from 'path';
import { getPendingDir, getActiveDir, getDoneDir } from '../utils/paths';

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
}

/**
 * Generate a unique task ID based on agent + timestamp.
 */
function generateTaskId(agent: string): string {
  const ts = Date.now();
  const slug = agent.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `${slug}__${ts}`;
}

/**
 * Build the markdown content for a task file.
 * Uses YAML frontmatter for structured metadata.
 */
function buildTaskContent(task: Omit<TaskFile, 'filePath' | 'status'>): string {
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
---

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
      return match[1].split(',').map(s => s.trim()).filter(Boolean);
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
  agent?: string;
  branch?: string;
  description: string;
  capabilities?: string[];
  complexity?: 'low' | 'medium' | 'high';
  category?: string;
  dependsOn?: string[];
  cwd?: string;
}): TaskFile {
  const agent = opts.agent || 'AUTO';
  const id = generateTaskId(agent);
  const branch = opts.branch || `maos/${agent.toLowerCase()}/${id}`;
  const now = new Date().toISOString();

  const task = {
    id,
    agent,
    branch,
    description: opts.description,
    capabilities: opts.capabilities || [],
    complexity: opts.complexity || 'medium',
    category: opts.category || 'general',
    dependsOn: opts.dependsOn || [],
    createdAt: now,
  };

  const content = buildTaskContent(task);
  const fileName = `${id}.md`;
  const pendingDir = getPendingDir(opts.cwd);

  if (!fs.existsSync(pendingDir)) {
    fs.mkdirSync(pendingDir, { recursive: true });
  }

  const filePath = path.join(pendingDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');

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

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Get all tasks in the active queue.
 */
export function getActiveTasks(cwd?: string): TaskFile[] {
  const dir = getActiveDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null);
}

/**
 * Get all tasks in the done queue.
 */
export function getDoneTasks(cwd?: string): TaskFile[] {
  const dir = getDoneDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseTaskFile(path.join(dir, f)))
    .filter((t): t is TaskFile => t !== null);
}

/**
 * Move a task file from pending → active.
 */
export function moveToActive(task: TaskFile, cwd?: string): TaskFile {
  const activeDir = getActiveDir(cwd);
  if (!fs.existsSync(activeDir)) fs.mkdirSync(activeDir, { recursive: true });

  const newPath = path.join(activeDir, path.basename(task.filePath));

  // Update status in file content
  const content = fs.readFileSync(task.filePath, 'utf-8');
  const updated = content.replace(/^status:\s*pending$/m, 'status: active');
  fs.writeFileSync(task.filePath, updated, 'utf-8');

  fs.renameSync(task.filePath, newPath);
  return { ...task, status: 'active', filePath: newPath };
}

/**
 * Move a task file from active → done.
 */
export function moveToDone(task: TaskFile, cwd?: string): TaskFile {
  const doneDir = getDoneDir(cwd);
  if (!fs.existsSync(doneDir)) fs.mkdirSync(doneDir, { recursive: true });

  const newPath = path.join(doneDir, path.basename(task.filePath));

  // Update status in file content
  const content = fs.readFileSync(task.filePath, 'utf-8');
  const updated = content.replace(/^status:\s*active$/m, 'status: done');
  fs.writeFileSync(task.filePath, updated, 'utf-8');

  fs.renameSync(task.filePath, newPath);
  return { ...task, status: 'done', filePath: newPath };
}

/**
 * Get counts for all queue states.
 */
export function getQueueCounts(cwd?: string): { pending: number; active: number; done: number } {
  return {
    pending: getPendingTasks(cwd).length,
    active: getActiveTasks(cwd).length,
    done: getDoneTasks(cwd).length,
  };
}
