/**
 * F5-03: Domain Types, Bounds, and Error Definitions for Local CPU Embeddings
 *
 * Defines the pinned offline embedding model configuration, snapshot manifest
 * structures, vector validation, and provenance records for knowledge-base
 * chunk embedding.
 *
 * Core Invariants:
 * 1. Pinned CPU Model: strictly sentence-transformers/all-MiniLM-L6-v2 (384-d, float32, CPU).
 * 2. Zero Synthetic Vectors: random, hash-derived, or keyword-count embeddings are rejected.
 * 3. Offline Verification: missing, malformed, or tampered assets fail closed without network downloads.
 * 4. F5-02 Provenance Retention: every vector is coupled with chunk ID, source hash, model ID, revision, and dimension.
 * 5. Bounded Vectors: exactly 384 finite float numbers, strictly no NaN, Infinity, or unbounded magnitude.
 */

import { ValidationResult } from './validators';

// ── Error Definitions ───────────────────────────────────────────────

export type EmbeddingErrorCode =
  | 'MISSING_SNAPSHOT'
  | 'REVISION_MISMATCH'
  | 'DIMENSION_MISMATCH'
  | 'HASH_MISMATCH'
  | 'PATH_TRAVERSAL'
  | 'SYMLINK_ESCAPE'
  | 'NO_RUNTIME_DOWNLOAD'
  | 'MALFORMED_OUTPUT'
  | 'INVALID_VECTOR_VALUE'
  | 'INFERENCE_TIMEOUT'
  | 'OVERSIZED_INPUT'
  | 'BATCH_TOO_LARGE'
  | 'BATCH_BYTES_EXCEEDED'
  | 'UNAUTHORIZED_MODEL'
  | 'CROSS_PROJECT'
  | 'LEASE_REQUIRED';

export class EmbeddingError extends Error {
  constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EmbeddingError';
    Object.setPrototypeOf(this, EmbeddingError.prototype);
  }
}

// ── Pinned Model Configuration ─────────────────────────────────────

export const PINNED_EMBEDDING_CONFIG = {
  modelId: 'sentence-transformers/all-MiniLM-L6-v2',
  modelName: 'all-minilm-l6-v2-local',
  revision: 'fa979fdf926cbd99430f16e4321689952542a641',
  architecture: 'BertModel',
  dimension: 384,
  device: 'cpu',
  quantization: 'float32',
  maxInputTokens: 256,
  maxInputChars: 2048,
  snapshotRelativePath: 'models--sentence-transformers--all-MiniLM-L6-v2/snapshots/fa979fdf926cbd99430f16e4321689952542a641',
  manifestPath: 'embedding-snapshot-manifest.json',
  license: 'Apache-2.0',
} as const;

// ── Resource and Content Bounds ─────────────────────────────────────

export const EMBEDDING_BOUNDS = {
  /** Pinned embedding vector dimension (384 float values). */
  dimension: 384,
  /** Maximum single input text length in characters (matches chunk size limit). */
  maxTextLength: 2048,
  /** Maximum single input text size in bytes. */
  maxInputBytes: 100_000,
  /** Maximum batch size of chunks embedded in a single inference call. */
  maxBatchSize: 32,
  /** Maximum total cumulative bytes in a single batch (32 chunks * 2048 bytes). */
  maxTotalBatchBytes: 65_536, // 64 KB
  /** Maximum Python worker startup plus inference time in milliseconds. */
  inferenceTimeoutMs: 60_000,
  /** Maximum allowed vector component magnitude (for sanity check). */
  maxVectorMagnitude: 100.0,
} as const;

// ── Snapshot Manifest Types ─────────────────────────────────────────

export interface EmbeddingSnapshotFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EmbeddingSnapshotBudgets {
  readonly maxHostMemoryMb: number;
  readonly maxBatchSize: number;
  readonly maxTotalBatchBytes: number;
  readonly inferenceTimeoutMs: number;
}

export interface EmbeddingSnapshotManifest {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly modelName: string;
  readonly revision: string;
  readonly dimension: number;
  readonly architecture: string;
  readonly device: string;
  readonly quantization: string;
  readonly maxInputTokens: number;
  readonly maxInputChars: number;
  readonly snapshotRelativePath: string;
  readonly files: readonly EmbeddingSnapshotFile[];
  readonly budgets: EmbeddingSnapshotBudgets;
  readonly license?: string;
}

