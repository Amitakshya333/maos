/**
 * F5-01: Local Knowledge-Base Corpus Policy
 *
 * Versioned domain schemas and validators that govern the local KB.
 * This module defines WHAT is allowed, not HOW indexing/search work.
 *
 * Key invariants:
 *   1. Documents are DATA, never executable instructions or tool commands.
 *   2. Only project-local relative paths under approved roots are accepted.
 *   3. Absolute paths, traversal sequences, symlink escapes, network paths,
 *      and implicit home-directory scans are rejected at the policy layer.
 *   4. Every corpus entry is project-isolated by projectId.
 *   5. Prompt-injection patterns in document text are detected, labelled,
 *      and quarantined — they CANNOT change MAOS policy, invoke tools,
 *      alter approvals, alter model selection, or bypass project scope.
 *   6. When evidence is missing or insufficient, the answer is "no answer"
 *      with an explicit reason — never fabrication.
 *
 * Schema version: 1
 */

import { ValidationResult } from './validators';

// ── Corpus Bounds ────────────────────────────────────────────────

/** Maximum size of a single source document in bytes (50 MiB). */
export const KB_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** Maximum number of documents in a single project corpus. */
export const KB_MAX_DOCUMENT_COUNT = 5_000;

/** Maximum number of pages per document (for PDF/DOCX). */
export const KB_MAX_PAGES_PER_DOCUMENT = 2_000;

/** Maximum extracted text per document in bytes (10 MiB). */
export const KB_MAX_EXTRACTED_TEXT_BYTES = 10 * 1024 * 1024;

/** Maximum size of a single text chunk in characters. */
export const KB_MAX_CHUNK_SIZE_CHARS = 2_048;

/** Maximum number of chunks per document. */
export const KB_MAX_CHUNKS_PER_DOCUMENT = 10_000;

/** Maximum total corpus storage in bytes (2 GiB). */
export const KB_MAX_TOTAL_CORPUS_BYTES = 2 * 1024 * 1024 * 1024;

/** Maximum path length for a corpus root or document path. */
export const KB_MAX_PATH_LENGTH = 1_024;

/** Maximum number of approved corpus roots per project. */
export const KB_MAX_ROOTS = 20;

/** Chunk overlap in characters for sliding-window chunking. */
export const KB_CHUNK_OVERLAP_CHARS = 200;

// ── Supported Document Types ────────────────────────────────────

/**
 * Document types the KB can ingest.
 * Any type not in this list is rejected (fail-closed).
 */
export const KB_SUPPORTED_DOCUMENT_TYPES = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
] as const;

export type KbDocumentMimeType = (typeof KB_SUPPORTED_DOCUMENT_TYPES)[number];

/** File extensions mapped to MIME types for fail-closed type resolution. */
export const KB_EXTENSION_MIME_MAP: Readonly<Record<string, KbDocumentMimeType>> = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ── Enums ───────────────────────────────────────────────────────

/** Status of a corpus document entry. */
export type KbDocumentStatus = 'pending' | 'indexed' | 'stale' | 'error' | 'quarantined';

/** Reason a document was quarantined. */
export type KbQuarantineReason =
  | 'PROMPT_INJECTION_DETECTED'
  | 'UNSUPPORTED_TYPE'
  | 'OVERSIZED'
  | 'CORRUPT'
  | 'HASH_MISMATCH'
  | 'SYMLINK_ESCAPE'
  | 'EXTERNAL_PATH';

/** Why re-indexing was triggered. */
export type KbReindexReason =
  | 'SOURCE_HASH_CHANGED'
  | 'SOURCE_SIZE_CHANGED'
  | 'POLICY_VERSION_CHANGED'
  | 'EMBEDDING_MODEL_CHANGED'
  | 'CHUNK_PARAMS_CHANGED'
  | 'MANUAL';

/** No-answer reason codes. */
export type KbNoAnswerReason =
  | 'NO_RELEVANT_CHUNKS'
  | 'BELOW_CONFIDENCE_THRESHOLD'
  | 'CORPUS_EMPTY'
  | 'INDEX_NOT_BUILT'
  | 'ALL_SOURCES_QUARANTINED'
  | 'QUERY_OUT_OF_SCOPE';

