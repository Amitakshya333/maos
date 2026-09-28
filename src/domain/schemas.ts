/**
 * MAOS Domain Schemas — Versioned Canonical Types
 *
 * Every shared domain entity is defined here with explicit versioning.
 * These types form the contract between CLI, Dashboard, GUI, and services.
 *
 * Rules:
 *   - Every schema has a readonly schemaVersion field
 *   - Unknown fields are ignored on read, stripped on write
 *   - Enums are string literal unions (not numeric enums)
 *   - Size/count bounds are exported as named constants
 *   - Factory functions set defaults so callers only specify overrides
 */

// ── Bounds ────────────────────────────────────────────────────

export const MAX_PROJECT_NAME_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 10_000;
export const MAX_MESSAGE_CONTENT_LENGTH = 500_000;
export const MAX_FINDING_METRIC_LENGTH = 500;
export const MAX_EVIDENCE_CRITERIA_LENGTH = 1_000;
export const MAX_TAGS_PER_ENTITY = 50;
export const MAX_AGENT_ID_LENGTH = 100;
export const MAX_PATH_LENGTH = 1_024;
export const MAX_HASH_LENGTH = 128;
export const MAX_CHILDREN_PER_WORKFLOW = 500;
export const MAX_PLAN_HISTORY_ENTRIES = 50;
export const MAX_AUDIT_DATA_SIZE_BYTES = 64_000;

// ── Enums (string literal unions) ─────────────────────────────

export type ProfileMode = 'sovereign-local' | 'cloud' | 'hybrid';

export type TaskType = 'task' | 'objective' | 'subtask' | 'review';

export type TaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'interrupted';

export type TaskComplexity = 'low' | 'medium' | 'high';

export type TaskResultKind = 'success' | 'partial_success' | 'failed' | 'no_mutation';

export type RuntimeType = 'api' | 'cli' | 'local';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type ObjectiveStatus =
  | 'planning'
  | 'executing'
  | 'replanning'
  | 'reviewing'
  | 'done'
  | 'failed';

export type AgentStatus = 'IDLE' | 'BUSY' | 'DONE' | 'FAILED' | 'STUCK';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'conditional' | 'expired';

export type FindingStatus = 'PASS' | 'WARNING' | 'FAIL';

export type ServiceStatus = 'starting' | 'healthy' | 'degraded' | 'stopped' | 'crashed';

export type AuditEventType =
  | 'TASK_STARTED'
  | 'TASK_PROGRESS'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'RUNTIME_CRASHED'
  | 'HEARTBEAT'
  | 'AGENT_READY'
  | 'AGENT_DISPOSED'
  | 'CONTEXT_COMPRESSED'
  | 'BUDGET_WARNING'
  | 'HEALTH_ALERT'
  | 'AGENT_PHASE'
  | 'PROVIDER_WAITING'
  | 'PROVIDER_FAILING'
  | 'OBJECTIVE_CREATED'
  | 'OBJECTIVE_PLAN_READY'
  | 'OBJECTIVE_REPLANNING'
  | 'OBJECTIVE_COMPLETED'
  | 'OBJECTIVE_FAILED'
  | 'COORD_REQUEST'
  | 'COORD_RESPONSE'
  | 'REVIEW_STARTED'
  | 'REVIEW_APPROVED'
  | 'REVIEW_CHANGES_REQUIRED'
  | 'SUPERVISOR_NUDGE'
  // F3 additions
  | 'ARTIFACT_CREATED'
  | 'ARTIFACT_FINALIZED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'MODEL_LEASED'
  | 'MODEL_RELEASED'
  | 'SERVICE_STARTED'
  | 'SERVICE_STOPPED';

export type MemoryType = 'DISCOVERY' | 'DECISION' | 'WARNING' | 'FILE_MAP';

// ── F7-01 Extended Task Requirement Types ──────────────────────

export type TaskModality = 'text' | 'vision' | 'multimodal' | 'embedding' | 'code' | 'audio';
export const TASK_MODALITIES: readonly TaskModality[] = [
  'text',
  'vision',
  'multimodal',
  'embedding',
  'code',
  'audio',
];

