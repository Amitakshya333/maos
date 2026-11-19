import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { IgniteError, runIgnite, resolveWorktreeTestCommand } from '../../src/cli/commands/ignite';
import { AutonomousHealer } from '../../src/core/autonomous-healer';
import { MessageBus } from '../../src/core/message-bus';
import { ensureWorktree, removeWorktree } from '../../src/integrations/worktree';
import { classifyUserInput, MaosTui } from '../../src/tui/maos-tui';

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

  describe('UserInputClassifier (Smart Intent Routing)', () => {
    it('classifies greetings and casual inputs as chat', () => {
      expect(classifyUserInput('hi')).toBe('chat');
      expect(classifyUserInput('HI')).toBe('chat');
      expect(classifyUserInput('hello')).toBe('chat');
      expect(classifyUserInput('hey there')).toBe('chat');
      expect(classifyUserInput('howdy')).toBe('chat');
      expect(classifyUserInput('good morning')).toBe('chat');
      expect(classifyUserInput('ping')).toBe('chat');
      expect(classifyUserInput('test')).toBe('chat');
      expect(classifyUserInput('')).toBe('chat');
      expect(classifyUserInput('   ')).toBe('chat');
    });

    it('classifies conversational inquiries as chat', () => {
      expect(classifyUserInput('who are you?')).toBe('chat');
      expect(classifyUserInput('what is maos?')).toBe('chat');
      expect(classifyUserInput('how does oasis work?')).toBe('chat');
      expect(classifyUserInput('can you explain how herdr works?')).toBe('chat');
      expect(classifyUserInput('could you explain how herdr works')).toBe('chat');
      expect(classifyUserInput('Can you tell me about the architecture')).toBe('chat');
      expect(classifyUserInput('can you help me understand how this works')).toBe('chat');
      expect(classifyUserInput('tell me how to use the tui')).toBe('chat');
      expect(classifyUserInput('tell me about gemma')).toBe('chat');
      expect(classifyUserInput('why loopback only?')).toBe('chat');
      expect(classifyUserInput('how are you today?')).toBe('chat');
    });

    it('classifies explicit chat prefixes as chat', () => {
      expect(classifyUserInput('chat: explain rust engine bridge')).toBe('chat');
      expect(classifyUserInput('ask: how does the autonomous healer work')).toBe('chat');
      expect(classifyUserInput('question: what port does ollama use')).toBe('chat');
    });

    it('classifies actionable engineering tasks as swarm_task', () => {
      expect(classifyUserInput('build and deploy canva 3d spatial studio')).toBe('swarm_task');
      expect(classifyUserInput('fix failing vitest unit tests in oasis')).toBe('swarm_task');
      expect(classifyUserInput('create a new rest api endpoint for tasks')).toBe('swarm_task');
      expect(classifyUserInput('refactor the database connector for connection pooling')).toBe('swarm_task');
      expect(classifyUserInput('implement raycasting ground plane collision')).toBe('swarm_task');
      expect(classifyUserInput('deploy worker service to production')).toBe('swarm_task');
      expect(classifyUserInput('scaffold react frontend with vite')).toBe('swarm_task');
      expect(classifyUserInput('optimize buffer geometry allocations')).toBe('swarm_task');
      expect(classifyUserInput('write a script to clean up temp files')).toBe('swarm_task');
    });

    it('classifies tasks with greetings or polite phrases as swarm_task', () => {
      expect(classifyUserInput('hi, build me a website')).toBe('swarm_task');
      expect(classifyUserInput('hey can you write a python script to parse logs')).toBe('swarm_task');
      expect(classifyUserInput('hello please implement auth')).toBe('swarm_task');
      expect(classifyUserInput('can you build a website')).toBe('swarm_task');
      expect(classifyUserInput('please create a new component')).toBe('swarm_task');
    });

    it('classifies explicit task prefixes as swarm_task', () => {
      expect(classifyUserInput('task: benchmark gemma throughput')).toBe('swarm_task');
      expect(classifyUserInput('goal: build canvas editor')).toBe('swarm_task');
      expect(classifyUserInput('ignite: test multi-pane clustering')).toBe('swarm_task');
      expect(classifyUserInput('swarm: run integration tests')).toBe('swarm_task');
    });
  });

  describe('MaosTui State Machine and Tab Navigation', () => {
    it('initializes with modalMode none and activeTab 1 (Dashboard)', () => {
      const tui = new MaosTui(process.cwd());
      expect(tui.getModalMode()).toBe('none');
      expect(tui.getActiveTab()).toBe(1);
    });

    it('transitions modalMode safely between none, ignite, and promptTest', () => {
      const tui = new MaosTui(process.cwd());
      expect(tui.getModalMode()).toBe('none');
      tui.setModalMode('ignite');
      expect(tui.getModalMode()).toBe('ignite');
      tui.setModalMode('none');
      expect(tui.getModalMode()).toBe('none');
      tui.setModalMode('promptTest');
      expect(tui.getModalMode()).toBe('promptTest');
      tui.setModalMode('none');
      expect(tui.getModalMode()).toBe('none');
    });

    it('cycles forward through all tabs in sequence: 1 -> 2 -> 3 -> 4 -> 5 -> 0 -> 1', () => {
      const tui = new MaosTui(process.cwd());
      expect(tui.getNextTab(1)).toBe(2); // Dashboard -> Chat
      expect(tui.getNextTab(2)).toBe(3); // Chat -> Agents
      expect(tui.getNextTab(3)).toBe(4); // Agents -> Telemetry
      expect(tui.getNextTab(4)).toBe(5); // Telemetry -> Event Log
      expect(tui.getNextTab(5)).toBe(0); // Event Log -> Settings
      expect(tui.getNextTab(0)).toBe(1); // Settings -> Dashboard
    });

    it('cycles backward through all tabs in sequence: 1 <- 2 <- 3 <- 4 <- 5 <- 0 <- 1', () => {
      const tui = new MaosTui(process.cwd());
      expect(tui.getPrevTab(1)).toBe(0); // Dashboard <- Settings
      expect(tui.getPrevTab(0)).toBe(5); // Settings <- Event Log
      expect(tui.getPrevTab(5)).toBe(4); // Event Log <- Telemetry
      expect(tui.getPrevTab(4)).toBe(3); // Telemetry <- Agents
      expect(tui.getPrevTab(3)).toBe(2); // Agents <- Chat
      expect(tui.getPrevTab(2)).toBe(1); // Chat <- Dashboard
    });

    it('allows setting and reading active tab directly', () => {
      const tui = new MaosTui(process.cwd());
      tui.setActiveTab(2);
      expect(tui.getActiveTab()).toBe(2);
      tui.setActiveTab(0);
      expect(tui.getActiveTab()).toBe(0);
      tui.setActiveTab(5);
      expect(tui.getActiveTab()).toBe(5);
    });

    it('renders clean categorized Settings panel without clumsy bracket noise', () => {
      const tui = new MaosTui(process.cwd());
      const lines: string[] = [];
      (tui as any).renderTabSettings(lines, 90, 30);
      const output = lines.join('\n');

      expect(output).toContain('SETTINGS & WORKSPACE CONFIGURATION');
      expect(output).toContain('MODEL & LOCAL INFERENCE');
      expect(output).toContain('MULTI-AGENT ORCHESTRATION');
      expect(output).toContain('SOVEREIGNTY & OPSEC POLICY');
      expect(output).toContain('Primary Model');
      expect(output).toContain('Herdr Multi-Pane');
      expect(output).toContain('Network Boundary');

      // Verify no clumsy debug bracket dumps like [ACTIVE], [OPTIMAL], [BLOCKED]
      expect(output).not.toContain('[ACTIVE]');
      expect(output).not.toContain('[OPTIMAL]');
      expect(output).not.toContain('[BLOCKED]');
      expect(output).not.toContain('[CONFIG]');

      // Verify sleek dot status indicators
      expect(output).toContain('● ACTIVE');
      expect(output).toContain('✓ STRICT');
      expect(output).toContain('✓ BLOCKED');
    });

    it('renders Chat view with streamlined status header and message history', () => {
      const tui = new MaosTui(process.cwd());
      const lines: string[] = [];
      (tui as any).renderTabChat(lines, 90, 24);
      const output = lines.join('\n');

      expect(output).toContain('CHAT');
      expect(output).toContain('ACTIVE MODEL');
      expect(output).toContain('LOCAL INFERENCE');
      expect(output).toContain('0 KB EGRESS');
      expect(output).toContain('Ask Gemma anything');
    });

    it('dynamically adapts welcome box on narrow terminal width without distortion', () => {
      const tui = new MaosTui(process.cwd());
      const lines: string[] = [];
      (tui as any).renderTabChat(lines, 50, 20);
      const output = lines.join('\n');

      expect(output).toContain('CHAT');
      expect(output).toContain('Welcome to MAOS Sovereign Local Chat!');
      // Verify all lines fit within width 50 without wrapping
      for (const line of lines) {
        // Strip ANSI escape codes to check visual cell width
        const raw = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
        expect(raw.length).toBeLessThanOrEqual(50);
      }
    });

    it('appends exactly one assistant response without duplication on sendGemmaChatMessage', async () => {
      const tui = new MaosTui(process.cwd());
      expect(tui.getChatMessages()).toHaveLength(0);

      await (tui as any).sendGemmaChatMessage('Hello Gemma');

      const messages = tui.getChatMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].sender).toBe('user');
      expect(messages[0].text).toBe('Hello Gemma');
      expect(messages[1].sender).toBe('gemma');
      expect(messages[1].text.length).toBeGreaterThan(0);
    });
  });
});
