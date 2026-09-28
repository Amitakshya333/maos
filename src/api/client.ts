/**
 * MAOS Typed REST API Client
 *
 * Provides a fully typed client implementation to consume /api/v1 endpoints.
 * Used by contract tests, CLI commands, and the future GUI client.
 */

import * as http from 'http';
import type {
  Project,
  Conversation,
  Message,
  Task,
  WorkflowStage,
  Approval,
  Artifact,
  Model,
  ModelLease,
  DiagnosticResult,
  CreateTaskInput,
  AuditRecord,
  AuditChainVerification,
  AuditEventParams,
  AuditFilter,
  RunVerificationResult,
  ArtifactVerificationResult,
  ModelVerificationResult,
  VerificationCheck,
} from '../domain/schemas';
import type {
  ModelRegistration,
  ModelResidencyStatus,
  AcquireModelLeaseInput,
  RenewModelLeaseInput,
} from '../domain/model-manifest';
import type {
  OperationalMode,
  PurgeOptions,
  PurgeResult,
  RetentionStatus,
  EvidenceValidationResult,
  CitedClaim,
} from '../domain/evidence-mode';
import type {
  QueueEntry,
  QueueStatusSummary,
  EnqueueRequestInput,
  CancelQueueEntryInput,
} from '../domain/fair-queue';
import type {
  ModelRouteRequest,
  ModelRouteResult,
  ModelSwitchRequest,
  ModelSwitchResult,
  ActiveModelIdentity,
} from '../domain/model-switch';
import type {
  ApprovalRecord,
  CreateApprovalInput,
  ReviewApprovalInput,
  ApprovalValidationContext,
  ApprovalCheckResult,
  ForceStopParams,
  ForceStopResult,
} from '../domain/approval';
import type { CockpitState, CockpitRunSummary } from '../domain/cockpit';
import type { SequencedEvent } from '../domain/schemas';
import type { ApiErrorEnvelope } from './types';

export interface ClientOptions {
  readonly baseUrl: string;
  readonly projectRoot?: string;
  readonly correlationId?: string;
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly data?: T;
  readonly error?: ApiErrorEnvelope['error'];
  readonly correlationId?: string;
  readonly isReplay?: boolean;
}

