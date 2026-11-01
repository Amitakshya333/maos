/**
 * TASK RING-IMPL-01: Ring ask panel (NEW hosted path consumer).
 *
 * ChatView mounts this panel; the sovereign conversation/model/promotion
 * flows below it are unchanged. This module:
 * - calls POST /api/v1/ring/ask via the exact RING-SVC-01 contract,
 * - renders hosted vs evidence-only states with verbatim copy,
 * - reuses CompletionRefusalDemo + TelemetryReviewCoordinator.prepareReview
 *   for the refusal beat (real gate, verbatim refusal text),
 * - renders the judge verify transcript only from provided real output.
 *
 * It invents nothing: no served-model id, no approval, no verify output,
 * no raw telemetry in any prompt (the client sends only the question text).
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiAdapter } from '../api';
import type { JudgedRunResponse } from '../api/rest-client';
import type { RingAskRequest, RingAskResult } from '../api/ring-types';
import { CompletionRefusalDemo } from './CompletionRefusalDemo';
import { TelemetryReviewCoordinator } from './telemetryReviewCoordinator';

/** Exact hosted badge copy (step 2). Served-model suffix appended only from server echo. */
export const RING_HOSTED_BADGE = 'HOSTED · meta-models/muse-spark-open-1026 via Baseten';
/** Exact evidence-only badge copy (step 2). */
export const RING_EVIDENCE_ONLY_BADGE = 'EVIDENCE-ONLY · no model configured';
/** Exact hosted banner copy (step 3). */
export const RING_HOSTED_BANNER = 'Meta model reasoning via Baseten. Company evidence stays in MAOS.';
/** Exact telemetry-boundary line (step 3). */
export const RING_TELEMETRY_BOUNDARY = 'raw telemetry never leaves MAOS; only the summary is sent';
/** Verify fallback copy (step 6). */
export const RING_NO_EXPORT_VERIFIED = 'No export verified yet.';

/**
 * Assistant attribution for Ring (O-2). USER rendering is unchanged;
 * assistant messages attribute to RING.
 */
export function ringRoleLabel(role: string): string {
  return role === 'assistant' ? 'RING' : role;
}

/**
 * Model identity line for the badge (step 2). When a Ring result exists it
 * determines the text; otherwise the caller keeps its existing local badge.
 * The served-model suffix appears only when the server echoed an id.
 */
export function ringBadgeText(ringResult: RingAskResult | null, localFallback: string): string {
  if (!ringResult) return localFallback;
  if (ringResult.mode === 'evidence-only') return RING_EVIDENCE_ONLY_BADGE;
  const served = ringResult.servedModelId?.trim();
  return served ? `${RING_HOSTED_BADGE} · reported ${served}` : RING_HOSTED_BADGE;
}

export const RingHostedBanner: React.FC<{ result: RingAskResult }> = ({ result }) => (
  <div
    data-testid="ring-hosted-banner"
    style={{
      padding: '8px 14px',
      backgroundColor: 'var(--bg-tertiary, #222222)',
      borderLeft: '4px solid var(--status-green, #4ade80)',
      borderRadius: '4px',
      marginBottom: '12px',
      fontSize: '12px',
      color: 'var(--text-secondary, #cccccc)',
    }}
  >
    <div>{RING_HOSTED_BANNER}</div>
    <div data-testid="ring-hosted-identity" style={{ marginTop: '4px', fontSize: '11px' }}>
      Provider: {result.providerName ?? 'not reported'} · Model: {result.modelId ?? 'not reported'}
      {result.servedModelId?.trim() ? ` · Served: ${result.servedModelId}` : ''}
    </div>
    <div data-testid="ring-telemetry-boundary" style={{ marginTop: '4px', fontSize: '11px' }}>
      {RING_TELEMETRY_BOUNDARY}
    </div>
  </div>
);

export const RingEvidenceOnlyBanner: React.FC = () => (
  <div
    data-testid="ring-evidence-only-banner"
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
    Ring is running in evidence-only mode: no model is configured, so no model wrote this answer and no model ran. Local
    evidence, verification, and review tools remain available.
  </div>
);

export interface RingVerifyTranscript {
  runId?: string | null;
  auditOutput?: string | null;
  exportPath?: string | null;
  exportPassLine?: string | null;
}

/**
 * Judge verify card (step 6 / O-5). Renders CLI/transcript text only from
 * provided real output. With no export evidence it shows the fallback;
 * it never invents output or a PASS line.
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

export interface RingResultCardProps {
  result: RingAskResult;
  reviewBusy: boolean;
  reviewError: string | null;
  reviewRun: JudgedRunResponse | null;
  onClaim: (analysisId: string) => void;
  verifyTranscript: RingVerifyTranscript;
}

/**
 * Presentational Ring result: answer verbatim, sources as citations,
 * deterministic line in every mode, refusal beat, verify card.
 */
