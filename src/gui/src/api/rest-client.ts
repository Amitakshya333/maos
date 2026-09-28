/**
 * UI1-02: Browser-Safe Typed REST Client
 *
 * Consumes the versioned /api/v1 REST endpoints over local loopback.
 * Features:
 *   - Automatic X-Project-Root, X-Correlation-ID, and Idempotency-Key headers
 *   - AbortController timeout and request cancellation
 *   - Idempotent-Replay detection
 *   - Standard error envelope mapping to typed error classes
 *   - Runtime response schema validation
 */

import { mapHttpError, NetworkError, TimeoutError, ApiError, ForbiddenLoopbackError } from './errors';
import {
  validateEnvelope,
  validateTask,
  validateTasksList,
  validateRun,
  validateRunsList,
  validateModelLease,
  validateModelLeasesList,
  validateModelResidencyStatus,
  validateAuditRecord,
  validateAuditRecordsList,
  validateHealthResponse,
  validateConversation,
  validateConversationsList,
  validateMessage,
  validateQueueEntry,
  validateQueueEntriesList,
  validateQueueStatusSummary,
  validateActiveModelIdentity,
  validateModelRouteResult,
  validateModelSwitchResult,
  validateApprovalRecord,
  validateApprovalsList,
  validateApprovalCheckResult,
  validateForceStopResult,
  validateCockpitState,
  validateCockpitRunsList,
} from './runtime-validation';
import type { CockpitState, CockpitRunSummary, WorkflowProjection, WorkflowRunProjection } from '../../../domain/cockpit';
export type { WorkflowProjection, WorkflowRunProjection };
import type {
  ApprovalRecord,
  CreateApprovalInput,
  ReviewApprovalInput,
  ApprovalValidationContext,
  ApprovalCheckResult,
  ForceStopParams,
  ForceStopResult,
} from '../../../domain/approval';
import type {
  ChatAttachment,
  PromoteToTaskInput,
  PromoteToTaskResult,
  ProjectFileInfo,
} from '../../../domain/conversation';
import type { IndustrialBoundaryStatus } from '../../../domain/industrial-firewall-requirement';
import type {
  Task,
  Run,
  WorkflowStage,
  ModelLease,
  AuditRecord,
  AuditChainVerification,
  Approval,
  Artifact,
  Conversation,
  Message,
  Project,
  RunVerificationResult,
  ArtifactVerificationResult,
  ModelVerificationResult,
  SequencedEvent,
} from '../../../domain/schemas';
import type {
  ModelRegistration,
  ModelResidencyStatus,
  AcquireModelLeaseInput,
  RenewModelLeaseInput,
} from '../../../domain/model-manifest';
import type { WorkspaceLayout } from '../../../domain/layout';
import type { BasicSettings } from '../../../domain/settings';
import type { TelemetryAnalysisReceipt } from '../../../industrial/telemetry-analysis';
import type {
  OperationalMode,
  PurgeOptions,
  PurgeResult,
  RetentionStatus,
  EvidenceValidationResult,
  CitedClaim,
} from '../../../domain/evidence-mode';
import type {
  QueueEntry,
  QueueStatusSummary,
  EnqueueRequestInput,
  CancelQueueEntryInput,
} from '../../../domain/fair-queue';
import type {
  ModelRouteRequest,
  ModelRouteResult,
  ModelSwitchRequest,
  ModelSwitchResult,
  ActiveModelIdentity,
} from '../../../domain/model-switch';
import type {
  ComparableObservation,
  ConflictItem,
  ConflictReport,
  ConflictReportSummary,
  ConflictResolutionDecision,
  HumanReviewInput,
  ResolvedObservation,
  ClassifyConflictOptions,
} from '../../../domain/conflict';

export interface RestClientOptions {
  baseUrl?: string;
  projectRoot?: string;
  sessionToken?: string;
  defaultTimeoutMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  correlationId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JudgedRunResponse {
  runId: string;
  status: 'pending_approval' | 'rejected' | 'completed' | 'failed';
  verdict: 'PASS' | 'WARNING' | 'FAIL';
  message?: string;
  approvalId?: string;
  deliverablePath?: string;
  deliverableSha256?: string;
  auditExportPath?: string;
  auditExportSha256?: string;
  details?: Record<string, unknown>;
}

export type IndustrialTelemetryAnalysisResponse = TelemetryAnalysisReceipt & {
  receiptPath: string;
  receiptSha256: string;
};

/** In-memory session handoff returned by the trusted launcher IPC channel. */
export interface LauncherSessionBootstrap {
  sessionToken: string;
  sessionId: string;
  windowId: string;
  serviceInstanceId: string;
  projectRootHash: string;
  servicePort: number;
  expiresAt: number;
  protocolVersion: string;
}

export interface RestResponse<T> {
  data: T;
  isReplay: boolean;
  correlationId?: string;
  status: number;
}

export class BrowserRestClient {
  private readonly baseUrl: string;
  private readonly projectRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetch: typeof fetch;
  private sessionToken?: string;

