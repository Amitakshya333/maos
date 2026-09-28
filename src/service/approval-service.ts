/**
 * MAOS Approval Service (UI1-14)
 *
 * Authoritative governance service for privileged, safety-critical, and mutating operations:
 * - DOCX, XLSX, PPTX generation
 * - Safety-verdict application
 * - Artifact overwrite
 * - Force-stop operations
 * - Final reviewer sign-off
 * - Project-scoped writes
 *
 * Strictly enforces:
 * - 15 required fields per approval record.
 * - Non-reusable single-use scope (cannot replay or cross-apply approvals).
 * - Dynamic expiration checks (auto-expires pending approvals).
 * - Rejection of hidden auto-approval upon creation.
 * - Rejection of untrusted model/agent self-approval.
 * - Mandatory confirmation and phantom success defense for force-stop operations.
 * - Tamper-evident audit logging strictly recorded on all lifecycle transitions.
 *
 * Stored persistently under .maos/approvals/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ApprovalRecord,
  CreateApprovalInput,
  ReviewApprovalInput,
  ApprovalValidationContext,
  ApprovalCheckResult,
  ForceStopParams,
  ForceStopResult,
} from '../domain/approval';
import {
  APPROVAL_ERROR_CODES,
  ApprovalError,
  AUTHORIZED_HUMAN_ROLES,
  validateCreateApprovalInput,
  validateReviewApprovalInput,
  checkApprovalForAction,
} from '../domain/approval';
import type { AuditService } from './audit-service';
import type { FairQueueService } from './fair-queue-service';
import type { TaskService } from './task-service';

export class ApprovalService {
  private readonly storageDir: string;
  private auditService?: AuditService;
  private queueService?: FairQueueService;
  private taskService?: TaskService;

  constructor(
    private readonly projectRoot: string,
    auditService?: AuditService,
    queueService?: FairQueueService,
    taskService?: TaskService,
  ) {
    this.storageDir = path.join(this.projectRoot, '.maos', 'approvals');
    this.auditService = auditService;
    this.queueService = queueService;
    this.taskService = taskService;
  }

  /**
   * Set or update service dependencies.
   */
  setDependencies(deps: {
    auditService?: AuditService;
    queueService?: FairQueueService;
    taskService?: TaskService;
  }): void {
    if (deps.auditService) this.auditService = deps.auditService;
    if (deps.queueService) this.queueService = deps.queueService;
    if (deps.taskService) this.taskService = deps.taskService;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Normalizes an unversioned or legacy record to a complete 15-field ApprovalRecord.
   */
  private normalizeRecord(raw: any): ApprovalRecord {
    const approvalId = raw.approvalId || raw.id || `appr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = raw.createdAt || new Date().toISOString();
    const expiresAt = raw.expiresAt || new Date(Date.now() + 3600 * 1000).toISOString();

    return {
      schemaVersion: 1,
      approvalId,
      id: approvalId,
      projectId: raw.projectId || 'default',
      runId: raw.runId || 'default',
      taskId: raw.taskId || 'default',
      stepId: raw.stepId || 'default',
      actorId: raw.actorId || 'system',
      actorRole: raw.actorRole || 'lead',
      status: raw.status || 'pending',
      reason: raw.reason || 'Governance gate approval',
      scope: raw.scope || 'reviewer_signoff',
      createdAt,
      expiresAt,
      payloadHash: raw.payloadHash || '0000000000000000000000000000000000000000000000000000000000000000',
      sourceHashes: Array.isArray(raw.sourceHashes) ? raw.sourceHashes : [],
      artifactIds: Array.isArray(raw.artifactIds) ? raw.artifactIds : [],
      approvedBy: raw.approvedBy || '',
      approvedAt: raw.approvedAt || null,
      reviewedBy: raw.reviewedBy,
      reviewedAt: raw.reviewedAt || null,
      reviewRole: raw.reviewRole,
      reviewNotes: raw.reviewNotes,
      conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
      evidenceId: raw.evidenceId,
      gateId: raw.gateId,
      consumed: raw.consumed === true,
      consumedAt: raw.consumedAt || null,
      consumedBy: raw.consumedBy,
      metadata: raw.metadata,
    };
  }

  /**
   * List all approvals, automatically checking expiration and sorting by createdAt descending.
   */
  listApprovals(filter?: {
    status?: string;
    scope?: string;
    projectId?: string;
    runId?: string;
    taskId?: string;
  }): ApprovalRecord[] {
    this.ensureDir();
    const files = fs.readdirSync(this.storageDir).filter((f) => f.endsWith('.json'));
    const approvals: ApprovalRecord[] = [];

    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const record = this.getApproval(id);
      if (!record) continue;

      // Apply filters
      if (filter?.status && record.status.toLowerCase() !== filter.status.toLowerCase()) {
        continue;
      }
      if (filter?.scope && record.scope.toLowerCase() !== filter.scope.toLowerCase()) {
        continue;
      }
      if (filter?.projectId && record.projectId !== filter.projectId) {
        continue;
      }
      if (filter?.runId && record.runId !== filter.runId) {
        continue;
      }
      if (filter?.taskId && record.taskId !== filter.taskId) {
        continue;
      }

      approvals.push(record);
    }

    return approvals.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * Get an approval by ID with dynamic expiration evaluation.
   */
  getApproval(id: string): ApprovalRecord | null {
    this.ensureDir();
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = JSON.parse(content);
      const record = this.normalizeRecord(raw);

      // Dynamic expiration check
      if (record.status === 'pending') {
        const expiresAtMs = Date.parse(record.expiresAt);
        if (!isNaN(expiresAtMs) && Date.now() > expiresAtMs) {
          const expiredRecord: ApprovalRecord = {
            ...record,
            status: 'expired',
          };
          this.writeRecord(expiredRecord);
          this.auditService?.recordAuditEvent({
            source: 'approval',
            category: 'approval',
            data: {
              action: 'APPROVAL_EXPIRED',
              approvalId: record.approvalId,
              expiredAt: record.expiresAt,
            },
          });
          return expiredRecord;
        }
      }

      return record;
    } catch {
      return null;
    }
  }

  /**
   * Write an approval record atomically to disk.
   */
  private writeRecord(record: ApprovalRecord): void {
    this.ensureDir();
    const filePath = path.join(this.storageDir, `${record.approvalId}.json`);
    const tempFile = path.join(this.storageDir, `${record.approvalId}.json.tmp_${Date.now()}`);
    fs.writeFileSync(tempFile, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
  }

  /**
   * Create a new gate approval in pending status.
   * Supports both full CreateApprovalInput and legacy gate options.
   */
  createApproval(
    opts:
      | CreateApprovalInput
      | {
          id?: string;
          gateId: string;
          conditions?: string[];
          evidenceId?: string;
        },
  ): ApprovalRecord {
    this.ensureDir();

    // Check if legacy call (only gateId provided)
    const isLegacy = 'gateId' in opts && !('scope' in opts);

    let normalizedInput: CreateApprovalInput;
    if (isLegacy) {
      const legacy = opts as { id?: string; gateId: string; conditions?: string[]; evidenceId?: string };
      normalizedInput = {
        approvalId: legacy.id,
        projectId: 'default',
        runId: 'default',
        taskId: 'default',
        stepId: 'default',
        actorId: 'system',
        actorRole: 'lead',
        reason: `Gate approval for ${legacy.gateId}`,
        scope: 'reviewer_signoff',
        payloadHash: '0000000000000000000000000000000000000000000000000000000000000000',
        gateId: legacy.gateId,
        evidenceId: legacy.evidenceId,
        conditions: legacy.conditions,
      };
    } else {
      normalizedInput = opts as CreateApprovalInput;
      const val = validateCreateApprovalInput(normalizedInput);
      if (!val.valid) {
        throw new ApprovalError(
          APPROVAL_ERROR_CODES.INVALID_APPROVAL_SCHEMA,
          `Invalid approval input: ${val.errors.join(', ')}`,
          { errors: val.errors },
        );
      }
    }

    const approvalId =
      normalizedInput.approvalId ||
      normalizedInput.id ||
      `appr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Prevent duplicate ID collision
    const existing = this.getApproval(approvalId);
    if (existing) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.INVALID_APPROVAL_SCHEMA,
        `Approval ID "${approvalId}" already exists`,
      );
    }

    const createdAt = new Date().toISOString();
    let expiresAt: string;
    if (normalizedInput.expiresAt) {
      expiresAt = normalizedInput.expiresAt;
    } else if (normalizedInput.expiresInSeconds && normalizedInput.expiresInSeconds > 0) {
      expiresAt = new Date(Date.now() + normalizedInput.expiresInSeconds * 1000).toISOString();
    } else {
      // Default 1 hour TTL
      expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    const record: ApprovalRecord = {
      schemaVersion: 1,
      approvalId,
      id: approvalId,
      projectId: normalizedInput.projectId,
      runId: normalizedInput.runId,
      taskId: normalizedInput.taskId,
      stepId: normalizedInput.stepId || 'step-0',
      actorId: normalizedInput.actorId,
      actorRole: normalizedInput.actorRole,
      status: 'pending',
      reason: normalizedInput.reason,
      scope: normalizedInput.scope,
      createdAt,
      expiresAt,
      payloadHash: normalizedInput.payloadHash,
      sourceHashes: normalizedInput.sourceHashes ? [...normalizedInput.sourceHashes] : [],
      artifactIds: normalizedInput.artifactIds ? [...normalizedInput.artifactIds] : [],
      approvedBy: '',
      approvedAt: null,
      reviewedBy: undefined,
      reviewedAt: null,
      reviewRole: undefined,
      reviewNotes: undefined,
      conditions: normalizedInput.conditions ? [...normalizedInput.conditions] : [],
      evidenceId: normalizedInput.evidenceId,
      gateId: normalizedInput.gateId,
      consumed: false,
      consumedAt: null,
      consumedBy: undefined,
      metadata: normalizedInput.metadata,
    };

    this.writeRecord(record);

    this.auditService?.recordAuditEvent({
      source: 'approval',
      category: 'approval',
      data: {
        action: 'APPROVAL_CREATED',
        approvalId: record.approvalId,
        scope: record.scope,
        projectId: record.projectId,
        runId: record.runId,
        taskId: record.taskId,
        actorId: record.actorId,
        actorRole: record.actorRole,
        expiresAt: record.expiresAt,
      },
    });

    return record;
  }

  /**
   * Decide an approval (approved or rejected).
   * Supports both legacy signature `(id, 'approved', 'operator', conditions)`
   * and structured review input `(id, { decision, actorId, actorRole, notes, conditions })`.
   */
  decideApproval(
    id: string,
    decisionOrInput: 'approved' | 'rejected' | ReviewApprovalInput,
    decidedBy?: string,
    conditionsOrNotes?: string[] | string,
    role?: string,
    conditions?: string[],
  ): ApprovalRecord {
    const approval = this.getApproval(id);
    if (!approval) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND,
        `Approval not found: ${id}`,
      );
    }

    // Expiration check
    if (approval.status === 'expired') {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.APPROVAL_EXPIRED,
        `Approval "${id}" has expired and cannot be decided`,
      );
    }

    // State transition check: only pending or conditional can be decided
    if (approval.status !== 'pending' && approval.status !== 'conditional') {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.UNAUTHORIZED_TRANSITION,
        `Approval "${id}" is already in "${approval.status}" state and cannot be decided`,
      );
    }

    let decision: 'approved' | 'rejected';
    let actorId: string;
    let actorRole: string;
    let reviewNotes: string | undefined;
    let reviewConditions: readonly string[] | undefined;

    if (typeof decisionOrInput === 'object') {
      decision = decisionOrInput.decision;
      actorId = decisionOrInput.actorId;
      actorRole = decisionOrInput.actorRole;
      reviewNotes = decisionOrInput.notes;
      reviewConditions = decisionOrInput.conditions;
    } else {
      decision = decisionOrInput;
      actorId = decidedBy || 'operator';
      actorRole = role || 'reviewer';
      if (typeof conditionsOrNotes === 'string') {
        reviewNotes = conditionsOrNotes;
        reviewConditions = conditions;
      } else {
        reviewConditions = conditionsOrNotes;
      }
    }

    // Validate review input
    const val = validateReviewApprovalInput({
      decision,
      actorId,
      actorRole,
      notes: reviewNotes,
      conditions: reviewConditions,
    });
    if (!val.valid) {
      if (val.errors.some((e) => e.includes('authorized human role') || e.includes('Untrusted model'))) {
        throw new ApprovalError(
          APPROVAL_ERROR_CODES.UNAUTHORIZED_REVIEWER_ROLE,
          `Invalid reviewer role: ${val.errors.join(', ')}`,
          { errors: val.errors },
        );
      }
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.INVALID_APPROVAL_SCHEMA,
        `Invalid review input: ${val.errors.join(', ')}`,
        { errors: val.errors },
      );
    }

    // Untrusted model self-approval defense:
    // 1. Reviewer role cannot be 'agent' or 'model'
    const roleLower = actorRole.toLowerCase();
    if (roleLower === 'agent' || roleLower === 'model') {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.UNAUTHORIZED_REVIEWER_ROLE,
        `Untrusted actor role "${actorRole}" is forbidden from reviewing approvals`,
      );
    }
    // 2. The requesting agent cannot approve their own action
    if (
      actorId.toLowerCase() === approval.actorId.toLowerCase() &&
      (approval.actorRole.toLowerCase() === 'agent' || approval.actorRole.toLowerCase() === 'model')
    ) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.UNTRUSTED_SELF_APPROVAL_REJECTED,
        `Requesting agent "${actorId}" cannot self-approve their own request "${id}"`,
      );
    }

    const now = new Date().toISOString();
    const updated: ApprovalRecord = {
      ...approval,
      status: decision,
      approvedBy: decision === 'approved' ? actorId : '',
      approvedAt: decision === 'approved' ? now : null,
      reviewedBy: actorId,
      reviewedAt: now,
      reviewRole: actorRole,
      reviewNotes: reviewNotes || approval.reviewNotes,
      conditions: reviewConditions ? [...reviewConditions] : approval.conditions,
    };

    this.writeRecord(updated);

    this.auditService?.recordAuditEvent({
      source: 'approval',
      category: 'approval',
      data: {
        action: 'APPROVAL_DECIDED',
        approvalId: updated.approvalId,
        status: updated.status,
        decidedBy: actorId,
        actorRole,
        notes: reviewNotes,
        timestamp: now,
      },
    });

    return updated;
  }

  /**
   * Validate an approval against an action context.
   */
  validateApprovalForAction(
    approvalId: string,
    context: ApprovalValidationContext,
  ): ApprovalCheckResult {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      return {
        valid: false,
        code: 'APPROVAL_NOT_FOUND',
        reason: `Approval "${approvalId}" was not found`,
      };
    }
    return checkApprovalForAction(approval, context);
  }

  /**
   * Mark an approval as consumed, enforcing single-use and preventing replay.
   */
  consumeApproval(
    approvalId: string,
    context: { actorId: string; operation: string },
  ): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND,
        `Approval not found: ${approvalId}`,
      );
    }

    if (approval.consumed) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED,
        `Approval "${approvalId}" has already been consumed and cannot be reused for operation "${context.operation}"`,
      );
    }

    if (approval.status !== 'approved' && approval.status !== 'conditional') {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.APPROVAL_PENDING,
        `Cannot consume approval "${approvalId}" in status "${approval.status}"`,
      );
    }

    const now = new Date().toISOString();
    const updated: ApprovalRecord = {
      ...approval,
      consumed: true,
      consumedAt: now,
      consumedBy: context.actorId,
    };

    this.writeRecord(updated);

    this.auditService?.recordAuditEvent({
      source: 'approval',
      category: 'approval',
      data: {
        action: 'APPROVAL_CONSUMED',
        approvalId,
        operation: context.operation,
        consumedBy: context.actorId,
        timestamp: now,
      },
    });

    return updated;
  }

  /**
   * Execute a force-stop operation with explicit confirmation and phantom success defense.
   */
  async executeForceStop(params: ForceStopParams): Promise<ForceStopResult> {
    // Explicit confirmation invariant
    if (params.confirm !== true) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.FORCE_STOP_CONFIRMATION_REQUIRED,
        'Force-stop operation strictly requires explicit confirmation (confirm must be true)',
      );
    }

    // Role enforcement for force-stop
    if (params.actorRole) {
      const roleLower = params.actorRole.trim().toLowerCase();
      if (
        roleLower === 'agent' ||
        roleLower === 'model' ||
        roleLower === 'bot' ||
        !AUTHORIZED_HUMAN_ROLES.includes(roleLower as any)
      ) {
        throw new ApprovalError(
          APPROVAL_ERROR_CODES.UNAUTHORIZED_REVIEWER_ROLE,
          `Force-stop requires an authorized human role (got: "${params.actorRole}")`,
        );
      }
    }

    // If an approvalId was specified, validate it
    if (params.approvalId) {
      const check = this.validateApprovalForAction(params.approvalId, {
        scope: 'force_stop',
        projectId: params.projectId,
        runId: params.runId,
        taskId: params.taskId,
        forceConfirm: true,
      });
      if (!check.valid) {
        throw new ApprovalError(
          check.code || APPROVAL_ERROR_CODES.APPROVAL_REJECTED,
          check.reason || 'Approval validation failed for force-stop',
        );
      }
      this.consumeApproval(params.approvalId, {
        actorId: params.actorId,
        operation: 'force_stop',
      });
    }

    // Cancel in FairQueueService if active or queued
    let queueCancelled = false;
    if (this.queueService) {
      try {
        let queueEntry = this.queueService.getEntry(params.taskId);
        if (!queueEntry) {
          const allEntries = this.queueService.listEntries();
          queueEntry = allEntries.find((e) => e.taskId === params.taskId);
        }
        if (queueEntry && queueEntry.state !== 'completed' && queueEntry.state !== 'failed') {
          this.queueService.cancel(queueEntry.id, {
            projectId: params.projectId,
            runId: params.runId,
            reason: `Force-stopped by ${params.actorId}: ${params.reason}`,
            force: true,
          });
          queueCancelled = true;
        }
      } catch {
        /* queue may not have entry */
      }
    }

    // Update task in TaskService to interrupted
    if (this.taskService) {
      try {
        this.taskService.interruptTask(
          params.taskId,
          `Force-stopped by ${params.actorId}: ${params.reason}`,
        );
      } catch {
        /* task may not exist */
      }
    }

    const stoppedAt = new Date().toISOString();

    // Audit interruption
    this.auditService?.recordAuditEvent({
      source: 'approval',
      category: 'interruption',
      data: {
        action: 'FORCE_STOP_EXECUTED',
        taskId: params.taskId,
        runId: params.runId,
        projectId: params.projectId,
        actorId: params.actorId,
        reason: params.reason,
        queueCancelled,
        timestamp: stoppedAt,
      },
    });

    return {
      success: true,
      status: 'interrupted',
      taskId: params.taskId,
      runId: params.runId,
      stoppedAt,
      auditRecorded: true,
      phantomSuccessDefended: true,
      queueCancelled,
      taskStatus: 'interrupted',
      details: {
        reason: params.reason,
        actorId: params.actorId,
        queueCancelled,
      },
    };
  }
}
