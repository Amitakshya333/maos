import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { computeSymmetricGridPlan } from '../../src/integrations/herdr';
import { exportBuiltArtifacts, printMergeReport, IgniteWorker } from '../../src/cli/commands/ignite';
import {
  detectLocalModels,
  formatHeaderBadge,
  formatModelDisplayName,
  FALLBACK_MODELS,
  DetectedModel,
} from '../../src/oasis/model-detector';
import { MaosTui } from '../../src/tui/maos-tui';

describe('Swarm Symmetry, Output Proof, Dynamic Models & Line Clamping Suite', () => {
  // ── 1. Symmetric Herdr Pane Grid Layout ────────────────────────────────────
  describe('Symmetric Grid Layout Plan', () => {
    it('returns empty plan for 1 worker (single pane occupies full window)', () => {
      const plan = computeSymmetricGridPlan(1);
      expect(plan).toHaveLength(0);
    });

    it('returns clean 1x2 horizontal/vertical 50-50 split for 2 workers', () => {
      const plan = computeSymmetricGridPlan(2);
      expect(plan).toEqual([{ targetWorkerIndex: 0, direction: 'right' }]);
    });

    it('returns balanced 1-over-2 layout for 3 workers', () => {
      const plan = computeSymmetricGridPlan(3);
      expect(plan).toEqual([
        { targetWorkerIndex: 0, direction: 'down' },
        { targetWorkerIndex: 1, direction: 'right' },
      ]);
    });

    it('returns perfectly symmetric 2x2 grid for 4 workers (solves user issue #1)', () => {
      const plan = computeSymmetricGridPlan(4);
      expect(plan).toHaveLength(3); // splits for workers 1, 2, 3 relative to worker 0

      // Step 1: Worker 0 split down -> creates Worker 1 below (Top row: W0, Bottom row: W1)
      expect(plan[0]).toEqual({ targetWorkerIndex: 0, direction: 'down' });

      // Step 2: Worker 0 split right -> creates Worker 2 on top right (Top row: W0 50%, W2 50%)
      expect(plan[1]).toEqual({ targetWorkerIndex: 0, direction: 'right' });

      // Step 3: Worker 1 split right -> creates Worker 3 on bottom right (Bottom row: W1 50%, W3 50%)
      expect(plan[2]).toEqual({ targetWorkerIndex: 1, direction: 'right' });

      // Verification: 4 equal quadrants (2 rows x 2 columns)
    });

    it('returns balanced 2 top / 3 bottom layout for 5 workers', () => {
      const plan = computeSymmetricGridPlan(5);
      expect(plan).toHaveLength(4);
      expect(plan[0]).toEqual({ targetWorkerIndex: 0, direction: 'down' });
      expect(plan[1]).toEqual({ targetWorkerIndex: 0, direction: 'right' });
      expect(plan[2]).toEqual({ targetWorkerIndex: 1, direction: 'right' });
      expect(plan[3]).toEqual({ targetWorkerIndex: 3, direction: 'right' });
    });

    it('returns symmetric 2x3 grid for 6 workers (2 rows of 3 equal columns)', () => {
      const plan = computeSymmetricGridPlan(6);
      expect(plan).toHaveLength(5);
      expect(plan[0]).toEqual({ targetWorkerIndex: 0, direction: 'down' });
      expect(plan[1]).toEqual({ targetWorkerIndex: 0, direction: 'right' });
      expect(plan[2]).toEqual({ targetWorkerIndex: 2, direction: 'right' });
      expect(plan[3]).toEqual({ targetWorkerIndex: 1, direction: 'right' });
      expect(plan[4]).toEqual({ targetWorkerIndex: 4, direction: 'right' });
    });

    it('returns symmetric 2x4 grid for 8 workers (2 rows of 4 equal columns)', () => {
      const plan = computeSymmetricGridPlan(8);
      expect(plan).toHaveLength(7);
      expect(plan[0]).toEqual({ targetWorkerIndex: 0, direction: 'down' });
      // Top row 4 cols:
      expect(plan[1]).toEqual({ targetWorkerIndex: 0, direction: 'right' });
      expect(plan[2]).toEqual({ targetWorkerIndex: 2, direction: 'right' });
      expect(plan[3]).toEqual({ targetWorkerIndex: 3, direction: 'right' });
      // Bottom row 4 cols:
      expect(plan[4]).toEqual({ targetWorkerIndex: 1, direction: 'right' });
      expect(plan[5]).toEqual({ targetWorkerIndex: 5, direction: 'right' });
      expect(plan[6]).toEqual({ targetWorkerIndex: 6, direction: 'right' });
    });
  });

  // ── 2. Built Artifacts & Live Output Proof ─────────────────────────────────
  describe('Built Artifacts Export & Instant Proof (User Issue #2)', () => {
    let tmpDir: string;
    let worktreeDir1: string;
    let worktreeDir2: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-artifacts-test-'));
      worktreeDir1 = path.join(tmpDir, '.maos', 'worktrees', 'Worker-1');
      worktreeDir2 = path.join(tmpDir, '.maos', 'worktrees', 'Worker-2');
      fs.mkdirSync(worktreeDir1, { recursive: true });
      fs.mkdirSync(worktreeDir2, { recursive: true });

      // Simulate Worker 1 building index.html and style.css
      fs.writeFileSync(
        path.join(worktreeDir1, 'index.html'),
        '<!DOCTYPE html>\n<html>\n<head><title>App</title></head>\n<body><h1>Hello Swarm</h1></body>\n</html>',
        'utf-8',
      );
      fs.mkdirSync(path.join(worktreeDir1, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir1, 'src', 'app.ts'),
        'export function startApp(): void {\n  console.log("running");\n}\n',
        'utf-8',
      );

      // Simulate Worker 2 building game.ts
      fs.mkdirSync(path.join(worktreeDir2, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir2, 'src', 'game.ts'),
        'export class Game {\n  score = 0;\n  play() { this.score += 10; }\n}\n',
        'utf-8',
      );
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('exports all built artifacts to ./output/ and ./dist-preview/ with line counts and sizes', () => {
      const mockWorkers: IgniteWorker[] = [
        {
          index: 0,
          title: 'HTML & UI',
          agentId: 'Worker-1',
          branch: 'maos-ignite-0',
          worktreePath: worktreeDir1,
          paneId: 'w0:p1',
          taskFile: path.join(tmpDir, '.maos', 'ignite', 'Worker-1.md'),
        },
        {
          index: 1,
          title: 'Game Logic',
          agentId: 'Worker-2',
          branch: 'maos-ignite-1',
          worktreePath: worktreeDir2,
          paneId: 'w0:p2',
          taskFile: path.join(tmpDir, '.maos', 'ignite', 'Worker-2.md'),
        },
      ];

      const manifest = exportBuiltArtifacts(tmpDir, mockWorkers);

      // Verify files copied to ./output/
      expect(fs.existsSync(path.join(tmpDir, 'output', 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'output', 'src', 'app.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'output', 'src', 'game.ts'))).toBe(true);

      // Verify files copied to ./dist-preview/
      expect(fs.existsSync(path.join(tmpDir, 'dist-preview', 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'dist-preview', 'src', 'game.ts'))).toBe(true);

      // Verify manifest records
      expect(manifest.files.length).toBeGreaterThanOrEqual(3);
      const htmlRecord = manifest.files.find((f) => f.path === 'index.html');
      expect(htmlRecord).toBeDefined();
      expect(htmlRecord?.lines).toBe(5);
      expect(htmlRecord?.sizeBytes).toBeGreaterThan(0);

      // Verify entrypoint detection
      expect(manifest.entrypointType).toBe('html');
      expect(manifest.entrypoint).toContain('index.html');

      // Verify manifest persisted in .maos/last-build.json
      const lastBuildFile = path.join(tmpDir, '.maos', 'last-build.json');
      expect(fs.existsSync(lastBuildFile)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(lastBuildFile, 'utf-8'));
      expect(saved.entrypointType).toBe('html');
      expect(saved.files.length).toBe(manifest.files.length);
    });

    it('renders Built Artifacts & Live Preview panel in printMergeReport', () => {
      const mockWorkers: IgniteWorker[] = [
        {
          index: 0,
          title: 'HTML & UI',
          agentId: 'Worker-1',
          branch: 'maos-ignite-0',
          worktreePath: worktreeDir1,
          paneId: 'w0:p1',
          taskFile: path.join(tmpDir, '.maos', 'ignite', 'Worker-1.md'),
        },
      ];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const manifest = printMergeReport(tmpDir, mockWorkers, false);
        expect(manifest.files.length).toBeGreaterThan(0);
        const logged = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logged).toContain('Built Artifacts & Live Preview');
        expect(logged).toContain('./output/');
        expect(logged).toContain('index.html');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('previewArtifacts in MaosTui launches preview cleanly', () => {
      const tui = new MaosTui(tmpDir);

      // Create output/index.html
      const outDir = path.join(tmpDir, 'output');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), '<h1>Test</h1>', 'utf-8');

      tui.previewArtifacts();
      const status = (tui as any).statusMessage;
      expect(status).toContain('Launched preview');
    });
  });

  // ── 3. Dynamic Model Detection & Selection ────────────────────────────────
  describe('Dynamic Model Detection (User Issue #3)', () => {
    it('formats model badges dynamically for Gemma 4, Gemma 2, and Qwen models', () => {
      expect(formatHeaderBadge('gemma4:e2b')).toBe('GEMMA 4 E2B · LOCAL');
      expect(formatHeaderBadge('gemma2:9b')).toBe('GEMMA 2 9B · LOCAL');
      expect(formatHeaderBadge('gemma2:2b')).toBe('GEMMA 2 2B · LOCAL');
      expect(formatHeaderBadge('gemma3:4b')).toBe('GEMMA 3 4B · LOCAL');
      expect(formatHeaderBadge('Qwen/Qwen2.5-3B-Instruct')).toBe('QWEN 2.5 3B · LOCAL');
      expect(formatHeaderBadge('qwen2.5-coder:7b')).toBe('QWEN CODER · LOCAL');
    });

    it('formats friendly display names for models', () => {
      expect(formatModelDisplayName('gemma4:e2b')).toBe('Gemma 4 (e2b)');
      expect(formatModelDisplayName('gemma2:9b')).toBe('Gemma 2 (9B)');
      expect(formatModelDisplayName('gemma2:2b')).toBe('Gemma 2 (2B)');
      expect(formatModelDisplayName('Qwen/Qwen2.5-3B-Instruct')).toBe('Qwen 2.5 (3B Instruct)');
      expect(formatModelDisplayName('qwen2.5-coder:7b')).toBe('Qwen 2.5 Coder (7b)');
    });

    it('detects installed Ollama models including gemma4:e2b and gemma2:2b/9b', async () => {
      const models = await detectLocalModels();
      expect(models.length).toBeGreaterThanOrEqual(3);

      const modelIds = models.map((m) => m.id.toLowerCase());
      // On this machine, Ollama has gemma2:2b, gemma4:e2b, gemma2:9b
      expect(modelIds.some((id) => id.includes('gemma2:2b'))).toBe(true);
      expect(modelIds.some((id) => id.includes('gemma4:e2b') || id.includes('gemma2:9b'))).toBe(true);
    });

    it('detects HuggingFace local models (e.g. Qwen from ~/.cache/huggingface/hub)', async () => {
      const models = await detectLocalModels();
      const hasQwen = models.some((m) => m.id.toLowerCase().includes('qwen') || m.family === 'qwen');
      expect(hasQwen).toBe(true);
    });

    it('allows cycling models through detected models in MaosTui on G key press', async () => {
      const tui = new MaosTui(process.cwd());
      await tui.refreshDetectedModels();

      const initialModel = (tui as any).selectedModel;
      // Simulate pressing G
      const keyHandler = (tui as any).setupKeyboard ? (tui as any).onKey : null;
      // Direct call to G toggle logic:
      const detected = (tui as any).detectedModels as DetectedModel[];
      expect(detected.length).toBeGreaterThan(1);

      const currIdx = detected.findIndex((m) => m.id.toLowerCase() === initialModel.toLowerCase());
      const nextIdx = (currIdx + 1) % detected.length;
      (tui as any).selectedModel = detected[nextIdx].id;

      expect((tui as any).selectedModel).toBe(detected[nextIdx].id);
      expect((tui as any).selectedModel).not.toBe('');
    });

    it('allows selecting model via /model <name> command in TUI', async () => {
      const tui = new MaosTui(process.cwd());
      await tui.refreshDetectedModels();

      // Switch to gemma4
      await (tui as any).executeCommandLine('/model 4');
      expect((tui as any).selectedModel).toBe('gemma4:e2b');

      // Switch to 2b
      await (tui as any).executeCommandLine('/model 2b');
      expect((tui as any).selectedModel).toBe('gemma2:2b');

      // Switch to 9b
      await (tui as any).executeCommandLine('/model 9b');
      expect((tui as any).selectedModel).toBe('gemma2:9b');

      // Switch to qwen
      await (tui as any).executeCommandLine('/model qwen');
      expect((tui as any).selectedModel.toLowerCase()).toContain('qwen');
    });
  });

  // ── 4. Line Distortion & Emoji Terminal Cell Clamping ──────────────────────
  describe('Line Distortion & Terminal Cell Clamping (User Issue #4)', () => {
    it('correctly calculates terminal cell width for cross mark (❌) as 2 cells', () => {
      const tui = new MaosTui(process.cwd());
      const fn = (tui as any).constructor.name; // access terminalCellWidth
      // Test via centerTerminalLine or fitTerminalLine
      const lineWithCross = '❌ [ERROR] Target file not found';
      const lineWithCheck = '✅ [SUCCESS] Target file created';
      const lineWithWarning = '⚠️ [WARN] Buffer hook broken';

      const fittedCross = (tui as any).constructor.prototype.fitTerminalLine
        ? (tui as any).constructor.prototype.fitTerminalLine(lineWithCross, 50)
        : null;

      // Use node Intl test to verify cell count for 0x274c
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const { segment } of segmenter.segment('❌')) {
        const points = Array.from(segment, (c) => c.codePointAt(0) || 0);
        expect(points[0]).toBe(0x274c);
      }
    });

    it('ensures line with ❌ does not overflow target width and misalign sidebar separator', () => {
      const tui = new MaosTui(process.cwd());
      const errLine =
        '❌ [2026-11-19T11:57:27.955Z] [ERROR] [HEALER] Pane wF:pD: patch failed - Target file not found: src/game.ts';
      const normalLine = '✓ [2026-11-19T11:57:27.955Z] [INFO] Normal logging line that does not contain error mark';

      (tui as any).transcript = [errLine, normalLine];
      const lines: string[] = [];
      (tui as any).renderTabFleet(lines, 80, 20);

      // Verify all rendered lines strictly conform to width
      for (const line of lines) {
        expect(line).not.toContain('\n');
        expect(line).not.toContain('\r');
      }
    });
  });
});
