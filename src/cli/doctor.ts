/**
 * MAOS Doctor — Environment & Connectivity Diagnostics
 *
 * Checks everything needed for healthy orchestration:
 *   1. Config file exists
 *   2. Provider credentials resolved (not placeholder)
 *   3. Provider connectivity (lightweight ping)
 *   4. CLI runtimes available in PATH
 *   5. Queue directory structure
 *   6. Git status
 *
 * Usage: maos doctor
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import chalk from 'chalk';
import { getConfigPath, getMaosRoot } from '../utils/paths';
import { RuntimeFactory, CredentialCheckResult } from '../backends/factory';
import { AgentRuntimeConfig } from '../backends/runtime';
import { ProviderConfig } from '../backends/provider';
import { engineHealth, getDefaultEnginePath, verifyExecutable } from '../industrial/rust-engine-bridge';
import { resolveProjectGitContext } from '../utils/project-git-context';

interface DiagnosticResult {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  readiness: 'ready' | 'ready_with_warnings' | 'not_ready';
  exitCode: 0 | 1;
  checks: DiagnosticResult[];
}

export async function runDoctor(projectRoot: string = process.cwd()): Promise<DoctorReport> {
  const cwd = path.resolve(projectRoot);
  const results: DiagnosticResult[] = [];

  console.log(chalk.bold.cyan('\n🩺 MAOS Doctor — Environment Diagnostics'));
  console.log(chalk.gray('─'.repeat(60)));

  // ── 0. Node.js Version Check ──
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  results.push({
    label: 'Node.js',
    status: nodeMajor >= 20 ? 'pass' : 'fail',
    required: true,
    detail: `v${nodeVersion} (requires >=20.0.0)`,
  });

  // ── 0b. Platform Check ──
  const platformLabel =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform;
  const hasCliAgents = (() => {
    try {
      const configPath = getConfigPath(cwd);
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return (cfg.agents || []).some((a: any) => a.runtime === 'cli');
      }
    } catch {
      /* ignore */
    }
    return false;
  })();
  if (hasCliAgents && process.platform !== 'win32') {
    results.push({
      label: 'Platform',
      status: 'warn',
      required: false,
      detail: `${platformLabel} — CLI runtimes (Copilot/Codex) require Windows. API runtimes work cross-platform.`,
    });
  } else {
    results.push({
      label: 'Platform',
      status: 'pass',
      required: false,
      detail: platformLabel,
    });
  }

  // ── 1. Config Check ──
  const configPath = getConfigPath(cwd);
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        typeof config.projectName !== 'string' || !Array.isArray(config.agents) ||
        !config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers) ||
        config.agents.some((agent: unknown) => !agent || typeof agent !== 'object' || Array.isArray(agent)) ||
        Object.values(config.providers).some((provider: unknown) => !provider || typeof provider !== 'object' || Array.isArray(provider))) {
      throw new Error('invalid config shape');
    }
  } catch (err: any) {
    const missing = err?.code === 'ENOENT';
    results.push({
      label: 'Config',
      status: 'fail',
      required: true,
      detail: missing
        ? `maos.config.json not found at ${configPath}. Run: maos init`
        : `maos.config.json is malformed, unreadable, or missing required fields at ${configPath}. Repair it or run: maos init`,
    });
    return finish(results);
  }

  const agents: AgentRuntimeConfig[] = config.agents || [];
  const providers: Record<string, ProviderConfig & { costPerMillionTokens?: number }> = config.providers || {};
  results.push({
    label: 'Config',
    status: 'pass',
    required: true,
    detail: `maos.config.json found (${agents.length} agents)`,
  });

  // ── 2. Credential Validation ──
  let credChecks: CredentialCheckResult[];
  try {
    credChecks = RuntimeFactory.validateCredentials(agents, providers);
  } catch {
    results.push({ label: 'Config', status: 'fail', required: true, detail: 'maos.config.json has invalid agent or provider entries.' });
    return finish(results);
  }
  for (const check of credChecks) {
    const detail = check.status === 'ok'
      ? `[${check.agentId}] Credential/runtime configuration resolved${check.source ? ` (${check.source})` : ''}`
      : `[${check.agentId}] ${safeCredentialMessage(check)}`;
    results.push({
      label: check.provider,
      status: check.status === 'ok' ? 'pass' : 'fail',
      required: true,
      detail,
    });
  }

  // Doctor reports configuration only; no model request is made as a side effect.
  results.push({ label: 'Connectivity', status: 'warn', required: false, detail: 'Not tested; doctor never sends inference requests.' });

  // ── 4. CLI Runtimes Available ──
  const cliAgents = agents.filter((a) => a.runtime === 'cli');
  const checkedClis = new Set<string>();
  if (cliAgents.length === 0) {
    results.push({ label: 'CLI runtimes', status: 'warn', required: false, detail: 'No optional CLI-agent runtimes are configured.' });
  }
  for (const agent of cliAgents) {
    const cli = agent.cliCommand;
    if (!cli || checkedClis.has(cli)) continue;
    checkedClis.add(cli);

    const found = isCommandAvailable(cli);
    results.push({
      label: `${cli}-cli`,
      status: found ? 'pass' : 'fail',
      required: true,
      detail: found ? `Found in PATH` : `Not found in PATH — install ${cli} or add it to PATH`,
    });
  }

  // ── 5. Directory Structure ──
  const maosRoot = getMaosRoot(cwd);
  const requiredDirs = ['queue/pending', 'queue/active', 'queue/done', 'queue/retry', 'queue/failed', 'status', 'logs'];
  let dirsOk = 0;
  let dirsMissing = 0;
  for (const dir of requiredDirs) {
    if (fs.existsSync(path.join(maosRoot, dir))) {
      dirsOk++;
    } else {
      dirsMissing++;
    }
  }

  results.push({
    label: 'Directories',
    status: dirsMissing === 0 ? 'pass' : 'warn',
    required: false,
    detail:
      dirsMissing === 0
        ? `All ${dirsOk} queue dirs exist`
        : `${dirsMissing}/${requiredDirs.length} dirs missing (run maos init)`,
  });

  if (config.profile?.id === 'industrial' || config.profile?.mode === 'sovereign-local') {
    const enginePath = getDefaultEnginePath(cwd);
    try {
      const manifest = verifyExecutable(enginePath);
      const response = engineHealth(manifest);
      const compatible = !('error' in response) &&
        response.operation === 'health' &&
        response.version === manifest.protocolVersion &&
        response.data.status === 'ok' &&
        response.data.engine === 'maos-industrial-engine' &&
        response.data.version === manifest.engineVersion &&
        response.data.protocol_version === manifest.protocolVersion &&
        response.data.unsafe_code === false;
      if (!compatible) throw new Error('identity or protocol mismatch');
      results.push({ label: 'Rust engine', status: 'pass', required: true, detail: `${manifest.engineVersion}, protocol ${manifest.protocolVersion}, SHA-256 ${manifest.executableHash}` });
    } catch (err: any) {
      const detail = err?.category === 'missing_binary'
        ? err.message
        : 'Rust engine identity/protocol check failed. Replace it with the platform-matched MAOS engine.';
      results.push({ label: 'Rust engine', status: 'fail', required: true, detail });
    }
  }

  // ── 6. Git Status ──
  const gitContext = resolveProjectGitContext(cwd);
  if (gitContext.kind === 'repository') {
    const { branch, changedFiles } = gitContext;
    results.push({
      label: 'Git',
      status: 'pass',
      required: false,
      detail: changedFiles === 0
        ? `Branch: ${branch} — clean working tree`
        : `Branch: ${branch} — ${changedFiles} file${changedFiles !== 1 ? 's' : ''} modified`,
    });
  } else {
    results.push({
      label: 'Git',
      status: 'warn',
      required: false,
      detail: gitContext.kind === 'none'
        ? 'No project repository'
        : 'Git status unavailable — verify Git is installed and the project root is accessible',
    });
  }

  return finish(results);
}

