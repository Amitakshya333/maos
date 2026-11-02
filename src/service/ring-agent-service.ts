import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL, ProviderApiPolicyError } from '../backends/meta-api-policy';
import { RING_STREAM_EVENT_TYPES } from './ring-contract';
import type { RingRole } from './ring-contract';
import { RingToolRegistry } from './ring-tool-registry';
import { createRingToolRegistry } from './ring-tools';
import type { RingToolDeps } from './ring-tools';
import type { DocxGeneratorService } from './docx-generator-service';
import type { XlsxGeneratorService } from './xlsx-generator-service';
import type { MemoryService } from './memory-service';
import type { OcrService } from './ocr-service';
import type { VisionService } from './vision-service';
import { RingThreadService } from './ring-thread-service';
import { OpenAIProvider } from '../backends/openai-provider';
import type { ChatMessage, IProvider, ToolDef } from '../backends/provider';
import type { Project } from '../domain/schemas';
import type { AuditService } from './audit-service';
import type { EventService } from './event-service';
import { getRingRolePersona } from './ring-roles';
import { isRestartAuthorizationRequest, ringRestartRefusal } from './ring-safety';
import { listRingSkills } from './ring-skills';
import { runRingSkillWorkflow } from './ring-skill-workflows';
import { RingArtifactService } from './ring-artifact-store';
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
  threadId?: string;
  role?: string;
  /** TASK DEV-C-01: skill-run intent (server-side skill workflow). */
  skillName?: string;
  skillArg?: string;
  skillRole?: string;
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
  skills?: string[];
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
  eventService?: EventService;
  endpointAllowlist?: EndpointAllowlistService;
  loadProjectConfig?: () => Project | undefined;
  fetch?: typeof globalThis.fetch;
  providerFactory?: () => IProvider;
  kbSearch?: RingKbSearchLike;
  maxTurns?: number;
  evidenceRoot?: string;
  memoryService?: MemoryService;
  ocrService?: OcrService;
  visionService?: VisionService;
  docxGenerator?: DocxGeneratorService;
  xlsxGenerator?: XlsxGeneratorService;
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
  threadId?: string;
  role?: RingRole;
  /** TASK HYBRID-ROUTER-01: narrowed tool list offered to the model on bookkeeping-prefetch runs (remember/recall/update_plan already established server-side). */
  toolDefs?: ToolDef[];
  completion: Promise<RingAgentRunSnapshot>;
}

const DEFAULT_MAX_TURNS = 20;

/**
 * TASK HYBRID-ROUTER-01: hosted hybrid routing rule (exact patterns).
 *
 * Live reliability result: the model reliably calls evidence tools
 * (analyze_telemetry, read_company_document, search_knowledge, verify_export,
 * ocr_document) but never discovers bookkeeping tools (remember/recall/
 * update_plan). So in HOSTED mode the server pre-runs the deterministic
 * bookkeeping chain FIRST (same registry-direct code as the evidence-only
 * path) and hands the model established facts; the model writes prose and
 * proposes (never performs) the consequential step. Approval gate unchanged.
 *
 * - bookkeeping prefetch iff the instruction matches one of:
 *   recall:    /\brecall\b|\bwhat do you remember\b|\blook up\b.{0,20}\bnotes?\b|\bsearch\b.{0,20}\b(stored|my)\b.{0,20}\bnotes?\b/i
 *   remember:  /\bremember\b|\bnote that\b|\bdon'?t forget\b|\bkeep in mind\b|\bfile\b.{0,20}\bfor later\b/i
 *   plan:      /\bupdate[ _-]?plan\b|\bupdate the plan\b|\brefresh the plan\b|\bplan status\b|\bcurrent plan\b|\bshow\b.{0,20}\bplan\b|\bnext steps\b|\btodo\b|\bto-?do list\b/i
   (recall wins over remember so a recall ask never stores a duplicate.)
 * - evidence path (fully model-driven, tools + approval as today):
 *   everything else — telemetry/documents/search/verify/ocr AND handover /
 *   work-order / draft / report asks (consequential evidence tools the model
 *   demonstrably calls). Raw CSV rows never ride along on either path.
 * Evidence-only mode is untouched by this router.
 */
const HYBRID_RECALL_RE = /\brecall\b|\bwhat do you remember\b|\blook up\b.{0,20}\bnotes?\b|\bsearch\b.{0,20}\b(stored|my)\b.{0,20}\bnotes?\b/i;
const HYBRID_REMEMBER_RE = /\bremember\b|\bnote that\b|\bdon'?t forget\b|\bkeep in mind\b|\bfile\b.{0,20}\bfor later\b/i;
const HYBRID_PLAN_RE = /\bupdate[ _-]?plan\b|\bupdate the plan\b|\brefresh the plan\b|\bplan status\b|\bcurrent plan\b|\bshow\b.{0,20}\bplan\b|\bnext steps\b|\btodo\b|\bto-?do list\b/i;

/** Bookkeeping tools the server pre-runs; never offered to the model on prefetch runs. */
const HYBRID_PREFETCHED_TOOLS: readonly string[] = ['remember', 'recall', 'update_plan'];

export const RING_AGENT_TOOLS: ToolDef[] = buildRingAgentToolDefs();

/**
 * TASK DEV-A-01: provider tool list derived from the registry so the model
 * sees exactly the tools the loop can execute (Day 2 tools included).
 * Registration order in `src/service/ring-tools/index.ts` is stable with
 * the original six first. A throwaway registry (no service deps) supplies
 * the static name/description/parameters surface only.
 */
