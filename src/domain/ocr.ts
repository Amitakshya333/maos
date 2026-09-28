/**
 * F4-02: Domain Types, Bounds, and Error Definitions for Printed-Text OCR
 *
 * Implements bounded, provenance-preserving optical character recognition
 * for industrial documents, inspection sheets, and architectural drawings.
 *
 * Invariant: OCR output is NEVER treated as an unqualified fact.
 * Every extracted result and text block retains authoritative source hash,
 * artifact reference, engine/version provenance, bounding box, and confidence.
 */

export class OcrValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrValidationError';
    Object.setPrototypeOf(this, OcrValidationError.prototype);
  }
}

// ── Resource and Content Bounds ─────────────────────────────────────

export const OCR_BOUNDS = {
  /** Maximum source image/document file size in bytes (frozen 50 MB limit). */
  maxSourceBytes: 52_428_800,
  /** Maximum pages processed per document. */
  maxPages: 20,
  /** Maximum single image dimension in pixels (frozen 4096 px limit). */
  maxImageDimension: 4096,
  /** Maximum total image pixels (frozen 4096 x 4096 limit). */
  maxImagePixels: 4096 * 4096,
  /** Absolute bounds cannot be raised by callers. */
  absoluteMaxSourceBytes: 52_428_800,
  absoluteMaxPages: 20,
  absoluteMaxImageDimension: 4096,
  absoluteMaxImagePixels: 4096 * 4096,
  /** Maximum characters of extracted text per page. */
  maxTextLength: 10_000_000,
  /** Maximum cumulative output artifact bytes (50 MB). */
  maxOutputBytes: 52_428_800,
  /** Default execution timeout in milliseconds (30 seconds). */
  timeoutMs: 30_000,
} as const;

// ── Confidence Thresholds ───────────────────────────────────────────

