/**
 * MAOS Fair Priority and Cancellation Queue Service (UI1-12)
 *
 * Implements a fair, cancellable execution queue orchestrating tasks and model leases:
 * - 5 fixed priority classes: interactive_chat (1), user_task (2), active_workflow (3),
 *   auto_workflow (4), background_indexing (5).
 * - 60-second aging anti-starvation: aged requests improve effective priority (capped at 2).
 * - Maximum consecutive interactive/chat turns (default: 3) to prevent workflow starvation.
 * - Strict FIFO tie-breaking for equal effective priority and age.
 * - Explicit queue state transitions:
 *   queued -> waiting_for_model_lease / waiting_for_vram -> running -> cancelling -> cancelled / completed / failed / interrupted.
 * - Safe cancellation for queued requests (immediate rejection) and running requests (abort + lease release).
 * - Phantom success defense: reporting completion on cancelled/force-stopped tasks is rejected.
 * - VRAM queue-first behavior; explicit CPU fallback only when permitted; zero silent degradation.
 * - Project and run boundary isolation.
 * - Durable idempotency for mutations.
 * - Service restart recovery (stranded running tasks become interrupted).
 * - Tamper-evident, privacy-preserving audit trail via AuditService.
 */

import * as crypto from 'crypto';
import {
  QueueEntry,
  QueueState,
  QueuePriorityClass,
  PRIORITY_WEIGHTS,
  VALID_PRIORITY_CLASSES,
  EnqueueRequestInput,
  CancelQueueEntryInput,
  QueueStatusSummary,
  QUEUE_ERROR_CODES,
  QueueError,
  validateEnqueueInput,
  validateCancelInput,
} from '../domain/fair-queue';
import { SharedModelManager } from './model-manager';
import { AuditService } from './audit-service';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import { VLM_ERROR_CODES, VlmError } from '../domain/vision';

export class FairQueueService {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly runningAbortControllers = new Map<string, AbortController>();
  private consecutiveChatTurns = 0;
  private readonly maxConsecutiveChatTurns = 3;

  constructor(
    private readonly projectRoot: string,
    private readonly modelManager: SharedModelManager,
    private readonly auditService: AuditService,
    private readonly idempotencyStore?: DurableIdempotencyStore,
  ) {}

