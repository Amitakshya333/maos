/**
 * MAOS Event Broker & WebSocket Subscription Manager
 *
 * Implements:
 *   - Live event broadcasting over WebSocket (/api/v1/events)
 *   - Persistent monotonic sequence delivery
 *   - Replay from disk after client cursor
 *   - Stale-cursor and forward-gap detection with explicit `resync_required` frames
 *   - Project and run filtering
 *   - Deduplication and conflict detection
 *   - Zero-dependency RFC 6455 framing
 *   - Backpressure and graceful disconnect lifecycle
 */

import * as net from 'net';
import * as crypto from 'crypto';
import { ServiceContainer } from '../service';
import type { SequencedEvent, WsServerMessage, WsClientMessage, ResyncReason } from '../domain/schemas';
import { encodeWebSocketFrame, decodeWebSocketFrames, OPCODES } from './ws-frame';

const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024; // 1 MB backpressure limit
const MAX_REPLAY_BATCH_SIZE = 500;

interface Subscriber {
  readonly id: string;
  readonly socket: net.Socket;
  projectId: string;
  runId?: string;
  lastSentSequence: number;
  buffer: Buffer;
  isAlive: boolean;
}

export class EventBroker {
  private readonly subscribers: Map<string, Subscriber> = new Map();
  private readonly recentEventIds: Map<string, string> = new Map(); // eventId -> payloadHash
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly services: ServiceContainer,
    private readonly projectRoot: string,
  ) {
    this.startHeartbeat();
  }

  /**
   * Register a newly upgraded WebSocket connection.
   */
  handleConnection(socket: net.Socket, initialQuery?: { projectId?: string; runId?: string; cursor?: number }): void {
    const id = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const subscriber: Subscriber = {
      id,
      socket,
      projectId: initialQuery?.projectId || '',
      runId: initialQuery?.runId,
      lastSentSequence: initialQuery?.cursor ?? -1,
      buffer: Buffer.alloc(0),
      isAlive: true,
    };

    this.subscribers.set(id, subscriber);

    // If query parameters provided initial subscription, process it immediately
    if (initialQuery?.projectId) {
      this.processSubscription(subscriber, initialQuery.projectId, initialQuery.runId, initialQuery.cursor);
    }

    socket.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      subscriber.buffer = Buffer.concat([subscriber.buffer, buf]);
      const { frames, remaining } = decodeWebSocketFrames(subscriber.buffer);
      subscriber.buffer = remaining;

      for (const frame of frames) {
        this.handleFrame(subscriber, frame.opcode, frame.payload);
      }
    });

    socket.on('close', () => {
      this.removeSubscriber(id);
    });

    socket.on('error', () => {
      this.removeSubscriber(id);
    });
  }

  private handleFrame(subscriber: Subscriber, opcode: number, payload: Buffer): void {
    if (opcode === OPCODES.CLOSE) {
      this.sendClose(subscriber, 1000, 'Normal Closure');
      subscriber.socket.end();
      this.removeSubscriber(subscriber.id);
      return;
    }

    if (opcode === OPCODES.PING) {
      subscriber.socket.write(encodeWebSocketFrame(payload, OPCODES.PONG));
      return;
    }

    if (opcode === OPCODES.PONG) {
      subscriber.isAlive = true;
      return;
    }

    if (opcode === OPCODES.TEXT) {
      const text = payload.toString('utf-8');
      try {
        const msg = JSON.parse(text) as WsClientMessage;
        if (msg.type === 'ping') {
          this.sendMessage(subscriber, {
            type: 'pong',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (msg.type === 'subscribe') {
          this.processSubscription(subscriber, msg.projectId, msg.runId, msg.cursor);
        }
      } catch {
        this.sendMessage(subscriber, {
          type: 'error',
          code: 'MALFORMED_MESSAGE',
          message: 'Received invalid JSON message.',
        });
      }
    }
  }

  /**
   * Process client subscription with strict project validation, gap detection,
   * stale-cursor detection, and persistent replay.
   */
  private processSubscription(subscriber: Subscriber, projectId: string, runId?: string, cursor?: number): void {
    let expectedProject = 'default';
    try {
      const config = this.services.project.loadConfig();
      expectedProject = config.projectName || 'default';
    } catch {}

    // 1. Wrong-Project Rejection
    if (projectId !== expectedProject && projectId !== 'default') {
      this.sendMessage(subscriber, {
        type: 'resync_required',
        reason: 'PROJECT_MISMATCH',
        latestSequence: 0,
        oldestSequence: 0,
        projectId: expectedProject,
        instructions: `Client requested projectId '${projectId}' but server is hosting '${expectedProject}'. Reconnect to the correct project.`,
      });
      return;
    }

    subscriber.projectId = projectId;
    subscriber.runId = runId;

    const bounds = this.services.event.getSequenceBounds();

    // 2. Cursor Bounds Validation
    if (cursor !== undefined) {
      // Forward gap check (cursor > latest sequence)
      if (cursor > bounds.latest) {
        this.sendMessage(subscriber, {
          type: 'resync_required',
          reason: 'SEQUENCE_GAP',
          latestSequence: bounds.latest,
          oldestSequence: bounds.oldest,
          projectId,
          instructions: `Cursor sequence ${cursor} is ahead of server sequence ${bounds.latest}. Resync state from latest snapshot.`,
        });
        return;
      }

      // Stale cursor check (cursor < oldest retained sequence)
      if (bounds.oldest > 1 && cursor < bounds.oldest - 1) {
        this.sendMessage(subscriber, {
          type: 'resync_required',
          reason: 'STALE_CURSOR',
          latestSequence: bounds.latest,
          oldestSequence: bounds.oldest,
          projectId,
          instructions: `Cursor ${cursor} is older than the oldest retained event (${bounds.oldest}). Resync required via REST snapshot.`,
        });
        return;
      }
    }

    // Acknowledge subscription
    this.sendMessage(subscriber, {
      type: 'subscribed',
      projectId,
      latestSequence: bounds.latest,
    });

    // 3. Persistent Replay Phase
    if (cursor !== undefined && cursor < bounds.latest) {
      const missedEvents = this.services.event.querySequenced({
        fromSeq: cursor,
        limit: MAX_REPLAY_BATCH_SIZE,
        projectId,
        runId,
      });

      if (missedEvents.length > 0) {
        const toCursor = missedEvents[missedEvents.length - 1].sequence;
        this.sendMessage(subscriber, {
          type: 'replay_batch',
          events: missedEvents,
          fromCursor: cursor,
          toCursor,
          hasMore: toCursor < bounds.latest,
        });
        subscriber.lastSentSequence = toCursor;
      } else {
        subscriber.lastSentSequence = cursor;
      }
    } else {
      subscriber.lastSentSequence = bounds.latest;
    }
  }

  /**
   * Broadcast a persisted SequencedEvent to active matching subscribers.
   * Ensures persistence has occurred, checks for conflicting duplicates,
   * and enforces backpressure.
   */
  broadcast(event: SequencedEvent): void {
    // Conflicting duplicate event detection
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(event.payload)).digest('hex');
    const existingHash = this.recentEventIds.get(event.eventId);

    if (existingHash && existingHash !== payloadHash) {
      throw new Error(`CONFLICTING_DUPLICATE_EVENT: Event ID '${event.eventId}' was previously recorded with differing payload.`);
    }
    if (this.recentEventIds.size > 5000) {
      const oldestKey = this.recentEventIds.keys().next().value;
      if (oldestKey) this.recentEventIds.delete(oldestKey);
    }
    this.recentEventIds.set(event.eventId, payloadHash);

    for (const [id, sub] of this.subscribers.entries()) {
      // Must be subscribed to a project
      if (!sub.projectId) continue;
      // Scope filter: match project and optional run
      if (sub.projectId !== event.projectId && sub.projectId !== 'default') continue;
      if (sub.runId && event.runId && sub.runId !== event.runId) continue;

      // Monotonic deduplication: never resend already dispatched sequence
      if (event.sequence <= sub.lastSentSequence) continue;

      // Backpressure check
      if (sub.socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
        this.sendMessage(sub, {
          type: 'error',
          code: 'SLOW_CONSUMER_BACKPRESSURE',
          message: 'Client socket buffer congested. Disconnecting.',
        });
        this.sendClose(sub, 1008, 'Slow consumer backpressure');
        sub.socket.destroy();
        this.removeSubscriber(id);
        continue;
      }

      this.sendMessage(sub, {
        type: 'event',
        event,
      });
      sub.lastSentSequence = event.sequence;
    }
  }

  private sendMessage(subscriber: Subscriber, message: WsServerMessage): void {
    if (subscriber.socket.destroyed || !subscriber.socket.writable) return;
    try {
      const json = JSON.stringify(message);
      const frame = encodeWebSocketFrame(json, OPCODES.TEXT);
      subscriber.socket.write(frame);
    } catch {
      this.removeSubscriber(subscriber.id);
    }
  }

  private sendClose(subscriber: Subscriber, code: number, reason: string): void {
    if (subscriber.socket.destroyed || !subscriber.socket.writable) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    subscriber.socket.write(encodeWebSocketFrame(body, OPCODES.CLOSE));
  }

  private removeSubscriber(id: string): void {
    this.subscribers.delete(id);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [id, sub] of this.subscribers.entries()) {
        if (!sub.isAlive) {
          sub.socket.destroy();
          this.removeSubscriber(id);
          continue;
        }
        sub.isAlive = false;
        try {
          sub.socket.write(encodeWebSocketFrame(Buffer.alloc(0), OPCODES.PING));
        } catch {
          this.removeSubscriber(id);
        }
      }
    }, 30000);
    if (this.heartbeatInterval && (this.heartbeatInterval as any).unref) {
      (this.heartbeatInterval as any).unref();
    }
  }

  /**
   * Stop the broker and close all active sockets.
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const sub of this.subscribers.values()) {
      try {
        sub.socket.destroy();
      } catch {}
    }
    this.subscribers.clear();
  }

  /**
   * Get active subscriber count.
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}
