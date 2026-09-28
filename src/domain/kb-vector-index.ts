/**
 * F5-04: Domain Types, Bounds, Error Definitions, and Validators for Bounded Local Vector Index
 *
 * Defines the versioned local vector index structure, deterministic entry hashing,
 * tamper detection, resource bounds, and pure validation functions.
 *
 * Core Invariants:
 * 1. Schema Version: strictly 1.
 * 2. Model Pinned: strictly sentence-transformers/all-MiniLM-L6-v2 (384-d, float32, CPU).
 * 3. Provenance Retention: every entry links to documentId, chunkId, sourceHash, offsets.
 * 4. Deterministic Hashing: canonical entryHash and overall entriesHash detect tampering.
 * 5. Bounded Limits: maximum documents, chunks, vector bytes, file size.
 * 6. Fail-Closed: rejected on corruption, dimension mismatch, or project mismatch.
 */

import * as crypto from 'crypto';
import { ValidationResult } from './validators';
import { PINNED_EMBEDDING_CONFIG, EMBEDDING_BOUNDS, validateEmbeddingVector } from './embedding';

// ── Error Definitions ───────────────────────────────────────────────

export type KbIndexErrorCode =
  | 'INDEX_NOT_FOUND'
  | 'INDEX_MALFORMED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'CORRUPTED_INDEX'
  | 'HASH_MISMATCH'
  | 'DIMENSION_MISMATCH'
  | 'MODEL_MISMATCH'
  | 'REVISION_MISMATCH'
  | 'POLICY_VERSION_MISMATCH'
  | 'CROSS_PROJECT'
  | 'PATH_TRAVERSAL'
  | 'SYMLINK_ESCAPE'
  | 'DUPLICATE_CHUNK_ID'
  | 'DUPLICATE_SOURCE_ENTRY'
  | 'INDEX_TOO_LARGE'
  | 'INVALID_VECTOR'
  | 'PERSIST_FAILED'
  | 'SOURCE_CHANGED'
  | 'REBUILD_REQUIRED'
  | 'NO_RUNTIME_DOWNLOAD';

export class KbIndexError extends Error {
  constructor(
    public readonly code: KbIndexErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KbIndexError';
    Object.setPrototypeOf(this, KbIndexError.prototype);
  }
}

// ── Resource and Content Bounds ─────────────────────────────────────

export const KB_INDEX_BOUNDS = {
  /** Maximum number of indexed documents in a project corpus. */
  maxDocuments: 1000,
  /** Maximum total chunks across the index. */
  maxChunks: 10_000,
  /** Maximum total raw vector bytes in the index (10,000 * 384 * 4 = ~15.36 MB). */
  maxTotalVectorBytes: 50 * 1024 * 1024, // 50 MB
  /** Maximum metadata bytes in index. */
  maxMetadataBytes: 20 * 1024 * 1024, // 20 MB
  /** Maximum index file size in bytes. */
  maxIndexFileSizeBytes: 50 * 1024 * 1024, // 50 MB
  /** Maximum batch size of chunks processed during embedding/indexing. */
  maxBatchSize: 32,
  /** Pinned embedding vector dimension (384). */
  dimension: 384,
  /** Precision format. */
  precision: 'float32' as const,
  /** Relative index path in project root. */
  indexPath: '.maos/kb/vector-index.json',
  /** Relative temp directory in project root. */
  tmpDir: '.maos/kb/.tmp',
} as const;

// ── Index Schemas ───────────────────────────────────────────────────

export interface KbVectorIndexEntry {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourcePath: string; // canonical relative path to project root
  readonly sourceHash: string; // SHA-256 of source file content
  readonly documentVersion: number;
  readonly chunkIndex: number;
  readonly pageNumber?: number;
  readonly sectionHeading?: string;
  readonly charOffsetStart: number;
  readonly charOffsetEnd: number;
  readonly vector: readonly number[]; // 384 finite float numbers
  readonly entryHash: string; // Deterministic SHA-256 of entry data
}