export class MaosRestClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.defaultHeaders = {};
    if (opts.projectRoot) {
      this.defaultHeaders['X-Project-Root'] = opts.projectRoot;
    }
    if (opts.correlationId) {
      this.defaultHeaders['X-Correlation-ID'] = opts.correlationId;
    }
  }

  private async request<T = unknown>(
    method: string,
    endpoint: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(this.baseUrl + endpoint);
    const postData = body ? JSON.stringify(body) : undefined;

    const requestHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...headers,
    };

    if (postData) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = String(Buffer.byteLength(postData));
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: requestHeaders,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const correlationId = res.headers['x-correlation-id'] as string | undefined;
            const isReplay = res.headers['idempotent-replay'] === 'true';

            try {
              const json = JSON.parse(raw);
              if (res.statusCode && res.statusCode >= 400) {
                resolve({
                  status: res.statusCode,
                  error: json.error,
                  correlationId,
                });
              } else {
                resolve({
                  status: res.statusCode || 200,
                  data: json.data !== undefined ? json.data : json,
                  correlationId,
                  isReplay,
                });
              }
            } catch {
              resolve({
                status: res.statusCode || 200,
                data: raw as unknown as T,
                correlationId,
                isReplay,
              });
            }
          });
        },
      );

      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  // ── OpenAPI ───────────────────────────────────────────────────

  async getOpenApiSpec(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('GET', '/api/v1/openapi.json');
  }

  // ── Project, Settings, Sovereignty ────────────────────────────

  async getProject(): Promise<ApiResponse<Project>> {
    return this.request('GET', '/api/v1/project');
  }

  async getSettings(projectId?: string): Promise<ApiResponse<Record<string, unknown>>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/api/v1/settings${qs}`);
  }

  async updateSettings(patch: Record<string, unknown>, idempotencyKey?: string, projectId?: string): Promise<ApiResponse<Record<string, unknown>>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('PATCH', `/api/v1/settings${qs}`, patch, headers);
  }

  async resetSettings(projectId?: string): Promise<ApiResponse<Record<string, unknown>>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('POST', `/api/v1/settings/reset${qs}`);
  }

  async stopService(payload: { mode: 'after-current-tasks' | 'force'; confirm?: boolean; reason?: string }): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('POST', '/api/v1/service/stop', payload);
  }

  async getServiceVisibility(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('GET', '/api/v1/service/visibility');
  }

  async getSovereigntyStatus(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('GET', '/api/v1/security/sovereignty');
  }

  // ── Retention & Scoped Purge (UI1-10) ───────────────────────────

  async getRetentionStatus(projectId?: string): Promise<ApiResponse<RetentionStatus>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/api/v1/retention/status${qs}`);
  }

  async executeRetentionPurge(
    options: PurgeOptions,
    idempotencyKey?: string,
  ): Promise<ApiResponse<PurgeResult>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/retention/purge', options, headers);
  }

  async validateClaim(
    claim: unknown,
    mode?: OperationalMode,
  ): Promise<ApiResponse<EvidenceValidationResult>> {
    return this.request('POST', '/api/v1/mode/validate-claim', { claim, mode });
  }

  // ── Conversations & Messages ──────────────────────────────────

  async listConversations(projectId?: string): Promise<ApiResponse<Conversation[]>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/api/v1/conversations${qs}`);
  }

  async createConversation(
    payload: { id?: string; projectId: string; agentId: string; taskId?: string; mode?: OperationalMode; pinned?: boolean },
    idempotencyKey?: string,
  ): Promise<ApiResponse<Conversation>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/conversations', payload, headers);
  }

  async getConversation(id: string): Promise<ApiResponse<Conversation>> {
    return this.request('GET', `/api/v1/conversations/${encodeURIComponent(id)}`);
  }

  async addMessage(
    conversationId: string,
    message: {
      role: string;
      content: string | null;
      name?: string;
      toolCallId?: string;
      attachments?: any[];
      mode?: OperationalMode;
      claims?: CitedClaim[];
      isModelGenerated?: boolean;
      verifiedAgainstData?: boolean;
    },
    idempotencyKey?: string,
  ): Promise<ApiResponse<Message>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, message, headers);
  }

  async updateConversationMode(
    conversationId: string,
    mode: OperationalMode,
    confirmed = false,
  ): Promise<ApiResponse<Conversation>> {
    return this.request('PATCH', `/api/v1/conversations/${encodeURIComponent(conversationId)}/mode`, { mode, confirmed });
  }

  async setConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<ApiResponse<Conversation>> {
    return this.request('PATCH', `/api/v1/conversations/${encodeURIComponent(conversationId)}/pin`, { pinned });
  }

  async promoteToTask(
    conversationId: string,
    data: {
      description: string;
      agent?: string;
      branch?: string;
      complexity?: string;
      attachments?: any[];
      mode?: OperationalMode;
      allowUnreviewedBrainstorm?: boolean;
    },
    idempotencyKey?: string,
  ): Promise<ApiResponse<{ task: Task; conversation: Conversation }>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', `/api/v1/conversations/${encodeURIComponent(conversationId)}/promote`, data, headers);
  }

  async getProjectFiles(subpath?: string): Promise<ApiResponse<Array<{ path: string; name: string; size: number; isDirectory: boolean; extension?: string }>>> {
    const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
    return this.request('GET', `/api/v1/project/files${query}`);
  }

  // ── Tasks ─────────────────────────────────────────────────────

  async listTasks(filter?: { status?: string; type?: string; agentId?: string; limit?: number }): Promise<ApiResponse<Task[]>> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.type) params.set('type', filter.type);
    if (filter?.agentId) params.set('agentId', filter.agentId);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/v1/tasks${qs}`);
  }

  async createTask(input: CreateTaskInput & { schemaVersion?: number }, idempotencyKey?: string): Promise<ApiResponse<Task>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/tasks', input, headers);
  }

  async getTask(id: string): Promise<ApiResponse<Task>> {
    return this.request('GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
  }

  // ── Workflows & Runs ──────────────────────────────────────────

  async listWorkflows(): Promise<ApiResponse<WorkflowStage[]>> {
    return this.request('GET', '/api/v1/workflows');
  }

  async createWorkflow(
    input: { id?: string; goal: string; plannerAgentId?: string; maxReplanAttempts?: number },
    idempotencyKey?: string,
  ): Promise<ApiResponse<WorkflowStage>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/workflows', input, headers);
  }

  async getWorkflow(id: string): Promise<ApiResponse<WorkflowStage>> {
    return this.request('GET', `/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  async listRuns(): Promise<ApiResponse<any[]>> {
    return this.request('GET', '/api/v1/runs');
  }

  async getRun(id: string): Promise<ApiResponse<any[]>> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}`);
  }

  // ── Approvals (UI1-14) ───────────────────────────────────────────

  async listApprovals(options?: {
    status?: string;
    scope?: string;
    projectId?: string;
    runId?: string;
    taskId?: string;
  }): Promise<ApiResponse<ApprovalRecord[]>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.scope) params.set('scope', options.scope);
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.runId) params.set('runId', options.runId);
    if (options?.taskId) params.set('taskId', options.taskId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<ApprovalRecord[]>('GET', `/api/v1/approvals${qs}`);
  }

  async getApproval(id: string): Promise<ApiResponse<ApprovalRecord>> {
    return this.request<ApprovalRecord>('GET', `/api/v1/approvals/${encodeURIComponent(id)}`);
  }

  async createApproval(
    input: CreateApprovalInput | { id?: string; gateId: string; conditions?: string[]; evidenceId?: string },
    idempotencyKey?: string,
  ): Promise<ApiResponse<ApprovalRecord>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request<ApprovalRecord>('POST', '/api/v1/approvals', input, headers);
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy = 'user',
    conditions?: string[],
    idempotencyKey?: string,
  ): Promise<ApiResponse<ApprovalRecord>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/decide`,
      { decision, decidedBy, conditions },
      headers,
    );
  }

  async reviewApproval(
    id: string,
    input: ReviewApprovalInput,
    idempotencyKey?: string,
  ): Promise<ApiResponse<ApprovalRecord>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/review`,
      input,
      headers,
    );
  }

  async validateApproval(
    id: string,
    context: ApprovalValidationContext,
  ): Promise<ApiResponse<ApprovalCheckResult>> {
    return this.request<ApprovalCheckResult>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/validate`,
      context,
    );
  }

  async consumeApproval(
    id: string,
    context: { actorId: string; operation: string },
  ): Promise<ApiResponse<ApprovalRecord>> {
    return this.request<ApprovalRecord>(
      'POST',
      `/api/v1/approvals/${encodeURIComponent(id)}/consume`,
      context,
    );
  }

  async forceStop(
    params: ForceStopParams,
    idempotencyKey?: string,
  ): Promise<ApiResponse<ForceStopResult>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request<ForceStopResult>('POST', '/api/v1/approvals/force-stop', params, headers);
  }

  // ── Artifacts ─────────────────────────────────────────────────

  async listArtifacts(runId?: string): Promise<ApiResponse<Artifact[]>> {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    return this.request('GET', `/api/v1/artifacts${qs}`);
  }

  async getArtifact(id: string): Promise<ApiResponse<Artifact>> {
    return this.request('GET', `/api/v1/artifacts/${encodeURIComponent(id)}`);
  }

  async getArtifactContent(id: string): Promise<ApiResponse<string>> {
    return this.request('GET', `/api/v1/artifacts/${encodeURIComponent(id)}/content`);
  }

  async finalizeArtifact(
    input: {
      id: string;
      relativePath?: string;
      path?: string;
      content: string;
      type: string;
      runId?: string;
      taskId?: string;
      projectId?: string;
      expectedHash?: string;
      allowOverwrite?: boolean;
      approvalId?: string;
      metadata?: Record<string, unknown>;
    },
    idempotencyKey?: string,
  ): Promise<ApiResponse<Artifact>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/artifacts', input, headers);
  }


  // ── Health & Diagnostics ──────────────────────────────────────

  async getHealth(): Promise<ApiResponse<any>> {
    return this.request('GET', '/api/v1/health');
  }

  async getDiagnostics(): Promise<ApiResponse<DiagnosticResult[]>> {
    return this.request('GET', '/api/v1/health/diagnostics');
  }

  // ── Audit Trail (F3-06) ───────────────────────────────────────

  async listAuditRecords(filter?: AuditFilter): Promise<ApiResponse<AuditRecord[]>> {
    const params = new URLSearchParams();
    if (filter?.category) params.set('category', filter.category);
    if (filter?.source) params.set('source', filter.source);
    if (filter?.fromSeq !== undefined) params.set('fromSeq', String(filter.fromSeq));
    if (filter?.toSeq !== undefined) params.set('toSeq', String(filter.toSeq));
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));

    const qs = params.toString();
    const endpoint = `/api/v1/audit${qs ? `?${qs}` : ''}`;
    return this.request('GET', endpoint);
  }

  async recordAuditEvent(
    event: AuditEventParams,
    idempotencyKey?: string,
  ): Promise<ApiResponse<AuditRecord>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return this.request('POST', '/api/v1/audit/events', event, headers);
  }

  async verifyAuditChain(): Promise<ApiResponse<AuditChainVerification>> {
    return this.request('POST', '/api/v1/audit/verify');
  }

  // ── Canonical Verification (F3-07) ───────────────────────────

  async verifyRun(runId: string): Promise<ApiResponse<RunVerificationResult>> {
    return this.request('POST', '/api/v1/verify/run', { runId });
  }

  async verifyArtifact(
    artifactId: string,
    expectedHash?: string,
  ): Promise<ApiResponse<ArtifactVerificationResult>> {
    return this.request('POST', '/api/v1/verify/artifact', { artifactId, expectedHash });
  }

  async verifyModel(opts: {
    modelId: string;
    revision?: string;
    snapshotHash?: string;
  }): Promise<ApiResponse<ModelVerificationResult>> {
    return this.request('POST', '/api/v1/verify/model', opts);
  }

  async verifyAudit(opts?: {
    sequence?: number;
    expectedHash?: string;
  }): Promise<ApiResponse<{ valid: boolean; errors: string[] }>> {
    return this.request('POST', '/api/v1/verify/audit', opts || {});
  }

  async verifyRelationship(opts: {
    projectId?: string;
    taskId?: string;
    runId?: string;
    artifactId?: string;
  }): Promise<ApiResponse<{ valid: boolean; errors: string[] }>> {
    return this.request('POST', '/api/v1/verify/relationship', opts);
  }

  async verifyService(
    serviceId: string,
    expectedExecutableHash?: string,
  ): Promise<ApiResponse<{ valid: boolean; errors: string[] }>> {
    return this.request('POST', '/api/v1/verify/service', { serviceId, expectedExecutableHash });
  }

  // ── Deterministic Inference (F7-02) ───────────────────────────

  async infer(input: unknown): Promise<ApiResponse<any>> {
    return this.request('POST', '/api/v1/inference', input);
  }

  // ── Workflow Planning (F7-03) ─────────────────────────────────

  async createWorkflowPlan(input: unknown, idempotencyKey?: string): Promise<ApiResponse<any>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.request('POST', '/api/v1/plans', input, headers);
  }

  async getWorkflowPlan(planId: string): Promise<ApiResponse<any>> {
    return this.request('GET', `/api/v1/plans/${encodeURIComponent(planId)}`);
  }

  async listWorkflowPlans(): Promise<ApiResponse<any>> {
    return this.request('GET', '/api/v1/plans');
  }

  // ── Tool & Approval Execution Planning (F7-04) ────────────────

  async createExecutionContract(input: unknown, idempotencyKey?: string): Promise<ApiResponse<any>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.request('POST', '/api/v1/execution-plans', input, headers);
  }

  async getExecutionContract(contractId: string): Promise<ApiResponse<any>> {
    return this.request('GET', `/api/v1/execution-plans/${encodeURIComponent(contractId)}`);
  }

  async listExecutionContracts(planId?: string): Promise<ApiResponse<any>> {
    const query = planId ? `?planId=${encodeURIComponent(planId)}` : '';
    return this.request('GET', `/api/v1/execution-plans${query}`);
  }

  async evaluateExecutionContract(contract: unknown, context: unknown): Promise<ApiResponse<any>> {
    return this.request('POST', '/api/v1/execution-plans/evaluate', { contract, context });
  }

  // ── Models, Leases & Residency (UI1-11) ────────────────────────

  async listModels(): Promise<ApiResponse<{ models?: Model[]; registeredModels?: ModelRegistration[] } | Model[]>> {
    return this.request('GET', '/api/v1/models');
  }

  async getModelResidencyStatus(): Promise<ApiResponse<ModelResidencyStatus>> {
    return this.request<ModelResidencyStatus>('GET', '/api/v1/models/residency');
  }

  async listModelLeases(projectId?: string): Promise<ApiResponse<ModelLease[]>> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request<ModelLease[]>('GET', `/api/v1/models/leases${query}`);
  }

  async acquireModelLease(
    input: AcquireModelLeaseInput,
    idempotencyKey?: string,
  ): Promise<ApiResponse<ModelLease>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.request<ModelLease>('POST', '/api/v1/models/leases', input, headers);
  }

  async renewModelLease(
    leaseId: string,
    extensionMs: number,
    options?: { projectId?: string; runId?: string },
  ): Promise<ApiResponse<ModelLease>> {
    return this.request<ModelLease>(
      'POST',
      `/api/v1/models/leases/${encodeURIComponent(leaseId)}/renew`,
      { extensionMs, ...options },
    );
  }

  async releaseModelLease(
    leaseId: string,
    options?: { projectId?: string; runId?: string },
  ): Promise<ApiResponse<{ released: boolean }>> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.runId) params.set('runId', options.runId);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ released: boolean }>(
      'DELETE',
      `/api/v1/models/leases/${encodeURIComponent(leaseId)}${queryString}`,
    );
  }

  async reapStaleModelLeases(): Promise<ApiResponse<{ reapedCount: number }>> {
    return this.request<{ reapedCount: number }>('POST', '/api/v1/models/leases/reap');
  }

  async releaseAllModelLeases(): Promise<ApiResponse<{ releasedCount: number }>> {
    return this.request<{ releasedCount: number }>('DELETE', '/api/v1/models/leases');
  }

  // ── Model Switcher & Auto-Routing (UI1-13) ─────────────────────

  async getActiveModelIdentity(projectId?: string): Promise<ApiResponse<ActiveModelIdentity>> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request<ActiveModelIdentity>('GET', `/api/v1/models/active${query}`);
  }

  async routeModel(input: ModelRouteRequest): Promise<ApiResponse<ModelRouteResult>> {
    return this.request<ModelRouteResult>('POST', '/api/v1/models/route', input);
  }

  async switchModel(
    input: ModelSwitchRequest,
    idempotencyKey?: string,
  ): Promise<ApiResponse<ModelSwitchResult>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.request<ModelSwitchResult>('POST', '/api/v1/models/switch', input, headers);
  }

  // ── Fair Priority & Cancellation Queue (UI1-12) ───────────────

  async listQueueEntries(options?: {
    projectId?: string;
    status?: string;
  }): Promise<ApiResponse<QueueEntry[]>> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.status) params.set('status', options.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<QueueEntry[]>('GET', `/api/v1/queue${qs}`);
  }

  async getQueueStatus(projectId?: string): Promise<ApiResponse<QueueStatusSummary>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request<QueueStatusSummary>('GET', `/api/v1/queue/status${qs}`);
  }

  async enqueueTask(
    input: EnqueueRequestInput,
    idempotencyKey?: string,
  ): Promise<ApiResponse<QueueEntry>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.request<QueueEntry>('POST', '/api/v1/queue', input, headers);
  }

  async getQueueEntry(id: string, projectId?: string): Promise<ApiResponse<QueueEntry>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request<QueueEntry>('GET', `/api/v1/queue/${encodeURIComponent(id)}${qs}`);
  }

  async cancelQueueEntry(
    id: string,
    options?: { projectId?: string; runId?: string; reason?: string; force?: boolean },
  ): Promise<ApiResponse<QueueEntry>> {
    return this.request<QueueEntry>(
      'POST',
      `/api/v1/queue/${encodeURIComponent(id)}/cancel`,
      options || {},
    );
  }

  async recoverQueueState(): Promise<ApiResponse<{ interruptedCount: number }>> {
    return this.request<{ interruptedCount: number }>('POST', '/api/v1/queue/recover');
  }

  // ── Agent Cockpit (UI1-15) ────────────────────────────────────

  async listCockpitRuns(projectId?: string): Promise<ApiResponse<CockpitRunSummary[]>> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request<CockpitRunSummary[]>('GET', `/api/v1/cockpit${qs}`);
  }

  async getCockpitState(runId: string, options?: { projectId?: string }): Promise<ApiResponse<CockpitState>> {
    const qs = options?.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : '';
    return this.request<CockpitState>('GET', `/api/v1/cockpit/${encodeURIComponent(runId)}${qs}`);
  }

  async stopCockpitRun(
    runId: string,
    options: { mode: 'cancel' | 'force'; confirmed?: boolean; reason?: string; projectId?: string },
  ): Promise<ApiResponse<{ success: boolean; status: string; stoppedAt: string }>> {
    return this.request('POST', `/api/v1/cockpit/${encodeURIComponent(runId)}/stop`, options);
  }

  async replayCockpitRun(
    runId: string,
    options?: { projectId?: string; fromCursor?: number },
  ): Promise<ApiResponse<CockpitState>> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.fromCursor !== undefined) params.set('fromCursor', String(options.fromCursor));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<CockpitState>('GET', `/api/v1/cockpit/${encodeURIComponent(runId)}/replay${qs}`);
  }

  async getSequencedEvents(options?: {
    cursor?: number;
    limit?: number;
    projectId?: string;
    runId?: string;
  }): Promise<ApiResponse<{ data: SequencedEvent[]; meta: any }>> {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set('cursor', String(options.cursor));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.runId) params.set('runId', options.runId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/v1/events${qs}`);
  }

  // ── Raw Request (For negative tests) ──────────────────────────

  async rawRequest<T = any>(
    method: string,
    endpoint: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(method, endpoint, body, headers);
  }
}
