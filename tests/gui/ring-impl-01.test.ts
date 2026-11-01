/**
 * TASK RING-IMPL-01: Ring hero surface (GUI consumer side).
 * Static-markup tests in the established ui1-25 pattern
 * (renderToStaticMarkup; no DOM interaction harness exists).
 *
 * Proves: chat is in INDUSTRIAL_DEMO_VIEWS; ActivityBar labels it Ring;
 * badge/banner copy is verbatim; Ring results render sources +
 * deterministic line + refusal in both modes; the verify card never
 * invents output; the contract validator fails closed and never invents
 * served-model identity.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityBar, INDUSTRIAL_DEMO_VIEWS } from '../../src/gui/src/components/ActivityBar';
import { LayoutProvider } from '../../src/gui/src/components/LayoutContext';
import {
  RING_EVIDENCE_ONLY_BADGE,
  RING_HOSTED_BADGE,
  RING_HOSTED_BANNER,
  RING_NO_EXPORT_VERIFIED,
  RING_TELEMETRY_BOUNDARY,
  RingAskPanel,
  RingEvidenceOnlyBanner,
  RingHostedBanner,
  RingResultCard,
  RingVerifyCard,
  ringBadgeText,
  ringRoleLabel,
} from '../../src/gui/src/components/RingAskPanel';
import type { RingAskResult } from '../../src/gui/src/api/ring-types';
import { validateRingAskResult } from '../../src/gui/src/api/ring-types';

const HOSTED_RESULT: RingAskResult = {
  mode: 'hosted',
  providerName: 'Baseten',
  modelId: 'meta-models/muse-spark-open-1026',
  answer: 'Turbine 7 exceeded its demo vibration limit at rows 12 and 40.',
  sources: [
    { kind: 'sop', label: 'SOP-TURBINE-VIB-DEMO-V1 §4', path: 'demo/industrial/sop_turbine_vibration_monitoring.md' },
    { kind: 'incident', label: 'MR-T07-2026-0822', path: 'demo/industrial/maintenance_report.txt' },
    { kind: 'telemetry', label: 'T-07 vibration log', path: 'demo/industrial/turbine_vibration_log.csv' },
  ],
  deterministic: {
    attempted: true,
    verdict: 'WARNING',
    overallRms: 4.125,
    analysisId: 'telemetry-1793000000000-abcdef12',
  },
  refusalTest: { prepared: false },
};

const EVIDENCE_ONLY_RESULT: RingAskResult = {
  mode: 'evidence-only',
  answer: 'Local evidence summary: WARNING verdict, RMS 4.125 mm/s. No model ran.',
  sources: [{ kind: 'telemetry', label: 'T-07 vibration log', path: 'demo/industrial/turbine_vibration_log.csv' }],
  deterministic: {
    attempted: true,
    verdict: 'WARNING',
    overallRms: 4.125,
    analysisId: 'telemetry-1793000000000-abcdef12',
  },
  refusalTest: { prepared: false },
};

describe('ring demo visibility', () => {
  it('includes chat in INDUSTRIAL_DEMO_VIEWS with Ring first as the hero surface', () => {
    expect([...INDUSTRIAL_DEMO_VIEWS]).toContain('chat');
    expect(INDUSTRIAL_DEMO_VIEWS[0]).toBe('chat');
  });

  it('labels the chat entry Ring in industrial demo mode', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        LayoutProvider,
        { autoFetch: false },
        React.createElement(ActivityBar, { activeView: 'chat', onSelectView: () => {}, industrialDemo: true }),
      ),
    );

    expect(html).toContain('data-testid="activity-btn-chat"');
    expect(html).toContain('Ring (Alt+1)');
    expect(html).not.toContain('Chat &amp; Sessions');
    expect(html).not.toContain('Chat & Sessions');
  });
});

describe('ring identity copy', () => {
  it('attributes assistant messages to RING and leaves user attribution unchanged', () => {
    expect(ringRoleLabel('assistant')).toBe('RING');
    expect(ringRoleLabel('user')).toBe('user');
  });

  it('shows the exact hosted badge and appends the served id only from server echo', () => {
    expect(ringBadgeText(HOSTED_RESULT, 'LOCAL: None')).toBe(RING_HOSTED_BADGE);
    expect(RING_HOSTED_BADGE).toBe('HOSTED · meta-models/muse-spark-open-1026 via Baseten');
    expect(ringBadgeText(HOSTED_RESULT, 'LOCAL: None')).not.toContain('reported');

    const echoed: RingAskResult = { ...HOSTED_RESULT, servedModelId: 'meta-models/muse-spark-open-1026' };
    expect(ringBadgeText(echoed, 'LOCAL: None')).toBe(
      'HOSTED · meta-models/muse-spark-open-1026 via Baseten · reported meta-models/muse-spark-open-1026',
    );
  });

  it('shows the exact evidence-only badge and keeps the local badge before any ask', () => {
    expect(ringBadgeText(EVIDENCE_ONLY_RESULT, 'LOCAL: None')).toBe(RING_EVIDENCE_ONLY_BADGE);
    expect(RING_EVIDENCE_ONLY_BADGE).toBe('EVIDENCE-ONLY · no model configured');
    expect(ringBadgeText(null, 'CUDA: qwen2.5-3b-instruct-local')).toBe('CUDA: qwen2.5-3b-instruct-local');
  });

  it('renders the exact hosted banner with identity and telemetry boundary', () => {
    const html = renderToStaticMarkup(React.createElement(RingHostedBanner, { result: HOSTED_RESULT }));

    expect(html).toContain(RING_HOSTED_BANNER);
    expect(RING_HOSTED_BANNER).toBe('Meta model reasoning via Baseten. Company evidence stays in MAOS.');
    expect(html).toContain('Baseten');
    expect(html).toContain('meta-models/muse-spark-open-1026');
    expect(html).toContain(RING_TELEMETRY_BOUNDARY);
    expect(RING_TELEMETRY_BOUNDARY).toBe('raw telemetry never leaves MAOS; only the summary is sent');
  });

  it('renders the evidence-only banner stating no model wrote the answer and no model ran', () => {
    const html = renderToStaticMarkup(React.createElement(RingEvidenceOnlyBanner));

    expect(html).toContain('no model wrote this answer');
    expect(html).toContain('no model ran');
    expect(html).toContain('evidence-only mode');
  });
});

describe('ring result rendering', () => {
  function renderCard(result: RingAskResult, extra?: { reviewError?: string | null }) {
    return renderToStaticMarkup(
      React.createElement(RingResultCard, {
        result,
        reviewBusy: false,
        reviewError: extra?.reviewError ?? null,
        reviewRun: null,
        onClaim: () => {},
        verifyTranscript: {},
      }),
    );
  }

  it('renders hosted answers with sources, deterministic line, and the refusal action', () => {
    const html = renderCard(HOSTED_RESULT);

    expect(html).toContain('Turbine 7 exceeded its demo vibration limit');
    expect(html).toContain('SOP-TURBINE-VIB-DEMO-V1 §4');
    expect(html).toContain('demo/industrial/sop_turbine_vibration_monitoring.md');
    expect(html).toContain('MR-T07-2026-0822');
    expect(html).toContain('demo/industrial/turbine_vibration_log.csv');
    expect(html).toContain('ring-source-item');
    expect(html).toContain('Deterministic: WARNING · RMS 4.125 · telemetry-1793000000000-abcdef12');
    expect(html).toContain('Try to claim completion without the required tool');
    expect(html).toContain(RING_TELEMETRY_BOUNDARY);
  });

  it('renders evidence-only answers as-is with the no-model note and deterministic line', () => {
    const html = renderCard(EVIDENCE_ONLY_RESULT);

    expect(html).toContain('Local evidence summary: WARNING verdict, RMS 4.125 mm/s. No model ran.');
    expect(html).toContain('No model wrote this answer and no model ran');
    expect(html).toContain('Deterministic: WARNING · RMS 4.125 · telemetry-1793000000000-abcdef12');
    expect(html).toContain('T-07 vibration log');
  });

  it('shows the gate refusal text verbatim when the Ring claim is refused', () => {
    const reason = 'Accepted agent report was not found inside the active project.';
    const html = renderCard(HOSTED_RESULT, { reviewError: reason });

    expect(html).toContain('role="alert"');
    expect(html).toContain(reason);
  });

  it('offers no refusal action when no deterministic analysis id exists', () => {
    const noAnalysis: RingAskResult = {
      ...HOSTED_RESULT,
      deterministic: { attempted: false },
    };
    const html = renderCard(noAnalysis);

    expect(html).not.toContain('Try to claim completion without the required tool');
    expect(html).toContain('Deterministic: not attempted');
  });
});

describe('ring verify card', () => {
  it('shows the fallback when no export has been verified', () => {
    const html = renderToStaticMarkup(React.createElement(RingVerifyCard, { transcript: {} }));

    expect(html).toContain(RING_NO_EXPORT_VERIFIED);
    expect(RING_NO_EXPORT_VERIFIED).toBe('No export verified yet.');
    expect(html).not.toContain('PASS');
  });

  it('renders provided audit and export transcript lines verbatim', () => {
    const html = renderToStaticMarkup(
      React.createElement(RingVerifyCard, {
        transcript: {
          runId: 'judged-run-agent-abc123',
          auditOutput: '{"target":"audit","verification":{"valid":true}}',
          exportPath: 'artifacts/audit-export.json',
          exportPassLine: 'Verification: PASS · 12 records',
        },
      }),
    );

    expect(html).toContain('maos-industrial verify audit --run-id judged-run-agent-abc123 --json');
    // Static markup HTML-escapes quotes; the escaped form proves the verbatim content.
    expect(html).toContain('{&quot;target&quot;:&quot;audit&quot;,&quot;verification&quot;:{&quot;valid&quot;:true}}');
    expect(html).toContain('verify export artifacts/audit-export.json');
    expect(html).toContain('Verification: PASS · 12 records');
  });
});

describe('ring ask panel shell', () => {
  it('renders the ask control with no result card before any ask', () => {
    const html = renderToStaticMarkup(React.createElement(RingAskPanel));

    expect(html).toContain('data-testid="ring-ask-panel"');
    expect(html).toContain('Ask Ring');
    expect(html).not.toContain('data-testid="ring-result-card"');
  });
});

describe('ring contract validator', () => {
  it('accepts valid hosted and evidence-only results without inventing identity', () => {
    expect(validateRingAskResult(HOSTED_RESULT).mode).toBe('hosted');
    expect(validateRingAskResult(EVIDENCE_ONLY_RESULT).mode).toBe('evidence-only');
    expect('servedModelId' in validateRingAskResult(HOSTED_RESULT)).toBe(false);
  });

  it('fails closed on shape violations', () => {
    expect(() => validateRingAskResult({ ...HOSTED_RESULT, mode: 'streaming' })).toThrow('RING_ASK_INVALID');
    expect(() => validateRingAskResult({ ...HOSTED_RESULT, answer: '' })).toThrow('RING_ASK_INVALID');
    expect(() =>
      validateRingAskResult({ ...HOSTED_RESULT, sources: [{ kind: 'wiki', label: 'x', path: 'y' }] }),
    ).toThrow('RING_ASK_INVALID');
    expect(() => validateRingAskResult({ ...HOSTED_RESULT, deterministic: { attempted: 'yes' } })).toThrow(
      'RING_ASK_INVALID',
    );
    expect(() => validateRingAskResult({ ...HOSTED_RESULT, servedModelId: '  ' })).toThrow('RING_ASK_INVALID');
  });
});