  constructor(options: RestClientOptions = {}) {
    this.baseUrl = (options.baseUrl || 'http://127.0.0.1:3847').replace(/\/+$/, '');
    this.projectRoot = options.projectRoot || 'C:\\maos';
    this.sessionToken = options.sessionToken;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? options.timeoutMs ?? 10_000;
    this.fetch = options.fetchFn || (options as any).customFetch || globalThis.fetch.bind(globalThis);

    // Enforce local loopback binding only
    try {
      const url = new URL(this.baseUrl);
      const host = url.hostname.toLowerCase();
      const isLoopback =
        host === '127.0.0.1' ||
        host === 'localhost' ||
        host === '::1' ||
        host === '[::1]' ||
        host.endsWith('.localhost');
      if (!isLoopback) {
        throw new ForbiddenLoopbackError(
          `Non-loopback URL '${this.baseUrl}' rejected: GUI client must only bind to local loopback`,
        );
      }
    } catch (err: any) {
      if (err instanceof ForbiddenLoopbackError) throw err;
      throw new ForbiddenLoopbackError(
        `Invalid loopback URL '${this.baseUrl}': ${err?.message || String(err)}`,
      );
    }
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setSessionToken(token?: string): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | undefined {
    return this.sessionToken;
  }

  /**
   * Install a launcher-issued session in memory. The initial credential must
   * arrive through the trusted launcher bridge, never from a public HTTP
   * handshake or URL.
   */
  initializeFromLauncher(session: LauncherSessionBootstrap): void {
    if (!session || !/^[0-9a-f]{64}$/i.test(session.sessionToken)) {
      throw new Error('INVALID_SESSION_BOOTSTRAP: Launcher session token is malformed.');
    }
    this.sessionToken = session.sessionToken;
  }

  /**
   * Internal HTTP execution helper with timeout, headers, and error handling.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<RestResponse<T>> {
    const correlationId =
      options.correlationId || `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Project-Root': this.projectRoot,
      'X-Correlation-ID': correlationId,
    };

    if (typeof window === 'undefined') {
      headers['Origin'] = this.baseUrl;
    }

    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['Idempotency-Key'] =
        options.idempotencyKey || `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const fullUrl = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    try {
      const response = await this.fetch(fullUrl, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const isReplay = response.headers.get('Idempotent-Replay') === 'true';

      let responseJson: unknown = null;
      const text = await response.text();
      if (text && text.trim()) {
        try {
          responseJson = JSON.parse(text);
        } catch {
          responseJson = { message: text };
        }
      }

      if (!response.ok) {
        throw mapHttpError(response.status, responseJson, correlationId);
      }

      const unpackedData = validateEnvelope<T>(responseJson, endpoint);

      return {
        data: unpackedData,
        isReplay,
        correlationId,
        status: response.status,
      };
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(`Request timed out after ${timeoutMs}ms for ${endpoint}`);
      }
      throw new NetworkError(
        `Failed to execute ${method} ${endpoint}: ${(err as Error)?.message || String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Health & System
  // ══════════════════════════════════════════════════════════════

  async getHealth(options?: RequestOptions): Promise<Record<string, unknown>> {
    const res = await this.request<Record<string, unknown>>('GET', '/api/v1/health', undefined, options);
    return validateHealthResponse(res.data);
  }

  async getOpenApiSpec(options?: RequestOptions): Promise<Record<string, unknown>> {
    const res = await this.request<Record<string, unknown>>('GET', '/api/v1/openapi.json', undefined, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Projects & Settings
  // ══════════════════════════════════════════════════════════════

  async getProject(options?: RequestOptions): Promise<Project> {
    const res = await this.request<Project>('GET', '/api/v1/project', undefined, options);
    return res.data;
  }

  async getSettings(options?: RequestOptions, projectId?: string): Promise<Record<string, unknown> & BasicSettings> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<Record<string, unknown> & BasicSettings>('GET', `/api/v1/settings${query}`, undefined, options);
    return res.data;
  }

  async getBasicSettings(projectId?: string, options?: RequestOptions): Promise<BasicSettings> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<BasicSettings>('GET', `/api/v1/settings${query}`, undefined, options);
    return res.data;
  }

  async updateSettings(patch: Record<string, unknown>, options?: RequestOptions, projectId?: string): Promise<Record<string, unknown> & BasicSettings> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<Record<string, unknown> & BasicSettings>('PATCH', `/api/v1/settings${query}`, patch, options);
    return res.data;
  }

  async updateBasicSettings(
    patch: Partial<BasicSettings> | Record<string, unknown>,
    options?: RequestOptions,
    projectId?: string,
  ): Promise<BasicSettings> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<BasicSettings>('PUT', `/api/v1/settings${query}`, patch, options);
    return res.data;
  }

  async resetSettings(projectId?: string, options?: RequestOptions): Promise<BasicSettings> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<BasicSettings>('POST', `/api/v1/settings/reset${query}`, {}, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Retention & Scoped Purge (UI1-10)
  // ══════════════════════════════════════════════════════════════

  async getRetentionStatus(projectId?: string, options?: RequestOptions): Promise<RetentionStatus> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<{ status: RetentionStatus } | RetentionStatus>('GET', `/api/v1/retention/status${query}`, undefined, options);
    const data = res.data as any;
    return data.status || data;
  }

  async executeRetentionPurge(
    purgeOptions: PurgeOptions,
    options?: RequestOptions,
  ): Promise<PurgeResult> {
    const res = await this.request<{ result: PurgeResult } | PurgeResult>('POST', '/api/v1/retention/purge', purgeOptions, options);
    const data = res.data as any;
    return data.result || data;
  }

  async validateClaim(
    claim: unknown,
    mode?: OperationalMode,
    options?: RequestOptions,
  ): Promise<EvidenceValidationResult> {
    const res = await this.request<EvidenceValidationResult>('POST', '/api/v1/mode/validate-claim', { claim, mode }, options);
    return res.data;
  }

  async stopService(
    payload: { mode: 'after-current-tasks' | 'force'; confirm?: boolean; reason?: string },
    options?: RequestOptions,
  ): Promise<{ status: string; mode: string; [key: string]: unknown }> {
    const res = await this.request<{ status: string; mode: string; [key: string]: unknown }>(
      'POST',
      '/api/v1/service/stop',
      payload,
      options,
    );
    return res.data;
  }

  async getServiceVisibility(options?: RequestOptions): Promise<Record<string, unknown>> {
    const res = await this.request<Record<string, unknown>>('GET', '/api/v1/service/visibility', undefined, options);
    return res.data;
  }

  async getServiceIdentity(options?: RequestOptions): Promise<ServiceIdentityResponse> {
    const res = await this.request<ServiceIdentityResponse>('GET', '/api/v1/service/identity', undefined, options);
    return res.data;
  }

  async getDiagnostics(options?: RequestOptions): Promise<DiagnosticResultRecord[]> {
    const res = await this.request<DiagnosticResultRecord[]>('GET', '/api/v1/health/diagnostics', undefined, options);
    return res.data;
  }

  async getServiceLifecycle(options?: RequestOptions): Promise<ServiceLifecycleResponse> {
    const res = await this.request<ServiceLifecycleResponse>('GET', '/api/v1/service/lifecycle', undefined, options);
    return res.data;
  }

  async cleanupOrphans(payload?: { maxAgeMs?: number }, options?: RequestOptions): Promise<OrphanCleanupResponse> {
    const res = await this.request<OrphanCleanupResponse>('POST', '/api/v1/service/orphan-cleanup', payload || {}, options);
    return res.data;
  }

  async sendKeepalive(payload?: { taskId?: string }, options?: RequestOptions): Promise<KeepaliveResponse> {
    const res = await this.request<KeepaliveResponse>('POST', '/api/v1/service/keepalive', payload || {}, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Workspace Layout & Role Presets (UI1-07)
  // ══════════════════════════════════════════════════════════════

  async getLayout(
    role?: string,
    options?: RequestOptions,
  ): Promise<{ layout: WorkspaceLayout; exists: boolean }> {
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    const res = await this.request<WorkspaceLayout>('GET', `/api/v1/layout${query}`, undefined, options);
    return { layout: res.data, exists: (res as any).exists ?? true };
  }

  async updateLayout(
    layout: WorkspaceLayout,
    options?: RequestOptions,
  ): Promise<WorkspaceLayout> {
    const res = await this.request<WorkspaceLayout>('PUT', '/api/v1/layout', layout, options);
    return res.data;
  }

  async resetLayout(
    role?: string,
    options?: RequestOptions,
  ): Promise<WorkspaceLayout> {
    const res = await this.request<WorkspaceLayout>('POST', '/api/v1/layout/reset', { role }, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Conversations & Task Promotion (UI1-09 & UI1-10)
  // ══════════════════════════════════════════════════════════════

  async getConversations(projectId?: string, options?: RequestOptions): Promise<Conversation[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<Conversation[]>('GET', `/api/v1/conversations${query}`, undefined, options);
    return validateConversationsList(res.data);
  }

  async getConversation(id: string, options?: RequestOptions): Promise<Conversation> {
    const res = await this.request<Conversation>('GET', `/api/v1/conversations/${encodeURIComponent(id)}`, undefined, options);
    return validateConversation(res.data);
  }

  async createConversation(
    data: { id?: string; projectId: string; agentId: string; taskId?: string; mode?: OperationalMode; pinned?: boolean },
    options?: RequestOptions,
  ): Promise<Conversation> {
    const res = await this.request<Conversation>('POST', '/api/v1/conversations', data, options);
    return validateConversation(res.data);
  }

  async updateConversationMode(
    conversationId: string,
    mode: OperationalMode,
    confirmed = false,
    options?: RequestOptions,
  ): Promise<Conversation> {
    const res = await this.request<Conversation>(
      'PATCH',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/mode`,
      { mode, confirmed },
      options,
    );
    return validateConversation(res.data);
  }

  async setConversationPinned(
    conversationId: string,
    pinned: boolean,
    options?: RequestOptions,
  ): Promise<Conversation> {
    const res = await this.request<Conversation>(
      'PATCH',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/pin`,
      { pinned },
      options,
    );
    return validateConversation(res.data);
  }

  async addMessage(
    conversationId: string,
    message: {
      role: Message['role'];
      content: string | null;
      name?: string;
      toolCallId?: string;
      toolCalls?: any[];
      tokenUsage?: any;
      attachments?: ChatAttachment[];
      mode?: OperationalMode;
      claims?: CitedClaim[];
      isModelGenerated?: boolean;
      verifiedAgainstData?: boolean;
    },
    options?: RequestOptions,
  ): Promise<Message> {
    const res = await this.request<Message>(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      message,
      options,
    );
    return validateMessage(res.data);
  }

  async chatCompletion(
    input: {
      conversationId: string;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    },
    options?: RequestOptions,
  ): Promise<{
    message: { role: 'assistant'; content: string };
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    model: string;
    deterministic: boolean;
  }> {
    const res = await this.request<{
      message: { role: 'assistant'; content: string };
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      model: string;
      deterministic: boolean;
    }>('POST', '/api/v1/chat/completions', input, options);
    return res.data;
  }

  async getChatHealth(options?: RequestOptions): Promise<{ available: boolean; status: string }> {
    const res = await this.request<{ available: boolean; status: string }>(
      'GET',
      '/api/v1/chat/health',
      undefined,
      options,
    );
    return res.data;
  }

  async promoteToTask(
    conversationId: string,
    data: PromoteToTaskInput,
    options?: RequestOptions,
  ): Promise<PromoteToTaskResult> {
    const res = await this.request<PromoteToTaskResult>(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/promote`,
      data,
      options,
    );
    return {
      task: validateTask(res.data.task),
      conversation: validateConversation(res.data.conversation),
    };
  }

  async getProjectFiles(subpath?: string, options?: RequestOptions): Promise<ProjectFileInfo[]> {
    const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
    const res = await this.request<ProjectFileInfo[]>('GET', `/api/v1/project/files${query}`, undefined, options);
    return res.data;
  }

  async analyzeIndustrialTelemetry(input: {
    name?: string;
    contentBase64?: string;
    useBundledSample?: boolean;
  }): Promise<IndustrialTelemetryAnalysisResponse> {
    const res = await this.request<IndustrialTelemetryAnalysisResponse>(
      'POST',
      '/api/industrial/telemetry/analyze',
      input,
      { timeoutMs: 30_000 },
    );
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Tasks
  // ══════════════════════════════════════════════════════════════

  async getTasks(status?: string, options?: RequestOptions): Promise<Task[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request<Task[]>('GET', `/api/v1/tasks${query}`, undefined, options);
    return validateTasksList(res.data);
  }

  async getTask(id: string, options?: RequestOptions): Promise<Task> {
    const res = await this.request<Task>('GET', `/api/v1/tasks/${encodeURIComponent(id)}`, undefined, options);
    return validateTask(res.data);
  }

  async createTask(
    data: { description: string; agent?: string; priority?: string; complexity?: string },
    options?: RequestOptions,
  ): Promise<Task> {
    const res = await this.request<Task>('POST', '/api/v1/tasks', data, options);
    return validateTask(res.data);
  }

  // ══════════════════════════════════════════════════════════════
  // Workflows & Runs
  // ══════════════════════════════════════════════════════════════

  async getRuns(workflowId?: string, options?: RequestOptions): Promise<Run[]> {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : '';
    const res = await this.request<Run[]>('GET', `/api/v1/workflows/runs${query}`, undefined, options);
    return validateRunsList(res.data);
  }

  async getRun(id: string, options?: RequestOptions): Promise<Run> {
    const res = await this.request<Run>('GET', `/api/v1/workflows/runs/${encodeURIComponent(id)}`, undefined, options);
    return validateRun(res.data);
  }

  async getRunStages(runId: string, options?: RequestOptions): Promise<WorkflowStage[]> {
    const res = await this.request<WorkflowStage[]>(
      'GET',
      `/api/v1/workflows/runs/${encodeURIComponent(runId)}/stages`,
      undefined,
      options,
    );
    return res.data;
  }

  async getWorkflowProjection(id: string, options?: RequestOptions): Promise<WorkflowProjection | WorkflowRunProjection> {
    const res = await this.request<WorkflowProjection | WorkflowRunProjection>(
      'GET',
      `/api/v1/workflows/${encodeURIComponent(id)}/projection`,
      undefined,
      options,
    );
    return res.data;
  }

  async getWorkflowRunProjection(runId: string, options?: RequestOptions): Promise<WorkflowRunProjection> {
    const res = await this.request<WorkflowRunProjection>(
      'GET',
      `/api/v1/cockpit/${encodeURIComponent(runId)}/projection`,
      undefined,
      options,
    );
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Models & Leases
  // ══════════════════════════════════════════════════════════════

  async getModels(options?: RequestOptions): Promise<{ models?: any[]; registeredModels?: ModelRegistration[] } | any[]> {
    const res = await this.request<{ models?: any[]; registeredModels?: ModelRegistration[] } | any[]>(
      'GET',
      '/api/v1/models',
      undefined,
      options,
    );
    return res.data;
  }

  async getModelResidencyStatus(options?: RequestOptions): Promise<ModelResidencyStatus> {
    const res = await this.request<ModelResidencyStatus>('GET', '/api/v1/models/residency', undefined, options);
    return validateModelResidencyStatus(res.data);
  }

  async getModelLeases(projectId?: string, options?: RequestOptions): Promise<ModelLease[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<ModelLease[]>('GET', `/api/v1/models/leases${query}`, undefined, options);
    return validateModelLeasesList(res.data);
  }

  async acquireModelLease(
    data: AcquireModelLeaseInput | { modelId: string; purpose?: string; runId?: string; agentId?: string; port?: number },
    options?: RequestOptions,
  ): Promise<ModelLease> {
    const payload: AcquireModelLeaseInput = {
      modelId: data.modelId,
      agentId: (data as any).agentId || 'gui_operator',
      port: (data as any).port,
      projectId: (data as any).projectId,
      runId: data.runId,
      priority: (data as any).priority,
      timeoutMs: (data as any).timeoutMs,
      expectedRevision: (data as any).expectedRevision,
      allowCpuFallback: (data as any).allowCpuFallback,
    };
    const res = await this.request<ModelLease>('POST', '/api/v1/models/leases', payload, options);
    return validateModelLease(res.data);
  }

  async renewModelLease(
    leaseId: string,
    extensionMs: number,
    scope?: { projectId?: string; runId?: string },
    options?: RequestOptions,
  ): Promise<ModelLease> {
    const res = await this.request<ModelLease>(
      'POST',
      `/api/v1/models/leases/${encodeURIComponent(leaseId)}/renew`,
      { extensionMs, ...scope },
      options,
    );
    return validateModelLease(res.data);
  }

  async releaseModelLease(
    leaseId: string,
    scope?: { projectId?: string; runId?: string },
    options?: RequestOptions,
  ): Promise<{ released: boolean }> {
    const params = new URLSearchParams();
    if (scope?.projectId) params.set('projectId', scope.projectId);
    if (scope?.runId) params.set('runId', scope.runId);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ released: boolean }>(
      'DELETE',
      `/api/v1/models/leases/${encodeURIComponent(leaseId)}${queryString}`,
      undefined,
      options,
    );
    return res.data;
  }

  async reapStaleModelLeases(options?: RequestOptions): Promise<{ reapedCount: number }> {
    const res = await this.request<{ reapedCount: number }>(
      'POST',
      '/api/v1/models/leases/reap',
      undefined,
      options,
    );
    return res.data;
  }

  async releaseAllModelLeases(options?: RequestOptions): Promise<{ releasedCount: number }> {
    const res = await this.request<{ releasedCount: number }>(
      'DELETE',
      '/api/v1/models/leases',
      undefined,
      options,
    );
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Audit Trail
  // ══════════════════════════════════════════════════════════════

  async getAuditEvents(category?: string, options?: RequestOptions): Promise<AuditRecord[]> {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    const res = await this.request<AuditRecord[]>('GET', `/api/v1/audit${query}`, undefined, options);
    return validateAuditRecordsList(res.data);
  }

  async verifyAuditChain(options?: RequestOptions): Promise<AuditChainVerification> {
    const res = await this.request<AuditChainVerification>('POST', '/api/v1/audit/verify', undefined, options);
    return res.data;
  }

  async exportAuditTrail(options?: RequestOptions): Promise<{ records: AuditRecord[]; verification: AuditChainVerification }> {
    const res = await this.request<{ records: AuditRecord[]; verification: AuditChainVerification }>('GET', '/api/v1/audit/export', undefined, options);
    return res.data;
  }

  async getSovereignPanelData(projectId?: string, options?: RequestOptions): Promise<SovereignPanelData> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<SovereignPanelData>('GET', `/api/v1/sovereignty/panel${qs}`, undefined, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Artifacts
  // ══════════════════════════════════════════════════════════════

  async getArtifacts(type?: string, options?: RequestOptions): Promise<Artifact[]> {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    const res = await this.request<Artifact[]>('GET', `/api/v1/artifacts${query}`, undefined, options);
    return res.data;
  }

  async getArtifact(id: string, options?: RequestOptions): Promise<Artifact> {
    const res = await this.request<Artifact>('GET', `/api/v1/artifacts/${encodeURIComponent(id)}`, undefined, options);
    return res.data;
  }

  async getArtifactContent(id: string, options?: RequestOptions): Promise<string> {
    const res = await this.request<string>(
      'GET',
      `/api/v1/artifacts/${encodeURIComponent(id)}/content`,
      undefined,
      options,
    );
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Approvals (UI1-14)
  // ══════════════════════════════════════════════════════════════

  async getApprovals(
    filters?: string | { status?: string; scope?: string; projectId?: string; runId?: string; taskId?: string },
    options?: RequestOptions,
  ): Promise<ApprovalRecord[]> {
    let qs = '';
    if (typeof filters === 'string') {
      qs = filters ? `?status=${encodeURIComponent(filters)}` : '';
    } else if (filters) {
      const p = new URLSearchParams();
      if (filters.status) p.set('status', filters.status);
      if (filters.scope) p.set('scope', filters.scope);
      if (filters.projectId) p.set('projectId', filters.projectId);
      if (filters.runId) p.set('runId', filters.runId);
      if (filters.taskId) p.set('taskId', filters.taskId);
      if (p.toString()) qs = `?${p.toString()}`;
    }
    const res = await this.request<ApprovalRecord[]>('GET', `/api/v1/approvals${qs}`, undefined, options);
    return validateApprovalsList(res.data);
  }

  async listApprovals(
    filters?: string | { status?: string; scope?: string; projectId?: string; runId?: string; taskId?: string },
    options?: RequestOptions,
  ): Promise<ApprovalRecord[]> {
    return this.getApprovals(filters, options);
  }

  async getApproval(id: string, options?: RequestOptions): Promise<ApprovalRecord> {
    const res = await this.request<ApprovalRecord>(
      'GET',
      `/api/v1/approvals/${encodeURIComponent(id)}`,
      undefined,
      options,
    );
    return validateApprovalRecord(res.data);
  }

  async createApproval(input: CreateApprovalInput, options?: RequestOptions): Promise<ApprovalRecord> {
    const res = await this.request<ApprovalRecord>('POST', '/api/v1/approvals', input, options);
    return validateApprovalRecord(res.data);
  }

  async reviewApproval(
    id: string,
    decision: ReviewApprovalInput,
    options?: RequestOptions,
  ): Promise<ApprovalRecord> {
    const res = await this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/review`,
      decision,
      options,
    );
    return validateApprovalRecord(res.data);
  }

  async resolveApproval(
    id: string,
    decision: { status: 'approved' | 'rejected'; reviewedBy: string; notes?: string; role?: string; conditions?: string[] },
    options?: RequestOptions,
  ): Promise<ApprovalRecord> {
    const res = await this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/resolve`,
      {
        decision: decision.status,
        actorId: decision.reviewedBy,
        actorRole: decision.role || 'reviewer',
        notes: decision.notes,
        conditions: decision.conditions,
      },
      options,
    );
    return validateApprovalRecord(res.data);
  }

  async validateApproval(
    id: string,
    context: ApprovalValidationContext,
    options?: RequestOptions,
  ): Promise<ApprovalCheckResult> {
    const res = await this.request<ApprovalCheckResult>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/validate`,
      context,
      options,
    );
    return validateApprovalCheckResult(res.data);
  }

  async consumeApproval(
    id: string,
    context: { actorId: string; operation: string },
    options?: RequestOptions,
  ): Promise<ApprovalRecord> {
    const res = await this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/consume`,
      context,
      options,
    );
    return validateApprovalRecord(res.data);
  }

  async forceStop(params: ForceStopParams, options?: RequestOptions): Promise<ForceStopResult> {
    const res = await this.request<ForceStopResult>('POST', '/api/v1/approvals/force-stop', params, options);
    return validateForceStopResult(res.data);
  }


  // ══════════════════════════════════════════════════════════════
  // Verifier Endpoints
  // ══════════════════════════════════════════════════════════════

  async verifyRun(runId: string, options?: RequestOptions): Promise<RunVerificationResult> {
    const res = await this.request<RunVerificationResult>('POST', '/api/v1/verify/run', { runId }, options);
    return res.data;
  }

  async verifyArtifact(artifactId: string, options?: RequestOptions): Promise<ArtifactVerificationResult> {
    const res = await this.request<ArtifactVerificationResult>('POST', '/api/v1/verify/artifact', { artifactId }, options);
    return res.data;
  }

  async verifyModel(modelId: string, options?: RequestOptions): Promise<ModelVerificationResult> {
    const res = await this.request<ModelVerificationResult>('POST', '/api/v1/verify/model', { modelId }, options);
    return res.data;
  }

  async verifyRelationship(childId: string, parentId: string, options?: RequestOptions): Promise<RunVerificationResult> {
    const res = await this.request<RunVerificationResult>(
      'POST',
      '/api/v1/verify/relationship',
      { childId, parentId },
      options,
    );
    return res.data;
  }

  async verifyService(serviceName: string, options?: RequestOptions): Promise<RunVerificationResult> {
    const res = await this.request<RunVerificationResult>('POST', '/api/v1/verify/service', { serviceName }, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Session Authentication (UI1-03)
  // ══════════════════════════════════════════════════════════════

  /**
   * Rotate an existing launcher-issued session. This is not an initial login:
   * the server rejects this call until a trusted bootstrap token is installed.
   */
  async handshake(
    windowId?: string,
    options?: RequestOptions,
  ): Promise<LauncherSessionBootstrap> {
    const res = await this.request<LauncherSessionBootstrap>(
      'POST',
      '/api/v1/auth/handshake',
      { windowId },
      options,
    );
    this.sessionToken = res.data.sessionToken;
    return res.data;
  }

  async revokeSession(
    sessionId?: string,
    options?: RequestOptions,
  ): Promise<{ revoked: boolean; sessionId?: string }> {
    const res = await this.request<{ revoked: boolean; sessionId?: string }>(
      'POST',
      '/api/v1/auth/revoke',
      { sessionId },
      options,
    );
    this.sessionToken = undefined;
    return res.data;
  }

  async getSession(options?: RequestOptions): Promise<Record<string, unknown>> {
    const res = await this.request<Record<string, unknown>>('GET', '/api/v1/auth/session', undefined, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Deterministic Inference & Planning (F7-02, F7-03, F7-04)
  // ══════════════════════════════════════════════════════════════

  async infer(input: unknown, options?: RequestOptions): Promise<any> {
    const res = await this.request<any>('POST', '/api/v1/inference', input, options);
    return res.data;
  }

  async createWorkflowPlan(input: unknown, idempotencyKey?: string, options?: RequestOptions): Promise<any> {
    const opts = { ...options, ...(idempotencyKey ? { idempotencyKey } : {}) };
    const res = await this.request<any>('POST', '/api/v1/plans', input, opts);
    return res.data;
  }

  async getWorkflowPlan(planId: string, options?: RequestOptions): Promise<any> {
    const res = await this.request<any>('GET', `/api/v1/plans/${encodeURIComponent(planId)}`, undefined, options);
    return res.data;
  }

  async createExecutionContract(input: unknown, idempotencyKey?: string, options?: RequestOptions): Promise<any> {
    const opts = { ...options, ...(idempotencyKey ? { idempotencyKey } : {}) };
    const res = await this.request<any>('POST', '/api/v1/execution-plans', input, opts);
    return res.data;
  }

  async evaluateExecutionContract(contract: unknown, context: unknown, options?: RequestOptions): Promise<any> {
    const res = await this.request<any>('POST', '/api/v1/execution-plans/evaluate', { contract, context }, options);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Fair Priority & Cancellation Queue (UI1-12)
  // ══════════════════════════════════════════════════════════════

  async getQueueEntries(
    options?: { projectId?: string; status?: string },
    reqOptions?: RequestOptions,
  ): Promise<QueueEntry[]> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.status) params.set('status', options.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<QueueEntry[]>('GET', `/api/v1/queue${qs}`, undefined, reqOptions);
    return validateQueueEntriesList(res.data);
  }

  async getQueueStatus(
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<QueueStatusSummary> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<QueueStatusSummary>('GET', `/api/v1/queue/status${qs}`, undefined, reqOptions);
    return validateQueueStatusSummary(res.data);
  }

  async enqueueTask(
    input: EnqueueRequestInput,
    idempotencyKey?: string,
    reqOptions?: RequestOptions,
  ): Promise<QueueEntry> {
    const opts = { ...reqOptions, ...(idempotencyKey ? { idempotencyKey } : {}) };
    const res = await this.request<QueueEntry>('POST', '/api/v1/queue', input, opts);
    return validateQueueEntry(res.data);
  }

  async getQueueEntry(
    id: string,
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<QueueEntry> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<QueueEntry>('GET', `/api/v1/queue/${encodeURIComponent(id)}${qs}`, undefined, reqOptions);
    return validateQueueEntry(res.data);
  }

  async cancelQueueEntry(
    id: string,
    options?: { projectId?: string; runId?: string; reason?: string; force?: boolean },
    reqOptions?: RequestOptions,
  ): Promise<QueueEntry> {
    const res = await this.request<QueueEntry>(
      'POST',
      `/api/v1/queue/${encodeURIComponent(id)}/cancel`,
      options || {},
      reqOptions,
    );
    return validateQueueEntry(res.data);
  }

  async recoverQueueState(reqOptions?: RequestOptions): Promise<{ interruptedCount: number }> {
    const res = await this.request<{ interruptedCount: number }>('POST', '/api/v1/queue/recover', undefined, reqOptions);
    return res.data;
  }

  // ── Model Switcher & Auto-Routing (UI1-13) ─────────────────────

  async getActiveModelIdentity(projectId?: string, reqOptions?: RequestOptions): Promise<ActiveModelIdentity> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<ActiveModelIdentity>('GET', `/api/v1/models/active${qs}`, undefined, reqOptions);
    return validateActiveModelIdentity(res.data);
  }

  async routeModel(input: ModelRouteRequest, reqOptions?: RequestOptions): Promise<ModelRouteResult> {
    const res = await this.request<ModelRouteResult>('POST', '/api/v1/models/route', input, reqOptions);
    return validateModelRouteResult(res.data);
  }

  async switchModel(input: ModelSwitchRequest, reqOptions?: RequestOptions): Promise<ModelSwitchResult> {
    const res = await this.request<ModelSwitchResult>('POST', '/api/v1/models/switch', input, reqOptions);
    return validateModelSwitchResult(res.data);
  }

  // ── Agent Cockpit (UI1-15) ────────────────────────────────────

  async startIndustrialJudgedRun(reqOptions?: RequestOptions): Promise<JudgedRunResponse> {
    const res = await this.request<JudgedRunResponse>(
      'POST',
      '/api/v1/industrial/judged-runs',
      {},
      reqOptions,
    );
    return res.data;
  }

  async getIndustrialJudgedRun(runId: string, reqOptions?: RequestOptions): Promise<JudgedRunResponse> {
    const res = await this.request<JudgedRunResponse>(
      'GET',
      `/api/v1/industrial/judged-runs/${encodeURIComponent(runId)}`,
      undefined,
      reqOptions,
    );
    return res.data;
  }

  async listCockpitRuns(projectId?: string, reqOptions?: RequestOptions): Promise<CockpitRunSummary[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<CockpitRunSummary[]>('GET', `/api/v1/cockpit${qs}`, undefined, reqOptions);
    return validateCockpitRunsList(res.data);
  }

  async getCockpitState(
    runId: string,
    options?: { projectId?: string },
    reqOptions?: RequestOptions,
  ): Promise<CockpitState> {
    const qs = options?.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : '';
    const res = await this.request<CockpitState>(
      'GET',
      `/api/v1/cockpit/${encodeURIComponent(runId)}${qs}`,
      undefined,
      reqOptions,
    );
    return validateCockpitState(res.data);
  }

  async stopCockpitRun(
    runId: string,
    options: { mode: 'cancel' | 'force'; confirmed?: boolean; reason?: string; projectId?: string },
    reqOptions?: RequestOptions,
  ): Promise<{ success: boolean; status: string; stoppedAt: string }> {
    const res = await this.request<{ success: boolean; status: string; stoppedAt: string }>(
      'POST',
      `/api/v1/cockpit/${encodeURIComponent(runId)}/stop`,
      options,
      reqOptions,
    );
    return res.data;
  }

  async replayCockpitRun(
    runId: string,
    options?: { projectId?: string; fromCursor?: number },
    reqOptions?: RequestOptions,
  ): Promise<CockpitState> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.fromCursor !== undefined) params.set('fromCursor', String(options.fromCursor));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<CockpitState>(
      'GET',
      `/api/v1/cockpit/${encodeURIComponent(runId)}/replay${qs}`,
      undefined,
      reqOptions,
    );
    return validateCockpitState(res.data);
  }

