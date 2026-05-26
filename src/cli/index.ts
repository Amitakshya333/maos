#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { runInit } from './init';
import { runTask, TaskOptions } from './task';
import { runStatus } from './status';
import { runStart, StartOptions } from './start';
import { runPool, PoolOptions } from './pool';
import { runPlan, PlanOptions } from './plan';
import { runLogs, LogsOptions } from './logs';
import { runLogin, LoginOptions } from './login';
import { runBrain } from './brain';
import { runRepl } from './repl';
import { runDashboard } from './dashboard';

const VERSION = '0.1.0';

// ─── Global Error Handlers ───────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error(chalk.red(`\n❌ Unexpected error: ${err.message}`));
  if (process.env.MAOS_DEBUG) {
    console.error(chalk.gray(err.stack || ''));
  }
  console.error(chalk.gray('Set MAOS_DEBUG=1 for full stack trace'));
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  console.error(chalk.red(`\n❌ Unhandled promise rejection: ${reason?.message || reason}`));
  if (process.env.MAOS_DEBUG) {
    console.error(chalk.gray(reason?.stack || ''));
  }
  process.exit(1);
});

const program = new Command();

program
  .name('maos')
  .version(VERSION)
  .description(
    chalk.bold('MAOS') +
    chalk.gray(' — Multi-Agent Orchestrator System\n') +
    chalk.gray('docker-compose for AI coding agents')
  );

// ─── maos init ────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize MAOS in the current directory')
  .action(async () => {
    try {
      await runInit();
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos task ────────────────────────────────────────────────
program
  .command('task <description>')
  .description('Create a new task in the queue')
  .option('-a, --agent <agent>', 'Target agent ID (default: AUTO for router)')
  .option('-b, --branch <branch>', 'Git branch name')
  .option('-c, --capabilities <caps>', 'Comma-separated capabilities (e.g., coding,apis)')
  .option('--complexity <level>', 'Task complexity: low, medium, high', 'medium')
  .option('--category <cat>', 'Task category for routing')
  .action((description: string, options: TaskOptions) => {
    runTask(description, options);
  });

// ─── maos status ──────────────────────────────────────────────
program
  .command('status')
  .description('Show fleet status dashboard')
  .action(() => {
    runStatus();
  });

// ─── maos start ───────────────────────────────────────────────
program
  .command('start')
  .description('Start the orchestrator loop')
  .option('-p, --provider <provider>', 'Override default provider for all agents')
  .action(async (options: StartOptions) => {
    try {
      await runStart(options);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos plan ────────────────────────────────────────────────
program
  .command('plan <goal>')
  .description('Decompose a goal into subtasks using AI')
  .option('-p, --provider <provider>', 'Provider to use for decomposition')
  .option('-y, --yes', 'Auto-confirm and queue all tasks without prompting')
  .action(async (goal: string, options: PlanOptions) => {
    try {
      await runPlan(goal, options);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos pool ────────────────────────────────────────────────
program
  .command('pool')
  .description('Manage agent pool (enable/disable agents)')
  .option('--enable <agent>', 'Enable an agent (or "all")')
  .option('--disable <agent>', 'Disable an agent (or "all")')
  .action((options: PoolOptions) => {
    runPool(options);
  });

// ─── maos logs ────────────────────────────────────────────────
program
  .command('logs')
  .description('View orchestrator logs')
  .option('-f, --follow', 'Follow log output in real-time')
  .option('-n, --lines <count>', 'Number of lines to show (default: 50)', '50')
  .option('-a, --agent <agent>', 'Filter logs by agent ID')
  .action((options: LogsOptions) => {
    runLogs(options);
  });

// ─── maos login ───────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate a CLI agent (copilot, codex, claude)')
  .option('-a, --agent <agent>', 'Agent ID to authenticate')
  .option('-c, --cli <cli>', 'CLI to authenticate with (copilot, codex, claude)')
  .action(async (options: LoginOptions) => {
    try {
      await runLogin(options);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos brain ───────────────────────────────────────────────
program
  .command('brain <action>')
  .description('Codebase scanner & telemetry (actions: init, status, context, telemetry)')
  .action((action: string) => {
    runBrain(action);
  });

// ─── maos dashboard ─────────────────────────────────────────
program
  .command('dashboard')
  .alias('dash')
  .description('Launch web dashboard at http://localhost:3847')
  .action(() => {
    runDashboard();
  });

// ─── maos clean ───────────────────────────────────────────────
program
  .command('clean')
  .description('Clear queue and reset agent statuses')
  .action(() => {
    const maosDir = path.join(process.cwd(), '.maos');
    if (!fs.existsSync(maosDir)) {
      console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
      process.exit(1);
    }

    // Clear queue directories
    const queueDirs = ['pending', 'active', 'done'];
    let cleared = 0;
    for (const dir of queueDirs) {
      const dirPath = path.join(maosDir, 'queue', dir);
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
        for (const file of files) {
          fs.unlinkSync(path.join(dirPath, file));
          cleared++;
        }
      }
    }

    // Clear status files
    const statusDir = path.join(maosDir, 'status');
    if (fs.existsSync(statusDir)) {
      const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.status'));
      for (const file of files) {
        fs.unlinkSync(path.join(statusDir, file));
      }
    }

    // Clear logs
    const logFile = path.join(maosDir, 'logs', 'orchestrator.log');
    if (fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf-8');
    }

    console.log(chalk.green(`✅ Cleaned: ${cleared} tasks removed, statuses reset, logs cleared.`));
  });

// Parse
program.parse(process.argv);

// Launch interactive REPL if no command provided
if (!process.argv.slice(2).length) {
  runRepl();
}

