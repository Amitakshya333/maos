/**
 * MAOS Autonomous Healer — Closed-Loop Self-Healing Engine
 *
 * Watches Herdr worker panes, intercepts the raw unwrapped scrollback buffer
 * (`herdr pane read <pane> --source recent-unwrapped`), detects compiler and
 * test error traces (TypeScript / Jest / Vitest / Node), parses stack traces,
 * and formulates + applies targeted hotpatches until tests pass.
 *
 * Design notes:
 * - Pure detection/parsing helpers are exported for unit testing and reuse.
 * - Herdr access goes through the `HerdrPaneReader` interface. The default
 *   `CliHerdrPaneReader` shells out to the `herdr` CLI (the same IPC the
 *   multiplexer exposes). When `src/integrations/herdr.ts` (Agent 2's Herdr
 *   harness driver) lands, it can implement this interface and be injected —
 *   no healer logic changes required.
 * - Hotpatches are rule-based by default (safe, deterministic). When an
 *   `IProvider` (Gemma via OpenCode harness) is supplied, complex failures
 *   are escalated to the model for a targeted diff; rule-based repair is the
 *   fallback.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MessageBus, createEvent } from './message-bus';
import { createLogger, Logger } from '../utils/logger';
import { IProvider } from '../backends/provider';

// ─── Types ───────────────────────────────────────────────────────

export type ErrorKind = 'typescript' | 'jest' | 'vitest' | 'node' | 'build' | 'unknown';

export interface StackFrame {
  /** Function/method name when present. */
  fn?: string;
  /** File path as printed in the trace (may be relative). */
  file: string;
  line: number;
  column?: number;
  raw: string;
}

export interface ErrorTrace {
  kind: ErrorKind;
  /** First meaningful error line (e.g. "error TS2304: Cannot find name 'x'"). */
  message: string;
  /** Diagnostic code when present (e.g. "TS2304"). */
  code?: string;
  /** Primary suspect file/line/col (best-effort). */
  file?: string;
  line?: number;
  column?: number;
  frames: StackFrame[];
  /** Raw excerpt (bounded) that produced this trace. */
  excerpt: string;
  /** Stable dedupe hash. */
  hash: string;
}

export type HotpatchOpType = 'replace-text' | 'replace-line' | 'insert-line' | 'create-file';

export interface HotpatchOp {
  type: HotpatchOpType;
  /** Project-relative target file. */
  file: string;
  /** 1-based line for replace-line / insert-line. */
  line?: number;
  /** Exact text to replace (replace-text). */
  find?: string;
  /** Replacement / inserted content. */
  content: string;
}

export interface Hotpatch {
  /** Human-readable diagnosis of the root cause. */
  diagnosis: string;
  /** Why this patch should fix it. */
  rationale: string;
  ops: HotpatchOp[];
  /** Command to verify the fix (run in the worktree/pane). */
  verificationCommand: string;
  /** 0..1 confidence. Low-confidence patches are reported, not auto-applied. */
  confidence: number;
  /** True when the failure needs model reasoning beyond safe rules. */
  needsLlm: boolean;
}

export interface HealAttempt {
  paneId: string;
  trace: ErrorTrace;
  patch: Hotpatch;
  applied: boolean;
  backupDir?: string;
  appliedAt: number;
  note: string;
}

export interface HealerStats {
  polls: number;
  panesWatched: number;
  tracesSeen: number;
  patchesApplied: number;
  patchesSkippedLowConfidence: number;
  failures: number;
  startedAt: number;
}

export interface HerdrPaneHandle {
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  agent?: string;
  agentStatus?: string;
  cwd?: string;
}

/** Minimal Herdr surface the healer needs. Implemented by CLI today. */
export interface HerdrPaneReader {
  listPanes(): Promise<HerdrPaneHandle[]>;
  readBuffer(paneId: string, lines?: number): Promise<string>;
  runCommand?(paneId: string, command: string): Promise<void>;
}

export interface AutonomousHealerOptions {
  projectRoot: string;
  /** Explicit pane IDs to watch. When omitted, all live panes are discovered. */
  paneIds?: string[];
  reader?: HerdrPaneReader;
  /** Optional model (Gemma) for complex-patch synthesis. */
  provider?: IProvider;
  bus?: MessageBus;
  logger?: Logger;
  pollIntervalMs?: number;
  /** Scrollback lines per read (default 250). */
  lines?: number;
  /** Max auto-applied patches per pane before giving up (default 5). */
  maxHealsPerPane?: number;
  /** Cooldown between heals on the same pane in ms (default 10s). */
  cooldownMs?: number;
  /** Minimum confidence for auto-apply (default 0.55). */
  minAutoApplyConfidence?: number;
  /** When true, re-run the verification command in the pane after a patch. */
  rerunTests?: boolean;
  onHeal?: (attempt: HealAttempt) => void;
}