  async getEvents(
    options?: {
      cursor?: number;
      limit?: number;
      projectId?: string;
      runId?: string;
    },
    reqOptions?: RequestOptions,
  ): Promise<{ data: SequencedEvent[]; meta: any }> {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set('cursor', String(options.cursor));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.runId) params.set('runId', options.runId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ data: SequencedEvent[]; meta: any }>(
      'GET',
      `/api/v1/events${qs}`,
      undefined,
      reqOptions,
    );
    return res.data;
  }

  // ── Sandbox Runner (F8) ───────────────────────────────────────

  async executeSandbox(
    payload: Record<string, any>,
    idempotencyKey?: string,
    reqOptions?: RequestOptions,
  ): Promise<any> {
    const opts = { ...reqOptions, ...(idempotencyKey ? { idempotencyKey } : {}) };
    const res = await this.request<any>('POST', '/api/v1/sandbox/execute', payload, opts);
    return res.data;
  }

  async getSandboxManifest(reqOptions?: RequestOptions): Promise<any> {
    const res = await this.request<any>('GET', '/api/v1/sandbox/manifest', undefined, reqOptions);
    return res.data;
  }

  // ── Industrial Firewall Requirement (F9-06) ───────────────────

  async getIndustrialBoundaryStatus(
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<IndustrialBoundaryStatus> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    try {
      const res = await this.request<IndustrialBoundaryStatus>(
        'GET',
        `/api/v1/industrial/boundary-status${qs}`,
        undefined,
        reqOptions,
      );
      return res.data;
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 403 && err.details) {
        return err.details as IndustrialBoundaryStatus;
      }
      throw err;
    }
  }

  // ── Evidence Workbench (UI1-16) ───────────────────────────────

  async getEvidenceFiles(reqOptions?: RequestOptions): Promise<EvidenceFileInfo[]> {
    const res = await this.request<EvidenceFileInfo[]>('GET', '/api/v1/evidence/files', undefined, reqOptions);
    return res.data;
  }

  async getEvidenceFileDetail(filePath: string, reqOptions?: RequestOptions): Promise<EvidenceFileDetail> {
    const qs = `?path=${encodeURIComponent(filePath)}`;
    const res = await this.request<EvidenceFileDetail>('GET', `/api/v1/evidence/file${qs}`, undefined, reqOptions);
    return res.data;
  }

  async getSafetyThresholds(reqOptions?: RequestOptions): Promise<SafetyThresholdsConfig> {
    const res = await this.request<SafetyThresholdsConfig>('GET', '/api/v1/evidence/thresholds', undefined, reqOptions);
    return res.data;
  }

  async getConflictReports(projectId?: string, reqOptions?: RequestOptions): Promise<ConflictReport[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<ConflictReport[]>('GET', `/api/v1/evidence/conflicts${qs}`, undefined, reqOptions);
    return res.data;
  }

  async getConflictReport(id: string, reqOptions?: RequestOptions): Promise<ConflictReport> {
    const res = await this.request<ConflictReport>(
      'GET',
      `/api/v1/evidence/conflicts/${encodeURIComponent(id)}`,
      undefined,
      reqOptions,
    );
    return res.data;
  }

  async compareEvidenceObservations(
    payload: {
      projectId: string;
      ocrObservations?: readonly ComparableObservation[];
      visionObservations?: readonly ComparableObservation[];
      options?: ClassifyConflictOptions;
    },
    reqOptions?: RequestOptions,
  ): Promise<ConflictReport> {
    const res = await this.request<ConflictReport>('POST', '/api/v1/evidence/conflicts/compare', payload, reqOptions);
    return res.data;
  }

  async resolveConflict(
    reportId: string,
    params: ResolveConflictParams,
    reqOptions?: RequestOptions,
  ): Promise<ResolveConflictResponse> {
    const res = await this.request<ResolveConflictResponse>(
      'POST',
      `/api/v1/evidence/conflicts/${encodeURIComponent(reportId)}/resolve`,
      params,
      reqOptions,
    );
    return res.data;
  }

  async getResolvedObservations(projectId?: string, reqOptions?: RequestOptions): Promise<ResolvedObservation[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<ResolvedObservation[]>('GET', `/api/v1/evidence/resolved${qs}`, undefined, reqOptions);
    return res.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Document Generator (UI1-17)
  // ══════════════════════════════════════════════════════════════

  async getGeneratorPresets(reqOptions?: RequestOptions): Promise<GeneratorPreset[]> {
    const res = await this.request<GeneratorPreset[]>('GET', '/api/v1/generator/presets', undefined, reqOptions);
    return res.data;
  }

  async validateGeneratorInput(
    input: any,
    allowForeignProject?: boolean,
    reqOptions?: RequestOptions,
  ): Promise<GeneratorValidationResponse> {
    const res = await this.request<GeneratorValidationResponse>(
      'POST',
      '/api/v1/generator/validate-input',
      { input, allowForeignProject },
      reqOptions,
    );
    return res.data;
  }

  async validateGeneratorTemplate(
    templatePath: string,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    reqOptions?: RequestOptions,
  ): Promise<TemplateValidationResponse> {
    const res = await this.request<TemplateValidationResponse>(
      'POST',
      '/api/v1/generator/validate-template',
      { templatePath, expectedType },
      reqOptions,
    );
    return res.data;
  }

  async generateDocument(
    payload: GenerateDocumentPayload,
    reqOptions?: RequestOptions,
  ): Promise<GenerateDocumentResponse> {
    const res = await this.request<GenerateDocumentResponse>(
      'POST',
      '/api/v1/generator/generate',
      payload,
      reqOptions,
    );
    return res.data;
  }

  async launchDocument(
    payload: { artifactId?: string; relativePath?: string },
    reqOptions?: RequestOptions,
  ): Promise<LaunchDocumentResponse> {
    const res = await this.request<LaunchDocumentResponse>(
      'POST',
      '/api/v1/generator/launch',
      payload,
      reqOptions,
    );
    return res.data;
  }

  async getGeneratorArtifacts(reqOptions?: RequestOptions): Promise<Artifact[]> {
    const res = await this.request<Artifact[]>('GET', '/api/v1/generator/artifacts', undefined, reqOptions);
    return res.data;
  }

  // ── Knowledge Base Search (UI1-18) ──────────────────────────────

  async searchKb(
    payload: KbSearchPayload,
    reqOptions?: RequestOptions,
  ): Promise<KbSearchResultResponse> {
    const res = await this.request<KbSearchResultResponse>('POST', '/api/v1/kb/search', payload, reqOptions);
    return res.data;
  }

  async getKbStatus(
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<any> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<any>('GET', `/api/v1/kb/status${qs}`, undefined, reqOptions);
    return res.data;
  }

  // ── Sandbox Results (UI1-18) ────────────────────────────────────

  async getSandboxResults(reqOptions?: RequestOptions): Promise<SandboxResultRecord[]> {
    const res = await this.request<SandboxResultRecord[]>('GET', '/api/v1/sandbox/results', undefined, reqOptions);
    return res.data;
  }
}