export interface OcrConfidenceThresholds {
  /** Text with confidence >= high is accepted as high-confidence printed text (default 0.85). */
  high: number;
  /** Text with confidence between medium and high is tagged with a warning (default 0.60). */
  medium: number;
  /** Text with confidence < medium requires human review (default 0.40). */
  low: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: OcrConfidenceThresholds = {
  high: 0.85,
  medium: 0.60,
  low: 0.40,
};

// ── Domain Schemas ──────────────────────────────────────────────────

export interface OcrBoundingBox {
  /** Horizontal coordinate of the top-left corner in pixels. */
  x: number;
  /** Vertical coordinate of the top-left corner in pixels. */
  y: number;
  /** Width of the bounding box in pixels. */
  width: number;
  /** Height of the bounding box in pixels. */
  height: number;
}

export interface OcrTextBlock {
  /** Unique identifier for the block (e.g., 'block-1-1'). */
  id: string;
  /** Extracted text content. */
  text: string;
  /** Pixel bounding box on the rasterized page. */
  bbox: OcrBoundingBox;
  /** Normalized confidence score [0.0, 1.0]. */
  confidence: number;
  /** 1-indexed page number where this text was detected. */
  pageNumber: number;
  /** Source artifact ID from which this block was extracted. */
  sourceArtifactId: string;
  /** Name of the OCR engine used. */
  engine: string;
  /** Exact version of the OCR engine. */
  engineVersion: string;
}

export interface OcrResult {
  /** Version of the OCR result schema. */
  schemaVersion: 1;
  /** Authoritative artifact ID of the source image or document. */
  sourceArtifactId: string;
  /** Authoritative SHA-256 hash of the source image or document. */
  sourceHash: string;
  /** 1-indexed page number of the processed raster. */
  pageNumber: number;
  /** Pinned OCR engine identifier. */
  engine: string;
  /** Exact version of the pinned OCR engine. */
  engineVersion: string;
  /** Language tag (e.g., 'en', 'eng'). */
  language: string;
  /** Full extracted page text. */
  text: string;
  /** Granular text blocks with individual bounding boxes and confidence. */
  blocks: OcrTextBlock[];
  /** Overall aggregate page confidence [0.0, 1.0]. */
  confidence: number;
  /** Warnings emitted during processing (e.g. low confidence, rotation, blur, handwriting). */
  warnings: string[];
  /** Finalized artifact ID if persisted to the Safe Artifact Store. */
  artifactId?: string;
  /** Authoritative SHA-256 hash of the finalized artifact. */
  artifactHash?: string;
}

export interface OcrDocumentResult {
  /** Version of the OCR document schema. */
  schemaVersion: 1;
  /** Authoritative artifact ID or relative path of the source document. */
  sourceArtifactId: string;
  /** Authoritative SHA-256 hash of the source document. */
  sourceHash: string;
  /** Total count of pages processed. */
  totalPages: number;
  /** Page-by-page OCR results. */
  pages: OcrResult[];
  /** Combined extracted text across all pages. */
  text: string;
  /** Average confidence score across all processed pages. */
  averageConfidence: number;
  /** Consolidated warnings across all pages. */
  warnings: string[];
}

// ── F4-03: Tool Schemas for ocr_document ────────────────────────────

export interface OcrDocumentInput {
  /** Schema version (must be 1). */
  schemaVersion: 1;
  /** Active project identifier. */
  projectId: string;
  /** Relative project path to the target PDF document. */
  sourcePath: string;
  /** Optional source artifact ID if already registered. */
  sourceArtifactId?: string;
  /** Language code (defaults to 'en'). */
  language?: string;
  /** Optional bounded page range to OCR. */
  pageRange?: {
    start: number;
    end: number;
  };
  /** Confidence evaluation mode ('standard' or 'strict'). */
  confidenceMode?: 'standard' | 'strict';
  /** Unique request ID for durable idempotency. */
  requestId: string;
  /** Optional expected source hash to verify integrity. */
  expectedSourceHash?: string;
}

export interface OcrPageToolResult {
  pageNumber: number;
  artifactId: string;
  artifactHash: string;
  confidence: number;
  warnings: string[];
  blockCount: number;
}

export interface OcrDocumentToolResult {
  schemaVersion: 1;
  sourceArtifactId: string;
  sourceHash: string;
  totalPages: number;
  text: string;
  averageConfidence: number;
  warnings: string[];
  pageResults: OcrPageToolResult[];
  engine: string;
  engineVersion: string;
  auditEventId: string;
  cached?: boolean;
}

// ── Error Definitions ───────────────────────────────────────────────

export type OcrErrorCode =
  | 'TRAVERSAL_REJECTED'
  | 'SYMLINK_ESCAPE_REJECTED'
  | 'INVALID_IMAGE_FORMAT'
  | 'INVALID_EXTENSION'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'OVERSIZED_IMAGE_DIMENSIONS'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'MALFORMED_INPUT'
  | 'OCR_ENGINE_FAILED'
  | 'MISSING_ENGINE_ASSETS'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'SOURCE_HASH_MISMATCH'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'INVALID_PAGE_RANGE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_MUTATION';

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: OcrErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'OcrError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, OcrError.prototype);
  }
}

// ── Service Options ─────────────────────────────────────────────────

export interface OcrOptions {
  /** Maximum source bytes (defaults to OCR_BOUNDS.maxSourceBytes). */
  maxSourceBytes?: number;
  /** Maximum pages to process for a document (defaults to OCR_BOUNDS.maxPages). */
  maxPages?: number;
  /** Maximum image dimension (defaults to OCR_BOUNDS.maxImageDimension). */
  maxImageDimension?: number;
  /** Maximum image pixels (defaults to OCR_BOUNDS.maxImagePixels). */
  maxImagePixels?: number;
  /** Execution timeout in milliseconds (defaults to OCR_BOUNDS.timeoutMs). */
  timeoutMs?: number;
  /** Expected source SHA-256 hash for provenance validation. */
  expectedSourceHash?: string;
  /** Language code (defaults to 'en'). */
  language?: string;
  /** Custom confidence thresholds. */
  confidenceThresholds?: Partial<OcrConfidenceThresholds>;
  /** Allow overwrite of existing artifact (defaults to true). */
  allowOverwrite?: boolean;
  /** Required approval ID if overwriting a non-temporary artifact. */
  approvalId?: string;
  /** Target page numbers to OCR (1-indexed). Defaults to all pages. */
  targetPages?: number[];
  /** Flag to force TypeScript fallback engine for verification/testing. */
  forceFallback?: boolean;
}

