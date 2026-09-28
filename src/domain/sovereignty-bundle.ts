/**
 * F9-07: Sovereignty Evidence Bundle Domain Schema & Invariants
 *
 * Aggregates all verified F8/F9 evidence into one self-contained,
 * tamper-evident sovereignty evidence bundle.
 *
 * Invariants:
 * 1. Self-contained offline verification: Zero network access required.
 * 2. Independent JSON verifiability: Can be verified directly or within archive.
 * 3. Privacy-safe: No raw prompts, credentials, tokens, or unredacted secrets.
 * 4. Epistemic honesty: Discloses excluded boundaries; rejects prohibited marketing claims.
 * 5. Cryptographic binding: Canonical bundle hash binds all evidence; operator
 *    sign-off binds the canonical bundle hash.
 * 6. Cross-project isolation: Disallows mixed project IDs across evidence.
 * 7. Fail-closed: Missing, tampered, unverified, or revoked evidence fails closed.
 */

import * as crypto from 'crypto';
import {
  SovereigntyBoundary,
  ExcludedInfrastructure,
  PROHIBITED_SOVEREIGNTY_CLAIMS,
  STANDARD_REDACTED_AUDIT_FIELDS,
} from './sovereignty-boundary';
import { EndpointAllowlistPolicy } from './endpoint-allowlist';
import {
  FirewallRulePlan,
  FirewallSnapshot,
  FirewallStatusResult,
} from './firewall-policy';
import { NetworkObservationTrace } from './network-monitor';
import {
  ServiceEndpointIdentityMapping,
  ModelIdentityRecord,
} from './service-identity';
import { CalculationTrace } from './calculation-trace';
import { AuditRecord } from './schemas';

// ── Types & Statuses ────────────────────────────────────────────────

export type SovereigntyBundleStatus = 'DRAFT' | 'SIGNED_OFF' | 'REVOKED';

export interface OperatorSignoff {
  readonly operatorId: string;
  readonly role?: string;
  readonly signedAt: string;
  readonly notes?: string;
  readonly signature: string;
  readonly keyFingerprint?: string;
}

export interface SovereigntyBundleHashes {
  readonly boundaryHash: string;
  readonly endpointPolicyHash: string;
  readonly firewallActivePolicyHash?: string;
  readonly firewallSnapshotHash?: string;
  readonly firewallPlanHash?: string;
  readonly networkTraceHash: string;
  readonly serviceMappingHash: string;
  readonly calculationTraceHash?: string;
  readonly auditChainHeadHash?: string;
  readonly rustVerifierExecutableHash?: string;
  readonly modelWeightsHash?: string;
  readonly modelManifestHash?: string;
  readonly sandboxImageDigest?: string;
  readonly projectRootHash: string;
}

export interface SovereigntyBundleAuditSummary {
  readonly recordsCount: number;
  readonly latestHash: string;
  readonly chainVerified: boolean;
  readonly records?: readonly AuditRecord[];
}

export interface SovereigntyBundleRustVerifier {
  readonly executablePath: string;
  readonly executableHash: string;
  readonly engineVersion: string;
  readonly protocolVersion?: string;
  readonly verified: boolean;
}

export interface SovereigntyBundleEvidence {
  readonly boundary?: SovereigntyBoundary;
  readonly endpointPolicy?: EndpointAllowlistPolicy;
  readonly firewallStatus?: FirewallStatusResult;
  readonly firewallPlan?: FirewallRulePlan;
  readonly firewallSnapshots?: readonly FirewallSnapshot[];
  readonly networkTrace?: NetworkObservationTrace;
  readonly serviceMapping?: ServiceEndpointIdentityMapping;
  readonly calculationTrace?: CalculationTrace;
  readonly auditTrail?: SovereigntyBundleAuditSummary;
  readonly rustVerifier?: SovereigntyBundleRustVerifier;
  readonly modelIdentity?: ModelIdentityRecord;
  readonly sandboxManifest?: {
    readonly imageDigest?: string;
    readonly verified?: boolean;
    readonly architecture?: string;
  };
}

export interface SovereigntyBundleMeasurementInterval {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs?: number;
}

export interface SovereigntyEvidenceBundle {
  readonly schemaVersion: 1;
  readonly bundleId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectRootHash: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly createdAt: string;
  readonly status: SovereigntyBundleStatus;
  readonly hashes: SovereigntyBundleHashes;
  readonly evidence: SovereigntyBundleEvidence;
  readonly excludedBoundaries: readonly ExcludedInfrastructure[];
  readonly verificationReportRefs: readonly string[];
  readonly claims: readonly string[];
  readonly observationLimitations: readonly string[];
  readonly measurementInterval: SovereigntyBundleMeasurementInterval;
  readonly signoff?: OperatorSignoff;
  readonly bundleHash?: string;
}

// ── Error Codes & Hierarchy ─────────────────────────────────────────