// ── Helpers ──

function printResults(results: DiagnosticResult[]): void {
  for (const r of results) {
    const icon = r.status === 'pass' ? chalk.green('✅') : r.status === 'warn' ? chalk.yellow('⚠️ ') : chalk.red('❌');
    const label = r.label.padEnd(18);
    console.log(`  ${icon} ${chalk.white(label)} ${chalk.gray(r.required ? '[required]' : '[optional]')} ${chalk.gray(r.detail)}`);
  }
}

function finish(results: DiagnosticResult[]): DoctorReport {
  printResults(results);
  const passes = results.filter((r) => r.status === 'pass').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const fails = results.filter((r) => r.required && r.status === 'fail').length;
  const readiness = fails > 0 ? 'not_ready' : warns > 0 ? 'ready_with_warnings' : 'ready';

  console.log(chalk.gray('─'.repeat(60)));
  console.log(
    `  ${chalk.green(passes + ' passed')}  ` +
      `${warns > 0 ? chalk.yellow(warns + ' optional warnings') + '  ' : ''}` +
      `${fails > 0 ? chalk.red(fails + ' required failures') : ''}`,
  );
  if (readiness === 'not_ready') {
    console.log(chalk.red('\n  ❌ Required setup is incomplete. Fix the failures above before running this project.'));
  } else if (readiness === 'ready_with_warnings') {
    console.log(chalk.yellow('\n  ⚠️  Required checks passed; optional capabilities are unavailable or untested.'));
  } else {
    console.log(chalk.green('\n  ✅ Required checks passed.'));
  }
  console.log('');
  return { readiness, exitCode: fails > 0 ? 1 : 0, checks: results };
}

function safeCredentialMessage(check: CredentialCheckResult): string {
  if (check.status === 'placeholder') return 'Configured credential is a placeholder; replace it before running.';
  if (check.message.includes('metaApiEnabled=true') || check.message.includes('apiKeyEnv')) return check.message;
  const envName = check.message.match(/environment variable ([A-Za-z_][A-Za-z0-9_]*) is (?:not set|empty)/i)?.[1];
  if (envName) return `Environment variable ${envName} is not set or is empty.`;
  if (check.message.includes('not found in config')) return 'Required provider is missing from maos.config.json.';
  return 'Required credential or runtime configuration is missing. Configure the provider or run maos configure.';
}

/**
 * Check if a command is available in PATH.
 * Uses where.exe on Windows, `which` on Unix.
 * Falls back to Get-Command on PowerShell if where.exe fails.
 */
function isCommandAvailable(command: string): boolean {
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // Try where.exe first (native Windows)
    try {
      child_process.execSync(`where.exe ${command}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return true;
    } catch {
      // where.exe failed — try Get-Command via pwsh
      try {
        child_process.execSync(`pwsh.exe -NoProfile -Command "Get-Command ${command} -ErrorAction Stop | Out-Null"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        });
        return true;
      } catch {
        return false;
      }
    }
  } else {
    // Unix: use which
    try {
      child_process.execSync(`which ${command}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return true;
    } catch {
      return false;
    }
  }
}
