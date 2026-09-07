import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createTask,
  getPendingTasks,
  getActiveTasks,
  getDoneTasks,
  moveToActive,
  moveToDone,
  getQueueCounts,
} from '../src/core/queue';

describe('Queue Module', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-queue-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create a task in the pending directory atomically', () => {
    const task = createTask({
      agent: 'CODER',
      description: 'Write unit tests for queue module',
      capabilities: ['typescript', 'testing'],
      complexity: 'low',
      category: 'testing',
      cwd: testDir,
    });

    expect(task.id).toBeDefined();
    expect(task.id).toContain('CODER__');
    expect(task.status).toBe('pending');
    expect(fs.existsSync(task.filePath)).toBe(true);

    const pending = getPendingTasks(testDir);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(task.id);
    expect(pending[0].description).toBe('Write unit tests for queue module');
    expect(pending[0].capabilities).toEqual(['typescript', 'testing']);
  });

  it('should generate unique task IDs even in rapid succession', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const task = createTask({
        agent: 'CODER',
        description: `Task ${i}`,
        cwd: testDir,
      });
      ids.add(task.id);
    }
    expect(ids.size).toBe(20);
  });

  it('should move task from pending to active atomically', () => {
    const task = createTask({
      agent: 'ARCHITECT',
      description: 'Design architecture',
      cwd: testDir,
    });

    const activeTask = moveToActive(task, testDir);

    expect(activeTask.status).toBe('active');
    expect(fs.existsSync(activeTask.filePath)).toBe(true);
    expect(activeTask.filePath).toContain('active');

    // Should no longer be in pending
    const pending = getPendingTasks(testDir);
    expect(pending.length).toBe(0);

    // Should be in active
    const active = getActiveTasks(testDir);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(task.id);
    expect(active[0].status).toBe('active');
  });

  it('should move task from active to done atomically', () => {
    const task = createTask({
      agent: 'TESTER',
      description: 'Run integration suite',
      cwd: testDir,
    });

    const activeTask = moveToActive(task, testDir);
    const doneTask = moveToDone(activeTask, testDir);

    expect(doneTask.status).toBe('done');
    expect(fs.existsSync(doneTask.filePath)).toBe(true);
    expect(doneTask.filePath).toContain('done');

    // Counts
    const counts = getQueueCounts(testDir);
    expect(counts.pending).toBe(0);
    expect(counts.active).toBe(0);
    expect(counts.done).toBe(1);

    const doneList = getDoneTasks(testDir);
    expect(doneList.length).toBe(1);
    expect(doneList[0].id).toBe(task.id);
    expect(doneList[0].status).toBe('done');
  });
});
