/**
 * F9-03: Firewall Boundary Enforcement Domain Schema & Invariants
 *
 * Defines the platform-agnostic firewall policy, rule synthesis from sealed
 * F9-02 EndpointAllowlistPolicy, pre-change snapshot schemas, and fail-closed
 * error hierarchies.
 *
 * Invariant:
 * Firewall rules MUST be synthesized deterministically from the sealed
 * EndpointAllowlistPolicy. No arbitrary or user-defined network rules are accepted.
 * Rules must strictly isolate the monitored boundary to loopback only.
 */

import * as crypto from 'crypto';
import {
  EndpointAllowlistPolicy,
  computeCanonicalPolicyHash,
} from './endpoint-allowlist';

// ── Types & Enums ───────────────────────────────────────────────────

export type FirewallStatusState =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'UNKNOWN'
  | 'RESTORE_REQUIRED';

export type FirewallRuleDirection = 'inbound' | 'outbound';
export type FirewallRuleAction = 'allow' | 'block';
export type FirewallRuleProtocol = 'tcp' | 'udp' | 'any';
/**
 * `windows` | `linux` are HOST packet-filter platforms: applying a plan on them
 * mutates machine-wide firewall state and requires administrator/root.
 * `process` is a PROCESS-SCOPED boundary: it constrains the MAOS process tree and
 * its declared loopback endpoints without touching host packet filters, and
 * requires no elevation. `mock` is test-only.
 */
export type FirewallPlatform = 'windows' | 'linux' | 'mock' | 'process';

/**
 * Which layer the Industrial sovereignty boundary is enforced at.
 *
 * - `process` — the MAOS process tree and its declared loopback endpoints are
 *   constrained and passively observed. Host packet filters are NOT modified.
 *   This is the default for the offline/local Industrial MVP.
 * - `host` — machine-wide packet filter rules are synthesized, applied, and
 *   restored. Requires explicit elevation and operator confirmation, and is
 *   never enabled implicitly.
 */
export type FirewallBoundaryScope = 'process' | 'host';

export interface FirewallRule {
  readonly ruleId: string;
  readonly name: string;
  readonly direction: FirewallRuleDirection;
  readonly action: FirewallRuleAction;
  readonly protocol: FirewallRuleProtocol;
  readonly localAddresses: readonly string[];
  readonly remoteAddresses: readonly string[];
  readonly localPorts?: readonly number[];
  readonly remotePorts?: readonly number[];
  readonly programPath?: string;
  readonly description: string;
}

export interface FirewallRulePlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly policyId: string;
  readonly policyHash: string;
  readonly platform: FirewallPlatform;
  readonly rules: readonly FirewallRule[];
  readonly defaultInboundAction: 'block';
  readonly defaultOutboundAction: 'block';
  readonly createdAt: string;
  readonly planHash?: string;
}

export interface FirewallSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly platform: FirewallPlatform;
  readonly capturedAt: string;
  readonly capturedRules: readonly unknown[];
  readonly stateMetadata: Record<string, unknown>;
  readonly snapshotHash?: string;
}

export interface FirewallStatusResult {
  readonly state: FirewallStatusState;
  readonly platform: FirewallPlatform;
  readonly isElevated: boolean;
  readonly activeRuleCount: number;
  readonly activePlanId?: string;
  readonly activePolicyHash?: string;
  readonly snapshotCount: number;
  readonly restoreRequired: boolean;
  readonly checkedAt: string;
  readonly details?: string;
  /** Which layer the boundary is enforced at. Absent is treated as `host`. */
  readonly boundaryScope?: FirewallBoundaryScope;
  /**
   * True only when this status reflects host packet-filter mutation.
   * Guarded so no code path can claim a process-scoped boundary changed host state.
   */
  readonly hostFirewallModified?: boolean;
}

export interface FirewallApplyResult {
  readonly success: boolean;
  readonly planId: string;
  readonly rulesAppliedCount: number;
  readonly snapshotId: string;
  readonly verified: boolean;
  readonly appliedAt: string;
  readonly state: FirewallStatusState;
}

export interface FirewallRestoreResult {
  readonly success: boolean;
  readonly snapshotId: string;
  readonly rulesRestoredCount: number;
  readonly restoredAt: string;
  readonly state: FirewallStatusState;
}

