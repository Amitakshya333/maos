import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL, ProviderApiPolicyError } from '../backends/meta-api-policy';
import { RING_STREAM_EVENT_TYPES } from './ring-contract';
import { OpenAIProvider } from '../backends/openai-provider';
import type { ChatMessage, IProvider, ToolDef } from '../backends/provider';
import type { Project } from '../domain/schemas';
import { analyzeTelemetryCsv, loadTelemetryDemoThresholds } from '../industrial/telemetry-analysis';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';

export type RingAgentRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export type RingAgentMode = 'hosted' | 'evidence-only';
export type RingAgentApprovalDecision = 'approved' | 'denied';

export interface RingAgentRunContext {
  /**
   * TASK RING-ADAPTER-01 (A6): accepted-and-ignored for this release.
   * Recorded as run.started metadata only; the Ring lead always executes.
   */
  agentId?: string;
  csvPath?: string;
  exportPath?: string;
  evidenceRoot?: string;
  analysisId?: string;
  documentPath?: string;
}

export interface RingAgentPendingApproval {
  approvalId: string;
  toolName: string;
  summary: string;
  reason: string;
  argsSummary: Record<string, unknown>;
  createdAt: string;
}

export interface RingAgentTranscriptEntry {
  ts: string;
  runId: string;
  type: string;
  [key: string]: unknown;
}

/**
 * TASK RING-ADAPTER-01 (A1/A2): one wire event as consumed by the Ring UI
 * validator (src/gui/src/api/ring-run-types.ts). This is a mapped projection
 * of a JSONL transcript entry; the JSONL entry itself is never rewritten.
 */
export interface RingStreamWireFields {
  delta?: string;
  plan?: Array<{ step: string; status: 'pending' | 'in_progress' | 'done' }>;
  artifact?: { path: string; kind: string; size: number; sha256: string };
  memory?: { noteId: string; summary: string };
}

export interface RingAgentWireEvent extends RingStreamWireFields {
  type: string;
  ts: string;
  /**
   * Set only on `run.started`: the run's resolved mode at snapshot time.
   * The transcript's own stored `mode` is a start-time placeholder, so the
   * mapper projects the live run mode instead of echoing a stale value.
   */
  mode?: string;
  text?: string;
  tool?: string;
  toolCallId?: string;
  argsSummary?: string;
  resultSummary?: string;
  verdict?: string;
  overallRms?: number;
  sources?: string[];
  approvalId?: string;
  action?: string;
  reason?: string;
  decision?: string;
  message?: string;
}

export interface RingAgentRunSnapshot {
  runId: string;
  instruction: string;
  status: RingAgentRunStatus;
  mode: RingAgentMode;
  createdAt: string;
  updatedAt: string;
  finalAnswer?: string;
  error?: string;
  pendingApproval?: RingAgentPendingApproval;
  transcriptPath: string;
  transcript: RingAgentTranscriptEntry[];
  /** TASK RING-ADAPTER-01 (A1): UI wire projection of `transcript`. */
  events: RingAgentWireEvent[];
  turns: number;
}

export class RingAgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RingAgentError';
  }
}

