import React from 'react';

export interface CompletionRefusalDemoProps {
  analysisId: string;
  reviewBusy: boolean;
  reviewError: string | null;
  actionsDisabled: boolean;
  onClaim: (analysisId: string) => void;
}

/**
 * Completion-honesty demonstration (TASK W2). Offers a clearly labelled action
 * that asks the service to accept an analysis which has no agent tool work
 * behind it. The request goes to the real review-preparation gate
 * (POST /api/v1/industrial/judged-runs -> prepareAgentJudgedRun), which
 * refuses because no accepted agent report exists; the refusal reason is
 * shown verbatim. This component performs no requests itself and fabricates
 * no outcome: no tool output, no report, no success state is invented here.
 */
export const CompletionRefusalDemo: React.FC<CompletionRefusalDemoProps> = ({
  analysisId,
  reviewBusy,
  reviewError,
  actionsDisabled,
  onClaim,
}) => {
  const disabled = actionsDisabled || reviewBusy;
  return (
    <div style={{ marginTop: 12, border: '1px dashed #484f58', borderRadius: 6, padding: '9px 11px' }}>
      <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>
        Completion-honesty demonstration: this upload receipt has no agent tool work behind it,
        so asking the service to accept it must be refused.
      </div>
      <button
        type="button"
        aria-label="Try to claim completion without the required tool"
        disabled={disabled}
        onClick={() => onClaim(analysisId)}
        style={{ border: '1px solid #484f58', borderRadius: 6, padding: '9px 12px', background: disabled ? '#161b22' : '#21262d', color: '#e6edf3', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        Try to claim completion without the required tool
      </button>
      {reviewError && <div role="alert" style={{ marginTop: 8, color: '#ff7b72', fontSize: 11 }}>{reviewError}</div>}
    </div>
  );
};
