/**
 * F5-06: Retrieval Evaluation and Knowledge-Base Search Benchmarking Domain Schemas
 *
 * Defines versioned schemas, ground truth structures, evaluation metrics,
 * determinism contracts, and pure validators for evaluating `search_knowledge_base`.
 *
 * Covers:
 * - 13 retrieval evaluation query classes
 * - Frozen query corpus specifications with explicit ground truth
 * - Retrieval metrics: Recall@1, Recall@k, Precision@k, No-Answer Accuracy,
 *   Quarantine Exclusion Rate, Cross-Project Isolation, Deterministic Ranking
 * - Tri-modal execution: contract_fixture, verified_local_model, production_live
 * - Tamper-evident report hashing and immutable audit integration
 */

import * as crypto from 'crypto';
import { ValidationResult } from './validators';
import {
  KbSearchFilter,
  KbSearchCitation,
  KbNoAnswerReason,
  validateKbSearchCitation,
} from './kb-search';
import { PINNED_EMBEDDING_CONFIG } from './embedding';

// ── 13 Retrieval Evaluation Query Classes ────────────────────────────

export type RetrievalEvalQueryClass =
  | 'exact_fact'
  | 'paraphrase'
  | 'numeric_unit'
  | 'section_filter'
  | 'document_filter'
  | 'multi_doc_ambiguity'
  | 'no_answer'
  | 'empty_corpus'
  | 'below_threshold'
  | 'prompt_injection'
  | 'quarantined_document'
  | 'cross_project'
  | 'malformed_index';

export const ALL_RETRIEVAL_QUERY_CLASSES: readonly RetrievalEvalQueryClass[] = [
  'exact_fact',
  'paraphrase',
  'numeric_unit',
  'section_filter',
  'document_filter',
  'multi_doc_ambiguity',
  'no_answer',
  'empty_corpus',
  'below_threshold',
  'prompt_injection',
  'quarantined_document',
  'cross_project',
  'malformed_index',
] as const;

// ── Evaluation Execution Modes ──────────────────────────────────────

export type RetrievalEvalMode =
  | 'contract_fixture'
  | 'verified_local_model'
  | 'production_live';

export const ALL_RETRIEVAL_EVAL_MODES: readonly RetrievalEvalMode[] = [
  'contract_fixture',
  'verified_local_model',
  'production_live',
] as const;

// ── Frozen Query Ground Truth Schema ────────────────────────────────

export interface RetrievalEvalGroundTruth {
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceHashes?: readonly string[];
  readonly expectedNoAnswer?: boolean;
  readonly expectedReason?: KbNoAnswerReason;
  readonly permittedAlternativeChunkIds?: readonly string[];
}

export interface RetrievalEvalQueryEntry {
  readonly queryId: string;
  readonly category: RetrievalEvalQueryClass;
  readonly description: string;
  readonly query: string;
  readonly queryHash: string;
  readonly topK: number;
  readonly minScore: number;
  readonly filter?: KbSearchFilter;
  readonly expected: RetrievalEvalGroundTruth;
}

// ── Query Execution Metrics & Result Schema ─────────────────────────

export interface RetrievalQueryMetrics {
  readonly recallAt1: number;
  readonly recallAtK: Record<number, number>;
  readonly precisionAtK: Record<number, number>;
  readonly expectedReasonMatched?: boolean;
  readonly quarantinedLeakage: boolean;
  readonly crossProjectLeakage: boolean;
}

export interface RetrievalEvalQueryResult {
  readonly queryId: string;
  readonly category: RetrievalEvalQueryClass;
  readonly queryHash: string;
  readonly topK: number;
  readonly minScore: number;
  readonly actual: {
    readonly answered: boolean;
    readonly reason?: KbNoAnswerReason;
    readonly returnedDocumentIds: readonly string[];
    readonly returnedChunkIds: readonly string[];
    readonly returnedScores: readonly number[];
    readonly citations: readonly KbSearchCitation[];
    readonly durationMs: number;
  };
  readonly metrics: RetrievalQueryMetrics;
  readonly passed: boolean;
  readonly failureReason?: string;
}

// ── Determinism & Iteration Record Schema ───────────────────────────

export interface RetrievalEvalIterationRecord {
  readonly iteration: number;
  readonly timestamp: string;
  readonly totalQueries: number;
  readonly passedQueries: number;
  readonly avgRecallAt1: number;
  readonly avgRecallAt3: number;
  readonly avgRecallAt5: number;
  readonly noAnswerAccuracy: number;
  readonly totalDurationMs: number;
  readonly queryResultHashes: readonly string[];
}