export interface FirewallVerificationResult {
  readonly verified: boolean;
  readonly matchingRules: number;
  readonly expectedRules: number;
  readonly missingRules: readonly string[];
  readonly unexpectedRules: readonly string[];
  readonly verifiedAt: string;
}

// ── Error Codes & Hierarchy ─────────────────────────────────────────

export const FIREWALL_ERROR_CODES = {
  FIREWALL_PRIVILEGE_REQUIRED: 'FIREWALL_PRIVILEGE_REQUIRED',
  FIREWALL_POLICY_TAMPERED: 'FIREWALL_POLICY_TAMPERED',
  FIREWALL_PLATFORM_UNSUPPORTED: 'FIREWALL_PLATFORM_UNSUPPORTED',
  FIREWALL_SNAPSHOT_FAILED: 'FIREWALL_SNAPSHOT_FAILED',
  FIREWALL_APPLY_FAILED: 'FIREWALL_APPLY_FAILED',
  FIREWALL_STATE_MISMATCH: 'FIREWALL_STATE_MISMATCH',
  FIREWALL_ROLLBACK_FAILED: 'FIREWALL_ROLLBACK_FAILED',
  FIREWALL_RESTORE_REQUIRED: 'FIREWALL_RESTORE_REQUIRED',
  FIREWALL_CONFIRMATION_REQUIRED: 'FIREWALL_CONFIRMATION_REQUIRED',
} as const;

export type FirewallErrorCode =
  (typeof FIREWALL_ERROR_CODES)[keyof typeof FIREWALL_ERROR_CODES];

export class FirewallError extends Error {
  public readonly code: FirewallErrorCode;
  public readonly detail?: unknown;

  constructor(code: FirewallErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'FirewallError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, FirewallError.prototype);
  }
}

// ── Canonical Hashing ───────────────────────────────────────────────

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sortedKeys) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
    }
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Computes canonical SHA-256 hash of a FirewallRulePlan.
 * Excludes `planHash` itself.
 */
export function computeCanonicalFirewallPlanHash(
  plan: Omit<FirewallRulePlan, 'planHash'> | FirewallRulePlan,
): string {
  const { planHash: _omitted, ...canonicalPayload } = plan as FirewallRulePlan;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}


/**
 * Computes canonical SHA-256 hash of a FirewallSnapshot.
 * Excludes `snapshotHash` itself.
 */
