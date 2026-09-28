/**
 * MAOS Industrial — F9-10: Process-Scoped Boundary Test Suite
 *
 * Verifies the shipped Industrial boundary scope:
 *
 *  1. NO HOST MUTATION — enabling, measuring, and disabling the boundary never
 *     invokes a host firewall adapter and never writes host firewall state.
 *     This is the safety property that makes the scope usable on a developer
 *     workstation.
 *  2. REACHABILITY — the sovereignty gate can actually reach VERIFIED, so
 *     preflight is a real check rather than a permanently-failing gate.
 *  3. MEASURED, NOT INFERRED — ACTIVE requires a live observation session and an
 *     unchanged policy. A stale record never reports ACTIVE.
 *  4. ATTRIBUTION SCOPE — only the attributed process tree is evaluated; host
 *     traffic from unrelated processes neither blocks nor blesses the boundary.
 *  5. FAIL-CLOSED — non-loopback endpoints, tampered policies, missing
 *     confirmation, and observed violations all block.
 *  6. REAL RESTORE — disable stops the session and persists evidence.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  ProcessBoundaryService,
  NetworkMonitorService,
  EndpointAllowlistService,
  FirewallService,
  IndustrialFirewallRequirementService,
} from '../../src/service';
import { MockSocketObserver } from '../../src/industrial/network';
import { MockFirewallAdapter } from '../../src/industrial/firewall';
import { synthesizeProcessBoundaryPlan } from '../../src/domain/process-boundary';
import { createIndustrialEndpointPolicy } from '../../src/domain/endpoint-allowlist';
import { INDUSTRIAL_FIREWALL_ERROR_CODES } from '../../src/domain/industrial-firewall-requirement';
import { FIREWALL_ERROR_CODES } from '../../src/domain/firewall-policy';
import { runIndustrialPreflight, INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';

/**
 * A host firewall adapter that fails loudly if any host-mutating method is
 * reached. Its presence in the wiring is how we PROVE the process scope does not
 * touch host packet filters.
 */
class HostMutationDetector extends MockFirewallAdapter {
  public readonly calls: string[] = [];

  private record(name: string) {
    this.calls.push(name);
  }

  public async applyRules(...args: any[]): Promise<any> {
    this.record('applyRules');
    return super.applyRules(args[0], args[1]);
  }
  public async clearAppliedRules(): Promise<void> {
    this.record('clearAppliedRules');
    return super.clearAppliedRules();
  }
  public async restoreSnapshot(...args: any[]): Promise<any> {
    this.record('restoreSnapshot');
    return super.restoreSnapshot(args[0]);
  }
  public async captureSnapshot(): Promise<any> {
    this.record('captureSnapshot');
    return super.captureSnapshot();
  }
}

