/**
 * F5-07: Local Knowledge-Base CLI and Service Operation Types & Exit Codes
 *
 * Defines:
 * - Stable numerical exit codes for automation scripts and orchestration
 * - Typed inputs and results for KbService (build, status, verify, clear)
 * - Standardized CLI output envelope for JSON and human-readable reporting
 */

import { KbDocumentMimeType } from './kb-corpus-policy';

// ── Stable CLI Exit Codes ───────────────────────────────────────────

export const KB_CLI_EXIT = {
  /** Operation succeeded with zero errors. */
  SUCCESS: 0,
  /** Unhandled or generic operational failure. */
  GENERAL_ERROR: 1,
  /** Invalid project root, missing .maos/, symlink escape, or home-dir scan. */
  INVALID_PROJECT: 10,
  /** Corpus policy validation error or rule violation. */
  POLICY_FAILURE: 11,
  /** Missing pinned model weights, offline snapshot mismatch, or NO_RUNTIME_DOWNLOAD. */
  MISSING_MODEL: 12,
  /** Document ingestion or text extraction failed. */
  INGESTION_FAILURE: 13,
  /** Vector index schema, entry hash, or vector data corrupted or tampered. */
  INDEX_CORRUPT: 14,
  /** Source document, model revision, or policy changed without reindexing. */
  STALE_INDEX: 15,
  /** Destructive clear operation attempted without explicit --yes confirmation. */
  CONFIRMATION_REQUIRED: 16,
  /** Unrecognized or invalid subcommand/argument. */
  INVALID_COMMAND: 17,
} as const;

export type KbCliExitCode = (typeof KB_CLI_EXIT)[keyof typeof KB_CLI_EXIT];

// ── Service Options & Results ───────────────────────────────────────

export interface KbBuildOptions {
  /** Optional override for project ID (defaults to project config). */
  readonly projectId?: string;
  /** Force rebuilding the index even if source hashes are unchanged. */
  readonly force?: boolean;
  /** Custom document directories to scan (defaults to policy approvedRoots). */
  readonly approvedRoots?: readonly string[];
}

export interface KbBuildResult {
  readonly success: boolean;
  readonly projectId: string;
  readonly status: 'built' | 'rebuilt' | 'up_to_date' | 'empty' | 'rebuild_required';
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly totalVectorBytes: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly indexBuildId: string;
  readonly entriesHash: string;
  readonly durationMs: number;
  readonly warnings?: readonly string[];
}

export interface KbStatusOptions {
  readonly projectId?: string;
}

export interface KbStatusPolicyInfo {
  readonly policyVersion: number;
  readonly approvedRoots: readonly string[];
  readonly supportedTypes: readonly KbDocumentMimeType[];
  readonly maxSourceBytes: number;
  readonly maxDocumentCount: number;
}

export interface KbStatusIngestionInfo {
  readonly documentCount: number;
  readonly totalSourceBytes: number;
  readonly totalChunks: number;
  readonly quarantinedCount: number;
  readonly lastIngestedAt?: string;
}

export interface KbStatusEmbeddingInfo {
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly dimension: number;
  readonly available: boolean;
  readonly offlineSnapshotValid: boolean;
  readonly blockerReason?: string;
}

export interface KbStatusIndexInfo {
  readonly state: 'not_built' | 'stale' | 'up_to_date' | 'empty' | 'corrupt';
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly totalVectorBytes: number;
  readonly indexBuildId?: string;
  readonly entriesHash?: string;
  readonly lastBuiltAt?: string;
  readonly indexFileSizeBytes: number;
}

export interface KbStatusResult {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly policy: KbStatusPolicyInfo;
  readonly ingestion: KbStatusIngestionInfo;
  readonly embedding: KbStatusEmbeddingInfo;
  readonly index: KbStatusIndexInfo;
  readonly privacyClean: true;
}

export interface KbVerifyOptions {
  readonly projectId?: string;
}

export interface KbVerifyCheckItem {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

export interface KbVerifyResult {
  readonly valid: boolean;
  readonly projectId: string;
  readonly checks: readonly KbVerifyCheckItem[];
  readonly errors: readonly string[];
  readonly indexBuildId?: string;
  readonly entriesHash?: string;
  readonly documentCount?: number;
  readonly chunkCount?: number;
}

export interface KbClearOptions {
  readonly projectId?: string;
  /** Explicit confirmation required to perform destructive deletion. */
  readonly confirmed?: boolean;
  /** Preview files that would be removed without deleting them. */
  readonly dryRun?: boolean;
}

export interface KbClearResult {
  readonly success: boolean;
  readonly projectId: string;
  readonly dryRun: boolean;
  readonly removedFiles: readonly string[];
  readonly removedCount: number;
  readonly sourceFilesPreserved: true;
  readonly auditPreserved: true;
  readonly message: string;
}

// ── Standardized CLI Result Envelope ────────────────────────────────

export interface KbCliResult<T = unknown> {
  readonly exitCode: KbCliExitCode;
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}
