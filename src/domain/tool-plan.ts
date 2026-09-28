/**
 * MAOS Industrial — Tool and Approval Planning Domain Types (F7-04)
 *
 * Defines explicit execution contracts for workflow plan steps:
 * - Which tool may run.
 * - Which agent may run it.
 * - Required model and revision.
 * - Required inputs and artifacts.
 * - Required approval state.
 * - Required human-review gates.
 * - Expected outputs.
 * - Idempotency key.
 * - Timeout and resource bounds.
 * - Audit event requirements.
 */

import * as crypto from 'crypto';
import type { WorkflowStepType } from './workflow-plan';
import type { TaskModality } from './schemas';
import {
  APPROVAL_CATEGORIES,
  MAX_CONTRACT_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_CONTRACT_ARTIFACTS,
} from './tool-plan-constants';
import type { ApprovalCategory } from './tool-plan-constants';

export {
  APPROVAL_CATEGORIES,
  MAX_CONTRACT_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_CONTRACT_ARTIFACTS,
} from './tool-plan-constants';
export type { ApprovalCategory } from './tool-plan-constants';

export type ToolExecutionContractStatus =
  | 'DRAFT'
  | 'READY'
  | 'APPROVED'
  | 'AWAITING_HUMAN_REVIEW'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED';

export const TOOL_EXECUTION_CONTRACT_STATUSES: readonly ToolExecutionContractStatus[] = [
  'DRAFT',
  'READY',
  'APPROVED',
  'AWAITING_HUMAN_REVIEW',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'REJECTED',
];

export type ToolExecutionErrorCode =
  | 'UNAUTHORIZED_AGENT'
  | 'TOOL_NOT_ALLOWED'
  | 'FORBIDDEN_TOOL'
  | 'MISSING_APPROVAL'
  | 'APPROVAL_NOT_GRANTED'
  | 'INVALID_APPROVAL_HASH'
  | 'STALE_APPROVAL'
  | 'SAFETY_CRITICAL_APPROVAL_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'QUARANTINED_ARTIFACT'
  | 'SOURCE_HASH_MISMATCH'
  | 'MISSING_ARTIFACT'
  | 'CROSS_PROJECT_ARTIFACT_VIOLATION'
  | 'MODEL_REVISION_MISMATCH'
  | 'MODALITY_DEGRADATION_REJECTED'
  | 'DEPENDENCY_UNSATISFIED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_REPLAY'
  | 'OUTPUT_TYPE_MISMATCH'
  | 'PROMPT_INJECTION_REJECTED'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'INVALID_CONTRACT_SCHEMA'
  | 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL';

export interface HumanReviewGate {
  readonly reason: string;
  readonly requiredReviewerRole?: string;
  readonly criteria?: readonly string[];
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly reviewVerdict?: 'APPROVED' | 'REJECTED';
  readonly reviewNotes?: string;
}

export interface ApprovalGate {
  readonly gateId: string;
  readonly requiredStatus: 'approved';
  readonly payloadHash?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly conditions?: readonly string[];
}

export interface ResourceBounds {
  readonly maxMemoryMb?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxExecutionTimeMs?: number;
}

export interface AuditRequirement {
  readonly eventType: string;
  readonly requiredFields: readonly string[];
}

export interface ToolExecutionPlan {
  readonly schemaVersion: 1;
  readonly contractId: string;
  readonly workflowPlanId: string;
  readonly stepId: string;
  readonly stepType: WorkflowStepType;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly authorizedAgent: string;
  readonly allowedTool: string;
  readonly requiredModel?: string;
  readonly requiredRevision?: string;
  readonly requiredModalities: readonly TaskModality[];
  readonly inputArtifactIds: readonly string[];
  readonly sourceHashes: readonly string[];
  readonly approvalRequirement: ApprovalCategory;
  readonly humanReviewRequirement: boolean;
  readonly humanReviewGate?: HumanReviewGate;
  readonly approvalGate?: ApprovalGate;
  readonly expectedOutputType: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly resourceBounds: ResourceBounds;
  readonly auditRequirement: AuditRequirement;
  readonly contractHash: string;
}

export interface PreExecutionEvaluationOutcome {
  readonly success: boolean;
  readonly code?: ToolExecutionErrorCode;
  readonly reason?: string;
  readonly contract?: ToolExecutionPlan;
  readonly details?: Record<string, unknown>;
  readonly replayResult?: string;
}

/**
 * Computes a deterministic canonical SHA-256 hash over an execution contract.
 * Excludes the contractHash field itself to provide pure cryptographic integrity.
 */
export function computeCanonicalContractHash(
  contract: Omit<ToolExecutionPlan, 'contractHash'>,
): string {
  const canonicalPayload = {
    schemaVersion: 1,
    contractId: contract.contractId,
    workflowPlanId: contract.workflowPlanId,
    stepId: contract.stepId,
    stepType: contract.stepType,
    projectId: contract.projectId,
    taskId: contract.taskId,
    runId: contract.runId,
    authorizedAgent: contract.authorizedAgent,
    allowedTool: contract.allowedTool,
    requiredModel: contract.requiredModel || null,
    requiredRevision: contract.requiredRevision || null,
    requiredModalities: [...contract.requiredModalities].sort(),
    inputArtifactIds: [...contract.inputArtifactIds].sort(),
    sourceHashes: [...contract.sourceHashes].sort(),
    approvalRequirement: contract.approvalRequirement,
    humanReviewRequirement: contract.humanReviewRequirement,
    humanReviewGate: contract.humanReviewGate
      ? {
          reason: contract.humanReviewGate.reason,
          requiredReviewerRole: contract.humanReviewGate.requiredReviewerRole || null,
          criteria: contract.humanReviewGate.criteria ? [...contract.humanReviewGate.criteria].sort() : [],
        }
      : null,
    approvalGate: contract.approvalGate
      ? {
          gateId: contract.approvalGate.gateId,
          requiredStatus: contract.approvalGate.requiredStatus,
          payloadHash: contract.approvalGate.payloadHash || null,
        }
      : null,
    expectedOutputType: contract.expectedOutputType,
    idempotencyKey: contract.idempotencyKey,
    timeoutMs: contract.timeoutMs,
    resourceBounds: {
      maxMemoryMb: contract.resourceBounds.maxMemoryMb || null,
      maxFileSizeBytes: contract.resourceBounds.maxFileSizeBytes || null,
      maxExecutionTimeMs: contract.resourceBounds.maxExecutionTimeMs || null,
    },
    auditRequirement: {
      eventType: contract.auditRequirement.eventType,
      requiredFields: [...contract.auditRequirement.requiredFields].sort(),
    },
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalPayload), 'utf-8')
    .digest('hex');
}
