/**
 * UI1-02: Runtime Schema & Envelope Validation
 *
 * Enforces runtime contract validation on all data received over the network.
 * Fail closed: unknown versions or malformed envelopes throw visible typed errors.
 */

import { SchemaVersionError, RuntimeValidationError } from './errors';
import type {
  Task,
  Run,
  ModelLease,
  AuditRecord,
  SequencedEvent,
  Conversation,
  Message,
} from '../../../domain/schemas';
import type { ModelResidencyStatus } from '../../../domain/model-manifest';
import type { QueueEntry, QueueStatusSummary } from '../../../domain/fair-queue';
import type {
  ActiveModelIdentity,
  ModelRouteResult,
  ModelSwitchResult,
} from '../../../domain/model-switch';
import type {
  ApprovalRecord,
  ApprovalCheckResult,
  ForceStopResult,
} from '../../../domain/approval';
import type { CockpitState, CockpitRunSummary } from '../../../domain/cockpit';

/**
 * Validate that an object has the expected schemaVersion (default 1).
 */
export function assertSchemaVersion(
  entity: unknown,
  entityName = 'Entity',
  expectedVersion = 1,
): void {
  if (!entity || typeof entity !== 'object') {
    throw new RuntimeValidationError(entityName, ['Expected non-null object']);
  }
  const record = entity as Record<string, unknown>;
  if (record.schemaVersion === undefined) {
    throw new RuntimeValidationError(entityName, ['Missing required field: schemaVersion']);
  }
  if (record.schemaVersion !== expectedVersion) {
    throw new SchemaVersionError(record.schemaVersion, expectedVersion, entityName);
  }
}

/**
 * Validate standard REST response envelope:
 * { success: boolean; data?: T; error?: ... }
 */
export function validateEnvelope<T>(
  data: unknown,
  endpointName = 'API',
): T {
  if (!data || typeof data !== 'object') {
    throw new RuntimeValidationError(endpointName, ['Response body is not an object']);
  }
  const record = data as Record<string, unknown>;
  if (record.success === false) {
    const errorObj = (record.error as Record<string, unknown>) || {};
    throw new RuntimeValidationError(
      endpointName,
      [String(errorObj.message || 'API operation reported failure')],
      record,
    );
  }
  // If data property exists, return it; otherwise return the record itself
  return (record.data !== undefined ? record.data : record) as T;
}

/**
 * Validates a Task domain entity.
 */
export function validateTask(task: unknown): Task {
  assertSchemaVersion(task, 'Task', 1);
  const t = task as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof t.id !== 'string' || !t.id.trim()) errors.push('Missing or invalid id');
  if (typeof t.description !== 'string') errors.push('Missing or invalid description');
  if (typeof t.status !== 'string') errors.push('Missing or invalid status');

  if (errors.length > 0) {
    throw new RuntimeValidationError('Task', errors, task);
  }
  return task as Task;
}

/**
 * Validates an array of Tasks.
 */
export function validateTasksList(tasks: unknown): Task[] {
  if (!Array.isArray(tasks)) {
    throw new RuntimeValidationError('TasksList', ['Expected array of tasks']);
  }
  return tasks.map((t) => validateTask(t));
}

/**
 * Validates a Run domain entity.
 */
export function validateRun(run: unknown): Run {
  assertSchemaVersion(run, 'Run', 1);
  const r = run as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.id !== 'string' || !r.id.trim()) errors.push('Missing or invalid id');
  if (typeof r.taskId !== 'string') errors.push('Missing or invalid taskId');

  if (errors.length > 0) {
    throw new RuntimeValidationError('Run', errors, run);
  }
  return run as Run;
}

/**
 * Validates an array of Runs.
 */
export function validateRunsList(runs: unknown): Run[] {
  if (!Array.isArray(runs)) {
    throw new RuntimeValidationError('RunsList', ['Expected array of runs']);
  }
  return runs.map((r) => validateRun(r));
}

/**
 * Validates a ModelLease domain entity.
 */
export function validateModelLease(lease: unknown): ModelLease {
  assertSchemaVersion(lease, 'ModelLease', 1);
  const l = lease as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof l.id !== 'string' || !l.id.trim()) errors.push('Missing or invalid id');
  if (typeof l.modelId !== 'string') errors.push('Missing or invalid modelId');

  if (errors.length > 0) {
    throw new RuntimeValidationError('ModelLease', errors, lease);
  }
  return lease as ModelLease;
}

/**
 * Validates an array of ModelLeases.
 */