function buildRingAgentToolDefs(): ToolDef[] {
  const registry = createRingToolRegistry({});
  return registry.names().map((name) => {
    const def = registry.get(name);
    const surface = def as unknown as { description?: string; parameters?: Record<string, unknown> } | undefined;
    return { type: 'function', function: { name, description: typeof surface?.description === 'string' ? surface.description : name, parameters: surface?.parameters || { type: 'object', properties: {} } } };
  });
}

function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

export class RingAgentService {
  private readonly projectRoot: string;
  private readonly auditService?: AuditService;
  private readonly eventService?: EventService;
  private readonly loadProjectConfig: () => Project | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly providerFactory?: () => IProvider;
  private readonly kbSearch?: RingKbSearchLike;
  private readonly maxTurns: number;
  private readonly evidenceRootOption?: string;
  private readonly registry: RingToolRegistry;
  private readonly toolDeps: RingToolDeps;
  /** TASK DEV-C-01: skill-run approval intents (runId -> intent). Completed synchronously on approval; no dangling promises. */
  public readonly pendingSkillRuns = new Map<string, { approvalId: string; outcomeBody: string; skill: string; role: string; arg: string }>();
  private readonly runs = new Map<string, InternalRun>();
  private readonly listeners = new Set<(entry: RingAgentTranscriptEntry) => void>();

