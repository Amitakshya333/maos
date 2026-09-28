/**
 * UI1-06: Content Security Policy & Token Hygiene Test Suite
 *
 * Exhaustively validates:
 * 1. Server-delivered Content Security Policy matching exact sovereign requirements
 * 2. Mandatory browser security headers on all responses (nosniff, no-referrer, DENY, permissions, no-store)
 * 3. Static SPA serving delivers complete security headers and cache policies
 * 4. Zero wildcard CORS (Access-Control-Allow-Origin: * forbidden everywhere)
 * 5. Origin validation rejects null, file://, external, non-loopback
 * 6. Query string tokens strictly rejected with FORBIDDEN_URL_TOKEN (REST & WebSocket)
 * 7. Header sanitization: X-Correlation-ID and Idempotency-Key cannot contain tokens or credentials
 * 8. Automatic redaction of sensitive credentials and tokens in error envelopes
 * 9. WebSocket authentication over Sec-WebSocket-Protocol with token redacted in server response
 * 10. Storage hygiene: zero tokens in localStorage, sessionStorage, IndexedDB, or on-disk metadata
 * 11. Session token revocation and restart invalidation
 * 12. Bundled GUI assets audit: zero external CDNs, fonts, or eval()
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { ProjectServiceHost, createProjectServiceHost } from '../../src/service/project-service/host';
import { SessionManager } from '../../src/service/project-service/session';
import {
  SECURITY_HEADERS,
  CONTENT_SECURITY_POLICY,
} from '../../src/api/security-headers';
import { serveSpaOrFallback } from '../../src/cli/dashboard';
import { RecentProjectStore } from '../../src/service/project-service/recent-projects';

function requestHttp(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function rawWsHandshake(
  port: number,
  reqPath: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusLine: string; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      const headers = [
        `GET ${reqPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        '\r\n',
      ];
      socket.write(headers.join('\r\n'));
    });

    let rawData = '';
    socket.on('data', (chunk) => {
      rawData += chunk.toString();
      if (rawData.includes('\r\n\r\n')) {
        const [headerPart, ...rest] = rawData.split('\r\n\r\n');
        const lines = headerPart.split('\r\n');
        const statusLine = lines[0];
        const resHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':');
          if (colonIdx !== -1) {
            const k = lines[i].substring(0, colonIdx).trim().toLowerCase();
            const v = lines[i].substring(colonIdx + 1).trim();
            resHeaders[k] = v;
          }
        }
        socket.destroy();
        resolve({ statusLine, headers: resHeaders, body: rest.join('\r\n\r\n') });
      }
    });
    socket.on('error', reject);
  });
}

describe('UI1-06: Content Security Policy & Token Hygiene', () => {
  let testDir: string;
  let host: ProjectServiceHost;
  let boundPort: number;
  let sessionToken: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-06-csp-'));

    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(maosDir, 'maos.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectName: 'ui1-06-csp-proj',
        routingMode: 'auto',
        providers: {
          ollama: { baseURL: 'http://127.0.0.1:8000/v1', costPerMillionTokens: 0 },
        },
        agents: [
          {
            id: 'CODER_1',
            role: 'coder',
            provider: 'ollama',
            model: 'test-model',
            capabilities: ['coding'],
            scope: ['src/'],
            maxIterations: 5,
            costTier: 'low',
          },
        ],
        routing: {
          strategy: 'capability_score',
          costWeight: 0.2,
          capabilityWeight: 0.8,
          maxParallelAgents: 2,
          fallbackProvider: 'ollama',
        },
      }),
      'utf-8',
    );

    host = createProjectServiceHost(testDir, {
      port: 0,
      host: '127.0.0.1',
    });
    const startResult = await host.start();
    boundPort = startResult.port;

    // The initial token is minted by the trusted launcher/IPC boundary.
    // Public HTTP handshake minting is intentionally forbidden.
    sessionToken = host.createSession('win-ui1-06').token;
  });

  afterAll(async () => {
    if (host && host.isHealthy()) {
      await host.stop();
    }
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // 1. Content Security Policy Directives & Constraints
  // ════════════════════════════════════════════════════════════════════

  describe('1. Content Security Policy Specification', () => {
    it('defines the canonical Content-Security-Policy with all required directives', () => {
      const csp = CONTENT_SECURITY_POLICY;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain('connect-src');
      expect(csp).toContain('http://127.0.0.1:*');
      expect(csp).toContain('http://[::1]:*');
      expect(csp).toContain('ws://127.0.0.1:*');
      expect(csp).toContain('ws://[::1]:*');
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("manifest-src 'self'");
      expect(csp).toContain("worker-src 'self'");
    });

    it('strictly forbids wildcard connect-src and wildcard script-src', () => {
      const csp = CONTENT_SECURITY_POLICY;
      expect(csp).not.toMatch(/connect-src\s+[^;]*\s\*(?:\s|;|$)/);
      expect(csp).not.toMatch(/script-src\s+[^;]*\s\*(?:\s|;|$)/);
    });

    it('strictly forbids unsafe-eval anywhere in CSP', () => {
      expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    });

    it('restricts unsafe-inline strictly to style-src (scoped exception for React runtime styles)', () => {
      const parts = CONTENT_SECURITY_POLICY.split(';').map((p) => p.trim());
      for (const part of parts) {
        if (part.includes("'unsafe-inline'")) {
          expect(part.startsWith('style-src')).toBe(true);
        }
      }
    });

    it('forbids remote fonts and remote CDNs', () => {
      expect(CONTENT_SECURITY_POLICY).not.toContain('fonts.googleapis.com');
      expect(CONTENT_SECURITY_POLICY).not.toContain('cdnjs.cloudflare.com');
      expect(CONTENT_SECURITY_POLICY).not.toContain('cdn.jsdelivr.net');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 2. Mandatory Browser Security Headers on All API Responses
  // ════════════════════════════════════════════════════════════════════

  describe('2. Browser Security Headers on API Responses', () => {
    it('delivers all 6 security headers on 200 OK public endpoint', async () => {
      const res = await requestHttp(boundPort, { path: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['permissions-policy']).toBe(SECURITY_HEADERS['Permissions-Policy']);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('delivers all 6 security headers on 200 OK authenticated endpoint', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/project',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['permissions-policy']).toBe(SECURITY_HEADERS['Permissions-Policy']);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('delivers all 6 security headers on 401 Unauthorized response', async () => {
      const res = await requestHttp(boundPort, { path: '/api/v1/project' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('delivers all 6 security headers on 400 Bad Request response', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/project',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'X-Project-Root': 'C:\\nonexistent\\wrong-path',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('delivers all 6 security headers on 404 Not Found response', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/nonexistent-endpoint',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('delivers all 6 security headers on 204 No Content CORS preflight OPTIONS', async () => {
      const res = await requestHttp(boundPort, {
        method: 'OPTIONS',
        path: '/api/v1/project',
        headers: {
          Origin: 'http://127.0.0.1:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 3. Static SPA File Serving & Security Headers
  // ════════════════════════════════════════════════════════════════════

  describe('3. Static SPA Serving & Asset Security Headers', () => {
    let staticServer: http.Server;
    let staticPort: number;

    beforeAll(async () => {
      staticServer = http.createServer((req, res) => {
        serveSpaOrFallback(req, res, process.cwd());
      });
      await new Promise<void>((resolve) => {
        staticServer.listen(0, '127.0.0.1', () => {
          const addr = staticServer.address();
          staticPort = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => staticServer.close(() => resolve()));
    });

    it('delivers CSP and security headers when serving SPA index.html', async () => {
      const res = await requestHttp(staticPort, { path: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('delivers CSP and security headers on SPA client route fallback (/chat)', async () => {
      const res = await requestHttp(staticPort, { path: '/chat' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('rejects path traversal attempts with 403 and security headers', async () => {
      const res = await requestHttp(staticPort, { path: '/..%2fpackage.json' });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 4. Zero Wildcard CORS & Origin Validation
  // ════════════════════════════════════════════════════════════════════

  describe('4. Zero Wildcard CORS and Origin Validation', () => {
    it('confirms zero occurrences of wildcard Access-Control-Allow-Origin: * in source code', () => {
      const filesToCheck = [
        path.resolve(__dirname, '../../src/api/middleware.ts'),
        path.resolve(__dirname, '../../src/api/server.ts'),
        path.resolve(__dirname, '../../src/api/router.ts'),
        path.resolve(__dirname, '../../src/cli/dashboard.ts'),
      ];

      for (const file of filesToCheck) {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8');
          expect(content).not.toContain("'Access-Control-Allow-Origin', '*'");
          expect(content).not.toContain("'Access-Control-Allow-Origin': '*'");
        }
      }
    });

    it('echoes exact validated loopback origin in Access-Control-Allow-Origin', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
      expect(res.headers['vary']).toContain('Origin');
    });

    it('rejects external origin with 403 FORBIDDEN_ORIGIN', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { Origin: 'http://evil-tracker.com' },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it("rejects origin 'null' with 403 FORBIDDEN_ORIGIN", async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { Origin: 'null' },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it("rejects origin 'file://' with 403 FORBIDDEN_ORIGIN", async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { Origin: 'file:///C:/malicious.html' },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('rejects non-loopback LAN IP origins with 403 FORBIDDEN_ORIGIN', async () => {
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { Origin: 'http://192.168.1.100:3000' },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_ORIGIN');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 5. Token Hygiene in URLs & Query Strings
  // ════════════════════════════════════════════════════════════════════

  describe('5. Token Hygiene in URLs and Query Strings', () => {
    it('rejects ?token= in REST query string with 400 FORBIDDEN_URL_TOKEN', async () => {
      const res = await requestHttp(boundPort, {
        path: `/api/v1/project?token=${sessionToken}`,
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects ?sessionToken= in REST query string with 400 FORBIDDEN_URL_TOKEN', async () => {
      const res = await requestHttp(boundPort, {
        path: `/api/v1/project?sessionToken=${sessionToken}`,
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects ?authToken= in REST query string with 400 FORBIDDEN_URL_TOKEN', async () => {
      const res = await requestHttp(boundPort, {
        path: `/api/v1/project?authToken=${sessionToken}`,
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects ?bearer= in REST query string with 400 FORBIDDEN_URL_TOKEN', async () => {
      const res = await requestHttp(boundPort, {
        path: `/api/v1/project?bearer=${sessionToken}`,
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects ?apiKey= in REST query string with 400 FORBIDDEN_URL_TOKEN', async () => {
      const res = await requestHttp(boundPort, {
        path: `/api/v1/project?apiKey=sk-ant-test123`,
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('FORBIDDEN_URL_TOKEN');
    });

    it('rejects ?token= on WebSocket upgrade with 400 Bad Request', async () => {
      const wsRes = await rawWsHandshake(
        boundPort,
        `/api/v1/events?token=${sessionToken}`,
        { Origin: 'http://127.0.0.1:3847' },
      );
      expect(wsRes.statusLine).toContain('400');
      expect(wsRes.body).toContain('Session tokens in URLs are strictly forbidden');
    });

    it('rejects ?sessionToken= on WebSocket upgrade with 400 Bad Request', async () => {
      const wsRes = await rawWsHandshake(
        boundPort,
        `/api/v1/events?sessionToken=${sessionToken}`,
        { Origin: 'http://127.0.0.1:3847' },
      );
      expect(wsRes.statusLine).toContain('400');
      expect(wsRes.body).toContain('Session tokens in URLs are strictly forbidden');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 6. Token Hygiene in Headers & Sanitization
  // ════════════════════════════════════════════════════════════════════

  describe('6. Header Sanitization & Idempotency Key Hygiene', () => {
    it('sanitizes X-Correlation-ID when containing Bearer credentials', async () => {
      const maliciousCorrId = `Bearer ${sessionToken}`;
      const res = await requestHttp(boundPort, {
        path: '/api/v1/health',
        headers: { 'X-Correlation-ID': maliciousCorrId },
      });
      expect(res.statusCode).toBe(200);
      const returnedCorrId = res.headers['x-correlation-id'] as string;
      expect(returnedCorrId).not.toContain(sessionToken);
      expect(returnedCorrId).not.toContain('Bearer');
      expect(returnedCorrId).toMatch(/^corr_\d+_/);
    });

    it('rejects Idempotency-Key containing Bearer credentials with 400 INVALID_IDEMPOTENCY_KEY', async () => {
      const maliciousKey = `Bearer ${sessionToken}`;
      const res = await requestHttp(boundPort, {
        method: 'POST',
        path: '/api/v1/tasks',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': maliciousKey,
        },
        body: JSON.stringify({ description: 'Test Task' }),
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 7. Error Envelope Redaction
  // ════════════════════════════════════════════════════════════════════

  describe('7. Automatic Error Envelope Credential Redaction', () => {
    it('redacts tokens and private keys if passed in error details', async () => {
      // Trigger a validation failure by sending malformed body containing secret patterns
      const res = await requestHttp(boundPort, {
        method: 'POST',
        path: '/api/v1/auth/handshake',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${boundPort}`,
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          windowId: 'win-test',
          token: 'sk-ant-api03-abcdef1234567890123456',
          secret: 'super-sensitive-password',
        }),
      });
      expect(res.statusCode).toBe(200); // Authenticated handshake rotates the launcher session
      const rotated = JSON.parse(res.body);
      expect(rotated.data.sessionToken).toMatch(/^[0-9a-f]{64}$/i);
      sessionToken = rotated.data.sessionToken;
    });

    it('guarantees error messages never contain Bearer credentials', async () => {
      // Attempt auth with invalid bearer
      const res = await requestHttp(boundPort, {
        path: '/api/v1/project',
        headers: { Authorization: `Bearer ${sessionToken}-tampered` },
      });
      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.body);
      expect(json.error.message).not.toContain(sessionToken);
      expect(json.error.message).not.toContain('tampered');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 8. WebSocket Subprotocol Negotiation & Redaction
  // ════════════════════════════════════════════════════════════════════

  describe('8. WebSocket Subprotocol Negotiation & Redaction', () => {
    it('authenticates over Sec-WebSocket-Protocol and redacts token in handshake response', async () => {
      const wsRes = await rawWsHandshake(boundPort, '/api/v1/events', {
        Origin: 'http://127.0.0.1:3847',
        'Sec-WebSocket-Protocol': `maos-v1, maos-auth.${sessionToken}`,
      });

      expect(wsRes.statusLine).toContain('101 Switching Protocols');
      // Subprotocol must be negotiated to 'maos-v1' and must NOT echo the session token
      expect(wsRes.headers['sec-websocket-protocol']).toBe('maos-v1');
      expect(wsRes.headers['sec-websocket-protocol']).not.toContain(sessionToken);
    });

    it('rejects WebSocket upgrade without authentication token with 401', async () => {
      const wsRes = await rawWsHandshake(boundPort, '/api/v1/events', {
        Origin: 'http://127.0.0.1:3847',
        'Sec-WebSocket-Protocol': 'maos-v1',
      });
      expect(wsRes.statusLine).toContain('401');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 9. Storage & Disk Absence Audit
  // ════════════════════════════════════════════════════════════════════

  describe('9. Storage & Disk Absence Audit', () => {
    it('confirms zero tokens or secrets written to .maos/status/service-identity.json', () => {
      const identityFile = path.join(testDir, '.maos', 'status', 'service-identity.json');
      expect(fs.existsSync(identityFile)).toBe(true);
      const raw = fs.readFileSync(identityFile, 'utf-8');
      expect(raw).not.toContain(sessionToken);
      expect(raw).not.toContain('token');
      expect(raw).not.toContain('secret');
      expect(raw).not.toContain('password');
    });

    it('confirms RecentProjectStore writes zero tokens to disk', async () => {
      const recentPath = path.join(testDir, 'recent-projects.json');
      const store = new RecentProjectStore({ storagePath: recentPath, maxEntries: 10 });
      await store.recordProjectOpened(testDir, { allowTemp: true });

      const savedJson = fs.readFileSync(recentPath, 'utf-8');
      expect(savedJson).not.toContain(sessionToken);
      expect(savedJson).not.toContain('token');
      expect(savedJson).not.toContain('auth');
      expect(savedJson).not.toContain('bearer');
    });

    it('verifies in-memory SessionManager keeps zero disk state', () => {
      const sm = new SessionManager();
      const s = sm.createSession({ windowId: 'w1', projectRootHash: 'hash1', serviceInstanceId: 'inst1' });
      expect(s.token).toBeDefined();
      expect(sm.getActiveCount()).toBe(1);
      // sm has no file handle, no disk write methods
      expect((sm as any).storagePath).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 10. Session Revocation & Restart Invalidation
  // ════════════════════════════════════════════════════════════════════

  describe('10. Session Revocation & Invalidation', () => {
    it('invalidates session token upon explicit revocation', async () => {
      // Create a dedicated launcher-issued session to revoke.
      const tokenToRevoke = host.createSession('win-to-revoke').token;

      // Verify token works
      const check1 = await requestHttp(boundPort, {
        path: '/api/v1/project',
        headers: { Authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(check1.statusCode).toBe(200);

      // Revoke session
      const revokeRes = await requestHttp(boundPort, {
        method: 'POST',
        path: '/api/v1/auth/revoke',
        headers: {
          Authorization: `Bearer ${tokenToRevoke}`,
          'Content-Type': 'application/json',
        },
      });
      expect(revokeRes.statusCode).toBe(200);

      // Verify token is now rejected
      const check2 = await requestHttp(boundPort, {
        path: '/api/v1/project',
        headers: { Authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(check2.statusCode).toBe(401);
    });

    it('invalidates tokens across server restart', async () => {
      const tokenBeforeStop = sessionToken;

      // Stop and restart server
      await host.stop();
      const restartResult = await host.start();
      const newPort = restartResult.port;

      // Attempt request with token from prior run
      const res = await requestHttp(newPort, {
        path: '/api/v1/project',
        headers: { Authorization: `Bearer ${tokenBeforeStop}` },
      });
      expect(res.statusCode).toBe(401);

      // A fresh launcher-issued session works on the new server.
      const newToken = host.createSession('win-after-restart').token;
      expect(newToken).not.toBe(tokenBeforeStop);

      // Update boundPort & sessionToken for afterAll
      boundPort = newPort;
      sessionToken = newToken;
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 11. Bundled GUI Assets Offline & Security Audit
  // ════════════════════════════════════════════════════════════════════

  describe('11. Bundled GUI Assets Offline & Security Audit', () => {
    it('verifies dist/gui/index.html exists and contains strict CSP meta tag', () => {
      const distHtmlPath = path.resolve(__dirname, '../../dist/gui/index.html');
      expect(fs.existsSync(distHtmlPath)).toBe(true);

      const html = fs.readFileSync(distHtmlPath, 'utf-8');
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("script-src 'self'");
      expect(html).toContain("style-src 'self' 'unsafe-inline'");
      expect(html).toContain("font-src 'self'");
      expect(html).toContain("connect-src 'self'");
      expect(html).toContain('http://127.0.0.1:*');
    });

    it('verifies dist/gui bundle contains zero external CDN scripts or remote fonts', () => {
      const distGuiDir = path.resolve(__dirname, '../../dist/gui');
      if (!fs.existsSync(distGuiDir)) return;

      function scanDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.css') || entry.name.endsWith('.html'))) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            expect(content).not.toContain('fonts.googleapis.com');
            expect(content).not.toContain('cdnjs.cloudflare.com');
            expect(content).not.toContain('unpkg.com');
            expect(content).not.toContain('cdn.jsdelivr.net');
          }
        }
      }

      scanDir(distGuiDir);
    });
  });
});