export class HealerError extends Error {
  readonly kind: 'HERDR_UNAVAILABLE' | 'PATCH_FAILED' | 'UNSAFE_PATH';
  constructor(kind: HealerError['kind'], message: string) {
    super(message);
    this.name = 'HealerError';
    this.kind = kind;
  }
}

// ─── Text helpers ────────────────────────────────────────────────

/** Strip ANSI escape sequences from terminal scrollback. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][0-9A-Z]/g, '');
}

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function normalizeTraceKey(parts: Array<string | number | undefined>): string {
  return parts
    .map((p) => (p === undefined ? '' : String(p)))
    .join('|')
    .slice(0, 500);
}

// ─── Stack-trace parsing ─────────────────────────────────────────

const NODE_FRAME_RE = /at\s+(?:(.+?)\s+\()?([^\s()]+):(\d+)(?::(\d+))?\)?/;
const TS_LOCATION_RE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+)?:\s*(.*)$/;
const JEST_LOCATION_RE = /^\s*at\s+.+\(([^()]+):(\d+):(\d+)\)/;
const VITEST_POS_RE = /([\w\-./\\]+\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)/;

/**
 * Parse Node/Jest/Vitest stack frames from free text. Returns frames in order.
 * Pure function — safe to unit test.
 */
export function parseStackFrames(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const clean = stripAnsi(text);
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('at ') && !VITEST_POS_RE.test(line)) continue;
    const m = line.match(NODE_FRAME_RE);
    if (m && line.startsWith('at')) {
      const [, fn, file, lineNo, colNo] = m;
      if (!file || file === '<anonymous>') continue;
      // Skip pure engine internals unless nothing else is found (kept, caller filters).
      frames.push({
        fn: fn?.trim(),
        file: file.trim(),
        line: Number(lineNo),
        column: colNo ? Number(colNo) : undefined,
        raw: rawLine.trim(),
      });
      continue;
    }
    const v = line.match(VITEST_POS_RE);
    if (v) {
      frames.push({
        file: v[1],
        line: Number(v[2]),
        column: Number(v[3]),
        raw: rawLine.trim(),
      });
    }
  }
  return frames.slice(0, 25);
}