export interface KbVectorIndex {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly policyVersion: number;
  readonly embeddingModelId: string;
  readonly embeddingModelRevision: string;
  readonly embeddingDimension: number;
  readonly precision: 'float32';
  readonly indexBuildId: string;
  readonly entriesHash: string; // SHA-256 of sorted entry hashes
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly totalVectorBytes: number;
  readonly entries: readonly KbVectorIndexEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KbVectorIndexBuildStatus {
  readonly status: 'built' | 'rebuilt' | 'up_to_date' | 'rebuild_required' | 'empty';
  readonly reason?: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly totalVectorBytes: number;
  readonly indexBuildId?: string;
  readonly entriesHash?: string;
  readonly durationMs?: number;
}

// ── Deterministic Hashing ───────────────────────────────────────────

/**
 * Computes a deterministic canonical SHA-256 hash of an index entry's contents.
 */
export function computeEntryHash(entry: Omit<KbVectorIndexEntry, 'entryHash'>): string {
  const parts = [
    entry.chunkId,
    entry.documentId,
    entry.sourcePath,
    entry.sourceHash,
    String(entry.documentVersion),
    String(entry.chunkIndex),
    String(entry.charOffsetStart),
    String(entry.charOffsetEnd),
    String(entry.pageNumber ?? ''),
    entry.sectionHeading ?? '',
    entry.vector.map((v) => Number(v.toFixed(6))).join(','),
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf-8').digest('hex');
}

/**
 * Computes a deterministic canonical SHA-256 hash over an array of entry hashes.
 * Hashes are lexicographically sorted to guarantee permutation-independent determinism.
 */
export function computeEntriesHash(entryHashes: readonly string[]): string {
  const sorted = [...entryHashes].sort();
  return crypto.createHash('sha256').update(sorted.join('\n'), 'utf-8').digest('hex');
}

// ── Pure Domain Validators ──────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

/**
 * Validates a single vector index entry including provenance references and vector values.
 */
export function validateVectorIndexEntry(
  entry: unknown,
  expectedDimension = KB_INDEX_BOUNDS.dimension,
): ValidationResult {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return fail(['Index entry must be a non-null object']);
  }
  const obj = entry as Record<string, unknown>;
  const errors: string[] = [];

  const requiredStrings = ['chunkId', 'documentId', 'sourcePath', 'sourceHash', 'entryHash'];
  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  if (typeof obj.sourceHash === 'string' && !/^[a-fA-F0-9]{64}$/.test(obj.sourceHash)) {
    errors.push('sourceHash must be a 64-character hex string');
  }

  if (typeof obj.entryHash === 'string' && !/^[a-fA-F0-9]{64}$/.test(obj.entryHash)) {
    errors.push('entryHash must be a 64-character hex string');
  }

  const requiredNumbers = ['documentVersion', 'chunkIndex', 'charOffsetStart', 'charOffsetEnd'];
  for (const field of requiredNumbers) {
    if (typeof obj[field] !== 'number' || (obj[field] as number) < 0 || !Number.isInteger(obj[field])) {
      errors.push(`"${field}" must be a non-negative integer`);
    }
  }

  if (obj.pageNumber !== undefined) {
    if (typeof obj.pageNumber !== 'number' || obj.pageNumber < 1 || !Number.isInteger(obj.pageNumber)) {
      errors.push('"pageNumber" must be a positive integer when present');
    }
  }

  if (obj.sectionHeading !== undefined && typeof obj.sectionHeading !== 'string') {
    errors.push('"sectionHeading" must be a string when present');
  }

  // Validate vector
  const vecResult = validateEmbeddingVector(obj.vector, expectedDimension);
  if (!vecResult.valid) {
    errors.push(...vecResult.errors);
  }

  // Verify entryHash integrity if no other basic errors occurred
  if (errors.length === 0) {
    const expectedEntryHash = computeEntryHash(obj as unknown as Omit<KbVectorIndexEntry, 'entryHash'>);
    if (obj.entryHash !== expectedEntryHash) {
      errors.push(`entryHash mismatch: expected ${expectedEntryHash}, got ${obj.entryHash}`);
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validates the full vector index object against all schema rules, bounds, and tamper hashes.
 */
export function validateVectorIndex(
  input: unknown,
  expectedDimension = KB_INDEX_BOUNDS.dimension,
): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Vector index must be a non-null object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  if (typeof obj.projectId !== 'string' || obj.projectId.length === 0) {
    errors.push('"projectId" must be a non-empty string');
  }

  if (typeof obj.policyVersion !== 'number' || obj.policyVersion < 1 || !Number.isInteger(obj.policyVersion)) {
    errors.push('"policyVersion" must be a positive integer');
  }

  if (obj.embeddingModelId !== PINNED_EMBEDDING_CONFIG.modelId) {
    errors.push(`embeddingModelId "${obj.embeddingModelId}" does not match pinned model "${PINNED_EMBEDDING_CONFIG.modelId}"`);
  }

  if (obj.embeddingModelRevision !== PINNED_EMBEDDING_CONFIG.revision) {
    errors.push(`embeddingModelRevision "${obj.embeddingModelRevision}" does not match pinned revision "${PINNED_EMBEDDING_CONFIG.revision}"`);
  }

  if (obj.embeddingDimension !== expectedDimension) {
    errors.push(`embeddingDimension must be ${expectedDimension}, got ${String(obj.embeddingDimension)}`);
  }

  if (obj.precision !== 'float32') {
    errors.push(`precision must be "float32", got ${String(obj.precision)}`);
  }

  if (typeof obj.indexBuildId !== 'string' || obj.indexBuildId.length === 0) {
    errors.push('"indexBuildId" must be a non-empty string');
  }

  if (typeof obj.entriesHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(obj.entriesHash)) {
    errors.push('"entriesHash" must be a 64-character hex string');
  }

  if (typeof obj.createdAt !== 'string' || Number.isNaN(Date.parse(obj.createdAt))) {
    errors.push('"createdAt" must be a valid ISO timestamp');
  }

  if (typeof obj.updatedAt !== 'string' || Number.isNaN(Date.parse(obj.updatedAt))) {
    errors.push('"updatedAt" must be a valid ISO timestamp');
  }

  if (typeof obj.documentCount !== 'number' || obj.documentCount < 0 || !Number.isInteger(obj.documentCount)) {
    errors.push('"documentCount" must be a non-negative integer');
  } else if (obj.documentCount > KB_INDEX_BOUNDS.maxDocuments) {
    errors.push(`documentCount (${obj.documentCount}) exceeds maximum limit (${KB_INDEX_BOUNDS.maxDocuments})`);
  }

  if (typeof obj.chunkCount !== 'number' || obj.chunkCount < 0 || !Number.isInteger(obj.chunkCount)) {
    errors.push('"chunkCount" must be a non-negative integer');
  } else if (obj.chunkCount > KB_INDEX_BOUNDS.maxChunks) {
    errors.push(`chunkCount (${obj.chunkCount}) exceeds maximum limit (${KB_INDEX_BOUNDS.maxChunks})`);
  }

  if (typeof obj.totalVectorBytes !== 'number' || obj.totalVectorBytes < 0) {
    errors.push('"totalVectorBytes" must be a non-negative number');
  } else if (obj.totalVectorBytes > KB_INDEX_BOUNDS.maxTotalVectorBytes) {
    errors.push(`totalVectorBytes (${obj.totalVectorBytes}) exceeds maximum limit (${KB_INDEX_BOUNDS.maxTotalVectorBytes})`);
  }

  if (!Array.isArray(obj.entries)) {
    errors.push('"entries" must be an array');
    return fail(errors);
  }

  if (obj.chunkCount !== obj.entries.length) {
    errors.push(`chunkCount (${obj.chunkCount}) does not match entries.length (${obj.entries.length})`);
  }

  const seenChunkIds = new Set<string>();
  const seenSourceOffsets = new Set<string>();
  const entryHashes: string[] = [];
  const uniqueDocIds = new Set<string>();

  for (let i = 0; i < obj.entries.length; i++) {
    const entry = obj.entries[i];
    const entryRes = validateVectorIndexEntry(entry, expectedDimension);
    if (!entryRes.valid) {
      errors.push(`Entry[${i}] validation failed: ${entryRes.errors.join('; ')}`);
      continue;
    }

    const typedEntry = entry as KbVectorIndexEntry;

    // Duplicate chunk ID check
    if (seenChunkIds.has(typedEntry.chunkId)) {
      errors.push(`Duplicate chunkId detected: "${typedEntry.chunkId}" at index ${i}`);
    } else {
      seenChunkIds.add(typedEntry.chunkId);
    }

    // Duplicate source document chunk range check
    const offsetKey = `${typedEntry.documentId}:${typedEntry.chunkIndex}`;
    if (seenSourceOffsets.has(offsetKey)) {
      errors.push(`Duplicate source chunk entry detected: "${offsetKey}" at index ${i}`);
    } else {
      seenSourceOffsets.add(offsetKey);
    }

    uniqueDocIds.add(typedEntry.documentId);
    entryHashes.push(typedEntry.entryHash);
  }

  if (obj.documentCount !== uniqueDocIds.size) {
    errors.push(`documentCount (${obj.documentCount}) does not match unique document IDs in entries (${uniqueDocIds.size})`);
  }

  // Validate overall entriesHash integrity if entry hashes were collected
  if (errors.length === 0) {
    const expectedEntriesHash = computeEntriesHash(entryHashes);
    if (obj.entriesHash !== expectedEntriesHash) {
      errors.push(`entriesHash mismatch: expected ${expectedEntriesHash}, got ${obj.entriesHash}`);
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}
