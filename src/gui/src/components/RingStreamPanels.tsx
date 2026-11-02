/**
 * TASK RING-DEV-B-01 (Day 1c): streaming-event display components for the
 * Ring workspace and overlay.
 *
 * Consumes ONLY the frozen shapes in `../api/ring-run-types.ts`
 * (model.delta, plan.updated, artifact.created, memory.saved). Every piece
 * of text shown is rendered verbatim from the event payload; nothing is
 * invented, interpolated, or defaulted.
 *
 * Honesty rules enforced here:
 * - Live text (`model.delta` fragments) is appended to the running draft in
 *   arrival order and labelled as partial until `run.completed` — no fake
 *   typewriter animation: fragments appear only when the server sent them.
 * - `plan.updated` replaces the whole checklist (server is authoritative).
 * - `artifact.created` renders an Open/Download card; the download path
 *   goes through the adapter's artifact endpoint with the run id + filename
 *   only — never a raw path, never a token in a URL.
 * - `memory.saved` renders the stored note summary verbatim.
 * - Evidence-only runs have no model turns to fake: `model.delta` events
 *   are rendered only if the server actually sent them.
 */
import React from 'react';
import type {
  RingArtifactDescriptor,
  RingMemoryRecord,
  RingPlanStep,
  RingRunEvent,
} from '../api/ring-run-types';

/**
 * TASK DEV-C-FEEL-01 (feel 4): ring animation states match the real run
 * state. `needs-you` is a distinct stop state for an UNRESOLVED
 * approval — the ring stops pulsing (no spinning while waiting on the
 * human) and the amber "Needs you" label/banner takes over instead. The
 * `waiting-for-approval` union member is preserved verbatim for the
 * frozen contract and existing callers/tests.
 */
export type RingVisualState =
  | 'idle'
  | 'thinking'
  | 'using-tool'
  | 'waiting-for-approval'
  | 'needs-you'
  | 'done'
  | 'error';

/**
 * Derives the animated-ring state from a run snapshot. Pure function so the
 * overlay and the full view agree; tested directly.
 */
export function ringVisualStateForRun(
  status: string | null,
  events: readonly RingRunEvent[],
): RingVisualState {
  if (!status) return 'idle';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'completed') return 'done';
  if (status === 'awaiting_approval') return 'needs-you';
  // TASK DEV-C-FEEL-01 (feel 4): an unresolved approval.pending on a
  // still-running run is the needs-you state — distinct from in-flight
  // thinking/using-tool, which keep pulsing.
  const pendingIds = new Set(
    events.filter((e) => e.type === 'approval.pending' && e.approvalId).map((e) => e.approvalId as string),
  );
  const resolvedIds = new Set(
    events.filter((e) => e.type === 'approval.resolved' && e.approvalId).map((e) => e.approvalId as string),
  );
  for (const id of pendingIds) {
    if (!resolvedIds.has(id)) return 'needs-you';
  }
  const toolCalls = events.filter((e) => e.type === 'tool.call').length;
  const pairedResults = events.filter((e) => e.type === 'tool.result').length;
  if (toolCalls > 0 && pairedResults < toolCalls) return 'using-tool';
  if (events.length > 0) return 'thinking';
  return 'idle';
}

const RING_STATE_COLOR: Record<RingVisualState, string> = {
  idle: 'var(--text-dim, #888888)',
  thinking: 'var(--accent, #3b82f6)',
  'using-tool': 'var(--status-green, #4ade80)',
  'waiting-for-approval': 'var(--status-amber, #eab308)',
  'needs-you': 'var(--status-amber, #eab308)',
  done: 'var(--status-green, #4ade80)',
  error: 'var(--status-red, #ef4444)',
};

const RING_STATE_LABEL: Record<RingVisualState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  'using-tool': 'Using tool',
  'waiting-for-approval': 'Waiting for approval',
  'needs-you': 'Needs you',
  done: 'Done',
  error: 'Needs attention',
};

/**
 * Animated Ring mark. SVG pulse animation (no JS timers, no fake typing):
 * the animation runs only while `state` is thinking/using-tool. The
 * needs-you and waiting-for-approval states render a STATIC amber ring —
 * no spinning while waiting on the human (TASK DEV-C-FEEL-01 feel 4); the
 * distinct "Needs you" label/banner carries the call to act instead.
 */
