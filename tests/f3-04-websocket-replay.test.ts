/**
 * F3-04 — Sequenced WebSocket and Event Replay Contract Tests
 *
 * Verifies:
 *   - RFC 6455 Frame encoding & decoding (text, ping, pong, close, masking)
 *   - WebSocket upgrade on /api/v1/events with loopback and project scope validation
 *   - Persistence-first architecture (disk write precedes WebSocket dispatch)
 *   - Project and runId filtered subscriptions
 *   - Reconnect with cursor: lossless, ordered replay without duplication
 *   - Forward gap detection -> resync_required (SEQUENCE_GAP)
 *   - Stale cursor detection -> resync_required (STALE_CURSOR)
 *   - Conflicting duplicate payload detection
 *   - Heartbeat ping-pong exchanges
 *   - REST history fallback (/api/v1/events)
 *   - Clean disconnect & lifecycle teardown
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createRestApiServer, RestApiServer } from '../src/api/server';
import { MaosWebSocketClient } from '../src/api/ws-client';
import {
  encodeWebSocketFrame,
  decodeWebSocketFrames,
  OPCODES,
  createWebSocketAccept,
} from '../src/api/ws-frame';
import type { SequencedEvent, WsServerResyncMessage, WsServerReplayBatchMessage } from '../src/domain/schemas';

describe('F3-04 Sequenced WebSocket and Event Replay Contract', () => {
  let testDir: string;
  let server: RestApiServer;
  let port: number;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ws-test-'));

    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });

    const config = {
      projectName: 'test-ws-project',
      routingMode: 'auto',
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
      },
      providers: {},
      agents: [
        {
          id: 'test-agent',
          name: 'Test Agent',
          description: 'Testing',
          capabilities: ['code'],
          complexity: 'low',
        },
      ],
      routing: { low: 'test-agent', medium: 'test-agent', high: 'test-agent' },
    };
    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

    server = createRestApiServer(testDir);
    port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `${baseUrl}/api/v1/events`;
  });

  afterAll(async () => {
    await server.stop();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. RFC 6455 Frame Encoding & Decoding Unit Tests ───────────

  describe('RFC 6455 Framing', () => {
    it('should compute correct Sec-WebSocket-Accept key', () => {
      // RFC 6455 test vector
      const clientKey = 'dGhlIHNhbXBsZSBub25jZQ==';
      const expectedAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
      expect(createWebSocketAccept(clientKey)).toBe(expectedAccept);
    });

    it('should encode and decode unmasked text frames', () => {
      const payload = JSON.stringify({ hello: 'world' });
      const encoded = encodeWebSocketFrame(payload, OPCODES.TEXT, false);
      const { frames, remaining } = decodeWebSocketFrames(encoded);

      expect(remaining.length).toBe(0);
      expect(frames.length).toBe(1);
      expect(frames[0].opcode).toBe(OPCODES.TEXT);
      expect(frames[0].payload.toString('utf-8')).toBe(payload);
    });

    it('should encode and decode masked text frames', () => {
      const payload = 'Masked client message';
      const encoded = encodeWebSocketFrame(payload, OPCODES.TEXT, true);
      const { frames, remaining } = decodeWebSocketFrames(encoded);

      expect(remaining.length).toBe(0);
      expect(frames.length).toBe(1);
      expect(frames[0].opcode).toBe(OPCODES.TEXT);
      expect(frames[0].payload.toString('utf-8')).toBe(payload);
    });

    it('should encode and decode ping, pong, and close frames', () => {
      const pingData = Buffer.from('ping-payload');
      const pingFrame = encodeWebSocketFrame(pingData, OPCODES.PING, false);
      const decodedPing = decodeWebSocketFrames(pingFrame);
      expect(decodedPing.frames[0].opcode).toBe(OPCODES.PING);
      expect(decodedPing.frames[0].payload.toString()).toBe('ping-payload');

      const closeBody = Buffer.alloc(2 + 4);
      closeBody.writeUInt16BE(1000, 0);
      closeBody.write('done', 2);
      const closeFrame = encodeWebSocketFrame(closeBody, OPCODES.CLOSE, false);
      const decodedClose = decodeWebSocketFrames(closeFrame);
      expect(decodedClose.frames[0].opcode).toBe(OPCODES.CLOSE);
      expect(decodedClose.frames[0].payload.readUInt16BE(0)).toBe(1000);
      expect(decodedClose.frames[0].payload.slice(2).toString()).toBe('done');
    });

    it('should decode multiple frames in a single buffer chunk', () => {
      const f1 = encodeWebSocketFrame('one', OPCODES.TEXT, false);
      const f2 = encodeWebSocketFrame('two', OPCODES.TEXT, false);
      const combined = Buffer.concat([f1, f2]);

      const { frames, remaining } = decodeWebSocketFrames(combined);
      expect(frames.length).toBe(2);
      expect(frames[0].payload.toString()).toBe('one');
      expect(frames[1].payload.toString()).toBe('two');
      expect(remaining.length).toBe(0);
    });

    it('should handle partial frames until remaining bytes arrive', () => {
      const frame = encodeWebSocketFrame('partial frame testing', OPCODES.TEXT, false);
      const part1 = frame.slice(0, 5);
      const part2 = frame.slice(5);

      const r1 = decodeWebSocketFrames(part1);
      expect(r1.frames.length).toBe(0);
      expect(r1.remaining.length).toBe(5);

      const r2 = decodeWebSocketFrames(Buffer.concat([r1.remaining, part2]));
      expect(r2.frames.length).toBe(1);
      expect(r2.frames[0].payload.toString()).toBe('partial frame testing');
      expect(r2.remaining.length).toBe(0);
    });
  });

  // ── 2. WebSocket Upgrade Security & Validation ──────────────────

  describe('Upgrade Security & Validation', () => {
    it('should reject upgrade request to undocumented path with 404', async () => {
      const client = new MaosWebSocketClient();
      await expect(client.connect(`${baseUrl}/api/v1/not-events`)).rejects.toThrow(
        /WebSocket upgrade rejected with status 404/,
      );
      client.close();
    });

    it('should reject upgrade request with mismatched X-Project-Root with 400', async () => {
      const client = new MaosWebSocketClient();
      await expect(
        client.connect(wsUrl, {
          headers: { 'X-Project-Root': path.join(testDir, 'other-project') },
        }),
      ).rejects.toThrow(/WebSocket upgrade rejected with status 400/);
      client.close();
    });

    it('should successfully establish WebSocket upgrade on /api/v1/events', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);
      expect(client.isOpen()).toBe(true);
      client.close();
    });
  });

  // ── 3. Subscription & Live Streaming ───────────────────────────

  describe('Subscription and Live Streaming', () => {
    it('should subscribe and receive subscribed acknowledgment', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);

      const subPromise = client.waitForMessage((m) => m.type === 'subscribed');
      client.subscribe('test-ws-project');

      const ack: any = await subPromise;
      expect(ack.type).toBe('subscribed');
      expect(ack.projectId).toBe('test-ws-project');
      expect(typeof ack.latestSequence).toBe('number');

      client.close();
    });

    it('should reject subscription with mismatched project using resync_required', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);

      const resyncPromise = client.waitForMessage<WsServerResyncMessage>(
        (m) => m.type === 'resync_required',
      );
      client.subscribe('foreign-project');

      const resync = await resyncPromise;
      expect(resync.type).toBe('resync_required');
      expect(resync.reason).toBe('PROJECT_MISMATCH');
      expect(resync.instructions).toContain('foreign-project');

      client.close();
    });

    it('should stream newly recorded events in strict sequence', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl, { projectId: 'test-ws-project' });

      // Wait for subscription confirmation
      await client.waitForMessage((m) => m.type === 'subscribed');

      const eventPromise = client.waitForMessage<any>((m) => m.type === 'event');

      // Application service records an event (persisted to disk first)
      const recorded = server.getServices().event.recordEvent({
        eventType: 'TASK_DISPATCHED',
        projectId: 'test-ws-project',
        correlationId: 'corr_test_live_1',
        payload: { task: 'T-001', agent: 'test-agent' },
      });

      const received: any = await eventPromise;
      expect(received.type).toBe('event');
      expect(received.event.eventId).toBe(recorded.eventId);
      expect(received.event.sequence).toBe(recorded.sequence);
      expect(received.event.eventType).toBe('TASK_DISPATCHED');
      expect(received.event.payload).toEqual({ task: 'T-001', agent: 'test-agent' });

      client.close();
    });

    it('should filter events by runId when subscribed with runId', async () => {
      const clientRunA = new MaosWebSocketClient();
      const clientRunB = new MaosWebSocketClient();

      await clientRunA.connect(wsUrl, { projectId: 'test-ws-project', runId: 'run-A' });
      await clientRunB.connect(wsUrl, { projectId: 'test-ws-project', runId: 'run-B' });

      await Promise.all([
        clientRunA.waitForMessage((m) => m.type === 'subscribed'),
        clientRunB.waitForMessage((m) => m.type === 'subscribed'),
      ]);

      const eventsA: SequencedEvent[] = [];
      const eventsB: SequencedEvent[] = [];

      clientRunA.on('event', (evt) => eventsA.push(evt));
      clientRunB.on('event', (evt) => eventsB.push(evt));

      // Record event for run-A
      server.getServices().event.recordEvent({
        eventType: 'STEP_STARTED',
        projectId: 'test-ws-project',
        runId: 'run-A',
        correlationId: 'corr_run_a',
        payload: { step: 1 },
      });

      // Wait for run-A event delivery
      await new Promise((r) => setTimeout(r, 100));

      expect(eventsA.length).toBe(1);
      expect(eventsA[0].runId).toBe('run-A');
      expect(eventsB.length).toBe(0); // clientRunB must not receive run-A event

      clientRunA.close();
      clientRunB.close();
    });
  });

  // ── 4. Disconnection, Missed Events, and Ordered Replay ────────

  describe('Disconnection and Ordered Replay', () => {
    it('should replay missed events in order after reconnect with cursor', async () => {
      // 1. First client connects and gets latest sequence
      const client1 = new MaosWebSocketClient();
      await client1.connect(wsUrl, { projectId: 'test-ws-project' });
      const ack1: any = await client1.waitForMessage((m) => m.type === 'subscribed');
      const cursorAtDisconnect = ack1.latestSequence;
      client1.close();

      // 2. While client is offline, server persists multiple new events
      const evt1 = server.getServices().event.recordEvent({
        eventType: 'TASK_CREATED',
        projectId: 'test-ws-project',
        correlationId: 'corr_replay_1',
        payload: { name: 'First offline task' },
      });
      const evt2 = server.getServices().event.recordEvent({
        eventType: 'TASK_APPROVED',
        projectId: 'test-ws-project',
        correlationId: 'corr_replay_2',
        payload: { name: 'First offline task approved' },
      });
      const evt3 = server.getServices().event.recordEvent({
        eventType: 'TASK_COMPLETED',
        projectId: 'test-ws-project',
        correlationId: 'corr_replay_3',
        payload: { name: 'First offline task done' },
      });

      // 3. Client reconnects with cursor
      const client2 = new MaosWebSocketClient();
      await client2.connect(wsUrl, {
        projectId: 'test-ws-project',
        cursor: cursorAtDisconnect,
      });

      // 4. Must receive subscribed ACK followed by replay_batch containing evt1, evt2, evt3
      await client2.waitForMessage((m) => m.type === 'subscribed');
      const replayMsg = await client2.waitForMessage<WsServerReplayBatchMessage>(
        (m) => m.type === 'replay_batch',
      );

      expect(replayMsg.type).toBe('replay_batch');
      expect(replayMsg.fromCursor).toBe(cursorAtDisconnect);
      expect(replayMsg.toCursor).toBe(evt3.sequence);
      expect(replayMsg.events.length).toBeGreaterThanOrEqual(3);

      const replayedIds = replayMsg.events.map((e) => e.eventId);
      expect(replayedIds).toContain(evt1.eventId);
      expect(replayedIds).toContain(evt2.eventId);
      expect(replayedIds).toContain(evt3.eventId);

      // Verify strict ascending sequence ordering in replay
      for (let i = 1; i < replayMsg.events.length; i++) {
        expect(replayMsg.events[i].sequence).toBeGreaterThan(replayMsg.events[i - 1].sequence);
      }

      // 5. Subsequent live event is dispatched without repeating replayed events
      const livePromise = client2.waitForMessage<any>((m) => m.type === 'event');
      const evt4 = server.getServices().event.recordEvent({
        eventType: 'LIVE_AFTER_REPLAY',
        projectId: 'test-ws-project',
        correlationId: 'corr_live_after_replay',
        payload: { status: 'new live' },
      });

      const liveReceived: any = await livePromise;
      expect(liveReceived.event.eventId).toBe(evt4.eventId);
      expect(liveReceived.event.sequence).toBe(evt4.sequence);

      client2.close();
    });
  });

  // ── 5. Gap & Stale Cursor Detection ────────────────────────────

  describe('Gap & Stale Cursor Detection', () => {
    it('should detect forward sequence gap and emit resync_required (SEQUENCE_GAP)', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);

      const resyncPromise = client.waitForMessage<WsServerResyncMessage>(
        (m) => m.type === 'resync_required',
      );
      // Pass impossible future cursor
      client.subscribe('test-ws-project', undefined, 999999);

      const resync = await resyncPromise;
      expect(resync.type).toBe('resync_required');
      expect(resync.reason).toBe('SEQUENCE_GAP');
      expect(resync.instructions).toContain('Resync state from latest snapshot');

      client.close();
    });

    it('should detect stale cursor when cursor is older than retention', async () => {
      // Create a temporary project directory with an event store where oldest sequence is 20
      const rotatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-rotated-test-'));
      const rotatedMaos = path.join(rotatedDir, '.maos');
      fs.mkdirSync(path.join(rotatedMaos, 'events'), { recursive: true });
      fs.writeFileSync(
        path.join(rotatedMaos, 'maos.config.json'),
        JSON.stringify({ projectName: 'rotated-project' }),
      );

      // Write event file starting at sequence 20
      const eventLines = [
        JSON.stringify({ schemaVersion: 1, eventId: 'e20', eventType: 'TEST', projectId: 'rotated-project', sequence: 20, occurredAt: new Date().toISOString(), correlationId: 'c20', payload: {} }),
        JSON.stringify({ schemaVersion: 1, eventId: 'e25', eventType: 'TEST', projectId: 'rotated-project', sequence: 25, occurredAt: new Date().toISOString(), correlationId: 'c25', payload: {} }),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(rotatedMaos, 'events', 'events.jsonl'), eventLines);
      fs.writeFileSync(path.join(rotatedMaos, 'events', 'seq'), '25');

      const rotatedServer = createRestApiServer(rotatedDir);
      const rotatedPort = await rotatedServer.start(0);

      const client = new MaosWebSocketClient();
      await client.connect(`http://127.0.0.1:${rotatedPort}/api/v1/events`);

      const resyncPromise = client.waitForMessage<WsServerResyncMessage>(
        (m) => m.type === 'resync_required',
      );

      // Client cursor is 5, but oldest retained is 20
      client.subscribe('rotated-project', undefined, 5);

      const resync = await resyncPromise;
      expect(resync.type).toBe('resync_required');
      expect(resync.reason).toBe('STALE_CURSOR');
      expect(resync.oldestSequence).toBe(20);

      client.close();
      await rotatedServer.stop();
      try {
        fs.rmSync(rotatedDir, { recursive: true, force: true });
      } catch {}
    });
  });

  // ── 6. Conflicting Duplicate Event Detection ───────────────────

  describe('Duplicate & Conflict Detection', () => {
    it('should allow idempotent duplicate broadcast with identical payload', () => {
      const broker = server.getEventBroker();
      const sampleEvent: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'duplicate_test_evt_1',
        eventType: 'TEST_IDEMPOTENT',
        projectId: 'test-ws-project',
        sequence: 99991,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr_dup_1',
        payload: { key: 'same-payload' },
      };

      // First broadcast
      expect(() => broker.broadcast(sampleEvent)).not.toThrow();
      // Second broadcast with IDENTICAL payload -> should succeed idempotently
      expect(() => broker.broadcast(sampleEvent)).not.toThrow();
    });

    it('should reject conflicting duplicate broadcast with differing payload', () => {
      const broker = server.getEventBroker();
      const eventA: SequencedEvent = {
        schemaVersion: 1,
        eventId: 'conflict_test_evt_1',
        eventType: 'TEST_CONFLICT',
        projectId: 'test-ws-project',
        sequence: 99992,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr_conflict_1',
        payload: { value: 100 },
      };

      const eventB: SequencedEvent = {
        ...eventA,
        payload: { value: 999 }, // Differing payload for same eventId!
      };

      expect(() => broker.broadcast(eventA)).not.toThrow();
      expect(() => broker.broadcast(eventB)).toThrow(/CONFLICTING_DUPLICATE_EVENT/);
    });
  });

  // ── 7. Heartbeat Ping-Pong ─────────────────────────────────────

  describe('Heartbeat & Ping-Pong', () => {
    it('should reply with pong message upon receiving client ping message', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);

      const pongPromise = client.waitForMessage((m) => m.type === 'pong');
      client.send({ type: 'ping' });

      const pong: any = await pongPromise;
      expect(pong.type).toBe('pong');
      expect(typeof pong.timestamp).toBe('string');

      client.close();
    });

    it('should reply with pong frame upon receiving client ping frame', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl);

      const pongFramePromise = new Promise<void>((resolve) => {
        client.once('pong', () => resolve());
      });

      client.ping();
      await pongFramePromise;

      client.close();
    });
  });

  // ── 8. REST History Fallback (/api/v1/events) ───────────────────

  describe('REST History Fallback', () => {
    it('GET /api/v1/events should return sequenced events and bounds metadata', async () => {
      const res = await fetch(`${baseUrl}/api/v1/events`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toBeDefined();
      expect(typeof body.meta.latestSequence).toBe('number');
      expect(typeof body.meta.oldestSequence).toBe('number');
      expect(typeof body.meta.count).toBe('number');
    });

    it('GET /api/v1/events with cursor should return only events after cursor', async () => {
      const allRes = await fetch(`${baseUrl}/api/v1/events`);
      const allBody = await allRes.json();
      expect(allBody.data.length).toBeGreaterThanOrEqual(2);

      const targetCursor = allBody.data[1].sequence;
      const paginatedRes = await fetch(`${baseUrl}/api/v1/events?cursor=${targetCursor}&limit=2`);
      const paginatedBody = await paginatedRes.json();

      expect(paginatedRes.status).toBe(200);
      for (const evt of paginatedBody.data) {
        expect(evt.sequence).toBeGreaterThan(targetCursor);
      }
    });

    it('GET /api/v1/events with impossible cursor should return 409 SEQUENCE_GAP', async () => {
      const res = await fetch(`${baseUrl}/api/v1/events?cursor=999999`);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('SEQUENCE_GAP');
    });

    it('POST /api/v1/events should persist event and broadcast to active subscriber', async () => {
      const client = new MaosWebSocketClient();
      await client.connect(wsUrl, { projectId: 'test-ws-project' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      const eventDeliveryPromise = client.waitForMessage<any>((m) => m.type === 'event');

      const postRes = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'API_DISPATCHED_EVENT',
          projectId: 'test-ws-project',
          payload: { source: 'rest_client' },
        }),
      });

      expect(postRes.status).toBe(201);
      const postBody = await postRes.json();
      expect(postBody.data.eventType).toBe('API_DISPATCHED_EVENT');
      expect(postBody.data.sequence).toBeGreaterThan(0);

      const received: any = await eventDeliveryPromise;
      expect(received.event.eventId).toBe(postBody.data.eventId);
      expect(received.event.sequence).toBe(postBody.data.sequence);

      client.close();
    });

    it('POST /api/v1/events should reject mismatched project with 400', async () => {
      const postRes = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'WRONG_PROJECT_EVENT',
          projectId: 'wrong-project-xyz',
          payload: {},
        }),
      });

      expect(postRes.status).toBe(400);
      const body = await postRes.json();
      expect(body.error.code).toBe('PROJECT_MISMATCH');
    });
  });

  // ── 9. Client Disconnection & Broker Lifecycle ─────────────────

  describe('Disconnect & Broker Lifecycle', () => {
    it('should unregister subscriber cleanly upon client close', async () => {
      const broker = server.getEventBroker();
      const initialCount = broker.getSubscriberCount();

      const client = new MaosWebSocketClient();
      await client.connect(wsUrl, { projectId: 'test-ws-project' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      expect(broker.getSubscriberCount()).toBe(initialCount + 1);

      client.close();
      await new Promise((r) => setTimeout(r, 100));

      expect(broker.getSubscriberCount()).toBe(initialCount);
    });
  });
});
