/**
 * MAOS Model Manifest and Lease Domain Schemas (UI1-11)
 *
 * Provides authoritative definitions, pinned model registries,
 * typed residency status, and pure validators for model management and leases.
 */

import type { ValidationResult } from './validators';
import { PINNED_VLM_CONFIG } from './vision';
import { PINNED_EMBEDDING_CONFIG } from './embedding';

export type ModelDevice = 'cuda' | 'cpu' | 'none';

export type QueuePriorityClass =
  | 'interactive_chat'
  | 'user_task'
  | 'active_workflow'
  | 'auto_workflow'
  | 'background_indexing';

export const PRIORITY_WEIGHTS: Record<QueuePriorityClass, number> = {
  interactive_chat: 1,
  user_task: 2,
  active_workflow: 3,
  auto_workflow: 4,
  background_indexing: 5,
};

export interface ModelRegistration {
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly architecture: string;
  readonly quantization: string;
  readonly vramRequiredMb: number;
  readonly device: 'cuda' | 'cpu';
  readonly port: number;
  readonly manifestPath?: string;
  readonly snapshotPath?: string;
  readonly isHealthy: boolean;
  readonly unhealthyReason?: string;
}

export interface ModelResidencyStatus {
  readonly residentModelId: string | null;
  readonly residentModelRevision: string | null;
  readonly residentDevice: ModelDevice;
  readonly vramUsedMb: number;
  readonly vramBudgetMb: number;
  readonly activeLeases: number;
  readonly queueLength: number;
  readonly healthy: boolean;
  readonly unhealthyReason?: string;
  readonly residentModels?: string[];
  readonly estimatedVramMb?: number;
}

export interface AcquireModelLeaseInput {
  readonly modelId: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly priority?: QueuePriorityClass | number;
  readonly timeoutMs?: number;
  readonly expectedRevision?: string;
  readonly allowCpuFallback?: boolean;
  readonly port?: number;
}

export interface RenewModelLeaseInput {
  readonly leaseId: string;
  readonly extensionMs: number;
  readonly projectId?: string;
  readonly runId?: string;
}

export interface ReleaseModelLeaseInput {
  readonly leaseId: string;
  readonly projectId?: string;
  readonly runId?: string;
}

// ── Pinned Model Registrations ──────────────────────────────────────

export const PINNED_TEXT_CONFIG = {
  modelId: 'Qwen/Qwen2.5-3B-Instruct',
  modelName: 'qwen2.5-3b-instruct-local',
  revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
  architecture: 'Qwen2ForCausalLM',
  quantization: 'fp16',
  vramRequiredMb: 4096,
  device: 'cuda' as const,
  port: 8000,
  manifestFilename: 'model-snapshot-manifest.json',
  snapshotRelativePath: 'models--Qwen--Qwen2.5-3B-Instruct/snapshots/aa8e72537993ba99e69dfaafa59ed015b17504d1',
} as const;

export const PINNED_MODELS = [
  PINNED_TEXT_CONFIG,
  {
    ...PINNED_VLM_CONFIG,
    manifestFilename: 'vlm-snapshot-manifest.json',
    vramRequiredMb: 3072,
    port: 8001,
  },
  {
    ...PINNED_EMBEDDING_CONFIG,
    manifestFilename: 'embedding-snapshot-manifest.json',
    vramRequiredMb: 0,
    port: 8002,
  },
] as const;

// ── Pure Validators ────────────────────────────────────────────────

export function validateAcquireModelLeaseInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['AcquireModelLeaseInput must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof payload.modelId !== 'string' || !payload.modelId.trim()) {
    errors.push('modelId must be a non-empty string');
  }

  if (typeof payload.agentId !== 'string' || !payload.agentId.trim()) {
    errors.push('agentId must be a non-empty string');
  }

  if (payload.port !== undefined) {
    if (typeof payload.port !== 'number' || payload.port < 1 || payload.port > 65535) {
      errors.push('port must be a number between 1 and 65535');
    }
  }

  if (payload.timeoutMs !== undefined) {
    if (typeof payload.timeoutMs !== 'number' || payload.timeoutMs <= 0) {
      errors.push('timeoutMs must be a positive number');
    }
  }

  if (payload.priority !== undefined) {
    const validPriorities = Object.keys(PRIORITY_WEIGHTS);
    if (
      typeof payload.priority === 'string' &&
      !validPriorities.includes(payload.priority)
    ) {
      errors.push(`Invalid priority '${payload.priority}'. Allowed: ${validPriorities.join(', ')}`);
    } else if (
      typeof payload.priority === 'number' &&
      (payload.priority < 1 || payload.priority > 5)
    ) {
      errors.push('Numeric priority must be between 1 (highest) and 5 (lowest)');
    }
  }

  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    errors.push('projectId must be a string');
  }

  if (payload.runId !== undefined && typeof payload.runId !== 'string') {
    errors.push('runId must be a string');
  }

  return { valid: errors.length === 0, errors };
}

export function validateRenewModelLeaseInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['RenewModelLeaseInput must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof payload.leaseId !== 'string' || !payload.leaseId.trim()) {
    errors.push('leaseId must be a non-empty string');
  }

  if (typeof payload.extensionMs !== 'number' || payload.extensionMs <= 0 || payload.extensionMs > 86400000) {
    errors.push('extensionMs must be a positive number <= 86,400,000 (24h)');
  }

  return { valid: errors.length === 0, errors };
}

export function validateReleaseModelLeaseInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['ReleaseModelLeaseInput must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof payload.leaseId !== 'string' || !payload.leaseId.trim()) {
    errors.push('leaseId must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}
