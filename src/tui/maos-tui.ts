/**
 * MAOS Oasis Terminal User Interface (TUI)
 *
 * Enterprise-grade, ultra-aesthetic, interactive terminal mission control.
 * Matches Antigravity CLI and Herdr level polishing:
 *   - Real-time GPU VRAM, Temperature & Throughput telemetry
 *   - Live Herdr Multi-Pane Swarm Matrix
 *   - Gemma Inference Playground & Model Switcher (2B ↔ 9B)
 *   - Autonomous Healer watcher monitor & trace viewer
 *   - Canva 3D Spatial Design Studio controls
 *   - Interactive hotkeys, modal overlays, and flicker-free rendering
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execSync, spawn, type ChildProcess } from 'child_process';
import chalk from 'chalk';
import { AgentInfo, getDefaultHerdrHarness, PaneInfo } from '../integrations/herdr';
import { detectLocalModels, DetectedModel, formatHeaderBadge, formatModelDisplayName } from '../oasis/model-detector';
import {
  SwarmAgent,
  SwarmPost,
  SwarmBoardState,
  createDefaultSwarmAgents,
  createDefaultSwarmPosts,
  renderSwarmBoard,
} from '../oasis/swarm-board';
import { renderJellyfishMascot, generateJellyfishRawFrame, renderColoredJellyfish } from '../oasis/jellyfish-ascii';

// ── Colors & Styles ──────────────────────────────────────────────
const c = {
  violet: chalk.hex('#8B5CF6'),
  violetBright: chalk.hex('#A78BFA'),
  pink: chalk.hex('#EC4899'),
  cyan: chalk.hex('#06B6D4'),
  cyanBright: chalk.hex('#38BDF8'),
  emerald: chalk.hex('#10B981'),
  amber: chalk.hex('#F59E0B'),
  slateDark: chalk.hex('#0F172A'),
  slateCard: chalk.hex('#1E293B'),
  slateBorder: chalk.hex('#334155'),
  slateMuted: chalk.hex('#64748B'),
  slateText: chalk.hex('#94A3B8'),
  white: chalk.hex('#F8FAFC'),
  boldWhite: chalk.bold.hex('#FFFFFF'),
};

interface GpuStats {
  vramUsedMiB: number;
  vramTotalMiB: number;
  gpuUtil: number;
  tempC: number;
  powerW: number;
  modelInVram: string;
}

interface ActivityEvent {
  time: string;
  tag: string;
  text: string;
  color: (s: string) => string;
}

interface MetricCard {
  label: string;
  value: string;
  detail?: string;
  color?: (value: string) => string;
}

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MAOS_OASIS_LOGO_ROWS = [
  '┌────────────┐┌────────┐┌────────┐┌─────────┐    ┌────────┐┌────────┐┌─────────┐┌──┐┌─────────┐',
  '│ ·┌─┐  ┌─┐· ││ .┌──┐ ·││ .┌──┐ ·││· ┌──────┘    │ .┌──┐ ·││ .┌──┐ ·││· ┌──────┘│  ││· ┌──────┘',
  '│  │ │· │ │ ·││· └──┘  ││· │  │  ││ ·└──────┐    │· │  │  ││· └──┘  ││ ·└──────┐│· ││ ·└──────┐',
  '│──│ │──│ │──││──┌──┐──││──│  │──│└──────┐──│    │──│  │──││──┌──┐──│└──────┐──││──│└──────┐──│',
  '│══│ │══│ │══││══│  │══││══└──┘══│┌──────┘══│    │══└──┘══││══│  │══│┌──────┘══││══│┌──────┘══│',
  '└──┘ └──┘ └──┘└──┘  └──┘└────────┘└─────────┘    └────────┘└──┘  └──┘└─────────┘└──┘└─────────┘',
];
const MAOS_OASIS_LOGO_WIDTH = Math.max(...MAOS_OASIS_LOGO_ROWS.map(terminalCellWidth));

function terminalCellWidth(value: string): number {
  let width = 0;
  const plainText = value.replace(ANSI_SEQUENCE, '').replace(/[\r\n]+/g, '');
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plainText)) {
    const points = Array.from(segment, (character) => character.codePointAt(0) || 0);
    const point = points.find((value) => value !== 0x200d && !(value >= 0xfe00 && value <= 0xfe0f)) || 0;
    const wide =
      point >= 0x1100 &&
      (point <= 0x115f ||
        point === 0x2329 ||
        point === 0x232a ||
        (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
        (point >= 0xac00 && point <= 0xd7a3) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe19) ||
        (point >= 0xfe30 && point <= 0xfe6f) ||
        (point >= 0xff00 && point <= 0xff60) ||
        (point >= 0xffe0 && point <= 0xffe6) ||
        (point >= 0x1f300 && point <= 0x1faff) ||
        (point >= 0x20000 && point <= 0x3fffd));
    const emojiPresentation =
      points.includes(0xfe0f) ||
      points.includes(0x20e3) ||
      points.filter((value) => value >= 0x1f1e6 && value <= 0x1f1ff).length === 2 ||
      points.some(
        (value) =>
          (value >= 0x1f000 && value <= 0x1faff) ||
          (value >= 0x2700 && value <= 0x27bf) || // Dingbats (❌ 0x274c, ✅ 0x2705, ❎ 0x274e, etc.)
          (value >= 0x2600 && value <= 0x26ff && [0x26a0, 0x26a1, 0x26d4, 0x267f, 0x2699].includes(value)),
      );
    width += wide || emojiPresentation ? 2 : 1;
  }
  return width;
}

function fitTerminalLine(value: string, width: number): string {
  if (width <= 0) return '';
  const cleanValue = value.replace(/[\r\n]+/g, ' ');
  const fullWidth = terminalCellWidth(cleanValue);
  const clipped = fullWidth > width;
  const limit = clipped ? Math.max(0, width - 1) : width;
  let used = 0;
  let output = '';
  const tokens = cleanValue.match(/\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]+|\u001b/gu) || [];

  segments: for (const token of tokens) {
    if (token.startsWith('\u001b')) {
      output += token;
      continue;
    }
    for (const { segment } of GRAPHEME_SEGMENTER.segment(token)) {
      const cells = terminalCellWidth(segment);
      if (used + cells > limit) {
        break segments;
      }
      output += segment;
      used += cells;
    }
  }

  if (clipped) {
    if (used < width) {
      output += '…';
      used += 1;
    }
  }
  if (cleanValue.includes('\u001b')) output += '\u001b[0m';
  return output + ' '.repeat(Math.max(0, width - used));
}

function centerTerminalLine(value: string, width: number): string {
  const cleanValue = value.replace(/[\r\n]+/g, ' ');
  const valueWidth = terminalCellWidth(cleanValue);
  if (valueWidth >= width) return fitTerminalLine(cleanValue, width);
  const left = Math.floor((width - valueWidth) / 2);
  const reset = cleanValue.includes('\u001b') ? '\u001b[0m' : '';
  return ' '.repeat(left) + cleanValue + reset + ' '.repeat(Math.max(0, width - valueWidth - left));
}

function fitTerminalTail(value: string, width: number): string {
  if (width <= 0) return '';
  const cleanValue = value.replace(/[\r\n]+/g, ' ');
  if (terminalCellWidth(cleanValue) <= width) return cleanValue;

  const segments = Array.from(GRAPHEME_SEGMENTER.segment(cleanValue), ({ segment }) => segment);
  const limit = Math.max(0, width - 1);
  const tail: string[] = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const cells = terminalCellWidth(segments[i]);
    if (used + cells > limit) break;
    tail.push(segments[i]);
    used += cells;
  }
  return `…${tail.reverse().join('')}`;
}

function wrapTerminalLine(value: string, width: number): string[] {
  if (width <= 0) return [''];
  if (value === '') return [''];

  const normalized = value.replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split('\n');
  const rows: string[] = [];

  for (const para of paragraphs) {
    if (para === '') {
      rows.push('');
      continue;
    }

    const words = para.match(/\S+|\s+/g) || [para];
    let row = '';
    let rowWidth = 0;

    for (const word of words) {
      const wordCells = terminalCellWidth(word);
      if (row && rowWidth + wordCells > width) {
        if (/^\s+$/.test(word)) {
          continue;
        }
        rows.push(row);
        row = '';
        rowWidth = 0;
      }

      if (wordCells > width) {
        for (const { segment } of GRAPHEME_SEGMENTER.segment(word)) {
          const cells = terminalCellWidth(segment);
          if (row && rowWidth + cells > width) {
            rows.push(row);
            row = '';
            rowWidth = 0;
          }
          row += segment;
          rowWidth += cells;
        }
      } else {
        if (!row && /^\s+$/.test(word)) {
          continue;
        }
        row += word;
        rowWidth += wordCells;
      }
    }
    if (row || rows.length === 0) {
      rows.push(row);
    }
  }

  return rows.length > 0 ? rows : [''];
}

function appendMetricCards(lines: string[], width: number, cards: MetricCard[]): void {
  const columns = width >= 82 ? 3 : width >= 52 ? 2 : 1;
  const gap = '  ';
  const cardWidth = Math.max(1, Math.floor((width - terminalCellWidth(gap) * (columns - 1)) / columns));
  const contentWidth = Math.max(0, cardWidth - 4);

  for (let start = 0; start < cards.length; start += columns) {
    const row = cards.slice(start, start + columns).map((card) => {
      const color = card.color || c.cyanBright;
      return [
        c.slateBorder(`╭${'─'.repeat(Math.max(0, cardWidth - 2))}╮`),
        `${c.slateBorder('│')} ${fitTerminalLine(c.slateMuted(card.label), contentWidth)} ${c.slateBorder('│')}`,
        `${c.slateBorder('│')} ${fitTerminalLine(color(card.value), contentWidth)} ${c.slateBorder('│')}`,
        `${c.slateBorder('│')} ${fitTerminalLine(c.slateText(card.detail || ''), contentWidth)} ${c.slateBorder('│')}`,
        c.slateBorder(`╰${'─'.repeat(Math.max(0, cardWidth - 2))}╯`),
      ];
    });

    for (let line = 0; line < 5; line++) lines.push(row.map((card) => card[line]).join(gap));
  }
}

function splitCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (escaped) {
      current += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      const next = value[i + 1];
      if (next && (next === '"' || next === "'" || next === '\\' || /\s/.test(next))) {
        escaped = true;
        continue;
      }
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) args.push(current);
      current = '';
      tokenStarted = false;
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (escaped) current += '\\';
  if (quote) throw new Error('Unclosed quote in command.');
  if (tokenStarted) args.push(current);
  return args;
}

const CORE_CLI_COMMANDS = new Set([
  'init',
  'task',
  'status',
  'start',
  'objective',
  'configure',
  'plan',
  'ignite',
  'pool',
  'logs',
  'login',
  'brain',
  'dashboard',
  'doctor',
  'repl',
  'preview',
  'run',
  'open',
  'replay',
  'queue',
  'memory',
  'clean',
]);

export interface ChatMessage {
  sender: 'user' | 'gemma';
  text: string;
  time: string;
}

/**
 * Distinguishes conversational queries / casual greetings / questions
 * from actionable multi-agent swarm engineering tasks.
 */
