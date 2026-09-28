/**
 * UI1-02: GUI API & Event Adapter
 *
 * Unifies the typed BrowserRestClient and BrowserEventClient into an integrated
 * service interface for React views and components.
 */

import { BrowserRestClient } from './rest-client';
import type {
  LauncherSessionBootstrap,
  RequestOptions,
  JudgedRunResponse,
  IndustrialTelemetryAnalysisResponse,
} from './rest-client';
import { BrowserEventClient, ConnectionState, EventListener, StateListener } from './event-client';
import type { Task, Artifact, ModelLease, AuditRecord, SequencedEvent, Project, Approval, Conversation, Message, MessageRole, AuditChainVerification } from '../../../domain/schemas';
import type {
  ModelRegistration,
  ModelResidencyStatus,
  AcquireModelLeaseInput,
  RenewModelLeaseInput,
} from '../../../domain/model-manifest';
import type { ChatAttachment, PromoteToTaskInput, PromoteToTaskResult, ProjectFileInfo } from '../../../domain/conversation';
import type { WorkspaceLayout } from '../../../domain/layout';
import type { BasicSettings } from '../../../domain/settings';
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
  ApprovalRecord,
  CreateApprovalInput,
  ReviewApprovalInput,
  ApprovalValidationContext,
  ApprovalCheckResult,
  ForceStopParams,
  ForceStopResult,
} from '../../../domain/approval';
import type { CockpitState, CockpitRunSummary, WorkflowProjection, WorkflowRunProjection } from '../../../domain/cockpit';
export type { WorkflowProjection, WorkflowRunProjection };
import type { IndustrialBoundaryStatus } from '../../../domain/industrial-firewall-requirement';
import type {
  EvidenceFileInfo,
  EvidenceFileDetail,
  SafetyThresholdsConfig,
  ResolveConflictParams,
  ResolveConflictResponse,
  GeneratorPreset,
  GeneratorValidationResponse,
  TemplateValidationResponse,
  GenerateDocumentPayload,
  GenerateDocumentResponse,
  LaunchDocumentResponse,
  KbSearchPayload,
  KbSearchResultResponse,
  ServiceIdentityResponse,
  DiagnosticResultRecord,
  ServiceLifecycleResponse,
  OrphanCleanupResponse,
  KeepaliveResponse,
  SovereignPanelData,
  SandboxResultRecord,
} from './rest-client';
import type {
  ComparableObservation,
  ConflictItem,
  ConflictReport,
  ResolvedObservation,
  ClassifyConflictOptions,
} from '../../../domain/conflict';

export interface SystemStatus {
  projectRoot: string;
  isSovereign: boolean;
  engineStatus: string;
  modelStatus: string;
  connectionState: ConnectionState;
  lastEventSeq: number;
}

export interface GuiApiAdapterOptions {
  baseUrl?: string;
  projectRoot?: string;
  wsUrl?: string;
  sessionToken?: string;
}

export class GuiApiAdapter {
  public readonly rest: BrowserRestClient;
  public readonly events: BrowserEventClient;

  constructor(
    baseUrlOrOptions: string | GuiApiAdapterOptions | BrowserRestClient = 'http://127.0.0.1:3847',
    projectRoot = 'C:\\maos',
    wsUrl?: string,
  ) {
    let finalBaseUrl: string;
    let finalProjectRoot: string;
    let finalWsUrl: string | undefined;
    let finalSessionToken: string | undefined;

    if (baseUrlOrOptions instanceof BrowserRestClient) {
      this.rest = baseUrlOrOptions;
      finalBaseUrl = baseUrlOrOptions.getBaseUrl();
      finalProjectRoot = projectRoot || baseUrlOrOptions.getProjectRoot();
      finalSessionToken = baseUrlOrOptions.getSessionToken();
    } else if (typeof baseUrlOrOptions === 'object' && baseUrlOrOptions !== null) {
      finalBaseUrl = baseUrlOrOptions.baseUrl || 'http://127.0.0.1:3847';
      finalProjectRoot = baseUrlOrOptions.projectRoot || 'C:\\maos';
      finalWsUrl = baseUrlOrOptions.wsUrl;
      finalSessionToken = baseUrlOrOptions.sessionToken;
      this.rest = new BrowserRestClient({
        baseUrl: finalBaseUrl,
        projectRoot: finalProjectRoot,
        sessionToken: finalSessionToken,
      });
    } else {
      finalBaseUrl = baseUrlOrOptions;
      finalProjectRoot = projectRoot;
      finalWsUrl = wsUrl;
      this.rest = new BrowserRestClient({
        baseUrl: finalBaseUrl,
        projectRoot: finalProjectRoot,
        sessionToken: finalSessionToken,
      });
    }

    const computedWsUrl = finalWsUrl || finalBaseUrl.replace(/^http/, 'ws') + '/api/v1/events';
    this.events = new BrowserEventClient({
      wsUrl: computedWsUrl,
      projectId: 'default-project',
      sessionToken: finalSessionToken,
    });
  }