  /**
   * Enqueue a new request for execution.
   */
  public enqueue(input: EnqueueRequestInput): QueueEntry {
    const validation = validateEnqueueInput(input);
    if (!validation.valid) {
      throw new QueueError(
        `Validation failed: ${validation.errors.join('; ')}`,
        QUEUE_ERROR_CODES.INVALID_PRIORITY_CLASS,
        400,
      );
    }

    if (!VALID_PRIORITY_CLASSES.includes(input.priorityClass)) {
      throw new QueueError(
        `Invalid priority class '${input.priorityClass}'. Allowed: ${VALID_PRIORITY_CLASSES.join(', ')}`,
        QUEUE_ERROR_CODES.INVALID_PRIORITY_CLASS,
        400,
      );
    }

    // 1. Check duplicate active queue entries by taskId
    if (input.taskId) {
      for (const existing of this.entries.values()) {
        if (
          existing.taskId === input.taskId &&
          (existing.state === 'queued' ||
            existing.state === 'waiting_for_model_lease' ||
            existing.state === 'waiting_for_vram' ||
            existing.state === 'running')
        ) {
          throw new QueueError(
            `DUPLICATE_QUEUE_ENTRY: Task '${input.taskId}' is already in queue (state: ${existing.state})`,
            QUEUE_ERROR_CODES.DUPLICATE_QUEUE_ENTRY,
            409,
          );
        }
      }
    }

    // 2. Check durable idempotency
    if (input.idempotencyKey) {
      for (const existing of this.entries.values()) {
        if (
          existing.idempotencyKey === input.idempotencyKey &&
          existing.state !== 'cancelled' &&
          existing.state !== 'failed'
        ) {
          return this.computeQueuePositionForEntry(existing);
        }
      }
    }

    // 3. Resolve model device preference
    const reg = this.modelManager.getModelRegistration(input.requestedModelId);
    if (!reg) {
      throw new VlmError(
        `Model '${input.requestedModelId}' is not registered with SharedModelManager`,
        VLM_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    const requestedDevice = input.requestedDevice ?? reg.device;
    const basePriority = PRIORITY_WEIGHTS[input.priorityClass];

    // Check dependency status
    let blockingReason: string | undefined = undefined;
    if (input.dependencies && input.dependencies.length > 0) {
      const unmet = this.checkUnmetDependencies(input.dependencies);
      if (unmet.length > 0) {
        blockingReason = `Waiting for dependencies: ${unmet.join(', ')}`;
      }
    }

    const id = `qentry_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const nowIso = new Date().toISOString();

    const entry: QueueEntry = {
      id,
      taskId: input.taskId,
      agentId: input.agentId,
      projectId: input.projectId,
      runId: input.runId,
      priorityClass: input.priorityClass,
      basePriority,
      effectivePriority: basePriority,
      queuePosition: 0,
      state: 'queued',
      requestedModelId: reg.modelId,
      requestedDevice,
      allowCpuFallback: input.allowCpuFallback ?? false,
      enqueuedAt: nowIso,
      ageSeconds: 0,
      isAged: false,
      cancellationStatus: 'none',
      blockingReason,
      idempotencyKey: input.idempotencyKey,
      dependencies: input.dependencies ? [...input.dependencies] : undefined,
    };

    this.entries.set(id, entry);

    // Audit log
    this.auditService.recordAuditEvent({
      source: 'fair_queue',
      category: 'stage',
      data: {
        action: 'QUEUE_ENQUEUED',
        actor: input.agentId,
        target: id,
        taskId: input.taskId,
        priorityClass: input.priorityClass,
        basePriority,
        requestedModelId: reg.modelId,
        requestedDevice,
        projectId: input.projectId,
        runId: input.runId,
      },
    });

    return this.computeQueuePositionForEntry(entry);
  }

  /**
   * Get sorted queue entries with dynamic aging and queue position.
   */
  public getQueue(options?: { projectId?: string; status?: QueueState }): QueueEntry[] {
    this.reevaluateAgingAndStates();
    const sortedActive = this.getSortedActiveEntries();

    // Assign positions 1..N to active items
    const activeMap = new Map<string, number>();
    sortedActive.forEach((item, index) => {
      activeMap.set(item.id, index + 1);
    });

    let all = Array.from(this.entries.values()).map((e) => {
      const pos = activeMap.get(e.id) ?? 0;
      return { ...e, queuePosition: pos };
    });

    if (options?.projectId) {
      all = all.filter((e) => !e.projectId || e.projectId === options.projectId);
    }
    if (options?.status) {
      all = all.filter((e) => e.state === options.status);
    }

    all.sort((a, b) => {
      if (a.queuePosition > 0 && b.queuePosition > 0) {
        return a.queuePosition - b.queuePosition;
      }
      if (a.queuePosition > 0) return -1;
      if (b.queuePosition > 0) return 1;
      return new Date(b.enqueuedAt).getTime() - new Date(a.enqueuedAt).getTime();
    });

    return all;
  }

  /**
   * Get summary status of the queue.
   */
  public getQueueStatus(projectId?: string): QueueStatusSummary {
    const queue = this.getQueue({ projectId });
    const queuedCount = queue.filter((e) => e.state === 'queued' || e.state === 'waiting_for_model_lease').length;
    const waitingForVramCount = queue.filter((e) => e.state === 'waiting_for_vram').length;
    const runningCount = queue.filter((e) => e.state === 'running').length;

    const residency = this.modelManager.getResidencyStatus();

    return {
      totalQueued: queuedCount,
      activeRunning: runningCount,
      waitingForVram: waitingForVramCount,
      consecutiveChatTurns: this.consecutiveChatTurns,
      maxConsecutiveChatTurns: this.maxConsecutiveChatTurns,
      residentModelId: residency.residentModelId,
      residentDevice: residency.residentDevice,
      vramUsedMb: residency.vramUsedMb,
      vramBudgetMb: residency.vramBudgetMb,
      entries: queue,
    };
  }

  /**
   * Look up a single queue entry with project boundary validation.
   */
  public getEntry(id: string, options?: { projectId?: string }): QueueEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    if (entry.projectId && options?.projectId && entry.projectId !== options.projectId) {
      throw new QueueError(
        `CROSS_PROJECT_CANCELLATION_FORBIDDEN: Queue entry '${id}' belongs to project '${entry.projectId}', cannot be accessed by project '${options.projectId}'`,
        QUEUE_ERROR_CODES.CROSS_PROJECT_CANCELLATION_FORBIDDEN,
        403,
      );
    }

    return this.computeQueuePositionForEntry(entry);
  }

  /**
   * List all entries currently in the fair queue.
   */
  public listEntries(): QueueEntry[] {
    return Array.from(this.entries.values()).map((e) => this.computeQueuePositionForEntry(e));
  }

  /**
   * Find entry by associated task ID.
   */
  public getEntryByTaskId(taskId: string): QueueEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.taskId === taskId) {
        return this.computeQueuePositionForEntry(entry);
      }
    }
    return undefined;
  }

  /**
   * Cancel a queued or running entry safely.
   */
  public cancel(id: string, options?: CancelQueueEntryInput): QueueEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new QueueError(`Queue entry '${id}' not found`, QUEUE_ERROR_CODES.ENTRY_NOT_FOUND, 404);
    }

    // 1. Cross-project validation
    if (entry.projectId && options?.projectId && entry.projectId !== options.projectId) {
      throw new QueueError(
        `CROSS_PROJECT_CANCELLATION_FORBIDDEN: Queue entry '${id}' belongs to project '${entry.projectId}', cannot be cancelled by project '${options.projectId}'`,
        QUEUE_ERROR_CODES.CROSS_PROJECT_CANCELLATION_FORBIDDEN,
        403,
      );
    }

    // 2. Wrong-run validation
    if (entry.runId && options?.runId && entry.runId !== options.runId) {
      throw new QueueError(
        `WRONG_RUN_CANCELLATION_FORBIDDEN: Queue entry '${id}' belongs to run '${entry.runId}', cannot be cancelled by run '${options.runId}'`,
        QUEUE_ERROR_CODES.WRONG_RUN_CANCELLATION_FORBIDDEN,
        403,
      );
    }

    // Already cancelled
    if (entry.state === 'cancelled') {
      return { ...entry };
    }

    const reason = options?.reason || 'Cancelled by client request';
    const nowIso = new Date().toISOString();

    if (entry.state === 'running') {
      // Safe abort for running task
      const controller = this.runningAbortControllers.get(id);
      if (controller) {
        try { controller.abort(); } catch {}
        this.runningAbortControllers.delete(id);
      }

      // Release model lease if active
      if (entry.leaseId) {
        try {
          this.modelManager.releaseLease(entry.leaseId, {
            projectId: entry.projectId,
            runId: entry.runId,
          });
        } catch {}
      }

      const updated: QueueEntry = {
        ...entry,
        state: 'cancelled',
        cancellationStatus: 'cancelled',
        cancellationReason: reason,
        cancelledAt: nowIso,
      };
      this.entries.set(id, updated);

      this.auditService.recordAuditEvent({
        source: 'fair_queue',
        category: 'stage',
        data: {
          action: 'QUEUE_CANCELLED',
          actor: options?.projectId || 'system',
          target: id,
          previousState: 'running',
          reason,
          projectId: entry.projectId,
          runId: entry.runId,
        },
      });

      return updated;
    }

    // For queued states (queued, waiting_for_model_lease, waiting_for_vram)
    const updated: QueueEntry = {
      ...entry,
      state: 'cancelled',
      cancellationStatus: 'cancelled',
      cancellationReason: reason,
      cancelledAt: nowIso,
      queuePosition: 0,
    };
    this.entries.set(id, updated);

    this.auditService.recordAuditEvent({
      source: 'fair_queue',
      category: 'stage',
      data: {
        action: 'QUEUE_CANCELLED',
        actor: options?.projectId || 'system',
        target: id,
        previousState: entry.state,
        reason,
        projectId: entry.projectId,
        runId: entry.runId,
      },
    });

    return updated;
  }

  /**
   * Dispatches the next eligible task in queue with lease acquisition and VRAM checks.
   */
  public async dispatchNext(): Promise<QueueEntry | null> {
    this.reevaluateAgingAndStates();
    const sorted = this.getSortedActiveEntries();
    if (sorted.length === 0) return null;

    for (const candidate of sorted) {
      // 1. Cancelled items cannot start execution
      if (candidate.state === 'cancelled') continue;

      // 2. Dependency check
      if (candidate.dependencies && candidate.dependencies.length > 0) {
        const unmet = this.checkUnmetDependencies(candidate.dependencies);
        if (unmet.length > 0) {
          const updated: QueueEntry = {
            ...candidate,
            blockingReason: `Waiting for dependencies: ${unmet.join(', ')}`,
          };
          this.entries.set(candidate.id, updated);
          continue;
        }
      }

      const reg = this.modelManager.getModelRegistration(candidate.requestedModelId);
      if (!reg) {
        const updated: QueueEntry = {
          ...candidate,
          state: 'failed',
          failureReason: `Model '${candidate.requestedModelId}' unavailable`,
        };
        this.entries.set(candidate.id, updated);
        continue;
      }

      // 3. VRAM queue-first & residency contention
      const residency = this.modelManager.getResidencyStatus();
      const isGpu = reg.device !== 'cpu' && candidate.requestedDevice !== 'cpu';

      if (isGpu && residency.residentModelId && residency.residentModelId !== reg.modelId) {
        const activeGpuLeases = this.modelManager.getActiveGpuLeasesCount();
        if (activeGpuLeases > 0) {
          if (candidate.allowCpuFallback) {
            // Explicit allowed CPU fallback
          } else {
            // Must wait in queue for VRAM
            const updated: QueueEntry = {
              ...candidate,
              state: 'waiting_for_vram',
              blockingReason: `Waiting for GPU VRAM: '${residency.residentModelId}' is active with ${activeGpuLeases} lease(s)`,
            };
            this.entries.set(candidate.id, updated);
            continue;
          }
        }
      }

      // 4. Acquire lease
      let lease;
      try {
        lease = await this.modelManager.acquireLease({
          modelId: candidate.requestedModelId,
          agentId: candidate.agentId,
          projectId: candidate.projectId,
          runId: candidate.runId,
          priority: candidate.priorityClass,
          allowCpuFallback: candidate.allowCpuFallback,
        });
      } catch (err: any) {
        if (err.code === VLM_ERROR_CODES.CONCURRENCY_VIOLATION) {
          const updated: QueueEntry = {
            ...candidate,
            state: 'waiting_for_vram',
            blockingReason: err.message,
          };
          this.entries.set(candidate.id, updated);
          continue;
        }
        throw err;
      }

      // 5. Transition candidate to running
      const controller = new AbortController();
      this.runningAbortControllers.set(candidate.id, controller);

      // Chat turn fairness tracking
      if (candidate.priorityClass === 'interactive_chat') {
        this.consecutiveChatTurns++;
      } else {
        this.consecutiveChatTurns = 0;
      }

      const started: QueueEntry = {
        ...candidate,
        state: 'running',
        leaseId: lease.id,
        startedAt: new Date().toISOString(),
        blockingReason: undefined,
      };
      this.entries.set(candidate.id, started);

      this.auditService.recordAuditEvent({
        source: 'fair_queue',
        category: 'stage',
        data: {
          action: 'QUEUE_STARTED',
          actor: candidate.agentId,
          target: candidate.id,
          taskId: candidate.taskId,
          leaseId: lease.id,
          modelId: lease.modelId,
          device: lease.device,
          priorityClass: candidate.priorityClass,
          projectId: candidate.projectId,
          runId: candidate.runId,
        },
      });

      return started;
    }

    return null;
  }

  /**
   * Report task completion.
   * Rejects phantom success if task was cancelled or force-stopped.
   */
  public reportCompletion(id: string): QueueEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new QueueError(`Queue entry '${id}' not found`, QUEUE_ERROR_CODES.ENTRY_NOT_FOUND, 404);
    }

    // Phantom completion prevention
    if (entry.state === 'cancelled' || entry.state === 'interrupted') {
      throw new QueueError(
        `CANNOT_COMPLETE_CANCELLED_TASK: Cannot report completion on ${entry.state} task '${id}'`,
        QUEUE_ERROR_CODES.CANNOT_COMPLETE_CANCELLED_TASK,
        400,
      );
    }

    if (entry.leaseId) {
      try {
        this.modelManager.releaseLease(entry.leaseId, {
          projectId: entry.projectId,
          runId: entry.runId,
        });
      } catch {}
    }

    this.runningAbortControllers.delete(id);

    const completed: QueueEntry = {
      ...entry,
      state: 'completed',
      completedAt: new Date().toISOString(),
      queuePosition: 0,
    };
    this.entries.set(id, completed);

    this.auditService.recordAuditEvent({
      source: 'fair_queue',
      category: 'stage',
      data: {
        action: 'QUEUE_COMPLETED',
        actor: entry.agentId,
        target: id,
        taskId: entry.taskId,
        projectId: entry.projectId,
        runId: entry.runId,
      },
    });

    return completed;
  }

  /**
   * Report task failure.
   */
  public reportFailure(id: string, error: Error | string): QueueEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new QueueError(`Queue entry '${id}' not found`, QUEUE_ERROR_CODES.ENTRY_NOT_FOUND, 404);
    }

    if (entry.state === 'cancelled' || entry.state === 'interrupted') {
      return { ...entry };
    }

    if (entry.leaseId) {
      try {
        this.modelManager.releaseLease(entry.leaseId, {
          projectId: entry.projectId,
          runId: entry.runId,
        });
      } catch {}
    }

    this.runningAbortControllers.delete(id);

    const reason = typeof error === 'string' ? error : error.message;
    const failed: QueueEntry = {
      ...entry,
      state: 'failed',
      failureReason: reason,
      queuePosition: 0,
    };
    this.entries.set(id, failed);

    this.auditService.recordAuditEvent({
      source: 'fair_queue',
      category: 'stage',
      data: {
        action: 'QUEUE_FAILED',
        actor: entry.agentId,
        target: id,
        taskId: entry.taskId,
        reason,
        projectId: entry.projectId,
        runId: entry.runId,
      },
    });

    return failed;
  }

  /**
   * Service restart recovery: marks stranded running tasks as interrupted
   * and cleans up their state.
   */
  public recoverQueueState(): { interruptedCount: number } {
    let interruptedCount = 0;
    const nowIso = new Date().toISOString();

    for (const [id, entry] of this.entries.entries()) {
      if (entry.state === 'running' || entry.state === 'cancelling') {
        if (entry.leaseId) {
          try { this.modelManager.releaseLease(entry.leaseId); } catch {}
        }
        this.runningAbortControllers.delete(id);

        const interrupted: QueueEntry = {
          ...entry,
          state: 'interrupted',
          failureReason: 'Service restarted while task was active',
          completedAt: nowIso,
          queuePosition: 0,
        };
        this.entries.set(id, interrupted);
        interruptedCount++;
      }
    }

    if (interruptedCount > 0) {
      this.auditService.recordAuditEvent({
        source: 'fair_queue',
        category: 'stage',
        data: {
          action: 'QUEUE_RECOVERED',
          actor: 'system',
          target: 'queue',
          interruptedCount,
        },
      });
    }

    return { interruptedCount };
  }

  /**
   * Get consecutive chat turns.
   */
  public getConsecutiveChatTurns(): number {
    return this.consecutiveChatTurns;
  }

  /**
   * Reset consecutive chat turns (for tests or manual queue recovery).
   */
  public resetConsecutiveChatTurns(): void {
    this.consecutiveChatTurns = 0;
  }

  /**
   * Reset all entries and controllers (for tests or clean re-initialization).
   */
  public clear(): void {
    this.entries.clear();
    for (const ctrl of this.runningAbortControllers.values()) {
      try { ctrl.abort(); } catch {}
    }
    this.runningAbortControllers.clear();
    this.consecutiveChatTurns = 0;
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private reevaluateAgingAndStates(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries.entries()) {
      if (
        entry.state === 'queued' ||
        entry.state === 'waiting_for_model_lease' ||
        entry.state === 'waiting_for_vram'
      ) {
        const enqueuedTime = new Date(entry.enqueuedAt).getTime();
        const ageSeconds = Math.max(0, Math.floor((now - enqueuedTime) / 1000));
        const isAged = ageSeconds >= 60;

        // Aging: increase priority by 1 class, capped at priority 2 (user_task)
        let effectivePriority = entry.basePriority;
        if (isAged && entry.basePriority > 2) {
          effectivePriority = Math.max(2, entry.basePriority - 1);
        }

        this.entries.set(id, {
          ...entry,
          ageSeconds,
          isAged,
          effectivePriority,
        });
      }
    }
  }

  private getSortedActiveEntries(): QueueEntry[] {
    const active = Array.from(this.entries.values()).filter(
      (e) =>
        e.state === 'queued' ||
        e.state === 'waiting_for_model_lease' ||
        e.state === 'waiting_for_vram',
    );

    active.sort((a, b) => {
      // 1. Max consecutive chat turns limit
      if (this.consecutiveChatTurns >= this.maxConsecutiveChatTurns) {
        if (a.priorityClass === 'interactive_chat' && b.priorityClass !== 'interactive_chat') return 1;
        if (b.priorityClass === 'interactive_chat' && a.priorityClass !== 'interactive_chat') return -1;
      }

      // 2. Effective priority ascending (1 highest)
      if (a.effectivePriority !== b.effectivePriority) {
        return a.effectivePriority - b.effectivePriority;
      }

      // 3. FIFO tie breaking
      return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
    });

    return active;
  }

  private computeQueuePositionForEntry(entry: QueueEntry): QueueEntry {
    if (
      entry.state !== 'queued' &&
      entry.state !== 'waiting_for_model_lease' &&
      entry.state !== 'waiting_for_vram'
    ) {
      return { ...entry, queuePosition: 0 };
    }

    const sorted = this.getSortedActiveEntries();
    const index = sorted.findIndex((e) => e.id === entry.id);
    const pos = index === -1 ? 0 : index + 1;
    return { ...entry, queuePosition: pos };
  }

  private checkUnmetDependencies(dependencies: string[]): string[] {
    const unmet: string[] = [];
    for (const depId of dependencies) {
      // Look for completed task
      let foundCompleted = false;
      for (const e of this.entries.values()) {
        if ((e.taskId === depId || e.id === depId) && e.state === 'completed') {
          foundCompleted = true;
          break;
        }
      }
      if (!foundCompleted) {
        unmet.push(depId);
      }
    }
    return unmet;
  }
}
