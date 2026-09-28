/**
 * MAOS Industrial — F9-03: Firewall Boundary Enforcement Test Suite
 *
 * Verifies host firewall boundary enforcement, safe application, status fidelity,
 * automated rollback, and crash recovery:
 * 1. Platform firewall abstraction (Windows, Linux, Mock)
 * 2. Deterministic rule synthesis from sealed F9-02 EndpointAllowlistPolicy
 * 3. Safe apply flow requiring operator confirmation, elevation, and pre-change snapshot
 * 4. Automated rollback on partial rule failure or post-apply verification mismatch
 * 5. Fail-closed RESTORE_REQUIRED on unrecoverable or interrupted states
 * 6. Crash recovery on service startup
 * 7. Clean state restoration without lingering rules
 * 8. Privacy-safe audit trail
 * 9. Invariants & cryptographic integrity (rust/test.txt canary)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  FirewallService,
} from '../../src/service';
import {
  FIREWALL_ERROR_CODES,
  FirewallError,
  synthesizeFirewallPlan,
  computeCanonicalFirewallPlanHash,
  computeCanonicalSnapshotHash,
} from '../../src/domain/firewall-policy';
import {
  createIndustrialEndpointPolicy,
} from '../../src/domain/endpoint-allowlist';
import {
  MockFirewallAdapter,
  WindowsFirewallAdapter,
  LinuxFirewallAdapter,
} from '../../src/industrial/firewall';

describe('F9-03: Firewall Boundary Enforcement', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f903-' + Date.now(),
  );

  let services: ServiceContainer;

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
    services = createServiceContainer(testTempDir);
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

  // ── 1. Platform Firewall Abstraction ──────────────────────────────

  describe('1. Platform Firewall Abstraction', () => {
    it('Windows adapter generates valid PowerShell NetSecurity cmdlets', () => {
      const endpointPolicy = createIndustrialEndpointPolicy('proj-win-test');
      const plan = synthesizeFirewallPlan(endpointPolicy, 'windows');
      const winAdapter = new WindowsFirewallAdapter();

      const psScript = winAdapter.generatePowerShellScript(plan);

      expect(psScript).toContain('New-NetFirewallRule');
      expect(psScript).toContain('MAOS_maos_fw_default_inbound_block');
      expect(psScript).toContain('MAOS_maos_fw_default_outbound_block');
      expect(psScript).toContain('MAOS_maos_fw_loopback_inbound_allow');
      expect(psScript).toContain('MAOS_maos_fw_loopback_outbound_allow');
      expect(psScript).toContain('-LocalAddress "127.0.0.1,::1"');
      expect(psScript).toContain('-RemotePort "53,5353"');
    });

    it('Linux adapter generates valid atomic nftables table and chain syntax', () => {
      const endpointPolicy = createIndustrialEndpointPolicy('proj-linux-test');
      const plan = synthesizeFirewallPlan(endpointPolicy, 'linux');
      const linuxAdapter = new LinuxFirewallAdapter();

      const nftScript = linuxAdapter.generateNftablesScript(plan);

      expect(nftScript).toContain('table inet maos_boundary');
      expect(nftScript).toContain('chain input');
      expect(nftScript).toContain('chain output');
      expect(nftScript).toContain('policy drop');
      expect(nftScript).toContain('iif "lo" accept');
      expect(nftScript).toContain('oif "lo" accept');
      expect(nftScript).toContain('udp dport 53 drop');
    });

    it('Mock adapter provides controllable in-memory simulation', async () => {
      const mock = new MockFirewallAdapter();
      expect(await mock.isElevated()).toBe(true);
      expect((await mock.inspectStatus()).state).toBe('INACTIVE');
    });
  });

  // ── 2. Rule Synthesis from Sealed Policy ───────────────────────────

  describe('2. Rule Synthesis from Sealed Policy', () => {
    it('synthesizes deterministic plan from valid EndpointAllowlistPolicy', () => {
      const endpointPolicy = createIndustrialEndpointPolicy('proj-synth-test');
      const plan = synthesizeFirewallPlan(endpointPolicy, 'mock');

      expect(plan.schemaVersion).toBe(1);
      expect(plan.policyId).toBe(endpointPolicy.policyId);
      expect(plan.policyHash).toBe(endpointPolicy.policyHash);
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify baseline default blocks
      const ruleIds = plan.rules.map((r) => r.ruleId);
      expect(ruleIds).toContain('maos_fw_default_inbound_block');
      expect(ruleIds).toContain('maos_fw_default_outbound_block');
      expect(ruleIds).toContain('maos_fw_loopback_inbound_allow');
      expect(ruleIds).toContain('maos_fw_loopback_outbound_allow');
      expect(ruleIds).toContain('maos_fw_dns_outbound_block');

      // Verify declared ports
      const bindRule = plan.rules.find((r) => r.ruleId === 'maos_fw_declared_bind_ports_allow');
      expect(bindRule).toBeDefined();
      expect(bindRule?.localPorts).toContain(3847);

      const connectRule = plan.rules.find(
        (r) => r.ruleId === 'maos_fw_declared_connect_ports_allow',
      );
      expect(connectRule).toBeDefined();
      expect(connectRule?.remotePorts).toContain(8000);
      expect(connectRule?.remotePorts).toContain(11434);
    });

    it('rejects synthesis if endpoint policy hash is tampered', () => {
      const endpointPolicy = createIndustrialEndpointPolicy('proj-tamper-policy');
      const tamperedPolicy = {
        ...endpointPolicy,
        policyHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      expect(() => synthesizeFirewallPlan(tamperedPolicy, 'mock')).toThrow(FirewallError);
      try {
        synthesizeFirewallPlan(tamperedPolicy, 'mock');
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED);
      }
    });

    it('rejects synthesis if endpoint policy contains non-loopback endpoints', () => {
      const endpointPolicy = createIndustrialEndpointPolicy('proj-bad-ep');
      const badPolicy = {
        ...endpointPolicy,
        declaredEndpoints: [
          ...endpointPolicy.declaredEndpoints,
          {
            endpointId: 'ep_bad_external',
            protocol: 'tcp' as const,
            direction: 'connect' as const,
            host: '8.8.8.8',
            port: 53,
            isLoopbackOnly: false,
            description: 'Illegal external endpoint',
          },
        ],
      };

      expect(() => synthesizeFirewallPlan(badPolicy, 'mock')).toThrow(FirewallError);
    });
  });

  // ── 3. Safe Application Flow ──────────────────────────────────────

  describe('3. Safe Application Flow & Pre-Change Snapshot', () => {
    it('fails closed when operator confirmation is missing (confirm: false)', async () => {
      const mockAdapter = new MockFirewallAdapter();
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');

      await expect(
        fwService.applyPlan(plan, { confirm: false }),
      ).rejects.toThrow(FirewallError);

      try {
        await fwService.applyPlan(plan, { confirm: false });
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED);
      }

      // Live state remains INACTIVE
      const status = await fwService.getStatus();
      expect(status.state).toBe('INACTIVE');
    });

    it('fails closed when administrator/root privileges are unavailable', async () => {
      const unprivilegedAdapter = new MockFirewallAdapter({ isElevated: false });
      const fwService = new FirewallService(testTempDir, {
        adapter: unprivilegedAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');

      await expect(
        fwService.applyPlan(plan, { confirm: true }),
      ).rejects.toThrow(FirewallError);

      try {
        await fwService.applyPlan(plan, { confirm: true });
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED);
      }
    });

    it('captures pre-change snapshot and successfully applies plan', async () => {
      const mockAdapter = new MockFirewallAdapter();
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');
      const result = await fwService.applyPlan(plan, { confirm: true });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.rulesAppliedCount).toBe(plan.rules.length);
      expect(result.snapshotId).toBeDefined();

      // Snapshot saved to disk
      const snapshots = fwService.listSnapshots();
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(snapshots).toContain(result.snapshotId);

      // Status is now ACTIVE
      const status = await fwService.getStatus();
      expect(status.state).toBe('ACTIVE');
      expect(status.activeRuleCount).toBe(plan.rules.length);
      expect(status.activePlanId).toBe(plan.planId);
    });
  });

  // ── 4. Automated Rollback on Partial Rule Failure ──────────────────

  describe('4. Automated Rollback on Partial Rule Failure', () => {
    it('atomically rolls back to snapshot when partial rule application fails', async () => {
      // Configure mock adapter to fail on rule index 3
      const mockAdapter = new MockFirewallAdapter({
        partialApplyFailIndex: 3,
      });
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');

      await expect(
        fwService.applyPlan(plan, { confirm: true }),
      ).rejects.toThrow(FirewallError);

      try {
        await fwService.applyPlan(plan, { confirm: true });
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED);
      }

      // Rollback occurred: live rules are cleaned up and status is INACTIVE
      expect(mockAdapter.getInstalledRuleCount()).toBe(0);
      const status = await fwService.getStatus();
      expect(status.state).toBe('INACTIVE');
      expect(status.restoreRequired).toBe(false);
    });

    it('rolls back when post-apply verification detects missing rules', async () => {
      // Mock verification failure
      const mockAdapter = new MockFirewallAdapter({
        failVerification: true,
      });
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');

      await expect(
        fwService.applyPlan(plan, { confirm: true }),
      ).rejects.toThrow(FirewallError);

      try {
        await fwService.applyPlan(plan, { confirm: true });
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_STATE_MISMATCH);
      }

      expect(mockAdapter.getInstalledRuleCount()).toBe(0);
      const status = await fwService.getStatus();
      expect(status.state).toBe('INACTIVE');
    });

    it('fails closed with RESTORE_REQUIRED if rollback itself fails', async () => {
      const mockAdapter = new MockFirewallAdapter({
        failApply: true,
        failRestore: true, // Rollback also fails!
      });
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');

      await expect(
        fwService.applyPlan(plan, { confirm: true }),
      ).rejects.toThrow(FirewallError);

      try {
        await fwService.applyPlan(plan, { confirm: true });
      } catch (err: any) {
        expect(err.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_ROLLBACK_FAILED);
      }

      // State is marked RESTORE_REQUIRED
      const status = await fwService.getStatus();
      expect(status.state).toBe('RESTORE_REQUIRED');
      expect(status.restoreRequired).toBe(true);
    });
  });

  // ── 5. Crash Recovery on Service Startup ───────────────────────────

  describe('5. Crash Recovery on Service Startup', () => {
    it('detects uncommitted/interrupted transaction on startup and sets RESTORE_REQUIRED', () => {
      const stateFile = path.join(testTempDir, '.maos', 'firewall', 'state.json');
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          status: 'ACTIVE',
          interrupted: true, // Process crashed mid-transaction!
          activePlanId: 'crashed_plan',
          lastUpdatedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      // Instantiate new service to simulate restart
      const fwService = new FirewallService(testTempDir, {
        adapter: new MockFirewallAdapter(),
        endpointAllowlist: services.endpointAllowlist,
      });

      const stored = (fwService as any).readState();
      expect(stored.status).toBe('RESTORE_REQUIRED');
    });

    it('restorePreviousState recovers from interrupted state to clean INACTIVE', async () => {
      const mockAdapter = new MockFirewallAdapter();
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      // Capture a snapshot first
      const snapshot = await mockAdapter.captureSnapshot();
      const snapshotPath = path.join(
        testTempDir,
        '.maos',
        'firewall',
        'snapshots',
        `${snapshot.snapshotId}.json`,
      );
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

      // Call restore
      const restoreRes = await fwService.restorePreviousState(snapshot.snapshotId);
      expect(restoreRes.success).toBe(true);
      expect(restoreRes.state).toBe('INACTIVE');

      const status = await fwService.getStatus();
      expect(status.state).toBe('INACTIVE');
      expect(status.restoreRequired).toBe(false);
    });
  });

  // ── 6. Measured Status Fidelity ───────────────────────────────────

  describe('6. Measured Status Fidelity', () => {
    it('never reports ACTIVE based only on a plan file if live adapter reports 0 rules', async () => {
      const mockAdapter = new MockFirewallAdapter();
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        endpointAllowlist: services.endpointAllowlist,
      });

      // Apply rules successfully
      const plan = fwService.synthesizePlan('default');
      await fwService.applyPlan(plan, { confirm: true });

      // Verify ACTIVE
      expect((await fwService.getStatus()).state).toBe('ACTIVE');

      // Simulate external flush / removal of rules directly on host
      await mockAdapter.clearAppliedRules();

      // Service must NOT falsely claim ACTIVE! It must detect mismatch and report RESTORE_REQUIRED or INACTIVE!
      const status = await fwService.getStatus();
      expect(status.state).not.toBe('ACTIVE');
    });
  });

  // ── 7. Privacy-Safe Audit Trail ───────────────────────────────────

  describe('7. Privacy-Safe Audit Trail', () => {
    it('records firewall lifecycle events with category endpoint', async () => {
      const audit = services.audit;
      const initialCount = audit.getRecords().length;

      const mockAdapter = new MockFirewallAdapter();
      const fwService = new FirewallService(testTempDir, {
        adapter: mockAdapter,
        auditService: audit,
        endpointAllowlist: services.endpointAllowlist,
      });

      const plan = fwService.synthesizePlan('default');
      const applyRes = await fwService.applyPlan(plan, { confirm: true });
      await fwService.restorePreviousState(applyRes.snapshotId);

      const records = audit.getRecords().slice(initialCount);
      const fwRecords = records.filter((r) => r.source === 'firewall-service');

      expect(fwRecords.length).toBeGreaterThanOrEqual(2);
      expect(
        fwRecords.some((r) => (r.data as any)?.event === 'FIREWALL_RULES_APPLIED'),
      ).toBe(true);
      expect(
        fwRecords.some((r) => (r.data as any)?.event === 'FIREWALL_RULES_RESTORED'),
      ).toBe(true);

      for (const r of fwRecords) {
        expect(r.category).toBe('endpoint');
      }

      // Verify audit chain integrity
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);
    });
  });

  // ── 8. Invariants & Cryptographic Integrity ───────────────────────

  describe('8. Invariants & Cryptographic Integrity', () => {
    it('verifies rust/test.txt canary SHA-256 is strictly preserved', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const computedHash = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(computedHash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
