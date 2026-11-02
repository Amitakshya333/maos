/**
 * TASK RING-UI-01: Ring agent workspace (replaces the one-shot RingAskPanel).
 *
 * Ring is a roster of agents you watch work, not a Q&A form:
 * - left roster lists the company's agents (from the project config) plus
 *   Ring as the lead; selecting one scopes run instructions to that agent,
 * - the main transcript renders a run live as it is polled: user message,
 *   tool-call activity chips with expandable result summaries, model turns,
 *   inline Allow/Deny approval cards, and the final answer,
 * - mode honesty is preserved verbatim from RING-IMPL-01 (badge + banners),
 * - the CompletionRefusalDemo behaviour stays reachable via a
 *   TelemetryReviewCoordinator.prepareReview claim (same gate as Cockpit).
 *
 * The existing app already has a WebSocket event stream, but it is a
 * project-scoped sequenced channel (BrowserEventClient), not a per-run
 * stream; run progress therefore polls GET /api/v1/ring/runs/:id, which is
 * the contract RING-AGENT-LOOP-01 builds against. No fake streaming: in
 * evidence-only mode there are no model turns to fake, and events render
 * exactly as polled.
 *
 * Interaction shape inspired by OpenMausBot (Apache-2.0); no code copied.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiAdapter } from '../api';
import type { JudgedRunResponse } from '../api/rest-client';
import type { RingAskResult } from '../api/ring-types';
import type {
  RingApprovalDecision,
  RingRunEvent,
  RingRunRequest,
  RingRunState,
} from '../api/ring-run-types';
import { CompletionRefusalDemo } from './CompletionRefusalDemo';
import { TelemetryReviewCoordinator } from './telemetryReviewCoordinator';

/** Exact hosted badge copy (RING-IMPL-01 step 2). Served suffix only from server echo. */
export const RING_HOSTED_BADGE = 'HOSTED · meta-models/muse-spark-open-1026 via Baseten';
/** Exact evidence-only badge copy (RING-IMPL-01 step 2). */
export const RING_EVIDENCE_ONLY_BADGE = 'EVIDENCE-ONLY · no model configured';
/** Exact hosted banner copy (RING-IMPL-01 step 3). */
export const RING_HOSTED_BANNER = 'Meta model reasoning via Baseten. Company evidence stays in MAOS.';
/** Exact telemetry-boundary line (RING-IMPL-01 step 3). */
export const RING_TELEMETRY_BOUNDARY = 'raw telemetry never leaves MAOS; only the summary is sent';
/** Verify fallback copy (RING-IMPL-01 step 6). */
export const RING_NO_EXPORT_VERIFIED = 'No export verified yet.';
/** Evidence-only banner: states plainly that no model wrote the answer. */
export const RING_EVIDENCE_ONLY_BANNER =
  'Ring is running in evidence-only mode: no model is configured, so no model wrote this answer and no model ran. Local evidence, verification, and review tools remain available.';

/**
 * Assistant attribution for Ring (O-2). USER rendering is unchanged;
 * assistant messages attribute to RING.
 */
export function ringRoleLabel(role: string): string {
  return role === 'assistant' ? 'RING' : role;
}

/**
 * Model identity line for the badge (RING-IMPL-01 step 2). A legacy
 * RingAskResult, when present, determines the text; otherwise the caller
 * keeps its existing local badge. The served-model suffix appears only
 * when the server echoed an id.
 */
export function ringBadgeText(ringResult: RingAskResult | null, localFallback: string): string {
  if (!ringResult) return localFallback;
  if (ringResult.mode === 'evidence-only') return RING_EVIDENCE_ONLY_BADGE;
  const served = ringResult.servedModelId?.trim();
  return served ? `${RING_HOSTED_BADGE} · reported ${served}` : RING_HOSTED_BADGE;
}

/**
 * Badge for the run workspace. The run payload carries no served-model
 * identity, so a run badge never shows a `· reported <id>` suffix; the
 * exact mode copy is preserved.
 */
export function ringRunBadgeText(state: RingRunState | null, localFallback: string): string {
  if (!state) return localFallback;
  return state.mode === 'evidence-only' ? RING_EVIDENCE_ONLY_BADGE : RING_HOSTED_BADGE;
}

export const RingEvidenceOnlyBanner: React.FC = () => (
  <div
    data-testid="ring-evidence-only-banner"
    role="note"
    style={{
      padding: '8px 14px',
      backgroundColor: 'var(--bg-tertiary, #222222)',
      borderLeft: '4px solid var(--status-amber, #eab308)',
      borderRadius: '4px',
      marginBottom: '12px',
      fontSize: '12px',
      color: 'var(--text-secondary, #cccccc)',
    }}
  >
    {RING_EVIDENCE_ONLY_BANNER}
  </div>
);

