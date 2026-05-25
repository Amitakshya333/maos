import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isMaosInitialized, getLogsDir } from '../utils/paths';

export interface LogsOptions {
  follow?: boolean;
  lines?: string;
  agent?: string;
}

/**
 * Show orchestrator logs or tail them in real-time.
 */
export function runLogs(options: LogsOptions): void {
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  const logsDir = getLogsDir();
  const logFile = path.join(logsDir, 'orchestrator.log');

  if (!fs.existsSync(logFile)) {
    console.log(chalk.yellow('📭 No logs yet. Start the orchestrator: maos start'));
    return;
  }

  const numLines = parseInt(options.lines || '50', 10);

  // Read the log file
  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n').filter(l => l.trim().length > 0);

  // Filter by agent if specified
  let lines = allLines;
  if (options.agent) {
    lines = lines.filter(l => l.includes(`[${options.agent}]`));
  }

  // Show last N lines
  const tail = lines.slice(-numLines);

  console.log('');
  console.log(chalk.bold.cyan('  MAOS Logs') + chalk.gray(` (last ${tail.length} of ${lines.length} lines)`));
  if (options.agent) {
    console.log(chalk.gray(`  Filtered: agent=${options.agent}`));
  }
  console.log(chalk.gray('  ─────────────────────────────────────────────────────'));
  console.log('');

  for (const line of tail) {
    // Colorize based on log level
    if (line.includes('[ERROR]')) {
      console.log(chalk.red(`  ${line}`));
    } else if (line.includes('[WARN]')) {
      console.log(chalk.yellow(`  ${line}`));
    } else if (line.includes('[SUCCESS]')) {
      console.log(chalk.green(`  ${line}`));
    } else if (line.includes('[DEBUG]')) {
      console.log(chalk.gray(`  ${line}`));
    } else {
      console.log(chalk.white(`  ${line}`));
    }
  }

  console.log('');

  // Follow mode
  if (options.follow) {
    console.log(chalk.gray('  📡 Following logs (Ctrl+C to stop)...'));
    console.log('');

    let lastSize = fs.statSync(logFile).size;

    const watcher = setInterval(() => {
      try {
        const currentSize = fs.statSync(logFile).size;
        if (currentSize > lastSize) {
          const fd = fs.openSync(logFile, 'r');
          const buffer = Buffer.alloc(currentSize - lastSize);
          fs.readSync(fd, buffer, 0, buffer.length, lastSize);
          fs.closeSync(fd);

          const newContent = buffer.toString('utf-8');
          const newLines = newContent.split('\n').filter(l => l.trim().length > 0);

          for (const line of newLines) {
            if (options.agent && !line.includes(`[${options.agent}]`)) continue;

            if (line.includes('[ERROR]')) {
              console.log(chalk.red(`  ${line}`));
            } else if (line.includes('[WARN]')) {
              console.log(chalk.yellow(`  ${line}`));
            } else if (line.includes('[SUCCESS]')) {
              console.log(chalk.green(`  ${line}`));
            } else {
              console.log(chalk.white(`  ${line}`));
            }
          }

          lastSize = currentSize;
        }
      } catch {
        // File might be temporarily locked
      }
    }, 500);

    process.on('SIGINT', () => {
      clearInterval(watcher);
      console.log(chalk.gray('\n  Stopped following logs.'));
      process.exit(0);
    });
  }
}
