/**
 * MAOS REST API Middleware
 *
 * Implements:
 *   - Loopback-only interface binding and caller verification (403 Forbidden)
 *   - Correlation ID generation and propagation (X-Correlation-ID)
 *   - Project-root scope and identifier verification (400 Bad Request)
 *   - Body size limits and streaming enforcement (413 Payload Too Large)
 *   - Idempotency-Key caching and conflict detection (409 Conflict)
 *   - Standard JSON response and error envelopes
 */

import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ApiErrorEnvelope } from './types';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import { SECURITY_HEADERS, CONTENT_SECURITY_POLICY, applySecurityHeaders } from './security-headers';
import { redactSensitive } from '../core/redaction';

export { SECURITY_HEADERS, CONTENT_SECURITY_POLICY, applySecurityHeaders };

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB

export const LOOPBACK_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

interface IdempotencyRecord {
  bodyHash: string;
  statusCode: number;
  responsePayload: unknown;
  timestamp: number;
}

// In-memory LRU-like cache for idempotency keys (TTL: 10 minutes, max 500 entries)
const idempotencyCache = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = 500;

function cleanIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, record] of idempotencyCache.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}

/**
 * Extract or generate a correlation ID for this request.
 */
export function getCorrelationId(req: http.IncomingMessage): string {
  const headerVal = req.headers['x-correlation-id'] || req.headers['x-request-id'];
  if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
    const trimmed = headerVal.trim();
    const lower = trimmed.toLowerCase();
    // Sanitize: reject/replace credentials, tokens, or overly long correlation IDs
    if (
      lower.startsWith('bearer ') ||
      lower.includes('token') ||
      lower.includes('auth') ||
      lower.includes('secret') ||
      lower.includes('key-') ||
      lower.includes('sk-') ||
      trimmed.length > 128
    ) {
      return `corr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }
    return trimmed;
  }
  return `corr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Enforce loopback-only caller interface. Rejects non-loopback with 403.
 */
export function checkLoopback(req: http.IncomingMessage, res: http.ServerResponse, correlationId: string): boolean {
  const remoteAddress = req.socket.remoteAddress || '';
  if (remoteAddress && !LOOPBACK_IPS.has(remoteAddress)) {
    sendError(
      res,
      403,
      'FORBIDDEN_NON_LOOPBACK',
      `Access is strictly restricted to local loopback. Remote address '${remoteAddress}' is forbidden.`,
      correlationId,
    );
    return false;
  }
  return true;
}

/**
 * Enforce project-root scoping. If X-Project-Root is provided, it must match the canonical root.
 * If X-Project-ID is provided and expectedProjectId is known, it must match.
 */
export function checkProjectScope(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectRoot: string,
  correlationId: string,
  expectedProjectId?: string,
): boolean {
  const headerProjectRoot = req.headers['x-project-root'];
  if (typeof headerProjectRoot === 'string' && headerProjectRoot.trim().length > 0) {
    const canonicalExpected = path.resolve(projectRoot).toLowerCase();
    const canonicalProvided = path.resolve(headerProjectRoot.trim()).toLowerCase();
    if (canonicalExpected !== canonicalProvided) {
      sendError(
        res,
        400,
        'PROJECT_SCOPE_MISMATCH',
        `Header X-Project-Root ('${headerProjectRoot}') does not match server project root ('${projectRoot}').`,
        correlationId,
      );
      return false;
    }
  }

  const headerProjectId = req.headers['x-project-id'];
  if (typeof headerProjectId === 'string' && headerProjectId.trim().length > 0 && expectedProjectId) {
    if (headerProjectId.trim().toLowerCase() !== expectedProjectId.trim().toLowerCase()) {
      sendError(
        res,
        400,
        'PROJECT_SCOPE_MISMATCH',
        `Header X-Project-ID ('${headerProjectId}') does not match expected project ID ('${expectedProjectId}').`,
        correlationId,
      );
      return false;
    }
  }

  return true;
}

/**
 * Read and parse JSON request body with strict size limit.
 */
export async function readJsonBody<T = any>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlationId: string,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<{ parsed: T | null; raw: string } | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      sendError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `Request payload exceeded limit of ${maxBytes} bytes.`,
        correlationId,
      );
      return null;
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) {
    return { parsed: null, raw: '' };
  }

  try {
    const parsed = JSON.parse(raw) as T;
    return { parsed, raw };
  } catch (err: any) {
    sendError(
      res,
      400,
      'MALFORMED_JSON',
      `Request body could not be parsed as JSON: ${err.message}`,
      correlationId,
    );
    return null;
  }
}