export type TaskModelParameterTier = 'light' | 'standard' | 'flagship';
export const TASK_MODEL_PARAMETER_TIERS: readonly TaskModelParameterTier[] = [
  'light',
  'standard',
  'flagship',
];

export type TaskDevicePreference = 'cpu' | 'cuda' | 'metal' | 'any';
export const TASK_DEVICE_PREFERENCES: readonly TaskDevicePreference[] = [
  'cpu',
  'cuda',
  'metal',
  'any',
];

export type TaskQuantization = 'q4_k_m' | 'q8_0' | 'fp16' | 'fp32' | 'none' | 'any';
export const TASK_QUANTIZATIONS: readonly TaskQuantization[] = [
  'q4_k_m',
  'q8_0',
  'fp16',
  'fp32',
  'none',
  'any',
];

export interface TaskModelRequirement {
  readonly minContextTokens?: number;
  readonly modelFamily?: string;
  readonly architecture?: string;
  readonly requiredRevision?: string;
  readonly parameterTier?: TaskModelParameterTier;
  readonly devicePreference?: TaskDevicePreference;
  readonly quantization?: TaskQuantization;
}

export interface TaskToolRequirement {
  readonly requiredTools: readonly string[];
  readonly optionalTools?: readonly string[];
  readonly forbiddenTools?: readonly string[];
}

export interface TaskInputRequirements {
  readonly requiredArtifactTypes?: readonly string[];
  readonly requiredMimeTypes?: readonly string[];
  readonly schemaId?: string;
  readonly maxInputSizeBytes?: number;
}

export interface TaskOutputRequirements {
  readonly expectedArtifactTypes?: readonly string[];
  readonly outputSchemaId?: string;
  readonly enforceFormat?: boolean;
}

export interface ExtendedTaskRequirements {
  readonly schemaVersion: 1;
  readonly modalities: readonly TaskModality[];
  readonly primaryModality?: TaskModality;
  readonly model?: TaskModelRequirement;
  readonly tools?: TaskToolRequirement;
  readonly input?: TaskInputRequirements;
  readonly output?: TaskOutputRequirements;
  readonly allowDegradation?: boolean;
}

// ── Schema 1: Project ─────────────────────────────────────────

export interface ProviderEntry {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly costPerMillionTokens?: number;
}

export interface AgentEntry {
  readonly id: string;
  readonly role: string;
  readonly runtime?: RuntimeType;
  readonly provider?: string;
  readonly model?: string;
  readonly cliCommand?: string;
  readonly cliArgs?: string[];
  readonly auth?: Record<string, string>;
  readonly capabilities: string[];
  readonly systemPrompt?: string;
  readonly allowedTools?: string[];
  readonly scope: string[];
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly quiescenceMs?: number;
  readonly costTier?: string;
}

export interface RoutingConfig {
  readonly strategy: string;
  readonly costWeight: number;
  readonly capabilityWeight: number;
  readonly maxParallelAgents: number;
  readonly fallbackProvider: string;
}

export interface ProfileConfig {
  readonly id: string;
  readonly displayName: string;
  readonly mode: ProfileMode;
  readonly zeroCloud: boolean;
  readonly evidenceRoot: string;
}

export interface Project {
  readonly schemaVersion: 1;
  readonly projectName: string;
  readonly profile?: ProfileConfig;
  readonly routingMode: string;
  readonly providers: Record<string, ProviderEntry>;
  readonly agents: AgentEntry[];
  readonly routing: RoutingConfig;
}

// ── Schema 2: Conversation ────────────────────────────────────