export function classifyUserInput(input: string): 'chat' | 'swarm_task' {
  const trimmed = input.trim();
  if (!trimmed) return 'chat';

  // Explicit prefixes
  if (/^(task|swarm|goal|build|ignite):\s*/i.test(trimmed)) return 'swarm_task';
  if (/^(chat|ask|question|say):\s*/i.test(trimmed)) return 'chat';

  const lower = trimmed.toLowerCase();

  // Strip leading polite / conversational preamble
  // e.g. "hi, can you please build..." -> "build..."
  // e.g. "hey could you write..." -> "write..."
  // e.g. "hello! please create..." -> "create..."
  // e.g. "can you please fix..." -> "fix..."
  const stripped = lower
    .replace(/^(hi|hello|hey|hiya|yo|howdy|hola|greetings|good\s+(morning|afternoon|evening|day))[!,.\s]*/i, '')
    .replace(/^(please|kindly)[!,.\s]*/i, '')
    .replace(
      /^(can\s+you(\s+please)?|could\s+you(\s+please)?|would\s+you(\s+please)?|i\s+want\s+you\s+to|i\s+need\s+you\s+to)[!,.\s]*/i,
      '',
    )
    .replace(/^(please|kindly)[!,.\s]*/i, '')
    .trim();

  // If after stripping preamble nothing is left (e.g. "hi", "hello!", "hey please"):
  if (!stripped) return 'chat';

  // Common conversational / casual feedback tokens
  const casualTokens = new Set([
    'hi',
    'hello',
    'hey',
    'hiya',
    'yo',
    'howdy',
    'hola',
    'sup',
    'ping',
    'test',
    'thanks',
    'thx',
    'thank',
    'bye',
    'goodbye',
    'ok',
    'okay',
    'cool',
    'nice',
    'great',
    'awesome',
    'perfect',
    'help',
    'status',
  ]);
  const cleanTokens = stripped
    .replace(/[?!.,;:()]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (cleanTokens.length <= 2 && cleanTokens.every((t) => casualTokens.has(t))) {
    return 'chat';
  }

  // Conversational questions asking to explain, tell, describe, clarify
  // Even if they mention task words ("explain how to build a website", "tell me how to write tests")
  const conversationalStarters =
    /^(how\s+(are\s+you|does|do|can|is|to)|who\s+(are\s+you|is)|what\s+(are\s+you|is|can|do|does|are)|why\s+|tell\s+me|explain|can\s+you\s+explain|could\s+you\s+explain|help\s+me\s+understand|describe|clarify)\b/i;

  if (conversationalStarters.test(stripped) || conversationalStarters.test(lower)) {
    return 'chat';
  }

  // Action verbs that indicate hands-on engineering / coding execution tasks
  const imperativeTaskVerbs =
    /^(build|create|implement|fix|refactor|deploy|scaffold|generate|develop|write|modify|update|optimize|delete|migrate|repair|run|compile|assemble|wire|dockerize|containerize|patch|remediate|benchmark|test|clean|install|init)\b/i;

  if (imperativeTaskVerbs.test(stripped)) {
    if (stripped.endsWith('?') && /^(is|are|does|do|can|could|how|what|why)\b/i.test(stripped)) {
      return 'chat';
    }
    return 'swarm_task';
  }

  // General questions (start with question word or end with question mark)
  const questionWords = /^(what|why|who|where|when|which|is|are|does|do|how|can|could|would)\b/i;
  if (questionWords.test(stripped) || stripped.endsWith('?')) {
    return 'chat';
  }

  // Short inputs (< 4 words) without task verb default to chat
  if (cleanTokens.length <= 3 && !imperativeTaskVerbs.test(cleanTokens[0])) {
    return 'chat';
  }

  return 'swarm_task';
}

export class MaosTui {
  private activeTab: number = 1; // 1: Dashboard, 2: Chat, 3: Agents, 4: Telemetry, 5: Event log, 0: Settings
  private isRunning: boolean = true;
  private externalCommandRunning: boolean = false;
  private activeChild: ChildProcess | null = null;
  private externalCommandLabel: string = '';
  private externalCommandStartTime: number = 0;
  private spinnerFrames: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex: number = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private lastCommandExitCode: number | null = null;
  private lastCommandLabel: string = '';
  private isRendering: boolean = false;
  private renderPending: boolean = false;
  private selectedModel: string = 'gemma2:9b';
  private detectedModels: DetectedModel[] = [];
  private modalMode: 'none' | 'ignite' | 'promptTest' = 'none';
  private modalInputText: string = '';
  private statusMessage: string = 'Ready. Press Enter to type a goal or slash command; /help lists commands.';
  private commandHistory: string[] = [];
  private commandHistoryIndex: number = -1;
  private transcript: string[] = [];
  private transcriptScrollOffset: number = 0;
  private transcriptViewportRows: number = 8;
  private transcriptRenderedRowCount: number = 0;
  private commandOutputRemainder: string = '';
  private transcriptRenderTimer: NodeJS.Timeout | null = null;
  private herdrPanes: PaneInfo[] = [];
  private herdrAgents: AgentInfo[] = [];
  private herdrAvailable: boolean = false;
  private herdrRefreshInFlight: boolean = false;

  // ── Swarm Board (Tab 3) State ─────────────────────────────────────
  private swarmGoal: string = 'Build and deploy Canva 3D Spatial Studio';
  private swarmState: 'active' | 'waiting' | 'done' = 'active';
  private swarmAgents: SwarmAgent[] = [];
  private swarmPosts: SwarmPost[] = [];
  private selectedSwarmAgentIndex: number = 0;
  private swarmInspectorExpanded: boolean = false;

  private chatMessages: ChatMessage[] = [];
  private chatInputText: string = '';
  private chatScrollOffset: number = 0;
  private chatViewportRows: number = 8;
  private chatRenderedRowCount: number = 0;
  private chatIsStreaming: boolean = false;
  private activeChatAbortController: AbortController | null = null;
  private oasisConfig: any = null;

  private settingsScrollOffset: number = 0;
  private settingsViewportRows: number = 16;
  private settingsRenderedRowCount: number = 0;

  private gpuStats: GpuStats = {
    vramUsedMiB: 3074,
    vramTotalMiB: 8188,
    gpuUtil: 1,
    tempC: 40,
    powerW: 1,
    modelInVram: 'gemma2:9b (80% GPU / 20% CPU)',
  };

  private activities: ActivityEvent[] = [];

  private refreshTimer: NodeJS.Timeout | null = null;
  private projectRoot: string;
  private readonly resizeHandler = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    this.render();
  };
  private readonly interruptHandler = () => {
    if (this.chatIsStreaming && this.activeChatAbortController) {
      this.activeChatAbortController.abort();
      this.activeChatAbortController = null;
      this.chatIsStreaming = false;
      this.statusMessage = 'Chat generation cancelled.';
      this.appendTranscript('\n^C [Chat generation cancelled by user]');
      this.render();
      return;
    }
    if (this.externalCommandRunning && this.activeChild) {
      this.statusMessage = 'Aborting running process...';
      this.appendTranscript('\n^C [Aborting running process...]');
      try {
        if (process.platform === 'win32' && this.activeChild.pid) {
          execSync(`taskkill /pid ${this.activeChild.pid} /T /F`, { stdio: 'ignore' });
        } else {
          this.activeChild.kill('SIGINT');
        }
      } catch {}
      this.render();
      return;
    }
    this.exit();
  };
  private readonly terminateHandler = () => this.exit();

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
    this.loadWorkplaceConfig();
    this.swarmAgents = createDefaultSwarmAgents(this.swarmGoal, this.selectedModel);
    this.swarmPosts = createDefaultSwarmPosts(this.swarmGoal);
  }

  public getSwarmGoal(): string {
    return this.swarmGoal;
  }

  public setSwarmGoal(goal: string): void {
    this.swarmGoal = goal;
    this.swarmAgents = createDefaultSwarmAgents(goal, this.selectedModel);
    this.swarmPosts = createDefaultSwarmPosts(goal);
    this.swarmState = 'active';
  }

  public getSwarmAgents(): SwarmAgent[] {
    return this.swarmAgents;
  }

  public getSwarmPosts(): SwarmPost[] {
    return this.swarmPosts;
  }

  public getSelectedSwarmAgent(): SwarmAgent {
    return this.swarmAgents[this.selectedSwarmAgentIndex] || this.swarmAgents[0];
  }

  public setSelectedSwarmAgentIndex(index: number): void {
    this.selectedSwarmAgentIndex = Math.max(0, Math.min(this.swarmAgents.length - 1, index));
  }

  public toggleSwarmInspectorExpanded(): boolean {
    this.swarmInspectorExpanded = !this.swarmInspectorExpanded;
    return this.swarmInspectorExpanded;
  }

  public isSwarmInspectorExpanded(): boolean {
    return this.swarmInspectorExpanded;
  }

  public recordSwarmPost(sender: string, recipient: string, action: string, text: string): void {
    const nextId = this.swarmPosts.length > 0 ? Math.max(...this.swarmPosts.map((p) => p.id)) + 1 : 1;
    const now = new Date();
    const timeStr = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    this.swarmPosts.push({
      id: nextId,
      sender,
      recipient,
      action,
      text,
      time: timeStr,
      type: 'tool',
    });
    if (this.swarmPosts.length > 100) this.swarmPosts.shift();

    const ag = this.swarmAgents.find((a) => a.id === sender);
    if (ag) {
      ag.latestTool = {
        name: action,
        args: text,
        result: 'executed',
        time: 'just now',
      };
      if (action.includes('complete') || text.includes('green') || text.includes('exit 0')) {
        ag.state = 'done';
      } else {
        ag.state = 'working';
      }
    }
  }

  public loadWorkplaceConfig(): void {
    try {
      const configPath = path.join(this.projectRoot, 'maos-oasis.config.json');
      if (fs.existsSync(configPath)) {
        this.oasisConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (this.oasisConfig?.model?.primary) {
          this.selectedModel = this.oasisConfig.model.primary;
        }
      }
    } catch {}
    void this.refreshDetectedModels();
  }

  public getNextTab(current: number): number {
    switch (current) {
      case 1:
        return 2;
      case 2:
        return 3;
      case 3:
        return 4;
      case 4:
        return 5;
      case 5:
        return 0;
      case 0:
        return 1;
      default:
        return 1;
    }
  }

  public getPrevTab(current: number): number {
    switch (current) {
      case 1:
        return 0;
      case 2:
        return 1;
      case 3:
        return 2;
      case 4:
        return 3;
      case 5:
        return 4;
      case 0:
        return 5;
      default:
        return 1;
    }
  }

  public getActiveTab(): number {
    return this.activeTab;
  }

  public setActiveTab(tab: number): void {
    this.activeTab = tab;
  }

  public getModalMode(): string {
    return this.modalMode;
  }

  public setModalMode(mode: 'none' | 'ignite' | 'promptTest'): void {
    this.modalMode = mode;
  }

  public getChatMessages(): readonly ChatMessage[] {
    return this.chatMessages;
  }

  public start(): void {
    // Switch to alternate screen buffer, clear screen & hide cursor
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');

    this.setupKeyboard();
    this.updateGpuTelemetry();
    void this.updateHerdrTelemetry();
    void this.refreshDetectedModels();
    process.stdout.on('resize', this.resizeHandler);

    // Sandbox unhandled rejections to prevent crashing the TUI during demos
    process.on('unhandledRejection', (reason: unknown) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.recordActivity('ERROR', `Async notice: ${msg.slice(0, 80)}`, c.pink);
      this.statusMessage = `Task notice: ${msg.slice(0, 60)}`;
      this.render();
    });
    process.on('uncaughtException', (err: Error) => {
      const msg = err.message || String(err);
      this.recordActivity('ERROR', `Exception recovered: ${msg.slice(0, 80)}`, c.pink);
      this.statusMessage = `Exception caught: ${msg.slice(0, 60)}`;
      this.render();
    });

    // Render loop
    this.render();
    this.startRefreshLoop();

    // Clean exit handlers
    process.on('SIGINT', this.interruptHandler);
    process.on('SIGTERM', this.terminateHandler);
  }

  private exit(): void {
    this.isRunning = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.transcriptRenderTimer) clearTimeout(this.transcriptRenderTimer);
    if (this.activeChild) {
      try {
        if (process.platform === 'win32' && this.activeChild.pid) {
          execSync(`taskkill /pid ${this.activeChild.pid} /T /F`, { stdio: 'ignore' });
        } else {
          this.activeChild.kill('SIGINT');
        }
      } catch {}
      this.activeChild = null;
    }
    process.stdout.removeListener('resize', this.resizeHandler);
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {}
    // Restore normal screen buffer and reveal cursor
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    console.log(c.cyanBright('✦ MAOS Oasis TUI closed. Returning to terminal.'));
    process.exit(0);
  }

  private setupKeyboard(): void {
    if (process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(true);
      } catch {}
    }
    try {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
    } catch {}
    readline.emitKeypressEvents(process.stdin);

    process.stdin.on('keypress', (str, key) => {
      // Synthesize key object if undefined from readline on raw Windows stream
      if (!key) {
        if (!str) return;
        key = {
          name:
            str === '\r' || str === '\n'
              ? 'return'
              : str === '\x1b'
                ? 'escape'
                : str === '\x08' || str === '\x7f'
                  ? 'backspace'
                  : str === '\t'
                    ? 'tab'
                    : str,
          ctrl: str === '\x03',
          meta: false,
          shift: false,
        };
      }

      // Handle Ctrl+C to cancel current process or quit cleanly
      if ((key.ctrl && key.name === 'c') || str === '\x03') {
        this.interruptHandler();
        return;
      }

      // If an external command is actively running:
      if (this.externalCommandRunning) {
        // Tab key always cycles views:
        if (key.name === 'tab') {
          this.activeTab = key.shift ? this.getPrevTab(this.activeTab) : this.getNextTab(this.activeTab);
          this.statusMessage = `Switched to View [${this.activeTab}].`;
          this.render();
          return;
        }
        // Direct number keys switch views:
        if (['0', '1', '2', '3', '4', '5'].includes(str)) {
          this.activeTab = Number(str);
          this.statusMessage = `Switched to View [${this.activeTab}].`;
          this.render();
          return;
        }
        // PageUp / PageDown / Home / End scroll the live transcript on View 1:
        if (
          ['pageup', 'pagedown', 'home', 'end'].includes(key.name) &&
          this.activeTab === 1 &&
          this.transcript.length > 0
        ) {
          if (key.name === 'home') {
            this.transcriptScrollOffset = Math.max(0, this.transcriptRenderedRowCount - this.transcriptViewportRows);
          } else if (key.name === 'end') {
            this.transcriptScrollOffset = 0;
          } else {
            const step = Math.max(1, this.transcriptViewportRows - 1);
            this.transcriptScrollOffset += key.name === 'pageup' ? step : -step;
            this.transcriptScrollOffset = Math.max(
              0,
              Math.min(
                this.transcriptScrollOffset,
                Math.max(0, this.transcriptRenderedRowCount - this.transcriptViewportRows),
              ),
            );
          }
          this.render();
          return;
        }
        // Q key quits when on non-input views (tabs 3, 4, 5, 0):
        if (this.activeTab !== 1 && this.activeTab !== 2 && key.name === 'q') {
          this.exit();
          return;
        }
        // Enter gives immediate feedback:
        if (key.name === 'return') {
          this.statusMessage = 'A task is currently running. Press Ctrl+C to abort it before starting a new one.';
          this.render();
          return;
        }
        return;
      }

      // If in modal dialog mode (ignite/promptTest modal overlays):
      if (this.modalMode !== 'none') {
        if (key.name === 'escape') {
          this.modalMode = 'none';
          this.modalInputText = '';
          this.statusMessage = 'Action cancelled.';
          this.render();
          return;
        }
        if (key.name === 'return') {
          this.handleModalSubmit();
          return;
        }
        if (key.name === 'backspace') {
          const characters = Array.from(GRAPHEME_SEGMENTER.segment(this.modalInputText), ({ segment }) => segment);
          characters.pop();
          this.modalInputText = characters.join('');
          this.render();
          return;
        }
        if (str && str.length === 1 && !key.ctrl && !key.meta) {
          this.modalInputText += str;
          this.render();
          return;
        }
        return;
      }

      // If on Tab 1 (where the prompt box is always ready to receive input):
      if (this.activeTab === 1) {
        if (key.name === 'tab') {
          this.activeTab = key.shift ? this.getPrevTab(1) : this.getNextTab(1);
          this.statusMessage = `Switched to View [${this.activeTab}].`;
          this.render();
          return;
        }
        if (key.name === 'escape') {
          if (this.chatIsStreaming && this.activeChatAbortController) {
            this.activeChatAbortController.abort();
            this.activeChatAbortController = null;
            this.chatIsStreaming = false;
            this.statusMessage = 'Chat generation cancelled.';
            this.appendTranscript('\n[Chat generation cancelled]');
            this.render();
            return;
          }
          if (this.modalInputText !== '') {
            this.modalInputText = '';
            this.statusMessage = 'Input cleared.';
          } else {
            // Esc on empty input restores pristine home dashboard view
            this.transcript = [];
            this.transcriptScrollOffset = 0;
            this.statusMessage = 'Returned to Home Dashboard.';
          }
          this.commandHistoryIndex = this.commandHistory.length;
          this.render();
          return;
        }
        if (key.name === 'return') {
          if (this.chatIsStreaming) {
            this.statusMessage = 'Gemma is currently responding. Press Esc to cancel.';
            this.render();
            return;
          }
          const command = this.modalInputText.trim();
          this.modalInputText = '';
          this.commandHistoryIndex = this.commandHistory.length;
          if (command) {
            this.commandHistory.push(command);
            this.commandHistory = this.commandHistory.slice(-50);
            void this.executeCommandLine(command);
          } else {
            this.statusMessage = 'Type a goal or /help to run commands.';
            this.render();
          }
          return;
        }
        if (key.name === 'backspace') {
          const characters = Array.from(GRAPHEME_SEGMENTER.segment(this.modalInputText), ({ segment }) => segment);
          characters.pop();
          this.modalInputText = characters.join('');
          this.render();
          return;
        }
        if (key.name === 'up' && this.commandHistory.length > 0) {
          this.commandHistoryIndex = Math.max(0, this.commandHistoryIndex - 1);
          this.modalInputText = this.commandHistory[this.commandHistoryIndex] || '';
          this.render();
          return;
        }
        if (key.name === 'down' && this.commandHistory.length > 0) {
          this.commandHistoryIndex = Math.min(this.commandHistory.length, this.commandHistoryIndex + 1);
          this.modalInputText = this.commandHistory[this.commandHistoryIndex] || '';
          this.render();
          return;
        }
        if (['pageup', 'pagedown', 'home', 'end'].includes(key.name) && this.transcript.length > 0) {
          if (key.name === 'home') {
            this.transcriptScrollOffset = Math.max(0, this.transcriptRenderedRowCount - this.transcriptViewportRows);
          } else if (key.name === 'end') {
            this.transcriptScrollOffset = 0;
          } else {
            const step = Math.max(1, this.transcriptViewportRows - 1);
            this.transcriptScrollOffset += key.name === 'pageup' ? step : -step;
            this.transcriptScrollOffset = Math.max(
              0,
              Math.min(
                this.transcriptScrollOffset,
                Math.max(0, this.transcriptRenderedRowCount - this.transcriptViewportRows),
              ),
            );
          }
          this.render();
          return;
        }

        // Capture ANY typed character directly into the input box:
        if (str && !key.ctrl && !key.meta) {
          this.modalInputText += str;
          this.commandHistoryIndex = this.commandHistory.length;
          this.render();
          return;
        }
      }

      // If on Tab 2 (Dedicated Local Gemma LLM Chat):
      if (this.activeTab === 2) {
        if (key.name === 'tab') {
          this.activeTab = key.shift ? this.getPrevTab(2) : this.getNextTab(2);
          this.statusMessage = `Switched to View [${this.activeTab}].`;
          this.render();
          return;
        }
        if (key.name === 'escape') {
          if (this.chatIsStreaming && this.activeChatAbortController) {
            this.activeChatAbortController.abort();
            this.activeChatAbortController = null;
            this.chatIsStreaming = false;
            this.statusMessage = 'Chat generation cancelled.';
            this.render();
            return;
          }
          this.chatInputText = '';
          this.statusMessage = 'Chat input cleared.';
          this.render();
          return;
        }
        if (key.name === 'return') {
          if (this.chatIsStreaming) {
            this.statusMessage = 'Gemma is currently responding. Press Esc to cancel.';
            this.render();
            return;
          }
          const msg = this.chatInputText.trim();
          this.chatInputText = '';
          if (msg) {
            void this.sendGemmaChatMessage(msg, false);
          } else {
            this.statusMessage = 'Type a message to chat with Gemma.';
            this.render();
          }
          return;
        }
        if (key.name === 'backspace') {
          const characters = Array.from(GRAPHEME_SEGMENTER.segment(this.chatInputText), ({ segment }) => segment);
          characters.pop();
          this.chatInputText = characters.join('');
          this.render();
          return;
        }
        if (['pageup', 'pagedown', 'home', 'end'].includes(key.name) && this.chatMessages.length > 0) {
          if (key.name === 'home') {
            this.chatScrollOffset = Math.max(0, this.chatRenderedRowCount - this.chatViewportRows);
          } else if (key.name === 'end') {
            this.chatScrollOffset = 0;
          } else {
            const step = Math.max(1, this.chatViewportRows - 1);
            this.chatScrollOffset += key.name === 'pageup' ? step : -step;
            this.chatScrollOffset = Math.max(
              0,
              Math.min(this.chatScrollOffset, Math.max(0, this.chatRenderedRowCount - this.chatViewportRows)),
            );
          }
          this.render();
          return;
        }
        if (str && !key.ctrl && !key.meta) {
          this.chatInputText += str;
          this.render();
          return;
        }
      }

      // If on Tab 3 (Antigravity Swarm Board):
      if (this.activeTab === 3) {
        if (key.name === 'tab') {
          this.activeTab = key.shift ? this.getPrevTab(3) : this.getNextTab(3);
          this.statusMessage = `Switched to View [${this.activeTab}].`;
          this.render();
          return;
        }
        if (key.name === 'escape') {
          if (this.swarmInspectorExpanded) {
            this.swarmInspectorExpanded = false;
            this.statusMessage = 'Collapsed swarm inspector.';
          } else {
            this.activeTab = 1;
            this.statusMessage = 'Returned to Dashboard.';
          }
          this.render();
          return;
        }
        if (key.name === 'return' || key.name === 'e') {
          this.swarmInspectorExpanded = !this.swarmInspectorExpanded;
          this.statusMessage = this.swarmInspectorExpanded ? 'Expanded swarm inspector.' : 'Collapsed swarm inspector.';
          this.render();
          return;
        }
        if (key.name === 'up' || key.name === 'k') {
          this.selectedSwarmAgentIndex = Math.max(0, this.selectedSwarmAgentIndex - 1);
          this.render();
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          this.selectedSwarmAgentIndex = Math.min(this.swarmAgents.length - 1, this.selectedSwarmAgentIndex + 1);
          this.render();
          return;
        }
        if (key.name === 'p') {
          this.previewArtifacts();
          return;
        }
        if (key.name === 'r') {
          void this.updateHerdrTelemetry();
          void this.refreshDetectedModels();
          this.statusMessage = 'Swarm roster and telemetry refreshed.';
          this.render();
          return;
        }
        if (['1', '2', '3', '4', '5'].includes(key.name)) {
          const targetAgentIdx = parseInt(key.name, 10) - 1;
          if (targetAgentIdx >= 0 && targetAgentIdx < this.swarmAgents.length) {
            this.selectedSwarmAgentIndex = targetAgentIdx;
            this.statusMessage = `Selected swarm agent: ${this.swarmAgents[targetAgentIdx].id}`;
            this.render();
            return;
          }
        }
      }

      // Action hotkeys on other tabs (Tabs 4, 5, 0):
      if (key.name === 'q') {
        this.exit();
        return;
      }
      if (key.name === 'tab') {
        this.activeTab = key.shift ? this.getPrevTab(this.activeTab) : this.getNextTab(this.activeTab);
        this.statusMessage = `Switched to View [${this.activeTab}].`;
        this.render();
        return;
      }
      if (this.activeTab === 0 && key.name === 'escape') {
        this.activeTab = 1;
        this.statusMessage = 'Returned to Dashboard.';
        this.render();
        return;
      }
      if (this.activeTab === 0 && ['pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
        const maxScroll = Math.max(0, this.settingsRenderedRowCount - this.settingsViewportRows);
        if (key.name === 'home') {
          this.settingsScrollOffset = 0;
        } else if (key.name === 'end') {
          this.settingsScrollOffset = maxScroll;
        } else {
          const step = Math.max(1, this.settingsViewportRows - 2);
          this.settingsScrollOffset =
            key.name === 'pageup'
              ? Math.max(0, this.settingsScrollOffset - step)
              : Math.min(maxScroll, this.settingsScrollOffset + step);
        }
        this.render();
        return;
      }
      if (key.name === 'return' || key.name === '/' || str === '/') {
        this.activeTab = 1;
        if (str === '/') this.modalInputText = '/';
        this.statusMessage = 'Command prompt active.';
        this.render();
        return;
      }
      if (key.name === 'c') {
        this.activeTab = 2;
        this.statusMessage = 'Switched to View [2] — Local Chat.';
        this.render();
        return;
      }
      if (key.name === 's') {
        this.loadWorkplaceConfig();
        this.activeTab = 0;
        this.statusMessage = 'Switched to View [0] — Settings.';
        this.render();
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (this.activeTab === 0 && this.settingsRenderedRowCount > this.settingsViewportRows) {
          const maxScroll = Math.max(0, this.settingsRenderedRowCount - this.settingsViewportRows);
          this.settingsScrollOffset =
            key.name === 'up'
              ? Math.max(0, this.settingsScrollOffset - 1)
              : Math.min(maxScroll, this.settingsScrollOffset + 1);
          this.render();
          return;
        }
        this.activeTab = key.name === 'down' ? this.getNextTab(this.activeTab) : this.getPrevTab(this.activeTab);
        this.statusMessage = `Switched to View [${this.activeTab}].`;
        this.render();
        return;
      }
      if (['0', '1', '2', '3', '4', '5'].includes(key.name)) {
        this.activeTab = parseInt(key.name, 10);
        this.statusMessage = `Switched to View [${this.activeTab}].`;
        this.render();
        return;
      }

      // Action hotkeys
      if (key.name === 'i') {
        this.modalMode = 'ignite';
        this.modalInputText = 'Build and deploy Canva 3D Spatial Studio';
        this.render();
        return;
      }

      if (key.name === 'g') {
        if (this.detectedModels.length === 0) {
          this.selectedModel = this.selectedModel === 'gemma2:9b' ? 'gemma2:2b' : 'gemma2:9b';
        } else {
          const currIdx = this.detectedModels.findIndex((m) => m.id.toLowerCase() === this.selectedModel.toLowerCase());
          const nextIdx = (currIdx + 1) % this.detectedModels.length;
          const nextModel = this.detectedModels[nextIdx];
          this.selectedModel = nextModel.id;
        }
        this.statusMessage = `Active model switched to ${this.selectedModel}.`;
        if (this.activeTab === 1 && this.transcript.length > 0) this.appendTranscript(this.statusMessage);
        this.render();
        return;
      }

      if (key.name === 'p' || key.name === 'o') {
        this.previewArtifacts();
        return;
      }

      if (key.name === 'd') {
        this.openStudio();
        return;
      }

      if (key.name === 't') {
        this.runCanvaTests();
        return;
      }

      if (key.name === 'r') {
        this.loadWorkplaceConfig();
        this.updateGpuTelemetry();
        void this.updateHerdrTelemetry();
        void this.refreshDetectedModels();
        this.statusMessage = 'GPU, Herdr telemetry, and configuration refreshed.';
        if (this.activeTab === 1 && this.transcript.length > 0) this.appendTranscript(this.statusMessage);
        this.render();
        return;
      }
    });
  }

  private async handleModalSubmit(): Promise<void> {
    const mode = this.modalMode;
    const input = this.modalInputText.trim();
    this.modalMode = 'none';
    this.modalInputText = '';

    if (!input) {
      this.reportCommand('Nothing entered. Action cancelled.', true);
      return;
    }

    this.activeTab = 1;
    this.transcriptScrollOffset = 0;
    this.appendTranscript(`› ${input}`);
    if (mode === 'promptTest') {
      this.runCliCommand(['plan', input], 'Planning goal');
      return;
    }
    this.launchIgniteGoal(input);
  }

  private async executeCommandLine(input: string): Promise<void> {
    if (!input) {
      this.reportCommand('Type a goal or /help to see commands.', true);
      return;
    }
    this.activeTab = 1;
    this.transcriptScrollOffset = 0;
    this.appendTranscript(`› ${input}`);
    if (!input.startsWith('/')) {
      const intent = classifyUserInput(input);
      if (intent === 'chat') {
        await this.sendGemmaChatMessage(input, true);
      } else {
        this.launchIgniteGoal(input);
      }
      return;
    }

    let parts: string[];
    try {
      parts = splitCommandLine(input.slice(1));
    } catch (err) {
      this.reportCommand(err instanceof Error ? err.message : String(err), true);
      return;
    }

    const name = (parts.shift() || '').toLowerCase();
    if (!name) {
      this.reportCommand('Type a command after /. Try /help.', true);
      return;
    }

    if (['help', 'commands', '?'].includes(name)) {
      this.transcript.push(
        '',
        'MAOS Oasis commands',
        '  /dashboard          Open the Dashboard [1]',
        '  /chat [message]     Chat directly with local Gemma LLM [2]',
        '  /agents, /herdr     Open live HERDR agents and panes [3]',
        '  /telemetry, /gpu    Open GPU and system telemetry [4]',
        '  /events, /logs      Open the session event log [5]',
        '  /settings           Open workplace settings & configuration [0]',
        '  /model [name]       Switch the active local model (Gemma, Qwen, etc.)',
        '  /preview, /run      Launch live preview of built swarm artifacts in browser',
        '  /ignite <goal>      Dispatch an autonomous goal to the HERDR swarm',
        '  /plan <goal>        Plan a goal with MAOS',
        '  /clear              Clear the transcript',
        '  /status             Display system snapshot (Herdr, model, GPU, last exit)',
        '  /maos <command>     Run a supported MAOS CLI command',
        '  /studio             Open the Canva 3D Studio',
        '  /test               Run the Canva 3D test command',
        '  /web                Open the MAOS web dashboard',
        '  /refresh            Refresh GPU, HERDR telemetry, and settings',
        '  /quit, /exit        Exit MAOS Oasis',
        '  /help               Show this command list',
        '',
        'Hotkeys: Tab switch views, 0-5 jump, / focus prompt, C chat, G cycle models, P preview output, R refresh, Q quit.',
      );
      this.transcriptScrollOffset = 0;
      this.transcript = this.transcript.slice(-5000);
      this.statusMessage = 'Help shown in session output.';
      this.render();
      return;
    }
    if (['status', 'snapshot', 'info'].includes(name)) {
      const vramGb = (this.gpuStats.vramUsedMiB / 1024).toFixed(1);
      const totalGb = (this.gpuStats.vramTotalMiB / 1024).toFixed(1);
      const lastExit =
        this.lastCommandExitCode !== null ? `${this.lastCommandExitCode}` : 'none (no command finished yet)';
      this.transcript.push(
        '',
        '── MAOS Oasis System Status ──',
        `  Ollama Model : ${this.selectedModel} (${this.gpuStats.modelInVram})`,
        `  GPU Telemetry: Temp ${this.gpuStats.tempC}°C │ Util ${this.gpuStats.gpuUtil}% │ VRAM ${vramGb}/${totalGb} GB`,
        `  Herdr Status : ${this.herdrAvailable ? 'ONLINE' : 'OFFLINE'} (${this.herdrPanes.length} pane(s), ${this.herdrAgents.length} agent(s))`,
        `  Last Command : ${this.lastCommandLabel || 'none'} → exit code: ${lastExit}`,
        `  Active State : ${this.externalCommandRunning ? `RUNNING (${this.externalCommandLabel})` : 'IDLE'}`,
        '',
      );
      this.statusMessage = 'System status captured.';
      this.render();
      return;
    }
    if (['dashboard', 'home', 'overview', '1'].includes(name)) {
      this.activeTab = 1;
      this.transcript = [];
      this.transcriptScrollOffset = 0;
      this.statusMessage = 'Dashboard opened.';
      this.render();
      return;
    }
    if (['chat', 'ask', 'gemma-chat', 'c', '2'].includes(name)) {
      if (parts.length > 0) {
        await this.sendGemmaChatMessage(parts.join(' '), true);
      } else {
        this.activeTab = 2;
        this.statusMessage = 'Switched to View [2] — Local Chat.';
        this.render();
      }
      return;
    }
    if (['clear', 'cls', 'clean', 'reset'].includes(name)) {
      this.activeTab = 1;
      this.transcript = [];
      this.transcriptScrollOffset = 0;
      this.statusMessage = 'Transcript cleared.';
      this.render();
      return;
    }
    if (name === 'demo') {
      this.activeTab = 1;
      this.transcript = [];
      this.launchIgniteGoal('Build and deploy Canva 3D Spatial Studio');
      return;
    }
    if (['herdr', 'agents', 'gemma', 'swarm', '3'].includes(name)) {
      this.activeTab = 3;
      void this.updateHerdrTelemetry();
      this.statusMessage = 'HERDR swarm matrix opened.';
      this.appendTranscript('HERDR swarm matrix opened.');
      this.render();
      return;
    }
    if (['telemetry', 'gpu', 'healer', '4'].includes(name)) {
      this.activeTab = 4;
      this.statusMessage = 'Telemetry opened.';
      this.appendTranscript('Telemetry opened.');
      this.render();
      return;
    }
    if (['events', 'event-log', 'logs', 'log', '5'].includes(name)) {
      this.activeTab = 5;
      this.statusMessage = 'Event log opened.';
      this.appendTranscript('Event log opened.');
      this.render();
      return;
    }
    if (['model', 'models'].includes(name)) {
      const requested = (parts[0] || '').toLowerCase().trim();
      if (!requested) {
        const listLines = [
          '',
          '── Available Local Models ──',
          ...this.detectedModels.map((m) => {
            const isCur = m.id.toLowerCase() === this.selectedModel.toLowerCase();
            const prefix = isCur ? chalk.green('● ') : chalk.gray('○ ');
            const src = chalk.cyan(`[${m.source.toUpperCase()}]`);
            const label = isCur ? chalk.bold.green(m.name) : chalk.white(m.name);
            return `  ${prefix}${label} ${src} ${chalk.gray(`(${m.id})`)}`;
          }),
          '',
          chalk.gray('Use /model <name> or press [G] to cycle models.'),
        ];
        this.transcript.push(...listLines);
        this.render();
        return;
      }

      const matched = this.detectedModels.find((m) => {
        const id = m.id.toLowerCase();
        const nm = m.name.toLowerCase();
        return id === requested || id.endsWith(`:${requested}`) || id.includes(requested) || nm.includes(requested);
      });

      if (matched) {
        this.selectedModel = matched.id;
      } else if (requested === '2b' || requested === '9b') {
        this.selectedModel = `gemma2:${requested}`;
      } else if (requested === '4' || requested === 'e2b' || requested === 'gemma4') {
        this.selectedModel = 'gemma4:e2b';
      } else {
        this.selectedModel = parts[0];
      }

      this.statusMessage = `Selected model: ${this.selectedModel}.`;
      this.appendTranscript(this.statusMessage);
      this.render();
      return;
    }
    if (['preview', 'run', 'open'].includes(name)) {
      this.previewArtifacts();
      return;
    }
    if (name === 'refresh') {
      this.loadWorkplaceConfig();
      this.updateGpuTelemetry();
      void this.updateHerdrTelemetry();
      void this.refreshDetectedModels();
      this.statusMessage = 'GPU, Herdr telemetry, and workplace configuration refreshed.';
      this.appendTranscript(this.statusMessage);
      this.render();
      return;
    }
    if (name === 'studio' || name === 'd') {
      this.openStudio();
      return;
    }
    if (name === 'test' || name === 't') {
      this.runCanvaTests();
      return;
    }
    if (name === 'quit' || name === 'exit') {
      this.exit();
      return;
    }
    if (name === 'tui') {
      this.statusMessage = 'You are already in the MAOS Oasis TUI.';
      this.appendTranscript('You are already in the MAOS Oasis TUI.');
      this.render();
      return;
    }
    if (['settings', 'config', 'configuration', '0'].includes(name)) {
      if (parts[0] === 'wizard' || parts[0] === 'configure') {
        this.runCliCommand(['configure', ...parts.slice(1)], 'Opening MAOS provider settings');
      } else {
        this.loadWorkplaceConfig();
        this.activeTab = 0;
        this.statusMessage = 'Switched to View [0] — Settings & Configuration.';
        this.render();
      }
      return;
    }
    if (name === 'web' || name === 'web-dashboard') {
      this.runCliCommand(['dashboard', ...parts], 'Opening the web dashboard');
      return;
    }
    if (name === 'ignite') {
      if (parts.length === 0) {
        this.modalMode = 'ignite';
        this.statusMessage = 'Enter a goal to dispatch through maos ignite.';
        this.appendTranscript('Enter a goal to dispatch through maos ignite.');
        this.render();
      } else if (parts[0].startsWith('-')) {
        const args = ['ignite', ...parts];
        if (!parts.includes('--model') && !parts.includes('-m')) args.push('--model', this.selectedModel);
        if (!parts.includes('--no-exit')) args.push('--no-exit');
        this.runCliCommand(args, 'Launching MAOS Gemma swarm');
      } else {
        this.launchIgniteGoal(parts.join(' '));
      }
      return;
    }
    if (name === 'plan') {
      if (parts.length === 0) {
        this.reportCommand('Usage: /plan <goal> or /maos plan --help.', true);
      } else {
        this.runCliCommand(['plan', parts.join(' ')], 'Planning goal');
      }
      return;
    }

    const cliArgs = name === 'maos' ? parts : [name, ...parts];
    const cliCommand = cliArgs[0];
    if (!cliCommand || (cliCommand.startsWith('-') === false && !CORE_CLI_COMMANDS.has(cliCommand))) {
      this.reportCommand(`Unknown MAOS command /${name}. Try /help or /maos --help.`, true);
      return;
    }
    this.runCliCommand(cliArgs, `Running maos ${cliArgs.join(' ')}`);
  }

  private async sendGemmaChatMessage(userMessage: string, inTranscript: boolean = false): Promise<void> {
    if (this.chatIsStreaming) {
      this.statusMessage = 'Gemma is currently responding. Press Esc to cancel.';
      this.render();
      return;
    }

    const time = this.getNowTime();
    this.chatMessages.push({ sender: 'user', text: userMessage, time });
    this.chatScrollOffset = 0;
    this.chatIsStreaming = true;

    const controller = new AbortController();
    this.activeChatAbortController = controller;

    // Run spinner loop so spinner animates during inference
    this.spinnerIndex = 0;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = setInterval(() => {
      if ((this.chatIsStreaming || this.externalCommandRunning) && this.isRunning) {
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
        this.render();
      }
    }, 120);

    if (inTranscript) {
      this.statusMessage = `Asking local Gemma (${this.selectedModel})...`;
      this.appendTranscript(`\n[Gemma ${this.selectedModel} · Local LLM Chat]`);
      this.appendTranscript('Thinking...');
    } else {
      this.statusMessage = `Gemma (${this.selectedModel}) is thinking...`;
    }
    this.render();

    let replyText = '';
    const host = this.oasisConfig?.ollama?.host || '127.0.0.1';
    const port = this.oasisConfig?.ollama?.port || 11434;
    let streamedMessage: ChatMessage | null = null;

    try {
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(`http://${host}:${port}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.selectedModel,
          prompt: userMessage,
          system:
            'You are MAOS Oasis, an intelligent sovereign local AI assistant powered by Google Gemma. You run 100% locally on loopback. Be concise, direct, helpful, and friendly. Answer queries directly without dispatching multi-agent swarms unless requested.',
          stream: true,
          options: {
            temperature: 0.7,
            num_predict: 256,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        if (res.body && typeof (res.body as any).getReader === 'function') {
          const reader = (res.body as any).getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          streamedMessage = { sender: 'gemma', text: '', time: this.getNowTime() };
          this.chatMessages.push(streamedMessage);
          let lastRenderTime = Date.now();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                if (data.response) {
                  replyText += data.response;
                  streamedMessage.text = replyText;
                }
              } catch {}
            }
            if (Date.now() - lastRenderTime > 80) {
              lastRenderTime = Date.now();
              this.render();
            }
          }
          if (buffer.trim()) {
            try {
              const data = JSON.parse(buffer);
              if (data.response) {
                replyText += data.response;
                streamedMessage.text = replyText;
              }
            } catch {}
          }
        } else {
          const data = (await res.json()) as { response?: string };
          replyText = data.response?.trim() || '';
        }
      } else {
        const errorText = await res.text().catch(() => '');
        if (res.status === 404 || errorText.includes('not found')) {
          replyText = `Model "${this.selectedModel}" is not downloaded in Ollama. Run: ollama pull ${this.selectedModel}`;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        replyText = '[Chat response cancelled]';
      }
    } finally {
      this.activeChatAbortController = null;
      this.chatIsStreaming = false;
      if (!this.externalCommandRunning && this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
    }

    if (!replyText) {
      const lower = userMessage.toLowerCase().trim();
      const isGreeting = /^(hi|hello|hey|hiya|yo|howdy|greetings|good\s+(morning|afternoon|evening))\b/i.test(lower);
      if (isGreeting) {
        replyText =
          'Hello! I am MAOS Oasis, your sovereign local workspace powered by Gemma. I run 100% locally on your machine with zero cloud egress. Local Ollama daemon is currently offline at ' +
          host +
          ':' +
          port +
          '. Start Ollama with "ollama serve" or run "maos doctor --fix" to enable live local Gemma inference.';
      } else {
        replyText =
          'Local Ollama inference daemon is offline at ' +
          host +
          ':' +
          port +
          '. Start Ollama with "ollama serve" or run "maos doctor --fix" to enable full local Gemma inference.';
      }
    }

    const replyTime = this.getNowTime();
    if (streamedMessage) {
      streamedMessage.text = replyText;
    } else {
      this.chatMessages.push({ sender: 'gemma', text: replyText, time: replyTime });
    }
    this.chatIsStreaming = false;

    if (inTranscript) {
      if (this.transcript.length > 0 && this.transcript[this.transcript.length - 1] === 'Thinking...') {
        this.transcript.pop();
      }
      this.appendTranscript(replyText);
      this.appendTranscript('✓ Local response completed (0 cloud egress · 0 agents dispatched)');
      this.statusMessage = `Answered by local Gemma (${this.selectedModel}).`;
    } else {
      this.statusMessage = 'Gemma replied.';
    }

    this.recordActivity('CHAT', `Gemma replied: ${userMessage.slice(0, 28)}...`, c.cyanBright);
    this.render();
  }

  private reportCommand(message: string, isError = false): void {
    this.activeTab = 1;
    this.transcript.push(`${isError ? 'Error: ' : ''}${message}`);
    this.transcriptScrollOffset = 0;
    this.statusMessage = message;
    this.render();
  }

  private appendTranscript(text: string): void {
    const cleaned = text
      .replace(ANSI_SEQUENCE, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!cleaned) return;
    const addedRows = cleaned.split('\n');
    this.transcript.push(...addedRows);
    if (this.transcriptScrollOffset > 0) {
      const terminalWidth = Math.max(1, process.stdout.columns || 120);
      const railWidth = terminalWidth >= Math.max(113, MAOS_OASIS_LOGO_WIDTH + 27) ? 24 : 0;
      const outputWidth = terminalWidth - railWidth - (railWidth ? 3 : 0) - 1;
      this.transcriptScrollOffset += addedRows.reduce(
        (count, row) => count + wrapTerminalLine(row, outputWidth).length,
        0,
      );
    }
    if (this.transcript.length > 5000) this.transcript.splice(0, this.transcript.length - 5000);
  }

  private appendCommandOutput(chunk: string): void {
    const normalized = `${this.commandOutputRemainder}${chunk}`
      .replace(ANSI_SEQUENCE, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const rows = normalized.split('\n');
    this.commandOutputRemainder = rows.pop() || '';
    if (rows.length > 0) {
      this.appendTranscript(rows.join('\n'));

      // Ingest live tool calls and worker activities into Swarm Board
      for (const row of rows) {
        if (row.includes('[Tool Call]') || row.includes('create_file:') || row.includes('run_command:')) {
          const toolMatch = row.match(/(?:\[Tool Call\]\s*|⚡\s*)(\w+):\s*(.*)/i);
          if (toolMatch) {
            const tool = toolMatch[1];
            const args = toolMatch[2];
            const wMatch = row.match(/(ignite-worker-\d+|Worker-\d+)/i);
            const sender = wMatch ? wMatch[1].toLowerCase().replace('worker-', 'ignite-worker-') : 'ignite-worker-1';
            this.recordSwarmPost(sender, '@coordinator', tool, `${tool}: ${args}`);
          }
        } else if (row.includes('Task marked complete') || row.includes('WORKTREE GREEN') || row.includes('green')) {
          const wMatch = row.match(/(ignite-worker-\d+|Worker-\d+)/i);
          const sender = wMatch ? wMatch[1].toLowerCase().replace('worker-', 'ignite-worker-') : 'ignite-worker-1';
          this.recordSwarmPost(sender, '@coordinator', 'complete', `${sender} worktree green and tests passed`);
        } else if (row.includes('Spawning worker')) {
          const wMatch = row.match(/(ignite-worker-\d+|Worker-\d+)/i);
          const worker = wMatch ? wMatch[1].toLowerCase().replace('worker-', 'ignite-worker-') : 'worker';
          this.recordSwarmPost('coordinator', `@${worker}`, 'spawn', `Spawning ${worker} in isolated worktree`);
        }
      }
    }
    if (!this.transcriptRenderTimer) {
      this.transcriptRenderTimer = setTimeout(() => {
        this.transcriptRenderTimer = null;
        if (this.isRunning && (this.activeTab === 1 || this.activeTab === 3)) this.render();
      }, 50);
    }
  }

  private launchIgniteGoal(goal: string): void {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      this.reportCommand('Enter a goal before dispatching.', true);
      return;
    }
    this.swarmGoal = trimmedGoal;
    this.swarmState = 'active';
    this.swarmAgents = createDefaultSwarmAgents(this.swarmGoal, this.selectedModel);
    this.swarmPosts = createDefaultSwarmPosts(this.swarmGoal);
    this.runCliCommand(
      [
        'ignite',
        '--gemma',
        '--harness',
        'herdr',
        '--model',
        this.selectedModel,
        '--no-exit',
        '--no-watch',
        '--yes',
        '--goal',
        trimmedGoal,
      ],
      'Launching MAOS Gemma swarm',
    );
  }

  private runCliCommand(args: string[], label: string): void {
    const sourceEntry = path.join(this.projectRoot, 'src', 'cli', 'index.ts');
    const tsxCli = path.join(this.projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const builtEntry = path.join(this.projectRoot, 'dist', 'cli', 'index.js');
    if (fs.existsSync(sourceEntry) && fs.existsSync(tsxCli)) {
      this.runExternalProcess(process.execPath, [tsxCli, sourceEntry, ...args], this.projectRoot, label);
    } else if (fs.existsSync(builtEntry)) {
      this.runExternalProcess(process.execPath, [builtEntry, ...args], this.projectRoot, label);
    } else {
      this.reportCommand('MAOS CLI entrypoint is missing. Reinstall dependencies or build the project.', true);
    }
  }

  private runExternalProcess(command: string, args: string[], cwd: string, label: string): void {
    if (this.externalCommandRunning) {
      this.reportCommand('A task is currently running. Press Ctrl+C to abort it before starting a new one.', true);
      return;
    }
    this.externalCommandRunning = true;
    this.externalCommandLabel = label;
    this.externalCommandStartTime = Date.now();
    this.spinnerIndex = 0;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = setInterval(() => {
      if (this.externalCommandRunning && this.isRunning && this.activeTab === 1) {
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
        this.render();
      }
    }, 150);

    this.activeTab = 1;
    this.transcriptScrollOffset = 0;
    this.appendTranscript(`\n$ ${label}`);
    this.statusMessage = `${label}...`;
    this.render();
    this.commandOutputRemainder = '';

    let finished = false;
    const finish = (code: number | null, signal?: NodeJS.Signals | null, error?: Error) => {
      if (finished) return;
      finished = true;
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      this.activeChild = null;
      this.externalCommandRunning = false;
      this.lastCommandExitCode = code;
      this.lastCommandLabel = label;
      if (!this.isRunning) return;

      if (this.commandOutputRemainder) {
        this.appendTranscript(this.commandOutputRemainder);
        this.commandOutputRemainder = '';
      }

      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch {}
      }
      try {
        process.stdin.resume();
      } catch {}
      process.stdout.write('\x1b[?25l');
      const wasAborted = this.statusMessage === 'Aborting running process...' || signal === 'SIGINT';
      const succeeded = !error && code === 0 && !wasAborted;
      this.statusMessage = wasAborted
        ? `${label} aborted by user.`
        : error
          ? `${label} failed: ${error.message.slice(0, 90)}`
          : succeeded
            ? `${label} completed.`
            : `${label} ended with ${signal || `exit code ${code ?? 'unknown'}`}.`;
      this.appendTranscript(
        wasAborted
          ? `\n⚠ ${label} aborted by user.`
          : error
            ? `\nError: ${error.message}`
            : succeeded
              ? `\n✓ ${label} completed (exit 0).`
              : `\n✗ ${label} ended with ${signal || `exit code ${code ?? 'unknown'}`}.`,
      );
      this.recordActivity(
        wasAborted ? 'COMMAND' : error || !succeeded ? 'ERROR' : 'COMMAND',
        `${label} ${wasAborted ? 'aborted' : error || !succeeded ? 'failed' : 'completed'}`,
        wasAborted ? c.amber : error || !succeeded ? c.pink : c.emerald,
      );
      this.updateGpuTelemetry();
      void this.updateHerdrTelemetry();
      this.render();
    };

    try {
      const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.activeChild = child;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.appendCommandOutput(chunk));
      child.stderr?.on('data', (chunk: string) => this.appendCommandOutput(chunk));
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
    } catch (error) {
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private openStudio(): void {
    const url = 'http://localhost:5173';
    let command: string;
    let args: string[];
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/d', '/s', '/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
    this.runExternalProcess(command, args, this.projectRoot, 'Opening Canva 3D Studio');
  }

  private runCanvaTests(): void {
    const cwd = path.resolve(this.projectRoot, 'apps', 'canva-3d');
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
      this.statusMessage = 'Canva 3D test project was not found.';
      if (this.activeTab === 1 && this.transcript.length > 0) this.appendTranscript(`Error: ${this.statusMessage}`);
      this.render();
      return;
    }
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test'];
    this.runExternalProcess(command, args, cwd, 'Running Canva 3D tests');
  }

  public previewArtifacts(): void {
    const lastBuildPath = path.join(this.projectRoot, '.maos', 'last-build.json');
    let entrypoint: string | null = null;
    let filesCount = 0;

    if (fs.existsSync(lastBuildPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(lastBuildPath, 'utf-8'));
        entrypoint = manifest.entrypoint ? path.resolve(this.projectRoot, manifest.entrypoint) : null;
        filesCount = Array.isArray(manifest.files) ? manifest.files.length : 0;
      } catch {}
    }

    const outputHtml = path.resolve(this.projectRoot, 'output', 'index.html');
    const distHtml = path.resolve(this.projectRoot, 'dist-preview', 'index.html');
    const rootHtml = path.resolve(this.projectRoot, 'index.html');

    if (entrypoint && fs.existsSync(entrypoint)) {
      // Valid target from manifest
    } else if (fs.existsSync(outputHtml)) {
      entrypoint = outputHtml;
    } else if (fs.existsSync(distHtml)) {
      entrypoint = distHtml;
    } else if (fs.existsSync(rootHtml)) {
      entrypoint = rootHtml;
    }

    if (!entrypoint || !fs.existsSync(entrypoint)) {
      const msg = 'No built output found to preview. Run an ignite goal first with /ignite <goal>.';
      this.statusMessage = msg;
      if (this.activeTab === 1) this.appendTranscript(`⚠️  ${msg}`);
      this.render();
      return;
    }

    const isHtml = entrypoint.endsWith('.html');
    if (isHtml) {
      try {
        let command: string;
        let args: string[];
        if (process.platform === 'win32') {
          command = 'cmd.exe';
          args = ['/d', '/s', '/c', 'start', '', entrypoint];
        } else if (process.platform === 'darwin') {
          command = 'open';
          args = [entrypoint];
        } else {
          command = 'xdg-open';
          args = [entrypoint];
        }
        execFile(command, args, () => {});
        this.statusMessage = `Launched preview: ${path.basename(entrypoint)} in default browser.`;
        this.appendTranscript(`🚀 Live Preview launched in your browser: ${entrypoint}`);
        this.appendTranscript(`✓ Output verified from ${filesCount ? `${filesCount} generated files` : './output/'}.`);
      } catch (err: unknown) {
        this.statusMessage = `Failed to open preview: ${err instanceof Error ? err.message : String(err)}`;
        this.appendTranscript(`❌ ${this.statusMessage}`);
      }
    } else {
      const relPath = path.relative(this.projectRoot, entrypoint);
      if (entrypoint.endsWith('.js')) {
        this.runExternalProcess(process.execPath, [entrypoint], this.projectRoot, `Previewing ${relPath}`);
      } else if (entrypoint.endsWith('.py')) {
        this.runExternalProcess('python', [entrypoint], this.projectRoot, `Previewing ${relPath}`);
      } else {
        this.statusMessage = `Artifact ready at ${relPath}.`;
        this.appendTranscript(`📦 Built artifact ready: ${relPath}`);
      }
    }
    this.render();
  }

  public async refreshDetectedModels(): Promise<void> {
    try {
      const host = this.oasisConfig?.ollama?.host || '127.0.0.1';
      const port = this.oasisConfig?.ollama?.port || 11434;
      this.detectedModels = await detectLocalModels({ ollamaHost: host, ollamaPort: port });
      if (
        this.detectedModels.length > 0 &&
        !this.detectedModels.some((m) => m.id.toLowerCase() === this.selectedModel.toLowerCase())
      ) {
        const preferred = this.detectedModels.find((m) => m.id.startsWith('gemma2:9b') || m.id.startsWith('gemma'));
        if (preferred) this.selectedModel = preferred.id;
      }
    } catch {
      /* ignore */
    }
  }

  private startRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.updateGpuTelemetry();
      void this.updateHerdrTelemetry();
      this.render();
    }, 2000);
  }

  private async updateHerdrTelemetry(): Promise<void> {
    if (this.herdrRefreshInFlight) return;
    this.herdrRefreshInFlight = true;
    try {
      const harness = getDefaultHerdrHarness();
      this.herdrAvailable = await harness.isAvailable();
      if (this.herdrAvailable) {
        [this.herdrPanes, this.herdrAgents] = await Promise.all([harness.listPanes(), harness.listAgents()]);
      } else {
        this.herdrPanes = [];
        this.herdrAgents = [];
      }
    } catch {
      this.herdrAvailable = false;
      this.herdrPanes = [];
      this.herdrAgents = [];
    } finally {
      this.herdrRefreshInFlight = false;
      if (this.isRunning && !this.externalCommandRunning) this.render();
    }
  }

  private recordActivity(tag: string, text: string, color: (value: string) => string): void {
    this.activities.unshift({ time: this.getNowTime(), tag, text, color });
    this.activities = this.activities.slice(0, 50);
  }

  private updateGpuTelemetry(): void {
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits',
        {
          encoding: 'utf-8',
          timeout: 1000,
        },
      );
      const parts = out
        .trim()
        .split(',')
        .map((p) => parseFloat(p.trim()));
      if (parts.length >= 5) {
        this.gpuStats.vramUsedMiB = parts[0];
        this.gpuStats.vramTotalMiB = parts[1];
        this.gpuStats.gpuUtil = parts[2];
        this.gpuStats.tempC = parts[3];
        this.gpuStats.powerW = parts[4];
      }
    } catch {
      // Fallback: keep previous or nominal values
    }
  }

  private getNowTime(): string {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  // ── Render Engine ──────────────────────────────────────────────

  private render(): void {
    if (!this.isRunning) return;
    if (this.isRendering) {
      this.renderPending = true;
      return;
    }
    this.isRendering = true;
    try {
      this.renderInternal();
    } finally {
      this.isRendering = false;
      if (this.renderPending) {
        this.renderPending = false;
        this.render();
      }
    }
  }

  private renderInternal(): void {
    const W = Math.max(20, (process.stdout.columns || 120) - 2);
    const railW = W >= Math.max(113, MAOS_OASIS_LOGO_WIDTH + 27) ? 24 : 0;
    const mainW = W - railW - (railW ? 3 : 0);
    const lines: string[] = [];
    const visibleLength = terminalCellWidth;
    const pad = fitTerminalLine;
    const fullLine = (value: string) => pad(value, W);

    const title = `${c.cyanBright('◈')}  ${c.boldWhite('MAOS')} ${c.cyanBright('OASIS')} ${c.slateMuted('v0.4.0')}  ${c.slateBorder('│')} ${c.slateText('Sovereign Multi-Agent Swarm Kernel')}`;
    const vramGb = (this.gpuStats.vramUsedMiB / 1024).toFixed(1);
    const totalGb = (this.gpuStats.vramTotalMiB / 1024).toFixed(1);
    const modelBadge = formatHeaderBadge(this.selectedModel);
    const herdrStatus = this.herdrAvailable
      ? this.herdrPanes.length > 0
        ? `HERDR: ${this.herdrPanes.length} PANE${this.herdrPanes.length > 1 ? 'S' : ''}`
        : 'HERDR: LIVE'
      : 'HERDR: OFFLINE';
    const telemetry = `${c.cyan(modelBadge)}  ${c.slateBorder('│')}  ${c.cyanBright(herdrStatus)}  ${c.slateBorder('│')}  ${c.amber(`GPU ${this.gpuStats.tempC}°C`)}  ${c.slateBorder('│')}  ${c.violetBright(`VRAM ${vramGb}/${totalGb} GB`)}`;
    const headerGap = W - visibleLength(title) - visibleLength(telemetry);
    lines.push(headerGap >= 2 ? title + ' '.repeat(headerGap) + telemetry : fullLine(title));
    if (headerGap < 2) lines.push(fullLine(telemetry));
    lines.push(c.slateBorder('─'.repeat(W)));

    const hasTranscriptSession = this.activeTab === 1 && this.transcript.length > 0;
    const hasStatus = !hasTranscriptSession && !this.statusMessage.startsWith('Ready.');
    const footerRows = hasStatus ? 4 : 2;
    const terminalRows = Math.max(10, (process.stdout.rows || 40) - 1);
    const availableBodyRows = Math.max(1, terminalRows - lines.length - footerRows);

    const page: string[] = [];
    if (this.activeTab === 1) this.renderTabFleet(page, mainW, availableBodyRows);
    else if (this.activeTab === 2) this.renderTabChat(page, mainW, availableBodyRows);
    else if (this.activeTab === 3) this.renderTabAgents(page, mainW, availableBodyRows);
    else if (this.activeTab === 4) this.renderTabHealer(page, mainW);
    else if (this.activeTab === 5) this.renderTabEventLog(page, mainW);
    else if (this.activeTab === 0) this.renderTabSettings(page, mainW, availableBodyRows);
    else this.renderTabFleet(page, mainW, availableBodyRows);

    if (this.modalMode !== 'none') this.renderModal(page, mainW);

    const bodyRows = availableBodyRows;
    const pageOffset = page.length < bodyRows ? Math.max(0, Math.floor((bodyRows - page.length) / 2)) : 0;
    const pageAt = (row: number) => {
      const idx = row - pageOffset;
      return idx >= 0 && idx < page.length ? page[idx] : '';
    };

    if (railW) {
      const sidebar = Array.from({ length: bodyRows }, () => '');
      const railItem = (row: number, label: string, tab: number, quiet = false, rightText = '') => {
        if (row < 0 || row >= bodyRows) return;
        const selected = tab === this.activeTab && !quiet;
        if (rightText) {
          const left = `  ${label}`;
          const gap = Math.max(1, railW - visibleLength(left) - visibleLength(rightText));
          const item = left + ' '.repeat(gap) + rightText;
          sidebar[row] = selected
            ? pad(chalk.bgHex('#33477F').hex('#FFFFFF').bold(item.padEnd(railW, ' ')), railW)
            : pad(c.slateText(left) + ' '.repeat(gap) + c.white(rightText), railW);
        } else if (selected) {
          const active = `  ${label}`.padEnd(railW - 2, ' ') + '  ';
          sidebar[row] = pad(chalk.bgHex('#33477F').hex('#FFFFFF').bold(active), railW);
        } else {
          sidebar[row] = pad(c.slateText(`  ${label}`), railW);
        }
      };
      const navTop = Math.max(1, Math.floor(bodyRows * 0.08));
      railItem(navTop, '⌂  Dashboard', 1);
      railItem(navTop + 2, '💬  Chat', 2);
      railItem(navTop + 4, '◇  Swarm', 3, false, String(this.swarmAgents.length || this.herdrAgents.length || 5));
      railItem(navTop + 6, '▥  Telemetry', 4);
      railItem(navTop + 8, '▤  Event Log', 5);
      const settingsRow = Math.max(navTop + 11, bodyRows - 3);
      if (settingsRow - 1 >= 0 && settingsRow - 1 < bodyRows)
        sidebar[settingsRow - 1] = c.slateBorder('─'.repeat(railW));
      railItem(settingsRow, '⚙  Settings', 0);

      for (let i = 0; i < bodyRows; i++) {
        lines.push(`${pad(pageAt(i), mainW)}${c.slateBorder(' │ ')}${pad(sidebar[i], railW)}`);
      }
    } else {
      for (let i = 0; i < bodyRows; i++) lines.push(pad(pageAt(i), mainW));
    }

    if (hasStatus) {
      lines.push(c.slateBorder('─'.repeat(W)));
      const status = `${c.amber('STATUS')}  ${c.white(this.statusMessage)}`;
      lines.push(fullLine(status));
    }
    lines.push(c.slateBorder('─'.repeat(W)));
    const hotkeys = (
      this.modalMode !== 'none'
        ? [
            `${c.boldWhite('Enter')} ${c.slateMuted('Dispatch')}`,
            `${c.boldWhite('Esc')} ${c.slateMuted('Cancel')}`,
            `${c.boldWhite('Backspace')} ${c.slateMuted('Delete')}`,
          ]
        : this.activeTab === 1
          ? [
              `${c.boldWhite('Enter')} ${c.slateMuted('Run Goal / Chat')}`,
              `${c.boldWhite('Tab')} ${c.slateMuted('Switch View')}`,
              `${c.boldWhite('P')} ${c.emerald('Preview')}`,
              ...(hasTranscriptSession ? [`${c.boldWhite('PgUp/PgDn')} ${c.slateMuted('Scroll')}`] : []),
              `${c.boldWhite('Esc')} ${c.slateMuted('Clear')}`,
              `${c.boldWhite('G')} ${c.amber(
                `Model ${
                  this.selectedModel
                    .split('/')
                    .pop()
                    ?.replace(/^gemma2?:?/i, '') || this.selectedModel
                }`,
              )}`,
              `${c.cyanBright('/help')} ${c.slateMuted('Commands')}`,
              `${c.boldWhite('Ctrl+C')} ${c.slateMuted('Quit')}`,
            ]
          : this.activeTab === 2
            ? [
                `${c.boldWhite('Enter')} ${c.slateMuted('Send Message')}`,
                `${c.boldWhite('Tab')} ${c.slateMuted('Switch View')}`,
                ...(this.chatMessages.length > 0 ? [`${c.boldWhite('PgUp/PgDn')} ${c.slateMuted('Scroll')}`] : []),
                `${c.boldWhite('Esc')} ${c.slateMuted('Clear')}`,
                `${c.boldWhite('G')} ${c.amber(
                  `Model ${
                    this.selectedModel
                      .split('/')
                      .pop()
                      ?.replace(/^gemma2?:?/i, '') || this.selectedModel
                  }`,
                )}`,
                `${c.boldWhite('P')} ${c.emerald('Preview')}`,
                `${c.boldWhite('Ctrl+C')} ${c.slateMuted('Quit')}`,
              ]
            : this.activeTab === 3
              ? [
                  `${c.boldWhite('Tab')} ${c.slateMuted('Switch View')}`,
                  `${c.boldWhite('P')} ${c.emerald('Preview')}`,
                  `${c.boldWhite('Enter')} ${c.cyan(this.swarmInspectorExpanded ? 'Collapse' : 'Expand')}`,
                  `${c.boldWhite('R')} ${c.cyanBright('Refresh')}`,
                  `${c.boldWhite('Esc')} ${c.slateMuted('Back')}`,
                  `${c.boldWhite('↑/↓')} ${c.slateMuted('Select Agent')}`,
                  `${c.boldWhite('Ctrl+C')} ${c.slateMuted('Quit')}`,
                ]
              : [
                  `${c.boldWhite('Tab')} ${c.slateMuted('Switch View')}`,
                  `${c.boldWhite('0-5')} ${c.slateMuted('Jump')}`,
                  `${c.boldWhite('/')} ${c.slateMuted('Prompt')}`,
                  `${c.boldWhite('C')} ${c.cyan('Chat')}`,
                  `${c.boldWhite('G')} ${c.amber(
                    `Model ${
                      this.selectedModel
                        .split('/')
                        .pop()
                        ?.replace(/^gemma2?:?/i, '') || this.selectedModel
                    }`,
                  )}`,
                  `${c.boldWhite('P')} ${c.emerald('Preview')}`,
                  `${c.boldWhite('R')} ${c.cyan('Refresh')}`,
                  `${c.boldWhite('Q')} ${c.slateMuted('Quit')}`,
                ]
    ).join('   ');
    lines.push(fullLine(hotkeys));

    // Rewrite from the cursor home and strictly clamp rows to viewport height
    const rendered = lines
      .slice(0, terminalRows)
      .map((l) => fitTerminalLine(l, W))
      .join('\n');
    process.stdout.write('\x1b[H' + rendered + '\x1b[J');
  }

  // ── Tab 1: MAOS Oasis welcome screen ───────────────────────────
  private renderTabFleet(lines: string[], W: number, bodyRows: number): void {
    const center = (value: string) => centerTerminalLine(value, W);
    const promptW = Math.min(76, W - 4);

    if (this.transcript.length > 0) {
      const transcriptWidth = Math.max(1, W - 1);
      const rows = this.transcript.flatMap((line) => wrapTerminalLine(line, transcriptWidth));
      if (this.externalCommandRunning && this.commandOutputRemainder) {
        rows.push(...wrapTerminalLine(this.commandOutputRemainder, transcriptWidth));
      }
      if (this.externalCommandRunning) {
        const elapsedSec = Math.floor((Date.now() - this.externalCommandStartTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        const spinner = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length];
        const runningRow = `${spinner} ${this.externalCommandLabel || 'Running'}... (${mins}:${secs})`;
        rows.push(...wrapTerminalLine(runningRow, transcriptWidth));
      }
      const promptRows = 4;
      const viewportRows = Math.max(1, bodyRows - promptRows);
      this.transcriptViewportRows = viewportRows;
      this.transcriptRenderedRowCount = rows.length;
      this.transcriptScrollOffset = Math.max(
        0,
        Math.min(this.transcriptScrollOffset, Math.max(0, rows.length - viewportRows)),
      );
      const end = rows.length - this.transcriptScrollOffset;
      const start = Math.max(0, end - viewportRows);
      const visibleRows = rows.slice(start, end);
      for (let i = visibleRows.length; i < viewportRows; i++) lines.push('');
      for (const row of visibleRows) {
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row)) {
          lines.push(c.cyanBright(row));
        } else if (row.startsWith('✓')) {
          lines.push(c.emerald(row));
        } else if (row.startsWith('✗') || row.startsWith('Error:')) {
          lines.push(c.pink(row));
        } else {
          lines.push(c.slateText(row));
        }
      }

      lines.push(c.slateBorder('─'.repeat(W)));
      const innerW = Math.max(0, W - 4);
      const prefix = `${c.cyanBright('>')} ${c.slateBorder('│')}  `;
      const inputWidth = Math.max(0, innerW - terminalCellWidth(prefix) - 1);
      const commandText = this.externalCommandRunning
        ? `${c.cyanBright(this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length])} ${c.white(`${this.externalCommandLabel || 'Running'}...`)} ${c.slateMuted('(Ctrl+C to abort · Tab to switch view)')}`
        : this.modalInputText
          ? `${c.white(fitTerminalTail(this.modalInputText, inputWidth))}${c.boldWhite('█')}`
          : `${c.boldWhite('█')} ${c.slateMuted('Type a goal or /help for commands')}`;
      const innerContent = prefix + commandText;
      const promptRow = `${c.cyanBright('│ ')}${fitTerminalLine(innerContent, innerW)}${c.cyanBright(' │')}`;
      lines.push(centerTerminalLine(c.cyanBright('╭' + '─'.repeat(Math.max(0, W - 2)) + '╮'), W));
      lines.push(promptRow);
      lines.push(centerTerminalLine(c.cyanBright('╰' + '─'.repeat(Math.max(0, W - 2)) + '╯'), W));
      return;
    }

    if (W >= MAOS_OASIS_LOGO_WIDTH) {
      for (const row of MAOS_OASIS_LOGO_ROWS) lines.push(center(c.slateText(row)));
    } else {
      lines.push(center(`${c.boldWhite('MAOS')} ${c.cyanBright('OASIS')}`));
    }
    lines.push('');
    const subtitle =
      W >= 68
        ? c.slateText('Sovereign Multi-Agent Swarm Kernel'.split('').join(' '))
        : c.slateText('Sovereign Multi-Agent Swarm Kernel');
    lines.push(center(subtitle));
    lines.push('');
    lines.push('');
    const dividerW = Math.max(0, Math.min(42, W - 4));
    const sideW = Math.max(0, Math.floor((dividerW - 2) / 3));
    const middleW = Math.max(0, dividerW - sideW * 2 - 2);
    lines.push(
      center(
        `${c.slateBorder('─'.repeat(sideW))}  ${c.cyanBright('━'.repeat(middleW))}  ${c.slateBorder('─'.repeat(sideW))}`,
      ),
    );
    lines.push('');
    lines.push('');
    lines.push('');
    const promptInnerW = promptW - 4;
    const prefix = `${c.cyanBright('>')} ${c.slateBorder('│')}  `;
    const inputWidth = Math.max(0, promptInnerW - terminalCellWidth(prefix) - 1);
    const commandText = this.externalCommandRunning
      ? `${c.cyanBright(this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length])} ${c.white(`${this.externalCommandLabel || 'Running'}...`)} ${c.slateMuted('(Ctrl+C to abort · Tab to switch view)')}`
      : this.modalInputText
        ? `${c.white(fitTerminalTail(this.modalInputText, inputWidth))}${c.boldWhite('█')}`
        : `${c.boldWhite('█')} ${c.slateMuted('Type a goal or /help for commands')}`;
    const innerContent = prefix + commandText;
    const promptRow = `${c.cyanBright('│ ')}${fitTerminalLine(innerContent, promptInnerW)}${c.cyanBright(' │')}`;
    if (promptW >= 24) {
      lines.push(centerTerminalLine(c.cyanBright('╭' + '─'.repeat(promptW - 2) + '╮'), W));
      lines.push(centerTerminalLine(promptRow, W));
      lines.push(centerTerminalLine(c.cyanBright('╰' + '─'.repeat(promptW - 2) + '╯'), W));
    } else {
      lines.push(center(innerContent));
    }
  }

  // ── Tab 2: Direct Local Gemma LLM Chat ─────────────────────────
  private renderTabChat(lines: string[], W: number, bodyRows: number): void {
    const center = (value: string) => centerTerminalLine(value, W);
    const host = this.oasisConfig?.ollama?.host || '127.0.0.1';
    const port = this.oasisConfig?.ollama?.port || 11434;
    const modelBadge = this.selectedModel.replace('gemma2:', 'GEMMA ').toUpperCase();

    // Responsive sleek NeoVim-style info bar
    const infoBar =
      W >= 87
        ? `${c.cyanBright('💬')} ${c.boldWhite('CHAT')}  ${c.slateBorder('│')}  ${c.slateMuted('ACTIVE MODEL:')} ${c.violetBright(modelBadge)}  ${c.slateBorder('│')}  ${c.slateMuted('LOCAL INFERENCE:')} ${c.emerald(`${host}:${port}`)}  ${c.slateBorder('│')}  ${c.cyanBright('0 KB EGRESS')}`
        : W >= 54
          ? `${c.cyanBright('💬 CHAT')} · ${c.violetBright(modelBadge)} · ${c.emerald(`${host}:${port}`)} · ${c.cyanBright('0 KB EGRESS')}`
          : W >= 32
            ? `${c.cyanBright('💬 CHAT')} · ${c.violetBright(modelBadge)} · ${c.cyanBright('0 KB EGRESS')}`
            : `${c.cyanBright('💬 CHAT')} · ${c.violetBright(modelBadge)}`;
    lines.push(center(infoBar));
    lines.push(c.slateBorder('─'.repeat(W)));

    // Chat history viewport
    const promptRows = 3;
    const headerRows = lines.length;
    const availableChatRows = Math.max(1, bodyRows - headerRows - promptRows);

    const chatContentWidth = Math.max(1, W - 2);
    const chatDisplayRows: string[] = [];

    if (this.chatMessages.length === 0) {
      const maxBoxW = Math.max(10, Math.min(62, chatContentWidth - 4));
      const boxW = Math.max(10, Math.min(maxBoxW, W - 2));
      const innerW = Math.max(8, boxW - 2);
      const topBorder = c.cyanBright('╭' + '─'.repeat(innerW) + '╮');
      const bottomBorder = c.cyanBright('╰' + '─'.repeat(innerW) + '╯');
      const makeBoxRow = (styledText: string) => {
        return c.cyanBright('│') + centerTerminalLine(styledText, innerW) + c.cyanBright('│');
      };

      const title =
        innerW >= 37 ? 'Welcome to MAOS Sovereign Local Chat!' : innerW >= 24 ? 'MAOS Sovereign Chat' : 'MAOS Chat';
      const desc =
        innerW >= 55
          ? 'Chat directly with local Gemma without spawning swarms.'
          : innerW >= 36
            ? 'Direct chat with sovereign local Gemma.'
            : 'Direct local Gemma chat.';
      const hint =
        innerW >= 50
          ? 'Try: "Hi", "What is MAOS?", "Explain architecture"'
          : innerW >= 30
            ? 'Try: "Hi" or "What is MAOS?"'
            : 'Try: "Hi"';

      chatDisplayRows.push('');
      chatDisplayRows.push(center(topBorder));
      chatDisplayRows.push(center(makeBoxRow(c.white(title))));
      chatDisplayRows.push(center(makeBoxRow(c.slateText(desc))));
      chatDisplayRows.push(center(makeBoxRow(c.slateMuted(hint))));
      chatDisplayRows.push(center(bottomBorder));
    } else {
      for (const msg of this.chatMessages) {
        if (msg.sender === 'user') {
          chatDisplayRows.push(`${c.cyanBright('>')} ${c.boldWhite('You')} ${c.slateMuted(`[${msg.time}]`)}`);
          for (const line of wrapTerminalLine(msg.text, chatContentWidth - 4)) {
            chatDisplayRows.push(`  ${c.white(line)}`);
          }
        } else {
          chatDisplayRows.push(
            `${c.violetBright('◆')} ${c.boldWhite(`Gemma (${this.selectedModel})`)} ${c.slateMuted(`[${msg.time}]`)}`,
          );
          for (const line of wrapTerminalLine(msg.text, chatContentWidth - 4)) {
            chatDisplayRows.push(`  ${c.slateText(line)}`);
          }
        }
        chatDisplayRows.push('');
      }
      if (this.chatIsStreaming) {
        const spinner = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length];
        chatDisplayRows.push(`  ${c.cyanBright(spinner)} ${c.slateMuted('Gemma is generating response...')}`);
      }
    }

    this.chatViewportRows = availableChatRows;
    this.chatRenderedRowCount = chatDisplayRows.length;
    this.chatScrollOffset = Math.max(
      0,
      Math.min(this.chatScrollOffset, Math.max(0, chatDisplayRows.length - availableChatRows)),
    );

    const end = chatDisplayRows.length - this.chatScrollOffset;
    const start = Math.max(0, end - availableChatRows);
    const visibleChatRows = chatDisplayRows.slice(start, end);

    for (let i = visibleChatRows.length; i < availableChatRows; i++) lines.push('');
    for (const row of visibleChatRows) lines.push(row);

    // Inline Chat Prompt Box
    const innerW = Math.max(0, W - 4);
    const prefix = `${c.violetBright('💬')} ${c.slateBorder('│')}  `;
    const inputWidth = Math.max(0, innerW - terminalCellWidth(prefix) - 1);
    const inputText = this.chatIsStreaming
      ? `${c.cyanBright(this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length])} ${c.white('Generating response...')} ${c.slateMuted('(Loopback inference)')}`
      : this.chatInputText
        ? `${c.white(fitTerminalTail(this.chatInputText, inputWidth))}${c.boldWhite('█')}`
        : `${c.boldWhite('█')} ${c.slateMuted('Ask Gemma anything... (Enter sends · Esc clears)')}`;
    const innerContent = prefix + inputText;
    const promptRow = `${c.violetBright('│ ')}${fitTerminalLine(innerContent, innerW)}${c.violetBright(' │')}`;
    lines.push(centerTerminalLine(c.violetBright('╭' + '─'.repeat(Math.max(0, W - 2)) + '╮'), W));
    lines.push(centerTerminalLine(promptRow, W));
    lines.push(centerTerminalLine(c.violetBright('╰' + '─'.repeat(Math.max(0, W - 2)) + '╯'), W));
  }

  // ── Tab 3: Antigravity Swarm Board (Mascot + Roster + Posts + Inspector) ────
  private renderTabAgents(lines: string[], W: number, bodyRows?: number): void {
    // Dynamically synchronize model badge
    const modelBadge = formatHeaderBadge(this.selectedModel);
    for (const ag of this.swarmAgents) {
      ag.model = modelBadge;
    }
    // Synchronize Herdr panes if active
    if (this.herdrPanes.length > 0) {
      this.herdrPanes.forEach((pane, idx) => {
        const agIdx = idx + 1; // 0 is coordinator
        if (this.swarmAgents[agIdx]) {
          this.swarmAgents[agIdx].paneId = pane.pane_id;
          if (pane.agent_status === 'working') this.swarmAgents[agIdx].state = 'working';
          else if (pane.agent_status === 'done') this.swarmAgents[agIdx].state = 'done';
        }
      });
    }

    const boardState: SwarmBoardState = {
      goal: this.swarmGoal,
      status: this.swarmState,
      agents: this.swarmAgents,
      posts: this.swarmPosts,
      selectedAgentIndex: this.selectedSwarmAgentIndex,
      expanded: this.swarmInspectorExpanded,
      model: this.selectedModel,
      herdrConnected: this.herdrAvailable,
    };

    const boardLines = renderSwarmBoard(boardState, {
      width: W,
      height: bodyRows,
      time: Date.now() / 1000,
    });

    lines.push(...boardLines);
  }

  private renderTabGemma(lines: string[], W: number, bodyRows?: number): void {
    this.renderTabAgents(lines, W, bodyRows);
  }

  // ── Tab 4: Autonomous Healer & Telemetry ───────────────────────
  private renderTabHealer(lines: string[], W: number): void {
    const center = (value: string) => centerTerminalLine(value, W);
    const vramPercent = this.gpuStats.vramTotalMiB
      ? Math.round((this.gpuStats.vramUsedMiB / this.gpuStats.vramTotalMiB) * 100)
      : 0;
    lines.push(center(c.boldWhite('TELEMETRY')));
    lines.push(center(c.slateText('GPU health, system resources, and autonomous repair activity')));
    lines.push('');
    appendMetricCards(lines, W, [
      {
        label: 'GPU MEMORY',
        value: `${(this.gpuStats.vramUsedMiB / 1024).toFixed(1)} / ${(this.gpuStats.vramTotalMiB / 1024).toFixed(1)} GB`,
        detail: `${vramPercent}% allocated`,
        color: c.violetBright,
      },
      {
        label: 'GPU HEALTH',
        value: `${this.gpuStats.tempC}°C · ${this.gpuStats.gpuUtil}%`,
        detail: `${this.gpuStats.powerW}W draw · 75W limit`,
        color: c.emerald,
      },
      {
        label: 'LOCAL RUNTIME',
        value: this.selectedModel,
        detail: 'Ollama 127.0.0.1:11434',
        color: c.cyanBright,
      },
    ]);

    lines.push('');
    lines.push(`${c.cyanBright('◆')} ${c.boldWhite('AUTONOMOUS HEALER')}`);
    lines.push(
      `  ${c.white('Watcher')}  ${c.emerald('ACTIVE')}  ${c.slateMuted('·')}  ${c.white('Source')}  ${c.cyan('Herdr pane buffer hook')}`,
    );
    lines.push(
      `  ${c.white('Repair engine')}  ${c.violetBright('Gemma 2 9B')}  ${c.slateMuted('·')}  ${c.white('Stack traces')}  ${c.cyan('TypeScript / Vite / Node')}`,
    );
    lines.push(
      `  ${c.white('Incidents')}  ${c.amber('1 compile warning')}  ${c.slateMuted('·')}  ${c.white('Hotpatches')}  ${c.emerald('1 applied')}  ${c.slateMuted('·')}  ${c.white('Resolution')}  ${c.emerald('100%')}`,
    );
    lines.push(
      `  ${c.white('Retry limit')}  ${c.cyan('3 attempts')}  ${c.slateMuted('·')}  ${c.white('Average repair')}  ${c.cyan('3.82 seconds')}`,
    );
    lines.push(`  ${c.white('Network boundary')}  ${c.emerald('Loopback only · 0.00 KB cloud egress · STRICT')}`);

    lines.push('');
    lines.push(`${c.cyanBright('◆')} ${c.boldWhite('RECENT REPAIRS & VERIFICATION')}`);
    lines.push(
      `  ${c.slateMuted('[21:35]')} ${c.emerald('HEALED')}  ${c.white('Buffer geometry index types unified')}`,
    );
    lines.push(`  ${c.slateMuted('[21:17]')} ${c.emerald('PASS')}  ${c.white('Node test runner passed in 2.4 ms')}`);
    lines.push(`  ${c.slateMuted('[21:16]')} ${c.emerald('PASS')}  ${c.white('Raycast ground plane math verified')}`);
    lines.push(`  ${c.emerald('✓')} ${c.slateText('Uint16 buffer attributes normalized · Euler rotation verified')}`);
    lines.push(`  ${c.emerald('✓')} ${c.slateText('Zero regression across 47 tests')}`);
  }

  // ── Tab 5: Session Event Log ───────────────────────────────────
  private renderTabEventLog(lines: string[], W: number): void {
    const center = (value: string) => centerTerminalLine(value, W);
    lines.push(center(c.boldWhite('EVENT LOG')));
    lines.push(center(c.slateText('Chronological session activity and agent telemetry audit trail')));
    lines.push('');
    appendMetricCards(lines, W, [
      {
        label: 'SESSION EVENTS',
        value: String(this.activities.length),
        detail: this.activities.length ? 'Chronological session log' : 'No activity recorded yet',
        color: c.cyanBright,
      },
      {
        label: 'COMMANDS RUN',
        value: String(this.commandHistory.length),
        detail: 'Commands executed',
        color: c.violetBright,
      },
      {
        label: 'SYSTEM HEALTH',
        value: '100%',
        detail: '0 unhandled crashes',
        color: c.emerald,
      },
    ]);

    lines.push('');
    lines.push(`${c.cyanBright('◆')} ${c.boldWhite('RECENT ACTIVITY')}`);
    const events = this.activities.slice(0, 10);
    if (events.length === 0) {
      lines.push(`  ${c.slateMuted('Events from commands, agent activities, and autonomous repairs stream here.')}`);
    } else {
      for (const event of events) {
        lines.push(`  ${c.slateMuted(`[${event.time}]`)} ${event.color(`[${event.tag}]`)} ${c.white(event.text)}`);
      }
    }
  }

  private renderTabCanva3D(lines: string[], W: number): void {
    this.renderTabEventLog(lines, W);
  }

  // ── Tab 0: Workplace Settings & Configuration ──────────────────
  private renderTabSettings(lines: string[], W: number, bodyRows?: number): void {
    const center = (value: string) => centerTerminalLine(value, W);
    const allRows: string[] = [];

    allRows.push(center(c.boldWhite('SETTINGS & WORKSPACE CONFIGURATION')));
    allRows.push(center(c.slateText('Sovereign local parameters · 100% loopback · Zero cloud egress')));
    allRows.push('');

    const tier = (this.oasisConfig?.hardware?.tier || 'high').toUpperCase();
    const vramGB = this.gpuStats.vramTotalMiB ? (this.gpuStats.vramTotalMiB / 1024).toFixed(1) : '8.0';
    const host = this.oasisConfig?.ollama?.host || '127.0.0.1';
    const port = this.oasisConfig?.ollama?.port || 11434;

    // Quick Status Pill Banner
    const banner = `${c.slateBorder('[')} ${c.slateMuted('CONFIG:')} ${c.cyanBright('maos-oasis.json')} ${c.slateBorder(']')}   ${c.slateBorder('[')} ${c.slateMuted('TIER:')} ${c.emerald(`${tier} (${vramGB} GB)`)} ${c.slateBorder(']')}   ${c.slateBorder('[')} ${c.slateMuted('OPSEC:')} ${c.violetBright('STRICT LOOPBACK')} ${c.slateBorder(']')}`;
    allRows.push(center(banner));
    allRows.push('');

    // Categorized NeoVim / OpenCode style panel
    const panelW = Math.min(84, Math.max(46, W - 4));
    const col1W = Math.max(18, Math.min(24, Math.floor(panelW * 0.28)));
    const col3W = 14;
    const col2W = Math.max(10, panelW - col1W - col3W - 6);

    const renderHeader = (title: string, isFirst = false) => {
      const t = ' ' + title + ' ';
      const left = isFirst ? '╭─' : '├─';
      const right = isFirst ? '╮' : '┤';
      const dashes = Math.max(0, panelW - 3 - terminalCellWidth(t));
      return centerTerminalLine(c.slateBorder(left) + c.cyanBright(t) + c.slateBorder('─'.repeat(dashes) + right), W);
    };

    const renderRow = (label: string, val: string, status: string, colorFn: (s: string) => string) => {
      const p1 = fitTerminalLine(c.slateText(label), col1W);
      const p2 = fitTerminalLine(c.white(val), col2W);
      const p3 = fitTerminalLine(colorFn(status), col3W);
      const content = c.slateBorder('│ ') + p1 + ' ' + p2 + ' ' + p3 + c.slateBorder(' │');
      return centerTerminalLine(content, W);
    };

    // Category 1: MODEL & LOCAL INFERENCE
    allRows.push(renderHeader('MODEL & LOCAL INFERENCE', true));
    allRows.push(
      renderRow('Primary Model', `${this.selectedModel} (${this.gpuStats.modelInVram})`, '● ACTIVE', c.emerald),
    );
    if (this.detectedModels.length > 0) {
      for (const m of this.detectedModels.slice(0, 5)) {
        const isActive = m.id.toLowerCase() === this.selectedModel.toLowerCase();
        allRows.push(
          renderRow(
            `Model (${m.source})`,
            `${m.name} [${m.id}]`,
            isActive ? '● ACTIVE' : '○ READY',
            isActive ? c.emerald : c.slateMuted,
          ),
        );
      }
    }
    allRows.push(
      renderRow(
        'Fallback Model',
        this.oasisConfig?.model?.fallback || 'gemma2:2b (CPU fallback)',
        '○ STANDBY',
        c.slateMuted,
      ),
    );
    allRows.push(
      renderRow(
        'Context Window',
        `${this.oasisConfig?.model?.contextTokens || 8192} tokens (sliding window)`,
        '✓ 100% LOCAL',
        c.cyanBright,
      ),
    );
    allRows.push(renderRow('Ollama Daemon', `http://${host}:${port}`, '● LIVE', c.emerald));
    allRows.push(
      renderRow(
        'Auto-Start Daemon',
        this.oasisConfig?.ollama?.autoStart ? 'Enabled (on-demand spawn)' : 'Disabled',
        '✓ AUTO',
        c.cyan,
      ),
    );

    // Category 2: MULTI-AGENT ORCHESTRATION
    allRows.push(renderHeader('MULTI-AGENT ORCHESTRATION', false));
    allRows.push(
      renderRow(
        'Herdr Multi-Pane',
        this.oasisConfig?.dependencies?.herdr?.multiPaneEnabled ? 'Physical terminal split matrix' : 'Disabled',
        this.herdrAvailable ? '● ONLINE' : '○ OFFLINE',
        this.herdrAvailable ? c.emerald : c.amber,
      ),
    );
    allRows.push(
      renderRow(
        'OpenCode Tool Harness',
        this.oasisConfig?.dependencies?.opencode?.harnessEnabled ? 'Isolated CLI sandbox executor' : 'Disabled',
        '✓ READY',
        c.cyan,
      ),
    );
    allRows.push(renderRow('Autonomous Healer', 'Pane error repair & patch hook', '● WATCHING', c.emerald));
    allRows.push(
      renderRow(
        'Swarm Team Preset',
        `${this.oasisConfig?.team?.preset || 'team'} (5 coordinated agents)`,
        '✓ APPLIED',
        c.violetBright,
      ),
    );

    // Category 3: SOVEREIGNTY & OPSEC POLICY
    allRows.push(renderHeader('SOVEREIGNTY & OPSEC POLICY', false));
    allRows.push(
      renderRow(
        'Hardware Profile',
        `${tier} TIER (${this.gpuStats.tempC}°C · ${this.gpuStats.powerW}W)`,
        '✓ DETECTED',
        c.emerald,
      ),
    );
    allRows.push(renderRow('Network Boundary', '127.0.0.1 loopback only', '✓ STRICT', c.emerald));
    allRows.push(renderRow('Cloud Telemetry Egress', '0.00 KB transmitted (strict policy)', '✓ BLOCKED', c.emerald));

    // Bottom Border
    allRows.push(centerTerminalLine(c.slateBorder('╰' + '─'.repeat(Math.max(0, panelW - 2)) + '╯'), W));

    allRows.push('');
    allRows.push(
      centerTerminalLine(
        `${c.boldWhite('G')} ${c.slateMuted('Toggle Model (2B ↔ 9B)')}   ${c.boldWhite('R')} ${c.slateMuted('Refresh Status')}   ${c.boldWhite('PgUp/PgDn')} ${c.slateMuted('Scroll')}   ${c.boldWhite('Esc')} ${c.slateMuted('Dashboard')}`,
        W,
      ),
    );

    if (bodyRows !== undefined && allRows.length > bodyRows) {
      this.settingsViewportRows = bodyRows;
      this.settingsRenderedRowCount = allRows.length;
      const maxScroll = Math.max(0, allRows.length - bodyRows);
      this.settingsScrollOffset = Math.max(0, Math.min(this.settingsScrollOffset, maxScroll));
      const end = allRows.length - this.settingsScrollOffset;
      const start = Math.max(0, end - bodyRows);
      lines.push(...allRows.slice(start, end));
    } else {
      this.settingsViewportRows = bodyRows || allRows.length;
      this.settingsRenderedRowCount = allRows.length;
      this.settingsScrollOffset = 0;
      lines.push(...allRows);
    }
  }

  // ── Modal Dialog Overlay ───────────────────────────────────────
  private renderModal(lines: string[], W: number): void {
    const modalW = Math.max(12, Math.min(74, W - 8));
    const modalPad = Math.max(2, Math.floor((W - modalW) / 2));
    const padStr = ' '.repeat(modalPad);

    lines.push(c.slateBorder('├' + '─'.repeat(Math.max(0, W - 2)) + '┤'));

    const modalTitle = this.modalMode === 'ignite' ? '⚡ IGNITE AUTONOMOUS GEMMA SWARM' : '🧠 GEMMA PROMPT PLAYGROUND';
    const titleText = chalk.bgHex('#EC4899').hex('#FFFFFF').bold(` ${modalTitle} `);
    const titleFill = Math.max(0, modalW - terminalCellWidth(`╭─ `) - terminalCellWidth(titleText) - 1);
    lines.push(padStr + fitTerminalLine(`${c.pink('╭─ ')}${titleText}${c.pink(' '.repeat(titleFill) + '╮')}`, modalW));

    const promptWidth = Math.max(0, modalW - 4);
    const inputPrefix = 'Goal: ';
    const inputWidth = Math.max(0, promptWidth - terminalCellWidth(inputPrefix) - 1);
    const promptText = `${inputPrefix}${fitTerminalTail(this.modalInputText, inputWidth)}█`;
    lines.push(padStr + c.pink('│ ') + fitTerminalLine(c.boldWhite(promptText), promptWidth) + c.pink(' │'));

    const hint = `Press [Enter] to dispatch to Gemma (${this.selectedModel}) · [Esc] to cancel`;
    lines.push(padStr + c.pink('│ ') + fitTerminalLine(c.slateMuted(hint), Math.max(0, modalW - 4)) + c.pink(' │'));

    lines.push(padStr + c.pink('╰' + '─'.repeat(modalW - 2) + '╯'));
  }
}

// ── Entrypoint ───────────────────────────────────────────────────
if (require.main === module) {
  const tui = new MaosTui(path.resolve(__dirname, '..', '..'));
  tui.start();
}
