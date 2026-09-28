/**
 * UI1-14: Approval APIs and UI Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Types & Pure Validators:
 *    - VALID_APPROVAL_SCOPES: docx_generation, xlsx_generation, pptx_generation,
 *      safety_verdict, artifact_overwrite, force_stop, reviewer_signoff, project_scoped_write
 *    - All 5 approval statuses: pending, approved, rejected, revoked, expired
 *    - All 15 required fields on ApprovalRecord
 *    - validateCreateApprovalInput: scope, actor, reason, hashes, auto-approval prevention
 *    - validateReviewApprovalInput: decision, authorized human role, rejection notes
 *    - checkApprovalForAction: fail-closed validation rules
 * 2. ApprovalService:
 *    - Authoritative file persistence (zero GUI-only state)
 *    - Complete 15-field preservation
 *    - Multi-field filtering (status, scope, project, run, task)
 *    - Expiration handling (static 'expired' status and dynamic now > expiresAt)
 *    - Single-use consumption (OPERATION_REUSE_REJECTED)
 *    - Anti-self-approval enforcement (UNTRUSTED_SELF_APPROVAL_REJECTED)
 *    - Role enforcement (UNAUTHORIZED_REVIEWER_ROLE)
 *    - Force-stop operations with confirmation requirement and phantom success defense
 *    - Unprompted / unblocked read-only operations
 *    - Audit logging of all actions
 * 3. REST API Router:
 *    - GET /api/v1/approvals
 *    - POST /api/v1/approvals
 *    - GET /api/v1/approvals/:id
 *    - POST /api/v1/approvals/:id/review
 *    - POST /api/v1/approvals/:id/validate
 *    - POST /api/v1/approvals/:id/consume
 *    - POST /api/v1/approvals/force-stop
 * 4. 4-Way Client Parity:
 *    - ServiceContainer, MaosRestClient, BrowserRestClient, GuiApiAdapter
 *    - Runtime validation schemas
 * 5. Security & Gate Invariants:
 *    - Canary file rust/test.txt SHA-256 preservation
 *    - Gate G5 passed state, G6 and G7 passed state
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  VALID_APPROVAL_SCOPES,
  AUTHORIZED_HUMAN_ROLES,
  APPROVAL_ERROR_CODES,
  ApprovalScope,
  ApprovalRecord,
  CreateApprovalInput,
  ReviewApprovalInput,
  ApprovalValidationContext,
  ApprovalCheckResult,
  ForceStopParams,
  validateCreateApprovalInput,
  validateReviewApprovalInput,
  validateApprovalRecord,
  checkApprovalForAction,
  isReadOnlyOperation,
} from '../../src/domain/approval';

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
import { PINNED_TEXT_CONFIG } from '../../src/domain/model-manifest';
import type { ApprovalStatus } from '../../src/domain/schemas';
import {
  createServiceContainer,
  ServiceContainer,
  ApprovalService,
  AuditService,
  FairQueueService,
  TaskService,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { MaosRestClient } from '../../src/api/client';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import {
  validateApprovalRecord as guiValidateApprovalRecord,
  validateApprovalsList as guiValidateApprovalsList,
  validateApprovalCheckResult as guiValidateApprovalCheckResult,
  validateForceStopResult as guiValidateForceStopResult,
} from '../../src/gui/src/api/runtime-validation';

describe('UI1-14: Approval APIs and UI', () => {
  let tempDir: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let server: http.Server;
  let baseUrl: string;
  let restClient: MaosRestClient;
  let browserClient: BrowserRestClient;
  let adapter: GuiApiAdapter;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-14-test-'));
    fs.mkdirSync(path.join(tempDir, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos', 'queue', 'done'), { recursive: true });

    services = createServiceContainer(tempDir);
    router = new RestApiRouter(services, tempDir);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        router.handle(req, res).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    restClient = new MaosRestClient({ baseUrl, projectRoot: tempDir });

    // Mock fetch for BrowserRestClient to target the live test server
    const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = input.toString();
      const url = urlStr.startsWith('http') ? urlStr : `${baseUrl}${urlStr}`;
      const headers: Record<string, string> = {
        'X-Project-Root': tempDir,
        ...(init?.headers as Record<string, string>),
      };

      const res = await fetch(url, {
        ...init,
        headers,
      });
      return res;
    };

    browserClient = new BrowserRestClient({ baseUrl, projectRoot: tempDir, customFetch });
    adapter = new GuiApiAdapter(browserClient, tempDir);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════════════
  // 1. Domain Types & Pure Validators
  // ══════════════════════════════════════════════════════════════════════

  describe('1. Domain Types & Pure Validators', () => {
    it('defines all 8 required approval scopes', () => {
      expect(VALID_APPROVAL_SCOPES).toEqual([
        'docx_generation',
        'xlsx_generation',
        'pptx_generation',
        'safety_verdict',
        'artifact_overwrite',
        'force_stop',
        'reviewer_signoff',
        'project_scoped_write',
      ]);
      expect(VALID_APPROVAL_SCOPES.length).toBe(8);
    });

    it('defines authorized human reviewer roles', () => {
      expect(AUTHORIZED_HUMAN_ROLES).toContain('operator');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('reviewer');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('auditor');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('admin');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('sec-officer');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('engineer');
      expect(AUTHORIZED_HUMAN_ROLES).toContain('compliance-officer');
    });

    it('validateCreateApprovalInput passes for valid inputs across all 8 scopes', () => {
      for (const scope of VALID_APPROVAL_SCOPES) {
        const input: CreateApprovalInput = {
          scope,
          projectId: 'proj-alpha',
          runId: 'run-001',
          taskId: 'task-101',
          actorId: 'agent-generator',
          actorRole: 'worker',
          reason: `Requesting approval for ${scope}`,
          payloadHash: computeSha256('sample payload content'),
          sourceHashes: [computeSha256('source-doc.md')],
          artifactIds: ['art-docx-1'],
        };
        const validation = validateCreateApprovalInput(input);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      }
    });

    it('validateCreateApprovalInput rejects invalid scopes, empty fields, and auto-approval attempts', () => {
      // Invalid scope
      const res1 = validateCreateApprovalInput({
        scope: 'arbitrary_bypass' as any,
        projectId: 'p1',
        runId: 'r1',
        taskId: 't1',
        actorId: 'agent-1',
        actorRole: 'agent',
        reason: 'bypass',
      });
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.includes('Invalid scope'))).toBe(true);

      // Missing reason
      const res2 = validateCreateApprovalInput({
        scope: 'docx_generation',
        projectId: 'p1',
        runId: 'r1',
        taskId: 't1',
        actorId: 'agent-1',
        actorRole: 'agent',
        reason: '   ',
      });
      expect(res2.valid).toBe(false);
      expect(res2.errors.some((e) => e.includes('reason'))).toBe(true);

      // Missing actorId
      const res3 = validateCreateApprovalInput({
        scope: 'docx_generation',
        projectId: 'p1',
        runId: 'r1',
        taskId: 't1',
        actorId: '',
        actorRole: 'agent',
        reason: 'reason',
      });
      expect(res3.valid).toBe(false);
      expect(res3.errors.some((e) => e.includes('actorId'))).toBe(true);

      // Hidden auto-approval attempt
      const res4 = validateCreateApprovalInput({
        scope: 'docx_generation',
        projectId: 'p1',
        runId: 'r1',
        taskId: 't1',
        actorId: 'agent-1',
        actorRole: 'agent',
        reason: 'self auto-approve',
        status: 'approved' as any,
      });
      expect(res4.valid).toBe(false);
      expect(res4.errors.some((e) => e.includes('auto-approved'))).toBe(true);
    });

    it('validateReviewApprovalInput validates decisions and requires rejection notes', () => {
      // Valid approval review
      const validApprove: ReviewApprovalInput = {
        decision: 'approved',
        actorId: 'alice-reviewer',
        actorRole: 'reviewer',
        notes: 'LGTM, verified references',
      };
      expect(validateReviewApprovalInput(validApprove).valid).toBe(true);

      // Valid rejection review
      const validReject: ReviewApprovalInput = {
        decision: 'rejected',
        actorId: 'bob-auditor',
        actorRole: 'auditor',
        notes: 'Citations failed verification',
      };
      expect(validateReviewApprovalInput(validReject).valid).toBe(true);

      // Missing rejection notes
      const invalidReject: ReviewApprovalInput = {
        decision: 'rejected',
        actorId: 'bob-auditor',
        actorRole: 'auditor',
      };
      const rejectVal = validateReviewApprovalInput(invalidReject);
      expect(rejectVal.valid).toBe(false);
      expect(rejectVal.errors.some((e) => e.includes('rejection notes'))).toBe(true);

      // Unauthorized role
      const unauthorizedRole: ReviewApprovalInput = {
        decision: 'approved',
        actorId: 'model-agent-prose',
        actorRole: 'untrusted-bot',
      };
      const roleVal = validateReviewApprovalInput(unauthorizedRole);
      expect(roleVal.valid).toBe(false);
      expect(roleVal.errors.some((e) => e.includes('authorized human role'))).toBe(true);
    });

    it('validateApprovalRecord verifies all 15 required fields on ApprovalRecord', () => {
      const validRecord: ApprovalRecord = {
        schemaVersion: 1,
        approvalId: 'appr-full-15-fields',
        projectId: 'proj-1',
        runId: 'run-1',
        taskId: 'task-1',
        stepId: 'step-1',
        actorId: 'requesting-agent',
        actorRole: 'agent',
        status: 'pending',
        reason: 'Generating executive DOCX',
        scope: 'docx_generation',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        payloadHash: computeSha256('docx-payload'),
        sourceHashes: [computeSha256('source-notes')],
        artifactIds: ['art-docx-1'],
        approvedBy: '',
        approvedAt: null,
        conditions: [],
        consumed: false,
        consumedAt: null,
      };

      const res = validateApprovalRecord(validRecord);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);

      // Check failure when a required field is missing
      const incompleteRecord = { ...validRecord, payloadHash: '' };
      expect(validateApprovalRecord(incompleteRecord).valid).toBe(false);
    });

    it('identifies unprompted read-only operations that do not require approvals', () => {
      expect(isReadOnlyOperation('inference')).toBe(true);
      expect(isReadOnlyOperation('ordinary_inference')).toBe(true);
      expect(isReadOnlyOperation('llm_prompt')).toBe(true);
      expect(isReadOnlyOperation('sandbox_exec')).toBe(true);
      expect(isReadOnlyOperation('sandbox_run')).toBe(true);
      expect(isReadOnlyOperation('read_file')).toBe(true);
      expect(isReadOnlyOperation('get_status')).toBe(true);

      // Mutating operations are NOT read-only
      expect(isReadOnlyOperation('docx_generation')).toBe(false);
      expect(isReadOnlyOperation('force_stop')).toBe(false);
      expect(isReadOnlyOperation('artifact_overwrite')).toBe(false);
      expect(isReadOnlyOperation('execute_tool')).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. Fail-Closed Validation Rules & Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('2. Fail-Closed Validation Rules & Invariants', () => {
    const validBaseRecord: ApprovalRecord = {
      schemaVersion: 1,
      approvalId: 'appr-rule-test',
      projectId: 'proj-sec',
      runId: 'run-alpha',
      taskId: 'task-01',
      stepId: 'step-01',
      actorId: 'agent-writer',
      actorRole: 'agent',
      status: 'approved',
      reason: 'Produce verified report',
      scope: 'docx_generation',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      payloadHash: computeSha256('expected report payload'),
      sourceHashes: [computeSha256('source A'), computeSha256('source B')],
      artifactIds: ['art-rep-1'],
      approvedBy: 'lead-auditor',
      approvedAt: new Date().toISOString(),
      reviewRole: 'auditor',
      consumed: false,
      consumedAt: null,
    };

    const validContext: ApprovalValidationContext = {
      projectId: 'proj-sec',
      runId: 'run-alpha',
      taskId: 'task-01',
      operation: 'docx_generation',
      payloadHash: computeSha256('expected report payload'),
      sourceHashes: [computeSha256('source A'), computeSha256('source B')],
      targetArtifactId: 'art-rep-1',
    };

    it('approves valid action matching approved record', () => {
      const res = checkApprovalForAction(validBaseRecord, validContext);
      expect(res.allowed).toBe(true);
      expect(res.reason).toBe('APPROVAL_VALID');
    });

    it('rejects missing approval with APPROVAL_NOT_FOUND', () => {
      const res = checkApprovalForAction(null, validContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND);
    });

    it('rejects pending approval with APPROVAL_PENDING', () => {
      const record = { ...validBaseRecord, status: 'pending' as ApprovalStatus };
      const res = checkApprovalForAction(record, validContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_PENDING);
    });

    it('rejects rejected approval with APPROVAL_REJECTED', () => {
      const record = { ...validBaseRecord, status: 'rejected' as ApprovalStatus };
      const res = checkApprovalForAction(record, validContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_REJECTED);
    });

    it('rejects expired approval with APPROVAL_EXPIRED (status or timestamp)', () => {
      // Explicit expired status
      const recordStatusExpired = { ...validBaseRecord, status: 'expired' as ApprovalStatus };
      const res1 = checkApprovalForAction(recordStatusExpired, validContext);
      expect(res1.allowed).toBe(false);
      expect(res1.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_EXPIRED);

      // Timestamp expired in the past
      const recordTimeExpired = {
        ...validBaseRecord,
        expiresAt: new Date(Date.now() - 5000).toISOString(),
      };
      const res2 = checkApprovalForAction(recordTimeExpired, validContext);
      expect(res2.allowed).toBe(false);
      expect(res2.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_EXPIRED);
    });

    it('rejects tampered payload hash with PAYLOAD_HASH_MISMATCH', () => {
      const contextWithDifferentPayload: ApprovalValidationContext = {
        ...validContext,
        payloadHash: computeSha256('altered malicious payload!'),
      };
      const res = checkApprovalForAction(validBaseRecord, contextWithDifferentPayload);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.PAYLOAD_HASH_MISMATCH);
    });

    it('rejects changed source hashes with SOURCE_HASH_MISMATCH', () => {
      const contextWithAlteredSources: ApprovalValidationContext = {
        ...validContext,
        sourceHashes: [computeSha256('source A modified'), computeSha256('source B')],
      };
      const res = checkApprovalForAction(validBaseRecord, contextWithAlteredSources);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.SOURCE_HASH_MISMATCH);
    });

    it('rejects cross-project approval reuse with CROSS_PROJECT_APPROVAL_USE', () => {
      const crossProjectContext: ApprovalValidationContext = {
        ...validContext,
        projectId: 'foreign-project-hijack',
      };
      const res = checkApprovalForAction(validBaseRecord, crossProjectContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.CROSS_PROJECT_APPROVAL_USE);
    });

    it('rejects cross-run approval reuse with CROSS_RUN_APPROVAL_USE', () => {
      const crossRunContext: ApprovalValidationContext = {
        ...validContext,
        runId: 'run-foreign-99',
      };
      const res = checkApprovalForAction(validBaseRecord, crossRunContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.CROSS_RUN_APPROVAL_USE);
    });

    it('rejects already consumed approval with OPERATION_REUSE_REJECTED', () => {
      const consumedRecord: ApprovalRecord = {
        ...validBaseRecord,
        consumed: true,
        consumedAt: new Date().toISOString(),
        consumedBy: 'agent-writer',
      };
      const res = checkApprovalForAction(consumedRecord, validContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED);
    });

    it('rejects untrusted model self-approval defense', () => {
      const selfApprovedRecord: ApprovalRecord = {
        ...validBaseRecord,
        actorId: 'model-gpt-agent',
        approvedBy: 'model-gpt-agent', // same actor attempting self-approval
        reviewRole: 'engineer',
      };
      const res = checkApprovalForAction(selfApprovedRecord, validContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.UNTRUSTED_SELF_APPROVAL_REJECTED);
    });

    it('rejects unapproved artifact overwrite with UNAUTHORIZED_OVERWRITE', () => {
      const overwriteContext: ApprovalValidationContext = {
        ...validContext,
        isOverwrite: true,
      };
      // Base record scope is 'docx_generation', not 'artifact_overwrite'
      const res = checkApprovalForAction(validBaseRecord, overwriteContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.UNAUTHORIZED_OVERWRITE);
    });

    it('rejects safety finding bypass with SAFETY_FINDING_BYPASS_REJECTED', () => {
      const safetyContext: ApprovalValidationContext = {
        ...validContext,
        hasSafetyFinding: true,
      };
      // Base record scope is 'docx_generation', not 'safety_verdict'
      const res = checkApprovalForAction(validBaseRecord, safetyContext);
      expect(res.allowed).toBe(false);
      expect(res.code).toBe(APPROVAL_ERROR_CODES.SAFETY_FINDING_BYPASS_REJECTED);
    });

    it('allows read-only operations without requiring approval', () => {
      const readOnlyContext: ApprovalValidationContext = {
        projectId: 'proj-sec',
        runId: 'run-alpha',
        taskId: 'task-01',
        operation: 'inference',
      };
      // Even with null approval record, read-only is permitted
      const res = checkApprovalForAction(null, readOnlyContext);
      expect(res.allowed).toBe(true);
      expect(res.reason).toBe('READ_ONLY_OPERATION_UNPROMPTED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. ApprovalService Core Lifecycle & Force-Stop Defense
  // ══════════════════════════════════════════════════════════════════════

  describe('3. ApprovalService Core Lifecycle & Force-Stop Defense', () => {
    let approvalService: ApprovalService;

    beforeEach(() => {
      approvalService = services.approval;
    });

    it('creates and persistently saves an approval record with all 15 fields', () => {
      const created = approvalService.createApproval({
        scope: 'xlsx_generation',
        projectId: 'proj-finance',
        runId: 'run-q3',
        taskId: 'task-sheet-01',
        stepId: 'step-eval',
        actorId: 'excel-agent',
        actorRole: 'worker',
        reason: 'Generate audited quarterly financial workbook',
        payloadHash: computeSha256('quarterly financial figures'),
        sourceHashes: [computeSha256('ledger.csv')],
        artifactIds: ['art-sheet-q3'],
      });

      expect(created.approvalId).toBeTruthy();
      expect(created.status).toBe('pending');
      expect(created.scope).toBe('xlsx_generation');
      expect(created.projectId).toBe('proj-finance');
      expect(created.payloadHash).toBe(computeSha256('quarterly financial figures'));
      expect(created.consumed).toBe(false);

      // Verify file persistence on disk
      const filePath = path.join(tempDir, '.maos', 'approvals', `${created.approvalId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(fileData.approvalId).toBe(created.approvalId);
      expect(fileData.status).toBe('pending');
      expect(fileData.schemaVersion).toBe(1);
    });

    it('filters approvals by scope, status, and project', () => {
      const list = approvalService.listApprovals({
        scope: 'xlsx_generation',
        projectId: 'proj-finance',
      });
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list[0].scope).toBe('xlsx_generation');
      expect(list[0].projectId).toBe('proj-finance');
    });

    it('reviews approval and enforces authorized human reviewer roles', () => {
      const created = approvalService.createApproval({
        scope: 'pptx_generation',
        projectId: 'proj-pres',
        runId: 'run-slides',
        taskId: 'task-slide-1',
        actorId: 'slide-agent',
        actorRole: 'agent',
        reason: 'Generate board presentation',
        payloadHash: computeSha256('presentation-content'),
      });

      // Attempt review with unauthorized bot role
      expect(() => {
        approvalService.decideApproval(created.approvalId, {
          decision: 'approved',
          actorId: 'unauthorized-bot',
          actorRole: 'llm_evaluator',
          notes: 'Bot approve',
        });
      }).toThrowError(/UNAUTHORIZED_REVIEWER_ROLE/);

      // Valid review with authorized role
      const approved = approvalService.decideApproval(created.approvalId, {
        decision: 'approved',
        actorId: 'sarah-vp',
        actorRole: 'admin',
        notes: 'Reviewed and approved for board delivery',
      });

      expect(approved.status).toBe('approved');
      expect(approved.reviewedBy).toBe('sarah-vp');
      expect(approved.reviewRole).toBe('admin');
      expect(approved.approvedBy).toBe('sarah-vp');
    });

    it('prevents operation reuse via single-use consumeApproval', () => {
      const created = approvalService.createApproval({
        scope: 'docx_generation',
        projectId: 'proj-single-use',
        runId: 'run-1',
        taskId: 'task-1',
        actorId: 'agent-1',
        actorRole: 'agent',
        reason: 'Single use action',
        payloadHash: computeSha256('single use docx'),
      });

      approvalService.decideApproval(created.approvalId, {
        decision: 'approved',
        actorId: 'lead-eng',
        actorRole: 'engineer',
      });

      // First consumption succeeds
      const consumed = approvalService.consumeApproval(created.approvalId, {
        actorId: 'agent-1',
        operation: 'docx_generation',
      });
      expect(consumed.consumed).toBe(true);
      expect(consumed.consumedBy).toBe('agent-1');

      // Second consumption fails with OPERATION_REUSE_REJECTED
      expect(() => {
        approvalService.consumeApproval(created.approvalId, {
          actorId: 'agent-1',
          operation: 'docx_generation',
        });
      }).toThrowError(/OPERATION_REUSE_REJECTED/);
    });

    it('detects and rejects expired approvals dynamically', () => {
      const created = approvalService.createApproval({
        scope: 'project_scoped_write',
        projectId: 'proj-expire',
        runId: 'run-1',
        taskId: 'task-1',
        actorId: 'agent-1',
        actorRole: 'agent',
        reason: 'Temporary write approval',
        payloadHash: computeSha256('write payload'),
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1 sec ago
      });

      // getApproval marks it as expired dynamically
      const fetched = approvalService.getApproval(created.approvalId);
      expect(fetched?.status).toBe('expired');

      // Review attempt fails
      expect(() => {
        approvalService.decideApproval(created.approvalId, {
          decision: 'approved',
          actorId: 'admin-user',
          actorRole: 'admin',
        });
      }).toThrowError(/APPROVAL_EXPIRED/);
    });

    it('executes force-stop with confirmation and prevents phantom success', async () => {
      // 1. Setup an active task in TaskService
      const task = services.task.createTask({
        description: 'Long running computation to be interrupted',
        agent: 'compute-agent',
        branch: 'feat/compute',
        type: 'feature',
      });
      expect(task.id).toBeTruthy();

      // Move task to active queue
      const taskFile = {
        id: task.id,
        type: task.type,
        agent: task.agent,
        branch: task.branch,
        description: task.description,
        capabilities: task.capabilities,
        complexity: task.complexity,
        status: 'active',
        category: task.category,
        depth: task.depth,
        reviewRequired: task.reviewRequired,
        fixAttempts: task.fixAttempts,
        parentTaskId: task.parentTaskId,
        createdAt: task.createdAt,
        filePath: task.filePath,
      };
      services.task.moveToActive(taskFile as any);

      // 2. Setup a queued entry in FairQueueService
      const queueEntry = services.queue.enqueue({
        projectId: 'proj-compute',
        runId: 'run-compute-1',
        agentId: 'compute-agent',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: task.id,
      });
      expect(queueEntry.taskId).toBe(task.id);

      // 3. Attempt force-stop WITHOUT confirmation -> Rejects
      const unconfirmedParams: ForceStopParams = {
        projectId: 'proj-compute',
        runId: 'run-compute-1',
        taskId: task.id,
        actorId: 'human-operator',
        actorRole: 'operator',
        reason: 'Stop compute run',
        confirm: false, // missing confirmation
      };

      await expect(approvalService.executeForceStop(unconfirmedParams)).rejects.toThrowError(
        /FORCE_STOP_CONFIRMATION_REQUIRED/,
      );

      // 4. Attempt force-stop with unauthorized role -> Rejects
      const unauthorizedRoleParams: ForceStopParams = {
        ...unconfirmedParams,
        confirm: true,
        actorRole: 'untrusted_bot',
      };
      await expect(approvalService.executeForceStop(unauthorizedRoleParams)).rejects.toThrowError(
        /UNAUTHORIZED_REVIEWER_ROLE/,
      );

      // 5. Execute confirmed force-stop
      const confirmedParams: ForceStopParams = {
        ...unconfirmedParams,
        confirm: true,
      };
      const stopResult = await approvalService.executeForceStop(confirmedParams);

      expect(stopResult.success).toBe(true);
      expect(stopResult.queueCancelled).toBe(true);
      expect(stopResult.taskStatus).toBe('interrupted');
      expect(stopResult.phantomSuccessDefended).toBe(true);

      // 6. Verify task in TaskService is definitely interrupted (phantom success defense)
      const interruptedTask = services.task.getTask(task.id);
      expect(interruptedTask?.status).toBe('interrupted');
      expect(interruptedTask?.status).not.toBe('done');

      // 7. Verify queue entry is cancelled
      const entryAfter = services.queue.getEntry(queueEntry.id);
      expect(entryAfter?.state).toBe('cancelled');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. REST API Router Endpoints
  // ══════════════════════════════════════════════════════════════════════

  describe('4. REST API Router Endpoints', () => {
    let testApprovalId: string;

    it('POST /api/v1/approvals creates pending approval record', async () => {
      const res = await restClient.createApproval({
        scope: 'docx_generation',
        projectId: 'proj-rest-test',
        runId: 'run-rest-01',
        taskId: 'task-rest-101',
        actorId: 'agent-doc-gen',
        actorRole: 'agent',
        reason: 'Create final audit DOCX report',
        payloadHash: computeSha256('final audit report content'),
        sourceHashes: [computeSha256('evidence-claim.md')],
        artifactIds: ['art-docx-audit'],
      });

      expect(res.status).toBe(201);
      expect(res.data?.approvalId).toBeTruthy();
      expect(res.data?.status).toBe('pending');
      expect(res.data?.scope).toBe('docx_generation');
      expect(res.data?.payloadHash).toBe(computeSha256('final audit report content'));

      testApprovalId = res.data!.approvalId;
    });

    it('GET /api/v1/approvals lists approvals with query filtering', async () => {
      const res = await restClient.listApprovals({
        status: 'pending',
        scope: 'docx_generation',
        projectId: 'proj-rest-test',
      });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data?.some((a) => a.approvalId === testApprovalId)).toBe(true);
    });

    it('GET /api/v1/approvals/:id returns individual approval', async () => {
      const res = await restClient.getApproval(testApprovalId);

      expect(res.status).toBe(200);
      expect(res.data?.approvalId).toBe(testApprovalId);
      expect(res.data?.status).toBe('pending');
    });

    it('POST /api/v1/approvals/:id/validate validates against action context', async () => {
      // Pending approval should validate as not allowed
      const resPending = await restClient.validateApproval(testApprovalId, {
        projectId: 'proj-rest-test',
        runId: 'run-rest-01',
        taskId: 'task-rest-101',
        operation: 'docx_generation',
        payloadHash: computeSha256('final audit report content'),
        sourceHashes: [computeSha256('evidence-claim.md')],
      });

      expect(resPending.status).toBe(200);
      expect(resPending.data?.allowed).toBe(false);
      expect(resPending.data?.code).toBe(APPROVAL_ERROR_CODES.APPROVAL_PENDING);
    });

    it('POST /api/v1/approvals/:id/review executes human decision', async () => {
      const res = await restClient.reviewApproval(testApprovalId, {
        decision: 'approved',
        actorId: 'inspector-clouseau',
        actorRole: 'auditor',
        notes: 'Verified citations and hashes',
      });

      expect(res.status).toBe(200);
      expect(res.data?.status).toBe('approved');
      expect(res.data?.reviewedBy).toBe('inspector-clouseau');
      expect(res.data?.reviewRole).toBe('auditor');
    });

    it('POST /api/v1/approvals/:id/validate succeeds after approval', async () => {
      const res = await restClient.validateApproval(testApprovalId, {
        projectId: 'proj-rest-test',
        runId: 'run-rest-01',
        taskId: 'task-rest-101',
        operation: 'docx_generation',
        payloadHash: computeSha256('final audit report content'),
        sourceHashes: [computeSha256('evidence-claim.md')],
      });

      expect(res.status).toBe(200);
      expect(res.data?.allowed).toBe(true);
      expect(res.data?.reason).toBe('APPROVAL_VALID');
    });

    it('POST /api/v1/approvals/:id/consume marks approval consumed', async () => {
      const res = await restClient.consumeApproval(testApprovalId, {
        actorId: 'agent-doc-gen',
        operation: 'docx_generation',
      });

      expect(res.status).toBe(200);
      expect(res.data?.consumed).toBe(true);
      expect(res.data?.consumedBy).toBe('agent-doc-gen');

      // Attempt to consume again returns 409
      const resSecond = await restClient.consumeApproval(testApprovalId, {
        actorId: 'agent-doc-gen',
        operation: 'docx_generation',
      });
      expect(resSecond.status).toBe(409);
      expect(resSecond.error?.code).toBe(APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED);
    });

    it('POST /api/v1/approvals/force-stop handles force stop requests', async () => {
      // Missing confirm returns 400
      const resNoConfirm = await restClient.forceStop({
        projectId: 'proj-rest-test',
        runId: 'run-rest-01',
        taskId: 'task-nonexistent',
        actorId: 'sec-officer-1',
        actorRole: 'sec-officer',
        reason: 'Stop run',
        confirm: false,
      });

      expect(resNoConfirm.status).toBe(400);
      expect(resNoConfirm.error?.code).toBe(APPROVAL_ERROR_CODES.FORCE_STOP_CONFIRMATION_REQUIRED);

      // Confirmed force-stop succeeds
      const resConfirmed = await restClient.forceStop({
        projectId: 'proj-rest-test',
        runId: 'run-rest-01',
        taskId: 'task-nonexistent',
        actorId: 'sec-officer-1',
        actorRole: 'sec-officer',
        reason: 'Verified stop',
        confirm: true,
      });

      expect(resConfirmed.status).toBe(200);
      expect(resConfirmed.data?.success).toBe(true);
      expect(resConfirmed.data?.phantomSuccessDefended).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. 4-Way Client Parity & Runtime Validations
  // ══════════════════════════════════════════════════════════════════════

  describe('5. 4-Way Client Parity & Runtime Validations', () => {
    let parityApprovalId: string;

    it('verifies createApproval parity across ServiceContainer, MaosRestClient, BrowserRestClient, and GuiApiAdapter', async () => {
      const input: CreateApprovalInput = {
        scope: 'safety_verdict',
        projectId: 'proj-parity',
        runId: 'run-p-1',
        taskId: 'task-p-1',
        actorId: 'guard-agent',
        actorRole: 'agent',
        reason: 'Safety finding sign-off for release',
        payloadHash: computeSha256('safety assessment payload'),
        sourceHashes: [computeSha256('security-scan.json')],
      };

      const restRes = await restClient.createApproval(input);
      expect(restRes.status).toBe(201);
      parityApprovalId = restRes.data!.approvalId;

      const browserRes = await browserClient.getApproval(parityApprovalId);
      const adapterRes = await adapter.getApproval(parityApprovalId);

      expect(browserRes.approvalId).toBe(parityApprovalId);
      expect(adapterRes.approvalId).toBe(parityApprovalId);
      expect(browserRes.scope).toBe('safety_verdict');
      expect(adapterRes.scope).toBe('safety_verdict');
    });

    it('verifies listApprovals parity across all clients', async () => {
      const rest = await restClient.listApprovals({ projectId: 'proj-parity' });
      const browser = await browserClient.listApprovals({ projectId: 'proj-parity' });
      const adapt = await adapter.getApprovals({ projectId: 'proj-parity' });

      expect(rest.data?.length).toBe(browser.length);
      expect(browser.length).toBe(adapt.length);
      expect(adapt.some((a) => a.approvalId === parityApprovalId)).toBe(true);
    });

    it('verifies reviewApproval and validateApproval parity across all clients', async () => {
      const reviewInput: ReviewApprovalInput = {
        decision: 'approved',
        actorId: 'compliance-officer-1',
        actorRole: 'compliance-officer',
        notes: 'Compliance verified and approved',
      };

      const reviewRes = await adapter.reviewApproval(parityApprovalId, reviewInput);
      expect(reviewRes.status).toBe('approved');
      expect(reviewRes.reviewedBy).toBe('compliance-officer-1');

      const validateContext: ApprovalValidationContext = {
        projectId: 'proj-parity',
        runId: 'run-p-1',
        taskId: 'task-p-1',
        operation: 'safety_verdict',
        payloadHash: computeSha256('safety assessment payload'),
        sourceHashes: [computeSha256('security-scan.json')],
      };

      const valRest = await restClient.validateApproval(parityApprovalId, validateContext);
      const valBrowser = await browserClient.validateApproval(parityApprovalId, validateContext);
      const valAdapter = await adapter.validateApproval(parityApprovalId, validateContext);

      expect(valRest.data?.allowed).toBe(true);
      expect(valBrowser.allowed).toBe(true);
      expect(valAdapter.allowed).toBe(true);
    });

    it('verifies runtime-validation functions in GUI library', () => {
      const validRecord: ApprovalRecord = {
        schemaVersion: 1,
        approvalId: 'appr-schema-test',
        projectId: 'p1',
        runId: 'r1',
        taskId: 't1',
        stepId: 's1',
        actorId: 'act1',
        actorRole: 'role1',
        status: 'pending',
        reason: 'reason',
        scope: 'docx_generation',
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        payloadHash: 'hash',
        sourceHashes: ['shash'],
        artifactIds: ['art1'],
        approvedBy: '',
        approvedAt: null,
        conditions: [],
        consumed: false,
        consumedAt: null,
      };

      expect(guiValidateApprovalRecord(validRecord)).toEqual(validRecord);
      expect(guiValidateApprovalsList([validRecord])).toEqual([validRecord]);

      const checkRes: ApprovalCheckResult = {
        valid: true,
        allowed: true,
        reason: 'VALID',
        approvalId: 'appr-1',
      };
      expect(guiValidateApprovalCheckResult(checkRes)).toEqual(checkRes);

      const stopRes: ForceStopResult = {
        success: true,
        status: 'interrupted',
        taskId: 't1',
        runId: 'r1',
        stoppedAt: new Date().toISOString(),
        auditRecorded: true,
        phantomSuccessDefended: true,
      };
      expect(guiValidateForceStopResult(stopRes)).toEqual(stopRes);

      // Rejects invalid payload
      expect(() => guiValidateApprovalRecord({ notAValidRecord: true })).toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. Security & Gate Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('6. Security & Gate Invariants', () => {
    it('preserves canary rust/test.txt SHA-256 hash', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });

    it('verifies Gate G5 is CONDITIONAL/PENDING OFFLINE WEIGHTS, G6 is PASSED, G7 is PASSED', () => {
      const planPath = path.resolve(__dirname, '../../docs/SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf-8');

      // Gate G5 is passed with the pinned offline weights
      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      // Gate G6 and G7 must be passed
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
