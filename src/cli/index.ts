#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { runInit } from './init';
import { runTask, TaskOptions } from './task';
import { runStatus } from './status';
import { runStart, StartOptions } from './start';

const VERSION = '0.1.0';

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
  .action((goal: string) => {
    console.log(chalk.yellow('⏳ Planner not yet implemented — coming Day 4!'));
    console.log(chalk.gray(`Goal: "${goal}"`));
    console.log(chalk.gray('This will: use the ARCHITECT agent to decompose into tagged subtasks.'));
  });

// ─── maos pool ────────────────────────────────────────────────
program
  .command('pool')
  .description('Manage agent pool (enable/disable agents)')
  .option('--enable <agent>', 'Enable an agent')
  .option('--disable <agent>', 'Disable an agent')
  .action((options) => {
    console.log(chalk.yellow('⏳ Pool manager not yet implemented — coming Day 3!'));
  });

// Parse
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