// ── Roster ────────────────────────────────────────────────────

export interface RingAgentConfigEntry {
  id: string;
  role: string;
}

export interface RingRosterAgent {
  id: string;
  name: string;
  role: string;
  isLead: boolean;
}

/** Ring itself: the lead you talk to; runs may be scoped to a roster agent. */
export const RING_LEAD_AGENT: RingRosterAgent = {
  id: 'RING',
  name: 'Ring',
  role: 'lead',
  isLead: true,
};

/**
 * Builds the roster from project-config agents only (never invented), with
 * Ring as the lead first. Agents with duplicate or blank ids are skipped.
 */
export function buildRingRoster(configAgents: readonly RingAgentConfigEntry[]): RingRosterAgent[] {
  const seen = new Set<string>([RING_LEAD_AGENT.id]);
  const roster: RingRosterAgent[] = [RING_LEAD_AGENT];
  for (const agent of configAgents) {
    const id = agent.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    roster.push({ id, name: id, role: agent.role || 'agent', isLead: false });
  }
  return roster;
}

export type RingAgentPresence = 'idle' | 'working' | 'waiting';

const PRESENCE_COLOR: Record<RingAgentPresence, string> = {
  idle: 'var(--text-dim, #888888)',
  working: 'var(--status-green, #4ade80)',
  waiting: 'var(--status-amber, #eab308)',
};

