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

export interface PoolOptions {
  enable?: string;
  disable?: string;
  all?: boolean;
  off?: boolean;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
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
      console.log(chalk.green('✅ All agents enabled'));
      return;
    }
    const agentId = options.enable.toUpperCase();
    const result = enableAgent(agentId);
    if (result) {
      console.log(chalk.green(`✅ ${agentId} enabled`));
    } else {
      console.log(chalk.red(`❌ Agent "${agentId}" not found in config`));
    }
    return;
  }

  if (options.disable) {
    if (options.disable === 'all') {
      disableAll();
      console.log(chalk.yellow('⏸️ All agents disabled'));
      return;
    }
    const agentId = options.disable.toUpperCase();
    const result = disableAgent(agentId);
    if (result) {
      console.log(chalk.yellow(`⏸️ ${agentId} disabled`));
    } else {
      console.log(chalk.red(`❌ Agent "${agentId}" not found in config`));
    }
    return;
  }

  // Default: show pool dashboard
  const agents = getPoolDashboard();
  const enabledCount = getEnabledCount();

  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('   M A O S — Agent Pool   ') + chalk.bold.cyan('            ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════╝'));
  console.log('');

  // Table header
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log(
    chalk.gray('  ') +
    chalk.bold(padRight('AGENT', 16)) +
    chalk.bold(padRight('ROLE', 10)) +
    chalk.bold(padRight('MODEL', 22)) +
    chalk.bold(padRight('STATUS', 14)) +
    chalk.bold('POOL')
  );
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));

  for (const agent of agents) {
    const roleIcon = agent.role === 'planner' ? '🧠' :
                     agent.role === 'coder' ? '⚙️' :
                     agent.role === 'designer' ? '🎨' :
                     agent.role === 'tester' ? '🧪' : '📦';

    const statusColor = agent.status === 'IDLE' ? chalk.green :
                        agent.status.startsWith('BUSY') ? chalk.yellow :
                        agent.status.startsWith('DONE') ? chalk.blue :
                        agent.status.startsWith('FAILED') ? chalk.red :
                        chalk.gray;

    const poolIcon = agent.enabled
      ? chalk.green.bold('● ON ')
      : chalk.red.bold('● OFF');

    const modelStr = `${agent.provider}/${agent.model}`;

    console.log(
      chalk.gray('  ') +
      `${roleIcon} ${padRight(agent.id, 14)}` +
      padRight(agent.role, 10) +
      chalk.gray(padRight(modelStr, 22)) +
      statusColor(padRight(agent.status.substring(0, 12), 14)) +
      poolIcon
    );

    // Show capabilities on a sub-line
    if (agent.capabilities.length > 0) {
      console.log(
        chalk.gray('     └─ ') +
        chalk.gray(agent.capabilities.join(', '))
      );
    }
  }

  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(`  ${chalk.bold('Fleet:')} ${chalk.green(String(enabledCount))} enabled / ${chalk.gray(String(agents.length))} total`);
  console.log('');

  // Usage hints
  console.log(chalk.gray('  Commands:'));
  console.log(chalk.gray('    maos pool --enable BACKEND_DEV   Enable an agent'));
  console.log(chalk.gray('    maos pool --disable FRONTEND_DEV Disable an agent'));
  console.log(chalk.gray('    maos pool --enable all           Enable all agents'));
  console.log(chalk.gray('    maos pool --disable all          Disable all agents'));
  console.log('');
}
