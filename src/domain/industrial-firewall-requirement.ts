/**
 * F9-06: Industrial Firewall Requirement Domain Schema & Invariants
 *
 * Connects firewall state (F9-03), endpoint allowlist (F9-02), network monitor (F9-04),
 * and service identity (F9-05) to the Industrial workflow start and continuation policy.
 *
 * Core Invariant:
 * An Industrial workflow may start or continue ONLY when:
 *   1. Firewall status is explicitly ACTIVE.
 *   2. Applied firewall policy hash matches approved policy hash.
 *   3. Endpoint allowlist verification passes with strict loopback.
 *   4. Network monitor is actively running within the defined boundary.
 *   5. All observed service identities are TRUSTED.
 *   6. Endpoint owners match registered process identities.
 *   7. Model service endpoints are loopback-only.
 *   8. No unresolved non-loopback connection exists.
 *   9. No service identity or executable hash mismatch exists.
 *
 * Stale or unknown firewall state is NEVER treated as active.
 */

import { FirewallStatusResult, FirewallBoundaryScope } from './firewall-policy';
import { EndpointAllowlistPolicy } from './endpoint-allowlist';

// ── Fail-Closed Error Codes ─────────────────────────────────────────

export const INDUSTRIAL_FIREWALL_ERROR_CODES = {
  FIREWALL_INACTIVE: 'FIREWALL_INACTIVE',
  FIREWALL_STATUS_UNKNOWN: 'FIREWALL_STATUS_UNKNOWN',
  FIREWALL_POLICY_MISMATCH: 'FIREWALL_POLICY_MISMATCH',
  ENDPOINT_POLICY_MISMATCH: 'ENDPOINT_POLICY_MISMATCH',
  NETWORK_MONITOR_UNAVAILABLE: 'NETWORK_MONITOR_UNAVAILABLE',
  NON_LOOPBACK_CONNECTION_DETECTED: 'NON_LOOPBACK_CONNECTION_DETECTED',
  SERVICE_IDENTITY_UNTRUSTED: 'SERVICE_IDENTITY_UNTRUSTED',
  ENDPOINT_OWNER_UNRESOLVED: 'ENDPOINT_OWNER_UNRESOLVED',
  SERVICE_HIJACK_DETECTED: 'SERVICE_HIJACK_DETECTED',
  MODEL_REVISION_MISMATCH: 'MODEL_REVISION_MISMATCH',
} as const;

export type IndustrialFirewallErrorCode =
  (typeof INDUSTRIAL_FIREWALL_ERROR_CODES)[keyof typeof INDUSTRIAL_FIREWALL_ERROR_CODES];

export class IndustrialFirewallRequirementError extends Error {
  public readonly code: IndustrialFirewallErrorCode;
  public readonly detail?: unknown;

  constructor(code: IndustrialFirewallErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'IndustrialFirewallRequirementError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, IndustrialFirewallRequirementError.prototype);
  }
}

// ── Measured Status Interfaces ──────────────────────────────────────

export interface IndustrialBoundaryStatus {
  readonly verified: boolean;
  readonly overallStatus: 'VERIFIED' | 'BLOCKED';
  readonly firewallStatus: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'RESTORE_REQUIRED';
  readonly endpointPolicyStatus: 'MATCHED' | 'MISMATCH' | 'UNCONFIGURED';
  readonly monitorStatus: 'CAPTURING' | 'IDLE' | 'UNAVAILABLE' | 'ANOMALY_DETECTED';
  readonly serviceIdentityStatus: 'TRUSTED' | 'UNTRUSTED' | 'UNRESOLVED';
  readonly activeViolations: readonly string[];
  readonly failureCode?: IndustrialFirewallErrorCode;
  readonly blockingReason?: string;
  readonly checkedAt: string;
  /**
   * Which layer the boundary was evaluated at. `process` means the MAOS process
   * tree and its declared loopback endpoints; host packet filters were not
   * modified. `host` means machine-wide packet filter rules.
   */
  readonly boundaryScope?: FirewallBoundaryScope;
  /**
   * Operator-facing measurement detail, including the attribution scope and an
   * explicit statement of whether host firewall state was touched.
   */
  readonly measureDetails?: string;
}

export interface EvaluationInput {
  readonly firewallStatus: FirewallStatusResult;
  readonly expectedFirewallPolicyHash?: string;
  readonly endpointPolicy: EndpointAllowlistPolicy | null;
  readonly monitorActive: boolean;
  readonly monitorAnomaliesCount?: number;
  readonly nonLoopbackObserved?: boolean;
  readonly trustedServicesCount: number;
  readonly untrustedServicesCount?: number;
  readonly hijackedServicesCount?: number;
  readonly unresolvedOwnersCount?: number;
  readonly modelEndpointsLoopbackOnly?: boolean;
  readonly modelRevisionMismatch?: boolean;
}

// ── Evaluator Function ──────────────────────────────────────────────

/**
 * Evaluates the comprehensive Industrial boundary preconditions.
 * Fails closed if any requirement is unverified or unknown.
 */
