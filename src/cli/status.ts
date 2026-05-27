import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isMaosInitialized, getConfigPath, getStatusDir, getPoolPath } from '../utils/paths';
import { getQueueCounts, getPendingTasks, getActiveTasks, getDoneTasks } from '../core/queue';

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
  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('   M A O S — Fleet Status   ') + chalk.bold.cyan('       ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════╝'));
  console.log('');

  // Agent table
  console.log(chalk.bold('  Agents:'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────────'));
  console.log(
    chalk.gray('  ') +
    chalk.bold(padRight('ID', 16)) +
    chalk.bold(padRight('ROLE', 10)) +
    chalk.bold(padRight('RUNTIME/MODEL', 22)) +
    chalk.bold(padRight('STATUS', 12)) +
    chalk.bold('POOL')
  );
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────────'));

  for (const agent of agents) {
    const enabled = pool[agent.id] !== false;
    const status = getAgentStatus(agent.id);

    const statusColor = status === 'IDLE' ? chalk.green :
                        status.startsWith('BUSY') ? chalk.yellow :
                        status.startsWith('DONE') ? chalk.blue :
                        chalk.red;

    const poolIcon = enabled ? chalk.green('● ON') : chalk.red('● OFF');
    const roleIcon = agent.role === 'planner' ? '🧠' :
                     agent.role === 'coder' ? '⚙️' :
                     agent.role === 'designer' ? '🎨' : '📦';

    // Build a runtime-aware label for heterogeneous metadata support
    let runtimeLabel = '';
    const runtimeType = (agent.runtime || 'api').toLowerCase();
    if (runtimeType === 'cli') {
      runtimeLabel = `${agent.cliCommand || 'cli'}-cli/${agent.cliCommand || 'cli'}`;
    } else if (runtimeType === 'local') {
      runtimeLabel = `local/${agent.model || 'local'}`;
    } else {
      runtimeLabel = `${agent.provider || 'unknown'}/${agent.model || 'unknown'}`;
    }

    console.log(
      chalk.gray('  ') +
      `${roleIcon} ${padRight(agent.id, 14)}` +
      padRight(agent.role, 10) +
      chalk.gray(padRight(runtimeLabel, 22)) +
      statusColor(padRight(status.substring(0, 10), 12)) +
      poolIcon
    );
  }

  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────────'));
  console.log('');

  // Queue summary
  console.log(chalk.bold('  Queue:'));
  console.log(`    📥 Pending:  ${chalk.yellow(String(counts.pending))}`);
  console.log(`    ⚡ Active:   ${chalk.cyan(String(counts.active))}`);
  console.log(`    ✅ Done:     ${chalk.green(String(counts.done))}`);
  console.log('');

  // Show pending tasks if any
  if (counts.pending > 0) {
    const pending = getPendingTasks();
    console.log(chalk.bold('  Pending Tasks:'));
    for (const task of pending) {
      console.log(
        `    → ${chalk.bold(task.id)} ` +
        chalk.gray(`[${task.agent}] `) +
        chalk.white(task.description.substring(0, 60))
      );
    }
    console.log('');
  }

  // Show active tasks if any
  if (counts.active > 0) {
    const active = getActiveTasks();
    console.log(chalk.bold('  Active Tasks:'));
    for (const task of active) {
      console.log(
        `    ⚡ ${chalk.bold(task.id)} ` +
        chalk.cyan(`[${task.agent}] `) +
        chalk.white(task.description.substring(0, 60))
      );
    }
    console.log('');
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}
