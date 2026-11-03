/**
 * TASK RELEASE-CLI-01: first-run Ring demo pack setup.
 *
 * `maos-industrial ring --demo` (and `maos-industrial setup-demo`) copy the
 * bundled synthetic demo pack out of the installed package into
 * `~/maos-industrial-demo` and run Ring there. This exists because Ring
 * resolves evidence relative to the project folder (CWD for `ring -p`), so
 * running from an empty directory finds no telemetry, SOP, or thresholds.
 *
 * Fail-closed rules:
 * - The target must be empty or absent; a non-empty target refuses unless
 *   `--force` is passed (which recreates the directory).
 * - Missing bundled sources fail with the exact missing file list.
 * - No API keys are ever written: the demo project config is derived from
 *   the bundled industrial profile template with every `apiKey` value
 *   stripped to an empty string.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import chalk from 'chalk';
import { runRingHeadless, RING_CLI_EXIT } from './ring-cli';
import type { RingCliExitCode } from './ring-cli';
import { safeTerminalText } from './industrial-repl';

/** Demo target directory name under the user's home directory. */
export const RING_DEMO_DIR_NAME = 'maos-industrial-demo';

/**
 * Bundled synthetic demo pack shipped inside the installed package. Every
 * path here must be present in `package.json` `files` (covered by
 * tests/industrial/ring-release-cli.test.ts). This is the exact set Ring
 * reads: the T-07 turbine evidence, the safety thresholds, and the P-12
 * pump evidence (telemetry CSV + maintenance note + SOP; the inspection
 * scan ships alongside for the evidence-root reader).
 */
export const RING_DEMO_FILES = [
  'demo/industrial/turbine_vibration_log.csv',
  'demo/industrial/sop_turbine_vibration_monitoring.md',
  'demo/industrial/maintenance_report.txt',
  'demo/industrial/safety_thresholds.json',
  'demo/industrial/turbine_inspection_scan.pdf',
  'demo/industrial/pump_p12_vibration_log.csv',
  'demo/industrial/sop_pump_p12_monitoring.md',
  'demo/industrial/maintenance_report_p12.txt',
  'demo/industrial/pump_p12_inspection_scan.png',
] as const;

/** Bundled industrial profile template used as the demo project config base. */
export const RING_DEMO_PROFILE_TEMPLATE = 'profiles/industrial/maos.config.json';

/** Headless brief instruction run by `ring --demo` after setup. */
export const RING_DEMO_BRIEF_INSTRUCTION = 'Give me the turbine vibration brief';

/** Resolve the package root that carries the bundled demo pack. */
export function resolveRingDemoSourceRoot(startDir?: string): string {
  const base = startDir ?? __dirname;
  const candidates = [
    // dist layout: dist/industrial/ring-demo.js -> package root.
    // src layout (ts-node/vitest): src/industrial/ring-demo.ts -> repo root.
    path.resolve(base, '..', '..'),
    path.resolve(base, '..'),
    path.resolve(base),
  ];
  for (const candidate of candidates) {
    try {
      const marker = path.join(candidate, RING_DEMO_FILES[0]);
      if (fs.existsSync(marker)) return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `RING_DEMO_SOURCE_MISSING: bundled demo pack not found under ${candidates[0]}. ` +
      `Missing: ${RING_DEMO_FILES[0]}. Reinstall the maosorch package.`,
  );
}

/** Resolve the demo target directory (`~/maos-industrial-demo` by default). */
export function resolveRingDemoTargetDir(env?: NodeJS.ProcessEnv): string {
  const override = env?.MAOS_DEMO_DIR ?? process.env.MAOS_DEMO_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), RING_DEMO_DIR_NAME);
}

export interface RingDemoSetupOptions {
  /** Package root carrying demo/industrial + profiles (defaults to resolved). */
  packageRoot?: string;
  /** Target directory (defaults to ~/maos-industrial-demo). */
  targetDir?: string;
  /** Recreate a non-empty target instead of failing closed. */
  force?: boolean;
  output?: Writable;
}

export interface RingDemoSetupResult {
  targetDir: string;
  copied: string[];
  configPath: string;
  alreadyPresent: boolean;
}

function stripApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripApiKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'apikey') {
        out[key] = '';
        continue;
      }
      out[key] = stripApiKeys(entry);
    }
    return out;
  }
  return value;
}

function isDirEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/**
 * Copy the bundled demo pack into the target directory. Fail-closed when the
 * target exists and is non-empty unless `force` recreates it. Writes no API
 * keys. Returns the copied file list and demo config path.
 */
export function setupRingDemoPack(options: RingDemoSetupOptions = {}): RingDemoSetupResult {
  const output = options.output;
  const packageRoot = path.resolve(options.packageRoot ?? resolveRingDemoSourceRoot());
  const targetDir = path.resolve(options.targetDir ?? resolveRingDemoTargetDir());
  const log = (line: string): void => {
    if (output) output.write(`${line}\n`);
  };

  const missing = RING_DEMO_FILES.filter(
    (rel) => !fs.existsSync(path.join(packageRoot, rel)),
  );
  if (missing.length > 0) {
    throw new Error(
      `RING_DEMO_SOURCE_MISSING: bundled demo pack incomplete under ${packageRoot}. Missing: ${missing.join(', ')}. Reinstall the maosorch package.`,
    );
  }
  const templatePath = path.join(packageRoot, RING_DEMO_PROFILE_TEMPLATE);
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `RING_DEMO_SOURCE_MISSING: profile template not found: ${RING_DEMO_PROFILE_TEMPLATE} under ${packageRoot}. Reinstall the maosorch package.`,
    );
  }

  const targetExists = fs.existsSync(targetDir);
  if (targetExists && !isDirEmpty(targetDir) && !options.force) {
    throw new Error(
      `RING_DEMO_TARGET_NOT_EMPTY: ${targetDir} already exists and is not empty. ` +
        `Pass --force to recreate it, or run Ring there directly.`,
    );
  }

  let alreadyPresent = false;
  if (targetExists && !isDirEmpty(targetDir) && options.force) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    log(chalk.gray(`Recreated ${safeTerminalText(targetDir)} (--force).`));
  } else if (targetExists && isDirEmpty(targetDir) && !options.force) {
    alreadyPresent = false;
  } else if (!targetExists) {
    alreadyPresent = false;
  } else {
    alreadyPresent = true;
  }

  fs.mkdirSync(path.join(targetDir, 'demo', 'industrial'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, '.maos'), { recursive: true });

  const copied: string[] = [];
  for (const rel of RING_DEMO_FILES) {
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, rel), dest);
    copied.push(rel);
  }

  // Demo project config: bundled industrial profile template with every
  // apiKey value stripped. Writes NO API keys by construction.
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as Record<string, unknown>;
  const sanitized = stripApiKeys(template) as Record<string, unknown>;
  const configPath = path.join(targetDir, '.maos', 'maos.config.json');
  fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2) + '\n', 'utf-8');

  log(chalk.green(`Demo pack ready at ${safeTerminalText(targetDir)} (${copied.length} files, no API keys written).`));
  return { targetDir, copied, configPath, alreadyPresent };
}

export interface RingDemoRunOptions extends RingDemoSetupOptions {
  json?: boolean;
}

/**
 * `maos-industrial ring --demo`: set up the demo pack, then run the
 * deterministic evidence-only brief headless inside the demo directory.
 * Works when CWD has no demo/industrial data (the reported bug: `ring -p`
 * uses CWD as the project folder).
 */
export async function runRingDemo(options: RingDemoRunOptions = {}): Promise<{
  exitCode: RingCliExitCode;
  targetDir: string;
}> {
  const output = options.output || process.stdout;
  const setup = setupRingDemoPack({ ...options, output });
  const result = await runRingHeadless({
    projectRoot: setup.targetDir,
    instruction: RING_DEMO_BRIEF_INSTRUCTION,
    json: options.json,
    output,
  });
  if (result.exitCode === RING_CLI_EXIT.COMPLETED) {
    output.write(
      chalk.gray(
        'Demo complete in ' +
          safeTerminalText(setup.targetDir) +
          '. Re-run: cd ' +
          safeTerminalText(setup.targetDir) +
          ' && maos-industrial ring -p "' +
          RING_DEMO_BRIEF_INSTRUCTION +
          '"\n',
      ),
    );
  }
  return { exitCode: result.exitCode, targetDir: setup.targetDir };
}

/** Exact next command printed by `setup-demo` (copy-paste ready). */
export function ringDemoNextCommand(targetDir: string): string {
  return 'cd ' + targetDir + ' && maos-industrial ring -p "' + RING_DEMO_BRIEF_INSTRUCTION + '"';
}
