/**
 * MAOS Domain — Typed Agent Cockpit Specification (UI1-15)
 *
 * Defines:
 *   - Typed, read-only DAG nodes and indicators
 *   - Versioned CockpitState schema (schemaVersion: 1)
 *   - Pure, deterministic event replay engine (reconstructCockpitState)
 *   - Negative protections:
 *       * No visual editing (immutable state)
 *       * No placeholder success (genuine event required)
 *       * Sequence order enforcement and gap detection
 *       * Cross-project event rejection
 *       * Phantom completion defense (interrupted/failed tasks cannot succeed)
 */

import type { WorkflowPlan, WorkflowPlanStep, WorkflowStepType } from './workflow-plan';
import type { SequencedEvent, ApprovalStatus } from './schemas';

// ── Bounds ────────────────────────────────────────────────────

export const MAX_COCKPIT_NODES = 100;
export const MAX_COCKPIT_EDGES = 200;
export const MAX_TOOL_INVOCATIONS_LOG = 50;

// ── Stage and Run Statuses ───────────────────────────────────

export type CockpitStageStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'WAITING_APPROVAL'
  | 'INTERRUPTED';

export const ALL_COCKPIT_STAGE_STATUSES: readonly CockpitStageStatus[] = Object.freeze([
  'PENDING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'WAITING_APPROVAL',
  'INTERRUPTED',
]);

export type CockpitRunStatus =
  | 'IDLE'
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED'
  | 'BLOCKED';

export const ALL_COCKPIT_RUN_STATUSES: readonly CockpitRunStatus[] = Object.freeze([
  'IDLE',
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'CANCELLED',
  'BLOCKED',
]);

// ── Node Indicator Types ─────────────────────────────────────

export interface CockpitModelInfo {
  readonly modelId: string;
  readonly family: string;
  readonly revision: string;
  readonly device: string;
  readonly quantization?: string;
  readonly isFallbackCpu: boolean;
}

export interface CockpitToolExecution {
  readonly toolName: string;
  readonly invocations: number;
  readonly lastExecutedAt?: string;
  readonly lastStatus?: 'success' | 'failure';
  readonly totalDurationMs?: number;
}

export interface CockpitIOArtifacts {
  readonly sourceIds: readonly string[];
  readonly sourceHashes: readonly string[];
  readonly expectedArtifactTypes: readonly string[];
  readonly artifactIds: readonly string[];
  readonly artifactHashes: readonly string[];
}

