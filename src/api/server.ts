/**
 * MAOS REST API Server
 *
 * Dedicated loopback HTTP server exposing the /api/v1 REST contract.
 * Guaranteed to bind strictly to loopback interfaces (127.0.0.1).
 */

import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { createServiceContainer, ServiceContainer } from '../service';
import { RestApiRouter } from './router';
import { EventBroker } from './event-broker';
import { createWebSocketAccept } from './ws-frame';
import { LOOPBACK_IPS } from './middleware';
import { SECURITY_HEADERS } from './security-headers';
import type { ServerOptions } from './types';
import type { SequencedEvent } from '../domain/schemas';
import { SessionManager } from '../service/project-service/session';
import { ServiceInstanceIdentity, clearServiceIdentity } from '../service/project-service/instance-identity';

export class RestApiServer {
  private server: http.Server | null = null;
  private readonly router: RestApiRouter;
  private readonly services: ServiceContainer;
  private readonly eventBroker: EventBroker;
  private readonly sessionManager?: SessionManager;
  private instanceIdentity?: ServiceInstanceIdentity;
  private readonly allowedOrigins?: Set<string>;

  constructor(
    private readonly projectRoot: string,
    private readonly options: ServerOptions = {},
  ) {
    this.services = createServiceContainer(this.projectRoot);

    if (this.options.authEnabled || this.options.sessionManager) {
      this.sessionManager = this.options.sessionManager ?? new SessionManager();
    }
    this.instanceIdentity = this.options.instanceIdentity;
    this.allowedOrigins = this.options.allowedOrigins;

    this.router = new RestApiRouter(
      this.services,
      this.projectRoot,
      this.sessionManager,
      this.instanceIdentity,
      this.allowedOrigins,
    );
    this.eventBroker = new EventBroker(this.services, this.projectRoot);

    // Automatically broadcast all persisted sequenced events to matching subscribers
    this.services.event.onEvent((evt: SequencedEvent) => {
      this.eventBroker.broadcast(evt);
    });
  }

  /**
   * Update or set active service instance identity.
   */
  setInstanceIdentity(identity: ServiceInstanceIdentity): void {
    this.instanceIdentity = identity;
    this.router.setInstanceIdentity(identity);
  }

  /**
   * Get active session manager if auth is enabled.
   */
  getSessionManager(): SessionManager | undefined {
    return this.sessionManager;
  }

  /**
   * Get active service instance identity if recorded.
   */
  getInstanceIdentity(): ServiceInstanceIdentity | undefined {
    return this.instanceIdentity;
  }

  /**
   * Get the underlying ServiceContainer.
   */
  getServices(): ServiceContainer {
    return this.services;
  }

  /**
   * Get the request router.
   */
  getRouter(): RestApiRouter {
    return this.router;
  }

  /**
   * Get the active event broker.
   */
  getEventBroker(): EventBroker {
    return this.eventBroker;
  }

  /**
   * Manually broadcast a SequencedEvent to subscribers.
   */
  broadcastEvent(event: SequencedEvent): void {
    this.eventBroker.broadcast(event);
  }