  /**
   * Update active session token across both REST and WebSocket event clients.
   */
  setSessionToken(token?: string): void {
    this.rest.setSessionToken(token);
    this.events.setSessionToken(token);
  }

  /**
   * Bootstrap both browser channels with a session issued by launcher IPC.
   */
  initializeFromLauncher(session: LauncherSessionBootstrap): void {
    this.rest.initializeFromLauncher(session);
    this.events.setSessionToken(session.sessionToken);
  }

  /**
   * Start live event subscription.
   */
  start(): void {
    this.events.connect();
  }

  /**
   * Stop live event subscription.
   */
  stop(): void {
    this.events.disconnect();
  }

  /**
   * Rotate an existing launcher-issued session.
   * Configures both the REST client and Event client with the new token.
   */
  async handshake(windowId?: string): Promise<{
    sessionToken: string;
    sessionId: string;
    windowId: string;
    serviceInstanceId: string;
    projectRootHash: string;
    servicePort: number;
    expiresAt: number;
    protocolVersion: string;
  }> {
    const result = await this.rest.handshake(windowId);
    this.events.setSessionToken(result.sessionToken);
    return result;
  }

  /**
   * Revoke active session token and disconnect.
   */
  async revokeSession(): Promise<boolean> {
    const res = await this.rest.revokeSession();
    this.events.setSessionToken(undefined);
    return res.revoked;
  }

  // ══════════════════════════════════════════════════════════════
  // Read-Only Data Operations
  // ══════════════════════════════════════════════════════════════

  async getHealth(): Promise<Record<string, unknown>> {
    return this.rest.getHealth();
  }

  async getProject(): Promise<Project> {
    return this.rest.getProject();
  }

  async getSettings(projectId?: string): Promise<Record<string, unknown> & BasicSettings> {
    return this.rest.getSettings(undefined, projectId);
  }

  async updateSettings(patch: Record<string, unknown>, projectId?: string): Promise<Record<string, unknown> & BasicSettings> {
    return this.rest.updateSettings(patch, undefined, projectId);
  }

  async getBasicSettings(projectId?: string): Promise<BasicSettings> {
    return this.rest.getBasicSettings(projectId);
  }

  async updateBasicSettings(
    patch: Partial<BasicSettings> | Record<string, unknown>,
    projectId?: string,
  ): Promise<BasicSettings> {
    return this.rest.updateBasicSettings(patch, undefined, projectId);
  }

  async resetSettings(projectId?: string): Promise<BasicSettings> {
    return this.rest.resetSettings(projectId);
  }

  // ══════════════════════════════════════════════════════════════
  // Retention & Scoped Purge (UI1-10)
  // ══════════════════════════════════════════════════════════════

  async getRetentionStatus(projectId?: string): Promise<RetentionStatus> {
    return this.rest.getRetentionStatus(projectId);
  }

  async executeRetentionPurge(options: PurgeOptions): Promise<PurgeResult> {
    return this.rest.executeRetentionPurge(options);
  }

  async validateClaim(claim: unknown, mode?: OperationalMode): Promise<EvidenceValidationResult> {
    return this.rest.validateClaim(claim, mode);
  }

