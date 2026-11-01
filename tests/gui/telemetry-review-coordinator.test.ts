/**
 * Behavioral coverage for the panel's delegated async/state coordination
 * (COMPLETION-FIX-06/08/10/12). These tests drive TelemetryReviewCoordinator —
 * the exact implementation TelemetryReviewPanel delegates every side effect
 * to — through the SAME entrypoints the panel uses (selection keys carried
 * from select calls into run/ask calls), with deferred promises and fake
 * adapters/storage/navigation. No new framework; node vitest only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TelemetryReviewCoordinator,
  type TelemetryFileSubmit,
  type TelemetryReviewViewState,
} from '../../src/gui/src/components/telemetryReviewCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CANCELLED = 'Cancelled. No successful model result was returned; retry to start a new run.';

interface Harness {
  coordinator: TelemetryReviewCoordinator;
  telemetryCalls: unknown[];
  csvCalls: unknown[];
  prepareCalls: string[];
  telemetryQueue: Array<ReturnType<typeof deferred<any>>>;
  csvQueue: Array<ReturnType<typeof deferred<any>>>;
  prepareQueue: Array<ReturnType<typeof deferred<any>>>;
  judgedQueue: Array<ReturnType<typeof deferred<any>>>;
  patches: Array<Partial<TelemetryReviewViewState>>;
  writes: string[];
  navigations: number;
  savedRunId: string | null;
}

function makeHarness(savedRunId: string | null = null): Harness {
  const h: Harness = {
    coordinator: undefined as unknown as TelemetryReviewCoordinator,
    telemetryCalls: [],
    csvCalls: [],
    prepareCalls: [],
    telemetryQueue: [],
    csvQueue: [],
    prepareQueue: [],
    judgedQueue: [],
    patches: [],
    writes: [],
    navigations: 0,
    savedRunId,
  };
  h.coordinator = new TelemetryReviewCoordinator(
    {
      analyzeTelemetry: vi.fn(async (input: unknown) => {
        h.telemetryCalls.push(input);
        const next = h.telemetryQueue.shift();
        if (!next) throw new Error('No queued telemetry response.');
        return next.promise;
      }),
      analyzeCsv: vi.fn(async (input: unknown) => {
        h.csvCalls.push(input);
        const next = h.csvQueue.shift();
        if (!next) throw new Error('No queued agent response.');
        return next.promise;
      }),
      prepareReview: vi.fn(async (analysisId: string) => {
        h.prepareCalls.push(analysisId);
        const next = h.prepareQueue.shift();
        if (!next) throw new Error('No queued review response.');
        return next.promise;
      }),
      getJudgedRun: vi.fn(async () => {
        const next = h.judgedQueue.shift();
        if (!next) throw new Error('No queued judged response.');
        return next.promise;
      }),
    },
    {
      apply: (patch) => {
        h.patches.push(patch);
      },
      readSavedRunId: () => h.savedRunId,
      writeSavedRunId: (runId) => {
        h.writes.push(runId);
      },
      navigateToApprovals: () => {
        h.navigations += 1;
      },
    },
  );
  return h;
}

const fileA = { name: 'a.csv', size: 136, lastModified: 1793433790000 };
const fileB = { name: 'b.csv', size: 140, lastModified: 1793433799999 };
const submitA = (contentBase64 = 'e30='): TelemetryFileSubmit => ({ ...fileA, contentBase64 });
const submitB = (contentBase64 = 'e30='): TelemetryFileSubmit => ({ ...fileB, contentBase64 });

function uploadReceipt(analysisId: string, relativePath: string) {
  return { analysisId, source: { relativePath }, result: { rowsAnalyzed: 3 } };
}

function agentResult() {
  return { evidence: { analysisId: 'telemetry-1' } };
}

function judgedRun(runId: string, status = 'pending_approval') {
  return { runId, status };
}

describe('telemetry review coordinator lifetimes (COMPLETION-FIX-06/08/10/12)', () => {
  it('prepare A, select B, resolve A: no stale review, error, storage or navigation', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prepA = deferred();
    h.prepareQueue.push(prepA);
    const pending = h.coordinator.prepareReview('analysis-a');
    h.coordinator.selectSample();
    prepA.resolve(judgedRun('judged-run-agent-a'));
    await pending;
    expect(h.prepareCalls).toEqual(['analysis-a']);
    expect(h.patches.some((p) => p.reviewRun != null)).toBe(false);
    expect(h.patches.some((p) => p.reviewError != null)).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.navigations).toBe(0);
  });

  it('same-source preparation: B resolves first, then A resolves and is ignored', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prepA = deferred();
    h.prepareQueue.push(prepA);
    const pendingA = h.coordinator.prepareReview('analysis-a');
    const prepB = deferred();
    h.prepareQueue.push(prepB);
    const pendingB = h.coordinator.prepareReview('analysis-b');
    prepB.resolve(judgedRun('judged-run-agent-b'));
    await pendingB;
    expect(h.writes).toEqual(['judged-run-agent-b']);
    expect(h.navigations).toBe(1);
    prepA.resolve(judgedRun('judged-run-agent-a'));
    await pendingA;
    const runs = h.patches.filter((p) => p.reviewRun != null);
    expect(runs).toHaveLength(1);
    expect(h.writes).toEqual(['judged-run-agent-b']);
    expect(h.navigations).toBe(1);
    const busy = h.patches.filter((p) => p.reviewBusy !== undefined).map((p) => p.reviewBusy);
    expect(busy[busy.length - 1]).toBe(false);
  });

  it('same-source preparation: stale rejection is ignored, then B applies', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prepA = deferred();
    h.prepareQueue.push(prepA);
    const pendingA = h.coordinator.prepareReview('analysis-a');
    const prepB = deferred();
    h.prepareQueue.push(prepB);
    const pendingB = h.coordinator.prepareReview('analysis-b');
    prepA.reject(new Error('stale backend failure'));
    await pendingA;
    expect(h.patches.some((p) => p.reviewError != null)).toBe(false);
    prepB.resolve(judgedRun('judged-run-agent-b'));
    await pendingB;
    const lastRun = [...h.patches].reverse().find((p) => p.reviewRun !== undefined);
    expect(lastRun?.reviewRun).toBeDefined();
    expect(h.writes).toEqual(['judged-run-agent-b']);
    expect(h.navigations).toBe(1);
  });

  it('prepare A, select B, start B, finish A: B stays busy until B finishes', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prepA = deferred();
    h.prepareQueue.push(prepA);
    const pendingA = h.coordinator.prepareReview('analysis-a');
    h.coordinator.selectSample();
    const prepB = deferred();
    h.prepareQueue.push(prepB);
    const pendingB = h.coordinator.prepareReview('analysis-b');
    prepA.resolve(judgedRun('judged-run-agent-a'));
    await pendingA;
    const busyAfterA = h.patches.filter((p) => p.reviewBusy !== undefined).map((p) => p.reviewBusy);
    expect(busyAfterA[busyAfterA.length - 1]).toBe(true);
    prepB.resolve(judgedRun('judged-run-agent-b'));
    await pendingB;
    const busyAfterB = h.patches.filter((p) => p.reviewBusy !== undefined).map((p) => p.reviewBusy);
    expect(busyAfterB[busyAfterB.length - 1]).toBe(false);
    expect(h.writes).toEqual(['judged-run-agent-b']);
    expect(h.navigations).toBe(1);
  });

  it('actual sample action while file preparation is pending detaches it', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prepA = deferred();
    h.prepareQueue.push(prepA);
    const pendingPrepare = h.coordinator.prepareReview('analysis-a');
    const sampleUpload = deferred();
    h.telemetryQueue.push(sampleUpload);
    const pendingSample = h.coordinator.runSampleAnalysis();
    expect(h.coordinator.getActiveSourceKey()).toMatch(/^sample#\d+$/);
    prepA.resolve(judgedRun('judged-run-agent-a'));
    await pendingPrepare;
    expect(h.patches.some((p) => p.reviewRun != null)).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.navigations).toBe(0);
    sampleUpload.resolve(uploadReceipt('telemetry-sample', 'synthetic/pilot.csv'));
    await pendingSample;
    const lastAnalysis = [...h.patches].reverse().find((p) => p.analysis !== undefined);
    expect(lastAnalysis?.analysis).toBeDefined();
  });

  it('file A then sample: no request for A runs under the sample identity', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    expect(keyA).toMatch(/^file#\d+:a\.csv:136:1793433790000$/);
    h.coordinator.selectSample();
    expect(h.coordinator.getActiveSourceKey()).toMatch(/^sample#\d+$/);
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise);
    enc.resolve(submitA());
    await pending;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.csvCalls).toHaveLength(0);
    expect(h.patches.some((p) => p.agentPhase === 'uploading' || p.agentPhase === 'requesting')).toBe(false);
  });

  it('sample then a new file: requests and results bind to that file', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    await h.coordinator.runSampleAnalysis();
    expect(h.coordinator.getActiveSourceKey()).toMatch(/^sample#\d+$/);
    const keyB = h.coordinator.selectFile(fileB) as string;
    expect(keyB).toMatch(/^file#\d+:b\.csv:140:1793433799999$/);
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyB, () => enc.promise);
    enc.resolve(submitB());
    const upload = deferred();
    h.telemetryQueue.push(upload);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(2));
    expect((h.telemetryCalls[1] as { name?: string }).name).toBe('b.csv');
    upload.resolve(uploadReceipt('telemetry-b', '.maos/industrial/evidence/b.csv'));
    const agentCall = deferred();
    h.csvQueue.push(agentCall);
    await vi.waitFor(() => expect(h.csvCalls).toHaveLength(1));
    agentCall.resolve(agentResult());
    await pending;
    const lastResult = [...h.patches].reverse().find((p) => p.agentResult !== undefined);
    expect(lastResult?.agentResult).not.toBeNull();
    expect(h.patches.some((p) => p.agentPhase === 'completed')).toBe(true);
  });

  it('identical metadata selections get distinct identities; stale keys are refused', async () => {
    const h = makeHarness();
    const twin = { name: 'a.csv', size: 136, lastModified: 1793433790000 };
    const keyA = h.coordinator.selectFile(fileA) as string;
    const keyB = h.coordinator.selectFile(twin) as string;
    expect(keyA).not.toBe(keyB);
    const enc = deferred<TelemetryFileSubmit>();
    const pendingStale = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise);
    enc.resolve(submitA());
    await pendingStale;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.csvCalls).toHaveLength(0);
    expect(h.patches.some((p) => p.agentPhase === 'uploading')).toBe(false);
    const keyC = h.coordinator.selectFile({ ...fileA }) as string;
    expect(keyC).not.toBe(keyA);
    expect(keyC).not.toBe(keyB);
    const encC = deferred<TelemetryFileSubmit>();
    const pendingC = h.coordinator.askAboutCsv('Summarize.', keyC, () => encC.promise);
    encC.resolve(submitA());
    const upload = deferred();
    h.telemetryQueue.push(upload);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    expect((h.telemetryCalls[0] as { name?: string }).name).toBe('a.csv');
    upload.resolve(uploadReceipt('telemetry-reselect', '.maos/industrial/evidence/a.csv'));
    const agentCall = deferred();
    h.csvQueue.push(agentCall);
    await vi.waitFor(() => expect(h.csvCalls).toHaveLength(1));
    agentCall.resolve(agentResult());
    await pendingC;
    expect(h.patches.some((p) => p.agentPhase === 'completed')).toBe(true);
  });

  it('stale ask rejected while a valid ask is pending does not invalidate it (deferred race)', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const keyB = h.coordinator.selectFile(fileB) as string;
    // Valid B ask goes pending on its upload.
    const encB = deferred<TelemetryFileSubmit>();
    const pendingB = h.coordinator.askAboutCsv('Summarize B.', keyB, () => encB.promise);
    encB.resolve(submitB());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    expect((h.telemetryCalls[0] as { name?: string }).name).toBe('b.csv');
    // Stale A ask arrives while B is in flight: rejected before allocating
    // an operation identity, so B's pending operation stays current.
    const encA = deferred<TelemetryFileSubmit>();
    const pendingStale = h.coordinator.askAboutCsv('Summarize A.', keyA, () => encA.promise);
    encA.resolve(submitA());
    await pendingStale;
    expect(h.telemetryCalls).toHaveLength(1);
    expect(h.csvCalls).toHaveLength(0);
    // B still completes normally.
    uploadB.resolve(uploadReceipt('telemetry-b', '.maos/industrial/evidence/b.csv'));
    const agentCall = deferred();
    h.csvQueue.push(agentCall);
    await vi.waitFor(() => expect(h.csvCalls).toHaveLength(1));
    agentCall.resolve(agentResult());
    await pendingB;
    const lastResult = [...h.patches].reverse().find((p) => p.agentResult !== undefined);
    expect(lastResult?.agentResult).not.toBeNull();
    expect(h.patches.some((p) => p.agentPhase === 'completed')).toBe(true);
  });

  it('stale panel callbacks for analysis are refused; the bound pair stays valid', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const keyB = h.coordinator.selectFile(fileB) as string;
    expect(keyB).not.toBe(keyA);
    // The panel held { file: A, key: keyA } at selection time; invoking the
    // stale analysis entry after B was selected must do nothing at all.
    const enc = deferred<TelemetryFileSubmit>();
    const pendingStale = h.coordinator.runFileAnalysis(keyA, () => enc.promise);
    enc.resolve(submitA());
    await pendingStale;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.patches.some((p) => p.busy === true)).toBe(false);
    expect(h.patches.some((p) => p.analysis != null)).toBe(false);
    expect(h.patches.some((p) => p.error != null)).toBe(false);
    // The current pair works, and stays valid for later calls until reselected.
    const encB = deferred<TelemetryFileSubmit>();
    const pendingB = h.coordinator.runFileAnalysis(keyB, () => encB.promise);
    encB.resolve(submitB());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    uploadB.resolve(uploadReceipt('telemetry-b', '.maos/industrial/evidence/b.csv'));
    await pendingB;
    const lastAnalysis = [...h.patches].reverse().find((p) => p.analysis !== undefined);
    expect(lastAnalysis?.analysis).toBeDefined();
    const encB2 = deferred<TelemetryFileSubmit>();
    const pendingB2 = h.coordinator.runFileAnalysis(keyB, () => encB2.promise);
    encB2.resolve(submitB());
    const uploadB2 = deferred();
    h.telemetryQueue.push(uploadB2);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(2));
    uploadB2.resolve(uploadReceipt('telemetry-b2', '.maos/industrial/evidence/b.csv'));
    await pendingB2;
    const analyses = h.patches.filter((p) => p.analysis != null);
    expect(analyses).toHaveLength(2);
  });

  it('ask requires the active source to be a file, even for a matching key', async () => {
    const h = makeHarness();
    const sampleKey = h.coordinator.selectSample();
    expect(sampleKey).toMatch(/^sample#\d+$/);
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', sampleKey, () => enc.promise);
    enc.resolve(submitA());
    await pending;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.csvCalls).toHaveLength(0);
    expect(h.patches.some((p) => p.agentPhase === 'uploading' || p.agentPhase === 'requesting')).toBe(false);
  });

  it('in-flight analysis A/B: stale resolve, error and finally cannot affect B', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const encA = deferred<TelemetryFileSubmit>();
    const pendingA = h.coordinator.runFileAnalysis(keyA, () => encA.promise);
    encA.resolve(submitA());
    const uploadA = deferred();
    h.telemetryQueue.push(uploadA);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    const keyB = h.coordinator.selectFile(fileB) as string;
    const encB = deferred<TelemetryFileSubmit>();
    encB.resolve(submitB());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    const pendingB = h.coordinator.runFileAnalysis(keyB, () => encB.promise);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(2));
    uploadA.resolve(uploadReceipt('telemetry-a', '.maos/industrial/evidence/a.csv'));
    await pendingA;
    expect(h.patches.some((p) => p.analysis != null)).toBe(false);
    expect(h.patches.some((p) => p.error != null)).toBe(false);
    const busyDuringB = h.patches.filter((p) => p.busy !== undefined).map((p) => p.busy);
    expect(busyDuringB[busyDuringB.length - 1]).toBe(true);
    uploadB.reject(new Error('backend failure for B'));
    await pendingB;
    const errors = h.patches.filter((p) => p.error != null);
    expect(errors).toHaveLength(1);
    expect(h.patches.some((p) => p.analysis != null)).toBe(false);
    const busy = h.patches.filter((p) => p.busy !== undefined).map((p) => p.busy);
    expect(busy[busy.length - 1]).toBe(false);
  });

  it('analysis A/B: stale rejection leaves B untouched', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const encA = deferred<TelemetryFileSubmit>();
    const pendingA = h.coordinator.runFileAnalysis(keyA, () => encA.promise);
    const keyB = h.coordinator.selectFile(fileB) as string;
    const encB = deferred<TelemetryFileSubmit>();
    const pendingB = h.coordinator.runFileAnalysis(keyB, () => encB.promise);
    encA.reject(new Error('stale encode failure'));
    await pendingA;
    expect(h.patches.some((p) => p.error != null)).toBe(false);
    expect(h.telemetryCalls).toHaveLength(0);
    encB.resolve(submitB());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    uploadB.resolve(uploadReceipt('telemetry-b', '.maos/industrial/evidence/b.csv'));
    await pendingB;
    const lastAnalysis = [...h.patches].reverse().find((p) => p.analysis !== undefined);
    expect(lastAnalysis?.analysis).toBeDefined();
    const busy = h.patches.filter((p) => p.busy !== undefined).map((p) => p.busy);
    expect(busy[busy.length - 1]).toBe(false);
  });

  it('file encoding failure after a source change reports nothing', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise);
    h.coordinator.selectFile(fileB);
    enc.reject(new Error('encode failed'));
    await pending;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.csvCalls).toHaveLength(0);
    expect(h.patches.some((p) => p.agentError != null)).toBe(false);
    const phases = h.patches.filter((p) => p.agentPhase !== undefined).map((p) => p.agentPhase);
    expect(phases[phases.length - 1]).toBe('idle');
  });

  it('encoding resolve after cancel never calls the telemetry API', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controller = new AbortController();
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise, { signal: controller.signal });
    controller.abort();
    enc.resolve(submitA());
    await pending;
    expect(h.telemetryCalls).toHaveLength(0);
    expect(h.csvCalls).toHaveLength(0);
    const lastPhase = [...h.patches].reverse().find((p) => p.agentPhase !== undefined);
    expect(lastPhase?.agentPhase).toBe('cancelled');
  });

  it('encoding rejection after cancel stays cancelled, never failed', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controller = new AbortController();
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise, { signal: controller.signal });
    controller.abort();
    enc.reject(new Error('encode failed'));
    await pending;
    expect(h.patches.some((p) => p.agentPhase === 'failed')).toBe(false);
    const lastPhase = [...h.patches].reverse().find((p) => p.agentPhase !== undefined);
    expect(lastPhase?.agentPhase).toBe('cancelled');
    expect(h.telemetryCalls).toHaveLength(0);
  });

  it('aborted upload that resolves still leaves uploading honestly', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controller = new AbortController();
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise, { signal: controller.signal });
    enc.resolve(submitA());
    const upload = deferred();
    h.telemetryQueue.push(upload);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    controller.abort();
    upload.resolve(uploadReceipt('telemetry-a', '.maos/industrial/evidence/a.csv'));
    await pending;
    const lastPhase = [...h.patches].reverse().find((p) => p.agentPhase !== undefined);
    expect(lastPhase?.agentPhase).toBe('cancelled');
    expect(h.patches.some((p) => p.agentError === CANCELLED)).toBe(true);
    expect(h.csvCalls).toHaveLength(0);
  });

  it('aborted upload that rejects stays cancelled for the current operation', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controller = new AbortController();
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise, { signal: controller.signal });
    enc.resolve(submitA());
    const upload = deferred();
    h.telemetryQueue.push(upload);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    controller.abort();
    upload.reject(new DOMException('The operation was aborted.', 'AbortError'));
    await pending;
    const lastPhase = [...h.patches].reverse().find((p) => p.agentPhase !== undefined);
    expect(lastPhase?.agentPhase).toBe('cancelled');
    expect(h.csvCalls).toHaveLength(0);
  });

  it('a provider timeout surfaces as failed with a timeout explanation', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const enc = deferred<TelemetryFileSubmit>();
    const pending = h.coordinator.askAboutCsv('Summarize.', keyA, () => enc.promise);
    enc.resolve(submitA());
    const upload = deferred();
    h.telemetryQueue.push(upload);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    upload.reject(new Error('Request timed out after 30000ms for /api/v1/chat/completions'));
    await pending;
    const lastPhase = [...h.patches].reverse().find((p) => p.agentPhase !== undefined);
    expect(lastPhase?.agentPhase).toBe('failed');
    const lastError = [...h.patches].reverse().find((p) => p.agentError !== undefined && p.agentError !== null);
    expect(String(lastError?.agentError)).toContain('Timed out');
  });

  it('an old abort after a new operation starts cannot touch the new operation', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controllerA = new AbortController();
    const encA = deferred<TelemetryFileSubmit>();
    const pendingA = h.coordinator.askAboutCsv('First.', keyA, () => encA.promise, { signal: controllerA.signal });
    encA.resolve(submitA());
    const uploadA = deferred();
    h.telemetryQueue.push(uploadA);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    const keyA2 = h.coordinator.getActiveSourceKey() as string;
    const controllerB = new AbortController();
    const encB = deferred<TelemetryFileSubmit>();
    const pendingB = h.coordinator.askAboutCsv('Second.', keyA2, () => encB.promise, { signal: controllerB.signal });
    controllerA.abort();
    uploadA.resolve(uploadReceipt('telemetry-a', '.maos/industrial/evidence/a.csv'));
    await pendingA;
    expect(h.patches.some((p) => p.agentPhase === 'cancelled')).toBe(false);
    encB.resolve(submitA());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(2));
    uploadB.resolve(uploadReceipt('telemetry-a2', '.maos/industrial/evidence/a.csv'));
    const agentCall = deferred();
    h.csvQueue.push(agentCall);
    await vi.waitFor(() => expect(h.csvCalls).toHaveLength(1));
    agentCall.resolve(agentResult());
    await pendingB;
    expect(h.patches.some((p) => p.agentPhase === 'completed')).toBe(true);
  });

  it('an old abort rejection after a new operation starts cannot touch it either', async () => {
    const h = makeHarness();
    const keyA = h.coordinator.selectFile(fileA) as string;
    const controllerA = new AbortController();
    const encA = deferred<TelemetryFileSubmit>();
    const pendingA = h.coordinator.askAboutCsv('First.', keyA, () => encA.promise, { signal: controllerA.signal });
    encA.resolve(submitA());
    const uploadA = deferred();
    h.telemetryQueue.push(uploadA);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(1));
    const keyA2 = h.coordinator.getActiveSourceKey() as string;
    const controllerB = new AbortController();
    const encB = deferred<TelemetryFileSubmit>();
    const pendingB = h.coordinator.askAboutCsv('Second.', keyA2, () => encB.promise, { signal: controllerB.signal });
    controllerA.abort();
    uploadA.reject(new DOMException('The operation was aborted.', 'AbortError'));
    await pendingA;
    expect(h.patches.some((p) => p.agentPhase === 'cancelled')).toBe(false);
    expect(h.patches.some((p) => p.agentError != null)).toBe(false);
    encB.resolve(submitA());
    const uploadB = deferred();
    h.telemetryQueue.push(uploadB);
    await vi.waitFor(() => expect(h.telemetryCalls).toHaveLength(2));
    uploadB.resolve(uploadReceipt('telemetry-a2', '.maos/industrial/evidence/a.csv'));
    const agentCall = deferred();
    h.csvQueue.push(agentCall);
    await vi.waitFor(() => expect(h.csvCalls).toHaveLength(1));
    agentCall.resolve(agentResult());
    await pendingB;
    expect(h.patches.some((p) => p.agentPhase === 'completed')).toBe(true);
  });

  it('dispose invalidates pending preparation and reconnect work', async () => {
    const h = makeHarness('judged-run-agent-old');
    h.coordinator.selectFile(fileA);
    const prep = deferred();
    h.prepareQueue.push(prep);
    const pendingPrepare = h.coordinator.prepareReview('analysis-a');
    const judged = deferred();
    h.judgedQueue.push(judged);
    const pendingReconnect = h.coordinator.reconnect();
    h.coordinator.dispose();
    prep.resolve(judgedRun('judged-run-agent-a', 'pending_approval'));
    judged.resolve(judgedRun('judged-run-agent-old', 'completed'));
    await pendingPrepare;
    await pendingReconnect;
    expect(h.patches.some((p) => p.reviewRun != null)).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.navigations).toBe(0);
    expect(h.patches.some((p) => p.reviewError != null)).toBe(false);
  });

  it('dispose does not disturb completed work and a remount can proceed', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const prep = deferred();
    h.prepareQueue.push(prep);
    const pending = h.coordinator.prepareReview('analysis-a');
    prep.resolve(judgedRun('judged-run-agent-a'));
    await pending;
    expect(h.writes).toEqual(['judged-run-agent-a']);
    expect(h.navigations).toBe(1);
    h.coordinator.dispose();
    h.coordinator.selectFile(fileB);
    const prepB = deferred();
    h.prepareQueue.push(prepB);
    const pendingB = h.coordinator.prepareReview('analysis-b');
    prepB.resolve(judgedRun('judged-run-agent-b'));
    await pendingB;
    expect(h.writes).toEqual(['judged-run-agent-a', 'judged-run-agent-b']);
    expect(h.navigations).toBe(2);
  });

  it('sample action binds the sample, clears file state, and analyzes atomically', async () => {
    const h = makeHarness();
    h.coordinator.selectFile(fileA);
    const upload = deferred();
    h.telemetryQueue.push(upload);
    const pending = h.coordinator.runSampleAnalysis();
    expect(h.coordinator.getActiveSourceKey()).toMatch(/^sample#\d+$/);
    const clearPatches = h.patches.filter((p) => (p as { clearFileInput?: boolean }).clearFileInput === true);
    expect(clearPatches.length).toBeGreaterThan(0);
    expect(h.patches.some((p) => p.agentResult != null)).toBe(false);
    expect(h.patches.some((p) => p.reviewRun != null)).toBe(false);
    upload.resolve(uploadReceipt('telemetry-sample', 'synthetic/pilot.csv'));
    await pending;
    const lastAnalysis = [...h.patches].reverse().find((p) => p.analysis !== undefined);
    expect(lastAnalysis?.analysis).toBeDefined();
    expect(h.telemetryCalls).toHaveLength(1);
    expect((h.telemetryCalls[0] as { useBundledSample?: boolean }).useBundledSample).toBe(true);
  });

  it('stale reconnect and stale analysis results stay ignored', async () => {
    const h = makeHarness('judged-run-agent-old');
    const judged = deferred();
    h.judgedQueue.push(judged);
    const reconnecting = h.coordinator.reconnect();
    h.coordinator.selectFile(fileA);
    judged.resolve(judgedRun('judged-run-agent-old', 'completed'));
    await reconnecting;
    expect(h.patches.some((p) => p.reviewRun != null)).toBe(false);

    const analysis = deferred();
    h.telemetryQueue.push(analysis);
    const analyzing = h.coordinator.runSampleAnalysis();
    h.coordinator.selectFile(fileB);
    analysis.resolve(uploadReceipt('telemetry-stale', 'synthetic/pilot.csv'));
    await analyzing;
    expect(h.patches.some((p) => p.analysis != null)).toBe(false);
  });
});
