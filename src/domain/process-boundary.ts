/**
 * F9-10: Process-Scoped Boundary Domain Schema & Invariants
 *
 * Defines the *process-scoped* sovereignty boundary that MAOS Industrial
 * enforces by default.
 *
 * Scope decision (see docs/BOUNDARY_SCOPE.md):
 *   The Industrial claim is "the MAOS process tree communicated only over
 *   declared loopback endpoints during this run". It is NOT "this workstation
 *   was isolated". Those are different claims requiring different mechanisms,
 *   and only the first is expressible without machine-wide side effects.
 *
 * Invariants:
 *  1. A process boundary plan is synthesized ONLY from a sealed
 *     EndpointAllowlistPolicy. It fails closed on any non-loopback endpoint.
 *  2. `hostFirewallModified` is always `false`; a plan claiming otherwise is
 *     rejected by `validateProcessBoundaryPlan`.
 *  3. The plan is deterministic and canonically hashable, so what was enforced
 *     can be re-derived and compared against what was recorded.
 *  4. Constraints describe *enforceable, measurable* properties only. Nothing
 *     here asserts a capability the runtime does not have.
 */

import * as crypto from 'crypto';
import {
  EndpointAllowlistPolicy,
  computeCanonicalPolicyHash,
} from './endpoint-allowlist';

// ── Types & Enums ───────────────────────────────────────────────────

export type ProcessBoundaryConstraintKind =
  | 'loopback_only_endpoints'
  | 'declared_listen_ports'
  | 'declared_connect_ports'
  | 'approved_named_pipes'
  | 'dns_resolution_denied'
  | 'host_firewall_untouched';

export interface ProcessBoundaryConstraint {
  readonly constraintId: string;
  readonly kind: ProcessBoundaryConstraintKind;
  readonly description: string;
  readonly values: readonly (string | number)[];
}

export interface ProcessBoundaryPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly policyId: string;
  readonly policyHash: string;
  readonly projectId: string;
  readonly scope: 'process';
  readonly platform: 'process';
  readonly constraints: readonly ProcessBoundaryConstraint[];
  /**
   * Always `false`. Present so that evidence bundles and operator output carry
   * an explicit, checkable statement that no host packet filter was written.
   */
  readonly hostFirewallModified: false;
  /** Process PIDs whose sockets are attributed to this boundary. */
  readonly monitoredPids: readonly number[];
  /** Process names additionally attributed to this boundary. */
  readonly monitoredProcessNames: readonly string[];
  readonly createdAt: string;
  readonly planHash?: string;
}

// ── Error Codes ─────────────────────────────────────────────────────

export const PROCESS_BOUNDARY_ERROR_CODES = {
  PROCESS_BOUNDARY_POLICY_INVALID: 'PROCESS_BOUNDARY_POLICY_INVALID',
  PROCESS_BOUNDARY_SCOPE_UNRESOLVED: 'PROCESS_BOUNDARY_SCOPE_UNRESOLVED',
  PROCESS_BOUNDARY_PLAN_INVALID: 'PROCESS_BOUNDARY_PLAN_INVALID',
  PROCESS_BOUNDARY_ALREADY_ACTIVE: 'PROCESS_BOUNDARY_ALREADY_ACTIVE',
  PROCESS_BOUNDARY_NOT_ACTIVE: 'PROCESS_BOUNDARY_NOT_ACTIVE',
} as const;

export type ProcessBoundaryErrorCode =
  (typeof PROCESS_BOUNDARY_ERROR_CODES)[keyof typeof PROCESS_BOUNDARY_ERROR_CODES];

export class ProcessBoundaryError extends Error {
  public readonly code: ProcessBoundaryErrorCode;
  public readonly detail?: unknown;

