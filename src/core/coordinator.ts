/**
 * MAOS Coordinator — Reactive Coordination Layer
 *
 * The coordinator sits between the MessageBus and the orchestrator.
 * It subscribes to events and triggers reactive behaviors:
 *
 *   1. REPLANNING  — when a subtask of an objective is dead-lettered,
 *                    the coordinator triggers ARCHITECT to redesign
 *   2. NEGOTIATION — routes request/response messages between running agents
 *   3. INBOX       — per-agent message queue for coordination messages
 *
 * The coordinator does NOT do scheduling or task dispatch. That stays
 * in orchestrator.ts. The coordinator only reacts to events.
 */

import { MessageBus, BusEvent, createEvent } from './message-bus';
import { createTask, TaskFile, getPendingTasks } from './queue';
import {
  loadObjective,
  saveObjective,
  recordChildCompletion,
  recordChildFailure,
  cancelObjectiveSubtasks,
  startReplan,
  failObjective,
  ObjectiveState,
} from './objective-store';
import { getMemoryStore } from './context-memory';
import { getCancelledDir } from '../utils/paths';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────

export interface CoordinationMessage {
  id: string;
  type: 'request' | 'response' | 'nudge' | 'handoff';
  from: string; // agentId
  to: string; // agentId or '*' for broadcast
  content: string;
  data?: Record<string, any>;
  timestamp: number;
  /** For responses: which request this answers */
  requestId?: string;
}

export interface CoordinationRequest {
  id: string;
  from: string;
  need: string;
  context: string;
  urgency: 'blocking' | 'nice_to_have';
  timestamp: number;
  resolved: boolean;
}

// ── Agent Inbox ───────────────────────────────────────────────

const MAX_INBOX_SIZE = 10;

export class AgentInbox {
  private inboxes = new Map<string, CoordinationMessage[]>();