/**
 * Check if the request has an Idempotency-Key and handle replay / conflict.
 */
export function checkIdempotency(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
  correlationId: string,
  durableStore?: DurableIdempotencyStore,
  operation?: string,
  projectId?: string,
): { isReplay: boolean; idempotencyKey?: string; bodyHash?: string } {
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return { isReplay: false };
  }

  const key = idempotencyKey.trim();
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.startsWith('bearer ') ||
    lowerKey.includes('token') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('auth') ||
    key.length > 256
  ) {
    sendError(
      res,
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must not contain credentials, tokens, or excessive payload data.',
      correlationId,
    );
    return { isReplay: true };
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  if (durableStore) {
    const authHeader = req.headers['authorization'];
    const authContext = typeof authHeader === 'string' ? authHeader : undefined;
    const claim = durableStore.claim({
      key,
      requestHash: bodyHash,
      operation: operation || 'mutation',
      projectId: projectId || 'default',
      authContext,
    });

    if (claim.outcome === 'conflict') {
      sendError(res, 409, 'IDEMPOTENCY_CONFLICT', claim.message, correlationId);
      return { isReplay: true, idempotencyKey: key, bodyHash };
    }

    if (claim.outcome === 'auth_mismatch') {
      sendError(res, 403, 'AUTHORIZATION_MISMATCH', claim.message, correlationId);
      return { isReplay: true, idempotencyKey: key, bodyHash };
    }

    if (claim.outcome === 'in_progress') {
      sendError(res, 409, 'CONCURRENT_MUTATION', claim.message, correlationId);
      return { isReplay: true, idempotencyKey: key, bodyHash };
    }

    if (claim.outcome === 'replay') {
      sendJson(res, claim.record.responseStatus || 200, claim.record.responsePayload, correlationId, {
        'Idempotent-Replay': 'true',
      });
      return { isReplay: true, idempotencyKey: key, bodyHash };
    }

    return { isReplay: false, idempotencyKey: key, bodyHash };
  }

  cleanIdempotencyCache();
  const existing = idempotencyCache.get(key);

  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      sendError(
        res,
        409,
        'IDEMPOTENCY_CONFLICT',
        `Idempotency-Key '${key}' was previously executed with a different request payload.`,
        correlationId,
      );
      return { isReplay: true, idempotencyKey: key, bodyHash };
    }

    // Replay cached response
    sendJson(res, existing.statusCode, existing.responsePayload, correlationId, {
      'Idempotent-Replay': 'true',
    });
    return { isReplay: true, idempotencyKey: key, bodyHash };
  }

  return { isReplay: false, idempotencyKey: key, bodyHash };
}

/**
 * Record a response in the idempotency cache and durable store.
 */
export function recordIdempotency(
  key: string,
  bodyHash: string,
  statusCode: number,
  responsePayload: unknown,
  durableStore?: DurableIdempotencyStore,
): void {
  if (durableStore) {
    durableStore.complete(key, statusCode, responsePayload);
  }

  if (idempotencyCache.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const oldestKey = idempotencyCache.keys().next().value;
    if (oldestKey) idempotencyCache.delete(oldestKey);
  }
  idempotencyCache.set(key, {
    bodyHash,
    statusCode,
    responsePayload,
    timestamp: Date.now(),
  });
}

/**
 * Send standard JSON response with correlation headers.
 */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  correlationId: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Correlation-ID': correlationId,
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

/**
 * Send standard error envelope with correlation ID and automatic credential redaction.
 */
export function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
): void {
  const sanitizedMessage = typeof message === 'string' ? redactSensitive(message).sanitized : message;
  const sanitizedDetails = details !== undefined ? redactSensitive(details).sanitized : undefined;
  const envelope: ApiErrorEnvelope = {
    error: {
      code,
      message: sanitizedMessage,
      details: sanitizedDetails,
      correlationId,
    },
  };
  sendJson(res, status, envelope, correlationId);
}