export interface Conversation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly mode?: 'evidence' | 'brainstorm' | 'industrial';
  readonly pinned?: boolean;
  readonly messages: Message[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Schema 3: Message ─────────────────────────────────────────

export interface ToolCallRef {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface Message {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string | null;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: ToolCallRef[];
  readonly timestamp: string;
  readonly tokenUsage?: TokenUsage;
  readonly mode?: 'evidence' | 'brainstorm' | 'industrial';
  readonly claims?: readonly any[];
  readonly isModelGenerated?: boolean;
  readonly verifiedAgainstData?: boolean;
  readonly attachments?: Array<{
    readonly id: string;
    readonly name: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly mimeType: string;
    readonly sha256?: string;
  }>;
}

// ── Schema 4: Task ────────────────────────────────────────────

export interface Task {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: TaskType;
  readonly agent: string;
  readonly branch: string;
  readonly description: string;
  readonly capabilities: string[];
  readonly complexity: TaskComplexity;
  readonly status: TaskStatus;
  readonly category: string;
  readonly dependsOn: string[];
  readonly objectiveId: string;
  readonly depth: number;
  readonly reviewRequired: boolean;
  readonly fixAttempts: number;
  readonly parentTaskId: string;
  readonly createdAt: string;
  readonly filePath: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly requirements?: ExtendedTaskRequirements;
}

// ── Schema 5: Run ─────────────────────────────────────────────

export interface Run {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly success: boolean;
  readonly summary: string;
  readonly filesChanged: string[];
  readonly iterations: number;
  readonly totalTokens: number;
  readonly costUSD: number;
  readonly latencyMs: number;
  readonly runtimeType: RuntimeType;
  readonly result?: TaskResultKind;
  readonly exitCode?: number;
  readonly error?: string;
}

// ── Schema 6: WorkflowStage ──────────────────────────────────

export interface PlanHistoryEntry {
  readonly version: number;
  readonly createdAt: string;
  readonly taskIds: string[];
  readonly reason: string;
}

export interface WorkflowStage {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly goal: string;
  readonly status: ObjectiveStatus;
  readonly version: number;
  readonly childTaskIds: string[];
  readonly completedChildIds: string[];
  readonly failedChildIds: string[];
  readonly cancelledChildIds: string[];
  readonly plannerAgentId: string;
  readonly planHistory: PlanHistoryEntry[];
  readonly createdAt: string;
  readonly planCompletedAt: string | null;
  readonly doneAt: string | null;
  readonly maxReplanAttempts?: number;
  readonly replanCount?: number;
}

// ── Schema 7: Artifact ────────────────────────────────────────

export type ArtifactType = 'file' | 'report' | 'evidence' | 'log' | 'snapshot';

export interface Artifact {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly path: string;
  readonly type: ArtifactType;
  readonly hash: string;
  readonly size: number;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
  readonly taskId?: string;
  readonly projectId?: string;
}

// ── Schema 8: Finding ─────────────────────────────────────────

export interface Finding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly metric: string;
  readonly observed: string;
  readonly threshold: string;
  readonly status: FindingStatus;
  readonly ruleId: string;
  readonly unit: string;
  readonly timestamp: string;
}

// ── Schema 9: Evidence ────────────────────────────────────────

export interface MachineIdentity {
  readonly hostname: string;
  readonly osBuild: string;
  readonly arch?: string;
}

export interface Evidence {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly gateId: string;
  readonly criteria: string[];
  readonly verifiedItems: string[];
  readonly blockers: string[];
  readonly machineIdentity: MachineIdentity;
  readonly timestamp: string;
  readonly summary: string;
  readonly g2Ready: boolean;
}

// ── Schema 10: Approval ───────────────────────────────────────

export interface Approval {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly gateId?: string;
  readonly status: ApprovalStatus;
  readonly approvedBy: string;
  readonly approvedAt: string | null;
  readonly conditions: string[];
  readonly evidenceId?: string;

  // UI1-14 Governance Fields
  readonly approvalId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly payloadHash?: string;
  readonly sourceHashes?: readonly string[];
  readonly artifactIds?: readonly string[];
  readonly reviewedBy?: string;
  readonly reviewedAt?: string | null;
  readonly reviewRole?: string;
  readonly reviewNotes?: string;
  readonly consumed?: boolean;
  readonly consumedAt?: string | null;
  readonly consumedBy?: string;
  readonly metadata?: Record<string, unknown>;
}

// ── Schema 11: Model ──────────────────────────────────────────

export interface Model {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly provider: string;
  readonly device: string;
  readonly snapshotPath: string;
  readonly hash: string;
}

// ── Schema 12: ModelLease ─────────────────────────────────────

export interface ModelLease {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly modelId: string;
  readonly agentId: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly port: number;
  readonly projectId?: string;
  readonly runId?: string;
  readonly revision?: string;
  readonly device?: 'cuda' | 'cpu';
}

// ── Schema 13: AuditEvent ─────────────────────────────────────

export interface AuditEvent {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly type: AuditEventType;
  readonly agentId: string;
  readonly taskId?: string;
  readonly timestamp: number;
  readonly data?: Record<string, unknown>;
  readonly prevHash?: string;
}

// ── Schema 14: ServiceIdentity ────────────────────────────────

export interface ServiceIdentity {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly executablePath: string;
  readonly executableHash: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly status: ServiceStatus;
  readonly startedAt: string;
}

// ── Schema 15: ProvenanceReference ────────────────────────────

export interface ProvenanceReference {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
  readonly extractedAt: string;
  readonly chainPosition: number;
}

// ── Schema Extras: Aggregate types used by services ───────────

export interface QueueCounts {
  readonly pending: number;
  readonly active: number;
  readonly done: number;
  readonly failed: number;
  readonly retry: number;
}

export interface EventStats {
  readonly totalEvents: number;
  readonly fileSize: number;
  readonly oldestEvent: string | null;
  readonly newestEvent: string | null;
  readonly eventsByType: Record<string, number>;
}

export interface MemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly tags: string[];
  readonly confidence: number;
  readonly timestamp: number;
  readonly ttlMs: number;
}

