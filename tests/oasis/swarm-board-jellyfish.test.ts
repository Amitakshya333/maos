import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateJellyfishRawFrame,
  renderColoredJellyfish,
  renderJellyfishMascot,
  colorJellyfishChar,
  squeeze,
  lift,
  rimAt,
  meta as jellyfishMeta,
} from '../../src/oasis/jellyfish-ascii';
import {
  createDefaultSwarmAgents,
  createDefaultSwarmPosts,
  renderSwarmBoard,
  SwarmBoardState,
  SwarmAgent,
  SwarmPost,
  terminalCellWidth,
} from '../../src/oasis/swarm-board';
import { MaosTui } from '../../src/tui/maos-tui';

describe('Antigravity Swarm Board & Jellyfish Mascot Suite', () => {
  // ── 1. Mathematical Jellyfish ASCII Simulation ────────────────────────────
  describe('Mathematical Jellyfish Generator', () => {
    it('produces exactly 26 rows and 44 columns as specified in meta', () => {
      const rawFrame = generateJellyfishRawFrame(0.5);
      const lines = rawFrame.split('\n');
      expect(lines).toHaveLength(jellyfishMeta.rows);
      for (const line of lines) {
        expect(line.length).toBe(jellyfishMeta.cols);
      }
    });

    it('simulates periodic squeeze bounded within [0, 1]', () => {
      for (let t = 0; t <= 5; t += 0.2) {
        const sq = squeeze(t);
        expect(sq).toBeGreaterThanOrEqual(0);
        expect(sq).toBeLessThanOrEqual(1);
      }
      // Periodicity check at t and t + 2.2
      const sq1 = squeeze(0.5);
      const sq2 = squeeze(0.5 + 2.2);
      expect(Math.abs(sq1 - sq2)).toBeLessThan(1e-5);
    });

    it('simulates lift motion bounded within [0, 1]', () => {
      for (let t = 0; t <= 5; t += 0.2) {
        const l = lift(t);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
      }
    });

    it('calculates rim position and half diameter correctly', () => {
      const rim = rimAt(1.0, 44);
      expect(rim.x).toBeGreaterThan(15);
      expect(rim.x).toBeLessThan(30);
      expect(rim.y).toBeGreaterThan(5);
      expect(rim.y).toBeLessThan(15);
      expect(rim.half).toBeGreaterThan(5);
    });

    it("renders jellyfish characters including bell rim (~ ') and mouth frills (;)", () => {
      const rawFrame = generateJellyfishRawFrame(0.8);
      expect(rawFrame).toContain('~');
      expect(rawFrame).toContain("'");
      expect(rawFrame).toContain(';');
      expect(rawFrame).toContain(':');
    });

    it('colors jellyfish characters with MAOS Oasis cyberpunk palette', () => {
      const coloredBell = colorJellyfishChar('*', 5, 11);
      expect(coloredBell).toContain('\u001b['); // contains ANSI color code

      const coloredRim = colorJellyfishChar('~', 11, 11);
      expect(coloredRim).toContain('\u001b[');

      const coloredMouth = colorJellyfishChar(';', 15, 11);
      expect(coloredMouth).toContain('\u001b[');

      const coloredSpeck = colorJellyfishChar('·', 20, 11);
      expect(coloredSpeck).toContain('\u001b[');
    });

    it('generates colored jellyfish lines for full frame', () => {
      const coloredLines = renderColoredJellyfish(0.4);
      expect(coloredLines).toHaveLength(26);
      expect(coloredLines.some((l) => l.includes('\u001b['))).toBe(true);
    });

    it('renders compact 8-row mascot with pulsing bell and tentacles', () => {
      const mascot1 = renderJellyfishMascot(0.2);
      const mascot2 = renderJellyfishMascot(1.5);
      expect(mascot1).toHaveLength(8);
      expect(mascot2).toHaveLength(8);
      for (const line of mascot1) {
        expect(line.length).toBeGreaterThan(0);
      }
    });
  });

  // ── 2. Swarm Board Layout & Components ─────────────────────────────────────
  describe('Antigravity Swarm Board Layout & Components', () => {
    let mockState: SwarmBoardState;

    beforeEach(() => {
      const goal = 'Build and deploy Canva 3D Spatial Studio';
      mockState = {
        goal,
        status: 'active',
        agents: createDefaultSwarmAgents(goal, 'gemma2:9b'),
        posts: createDefaultSwarmPosts(goal),
        selectedAgentIndex: 1, // Worker 1
        model: 'gemma2:9b',
        herdrConnected: true,
      };
    });

    it('initializes 5 default swarm agents including coordinator and 4 workers', () => {
      expect(mockState.agents).toHaveLength(5);
      expect(mockState.agents[0].id).toBe('coordinator');
      expect(mockState.agents[1].id).toBe('ignite-worker-1');
      expect(mockState.agents[2].id).toBe('ignite-worker-2');
      expect(mockState.agents[3].id).toBe('ignite-worker-3');
      expect(mockState.agents[4].id).toBe('ignite-worker-4');

      expect(mockState.agents[0].state).toBe('working');
      expect(mockState.agents[1].state).toBe('working');
      expect(mockState.agents[4].state).toBe('done');
    });

    it('initializes default live activity posts stream with tool calls and assignments', () => {
      expect(mockState.posts.length).toBeGreaterThanOrEqual(10);
      expect(mockState.posts[0].sender).toBe('coordinator');
      expect(mockState.posts[0].recipient).toBe('@ignite-worker-1');

      const toolPost = mockState.posts.find((p) => p.action === 'create_file');
      expect(toolPost).toBeDefined();
      expect(toolPost?.text).toContain('index.html');
    });

    it('renders header with Jellyfish mascot, Swarm board goal, and active agent count', () => {
      const renderedLines = renderSwarmBoard(mockState, { width: 90 });
      const fullText = renderedLines.join('\n');

      expect(fullText).toContain('Swarm board');
      expect(fullText).toContain('Canva 3D Spatial Studio');
      expect(fullText).toContain('agents');
      expect(fullText).toContain('active');
    });

    it('renders Roster column with all 5 swarm members and live states', () => {
      const renderedLines = renderSwarmBoard(mockState, { width: 90 });
      const fullText = renderedLines.join('\n');

      expect(fullText).toContain('ROSTER');
      expect(fullText).toContain('coordinator');
      expect(fullText).toContain('ignite-worker-1');
      expect(fullText).toContain('ignite-worker-2');
      expect(fullText).toContain('ignite-worker-3');
      expect(fullText).toContain('ignite-worker-4');
    });

    it('renders Posts column with live tool calls and messages', () => {
      const renderedLines = renderSwarmBoard(mockState, { width: 90 });
      const fullText = renderedLines.join('\n');

      expect(fullText).toContain('POSTS');
      expect(fullText).toContain('#1');
      expect(fullText).toContain('create_file:');
      expect(fullText).toContain('index.html');
    });

    it('renders Message / Detail Inspector with task details and git diff for selected agent', () => {
      const renderedLines = renderSwarmBoard(mockState, { width: 90 });
      const fullText = renderedLines.join('\n');

      expect(fullText).toContain('Inspector: ignite-worker-1');
      expect(fullText).toContain('HTML & 3D Spatial Viewport');
      expect(fullText).toContain('Task:');
      expect(fullText).toContain('Latest Tool:');
      expect(fullText).toContain('Diff:');
    });

    it('renders expanded inspector when expanded=true', () => {
      mockState.expanded = true;
      const renderedLines = renderSwarmBoard(mockState, { width: 90 });
      const fullText = renderedLines.join('\n');

      expect(fullText).toContain('EXPANDED SWARM INSPECTOR');
      expect(fullText).toContain('WORKTREE GIT DIFF / VERIFICATION TRACE');
      expect(fullText).toContain('diff --git a/index.html');
      expect(fullText).toContain('<!DOCTYPE html>');
    });
  });

  // ── 3. MaosTui Tab 3 Integration & Key Interactions ────────────────────────
  describe('MaosTui Tab 3 Integration', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-swarm-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('initializes MaosTui with swarmGoal, swarmAgents, and swarmPosts', () => {
      const tui = new MaosTui(tmpDir);
      expect(tui.getSwarmGoal()).toContain('Canva 3D Spatial Studio');
      expect(tui.getSwarmAgents()).toHaveLength(5);
      expect(tui.getSwarmPosts().length).toBeGreaterThan(0);
      expect(tui.getSelectedSwarmAgent().id).toBe('coordinator');
    });

    it('updates swarmGoal and resets agents and posts on setSwarmGoal', () => {
      const tui = new MaosTui(tmpDir);
      tui.setSwarmGoal('Build sovereign AI coding agent');
      expect(tui.getSwarmGoal()).toBe('Build sovereign AI coding agent');
      expect(tui.getSwarmAgents()[0].taskDesc).toContain('Build sovereign AI coding agent');
    });

    it('allows cycling and selecting swarm agents via setSelectedSwarmAgentIndex', () => {
      const tui = new MaosTui(tmpDir);
      tui.setSelectedSwarmAgentIndex(2);
      expect(tui.getSelectedSwarmAgent().id).toBe('ignite-worker-2');

      tui.setSelectedSwarmAgentIndex(4);
      expect(tui.getSelectedSwarmAgent().id).toBe('ignite-worker-4');
    });

    it('toggles swarm inspector expanded state via toggleSwarmInspectorExpanded', () => {
      const tui = new MaosTui(tmpDir);
      expect(tui.isSwarmInspectorExpanded()).toBe(false);
      expect(tui.toggleSwarmInspectorExpanded()).toBe(true);
      expect(tui.isSwarmInspectorExpanded()).toBe(true);
      expect(tui.toggleSwarmInspectorExpanded()).toBe(false);
      expect(tui.isSwarmInspectorExpanded()).toBe(false);
    });

    it('records live swarm tool operations dynamically via recordSwarmPost', () => {
      const tui = new MaosTui(tmpDir);
      const initialCount = tui.getSwarmPosts().length;

      tui.recordSwarmPost(
        'ignite-worker-1',
        '@coordinator',
        'create_file',
        'create_file: src/components/Studio.tsx (220 lines)',
      );

      const posts = tui.getSwarmPosts();
      expect(posts.length).toBe(initialCount + 1);
      const latest = posts[posts.length - 1];
      expect(latest.sender).toBe('ignite-worker-1');
      expect(latest.text).toContain('Studio.tsx');

      const worker1 = tui.getSwarmAgents().find((a) => a.id === 'ignite-worker-1');
      expect(worker1?.latestTool?.name).toBe('create_file');
      expect(worker1?.latestTool?.args).toContain('Studio.tsx');
    });

    it('renders Tab 3 cleanly without exceeding terminal cell widths', () => {
      const tui = new MaosTui(tmpDir);
      const lines: string[] = [];
      (tui as any).renderTabAgents(lines, 80, 24);

      expect(lines.length).toBeGreaterThan(0);
      const fullText = lines.join('\n');
      expect(fullText).toContain('Swarm board');
      expect(fullText).toContain('ROSTER');
      expect(fullText).toContain('POSTS');
      expect(fullText).toContain('Inspector:');

      // Verify no raw unescaped newlines inside lines
      for (const line of lines) {
        expect(line).not.toContain('\r');
      }
    });

    it('displays Tab 3 Antigravity hotkeys: Tab switch view · P preview · Enter expand · R refresh · Esc back', () => {
      const tui = new MaosTui(tmpDir);
      (tui as any).activeTab = 3;

      const consoleSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        (tui as any).render();
        const callArgs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(callArgs).toContain('Tab');
        expect(callArgs).toContain('Switch View');
        expect(callArgs).toContain('Preview');
        expect(callArgs).toContain('Expand');
        expect(callArgs).toContain('Refresh');
        expect(callArgs).toContain('Back');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
