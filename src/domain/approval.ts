/**
 * MAOS Industrial — Governance Approval Domain Schemas (UI1-14)
 *
 * Defines authoritative domain models, explicit scopes, pure validators,
 * and fail-closed security error codes for privileged and gated actions:
 * - DOCX generation
 * - XLSX generation
 * - PPTX generation
 * - Safety-verdict application
 * - Artifact overwrite
 * - Force-stop operations
 * - Final reviewer sign-off
 * - Project-scoped writes explicitly allowed by policy
 *
 * Enforces:
 * 1. Exactly 15 required fields on every approval record:
 *    approvalId, projectId, runId, taskId, stepId, actorId, actorRole, status,
 *    reason, scope, createdAt, expiresAt, payloadHash, sourceHashes, artifactIds.
 * 2. Non-reusable single-use scope: approvals are tightly bound to exact hashes,
 *    project, run, and task identities; reuse or replay is strictly rejected.
 * 3. Fail-closed safety rules:
 *    - Rejection of missing, pending, rejected, or expired approvals.
 *    - Rejection of payload or source hash changes after approval.
 *    - Rejection of cross-project and cross-run approval usage.
 *    - Rejection of hidden auto-approval upon creation.
 *    - Rejection of untrusted model/agent prose self-approval.
 *    - Rejection of unconfirmed force-stops and phantom success reporting.
 */

import type { ValidationResult } from './validators';
import { ok, fail } from './validators';
import type { ApprovalStatus } from './schemas';

// ── Local Type Guards ────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return isArray(v) && v.every(isString);
}

// ── Explicit Approval Scopes ──────────────────────────────────────────

export type ApprovalScope =
  | 'docx_generation'
  | 'xlsx_generation'
  | 'pptx_generation'
  | 'safety_verdict'
  | 'artifact_overwrite'
  | 'force_stop'
  | 'reviewer_signoff'
  | 'project_scoped_write';

export const VALID_APPROVAL_SCOPES: readonly ApprovalScope[] = [
  'docx_generation',
  'xlsx_generation',
  'pptx_generation',
  'safety_verdict',
  'artifact_overwrite',
  'force_stop',
  'reviewer_signoff',
  'project_scoped_write',
] as const;

// ── Approval Statuses ────────────────────────────────────────────────

export const VALID_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'conditional',
] as const;

// ── Authorized Human Reviewer Roles ──────────────────────────────────

export const AUTHORIZED_HUMAN_ROLES: readonly string[] = [
  'reviewer',
  'lead',
  'admin',
  'operator',
  'user',
  'auditor',
  'sec-officer',
  'engineer',
  'compliance-officer',
] as const;

// ── Error Codes ──────────────────────────────────────────────────────

export const APPROVAL_ERROR_CODES = {
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  PAYLOAD_HASH_MISMATCH: 'PAYLOAD_HASH_MISMATCH',
  SOURCE_HASH_MISMATCH: 'SOURCE_HASH_MISMATCH',
  CROSS_PROJECT_APPROVAL_USE: 'CROSS_PROJECT_APPROVAL_USE',
  CROSS_RUN_APPROVAL_USE: 'CROSS_RUN_APPROVAL_USE',
  SCOPE_MISMATCH: 'SCOPE_MISMATCH',
  ARTIFACT_MISMATCH: 'ARTIFACT_MISMATCH',
  OPERATION_REUSE_REJECTED: 'OPERATION_REUSE_REJECTED',
  UNAUTHORIZED_OVERWRITE: 'UNAUTHORIZED_OVERWRITE',
  AUTO_APPROVAL_FORBIDDEN: 'AUTO_APPROVAL_FORBIDDEN',
  UNTRUSTED_SELF_APPROVAL_REJECTED: 'UNTRUSTED_SELF_APPROVAL_REJECTED',
  UNAUTHORIZED_REVIEWER_ROLE: 'UNAUTHORIZED_REVIEWER_ROLE',
  SAFETY_FINDING_BYPASS_REJECTED: 'SAFETY_FINDING_BYPASS_REJECTED',
  FORCE_STOP_CONFIRMATION_REQUIRED: 'FORCE_STOP_CONFIRMATION_REQUIRED',
  PHANTOM_SUCCESS_REJECTED: 'PHANTOM_SUCCESS_REJECTED',
  SCOPE_INVALIDATED: 'SCOPE_INVALIDATED',
  CANNOT_DECIDE_NON_PENDING: 'UNAUTHORIZED_TRANSITION',
  UNAUTHORIZED_TRANSITION: 'UNAUTHORIZED_TRANSITION',
  INVALID_APPROVAL_SCHEMA: 'INVALID_APPROVAL_SCHEMA',
} as const;

