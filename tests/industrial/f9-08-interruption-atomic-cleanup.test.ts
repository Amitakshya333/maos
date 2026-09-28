/**
 * MAOS Industrial — F9-08: Interruption and Atomic Cleanup Test Suite
 *
 * Verifies atomic state cleanup, transactional rollback, emergency teardown,
 * and crash recovery across all MAOS runtime subsystems:
 *
 * 1. Chat Completion Cancellation & Interruption:
 *    - Immediate abort on pre-cancelled AbortSignal (INTERRUPTED code, CLIENT_ABORTED audit).
 *    - In-flight abort during model inference halts fetch and prevents phantom success.
 *    - Model server timeout fails cleanly with MODEL_INFERENCE_TIMEOUT.
 *
 * 2. Task Interruption & Queue Protection:
 *    - Specific task cancellation marks queue file interrupted and appends audit trail.
 *    - Fleet interruption marks all active tasks interrupted.
 *    - Fail-closed: cancelled tasks cannot count toward done queue (zero phantom success).
 *
 * 3. Workflow / Objective Cancellation:
 *    - Cancelling an objective marks status failed, timestamps doneAt, and cancels subtasks.
 *    - Fleet workflow interruption halts all in-flight stages.
 *
 * 4. Sandbox Container Crash & Timeout Cleanup:
 *    - Synchronous and asynchronous container removal (rm -f) guarantees zero orphan containers.
 *    - Ephemeral staging directory registration and guaranteed deletion.
 *
 * 5. Firewall Unclean Shutdown & Rollback:
 *    - Interrupted apply transaction flags RESTORE_REQUIRED on startup.
 *    - Automated recovery rolls back rules to pre-change snapshot and restores clean state.
 *
 * 6. Network Observation Session Teardown:
 *    - Halting active observations clears interval timers and flushes traces to disk.
 *    - Zero leaked timers or unpersisted measurements.
 *
 * 7. Model Lease Reclamation:
 *    - Forcibly releases all GPU/VRAM leases, resetting active count to zero.
 *
 * 8. Orphan File & Stale Lock Removal:
 *    - Purges orphaned temporary artifacts (.tmp_*) and bundle staging files.
 *    - Releases stale lifecycle lockfiles when owning PID is dead.
 *
 * 9. Unified Atomic Cleanup Coordinator Integration:
 *    - Orchestrates all cleanup layers in a single, fail-safe pass.
 *    - Idempotent: repeated runs succeed without error or side-effects.
 *    - Signal handler registration and removal.
 *
 * 10. Canary Invariant:
 *     - Verifies rust/test.txt SHA-256 remains strictly untouched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';

import {
  createServiceContainer,
  ServiceContainer,
  ChatInferenceService,
  ChatInferenceError,
  TaskService,
  WorkflowService,
  FirewallService,
  NetworkMonitorService,
  ModelService,
  ArtifactService,
  SovereigntyBundleService,
  AuditService,
  AtomicCleanupCoordinator,
  AtomicCleanupReport,
} from '../../src/service';
import {
  createIndustrialEndpointPolicy,
} from '../../src/domain/endpoint-allowlist';
import {
  computeCanonicalSnapshotHash,
} from '../../src/domain/firewall-policy';
import {
  MockFirewallAdapter,
} from '../../src/industrial/firewall';
import {
  MockSocketObserver,
} from '../../src/industrial/network';
import { ContainerRunner } from '../../src/industrial/container-runner';
import { getLockPath } from '../../src/industrial/lifecycle';

describe('F9-08: Interruption and Atomic Cleanup', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f908-' + Date.now(),
  );

  let mockHttpServer: http.Server;
  let mockServerPort: number;

  beforeAll(async () => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }

    // Start a mock HTTP server to simulate slow / responsive local model server endpoints
    mockHttpServer = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        // Slow response to test in-flight cancellation
        const timer = setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'mock-chat-1',
              model: 'qwen2.5-3b-instruct-local',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Finished inference normally.',
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }),
          );
        }, 500);

        req.on('close', () => {
          clearTimeout(timer);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockHttpServer.listen(0, '127.0.0.1', () => {
        const addr = mockHttpServer.address() as { port: number };
        mockServerPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockHttpServer.close(() => resolve());
    });

    if (fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 1: Chat Completion Cancellation & Interruption
  // ══════════════════════════════════════════════════════════════════════════
  describe('1. Chat Completion Cancellation & Interruption', () => {
    it('rejects immediately when AbortSignal is already aborted before starting', async () => {
      const audit = new AuditService(testTempDir);
      const chat = new ChatInferenceService({
        auditService: audit,
        modelEndpoint: `http://127.0.0.1:${mockServerPort}`,
      });

      const controller = new AbortController();
      controller.abort(); // pre-aborted

      let caughtError: any;
      try {
        await chat.chatCompletion({
          conversationId: 'conv-pre-abort',
          messages: [{ role: 'user', content: 'Calculate RMS vibration' }],
          signal: controller.signal,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ChatInferenceError);
      expect(caughtError.code).toBe('INTERRUPTED');
      expect(caughtError.message).toContain('cancelled before execution');

      // Verify audit trail
      const events = audit.getRecords({ limit: 10 });
      const cancelEvent = events.find(
        (e) => (e.data as any).event === 'CHAT_INFERENCE_INTERRUPTED',
      );
      expect(cancelEvent).toBeDefined();
      expect((cancelEvent?.data as any).reason).toBe('CLIENT_ABORTED');
    });

    it('aborts in-flight inference on client cancellation via AbortSignal', async () => {
      const audit = new AuditService(testTempDir);
      const chat = new ChatInferenceService({
        auditService: audit,
        modelEndpoint: `http://127.0.0.1:${mockServerPort}`,
      });

      const controller = new AbortController();
      const completionPromise = chat.chatCompletion({
        conversationId: 'conv-inflight-abort',
        messages: [{ role: 'user', content: 'Generate turbine failure prediction' }],
        signal: controller.signal,
      });

      // Abort in-flight after 40ms
      setTimeout(() => controller.abort(), 40);

      let caughtError: any;
      try {
        await completionPromise;
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ChatInferenceError);
      expect(caughtError.code).toBe('INTERRUPTED');
      expect(caughtError.message).toContain('cancelled by client');

      // Verify audit trail
      const events = audit.getRecords({ limit: 10 });
      const cancelEvent = events.find(
        (e) => (e.data as any).event === 'CHAT_INFERENCE_INTERRUPTED',
      );
      expect(cancelEvent).toBeDefined();
      expect((cancelEvent?.data as any).reason).toBe('CLIENT_ABORTED');
    });

    it('handles server timeout cleanly without phantom success', async () => {
      const audit = new AuditService(testTempDir);
      const chat = new ChatInferenceService({
        auditService: audit,
        modelEndpoint: `http://127.0.0.1:${mockServerPort}`,
        timeoutMs: 50, // mock server delays 500ms -> triggers timeout
      });

      let caughtError: any;
      try {
        await chat.chatCompletion({
          conversationId: 'conv-timeout-test',
          messages: [{ role: 'user', content: 'Perform long analysis' }],
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ChatInferenceError);
      expect(caughtError.code).toBe('MODEL_INFERENCE_TIMEOUT');

      const events = audit.getRecords({ limit: 10 });
      const failEvent = events.find(
        (e) => (e.data as any).event === 'CHAT_INFERENCE_FAILED',
      );
      expect(failEvent).toBeDefined();
      expect((failEvent?.data as any).error).toBe('TIMEOUT');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 2: Task Interruption & Queue Protection
  // ══════════════════════════════════════════════════════════════════════════
  describe('2. Task Interruption & Queue Protection', () => {
    let taskService: TaskService;

    beforeEach(() => {
      taskService = new TaskService(testTempDir);
    });

    afterEach(() => {
      taskService.clean();
    });

    it('interrupts a specific active task and updates on-disk task metadata', () => {
      const task = taskService.createTask({
        description: 'Vibration analysis step 1',
        agent: 'analyst_agent',
        branch: 'analysis-branch',
        type: 'coding',
      });

      // Move to active
      const activeFile = {
        id: task.id,
        filePath: task.filePath!,
        status: 'pending' as const,
      };
      taskService.moveToActive(activeFile as any);

      // Interrupt task
      const interrupted = taskService.interruptTask(task.id, 'User clicked stop');
      expect(interrupted).toBeDefined();
      expect(interrupted?.status).toBe('interrupted');

      // Verify file content on disk contains Interruption header
      const activeTask = taskService.getTask(task.id);
      expect(activeTask).toBeDefined();
      const content = fs.readFileSync(activeTask!.filePath!, 'utf8');
      expect(content).toContain('status: interrupted');
      expect(content).toContain('## Interruption');
      expect(content).toContain('User clicked stop');
    });

    it('interrupts all active tasks and clears active queue on fleet interrupt', () => {
      const task1 = taskService.createTask({
        description: 'Task 1',
        agent: 'analyst_agent',
        branch: 'b1',
      });
      const task2 = taskService.createTask({
        description: 'Task 2',
        agent: 'analyst_agent',
        branch: 'b2',
      });

      taskService.moveToActive({ id: task1.id, filePath: task1.filePath!, status: 'active' } as any);
      taskService.moveToActive({ id: task2.id, filePath: task2.filePath!, status: 'active' } as any);

      const interrupted = taskService.interruptActiveTasks('Emergency fleet halt');
      expect(interrupted.length).toBe(2);
      expect(interrupted.every((t) => t.status === 'interrupted')).toBe(true);

      // Check queue counts
      const counts = taskService.getQueueCounts();
      expect(counts.done).toBe(0); // Zero phantom success
    });

    it('fail-closed: interrupted tasks never transition to done without re-execution', () => {
      const task = taskService.createTask({
        description: 'Interrupted task test',
        agent: 'analyst_agent',
        branch: 'b1',
      });
      taskService.moveToActive({ id: task.id, filePath: task.filePath!, status: 'active' } as any);
      taskService.interruptTask(task.id, 'Abort');

      const current = taskService.getTask(task.id);
      expect(current?.status).toBe('interrupted');
      expect(taskService.getQueueCounts().done).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 3: Workflow / Objective Cancellation
  // ══════════════════════════════════════════════════════════════════════════
  describe('3. Workflow / Objective Cancellation', () => {
    let workflowService: WorkflowService;
    let taskService: TaskService;

    beforeEach(() => {
      workflowService = new WorkflowService(testTempDir);
      taskService = new TaskService(testTempDir);
    });

    afterEach(() => {
      taskService.clean();
    });

    it('cancels an objective and marks uncompleted subtasks cancelled/interrupted', () => {
      const task1 = taskService.createTask({ description: 'Subtask 1', agent: 'a1', branch: 'b' });
      const task2 = taskService.createTask({ description: 'Subtask 2', agent: 'a1', branch: 'b' });

      // Move task1 to active
      taskService.moveToActive({ id: task1.id, filePath: task1.filePath!, status: 'active' } as any);

      const obj = workflowService.createObjective({
        id: 'obj-turbine-eval',
        goal: 'Evaluate turbine vibration safety',
        plannerAgentId: 'planner_agent',
      });

      // Associate subtasks with objective in store
      const objStorePath = path.join(testTempDir, '.maos', 'queue', 'objectives', `${obj.id}.json`);
      const rawObj = JSON.parse(fs.readFileSync(objStorePath, 'utf8'));
      rawObj.childTaskIds = [task1.id, task2.id];
      rawObj.status = 'executing';
      fs.writeFileSync(objStorePath, JSON.stringify(rawObj, null, 2));

      // Interrupt objective
      const interruptedObj = workflowService.interruptObjective(
        obj.id,
        'Operator cancelled run',
        taskService,
      );

      expect(interruptedObj).toBeDefined();
      expect(interruptedObj?.status).toBe('failed');
      expect(interruptedObj?.doneAt).toBeDefined();
      expect(interruptedObj?.cancelledChildIds).toContain(task1.id);
      expect(interruptedObj?.cancelledChildIds).toContain(task2.id);

      // Verify active task was also marked interrupted
      const refreshedTask1 = taskService.getTask(task1.id);
      expect(refreshedTask1?.status).toBe('interrupted');
    });

    it('interruptAllWorkflows marks all in-flight stages failed', () => {
      const obj1 = workflowService.createObjective({
        id: 'obj-stage-1',
        goal: 'Goal 1',
        plannerAgentId: 'planner_agent',
      });
      const obj2 = workflowService.createObjective({
        id: 'obj-stage-2',
        goal: 'Goal 2',
        plannerAgentId: 'planner_agent',
      });

      const path1 = path.join(testTempDir, '.maos', 'queue', 'objectives', `${obj1.id}.json`);
      const raw1 = JSON.parse(fs.readFileSync(path1, 'utf8'));
      raw1.status = 'executing';
      fs.writeFileSync(path1, JSON.stringify(raw1, null, 2));

      const path2 = path.join(testTempDir, '.maos', 'queue', 'objectives', `${obj2.id}.json`);
      const raw2 = JSON.parse(fs.readFileSync(path2, 'utf8'));
      raw2.status = 'planning';
      fs.writeFileSync(path2, JSON.stringify(raw2, null, 2));

      const stopped = workflowService.interruptAllWorkflows('Emergency abort', taskService);
      expect(stopped.length).toBe(2);
      expect(stopped.every((s) => s.status === 'failed')).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 4: Sandbox Container Crash & Timeout Cleanup
  // ══════════════════════════════════════════════════════════════════════════
  describe('4. Sandbox Container Crash & Timeout Cleanup', () => {
    it('guarantees cleanupContainerSync and cleanupContainer do not throw on missing containers', async () => {
      const runner = new ContainerRunner();
      expect(() => {
        runner.cleanupContainerSync('nonexistent-test-container-' + Date.now());
      }).not.toThrow();

      await expect(
        runner.cleanupContainer('nonexistent-test-container-' + Date.now()),
      ).resolves.toBeUndefined();
    });

    it('coordinator tracks and cleans up registered containers and staging dirs', () => {
      const coordinator = new AtomicCleanupCoordinator(testTempDir);

      const fakeContainer = 'maos-test-container-999';
      const fakeTempDir = path.join(testTempDir, 'staged-sandbox-workspace');
      fs.mkdirSync(fakeTempDir, { recursive: true });
      fs.writeFileSync(path.join(fakeTempDir, 'script.py'), 'print(1)');

      coordinator.registerContainer(fakeContainer);
      coordinator.registerTempDir(fakeTempDir);

      expect(coordinator.getActiveContainers()).toContain(fakeContainer);
      expect(coordinator.getActiveTempDirs()).toContain(fakeTempDir);

      const containerRes = coordinator.cleanupContainers();
      expect(containerRes.killed).toContain(fakeContainer);
      expect(coordinator.getActiveContainers().length).toBe(0);

      const dirRes = coordinator.cleanupTempDirs();
      expect(dirRes.purged).toContain(fakeTempDir);
      expect(fs.existsSync(fakeTempDir)).toBe(false);
      expect(coordinator.getActiveTempDirs().length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 5: Firewall Unclean Shutdown & Rollback
  // ══════════════════════════════════════════════════════════════════════════
  describe('5. Firewall Unclean Shutdown & Rollback', () => {
    it('detects RESTORE_REQUIRED when state file indicates an interrupted transaction', async () => {
      const firewallDir = path.join(testTempDir, '.maos', 'firewall');
      fs.mkdirSync(firewallDir, { recursive: true });

      // Write interrupted state file
      fs.writeFileSync(
        path.join(firewallDir, 'state.json'),
        JSON.stringify({
          status: 'APPLYING',
          interrupted: true,
          lastUpdatedAt: new Date().toISOString(),
        }),
      );

      const mockAdapter = new MockFirewallAdapter();
      const firewall = new FirewallService(testTempDir, {
        adapter: mockAdapter,
      });

      const status = await firewall.getStatus();
      expect(status.state).toBe('RESTORE_REQUIRED');
      expect(status.restoreRequired).toBe(true);
    });

    it('automatically restores previous snapshot on coordinator recovery sweep', async () => {
      const firewallDir = path.join(testTempDir, '.maos', 'firewall');
      const snapshotsDir = path.join(firewallDir, 'snapshots');
      fs.mkdirSync(snapshotsDir, { recursive: true });

      // Write valid snapshot file
      const snapshotId = 'snap-interrupted-001';
      const snapshotData = {
        schemaVersion: 1,
        snapshotId,
        platform: 'mock',
        capturedAt: new Date().toISOString(),
        capturedRules: [],
        stateMetadata: {},
      };
      const canonicalHash = computeCanonicalSnapshotHash(snapshotData as any);
      fs.writeFileSync(
        path.join(snapshotsDir, `${snapshotId}.json`),
        JSON.stringify({ ...snapshotData, snapshotHash: canonicalHash }, null, 2),
      );

      // Write interrupted state file referencing snapshot
      fs.writeFileSync(
        path.join(firewallDir, 'state.json'),
        JSON.stringify({
          status: 'RESTORE_REQUIRED',
          interrupted: true,
          activeSnapshotId: snapshotId,
          lastUpdatedAt: new Date().toISOString(),
        }),
      );

      const mockAdapter = new MockFirewallAdapter();
      const firewall = new FirewallService(testTempDir, {
        adapter: mockAdapter,
      });

      const coordinator = new AtomicCleanupCoordinator(testTempDir, {
        firewallService: firewall,
      });

      const restoreRes = await coordinator.cleanupFirewallState();
      expect(restoreRes).toBeDefined();
      expect(restoreRes?.success).toBe(true);

      const statusAfter = await firewall.getStatus();
      expect(statusAfter.state).toBe('INACTIVE');
      expect(statusAfter.restoreRequired).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 6: Network Observation Session Teardown
  // ══════════════════════════════════════════════════════════════════════════
  describe('6. Network Observation Session Teardown', () => {
    it('halts active observation sessions, clears polling timers, and flushes traces', async () => {
      const mockObserver = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 8000,
            remoteAddress: '127.0.0.1',
            remotePort: 54321,
            state: 'ESTABLISHED',
            pid: process.pid,
            processName: 'node.exe',
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockObserver,
        evidenceDir: path.join(testTempDir, '.maos', 'network-evidence'),
      });

      await monitor.startObservation(
        'obs-interruption-test',
        'test-project',
        { sampleIntervalMs: 50 },
      );

      expect(monitor.isObservationActive('obs-interruption-test')).toBe(true);
      expect(monitor.listActiveObservations()).toContain('obs-interruption-test');

      // Interrupt all active sessions
      const traces = await monitor.interruptAll('Shutdown triggered');
      expect(traces.length).toBe(1);
      expect(traces[0].sessionId).toBe('obs-interruption-test');
      expect(monitor.listActiveObservations().length).toBe(0);

      // Verify persisted trace file
      const traceFile = path.join(
        testTempDir,
        '.maos',
        'network-evidence',
        'obs-interruption-test.json',
      );
      expect(fs.existsSync(traceFile)).toBe(true);
      const parsedTrace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
      expect(parsedTrace.traceHash).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 7: Model Lease Reclamation
  // ══════════════════════════════════════════════════════════════════════════
  describe('7. Model Lease Reclamation', () => {
    it('releases all active model leases and resets lease count to zero', () => {
      const audit = new AuditService(testTempDir);
      const modelService = new ModelService(TEST_PROJECT_ROOT, undefined, audit);

      const lease1 = modelService.acquireLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent_1',
        allowCpuFallback: true,
      });
      const lease2 = modelService.acquireLease({
        modelId: 'Qwen/Qwen2.5-3B-Instruct',
        agentId: 'agent_2',
        allowCpuFallback: true,
      });

      expect(modelService.getLease(lease1.id)).toBeDefined();
      expect(modelService.getLease(lease2.id)).toBeDefined();

      const coordinator = new AtomicCleanupCoordinator(TEST_PROJECT_ROOT, {
        modelService,
      });

      const releasedCount = coordinator.cleanupModelLeases();
      expect(releasedCount).toBeGreaterThanOrEqual(2);

      expect(modelService.getLease(lease1.id)).toBeUndefined();
      expect(modelService.getLease(lease2.id)).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 8: Orphan File & Stale Lock Removal
  // ══════════════════════════════════════════════════════════════════════════
  describe('8. Orphan File & Stale Lock Removal', () => {
    it('purges orphan temporary files across artifacts, bundles, and stale locks', () => {
      const artifactsTmpDir = path.join(testTempDir, 'artifacts', '.tmp');
      const bundlesDir = path.join(testTempDir, '.maos', 'bundles');
      fs.mkdirSync(artifactsTmpDir, { recursive: true });
      fs.mkdirSync(bundlesDir, { recursive: true });

      const tmpArtifact1 = path.join(artifactsTmpDir, '.tmp_unfinished_artifact_1');
      const tmpArtifact2 = path.join(artifactsTmpDir, '.tmp_unfinished_artifact_2');
      const realArtifact = path.join(artifactsTmpDir, 'permanent_file.txt');
      fs.writeFileSync(tmpArtifact1, 'partial content');
      fs.writeFileSync(tmpArtifact2, 'partial content');
      fs.writeFileSync(realArtifact, 'keep content');

      const tmpBundle1 = path.join(bundlesDir, 'bundle1.json.tmp_12345');
      const tmpBundle2 = path.join(bundlesDir, 'bundle2.zip.tmp_67890');
      const realBundle = path.join(bundlesDir, 'bundle_permanent.json');
      fs.writeFileSync(tmpBundle1, 'partial bundle');
      fs.writeFileSync(tmpBundle2, 'partial zip');
      fs.writeFileSync(realBundle, '{"bundleId": "permanent"}');

      // Create stale lock with dead PID
      const lockPath = getLockPath(testTempDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 99999999, // definitely dead PID
          timestamp: new Date(Date.now() - 60000).toISOString(),
          hostname: 'test-host',
        }),
      );

      const artifactService = new ArtifactService(testTempDir);
      const bundleService = new SovereigntyBundleService(testTempDir);

      const coordinator = new AtomicCleanupCoordinator(testTempDir, {
        artifactService,
        sovereigntyBundle: bundleService,
      });

      const res = coordinator.cleanupOrphanFiles();
      expect(res.artifactsPurged).toBe(2);
      expect(res.bundlesPurged).toBe(2);
      expect(res.locksRemoved).toBe(1);

      expect(fs.existsSync(tmpArtifact1)).toBe(false);
      expect(fs.existsSync(tmpArtifact2)).toBe(false);
      expect(fs.existsSync(realArtifact)).toBe(true);

      expect(fs.existsSync(tmpBundle1)).toBe(false);
      expect(fs.existsSync(tmpBundle2)).toBe(false);
      expect(fs.existsSync(realBundle)).toBe(true);

      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('preserves live lifecycle lock unless forced', () => {
      const lockPath = getLockPath(testTempDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid, // current process -> ALIVE
          timestamp: new Date().toISOString(),
          hostname: 'test-host',
        }),
      );

      const coordinator = new AtomicCleanupCoordinator(testTempDir);

      // Normal sweep preserves live lock
      const res1 = coordinator.cleanupOrphanFiles();
      expect(res1.locksRemoved).toBe(0);
      expect(fs.existsSync(lockPath)).toBe(true);

      // Forced sweep removes it
      const res2 = coordinator.cleanupOrphanFiles({ forceLockRelease: true });
      expect(res2.locksRemoved).toBe(1);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 9: Unified Atomic Cleanup Coordinator Integration
  // ══════════════════════════════════════════════════════════════════════════
  describe('9. Unified Atomic Cleanup Coordinator Integration', () => {
    let services: ServiceContainer;

    beforeEach(() => {
      services = createServiceContainer(testTempDir);
    });

    afterEach(() => {
      services.task.clean();
    });

    it('orchestrates complete atomic cleanup across all subsystems simultaneously', async () => {
      // 1. Create active task
      const task = services.task.createTask({
        description: 'Multi-agent vibration check',
        agent: 'analyst_agent',
        branch: 'analysis',
      });
      services.task.moveToActive({ id: task.id, filePath: task.filePath!, status: 'pending' } as any);

      // 2. Create in-flight workflow
      const obj = services.workflow.createObjective({
        id: 'obj-unified-test',
        goal: 'Unified pipeline test',
        plannerAgentId: 'planner_agent',
      });
      const objPath = path.join(testTempDir, '.maos', 'queue', 'objectives', `${obj.id}.json`);
      const rawObj = JSON.parse(fs.readFileSync(objPath, 'utf8'));
      rawObj.status = 'executing';
      rawObj.childTaskIds = [task.id];
      fs.writeFileSync(objPath, JSON.stringify(rawObj, null, 2));

      // 3. Register sandbox container & staging dir
      const fakeDir = path.join(testTempDir, 'temp-staging-' + Date.now());
      fs.mkdirSync(fakeDir, { recursive: true });
      services.atomicCleanup.registerContainer('maos-container-unified-1');
      services.atomicCleanup.registerTempDir(fakeDir);

      // 4. Create orphan temp files
      const artifactsTmpDir = path.join(testTempDir, 'artifacts', '.tmp');
      fs.mkdirSync(artifactsTmpDir, { recursive: true });
      fs.writeFileSync(path.join(artifactsTmpDir, '.tmp_artifact_unified'), 'partial');

      const bundlesDir = path.join(testTempDir, '.maos', 'bundles');
      fs.mkdirSync(bundlesDir, { recursive: true });
      fs.writeFileSync(path.join(bundlesDir, 'bundle.json.tmp_unified'), 'partial');

      // 5. Execute unified atomic cleanup
      const report: AtomicCleanupReport = await services.atomicCleanup.executeAtomicCleanup({
        reason: 'SIGINT received from operator',
      });

      expect(report.success).toBe(true);
      expect(report.tasksInterruptedCount).toBe(1);
      expect(report.workflowsInterruptedCount).toBe(1);
      expect(report.containersCleanedCount).toBe(1);
      expect(report.tempDirsCleanedCount).toBe(1);
      expect(report.orphanArtifactsPurgedCount).toBe(1);
      expect(report.orphanBundlesPurgedCount).toBe(1);
      expect(report.errors.length).toBe(0);

      // Verify audit record
      const events = services.audit.getRecords({ limit: 10 });
      const auditEvt = events.find(
        (e) => (e.data as any).event === 'ATOMIC_CLEANUP_COMPLETED',
      );
      expect(auditEvt).toBeDefined();
      expect((auditEvt?.data as any).success).toBe(true);
      expect((auditEvt?.data as any).reason).toBe('SIGINT received from operator');
    });

    it('idempotent execution: second run immediately after is clean and no-op', async () => {
      const report1 = await services.atomicCleanup.executeAtomicCleanup({
        reason: 'First pass',
      });
      expect(report1.success).toBe(true);

      const report2 = await services.atomicCleanup.executeAtomicCleanup({
        reason: 'Second pass (idempotent)',
      });
      expect(report2.success).toBe(true);
      expect(report2.tasksInterruptedCount).toBe(0);
      expect(report2.workflowsInterruptedCount).toBe(0);
      expect(report2.containersCleanedCount).toBe(0);
      expect(report2.tempDirsCleanedCount).toBe(0);
      expect(report2.errors.length).toBe(0);
    });

    it('installs and cleanly removes process signal handlers without error', () => {
      let interruptedReport: AtomicCleanupReport | undefined;

      services.atomicCleanup.installSignalHandlers({
        exitProcess: false,
        onInterrupted: (rep) => {
          interruptedReport = rep;
        },
      });

      // Cleanup signal handlers to prevent listener leaks in test runner
      services.atomicCleanup.removeSignalHandlers();
      expect(interruptedReport).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Section 10: Canary Invariant
  // ══════════════════════════════════════════════════════════════════════════
  describe('10. Canary Invariant', () => {
    it('rust/test.txt SHA-256 remains strictly untouched and unmodified', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
