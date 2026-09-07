import chalk from 'chalk';
import { isMaosInitialized, getConfigPath } from '../utils/paths';
import { startOrchestrator } from '../core/orchestrator';
import { getQueueCounts } from '../core/queue';
import { renderPanel, getBrandBadge, renderDivider, icons } from '../utils/ui';
import * as fs from 'fs';

export interface StartOptions {
  provider?: string;
  force?: boolean;
}

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

  // Print gorgeous banner
  const bannerLines = [
    `${getBrandBadge()} ${chalk.bold.hex('#F1F5F9')('Orchestrator Active')}`,
    `${chalk.gray('Watching queue')} ${icons.bullet} ${chalk.gray('Dispatching agents')} ${icons.bullet} ${chalk.gray('Building systems')}`,
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#6366F1')));

  console.log('');
  console.log(`  ${chalk.bold.hex('#94A3B8')('📁 Project:')}   ${chalk.bold.white(config.projectName)}`);
  console.log(
    `  ${chalk.bold.hex('#94A3B8')('👥 Fleet:')}     ` +
      config.agents
        .map((a: any) => {
          const icon =
            a.role === 'planner'
              ? icons.planner
              : a.role === 'coder'
                ? icons.coder
                : a.role === 'designer'
                  ? icons.designer
                  : icons.general;
          return `${icon} ${chalk.bold.hex('#F1F5F9')(a.id)} ${chalk.gray('(' + a.provider + '/' + a.model + ')')}`;
        })
        .join('  '),
  );

  if (options.provider) {
    console.log(`  ${chalk.bold.yellow('⚡ Override:')}  ${chalk.bold.yellow(`All agents → ${options.provider}`)}`);
  }

  console.log('');
  console.log(
    `  ${icons.pending} ${chalk.bold.cyan(String(counts.pending))} pending   ${icons.active} ${chalk.bold.yellow(String(counts.active))} active   ${icons.done} ${chalk.bold.green(String(counts.done))} done`,
  );
  console.log('');

  if (counts.pending === 0 && counts.active === 0) {
    console.log(`  ${icons.warning}  ${chalk.yellow('No tasks in the queue. Create one with:')}`);
    console.log(chalk.cyan('     maos task "Build a login page"'));
    console.log('');
    console.log(chalk.gray('  Orchestrator will watch for new tasks...'));
  }

  console.log(renderDivider(65));
  console.log(`  ${chalk.gray('Press')} ${chalk.bold.red('Ctrl+C')} ${chalk.gray('to stop the orchestrator safely')}`);
  console.log(renderDivider(65));
  console.log('');

  // Start the orchestrator
  try {
    await startOrchestrator({
      providerOverride: options.provider,
      force: options.force,
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
          `${icons.active} ${chalk.bold.yellow(`Active: ${active}`)}`,
          `${icons.done} ${chalk.bold.green(`Done: ${state.completedTasks}`)}`,
          `${icons.failed} ${chalk.bold.red(`Failed: ${state.failedTasks}`)}`,
          `${chalk.gray('Tokens:')} ${chalk.bold.cyan(state.totalTokensUsed)}`,
          `${chalk.gray('Cost:')} ${chalk.bold.hex('#10B981')(`$${state.totalCostUSD.toFixed(4)}`)}`,
        ].join(chalk.hex('#334155')(' │ '));

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