// ── Validation Helpers ──────────────────────────────────────────────

export function validateOcrBoundingBox(bbox: unknown, field = 'bbox'): OcrBoundingBox {
  if (!bbox || typeof bbox !== 'object') {
    throw new OcrValidationError(`${field} must be an object`);
  }
  const b = bbox as Record<string, unknown>;
  if (typeof b.x !== 'number' || b.x < 0) {
    throw new OcrValidationError(`${field}.x must be a non-negative number`);
  }
  if (typeof b.y !== 'number' || b.y < 0) {
    throw new OcrValidationError(`${field}.y must be a non-negative number`);
  }
  if (typeof b.width !== 'number' || b.width < 0) {
    throw new OcrValidationError(`${field}.width must be a non-negative number`);
  }
  if (typeof b.height !== 'number' || b.height < 0) {
    throw new OcrValidationError(`${field}.height must be a non-negative number`);
  }
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}

export function validateOcrTextBlock(block: unknown, index = 0): OcrTextBlock {
  if (!block || typeof block !== 'object') {
    throw new OcrValidationError(`blocks[${index}] must be an object`);
  }
  const b = block as Record<string, unknown>;
  if (typeof b.id !== 'string' || !b.id.trim()) {
    throw new OcrValidationError(`blocks[${index}].id must be a non-empty string`);
  }
  if (typeof b.text !== 'string') {
    throw new OcrValidationError(`blocks[${index}].text must be a string`);
  }
  const bbox = validateOcrBoundingBox(b.bbox, `blocks[${index}].bbox`);
  if (typeof b.confidence !== 'number' || b.confidence < 0 || b.confidence > 1) {
    throw new OcrValidationError(`blocks[${index}].confidence must be a number between 0.0 and 1.0`);
  }
  if (typeof b.pageNumber !== 'number' || b.pageNumber < 1) {
    throw new OcrValidationError(`blocks[${index}].pageNumber must be an integer >= 1`);
  }
  if (typeof b.sourceArtifactId !== 'string') {
    throw new OcrValidationError(`blocks[${index}].sourceArtifactId must be a string`);
  }
  if (typeof b.engine !== 'string') {
    throw new OcrValidationError(`blocks[${index}].engine must be a string`);
  }
  if (typeof b.engineVersion !== 'string') {
    throw new OcrValidationError(`blocks[${index}].engineVersion must be a string`);
  }

  return {
    id: b.id,
    text: b.text,
    bbox,
    confidence: b.confidence,
    pageNumber: Math.floor(b.pageNumber),
    sourceArtifactId: b.sourceArtifactId,
    engine: b.engine,
    engineVersion: b.engineVersion,
  };
}

