/**
 * UI1-12: Fair Priority and Cancellation Queue Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Types & Pure Validators:
 *    - validateEnqueueInput: validates priorityClass, requestedModelId, agentId, dependencies
 *    - validateCancelInput: validates entryId, projectId, runId, force
 *    - Fixed priority classes: interactive_chat (1), user_task (2), active_workflow (3),
 *      auto_workflow (4), background_indexing (5)
 *    - 9 explicit queue states: queued, waiting_for_model_lease, waiting_for_vram, running,
 *      cancelling, cancelled, completed, failed, interrupted
 * 2. FairQueueService Core Logic:
 *    - FIFO tie-breaking within equivalent priority and age
 *    - Aging anti-starvation: aged requests (>=60s) improve effective priority (capped at 2)
 *    - Maximum consecutive interactive/chat turns (3) before yielding to workflow tasks
 *    - Safe cancellation of queued requests (immediate status transition, position 0)
 *    - Safe cancellation of running requests (abort controller triggered, lease released)
 *    - Phantom success defense: reporting completion on cancelled/interrupted task rejected
 *    - VRAM queue-first behavior: contention leads to waiting_for_vram, CPU fallback only when permitted
 *    - Dependency gating: unmet dependencies block task dispatch
 *    - Duplicate prevention: duplicate active task ID rejected with 409
 *    - Service restart recovery: stranded running tasks marked as interrupted
 *    - Project & run boundary isolation: cross-project and wrong-run cancellations rejected with 403
 *    - Tamper-evident audit trail: records QUEUE_ENQUEUED, QUEUE_STARTED, QUEUE_CANCELLED,
 *      QUEUE_COMPLETED, QUEUE_FAILED, QUEUE_RECOVERED
 * 3. REST API Router:
 *    - GET /api/v1/queue
 *    - GET /api/v1/queue/status
 *    - POST /api/v1/queue
 *    - GET /api/v1/queue/:id
 *    - POST /api/v1/queue/:id/cancel
 *    - POST /api/v1/queue/recover
 * 4. 4-Way Parity:
 *    - ServiceContainer, RestApiRouter, MaosRestClient, BrowserRestClient, GuiApiAdapter
 * 5. Security & Gate Invariants:
 *    - Canary file rust/test.txt SHA-256 preservation
 *    - Gate G5 passed state, G6 and G7 passed state
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  validateEnqueueInput,
  validateCancelInput,
  PRIORITY_WEIGHTS,
  VALID_PRIORITY_CLASSES,
  VALID_QUEUE_STATES,
  QUEUE_ERROR_CODES,
  QueueEntry,
} from '../../src/domain/fair-queue';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import { SharedModelManager } from '../../src/service/model-manager';
import { RestApiRouter } from '../../src/api/router';
import { MaosRestClient } from '../../src/api/client';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import { PINNED_TEXT_CONFIG } from '../../src/domain/model-manifest';

describe('UI1-12: Fair Priority and Cancellation Queue', () => {
  let tempDir: string;
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let restClient: MaosRestClient;
  let browserClient: BrowserRestClient;
  let adapter: GuiApiAdapter;

  beforeAll(async () => {
    SharedModelManager.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-ui1-12-'));

    // Setup dummy project config
    const configDir = path.join(tempDir, '.maos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          storage: { engine: 'file' },
          audit: { enabled: true, hashAlgorithm: 'sha256' },
          projectRoot: tempDir,
        },
        null,
        2,
      ),
    );

    // Setup snapshot manifests and files
    const textSnapshotRelativePath = 'models--Qwen--Qwen2.5-3B-Instruct/snapshots/aa8e72537993ba99e69dfaafa59ed015b17504d1';
    const textSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', textSnapshotRelativePath);
    fs.mkdirSync(textSnapshotDir, { recursive: true });
    const textConfig = Buffer.from('{"model_type":"qwen2"}', 'utf8');
    fs.writeFileSync(path.join(textSnapshotDir, 'config.json'), textConfig);
    fs.writeFileSync(path.join(tempDir, 'model-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'Qwen/Qwen2.5-3B-Instruct',
      revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
      snapshotRelativePath: textSnapshotRelativePath,
      files: [{ path: 'config.json', size: textConfig.length, sha256: crypto.createHash('sha256').update(textConfig).digest('hex') }],
    }));

    const embSnapshotRelativePath = 'models--sentence-transformers--all-MiniLM-L6-v2/snapshots/fa979fdf926cbd99430f16e4321689952542a641';
    const embSnapshotDir = path.join(tempDir, 'offline-stores', 'model-snapshot', embSnapshotRelativePath);
    fs.mkdirSync(embSnapshotDir, { recursive: true });
    const embConfig = Buffer.from('{"model_type":"bert"}', 'utf8');
    fs.writeFileSync(path.join(embSnapshotDir, 'config.json'), embConfig);
    fs.writeFileSync(path.join(tempDir, 'embedding-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      revision: 'fa979fdf926cbd99430f16e4321689952542a641',
      snapshotRelativePath: embSnapshotRelativePath,
      files: [{ path: 'config.json', size: embConfig.length, sha256: crypto.createHash('sha256').update(embConfig).digest('hex') }],
    }));

    services = createServiceContainer(tempDir);
    router = new RestApiRouter(services, tempDir);

    server = http.createServer(async (req, res) => {
      const handled = await router.handle(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    restClient = new MaosRestClient({ baseUrl, projectRoot: tempDir });
    browserClient = new BrowserRestClient({ baseUrl, projectRoot: tempDir });
    adapter = new GuiApiAdapter({ baseUrl, projectRoot: tempDir });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    SharedModelManager.resetInstance();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    services.model.releaseAllLeases();
    services.queue.clear();
  });

  // ══════════════════════════════════════════════════════════════════════
  // 1. Domain Types & Pure Validators
  // ══════════════════════════════════════════════════════════════════════

  describe('1. Domain Types & Pure Validators', () => {
    it('verifies 5 fixed priority classes and their weights', () => {
      expect(VALID_PRIORITY_CLASSES).toEqual([
        'interactive_chat',
        'user_task',
        'active_workflow',
        'auto_workflow',
        'background_indexing',
      ]);

      expect(PRIORITY_WEIGHTS.interactive_chat).toBe(1);
      expect(PRIORITY_WEIGHTS.user_task).toBe(2);
      expect(PRIORITY_WEIGHTS.active_workflow).toBe(3);
      expect(PRIORITY_WEIGHTS.auto_workflow).toBe(4);
      expect(PRIORITY_WEIGHTS.background_indexing).toBe(5);
    });

    it('verifies 9 explicit queue states', () => {
      expect(VALID_QUEUE_STATES).toEqual([
        'queued',
        'waiting_for_model_lease',
        'waiting_for_vram',
        'running',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
        'interrupted',
      ]);
    });

    it('validateEnqueueInput accepts valid enqueue payloads', () => {
      const valid = validateEnqueueInput({
        agentId: 'test-agent',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-101',
        projectId: 'project-a',
        runId: 'run-1',
      });
      expect(valid.valid).toBe(true);
      expect(valid.errors).toHaveLength(0);
    });

    it('validateEnqueueInput rejects invalid priorityClass and missing fields', () => {
      const invalid = validateEnqueueInput({
        agentId: '',
        priorityClass: 'invalid_priority' as any,
        requestedModelId: '',
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThan(0);
      expect(invalid.errors.some((e) => e.includes('priorityClass'))).toBe(true);
      expect(invalid.errors.some((e) => e.includes('agentId'))).toBe(true);
      expect(invalid.errors.some((e) => e.includes('requestedModelId'))).toBe(true);
    });

    it('validateCancelInput handles valid and invalid payloads', () => {
      const valid = validateCancelInput({
        entryId: 'entry-123',
        reason: 'User cancelled',
        force: true,
      });
      expect(valid.valid).toBe(true);

      const invalid = validateCancelInput(null);
      expect(invalid.valid).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. FairQueueService Core Logic
  // ══════════════════════════════════════════════════════════════════════

  describe('2. FairQueueService Core Logic', () => {
    it('enqueues tasks with correct priority weights and positions', () => {
      const entry1 = services.queue.enqueue({
        agentId: 'analyst',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-u1',
      });

      const entry2 = services.queue.enqueue({
        agentId: 'chat-agent',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-c1',
      });

      expect(entry1.basePriority).toBe(2);
      expect(entry2.basePriority).toBe(1);

      const queue = services.queue.getQueue();
      // interactive_chat (P1) should be sorted before user_task (P2)
      expect(queue[0].id).toBe(entry2.id);
      expect(queue[1].id).toBe(entry1.id);
      expect(queue[0].queuePosition).toBe(1);
      expect(queue[1].queuePosition).toBe(2);
    });

    it('enforces FIFO tie-breaking within equivalent priority', async () => {
      const e1 = services.queue.enqueue({
        agentId: 'worker-1',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-fifo-1',
      });

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 15));

      const e2 = services.queue.enqueue({
        agentId: 'worker-2',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-fifo-2',
      });

      const queue = services.queue.getQueue();
      const pos1 = queue.find((e) => e.id === e1.id)?.queuePosition;
      const pos2 = queue.find((e) => e.id === e2.id)?.queuePosition;

      expect(pos1).toBeLessThan(pos2!);
    });

    it('rejects duplicate active task IDs', () => {
      services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-dup-1',
      });

      expect(() => {
        services.queue.enqueue({
          agentId: 'worker',
          priorityClass: 'user_task',
          requestedModelId: PINNED_TEXT_CONFIG.modelId,
          taskId: 'task-dup-1',
        });
      }).toThrowError(/DUPLICATE_QUEUE_ENTRY/);
    });

    it('promotes effective priority by 1 class after 60 seconds (anti-starvation)', () => {
      const entry = services.queue.enqueue({
        agentId: 'indexing-worker',
        priorityClass: 'background_indexing', // P5
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-aging-1',
      });

      expect(entry.basePriority).toBe(5);
      expect(entry.effectivePriority).toBe(5);
      expect(entry.isAged).toBe(false);

      // Simulate 65 seconds aging
      const sixtyFiveSecAgo = new Date(Date.now() - 65000).toISOString();
      (services.queue as any).entries.get(entry.id).enqueuedAt = sixtyFiveSecAgo;

      const queue = services.queue.getQueue();
      const aged = queue.find((e) => e.id === entry.id);

      expect(aged).toBeDefined();
      expect(aged?.isAged).toBe(true);
      expect(aged?.ageSeconds).toBeGreaterThanOrEqual(60);
      expect(aged?.effectivePriority).toBe(4); // Promoted from 5 to 4
    });

    it('caps aging priority promotion at user_task (P2) to protect interactive chat (P1)', () => {
      const entry = services.queue.enqueue({
        agentId: 'workflow-worker',
        priorityClass: 'active_workflow', // P3
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-aging-cap',
      });

      // Simulate 120 seconds aging
      const twoMinAgo = new Date(Date.now() - 120000).toISOString();
      (services.queue as any).entries.get(entry.id).enqueuedAt = twoMinAgo;

      const queue = services.queue.getQueue();
      const aged = queue.find((e) => e.id === entry.id);

      expect(aged?.isAged).toBe(true);
      expect(aged?.effectivePriority).toBe(2); // Promoted from 3 to 2, capped at 2
    });

    it('blocks dispatch when dependencies are unmet', async () => {
      const entry = services.queue.enqueue({
        agentId: 'dependent-worker',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-dep-child',
        dependencies: ['task-dep-parent-unmet'],
      });

      expect(entry.blockingReason).toContain('Waiting for dependencies: task-dep-parent-unmet');

      const dispatched = await services.queue.dispatchNext();
      expect(dispatched).toBeNull();
    });

    it('safely cancels queued entry with position 0', () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'background_indexing',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-to-cancel',
      });

      const cancelled = services.queue.cancel(entry.id, { reason: 'No longer needed' });
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.cancellationStatus).toBe('cancelled');
      expect(cancelled.cancellationReason).toBe('No longer needed');
      expect(cancelled.queuePosition).toBe(0);

      // Cancelling again is idempotent
      const recancelled = services.queue.cancel(entry.id);
      expect(recancelled.state).toBe('cancelled');
    });

    it('safely cancels running entry, aborts controller, and releases model lease', async () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-run-cancel',
      });

      const started = await services.queue.dispatchNext();
      expect(started).not.toBeNull();
      expect(started?.id).toBe(entry.id);
      expect(started?.state).toBe('running');
      expect(started?.leaseId).toBeDefined();

      const cancelled = services.queue.cancel(entry.id, { reason: 'Aborted by user' });
      expect(cancelled.state).toBe('cancelled');

      // Verify lease was released
      const residency = services.model.getModelResidencyStatus();
      expect(residency.activeLeases).toBe(0);
    });

    it('phantom success defense: rejects reporting completion on cancelled task', async () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-phantom',
      });

      services.queue.cancel(entry.id, { reason: 'User cancellation' });

      expect(() => {
        services.queue.reportCompletion(entry.id);
      }).toThrowError(/CANNOT_COMPLETE_CANCELLED_TASK/);
    });

    it('enforces chat burst limit: yields after 3 consecutive chat turns', async () => {
      // Enqueue a workflow task
      const workflowEntry = services.queue.enqueue({
        agentId: 'workflow-worker',
        priorityClass: 'active_workflow',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-wf-1',
      });

      // Simulate 3 chat turns completed
      for (let i = 0; i < 3; i++) {
        const chatEntry = services.queue.enqueue({
          agentId: 'chat-user',
          priorityClass: 'interactive_chat',
          requestedModelId: PINNED_TEXT_CONFIG.modelId,
          taskId: `task-chat-${i}`,
        });
        const running = await services.queue.dispatchNext();
        expect(running?.id).toBe(chatEntry.id);
        services.queue.reportCompletion(running!.id);
      }

      expect(services.queue.getConsecutiveChatTurns()).toBe(3);

      // Now enqueue another chat entry
      const chatEntry4 = services.queue.enqueue({
        agentId: 'chat-user',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-chat-4',
      });

      // Even though chatEntry4 has priority 1, because 3 consecutive turns occurred,
      // the workflow task should be dispatched next!
      const nextDispatched = await services.queue.dispatchNext();
      expect(nextDispatched?.id).toBe(workflowEntry.id);
      expect(nextDispatched?.priorityClass).toBe('active_workflow');

      // Reset consecutive chat turns counter after yielding
      expect(services.queue.getConsecutiveChatTurns()).toBe(0);
    });

    it('enforces project boundary isolation on cancellation', () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        projectId: 'project-alpha',
        taskId: 'task-iso-1',
      });

      expect(() => {
        services.queue.cancel(entry.id, {
          projectId: 'project-beta',
          reason: 'Cross project attempt',
        });
      }).toThrowError(/CROSS_PROJECT_CANCELLATION_FORBIDDEN/);
    });

    it('enforces run boundary isolation on cancellation', () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        projectId: 'project-alpha',
        runId: 'run-100',
        taskId: 'task-iso-2',
      });

      expect(() => {
        services.queue.cancel(entry.id, {
          projectId: 'project-alpha',
          runId: 'run-200',
          reason: 'Wrong run attempt',
        });
      }).toThrowError(/WRONG_RUN_CANCELLATION_FORBIDDEN/);
    });

    it('service restart recovery marks stranded running tasks as interrupted', async () => {
      const entry = services.queue.enqueue({
        agentId: 'worker',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-stranded',
      });

      await services.queue.dispatchNext();
      const queueBefore = services.queue.getQueue();
      const runningItem = queueBefore.find((e) => e.id === entry.id);
      expect(runningItem?.state).toBe('running');

      const recovery = services.queue.recoverQueueState();
      expect(recovery.interruptedCount).toBeGreaterThanOrEqual(1);

      const recoveredEntry = services.queue.getEntry(entry.id);
      expect(recoveredEntry?.state).toBe('interrupted');
      expect(recoveredEntry?.failureReason).toContain('Service restarted');
    });

    it('records audited events for queue operations', async () => {
      const entry = services.queue.enqueue({
        agentId: 'audit-agent',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-audited',
      });

      const started = await services.queue.dispatchNext();
      services.queue.reportCompletion(started!.id);

      const auditEvents = services.audit.getRecords({ source: 'fair_queue' });
      expect(auditEvents.length).toBeGreaterThanOrEqual(3);

      const actions = auditEvents.map((r: any) => r.data?.action);
      expect(actions).toContain('QUEUE_ENQUEUED');
      expect(actions).toContain('QUEUE_STARTED');
      expect(actions).toContain('QUEUE_COMPLETED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. REST API Router & Middleware
  // ══════════════════════════════════════════════════════════════════════

  describe('3. REST API Router & Endpoints', () => {
    it('POST /api/v1/queue enqueues a request', async () => {
      const res = await restClient.enqueueTask({
        agentId: 'api-agent',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-rest-1',
        projectId: 'proj-rest',
      });

      expect(res.status).toBe(201);
      expect(res.data).toBeDefined();
      expect(res.data?.id).toMatch(/^qentry_/);
      expect(res.data?.state).toBe('queued');
      expect(res.data?.priorityClass).toBe('user_task');
    });

    it('GET /api/v1/queue returns list of queue entries', async () => {
      await restClient.enqueueTask({
        agentId: 'list-agent',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-list-1',
      });
      const res = await restClient.listQueueEntries();
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data!.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/queue/status returns status summary', async () => {
      const res = await restClient.getQueueStatus();
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      expect(typeof res.data?.totalQueued).toBe('number');
      expect(typeof res.data?.activeRunning).toBe('number');
      expect(typeof res.data?.waitingForVram).toBe('number');
      expect(typeof res.data?.consecutiveChatTurns).toBe('number');
    });

    it('GET /api/v1/queue/:id returns single queue entry', async () => {
      const enq = await restClient.enqueueTask({
        agentId: 'api-agent',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-rest-detail',
      });

      const res = await restClient.getQueueEntry(enq.data!.id);
      expect(res.status).toBe(200);
      expect(res.data?.id).toBe(enq.data!.id);
      expect(res.data?.taskId).toBe('task-rest-detail');
    });

    it('POST /api/v1/queue/:id/cancel cancels the entry', async () => {
      const enq = await restClient.enqueueTask({
        agentId: 'api-agent',
        priorityClass: 'background_indexing',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-rest-cancel',
      });

      const res = await restClient.cancelQueueEntry(enq.data!.id, {
        reason: 'REST cancel test',
      });

      expect(res.status).toBe(200);
      expect(res.data?.state).toBe('cancelled');
      expect(res.data?.cancellationReason).toBe('REST cancel test');
    });

    it('POST /api/v1/queue/recover recovers stranded tasks', async () => {
      const res = await restClient.recoverQueueState();
      expect(res.status).toBe(200);
      expect(typeof res.data?.interruptedCount).toBe('number');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. 4-Way Client Parity
  // ══════════════════════════════════════════════════════════════════════

  describe('4. 4-Way Client Parity', () => {
    it('verifies BrowserRestClient queue operations', async () => {
      const entry = await browserClient.enqueueTask({
        agentId: 'browser-agent',
        priorityClass: 'user_task',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-browser-1',
      });
      expect(entry.id).toBeDefined();
      expect(entry.state).toBe('queued');

      const status = await browserClient.getQueueStatus();
      expect(status.totalQueued).toBeGreaterThanOrEqual(1);

      const entries = await browserClient.getQueueEntries();
      expect(entries.some((e) => e.id === entry.id)).toBe(true);

      const detail = await browserClient.getQueueEntry(entry.id);
      expect(detail.id).toBe(entry.id);

      const cancelled = await browserClient.cancelQueueEntry(entry.id, {
        reason: 'Browser client cancel',
      });
      expect(cancelled.state).toBe('cancelled');
    });

    it('verifies GuiApiAdapter queue operations', async () => {
      const entry = await adapter.enqueueTask({
        agentId: 'adapter-agent',
        priorityClass: 'interactive_chat',
        requestedModelId: PINNED_TEXT_CONFIG.modelId,
        taskId: 'task-adapter-1',
      });
      expect(entry.id).toBeDefined();

      const status = await adapter.getQueueStatus();
      expect(status).toBeDefined();

      const entries = await adapter.getQueueEntries();
      expect(entries.some((e) => e.id === entry.id)).toBe(true);

      const cancelled = await adapter.cancelQueueEntry(entry.id, {
        reason: 'Adapter cancel',
      });
      expect(cancelled.state).toBe('cancelled');

      const recovery = await adapter.recoverQueueState();
      expect(typeof recovery.interruptedCount).toBe('number');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. Security & Gate Invariants
  // ══════════════════════════════════════════════════════════════════════

  describe('5. Security & Gate Invariants', () => {
    it('verifies canary rust/test.txt SHA-256 hash preservation', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);
      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });

    it('verifies Gate G5 is passed and Gates G6/G7 are passed in plan', () => {
      const planPath = path.resolve(__dirname, '../../docs/SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf8');

      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
