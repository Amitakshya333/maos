/**
 * F5-05: Local Knowledge-Base Search Domain Models & Pure Validators
 *
 * Defines versioned schemas, boundary constraints, error types,
 * vector cosine similarity math, and pure validation functions
 * for semantic similarity search over the validated local vector index.
 *
 * Invariants:
 *   1. Documents are DATA only — returned snippets are untrusted and must never
 *      be executed as instructions, tools, or policy modifiers.
 *   2. Citations must match verified entries in the index — never fabricate citations.
 *   3. When evidence is missing, below threshold, or quarantined, search returns
 *      an explicit no-answer result according to the F5-01 contract.
 *   4. Results are deterministically ranked by score descending, with stable
 *      tie-breaking by documentId, chunkIndex, and chunkId.
 *   5. All vectors must be finite, non-empty, and match the 384-d embedding dimension.
 *   6. Cross-project search attempts are strictly rejected.
 *   7. Zero network activity — missing offline embedding weights fail closed.
 *
 * Schema version: 1
 */

import { ValidationResult } from './validators';
import { KbDocumentMimeType, isSupportedMimeType, KbNoAnswerReason } from './kb-corpus-policy';
export { KbNoAnswerReason };
import { EMBEDDING_BOUNDS } from './embedding';
import { KB_INDEX_BOUNDS } from './kb-vector-index';

// ── Search Boundary Constraints ──────────────────────────────────────

export const KB_SEARCH_BOUNDS = {
  /** Maximum length of a search query in characters. */
  maxQueryChars: 2_048,

  /** Maximum byte size of a search query in UTF-8. */
  maxQueryBytes: 100_000,

  /** Default number of top results to return. */
  defaultTopK: 5,

  /** Maximum allowed topK snippets. */
  maxTopK: 50,

  /** Default minimum similarity score threshold. */
  defaultMinScore: 0.0,

  /** Lower bound for similarity score threshold. */
  minScoreLowerBound: 0.0,

  /** Upper bound for similarity score threshold. */
  minScoreUpperBound: 1.0,

  /** Maximum execution time before timing out search operation. */
  searchTimeoutMs: 15_000,

  /** Expected embedding vector dimension. */
  dimension: KB_INDEX_BOUNDS.dimension, // 384
} as const;

// ── Error Definitions ────────────────────────────────────────────────

export type KbSearchErrorCode =
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'INVALID_INPUT'
  | 'QUERY_TOO_LONG'
  | 'EMPTY_QUERY'
  | 'INVALID_BOUNDS'
  | 'CROSS_PROJECT'
  | 'INDEX_NOT_FOUND'
  | 'INDEX_STALE'
  | 'INDEX_CORRUPT'
  | 'NO_RUNTIME_DOWNLOAD'
  | 'EMBEDDING_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_MUTATION'
  | 'SEARCH_TIMEOUT'
  | 'TRAVERSAL_REJECTED';

export class KbSearchError extends Error {
  constructor(
    public readonly code: KbSearchErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KbSearchError';
    Object.setPrototypeOf(this, KbSearchError.prototype);
  }
}

// ── Search Filter Schema ─────────────────────────────────────────────

export interface KbSearchFilter {
  /** Optional filter to match specific relative source paths. */
  readonly sourcePaths?: readonly string[];

  /** Optional filter to match specific document IDs. */
  readonly documentIds?: readonly string[];

  /** Optional filter to match specific MIME types. */
  readonly mimeTypes?: readonly KbDocumentMimeType[];

  /** Optional filter to match specific 1-indexed page numbers. */
  readonly pageNumbers?: readonly number[];

  /** Optional filter to match specific section headings. */
  readonly sectionHeadings?: readonly string[];
}

// ── Search Input Schema ──────────────────────────────────────────────

export interface KbSearchInput {
  readonly schemaVersion: 1;

  /** Project identifier that owns the knowledge base. */
  readonly projectId: string;

  /** Natural language or keyword search query text. */
  readonly query: string;

  /** Maximum number of top results to return (1-50, default 5). */
  readonly topK?: number;

  /** Minimum cosine similarity threshold (0.0-1.0, default 0.0). */
  readonly minScore?: number;

  /** Optional metadata and provenance filters. */
  readonly filter?: KbSearchFilter;

  /** Request identifier for durable idempotency claims. */
  readonly requestId?: string;
}