/** Injection pattern categories. */
export type KbInjectionCategory =
  | 'TOOL_INVOCATION'
  | 'POLICY_OVERRIDE'
  | 'APPROVAL_MANIPULATION'
  | 'MODEL_SELECTION'
  | 'SCOPE_BYPASS'
  | 'ROLE_IMPERSONATION'
  | 'INSTRUCTION_INJECTION';

// ── Path Rejection Patterns ─────────────────────────────────────

/**
 * Patterns that indicate a path is not a safe project-local relative path.
 * Used by validateCorpusRootPath and validateDocumentPath.
 */
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[/\\]/, // ../
  /[/\\]\.\.[/\\]/, // /../
  /[/\\]\.\.$/, // /..
] as const;

const NETWORK_PATH_PATTERNS = [
  /^\\\\/, // UNC path \\server\share
  /^\/\//, // Unix network path //server/share
  /^https?:\/\//, // HTTP/HTTPS URL
  /^ftp:\/\//, // FTP URL
  /^s3:\/\//, // S3 bucket
  /^gs:\/\//, // GCS bucket
  /^az:\/\//, // Azure blob
] as const;

const HOME_DIR_PATTERNS = [
  /^~[/\\]/, // ~/something
  /^~$/, // just ~
  /^\$HOME[/\\]?/, // $HOME or $HOME/
  /^%USERPROFILE%/i, // Windows %USERPROFILE%
  /^%HOMEPATH%/i, // Windows %HOMEPATH%
  /^%HOMEDRIVE%/i, // Windows %HOMEDRIVE%
] as const;

// ── Prompt Injection Detection Patterns ─────────────────────────

/**
 * Patterns that indicate prompt-injection attempts in document text.
 * These are heuristic — not exhaustive — but catch the most dangerous
 * categories. Matched text is labelled but never executed.
 */
