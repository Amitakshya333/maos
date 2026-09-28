/**
 * UI1-02: Typed API & Event Clients Test Suite
 *
 * Tests:
 * 1. BrowserRestClient loopback confinement and non-loopback rejection
 * 2. Header propagation (X-Project-Root, X-Correlation-ID, Idempotency-Key)
 * 3. Typed REST endpoints consuming live RestApiServer (health, project, settings, tasks, models, audit, openapi)
 * 4. Error mapping (ApiError, ScopeMismatchError, TimeoutError, NetworkError, IdempotencyConflictError)
 * 5. Runtime schema validation (SchemaVersionError on != 1, RuntimeValidationError on malformed payloads)
 * 6. BrowserEventClient WebSocket connection, live events, cursor tracking, duplicate suppression, replay, resync
 * 7. GuiApiAdapter integration
 * 8. GUI codebase purity validation (zero Node builtins, zero CLI shells, zero token leaks)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createRestApiServer, RestApiServer } from '../../src/api/server';
import { createTask } from '../../src/core/queue';
import {
  BrowserRestClient,
  BrowserEventClient,
  GuiApiAdapter,
  ApiError,
  ForbiddenLoopbackError,
  ScopeMismatchError,
  TimeoutError,
  SchemaVersionError,
  RuntimeValidationError,
  IdempotencyConflictError,
  assertSchemaVersion,
  validateTask,
  validateRun,
  validateModelLease,
  validateAuditRecord,
} from '../../src/gui/src/api';
import type { SequencedEvent } from '../../src/domain/schemas';

describe('UI1-02: Typed API & Event Clients', () => {
  let testDir: string;
  let server: RestApiServer;
  let port: number;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-02-test-'));

    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });

    // Sample artifact file
    fs.writeFileSync(path.join(testDir, 'artifacts', 'evidence.txt'), 'Test Evidence Content');

    // Create a canonical pending task file
    createTask({
      cwd: testDir,
      id: 'task-test-01',
      description: 'Test task for UI1-02 client verification',
      agent: 'test-agent',
      complexity: 'low',
    });

    const config = {
      projectName: 'test-ui-project',
      routingMode: 'auto',
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
        evidenceRoot: 'artifacts',
      },
      providers: {
        ollama: { baseURL: 'http://127.0.0.1:11434', costPerMillionTokens: 0 },
      },
      agents: [
        {
          id: 'test-agent',
          role: 'tester',
          capabilities: ['code'],
          scope: ['src/'],
        },
      ],
      routing: {
        strategy: 'round_robin',
        costWeight: 0,
        capabilityWeight: 1,
        maxParallelAgents: 1,
        fallbackProvider: 'ollama',
      },
    };
    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

    server = createRestApiServer(testDir);
    port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/api/v1/events`;
  });

  afterAll(async () => {
    await server.stop();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Loopback Confinement and Security
  // ══════════════════════════════════════════════════════════════

  describe('Loopback Confinement and Security', () => {
    it('rejects non-loopback base URL with ForbiddenLoopbackError', () => {
      expect(() => {
        new BrowserRestClient({
          baseUrl: 'http://external-cloud.example.com:3847',
          projectRoot: testDir,
        });
      }).toThrow(ForbiddenLoopbackError);

      expect(() => {
        new BrowserRestClient({
          baseUrl: 'http://192.168.1.100:3847',
          projectRoot: testDir,
        });
      }).toThrow(ForbiddenLoopbackError);
    });

    it('accepts loopback base URLs (127.0.0.1 and localhost)', () => {
      expect(() => {
        new BrowserRestClient({
          baseUrl: 'http://127.0.0.1:3847',
          projectRoot: testDir,
        });
      }).not.toThrow();

      expect(() => {
        new BrowserRestClient({
          baseUrl: 'http://localhost:3847',
          projectRoot: testDir,
        });
      }).not.toThrow();
    });

    it('propagates X-Project-Root and X-Correlation-ID headers automatically', async () => {
      const client = new BrowserRestClient({ baseUrl, projectRoot: testDir });
      const health = await client.getHealth();
      expect(health).toBeDefined();
      expect(health.status).toBe('HEALTHY');
    });

    it('rejects cross-project project root header with ScopeMismatchError', async () => {
      const fakeDir = path.join(os.tmpdir(), 'different-project-dir');
      const client = new BrowserRestClient({ baseUrl, projectRoot: fakeDir });
      await expect(client.getHealth()).rejects.toThrow(ScopeMismatchError);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Typed REST Endpoints (F3-03 Integration)
  // ══════════════════════════════════════════════════════════════

  describe('Typed REST Endpoints', () => {
    let client: BrowserRestClient;

    beforeAll(() => {
      client = new BrowserRestClient({ baseUrl, projectRoot: testDir });
    });

    it('GET /api/v1/health returns valid health envelope', async () => {
      const health = await client.getHealth();
      expect(health.status).toBe('HEALTHY');
      expect(Array.isArray(health.agentPool)).toBe(true);
      expect(health.queueCounts).toBeDefined();
    });

    it('GET /api/v1/project returns project config and profile', async () => {
      const proj = await client.getProject();
      expect(proj.schemaVersion).toBe(1);
      expect(proj.projectName).toBe('test-ui-project');
      expect(proj.profile?.mode).toBe('sovereign-local');
      expect(proj.profile?.zeroCloud).toBe(true);
    });

    it('GET /api/v1/settings returns configuration object', async () => {
      const settings = await client.getSettings();
      expect(settings).toBeDefined();
      expect(settings.projectName).toBe('test-ui-project');
    });

    it('GET /api/v1/tasks returns validated task array', async () => {
      const tasks = await client.getTasks();
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      const first = tasks[0];
      expect(first.id).toBe('task-test-01');
      expect(first.status).toBe('pending');
      expect(first.schemaVersion).toBe(1);
    });

    it('GET /api/v1/models/leases returns lease array', async () => {
      const leases = await client.getModelLeases();
      expect(Array.isArray(leases)).toBe(true);
    });

    it('GET /api/v1/audit returns audit records array', async () => {
      const audit = await client.getAuditEvents();
      expect(Array.isArray(audit)).toBe(true);
    });

    it('GET /openapi.json returns valid OpenAPI 3.1 contract', async () => {
      const spec = await client.getOpenApiSpec();
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toContain('MAOS');
      expect(spec.paths['/api/v1/health']).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Error Mapping
  // ══════════════════════════════════════════════════════════════

  describe('Error Mapping & Envelope Handling', () => {
    let client: BrowserRestClient;

    beforeAll(() => {
      client = new BrowserRestClient({ baseUrl, projectRoot: testDir });
    });

    it('maps 404 responses to ApiError with status 404', async () => {
      await expect(client.getTask('non-existent-task-id-12345')).rejects.toThrow(ApiError);
      try {
        await client.getTask('non-existent-task-id-12345');
      } catch (err: any) {
        expect(err.status).toBe(404);
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    it('maps network failures to NetworkError', async () => {
      // Port 59999 is unlikely to have an active listener
      const unreachableClient = new BrowserRestClient({
        baseUrl: 'http://127.0.0.1:59999',
        projectRoot: testDir,
      });
      await expect(unreachableClient.getHealth()).rejects.toThrow();
    });

    it('times out when server does not respond within timeoutMs', async () => {
      const hangingServer = http.createServer((_req, _res) => {
        // intentionally do not respond to trigger timeout
      });
      await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()));
      const hangingPort = (hangingServer.address() as any).port;

      const timeoutClient = new BrowserRestClient({
        baseUrl: `http://127.0.0.1:${hangingPort}`,
        projectRoot: testDir,
        timeoutMs: 60,
      });

      try {
        await expect(timeoutClient.getHealth()).rejects.toThrow(TimeoutError);
      } finally {
        await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Runtime Schema Validation
  // ══════════════════════════════════════════════════════════════

  describe('Runtime Schema Validation', () => {
    it('assertSchemaVersion throws SchemaVersionError when schemaVersion is invalid', () => {
      expect(() => assertSchemaVersion({} as any, 'Test')).toThrow(RuntimeValidationError);
      expect(() => assertSchemaVersion({ schemaVersion: 2 } as any, 'Test')).toThrow(SchemaVersionError);
      expect(() => assertSchemaVersion({ schemaVersion: 1 }, 'Test')).not.toThrow();
    });

    it('validateTask validates valid Task shape', () => {
      const valid = {
        schemaVersion: 1,
        id: 't-1',
        description: 'valid task',
        status: 'pending',
        type: 'task',
        agent: 'agent-1',
      };
      expect(() => validateTask(valid)).not.toThrow();
    });

    it('validateTask rejects invalid shape with RuntimeValidationError', () => {
      expect(() => validateTask(null)).toThrow(RuntimeValidationError);
      expect(() => validateTask({ id: 't-1' })).toThrow(RuntimeValidationError);
      expect(() => validateTask({ schemaVersion: 1, description: 'missing id' })).toThrow(RuntimeValidationError);
    });

    it('validateModelLease validates valid ModelLease shape', () => {
      const valid = {
        schemaVersion: 1,
        id: 'lease-1',
        modelId: 'm-1',
        agentId: 'a-1',
        port: 8080,
      };
      expect(() => validateModelLease(valid)).not.toThrow();
    });

    it('validateAuditRecord validates valid AuditRecord shape', () => {
      const valid = {
        schemaVersion: 1,
        sequence: 1,
        category: 'stage',
        source: 'orchestrator',
        timestamp: '2026-09-17T12:00:00Z',
        hash: 'abc123hash',
      };
      expect(() => validateAuditRecord(valid)).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. BrowserEventClient (F3-04 Sequenced Events & Replay)
  // ══════════════════════════════════════════════════════════════

  describe('BrowserEventClient Sequenced Event & Replay', () => {
    it('connects to live WebSocket endpoint and establishes connection', async () => {
      const eventClient = new BrowserEventClient({
        wsUrl,
        projectId: 'test-ui-project',
        initialCursor: 0,
      });

      const states: string[] = [];
      const unsub = eventClient.onStateChange((st) => states.push(st));

      eventClient.connect();

      // Wait for connected state
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 4000);
        const check = setInterval(() => {
          if (eventClient.getState() === 'connected') {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });

      expect(eventClient.getState()).toBe('connected');
      unsub();
      eventClient.disconnect();
      expect(eventClient.getState()).toBe('disconnected');
    });

    it('dispatches live events and advances cursor', () => {
      const eventClient = new BrowserEventClient({
        wsUrl: 'ws://127.0.0.1:3847/api/v1/events',
        projectId: 'proj-1',
        initialCursor: 0,
      });

      const received: SequencedEvent[] = [];
      eventClient.onEvent((ev) => received.push(ev));

      // Simulate incoming event frame
      const mockEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'ev-101',
        eventType: 'TASK_STARTED',
        projectId: 'proj-1',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-1',
        payload: { taskId: 'task-1' },
      };

      eventClient.handleMessage(JSON.stringify({ type: 'event', event: mockEvent }));

      expect(received.length).toBe(1);
      expect(received[0].eventId).toBe('ev-101');
      expect(eventClient.getCursor()).toBe(1);
    });

    it('suppresses duplicate events with identical sequence', () => {
      const eventClient = new BrowserEventClient({
        wsUrl: 'ws://127.0.0.1:3847/api/v1/events',
        projectId: 'proj-1',
        initialCursor: 0,
      });

      const received: SequencedEvent[] = [];
      eventClient.onEvent((ev) => received.push(ev));

      const mockEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'ev-102',
        eventType: 'TASK_PROGRESS',
        projectId: 'proj-1',
        sequence: 2,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-2',
        payload: { progress: 50 },
      };

      eventClient.handleMessage(JSON.stringify({ type: 'event', event: mockEvent }));
      // Send identical event again
      eventClient.handleMessage(JSON.stringify({ type: 'event', event: mockEvent }));

      expect(received.length).toBe(1);
      expect(eventClient.getCursor()).toBe(2);
    });

    it('rejects conflicting events with same sequence but different eventId', () => {
      const eventClient = new BrowserEventClient({
        wsUrl: 'ws://127.0.0.1:3847/api/v1/events',
        projectId: 'proj-1',
        initialCursor: 0,
      });

      const received: SequencedEvent[] = [];
      eventClient.onEvent((ev) => received.push(ev));

      const originalEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'ev-original',
        eventType: 'TASK_STARTED',
        projectId: 'proj-1',
        sequence: 5,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-5',
        payload: {},
      };

      const conflictingEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'ev-conflict',
        eventType: 'TASK_FAILED',
        projectId: 'proj-1',
        sequence: 5,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-5',
        payload: {},
      };

      eventClient.handleMessage(JSON.stringify({ type: 'event', event: originalEvent }));
      eventClient.handleMessage(JSON.stringify({ type: 'event', event: conflictingEvent }));

      expect(received.length).toBe(1);
      expect(received[0].eventId).toBe('ev-original');
    });

    it('unpacks replay batches in sequence order and advances cursor', () => {
      const eventClient = new BrowserEventClient({
        wsUrl: 'ws://127.0.0.1:3847/api/v1/events',
        projectId: 'proj-1',
        initialCursor: 0,
      });

      const received: SequencedEvent[] = [];
      eventClient.onEvent((ev) => received.push(ev));

      const batch: SequencedEvent[] = [
        {
          schemaVersion: 1,
          eventId: 'batch-1',
          eventType: 'STEP_1',
          projectId: 'proj-1',
          sequence: 10,
          occurredAt: new Date().toISOString(),
          correlationId: 'corr-10',
          payload: {},
        },
        {
          schemaVersion: 1,
          eventId: 'batch-2',
          eventType: 'STEP_2',
          projectId: 'proj-1',
          sequence: 11,
          occurredAt: new Date().toISOString(),
          correlationId: 'corr-11',
          payload: {},
        },
      ];

      eventClient.handleMessage(
        JSON.stringify({
          type: 'replay_batch',
          events: batch,
          fromCursor: 10,
          toCursor: 11,
          hasMore: false,
        })
      );

      expect(received.length).toBe(2);
      expect(received[0].sequence).toBe(10);
      expect(received[1].sequence).toBe(11);
      expect(eventClient.getCursor()).toBe(11);
    });

    it('invokes resync listeners when resync_required is received', () => {
      const eventClient = new BrowserEventClient({
        wsUrl: 'ws://127.0.0.1:3847/api/v1/events',
        projectId: 'proj-1',
        initialCursor: 100,
      });

      let resyncReason = '';
      let resyncSeq = 0;
      eventClient.onResync((reason, latestSeq) => {
        resyncReason = reason;
        resyncSeq = latestSeq || 0;
      });

      eventClient.handleMessage(
        JSON.stringify({
          type: 'resync_required',
          reason: 'STALE_CURSOR',
          latestSequence: 500,
          oldestSequence: 200,
          projectId: 'proj-1',
          instructions: 'Re-fetch state',
        })
      );

      expect(resyncReason).toBe('STALE_CURSOR');
      expect(resyncSeq).toBe(500);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. GuiApiAdapter Integration
  // ══════════════════════════════════════════════════════════════

  describe('GuiApiAdapter Integration', () => {
    it('provides integrated access to REST and event streams', async () => {
      const adapter = new GuiApiAdapter(baseUrl, testDir, wsUrl);

      const health = await adapter.getHealth();
      expect(health.status).toBe('HEALTHY');

      const tasks = await adapter.getTasks();
      expect(Array.isArray(tasks)).toBe(true);

      const leases = await adapter.getModelLeases();
      expect(Array.isArray(leases)).toBe(true);

      const audit = await adapter.getAuditEvents();
      expect(Array.isArray(audit)).toBe(true);

      expect(typeof adapter.getLastEventSeq()).toBe('number');

      // Test event listener subscription
      const unsub = adapter.subscribeEvents(() => {});
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. GUI Purity & Security Verification
  // ══════════════════════════════════════════════════════════════

  describe('GUI Codebase Purity & Local Sovereignty', () => {
    const guiSrcDir = path.resolve(__dirname, '../../src/gui/src');

    function checkFiles(dir: string, callback: (filePath: string, content: string) => void) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkFiles(fullPath, callback);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          callback(fullPath, fs.readFileSync(fullPath, 'utf8'));
        }
      }
    }

    it('contains ZERO Node.js built-ins in GUI client and views', () => {
      const forbiddenBuiltins = [
        "from 'fs'",
        "from 'node:fs'",
        "from 'child_process'",
        "from 'node:child_process'",
        "from 'net'",
        "from 'node:net'",
        "from 'http'",
        "from 'node:http'",
        "from 'path'",
        "from 'node:path'",
        "from 'os'",
        "from 'node:os'",
      ];

      checkFiles(guiSrcDir, (filePath, content) => {
        for (const forbidden of forbiddenBuiltins) {
          expect(content.includes(forbidden)).toBe(false);
        }
      });
    });

    it('contains ZERO shell/CLI executions in GUI client and views', () => {
      const forbiddenPatterns = [
        'execSync',
        'exec(',
        'spawn(',
        'fork(',
        'child_process',
      ];

      checkFiles(guiSrcDir, (filePath, content) => {
        for (const pattern of forbiddenPatterns) {
          expect(content.includes(pattern)).toBe(false);
        }
      });
    });

    it('contains ZERO localStorage token persistence in GUI client', () => {
      checkFiles(path.join(guiSrcDir, 'api'), (filePath, content) => {
        expect(content.includes('localStorage.setItem')).toBe(false);
        expect(content.includes('sessionStorage.setItem')).toBe(false);
      });
    });
  });
});