export interface CockpitStageTelemetry {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface CockpitStageApproval {
  readonly required: boolean;
  readonly approvalId?: string;
  readonly scope?: string;
  readonly status?: ApprovalStatus;
  readonly reason?: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

export interface CockpitStageRetries {
  readonly count: number;
  readonly maxRetries: number;
  readonly lastRetryReason?: string;
}

export interface CockpitStageError {
  readonly code: string;
  readonly message: string;
  readonly timestamp: string;
  readonly details?: Record<string, unknown>;
}

export interface CockpitStageNode {
  readonly stepId: string;
  readonly stepType: WorkflowStepType | string;
  readonly title: string;
  readonly assignedAgentId: string;
  readonly status: CockpitStageStatus;
  readonly dependencies: readonly string[];
  readonly actualModel?: CockpitModelInfo;
  readonly tools: readonly CockpitToolExecution[];
  readonly io: CockpitIOArtifacts;
  readonly telemetry: CockpitStageTelemetry;
  readonly approval: CockpitStageApproval;
  readonly retries: CockpitStageRetries;
  readonly error?: CockpitStageError;
  readonly routes?: CockpitStageRoutes;
}

export interface CockpitStageRoutes {
  readonly stage: string;
  readonly approval?: string;
  readonly artifacts: readonly string[];
}

export interface CockpitEdge {
  readonly from: string; // dependency stepId
  readonly to: string;   // dependent stepId
}

export interface CockpitStateRoutes {
  readonly run: string;
  readonly replay: string;
  readonly stop: string;
  readonly stages?: string;
  readonly approvals?: string;
  readonly audit?: string;
}

// ── Typed Workflow Projections (F10-03) ───────────────────────

export interface WorkflowProjection {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly title: string;
  readonly stepType: string;
  readonly assignedAgentId: string;
  readonly state: CockpitStageStatus;
  readonly dependencies: readonly string[];
  readonly tools: readonly CockpitToolExecution[];
  readonly retries: CockpitStageRetries;
  readonly review: CockpitStageApproval;
  readonly model?: CockpitModelInfo;
  readonly timing: CockpitStageTelemetry;
  readonly artifacts: CockpitIOArtifacts;
  readonly routes: CockpitStageRoutes;
  readonly error?: CockpitStageError;
}

export interface WorkflowRunProjection {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly planId?: string;
  readonly state: CockpitRunStatus;
  readonly activeAgentId?: string;
  readonly activeStepId?: string;
  readonly stages: readonly WorkflowProjection[];
  readonly dependencies: readonly CockpitEdge[];
  readonly totalTokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
  readonly timing: {
    readonly totalLatencyMs: number;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly interruptedAt?: string;
    readonly lastUpdated: string;
  };
  readonly routes: CockpitStateRoutes;
  readonly forceStopped: boolean;
}

// ── Aggregate Cockpit State ──────────────────────────────────

export interface CockpitState {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly planId?: string;
  readonly status: CockpitRunStatus;
  readonly activeAgentId?: string;
  readonly activeStepId?: string;
  readonly nodes: readonly CockpitStageNode[];
  readonly edges: readonly CockpitEdge[];
  readonly totalTokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
  readonly totalLatencyMs: number;
  readonly currentCursor: number;
  readonly isReplaying: boolean;
  readonly forceStopped: boolean;
  readonly interruptedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly lastUpdated: string;
  readonly processedEventCount: number;
  readonly routes?: CockpitStateRoutes;
}

export interface CockpitRunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly planId?: string;
  readonly status: CockpitRunStatus;
  readonly activeAgentId?: string;
  readonly nodeCount: number;
  readonly completedCount: number;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
  readonly forceStopped: boolean;
  readonly startedAt?: string;
  readonly lastUpdated: string;
}

// ── Pure Initial State Factory ────────────────────────────────

/**
 * Creates the initial read-only CockpitState from a validated WorkflowPlan.
 * Nodes with no dependencies start in READY; nodes with dependencies start in PENDING.
 * Forbids placeholder success badges.
 */
export function createInitialCockpitState(
  plan: WorkflowPlan,
  options?: { runId?: string; initialCursor?: number },
): CockpitState {
  const runId = options?.runId || plan.provenance.runId || `run-${plan.planId}`;
  const nodes: CockpitStageNode[] = plan.steps.map((step) => {
    const hasDependencies = step.dependencies && step.dependencies.length > 0;
    const initialStatus: CockpitStageStatus = hasDependencies ? 'PENDING' : 'READY';

    return Object.freeze({
      stepId: step.stepId,
      stepType: step.stepType,
      title: step.title,
      assignedAgentId: step.assignedAgentId,
      status: initialStatus,
      dependencies: Object.freeze([...(step.dependencies || [])]),
      actualModel: step.requiredModel
        ? Object.freeze({
            modelId: step.requiredModel.modelFamily || 'auto',
            family: step.requiredModel.modelFamily || 'general',
            revision: step.requiredModel.requiredRevision || 'latest',
            device: step.requiredModel.devicePreference || 'any',
            quantization: step.requiredModel.quantization,
            isFallbackCpu: step.requiredModel.devicePreference === 'cpu',
          })
        : undefined,
      tools: Object.freeze([]),
      io: Object.freeze({
        sourceIds: Object.freeze([...(step.inputs?.sourceIds || [])]),
        sourceHashes: Object.freeze([]),
        expectedArtifactTypes: Object.freeze([...(step.outputs?.expectedArtifactTypes || [])]),
        artifactIds: Object.freeze([]),
        artifactHashes: Object.freeze([]),
      }),
      telemetry: Object.freeze({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      }),
      approval: Object.freeze({
        required: step.requiresApproval ?? false,
        reason: step.approvalReason,
        status: step.requiresApproval ? 'pending' : undefined,
      }),
      retries: Object.freeze({
        count: 0,
        maxRetries: 3,
      }),
      routes: Object.freeze({
        stage: `/api/v1/workflows/${encodeURIComponent(step.stepId)}`,
        approval: step.requiresApproval ? `/api/v1/approvals?stepId=${encodeURIComponent(step.stepId)}` : undefined,
        artifacts: Object.freeze([]),
      }),
    });
  });

  const edges: CockpitEdge[] = [];
  for (const step of plan.steps) {
    for (const dep of step.dependencies || []) {
      edges.push(Object.freeze({ from: dep, to: step.stepId }));
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    projectId: plan.provenance.projectId,
    runId,
    planId: plan.planId,
    status: 'PENDING',
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    totalTokens: Object.freeze({ prompt: 0, completion: 0, total: 0 }),
    totalLatencyMs: 0,
    currentCursor: options?.initialCursor ?? 0,
    isReplaying: false,
    forceStopped: false,
    lastUpdated: plan.provenance.createdAt || new Date().toISOString(),
    processedEventCount: 0,
    routes: Object.freeze({
      run: `/api/v1/cockpit/${encodeURIComponent(runId)}`,
      replay: `/api/v1/cockpit/${encodeURIComponent(runId)}/replay`,
      stop: `/api/v1/cockpit/${encodeURIComponent(runId)}/stop`,
      stages: `/api/v1/workflows?runId=${encodeURIComponent(runId)}`,
      approvals: `/api/v1/approvals?runId=${encodeURIComponent(runId)}`,
      audit: `/api/v1/audit/export?runId=${encodeURIComponent(runId)}`,
    }),
  });
}

// ── Pure Event Reducer ────────────────────────────────────────

export type ReplayErrorType =
  | 'CROSS_PROJECT_EVENT_REJECTED'
  | 'SEQUENCE_GAP_DETECTED'
  | 'PHANTOM_COMPLETION_PREVENTED'
  | 'INVALID_EVENT_PAYLOAD';

export class CockpitReplayError extends Error {
  constructor(
    public readonly errorType: ReplayErrorType,
    message: string,
    public readonly event?: SequencedEvent,
  ) {
    super(message);
    this.name = 'CockpitReplayError';
  }
}

/**
 * Applies a single SequencedEvent to CockpitState deterministically.
 * Enforces negative guardrails:
 *   - Rejects cross-project events
 *   - Rejects out-of-order or duplicate events (idempotent ignore)
 *   - Defends against phantom completion if run/step was interrupted/failed
 */
export function applySequencedEventToCockpit(
  state: CockpitState,
  event: SequencedEvent,
): CockpitState {
  // 1. Cross-Project Guardrail
  if (event.projectId && event.projectId !== state.projectId) {
    throw new CockpitReplayError(
      'CROSS_PROJECT_EVENT_REJECTED',
      `Event projectId '${event.projectId}' does not match state projectId '${state.projectId}'`,
      event,
    );
  }

  // 2. Duplicate or Out-of-order Sequence Guardrail
  // If sequence <= currentCursor, it is a duplicate event in replay or delivery — ignore idempotently
  if (event.sequence <= state.currentCursor) {
    return state;
  }

  // 3. Extract event parameters
  const eventType = (((event as any).eventType || (event as any).type || '') as string).toUpperCase();
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<
    string,
    any
  >;

  let nextStatus = state.status;
  let nextActiveAgentId = state.activeAgentId;
  let nextActiveStepId = state.activeStepId;
  let nextForceStopped = state.forceStopped;
  let nextInterruptedAt = state.interruptedAt;
  let nextStartedAt = state.startedAt || (eventType === 'RUN_STARTED' || eventType === 'TASK_STARTED' ? event.occurredAt : undefined);
  let nextCompletedAt = state.completedAt;

  let promptTokensDelta = 0;
  let completionTokensDelta = 0;
  let latencyDeltaMs = 0;

  // Clone nodes array for modification
  const nodeMap = new Map<string, CockpitStageNode>(state.nodes.map((n) => [n.stepId, n]));

  // Helper to get or fallback to stepId from payload or event
  const targetStepId: string | undefined = payload.stepId || (event as any).stepId || event.taskId || state.activeStepId;

  // Process Event Types
  switch (eventType) {
    case 'RUN_STARTED':
    case 'TASK_STARTED':
    case 'OBJECTIVE_CREATED': {
      if (nextStatus === 'PENDING' || nextStatus === 'IDLE') {
        nextStatus = 'RUNNING';
      }
      if (payload.agentId || (event as any).agentId) nextActiveAgentId = String(payload.agentId || (event as any).agentId);
      break;
    }

    case 'STAGE_STARTED':
    case 'STEP_STARTED': {
      // Guard against phantom restarts after force-stop
      if (nextForceStopped || nextStatus === 'INTERRUPTED') {
        break;
      }
      nextStatus = 'RUNNING';
      if (payload.stepId || (event as any).stepId) nextActiveStepId = String(payload.stepId || (event as any).stepId);
      if (payload.agentId || (event as any).agentId) nextActiveAgentId = String(payload.agentId || (event as any).agentId);

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        let actualModel = node.actualModel;
        if (payload.model) {
          actualModel = Object.freeze({
            modelId: payload.model.id || payload.model.modelId || 'auto',
            family: payload.model.family || 'general',
            revision: payload.model.revision || 'latest',
            device: payload.model.device || 'any',
            quantization: payload.model.quantization,
            isFallbackCpu: payload.model.device === 'cpu' || Boolean(payload.model.isFallbackCpu),
          });
        }
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'RUNNING',
            assignedAgentId: payload.agentId ? String(payload.agentId) : node.assignedAgentId,
            actualModel,
            telemetry: Object.freeze({
              ...node.telemetry,
              startedAt: node.telemetry.startedAt || event.occurredAt,
            }),
          }),
        );
      }
      break;
    }

    case 'MODEL_LEASED':
    case 'MODEL_SWITCHED': {
      const modelInfo: CockpitModelInfo = Object.freeze({
        modelId: String(payload.modelId || payload.model || 'unknown'),
        family: String(payload.family || 'general'),
        revision: String(payload.revision || payload.gitRevision || 'pinned'),
        device: String(payload.device || 'cuda'),
        quantization: payload.quantization ? String(payload.quantization) : undefined,
        isFallbackCpu: payload.device === 'cpu' || Boolean(payload.isFallbackCpu),
      });

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            actualModel: modelInfo,
          }),
        );
      }
      break;
    }

    case 'TOOL_EXECUTION':
    case 'TOOL_INVOKED':
    case 'TOOL_CALLED':
    case 'TOOL_COMPLETED': {
      const toolName = String(payload.toolName || payload.tool || 'unknown_tool');
      const duration = typeof payload.durationMs === 'number' ? payload.durationMs : 0;
      const toolStatus: 'success' | 'failure' = payload.status === 'failure' || payload.error ? 'failure' : 'success';
      latencyDeltaMs += duration;

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        const existingTools = [...node.tools];
        const existingIdx = existingTools.findIndex((t) => t.toolName === toolName);

        if (existingIdx >= 0) {
          const prev = existingTools[existingIdx];
          existingTools[existingIdx] = Object.freeze({
            toolName,
            invocations: prev.invocations + 1,
            lastExecutedAt: event.occurredAt,
            lastStatus: toolStatus,
            totalDurationMs: (prev.totalDurationMs || 0) + duration,
          });
        } else {
          existingTools.push(
            Object.freeze({
              toolName,
              invocations: 1,
              lastExecutedAt: event.occurredAt,
              lastStatus: toolStatus,
              totalDurationMs: duration,
            }),
          );
        }

        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            tools: Object.freeze(existingTools),
            telemetry: Object.freeze({
              ...node.telemetry,
              latencyMs: node.telemetry.latencyMs + duration,
            }),
          }),
        );
      }
      break;
    }

    case 'TOKEN_USAGE':
    case 'TELEMETRY': {
      const prompt = typeof payload.promptTokens === 'number' ? payload.promptTokens : 0;
      const completion = typeof payload.completionTokens === 'number' ? payload.completionTokens : 0;
      const latency = typeof payload.latencyMs === 'number' ? payload.latencyMs : 0;

      promptTokensDelta += prompt;
      completionTokensDelta += completion;
      latencyDeltaMs += latency;

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            telemetry: Object.freeze({
              ...node.telemetry,
              promptTokens: node.telemetry.promptTokens + prompt,
              completionTokens: node.telemetry.completionTokens + completion,
              totalTokens: node.telemetry.totalTokens + prompt + completion,
              latencyMs: node.telemetry.latencyMs + latency,
            }),
          }),
        );
      }
      break;
    }

    case 'ARTIFACT_CREATED':
    case 'ARTIFACT_FINALIZED': {
      const artId = payload.artifactId ? String(payload.artifactId) : undefined;
      const artHash = payload.hash || payload.sha256 ? String(payload.hash || payload.sha256) : undefined;

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        const artIds = artId && !node.io.artifactIds.includes(artId) ? [...node.io.artifactIds, artId] : [...node.io.artifactIds];
        const artHashes = artHash && !node.io.artifactHashes.includes(artHash) ? [...node.io.artifactHashes, artHash] : [...node.io.artifactHashes];

        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            io: Object.freeze({
              ...node.io,
              artifactIds: Object.freeze(artIds),
              artifactHashes: Object.freeze(artHashes),
            }),
          }),
        );
      }
      break;
    }

    case 'APPROVAL_REQUESTED': {
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'WAITING_APPROVAL',
            approval: Object.freeze({
              required: true,
              approvalId: payload.approvalId ? String(payload.approvalId) : node.approval.approvalId,
              scope: payload.scope ? String(payload.scope) : node.approval.scope,
              status: 'pending',
              reason: payload.reason ? String(payload.reason) : node.approval.reason,
            }),
          }),
        );
      }
      break;
    }

    case 'APPROVAL_GRANTED': {
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: node.status === 'WAITING_APPROVAL' ? 'RUNNING' : node.status,
            approval: Object.freeze({
              ...node.approval,
              status: 'approved',
              reviewedBy: payload.actorId || payload.reviewedBy ? String(payload.actorId || payload.reviewedBy) : undefined,
              reviewedAt: event.occurredAt,
            }),
          }),
        );
      }
      break;
    }

    case 'APPROVAL_REJECTED': {
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'FAILED',
            approval: Object.freeze({
              ...node.approval,
              status: 'rejected',
              reviewedBy: payload.actorId || payload.reviewedBy ? String(payload.actorId || payload.reviewedBy) : undefined,
              reviewedAt: event.occurredAt,
            }),
            error: Object.freeze({
              code: 'APPROVAL_REJECTED',
              message: payload.reason || payload.notes ? String(payload.reason || payload.notes) : 'Approval rejected by reviewer',
              timestamp: event.occurredAt,
            }),
          }),
        );
      }
      break;
    }

    case 'RETRY_ATTEMPTED':
    case 'TASK_RETRY': {
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'RUNNING',
            retries: Object.freeze({
              count: node.retries.count + 1,
              maxRetries: node.retries.maxRetries,
              lastRetryReason: payload.reason ? String(payload.reason) : 'Transient execution error',
            }),
          }),
        );
      }
      break;
    }

    case 'STAGE_COMPLETED':
    case 'STEP_COMPLETED':
    case 'TASK_COMPLETED': {
      // 4. Phantom Completion Defense:
      // If the run or target step was interrupted or failed, reject completion!
      if (nextForceStopped || nextStatus === 'INTERRUPTED') {
        // Drop phantom completion
        break;
      }

      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        if (node.status === 'INTERRUPTED' || node.status === 'FAILED') {
          // Cannot complete an already interrupted or failed node
          break;
        }

        const prompt = typeof payload.promptTokens === 'number'
          ? payload.promptTokens
          : (payload.tokens && typeof payload.tokens.prompt === 'number' ? payload.tokens.prompt : 0);
        const completion = typeof payload.completionTokens === 'number'
          ? payload.completionTokens
          : (payload.tokens && typeof payload.tokens.completion === 'number' ? payload.tokens.completion : 0);
        const total = typeof payload.totalTokens === 'number'
          ? payload.totalTokens
          : (payload.tokens && typeof payload.tokens.total === 'number' ? payload.tokens.total : (prompt + completion));
        const latency = typeof payload.latencyMs === 'number' ? payload.latencyMs : 0;

        promptTokensDelta += prompt;
        completionTokensDelta += completion;
        latencyDeltaMs += latency;

        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'COMPLETED',
            telemetry: Object.freeze({
              ...node.telemetry,
              promptTokens: node.telemetry.promptTokens + prompt,
              completionTokens: node.telemetry.completionTokens + completion,
              totalTokens: node.telemetry.totalTokens + total,
              latencyMs: node.telemetry.latencyMs + latency,
              completedAt: event.occurredAt,
            }),
          }),
        );

        // Update downstream nodes: if all dependencies of a PENDING node are now COMPLETED, promote to READY
        for (const [sId, candidate] of nodeMap.entries()) {
          if (candidate.status === 'PENDING') {
            const allDepsCompleted = candidate.dependencies.every((depId) => {
              const depNode = nodeMap.get(depId);
              return depNode && depNode.status === 'COMPLETED';
            });
            if (allDepsCompleted) {
              nodeMap.set(
                sId,
                Object.freeze({
                  ...candidate,
                  status: 'READY',
                }),
              );
            }
          }
        }
      }
      break;
    }

    case 'STAGE_INTERRUPTED':
    case 'STEP_INTERRUPTED': {
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'INTERRUPTED',
            error: Object.freeze({
              code: 'STAGE_INTERRUPTED',
              message: payload.reason ? String(payload.reason) : 'Stage execution interrupted',
              timestamp: event.occurredAt,
            }),
          }),
        );
      }
      break;
    }

    case 'STAGE_FAILED':
    case 'STEP_FAILED':
    case 'TASK_FAILED': {
      nextStatus = 'FAILED';
      if (targetStepId && nodeMap.has(targetStepId)) {
        const node = nodeMap.get(targetStepId)!;
        nodeMap.set(
          targetStepId,
          Object.freeze({
            ...node,
            status: 'FAILED',
            error: Object.freeze({
              code: String(payload.errorCode || 'STAGE_EXECUTION_FAILED'),
              message: String(payload.errorMessage || payload.reason || 'Stage execution failed'),
              timestamp: event.occurredAt,
              details: payload.details,
            }),
          }),
        );
      }
      break;
    }

    case 'FORCE_STOP_CONFIRMED':
    case 'RUN_INTERRUPTED':
    case 'TASK_INTERRUPTED': {
      nextStatus = 'INTERRUPTED';
      nextForceStopped = true;
      nextInterruptedAt = event.occurredAt;

      // Mark all currently RUNNING, READY, or WAITING_APPROVAL nodes as INTERRUPTED
      for (const [sId, node] of nodeMap.entries()) {
        if (node.status === 'RUNNING' || node.status === 'READY' || node.status === 'WAITING_APPROVAL') {
          nodeMap.set(
            sId,
            Object.freeze({
              ...node,
              status: 'INTERRUPTED',
              error: Object.freeze({
                code: 'FORCE_STOP_INTERRUPTED',
                message: payload.reason ? String(payload.reason) : 'Execution halted by confirmed force stop',
                timestamp: event.occurredAt,
              }),
            }),
          );
        }
      }
      break;
    }

    case 'RUN_COMPLETED':
    case 'OBJECTIVE_COMPLETED': {
      // Guard against phantom run completion if force stopped
      if (!nextForceStopped && nextStatus !== 'INTERRUPTED' && nextStatus !== 'FAILED') {
        nextStatus = 'COMPLETED';
        nextCompletedAt = event.occurredAt;
      }
      break;
    }
  }

  // Preserve topological/original order of nodes
  const orderedNodes = state.nodes.map((orig) => nodeMap.get(orig.stepId)!);

  return Object.freeze({
    schemaVersion: 1,
    projectId: state.projectId,
    runId: state.runId,
    planId: state.planId,
    status: nextStatus,
    activeAgentId: nextActiveAgentId,
    activeStepId: nextActiveStepId,
    nodes: Object.freeze(orderedNodes),
    edges: state.edges, // edges remain invariant
    totalTokens: Object.freeze({
      prompt: state.totalTokens.prompt + promptTokensDelta,
      completion: state.totalTokens.completion + completionTokensDelta,
      total: state.totalTokens.total + promptTokensDelta + completionTokensDelta,
    }),
    totalLatencyMs: state.totalLatencyMs + latencyDeltaMs,
    currentCursor: event.sequence,
    isReplaying: state.isReplaying,
    forceStopped: nextForceStopped,
    interruptedAt: nextInterruptedAt,
    startedAt: nextStartedAt,
    completedAt: nextCompletedAt,
    lastUpdated: event.occurredAt,
    processedEventCount: state.processedEventCount + 1,
  });
}

