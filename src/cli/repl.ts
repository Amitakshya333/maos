import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { isMaosInitialized, getConfigPath, getPoolPath, getStatusDir, getMaosRoot } from '../utils/paths';
import { runStatus } from './status';
import { runBrain } from './brain';
import { runLogs, LogsOptions } from './logs';
import { runPlan } from './plan';
import { runTask, TaskOptions } from './task';
import { runStart, StartOptions } from './start';
import { runPool, PoolOptions } from './pool';
import { runLogin, LoginOptions } from './login';
import { runInit } from './init';
import { runDoctor } from './doctor';
import { runDashboard } from './dashboard';
import { EventStore } from '../core/event-store';
import { getRetryQueueStatus, getDeadLetterQueue } from '../core/retry-queue';
import { MemoryStore } from '../core/context-memory';

const VERSION = '0.3.0';

// ── Helpers ──────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function centerText(text: string, w: number): string {
  const tl = stripAnsi(text).length;
  const lp = Math.max(0, Math.floor((w - tl) / 2));
  return ' '.repeat(lp) + text;
}

function padRight(str: string, len: number): string {
  const vLen = stripAnsi(str).length;
  return vLen >= len ? str : str + ' '.repeat(len - vLen);
}

// ── ASCII Art Logo ───────────────────────────────────────────
// MA in dim slate, OS in bright white — "Multi-Agent OS" brand split

const LOGO = [
  { dim: '███    ███   █████', bright: '   ██████  ███████' },
  { dim: '████  ████  ██   ██', bright: ' ██    ██ ██     ' },
  { dim: '██ ████ ██  ███████', bright: ' ██    ██ ███████' },
  { dim: '██  ██  ██  ██   ██', bright: ' ██    ██      ██' },
  { dim: '██      ██  ██   ██', bright: '  ██████  ███████' },
];

// ── Config & Git Helpers ─────────────────────────────────────

interface ModelInfo {
  provider: string;
  model: string;
  tier: string;
}

