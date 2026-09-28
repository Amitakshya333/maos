/**
 * UI1-10: Evidence / Brainstorm Modes and Retention Domain Schemas
 *
 * Defines versioned, strictly typed contracts and pure validators for:
 * 1. Operational Modes (Evidence / Industrial vs. Brainstorm)
 * 2. Cited Claims & Provenance Verification
 * 3. Silent Mode Downgrade Defense
 * 4. Configurable Scoped Purge & Retention Invariants
 *
 * Safety Invariants:
 * - Industrial / Evidence mode strictly blocks claims without cryptographic citations (UNCITED_CLAIM_REJECTED).
 * - Unverified model prose must be clearly tagged and labeled (UNVERIFIED_MODEL_PROSE).
 * - Silent downgrade from Evidence to Brainstorm mode is forbidden (SILENT_DOWNGRADE_FORBIDDEN).
 * - Append-only audit logs (.maos/audit/) and finalized deliverables are strictly immutable and never purged.
 */

import type { RetentionSettings } from './settings';

// ── Operational Modes ───────────────────────────────────────────────

export type OperationalMode = 'evidence' | 'brainstorm' | 'industrial';

export const OPERATIONAL_MODES: readonly OperationalMode[] = [
  'evidence',
  'brainstorm',
  'industrial',
] as const;

/**
 * Normalizes operational mode: 'industrial' is synonymous with 'evidence'.
 */
export function normalizeOperationalMode(mode: unknown): 'evidence' | 'brainstorm' {
  if (mode === 'brainstorm') return 'brainstorm';
  return 'evidence';
}

// ── Provenance & Citations ──────────────────────────────────────────

export interface ClaimCitation {
  readonly citationId: string;
  readonly sourceArtifactId?: string;
  readonly sourcePath: string;
  readonly sourceHash: string; // SHA-256 of source file/chunk
  readonly documentId?: string;
  readonly chunkId?: string;
  readonly pageNumber?: number;
  readonly sectionHeading?: string;
  readonly snippet: string;
  readonly verifiedAt: string;
}

// ── Cited Claims & Evidence Types ───────────────────────────────────

export interface CitedClaim {
  readonly id: string;
  readonly statement: string;
  readonly citations: readonly ClaimCitation[];
  readonly isModelGenerated: boolean;
  readonly verifiedAgainstData: boolean;
  readonly confidence?: number;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface EvidenceValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
}

function ok(warnings: string[] = []): EvidenceValidationResult {
  return { valid: true, errors: [], warnings };
}

function fail(errors: string[], warnings: string[] = []): EvidenceValidationResult {
  return { valid: false, errors, warnings };
}

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Validates an OperationalMode string.
 */
export function validateOperationalMode(mode: unknown): EvidenceValidationResult {
  if (typeof mode !== 'string') {
    return fail(['Operational mode must be a string']);
  }
  if (!OPERATIONAL_MODES.includes(mode as OperationalMode)) {
    return fail([`Invalid operational mode '${mode}'. Allowed: ${OPERATIONAL_MODES.join(', ')}`]);
  }
  return ok();
}

/**
 * Validates mode transitions to prevent silent downgrades.
 * Switching from Evidence/Industrial to Brainstorm requires explicit confirmation.
 */
export function validateModeTransition(
  currentMode: OperationalMode,
  targetMode: OperationalMode,
  confirmed = false,
): EvidenceValidationResult {
  const currentNormalized = normalizeOperationalMode(currentMode);
  const targetNormalized = normalizeOperationalMode(targetMode);

  if (currentNormalized === 'evidence' && targetNormalized === 'brainstorm' && !confirmed) {
    return fail([
      'SILENT_DOWNGRADE_FORBIDDEN: Explicit user confirmation required to switch from Industrial/Evidence mode to Brainstorm mode. Unverified exploratory content must not bypass citation controls without acknowledgment.',
    ]);
  }

  return ok();
}

/**
 * Pure validator for CitedClaim under the given operational mode.
 *
 * In 'evidence' / 'industrial' mode:
 *   - citations must be non-empty
 *   - each citation must have valid sourcePath, 64-char hex sourceHash, and non-empty snippet
 *   - model-generated unverified content receives warning UNVERIFIED_MODEL_PROSE
 *
 * In 'brainstorm' mode:
 *   - citations are optional
 *   - uncited claims MUST have isModelGenerated = true and verifiedAgainstData = false
 */