  /**
   * Start listening on loopback interface.
   */
  async start(port = 0): Promise<number> {
    if (this.server) {
      const addr = this.server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    }

    const bindHost = this.options.host || '127.0.0.1';
    // Reject non-loopback bind hosts
    if (bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost') {
      throw new Error(`FORBIDDEN_BIND_HOST: Cannot bind to non-loopback host '${bindHost}'.`);
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const handled = await this.router.handle(req, res);
        if (!handled) {
          res.writeHead(404, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
        }
      });

      // Handle RFC 6455 WebSocket Upgrade on /api/v1/events
      srv.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        const remoteAddress = req.socket?.remoteAddress || '';
        if (remoteAddress && !LOOPBACK_IPS.has(remoteAddress)) {
          socket.write(
            'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\nForbidden: Non-loopback access denied.\r\n',
          );
          socket.destroy();
          return;
        }

        const parsedUrl = new URL(req.url || '', 'http://127.0.0.1');

        // Tokens in URLs or query strings are strictly forbidden
        const FORBIDDEN_TOKEN_PARAMS = new Set([
          'token',
          'sessiontoken',
          'authtoken',
          'bearer',
          'session',
          'auth',
          'access_token',
          'api_key',
          'apikey',
          'secret',
          'password',
        ]);
        let hasForbiddenWsToken = false;
        for (const key of parsedUrl.searchParams.keys()) {
          if (FORBIDDEN_TOKEN_PARAMS.has(key.toLowerCase())) {
            hasForbiddenWsToken = true;
            break;
          }
        }
        if (
          !hasForbiddenWsToken &&
          ((req.url || '').toLowerCase().includes('token=') || (req.url || '').toLowerCase().includes('bearer='))
        ) {
          hasForbiddenWsToken = true;
        }

        if (hasForbiddenWsToken) {
          socket.write(
            'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\nBad Request: Session tokens in URLs are strictly forbidden.\r\n',
          );
          socket.destroy();
          return;
        }

        // Strict Origin check for WebSocket upgrades
        const originHeader = req.headers['origin'];
        if (typeof originHeader === 'string' && originHeader.trim()) {
          const trimmedOrigin = originHeader.trim();
          if (trimmedOrigin === 'null' || trimmedOrigin.startsWith('file:')) {
            socket.write(
              'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Origin is not permitted.\r\n',
            );
            socket.destroy();
            return;
          }

          try {
            const originUrl = new URL(trimmedOrigin);
            const hostname = originUrl.hostname.toLowerCase();
            const isLoopback =
              hostname === '127.0.0.1' ||
              hostname === 'localhost' ||
              hostname === '::1' ||
              hostname === '[::1]' ||
              hostname.endsWith('.localhost');

            if (!isLoopback) {
              socket.write(
                'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Non-loopback origin denied.\r\n',
              );
              socket.destroy();
              return;
            }

            if (this.allowedOrigins && this.allowedOrigins.size > 0 && !this.allowedOrigins.has(trimmedOrigin)) {
              socket.write(
                'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Origin not in allowed list.\r\n',
              );
              socket.destroy();
              return;
            }
          } catch {
            socket.write(
              'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Malformed origin.\r\n',
            );
            socket.destroy();
            return;
          }
        }

        // Scope check
        const headerProjectRoot = req.headers['x-project-root'];
        if (typeof headerProjectRoot === 'string' && headerProjectRoot.trim().length > 0) {
          const canonicalExpected = path.resolve(this.projectRoot).toLowerCase();
          const canonicalProvided = path.resolve(headerProjectRoot.trim()).toLowerCase();
          if (canonicalExpected !== canonicalProvided) {
            socket.write(
              'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Request: Cross-project access denied.\r\n',
            );
            socket.destroy();
            return;
          }
        }

        if (parsedUrl.pathname !== '/api/v1/events') {
          socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNot Found\r\n');
          socket.destroy();
          return;
        }

        // Authenticate WebSocket connection if sessionManager is active
        let negotiatedProtocol: string | null = null;
        if (this.sessionManager) {
          let token: string | null = null;

          // 1. Check Authorization header
          const authHeader = req.headers['authorization'];
          if (typeof authHeader === 'string' && authHeader.trim().toLowerCase().startsWith('bearer ')) {
            token = authHeader.trim().substring(7).trim();
          }

          // 2. Check Sec-WebSocket-Protocol (browser standard way to pass auth token on WS upgrade)
          const wsProtocolHeader = req.headers['sec-websocket-protocol'];
          if (!token && typeof wsProtocolHeader === 'string') {
            const protocols = wsProtocolHeader.split(',').map((p) => p.trim());
            for (const p of protocols) {
              if (p.startsWith('maos-auth.')) {
                token = p.substring('maos-auth.'.length).trim();
                negotiatedProtocol = 'maos-v1';
                break;
              }
              if (p.startsWith('bearer.')) {
                token = p.substring('bearer.'.length).trim();
                negotiatedProtocol = 'maos-v1';
                break;
              }
            }
          }

          if (!token) {
            socket.write(
              'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized: Session token required.\r\n',
            );
            socket.destroy();
            return;
          }

          const verifyResult = this.sessionManager.verifyToken(token, {
            projectRootHash: this.instanceIdentity?.projectRootHash,
            serviceInstanceId: this.instanceIdentity?.serviceInstanceId,
          });

          if (!verifyResult.valid) {
            const status =
              verifyResult.code === 'PROJECT_SCOPE_MISMATCH' || verifyResult.code === 'INSTANCE_MISMATCH'
                ? '403 Forbidden'
                : '401 Unauthorized';
            socket.write(
              `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${verifyResult.reason || 'Authentication failed.'}\r\n`,
            );
            socket.destroy();
            return;
          }
        }

        const wsKey = req.headers['sec-websocket-key'];
        if (!wsKey || typeof wsKey !== 'string') {
          socket.write(
            'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nMissing Sec-WebSocket-Key\r\n',
          );
          socket.destroy();
          return;
        }

        const acceptKey = createWebSocketAccept(wsKey);
        const responseHeaders = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey}`,
        ];

        // Redact any auth subprotocol and echo safe protocol if requested
        if (negotiatedProtocol) {
          responseHeaders.push(`Sec-WebSocket-Protocol: ${negotiatedProtocol}`);
        } else if (req.headers['sec-websocket-protocol']) {
          const clientProtocols = String(req.headers['sec-websocket-protocol'])
            .split(',')
            .map((p) => p.trim());
          if (clientProtocols.includes('maos-v1')) {
            responseHeaders.push('Sec-WebSocket-Protocol: maos-v1');
          }
        }

        responseHeaders.push('\r\n');
        socket.write(responseHeaders.join('\r\n'));

        if (head && head.length > 0) {
          socket.unshift(head);
        }

        const projectId = parsedUrl.searchParams.get('projectId') || undefined;
        const runId = parsedUrl.searchParams.get('runId') || undefined;
        const cursorStr = parsedUrl.searchParams.get('cursor');
        const cursor = cursorStr !== null ? parseInt(cursorStr, 10) : undefined;

        this.eventBroker.handleConnection(socket, { projectId, runId, cursor });
      });

      srv.on('error', reject);

      srv.listen(port, bindHost, () => {
        this.server = srv;
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve(actualPort);
      });
    });
  }

  /**
   * Stop the server gracefully.
   */
  async stop(): Promise<void> {
    this.eventBroker.stop();
    if (this.sessionManager) {
      this.sessionManager.revokeAll();
    }
    clearServiceIdentity(this.projectRoot);
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Check if server is currently listening.
   */
  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }
}

/**
 * Factory to create a REST API server instance.
 */
export function createRestApiServer(projectRoot: string, options?: ServerOptions): RestApiServer {
  return new RestApiServer(projectRoot, options);
}
