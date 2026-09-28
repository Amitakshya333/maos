/**
 * UI1-22: Actionable Error Banner Component
 *
 * Provides accessible, actionable recovery error states across the six required domains:
 * 1. reconnect: Network/WebSocket interruption, retry countdown, reconnect action.
 * 2. offline: Zero-cloud sovereignty boundary violation, local boundary explanation.
 * 3. approval: Gate rejection, role mismatch (lead/engineer required), review action.
 * 4. service: Service host crash, PID/process exit, restart action.
 * 5. model: Model OOM, lease expiration, switch model action.
 * 6. sandbox: Sandbox execution failure, nonzero exit, view trace action.
 *
 * Enforces negative requirements:
 * - Zero raw stack traces or internal source line leakage.
 * - Zero credential or token leakage (redacts secrets).
 * - Zero color-only status (always paired with icon and human-readable text label).
 * - Full keyboard navigation and ARIA live-region announcements.
 */

import React from 'react';
import { AlertCircleIcon, ShieldIcon, RefreshIcon, CloseIcon } from './icons';
import { redactSensitiveString } from '../../../core/redaction';

export type ActionableErrorCategory =
  | 'reconnect'
  | 'offline'
  | 'approval'
  | 'service'
  | 'model'
  | 'sandbox'
  | 'general';

export interface ActionableErrorAction {
  readonly label: string;
  readonly onClick: () => void | Promise<void>;
  readonly primary?: boolean;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

export interface ActionableErrorProps {
  readonly category: ActionableErrorCategory;
  readonly title: string;
  readonly message: string;
  readonly code?: string;
  readonly details?: string;
  readonly actions?: ActionableErrorAction[];
  readonly dismissible?: boolean;
  readonly onDismiss?: () => void;
  readonly isAssertive?: boolean;
  readonly testId?: string;
}

/**
 * Sanitizes user-facing error text by stripping internal stack traces,
 * file paths, and redacting credentials/tokens.
 */
export function sanitizeUserFacingError(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return 'An unexpected error occurred.';

  // 1. Redact credentials/tokens/keys
  let sanitized = redactSensitiveString(rawText).sanitized;

  // 2. Strip V8/Node stack traces (e.g. "at Object.<anonymous> (/path/file.ts:12:34)")
  sanitized = sanitized.replace(/\s*at\s+.*(?:\r?\n|$)/g, ' ');

  // 3. Strip internal file system paths with line numbers (e.g. "C:\maos\src\...:123:45")
  sanitized = sanitized.replace(/(?:[a-zA-Z]:\\|\/)[^\s:]+\.(?:ts|js|jsx|tsx):\d+(?::\d+)?/g, '[source]');

  // 4. Clean up whitespace
  return sanitized.trim();
}

/**
 * Maps error categories to human-readable textual badge labels and guidance.
 */
export const CATEGORY_METADATA: Record<
  ActionableErrorCategory,
  { badge: string; defaultGuidance: string; icon: React.FC<{ size?: number }> }
> = {
  reconnect: {
    badge: 'CONNECTION INTERRUPTED',
    defaultGuidance: 'The loopback service connection was lost. Automatic reconnection is active.',
    icon: RefreshIcon,
  },
  offline: {
    badge: 'OFFLINE BOUNDARY DEFENSE',
    defaultGuidance: 'Execution blocked to enforce zero-cloud boundary. No external requests are permitted.',
    icon: ShieldIcon,
  },
  approval: {
    badge: 'APPROVAL REQUIRED',
    defaultGuidance: 'This operation requires human lead or safety engineer authorization before proceeding.',
    icon: AlertCircleIcon,
  },
  service: {
    badge: 'SERVICE FAULT',
    defaultGuidance: 'The local project service host encountered an unrecoverable fault or stopped.',
    icon: AlertCircleIcon,
  },
  model: {
    badge: 'MODEL RESOURCE EXHAUSTED',
    defaultGuidance: 'The local inference model encountered a memory limit or lease expiration.',
    icon: AlertCircleIcon,
  },
  sandbox: {
    badge: 'SANDBOX EXECUTION FAILED',
    defaultGuidance: 'Container execution finished with a nonzero exit code or validation failure.',
    icon: AlertCircleIcon,
  },
  general: {
    badge: 'ACTION REQUIRED',
    defaultGuidance: 'An operational fault was detected. Review details and select a recovery action.',
    icon: AlertCircleIcon,
  },
};

export const ActionableErrorBanner: React.FC<ActionableErrorProps> = ({
  category,
  title,
  message,
  code,
  details,
  actions = [],
  dismissible = false,
  onDismiss,
  isAssertive = true,
  testId = 'actionable-error-banner',
}) => {
  const meta = CATEGORY_METADATA[category] || CATEGORY_METADATA.general;
  const IconComponent = meta.icon;
  const safeMessage = sanitizeUserFacingError(message);
  const safeDetails = details ? sanitizeUserFacingError(details) : undefined;

  return (
    <div
      role="alert"
      aria-live={isAssertive ? 'assertive' : 'polite'}
      data-testid={testId}
      data-category={category}
      className={`actionable-error-banner actionable-error-${category}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 16px',
        backgroundColor: 'var(--surface-elevated, #1a1a1a)',
        border: '1px solid var(--status-red, #ef4444)',
        borderLeft: '4px solid var(--status-red, #ef4444)',
        borderRadius: '4px',
        margin: '8px 0',
        color: 'var(--text, #f0f0f0)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Header Row: Category Badge + Title + Optional Close */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            aria-hidden="true"
            style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--status-red, #ef4444)' }}
          >
            <IconComponent size={16} />
          </span>
          <span
            className="error-category-badge"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '2px 6px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid var(--status-red, #ef4444)',
              borderRadius: '3px',
              color: 'var(--status-red, #ef4444)',
            }}
          >
            {meta.badge}
          </span>
          {code && (
            <span
              className="error-code-badge"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--text-muted, #888888)',
              }}
            >
              {`[${code}]`}
            </span>
          )}
          <h4
            style={{
              margin: 0,
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text, #f0f0f0)',
            }}
          >
            {title}
          </h4>
        </div>

        {dismissible && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            title="Dismiss error"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted, #888888)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '3px',
            }}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {/* Message Body */}
      <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.4, color: 'var(--text, #f0f0f0)' }}>
        {safeMessage}
      </p>

      {/* Safe Non-Technical Details */}
      {safeDetails && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--text-muted, #888888)',
            backgroundColor: 'var(--surface, #0a0a0a)',
            padding: '6px 8px',
            borderRadius: '3px',
            border: '1px solid var(--border, #222222)',
            wordBreak: 'break-word',
          }}
        >
          {safeDetails}
        </div>
      )}

      {/* Actionable Recovery Buttons */}
      {actions.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '4px',
            flexWrap: 'wrap',
          }}
        >
          {actions.map((act, index) => (
            <button
              key={`${act.label}-${index}`}
              type="button"
              data-testid={act.testId || `error-action-${index}`}
              aria-label={act.ariaLabel || act.label}
              onClick={act.onClick}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '12px',
                fontWeight: 600,
                padding: '4px 12px',
                borderRadius: '3px',
                cursor: 'pointer',
                border: act.primary ? '1px solid var(--primary, #ffffff)' : '1px solid var(--border-bright, #3a3a3a)',
                backgroundColor: act.primary ? 'var(--primary, #ffffff)' : 'var(--surface, #0a0a0a)',
                color: act.primary ? 'var(--primary-contrast, #000000)' : 'var(--text, #f0f0f0)',
                outline: 'none',
              }}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