const INJECTION_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly category: KbInjectionCategory;
  readonly description: string;
}> = [
  // Tool invocation attempts
  {
    pattern: /(?:^|\n)\s*(?:use_tool|call_tool|execute|invoke|run_command)\s*[:(]/i,
    category: 'TOOL_INVOCATION',
    description: 'Attempt to invoke a tool or command from document text',
  },
  {
    pattern: /\{\s*"(?:tool|function|action)"\s*:\s*"/i,
    category: 'TOOL_INVOCATION',
    description: 'JSON-formatted tool call attempt',
  },
  // Policy override attempts
  {
    pattern: /(?:^|\n)\s*(?:ignore|override|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|rules?|policies?|prompts?)/i,
    category: 'POLICY_OVERRIDE',
    description: 'Attempt to override system instructions',
  },
  {
    pattern: /(?:^|\n)\s*(?:new|updated?|revised?)\s+(?:system\s+)?(?:instructions?|policy|rules?)\s*:/i,
    category: 'POLICY_OVERRIDE',
    description: 'Attempt to inject new policy directives',
  },
  // Approval manipulation
  {
    pattern: /(?:auto[_-]?approve|skip[_-]?review|bypass[_-]?approval|grant[_-]?approval|approve[_-]?all)/i,
    category: 'APPROVAL_MANIPULATION',
    description: 'Attempt to manipulate approval gates',
  },
  // Model selection
  {
    pattern: /(?:switch|change|use|select)\s+(?:to\s+)?(?:model|llm|gpt|claude|gemini)/i,
    category: 'MODEL_SELECTION',
    description: 'Attempt to change model selection',
  },
  // Scope bypass
  {
    pattern: /(?:access|read|write|delete|modify)\s+(?:files?\s+)?(?:outside|beyond|above)\s+(?:the\s+)?(?:project|scope|boundary|sandbox)/i,
    category: 'SCOPE_BYPASS',
    description: 'Attempt to escape project scope',
  },
  // Role impersonation
  {
    pattern: /(?:^|\n)\s*(?:you\s+are\s+(?:now|a)|act\s+as|pretend\s+(?:to\s+be|you\s+are)|assume\s+the\s+role)/i,
    category: 'ROLE_IMPERSONATION',
    description: 'Attempt to change agent identity or role',
  },
  // Generic instruction injection
  {
    pattern: /(?:^|\n)\s*\[(?:SYSTEM|INST|INSTRUCTION|ADMIN)\]/i,
    category: 'INSTRUCTION_INJECTION',
    description: 'Attempt to inject system-level instructions via markers',
  },
];

// ── Schema: CorpusPolicy ────────────────────────────────────────

/**
 * The immutable corpus policy for a project's knowledge base.
 * Created once per project; version-bumped on policy changes.
 */
export interface KbCorpusPolicy {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly policyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;

  /** Approved relative corpus root directories (under project root). */
  readonly approvedRoots: readonly string[];

  /** Supported MIME types (fail-closed for unlisted types). */
  readonly supportedTypes: readonly KbDocumentMimeType[];

  /** Size and count limits. */
  readonly limits: KbCorpusLimits;

  /** Chunking configuration. */
  readonly chunking: KbChunkingConfig;

  /** Documents are DATA only — never instructions. */
  readonly documentsAreDataOnly: true;

  /** Project isolation marker. */
  readonly isolatedToProject: true;
}

export interface KbCorpusLimits {
  readonly maxSourceBytes: number;
  readonly maxDocumentCount: number;
  readonly maxPagesPerDocument: number;
  readonly maxExtractedTextBytes: number;
  readonly maxChunkSizeChars: number;
  readonly maxChunksPerDocument: number;
  readonly maxTotalCorpusBytes: number;
}

export interface KbChunkingConfig {
  readonly chunkSizeChars: number;
  readonly overlapChars: number;
}

// ── Schema: CorpusDocumentEntry ─────────────────────────────────

/**
 * Metadata record for a single document in the corpus.
 * The document content is stored separately; this tracks provenance.
 */
export interface KbCorpusDocumentEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;

  /** Canonical relative path from project root (forward-slash normalized). */
  readonly canonicalPath: string;

  /** Original file path as provided (may differ in casing/separators). */
  readonly originalPath: string;

  /** SHA-256 hash of the source file content. */
  readonly sourceHash: string;

  /** Source file size in bytes. */
  readonly sourceBytes: number;

  /** MIME type. */
  readonly mimeType: KbDocumentMimeType;

  /** Number of pages (for PDF/DOCX; 1 for text). */
  readonly pageCount: number;

  /** Number of text chunks extracted. */
  readonly chunkCount: number;

  /** Total extracted text size in bytes. */
  readonly extractedTextBytes: number;

  /** Indexing version — bumped on re-index. */
  readonly indexVersion: number;

  /** Current status. */
  readonly status: KbDocumentStatus;

  /** Quarantine details (only when status === 'quarantined'). */
  readonly quarantine?: KbQuarantineInfo;

  /** Timestamps. */
  readonly ingestedAt: string;
  readonly lastIndexedAt: string | null;
  readonly sourceModifiedAt: string;
}

export interface KbQuarantineInfo {
  readonly reason: KbQuarantineReason;
  readonly details: string;
  readonly detectedAt: string;
  readonly injectionMatches?: readonly KbInjectionMatch[];
}

// ── Schema: InjectionMatch ──────────────────────────────────────

export interface KbInjectionMatch {
  readonly category: KbInjectionCategory;
  readonly description: string;
  readonly matchedText: string;
  readonly offsetStart: number;
  readonly offsetEnd: number;
}

// ── Schema: ReindexTrigger ──────────────────────────────────────

export interface KbReindexTrigger {
  readonly documentId: string;
  readonly reason: KbReindexReason;
  readonly previousHash: string;
  readonly currentHash: string;
  readonly triggeredAt: string;
}

// ── Schema: NoAnswerResult ──────────────────────────────────────

/**
 * Returned when the KB cannot provide an evidence-backed answer.
 * The system MUST return this instead of fabricating content.
 */
export interface KbNoAnswerResult {
  readonly answered: false;
  readonly reason: KbNoAnswerReason;
  readonly details: string;
  readonly queriedAt: string;
  readonly corpusDocumentCount: number;
  readonly indexedDocumentCount: number;
}

// ── Schema: RetentionAction ─────────────────────────────────────

export type KbRetentionAction = 'keep' | 'remove_index' | 'remove_entry';

/**
 * Retention semantics:
 *   - 'keep': entry and index remain
 *   - 'remove_index': index data deleted, entry stays as tombstone
 *   - 'remove_entry': entry and index deleted from KB metadata
 *
 * IMPORTANT: Retention NEVER deletes the original source file.
 * It only removes KB metadata and index data.
 */
export interface KbRetentionDecision {
  readonly documentId: string;
  readonly action: KbRetentionAction;
  readonly reason: string;
  readonly decidedAt: string;
  /** Original source path is preserved for audit — never deleted. */
  readonly sourcePathPreserved: true;
}

// ── Factory: Default Policy ─────────────────────────────────────

/**
 * Create a default corpus policy for a project.
 * Callers override individual fields as needed.
 */
export function createDefaultCorpusPolicy(
  projectId: string,
  approvedRoots: readonly string[] = ['docs', 'manuals', 'sops', 'correspondence'],
): KbCorpusPolicy {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId,
    policyVersion: 1,
    createdAt: now,
    updatedAt: now,
    approvedRoots,
    supportedTypes: [...KB_SUPPORTED_DOCUMENT_TYPES],
    limits: {
      maxSourceBytes: KB_MAX_SOURCE_BYTES,
      maxDocumentCount: KB_MAX_DOCUMENT_COUNT,
      maxPagesPerDocument: KB_MAX_PAGES_PER_DOCUMENT,
      maxExtractedTextBytes: KB_MAX_EXTRACTED_TEXT_BYTES,
      maxChunkSizeChars: KB_MAX_CHUNK_SIZE_CHARS,
      maxChunksPerDocument: KB_MAX_CHUNKS_PER_DOCUMENT,
      maxTotalCorpusBytes: KB_MAX_TOTAL_CORPUS_BYTES,
    },
    chunking: {
      chunkSizeChars: KB_MAX_CHUNK_SIZE_CHARS,
      overlapChars: KB_CHUNK_OVERLAP_CHARS,
    },
    documentsAreDataOnly: true,
    isolatedToProject: true,
  };
}

