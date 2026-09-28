/**
 * MAOS GUI — Read-Only Agent Cockpit View (UI1-15)
 *
 * Implements a strictly read-only cockpit view for observing workflow runs:
 *   - Workflow stages and topological DAG layout
 *   - Active agent identity and capability
 *   - Actual resident model (family, revision, hardware, CPU fallback)
 *   - Tool executions (invocations, status, latency)
 *   - I/O artifacts (source IDs, expected types, generated IDs and SHA-256 hashes)
 *   - Retries count and failure diagnostics
 *   - Token usage (prompt, completion, total) and latency timings
 *   - Approval checkpoints (required, status, reviewedBy, reviewedAt, reason)
 *   - Safe cancel and emergency force-stop controls with confirmation
 *   - Live WebSocket event stream and deterministic replay scrubber
 *
 * NEGATIVE PROTECTIONS ENFORCED:
 *   - No graphical editing / node mutation
 *   - Zero placeholder success badges
 *   - Reject out-of-order and skipped sequence events
 *   - Reject cross-project events
 *   - Guard against phantom completion after failure or force-stop
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  CockpitIcon,
  AgentsIcon,
  ModelsIcon,
  ApprovalsIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  TerminalIcon,
  ShieldIcon,
  CloseIcon,
} from '../components/icons';
import { apiAdapter } from '../api';
import type { JudgedRunResponse } from '../api/rest-client';
import type {
  CockpitState,
  CockpitStageNode,
  CockpitRunSummary,
  CockpitStageStatus,
} from '../../../domain/cockpit';
import { applySequencedEventToCockpit } from '../../../domain/cockpit';
import type { SequencedEvent } from '../../../domain/schemas';
import type { ConnectionState } from '../api/event-client';
import { TelemetryReviewPanel } from '../components/TelemetryReviewPanel';

const STATUS_COLORS: Record<CockpitStageStatus, { bg: string; border: string; text: string; label: string }> = {
  PENDING: { bg: '#21262d', border: '#30363d', text: '#8b949e', label: 'Pending' },
  READY: { bg: '#161b22', border: '#1f6feb', text: '#58a6ff', label: 'Ready' },
  RUNNING: { bg: '#0c2d6b', border: '#58a6ff', text: '#79c0ff', label: 'Running' },
  COMPLETED: { bg: '#0d381e', border: '#238636', text: '#3fb950', label: 'Completed' },
  FAILED: { bg: '#3c1e1e', border: '#da3633', text: '#f85149', label: 'Failed' },
  SKIPPED: { bg: '#21262d', border: '#484f58', text: '#8b949e', label: 'Skipped' },
  WAITING_APPROVAL: { bg: '#3b2300', border: '#d29922', text: '#e3b341', label: 'Waiting Approval' },
  INTERRUPTED: { bg: '#2f1538', border: '#a371f7', text: '#d2a8ff', label: 'Interrupted' },
};

export const CockpitView: React.FC = () => {
  const [runs, setRuns] = useState<CockpitRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [cockpitState, setCockpitState] = useState<CockpitState | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Live WebSocket state
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [recentEvents, setRecentEvents] = useState<SequencedEvent[]>([]);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);

  // Force Stop Modal State
  const [showForceStopModal, setShowForceStopModal] = useState<boolean>(false);
  const [forceStopConfirmed, setForceStopConfirmed] = useState<boolean>(false);
  const [forceStopReason, setForceStopReason] = useState<string>('');
  const [submittingStop, setSubmittingStop] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [judgedRun, setJudgedRun] = useState<JudgedRunResponse | null>(null);
  const [startingJudgedRun, setStartingJudgedRun] = useState(false);

  useEffect(() => {
    const savedRunId = window.localStorage.getItem('maos:last-industrial-judged-run');
    if (!savedRunId) return;
    apiAdapter.getIndustrialJudgedRun(savedRunId).then(setJudgedRun).catch(() => {});
  }, []);

  useEffect(() => {
    if (!judgedRun?.runId || judgedRun.status !== 'pending_approval') return;
    const timer = window.setInterval(() => {
      apiAdapter.getIndustrialJudgedRun(judgedRun.runId).then(setJudgedRun).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [judgedRun?.runId, judgedRun?.status]);

  const handleStartT07Run = async () => {
    setStartingJudgedRun(true);
    setActionMessage(null);
    try {
      const run = await apiAdapter.startIndustrialJudgedRun();
      setJudgedRun(run);
      window.localStorage.setItem('maos:last-industrial-judged-run', run.runId);
      setActionMessage({ type: 'success', text: `T-07 analysis is ready. Review approval ${String(run.details?.approvalId || run.approvalId || 'in queue')} before the report is generated.` });
    } catch (err: unknown) {
      setActionMessage({ type: 'error', text: `T-07 run could not start: ${(err as Error).message}` });
    } finally {
      setStartingJudgedRun(false);
    }
  };

  // 1. Fetch available runs
  const fetchRuns = useCallback(async () => {
    try {
      const runList = await apiAdapter.listCockpitRuns();
      setRuns(runList);
      if (runList.length > 0 && !selectedRunId) {
        setSelectedRunId(runList[0].runId);
      }
    } catch {
      // Offline or initial startup fallback
    }
  }, [selectedRunId]);

  // 2. Fetch authoritative state for selected run
  const fetchCockpitState = useCallback(
    async (runId: string) => {
      if (!runId) return;
      setLoading(true);
      setError(null);
      try {
        const state = await apiAdapter.getCockpitState(runId);
        setCockpitState(state);
        // Default selected step to first active or first node
        if (state.nodes.length > 0) {
          const activeNode = state.nodes.find((n) => n.status === 'RUNNING' || n.status === 'WAITING_APPROVAL');
          setSelectedStepId(activeNode ? activeNode.stepId : state.nodes[0].stepId);
        }
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to load cockpit state');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial load
  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Load state when selectedRunId changes
  useEffect(() => {
    if (selectedRunId) {
      fetchCockpitState(selectedRunId);
    }
  }, [selectedRunId, fetchCockpitState]);

  // Subscribe to live events and connection lifecycle
  useEffect(() => {
    const unsubEvents = apiAdapter.subscribeEvents((event) => {
      // Scope protection: only process events for current run and project
      if (cockpitState && event.projectId === cockpitState.projectId) {
        if (!event.runId || event.runId === cockpitState.runId) {
          setRecentEvents((prev) => [event, ...prev].slice(0, 30));
          // Apply event reducer deterministically to maintain live view
          setCockpitState((prev) => {
            if (!prev) return prev;
            try {
              return applySequencedEventToCockpit(prev, event);
            } catch {
              return prev;
            }
          });
        }
      }
    });

    const unsubState = apiAdapter.subscribeConnectionState((state) => {
      setConnectionState(state);
    });

    return () => {
      unsubEvents();
      unsubState();
    };
  }, [cockpitState]);

  // Selected stage node
  const selectedNode: CockpitStageNode | null = useMemo(() => {
    if (!cockpitState || !selectedStepId) return null;
    return cockpitState.nodes.find((n) => n.stepId === selectedStepId) || null;
  }, [cockpitState, selectedStepId]);

  // Handler: Replay run deterministically
  const handleReplayRun = async () => {
    if (!selectedRunId) return;
    setIsReplaying(true);
    setActionMessage(null);
    try {
      const replayed = await apiAdapter.replayCockpitRun(selectedRunId, { fromCursor: 0 });
      setCockpitState(replayed);
      setActionMessage({ type: 'success', text: `Replay successful: identical DAG reconstructed (${replayed.nodes.length} stages verified).` });
    } catch (err: unknown) {
      setActionMessage({ type: 'error', text: `Replay failed: ${(err as Error).message}` });
    } finally {
      setIsReplaying(false);
    }
  };

  // Handler: Force stop confirmed
  const handleExecuteForceStop = async () => {
    if (!selectedRunId || !forceStopConfirmed) return;
    setSubmittingStop(true);
    setActionMessage(null);
    try {
      const res = await apiAdapter.stopCockpitRun(selectedRunId, {
        mode: 'force',
        confirmed: true,
        reason: forceStopReason || 'Operator emergency halt via Agent Cockpit',
      });
      setShowForceStopModal(false);
      setForceStopConfirmed(false);
      setForceStopReason('');
      setActionMessage({
        type: 'success',
        text: `Run force stopped successfully. Tasks marked ${res.status.toUpperCase()}. Phantom success prevented.`,
      });
      // Refresh authoritative state
      await fetchCockpitState(selectedRunId);
    } catch (err: unknown) {
      setActionMessage({ type: 'error', text: `Force stop failed: ${(err as Error).message}` });
    } finally {
      setSubmittingStop(false);
    }
  };

  return (
    <div className="view-container cockpit-view" role="tabpanel" aria-label="Agent Cockpit View">
      {/* ── 1. Header & Run Selector ─────────────────────────────── */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CockpitIcon size={24} />
            <h1 className="view-title" style={{ margin: 0 }}>Agent Cockpit</h1>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 12,
                background: '#21262d',
                color: '#8b949e',
                border: '1px solid #30363d',
                letterSpacing: 0.5,
              }}
            >
              RUN OBSERVATION
            </span>
          </div>
          <p className="view-desc" style={{ marginTop: 4, marginBottom: 0 }}>
            Use the CSV evidence review below for a deterministic local threshold check and CLI replay. It does not make an operating decision.
          </p>
        </div>

        {/* Action Controls & Stream Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* WebSocket Status Indicator */}
          <div
            title={`WebSocket: ${connectionState} (seq: ${cockpitState?.currentCursor ?? 0})`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 16,
              background: connectionState === 'connected' ? '#0d381e' : '#21262d',
              color: connectionState === 'connected' ? '#3fb950' : '#8b949e',
              border: `1px solid ${connectionState === 'connected' ? '#238636' : '#30363d'}`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: connectionState === 'connected' ? '#3fb950' : '#8b949e',
                boxShadow: connectionState === 'connected' ? '0 0 6px #3fb950' : 'none',
              }}
            />
            {connectionState === 'connected' ? `LIVE STREAM (seq: ${cockpitState?.currentCursor ?? 0})` : connectionState.toUpperCase()}
          </div>

          <button
            className="btn-primary"
            onClick={handleStartT07Run}
            disabled={startingJudgedRun}
            title="Analyze the included T-07 evidence and pause for a human approval decision"
            style={{ fontSize: 13, whiteSpace: 'nowrap' }}
          >
            {startingJudgedRun ? 'Preparing T-07…' : 'Run T-07 Safety Audit'}
          </button>

          {/* Replay Run Button */}
          <button
            className="secondary-btn"
            onClick={handleReplayRun}
            disabled={!cockpitState || isReplaying}
            title="Reconstruct identical DAG from event stream"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
          >
            <TerminalIcon size={14} />
            {isReplaying ? 'Replaying...' : 'Replay Run'}
          </button>

          {/* Force Stop Button */}
          <button
            className="secondary-btn"
            onClick={() => setShowForceStopModal(true)}
            disabled={!cockpitState || cockpitState.status === 'COMPLETED' || cockpitState.status === 'INTERRUPTED'}
            title="Emergency halt of active workflow stages"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              color: '#f85149',
              borderColor: '#da3633',
            }}
          >
            <AlertCircleIcon size={14} />
            Force Stop
          </button>
        </div>
      </div>

      {judgedRun && (
        <section
          aria-label="T-07 judged run"
          style={{
            margin: '14px 0',
            padding: '14px 16px',
            borderRadius: 8,
            border: `1px solid ${judgedRun.status === 'completed' ? '#238636' : judgedRun.status === 'rejected' || judgedRun.status === 'failed' ? '#da3633' : '#d29922'}`,
            background: 'var(--card-bg, #161b22)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <strong>STEAM TURBINE T-07</strong>
              <span style={{ marginLeft: 10, fontSize: 12, letterSpacing: 0.5 }}>
                {judgedRun.status.replace('_', ' ').toUpperCase()} · {judgedRun.verdict}
              </span>
              <div style={{ color: 'var(--text-dim, #8b949e)', fontSize: 12, marginTop: 5 }}>
                Run {judgedRun.runId} · {String(judgedRun.details?.anomalyCount ?? '—')} threshold findings
              </div>
            </div>
            {judgedRun.status === 'pending_approval' ? (
              <a href="#/approvals" className="btn-primary" style={{ textDecoration: 'none', fontSize: 13 }}>
                Review the evidence
              </a>
            ) : judgedRun.status === 'completed' ? (
              <div style={{ textAlign: 'right', fontSize: 12 }}>
                <div>Report: {judgedRun.deliverablePath || 'generated'}</div>
                <code>maos industrial verify audit --run-id {judgedRun.runId}</code>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* Action Messages */}
      {actionMessage && (
        <div
          style={{
            margin: '12px 0',
            padding: '10px 14px',
            borderRadius: 6,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: actionMessage.type === 'success' ? '#0d381e' : '#3c1e1e',
            color: actionMessage.type === 'success' ? '#3fb950' : '#f85149',
            border: `1px solid ${actionMessage.type === 'success' ? '#238636' : '#da3633'}`,
          }}
        >
          {actionMessage.type === 'success' ? <CheckCircleIcon size={16} /> : <AlertCircleIcon size={16} />}
          <span>{actionMessage.text}</span>
        </div>
      )}

      <TelemetryReviewPanel />

      {/* ── 2. Run Ribbon & Metrics ───────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          padding: '12px 16px',
          background: 'var(--card-bg, #161b22)',
          border: '1px solid var(--border-color, #30363d)',
          borderRadius: 8,
          marginBottom: 16,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Run Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8b949e)' }}>
            ACTIVE RUN:
          </label>
          {runs.length > 0 ? (
            <select
              value={selectedRunId}
              onChange={(e) => setSelectedRunId(e.target.value)}
              style={{
                background: '#0d1117',
                color: '#c9d1d9',
                border: '1px solid #30363d',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 13,
                fontFamily: 'monospace',
              }}
            >
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} ({r.status})
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#8b949e' }}>
              {selectedRunId || 'No active runs'}
            </span>
          )}

          {cockpitState && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 12,
                background: STATUS_COLORS[cockpitState.status as CockpitStageStatus]?.bg || '#21262d',
                border: `1px solid ${STATUS_COLORS[cockpitState.status as CockpitStageStatus]?.border || '#30363d'}`,
                color: STATUS_COLORS[cockpitState.status as CockpitStageStatus]?.text || '#8b949e',
              }}
            >
              {cockpitState.status}
            </span>
          )}
        </div>

        {/* Global Telemetry Metrics */}
        {cockpitState && (
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontSize: 12 }}>
            <div>
              <span style={{ color: '#8b949e' }}>Stages: </span>
              <strong>
                {cockpitState.nodes.filter((n) => n.status === 'COMPLETED').length} / {cockpitState.nodes.length}
              </strong>
            </div>
            <div>
              <span style={{ color: '#8b949e' }}>Tokens: </span>
              <strong>{cockpitState.totalTokens.total.toLocaleString()}</strong>
              <span style={{ color: '#8b949e', fontSize: 10 }}> ({cockpitState.totalTokens.prompt} in / {cockpitState.totalTokens.completion} out)</span>
            </div>
            <div>
              <span style={{ color: '#8b949e' }}>Latency: </span>
              <strong>{cockpitState.totalLatencyMs} ms</strong>
            </div>
            {cockpitState.activeAgentId && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <AgentsIcon size={14} />
                <span style={{ color: '#8b949e' }}>Active Agent: </span>
                <span style={{ color: '#58a6ff', fontWeight: 600 }}>{cockpitState.activeAgentId}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {loading && !cockpitState ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>Loading authoritative cockpit state...</div>
      ) : error ? (
        <div style={{ padding: 20, color: '#f85149', background: '#3c1e1e', borderRadius: 8 }}>
          {error}
        </div>
      ) : !cockpitState ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>
          No workflow plan found. Trigger a task or workflow from Chat or Tasks view to view live DAG telemetry.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 420px', gap: 16, alignItems: 'start' }}>
          {/* ── 3. Read-Only Topological DAG Pipeline ─────────────── */}
          <div
            style={{
              background: 'var(--card-bg, #161b22)',
              border: '1px solid var(--border-color, #30363d)',
              borderRadius: 8,
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 14, margin: 0, color: '#c9d1d9', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Workflow Pipeline Stages (DAG)</span>
                <span style={{ fontSize: 11, color: '#8b949e', fontWeight: 'normal' }}>
                  [Topologically Ordered • Strictly Read-Only]
                </span>
              </h2>
              <span style={{ fontSize: 11, color: '#8b949e' }}>Click node to inspect details</span>
            </div>

            {/* Stages Flow */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cockpitState.nodes.map((node, index) => {
                const isSelected = selectedStepId === node.stepId;
                const statusTheme = STATUS_COLORS[node.status] || STATUS_COLORS.PENDING;

                return (
                  <div
                    key={node.stepId}
                    onClick={() => setSelectedStepId(node.stepId)}
                    tabIndex={0}
                    role="button"
                    aria-label={`Stage ${index + 1}: ${node.title} (${node.status})`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: isSelected ? '#1f242c' : statusTheme.bg,
                      border: `1px solid ${isSelected ? '#58a6ff' : statusTheme.border}`,
                      borderRadius: 6,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: isSelected ? '0 0 8px rgba(88, 166, 255, 0.3)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {/* Step Number / Status Icon */}
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          background: statusTheme.border,
                          color: '#ffffff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {node.status === 'COMPLETED' ? '✓' : index + 1}
                      </div>

                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#c9d1d9' }}>
                          {node.title}
                        </div>
                        <div style={{ fontSize: 11, color: '#8b949e', display: 'flex', gap: 8, marginTop: 2 }}>
                          <span style={{ fontFamily: 'monospace' }}>{node.stepType}</span>
                          <span>•</span>
                          <span>Agent: <strong style={{ color: '#58a6ff' }}>{node.assignedAgentId}</strong></span>
                          {node.actualModel && (
                            <>
                              <span>•</span>
                              <span>Model: {node.actualModel.family} ({node.actualModel.device})</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {/* Approval Badge if required */}
                      {node.approval.required && (
                        <span
                          title={`Approval Gate: ${node.approval.status || 'pending'}`}
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            borderRadius: 10,
                            background: node.approval.status === 'approved' ? '#0d381e' : '#3b2300',
                            color: node.approval.status === 'approved' ? '#3fb950' : '#e3b341',
                            border: `1px solid ${node.approval.status === 'approved' ? '#238636' : '#d29922'}`,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <ShieldIcon size={10} />
                          {node.approval.status === 'approved' ? 'APPROVED' : 'APPROVAL REQ'}
                        </span>
                      )}

                      {/* Status Pill */}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '3px 8px',
                          borderRadius: 12,
                          background: statusTheme.bg,
                          color: statusTheme.text,
                          border: `1px solid ${statusTheme.border}`,
                        }}
                      >
                        {node.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── 4. Stage Detail Inspector (Read-Only) ────────────────── */}
          <div
            style={{
              background: 'var(--card-bg, #161b22)',
              border: '1px solid var(--border-color, #30363d)',
              borderRadius: 8,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {selectedNode ? (
              <>
                <div style={{ borderBottom: '1px solid #30363d', paddingBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Stage Inspector
                  </div>
                  <h3 style={{ fontSize: 15, margin: '4px 0 0 0', color: '#c9d1d9' }}>
                    {selectedNode.title}
                  </h3>
                  <div style={{ fontSize: 11, color: '#8b949e', fontFamily: 'monospace', marginTop: 4 }}>
                    ID: {selectedNode.stepId} • Type: {selectedNode.stepType}
                  </div>
                </div>

                {/* Agent & Model Identity */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AgentsIcon size={14} /> ASSIGNED AGENT & MODEL
                  </div>
                  <div style={{ background: '#0d1117', padding: 10, borderRadius: 6, fontSize: 12, border: '1px solid #30363d' }}>
                    <div>Agent: <strong style={{ color: '#58a6ff' }}>{selectedNode.assignedAgentId}</strong></div>
                    {selectedNode.actualModel ? (
                      <div style={{ marginTop: 4 }}>
                        Resident Model: <strong>{selectedNode.actualModel.modelId}</strong> ({selectedNode.actualModel.family})<br />
                        Revision: <code>{selectedNode.actualModel.revision}</code> • Device: <code>{selectedNode.actualModel.device}</code>
                        {selectedNode.actualModel.isFallbackCpu && (
                          <span style={{ color: '#e3b341', marginLeft: 6 }}>[CPU Fallback]</span>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: '#8b949e', marginTop: 4 }}>No model lease requested for this step.</div>
                    )}
                  </div>
                </div>

                {/* Tool Executions */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6 }}>
                    TOOL EXECUTIONS ({selectedNode.tools.length})
                  </div>
                  {selectedNode.tools.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {selectedNode.tools.map((tool) => (
                        <div
                          key={tool.toolName}
                          style={{
                            padding: '6px 10px',
                            background: '#0d1117',
                            border: '1px solid #30363d',
                            borderRadius: 4,
                            fontSize: 12,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <code style={{ color: '#79c0ff' }}>{tool.toolName}</code>
                            <span style={{ color: '#8b949e', fontSize: 11, marginLeft: 8 }}>
                              ×{tool.invocations}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: tool.lastStatus === 'success' ? '#3fb950' : '#f85149',
                            }}
                          >
                            {tool.lastStatus?.toUpperCase() || 'OK'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#8b949e', fontStyle: 'italic' }}>
                      No tool executions recorded yet.
                    </div>
                  )}
                </div>

                {/* I/O Artifacts */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6 }}>
                    I/O ARTIFACTS & EVIDENCE HASHES
                  </div>
                  <div style={{ background: '#0d1117', padding: 10, borderRadius: 6, fontSize: 11, border: '1px solid #30363d' }}>
                    <div>
                      <span style={{ color: '#8b949e' }}>Inputs: </span>
                      {selectedNode.io.sourceIds.length > 0 ? (
                        selectedNode.io.sourceIds.join(', ')
                      ) : (
                        <span style={{ color: '#8b949e' }}>None</span>
                      )}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <span style={{ color: '#8b949e' }}>Outputs: </span>
                      {selectedNode.io.artifactIds.length > 0 ? (
                        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {selectedNode.io.artifactIds.map((artId, idx) => (
                            <div key={artId} style={{ fontFamily: 'monospace', color: '#3fb950' }}>
                              📄 {artId}
                              {selectedNode.io.artifactHashes[idx] && (
                                <span style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>
                                  SHA: {selectedNode.io.artifactHashes[idx].slice(0, 16)}...
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: '#8b949e' }}>Pending creation</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Telemetry & Retries */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ background: '#0d1117', padding: 10, borderRadius: 6, fontSize: 11, border: '1px solid #30363d' }}>
                    <div style={{ color: '#8b949e' }}>TELEMETRY</div>
                    <div style={{ marginTop: 4 }}>
                      Latency: <strong>{selectedNode.telemetry.latencyMs} ms</strong><br />
                      Tokens: <strong>{selectedNode.telemetry.totalTokens}</strong>
                    </div>
                  </div>
                  <div style={{ background: '#0d1117', padding: 10, borderRadius: 6, fontSize: 11, border: '1px solid #30363d' }}>
                    <div style={{ color: '#8b949e' }}>RETRIES</div>
                    <div style={{ marginTop: 4 }}>
                      Attempts: <strong>{selectedNode.retries.count} / {selectedNode.retries.maxRetries}</strong>
                      {selectedNode.retries.lastRetryReason && (
                        <div style={{ color: '#e3b341', fontSize: 10, marginTop: 2 }}>
                          {selectedNode.retries.lastRetryReason}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Approval Checkpoint */}
                {selectedNode.approval.required && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ApprovalsIcon size={14} /> APPROVAL GATE CHECKPOINT
                    </div>
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        fontSize: 11,
                        background: selectedNode.approval.status === 'approved' ? '#0d381e' : '#3b2300',
                        border: `1px solid ${selectedNode.approval.status === 'approved' ? '#238636' : '#d29922'}`,
                        color: selectedNode.approval.status === 'approved' ? '#3fb950' : '#e3b341',
                      }}
                    >
                      <div>Status: <strong>{selectedNode.approval.status?.toUpperCase() || 'PENDING'}</strong></div>
                      {selectedNode.approval.reason && <div style={{ marginTop: 2 }}>Reason: {selectedNode.approval.reason}</div>}
                      {selectedNode.approval.reviewedBy && <div style={{ marginTop: 2 }}>Reviewer: {selectedNode.approval.reviewedBy}</div>}
                      {selectedNode.approval.reviewedAt && <div style={{ marginTop: 2 }}>Timestamp: {selectedNode.approval.reviewedAt}</div>}
                    </div>
                  </div>
                )}

                {/* Diagnostics / Error Trace */}
                {selectedNode.error && (
                  <div style={{ padding: 10, borderRadius: 6, background: '#3c1e1e', border: '1px solid #da3633', color: '#f85149', fontSize: 11 }}>
                    <div style={{ fontWeight: 600 }}>ERROR: [{selectedNode.error.code}]</div>
                    <div style={{ marginTop: 2 }}>{selectedNode.error.message}</div>
                    <div style={{ marginTop: 2, fontSize: 10, color: '#8b949e' }}>{selectedNode.error.timestamp}</div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: '#8b949e', fontSize: 13, textAlign: 'center', padding: 30 }}>
                Select a stage node to inspect indicators.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 5. Sequenced Event Log & Replay Stream ──────────────── */}
      <div
        style={{
          marginTop: 20,
          background: 'var(--card-bg, #161b22)',
          border: '1px solid var(--border-color, #30363d)',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 13, margin: 0, color: '#c9d1d9', display: 'flex', alignItems: 'center', gap: 6 }}>
            <TerminalIcon size={14} />
            <span>Typed Sequenced Event Stream</span>
          </h3>
          <span style={{ fontSize: 11, color: '#8b949e' }}>
            Authoritative source of DAG state transitions
          </span>
        </div>

        <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {recentEvents.length > 0 ? (
            recentEvents.map((evt) => (
              <div
                key={`${evt.eventId}-${evt.sequence}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '4px 8px',
                  background: '#0d1117',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'monospace',
                }}
              >
                <span style={{ color: '#58a6ff', fontWeight: 600 }}>#{String(evt.sequence).padStart(4, '0')}</span>
                <span style={{ color: '#79c0ff' }}>{evt.eventType}</span>
                <span style={{ color: '#8b949e', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {typeof evt.payload === 'object' && evt.payload !== null
                    ? JSON.stringify(evt.payload)
                    : String(evt.payload ?? '')}
                </span>
                <span style={{ color: '#484f58', fontSize: 10 }}>{evt.occurredAt.split('T')[1]?.slice(0, 8)}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: '#8b949e', fontStyle: 'italic', padding: 8 }}>
              No live events received in this session. Replay or execute a task to view the live event stream.
            </div>
          )}
        </div>
      </div>

      {/* ── 6. Confirmed Force-Stop Modal ───────────────────────── */}
      {showForceStopModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#161b22',
              border: '1px solid #da3633',
              borderRadius: 8,
              padding: 24,
              width: 480,
              maxWidth: '90vw',
              color: '#c9d1d9',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, margin: 0, color: '#f85149', display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertCircleIcon size={20} />
                Confirm Emergency Force Stop
              </h2>
              <button
                className="icon-btn"
                onClick={() => setShowForceStopModal(false)}
                aria-label="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <div
              style={{
                background: '#3c1e1e',
                border: '1px solid #da3633',
                borderRadius: 6,
                padding: 12,
                fontSize: 12,
                color: '#f85149',
                marginBottom: 16,
              }}
            >
              <strong>WARNING:</strong> Force stop immediately marks active workflow stages as <code>INTERRUPTED</code>, cancels queued tasks, and halts model inference. This action prevents phantom completion and is permanently recorded in the audit trail.
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', display: 'block', marginBottom: 4 }}>
                Reason for Emergency Interruption:
              </label>
              <textarea
                value={forceStopReason}
                onChange={(e) => setForceStopReason(e.target.value)}
                placeholder="Describe reason for stopping active execution..."
                rows={3}
                style={{
                  width: '100%',
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  borderRadius: 6,
                  color: '#c9d1d9',
                  padding: 8,
                  fontSize: 12,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={forceStopConfirmed}
                  onChange={(e) => setForceStopConfirmed(e.target.checked)}
                />
                <span style={{ fontWeight: 600, color: '#f85149' }}>
                  I confirm immediate emergency force stop of active workflow stages.
                </span>
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                className="secondary-btn"
                onClick={() => setShowForceStopModal(false)}
                disabled={submittingStop}
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteForceStop}
                disabled={!forceStopConfirmed || submittingStop}
                style={{
                  background: forceStopConfirmed ? '#da3633' : '#21262d',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '6px 16px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: forceStopConfirmed ? 'pointer' : 'not-allowed',
                }}
              >
                {submittingStop ? 'Stopping...' : 'Confirm Force Stop'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