export function validateModelLeasesList(leases: unknown): ModelLease[] {
  if (!Array.isArray(leases)) {
    throw new RuntimeValidationError('ModelLeasesList', ['Expected array of model leases']);
  }
  return leases.map((l) => validateModelLease(l));
}

/**
 * Validates a ModelResidencyStatus entity.
 */
export function validateModelResidencyStatus(status: unknown): ModelResidencyStatus {
  if (!status || typeof status !== 'object') {
    throw new RuntimeValidationError('ModelResidencyStatus', ['Expected non-null object']);
  }
  const s = status as Record<string, unknown>;
  const errors: string[] = [];
  if (s.residentModelId !== null && typeof s.residentModelId !== 'string') {
    errors.push('residentModelId must be string or null');
  }
  if (typeof s.vramUsedMb !== 'number') errors.push('vramUsedMb must be a number');
  if (typeof s.vramBudgetMb !== 'number') errors.push('vramBudgetMb must be a number');
  if (typeof s.activeLeases !== 'number') errors.push('activeLeases must be a number');
  if (typeof s.queueLength !== 'number') errors.push('queueLength must be a number');
  if (typeof s.healthy !== 'boolean') errors.push('healthy must be a boolean');

  if (errors.length > 0) {
    throw new RuntimeValidationError('ModelResidencyStatus', errors, status);
  }
  return status as ModelResidencyStatus;
}

/**
 * Validates an AuditRecord domain entity.
 */
export function validateAuditRecord(event: unknown): AuditRecord {
  assertSchemaVersion(event, 'AuditRecord', 1);
  const e = event as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof e.sequence !== 'number') errors.push('Missing or invalid sequence');
  if (typeof e.category !== 'string') errors.push('Missing or invalid category');
  if (typeof e.hash !== 'string') errors.push('Missing or invalid hash');

  if (errors.length > 0) {
    throw new RuntimeValidationError('AuditRecord', errors, event);
  }
  return event as AuditRecord;
}

/**
 * Validates an array of AuditRecords.
 */
export function validateAuditRecordsList(events: unknown): AuditRecord[] {
  if (!Array.isArray(events)) {
    throw new RuntimeValidationError('AuditRecordsList', ['Expected array of audit records']);
  }
  return events.map((e) => validateAuditRecord(e));
}

/**
 * Validates a SequencedEvent received over WebSocket or REST.
 */
export function validateSequencedEvent(event: unknown): SequencedEvent {
  assertSchemaVersion(event, 'SequencedEvent', 1);
  const e = event as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof e.eventId !== 'string' || !e.eventId.trim()) errors.push('Missing or invalid eventId');
  if (typeof e.sequence !== 'number' || e.sequence < 1) errors.push('Missing or invalid positive sequence');
  if (typeof e.eventType !== 'string' || !e.eventType.trim()) errors.push('Missing or invalid eventType');
  if (typeof e.projectId !== 'string') errors.push('Missing or invalid projectId');
  if (typeof e.occurredAt !== 'string') errors.push('Missing or invalid occurredAt');

  if (errors.length > 0) {
    throw new RuntimeValidationError('SequencedEvent', errors, event);
  }
  return event as SequencedEvent;
}

/**
 * Validates Health check response.
 */
export function validateHealthResponse(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    throw new RuntimeValidationError('HealthResponse', ['Response is not an object']);
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec.status !== 'string') {
    throw new RuntimeValidationError('HealthResponse', ['Missing required status field']);
  }
  return rec;
}

/**
 * Validates a Message domain entity.
 */
export function validateMessage(msg: unknown): Message {
  assertSchemaVersion(msg, 'Message', 1);
  const m = msg as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof m.id !== 'string' || !m.id.trim()) errors.push('Missing or invalid id');
  if (typeof m.role !== 'string') errors.push('Missing or invalid role');
  if (typeof m.timestamp !== 'string') errors.push('Missing or invalid timestamp');
  if (errors.length > 0) {
    throw new RuntimeValidationError('Message', errors, msg);
  }
  return msg as Message;
}

/**
 * Validates a Conversation domain entity.
 */
export function validateConversation(conv: unknown): Conversation {
  assertSchemaVersion(conv, 'Conversation', 1);
  const c = conv as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.id !== 'string' || !c.id.trim()) errors.push('Missing or invalid id');
  if (typeof c.projectId !== 'string') errors.push('Missing or invalid projectId');
  if (typeof c.agentId !== 'string') errors.push('Missing or invalid agentId');
  if (!Array.isArray(c.messages)) errors.push('Missing or invalid messages array');
  if (errors.length > 0) {
    throw new RuntimeValidationError('Conversation', errors, conv);
  }
  return conv as Conversation;
}

