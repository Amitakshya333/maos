/**
 * F5-02: Domain Types, Schemas, and Validators for Normalized Document Ingestion
 *
 * Implements typed, versioned records for normalized knowledge-base chunks
 * and ingestion manifests with complete provenance tracking:
 *   - project ID
 *   - source path & canonical path
 *   - source SHA-256 hash
 *   - MIME type
 *   - file size & document version
 *   - page number & section heading
 *   - chunk ID & index & text
 *   - character and byte offsets
 *   - extraction engine & version
 *   - warnings & timestamps
 */

import { ValidationResult } from './validators';
import {
  KbDocumentMimeType,
  KbCorpusDocumentEntry,
  KbInjectionMatch,
  isSupportedMimeType,
} from './kb-corpus-policy';

// ── Ingestion Error Codes ───────────────────────────────────────────

export type KbIngestionErrorCode =
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_ROOT'
  | 'SYMLINK_ESCAPE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_IS_DIRECTORY'
  | 'UNSUPPORTED_TYPE'
  | 'SOURCE_TOO_LARGE'
  | 'CORPUS_CAPACITY_EXCEEDED'
  | 'DOCUMENT_LIMIT_EXCEEDED'
  | 'HASH_MISMATCH'
  | 'EXTRACTION_FAILED'
  | 'MALFORMED_DOCUMENT'
  | 'ENCRYPTED_DOCUMENT'
  | 'EMPTY_DOCUMENT'
  | 'CROSS_PROJECT'
  | 'POLICY_INVALID'
  | 'ALREADY_INGESTED'
  | 'QUARANTINED'
  | 'PERSIST_FAILED';

export class KbIngestionError extends Error {
  constructor(
    public readonly code: KbIngestionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KbIngestionError';
    Object.setPrototypeOf(this, KbIngestionError.prototype);
  }
}

// ── Extraction Engine Constants ─────────────────────────────────────

export const EXTRACTION_ENGINE = 'maos-kb-ingestion';
export const EXTRACTION_VERSION = '1.0.0';

// ── Text Chunk Interface (Requirement 6) ────────────────────────────

export interface KbTextChunk {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly canonicalPath: string;
  readonly sourceHash: string;
  readonly mimeType: KbDocumentMimeType;
  readonly fileSize: number;
  readonly sourceBytes: number;
  readonly documentVersion: number;
  readonly documentId: string;
  readonly pageNumber: number | null;
  readonly sectionHeading: string | null;
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly chunkText: string;
  readonly text: string;
  readonly charOffsetStart: number;
  readonly charOffsetEnd: number;
  readonly byteOffsetStart: number;
  readonly byteOffsetEnd: number;
  readonly extractionEngine: string;
  readonly extractionVersion: string;
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Ingestion Result & Input ────────────────────────────────────────

export interface KbIngestionResult {
  readonly documentEntry: KbCorpusDocumentEntry;
  readonly chunks: readonly KbTextChunk[];
  readonly warnings: readonly string[];
  readonly injectionMatches: readonly KbInjectionMatch[];
  readonly quarantined: boolean;
}

export interface KbIngestionInput {
  readonly sourcePath: string;
  readonly projectId: string;
  readonly expectedHash?: string;
  readonly documentId?: string;
}

// ── Manifest Persistence ────────────────────────────────────────────

export interface KbPersistedDocumentRecord {
  readonly entry: KbCorpusDocumentEntry;
  readonly chunkCount: number;
}

export interface KbIngestionManifest {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly documentCount: number;
  readonly totalSourceBytes: number;
  readonly totalChunks: number;
  readonly policyVersion: number;
  readonly updatedAt: string;
  readonly entries: Record<string, KbPersistedDocumentRecord>;
}

// ── Validators ──────────────────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

export function validateKbTextChunk(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Chunk input must be an object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  const requiredStrings = [
    'projectId',
    'sourcePath',
    'canonicalPath',
    'sourceHash',
    'mimeType',
    'documentId',
    'chunkId',
    'chunkText',
    'text',
    'extractionEngine',
    'extractionVersion',
    'createdAt',
    'updatedAt',
  ];

  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  if (typeof obj.mimeType === 'string' && !isSupportedMimeType(obj.mimeType)) {
    errors.push(`Unsupported chunk MIME type: "${obj.mimeType}"`);
  }

  const requiredNumbers = [
    'fileSize',
    'sourceBytes',
    'documentVersion',
    'chunkIndex',
    'charOffsetStart',
    'charOffsetEnd',
    'byteOffsetStart',
    'byteOffsetEnd',
  ];

  for (const field of requiredNumbers) {
    if (typeof obj[field] !== 'number' || (obj[field] as number) < 0) {
      errors.push(`"${field}" must be a non-negative number`);
    }
  }

  if (obj.pageNumber !== null && typeof obj.pageNumber !== 'undefined') {
    if (typeof obj.pageNumber !== 'number' || obj.pageNumber <= 0) {
      errors.push('"pageNumber" must be null or a positive number');
    }
  }

  if (obj.sectionHeading !== null && typeof obj.sectionHeading !== 'undefined') {
    if (typeof obj.sectionHeading !== 'string') {
      errors.push('"sectionHeading" must be null or a string');
    }
  }

  if (!Array.isArray(obj.warnings)) {
    errors.push('"warnings" must be an array');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

export function validateKbIngestionManifest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Manifest input must be an object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  if (typeof obj.projectId !== 'string' || obj.projectId.length === 0) {
    errors.push('"projectId" must be a non-empty string');
  }

  for (const field of ['documentCount', 'totalSourceBytes', 'totalChunks', 'policyVersion']) {
    if (typeof obj[field] !== 'number' || (obj[field] as number) < 0) {
      errors.push(`"${field}" must be a non-negative number`);
    }
  }

  if (typeof obj.updatedAt !== 'string' || obj.updatedAt.length === 0) {
    errors.push('"updatedAt" must be a non-empty string');
  }

  if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) {
    errors.push('"entries" must be an object map');
  }

  return errors.length > 0 ? fail(errors) : ok();
}
