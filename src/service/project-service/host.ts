/**
 * UI1-03: Authenticated Project Service Host
 *
 * Provides a secure, ephemeral loopback-only service host for the local MAOS project.
 * Enforces:
 *   - Ephemeral loopback port binding (127.0.0.1 or ::1, port 0 default)
 *   - Rejection of 0.0.0.0, LAN addresses, public addresses, and wildcard binding
 *   - Immutable ServiceInstanceIdentity generation and file recording (.maos/status/service-identity.json)
 *   - In-memory per-window session token management and constant-time verification
 *   - Zero token leakage to disk, URLs, logs, or external clients
 *   - Clean shutdown with token revocation and identity file cleanup
 *   - Instance renewal on restart (invalidating previous tokens)
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { RestApiServer } from '../../api/server';
import { SessionManager, SessionInfo } from './session';
import {
  ServiceInstanceIdentity,
  computeProjectRootHash,
  computeExecutableHash,
  recordServiceIdentity,
  clearServiceIdentity,
  readServiceIdentity,
} from './instance-identity';

export interface ProjectServiceHostOptions {
  /**
   * Host interface to bind to. Strictly restricted to loopback (127.0.0.1, ::1, localhost).
   * Default: '127.0.0.1'.
   */
  readonly host?: string;

  /**
   * Port to bind to. Default: 0 (ephemeral port chosen by OS).
   */
  readonly port?: number;

  /**
   * Set of allowed loopback Origin header values.
   */
  readonly allowedOrigins?: Set<string> | string[];

  /**
   * Session token time-to-live in milliseconds. Default: 1 hour (3,600,000 ms).
   */
  readonly tokenTtlMs?: number;

  /**
   * Path to the executable running this service. Default: process.execPath.
   */
  readonly executablePath?: string;

  /**
   * SHA-256 hash of the running executable. Computed automatically if omitted.
   */
  readonly executableHash?: string;

  /**
   * Service protocol version. Default: '1.0'.
   */
  readonly protocolVersion?: string;
}

export class ProjectServiceHost {
  private readonly projectRoot: string;
  private readonly options: ProjectServiceHostOptions;
  private readonly sessionManager: SessionManager;
  private server: RestApiServer | null = null;
  private instanceIdentity: ServiceInstanceIdentity | null = null;
  private actualPort: number | null = null;
  private started = false;

  constructor(projectRoot: string, options: ProjectServiceHostOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.options = options;
    this.sessionManager = new SessionManager();
  }

  /**
   * Start the authenticated project service host on loopback interface.
   * By default binds to an ephemeral port (port 0).
   */
  async start(port?: number): Promise<{ port: number; identity: ServiceInstanceIdentity }> {
    if (this.started && this.server && this.actualPort && this.instanceIdentity) {
      return { port: this.actualPort, identity: this.instanceIdentity };
    }

    const host = this.options.host || '127.0.0.1';

    // Strictly enforce loopback binding; fail closed on non-loopback
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      throw new Error(
        `FORBIDDEN_BIND_HOST: Host '${host}' is forbidden. Project service must strictly bind to loopback (127.0.0.1 or ::1).`,
      );
    }

