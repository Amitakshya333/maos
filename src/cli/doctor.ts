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

interface DiagnosticResult {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(): Promise<void> {
  const cwd = process.cwd();
  const results: DiagnosticResult[] = [];

  console.log(chalk.bold.cyan('\n🩺 MAOS Doctor — Environment Diagnostics'));
  console.log(chalk.gray('─'.repeat(60)));

  // ── 0. Node.js Version Check ──
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  results.push({
    label: 'Node.js',
    status: nodeMajor >= 18 ? 'pass' : 'fail',
    detail: `v${nodeVersion} (requires >=18.0.0)`,
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
      detail: `${platformLabel} — CLI runtimes (Copilot/Codex) require Windows. API runtimes work cross-platform.`,
    });
  } else {
    results.push({
      label: 'Platform',
      status: 'pass',
      detail: platformLabel,
    });
  }

  // ── 1. Config Check ──
  const configPath = getConfigPath(cwd);
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const agentCount = config.agents?.length ?? 0;
      results.push({
        label: 'Config',
        status: 'pass',
        detail: `maos.config.json found (${agentCount} agents)`,
      });
    } catch (err: any) {
      results.push({
        label: 'Config',
        status: 'fail',
        detail: `maos.config.json exists but failed to parse: ${err.message}`,
      });
    }
  } else {
    results.push({
      label: 'Config',
      status: 'fail',
      detail: 'maos.config.json not found. Run: maos init',
    });
    // Can't continue without config
    printResults(results);
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const agents: AgentRuntimeConfig[] = config.agents || [];
  const providers: Record<string, ProviderConfig & { costPerMillionTokens?: number }> = config.providers || {};

  // ── 2. Credential Validation ──
  const credChecks = RuntimeFactory.validateCredentials(agents, providers);
  for (const check of credChecks) {
    let detail = `[${check.agentId}] ${check.message}`;
    if (check.status === 'placeholder' && check.source) {
      detail = `[${check.agentId}] API key loaded from ${check.source} is a placeholder`;
    } else if (check.status === 'ok' && check.source && check.source !== 'fallback') {
      const maskedPart = check.message.match(/\(([^)]+)\)/)?.[1] || 'resolved';
      detail = `[${check.agentId}] API key loaded from ${check.source} (${maskedPart})`;
    }
    results.push({
      label: check.provider,
      status: check.status === 'ok' ? 'pass' : check.status === 'placeholder' ? 'warn' : 'fail',
      detail,
    });
  }

  // ── 3. Provider Connectivity (API agents only) ──
  const apiProviders = new Set<string>();
  for (const agent of agents) {
    const rt = agent.runtime || 'api';
    if (rt === 'api' || rt === 'local') {
      const p = agent.provider || 'freemodel';
      // Only ping if credentials look OK
      const credCheck = credChecks.find((c) => c.agentId === agent.id);
      if (credCheck && credCheck.status === 'ok' && !apiProviders.has(p)) {
        apiProviders.add(p);
      }
    }
  }

  for (const providerName of apiProviders) {
    const result = await pingProvider(providerName, providers[providerName], config);
    results.push(result);
  }

  // ── 4. CLI Runtimes Available ──
  const cliAgents = agents.filter((a) => a.runtime === 'cli');
  const checkedClis = new Set<string>();
  for (const agent of cliAgents) {
    const cli = agent.cliCommand;
    if (!cli || checkedClis.has(cli)) continue;
    checkedClis.add(cli);

    const found = isCommandAvailable(cli);
    results.push({
      label: `${cli}-cli`,
      status: found ? 'pass' : 'warn',
      detail: found ? `Found in PATH` : `Not found in PATH — install or add to PATH`,
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
    detail:
      dirsMissing === 0
        ? `All ${dirsOk} queue dirs exist`
        : `${dirsMissing}/${requiredDirs.length} dirs missing (run maos init)`,
  });

  // ── 6. Git Status ──
  try {
    const isInsideWorkTree =
      child_process
        .execSync('git rev-parse --is-inside-work-tree', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        .trim() === 'true';

    if (isInsideWorkTree) {
      let branch = 'unknown';
      try {
        // Try symbolic-ref first to support newborn repositories (no commits)
        branch = child_process
          .execSync('git symbolic-ref --short HEAD', {
            cwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          .trim();
      } catch {
        try {
          branch = child_process
            .execSync('git rev-parse --abbrev-ref HEAD', {
              cwd,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            .trim();
        } catch {
          branch = 'main (no commits yet)';
        }
      }

      let gitStatus = 'clean';
      let changedFiles = 0;
      try {
        const statusOutput = child_process
          .execSync('git status --porcelain', {
            cwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          .trim();
        if (statusOutput) {
          changedFiles = statusOutput.split('\n').length;
          gitStatus = `${changedFiles} uncommitted changes`;
        }
      } catch {
        /* ignore */
      }

      // Uncommitted changes are normal during development — not a warning.
      // Only flag as warn if there is no git at all.
      results.push({
        label: 'Git',
        status: 'pass',
        detail:
          gitStatus === 'clean'
            ? `Branch: ${branch} — clean working tree`
            : `Branch: ${branch} — ${changedFiles} file${changedFiles !== 1 ? 's' : ''} modified`,
      });
    } else {
      results.push({
        label: 'Git',
        status: 'warn',
        detail: 'Not inside a git worktree',
      });
    }
  } catch {
    results.push({
      label: 'Git',
      status: 'warn',
      detail: 'Git not found — install git for branch isolation',
    });
  }

  // Print results
  printResults(results);

  // Summary
  const passes = results.filter((r) => r.status === 'pass').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const fails = results.filter((r) => r.status === 'fail').length;

  console.log(chalk.gray('─'.repeat(60)));
  console.log(
    `  ${chalk.green(passes + ' passed')}  ` +
      `${warns > 0 ? chalk.yellow(warns + ' warnings') + '  ' : ''}` +
      `${fails > 0 ? chalk.red(fails + ' failed') : ''}`,
  );

  if (fails > 0) {
    console.log(chalk.red('\n  ❌ Critical issues found. Fix them before running maos start.'));
  } else if (warns > 0) {
    console.log(
      chalk.yellow(
        '\n  ⚠️  ' + warns + ' warning' + (warns > 1 ? 's' : '') + '. Review above before running maos start.',
      ),
    );
  } else {
    console.log(chalk.green('\n  ✅ All checks passed. Ready to orchestrate!'));
  }
  console.log('');
}

// ── Helpers ──

function printResults(results: DiagnosticResult[]): void {
  for (const r of results) {
    const icon = r.status === 'pass' ? chalk.green('✅') : r.status === 'warn' ? chalk.yellow('⚠️ ') : chalk.red('❌');
    const label = r.label.padEnd(18);
    console.log(`  ${icon} ${chalk.white(label)} ${chalk.gray(r.detail)}`);
  }
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

/**
 * Lightweight ping to an API provider.
 * Sends a minimal completion request (max_tokens=1) to test connectivity.
 */
async function pingProvider(
  providerName: string,
  providerConfig: ProviderConfig & { costPerMillionTokens?: number },
  fullConfig: any,
): Promise<DiagnosticResult> {
  const label = providerName;

  try {
    // Find first agent using this provider to determine the model
    const agent = fullConfig.agents.find(
      (a: any) =>
        (a.provider || 'freemodel') === providerName && (!a.runtime || a.runtime === 'api' || a.runtime === 'local'),
    );
    const model = agent?.model || 'gpt-4o-mini';

    const { createProviderDirect } = await import('../backends/factory');
    const { resolveCredential } = require('../core/credentials');
    const resolved = resolveCredential(providerName, providerConfig.apiKey);
    const enrichedConfig = resolved ? { ...providerConfig, apiKey: resolved.key } : providerConfig;
    const provider = createProviderDirect(providerName, enrichedConfig, model);

    const startMs = Date.now();
    await provider.generate([{ role: 'user', content: 'Say OK' }]);
    const latencyMs = Date.now() - startMs;

    return {
      label,
      status: 'pass',
      detail: `Connected (${latencyMs}ms, ${model})`,
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    const lowerMsg = msg.toLowerCase();

    if (lowerMsg.includes('401') || lowerMsg.includes('authentication') || lowerMsg.includes('unauthorized')) {
      return { label, status: 'fail', detail: `API key invalid (provider rejected authentication)` };
    }
    if (lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound')) {
      return { label, status: 'fail', detail: `Cannot connect (provider unreachable): ${msg.substring(0, 80)}` };
    }

    return {
      label,
      status: 'warn',
      detail: `Ping failed: ${msg.substring(0, 80)}`,
    };
  }
}