function getModelInfo(): ModelInfo {
  try {
    const cfgPath = getConfigPath();
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const agent = cfg.agents?.find((a: any) => a.role === 'planner') || cfg.agents?.[0];
      if (agent) {
        return {
          provider: agent.provider || 'unknown',
          model: agent.model || 'unknown',
          tier: agent.costTier || 'low',
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { provider: 'freemodel', model: 'gpt-5.4', tier: 'low' };
}

function getGitBranch(): string {
  try {
    const cp = require('child_process');
    return cp
      .execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
  } catch {
    return '';
  }
}

interface FleetAgent {
  id: string;
  role: string;
  status: string;
  icon: string;
  enabled: boolean;
}

function getFleetAgents(): FleetAgent[] {
  try {
    const cwd = process.cwd();
    const configPath = getConfigPath(cwd);
    if (!fs.existsSync(configPath)) return [];
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const poolPath = getPoolPath(cwd);
    let pool: Record<string, boolean> = {};
    if (fs.existsSync(poolPath)) {
      pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    }
    const statusDir = getStatusDir(cwd);

    // Load credential statuses for fleet enrichment
    let credStatuses: any[] = [];
    try {
      const { getAllCredentialStatuses } = require('../core/credentials');
      credStatuses = getAllCredentialStatuses(config, cwd);
    } catch {
      /* credentials module not available yet — ignore */
    }

    return config.agents.map((a: any) => {
      const enabled = pool[a.id] !== false;
      const statusFile = path.join(statusDir, `${a.id}.status`);
      let status = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf-8').trim() : 'IDLE';

      // Override status with credential state when agent is idle
      // (don't override BUSY/DONE — those are real runtime statuses)
      if (status === 'IDLE' || status === '') {
        const cred = credStatuses.find((s: any) => s.agentId === a.id);
        if (cred && cred.status === 'missing') status = 'MISSING_KEY';
        else if (cred && cred.status === 'placeholder') status = 'INVALID_KEY';
        else if (!enabled) status = 'DISABLED';
        else if (cred && cred.status === 'valid') status = 'READY';
      }

      let icon = '📦';
      if (a.role === 'planner') icon = '🧠';
      else if (a.role === 'coder') icon = '⚙️';
      else if (a.role === 'reviewer') icon = '🔍';
      else if (a.role === 'designer') icon = '🎨';
      return { id: a.id, role: a.role, status, icon, enabled };
    });
  } catch {
    return [];
  }
}

// ── Screen Renderers ─────────────────────────────────────────

function drawWelcome(): void {
  console.clear();
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const info = getModelInfo();
  const branch = getGitBranch();
  const cwd = process.cwd();
  const agents = getFleetAgents();

  // ── Color Palette ──
  const slate = chalk.hex('#64748B');
  const border = chalk.hex('#334155');
  const amber = chalk.hex('#F59E0B');
  const violet = chalk.hex('#A78BFA');
  const emerald = chalk.hex('#10B981');

  // ── Vertical push (place logo ~20% from top) ──
  const topLines = Math.max(2, Math.floor(H * 0.15));
  for (let i = 0; i < topLines; i++) process.stdout.write('\n');

  // ── Logo (MA=dim slate, OS=bright white) ──
  for (const row of LOGO) {
    const line = slate(row.dim) + chalk.bold.white(row.bright);
    process.stdout.write(centerText(line, W) + '\n');
  }

  process.stdout.write('\n');
  process.stdout.write(centerText(slate('docker-compose for AI coding agents'), W) + '\n');
  process.stdout.write('\n');

  // ── Input Card ──
  const cardW = Math.min(62, W - 8);
  const cardPad = ' '.repeat(Math.max(2, Math.floor((W - cardW) / 2)));

  process.stdout.write(cardPad + border('╭' + '─'.repeat(cardW - 2) + '╮') + '\n');

  // Placeholder line
  const ph = 'Ask the fleet anything... "Build a login page"';
  const phFill = Math.max(0, cardW - 6 - ph.length);
  process.stdout.write(
    cardPad + border('│ ') + amber('┃') + chalk.gray(` ${ph}`) + ' '.repeat(phFill) + border(' │') + '\n',
  );

  // Empty line inside card
  process.stdout.write(cardPad + border('│ ') + amber('┃') + ' '.repeat(cardW - 5) + border(' │') + '\n');

  // Model info line
  const modelDisplay = `${amber('Build')} ${slate('·')} ${chalk.bold.white(info.model)} ${slate(info.provider)} ${slate('·')} ${amber(info.tier)}`;
  const modelClean = stripAnsi(modelDisplay).length;
  const modelFill = Math.max(0, cardW - 5 - modelClean);
  process.stdout.write(
    cardPad + border('│ ') + amber('┃') + ` ${modelDisplay}` + ' '.repeat(modelFill) + border(' │') + '\n',
  );

  process.stdout.write(cardPad + border('╰' + '─'.repeat(cardW - 2) + '╯') + '\n');
  process.stdout.write('\n');

  // ── Keyboard shortcuts (right-aligned to card) ──
  const sc = `${chalk.bold.white('tab')} ${slate('complete')}   ${chalk.bold.white('help')} ${slate('commands')}   ${chalk.bold.white('ctrl+c')} ${slate('quit')}`;
  const scLen = stripAnsi(sc).length;
  const scPad = Math.max(0, Math.floor((W - cardW) / 2) + cardW - scLen - 2);
  process.stdout.write(' '.repeat(scPad) + sc + '\n');

  process.stdout.write('\n');

  // ── Fleet status mini-grid (if agents exist) ──
  if (agents.length > 0) {
    process.stdout.write(cardPad + violet('Fleet') + '\n');

    let credIssueCount = 0;
    for (const a of agents) {
      let statusColor;
      let statusLabel = a.status.substring(0, 12);
      switch (a.status) {
        case 'READY':
          statusColor = emerald;
          statusLabel = '✅ READY';
          break;
        case 'IDLE':
          statusColor = emerald;
          break;
        case 'BUSY':
          statusColor = chalk.bold.yellow;
          break;
        case 'DONE':
          statusColor = emerald;
          break;
        case 'MISSING_KEY':
          statusColor = chalk.red.bold;
          statusLabel = '❌ MISSING_KEY';
          credIssueCount++;
          break;
        case 'INVALID_KEY':
          statusColor = chalk.red;
          statusLabel = '⚠️  INVALID_KEY';
          credIssueCount++;
          break;
        case 'DISABLED':
          statusColor = slate;
          statusLabel = '○ DISABLED';
          break;
        default:
          statusColor = chalk.gray;
          break;
      }
      const idLabel = a.enabled ? chalk.white(a.id) : slate(a.id);
      process.stdout.write(cardPad + `  ${a.icon} ${padRight(idLabel, 14)} ${statusColor(statusLabel)}` + '\n');
    }

    if (credIssueCount > 0) {
      process.stdout.write('\n');
      process.stdout.write(cardPad + chalk.yellow(`  ⚠️  ${credIssueCount} agent(s) need configuration.`) + '\n');
      process.stdout.write(cardPad + chalk.cyan('  Run: configure') + '\n');
    }

    process.stdout.write('\n');
  }

  // ── Tip ──
  const tips = [
    `Use ${chalk.cyan('plan "goal"')} to decompose features into parallel agent tasks`,
    `Type ${chalk.cyan('status')} to view the live fleet grid`,
    `Use ${chalk.cyan('brain init')} to scan and index your codebase`,
    `Type ${chalk.cyan('help')} to see all available commands`,
    `Use ${chalk.cyan('task "description"')} to queue a task for an agent`,
    `Type ${chalk.cyan('doctor')} to run environment diagnostics`,
    `Use ${chalk.cyan('memory --stats')} to view shared agent knowledge`,
    `Type ${chalk.cyan('replay --stats')} to see event store analytics`,
  ];
  const tip = tips[Math.floor(Math.random() * tips.length)];
  process.stdout.write(cardPad + amber('●') + amber(' Tip') + chalk.gray('  ' + tip) + '\n');

  // ── Fill remaining space to push status bar to bottom ──
  const usedLines =
    topLines + LOGO.length + 1 + 1 + 1 + 5 + 1 + 1 + 1 + (agents.length > 0 ? agents.length + 2 : 0) + 1;
  const remaining = Math.max(0, H - usedLines - 4);
  for (let i = 0; i < remaining; i++) process.stdout.write('\n');

  // ── Bottom status bar ──
  const leftBar = slate(`${cwd}${branch ? ':' + chalk.white(branch) : ''}`);
  const rightBar = slate(`v${VERSION}`);
  const barLen = stripAnsi(leftBar).length + stripAnsi(rightBar).length;
  const barSpace = Math.max(1, W - barLen);
  process.stdout.write(leftBar + ' '.repeat(barSpace) + rightBar + '\n');

  process.stdout.write('\n');
}

// ── Compact Persistent Header ─────────────────────────────
// Shown after every command so MAOS identity never disappears.
// Replaces the full welcome screen between commands.

function drawCompactHeader(): void {
  console.clear();

  const W = process.stdout.columns || 80;
  const slate = chalk.hex('#64748B');
  const dim = chalk.hex('#334155');
  const emerald = chalk.hex('#10B981');

  // Collect live state
  const info = getModelInfo();
  const branch = getGitBranch();
  const agents = getFleetAgents();

  // ── Row 1: Brand wordmark + context ──────────────────────
  // "MAOS" in two-tone, then separator dots and live context
  const ma = slate('MA') + chalk.bold.white('OS');
  const ver = slate(`v${VERSION}`);
  const branchPart = branch ? slate(' · ') + chalk.white(branch) : '';
  const modelPart = slate(' · ') + chalk.bold.white(info.model) + slate(` ${info.provider}`);

  // Agent summary: "2 agents · DEV IDLE · QA BUSY"
  let agentSummary = '';
  if (agents.length > 0) {
    const parts = agents.map((a) => {
      const statusColor = a.status === 'IDLE' ? emerald : chalk.bold.yellow;
      return `${chalk.white(a.id)} ${statusColor(a.status)}`;
    });
    agentSummary = slate(' · ') + parts.join(slate(' / '));
  }

  const row1 = `  ${ma} ${ver}${branchPart}${modelPart}${agentSummary}`;
  process.stdout.write(row1 + '\n');

  // ── Row 2: Thin separator spanning full width ─────────────
  process.stdout.write(dim('  ' + '─'.repeat(W - 4)) + '\n');
  process.stdout.write('\n');
}

function drawOutput(cmd: string, lines: string[]): void {
  drawCompactHeader();
  const pink = chalk.hex('#EC4899');
  process.stdout.write(`  ${pink('❯')} ${chalk.bold.white(cmd)}\n`);
  process.stdout.write('\n');
  for (const l of lines) {
    process.stdout.write(l + '\n');
  }
  process.stdout.write('\n');
}

// ── Output Capture ───────────────────────────────────────────

async function capture(fn: () => void | Promise<void>): Promise<string[]> {
  const buf: string[] = [];
  const oLog = console.log;
  const oErr = console.error;
  console.log = (...a: any[]) => {
    const raw = a.map((x) => String(x)).join(' ');
    buf.push(...raw.split('\n'));
  };
  console.error = (...a: any[]) => {
    const raw = a.map((x) => String(x)).join(' ');
    buf.push(...raw.split('\n').map((l) => chalk.red(l)));
  };
  try {
    await fn();
  } catch (e: any) {
    buf.push(chalk.red(`Error: ${e.message}`));
  } finally {
    console.log = oLog;
    console.error = oErr;
  }
  return buf;
}

// ── Inline command handlers (replay, queue, memory, clean) ───
// These are inlined because they have complex logic in index.ts
// that doesn't have a standalone exported function.

function runReplay(args: string[]): void {
  const cwd = process.cwd();
  const store = new EventStore(cwd);

  // --stats flag
  if (args.includes('--stats')) {
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

  // replay <taskId>
  const taskId = args.find((a) => !a.startsWith('--'));
  if (taskId) {
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
    return;
  }

  // Default: recent events
  const events = store.query({ limit: 30 });
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

function runQueue(): void {
  const cwd = process.cwd();
  const retrying = getRetryQueueStatus(cwd);
  const dead = getDeadLetterQueue(cwd);

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
}

function formatMemAge(ms: number): string {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

function printMemories(entries: any[]): void {
  console.log(chalk.gray('─'.repeat(70)));
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
  console.log(chalk.gray('─'.repeat(70)));
}

function runMemory(args: string[]): void {
  const cwd = process.cwd();
  const store = new MemoryStore(cwd);

  if (args.includes('--clear')) {
    store.clear();
    console.log(chalk.green('✅ Memory cleared (previous session archived).'));
    return;
  }

  if (args.includes('--stats')) {
    const s = store.getStats();
    console.log(chalk.bold.cyan('\n🧠 Context Memory Statistics'));
    console.log(chalk.gray('─'.repeat(40)));
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

  // --search <query>
  const searchIdx = args.indexOf('--search');
  if (searchIdx !== -1 && args[searchIdx + 1]) {
    const query = args[searchIdx + 1];
    const results = store.searchByContent(query);
    if (results.length === 0) {
      console.log(chalk.yellow(`\n⚠️  No memories match: "${query}"`));
      return;
    }
    console.log(chalk.bold.cyan(`\n🔍 Search results (${results.length})`));
    printMemories(results);
    return;
  }

  // --tag <tag>
  const tagIdx = args.indexOf('--tag');
  if (tagIdx !== -1 && args[tagIdx + 1]) {
    const tag = args[tagIdx + 1];
    const results = store.searchByTag(tag);
    if (results.length === 0) {
      console.log(chalk.yellow(`\n⚠️  No memories tagged: "${tag}"`));
      return;
    }
    console.log(chalk.bold.cyan(`\n🏷️  Tag: ${tag} (${results.length})`));
    printMemories(results);
    return;
  }

  // Default: list live
  const live = store.getLive();
  if (live.length === 0) {
    console.log(chalk.yellow('\n⚠️  No memories in current session.'));
    console.log(chalk.gray('  Memories are created by agents using the share_knowledge tool.'));
    return;
  }
  console.log(chalk.bold.cyan(`\n🧠 Shared Memory (${live.length} live entries)`));
  printMemories(live);
}

function runClean(): void {
  const cwd = process.cwd();
  const maosDir = path.join(cwd, '.maos');

  if (!fs.existsSync(maosDir)) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    return;
  }

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

  const checkpointDir = path.join(maosDir, 'checkpoints');
  if (fs.existsSync(checkpointDir)) {
    for (const file of fs.readdirSync(checkpointDir)) {
      fs.unlinkSync(path.join(checkpointDir, file));
    }
  }

  const statusDir = path.join(maosDir, 'status');
  if (fs.existsSync(statusDir)) {
    const files = fs.readdirSync(statusDir).filter((f) => f.endsWith('.status'));
    for (const file of files) {
      fs.unlinkSync(path.join(statusDir, file));
    }
  }

  const logFile = path.join(maosDir, 'logs', 'orchestrator.log');
  if (fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '', 'utf-8');
  }

  console.log(chalk.green(`✅ Cleaned: ${cleared} tasks removed, statuses reset, logs cleared.`));
}

// ── Parse helper for quoted strings ──────────────────────────
// Handles: task "Build a login page" --agent DEV
// Returns: ['Build a login page', '--agent', 'DEV']

function parseArgs(input: string): { positional: string; flags: Record<string, string>; rawArgs: string[] } {
  const flags: Record<string, string> = {};
  let positional = '';
  const rawArgs: string[] = [];

  // Extract quoted string first
  const quotedMatch = input.match(/"([^"]+)"|'([^']+)'/);
  if (quotedMatch) {
    positional = quotedMatch[1] || quotedMatch[2] || '';
    // Remove quoted part from input for flag parsing
    input = input.replace(quotedMatch[0], '').trim();
  }

  // Parse remaining tokens for flags
  const tokens = input.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    rawArgs.push(tokens[i]);
    if (tokens[i].startsWith('--') && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      flags[tokens[i].replace('--', '')] = tokens[i + 1];
      i++;
    } else if (tokens[i].startsWith('-') && tokens[i].length === 2 && i + 1 < tokens.length) {
      flags[tokens[i].replace('-', '')] = tokens[i + 1];
      i++;
    }
  }

  // If no quoted positional, use first non-flag token
  if (!positional) {
    const firstNonFlag = tokens.find((t) => !t.startsWith('-'));
    if (firstNonFlag) positional = firstNonFlag;
  }

  return { positional, flags, rawArgs };
}

// ── Main REPL ────────────────────────────────────────────────

export function runRepl(): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  // Draw the beautiful welcome screen
  drawWelcome();

  // All available commands for tab completion
  const ALL_COMMANDS = [
    'status',
    'start',
    'stop',
    'task',
    'plan',
    'objective',
    'obj',
    'brain init',
    'brain status',
    'brain context',
    'brain telemetry',
    'logs',
    'pool',
    'login',
    'configure',
    'init',
    'doctor',
    'dashboard',
    'replay',
    'replay --stats',
    'queue',
    'memory',
    'memory --list',
    'memory --stats',
    'memory --clear',
    'memory --search',
    'memory --tag',
    'clean',
    'clear',
    'help',
    'exit',
  ];

  // Create readline interface with styled prompt
  const prompt = chalk.hex('#F59E0B')('  ┃ ');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: prompt,
    completer: (line: string) => {
      const trimmed = line.trim().toLowerCase();
      const prefixMatch = trimmed.match(/^(maos|maosorch)\s+/i);
      const prefix = prefixMatch ? prefixMatch[0] : '';
      const query = prefix ? trimmed.substring(prefix.length) : trimmed;
      const baseHits = ALL_COMMANDS.filter((c) => c.startsWith(query));
      const hits = baseHits.map((h) => `${prefix}${h}`);
      return [hits.length ? hits : ALL_COMMANDS, line];
    },
  });

  rl.prompt();

  rl.on('line', async (input: string) => {
    let raw = input.trim();

    if (!raw) {
      drawWelcome();
      rl.prompt();
      return;
    }

    // Strip redundant launcher prefix inside REPL:
    // supports both "maos ..." and "maosorch ..." with any whitespace.
    const prefixed = raw.match(/^(?:maos|maosorch)(?:\s+|$)/i);
    if (prefixed) {
      raw = raw.substring(prefixed[0].length).trim();
    }

    if (!raw) {
      raw = 'help';
    }

    const cmdLower = raw.toLowerCase();

    // Extract the base command (first word)
    const firstWord = cmdLower.split(/\s+/)[0];
    const restOfInput = raw.substring(firstWord.length).trim();

    try {
      switch (firstWord) {
        // ── Navigation ──────────────────────────────────────
        case 'clear':
        case 'cls':
          drawWelcome();
          break;

        case 'exit':
        case 'quit':
        case 'q':
          console.clear();
          console.log(chalk.gray('\n  👋 Goodbye!\n'));
          process.exit(0);
          break;

        // ── Help ────────────────────────────────────────────
        case 'help':
        case 'h':
        case '?': {
          const v = chalk.hex('#A78BFA');
          const a = chalk.hex('#F59E0B');
          const g = chalk.hex('#64748B');

          drawOutput('help', [
            `  ${v('━━━ Fleet Operations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('status')}                    ${g('Live fleet status grid & task counts')}`,
            `    ${chalk.bold.cyan('start')}                     ${g('Start the orchestrator loop')}`,
            `    ${chalk.bold.cyan('start --provider <p>')}      ${g('Start with a specific provider override')}`,
            `    ${chalk.bold.cyan('pool')}                      ${g('Show agent pool status')}`,
            `    ${chalk.bold.cyan('pool --enable <agent>')}     ${g('Enable an agent (or "all")')}`,
            `    ${chalk.bold.cyan('pool --disable <agent>')}    ${g('Disable an agent (or "all")')}`,
            '',
            `  ${v('━━━ Task Management ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('task "description"')}        ${g('Queue a new task for an agent')}`,
            `    ${chalk.bold.cyan('task "desc" --agent DEV')}   ${g('Queue task targeting a specific agent')}`,
            `    ${chalk.bold.cyan('plan "goal"')}               ${g('AI-decompose a goal into subtasks')}`,
            `    ${chalk.bold.cyan('objective "goal"')}           ${g('Create a multi-agent objective (v0.3)')}`,
            `    ${chalk.bold.cyan('objective list')}             ${g('Show all objectives and progress')}`,
            `    ${chalk.bold.cyan('objective status <id>')}      ${g('Detailed objective + subtask view')}`,
            `    ${chalk.bold.cyan('queue')}                     ${g('Show retry queue & dead letter queue')}`,
            `    ${chalk.bold.cyan('clean')}                     ${g('Clear all queues, statuses, and logs')}`,
            '',
            `  ${v('━━━ Intelligence ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('brain init')}                ${g('Scan & index your codebase')}`,
            `    ${chalk.bold.cyan('brain status')}              ${g('Check memory sync freshness')}`,
            `    ${chalk.bold.cyan('brain context')}             ${g('Preview agent context injection')}`,
            `    ${chalk.bold.cyan('brain telemetry')}           ${g('View token usage & cost analytics')}`,
            `    ${chalk.bold.cyan('memory')}                    ${g('List shared agent memories')}`,
            `    ${chalk.bold.cyan('memory --stats')}            ${g('Memory statistics by type/agent')}`,
            `    ${chalk.bold.cyan('memory --search "query"')}   ${g('Search memories by content')}`,
            `    ${chalk.bold.cyan('memory --tag <tag>')}        ${g('Filter memories by tag')}`,
            `    ${chalk.bold.cyan('memory --clear')}            ${g('Archive & clear current memories')}`,
            '',
            `  ${v('━━━ Observability ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('logs')}                      ${g('View recent orchestrator logs')}`,
            `    ${chalk.bold.cyan('logs -n 100')}               ${g('Show last 100 log lines')}`,
            `    ${chalk.bold.cyan('logs --agent DEV')}          ${g('Filter logs by agent')}`,
            `    ${chalk.bold.cyan('replay')}                    ${g('Show recent events timeline')}`,
            `    ${chalk.bold.cyan('replay <taskId>')}           ${g('Full event timeline for a task')}`,
            `    ${chalk.bold.cyan('replay --stats')}            ${g('Event store statistics')}`,
            '',
            `  ${v('━━━ System ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('doctor')}                    ${g('Run environment & connectivity diagnostics')}`,
            `    ${chalk.bold.cyan('configure')}                 ${g('Configure API keys for providers')}`,
            `    ${chalk.bold.cyan('login')}                     ${g('Authenticate a CLI agent')}`,
            `    ${chalk.bold.cyan('login --cli copilot')}       ${g('Login with a specific CLI')}`,
            `    ${chalk.bold.cyan('dashboard')}                 ${g('Launch web dashboard on :3847')}`,
            `    ${chalk.bold.cyan('init')}                      ${g('Re-initialize MAOS in this directory')}`,
            '',
            `  ${v('━━━ Shell ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${chalk.bold.cyan('clear')}                     ${g('Return to welcome screen')}`,
            `    ${chalk.bold.cyan('exit')}                      ${g('Exit interactive shell')}`,
            '',
            `  ${v('━━━ Natural Language ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`,
            '',
            `    ${g('Type any goal in quotes to auto-decompose into agent tasks.')}`,
            `    ${a('Example:')} ${chalk.white('"Build a login page with OAuth"')}`,
            '',
          ]);
          break;
        }

        // ── Fleet Operations ────────────────────────────────
        case 'status':
        case 's':
          drawOutput('status', await capture(() => runStatus()));
          break;

        case 'start': {
          const opts: StartOptions = {};
          const { flags } = parseArgs(restOfInput);
          if (flags.provider || flags.p) opts.provider = flags.provider || flags.p;
          if (flags.force || flags.f) opts.force = true;
          drawOutput('start', await capture(() => runStart(opts)));
          break;
        }

        case 'pool': {
          if (!restOfInput) {
            // No flags — show pool status
            drawOutput('pool', await capture(() => runPool({} as PoolOptions)));
          } else {
            const { flags } = parseArgs(restOfInput);
            const opts: PoolOptions = {};
            if (flags.enable) opts.enable = flags.enable;
            if (flags.disable) opts.disable = flags.disable;
            drawOutput('pool', await capture(() => runPool(opts)));
          }
          break;
        }

        // ── Task Management ─────────────────────────────────
        case 'task': {
          const { positional, flags } = parseArgs(restOfInput);
          if (!positional) {
            drawOutput('task', [
              chalk.yellow('  Usage: task "description" [--agent <id>] [--complexity <level>]'),
              '',
              chalk.gray('  Example: task "Add user authentication" --agent DEV --complexity high'),
            ]);
            break;
          }
          const taskOpts: TaskOptions = {};
          if (flags.agent || flags.a) taskOpts.agent = flags.agent || flags.a;
          if (flags.branch || flags.b) taskOpts.branch = flags.branch || flags.b;
          if (flags.capabilities || flags.c) taskOpts.capabilities = flags.capabilities || flags.c;
          if (flags.complexity) taskOpts.complexity = flags.complexity;
          if (flags.category) taskOpts.category = flags.category;
          drawOutput(`task "${positional}"`, await capture(() => runTask(positional, taskOpts)));
          break;
        }

        case 'plan': {
          const { positional } = parseArgs(restOfInput);
          if (!positional) {
            drawOutput('plan', [
              chalk.yellow('  Usage: plan "goal"'),
              '',
              chalk.gray('  Example: plan "Build a REST API with authentication"'),
            ]);
            break;
          }
          drawOutput(`plan "${positional}"`, await capture(() => runPlan(positional, { yes: true })));
          break;
        }

        // ── v0.3: Objective Management ──────────────────────
        case 'objective':
        case 'obj': {
          const objArgs = restOfInput.split(/\s+/).filter(Boolean);
          const { runObjective } = require('./objective');
          drawOutput('objective', await capture(() => runObjective(objArgs)));
          break;
        }

        case 'queue':
          drawOutput('queue', await capture(() => runQueue()));
          break;

        case 'clean':
          drawOutput('clean', await capture(() => runClean()));
          break;

        // ── Intelligence ────────────────────────────────────
        case 'brain': {
          const action = restOfInput.split(/\s+/)[0] || 'status';
          drawOutput(`brain ${action}`, await capture(() => runBrain(action)));
          break;
        }

        case 'memory':
        case 'mem': {
          const memArgs = restOfInput.split(/\s+/).filter(Boolean);
          drawOutput('memory', await capture(() => runMemory(memArgs)));
          break;
        }

        // ── Observability ───────────────────────────────────
        case 'logs':
        case 'l': {
          const logsOpts: LogsOptions = { lines: '30' } as LogsOptions;
          const { flags } = parseArgs(restOfInput);
          if (flags.n || flags.lines) logsOpts.lines = flags.n || flags.lines;
          if (flags.agent || flags.a) (logsOpts as any).agent = flags.agent || flags.a;
          drawOutput('logs', await capture(() => runLogs(logsOpts)));
          break;
        }

        case 'replay': {
          const replayArgs = restOfInput.split(/\s+/).filter(Boolean);
          drawOutput('replay', await capture(() => runReplay(replayArgs)));
          break;
        }

        // ── System ──────────────────────────────────────────
        case 'doctor':
        case 'doc':
          drawOutput('doctor', await capture(() => runDoctor()));
          break;

        case 'login': {
          const loginOpts: LoginOptions = {};
          const { flags } = parseArgs(restOfInput);
          if (flags.agent || flags.a) loginOpts.agent = flags.agent || flags.a;
          if (flags.cli || flags.c) loginOpts.cli = flags.cli || flags.c;
          if (!loginOpts.agent && !loginOpts.cli && restOfInput) {
            // Allow shorthand: login copilot
            loginOpts.cli = restOfInput.trim();
          }
          drawOutput('login', await capture(() => runLogin(loginOpts)));
          break;
        }

        case 'configure':
        case 'config': {
          const configArgs = restOfInput.split(/\s+/).filter(Boolean);
          const { runConfigure } = require('./configure');
          drawOutput('configure', await capture(() => runConfigure(configArgs)));
          break;
        }

        case 'dashboard':
        case 'dash':
          drawOutput('dashboard', await capture(() => runDashboard()));
          break;

        case 'init':
          drawOutput('init', await capture(() => runInit()));
          break;

        // ── Default: Natural Language Goal ──────────────────
        default: {
          // Check if the entire input is a quoted string — treat as plan
          const quotedMatch = raw.match(/^["'](.+)["']$/);
          if (quotedMatch) {
            const goal = quotedMatch[1];
            const amber = chalk.hex('#F59E0B');
            process.stdout.write(`\n  ${amber('⟳')} Decomposing: ${chalk.bold.white(`"${goal}"`)}\n\n`);
            drawOutput(`plan "${goal}"`, await capture(() => runPlan(goal, { yes: true })));
          } else {
            drawOutput(raw, [
              chalk.yellow(`  Unknown command: "${firstWord}"`),
              '',
              chalk.gray('  Type ') + chalk.bold.cyan('help') + chalk.gray(' to see all available commands.'),
              chalk.gray('  Or wrap your goal in quotes: ') + chalk.bold.white('"Build a login page"'),
            ]);
          }
          break;
        }
      }
    } catch (err: any) {
      drawOutput(raw, [chalk.red(`  Error: ${err.message}`)]);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.clear();
    console.log(chalk.gray('\n  👋 Goodbye!\n'));
    process.exit(0);
  });

  // Handle terminal resizing
  process.stdout.on('resize', () => {
    // Redraw handled on next command
  });
}
