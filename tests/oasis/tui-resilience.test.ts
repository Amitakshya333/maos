import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { IgniteError, runIgnite, resolveWorktreeTestCommand } from '../../src/cli/commands/ignite';
import { AutonomousHealer } from '../../src/core/autonomous-healer';
import { MessageBus } from '../../src/core/message-bus';
import { ensureWorktree, removeWorktree } from '../../src/integrations/worktree';

describe('TUI and Ignite Resilience Suite', () => {
  describe('IgniteError and noExit flag', () => {
    it('creates an IgniteError with custom message and exit code', () => {
      const err = new IgniteError('Herdr offline', 2);
      expect(err.name).toBe('IgniteError');
      expect(err.message).toBe('Herdr offline');
      expect(err.code).toBe(2);
      expect(err instanceof Error).toBe(true);
    });

    it('throws IgniteError instead of process.exit when noExit=true and not initialized', async () => {
      const origCwd = process.cwd();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-uninit-'));
      try {
        process.chdir(tmpDir);
        await expect(
          runIgnite({
            goal: 'Build studio',
            noExit: true,
            dryRun: false,
          }),
        ).rejects.toThrow(IgniteError);
      } finally {
        process.chdir(origCwd);
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('throws IgniteError instead of process.exit when exit=false (Commander --no-exit flag)', async () => {
      const origCwd = process.cwd();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-uninit-'));
      try {
        process.chdir(tmpDir);
        await expect(
          runIgnite({
            goal: 'Build studio',
            exit: false,
            dryRun: false,
          }),
        ).rejects.toThrow(IgniteError);
      } finally {
        process.chdir(origCwd);
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe('resolveWorktreeTestCommand', () => {
    it('prefers npx tsc --noEmit when package.json test script is full vitest run', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-cmd-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({
            scripts: { test: 'vitest run' },
          }),
          'utf-8',
        );
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
        const cmd = resolveWorktreeTestCommand(tmpDir);
        expect(cmd).toBe('npx tsc --noEmit');
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('prefers test:unit when declared', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-cmd-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({
            scripts: { 'test:unit': 'vitest run tests/unit' },
          }),
          'utf-8',
        );
        const cmd = resolveWorktreeTestCommand(tmpDir);
        expect(cmd).toBe('npm run test:unit --silent');
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe('AutonomousHealer Sandboxing', () => {
    it('catches sweep and reader errors gracefully without bubbling', async () => {
      const mockReader = {
        listPanes: vi.fn().mockRejectedValue(new Error('Herdr IPC socket broken')),
        readBuffer: vi.fn().mockRejectedValue(new Error('Read timeout')),
      };
      const bus = new MessageBus();
      const healer = new AutonomousHealer({
        projectRoot: process.cwd(),
        reader: mockReader,
        bus,
        pollIntervalMs: 100,
        maxHealsPerPane: 2,
      });

      // healOnce should return empty array and not throw
      const attempts = await healer.healOnce();
      expect(attempts).toEqual([]);
      expect(healer.getStats().failures).toBeGreaterThan(0);
    });

    it('safely handles throwing event bus listener without crashing', async () => {
      const mockReader = {
        listPanes: vi.fn().mockResolvedValue([{ paneId: 'pane-1' }]),
        readBuffer: vi.fn().mockResolvedValue('TypeError: Cannot read properties of undefined'),
      };
      const bus = new MessageBus();
      // Add a broken listener that throws
      bus.on('TASK_PROGRESS', () => {
        throw new Error('Listener catastrophe');
      });

      const healer = new AutonomousHealer({
        projectRoot: process.cwd(),
        paneIds: ['pane-1'],
        reader: mockReader,
        bus,
        pollIntervalMs: 100,
        maxHealsPerPane: 2,
      });

      // Should complete without uncaught exception
      const attempts = await healer.healOnce();
      expect(Array.isArray(attempts)).toBe(true);
    });
  });

  describe('Worktree Junction Resilience', () => {
    it('creates node_modules junction on worktree creation and preserves on reuse', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-wt-'));
      try {
        execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
        execSync('git config user.email "test@maos.internal"', { cwd: tmpDir, stdio: 'ignore' });
        execSync('git config user.name "Test Runner"', { cwd: tmpDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test-repo"}', 'utf-8');
        const rootModules = path.join(tmpDir, 'node_modules');
        fs.mkdirSync(rootModules, { recursive: true });
        fs.writeFileSync(path.join(rootModules, 'test-lib.js'), 'module.exports = 42;', 'utf-8');
        execSync('git add package.json && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

        const wt = ensureWorktree('test-agent', 'test-branch', tmpDir);
        const wtModules = path.join(wt.worktreePath, 'node_modules');
        expect(fs.existsSync(wtModules)).toBe(true);
        expect(fs.existsSync(path.join(wtModules, 'test-lib.js'))).toBe(true);

        // Reusing the worktree should preserve or recreate the junction
        const reused = ensureWorktree('test-agent', 'test-branch', tmpDir);
        expect(reused.worktreePath).toBe(wt.worktreePath);
        expect(fs.existsSync(path.join(reused.worktreePath, 'node_modules', 'test-lib.js'))).toBe(true);

        // Safe removal cleans up the junction and worktree
        removeWorktree('test-agent', tmpDir);
        expect(fs.existsSync(wt.worktreePath)).toBe(false);
        // Root node_modules must remain intact!
        expect(fs.existsSync(rootModules)).toBe(true);
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});
