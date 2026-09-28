/**
 * F9-03: Windows Defender Firewall Adapter
 *
 * Implements firewall management for Windows using PowerShell NetSecurity cmdlets
 * (New-NetFirewallRule, Get-NetFirewallRule, Remove-NetFirewallRule).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
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

const execFileAsync = promisify(execFile);

export class WindowsFirewallAdapter implements FirewallAdapter {
  public readonly platformName = 'windows';

  /**
   * Checks whether the current process has Windows Administrator privileges.
   */
  public async isElevated(): Promise<boolean> {
    try {
      // 'net session' exits with 0 if running elevated as Administrator, non-zero otherwise
      await execFileAsync('net', ['session']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generates the concrete PowerShell script string corresponding to a rule plan.
   */
  public generatePowerShellScript(plan: FirewallRulePlan): string {
    const lines: string[] = [
      '# MAOS Industrial — Synthesized Windows Defender Firewall Boundary Script',
      `# Plan ID: ${plan.planId}`,
      `# Policy Hash: ${plan.policyHash}`,
      `# Generated At: ${plan.createdAt}`,
      '$ErrorActionPreference = "Stop"',
      '',
    ];

    for (const rule of plan.rules) {
      const displayName = `MAOS_${rule.ruleId}`;
      const dir = rule.direction === 'inbound' ? 'Inbound' : 'Outbound';
      const action = rule.action === 'allow' ? 'Allow' : 'Block';
      const protocol = rule.protocol === 'tcp' ? 'TCP' : rule.protocol === 'udp' ? 'UDP' : 'Any';

      let cmd = `New-NetFirewallRule -Name "${displayName}" -DisplayName "${rule.name}" -Direction ${dir} -Action ${action} -Protocol ${protocol}`;

      if (rule.localAddresses && rule.localAddresses.length > 0) {
        cmd += ` -LocalAddress "${rule.localAddresses.join(',')}"`;
      }
      if (rule.remoteAddresses && rule.remoteAddresses.length > 0) {
        cmd += ` -RemoteAddress "${rule.remoteAddresses.join(',')}"`;
      }
      if (rule.localPorts && rule.localPorts.length > 0) {
        cmd += ` -LocalPort "${rule.localPorts.join(',')}"`;
      }
      if (rule.remotePorts && rule.remotePorts.length > 0) {
        cmd += ` -RemotePort "${rule.remotePorts.join(',')}"`;
      }
      if (rule.programPath) {
        cmd += ` -Program "${rule.programPath}"`;
      }

      cmd += ` -Description "${rule.description.replace(/"/g, '`"')}"`;
      lines.push(cmd);
    }

    return lines.join('\n');
  }

  public async captureSnapshot(): Promise<FirewallSnapshot> {
    const isElevated = await this.isElevated();
    let capturedRules: unknown[] = [];

    if (isElevated) {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          'Get-NetFirewallRule -Name "MAOS_*" -ErrorAction SilentlyContinue | Select-Object -Property Name, DisplayName, Direction, Action, Enabled | ConvertTo-Json',
        ]);
        if (stdout.trim()) {
          const parsed = JSON.parse(stdout);
          capturedRules = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch {
        // Fall through to empty captured rules
      }
    }

    const draft: Omit<FirewallSnapshot, 'snapshotHash'> = {
      schemaVersion: 1,
      snapshotId: `snap_win_${Date.now()}`,
      platform: 'windows',
      capturedAt: new Date().toISOString(),
      capturedRules,
      stateMetadata: {
        isElevated,
        ruleCount: capturedRules.length,
      },
    };

    const snapshotHash = computeCanonicalSnapshotHash(draft);
    return Object.freeze({
      ...draft,
      snapshotHash,
    });
  }

  public async inspectStatus(): Promise<FirewallStatusResult> {
    const isElevated = await this.isElevated();
    let activeRuleCount = 0;

    if (isElevated) {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          '(Get-NetFirewallRule -Name "MAOS_*" -ErrorAction SilentlyContinue).Count',
        ]);
        activeRuleCount = parseInt(stdout.trim(), 10) || 0;
      } catch {
        activeRuleCount = 0;
      }
    }

    const state = activeRuleCount > 0 ? 'ACTIVE' : 'INACTIVE';

    return {
      state,
      platform: 'windows',
      isElevated,
      activeRuleCount,
      snapshotCount: 0,
      restoreRequired: false,
      checkedAt: new Date().toISOString(),
      details: isElevated
        ? `Windows Defender Firewall: ${activeRuleCount} active MAOS rule(s).`
        : 'Windows Defender Firewall: running unelevated (read-only inspection).',
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
        'Cannot apply Windows Defender Firewall rules: Administrator privileges required.',
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

    const script = this.generatePowerShellScript(plan);

    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]);
    } catch (err: any) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        `Windows firewall rule application failed: ${err.message}`,
        { error: err.message },
      );
    }

    const verify = await this.verifyAppliedRules(plan);
    if (!verify.verified) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_STATE_MISMATCH,
        `Applied firewall rules do not match plan: missing [${verify.missingRules.join(', ')}].`,
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
        'Cannot restore Windows Defender Firewall snapshot: Administrator privileges required.',
      );
    }

    try {
      await this.clearAppliedRules();
    } catch (err: any) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_ROLLBACK_FAILED,
        `Failed to clear MAOS firewall rules during restore: ${err.message}`,
      );
    }

    return {
      success: true,
      snapshotId: snapshot.snapshotId,
      rulesRestoredCount: snapshot.capturedRules.length,
      restoredAt: new Date().toISOString(),
      state: 'INACTIVE',
    };
  }

  public async verifyAppliedRules(plan: FirewallRulePlan): Promise<FirewallVerificationResult> {
    const isElevated = await this.isElevated();
    if (!isElevated) {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: plan.rules.length,
        missingRules: plan.rules.map((r) => r.ruleId),
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        '(Get-NetFirewallRule -Name "MAOS_*" -ErrorAction SilentlyContinue).Name',
      ]);
      const installedNames = new Set(
        stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );

      const missingRules: string[] = [];
      let matching = 0;

      for (const rule of plan.rules) {
        const expectedName = `MAOS_${rule.ruleId}`;
        if (installedNames.has(expectedName)) {
          matching++;
        } else {
          missingRules.push(rule.ruleId);
        }
      }

      return {
        verified: missingRules.length === 0,
        matchingRules: matching,
        expectedRules: plan.rules.length,
        missingRules,
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    } catch {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: plan.rules.length,
        missingRules: plan.rules.map((r) => r.ruleId),
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }
  }

  public async clearAppliedRules(): Promise<void> {
    const isElevated = await this.isElevated();
    if (!isElevated) return;

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Remove-NetFirewallRule -Name "MAOS_*" -ErrorAction SilentlyContinue',
    ]);
  }
}