export function computeCanonicalSnapshotHash(
  snapshot: Omit<FirewallSnapshot, 'snapshotHash'> | FirewallSnapshot,
): string {
  const { snapshotHash: _omitted, ...canonicalPayload } = snapshot as FirewallSnapshot;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

// ── Rule Synthesis From Endpoint Policy ──────────────────────────────

export interface SynthesizeFirewallOptions {
  readonly planId?: string;
  readonly createdAt?: string;
}

/**
 * Synthesizes a deterministic FirewallRulePlan from an authoritative EndpointAllowlistPolicy.
 * Fails closed if the policy contains non-loopback endpoints or invalid hashes.
 */
export function synthesizeFirewallPlan(
  policy: EndpointAllowlistPolicy,
  platform: FirewallPlatform,
  options: SynthesizeFirewallOptions = {},
): FirewallRulePlan {
  // 1. Verify policy hash integrity
  const expectedHash = computeCanonicalPolicyHash(policy);
  if (policy.policyHash && policy.policyHash !== expectedHash) {
    throw new FirewallError(
      FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED,
      `Cannot synthesize firewall rules: policy hash mismatch (found ${policy.policyHash}, expected ${expectedHash}).`,
    );
  }

  // 2. Verify all endpoints are strictly loopback
  for (const ep of policy.declaredEndpoints) {
    if (!ep.isLoopbackOnly) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED,
        `Cannot synthesize firewall rules: endpoint "${ep.endpointId}" is not loopback-only.`,
      );
    }
  }

  const planId = options.planId || `fw_plan_${policy.projectId}_${Date.now()}`;
  const createdAt = options.createdAt || new Date().toISOString();
  const rules: FirewallRule[] = [];

  // Rule 1: Baseline Default Inbound Block (External interfaces)
  rules.push({
    ruleId: 'maos_fw_default_inbound_block',
    name: 'MAOS Industrial — Default Inbound Block',
    direction: 'inbound',
    action: 'block',
    protocol: 'any',
    localAddresses: ['0.0.0.0/0', '::/0'],
    remoteAddresses: ['0.0.0.0/0', '::/0'],
    description: 'Block all incoming connections from non-loopback network adapters.',
  });

  // Rule 2: Baseline Default Outbound Block (External interfaces & Public Internet)
  rules.push({
    ruleId: 'maos_fw_default_outbound_block',
    name: 'MAOS Industrial — Default Outbound Block',
    direction: 'outbound',
    action: 'block',
    protocol: 'any',
    localAddresses: ['0.0.0.0/0', '::/0'],
    remoteAddresses: ['0.0.0.0/0', '::/0'],
    description: 'Block all outgoing connections to external LAN and public Internet.',
  });

  // Rule 3: Explicit Loopback Inbound Allow (127.0.0.1 and ::1)
  rules.push({
    ruleId: 'maos_fw_loopback_inbound_allow',
    name: 'MAOS Industrial — Loopback Inbound Allow',
    direction: 'inbound',
    action: 'allow',
    protocol: 'any',
    localAddresses: ['127.0.0.1', '::1'],
    remoteAddresses: ['127.0.0.1', '::1'],
    description: 'Allow incoming loopback traffic on local loopback adapter.',
  });

  // Rule 4: Explicit Loopback Outbound Allow (127.0.0.1 and ::1)
  rules.push({
    ruleId: 'maos_fw_loopback_outbound_allow',
    name: 'MAOS Industrial — Loopback Outbound Allow',
    direction: 'outbound',
    action: 'allow',
    protocol: 'any',
    localAddresses: ['127.0.0.1', '::1'],
    remoteAddresses: ['127.0.0.1', '::1'],
    description: 'Allow outgoing loopback traffic to local loopback adapter.',
  });

  // Rule 5+: Synthesize Port-Specific Rules from Declared Endpoints
  const bindPorts = new Set<number>();
  const connectPorts = new Set<number>();

  for (const ep of policy.declaredEndpoints) {
    if (ep.protocol === 'tcp' && typeof ep.port === 'number') {
      if (ep.direction === 'bind') {
        bindPorts.add(ep.port);
      } else if (ep.direction === 'connect') {
        connectPorts.add(ep.port);
      }
    }
  }

  if (bindPorts.size > 0) {
    rules.push({
      ruleId: 'maos_fw_declared_bind_ports_allow',
      name: 'MAOS Industrial — Declared Listen Ports Allow',
      direction: 'inbound',
      action: 'allow',
      protocol: 'tcp',
      localAddresses: ['127.0.0.1', '::1'],
      remoteAddresses: ['127.0.0.1', '::1'],
      localPorts: Array.from(bindPorts).sort((a, b) => a - b),
      description: `Allow loopback listeners on declared service ports: [${Array.from(bindPorts).join(', ')}].`,
    });
  }

  if (connectPorts.size > 0) {
    rules.push({
      ruleId: 'maos_fw_declared_connect_ports_allow',
      name: 'MAOS Industrial — Declared Target Ports Allow',
      direction: 'outbound',
      action: 'allow',
      protocol: 'tcp',
      localAddresses: ['127.0.0.1', '::1'],
      remoteAddresses: ['127.0.0.1', '::1'],
      remotePorts: Array.from(connectPorts).sort((a, b) => a - b),
      description: `Allow loopback connections to declared service ports: [${Array.from(connectPorts).join(', ')}].`,
    });
  }

  // Rule: Strict DNS Outbound Block (Port 53 TCP & UDP)
  rules.push({
    ruleId: 'maos_fw_dns_outbound_block',
    name: 'MAOS Industrial — DNS Outbound Block',
    direction: 'outbound',
    action: 'block',
    protocol: 'any',
    localAddresses: ['0.0.0.0/0', '::/0'],
    remoteAddresses: ['0.0.0.0/0', '::/0'],
    remotePorts: [53, 5353],
    description: 'Strictly block all external DNS and mDNS resolution requests.',
  });

  const draft: Omit<FirewallRulePlan, 'planHash'> = {
    schemaVersion: 1,
    planId,
    policyId: policy.policyId,
    policyHash: policy.policyHash || expectedHash,
    platform,
    rules: Object.freeze(rules),
    defaultInboundAction: 'block',
    defaultOutboundAction: 'block',
    createdAt,
  };

  const planHash = computeCanonicalFirewallPlanHash(draft);

  return Object.freeze({
    ...draft,
    planHash,
  });
}