/** Prefer project frames over node_modules / engine internals. */
export function primaryFrame(frames: StackFrame[]): StackFrame | undefined {
  return (
    frames.find((f) => !/node_modules|node:internal|internal\//.test(f.file)) ||
    frames.find((f) => !/node:internal|internal\//.test(f.file)) ||
    frames[0]
  );
}

// ─── Error-trace detection ───────────────────────────────────────

const MARKERS: Array<{ kind: ErrorKind; re: RegExp }> = [
  { kind: 'typescript', re: /error\s+TS\d{3,5}\s*:/ },
  { kind: 'typescript', re: /Found \d+ error[s]?(\. Watching for file changes)?/ },
  { kind: 'jest', re: /^FAIL\s+\S+/m },
  { kind: 'jest', re: /Test Suites:\s+\d+\s+failed/i },
  { kind: 'jest', re: /Tests:\s+\d+\s+failed/i },
  { kind: 'jest', re: /●.*›|●\s+\S+/ },
  { kind: 'vitest', re: /Test Files\s+\d+\s+failed/i },
  { kind: 'vitest', re: /FAIL\s+.*\.(test|spec)\.[a-z]+/i },
  { kind: 'vitest', re: /AssertionError|Expected .* (toBe|toEqual|toMatch|toContain)/ },
  { kind: 'node', re: /(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\s*:/ },
  { kind: 'node', re: /Cannot find module\s+['"]/ },
  { kind: 'node', re: /ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/ },
  { kind: 'build', re: /Module not found/i },
  { kind: 'build', re: /npm ERR!|ERROR in .*Module/i },
  { kind: 'build', re: /Failed to compile/i },
];

function classifyLine(line: string): ErrorKind | null {
  for (const { kind, re } of MARKERS) {
    if (re.test(line)) return kind;
  }
  return null;
}

/**
 * Detect compiler/test error traces in a Herdr unwrapped scrollback buffer.
 * Groups marker lines with surrounding context + stack frames into traces.
 * Pure function — safe to unit test.
 */
export function detectErrorTraces(buffer: string, maxTraces = 8): ErrorTrace[] {
  const clean = stripAnsi(buffer);
  const lines = clean.split('\n');
  const traces: ErrorTrace[] = [];

  for (let i = 0; i < lines.length && traces.length < maxTraces; i++) {
    const line = lines[i];
    const kind = classifyLine(line);
    if (!kind) continue;

    // Gather a bounded window: marker line + next ~40 lines (stack + excerpt).
    const window = lines.slice(i, Math.min(lines.length, i + 40)).join('\n');
    const frames = parseStackFrames(window);
    const primary = primaryFrame(frames);

    // TypeScript locations carry file(line,col) directly on the marker line.
    let file = primary?.file;
    let lineNo = primary?.line;
    let colNo = primary?.column;
    let code: string | undefined;
    const tsMatch = line.match(TS_LOCATION_RE);
    if (tsMatch) {
      file = tsMatch[1].trim();
      lineNo = Number(tsMatch[2]);
      colNo = Number(tsMatch[3]);
      code = tsMatch[5];
    } else {
      const codeMatch = line.match(/(TS\d{3,5}|ERR_[A-Z_]+)/);
      if (codeMatch) code = codeMatch[1];
      // Jest "FAIL path/to/test" carries the failing suite on the marker.
      if (kind === 'jest' && !file) {
        const failMatch = line.match(/^FAIL\s+(\S+)/);
        if (failMatch) file = failMatch[1];
      }
    }

    const message = line.trim().slice(0, 300) || `${kind} failure`;
    const excerpt = window.split('\n').slice(0, 30).join('\n').slice(0, 2000);
    const hash = hashText(normalizeTraceKey([kind, code, message, file, lineNo]));

    // Skip exact duplicates within the same buffer scan.
    if (traces.some((t) => t.hash === hash)) continue;

    traces.push({ kind, message, code, file, line: lineNo, column: colNo, frames, excerpt, hash });

    // Advance past this window's stack so one failure yields one trace.
    let j = i + 1;
    while (j < lines.length && j < i + 40 && /^\s*at\s/.test(lines[j].trim())) j++;
    i = Math.max(i, j - 1);
  }

  return traces;
}

// ─── Hotpatch formulation (rule-based) ───────────────────────────

const TS_MISSING_NAME_RE = /Cannot find name '([^']+)'/;
const TS_MISSING_MODULE_RE = /Cannot find module '([^']+)'/;
const NODE_MISSING_MODULE_RE = /Cannot find module '([^']+)'/;
const TS_UNUSED_RE = /'([^']+)' is declared but its value is never read/;
const ASSERTION_RE = /Expected[:\s]+(.+?)\s+Received[:\s]+(.+)/s;

function verificationFor(kind: ErrorKind, file?: string): string {
  if (file && /\.(test|spec)\.[a-z]+$/.test(file)) return `npx vitest run ${file}`;
  switch (kind) {
    case 'typescript':
      return 'npx tsc --noEmit';
    case 'jest':
      return 'npx jest --silent';
    case 'vitest':
      return 'npx vitest run --silent';
    default:
      return 'npm test --silent';
  }
}

/**
 * Formulate a targeted hotpatch for a detected trace. Rule-based and
 * deterministic; returns a low-confidence `needsLlm` patch when no safe rule
 * matches so the caller can escalate to Gemma instead of guessing.
 * When `fileContents` is supplied, import-insertion rules anchor precisely.
 */
