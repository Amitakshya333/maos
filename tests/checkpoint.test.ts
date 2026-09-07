import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint, TaskCheckpoint } from '../src/core/checkpoint';

describe('Checkpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-checkpoint-test-'));
    // Create the .maos directory structure
    fs.mkdirSync(path.join(tmpDir, '.maos'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCheckpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
    return {
      taskId: 'test-task-001',
      agentId: 'agent-a',
      iteration: 5,
      maxIterations: 20,
      progressPct: 0.25,
      totalTokens: 5000,
      filesChanged: ['src/main.ts'],
      lastToolCalls: [{ name: 'write_file', summary: '{"path":"src/main.ts"}' }],
      wasProductive: true,
      idleCount: 0,
      costUSD: 0.005,
      savedAt: Date.now(),
      startedAt: Date.now() - 10000,
      progressSummary: 'Iteration 5/20: 1 files changed',
      retryCount: 0,
      ...overrides,
    };
  }

  it('saves and loads a checkpoint', () => {
    const cp = makeCheckpoint();
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, 'test-task-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe('test-task-001');
    expect(loaded!.agentId).toBe('agent-a');
    expect(loaded!.iteration).toBe(5);
    expect(loaded!.filesChanged).toEqual(['src/main.ts']);
  });

  it('returns null for non-existent checkpoint', () => {
    const loaded = loadCheckpoint(tmpDir, 'non-existent-task');
    expect(loaded).toBeNull();
  });

  it('deletes a checkpoint', () => {
    const cp = makeCheckpoint();
    saveCheckpoint(tmpDir, cp);
    expect(loadCheckpoint(tmpDir, 'test-task-001')).not.toBeNull();
    deleteCheckpoint(tmpDir, 'test-task-001');
    expect(loadCheckpoint(tmpDir, 'test-task-001')).toBeNull();
  });

  it('overwrites existing checkpoint with newer data', () => {
    const cp1 = makeCheckpoint({ iteration: 3, totalTokens: 2000 });
    saveCheckpoint(tmpDir, cp1);

    const cp2 = makeCheckpoint({ iteration: 10, totalTokens: 8000 });
    saveCheckpoint(tmpDir, cp2);

    const loaded = loadCheckpoint(tmpDir, 'test-task-001');
    expect(loaded!.iteration).toBe(10);
    expect(loaded!.totalTokens).toBe(8000);
  });

  it('handles task IDs with special characters', () => {
    const cp = makeCheckpoint({ taskId: 'task/with:special_chars' });
    saveCheckpoint(tmpDir, cp);
    const loaded = loadCheckpoint(tmpDir, 'task/with:special_chars');
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe('task/with:special_chars');
  });
});
