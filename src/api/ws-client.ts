/**
 * MAOS WebSocket Client Helper
 *
 * Provides a typed, zero-dependency client connection for consuming
 * the /api/v1/events sequenced streaming endpoint over RFC 6455.
 */

import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { WsClientMessage, WsServerMessage } from '../domain/schemas';
import { encodeWebSocketFrame, decodeWebSocketFrames, OPCODES } from './ws-frame';

export interface MaosWebSocketClientOptions {
  headers?: Record<string, string>;
  projectId?: string;
  runId?: string;
  cursor?: number;
}

export class MaosWebSocketClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private messageHistory: WsServerMessage[] = [];
  private isConnected = false;
  private isClosed = false;

  constructor() {
    super();
  }

  /**
   * Connect to WebSocket endpoint at url (e.g. http://127.0.0.1:3847/api/v1/events)
   */
  async connect(url: string, options: MaosWebSocketClientOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (options.projectId && !parsed.searchParams.has('projectId')) {
        parsed.searchParams.set('projectId', options.projectId);
      }
      if (options.runId && !parsed.searchParams.has('runId')) {
        parsed.searchParams.set('runId', options.runId);
      }
      if (options.cursor !== undefined && !parsed.searchParams.has('cursor')) {
        parsed.searchParams.set('cursor', String(options.cursor));
      }

      const secKey = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': secKey,
          ...(options.headers || {}),
        },
      });

      req.on('upgrade', (_res, socket, head) => {
        this.socket = socket;
        this.isConnected = true;

        if (head && head.length > 0) {
          this.buffer = Buffer.concat([this.buffer, head]);
          this.processBuffer();
        }

        socket.on('data', (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.processBuffer();
        });

        socket.on('close', () => {
          this.isConnected = false;
          this.isClosed = true;
          this.emit('close');
        });

        socket.on('error', (err: any) => {
          if (this.isClosed || err?.code === 'ECONNRESET' || err?.code === 'EPIPE') {
            return;
          }
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
        });

        this.emit('open');
        resolve();
      });

      req.on('response', (res) => {
        const err = new Error(`WebSocket upgrade rejected with status ${res.statusCode}`);
        (err as any).statusCode = res.statusCode;
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  private processBuffer(): void {
    const { frames, remaining } = decodeWebSocketFrames(this.buffer);
    this.buffer = remaining;

    for (const frame of frames) {
      if (frame.opcode === OPCODES.TEXT) {
        try {
          const msg = JSON.parse(frame.payload.toString('utf-8')) as WsServerMessage;
          this.messageHistory.push(msg);
          this.emit('message', msg);
          if (msg.type === 'event') {
            this.emit('event', msg.event);
          } else if (msg.type === 'replay_batch') {
            this.emit('replay_batch', msg);
          } else if (msg.type === 'resync_required') {
            this.emit('resync_required', msg);
          } else if (msg.type === 'subscribed') {
            this.emit('subscribed', msg);
          }
        } catch (e) {
          this.emit('error', e);
        }
      } else if (frame.opcode === OPCODES.PING) {
        this.pong(frame.payload);
        this.emit('ping', frame.payload);
      } else if (frame.opcode === OPCODES.PONG) {
        this.emit('pong', frame.payload);
      } else if (frame.opcode === OPCODES.CLOSE) {
        this.close();
      }
    }
  }

  /**
   * Send a typed client message (masked RFC 6455 frame).
   */
  send(msg: WsClientMessage): void {
    if (!this.socket || !this.isConnected || this.isClosed) {
      throw new Error('Socket is not connected');
    }
    const json = JSON.stringify(msg);
    const frame = encodeWebSocketFrame(json, OPCODES.TEXT, true);
    this.socket.write(frame);
  }

  /**
   * Subscribe to a project with optional runId and resumption cursor.
   */
  subscribe(projectId: string, runId?: string, cursor?: number): void {
    this.send({
      type: 'subscribe',
      projectId,
      runId,
      cursor,
    });
  }

  /**
   * Send ping frame to server.
   */
  ping(): void {
    if (!this.socket || !this.isConnected || this.isClosed) return;
    const frame = encodeWebSocketFrame(Buffer.alloc(0), OPCODES.PING, true);
    this.socket.write(frame);
  }

  /**
   * Send pong frame to server.
   */
  pong(payload: Buffer = Buffer.alloc(0)): void {
    if (!this.socket || !this.isConnected || this.isClosed) return;
    const frame = encodeWebSocketFrame(payload, OPCODES.PONG, true);
    this.socket.write(frame);
  }

  /**
   * Wait for a specific message type or matching predicate.
   */
  waitForMessage<T extends WsServerMessage>(
    predicate: (msg: WsServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    const existingIndex = this.messageHistory.findIndex(predicate);
    if (existingIndex !== -1) {
      const found = this.messageHistory.splice(existingIndex, 1)[0];
      return Promise.resolve(found as T);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMsg);
        reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMsg = (msg: WsServerMessage) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          this.off('message', onMsg);
          const idx = this.messageHistory.indexOf(msg);
          if (idx !== -1) this.messageHistory.splice(idx, 1);
          resolve(msg as T);
        }
      };

      this.on('message', onMsg);
    });
  }

  /**
   * Close connection cleanly.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.socket && !this.socket.destroyed) {
      try {
        const frame = encodeWebSocketFrame(Buffer.alloc(0), OPCODES.CLOSE, true);
        this.socket.write(frame);
        this.socket.end();
      } catch {}
    }
  }

  isOpen(): boolean {
    return this.isConnected && !this.isClosed;
  }
}
