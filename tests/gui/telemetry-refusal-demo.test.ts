/**
 * Completion-refusal demo UI (TASK W2). Static-markup tests in the established
 * ui1-25 pattern (renderToStaticMarkup; no DOM interaction harness exists).
 *
 * Proves the demo action is labelled, bound to the presented analysis, and
 * that a refusal reason renders verbatim. The click path delegates to the
 * existing TelemetryReviewCoordinator.prepareReview (covered by the
 * telemetry-review-coordinator suite); the refusal itself comes from the
 * real prepareAgentJudgedRun gate (covered by agent-review-refusal.test.ts).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompletionRefusalDemo } from '../../src/gui/src/components/CompletionRefusalDemo';
import { TelemetryReviewPanel } from '../../src/gui/src/components/TelemetryReviewPanel';

const ANALYSIS_ID = 'telemetry-1793000000000-abcdef12';
const LABEL = 'Try to claim completion without the required tool';

describe('completion refusal demo', () => {
  it('renders the labelled claim action for the presented analysis', () => {
    const html = renderToStaticMarkup(
      React.createElement(CompletionRefusalDemo, {
        analysisId: ANALYSIS_ID,
        reviewBusy: false,
        reviewError: null,
        actionsDisabled: false,
        onClaim: () => {},
      }),
    );

    expect(html).toContain(LABEL);
    expect(html).toContain(`aria-label="${LABEL}"`);
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('role="alert"');
  });

  it('disables the action while a request is busy or actions are disabled', () => {
    const busyHtml = renderToStaticMarkup(
      React.createElement(CompletionRefusalDemo, {
        analysisId: ANALYSIS_ID,
        reviewBusy: true,
        reviewError: null,
        actionsDisabled: false,
        onClaim: () => {},
      }),
    );
    const blockedHtml = renderToStaticMarkup(
      React.createElement(CompletionRefusalDemo, {
        analysisId: ANALYSIS_ID,
        reviewBusy: false,
        reviewError: null,
        actionsDisabled: true,
        onClaim: () => {},
      }),
    );

    expect(busyHtml).toContain('disabled');
    expect(blockedHtml).toContain('disabled');
  });

  it('shows the gate refusal reason verbatim when the claim is refused', () => {
    const reason = 'Accepted agent report was not found inside the active project.';
    const html = renderToStaticMarkup(
      React.createElement(CompletionRefusalDemo, {
        analysisId: ANALYSIS_ID,
        reviewBusy: false,
        reviewError: reason,
        actionsDisabled: false,
        onClaim: () => {},
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain(reason);
  });

  it('offers no claim action before any analysis exists', () => {
    const html = renderToStaticMarkup(React.createElement(TelemetryReviewPanel));

    expect(html).not.toContain(LABEL);
  });
});
