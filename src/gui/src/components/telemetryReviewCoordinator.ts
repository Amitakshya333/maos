/**
 * Async/state coordination for the CSV telemetry panel (COMPLETION-FIX-06/08).
 *
 * TelemetryReviewPanel delegates every review side effect to this coordinator,
 * which owns the source binding, per-operation identities, and staleness
 * guards. Deferred-promise tests drive this exact implementation with fake
 * adapters — not a parallel simulation.
 *
 * REQUIRED INVARIANT: every asynchronous operation captures the source
 * identity/lifetime and a per-operation request identity, and checks BOTH
 * before EVERY state or external side effect. Only the current operation may
 * update results, errors, phase, busy flags, storage, or navigation. Stale
 * operations do nothing. Cancellation supplements these guards; it never
 * replaces them.
 *
 * No DOM dependency here; React state stays in the panel behind `apply`.
 */
import type {
  IndustrialAnalysisAgentResponse,
  IndustrialTelemetryAnalysisResponse,
  JudgedRunResponse,
} from '../api/rest-client';
import { clearedOnSourceChange, isCurrentResponse, shouldApplyReconnect } from './telemetryReviewState';

export type TelemetryAgentPhase = 'idle' | 'uploading' | 'requesting' | 'completed' | 'failed' | 'cancelled';

export interface TelemetryReviewViewState {
  analysis: IndustrialTelemetryAnalysisResponse | null;
  agentResult: IndustrialAnalysisAgentResponse | null;
  agentPhase: TelemetryAgentPhase;
  agentError: string | null;
  error: string | null;
  reviewRun: JudgedRunResponse | null;
  reviewError: string | null;
  busy: boolean;
  busySource: 'sample' | 'file' | null;
  reviewBusy: boolean;
  /** One-shot: the active source is no longer a file; detach file UI state. */
  clearFileInput?: boolean;
}

export interface TelemetryFileSubmit {
  name: string;
  size: number;
  lastModified: number;
  contentBase64: string;
}

export interface TelemetryFileDescriptor {
  name: string;
  size: number;
  lastModified: number;
}

