/**
 * F9-03: Firewall Platform Adapter Interface
 *
 * Defines the contract for platform-specific host firewall operations:
 * Windows Defender / PowerShell, Linux nftables/iptables, and Mock adapter.
 */

import {
  FirewallRulePlan,
  FirewallSnapshot,
  FirewallStatusResult,
  FirewallApplyResult,
  FirewallRestoreResult,
  FirewallVerificationResult,
  FirewallPlatform,
} from '../../domain/firewall-policy';

export interface FirewallApplyOptions {
  readonly dryRun?: boolean;
}

export interface FirewallAdapter {
  readonly platformName: FirewallPlatform;

  /**
   * Checks whether the current runtime process has administrator / root privileges.
   */
  isElevated(): Promise<boolean>;

  /**
   * Captures a durable pre-change snapshot of the host firewall state.
   */
  captureSnapshot(): Promise<FirewallSnapshot>;

  /**
   * Inspects live host firewall status and returns measured state.
   */
  inspectStatus(): Promise<FirewallStatusResult>;

  /**
   * Applies the synthesized rule plan to the host firewall.
   */
  applyRules(plan: FirewallRulePlan, options?: FirewallApplyOptions): Promise<FirewallApplyResult>;

  /**
   * Restores a previously captured firewall snapshot.
   */
  restoreSnapshot(snapshot: FirewallSnapshot): Promise<FirewallRestoreResult>;

  /**
   * Verifies that live host rules match the requested rule plan.
   */
  verifyAppliedRules(plan: FirewallRulePlan): Promise<FirewallVerificationResult>;

  /**
   * Cleans up all MAOS-installed rules from the host firewall.
   */
  clearAppliedRules(): Promise<void>;
}
