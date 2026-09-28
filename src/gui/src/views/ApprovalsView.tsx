import React, { useEffect, useState, useMemo } from 'react';
import { ApprovalsIcon, CheckCircleIcon, AlertCircleIcon } from '../components/icons';
import { apiAdapter } from '../api';
import type {
  ApprovalRecord,
  ApprovalScope,
  ForceStopResult,
} from '../../../domain/approval';
import type { ApprovalStatus } from '../../../domain/schemas';
import {
  VALID_APPROVAL_SCOPES,
  AUTHORIZED_HUMAN_ROLES,
} from '../../../domain/approval';

const SCOPE_LABELS: Record<ApprovalScope, string> = {
  docx_generation: 'DOCX Generation',
  xlsx_generation: 'XLSX Generation',
  pptx_generation: 'PPTX Generation',
  safety_verdict: 'Safety Verdict',
  artifact_overwrite: 'Artifact Overwrite',
  force_stop: 'Force Stop',
  reviewer_signoff: 'Reviewer Sign-off',
  project_scoped_write: 'Project Write',
};

const SCOPE_COLORS: Record<ApprovalScope, string> = {
  docx_generation: '#2b579a',
  xlsx_generation: '#217346',
  pptx_generation: '#b7472a',
  safety_verdict: '#cf222e',
  artifact_overwrite: '#d29922',
  force_stop: '#fa4549',
  reviewer_signoff: '#8957e5',
  project_scoped_write: '#1f6feb',
};

