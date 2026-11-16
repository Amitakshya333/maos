/**
 * MAOS Oasis — Sovereign Health Gatekeeper & Diagnostic Suite
 *
 * Implements 6-point diagnostics:
 *   1. Node.js version (>=20.0.0)
 *   2. Configuration file & runtime directories integrity
 *   3. Network & loopback OpSec enforcement (127.0.0.1 / localhost / ::1 only)
 *   4. Ollama daemon reachability on 127.0.0.1:11434 (with --fix auto-start)
 *   5. Model presence & live generation speed benchmark (POST /api/generate prompt: 'OASIS_OK')
 *   6. Companion toolchain integrations (Herdr, OpenCode, Git) with non-fatal warnings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import chalk from 'chalk';
import ora from 'ora';

import {
  DoctorCheckResult,
  DoctorReport,
  DoctorOptions,
  DoctorReadiness,
  GenerationBenchmark,
  MaosOasisConfig,
} from './types';
import {
  getOasisConfigPath,
  getOasisRuntimeDir,
  getOasisQueueDir,
  getOasisLogsDir,
  getOasisStatusDir,
  loadOasisConfig,
  ensureOasisRuntimeDirs,
  isLoopbackHost,
  OASIS_CURRENT_VERSION,
} from './config';
import { renderPanel, getBrandBadge } from '../utils/ui';

export const DEFAULT_LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_LOOPBACK_PORT = 11434;
export const DEFAULT_LOOPBACK_URL = `http://${DEFAULT_LOOPBACK_HOST}:${DEFAULT_LOOPBACK_PORT}`;
export const PROMPT_BENCHMARK_PAYLOAD = 'Reply with exactly: OASIS_OK';

// ── Binary Finders & Process Management ────────────────────────────────────

export function findOllamaExecutable(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}

  if (process.platform === 'win32') {
    const defaultWin = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(defaultWin)) return defaultWin;
    const progFiles = 'C:\\Program Files\\Ollama\\ollama.exe';
    if (fs.existsSync(progFiles)) return progFiles;
  }

  if (process.platform === 'linux') {
    for (const p of [
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      '/bin/ollama',
      path.join(os.homedir(), '.local/bin/ollama'),
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

export function findHerdrExecutable(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where herdr' : 'which herdr';
    const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}

  if (process.platform === 'win32') {
    const defaultWin = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Herdr', 'bin', 'herdr.exe');
    if (fs.existsSync(defaultWin)) return defaultWin;
  }

  return null;
}

export async function attemptOllamaAutoStart(
  fetchFn: typeof globalThis.fetch,
  host = DEFAULT_LOOPBACK_HOST,
  port = DEFAULT_LOOPBACK_PORT,
  timeoutMs = 10000,
): Promise<boolean> {
  const binary = findOllamaExecutable();
  if (binary) {
    try {
      const child = child_process.spawn(binary, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch {
      // Continue and poll fetch in case daemon is managed externally or test mock is supplied
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetchFn(`http://${host}:${port}/api/tags`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

// ── Check 1: Node.js Runtime Version ───────────────────────────────────────

export function checkNodeVersion(): DoctorCheckResult {
  const startTime = Date.now();
  const rawVersion = process.versions.node;
  const major = parseInt(rawVersion.split('.')[0], 10);
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
  const arch = process.arch;

  if (major >= 20) {
    return {
      id: 'node_version',
      name: 'Node.js Runtime',
      status: 'pass',
      required: true,
      message: `v${rawVersion} on ${platform} (${arch}) [Node >=20 satisfied]`,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    id: 'node_version',
    name: 'Node.js Runtime',
    status: 'fail',
    required: true,
    message: `v${rawVersion} is unsupported. MAOS Oasis requires Node.js >= 20.0.0 for native fetch & ESM/CJS compatibility.`,
    fixHint:
      'Update Node.js to version 20.0.0 or higher from https://nodejs.org or via your version manager (nvm/fnm).',
    durationMs: Date.now() - startTime,
  };
}

// ── Check 2: Configuration & Runtime Directory Integrity ───────────────────

export function checkConfigAndRuntime(cwd: string, fix: boolean): DoctorCheckResult {
  const startTime = Date.now();
  const configPath = getOasisConfigPath(cwd);
  const runtimeDir = getOasisRuntimeDir(cwd);
  const queueDir = getOasisQueueDir(cwd);

  const requiredDirs = [
    runtimeDir,
    queueDir,
    path.join(queueDir, 'pending'),
    path.join(queueDir, 'active'),
    path.join(queueDir, 'done'),
    path.join(queueDir, 'failed'),
    getOasisLogsDir(cwd),
    getOasisStatusDir(cwd),
  ];

  if (!fs.existsSync(configPath)) {
    return {
      id: 'oasis_config',
      name: 'Config & Runtime State',
      status: 'fail',
      required: true,
      message: `Configuration missing at ${path.relative(cwd, configPath) || configPath}`,
      fixHint: 'Run "maos-oasis init" to generate your project configuration.',
      durationMs: Date.now() - startTime,
    };
  }

  let parsedConfig: MaosOasisConfig;
  try {
    parsedConfig = loadOasisConfig(cwd)!;
  } catch (err: any) {
    return {
      id: 'oasis_config',
      name: 'Config & Runtime State',
      status: 'fail',
      required: true,
      message: `Invalid configuration: ${err.message}`,
      fixHint: 'Check syntax in maos-oasis.config.json or run "maos-oasis init -f" to regenerate.',
      durationMs: Date.now() - startTime,
    };
  }

  const missingDirs = requiredDirs.filter((d) => !fs.existsSync(d));
  const innerGitignore = path.join(runtimeDir, '.gitignore');
  const missingGitignore = !fs.existsSync(innerGitignore);

  if (missingDirs.length > 0 || missingGitignore) {
    if (fix) {
      ensureOasisRuntimeDirs(cwd);
      return {
        id: 'oasis_config',
        name: 'Config & Runtime State',
        status: 'pass',
        required: true,
        message: `Config verified & auto-repaired ${missingDirs.length} missing directories with hardened .gitignore`,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      id: 'oasis_config',
      name: 'Config & Runtime State',
      status: 'warn',
      required: true,
      message: `Runtime directory .maos-oasis missing ${missingDirs.length} subfolders`,
      fixHint: 'Run "maos-oasis doctor --fix" to automatically create missing runtime directories.',
      durationMs: Date.now() - startTime,
    };
  }

  return {
    id: 'oasis_config',
    name: 'Config & Runtime State',
    status: 'pass',
    required: true,
    message: `./maos-oasis.config.json & ./.maos-oasis/ verified (${requiredDirs.length} directories active, .gitignore hardened)`,
    durationMs: Date.now() - startTime,
    metadata: { version: parsedConfig.version, preset: parsedConfig.team?.preset },
  };
}

// ── Check 3: Sovereign Loopback OpSec Gate ─────────────────────────────────

export function checkLoopbackOpSec(config: MaosOasisConfig | null): DoctorCheckResult {
  const startTime = Date.now();
  const host = config?.ollama?.host || DEFAULT_LOOPBACK_HOST;
  const port = config?.ollama?.port || DEFAULT_LOOPBACK_PORT;
  const endpoint = `http://${host}:${port}`;

  if (!isLoopbackHost(host)) {
    return {
      id: 'loopback_opsec',
      name: 'Loopback OpSec Gate',
      status: 'fail',
      required: true,
      message: `OpSec Violation: endpoint "${endpoint}" is not a strict loopback address. Only 127.0.0.1, localhost, and ::1 are permitted.`,
      fixHint: 'Change "ollama.host" to "127.0.0.1" in maos-oasis.config.json.',
      durationMs: Date.now() - startTime,
    };
  }

  // Scan environment for cloud keys to verify sovereign operation
  const detectedKeys: string[] = [];
  for (const envKey of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY']) {
    if (process.env[envKey] && process.env[envKey]!.trim().length > 0) {
      detectedKeys.push(envKey);
    }
  }

  let note = 'Zero cloud transmission';
  if (detectedKeys.length > 0) {
    note = `Cloud keys found in env (${detectedKeys.join(', ')}) but ignored — sovereign local loopback strictly enforced`;
  }

  return {
    id: 'loopback_opsec',
    name: 'Loopback OpSec Gate',
    status: 'pass',
    required: true,
    message: `Strict sovereign loopback confirmed (${endpoint}) — ${note}`,
    durationMs: Date.now() - startTime,
  };
}

// ── Check 4: Ollama Daemon Reachability on Port 11434 ───────────────────────

export async function checkOllamaDaemon(
  host: string,
  port: number,
  fix: boolean,
  fetchFn: typeof globalThis.fetch,
): Promise<{ result: DoctorCheckResult; autoStarted: boolean; tagsData?: any }> {
  const startTime = Date.now();
  const endpoint = `http://${host}:${port}/api/tags`;

  let isOnline = false;
  let latencyMs = 0;
  let tagsData: any = null;

  try {
    const pingStart = Date.now();
    const res = await fetchFn(endpoint, { signal: AbortSignal.timeout(3000) });
    latencyMs = Date.now() - pingStart;
    if (res.ok) {
      isOnline = true;
      tagsData = await res.json();
    }
  } catch {}

  let autoStarted = false;
  if (!isOnline && fix) {
    autoStarted = await attemptOllamaAutoStart(fetchFn, host, port, 10000);
    if (autoStarted) {
      try {
        const pingStart = Date.now();
        const res = await fetchFn(endpoint, { signal: AbortSignal.timeout(3000) });
        latencyMs = Date.now() - pingStart;
        if (res.ok) {
          isOnline = true;
          tagsData = await res.json();
        }
      } catch {}
    }
  }

  if (isOnline) {
    const msgSuffix = autoStarted ? ' (auto-started in background via --fix)' : ` (${latencyMs}ms latency)`;
    return {
      autoStarted,
      tagsData,
      result: {
        id: 'ollama_daemon',
        name: 'Ollama Daemon',
        status: 'pass',
        required: true,
        message: `Online on ${host}:${port}${msgSuffix}`,
        durationMs: Date.now() - startTime,
      },
    };
  }

  const binaryFound = Boolean(findOllamaExecutable());
  const fixHint = binaryFound
    ? 'Start Ollama by running "ollama serve" in a separate terminal, or run "maos-oasis doctor --fix".'
    : process.platform === 'win32'
      ? 'Install Ollama from https://ollama.com/download, then run "ollama serve".'
      : 'Install Ollama via "curl -fsSL https://ollama.com/install.sh | sh", then run "ollama serve".';

  return {
    autoStarted: false,
    result: {
      id: 'ollama_daemon',
      name: 'Ollama Daemon',
      status: 'fail',
      required: true,
      message: `Ollama daemon is not responding on http://${host}:${port}.`,
      fixHint,
      durationMs: Date.now() - startTime,
    },
  };
}

// ── Check 5: Model Presence & Live Generation Speed Benchmark ──────────────

export async function checkModelAndBenchmark(
  host: string,
  port: number,
  targetModel: string,
  tagsData: any,
  timeoutMs: number,
  fetchFn: typeof globalThis.fetch,
): Promise<{ result: DoctorCheckResult; benchmark?: GenerationBenchmark }> {
  const startTime = Date.now();

  // Step 5A: Model Tag Verification
  const pulledModels: string[] = (tagsData?.models || []).map((m: any) => m.name || '');
  const modelMatches = (candidate: string, target: string): boolean => {
    const c = candidate.toLowerCase();
    const t = target.toLowerCase();
    return c === t || c === `${t}:latest` || c.replace(/:latest$/, '') === t.replace(/:latest$/, '');
  };

  const isPresent = pulledModels.some((name) => modelMatches(name, targetModel));

  if (!isPresent && pulledModels.length > 0) {
    return {
      result: {
        id: 'model_benchmark',
        name: 'Gemma Inference Benchmark',
        status: 'fail',
        required: true,
        message: `Configured model "${targetModel}" is not downloaded in Ollama (found: ${pulledModels.join(', ') || 'none'}).`,
        fixHint: `Download the model by running "ollama pull ${targetModel}".`,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // Step 5B: Live Generation Speed Benchmark
  try {
    const genStart = Date.now();
    const res = await fetchFn(`http://${host}:${port}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        prompt: PROMPT_BENCHMARK_PAYLOAD,
        stream: false,
        options: {
          num_predict: 16,
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const totalDurationMs = Date.now() - genStart;

    if (!res.ok) {
      const errText = await res.text();
      return {
        result: {
          id: 'model_benchmark',
          name: 'Gemma Inference Benchmark',
          status: 'fail',
          required: true,
          message: `Ollama generate API failed with HTTP ${res.status}: ${errText.slice(0, 150)}`,
          fixHint: `Ensure "${targetModel}" is valid and your system has sufficient VRAM/RAM.`,
          durationMs: Date.now() - startTime,
        },
      };
    }

    const data = (await res.json()) as {
      response?: string;
      eval_count?: number;
      eval_duration?: number;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
    };

    const evalCount = data.eval_count || 1;
    let evalDurationSec = (data.eval_duration || 0) / 1e9;
    if (evalDurationSec <= 0) {
      evalDurationSec = Math.max(0.001, totalDurationMs / 1000);
    }
    const tokensPerSecond = Math.round((evalCount / evalDurationSec) * 10) / 10;
    const sampleOutput = (data.response || '').trim();

    const benchmark: GenerationBenchmark = {
      model: targetModel,
      evalCount,
      evalDurationSec,
      tokensPerSecond,
      totalDurationMs,
      sampleOutput: sampleOutput.replace(/\r?\n/g, ' ').slice(0, 40),
      promptEvalCount: data.prompt_eval_count,
      promptEvalDurationSec: data.prompt_eval_duration ? data.prompt_eval_duration / 1e9 : undefined,
    };

    const outputSnippet = sampleOutput ? ` — "${benchmark.sampleOutput}"` : '';

    return {
      benchmark,
      result: {
        id: 'model_benchmark',
        name: 'Gemma Inference Benchmark',
        status: 'pass',
        required: true,
        message: `${targetModel} verified live: ${tokensPerSecond} tok/s (${totalDurationMs}ms)${outputSnippet}`,
        durationMs: Date.now() - startTime,
        metadata: { ...benchmark },
      },
    };
  } catch (err: any) {
    return {
      result: {
        id: 'model_benchmark',
        name: 'Gemma Inference Benchmark',
        status: 'fail',
        required: true,
        message: `Live generation test timed out or failed: ${err.message}`,
        fixHint: `The model may have exceeded available VRAM. Consider switching to lightweight "gemma2:2b" in maos-oasis.config.json.`,
        durationMs: Date.now() - startTime,
      },
    };
  }
}

// ── Check 6: Companion Toolchain Integrations (Non-Fatal Warnings) ──────────

export function checkToolchains(cwd: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  // 1. Herdr (Multi-pane terminal tiling)
  const herdrStart = Date.now();
  let herdrVersion: string | null = null;
  try {
    herdrVersion = child_process
      .execSync('herdr --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 })
      .trim();
  } catch {
    const winHerdr = findHerdrExecutable();
    if (winHerdr) {
      try {
        herdrVersion = child_process
          .execSync(`"${winHerdr}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 })
          .trim();
      } catch {}
    }
  }

  if (herdrVersion) {
    results.push({
      id: 'toolchain_herdr',
      name: 'Herdr Toolchain',
      status: 'pass',
      required: false,
      message: `${herdrVersion} detected — Multi-pane terminal tiling enabled`,
      durationMs: Date.now() - herdrStart,
    });
  } else {
    results.push({
      id: 'toolchain_herdr',
      name: 'Herdr Toolchain',
      status: 'warn',
      required: false,
      message: 'Herdr not found — Single-pane terminal fallback active',
      fixHint:
        process.platform === 'win32'
          ? 'powershell -Command "irm https://herdr.dev/install.ps1 | iex"'
          : 'curl -fsSL https://herdr.dev/install.sh | sh',
      durationMs: Date.now() - herdrStart,
    });
  }

  // 2. OpenCode (AST / Code Diff Harness)
  const opencodeStart = Date.now();
  let opencodeVersion: string | null = null;
  try {
    opencodeVersion = child_process
      .execSync('opencode --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 })
      .trim();
  } catch {}

  if (opencodeVersion) {
    const cleanVersion = opencodeVersion.replace(/^opencode\s*/i, '');
    results.push({
      id: 'toolchain_opencode',
      name: 'OpenCode Toolchain',
      status: 'pass',
      required: false,
      message: `OpenCode ${cleanVersion} detected — AST/diff harness enabled`,
      durationMs: Date.now() - opencodeStart,
    });
  } else {
    results.push({
      id: 'toolchain_opencode',
      name: 'OpenCode Toolchain',
      status: 'warn',
      required: false,
      message: 'OpenCode not found — Direct loopback Ollama API fallback active',
      fixHint: 'npm install -g @opencode/cli',
      durationMs: Date.now() - opencodeStart,
    });
  }

  // 3. Git Repository Status
  const gitStart = Date.now();
  let isGit = false;
  let branchName = '';
  try {
    const isRepo = child_process
      .execSync('git rev-parse --is-inside-work-tree', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2000,
      })
      .trim();
    if (isRepo === 'true') {
      isGit = true;
      branchName = child_process
        .execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 2000,
        })
        .trim();
    }
  } catch {}

  if (isGit) {
    results.push({
      id: 'git_repository',
      name: 'Git Worktrees',
      status: 'pass',
      required: false,
      message: `Git repository active on branch "${branchName}" — Worktree swarm isolation ready`,
      durationMs: Date.now() - gitStart,
    });
  } else {
    results.push({
      id: 'git_repository',
      name: 'Git Worktrees',
      status: 'warn',
      required: false,
      message: 'Current directory is not a Git repository — Parallel branch isolation disabled',
      fixHint: 'Run "git init" to enable agent worktree isolation.',
      durationMs: Date.now() - gitStart,
    });
  }

  return results;
}

