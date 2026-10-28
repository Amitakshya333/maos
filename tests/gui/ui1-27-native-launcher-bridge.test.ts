import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserEventClient, BrowserRestClient, GuiApiAdapter } from '../../src/gui/src/api';
import type { LauncherSessionBootstrap } from '../../src/gui/src/api';

const { buildBootstrap, createUiServer, parseArgs } = require('../../desktop/main.cjs');

const token = 'a'.repeat(64);
const bootstrap: LauncherSessionBootstrap = {
  sessionToken: token,
  sessionId: 'sess_test_01',
  windowId: 'desktop-test-window',
  serviceInstanceId: 'inst_test_01',
  projectRootHash: 'b'.repeat(64),
  servicePort: 49123,
  baseUrl: 'http://127.0.0.1:49123',
  projectRoot: path.join(os.tmpdir(), 'maos-bridge-project'),
  projectId: 'maos-industrial-demo',
  expiresAt: Date.now() + 60_000,
  protocolVersion: '1.0',
};

describe('native launcher renderer bridge', () => {
  it('builds renderer configuration from the launched service and bound session', () => {
    const host = {
      host: '127.0.0.1',
      port: bootstrap.servicePort,
      projectRoot: bootstrap.projectRoot,
      projectRootHash: bootstrap.projectRootHash,
      serviceInstanceId: bootstrap.serviceInstanceId,
      readiness: { protocolVersion: '1.0' },
      project: { config: { projectName: 'maos-industrial-demo', profile: { id: 'industrial' } } },
    };
    const session = {
      token,
      sessionId: bootstrap.sessionId,
      windowId: bootstrap.windowId,
      projectRootHash: bootstrap.projectRootHash,
      serviceInstanceId: bootstrap.serviceInstanceId,
      expiresAt: bootstrap.expiresAt,
      revoked: false,
    };

    expect(buildBootstrap(host, session)).toEqual(bootstrap);
    expect(() => buildBootstrap(host, { ...session, projectRootHash: 'c'.repeat(64) }))
      .toThrow(/SESSION_IDENTITY_MISMATCH/);
  });

  it('sets the runtime REST target and session in memory before UI use', () => {
    const client = new BrowserRestClient();
    client.initializeFromLauncher(bootstrap);

    expect(client.getBaseUrl()).toBe(bootstrap.baseUrl);
    expect(client.getProjectRoot()).toBe(bootstrap.projectRoot);
    expect(client.getSessionToken()).toBe(token);
    expect(() => client.initializeFromLauncher({ ...bootstrap, baseUrl: 'https://example.com' }))
      .toThrow(/INVALID_SESSION_BOOTSTRAP/);
    expect(() => client.initializeFromLauncher({ ...bootstrap, servicePort: 49124 }))
      .toThrow(/INVALID_SESSION_BOOTSTRAP/);
  });

  it('sets the runtime project, API port and session protocol for events', () => {
    let socketUrl = '';
    let socketProtocols: string[] = [];
    class MockWebSocket {
      readyState = 0;
      onclose: (() => void) | null = null;
      constructor(url: string, protocols: string[]) {
        socketUrl = url;
        socketProtocols = protocols;
      }
      close(): void {}
      send(): void {}
    }

    const client = new BrowserEventClient({ WebSocketClass: MockWebSocket as any });
    client.initializeFromLauncher(bootstrap);
    client.connect();
    expect(socketUrl).toBe(`ws://127.0.0.1:${bootstrap.servicePort}/api/v1/events?projectId=${bootstrap.projectId}`);
    expect(socketProtocols).toEqual(['maos-v1', `maos-auth.${token}`]);
    client.disconnect();
  });

  it('requires authenticated bootstrap before the adapter is ready', () => {
    const adapter = new GuiApiAdapter();
    adapter.initializeFromLauncher(bootstrap);
    expect(adapter.rest.getBaseUrl()).toBe(bootstrap.baseUrl);
    expect(adapter.rest.getProjectRoot()).toBe(bootstrap.projectRoot);
    expect(adapter.rest.getSessionToken()).toBe(token);
    expect(adapter.events.getSessionToken()).toBe(token);
  });

  it('serves only package GUI files on an ephemeral loopback origin with the exact API port in CSP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-desktop-ui-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>MAOS</title>');
    const ui = await createUiServer(root);
    try {
      ui.setApiPort(49123);
      const response = await fetch(`${ui.origin}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain('http://127.0.0.1:49123');
      expect(response.headers.get('content-security-policy')).toContain('ws://127.0.0.1:49123');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect((await fetch(`${ui.origin}/../secret.txt`)).status).toBe(404);
      expect((await fetch(`${ui.origin}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      await ui.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a validated explicit UI port for deterministic shell rehearsals', async () => {
    const args = parseArgs(['--project-root', os.tmpdir(), '--allow-temp', '--ui-port', '41081']);
    expect(args).toEqual({ allowTemp: true, projectRoot: os.tmpdir(), uiPort: 41081 });
    expect(() => parseArgs(['--ui-port', '0'])).toThrow(/--ui-port must be an available TCP port/);
    expect(() => parseArgs(['--ui-port', '65536'])).toThrow(/--ui-port must be an available TCP port/);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-desktop-explicit-ui-'));
    const reservation = require('node:net').createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>MAOS</title>');
    const ui = await createUiServer(root, port);
    try {
      ui.setApiPort(49123);
      expect(new URL(ui.origin).origin).toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`${ui.origin}/`)).status).toBe(200);
    } finally {
      await ui.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
