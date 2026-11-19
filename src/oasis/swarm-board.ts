/**
 * Antigravity Swarm Board for MAOS Oasis (Tab 3)
 *
 * Implements the Antigravity Swarm Board layout:
 * - Animated Jellyfish Mascot ASCII Art (Cyberpunk palette: violet, cyan, emerald, slate)
 * - Header: Jellyfish mascot alongside `Swarm board "<Current Goal>"` · N agents · [active]
 * - Roster: List of swarm members (`coordinator`, `ignite-worker-1` .. `ignite-worker-4`)
 *   with live state (`● working`, `○ waiting`, `✓ done`) and model badge (`GEMMA 9B`, `GEMMA 4 2B`, etc.)
 * - Posts / Live Activity Stream: Live feed showing agent tool calls and messages
 *   (e.g. `> #1 coordinator @worker-1 You own the implementation...`, `> #2 worker-1 @coordinator create_file: script.js`)
 * - Message / Detail Inspector: Box showing selected agent's current task details, latest tool call result, and git diff
 * - Clean Hotkey Footer: `tab switch view · p preview · enter expand · r refresh · esc back`
 */

import chalk from 'chalk';
import { renderJellyfishMascot, renderColoredJellyfish, generateJellyfishRawFrame } from './jellyfish-ascii';
import { formatHeaderBadge } from './model-detector';

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function terminalCellWidth(value: string): number {
  let width = 0;
  const plainText = value.replace(ANSI_SEQUENCE, '').replace(/[\r\n]+/g, '');
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plainText)) {
    const points = Array.from(segment, (char) => char.codePointAt(0) || 0);
    const point = points.find((v) => v !== 0x200d && !(v >= 0xfe00 && v <= 0xfe0f)) || 0;
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
      points.filter((v) => v >= 0x1f1e6 && v <= 0x1f1ff).length === 2 ||
      points.some(
        (v) =>
          (v >= 0x1f000 && v <= 0x1faff) ||
          (v >= 0x2700 && v <= 0x27bf) || // Dingbats (❌ 0x274c, ✅ 0x2705, etc.)
          (v >= 0x2600 && v <= 0x26ff && [0x26a0, 0x26a1, 0x26d4, 0x267f, 0x2699].includes(v)),
      );
    width += wide || emojiPresentation ? 2 : 1;
  }
  return width;
}

