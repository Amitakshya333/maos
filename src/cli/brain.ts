import chalk from 'chalk';
import ora from 'ora';
import { isMaosInitialized } from '../utils/paths';
import { scanProject, saveBrain, loadBrain, getBrainContext } from '../core/brain';
import { summarizeTelemetry } from '../core/telemetry';

export interface BrainOptions {
  action?: string;
}

export function runBrain(action: string): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  switch (action) {
    case 'init':
    case 'scan':
      scanAndSave(cwd);
      break;
    case 'status':
      showBrainStatus(cwd);
      break;
    case 'context':
      showBrainContext(cwd);
      break;
    case 'telemetry':
    case 'stats':
      showTelemetry(cwd);
      break;
    default:
      console.log(chalk.yellow(`Unknown brain action: ${action}`));
      console.log(chalk.gray('Available: init, status, context, telemetry'));
      break;
  }
}

function scanAndSave(cwd: string): void {
  const spinner = ora('Scanning codebase...').start();

  try {
    const brain = scanProject(cwd);
    saveBrain(cwd, brain);
    spinner.succeed('Codebase scanned');

    console.log('');
    console.log(chalk.bold('  🧠 MAOS Brain — Codebase Analysis'));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(`  📁 Files:     ${chalk.cyan(brain.totalFiles.toString())}`);
    console.log(`  💾 Size:      ${chalk.cyan(formatBytes(brain.totalSize))}`);
    console.log('');

    // Language breakdown
    console.log(chalk.bold('  Languages:'));
    const sortedLangs = Object.entries(brain.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [lang, count] of sortedLangs) {
      const pct = ((count / brain.totalFiles) * 100).toFixed(0);
      const bar = '█'.repeat(Math.max(1, Math.round(parseInt(pct) / 5)));
      console.log(`    ${chalk.green(bar)} ${lang} (${count} files, ${pct}%)`);
    }

    console.log('');
    console.log(chalk.gray('  Saved to: .maos/brain/'));
    console.log(chalk.gray('    → file-map.json'));
    console.log(chalk.gray('    → architecture.md'));
    console.log('');
  } catch (err: any) {
    spinner.fail(`Scan failed: ${err.message}`);
    process.exit(1);
  }
}

function showBrainStatus(cwd: string): void {
  const brain = loadBrain(cwd);

  if (!brain) {
    console.log(chalk.yellow('⚠️  No brain data found. Run `maos brain init` first.'));
    return;
  }

  const generatedAt = new Date(brain.generatedAt);
  const age = Date.now() - generatedAt.getTime();
  const ageStr = age < 3600000
    ? `${Math.round(age / 60000)} minutes ago`
    : age < 86400000
      ? `${Math.round(age / 3600000)} hours ago`
      : `${Math.round(age / 86400000)} days ago`;

  const isStale = age > 86400000; // > 1 day

  console.log('');
  console.log(chalk.bold('  🧠 MAOS Brain Status'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log(`  📅 Generated: ${chalk.cyan(generatedAt.toLocaleString())} (${isStale ? chalk.red(ageStr) : chalk.green(ageStr)})`);
  console.log(`  📁 Files:     ${chalk.cyan(brain.totalFiles.toString())}`);
  console.log(`  💾 Size:      ${chalk.cyan(formatBytes(brain.totalSize))}`);
  console.log(`  🔤 Languages: ${chalk.cyan(Object.keys(brain.languages).length.toString())}`);
  console.log(`  📂 Dirs:      ${chalk.cyan(Object.keys(brain.structure).length.toString())}`);

  if (isStale) {
    console.log('');
    console.log(chalk.yellow('  ⚠️  Brain data is stale. Run `maos brain init` to refresh.'));
  }
  console.log('');
}

function showBrainContext(cwd: string): void {
  const context = getBrainContext(cwd);

  if (!context) {
    console.log(chalk.yellow('⚠️  No brain data found. Run `maos brain init` first.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  🧠 Agent Context Injection Preview'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log(chalk.gray('  This is what gets injected into agent system prompts:'));
  console.log('');
  console.log(chalk.dim(context));
  console.log('');
}

function showTelemetry(cwd: string): void {
  const summary = summarizeTelemetry(cwd);

  if (summary.totalRuns === 0) {
    console.log(chalk.yellow('⚠️  No telemetry data yet. Run some tasks first.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  📊 MAOS Telemetry Dashboard'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log(`  Total Runs:    ${chalk.cyan(summary.totalRuns.toString())}`);
  console.log(`  Success Rate:  ${colorRate(summary.successRate)}`);
  console.log(`  Total Tokens:  ${chalk.cyan(summary.totalTokens.toLocaleString())}`);
  console.log(`  Total Cost:    ${chalk.yellow('$' + summary.totalCostUSD.toFixed(4))}`);
  console.log(`  Avg Latency:   ${chalk.cyan((summary.avgLatencyMs / 1000).toFixed(1) + 's')}`);
  console.log(`  Avg Iterations: ${chalk.cyan(summary.avgIterations.toFixed(1))}`);
  console.log('');

  // By agent
  if (Object.keys(summary.byAgent).length > 0) {
    console.log(chalk.bold('  By Agent:'));
    for (const [agentId, stats] of Object.entries(summary.byAgent)) {
      console.log(`    ${chalk.bold(agentId)}: ${stats.runs} runs, ${colorRate(stats.successRate)}, avg $${stats.avgCost.toFixed(4)}, ${(stats.avgLatency / 1000).toFixed(1)}s`);
    }
    console.log('');
  }

  // By provider
  if (Object.keys(summary.byProvider).length > 0) {
    console.log(chalk.bold('  By Provider:'));
    for (const [prov, stats] of Object.entries(summary.byProvider)) {
      console.log(`    ${chalk.bold(prov)}: ${stats.runs} runs, ${colorRate(stats.successRate)}, $${stats.totalCost.toFixed(4)} total`);
    }
    console.log('');
  }

  // Top capabilities
  if (summary.topCapabilities.length > 0) {
    console.log(chalk.bold('  Top Capabilities:'));
    for (const cap of summary.topCapabilities) {
      console.log(`    ${chalk.cyan(cap.capability)}: ${cap.count} tasks, ${colorRate(cap.successRate)}`);
    }
    console.log('');
  }
}

function colorRate(rate: number): string {
  const pct = (rate * 100).toFixed(0) + '%';
  if (rate >= 0.8) return chalk.green(pct);
  if (rate >= 0.5) return chalk.yellow(pct);
  return chalk.red(pct);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