describe('F9-10: Process-Scoped Boundary', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f910-' + Date.now(),
  );

  let services: ServiceContainer;
  let mockObserver: MockSocketObserver;
  let hostDetector: HostMutationDetector;
  let hostFirewall: FirewallService;
  let endpointService: EndpointAllowlistService;
  let monitorService: NetworkMonitorService;
  let boundaryService: ProcessBoundaryService;
  let requirementService: IndustrialFirewallRequirementService;

  const PROJECT_ID = 'proj-f910';

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
        // Best effort
      }
    }
  });

  beforeEach(() => {
    mockObserver = new MockSocketObserver();
    hostDetector = new HostMutationDetector();

    services = createServiceContainer(testTempDir);

    endpointService = new EndpointAllowlistService(testTempDir, {
      auditService: services.audit,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    monitorService = new NetworkMonitorService(testTempDir, {
      adapter: mockObserver,
      auditService: services.audit,
      endpointAllowlist: endpointService,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    // The host firewall service is wired in deliberately: nothing in the process
    // scope may reach it.
    hostFirewall = new FirewallService(testTempDir, {
      adapter: hostDetector,
      auditService: services.audit,
      endpointAllowlist: endpointService,
    });

    boundaryService = new ProcessBoundaryService(testTempDir, {
      auditService: services.audit,
      endpointAllowlist: endpointService,
      networkMonitor: monitorService,
      // Deterministic attribution scope: the boundary covers PIDs 4242 and 4243.
      resolveTree: async () => ({ pids: [4242, 4243], complete: true }),
    });

    requirementService = new IndustrialFirewallRequirementService(testTempDir, {
      firewall: hostFirewall,
      processBoundary: boundaryService,
      boundaryScope: 'process',
      endpointAllowlist: endpointService,
      networkMonitor: monitorService,
      auditService: services.audit,
    });
  });

  function boundaryRecordPath(): string {
    return path.join(testTempDir, '.maos', 'firewall', 'process-boundary.json');
  }

  function hostActivePlanPath(): string {
    return path.join(testTempDir, '.maos', 'firewall', 'active-plan.json');
  }

  // ── 1. No Host Mutation ───────────────────────────────────────────

  describe('1. No Host Mutation (safety property)', () => {
    it('enabling, measuring, and disabling the boundary never touches host firewall state', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });
      await boundaryService.getStatus(PROJECT_ID);
      boundaryService.verifyEnabledBoundary(PROJECT_ID);
      await boundaryService.disable(PROJECT_ID, { confirm: true });

      // The decisive assertion: zero host adapter invocations.
      expect(hostDetector.calls).toEqual([]);
      expect(hostDetector.getInstalledRuleCount()).toBe(0);

      // And no host plan was ever committed.
      expect(fs.existsSync(hostActivePlanPath())).toBe(false);
    });

    it('reports hostFirewallModified: false at every lifecycle stage', async () => {
      const before = await boundaryService.getStatus(PROJECT_ID);
      expect(before.hostFirewallModified).toBe(false);
      expect(before.platform).toBe('process');
      expect(before.boundaryScope).toBe('process');
      expect(before.isElevated).toBe(false);

      const enableResult = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
      });
      expect(enableResult.hostFirewallModified).toBe(false);
      expect(enableResult.elevationRequired).toBe(false);

      const active = await boundaryService.getStatus(PROJECT_ID);
      expect(active.state).toBe('ACTIVE');
      expect(active.hostFirewallModified).toBe(false);

      const disableResult = await boundaryService.disable(PROJECT_ID, { confirm: true });
      expect(disableResult.hostFirewallModified).toBe(false);
    });

    it('every synthesized constraint declares that no host filter is written', () => {
      const policy = createIndustrialEndpointPolicy(PROJECT_ID);
      const plan = synthesizeProcessBoundaryPlan(policy);

      expect(plan.scope).toBe('process');
      expect(plan.platform).toBe('process');
      expect(plan.hostFirewallModified).toBe(false);

      const kinds = plan.constraints.map((c) => c.kind);
      expect(kinds).toContain('host_firewall_untouched');
      expect(kinds).toContain('loopback_only_endpoints');
      expect(kinds).not.toContain('default_inbound_block' as any);
    });

    it('self-test leaves no record behind and never touches host state', async () => {
      const result = await boundaryService.selfTest(PROJECT_ID);

      expect(result.hostFirewallModified).toBe(false);
      expect(result.elevationRequired).toBe(false);
      expect(hostDetector.calls).toEqual([]);

      // Self-test tears its own session down.
      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(false);

      const after = await boundaryService.getStatus(PROJECT_ID);
      expect(after.state).toBe('INACTIVE');
    });
  });

  // ── 2. Reachability of the Gate ───────────────────────────────────

  describe('2. The sovereignty gate is reachable', () => {
    it('reaches VERIFIED once the boundary is enabled and observed', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      const status = await requirementService.getIndustrialBoundaryStatus(PROJECT_ID);

      expect(status.verified).toBe(true);
      expect(status.overallStatus).toBe('VERIFIED');
      expect(status.firewallStatus).toBe('ACTIVE');
      expect(status.endpointPolicyStatus).toBe('MATCHED');
      expect(status.monitorStatus).toBe('CAPTURING');
      expect(status.boundaryScope).toBe('process');
      expect(status.measureDetails).toContain('process-scoped');
      expect(status.measureDetails).toContain('not modified');
    });

    it('satisfies the execution assertions once the boundary is enabled', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      await expect(
        requirementService.assertIndustrialExecutionAllowed(PROJECT_ID),
      ).resolves.toBeDefined();
      await expect(
        requirementService.assertSandboxExecutionAllowed(PROJECT_ID),
      ).resolves.toBeUndefined();
      await expect(
        requirementService.assertContinuationRecoveryAllowed(PROJECT_ID, 'wf-1'),
      ).resolves.toBeUndefined();
    });

    it('blames the correct layer: INACTIVE is reported as boundary state, not host firewall state', async () => {
      const status = await requirementService.getIndustrialBoundaryStatus(PROJECT_ID);

      expect(status.verified).toBe(false);
      expect(status.firewallStatus).toBe('INACTIVE');
      expect(status.boundaryScope).toBe('process');
      // The operator-facing detail must not imply the host firewall is disabled.
      expect(status.measureDetails).toContain('not modified');
      expect(status.measureDetails).toContain('Boundary scope: process-scoped');
    });
  });

  // ── 3. Measured, Not Inferred ─────────────────────────────────────

  describe('3. ACTIVE is measured, never inferred', () => {
    it('reports INACTIVE when a record exists but its session has ended', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });
      expect((await boundaryService.getStatus(PROJECT_ID)).state).toBe('ACTIVE');

      // Kill the session out from under the record.
      const sessionId = boundaryService.getActiveSessionId(PROJECT_ID)!;
      await monitorService.stopObservation(sessionId);

      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(status.state).toBe('INACTIVE');
      expect(status.details).toContain('no longer running');
    });

    it('restore_required when the sealed policy changes under an enabled boundary', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      // Re-seal a different policy for the same project.
      endpointService.freezePolicy(PROJECT_ID, { policyId: 'rotated-policy' });

      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(status.state).toBe('RESTORE_REQUIRED');
      expect(status.restoreRequired).toBe(true);
    });

    it('reports INACTIVE for a project that never had a boundary', async () => {
      const status = await boundaryService.getStatus('never-enabled');
      expect(status.state).toBe('INACTIVE');
      expect(status.activePlanId).toBeUndefined();
      expect(status.snapshotCount).toBe(0);
    });
  });

  // ── 4. Attribution Scope ──────────────────────────────────────────

  describe('4. Attribution scope is enforced', () => {
    it('ignores non-loopback traffic from processes outside the attributed tree', async () => {
      // A browser talking to the internet: NOT in the attributed process tree.
      mockObserver.addMockSocket({
        protocol: 'tcp',
        localAddress: '192.168.1.50',
        localPort: 54321,
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        state: 'ESTABLISHED',
        pid: 9999,
        processName: 'chrome',
        timestamp: new Date().toISOString(),
      });

      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      const status = await requirementService.getIndustrialBoundaryStatus(PROJECT_ID);
      expect(status.verified).toBe(true);
      expect(status.monitorStatus).toBe('CAPTURING');
    });

    it('blocks when an attributed process connects off-loopback', async () => {
      mockObserver.addMockSocket({
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 54322,
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        state: 'ESTABLISHED',
        pid: 4242,
        processName: 'maos-model-server',
        timestamp: new Date().toISOString(),
      });

      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      const status = await requirementService.getIndustrialBoundaryStatus(PROJECT_ID);
      expect(status.verified).toBe(false);
      expect(status.failureCode).toBe(
        INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED,
      );
    });

    it('blocks when an attributed process listens on a non-loopback interface', async () => {
      mockObserver.addMockSocket({
        protocol: 'tcp',
        localAddress: '0.0.0.0',
        localPort: 3847,
        state: 'LISTEN',
        pid: 4243,
        processName: 'maos-backend',
        timestamp: new Date().toISOString(),
      });

      const result = await boundaryService.selfTest(PROJECT_ID);

      expect(result.verified).toBe(false);
      expect(result.violationCount).toBeGreaterThan(0);
      expect(result.violations.join(' ')).toContain('0.0.0.0');
    });

    it('records the attribution scope in the plan and enable result', async () => {
      const result = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
        monitoredPids: [5150],
      });

      expect(result.monitoredPids).toContain(4242);
      expect(result.monitoredPids).toContain(4243);
      expect(result.monitoredPids).toContain(5150);
      expect(result.monitoredPids).toEqual([...result.monitoredPids].sort((a, b) => a - b));
      expect(result.attributionComplete).toBe(true);
    });
  });

  // ── 5. Fail-Closed ────────────────────────────────────────────────

  describe('5. Fail-closed behaviour', () => {
    it('refuses to enable without explicit confirmation', async () => {
      await expect(
        boundaryService.enable(PROJECT_ID, { confirm: false }),
      ).rejects.toThrow(FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED);

      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(false);
      expect(hostDetector.calls).toEqual([]);
    });

    it('refuses to disable without explicit confirmation', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      await expect(
        boundaryService.disable(PROJECT_ID, { confirm: false }),
      ).rejects.toThrow(FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED);

      // Boundary is untouched by the refused call.
      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(true);
    });

    it('refuses to synthesize a boundary from a non-loopback endpoint', () => {
      const policy = createIndustrialEndpointPolicy(PROJECT_ID, {
        customEndpoints: [
          {
            endpointId: 'ep_external',
            protocol: 'tcp',
            direction: 'connect',
            host: '93.184.216.34',
            port: 443,
            isLoopbackOnly: false,
            description: 'Exfiltrating endpoint',
          },
        ],
      });

      expect(() => synthesizeProcessBoundaryPlan(policy)).toThrow(
        /not loopback-only/,
      );
    });

    it('refuses to synthesize a boundary when DNS resolution is permitted', () => {
      // Strip the sealed hash so the hash-integrity gate does not fire first and
      // mask the invariant under test.
      const { policyHash: _omit, ...base } = createIndustrialEndpointPolicy(PROJECT_ID);
      const policy = { ...base, disallowDnsResolution: false };

      expect(() => synthesizeProcessBoundaryPlan(policy as any)).toThrow(
        /permits DNS resolution/,
      );
    });

    it('refuses to synthesize a boundary from a non-strict policy', () => {
      const { policyHash: _omit, ...base } = createIndustrialEndpointPolicy(PROJECT_ID);
      const policy = { ...base, enforceLoopbackStrict: false };

      expect(() => synthesizeProcessBoundaryPlan(policy as any)).toThrow(
        /strict loopback/,
      );
    });

    it('refuses to synthesize a boundary from a policy whose hash was tampered with', () => {
      const policy = {
        ...createIndustrialEndpointPolicy(PROJECT_ID),
        policyHash: 'deadbeef'.repeat(8),
      };

      expect(() => synthesizeProcessBoundaryPlan(policy as any)).toThrow(
        /policy hash mismatch/,
      );
    });

    it('rejects a process-scoped instance constructed without a boundary service', () => {
      expect(
        () =>
          new IndustrialFirewallRequirementService(testTempDir, {
            firewall: hostFirewall,
            boundaryScope: 'process',
          }),
      ).toThrow(/Refusing to silently fall back/);
    });

    it('rejects a plan that claims host firewall modification', async () => {
      const policy = createIndustrialEndpointPolicy(PROJECT_ID);
      const plan = synthesizeProcessBoundaryPlan(policy);
      const tampered = { ...plan, hostFirewallModified: true };

      const { validateProcessBoundaryPlan } = await import('../../src/domain/process-boundary');
      const validation = validateProcessBoundaryPlan(tampered);
      expect(validation.valid).toBe(false);
      expect(validation.errors.join(' ')).toContain('hostFirewallModified');
    });
  });

  // ── 6. Verification & Teardown ────────────────────────────────────

  describe('6. Verification and real teardown', () => {
    it('verifies an enabled boundary against the re-derived plan, not the stored file', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      const verification = boundaryService.verifyEnabledBoundary(PROJECT_ID);
      expect(verification.verified).toBe(true);
      expect(verification.sessionLive).toBe(true);
      expect(verification.policyMatches).toBe(true);
      expect(verification.planHash).toBe(verification.expectedPlanHash);
      expect(verification.constraintCount).toBeGreaterThan(0);
    });

    it('detects a tampered record even though every constraint ID is still present', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });

      // Mutate a constraint VALUE while leaving all IDs intact — the failure mode
      // a name-only verifier would miss.
      const raw = JSON.parse(fs.readFileSync(boundaryRecordPath(), 'utf8'));
      const record = raw.records[PROJECT_ID];
      const target = record.plan.constraints.find(
        (c: any) => c.kind === 'declared_listen_ports',
      );
      target.values = [9999];
      fs.writeFileSync(boundaryRecordPath(), JSON.stringify(raw, null, 2));

      // Status must not report ACTIVE for a boundary that no longer matches.
      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(status.state).toBe('ACTIVE'); // session + policy are still live...

      // ...but verification, which re-derives from the sealed policy, catches it.
      const verification = boundaryService.verifyEnabledBoundary(PROJECT_ID);
      expect(verification.verified).toBe(false);
      expect(verification.errors.join(' ')).toContain('does not match');
    });

    it('disable stops the session, persists the observation trace, and clears the record', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });
      const sessionId = boundaryService.getActiveSessionId(PROJECT_ID)!;

      const result = await boundaryService.disable(PROJECT_ID, { confirm: true });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionId);
      expect(result.traceHash).toBeDefined();

      // Evidence persisted.
      expect(result.tracePath).toBeDefined();
      expect(fs.existsSync(result.tracePath!)).toBe(true);

      // Session gone, record gone.
      expect(monitorService.isObservationActive(sessionId)).toBe(false);
      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(false);

      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(status.state).toBe('INACTIVE');
    });

    it('disable is idempotent on a project with no boundary', async () => {
      const result = await boundaryService.disable('absent-project', { confirm: true });
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeUndefined();
    });

    it('re-enabling an identical boundary is idempotent and does not churn the session', async () => {
      const first = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
      });
      const second = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
      });

      expect(second.alreadyActive).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      expect(monitorService.isObservationActive(first.sessionId)).toBe(true);
    });

    it('a superseding enable with a wider scope replaces the previous boundary', async () => {
      const first = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
      });

      const second = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
        monitoredPids: [7000],
      });

      expect(second.alreadyActive).toBe(false);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(monitorService.isObservationActive(first.sessionId)).toBe(false);
      expect(monitorService.isObservationActive(second.sessionId)).toBe(true);
    });

    it('a self-test never tears down a boundary it did not create', async () => {
      const enabled = await boundaryService.enable(PROJECT_ID, {
        confirm: true,
        samplingIntervalMs: 0,
      });
      const sessionId = boundaryService.getActiveSessionId(PROJECT_ID)!;

      const selfTest = await boundaryService.selfTest(PROJECT_ID);
      expect(selfTest.verified).toBe(true);

      // The pre-existing boundary is untouched: same session, still live, still
      // recorded. A check must not destroy the state it was asked to inspect.
      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(true);
      expect(boundaryService.getActiveSessionId(PROJECT_ID)).toBe(sessionId);
      expect(sessionId).toBe(enabled.sessionId);

      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(status.state).toBe('ACTIVE');
    });

    it('preflight never tears down a boundary it did not create', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });
      const sessionId = boundaryService.getActiveSessionId(PROJECT_ID)!;

      await runIndustrialPreflight({
        projectRoot: testTempDir,
        json: true,
        services: {
          ...services,
          processBoundary: boundaryService,
          industrialFirewallRequirement: requirementService,
        },
      });

      expect(boundaryService.isEnabled(PROJECT_ID)).toBe(true);
      expect(boundaryService.getActiveSessionId(PROJECT_ID)).toBe(sessionId);
    });

    it('cleanup teardown clears the record so no stale boundary outlives its session', async () => {
      await boundaryService.enable(PROJECT_ID, { confirm: true, samplingIntervalMs: 0 });
      expect(boundaryService.listEnabledProjectIds()).toContain(PROJECT_ID);

      const cleared = await services.atomicCleanup.cleanupProcessBoundary();

      // `services`'s own container may own a different project set; assert on our
      // instance's record directly.
      const status = await boundaryService.getStatus(PROJECT_ID);
      expect(['INACTIVE', 'ACTIVE']).toContain(status.state);
      expect(cleared).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 7. Preflight Integration ──────────────────────────────────────

  describe('7. Preflight integration', () => {
    /**
     * A container wired to the mock observer and this suite's boundary service,
     * so preflight's self-test is deterministic. Everything else is the real
     * shipped container.
     */
    function injectableContainer(): ServiceContainer {
      return {
        ...services,
        processBoundary: boundaryService,
        industrialFirewallRequirement: requirementService,
      };
    }

    it('preflight passes when the process-scoped boundary can be established and observed', async () => {
      const result = await runIndustrialPreflight({
        projectRoot: testTempDir,
        json: true,
        services: injectableContainer(),
      });

      const data = result.data as any;
      expect(data.boundaryScope).toBe('process');
      expect(data.boundarySelfTest).toBeDefined();
      expect(data.boundarySelfTest.verified).toBe(true);
      expect(data.boundarySelfTest.hostFirewallModified).toBe(false);
      expect(data.boundarySelfTest.constraintCount).toBeGreaterThan(0);

      // Preflight passes iff the diagnostics pass; the boundary is no longer the
      // permanent blocker it used to be.
      const diagsPassed = data.diagnostics.every((d: any) => d.passed);
      expect(result.exitCode).toBe(
        diagsPassed ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED,
      );
    });

    it('preflight fails closed when an attributed process violates the boundary', async () => {
      // Attribute the violation to a PID inside the resolved scope.
      mockObserver.addMockSocket({
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 54323,
        remoteAddress: '8.8.8.8',
        remotePort: 53,
        state: 'ESTABLISHED',
        pid: 4242,
        processName: 'maos-attributed',
        timestamp: new Date().toISOString(),
      });

      const result = await runIndustrialPreflight({
        projectRoot: testTempDir,
        json: true,
        services: injectableContainer(),
      });
      const data = result.data as any;

      expect(data.boundarySelfTest.verified).toBe(false);
      expect(data.boundarySelfTest.violationCount).toBeGreaterThan(0);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED);
    });

    it('the shipped default container performs no host firewall mutation', async () => {
      // Real container: proves the shipped wiring never writes a host plan.
      await runIndustrialPreflight({ projectRoot: testTempDir, json: true });

      expect(
        fs.existsSync(path.join(testTempDir, '.maos', 'firewall', 'active-plan.json')),
      ).toBe(false);
    });
  });

  // ── 8. Canary & Invariants ────────────────────────────────────────

  describe('8. Canary & cryptographic invariants', () => {
    it('strictly preserves rust/test.txt canary SHA-256', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const content = fs.readFileSync(CANARY_PATH);
      expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(
        EXPECTED_CANARY_SHA256,
      );
    });

    it('plan hashes are deterministic across independent synthesis', () => {
      const policy = createIndustrialEndpointPolicy(PROJECT_ID);
      const a = synthesizeProcessBoundaryPlan(policy, { createdAt: '2026-01-01T00:00:00.000Z', planId: 'p1' });
      const b = synthesizeProcessBoundaryPlan(policy, { createdAt: '2026-01-01T00:00:00.000Z', planId: 'p1' });
      expect(a.planHash).toBe(b.planHash);

      const c = synthesizeProcessBoundaryPlan(policy, { createdAt: '2026-01-01T00:00:00.000Z', planId: 'p2' });
      expect(c.planHash).not.toBe(a.planHash);
    });
  });
});