export type ApprovalErrorCode =
  (typeof APPROVAL_ERROR_CODES)[keyof typeof APPROVAL_ERROR_CODES];

export class ApprovalError extends Error {
  constructor(
    public readonly code: ApprovalErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ApprovalError';
    Object.setPrototypeOf(this, ApprovalError.prototype);
  }
}

// ── Core Domain Interfaces ───────────────────────────────────────────

export interface ApprovalRecord {
  readonly schemaVersion: 1;
  // 15 Authoritative Fields
  readonly approvalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly actorId: string;
  readonly actorRole: string;
  readonly status: ApprovalStatus;
  readonly reason: string;
  readonly scope: ApprovalScope;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly payloadHash: string;
  readonly sourceHashes: readonly string[];
  readonly artifactIds: readonly string[];

  // Resolution and audit fields
  readonly id?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string | null;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string | null;
  readonly reviewRole?: string;
  readonly reviewNotes?: string;
  readonly conditions: readonly string[];
  readonly evidenceId?: string;
  readonly gateId?: string;
  readonly consumed?: boolean;
  readonly consumedAt?: string | null;
  readonly consumedBy?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateApprovalInput {
  approvalId?: string;
  id?: string;
  projectId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  actorId: string;
  actorRole: string;
  reason: string;
  scope: ApprovalScope;
  payloadHash: string;
  sourceHashes?: readonly string[];
  artifactIds?: readonly string[];
  expiresInSeconds?: number;
  expiresAt?: string;
  evidenceId?: string;
  gateId?: string;
  conditions?: readonly string[];
  status?: 'pending';
  metadata?: Record<string, unknown>;
}

export interface ReviewApprovalInput {
  decision: 'approved' | 'rejected';
  actorId: string;
  actorRole: string;
  notes?: string;
  conditions?: readonly string[];
}

export interface ApprovalValidationContext {
  scope?: ApprovalScope;
  operation?: string;
  projectId: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  payloadHash?: string;
  sourceHashes?: readonly string[];
  artifactId?: string;
  targetArtifactId?: string;
  allowReuse?: boolean;
  forceConfirm?: boolean;
  isOverwrite?: boolean;
  hasSafetyFinding?: boolean;
}

export interface ApprovalCheckResult {
  valid: boolean;
  allowed?: boolean;
  code?: ApprovalErrorCode;
  reason?: string;
  approval?: ApprovalRecord;
  approvalId?: string;
}

export interface ForceStopParams {
  approvalId?: string;
  taskId: string;
  runId: string;
  projectId: string;
  confirm: boolean;
  reason: string;
  actorId: string;
  actorRole?: string;
}

export interface ForceStopResult {
  success: boolean;
  status: 'cancelled' | 'interrupted';
  taskId: string;
  runId: string;
  stoppedAt: string;
  auditRecorded: boolean;
  phantomSuccessDefended?: boolean;
  queueCancelled?: boolean;
  taskStatus?: string;
  details?: Record<string, unknown>;
}

export function isReadOnlyOperation(operation: string): boolean {
  if (!operation || typeof operation !== 'string') return false;
  const op = operation.trim().toLowerCase();
  const readOnlyOps = new Set([
    'inference',
    'ordinary_inference',
    'llm_prompt',
    'sandbox_exec',
    'sandbox_run',
    'read_file',
    'get_status',
    'search',
    'kb_search',
  ]);
  return readOnlyOps.has(op);
}

// ── Pure Validators ──────────────────────────────────────────────────

/**
 * Validates approval creation input.
 * Strictly prevents hidden auto-approval (status cannot be 'approved' initially).
 */
export function validateCreateApprovalInput(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['CreateApprovalInput must be an object']);
  const errors: string[] = [];

  const raw = input as Record<string, any>;

  // Fail-closed against hidden auto-approval
  if (raw.status !== undefined && raw.status !== 'pending') {
    errors.push('New approval requests cannot be auto-approved; auto-approval on creation is forbidden');
  }

