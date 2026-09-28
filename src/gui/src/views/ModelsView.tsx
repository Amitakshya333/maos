import React, { useEffect, useState, useCallback } from 'react';
import { ModelsIcon } from '../components/icons';
import { apiAdapter } from '../api';
import type { ModelLease } from '../../../domain/schemas';
import type { ModelRegistration, ModelResidencyStatus } from '../../../domain/model-manifest';
import type { QueueEntry, QueueStatusSummary } from '../../../domain/fair-queue';
import type {
  ActiveModelIdentity,
  ModelRouteResult,
} from '../../../domain/model-switch';

export const ModelsView: React.FC = () => {
  const [leases, setLeases] = useState<ModelLease[]>([]);
  const [manifest, setManifest] = useState<ModelRegistration[]>([]);
  const [residency, setResidency] = useState<ModelResidencyStatus | null>(null);
  const [activeModel, setActiveModel] = useState<ActiveModelIdentity | null>(null);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatusSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Model Switcher state
  const [routeModality, setRouteModality] = useState<string>('text');
  const [routeHasImages, setRouteHasImages] = useState<boolean>(false);
  const [routePrompt, setRoutePrompt] = useState<string>('');
  const [routeResult, setRouteResult] = useState<ModelRouteResult | null>(null);
  const [targetModelId, setTargetModelId] = useState<string>('Qwen/Qwen2.5-3B-Instruct');
  const [switchActor, setSwitchActor] = useState<string>('gui_operator');
  const [switchReason, setSwitchReason] = useState<string>('');
  const [switchConfirmed, setSwitchConfirmed] = useState<boolean>(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchFeedback, setSwitchFeedback] = useState<string | null>(null);
  const [switchConfirmPrompt, setSwitchConfirmPrompt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [leasesResult, statusResult, modelsResult, queueResult, qStatusResult, activeResult] = await Promise.all([
        apiAdapter.getModelLeases(),
        apiAdapter.getModelResidencyStatus().catch(() => null),
        apiAdapter.getModels().catch(() => null),
        apiAdapter.getQueueEntries().catch(() => []),
        apiAdapter.getQueueStatus().catch(() => null),
        apiAdapter.getActiveModelIdentity().catch(() => null),
      ]);

      setLeases(leasesResult || []);
      setQueueEntries(queueResult || []);
      if (qStatusResult) {
        setQueueStatus(qStatusResult);
      }
      if (statusResult) {
        setResidency(statusResult);
      }
      if (activeResult) {
        setActiveModel(activeResult);
        if (activeResult.modelId) {
          setTargetModelId(activeResult.modelId);
        }
      }
      if (modelsResult) {
        if (modelsResult.registeredModels && Array.isArray(modelsResult.registeredModels)) {
          setManifest(modelsResult.registeredModels);
        } else if (Array.isArray(modelsResult)) {
          // Map array if registeredModels not present
          setManifest(
            modelsResult.map((m: any) => ({
              modelId: m.id || m.name,
              modelName: m.name,
              revision: m.revision || '',
              architecture: 'unknown',
              quantization: 'unknown',
              vramRequiredMb: 0,
              device: m.device || 'cpu',
              port: 11434,
              isHealthy: true,
            })),
          );
        }
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to fetch model manager state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      apiAdapter.getModelLeases().then(setLeases).catch(() => {});
      apiAdapter.getModelResidencyStatus().then(setResidency).catch(() => {});
      apiAdapter.getQueueEntries().then(setQueueEntries).catch(() => {});
      apiAdapter.getQueueStatus().then(setQueueStatus).catch(() => {});
      apiAdapter.getActiveModelIdentity().then(setActiveModel).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleAutoRoute = async () => {
    setActionLoading('route');
    setError(null);
    setSwitchError(null);
    try {
      const res = await apiAdapter.routeModel({
        modality: routeModality,
        hasImages: routeHasImages,
        promptText: routePrompt,
      });
      setRouteResult(res);
      setTargetModelId(res.selectedModelId);
    } catch (err: unknown) {
      setSwitchError((err as Error).message || 'Auto-routing failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleExecuteSwitch = async (forceConfirmed?: boolean) => {
    setActionLoading('switch');
    setSwitchError(null);
    setSwitchFeedback(null);
    setSwitchConfirmPrompt(null);
    try {
      const isConfirmed = forceConfirmed ?? switchConfirmed;
      const res = await apiAdapter.switchModel({
        targetModelId,
        actor: switchActor.trim() || 'gui_operator',
        reason: switchReason.trim() || 'Operator initiated switch from GUI cockpit',
        confirmed: isConfirmed,
      });

      if (res.status === 'CONFIRMATION_REQUIRED') {
        setSwitchConfirmPrompt(res.message);
      } else {
        setSwitchFeedback(res.message);
        setSwitchConfirmed(false);
        await fetchData();
      }
    } catch (err: unknown) {
      setSwitchError((err as Error).message || 'Model switch failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelQueue = async (id: string) => {
    setActionLoading(`cancel_${id}`);
    setFeedback(null);
    try {
      await apiAdapter.cancelQueueEntry(id, { entryId: id, reason: 'Cancelled from GUI Cockpit' });
      setFeedback(`Queue entry '${id}' cancelled successfully`);
      await fetchData();
    } catch (err: unknown) {
      setError((err as Error).message || `Failed to cancel queue entry '${id}'`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRecoverQueue = async () => {
    setActionLoading('recover_queue');
    setFeedback(null);
    try {
      const res = await apiAdapter.recoverQueueState();
      setFeedback(`Recovered queue: interrupted ${res.interruptedCount} stranded task(s)`);
      await fetchData();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to recover queue');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRelease = async (leaseId: string) => {
    setActionLoading(`release_${leaseId}`);
    setFeedback(null);
    try {
      await apiAdapter.releaseModelLease(leaseId);
      setFeedback(`Lease '${leaseId}' released successfully`);
      await fetchData();
    } catch (err: unknown) {
      setError((err as Error).message || `Failed to release lease '${leaseId}'`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReapStale = async () => {
    setActionLoading('reap');
    setFeedback(null);
    try {
      const res = await apiAdapter.reapStaleModelLeases();
      setFeedback(`Reaped ${res.reapedCount} stale lease(s)`);
      await fetchData();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to reap stale leases');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReleaseAll = async () => {
    if (!window.confirm('Are you sure you want to release all active leases and trigger model unload?')) {
      return;
    }
    setActionLoading('release_all');
    setFeedback(null);
    try {
      const res = await apiAdapter.releaseAllModelLeases();
      setFeedback(`Released ${res.releasedCount} lease(s) and triggered model unload`);
      await fetchData();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to release all leases');
    } finally {
      setActionLoading(null);
    }
  };

  const vramPercent = residency && residency.vramBudgetMb > 0
    ? Math.min(100, Math.round((residency.vramUsedMb / residency.vramBudgetMb) * 100))
    : 0;

  return (
    <div className="view-container" role="tabpanel" aria-label="Models & Leases View">
      {/* Header */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="view-title">Model Manager & Leases</h1>
          <p className="view-desc">
            Local model weight residency, exclusive execution leases, VRAM limits, and cold/warm lifecycle management.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={handleReapStale}
            disabled={loading || actionLoading !== null}
            aria-label="Reap stale leases"
          >
            {actionLoading === 'reap' ? 'Reaping...' : 'Reap Stale Leases'}
          </button>
          {leases.length > 0 && (
            <button
              className="btn-secondary"
              onClick={handleReleaseAll}
              disabled={loading || actionLoading !== null}
              style={{ color: 'var(--status-red)' }}
              aria-label="Release all leases"
            >
              {actionLoading === 'release_all' ? 'Releasing...' : 'Release All'}
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={fetchData}
            disabled={loading || actionLoading !== null}
            aria-label="Refresh leases"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {feedback && (
        <div className="alert alert-success" style={{ marginBottom: '16px', padding: '10px 16px', borderRadius: '4px', background: 'rgba(34, 197, 94, 0.1)', color: 'var(--status-green, #22c55e)', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
          {feedback}
        </div>
      )}

      {error && (
        <div className="state-box" style={{ borderColor: 'var(--status-red)', marginBottom: '16px' }}>
          <div className="state-title" style={{ color: 'var(--status-red)' }}>Error</div>
          <p className="state-message">{error}</p>
          <button className="btn-secondary" onClick={fetchData}>Dismiss & Retry</button>
        </div>
      )}

      {/* GPU Residency Cockpit Card */}
      <div
        className="cockpit-card"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ModelsIcon size={22} />
            <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>GPU Residency & VRAM Cockpit</h2>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span
              className="state-badge"
              style={{
                backgroundColor: residency?.healthy === false ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                color: residency?.healthy === false ? 'var(--status-red)' : 'var(--status-green)',
                fontWeight: 600,
              }}
            >
              {residency?.healthy === false ? 'UNHEALTHY' : 'SOVEREIGN / HEALTHY'}
            </span>
            <span className="state-badge">
              {residency?.residentDevice === 'cuda' ? 'DEVICE: CUDA (GPU)' : residency?.residentDevice === 'cpu' ? 'DEVICE: CPU FALLBACK' : 'DEVICE: NONE'}
            </span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          <div style={{ background: 'var(--surface-elevated)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Resident Model</div>
            <div style={{ fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
              {residency?.residentModelId || <span style={{ color: 'var(--text-muted)' }}>None (Unloaded)</span>}
            </div>
            {residency?.residentModelRevision && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                Rev: {residency.residentModelRevision.slice(0, 12)}
              </div>
            )}
          </div>

          <div style={{ background: 'var(--surface-elevated)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Active Leases</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--primary)' }}>
              {residency?.activeLeases ?? leases.length}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Exclusive weight locks
            </div>
          </div>

          <div style={{ background: 'var(--surface-elevated)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Serialized Queue</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: (residency?.queueLength ?? 0) > 0 ? 'var(--status-amber)' : 'var(--text-muted)' }}>
              {residency?.queueLength ?? 0}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Waiting execution requests
            </div>
          </div>

          <div style={{ background: 'var(--surface-elevated)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>VRAM Allocation</div>
            <div style={{ fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
              {residency?.vramUsedMb ?? 0} MB / {residency?.vramBudgetMb ?? 6000} MB
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {vramPercent}% of 6.0 GB budget
            </div>
          </div>
        </div>

        {/* VRAM Meter Bar */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
            <span style={{ color: 'var(--text-muted)' }}>VRAM Utilization (Manifest Budget 6,000 MB)</span>
            <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{vramPercent}%</span>
          </div>
          <div style={{ height: '8px', background: 'var(--surface-elevated)', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${vramPercent}%`,
                height: '100%',
                background: vramPercent > 90 ? 'var(--status-red, #ef4444)' : vramPercent > 70 ? 'var(--status-amber, #f59e0b)' : 'var(--status-green, #22c55e)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      </div>

      {/* Model Switcher & Auto-Routing Cockpit (UI1-13) */}
      <div
        className="cockpit-card"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
        }}
        data-testid="model-switcher-cockpit"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Model Switcher & Auto-Routing</h2>
              {activeModel?.isWorkflowFixed && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    color: 'var(--status-red)',
                    fontWeight: 600,
                  }}
                  data-testid="workflow-locked-badge"
                >
                  🔒 WORKFLOW-FIXED RUN: {activeModel.lockedByRunId || 'ACTIVE'}
                </span>
              )}
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
              Automatic routing based on task modality, or audited manual override with explicit unloaded VRAM confirmation.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span
              className="state-badge"
              style={{
                fontSize: '11px',
                fontWeight: 600,
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                color: 'var(--primary)',
              }}
              data-testid="active-model-badge"
            >
              ACTIVE: {activeModel?.modelId || residency?.residentModelId || 'None'}
            </span>
          </div>
        </div>

        {/* Switch Feedback & Error Banners */}
        {switchFeedback && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid var(--status-green)',
              borderRadius: '6px',
              color: 'var(--status-green)',
              fontSize: '12px',
              marginBottom: '14px',
            }}
            data-testid="switch-feedback-banner"
          >
            ✓ {switchFeedback}
          </div>
        )}

        {switchError && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid var(--status-red)',
              borderRadius: '6px',
              color: 'var(--status-red)',
              fontSize: '12px',
              marginBottom: '14px',
            }}
            data-testid="switch-error-banner"
          >
            ✗ {switchError}
          </div>
        )}

        {switchConfirmPrompt && (
          <div
            style={{
              padding: '14px',
              backgroundColor: 'rgba(245, 158, 11, 0.15)',
              border: '1px solid var(--status-amber)',
              borderRadius: '6px',
              marginBottom: '16px',
            }}
            data-testid="confirmation-prompt-card"
          >
            <div style={{ fontWeight: 600, color: 'var(--status-amber)', fontSize: '13px', marginBottom: '6px' }}>
              ⚠️ Disruptive Model Switch Confirmation Required
            </div>
            <p style={{ fontSize: '12px', margin: '0 0 10px 0', color: 'var(--text)' }}>
              {switchConfirmPrompt}
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn-primary"
                onClick={() => handleExecuteSwitch(true)}
                disabled={actionLoading === 'switch'}
                style={{ fontSize: '12px', padding: '5px 12px', backgroundColor: 'var(--status-amber)', color: '#000' }}
                data-testid="confirm-disruptive-switch-btn"
              >
                {actionLoading === 'switch' ? 'Unloading & Switching...' : 'Confirm Unload & Switch'}
              </button>
              <button
                className="btn-secondary"
                onClick={() => setSwitchConfirmPrompt(null)}
                style={{ fontSize: '12px', padding: '5px 12px' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Section 1: Auto-Routing Evaluation */}
          <div style={{ background: 'var(--surface-elevated)', padding: '16px', borderRadius: '6px' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0' }}>1. Automatic Task Routing</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 12px 0' }}>
              Detects recommended model based on requested modality, visual attachments, or task description.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                  Task Modality
                </label>
                <select
                  value={routeModality}
                  onChange={(e) => setRouteModality(e.target.value)}
                  style={{ width: '100%', padding: '6px', fontSize: '12px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  data-testid="route-modality-select"
                >
                  <option value="text">text (General Reasoning / Code)</option>
                  <option value="vision">vision (OCR / Technical Diagrams)</option>
                  <option value="embedding">embedding (Dense Vector Search)</option>
                  <option value="multimodal">multimodal (Combined Text + Vision)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id="hasImagesCheck"
                  checked={routeHasImages}
                  onChange={(e) => setRouteHasImages(e.target.checked)}
                  data-testid="route-has-images-checkbox"
                />
                <label htmlFor="hasImagesCheck" style={{ fontSize: '12px', cursor: 'pointer' }}>
                  Has Visual Attachments (forces VLM)
                </label>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                  Prompt / Task Hint
                </label>
                <input
                  type="text"
                  value={routePrompt}
                  onChange={(e) => setRoutePrompt(e.target.value)}
                  placeholder="e.g. Inspect schematic drawing for dimensions"
                  style={{ width: '100%', padding: '6px', fontSize: '12px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  data-testid="route-prompt-input"
                />
              </div>

              <button
                className="btn-secondary"
                onClick={handleAutoRoute}
                disabled={actionLoading === 'route'}
                style={{ fontSize: '12px', padding: '6px 12px', marginTop: '4px' }}
                data-testid="evaluate-route-btn"
              >
                {actionLoading === 'route' ? 'Evaluating...' : '⚡ Evaluate Best Route'}
              </button>

              {routeResult && (
                <div
                  style={{
                    marginTop: '8px',
                    padding: '10px',
                    borderRadius: '4px',
                    backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)',
                    fontSize: '11px',
                  }}
                  data-testid="route-result-box"
                >
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>
                    Recommended: {routeResult.selectedModelId}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Device: {routeResult.device.toUpperCase()} ({routeResult.vramRequiredMb} MB) • Confidence: {(routeResult.confidence * 100).toFixed(0)}%
                  </div>
                  <div style={{ color: 'var(--text-dim)' }}>
                    {routeResult.reason}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section 2: Audited Manual Override */}
          <div style={{ background: 'var(--surface-elevated)', padding: '16px', borderRadius: '6px' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px 0' }}>2. Audited Manual Override</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 12px 0' }}>
              Override resident model. Enforces audit actor, rationale, revision checks, and workflow safety.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                  Target Pinned Model
                </label>
                <select
                  value={targetModelId}
                  onChange={(e) => setTargetModelId(e.target.value)}
                  style={{ width: '100%', padding: '6px', fontSize: '12px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  data-testid="target-model-select"
                >
                  {manifest.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.modelId} ({m.device.toUpperCase()} - {m.vramRequiredMb} MB)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                  Audit Actor <span style={{ color: 'var(--status-red)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={switchActor}
                  onChange={(e) => setSwitchActor(e.target.value)}
                  placeholder="e.g. operator_alice"
                  style={{ width: '100%', padding: '6px', fontSize: '12px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  data-testid="switch-actor-input"
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                  Audit Reason / Rationale <span style={{ color: 'var(--status-red)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={switchReason}
                  onChange={(e) => setSwitchReason(e.target.value)}
                  placeholder="e.g. Blueprint inspection requires VLM vision reasoning"
                  style={{ width: '100%', padding: '6px', fontSize: '12px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  data-testid="switch-reason-input"
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id="confirmDisruptiveCheck"
                  checked={switchConfirmed}
                  onChange={(e) => setSwitchConfirmed(e.target.checked)}
                  data-testid="switch-confirm-checkbox"
                />
                <label htmlFor="confirmDisruptiveCheck" style={{ fontSize: '12px', cursor: 'pointer' }}>
                  Pre-confirm disruptive GPU model unload
                </label>
              </div>

              <button
                className="btn-primary"
                onClick={() => handleExecuteSwitch()}
                disabled={actionLoading === 'switch' || !switchActor.trim() || !switchReason.trim()}
                style={{ fontSize: '12px', padding: '6px 12px', marginTop: '4px' }}
                data-testid="execute-switch-btn"
              >
                {actionLoading === 'switch' ? 'Switching Model...' : 'Switch Model & Await VRAM'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 4px 0' }}>Pinned Model Manifest</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Authorized offline model snapshots with verified SHA-256 hashes and fixed revisions.
            </p>
          </div>
          <span className="state-badge">PINNED MODEL MANIFEST</span>
        </div>

        {manifest.length === 0 ? (
          <div className="state-box" style={{ padding: '24px' }}>
            <div className="state-title">No Registered Models Loaded</div>
            <p className="state-message">Verifying model registrations from <code>SharedModelManager</code>.</p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table" aria-label="Pinned Models Manifest">
              <thead>
                <tr>
                  <th>Model ID</th>
                  <th>Revision</th>
                  <th>Arch / Quant</th>
                  <th>Device</th>
                  <th>VRAM Req</th>
                  <th>Port</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {manifest.map((m) => {
                  const isResident = residency?.residentModelId === m.modelId;
                  return (
                    <tr key={m.modelId} style={isResident ? { background: 'rgba(59, 130, 246, 0.05)' } : undefined}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span className="font-mono" style={{ fontWeight: 600 }}>{m.modelId}</span>
                          {isResident && (
                            <span
                              style={{
                                fontSize: '10px',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'var(--primary)',
                                color: '#fff',
                                fontWeight: 600,
                              }}
                            >
                              RESIDENT
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="font-mono text-dim" title={m.revision}>
                        {m.revision ? m.revision.slice(0, 10) : 'none'}
                      </td>
                      <td className="font-mono text-dim">
                        {m.architecture} / {m.quantization}
                      </td>
                      <td>
                        <span
                          className="state-badge"
                          style={{
                            fontSize: '10px',
                            backgroundColor: m.device === 'cuda' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(107, 114, 128, 0.1)',
                          }}
                        >
                          {m.device.toUpperCase()}
                        </span>
                      </td>
                      <td className="font-mono text-dim">{m.vramRequiredMb} MB</td>
                      <td className="font-mono text-dim">{m.port}</td>
                      <td>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: m.isHealthy ? 'var(--status-green)' : 'var(--status-red)',
                          }}
                        >
                          {m.isHealthy ? 'HEALTHY' : 'UNHEALTHY'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section: Active Model Leases */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 4px 0' }}>Active Leases</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Project and run-scoped execution leases. Serialized GPU residency prohibits concurrent multi-model VRAM loading.
            </p>
          </div>
          <span className="state-badge">SERIALIZED RESIDENCY</span>
        </div>

        {leases.length === 0 ? (
          <div className="state-box" style={{ padding: '32px' }}>
            <ModelsIcon size={36} className="state-icon" />
            <div className="state-title">No Active Model Leases</div>
            <p className="state-message">
              GPU models are loaded on demand and automatically unloaded after idle timeout. CPU embedding leases do not evict resident GPU models.
            </p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table" aria-label="Model Leases List">
              <thead>
                <tr>
                  <th>Lease ID</th>
                  <th>Model ID</th>
                  <th>Agent</th>
                  <th>Project / Run</th>
                  <th>Device</th>
                  <th>Port</th>
                  <th>Granted At</th>
                  <th>Expires At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {leases.map((lease) => (
                  <tr key={lease.id}>
                    <td className="font-mono" style={{ fontSize: '12px' }}>{lease.id}</td>
                    <td className="font-mono" style={{ fontWeight: 600 }}>{lease.modelId}</td>
                    <td className="font-mono">{lease.agentId}</td>
                    <td className="font-mono text-dim" style={{ fontSize: '11px' }}>
                      {lease.projectId ? (
                        <>
                          <div>Proj: {lease.projectId.slice(0, 12)}</div>
                          {lease.runId && <div>Run: {lease.runId.slice(0, 12)}</div>}
                        </>
                      ) : (
                        'global'
                      )}
                    </td>
                    <td>
                      <span
                        className="state-badge"
                        style={{
                          fontSize: '10px',
                          backgroundColor: lease.device === 'cuda' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(107, 114, 128, 0.1)',
                        }}
                      >
                        {(lease.device || 'cuda').toUpperCase()}
                      </span>
                    </td>
                    <td className="font-mono text-dim">{lease.port}</td>
                    <td className="text-dim font-mono" style={{ fontSize: '11px' }}>
                      {new Date(lease.grantedAt).toLocaleTimeString()}
                    </td>
                    <td className="text-dim font-mono" style={{ fontSize: '11px' }}>
                      {lease.expiresAt ? new Date(lease.expiresAt).toLocaleTimeString() : 'Permanent'}
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        onClick={() => handleRelease(lease.id)}
                        disabled={actionLoading === `release_${lease.id}`}
                        style={{ fontSize: '11px', padding: '4px 8px', color: 'var(--status-red)' }}
                        aria-label={`Release lease ${lease.id}`}
                      >
                        {actionLoading === `release_${lease.id}` ? 'Releasing...' : 'Release'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section: Fair Execution Queue Cockpit (UI1-12) */}
      <div style={{ marginBottom: '32px' }} data-testid="fair-queue-cockpit">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 4px 0' }}>Fair Priority Execution Queue</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Anti-starvation aging (60s), 3-turn chat burst limit, VRAM queue-first residency, and 9 explicit queue states.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-secondary"
              onClick={handleRecoverQueue}
              disabled={loading || actionLoading !== null}
              style={{ fontSize: '12px' }}
              aria-label="Recover stranded queue tasks"
            >
              {actionLoading === 'recover_queue' ? 'Recovering...' : 'Recover Stranded Tasks'}
            </button>
          </div>
        </div>

        {/* Queue Metrics Bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Queued / Waiting</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: (queueStatus?.totalQueued ?? 0) > 0 ? 'var(--primary)' : 'var(--text-muted)' }}>
              {queueStatus?.totalQueued ?? 0}
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Active Running</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: (queueStatus?.activeRunning ?? 0) > 0 ? 'var(--status-green)' : 'var(--text-muted)' }}>
              {queueStatus?.activeRunning ?? 0}
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Waiting for VRAM</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: (queueStatus?.waitingForVram ?? 0) > 0 ? 'var(--status-amber)' : 'var(--text-muted)' }}>
              {queueStatus?.waitingForVram ?? 0}
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Consecutive Chat Turns</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: (queueStatus?.consecutiveChatTurns ?? 0) >= (queueStatus?.maxConsecutiveChatTurns ?? 3) ? 'var(--status-red)' : 'var(--text-muted)' }}>
              {queueStatus?.consecutiveChatTurns ?? 0} / {queueStatus?.maxConsecutiveChatTurns ?? 3}
            </div>
          </div>
        </div>

        {queueEntries.length === 0 ? (
          <div className="state-box" style={{ padding: '32px' }}>
            <div className="state-title">Queue Empty</div>
            <p className="state-message">
              No tasks currently queued or running. Enqueue requests through chat, workflow execution, or background indexing.
            </p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table" aria-label="Fair Execution Queue Table">
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>ID / Task</th>
                  <th>Priority Class</th>
                  <th>Effective</th>
                  <th>State</th>
                  <th>Model / Fallback</th>
                  <th>Age</th>
                  <th>Blocking Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queueEntries.map((entry) => {
                  const isQueued = entry.state === 'queued' || entry.state === 'waiting_for_model_lease' || entry.state === 'waiting_for_vram';
                  const isRunning = entry.state === 'running';
                  const isCancellable = isQueued || isRunning || entry.state === 'cancelling';

                  return (
                    <tr key={entry.id} data-testid={`queue-entry-${entry.id}`}>
                      <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        {entry.queuePosition > 0 ? `#${entry.queuePosition}` : '—'}
                      </td>
                      <td>
                        <div className="font-mono" style={{ fontSize: '12px', fontWeight: 600 }}>{entry.id}</div>
                        {entry.taskId && <div className="text-dim font-mono" style={{ fontSize: '11px' }}>Task: {entry.taskId}</div>}
                        <div className="text-dim font-mono" style={{ fontSize: '11px' }}>Agent: {entry.agentId}</div>
                      </td>
                      <td>
                        <span
                          className="state-badge"
                          style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            backgroundColor:
                              entry.priorityClass === 'interactive_chat'
                                ? 'rgba(59, 130, 246, 0.15)'
                                : entry.priorityClass === 'user_task'
                                ? 'rgba(34, 197, 94, 0.15)'
                                : entry.priorityClass === 'active_workflow'
                                ? 'rgba(245, 158, 11, 0.15)'
                                : 'rgba(156, 163, 175, 0.15)',
                            color:
                              entry.priorityClass === 'interactive_chat'
                                ? 'var(--primary)'
                                : entry.priorityClass === 'user_task'
                                ? 'var(--status-green)'
                                : entry.priorityClass === 'active_workflow'
                                ? 'var(--status-amber)'
                                : 'var(--text-muted)',
                          }}
                        >
                          {entry.priorityClass}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600 }}>P{entry.effectivePriority}</span>
                          {entry.isAged && (
                            <span
                              style={{
                                fontSize: '9px',
                                padding: '1px 5px',
                                borderRadius: '4px',
                                backgroundColor: 'rgba(245, 158, 11, 0.2)',
                                color: 'var(--status-amber)',
                                fontWeight: 700,
                              }}
                            >
                              AGED
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span
                          className="state-badge"
                          style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            backgroundColor:
                              entry.state === 'running'
                                ? 'rgba(34, 197, 94, 0.2)'
                                : entry.state === 'waiting_for_vram'
                                ? 'rgba(217, 119, 6, 0.2)'
                                : entry.state === 'waiting_for_model_lease'
                                ? 'rgba(245, 158, 11, 0.15)'
                                : entry.state === 'queued'
                                ? 'rgba(14, 165, 233, 0.15)'
                                : entry.state === 'completed'
                                ? 'rgba(16, 185, 129, 0.15)'
                                : entry.state === 'failed' || entry.state === 'interrupted'
                                ? 'rgba(239, 68, 68, 0.2)'
                                : 'rgba(113, 113, 122, 0.2)',
                            color:
                              entry.state === 'running'
                                ? 'var(--status-green)'
                                : entry.state === 'waiting_for_vram'
                                ? 'var(--status-amber)'
                                : entry.state === 'waiting_for_model_lease'
                                ? 'var(--status-amber)'
                                : entry.state === 'queued'
                                ? 'var(--primary)'
                                : entry.state === 'completed'
                                ? 'var(--status-green)'
                                : entry.state === 'failed' || entry.state === 'interrupted'
                                ? 'var(--status-red)'
                                : 'var(--text-muted)',
                          }}
                        >
                          {entry.state.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <div className="font-mono" style={{ fontSize: '11px' }}>{entry.requestedModelId}</div>
                        <div className="text-dim" style={{ fontSize: '10px' }}>
                          Device: {entry.requestedDevice} {entry.allowCpuFallback ? '(CPU Fallback OK)' : '(GPU Required)'}
                        </div>
                      </td>
                      <td className="font-mono text-dim" style={{ fontSize: '11px' }}>
                        {entry.ageSeconds}s
                      </td>
                      <td style={{ fontSize: '11px', color: entry.blockingReason ? 'var(--status-amber)' : 'var(--text-muted)' }}>
                        {entry.blockingReason || (entry.failureReason ? `Failed: ${entry.failureReason}` : entry.cancellationReason ? `Cancelled: ${entry.cancellationReason}` : '—')}
                      </td>
                      <td>
                        {isCancellable ? (
                          <button
                            className="btn-secondary"
                            onClick={() => handleCancelQueue(entry.id)}
                            disabled={actionLoading === `cancel_${entry.id}`}
                            style={{ fontSize: '11px', padding: '3px 8px', color: 'var(--status-red)' }}
                            aria-label={`Cancel queue entry ${entry.id}`}
                          >
                            {actionLoading === `cancel_${entry.id}` ? 'Cancelling...' : 'Cancel'}
                          </button>
                        ) : (
                          <span className="text-dim" style={{ fontSize: '11px' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fair Priority & Queue Architecture Notice */}
      <div
        style={{
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '16px',
          fontSize: '12px',
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>
          Fair Priority & Anti-Starvation Guarantees
        </div>
        <div>
          Execution requests are queued with priority classes: <code>interactive_chat</code> (priority 1), <code>user_task</code> (priority 2), <code>active_workflow</code> (priority 3), <code>auto_workflow</code> (priority 4), and <code>background_indexing</code> (priority 5).
          Interactive chat turns are capped at 3 consecutive turns before yielding to workflow tasks.
          Aged requests (&gt;60s) improve priority dynamically. Serialized GPU residency prohibits multiple concurrent GPU models in VRAM.
        </div>
      </div>
    </div>
  );
};
