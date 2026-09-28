/**
 * UI1-03: Per-Window In-Memory Session Token Manager
 *
 * Implements cryptographically secure, short-lived, per-window session tokens
 * bound to canonical project roots and service instance identities.
 *
 * Invariants:
 *   - Tokens are stored exclusively in memory (never in localStorage, sessionStorage,
 *     disk files, URLs, crash logs, or audit payloads).
 *   - Tokens are compared in constant time using crypto.timingSafeEqual.
 *   - Tokens are bound to a specific projectRootHash and serviceInstanceId.
 *   - Revocation and expiration are verified on every request.
 */

import * as crypto from 'crypto';

export interface SessionInfo {
  readonly sessionId: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly windowId: string;
  readonly projectRootHash: string;
  readonly serviceInstanceId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  revoked: boolean;
}

export interface CreateSessionParams {
  windowId?: string;
  projectRootHash: string;
  serviceInstanceId: string;
  ttlMs?: number;
}

export interface VerifyTokenContext {
  projectRootHash?: string;
  serviceInstanceId?: string;
}

export interface VerifyTokenResult {
  valid: boolean;
  code?: string;
  reason?: string;
  session?: SessionInfo;
}

export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export class SessionManager {
  // Keyed by tokenHash for O(1) constant-time lookup
  private readonly sessionsByHash = new Map<string, SessionInfo>();
  // Index by sessionId for fast revocation
  private readonly sessionsById = new Map<string, SessionInfo>();

  /**
   * Create a new cryptographically random, per-window session token.
   */
  createSession(params: CreateSessionParams): SessionInfo {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const windowId = params.windowId || `win_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const ttlMs = params.ttlMs ?? DEFAULT_SESSION_TTL_MS;

    const session: SessionInfo = {
      sessionId,
      token: rawToken,
      tokenHash,
      windowId,
      projectRootHash: params.projectRootHash,
      serviceInstanceId: params.serviceInstanceId,
      createdAt: now,
      expiresAt: now + ttlMs,
      revoked: false,
    };

    this.sessionsByHash.set(tokenHash, session);
    this.sessionsById.set(sessionId, session);
    return session;
  }

  /**
   * Verify an incoming token with constant-time equality check,
   * expiration validation, revocation check, and project/instance binding.
   */
  verifyToken(token: string, context?: VerifyTokenContext): VerifyTokenResult {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return { valid: false, code: 'AUTH_REQUIRED', reason: 'Session token is required.' };
    }

    const trimmed = token.trim();
    // Validate token format (64 hex characters)
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      return { valid: false, code: 'MALFORMED_TOKEN', reason: 'Session token format is invalid.' };
    }

    const incomingHash = crypto.createHash('sha256').update(trimmed).digest('hex');
    const session = this.sessionsByHash.get(incomingHash);

    if (!session) {
      return { valid: false, code: 'INVALID_TOKEN', reason: 'Session token was not recognized.' };
    }

    // Constant-time token verification
    const sessionTokenBuf = Buffer.from(session.token, 'utf-8');
    const incomingTokenBuf = Buffer.from(trimmed, 'utf-8');
    if (
      sessionTokenBuf.length !== incomingTokenBuf.length ||
      !crypto.timingSafeEqual(sessionTokenBuf, incomingTokenBuf)
    ) {
      return { valid: false, code: 'INVALID_TOKEN', reason: 'Session token verification failed.' };
    }

    // Check revocation
    if (session.revoked) {
      return { valid: false, code: 'TOKEN_REVOKED', reason: 'Session token has been revoked.' };
    }

    // Check expiration
    if (Date.now() > session.expiresAt) {
      return { valid: false, code: 'TOKEN_EXPIRED', reason: 'Session token has expired.' };
    }

    // Check service instance binding
    if (context?.serviceInstanceId && session.serviceInstanceId !== context.serviceInstanceId) {
      return {
        valid: false,
        code: 'INSTANCE_MISMATCH',
        reason: 'Session token is not valid for this service instance.',
      };
    }

    // Check project root binding
    if (context?.projectRootHash && session.projectRootHash !== context.projectRootHash) {
      return {
        valid: false,
        code: 'PROJECT_SCOPE_MISMATCH',
        reason: 'Session token is not valid for this project.',
      };
    }

    return { valid: true, session };
  }

  /**
   * Revoke a specific session by sessionId.
   */
  revokeSession(sessionId: string): boolean {
    const session = this.sessionsById.get(sessionId);
    if (!session) return false;
    session.revoked = true;
    return true;
  }

  /**
   * Rotate an already authenticated session. Initial sessions must come from
   * the trusted launcher IPC channel; HTTP can only renew an existing session.
   */
  rotateSession(current: SessionInfo, windowId?: string, ttlMs?: number): SessionInfo {
    const active = this.sessionsById.get(current.sessionId);
    if (!active || active !== current || active.revoked) {
      throw new Error('SESSION_NOT_ACTIVE: Cannot rotate an inactive session.');
    }
    active.revoked = true;
    return this.createSession({
      windowId: windowId?.trim() || active.windowId,
      projectRootHash: active.projectRootHash,
      serviceInstanceId: active.serviceInstanceId,
      ttlMs,
    });
  }

  /**
   * Revoke all active sessions (e.g., on service shutdown).
   */
  revokeAll(): void {
    for (const session of this.sessionsById.values()) {
      session.revoked = true;
    }
    this.sessionsByHash.clear();
    this.sessionsById.clear();
  }

  /**
   * Remove expired sessions from memory.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [hash, session] of this.sessionsByHash.entries()) {
      if (now > session.expiresAt || session.revoked) {
        this.sessionsByHash.delete(hash);
        this.sessionsById.delete(session.sessionId);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Get active session count.
   */
  getActiveCount(): number {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessionsById.values()) {
      if (!session.revoked && now <= session.expiresAt) {
        count++;
      }
    }
    return count;
  }
}