// ── Visual Terminal Formatter ──────────────────────────────────────────────

export function renderDoctorReport(report: DoctorReport): void {
  console.log('');
  const headerLines = [
    `${getBrandBadge('OASIS DOCTOR')} ${chalk.bold.hex('#F1F5F9')('Sovereign Health Diagnostics')}`,
    `${chalk.gray('Strict Loopback · 100% Offline · Gemma Optimization')}`,
  ];
  console.log(renderPanel(headerLines, chalk.hex('#3B82F6')));
  console.log('');

  for (const check of report.checks) {
    let icon = chalk.green('  ✔ ');
    let statusLabel = chalk.green('PASS');
    if (check.status === 'warn') {
      icon = chalk.yellow('  ⚠️ ');
      statusLabel = chalk.yellow('WARN');
    } else if (check.status === 'fail') {
      icon = chalk.red('  ✖ ');
      statusLabel = chalk.red('FAIL');
    }

    const nameCol = chalk.bold(check.name.padEnd(26));
    const reqTag = check.required ? chalk.gray('[required]') : chalk.gray('[optional]');
    console.log(`${icon} ${nameCol} ${reqTag.padEnd(12)} ${check.message}`);

    if (check.fixHint) {
      console.log(chalk.gray(`     └─ Fix: ${chalk.yellow(check.fixHint)}`));
    }
  }

  console.log('');
  console.log(chalk.hex('#334155')('─'.repeat(70)));
  const { total, passed, warned, failed } = report.summary || {
    total: report.checks.length,
    passed: report.checks.filter((c) => c.status === 'pass').length,
    warned: report.checks.filter((c) => c.status === 'warn').length,
    failed: report.checks.filter((c) => c.status === 'fail').length,
  };

  console.log(
    `  Summary: ${chalk.green(`${passed} passed`)}    ${chalk.yellow(`${warned} warnings`)}    ${chalk.red(`${failed} failures`)}`,
  );
  console.log(chalk.hex('#334155')('─'.repeat(70)));
  console.log('');

  if (report.readiness === 'ready') {
    console.log(chalk.green('  🚀 ALL CHECKS PASSED: Sovereign workplace is fully operational.\n'));
  } else if (report.readiness === 'ready_with_warnings') {
    console.log(
      chalk.yellow('  ⚠️  READY WITH FALLBACKS: Sovereign workplace ready; optional tools in fallback mode.\n'),
    );
  } else {
    console.log(chalk.red('  ❌ NOT READY: Critical prerequisites failed. Address errors above before running.\n'));
  }
}

