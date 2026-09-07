import chalk from 'chalk';
import { isMaosInitialized } from '../utils/paths';
import {
  enableAgent,
  disableAgent,
  enableAll,
  disableAll,
  getPoolDashboard,
  getEnabledCount,
} from '../core/pool-manager';
import { renderPanel, getBrandBadge, renderDivider, icons, padRight } from '../utils/ui';

export interface PoolOptions {
  enable?: string;
  disable?: string;
  all?: boolean;
  off?: boolean;
}

export function runPool(options: PoolOptions): void {
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  // Handle enable/disable operations
  if (options.enable) {
    if (options.enable === 'all') {
      enableAll();
      console.log(`  ${icons.done} ${chalk.bold.green('All agents enabled in the active pool')}`);
      return;
    }
    const agentId = options.enable.toUpperCase();
    const result = enableAgent(agentId);
    if (result) {
      console.log(`  ${icons.done} ${chalk.bold.green(`${agentId} successfully enabled`)}`);
    } else {
      console.log(`  ${icons.error} ${chalk.bold.red(`Agent "${agentId}" not found in config`)}`);
    }
    return;
  }

  if (options.disable) {
    if (options.disable === 'all') {
      disableAll();
      console.log(`  ${icons.active} ${chalk.bold.yellow('All agents disabled (paused in pool)')}`);
      return;
    }
    const agentId = options.disable.toUpperCase();
    const result = disableAgent(agentId);
    if (result) {
      console.log(`  ${icons.active} ${chalk.bold.yellow(`${agentId} successfully disabled`)}`);
    } else {
      console.log(`  ${icons.error} ${chalk.bold.red(`Agent "${agentId}" not found in config`)}`);
    }
    return;
  }

  // Default: show pool dashboard
  const agents = getPoolDashboard();
  const enabledCount = getEnabledCount();

  // Banner
  const bannerLines = [
    `${getBrandBadge('AGENT POOL')} ${chalk.bold.hex('#F1F5F9')('Concurrency Controllers')}`,
    `${chalk.gray('Activate or pause specific agent processes in real-time')}`,
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#EC4899')));
  console.log('');

  // Table header
  console.log(`  ${chalk.bold.hex('#94A3B8')('🎯 Fleet Pool Allocations')}`);
  console.log(renderDivider(75));
  console.log(
    chalk.gray('  ') +
      chalk.bold.hex('#CBD5E1')(padRight('AGENT ID', 18)) +
      chalk.bold.hex('#CBD5E1')(padRight('ROLE', 12)) +
      chalk.bold.hex('#CBD5E1')(padRight('MODEL', 24)) +
      chalk.bold.hex('#CBD5E1')(padRight('STATUS', 14)) +
      chalk.bold.hex('#CBD5E1')('POOL'),
  );
  console.log(renderDivider(75));

  for (const agent of agents) {
    const roleIcon =
      agent.role === 'planner'
        ? icons.planner
        : agent.role === 'coder'
          ? icons.coder
          : agent.role === 'designer'
            ? icons.designer
            : agent.role === 'tester'
              ? icons.tester
              : icons.general;

    const statusColor =
      agent.status === 'IDLE'
        ? chalk.bold.green
        : agent.status.startsWith('BUSY')
          ? chalk.bold.yellow
          : agent.status.startsWith('DONE')
            ? chalk.bold.cyan
            : agent.status.startsWith('FAILED')
              ? chalk.bold.red
              : chalk.bold.gray;

    const poolIcon = agent.enabled ? chalk.bold.green('● ON ') : chalk.bold.red('○ OFF');

    const modelStr = `${agent.provider}/${agent.model}`;

    console.log(
      chalk.gray('  ') +
        `${roleIcon} ${padRight(chalk.bold.hex('#F1F5F9')(agent.id), 16)}` +
        padRight(chalk.hex('#E2E8F0')(agent.role), 12) +
        chalk.gray(padRight(modelStr, 24)) +
        statusColor(padRight(agent.status.substring(0, 12), 14)) +
        poolIcon,
    );

    // Show capabilities on a sub-line
    if (agent.capabilities.length > 0) {
      console.log(chalk.gray('     └─ ') + chalk.gray(agent.capabilities.join(', ')));
    }
  }

  console.log(renderDivider(75));
  console.log('');
  console.log(
    `  ${chalk.bold('Fleet Power:')} ${chalk.bold.green(String(enabledCount))} active / ${chalk.bold.gray(String(agents.length))} total`,
  );
  console.log('');

  // Usage hints
  console.log(`  ${chalk.bold.hex('#94A3B8')('💡 Control Commands:')}`);
  console.log(`    ${chalk.cyan('maos pool --enable  BACKEND_DEV')}   Enable a specific agent`);
  console.log(`    ${chalk.cyan('maos pool --disable FRONTEND_DEV')}  Disable/pause an agent`);
  console.log(`    ${chalk.cyan('maos pool --enable  all')}           Enable all agents`);
  console.log(`    ${chalk.cyan('maos pool --disable all')}          Disable all agents`);
  console.log('');
}