  constructor(code: ProcessBoundaryErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ProcessBoundaryError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, ProcessBoundaryError.prototype);
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
 * Computes the canonical SHA-256 hash of a ProcessBoundaryPlan.
 * Excludes `planHash` itself.
 */
export function computeCanonicalProcessBoundaryPlanHash(
  plan: Omit<ProcessBoundaryPlan, 'planHash'> | ProcessBoundaryPlan,
): string {
  const { planHash: _omitted, ...canonicalPayload } = plan as ProcessBoundaryPlan;
  return crypto
    .createHash('sha256')
    .update(canonicalJson(canonicalPayload), 'utf8')
    .digest('hex');
}

// ── Synthesis From Sealed Endpoint Policy ───────────────────────────

export interface SynthesizeProcessBoundaryOptions {
  readonly planId?: string;
  readonly createdAt?: string;
  readonly monitoredPids?: readonly number[];
  readonly monitoredProcessNames?: readonly string[];
}

/**
 * Synthesizes a deterministic ProcessBoundaryPlan from a sealed
 * EndpointAllowlistPolicy.
 *
 * Fails closed if the policy is tampered with, if any declared endpoint is not
 * strictly loopback, or if the policy permits DNS resolution.
 */
export function synthesizeProcessBoundaryPlan(
  policy: EndpointAllowlistPolicy,
  options: SynthesizeProcessBoundaryOptions = {},
): ProcessBoundaryPlan {
  // 1. Policy hash integrity — never synthesize from a mutated policy.
  const expectedHash = computeCanonicalPolicyHash(policy);
  if (policy.policyHash && policy.policyHash !== expectedHash) {
    throw new ProcessBoundaryError(
      PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
      `Cannot synthesize process boundary: policy hash mismatch (found ${policy.policyHash}, expected ${expectedHash}).`,
    );
  }

  // 2. Strict loopback invariant.
  if (policy.enforceLoopbackStrict !== true) {
    throw new ProcessBoundaryError(
      PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
      'Cannot synthesize process boundary: policy does not enforce strict loopback.',
    );
  }

  for (const ep of policy.declaredEndpoints) {
    if (!ep.isLoopbackOnly) {
      throw new ProcessBoundaryError(
        PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
        `Cannot synthesize process boundary: endpoint "${ep.endpointId}" is not loopback-only.`,
      );
    }
  }

  // 3. DNS denial is required — a boundary that permits name resolution cannot
  //    make a sovereignty claim about where traffic went.
  if (policy.disallowDnsResolution !== true) {
    throw new ProcessBoundaryError(
      PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
      'Cannot synthesize process boundary: policy permits DNS resolution.',
    );
  }

  const bindPorts = new Set<number>();
  const connectPorts = new Set<number>();
  const endpointIds: string[] = [];

  for (const ep of policy.declaredEndpoints) {
    endpointIds.push(ep.endpointId);
    if (ep.protocol === 'tcp' && typeof ep.port === 'number') {
      if (ep.direction === 'bind') bindPorts.add(ep.port);
      else if (ep.direction === 'connect') connectPorts.add(ep.port);
    }
  }

  const constraints: ProcessBoundaryConstraint[] = [
    {
      constraintId: 'pbc_loopback_only_endpoints',
      kind: 'loopback_only_endpoints',
      description:
        'Every declared endpoint must be a loopback address; the runtime rejects any other target before a socket is opened.',
      values: endpointIds.sort(),
    },
    {
      constraintId: 'pbc_declared_listen_ports',
      kind: 'declared_listen_ports',
      description:
        'Monitored processes may listen only on declared loopback ports.',
      values: Array.from(bindPorts).sort((a, b) => a - b),
    },
    {
      constraintId: 'pbc_declared_connect_ports',
      kind: 'declared_connect_ports',
      description:
        'Monitored processes may connect only to declared loopback ports.',
      values: Array.from(connectPorts).sort((a, b) => a - b),
    },
    {
      constraintId: 'pbc_approved_named_pipes',
      kind: 'approved_named_pipes',
      description: 'Only approved local named pipes may be opened.',
      values: [...policy.allowedNamedPipes].sort(),
    },
    {
      constraintId: 'pbc_dns_resolution_denied',
      kind: 'dns_resolution_denied',
      description:
        'Hostname resolution is refused; only literal loopback addresses are accepted.',
      values: ['127.0.0.1', '::1', 'localhost'],
    },
    {
      constraintId: 'pbc_host_firewall_untouched',
      kind: 'host_firewall_untouched',
      description:
        'This boundary writes no host packet filter rules and requires no elevation.',
      values: [],
    },
  ];

  const planId =
    options.planId || `pb_plan_${policy.projectId}_${Date.now()}`;
  const createdAt = options.createdAt || new Date().toISOString();

  const draft: Omit<ProcessBoundaryPlan, 'planHash'> = {
    schemaVersion: 1,
    planId,
    policyId: policy.policyId,
    policyHash: policy.policyHash || expectedHash,
    projectId: policy.projectId,
    scope: 'process',
    platform: 'process',
    constraints: Object.freeze(constraints),
    hostFirewallModified: false,
    monitoredPids: Object.freeze([...(options.monitoredPids || [])]),
    monitoredProcessNames: Object.freeze([
      ...(options.monitoredProcessNames || []),
    ]),
    createdAt,
  };

  return Object.freeze({
    ...draft,
    planHash: computeCanonicalProcessBoundaryPlanHash(draft),
  });
}

/**
 * Validates a ProcessBoundaryPlan: schema, hash integrity, and the invariant
 * that no process-scoped plan may claim host firewall modification.
 */
export function validateProcessBoundaryPlan(plan: unknown): {
  valid: boolean;
  errors: readonly string[];
  canonicalHash?: string;
} {
  const errors: string[] = [];

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { valid: false, errors: ['Plan must be a non-null object.'] };
  }

  const p = plan as Record<string, any>;

  if (p.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${p.schemaVersion}.`);
  }
  if (p.scope !== 'process') {
    errors.push(`Invalid scope: expected "process", received ${p.scope}.`);
  }
  if (p.hostFirewallModified !== false) {
    errors.push(
      'Invariant violation: a process-scoped plan must declare hostFirewallModified: false.',
    );
  }
  if (!Array.isArray(p.constraints) || p.constraints.length === 0) {
    errors.push('constraints must be a non-empty array.');
  }
  if (!p.policyHash || typeof p.policyHash !== 'string') {
    errors.push('policyHash is required.');
  }

  let canonicalHash: string | undefined;
  try {
    canonicalHash = computeCanonicalProcessBoundaryPlanHash(p as any);
    if (p.planHash && p.planHash !== canonicalHash) {
      errors.push(
        `Plan hash mismatch: expected ${canonicalHash}, found ${p.planHash}.`,
      );
    }
  } catch (err: any) {
    errors.push(`Failed to compute canonical plan hash: ${err.message}`);
  }

  return { valid: errors.length === 0, errors, canonicalHash };
}
