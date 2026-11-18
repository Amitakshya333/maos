import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { IgniteError, runIgnite, resolveWorktreeTestCommand } from '../../src/cli/commands/ignite';
import { AutonomousHealer } from '../../src/core/autonomous-healer';
import { MessageBus } from '../../src/core/message-bus';

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
});
