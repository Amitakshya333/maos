/**
 * TASK RELEASE-CLI-01: Ring CLI release packaging tests.
 *
 * - First-run demo command works when CWD has no demo/industrial data:
 *   empty temp CWD is irrelevant (runRingDemo never reads process.cwd());
 *   the brief completes evidence-only with CRITICAL / RMS 2.637.
 * - `files` coverage: every demo file Ring reads is in package.json `files`,
 *   and review-packets/, event-staging-*, .worktrees/, read-only-completion.patch
 *   stay excluded.
 * - Version consistency: package.json, CLI VERSION constants, TUI version,
 *   and package-lock agree on 0.4.0.
 *
 * Evidence-only throughout (BASETEN_API_KEY unset; no hosted calls).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { BASETEN_API_KEY_ENV } from '../../src/backends/meta-api-policy';
import { INDUSTRIAL_TUI_VERSION } from '../../src/industrial/industrial-tui';
import {
  RING_DEMO_FILES,
  RING_DEMO_BRIEF_INSTRUCTION,
  resolveRingDemoTargetDir,
  setupRingDemoPack,
  runRingDemo,
  ringDemoNextCommand,
} from '../../src/industrial/ring-demo';
import { RING_CLI_EXIT } from '../../src/industrial/ring-cli';

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeEmptyDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collectApiKeys(value: unknown, hits: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectApiKeys(entry, hits);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'apikey' && typeof entry === 'string' && entry.trim()) {
        hits.push(entry.trim());
      } else {
        collectApiKeys(entry, hits);
      }
    }
  }
}

describe('TASK RELEASE-CLI-01: Ring first-run demo command', () => {
  let home = '';
  let target = '';
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    savedEnv.MAOS_DEMO_DIR = process.env.MAOS_DEMO_DIR;
    home = makeEmptyDir('maos-ring-demo-home-');
    target = path.join(home, 'maos-industrial-demo');
    process.env.MAOS_DEMO_DIR = target;
  });

  afterEach(() => {
    delete process.env[BASETEN_API_KEY_ENV];
    if (savedEnv.MAOS_DEMO_DIR === undefined) delete process.env.MAOS_DEMO_DIR;
    else process.env.MAOS_DEMO_DIR = savedEnv.MAOS_DEMO_DIR;
    for (const dir of [home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('sets up the demo pack with no API keys written', () => {
    const setup = setupRingDemoPack({ packageRoot: REPO_ROOT, targetDir: target });
    expect(setup.targetDir).toBe(path.resolve(target));
    expect(setup.copied).toHaveLength(RING_DEMO_FILES.length);
    for (const rel of RING_DEMO_FILES) {
      expect(fs.existsSync(path.join(target, rel))).toBe(true);
    }
    const config = JSON.parse(fs.readFileSync(setup.configPath, 'utf-8')) as unknown;
    const keys: string[] = [];
    collectApiKeys(config, keys);
    expect(keys).toEqual([]);
  });

  it('fails closed when the target exists and is non-empty, recreates with --force', () => {
    setupRingDemoPack({ packageRoot: REPO_ROOT, targetDir: target });
    expect(() => setupRingDemoPack({ packageRoot: REPO_ROOT, targetDir: target })).toThrow(
      /RING_DEMO_TARGET_NOT_EMPTY/,
    );
    const forced = setupRingDemoPack({ packageRoot: REPO_ROOT, targetDir: target, force: true });
    expect(forced.copied).toHaveLength(RING_DEMO_FILES.length);
  });

  it('runs the brief from the demo dir with CRITICAL RMS 2.637 (CWD-independent)', () => {
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    return runRingDemo({ packageRoot: REPO_ROOT, targetDir: target, output }).then((result) => {
      expect(result.exitCode).toBe(RING_CLI_EXIT.COMPLETED);
      expect(text).toContain('CRITICAL');
      expect(text).toContain('2.637');
    });
  }, 120000);

  it('prints the exact next command for setup-demo users', () => {
    expect(ringDemoNextCommand(target)).toBe(
      'cd ' + target + ' && maos-industrial ring -p "' + RING_DEMO_BRIEF_INSTRUCTION + '"',
    );
    expect(resolveRingDemoTargetDir({ MAOS_DEMO_DIR: target } as NodeJS.ProcessEnv)).toBe(
      path.resolve(target),
    );
  });
});

describe('TASK RELEASE-CLI-01: packaged files cover every demo file Ring reads', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    files: string[];
  };

  it('ships the SOP plus the P-12 demo files Ring reads', () => {
    for (const rel of RING_DEMO_FILES) {
      expect(pkg.files).toContain(rel);
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
    // Code-read paths, verified by grep over src (see run-log):
    // ring-inference-service prefetch (turbine SOP/maintenance/thresholds/CSV),
    // ring-agent-service P-12 defaults (csvPath/documentPath), skill presets
    // (sop_pump_p12_monitoring.md), telemetry tool default CSV, ocr tool scan.
    for (const rel of [
      'demo/industrial/sop_turbine_vibration_monitoring.md',
      'demo/industrial/maintenance_report.txt',
      'demo/industrial/safety_thresholds.json',
      'demo/industrial/turbine_vibration_log.csv',
      'demo/industrial/turbine_inspection_scan.pdf',
      'demo/industrial/pump_p12_vibration_log.csv',
      'demo/industrial/maintenance_report_p12.txt',
      'demo/industrial/sop_pump_p12_monitoring.md',
      'demo/industrial/pump_p12_inspection_scan.png',
    ]) {
      expect(pkg.files).toContain(rel);
    }
  });

  it('keeps review packets, staging, worktrees, and patches out of the tarball', () => {
    for (const entry of pkg.files) {
      expect(entry.startsWith('review-packets/')).toBe(false);
      expect(entry.startsWith('event-staging-')).toBe(false);
      expect(entry.startsWith('.worktrees/')).toBe(false);
      expect(entry).not.toBe('read-only-completion.patch');
    }
    expect(fs.existsSync(path.join(REPO_ROOT, '.npmignore'))).toBe(true);
  });
});

describe('TASK RELEASE-CLI-01: version 0.4.0 is consistent', () => {
  it('package.json, CLI, TUI, and lockfile agree on 0.4.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('0.4.0');
    expect(INDUSTRIAL_TUI_VERSION).toBe('0.4.0');
    for (const rel of ['src/cli/index.ts', 'src/cli/repl.ts']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(src).toContain("const VERSION = '0.4.0';");
    }
    const lock = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as { version: string; packages: { '': { version: string } } };
    expect(lock.version).toBe('0.4.0');
    expect(lock.packages[''].version).toBe('0.4.0');
    const desktop = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(desktop.version).toBe('0.4.0');
  });
});