  async stopService(payload: { mode: 'after-current-tasks' | 'force'; confirm?: boolean; reason?: string }): Promise<{
    status: string;
    mode: string;
    [key: string]: unknown;
  }> {
    return this.rest.stopService(payload);
  }

  async getServiceVisibility(): Promise<Record<string, unknown>> {
    return this.rest.getServiceVisibility();
  }

  async getServiceIdentity(): Promise<ServiceIdentityResponse> {
    return this.rest.getServiceIdentity();
  }

  async getDiagnostics(): Promise<DiagnosticResultRecord[]> {
    return this.rest.getDiagnostics();
  }

  async getServiceLifecycle(): Promise<ServiceLifecycleResponse> {
    return this.rest.getServiceLifecycle();
  }

  async cleanupOrphans(payload?: { maxAgeMs?: number }): Promise<OrphanCleanupResponse> {
    return this.rest.cleanupOrphans(payload);
  }

  async sendKeepalive(payload?: { taskId?: string }): Promise<KeepaliveResponse> {
    return this.rest.sendKeepalive(payload);
  }

  async getLayout(role?: string): Promise<{ layout: WorkspaceLayout; exists: boolean }> {
    return this.rest.getLayout(role);
  }

  async updateLayout(layout: WorkspaceLayout): Promise<WorkspaceLayout> {
    return this.rest.updateLayout(layout);
  }

  async resetLayout(role?: string): Promise<WorkspaceLayout> {
    return this.rest.resetLayout(role);
  }

  // ══════════════════════════════════════════════════════════════
  // Conversations & Task Promotion (UI1-09 & UI1-10)
  // ══════════════════════════════════════════════════════════════

  async getConversations(projectId?: string): Promise<Conversation[]> {
    return this.rest.getConversations(projectId);
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.rest.getConversation(id);
  }

  async createConversation(data: { id?: string; projectId: string; agentId: string; taskId?: string; mode?: OperationalMode; pinned?: boolean }): Promise<Conversation> {
    return this.rest.createConversation(data);
  }

  async updateConversationMode(conversationId: string, mode: OperationalMode, confirmed = false): Promise<Conversation> {
    return this.rest.updateConversationMode(conversationId, mode, confirmed);
  }

  async setConversationPinned(conversationId: string, pinned: boolean): Promise<Conversation> {
    return this.rest.setConversationPinned(conversationId, pinned);
  }

