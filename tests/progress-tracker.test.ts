import { describe, it, expect } from 'vitest';
import { ProgressTracker } from '../src/core/progress-tracker';

describe('ProgressTracker', () => {
  it('marks first read_file as productive (new context)', () => {
    const pt = new ProgressTracker();
    const result = pt.recordIteration([{ name: 'read_file', args: { path: '/foo/bar.ts' } }]);
    expect(result).toBe(true);
    expect(pt.idleCount).toBe(0);
  });

  it('marks repeated read_file on same path as idle (no diversity either)', () => {
    const pt = new ProgressTracker();
    pt.recordIteration([{ name: 'read_file', args: { path: '/foo/bar.ts' } }]);
    // Second read of the same file, same tool
    const result = pt.recordIteration([{ name: 'read_file', args: { path: '/foo/bar.ts' } }]);
    expect(result).toBe(false);
    expect(pt.idleCount).toBe(1);
  });

  it('marks write_file as productive', () => {
    const pt = new ProgressTracker();
    const result = pt.recordIteration([{ name: 'write_file', args: { path: '/out.ts', content: 'hello' } }]);
    expect(result).toBe(true);
  });

  it('marks git_commit as productive', () => {
    const pt = new ProgressTracker();
    const result = pt.recordIteration([{ name: 'git_commit', args: { message: 'fix bug' } }]);
    expect(result).toBe(true);
  });

  it('marks list_dir on new directory as productive', () => {
    const pt = new ProgressTracker();
    const result = pt.recordIteration([{ name: 'list_dir', args: { path: '/src' } }]);
    expect(result).toBe(true);
  });

  it('marks search_code on new query as productive', () => {
    const pt = new ProgressTracker();
    const result = pt.recordIteration([{ name: 'search_code', args: { query: 'import' } }]);
    expect(result).toBe(true);
  });

  it('detects stuck state after MAX_IDLE consecutive idle iterations', () => {
    const pt = new ProgressTracker();
    // First iteration is productive (new context)
    pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    expect(pt.isStuck()).toBe(false);
    // Next 6 iterations are idle (same file, same tool)
    for (let i = 0; i < 6; i++) {
      pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    }
    expect(pt.isStuck()).toBe(true);
  });

  it('resets idle count on productive iteration', () => {
    const pt = new ProgressTracker();
    pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    // Build up idle count
    pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    expect(pt.idleCount).toBe(2);
    // New file read resets it
    pt.recordIteration([{ name: 'read_file', args: { path: '/b.ts' } }]);
    expect(pt.idleCount).toBe(0);
  });

  it('caps repeated identical commands at MAX_COMMAND_REPEATS', () => {
    const pt = new ProgressTracker();
    // First 3 runs of same command are productive
    for (let i = 0; i < 3; i++) {
      const result = pt.recordIteration([{ name: 'run_command', args: { command: 'npm test' } }]);
      expect(result).toBe(true);
    }
    // 4th run of exact same command is no longer treated as productive
    // (but tool diversity might still trigger since it's a new iteration — use same tool to avoid)
    pt.recordIteration([{ name: 'run_command', args: { command: 'npm test' } }]);
    // idle should increment since command is capped and no diversity
    expect(pt.idleCount).toBe(1);
  });

  it('deduplicates write_file by path+content signature', () => {
    const pt = new ProgressTracker();
    pt.recordIteration([{ name: 'write_file', args: { path: '/x.ts', content: 'const a = 1;' } }]);
    expect(pt.idleCount).toBe(0);
    // Same write is idle
    const result = pt.recordIteration([{ name: 'write_file', args: { path: '/x.ts', content: 'const a = 1;' } }]);
    expect(result).toBe(false);
  });

  it('statusLine returns readable summary', () => {
    const pt = new ProgressTracker();
    pt.recordIteration([{ name: 'read_file', args: { path: '/a.ts' } }]);
    const status = pt.statusLine();
    expect(status).toContain('files_seen=1');
    expect(status).toContain('idle=0/6');
  });
});
