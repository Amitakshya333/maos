/**
 * MAOS Industrial — F9-05: Service and Process Endpoint Identity Test Suite
 *
 * Verifies trusted mappings between observed endpoints and the processes/services that own them:
 * 1. Process registration and identity binding
 * 2. PID reuse detection (PID_REUSED)
 * 3. Port reuse detection (PORT_REUSED)
 * 4. Executable hash drift detection (EXECUTABLE_HASH_MISMATCH)
 * 5. Project root mismatch & cross-project isolation (PROJECT_ROOT_MISMATCH / CROSS_PROJECT_IDENTITY_REJECTED)
 * 6. Process descendant verification (UNTRUSTED_DESCENDANT)
 * 7. Model revision and lease verification (MODEL_REVISION_MISMATCH)
 * 8. Unresolved endpoint owner handling (ENDPOINT_OWNER_UNRESOLVED)
 * 9. Service hijacking detection (SERVICE_HIJACK_DETECTED)
 * 10. Deterministic canonical mapping hashing & tamper detection
 * 11. Privacy-safe identity records (no credentials or raw prompts)
 * 12. Audit trail verification and canary invariant
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  ServiceIdentityService,
} from '../../src/service';
import {
  SERVICE_IDENTITY_ERROR_CODES,
  ServiceIdentityError,
  computeProjectRootHash,
  computeCanonicalIdentityMappingHash,
  validateIdentityMapping,
  assertPrivacySafeIdentity,
  validateProcessTrust,
} from '../../src/domain/service-identity';
import { ObservedSocket } from '../../src/domain/network-monitor';

describe('F9-05: Service and Process Endpoint Identity', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f905-' + Date.now(),
  );

  let services: ServiceContainer;

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
    services = createServiceContainer(testTempDir);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  // ── 1. Process Registration & Identity Binding ──────────────────────

  describe('1. Process Registration & Identity Binding', () => {
    it('registers a process with valid attributes and computes canonical root hash', async () => {
      const identityService = new ServiceIdentityService(testTempDir, {
        auditService: services.audit,
      });

      const proc = await identityService.registerProcess({
        pid: 1001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'maos_backend',
        processName: 'node.exe',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        executableHash: '1'.repeat(64),
        approvedDescendantPids: [1002, 1003],
      });

      expect(proc.processId).toBe(1001);
      expect(proc.serviceIdentity).toBe('maos_backend');
      expect(proc.status).toBe('trusted');
      expect(proc.projectRootHash).toBe(computeProjectRootHash(testTempDir));
      expect(proc.approvedDescendantPids).toEqual([1002, 1003]);

      const retrieved = identityService.getTrackedProcess(1001);
      expect(retrieved).toBeDefined();
      expect(retrieved?.executableHash).toBe('1'.repeat(64));
    });

    it('registers endpoint binding to a trusted process', async () => {
      const identityService = new ServiceIdentityService(testTempDir, {
        auditService: services.audit,
      });

      await identityService.registerProcess({
        pid: 1005,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'maos_backend',
        processName: 'node.exe',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        executableHash: '2'.repeat(64),
      });

      const binding = await identityService.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 3847,
        owningPid: 1005,
        serviceIdentity: 'maos_backend',
      });

      expect(binding.protocol).toBe('tcp');
      expect(binding.localPort).toBe(3847);
      expect(binding.owningPid).toBe(1005);
      expect(binding.status).toBe('active');
    });
  });

  // ── 2. PID Reuse Detection ──────────────────────────────────────────

  describe('2. PID Reuse Detection (PID_REUSED)', () => {
    it('rejects re-registration of active PID with different binary hash or service', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 2001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'legitimate_service',
        processName: 'python.exe',
        executablePath: 'C:\\Python311\\python.exe',
        executableHash: 'a'.repeat(64),
      });

      // Different executable hash under same PID
      await expect(
        identityService.registerProcess({
          pid: 2001,
          projectId: 'test_project',
          projectRoot: testTempDir,
          serviceIdentity: 'legitimate_service',
          processName: 'python.exe',
          executablePath: 'C:\\Python311\\python.exe',
          executableHash: 'b'.repeat(64), // CHANGED HASH
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: SERVICE_IDENTITY_ERROR_CODES.PID_REUSED,
        }),
      );

      // Existing process status is now revoked
      const proc = identityService.getTrackedProcess(2001);
      expect(proc?.status).toBe('revoked');
      expect(proc?.revocationReason).toBe('PID_REUSED');
    });
  });

  // ── 3. Port Reuse Detection ─────────────────────────────────────────

  describe('3. Port Reuse Detection (PORT_REUSED)', () => {
    it('rejects binding an active port to a different process', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 3001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'server_a',
        processName: 'node.exe',
        executablePath: 'node.exe',
        executableHash: '3'.repeat(64),
      });

      await identityService.registerProcess({
        pid: 3002,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'server_b',
        processName: 'python.exe',
        executablePath: 'python.exe',
        executableHash: '4'.repeat(64),
      });

      // Bind port 8000 to server_a
      await identityService.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 8000,
        owningPid: 3001,
        serviceIdentity: 'server_a',
      });

      // Attempt to bind port 8000 to server_b
      await expect(
        identityService.registerEndpointBinding({
          protocol: 'tcp',
          direction: 'bind',
          localAddress: '127.0.0.1',
          localPort: 8000,
          owningPid: 3002,
          serviceIdentity: 'server_b',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: SERVICE_IDENTITY_ERROR_CODES.PORT_REUSED,
        }),
      );
    });
  });

  // ── 4. Executable Hash Changes ──────────────────────────────────────

  describe('4. Executable Hash Drift (EXECUTABLE_HASH_MISMATCH)', () => {
    it('revokes trust when live process binary hash changes', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 4001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'trusted_worker',
        processName: 'worker.exe',
        executablePath: 'worker.exe',
        executableHash: 'c'.repeat(64),
      });

      // Probing with different hash
      const result = await identityService.verifyProcessIdentity(4001, {
        pid: 4001,
        executableHash: 'd'.repeat(64), // DRIFT
        projectRoot: testTempDir,
      });

      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH);

      const proc = identityService.getTrackedProcess(4001);
      expect(proc?.status).toBe('revoked');
    });

    it('revokes trust when observed socket reports modified executable hash', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 4002,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'trusted_worker',
        processName: 'worker.exe',
        executablePath: 'worker.exe',
        executableHash: 'c'.repeat(64),
      });

      const observed: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 54321,
        remoteAddress: '127.0.0.1',
        remotePort: 8000,
        pid: 4002,
        processName: 'worker.exe',
        executableHash: 'e'.repeat(64), // MODIFIED HASH
        timestamp: new Date().toISOString(),
      };

      const result = await identityService.verifyObservedEndpoint(observed);
      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH);
    });
  });

  // ── 5. Project Root & Cross-Project Isolation ───────────────────────

  describe('5. Project Root & Cross-Project Isolation', () => {
    it('rejects process registration pointing to external project root', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await expect(
        identityService.registerProcess({
          pid: 5001,
          projectId: 'external_project',
          projectRoot: 'C:\\some\\external\\path',
          serviceIdentity: 'external_service',
          processName: 'node.exe',
          executablePath: 'node.exe',
          executableHash: '5'.repeat(64),
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: SERVICE_IDENTITY_ERROR_CODES.CROSS_PROJECT_IDENTITY_REJECTED,
        }),
      );
    });

    it('revokes trust if verified process project root drifts', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 5002,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'local_svc',
        processName: 'node.exe',
        executablePath: 'node.exe',
        executableHash: '5'.repeat(64),
      });

      const result = await identityService.verifyProcessIdentity(5002, {
        pid: 5002,
        executableHash: '5'.repeat(64),
        projectRoot: 'C:\\different\\folder',
      });

      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.PROJECT_ROOT_MISMATCH);
    });
  });

  // ── 6. Process Descendant Changes ───────────────────────────────────

  describe('6. Process Descendant Verification (UNTRUSTED_DESCENDANT)', () => {
    it('revokes trust if an unapproved descendant PID is spawned', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 6001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'orchestrator',
        processName: 'node.exe',
        executablePath: 'node.exe',
        executableHash: '6'.repeat(64),
        approvedDescendantPids: [6002, 6003],
      });

      // Probing with unknown descendant PID 9999
      const result = await identityService.verifyProcessIdentity(6001, {
        pid: 6001,
        executableHash: '6'.repeat(64),
        projectRoot: testTempDir,
        descendantPids: [6002, 9999], // 9999 is unapproved
      });

      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.UNTRUSTED_DESCENDANT);
    });
  });

  // ── 7. Model Revision & Lease Verification ──────────────────────────

  describe('7. Model Revision & Lease Verification (MODEL_REVISION_MISMATCH)', () => {
    it('revokes trust if model server revision changes unexpectedly', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 7001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'local_model_server',
        processName: 'python.exe',
        executablePath: 'python.exe',
        executableHash: '7'.repeat(64),
        modelIdentity: {
          modelId: 'qwen2.5-coder-7b',
          modelRevision: 'rev_1_pinned',
          manifestHash: 'f'.repeat(64),
        },
        activeModelLeases: ['lease_1'],
      });

      // Probing with mismatched model revision
      const result = await identityService.verifyProcessIdentity(7001, {
        pid: 7001,
        executableHash: '7'.repeat(64),
        projectRoot: testTempDir,
        modelRevision: 'rev_2_unapproved', // REVISION DRIFT
      });

      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.MODEL_REVISION_MISMATCH);
    });

    it('rejects lease update if revision does not match registered model', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      await identityService.registerProcess({
        pid: 7002,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'local_model_server',
        processName: 'python.exe',
        executablePath: 'python.exe',
        executableHash: '7'.repeat(64),
        modelIdentity: {
          modelId: 'qwen2.5-coder-7b',
          modelRevision: 'rev_1_pinned',
          manifestHash: 'f'.repeat(64),
        },
      });

      await expect(
        identityService.updateModelLease(
          7002,
          'qwen2.5-coder-7b',
          'rev_2_unknown',
          ['lease_2'],
        ),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: SERVICE_IDENTITY_ERROR_CODES.MODEL_REVISION_MISMATCH,
        }),
      );
    });
  });

  // ── 8. Endpoint Owner Unresolved & Service Hijack ───────────────────

  describe('8. Endpoint Owner Unresolved & Service Hijack', () => {
    it('fails closed when observed socket is owned by unmapped PID', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      const unmappedSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 3847,
        pid: 8888, // NOT REGISTERED
        timestamp: new Date().toISOString(),
      };

      const result = await identityService.verifyObservedEndpoint(unmappedSocket);
      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED);
    });

    it('detects service hijack when an external PID listens on registered service port', async () => {
      const identityService = new ServiceIdentityService(testTempDir);

      // Register legitimate backend on port 3847
      await identityService.registerProcess({
        pid: 9001,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'maos_backend',
        processName: 'node.exe',
        executablePath: 'node.exe',
        executableHash: '9'.repeat(64),
      });

      await identityService.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 9090,
        owningPid: 9001,
        serviceIdentity: 'maos_backend',
      });

      // Register another process
      await identityService.registerProcess({
        pid: 9002,
        projectId: 'test_project',
        projectRoot: testTempDir,
        serviceIdentity: 'rogue_process',
        processName: 'malicious.exe',
        executablePath: 'malicious.exe',
        executableHash: '8'.repeat(64),
      });

      // Observed socket indicates PID 9002 is listening on port 9090
      const hijackSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 9090,
        pid: 9002, // Different PID claiming port 9090
        timestamp: new Date().toISOString(),
      };

      const result = await identityService.verifyObservedEndpoint(hijackSocket);
      expect(result.trusted).toBe(false);
      expect(result.errorCode).toBe(SERVICE_IDENTITY_ERROR_CODES.SERVICE_HIJACK_DETECTED);

      // Malicious PID is revoked
      const rogue = identityService.getTrackedProcess(9002);
      expect(rogue?.status).toBe('terminated');
    });
  });

  // ── 9. Canonical Mapping Hashes & Tamper Detection ───────────────────

  describe('9. Canonical Hashing & Tamper Detection', () => {
    it('produces identical mapping hash regardless of object key order', () => {
      const mapping1 = {
        schemaVersion: 1 as const,
        mappingId: 'map_1',
        projectId: 'proj_1',
        projectRoot: testTempDir,
        boundaryHash: 'a'.repeat(64),
        endpointPolicyHash: 'b'.repeat(64),
        processes: [],
        endpointBindings: [],
        createdAt: '2026-09-24T13:00:00.000Z',
        lastVerifiedAt: '2026-09-24T13:05:00.000Z',
      };

      const mapping2 = {
        lastVerifiedAt: '2026-09-24T13:05:00.000Z',
        endpointPolicyHash: 'b'.repeat(64),
        mappingId: 'map_1',
        boundaryHash: 'a'.repeat(64),
        projectRoot: testTempDir,
        processes: [],
        createdAt: '2026-09-24T13:00:00.000Z',
        schemaVersion: 1 as const,
        endpointBindings: [],
        projectId: 'proj_1',
      };

      const h1 = computeCanonicalIdentityMappingHash(mapping1);
      const h2 = computeCanonicalIdentityMappingHash(mapping2);

      expect(h1).toHaveLength(64);
      expect(h1).toBe(h2);
    });

    it('detects tampering in exported identity mapping', () => {
      const identityService = new ServiceIdentityService(testTempDir);
      const mapping = identityService.exportIdentityMapping('test_proj');

      expect(mapping.mappingHash).toBeDefined();
      const val = identityService.verifyIdentityMappingIntegrity(mapping);
      expect(val.valid).toBe(true);

      // Tamper: alter projectRoot
      const tampered = {
        ...mapping,
        projectRoot: 'C:\\hacked\\path',
      };

      const tamperedVal = identityService.verifyIdentityMappingIntegrity(tampered as any);
      expect(tamperedVal.valid).toBe(false);
      expect(tamperedVal.errors[0]).toContain('mappingHash mismatch');
    });
  });

  // ── 10. Privacy-Safe Identity Evidence ──────────────────────────────

  describe('10. Privacy-Safe Identity Evidence', () => {
    it('rejects identity objects containing sensitive keys or tokens', () => {
      const leakAttempt = {
        pid: 9999,
        serviceIdentity: 'bad_actor',
        apiKey: 'sk-secret-12345', // SENSITIVE
      };

      expect(() => assertPrivacySafeIdentity(leakAttempt)).toThrowError(
        expect.objectContaining({
          code: SERVICE_IDENTITY_ERROR_CODES.IDENTITY_TAMPERED,
        }),
      );
    });

    it('accepts pure metadata without credentials or prompts', () => {
      const safeObject = {
        pid: 1234,
        serviceIdentity: 'maos_backend',
        executableHash: 'a'.repeat(64),
        runtime: { version: 'v20.10.0' },
      };

      expect(() => assertPrivacySafeIdentity(safeObject)).not.toThrow();
    });
  });

  // ── 11. Audit Trail Integration ─────────────────────────────────────

  describe('11. Audit Trail Integration', () => {
    it('records identity registration and revocation in append-only audit log', async () => {
      const identityService = new ServiceIdentityService(testTempDir, {
        auditService: services.audit,
      });

      await identityService.registerProcess({
        pid: 1101,
        projectId: 'audit_project',
        projectRoot: testTempDir,
        serviceIdentity: 'audited_service',
        processName: 'node.exe',
        executablePath: 'node.exe',
        executableHash: '1'.repeat(64),
      });

      await identityService.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 4433,
        owningPid: 1101,
        serviceIdentity: 'audited_service',
      });

      await identityService.revokeProcess(1101, SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH, false);

      const chain = services.audit.verifyChain();
      expect(chain.valid).toBe(true);

      const records = services.audit.getRecords({ category: 'endpoint' });
      const events = records.map((r) => (r.data as any)?.event);

      expect(events).toContain('SERVICE_IDENTITY_REGISTERED');
      expect(events).toContain('ENDPOINT_BINDING_REGISTERED');
      expect(events).toContain('SERVICE_IDENTITY_REVOKED');
    });
  });

  // ── 12. Protected Canary Invariant ──────────────────────────────────

  describe('12. Protected Canary Invariant', () => {
    it('rust/test.txt canary SHA-256 remains strictly unchanged', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryContent = fs.readFileSync(CANARY_PATH);
      const actualHash = crypto
        .createHash('sha256')
        .update(canaryContent)
        .digest('hex');
      expect(actualHash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