export interface EvidenceFileInfo {
  name: string;
  path: string;
  size: number;
  sha256: string;
  mimeType: string;
  fixtureClass?: string;
  isSafetyCritical?: boolean;
}

export interface EvidenceFileDetail extends EvidenceFileInfo {
  content?: string;
  base64Content?: string;
}

export interface SafetyStandardCitation {
  code: string;
  title: string;
  clause?: string;
}

export interface SafetyThresholdItem {
  unit: string;
  warning: number;
  critical: number;
  standardCitation?: string;
  recommendations?: {
    WARNING?: string;
    FAIL?: string;
  };
}

export interface SafetyThresholdsConfig {
  rulesetId: string;
  title: string;
  disclaimer: string;
  assetType: string;
  standardCitations?: SafetyStandardCitation[];
  thresholds: Record<string, SafetyThresholdItem>;
}

export interface ResolveConflictParams {
  itemId?: string;
  itemKey?: string;
  decision: 'accept_ocr' | 'accept_vision' | 'enter_corrected_value' | 'mark_unresolved' | 'reject_both';
  reviewerId: string;
  reviewerRole?: string;
  rationale: string;
  notes?: string;
  correctedValue?: string;
  correctedUnit?: string;
  autoApproveSafetyVerdict?: boolean;
  runId?: string;
  taskId?: string;
}