export function formulateHotpatch(trace: ErrorTrace, fileContents?: string): Hotpatch {
  const verify = verificationFor(trace.kind, trace.file);

  // Rule 1: TypeScript "Cannot find name 'X'" — likely a missing import.
  const missingName = trace.message.match(TS_MISSING_NAME_RE) || trace.excerpt.match(TS_MISSING_NAME_RE);
  if (missingName && trace.file) {
    const name = missingName[1];
    const op: HotpatchOp =
      fileContents !== undefined
        ? {
            type: 'insert-line',
            file: trace.file,
            line: 1,
            content: `import { ${name} } from './${name}'; // healer: verify source module`,
          }
        : {
            type: 'insert-line',
            file: trace.file,
            line: 1,
            content: `import { ${name} } from './${name}'; // healer: verify source module`,
          };
    return {
      diagnosis: `Missing identifier '${name}' in ${trace.file}${trace.line ? `:${trace.line}` : ''} (${trace.code || 'TS'}).`,
      rationale: `Insert a placeholder named import for '${name}' at the top of the file; the healer flags it for verification since the true source module needs confirmation.`,
      ops: [op],
      verificationCommand: verify,
      confidence: 0.5,
      needsLlm: true,
    };
  }

  // Rule 2: Missing module — distinguish relative-path typos from packages.
  const missingModule =
    trace.message.match(TS_MISSING_MODULE_RE) ||
    trace.message.match(NODE_MISSING_MODULE_RE) ||
    trace.excerpt.match(TS_MISSING_MODULE_RE) ||
    trace.excerpt.match(NODE_MISSING_MODULE_RE);
  if (missingModule) {
    const spec = missingModule[1];
    if (spec.startsWith('.') && trace.file) {
      return {
        diagnosis: `Unresolved relative import '${spec}' from ${trace.file}.`,
        rationale: `Relative import cannot be resolved — likely a wrong path or missing extension. Escalate to the model with the directory listing; do not guess a rewrite.`,
        ops: [],
        verificationCommand: verify,
        confidence: 0.35,
        needsLlm: true,
      };
    }
    return {
      diagnosis: `Missing package '${spec}'${trace.file ? ` required by ${trace.file}` : ''}.`,
      rationale: `The import target looks like an external package. Install it rather than editing source.`,
      ops: [],
      verificationCommand: `npm install ${spec} && ${verify}`,
      confidence: 0.7,
      needsLlm: false,
    };
  }

  // Rule 3: Unused locals (noUnusedLocals) — safe prefix-underscore fix.
  const unused = trace.message.match(TS_UNUSED_RE) || trace.excerpt.match(TS_UNUSED_RE);
  if (unused && trace.file && trace.line) {
    return {
      diagnosis: `Unused variable '${unused[1]}' in ${trace.file}:${trace.line} (TS6133).`,
      rationale: `Prefixing with an underscore is the idiomatic, behavior-preserving fix for noUnusedLocals failures.`,
      ops: [],
      verificationCommand: verify,
      confidence: 0.4,
      needsLlm: true,
    };
  }

  // Rule 4: Assertion mismatch — locate the spec from the stack, escalate.
  if (trace.kind === 'jest' || trace.kind === 'vitest') {
    const primary = primaryFrame(trace.frames);
    const suspect = primary ? `${primary.file}:${primary.line}` : trace.file || 'unknown spec';
    const assertion = trace.excerpt.match(ASSERTION_RE);
    return {
      diagnosis: assertion
        ? `Assertion mismatch in ${suspect}: expected ${assertion[1].trim().slice(0, 120)} but received ${assertion[2].trim().slice(0, 120)}.`
        : `Test failure in ${suspect}: ${trace.message.slice(0, 160)}.`,
      rationale: `Test semantics need model reasoning against the spec and implementation; the healer pins the suspect frame so Gemma patches the right file.`,
      ops: [],
      verificationCommand: verify,
      confidence: 0.3,
      needsLlm: true,
    };
  }

  // Rule 5: Generic compiler/build error with a location — escalate with context.
  return {
    diagnosis: `${trace.kind} failure${trace.file ? ` in ${trace.file}${trace.line ? `:${trace.line}` : ''}` : ''}: ${trace.message.slice(0, 200)}.`,
    rationale: `No safe deterministic rewrite matches; escalate the excerpt + stack to the model for a targeted diff.`,
    ops: [],
    verificationCommand: verify,
    confidence: 0.3,
    needsLlm: true,
  };
}

/**
 * Ask the model (Gemma) to synthesize a targeted patch for a trace that has
 * no safe rule. Returns null when the model call fails or yields nothing
 * usable — the caller keeps the rule-based patch as fallback.
 */