export interface TelemetryReviewAdapter {
  analyzeTelemetry(
    input: { name?: string; contentBase64?: string; useBundledSample?: boolean },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IndustrialTelemetryAnalysisResponse>;
  analyzeCsv(
    input: { request: string; sourcePath: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IndustrialAnalysisAgentResponse>;
  prepareReview(analysisId: string): Promise<JudgedRunResponse>;
  getJudgedRun(runId: string): Promise<JudgedRunResponse>;
}

export interface TelemetryReviewEffects {
  apply(patch: Partial<TelemetryReviewViewState>): void;
  readSavedRunId(): string | null;
  writeSavedRunId(runId: string): void;
  navigateToApprovals(): void;
}

interface CapturedOperation {
  key: string | null;
  seq: number;
  opId: number;
}

const SAVED_RUN_PREFIX = 'judged-run-agent-';
const ANALYSIS_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 65_000;
const CANCELLED_MESSAGE = 'Cancelled. No successful model result was returned; retry to start a new run.';

export class TelemetryReviewCoordinator {
  private sourceKey: string | null = null;
  private sourceKind: 'file' | 'sample' | null = null;
  private sourceDescriptor: TelemetryFileDescriptor | null = null;
  private sourceSeq = 0;
  private selectionUid = 0;
  private analysisOpId = 0;
  private askOpId = 0;
  private reviewOpId = 0;
  private reconnectOpId = 0;

  constructor(
    private readonly adapter: TelemetryReviewAdapter,
    private readonly effects: TelemetryReviewEffects,
  ) {}

  /** Currently bound active-source identity, if any. */
  getActiveSourceKey(): string | null {
    return this.sourceKey;
  }

  /**
   * Invalidate all pending coordinator work (panel unmount). Sequence-based
   * only, so remounting stays safe: late resolves become stale and apply
   * nothing — no detached-component updates, storage writes, or navigation.
   */
  dispose(): void {
    this.sourceSeq += 1;
  }

  /** Bind an uploaded file (or detach with null) and clear all review state. Returns the unique selection identity. */
  selectFile(descriptor: TelemetryFileDescriptor | null): string | null {
    this.sourceSeq += 1;
    if (descriptor === null) {
      this.sourceKey = null;
      this.sourceKind = null;
      this.sourceDescriptor = null;
    } else {
      this.selectionUid += 1;
      this.sourceDescriptor = descriptor;
      this.sourceKind = 'file';
      this.sourceKey = `file#${this.selectionUid}:${descriptor.name}:${descriptor.size}:${descriptor.lastModified}`;
    }
    // A source change also releases preparation busy state: any pending
    // prepare belongs to the detached source and its finish is guarded, so
    // the new source is never blocked by stale busy.
    this.effects.apply({ ...clearedOnSourceChange(), busy: false, busySource: null, reviewBusy: false });
    return this.sourceKey;
  }

  /** Bind the bundled synthetic sample as the single active source. Returns the unique selection identity. */
  selectSample(): string {
    this.sourceSeq += 1;
    this.selectionUid += 1;
    this.sourceDescriptor = null;
    this.sourceKind = 'sample';
    this.sourceKey = `sample#${this.selectionUid}`;
    this.effects.apply({
      ...clearedOnSourceChange(),
      busy: false,
      busySource: null,
      reviewBusy: false,
      clearFileInput: true,
    });
    return this.sourceKey;
  }

  private capture(opId: number): CapturedOperation {
    return { key: this.sourceKey, seq: this.sourceSeq, opId };
  }

  private fresh(lifetime: CapturedOperation, latestOpId: number): boolean {
    return (
      lifetime.opId === latestOpId && lifetime.key === this.sourceKey && isCurrentResponse(lifetime.seq, this.sourceSeq)
    );
  }

  /**
   * The single panel entrypoint for the sample action: binding the sample is
   * atomic with starting its analysis, so no caller can analyze without a
   * bound sample identity. Clears any previously selected file/input and
   * invalidates prior preparation/analysis/ask operations via the new
   * sequence. Historical reviews stay reachable through Approvals, never
   * rebound here.
   */
  async runSampleAnalysis(): Promise<void> {
    this.selectSample();
    const opId = ++this.analysisOpId;
    const lifetime = this.capture(opId);
    this.effects.apply({ busy: true, busySource: 'sample' });
    try {
      const response = await this.adapter.analyzeTelemetry(
        { useBundledSample: true },
        { timeoutMs: ANALYSIS_TIMEOUT_MS },
      );
      if (!this.fresh(lifetime, this.analysisOpId)) return;
      this.effects.apply({ analysis: response });
    } catch (err: unknown) {
      if (!this.fresh(lifetime, this.analysisOpId)) return;
      this.effects.apply({ error: (err as Error).message || 'Telemetry analysis failed.' });
    } finally {
      if (this.fresh(lifetime, this.analysisOpId)) {
        this.effects.apply({ busy: false, busySource: null });
      }
    }
  }

  /**
   * Deterministic analysis of a file: the caller passes the selection identity
   * bound at selection time and never a key fetched later. A stale entry
   * (another selection happened since) is refused. The identity is NOT
   * renewed here — selection is the single binding point, so a stored
   * {file, key} pair stays valid until the next selection. Encoder failures
   * surface only when this operation is still current.
   */
  async runFileAnalysis(selectionKey: string | null, readFile: () => Promise<TelemetryFileSubmit>): Promise<void> {
    if (selectionKey === null || selectionKey !== this.sourceKey || this.sourceKind !== 'file') return;
    const descriptor = this.sourceDescriptor;
    if (!descriptor) return;
    this.sourceSeq += 1;
    this.effects.apply({ ...clearedOnSourceChange(), busy: false, busySource: null, reviewBusy: false });
    const opId = ++this.analysisOpId;
    const lifetime = this.capture(opId);
    this.effects.apply({ busy: true, busySource: 'file' });
    let file: TelemetryFileSubmit;
    try {
      file = await readFile();
    } catch (err: unknown) {
      if (!this.fresh(lifetime, this.analysisOpId)) return;
      this.effects.apply({
        error: (err as Error).message || 'Telemetry analysis failed.',
        busy: false,
        busySource: null,
      });
      return;
    }
    if (!this.fresh(lifetime, this.analysisOpId)) return;
    try {
      const response = await this.adapter.analyzeTelemetry(
        { name: file.name, contentBase64: file.contentBase64 },
        { timeoutMs: ANALYSIS_TIMEOUT_MS },
      );
      if (!this.fresh(lifetime, this.analysisOpId)) return;
      this.effects.apply({ analysis: response });
    } catch (err: unknown) {
      if (!this.fresh(lifetime, this.analysisOpId)) return;
      this.effects.apply({ error: (err as Error).message || 'Telemetry analysis failed.' });
    } finally {
      if (this.fresh(lifetime, this.analysisOpId)) {
        this.effects.apply({ busy: false, busySource: null });
      }
    }
  }

  /**
   * Agent analysis of the actively bound file. Refuses when the presented
   * selection identity is stale or when the active source is not a file
   * (e.g. the bundled sample was selected instead), so no request for a
   * detached file can run under a sample identity. Ownership starts before
   * file encoding; the deferred reader runs inside the guarded operation.
   */
  async askAboutCsv(
    request: string,
    selectionKey: string | null,
    readFile: () => Promise<TelemetryFileSubmit>,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    // Validate BEFORE allocating the operation identity: rejecting a stale
    // entry must not burn the current operation's id and invalidate a
    // valid in-flight ask (COMPLETION-FIX-16).
    if (selectionKey === null || selectionKey !== this.sourceKey || this.sourceKind !== 'file') return;
    const opId = ++this.askOpId;
    const lifetime = this.capture(opId);
    this.effects.apply({
      agentResult: null,
      reviewRun: null,
      reviewError: null,
      analysis: null,
      agentError: null,
      agentPhase: 'uploading',
    });
    let file: TelemetryFileSubmit;
    try {
      file = await readFile();
    } catch (err: unknown) {
      if (options.signal?.aborted) {
        // Cancelled while encoding: the current operation stays cancelled,
        // never failed; a stale cancellation is a no-op.
        if (this.fresh(lifetime, this.askOpId)) {
          this.effects.apply({ agentPhase: 'cancelled', agentError: CANCELLED_MESSAGE });
        }
        return;
      }
      if (!this.fresh(lifetime, this.askOpId)) return;
      this.effects.apply({
        agentPhase: 'failed',
        agentError: (err as Error).message || 'Could not read the selected file.',
      });
      return;
    }
    if (options.signal?.aborted) {
      // The encoder resolved after cancellation: never call the telemetry
      // API. The current operation leaves uploading honestly; stale ones
      // stay silent.
      if (this.fresh(lifetime, this.askOpId)) {
        this.effects.apply({ agentPhase: 'cancelled', agentError: CANCELLED_MESSAGE });
      }
      return;
    }
    if (!this.fresh(lifetime, this.askOpId)) return;
    try {
      const selectedReceipt = await this.adapter.analyzeTelemetry(
        { name: file.name, contentBase64: file.contentBase64 },
        { signal: options.signal, timeoutMs: ANALYSIS_TIMEOUT_MS },
      );
      if (options.signal?.aborted) {
        // An aborted request may still resolve instead of rejecting: a stale
        // abort does nothing, while the current operation leaves
        // uploading/requesting honestly instead of hanging.
        if (this.fresh(lifetime, this.askOpId)) {
          this.effects.apply({ agentPhase: 'cancelled', agentError: CANCELLED_MESSAGE });
        }
        return;
      }
      if (!this.fresh(lifetime, this.askOpId)) return;
      this.effects.apply({ analysis: selectedReceipt, agentPhase: 'requesting' });
      const result = await this.adapter.analyzeCsv(
        { request, sourcePath: selectedReceipt.source.relativePath },
        { signal: options.signal, timeoutMs: AGENT_TIMEOUT_MS },
      );
      if (options.signal?.aborted) {
        if (this.fresh(lifetime, this.askOpId)) {
          this.effects.apply({ agentPhase: 'cancelled', agentError: CANCELLED_MESSAGE });
        }
        return;
      }
      if (!this.fresh(lifetime, this.askOpId)) return;
      this.effects.apply({ agentResult: result, agentPhase: 'completed' });
    } catch (err: unknown) {
      if (!this.fresh(lifetime, this.askOpId)) return;
      if (options.signal?.aborted) {
        this.effects.apply({ agentPhase: 'cancelled', agentError: CANCELLED_MESSAGE });
      } else {
        const message = (err as Error).message || 'The analysis request failed.';
        const timedOut = /timed out|timeout/i.test(message);
        this.effects.apply({
          agentPhase: 'failed',
          agentError: `${timedOut ? 'Timed out' : 'Failed'}: ${message} Retry is available.`,
        });
      }
    }
  }

  /**
   * Prepare a persisted human-review package for an accepted agent result.
   * Both the source lifetime and the preparation request identity are checked
   * before reviewRun, errors, storage writes, navigation, and busy cleanup, so
   * same-source overlapping requests are ordered: only the latest may apply.
   */
  async prepareReview(analysisId: string): Promise<void> {
    const opId = ++this.reviewOpId;
    const lifetime = this.capture(opId);
    this.effects.apply({ reviewBusy: true, reviewError: null });
    try {
      const run = await this.adapter.prepareReview(analysisId);
      if (!this.fresh(lifetime, this.reviewOpId)) return;
      this.effects.apply({ reviewRun: run });
      this.effects.writeSavedRunId(run.runId);
      if (run.status === 'pending_approval') this.effects.navigateToApprovals();
    } catch (err: unknown) {
      if (!this.fresh(lifetime, this.reviewOpId)) return;
      this.effects.apply({ reviewError: (err as Error).message || 'Could not prepare the persisted review package.' });
    } finally {
      // A stale finish must never clear a newer request's busy state.
      if (this.fresh(lifetime, this.reviewOpId)) {
        this.effects.apply({ reviewBusy: false });
      }
    }
  }

  /** Reconnect a previously saved review on load; never rebind it to a new source. */
  async reconnect(): Promise<void> {
    const opId = ++this.reconnectOpId;
    const lifetime = this.capture(opId);
    const runId = this.effects.readSavedRunId();
    if (!runId?.startsWith(SAVED_RUN_PREFIX)) return;
    try {
      const run = await this.adapter.getJudgedRun(runId);
      if (!this.fresh(lifetime, this.reconnectOpId) || !shouldApplyReconnect(this.sourceKey)) return;
      this.effects.apply({ reviewRun: run });
    } catch {
      if (!this.fresh(lifetime, this.reconnectOpId) || !shouldApplyReconnect(this.sourceKey)) return;
      this.effects.apply({
        reviewError:
          'Could not reconnect to the saved review run. Check the authenticated service and approvals queue.',
      });
    }
  }
}