export interface ResolveConflictResponse {
  resolved: ResolvedObservation;
  approval?: ApprovalRecord;
}

// ── Document Generator Types (UI1-17) ─────────────────────────

export interface GeneratorPreset {
  id: string;
  name: string;
  artifactType: 'docx' | 'xlsx' | 'pptx';
  outputPath: string;
  description: string;
  input: any;
}

export interface GeneratorValidationResponse {
  valid: boolean;
  canonicalHash?: string;
  errors: string[];
  warnings: string[];
  freshness?: {
    fresh: boolean;
    errors: readonly string[];
    warnings: readonly string[];
    verifiedSourceCount: number;
    checkedAt: string;
  };
}

export interface TemplateValidationResponse {
  valid: boolean;
  templateHash?: string;
  errors: readonly string[];
}

export interface GenerateDocumentPayload {
  artifactType: 'docx' | 'xlsx' | 'pptx';
  schemaVersion: 1;
  projectId: string;
  input: any;
  outputPath: string;
  allowOverwrite?: boolean;
  approvalId?: string;
  requestId: string;
  templatePath?: string;
}

export interface GenerateDocumentResponse {
  ok: boolean;
  artifactId?: string;
  relativePath?: string;
  canonicalHash?: string;
  artifactHash?: string;
  bytesWritten?: number;
  generatedAt?: string;
  approvalId?: string;
  cached?: boolean;
  sheetCount?: number;
  sheetNames?: readonly string[];
  slideCount?: number;
  slideTitles?: readonly string[];
  error?: string;
  message?: string;
}