  push(agentId: string, message: CoordinationMessage): void {
    if (!this.inboxes.has(agentId)) {
      this.inboxes.set(agentId, []);
    }
    const inbox = this.inboxes.get(agentId)!;
    inbox.push(message);

    // Cap inbox size — drop oldest with summary
    if (inbox.length > MAX_INBOX_SIZE) {
      const dropped = inbox.splice(0, inbox.length - MAX_INBOX_SIZE);
      // Add a summary message about dropped messages
      inbox.unshift({
        id: `drop_${Date.now()}`,
        type: 'nudge',
        from: 'SYSTEM',
        to: agentId,
        content: `[${dropped.length} older messages were dropped due to inbox overflow]`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Drain all messages (returns and clears).
   */
  drain(agentId: string): CoordinationMessage[] {
    const messages = this.inboxes.get(agentId) || [];
    this.inboxes.set(agentId, []);
    return messages;
  }

  /**
   * Peek without clearing.
   */
  peek(agentId: string): CoordinationMessage[] {
    return [...(this.inboxes.get(agentId) || [])];
  }

  /**
   * Check if any agent has pending messages.
   */
  hasMessages(agentId: string): boolean {
    return (this.inboxes.get(agentId)?.length || 0) > 0;
  }
}

// ── Coordinator ───────────────────────────────────────────────

export class Coordinator {
  private bus: MessageBus;
  private inbox: AgentInbox;
  private pendingRequests = new Map<string, CoordinationRequest>();
  private cwd: string;
  private logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  private requestCounter = 0;

  constructor(
    bus: MessageBus,
    cwd: string,
    logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void },
  ) {
    this.bus = bus;
    this.cwd = cwd;
    this.logger = logger;
    this.inbox = new AgentInbox();

    this.wireEventHandlers();
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Get the agent inbox (for agent-runner to drain messages each iteration).
   */
  getInbox(): AgentInbox {
    return this.inbox;
  }

  /**
   * Handle a coordination request from an agent (via request_from_team tool).
   */
  handleRequest(agentId: string, taskId: string, need: string, context: string, urgency: string): string {
    const requestId = `req_${++this.requestCounter}_${Date.now()}`;

    const request: CoordinationRequest = {
      id: requestId,
      from: agentId,
      need,
      context,
      urgency: urgency === 'blocking' ? 'blocking' : 'nice_to_have',
      timestamp: Date.now(),
      resolved: false,
    };

    this.pendingRequests.set(requestId, request);

    // First: try to resolve from context memory
    const memStore = getMemoryStore();
    if (memStore) {
      const byTag = memStore.searchByTag(need);
      const byContent = memStore.searchByContent(need);
      const matches = [...new Set([...byTag, ...byContent])];

      if (matches.length > 0) {
        // Auto-resolve from memory
        const best = matches[matches.length - 1]; // Most recent match
        this.inbox.push(agentId, {
          id: `resp_${requestId}`,
          type: 'response',
          from: best.agentId,
          to: agentId,
          content: `[AUTO-RESOLVED from team memory]\n${best.content}`,
          data: { source: 'memory', memoryId: best.id },
          timestamp: Date.now(),
          requestId,
        });
        request.resolved = true;
        this.logger.info('COORDINATOR', `Auto-resolved request "${need}" from ${agentId} via memory`);
        return requestId;
      }
    }

    // Not found in memory — broadcast to team via bus
    this.bus.emit(
      createEvent(
        'COORD_REQUEST',
        agentId,
        {
          requestId,
          need,
          context,
          urgency,
        },
        taskId,
      ),
    );

    this.logger.info('COORDINATOR', `Request "${need}" from ${agentId} → broadcast to team`);
    return requestId;
  }

  /**
   * Handle a coordination response from an agent (via respond_to_team tool).
   */
  handleResponse(agentId: string, requestId: string, response: string, responseData?: Record<string, any>): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      this.logger.warn('COORDINATOR', `Response for unknown request: ${requestId}`);
      return;
    }

    if (request.resolved) {
      this.logger.warn('COORDINATOR', `Request ${requestId} already resolved, ignoring duplicate response`);
      return;
    }

    request.resolved = true;

    // Deliver to requester's inbox
    this.inbox.push(request.from, {
      id: `resp_${requestId}`,
      type: 'response',
      from: agentId,
      to: request.from,
      content: response,
      data: responseData,
      timestamp: Date.now(),
      requestId,
    });

    // Also store in context memory for future agents
    const memStore = getMemoryStore();
    if (memStore) {
      memStore.add({
        agentId,
        taskId: '',
        type: 'DISCOVERY',
        content: `[Response to "${request.need}"]\n${response}`,
        tags: [request.need.toLowerCase().replace(/\s+/g, '-')],
        confidence: 0.9,
      });
    }

    this.bus.emit(
      createEvent('COORD_RESPONSE', agentId, {
        requestId,
        respondedTo: request.from,
      }),
    );

    this.logger.info('COORDINATOR', `${agentId} responded to ${request.from}'s request "${request.need}"`);
  }

  /**
   * Handle subtask completion (update objective state).
   */
  handleSubtaskCompletion(taskId: string, objectiveId: string): void {
    if (!objectiveId) return;
    recordChildCompletion(objectiveId, taskId, this.cwd);
    this.logger.info('COORDINATOR', `Subtask ${taskId} completed for objective ${objectiveId}`);

    // Check if objective is now done
    const obj = loadObjective(objectiveId, this.cwd);
    if (obj && obj.status === 'done') {
      this.bus.emit(
        createEvent('OBJECTIVE_COMPLETED', 'COORDINATOR', {
          objectiveId: obj.id,
          goal: obj.goal,
          subtasksCompleted: obj.completedChildIds.length,
        }),
      );
      this.logger.info('COORDINATOR', `🎉 Objective COMPLETED: ${obj.goal}`);
    }
  }

  /**
   * Get pending requests for an agent (shown in their system prompt as "team needs").
   */
  getPendingRequestsForAgent(agentId: string, capabilities: string[]): CoordinationRequest[] {
    return [...this.pendingRequests.values()].filter((req) => !req.resolved && req.from !== agentId);
  }

  /**
   * Format inbox messages for injection into agent conversation.
   */
  formatInboxMessages(messages: CoordinationMessage[]): string {
    if (messages.length === 0) return '';

    const lines = messages.map((msg) => {
      switch (msg.type) {
        case 'response':
          return `[TEAM RESPONSE from ${msg.from}]\n${msg.content}`;
        case 'request':
          return `[TEAM REQUEST from ${msg.from}]\nNeed: ${msg.content}\nUse respond_to_team(requestId: "${msg.requestId}") to answer.`;
        case 'nudge':
          return `[SUPERVISOR]\n${msg.content}`;
        case 'handoff':
          return `[HANDOFF from ${msg.from}]\n${msg.content}`;
        default:
          return `[${msg.from}] ${msg.content}`;
      }
    });

    return `\n## Team Messages (${messages.length} new)\n\n${lines.join('\n\n')}\n`;
  }

  // ── Event Handlers ────────────────────────────────────────

  private wireEventHandlers(): void {
    // ── Subtask failure → trigger replanning ──
    this.bus.on('TASK_FAILED', (event: BusEvent) => {
      this.onTaskFailed(event);
    });

    // ── Subtask completion → update objective ──
    this.bus.on('TASK_COMPLETED', (event: BusEvent) => {
      this.onTaskCompleted(event);
    });

    // ── Coordination request → route to agents ──
    this.bus.on('COORD_REQUEST', (event: BusEvent) => {
      this.onCoordRequest(event);
    });
  }

  private onTaskCompleted(event: BusEvent): void {
    if (!event.taskId) return;

    // Look up the task's objective
    // We check the event data for objectiveId (set by orchestrator)
    const objectiveId = event.data?.objectiveId;
    if (objectiveId) {
      this.handleSubtaskCompletion(event.taskId, objectiveId);
    }
  }

  private onTaskFailed(event: BusEvent): void {
    if (!event.taskId) return;

    const objectiveId = event.data?.objectiveId;
    const isDeadLettered = event.data?.deadLettered === true;
    if (!objectiveId || !isDeadLettered) return;

    // A subtask of an objective has been permanently dead-lettered
    recordChildFailure(objectiveId, event.taskId, this.cwd);

    const obj = loadObjective(objectiveId, this.cwd);
    if (!obj) return;

    // Guard against concurrent replan triggers if objective is already replanning, done, or failed
    if (obj.status === 'replanning' || obj.status === 'failed' || obj.status === 'done') {
      this.logger.info('COORDINATOR', `Skipping replan for objective ${obj.id} — already in status "${obj.status}"`);
      return;
    }

    // Trigger replanning
    this.triggerReplan(obj, event.taskId, event.data?.error || 'Unknown error');
  }

  private onCoordRequest(event: BusEvent): void {
    if (!event.data?.requestId) return;

    // Broadcast the request to all agents' inboxes
    // The orchestrator will inject these into agent prompts
    const request = this.pendingRequests.get(event.data.requestId);
    if (!request || request.resolved) return;

    // We don't know which agents can answer — broadcast is handled by
    // the supervisor or by agents seeing "pending team requests" in prompt
  }

  // ── Replanning Logic ──────────────────────────────────────

  private triggerReplan(obj: ObjectiveState, failedTaskId: string, errorMessage: string): void {
    // Check replan budget
    const updated = startReplan(obj.id, this.cwd);
    if (!updated) return;

    if (updated.status === 'failed') {
      this.bus.emit(
        createEvent('OBJECTIVE_FAILED', 'COORDINATOR', {
          objectiveId: obj.id,
          reason: 'max replans exceeded',
          failedTaskId,
        }),
      );
      this.logger.error('COORDINATOR', `Objective ${obj.id} FAILED: max replans (${obj.maxReplanAttempts}) exceeded`);
      return;
    }

    // Cancel remaining pending subtasks of this objective
    const pendingSubtasks = getPendingTasks(this.cwd).filter((t) => t.objectiveId === obj.id);
    if (pendingSubtasks.length > 0) {
      const cancelledIds = pendingSubtasks.map((t) => t.id);
      cancelObjectiveSubtasks(obj.id, cancelledIds, this.cwd);

      // Move cancelled task files to cancelled/
      const cancelledDir = getCancelledDir(this.cwd);
      if (!fs.existsSync(cancelledDir)) fs.mkdirSync(cancelledDir, { recursive: true });
      for (const task of pendingSubtasks) {
        try {
          const dest = path.join(cancelledDir, path.basename(task.filePath));
          fs.renameSync(task.filePath, dest);
        } catch {
          /* non-fatal */
        }
      }

      this.logger.info('COORDINATOR', `Cancelled ${cancelledIds.length} pending subtasks for replan`);
    }

    // Build replan context
    const completedSummary = obj.completedChildIds.map((id) => `✅ ${id}`).join('\n');
    const failedSummary = obj.failedChildIds.map((id) => `❌ ${id}`).join('\n');
    const prevPlanTasks =
      obj.planHistory.length > 0 ? obj.planHistory[obj.planHistory.length - 1].taskIds.join(', ') : 'none';

    // Create a REPLAN task for ARCHITECT
    createTask({
      type: 'objective',
      objectiveId: obj.id,
      depth: 0,
      description: `## REPLAN: ${obj.goal}

### Replan Attempt ${updated.replanCount} of ${obj.maxReplanAttempts}

### What Failed
Task ${failedTaskId} failed permanently after all retries.

### Error
${errorMessage}

### Completed Work (preserve this)
${completedSummary || 'Nothing completed yet.'}

### Failed Work
${failedSummary}

### Previous Plan (v${obj.version})
Tasks: ${prevPlanTasks}

### Instructions
1. Analyze WHY the task failed.
2. Design an ALTERNATIVE approach that avoids the failure mode.
3. You may reuse completed work — do NOT redo what's already done.
4. Create NEW subtasks for the remaining work only.
5. Do NOT retry the exact same approach that failed.
`,
      capabilities: ['planning', 'decomposition'],
      complexity: 'high',
      category: 'planning',
      cwd: this.cwd,
    });

    this.bus.emit(
      createEvent('OBJECTIVE_REPLANNING', 'COORDINATOR', {
        objectiveId: obj.id,
        replanCount: updated.replanCount,
        failedTaskId,
      }),
    );

    this.logger.info(
      'COORDINATOR',
      `Triggered REPLAN for "${obj.goal}" (attempt ${updated.replanCount}/${obj.maxReplanAttempts})`,
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────

let _coordinator: Coordinator | null = null;

export function createCoordinator(
  bus: MessageBus,
  cwd: string,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void },
): Coordinator {
  _coordinator = new Coordinator(bus, cwd, logger);
  return _coordinator;
}

export function getCoordinator(): Coordinator | null {
  return _coordinator;
}