export interface MemoryStats {
  readonly total: number;
  readonly live: number;
  readonly expired: number;
  readonly byType: Record<string, number>;
  readonly byAgent: Record<string, number>;
}

export interface DiagnosticResult {
  readonly check: string;
  readonly passed: boolean;
  readonly message: string;
  readonly details?: string;
}

export interface AgentPoolEntry {
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly detail: string;
  readonly enabled?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly capabilities: string[];
}

export interface RetryEntry {
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly maxRetries: number;
  readonly lastErrorType: string;
  readonly readyInMs: number;
}

export interface DeadLetterEntry {
  readonly taskId: string;
  readonly failedAt: string;
  readonly lastError: string;
}

export interface CredentialStatus {
  readonly provider: string;
  readonly valid: boolean;
  readonly error?: string;
}

export interface CleanResult {
  readonly tasksRemoved: number;
  readonly statusesReset: boolean;
  readonly logsCleared: boolean;
}

export interface CreateTaskInput {
  readonly description: string;
  readonly agent?: string;
  readonly branch?: string;
  readonly capabilities?: string[];
  readonly complexity?: TaskComplexity;
  readonly category?: string;
  readonly type?: TaskType;
  readonly objectiveId?: string;
  readonly depth?: number;
  readonly reviewRequired?: boolean;
  readonly dependsOn?: string[];
  readonly requirements?: ExtendedTaskRequirements;
}

export interface TaskFilter {
  readonly status?: TaskStatus;
  readonly type?: TaskType;
  readonly agentId?: string;
  readonly limit?: number;
}

export interface EventFilter {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly type?: AuditEventType;
  readonly limit?: number;
}

export interface OrchestrationOptions {
  readonly providerOverride?: string;
  readonly pollIntervalMs?: number;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly onStatusUpdate?: (state: any) => void;
}

export interface OrchestrationState {
  readonly running: boolean;
  readonly activeAgents: Array<{ agentId: string; taskId: string; startedAt: number }>;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly totalTokensUsed: number;
  readonly totalCostUSD: number;
}

// ── Sequenced Event (F3-04) ───────────────────────────────────

export interface SequencedEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