export const RingMark: React.FC<{ state: RingVisualState; size?: number }> = ({
  state,
  size = 44,
}) => {
  const animated = state === 'thinking' || state === 'using-tool';
  const color = RING_STATE_COLOR[state];
  return (
    <span
      role="img"
      aria-label={'Ring: ' + RING_STATE_LABEL[state]}
      data-testid="ring-mark"
      data-state={state}
      style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}
    >
      <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="3" opacity="0.9" />
        {animated ? (
          <circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="3" opacity="0.4">
            <animate attributeName="r" values="14;21;14" dur="1.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0.1;0.5" dur="1.8s" repeatCount="indefinite" />
          </circle>
        ) : (
          <circle cx="22" cy="22" r="7" fill={color} opacity="0.85" />
        )}
      </svg>
    </span>
  );
};

/**
 * Live model text assembled from `model.delta` fragments (arrival order) +
 * any full `model.turn` texts. The caller passes the already-ordered event
 * list; this component only concatenates `delta`/`text` verbatim and marks
 * the block partial while the run is still live. No timers, no invented
 * characters.
 */
export const RingLiveText: React.FC<{ events: readonly RingRunEvent[]; live: boolean }> = ({
  events,
  live,
}) => {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === 'model.delta' && typeof event.delta === 'string') parts.push(event.delta);
    else if (event.type === 'model.turn' && typeof event.text === 'string') parts.push(event.text);
  }
  if (parts.length === 0) return null;
  return (
    <div data-testid="ring-live-text" style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
      <div
        style={{ fontSize: '11px', fontWeight: 600, color: 'var(--status-green, #4ade80)', marginBottom: '4px' }}
      >
        RING{live ? ' · live' : ''}
      </div>
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
        {parts.join('')}
        {live && (
          <span data-testid="ring-live-caret" aria-hidden="true" style={{ opacity: 0.6 }}>
            {' '}
            &#9612;
          </span>
        )}
      </div>
      {live && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim, #888888)', marginTop: '4px' }}>
          Streaming from the run — partial text.
        </div>
      )}
    </div>
  );
};