export interface LaunchDocumentResponse {
  launched: boolean;
  path: string;
  sha256?: string;
  message: string;
  downloadUrl?: string;
}

// ── KB Search Types (UI1-18) ──────────────────────────────────────

export interface KbSearchPayload {
  query: string;
  projectId?: string;
  topK?: number;
  minScore?: number;
  filter?: {
    sourcePaths?: string[];
    documentIds?: string[];
    mimeTypes?: string[];
    pageNumbers?: number[];
    sectionHeadings?: string[];
  };
  requestId?: string;
}

export interface KbSearchCitationRecord {
  documentId: string;
  chunkId: string;
  sourcePath: string;
  canonicalPath?: string;
  pageNumber?: number;
  sectionHeading?: string;
  sourceHash: string;
  documentVersion: number;
  chunkIndex: number;
  charOffsetStart: number;
  charOffsetEnd: number;
  score: number;
  indexBuildId: string;
  embeddingModelId: string;
  embeddingModelRevision: string;
  snippet: string;
}

export interface KbSearchResultResponse {
  schemaVersion: 1;
  answered: boolean;
  projectId: string;
  query: string;
  durationMs: number;
  citations: KbSearchCitationRecord[];
  totalMatches?: number;
  returnedMatches?: number;
  indexBuildId?: string;
  embeddingModelId?: string;
  embeddingModelRevision?: string;
  reason?: string;
  details?: string;
  queriedAt?: string;
  corpusDocumentCount?: number;
  indexedDocumentCount?: number;
}