/**
 * Validates an array of Conversations.
 */
export function validateConversationsList(convs: unknown): Conversation[] {
  if (!Array.isArray(convs)) {
    throw new RuntimeValidationError('ConversationsList', ['Expected array of conversations']);
  }
  return convs.map((c) => validateConversation(c));
}

/**
 * Validates a QueueEntry domain entity.
 */
export function validateQueueEntry(entry: unknown): QueueEntry {
  if (!entry || typeof entry !== 'object') {
    throw new RuntimeValidationError('QueueEntry', ['Expected non-null object']);
  }
  const e = entry as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof e.id !== 'string' || !e.id.trim()) errors.push('Missing or invalid id');
  if (typeof e.state !== 'string') errors.push('Missing or invalid state');
  if (typeof e.priorityClass !== 'string') errors.push('Missing or invalid priorityClass');
  if (typeof e.requestedModelId !== 'string') errors.push('Missing or invalid requestedModelId');
  if (errors.length > 0) {
    throw new RuntimeValidationError('QueueEntry', errors, entry);
  }
  return entry as QueueEntry;
}

/**
 * Validates an array of QueueEntries.
 */
export function validateQueueEntriesList(entries: unknown): QueueEntry[] {
  if (!Array.isArray(entries)) {
    throw new RuntimeValidationError('QueueEntriesList', ['Expected array of queue entries']);
  }
  return entries.map((e) => validateQueueEntry(e));
}

/**
 * Validates a QueueStatusSummary object.
 */
export function validateQueueStatusSummary(summary: unknown): QueueStatusSummary {
  if (!summary || typeof summary !== 'object') {
    throw new RuntimeValidationError('QueueStatusSummary', ['Expected non-null object']);
  }
  const s = summary as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof s.totalQueued !== 'number') errors.push('Missing or invalid totalQueued');
  if (typeof s.activeRunning !== 'number') errors.push('Missing or invalid activeRunning');
  if (!Array.isArray(s.entries)) errors.push('Missing or invalid entries array');
  if (errors.length > 0) {
    throw new RuntimeValidationError('QueueStatusSummary', errors, summary);
  }
  return summary as QueueStatusSummary;
}

/**
 * Validates an ActiveModelIdentity object.
 */
export function validateActiveModelIdentity(identity: unknown): ActiveModelIdentity {
  if (!identity || typeof identity !== 'object') {
    throw new RuntimeValidationError('ActiveModelIdentity', ['Expected non-null object']);
  }
  const rec = identity as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof rec.healthy !== 'boolean') errors.push('Missing or invalid healthy boolean');
  if (typeof rec.isWorkflowFixed !== 'boolean') errors.push('Missing or invalid isWorkflowFixed boolean');
  if (typeof rec.vramUsedMb !== 'number') errors.push('Missing or invalid vramUsedMb');
  if (errors.length > 0) {
    throw new RuntimeValidationError('ActiveModelIdentity', errors, identity);
  }
  return identity as ActiveModelIdentity;
}

/**
 * Validates a ModelRouteResult object.
 */
export function validateModelRouteResult(result: unknown): ModelRouteResult {
  if (!result || typeof result !== 'object') {
    throw new RuntimeValidationError('ModelRouteResult', ['Expected non-null object']);
  }
  const rec = result as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof rec.selectedModelId !== 'string') errors.push('Missing or invalid selectedModelId');
  if (typeof rec.reason !== 'string') errors.push('Missing or invalid reason');
  if (typeof rec.confidence !== 'number') errors.push('Missing or invalid confidence');
  if (errors.length > 0) {
    throw new RuntimeValidationError('ModelRouteResult', errors, result);
  }
  return result as ModelRouteResult;
}

/**
 * Validates a ModelSwitchResult object.
 */
export function validateModelSwitchResult(result: unknown): ModelSwitchResult {
  if (!result || typeof result !== 'object') {
    throw new RuntimeValidationError('ModelSwitchResult', ['Expected non-null object']);
  }
  const rec = result as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof rec.status !== 'string') errors.push('Missing or invalid status');
  if (typeof rec.activeModelId !== 'string') errors.push('Missing or invalid activeModelId');
  if (typeof rec.message !== 'string') errors.push('Missing or invalid message');
  if (errors.length > 0) {
    throw new RuntimeValidationError('ModelSwitchResult', errors, result);
  }
  return result as ModelSwitchResult;
}

/**
 * Validates an ApprovalRecord domain entity with 15 required fields.
 */