// ── Benchmark Summary & Aggregation Schema ──────────────────────────

export interface RetrievalEvalSummary {
  readonly totalQueries: number;
  readonly passedQueries: number;
  readonly failedQueries: number;
  readonly avgRecallAt1: number;
  readonly avgRecallAt3: number;
  readonly avgRecallAt5: number;
  readonly noAnswerAccuracy: number;
  readonly falsePositiveRate: number;
  readonly quarantinedExclusionRate: number;
  readonly crossProjectLeakageRate: number;
  readonly rankingDeterminismRate: number;
  readonly timing: {
    readonly totalDurationMs: number;
    readonly avgQueryDurationMs: number;
    readonly p95QueryDurationMs: number;
  };
  readonly productionLiveBlocked: boolean;
  readonly blockerReason?: string;
}

// ── Benchmark Report Schema ─────────────────────────────────────────

export interface RetrievalEvalReport {
  readonly schemaVersion: 1;
  readonly evaluationId: string;
  readonly projectId: string;
  readonly timestamp: string;
  readonly corpusId: string;
  readonly embeddingModelId: string;
  readonly embeddingModelRevision: string;
  readonly indexBuildId: string;
  readonly querySetVersion: string;
  readonly evaluationMode: RetrievalEvalMode;
  readonly iterations: readonly RetrievalEvalIterationRecord[];
  readonly queryResults: readonly RetrievalEvalQueryResult[];
  readonly summary: RetrievalEvalSummary;
  readonly reportHash: string;
}

// ── Pure Metric Functions ───────────────────────────────────────────

/**
 * Computes Recall@k: fraction of expected chunk IDs retrieved within the top-k results.
 * Returns 1.0 if expected is empty and no answer was expected.
 */
export function computeRecallAtK(
  expectedIds: readonly string[],
  returnedIds: readonly string[],
  k: number,
): number {
  if (!expectedIds || expectedIds.length === 0) {
    return returnedIds.length === 0 ? 1.0 : 0.0;
  }
  const topKReturned = returnedIds.slice(0, k);
  const matched = expectedIds.filter((id) => topKReturned.includes(id));
  return Number((matched.length / expectedIds.length).toFixed(4));
}

/**
 * Computes Precision@k: fraction of top-k retrieved chunks that belong to expected IDs.
 * Returns 1.0 if top-k is empty and no results were expected.
 */
export function computePrecisionAtK(
  expectedIds: readonly string[],
  returnedIds: readonly string[],
  k: number,
): number {
  const topKReturned = returnedIds.slice(0, k);
  if (topKReturned.length === 0) {
    return expectedIds.length === 0 ? 1.0 : 0.0;
  }
  const relevant = topKReturned.filter((id) => expectedIds.includes(id));
  return Number((relevant.length / topKReturned.length).toFixed(4));
}

/**
 * Computes a deterministic canonical SHA-256 hash for an evaluation report.
 */