/**
 * Origin validation & CORS enforcement.
 * Enforces local loopback SPA Origin, rejects external or malformed origins.
 * Injects non-wildcard CORS headers echoing the exact allowed origin.
 */
export function checkOrigin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlationId: string,
  allowedOrigins?: Set<string>,
  requireOriginOnMutation = false,
): boolean {
  const origin = req.headers['origin'];

  // If no Origin header:
  if (!origin || typeof origin !== 'string') {
    // Check if request is a browser fetch mutation when origin is required
    if (requireOriginOnMutation) {
      const fetchMode = req.headers['sec-fetch-mode'];
      const method = req.method?.toUpperCase() || 'GET';
      if (fetchMode && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        sendError(
          res,
          403,
          'FORBIDDEN_ORIGIN',
          'Browser mutation requests require a valid Origin header.',
          correlationId,
        );
        return false;
      }
    }
    // Allow CLI or direct loopback server-to-server calls without Origin header
    return true;
  }

  const trimmedOrigin = origin.trim();

  // Reject 'null' (sandboxed iframe / local file)
  if (trimmedOrigin === 'null') {
    sendError(
      res,
      403,
      'FORBIDDEN_ORIGIN',
      "Origin 'null' is not allowed.",
      correlationId,
    );
    return false;
  }

  // Reject file:// scheme
  if (trimmedOrigin.startsWith('file:')) {
    sendError(
      res,
      403,
      'FORBIDDEN_ORIGIN',
      "Origin 'file://' is not allowed.",
      correlationId,
    );
    return false;
  }

  try {
    const url = new URL(trimmedOrigin);
    const hostname = url.hostname.toLowerCase();
    const isLoopbackHost =
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost');

    if (!isLoopbackHost) {
      sendError(
        res,
        403,
        'FORBIDDEN_ORIGIN',
        `Origin '${trimmedOrigin}' is not an authorized loopback origin.`,
        correlationId,
      );
      return false;
    }

    if (allowedOrigins && allowedOrigins.size > 0 && !allowedOrigins.has(trimmedOrigin)) {
      sendError(
        res,
        403,
        'FORBIDDEN_ORIGIN',
        `Origin '${trimmedOrigin}' is not in the registered allowed origins.`,
        correlationId,
      );
      return false;
    }

    // Set strict CORS response headers echoing exact origin
    res.setHeader('Access-Control-Allow-Origin', trimmedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Project-Root, X-Correlation-ID, Idempotency-Key, Sec-WebSocket-Protocol',
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    applySecurityHeaders(res);

    return true;
  } catch {
    sendError(
      res,
      403,
      'FORBIDDEN_ORIGIN',
      `Malformed Origin header '${trimmedOrigin}'.`,
      correlationId,
    );
    return false;
  }
}

/**
 * Enforce Bearer token session authentication.
 */
export function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlationId: string,
  sessionManager?: import('../service/project-service/session').SessionManager,
  instanceIdentity?: import('../service/project-service/instance-identity').ServiceInstanceIdentity,
): { authenticated: boolean; session?: import('../service/project-service/session').SessionInfo } {
  if (!sessionManager) {
    // If no sessionManager provided (auth not enabled), allow request
    return { authenticated: true };
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    sendError(
      res,
      401,
      'AUTH_REQUIRED',
      'Authorization header with Bearer session token is required.',
      correlationId,
    );
    return { authenticated: false };
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    sendError(
      res,
      401,
      'MALFORMED_TOKEN',
      'Authorization header format must be: Bearer <session-token>.',
      correlationId,
    );
    return { authenticated: false };
  }

  const token = parts[1];
  const verifyResult = sessionManager.verifyToken(token, {
    projectRootHash: instanceIdentity?.projectRootHash,
    serviceInstanceId: instanceIdentity?.serviceInstanceId,
  });

  if (!verifyResult.valid) {
    const status =
      verifyResult.code === 'PROJECT_SCOPE_MISMATCH' || verifyResult.code === 'INSTANCE_MISMATCH'
        ? 403
        : 401;
    sendError(
      res,
      status,
      verifyResult.code || 'INVALID_TOKEN',
      verifyResult.reason || 'Session authentication failed.',
      correlationId,
    );
    return { authenticated: false };
  }

  return { authenticated: true, session: verifyResult.session };
}