export const SOVEREIGNTY_BUNDLE_ERROR_CODES = {
  BUNDLE_HASH_MISMATCH: 'BUNDLE_HASH_MISMATCH',
  BOUNDARY_HASH_MISMATCH: 'BOUNDARY_HASH_MISMATCH',
  ENDPOINT_POLICY_MISMATCH: 'ENDPOINT_POLICY_MISMATCH',
  FIREWALL_EVIDENCE_TAMPERED: 'FIREWALL_EVIDENCE_TAMPERED',
  NETWORK_TRACE_TAMPERED: 'NETWORK_TRACE_TAMPERED',
  SERVICE_IDENTITY_REVOKED: 'SERVICE_IDENTITY_REVOKED',
  CALCULATION_TRACE_INVALID: 'CALCULATION_TRACE_INVALID',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
  RUST_VERIFIER_MISMATCH: 'RUST_VERIFIER_MISMATCH',
  CROSS_PROJECT_REFERENCE: 'CROSS_PROJECT_REFERENCE',
  UNVERIFIED_EVIDENCE: 'UNVERIFIED_EVIDENCE',
  PROHIBITED_MARKETING_CLAIM: 'PROHIBITED_MARKETING_CLAIM',
  SENSITIVE_DATA_DETECTED: 'SENSITIVE_DATA_DETECTED',
  UNSIGNED_BUNDLE_MARKED_SIGNED_OFF: 'UNSIGNED_BUNDLE_MARKED_SIGNED_OFF',
  INVALID_OPERATOR_SIGNATURE: 'INVALID_OPERATOR_SIGNATURE',
  BUNDLE_NOT_FOUND: 'BUNDLE_NOT_FOUND',
  ARCHIVE_CREATION_FAILED: 'ARCHIVE_CREATION_FAILED',
} as const;

export type SovereigntyBundleErrorCode =
  (typeof SOVEREIGNTY_BUNDLE_ERROR_CODES)[keyof typeof SOVEREIGNTY_BUNDLE_ERROR_CODES];

export class SovereigntyBundleError extends Error {
  public readonly code: SovereigntyBundleErrorCode;
  public readonly detail?: unknown;

  constructor(code: SovereigntyBundleErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'SovereigntyBundleError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, SovereigntyBundleError.prototype);
  }
}

// ── Canonical Hashing ───────────────────────────────────────────────

/**
 * Deterministically sorts object keys for canonical cryptographic hashing.
 */
export function canonicalJson(obj: unknown): string {
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
 * Computes canonical SHA-256 hash of a SovereigntyEvidenceBundle.
 * Excludes `bundleHash` and `signoff` fields to allow reproducible verification
 * and non-circular operator signatures.
 */
export function computeCanonicalBundleHash(
  bundle: Omit<SovereigntyEvidenceBundle, 'bundleHash'> | SovereigntyEvidenceBundle,
): string {
  const {
    bundleHash: _omittedHash,
    signoff: _omittedSignoff,
    ...canonicalPayload
  } = bundle as SovereigntyEvidenceBundle;

  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Computes deterministic cryptographic signature for operator sign-off.
 * Signs canonical `bundleHash + operatorId + signedAt` using HMAC-SHA256 (if secret provided)
 * or SHA-256 with key domain separation.
 */
export function computeBundleSignature(
  bundleHash: string,
  operatorId: string,
  signedAt: string,
  secretKey?: string,
): string {
  const payload = `sovereignty-bundle-signoff:${bundleHash}:${operatorId}:${signedAt}`;
  if (secretKey && secretKey.trim().length > 0) {
    return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
  }
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Verifies an operator signature against the canonical bundle hash.
 */
export function verifyBundleSignature(
  bundleHash: string,
  signoff: OperatorSignoff,
  secretKey?: string,
): boolean {
  if (!signoff || !signoff.signature || !signoff.operatorId || !signoff.signedAt) {
    return false;
  }
  const expectedSignature = computeBundleSignature(
    bundleHash,
    signoff.operatorId,
    signoff.signedAt,
    secretKey,
  );
  return crypto.timingSafeEqual(
    Buffer.from(signoff.signature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  );
}

// ── Privacy & Epistemic Honesty ─────────────────────────────────────

const SENSITIVE_KEY_REGEX = new RegExp(
  `^(${STANDARD_REDACTED_AUDIT_FIELDS.join('|')})$`,
  'i',
);

/**
 * Traverses an arbitrary object looking for unredacted sensitive keys/values
 * or prohibited marketing claim substrings.
 */
export function assertPrivacySafeBundle(bundle: SovereigntyEvidenceBundle): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  function inspectValue(val: unknown, currentPath: string): void {
    if (val === null || val === undefined) return;

    if (typeof val === 'string') {
      const lower = val.toLowerCase();
      for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        if (lower.includes(prohibited.toLowerCase())) {
          violations.push(
            `PROHIBITED_MARKETING_CLAIM at ${currentPath}: found prohibited claim "${prohibited}"`,
          );
        }
      }
      return;
    }

    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        inspectValue(val[i], `${currentPath}[${i}]`);
      }
      return;
    }

    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
          // If the field exists, check if it contains actual unredacted text
          if (
            typeof v === 'string' &&
            v.trim().length > 0 &&
            v !== '[REDACTED]' &&
            v !== '[REDACTED_PROMPT]'
          ) {
            violations.push(
              `SENSITIVE_DATA_DETECTED at ${currentPath}.${k}: contains unredacted sensitive content`,
            );
          }
        }
        inspectValue(v, `${currentPath}.${k}`);
      }
    }
  }

  inspectValue(bundle, 'bundle');

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Validates structural conformity of an evidence bundle.
 */
export function validateBundleStructure(bundle: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle must be a non-null object'] };
  }

  const b = bundle as Record<string, unknown>;
  if (b.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, found ${String(b.schemaVersion)}`);
  }
  if (!b.bundleId || typeof b.bundleId !== 'string') {
    errors.push('bundleId is required and must be a string');
  }
  if (!b.projectId || typeof b.projectId !== 'string') {
    errors.push('projectId is required and must be a string');
  }
  if (!b.hashes || typeof b.hashes !== 'object') {
    errors.push('hashes is required and must be an object');
  }
  if (!b.evidence || typeof b.evidence !== 'object') {
    errors.push('evidence is required and must be an object');
  }
  if (!b.claims || !Array.isArray(b.claims)) {
    errors.push('claims is required and must be an array');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