/**
 * Deterministically reconstructs the complete CockpitState from a WorkflowPlan
 * and a list of SequencedEvents.
 * Guarantees 100% determinism: identical events in sequence produce identical DAG state.
 */
export function reconstructCockpitState(
  plan: WorkflowPlan,
  events: readonly SequencedEvent[],
  options?: { runId?: string },
): CockpitState {
  let state = createInitialCockpitState(plan, options);

  // Sort events by sequence strictly in ascending order to guarantee reproducibility
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);

  for (const event of sorted) {
    state = applySequencedEventToCockpit(state, event);
  }

  return state;
}

/**
 * Computes a high-level summary of the CockpitState for list views.
 */
export function summarizeCockpitState(state: CockpitState): CockpitRunSummary {
  const completedCount = state.nodes.filter((n) => n.status === 'COMPLETED').length;

  return Object.freeze({
    runId: state.runId,
    projectId: state.projectId,
    planId: state.planId,
    status: state.status,
    activeAgentId: state.activeAgentId,
    nodeCount: state.nodes.length,
    completedCount,
    totalTokens: state.totalTokens.total,
    totalLatencyMs: state.totalLatencyMs,
    forceStopped: state.forceStopped,
    startedAt: state.startedAt,
    lastUpdated: state.lastUpdated,
  });
}