  // Required string fields
  if (!isString(raw.projectId) || raw.projectId.trim().length === 0) {
    errors.push('Field "projectId" is required and must be a non-empty string');
  }
  if (!isString(raw.runId) || raw.runId.trim().length === 0) {
    errors.push('Field "runId" is required and must be a non-empty string');
  }
  if (!isString(raw.taskId) || raw.taskId.trim().length === 0) {
    errors.push('Field "taskId" is required and must be a non-empty string');
  }
  if (raw.stepId !== undefined && (!isString(raw.stepId) || raw.stepId.trim().length === 0)) {
    errors.push('Field "stepId" must be a non-empty string when provided');
  }
  if (!isString(raw.actorId) || raw.actorId.trim().length === 0) {
    errors.push('Field "actorId" is required and must be a non-empty string');
  }
  if (!isString(raw.actorRole) || raw.actorRole.trim().length === 0) {
    errors.push('Field "actorRole" is required and must be a non-empty string');
  }
  if (!isString(raw.reason) || raw.reason.trim().length < 3) {
    errors.push('Field "reason" is required and must be at least 3 characters');
  }

  // Scope validation
  if (!isString(raw.scope) || !VALID_APPROVAL_SCOPES.includes(raw.scope as ApprovalScope)) {
    errors.push(`Invalid scope: Field "scope" must be one of: ${VALID_APPROVAL_SCOPES.join(', ')}`);
  }

  // Payload hash validation (must be 64-hex char SHA-256 or non-empty string >= 32 chars)
  if (!isString(raw.payloadHash) || raw.payloadHash.trim().length < 32) {
    errors.push('Field "payloadHash" is required and must be a valid cryptographic hash (min 32 chars)');
  }

  // Arrays
  if (raw.sourceHashes !== undefined && raw.sourceHashes !== null) {
    if (!isStringArray(raw.sourceHashes)) {
      errors.push('Field "sourceHashes" must be an array of strings');
    }
  }
  if (raw.artifactIds !== undefined && raw.artifactIds !== null) {
    if (!isStringArray(raw.artifactIds)) {
      errors.push('Field "artifactIds" must be an array of strings');
    }
  }

