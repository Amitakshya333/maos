import chalk from 'chalk';
import * as readline from 'readline';
import { isMaosInitialized } from '../utils/paths';
import { runStatus } from './status';
import { runBrain } from './brain';
import { runLogs, LogsOptions } from './logs';

/**
 * MAOS Interactive REPL Shell
 *
 * Launch with just `maos` (no subcommand) or `maos repl`.
 * Provides an interactive prompt for running MAOS commands
 * with live feedback and a persistent session.
 */

const BANNER = `
${chalk.bold.cyan('╔══════════════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold('🤖 M A O S')}  ${chalk.gray('— Interactive Shell')}            ${chalk.bold.cyan('║')}
${chalk.bold.cyan('║')}  ${chalk.gray('docker-compose for AI coding agents')}         ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════════════╝')}

  ${chalk.gray('Type')} ${chalk.cyan('help')} ${chalk.gray('for available commands.')}
  ${chalk.gray('Type')} ${chalk.cyan('exit')} ${chalk.gray('or press')} ${chalk.cyan('Ctrl+C')} ${chalk.gray('to quit.')}
`;

const HELP_TEXT = `
${chalk.bold('Available Commands:')}

  ${chalk.cyan('status')}              Show fleet status dashboard
  ${chalk.cyan('brain init')}          Scan codebase and generate brain
  ${chalk.cyan('brain status')}        Show brain freshness
  ${chalk.cyan('brain context')}       Preview agent context injection
  ${chalk.cyan('brain telemetry')}     Show telemetry analytics
  ${chalk.cyan('logs')}                Show recent orchestrator logs
  ${chalk.cyan('watch')}               Auto-refresh status every 3 seconds (Ctrl+C to stop)
  ${chalk.cyan('clear')}               Clear the terminal
  ${chalk.cyan('help')}                Show this help
  ${chalk.cyan('exit')}                Exit MAOS shell

  ${chalk.gray('For task management, use the full CLI:')}
  ${chalk.gray('  maos task "..." | maos plan "..." | maos start')}
`;

export function runRepl(): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  console.log(BANNER);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.cyan('maos> '),
    completer: (line: string) => {
      const commands = ['status', 'brain init', 'brain status', 'brain context', 'brain telemetry', 'logs', 'watch', 'clear', 'help', 'exit'];
      const hits = commands.filter(c => c.startsWith(line.trim()));
      return [hits.length ? hits : commands, line];
    },
  });

  rl.prompt();

  rl.on('line', async (input: string) => {
    const cmd = input.trim().toLowerCase();

    if (!cmd) {
      rl.prompt();
      return;
    }

    try {
      switch (cmd) {
        case 'status':
        case 's':
          runStatus();
          break;

        case 'brain init':
        case 'bi':
          runBrain('init');
          break;

        case 'brain status':
        case 'bs':
          runBrain('status');
          break;

        case 'brain context':
        case 'bc':
          runBrain('context');
          break;

        case 'brain telemetry':
        case 'bt':
        case 'telemetry':
        case 'stats':
          runBrain('telemetry');
          break;

        case 'logs':
        case 'l':
          runLogs({ lines: '20' } as LogsOptions);
          break;

        case 'watch':
        case 'w':
          await runWatch(rl);
          break;

        case 'clear':
        case 'cls':
          console.clear();
          break;

        case 'help':
        case 'h':
        case '?':
          console.log(HELP_TEXT);
          break;

        case 'exit':
        case 'quit':
        case 'q':
          console.log(chalk.gray('\n  👋 Goodbye!\n'));
          process.exit(0);
          break;

        default:
          console.log(chalk.yellow(`  Unknown command: ${cmd}`));
          console.log(chalk.gray(`  Type 'help' for available commands.`));
          break;
      }
    } catch (err: any) {
      console.error(chalk.red(`  Error: ${err.message}`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.gray('\n  👋 Goodbye!\n'));
    process.exit(0);
  });
}

/**
 * Watch mode — auto-refreshes status every 3 seconds.
 */
async function runWatch(rl: readline.Interface): Promise<void> {
  console.log(chalk.gray('  Watching status... Press Enter to stop.\n'));

  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      console.clear();
      console.log(chalk.gray(`  🔄 Auto-refresh (${new Date().toLocaleTimeString()}) — Press Enter to stop\n`));
      runStatus();
    }, 3000);

    // First immediate render
    runStatus();

    // Wait for any keypress to stop
    const onLine = () => {
      clearInterval(interval);
      rl.removeListener('line', onLine);
      console.log(chalk.gray('\n  Stopped watching.\n'));
      resolve();
    };
    rl.once('line', onLine);
  });
}