/** Live plan checklist. The latest `plan.updated` wins; steps render verbatim. */
export const RingPlanChecklist: React.FC<{ plan: readonly RingPlanStep[] }> = ({ plan }) => {
  if (plan.length === 0) return null;
  const done = plan.filter((s) => s.status === 'done').length;
  return (
    <div
      data-testid="ring-plan-checklist"
      aria-label={'Plan: ' + done + ' of ' + plan.length + ' steps done'}
      style={{
        alignSelf: 'flex-start',
        maxWidth: '90%',
        border: '1px solid var(--border-color, #444444)',
        borderRadius: '6px',
        padding: '8px 12px',
        backgroundColor: 'var(--bg-tertiary, #262626)',
        fontSize: '12px',
      }}
    >
      <div style={{ fontSize: '11px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-secondary, #cccccc)' }}>
        PLAN · {done}/{plan.length}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {plan.map((step, index) => (
          <li
            key={index}
            data-testid="ring-plan-step"
            data-status={step.status}
            style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}
          >
            <span aria-hidden="true">{step.status === 'done' ? '✓' : step.status === 'in_progress' ? '…' : '○'}</span>
            <span>{step.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Latest plan in an event list (last `plan.updated` wins; earlier ones are history). */
export function latestPlan(events: readonly RingRunEvent[]): RingPlanStep[] {
  let plan: RingPlanStep[] = [];
  for (const event of events) {
    if (event.type === 'plan.updated' && Array.isArray(event.plan)) plan = event.plan;
  }
  return plan;
}

/** All artifact descriptors in arrival order. */
export function allArtifacts(events: readonly RingRunEvent[]): RingArtifactDescriptor[] {
  const out: RingArtifactDescriptor[] = [];
  for (const event of events) {
    if (event.type === 'artifact.created' && event.artifact) out.push(event.artifact);
  }
  return out;
}

/** All memory records in arrival order. */
export function allMemories(events: readonly RingRunEvent[]): RingMemoryRecord[] {
  const out: RingMemoryRecord[] = [];
  for (const event of events) {
    if (event.type === 'memory.saved' && event.memory) out.push(event.memory);
  }
  return out;
}

/**
 * Artifact card: Open downloads through the adapter (run id + filename —
 * never a raw path or token in a URL) and reports failures verbatim.
 * The filename shown is the server-provided descriptor suffix, not a path.
 */
export const RingArtifactCard: React.FC<{
  artifact: RingArtifactDescriptor;
  runId: string;
  onDownload: (runId: string, filename: string) => Promise<void>;
}> = ({ artifact, runId, onDownload }) => {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const filename = artifact.path.split('/').pop() || artifact.path;
  const handleOpen = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDownload(runId, filename);
    } catch (err: unknown) {
      setError((err as Error).message || 'The artifact could not be downloaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-testid="ring-artifact-card"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '90%',
        border: '1px solid var(--border-color, #444444)',
        borderRadius: '6px',
        padding: '8px 12px',
        backgroundColor: 'var(--bg-tertiary, #262626)',
        fontSize: '12px',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: '4px', color: 'var(--text-secondary, #cccccc)' }}>
        ARTIFACT · {artifact.kind}
      </div>
      <div data-testid="ring-artifact-name" style={{ wordBreak: 'break-all' }}>
        {filename}
      </div>
      <div style={{ color: 'var(--text-dim, #888888)', fontSize: '11px', marginTop: '2px' }}>
        {artifact.size} bytes · sha256 {artifact.sha256.slice(0, 12)}…
      </div>
      <button
        type="button"
        data-testid="ring-artifact-open"
        disabled={busy}
        onClick={() => void handleOpen()}
        style={{ marginTop: '8px', padding: '4px 10px', fontSize: '12px' }}
        className="btn-secondary"
      >
        {busy ? 'Opening…' : 'Open'}
      </button>
      {error && (
        <div role="alert" style={{ marginTop: '6px', color: '#ff7b72', fontSize: '12px' }}>
          {error}
        </div>
      )}
    </div>
  );
};

/**
 * TASK DEV-C-FEEL-01 (feel 3): bottom-line-first answer layout. The first
 * thing a run shows is one verdict line (preferred: verdict + RMS with
 * units from the latest paired tool.result; fallback: the first model
 * text / final answer truncated to one line), then evidence and sources
 * render below in the normal transcript. Everything is verbatim from
 * polled events — no invented numbers, units always attached.
 */
export function bottomLineForEvents(
  events: readonly RingRunEvent[],
  finalAnswer?: string,
): { line: string; verdict?: string; overallRms?: number; sources: string[] } | null {
  let verdict: string | undefined;
  let overallRms: number | undefined;
  let sources: string[] = [];
  for (const event of events) {
    if (event.type === 'tool.result') {
      if (typeof event.verdict === 'string' && event.verdict) verdict = event.verdict;
      if (typeof event.overallRms === 'number') overallRms = event.overallRms;
      if (Array.isArray(event.sources) && event.sources.length > 0) sources = [...event.sources];
    }
  }
  if (verdict !== undefined || overallRms !== undefined) {
    const parts: string[] = [];
    if (verdict) parts.push(verdict);
    if (overallRms !== undefined) parts.push('RMS ' + overallRms + ' mm/s');
    return { line: parts.join(' · ') || 'Result', verdict, overallRms, sources };
  }
  for (const event of events) {
    if ((event.type === 'model.turn' || event.type === 'model.delta') && typeof (event.text ?? event.delta) === 'string') {
      const raw = String(event.text ?? event.delta).trim().split('\n')[0].trim();
      if (raw) return { line: raw, sources: [] };
    }
  }
  if (typeof finalAnswer === 'string' && finalAnswer.trim()) {
    return { line: finalAnswer.trim().split('\n')[0].trim(), sources: [] };
  }
  return null;
}

export const RingBottomLine: React.FC<{
  events: readonly RingRunEvent[];
  finalAnswer?: string;
  mode?: string;
}> = ({ events, finalAnswer, mode }) => {
  const bottom = bottomLineForEvents(events, finalAnswer);
  if (!bottom) return null;
  return (
    <div data-testid="ring-bottom-line" style={{ alignSelf: 'flex-start', maxWidth: '90%' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary, #cccccc)', marginBottom: '4px' }}>
        BOTTOM LINE{mode === 'evidence-only' ? ' · EVIDENCE-ONLY' : ''}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: '1.4' }}>{bottom.line}</div>
      {bottom.sources.length > 0 && (
        <div data-testid="ring-bottom-line-sources" style={{ fontSize: '11px', color: 'var(--text-dim, #888888)', marginTop: '4px' }}>
          Evidence:{' '}
          {bottom.sources.map((source, index) => (
            <span key={index}>
              {index > 0 ? ', ' : ''}
              <code>{source}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/** Stored-memory note, rendered verbatim. */
export const RingMemoryNote: React.FC<{ memory: RingMemoryRecord }> = ({ memory }) => (
  <div
    data-testid="ring-memory-note"
    style={{
      alignSelf: 'flex-start',
      maxWidth: '90%',
      border: '1px dashed var(--border-color, #444444)',
      borderRadius: '6px',
      padding: '8px 12px',
      fontSize: '12px',
      color: 'var(--text-secondary, #cccccc)',
    }}
  >
    <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: '4px' }}>SAVED NOTE</div>
    <div>{memory.summary}</div>
  </div>
);
