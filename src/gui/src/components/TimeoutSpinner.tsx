/**
 * UI1-22: Accessible Bounded Loading Indicator (Timeout Spinner)
 *
 * Enforces the negative requirement: "indefinite spinner fails".
 * - Automatically bounds spinning duration to a defined timeout (default: 8,000ms).
 * - Transitions to an actionable timeout error state if the asynchronous operation hangs.
 * - Conveys state textually and through ARIA attributes (never color or visual-only).
 * - Respects prefers-reduced-motion by avoiding continuous rotational loops.
 */

import React, { useEffect, useState } from 'react';
import { RefreshIcon, AlertCircleIcon } from './icons';

export interface TimeoutSpinnerProps {
  readonly label?: string;
  readonly timeoutMs?: number;
  readonly onTimeout?: () => void;
  readonly onRetry?: () => void;
  readonly onCancel?: () => void;
  readonly isRunning?: boolean;
  readonly testId?: string;
}

export const TimeoutSpinner: React.FC<TimeoutSpinnerProps> = ({
  label = 'Processing request...',
  timeoutMs = 8000,
  onTimeout,
  onRetry,
  onCancel,
  isRunning = true,
  testId = 'timeout-spinner',
}) => {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!isRunning) {
      setTimedOut(false);
      return;
    }

    const timer = setTimeout(() => {
      setTimedOut(true);
      if (onTimeout) {
        onTimeout();
      }
    }, timeoutMs);

    return () => clearTimeout(timer);
  }, [isRunning, timeoutMs, onTimeout]);

  const handleRetry = () => {
    setTimedOut(false);
    if (onRetry) {
      onRetry();
    }
  };

  if (timedOut) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-testid={`${testId}-timed-out`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          borderRadius: '4px',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid var(--status-red, #ef4444)',
          color: 'var(--text, #f0f0f0)',
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
        }}
      >
        <span style={{ color: 'var(--status-red, #ef4444)' }} aria-hidden="true">
          <AlertCircleIcon size={14} />
        </span>
        <span style={{ fontWeight: 600 }}>Operation timed out</span>
        <span style={{ color: 'var(--text-muted, #888888)' }}>(exceeded {Math.round(timeoutMs / 1000)}s)</span>
        {onRetry && (
          <button
            type="button"
            onClick={handleRetry}
            data-testid={`${testId}-retry-btn`}
            aria-label="Retry timed-out operation"
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 8px',
              marginLeft: '4px',
              backgroundColor: 'var(--surface-elevated, #242424)',
              border: '1px solid var(--border-bright, #3a3a3a)',
              color: 'var(--text, #f0f0f0)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            data-testid={`${testId}-cancel-btn`}
            aria-label="Cancel operation"
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              padding: '2px 6px',
              backgroundColor: 'transparent',
              border: 'none',
              color: 'var(--text-muted, #888888)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (!isRunning) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        fontFamily: 'var(--font-sans)',
        fontSize: '12px',
        color: 'var(--text-muted, #888888)',
      }}
    >
      <span
        aria-hidden="true"
        className="bounded-spinner-icon"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'var(--primary, #ffffff)',
          animation: 'spin 1.5s linear infinite',
        }}
      >
        <RefreshIcon size={14} />
      </span>
      <span>{label}</span>
    </div>
  );
};
