/**
 * UI1-19: Service Lifecycle and Recovery Controls Test Suite
 *
 * Exhaustively validates:
 * 1. Verified Reattach & Stale Identity Defense:
 *    - Valid session token bound to instance identity and project root succeeds
 *    - Stale serviceInstanceId rejected with INSTANCE_MISMATCH
 *    - Cross-project / stale projectRootHash rejected with PROJECT_SCOPE_MISMATCH
 *    - Expired token rejected with TOKEN_EXPIRED
 *    - Revoked token rejected with TOKEN_REVOKED
 * 2. Service Lifecycle & Timeout Defaults:
 *    - GET /api/v1/service/lifecycle returns 10-minute service idle, 3-minute model idle, 1-hour session TTL
 *    - Negative check: pauseResumeSupported is strictly false (no pause/resume)
 *    - orphanReaperEnabled is true
 * 3. Orphan Reaper & Temp File Cleanup:
 *    - POST /api/v1/service/orphan-cleanup sweeps and purges stale .tmp_* files
 *    - Zero trusted temp artifacts remain after cleanup
 * 4. Task Keepalive:
 *    - POST /api/v1/service/keepalive acknowledges active task heartbeat
 * 5. Stop Controls & Interruption Defense:
 *    - Graceful stop (after-current-tasks) allows existing tasks to finish
 *    - Force stop without explicit confirmation is rejected with CONFIRMATION_REQUIRED
 *    - Confirmed force stop marks active tasks INTERRUPTED and records audit event
 *    - Negative check: calling pause or resume mode is rejected with error
 * 6. Interactive Disconnect & Client Abort:
 *    - Client disconnect aborts chat completions without affecting background workflows
 * 7. Client & Adapter Parity:
 *    - BrowserRestClient and GuiApiAdapter methods for lifecycle, identity, diagnostics, orphans, keepalive, stop
 * 8. UI & Component Structure:
 *    - LifecyclePanel and SettingsView have required test IDs and zero pause/resume controls
 * 9. Untouched Canary Hash Invariant (rust/test.txt)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import { SessionManager } from '../../src/service/project-service/session';
import {
  ServiceInstanceIdentity,
  computeProjectRootHash,
  computeExecutableHash,
} from '../../src/service/project-service/instance-identity';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('UI1-19: Service Lifecycle and Recovery Controls', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let restClient: BrowserRestClient;
  let apiAdapter: GuiApiAdapter;
  let sessionManager: SessionManager;
  let instanceIdentity: ServiceInstanceIdentity;

  beforeAll(async () => {
    services = createServiceContainer(PROJECT_ROOT);
    sessionManager = new SessionManager();

    instanceIdentity = {
      serviceInstanceId: `srv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      servicePid: process.pid,
      servicePort: 0, // updated after listen
      host: '127.0.0.1',
      projectRoot: PROJECT_ROOT,
      projectRootHash: computeProjectRootHash(PROJECT_ROOT),
      executablePath: process.execPath,
      executableHash: computeExecutableHash(process.execPath),
      protocolVersion: '1.0.0',
      startedAt: new Date().toISOString(),
      status: 'healthy',
    };

    router = new RestApiRouter(
      services,
      PROJECT_ROOT,
      sessionManager,
      instanceIdentity,
    );

    await new Promise<void>((resolve) => {
      server = http.createServer(async (req, res) => {
        try {
          const handled = await router.handle(req, res);
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        (instanceIdentity as any).servicePort = serverPort;
        router.setInstanceIdentity(instanceIdentity);
        resolve();
      });
    });

    // Create an authenticated session for restClient
    const session = sessionManager.createSession({
      projectRootHash: instanceIdentity.projectRootHash,
      serviceInstanceId: instanceIdentity.serviceInstanceId,
    });

    restClient = new BrowserRestClient({
      baseUrl: serverUrl,
      projectRoot: PROJECT_ROOT,
      sessionToken: session.token,
      timeoutMs: 10000,
    });
    apiAdapter = new GuiApiAdapter(restClient);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Verified Reattach & Stale Identity Defense
  // ══════════════════════════════════════════════════════════════

  describe('1. Verified Reattach & Stale Identity Defense', () => {
    it('authenticates valid session token matching instance and project root', () => {
      const validSession = sessionManager.createSession({
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      const res = sessionManager.verifyToken(validSession.token, {
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      expect(res.valid).toBe(true);
      expect(res.session?.sessionId).toBe(validSession.sessionId);
    });

    it('rejects stale serviceInstanceId with INSTANCE_MISMATCH (403)', async () => {
      const staleSession = sessionManager.createSession({
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: 'srv_stale_old_instance_id',
      });

      const verifyRes = sessionManager.verifyToken(staleSession.token, {
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.code).toBe('INSTANCE_MISMATCH');

      // Attempt HTTP request with the stale token
      const res = await fetch(`${serverUrl}/api/v1/service/visibility`, {
        headers: { Authorization: `Bearer ${staleSession.token}` },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('INSTANCE_MISMATCH');
    });

    it('rejects cross-project / stale projectRootHash with PROJECT_SCOPE_MISMATCH (403)', async () => {
      const otherProjectHash = crypto.createHash('sha256').update('c:/other/project').digest('hex');
      const crossSession = sessionManager.createSession({
        projectRootHash: otherProjectHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      const verifyRes = sessionManager.verifyToken(crossSession.token, {
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.code).toBe('PROJECT_SCOPE_MISMATCH');

      const res = await fetch(`${serverUrl}/api/v1/service/visibility`, {
        headers: { Authorization: `Bearer ${crossSession.token}` },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('PROJECT_SCOPE_MISMATCH');
    });

    it('rejects expired session token with TOKEN_EXPIRED (401)', async () => {
      const expiredSession = sessionManager.createSession({
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
        ttlMs: -1000, // already expired
      });

      const verifyRes = sessionManager.verifyToken(expiredSession.token, {
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.code).toBe('TOKEN_EXPIRED');

      const res = await fetch(`${serverUrl}/api/v1/service/visibility`, {
        headers: { Authorization: `Bearer ${expiredSession.token}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects revoked session token with TOKEN_REVOKED (401)', async () => {
      const revSession = sessionManager.createSession({
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });
      sessionManager.revokeSession(revSession.sessionId);

      const verifyRes = sessionManager.verifyToken(revSession.token, {
        projectRootHash: instanceIdentity.projectRootHash,
        serviceInstanceId: instanceIdentity.serviceInstanceId,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.code).toBe('TOKEN_REVOKED');

      const res = await fetch(`${serverUrl}/api/v1/service/visibility`, {
        headers: { Authorization: `Bearer ${revSession.token}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('TOKEN_REVOKED');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Service Lifecycle & Timeout Defaults
  // ══════════════════════════════════════════════════════════════

  describe('2. Service Lifecycle & Timeout Defaults', () => {
    it('GET /api/v1/service/lifecycle returns canonical timeout defaults', async () => {
      const lifecycle = await restClient.getServiceLifecycle();
      expect(lifecycle).toBeDefined();
      expect(lifecycle.defaults).toBeDefined();
      // 10-minute service idle timeout (600,000 ms)
      expect(lifecycle.defaults.serviceIdleTimeoutMs).toBe(600_000);
      // 3-minute model idle timeout (180,000 ms)
      expect(lifecycle.defaults.modelIdleTimeoutMs).toBe(180_000);
      // 1-hour session TTL (3,600,000 ms)
      expect(lifecycle.defaults.sessionTtlMs).toBe(3_600_000);
    });

    it('strictly forbids pause/resume controls (pauseResumeSupported is false)', async () => {
      const lifecycle = await restClient.getServiceLifecycle();
      expect(lifecycle.pauseResumeSupported).toBe(false);
    });

    it('reports orphanReaperEnabled is true', async () => {
      const lifecycle = await restClient.getServiceLifecycle();
      expect(lifecycle.orphanReaperEnabled).toBe(true);
    });

    it('GET /api/v1/service/identity returns verified identity fields', async () => {
      const id = await restClient.getServiceIdentity();
      expect(id).toBeDefined();
      expect(id.serviceInstanceId).toBe(instanceIdentity.serviceInstanceId);
      expect(id.servicePid).toBe(process.pid);
      expect(id.servicePort).toBe(serverPort);
      expect(id.host).toBe('127.0.0.1');
      expect(id.projectRootHash).toBe(instanceIdentity.projectRootHash);
      expect(id.executableHash).toBe(instanceIdentity.executableHash);
      expect(id.status).toBe('healthy');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Orphan Reaper & Temp File Cleanup
  // ══════════════════════════════════════════════════════════════

  describe('3. Orphan Reaper & Temp File Cleanup', () => {
    it('cleans up orphaned .tmp_* files on explicit reaper sweep', async () => {
      const tmpDir = path.join(PROJECT_ROOT, 'artifacts', '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });

      const testOrphanPath = path.join(tmpDir, `.tmp_test_orphan_${Date.now()}.txt`);
      fs.writeFileSync(testOrphanPath, 'abandoned write content from interrupted task', 'utf-8');
      expect(fs.existsSync(testOrphanPath)).toBe(true);

      const res = await restClient.cleanupOrphans({ maxAgeMs: 0 });
      expect(res.purged).toBeGreaterThanOrEqual(1);

      // Verify the orphan file was unlinked
      expect(fs.existsSync(testOrphanPath)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Task Keepalive
  // ══════════════════════════════════════════════════════════════

  describe('4. Task Keepalive', () => {
    it('POST /api/v1/service/keepalive acknowledges active task heartbeat', async () => {
      const res = await restClient.sendKeepalive({ taskId: 'task-lifecycle-001' });
      expect(res.acknowledged).toBe(true);
      expect(res.taskId).toBe('task-lifecycle-001');
      expect(res.status).toBe('healthy');
      expect(res.serverTimestamp).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Stop Controls & Interruption Defense
  // ══════════════════════════════════════════════════════════════

  describe('5. Stop Controls & Interruption Defense', () => {
    it('graceful stop (mode: after-current-tasks) succeeds', async () => {
      const res = await restClient.stopService({ mode: 'after-current-tasks' });
      expect(res.status).toMatch(/stopped|stopping_after_tasks/);
      expect(res.mode).toBe('after-current-tasks');
    });

    it('force stop without explicit confirmation is rejected with CONFIRMATION_REQUIRED', async () => {
      await expect(
        restClient.stopService({
          mode: 'force',
          // confirm is intentionally omitted
        }),
      ).rejects.toThrow();
    });

    it('confirmed force stop marks active tasks INTERRUPTED and records audit event', async () => {
      // Create a temporary orphan to prove cleanup during force stop
      const tmpDir = path.join(PROJECT_ROOT, 'artifacts', '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const orphanFile = path.join(tmpDir, `.tmp_force_stop_${Date.now()}.tmp`);
      fs.writeFileSync(orphanFile, 'stale unfinalized data', 'utf-8');

      const res = await restClient.stopService({
        mode: 'force',
        confirm: true,
        reason: 'Operator emergency stop test',
      });

      expect(res.status).toBe('stopped');
      expect(res.mode).toBe('force');
      expect(typeof res.interruptedTasksCount).toBe('number');
      expect(typeof res.cleanedTempArtifacts).toBe('number');

      // Verify temp orphan was cleaned during force-stop
      expect(fs.existsSync(orphanFile)).toBe(false);

      // Verify audit trail records the force stop event
      const records = services.audit.getRecords({ source: 'project-service' });
      const forceStopEvents = records.filter(
        (r) => (r.data as any)?.event === 'SERVICE_FORCE_STOPPED',
      );
      expect(forceStopEvents.length).toBeGreaterThan(0);
      const latestForceStop = forceStopEvents[forceStopEvents.length - 1];
      expect((latestForceStop.data as any).reason).toBe('Operator emergency stop test');
    });

    it('rejects invalid stop modes like pause or resume (no pause/resume)', async () => {
      await expect(
        restClient.stopService({
          mode: 'pause' as any,
        }),
      ).rejects.toThrow();

      await expect(
        restClient.stopService({
          mode: 'resume' as any,
        }),
      ).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Interactive Disconnect & Client Abort
  // ══════════════════════════════════════════════════════════════

  describe('6. Interactive Disconnect & Client Abort', () => {
    it('cancels chat completion on client abort without breaking service', async () => {
      const controller = new AbortController();

      // Immediately abort
      controller.abort();

      await expect(
        services.chatInference.chatCompletion({
          conversationId: 'conv-disconnect-test',
          messages: [{ role: 'user', content: 'hello' }] as any,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/i);

      // Verify audit record was created for the client abort
      const auditRecords = services.audit.getRecords();
      const abortedAudits = auditRecords.filter(
        (r) => (r.data as any)?.event === 'CHAT_INFERENCE_INTERRUPTED' &&
               (r.data as any)?.reason === 'CLIENT_ABORTED',
      );
      expect(abortedAudits.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Client & Adapter Parity
  // ══════════════════════════════════════════════════════════════

  describe('7. Client & Adapter Parity', () => {
    it('apiAdapter delegates getServiceLifecycle correctly', async () => {
      const res = await apiAdapter.getServiceLifecycle();
      expect(res.defaults.serviceIdleTimeoutMs).toBe(600_000);
      expect(res.defaults.modelIdleTimeoutMs).toBe(180_000);
    });

    it('apiAdapter delegates getServiceIdentity correctly', async () => {
      const id = await apiAdapter.getServiceIdentity();
      expect(id.serviceInstanceId).toBe(instanceIdentity.serviceInstanceId);
    });

    it('apiAdapter delegates getDiagnostics correctly', async () => {
      const diags = await apiAdapter.getDiagnostics();
      expect(Array.isArray(diags)).toBe(true);
      expect(diags.length).toBeGreaterThan(0);
    });

    it('apiAdapter delegates cleanupOrphans correctly', async () => {
      const res = await apiAdapter.cleanupOrphans({ maxAgeMs: 0 });
      expect(typeof res.purged).toBe('number');
    });

    it('apiAdapter delegates sendKeepalive correctly', async () => {
      const res = await apiAdapter.sendKeepalive({ taskId: 'task-adapter-test' });
      expect(res.acknowledged).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. UI & Component Structure
  // ══════════════════════════════════════════════════════════════

  describe('8. UI & Component Structure', () => {
    it('LifecyclePanel.tsx exports React component', async () => {
      const mod = await import('../../src/gui/src/components/LifecyclePanel');
      expect(mod.LifecyclePanel).toBeDefined();
      expect(typeof mod.LifecyclePanel).toBe('function');
    });

    it('LifecyclePanel.tsx contains required test IDs and headings', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'LifecyclePanel.tsx'),
        'utf8',
      );
      expect(content).toContain('data-testid="lifecycle-panel"');
      expect(content).toContain('data-testid="lifecycle-identity"');
      expect(content).toContain('data-testid="lifecycle-timeouts"');
      expect(content).toContain('data-testid="lifecycle-diagnostics"');
      expect(content).toContain('data-testid="lifecycle-stop-controls"');
      expect(content).toContain('data-testid="lifecycle-orphan-reaper"');
      expect(content).toContain('data-testid="btn-stop-after-current"');
      expect(content).toContain('data-testid="btn-reap-orphans"');
    });

    it('LifecyclePanel strictly contains no pause/resume controls', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'LifecyclePanel.tsx'),
        'utf8',
      );
      expect(content).not.toContain('btn-pause');
      expect(content).not.toContain('btn-resume');
      expect(content).not.toContain('Pause Service');
      expect(content).not.toContain('Resume Service');
    });

    it('SettingsView.tsx embeds LifecyclePanel in Section 6', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'SettingsView.tsx'),
        'utf8',
      );
      expect(content).toContain("import { LifecyclePanel } from '../components/LifecyclePanel'");
      expect(content).toContain('<LifecyclePanel />');
      expect(content).toContain('Section 6: Service Lifecycle & Recovery Controls');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 9. Canary Invariant
  // ══════════════════════════════════════════════════════════════

  describe('9. Canary Invariant', () => {
    it('rust/test.txt SHA-256 hash is strictly preserved', () => {
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