// ── Sandbox Result Types (UI1-18) ─────────────────────────────────

export interface SandboxResultRecord {
  eventId: string;
  timestamp: string;
  source: string;
  event: string;
  ok?: boolean;
  exitCode?: number | null;
  status?: string;
  durationMs?: number;
  inputHash?: string;
  outputHash?: string;
  containerName?: string;
  imageDigest?: string;
  stagedFiles?: readonly string[];
  stdoutLength?: number;
  stderrLength?: number;
  auditEventId?: string;
}

// ── Service Identity Types (UI1-19) ───────────────────────────────

export interface ServiceIdentityResponse {
  serviceInstanceId: string;
  servicePid: number;
  servicePort: number;
  host: string;
  projectRoot: string;
  projectRootHash: string;
  executablePath: string;
  executableHash: string;
  protocolVersion: string;
  startedAt: string;
  status: 'starting' | 'healthy' | 'stopped';
}

export interface DiagnosticResultRecord {
  check: string;
  passed: boolean;
  message: string;
}

export interface ServiceLifecycleResponse {
  defaults: {
    serviceIdleTimeoutMs: number;
    modelIdleTimeoutMs: number;
    sessionTtlMs: number;
  };
  identity: ServiceIdentityResponse | null;
  activeTasksCount: number;
  orphanReaperEnabled: boolean;
  pauseResumeSupported: boolean;
}

