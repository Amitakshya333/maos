/**
 * MAOS Domain — Inference Schemas and Types (F7-02)
 *
 * Defines canonical types for deterministic text and attachment inference.
 * Provides structured classification, confidence scoring, evidence linkage,
 * and unambiguous clarification protocols without dynamic LLM guessing.
 */

import type { ExtendedTaskRequirements, TaskModality } from './schemas';

// ── Bounds ────────────────────────────────────────────────────

export const MAX_INFERENCE_TEXT_LENGTH = 100_000;
export const MAX_INFERENCE_ATTACHMENTS = 50;
export const MAX_ATTACHMENT_NAME_LENGTH = 500;
export const MAX_REASONING_CODES = 50;
export const MAX_EVIDENCE_REFERENCES = 100;

// ── Enums ─────────────────────────────────────────────────────

export type InferenceStatus =
  | 'MATCHED'
  | 'AMBIGUOUS'
  | 'UNSUPPORTED'
  | 'CLARIFICATION_REQUIRED';

export const INFERENCE_STATUSES: readonly InferenceStatus[] = [
  'MATCHED',
  'AMBIGUOUS',
  'UNSUPPORTED',
  'CLARIFICATION_REQUIRED',
];

// ── Attachment & Input Schemas ─────────────────────────────────

export interface TaskAttachment {
  readonly name: string;
  readonly mimeType?: string;
  readonly sourcePath?: string;
  readonly content?: string;
  readonly buffer?: Buffer;
  readonly sourceHash?: string;
  readonly artifactId?: string;
  readonly sizeBytes?: number;
  readonly pageCount?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface InferenceInput {
  readonly text?: string;
  readonly attachments?: readonly TaskAttachment[];
  readonly context?: Record<string, unknown>;
}

// ── Evidence & Rule Schemas ───────────────────────────────────

export interface EvidenceReference {
  readonly source: string;
  readonly ref: string;
  readonly matchDetail: string;
  readonly hash?: string;
}

export interface InferenceRuleMatch {
  readonly matched: boolean;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

export interface InferenceRule {
  readonly ruleId: string;
  readonly name: string;
  readonly version: number;
  readonly priority: number;
  readonly category: string;
  readonly targetIntent: string;
  readonly requiredModalities: readonly TaskModality[];
  readonly suggestedAgent?: string;
  readonly suggestedWorkflow?: string;
  readonly inferredRequirements: ExtendedTaskRequirements;
  readonly matcher: (input: InferenceInput) => InferenceRuleMatch;
}

// ── Inference Result Schema ────────────────────────────────────

export interface InferenceResult {
  readonly schemaVersion: 1;
  readonly status: InferenceStatus;
  readonly inferredIntent: string;
  readonly confidence: number;
  readonly matchedRuleId: string | null;
  readonly matchedRuleVersion: number | null;
  readonly reasoningCodes: readonly string[];
  readonly supportingEvidence: readonly EvidenceReference[];
  readonly requirements: ExtendedTaskRequirements | null;
  readonly selectedModality: TaskModality | null;
  readonly selectedAgent?: string | null;
  readonly selectedWorkflow?: string | null;
  readonly clarificationPrompt?: string | null;
  readonly inputHash: string;
  readonly deterministic: true;
}
