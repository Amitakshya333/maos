/**
 * TASK RING-UI-01: Ring agent-run contract types (GUI consumer side).
 *
 * Codes against the RING-AGENT-LOOP-01 run API exactly:
 *   POST /api/v1/ring/runs { instruction, agentId? } -> { runId }
 *   GET  /api/v1/ring/runs/:id -> { status, mode, events, finalAnswer? }
 *   POST /api/v1/ring/runs/:id/cancel
 *   POST /api/v1/ring/runs/:id/approvals/:approvalId { decision }
 *
 * Identity honesty: the run payload carries no provider/model/served-model
 * identity, so nothing here invents one. The header badge keeps the exact
 * RING-IMPL-01 copy and the reported-id suffix stays absent unless a legacy
 * RingAskResult echoed it (ringBadgeText in RingWorkspace).
 */

export type RingRunMode = 'hosted' | 'evidence-only';

export type RingRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export type RingRunEventType =
  | 'run.started'
  | 'model.turn'
  | 'tool.call'
  | 'tool.result'
  | 'approval.pending'
  | 'approval.resolved'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export type RingApprovalDecision = 'approved' | 'denied';

export interface RingRunEvent {
  type: RingRunEventType;
  ts: string;
  /** model.turn: text the model produced this turn. */
  text?: string;
  /** tool.call / tool.result: tool name. */
  tool?: string;
  /** TASK RING-ADAPTER-01 (A5): pairing key emitted by the service on both
   *  tool.call and tool.result; chips pair by this, never by tool name. */
  toolCallId?: string;
  /** tool.call: short argument summary, rendered verbatim. */
  argsSummary?: string;
  /** tool.result: short result summary, rendered verbatim. */
  resultSummary?: string;
  /** tool.result: deterministic verdict when the tool reported one. */
  verdict?: string;
  /** tool.result: deterministic RMS when the tool reported one. */
  overallRms?: number;
  /** tool.result: cited evidence paths. */
  sources?: string[];
  /** approval.pending / approval.resolved: approval identifier. */
  approvalId?: string;
  /** approval.pending: what the agent wants to do. */
  action?: string;
  /** approval.pending: why the agent wants to do it. */
  reason?: string;
  /** approval.resolved: recorded decision. */
  decision?: RingApprovalDecision;
  /** run.failed: failure message, rendered verbatim. */
  message?: string;
}

export interface RingRunState {
  status: RingRunStatus;
  mode: RingRunMode;
  events: RingRunEvent[];
  finalAnswer?: string;
  /** Served-model id only when the server echoed one; never defaulted. */
  servedModelId?: string;
}

export interface RingRunStartResult {
  runId: string;
}

export interface RingRunRequest {
  instruction: string;
  agentId?: string;
}

const RUN_STATUSES: readonly string[] = ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled'];
const RUN_MODES: readonly string[] = ['hosted', 'evidence-only'];
const EVENT_TYPES: readonly string[] = [
  'run.started',
  'model.turn',
  'tool.call',
  'tool.result',
  'approval.pending',
  'approval.resolved',
  'run.completed',
  'run.failed',
  'run.cancelled',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const entry = record[field];
  if (entry === undefined) return undefined;
  if (typeof entry !== 'string') throw new Error(`RING_RUN_INVALID: ${field} must be a string when present.`);
  return entry;
}

/**
 * Runtime validator for one run event. Fails closed on shape violations and
 * passes optional payload fields through only when present with the right
 * type; nothing is defaulted or invented.
 */
export function validateRingRunEvent(value: unknown): RingRunEvent {
  if (!isRecord(value)) throw new Error('RING_RUN_INVALID: each event must be an object.');
  if (!EVENT_TYPES.includes(value.type as string)) {
    throw new Error('RING_RUN_INVALID: event.type is not a known run event type.');
  }
  if (typeof value.ts !== 'string' || !value.ts) {
    throw new Error('RING_RUN_INVALID: event.ts must be a non-empty string.');
  }
  const event: RingRunEvent = { type: value.type as RingRunEventType, ts: value.ts };
  event.text = optionalString(value, 'text');
  event.tool = optionalString(value, 'tool');
  event.toolCallId = optionalString(value, 'toolCallId');
  event.argsSummary = optionalString(value, 'argsSummary');
  event.resultSummary = optionalString(value, 'resultSummary');
  event.verdict = optionalString(value, 'verdict');
  event.approvalId = optionalString(value, 'approvalId');
  event.action = optionalString(value, 'action');
  event.reason = optionalString(value, 'reason');
  event.message = optionalString(value, 'message');
  if (value.overallRms !== undefined) {
    if (typeof value.overallRms !== 'number') {
      throw new Error('RING_RUN_INVALID: event.overallRms must be a number when present.');
    }
    event.overallRms = value.overallRms;
  }
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.some((s) => typeof s !== 'string')) {
      throw new Error('RING_RUN_INVALID: event.sources must be an array of strings when present.');
    }
    event.sources = value.sources as string[];
  }
  if (value.decision !== undefined) {
    if (value.decision !== 'approved' && value.decision !== 'denied') {
      throw new Error('RING_RUN_INVALID: event.decision must be approved or denied when present.');
    }
    event.decision = value.decision;
  }
  return event;
}

/** Runtime validator for GET /api/v1/ring/runs/:id. Fails closed. */
export function validateRingRunState(value: unknown): RingRunState {
  if (!isRecord(value)) throw new Error('RING_RUN_INVALID: run state must be an object.');
  if (!RUN_STATUSES.includes(value.status as string)) {
    throw new Error('RING_RUN_INVALID: status must be running, awaiting_approval, completed, failed, or cancelled.');
  }
  if (!RUN_MODES.includes(value.mode as string)) {
    throw new Error('RING_RUN_INVALID: mode must be hosted or evidence-only.');
  }
  if (!Array.isArray(value.events)) throw new Error('RING_RUN_INVALID: events must be an array.');
  const state: RingRunState = {
    status: value.status as RingRunStatus,
    mode: value.mode as RingRunMode,
    events: value.events.map(validateRingRunEvent),
  };
  if (value.finalAnswer !== undefined) {
    if (typeof value.finalAnswer !== 'string') {
      throw new Error('RING_RUN_INVALID: finalAnswer must be a string when present.');
    }
    state.finalAnswer = value.finalAnswer;
  }
  if (value.servedModelId !== undefined) {
    if (typeof value.servedModelId !== 'string' || !value.servedModelId.trim()) {
      throw new Error('RING_RUN_INVALID: servedModelId must be a non-empty string when present.');
    }
    state.servedModelId = value.servedModelId;
  }
  return state;
}

/** Runtime validator for POST /api/v1/ring/runs. Fails closed. */
export function validateRingRunStart(value: unknown): RingRunStartResult {
  if (!isRecord(value)) throw new Error('RING_RUN_INVALID: run start response must be an object.');
  if (typeof value.runId !== 'string' || !value.runId.trim()) {
    throw new Error('RING_RUN_INVALID: runId must be a non-empty string.');
  }
  return { runId: value.runId };
}