export function validateOcrResult(data: unknown): OcrResult {
  if (!data || typeof data !== 'object') {
    throw new OcrValidationError('OcrResult must be an object');
  }
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) {
    throw new OcrValidationError(`OcrResult.schemaVersion must be 1, received ${d.schemaVersion}`);
  }
  if (typeof d.sourceArtifactId !== 'string' || !d.sourceArtifactId.trim()) {
    throw new OcrValidationError('OcrResult.sourceArtifactId must be a non-empty string');
  }
  if (typeof d.sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(d.sourceHash)) {
    throw new OcrValidationError('OcrResult.sourceHash must be a 64-character hex SHA-256 string');
  }
  if (typeof d.pageNumber !== 'number' || d.pageNumber < 1) {
    throw new OcrValidationError('OcrResult.pageNumber must be an integer >= 1');
  }
  if (typeof d.engine !== 'string' || !d.engine.trim()) {
    throw new OcrValidationError('OcrResult.engine must be a non-empty string');
  }
  if (typeof d.engineVersion !== 'string' || !d.engineVersion.trim()) {
    throw new OcrValidationError('OcrResult.engineVersion must be a non-empty string');
  }
  if (typeof d.language !== 'string') {
    throw new OcrValidationError('OcrResult.language must be a string');
  }
  if (typeof d.text !== 'string') {
    throw new OcrValidationError('OcrResult.text must be a string');
  }
  if (!Array.isArray(d.blocks)) {
    throw new OcrValidationError('OcrResult.blocks must be an array');
  }
  const blocks = d.blocks.map((b, i) => validateOcrTextBlock(b, i));

  if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) {
    throw new OcrValidationError('OcrResult.confidence must be a number between 0.0 and 1.0');
  }
  const warnings = Array.isArray(d.warnings)
    ? d.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  return {
    schemaVersion: 1,
    sourceArtifactId: d.sourceArtifactId,
    sourceHash: d.sourceHash.toLowerCase(),
    pageNumber: Math.floor(d.pageNumber),
    engine: d.engine,
    engineVersion: d.engineVersion,
    language: d.language || 'en',
    text: d.text,
    blocks,
    confidence: d.confidence,
    warnings,
    artifactId: typeof d.artifactId === 'string' ? d.artifactId : undefined,
    artifactHash: typeof d.artifactHash === 'string' ? d.artifactHash : undefined,
  };
}

export function validateOcrOptions(options?: OcrOptions): Required<OcrOptions> {
  const opts = options || {};
  return {
    maxSourceBytes: Math.min(
      Math.max(1, opts.maxSourceBytes ?? OCR_BOUNDS.maxSourceBytes),
      OCR_BOUNDS.absoluteMaxSourceBytes,
    ),
    maxPages: Math.min(
      Math.max(1, opts.maxPages ?? OCR_BOUNDS.maxPages),
      OCR_BOUNDS.absoluteMaxPages,
    ),
    maxImageDimension: Math.min(
      Math.max(10, opts.maxImageDimension ?? OCR_BOUNDS.maxImageDimension),
      OCR_BOUNDS.absoluteMaxImageDimension,
    ),
    maxImagePixels: Math.min(
      Math.max(100, opts.maxImagePixels ?? OCR_BOUNDS.maxImagePixels),
      OCR_BOUNDS.absoluteMaxImagePixels,
    ),
    timeoutMs: Math.max(1, opts.timeoutMs ?? OCR_BOUNDS.timeoutMs),
    expectedSourceHash: opts.expectedSourceHash ?? '',
    language: opts.language ?? 'en',
    confidenceThresholds: {
      high: opts.confidenceThresholds?.high ?? DEFAULT_CONFIDENCE_THRESHOLDS.high,
      medium: opts.confidenceThresholds?.medium ?? DEFAULT_CONFIDENCE_THRESHOLDS.medium,
      low: opts.confidenceThresholds?.low ?? DEFAULT_CONFIDENCE_THRESHOLDS.low,
    },
    allowOverwrite: opts.allowOverwrite ?? true,
    approvalId: opts.approvalId ?? '',
    targetPages: opts.targetPages ? [...opts.targetPages] : [],
    forceFallback: opts.forceFallback ?? false,
  };
}

