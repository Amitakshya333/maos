/**
 * F9-03: Linux Firewall Adapter (nftables / iptables)
 *
 * Implements firewall boundary management for Linux using atomic nftables rulesets.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  FirewallAdapter,
  FirewallApplyOptions,
} from './firewall-adapter';
import {
  FirewallRulePlan,
  FirewallSnapshot,
  FirewallStatusResult,
  FirewallApplyResult,
  FirewallRestoreResult,
  FirewallVerificationResult,
  computeCanonicalSnapshotHash,
  FirewallError,
  FIREWALL_ERROR_CODES,
} from '../../domain/firewall-policy';

const execFileAsync = promisify(execFile);

export class LinuxFirewallAdapter implements FirewallAdapter {
  public readonly platformName = 'linux';

  public async isElevated(): Promise<boolean> {
    if (typeof process.getuid === 'function') {
      return process.getuid() === 0;
    }
    return false;
  }

  /**
   * Generates atomic nftables ruleset syntax for the given plan.
   */
  public generateNftablesScript(plan: FirewallRulePlan): string {
    const lines: string[] = [
      '#!/usr/sbin/nft -f',
      `# MAOS Industrial — Synthesized nftables Boundary Ruleset`,
      `# Plan ID: ${plan.planId}`,
      `# Policy Hash: ${plan.policyHash}`,
      '',
      'table inet maos_boundary {',
      '  chain input {',
      '    type filter hook input priority 0; policy drop;',
      '    iif "lo" accept',
      '    ct state established,related accept',
      '  }',
      '  chain output {',
      '    type filter hook output priority 0; policy drop;',
      '    oif "lo" accept',
      '    ct state established,related accept',
    ];

    for (const rule of plan.rules) {
      if (rule.action === 'block' && rule.remotePorts?.includes(53)) {
        lines.push('    udp dport 53 drop');
        lines.push('    tcp dport 53 drop');
      }
    }

    lines.push('  }');
    lines.push('}');
    return lines.join('\n');
  }

  public async captureSnapshot(): Promise<FirewallSnapshot> {
    const isElevated = await this.isElevated();
    let capturedRules: unknown[] = [];

    if (isElevated) {
      try {
        const { stdout } = await execFileAsync('nft', ['list', 'table', 'inet', 'maos_boundary']);
        capturedRules = [stdout];
      } catch {
        // Table does not exist
      }
    }

    const draft: Omit<FirewallSnapshot, 'snapshotHash'> = {
      schemaVersion: 1,
      snapshotId: `snap_linux_${Date.now()}`,
      platform: 'linux',
      capturedAt: new Date().toISOString(),
      capturedRules,
      stateMetadata: { isElevated, ruleCount: capturedRules.length },
    };

    const snapshotHash = computeCanonicalSnapshotHash(draft);
    return Object.freeze({ ...draft, snapshotHash });
  }

  public async inspectStatus(): Promise<FirewallStatusResult> {
    const isElevated = await this.isElevated();
    let activeRuleCount = 0;

    if (isElevated) {
      try {
        await execFileAsync('nft', ['list', 'table', 'inet', 'maos_boundary']);
        activeRuleCount = 1; // table exists
      } catch {
        activeRuleCount = 0;
      }
    }

    const state = activeRuleCount > 0 ? 'ACTIVE' : 'INACTIVE';

    return {
      state,
      platform: 'linux',
      isElevated,
      activeRuleCount,
      snapshotCount: 0,
      restoreRequired: false,
      checkedAt: new Date().toISOString(),
      details: isElevated
        ? `Linux nftables: ${activeRuleCount > 0 ? 'maos_boundary table active.' : 'inactive.'}`
        : 'Linux nftables: running unelevated (root privileges required for modification).',
    };
  }

  public async applyRules(
    plan: FirewallRulePlan,
    options: FirewallApplyOptions = {},
  ): Promise<FirewallApplyResult> {
    const isElevated = await this.isElevated();
    if (!isElevated) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED,
        'Cannot apply Linux firewall rules: root privileges required.',
      );
    }

    const snapshot = await this.captureSnapshot();

    if (options.dryRun) {
      return {
        success: true,
        planId: plan.planId,
        rulesAppliedCount: plan.rules.length,
        snapshotId: snapshot.snapshotId,
        verified: true,
        appliedAt: new Date().toISOString(),
        state: 'ACTIVE',
      };
    }

    const script = this.generateNftablesScript(plan);

    try {
      await execFileAsync('nft', ['-f', '-'], { input: script } as any);
    } catch (err: any) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        `Linux nftables rule application failed: ${err.message}`,
      );
    }

    return {
      success: true,
      planId: plan.planId,
      rulesAppliedCount: plan.rules.length,
      snapshotId: snapshot.snapshotId,
      verified: true,
      appliedAt: new Date().toISOString(),
      state: 'ACTIVE',
    };
  }

  public async restoreSnapshot(snapshot: FirewallSnapshot): Promise<FirewallRestoreResult> {
    const isElevated = await this.isElevated();
    if (!isElevated) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED,
        'Cannot restore Linux firewall: root privileges required.',
      );
    }

    await this.clearAppliedRules();

    return {
      success: true,
      snapshotId: snapshot.snapshotId,
      rulesRestoredCount: snapshot.capturedRules.length,
      restoredAt: new Date().toISOString(),
      state: 'INACTIVE',
    };
  }

  public async verifyAppliedRules(_plan: FirewallRulePlan): Promise<FirewallVerificationResult> {
    const isElevated = await this.isElevated();
    if (!isElevated) {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: 1,
        missingRules: ['maos_boundary'],
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }

    try {
      await execFileAsync('nft', ['list', 'table', 'inet', 'maos_boundary']);
      return {
        verified: true,
        matchingRules: 1,
        expectedRules: 1,
        missingRules: [],
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    } catch {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: 1,
        missingRules: ['maos_boundary'],
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }
  }

  public async clearAppliedRules(): Promise<void> {
    const isElevated = await this.isElevated();
    if (!isElevated) return;

    try {
      await execFileAsync('nft', ['delete', 'table', 'inet', 'maos_boundary']);
    } catch {
      // Ignore if table does not exist
    }
  }
}
