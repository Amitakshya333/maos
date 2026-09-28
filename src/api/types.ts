/**
 * MAOS REST API Types & Standard Envelopes
 *
 * Defines the canonical API envelope structures, standard error formats,
 * and request/response shapes for /api/v1.
 */

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly correlationId: string;
  };
}

export interface ApiSuccessEnvelope<T = unknown> {
  readonly data: T;
  readonly meta?: {
    readonly correlationId: string;
    readonly timestamp: string;
    readonly totalCount?: number;
  };
}

export interface ServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly projectRoot?: string;
  readonly maxBodyBytes?: number;
  readonly authEnabled?: boolean;
  readonly allowedOrigins?: Set<string>;
  readonly tokenTtlMs?: number;
  readonly sessionManager?: import('../service/project-service/session').SessionManager;
  readonly instanceIdentity?: import('../service/project-service/instance-identity').ServiceInstanceIdentity;
}

export interface AuthHandshakeRequest {
  readonly windowId?: string;
}

export interface AuthHandshakeResponse {
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly windowId: string;
  readonly serviceInstanceId: string;
  readonly projectRootHash: string;
  readonly servicePort: number;
  readonly expiresAt: number;
  readonly protocolVersion: string;
}

export interface AuthRevokeRequest {
  readonly sessionId?: string;
}

export interface AuthRevokeResponse {
  readonly revoked: boolean;
  readonly sessionId?: string;
}