    const requestedPort = port ?? this.options.port ?? 0;
    const projectRootHash = computeProjectRootHash(this.projectRoot);
    const executablePath = this.options.executablePath || process.execPath;
    const executableHash = this.options.executableHash || computeExecutableHash(executablePath);
    const serviceInstanceId = `inst_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const protocolVersion = this.options.protocolVersion || '1.0';

    const allowedOriginsSet = this.options.allowedOrigins
      ? this.options.allowedOrigins instanceof Set
        ? this.options.allowedOrigins
        : new Set(this.options.allowedOrigins)
      : undefined;

    // Create REST API server with session authentication enabled
    this.server = new RestApiServer(this.projectRoot, {
      host,
      port: requestedPort,
      authEnabled: true,
      sessionManager: this.sessionManager,
      allowedOrigins: allowedOriginsSet,
    });

    // Start server and obtain actual bound port
    const actualPort = await this.server.start(requestedPort);
    this.actualPort = actualPort;

    // Construct immutable service identity
    this.instanceIdentity = {
      serviceInstanceId,
      servicePid: process.pid,
      servicePort: actualPort,
      host,
      projectRoot: this.projectRoot,
      projectRootHash,
      executablePath,
      executableHash,
      protocolVersion,
      startedAt: new Date().toISOString(),
      status: 'healthy',
    };

    // Propagate identity to server & router
    this.server.setInstanceIdentity(this.instanceIdentity);

    // Durably record identity to .maos/status/service-identity.json (guaranteed zero tokens)
    recordServiceIdentity(this.projectRoot, this.instanceIdentity);
    this.started = true;

    return { port: actualPort, identity: this.instanceIdentity };
  }

  /**
   * Stop the service host, revoking all active sessions and clearing identity.
   */
  async stop(): Promise<void> {
    // 1. Revoke all active sessions in memory immediately
    this.sessionManager.revokeAll();

    // 2. Stop server
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    // 3. Clear recorded identity file
    clearServiceIdentity(this.projectRoot);

    if (this.instanceIdentity) {
      this.instanceIdentity = {
        ...this.instanceIdentity,
        status: 'stopped',
      };
    }

    this.started = false;
    this.actualPort = null;
  }

  /**
   * Restart the service host. Generates a fresh serviceInstanceId,
   * completely invalidating all previous session tokens.
   */
  async restart(port?: number): Promise<{ port: number; identity: ServiceInstanceIdentity }> {
    await this.stop();
    return this.start(port);
  }

  /**
   * Create a new per-window session token bound to this service instance.
   */
  createSession(windowId?: string): SessionInfo {
    if (!this.instanceIdentity) {
      throw new Error('SERVICE_NOT_STARTED: Cannot create session before service host is started.');
    }
    return this.sessionManager.createSession({
      windowId,
      projectRootHash: this.instanceIdentity.projectRootHash,
      serviceInstanceId: this.instanceIdentity.serviceInstanceId,
      ttlMs: this.options.tokenTtlMs,
    });
  }

  /**
   * Get active service instance identity.
   */
  getIdentity(): ServiceInstanceIdentity | null {
    return this.instanceIdentity;
  }

  /**
   * Get the underlying SessionManager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the active RestApiServer instance.
   */
  getServer(): RestApiServer | null {
    return this.server;
  }

  /**
   * Get the bound port.
   */
  getPort(): number | null {
    return this.actualPort;
  }

  /**
   * Get HTTP base URL for the service host (e.g. http://127.0.0.1:49210).
   */
  getBaseUrl(): string {
    if (!this.actualPort) {
      throw new Error('SERVICE_NOT_STARTED: Port not bound.');
    }
    const host = this.instanceIdentity?.host || '127.0.0.1';
    return `http://${host}:${this.actualPort}`;
  }

  /**
   * Get WebSocket events URL for the service host (e.g. ws://127.0.0.1:49210/api/v1/events).
   */
  getWsUrl(): string {
    if (!this.actualPort) {
      throw new Error('SERVICE_NOT_STARTED: Port not bound.');
    }
    const host = this.instanceIdentity?.host || '127.0.0.1';
    return `ws://${host}:${this.actualPort}/api/v1/events`;
  }

  /**
   * Check if the service is currently running and listening.
   */
  isHealthy(): boolean {
    return this.started && this.server !== null && this.server.isListening();
  }

  /**
   * Read identity file from disk for verification.
   */
  readRecordedIdentity(): ServiceInstanceIdentity | null {
    return readServiceIdentity(this.projectRoot);
  }
}

/**
 * Factory to create a ProjectServiceHost instance.
 */
export function createProjectServiceHost(
  projectRoot: string,
  options?: ProjectServiceHostOptions,
): ProjectServiceHost {
  return new ProjectServiceHost(projectRoot, options);
}
