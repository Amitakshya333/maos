/**
 * UI1-02: Browser-Safe Sequenced WebSocket Event Client
 *
 * Implements resilient event stream consumption over local loopback:
 *   - Monotonic in-memory cursor tracking (never in web storage)
 *   - Project and runId scoped subscription
 *   - Reconnection with exponential backoff
 *   - Replay batch processing
 *   - Duplicate suppression & conflicting event rejection
 *   - Sequence gap and stale cursor resynchronization
 *   - Connection lifecycle observables
 */

import { validateSequencedEvent } from './runtime-validation';
import type { SequencedEvent, ResyncReason } from '../../../domain/schemas';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'resyncing'
  | 'failed';

export interface EventClientOptions {
  wsUrl?: string;
  projectId?: string;
  runId?: string;
  sessionToken?: string;
  initialCursor?: number;
  maxReconnectAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  WebSocketClass?: typeof WebSocket;
}

export type EventListener = (event: SequencedEvent) => void;
export type StateListener = (state: ConnectionState) => void;
export type ResyncListener = (reason: ResyncReason, latestSequence?: number) => void;

export class BrowserEventClient {
  private readonly wsUrl: string;
  private readonly projectId: string;
  private readonly runId?: string;
  private readonly maxReconnectAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly WS: typeof WebSocket;
  private sessionToken?: string;

  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private cursor = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isExplicitDisconnect = false;

  // Track delivered events for duplicate suppression and conflict detection
  private readonly deliveredEvents = new Map<number, string>(); // seq -> eventId

  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly resyncListeners = new Set<ResyncListener>();

  constructor(options: EventClientOptions = {}) {
    this.wsUrl = options.wsUrl || 'ws://127.0.0.1:3847/api/v1/events';
    this.projectId = options.projectId || 'default-project';
    this.runId = options.runId;
    this.sessionToken = options.sessionToken;
    this.cursor = options.initialCursor || 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.WS = options.WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : (null as any));
  }

  setSessionToken(token?: string): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | undefined {
    return this.sessionToken;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getCursor(): number {
    return this.cursor;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onResync(listener: ResyncListener): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      for (const listener of this.stateListeners) {
        try {
          listener(this.state);
        } catch {
          // ignore observer errors
        }
      }
    }
  }

  /**
   * Connect to loopback WebSocket server.
   */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }
    this.isExplicitDisconnect = false;
    this.initiateConnection();
  }

  private initiateConnection(): void {
    if (!this.WS) {
      this.setState('failed');
      return;
    }

    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      let targetUrl = this.wsUrl;
      try {
        const urlObj = new URL(this.wsUrl);
        if (this.projectId && !urlObj.searchParams.has('projectId')) {
          urlObj.searchParams.set('projectId', this.projectId);
        }
        if (this.runId && !urlObj.searchParams.has('runId')) {
          urlObj.searchParams.set('runId', this.runId);
        }
        if (this.cursor > 0 && !urlObj.searchParams.has('cursor')) {
          urlObj.searchParams.set('cursor', String(this.cursor));
        }
        targetUrl = urlObj.toString();
      } catch {
        // Fall back to raw url if URL constructor fails
      }

      const protocols = this.sessionToken
        ? ['maos-v1', `maos-auth.${this.sessionToken}`]
        : ['maos-v1'];

      this.ws = new this.WS(targetUrl, protocols);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setState('connected');
        // Send subscribe handshake with current cursor
        this.sendSubscribe();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (!this.isExplicitDisconnect) {
          this.scheduleReconnect();
        } else {
          this.setState('disconnected');
        }
      };

      this.ws.onerror = () => {
        // Handled by onclose
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const msg = {
      type: 'subscribe',
      projectId: this.projectId,
      runId: this.runId,
      cursor: this.cursor,
    };
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Handle incoming raw string or Buffer from WebSocket.
   */
  handleMessage(rawData: any): void {
    let parsed: any;
    try {
      parsed = typeof rawData === 'string' ? JSON.parse(rawData) : JSON.parse(rawData.toString());
    } catch {
      return; // Discard unparseable frames
    }

    if (!parsed || typeof parsed !== 'object') return;

    switch (parsed.type) {
      case 'subscribed':
        // Acknowledged subscription
        break;

      case 'replay_batch':
        if (Array.isArray(parsed.events)) {
          for (const rawEvt of parsed.events) {
            this.processEvent(rawEvt);
          }
        }
        break;

      case 'event':
        if (parsed.event) {
          this.processEvent(parsed.event);
        }
        break;

      case 'resync_required': {
        const reason: ResyncReason = parsed.reason || 'SEQUENCE_GAP';
        this.setState('resyncing');
        for (const listener of this.resyncListeners) {
          try {
            listener(reason, parsed.latestSequence);
          } catch {
            // ignore
          }
        }
        // Resubscribe or reset cursor depending on reason
        if (reason === 'STALE_CURSOR') {
          this.cursor = 0;
          this.deliveredEvents.clear();
        }
        this.sendSubscribe();
        break;
      }

      case 'ping':
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
        break;
    }
  }

  /**
   * Validate, deduplicate, and deliver a SequencedEvent.
   */
  processEvent(rawEvt: unknown): void {
    let event: SequencedEvent;
    try {
      event = validateSequencedEvent(rawEvt);
    } catch {
      return; // Malformed event dropped
    }

    // Filter project scope
    if (event.projectId !== this.projectId) {
      return;
    }

    // Filter runId if configured
    if (this.runId && event.runId && event.runId !== this.runId) {
      return;
    }

    // Conflicting event rejection
    const existingEventId = this.deliveredEvents.get(event.sequence);
    if (existingEventId && existingEventId !== event.eventId) {
      // Conflicting payload for already seen sequence — drop & ignore
      return;
    }

    // Duplicate suppression
    if (this.deliveredEvents.has(event.sequence)) {
      return;
    }

    // Monotonically advance cursor
    if (event.sequence > this.cursor) {
      this.cursor = event.sequence;
    }

    // Record delivery
    this.deliveredEvents.set(event.sequence, event.eventId);

    // Notify listeners
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // ignore subscriber exceptions
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState('failed');
      return;
    }

    this.setState('reconnecting');
    const delay = Math.min(
      this.baseBackoffMs * Math.pow(2, this.reconnectAttempts),
      this.maxBackoffMs,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.initiateConnection();
    }, delay);
  }

  /**
   * Disconnect cleanly and stop reconnect attempts.
   */
  disconnect(): void {
    this.isExplicitDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }
}