export const ApprovalsView: React.FC = () => {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Review Modal State
  const [activeReviewApproval, setActiveReviewApproval] = useState<ApprovalRecord | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'approved' | 'rejected'>('approved');
  const [reviewerId, setReviewerId] = useState<string>('operator_lead');
  const [reviewerRole, setReviewerRole] = useState<string>('reviewer');
  const [reviewNotes, setReviewNotes] = useState<string>('');
  const [reviewConditions, setReviewConditions] = useState<string>('');
  const [submittingReview, setSubmittingReview] = useState<boolean>(false);

  // Force Stop Modal State
  const [showForceStopModal, setShowForceStopModal] = useState<boolean>(false);
  const [forceStopTaskId, setForceStopTaskId] = useState<string>('');
  const [forceStopRunId, setForceStopRunId] = useState<string>('');
  const [forceStopProjectId, setForceStopProjectId] = useState<string>('default');
  const [forceStopReason, setForceStopReason] = useState<string>('');
  const [forceStopApprovalId, setForceStopApprovalId] = useState<string>('');
  const [forceStopConfirmed, setForceStopConfirmed] = useState<boolean>(false);
  const [submittingForceStop, setSubmittingForceStop] = useState<boolean>(false);
  const [forceStopResult, setForceStopResult] = useState<ForceStopResult | null>(null);

  const fetchApprovals = async () => {
    setLoading(true);
    setError(null);
    try {
      const filters = statusFilter !== 'all' ? { status: statusFilter } : undefined;
      const result = await apiAdapter.getApprovals(filters);
      setApprovals(result);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to fetch approvals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovals();
  }, [statusFilter]);

  const openReviewModal = (approval: ApprovalRecord, defaultDecision: 'approved' | 'rejected' = 'approved') => {
    setActiveReviewApproval(approval);
    setReviewDecision(defaultDecision);
    setReviewNotes('');
    setReviewConditions('');
    setActionError(null);
  };

  const closeReviewModal = () => {
    setActiveReviewApproval(null);
    setSubmittingReview(false);
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReviewApproval) return;

    if (reviewDecision === 'rejected' && (!reviewNotes || reviewNotes.trim().length < 3)) {
      setActionError('A justification of at least 3 characters is required to reject an approval.');
      return;
    }

    setSubmittingReview(true);
    setActionError(null);

    try {
      const conds = reviewConditions
        .split('\n')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      await apiAdapter.reviewApproval(activeReviewApproval.approvalId, {
        decision: reviewDecision,
        actorId: reviewerId,
        actorRole: reviewerRole,
        notes: reviewNotes || undefined,
        conditions: conds.length > 0 ? conds : undefined,
      });

      let successText = `Approval ${activeReviewApproval.approvalId} successfully ${reviewDecision} by ${reviewerId}.`;
      if (activeReviewApproval.metadata?.kind === 'maos-industrial-judged-run') {
        window.localStorage.setItem('maos:last-industrial-judged-run', activeReviewApproval.runId);
        const run = await apiAdapter.getIndustrialJudgedRun(activeReviewApproval.runId);
        successText = reviewDecision === 'approved' && run.status === 'completed'
          ? `Approved by ${reviewerId}. Report generated for ${run.runId}: ${run.deliverablePath}.`
          : `Approval ${reviewDecision} by ${reviewerId}. T-07 run ${run.runId} is ${run.status.replace('_', ' ')}.`;
      }
      setActionSuccess(successText);
      closeReviewModal();
      await fetchApprovals();
    } catch (err: unknown) {
      setActionError((err as Error).message || `Failed to submit review decision`);
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleExecuteForceStop = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forceStopConfirmed) {
      setActionError('Explicit confirmation checkbox is mandatory for force-stop execution.');
      return;
    }

    if (!forceStopTaskId.trim()) {
      setActionError('Task ID is required for force stop.');
      return;
    }

    setSubmittingForceStop(true);
    setActionError(null);

    try {
      const res = await apiAdapter.forceStop({
        taskId: forceStopTaskId.trim(),
        runId: forceStopRunId.trim() || 'default',
        projectId: forceStopProjectId.trim() || 'default',
        confirm: forceStopConfirmed,
        reason: forceStopReason.trim() || 'Administrative force-stop',
        actorId: reviewerId,
        approvalId: forceStopApprovalId.trim() || undefined,
      });

      setForceStopResult(res);
      setActionSuccess(`Task ${res.taskId} successfully halted (status: ${res.status}). No phantom success can occur.`);
      setShowForceStopModal(false);
      setForceStopTaskId('');
      setForceStopReason('');
      setForceStopConfirmed(false);
      await fetchApprovals();
    } catch (err: unknown) {
      setActionError((err as Error).message || 'Failed to execute force-stop');
    } finally {
      setSubmittingForceStop(false);
    }
  };

  // Filtered list
  const filteredApprovals = useMemo(() => {
    return approvals.filter((app) => {
      if (scopeFilter !== 'all' && app.scope !== scopeFilter) return false;
      if (statusFilter !== 'all' && app.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchId = app.approvalId.toLowerCase().includes(q);
        const matchTask = app.taskId.toLowerCase().includes(q);
        const matchActor = app.actorId.toLowerCase().includes(q);
        const matchReason = app.reason.toLowerCase().includes(q);
        if (!matchId && !matchTask && !matchActor && !matchReason) return false;
      }
      return true;
    });
  }, [approvals, scopeFilter, statusFilter, searchQuery]);

  const pendingCount = useMemo(() => {
    return approvals.filter((a) => a.status === 'pending').length;
  }, [approvals]);

  return (
    <div className="view-container" role="tabpanel" aria-label="Approvals Queue View" style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="view-title" style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
              Governance & Human-in-the-Loop Approvals
            </h1>
            {pendingCount > 0 && (
              <span
                style={{
                  backgroundColor: 'var(--status-yellow, #d29922)',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 12,
                }}
              >
                {pendingCount} Pending
              </span>
            )}
          </div>
          <p className="view-desc" style={{ marginTop: 6, color: 'var(--muted, #8b949e)', fontSize: 13 }}>
            Deterministic governance gating for document generation (DOCX/XLSX/PPTX), safety verdicts, artifact overwrites, and force-stops.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn-secondary"
            onClick={() => setShowForceStopModal(true)}
            style={{ borderColor: 'var(--status-red, #f85149)', color: 'var(--status-red, #f85149)' }}
          >
            Force-Stop Execution
          </button>
          <button className="btn-secondary" onClick={fetchApprovals} disabled={loading} aria-label="Refresh approvals">
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Notifications */}
      {actionSuccess && (
        <div
          className="state-box"
          style={{ borderColor: 'var(--status-green, #2ea043)', backgroundColor: 'rgba(46,160,67,0.1)', marginBottom: 16, padding: 12 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--status-green, #2ea043)', fontSize: 13, fontWeight: 600 }}>{actionSuccess}</span>
            <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setActionSuccess(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div
          className="state-box"
          style={{ borderColor: 'var(--status-red, #f85149)', backgroundColor: 'rgba(248,81,73,0.1)', marginBottom: 16, padding: 12 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--status-red, #f85149)', fontSize: 13, fontWeight: 600 }}>{actionError}</span>
            <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Filters Toolbar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          backgroundColor: 'var(--bg-secondary, #161b22)',
          border: '1px solid var(--border, #30363d)',
          borderRadius: 6,
          padding: '10px 14px',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted, #8b949e)' }}>Status:</span>
          {(['all', 'pending', 'approved', 'rejected', 'expired'] as const).map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={statusFilter === st ? 'btn-primary' : 'btn-secondary'}
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 12,
                textTransform: 'capitalize',
              }}
            >
              {st}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted, #8b949e)' }}>Scope:</span>
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: 12,
              borderRadius: 4,
              backgroundColor: 'var(--bg-primary, #0d1117)',
              color: 'var(--fg-primary, #c9d1d9)',
              border: '1px solid var(--border, #30363d)',
            }}
          >
            <option value="all">All Scopes</option>
            {VALID_APPROVAL_SCOPES.map((sc) => (
              <option key={sc} value={sc}>
                {SCOPE_LABELS[sc] || sc}
              </option>
            ))}
          </select>
        </div>

        <div>
          <input
            type="text"
            placeholder="Search approvals..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 4,
              width: 180,
              backgroundColor: 'var(--bg-primary, #0d1117)',
              color: 'var(--fg-primary, #c9d1d9)',
              border: '1px solid var(--border, #30363d)',
            }}
          />
        </div>
      </div>

      {/* Main List Area */}
      {loading && approvals.length === 0 ? (
        <div className="state-box">
          <div className="state-title">Loading Approvals...</div>
          <p className="state-message">Querying authoritative approval records from <code>/api/v1/approvals</code></p>
        </div>
      ) : error ? (
        <div className="state-box" style={{ borderColor: 'var(--status-red, #f85149)' }}>
          <div className="state-title" style={{ color: 'var(--status-red, #f85149)' }}>Error Loading Approvals</div>
          <p className="state-message">{error}</p>
          <button className="btn-secondary" onClick={fetchApprovals}>Retry</button>
        </div>
      ) : filteredApprovals.length === 0 ? (
        <div className="state-box">
          <ApprovalsIcon size={40} className="state-icon" />
          <div className="state-title">No Approvals Matching Filter</div>
          <p className="state-message">
            Zero approvals found under the selected filters. Any privileged action requiring authorization will appear here in real time.
          </p>
          <span className="state-badge">REST ENDPOINT: /api/v1/approvals</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filteredApprovals.map((app) => {
            const isExpired = app.status === 'expired' || (app.status === 'pending' && Date.now() > Date.parse(app.expiresAt));
            const statusLabel = isExpired && app.status === 'pending' ? 'EXPIRED' : app.status.toUpperCase();
            const scopeColor = SCOPE_COLORS[app.scope] || '#8957e5';
            const isJudgedRun = app.metadata?.kind === 'maos-industrial-judged-run';
            const judgedFindings = Array.isArray(app.metadata?.findings)
              ? app.metadata.findings as Array<{ row?: number; timestamp?: string; field?: string; value?: number; threshold?: number; unit?: string; verdict?: string }>
              : [];
            const judgedSources = app.metadata?.sourceFiles && typeof app.metadata.sourceFiles === 'object'
              ? Object.entries(app.metadata.sourceFiles as Record<string, { sha256?: string }>)
              : [];
            const judgedRms = app.metadata?.overallRms;

            return (
              <div
                key={app.approvalId}
                className="state-box"
                style={{
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  border: `1px solid ${app.status === 'pending' ? 'var(--border-active, #58a6ff)' : 'var(--border, #30363d)'}`,
                  backgroundColor: 'var(--bg-secondary, #161b22)',
                  padding: 16,
                  borderRadius: 6,
                }}
              >
                {/* Header Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        backgroundColor: scopeColor,
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 4,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                      }}
                    >
                      {SCOPE_LABELS[app.scope] || app.scope}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      <code>{app.approvalId}</code>
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      className="state-badge"
                      style={{
                        backgroundColor:
                          app.status === 'approved'
                            ? 'rgba(46,160,67,0.2)'
                            : app.status === 'rejected'
                            ? 'rgba(248,81,73,0.2)'
                            : isExpired
                            ? 'rgba(209,213,219,0.2)'
                            : 'rgba(210,153,34,0.2)',
                        color:
                          app.status === 'approved'
                            ? 'var(--status-green, #2ea043)'
                            : app.status === 'rejected'
                            ? 'var(--status-red, #f85149)'
                            : isExpired
                            ? 'var(--muted, #8b949e)'
                            : 'var(--status-yellow, #d29922)',
                        fontWeight: 700,
                      }}
                    >
                      {statusLabel}
                    </span>
                    {app.consumed && (
                      <span
                        style={{
                          fontSize: 10,
                          backgroundColor: 'var(--border, #30363d)',
                          padding: '2px 6px',
                          borderRadius: 4,
                          color: 'var(--muted, #8b949e)',
                        }}
                      >
                        CONSUMED
                      </span>
                    )}
                  </div>
                </div>

                {/* Justification / Reason */}
                <div style={{ fontSize: 14, fontWeight: 500, marginTop: 10, color: 'var(--fg-primary, #c9d1d9)' }}>
                  {app.reason}
                </div>

                {isJudgedRun && (
                  <div style={{ marginTop: 10, padding: '10px 12px', backgroundColor: 'var(--bg-primary, #0d1117)', borderRadius: 4, width: '100%', boxSizing: 'border-box' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                      T-07 pre-review findings · overall RMS {typeof judgedRms === 'number' ? `${judgedRms.toFixed(3)} mm/s` : 'not available'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted, #8b949e)' }}>
                      The report has not been generated. Review these source-derived threshold findings before deciding.
                    </div>
                    {judgedFindings.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                        {judgedFindings.slice(0, 12).map((finding, index) => (
                          <li key={`${finding.row}-${finding.field}-${index}`}>
                            Row {finding.row} · {finding.timestamp} · {finding.field}: {finding.value} {finding.unit} (limit {finding.threshold} {finding.unit}) · {finding.verdict}
                          </li>
                        ))}
                        {judgedFindings.length > 12 && <li>…and {judgedFindings.length - 12} more findings</li>}
                      </ul>
                    )}
                  </div>
                )}

                {/* Identity Metadata Grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 8,
                    marginTop: 12,
                    fontSize: 11,
                    color: 'var(--muted, #8b949e)',
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    padding: '8px 12px',
                    borderRadius: 4,
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <div>
                    <strong>Project:</strong> <code>{app.projectId}</code>
                  </div>
                  <div>
                    <strong>Run ID:</strong> <code>{app.runId}</code>
                  </div>
                  <div>
                    <strong>Task ID:</strong> <code>{app.taskId}</code>
                  </div>
                  <div>
                    <strong>Step ID:</strong> <code>{app.stepId}</code>
                  </div>
                  <div>
                    <strong>Requester:</strong> <code>{app.actorId}</code> ({app.actorRole})
                  </div>
                  <div>
                    <strong>Expires:</strong> {new Date(app.expiresAt).toLocaleTimeString()}
                  </div>
                </div>

                {/* Cryptographic Hash Integrity Block */}
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 11,
                    color: 'var(--muted, #8b949e)',
                    width: '100%',
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    padding: '8px 12px',
                    borderRadius: 4,
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>Payload SHA-256:</strong>{' '}
                      <code style={{ fontSize: 10, color: 'var(--status-blue, #58a6ff)' }}>
                        {app.payloadHash.substring(0, 16)}...{app.payloadHash.substring(48)}
                      </code>
                    </div>
                    <div>
                      <strong>Source Hashes:</strong> {app.sourceHashes.length} attached
                    </div>
                    {app.artifactIds.length > 0 && (
                      <div>
                        <strong>Artifacts:</strong> {app.artifactIds.join(', ')}
                      </div>
                    )}
                  </div>
                  {judgedSources.length > 0 && (
                    <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
                      {judgedSources.map(([sourcePath, source]) => (
                        <div key={sourcePath}><strong>{sourcePath}:</strong> <code>{source.sha256}</code></div>
                      ))}
                    </div>
                  )}
                  {isExpired && (
                    <div style={{ color: 'var(--status-red, #f85149)', marginTop: 4, fontWeight: 600 }}>
                      Warning: Approval has passed expiration timestamp and cannot be decided or executed.
                    </div>
                  )}
                </div>

                {/* Review Verdict (if reviewed) */}
                {app.reviewedBy && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 12px',
                      borderRadius: 4,
                      backgroundColor: 'rgba(255,255,255,0.03)',
                      border: '1px solid var(--border, #30363d)',
                      width: '100%',
                      boxSizing: 'border-box',
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <strong>Reviewed By:</strong> <code>{app.reviewedBy}</code> ({app.reviewRole || 'reviewer'}) at{' '}
                      {app.reviewedAt ? new Date(app.reviewedAt).toLocaleString() : 'N/A'}
                    </div>
                    {app.reviewNotes && (
                      <div style={{ marginTop: 4 }}>
                        <strong>Notes:</strong> {app.reviewNotes}
                      </div>
                    )}
                    {app.conditions && app.conditions.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <strong>Conditions:</strong> {app.conditions.join(', ')}
                      </div>
                    )}
                  </div>
                )}

                {/* Actions (for pending approvals) */}
                {app.status === 'pending' && !isExpired && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                    <button
                      className="btn-primary"
                      style={{ backgroundColor: 'var(--status-green, #2ea043)' }}
                      onClick={() => openReviewModal(app, 'approved')}
                    >
                      <CheckCircleIcon size={14} /> Review & Approve
                    </button>
                    <button
                      className="btn-secondary"
                      style={{ color: 'var(--status-red, #f85149)', borderColor: 'var(--status-red, #f85149)' }}
                      onClick={() => openReviewModal(app, 'rejected')}
                    >
                      <AlertCircleIcon size={14} /> Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Review Modal */}
      {activeReviewApproval && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-secondary, #161b22)',
              border: '1px solid var(--border, #30363d)',
              borderRadius: 8,
              padding: 24,
              width: 520,
              maxWidth: '90%',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
          >
            <h2 style={{ margin: '0 0 12px 0', fontSize: 18 }}>
              Governance Review: {activeReviewApproval.approvalId}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--muted, #8b949e)', marginBottom: 16 }}>
              Scope: <strong>{SCOPE_LABELS[activeReviewApproval.scope] || activeReviewApproval.scope}</strong> | Requester:{' '}
              <code>{activeReviewApproval.actorId}</code> ({activeReviewApproval.actorRole})
            </p>

            <form onSubmit={handleSubmitReview}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Verdict Decision</label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="radio"
                      name="decision"
                      value="approved"
                      checked={reviewDecision === 'approved'}
                      onChange={() => setReviewDecision('approved')}
                    />
                    Approve
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--status-red, #f85149)' }}>
                    <input
                      type="radio"
                      name="decision"
                      value="rejected"
                      checked={reviewDecision === 'rejected'}
                      onChange={() => setReviewDecision('rejected')}
                    />
                    Reject
                  </label>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Reviewer ID</label>
                  <input
                    type="text"
                    required
                    value={reviewerId}
                    onChange={(e) => setReviewerId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      backgroundColor: 'var(--bg-primary, #0d1117)',
                      color: 'var(--fg-primary, #c9d1d9)',
                      border: '1px solid var(--border, #30363d)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Reviewer Role</label>
                  <select
                    value={reviewerRole}
                    onChange={(e) => setReviewerRole(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      backgroundColor: 'var(--bg-primary, #0d1117)',
                      color: 'var(--fg-primary, #c9d1d9)',
                      border: '1px solid var(--border, #30363d)',
                      boxSizing: 'border-box',
                    }}
                  >
                    {AUTHORIZED_HUMAN_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Review Notes / Justification {reviewDecision === 'rejected' && <span style={{ color: 'var(--status-red, #f85149)' }}>* (Required)</span>}
                </label>
                <textarea
                  rows={3}
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder={reviewDecision === 'rejected' ? 'Mandatory explanation for rejection...' : 'Optional approval notes...'}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 12,
                    borderRadius: 4,
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    color: 'var(--fg-primary, #c9d1d9)',
                    border: '1px solid var(--border, #30363d)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {reviewDecision === 'approved' && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    Conditions (one per line, optional)
                  </label>
                  <textarea
                    rows={2}
                    value={reviewConditions}
                    onChange={(e) => setReviewConditions(e.target.value)}
                    placeholder="Must complete within 10 minutes..."
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      backgroundColor: 'var(--bg-primary, #0d1117)',
                      color: 'var(--fg-primary, #c9d1d9)',
                      border: '1px solid var(--border, #30363d)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button type="button" className="btn-secondary" onClick={closeReviewModal} disabled={submittingReview}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={submittingReview}
                  style={{
                    backgroundColor:
                      reviewDecision === 'approved' ? 'var(--status-green, #2ea043)' : 'var(--status-red, #f85149)',
                  }}
                >
                  {submittingReview ? 'Submitting...' : reviewDecision === 'approved' ? 'Confirm Approval' : 'Confirm Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Force-Stop Modal */}
      {showForceStopModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-secondary, #161b22)',
              border: '1px solid var(--status-red, #f85149)',
              borderRadius: 8,
              padding: 24,
              width: 520,
              maxWidth: '90%',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
          >
            <h2 style={{ margin: '0 0 8px 0', fontSize: 18, color: 'var(--status-red, #f85149)' }}>
              Emergency Force-Stop Execution
            </h2>
            <p style={{ fontSize: 12, color: 'var(--muted, #8b949e)', marginBottom: 16 }}>
              Immediately aborts execution, interrupts queue leases, and guarantees that no phantom success can be recorded.
            </p>

            <form onSubmit={handleExecuteForceStop}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Target Task ID *</label>
                <input
                  type="text"
                  required
                  placeholder="task_123..."
                  value={forceStopTaskId}
                  onChange={(e) => setForceStopTaskId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: 12,
                    borderRadius: 4,
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    color: 'var(--fg-primary, #c9d1d9)',
                    border: '1px solid var(--border, #30363d)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Run ID</label>
                  <input
                    type="text"
                    value={forceStopRunId}
                    onChange={(e) => setForceStopRunId(e.target.value)}
                    placeholder="default"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      backgroundColor: 'var(--bg-primary, #0d1117)',
                      color: 'var(--fg-primary, #c9d1d9)',
                      border: '1px solid var(--border, #30363d)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Project ID</label>
                  <input
                    type="text"
                    value={forceStopProjectId}
                    onChange={(e) => setForceStopProjectId(e.target.value)}
                    placeholder="default"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      borderRadius: 4,
                      backgroundColor: 'var(--bg-primary, #0d1117)',
                      color: 'var(--fg-primary, #c9d1d9)',
                      border: '1px solid var(--border, #30363d)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Reason for Force-Stop *</label>
                <input
                  type="text"
                  required
                  placeholder="Safety violation, runaway model loop, etc."
                  value={forceStopReason}
                  onChange={(e) => setForceStopReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: 12,
                    borderRadius: 4,
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    color: 'var(--fg-primary, #c9d1d9)',
                    border: '1px solid var(--border, #30363d)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Approval ID (Optional)</label>
                <input
                  type="text"
                  placeholder="appr_..."
                  value={forceStopApprovalId}
                  onChange={(e) => setForceStopApprovalId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: 12,
                    borderRadius: 4,
                    backgroundColor: 'var(--bg-primary, #0d1117)',
                    color: 'var(--fg-primary, #c9d1d9)',
                    border: '1px solid var(--border, #30363d)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div
                style={{
                  marginBottom: 16,
                  padding: 10,
                  borderRadius: 4,
                  backgroundColor: 'rgba(248,81,73,0.1)',
                  border: '1px solid var(--status-red, #f85149)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg-primary, #c9d1d9)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={forceStopConfirmed}
                    onChange={(e) => setForceStopConfirmed(e.target.checked)}
                  />
                  <span>
                    <strong>I confirm this force-stop:</strong> Task execution will be aborted immediately and cannot report success.
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowForceStopModal(false)}
                  disabled={submittingForceStop}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!forceStopConfirmed || submittingForceStop}
                  style={{ backgroundColor: 'var(--status-red, #f85149)' }}
                >
                  {submittingForceStop ? 'Halting...' : 'Execute Force-Stop'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