  // Optional TTL / expiration
  if (raw.expiresInSeconds !== undefined && raw.expiresInSeconds !== null) {
    if (!isNumber(raw.expiresInSeconds) || raw.expiresInSeconds <= 0) {
      errors.push('Field "expiresInSeconds" must be a positive number');
    }
  }
  if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    if (!isString(raw.expiresAt) || isNaN(Date.parse(raw.expiresAt))) {
      errors.push('Field "expiresAt" must be a valid ISO 8601 date string');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validates approval review input.
 * Strictly prevents model/agent personas from approving human-gated actions.
 * Enforces mandatory justification for rejections.
 */
export function validateReviewApprovalInput(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['ReviewApprovalInput must be an object']);
  const errors: string[] = [];

  const raw = input as Record<string, any>;

  if (raw.decision !== 'approved' && raw.decision !== 'rejected') {
    errors.push('Field "decision" must be either "approved" or "rejected"');
  }

  if (!isString(raw.actorId) || raw.actorId.trim().length === 0) {
    errors.push('Field "actorId" is required and must be a non-empty string');
  }

  if (!isString(raw.actorRole) || raw.actorRole.trim().length === 0) {
    errors.push('Field "actorRole" is required and must be a non-empty string');
  } else {
    const roleLower = raw.actorRole.trim().toLowerCase();
    // Rejection of untrusted model/agent persona attempting to review
    if (roleLower === 'agent' || roleLower === 'model' || roleLower === 'bot') {
      errors.push('Untrusted model or agent personas are forbidden from reviewing approvals (must be human role)');
    } else if (!AUTHORIZED_HUMAN_ROLES.includes(roleLower as any)) {
      errors.push(`Field "actorRole" must be an authorized human role: ${AUTHORIZED_HUMAN_ROLES.join(', ')}`);
    }
  }

  if (raw.decision === 'rejected') {
    if (!isString(raw.notes) || raw.notes.trim().length < 3) {
      errors.push('Rejection decision requires non-empty rejection notes justifying the decision (at least 3 characters)');
    }
  }

  if (raw.conditions !== undefined && raw.conditions !== null) {
    if (!isStringArray(raw.conditions)) {
      errors.push('Field "conditions" must be an array of strings');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validates complete ApprovalRecord schema ensuring all 15 required fields are present.
 */
export function validateApprovalRecord(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['ApprovalRecord must be an object']);
  const errors: string[] = [];

  const raw = input as Record<string, any>;

  if (raw.schemaVersion !== 1) {
    errors.push('Field "schemaVersion" must be 1');
  }

  const requiredStringFields = [
    'approvalId',
    'projectId',
    'runId',
    'taskId',
    'stepId',
    'actorId',
    'actorRole',
    'reason',
    'createdAt',
    'expiresAt',
    'payloadHash',
  ];

  for (const field of requiredStringFields) {
    if (!isString(raw[field]) || raw[field].trim().length === 0) {
      errors.push(`Field "${field}" is required and must be a non-empty string`);
    }
  }

  if (!isString(raw.scope) || !VALID_APPROVAL_SCOPES.includes(raw.scope as ApprovalScope)) {
    errors.push(`Field "scope" must be one of: ${VALID_APPROVAL_SCOPES.join(', ')}`);
  }

  if (!isString(raw.status) || !VALID_APPROVAL_STATUSES.includes(raw.status as ApprovalStatus)) {
    errors.push(`Field "status" must be one of: ${VALID_APPROVAL_STATUSES.join(', ')}`);
  }

  if (!isStringArray(raw.sourceHashes)) {
    errors.push('Field "sourceHashes" must be an array of strings');
  }

  if (!isStringArray(raw.artifactIds)) {
    errors.push('Field "artifactIds" must be an array of strings');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Pure evaluation of an ApprovalRecord against an execution context.
 * Fail-closed across all safety vectors.
 */
export function checkApprovalForAction(
  approval: ApprovalRecord | null | undefined,
  context: ApprovalValidationContext,
  nowMs: number = Date.now(),
): ApprovalCheckResult {
  // 0. Read-only operation check (inference, sandbox exec, status)
  if (context.operation && isReadOnlyOperation(context.operation)) {
    return {
      valid: true,
      allowed: true,
      reason: 'READ_ONLY_OPERATION_UNPROMPTED',
    };
  }

  if (!approval) {
    return {
      valid: false,
      allowed: false,
      code: 'APPROVAL_NOT_FOUND',
      reason: 'No approval record provided for gated action',
    };
  }

  // 1. Status Check
  if (approval.status === 'pending') {
    return {
      valid: false,
      allowed: false,
      code: 'APPROVAL_PENDING',
      reason: `Approval "${approval.approvalId}" is still in pending status and has not been approved`,
      approval,
      approvalId: approval.approvalId,
    };
  }
  if (approval.status === 'rejected') {
    return {
      valid: false,
      allowed: false,
      code: 'APPROVAL_REJECTED',
      reason: `Approval "${approval.approvalId}" was rejected: ${approval.reviewNotes || approval.reason}`,
      approval,
      approvalId: approval.approvalId,
    };
  }
  if (approval.status === 'expired') {
    return {
      valid: false,
      allowed: false,
      code: 'APPROVAL_EXPIRED',
      reason: `Approval "${approval.approvalId}" has expired (expiredAt: ${approval.expiresAt})`,
      approval,
      approvalId: approval.approvalId,
    };
  }
  if (approval.status !== 'approved' && approval.status !== 'conditional') {
    return {
      valid: false,
      allowed: false,
      code: 'INVALID_APPROVAL_SCHEMA',
      reason: `Approval "${approval.approvalId}" has unrecognized status: ${approval.status}`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 2. Dynamic Expiration Check
  const expiresAtMs = Date.parse(approval.expiresAt);
  if (!isNaN(expiresAtMs) && nowMs > expiresAtMs) {
    return {
      valid: false,
      allowed: false,
      code: 'APPROVAL_EXPIRED',
      reason: `Approval "${approval.approvalId}" expired at ${approval.expiresAt} (current time: ${new Date(nowMs).toISOString()})`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 3. Project Boundary Isolation Check
  if (approval.projectId !== context.projectId) {
    return {
      valid: false,
      allowed: false,
      code: 'CROSS_PROJECT_APPROVAL_USE',
      reason: `Approval "${approval.approvalId}" belongs to project "${approval.projectId}", cannot be used in project "${context.projectId}"`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 4. Run Boundary Isolation Check
  if (context.runId && approval.runId !== context.runId) {
    return {
      valid: false,
      allowed: false,
      code: 'CROSS_RUN_APPROVAL_USE',
      reason: `Approval "${approval.approvalId}" belongs to run "${approval.runId}", cannot be reused for run "${context.runId}"`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 5. Anti-Self-Approval Defense
  if (
    approval.actorId &&
    ((approval.approvedBy && approval.approvedBy.trim().toLowerCase() === approval.actorId.trim().toLowerCase()) ||
      (approval.reviewedBy && approval.reviewedBy.trim().toLowerCase() === approval.actorId.trim().toLowerCase()))
  ) {
    return {
      valid: false,
      allowed: false,
      code: 'UNTRUSTED_SELF_APPROVAL_REJECTED',
      reason: `Self-approval rejected: actor "${approval.actorId}" cannot approve their own request`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 6. Safety Finding Bypass Defense
  if (context.hasSafetyFinding && approval.scope !== 'safety_verdict') {
    return {
      valid: false,
      allowed: false,
      code: 'SAFETY_FINDING_BYPASS_REJECTED',
      reason: 'Safety finding bypass rejected: actions with safety findings require an approval with "safety_verdict" scope',
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 7. Unauthorized Overwrite Defense
  if (context.isOverwrite && approval.scope !== 'artifact_overwrite') {
    return {
      valid: false,
      allowed: false,
      code: 'UNAUTHORIZED_OVERWRITE',
      reason: 'Unauthorized overwrite: overwriting an existing artifact strictly requires an approval with "artifact_overwrite" scope',
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 8. Scope Matching Check
  const targetScope = context.scope || (context.operation as ApprovalScope);
  if (targetScope && approval.scope !== targetScope) {
    return {
      valid: false,
      allowed: false,
      code: 'SCOPE_MISMATCH',
      reason: `Approval "${approval.approvalId}" has scope "${approval.scope}", which does not match requested scope "${targetScope}"`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 9. Payload Hash Integrity Check
  if (context.payloadHash) {
    const expected = approval.payloadHash.trim().toLowerCase();
    const actual = context.payloadHash.trim().toLowerCase();
    if (expected !== actual) {
      return {
        valid: false,
        allowed: false,
        code: 'PAYLOAD_HASH_MISMATCH',
        reason: `Input payload hash "${actual}" does not match approved hash "${expected}"`,
        approval,
        approvalId: approval.approvalId,
      };
    }
  }

  // 10. Source Hashes Integrity Check
  if (context.sourceHashes && context.sourceHashes.length > 0) {
    const approvedHashes = new Set(approval.sourceHashes.map((h) => h.trim().toLowerCase()));
    for (const srcHash of context.sourceHashes) {
      if (!approvedHashes.has(srcHash.trim().toLowerCase())) {
        return {
          valid: false,
          allowed: false,
          code: 'SOURCE_HASH_MISMATCH',
          reason: `Source hash "${srcHash}" is not present in approved source hashes for approval "${approval.approvalId}"`,
          approval,
          approvalId: approval.approvalId,
        };
      }
    }
  }

  // 11. Affected Artifact ID Check
  const targetArtifact = context.targetArtifactId || context.artifactId;
  if (targetArtifact && approval.artifactIds.length > 0) {
    if (!approval.artifactIds.includes(targetArtifact)) {
      return {
        valid: false,
        allowed: false,
        code: 'ARTIFACT_MISMATCH',
        reason: `Target artifact "${targetArtifact}" is not covered by approval "${approval.approvalId}" (covers: ${approval.artifactIds.join(', ')})`,
        approval,
        approvalId: approval.approvalId,
      };
    }
  }

  // 12. Single-Use Replay Prevention Check
  if (approval.consumed && !context.allowReuse) {
    return {
      valid: false,
      allowed: false,
      code: 'OPERATION_REUSE_REJECTED',
      reason: `Approval "${approval.approvalId}" has already been consumed at ${approval.consumedAt || 'unknown time'} and cannot be reused`,
      approval,
      approvalId: approval.approvalId,
    };
  }

  // 13. Force Stop Confirmation Check
  if (approval.scope === 'force_stop' && context.forceConfirm !== true) {
    return {
      valid: false,
      allowed: false,
      code: 'FORCE_STOP_CONFIRMATION_REQUIRED',
      reason: 'Force-stop operations strictly require explicit confirmation (forceConfirm must be true)',
      approval,
      approvalId: approval.approvalId,
    };
  }

  return {
    valid: true,
    allowed: true,
    reason: 'APPROVAL_VALID',
    approval,
    approvalId: approval.approvalId,
  };
}
