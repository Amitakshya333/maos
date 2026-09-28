/**
 * MAOS Domain: Model Switcher and Auto-Routing Schemas (UI1-13)
 *
 * Provides typed definitions, error codes, and pure validators for:
 * 1. Automatic task-to-model routing (modality, complexity, task intent)
 * 2. Audited manual model override (actor, reason, revision, confirmation)
 * 3. Authoritative active model identity and residency visibility
 * 4. Workflow-fixed model and revision protection
 * 5. Modality compatibility matrices and fail-closed validation
 */

import type { ValidationResult } from './validators';
import type { TaskModality } from './schemas';
import type { ModelDevice } from './model-manifest';

export type { TaskModality };

// ── Error Codes ───────────────────────────────────────────────────

export const SWITCH_ERROR_CODES = {
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  NO_RUNTIME_DOWNLOAD: 'NO_RUNTIME_DOWNLOAD',
  SNAPSHOT_CORRUPTED: 'SNAPSHOT_CORRUPTED',
  MODEL_UNHEALTHY: 'MODEL_UNHEALTHY',
  MODALITY_INCOMPATIBLE: 'MODALITY_INCOMPATIBLE',
  WORKFLOW_FIXED_MODEL_PROTECTED: 'WORKFLOW_FIXED_MODEL_PROTECTED',
  CONCURRENCY_VIOLATION: 'CONCURRENCY_VIOLATION',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  UNAUDITED_OVERRIDE: 'UNAUDITED_OVERRIDE',
  CROSS_PROJECT_ACCESS: 'CROSS_PROJECT_ACCESS',
  MID_RUN_SWITCH_FORBIDDEN: 'MID_RUN_SWITCH_FORBIDDEN',
  OOM_BUDGET_EXCEEDED: 'OOM_BUDGET_EXCEEDED',
} as const;

export type SwitchErrorCode = typeof SWITCH_ERROR_CODES[keyof typeof SWITCH_ERROR_CODES];

export class ModelSwitchError extends Error {
  constructor(
    message: string,
    public readonly code: SwitchErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ModelSwitchError';
  }
}

// ── Modality & Model Compatibility ─────────────────────────────────

export interface ModelModalityCapability {
  readonly modelId: string;
  readonly supportedModalities: readonly TaskModality[];
  readonly primaryIntent: string;
  readonly maxContextTokens: number;
}

export const PINNED_MODEL_CAPABILITIES: readonly ModelModalityCapability[] = [
  {
    modelId: 'Qwen/Qwen2.5-3B-Instruct',
    supportedModalities: ['text', 'code'],
    primaryIntent: 'General reasoning, industrial code generation, structured deliverable text',
    maxContextTokens: 32768,
  },
  {
    modelId: 'Qwen/Qwen2-VL-2B-Instruct',
    supportedModalities: ['vision', 'multimodal', 'text'],
    primaryIntent: 'Visual document inspection, technical diagram OCR review, image reasoning',
    maxContextTokens: 8192,
  },
  {
    modelId: 'sentence-transformers/all-MiniLM-L6-v2',
    supportedModalities: ['embedding'],
    primaryIntent: 'Dense vector embeddings, semantic search, KB index retrieval',
    maxContextTokens: 512,
  },
] as const;

// ── Auto-Routing Domain Types ─────────────────────────────────────

export interface ModelRouteRequest {
  readonly taskType?: string;
  readonly modality?: TaskModality | string;
  readonly hasImages?: boolean;
  readonly complexity?: 'low' | 'medium' | 'high';
  readonly promptText?: string;
  readonly projectId?: string;
}

export interface ModelRouteResult {
  readonly selectedModelId: string;
  readonly selectedRevision: string;
  readonly device: 'cuda' | 'cpu';
  readonly vramRequiredMb: number;
  readonly reason: string;
  readonly confidence: number;
  readonly alternativeModelIds: string[];
}

// ── Manual Switch Domain Types ────────────────────────────────────

export interface ModelSwitchRequest {
  readonly targetModelId: string;
  readonly expectedRevision?: string;
  readonly actor: string;
  readonly reason: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly conversationId?: string;
  readonly confirmed?: boolean;
  readonly requiredModality?: TaskModality | string;
}

export type SwitchStatus =
  | 'SWITCHED'
  | 'CONFIRMATION_REQUIRED'
  | 'QUEUED'
  | 'REJECTED';

export interface ModelSwitchResult {
  readonly status: SwitchStatus;
  readonly previousModelId: string | null;
  readonly activeModelId: string;
  readonly activeRevision: string;
  readonly device: ModelDevice;
  readonly vramUsedMb: number;
  readonly requiresUnload: boolean;
  readonly message: string;
  readonly auditEventId?: string;
  readonly leaseId?: string;
}

export interface ActiveModelIdentity {
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly revision: string | null;
  readonly architecture: string | null;
  readonly quantization: string | null;
  readonly device: ModelDevice;
  readonly vramUsedMb: number;
  readonly vramBudgetMb: number;
  readonly activeLeases: number;
  readonly queueLength: number;
  readonly healthy: boolean;
  readonly unhealthyReason?: string;
  readonly isWorkflowFixed: boolean;
  readonly lockedByRunId: string | null;
  readonly supportedModalities: string[];
}

// ── Pure Validators ───────────────────────────────────────────────

export function validateModelRouteRequest(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['ModelRouteRequest must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (payload.taskType !== undefined && typeof payload.taskType !== 'string') {
    errors.push('taskType must be a string if provided');
  }

  if (payload.modality !== undefined && typeof payload.modality !== 'string') {
    errors.push('modality must be a string if provided');
  }

  if (payload.hasImages !== undefined && typeof payload.hasImages !== 'boolean') {
    errors.push('hasImages must be a boolean if provided');
  }

  if (payload.complexity !== undefined) {
    if (!['low', 'medium', 'high'].includes(String(payload.complexity))) {
      errors.push('complexity must be one of: low, medium, high');
    }
  }

  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    errors.push('projectId must be a string if provided');
  }

  return { valid: errors.length === 0, errors };
}

export function validateModelSwitchRequest(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['ModelSwitchRequest must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof payload.targetModelId !== 'string' || !payload.targetModelId.trim()) {
    errors.push('targetModelId must be a non-empty string');
  }

  if (typeof payload.actor !== 'string' || !payload.actor.trim()) {
    errors.push('actor must be a non-empty string (audited override requirement)');
  }

  if (typeof payload.reason !== 'string' || !payload.reason.trim()) {
    errors.push('reason must be a non-empty string (audited override requirement)');
  }

  if (payload.expectedRevision !== undefined && (typeof payload.expectedRevision !== 'string' || !payload.expectedRevision.trim())) {
    errors.push('expectedRevision must be a non-empty string if provided');
  }

  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') {
    errors.push('confirmed must be a boolean if provided');
  }

  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    errors.push('projectId must be a string if provided');
  }

  if (payload.runId !== undefined && typeof payload.runId !== 'string') {
    errors.push('runId must be a string if provided');
  }

  if (payload.conversationId !== undefined && typeof payload.conversationId !== 'string') {
    errors.push('conversationId must be a string if provided');
  }

  return { valid: errors.length === 0, errors };
}