// ── Primary Exported Function ──────────────────────────────────────────────

export async function runOasisDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fetchFn = options.fetch || globalThis.fetch;
  const timeoutMs = options.benchmarkTimeoutMs || 30000;
  const fix = Boolean(options.fix);

  const checks: DoctorCheckResult[] = [];

  // Check 1: Node.js Runtime
  checks.push(checkNodeVersion());

  // Check 2: Config & Runtime Directories
  checks.push(checkConfigAndRuntime(cwd, fix));

  // Load config for remaining checks
  const config = loadOasisConfig(cwd);

  // Check 3: Loopback OpSec
  checks.push(checkLoopbackOpSec(config));

  // Check 4: Ollama Daemon Reachability
  const host = config?.ollama?.host || DEFAULT_LOOPBACK_HOST;
  const port = config?.ollama?.port || DEFAULT_LOOPBACK_PORT;
  const targetModel = config?.model?.primary || 'gemma2:9b';

  const ollamaCheck = await checkOllamaDaemon(host, port, fix, fetchFn);
  checks.push(ollamaCheck.result);

  // Check 5: Model presence and live generation benchmark
  let benchmark: GenerationBenchmark | undefined;
  if (ollamaCheck.result.status === 'pass') {
    const benchCheck = await checkModelAndBenchmark(host, port, targetModel, ollamaCheck.tagsData, timeoutMs, fetchFn);
    checks.push(benchCheck.result);
    benchmark = benchCheck.benchmark;
  } else {
    checks.push({
      id: 'model_benchmark',
      name: 'Gemma Inference Benchmark',
      status: 'fail',
      required: true,
      message: `Skipped: Ollama daemon is offline on http://${host}:${port}`,
      fixHint: 'Start Ollama first by running "ollama serve".',
    });
  }

  // Check 6: Companion Toolchains
  const toolchainChecks = checkToolchains(cwd);
  checks.push(...toolchainChecks);

  // Aggregate results
  const passedCount = checks.filter((c) => c.status === 'pass').length;
  const warnedCount = checks.filter((c) => c.status === 'warn').length;
  const failedCount = checks.filter((c) => c.status === 'fail' && c.required !== false).length;

  let readiness: DoctorReadiness = 'ready';
  let exitCode: 0 | 1 = 0;
  let passed = true;

  if (failedCount > 0) {
    readiness = 'not_ready';
    exitCode = 1;
    passed = false;
  } else if (warnedCount > 0) {
    readiness = 'ready_with_warnings';
    exitCode = 0;
    passed = true;
  }

  const report: DoctorReport = {
    passed,
    readiness,
    exitCode,
    checks,
    benchmark,
    timestamp: new Date().toISOString(),
    version: OASIS_CURRENT_VERSION,
    fixApplied: fix,
    summary: {
      total: checks.length,
      passed: passedCount,
      warned: warnedCount,
      failed: failedCount,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!options.silent) {
    renderDoctorReport(report);
  }

  return report;
}
