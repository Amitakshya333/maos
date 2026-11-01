/**
 * TASK RING-IMPL-01: RingAsk contract types (GUI consumer side).
 *
 * The route/service (POST /api/v1/ring/ask) is built by TASK RING-SVC-01
 * against this exact contract. This module only declares the shape and
 * validates responses at runtime. It never invents provider, model, or
 * served-model identity: optional identity fields stay absent unless the
 * server actually echoed them.
 */

export interface RingAskRequest {
  question: string;
  analysisId?: string;
}

export type RingSourceKind = 'sop' | 'incident' | 'telemetry' | 'config';

export interface RingSource {
  kind: RingSourceKind;
  label: string;
  path: string;
}

export interface RingDeterministic {
  attempted: boolean;
  verdict?: string;
  overallRms?: number;
  analysisId?: string;
}

export interface RingAskResult {
  mode: 'hosted' | 'evidence-only';
  providerName?: string;
  modelId?: string;
  servedModelId?: string;
  answer: string;
  sources: RingSource[];
  deterministic: RingDeterministic;
  refusalTest: { prepared: boolean };
}

const SOURCE_KINDS: readonly string[] = ['sop', 'incident', 'telemetry', 'config'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime validator for RingAskResult. Fails closed on any shape violation.
 * Identity fields (providerName/modelId/servedModelId) are passed through
 * only when present as non-empty strings; nothing is defaulted or invented.
 */
export function validateRingAskResult(value: unknown): RingAskResult {
  if (!isRecord(value)) throw new Error('RING_ASK_INVALID: response must be an object.');
  if (value.mode !== 'hosted' && value.mode !== 'evidence-only') {
    throw new Error('RING_ASK_INVALID: mode must be hosted or evidence-only.');
  }
  if (typeof value.answer !== 'string' || value.answer.length === 0) {
    throw new Error('RING_ASK_INVALID: answer must be a non-empty string.');
  }
  if (!Array.isArray(value.sources)) throw new Error('RING_ASK_INVALID: sources must be an array.');
  for (const source of value.sources) {
    if (!isRecord(source)) throw new Error('RING_ASK_INVALID: each source must be an object.');
    if (!SOURCE_KINDS.includes(source.kind as string)) {
      throw new Error('RING_ASK_INVALID: source.kind must be sop, incident, telemetry, or config.');
    }
    if (typeof source.label !== 'string' || !source.label.trim()) {
      throw new Error('RING_ASK_INVALID: source.label must be a non-empty string.');
    }
    if (typeof source.path !== 'string' || !source.path.trim()) {
      throw new Error('RING_ASK_INVALID: source.path must be a non-empty string.');
    }
  }
  if (!isRecord(value.deterministic) || typeof value.deterministic.attempted !== 'boolean') {
    throw new Error('RING_ASK_INVALID: deterministic.attempted must be a boolean.');
  }
  if (value.deterministic.verdict !== undefined && typeof value.deterministic.verdict !== 'string') {
    throw new Error('RING_ASK_INVALID: deterministic.verdict must be a string when present.');
  }
  if (value.deterministic.overallRms !== undefined && typeof value.deterministic.overallRms !== 'number') {
    throw new Error('RING_ASK_INVALID: deterministic.overallRms must be a number when present.');
  }
  if (value.deterministic.analysisId !== undefined && typeof value.deterministic.analysisId !== 'string') {
    throw new Error('RING_ASK_INVALID: deterministic.analysisId must be a string when present.');
  }
  if (!isRecord(value.refusalTest) || typeof value.refusalTest.prepared !== 'boolean') {
    throw new Error('RING_ASK_INVALID: refusalTest.prepared must be a boolean.');
  }
  for (const field of ['providerName', 'modelId', 'servedModelId'] as const) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`RING_ASK_INVALID: ${field} must be a non-empty string when present.`);
    }
  }
  return value as unknown as RingAskResult;
}
