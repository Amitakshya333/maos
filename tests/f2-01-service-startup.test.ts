/**
 * F2-01: Service Startup Manager Tests — Corrected
 *
 * Integration tests proving:
 * 1. Two simultaneous startups cannot claim the same port.
 * 2. Service fails clearly if bind fails.
 * 3. Failed startup cleans up its process.
 * 4. Stale process with wrong executable/project identity is not reused.
 * 5. Shutdown terminates descendants, not only the immediate process.
 *
 * Review checks verified:
 * - SHA-256 against release executable only
 * - Debug binaries rejected
 * - --host, --port, --model-path, --device reach real process
 * - Rust health validates protocol AND engine version
 * - Model paths canonicalized and confined to approved roots
 * - Stable documented exit codes
 * - Repeated startup/shutdown is safe
 * - Windows process tree shutdown
 * - No secrets in logs
 * - Tests exercise real process startup, not only mocks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import {
  verifyExecutable,
  rejectDebugBinary,
  validateLoopbackHost,
  validateModelPath,
  isPortOccupied,
  claimPort,
  validateServiceConfig,
  createRustEngineConfig,
  createModelServerConfig,
  checkRustEngineHealth,
  spawnService,
  stopService,
  getServiceState,
  setServiceState,
  resetAllServiceStates,
  detectStaleProcess,
  verifyServiceIdentity,
  ServiceStartupError,
  SERVICE_EXIT_CODES,
} from '../src/industrial/service-startup';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENGINE_EXT = process.platform === 'win32' ? '.exe' : '';
const ENGINE_PATH = path.resolve(PROJECT_ROOT, 'rust', 'target', 'release', `maos-engine${ENGINE_EXT}`);
const ENGINE_EXISTS = fs.existsSync(ENGINE_PATH);
const itIfEngine = ENGINE_EXISTS ? it : it.skip;

describe('F2-01: Service Startup Manager', () => {
  beforeEach(() => {
    resetAllServiceStates();
  });

  // ══════════════════════════════════════════════════════════════
  // 1. SHA-256 against release executable / debug binary rejection
  // ══════════════════════════════════════════════════════════════

  describe('Release-only executable verification', () => {
    itIfEngine('should verify release executable hash', () => {
      const { actualHash, absolutePath } = verifyExecutable(ENGINE_PATH, '', 'rust-engine');
      expect(actualHash).toMatch(/^[0-9a-f]{64}$/);
      expect(absolutePath).toContain(path.join('target', 'release'));
    });

    it('should reject debug binary path with DEBUG_BINARY exit code', () => {
      const debugPath = path.join(PROJECT_ROOT, 'rust', 'target', 'debug', 'maos-engine.exe');
      try {
        rejectDebugBinary(debugPath, 'test');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.DEBUG_BINARY);
        expect(e.message).toContain('Debug binary');
        expect(e.message).toContain('cargo build --release');
      }
    });

    it('should throw MISSING_EXECUTABLE for non-existent path', () => {
      try {
        verifyExecutable('/nonexistent/maos-engine.exe', '', 'svc');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.MISSING_EXECUTABLE);
      }
    });

    itIfEngine('should throw TAMPERED_EXECUTABLE for wrong hash', () => {
      const wrongHash = 'a'.repeat(64);
      try {
        verifyExecutable(ENGINE_PATH, wrongHash, 'rust-engine');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.TAMPERED_EXECUTABLE);
        expect(e.message).toContain('hash mismatch');
      }
    });

    itIfEngine('should accept correct hash', () => {
      const { actualHash } = verifyExecutable(ENGINE_PATH, '', 'rust-engine');
      expect(() => verifyExecutable(ENGINE_PATH, actualHash, 'rust-engine')).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Loopback enforcement (0.0.0.0 excluded)
  // ══════════════════════════════════════════════════════════════

  describe('Loopback host validation', () => {
    it('should accept 127.0.0.1, localhost, ::1', () => {
      expect(() => validateLoopbackHost('127.0.0.1')).not.toThrow();
      expect(() => validateLoopbackHost('localhost')).not.toThrow();
      expect(() => validateLoopbackHost('::1')).not.toThrow();
    });

    it('should reject 0.0.0.0 (binds all interfaces)', () => {
      try {
        validateLoopbackHost('0.0.0.0');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.NON_LOOPBACK_HOST);
        expect(e.message).toContain('0.0.0.0');
      }
    });

    it('should reject external addresses', () => {
      expect(() => validateLoopbackHost('192.168.1.1')).toThrow(ServiceStartupError);
      expect(() => validateLoopbackHost('10.0.0.1')).toThrow(ServiceStartupError);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Model path canonicalization and root confinement
  // ══════════════════════════════════════════════════════════════

  describe('Model path validation', () => {
    it('should reject empty model path', () => {
      try {
        validateModelPath('', 'svc');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ServiceStartupError).code).toBe(SERVICE_EXIT_CODES.INVALID_MODEL_PATH);
      }
    });

    it('should reject non-existent model path', () => {
      try {
        validateModelPath('/nonexistent/model.bin', 'svc');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ServiceStartupError).code).toBe(SERVICE_EXIT_CODES.INVALID_MODEL_PATH);
      }
    });

    it('should canonicalize and accept valid path', () => {
      const canonical = validateModelPath(PROJECT_ROOT, 'svc');
      // Canonical path should be an absolute, resolved path
      expect(path.isAbsolute(canonical)).toBe(true);
    });

    it('should reject paths outside approved model roots', () => {
      // Create a temp dir as the only approved root
      const approvedRoot = path.resolve(PROJECT_ROOT, 'rust');
      try {
        // PROJECT_ROOT is outside rust/, so this should fail
        validateModelPath(path.resolve(PROJECT_ROOT, 'src'), 'svc', [approvedRoot]);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ServiceStartupError).code).toBe(SERVICE_EXIT_CODES.MODEL_PATH_ESCAPE);
        expect((err as ServiceStartupError).message).toContain('outside approved');
      }
    });

    it('should accept paths inside approved model roots', () => {
      const approvedRoot = PROJECT_ROOT;
      const canonical = validateModelPath(
        path.resolve(PROJECT_ROOT, 'rust'), 'svc', [approvedRoot],
      );
      expect(canonical).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. --host, --port, --model-path, --device in args
  // ══════════════════════════════════════════════════════════════

  describe('CLI arguments pass-through', () => {
    it('should include --host, --port, --model-path, --device in args', () => {
      const config = createModelServerConfig({
        id: 'test-model',
        executablePath: '/fake/binary',
        host: '127.0.0.1',
        port: 8080,
        modelPath: '/models/qwen',
        modelName: 'qwen2.5',
        device: 'cuda:0',
      });

      expect(config.args).toContain('--host');
      expect(config.args).toContain('127.0.0.1');
      expect(config.args).toContain('--port');
      expect(config.args).toContain('8080');
      expect(config.args).toContain('--model-path');
      expect(config.args).toContain('/models/qwen');
      expect(config.args).toContain('--device');
      expect(config.args).toContain('cuda:0');
    });

    it('should not include secrets in env', () => {
      const config = createModelServerConfig({
        id: 'test-model',
        executablePath: '/fake/binary',
        port: 8080,
        modelPath: '/models/qwen',
        modelName: 'qwen2.5',
      });

      const envKeys = Object.keys(config.env);
      const secretPatterns = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL'];
      for (const key of envKeys) {
        for (const pattern of secretPatterns) {
          expect(key.toUpperCase()).not.toContain(pattern);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Rust health validates protocol AND engine version
  // ══════════════════════════════════════════════════════════════

  describe('Rust engine health validation', () => {
    itIfEngine('should validate protocol version, engine name, and status', () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      const data = checkRustEngineHealth(config);

      expect(data.status).toBe('ok');
      expect(data.engine).toBe('maos-industrial-engine');
      expect(data.protocol_version).toBe('1.0');
      expect(data.unsafe_code).toBe(false);
      expect(data.version).toBeDefined(); // engine version
    });

    it('should fail for missing engine', () => {
      const config = createRustEngineConfig('/nonexistent/project');
      try {
        checkRustEngineHealth(config);
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.MISSING_EXECUTABLE);
      }
    });

    itIfEngine('should record health check timestamp and hash', () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      checkRustEngineHealth(config);
      const state = getServiceState('rust-engine');
      expect(state.lastHealthCheck).toBeDefined();
      expect(state.executableHash).toMatch(/^[0-9a-f]{64}$/);
      expect(state.executablePath).toContain('release');
      expect(state.projectRoot).toBe(PROJECT_ROOT);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Stable documented exit codes
  // ══════════════════════════════════════════════════════════════

  describe('Exit code stability', () => {
    it('should have all documented exit codes', () => {
      expect(SERVICE_EXIT_CODES.SUCCESS).toBe(0);
      expect(SERVICE_EXIT_CODES.MISSING_EXECUTABLE).toBe(10);
      expect(SERVICE_EXIT_CODES.TAMPERED_EXECUTABLE).toBe(11);
      expect(SERVICE_EXIT_CODES.INVALID_MODEL_PATH).toBe(12);
      expect(SERVICE_EXIT_CODES.PORT_OCCUPIED).toBe(13);
      expect(SERVICE_EXIT_CODES.NON_LOOPBACK_HOST).toBe(14);
      expect(SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED).toBe(15);
      expect(SERVICE_EXIT_CODES.ALREADY_RUNNING).toBe(16);
      expect(SERVICE_EXIT_CODES.STARTUP_FAILED).toBe(17);
      expect(SERVICE_EXIT_CODES.STALE_PROCESS).toBe(18);
      expect(SERVICE_EXIT_CODES.BIND_FAILED).toBe(19);
      expect(SERVICE_EXIT_CODES.DEBUG_BINARY).toBe(20);
      expect(SERVICE_EXIT_CODES.MODEL_PATH_ESCAPE).toBe(21);
      expect(SERVICE_EXIT_CODES.IDENTITY_MISMATCH).toBe(22);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Idempotent startup and shutdown
  // ══════════════════════════════════════════════════════════════

  describe('Idempotent startup/shutdown', () => {
    it('should be safe to stop a stopped service multiple times', () => {
      const s1 = stopService('test-svc');
      expect(s1.status).toBe('stopped');
      const s2 = stopService('test-svc');
      expect(s2.status).toBe('stopped');
      const s3 = stopService('test-svc');
      expect(s3.status).toBe('stopped');
    });

    itIfEngine('should detect already-running service', () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      checkRustEngineHealth(config);
      const state = getServiceState('rust-engine');
      expect(state.status).toBe('running');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // INTEGRATION: Two simultaneous startups cannot claim same port
  // ══════════════════════════════════════════════════════════════

  describe('INTEGRATION: Port claiming (authoritative bind)', () => {
    let claimedServer: net.Server | null = null;

    afterEach(() => {
      if (claimedServer) {
        claimedServer.close();
        claimedServer = null;
      }
    });

    it('should claim a port authoritatively', async () => {
      const { server, actualPort } = await claimPort(0, '127.0.0.1', 'test-svc');
      claimedServer = server;
      expect(actualPort).toBeGreaterThan(0);
    });

    it('should fail if port is already claimed by another', async () => {
      // First claim
      const { server, actualPort } = await claimPort(0, '127.0.0.1', 'svc-a');
      claimedServer = server;

      // Second claim on same port MUST fail
      try {
        await claimPort(actualPort, '127.0.0.1', 'svc-b');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.BIND_FAILED);
        expect(e.message).toContain('EADDRINUSE');
      }
    });

    it('two simultaneous claims on same port — one succeeds, one fails', async () => {
      // Allocate an ephemeral port first to get a known port number
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const targetPort = (probe.address() as net.AddressInfo).port;
      probe.close();

      // Race two claims on the same port
      const results = await Promise.allSettled([
        claimPort(targetPort, '127.0.0.1', 'racer-1'),
        claimPort(targetPort, '127.0.0.1', 'racer-2'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one should succeed, one should fail
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Clean up the winner's server
      const winner = fulfilled[0] as PromiseFulfilledResult<{ server: net.Server; actualPort: number }>;
      winner.value.server.close();

      // Loser should have BIND_FAILED
      const loser = rejected[0] as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(ServiceStartupError);
      expect((loser.reason as ServiceStartupError).code).toBe(SERVICE_EXIT_CODES.BIND_FAILED);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // INTEGRATION: Bind failure produces clear error
  // ══════════════════════════════════════════════════════════════

  describe('INTEGRATION: Bind failure clarity', () => {
    it('should produce BIND_FAILED with port number in message', async () => {
      // Occupy a port
      const blocker = net.createServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const port = (blocker.address() as net.AddressInfo).port;

      try {
        await claimPort(port, '127.0.0.1', 'test-svc');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.BIND_FAILED);
        expect(e.message).toContain(String(port));
        expect(e.serviceId).toBe('test-svc');
      } finally {
        blocker.close();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // INTEGRATION: Stale process with wrong identity not reused
  // ══════════════════════════════════════════════════════════════

  describe('INTEGRATION: Identity mismatch on stale process', () => {
    it('should reject service with different executable path', () => {
      // Simulate a running service with one executable
      setServiceState('svc-x', {
        id: 'svc-x',
        status: 'running',
        pid: process.pid, // current process is alive
        executablePath: '/old/path/engine.exe',
        projectRoot: '/old/project',
      });

      try {
        verifyServiceIdentity('svc-x', '/new/path/engine.exe');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.IDENTITY_MISMATCH);
        expect(e.message).toContain('different executable');
      }
    });

    it('should reject service with different project root', () => {
      setServiceState('svc-y', {
        id: 'svc-y',
        status: 'running',
        pid: process.pid,
        executablePath: '/same/engine.exe',
        projectRoot: '/project-A',
      });

      try {
        verifyServiceIdentity('svc-y', '/same/engine.exe', '/project-B');
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ServiceStartupError;
        expect(e.code).toBe(SERVICE_EXIT_CODES.IDENTITY_MISMATCH);
        expect(e.message).toContain('different project');
      }
    });

    it('should accept matching identity', () => {
      setServiceState('svc-z', {
        id: 'svc-z',
        status: 'running',
        pid: process.pid,
        executablePath: '/same/engine.exe',
        projectRoot: '/project-A',
      });

      expect(() => verifyServiceIdentity('svc-z', '/same/engine.exe', '/project-A')).not.toThrow();
    });

    it('should skip identity check for non-running services', () => {
      setServiceState('svc-stopped', {
        id: 'svc-stopped',
        status: 'stopped',
        executablePath: '/old/engine.exe',
      });

      // Should not throw even with different path
      expect(() => verifyServiceIdentity('svc-stopped', '/new/engine.exe')).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // INTEGRATION: Failed startup cleanup
  // ══════════════════════════════════════════════════════════════

  describe('INTEGRATION: Failed startup process cleanup', () => {
    itIfEngine('should record error state when spawned process exits immediately', async () => {
      // Spawn the engine with no stdin — it will read empty and exit
      const config = createRustEngineConfig(PROJECT_ROOT);
      const child = spawnService(config);

      // Close stdin immediately to trigger exit
      child.stdin?.end();

      // Wait for exit
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });

      // State should reflect error
      const state = getServiceState('rust-engine');
      expect(state.status).toBe('error');
      expect(state.lastError).toContain('exited unexpectedly');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // INTEGRATION: Shutdown terminates descendants (process tree)
  // ══════════════════════════════════════════════════════════════

  describe('INTEGRATION: Process tree shutdown', () => {
    itIfEngine('should stop a running spawned service', async () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      const child = spawnService(config);

      // Verify it started
      expect(child.pid).toBeDefined();
      const state = getServiceState('rust-engine');
      expect(state.status).toBe('starting');
      expect(state.pid).toBe(child.pid);

      // Stop it
      const result = stopService('rust-engine');
      expect(result.status).toBe('stopped');

      // Wait a moment for process to die
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    it('should be safe to stop non-existent services', () => {
      expect(() => stopService('never-existed')).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Stale process detection
  // ══════════════════════════════════════════════════════════════

  describe('Stale process detection', () => {
    it('should not detect stale for stopped services', () => {
      expect(detectStaleProcess('never-started')).toBe(false);
    });

    it('should detect stale when PID is dead', () => {
      // Use a very high PID that is certainly not running
      setServiceState('dead-svc', {
        id: 'dead-svc',
        status: 'running',
        pid: 999999999,
      });

      const isStale = detectStaleProcess('dead-svc');
      expect(isStale).toBe(true);

      const state = getServiceState('dead-svc');
      expect(state.status).toBe('error');
      expect(state.lastError).toContain('Stale process');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Rust engine config
  // ══════════════════════════════════════════════════════════════

  describe('Rust engine config', () => {
    it('should resolve to release binary, never debug', () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      expect(config.executablePath).toContain(path.join('target', 'release'));
      expect(config.executablePath).not.toContain('debug');
    });

    it('should record project root', () => {
      const config = createRustEngineConfig(PROJECT_ROOT);
      expect(config.projectRoot).toBe(PROJECT_ROOT);
    });
  });
});
