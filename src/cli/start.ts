import chalk from 'chalk';
import { isMaosInitialized, getConfigPath } from '../utils/paths';
import { startOrchestrator } from '../core/orchestrator';
import { getQueueCounts } from '../core/queue';
import * as fs from 'fs';

export interface StartOptions {
  provider?: string;
}

const BANNER = `
${chalk.bold.cyan('╔══════════════════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold.white('M A O S')}  ${chalk.gray('— Orchestrator Active')}               ${chalk.bold.cyan('║')}
${chalk.bold.cyan('║')}  ${chalk.gray('Watching queue • Dispatching agents • Building')}   ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════════════════╝')}
`;

export async function runStart(options: StartOptions): Promise<void> {
  // Pre-flight checks
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  // Load config for display
  const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  const counts = getQueueCounts();

  console.log(BANNER);
  console.log(chalk.bold('  Project: ') + chalk.white(config.projectName));
  console.log(chalk.bold('  Agents:  ') + config.agents.map((a: any) => {
    const icon = a.role === 'planner' ? '🧠' : a.role === 'coder' ? '⚙️' : '🎨';
    return `${icon} ${chalk.bold(a.id)} (${chalk.gray(a.provider + '/' + a.model)})`;
  }).join('  '));

  if (options.provider) {
    console.log(chalk.bold('  Override:') + chalk.yellow(` All agents → ${options.provider}`));
  }

  console.log('');
  console.log(chalk.gray(`  📥 ${counts.pending} pending  ⚡ ${counts.active} active  ✅ ${counts.done} done`));
  console.log('');

  if (counts.pending === 0 && counts.active === 0) {
    console.log(chalk.yellow('  ⚠️  No tasks in the queue. Create one with:'));
    console.log(chalk.cyan('     maos task "Build a login page"'));
    console.log('');
    console.log(chalk.gray('  Orchestrator will watch for new tasks...'));
  }

  console.log(chalk.gray('  ─────────────────────────────────────────────'));
  console.log(chalk.gray('  Press Ctrl+C to stop'));
  console.log(chalk.gray('  ─────────────────────────────────────────────'));
  console.log('');

  // Start the orchestrator
  try {
    await startOrchestrator({
      providerOverride: options.provider,
      pollIntervalMs: 3000,
      cwd: process.cwd(),
      onStatusUpdate: (state) => {
        const active = state.activeAgents.size;
        const agents = Array.from(state.activeAgents.entries())
          .map(([id, info]) => `${id}:${info.taskId}`)
          .join(', ');

        // Live heartbeat line
        const now = new Date().toLocaleTimeString();
        const line = [
          chalk.gray(`[${now}]`),
          chalk.cyan(`Active: ${active}`),
          chalk.green(`Done: ${state.completedTasks}`),
          chalk.red(`Failed: ${state.failedTasks}`),
          chalk.gray(`Tokens: ${state.totalTokensUsed}`),
          chalk.yellow(`$${state.totalCostUSD.toFixed(4)}`),
        ].join(chalk.gray(' │ '));

        console.log(`  ${line}`);
        if (agents) {
          console.log(chalk.gray(`    └─ ${agents}`));
        }
      },
    });
  } catch (err: any) {
    console.error(chalk.red(`\n❌ Orchestrator error: ${err.message}`));
    process.exit(1);
  }
}