// ── Validation Helpers ──────────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

// ── Path Validators ─────────────────────────────────────────────

/**
 * Error codes for corpus path validation.
 */
export type KbPathErrorCode =
  | 'EMPTY_PATH'
  | 'PATH_TOO_LONG'
  | 'ABSOLUTE_PATH'
  | 'PATH_TRAVERSAL'
  | 'NETWORK_PATH'
  | 'HOME_DIRECTORY'
  | 'NULL_BYTE'
  | 'DRIVE_LETTER';

export class KbPathValidationError extends Error {
  constructor(
    public readonly code: KbPathErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KbPathValidationError';
    Object.setPrototypeOf(this, KbPathValidationError.prototype);
  }
}

/**
 * Validate that a path is a safe project-local relative path.
 *
 * Rejects:
 *   - Empty paths
 *   - Paths exceeding KB_MAX_PATH_LENGTH
 *   - Absolute paths (Unix / or Windows C:\)
 *   - Traversal sequences (../)
 *   - Network/UNC paths
 *   - Home directory references (~, $HOME, %USERPROFILE%)
 *   - Null bytes
 *   - Windows drive letters (C:, D:)
 *
 * Returns ValidationResult. Does NOT resolve symlinks (that's an OS-level
 * check done at ingestion time in F5-02).
 */
