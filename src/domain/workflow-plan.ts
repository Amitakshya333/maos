/**
 * MAOS Domain — Typed Workflow Plan Schemas (F7-03)
 *
 * Defines versioned, deterministic, and typed workflow plan structures.
 * Enforces explicit step typing, agent assignment, tool boundaries,
 * provenance preservation, and approval gates.
 */

import * as crypto from 'crypto';
import type {
  ExtendedTaskRequirements,
  TaskModelRequirement,
} from './schemas';
import type { EvidenceReference } from './inference';
import {
  MAX_WORKFLOW_PLAN_STEPS,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEP_DEPENDENCIES,
  MAX_PLAN_ID_LENGTH,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_PLAN_STATUSES,
} from './workflow-plan-constants';
import type {
  WorkflowStepType,
  WorkflowStepStatus,
  WorkflowPlanStatus,
} from './workflow-plan-constants';

export {
  MAX_WORKFLOW_PLAN_STEPS,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEP_DEPENDENCIES,
  MAX_PLAN_ID_LENGTH,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_PLAN_STATUSES,
} from './workflow-plan-constants';
export type {
  WorkflowStepType,
  WorkflowStepStatus,
  WorkflowPlanStatus,
} from './workflow-plan-constants';

// ── Step IO Interfaces ────────────────────────────────────────

export interface WorkflowStepInput {
  readonly artifactTypes?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly parameters?: Record<string, unknown>;
}

export interface WorkflowStepOutput {
  readonly expectedArtifactTypes: readonly string[];
  readonly outputSchemaId?: string;
}

// ── Workflow Plan Step ────────────────────────────────────────

export interface WorkflowPlanStep {
  readonly stepId: string;
  readonly stepType: WorkflowStepType;
  readonly title: string;
  readonly assignedAgentId: string;
  readonly requiredTools: readonly string[];
  readonly requiredModel?: TaskModelRequirement;
  readonly dependencies: readonly string[];
  readonly inputs: WorkflowStepInput;
  readonly outputs: WorkflowStepOutput;
  readonly requiresApproval: boolean;
  readonly approvalReason?: string;
  readonly status: WorkflowStepStatus;
}

// ── Provenance ────────────────────────────────────────────────

export interface WorkflowPlanProvenance {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly inferenceInputHash: string;
  readonly sourceArtifactIds: readonly string[];
  readonly sourceHashes: readonly string[];
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly createdAt: string;
}

// ── Complete Workflow Plan ────────────────────────────────────

export interface WorkflowPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly title: string;
  readonly intent: string;
  readonly status: WorkflowPlanStatus;
  readonly provenance: WorkflowPlanProvenance;
  readonly requirements: ExtendedTaskRequirements;
  readonly steps: readonly WorkflowPlanStep[];
  readonly planHash: string;
  readonly deterministic: true;
}

// ── Planning Failure Codes ────────────────────────────────────

export type WorkflowPlanningErrorCode =
  | 'INFERENCE_NOT_MATCHED'
  | 'NO_ELIGIBLE_AGENT'
  | 'REQUIRED_TOOL_UNAVAILABLE'
  | 'FORBIDDEN_TOOL_VIOLATION'
  | 'TOOL_ESCALATION_VIOLATION'
  | 'MODEL_REVISION_MISMATCH'
  | 'MODALITY_UNAVAILABLE'
  | 'STALE_EVIDENCE'
  | 'QUARANTINED_EVIDENCE'
  | 'MISSING_APPROVAL_GATE'
  | 'CYCLIC_DEPENDENCY'
  | 'CROSS_PROJECT_VIOLATION'
  | 'INVALID_PLAN_SCHEMA'
  | 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL';

export type WorkflowPlanningOutcome =
  | {
      readonly success: true;
      readonly plan: WorkflowPlan;
    }
  | {
      readonly success: false;
      readonly code: WorkflowPlanningErrorCode;
      readonly reason: string;
      readonly details?: Record<string, unknown>;
      readonly clarificationPrompt?: string;
    };

// ── Canonical Hashing ─────────────────────────────────────────

/**
 * Computes a deterministic canonical SHA-256 hash for a workflow plan.
 */
export function computeCanonicalPlanHash(
  plan: Omit<WorkflowPlan, 'planHash'> | WorkflowPlan,
): string {
  const normalizedSteps = plan.steps.map((s) => ({
    stepId: s.stepId,
    stepType: s.stepType,
    title: s.title,
    assignedAgentId: s.assignedAgentId,
    requiredTools: [...s.requiredTools].sort(),
    dependencies: [...s.dependencies].sort(),
    inputs: {
      artifactTypes: s.inputs.artifactTypes ? [...s.inputs.artifactTypes].sort() : [],
      sourceIds: s.inputs.sourceIds ? [...s.inputs.sourceIds].sort() : [],
      parameters: s.inputs.parameters || {},
    },
    outputs: {
      expectedArtifactTypes: [...s.outputs.expectedArtifactTypes].sort(),
      outputSchemaId: s.outputs.outputSchemaId || '',
    },
    requiresApproval: s.requiresApproval,
  }));

  const canonicalObj = {
    schemaVersion: 1,
    planId: plan.planId,
    intent: plan.intent,
    provenance: {
      projectId: plan.provenance.projectId,
      taskId: plan.provenance.taskId,
      runId: plan.provenance.runId,
      inferenceInputHash: plan.provenance.inferenceInputHash,
      sourceArtifactIds: [...plan.provenance.sourceArtifactIds].sort(),
      sourceHashes: [...plan.provenance.sourceHashes].sort(),
    },
    requirements: {
      modalities: [...plan.requirements.modalities].sort(),
      primaryModality: plan.requirements.primaryModality || '',
      requiredTools: plan.requirements.tools?.requiredTools
        ? [...plan.requirements.tools.requiredTools].sort()
        : [],
      forbiddenTools: plan.requirements.tools?.forbiddenTools
        ? [...plan.requirements.tools.forbiddenTools].sort()
        : [],
      allowDegradation: plan.requirements.allowDegradation ?? false,
    },
    steps: normalizedSteps,
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalObj))
    .digest('hex');
}