export interface OrphanCleanupResponse {
  purged: number;
  maxAgeMs: number;
  cleanedAt: string;
}

export interface KeepaliveResponse {
  acknowledged: boolean;
  taskId: string | null;
  serverTimestamp: string;
  status: string;
}

// ── Sovereign Panel Types (UI1-20) ────────────────────────────────

export interface TrackedProcessInfo {
  processId: number;
  projectId: string;
  projectRoot: string;
  serviceIdentity: string;
  processName: string;
  executablePath: string;
  executableHash: string;
  parentPid?: number;
  approvedDescendantPids?: readonly number[];
  status: 'trusted' | 'untrusted' | 'revoked';
  modelIdentity?: {
    modelId: string;
    modelRevision: string;
  };
  activeModelLeases?: readonly string[];
  registeredAt: string;
  lastVerifiedAt: string;
}

export interface TrackedEndpointInfo {
  protocol: 'tcp' | 'udp' | 'pipe';
  direction: 'bind' | 'connect';
  owningPid: number;
  serviceIdentity: string;
  localAddress: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  pipeName?: string;
  isLoopbackOnly: boolean;
  status: 'active' | 'closed' | 'blocked';
  boundAt: string;
}

export interface SovereignPanelData {
  projectId: string;
  boundaryStatus: IndustrialBoundaryStatus;
  activeBoundary: any;
  endpointPolicy: any;
  trackedProcesses: TrackedProcessInfo[];
  trackedBindings: TrackedEndpointInfo[];
  verification: AuditChainVerification;
  activeIdentity: ServiceIdentityResponse | null;
  inspectedAt: string;
}
