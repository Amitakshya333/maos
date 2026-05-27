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
import { EventStore } from '../core/event-store';
import { getRetryQueueStatus, getDeadLetterQueue } from '../core/retry-queue';
import { MemoryStore } from '../core/context-memory';

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

// ─── maos replay ─────────────────────────────────────────────
program
  .command('replay [taskId]')
  .description('Show event timeline for a task (or list recent events)')
  .option('--agent <agentId>', 'Filter by agent ID')
  .option('--type <type>', 'Filter by event type')
  .option('-n, --limit <n>', 'Max events to show', '50')
  .option('--stats', 'Show event store statistics')
  .action((taskId: string | undefined, opts: any) => {
    const cwd = process.cwd();
    const maosDir = path.join(cwd, '.maos');

    if (!fs.existsSync(maosDir)) {
      console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
      process.exit(1);
    }

    const store = new EventStore(cwd);

    if (opts.stats) {
      const s = store.stats();
      console.log(chalk.bold.cyan('\n📊 Event Store Statistics'));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`  Total events   : ${chalk.white(s.totalEvents)}`);
      console.log(`  File size      : ${chalk.white((s.fileSize / 1024).toFixed(1) + ' KB')}`);
      if (s.oldestEvent) console.log(`  Oldest event   : ${chalk.gray(s.oldestEvent)}`);
      if (s.newestEvent) console.log(`  Newest event   : ${chalk.gray(s.newestEvent)}`);
      console.log(chalk.bold('\n  Events by type:'));
      for (const [type, count] of Object.entries(s.eventsByType).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${chalk.cyan(type.padEnd(25))} ${chalk.white(count)}`);
      }
      return;
    }

    if (taskId) {
      // Full task replay
      const timeline = store.getTaskTimeline(taskId);
      if (timeline.length === 0) {
        console.log(chalk.yellow(`\n⚠️  No events found for task: ${taskId}`));
        return;
      }

      console.log(chalk.bold.cyan(`\n🔁 Event Timeline: ${taskId}`));
      console.log(chalk.gray('─'.repeat(70)));
      console.log(chalk.gray(`${'SEQ'.padEnd(6)} ${'TIME'.padEnd(26)} ${'TYPE'.padEnd(22)} ${'AGENT'.padEnd(15)} NOTE`));
      console.log(chalk.gray('─'.repeat(70)));

      for (const evt of timeline) {
        const time = new Date(evt.time).toLocaleTimeString();
        const seqStr = String(evt.seq).padEnd(6);
        const typeColor = evt.type.includes('FAIL') || evt.type.includes('ERROR')
          ? chalk.red(evt.type.padEnd(22))
          : evt.type.includes('COMPLETE') || evt.type.includes('DONE')
          ? chalk.green(evt.type.padEnd(22))
          : chalk.cyan(evt.type.padEnd(22));

        console.log(
          `${chalk.gray(seqStr)} ${chalk.gray(time.padEnd(26))} ${typeColor} ` +
          `${chalk.yellow(evt.agentId.padEnd(15))} ${chalk.gray(evt.note.substring(0, 40))}`
        );
      }
      console.log(chalk.gray('─'.repeat(70)));
      console.log(chalk.gray(`  ${timeline.length} events`));
    } else {
      // Show recent events
      const limit = parseInt(opts.limit, 10) || 50;
      const events = store.query({
        agentId: opts.agent,
        type: opts.type,
        limit,
      });

      if (events.length === 0) {
        console.log(chalk.yellow('\n⚠️  No events found.'));
        return;
      }

      console.log(chalk.bold.cyan(`\n📜 Recent Events (${events.length})`));
      console.log(chalk.gray('─'.repeat(70)));

      for (const evt of events) {
        const time = new Date(evt.timestamp).toLocaleTimeString();
        const typeColor = evt.type.includes('FAIL') ? chalk.red(evt.type) : chalk.cyan(evt.type);
        const task = evt.taskId ? chalk.gray(` [${evt.taskId.substring(0, 20)}]`) : '';
        console.log(`  ${chalk.gray(String(evt.seq).padEnd(5))} ${chalk.gray(time)} ${typeColor}${task} ${chalk.yellow(evt.agentId)}`);
      }
    }
  });

// ─── maos queue ──────────────────────────────────────────────
program
  .command('queue')
  .description('Show retry queue and dead-letter queue status')
  .action(() => {
    const cwd = process.cwd();
    const retrying = getRetryQueueStatus(cwd);
    const dead = getDeadLetterQueue(cwd);

    console.log(chalk.bold.cyan('\n🔄 Retry Queue'));
    if (retrying.length === 0) {
      console.log(chalk.gray('  (empty)'));
    } else {
      for (const r of retrying) {
        const readySecs = Math.round(r.readyInMs / 1000);
        const status = r.readyInMs === 0
          ? chalk.green('READY')
          : chalk.yellow(`in ${readySecs}s`);
        console.log(
          `  ${chalk.white(r.taskId.substring(0, 30).padEnd(30))} ` +
          `attempt ${r.attemptNumber}/${r.maxRetries} ` +
          `[${chalk.red(r.lastErrorType)}] ` +
          status
        );
      }
    }

    console.log(chalk.bold.red('\n💀 Dead Letter Queue'));
    if (dead.length === 0) {
      console.log(chalk.gray('  (empty)'));
    } else {
      for (const d of dead) {
        console.log(`  ${chalk.red('✗')} ${chalk.gray(d.taskId)}`);
      }
    }
  });

// ─── maos memory ─────────────────────────────────────────────
// Inter-agent knowledge transfer store
program
  .command('memory')
  .alias('mem')
  .description('View and manage shared agent memory')
  .option('--list', 'List all live memory entries')
  .option('--search <query>', 'Search memory by content')
  .option('--tag <tag>', 'Search memory by tag')
  .option('--stats', 'Show memory statistics')
  .option('--clear', 'Clear all memories (archive current session)')
  .action((opts: any) => {
    const cwd = process.cwd();
    const maosDir = path.join(cwd, '.maos');

    if (!fs.existsSync(maosDir)) {
      console.log(chalk.red('\u274C MAOS is not initialized in this directory.'));
      process.exit(1);
    }

    const store = new MemoryStore(cwd);

    if (opts.clear) {
      store.clear();
      console.log(chalk.green('\u2705 Memory cleared (previous session archived).'));
      return;
    }

    if (opts.stats) {
      const s = store.getStats();
      console.log(chalk.bold.cyan('\n\uD83E\uDDE0 Context Memory Statistics'));
      console.log(chalk.gray('\u2500'.repeat(40)));
      console.log('  Total entries  : ' + chalk.white(s.total));
      console.log('  Live entries   : ' + chalk.green(s.live));
      console.log('  Expired        : ' + chalk.yellow(s.expired));
      console.log(chalk.bold('\n  By type:'));
      for (const [type, count] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
        console.log('    ' + chalk.cyan(type.padEnd(15)) + ' ' + chalk.white(count));
      }
      console.log(chalk.bold('\n  By agent:'));
      for (const [agent, count] of Object.entries(s.byAgent).sort((a, b) => b[1] - a[1])) {
        console.log('    ' + chalk.yellow(agent.padEnd(15)) + ' ' + chalk.white(count));
      }
      return;
    }

    if (opts.search) {
      const results = store.searchByContent(opts.search);
      if (results.length === 0) {
        console.log(chalk.yellow('\n\u26A0\uFE0F  No memories match: "' + opts.search + '"'));
        return;
      }
      console.log(chalk.bold.cyan('\n\uD83D\uDD0D Search results (' + results.length + ')'));
      printMemories(results);
      return;
    }

    if (opts.tag) {
      const results = store.searchByTag(opts.tag);
      if (results.length === 0) {
        console.log(chalk.yellow('\n\u26A0\uFE0F  No memories tagged: "' + opts.tag + '"'));
        return;
      }
      console.log(chalk.bold.cyan('\n\uD83C\uDFF7\uFE0F  Tag: ' + opts.tag + ' (' + results.length + ')'));
      printMemories(results);
      return;
    }

    // Default: --list
    const live = store.getLive();
    if (live.length === 0) {
      console.log(chalk.yellow('\n\u26A0\uFE0F  No memories in current session.'));
      console.log(chalk.gray('  Memories are created by agents using the share_knowledge tool.'));
      return;
    }

    console.log(chalk.bold.cyan('\n\uD83E\uDDE0 Shared Memory (' + live.length + ' live entries)'));
    printMemories(live);
  });

function printMemories(entries: any[]): void {
  console.log(chalk.gray('\u2500'.repeat(70)));
  for (const e of entries) {
    const age = formatMemAge(Date.now() - e.timestamp);
    const confBadge = e.confidence < 0.8
      ? chalk.yellow(' conf:' + e.confidence)
      : '';
    const typeBadge =
      e.type === 'DISCOVERY' ? chalk.green('[DISCOVERY]') :
      e.type === 'DECISION' ? chalk.blue('[DECISION]') :
      e.type === 'WARNING' ? chalk.red('[WARNING]') :
      chalk.magenta('[FILE_MAP]');

    console.log(
      '  ' + typeBadge + ' ' +
      chalk.yellow(e.agentId) + ' ' +
      chalk.gray(age + ' ago') + confBadge
    );
    console.log('    ' + chalk.white(e.content.substring(0, 100)));
    if (e.tags.length > 0) {
      console.log('    ' + chalk.gray('tags: ' + e.tags.join(', ')));
    }
    console.log('');
  }
  console.log(chalk.gray('\u2500'.repeat(70)));
}

function formatMemAge(ms: number): string {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

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

    // Clear queue directories (including retry + failed)
    const queueDirs = ['pending', 'active', 'done', 'retry', 'failed'];
    let cleared = 0;
    for (const dir of queueDirs) {
      const dirPath = path.join(maosDir, 'queue', dir);
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          fs.unlinkSync(path.join(dirPath, file));
          cleared++;
        }
      }
    }

    // Clear checkpoints
    const checkpointDir = path.join(maosDir, 'checkpoints');
    if (fs.existsSync(checkpointDir)) {
      for (const file of fs.readdirSync(checkpointDir)) {
        fs.unlinkSync(path.join(checkpointDir, file));
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

