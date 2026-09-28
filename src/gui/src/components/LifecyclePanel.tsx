/**
 * UI1-19: Service Lifecycle & Recovery Controls Panel
 *
 * Displays service identity, health diagnostics, timeout defaults,
 * orphan temp file cleanup, connection state, and recovery controls.
 *
 * Safety invariants:
 *   - Stale identity cannot be used for reattach
 *   - Force stop cannot report success or leave trusted temp artifacts
 *   - No pause/resume controls (forbidden by spec)
 */

import React, { useState, useEffect } from 'react';
import {
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from '../components/icons';
import { apiAdapter } from '../api';
import type {
  ServiceIdentityResponse,
  DiagnosticResultRecord,
} from '../api/rest-client';

/** Canonical timeout defaults for display (from domain services) */
const SERVICE_TIMEOUT_DEFAULTS = {
  serviceIdleMs: 600_000,  // 10 minutes
  modelIdleMs:   180_000,  // 3 minutes
  sessionTtlMs: 3_600_000, // 1 hour
} as const;

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(0)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function truncateHash(hash?: string): string {
  if (!hash) return '—';
  return hash.length > 16 ? hash.slice(0, 8) + '…' + hash.slice(-8) : hash;
}

function uptimeStr(startedAt?: string): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diff = now - start;
  if (diff < 0) return '—';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1_000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

export const LifecyclePanel: React.FC = () => {
  const [identity, setIdentity] = useState<ServiceIdentityResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticResultRecord[]>([]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stop/recovery state
  const [stopStatus, setStopStatus] = useState<string | null>(null);
  const [isStopPending, setIsStopPending] = useState(false);
  const [orphanStatus, setOrphanStatus] = useState<string | null>(null);
  const [isReaping, setIsReaping] = useState(false);

  const handleCleanupOrphans = async () => {
    setIsReaping(true);
    try {
      const res = await apiAdapter.cleanupOrphans({ maxAgeMs: 0 });
      setOrphanStatus(`Orphan reaper purged ${res.purged} stale temporary file(s).`);
    } catch (err: any) {
      setOrphanStatus(`Orphan reaper error: ${err.message}`);
    } finally {
      setIsReaping(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [id, diag, hp] = await Promise.allSettled([
        apiAdapter.getServiceIdentity(),
        apiAdapter.getDiagnostics(),
        apiAdapter.getHealth(),
      ]);

      if (id.status === 'fulfilled') setIdentity(id.value);
      else setIdentity(null);

      if (diag.status === 'fulfilled') setDiagnostics(diag.value);
      else setDiagnostics([]);

      if (hp.status === 'fulfilled') setHealth(hp.value);
      else setHealth(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load lifecycle data');
    } finally {
      setLoading(false);
    }
  };

  const handleStopAfterCurrent = async () => {
    setIsStopPending(true);
    setStopStatus('Requesting graceful stop after current tasks…');
    try {
      const result = await apiAdapter.stopService({ mode: 'after-current-tasks' });
      setStopStatus(
        result.status === 'stopping_after_tasks'
          ? `Service stopping: ${(result as any).activeTasksCount ?? 0} active task(s) will finish first.`
          : `Service stopped. Status: ${result.status}`,
      );
    } catch (err: any) {
      setStopStatus(`Stop error: ${err.message}`);
    } finally {
      setIsStopPending(false);
    }
  };

  const identityStatus = identity?.status || 'unknown';
  const isHealthy = identityStatus === 'healthy';
  const isStopped = identityStatus === 'stopped';

  const allDiagsPassed = diagnostics.length > 0 && diagnostics.every((d) => d.passed);
  const failedDiags = diagnostics.filter((d) => !d.passed);

  return (
    <div data-testid="lifecycle-panel">
      {/* Section Header */}
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>
        Service Lifecycle & Recovery
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        Verified service identity, health diagnostics, timeout defaults, and recovery controls.
        Stale identities cannot reattach. No pause/resume.
      </p>

      {error && (
        <div className="state-box" data-testid="lifecycle-error" style={{ borderColor: 'rgba(248,81,73,0.4)', marginBottom: 12 }}>
          <AlertCircleIcon size={16} />
          <span style={{ color: '#f85149', fontSize: 13 }}>{error}</span>
        </div>
      )}

      {/* Service Identity */}
      <div className="state-box" data-testid="lifecycle-identity" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div className="state-title">Service Identity</div>
          <button className="icon-btn" onClick={refresh} aria-label="Refresh lifecycle" title="Refresh">
            <RefreshIcon size={16} />
          </button>
        </div>
        {loading && <p className="state-message">Loading…</p>}
        {identity ? (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
            <tbody>
              <tr>
                <td style={{ padding: '3px 8px', color: 'var(--text-secondary)', width: 140 }}>Status</td>
                <td>
                  <span
                    data-testid="lifecycle-identity-status"
                    style={{
                      fontWeight: 600,
                      color: isHealthy ? '#3fb950' : isStopped ? '#f85149' : '#d29922',
                    }}
                  >
                    {identityStatus.toUpperCase()}
                  </span>
                </td>
              </tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Instance ID</td><td style={{ fontFamily: 'monospace' }} data-testid="lifecycle-instance-id">{truncateHash(identity.serviceInstanceId)}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>PID</td><td data-testid="lifecycle-pid">{identity.servicePid}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Port</td><td data-testid="lifecycle-port">{identity.servicePort}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Host</td><td>{identity.host}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Project Root Hash</td><td style={{ fontFamily: 'monospace' }}>{truncateHash(identity.projectRootHash)}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Executable Hash</td><td style={{ fontFamily: 'monospace' }}>{truncateHash(identity.executableHash)}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Protocol</td><td>{identity.protocolVersion}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Started At</td><td>{identity.startedAt}</td></tr>
              <tr><td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Uptime</td><td data-testid="lifecycle-uptime">{uptimeStr(identity.startedAt)}</td></tr>
            </tbody>
          </table>
        ) : !loading ? (
          <p className="state-message" style={{ color: '#f85149' }}>
            No service identity record found. Service may not be running or identity file is missing.
          </p>
        ) : null}
      </div>

      {/* Timeout Defaults */}
      <div className="state-box" data-testid="lifecycle-timeouts" style={{ marginBottom: 12 }}>
        <div className="state-title">Timeout Defaults</div>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
          <tbody>
            <tr>
              <td style={{ padding: '3px 8px', color: 'var(--text-secondary)', width: 160 }}>Service Idle Timeout</td>
              <td data-testid="lifecycle-service-timeout">{formatMs(SERVICE_TIMEOUT_DEFAULTS.serviceIdleMs)}</td>
              <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Auto-shutdown after inactivity</td>
            </tr>
            <tr>
              <td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Model Idle Unload</td>
              <td data-testid="lifecycle-model-timeout">{formatMs(SERVICE_TIMEOUT_DEFAULTS.modelIdleMs)}</td>
              <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>GPU model unloaded after idle</td>
            </tr>
            <tr>
              <td style={{ padding: '3px 8px', color: 'var(--text-secondary)' }}>Session TTL</td>
              <td data-testid="lifecycle-session-ttl">{formatMs(SERVICE_TIMEOUT_DEFAULTS.sessionTtlMs)}</td>
              <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Per-window session token lifetime</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Health Diagnostics */}
      <div className="state-box" data-testid="lifecycle-diagnostics" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div className="state-title">Health Diagnostics</div>
          {allDiagsPassed ? (
            <span style={{ color: '#3fb950', fontSize: 12 }}>
              <CheckCircleIcon size={14} /> All {diagnostics.length} checks passed
            </span>
          ) : failedDiags.length > 0 ? (
            <span style={{ color: '#f85149', fontSize: 12 }}>
              <AlertCircleIcon size={14} /> {failedDiags.length} check(s) failed
            </span>
          ) : null}
        </div>
        {diagnostics.length > 0 ? (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text-secondary)', fontSize: 11 }}>Check</th>
                <th style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text-secondary)', fontSize: 11 }}>Status</th>
                <th style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text-secondary)', fontSize: 11 }}>Message</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.map((d, i) => (
                <tr key={i} data-testid={`diag-${d.check}`}>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{d.check}</td>
                  <td style={{ padding: '3px 8px', color: d.passed ? '#3fb950' : '#f85149' }}>
                    {d.passed ? '✓ PASS' : '✗ FAIL'}
                  </td>
                  <td style={{ padding: '3px 8px' }}>{d.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : !loading ? (
          <p className="state-message">No diagnostics available.</p>
        ) : null}
      </div>

      {/* Health Summary */}
      {health && (
        <div className="state-box" data-testid="lifecycle-health" style={{ marginBottom: 12 }}>
          <div className="state-title">Service Health</div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            <div>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Status: </span>
              <span
                data-testid="lifecycle-health-status"
                style={{ fontWeight: 600, color: (health as any).status === 'HEALTHY' ? '#3fb950' : '#d29922' }}
              >
                {String((health as any).status || '—')}
              </span>
            </div>
            {(health as any).serviceInstanceId && (
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Instance: </span>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{truncateHash(String((health as any).serviceInstanceId))}</span>
              </div>
            )}
            {(health as any).servicePort && (
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Port: </span>
                <span>{String((health as any).servicePort)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stop Controls */}
      <div className="state-box" data-testid="lifecycle-stop-controls" style={{ marginBottom: 12 }}>
        <div className="state-title">Service Stop Controls</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            data-testid="btn-stop-after-current"
            onClick={handleStopAfterCurrent}
            disabled={isStopPending}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: isStopPending ? 'not-allowed' : 'pointer',
            }}
          >
            Stop After Current Tasks
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Graceful shutdown — lets running tasks finish, then stops.
          </span>
        </div>
        {stopStatus && (
          <p className="state-message" data-testid="lifecycle-stop-status" style={{ marginTop: 8 }}>
            {stopStatus}
          </p>
        )}
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, fontStyle: 'italic' }}>
          Force stop is available in the Force Stop modal above. No pause/resume controls exist.
        </p>
      </div>

      {/* Orphan Reaper Controls */}
      <div className="state-box" data-testid="lifecycle-orphan-reaper" style={{ marginBottom: 12 }}>
        <div className="state-title">Orphan Reaper & Temp File Cleanup</div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 8 }}>
          Purge unfinalized temporary files (.tmp_*) left behind by crashes or interrupted tasks.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            data-testid="btn-reap-orphans"
            onClick={handleCleanupOrphans}
            disabled={isReaping}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: isReaping ? 'not-allowed' : 'pointer',
            }}
          >
            {isReaping ? 'Cleaning...' : 'Run Orphan Reaper Sweep'}
          </button>
        </div>
        {orphanStatus && (
          <p className="state-message" data-testid="lifecycle-orphan-status" style={{ marginTop: 8 }}>
            {orphanStatus}
          </p>
        )}
      </div>

      {/* Recovery Information */}
      <div className="state-box" data-testid="lifecycle-recovery" style={{ marginBottom: 12 }}>
        <div className="state-title">Recovery & Crash Handling</div>
        <ul style={{ fontSize: 12, lineHeight: 1.8, paddingLeft: 20, margin: '8px 0 0 0' }}>
          <li>
            <strong>Browser disconnect</strong>: cancels active chat; workflow tasks continue on the service side.
          </li>
          <li>
            <strong>Service crash</strong>: orphaned temporary artifacts are cleaned on next startup
            (max age sweep); session tokens are invalidated immediately.
          </li>
          <li>
            <strong>Stale reattach</strong>: a browser with a stale service instance ID or expired session token
            is rejected with <code>INSTANCE_MISMATCH</code> or <code>TOKEN_EXPIRED</code>.
          </li>
          <li>
            <strong>Orphan reaper</strong>: temporary files older than the configured max age are purged
            on service startup by <code>ArtifactService.cleanupOrphanTempFiles()</code>.
          </li>
          <li>
            <strong>Task keepalive</strong>: active tasks emit heartbeat events to the event stream;
            the browser EventSource reconnects automatically on disconnection.
          </li>
          <li>
            <strong>Force stop defense</strong>: force stop cannot report success (phantom success)
            and cannot leave trusted temp artifacts behind.
          </li>
        </ul>
      </div>
    </div>
  );
};
