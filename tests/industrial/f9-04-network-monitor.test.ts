/**
 * MAOS Industrial — F9-04: Process-Attributed Network Monitor Test Suite
 *
 * Verifies real-time passive socket observation, process attribution,
 * allowlist correlation, anomaly/violation detection, epistemic honesty,
 * canonical trace generation, persistence, and audit logging:
 * 1. Platform socket observer abstraction (Windows, Linux, Mock)
 * 2. Real-time socket evaluation & violation detection (loopback vs non-loopback, binds, ports)
 * 3. Session lifecycle & periodic sampling (start, snapshot, stop, timer cleanup)
 * 4. Epistemic wording invariants (rejection of absolute/unmeasured claims)
 * 5. Deterministic canonical trace hashing & tamper detection
 * 6. Evidence persistence & trace loading from disk
 * 7. Privacy-safe audit trail integration
 * 8. Invariants & cryptographic integrity (rust/test.txt canary)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  NetworkMonitorService,
} from '../../src/service';
import {
  ObservedSocket,
  NetworkMonitorError,
  NETWORK_MONITOR_ERROR_CODES,
  evaluateObservedSocket,
  assertMeasuredObservationClaims,
  computeCanonicalObservationTraceHash,
  validateObservationTrace,
  generateStandardMeasuredClaim,
} from '../../src/domain/network-monitor';
import {
  createIndustrialEndpointPolicy,
} from '../../src/domain/endpoint-allowlist';
import {
  createIndustrialSovereigntyBoundary,
} from '../../src/domain/sovereignty-boundary';
import {
  MockSocketObserver,
  WindowsSocketObserver,
  LinuxSocketObserver,
  createPlatformSocketObserver,
} from '../../src/industrial/network';

describe('F9-04: Process-Attributed Network Monitor', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f904-' + Date.now(),
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

  // ── 1. Platform Socket Observer Abstraction ────────────────────────

  describe('1. Platform Socket Observer Abstraction', () => {
    it('initializes MockSocketObserver with deterministic in-memory state', async () => {
      const mock = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 3847,
            state: 'LISTEN',
            pid: 1234,
            timestamp: new Date().toISOString(),
          },
        ],
        processes: [
          {
            pid: 1234,
            processName: 'node.exe',
            executablePath: 'C:\\Program Files\\nodejs\\node.exe',
            executableHash: 'a'.repeat(64),
          },
        ],
      });

      expect(mock.platformName).toBe('mock');

      const sockets = await mock.captureActiveSockets();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].protocol).toBe('tcp');
      expect(sockets[0].localPort).toBe(3847);
      expect(sockets[0].processName).toBe('node.exe');
      expect(sockets[0].executableHash).toBe('a'.repeat(64));
      expect(mock.captureCalls).toBe(1);

      const meta = await mock.resolveProcessMetadata(1234);
      expect(meta).not.toBeNull();
      expect(meta?.processName).toBe('node.exe');
    });

    it('handles simulated adapter capture failure in mock adapter', async () => {
      const mock = new MockSocketObserver({ failCapture: true });
      await expect(mock.captureActiveSockets()).rejects.toThrow(
        /Simulated socket capture failure/,
      );
    });

    it('handles simulated process resolution failure in mock adapter', async () => {
      const mock = new MockSocketObserver({ failProcessResolution: true });
      await expect(mock.resolveProcessMetadata(9999)).rejects.toThrow(
        /Simulated process resolution failure/,
      );
    });

    it('instantiates Windows and Linux observers without execution side-effects', () => {
      const winObserver = new WindowsSocketObserver();
      expect(winObserver.platformName).toBe('windows');

      const linuxObserver = new LinuxSocketObserver();
      expect(linuxObserver.platformName).toBe('linux');

      const autoObserver = createPlatformSocketObserver('mock');
      expect(autoObserver.platformName).toBe('mock');
    });
  });

  // ── 2. Socket Evaluation & Violation Detection ─────────────────────

  describe('2. Socket Evaluation & Violation Detection', () => {
    const policy = createIndustrialEndpointPolicy('test_proj');
    const boundary = createIndustrialSovereigntyBoundary('test_proj');

    it('evaluates clean loopback connection as valid (null violation)', () => {
      const cleanSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 54321,
        remoteAddress: '127.0.0.1',
        remotePort: 8000,
        state: 'ESTABLISHED',
        pid: 2000,
        processName: 'maos_backend',
        timestamp: new Date().toISOString(),
      };

      const violation = evaluateObservedSocket(cleanSocket, policy, boundary, {
        monitoredPids: new Set([2000]),
        strictPorts: true,
      });

      expect(violation).toBeNull();
    });

    it('detects outbound connection to public IP as critical violation', () => {
      const cloudSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '192.168.1.100',
        localPort: 55443,
        remoteAddress: '8.8.8.8',
        remotePort: 53,
        state: 'ESTABLISHED',
        pid: 2000,
        processName: 'maos_backend',
        timestamp: new Date().toISOString(),
      };

      const violation = evaluateObservedSocket(cloudSocket, policy, boundary, {
        monitoredPids: new Set([2000]),
      });

      expect(violation).not.toBeNull();
      expect(violation?.type).toBe('NON_LOOPBACK_CONNECTION_DETECTED');
      expect(violation?.severity).toBe('critical');
      expect(violation?.classification).toBe('public');
      expect(violation?.description).toContain('8.8.8.8:53');
    });

    it('detects connection to private LAN IP as critical violation', () => {
      const lanSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '192.168.1.100',
        localPort: 55444,
        remoteAddress: '192.168.1.50',
        remotePort: 8080,
        state: 'ESTABLISHED',
        pid: 2000,
        processName: 'maos_backend',
        timestamp: new Date().toISOString(),
      };

      const violation = evaluateObservedSocket(lanSocket, policy, boundary, {
        monitoredPids: new Set([2000]),
      });

      expect(violation).not.toBeNull();
      expect(violation?.type).toBe('NON_LOOPBACK_CONNECTION_DETECTED');
      expect(violation?.severity).toBe('critical');
      expect(violation?.classification).toBe('private_lan');
    });

    it('detects wildcard or external bind in LISTEN state as critical violation', () => {
      const wildcardListener: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '0.0.0.0',
        localPort: 8080,
        state: 'LISTEN',
        pid: 2000,
        processName: 'maos_backend',
        timestamp: new Date().toISOString(),
      };

      const violation = evaluateObservedSocket(wildcardListener, policy, boundary, {
        monitoredPids: new Set([2000]),
      });

      expect(violation).not.toBeNull();
      expect(violation?.type).toBe('EXTERNAL_INTERFACE_BIND');
      expect(violation?.severity).toBe('critical');
      expect(violation?.classification).toBe('unspecified');
    });

    it('detects loopback connection to undeclared port as warning violation', () => {
      const undeclaredPortSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 54322,
        remoteAddress: '127.0.0.1',
        remotePort: 9999, // not declared in policy
        state: 'ESTABLISHED',
        pid: 2000,
        processName: 'maos_backend',
        timestamp: new Date().toISOString(),
      };

      const violation = evaluateObservedSocket(undeclaredPortSocket, policy, boundary, {
        monitoredPids: new Set([2000]),
        strictPorts: true,
      });

      expect(violation).not.toBeNull();
      expect(violation?.type).toBe('UNDECLARED_LOOPBACK_PORT');
      expect(violation?.severity).toBe('warning');
    });

    it('ignores sockets belonging to unmonitored system PIDs', () => {
      const systemSocket: ObservedSocket = {
        protocol: 'tcp',
        localAddress: '192.168.1.100',
        localPort: 59999,
        remoteAddress: '52.178.10.20',
        remotePort: 443,
        state: 'ESTABLISHED',
        pid: 4, // Windows System process
        processName: 'System',
        timestamp: new Date().toISOString(),
      };

      // Only monitoring PID 2000
      const violation = evaluateObservedSocket(systemSocket, policy, boundary, {
        monitoredPids: new Set([2000]),
      });

      expect(violation).toBeNull();
    });
  });

  // ── 3. Session Lifecycle & Periodic Sampling ───────────────────────

  describe('3. Session Lifecycle & Periodic Sampling', () => {
    it('runs full observation lifecycle with clean loopback traffic', async () => {
      const mockAdapter = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 3847,
            state: 'LISTEN',
            pid: 1001,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 50000,
            remoteAddress: '127.0.0.1',
            remotePort: 8000,
            state: 'ESTABLISHED',
            pid: 1001,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockAdapter,
        auditService: services.audit,
      });

      const sessionId = 'session_clean_test';
      const projectId = 'proj_alpha';

      expect(monitor.isObservationActive(sessionId)).toBe(false);

      // 1. Start observation
      await monitor.startObservation(sessionId, projectId, {
        monitoredPids: [1001],
      });

      expect(monitor.isObservationActive(sessionId)).toBe(true);
      expect(monitor.listActiveObservations()).toContain(sessionId);

      // Duplicate session fails closed
      await expect(
        monitor.startObservation(sessionId, projectId),
      ).rejects.toThrow(NetworkMonitorError);

      // 2. Capture on-demand snapshot
      const snap = await monitor.captureSnapshot(sessionId);
      expect(snap.totalSockets).toBe(2);
      expect(snap.violations).toHaveLength(0);
      expect(snap.loopbackSockets).toBe(2);
      expect(snap.nonLoopbackSockets).toBe(0);

      // 3. Stop observation
      const trace = await monitor.stopObservation(sessionId);
      expect(monitor.isObservationActive(sessionId)).toBe(false);

      expect(trace.schemaVersion).toBe(1);
      expect(trace.sessionId).toBe(sessionId);
      expect(trace.projectId).toBe(projectId);
      expect(trace.summary.allObservedLoopback).toBe(true);
      expect(trace.summary.violationsCount).toBe(0);
      expect(trace.summary.totalSamples).toBeGreaterThanOrEqual(2);
      expect(trace.claims).toHaveLength(1);
      expect(trace.claims[0]).toContain(
        'No non-loopback application connections were observed',
      );
      expect(trace.traceHash).toBeDefined();
      expect(trace.traceHash).toHaveLength(64);
    });

    it('detects violations and reflects them in summary and claims', async () => {
      const mockAdapter = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '192.168.1.100',
            localPort: 54321,
            remoteAddress: '140.82.121.4', // GitHub external IP
            remotePort: 443,
            state: 'ESTABLISHED',
            pid: 1002,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockAdapter,
        auditService: services.audit,
      });

      const sessionId = 'session_violation_test';
      await monitor.startObservation(sessionId, 'proj_beta', {
        monitoredPids: [1002],
      });

      const trace = await monitor.stopObservation(sessionId);

      expect(trace.summary.allObservedLoopback).toBe(false);
      expect(trace.summary.violationsCount).toBeGreaterThan(0);
      expect(trace.summary.violationTypes).toContain(
        'NON_LOOPBACK_CONNECTION_DETECTED',
      );
      expect(trace.claims[0]).toContain('Observed 2 network boundary violation(s)');
    });

    it('enforces failFastOnViolation when configured', async () => {
      const mockAdapter = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '10.0.0.5',
            localPort: 50000,
            remoteAddress: '1.1.1.1',
            remotePort: 53,
            state: 'ESTABLISHED',
            pid: 1003,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockAdapter,
      });

      await expect(
        monitor.startObservation('session_fail_fast', 'proj_gamma', {
          monitoredPids: [1003],
          failFastOnViolation: true,
        }),
      ).rejects.toThrow(/Network boundary violation detected/);
    });

    it('throws NO_ACTIVE_OBSERVATION when stopping unknown session', async () => {
      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: new MockSocketObserver(),
      });

      await expect(monitor.stopObservation('non_existent_session')).rejects.toThrow(
        /no active session found/i,
      );
    });
  });

  // ── 4. Epistemic Wording Invariants & Claims ────────────────────────

  describe('4. Epistemic Wording Invariants', () => {
    it('accepts measured qualified claims', () => {
      const claims = [
        'No non-loopback application connections were observed for monitored processes during the observation window.',
        'Observed 0 violations across 15 socket samples.',
      ];
      expect(() => assertMeasuredObservationClaims(claims)).not.toThrow();
    });

    it('strictly rejects unmeasured absolute claims', () => {
      const forbiddenClaims = [
        'Zero data left the machine',
        'The entire operating system is guaranteed offline',
        'Universal host security is maintained',
        'No network traffic of any kind occurred host-wide',
        'This setup is bulletproof air-gap',
        'Guaranteed unhackable local agent',
      ];

      for (const claim of forbiddenClaims) {
        expect(() => assertMeasuredObservationClaims([claim])).toThrow(
          NetworkMonitorError,
        );
        try {
          assertMeasuredObservationClaims([claim]);
        } catch (err: any) {
          expect(err.code).toBe(NETWORK_MONITOR_ERROR_CODES.PROHIBITED_CLAIM_DETECTED);
        }
      }
    });

    it('generates standard measured claim dynamically based on summary', () => {
      const cleanSummary = {
        allObservedLoopback: true,
        totalSocketsObserved: 10,
        totalSamples: 2,
        trackedProcessSocketsCount: 10,
        untrackedProcessSocketsCount: 0,
        violationsCount: 0,
        violationTypes: [],
        monitoredPids: [1001],
      };
      expect(generateStandardMeasuredClaim(cleanSummary)).toContain(
        'No non-loopback application connections were observed',
      );

      const dirtySummary = {
        ...cleanSummary,
        allObservedLoopback: false,
        violationsCount: 3,
      };
      expect(generateStandardMeasuredClaim(dirtySummary)).toContain(
        'Observed 3 network boundary violation(s)',
      );
    });
  });

  // ── 5. Deterministic Canonical Hashing & Tamper Detection ──────────

  describe('5. Deterministic Canonical Hashing & Tamper Detection', () => {
    it('produces identical SHA-256 hashes regardless of object key order', () => {
      const summary = {
        allObservedLoopback: true,
        totalSocketsObserved: 5,
        totalSamples: 1,
        trackedProcessSocketsCount: 5,
        untrackedProcessSocketsCount: 0,
        violationsCount: 0,
        violationTypes: [],
        monitoredPids: [1001],
      };

      const trace1 = {
        schemaVersion: 1 as const,
        traceId: 'tr_1',
        sessionId: 'sess_1',
        projectId: 'proj_1',
        startedAt: '2026-09-24T13:00:00.000Z',
        stoppedAt: '2026-09-24T13:05:00.000Z',
        policyHash: 'a'.repeat(64),
        boundaryHash: 'b'.repeat(64),
        summary,
        samples: [],
        violations: [],
        observationLimitations: ['limitation 1'],
        claims: ['Claim 1'],
      };

      // Permuted key order
      const trace2 = {
        claims: ['Claim 1'],
        traceId: 'tr_1',
        stoppedAt: '2026-09-24T13:05:00.000Z',
        schemaVersion: 1 as const,
        observationLimitations: ['limitation 1'],
        violations: [],
        summary,
        policyHash: 'a'.repeat(64),
        sessionId: 'sess_1',
        projectId: 'proj_1',
        boundaryHash: 'b'.repeat(64),
        samples: [],
        startedAt: '2026-09-24T13:00:00.000Z',
      };

      const hash1 = computeCanonicalObservationTraceHash(trace1);
      const hash2 = computeCanonicalObservationTraceHash(trace2);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it('detects tampering with any trace field', () => {
      const baseTrace = {
        schemaVersion: 1 as const,
        traceId: 'tr_tamper',
        sessionId: 'sess_tamper',
        projectId: 'proj_tamper',
        startedAt: '2026-09-24T13:00:00.000Z',
        stoppedAt: '2026-09-24T13:05:00.000Z',
        policyHash: 'a'.repeat(64),
        boundaryHash: 'b'.repeat(64),
        summary: {
          allObservedLoopback: true,
          totalSocketsObserved: 5,
          totalSamples: 1,
          trackedProcessSocketsCount: 5,
          untrackedProcessSocketsCount: 0,
          violationsCount: 0,
          violationTypes: [],
          monitoredPids: [1001],
        },
        samples: [],
        violations: [],
        observationLimitations: ['limit'],
        claims: ['No non-loopback application connections were observed.'],
      };

      const canonicalHash = computeCanonicalObservationTraceHash(baseTrace);
      const sealedTrace = { ...baseTrace, traceHash: canonicalHash };

      const validRes = validateObservationTrace(sealedTrace);
      expect(validRes.valid).toBe(true);

      // Tamper: alter summary violationsCount
      const tamperedTrace = {
        ...sealedTrace,
        summary: { ...sealedTrace.summary, violationsCount: 1 },
      };

      const tamperedRes = validateObservationTrace(tamperedTrace);
      expect(tamperedRes.valid).toBe(false);
      expect(tamperedRes.errors[0]).toContain('traceHash mismatch');
    });
  });

  // ── 6. Persistence & Evidence Retrieval ─────────────────────────────

  describe('6. Evidence Persistence & Trace Loading', () => {
    it('persists trace file to .maos/network-evidence and loads it cleanly', async () => {
      const mockAdapter = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 3847,
            state: 'LISTEN',
            pid: 4001,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockAdapter,
      });

      const sessionId = 'session_persistence_test';
      await monitor.startObservation(sessionId, 'proj_persist', {
        monitoredPids: [4001],
      });
      const generated = await monitor.stopObservation(sessionId);

      // Check on disk
      const filePath = path.join(
        testTempDir,
        '.maos',
        'network-evidence',
        `${sessionId}.json`,
      );
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = monitor.getObservationTrace(sessionId);
      expect(loaded.traceId).toBe(generated.traceId);
      expect(loaded.traceHash).toBe(generated.traceHash);

      const verification = monitor.verifyObservationTrace(loaded);
      expect(verification.valid).toBe(true);
    });

    it('rejects tampered trace file on disk', () => {
      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: new MockSocketObserver(),
      });

      const sessionId = 'session_tamper_disk';
      const filePath = path.join(
        testTempDir,
        '.maos',
        'network-evidence',
        `${sessionId}.json`,
      );

      // Write corrupted JSON
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          traceId: 'tr_fake',
          sessionId,
          policyHash: 'a'.repeat(64),
          boundaryHash: 'b'.repeat(64),
          summary: {},
          samples: [],
          violations: [],
          claims: ['Zero data left the machine'], // Prohibited claim
          traceHash: 'c'.repeat(64),
        }),
        'utf-8',
      );

      expect(() => monitor.getObservationTrace(sessionId)).toThrow(
        NetworkMonitorError,
      );
    });
  });

  // ── 7. Privacy-Safe Audit Trail Integration ─────────────────────────

  describe('7. Privacy-Safe Audit Trail Integration', () => {
    it('records start, violation, and stop events in append-only audit log', async () => {
      const mockAdapter = new MockSocketObserver({
        initialSockets: [
          {
            protocol: 'tcp',
            localAddress: '192.168.1.1',
            localPort: 50000,
            remoteAddress: '93.184.216.34', // example.com
            remotePort: 80,
            state: 'ESTABLISHED',
            pid: 5001,
            processName: 'maos_backend',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const monitor = new NetworkMonitorService(testTempDir, {
        adapter: mockAdapter,
        auditService: services.audit,
      });

      const sessionId = 'session_audit_test';
      await monitor.startObservation(sessionId, 'proj_audit', {
        monitoredPids: [5001],
      });

      await monitor.captureSnapshot(sessionId);
      await monitor.stopObservation(sessionId);

      // Verify the audit chain via Rust engine bridge
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);

      const records = services.audit.getRecords({ category: 'endpoint' });
      expect(records.length).toBeGreaterThanOrEqual(3);

      const events = records.map((r) => (r.data as any)?.event);
      expect(events).toContain('NETWORK_OBSERVATION_STARTED');
      expect(events).toContain('NETWORK_ANOMALY_DETECTED');
      expect(events).toContain('NETWORK_OBSERVATION_STOPPED');
    });
  });

  // ── 8. Invariants & Cryptographic Integrity ─────────────────────────

  describe('8. Protected Canary Invariant', () => {
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