export function computeReportHash(report: Omit<RetrievalEvalReport, 'reportHash'>): string {
  const canonical = {
    schemaVersion: report.schemaVersion,
    evaluationId: report.evaluationId,
    projectId: report.projectId,
    corpusId: report.corpusId,
    embeddingModelId: report.embeddingModelId,
    embeddingModelRevision: report.embeddingModelRevision,
    indexBuildId: report.indexBuildId,
    querySetVersion: report.querySetVersion,
    evaluationMode: report.evaluationMode,
    summary: report.summary,
    queryResultIds: report.queryResults.map((q) => ({
      queryId: q.queryId,
      passed: q.passed,
      recallAt1: q.metrics.recallAt1,
      returnedChunks: q.actual.returnedChunkIds,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf-8').digest('hex');
}

// ── Pure Domain Validators ──────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates a single frozen query entry in the retrieval benchmark dataset.
 */
export function validateRetrievalEvalQueryEntry(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['RetrievalEvalQueryEntry must be an object']);

  if (!isString(data.queryId) || !data.queryId.trim()) errors.push('queryId must be a non-empty string');
  if (!ALL_RETRIEVAL_QUERY_CLASSES.includes(data.category as RetrievalEvalQueryClass)) {
    errors.push(`Invalid category: ${data.category}`);
  }
  if (!isString(data.description) || !data.description.trim()) {
    errors.push('description must be a non-empty string');
  }
  if (!isString(data.query) || !data.query.trim()) errors.push('query must be a non-empty string');
  if (!isString(data.queryHash) || !/^[a-f0-9]{64}$/i.test(data.queryHash)) {
    errors.push('queryHash must be a valid 64-char SHA-256 hex string');
  }
  if (!isNumber(data.topK) || data.topK < 1 || data.topK > 50) {
    errors.push('topK must be an integer between 1 and 50');
  }
  if (!isNumber(data.minScore) || data.minScore < 0.0 || data.minScore > 1.0) {
    errors.push('minScore must be a number between 0.0 and 1.0');
  }

  if (!isObject(data.expected)) {
    errors.push('expected ground truth must be an object');
  } else {
    const exp = data.expected;
    if (exp.expectedNoAnswer !== undefined && !isBoolean(exp.expectedNoAnswer)) {
      errors.push('expected.expectedNoAnswer must be a boolean when present');
    }
    if (exp.expectedReason !== undefined && !isString(exp.expectedReason)) {
      errors.push('expected.expectedReason must be a string when present');
    }
    if (exp.documentIds !== undefined && !Array.isArray(exp.documentIds)) {
      errors.push('expected.documentIds must be an array when present');
    }
    if (exp.chunkIds !== undefined && !Array.isArray(exp.chunkIds)) {
      errors.push('expected.chunkIds must be an array when present');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validates a completed retrieval benchmark report.
 */
export function validateRetrievalEvalReport(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['RetrievalEvalReport must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.evaluationId) || !data.evaluationId.trim()) {
    errors.push('evaluationId must be a non-empty string');
  }
  if (!isString(data.projectId) || !data.projectId.trim()) {
    errors.push('projectId must be a non-empty string');
  }
  if (!isString(data.timestamp) || !data.timestamp.trim()) {
    errors.push('timestamp must be a non-empty string');
  }
  if (!isString(data.corpusId) || !data.corpusId.trim()) {
    errors.push('corpusId must be a non-empty string');
  }
  if (!isString(data.embeddingModelId) || !data.embeddingModelId.trim()) {
    errors.push('embeddingModelId must be a non-empty string');
  }
  if (!isString(data.embeddingModelRevision) || !data.embeddingModelRevision.trim()) {
    errors.push('embeddingModelRevision must be a non-empty string');
  }
  if (!ALL_RETRIEVAL_EVAL_MODES.includes(data.evaluationMode as RetrievalEvalMode)) {
    errors.push(`Invalid evaluationMode: ${data.evaluationMode}`);
  }

  if (!Array.isArray(data.queryResults)) {
    errors.push('queryResults must be an array');
  } else {
    data.queryResults.forEach((qr, idx) => {
      if (!isObject(qr)) {
        errors.push(`queryResults[${idx}] must be an object`);
      } else {
        if (!isString(qr.queryId)) errors.push(`queryResults[${idx}].queryId must be a string`);
        if (!isBoolean(qr.passed)) errors.push(`queryResults[${idx}].passed must be a boolean`);
      }
    });
  }

  if (!isObject(data.summary)) {
    errors.push('summary must be an object');
  } else {
    const s = data.summary;
    if (!isNumber(s.totalQueries) || s.totalQueries < 0) errors.push('summary.totalQueries must be non-negative');
    if (!isNumber(s.passedQueries) || s.passedQueries < 0) errors.push('summary.passedQueries must be non-negative');
    if (!isNumber(s.avgRecallAt1) || s.avgRecallAt1 < 0 || s.avgRecallAt1 > 1) {
      errors.push('summary.avgRecallAt1 must be between 0.0 and 1.0');
    }
    if (!isNumber(s.noAnswerAccuracy) || s.noAnswerAccuracy < 0 || s.noAnswerAccuracy > 1) {
      errors.push('summary.noAnswerAccuracy must be between 0.0 and 1.0');
    }
    if (!isBoolean(s.productionLiveBlocked)) {
      errors.push('summary.productionLiveBlocked must be a boolean');
    }
  }

  if (!isString(data.reportHash) || !/^[a-f0-9]{64}$/i.test(data.reportHash)) {
    errors.push('reportHash must be a valid 64-char SHA-256 hex string');
  }

  return errors.length > 0 ? fail(errors) : ok();
}
