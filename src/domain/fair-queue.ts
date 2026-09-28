/**
 * MAOS Fair Priority and Cancellation Queue Domain Schemas (UI1-12)
 *
 * Defines authoritative domain types, queue states, fixed priority classes,
 * pure validators, and error codes for the fair, cancellable execution queue.
 */

import type { ValidationResult } from './validators';
import { QueuePriorityClass, PRIORITY_WEIGHTS } from './model-manifest';

export type { QueuePriorityClass };
export { PRIORITY_WEIGHTS };

export type QueueState =
  | 'queued'
  | 'waiting_for_model_lease'
  | 'waiting_for_vram'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted';

export const VALID_QUEUE_STATES: readonly QueueState[] = [
  'queued',
  'waiting_for_model_lease',
  'waiting_for_vram',
  'running',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'interrupted',
] as const;

export const VALID_PRIORITY_CLASSES: readonly QueuePriorityClass[] = [
  'interactive_chat',
  'user_task',
  'active_workflow',
  'auto_workflow',
  'background_indexing',
] as const;

export interface QueueEntry {
  readonly id: string;
  readonly taskId?: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly priorityClass: QueuePriorityClass;
  readonly basePriority: number; // 1-5
  readonly effectivePriority: number; // 1-5, aged
  readonly queuePosition: number; // 1-based position among active queue
  readonly state: QueueState;
  readonly requestedModelId: string;
  readonly requestedDevice: 'cuda' | 'cpu';
  readonly allowCpuFallback: boolean;
  readonly leaseId?: string;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly ageSeconds: number;
  readonly isAged: boolean; // ageSeconds >= 60
  readonly cancellationStatus?: 'none' | 'requested' | 'cancelling' | 'cancelled';
  readonly cancellationReason?: string;
  readonly blockingReason?: string;
  readonly failureReason?: string;
  readonly idempotencyKey?: string;
  readonly dependencies?: string[];
}

export interface EnqueueRequestInput {
  taskId?: string;
  agentId: string;
  projectId?: string;
  runId?: string;
  priorityClass: QueuePriorityClass;
  requestedModelId: string;
  requestedDevice?: 'cuda' | 'cpu';
  allowCpuFallback?: boolean;
  timeoutMs?: number;
  idempotencyKey?: string;
  dependencies?: string[];
  description?: string;
}

export interface CancelQueueEntryInput {
  entryId?: string;
  projectId?: string;
  runId?: string;
  reason?: string;
  force?: boolean;
}

export interface QueueStatusSummary {
  readonly totalQueued: number;
  readonly activeRunning: number;
  readonly waitingForVram: number;
  readonly consecutiveChatTurns: number;
  readonly maxConsecutiveChatTurns: number;
  readonly residentModelId: string | null;
  readonly residentDevice: string;
  readonly vramUsedMb: number;
  readonly vramBudgetMb: number;
  readonly entries: QueueEntry[];
}

export const QUEUE_ERROR_CODES = {
  INVALID_PRIORITY_CLASS: 'INVALID_PRIORITY_CLASS',
  DUPLICATE_QUEUE_ENTRY: 'DUPLICATE_QUEUE_ENTRY',
  CROSS_PROJECT_CANCELLATION_FORBIDDEN: 'CROSS_PROJECT_CANCELLATION_FORBIDDEN',
  WRONG_RUN_CANCELLATION_FORBIDDEN: 'WRONG_RUN_CANCELLATION_FORBIDDEN',
  DEPENDENCIES_NOT_SATISFIED: 'DEPENDENCIES_NOT_SATISFIED',
  SILENT_FALLBACK_PROHIBITED: 'SILENT_FALLBACK_PROHIBITED',
  CANNOT_COMPLETE_CANCELLED_TASK: 'CANNOT_COMPLETE_CANCELLED_TASK',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
} as const;

export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES];

export class QueueError extends Error {
  public readonly code: QueueErrorCode;
  public readonly statusCode: number;

  constructor(message: string, code: QueueErrorCode, statusCode = 400) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, QueueError.prototype);
  }
}

/**
 * Pure validator for EnqueueRequestInput.
 */
export function validateEnqueueInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['EnqueueRequestInput must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof payload.agentId !== 'string' || !payload.agentId.trim()) {
    errors.push('agentId must be a non-empty string');
  }

  if (typeof payload.requestedModelId !== 'string' || !payload.requestedModelId.trim()) {
    errors.push('requestedModelId must be a non-empty string');
  }

  if (typeof payload.priorityClass !== 'string' || !VALID_PRIORITY_CLASSES.includes(payload.priorityClass as QueuePriorityClass)) {
    errors.push(
      `priorityClass must be one of the approved classes: ${VALID_PRIORITY_CLASSES.join(', ')}`,
    );
  }

  if (payload.requestedDevice !== undefined && payload.requestedDevice !== 'cuda' && payload.requestedDevice !== 'cpu') {
    errors.push("requestedDevice must be 'cuda' or 'cpu'");
  }

  if (payload.allowCpuFallback !== undefined && typeof payload.allowCpuFallback !== 'boolean') {
    errors.push('allowCpuFallback must be a boolean');
  }

  if (payload.timeoutMs !== undefined) {
    if (typeof payload.timeoutMs !== 'number' || payload.timeoutMs <= 0) {
      errors.push('timeoutMs must be a positive number');
    }
  }

  if (payload.taskId !== undefined && (typeof payload.taskId !== 'string' || !payload.taskId.trim())) {
    errors.push('taskId must be a non-empty string if provided');
  }

  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    errors.push('projectId must be a string');
  }

  if (payload.runId !== undefined && typeof payload.runId !== 'string') {
    errors.push('runId must be a string');
  }

  if (payload.idempotencyKey !== undefined && (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey.trim())) {
    errors.push('idempotencyKey must be a non-empty string if provided');
  }

  if (payload.dependencies !== undefined) {
    if (!Array.isArray(payload.dependencies)) {
      errors.push('dependencies must be an array of string task IDs');
    } else {
      for (let i = 0; i < payload.dependencies.length; i++) {
        if (typeof payload.dependencies[i] !== 'string') {
          errors.push(`dependencies[${i}] must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Pure validator for CancelQueueEntryInput.
 */
export function validateCancelInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['CancelQueueEntryInput must be a non-null object'] };
  }

  const payload = input as Record<string, unknown>;
  const errors: string[] = [];

  if (payload.entryId !== undefined && (typeof payload.entryId !== 'string' || !payload.entryId.trim())) {
    errors.push('entryId must be a non-empty string if provided');
  }

  if (payload.projectId !== undefined && typeof payload.projectId !== 'string') {
    errors.push('projectId must be a string');
  }

  if (payload.runId !== undefined && typeof payload.runId !== 'string') {
    errors.push('runId must be a string');
  }

  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    errors.push('reason must be a string');
  }

  if (payload.force !== undefined && typeof payload.force !== 'boolean') {
    errors.push('force must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}