export function fitTerminalLine(value: string, width: number): string {
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
      if (used + cells > limit) break segments;
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

export function centerTerminalLine(value: string, width: number): string {
  const cleanValue = value.replace(/[\r\n]+/g, ' ');
  const valueWidth = terminalCellWidth(cleanValue);
  if (valueWidth >= width) return fitTerminalLine(cleanValue, width);
  const left = Math.floor((width - valueWidth) / 2);
  const reset = cleanValue.includes('\u001b') ? '\u001b[0m' : '';
  return ' '.repeat(left) + cleanValue + reset + ' '.repeat(Math.max(0, width - valueWidth - left));
}

// ── Palette ──────────────────────────────────────────────────────────
const colorInstance = new chalk.Instance({ level: 3 });

export const swarmColors = {
  violet: colorInstance.hex('#8B5CF6'),
  violetBright: colorInstance.hex('#A78BFA'),
  pink: colorInstance.hex('#EC4899'),
  cyan: colorInstance.hex('#06B6D4'),
  cyanBright: colorInstance.hex('#38BDF8'),
  emerald: colorInstance.hex('#10B981'),
  amber: colorInstance.hex('#F59E0B'),
  slateDark: colorInstance.hex('#0F172A'),
  slateCard: colorInstance.hex('#1E293B'),
  slateBorder: colorInstance.hex('#334155'),
  slateMuted: colorInstance.hex('#64748B'),
  slateText: colorInstance.hex('#94A3B8'),
  white: colorInstance.hex('#F8FAFC'),
  boldWhite: colorInstance.bold.hex('#FFFFFF'),
};

const c = swarmColors;

// ── Interfaces ───────────────────────────────────────────────────────
export interface SwarmAgent {
  id: string; // 'coordinator', 'ignite-worker-1', ...
  name: string; // 'Coordinator', 'Worker 1', ...
  role: string; // 'Swarm Lead', '3D Scene Viewport', ...
  state: 'working' | 'waiting' | 'done';
  model: string; // 'GEMMA 9B', 'GEMMA 4 2B', etc.
  branch: string; // 'main', 'maos-ignite-0', ...
  paneId?: string; // 'w0:p1'
  taskTitle: string;
  taskDesc: string;
  latestTool?: {
    name: string;
    args: string;
    result: string;
    time: string;
  };
  gitDiff?: string[];
}

export interface SwarmPost {
  id: number;
  sender: string;
  recipient: string;
  action: string;
  text: string;
  time: string;
  type?: 'tool' | 'message' | 'status' | 'system';
}

export interface SwarmBoardState {
  goal: string;
  status: 'active' | 'waiting' | 'done';
  agents: SwarmAgent[];
  posts: SwarmPost[];
  selectedAgentIndex: number;
  expanded?: boolean;
  model: string;
  herdrConnected?: boolean;
}

/**
 * Creates realistic default swarm agents tailored to a goal.
 */
export function createDefaultSwarmAgents(goal: string, model: string = 'gemma2:9b'): SwarmAgent[] {
  const modelBadge = formatHeaderBadge(model);

  return [
    {
      id: 'coordinator',
      name: 'Coordinator',
      role: 'Swarm Orchestrator & Healer',
      state: 'working',
      model: modelBadge,
      branch: 'main',
      paneId: 'w0:p0',
      taskTitle: 'Supervise Swarm & Worktree Isolation',
      taskDesc: `Coordinate parallel workers for "${goal}", watch scrollback, and merge artifacts.`,
      latestTool: {
        name: 'plan_decomposition',
        args: `goal="${goal}"`,
        result: '4 parallel subtasks assigned to isolated git worktrees',
        time: 'just now',
      },
      gitDiff: [
        '+ swarm: parallel worktree isolation initialized',
        '+ workers: 4 autonomous agents allocated (2x2 grid)',
        '+ health: autonomous watcher active (healer zero-egress)',
      ],
    },
    {
      id: 'ignite-worker-1',
      name: 'Worker 1',
      role: 'HTML & 3D Spatial Viewport',
      state: 'working',
      model: modelBadge,
      branch: 'maos-ignite-0',
      paneId: 'w0:p1',
      taskTitle: 'Three.js Spatial Canvas & DOM Setup',
      taskDesc: 'Build responsive 3D canvas viewport container with orbital camera controls.',
      latestTool: {
        name: 'create_file',
        args: 'index.html',
        result: '58 lines written, canvas mount ready',
        time: '3s ago',
      },
      gitDiff: [
        'diff --git a/index.html b/index.html',
        'new file mode 100644',
        '+ <!DOCTYPE html>',
        '+ <html lang="en">',
        '+   <head><title>Canva 3D Spatial Studio</title></head>',
        '+   <body><canvas id="viewport"></canvas></body>',
        '+ </html>',
      ],
    },
    {
      id: 'ignite-worker-2',
      name: 'Worker 2',
      role: 'Scene Graph & Transform Hierarchy',
      state: 'working',
      model: modelBadge,
      branch: 'maos-ignite-1',
      paneId: 'w0:p2',
      taskTitle: 'SceneManager & Transform Engine',
      taskDesc: 'Implement SceneManager node graph, matrix transforms, and object selection.',
      latestTool: {
        name: 'create_file',
        args: 'src/scene.ts',
        result: '142 lines written, node graph compiled',
        time: '8s ago',
      },
      gitDiff: [
        'diff --git a/src/scene.ts b/src/scene.ts',
        '+ export class SceneManager {',
        '+   nodes = new Map<string, SceneNode>();',
        '+   addNode(node: SceneNode) { this.nodes.set(node.id, node); }',
        '+ }',
      ],
    },
    {
      id: 'ignite-worker-3',
      name: 'Worker 3',
      role: 'GLSL Shaders & Spatial Audio',
      state: 'working',
      model: modelBadge,
      branch: 'maos-ignite-2',
      paneId: 'w0:p3',
      taskTitle: 'Directional Lighting & Positional FX',
      taskDesc: 'Implement GLSL PBR lighting shaders and WebAudio 3D positional listener.',
      latestTool: {
        name: 'create_file',
        args: 'src/shaders/spatial.glsl',
        result: '86 lines written, shader compiled',
        time: '12s ago',
      },
      gitDiff: [
        'diff --git a/src/shaders/spatial.glsl b/src/shaders/spatial.glsl',
        '+ precision highp float;',
        '+ uniform vec3 uLightPos;',
        '+ void main() { gl_FragColor = vec4(uLightPos, 1.0); }',
      ],
    },
    {
      id: 'ignite-worker-4',
      name: 'Worker 4',
      role: 'Autonomous Verifier & Test Suite',
      state: 'done',
      model: modelBadge,
      branch: 'maos-ignite-3',
      paneId: 'w0:p4',
      taskTitle: 'Dynamic Compilation & Test Gate',
      taskDesc: 'Run Vitest suite, verify zero regression, and sign off merge readiness.',
      latestTool: {
        name: 'run_command',
        args: 'npm test',
        result: '18 passed, 0 failed (exit 0)',
        time: '15s ago',
      },
      gitDiff: [
        '✓ tests/canvas.test.ts (6 tests) 120ms',
        '✓ tests/scene.test.ts (8 tests) 180ms',
        '✓ tests/audio.test.ts (4 tests) 95ms',
        'All 18 tests passed. Branch green.',
      ],
    },
  ];
}

/**
 * Creates realistic default live activity stream posts.
 */
export function createDefaultSwarmPosts(goal: string): SwarmPost[] {
  return [
    {
      id: 1,
      sender: 'coordinator',
      recipient: '@ignite-worker-1',
      action: 'assign',
      text: 'You own the implementation of HTML & 3D Spatial Viewport',
      time: '00:01',
      type: 'message',
    },
    {
      id: 2,
      sender: 'coordinator',
      recipient: '@ignite-worker-2',
      action: 'assign',
      text: 'You own the implementation of Canva Engine & Scene Manager',
      time: '00:01',
      type: 'message',
    },
    {
      id: 3,
      sender: 'coordinator',
      recipient: '@ignite-worker-3',
      action: 'assign',
      text: 'You own the implementation of Spatial Audio & Lighting Shaders',
      time: '00:01',
      type: 'message',
    },
    {
      id: 4,
      sender: 'coordinator',
      recipient: '@ignite-worker-4',
      action: 'assign',
      text: 'You own the implementation of Autonomous Verifier & Test Suite',
      time: '00:01',
      type: 'message',
    },
    {
      id: 5,
      sender: 'ignite-worker-1',
      recipient: '@coordinator',
      action: 'create_file',
      text: 'create_file: index.html (58 lines written to worktree)',
      time: '00:04',
      type: 'tool',
    },
    {
      id: 6,
      sender: 'ignite-worker-2',
      recipient: '@coordinator',
      action: 'create_file',
      text: 'create_file: src/scene.ts (142 lines written to worktree)',
      time: '00:07',
      type: 'tool',
    },
    {
      id: 7,
      sender: 'ignite-worker-3',
      recipient: '@coordinator',
      action: 'create_file',
      text: 'create_file: src/shaders/spatial.glsl (86 lines written)',
      time: '00:10',
      type: 'tool',
    },
    {
      id: 8,
      sender: 'ignite-worker-4',
      recipient: '@coordinator',
      action: 'run_command',
      text: 'run_command: npm test (18 passed, 0 failed, exit code 0)',
      time: '00:14',
      type: 'tool',
    },
    {
      id: 9,
      sender: 'ignite-worker-1',
      recipient: '@coordinator',
      action: 'git_commit',
      text: 'git_commit: feat(viewport): canvas container initialized',
      time: '00:16',
      type: 'tool',
    },
    {
      id: 10,
      sender: 'ignite-worker-2',
      recipient: '@coordinator',
      action: 'git_commit',
      text: 'git_commit: feat(scene): hierarchy and transforms applied',
      time: '00:18',
      type: 'tool',
    },
    {
      id: 11,
      sender: 'coordinator',
      recipient: '@all',
      action: 'sync',
      text: 'Swarm synchronization barrier cleared · 4/4 branches green',
      time: '00:20',
      type: 'system',
    },
  ];
}

/**
 * Renders the complete Antigravity Swarm Board for Tab 3.
 */
export function renderSwarmBoard(
  state: SwarmBoardState,
  options: {
    width: number;
    height?: number;
    time?: number;
  },
): string[] {
  const W = Math.max(60, options.width);
  const time = options.time !== undefined ? options.time : Date.now() / 1000;
  const lines: string[] = [];
  const pad = (str: string, len: number) => fitTerminalLine(str, len);

  const selectedIdx = Math.max(0, Math.min(state.agents.length - 1, state.selectedAgentIndex || 0));
  const selectedAgent = state.agents[selectedIdx] || state.agents[0];

  // ──────────────────────────────────────────────────────────────────────────
  // 1. HEADER WITH JELLYFISH MASCOT
  // ──────────────────────────────────────────────────────────────────────────
  const mascotLines = renderJellyfishMascot(time);
  const mascotWidth = 20;
  const headerInfoWidth = Math.max(30, W - mascotWidth - 3);

  const activeCount = state.agents.filter((a) => a.state === 'working').length;
  const doneCount = state.agents.filter((a) => a.state === 'done').length;
  const statusColor = state.status === 'active' ? c.emerald : state.status === 'done' ? c.cyanBright : c.amber;
  const statusText = state.status === 'active' ? '● active' : state.status === 'done' ? '✓ complete' : '○ waiting';

  const infoRows: string[] = [
    `${c.boldWhite('Swarm board')} ${c.cyanBright(`"${pad(state.goal, headerInfoWidth - 28)}"`)}`,
    `${statusColor(statusText)}  ${c.slateBorder('·')}  ${c.white(String(state.agents.length))} ${c.slateText('agents')} (${c.cyanBright(String(activeCount) + ' working')}${doneCount > 0 ? ', ' + c.emerald(String(doneCount) + ' done') : ''})  ${c.slateBorder('·')}  ${c.violetBright(formatHeaderBadge(state.model))}`,
    `${c.slateText('Target:')} ${c.white(pad(state.goal, headerInfoWidth - 10))}`,
    `${c.slateText('Pipeline:')} ${c.emerald('Goal Decomposition')} ${c.slateMuted('→')} ${c.cyanBright('Parallel Panes')} ${c.slateMuted('→')} ${c.violetBright('Isolated Worktrees')} ${c.slateMuted('→')} ${c.emerald('Merge Barrier')}`,
    `${c.slateText('Swarm Health:')} ${c.emerald('Strict Loopback')} ${c.slateMuted('·')} ${c.slateText('Healer:')} ${c.cyanBright('Scrollback Watcher Active')} ${c.slateMuted('·')} ${c.slateText('Egress:')} ${c.emerald('0.00 KB')}`,
    `${c.slateText('Controls:')} ${c.boldWhite('↑/↓')} ${c.slateMuted('select agent')} ${c.slateBorder('·')} ${c.boldWhite('Enter')} ${c.slateMuted('toggle expand')} ${c.slateBorder('·')} ${c.boldWhite('P')} ${c.emerald('preview built artifacts')}`,
    c.slateBorder('─'.repeat(headerInfoWidth)),
    `${c.slateMuted('Antigravity CLI Swarm Engine')} ${c.slateBorder('│')} ${c.violetBright('Moon Jellyfish Swarm Kernel')}`,
  ];

  const headerHeight = Math.max(mascotLines.length, infoRows.length);
  for (let r = 0; r < headerHeight; r++) {
    const left = mascotLines[r] || ' '.repeat(mascotWidth);
    const right = infoRows[r] || '';
    lines.push(`${pad(left, mascotWidth)}${c.slateBorder(' │ ')}${pad(right, headerInfoWidth)}`);
  }

  lines.push(c.slateBorder('─'.repeat(W)));

  // ──────────────────────────────────────────────────────────────────────────
  // 2. EXPANDED VIEW OR SPLIT VIEW
  // ──────────────────────────────────────────────────────────────────────────
  if (state.expanded) {
    // ── Full Expanded Inspector with Mathematical Jellyfish Frame ───────────
    lines.push(
      `${c.cyanBright('◈')} ${c.boldWhite('EXPANDED SWARM INSPECTOR')} ${c.slateMuted('—')} ${c.cyanBright(selectedAgent.name)} ${c.slateMuted(`(${selectedAgent.id})`)} ${c.slateBorder('·')} ${c.slateMuted('Press Enter or Esc to collapse')}`,
    );
    lines.push('');

    // Detail boxes:
    lines.push(
      `${c.cyanBright('Role:')} ${c.boldWhite(selectedAgent.role)}  ${c.slateBorder('│')}  ${c.slateText('Branch:')} ${c.cyan(selectedAgent.branch)}  ${c.slateBorder('│')}  ${c.slateText('Status:')} ${selectedAgent.state === 'working' ? c.cyanBright('● working') : selectedAgent.state === 'done' ? c.emerald('✓ done') : c.amber('○ waiting')}`,
    );
    lines.push(`${c.slateText('Current Task:')} ${c.white(selectedAgent.taskTitle)}`);
    lines.push(`${c.slateText('Description:')} ${c.slateText(selectedAgent.taskDesc)}`);
    if (selectedAgent.latestTool) {
      lines.push(
        `${c.cyanBright('Latest Tool Call:')} ${c.boldWhite(selectedAgent.latestTool.name)} ${c.slateMuted(`(${selectedAgent.latestTool.args})`)} ${c.slateBorder('→')} ${c.emerald(selectedAgent.latestTool.result)} ${c.slateMuted(`[${selectedAgent.latestTool.time}]`)}`,
      );
    }
    lines.push('');
    lines.push(c.slateBorder('╭' + '─'.repeat(Math.max(0, W - 2)) + '╮'));
    lines.push(
      `${c.slateBorder('│ ')}${c.boldWhite('WORKTREE GIT DIFF / VERIFICATION TRACE')}${c.slateBorder(' '.repeat(Math.max(0, W - 42)) + '│')}`,
    );
    lines.push(c.slateBorder('├' + '─'.repeat(Math.max(0, W - 2)) + '┤'));

    const diffRows = selectedAgent.gitDiff || ['+ No local diff'];
    for (const d of diffRows.slice(0, 8)) {
      const col = d.startsWith('+')
        ? c.emerald
        : d.startsWith('-')
          ? c.pink
          : d.startsWith('✓')
            ? c.emerald
            : c.slateText;
      lines.push(`${c.slateBorder('│ ')}${pad(col(d), W - 4)}${c.slateBorder(' │')}`);
    }
    lines.push(c.slateBorder('╰' + '─'.repeat(Math.max(0, W - 2)) + '╯'));
    return lines;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. NORMAL VIEW: ROSTER (LEFT) + POSTS STREAM (RIGHT)
  // ──────────────────────────────────────────────────────────────────────────
  const rosterWidth = Math.min(38, Math.max(28, Math.floor(W * 0.4)));
  const postsWidth = Math.max(30, W - rosterWidth - 3);

  // Roster lines:
  const rosterHeader = `${c.cyanBright('ROSTER')} ${c.slateMuted(`(${state.agents.length} agents)`)}`;
  const rosterLines: string[] = [rosterHeader, c.slateBorder('─'.repeat(rosterWidth))];

  state.agents.forEach((ag, idx) => {
    const isSelected = idx === selectedIdx;
    const bullet = ag.state === 'working' ? c.cyanBright('●') : ag.state === 'done' ? c.emerald('✓') : c.amber('○');
    const pointer = isSelected ? c.cyanBright('▶ ') : '  ';
    const namePart = isSelected ? c.boldWhite(ag.id) : c.white(ag.id);
    const badge = c.slateMuted(`[${ag.model.split(' ')[0]}]`);
    const line1 = `${pointer}${bullet} ${namePart} ${badge}`;
    const line2 = `     ${c.slateText(pad(ag.role, rosterWidth - 6))}`;
    rosterLines.push(line1);
    rosterLines.push(line2);
  });

  // Posts lines (Live Activity Stream):
  const postsHeader = `${c.cyanBright('POSTS')} ${c.slateMuted(`(${state.posts.length} activity entries)`)}`;
  const postsLines: string[] = [postsHeader, c.slateBorder('─'.repeat(postsWidth))];

  const recentPosts = state.posts.slice(-8);
  if (recentPosts.length === 0) {
    postsLines.push(c.slateMuted('  No activity recorded yet. Swarm is standing by.'));
  } else {
    for (const post of recentPosts) {
      const pNum = c.violetBright(`#${post.id}`);
      const sender = post.sender === 'coordinator' ? c.boldWhite(post.sender) : c.cyan(post.sender);
      const recip = c.cyanBright(post.recipient);
      const text =
        post.action === 'create_file'
          ? c.emerald(post.text)
          : post.action === 'run_command'
            ? c.cyanBright(post.text)
            : post.action === 'git_commit'
              ? c.violetBright(post.text)
              : c.white(post.text);
      postsLines.push(`${c.cyanBright('>')} ${pNum} ${sender} ${recip} ${text}`);
    }
  }

  // Combine Roster (left) and Posts (right):
  const midHeight = Math.max(rosterLines.length, postsLines.length);
  for (let r = 0; r < midHeight; r++) {
    const left = rosterLines[r] || ' '.repeat(rosterWidth);
    const right = postsLines[r] || '';
    lines.push(`${pad(left, rosterWidth)}${c.slateBorder(' │ ')}${pad(right, postsWidth)}`);
  }

  lines.push(c.slateBorder('─'.repeat(W)));

  // ──────────────────────────────────────────────────────────────────────────
  // 4. MESSAGE / DETAIL INSPECTOR (BOTTOM PANEL)
  // ──────────────────────────────────────────────────────────────────────────
  const inspectorTitle = `╭─── Inspector: ${selectedAgent.id} [${selectedAgent.role}] ─`;
  lines.push(c.slateBorder(inspectorTitle + '─'.repeat(Math.max(0, W - terminalCellWidth(inspectorTitle) - 1)) + '╮'));

  const taskRow = `${c.slateText('Task:')} ${c.white(selectedAgent.taskTitle)}  ${c.slateBorder('│')}  ${c.slateText('Branch:')} ${c.cyan(selectedAgent.branch)}`;
  lines.push(`${c.slateBorder('│ ')}${pad(taskRow, W - 4)}${c.slateBorder(' │')}`);

  if (selectedAgent.latestTool) {
    const toolRow = `${c.slateText('Latest Tool:')} ${c.cyanBright(selectedAgent.latestTool.name)} ${c.slateMuted(`(${selectedAgent.latestTool.args})`)} ${c.slateBorder('→')} ${c.emerald(selectedAgent.latestTool.result)}`;
    lines.push(`${c.slateBorder('│ ')}${pad(toolRow, W - 4)}${c.slateBorder(' │')}`);
  }

  if (selectedAgent.gitDiff && selectedAgent.gitDiff.length > 0) {
    const diffSample = selectedAgent.gitDiff
      .slice(0, 2)
      .map((d) => (d.startsWith('+') ? c.emerald(d) : c.slateText(d)))
      .join('  ');
    const diffRow = `${c.slateText('Diff:')} ${diffSample}`;
    lines.push(`${c.slateBorder('│ ')}${pad(diffRow, W - 4)}${c.slateBorder(' │')}`);
  }

  lines.push(c.slateBorder('╰' + '─'.repeat(Math.max(0, W - 2)) + '╯'));

  return lines;
}