export async function formulateHotpatchWithLlm(
  provider: IProvider,
  trace: ErrorTrace,
  projectRoot: string,
): Promise<Hotpatch | null> {
  const suspectFile = trace.file;
  let snippet = '';
  if (suspectFile) {
    try {
      const abs = resolveProjectPath(projectRoot, suspectFile);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf-8');
        const lines = content.split('\n');
        const center = trace.line ? trace.line - 1 : 0;
        const from = Math.max(0, center - 30);
        const to = Math.min(lines.length, center + 30);
        snippet = lines
          .slice(from, to)
          .map((l, i) => `${from + i + 1}: ${l}`)
          .join('\n')
          .slice(0, 4000);
      }
    } catch {
      snippet = '';
    }
  }

  const prompt = [
    'You are MAOS Healer, a senior engineer writing a minimal hotpatch.',
    `Failure kind: ${trace.kind}. Message: ${trace.message}`,
    trace.file ? `Suspect: ${trace.file}${trace.line ? `:${trace.line}` : ''}` : 'Suspect: unknown',
    'Trace excerpt:',
    trace.excerpt.slice(0, 1500),
    snippet ? `Source context (line-numbered):\n${snippet}` : 'Source context: unavailable',
    'Reply ONLY with JSON: {"diagnosis": string, "rationale": string, "ops": [{"type": "replace-text"|"replace-line"|"insert-line", "file": string, "line"?: number, "find"?: string, "content": string}], "confidence": number}.',
    'Rules: at most 3 ops, all inside the project, no deletions of tests, prefer the smallest edit that fixes the root cause.',
  ].join('\n');

  try {
    const res = await provider.generate([{ role: 'user', content: prompt }]);
    const text = (res.content || '').trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      diagnosis?: string;
      rationale?: string;
      ops?: HotpatchOp[];
      confidence?: number;
    };
    if (!Array.isArray(parsed.ops) || parsed.ops.length === 0 || parsed.ops.length > 5) return null;
    const ops: HotpatchOp[] = [];
    for (const op of parsed.ops) {
      if (!op || typeof op.file !== 'string' || typeof op.content !== 'string') return null;
      if (!['replace-text', 'replace-line', 'insert-line', 'create-file'].includes(op.type)) return null;
      ops.push({ type: op.type, file: op.file, line: op.line, find: op.find, content: op.content.slice(0, 8000) });
    }
    return {
      diagnosis: String(parsed.diagnosis || `Model patch for ${trace.message}`.slice(0, 300)),
      rationale: String(parsed.rationale || 'Model-synthesized targeted fix.').slice(0, 500),
      ops,
      verificationCommand: verificationFor(trace.kind, trace.file),
      confidence: Math.min(0.95, Math.max(0.1, Number(parsed.confidence) || 0.6)),
      needsLlm: false,
    };
  } catch {
    return null;
  }
}

// ─── Patch application ───────────────────────────────────────────

function resolveProjectPath(projectRoot: string, rel: string): string {
  const abs = path.resolve(projectRoot, rel);
  const root = path.resolve(projectRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new HealerError('UNSAFE_PATH', `Refusing to patch outside project root: ${rel}`);
  }
  return abs;
}