// ── Search Citation Schema ───────────────────────────────────────────

export interface KbSearchCitation {
  /** Document ID in the knowledge base manifest. */
  readonly documentId: string;

  /** Deterministic chunk ID. */
  readonly chunkId: string;

  /** Relative source file path. */
  readonly sourcePath: string;

  /** Normalized canonical path. */
  readonly canonicalPath?: string;

  /** 1-indexed page number if available. */
  readonly pageNumber?: number;

  /** Detected section heading if available. */
  readonly sectionHeading?: string;

  /** Authoritative SHA-256 hash of original document content. */
  readonly sourceHash: string;

  /** Ingestion version of the source document. */
  readonly documentVersion: number;

  /** 0-indexed position of chunk in the document. */
  readonly chunkIndex: number;

  /** Start character offset in normalized document text. */
  readonly charOffsetStart: number;

  /** End character offset in normalized document text. */
  readonly charOffsetEnd: number;

  /** Cosine similarity score bounded in [-1.0, 1.0]. */
  readonly score: number;

  /** Vector index build identifier. */
  readonly indexBuildId: string;

  /** Pinned embedding model ID used to index chunk. */
  readonly embeddingModelId: string;

  /** Pinned embedding model git revision hash. */
  readonly embeddingModelRevision: string;

  /** Extracted chunk text content (DATA only, untrusted). */
  readonly snippet: string;
}

// ── Search Result Schemas ────────────────────────────────────────────

export interface KbSearchAnswerResult {
  readonly schemaVersion: 1;
  readonly answered: true;
  readonly projectId: string;
  readonly query: string;
  readonly durationMs: number;
  readonly totalMatches: number;
  readonly returnedMatches: number;
  readonly citations: readonly KbSearchCitation[];
  readonly indexBuildId: string;
  readonly embeddingModelId: string;
  readonly embeddingModelRevision: string;
}

export interface KbSearchNoAnswerResult {
  readonly schemaVersion: 1;
  readonly answered: false;
  readonly reason: KbNoAnswerReason;
  readonly details: string;
  readonly queriedAt: string;
  readonly corpusDocumentCount: number;
  readonly indexedDocumentCount: number;
  readonly projectId: string;
  readonly query: string;
  readonly durationMs: number;
  readonly citations: readonly [];
}

export type KbSearchResult = KbSearchAnswerResult | KbSearchNoAnswerResult;

// ── Cosine Similarity Math ───────────────────────────────────────────

/**
 * Compute cosine similarity between two numeric vectors.
 * Returns a float strictly bounded in [-1.0, 1.0].
 * Fails closed with 0.0 if vectors have dimension mismatch,
 * zero magnitude, or non-finite values (NaN / Infinity).
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
  expectedDimension = KB_SEARCH_BOUNDS.dimension,
): number {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return 0.0;
  }
  if (a.length !== expectedDimension || b.length !== expectedDimension) {
    return 0.0;
  }

  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < expectedDimension; i++) {
    const valA = a[i];
    const valB = b[i];

    if (
      typeof valA !== 'number' ||
      typeof valB !== 'number' ||
      !Number.isFinite(valA) ||
      !Number.isFinite(valB)
    ) {
      return 0.0;
    }

    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA <= 0.0 || normB <= 0.0) {
    return 0.0;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator <= 0.0 || !Number.isFinite(denominator)) {
    return 0.0;
  }

  const similarity = dotProduct / denominator;
  if (!Number.isFinite(similarity)) {
    return 0.0;
  }

  // Bound strictly within [-1.0, 1.0] to account for float precision
  return Math.max(-1.0, Math.min(1.0, similarity));
}

// ── Pure Validators ──────────────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

/**
 * Pure validator for KbSearchInput.
 */
