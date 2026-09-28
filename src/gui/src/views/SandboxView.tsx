import React, { useState, useEffect } from 'react';
import {
  SandboxIcon,
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  CloseIcon,
} from '../components/icons';
import { apiAdapter } from '../api';
import type { SandboxResultRecord } from '../api/rest-client';

function statusColor(ok?: boolean): string {
  if (ok === true) return '#3fb950';
  if (ok === false) return '#f85149';
  return '#8b949e';
}

function statusLabel(record: SandboxResultRecord): string {
  if (record.status) return record.status;
  if (record.ok === true) return 'COMPLETED';
  if (record.ok === false) return 'FAILED';
  return 'UNKNOWN';
}

function truncateHash(hash?: string): string {
  if (!hash) return '—';
  return hash.length > 16 ? hash.slice(0, 8) + '…' + hash.slice(-8) : hash;
}

export const SandboxView: React.FC = () => {
  const [results, setResults] = useState<SandboxResultRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<SandboxResultRecord | null>(null);

  // Sandbox manifest/image state
  const [manifest, setManifest] = useState<any>(null);

  useEffect(() => {
    loadResults();
    loadManifest();
  }, []);

  const loadResults = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiAdapter.getSandboxResults();
      setResults(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load sandbox results.');
    } finally {
      setLoading(false);
    }
  };

  const loadManifest = async () => {
    try {
      const m = await apiAdapter.getSandboxManifest();
      setManifest(m);
    } catch {
      setManifest(null);
    }
  };

  const completedCount = results.filter((r) => r.ok === true).length;
  const failedCount = results.filter((r) => r.ok === false).length;

  return (
    <div className="view-container" role="tabpanel" aria-label="Sandbox Results View">
      <div className="view-header">
        <h1 className="view-title">Container Sandbox</h1>
        <p className="view-desc">
          Execution results from container-isolated sandbox runs.
          Source scripts, stdout/stderr lengths, artifact hashes, and provenance records.
        </p>
      </div>

      {/* Manifest Status */}
      <div className="state-box" data-testid="sandbox-manifest-box">
        <SandboxIcon size={20} />
        <div className="state-title">Sandbox Image</div>
        {manifest ? (
          <div>
            <span className="state-badge" data-testid="sandbox-image-badge">
              IMAGE: {manifest.imageRef || manifest.image || 'CONFIGURED'}
            </span>
            {manifest.digest && (
              <p className="state-message" style={{ fontFamily: 'monospace', fontSize: 11 }} data-testid="sandbox-image-digest">
                Digest: {truncateHash(manifest.digest)}
              </p>
            )}
          </div>
        ) : (
          <span className="state-badge">IMAGE: NOT CONFIGURED</span>
        )}
        <button
          className="icon-btn"
          onClick={() => { loadResults(); loadManifest(); }}
          aria-label="Refresh sandbox data"
          title="Refresh"
        >
          <RefreshIcon size={16} />
        </button>
      </div>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: 16, marginTop: 16 }} data-testid="sandbox-summary">
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-title">Total Runs</div>
          <div style={{ fontSize: 24, fontWeight: 700 }} data-testid="sandbox-total-count">{results.length}</div>
        </div>
        <div className="state-box" style={{ flex: 1 }}>
          <CheckCircleIcon size={16} />
          <div className="state-title" style={{ color: '#3fb950' }}>Completed</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#3fb950' }} data-testid="sandbox-completed-count">{completedCount}</div>
        </div>
        <div className="state-box" style={{ flex: 1 }}>
          <AlertCircleIcon size={16} />
          <div className="state-title" style={{ color: '#f85149' }}>Failed</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#f85149' }} data-testid="sandbox-failed-count">{failedCount}</div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="state-box" data-testid="sandbox-error" style={{ borderColor: 'rgba(248,81,73,0.4)', marginTop: 16 }}>
          <AlertCircleIcon size={20} />
          <div className="state-title" style={{ color: '#f85149' }}>Error</div>
          <p className="state-message">{error}</p>
        </div>
      )}

      {/* Results List */}
      {!loading && results.length === 0 && !error && (
        <div className="state-box" data-testid="sandbox-empty" style={{ marginTop: 16 }}>
          <SandboxIcon size={24} />
          <div className="state-title">No Sandbox Executions</div>
          <p className="state-message">No container sandbox runs recorded yet.</p>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 16 }} data-testid="sandbox-results-list">
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Execution History</h2>
          {results.map((r, i) => (
            <div
              key={r.eventId || `run-${i}`}
              className="result-item"
              data-testid={`sandbox-result-${i}`}
              onClick={() => setSelectedResult(r)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setSelectedResult(r)}
              aria-label={`Sandbox run ${i + 1}: ${statusLabel(r)}`}
              style={{
                padding: '12px 16px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                marginBottom: 8,
                cursor: 'pointer',
                background: selectedResult?.eventId === r.eventId ? 'rgba(88,166,255,0.1)' : 'var(--bg-secondary)',
                transition: 'background 0.15s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: statusColor(r.ok),
                    }}
                  />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{statusLabel(r)}</span>
                  {r.exitCode !== undefined && r.exitCode !== null && (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                      exit:{r.exitCode}
                    </span>
                  )}
                  {r.containerName && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                      {r.containerName}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {r.durationMs !== undefined && `${r.durationMs}ms · `}
                  {r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : ''}
                </div>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', display: 'flex', gap: 16 }}>
                <span>input: {truncateHash(r.inputHash)}</span>
                <span>output: {truncateHash(r.outputHash)}</span>
                {r.stdoutLength !== undefined && <span>stdout: {r.stdoutLength}B</span>}
                {r.stderrLength !== undefined && <span>stderr: {r.stderrLength}B</span>}
              </div>
              {r.stagedFiles && r.stagedFiles.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                  Files: {(r.stagedFiles as string[]).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Result Detail Panel */}
      {selectedResult && (
        <div className="state-box" data-testid="sandbox-result-detail" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="state-title">Execution Detail</div>
            <button
              className="icon-btn"
              onClick={() => setSelectedResult(null)}
              aria-label="Close execution detail"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
            <tbody>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Event ID</td><td style={{ fontFamily: 'monospace' }}>{selectedResult.eventId}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Timestamp</td><td>{selectedResult.timestamp}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Source</td><td>{selectedResult.source}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Event</td><td>{selectedResult.event}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Status</td><td style={{ color: statusColor(selectedResult.ok) }}>{statusLabel(selectedResult)}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Exit Code</td><td>{selectedResult.exitCode ?? '—'}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Duration</td><td>{selectedResult.durationMs ?? '—'}ms</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Container</td><td style={{ fontFamily: 'monospace' }}>{selectedResult.containerName || '—'}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Image Digest</td><td style={{ fontFamily: 'monospace' }}>{truncateHash(selectedResult.imageDigest)}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Input Hash</td><td style={{ fontFamily: 'monospace' }}>{selectedResult.inputHash || '—'}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Output Hash</td><td style={{ fontFamily: 'monospace' }}>{selectedResult.outputHash || '—'}</td></tr>
              {selectedResult.stdoutLength !== undefined && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Stdout Length</td><td>{selectedResult.stdoutLength} bytes</td></tr>}
              {selectedResult.stderrLength !== undefined && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Stderr Length</td><td>{selectedResult.stderrLength} bytes</td></tr>}
              {selectedResult.auditEventId && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Audit Event</td><td style={{ fontFamily: 'monospace' }}>{selectedResult.auditEventId}</td></tr>}
            </tbody>
          </table>
          {selectedResult.stagedFiles && selectedResult.stagedFiles.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Staged Files:</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, fontFamily: 'monospace' }}>
                {(selectedResult.stagedFiles as string[]).map((f, fi) => (
                  <li key={fi}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="state-box" style={{ marginTop: 16 }}>
          <div className="state-title">Loading…</div>
        </div>
      )}
    </div>
  );
};