export function validateOcrDocumentInput(input: unknown): OcrDocumentInput {
  if (!input || typeof input !== 'object') {
    throw new OcrError('MALFORMED_INPUT', 'ocr_document input must be an object');
  }
  const i = input as Record<string, unknown>;

  if (i.schemaVersion !== 1) {
    throw new OcrError(
      'MALFORMED_INPUT',
      `ocr_document input.schemaVersion must be 1, received ${i.schemaVersion}`,
    );
  }

  if (typeof i.projectId !== 'string' || !i.projectId.trim()) {
    throw new OcrError('MALFORMED_INPUT', 'ocr_document input.projectId must be a non-empty string');
  }

  if (typeof i.requestId !== 'string' || !i.requestId.trim()) {
    throw new OcrError('MALFORMED_INPUT', 'ocr_document input.requestId must be a non-empty string');
  }

  if (typeof i.sourcePath !== 'string' || !i.sourcePath.trim()) {
    throw new OcrError('MALFORMED_INPUT', 'ocr_document input.sourcePath must be a non-empty string');
  }

  const normPath = i.sourcePath.replace(/\\/g, '/');
  if (normPath.includes('../') || normPath.startsWith('../') || normPath === '..' || normPath.includes('\0')) {
    throw new OcrError('TRAVERSAL_REJECTED', `Path traversal rejected: '${i.sourcePath}'`);
  }

  const ext = (normPath.split('.').pop() || '').toLowerCase();
  if (ext !== 'pdf') {
    throw new OcrError(
      'INVALID_EXTENSION',
      `ocr_document expects a .pdf file, received '${i.sourcePath}'`,
    );
  }

  let pageRange: { start: number; end: number } | undefined;
  if (i.pageRange !== undefined && i.pageRange !== null) {
    if (typeof i.pageRange !== 'object') {
      throw new OcrError('INVALID_PAGE_RANGE', 'ocr_document input.pageRange must be an object');
    }
    const pr = i.pageRange as Record<string, unknown>;
    if (typeof pr.start !== 'number' || !Number.isInteger(pr.start) || pr.start < 1) {
      throw new OcrError('INVALID_PAGE_RANGE', 'ocr_document pageRange.start must be an integer >= 1');
    }
    if (typeof pr.end !== 'number' || !Number.isInteger(pr.end) || pr.end < pr.start) {
      throw new OcrError('INVALID_PAGE_RANGE', 'ocr_document pageRange.end must be an integer >= pageRange.start');
    }
    if (pr.end - pr.start + 1 > OCR_BOUNDS.maxPages) {
      throw new OcrError(
        'PAGE_LIMIT_EXCEEDED',
        `Requested page range (${pr.end - pr.start + 1} pages) exceeds maxPages limit of ${OCR_BOUNDS.maxPages}`,
      );
    }
    pageRange = { start: pr.start, end: pr.end };
  }

  let language = 'en';
  if (i.language !== undefined && i.language !== null) {
    if (typeof i.language !== 'string') {
      throw new OcrError('MALFORMED_INPUT', 'ocr_document input.language must be a string');
    }
    const lang = i.language.trim().toLowerCase();
    const ALLOWED_LANGUAGES = ['en', 'eng'];
    if (!ALLOWED_LANGUAGES.includes(lang)) {
      throw new OcrError(
        'UNSUPPORTED_LANGUAGE',
        `Unsupported OCR language '${i.language}'. Supported languages: ${ALLOWED_LANGUAGES.join(', ')}`,
      );
    }
    language = lang;
  }

  let confidenceMode: 'standard' | 'strict' | undefined;
  if (i.confidenceMode !== undefined && i.confidenceMode !== null) {
    if (i.confidenceMode !== 'standard' && i.confidenceMode !== 'strict') {
      throw new OcrError(
        'MALFORMED_INPUT',
        `ocr_document input.confidenceMode must be 'standard' or 'strict', received '${i.confidenceMode}'`,
      );
    }
    confidenceMode = i.confidenceMode;
  }

  let expectedSourceHash: string | undefined;
  if (i.expectedSourceHash !== undefined && i.expectedSourceHash !== null) {
    if (typeof i.expectedSourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(i.expectedSourceHash)) {
      throw new OcrError(
        'MALFORMED_INPUT',
        'ocr_document input.expectedSourceHash must be a 64-character hex SHA-256 string',
      );
    }
    expectedSourceHash = i.expectedSourceHash.toLowerCase();
  }

  return {
    schemaVersion: 1,
    projectId: i.projectId.trim(),
    sourcePath: normPath,
    sourceArtifactId: typeof i.sourceArtifactId === 'string' ? i.sourceArtifactId : undefined,
    requestId: i.requestId.trim(),
    pageRange,
    language,
    confidenceMode,
    expectedSourceHash,
  };
}
