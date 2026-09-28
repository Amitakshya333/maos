/**
 * MAOS Industrial — F9-06: Industrial Firewall Requirement Test Suite
 *
 * Verifies that Industrial workflows, tasks, model leases, sandbox runs, and restarts
 * strictly require an active, verified host firewall boundary, matched endpoint policy,
 * active passive socket monitoring, and authenticated service identities.
 *
 * Test Sections:
 * 1. Verified Boundary Preconditions (Happy Path)
 * 2. Fail-Closed on Inactive / Unknown / Mismatched Firewall State
 * 3. Fail-Closed on Unconfigured or Non-Strict Endpoint Allowlist
 * 4. Fail-Closed on Network Monitor Inactivity or Detected External Sockets
 * 5. Fail-Closed on Untrusted, Hijacked, or Unresolved Service Identities
 * 6. Fail-Closed on Restart & Continuation Recovery
 * 7. Sandbox Runner Integration
 * 8. REST API /api/v1/industrial/boundary-status Endpoints
 * 9. Privacy-Safe Audit Trail
 * 10. Canary & Cryptographic Invariants
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';

import {
  createServiceContainer,
  ServiceContainer,
  FirewallService,
  EndpointAllowlistService,
  NetworkMonitorService,
  ServiceIdentityService,
  IndustrialFirewallRequirementService,
} from '../../src/service';
import {
  INDUSTRIAL_FIREWALL_ERROR_CODES,
  IndustrialFirewallRequirementError,
  IndustrialBoundaryStatus,
  formatMeasuredBoundaryStatus,
  evaluateIndustrialFirewallRequirement,
} from '../../src/domain/industrial-firewall-requirement';
import {
  createIndustrialEndpointPolicy,
} from '../../src/domain/endpoint-allowlist';
import {
  synthesizeFirewallPlan,
} from '../../src/domain/firewall-policy';
import { MockFirewallAdapter } from '../../src/industrial/firewall';
import { MockSocketObserver } from '../../src/industrial/network';
import { RestApiRouter } from '../../src/api/router';

describe('F9-06: Industrial Firewall Requirement', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f906-' + Date.now(),
  );

  let services: ServiceContainer;
  let mockFwAdapter: MockFirewallAdapter;
  let mockSocketObserver: MockSocketObserver;
  let firewallService: FirewallService;
  let endpointService: EndpointAllowlistService;
  let monitorService: NetworkMonitorService;
  let identityService: ServiceIdentityService;
  let requirementService: IndustrialFirewallRequirementService;

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  });

  beforeEach(async () => {
    mockFwAdapter = new MockFirewallAdapter();
    mockSocketObserver = new MockSocketObserver();

    services = createServiceContainer(testTempDir);

    firewallService = new FirewallService(testTempDir, {
      adapter: mockFwAdapter,
      auditService: services.audit,
      endpointAllowlist: services.endpointAllowlist,
    });

    endpointService = new EndpointAllowlistService(testTempDir, {
      auditService: services.audit,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    monitorService = new NetworkMonitorService(testTempDir, {
      adapter: mockSocketObserver,
      auditService: services.audit,
      endpointAllowlist: endpointService,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    identityService = new ServiceIdentityService(testTempDir, {
      auditService: services.audit,
      endpointAllowlist: endpointService,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    requirementService = new IndustrialFirewallRequirementService(testTempDir, {
      firewall: firewallService,
      endpointAllowlist: endpointService,
      networkMonitor: monitorService,
      serviceIdentity: identityService,
      auditService: services.audit,
    });
    (services as any).industrialFirewallRequirement = requirementService;
  });

  /**
   * Helper to set up a fully verified Industrial boundary.
   */
  async function setupFullyVerifiedBoundary(projectId: string = 'test-proj-verified') {
    // 1. Initialize and activate endpoint allowlist policy
    const policy = endpointService.getActivePolicy(projectId);

    // 2. Synthesize and apply firewall rules via MockFirewallAdapter
    const plan = synthesizeFirewallPlan(policy, 'mock');
    await firewallService.applyPlan(plan, {
      confirm: true,
      isElevated: true,
    });

    // 3. Start network monitor observation session
    await monitorService.startObservation(`session-${projectId}`, projectId, {
      policyHash: plan.policyHash,
    });

    // 4. Register a trusted process
    await identityService.registerProcess({
      projectId,
      projectRoot: testTempDir,
      pid: 2468,
      processName: 'maos-model-server',
      executablePath: path.join(testTempDir, 'maos-model'),
      executableHash: 'a'.repeat(64),
      serviceIdentity: 'local_model_server',
      runtimeManifest: {
        runtimeType: 'native_binary',
        version: '1.0.0',
      },
      modelIdentity: {
        modelId: 'qwen2.5-3b-instruct-local',
        modelRevision: 'rev-2026-03',
        manifestHash: 'c'.repeat(64),
      },
    });

    await identityService.registerEndpointBinding({
      projectId,
      owningPid: 2468,
      serviceIdentity: 'local_model_server',
      port: 8000,
      protocol: 'tcp',
      direction: 'bind',
      localAddress: '127.0.0.1',
    });

    return { policy, plan };
  }

  // ── 1. Verified Boundary Preconditions (Happy Path) ────────────────

  describe('1. Verified Boundary Preconditions (Happy Path)', () => {
    it('returns VERIFIED status when all preconditions are satisfied', async () => {
      const projectId = 'proj-happy-01';
      await setupFullyVerifiedBoundary(projectId);

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(true);
      expect(status.overallStatus).toBe('VERIFIED');
      expect(status.firewallStatus).toBe('ACTIVE');
      expect(status.endpointPolicyStatus).toBe('MATCHED');
      expect(status.monitorStatus).toBe('CAPTURING');
      expect(status.serviceIdentityStatus).toBe('TRUSTED');
      expect(status.activeViolations).toHaveLength(0);
      expect(status.failureCode).toBeUndefined();
    });

    it('formats measured boundary status with standard multi-line report', async () => {
      const projectId = 'proj-happy-02';
      await setupFullyVerifiedBoundary(projectId);

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);
      const formatted = requirementService.formatStatusForDisplay(status);

      expect(formatted).toBe(
        [
          'Industrial network boundary: VERIFIED',
          'Firewall: ACTIVE',
          'Endpoint policy: MATCHED',
          'Monitor: CAPTURING',
          'Service identity: TRUSTED',
        ].join('\n'),
      );
    });

    it('allows workflow, task, model lease, sandbox, and continuation assertions', async () => {
      const projectId = 'proj-happy-03';
      await setupFullyVerifiedBoundary(projectId);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).resolves.toBeDefined();

      await expect(
        requirementService.assertTaskStartAllowed(projectId, 'task-001'),
      ).resolves.toBeUndefined();

      await expect(
        requirementService.assertModelLeaseAllowed(projectId, 'model-qwen', 'rev-2026-03'),
      ).resolves.toBeUndefined();

      await expect(
        requirementService.assertSandboxExecutionAllowed(projectId),
      ).resolves.toBeUndefined();

      await expect(
        requirementService.assertContinuationRecoveryAllowed(projectId, 'wf-999'),
      ).resolves.toBeUndefined();
    });
  });

  // ── 2. Fail-Closed on Firewall States ──────────────────────────────

  describe('2. Fail-Closed on Inactive / Unknown / Mismatched Firewall State', () => {
    it('fails closed when firewall status is INACTIVE', async () => {
      const projectId = 'proj-fw-inactive';
      endpointService.getActivePolicy(projectId);

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(false);
      expect(status.overallStatus).toBe('BLOCKED');
      expect(status.firewallStatus).toBe('INACTIVE');
      expect(status.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).rejects.toThrow(IndustrialFirewallRequirementError);

      try {
        await requirementService.assertIndustrialExecutionAllowed(projectId);
      } catch (err: any) {
        expect(err.code).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);
        expect(err.message).toContain('FIREWALL_INACTIVE');
      }
    });

    it('fails closed when firewall status is UNKNOWN', async () => {
      const projectId = 'proj-fw-unknown';

      // Create an evaluator input with unknown firewall state
      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'windows',
          state: 'UNKNOWN',
          activeRulesCount: 0,
          capturedAt: new Date().toISOString(),
        },
        endpointPolicy: createIndustrialEndpointPolicy(projectId),
        monitorActive: true,
        trustedServicesCount: 1,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_STATUS_UNKNOWN);
      expect(formatMeasuredBoundaryStatus(evalResult)).toBe(
        'Industrial execution blocked: firewall status unknown',
      );
    });

    it('fails closed when applied firewall policy hash does not match approved policy', async () => {
      const projectId = 'proj-fw-mismatch';
      const { plan } = await setupFullyVerifiedBoundary(projectId);

      // Mutate the active plan file on disk to report a mismatched hash
      const activePlanPath = path.join(testTempDir, '.maos', 'firewall', 'active-plan.json');
      const diskPlan = JSON.parse(fs.readFileSync(activePlanPath, 'utf8'));
      fs.writeFileSync(
        activePlanPath,
        JSON.stringify({ ...diskPlan, policyHash: 'tampered-hash-999' }, null, 2),
      );

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(false);
      expect(status.overallStatus).toBe('BLOCKED');
      expect(status.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_POLICY_MISMATCH);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_POLICY_MISMATCH);
    });
  });

  // ── 3. Fail-Closed on Endpoint Allowlist States ────────────────────

  describe('3. Fail-Closed on Unconfigured or Non-Strict Endpoint Allowlist', () => {
    it('fails closed when endpoint allowlist policy is unconfigured', async () => {
      // Evaluate with null endpoint policy
      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'mock',
          state: 'ACTIVE',
          activeRulesCount: 4,
          activePolicyHash: 'matching-hash',
          capturedAt: new Date().toISOString(),
        },
        expectedFirewallPolicyHash: 'matching-hash',
        endpointPolicy: null,
        monitorActive: true,
        trustedServicesCount: 1,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.ENDPOINT_POLICY_MISMATCH);
      expect(evalResult.endpointPolicyStatus).toBe('UNCONFIGURED');
    });

    it('fails closed when endpoint allowlist policy does not enforce strict loopback', async () => {
      const tamperedPolicy = {
        ...createIndustrialEndpointPolicy('tampered-proj'),
        enforceLoopbackStrict: false,
      };

      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'mock',
          state: 'ACTIVE',
          activeRulesCount: 4,
          activePolicyHash: 'hash-abc',
          capturedAt: new Date().toISOString(),
        },
        expectedFirewallPolicyHash: 'hash-abc',
        endpointPolicy: tamperedPolicy as any,
        monitorActive: true,
        trustedServicesCount: 1,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.ENDPOINT_POLICY_MISMATCH);
    });

    it('fails closed when a model endpoint is not strictly loopback', async () => {
      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'mock',
          state: 'ACTIVE',
          activeRulesCount: 4,
          activePolicyHash: 'hash-abc',
          capturedAt: new Date().toISOString(),
        },
        expectedFirewallPolicyHash: 'hash-abc',
        endpointPolicy: createIndustrialEndpointPolicy('proj-ext-model'),
        monitorActive: true,
        trustedServicesCount: 1,
        modelEndpointsLoopbackOnly: false,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED);
    });
  });

  // ── 4. Fail-Closed on Network Monitor States ───────────────────────

  describe('4. Fail-Closed on Network Monitor Inactivity or Detected External Sockets', () => {
    it('fails closed when network monitor is unavailable or inactive', async () => {
      const projectId = 'proj-no-monitor';
      const policy = endpointService.getActivePolicy(projectId);
      const plan = synthesizeFirewallPlan(policy, 'mock');
      await firewallService.applyPlan(plan, { confirm: true, isElevated: true });

      // Note: monitor is NOT started
      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(false);
      expect(status.overallStatus).toBe('BLOCKED');
      expect(status.monitorStatus).toBe('UNAVAILABLE');
      expect(status.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.NETWORK_MONITOR_UNAVAILABLE);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.NETWORK_MONITOR_UNAVAILABLE);
    });

    it('fails closed when network monitor observes non-loopback connection', async () => {
      const projectId = 'proj-external-conn';
      await setupFullyVerifiedBoundary(projectId);

      // Simulate external non-loopback socket detected by network monitor
      mockSocketObserver.addMockSocket({
        protocol: 'tcp',
        localAddress: '192.168.1.50',
        localPort: 54321,
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        state: 'ESTABLISHED',
        pid: 9999,
        processName: 'rogue-process',
        timestamp: new Date().toISOString(),
      });

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(false);
      expect(status.overallStatus).toBe('BLOCKED');
      expect(status.monitorStatus).toBe('ANOMALY_DETECTED');
      expect(status.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED);
    });
  });

  // ── 5. Fail-Closed on Service Identity & Hijack States ─────────────

  describe('5. Fail-Closed on Untrusted, Hijacked, or Unresolved Service Identities', () => {
    it('fails closed when an untrusted or revoked process identity exists', async () => {
      const projectId = 'proj-untrusted-svc';
      await setupFullyVerifiedBoundary(projectId);

      // Register untrusted process
      await identityService.registerProcess({
        projectId,
        projectRoot: testTempDir,
        pid: 7777,
        processName: 'suspicious-worker',
        executablePath: path.join(testTempDir, 'evil'),
        executableHash: 'b'.repeat(64),
        serviceIdentity: 'suspicious_worker',
        runtimeManifest: {
          runtimeType: 'python_script',
          version: '1.0.0',
        },
      });
      await identityService.revokeProcess(7777, 'UNTRUSTED_DESCENDANT' as any);

      const status = await requirementService.getIndustrialBoundaryStatus(projectId);

      expect(status.verified).toBe(false);
      expect(status.serviceIdentityStatus).toBe('UNTRUSTED');
      expect(status.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.SERVICE_IDENTITY_UNTRUSTED);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(projectId),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.SERVICE_IDENTITY_UNTRUSTED);
    });

    it('fails closed when a port binding is hijacked', async () => {
      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'mock',
          state: 'ACTIVE',
          activeRulesCount: 4,
          activePolicyHash: 'hash-abc',
          capturedAt: new Date().toISOString(),
        },
        expectedFirewallPolicyHash: 'hash-abc',
        endpointPolicy: createIndustrialEndpointPolicy('proj-hijack'),
        monitorActive: true,
        trustedServicesCount: 1,
        hijackedServicesCount: 1,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.SERVICE_HIJACK_DETECTED);
    });

    it('fails closed on model revision mismatch', async () => {
      const evalResult = evaluateIndustrialFirewallRequirement({
        firewallStatus: {
          platform: 'mock',
          state: 'ACTIVE',
          activeRulesCount: 4,
          activePolicyHash: 'hash-abc',
          capturedAt: new Date().toISOString(),
        },
        expectedFirewallPolicyHash: 'hash-abc',
        endpointPolicy: createIndustrialEndpointPolicy('proj-model-rev'),
        monitorActive: true,
        trustedServicesCount: 1,
        modelRevisionMismatch: true,
      });

      expect(evalResult.verified).toBe(false);
      expect(evalResult.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.MODEL_REVISION_MISMATCH);
    });
  });

  // ── 6. Restart & Continuation Recovery Invariants ─────────────────

  describe('6. Restart & Continuation Recovery Invariants', () => {
    it('blocks continuation recovery if boundary has not been verified', async () => {
      const projectId = 'proj-restart-unverified';
      // Inactive firewall
      await expect(
        requirementService.assertContinuationRecoveryAllowed(projectId, 'workflow-interrupted-01'),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);
    });

    it('allows continuation recovery only after full boundary verification', async () => {
      const projectId = 'proj-restart-verified';
      await setupFullyVerifiedBoundary(projectId);

      await expect(
        requirementService.assertContinuationRecoveryAllowed(projectId, 'workflow-interrupted-02'),
      ).resolves.toBeUndefined();
    });
  });

  // ── 7. Sandbox Runner Integration ──────────────────────────────────

  describe('7. Sandbox Runner Integration', () => {
    it('halts sandbox execution when enforceFirewallRequirement is enabled and boundary is blocked', async () => {
      const projectId = 'proj-sandbox-blocked';
      // Create runner with requirement enforcement
      const runner = services.sandboxRunner;
      runner.setIndustrialFirewallRequirement(requirementService, true);

      await expect(
        runner.execute({
          script: 'print("hello sovereign")',
          projectId,
          callerIdentity: {
            agentId: 'coder_agent',
          },
        }),
      ).rejects.toThrow(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);
    });
  });

  // ── 8. REST API /api/v1/industrial/boundary-status ─────────────────

  describe('8. REST API /api/v1/industrial/boundary-status', () => {
    let server: http.Server;
    let serverPort: number;

    beforeAll(async () => {
      // Connect our requirementService into services container
      (services as any).industrialFirewallRequirement = requirementService;

      server = http.createServer(async (req, res) => {
        const router = new RestApiRouter(services, testTempDir);
        const handled = await router.handle(req, res);
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          serverPort = addr.port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 403 with typed error code when boundary is unverified', async () => {
      const projectId = 'proj-api-blocked';

      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/v1/industrial/boundary-status?projectId=${projectId}`,
        {
          headers: {
            'X-Project-Root': testTempDir,
          },
        },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);
      expect(body.error.details.verified).toBe(false);
      expect(body.error.details.overallStatus).toBe('BLOCKED');
    });

    it('returns HTTP 200 with status when ?inspect=true is provided on blocked boundary', async () => {
      const projectId = 'proj-api-inspect';

      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/v1/industrial/boundary-status?projectId=${projectId}&inspect=true`,
        {
          headers: {
            'X-Project-Root': testTempDir,
          },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.verified).toBe(false);
      expect(body.data.overallStatus).toBe('BLOCKED');
    });

    it('returns HTTP 200 with verified boundary status when boundary is active', async () => {
      const projectId = 'proj-api-verified';
      await setupFullyVerifiedBoundary(projectId);

      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/v1/industrial/boundary-status?projectId=${projectId}`,
        {
          headers: {
            'X-Project-Root': testTempDir,
          },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.verified).toBe(true);
      expect(body.data.overallStatus).toBe('VERIFIED');
      expect(body.data.firewallStatus).toBe('ACTIVE');
      expect(body.data.endpointPolicyStatus).toBe('MATCHED');
      expect(body.data.monitorStatus).toBe('CAPTURING');
      expect(body.data.serviceIdentityStatus).toBe('TRUSTED');
    });
  });

  // ── 9. Privacy-Safe Audit Trail ───────────────────────────────────

  describe('9. Privacy-Safe Audit Trail', () => {
    it('durably records INDUSTRIAL_BOUNDARY_CHECK_FAILED audit events upon failure', async () => {
      const projectId = 'proj-audit-fail';

      try {
        await requirementService.assertIndustrialExecutionAllowed(projectId, {
          action: 'TEST_TASK',
          taskId: 'task-audit-99',
        });
      } catch {
        // Expected failure
      }

      const records = services.audit.getRecords({ category: 'endpoint' });
      const failEvent = records.find(
        (r) => r.data?.event === 'INDUSTRIAL_BOUNDARY_CHECK_FAILED' && r.data?.projectId === projectId,
      );

      expect(failEvent).toBeDefined();
      expect(failEvent?.data?.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);
      expect(failEvent?.data?.action).toBe('TEST_TASK');
      expect(failEvent?.data?.taskId).toBe('task-audit-99');
    });
  });

  // ── 10. Canary & Cryptographic Invariants ─────────────────────────

  describe('10. Canary & Cryptographic Invariants', () => {
    it('strictly preserves rust/test.txt canary SHA-256', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