export function validateCorpusPath(inputPath: string): ValidationResult {
  const errors: string[] = [];

  // Empty
  if (!inputPath || inputPath.trim().length === 0) {
    return fail(['Path must not be empty']);
  }

  // Null byte
  if (inputPath.includes('\0')) {
    return fail(['Path must not contain null bytes']);
  }

  // Length
  if (inputPath.length > KB_MAX_PATH_LENGTH) {
    errors.push(`Path exceeds maximum length of ${KB_MAX_PATH_LENGTH} characters`);
  }

  // Absolute path (Unix)
  if (inputPath.startsWith('/')) {
    errors.push('Absolute paths are not allowed — only project-relative paths');
  }

  // Absolute path (Windows drive letter)
  if (/^[A-Za-z]:/.test(inputPath)) {
    errors.push('Windows absolute paths (drive letters) are not allowed — only project-relative paths');
  }

  // Traversal
  if (inputPath === '..' || inputPath.startsWith('..') || PATH_TRAVERSAL_PATTERNS.some(p => p.test(inputPath))) {
    errors.push('Path traversal sequences (..) are not allowed');
  }

  // Network/UNC paths
  if (NETWORK_PATH_PATTERNS.some(p => p.test(inputPath))) {
    errors.push('Network and remote paths are not allowed — corpus must be project-local');
  }

  // Home directory
  if (HOME_DIR_PATTERNS.some(p => p.test(inputPath))) {
    errors.push('Home directory references are not allowed — use project-relative paths');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Normalize a path to canonical forward-slash form for deduplication.
 * Does NOT validate — call validateCorpusPath first.
 */
export function canonicalizeCorpusPath(inputPath: string): string {
  return inputPath
    .replace(/\\/g, '/') // backslash → forward slash
    .replace(/\/+/g, '/') // collapse multiple slashes
    .replace(/\/$/, ''); // strip trailing slash
}

// ── MIME Type Validation ────────────────────────────────────────

/**
 * Resolve MIME type from file extension. Returns null if unsupported.
 * Fail-closed: unknown extensions return null.
 */
export function resolveDocumentMimeType(filePath: string): KbDocumentMimeType | null {
  const ext = filePath.lastIndexOf('.') >= 0
    ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    : '';
  return (KB_EXTENSION_MIME_MAP[ext] as KbDocumentMimeType) ?? null;
}

/**
 * Check if a MIME type is supported by the corpus policy.
 */
export function isSupportedMimeType(mimeType: string): mimeType is KbDocumentMimeType {
  return (KB_SUPPORTED_DOCUMENT_TYPES as readonly string[]).includes(mimeType);
}

// ── Duplicate Detection ─────────────────────────────────────────

/**
 * Check if a document is a duplicate based on canonical path and source hash.
 * Returns the nature of the match for the caller to decide.
 */
export type KbDuplicateCheckResult =
  | { readonly duplicate: false }
  | { readonly duplicate: true; readonly reason: 'SAME_PATH_SAME_HASH'; readonly existingId: string }
  | { readonly duplicate: false; readonly reason: 'SAME_PATH_DIFFERENT_HASH'; readonly existingId: string; readonly reindexRequired: true }
  | { readonly duplicate: true; readonly reason: 'DIFFERENT_PATH_SAME_HASH'; readonly existingId: string };

export function checkDuplicate(
  canonicalPath: string,
  sourceHash: string,
  existingEntries: ReadonlyArray<Pick<KbCorpusDocumentEntry, 'id' | 'canonicalPath' | 'sourceHash'>>,
): KbDuplicateCheckResult {
  for (const entry of existingEntries) {
    if (entry.canonicalPath === canonicalPath) {
      if (entry.sourceHash === sourceHash) {
        return { duplicate: true, reason: 'SAME_PATH_SAME_HASH', existingId: entry.id };
      }
      // Same path, different hash → source changed, needs re-index
      return { duplicate: false, reason: 'SAME_PATH_DIFFERENT_HASH', existingId: entry.id, reindexRequired: true };
    }
    if (entry.sourceHash === sourceHash) {
      return { duplicate: true, reason: 'DIFFERENT_PATH_SAME_HASH', existingId: entry.id };
    }
  }
  return { duplicate: false };
}

// ── Re-Index Rules ──────────────────────────────────────────────

/**
 * Determine whether a document needs re-indexing.
 * Re-indexing is required when:
 *   1. Source content hash has changed
 *   2. Source file size has changed (belt-and-suspenders with hash)
 *   3. Policy version has changed
 *   4. Embedding model has changed
 *   5. Chunk parameters have changed
 */
export function needsReindex(
  entry: Pick<KbCorpusDocumentEntry, 'sourceHash' | 'sourceBytes' | 'indexVersion'>,
  currentSourceHash: string,
  currentSourceBytes: number,
  currentPolicyVersion: number,
): KbReindexReason | null {
  if (entry.sourceHash !== currentSourceHash) {
    return 'SOURCE_HASH_CHANGED';
  }
  if (entry.sourceBytes !== currentSourceBytes) {
    return 'SOURCE_SIZE_CHANGED';
  }
  if (entry.indexVersion < currentPolicyVersion) {
    return 'POLICY_VERSION_CHANGED';
  }
  return null;
}

// ── Prompt-Injection Detection ──────────────────────────────────

/**
 * Scan document text for prompt-injection patterns.
 * Returns all matches found. An empty array means no injection detected.
 *
 * IMPORTANT: This is a heuristic scanner. It does NOT make documents safe
 * to treat as instructions — the architectural guarantee is that documents
 * are ALWAYS treated as data regardless of this scan's results.
 * This scanner provides labelling for audit and quarantine purposes.
 */
export function scanForInjection(text: string): readonly KbInjectionMatch[] {
  const matches: KbInjectionMatch[] = [];
  for (const { pattern, category, description } of INJECTION_PATTERNS) {
    // Reset lastIndex for global patterns
    const regex = new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g'));
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        category,
        description,
        matchedText: match[0].slice(0, 200), // truncate long matches
        offsetStart: match.index,
        offsetEnd: match.index + match[0].length,
      });
    }
  }
  return matches;
}