function backupFile(absPath: string, projectRoot: string): string {
  const backupRoot = path.join(projectRoot, '.maos', 'healer-backups', `${Date.now()}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  const rel = path.relative(projectRoot, absPath).replace(/[/\\]/g, '__');
  const dest = path.join(backupRoot, rel || 'file.bak');
  fs.copyFileSync(absPath, dest);
  return backupRoot;
}

/**
 * Apply a hotpatch to the working tree. Returns the backup dir when any file
 * was modified. Throws HealerError on unsafe paths or failed ops.
 */
export function applyHotpatch(patch: Hotpatch, projectRoot: string): { backupDir?: string; filesTouched: string[] } {
  const filesTouched: string[] = [];
  let backupDir: string | undefined;

  for (const op of patch.ops) {
    const abs = resolveProjectPath(projectRoot, op.file);
    if (op.type === 'create-file') {
      if (fs.existsSync(abs)) {
        throw new HealerError('PATCH_FAILED', `create-file refused, already exists: ${op.file}`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, op.content, 'utf-8');
      filesTouched.push(op.file);
      continue;
    }

    if (!fs.existsSync(abs)) {
      throw new HealerError('PATCH_FAILED', `Target file not found: ${op.file}`);
    }
    if (!backupDir) backupDir = backupFile(abs, projectRoot);
    else {
      try {
        backupFile(abs, projectRoot);
      } catch {
        /* best effort for multi-file patches */
      }
    }

    const content = fs.readFileSync(abs, 'utf-8');
    const lines = content.split('\n');

    if (op.type === 'replace-text') {
      if (!op.find || !content.includes(op.find)) {
        throw new HealerError('PATCH_FAILED', `replace-text anchor not found in ${op.file}`);
      }
      fs.writeFileSync(abs, content.replace(op.find, op.content), 'utf-8');
    } else if (op.type === 'replace-line') {
      const idx = (op.line || 1) - 1;
      if (idx < 0 || idx >= lines.length) {
        throw new HealerError('PATCH_FAILED', `replace-line ${op.line} out of range in ${op.file}`);
      }
      lines[idx] = op.content;
      fs.writeFileSync(abs, lines.join('\n'), 'utf-8');
    } else if (op.type === 'insert-line') {
      const idx = Math.min(Math.max((op.line || 1) - 1, 0), lines.length);
      lines.splice(idx, 0, op.content);
      fs.writeFileSync(abs, lines.join('\n'), 'utf-8');
    }
    filesTouched.push(op.file);
  }

  return { backupDir, filesTouched };
}

// ─── Herdr CLI reader ────────────────────────────────────────────

function execHerdr(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('herdr', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new HealerError('HERDR_UNAVAILABLE', `herdr ${args.join(' ')} failed: ${(err.message || '').slice(0, 300)}`),
        );
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Default HerdrPaneReader backed by the `herdr` CLI over the IPC socket. */
export class CliHerdrPaneReader implements HerdrPaneReader {
  async listPanes(): Promise<HerdrPaneHandle[]> {
    const { stdout } = await execHerdr(['pane', 'list']);
    try {
      const parsed = JSON.parse(stdout) as {
        result?: { panes?: Array<Record<string, unknown>> };
      };
      const panes = parsed?.result?.panes || [];
      return panes
        .map((p) => ({
          paneId: String(p.pane_id || ''),
          tabId: p.tab_id ? String(p.tab_id) : undefined,
          workspaceId: p.workspace_id ? String(p.workspace_id) : undefined,
          agent: p.agent ? String(p.agent) : undefined,
          agentStatus: p.agent_status ? String(p.agent_status) : undefined,
          cwd: p.cwd ? String(p.cwd) : undefined,
        }))
        .filter((p) => p.paneId);
    } catch {
      throw new HealerError('HERDR_UNAVAILABLE', 'Could not parse `herdr pane list` JSON output.');
    }
  }

  async readBuffer(paneId: string, lines = 250): Promise<string> {
    // Unwrapped scrollback is the healer's source of truth: soft wraps joined,
    // so stack traces and assertion diffs survive intact.
    const { stdout } = await execHerdr([
      'pane',
      'read',
      paneId,
      '--source',
      'recent-unwrapped',
      '--lines',
      String(lines),
    ]);
    return stdout || '';
  }

  async runCommand(paneId: string, command: string): Promise<void> {
    await execHerdr(['pane', 'run', paneId, command]);
  }
}

/** Split a sibling pane for a worker. Shared with `maos ignite`. */
export async function herdrSplitPane(opts: {
  direction?: 'right' | 'down';
  cwd?: string;
  noFocus?: boolean;
  targetPane?: string;
}): Promise<string> {
  const target = opts.targetPane ? ['--pane', opts.targetPane] : ['--current'];
  const args = ['pane', 'split', ...target, '--direction', opts.direction || 'right'];
  if (opts.cwd) args.push('--cwd', opts.cwd);
  args.push(opts.noFocus === false ? '--focus' : '--no-focus');
  const { stdout } = await execHerdr(args);
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: string } } };
    const paneId = parsed?.result?.pane?.pane_id;
    if (!paneId) throw new Error('missing pane_id');
    return paneId;
  } catch {
    throw new HealerError('HERDR_UNAVAILABLE', 'Could not parse `herdr pane split` JSON output.');
  }
}

/** Move a pane to a new tab or target pane. */
export async function herdrMovePane(
  paneId: string,
  opts: { newTab?: boolean; label?: string; noFocus?: boolean },
): Promise<void> {
  const args = ['pane', 'move', paneId];
  if (opts.newTab) args.push('--new-tab');
  if (opts.label) args.push('--label', opts.label);
  if (opts.noFocus) args.push('--no-focus');
  await execHerdr(args);
}

/** Close a pane. Safe if already closed. */
export async function herdrPaneClose(paneId: string): Promise<void> {
  try {
    await execHerdr(['pane', 'close', paneId]);
  } catch {}
}

export async function isHerdrAvailable(): Promise<boolean> {
  try {
    await execHerdr(['status'], 8000);
    return true;
  } catch {
    return false;
  }
}

// ─── AutonomousHealer ────────────────────────────────────────────

export class AutonomousHealer {
  private opts: Required<
    Pick<
      AutonomousHealerOptions,
      'pollIntervalMs' | 'lines' | 'maxHealsPerPane' | 'cooldownMs' | 'minAutoApplyConfidence' | 'rerunTests'
    >
  > &
    AutonomousHealerOptions;
  private reader: HerdrPaneReader;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private seen = new Map<string, number>();
  private healsPerPane = new Map<string, number>();
  private lastHealAt = new Map<string, number>();
  private stats: HealerStats;
  private running = false;

  constructor(options: AutonomousHealerOptions) {
    this.opts = {
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? 4000,
      lines: options.lines ?? 250,
      maxHealsPerPane: options.maxHealsPerPane ?? 5,
      cooldownMs: options.cooldownMs ?? 10_000,
      minAutoApplyConfidence: options.minAutoApplyConfidence ?? 0.55,
      rerunTests: options.rerunTests ?? true,
    };
    this.reader = options.reader || new CliHerdrPaneReader();
    this.logger = options.logger || createLogger(options.projectRoot);
    this.stats = {
      polls: 0,
      panesWatched: 0,
      tracesSeen: 0,
      patchesApplied: 0,
      patchesSkippedLowConfidence: 0,
      failures: 0,
      startedAt: Date.now(),
    };
  }

  getStats(): HealerStats {
    return { ...this.stats, panesWatched: this.lastPaneCount };
  }

  private lastPaneCount = 0;

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      'HEALER',
      `Closed-loop healer started (poll ${this.opts.pollIntervalMs}ms, panes: ${this.opts.paneIds?.join(',') || 'auto-discover'})`,
    );
    void this.sweep().catch((err: unknown) => {
      this.stats.failures++;
      this.logger.warn('HEALER', `Initial sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.timer = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        this.stats.failures++;
        this.logger.warn('HEALER', `Periodic sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.opts.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info(
      'HEALER',
      `Healer stopped after ${this.stats.polls} polls: ${this.stats.patchesApplied} applied, ${this.stats.patchesSkippedLowConfidence} skipped, ${this.stats.failures} failures`,
    );
  }

  /** Run one heal sweep across the watched panes (also used by `maos ignite`). */
  async healOnce(): Promise<HealAttempt[]> {
    return this.sweep();
  }

  private async resolvePanes(): Promise<HerdrPaneHandle[]> {
    if (this.opts.paneIds && this.opts.paneIds.length > 0) {
      return this.opts.paneIds.map((paneId) => ({ paneId }));
    }
    return this.reader.listPanes();
  }

  private async sweep(): Promise<HealAttempt[]> {
    const attempts: HealAttempt[] = [];
    try {
      let panes: HerdrPaneHandle[];
      try {
        panes = await this.resolvePanes();
      } catch (err: unknown) {
        this.stats.failures++;
        this.logger.warn('HEALER', err instanceof Error ? err.message : String(err));
        return attempts;
      }
      this.lastPaneCount = panes.length;
      this.stats.polls++;

      for (const pane of panes) {
        try {
          const buffer = await this.reader.readBuffer(pane.paneId, this.opts.lines);
          if (!buffer || buffer.trim().length === 0) continue;
          const traces = detectErrorTraces(buffer);
          for (const trace of traces) {
            const seenKey = `${pane.paneId}:${trace.hash}`;
            if (this.seen.has(seenKey)) continue;
            this.seen.set(seenKey, Date.now());
            this.stats.tracesSeen++;
            try {
              const attempt = await this.healTrace(pane.paneId, trace);
              if (attempt) attempts.push(attempt);
            } catch (healErr: unknown) {
              this.stats.failures++;
              this.logger.warn(
                'HEALER',
                `Pane ${pane.paneId} heal attempt failed: ${healErr instanceof Error ? healErr.message : String(healErr)}`,
              );
            }
          }
        } catch (err: unknown) {
          this.stats.failures++;
          this.logger.warn('HEALER', `Pane ${pane.paneId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Bound the dedupe map (1h TTL sweep).
      if (this.seen.size > 2000) {
        const cutoff = Date.now() - 3600_000;
        for (const [k, v] of this.seen) {
          if (v < cutoff) this.seen.delete(k);
        }
      }
    } catch (globalErr: unknown) {
      this.stats.failures++;
      this.logger.warn(
        'HEALER',
        `Unexpected sweep error: ${globalErr instanceof Error ? globalErr.message : String(globalErr)}`,
      );
    }
    return attempts;
  }

  private async healTrace(paneId: string, trace: ErrorTrace): Promise<HealAttempt | null> {
    const safeEmit = (event: Parameters<NonNullable<typeof this.opts.bus>['emit']>[0]) => {
      try {
        this.opts.bus?.emit(event);
      } catch (err: unknown) {
        this.logger.warn('HEALER', `Event bus emit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const safeOnHeal = (attempt: HealAttempt) => {
      try {
        this.opts.onHeal?.(attempt);
      } catch (err: unknown) {
        this.logger.warn('HEALER', `onHeal handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const heals = this.healsPerPane.get(paneId) || 0;
    if (heals >= (this.opts.maxHealsPerPane as number)) {
      this.logger.warn(
        'HEALER',
        `Pane ${paneId}: heal budget exhausted (${heals}/${this.opts.maxHealsPerPane}) — needs human review: ${trace.message.slice(0, 120)}`,
      );
      safeEmit(
        createEvent('TASK_FAILED', `healer:${paneId}`, {
          reason: 'heal budget exhausted',
          trace: trace.message.slice(0, 200),
          file: trace.file,
        }),
      );
      return null;
    }
    const lastAt = this.lastHealAt.get(paneId) || 0;
    if (Date.now() - lastAt < (this.opts.cooldownMs as number)) return null;

    this.logger.warn('HEALER', `Pane ${paneId}: ${trace.kind} failure — ${trace.message.slice(0, 160)}`);
    safeEmit(
      createEvent('TASK_PROGRESS', `healer:${paneId}`, {
        phase: 'HEAL_DIAGNOSED',
        kind: trace.kind,
        message: trace.message.slice(0, 200),
        file: trace.file,
        line: trace.line,
      }),
    );

    let patch = formulateHotpatch(trace);
    if (patch.needsLlm && this.opts.provider && patch.ops.length === 0) {
      const llmPatch = await formulateHotpatchWithLlm(this.opts.provider, trace, this.opts.projectRoot);
      if (llmPatch) patch = llmPatch;
    }

    if (patch.ops.length === 0 || patch.confidence < (this.opts.minAutoApplyConfidence as number)) {
      this.stats.patchesSkippedLowConfidence++;
      this.logger.warn(
        'HEALER',
        `Pane ${paneId}: patch withheld (confidence ${patch.confidence.toFixed(2)}, needs review) — ${patch.diagnosis.slice(0, 160)}`,
      );
      safeEmit(
        createEvent('TASK_PROGRESS', `healer:${paneId}`, {
          phase: 'HEAL_WITHHELD',
          diagnosis: patch.diagnosis.slice(0, 200),
          confidence: patch.confidence,
        }),
      );
      const withheld: HealAttempt = {
        paneId,
        trace,
        patch,
        applied: false,
        appliedAt: Date.now(),
        note: 'withheld: low confidence / needs review',
      };
      safeOnHeal(withheld);
      return withheld;
    }

    try {
      const { backupDir, filesTouched } = applyHotpatch(patch, this.opts.projectRoot);
      this.healsPerPane.set(paneId, heals + 1);
      this.lastHealAt.set(paneId, Date.now());
      this.stats.patchesApplied++;
      this.logger.success(
        'HEALER',
        `Pane ${paneId}: hotpatch applied to ${filesTouched.join(', ')} — ${patch.diagnosis.slice(0, 140)}`,
      );
      safeEmit(
        createEvent('TASK_PROGRESS', `healer:${paneId}`, {
          phase: 'HEAL_APPLIED',
          files: filesTouched,
          diagnosis: patch.diagnosis.slice(0, 200),
          backupDir,
        }),
      );

      if (this.opts.rerunTests && this.reader.runCommand) {
        try {
          await this.reader.runCommand(paneId, patch.verificationCommand);
        } catch (err: unknown) {
          this.logger.warn(
            'HEALER',
            `Pane ${paneId}: verification re-run failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const attempt: HealAttempt = {
        paneId,
        trace,
        patch,
        applied: true,
        backupDir,
        appliedAt: Date.now(),
        note: `applied to ${filesTouched.join(', ')}`,
      };
      safeOnHeal(attempt);
      return attempt;
    } catch (err: unknown) {
      this.stats.failures++;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('HEALER', `Pane ${paneId}: patch failed — ${message}`);
      return null;
    }
  }
}

/** Convenience: create a healer watching explicit panes with defaults. */
export function createAutonomousHealer(options: AutonomousHealerOptions): AutonomousHealer {
  return new AutonomousHealer(options);
}