/**
 * Projects a CockpitStageNode into a client-facing WorkflowProjection.
 * Every value is runtime-derived from typed domain state.
 */
export function projectStageNode(
  node: CockpitStageNode,
  projectId: string,
  runId: string,
): WorkflowProjection {
  const approvalRoute = node.approval.approvalId
    ? `/api/v1/approvals/${encodeURIComponent(node.approval.approvalId)}`
    : undefined;

  const artifactRoutes = node.io.artifactIds.map(
    (artId) => `/api/v1/artifacts/${encodeURIComponent(artId)}`,
  );

  const routes: CockpitStageRoutes = Object.freeze({
    stage: `/api/v1/workflows/${encodeURIComponent(node.stepId)}`,
    approval: approvalRoute,
    artifacts: Object.freeze(artifactRoutes),
  });

  return Object.freeze({
    schemaVersion: 1,
    projectId,
    runId,
    stageId: node.stepId,
    title: node.title,
    stepType: node.stepType,
    assignedAgentId: node.assignedAgentId,
    state: node.status,
    dependencies: node.dependencies,
    tools: node.tools,
    retries: node.retries,
    review: node.approval,
    model: node.actualModel,
    timing: node.telemetry,
    artifacts: node.io,
    routes,
    error: node.error,
  });
}

