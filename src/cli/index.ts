#!/usr/bin/env node

import * as dotenv from 'dotenv';
dotenv.config({ override: true });
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
import { runDoctor } from './doctor';
import {
  bundlePrepare,
  bundleVerify,
  runRehearsalWorkflow,
  verifyRehearsalEvidence,
} from '../industrial/bundle-cli';
import {
  runKbBuild,
  runKbStatus,
  runKbVerify,
  runKbClear,
} from '../industrial/kb-cli';
import {
  runIndustrialPreflight,
  runIndustrialBoundary,
  runIndustrialStart,
  runIndustrialDemo,
  runIndustrialVerify,
  runIndustrialStop,
  runIndustrialReset,
  runIndustrialRun,
  runIndustrialOpen,
} from '../industrial/industrial-cli';
import { createServiceContainer } from '../service';

const VERSION = '0.3.0';

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
      chalk.gray('docker-compose for AI coding agents'),
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
  .option('-f, --force', 'Start with reduced fleet even if some agents have credential issues')
  .action(async (options: StartOptions) => {
    try {
      await runStart(options);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos objective ───────────────────────────────────────────
// Create and manage high-level objectives (v0.3 multi-agent decomposition)
program
  .command('objective [goal...]')
  .alias('obj')
  .description('Create or manage objectives (decomposed by ARCHITECT into subtasks)')
  .option('--list', 'List all objectives')
  .option('--status <id>', 'Show objective details by ID')
  .action((goalParts: string[], opts: any) => {
    const { runObjective } = require('./objective');

    if (opts.list) {
      runObjective(['list']);
      return;
    }
    if (opts.status) {
      runObjective(['status', opts.status]);
      return;
    }
    if (goalParts && goalParts.length > 0) {
      // Join multi-word goal back into a single string
      runObjective([goalParts.join(' ')]);
      return;
    }
    // No args — show list
    runObjective(['list']);
  });

// ─── maos configure ───────────────────────────────────────────
// Interactive credential wizard (v0.3 zero-friction UX)
program
  .command('configure [provider]')
  .alias('config')
  .description('Configure API keys for providers interactively')
  .action(async (provider?: string) => {
    const { runConfigure } = require('./configure');
    try {
      await runConfigure(provider ? [provider] : []);
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
  .description('Authenticate a CLI agent (copilot, codex, opencode, claude)')
  .option('-a, --agent <agent>', 'Agent ID to authenticate')
  .option('-c, --cli <cli>', 'CLI to authenticate with (copilot, codex, opencode, claude)')
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

// ─── maos doctor ─────────────────────────────────────────────
program
  .command('doctor')
  .alias('doc')
  .description('Run environment and connectivity diagnostics')
  .action(async () => {
    try {
      await runDoctor();
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ─── maos repl ───────────────────────────────────────────────
program
  .command('repl')
  .description('Launch the interactive MAOS REPL')
  .action(() => {
    runRepl();
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

    const services = createServiceContainer(cwd);

    if (opts.stats) {
      const s = services.event.getStats();
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
      const timeline = services.event.getTaskTimelineSummary(taskId);
      if (timeline.length === 0) {
        console.log(chalk.yellow(`\n⚠️  No events found for task: ${taskId}`));
        return;
      }

      console.log(chalk.bold.cyan(`\n🔁 Event Timeline: ${taskId}`));
      console.log(chalk.gray('─'.repeat(70)));
      console.log(
        chalk.gray(`${'SEQ'.padEnd(6)} ${'TIME'.padEnd(26)} ${'TYPE'.padEnd(22)} ${'AGENT'.padEnd(15)} NOTE`),
      );
      console.log(chalk.gray('─'.repeat(70)));

      for (const evt of timeline) {
        const time = new Date(evt.time).toLocaleTimeString();
        const seqStr = String(evt.seq).padEnd(6);
        const typeColor =
          evt.type.includes('FAIL') || evt.type.includes('ERROR')
            ? chalk.red(evt.type.padEnd(22))
            : evt.type.includes('COMPLETE') || evt.type.includes('DONE')
              ? chalk.green(evt.type.padEnd(22))
              : chalk.cyan(evt.type.padEnd(22));

        console.log(
          `${chalk.gray(seqStr)} ${chalk.gray(time.padEnd(26))} ${typeColor} ` +
            `${chalk.yellow(evt.agentId.padEnd(15))} ${chalk.gray(evt.note.substring(0, 40))}`,
        );
      }
      console.log(chalk.gray('─'.repeat(70)));
      console.log(chalk.gray(`  ${timeline.length} events`));
    } else {
      // Show recent events
      const limit = parseInt(opts.limit, 10) || 50;
      const events = services.event.query({
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
        console.log(
          `  ${chalk.gray(String(evt.seq).padEnd(5))} ${chalk.gray(time)} ${typeColor}${task} ${chalk.yellow(evt.agentId)}`,
        );
      }
    }
  });

// ─── maos queue ──────────────────────────────────────────────
program
  .command('queue')
  .description('Show retry queue and dead-letter queue status')
  .action(() => {
    const cwd = process.cwd();
    const services = createServiceContainer(cwd);
    const retrying = services.health.getRetryQueueStatus();
    const dead = services.health.getDeadLetterQueue();

    console.log(chalk.bold.cyan('\n🔄 Retry Queue'));
    if (retrying.length === 0) {
      console.log(chalk.gray('  (empty)'));
    } else {
      for (const r of retrying) {
        const readySecs = Math.round(r.readyInMs / 1000);
        const status = r.readyInMs === 0 ? chalk.green('READY') : chalk.yellow(`in ${readySecs}s`);
        console.log(
          `  ${chalk.white(r.taskId.substring(0, 30).padEnd(30))} ` +
            `attempt ${r.attemptNumber}/${r.maxRetries} ` +
            `[${chalk.red(r.lastErrorType)}] ` +
            status,
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

    const services = createServiceContainer(cwd);

    if (opts.clear) {
      services.memory.clear();
      console.log(chalk.green('\u2705 Memory cleared (previous session archived).'));
      return;
    }

    if (opts.stats) {
      const s = services.memory.getStats();
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
      const results = services.memory.search(opts.search);
      if (results.length === 0) {
        console.log(chalk.yellow('\n\u26A0\uFE0F  No memories match: "' + opts.search + '"'));
        return;
      }
      console.log(chalk.bold.cyan('\n\uD83D\uDD0D Search results (' + results.length + ')'));
      printMemories(results);
      return;
    }

    if (opts.tag) {
      const results = services.memory.searchByTag(opts.tag);
      if (results.length === 0) {
        console.log(chalk.yellow('\n\u26A0\uFE0F  No memories tagged: "' + opts.tag + '"'));
        return;
      }
      console.log(chalk.bold.cyan('\n\uD83C\uDFF7\uFE0F  Tag: ' + opts.tag + ' (' + results.length + ')'));
      printMemories(results);
      return;
    }

    // Default: --list
    const live = services.memory.getLive();
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
    const confBadge = e.confidence < 0.8 ? chalk.yellow(' conf:' + e.confidence) : '';
    const typeBadge =
      e.type === 'DISCOVERY'
        ? chalk.green('[DISCOVERY]')
        : e.type === 'DECISION'
          ? chalk.blue('[DECISION]')
          : e.type === 'WARNING'
            ? chalk.red('[WARNING]')
            : chalk.magenta('[FILE_MAP]');

    console.log('  ' + typeBadge + ' ' + chalk.yellow(e.agentId) + ' ' + chalk.gray(age + ' ago') + confBadge);
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
    const cwd = process.cwd();
    const maosDir = path.join(cwd, '.maos');
    if (!fs.existsSync(maosDir)) {
      console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
      process.exit(1);
    }

    const services = createServiceContainer(cwd);
    const result = services.task.clean();
    console.log(chalk.green(`✅ Cleaned: ${result.tasksRemoved} tasks removed, statuses reset, logs cleared.`));
  });

// ─── maos industrial ──────────────────────────────────────────
const industrial = program
  .command('industrial')
  .description('MAOS Industrial commands: offline bundle, rehearsal, and evidence verification');

const bundleCmd = industrial
  .command('bundle')
  .description('Manage offline bundle packaging and verification');

bundleCmd
  .command('prepare')
  .description('Prepare offline release bundle (builds release binary, locked checks, stores, manifest, archive)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-o, --output-dir <path>', 'Output directory for release archive', 'dist/release')
  .option('--skip-tests', 'Skip tests during preparation')
  .option('--model-cache-dir <path>', 'Path to local HuggingFace cache directory for models')
  .action(async (opts) => {
    console.log(chalk.bold.blue('\n📦 MAOS Industrial — Bundle Preparation\n'));
    console.log(chalk.gray(`Project Root: ${opts.projectRoot}`));
    console.log(chalk.gray(`Output Dir:   ${opts.outputDir}\n`));

    const result = await bundlePrepare({
      projectRoot: opts.projectRoot,
      outputDir: opts.outputDir,
      skipTests: opts.skipTests,
      modelCacheDir: opts.modelCacheDir,
    });

    if (result.success) {
      console.log(chalk.green(`\n✅ Bundle preparation completed in ${result.durationMs}ms`));
      console.log(chalk.white(`Entries:      ${result.manifest.totalEntries} files (${(result.manifest.totalSize / 1024 / 1024).toFixed(2)} MB)`));
      console.log(chalk.white(`Entries Hash: ${result.manifest.buildIdentity.entriesHash}`));
      if (result.archivePath) {
        console.log(chalk.white(`Archive:      ${result.archivePath}`));
        if (result.archiveHash) console.log(chalk.white(`Archive Hash: ${result.archiveHash}`));
      }
      process.exit(0);
    } else {
      console.error(chalk.red(`\n❌ Bundle preparation failed with ${result.failures.length} errors:`));
      for (const f of result.failures) {
        console.error(chalk.red(`  - ${f}`));
      }
      process.exit(1);
    }
  });

bundleCmd
  .command('verify')
  .description('Verify offline release bundle integrity, stores, binaries, and manifests')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-m, --manifest <path>', 'Path to bundle-manifest.json')
  .option('--check-unlisted', 'Check for unlisted executables in the bundle')
  .action((opts) => {
    console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Bundle Verification\n'));
    console.log(chalk.gray(`Project Root: ${opts.projectRoot}\n`));

    const result = bundleVerify({
      projectRoot: opts.projectRoot,
      manifestPath: opts.manifest,
      checkUnlisted: opts.checkUnlisted,
    });

    if (result.valid) {
      console.log(chalk.green('✅ Bundle verification passed: all files, stores, binaries, and manifests are intact.'));
      process.exit(0);
    } else {
      console.error(chalk.red(`❌ Bundle verification failed (${result.failures.length} errors):`));
      for (const f of result.failures) {
        console.error(chalk.red(`  - ${f}`));
      }
      process.exit(1);
    }
  });

industrial
  .command('rehearsal')
  .description('Run clean disconnected VM rehearsal workflow')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--allow-network', 'Allow network access (simulation only - not clean rehearsal)')
  .option('-r, --report-path <path>', 'Path for rehearsal evidence report')
  .action(async (opts) => {
    console.log(chalk.bold.blue('\n🧪 MAOS Industrial — Clean Disconnected Rehearsal\n'));
    console.log(chalk.gray(`Project Root: ${opts.projectRoot}`));
    console.log(chalk.gray(`Network:      ${opts.allowNetwork ? 'ALLOWED (Simulation mode)' : 'STRICT DISCONNECTED'}\n`));

    const result = await runRehearsalWorkflow({
      projectRoot: opts.projectRoot,
      allowNetwork: opts.allowNetwork,
      reportPath: opts.reportPath,
    });

    console.log(chalk.white(`Report written to: ${result.reportPath}`));

    if (result.passed) {
      console.log(chalk.green('\n✅ Clean rehearsal passed all stages!'));
      process.exit(0);
    } else {
      console.error(chalk.yellow(`\n⚠️ Rehearsal completed with ${result.failures.length} blockers/failures:`));
      for (const f of result.failures) {
        console.error(chalk.yellow(`  - ${f}`));
      }
      console.log(chalk.gray('\nGate G2 remains [!] until clean disconnected rehearsal passes on a clean VM.'));
      process.exit(1);
    }
  });

const evidenceCmd = industrial
  .command('evidence')
  .description('Manage and verify rehearsal evidence');

evidenceCmd
  .command('verify')
  .description('Verify rehearsal evidence against Gate G2 criteria')
  .option('-e, --evidence-file <path>', 'Path to rehearsal evidence file', 'artifacts/verification/G2-rehearsal.json')
  .action((opts) => {
    console.log(chalk.bold.blue('\n📋 MAOS Industrial — Evidence Verification\n'));
    console.log(chalk.gray(`Evidence File: ${opts.evidenceFile}\n`));

    const result = verifyRehearsalEvidence(opts.evidenceFile);

    if (result.verifiedItems.length > 0) {
      console.log(chalk.green('Verified Criteria:'));
      for (const v of result.verifiedItems) {
        console.log(chalk.green(`  ✓ ${v}`));
      }
    }

    if (!result.g2Ready) {
      console.log(chalk.red(`\nRemaining G2 Blockers (${result.blockers.length}):`));
      for (const b of result.blockers) {
        console.log(chalk.red(`  ✗ ${b}`));
      }
      console.log(chalk.yellow(`\nStatus: ${result.summary}`));
      process.exit(1);
    } else {
      console.log(chalk.bold.green(`\nStatus: ${result.summary}`));
      process.exit(0);
    }
  });

const kbCmd = industrial
  .command('kb')
  .description('Manage project local knowledge base (build, status, verify, clear)');

kbCmd
  .command('build')
  .description('Build or rebuild local knowledge base vector index')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-f, --force', 'Force re-ingestion and index rebuilding even if hashes match')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runKbBuild({
      projectRoot: opts.projectRoot,
      force: opts.force,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

kbCmd
  .command('status')
  .description('Inspect knowledge base policy, ingestion, model, and index status')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runKbStatus({
      projectRoot: opts.projectRoot,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

kbCmd
  .command('verify')
  .description('Verify integrity of knowledge base policy, manifests, chunks, model, and index')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runKbVerify({
      projectRoot: opts.projectRoot,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

kbCmd
  .command('clear')
  .description('Safely clear generated knowledge base index and chunks (requires --yes)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-y, --yes', 'Confirm destructive deletion of generated KB artifacts')
  .option('--dry-run', 'Preview files that would be removed without deleting them')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runKbClear({
      projectRoot: opts.projectRoot,
      yes: opts.yes,
      dryRun: opts.dryRun,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial boundary ───────────────────────────────
industrial
  .command('boundary <action>')
  .description('Manage the process-scoped sovereignty boundary (enable | status | disable)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--project-id <id>', 'Project identifier', 'default')
  .option('-y, --yes', 'Confirm the boundary state change')
  .option('--sampling-interval-ms <ms>', 'Passive observation sampling interval in milliseconds', (v: string) => parseInt(v, 10))
  .option('--monitor-pid <pid...>', 'Additional PID(s) to attribute to the boundary (e.g. an externally launched model server)', (v: string) => parseInt(v, 10))
  .option('--json', 'Output machine-readable JSON')
  .action(async (action, opts) => {
    const result = await runIndustrialBoundary({
      projectRoot: opts.projectRoot,
      action,
      projectId: opts.projectId,
      yes: opts.yes,
      samplingIntervalMs: opts.samplingIntervalMs,
      monitorPids: opts.monitorPid,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial preflight ──────────────────────────────
industrial
  .command('preflight')
  .description('Run industrial preflight and boundary verification')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--stage <stage>', 'Specific stage to run')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialPreflight({
      projectRoot: opts.projectRoot,
      stage: opts.stage,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial start ──────────────────────────────────
industrial
  .command('start')
  .description('Start the industrial project service host')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--port <number>', 'Port to bind (default: 0 for ephemeral)', (v: string) => parseInt(v, 10))
  .option('--host <host>', 'Host to bind (default: 127.0.0.1)', '127.0.0.1')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialStart({
      projectRoot: opts.projectRoot,
      port: opts.port,
      host: opts.host,
      json: opts.json,
    });
    // Keep the HTTP server's event loop alive after startup. Calling
    // process.exit() here terminates the listener immediately, despite the
    // successful "service started" message.
    process.exitCode = result.exitCode;
  });

// ─── maos industrial demo ───────────────────────────────────
industrial
  .command('demo')
  .description('Run sovereign industrial coding demo (e.g. RMS calculation)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-d, --demo <name>', 'Demo name to run (default: rms)', 'rms')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialDemo({
      projectRoot: opts.projectRoot,
      demo: opts.demo,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial verify ─────────────────────────────────
industrial
  .command('verify [target]')
  .description('Verify industrial state: audit, boundary, service, or telemetry analysis')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--run-id <runId>', 'Verify one completed judged run and its report/export hashes')
  .option('--analysis-id <analysisId>', 'Replay one local telemetry analysis against its source CSV')
  .option('--json', 'Output machine-readable JSON')
  .action(async (target, opts) => {
    const result = await runIndustrialVerify({
      target: target || 'audit',
      runId: opts.runId,
      analysisId: opts.analysisId,
      projectRoot: opts.projectRoot,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial stop ───────────────────────────────────
industrial
  .command('stop')
  .description('Stop the running industrial service (graceful or force with --yes)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-m, --mode <mode>', 'Stop mode: after-current-tasks or force', 'after-current-tasks')
  .option('-y, --yes', 'Confirm force stop (required for --mode force)')
  .option('--reason <reason>', 'Reason for stopping service')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialStop({
      projectRoot: opts.projectRoot,
      mode: opts.mode,
      yes: opts.yes,
      reason: opts.reason,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial reset ───────────────────────────────────
industrial
  .command('reset')
  .description('Deterministically reset confirmed generated test state (dry-run and allowlist)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('--allowlist <categories>', 'Comma-separated categories to reset (queue, output, index, sandbox, conversation, all)', 'all')
  .option('--run-id <runId>', 'Filter reset to a specific run ID')
  .option('--dry-run', 'Preview files that would be removed without deleting anything')
  .option('-y, --yes', 'Confirm live deletion of generated test state')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialReset({
      projectRoot: opts.projectRoot,
      allowlist: opts.allowlist,
      runId: opts.runId,
      dryRun: opts.dryRun,
      yes: opts.yes,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial run ─────────────────────────────────────
industrial
  .command('run')
  .description('One-command judged run (preflight → policy → services → DAG → approvals → verify → audit export)')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-d, --demo <name>', 'Demo name to run (default: safety-audit)', 'safety-audit')
  .option('--auto-approve', 'Automatically approve safety verdict with explicit confirmation')
  .option('-y, --yes', 'Confirm automatic approval and execution')
  .option('--enforce-firewall', 'Enforce active host firewall boundary during preflight')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    const result = await runIndustrialRun({
      projectRoot: opts.projectRoot,
      demo: opts.demo,
      autoApprove: opts.autoApprove,
      yes: opts.yes,
      enforceFirewall: opts.enforceFirewall,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// ─── maos industrial open ────────────────────────────────────
industrial
  .command('open <target>')
  .description('Open a validated local deliverable (.docx, .xlsx, .pptx, .pdf) in desktop office application')
  .option('-p, --project-root <path>', 'Project root directory', process.cwd())
  .option('-l, --launcher <launcher>', 'Launcher preference (auto, office, libreoffice, system)', 'auto')
  .option('--dry-run', 'Validate target and print launch command without opening window')
  .option('--json', 'Output machine-readable JSON')
  .action(async (target, opts) => {
    const result = await runIndustrialOpen({
      projectRoot: opts.projectRoot,
      target,
      launcher: opts.launcher,
      dryRun: opts.dryRun,
      json: opts.json,
    });
    process.exit(result.exitCode);
  });

// Default action: launch interactive REPL when no subcommand is provided
program.action(() => {
  runRepl();
});

// Parse
program.parse(process.argv);