export function validateCitedClaim(
  input: unknown,
  mode: OperationalMode = 'evidence',
): EvidenceValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(['CitedClaim must be a non-null object']);
  }

  const claim = input as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check ID
  if (typeof claim.id !== 'string' || !claim.id.trim()) {
    errors.push('Claim id must be a non-empty string');
  }

  // 2. Check Statement
  if (typeof claim.statement !== 'string' || !claim.statement.trim()) {
    errors.push('Claim statement must be a non-empty string');
  }

  // 3. Confidence range if present
  if (claim.confidence !== undefined) {
    if (typeof claim.confidence !== 'number' || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) {
      errors.push('Claim confidence must be a number between 0.0 and 1.0');
    }
  }

  const normalizedMode = normalizeOperationalMode(mode);

  // 4. Citation and Verification Enforcement
  const citations = claim.citations;
  const isModelGenerated = claim.isModelGenerated === true;
  const verifiedAgainstData = claim.verifiedAgainstData === true;

  if (normalizedMode === 'evidence') {
    // Industrial / Evidence Mode: Citations MANDATORY
    if (!Array.isArray(citations) || citations.length === 0) {
      errors.push(
        'UNCITED_CLAIM_REJECTED: Industrial / Evidence mode strictly requires at least one verified cryptographic citation for every claim.',
      );
    } else {
      // Validate each citation
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        if (!c || typeof c !== 'object') {
          errors.push(`Citation at index ${i} must be an object`);
          continue;
        }
        if (typeof c.sourcePath !== 'string' || !c.sourcePath.trim()) {
          errors.push(`Citation at index ${i} requires a non-empty sourcePath`);
        }
        if (typeof c.sourceHash !== 'string' || !SHA256_HEX_REGEX.test(c.sourceHash)) {
          errors.push(`Citation at index ${i} requires a valid 64-character hex SHA-256 sourceHash`);
        }
        if (typeof c.snippet !== 'string' || !c.snippet.trim()) {
          errors.push(`Citation at index ${i} requires a non-empty snippet`);
        }
      }
    }

    if (isModelGenerated && !verifiedAgainstData) {
      warnings.push(
        'UNVERIFIED_MODEL_PROSE: Model-generated claim is pending human reviewer verification against source evidence.',
      );
    }
  } else {
    // Brainstorm Mode: Citations optional, but unverified claims must be flagged
    if (!Array.isArray(citations) || citations.length === 0) {
      if (verifiedAgainstData) {
        errors.push(
          'BRAINSTORM_UNVERIFIED_ASSERTION: A claim without citations in Brainstorm mode cannot be marked verifiedAgainstData without citations (cannot assert verifiedAgainstData = true).',
        );
      }
      warnings.push(
        'BRAINSTORM_UNVERIFIED_CLAIM: Unverified exploratory statement in Brainstorm mode. Review required before promoting to tasks or deliverables.',
      );
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : ok(warnings);
}

// ── Retention & Scoped Purge Types ──────────────────────────────────

export type PurgeTarget =
  | 'conversations'
  | 'artifact_previews'
  | 'event_display'
  | 'all_expired';

export const PURGE_TARGETS: readonly PurgeTarget[] = [
  'conversations',
  'artifact_previews',
  'event_display',
  'all_expired',
] as const;

export interface PurgeOptions {
  readonly target: PurgeTarget;
  readonly dryRun?: boolean;
  readonly actor?: string;
  readonly reason?: string;
  readonly conversationDays?: number;
  readonly artifactPreviewDays?: number;
  readonly eventDisplayDays?: number;
}

export interface PurgedItemDetail {
  readonly category: 'conversations' | 'artifact_previews' | 'event_display';
  readonly identifier: string;
  readonly relativePath: string;
  readonly ageDays: number;
  readonly sizeBytes: number;
}

export interface PurgeResult {
  readonly purgedConversations: number;
  readonly purgedArtifactPreviews: number;
  readonly purgedEventDisplay: number;
  readonly totalPurged: number;
  readonly freedBytes: number;
  readonly auditRecordSequence?: number;
  readonly auditHash?: string;
  readonly timestamp: string;
  readonly dryRun: boolean;
  readonly items?: readonly PurgedItemDetail[];
}

export interface RetentionStatus {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly retention: RetentionSettings;
  readonly totalConversations: number;
  readonly expiredConversations: number;
  readonly totalArtifactPreviews: number;
  readonly expiredArtifactPreviews: number;
  readonly totalEventDisplayRecords: number;
  readonly expiredEventDisplayRecords: number;
  readonly estimatedReclaimableBytes: number;
  readonly immutableAuditRecordCount: number;
  readonly immutableDeliverableCount: number;
  readonly updatedAt: string;
}

export function validatePurgeOptions(input: unknown): EvidenceValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(['PurgeOptions must be an object']);
  }
  const opts = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof opts.target !== 'string' || !PURGE_TARGETS.includes(opts.target as PurgeTarget)) {
    errors.push(`Invalid purge target '${opts.target}'. Allowed: ${PURGE_TARGETS.join(', ')}`);
  }

  if (opts.conversationDays !== undefined) {
    if (typeof opts.conversationDays !== 'number' || opts.conversationDays < 1 || opts.conversationDays > 365) {
      errors.push('conversationDays must be between 1 and 365');
    }
  }

  if (opts.artifactPreviewDays !== undefined) {
    if (typeof opts.artifactPreviewDays !== 'number' || opts.artifactPreviewDays < 1 || opts.artifactPreviewDays > 365) {
      errors.push('artifactPreviewDays must be between 1 and 365');
    }
  }

  if (opts.eventDisplayDays !== undefined) {
    if (typeof opts.eventDisplayDays !== 'number' || opts.eventDisplayDays < 1 || opts.eventDisplayDays > 365) {
      errors.push('eventDisplayDays must be between 1 and 365');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}