  async addMessage(
    conversationId: string,
    message: {
      role: MessageRole;
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
  ): Promise<Message> {
    return this.rest.addMessage(conversationId, message);
  }

  async chatCompletion(
    conversationId: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<{
    message: { role: 'assistant'; content: string };
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    model: string;
    deterministic: boolean;
  }> {
    return this.rest.chatCompletion({ conversationId, messages });
  }

  async getChatHealth(): Promise<{ available: boolean; status: string }> {
    return this.rest.getChatHealth();
  }

  async promoteToTask(conversationId: string, data: PromoteToTaskInput): Promise<PromoteToTaskResult> {
    return this.rest.promoteToTask(conversationId, data);
  }

  async getProjectFiles(subpath?: string): Promise<ProjectFileInfo[]> {
    return this.rest.getProjectFiles(subpath);
  }

  async analyzeIndustrialTelemetry(input: {
    name?: string;
    contentBase64?: string;
    useBundledSample?: boolean;
  }): Promise<IndustrialTelemetryAnalysisResponse> {
    return this.rest.analyzeIndustrialTelemetry(input);
  }

  // ══════════════════════════════════════════════════════════════
  // Tasks
  // ══════════════════════════════════════════════════════════════

  async getTasks(status?: string): Promise<Task[]> {
    return this.rest.getTasks(status);
  }

  async getTask(id: string): Promise<Task> {
    return this.rest.getTask(id);
  }

  async createTask(data: { description: string; agent?: string; priority?: string; complexity?: string }): Promise<Task> {
    return this.rest.createTask(data);
  }

  async getApprovals(
    filters?: string | { status?: string; scope?: string; projectId?: string; runId?: string; taskId?: string },
  ): Promise<ApprovalRecord[]> {
    return this.rest.getApprovals(filters);
  }

  async getApproval(id: string): Promise<ApprovalRecord> {
    return this.rest.getApproval(id);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    return this.rest.createApproval(input);
  }

  async reviewApproval(id: string, input: ReviewApprovalInput): Promise<ApprovalRecord> {
    return this.rest.reviewApproval(id, input);
  }

  async resolveApproval(
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    role?: string,
  ): Promise<ApprovalRecord> {
    return this.rest.resolveApproval(id, {
      status: decision,
      reviewedBy: 'gui_operator',
      notes: reason,
      role: role || 'operator',
    });
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy = 'operator',
    conditions?: string[],
    idempotencyKey?: string,
  ): Promise<ApprovalRecord> {
    return this.rest.reviewApproval(
      id,
      {
        decision,
        actorId: decidedBy,
        actorRole: 'reviewer',
        conditions,
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }

  async validateApproval(
    id: string,
    context: ApprovalValidationContext,
  ): Promise<ApprovalCheckResult> {
    return this.rest.validateApproval(id, context);
  }

  async consumeApproval(
    id: string,
    context: { actorId: string; operation: string },
  ): Promise<ApprovalRecord> {
    return this.rest.consumeApproval(id, context);
  }

  async forceStop(params: ForceStopParams): Promise<ForceStopResult> {
    return this.rest.forceStop(params);
  }


  async getModels(): Promise<any> {
    return this.rest.getModels();
  }

  async getModelResidencyStatus(): Promise<ModelResidencyStatus> {
    return this.rest.getModelResidencyStatus();
  }

  async getModelLeases(projectId?: string): Promise<ModelLease[]> {
    return this.rest.getModelLeases(projectId);
  }

  async acquireModelLease(data: AcquireModelLeaseInput): Promise<ModelLease> {
    return this.rest.acquireModelLease(data);
  }

  async renewModelLease(
    leaseId: string,
    extensionMs: number,
    scope?: { projectId?: string; runId?: string },
  ): Promise<ModelLease> {
    return this.rest.renewModelLease(leaseId, extensionMs, scope);
  }

  async releaseModelLease(
    leaseId: string,
    scope?: { projectId?: string; runId?: string },
  ): Promise<{ released: boolean }> {
    return this.rest.releaseModelLease(leaseId, scope);
  }

  async reapStaleModelLeases(): Promise<{ reapedCount: number }> {
    return this.rest.reapStaleModelLeases();
  }

  async releaseAllModelLeases(): Promise<{ releasedCount: number }> {
    return this.rest.releaseAllModelLeases();
  }

  async getAuditEvents(category?: string): Promise<AuditRecord[]> {
    return this.rest.getAuditEvents(category);
  }

  async verifyAuditChain(): Promise<AuditChainVerification> {
    return this.rest.verifyAuditChain();
  }

  async exportAuditTrail(): Promise<{ records: AuditRecord[]; verification: AuditChainVerification }> {
    return this.rest.exportAuditTrail();
  }

  async getSovereignPanelData(projectId?: string): Promise<SovereignPanelData> {
    return this.rest.getSovereignPanelData(projectId);
  }

  // ══════════════════════════════════════════════════════════════
  // Fair Priority Queue (UI1-12)
  // ══════════════════════════════════════════════════════════════

  async getQueueEntries(projectId?: string, status?: string): Promise<QueueEntry[]> {
    return this.rest.getQueueEntries({ projectId, status });
  }

  async getQueueStatus(projectId?: string): Promise<QueueStatusSummary> {
    return this.rest.getQueueStatus(projectId);
  }

  async enqueueTask(input: EnqueueRequestInput): Promise<QueueEntry> {
    return this.rest.enqueueTask(input);
  }

  async getQueueEntry(id: string): Promise<QueueEntry> {
    return this.rest.getQueueEntry(id);
  }

  async cancelQueueEntry(id: string, options?: CancelQueueEntryInput): Promise<QueueEntry> {
    return this.rest.cancelQueueEntry(id, options);
  }

  async recoverQueueState(): Promise<{ interruptedCount: number }> {
    return this.rest.recoverQueueState();
  }

  // ══════════════════════════════════════════════════════════════
  // Model Switcher & Auto-Routing (UI1-13)
  // ══════════════════════════════════════════════════════════════

  async getActiveModelIdentity(projectId?: string): Promise<ActiveModelIdentity> {
    return this.rest.getActiveModelIdentity(projectId);
  }

  async routeModel(input: ModelRouteRequest): Promise<ModelRouteResult> {
    return this.rest.routeModel(input);
  }

  async switchModel(input: ModelSwitchRequest): Promise<ModelSwitchResult> {
    return this.rest.switchModel(input);
  }

  // ══════════════════════════════════════════════════════════════
  // Inference & Planning (F7-02, F7-03, F7-04)
  // ══════════════════════════════════════════════════════════════

  async infer(input: unknown): Promise<any> {
    return this.rest.infer(input);
  }

  async createWorkflowPlan(input: unknown, idempotencyKey?: string): Promise<any> {
    return this.rest.createWorkflowPlan(input, idempotencyKey);
  }

  async getWorkflowPlan(planId: string): Promise<any> {
    return this.rest.getWorkflowPlan(planId);
  }

  async createExecutionContract(input: unknown, idempotencyKey?: string): Promise<any> {
    return this.rest.createExecutionContract(input, idempotencyKey);
  }

  async evaluateExecutionContract(contract: unknown, context: unknown): Promise<any> {
    return this.rest.evaluateExecutionContract(contract, context);
  }

  // ══════════════════════════════════════════════════════════════
  // Agent Cockpit (UI1-15)
  // ══════════════════════════════════════════════════════════════

  async startIndustrialJudgedRun(): Promise<JudgedRunResponse> {
    return this.rest.startIndustrialJudgedRun();
  }

  async getIndustrialJudgedRun(runId: string): Promise<JudgedRunResponse> {
    return this.rest.getIndustrialJudgedRun(runId);
  }

  async listCockpitRuns(projectId?: string): Promise<CockpitRunSummary[]> {
    return this.rest.listCockpitRuns(projectId);
  }

  async getCockpitState(runId: string, projectId?: string): Promise<CockpitState> {
    return this.rest.getCockpitState(runId, projectId ? { projectId } : undefined);
  }

  async stopCockpitRun(
    runId: string,
    options: { mode: 'cancel' | 'force'; confirmed?: boolean; reason?: string; projectId?: string },
  ): Promise<{ success: boolean; status: string; stoppedAt: string }> {
    return this.rest.stopCockpitRun(runId, options);
  }

  async replayCockpitRun(
    runId: string,
    options?: { projectId?: string; fromCursor?: number },
  ): Promise<CockpitState> {
    return this.rest.replayCockpitRun(runId, options);
  }

  async getWorkflowProjection(id: string): Promise<WorkflowProjection | WorkflowRunProjection> {
    return this.rest.getWorkflowProjection(id);
  }

  async getWorkflowRunProjection(runId: string): Promise<WorkflowRunProjection> {
    return this.rest.getWorkflowRunProjection(runId);
  }

  async getEvents(options?: {
    cursor?: number;
    limit?: number;
    projectId?: string;
    runId?: string;
  }): Promise<{ data: SequencedEvent[]; meta: any }> {
    return this.rest.getEvents(options);
  }

  // ══════════════════════════════════════════════════════════════
  // Sandbox Runner (F8)
  // ══════════════════════════════════════════════════════════════

  async executeSandbox(
    payload: Record<string, any>,
    idempotencyKey?: string,
    reqOptions?: RequestOptions,
  ): Promise<any> {
    return this.rest.executeSandbox(payload, idempotencyKey, reqOptions);
  }

  async getSandboxManifest(reqOptions?: RequestOptions): Promise<any> {
    return this.rest.getSandboxManifest(reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Industrial Firewall Requirement (F9-06)
  // ══════════════════════════════════════════════════════════════

  async getIndustrialBoundaryStatus(
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<IndustrialBoundaryStatus> {
    return this.rest.getIndustrialBoundaryStatus(projectId, reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Evidence Workbench (UI1-16)
  // ══════════════════════════════════════════════════════════════

  async getEvidenceFiles(reqOptions?: RequestOptions): Promise<EvidenceFileInfo[]> {
    return this.rest.getEvidenceFiles(reqOptions);
  }

  async getEvidenceFileDetail(filePath: string, reqOptions?: RequestOptions): Promise<EvidenceFileDetail> {
    return this.rest.getEvidenceFileDetail(filePath, reqOptions);
  }

  async getSafetyThresholds(reqOptions?: RequestOptions): Promise<SafetyThresholdsConfig> {
    return this.rest.getSafetyThresholds(reqOptions);
  }

  async getConflictReports(projectId?: string, reqOptions?: RequestOptions): Promise<ConflictReport[]> {
    return this.rest.getConflictReports(projectId, reqOptions);
  }

  async getConflictReport(id: string, reqOptions?: RequestOptions): Promise<ConflictReport> {
    return this.rest.getConflictReport(id, reqOptions);
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
    return this.rest.compareEvidenceObservations(payload, reqOptions);
  }

  async resolveConflict(
    reportId: string,
    params: ResolveConflictParams,
    reqOptions?: RequestOptions,
  ): Promise<ResolveConflictResponse> {
    return this.rest.resolveConflict(reportId, params, reqOptions);
  }

  async getResolvedObservations(projectId?: string, reqOptions?: RequestOptions): Promise<ResolvedObservation[]> {
    return this.rest.getResolvedObservations(projectId, reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Document Generator (UI1-17)
  // ══════════════════════════════════════════════════════════════

  async getGeneratorPresets(reqOptions?: RequestOptions): Promise<GeneratorPreset[]> {
    return this.rest.getGeneratorPresets(reqOptions);
  }

  async validateGeneratorInput(
    input: any,
    allowForeignProject?: boolean,
    reqOptions?: RequestOptions,
  ): Promise<GeneratorValidationResponse> {
    return this.rest.validateGeneratorInput(input, allowForeignProject, reqOptions);
  }

  async validateGeneratorTemplate(
    templatePath: string,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    reqOptions?: RequestOptions,
  ): Promise<TemplateValidationResponse> {
    return this.rest.validateGeneratorTemplate(templatePath, expectedType, reqOptions);
  }

  async generateDocument(
    payload: GenerateDocumentPayload,
    reqOptions?: RequestOptions,
  ): Promise<GenerateDocumentResponse> {
    return this.rest.generateDocument(payload, reqOptions);
  }

  async launchDocument(
    payload: { artifactId?: string; relativePath?: string },
    reqOptions?: RequestOptions,
  ): Promise<LaunchDocumentResponse> {
    return this.rest.launchDocument(payload, reqOptions);
  }

  async getGeneratorArtifacts(reqOptions?: RequestOptions): Promise<Artifact[]> {
    return this.rest.getGeneratorArtifacts(reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Knowledge Base Search (UI1-18)
  // ══════════════════════════════════════════════════════════════

  async searchKb(
    payload: KbSearchPayload,
    reqOptions?: RequestOptions,
  ): Promise<KbSearchResultResponse> {
    return this.rest.searchKb(payload, reqOptions);
  }

  async getKbStatus(
    projectId?: string,
    reqOptions?: RequestOptions,
  ): Promise<any> {
    return this.rest.getKbStatus(projectId, reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Sandbox Results (UI1-18)
  // ══════════════════════════════════════════════════════════════

  async getSandboxResults(reqOptions?: RequestOptions): Promise<SandboxResultRecord[]> {
    return this.rest.getSandboxResults(reqOptions);
  }

  // ══════════════════════════════════════════════════════════════
  // Live Event Subscriptions
  // ══════════════════════════════════════════════════════════════

  subscribeEvents(listener: EventListener): () => void {
    return this.events.onEvent(listener);
  }

  subscribeConnectionState(listener: StateListener): () => void {
    return this.events.onStateChange(listener);
  }

  getLastEventSeq(): number {
    return this.events.getCursor();
  }
}

// Global default adapter configured for loopback
export const apiAdapter = new GuiApiAdapter();