/**
 * Determine if injection matches warrant quarantine.
 * Any match in a safety-critical category triggers quarantine.
 */
export function shouldQuarantine(matches: readonly KbInjectionMatch[]): boolean {
  if (matches.length === 0) return false;
  // All injection categories warrant quarantine in MAOS industrial context
  return true;
}

// ── Document Limits Validation ──────────────────────────────────

/**
 * Validate a document against corpus limits.
 * Returns errors for any limit violation.
 */
export function validateDocumentLimits(
  sourceBytes: number,
  pageCount: number,
  extractedTextBytes: number,
  chunkCount: number,
  limits: KbCorpusLimits,
): ValidationResult {
  const errors: string[] = [];

  if (sourceBytes > limits.maxSourceBytes) {
    errors.push(
      `Source file size (${sourceBytes} bytes) exceeds maximum (${limits.maxSourceBytes} bytes)`,
    );
  }
  if (pageCount > limits.maxPagesPerDocument) {
    errors.push(
      `Page count (${pageCount}) exceeds maximum (${limits.maxPagesPerDocument})`,
    );
  }
  if (extractedTextBytes > limits.maxExtractedTextBytes) {
    errors.push(
      `Extracted text size (${extractedTextBytes} bytes) exceeds maximum (${limits.maxExtractedTextBytes} bytes)`,
    );
  }
  if (chunkCount > limits.maxChunksPerDocument) {
    errors.push(
      `Chunk count (${chunkCount}) exceeds maximum (${limits.maxChunksPerDocument})`,
    );
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validate that adding a document does not exceed corpus-wide limits.
 */
export function validateCorpusCapacity(
  currentDocumentCount: number,
  currentTotalBytes: number,
  newDocumentBytes: number,
  limits: KbCorpusLimits,
): ValidationResult {
  const errors: string[] = [];

  if (currentDocumentCount + 1 > limits.maxDocumentCount) {
    errors.push(
      `Corpus document count (${currentDocumentCount + 1}) would exceed maximum (${limits.maxDocumentCount})`,
    );
  }
  if (currentTotalBytes + newDocumentBytes > limits.maxTotalCorpusBytes) {
    errors.push(
      `Corpus total size (${currentTotalBytes + newDocumentBytes} bytes) would exceed maximum (${limits.maxTotalCorpusBytes} bytes)`,
    );
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ── Project Isolation ───────────────────────────────────────────

/**
 * Validate that a document entry belongs to the expected project.
 * Cross-project access is always forbidden.
 */
export function validateProjectIsolation(
  entryProjectId: string,
  requestProjectId: string,
): ValidationResult {
  if (entryProjectId !== requestProjectId) {
    return fail([
      `Cross-project corpus access forbidden: document belongs to project "${entryProjectId}" ` +
        `but request is for project "${requestProjectId}"`,
    ]);
  }
  return ok();
}

// ── Corpus Policy Validator ─────────────────────────────────────

/**
 * Validate a KbCorpusPolicy object.
 */
export function validateCorpusPolicy(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Input must be an object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  // Schema version
  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  // Required string fields
  for (const field of ['projectId', 'createdAt', 'updatedAt'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  // policyVersion
  if (typeof obj.policyVersion !== 'number' || obj.policyVersion < 1) {
    errors.push('"policyVersion" must be a positive integer');
  }

  // approvedRoots
  if (!Array.isArray(obj.approvedRoots)) {
    errors.push('"approvedRoots" must be an array');
  } else {
    if (obj.approvedRoots.length > KB_MAX_ROOTS) {
      errors.push(`"approvedRoots" exceeds maximum of ${KB_MAX_ROOTS}`);
    }
    for (const root of obj.approvedRoots) {
      if (typeof root !== 'string') {
        errors.push('Each approved root must be a string');
        continue;
      }
      const pathResult = validateCorpusPath(root);
      if (!pathResult.valid) {
        errors.push(`Invalid approved root "${root}": ${pathResult.errors.join('; ')}`);
      }
    }
  }

  // supportedTypes
  if (!Array.isArray(obj.supportedTypes)) {
    errors.push('"supportedTypes" must be an array');
  } else {
    for (const t of obj.supportedTypes) {
      if (!isSupportedMimeType(t as string)) {
        errors.push(`Unsupported MIME type: "${String(t)}"`);
      }
    }
  }

  // limits
  if (typeof obj.limits !== 'object' || obj.limits === null) {
    errors.push('"limits" must be an object');
  } else {
    const lim = obj.limits as Record<string, unknown>;
    for (const field of [
      'maxSourceBytes',
      'maxDocumentCount',
      'maxPagesPerDocument',
      'maxExtractedTextBytes',
      'maxChunkSizeChars',
      'maxChunksPerDocument',
      'maxTotalCorpusBytes',
    ] as const) {
      if (typeof lim[field] !== 'number' || (lim[field] as number) <= 0) {
        errors.push(`limits.${field} must be a positive number`);
      }
    }
  }

  // Immutable invariants
  if (obj.documentsAreDataOnly !== true) {
    errors.push('"documentsAreDataOnly" must be true');
  }
  if (obj.isolatedToProject !== true) {
    errors.push('"isolatedToProject" must be true');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ── Corpus Document Entry Validator ─────────────────────────────

/**
 * Validate a KbCorpusDocumentEntry object.
 */
export function validateCorpusDocumentEntry(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(['Input must be an object']);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${String(obj.schemaVersion)}`);
  }

  for (const field of ['id', 'projectId', 'canonicalPath', 'originalPath', 'sourceHash', 'mimeType', 'ingestedAt'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  // Numeric fields
  for (const field of ['sourceBytes', 'pageCount', 'chunkCount', 'extractedTextBytes', 'indexVersion'] as const) {
    if (typeof obj[field] !== 'number' || (obj[field] as number) < 0) {
      errors.push(`"${field}" must be a non-negative number`);
    }
  }

  // Status
  const validStatuses: KbDocumentStatus[] = ['pending', 'indexed', 'stale', 'error', 'quarantined'];
  if (typeof obj.status !== 'string' || !validStatuses.includes(obj.status as KbDocumentStatus)) {
    errors.push(`"status" must be one of: ${validStatuses.join(', ')}`);
  }

  // MIME type
  if (typeof obj.mimeType === 'string' && !isSupportedMimeType(obj.mimeType)) {
    errors.push(`Unsupported MIME type: "${obj.mimeType}"`);
  }

  // Path validation
  if (typeof obj.canonicalPath === 'string') {
    const pathResult = validateCorpusPath(obj.canonicalPath);
    if (!pathResult.valid) {
      errors.push(`Invalid canonicalPath: ${pathResult.errors.join('; ')}`);
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ── No-Answer Builder ───────────────────────────────────────────

/**
 * Build a no-answer result. The KB MUST use this instead of fabricating
 * content when evidence is insufficient.
 */
export function buildNoAnswer(
  reason: KbNoAnswerReason,
  details: string,
  corpusDocumentCount: number,
  indexedDocumentCount: number,
): KbNoAnswerResult {
  return {
    answered: false,
    reason,
    details,
    queriedAt: new Date().toISOString(),
    corpusDocumentCount,
    indexedDocumentCount,
  };
}

// ── Retention Helpers ───────────────────────────────────────────

/**
 * Create a retention decision record.
 * IMPORTANT: Original source files are NEVER deleted by the KB.
 */
export function createRetentionDecision(
  documentId: string,
  action: KbRetentionAction,
  reason: string,
): KbRetentionDecision {
  return {
    documentId,
    action,
    reason,
    decidedAt: new Date().toISOString(),
    sourcePathPreserved: true,
  };
}