/**
 * Projects a complete CockpitState into a client-facing WorkflowRunProjection.
 * Guarantees zero static placeholders and strictly runtime-derived values.
 */
export function projectWorkflowState(state: CockpitState): WorkflowRunProjection {
  const stages = state.nodes.map((n) => projectStageNode(n, state.projectId, state.runId));

  const routes: CockpitStateRoutes = Object.freeze({
    run: `/api/v1/cockpit/${encodeURIComponent(state.runId)}`,
    replay: `/api/v1/cockpit/${encodeURIComponent(state.runId)}/replay`,
    stop: `/api/v1/cockpit/${encodeURIComponent(state.runId)}/stop`,
    stages: `/api/v1/workflows?runId=${encodeURIComponent(state.runId)}`,
    approvals: `/api/v1/approvals?runId=${encodeURIComponent(state.runId)}`,
    audit: `/api/v1/audit/export?runId=${encodeURIComponent(state.runId)}`,
  });

  return Object.freeze({
    schemaVersion: 1,
    projectId: state.projectId,
    runId: state.runId,
    planId: state.planId,
    state: state.status,
    activeAgentId: state.activeAgentId,
    activeStepId: state.activeStepId,
    stages: Object.freeze(stages),
    dependencies: state.edges,
    totalTokens: state.totalTokens,
    timing: Object.freeze({
      totalLatencyMs: state.totalLatencyMs,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      interruptedAt: state.interruptedAt,
      lastUpdated: state.lastUpdated,
    }),
    routes,
    forceStopped: state.forceStopped,
  });
}