export type ResyncReason = 'STALE_CURSOR' | 'SEQUENCE_GAP' | 'PROJECT_MISMATCH' | 'RETENTION_EXCEEDED';

export interface WsClientSubscribeMessage {
  readonly type: 'subscribe';
  readonly projectId: string;
  readonly runId?: string;
  readonly cursor?: number;
}

export interface WsClientPingMessage {
  readonly type: 'ping';
}

export type WsClientMessage = WsClientSubscribeMessage | WsClientPingMessage;

export interface WsServerSubscribedMessage {
  readonly type: 'subscribed';
  readonly projectId: string;
  readonly latestSequence: number;
}

export interface WsServerEventMessage {
  readonly type: 'event';
  readonly event: SequencedEvent;
}

export interface WsServerReplayBatchMessage {
  readonly type: 'replay_batch';
  readonly events: SequencedEvent[];
  readonly fromCursor: number;
  readonly toCursor: number;
  readonly hasMore: boolean;
}

export interface WsServerResyncMessage {
  readonly type: 'resync_required';
  readonly reason: ResyncReason;
  readonly latestSequence: number;
  readonly oldestSequence: number;
  readonly projectId: string;
  readonly instructions: string;
}

export interface WsServerErrorMessage {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

export interface WsServerPongMessage {
  readonly type: 'pong';
  readonly timestamp: string;
}

export type WsServerMessage =
  | WsServerSubscribedMessage
  | WsServerEventMessage
  | WsServerReplayBatchMessage
  | WsServerResyncMessage
  | WsServerErrorMessage
  | WsServerPongMessage;

// ── Audit Types (F3-06) ───────────────────────────────────────────

export type AuditCategory =
  | 'stage'
  | 'tool'
  | 'model'
  | 'endpoint'
  | 'lease'
  | 'io_hash'
  | 'duration'
  | 'warning'
  | 'approval'
  | 'interruption';

export interface AuditRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly previous_hash: string;
  readonly timestamp: string;
  readonly source: string;
  readonly category: AuditCategory;
  readonly data: Record<string, unknown>;
  readonly hash: string;
}

export interface AuditChainVerification {
  readonly valid: boolean;
  readonly recordCount: number;
  readonly errors: readonly string[];
  readonly verifiedAt: string;
  readonly latestHash: string;
  readonly executableHash: string;
}

export interface AuditEventParams {
  readonly source: string;
  readonly category: AuditCategory;
  readonly data: Record<string, unknown>;
  readonly timestamp?: string;
}

export interface AuditFilter {
  readonly category?: AuditCategory;
  readonly source?: string;
  readonly fromSeq?: number;
  readonly toSeq?: number;
  readonly limit?: number;
}

// ── Idempotency & Verifier Types (F3-07) ──────────────────────────

export type IdempotencyStatus = 'in_progress' | 'completed' | 'failed';

export interface IdempotencyRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly requestHash: string;
  readonly operation: string;
  readonly projectId: string;
  readonly status: IdempotencyStatus;
  readonly responseStatus?: number;
  readonly responseHash?: string;
  readonly responsePayload?: unknown;
  readonly resultReference?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly authContext?: string;
}

export interface VerificationCheck {
  readonly check: string;
  readonly target: string;
  readonly valid: boolean;
  readonly details?: string;
}

export interface RunVerificationResult {
  readonly valid: boolean;
  readonly runId: string;
  readonly projectId: string;
  readonly checks: readonly VerificationCheck[];
  readonly errors: readonly string[];
  readonly verifiedAt: string;
}

export interface ArtifactVerificationResult {
  readonly valid: boolean;
  readonly artifactId: string;
  readonly path: string;
  readonly computedHash: string;
  readonly expectedHash?: string;
  readonly errors: readonly string[];
  readonly verifiedAt: string;
}

export interface ModelVerificationResult {
  readonly valid: boolean;
  readonly modelId: string;
  readonly revision?: string;
  readonly snapshotHash?: string;
  readonly errors: readonly string[];
  readonly verifiedAt: string;
}

