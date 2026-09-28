import React, { useState, useEffect, useMemo } from 'react';
import {
  KnowledgeIcon,
  RefreshIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  CloseIcon,
} from '../components/icons';
import { apiAdapter } from '../api';
import type {
  KbSearchPayload,
  KbSearchResultResponse,
  KbSearchCitationRecord,
} from '../api/rest-client';

// Score color thresholds
function scoreColor(score: number): string {
  if (score >= 0.8) return '#3fb950';
  if (score >= 0.5) return '#d29922';
  return '#f85149';
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export const KnowledgeView: React.FC = () => {
  // Search form state
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [minScore, setMinScore] = useState(0.0);

  // Results state
  const [result, setResult] = useState<KbSearchResultResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // KB status
  const [kbStatus, setKbStatus] = useState<any>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Selected citation detail
  const [selectedCitation, setSelectedCitation] = useState<KbSearchCitationRecord | null>(null);

  // Load KB status on mount
  useEffect(() => {
    loadKbStatus();
  }, []);

  const loadKbStatus = async () => {
    setStatusLoading(true);
    try {
      const status = await apiAdapter.getKbStatus();
      setKbStatus(status);
    } catch (err: any) {
      // Non-fatal; status panel just shows unavailable
      setKbStatus(null);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) {
      setError('Query cannot be empty.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedCitation(null);

    try {
      const payload: KbSearchPayload = {
        query: query.trim(),
        topK,
        minScore,
      };
      const res = await apiAdapter.searchKb(payload);
      setResult(res);
    } catch (err: any) {
      setError(err.message || 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleSearch();
    }
  };

  // Derived state
  const citations = result?.citations ?? [];
  const isNoAnswer = result !== null && result.answered === false;
  const hasResults = result !== null && result.answered === true && citations.length > 0;

  return (
    <div className="view-container" role="tabpanel" aria-label="Knowledge Search View">
      <div className="view-header">
        <h1 className="view-title">Knowledge Search</h1>
        <p className="view-desc">
          Semantic similarity search over the project-local vector index.
          All results include provenance citations. No cloud, no fabrication.
        </p>
      </div>

      {/* KB Status Banner */}
      <div className="state-box" data-testid="kb-status-box">
        <KnowledgeIcon size={20} />
        <div className="state-title">Index Status</div>
        {statusLoading ? (
          <p className="state-message">Loading index status…</p>
        ) : kbStatus ? (
          <div>
            <span className="state-badge" data-testid="kb-status-badge">
              {kbStatus.indexed ? 'INDEX: READY' : 'INDEX: NOT BUILT'}
            </span>
            {kbStatus.documentCount !== undefined && (
              <p className="state-message" data-testid="kb-doc-count">
                {kbStatus.documentCount} document(s) indexed
                {kbStatus.embeddingModelId ? ` · Model: ${kbStatus.embeddingModelId}` : ''}
              </p>
            )}
          </div>
        ) : (
          <span className="state-badge">INDEX: UNAVAILABLE</span>
        )}
        <button
          className="icon-btn"
          onClick={loadKbStatus}
          aria-label="Refresh KB status"
          title="Refresh"
        >
          <RefreshIcon size={16} />
        </button>
      </div>

      {/* Search Form */}
      <div style={{ marginTop: 16 }} data-testid="kb-search-form">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="kb-query" style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Search Query
            </label>
            <input
              id="kb-query"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter search query…"
              disabled={loading}
              className="input-field"
              data-testid="kb-query-input"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
          </div>
          <div>
            <label htmlFor="kb-topk" style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Top K
            </label>
            <input
              id="kb-topk"
              type="number"
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Math.min(50, parseInt(e.target.value) || 5)))}
              min={1}
              max={50}
              disabled={loading}
              data-testid="kb-topk-input"
              style={{ width: 64, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
          </div>
          <div>
            <label htmlFor="kb-minscore" style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Min Score
            </label>
            <input
              id="kb-minscore"
              type="number"
              value={minScore}
              onChange={(e) => setMinScore(Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)))}
              min={0}
              max={1}
              step={0.05}
              disabled={loading}
              data-testid="kb-minscore-input"
              style={{ width: 80, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            data-testid="kb-search-btn"
            style={{ padding: '8px 16px', borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 14 }}
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="state-box" data-testid="kb-error" style={{ borderColor: 'rgba(248,81,73,0.4)', marginTop: 16 }}>
          <AlertCircleIcon size={20} />
          <div className="state-title" style={{ color: '#f85149' }}>Search Error</div>
          <p className="state-message">{error}</p>
        </div>
      )}

      {/* No-Answer Result */}
      {isNoAnswer && (
        <div className="state-box" data-testid="kb-no-answer" style={{ borderColor: 'rgba(210,153,34,0.4)', marginTop: 16 }}>
          <AlertCircleIcon size={20} />
          <div className="state-title" style={{ color: '#d29922' }}>No Answer</div>
          <p className="state-message">
            {(result as any).reason}: {(result as any).details || 'Insufficient evidence in the index.'}
          </p>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Corpus: {(result as any).corpusDocumentCount ?? '?'} docs ·
            Indexed: {(result as any).indexedDocumentCount ?? '?'} docs ·
            Duration: {result!.durationMs}ms
          </div>
        </div>
      )}

      {/* Results List */}
      {hasResults && (
        <div style={{ marginTop: 16 }} data-testid="kb-results">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>
              <CheckCircleIcon size={16} /> Results
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
                {result!.returnedMatches ?? citations.length} of {result!.totalMatches ?? citations.length} matches ·
                {result!.durationMs}ms
              </span>
            </h2>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
              Index: {result!.indexBuildId ? truncate(result!.indexBuildId, 12) : '—'} ·
              Model: {result!.embeddingModelId || '—'}
            </span>
          </div>

          <div className="results-list" data-testid="kb-citations-list">
            {citations.map((c, i) => (
              <div
                key={c.chunkId}
                className="result-item"
                data-testid={`kb-citation-${i}`}
                onClick={() => setSelectedCitation(c)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setSelectedCitation(c)}
                aria-label={`Citation ${i + 1}: ${c.sourcePath}`}
                style={{
                  padding: '12px 16px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  marginBottom: 8,
                  cursor: 'pointer',
                  background: selectedCitation?.chunkId === c.chunkId ? 'rgba(88,166,255,0.1)' : 'var(--bg-secondary)',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{i + 1}.</span>
                    <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{c.sourcePath}</span>
                    {c.pageNumber && (
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>p.{c.pageNumber}</span>
                    )}
                    {c.sectionHeading && (
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>§ {truncate(c.sectionHeading, 30)}</span>
                    )}
                  </div>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      color: scoreColor(c.score),
                      fontFamily: 'monospace',
                    }}
                    data-testid={`kb-score-${i}`}
                  >
                    {c.score.toFixed(4)}
                  </span>
                </div>
                <div
                  style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}
                  data-testid={`kb-snippet-${i}`}
                >
                  {truncate(c.snippet, 300)}
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  doc:{truncate(c.documentId, 12)} · chunk:{c.chunkIndex} · hash:{truncate(c.sourceHash, 12)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Citation Detail Panel */}
      {selectedCitation && (
        <div className="state-box" data-testid="kb-citation-detail" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="state-title">Citation Detail</div>
            <button
              className="icon-btn"
              onClick={() => setSelectedCitation(null)}
              aria-label="Close citation detail"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
            <tbody>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Document ID</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.documentId}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Chunk ID</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.chunkId}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Source Path</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.sourcePath}</td></tr>
              {selectedCitation.canonicalPath && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Canonical Path</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.canonicalPath}</td></tr>}
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Source Hash</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.sourceHash}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Score</td><td style={{ fontFamily: 'monospace', color: scoreColor(selectedCitation.score) }}>{selectedCitation.score.toFixed(6)}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Chunk Index</td><td>{selectedCitation.chunkIndex}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Version</td><td>{selectedCitation.documentVersion}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Offsets</td><td>{selectedCitation.charOffsetStart}–{selectedCitation.charOffsetEnd}</td></tr>
              {selectedCitation.pageNumber && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Page</td><td>{selectedCitation.pageNumber}</td></tr>}
              {selectedCitation.sectionHeading && <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Section</td><td>{selectedCitation.sectionHeading}</td></tr>}
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Index Build</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.indexBuildId}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Embedding Model</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.embeddingModelId}</td></tr>
              <tr><td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>Model Revision</td><td style={{ fontFamily: 'monospace' }}>{selectedCitation.embeddingModelRevision}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Snippet (DATA only — untrusted):</div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 4, maxHeight: 200, overflow: 'auto' }}>
              {selectedCitation.snippet}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