export const RingResultCard: React.FC<RingResultCardProps> = ({
  result,
  reviewBusy,
  reviewError,
  reviewRun,
  onClaim,
  verifyTranscript,
}) => {
  const deterministic = result.deterministic;
  const deterministicLine = deterministic.attempted
    ? `Deterministic: ${deterministic.verdict ?? 'not reported'} · RMS ${deterministic.overallRms ?? 'not reported'} · ${deterministic.analysisId ?? 'no analysis id'}`
    : 'Deterministic: not attempted';
  return (
    <div
      data-testid="ring-result-card"
      style={{
        marginTop: 12,
        border: '1px solid var(--border-color, #30363d)',
        borderRadius: 7,
        padding: 12,
        background: 'var(--bg-secondary, #0d1117)',
      }}
    >
      {result.mode === 'evidence-only' ? (
        <div data-testid="ring-no-model-note" style={{ fontSize: 11, color: '#e3b341', marginBottom: 8 }}>
          No model wrote this answer and no model ran — evidence-only response shown as-is.
        </div>
      ) : (
        <div data-testid="ring-model-note" style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
          Model answer · {result.providerName ?? 'provider not reported'} · {result.modelId ?? 'model not reported'} ·{' '}
          {RING_TELEMETRY_BOUNDARY}
        </div>
      )}
      <div data-testid="ring-answer" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {result.answer}
      </div>
      <div data-testid="ring-deterministic-line" style={{ marginTop: 8, fontSize: 11, color: '#8b949e' }}>
        {deterministicLine}
      </div>
      {result.sources.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#60a5fa', marginBottom: 4 }}>
            Cited sources ({result.sources.length}):
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {result.sources.map((source, index) => (
              <div
                key={`${source.kind}-${source.path}-${index}`}
                data-testid="ring-source-item"
                style={{ fontSize: 11, color: '#c9d1d9' }}
              >
                [{source.kind}] {source.label} · <code>{source.path}</code>
              </div>
            ))}
          </div>
        </div>
      )}
      {deterministic.analysisId && (
        <CompletionRefusalDemo
          analysisId={deterministic.analysisId}
          reviewBusy={reviewBusy}
          reviewError={reviewError}
          actionsDisabled={false}
          onClaim={onClaim}
        />
      )}
      {reviewRun && (
        <div role="status" style={{ marginTop: 8, fontSize: 11 }}>
          Run {reviewRun.runId} · {reviewRun.status.replace('_', ' ')}
        </div>
      )}
      <RingVerifyCard transcript={verifyTranscript} />
    </div>
  );
};

export interface RingAskPanelProps {
  onResult?: (result: RingAskResult | null) => void;
  askFn?: (input: RingAskRequest) => Promise<RingAskResult>;
  verifyTranscript?: RingVerifyTranscript;
}

/**
 * Ring ask container. Owns the question input, the ask lifecycle, and a
 * Ring-owned TelemetryReviewCoordinator for the refusal beat (same
 * adapter/effects pattern the telemetry panel uses; per-mount instance).
 */
export const RingAskPanel: React.FC<RingAskPanelProps> = ({ onResult, askFn, verifyTranscript }) => {
  const [question, setQuestion] = useState('Why is turbine 7 above its vibration limit, and what do we do next?');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [result, setResult] = useState<RingAskResult | null>(null);
  const [reviewRun, setReviewRun] = useState<JudgedRunResponse | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const coordinatorRef = useRef<TelemetryReviewCoordinator | null>(null);
  if (!coordinatorRef.current) {
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

  const handleAsk = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setAskError(null);
    setReviewError(null);
    setReviewRun(null);
    try {
      const ask = askFn ?? ((input: RingAskRequest) => apiAdapter.ringAsk(input));
      const answer = await ask({ question: trimmed });
      setResult(answer);
      onResult?.(answer);
    } catch (err: unknown) {
      // No silent fallback: a failed ask leaves no result and surfaces the
      // error verbatim. No model ran on this path.
      setResult(null);
      onResult?.(null);
      setAskError((err as Error).message || 'Ring request failed. No model ran.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <section
      aria-label="Ring ask panel"
      data-testid="ring-ask-panel"
      style={{
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--border-color, #30363d)',
        background: 'var(--card-bg, #161b22)',
        marginBottom: 12,
      }}
    >
      <form onSubmit={handleAsk} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          type="text"
          aria-label="Ask Ring"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={asking}
          data-testid="ring-question-input"
          style={{
            flex: 1,
            padding: '9px 14px',
            borderRadius: 6,
            border: '1px solid var(--border-color, #444444)',
            backgroundColor: 'var(--bg-primary, #121212)',
            color: 'inherit',
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={asking || !question.trim()}
          data-testid="ring-ask-button"
          style={{ padding: '9px 18px', fontSize: 13 }}
        >
          {asking ? 'Asking…' : 'Ask Ring'}
        </button>
      </form>
      {askError && (
        <div role="alert" data-testid="ring-ask-error" style={{ marginTop: 8, color: '#ff7b72', fontSize: 12 }}>
          {askError}
        </div>
      )}
      {result && (
        <RingResultCard
          result={result}
          reviewBusy={reviewBusy}
          reviewError={reviewError}
          reviewRun={reviewRun}
          onClaim={(analysisId) => void coordinatorRef.current?.prepareReview(analysisId)}
          verifyTranscript={verifyTranscript ?? {}}
        />
      )}
    </section>
  );
};
