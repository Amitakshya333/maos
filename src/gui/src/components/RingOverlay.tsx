/**
 * TASK RING-DEV-B-01 (Day 1a/1c): Ring overlay — the compact always-on-top
 * companion window (Electron second BrowserWindow, `#/ring-overlay`).
 *
 * Same GUI bundle, same thread ids, same run state as the full view:
 * - Owns no session of its own: `main.tsx` boots the same adapter from the
 *   same launcher bootstrap, and the overlay reuses `defaultRingRunClient`
 *   (same REST routes, same private-IPC session, same loopback origin).
 * - Compact chat: RingMark + live transcript (plan checklist, live text,
 *   tool chips, artifact cards, memory notes) + inline Allow/Deny approval
 *   card (human-in-the-loop inside the overlay — consequential actions
 *   still pause) + instruction input + explicit "What am I looking at?"
 *   screenshot button (Electron IPC capture with a visible indicator, or
 *   the browser screen picker elsewhere — never automatic).
 * - "Expand" navigates the MAIN window to the full Ring view on the same
 *   thread: it writes the thread id to localStorage (`maos:ring:expand`)
 *   and asks the opener via IPC (`maos:expand-ring`); the full view picks
 *   the thread up on focus. Same thread ids in overlay and full view.
 * - Evidence-only honesty: the exact `RING_EVIDENCE_ONLY_BADGE` copy, no
 *   fake streaming (fragments render only when polled).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiAdapter } from '../api';
import type { RingApprovalDecision, RingRunEvent, RingRunState } from '../api/ring-run-types';
import {
  RING_EVIDENCE_ONLY_BADGE,
  RING_HOSTED_BADGE,
  RingApprovalCard,
  RingFinalAnswer,
  RingModelTurn,
  RingToolChip,
  defaultRingRunClient,
  type RingRunClient,
} from './RingWorkspace';
import {
  allMemories,
  latestPlan,
  RingArtifactCard,
  RingLiveText,
  RingMemoryNote,
  RingPlanChecklist,
  ringVisualStateForRun,
  RingMark,
} from './RingStreamPanels';
import { RING_EXPAND_KEY } from './RingThreads';

function resolvedApprovalIds(events: readonly RingRunEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type === 'approval.resolved' && event.approvalId) resolved.add(event.approvalId);
  }
  return resolved;
}

export const RingOverlay: React.FC<{ runClient?: RingRunClient; pollIntervalMs?: number }> = ({
  runClient,
  pollIntervalMs = 1000,
}) => {
  const clientRef = useRef<RingRunClient>(runClient ?? defaultRingRunClient);
  if (runClient) clientRef.current = runClient;

  const [instruction, setInstruction] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  // TASK RING-DEV-B-01 (Day 1a): overlay shares thread ids with the full
  // view. When the run client carries a thread client (same REST routes as
  // the workspace), overlay sends post into one overlay thread so Expand
  // hands off a thread id, not just a run id.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadsAvailable, setThreadsAvailable] = useState(true);
  const [state, setState] = useState<RingRunState | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const events = useMemo(() => state?.events ?? [], [state]);
  const resolved = useMemo(() => resolvedApprovalIds(events), [events]);
  const isLive = state !== null && !['completed', 'failed', 'cancelled'].includes(state.status);
  const visual = ringVisualStateForRun(state?.status ?? null, events);
  const modeBadge = state
    ? state.mode === 'evidence-only'
      ? RING_EVIDENCE_ONLY_BADGE
      : RING_HOSTED_BADGE
    : null;

  useEffect(() => {
    if (!runId || !isLive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await clientRef.current.getRun(runId);
        if (!cancelled) setState(next);
      } catch {
        /* poll errors stay silent in the overlay; the last state persists */
      }
    };
    void tick();
    const poll = setInterval(() => void tick(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [runId, isLive, pollIntervalMs]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const handleSend = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = instruction.trim();
    if (!text || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      let nextRunId: string;
      const threadClient = clientRef.current.threadClient;
      if (threadClient && threadsAvailable) {
        try {
          let tid = threadId;
          if (!tid) {
            const created = await threadClient.createThread({ title: 'Ring overlay ' + new Date().toLocaleString(), role: 'operator' });
            tid = created.threadId;
            setThreadId(tid);
          }
          nextRunId = (await threadClient.postMessage(tid, text)).runId;
        } catch {
          // Thread service unreachable (Dev A lane): the overlay keeps
          // working with unscoped runs and says so on the next send.
          setThreadsAvailable(false);
          nextRunId = (await clientRef.current.startRun({ instruction: text })).runId;
        }
      } else {
        nextRunId = (await clientRef.current.startRun({ instruction: text })).runId;
      }
      setRunId(nextRunId);
      setInstruction('');
      try {
        setState(await clientRef.current.getRun(nextRunId));
      } catch (err: unknown) {
        setStartError((err as Error).message || 'Could not reach the Ring run service.');
      }
    } catch (err: unknown) {
      setStartError((err as Error).message || 'Ring run service unavailable.');
    } finally {
      setStarting(false);
    }
  };

  const handleDecide = useCallback(
    async (approvalId: string, decision: RingApprovalDecision) => {
      if (!runId || approvalBusyId) return;
      setApprovalBusyId(approvalId);
      setApprovalError(null);
      try {
        await clientRef.current.decideApproval(runId, approvalId, decision);
        setState(await clientRef.current.getRun(runId));
      } catch (err: unknown) {
        setApprovalError((err as Error).message || 'Could not record the approval decision.');
      } finally {
        setApprovalBusyId(null);
      }
    },
    [runId, approvalBusyId],
  );

  const [expandNote, setExpandNote] = useState<string | null>(null);
  // TASK RING-DEV-B-01 (Day 2c): explicit screenshot state. The image is
  // held in memory only (a thumbnail chip); nothing is written to disk
  // and nothing is sent anywhere — `inspect_image` is Dev C's lane, so
  // the chip is labelled pending until that tool exists.
  const [screenshot, setScreenshot] = useState<{ name: string; dataUrl: string; width: number; height: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const handleScreenshot = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setCaptureError(null);
    try {
      const bridge = (window as unknown as { maosNative?: { captureRingScreen?: () => Promise<unknown> } }).maosNative;
      if (bridge?.captureRingScreen) {
        // Electron: the main process captures the primary display on this
        // explicit call only; the overlay badge stays visible throughout.
        const result = (await bridge.captureRingScreen()) as
          | { pngBase64: string; width: number; height: number; displays: number }
          | { dismissed: true; reason: string };
        if ('dismissed' in result) {
          setCaptureError(result.reason);
        } else {
          setScreenshot({
            name: 'ring-screenshot-' + Date.now() + '.png',
            dataUrl: 'data:image/png;base64,' + result.pngBase64,
            width: result.width,
            height: result.height,
          });
        }
        return;
      }
      // Browser build: the user picks the screen in the OS picker — the
      // capture cannot happen silently.
      if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
        throw new Error('Screen capture is not available in this browser context.');
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      try {
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No screen track was granted.');
        const bitmap = await new ImageCapture(track).grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        setScreenshot({ name: 'ring-screenshot-' + Date.now() + '.png', dataUrl, width: bitmap.width, height: bitmap.height });
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'NotAllowedError') {
        setCaptureError('Screen capture dismissed: no screen was shared.');
      } else {
        setCaptureError((err as Error)?.message || 'Screen capture failed.');
      }
    } finally {
      setCapturing(false);
    }
  }, [capturing]);
  const handleExpand = useCallback(() => {
    // TASK RING-DEV-B-01 (Day 1a): Expand moves overlay→full app on the
    // same thread. The overlay keeps its own route (it never navigates
    // itself — the old `location.hash` hop destroyed overlay context).
    // Thread id wins; the run id is the fallback when no thread exists.
    // In a browser tab without the Electron bridge, the handoff key stays
    // intact and the tab navigates to the full view itself.
    const handoff = threadId ?? runId;
    try {
      if (handoff) window.localStorage.setItem(RING_EXPAND_KEY, handoff);
    } catch {
      /* storage is a convenience; focusing the main window still helps */
    }
    const bridge = (window as unknown as { maosNative?: { expandRing?: () => void } }).maosNative;
    if (bridge?.expandRing) {
      try {
        bridge.expandRing();
        setExpandNote('Opening in the full Ring view…');
        return;
      } catch {
        /* fall through to the in-tab navigation */
      }
    }
    setExpandNote('Full Ring view opened in this tab.');
    window.location.hash = '#/chat';
  }, [threadId, runId]);

  const renderEvent = (entry: RingRunEvent, index: number) => {
    switch (entry.type) {
      case 'tool.call': {
        const result = entry.toolCallId
          ? events
              .slice(index + 1)
              .find((c) => c.type === 'tool.result' && c.toolCallId === entry.toolCallId)
          : undefined;
        return <RingToolChip key={index} call={entry} result={result} />;
      }
      case 'tool.result': {
        const paired =
          Boolean(entry.toolCallId) &&
          events.slice(0, index).some((c) => c.type === 'tool.call' && c.toolCallId === entry.toolCallId);
        return paired ? null : <RingToolChip key={index} call={entry} result={entry} />;
      }
      case 'model.turn':
        return entry.text ? <RingModelTurn key={index} text={entry.text} /> : null;
      case 'model.delta': {
        const laterDelta = events.slice(index + 1).some((e) => e.type === 'model.delta');
        if (laterDelta) return null;
        return <RingLiveText key={index} events={events.filter((e) => e.type === 'model.delta')} live={isLive} />;
      }
      case 'plan.updated': {
        const laterPlan = events.slice(index + 1).some((e) => e.type === 'plan.updated');
        if (laterPlan || !entry.plan) return null;
        return <RingPlanChecklist key={index} plan={entry.plan} />;
      }
      case 'artifact.created':
        return entry.artifact ? (
          <RingArtifactCard
            key={index}
            artifact={entry.artifact}
            runId={runId ?? ''}
            onDownload={(rid, filename) => clientRef.current.downloadArtifact(rid, filename)}
          />
        ) : null;
      case 'memory.saved':
        return entry.memory ? <RingMemoryNote key={index} memory={entry.memory} /> : null;
      case 'approval.pending': {
        if (entry.approvalId && resolved.has(entry.approvalId)) return null;
        return (
          <RingApprovalCard
            key={index}
            event={entry}
            busy={approvalBusyId === entry.approvalId}
            error={approvalError}
            onDecide={(approvalId, decision) => void handleDecide(approvalId, decision)}
          />
        );
      }
      case 'approval.resolved':
        return (
          <div key={index} data-testid="ring-approval-resolved" style={{ fontSize: '12px', color: 'var(--text-secondary, #cccccc)' }}>
            {entry.decision === 'approved' ? '✓ Approved' : '✕ Denied'}
          </div>
        );
      case 'run.failed':
        return (
          <div key={index} role="alert" data-testid="ring-run-failed" style={{ fontSize: '12px', color: '#ff7b72' }}>
            Run failed: {entry.message ?? 'The run failed without a message.'}
          </div>
        );
      default:
        return null;
    }
  };

  void latestPlan;
  void allMemories;

  return (
    <section
      aria-label="Ring overlay"
      data-testid="ring-overlay"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        height: '100vh',
        padding: '12px',
        backgroundColor: 'rgba(18, 18, 18, 0.88)',
        color: 'var(--text-primary, #eeeeee)',
        fontSize: '13px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <RingMark state={visual} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>Ring</div>
          {modeBadge && (
            <div data-testid="ring-overlay-badge" style={{ fontSize: '11px', color: 'var(--text-dim, #888888)' }}>
              {modeBadge}
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="ring-expand-button"
          onClick={handleExpand}
          className="btn-secondary"
          style={{ padding: '4px 10px', fontSize: '12px' }}
          title="Open this thread in the full Ring workspace"
        >
          Expand
        </button>
        {expandNote && (
          <span data-testid="ring-expand-note" style={{ fontSize: '11px', color: 'var(--text-dim, #888888)' }}>
            {expandNote}
          </span>
        )}
      </header>

      <div
        data-testid="ring-overlay-transcript"
        style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}
      >
        {!runId && (
          <div data-testid="ring-overlay-empty" style={{ color: 'var(--text-dim, #888888)', fontSize: '12px' }}>
            Ask Ring anything — the plan, tools, approvals, and files stream here.
            {!threadsAvailable && ' Runs are unscoped: the thread service is unreachable.'}
          </div>
        )}
        {events.map(renderEvent)}
        {state?.finalAnswer && <RingFinalAnswer answer={state.finalAnswer} mode={state.mode} />}
        <div ref={endRef} />
      </div>

      {startError && (
        <div role="alert" data-testid="ring-overlay-error" style={{ fontSize: '12px', color: '#ff7b72' }}>
          {startError}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="ring-overlay-screenshot"
          disabled={capturing}
          onClick={() => void handleScreenshot()}
          className="btn-secondary"
          style={{ padding: '4px 10px', fontSize: '12px' }}
          title="Capture the screen you pick and hold it locally (inspect_image arrives with Dev C)"
        >
          {capturing ? 'Capturing…' : 'What am I looking at?'}
        </button>
        {capturing && (
          <span data-testid="ring-overlay-screenshot-indicator" role="status" style={{ fontSize: '11px', color: 'var(--status-amber, #eab308)' }}>
            ● Capture in progress — you chose to share this screen.
          </span>
        )}
        {screenshot && (
          <span data-testid="ring-overlay-screenshot-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
            <img src={screenshot.dataUrl} alt="Captured screen thumbnail" style={{ width: '48px', height: 'auto', borderRadius: '4px', border: '1px solid var(--border-color, #444444)' }} />
            {screenshot.name} · {screenshot.width}×{screenshot.height} · local only — inspect_image pending (Dev C)
            <button
              type="button"
              aria-label={'Discard ' + screenshot.name}
              onClick={() => setScreenshot(null)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 2px' }}
            >
              ×
            </button>
          </span>
        )}
      </div>
      {captureError && (
        <div role="alert" data-testid="ring-overlay-screenshot-error" style={{ fontSize: '12px', color: '#ff7b72' }}>
          {captureError}
        </div>
      )}

      <form onSubmit={(event) => void handleSend(event)} style={{ display: 'flex', gap: '8px' }}>
        <input
          aria-label="Ask Ring"
          data-testid="ring-overlay-input"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          disabled={starting}
          placeholder="Ask Ring…"
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #444444)',
            backgroundColor: 'var(--bg-primary, #121212)',
            color: 'inherit',
            fontSize: '13px',
          }}
        />
        <button
          type="submit"
          data-testid="ring-overlay-send"
          disabled={starting || !instruction.trim()}
          className="btn-primary"
          style={{ padding: '8px 14px', fontSize: '13px' }}
        >
          {starting ? '…' : 'Send'}
        </button>
      </form>
    </section>
  );
};
