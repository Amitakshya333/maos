/**
 * Source-bound review state for the CSV telemetry panel (COMPLETION-FIX-04 finding 2).
 *
 * Pure helpers so the detach/staleness rules carry node-level regression coverage.
 * TelemetryReviewPanel wires them to React state. No DOM or React dependency here.
 */

export type TelemetrySourceDescriptor =
  { kind: 'file'; name: string; size: number; lastModified: number } | { kind: 'sample' };

/** Opaque key identifying the currently selected telemetry source. */
export function buildSourceKey(descriptor: TelemetrySourceDescriptor): string {
  if (descriptor.kind === 'sample') return 'sample';
  return `file:${descriptor.name}:${descriptor.size}:${descriptor.lastModified}`;
}

/** Every review field that must detach when the selected source changes. */
export interface SourceChangeReset {
  analysis: null;
  agentResult: null;
  agentPhase: 'idle';
  agentError: null;
  error: null;
  reviewRun: null;
  reviewError: null;
}

export function clearedOnSourceChange(): SourceChangeReset {
  return {
    analysis: null,
    agentResult: null,
    agentPhase: 'idle',
    agentError: null,
    error: null,
    reviewRun: null,
    reviewError: null,
  };
}

/**
 * Accept an asynchronous response only when its sequence still matches the
 * current source sequence. A source change bumps the sequence, so an older
 * in-flight response can never restore stale review state.
 */
export function isCurrentResponse(requestSeq: number, currentSeq: number): boolean {
  return requestSeq === currentSeq;
}

/**
 * A reconnected historical review may only populate the panel when no source
 * is currently selected. Once a source is selected, history stays reachable
 * through the Approvals queue/run views, never rebound to the new file.
 */
export function shouldApplyReconnect(selectedKey: string | null): boolean {
  return selectedKey === null;
}

/** The exact {file, key} pair created at selection time. */
export interface FileSelectionPair<F> {
  file: F;
  key: string;
}

/**
 * Panel selection binding (COMPLETION-FIX-16). Callbacks close over the pair
 * object returned by bind(); identity comparison (===) — not metadata — is
 * the staleness test, so a retained callback for a previous selection can
 * never pair its file with a newer selection's key.
 */
export class SelectionBinding<F> {
  private pair: FileSelectionPair<F> | null = null;

  bind(file: F, key: string): FileSelectionPair<F> {
    this.pair = { file, key };
    return this.pair;
  }

  clear(): void {
    this.pair = null;
  }

  current(): FileSelectionPair<F> | null {
    return this.pair;
  }

  /** True only when the presented pair is the exact object currently bound. */
  isCurrent(pair: FileSelectionPair<F> | null): boolean {
    return pair !== null && pair === this.pair;
  }
}

export type TelemetryReviewPhase = 'idle' | 'uploading' | 'requesting' | 'completed' | 'failed' | 'cancelled';

/** View-state patch shape applied to the panel (mirrors the coordinator's). */
export interface TelemetryReviewViewPatch {
  analysis?: unknown;
  agentResult?: unknown;
  agentPhase?: TelemetryReviewPhase;
  agentError?: string | null;
  error?: unknown;
  reviewRun?: unknown;
  reviewError?: string | null;
  busy?: boolean;
  busySource?: 'sample' | 'file' | null;
  reviewBusy?: boolean;
  clearFileInput?: boolean;
}

/** React setters the panel binds; the interpreter below is the only writer. */
export interface TelemetryReviewSetters {
  setAnalysis: (value: any) => void;
  setAgentResult: (value: any) => void;
  setAgentPhase: (value: TelemetryReviewPhase) => void;
  setAgentError: (value: string | null) => void;
  setError: (value: string | null) => void;
  setReviewRun: (value: any) => void;
  setReviewError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusySource: (value: 'sample' | 'file' | null) => void;
  setReviewBusy: (value: boolean) => void;
  setSelectedFile: (value: null) => void;
  bumpFileInputKey: () => void;
}

/**
 * The single interpreter from coordinator patches to React state
 * (COMPLETION-FIX-10 finding 5). The panel's sample button path funnels
 * through runSampleAnalysis → this interpreter, so the file/input clearing
 * it performs is covered by unit tests against the real mapping.
 */
export function applyReviewPatch(setters: TelemetryReviewSetters, patch: TelemetryReviewViewPatch): void {
  if ('analysis' in patch) setters.setAnalysis(patch.analysis ?? null);
  if ('agentResult' in patch) setters.setAgentResult(patch.agentResult ?? null);
  if ('agentPhase' in patch) setters.setAgentPhase(patch.agentPhase ?? 'idle');
  if ('agentError' in patch) setters.setAgentError(patch.agentError ?? null);
  if ('error' in patch) setters.setError((patch.error as string | null) ?? null);
  if ('reviewRun' in patch) setters.setReviewRun(patch.reviewRun ?? null);
  if ('reviewError' in patch) setters.setReviewError(patch.reviewError ?? null);
  if ('busy' in patch) setters.setBusy(patch.busy ?? false);
  if ('busySource' in patch) setters.setBusySource(patch.busySource ?? null);
  if ('reviewBusy' in patch) setters.setReviewBusy(patch.reviewBusy ?? false);
  if (patch.clearFileInput) {
    setters.setSelectedFile(null);
    setters.bumpFileInputKey();
  }
}
