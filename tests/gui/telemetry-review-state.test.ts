import { describe, expect, it, vi } from 'vitest';
import {
  applyReviewPatch,
  buildSourceKey,
  clearedOnSourceChange,
  isCurrentResponse,
  SelectionBinding,
  shouldApplyReconnect,
  type TelemetryReviewSetters,
} from '../../src/gui/src/components/telemetryReviewState';

describe('telemetry source-bound review state (COMPLETION-FIX-04 finding 2)', () => {
  it('detaches every review field on source change, including the saved review run', () => {
    const cleared = clearedOnSourceChange();

    expect(cleared).toEqual({
      analysis: null,
      agentResult: null,
      agentPhase: 'idle',
      agentError: null,
      error: null,
      reviewRun: null,
      reviewError: null,
    });
  });

  it('keys file and bundled-sample sources distinctly and stably', () => {
    const file = { kind: 'file', name: 'pilot.csv', size: 136, lastModified: 1793433790000 } as const;
    const sample = { kind: 'sample' } as const;

    expect(buildSourceKey(file)).toBe(buildSourceKey({ ...file }));
    expect(buildSourceKey(file)).not.toBe(buildSourceKey(sample));
    expect(buildSourceKey(file)).not.toBe(buildSourceKey({ ...file, size: 137 }));
    expect(buildSourceKey(file)).not.toBe(buildSourceKey({ ...file, lastModified: 1793433790001 }));
    expect(buildSourceKey({ ...file, name: 'other.csv' })).not.toBe(buildSourceKey(file));
  });

  it('rejects an older in-flight response after a source change', () => {
    let seq = 0;
    const beginRequest = () => ++seq;
    const selectNewSource = () => ++seq;

    const first = beginRequest();
    selectNewSource();
    const second = beginRequest();

    expect(isCurrentResponse(first, seq)).toBe(false);
    expect(isCurrentResponse(second, seq)).toBe(true);
  });

  it('keeps historical reviews out of a newly selected source', () => {
    expect(shouldApplyReconnect(null)).toBe(true);
    expect(shouldApplyReconnect('file:pilot.csv:136:1793433790000')).toBe(false);
    expect(shouldApplyReconnect('sample')).toBe(false);
  });

  it('applies coordinator patches to panel state, including file/input clearing', () => {
    const setters: TelemetryReviewSetters & Record<string, ReturnType<typeof vi.fn>> = {
      setAnalysis: vi.fn(),
      setAgentResult: vi.fn(),
      setAgentPhase: vi.fn(),
      setAgentError: vi.fn(),
      setError: vi.fn(),
      setReviewRun: vi.fn(),
      setReviewError: vi.fn(),
      setBusy: vi.fn(),
      setBusySource: vi.fn(),
      setReviewBusy: vi.fn(),
      setSelectedFile: vi.fn(),
      bumpFileInputKey: vi.fn(),
    };
    const apply = (patch: Parameters<typeof applyReviewPatch>[1]) => applyReviewPatch(setters, patch);

    apply({ clearFileInput: true } as never);
    expect(setters.setSelectedFile).toHaveBeenCalledWith(null);
    expect(setters.bumpFileInputKey).toHaveBeenCalledTimes(1);
    expect(setters.setAnalysis).not.toHaveBeenCalled();

    apply({ agentPhase: 'uploading', busy: true, busySource: 'sample' });
    expect(setters.setAgentPhase).toHaveBeenCalledWith('uploading');
    expect(setters.setBusy).toHaveBeenCalledWith(true);
    expect(setters.setBusySource).toHaveBeenCalledWith('sample');

    apply({ analysis: { analysisId: 'telemetry-1' }, agentPhase: 'completed' } as never);
    expect(setters.setAnalysis).toHaveBeenCalledWith({ analysisId: 'telemetry-1' });
    expect(setters.setAgentPhase).toHaveBeenCalledWith('completed');
  });
});

describe('panel selection binding (COMPLETION-FIX-16)', () => {
  it('binds the exact {file, key} pair and stale pairs fail identity', () => {
    const binding = new SelectionBinding<{ name: string }>();
    const fileA = { name: 'a.csv' };
    const fileB = { name: 'a.csv' }; // identical metadata, distinct object

    const pairA = binding.bind(fileA, 'file#1:a.csv:136:1');
    expect(binding.current()).toBe(pairA);
    expect(binding.isCurrent(pairA)).toBe(true);

    const pairB = binding.bind(fileB, 'file#2:a.csv:136:1');
    expect(pairB).not.toBe(pairA);
    expect(binding.isCurrent(pairA)).toBe(false);
    expect(binding.isCurrent(pairB)).toBe(true);
    expect(binding.current()).toBe(pairB);
    // A retained stale callback holding pairA can never present B's key
    // with A's file: identity, not metadata, decides.
    expect(pairA.key).not.toBe(pairB.key);
  });

  it('reselecting the same file object mints a new pair identity', () => {
    const binding = new SelectionBinding<{ name: string }>();
    const file = { name: 'a.csv' };
    const first = binding.bind(file, 'file#1:a.csv:136:1');
    const second = binding.bind(file, 'file#2:a.csv:136:1');
    expect(second).not.toBe(first);
    expect(binding.isCurrent(first)).toBe(false);
    expect(binding.isCurrent(second)).toBe(true);
  });

  it('clear detaches the pair so no callback can act', () => {
    const binding = new SelectionBinding<{ name: string }>();
    const pair = binding.bind({ name: 'a.csv' }, 'file#1:a.csv:136:1');
    binding.clear();
    expect(binding.current()).toBeNull();
    expect(binding.isCurrent(pair)).toBe(false);
    expect(binding.isCurrent(null)).toBe(false);
  });
});
