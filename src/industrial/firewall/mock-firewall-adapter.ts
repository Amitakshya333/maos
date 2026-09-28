/**
 * F9-03: Mock Firewall Platform Adapter
 *
 * Controllable mock adapter for safe unit tests and deterministic failure simulation.
 * Guarantees zero side-effects on the host development machine while providing
 * 100% test coverage for success, partial failure, privilege denial, and rollback.
 */

import {
  FirewallAdapter,
  FirewallApplyOptions,
} from './firewall-adapter';
import {
  FirewallRulePlan,
  FirewallRule,
  FirewallSnapshot,
  FirewallStatusResult,
  FirewallApplyResult,
  FirewallRestoreResult,
  FirewallVerificationResult,
  computeCanonicalSnapshotHash,
  FirewallError,
  FIREWALL_ERROR_CODES,
} from '../../domain/firewall-policy';

export interface MockFirewallAdapterOptions {
  isElevated?: boolean;
  failSnapshot?: boolean;
  failApply?: boolean;
  partialApplyFailIndex?: number;
  failRestore?: boolean;
  failVerification?: boolean;
}

export class MockFirewallAdapter implements FirewallAdapter {
  public readonly platformName = 'mock';

  public isElevatedState: boolean;
  public failSnapshot: boolean;
  public failApply: boolean;
  public partialApplyFailIndex?: number;
  public failRestore: boolean;
  public failVerification: boolean;

  private installedRules: Map<string, FirewallRule> = new Map();
  private snapshotHistory: FirewallSnapshot[] = [];
  private activePlan?: FirewallRulePlan;

  constructor(options: MockFirewallAdapterOptions = {}) {
    this.isElevatedState = options.isElevated ?? true;
    this.failSnapshot = options.failSnapshot ?? false;
    this.failApply = options.failApply ?? false;
    this.partialApplyFailIndex = options.partialApplyFailIndex;
    this.failRestore = options.failRestore ?? false;
    this.failVerification = options.failVerification ?? false;
  }

  public async isElevated(): Promise<boolean> {
    return this.isElevatedState;
  }

  public async captureSnapshot(): Promise<FirewallSnapshot> {
    if (this.failSnapshot) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_SNAPSHOT_FAILED,
        'Simulated firewall snapshot capture failure.',
      );
    }

    const capturedRules = Array.from(this.installedRules.values());
    const draft: Omit<FirewallSnapshot, 'snapshotHash'> = {
      schemaVersion: 1,
      snapshotId: `snap_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      platform: 'mock',
      capturedAt: new Date().toISOString(),
      capturedRules,
      stateMetadata: {
        ruleCount: capturedRules.length,
        activePlanId: this.activePlan?.planId,
      },
    };

    const snapshotHash = computeCanonicalSnapshotHash(draft);
    const snapshot: FirewallSnapshot = Object.freeze({
      ...draft,
      snapshotHash,
    });

    this.snapshotHistory.push(snapshot);
    return snapshot;
  }

  public async inspectStatus(): Promise<FirewallStatusResult> {
    const isElevated = await this.isElevated();
    const activeRuleCount = this.installedRules.size;

    let state: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' = 'INACTIVE';
    if (activeRuleCount > 0 && this.activePlan) {
      state = 'ACTIVE';
    }

    return {
      state,
      platform: 'mock',
      isElevated,
      activeRuleCount,
      activePlanId: this.activePlan?.planId,
      activePolicyHash: this.activePlan?.policyHash,
      snapshotCount: this.snapshotHistory.length,
      restoreRequired: false,
      checkedAt: new Date().toISOString(),
      details: `Mock adapter running with ${activeRuleCount} active rule(s).`,
    };
  }

  public async applyRules(
    plan: FirewallRulePlan,
    _options: FirewallApplyOptions = {},
  ): Promise<FirewallApplyResult> {
    if (!this.isElevatedState) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED,
        'Cannot apply firewall rules: administrator/root privileges are required.',
      );
    }

    if (this.failApply) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        'Simulated total firewall rule application failure.',
      );
    }

    const snapshot = await this.captureSnapshot();

    let applied = 0;
    for (let i = 0; i < plan.rules.length; i++) {
      if (this.partialApplyFailIndex !== undefined && i >= this.partialApplyFailIndex) {
        throw new FirewallError(
          FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
          `Simulated partial rule failure at rule index ${i} (${plan.rules[i].ruleId}).`,
          { appliedCount: applied, failedRuleId: plan.rules[i].ruleId },
        );
      }

      const rule = plan.rules[i];
      this.installedRules.set(rule.ruleId, rule);
      applied++;
    }

    this.activePlan = plan;

    return {
      success: true,
      planId: plan.planId,
      rulesAppliedCount: applied,
      snapshotId: snapshot.snapshotId,
      verified: true,
      appliedAt: new Date().toISOString(),
      state: 'ACTIVE',
    };
  }

  public async restoreSnapshot(snapshot: FirewallSnapshot): Promise<FirewallRestoreResult> {
    if (this.failRestore) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_ROLLBACK_FAILED,
        'Simulated firewall rollback/restore failure.',
      );
    }

    this.installedRules.clear();
    for (const raw of snapshot.capturedRules) {
      const r = raw as FirewallRule;
      this.installedRules.set(r.ruleId, r);
    }

    this.activePlan = undefined;

    return {
      success: true,
      snapshotId: snapshot.snapshotId,
      rulesRestoredCount: snapshot.capturedRules.length,
      restoredAt: new Date().toISOString(),
      state: this.installedRules.size > 0 ? 'ACTIVE' : 'INACTIVE',
    };
  }

  public async verifyAppliedRules(plan: FirewallRulePlan): Promise<FirewallVerificationResult> {
    if (this.failVerification) {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: plan.rules.length,
        missingRules: plan.rules.map((r) => r.ruleId),
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }

    const missingRules: string[] = [];
    let matchingRules = 0;

    for (const rule of plan.rules) {
      if (this.installedRules.has(rule.ruleId)) {
        matchingRules++;
      } else {
        missingRules.push(rule.ruleId);
      }
    }

    const planRuleIds = new Set(plan.rules.map((r) => r.ruleId));
    const unexpectedRules: string[] = [];
    for (const ruleId of this.installedRules.keys()) {
      if (!planRuleIds.has(ruleId)) {
        unexpectedRules.push(ruleId);
      }
    }

    const verified = missingRules.length === 0 && unexpectedRules.length === 0;

    return {
      verified,
      matchingRules,
      expectedRules: plan.rules.length,
      missingRules,
      unexpectedRules,
      verifiedAt: new Date().toISOString(),
    };
  }

  public async clearAppliedRules(): Promise<void> {
    this.installedRules.clear();
    this.activePlan = undefined;
  }

  public getInstalledRuleCount(): number {
    return this.installedRules.size;
  }

  public getInstalledRules(): readonly FirewallRule[] {
    return Array.from(this.installedRules.values());
  }
}