  constructor(options: RingAgentServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.auditService = options.auditService;
    this.eventService = options.eventService;
    this.fetchImpl = options.fetch;
    this.providerFactory = options.providerFactory;
    this.kbSearch = options.kbSearch;
    this.maxTurns = typeof options.maxTurns === 'number' && Number.isFinite(options.maxTurns) && options.maxTurns > 0 ? Math.floor(options.maxTurns) : DEFAULT_MAX_TURNS;
    this.evidenceRootOption = options.evidenceRoot;
    this.toolDeps = { auditService: options.auditService, kbSearch: options.kbSearch, ocrService: options.ocrService, visionService: options.visionService, docxGenerator: options.docxGenerator, xlsxGenerator: options.xlsxGenerator, memoryService: options.memoryService, getProjectId: () => this.safeProjectId() };
    this.registry = createRingToolRegistry(this.toolDeps);
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
    const threadLink = this.resolveThreadLink(context);
    const now = new Date().toISOString();
    let resolveCompletion!: (snapshot: RingAgentRunSnapshot) => void;
    const completion = new Promise<RingAgentRunSnapshot>((resolve) => { resolveCompletion = resolve; });
    const run: InternalRun = { runId, instruction: trimmed, context: context || {}, status: 'running', mode: 'evidence-only', createdAt: now, updatedAt: now, transcriptPath, transcriptRel: `.maos/ring-runs/${runId}.jsonl`, transcript: [], abortController: new AbortController(), cancelled: false, conversation: [], toolResultProjections: new Map(), turns: 0, evidenceRootAbs, threadId: threadLink?.threadId, role: threadLink?.role, completion };
    if (threadLink) {
      try { new RingThreadService(this.projectRoot).appendRun(threadLink.threadId, runId); } catch { /* run proceeds unlinked rather than failing */ }
    }
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
    const skillIntent = this.pendingSkillRuns.get(runId);
    if (skillIntent && run.pending && run.pending.toolName === skillIntent.skill) {
      const skillPending = run.pending;
      if (run.pending.approvalId !== approvalId) throw new RingAgentError('APPROVAL_NOT_FOUND', `Approval '${approvalId}' was not found for ring run '${runId}'.`);
      this.pendingSkillRuns.delete(runId);
      run.pending = undefined;
      this.record(run, { type: 'approval.resolved', approvalId, toolName: skillPending.toolName, decision });
      if (this.auditService) {
        try { this.auditService.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: 'RING_SKILL_APPROVAL_RESOLVED', runId, approvalId, toolName: skillPending.toolName, decision } }); } catch { /* audit must not break approval resolution */ }
      }
      if (decision === 'denied') {
        this.complete(run, `Approval denied for ${skillPending.toolName}: the requested action was not performed. No file was written.`);
        return this.snapshot(run);
      }
      try {
        const descriptor = new RingArtifactService(this.projectRoot).saveArtifact(runId, `${skillIntent.skill}-${(skillIntent.arg || 'asset').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'asset'}.md`, skillIntent.outcomeBody, 'markdown');
        this.record(run, { type: 'artifact.created', artifact: { path: descriptor.path, kind: descriptor.kind, size: descriptor.size, sha256: descriptor.sha256 } });
        try { this.auditService?.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: 'RING_SKILL_ARTIFACT_WRITTEN', runId, path: descriptor.path, sha256: descriptor.sha256 } }); } catch { /* best effort */ }
        this.complete(run, skillIntent.outcomeBody);
      } catch (err) {
        this.fail(run, err);
      }
      return this.snapshot(run);
    }
    if (!run.pending || run.status !== 'awaiting_approval') throw new RingAgentError('APPROVAL_NOT_PENDING', `Ring run '${runId}' has no pending approval.`);
    if (run.pending.approvalId !== approvalId) throw new RingAgentError('APPROVAL_NOT_FOUND', `Approval '${approvalId}' was not found for ring run '${runId}'.`);
    const pending = run.pending;
    run.pending = undefined;
    this.record(run, { type: 'approval.resolved', approvalId, toolName: pending.toolName, decision });
    if (this.auditService) {
      try { this.auditService.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: 'RING_APPROVAL_RESOLVED', runId, approvalId, toolName: pending.toolName, decision } }); } catch { /* audit must not break approval resolution */ }
    }
    try { (run.context as Record<string, unknown>).__lastApproval = { approvalId, decidedAt: new Date().toISOString(), decision, toolName: pending.toolName }; } catch { /* stashing must not break approval resolution */ }
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
    if (typeof result.text === 'string' && result.text) return truncate(result.text, 300);
    if (typeof result.path === 'string' && result.path) return result.path;
    if (typeof result.answered === 'boolean') return result.answered ? 'Knowledge search returned results.' : 'Knowledge search returned no answer.';
    if (typeof result.noteId === 'string' && result.noteId) return `Memory saved: ${result.noteId}`;
    if (typeof result.primaryPath === 'string' && result.primaryPath) return result.primaryPath;
    if (typeof result.steps === 'number') return `Plan updated: ${result.steps} step(s).`;
    if (Array.isArray(result.results)) return (result as { results: unknown[] }).results.length > 0 ? `Recalled ${(result as { results: unknown[] }).results.length} stored note(s).` : 'No stored notes matched.';
    if (Array.isArray(result.observations)) return (result as { observations: unknown[] }).observations.length > 0 ? `Vision inspection returned ${(result as { observations: unknown[] }).observations.length} observation(s).` : 'Vision inspection completed with no observations.';
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
      case 'skill.prefetch': {
        if (Array.isArray(entry.skills)) wire.skills = (entry.skills as unknown[]).filter((sk): sk is string => typeof sk === 'string');
        if (typeof entry.summary === 'string' && entry.summary) wire.message = entry.summary;
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

  /**
   * TASK DEV-A-01: thread linkage. When a run starts inside a thread, the
   * thread must exist (fail closed with RING_THREAD_NOT_FOUND), the run
   * inherits the thread role, and prior runs' instructions + final answers
   * are compacted into a bounded carry-over prefix so conversation continues
   * across runs. History comes from per-run JSONL transcripts on disk, so a
   * restarted service rebuilds it with no in-memory state.
   */
  private resolveThreadLink(context: RingAgentRunContext): { threadId: string; role?: RingRole } | undefined {
    const threadId = typeof context.threadId === 'string' && context.threadId ? context.threadId : undefined;
    if (!threadId) return undefined;
    const threads = new RingThreadService(this.projectRoot);
    const thread = threads.getThread(threadId);
    if (!thread) throw new RingAgentError('RING_THREAD_NOT_FOUND', 'Ring thread ' + threadId + ' was not found.');
    return { threadId: thread.threadId, role: thread.role };
  }

  private buildThreadCarryOver(threadId: string, maxChars = 4000): string {
    const threads = new RingThreadService(this.projectRoot);
    const thread = threads.getThread(threadId);
    if (!thread || thread.runs.length === 0) return '';
    const parts: string[] = [];
    for (const priorRunId of thread.runs.slice(-3)) {
      const history = this.getTranscript(priorRunId);
      if (history.length === 0) continue;
      const started = history.find((e) => e.type === 'run.started');
      const completed = [...history].reverse().find((e) => e.type === 'run.completed');
      const priorInstruction = typeof started?.instructionSummary === 'string' ? started.instructionSummary : '';
      const priorAnswer = typeof completed?.finalAnswerSummary === 'string' ? completed.finalAnswerSummary : '';
      if (priorInstruction || priorAnswer) parts.push('Prior run ' + priorRunId + ' instruction: ' + priorInstruction.slice(0, 500) + ' Final answer: ' + priorAnswer.slice(0, 1000));
    }
    const joined = parts.join('\n---\n');
    return joined.length > maxChars ? joined.slice(0, maxChars) + '...[trimmed]' : joined;
  }

  private resolveEvidenceRoot(context: RingAgentRunContext): string {
    const configured = context.evidenceRoot || this.evidenceRootOption || this.safeConfigEvidenceRoot() || 'demo/industrial';
    return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(this.projectRoot, configured);
  }

  private safeProjectId(): string {
    try { const name = this.loadProjectConfig()?.projectName; if (typeof name === 'string' && name.trim()) return name.trim(); } catch { /* fall through */ }
    return 'default';
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
    if (context.threadId) out.threadId = context.threadId;
    if (context.role) out.role = context.role;
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

  /**
   * TASK RING-DEV-B-01 (Day 1): fan the same mapped wire copy that backs the
   * onStreamEvent hook into the sequenced event bus (EventService) when one
   * is wired, so the existing WS /api/v1/events channel (runId-scoped,
   * sequenced + replay) delivers it. Payload shape is the wire event the UI
   * validator consumes; nothing raw (no CSV rows) is attached. Listener
   * exceptions never break the run; the JSONL transcript on disk is
   * untouched.
   */
  private emitStreamEvent(run: InternalRun, entry: RingAgentTranscriptEntry): void {
    let wire: RingAgentWireEvent | null = null;
    try { wire = this.toWireEvent(run, entry); } catch { return; }
    if (!wire) return;
    for (const l of this.streamListeners) { try { l(run.runId, wire); } catch {} }
    const bus = this.eventService;
    if (!bus) return;
    try {
      const projectId = this.safeProjectId();
      bus.recordEvent({
        eventType: 'ring.run.' + wire.type,
        projectId,
        runId: run.runId,
        correlationId: 'ring-' + run.runId + '-' + Date.now(),
        payload: wire,
      });
    } catch { /* event bus must not break the run */ }
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

  /**
   * TASK DEV-C-01: server-side skill execution. Runs the deterministic
   * workflow (evidence-first, no model call), records tool.result entries
   * for the transcript, and — for consequential skills — pauses for human
   * approval WITHOUT writing anything. The artifact is written only in
   * resolveApproval after a human approves. Restart/operation requests are
   * refused with no tools and no files.
   */
  private async executeSkillRun(run: InternalRun, skillName: string, arg: string, role: string): Promise<void> {
    try {
      const skill = listRingSkills().find((s) => s.name === skillName);
      if (!skill) { this.fail(run, new Error(`UNKNOWN_SKILL: no Ring skill named '${skillName}'.`)); return; }
      const resolvedRole = getRingRolePersona(role) ? role : 'operator';
      const refusal = isRestartAuthorizationRequest(arg) ? ringRestartRefusal('this asset', 'The request asks for restart/operation approval.') : undefined;
      if (refusal) {
        try { this.auditService?.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: 'RING_SKILL_REFUSED', skill: skillName, role: resolvedRole, runId: run.runId } }); } catch { /* best effort */ }
        this.complete(run, refusal);
        return;
      }
      let outcome: ReturnType<typeof runRingSkillWorkflow>;
      try {
        outcome = runRingSkillWorkflow({ skillName, arg, role: resolvedRole as never, projectRoot: this.projectRoot, runId: run.runId });
      } catch (err) {
        this.fail(run, err);
        return;
      }
      this.record(run, { type: 'tool.call', toolCallId: `skill-${skill.name}`, toolName: skill.name, argsSummary: { arg } });
      this.record(run, { type: 'tool.result', toolCallId: `skill-${skill.name}`, toolName: skill.name, ok: true, summary: outcome.body.slice(0, 1000) });
      try { this.auditService?.recordAuditEvent({ category: 'approval', source: 'ring-agent', data: { event: outcome.audit.event, skill: outcome.audit.skill, role: outcome.audit.role, runId: run.runId, evidencePaths: outcome.audit.evidencePaths, needsApproval: outcome.audit.needsApproval } }); } catch { /* best effort */ }
      if (!outcome.needsApproval) {
        this.complete(run, outcome.body);
        return;
      }
      const approvalId = `approval-${crypto.randomBytes(4).toString('hex')}`;
      run.status = 'awaiting_approval';
      run.updatedAt = new Date().toISOString();
      this.pendingSkillRuns.set(run.runId, { approvalId, outcomeBody: outcome.body, skill: skill.name, role: resolvedRole, arg });
      run.pending = { approvalId, toolName: skill.name, summary: `Save ${skill.name} artifact for ${(arg || '').trim() ? (arg || '').trim() : skill.name} (pending authorized review)`, reason: 'Consequential skill output requires human approval before it is written.', argsSummary: { skill: skill.name }, createdAt: new Date().toISOString(), toolCallId: `skill-${skill.name}`, args: { skill: skill.name, arg }, resolver: () => undefined as never };
      this.record(run, { type: 'approval.pending', approvalId, toolName: skill.name, summary: run.pending.summary, reason: run.pending.reason, argsSummary: run.pending.argsSummary, status: 'awaiting_approval' });
    } catch (err) {
      if ((run.status as string) === 'cancelled' || run.cancelled) this.ensureCancelled(run);
      else this.fail(run, err);
    } finally {
      if (run.status === 'running' || run.status === 'awaiting_approval') {
        if (run.cancelled) this.ensureCancelled(run);
        else if (run.status === 'running') this.fail(run, new Error('RING_AGENT_INCOMPLETE: agent loop ended without a final answer.'));
      }
    }
  }
  private async execute(run: InternalRun): Promise<void> {
    if (typeof run.context.skillName === 'string' && run.context.skillName) {
      await this.executeSkillRun(run, run.context.skillName, typeof run.context.skillArg === 'string' ? run.context.skillArg : '', typeof run.context.skillRole === 'string' ? run.context.skillRole : 'operator');
      return;
    }
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
      const def = this.registry.get('analyze_telemetry');
      if (!def) throw new Error('Telemetry tool is not registered.');
      const maybe = def.execute({ projectRoot: this.projectRoot, evidenceRoot: this.projectRoot, runId: 'telemetry-preview', runContext: {} }, typeof csvPath === 'string' && csvPath ? { csvPath } : {});
      if (maybe && typeof (maybe as Promise<unknown>).then === 'function') throw new Error('Telemetry preview must be synchronous.');
      const r = maybe as Record<string, unknown>;
      return { summary: [`verdict=${String(r.verdict)}`, `overallVibrationRms=${String(r.overallVibrationRms)} mm/s`, `peakVibration=${String(r.peakVibration)} mm/s`, `peakTemperature=${String(r.peakTemperature)} C`, `rowsAnalyzed=${String(r.rowsAnalyzed)}`, `warnings=${String(r.warningCount)} critical=${String(r.criticalCount)}`, `findings=${JSON.stringify(r.findings ?? [])}`, `source=${String(r.source ?? '')}`].join('; ') };
    } catch (err) {
      return { summary: `Telemetry summary unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * TASK DEV-A-01: refusal gate. The agent REFUSES to approve equipment
   * restart/operation or to certify safety — for any mode, no tools run and
   * no files are written; the refusal is the final answer. Human approval
   * via the gate covers the registry's consequential tools only and never
   * authorizes operating the plant or certifying it safe.
   */
  private refusalFor(instruction: string): string | undefined {
    const text = instruction.toLowerCase();
    const wantsRestartApproval = /(approv|authori[sz]e|permit|allow).{0,40}(restart|re-start|start-up|startup|shut-?down|trips+reset|resets+trip)/.test(text) || /(restart|re-start|start-up|startup).{0,40}(approv|authori[sz]e|permit|ok|okay|go-ahead|green light)/.test(text);
    const wantsOperation = /(operate|run|start)s+(thes+)?(equipment|turbine|pump|compressor|plant|machine|asset)/.test(text) && /(approv|authori[sz]e|permit|allow|ok|go-ahead)/.test(text);
    const wantsPumpRestart = /(p-12|pump).{0,60}(restart|re-start|start-up|startup|back in service|return to service)/.test(text) && /(approv|authori[sz]e|permit|allow|ok|okay|go-ahead|green light|give)/.test(text);
    const wantsCertification = /(certif|declare|confirm|verify).{0,40}(safe|safety|safe-to-operate|safe to operate|fit for|compliant)/.test(text) || /(safe|safety).{0,40}(certif|sign-?off)/.test(text);
    if (wantsRestartApproval || wantsOperation || wantsPumpRestart) return 'I cannot approve equipment restart or operation. Restarting or operating plant equipment requires an authorized human operator following site procedures; a Ring run approval covers evidence artifacts only and never authorizes operating the plant. No action was taken and no files were written.';
    if (wantsCertification) return 'I cannot certify safety or declare equipment safe to operate. Safety certification requires a qualified human authority following site procedures; Ring evidence summaries are decision support only. No action was taken and no files were written.';
    return undefined;
  }

  private async executeEvidenceOnly(run: InternalRun): Promise<void> {
    this.record(run, { type: 'mode.evidence-only', mode: 'evidence-only' });
    const refused = this.refusalFor(run.instruction);
    if (refused) { this.complete(run, refused); return; }
    const text = run.instruction.toLowerCase();
    const wantsPumpAsset = /p-12|\bpump\b/.test(text);
    if (wantsPumpAsset) {
      if (!run.context.csvPath) run.context.csvPath = 'demo/industrial/pump_p12_vibration_log.csv';
      if (!run.context.documentPath) run.context.documentPath = 'demo/industrial/maintenance_report_p12.txt';
    }
    const wantsTelemetry = /telemetry|vibration|turbine|pump|p-12|rms|\bcsv\b|bearing/.test(text) || Boolean(run.context.csvPath);
    const wantsVerify = /audit|verify|export|chain/.test(text);
    const wantsDocument = /document|\bsop\b|maintenance report|read/.test(text);
    const wantsSearch = /search|knowledge|find in|look up/.test(text);
    const wantsMemory = /\bremember\b|\brecall\b|\bmemory\b|note that|don't forget/.test(text);
    const wantsPlan = /\bplan\b|todo|to-do|next steps/.test(text);
    const wantsOcr = /\bocr\b|scan(s|ned)?\b|turbine_inspection_scan|inspection.{0,20}scan/.test(text);
    const wantsWorkOrder = /work[- ]order|raise.{0,20}order|workorder/.test(text);
    const results: Array<{ name: string; result: Record<string, unknown> }> = [];
    const runTool = async (name: string, args: Record<string, unknown>) => {
      const out = await this.executeToolLogged(run, 'evidence-' + (results.length + 1), name, args);
      results.push({ name, result: out.result });
    };
    const runConsequential = async (name: string, args: Record<string, unknown>) => {
      const decision = await this.awaitApproval(run, 'evidence-' + (results.length + 1), name, args);
      if (decision === 'cancelled' || run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return false; }
      if (decision === 'denied') {
        const denied: Record<string, unknown> = { ok: false, denied: true, toolName: name, message: 'Approval denied for ' + name + '. The requested action was not performed.' };
        this.recordToolResult(run, 'evidence-' + (results.length + 1), name, args, { ok: false, result: denied });
        results.push({ name, result: denied });
        return false;
      }
      const before = (run.context as Record<string, unknown>).__lastApproval;
      await runTool(name, args);
      return before !== (run.context as Record<string, unknown>).__lastApproval || true;
    };
    if (wantsTelemetry) await runTool('analyze_telemetry', run.context.csvPath ? { csvPath: run.context.csvPath } : {});
    if (wantsDocument) await runTool('read_company_document', { path: run.context.documentPath || 'sop_turbine_vibration_monitoring.md' });
    if (wantsVerify) await runTool('verify_export', run.context.exportPath ? { exportPath: run.context.exportPath } : {});
    if (wantsOcr) await runTool('ocr_document', { path: 'turbine_inspection_scan.pdf' });
    if (wantsMemory) {
      if (/\brecall\b/.test(text)) await runTool('recall', { query: run.instruction });
      else await runTool('remember', { content: run.instruction.slice(0, 2000), tags: ['evidence-only'] });
    }
    if (wantsPlan) await runTool('update_plan', { plan: [{ step: 'Review evidence-only findings', status: 'in_progress' }] });
    if (wantsWorkOrder) {
      const tel = (run.context as Record<string, unknown>).__telemetry as Record<string, unknown> | undefined;
      const finding = typeof tel?.verdict === 'string' ? 'Turbine vibration verdict: ' + String(tel.verdict) + ' (deterministic telemetry summary).' : run.instruction.slice(0, 500);
      const proceed = await runConsequential('create_work_order', { title: 'T-07 work order', assetId: 'T-07', finding, priority: tel?.verdict === 'CRITICAL' ? 'urgent' : 'routine', evidencePaths: typeof tel?.csvRel === 'string' ? [tel.csvRel] : [] });
      if (!proceed && ((run.status as string) === 'cancelled')) return;
    }
    if (wantsSearch) await runTool('search_knowledge', { query: run.instruction });
    if (results.length === 0) await runTool('search_knowledge', { query: run.instruction });
    if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
    const lines = ['Deterministic evidence-only answer (no hosted model was called).', `Instruction: ${run.instruction}`];
    for (const { name, result } of results) {
      if (name === 'analyze_telemetry' && result.ok !== false) lines.push(`Telemetry verdict: ${String(result.verdict)}; Overall Vibration RMS: ${String(result.overallVibrationRms)} mm/s; Peak Vibration: ${String(result.peakVibration)} mm/s; Peak Temperature: ${String(result.peakTemperature)} C; Warnings: ${String(result.warningCount)}; Critical: ${String(result.criticalCount)}; Rows analyzed: ${String(result.rowsAnalyzed)}; Source: ${String(result.source ?? '')}.`);
      else if (name === 'read_company_document' && result.ok !== false) lines.push(`Document ${String(result.path ?? '')}: ${truncate(String(result.content ?? ''), 800)}`);
      else if (name === 'verify_export') lines.push(`Audit verification: valid=${String(result.valid ?? result.available ?? 'unknown')}; ${truncate(String(result.message ?? JSON.stringify(result)), 500)}`);
      else if (name === 'search_knowledge') lines.push(`Knowledge search: ${truncate(String(result.message ?? JSON.stringify(result)), 500)}`);
      else if (name === 'ocr_document' && result.ok !== false) lines.push(`OCR: ${truncate(String((result as Record<string, unknown>).text ?? (result as Record<string, unknown>).message ?? JSON.stringify(result)), 500)}`);
      else if (name === 'remember') lines.push(`Memory: ${truncate(String((result as Record<string, unknown>).summary ?? (result as Record<string, unknown>).message ?? JSON.stringify(result)), 300)}`);
      else if (name === 'recall') lines.push(`Recall: ${truncate(String((result as Record<string, unknown>).message ?? JSON.stringify(result)), 500)}`);
      else if (name === 'update_plan') lines.push(`Plan: ${truncate(JSON.stringify((result as Record<string, unknown>).steps ?? result), 300)}`);
      else if (name === 'create_work_order') lines.push(`Work order: ${truncate(String((result as Record<string, unknown>).primaryPath ?? (result as Record<string, unknown>).message ?? (result as Record<string, unknown>).error ?? JSON.stringify(result)), 500)}`);
      else lines.push(`${name}: ${truncate(JSON.stringify(result), 500)}`);
    }
    lines.push('No model prose was generated in evidence-only mode.');
    this.complete(run, lines.join('\n'));
  }

  /**
   * TASK RING-DEV-A-DAY2: one streamed model turn. When the provider
   * exposes `generateStream()`, each non-empty content fragment is
   * recorded as a `model.delta` transcript entry (which fans out through
   * the existing `record()` → Dev B streaming drain and `toWireEvent`
   * projection — no evidence-only or drain change needed) and the
   * redacted whole-text `model.turn` is recorded once the stream closes,
   * exactly as the non-streaming path did. Evidence-only never calls this
   * (it never touches a provider), so no `model.delta` is ever fabricated
   * there. When the provider has no streaming shape, or the transport
   * yields zero chunks (`streamEmpty`), this falls back to `generate()`
   * ONCE per turn; the fallback response is the whole text and emits no
   * deltas. Deltas that arrive after cancellation are dropped.
   */
  private async generateHostedTurn(provider: IProvider, run: InternalRun): Promise<Awaited<ReturnType<IProvider['generate']>>> {
    const canStream = typeof (provider as { generateStream?: unknown }).generateStream === 'function';
    if (!canStream) {
      return provider.generate(run.conversation, run.toolDefs ?? RING_AGENT_TOOLS, { signal: run.abortController.signal });
    }
    const streamProvider = provider as Required<Pick<IProvider, 'generateStream'>> & IProvider;
    const streamed = await streamProvider.generateStream!(run.conversation, run.toolDefs ?? RING_AGENT_TOOLS, {
      signal: run.abortController.signal,
      onDelta: (delta: string) => {
        if (run.cancelled || (run.status as string) === 'cancelled') return;
        try { this.record(run, { type: 'model.delta', delta: this.redact(delta) }); } catch { /* streaming must not break the run */ }
      },
    });
    if (streamed.streamEmpty) {
      return provider.generate(run.conversation, run.toolDefs ?? RING_AGENT_TOOLS, { signal: run.abortController.signal });
    }
    return streamed;
  }

  /** TASK DEV-C-02: instruction-matched asset default (P-12 pump vs T-07 turbine). */
  private defaultAssetPaths(run: InternalRun): void {
    const text = run.instruction.toLowerCase();
    if (/p-12|\bpump\b/.test(text)) {
      if (!run.context.csvPath) run.context.csvPath = 'demo/industrial/pump_p12_vibration_log.csv';
      if (!run.context.documentPath) run.context.documentPath = 'demo/industrial/maintenance_report_p12.txt';
    }
  }

  /**
   * TASK HYBRID-ROUTER-01: hybrid prefetch classifier. Returns the
   * bookkeeping kinds the server must pre-run (recall wins over remember).
   * Empty array = evidence path (fully model-driven, unchanged).
   */
  private classifyHybridPrefetch(instruction: string): Array<'remember' | 'recall' | 'plan'> {
    const kinds: Array<'remember' | 'recall' | 'plan'> = [];
    if (HYBRID_RECALL_RE.test(instruction)) kinds.push('recall');
    else if (HYBRID_REMEMBER_RE.test(instruction)) kinds.push('remember');
    if (HYBRID_PLAN_RE.test(instruction)) kinds.push('plan');
    return kinds;
  }

  /**
   * TASK HYBRID-ROUTER-01: deterministic bookkeeping prefetch. Runs
   * remember/recall/update_plan through the registry DIRECTLY (same code as
   * the evidence-only path - executeToolLogged, so plan.updated/memory.saved
   * fan out and are stripped before any model sees them), then records one
   * honest server-side skill.prefetch marker. Returns short fact lines for
   * the model context. Bookkeeping tools are non-consequential, so this
   * never pauses for approval; cancellation is honored between steps.
   */
  private async runBookkeepingPrefetch(run: InternalRun, kinds: Array<'remember' | 'recall' | 'plan'>): Promise<string[]> {
    const facts: string[] = [];
    const done: string[] = [];
    let n = 0;
    for (const kind of kinds) {
      if (run.cancelled || (run.status as string) === 'cancelled') return facts;
      const toolCallId = 'hybrid-prefetch-' + (++n);
      if (kind === 'recall') {
        const outcome = await this.executeToolLogged(run, toolCallId, 'recall', { query: run.instruction.slice(0, 500) });
        done.push('recall');
        facts.push('recall: ' + (this.summarizeToolResult(outcome.result, outcome.ok) ?? 'done'));
      } else if (kind === 'remember') {
        const outcome = await this.executeToolLogged(run, toolCallId, 'remember', { content: run.instruction.slice(0, 2000), tags: ['hosted-prefetch'] });
        done.push('remember');
        facts.push('remember: ' + (this.summarizeToolResult(outcome.result, outcome.ok) ?? 'done'));
      } else {
        const step = 'Review: ' + truncate(run.instruction, 120);
        const outcome = await this.executeToolLogged(run, toolCallId, 'update_plan', { plan: [{ step, status: 'in_progress' }] });
        done.push('update_plan');
        facts.push('update_plan: ' + (this.summarizeToolResult(outcome.result, outcome.ok) ?? 'done'));
      }
    }
    this.record(run, { type: 'skill.prefetch', skills: done, mode: run.mode, summary: 'Server-side bookkeeping prefetch established ' + done.join(', ') + ' (see tool.result / plan.updated / memory.saved above). These facts are final: write prose and propose - do not re-perform - any consequential step.' });
    return facts;
  }

  private hostedNeedsTelemetry(run: InternalRun): boolean {
    const text = run.instruction.toLowerCase();
    return /telemetry|vibration|turbine|pump|p-12|rms|\bcsv\b|bearing/.test(text) || Boolean(run.context.csvPath);
  }

  private async executeHosted(run: InternalRun, apiKey?: string): Promise<void> {
    const provider: IProvider = this.providerFactory ? this.providerFactory() : new OpenAIProvider({ name: 'baseten', apiKey: apiKey || '', model: BASETEN_API_MODEL, baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true, fetch: this.fetchImpl });
    const refused = this.refusalFor(run.instruction);
    if (refused) { this.complete(run, refused); return; }
    this.defaultAssetPaths(run);
    // TASK HYBRID-ROUTER-01: deterministic bookkeeping prefetch FIRST (server-side,
    // same registry-direct code as the evidence-only path). The model then writes
    // prose over established facts and proposes - never performs - consequential steps.
    const prefetchKinds = this.classifyHybridPrefetch(run.instruction);
    const prefetchFacts = prefetchKinds.length > 0 ? await this.runBookkeepingPrefetch(run, prefetchKinds) : [];
    if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
    if (prefetchKinds.length > 0) {
      run.toolDefs = RING_AGENT_TOOLS.filter((t) => !HYBRID_PREFETCHED_TOOLS.includes(t.function.name));
    }
    const includeTelemetry = this.hostedNeedsTelemetry(run);
    const telemetry = includeTelemetry ? this.telemetrySummaryText(run.context.csvPath) : undefined;
    const carryOver = run.threadId ? this.buildThreadCarryOver(run.threadId) : '';
    run.conversation = [
      { role: 'system', content: 'You are the MAOS Industrial Ring agent. Use the provided tools for real evidence. Never invent engineering data. Never request or reveal raw telemetry CSV rows; only deterministic summaries are available. Consequential tools (generate_report_docx, generate_spreadsheet_xlsx, create_work_order, write_shift_handover, draft_safety_note, request_approval) require human approval and will pause the run; the human decision arrives as an approval resolution, never as model text. You must refuse requests to approve equipment restart/operation or to certify safety: those need an authorized human operator under site procedures, never a run approval. update_plan publishes the visible todo list; remember stores follow-up context. When you have enough evidence, give a final answer citing the deterministic verdict and sources.' },
      { role: 'user', content: ['Instruction: ' + run.instruction, carryOver ? 'Conversation so far in this thread (compacted summaries of prior runs):' : '', carryOver, includeTelemetry ? 'Deterministic Engineering Context (summary only; raw telemetry rows are never provided):' : '', includeTelemetry && telemetry ? telemetry.summary : '', prefetchFacts.length > 0 ? 'Established bookkeeping facts (server-executed skill.prefetch - FINAL, do NOT call remember/recall/update_plan to re-establish them):' : '', ...prefetchFacts, prefetchFacts.length > 0 ? 'Write the summary/plan/prose answer citing these established facts, then PROPOSE (not perform) any consequential step; consequential tools still pause for human approval and the human decision arrives as an approval resolution, never as model text.' : 'Use tools when you need real evidence before answering.'].filter((line) => line !== '').join('\n') },
    ];
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      if (run.cancelled || (run.status as string) === 'cancelled') { this.ensureCancelled(run); return; }
      run.turns = turn;
      let response;
      try { response = await this.generateHostedTurn(provider, run); }
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
        if (this.registry.isConsequential(toolName)) {
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
    const summary = toolName === 'request_approval' ? truncate(String(args.summary ?? 'Approval requested'), 500) : toolName === 'draft_safety_note' ? truncate(`Draft safety note${args.title ? ` "${String(args.title)}"` : ''}${args.filename ? ` as ${String(args.filename)}` : ''} (${typeof args.content === 'string' ? args.content.length : 0} chars)`, 500) : truncate(`Execute consequential tool ${toolName}${typeof args.title === 'string' && args.title.trim() ? ` "${args.title.trim().slice(0, 120)}"` : ''}`, 500);
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
      case 'update_plan': return Array.isArray(args.plan) ? { steps: (args.plan as unknown[]).length } : { steps: 0 };
      case 'remember': return { contentPreview: typeof args.content === 'string' ? truncate(args.content, 200) : undefined, type: typeof args.type === 'string' ? args.type : undefined };
      case 'recall': return { query: typeof args.query === 'string' ? truncate(args.query, 200) : undefined };
      case 'ocr_document': case 'inspect_image': return { path: typeof args.path === 'string' ? args.path : undefined };
      case 'generate_report_docx': case 'generate_spreadsheet_xlsx': return { title: typeof args.title === 'string' ? truncate(args.title, 200) : undefined };
      case 'create_work_order': return { assetId: typeof args.assetId === 'string' ? args.assetId : undefined, finding: typeof args.finding === 'string' ? truncate(args.finding, 200) : undefined, priority: typeof args.priority === 'string' ? args.priority : undefined };
      case 'write_shift_handover': return { title: typeof args.title === 'string' ? truncate(args.title, 200) : undefined };
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
    outcome = this.drainRingEvents(run, outcome);
    if (toolName === 'analyze_telemetry' && outcome.ok) this.stashTelemetryRef(run, outcome.result);
    this.recordToolResult(run, toolCallId, toolName, args, outcome);
    return outcome;
  }

  /**
   * TASK DEV-A-01: envelope drain. Tools return `__ringEvents` carrying
   * `plan.updated` / `artifact.created` / `memory.saved` payloads; each is
   * recorded as its own transcript entry (which fans out to the Dev B
   * streaming hook via `record()`) and STRIPPED before the model sees the
   * result. The JSONL keeps the tool.result; the envelope never ships.
   */
  private drainRingEvents(run: InternalRun, outcome: { ok: boolean; result: Record<string, unknown> }): { ok: boolean; result: Record<string, unknown> } {
    const envelope = (outcome.result as Record<string, unknown>).__ringEvents;
    if (!Array.isArray(envelope) || envelope.length === 0) return outcome;
    const clean: Record<string, unknown> = { ...outcome.result };
    delete clean.__ringEvents;
    for (const entry of envelope) {
      if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).type !== 'string') continue;
      try { this.record(run, entry as Omit<RingAgentTranscriptEntry, 'ts' | 'runId'> & { type: string }); } catch { /* event recording must not break the run */ }
    }
    return { ok: outcome.ok, result: clean };
  }

  /** Cache the deterministic telemetry summary for office-tool citations. */
  private stashTelemetryRef(run: InternalRun, result: Record<string, unknown>): void {
    try {
      (run.context as Record<string, unknown>).__telemetry = { verdict: result.verdict, overallVibrationRms: result.overallVibrationRms, rowsAnalyzed: result.rowsAnalyzed, csvRel: typeof result.source === 'string' ? result.source : undefined };
    } catch { /* stashing must not break the run */ }
  }

  /**
   * TASK DEV-A-01 (Day 1a): registry dispatch. All tools — the 6 migrated
   * verbatim plus the Day 2 wrappers — execute through the frozen registry
   * interface; the loop never calls a private tool method directly.
   * `runContext` carries the run's configured defaults plus stashed
   * telemetry/approval refs the office tools require. Unknown tools fail
   * closed via the registry (ok:false), matching the old default branch.
   */
  private async executeTool(run: InternalRun, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ctx = { projectRoot: this.projectRoot, evidenceRoot: run.evidenceRootAbs, runId: run.runId, runContext: run.context as Record<string, unknown> };
    const result = await this.registry.execute(toolName, ctx, args || {});
    if (typeof result.toolName !== 'string') result.toolName = toolName;
    return result;
  }

}