export const RingAgentRoster: React.FC<{
  agents: readonly RingRosterAgent[];
  selectedAgentId: string;
  presence: Readonly<Record<string, RingAgentPresence>>;
  onSelect: (agentId: string) => void;
}> = ({ agents, selectedAgentId, presence, onSelect }) => (
  <nav
    aria-label="Ring agents"
    data-testid="ring-agent-roster"
    style={{
      width: '220px',
      flexShrink: 0,
      backgroundColor: 'var(--bg-secondary, #1a1a1a)',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #333333)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}
  >
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color, #333333)', fontWeight: 600, fontSize: '13px' }}>
      Agents
    </div>
    <div style={{ overflowY: 'auto', padding: '6px' }}>
      {agents.map((agent) => {
        const status = presence[agent.id] ?? 'idle';
        const selected = agent.id === selectedAgentId;
        return (
          <button
            key={agent.id}
            type="button"
            data-testid={`ring-agent-${agent.id}`}
            aria-pressed={selected}
            onClick={() => onSelect(agent.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '4px',
              backgroundColor: selected ? 'var(--accent-dim, rgba(59, 130, 246, 0.2))' : 'transparent',
              border: selected ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
              color: 'inherit',
            }}
          >
            <span
              data-testid="ring-agent-status-dot"
              data-status={status}
              aria-hidden="true"
              style={{
                width: '9px',
                height: '9px',
                borderRadius: '50%',
                flexShrink: 0,
                backgroundColor: PRESENCE_COLOR[status],
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.name}
                {agent.isLead ? ' · lead' : ''}
              </span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-dim, #888888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.role} · {status}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  </nav>
);

// ── Transcript pieces ─────────────────────────────────────────

export const RingUserMessage: React.FC<{ text: string; agentId: string }> = ({ text, agentId }) => (
  <div data-testid="ring-user-message" style={{ alignSelf: 'flex-end', maxWidth: '80%' }}>
    <div style={{ fontSize: '11px', color: 'var(--text-dim, #888888)', marginBottom: '4px', textAlign: 'right' }}>
      YOU → {agentId}
    </div>
    <div
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        backgroundColor: 'var(--accent-dim, rgba(59, 130, 246, 0.15))',
        border: '1px solid var(--accent, #3b82f6)',
        fontSize: '13px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  </div>
);

export const RingModelTurn: React.FC<{ text: string }> = ({ text }) => (
  <div data-testid="ring-model-turn" style={{ alignSelf: 'flex-start', maxWidth: '80%' }}>
    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--status-green, #4ade80)', marginBottom: '4px' }}>RING</div>
    <div
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        backgroundColor: 'var(--bg-tertiary, #262626)',
        border: '1px solid var(--border-color, #3a3a3a)',
        fontSize: '13px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  </div>
);

/**
 * One tool call paired with its result (when polled). Rendered as an
 * activity chip; the result summary expands without inventing fields —
 * only values the event actually carried are shown.
 */
export const RingToolChip: React.FC<{ call: RingRunEvent; result?: RingRunEvent }> = ({ call, result }) => {
  const [expanded, setExpanded] = useState(false);
  const label = `${call.tool ?? 'tool'}${call.argsSummary ? ` · ${call.argsSummary}` : ''}`;
  const hasResult = Boolean(result);
  return (
    <div data-testid="ring-tool-chip" style={{ alignSelf: 'flex-start', maxWidth: '90%' }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Tool activity: ${label}`}
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '12px',
          border: '1px solid var(--border-color, #444444)',
          backgroundColor: 'var(--bg-tertiary, #262626)',
          color: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden="true">{hasResult ? '✓' : '…'}</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div data-testid="ring-tool-result" style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-secondary, #cccccc)' }}>
          {!result && <div>Running…</div>}
          {result?.resultSummary && <div>{result.resultSummary}</div>}
          {result?.verdict && <div>Verdict: {result.verdict}</div>}
          {typeof result?.overallRms === 'number' && <div>RMS: {result.overallRms}</div>}
          {result?.sources && result.sources.length > 0 && (
            <div>
              Sources:{' '}
              {result.sources.map((source, index) => (
                <span key={`${source}-${index}`}>
                  {index > 0 ? ', ' : ''}
                  <code>{source}</code>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Inline approval card. Unmissable (amber, labelled region) and keyboard
 * accessible (real buttons). While a decision post is in flight both
 * buttons disable; a post error is shown verbatim and retry stays possible.
 */
export const RingApprovalCard: React.FC<{
  event: RingRunEvent;
  busy: boolean;
  error: string | null;
  onDecide: (approvalId: string, decision: RingApprovalDecision) => void;
}> = ({ event, busy, error, onDecide }) => {
  const approvalId = event.approvalId ?? '';
  return (
    <div
      role="group"
      aria-label="Approval required"
      data-testid="ring-approval-card"
      style={{
        alignSelf: 'stretch',
        border: '2px solid var(--status-amber, #eab308)',
        backgroundColor: 'rgba(234, 179, 8, 0.12)',
        borderRadius: '8px',
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--status-amber, #eab308)', marginBottom: '6px' }}>
        APPROVAL REQUIRED
      </div>
      <div data-testid="ring-approval-action" style={{ fontSize: '13px', fontWeight: 600 }}>
        {event.action}
      </div>
      {event.reason && (
        <div data-testid="ring-approval-reason" style={{ fontSize: '12px', color: 'var(--text-secondary, #cccccc)', marginTop: '4px' }}>
          Why: {event.reason}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <button
          type="button"
          className="btn-primary"
          data-testid="ring-approval-allow"
          disabled={busy || !approvalId}
          onClick={() => onDecide(approvalId, 'approved')}
          style={{ padding: '8px 16px', fontSize: '13px' }}
        >
          Allow
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-testid="ring-approval-deny"
          disabled={busy || !approvalId}
          onClick={() => onDecide(approvalId, 'denied')}
          style={{ padding: '8px 16px', fontSize: '13px' }}
        >
          Deny
        </button>
      </div>
      {error && (
        <div role="alert" style={{ marginTop: '8px', color: '#ff7b72', fontSize: '12px' }}>
          {error}
        </div>
      )}
    </div>
  );
};

export const RingApprovalResolved: React.FC<{ event: RingRunEvent }> = ({ event }) => (
  <div
    data-testid="ring-approval-resolved"
    style={{
      alignSelf: 'flex-start',
      fontSize: '12px',
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #444444)',
      color: 'var(--text-secondary, #cccccc)',
    }}
  >
    {event.decision === 'approved' ? '✓ Approved' : '✕ Denied'}
    {event.action ? ` · ${event.action}` : ''}
  </div>
);

export const RingFinalAnswer: React.FC<{ answer: string; mode: RingRunState['mode'] }> = ({ answer, mode }) => (
  <div data-testid="ring-final-answer" style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--status-green, #4ade80)', marginBottom: '4px' }}>RING · FINAL</div>
    {mode === 'evidence-only' && (
      <div data-testid="ring-no-model-note" style={{ fontSize: '11px', color: '#e3b341', marginBottom: '6px' }}>
        No model wrote this answer and no model ran — evidence-only response shown as-is.
      </div>
    )}
    <div
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        backgroundColor: 'var(--bg-tertiary, #262626)',
        border: '1px solid var(--status-green, #4ade80)',
        fontSize: '13px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {answer}
    </div>
  </div>
);

// ── Run client (injectable for tests) ─────────────────────────

export interface RingThreadSummary {
  threadId: string;
  title: string;
  role: string;
  createdAt: string;
  runs: string[];
}

export interface RingRunClient {
  startRun: (input: RingRunRequest) => Promise<{ runId: string }>;
  getRun: (runId: string) => Promise<RingRunState>;
  cancelRun: (runId: string) => Promise<void>;
  decideApproval: (runId: string, approvalId: string, decision: RingApprovalDecision) => Promise<void>;
  /** TASK DEV-A-01: thread methods. Optional so existing injected mocks keep compiling. */
  createThread?: (input: { title?: string }) => Promise<{ threadId: string }>;
  getThread?: (threadId: string) => Promise<RingThreadSummary>;
  postThreadMessage?: (threadId: string, instruction: string) => Promise<{ runId: string }>;
}

export const defaultRingRunClient: RingRunClient = {
  startRun: (input) => apiAdapter.startRingRun(input),
  getRun: (runId) => apiAdapter.getRingRun(runId),
  cancelRun: (runId) => apiAdapter.cancelRingRun(runId),
  decideApproval: (runId, approvalId, decision) => apiAdapter.decideRingApproval(runId, approvalId, decision),
  createThread: (input) => apiAdapter.createRingThread(input),
  getThread: (threadId) => apiAdapter.getRingThread(threadId),
  postThreadMessage: (threadId, instruction) => apiAdapter.postRingThreadMessage(threadId, instruction),
};

export interface RingVerifyTranscript {
  runId?: string | null;
  auditOutput?: string | null;
  exportPath?: string | null;
  exportPassLine?: string | null;
}

/**
 * Judge verify card. Renders CLI/transcript text only from provided real
 * output. With no export evidence it shows the fallback; it never invents
 * output or a PASS line.
 */
export const RingVerifyCard: React.FC<{ transcript: RingVerifyTranscript }> = ({ transcript }) => {
  const hasAudit = Boolean(transcript.runId && transcript.auditOutput);
  const hasExport = Boolean(transcript.exportPath && transcript.exportPassLine);
  if (!hasAudit && !hasExport) {
    return (
      <div data-testid="ring-verify-card" style={{ marginTop: 10, fontSize: 11, color: '#8b949e' }}>
        {RING_NO_EXPORT_VERIFIED}
      </div>
    );
  }
  return (
    <div data-testid="ring-verify-card" style={{ marginTop: 10, fontSize: 11 }}>
      {hasAudit && (
        <div style={{ marginBottom: 6 }}>
          <code style={{ display: 'block', color: '#79c0ff', wordBreak: 'break-all' }}>
            maos-industrial verify audit --run-id {transcript.runId} --json
          </code>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#c9d1d9', margin: '4px 0 0' }}>{transcript.auditOutput}</pre>
        </div>
      )}
      {hasExport && (
        <div>
          <code style={{ display: 'block', color: '#79c0ff', wordBreak: 'break-all' }}>
            verify export {transcript.exportPath}
          </code>
          <div style={{ color: '#3fb950', marginTop: 4 }}>{transcript.exportPassLine}</div>
        </div>
      )}
    </div>
  );
};

const SUGGESTED_INSTRUCTIONS: readonly string[] = [
  'Why is turbine 7 above its vibration limit, and what do we do next?',
  'Draft a safety note for the turbine 7 vibration exceedance.',
  'Verify the last export and show the audit evidence.',
];

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Approval ids already resolved in the transcript (approval.resolved wins). */
function resolvedApprovalIds(events: readonly RingRunEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type === 'approval.resolved' && event.approvalId) resolved.add(event.approvalId);
  }
  return resolved;
}

/** First approval id that is pending and not yet resolved, if any. */
function pendingApprovalId(events: readonly RingRunEvent[]): string | null {
  const resolved = resolvedApprovalIds(events);
  for (const event of events) {
    if (event.type === 'approval.pending' && event.approvalId && !resolved.has(event.approvalId)) {
      return event.approvalId;
    }
  }
  return null;
}

/** Latest deterministic analysis id a tool result reported, if any. */
function latestAnalysisId(events: readonly RingRunEvent[]): string | null {
  let found: string | null = null;
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    if (typeof event.resultSummary === 'string') {
      const match = event.resultSummary.match(/analysis (telemetry-[A-Za-z0-9-]+)/);
      if (match) found = match[1];
    }
  }
  return found;
}

export interface RingWorkspaceProps {
  agents?: readonly RingRosterAgent[];
  loadAgents?: () => Promise<readonly RingRosterAgent[]>;
  runClient?: RingRunClient;
  pollIntervalMs?: number;
  verifyTranscript?: RingVerifyTranscript;
  prepareReview?: (analysisId: string) => Promise<JudgedRunResponse>;
  onOpenCockpit?: () => void;
  /** Kept for ChatView's legacy badge state; runs report mode via onRunState. */
  onResult?: (result: RingAskResult | null) => void;
  onRunState?: (state: RingRunState | null) => void;
}

interface TranscriptRun {
  runId: string;
  instruction: string;
  agentId: string;
  /** Null until the first GET resolves (A7): no mode badge is claimed yet. */
  state: RingRunState | null;
}

const TERMINAL_STATUSES: readonly RingRunState['status'][] = ['completed', 'failed', 'cancelled'];

export const RingWorkspace: React.FC<RingWorkspaceProps> = ({
  agents: agentsProp,
  loadAgents,
  runClient,
  pollIntervalMs = 1000,
  verifyTranscript,
  prepareReview,
  onOpenCockpit,
  onRunState,
}) => {
  const clientRef = useRef<RingRunClient>(runClient ?? defaultRingRunClient);
  if (runClient) clientRef.current = runClient;

  const [agents, setAgents] = useState<readonly RingRosterAgent[]>(agentsProp ?? [RING_LEAD_AGENT]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(RING_LEAD_AGENT.id);
  const [instruction, setInstruction] = useState('');
  const [runs, setRuns] = useState<TranscriptRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // TASK DEV-A-01: threads. Null = unthreaded (legacy single-run view).
  // Threads only activate when the client exposes thread methods.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<RingThreadSummary | null>(null);
  const [threadStarting, setThreadStarting] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const startedAtRef = useRef<number | null>(null);
  const runCounterRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Refusal beat (RING-IMPL-01 behaviour, still reachable): the workspace
  // owns a TelemetryReviewCoordinator exactly like the panel it replaces.
  const [reviewRun, setReviewRun] = useState<JudgedRunResponse | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const coordinatorRef = useRef<TelemetryReviewCoordinator | null>(null);
  if (!coordinatorRef.current && !prepareReview) {
    coordinatorRef.current = new TelemetryReviewCoordinator(
      {
        analyzeTelemetry: (input, options) => apiAdapter.analyzeIndustrialTelemetry(input, options),
        analyzeCsv: (input, options) => apiAdapter.analyzeIndustrialCsv(input, options),
        prepareReview: (analysisId) => apiAdapter.prepareIndustrialAgentReview(analysisId),
        getJudgedRun: (runId) => apiAdapter.getIndustrialJudgedRun(runId),
      },
      {
        apply: (patch) => {
          if (patch.reviewRun !== undefined) setReviewRun(patch.reviewRun);
          if (patch.reviewError !== undefined) setReviewError(patch.reviewError);
          if (patch.reviewBusy !== undefined) setReviewBusy(patch.reviewBusy);
        },
        readSavedRunId: () =>
          typeof window === 'undefined' ? null : window.localStorage.getItem('maos:last-industrial-judged-run'),
        writeSavedRunId: (runId) => {
          if (typeof window !== 'undefined') window.localStorage.setItem('maos:last-industrial-judged-run', runId);
        },
        navigateToApprovals: () => {
          if (typeof window !== 'undefined') window.location.hash = '#/approvals';
        },
      },
    );
  }
  useEffect(() => {
    return () => {
      coordinatorRef.current?.dispose();
    };
  }, []);

  // Roster loading: injected agents win; otherwise ask the loader, then the
  // project config via the adapter. Failures keep Ring only and say so
  // through the start error channel only when a run is attempted — loading
  // itself never fabricates agents.
  useEffect(() => {
    if (agentsProp) {
      setAgents(agentsProp);
      return;
    }
    let cancelled = false;
    const loader =
      loadAgents ??
      (async () => {
        const project = await apiAdapter.getProject();
        return buildRingRoster(project.agents ?? []);
      });
    loader()
      .then((loaded) => {
        if (!cancelled && loaded.length > 0) setAgents(loaded);
      })
      .catch(() => {
        if (!cancelled) setAgents([RING_LEAD_AGENT]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentsProp, loadAgents]);

  const activeRun = useMemo(
    () => runs.find((run) => run.runId === activeRunId) ?? runs[runs.length - 1] ?? null,
    [runs, activeRunId],
  );
  const activeState = activeRun?.state ?? null;
  const isActive = activeState !== null && !TERMINAL_STATUSES.includes(activeState.status);

  // Poll the active run and tick the elapsed clock while it is live. The
  // existing WebSocket event channel is project-scoped, not per-run, so
  // polling the run contract is the honest live path.
  useEffect(() => {
    if (!activeRunId || !isActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await clientRef.current.getRun(activeRunId);
        if (cancelled) return;
        setPollError(null);
        setRuns((prev) => prev.map((run) => (run.runId === activeRunId ? { ...run, state } : run)));
        onRunState?.(state);
      } catch (err: unknown) {
        if (!cancelled) setPollError((err as Error).message || 'Could not reach the Ring run service.');
      }
    };
    void tick();
    const poll = setInterval(() => void tick(), pollIntervalMs);
    const clock = setInterval(() => setNowMs(Date.now()), 500);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [activeRunId, isActive, pollIntervalMs, onRunState]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [runs]);

  const presence = useMemo<Record<string, RingAgentPresence>>(() => {
    const map: Record<string, RingAgentPresence> = {};
    for (const agent of agents) map[agent.id] = 'idle';
    // TASK RING-ADAPTER-01 (A6): the Ring lead executes every run; agentId is
    // accepted-and-ignored metadata, so presence never claims a non-lead
    // roster agent is working/waiting — only the lead's dot reflects the run.
    if (activeState) {
      if (activeState.status === 'awaiting_approval') {
        map[RING_LEAD_AGENT.id] = 'waiting';
      } else if (activeState.status === 'running') {
        map[RING_LEAD_AGENT.id] = 'working';
      }
    }
    return map;
  }, [agents, activeRun, activeState]);

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setStartError(null);
  };

  const handleSend = async (event?: React.FormEvent, overrideInstruction?: string) => {
    event?.preventDefault();
    const text = (overrideInstruction ?? instruction).trim();
    if (!text || starting) return;
    setStarting(true);
    setStartError(null);
    setPollError(null);
    setCancelError(null);
    try {
      const scopedAgentId = selectedAgentId === RING_LEAD_AGENT.id ? undefined : selectedAgentId;
      const threadClient = activeThreadId && clientRef.current.postThreadMessage ? clientRef.current : undefined;
      const { runId } = threadClient
        ? await threadClient.postThreadMessage!(activeThreadId as string, text)
        : await clientRef.current.startRun(
            scopedAgentId ? { instruction: text, agentId: scopedAgentId } : { instruction: text },
          );
      runCounterRef.current += 1;
      startedAtRef.current = Date.now();
      setNowMs(Date.now());
      // TASK RING-ADAPTER-01 (A7): no optimistic mode claim — hold null
      // (no badge/banner) until the first GET resolves the real mode.
      setRuns((prev) => [...prev, { runId, instruction: text, agentId: selectedAgentId, state: null }]);
      setActiveRunId(runId);
      setInstruction('');
      try {
        const state = await clientRef.current.getRun(runId);
        setRuns((prev) => prev.map((run) => (run.runId === runId ? { ...run, state } : run)));
        onRunState?.(state);
      } catch (err: unknown) {
        setPollError((err as Error).message || 'Could not reach the Ring run service.');
      }
    } catch (err: unknown) {
      // Backend down: honest error, no run is fabricated. Retry re-sends.
      setStartError((err as Error).message || 'Ring run service unavailable.');
    } finally {
      setStarting(false);
    }
  };

  // TASK DEV-A-01: start a thread, then refresh its summary (runs link on
  // the service side at run start; the summary read shows the linkage).
  const handleNewThread = async () => {
    const client = clientRef.current;
    if (!client.createThread || threadStarting) return;
    setThreadStarting(true);
    setThreadError(null);
    try {
      const { threadId } = await client.createThread({ title: instruction.trim() || undefined });
      setActiveThreadId(threadId);
      setRuns([]);
      setActiveRunId(null);
      if (client.getThread) {
        try {
          setActiveThread(await client.getThread(threadId));
        } catch {
          setActiveThread(null);
        }
      }
    } catch (err: unknown) {
      setThreadError((err as Error).message || 'Could not create the thread.');
    } finally {
      setThreadStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeRunId || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await clientRef.current.cancelRun(activeRunId);
      const state = await clientRef.current.getRun(activeRunId);
      setRuns((prev) => prev.map((run) => (run.runId === activeRunId ? { ...run, state } : run)));
      onRunState?.(state);
    } catch (err: unknown) {
      setCancelError((err as Error).message || 'Could not cancel the run.');
    } finally {
      setCancelling(false);
    }
  };

  const handleDecide = async (runId: string, approvalId: string, decision: RingApprovalDecision) => {
    if (approvalBusyId) return;
    setApprovalBusyId(approvalId);
    setApprovalError(null);
    try {
      await clientRef.current.decideApproval(runId, approvalId, decision);
      const state = await clientRef.current.getRun(runId);
      setRuns((prev) => prev.map((run) => (run.runId === runId ? { ...run, state } : run)));
      onRunState?.(state);
    } catch (err: unknown) {
      setApprovalError((err as Error).message || 'Could not record the approval decision.');
    } finally {
      setApprovalBusyId(null);
    }
  };

  const handleClaimCompletion = (analysisId: string) => {
    if (prepareReview) {
      setReviewBusy(true);
      setReviewError(null);
      prepareReview(analysisId)
        .then((run) => setReviewRun(run))
        .catch((err: unknown) =>
          setReviewError((err as Error).message || 'Could not prepare the persisted review package.'),
        )
        .finally(() => setReviewBusy(false));
      return;
    }
    void coordinatorRef.current?.prepareReview(analysisId);
  };

  const elapsedMs = startedAtRef.current ? nowMs - startedAtRef.current : 0;
  const transcriptEvents = activeState?.events ?? [];
  const resolved = resolvedApprovalIds(transcriptEvents);
  const analysisId = latestAnalysisId(transcriptEvents);
  const failureEvent = transcriptEvents.find((entry) => entry.type === 'run.failed');
  const showEmptyState = runs.length === 0 && !starting;

  const renderTranscriptEvent = (run: TranscriptRun, entry: RingRunEvent, index: number) => {
    const events = run.state?.events ?? [];
    switch (entry.type) {
      case 'tool.call': {
        // TASK RING-ADAPTER-01 (A5): pair by toolCallId (emitted on both
        // sides by the service), never by tool name. Both sides must carry
        // the same non-empty id; id-less mocks never pair by accident.
        const result = entry.toolCallId
          ? events
            .slice(index + 1)
            .find((candidate) => candidate.type === 'tool.result' && candidate.toolCallId === entry.toolCallId)
          : undefined;
        return <RingToolChip key={index} call={entry} result={result} />;
      }
      case 'tool.result': {
        const paired = Boolean(entry.toolCallId) && events
          .slice(0, index)
          .some((candidate) => candidate.type === 'tool.call' && candidate.toolCallId === entry.toolCallId);
        return paired ? null : <RingToolChip key={index} call={entry} result={entry} />;
      }
      case 'model.turn':
        // Evidence-only honesty: a model turn the server sent is rendered;
        // the client never synthesizes one, and there is no fake typing.
        return entry.text ? <RingModelTurn key={index} text={entry.text} /> : null;
      case 'approval.pending': {
        if (entry.approvalId && resolved.has(entry.approvalId)) return null;
        return (
          <RingApprovalCard
            key={index}
            event={entry}
            busy={approvalBusyId === entry.approvalId}
            error={approvalError}
            onDecide={(approvalId, decision) => void handleDecide(run.runId, approvalId, decision)}
          />
        );
      }
      case 'approval.resolved':
        return <RingApprovalResolved key={index} event={entry} />;
      case 'run.failed':
        return (
          <div
            key={index}
            role="alert"
            data-testid="ring-run-failed"
            style={{ alignSelf: 'stretch', fontSize: '12px', color: '#ff7b72', border: '1px solid #ff7b72', borderRadius: '6px', padding: '10px 12px' }}
          >
            Run failed: {entry.message ?? 'The run failed without a message.'}
          </div>
        );
      case 'run.cancelled':
        return (
          <div key={index} data-testid="ring-run-cancelled" style={{ alignSelf: 'flex-start', fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
            Run cancelled.
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <section
      aria-label="Ring agent workspace"
      data-testid="ring-workspace"
      style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0, marginBottom: '12px' }}
    >
      {activeState?.mode === 'evidence-only' && <RingEvidenceOnlyBanner />}
      {activeState?.mode === 'hosted' && (
        <div
          data-testid="ring-hosted-banner"
          style={{
            padding: '8px 14px',
            backgroundColor: 'var(--bg-tertiary, #222222)',
            borderLeft: '4px solid var(--status-green, #4ade80)',
            borderRadius: '4px',
            fontSize: '12px',
            color: 'var(--text-secondary, #cccccc)',
          }}
        >
          <div>{RING_HOSTED_BANNER}</div>
          <div data-testid="ring-telemetry-boundary" style={{ marginTop: '4px', fontSize: '11px' }}>
            {RING_TELEMETRY_BOUNDARY}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
        <RingAgentRoster agents={agents} selectedAgentId={selectedAgentId} presence={presence} onSelect={handleSelectAgent} />

        <div
          style={{
            flex: 1,
            backgroundColor: 'var(--bg-secondary, #1a1a1a)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333333)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          {clientRef.current.createThread && (
            <div
              data-testid="ring-thread-bar"
              style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-color, #333333)', display: 'flex', gap: '8px', alignItems: 'center' }}
            >
              <button
                type="button"
                className="btn-secondary"
                data-testid="ring-new-thread-button"
                disabled={threadStarting}
                onClick={() => void handleNewThread()}
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                {threadStarting ? 'Starting…' : 'New thread'}
              </button>
              {activeThreadId && (
                <span data-testid="ring-active-thread" style={{ fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
                  Thread {activeThreadId}
                  {activeThread ? ` · ${activeThread.runs.length} run${activeThread.runs.length === 1 ? '' : 's'}` : ''}
                </span>
              )}
              {threadError && (
                <span role="alert" data-testid="ring-thread-error" style={{ fontSize: '12px', color: '#ff7b72' }}>
                  {threadError}
                </span>
              )}
            </div>
          )}
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-color, #333333)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: '14px' }}>
              {agents.find((agent) => agent.id === selectedAgentId)?.name ?? selectedAgentId}
              {activeRun ? ` · run ${activeRun.runId}` : ''}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isActive && activeState && (
                <span data-testid="ring-working-indicator" role="status" style={{ fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
                  {activeState.status === 'awaiting_approval' ? 'Waiting for approval' : 'Working'} · {formatElapsed(elapsedMs)}
                </span>
              )}
              {isActive && (
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="ring-cancel-button"
                  disabled={cancelling}
                  onClick={() => void handleCancel()}
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                data-testid="ring-open-cockpit"
                onClick={() => {
                  if (onOpenCockpit) onOpenCockpit();
                  else if (typeof window !== 'undefined') window.location.hash = '#/cockpit';
                }}
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Open Cockpit
              </button>
            </span>
          </div>

          {cancelError && (
            <div role="alert" data-testid="ring-cancel-error" style={{ padding: '8px 14px', fontSize: '12px', color: '#ff7b72' }}>
              {cancelError}
            </div>
          )}
          {pollError && (
            <div role="alert" data-testid="ring-poll-error" style={{ padding: '8px 14px', fontSize: '12px', color: '#ff7b72' }}>
              Could not refresh the run: {pollError}
            </div>
          )}

          <div
            data-testid="ring-transcript"
            style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}
          >
            {showEmptyState && (
              <div
                data-testid="ring-empty-state"
                className="state-box"
                style={{ margin: 'auto', padding: '40px 20px', textAlign: 'center', color: 'var(--text-dim, #888888)', maxWidth: '520px' }}
              >
                <div className="state-title" style={{ fontSize: '15px', fontWeight: 500, color: 'inherit' }}>
                  No runs yet
                </div>
                <p className="state-message" style={{ fontSize: '13px', margin: '6px auto 14px auto' }}>
                  Pick an agent, give Ring an instruction, and watch the work happen here — tool activity, approvals, and the final answer.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {SUGGESTED_INSTRUCTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="btn-secondary"
                      data-testid="ring-suggestion"
                      onClick={() => setInstruction(suggestion)}
                      style={{ padding: '8px 12px', fontSize: '12px', textAlign: 'left' }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {runs.map((run) => (
              <React.Fragment key={run.runId}>
                <RingUserMessage text={run.instruction} agentId={run.agentId} />
                {(run.state?.events ?? []).map((entry, index) => renderTranscriptEvent(run, entry, index))}
                {run.state?.finalAnswer && <RingFinalAnswer answer={run.state.finalAnswer} mode={run.state.mode} />}
                {run.state?.status === 'failed' && !failureEvent && (
                  <div role="alert" data-testid="ring-run-failed" style={{ fontSize: '12px', color: '#ff7b72' }}>
                    Run failed.
                  </div>
                )}
              </React.Fragment>
            ))}
            <div ref={transcriptEndRef} />
          </div>

          {analysisId && (
            <div style={{ padding: '0 16px 12px' }}>
              <CompletionRefusalDemo
                analysisId={analysisId}
                reviewBusy={reviewBusy}
                reviewError={reviewError}
                actionsDisabled={false}
                onClaim={handleClaimCompletion}
              />
              {reviewRun && (
                <div role="status" style={{ marginTop: '8px', fontSize: '11px' }}>
                  Run {reviewRun.runId} · {reviewRun.status.replace('_', ' ')}
                </div>
              )}
              <RingVerifyCard transcript={verifyTranscript ?? {}} />
            </div>
          )}

          <form
            onSubmit={(event) => void handleSend(event)}
            style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--border-color, #333333)',
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            <label htmlFor="ring-instruction-input" style={{ fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
              Instruction for {selectedAgentId}
            </label>
            <input
              id="ring-instruction-input"
              type="text"
              aria-label="Instruction for Ring"
              data-testid="ring-instruction-input"
              placeholder="Tell Ring what to do…"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={starting}
              style={{
                flex: 1,
                padding: '9px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border-color, #444444)',
                backgroundColor: 'var(--bg-primary, #121212)',
                color: 'inherit',
                fontSize: '13px',
              }}
            />
            <button
              type="submit"
              className="btn-primary"
              data-testid="ring-send-button"
              disabled={starting || !instruction.trim()}
              style={{ padding: '9px 18px', fontSize: '13px' }}
            >
              {starting ? 'Starting…' : 'Send'}
            </button>
          </form>
          {startError && (
            <div
              role="alert"
              data-testid="ring-start-error"
              style={{ padding: '0 16px 12px', fontSize: '12px', color: '#ff7b72', display: 'flex', gap: '10px', alignItems: 'center' }}
            >
              <span>{startError}</span>
              <button
                type="button"
                className="btn-secondary"
                data-testid="ring-retry-button"
                disabled={starting || !instruction.trim()}
                onClick={() => void handleSend()}
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
