import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isMaosInitialized, getConfigPath, getStatusDir, getPoolPath } from '../utils/paths';
import { getQueueCounts, getPendingTasks, getActiveTasks } from '../core/queue';
import { renderPanel, getBrandBadge, renderDivider, icons, padRight } from '../utils/ui';

export function runStatus(): void {
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  // Load config
  const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  const agents = config.agents || [];

  // Load pool state
  let pool: Record<string, boolean> = {};
  const poolPath = getPoolPath();
  if (fs.existsSync(poolPath)) {
    pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
  }

  // Load agent statuses
  const statusDir = getStatusDir();
  const getAgentStatus = (agentId: string): string => {
    const statusFile = path.join(statusDir, `${agentId}.status`);
    if (fs.existsSync(statusFile)) {
      return fs.readFileSync(statusFile, 'utf-8').trim();
    }
    return 'IDLE';
  };

  // Queue counts
  const counts = getQueueCounts();

  // Banner
  const bannerLines = [
    `${getBrandBadge('FLEET STATUS')} ${chalk.bold.hex('#F1F5F9')('Active Agent Grid')}`,
    `${chalk.gray('Real-time task allocations and workspace synchronization')}`,
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#10B981')));
  console.log('');

  // Agent table
  console.log(`  ${chalk.bold.hex('#94A3B8')('👥 Active Agents')}`);
  console.log(renderDivider(75));
  console.log(
    chalk.gray('  ') +
      chalk.bold.hex('#CBD5E1')(padRight('AGENT ID', 18)) +
      chalk.bold.hex('#CBD5E1')(padRight('ROLE', 12)) +
      chalk.bold.hex('#CBD5E1')(padRight('RUNTIME/MODEL', 24)) +
      chalk.bold.hex('#CBD5E1')(padRight('STATUS', 14)) +
      chalk.bold.hex('#CBD5E1')('POOL'),
  );
  console.log(renderDivider(75));

  for (const agent of agents) {
    const enabled = pool[agent.id] !== false;
    const status = getAgentStatus(agent.id);

    const statusColor =
      status === 'IDLE'
        ? chalk.bold.green
        : status.startsWith('BUSY')
          ? chalk.bold.yellow
          : status.startsWith('DONE')
            ? chalk.bold.cyan
            : chalk.bold.red;

    const poolIcon = enabled ? chalk.bold.green('● ON') : chalk.bold.red('○ OFF');
    const roleIcon =
      agent.role === 'planner'
        ? icons.planner
        : agent.role === 'coder'
          ? icons.coder
          : agent.role === 'designer'
            ? icons.designer
            : icons.general;

    // Build a runtime-aware label for heterogeneous metadata support
    let runtimeLabel = '';
    const runtimeType = (agent.runtime || 'api').toLowerCase();
    if (runtimeType === 'cli') {
      runtimeLabel = `${agent.cliCommand || 'cli'}-cli`;
    } else if (runtimeType === 'local') {
      runtimeLabel = `local/${agent.model || 'local'}`;
    } else {
      runtimeLabel = `${agent.provider || 'unknown'}/${agent.model || 'unknown'}`;
    }

    console.log(
      chalk.gray('  ') +
        `${roleIcon} ${padRight(chalk.bold.hex('#F1F5F9')(agent.id), 16)}` +
        padRight(chalk.hex('#E2E8F0')(agent.role), 12) +
        chalk.gray(padRight(runtimeLabel, 24)) +
        statusColor(padRight(status.substring(0, 12), 14)) +
        poolIcon,
    );
  }

  console.log(renderDivider(75));
  console.log('');

  // Queue summary
  console.log(`  ${chalk.bold.hex('#94A3B8')('📥 Task Queue Summary')}`);
  console.log(`    ${icons.pending} ${chalk.gray('Pending Tasks:')}  ${chalk.bold.yellow(String(counts.pending))}`);
  console.log(`    ${icons.active} ${chalk.gray('Active Tasks:')}   ${chalk.bold.cyan(String(counts.active))}`);
  console.log(`    ${icons.done} ${chalk.gray('Completed:')}      ${chalk.bold.green(String(counts.done))}`);
  console.log('');

  // Show pending tasks if any
  if (counts.pending > 0) {
    const pending = getPendingTasks();
    console.log(`  ${chalk.bold.yellow('⏳ Pending Queue Details')}`);
    for (const task of pending) {
      console.log(
        `    ${icons.arrow} ${chalk.bold.yellow(task.id)} ` +
          chalk.gray(`[${task.agent}] `) +
          chalk.white(task.description.split('\n')[0].substring(0, 60)),
      );
    }
    console.log('');
  }

  // Show active tasks if any
  if (counts.active > 0) {
    const active = getActiveTasks();
    console.log(`  ${chalk.bold.cyan('⚡ Active Operations')}`);
    for (const task of active) {
      console.log(
        `    ${icons.active} ${chalk.bold.cyan(task.id)} ` +
          chalk.gray(`[${task.agent}] `) +
          chalk.white(task.description.split('\n')[0].substring(0, 60)),
      );
    }
    console.log('');
  }
}