export interface RingKbSearchLike {
  searchSync?: (input: Record<string, unknown>) => unknown;
  search?: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface RingAgentServiceOptions {
  projectRoot: string;
  auditService?: AuditService;
  endpointAllowlist?: EndpointAllowlistService;
  loadProjectConfig?: () => Project | undefined;
  fetch?: typeof globalThis.fetch;
  providerFactory?: () => IProvider;
  kbSearch?: RingKbSearchLike;
  maxTurns?: number;
  evidenceRoot?: string;
}

interface ToolResultProjection {
  verdict?: string;
  overallRms?: number;
  sources?: string[];
}

interface PendingInternal extends RingAgentPendingApproval {
  toolCallId: string;
  args: Record<string, unknown>;
  resolver: (decision: RingAgentApprovalDecision | 'cancelled') => void;
}

interface InternalRun {
  runId: string;
  instruction: string;
  context: RingAgentRunContext;
  status: RingAgentRunStatus;
  mode: RingAgentMode;
  createdAt: string;
  updatedAt: string;
  finalAnswer?: string;
  error?: string;
  transcriptPath: string;
  transcriptRel: string;
  transcript: RingAgentTranscriptEntry[];
  abortController: AbortController;
  cancelled: boolean;
  pending?: PendingInternal;
  conversation: ChatMessage[];
  /** TASK RING-ADAPTER-01 (A2): structured tool-result fields keyed by toolCallId. */
  toolResultProjections: Map<string, ToolResultProjection>;
  turns: number;
  evidenceRootAbs: string;
  completion: Promise<RingAgentRunSnapshot>;
}

const DEFAULT_MAX_TURNS = 12;
const CONSEQUENTIAL_TOOLS = new Set(['draft_safety_note', 'request_approval']);

export const RING_AGENT_TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'analyze_telemetry', description: 'Run the deterministic telemetry analysis on the bundled turbine vibration sample or a project-relative CSV path. Returns verdict, RMS and threshold breaches only; never raw CSV rows.', parameters: { type: 'object', properties: { csvPath: { type: 'string', description: 'Optional project-root-relative CSV path. Defaults to the bundled sample.' } } } } },
  { type: 'function', function: { name: 'read_company_document', description: 'Read a text company document located under the project evidence root. Paths outside the evidence root are refused.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Document path relative to the evidence root (or project-relative inside it).' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_knowledge', description: 'Search indexed company knowledge if an index is available. Returns an honest unavailable/no-answer result when no index exists; never fabricates results.', parameters: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'draft_safety_note', description: 'Draft a safety note as text and write it under .maos/ring-runs/drafts after human approval. CONSEQUENTIAL: requires approval before any file is written.', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, filename: { type: 'string' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'verify_export', description: 'Verify an audit export (or the live audit trail) using the real audit chain verification code path.', parameters: { type: 'object', properties: { exportPath: { type: 'string', description: 'Optional project-relative audit export JSON path.' } } } } },
  { type: 'function', function: { name: 'request_approval', description: 'Ask a human to approve a proposed consequential action. Pauses the run until the approval is resolved.', parameters: { type: 'object', properties: { summary: { type: 'string' }, reason: { type: 'string' } }, required: ['summary'] } } },
];

function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isStrictlyWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export class RingAgentService {
  private readonly projectRoot: string;
  private readonly auditService?: AuditService;
  private readonly loadProjectConfig: () => Project | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly providerFactory?: () => IProvider;
  private readonly kbSearch?: RingKbSearchLike;
  private readonly maxTurns: number;
  private readonly evidenceRootOption?: string;
  private readonly runs = new Map<string, InternalRun>();
  private readonly listeners = new Set<(entry: RingAgentTranscriptEntry) => void>();

  constructor(options: RingAgentServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.auditService = options.auditService;
    this.fetchImpl = options.fetch;
    this.providerFactory = options.providerFactory;
    this.kbSearch = options.kbSearch;
    this.maxTurns = typeof options.maxTurns === 'number' && Number.isFinite(options.maxTurns) && options.maxTurns > 0 ? Math.floor(options.maxTurns) : DEFAULT_MAX_TURNS;
    this.evidenceRootOption = options.evidenceRoot;
    this.loadProjectConfig = options.loadProjectConfig || (() => {
      const configPath = path.resolve(this.projectRoot, '.maos', 'maos.config.json');
      if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return undefined; }
      }
      return undefined;
    });
  }

  onEvent(listener: (entry: RingAgentTranscriptEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startRun(instruction: string, context: RingAgentRunContext = {}): string {
    const trimmed = typeof instruction === 'string' ? instruction.trim() : '';
    if (!trimmed) throw new RingAgentError('RING_AGENT_INVALID', 'RING_AGENT_INVALID: instruction is required and must be a non-empty string.');
    const runId = `ring-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const runsDir = path.join(this.projectRoot, '.maos', 'ring-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const transcriptPath = path.join(runsDir, `${runId}.jsonl`);
    const evidenceRootAbs = this.resolveEvidenceRoot(context);
    const now = new Date().toISOString();
    let resolveCompletion!: (snapshot: RingAgentRunSnapshot) => void;
    const completion = new Promise<RingAgentRunSnapshot>((resolve) => { resolveCompletion = resolve; });
    const run: InternalRun = { runId, instruction: trimmed, context: context || {}, status: 'running', mode: 'evidence-only', createdAt: now, updatedAt: now, transcriptPath, transcriptRel: `.maos/ring-runs/${runId}.jsonl`, transcript: [], abortController: new AbortController(), cancelled: false, conversation: [], toolResultProjections: new Map(), turns: 0, evidenceRootAbs, completion };
    this.runs.set(runId, run);
    this.record(run, { type: 'run.started', status: 'running', agentId: run.context.agentId || 'ring-lead', requestedAgentId: run.context.agentId, instructionSummary: truncate(trimmed, 500), contextSummary: this.summarizeContext(context) });
    void this.execute(run).then(() => resolveCompletion(this.snapshot(run)), () => resolveCompletion(this.snapshot(run)));
    return runId;
  }

  getRun(runId: string): RingAgentRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  getTranscript(runId: string): RingAgentTranscriptEntry[] {
    const run = this.runs.get(runId);
    if (run) return [...run.transcript];
    const file = path.join(this.projectRoot, '.maos', 'ring-runs', `${runId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) as RingAgentTranscriptEntry; } catch { return { ts: '', runId, type: 'transcript.unparsable' }; } });
  }

  async waitForRun(runId: string, timeoutMs = 30000): Promise<RingAgentRunSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = this.getRun(runId);
      if (!snap) throw new RingAgentError('RING_RUN_NOT_FOUND', `Ring run '${runId}' was not found.`);
      if (snap.status !== 'running') return snap;
      if (Date.now() > deadline) return snap;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForCompletion(runId: string, timeoutMs = 30000): Promise<RingAgentRunSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = this.getRun(runId);
      if (!snap) throw new RingAgentError('RING_RUN_NOT_FOUND', `Ring run '${runId}' was not found.`);
      if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') return snap;
      if (Date.now() > deadline) return snap;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  resolveApproval(runId: string, approvalId: string, decision: RingAgentApprovalDecision): RingAgentRunSnapshot {
    if (decision !== 'approved' && decision !== 'denied') throw new RingAgentError('VALIDATION_FAILED', "decision must be 'approved' or 'denied'.");
    const run = this.runs.get(runId);
    if (!run) throw new RingAgentError('RING_RUN_NOT_FOUND', `Ring run '${runId}' was not found.`);
    if (!run.pending || run.status !== 'awaiting_approval') throw new RingAgentError('APPROVAL_NOT_PENDING', `Ring run '${runId}' has no pending approval.`);
    if (run.pending.approvalId !== approvalId) throw new RingAgentError('APPROVAL_NOT_FOUND', `Approval '${approvalId}' was not found for ring run '${runId}'.`);
    const pending = run.pending;
    run.pending = undefined;
    this.record(run, { type: 'approval.resolved', approvalId, toolName: pending.toolName, decision });
    if (this.auditService) {
      try { this.auditService.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: 'RING_APPROVAL_RESOLVED', runId, approvalId, toolName: pending.toolName, decision } }); } catch { /* audit must not break approval resolution */ }
    }
    pending.resolver(decision);
    if (decision === 'approved' && run.status === 'awaiting_approval') { run.status = 'running'; run.updatedAt = new Date().toISOString(); }
    return this.snapshot(run);
  }

  cancelRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status === 'completed' || run.status === 'failed' || (run.status as string) === 'cancelled') return false;
    run.cancelled = true;
    run.status = 'cancelled';
    run.updatedAt = new Date().toISOString();
    const pending = run.pending;
    run.pending = undefined;
    this.record(run, { type: 'run.cancelled', status: 'cancelled', approvalId: pending?.approvalId });
    try { run.abortController.abort(); } catch { /* best effort */ }
    if (pending) pending.resolver('cancelled');
    return true;
  }

  /**
   * TASK RING-ADAPTER-01 (A3): compact k=v rendering of summarizeArgs() for
   * the wire. Keys with undefined values (summarizeArgs pads absent args with
   * undefined) are omitted, so the string never invents values.
   */
  private formatArgsSummary(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
    return parts.length ? parts.join(' ') : undefined;
  }

  private projectToolResult(result: Record<string, unknown>): ToolResultProjection {
    const out: ToolResultProjection = {};
    if (typeof result.verdict === 'string' && result.verdict) out.verdict = result.verdict;
    if (typeof result.overallVibrationRms === 'number' && Number.isFinite(result.overallVibrationRms)) out.overallRms = result.overallVibrationRms;
    if (typeof result.source === 'string' && result.source) out.sources = [result.source];
    return out;
  }

  private summarizeToolResult(result: Record<string, unknown>, ok: boolean): string | undefined {
    if (!ok) {
      const err = typeof result.error === 'string' && result.error ? result.error
        : typeof result.message === 'string' && result.message ? result.message : undefined;
      return err;
    }
    if (typeof result.verdict === 'string' && result.verdict) return `Verdict: ${result.verdict}`;
    if (typeof result.message === 'string' && result.message) return result.message;
    if (typeof result.valid === 'boolean') return `Audit export verification: valid=${result.valid}`;
    if (typeof result.path === 'string' && result.path) return result.path;
    if (typeof result.answered === 'boolean') return result.answered ? 'Knowledge search returned results.' : 'Knowledge search returned no answer.';
    return truncate(JSON.stringify(result), 300);
  }

  /**
   * TASK RING-ADAPTER-01 (A1/A2/A4): map one JSONL transcript entry to its
   * wire event. Returns null for entries the UI must never see
   * (`mode.evidence-only` — mode is already carried by run.started/snapshot).
   * The JSONL transcript on disk is untouched; this is a snapshot-time
   * projection only, so direct transcript readers keep the object
   * argsSummary and the mode marker.
   */
  private toWireEvent(run: InternalRun, entry: RingAgentTranscriptEntry): RingAgentWireEvent | null {
    if (entry.type === 'mode.evidence-only') return null;
    const wire: RingAgentWireEvent = { type: entry.type, ts: entry.ts };
    if (typeof entry.toolCallId === 'string' && entry.toolCallId) wire.toolCallId = entry.toolCallId;
    if (typeof entry.toolName === 'string' && entry.toolName) wire.tool = entry.toolName;
    const argsSummary = this.formatArgsSummary(entry.argsSummary);
    if (argsSummary) wire.argsSummary = argsSummary;
    switch (entry.type) {
      case 'run.started': {
        wire.mode = run.mode;
        break;
      }
      case 'model.turn': {
        if (typeof entry.contentSummary === 'string' && entry.contentSummary) wire.text = entry.contentSummary;
        break;
      }
      case 'tool.result': {
        const projection = typeof entry.toolCallId === 'string' ? run.toolResultProjections.get(entry.toolCallId) : undefined;
        if (projection?.verdict) wire.verdict = projection.verdict;
        if (projection?.overallRms !== undefined) wire.overallRms = projection.overallRms;
        if (projection?.sources?.length) wire.sources = [...projection.sources];
        if (typeof entry.summary === 'string' && entry.summary) wire.resultSummary = entry.summary;
        break;
      }
      case 'approval.pending': {
        if (typeof entry.approvalId === 'string' && entry.approvalId) wire.approvalId = entry.approvalId;
        if (typeof entry.summary === 'string' && entry.summary) wire.action = entry.summary;
    
        if (typeof entry.reason === 'string' && entry.reason) wire.reason = entry.reason;
        break;
      }
      case 'approval.resolved': {
        if (typeof entry.approvalId === 'string' && entry.approvalId) wire.approvalId = entry.approvalId;
        if (entry.decision === 'approved' || entry.decision === 'denied') wire.decision = entry.decision;
        break;
      }
      case 'run.failed': {
        const msg = typeof entry.error === 'string' && entry.error ? entry.error
          : typeof entry.message === 'string' && entry.message ? (entry.message as string) : undefined;
        if (msg) wire.message = msg;
        break;
      }
      default:
        break;
    }
    if ((RING_STREAM_EVENT_TYPES as readonly string[]).includes(entry.type)) {
      if (entry.type === 'model.delta' && typeof entry.delta === 'string') wire.delta = entry.delta;
      if (entry.type === 'plan.updated' && Array.isArray(entry.plan)) wire.plan = entry.plan as RingStreamWireFields['plan'];
      if (entry.type === 'artifact.created' && entry.artifact && typeof entry.artifact === 'object') wire.artifact = entry.artifact as RingStreamWireFields['artifact'];
      if (entry.type === 'memory.saved' && entry.memory && typeof entry.memory === 'object') wire.memory = entry.memory as RingStreamWireFields['memory'];
    }
    return wire;
  }

  private snapshot(run: InternalRun): RingAgentRunSnapshot {
    return { runId: run.runId, instruction: run.instruction, status: run.status, mode: run.mode, createdAt: run.createdAt, updatedAt: run.updatedAt, finalAnswer: run.finalAnswer, error: run.error, pendingApproval: run.pending ? { approvalId: run.pending.approvalId, toolName: run.pending.toolName, summary: run.pending.summary, reason: run.pending.reason, argsSummary: run.pending.argsSummary, createdAt: run.pending.createdAt } : undefined, transcriptPath: run.transcriptRel, transcript: [...run.transcript], events: run.transcript.map((entry) => this.toWireEvent(run, entry)).filter((e) => e !== null), turns: run.turns };
  }

  private resolveEvidenceRoot(context: RingAgentRunContext): string {
    const configured = context.evidenceRoot || this.evidenceRootOption || this.safeConfigEvidenceRoot() || 'demo/industrial';
    return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(this.projectRoot, configured);
  }

  private safeConfigEvidenceRoot(): string | undefined {
    try { const cfg = this.loadProjectConfig(); const root = cfg?.profile?.evidenceRoot; return typeof root === 'string' && root.trim() ? root.trim() : undefined; } catch { return undefined; }
  }

  private summarizeContext(context: RingAgentRunContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (context.csvPath) out.csvPath = context.csvPath;
    if (context.exportPath) out.exportPath = context.exportPath;
    if (context.evidenceRoot) out.evidenceRoot = context.evidenceRoot;
    if (context.analysisId) out.analysisId = context.analysisId;
    if (context.documentPath) out.documentPath = context.documentPath;
    return out;
  }

  private redact(text: string): string {
    let out = text;
    const key = process.env[BASETEN_API_KEY_ENV];
    if (key && key.trim()) out = out.split(key).join('[REDACTED]');
    return out;
  }

  private readonly streamListeners = new Set<(runId: string, event: RingAgentWireEvent) => void>();

  /**
   * TASK RING-CONTRACT-01 (Dev B hook): subscribe to mapped wire events for
   * the live streaming path. The Dev B lane persists each event as a
   * SequencedEvent (`eventType: ring.run.<type>`, `runId` set) via
   * EventService.recordEvent so the existing WS /api/v1/events channel
   * (runId-scoped, sequenced + replay) delivers it; GET /ring/runs/:id stays
   * the documented snapshot fallback. Listener exceptions never break the
   * run; the JSONL transcript on disk is untouched.
   */
  onStreamEvent(listener: (runId: string, event: RingAgentWireEvent) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private emitStreamEvent(run: InternalRun, entry: RingAgentTranscriptEntry): void {
    if (this.streamListeners.size === 0) return;
    let wire: RingAgentWireEvent | null = null;
    try { wire = this.toWireEvent(run, entry); } catch { return; }
    if (!wire) return;
    for (const l of this.streamListeners) { try { l(run.runId, wire); } catch {} }
  }

  private record(run: InternalRun, entry: Omit<RingAgentTranscriptEntry, 'ts' | 'runId'> & { type: string }): void {
    const full: RingAgentTranscriptEntry = { ts: new Date().toISOString(), runId: run.runId, mode: run.mode, status: run.status, ...entry };
    run.transcript.push(full);
    run.updatedAt = full.ts as string;
    try { fs.appendFileSync(run.transcriptPath, `${JSON.stringify(full)}\n`, 'utf-8'); } catch {}
    for (const l of this.listeners) { try { l(full); } catch {} }
    this.emitStreamEvent(run, full);
  }

  private checkBasetenArming(): { isArmed: boolean; apiKey?: string } {
    if (this.providerFactory) return { isArmed: true };
    const cfg = this.loadProjectConfig();
    const baseten = cfg?.providers?.baseten as Record<string, unknown> | undefined;
    if (!baseten || baseten.basetenApiEnabled !== true) return { isArmed: false };
    if (baseten.baseURL !== BASETEN_API_BASE_URL) {
      throw new ProviderApiPolicyError('BASETEN_API_CONFIGURATION_INVALID', `Baseten Model API is limited to provider "baseten", ${BASETEN_API_BASE_URL}, and model ${BASETEN_API_MODEL}.`);
    }
    const model = (typeof baseten.model === 'string' && baseten.model) || cfg?.agents?.find((a) => a.provider === 'baseten')?.model || BASETEN_API_MODEL;
    if (model !== BASETEN_API_MODEL) {
      throw new ProviderApiPolicyError('BASETEN_API_CONFIGURATION_INVALID', `Baseten Model API is limited to provider "baseten", ${BASETEN_API_BASE_URL}, and model ${BASETEN_API_MODEL}.`);
    }
    const apiKey = process.env[BASETEN_API_KEY_ENV];
    if (!apiKey || !apiKey.trim()) return { isArmed: false };
    return { isArmed: true, apiKey: apiKey.trim() };
  }

  private async execute(run: InternalRun): Promise<void> {
    try {
      let arming: { isArmed: boolean; apiKey?: string };
      try { arming = this.checkBasetenArming(); } catch (err) { this.fail(run, err); return; }
      if (!arming.isArmed) { run.mode = 'evidence-only'; await this.executeEvidenceOnly(run); return; }
      run.mode = 'hosted';
      await this.executeHosted(run, arming.apiKey);
    } catch (err) {
      if ((run.status as string) === 'cancelled' || run.cancelled) this.ensureCancelled(run);
      else if (run.status === 'running' || run.status === 'awaiting_approval') this.fail(run, err);
    } finally {
      if (run.status === 'running' || run.status === 'awaiting_approval') {
        if (run.cancelled) this.ensureCancelled(run);
        else this.fail(run, new Error('RING_AGENT_INCOMPLETE: agent loop ended without a final answer.'));
      }
    }
  }

  private ensureCancelled(run: InternalRun): void {
    if (run.status !== 'cancelled') {
      run.status = 'cancelled';
      run.updatedAt = new Date().toISOString();
      this.record(run, { type: 'run.cancelled', status: 'cancelled' });
    }
  }

  private fail(run: InternalRun, err: unknown): void {
    if ((run.status as string) === 'cancelled' || run.cancelled) { this.ensureCancelled(run); return; }
    const message = this.redact(err instanceof Error ? err.message : String(err));
    run.status = 'failed';
    run.error = truncate(message, 1000);
    run.updatedAt = new Date().toISOString();
    this.record(run, { type: 'run.failed', status: 'failed', error: truncate(message, 500) });
  }

  private complete(run: InternalRun, finalAnswer: string): void {
    if ((run.status as string) === 'cancelled' || run.cancelled) { this.ensureCancelled(run); return; }
    run.status = 'completed';
    run.finalAnswer = finalAnswer;
    run.updatedAt = new Date().toISOString();
    this.record(run, { type: 'run.completed', status: 'completed', finalAnswerSummary: truncate(finalAnswer, 1000) });
  }

  private telemetrySummaryText(csvPath?: string): { summary: string } {
    try {
      const r = this.toolAnalyzeTelemetry({ csvPath });
      return { summary: [`verdict=${String(r.verdict)}`, `overallVibrationRms=${String(r.overallVibrationRms)} mm/s`, `peakVibration=${String(r.peakVibration)} mm/s`, `peakTemperature=${String(r.peakTemperature)} C`, `rowsAnalyzed=${String(r.rowsAnalyzed)}`, `warnings=${String(r.warningCount)} critical=${String(r.criticalCount)}`, `findings=${JSON.stringify(r.findings ?? [])}`, `source=${String(r.source ?? '')}`].join('; ') };
    } catch (err) {
      return { summary: `Telemetry summary unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async executeEvidenceOnly(run: InternalRun): Promise<void> {
    this.record(run, { type: 'mode.evidence-only', mode: 'evidence-only' });
    const text = run.instruction.toLowerCase();
    const wantsTelemetry = /telemetry|vibration|turbine|rms|\bcsv\b|bearing/.test(text) || Boolean(run.context.csvPath);
    const wantsVerify = /audit|verify|export|chain/.test(text);
    const wantsDocument = /document|\bsop\b|maintenance report|read/.test(text);
    const wantsSearch = /search|knowledge|find in|look up/.test(text);
    const results: Array<{ name: string; result: Record<string, unknown> }> = [];
    const runTool = async (name: string, args: Record<string, unknown>) => {
      const out = await this.executeToolLogged(run, `evidence-${results.length + 1}`, name, args);
      results.push({ name, result: out.result });
    };
    if (wantsTelemetry) await runTool('analyze_telemetry', run.context.csvPath ? { csvPath: run.context.csvPath } : {});
    if (wantsDocument) await runTool('read_company_document', { path: run.context.documentPath || 'sop_turbine_vibration_monitoring.md' });
    if (wantsVerify) await runTool('verify_export', run.context.exportPath ? { exportPath: run.context.exportPath } : {});
    if (wantsSearch) await runTool('search_knowledge', { query: run.instruction });
    if (results.length === 0) await runTool('search_knowledge', { query: run.instruction });
    if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
    const lines = ['Deterministic evidence-only answer (no hosted model was called).', `Instruction: ${run.instruction}`];
    for (const { name, result } of results) {
      if (name === 'analyze_telemetry' && result.ok !== false) lines.push(`Telemetry verdict: ${String(result.verdict)}; Overall Vibration RMS: ${String(result.overallVibrationRms)} mm/s; Peak Vibration: ${String(result.peakVibration)} mm/s; Peak Temperature: ${String(result.peakTemperature)} C; Warnings: ${String(result.warningCount)}; Critical: ${String(result.criticalCount)}; Rows analyzed: ${String(result.rowsAnalyzed)}; Source: ${String(result.source ?? '')}.`);
      else if (name === 'read_company_document' && result.ok !== false) lines.push(`Document ${String(result.path ?? '')}: ${truncate(String(result.content ?? ''), 800)}`);
      else if (name === 'verify_export') lines.push(`Audit verification: valid=${String(result.valid ?? result.available ?? 'unknown')}; ${truncate(String(result.message ?? JSON.stringify(result)), 500)}`);
      else if (name === 'search_knowledge') lines.push(`Knowledge search: ${truncate(String(result.message ?? JSON.stringify(result)), 500)}`);
      else lines.push(`${name}: ${truncate(JSON.stringify(result), 500)}`);
    }
    lines.push('No model prose was generated in evidence-only mode.');
    this.complete(run, lines.join('\n'));
  }

  private async executeHosted(run: InternalRun, apiKey?: string): Promise<void> {
    const provider: IProvider = this.providerFactory ? this.providerFactory() : new OpenAIProvider({ name: 'baseten', apiKey: apiKey || '', model: BASETEN_API_MODEL, baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true, fetch: this.fetchImpl });
    const telemetry = this.telemetrySummaryText(run.context.csvPath);
    run.conversation = [
      { role: 'system', content: 'You are the MAOS Industrial Ring agent. Use the provided tools for real evidence. Never invent engineering data. Never request or reveal raw telemetry CSV rows; only deterministic summaries are available. Consequential tools (draft_safety_note, request_approval) require human approval and will pause the run. When you have enough evidence, give a final answer citing the deterministic verdict and sources.' },
      { role: 'user', content: [`Instruction: ${run.instruction}`, '', 'Deterministic Engineering Context (summary only; raw telemetry rows are never provided):', telemetry.summary, '', 'Use tools when you need real evidence before answering.'].join('\n') },
    ];
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
      run.turns = turn;
      let response;
      try { response = await provider.generate(run.conversation, RING_AGENT_TOOLS, { signal: run.abortController.signal }); }
      catch (err) { if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; } throw err; }
      if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
      const toolCalls = response.toolCalls || [];
      this.record(run, { type: 'model.turn', turn, role: 'assistant', contentSummary: truncate(this.redact(String(response.content ?? '')), 500), toolCalls: toolCalls.map((tc) => tc.function.name), finishReason: response.finishReason });
      run.conversation.push({ role: 'assistant', content: response.content ?? null, tool_calls: toolCalls.length ? toolCalls : undefined });
      if (toolCalls.length === 0) {
        const answer = typeof response.content === 'string' ? response.content.trim() : '';
        if (!answer) throw new Error('RING_AGENT_EMPTY_RESPONSE: model returned no final answer and no tool call.');
        this.complete(run, answer);
        return;
      }
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try { args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}; if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}; }
        catch {
          const bad = { ok: false, result: { ok: false, error: 'Invalid tool arguments: expected a JSON object.' } as Record<string, unknown> };
          this.recordToolResult(run, toolCall.id, toolName, args, bad);
          run.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(bad.result) });
          continue;
        }
        if (CONSEQUENTIAL_TOOLS.has(toolName)) {
          const decision = await this.awaitApproval(run, toolCall.id, toolName, args);
          if (decision === 'cancelled' || run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
          if (decision === 'denied') {
            const denied: Record<string, unknown> = { ok: false, denied: true, toolName, message: `Approval denied for ${toolName}. The requested action was not performed.` };
            this.recordToolResult(run, toolCall.id, toolName, args, { ok: false, result: denied });
            this.complete(run, `Approval denied for ${toolName}: the requested action was not performed. No file was written and that branch was stopped rather than retried.`);
            return;
          }
        }
        const outcome = await this.executeToolLogged(run, toolCall.id, toolName, args);
        if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
        run.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: truncate(JSON.stringify(outcome.result), 6000) });
      }
    }
    throw new Error(`RING_AGENT_MAX_TURNS: agent exceeded the maximum of ${this.maxTurns} turns without a final answer.`);
  }

  private awaitApproval(run: InternalRun, toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<RingAgentApprovalDecision | 'cancelled'> {
    const approvalId = `approval-${crypto.randomBytes(4).toString('hex')}`;
    const summary = toolName === 'request_approval' ? truncate(String(args.summary ?? 'Approval requested'), 500) : toolName === 'draft_safety_note' ? truncate(`Draft safety note${args.title ? ` "${String(args.title)}"` : ''}${args.filename ? ` as ${String(args.filename)}` : ''} (${typeof args.content === 'string' ? args.content.length : 0} chars)`, 500) : `Execute consequential tool ${toolName}`;
    const reason = toolName === 'request_approval' ? truncate(String(args.reason ?? summary), 500) : 'Consequential action requires human approval before it is performed.';
    run.status = 'awaiting_approval';
    run.updatedAt = new Date().toISOString();
    return new Promise((resolve) => {
      run.pending = { approvalId, toolName, summary, reason, argsSummary: this.summarizeArgs(toolName, args), createdAt: new Date().toISOString(), toolCallId, args, resolver: resolve };
      this.record(run, { type: 'approval.pending', approvalId, toolName, summary, reason, argsSummary: this.summarizeArgs(toolName, args), status: 'awaiting_approval' });
    });
  }

  private summarizeArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (toolName) {
      case 'analyze_telemetry': return { csvPath: typeof args.csvPath === 'string' ? args.csvPath : undefined };
      case 'read_company_document': return { path: typeof args.path === 'string' ? args.path : undefined };
      case 'search_knowledge': return { query: typeof args.query === 'string' ? truncate(args.query, 200) : undefined, topK: typeof args.topK === 'number' ? args.topK : undefined };
      case 'draft_safety_note': return { title: typeof args.title === 'string' ? truncate(args.title, 200) : undefined, filename: typeof args.filename === 'string' ? args.filename : undefined, contentChars: typeof args.content === 'string' ? args.content.length : 0, contentPreview: typeof args.content === 'string' ? truncate(args.content, 200) : undefined };
      case 'verify_export': return { exportPath: typeof args.exportPath === 'string' ? args.exportPath : undefined };
      case 'request_approval': return { summary: typeof args.summary === 'string' ? truncate(args.summary, 300) : undefined, reason: typeof args.reason === 'string' ? truncate(args.reason, 300) : undefined };
      default: return { keys: Object.keys(args) };
    }
  }

  private recordToolResult(run: InternalRun, toolCallId: string, toolName: string, args: Record<string, unknown>, outcome: { ok: boolean; result: Record<string, unknown> }): void {
    run.toolResultProjections.set(toolCallId, this.projectToolResult(outcome.result));
    const resultSummary = this.summarizeToolResult(outcome.result, outcome.ok);
    this.record(run, { type: 'tool.result', toolCallId, toolName, argsSummary: this.summarizeArgs(toolName, args), ok: outcome.ok, summary: resultSummary ?? truncate(this.redact(JSON.stringify(outcome.result)), 1000), error: outcome.ok ? undefined : truncate(String(outcome.result.error ?? outcome.result.message ?? 'tool failed'), 500) });
  }

  private async executeToolLogged(run: InternalRun, toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    this.record(run, { type: 'tool.call', toolCallId, toolName, argsSummary: this.summarizeArgs(toolName, args) });
    let outcome: { ok: boolean; result: Record<string, unknown> };
    try { const result = await this.executeTool(run, toolName, args); outcome = { ok: result.ok !== false, result }; }
    catch (err) { const message = this.redact(err instanceof Error ? err.message : String(err)); outcome = { ok: false, result: { ok: false, toolName, error: truncate(message, 800) } }; }
    this.recordToolResult(run, toolCallId, toolName, args, outcome);
    return outcome;
  }

  private async executeTool(run: InternalRun, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'analyze_telemetry': return { ok: true, toolName, ...this.toolAnalyzeTelemetry(args, run) };
      case 'read_company_document': return { ok: true, toolName, ...this.toolReadCompanyDocument(run, args) };
      case 'search_knowledge': return { toolName, ...(await this.toolSearchKnowledge(args)) };
      case 'draft_safety_note': return { ok: true, toolName, ...this.toolDraftSafetyNote(run, args) };
      case 'verify_export': return { toolName, ...this.toolVerifyExport(args, run) };
      case 'request_approval': return { ok: true, toolName, approved: true, message: 'Human approval was granted for the proposed action.', summary: typeof args.summary === 'string' ? truncate(args.summary, 300) : undefined };
      default: return { ok: false, toolName, error: `Unknown tool: ${toolName}` };
    }
  }

  private toolAnalyzeTelemetry(args: Record<string, unknown>, run?: InternalRun): Record<string, unknown> {
    const requested = (typeof args.csvPath === 'string' && args.csvPath.trim()) || run?.context.csvPath || 'demo/industrial/turbine_vibration_log.csv';
    let resolved: string;
    if (path.isAbsolute(requested)) { resolved = path.resolve(requested); if (!isStrictlyWithin(this.projectRoot, resolved)) throw new Error(`PATH_OUTSIDE_PROJECT_ROOT: telemetry CSV path is outside the project root: ${requested}`); }
    else { resolved = path.resolve(this.projectRoot, requested); if (!isStrictlyWithin(this.projectRoot, resolved)) throw new Error(`PATH_OUTSIDE_PROJECT_ROOT: telemetry CSV path is outside the project root: ${requested}`); }
    if (!fs.existsSync(resolved)) throw new Error(`Telemetry CSV not found: ${requested}`);
    const thresholds = loadTelemetryDemoThresholds(this.projectRoot);
    const metrics = analyzeTelemetryCsv(fs.readFileSync(resolved), thresholds);
    return { verdict: metrics.verdict, overallVibrationRms: Number(metrics.overallVibrationRms.toFixed(3)), peakVibration: Number(metrics.peakVibration.toFixed(3)), peakTemperature: Number(metrics.peakTemperature.toFixed(1)), rowsAnalyzed: metrics.rowsAnalyzed, warningCount: metrics.warningCount, criticalCount: metrics.criticalCount, findings: metrics.findings.slice(0, 20).map((f) => ({ row: f.row, timestamp: f.timestamp, field: f.field, value: f.value, threshold: f.threshold, unit: f.unit, severity: f.severity })), source: path.relative(this.projectRoot, resolved).split(path.sep).join('/'), disclaimer: 'Deterministic summary only; raw telemetry rows were not sent to the model.' };
  }

  private toolReadCompanyDocument(run: InternalRun, args: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof args.path === 'string' ? args.path.trim() : '';
    if (!requested) throw new Error('read_company_document requires a non-empty path.');
    const evidenceRoot = run.evidenceRootAbs;
    const evidenceRelToProject = path.relative(this.projectRoot, evidenceRoot);
    let candidate: string;
    if (path.isAbsolute(requested)) candidate = path.resolve(requested);
    else if (evidenceRelToProject && (requested === evidenceRelToProject.split(path.sep).join('/') || requested.startsWith(`${evidenceRelToProject.split(path.sep).join('/')}/`))) candidate = path.resolve(this.projectRoot, requested);
    else candidate = path.resolve(evidenceRoot, requested);
    if (!isWithin(evidenceRoot, candidate) || candidate === evidenceRoot) throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
    if (!fs.existsSync(candidate)) throw new Error(`Company document not found under the evidence root: ${requested}`);
    const realRoot = fs.realpathSync(evidenceRoot);
    const realCandidate = fs.realpathSync(candidate);
    if (!isStrictlyWithin(realRoot, realCandidate)) throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
    const stat = fs.statSync(realCandidate);
    if (!stat.isFile()) throw new Error(`Company document is not a file: ${requested}`);
    if (stat.size > 256 * 1024) throw new Error(`Company document exceeds the 256 KB read limit: ${requested}`);
    const rel = path.relative(this.projectRoot, realCandidate).split(path.sep).join('/');
    if (path.extname(realCandidate).toLowerCase() === '.csv') {
      const bytes = fs.readFileSync(realCandidate);
      return { path: rel, bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), content: 'CSV content is not returned raw. Use analyze_telemetry for the deterministic telemetry summary.' };
    }
    const content = fs.readFileSync(realCandidate, 'utf-8');
    return { path: rel, bytes: stat.size, content: truncate(content, 6000), truncated: content.length > 6000 };
  }

  private async toolSearchKnowledge(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { ok: false, error: 'search_knowledge requires a non-empty query.' };
    if (!this.kbSearch || (!this.kbSearch.searchSync && !this.kbSearch.search)) {
      return { ok: true, available: false, answered: false, query: truncate(query, 200), results: [], message: 'Knowledge search is unavailable: no indexed company knowledge search is configured for this run. No results were fabricated.' };
    }
    try {
      let projectId = 'default';
      try { projectId = this.loadProjectConfig()?.projectName || 'default'; } catch { projectId = 'default'; }
      const input: Record<string, unknown> = { schemaVersion: 1, projectId, query, topK: typeof args.topK === 'number' ? Math.min(Math.max(1, Math.floor(args.topK)), 10) : 5 };
      const raw = this.kbSearch.searchSync ? this.kbSearch.searchSync(input) : await this.kbSearch.search!(input);
      const result = raw as Record<string, unknown>;
      if (result && result.answered === true && Array.isArray(result.citations)) {
        return { ok: true, available: true, answered: true, query: truncate(query, 200), totalMatches: result.totalMatches, results: (result.citations as Array<Record<string, unknown>>).slice(0, 5).map((c) => ({ documentId: c.documentId, sourcePath: c.sourcePath, score: c.score, snippet: typeof c.snippet === 'string' ? truncate(c.snippet, 300) : undefined })), message: 'Knowledge search returned indexed citations.' };
      }
      const reason = typeof result?.reason === 'string' ? result.reason : 'NO_ANSWER';
      const details = typeof result?.details === 'string' ? result.details : 'No indexed answer was returned.';
      return { ok: true, available: true, answered: false, query: truncate(query, 200), results: [], message: `Knowledge search returned no answer (${reason}): ${details} No results were fabricated.` };
    } catch (err) {
      return { ok: true, available: false, answered: false, query: truncate(query, 200), results: [], message: `Knowledge search is unavailable: ${err instanceof Error ? err.message : String(err)} No results were fabricated.` };
    }
  }

  private toolDraftSafetyNote(run: InternalRun, args: Record<string, unknown>): Record<string, unknown> {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) throw new Error('draft_safety_note requires non-empty content.');
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Safety Note';
    const rawName = typeof args.filename === 'string' && args.filename.trim() ? path.basename(args.filename.trim()) : 'safety-note.md';
    const safeBase = rawName.replace(/\.(md|txt)$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'safety-note';
    const draftsDir = path.join(this.projectRoot, '.maos', 'ring-runs', 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const filename = `${run.runId}-${safeBase}.md`;
    const filePath = path.join(draftsDir, filename);
    const body = `# ${title}\n\n${content.trim()}\n\n---\nDrafted by Ring agent run ${run.runId} after human approval.\n`;
    fs.writeFileSync(filePath, body, { flag: 'wx' });
    return { written: true, path: path.relative(this.projectRoot, filePath).split(path.sep).join('/'), bytes: Buffer.byteLength(body, 'utf-8'), sha256: crypto.createHash('sha256').update(body).digest('hex'), title };
  }

  private toolVerifyExport(args: Record<string, unknown>, run: InternalRun): Record<string, unknown> {
    const requested = (typeof args.exportPath === 'string' && args.exportPath.trim()) || run.context.exportPath || '';
    if (requested) {
      const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(this.projectRoot, requested);
      if (!isStrictlyWithin(this.projectRoot, resolved)) throw new Error(`PATH_OUTSIDE_PROJECT_ROOT: audit export path is outside the project root: ${requested}`);
      if (!fs.existsSync(resolved)) return { ok: true, valid: false, exportPath: requested, recordCount: 0, errors: [`Audit export file not found: ${requested}`], message: `Audit export verification failed: file not found (${requested}).` };
      if (!this.auditService) return { ok: true, available: false, valid: false, exportPath: requested, message: 'Audit verification unavailable: no audit service is configured for this run. No verification was fabricated.' };
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      const records = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.records;
      if (!Array.isArray(records)) return { ok: true, valid: false, exportPath: requested, recordCount: 0, errors: ['Audit export does not contain a records array.'], message: 'Audit export verification failed: no records array.' };
      const verification = this.auditService.verifyChainRecords(records as never);
      return { ok: true, valid: verification.valid, method: 'audit-service.verifyChainRecords', exportPath: path.relative(this.projectRoot, resolved).split(path.sep).join('/'), recordCount: verification.recordCount, latestHash: verification.latestHash, errors: verification.errors, message: verification.valid ? `Audit export verified (${verification.recordCount} records).` : `Audit export verification failed: ${verification.errors.join('; ')}` };
    }
    if (!this.auditService) return { ok: true, available: false, valid: false, message: 'Audit verification unavailable: no export path was provided and no audit service is configured. No verification was fabricated.' };
    const exported = this.auditService.exportAuditTrail();
    return { ok: true, valid: exported.verification.valid, method: 'audit-service.exportAuditTrail', recordCount: exported.verification.recordCount, latestHash: exported.verification.latestHash, errors: exported.verification.errors, message: exported.verification.valid ? `Live audit trail verified (${exported.verification.recordCount} records).` : `Live audit trail verification returned valid=${exported.verification.valid}: ${exported.verification.errors.join('; ')}` };
  }
}
