/**
 * UI1-03: Authenticated Project Service Host Test Suite
 *
 * Exhaustively validates:
 * 1. Ephemeral loopback port binding and non-loopback host rejection (FORBIDDEN_BIND_HOST)
 * 2. Immutable ServiceInstanceIdentity generation, recording, and safe cleanup
 * 3. Identity file hygiene (ZERO tokens/secrets stored on disk)
 * 4. Handshake endpoint (POST /api/v1/auth/handshake) and 64-hex session token generation
 * 5. Bearer token session authentication enforcement on protected REST routes
 * 6. Public bypass routes (/api/v1/auth/handshake, /api/v1/openapi.json, /api/v1/health)
 * 7. Token rejection modes (missing, malformed, invalid, expired, revoked)
 * 8. Strict Origin validation (reject null, file://, external; accept loopback; non-wildcard CORS)
 * 9. URL token parameter rejection (FORBIDDEN_URL_TOKEN)
 * 10. Project scope and service instance binding (cross-project & cross-instance rejection)
 * 11. WebSocket upgrade authentication via Sec-WebSocket-Protocol (token redacted in handshake response)
 * 12. WebSocket URL token rejection
 * 13. Service restart and token invalidation
 * 14. BrowserRestClient & GuiApiAdapter handshake integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { ProjectServiceHost, createProjectServiceHost } from '../../src/service/project-service/host';
import { SessionManager } from '../../src/service/project-service/session';
import {
  readServiceIdentity,
  verifyServiceIdentity,
  computeProjectRootHash,
} from '../../src/service/project-service/instance-identity';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';

describe('UI1-03: Authenticated Project Service Host', () => {
  let testDir: string;
  let otherTestDir: string;
  let host: ProjectServiceHost;
  let boundPort: number;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-03-host-'));
    otherTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-03-other-'));

    // Set up minimal MAOS directory structure
    for (const dir of [testDir, otherTestDir]) {
      const maosDir = path.join(dir, '.maos');
      fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
      fs.writeFileSync(
        path.join(maosDir, 'maos.config.json'),
        JSON.stringify({ schemaVersion: 1, projectName: 'ui1-03-test-proj' }),
        'utf-8',
      );
    }

    // Start ProjectServiceHost with ephemeral port (port: 0)
    host = createProjectServiceHost(testDir, { port: 0 });
    const started = await host.start();
    boundPort = started.port;
    baseUrl = host.getBaseUrl();
    wsUrl = host.getWsUrl();
  });

  afterAll(async () => {
    if (host) {
      await host.stop();
    }
    for (const dir of [testDir, otherTestDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Loopback Binding & Port Security
  // ══════════════════════════════════════════════════════════════

  describe('1. Loopback Binding & Ephemeral Port', () => {
    it('binds to an ephemeral loopback port > 0', () => {
      expect(boundPort).toBeGreaterThan(0);
      expect(host.getPort()).toBe(boundPort);
      expect(baseUrl).toBe(`http://127.0.0.1:${boundPort}`);
      expect(wsUrl).toBe(`ws://127.0.0.1:${boundPort}/api/v1/events`);
      expect(host.isHealthy()).toBe(true);
    });

    it('rejects non-loopback bind hosts (0.0.0.0, LAN addresses) with FORBIDDEN_BIND_HOST', async () => {
      const badHost1 = createProjectServiceHost(testDir, { host: '0.0.0.0' });
      await expect(badHost1.start()).rejects.toThrow(/FORBIDDEN_BIND_HOST/);

      const badHost2 = createProjectServiceHost(testDir, { host: '192.168.1.100' });
      await expect(badHost2.start()).rejects.toThrow(/FORBIDDEN_BIND_HOST/);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Service Instance Identity Recording & Hygiene
  // ══════════════════════════════════════════════════════════════

  describe('2. Service Instance Identity & Hygiene', () => {
    it('records verifiable service identity to .maos/status/service-identity.json', () => {
      const recorded = readServiceIdentity(testDir);
      expect(recorded).not.toBeNull();
      expect(recorded!.servicePid).toBe(process.pid);
      expect(recorded!.servicePort).toBe(boundPort);
      expect(recorded!.host).toBe('127.0.0.1');
      expect(recorded!.status).toBe('healthy');
      expect(recorded!.protocolVersion).toBe('1.0');
      expect(recorded!.projectRootHash).toBe(computeProjectRootHash(testDir));
      expect(recorded!.serviceInstanceId).toMatch(/^inst_\d+_[0-9a-f]+$/);

      const verification = verifyServiceIdentity(testDir, {
        servicePid: process.pid,
        servicePort: boundPort,
      });
      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });

    it('guarantees identity record contains ZERO tokens, secret keys, or passwords', () => {
      const filePath = path.join(testDir, '.maos', 'status', 'service-identity.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed).not.toHaveProperty('token');
      expect(parsed).not.toHaveProperty('sessionToken');
      expect(parsed).not.toHaveProperty('secret');
      expect(parsed).not.toHaveProperty('apiKey');
      expect(parsed).not.toHaveProperty('password');
      expect(raw).not.toContain('Bearer');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Handshake & Session Token Creation
  // ══════════════════════════════════════════════════════════════

  describe('3. Authenticated Handshake Rotation', () => {
    it('does not mint a session over public HTTP and rotates a launcher-issued session', async () => {
      const publicRes = await fetch(`${baseUrl}/api/v1/auth/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ windowId: 'win_public_attempt' }),
      });
      expect(publicRes.status).toBe(401);

      const launcherSession = host.createSession('win_main_1');
      const res = await fetch(`${baseUrl}/api/v1/auth/handshake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Authorization: `Bearer ${launcherSession.token}`,
        },
        body: JSON.stringify({ windowId: 'win_main_1' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty('data');
      const data = json.data;

      expect(data.sessionToken).toMatch(/^[0-9a-f]{64}$/i);
      expect(data.sessionId).toMatch(/^sess_\d+_[0-9a-f]+$/);
      expect(data.windowId).toBe('win_main_1');
      expect(data.serviceInstanceId).toBe(host.getIdentity()!.serviceInstanceId);
      expect(data.projectRootHash).toBe(computeProjectRootHash(testDir));
      expect(data.servicePort).toBe(boundPort);
      expect(data.protocolVersion).toBe('1.0');
      expect(data.expiresAt).toBeGreaterThan(Date.now());
    });

    it('generates a unique token for each authenticated rotation', async () => {
      const first = host.createSession('win_1');
      const res1 = await fetch(`${baseUrl}/api/v1/auth/handshake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Authorization: `Bearer ${first.token}`,
        },
        body: JSON.stringify({ windowId: 'win_1' }),
      });
      const d1 = (await res1.json()).data;
      const res2 = await fetch(`${baseUrl}/api/v1/auth/handshake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Authorization: `Bearer ${d1.sessionToken}`,
        },
        body: JSON.stringify({ windowId: 'win_2' }),
      });

      const d2 = (await res2.json()).data;

      expect(d1.sessionToken).not.toBe(d2.sessionToken);
      expect(d1.sessionId).not.toBe(d2.sessionId);
      expect(d1.windowId).toBe('win_1');
      expect(d2.windowId).toBe('win_2');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Protected REST Routes & Token Verification
  // ══════════════════════════════════════════════════════════════

  describe('4. Protected REST Routes & Token Verification', () => {
    let validToken: string;

    beforeAll(async () => {
      const session = host.createSession('win_test_runner');
      validToken = session.token;
    });

    it('allows public routes (/openapi.json and /health) without authentication', async () => {
      const resHealth = await fetch(`${baseUrl}/api/v1/health`);
      expect(resHealth.status).toBe(200);
      const healthJson = await resHealth.json();
      expect(healthJson.data.status).toBe('HEALTHY');

      const resSpec = await fetch(`${baseUrl}/api/v1/openapi.json`);
      expect(resSpec.status).toBe(200);
    });

    it('rejects protected routes without Authorization header with 401 AUTH_REQUIRED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('AUTH_REQUIRED');
    });

    it('rejects non-Bearer scheme with 401 MALFORMED_TOKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Basic ${validToken}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('MALFORMED_TOKEN');
    });

    it('rejects malformed token format (not 64 hex characters) with 401 MALFORMED_TOKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: 'Bearer short-invalid-token' },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('MALFORMED_TOKEN');
    });

    it('rejects unknown 64-hex token with 401 INVALID_TOKEN', async () => {
      const fakeToken = crypto.randomBytes(32).toString('hex');
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${fakeToken}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_TOKEN');
    });

    it('accepts protected requests with valid Bearer token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          'X-Project-Root': testDir,
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.projectName).toBe('ui1-03-test-proj');
    });

    it('returns active session metadata on GET /api/v1/auth/session without leaking raw token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/session`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveProperty('sessionId');
      expect(json.data).toHaveProperty('windowId');
      expect(json.data).not.toHaveProperty('token');
      expect(json.data).not.toHaveProperty('tokenHash');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Token Revocation & Expiration
  // ══════════════════════════════════════════════════════════════

  describe('5. Token Revocation & Expiration', () => {
    it('revokes session via POST /api/v1/auth/revoke and denies subsequent calls with 401 TOKEN_REVOKED', async () => {
      const session = host.createSession('win_to_revoke');
      const token = session.token;

      // Verify it works before revocation
      const res1 = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res1.status).toBe(200);

      // Revoke session
      const revokeRes = await fetch(`${baseUrl}/api/v1/auth/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      expect(revokeRes.status).toBe(200);
      const revokeJson = await revokeRes.json();
      expect(revokeJson.data.revoked).toBe(true);

      // Verify it is rejected now
      const res2 = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res2.status).toBe(401);
      const json2 = await res2.json();
      expect(json2.error.code).toBe('TOKEN_REVOKED');
    });

    it('rejects expired session tokens with 401 TOKEN_EXPIRED', async () => {
      // Create a session that expired 1 second ago
      const expiredSession = host.getSessionManager().createSession({
        windowId: 'win_expired',
        projectRootHash: host.getIdentity()!.projectRootHash,
        serviceInstanceId: host.getIdentity()!.serviceInstanceId,
        ttlMs: -1000,
      });

      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${expiredSession.token}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('TOKEN_EXPIRED');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Project Scope & Service Instance Binding
  // ══════════════════════════════════════════════════════════════

  describe('6. Project Scope & Service Instance Binding', () => {
    it('rejects tokens minted for a different project with 403 PROJECT_SCOPE_MISMATCH', async () => {
      // Create session for other project root hash
      const otherHash = computeProjectRootHash(otherTestDir);
      const crossProjectSession = host.getSessionManager().createSession({
        windowId: 'win_other_proj',
        projectRootHash: otherHash,
        serviceInstanceId: host.getIdentity()!.serviceInstanceId,
      });

      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${crossProjectSession.token}` },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('PROJECT_SCOPE_MISMATCH');
    });

    it('rejects tokens minted for a prior service instance with 403 INSTANCE_MISMATCH', async () => {
      // Create session for older serviceInstanceId
      const staleSession = host.getSessionManager().createSession({
        windowId: 'win_stale',
        projectRootHash: host.getIdentity()!.projectRootHash,
        serviceInstanceId: 'inst_prior_instance_12345',
      });

      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${staleSession.token}` },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('INSTANCE_MISMATCH');
    });

    it('rejects mismatched X-Project-Root header with 400 PROJECT_SCOPE_MISMATCH', async () => {
      const session = host.createSession('win_scope_test');
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Project-Root': otherTestDir,
        },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('PROJECT_SCOPE_MISMATCH');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Strict Origin & CORS Validation
  // ══════════════════════════════════════════════════════════════

  describe('7. Strict Origin Validation', () => {
    let validToken: string;

    beforeAll(() => {
      validToken = host.createSession('win_origin_test').token;
    });

    it("rejects Origin: 'null' with 403 FORBIDDEN_ORIGIN", async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          Origin: 'null',
        },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it("rejects Origin: 'file://' with 403 FORBIDDEN_ORIGIN", async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          Origin: 'file:///C:/index.html',
        },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('rejects external Origin (e.g. http://malicious.com) with 403 FORBIDDEN_ORIGIN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          Origin: 'http://malicious.com',
        },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('accepts loopback Origin and sets non-wildcard CORS headers', async () => {
      const loopbackOrigin = 'http://127.0.0.1:5173';
      const res = await fetch(`${baseUrl}/api/v1/project`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          Origin: loopbackOrigin,
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(loopbackOrigin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('handles CORS preflight OPTIONS request with 204 No Content', async () => {
      const loopbackOrigin = 'http://localhost:3000';
      const res = await fetch(`${baseUrl}/api/v1/tasks`, {
        method: 'OPTIONS',
        headers: {
          Origin: loopbackOrigin,
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(loopbackOrigin);
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. URL Token Parameter Rejection
  // ══════════════════════════════════════════════════════════════

  describe('8. URL Token Parameter Rejection', () => {
    it('rejects tokens in query parameters (?token=...) with 400 FORBIDDEN_URL_TOKEN', async () => {
      const session = host.createSession('win_url_test');
      const res = await fetch(`${baseUrl}/api/v1/project?token=${session.token}`);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects tokens in ?sessionToken=... query parameters with 400 FORBIDDEN_URL_TOKEN', async () => {
      const session = host.createSession('win_url_test_2');
      const res = await fetch(`${baseUrl}/api/v1/project?sessionToken=${session.token}`);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 9. WebSocket Upgrade Authentication
  // ══════════════════════════════════════════════════════════════

  describe('9. WebSocket Upgrade Authentication', () => {
    function performWsHandshake(
      reqHeaders: Record<string, string>,
      query = '',
    ): Promise<{ statusCode: number; headers: Record<string, string>; statusMessage: string }> {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: boundPort, host: '127.0.0.1' }, () => {
          const lines = [
            `GET /api/v1/events${query} HTTP/1.1`,
            `Host: 127.0.0.1:${boundPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
          ];

          for (const [k, v] of Object.entries(reqHeaders)) {
            lines.push(`${k}: ${v}`);
          }
          lines.push('\r\n');
          socket.write(lines.join('\r\n'));
        });

        let responseData = '';
        socket.on('data', (chunk) => {
          responseData += chunk.toString('utf-8');
          if (responseData.includes('\r\n\r\n')) {
            socket.destroy();
            const headerSection = responseData.split('\r\n\r\n')[0];
            const headerLines = headerSection.split('\r\n');
            const statusLine = headerLines[0];
            const parts = statusLine.split(' ');
            const statusCode = parseInt(parts[1], 10);
            const statusMessage = parts.slice(2).join(' ');

            const parsedHeaders: Record<string, string> = {};
            for (let i = 1; i < headerLines.length; i++) {
              const colonIdx = headerLines[i].indexOf(':');
              if (colonIdx !== -1) {
                const name = headerLines[i].slice(0, colonIdx).trim().toLowerCase();
                const val = headerLines[i].slice(colonIdx + 1).trim();
                parsedHeaders[name] = val;
              }
            }
            resolve({ statusCode, headers: parsedHeaders, statusMessage });
          }
        });

        socket.on('error', reject);
      });
    }

    it('rejects WebSocket upgrade without session token with 401 Unauthorized', async () => {
      const res = await performWsHandshake({});
      expect(res.statusCode).toBe(401);
    });

    it('rejects WebSocket upgrade with URL query token (?token=...) with 400 Bad Request', async () => {
      const session = host.createSession('win_ws_url');
      const res = await performWsHandshake({}, `?token=${session.token}`);
      expect(res.statusCode).toBe(400);
    });

    it('rejects WebSocket upgrade with invalid token in Sec-WebSocket-Protocol with 401', async () => {
      const fakeToken = crypto.randomBytes(32).toString('hex');
      const res = await performWsHandshake({
        'Sec-WebSocket-Protocol': `maos-v1, maos-auth.${fakeToken}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects WebSocket upgrade with invalid external Origin with 403 Forbidden', async () => {
      const session = host.createSession('win_ws_origin');
      const res = await performWsHandshake({
        'Sec-WebSocket-Protocol': `maos-v1, maos-auth.${session.token}`,
        Origin: 'http://evil.com',
      });
      expect(res.statusCode).toBe(403);
    });

    it('accepts WebSocket upgrade with valid token in Sec-WebSocket-Protocol and redacts token', async () => {
      const session = host.createSession('win_ws_valid');
      const res = await performWsHandshake({
        'Sec-WebSocket-Protocol': `maos-v1, maos-auth.${session.token}`,
        Origin: 'http://127.0.0.1:3000',
      });

      expect(res.statusCode).toBe(101);
      expect(res.headers['upgrade']).toBe('websocket');
      // Token must be completely redacted; response must only state negotiated protocol
      expect(res.headers['sec-websocket-protocol']).toBe('maos-v1');
      expect(res.headers['sec-websocket-protocol']).not.toContain(session.token);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 10. Service Restart & Token Invalidation
  // ══════════════════════════════════════════════════════════════

  describe('10. Service Restart & Token Invalidation', () => {
    it('invalidates previous tokens and writes fresh serviceInstanceId on restart', async () => {
      const oldInstanceId = host.getIdentity()!.serviceInstanceId;
      const oldSession = host.createSession('win_before_restart');

      // Verify token works before restart
      const preCheck = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${oldSession.token}` },
      });
      expect(preCheck.status).toBe(200);

      // Restart service host
      const restarted = await host.restart();
      boundPort = restarted.port;
      baseUrl = host.getBaseUrl();
      wsUrl = host.getWsUrl();

      expect(restarted.identity.serviceInstanceId).not.toBe(oldInstanceId);

      // Previous token must now be rejected
      const postCheck = await fetch(`${baseUrl}/api/v1/project`, {
        headers: { Authorization: `Bearer ${oldSession.token}` },
      });
      expect(postCheck.status).toBe(401); // All sessions cleared on restart
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 11. BrowserRestClient & GuiApiAdapter Integration
  // ══════════════════════════════════════════════════════════════

  describe('11. BrowserRestClient & GuiApiAdapter Handshake Integration', () => {
    it('BrowserRestClient handshake() acquires token and authenticates subsequent calls', async () => {
      const launcherSession = host.createSession('win_browser_client');
      const client = new BrowserRestClient({
        baseUrl,
        projectRoot: testDir,
        sessionToken: launcherSession.token,
      });

      // The launcher IPC path supplies the initial token; HTTP only rotates it.
      const handshakeData = await client.handshake('win_browser_client');
      expect(handshakeData.sessionToken).toMatch(/^[0-9a-f]{64}$/);
      expect(client.getSessionToken()).toBe(handshakeData.sessionToken);

      // After handshake, requests succeed
      const proj = await client.getProject();
      expect(proj.projectName).toBe('ui1-03-test-proj');

      // Revoke session
      const revokeResult = await client.revokeSession();
      expect(revokeResult.revoked).toBe(true);
      expect(client.getSessionToken()).toBeUndefined();

      // Subsequent requests fail again
      await expect(client.getProject()).rejects.toThrow();
    });

    it('GuiApiAdapter handshake() synchronizes token between REST and Event clients', async () => {
      const launcherSession = host.createSession('win_adapter_1');
      const adapter = new GuiApiAdapter({
        baseUrl,
        projectRoot: testDir,
        wsUrl,
        sessionToken: launcherSession.token,
      });

      const handshakeData = await adapter.handshake('win_adapter_1');
      expect(handshakeData.sessionToken).toBeDefined();
      expect(adapter.rest.getSessionToken()).toBe(handshakeData.sessionToken);
      expect(adapter.events.getSessionToken()).toBe(handshakeData.sessionToken);

      const proj = await adapter.getProject();
      expect(proj.projectName).toBe('ui1-03-test-proj');

      const revoked = await adapter.revokeSession();
      expect(revoked).toBe(true);
      expect(adapter.rest.getSessionToken()).toBeUndefined();
      expect(adapter.events.getSessionToken()).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 12. Clean Stop & Identity File Teardown
  // ══════════════════════════════════════════════════════════════

  describe('12. Clean Shutdown & File Teardown', () => {
    it('deletes identity file and clears sessions on host.stop()', async () => {
      const identityFile = path.join(testDir, '.maos', 'status', 'service-identity.json');
      expect(fs.existsSync(identityFile)).toBe(true);

      await host.stop();
      expect(fs.existsSync(identityFile)).toBe(false);
      expect(host.getSessionManager().getActiveCount()).toBe(0);
      expect(host.isHealthy()).toBe(false);
    });
  });
});