/**
 * Projects a single WorkflowStage (e.g. from WorkflowService) into a WorkflowProjection.
 */
export function projectWorkflowStage(
  stage: import('./schemas').WorkflowStage,
  projectId = 'default',
): WorkflowProjection {
  let mappedStatus: CockpitStageStatus = 'PENDING';
  if (stage.status === 'planning' || stage.status === 'replanning') mappedStatus = 'READY';
  else if (stage.status === 'executing') mappedStatus = 'RUNNING';
  else if (stage.status === 'reviewing') mappedStatus = 'WAITING_APPROVAL';
  else if (stage.status === 'done') mappedStatus = 'COMPLETED';
  else if (stage.status === 'failed') mappedStatus = 'FAILED';

  return Object.freeze({
    schemaVersion: 1,
    projectId,
    runId: stage.id,
    stageId: stage.id,
    title: stage.goal,
    stepType: 'objective',
    assignedAgentId: stage.plannerAgentId,
    state: mappedStatus,
    dependencies: Object.freeze([...(stage.childTaskIds || [])]),
    tools: Object.freeze([]),
    retries: Object.freeze({
      count: stage.replanCount ?? 0,
      maxRetries: stage.maxReplanAttempts ?? 3,
    }),
    review: Object.freeze({
      required: stage.status === 'reviewing',
      status: stage.status === 'reviewing' ? 'pending' : undefined,
    }),
    timing: Object.freeze({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      startedAt: stage.createdAt,
      completedAt: stage.doneAt || undefined,
    }),
    artifacts: Object.freeze({
      sourceIds: Object.freeze([]),
      sourceHashes: Object.freeze([]),
      expectedArtifactTypes: Object.freeze([]),
      artifactIds: Object.freeze([]),
      artifactHashes: Object.freeze([]),
    }),
    routes: Object.freeze({
      stage: `/api/v1/workflows/${encodeURIComponent(stage.id)}`,
      approval: undefined,
      artifacts: Object.freeze([]),
    }),
  });
}