// ── Provenance-Preserving Embedding Records (F5-02 -> F5-03) ────────

export interface ChunkEmbeddingRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly sourceHash: string;
  readonly documentVersion: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimension: number;
  readonly vector: readonly number[];
  readonly charOffsetStart: number;
  readonly charOffsetEnd: number;
  readonly generatedAt: string;
}

// ── Batch Inputs & Results ──────────────────────────────────────────

export interface EmbeddingInput {
  readonly text: string;
  readonly chunkId?: string;
  readonly chunkIndex?: number;
  readonly documentId?: string;
  readonly sourceHash?: string;
  readonly documentVersion?: number;
  readonly charOffsetStart?: number;
  readonly charOffsetEnd?: number;
}

export interface EmbeddingBatchInput {
  readonly projectId: string;
  readonly items: readonly EmbeddingInput[];
}

export interface EmbeddingBatchResult {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly records: readonly ChunkEmbeddingRecord[];
  readonly durationMs: number;
}

// ── Validators ──────────────────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

export function validateEmbeddingSnapshotManifest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Embedding manifest must be a non-null object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  const requiredStrings = [
    'model',
    'modelName',
    'revision',
    'architecture',
    'device',
    'quantization',
    'snapshotRelativePath',
  ];

  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  if (obj.dimension !== EMBEDDING_BOUNDS.dimension) {
    errors.push(`dimension must be exactly ${EMBEDDING_BOUNDS.dimension}, got ${String(obj.dimension)}`);
  }

  if (typeof obj.maxInputTokens !== 'number' || obj.maxInputTokens <= 0) {
    errors.push('"maxInputTokens" must be a positive number');
  }

  if (typeof obj.maxInputChars !== 'number' || obj.maxInputChars <= 0) {
    errors.push('"maxInputChars" must be a positive number');
  }

  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    errors.push('"files" must be a non-empty array');
  } else {
    for (let i = 0; i < obj.files.length; i++) {
      const f = obj.files[i] as Record<string, unknown>;
      if (!f || typeof f !== 'object') {
        errors.push(`file[${i}] must be an object`);
        continue;
      }
      if (typeof f.path !== 'string' || !f.path) {
        errors.push(`file[${i}].path must be a non-empty string`);
      }
      if (typeof f.size !== 'number' || f.size < 0) {
        errors.push(`file[${i}].size must be a non-negative number`);
      }
      if (typeof f.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(f.sha256)) {
        errors.push(`file[${i}].sha256 must be a 64-character hex string`);
      }
    }
  }

  if (!obj.budgets || typeof obj.budgets !== 'object') {
    errors.push('"budgets" must be an object');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

export function validateEmbeddingVector(vector: unknown, expectedDimension: number): ValidationResult {
  if (!Array.isArray(vector)) {
    return fail(['Embedding vector must be an array of numbers']);
  }
  if (vector.length !== expectedDimension) {
    return fail([`Embedding vector length must be exactly ${expectedDimension}, got ${vector.length}`]);
  }

  for (let i = 0; i < vector.length; i++) {
    const val = vector[i];
    if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val)) {
      return fail([`Vector element at index ${i} is not a finite number: ${String(val)}`]);
    }
    if (Math.abs(val) > EMBEDDING_BOUNDS.maxVectorMagnitude) {
      return fail([`Vector element at index ${i} exceeds maximum magnitude bound: ${val}`]);
    }
  }

  return ok();
}

export function validateChunkEmbeddingRecord(input: unknown, expectedDimension: number): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Chunk embedding record must be an object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  const requiredStrings = [
    'projectId',
    'documentId',
    'chunkId',
    'sourceHash',
    'modelId',
    'modelRevision',
    'generatedAt',
  ];

  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  if (obj.dimension !== expectedDimension) {
    errors.push(`dimension must be ${expectedDimension}, got ${String(obj.dimension)}`);
  }

  const requiredNumbers = ['chunkIndex', 'documentVersion', 'charOffsetStart', 'charOffsetEnd'];
  for (const field of requiredNumbers) {
    if (typeof obj[field] !== 'number' || (obj[field] as number) < 0) {
      errors.push(`"${field}" must be a non-negative number`);
    }
  }

  const vectorValidation = validateEmbeddingVector(obj.vector, expectedDimension);
  if (!vectorValidation.valid) {
    errors.push(...vectorValidation.errors);
  }

  return errors.length > 0 ? fail(errors) : ok();
}
