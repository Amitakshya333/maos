/**
 * TASK RING-IMPL-01 (updated by RING-UI-01): Ring hero surface.
 * Static-markup tests in the established ui1-25 pattern.
 *
 * Proves: chat is in INDUSTRIAL_DEMO_VIEWS; ActivityBar labels it Ring;
 * badge/banner copy is verbatim; the workspace shell renders the roster +
 * empty state instead of the deleted one-shot ask panel; the verify card
 * never invents output; the ask contract validator fails closed and never
 * invents served-model identity. Dynamic run/approval coverage lives in
 * tests/gui/ring-workspace.test.ts.
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
  RingEvidenceOnlyBanner,
  RingVerifyCard,
  RingWorkspace,
  ringBadgeText,
  ringRoleLabel,
} from '../../src/gui/src/components/RingWorkspace';
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

  it('keeps the exact hosted banner and telemetry-boundary copy (rendered dynamically by the workspace)', () => {
    expect(RING_HOSTED_BANNER).toBe('Meta model reasoning via Baseten. Company evidence stays in MAOS.');
    expect(RING_HOSTED_BANNER).toContain('Baseten');
    expect(RING_HOSTED_BADGE).toContain('meta-models/muse-spark-open-1026');
    expect(RING_TELEMETRY_BOUNDARY).toBe('raw telemetry never leaves MAOS; only the summary is sent');
  });

  it('renders the evidence-only banner stating no model wrote the answer and no model ran', () => {
    const html = renderToStaticMarkup(React.createElement(RingEvidenceOnlyBanner));

    expect(html).toContain('no model wrote this answer');
    expect(html).toContain('no model ran');
    expect(html).toContain('evidence-only mode');
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

describe('ring workspace shell', () => {
  it('renders the agent workspace (not the deleted one-shot ask panel)', () => {
    const html = renderToStaticMarkup(React.createElement(RingWorkspace, { pollIntervalMs: 60000 }));

    expect(html).toContain('data-testid="ring-workspace"');
    expect(html).toContain('data-testid="ring-agent-roster"');
    expect(html).toContain('data-testid="ring-empty-state"');
    expect(html).not.toContain('data-testid="ring-ask-panel"');
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
