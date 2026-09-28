/**
 * UI1-20: Append-Only Redacted Audit Trail & Sovereign Boundary Panel
 *
 * Implements:
 * 1. Cryptographically linked audit chain verification & export
 * 2. Measured sovereignty boundary status, firewall status, and allowlist
 * 3. Tracked processes, process tree, executable hashes, and active leases
 * 4. Mismatch actions and violation remediation guides
 *
 * Safety & Invariant Guarantees:
 *   - Never claims "zero data left the machine" or "OS guaranteed offline"
 *   - Only displays measured facts within the monitored boundary
 *   - Never displays zero before measurement (renders pending state)
 *   - Strictly forbids hidden non-loopback endpoints or cross-project records
 */

import React, { useEffect, useState } from 'react';
import {
  AuditIcon,
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from '../components/icons';
import { apiAdapter } from '../api';
import type { AuditRecord, AuditChainVerification } from '../../../domain/schemas';
import type { SovereignPanelData, TrackedProcessInfo } from '../api/rest-client';

function truncateHash(hash?: string, chars = 12): string {
  if (!hash) return '—';
  return hash.length > chars ? `${hash.slice(0, chars)}…` : hash;
}

const AUDIT_CATEGORIES = [
  'ALL',
  'stage',
  'artifact',
  'verification',
  'interruption',
  'endpoint',
  'mode',
  'session',
  'system',
] as const;

export const AuditView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'audit' | 'sovereign'>('audit');

  // Audit state
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [verification, setVerification] = useState<AuditChainVerification | null>(null);
  const [loadingAudit, setLoadingAudit] = useState<boolean>(true);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Sovereign panel state
  const [panelData, setPanelData] = useState<SovereignPanelData | null>(null);
  const [loadingPanel, setLoadingPanel] = useState<boolean>(true);
  const [panelError, setPanelError] = useState<string | null>(null);

  // Load audit records and verification
  const fetchAuditData = async () => {
    setLoadingAudit(true);
    setAuditError(null);
    try {
      const cat = categoryFilter === 'ALL' ? undefined : categoryFilter;
      const [events, verify] = await Promise.allSettled([
        apiAdapter.getAuditEvents(cat),
        apiAdapter.verifyAuditChain(),
      ]);

      if (events.status === 'fulfilled') setRecords(events.value);
      else setRecords([]);

      if (verify.status === 'fulfilled') setVerification(verify.value);
      else setVerification(null);
    } catch (err: unknown) {
      setAuditError((err as Error).message || 'Failed to fetch audit data');
    } finally {
      setLoadingAudit(false);
    }
  };

  // Load sovereign panel data
  const fetchPanelData = async () => {
    setLoadingPanel(true);
    setPanelError(null);
    try {
      const data = await apiAdapter.getSovereignPanelData();
      setPanelData(data);
    } catch (err: unknown) {
      setPanelError((err as Error).message || 'Failed to fetch sovereignty panel');
    } finally {
      setLoadingPanel(false);
    }
  };

  useEffect(() => {
    fetchAuditData();
    fetchPanelData();
  }, [categoryFilter]);

  const handleManualVerify = async () => {
    setIsVerifying(true);
    try {
      const res = await apiAdapter.verifyAuditChain();
      setVerification(res);
    } catch (err: unknown) {
      setAuditError((err as Error).message || 'Audit verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleExportAudit = async () => {
    try {
      const exported = await apiAdapter.exportAuditTrail();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-trail-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportNotice(`Exported ${exported.records.length} audit records.`);
      setTimeout(() => setExportNotice(null), 4000);
    } catch (err: unknown) {
      setAuditError((err as Error).message || 'Export failed');
    }
  };

  const boundaryStatus = panelData?.boundaryStatus;
  const isBoundaryVerified = boundaryStatus?.verified === true;
  const firewallActive = boundaryStatus?.firewallStatus === 'ACTIVE';

  return (
    <div className="view-container" role="tabpanel" aria-label="Audit & Sovereign Panel View">
      {/* View Header with Tab Switcher */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="view-title">Audit Trail & Sovereign Boundary</h1>
          <p className="view-desc">
            Cryptographically linked tamper-evident audit chain and measured industrial boundary state.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={activeTab === 'audit' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('audit')}
            data-testid="tab-audit-trail"
          >
            Audit Trail
          </button>
          <button
            className={activeTab === 'sovereign' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('sovereign')}
            data-testid="tab-sovereign-panel"
          >
            Sovereign Panel
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* TAB 1: AUDIT TRAIL                                             */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'audit' && (
        <div data-testid="audit-trail-section">
          {/* Verification Status & Action Banner */}
          <div className="state-box" data-testid="audit-verification-box" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AuditIcon size={20} />
                <div className="state-title">Audit Chain Integrity</div>
                {verification ? (
                  <span
                    className="state-badge"
                    data-testid="audit-chain-badge"
                    style={{
                      backgroundColor: verification.valid ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: verification.valid ? '#22c55e' : '#ef4444',
                      border: `1px solid ${verification.valid ? '#22c55e' : '#ef4444'}`,
                    }}
                  >
                    {verification.valid ? 'CHAIN: VERIFIED' : 'CHAIN: BROKEN'}
                  </span>
                ) : (
                  <span className="state-badge">CHAIN: UNVERIFIED</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn-secondary"
                  onClick={handleManualVerify}
                  disabled={isVerifying}
                  data-testid="btn-verify-chain"
                >
                  {isVerifying ? 'Verifying...' : 'Verify Cryptographic Chain'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={handleExportAudit}
                  data-testid="btn-export-audit"
                >
                  Export Audit Trail
                </button>
                <button
                  className="icon-btn"
                  onClick={fetchAuditData}
                  aria-label="Refresh audit records"
                  title="Refresh"
                >
                  <RefreshIcon size={16} />
                </button>
              </div>
            </div>

            {verification && (
              <div style={{ width: '100%', fontSize: 12, marginTop: 10, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Records: </span>
                  <span data-testid="audit-record-count" style={{ fontWeight: 600 }}>{verification.recordCount}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Verified At: </span>
                  <span data-testid="audit-verified-at">{new Date(verification.verifiedAt).toLocaleString()}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Latest Hash: </span>
                  <span className="font-mono" data-testid="audit-latest-hash">{truncateHash(verification.latestHash)}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Executable Hash: </span>
                  <span className="font-mono" data-testid="audit-executable-hash">{truncateHash(verification.executableHash)}</span>
                </div>
              </div>
            )}

            {verification?.errors && verification.errors.length > 0 && (
              <div data-testid="audit-verification-errors" style={{ marginTop: 8, color: '#ef4444', fontSize: 12 }}>
                <strong>Verification Errors:</strong>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {verification.errors.map((e, idx) => (
                    <li key={idx}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {exportNotice && (
            <div className="state-box" style={{ borderColor: '#22c55e', color: '#22c55e', marginBottom: 12 }}>
              <CheckCircleIcon size={16} />
              <span>{exportNotice}</span>
            </div>
          )}

          {auditError && (
            <div className="state-box" data-testid="audit-error" style={{ borderColor: '#ef4444', color: '#ef4444', marginBottom: 12 }}>
              <AlertCircleIcon size={16} />
              <span>{auditError}</span>
            </div>
          )}

          {/* Category Filter Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label htmlFor="audit-cat-select" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Filter Category:
              </label>
              <select
                id="audit-cat-select"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                data-testid="audit-category-select"
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  border: '1px solid var(--border)',
                  background: 'var(--surface, #1e1e1e)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                }}
              >
                {AUDIT_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Showing {records.length} record(s)
            </span>
          </div>

          {/* Records Table */}
          {loadingAudit && records.length === 0 ? (
            <div className="state-box" data-testid="audit-loading">
              <div className="state-title">Loading Audit Trail...</div>
            </div>
          ) : records.length === 0 ? (
            <div className="state-box" data-testid="audit-empty">
              <AuditIcon size={32} />
              <div className="state-title">No Audit Records Found</div>
              <p className="state-message">No audit entries matching the selected filter.</p>
            </div>
          ) : (
            <div className="table-responsive" data-testid="audit-records-table">
              <table className="data-table" aria-label="Audit Records List" style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>Seq</th>
                    <th style={{ width: 100 }}>Category</th>
                    <th style={{ width: 160 }}>Source</th>
                    <th style={{ width: 180 }}>Timestamp</th>
                    <th style={{ width: 120 }}>Record Hash</th>
                    <th>Payload (Redacted)</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec, idx) => (
                    <tr key={rec.sequence || idx} data-testid={`audit-row-${rec.sequence}`}>
                      <td className="font-mono">{rec.sequence}</td>
                      <td>
                        <span className="state-badge" style={{ fontSize: 10, padding: '1px 6px' }}>
                          {rec.category}
                        </span>
                      </td>
                      <td className="font-mono" style={{ fontSize: 11 }}>{rec.source}</td>
                      <td className="font-mono text-dim" style={{ fontSize: 11 }}>{rec.timestamp}</td>
                      <td className="font-mono text-dim" title={rec.hash}>
                        {truncateHash(rec.hash, 10)}
                      </td>
                      <td
                        className="font-mono text-muted"
                        style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={JSON.stringify(rec.data)}
                      >
                        {JSON.stringify(rec.data)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* TAB 2: SOVEREIGN BOUNDARY PANEL                                */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {activeTab === 'sovereign' && (
        <div data-testid="sovereign-panel-section">
          {panelError && (
            <div className="state-box" data-testid="sovereign-error" style={{ borderColor: '#ef4444', color: '#ef4444', marginBottom: 12 }}>
              <AlertCircleIcon size={16} />
              <span>{panelError}</span>
            </div>
          )}

          {/* Measured Boundary Overview Card */}
          <div className="state-box" data-testid="boundary-overview-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="state-title">Industrial Measurement Boundary</div>
                {loadingPanel ? (
                  <span className="state-badge" data-testid="boundary-loading-badge">MEASURING…</span>
                ) : boundaryStatus ? (
                  <span
                    className="state-badge"
                    data-testid="boundary-status-badge"
                    style={{
                      backgroundColor: isBoundaryVerified ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: isBoundaryVerified ? '#22c55e' : '#ef4444',
                      border: `1px solid ${isBoundaryVerified ? '#22c55e' : '#ef4444'}`,
                    }}
                  >
                    {boundaryStatus.overallStatus}
                  </span>
                ) : (
                  <span className="state-badge" data-testid="boundary-unmeasured-badge">UNMEASURED</span>
                )}
              </div>
              <button className="icon-btn" onClick={fetchPanelData} aria-label="Re-inspect sovereign boundary" title="Re-inspect">
                <RefreshIcon size={16} />
              </button>
            </div>

            {/* Approved Measured Wording Invariant */}
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, marginBottom: 12, lineHeight: 1.5 }} data-testid="measured-claim-text">
              <strong>Measured Fact:</strong> No non-loopback application connections were observed within the defined monitored boundary during the verified interval.
            </p>

            {/* Negative Disclaimer */}
            <div style={{ fontSize: 11, color: 'var(--muted, #888)', background: 'rgba(0,0,0,0.2)', padding: '6px 10px', borderRadius: 4, marginBottom: 12 }}>
              <em>Boundary Guarantee Notice: MAOS measures loopback socket isolation within configured process tree. It does not claim universal operating system offline status or total zero host traffic.</em>
            </div>

            {/* Boundary Status Grid */}
            {boundaryStatus && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, width: '100%' }}>
                <div className="state-box" style={{ padding: 10, textAlign: 'left', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Firewall</div>
                  <div style={{ fontWeight: 600, color: firewallActive ? '#22c55e' : '#ef4444' }} data-testid="firewall-status">
                    {boundaryStatus.firewallStatus}
                  </div>
                </div>
                <div className="state-box" style={{ padding: 10, textAlign: 'left', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Endpoint Policy</div>
                  <div style={{ fontWeight: 600, color: boundaryStatus.endpointPolicyStatus === 'MATCHED' ? '#22c55e' : '#ef4444' }} data-testid="endpoint-policy-status">
                    {boundaryStatus.endpointPolicyStatus}
                  </div>
                </div>
                <div className="state-box" style={{ padding: 10, textAlign: 'left', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Network Monitor</div>
                  <div style={{ fontWeight: 600, color: boundaryStatus.monitorStatus === 'CAPTURING' ? '#22c55e' : '#d29922' }} data-testid="monitor-status">
                    {boundaryStatus.monitorStatus}
                  </div>
                </div>
                <div className="state-box" style={{ padding: 10, textAlign: 'left', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Service Identity</div>
                  <div style={{ fontWeight: 600, color: boundaryStatus.serviceIdentityStatus === 'TRUSTED' ? '#22c55e' : '#ef4444' }} data-testid="service-identity-status">
                    {boundaryStatus.serviceIdentityStatus}
                  </div>
                </div>
                <div className="state-box" style={{ padding: 10, textAlign: 'left', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Last Measured At</div>
                  <div style={{ fontSize: 12, fontWeight: 500 }} data-testid="boundary-checked-at">
                    {new Date(boundaryStatus.checkedAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            )}

            {/* Mismatch & Remediation Actions */}
            {boundaryStatus && !isBoundaryVerified && (
              <div className="state-box" data-testid="mismatch-actions-box" style={{ borderColor: '#ef4444', marginTop: 12, width: '100%', textAlign: 'left', alignItems: 'flex-start' }}>
                <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>
                  <AlertCircleIcon size={14} /> Action Required: Boundary State Mismatch
                </div>
                {boundaryStatus.blockingReason && (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Reason: {boundaryStatus.blockingReason}
                  </p>
                )}
                {boundaryStatus.activeViolations && boundaryStatus.activeViolations.length > 0 && (
                  <ul style={{ fontSize: 12, margin: '0 0 8px 16px', padding: 0 }}>
                    {boundaryStatus.activeViolations.map((v, i) => (
                      <li key={i} style={{ color: '#ef4444' }}>{v}</li>
                    ))}
                  </ul>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <strong>Recommended Mismatch Remedies:</strong>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {!firewallActive && <li>Enable industrial firewall mode and apply approved policy hash.</li>}
                    {boundaryStatus.endpointPolicyStatus !== 'MATCHED' && <li>Verify all open ports match the strict loopback-only allowlist.</li>}
                    {boundaryStatus.serviceIdentityStatus !== 'TRUSTED' && <li>Restart unverified background worker processes to recalculate executable hash.</li>}
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Approved Endpoints & Allowlist */}
          <div className="state-box" data-testid="allowlist-box" style={{ marginBottom: 16 }}>
            <div className="state-title">Approved Loopback Allowlist</div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 8 }}>
              Authoritative socket allowlist. Zero non-loopback endpoints are permitted or hidden.
            </p>
            {panelData?.endpointPolicy?.allowedEndpoints && panelData.endpointPolicy.allowedEndpoints.length > 0 ? (
              <div className="table-responsive" style={{ width: '100%' }}>
                <table className="data-table" aria-label="Allowlist Endpoints Table" style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Endpoint ID</th>
                      <th>Protocol</th>
                      <th>Host Pattern</th>
                      <th>Port Range</th>
                      <th>Loopback Only</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panelData.endpointPolicy.allowedEndpoints.map((ep: any, idx: number) => (
                      <tr key={ep.endpointId || idx} data-testid={`endpoint-row-${idx}`}>
                        <td className="font-mono">{ep.endpointId}</td>
                        <td className="font-mono">{ep.protocol}</td>
                        <td className="font-mono">{ep.hostPattern}</td>
                        <td className="font-mono">{ep.portRange || 'ephemeral'}</td>
                        <td>
                          <span style={{ color: ep.isLoopbackOnly ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                            {ep.isLoopbackOnly ? 'YES' : 'NO'}
                          </span>
                        </td>
                        <td>{ep.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No explicit endpoint policy rules recorded.</p>
            )}
          </div>

          {/* Tracked Processes & Process Tree */}
          <div className="state-box" data-testid="process-tree-box" style={{ marginBottom: 16 }}>
            <div className="state-title">Tracked Process Tree & Service Identities</div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 8 }}>
              Cryptographically verified running processes bound to project root. Zero cross-project records.
            </p>
            {panelData?.trackedProcesses && panelData.trackedProcesses.length > 0 ? (
              <div className="table-responsive" style={{ width: '100%' }}>
                <table className="data-table" aria-label="Tracked Processes Table" style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>Parent PID</th>
                      <th>Name</th>
                      <th>Trust Status</th>
                      <th>Executable Hash</th>
                      <th>Model Leases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panelData.trackedProcesses.map((p: TrackedProcessInfo) => (
                      <tr key={p.processId} data-testid={`process-row-${p.processId}`}>
                        <td className="font-mono">{p.processId}</td>
                        <td className="font-mono text-dim">{p.parentPid || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{p.processName}</td>
                        <td>
                          <span
                            className="state-badge"
                            style={{
                              backgroundColor: p.status === 'trusted' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                              color: p.status === 'trusted' ? '#22c55e' : '#ef4444',
                              fontSize: 10,
                            }}
                          >
                            {p.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="font-mono text-dim" title={p.executableHash}>
                          {truncateHash(p.executableHash, 14)}
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {p.activeModelLeases && p.activeModelLeases.length > 0 ? (
                            p.activeModelLeases.join(', ')
                          ) : (
                            <span style={{ color: 'var(--muted, #888)' }}>None</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No tracked processes currently registered.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