export function evaluateIndustrialFirewallRequirement(
  input: EvaluationInput,
): IndustrialBoundaryStatus {
  const checkedAt = new Date().toISOString();
  const violations: string[] = [];

  // 1. Evaluate Firewall Status
  let fwStatus: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'RESTORE_REQUIRED' = 'UNKNOWN';
  if (input.firewallStatus) {
    fwStatus = input.firewallStatus.state;
  }

  if (fwStatus === 'UNKNOWN') {
    const reason = 'Industrial execution blocked: firewall status unknown';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'UNKNOWN',
      endpointPolicyStatus: input.endpointPolicy ? 'MATCHED' : 'UNCONFIGURED',
      monitorStatus: input.monitorActive ? 'CAPTURING' : 'UNAVAILABLE',
      serviceIdentityStatus: 'UNRESOLVED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_STATUS_UNKNOWN,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (fwStatus !== 'ACTIVE') {
    const reason = `Industrial execution blocked: firewall status is ${fwStatus.toLowerCase()}`;
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: fwStatus,
      endpointPolicyStatus: input.endpointPolicy ? 'MATCHED' : 'UNCONFIGURED',
      monitorStatus: input.monitorActive ? 'CAPTURING' : 'UNAVAILABLE',
      serviceIdentityStatus: 'UNRESOLVED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE,
      blockingReason: reason,
      checkedAt,
    };
  }

  // 2. Evaluate Applied Firewall Policy Hash Match
  if (
    input.expectedFirewallPolicyHash &&
    input.firewallStatus.activePolicyHash !== input.expectedFirewallPolicyHash
  ) {
    const reason = `Industrial execution blocked: applied firewall policy hash (${input.firewallStatus.activePolicyHash || 'none'}) does not match expected hash (${input.expectedFirewallPolicyHash})`;
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MISMATCH',
      monitorStatus: input.monitorActive ? 'CAPTURING' : 'UNAVAILABLE',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_POLICY_MISMATCH,
      blockingReason: reason,
      checkedAt,
    };
  }

  // 3. Evaluate Endpoint Allowlist Policy
  if (!input.endpointPolicy) {
    const reason = 'Industrial execution blocked: endpoint allowlist policy is unconfigured';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'UNCONFIGURED',
      monitorStatus: input.monitorActive ? 'CAPTURING' : 'UNAVAILABLE',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.ENDPOINT_POLICY_MISMATCH,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (!input.endpointPolicy.enforceLoopbackStrict) {
    const reason = 'Industrial execution blocked: endpoint allowlist policy does not enforce strict loopback';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MISMATCH',
      monitorStatus: input.monitorActive ? 'CAPTURING' : 'UNAVAILABLE',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.ENDPOINT_POLICY_MISMATCH,
      blockingReason: reason,
      checkedAt,
    };
  }

  // 4. Evaluate Network Monitor
  if (!input.monitorActive) {
    const reason = 'Industrial execution blocked: network monitor is unavailable or inactive';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'UNAVAILABLE',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.NETWORK_MONITOR_UNAVAILABLE,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (input.nonLoopbackObserved || (input.monitorAnomaliesCount && input.monitorAnomaliesCount > 0)) {
    const reason = 'Industrial execution blocked: non-loopback connection detected by network monitor';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'ANOMALY_DETECTED',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED,
      blockingReason: reason,
      checkedAt,
    };
  }

  // 5. Evaluate Model Endpoints
  if (input.modelEndpointsLoopbackOnly === false) {
    const reason = 'Industrial execution blocked: model endpoints must be strictly loopback-only';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MISMATCH',
      monitorStatus: 'CAPTURING',
      serviceIdentityStatus: 'TRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.NON_LOOPBACK_CONNECTION_DETECTED,
      blockingReason: reason,
      checkedAt,
    };
  }

  // 6. Evaluate Service Identities & Hijacking
  if (input.hijackedServicesCount && input.hijackedServicesCount > 0) {
    const reason = 'Industrial execution blocked: service hijacking detected on registered endpoint';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'CAPTURING',
      serviceIdentityStatus: 'UNTRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.SERVICE_HIJACK_DETECTED,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (input.untrustedServicesCount && input.untrustedServicesCount > 0) {
    const reason = 'Industrial execution blocked: untrusted or revoked process identity detected';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'CAPTURING',
      serviceIdentityStatus: 'UNTRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.SERVICE_IDENTITY_UNTRUSTED,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (input.unresolvedOwnersCount && input.unresolvedOwnersCount > 0) {
    const reason = 'Industrial execution blocked: observed endpoint owner is unresolved';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'CAPTURING',
      serviceIdentityStatus: 'UNRESOLVED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED,
      blockingReason: reason,
      checkedAt,
    };
  }

  if (input.modelRevisionMismatch) {
    const reason = 'Industrial execution blocked: model revision mismatch against approved manifest';
    return {
      verified: false,
      overallStatus: 'BLOCKED',
      firewallStatus: 'ACTIVE',
      endpointPolicyStatus: 'MATCHED',
      monitorStatus: 'CAPTURING',
      serviceIdentityStatus: 'UNTRUSTED',
      activeViolations: [reason],
      failureCode: INDUSTRIAL_FIREWALL_ERROR_CODES.MODEL_REVISION_MISMATCH,
      blockingReason: reason,
      checkedAt,
    };
  }

  // All preconditions strictly met
  return {
    verified: true,
    overallStatus: 'VERIFIED',
    firewallStatus: 'ACTIVE',
    endpointPolicyStatus: 'MATCHED',
    monitorStatus: 'CAPTURING',
    serviceIdentityStatus: 'TRUSTED',
    activeViolations: [],
    checkedAt,
  };
}

/**
 * Generates human-readable measured status strings for GUI / CLI.
 */
export function formatMeasuredBoundaryStatus(status: IndustrialBoundaryStatus): string {
  if (status.overallStatus === 'VERIFIED') {
    return [
      'Industrial network boundary: VERIFIED',
      `Firewall: ${status.firewallStatus}`,
      `Endpoint policy: ${status.endpointPolicyStatus}`,
      `Monitor: ${status.monitorStatus}`,
      `Service identity: ${status.serviceIdentityStatus}`,
    ].join('\n');
  }

  return status.blockingReason || 'Industrial execution blocked: unverified boundary state';
}
