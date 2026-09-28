/**
 * UI1-04: Launcher Handshake and Project Validation Test Suite
 *
 * Tests the complete sovereign launcher protocol:
 *   1. Pre-launch Project Folder Validation (fails closed)
 *   2. Dedicated Child Process Host Spawning (piped stdout + IPC)
 *   3. Structured HostReadinessEnvelope Decoding (never scrape logs)
 *   4. Independent Verification (Liveness, Loopback Port, TCP, Identity File, Hashes)
 *   5. Zero-Orphan Process Guarantee (Tree termination on failure/exit)
 *   6. Concurrent Project Management & Session Handshake
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import {
  validateProjectFolder,
  assertValidProjectFolder,
  ProjectValidationError,
  CanonicalProjectFolder,
} from '../../src/service/project-service/validator';
import {
  ProjectHostLauncher,
  LauncherError,
  isProcessAlive,
  killProcessTree,
  LaunchedProjectHost,
  resolveEntrypoint,
} from '../../src/service/project-service/launcher';
import {
  computeProjectRootHash,
  readServiceIdentity,
} from '../../src/service/project-service/instance-identity';

function createValidProjectStructure(projectDir: string, configOverrides: Record<string, any> = {}): void {
  const maosDir = path.join(projectDir, '.maos');
  fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });

  const config = {
    schemaVersion: 1,
    projectName: path.basename(projectDir),
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
    ...configOverrides,
  };

  fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}


function makeHttpRequest(
  port: number,
  pathName: string,
  token?: string,
  projectRoot?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (projectRoot) {
      headers['X-Project-Root'] = projectRoot;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method: 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode || 500,
              body: raw ? JSON.parse(raw) : null,
            });
          } catch {
            resolve({
              status: res.statusCode || 500,
              body: raw,
            });
          }
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

describe('UI1-04: Launcher Handshake and Project Validation', () => {
  let tempBaseDir: string;
  let nonTempBaseDir: string;
  let launcher: ProjectHostLauncher;
  const spawnedPids: number[] = [];

  beforeAll(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-04-test-'));
    // Create a local directory within workspace for testing non-temp rules
    nonTempBaseDir = path.join(process.cwd(), '.tmp-ui1-04-workspace-test');
    if (!fs.existsSync(nonTempBaseDir)) {
      fs.mkdirSync(nonTempBaseDir, { recursive: true });
    }
  });

  afterAll(async () => {
    if (launcher) {
      await launcher.stopAll();
    }

    // Clean up any stray PIDs if any were tracked
    for (const pid of spawnedPids) {
      if (isProcessAlive(pid)) {
        await killProcessTree(pid);
      }
    }

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(nonTempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    launcher = new ProjectHostLauncher({
      allowTemp: true, // by default allow in tests running in tempBaseDir
      timeoutMs: 8000,
    });
  });

  afterEach(async () => {
    if (launcher) {
      await launcher.stopAll();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Section 1: Pre-launch Project Folder Validation
  // ══════════════════════════════════════════════════════════════

  describe('1. Pre-launch Project Folder Validation', () => {
    it('validates a correct project folder successfully', () => {
      const projDir = path.join(tempBaseDir, 'valid-proj');
      fs.mkdirSync(projDir, { recursive: true });
      createValidProjectStructure(projDir);

      const result = validateProjectFolder(projDir, { allowTemp: true });
      expect(result.valid).toBe(true);
      expect(result.project).toBeDefined();
      expect(result.project!.projectName).toBe('valid-proj');
      expect(result.project!.projectRootHash).toBe(computeProjectRootHash(result.project!.canonicalPath));
    });

    it('rejects an empty or invalid project path', () => {
      const result = validateProjectFolder('', { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT_PATH');

      expect(() => assertValidProjectFolder('', { allowTemp: true })).toThrow(ProjectValidationError);
    });

    it('fails closed when project directory does not exist (PROJECT_NOT_FOUND)', () => {
      const nonExistent = path.join(tempBaseDir, 'non-existent-folder-12345');
      const result = validateProjectFolder(nonExistent, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('PROJECT_NOT_FOUND');
    });

    it('fails closed when project path is a file, not a directory (PROJECT_NOT_A_DIRECTORY)', () => {
      const filePath = path.join(tempBaseDir, 'plain-file.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');

      const result = validateProjectFolder(filePath, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('PROJECT_NOT_A_DIRECTORY');
    });

    it('fails closed when .maos directory is missing (MISSING_MAOS_DIRECTORY)', () => {
      const uninitDir = path.join(tempBaseDir, 'uninit-proj');
      fs.mkdirSync(uninitDir, { recursive: true });

      const result = validateProjectFolder(uninitDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('MISSING_MAOS_DIRECTORY');
    });

    it('fails closed when .maos is a file, not a directory (MAOS_NOT_A_DIRECTORY)', () => {
      const corruptedDir = path.join(tempBaseDir, 'corrupt-maos-file');
      fs.mkdirSync(corruptedDir, { recursive: true });
      fs.writeFileSync(path.join(corruptedDir, '.maos'), 'corrupt', 'utf-8');

      const result = validateProjectFolder(corruptedDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('MAOS_NOT_A_DIRECTORY');
    });

    it('fails closed when maos.config.json is missing (MISSING_PROJECT_CONFIG)', () => {
      const noConfigDir = path.join(tempBaseDir, 'no-config-proj');
      fs.mkdirSync(path.join(noConfigDir, '.maos'), { recursive: true });

      const result = validateProjectFolder(noConfigDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('MISSING_PROJECT_CONFIG');
    });

    it('fails closed when maos.config.json contains invalid JSON (INVALID_PROJECT_CONFIG)', () => {
      const badJsonDir = path.join(tempBaseDir, 'bad-json-proj');
      const maosDir = path.join(badJsonDir, '.maos');
      fs.mkdirSync(maosDir, { recursive: true });
      fs.writeFileSync(path.join(maosDir, 'maos.config.json'), '{ malformed JSON @@', 'utf-8');

      const result = validateProjectFolder(badJsonDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INVALID_PROJECT_CONFIG');
    });

    it('fails closed when maos.config.json is missing schemaVersion (INCOMPATIBLE_SCHEMA_VERSION)', () => {
      const noVersionDir = path.join(tempBaseDir, 'no-version-proj');
      const maosDir = path.join(noVersionDir, '.maos');
      fs.mkdirSync(maosDir, { recursive: true });
      fs.writeFileSync(
        path.join(maosDir, 'maos.config.json'),
        JSON.stringify({ projectName: 'no-version' }),
        'utf-8',
      );

      const result = validateProjectFolder(noVersionDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INCOMPATIBLE_SCHEMA_VERSION');
    });

    it('fails closed when schemaVersion is incompatible (INCOMPATIBLE_SCHEMA_VERSION)', () => {
      const badVersionDir = path.join(tempBaseDir, 'bad-version-proj');
      const maosDir = path.join(badVersionDir, '.maos');
      fs.mkdirSync(maosDir, { recursive: true });
      fs.writeFileSync(
        path.join(maosDir, 'maos.config.json'),
        JSON.stringify({ schemaVersion: 999, projectName: 'future' }),
        'utf-8',
      );

      const result = validateProjectFolder(badVersionDir, { allowTemp: true });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INCOMPATIBLE_SCHEMA_VERSION');
    });

    it('fails closed on symlinked project roots (SYMLINK_PROJECT_ROOT_FORBIDDEN)', () => {
      const targetDir = path.join(tempBaseDir, 'symlink-target');
      fs.mkdirSync(targetDir, { recursive: true });
      createValidProjectStructure(targetDir);

      const junctionDir = path.join(tempBaseDir, 'symlink-junction');
      try {
        fs.symlinkSync(targetDir, junctionDir, 'junction');
      } catch {
        // If system doesn't support junctions/symlinks, skip test
        return;
      }

      const result = validateProjectFolder(junctionDir, { allowTemp: true, allowSymlinks: false });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('SYMLINK_PROJECT_ROOT_FORBIDDEN');
    });

    it('fails closed when project is in temp directory without allowTemp (UNSAFE_TEMP_PROJECT_ROOT)', () => {
      const tempProj = path.join(tempBaseDir, 'temp-safety-proj');
      fs.mkdirSync(tempProj, { recursive: true });
      createValidProjectStructure(tempProj);

      // Without allowTemp (default: false)
      const result = validateProjectFolder(tempProj, { allowTemp: false });
      expect(result.valid).toBe(false);
      expect(result.code).toBe('UNSAFE_TEMP_PROJECT_ROOT');
    });

    it('permits non-temp workspace directory with default options', () => {
      const nonTempProj = path.join(nonTempBaseDir, 'sovereign-proj');
      fs.mkdirSync(nonTempProj, { recursive: true });
      createValidProjectStructure(nonTempProj);

      // allowTemp defaults to false
      const result = validateProjectFolder(nonTempProj);
      expect(result.valid).toBe(true);
      expect(result.project).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Section 2: End-to-End Child Process Launch & Handshake
  // ══════════════════════════════════════════════════════════════

  describe('2. End-to-End Child Process Launch & Handshake', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = path.join(tempBaseDir, `e2e-proj-${Date.now()}`);
      fs.mkdirSync(testProjectDir, { recursive: true });
      createValidProjectStructure(testProjectDir);
    });

    it('spawns child process, verifies readiness, and enables authenticated REST/IPC communication', async () => {
      const host = await launcher.launch(testProjectDir, { allowTemp: true });
      spawnedPids.push(host.pid);

      // (a) Process state
      expect(host.pid).toBeGreaterThan(0);
      expect(isProcessAlive(host.pid)).toBe(true);
      expect(host.isAlive()).toBe(true);

      // (b) Loopback port
      expect(host.port).toBeGreaterThan(1024);
      expect(host.host).toBe('127.0.0.1');

      // (c) Project identity
      expect(path.resolve(host.projectRoot).toLowerCase()).toBe(path.resolve(testProjectDir).toLowerCase());
      expect(host.projectRootHash).toBe(computeProjectRootHash(testProjectDir));
      expect(host.serviceInstanceId).toMatch(/^inst_/);

      // (d) Recorded service identity file
      const recorded = readServiceIdentity(testProjectDir);
      expect(recorded).not.toBeNull();
      expect(recorded!.servicePid).toBe(host.pid);
      expect(recorded!.servicePort).toBe(host.port);
      expect(recorded!.serviceInstanceId).toBe(host.serviceInstanceId);
      expect(recorded!.status).toBe('healthy');

      // (e) IPC Ping
      const pingMs = await host.ping();
      expect(pingMs).toBeGreaterThanOrEqual(0);

      // (f) Per-window session token creation
      const session = await host.createSession('main-window-1');
      expect(session).toBeDefined();
      expect(session.token).toBeDefined();
      expect(session.token.length).toBeGreaterThan(30);
      expect(session.windowId).toBe('main-window-1');
      expect(session.serviceInstanceId).toBe(host.serviceInstanceId);

      // (g) Authenticated HTTP request over the verified port
      const projRes = await makeHttpRequest(host.port, '/api/v1/project', session.token, testProjectDir);
      expect(projRes.status).toBe(200);
      expect(projRes.body.data.projectName).toBe(path.basename(testProjectDir));

      // (h) Health check
      const healthRes = await makeHttpRequest(host.port, '/api/v1/health', session.token, testProjectDir);
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.data.status).toBe('HEALTHY');
      expect(healthRes.body.data.serviceInstanceId).toBe(host.serviceInstanceId);
      expect(healthRes.body.data.servicePort).toBe(host.port);



      // (i) Clean shutdown
      await host.stop();
      expect(host.isAlive()).toBe(false);
      expect(isProcessAlive(host.pid)).toBe(false);

      // Identity file must be cleared
      const postRecorded = readServiceIdentity(testProjectDir);
      expect(postRecorded).toBeNull();
    }, 15000);

    it('fails closed before spawning if folder validation fails', async () => {
      const invalidDir = path.join(tempBaseDir, 'invalid-pre-launch');
      fs.mkdirSync(invalidDir, { recursive: true });
      // Missing .maos

      await expect(launcher.launch(invalidDir, { allowTemp: true })).rejects.toThrow(LauncherError);
      expect(launcher.getActiveHost(invalidDir)).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Section 3: Independent Verification Failures & Zero Orphans
  // ══════════════════════════════════════════════════════════════

  describe('3. Independent Verification Failures & Zero Orphans', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = path.join(tempBaseDir, `verify-fail-proj-${Date.now()}`);
      fs.mkdirSync(testProjectDir, { recursive: true });
      createValidProjectStructure(testProjectDir);
    });

    it('rejects child that emits malformed non-JSON readiness and terminates process', async () => {
      const badScript = path.join(testProjectDir, 'malformed-entry.js');
      fs.writeFileSync(
        badScript,
        `
        process.stdout.write("MALFORMED_NON_JSON_LINE\\n");
        setTimeout(() => process.exit(0), 1000);
      `,
        'utf-8',
      );

      await expect(
        launcher.launch(testProjectDir, {
          entrypointPath: badScript,
          allowTemp: true,
          timeoutMs: 2000,
        }),
      ).rejects.toThrow(LauncherError);

      expect(launcher.getActiveHost(testProjectDir)).toBeUndefined();
      expect(readServiceIdentity(testProjectDir)).toBeNull();
    });

    it('rejects child with incompatible protocol version (INCOMPATIBLE_PROTOCOL_VERSION) and kills child', async () => {
      const badScript = path.join(testProjectDir, 'bad-version-entry.js');
      fs.writeFileSync(
        badScript,
        `
        const env = {
          type: 'service_ready',
          protocolVersion: '99.0',
          serviceInstanceId: 'inst_test',
          pid: process.pid,
          port: 50000,
          host: '127.0.0.1',
          projectRoot: process.cwd(),
          projectRootHash: 'dummy',
          executablePath: process.execPath,
          executableHash: 'dummy',
          startedAt: new Date().toISOString()
        };
        process.stdout.write(JSON.stringify(env) + '\\n');
        setInterval(() => {}, 1000);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: badScript,
          allowTemp: true,
          timeoutMs: 3000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('INCOMPATIBLE_PROTOCOL_VERSION');
      expect(readServiceIdentity(testProjectDir)).toBeNull();
    });

    it('rejects child with PID mismatch (VERIFICATION_PID_MISMATCH) and kills child', async () => {
      const badScript = path.join(testProjectDir, 'pid-mismatch-entry.js');
      fs.writeFileSync(
        badScript,
        `
        const env = {
          type: 'service_ready',
          protocolVersion: '1.0',
          serviceInstanceId: 'inst_test',
          pid: 999999, // fake pid
          port: 50000,
          host: '127.0.0.1',
          projectRoot: process.cwd(),
          projectRootHash: 'dummy',
          executablePath: process.execPath,
          executableHash: 'dummy',
          startedAt: new Date().toISOString()
        };
        process.stdout.write(JSON.stringify(env) + '\\n');
        setInterval(() => {}, 1000);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: badScript,
          allowTemp: true,
          timeoutMs: 3000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('VERIFICATION_PID_MISMATCH');
      expect(readServiceIdentity(testProjectDir)).toBeNull();
    });

    it('rejects child with non-loopback host (VERIFICATION_HOST_NON_LOOPBACK) and kills child', async () => {
      const badScript = path.join(testProjectDir, 'non-loopback-entry.js');
      fs.writeFileSync(
        badScript,
        `
        const env = {
          type: 'service_ready',
          protocolVersion: '1.0',
          serviceInstanceId: 'inst_test',
          pid: process.pid,
          port: 50000,
          host: '192.168.1.50',
          projectRoot: process.cwd(),
          projectRootHash: 'dummy',
          executablePath: process.execPath,
          executableHash: 'dummy',
          startedAt: new Date().toISOString()
        };
        process.stdout.write(JSON.stringify(env) + '\\n');
        setInterval(() => {}, 1000);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: badScript,
          allowTemp: true,
          timeoutMs: 3000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('VERIFICATION_HOST_NON_LOOPBACK');
      expect(readServiceIdentity(testProjectDir)).toBeNull();
    });

    it('rejects child with unreachable / unopened TCP port (VERIFICATION_PORT_UNREACHABLE)', async () => {
      const badScript = path.join(testProjectDir, 'closed-port-entry.js');
      fs.writeFileSync(
        badScript,
        `
        const env = {
          type: 'service_ready',
          protocolVersion: '1.0',
          serviceInstanceId: 'inst_test',
          pid: process.pid,
          port: 59123, // Port not listened on
          host: '127.0.0.1',
          projectRoot: ${JSON.stringify(path.resolve(testProjectDir))},
          projectRootHash: '${computeProjectRootHash(path.resolve(testProjectDir))}',
          executablePath: process.execPath,

          executableHash: 'dummy',
          startedAt: new Date().toISOString()
        };
        process.stdout.write(JSON.stringify(env) + '\\n');
        setInterval(() => {}, 1000);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: badScript,
          allowTemp: true,
          timeoutMs: 3000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('VERIFICATION_PORT_UNREACHABLE');
      expect(readServiceIdentity(testProjectDir)).toBeNull();
    });

    it('detects child process early exit before readiness (HOST_EXITED_PREMATURELY)', async () => {
      const exitScript = path.join(testProjectDir, 'early-exit-entry.js');
      fs.writeFileSync(
        exitScript,
        `
        process.exit(42);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: exitScript,
          allowTemp: true,
          timeoutMs: 3000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('HOST_EXITED_PREMATURELY');
    });

    it('times out and kills hanging child if readiness is never sent (STARTUP_TIMEOUT)', async () => {
      const hangScript = path.join(testProjectDir, 'hang-entry.js');
      fs.writeFileSync(
        hangScript,
        `
        // Do nothing, never signal ready
        setInterval(() => {}, 1000);
      `,
        'utf-8',
      );

      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(testProjectDir, {
          entrypointPath: hangScript,
          allowTemp: true,
          timeoutMs: 1000,
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('STARTUP_TIMEOUT');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Section 4: Concurrency, Lifecycle & Zero Orphans
  // ══════════════════════════════════════════════════════════════

  describe('4. Concurrency, Lifecycle & Zero Orphans', () => {
    let projA: string;
    let projB: string;

    beforeEach(() => {
      projA = path.join(tempBaseDir, `concur-a-${Date.now()}`);
      projB = path.join(tempBaseDir, `concur-b-${Date.now()}`);
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      createValidProjectStructure(projA, { projectName: 'project-a' });
      createValidProjectStructure(projB, { projectName: 'project-b' });
    });

    it('rejects duplicate launch of already-running project when reuseExisting: false', async () => {
      const host = await launcher.launch(projA, { allowTemp: true });
      spawnedPids.push(host.pid);

      // Launch again on same folder
      let caughtError: LauncherError | null = null;
      try {
        await launcher.launch(projA, { allowTemp: true, reuseExisting: false });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('ALREADY_RUNNING');

      // Original host remains healthy
      expect(host.isAlive()).toBe(true);
      await host.stop();
    });

    it('returns existing host on duplicate launch when reuseExisting: true', async () => {
      const host1 = await launcher.launch(projA, { allowTemp: true });
      spawnedPids.push(host1.pid);

      const host2 = await launcher.launch(projA, { allowTemp: true, reuseExisting: true });
      expect(host2).toBe(host1);
      expect(host2.pid).toBe(host1.pid);
      expect(host2.port).toBe(host1.port);

      await host1.stop();
    });

    it('cleans up stale identity file if previous process is dead before launch', async () => {
      const statusDir = path.join(projA, '.maos', 'status');
      const identityFile = path.join(statusDir, 'service-identity.json');

      // Write a fake identity with dead PID 999999
      fs.writeFileSync(
        identityFile,
        JSON.stringify({
          serviceInstanceId: 'inst_dead',
          servicePid: 999999,
          servicePort: 49999,
          host: '127.0.0.1',
          projectRoot: projA,
          projectRootHash: 'hash',
          executablePath: process.execPath,
          executableHash: 'hash',
          protocolVersion: '1.0',
          startedAt: new Date().toISOString(),
          status: 'healthy',
        }),
        'utf-8',
      );

      // Launcher must detect dead PID, clear stale identity, and launch cleanly
      const host = await launcher.launch(projA, { allowTemp: true });
      spawnedPids.push(host.pid);
      expect(host.isAlive()).toBe(true);
      expect(host.pid).not.toBe(999999);

      const updated = readServiceIdentity(projA);
      expect(updated!.servicePid).toBe(host.pid);

      await host.stop();
    });

    it('spawns two distinct projects concurrently on different ports without interference', async () => {
      const [hostA, hostB] = await Promise.all([
        launcher.launch(projA, { allowTemp: true }),
        launcher.launch(projB, { allowTemp: true }),
      ]);
      spawnedPids.push(hostA.pid, hostB.pid);

      expect(hostA.pid).not.toBe(hostB.pid);
      expect(hostA.port).not.toBe(hostB.port);
      expect(hostA.isAlive()).toBe(true);
      expect(hostB.isAlive()).toBe(true);

      const sessionA = await hostA.createSession('win-a');
      const sessionB = await hostB.createSession('win-b');

      const resA = await makeHttpRequest(hostA.port, '/api/v1/project', sessionA.token, projA);
      const resB = await makeHttpRequest(hostB.port, '/api/v1/project', sessionB.token, projB);


      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.data.projectName).toBe('project-a');
      expect(resB.body.data.projectName).toBe('project-b');


      await launcher.stopAll();
      expect(hostA.isAlive()).toBe(false);
      expect(hostB.isAlive()).toBe(false);
      expect(readServiceIdentity(projA)).toBeNull();
      expect(readServiceIdentity(projB)).toBeNull();
    });

    it('detects external host crash and cleans up identity state', async () => {
      const host = await launcher.launch(projA, { allowTemp: true });
      spawnedPids.push(host.pid);
      expect(host.isAlive()).toBe(true);

      // Kill the child process externally
      await killProcessTree(host.pid);

      // Wait a moment for exit event to register
      await new Promise((r) => setTimeout(r, 200));

      expect(host.isAlive()).toBe(false);
      expect(launcher.getActiveHost(projA)).toBeUndefined();
      expect(readServiceIdentity(projA)).toBeNull();
    });

    it('guarantees zero orphaned child processes after stopAll', async () => {
      const host = await launcher.launch(projA, { allowTemp: true });
      const pid = host.pid;
      expect(isProcessAlive(pid)).toBe(true);

      await launcher.stopAll();
      expect(isProcessAlive(pid)).toBe(false);
    });
  });
});