export function validateKbSearchInput(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Search input must be a non-null object']);
  }

  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  if (typeof obj.projectId !== 'string' || obj.projectId.trim().length === 0) {
    errors.push('projectId must be a non-empty string');
  }

  if (typeof obj.query !== 'string' || obj.query.trim().length === 0) {
    errors.push('query must be a non-empty string');
  } else {
    if (obj.query.length > KB_SEARCH_BOUNDS.maxQueryChars) {
      errors.push(
        `query length (${obj.query.length}) exceeds maximum limit (${KB_SEARCH_BOUNDS.maxQueryChars} characters)`,
      );
    }
    const byteLength = Buffer.byteLength(obj.query, 'utf-8');
    if (byteLength > KB_SEARCH_BOUNDS.maxQueryBytes) {
      errors.push(
        `query byte size (${byteLength}) exceeds maximum limit (${KB_SEARCH_BOUNDS.maxQueryBytes} bytes)`,
      );
    }
  }

  if (obj.topK !== undefined) {
    if (
      typeof obj.topK !== 'number' ||
      !Number.isInteger(obj.topK) ||
      obj.topK < 1 ||
      obj.topK > KB_SEARCH_BOUNDS.maxTopK
    ) {
      errors.push(
        `topK must be an integer between 1 and ${KB_SEARCH_BOUNDS.maxTopK}, got ${String(obj.topK)}`,
      );
    }
  }

  if (obj.minScore !== undefined) {
    if (
      typeof obj.minScore !== 'number' ||
      !Number.isFinite(obj.minScore) ||
      obj.minScore < KB_SEARCH_BOUNDS.minScoreLowerBound ||
      obj.minScore > KB_SEARCH_BOUNDS.minScoreUpperBound
    ) {
      errors.push(
        `minScore must be a finite number between ${KB_SEARCH_BOUNDS.minScoreLowerBound} and ${KB_SEARCH_BOUNDS.minScoreUpperBound}, got ${String(obj.minScore)}`,
      );
    }
  }

  if (obj.requestId !== undefined) {
    if (typeof obj.requestId !== 'string' || obj.requestId.trim().length === 0) {
      errors.push('requestId must be a non-empty string when provided');
    }
  }

  if (obj.filter !== undefined) {
    if (typeof obj.filter !== 'object' || obj.filter === null || Array.isArray(obj.filter)) {
      errors.push('filter must be an object when provided');
    } else {
      const filterObj = obj.filter as Record<string, unknown>;

      if (filterObj.sourcePaths !== undefined) {
        if (
          !Array.isArray(filterObj.sourcePaths) ||
          filterObj.sourcePaths.some((p) => typeof p !== 'string' || p.trim().length === 0)
        ) {
          errors.push('filter.sourcePaths must be an array of non-empty strings');
        }
      }

      if (filterObj.documentIds !== undefined) {
        if (
          !Array.isArray(filterObj.documentIds) ||
          filterObj.documentIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
        ) {
          errors.push('filter.documentIds must be an array of non-empty strings');
        }
      }

      if (filterObj.mimeTypes !== undefined) {
        if (
          !Array.isArray(filterObj.mimeTypes) ||
          filterObj.mimeTypes.some((m) => typeof m !== 'string' || !isSupportedMimeType(m))
        ) {
          errors.push('filter.mimeTypes must be an array of supported MIME types');
        }
      }

      if (filterObj.pageNumbers !== undefined) {
        if (
          !Array.isArray(filterObj.pageNumbers) ||
          filterObj.pageNumbers.some((pn) => typeof pn !== 'number' || !Number.isInteger(pn) || pn < 1)
        ) {
          errors.push('filter.pageNumbers must be an array of positive integers');
        }
      }

      if (filterObj.sectionHeadings !== undefined) {
        if (
          !Array.isArray(filterObj.sectionHeadings) ||
          filterObj.sectionHeadings.some((sh) => typeof sh !== 'string')
        ) {
          errors.push('filter.sectionHeadings must be an array of strings');
        }
      }
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Pure validator for KbSearchCitation.
 */
export function validateKbSearchCitation(
  citation: unknown,
  expectedDimension = KB_SEARCH_BOUNDS.dimension,
): ValidationResult {
  if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) {
    return fail(['Citation must be a non-null object']);
  }

  const obj = citation as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of [
    'documentId',
    'chunkId',
    'sourcePath',
    'sourceHash',
    'indexBuildId',
    'embeddingModelId',
    'embeddingModelRevision',
  ] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).trim().length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  if (typeof obj.snippet !== 'string') {
    errors.push('"snippet" must be a string');
  }

  for (const field of ['documentVersion', 'chunkIndex', 'charOffsetStart', 'charOffsetEnd'] as const) {
    if (typeof obj[field] !== 'number' || !Number.isInteger(obj[field]) || (obj[field] as number) < 0) {
      errors.push(`"${field}" must be a non-negative integer`);
    }
  }

  if (typeof obj.score !== 'number' || !Number.isFinite(obj.score) || obj.score < -1.0 || obj.score > 1.0) {
    errors.push(`"score" must be a finite number between -1.0 and 1.0, got ${String(obj.score)}`);
  }

  if (obj.pageNumber !== undefined && obj.pageNumber !== null) {
    if (typeof obj.pageNumber !== 'number' || !Number.isInteger(obj.pageNumber) || obj.pageNumber < 1) {
      errors.push('"pageNumber" must be a positive integer when provided');
    }
  }

  if (obj.sectionHeading !== undefined && obj.sectionHeading !== null) {
    if (typeof obj.sectionHeading !== 'string') {
      errors.push('"sectionHeading" must be a string when provided');
    }
  }

  if (obj.canonicalPath !== undefined && obj.canonicalPath !== null) {
    if (typeof obj.canonicalPath !== 'string') {
      errors.push('"canonicalPath" must be a string when provided');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Pure validator for KbSearchResult (union of answer or no-answer).
 */
export function validateKbSearchResult(result: unknown): ValidationResult {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return fail(['Search result must be a non-null object']);
  }

  const obj = result as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  if (typeof obj.projectId !== 'string' || obj.projectId.trim().length === 0) {
    errors.push('projectId must be a non-empty string');
  }

  if (typeof obj.query !== 'string') {
    errors.push('query must be a string');
  }

  if (typeof obj.durationMs !== 'number' || obj.durationMs < 0) {
    errors.push('durationMs must be a non-negative number');
  }

  if (typeof obj.answered !== 'boolean') {
    errors.push('answered must be a boolean');
    return fail(errors);
  }

  if (obj.answered === true) {
    // KbSearchAnswerResult
    if (typeof obj.indexBuildId !== 'string' || obj.indexBuildId.length === 0) {
      errors.push('indexBuildId must be a non-empty string');
    }
    if (typeof obj.embeddingModelId !== 'string' || obj.embeddingModelId.length === 0) {
      errors.push('embeddingModelId must be a non-empty string');
    }
    if (typeof obj.embeddingModelRevision !== 'string' || obj.embeddingModelRevision.length === 0) {
      errors.push('embeddingModelRevision must be a non-empty string');
    }
    if (typeof obj.totalMatches !== 'number' || obj.totalMatches < 0) {
      errors.push('totalMatches must be a non-negative number');
    }
    if (typeof obj.returnedMatches !== 'number' || obj.returnedMatches < 0) {
      errors.push('returnedMatches must be a non-negative number');
    }
    if (!Array.isArray(obj.citations)) {
      errors.push('citations must be an array');
    } else {
      for (let i = 0; i < obj.citations.length; i++) {
        const citationValidation = validateKbSearchCitation(obj.citations[i]);
        if (!citationValidation.valid) {
          errors.push(`citations[${i}] invalid: ${citationValidation.errors.join('; ')}`);
        }
      }
    }
  } else {
    // KbSearchNoAnswerResult
    const validReasons: KbNoAnswerReason[] = [
      'NO_RELEVANT_CHUNKS',
      'BELOW_CONFIDENCE_THRESHOLD',
      'CORPUS_EMPTY',
      'INDEX_NOT_BUILT',
      'ALL_SOURCES_QUARANTINED',
      'QUERY_OUT_OF_SCOPE',
    ];
    if (typeof obj.reason !== 'string' || !validReasons.includes(obj.reason as KbNoAnswerReason)) {
      errors.push(`reason must be one of: ${validReasons.join(', ')}`);
    }
    if (typeof obj.details !== 'string') {
      errors.push('details must be a string');
    }
    if (typeof obj.queriedAt !== 'string') {
      errors.push('queriedAt must be a string');
    }
    if (typeof obj.corpusDocumentCount !== 'number' || obj.corpusDocumentCount < 0) {
      errors.push('corpusDocumentCount must be a non-negative number');
    }
    if (typeof obj.indexedDocumentCount !== 'number' || obj.indexedDocumentCount < 0) {
      errors.push('indexedDocumentCount must be a non-negative number');
    }
    if (!Array.isArray(obj.citations) || obj.citations.length !== 0) {
      errors.push('citations must be an empty array for no-answer results');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}