export function validateApprovalRecord(approval: unknown): ApprovalRecord {
  assertSchemaVersion(approval, 'ApprovalRecord', 1);
  const rec = approval as Record<string, unknown>;
  const errors: string[] = [];

  const reqStrings = [
    'approvalId',
    'projectId',
    'runId',
    'taskId',
    'stepId',
    'actorId',
    'actorRole',
    'status',
    'reason',
    'scope',
    'createdAt',
    'expiresAt',
    'payloadHash',
  ];

  for (const f of reqStrings) {
    if (typeof rec[f] !== 'string' || !(rec[f] as string).trim()) {
      errors.push(`Missing or invalid ${f}`);
    }
  }

  if (!Array.isArray(rec.sourceHashes)) errors.push('Missing or invalid sourceHashes array');
  if (!Array.isArray(rec.artifactIds)) errors.push('Missing or invalid artifactIds array');

  if (errors.length > 0) {
    throw new RuntimeValidationError('ApprovalRecord', errors, approval);
  }
  return approval as ApprovalRecord;
}

/**
 * Validates an array of ApprovalRecords.
 */
export function validateApprovalsList(approvals: unknown): ApprovalRecord[] {
  if (!Array.isArray(approvals)) {
    throw new RuntimeValidationError('ApprovalsList', ['Expected array of approvals']);
  }
  return approvals.map((a) => validateApprovalRecord(a));
}

/**
 * Validates an ApprovalCheckResult.
 */
export function validateApprovalCheckResult(result: unknown): ApprovalCheckResult {
  if (!result || typeof result !== 'object') {
    throw new RuntimeValidationError('ApprovalCheckResult', ['Expected non-null object']);
  }
  const rec = result as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof rec.valid !== 'boolean') errors.push('Missing or invalid valid boolean');
  if (errors.length > 0) {
    throw new RuntimeValidationError('ApprovalCheckResult', errors, result);
  }
  return result as ApprovalCheckResult;
}

/**
 * Validates a ForceStopResult.
 */
export function validateForceStopResult(result: unknown): ForceStopResult {
  if (!result || typeof result !== 'object') {
    throw new RuntimeValidationError('ForceStopResult', ['Expected non-null object']);
  }
  const rec = result as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof rec.success !== 'boolean') errors.push('Missing or invalid success boolean');
  if (typeof rec.status !== 'string') errors.push('Missing or invalid status');
  if (typeof rec.taskId !== 'string') errors.push('Missing or invalid taskId');
  if (typeof rec.runId !== 'string') errors.push('Missing or invalid runId');
  if (typeof rec.stoppedAt !== 'string') errors.push('Missing or invalid stoppedAt');
  if (errors.length > 0) {
    throw new RuntimeValidationError('ForceStopResult', errors, result);
  }
  return result as ForceStopResult;
}

/**
 * Validates a CockpitState object.
 */
export function validateCockpitState(data: unknown): CockpitState {
  assertSchemaVersion(data, 'CockpitState', 1);
  const rec = data as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof rec.projectId !== 'string' || !rec.projectId.trim()) {
    errors.push('Missing or invalid projectId');
  }
  if (typeof rec.runId !== 'string' || !rec.runId.trim()) {
    errors.push('Missing or invalid runId');
  }
  if (typeof rec.status !== 'string') {
    errors.push('Missing or invalid status');
  }
  if (!Array.isArray(rec.nodes)) {
    errors.push('Missing or invalid nodes array');
  }
  if (!Array.isArray(rec.edges)) {
    errors.push('Missing or invalid edges array');
  }
  if (!rec.totalTokens || typeof rec.totalTokens !== 'object') {
    errors.push('Missing or invalid totalTokens object');
  }
  if (typeof rec.totalLatencyMs !== 'number') {
    errors.push('Missing or invalid totalLatencyMs number');
  }
  if (typeof rec.currentCursor !== 'number') {
    errors.push('Missing or invalid currentCursor number');
  }
  if (typeof rec.forceStopped !== 'boolean') {
    errors.push('Missing or invalid forceStopped boolean');
  }
  if (typeof rec.lastUpdated !== 'string') {
    errors.push('Missing or invalid lastUpdated string');
  }

  if (errors.length > 0) {
    throw new RuntimeValidationError('CockpitState', errors, data);
  }

  return data as CockpitState;
}

/**
 * Validates a list of CockpitRunSummary objects.
 */
export function validateCockpitRunsList(data: unknown): CockpitRunSummary[] {
  if (!Array.isArray(data)) {
    throw new RuntimeValidationError('CockpitRunsList', ['Expected array of runs']);
  }
  return data as CockpitRunSummary[];
}

