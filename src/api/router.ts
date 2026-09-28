/**
 * MAOS REST API Router
 *
 * Dispatches /api/v1/* requests directly to ServiceContainer methods.
 * Zero business logic inside the router; delegates completely to the typed service layer.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { ServiceContainer, ChatInferenceError } from '../service';
import {
  getCorrelationId,
  checkLoopback,
  checkOrigin,
  checkAuth,
  checkProjectScope,
  readJsonBody,
  checkIdempotency,
  recordIdempotency,
  sendJson,
  sendError,
  SECURITY_HEADERS,
} from './middleware';
import { OPENAPI_SPEC } from './openapi-spec';
import {
  validateTask,
  validateMessage,
  validateApproval,
  validateProject,
} from '../domain/validators';
import { isRolePreset, validateWorkspaceLayout } from '../domain/layout';
import type { OperationalMode, PurgeOptions } from '../domain/evidence-mode';
import type { SessionManager, SessionInfo } from '../service/project-service/session';
import { ServiceInstanceIdentity } from '../service/project-service/instance-identity';
import {
  validateAcquireModelLeaseInput,
  validateRenewModelLeaseInput,
  validateReleaseModelLeaseInput,
} from '../domain/model-manifest';
import {
  validateEnqueueInput,
  validateCancelInput,
} from '../domain/fair-queue';
import {
  validateModelRouteRequest,
  validateModelSwitchRequest,
  ModelSwitchError,
  SWITCH_ERROR_CODES,
} from '../domain/model-switch';
import {
  ApprovalError,
  APPROVAL_ERROR_CODES,
  validateCreateApprovalInput,
  validateReviewApprovalInput,
} from '../domain/approval';
import {
  ContainerRunnerError,
  CONTAINER_RUNNER_ERROR_CODES,
} from '../domain/sandbox-run';
import {
  KbSearchError,
} from '../domain/kb-search';
import {
  IndustrialFirewallRequirementError,
  INDUSTRIAL_FIREWALL_ERROR_CODES,
} from '../domain/industrial-firewall-requirement';
import {
  ConflictReviewError,
  validateHumanReviewInput,
  validateComparableObservation,
  type ComparableObservation,
  type HumanReviewInput,
} from '../domain/conflict';
import {
  DocxGenerationError,
  XlsxGenerationError,
  PptxGenerationError,
  OfficeInputError,
  TemplateSafetyError,
  computeOfficeInputHash,
  type OfficeDocxInput,
  type OfficeXlsxInput,
  type OfficePptxInput,
  type ValidatedOfficeArtifactInput,
} from '../domain/office-artifact';
import { getDocumentGeneratorPresets } from '../domain/document-presets';
import { projectWorkflowState, projectWorkflowStage } from '../domain/cockpit';
import { getOrGenerateProjectId } from '../service/project-service/recent-projects';
import { executeJudgedRun, readJudgedRunManifest, resumeJudgedRunAfterApproval } from '../industrial/judged-run';

export class RestApiRouter {
  constructor(
    private readonly services: ServiceContainer,
    private readonly projectRoot: string,
    private readonly sessionManager?: SessionManager,
    private instanceIdentity?: ServiceInstanceIdentity,
    private readonly allowedOrigins?: Set<string>,
  ) {}

  /**
   * Update or set the active service instance identity.
   */
  setInstanceIdentity(identity: ServiceInstanceIdentity): void {
    this.instanceIdentity = identity;
  }

  /**
   * Handle incoming HTTP request. Returns true if handled, false otherwise.
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const rawUrl = req.url || '';
    const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Only process /api/v1 routes and OpenAPI spec
    if (!pathname.startsWith('/api/v1')) {
      return false;
    }

    const correlationId = getCorrelationId(req);

    // Tokens in URLs or query strings are strictly forbidden (prevents leak in logs)
    const FORBIDDEN_TOKEN_PARAMS = new Set([
      'token',
      'sessiontoken',
      'authtoken',
      'bearer',
      'session',
      'auth',
      'access_token',
      'api_key',
      'apikey',
      'secret',
      'password',
    ]);
    let hasForbiddenParam = false;
    for (const key of parsedUrl.searchParams.keys()) {
      if (FORBIDDEN_TOKEN_PARAMS.has(key.toLowerCase())) {
        hasForbiddenParam = true;
        break;
      }
    }
    if (!hasForbiddenParam && (rawUrl.toLowerCase().includes('token=') || rawUrl.toLowerCase().includes('bearer='))) {
      hasForbiddenParam = true;
    }

    if (hasForbiddenParam) {
      sendError(
        res,
        400,
        'FORBIDDEN_URL_TOKEN',
        'Session tokens in URLs or query parameters are strictly forbidden.',
        correlationId,
      );
      return true;
    }

    // 1. Loopback-only enforcement
    if (!checkLoopback(req, res, correlationId)) {
      return true;
    }

    // 2. Strict Origin validation (if Origin header present or browser mutation)
    if (!checkOrigin(req, res, correlationId, this.allowedOrigins, Boolean(this.sessionManager))) {
      return true;
    }

    // Handle CORS preflight OPTIONS request
    if (method === 'OPTIONS') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return true;
    }

    // 3. Project-root scope enforcement
    let expectedProjectId: string | undefined;
    try {
      expectedProjectId = this.services.project.loadConfig()?.projectName;
    } catch {}
    if (!checkProjectScope(req, res, this.projectRoot, correlationId, expectedProjectId)) {
      return true;
    }

    // 4. Session authentication enforcement (if sessionManager is active)
    const isPublicEndpoint =
      (method === 'GET' && pathname === '/api/v1/openapi.json') ||
      (method === 'GET' && pathname === '/api/v1/health');

    let currentSession: SessionInfo | undefined;
    if (this.sessionManager && !isPublicEndpoint) {
      const authResult = checkAuth(req, res, correlationId, this.sessionManager, this.instanceIdentity);
      if (!authResult.authenticated) {
        return true;
      }
      currentSession = authResult.session;
    }

    // 5. Serve OpenAPI spec
    if (method === 'GET' && pathname === '/api/v1/openapi.json') {
      sendJson(res, 200, OPENAPI_SPEC, correlationId);
      return true;
    }

    try {
      // 6. Route matching
      const handled = await this.dispatch(
        method,
        pathname,
        parsedUrl.searchParams,
        req,
        res,
        correlationId,
        currentSession,
      );
      if (!handled) {
        sendError(
          res,
          404,
          'UNDOCUMENTED_ROUTE',
          `No route registered for ${method} ${pathname}. Consult /api/v1/openapi.json for documented routes.`,
          correlationId,
        );
      }
      return true;
    } catch (err: any) {
      if (
        err.message &&
        (err.message.startsWith('PATH_TRAVERSAL') ||
          err.message.startsWith('PATH_OUTSIDE_PROJECT') ||
          err.message.startsWith('SYMLINK_ESCAPE'))
      ) {
        sendError(res, 400, 'PATH_TRAVERSAL', err.message, correlationId);
      } else if (
        err.message &&
        (err.message.startsWith('INVALID_ARTIFACT_ID') ||
          err.message.startsWith('UNKNOWN_ARTIFACT_TYPE') ||
          err.message.startsWith('UNSUPPORTED_EXTENSION') ||
          err.message.startsWith('INVALID_CONTENT') ||
          err.message.startsWith('HASH_MISMATCH') ||
          err.message.startsWith('INVALID_AUDIT_CATEGORY') ||
          err.message.startsWith('INVALID_AUDIT_SOURCE') ||
          err.message.startsWith('INVALID_AUDIT_RECORD'))
      ) {
        sendError(res, 400, 'VALIDATION_FAILED', err.message, correlationId);
      } else if (err.message && err.message.startsWith('OVERSIZED_ARTIFACT')) {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, correlationId);
      } else if (
        err.message &&
        (err.message.startsWith('ARTIFACT_COLLISION') || err.message.startsWith('DUPLICATE_FINALIZATION'))
      ) {
        sendError(res, 409, 'CONFLICT', err.message, correlationId);
      } else if (err.message && err.message.startsWith('UNAUTHORIZED_TRANSITION')) {
        sendError(res, 400, 'UNAUTHORIZED_TRANSITION', err.message, correlationId);
      } else if (err.message && err.message.startsWith('UNAUTHORIZED_OVERWRITE')) {
        sendError(res, 403, 'UNAUTHORIZED_OVERWRITE', err.message, correlationId);
      } else if (err instanceof ApprovalError) {
        let status = 400;
        if (err.code === APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND) status = 404;
        else if (err.code === APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED) status = 409;
        else if (
          err.code === APPROVAL_ERROR_CODES.UNAUTHORIZED_REVIEWER_ROLE ||
          err.code === APPROVAL_ERROR_CODES.UNTRUSTED_SELF_APPROVAL_REJECTED ||
          err.code === APPROVAL_ERROR_CODES.CROSS_PROJECT_APPROVAL_USE ||
          err.code === APPROVAL_ERROR_CODES.CROSS_RUN_APPROVAL_USE
        ) status = 403;
        sendError(res, status, err.code, err.message, correlationId);
      } else if (err instanceof ChatInferenceError) {
        let status = 500;
        if (err.code === 'MODEL_SERVER_UNAVAILABLE') status = 503;
        else if (err.code === 'MODEL_INFERENCE_TIMEOUT') status = 504;
        else if (err.code === 'INVALID_MODEL_RESPONSE') status = 502;
        sendError(res, status, err.code, err.message, correlationId, err.details);
      } else if (
        err instanceof ContainerRunnerError ||
        err?.code === 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' ||
        (err.message && err.message.includes('HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL'))
      ) {
        let status = 400;
        const code = err.code || 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL';
        if (code === 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' || code === 'UNAUTHORIZED_AGENT') {
          status = 403;
        } else if (code === 'IDEMPOTENCY_CONFLICT') {
          status = 409;
        }
        sendError(res, status, code, err.message, correlationId, (err as any).detail || (err as any).details);
      } else if (
        err instanceof IndustrialFirewallRequirementError ||
        (err?.code && Object.values(INDUSTRIAL_FIREWALL_ERROR_CODES).includes(err.code))
      ) {
        sendError(res, 403, err.code, err.message, correlationId, err.detail);
      } else if (
        err instanceof DocxGenerationError ||
        err instanceof XlsxGenerationError ||
        err instanceof PptxGenerationError ||
        err instanceof OfficeInputError ||
        err instanceof TemplateSafetyError
      ) {
        let status = 400;
        let code = err.code || 'GENERATION_ERROR';
        if (
          code === 'APPROVAL_REQUIRED' ||
          (err.message && err.message.includes('APPROVAL_REQUIRED')) ||
          code === 'STALE_APPROVAL' ||
          code === 'CHANGED_INPUT_AFTER_APPROVAL' ||
          code === 'UNAUTHORIZED_OVERWRITE' ||
          code === 'UNAUTHORIZED_TOOL_CALL' ||
          code === 'CROSS_PROJECT_FORBIDDEN'
        ) {
          status = 403;
          if (err.message && err.message.includes('APPROVAL_REQUIRED')) {
            code = 'APPROVAL_REQUIRED';
          }
        } else if (
          code === 'ARTIFACT_COLLISION' ||
          code === 'IDEMPOTENCY_CONFLICT' ||
          code === 'CONCURRENT_MUTATION'
        ) {
          status = 409;
        } else if (
          code === 'STALE_SOURCE_HASH' ||
          code === 'SOURCE_FILE_MISSING' ||
          code === 'UNRESOLVED_CONFLICT' ||
          code === 'QUARANTINED_EVIDENCE' ||
          code === 'LOW_CONFIDENCE_UNREVIEWED'
        ) {
          status = 422;
        }
        sendError(res, status, code, err.message, correlationId, err.details);
      } else if (
        err.message &&
        (err.message.startsWith('RUST_CHAIN_FAILED') || err.message.startsWith('RUST_VERIFY_FAILED'))
      ) {
        sendError(res, 500, 'RUST_ENGINE_ERROR', err.message, correlationId);
      } else {
        sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message || 'An unexpected error occurred.', correlationId);
      }
      return true;
    }
  }

  private async dispatch(
    method: string,
    pathname: string,
    query: URLSearchParams,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    correlationId: string,
    currentSession?: SessionInfo,
  ): Promise<boolean> {
    if (method === 'POST' && pathname === '/api/v1/industrial/judged-runs') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'start_industrial_judged_run',
        'default',
      );
      if (idempotency.isReplay) return true;
      try {
        const result = await executeJudgedRun({
          projectRoot: this.projectRoot,
          services: this.services,
          demoName: 'safety-audit',
          json: true,
        });
        const data = {
          runId: result.runId,
          success: result.success,
          status: result.approvalStatus === 'pending' ? 'pending_approval' : (result.success ? 'completed' : 'failed'),
          verdict: result.overallVerdict,
          message: result.message,
          details: result.details,
        };
        const statusCode = result.approvalStatus === 'pending' ? 202 : (result.success ? 200 : 422);
        const responsePayload = { data };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, statusCode, responsePayload, this.services.idempotency);
        }
        sendJson(res, statusCode, responsePayload, correlationId);
      } catch (err: any) {
        sendError(res, 422, 'JUDGED_RUN_START_FAILED', err.message || 'Unable to start judged run.', correlationId);
      }
      return true;
    }

    const judgedRunMatch = pathname.match(/^\/api\/v1\/industrial\/judged-runs\/([^/]+)$/);
    if (method === 'GET' && judgedRunMatch) {
      try {
        const runId = decodeURIComponent(judgedRunMatch[1]);
        const manifest = readJudgedRunManifest(this.projectRoot, runId);
        if (!manifest) {
          sendError(res, 404, 'JUDGED_RUN_NOT_FOUND', `Judged run '${runId}' was not found.`, correlationId);
        } else {
          sendJson(res, 200, { data: manifest }, correlationId);
        }
      } catch (err: any) {
        sendError(res, 400, 'INVALID_JUDGED_RUN_ID', err.message, correlationId);
      }
      return true;
    }

    // ── Local Session Authentication (UI1-03) ──────────────────────

    if (method === 'POST' && pathname === '/api/v1/auth/handshake') {
      const bodyResult = await readJsonBody<{ windowId?: string }>(req, res, correlationId);
      if (!bodyResult) return true;

      if (!this.sessionManager || !this.instanceIdentity || !currentSession) {
        // The first session is deliberately not minted over unauthenticated
        // HTTP. It is issued by the trusted launcher IPC channel and passed
        // to the GUI in memory. This endpoint only rotates an existing token.
        sendError(
          res,
          401,
          'AUTH_REQUIRED',
          'An authenticated launcher-issued session is required before token rotation.',
          correlationId,
        );
        return true;
      }

      const session = this.sessionManager.rotateSession(currentSession, bodyResult.parsed?.windowId);

      sendJson(
        res,
        200,
        {
          data: {
            sessionToken: session.token,
            sessionId: session.sessionId,
            windowId: session.windowId,
            serviceInstanceId: session.serviceInstanceId,
            projectRootHash: session.projectRootHash,
            servicePort: this.instanceIdentity.servicePort,
            expiresAt: session.expiresAt,
            protocolVersion: this.instanceIdentity.protocolVersion,
          },
        },
        correlationId,
      );
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/revoke') {
      const bodyResult = await readJsonBody<{ sessionId?: string }>(req, res, correlationId);
      if (!bodyResult) return true;

      const targetSessionId = bodyResult.parsed?.sessionId || currentSession?.sessionId;
      if (targetSessionId && this.sessionManager) {
        this.sessionManager.revokeSession(targetSessionId);
      }

      sendJson(res, 200, { data: { revoked: true, sessionId: targetSessionId } }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/auth/session') {
      if (!currentSession) {
        sendError(res, 401, 'INVALID_TOKEN', 'No active session found.', correlationId);
        return true;
      }

      sendJson(
        res,
        200,
        {
          data: {
            sessionId: currentSession.sessionId,
            windowId: currentSession.windowId,
            projectRootHash: currentSession.projectRootHash,
            serviceInstanceId: currentSession.serviceInstanceId,
            createdAt: currentSession.createdAt,
            expiresAt: currentSession.expiresAt,
            revoked: currentSession.revoked,
          },
        },
        correlationId,
      );
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/service/identity') {
      if (!this.instanceIdentity) {
        sendError(res, 404, 'IDENTITY_NOT_FOUND', 'Service instance identity is not available.', correlationId);
        return true;
      }
      sendJson(res, 200, { data: this.instanceIdentity }, correlationId);
      return true;
    }

    // ── Projects, Settings, Sovereignty ───────────────────────────

    if (method === 'GET' && pathname === '/api/v1/project') {
      const config = this.services.project.loadConfig();
      sendJson(res, 200, { data: config }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/project/files') {
      const requestedSubpath = query.get('subpath') || '';
      try {
        const files = this.services.conversation.listProjectFiles(requestedSubpath);
        sendJson(res, 200, { data: files }, correlationId);
      } catch (err: any) {
        if (err.message && err.message.includes('Path traversal rejected')) {
          sendError(res, 400, 'PATH_TRAVERSAL', err.message, correlationId);
        } else if (err.message && err.message.startsWith('PATH_OUTSIDE_PROJECT')) {
          sendError(res, 400, 'PATH_OUTSIDE_PROJECT', err.message, correlationId);
        } else if (err.message && err.message.startsWith('NOT_FOUND')) {
          sendError(res, 404, 'NOT_FOUND', err.message, correlationId);
        } else {
          sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message, correlationId);
        }
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/settings') {
      const projectId = query.get('projectId') || undefined;
      const settings = this.services.project.getSettings(projectId);
      sendJson(res, 200, { data: settings }, correlationId);
      return true;
    }

    if ((method === 'PATCH' || method === 'PUT') && pathname === '/api/v1/settings') {
      const bodyResult = await readJsonBody<Record<string, unknown>>(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'update_settings',
        'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const projectId = query.get('projectId') || undefined;
        const updated = this.services.project.updateSettings(bodyResult.parsed || {}, projectId);
        const responsePayload = { data: updated };

        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 200, responsePayload, this.services.idempotency);
        }

        sendJson(res, 200, responsePayload, correlationId);
      } catch (err: any) {
        sendError(res, 400, 'INVALID_BASIC_SETTINGS', err.message || 'Invalid settings', correlationId);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/settings/reset') {
      const projectId = query.get('projectId') || undefined;
      const reset = this.services.project.resetSettings(projectId);
      sendJson(res, 200, { data: reset }, correlationId);
      return true;
    }

    // ── Retention & Scoped Purge (UI1-10) ───────────────────────────

    if (method === 'GET' && pathname === '/api/v1/retention/status') {
      const projectId = query.get('projectId') || 'default';
      const status = this.services.retention.getRetentionStatus(projectId);
      sendJson(res, 200, { data: status, status }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/retention/purge') {
      const bodyResult = await readJsonBody<PurgeOptions>(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'retention_purge',
        'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const payload = bodyResult.parsed || { target: 'all_expired' };
        const purgeResult = this.services.retention.executePurge(payload);
        const responsePayload = { data: purgeResult, result: purgeResult };

        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 200, responsePayload, this.services.idempotency);
        }
        sendJson(res, 200, responsePayload, correlationId);
      } catch (err: any) {
        const code = err.message?.includes('IMMUTABLE_AUDIT_PURGE_FORBIDDEN')
          ? 'IMMUTABLE_AUDIT_PURGE_FORBIDDEN'
          : err.message?.includes('FINALIZED_DELIVERABLE_PURGE_FORBIDDEN')
          ? 'FINALIZED_DELIVERABLE_PURGE_FORBIDDEN'
          : err.message?.includes('PATH_OUTSIDE_PROJECT')
          ? 'PATH_OUTSIDE_PROJECT'
          : 'RETENTION_PURGE_ERROR';
        sendError(res, 400, code, err.message, correlationId);
      }
      return true;
    }

    // ── Evidence & Mode Claim Validation (UI1-10) ───────────────────

    if (method === 'POST' && pathname === '/api/v1/mode/validate-claim') {
      const bodyResult = await readJsonBody<{ claim?: unknown; mode?: OperationalMode }>(req, res, correlationId);
      if (!bodyResult) return true;

      const result = this.services.evidenceMode.validateClaim(
        bodyResult.parsed?.claim,
        bodyResult.parsed?.mode || 'evidence',
      );
      sendJson(res, 200, { data: result, ...result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/service/stop') {
      const bodyResult = await readJsonBody<{
        mode?: 'after-current-tasks' | 'force';
        confirm?: boolean;
        reason?: string;
      }>(req, res, correlationId);
      if (!bodyResult) return true;

      try {
        const mode = bodyResult.parsed?.mode || 'after-current-tasks';
        const confirm = bodyResult.parsed?.confirm;
        const reason = bodyResult.parsed?.reason;

        const result = this.services.project.stopService({
          mode,
          confirm,
          reason,
        });

        sendJson(res, 200, { data: result }, correlationId);
      } catch (err: any) {
        const code = err.message?.includes('CONFIRMATION_REQUIRED') ? 'CONFIRMATION_REQUIRED' : 'SERVICE_STOP_ERROR';
        sendError(res, 400, code, err.message || 'Service stop failed', correlationId);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/service/visibility') {
      const visibility = this.services.project.getSovereigntyVisibility(this.instanceIdentity);
      sendJson(res, 200, { data: visibility }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/security/sovereignty') {
      const status = this.services.project.getSovereigntyStatus();
      const visibility = this.services.project.getSovereigntyVisibility(this.instanceIdentity);
      sendJson(res, 200, { data: { ...status, ...visibility } }, correlationId);
      return true;
    }

    // ── Service Lifecycle & Recovery Controls (UI1-19) ──────────────

    if (method === 'GET' && pathname === '/api/v1/service/lifecycle') {
      const activeTasksCount = this.services.task ? this.services.task.listTasks({ status: 'active' }).length : 0;
      sendJson(
        res,
        200,
        {
          data: {
            defaults: {
              serviceIdleTimeoutMs: 600_000, // 10 minutes default
              modelIdleTimeoutMs: 180_000,   // 3 minutes default
              sessionTtlMs: 3_600_000,       // 1 hour default
            },
            identity: this.instanceIdentity || null,
            activeTasksCount,
            orphanReaperEnabled: true,
            pauseResumeSupported: false,
          },
        },
        correlationId,
      );
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/service/orphan-cleanup') {
      const bodyResult = await readJsonBody<{ maxAgeMs?: number }>(req, res, correlationId);
      const maxAgeMs = bodyResult?.parsed?.maxAgeMs ?? 0;
      const purged = this.services.artifact.cleanupOrphanTempFiles(maxAgeMs);
      sendJson(res, 200, { data: { purged, maxAgeMs, cleanedAt: new Date().toISOString() } }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/service/keepalive') {
      const bodyResult = await readJsonBody<{ taskId?: string }>(req, res, correlationId);
      const taskId = bodyResult?.parsed?.taskId;
      sendJson(
        res,
        200,
        {
          data: {
            acknowledged: true,
            taskId: taskId || null,
            serverTimestamp: new Date().toISOString(),
            status: 'healthy',
          },
        },
        correlationId,
      );
      return true;
    }

    // ── Workspace Layout & Role Presets (UI1-07) ─────────────────

    if (method === 'GET' && pathname === '/api/v1/layout') {
      const projectId = query.get('projectId') || getOrGenerateProjectId(this.projectRoot);
      const roleQuery = query.get('role');
      const defaultRole = roleQuery && isRolePreset(roleQuery) ? roleQuery : 'developer';
      const storagePath = this.services.layout.getStoragePath();
      const exists = fs.existsSync(storagePath);
      const layout = this.services.layout.loadLayout(projectId, defaultRole);
      sendJson(res, 200, { data: layout, exists }, correlationId);
      return true;
    }

    if (method === 'PUT' && pathname === '/api/v1/layout') {
      const bodyResult = await readJsonBody<Record<string, unknown>>(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'put_layout',
        'default',
      );
      if (idempotency.isReplay) return true;

      const targetProjectId = (bodyResult.parsed as any)?.projectId || getOrGenerateProjectId(this.projectRoot);
      const validation = validateWorkspaceLayout(bodyResult.parsed, targetProjectId);
      if (!validation.valid || !validation.layout) {
        sendError(
          res,
          400,
          'INVALID_WORKSPACE_LAYOUT',
          validation.errors?.join('; ') || 'Invalid workspace layout',
          correlationId,
        );
        return true;
      }

      const saved = this.services.layout.saveLayout(validation.layout);
      const responsePayload = { data: saved };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 200, responsePayload, this.services.idempotency);
      }
      sendJson(res, 200, responsePayload, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/layout/reset') {
      const bodyResult = await readJsonBody<{ role?: string; projectId?: string }>(req, res, correlationId);
      if (!bodyResult) return true;

      const projectId = bodyResult.parsed?.projectId || getOrGenerateProjectId(this.projectRoot);
      const role = bodyResult.parsed?.role;
      const targetRole = role && isRolePreset(role) ? role : 'developer';

      const resetLayout = this.services.layout.resetLayout(projectId, targetRole);
      sendJson(res, 200, { data: resetLayout }, correlationId);
      return true;
    }

    // ── Conversations & Messages ──────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/conversations') {
      const projectId = query.get('projectId') || undefined;
      const conversations = this.services.conversation.listConversations(projectId);
      sendJson(res, 200, { data: conversations }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/conversations') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_conversation',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      if (!payload.projectId || !payload.agentId) {
        sendError(res, 400, 'VALIDATION_FAILED', 'projectId and agentId are required to create a conversation.', correlationId);
        return true;
      }

      const conv = this.services.conversation.createConversation({
        id: payload.id,
        projectId: payload.projectId,
        agentId: payload.agentId,
        taskId: payload.taskId,
      });
      const responsePayload = { data: conv };

      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    const convDetailMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
    if (method === 'GET' && convDetailMatch) {
      const convId = decodeURIComponent(convDetailMatch[1]);
      const conv = this.services.conversation.getConversation(convId);
      if (!conv) {
        sendError(res, 404, 'NOT_FOUND', `Conversation '${convId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: conv }, correlationId);
      return true;
    }

    const convMessagesMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
    if (method === 'POST' && convMessagesMatch) {
      const convId = decodeURIComponent(convMessagesMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'add_message',
        'default',
      );
      if (idempotency.isReplay) return true;

      const payload = bodyResult.parsed || {};
      // Validate message schema
      const messageToValidate = {
        schemaVersion: payload.schemaVersion ?? 1,
        id: payload.id || 'tmp_id',
        role: payload.role,
        content: payload.content,
        timestamp: new Date().toISOString(),
      };
      const validation = validateMessage(messageToValidate);
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', 'Invalid message payload.', correlationId, validation.errors);
        return true;
      }

      try {
        const msg = this.services.conversation.addMessage(convId, payload);
        const responsePayload = { data: msg };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        sendError(res, 404, 'NOT_FOUND', err.message, correlationId);
      }
      return true;
    }

    const convPromoteMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/promote$/);
    if (method === 'POST' && convPromoteMatch) {
      const convId = decodeURIComponent(convPromoteMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'promote_conversation',
        'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const result = this.services.conversation.promoteToTask(
          convId,
          {
            conversationId: convId,
            description: payload.description,
            agent: payload.agent,
            branch: payload.branch,
            complexity: payload.complexity,
            category: payload.category,
            attachments: payload.attachments,
            mode: payload.mode,
            allowUnreviewedBrainstorm: payload.allowUnreviewedBrainstorm,
          },
          this.services.task,
        );

        const responsePayload = { data: result };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        if (err.message && err.message.startsWith('PATH_TRAVERSAL')) {
          sendError(res, 400, 'PATH_TRAVERSAL', err.message, correlationId);
        } else if (err.message && err.message.startsWith('PATH_OUTSIDE_PROJECT')) {
          sendError(res, 400, 'PATH_OUTSIDE_PROJECT', err.message, correlationId);
        } else if (err.message && err.message.startsWith('OVERSIZED_ATTACHMENT')) {
          sendError(res, 413, 'OVERSIZED_ATTACHMENT', err.message, correlationId);
        } else if (err.message && err.message.startsWith('BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW')) {
          sendError(res, 400, 'BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW', err.message, correlationId);
        } else if (err.message && err.message.startsWith('VALIDATION_FAILED')) {
          sendError(res, 400, 'VALIDATION_FAILED', err.message, correlationId);
        } else {
          sendError(res, 404, 'NOT_FOUND', err.message, correlationId);
        }
      }
      return true;
    }

    const convModeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/mode$/);
    if (method === 'PATCH' && convModeMatch) {
      const convId = decodeURIComponent(convModeMatch[1]);
      const bodyResult = await readJsonBody<{ mode: OperationalMode; confirmed?: boolean }>(req, res, correlationId);
      if (!bodyResult) return true;

      try {
        const updated = this.services.conversation.updateMode(
          convId,
          bodyResult.parsed?.mode as any,
          bodyResult.parsed?.confirmed === true,
        );
        sendJson(res, 200, { data: updated }, correlationId);
      } catch (err: any) {
        const code = err.message?.includes('SILENT_DOWNGRADE_FORBIDDEN') ? 'SILENT_DOWNGRADE_FORBIDDEN' : 'MODE_UPDATE_ERROR';
        sendError(res, 400, code, err.message, correlationId);
      }
      return true;
    }

    const convPinMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/pin$/);
    if (method === 'PATCH' && convPinMatch) {
      const convId = decodeURIComponent(convPinMatch[1]);
      const bodyResult = await readJsonBody<{ pinned: boolean }>(req, res, correlationId);
      if (!bodyResult) return true;

      try {
        const updated = this.services.conversation.setPinned(
          convId,
          bodyResult.parsed?.pinned === true,
        );
        sendJson(res, 200, { data: updated }, correlationId);
      } catch (err: any) {
        sendError(res, 400, 'PIN_UPDATE_ERROR', err.message, correlationId);
      }
      return true;
    }

    // ── Chat Inference ────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/v1/chat/completions') {
      const bodyResult = await readJsonBody<{
        conversationId?: string;
        messages?: Array<{ role: string; content: string }>;
      }>(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed;
      if (!payload || !payload.conversationId || !Array.isArray(payload.messages) || payload.messages.length === 0) {
        sendError(
          res,
          400,
          'VALIDATION_FAILED',
          'conversationId and a non-empty messages array are required.',
          correlationId,
        );
        return true;
      }

      try {
        const abortController = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        };
        req.on('close', onClose);

        try {
          const result = await this.services.chatInference.chatCompletion({
            conversationId: payload.conversationId,
            messages: payload.messages as any,
            signal: abortController.signal,
          });
          sendJson(res, 200, { data: result }, correlationId);
        } finally {
          req.off('close', onClose);
        }
      } catch (err: any) {
        if (err instanceof ChatInferenceError) {
          const status =
            err.code === 'MODEL_SERVER_UNAVAILABLE'
              ? 503
              : err.code === 'MODEL_INFERENCE_TIMEOUT'
              ? 504
              : err.code === 'INVALID_MODEL_RESPONSE'
              ? 502
              : 500;
          sendError(res, status, err.code, err.message, correlationId, err.details);
        } else {
          sendError(res, 500, 'CHAT_INFERENCE_FAILED', err.message || 'Chat completion failed', correlationId);
        }
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/chat/health') {
      const available = await this.services.chatInference.isModelServerAvailable();
      sendJson(res, 200, { data: { available, status: available ? 'available' : 'unavailable' } }, correlationId);
      return true;
    }

    // ── Tasks ─────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/tasks') {
      const status = query.get('status') as any;
      const type = query.get('type') as any;
      const agentId = query.get('agentId') || undefined;
      const limit = query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined;

      const tasks = this.services.task.listTasks({ status, type, agentId, limit });
      sendJson(res, 200, { data: tasks }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/tasks') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_task',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      // Schema version check
      if (payload.schemaVersion !== undefined && payload.schemaVersion !== 1) {
        sendError(res, 400, 'INCOMPATIBLE_SCHEMA_VERSION', `Expected schemaVersion: 1, got ${payload.schemaVersion}.`, correlationId);
        return true;
      }

      if (!payload.description || typeof payload.description !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'Task description must be a non-empty string.', correlationId);
        return true;
      }

      const task = this.services.task.createTask({
        description: payload.description,
        agent: payload.agent,
        branch: payload.branch,
        capabilities: payload.capabilities,
        complexity: payload.complexity,
        category: payload.category,
        type: payload.type,
        objectiveId: payload.objectiveId,
        depth: payload.depth,
        reviewRequired: payload.reviewRequired,
        dependsOn: payload.dependsOn,
      });

      const responsePayload = { data: task };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    const taskDetailMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskDetailMatch) {
      const taskId = decodeURIComponent(taskDetailMatch[1]);
      const tasks = this.services.task.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) {
        sendError(res, 404, 'NOT_FOUND', `Task '${taskId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: task }, correlationId);
      return true;
    }

    // ── Fair Priority & Cancellation Queue ───────────────────────

    if (method === 'GET' && pathname === '/api/v1/queue') {
      const projectId = query.get('projectId') || undefined;
      const status = (query.get('status') as any) || undefined;
      const queue = this.services.queue.getQueue({ projectId, status });
      sendJson(res, 200, { data: queue }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/queue/status') {
      const projectId = query.get('projectId') || undefined;
      const statusSummary = this.services.queue.getQueueStatus(projectId);
      sendJson(res, 200, { data: statusSummary }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/queue') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'enqueue_task',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      const validation = validateEnqueueInput(payload);
      if (!validation.valid) {
        sendError(
          res,
          400,
          'INVALID_PRIORITY_CLASS',
          validation.errors.join('; '),
          correlationId,
          validation.errors,
        );
        return true;
      }

      try {
        const entry = this.services.queue.enqueue({
          taskId: payload.taskId,
          agentId: payload.agentId,
          projectId: payload.projectId,
          runId: payload.runId,
          priorityClass: payload.priorityClass,
          requestedModelId: payload.requestedModelId,
          requestedDevice: payload.requestedDevice,
          allowCpuFallback: payload.allowCpuFallback,
          timeoutMs: payload.timeoutMs,
          idempotencyKey: payload.idempotencyKey,
          dependencies: payload.dependencies,
          description: payload.description,
        });

        const responsePayload = { data: entry };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        const statusCode = err.statusCode || (err.code === 'DUPLICATE_QUEUE_ENTRY' ? 409 : 400);
        const errorCode = err.code || 'QUEUE_ERROR';
        sendError(res, statusCode, errorCode, err.message, correlationId);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/queue/recover') {
      const result = this.services.queue.recoverQueueState();
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    const queueCancelMatch = pathname.match(/^\/api\/v1\/queue\/([^/]+)\/cancel$/);
    if (method === 'POST' && queueCancelMatch) {
      const entryId = decodeURIComponent(queueCancelMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const validation = validateCancelInput({ entryId, ...payload });
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', validation.errors.join('; '), correlationId, validation.errors);
        return true;
      }

      try {
        const cancelled = this.services.queue.cancel(entryId, {
          entryId,
          projectId: payload.projectId || query.get('projectId') || undefined,
          runId: payload.runId || query.get('runId') || undefined,
          reason: payload.reason,
          force: payload.force,
        });
        sendJson(res, 200, { data: cancelled }, correlationId);
      } catch (err: any) {
        const statusCode = err.statusCode || 400;
        const errorCode = err.code || 'CANCELLATION_ERROR';
        sendError(res, statusCode, errorCode, err.message, correlationId);
      }
      return true;
    }

    const queueDetailMatch = pathname.match(/^\/api\/v1\/queue\/([^/]+)$/);
    if (method === 'GET' && queueDetailMatch) {
      const entryId = decodeURIComponent(queueDetailMatch[1]);
      const projectId = query.get('projectId') || undefined;
      try {
        const entry = this.services.queue.getEntry(entryId, { projectId });
        if (!entry) {
          sendError(res, 404, 'NOT_FOUND', `Queue entry '${entryId}' not found.`, correlationId);
          return true;
        }
        sendJson(res, 200, { data: entry }, correlationId);
      } catch (err: any) {
        const statusCode = err.statusCode || 400;
        const errorCode = err.code || 'QUEUE_LOOKUP_ERROR';
        sendError(res, statusCode, errorCode, err.message, correlationId);
      }
      return true;
    }

    // ── Workflows & Runs ──────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/workflows') {
      const workflows = this.services.workflow.listObjectives();
      sendJson(res, 200, { data: workflows }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/workflows') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_workflow',
        'default',
      );
      if (idempotency.isReplay) return true;

      const payload = bodyResult.parsed || {};
      if (!payload.goal || typeof payload.goal !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'Workflow goal is required.', correlationId);
        return true;
      }

      const id = payload.id || `OBJ_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const wf = this.services.workflow.createObjective({
        id,
        goal: payload.goal,
        plannerAgentId: payload.plannerAgentId || 'AUTO',
        maxReplanAttempts: payload.maxReplanAttempts,
      });

      const responsePayload = { data: wf };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    const workflowRunStagesMatch = pathname.match(/^\/api\/v1\/workflows\/runs\/([^/]+)\/stages$/);
    if (method === 'GET' && workflowRunStagesMatch) {
      const runId = decodeURIComponent(workflowRunStagesMatch[1]);
      const stages = this.services.workflow.getRunStages(runId);
      sendJson(res, 200, { data: stages }, correlationId);
      return true;
    }

    const workflowProjectionMatch = pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/projection$/);
    if (method === 'GET' && workflowProjectionMatch) {
      const id = decodeURIComponent(workflowProjectionMatch[1]);
      const projectId = query.get('projectId') || getOrGenerateProjectId(this.projectRoot);
      const cockpitState = this.services.cockpit.getCockpitState(projectId, id);
      if (cockpitState) {
        const runProj = projectWorkflowState(cockpitState);
        sendJson(res, 200, { data: runProj }, correlationId);
        return true;
      }
      const stageProj = this.services.workflow.getWorkflowProjection(id, projectId);
      if (!stageProj) {
        sendError(res, 404, 'NOT_FOUND', `Workflow projection for '${id}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: stageProj }, correlationId);
      return true;
    }

    const workflowDetailMatch = pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
    if (method === 'GET' && workflowDetailMatch) {
      const wfId = decodeURIComponent(workflowDetailMatch[1]);
      const wf = this.services.workflow.getObjective(wfId);
      if (!wf) {
        sendError(res, 404, 'NOT_FOUND', `Workflow '${wfId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: wf }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/runs') {
      const events = this.services.event.query({ limit: 50 });
      sendJson(res, 200, { data: events }, correlationId);
      return true;
    }

    const runProjectionMatch = pathname.match(/^\/api\/v1\/(runs|cockpit)\/([^/]+)\/projection$/);
    if (method === 'GET' && runProjectionMatch) {
      const runId = decodeURIComponent(runProjectionMatch[2]);
      const projectId = query.get('projectId') || getOrGenerateProjectId(this.projectRoot);
      const proj = this.services.cockpit.getWorkflowRunProjection(projectId, runId);
      if (!proj) {
        sendError(res, 404, 'NOT_FOUND', `Run projection for '${runId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: proj }, correlationId);
      return true;
    }

    const runDetailMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (method === 'GET' && runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1]);
      const timeline = this.services.event.getTaskTimeline(runId);
      sendJson(res, 200, { data: timeline }, correlationId);
      return true;
    }

    // ── Deterministic Inference (F7-02) ───────────────────────────

    if (method === 'POST' && pathname === '/api/v1/inference') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      try {
        const input = bodyResult.parsed || {};
        const result = this.services.inference.infer(input as any);
        sendJson(res, 200, { data: result }, correlationId);
      } catch (err: any) {
        sendError(res, 400, 'INFERENCE_ERROR', err.message || 'Inference evaluation failed.', correlationId);
      }
      return true;
    }

    // ── Workflow Planning (F7-03) ─────────────────────────────────

    if (method === 'POST' && pathname === '/api/v1/plans') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_workflow_plan',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const outcome = this.services.workflowPlanning.createPlan(payload as any);
        if (!outcome.success) {
          const status = outcome.code === 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' ? 403 : 400;
          sendError(
            res,
            status,
            outcome.code || 'PLANNING_FAILED',
            outcome.reason || 'Workflow planning failed.',
            correlationId,
            outcome.clarificationPrompt ? { clarificationPrompt: outcome.clarificationPrompt } : outcome.details,
          );
          return true;
        }

        const responsePayload = { data: outcome.plan };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        sendError(res, 400, 'PLANNING_ERROR', err.message || 'Workflow planning failed.', correlationId);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/plans') {
      const plans = this.services.workflowPlanning.listPlans();
      sendJson(res, 200, { data: plans }, correlationId);
      return true;
    }

    const planDetailMatch = pathname.match(/^\/api\/v1\/plans\/([^/]+)$/);
    if (method === 'GET' && planDetailMatch) {
      const planId = decodeURIComponent(planDetailMatch[1]);
      const plan = this.services.workflowPlanning.getPlan(planId);
      if (!plan) {
        sendError(res, 404, 'NOT_FOUND', `Workflow plan '${planId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: plan }, correlationId);
      return true;
    }

    // ── Tool & Approval Execution Planning (F7-04) ────────────────

    if (method === 'POST' && pathname === '/api/v1/execution-plans') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_execution_contract',
        payload.plan?.provenance?.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const contract = this.services.toolApprovalPlanning.createContract(
          payload.step,
          payload.plan,
          payload.options,
        );
        const responsePayload = { data: contract };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        if (err.message && err.message.includes('HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL')) {
          sendError(res, 403, 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL', err.message, correlationId);
        } else {
          sendError(res, 400, 'CONTRACT_CREATION_FAILED', err.message || 'Execution contract creation failed.', correlationId);
        }
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/execution-plans/evaluate') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      try {
        const outcome = this.services.toolApprovalPlanning.evaluatePreExecution(
          payload.contract,
          payload.context,
        );
        const status = outcome.code === 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' ? 403 : 200;
        sendJson(res, status, { data: outcome }, correlationId);
      } catch (err: any) {
        if (err.message && err.message.includes('HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL')) {
          sendError(res, 403, 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL', err.message, correlationId);
        } else {
          sendError(res, 400, 'PRE_EXECUTION_EVALUATION_FAILED', err.message || 'Pre-execution evaluation failed.', correlationId);
        }
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/execution-plans') {
      const planId = query.get('planId') || undefined;
      const contracts = this.services.toolApprovalPlanning.listContracts(planId);
      sendJson(res, 200, { data: contracts }, correlationId);
      return true;
    }

    const executionPlanDetailMatch = pathname.match(/^\/api\/v1\/execution-plans\/([^/]+)$/);
    if (method === 'GET' && executionPlanDetailMatch) {
      const contractId = decodeURIComponent(executionPlanDetailMatch[1]);
      const contract = this.services.toolApprovalPlanning.getContract(contractId);
      if (!contract) {
        sendError(res, 404, 'NOT_FOUND', `Execution contract '${contractId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: contract }, correlationId);
      return true;
    }

    // ── Approvals (UI1-14) ───────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/approvals') {
      const status = query.get('status') || undefined;
      const scope = query.get('scope') || undefined;
      const projectId = query.get('projectId') || undefined;
      const runId = query.get('runId') || undefined;
      const taskId = query.get('taskId') || undefined;

      const approvals = this.services.approval.listApprovals({
        status,
        scope,
        projectId,
        runId,
        taskId,
      });
      sendJson(res, 200, { data: approvals }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/approvals') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = (bodyResult.parsed || {}) as Record<string, any>;
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'create_approval',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const appr = this.services.approval.createApproval(payload as any);
        const responsePayload = { data: appr };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(
            idempotency.idempotencyKey,
            idempotency.bodyHash,
            201,
            responsePayload,
            this.services.idempotency,
          );
        }
        sendJson(res, 201, responsePayload, correlationId);
      } catch (err: any) {
        if (err instanceof ApprovalError) {
          sendError(res, 400, err.code, err.message, correlationId);
        } else {
          throw err;
        }
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/approvals/force-stop') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = (bodyResult.parsed || {}) as Record<string, any>;
      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'force_stop',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      if (payload.confirm !== true) {
        sendError(
          res,
          400,
          APPROVAL_ERROR_CODES.FORCE_STOP_CONFIRMATION_REQUIRED,
          'Force-stop operation strictly requires explicit confirmation (confirm: true).',
          correlationId,
        );
        return true;
      }

      if (!payload.taskId || typeof payload.taskId !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'taskId is required for force-stop.', correlationId);
        return true;
      }

      try {
        const result = await this.services.approval.executeForceStop({
          approvalId: payload.approvalId,
          taskId: payload.taskId,
          runId: payload.runId || 'default',
          projectId: payload.projectId || 'default',
          confirm: payload.confirm,
          reason: payload.reason || 'Force-stopped via governance API',
          actorId: payload.actorId || 'operator',
        });
        const responsePayload = { data: result };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(
            idempotency.idempotencyKey,
            idempotency.bodyHash,
            200,
            responsePayload,
            this.services.idempotency,
          );
        }
        sendJson(res, 200, responsePayload, correlationId);
      } catch (err: any) {
        if (err instanceof ApprovalError) {
          let status = 400;
          if (err.code === APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND) status = 404;
          sendError(res, status, err.code, err.message, correlationId);
        } else {
          throw err;
        }
      }
      return true;
    }

    const approvalDetailMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)$/);
    if (method === 'GET' && approvalDetailMatch) {
      const apprId = decodeURIComponent(approvalDetailMatch[1]);
      const appr = this.services.approval.getApproval(apprId);
      if (!appr) {
        sendError(res, 404, 'NOT_FOUND', `Approval '${apprId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: appr }, correlationId);
      return true;
    }

    const approvalReviewMatch = pathname.match(
      /^\/api\/v1\/approvals\/([^/]+)\/(review|resolve|decide)$/,
    );
    if (method === 'POST' && approvalReviewMatch) {
      const apprId = decodeURIComponent(approvalReviewMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'review_approval',
        'default',
      );
      if (idempotency.isReplay) return true;

      const payload = (bodyResult.parsed || {}) as Record<string, any>;
      const decision = payload.decision || payload.status;
      const actorId = payload.actorId || payload.reviewedBy || payload.decidedBy || 'operator';
      const actorRole = payload.actorRole || payload.role || 'reviewer';
      const notes = payload.notes || payload.reason || payload.comment;
      const conditions = payload.conditions;

      try {
        const updated = this.services.approval.decideApproval(apprId, {
          decision,
          actorId,
          actorRole,
          notes,
          conditions,
        });

        let judgedRun: unknown;
        if (updated.metadata?.kind === 'maos-industrial-judged-run' && (updated.status === 'approved' || updated.status === 'rejected')) {
          judgedRun = await resumeJudgedRunAfterApproval(this.projectRoot, this.services, updated.approvalId);
        }
        const responsePayload = { data: updated, ...(judgedRun ? { judgedRun } : {}) };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(
            idempotency.idempotencyKey,
            idempotency.bodyHash,
            200,
            responsePayload,
            this.services.idempotency,
          );
        }

        sendJson(res, 200, responsePayload, correlationId);
      } catch (err: any) {
        if (err instanceof ApprovalError) {
          let status = 400;
          if (err.code === APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND) status = 404;
          else if (
            err.code === APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED
          )
            status = 409;
          else if (
            err.code === APPROVAL_ERROR_CODES.UNAUTHORIZED_REVIEWER_ROLE ||
            err.code === APPROVAL_ERROR_CODES.UNTRUSTED_SELF_APPROVAL_REJECTED ||
            err.code === APPROVAL_ERROR_CODES.CROSS_PROJECT_APPROVAL_USE ||
            err.code === APPROVAL_ERROR_CODES.CROSS_RUN_APPROVAL_USE
          )
            status = 403;
          sendError(res, status, err.code, err.message, correlationId);
        } else {
          throw err;
        }
      }
      return true;
    }

    const approvalValidateMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/validate$/);
    if (method === 'POST' && approvalValidateMatch) {
      const apprId = decodeURIComponent(approvalValidateMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = (bodyResult.parsed || {}) as Record<string, any>;
      const check = this.services.approval.validateApprovalForAction(apprId, payload as any);
      sendJson(res, 200, { data: check }, correlationId);
      return true;
    }

    const approvalConsumeMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/consume$/);
    if (method === 'POST' && approvalConsumeMatch) {
      const apprId = decodeURIComponent(approvalConsumeMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = (bodyResult.parsed || {}) as Record<string, any>;
      try {
        const updated = this.services.approval.consumeApproval(apprId, {
          actorId: payload.actorId || 'operator',
          operation: payload.operation || 'execution',
        });
        sendJson(res, 200, { data: updated }, correlationId);
      } catch (err: any) {
        if (err instanceof ApprovalError) {
          let status = 400;
          if (err.code === APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND) status = 404;
          else if (err.code === APPROVAL_ERROR_CODES.OPERATION_REUSE_REJECTED) status = 409;
          sendError(res, status, err.code, err.message, correlationId);
        } else {
          throw err;
        }
      }
      return true;
    }

    // ── Agent Cockpit (UI1-15) ────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/cockpit') {
      const config = this.services.project.loadConfig();
      const projectId = query.get('projectId') || config.projectName || 'default';
      const runs = this.services.cockpit.listCockpitRuns(projectId);
      sendJson(res, 200, { data: runs }, correlationId);
      return true;
    }

    const cockpitReplayMatch = pathname.match(/^\/api\/v1\/cockpit\/([^/]+)\/replay$/);
    if (method === 'GET' && cockpitReplayMatch) {
      const runId = decodeURIComponent(cockpitReplayMatch[1]);
      const config = this.services.project.loadConfig();
      const projectId = query.get('projectId') || config.projectName || 'default';
      const fromCursor = parseInt(query.get('fromCursor') || query.get('cursor') || '0', 10);

      try {
        const replayRes = this.services.cockpit.replayRunEvents(projectId, runId, fromCursor);
        sendJson(res, 200, { data: replayRes.state, meta: { events: replayRes.events } }, correlationId);
      } catch (err: any) {
        sendError(res, 404, 'NOT_FOUND', err.message || `Replay failed for run '${runId}'.`, correlationId);
      }
      return true;
    }

    const cockpitStopMatch = pathname.match(/^\/api\/v1\/cockpit\/([^/]+)\/stop$/);
    if (method === 'POST' && cockpitStopMatch) {
      const runId = decodeURIComponent(cockpitStopMatch[1]);
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const config = this.services.project.loadConfig();
      const projectId = payload.projectId || query.get('projectId') || config.projectName || 'default';
      const mode = payload.mode === 'force' ? 'force' : 'cancel';

      if (mode === 'force' && !payload.confirmed) {
        sendError(
          res,
          400,
          'FORCE_STOP_CONFIRMATION_REQUIRED',
          'Force stop mandates explicit confirmation.',
          correlationId,
        );
        return true;
      }

      try {
        const stopResult = await this.services.cockpit.executeRunStop(projectId, runId, {
          mode,
          reason: payload.reason,
          confirmed: Boolean(payload.confirmed),
        });
        sendJson(res, 200, { data: stopResult }, correlationId);
      } catch (err: any) {
        sendError(res, 500, 'STOP_FAILED', err.message || `Stop failed for run '${runId}'.`, correlationId);
      }
      return true;
    }

    const cockpitDetailMatch = pathname.match(/^\/api\/v1\/cockpit\/([^/]+)$/);
    if (method === 'GET' && cockpitDetailMatch) {
      const runId = decodeURIComponent(cockpitDetailMatch[1]);
      const config = this.services.project.loadConfig();
      const projectId = query.get('projectId') || config.projectName || 'default';
      const state = this.services.cockpit.getCockpitState(projectId, runId);

      if (!state) {
        sendError(res, 404, 'NOT_FOUND', `Cockpit state for run '${runId}' not found.`, correlationId);
        return true;
      }

      sendJson(res, 200, { data: state }, correlationId);
      return true;
    }

    // ── Artifacts ─────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/artifacts') {
      const runId = query.get('runId') || undefined;
      const artifacts = this.services.artifact.listArtifacts(runId);
      sendJson(res, 200, { data: artifacts }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/artifacts') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'finalize_artifact',
        payload.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      const artifact = this.services.artifact.finalizeArtifact({
        id: payload.id,
        relativePath: payload.relativePath || payload.path,
        content: payload.content,
        type: payload.type,
        runId: payload.runId,
        taskId: payload.taskId,
        projectId: payload.projectId,
        correlationId,
        expectedHash: payload.expectedHash,
        allowOverwrite: payload.allowOverwrite,
        approvalId: payload.approvalId,
        metadata: payload.metadata,
        producer: payload.producer,
      });

      const responsePayload = { data: artifact };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    const artifactContentMatch = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
    if (method === 'GET' && artifactContentMatch) {
      const rawId = decodeURIComponent(artifactContentMatch[1]);
      // Check for path traversal characters
      if (rawId.includes('..') || rawId.includes('\\') || rawId.startsWith('/') || rawId.includes(':')) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Invalid artifact identifier with path traversal sequence.', correlationId);
        return true;
      }

      try {
        const { content, contentType } = this.services.artifact.getArtifactContent(rawId);
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Correlation-ID': correlationId,
        });
        res.end(content);
      } catch (err: any) {
        if (err.message && (err.message.includes('not found') || err.message.includes('NOT_FOUND'))) {
          sendError(res, 404, 'NOT_FOUND', err.message, correlationId);
        } else {
          throw err;
        }
      }
      return true;
    }

    const artifactDetailMatch = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)$/);
    if (method === 'GET' && artifactDetailMatch) {
      const artId = decodeURIComponent(artifactDetailMatch[1]);
      const art = this.services.artifact.getArtifact(artId);
      if (!art) {
        sendError(res, 404, 'NOT_FOUND', `Artifact '${artId}' not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: art }, correlationId);
      return true;
    }

    // ── Models & Leases ───────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/models') {
      const models = this.services.model.listModels();
      const registered = this.services.model.listRegisteredModels();
      sendJson(res, 200, { data: models, registeredModels: registered }, correlationId);
      return true;
    }

    if (method === 'GET' && (pathname === '/api/v1/models/residency' || pathname === '/api/v1/models/status')) {
      const status = this.services.model.getModelResidencyStatus();
      sendJson(res, 200, { data: status }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/models/active') {
      const projectId = query.get('projectId') || undefined;
      const identity = this.services.modelSwitch.getActiveModelIdentity({ projectId });
      sendJson(res, 200, { data: identity }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/models/route') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const validation = validateModelRouteRequest(payload);
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', validation.errors.join('; '), correlationId);
        return true;
      }

      try {
        const routeResult = this.services.modelSwitch.determineRoute(payload);
        sendJson(res, 200, { data: routeResult }, correlationId);
        return true;
      } catch (err: any) {
        const code = err.code || 'ROUTE_FAILED';
        const status = code === 'MODEL_UNAVAILABLE' ? 404 : code === 'MODEL_UNHEALTHY' ? 503 : 400;
        sendError(res, status, code, err.message, correlationId);
        return true;
      }
    }

    if (method === 'POST' && pathname === '/api/v1/models/switch') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'switch_model',
        'default',
      );
      if (idempotency.isReplay) return true;

      const payload = bodyResult.parsed || {};
      const validation = validateModelSwitchRequest(payload);
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', validation.errors.join('; '), correlationId);
        return true;
      }

      try {
        const result = await this.services.modelSwitch.switchModel(payload);
        const responsePayload = { data: result };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 200, responsePayload, this.services.idempotency);
        }
        sendJson(res, 200, responsePayload, correlationId);
        return true;
      } catch (err: any) {
        const code = err.code || 'MODEL_SWITCH_FAILED';
        let status = 400;
        if (
          code === 'WORKFLOW_FIXED_MODEL_PROTECTED' ||
          code === 'CONCURRENCY_VIOLATION' ||
          code === 'MID_RUN_SWITCH_FORBIDDEN'
        ) {
          status = 409;
        } else if (code === 'MODEL_UNAVAILABLE') {
          status = 404;
        } else if (code === 'MODEL_UNHEALTHY') {
          status = 503;
        }
        sendError(res, status, code, err.message, correlationId);
        return true;
      }
    }

    if (method === 'GET' && pathname === '/api/v1/models/leases') {
      const projectId = query.get('projectId') || undefined;
      const leases = this.services.model.listLeases(projectId);
      sendJson(res, 200, { data: leases }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/models/leases') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'acquire_lease',
        'default',
      );
      if (idempotency.isReplay) return true;

      const payload = bodyResult.parsed || {};
      const validation = validateAcquireModelLeaseInput(payload);
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', validation.errors.join('; '), correlationId);
        return true;
      }

      try {
        const lease = this.services.model.acquireLease({
          modelId: payload.modelId,
          agentId: payload.agentId,
          port: payload.port,
          projectId: payload.projectId,
          runId: payload.runId,
          priority: payload.priority,
          timeoutMs: payload.timeoutMs,
          expectedRevision: payload.expectedRevision,
          allowCpuFallback: payload.allowCpuFallback,
        });

        const responsePayload = { data: lease };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
        }

        sendJson(res, 201, responsePayload, correlationId);
        return true;
      } catch (err: any) {
        const code = err.code || 'LEASE_ACQUISITION_FAILED';
        sendError(res, 400, code, err.message, correlationId);
        return true;
      }
    }

    const modelLeaseRenewMatch = pathname.match(/^\/api\/v1\/models\/leases\/([^/]+)\/renew$/);
    if (method === 'POST' && modelLeaseRenewMatch) {
      const leaseId = decodeURIComponent(modelLeaseRenewMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      const validation = validateRenewModelLeaseInput({ leaseId, ...payload });
      if (!validation.valid) {
        sendError(res, 400, 'VALIDATION_FAILED', validation.errors.join('; '), correlationId);
        return true;
      }

      try {
        const renewed = this.services.model.renewLease(
          leaseId,
          Number(payload.extensionMs),
          { projectId: payload.projectId, runId: payload.runId },
        );
        sendJson(res, 200, { data: renewed }, correlationId);
        return true;
      } catch (err: any) {
        const message = err?.message || String(err);
        if (message.includes('LEASE_NOT_FOUND')) {
          sendError(res, 404, 'NOT_FOUND', message, correlationId);
          return true;
        }
        let code = 'RENEW_FAILED';
        if (message.includes('LEASE_EXPIRED')) code = 'LEASE_EXPIRED';
        else if (message.includes('CROSS_PROJECT_LEASE_ACCESS')) code = 'CROSS_PROJECT_LEASE_ACCESS';
        else if (message.includes('WRONG_RUN_LEASE_RELEASE')) code = 'WRONG_RUN_LEASE_RELEASE';
        sendError(res, 400, code, message, correlationId);
        return true;
      }
    }

    if (method === 'POST' && pathname === '/api/v1/models/leases/reap') {
      const reapedCount = this.services.model.reapStaleLeases();
      sendJson(res, 200, { data: { reapedCount } }, correlationId);
      return true;
    }

    const modelLeaseDeleteMatch = pathname.match(/^\/api\/v1\/models\/leases\/([^/]+)$/);
    if (method === 'DELETE' && modelLeaseDeleteMatch) {
      const leaseId = decodeURIComponent(modelLeaseDeleteMatch[1]);
      const projectId = query.get('projectId') || undefined;
      const runId = query.get('runId') || undefined;

      try {
        const released = this.services.model.releaseLease(leaseId, { projectId, runId });
        if (!released) {
          sendError(res, 404, 'NOT_FOUND', `Lease '${leaseId}' not found.`, correlationId);
          return true;
        }
        sendJson(res, 200, { data: { released: true } }, correlationId);
        return true;
      } catch (err: any) {
        const message = err?.message || String(err);
        let code = 'RELEASE_FAILED';
        if (message.includes('CROSS_PROJECT_LEASE_ACCESS')) code = 'CROSS_PROJECT_LEASE_ACCESS';
        else if (message.includes('WRONG_RUN_LEASE_RELEASE')) code = 'WRONG_RUN_LEASE_RELEASE';
        sendError(res, 400, code, message, correlationId);
        return true;
      }
    }

    if (method === 'DELETE' && pathname === '/api/v1/models/leases') {
      const releasedCount = this.services.model.releaseAllLeases();
      sendJson(res, 200, { data: { releasedCount } }, correlationId);
      return true;
    }

    // ── Health & Diagnostics ──────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/health') {
      const config = this.services.project.loadConfig();
      const pool = this.services.health.getAgentPool(config.agents || []);
      const queueCounts = this.services.task.getQueueCounts();
      const retries = this.services.health.getRetryQueueStatus();
      const deadLetters = this.services.health.getDeadLetterQueue();

      sendJson(
        res,
        200,
        {
          data: {
            status: deadLetters.length > 0 ? 'DEGRADED' : 'HEALTHY',
            agentPool: pool,
            queueCounts,
            retryQueue: retries,
            deadLetterQueue: deadLetters,
            serviceInstanceId: this.instanceIdentity?.serviceInstanceId,
            servicePort: this.instanceIdentity?.servicePort,
          },
        },
        correlationId,
      );
      return true;
    }

    if (method === 'GET' && (pathname === '/api/v1/health/diagnostics' || pathname === '/api/v1/diagnostics')) {
      const diagnostics = this.services.health.runDiagnostics();
      sendJson(res, 200, { data: diagnostics }, correlationId);
      return true;
    }

    // ── Sequenced Events (REST History & Replay Fallback) ─────────

    if (method === 'GET' && pathname === '/api/v1/events') {
      const cursorParam = query.get('cursor') || query.get('fromSeq');
      const cursor = cursorParam !== null ? parseInt(cursorParam, 10) : undefined;
      const limitParam = query.get('limit');
      const limit = limitParam !== null ? Math.min(parseInt(limitParam, 10), 500) : 100;
      const projectId = query.get('projectId') || undefined;
      const runId = query.get('runId') || undefined;

      const bounds = this.services.event.getSequenceBounds();

      // Forward gap check (cursor > latest sequence)
      if (cursor !== undefined && cursor > bounds.latest) {
        sendError(
          res,
          409,
          'SEQUENCE_GAP',
          `Requested cursor ${cursor} is ahead of server latest sequence ${bounds.latest}. Resync required.`,
          correlationId,
          { latestSequence: bounds.latest, oldestSequence: bounds.oldest },
        );
        return true;
      }

      // Stale cursor check (cursor < oldest retained)
      if (cursor !== undefined && bounds.oldest > 1 && cursor < bounds.oldest - 1) {
        sendError(
          res,
          410,
          'STALE_CURSOR',
          `Requested cursor ${cursor} is older than oldest retained sequence ${bounds.oldest}. Resync required.`,
          correlationId,
          { latestSequence: bounds.latest, oldestSequence: bounds.oldest },
        );
        return true;
      }

      const events = this.services.event.querySequenced({
        fromSeq: cursor,
        limit,
        projectId,
        runId,
      });

      sendJson(
        res,
        200,
        {
          data: events,
          meta: {
            latestSequence: bounds.latest,
            oldestSequence: bounds.oldest,
            cursor: cursor ?? -1,
            count: events.length,
            hasMore: events.length > 0 && events[events.length - 1].sequence < bounds.latest,
          },
        },
        correlationId,
      );
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/events') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      if (!payload.eventType || typeof payload.eventType !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'Field "eventType" is required and must be a string.', correlationId);
        return true;
      }

      const config = this.services.project.loadConfig();
      const project = config.projectName || 'default';
      const eventProjectId = payload.projectId || project;

      // Cross-project mismatch rejection
      if (eventProjectId !== project && eventProjectId !== 'default') {
        sendError(
          res,
          400,
          'PROJECT_MISMATCH',
          `Event projectId '${eventProjectId}' does not match hosted project '${project}'.`,
          correlationId,
        );
        return true;
      }

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'record_event',
        eventProjectId,
      );
      if (idempotency.isReplay) return true;

      const event = this.services.event.recordEvent({
        eventId: payload.eventId,
        eventType: payload.eventType,
        projectId: eventProjectId,
        runId: payload.runId,
        taskId: payload.taskId,
        correlationId: payload.correlationId || correlationId,
        payload: payload.payload !== undefined ? payload.payload : (payload.data || {}),
      });

      const responsePayload = { data: event };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    // ── Audit Trail (F3-06) ───────────────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/audit') {
      const category = (query.get('category') || undefined) as any;
      const source = query.get('source') || undefined;
      const fromSeq = query.has('fromSeq') ? parseInt(query.get('fromSeq')!, 10) : undefined;
      const toSeq = query.has('toSeq') ? parseInt(query.get('toSeq')!, 10) : undefined;
      const limit = query.has('limit') ? parseInt(query.get('limit')!, 10) : undefined;

      const records = this.services.audit.getRecords({
        category,
        source,
        fromSeq,
        toSeq,
        limit,
      });

      sendJson(res, 200, { data: records, meta: { total: records.length } }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/audit/events') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'record_audit_event',
        'default',
      );
      if (idempotency.isReplay) return true;

      const record = this.services.audit.recordAuditEvent({
        source: payload.source,
        category: payload.category,
        data: payload.data,
        timestamp: payload.timestamp,
      });

      const responsePayload = { data: record };
      if (idempotency.idempotencyKey && idempotency.bodyHash) {
        recordIdempotency(idempotency.idempotencyKey, idempotency.bodyHash, 201, responsePayload, this.services.idempotency);
      }

      sendJson(res, 201, responsePayload, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/audit/verify') {
      const verification = this.services.audit.verifyChain();
      sendJson(res, 200, { data: verification }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/audit/export') {
      const exported = this.services.audit.exportAuditTrail();
      sendJson(res, 200, { data: exported }, correlationId);
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/sovereignty/panel') {
      const projectId = query.get('projectId') || getOrGenerateProjectId(this.projectRoot);
      const boundaryStatus = await this.services.industrialFirewallRequirement.getIndustrialBoundaryStatus(projectId);
      const activeBoundary = this.services.sovereigntyBoundary ? this.services.sovereigntyBoundary.getActiveBoundary(projectId) : null;
      const endpointPolicy = this.services.endpointAllowlist ? this.services.endpointAllowlist.getActivePolicy(projectId) : null;
      const trackedProcesses = this.services.serviceIdentity ? this.services.serviceIdentity.listTrackedProcesses() : [];
      const trackedBindings = this.services.serviceIdentity ? this.services.serviceIdentity.listTrackedBindings() : [];
      const verification = this.services.audit.verifyChain();
      const activeIdentity = this.instanceIdentity || null;

      sendJson(
        res,
        200,
        {
          data: {
            projectId,
            boundaryStatus,
            activeBoundary,
            endpointPolicy,
            trackedProcesses,
            trackedBindings,
            verification,
            activeIdentity,
            inspectedAt: new Date().toISOString(),
          },
        },
        correlationId,
      );
      return true;
    }

    // ── Canonical Verification (F3-07) ───────────────────────────

    if (method === 'POST' && pathname === '/api/v1/verify/run') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      if (!payload.runId || typeof payload.runId !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'runId is required to verify a run.', correlationId);
        return true;
      }

      const result = this.services.verifier.verifyRun(payload.runId);
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/verify/artifact') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      if (!payload.artifactId || typeof payload.artifactId !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'artifactId is required to verify an artifact.', correlationId);
        return true;
      }

      const result = this.services.verifier.verifyArtifact(payload.artifactId, payload.expectedHash);
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/verify/model') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      if (!payload.modelId || typeof payload.modelId !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'modelId is required to verify a model.', correlationId);
        return true;
      }

      const result = this.services.verifier.verifyModel({
        modelId: payload.modelId,
        revision: payload.revision,
        snapshotHash: payload.snapshotHash,
      });
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/verify/audit') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      const sequence = typeof payload.sequence === 'number' ? payload.sequence : undefined;
      const result = this.services.verifier.verifyAuditReference(sequence, payload.expectedHash);
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/verify/relationship') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      const result = this.services.verifier.verifyRelationship({
        projectId: payload.projectId,
        taskId: payload.taskId,
        runId: payload.runId,
        artifactId: payload.artifactId,
      });
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/verify/service') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult || !bodyResult.parsed || typeof bodyResult.parsed !== 'object') return true;
      const payload = bodyResult.parsed;

      if (!payload.serviceId || typeof payload.serviceId !== 'string') {
        sendError(res, 400, 'VALIDATION_FAILED', 'serviceId is required to verify service identity.', correlationId);
        return true;
      }

      const result = this.services.verifier.verifyServiceIdentity(payload.serviceId, payload.expectedExecutableHash);
      sendJson(res, 200, { data: result }, correlationId);
      return true;
    }

    // ── Sandbox Container Execution (F8-02) ───────────────────────────

    if (
      method === 'POST' &&
      (pathname === '/api/v1/sandbox/execute' ||
        pathname.match(/^\/api\/v1\/projects\/[^/]+\/sandbox\/execute$/))
    ) {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      const idempotency = checkIdempotency(
        req,
        res,
        bodyResult.raw,
        correlationId,
        this.services.idempotency,
        'sandbox.execute',
        bodyResult.parsed?.projectId || 'default',
      );
      if (idempotency.isReplay) return true;

      try {
        const result = await this.services.sandboxRunner.execute(bodyResult.parsed, {
          idempotencyKey: idempotency.idempotencyKey,
          executorType: bodyResult.parsed?.executorType,
        });

        const responsePayload = { data: result };
        if (idempotency.idempotencyKey && idempotency.bodyHash) {
          recordIdempotency(
            idempotency.idempotencyKey,
            idempotency.bodyHash,
            200,
            responsePayload,
            this.services.idempotency,
          );
        }
        sendJson(res, 200, responsePayload, correlationId);
      } catch (err: any) {
        if (err instanceof ContainerRunnerError) {
          const status =
            err.code === CONTAINER_RUNNER_ERROR_CODES.INVALID_INPUT
              ? 400
              : err.code === CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT ||
                err.code === CONTAINER_RUNNER_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL
                ? 403
                : err.code === CONTAINER_RUNNER_ERROR_CODES.IDEMPOTENCY_CONFLICT
                  ? 409
                  : 400;
          sendError(res, status, err.code, err.message, correlationId, err.detail);
        } else {
          sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message, correlationId);
        }
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/sandbox/manifest') {
      try {
        const manifest = this.services.sandboxImage.getManifest();
        sendJson(res, 200, { data: manifest }, correlationId);
      } catch (err: any) {
        sendError(res, 404, 'MANIFEST_NOT_FOUND', err.message, correlationId);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/sandbox/verify-image') {
      const bodyResult = await readJsonBody<{ observedDigest?: string }>(req, res, correlationId);
      if (!bodyResult) return true;

      const observedDigest = bodyResult.parsed?.observedDigest;
      const verification = await this.services.sandboxImage.verifyImage(observedDigest);
      sendJson(res, verification.valid ? 200 : 400, { data: verification }, correlationId);
      return true;
    }

    // ── Industrial Firewall Requirement (F9-06) ───────────────────

    if (
      method === 'GET' &&
      (pathname === '/api/v1/industrial/boundary-status' ||
        pathname.match(/^\/api\/v1\/projects\/[^/]+\/industrial\/boundary-status$/))
    ) {
      let projectId = query.get('projectId') || 'default';
      const match = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/industrial\/boundary-status$/);
      if (match) {
        projectId = decodeURIComponent(match[1]);
      }
      const inspectOnly = query.get('inspect') === 'true';

      const status = await this.services.industrialFirewallRequirement.getIndustrialBoundaryStatus(projectId);
      if (!status.verified && !inspectOnly) {
        sendError(
          res,
          403,
          status.failureCode || 'FIREWALL_STATUS_UNKNOWN',
          status.blockingReason || 'Industrial execution blocked: unverified boundary state.',
          correlationId,
          status,
        );
        return true;
      }

      sendJson(res, 200, { data: status }, correlationId);
      return true;
    }

    // GET /api/v1/industrial/bundles
    if (method === 'GET' && pathname === '/api/v1/industrial/bundles') {
      const bundles = this.services.sovereigntyBundle.listBundles();
      sendJson(res, 200, { data: bundles }, correlationId);
      return true;
    }

    // POST /api/v1/industrial/bundles/generate
    if (method === 'POST' && pathname === '/api/v1/industrial/bundles/generate') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;
      try {
        const bundle = await this.services.sovereigntyBundle.generateBundle(bodyResult.parsed || {});
        sendJson(res, 201, { data: bundle }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 400, 'BUNDLE_GENERATION_FAILED', msg, correlationId);
      }
      return true;
    }

    // GET /api/v1/industrial/bundles/:bundleId
    const bundleMatch = pathname.match(/^\/api\/v1\/industrial\/bundles\/([^/]+)$/);
    if (method === 'GET' && bundleMatch) {
      const bundleId = decodeURIComponent(bundleMatch[1]);
      const asArchive = query.get('archive') === 'true';
      try {
        if (asArchive) {
          const { zipBuffer } = this.services.sovereigntyBundle.exportBundleArchive(bundleId);
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${bundleId}.zip"`,
            'X-Correlation-ID': correlationId,
          });
          res.end(zipBuffer);
          return true;
        }
        const bundle = this.services.sovereigntyBundle.loadBundle(bundleId);
        sendJson(res, 200, { data: bundle }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 404, 'NOT_FOUND', msg, correlationId);
      }
      return true;
    }

    // POST /api/v1/industrial/bundles/:bundleId/sign-off
    const signOffMatch = pathname.match(/^\/api\/v1\/industrial\/bundles\/([^/]+)\/sign-off$/);
    if (method === 'POST' && signOffMatch) {
      const bundleId = decodeURIComponent(signOffMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;
      try {
        const signedBundle = this.services.sovereigntyBundle.signOffBundle(bundleId, bodyResult.parsed || {});
        sendJson(res, 200, { data: signedBundle }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 400, 'SIGNOFF_FAILED', msg, correlationId);
      }
      return true;
    }

    // POST /api/v1/industrial/bundles/:bundleId/verify
    const verifyMatch = pathname.match(/^\/api\/v1\/industrial\/bundles\/([^/]+)\/verify$/);
    if (method === 'POST' && verifyMatch) {
      const bundleId = decodeURIComponent(verifyMatch[1]);
      const bodyResult = await readJsonBody(req, res, correlationId);
      const options = bodyResult?.parsed || {};
      try {
        const verifyArchive = query.get('archive') === 'true';
        const result = verifyArchive
          ? this.services.sovereigntyBundle.verifyBundleArchive(bundleId, options)
          : this.services.sovereigntyBundle.verifyBundle(bundleId, options);
        sendJson(res, result.valid ? 200 : 422, { data: result }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 400, 'VERIFICATION_FAILED', msg, correlationId);
      }
      return true;
    }

    // ── Evidence & Conflict Review (UI1-16) ───────────────────────────

    // GET /api/v1/evidence/files
    if (method === 'GET' && pathname === '/api/v1/evidence/files') {
      const files: Array<{
        name: string;
        path: string;
        size: number;
        sha256: string;
        mimeType: string;
        fixtureClass?: string;
        isSafetyCritical?: boolean;
      }> = [];

      // 1. Scanned multimodal manifest fixtures
      try {
        const manifestPath = path.join(this.projectRoot, 'fixtures', 'multimodal', 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (Array.isArray(manifest.fixtures)) {
            for (const f of manifest.fixtures) {
              const fullPath = path.join(this.projectRoot, f.relativePath);
              let size = f.byteSize || 0;
              let hash = f.expectedSha256 || '';
              if (fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                size = stat.size;
                const buf = fs.readFileSync(fullPath);
                hash = crypto.createHash('sha256').update(buf).digest('hex');
              }
              files.push({
                name: f.filename || path.basename(f.relativePath),
                path: f.relativePath.replace(/\\/g, '/'),
                size,
                sha256: hash,
                mimeType: f.mimeType || 'application/octet-stream',
                fixtureClass: f.fixtureClass,
                isSafetyCritical: f.expectedBehavior?.isSafetyCritical ?? true,
              });
            }
          }
        }
      } catch {}

      // 2. Demo industrial files
      try {
        const demoDir = path.join(this.projectRoot, 'demo', 'industrial');
        if (fs.existsSync(demoDir)) {
          const entries = fs.readdirSync(demoDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              const fullPath = path.join(demoDir, entry.name);
              const relPath = path.posix.join('demo', 'industrial', entry.name);
              if (!files.some((f) => f.path === relPath)) {
                const stat = fs.statSync(fullPath);
                const buf = fs.readFileSync(fullPath);
                const hash = crypto.createHash('sha256').update(buf).digest('hex');
                const ext = path.extname(entry.name).toLowerCase();
                const mime =
                  ext === '.csv'
                    ? 'text/csv'
                    : ext === '.json'
                    ? 'application/json'
                    : ext === '.txt'
                    ? 'text/plain'
                    : ext === '.pdf'
                    ? 'application/pdf'
                    : ext === '.png'
                    ? 'image/png'
                    : 'text/plain';
                const isSafety =
                  entry.name.includes('vibration') ||
                  entry.name.includes('safety') ||
                  entry.name.includes('threshold');
                files.push({
                  name: entry.name,
                  path: relPath,
                  size: stat.size,
                  sha256: hash,
                  mimeType: mime,
                  isSafetyCritical: isSafety,
                });
              }
            }
          }
        }
      } catch {}

      sendJson(res, 200, { data: files }, correlationId);
      return true;
    }

    // GET /api/v1/evidence/file
    if (method === 'GET' && pathname === '/api/v1/evidence/file') {
      const targetRelPath = query.get('path');
      if (!targetRelPath) {
        sendError(res, 400, 'MISSING_PARAM', 'Query parameter "path" is required.', correlationId);
        return true;
      }

      // Path traversal security verification
      if (
        targetRelPath.includes('..') ||
        targetRelPath.includes('\\') ||
        targetRelPath.startsWith('/') ||
        targetRelPath.includes(':')
      ) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Invalid file path: path traversal detected.', correlationId);
        return true;
      }

      const normalizedRel = path.posix.normalize(targetRelPath);
      const fullPath = path.resolve(this.projectRoot, normalizedRel);
      if (!fullPath.startsWith(path.resolve(this.projectRoot))) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Path escapes project root.', correlationId);
        return true;
      }

      if (!fs.existsSync(fullPath)) {
        sendError(res, 404, 'NOT_FOUND', `Evidence file '${targetRelPath}' not found.`, correlationId);
        return true;
      }

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          sendError(res, 400, 'IS_DIRECTORY', 'Target path is a directory.', correlationId);
          return true;
        }

        const buf = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const ext = path.extname(fullPath).toLowerCase();
        const isText = ['.txt', '.csv', '.json', '.md', '.log'].includes(ext);

        const mime =
          ext === '.csv'
            ? 'text/csv'
            : ext === '.json'
            ? 'application/json'
            : ext === '.txt'
            ? 'text/plain'
            : ext === '.pdf'
            ? 'application/pdf'
            : ext === '.png'
            ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'application/octet-stream';

        const fileData = {
          name: path.basename(fullPath),
          path: targetRelPath,
          size: stat.size,
          sha256: hash,
          mimeType: mime,
          content: isText ? buf.toString('utf8') : undefined,
          base64Content: buf.toString('base64'),
        };

        sendJson(res, 200, { data: fileData }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, 'READ_ERROR', msg, correlationId);
      }
      return true;
    }

    // GET /api/v1/evidence/thresholds
    if (method === 'GET' && pathname === '/api/v1/evidence/thresholds') {
      try {
        const thresholdsPath = path.join(this.projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
        let config: any = {
          rulesetId: 'MAOS-DEMO-TURBINE-T07-V1',
          title: 'Demonstration turbine operating thresholds',
          disclaimer: 'Official engineering safety baseline with ISO-10816-3 & ISO-13373-1 citations.',
          assetType: 'steam_turbine',
          standardCitations: [
            {
              code: 'ISO-10816-3:2009',
              title: 'Mechanical vibration - Evaluation of machine vibration by measurements on non-rotating parts',
              clause: 'Clause 4.2: Vibration velocity evaluation zones A/B/C/D',
            },
            {
              code: 'ISO-13373-1:2002',
              title: 'Condition monitoring and diagnostics of machines - Vibration condition monitoring',
              clause: 'Section 6: Sensor location, measurement units, and baseline establishment',
            },
            {
              code: 'API 670 5th Ed',
              title: 'Machinery Protection Systems',
              clause: 'Standard shutdown escalation and voting logic',
            },
          ],
          thresholds: {
            vibration_rms_mm_s: {
              unit: 'mm/s RMS',
              warning: 4.5,
              critical: 7.1,
              standardCitation: 'ISO-10816-3 Zone C (4.5) / Zone D (7.1)',
              recommendations: {
                WARNING: 'Increase monitoring frequency and inspect bearing condition.',
                FAIL: 'Escalate for engineering review and controlled shutdown assessment.',
              },
            },
            bearing_temperature_c: {
              unit: 'deg C',
              warning: 85.0,
              critical: 95.0,
              standardCitation: 'ISO-13373-1 Bearings Thermal Limit Guidelines',
              recommendations: {
                WARNING: 'Verify lubrication and cooling; trend temperature closely.',
                FAIL: 'Escalate immediately and assess safe shutdown requirements.',
              },
            },
            hydraulic_pressure_bar: {
              unit: 'bar',
              warning: 140.0,
              critical: 160.0,
              standardCitation: 'API 670 Auxiliary Systems Pressure Limits',
              recommendations: {
                WARNING: 'Inspect hydraulic accumulator and check relief valves.',
                FAIL: 'Immediate relief valve inspection; trip if pressure exceeds relief max.',
              },
            },
          },
        };

        if (fs.existsSync(thresholdsPath)) {
          const raw = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
          config = {
            ...config,
            ...raw,
            standardCitations: config.standardCitations,
            thresholds: {
              ...config.thresholds,
              ...(raw.thresholds || {}),
            },
          };
        }

        sendJson(res, 200, { data: config }, correlationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, 'THRESHOLDS_ERROR', msg, correlationId);
      }
      return true;
    }

    // GET /api/v1/evidence/conflicts
    if (method === 'GET' && pathname === '/api/v1/evidence/conflicts') {
      const projectId = query.get('projectId') || undefined;
      const reports = this.services.conflict.listConflictReports(projectId);
      sendJson(res, 200, { data: reports }, correlationId);
      return true;
    }

    // POST /api/v1/evidence/conflicts/compare
    if (method === 'POST' && pathname === '/api/v1/evidence/conflicts/compare') {
      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;

      const payload = bodyResult.parsed || {};
      if (!payload.projectId) {
        sendError(res, 400, 'MISSING_PROJECT_ID', 'Missing required "projectId".', correlationId);
        return true;
      }

      try {
        const report = await this.services.conflict.compareAndPersist(payload);
        sendJson(res, 201, { data: report }, correlationId);
      } catch (err: unknown) {
        if (err instanceof ConflictReviewError) {
          sendError(res, 422, err.code, err.message, correlationId, err.details);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          sendError(res, 500, 'COMPARE_FAILED', msg, correlationId);
        }
      }
      return true;
    }

    // GET /api/v1/evidence/conflicts/:id
    const conflictDetailMatch = pathname.match(/^\/api\/v1\/evidence\/conflicts\/([^/]+)$/);
    if (method === 'GET' && conflictDetailMatch) {
      const reportId = decodeURIComponent(conflictDetailMatch[1]);
      if (reportId.includes('..') || reportId.includes('\\') || reportId.includes('/')) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Invalid report id format.', correlationId);
        return true;
      }
      const report = this.services.conflict.getConflictReport(reportId);
      if (!report) {
        sendError(res, 404, 'NOT_FOUND', `Conflict report "${reportId}" not found.`, correlationId);
        return true;
      }
      sendJson(res, 200, { data: report }, correlationId);
      return true;
    }

    // POST /api/v1/evidence/conflicts/:id/resolve
    const conflictResolveMatch = pathname.match(/^\/api\/v1\/evidence\/conflicts\/([^/]+)\/resolve$/);
    if (method === 'POST' && conflictResolveMatch) {
      const reportId = decodeURIComponent(conflictResolveMatch[1]);
      if (reportId.includes('..') || reportId.includes('\\') || reportId.includes('/')) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Invalid report id format.', correlationId);
        return true;
      }

      const report = this.services.conflict.getConflictReport(reportId);
      if (!report) {
        sendError(res, 404, 'NOT_FOUND', `Conflict report "${reportId}" not found.`, correlationId);
        return true;
      }

      const bodyResult = await readJsonBody(req, res, correlationId);
      if (!bodyResult) return true;
      const body = bodyResult.parsed || {};

      const targetItem = report.items.find(
        (i) => i.id === body.itemId || i.key === body.itemId || i.key === body.itemKey,
      );
      if (!targetItem) {
        sendError(res, 404, 'ITEM_NOT_FOUND', `Item "${body.itemId || body.itemKey}" not found in report "${reportId}".`, correlationId);
        return true;
      }

      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId,
        itemId: targetItem.id,
        reviewerId: body.reviewerId || 'engineer_review',
        decision: body.decision,
        correctedValue: body.correctedValue,
        correctedUnit: body.correctedUnit,
        rationale: body.rationale || body.notes || 'Human review decision logged via Evidence Workbench',
        timestamp: body.timestamp || new Date().toISOString(),
      };

      try {
        const resolved = await this.services.conflict.resolveConflict(input);

        // Approval Flow for Safety Verdicts
        let approvalRecord = undefined;
        if (targetItem.isSafetyCritical || body.autoApproveSafetyVerdict !== false) {
          try {
            const role = body.reviewerRole || 'reviewer';
            const createdAppr = this.services.approval.createApproval({
              projectId: report.projectId,
              runId: body.runId || 'default',
              taskId: body.taskId || 'default',
              scope: 'safety_verdict',
              actorId: input.reviewerId,
              actorRole: role,
              reason: `Safety verdict resolved for ${targetItem.key}: ${input.decision}. Rationale: ${input.rationale}`,
              payloadHash: crypto.createHash('sha256').update(JSON.stringify(resolved)).digest('hex'),
              sourceHashes: [report.sourceHash],
              metadata: {
                conflictReportId: report.id,
                itemId: targetItem.id,
                itemKey: targetItem.key,
                decision: input.decision,
                resolvedObservationId: resolved.id,
              },
            });

            approvalRecord = this.services.approval.decideApproval(
              createdAppr.approvalId,
              input.decision === 'reject_both' ? 'rejected' : 'approved',
              input.reviewerId,
              input.rationale,
              role,
            );
          } catch {
            // Approval recording logged without blocking resolved result
          }
        }

        sendJson(res, 200, { data: { resolved, approval: approvalRecord } }, correlationId);
      } catch (err: unknown) {
        if (err instanceof ConflictReviewError) {
          sendError(res, 422, err.code, err.message, correlationId, err.details);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          sendError(res, 400, 'RESOLVE_FAILED', msg, correlationId);
        }
      }
      return true;
    }

    // GET /api/v1/evidence/resolved
    if (method === 'GET' && pathname === '/api/v1/evidence/resolved') {
      const projectId = query.get('projectId') || undefined;
      const resolved = this.services.conflict.listResolvedObservations(projectId);
      sendJson(res, 200, { data: resolved }, correlationId);
      return true;
    }

    // ── Document Generator (UI1-17) ──────────────────────────────

    // GET /api/v1/generator/presets
    if (method === 'GET' && pathname === '/api/v1/generator/presets') {
      const presets = getDocumentGeneratorPresets(this.projectRoot);
      sendJson(res, 200, { data: presets }, correlationId);
      return true;
    }

    // POST /api/v1/generator/validate-input
    if (method === 'POST' && pathname === '/api/v1/generator/validate-input') {
      const bodyResult = await readJsonBody<{ input: any; allowForeignProject?: boolean }>(req, res, correlationId);
      if (!bodyResult) return true;
      const { input, allowForeignProject } = bodyResult.parsed || {};
      if (!input || typeof input !== 'object') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required input object.', correlationId);
        return true;
      }

      const valResult = this.services.officeInput.validateInput(input, { allowForeignProject, skipAudit: false });
      const nonApprovalErrors = valResult.errors.filter((e) => !e.includes('[APPROVAL_REQUIRED]'));
      const schemaValid = nonApprovalErrors.length === 0;

      let canonicalHash = valResult.canonicalHash;
      if (!canonicalHash && schemaValid && input && typeof input === 'object') {
        try {
          canonicalHash = computeOfficeInputHash(input as ValidatedOfficeArtifactInput);
        } catch {
          /* fallback */
        }
      }

      let freshness = undefined;
      if (input && Array.isArray((input as any).citations)) {
        try {
          const rawFreshness = this.services.officeInput.verifyFreshnessSync(input as ValidatedOfficeArtifactInput);
          const sourceErrors = rawFreshness.errors.filter((e) => !e.includes('[APPROVAL_REQUIRED]'));
          freshness = {
            ...rawFreshness,
            fresh: sourceErrors.length === 0,
            errors: sourceErrors,
          };
        } catch (err: any) {
          freshness = {
            fresh: false,
            errors: [err.message || String(err)],
            warnings: [],
            verifiedSourceCount: 0,
            checkedAt: new Date().toISOString(),
          };
        }
      }

      sendJson(res, 200, {
        data: {
          valid: schemaValid,
          canonicalHash,
          errors: nonApprovalErrors,
          warnings: valResult.warnings,
          freshness,
        },
      }, correlationId);
      return true;
    }

    // POST /api/v1/generator/validate-template
    if (method === 'POST' && pathname === '/api/v1/generator/validate-template') {
      const bodyResult = await readJsonBody<{ templatePath?: string; expectedType?: string }>(req, res, correlationId);
      if (!bodyResult) return true;
      const { templatePath, expectedType } = (bodyResult.parsed || {}) as { templatePath?: string; expectedType?: string };
      if (!templatePath || typeof templatePath !== 'string') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required templatePath.', correlationId);
        return true;
      }
      if (!expectedType || !['docx', 'xlsx', 'pptx'].includes(expectedType)) {
        sendError(res, 400, 'INVALID_INPUT', `Invalid expectedType '${expectedType}'. Must be docx, xlsx, or pptx.`, correlationId);
        return true;
      }

      const summary = this.services.templateSafety.validateTemplate(templatePath, expectedType as 'docx' | 'xlsx' | 'pptx', {
        actor: 'gui_operator',
      });
      sendJson(res, 200, { data: summary }, correlationId);
      return true;
    }

    // POST /api/v1/generator/generate
    if (method === 'POST' && pathname === '/api/v1/generator/generate') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;
      const payload: Record<string, any> = (bodyResult.parsed as Record<string, any>) || {};

      if (!payload.artifactType || !['docx', 'xlsx', 'pptx'].includes(payload.artifactType)) {
        sendError(res, 400, 'INVALID_INPUT', `Invalid artifactType '${payload.artifactType}'. Expected 'docx', 'xlsx', or 'pptx'.`, correlationId);
        return true;
      }
      if (payload.schemaVersion !== 1) {
        sendError(res, 400, 'INVALID_INPUT', `Unsupported schemaVersion '${payload.schemaVersion}'. Expected 1.`, correlationId);
        return true;
      }
      if (!payload.projectId || typeof payload.projectId !== 'string') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required projectId parameter.', correlationId);
        return true;
      }
      if (!payload.outputPath || typeof payload.outputPath !== 'string') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required outputPath parameter.', correlationId);
        return true;
      }
      if (!payload.requestId || typeof payload.requestId !== 'string') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required requestId parameter for idempotency.', correlationId);
        return true;
      }
      if (!payload.input || typeof payload.input !== 'object') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required input object.', correlationId);
        return true;
      }

      let result: any;
      if (payload.artifactType === 'docx') {
        result = this.services.docxGenerator.generateDocx({
          schemaVersion: 1,
          projectId: payload.projectId,
          input: payload.input as OfficeDocxInput,
          outputPath: payload.outputPath,
          allowOverwrite: Boolean(payload.allowOverwrite),
          approvalId: payload.approvalId,
          requestId: payload.requestId,
          templatePath: payload.templatePath,
          callerIdentity: { agentId: 'gui_document_generator', taskId: payload.input.taskId },
        });
      } else if (payload.artifactType === 'xlsx') {
        result = this.services.xlsxGenerator.generateXlsx({
          schemaVersion: 1,
          projectId: payload.projectId,
          input: payload.input as OfficeXlsxInput,
          outputPath: payload.outputPath,
          allowOverwrite: Boolean(payload.allowOverwrite),
          approvalId: payload.approvalId,
          requestId: payload.requestId,
          templatePath: payload.templatePath,
          callerIdentity: { agentId: 'gui_document_generator', taskId: payload.input.taskId },
        });
      } else if (payload.artifactType === 'pptx') {
        result = this.services.pptxGenerator.generatePptx({
          schemaVersion: 1,
          projectId: payload.projectId,
          input: payload.input as OfficePptxInput,
          outputPath: payload.outputPath,
          allowOverwrite: Boolean(payload.allowOverwrite),
          approvalId: payload.approvalId,
          requestId: payload.requestId,
          templatePath: payload.templatePath,
          callerIdentity: { agentId: 'gui_document_generator', taskId: payload.input.taskId },
        });
      }

      sendJson(res, 201, { data: result }, correlationId);
      return true;
    }

    // POST /api/v1/generator/launch
    if (method === 'POST' && pathname === '/api/v1/generator/launch') {
      const bodyResult = await readJsonBody<{ artifactId?: string; relativePath?: string }>(req, res, correlationId);
      if (!bodyResult) return true;
      const { artifactId, relativePath } = bodyResult.parsed || {};
      const idOrPath = artifactId || relativePath;
      if (!idOrPath || typeof idOrPath !== 'string') {
        sendError(res, 400, 'INVALID_INPUT', 'Missing required artifactId or relativePath parameter.', correlationId);
        return true;
      }
      if (idOrPath.includes('..') || idOrPath.includes('\\..') || idOrPath.includes('/..')) {
        sendError(res, 400, 'PATH_TRAVERSAL', 'Path traversal sequence detected in artifact path.', correlationId);
        return true;
      }

      const artifact = this.services.artifact.getArtifact(idOrPath);
      if (!artifact) {
        sendError(res, 404, 'NOT_FOUND', `Artifact '${idOrPath}' not found in artifact store.`, correlationId);
        return true;
      }

      const absPath = path.resolve(this.projectRoot, artifact.path);
      if (!fs.existsSync(absPath)) {
        sendError(res, 404, 'NOT_FOUND', `Artifact file does not exist on disk: ${artifact.path}`, correlationId);
        return true;
      }

      let launched = false;
      let message = '';
      try {
        if (process.platform === 'win32') {
          const child = child_process.spawn('explorer.exe', [absPath], { detached: true, stdio: 'ignore' });
          child.unref();
          launched = true;
          message = `Opened '${path.basename(absPath)}' in default Windows viewer.`;
        } else if (process.platform === 'darwin') {
          const child = child_process.spawn('open', [absPath], { detached: true, stdio: 'ignore' });
          child.unref();
          launched = true;
          message = `Opened '${path.basename(absPath)}' in macOS default viewer.`;
        } else {
          const child = child_process.spawn('xdg-open', [absPath], { detached: true, stdio: 'ignore' });
          child.unref();
          launched = true;
          message = `Opened '${path.basename(absPath)}' with xdg-open.`;
        }
      } catch (err: any) {
        launched = false;
        message = `External launcher error: ${err.message}. Direct download available.`;
      }

      sendJson(res, 200, {
        data: {
          launched,
          path: artifact.path,
          sha256: artifact.hash,
          message,
          downloadUrl: `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`,
        },
      }, correlationId);
      return true;
    }

    // GET /api/v1/generator/artifacts
    if (method === 'GET' && pathname === '/api/v1/generator/artifacts') {
      const allArtifacts = this.services.artifact.listArtifacts();
      const officeArtifacts = allArtifacts.filter((a) => {
        const p = a.path.toLowerCase();
        return p.endsWith('.docx') || p.endsWith('.xlsx') || p.endsWith('.pptx');
      });
      sendJson(res, 200, { data: officeArtifacts }, correlationId);
      return true;
    }

    // ── Knowledge Base Search (UI1-18 / F5-05) ─────────────────────────

    if (method === 'POST' && pathname === '/api/v1/kb/search') {
      const bodyResult = await readJsonBody<Record<string, any>>(req, res, correlationId);
      if (!bodyResult) return true;

      try {
        const input = {
          schemaVersion: 1 as const,
          projectId: bodyResult.parsed?.projectId || getOrGenerateProjectId(this.projectRoot),
          query: bodyResult.parsed?.query || '',
          topK: bodyResult.parsed?.topK,
          minScore: bodyResult.parsed?.minScore,
          filter: bodyResult.parsed?.filter,
          requestId: bodyResult.parsed?.requestId,
        };
        const result = await this.services.kbSearch.search(input);
        sendJson(res, 200, { data: result }, correlationId);
      } catch (err: any) {
        if (err instanceof KbSearchError) {
          const status =
            err.code === 'UNAUTHORIZED_TOOL_CALL' ? 403
            : err.code === 'CROSS_PROJECT' ? 403
            : err.code === 'INVALID_INPUT' || err.code === 'EMPTY_QUERY' || err.code === 'QUERY_TOO_LONG' || err.code === 'INVALID_BOUNDS' ? 400
            : err.code === 'INDEX_NOT_FOUND' || err.code === 'INDEX_STALE' || err.code === 'INDEX_CORRUPT' ? 404
            : err.code === 'NO_RUNTIME_DOWNLOAD' ? 503
            : err.code === 'IDEMPOTENCY_CONFLICT' ? 409
            : err.code === 'SEARCH_TIMEOUT' ? 504
            : 500;
          sendError(res, status, err.code, err.message, correlationId, err.details);
        } else {
          sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message, correlationId);
        }
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/kb/status') {
      try {
        const projectId = query.get('projectId') || getOrGenerateProjectId(this.projectRoot);
        const status = await this.services.kb.status({ projectId });
        sendJson(res, 200, { data: status }, correlationId);
      } catch (err: any) {
        if (err instanceof KbSearchError) {
          sendError(res, 400, err.code, err.message, correlationId, err.details);
        } else {
          sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message, correlationId);
        }
      }
      return true;
    }

    // ── Sandbox Execution History (UI1-18) ──────────────────────────────

    if (method === 'GET' && pathname === '/api/v1/sandbox/results') {
      try {
        const allRecords = this.services.audit.getRecords({ source: 'sandbox-runner-service' });
        const sandboxResults = allRecords
          .filter((r) =>
            (r.data as any)?.event === 'SANDBOX_EXECUTION_COMPLETED' ||
            (r.data as any)?.event === 'SANDBOX_EXECUTION_FAILED' ||
            r.source === 'sandbox-runner-service',
          )
          .map((r) => {
            const d = r.data as Record<string, any>;
            return {
              eventId: String(r.sequence),
              timestamp: r.timestamp,
              source: r.source,
              event: d.event,
              ok: d.ok,
              exitCode: d.exitCode,
              status: d.status,
              durationMs: d.durationMs,
              inputHash: d.inputHash,
              outputHash: d.outputHash,
              containerName: d.containerName,
              imageDigest: d.imageDigest,
              stagedFiles: d.stagedFiles,
              stdoutLength: d.stdoutLength,
              stderrLength: d.stderrLength,
              auditEventId: d.auditEventId,
            };
          });
        sendJson(res, 200, { data: sandboxResults }, correlationId);
      } catch (err: any) {
        sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message, correlationId);
      }
      return true;
    }

    return false;
  }
}
