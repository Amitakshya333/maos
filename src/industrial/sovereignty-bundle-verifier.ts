/**
 * F9-07: Sovereignty Bundle Offline Standalone Verifier
 *
 * Provides offline, zero-network, tamper-evident verification of exported
 * Sovereignty Evidence Bundles (both standalone JSON and deterministic ZIP archives).
 *
 * Guarantees:
 * - Zero network, socket, or external process execution.
 * - Strict cryptographic validation of all evidence hashes and operator signatures.
 * - Enforces privacy boundaries (no unredacted secrets) and epistemic honesty (no prohibited claims).
 * - Detects cross-project pollution, revoked identities, broken audit chains, and unverified traces.
 */

import {
  SovereigntyEvidenceBundle,
  SovereigntyBundleErrorCode,
  SOVEREIGNTY_BUNDLE_ERROR_CODES,
  computeCanonicalBundleHash,
  verifyBundleSignature,
  assertPrivacySafeBundle,
  validateBundleStructure,
  SovereigntyBundleStatus,
} from '../domain/sovereignty-bundle';
import { computeCanonicalBoundaryHash } from '../domain/sovereignty-boundary';
import { computeCanonicalPolicyHash } from '../domain/endpoint-allowlist';
import {
  computeCanonicalFirewallPlanHash,
  computeCanonicalSnapshotHash,
} from '../domain/firewall-policy';
import { computeCanonicalObservationTraceHash } from '../domain/network-monitor';
import { computeCanonicalIdentityMappingHash } from '../domain/service-identity';
import { computeCalculationTraceHash } from '../domain/calculation-trace';

export interface SovereigntyBundleVerifierOptions {
  readonly secretKey?: string;
  readonly allowDraft?: boolean;
}

export interface SovereigntyBundleVerificationResult {
  readonly valid: boolean;
  readonly bundleId?: string;
  readonly status?: SovereigntyBundleStatus;
  readonly errors: readonly string[];
  readonly errorCodes: readonly SovereigntyBundleErrorCode[];
  readonly verifiedAt: string;
  readonly bundleHash?: string;
  readonly details: {
    readonly boundaryValid?: boolean;
    readonly endpointPolicyValid?: boolean;
    readonly firewallValid?: boolean;
    readonly networkTraceValid?: boolean;
    readonly serviceIdentityValid?: boolean;
    readonly calculationTraceValid?: boolean;
    readonly auditChainValid?: boolean;
    readonly rustVerifierValid?: boolean;
    readonly signoffValid?: boolean;
    readonly privacySafe?: boolean;
  };
}

/**
 * Extracts bundle.json from an uncompressed (STORE) deterministic ZIP archive
 * in pure Node.js without any third-party dependencies or external processes.
 */
export function extractBundleFromZip(zipBuffer: Buffer): SovereigntyEvidenceBundle {
  let offset = 0;
  while (offset + 30 <= zipBuffer.length) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break; // Reached central directory or corrupted record
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

    const fileName = zipBuffer
      .subarray(offset + 30, offset + 30 + fileNameLength)
      .toString('utf8');
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const fileData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    if (fileName === 'bundle.json') {
      if (compressionMethod !== 0) {
        throw new Error('Unsupported compression method in sovereign bundle archive: must be 0 (STORE).');
      }
      return JSON.parse(fileData.toString('utf8')) as SovereigntyEvidenceBundle;
    }

    offset = dataStart + compressedSize;
  }

  throw new Error('bundle.json not found in sovereignty archive.');
}

/**
 * Authoritative offline verifier for Sovereignty Evidence Bundles.
 */
export function verifySovereigntyBundle(
  bundleInput: SovereigntyEvidenceBundle | string,
  options: SovereigntyBundleVerifierOptions = {},
): SovereigntyBundleVerificationResult {
  const verifiedAt = new Date().toISOString();
  const errors: string[] = [];
  const errorCodes: SovereigntyBundleErrorCode[] = [];

  function recordError(code: SovereigntyBundleErrorCode, message: string): void {
    if (!errorCodes.includes(code)) {
      errorCodes.push(code);
    }
    errors.push(`[${code}] ${message}`);
  }

  let bundle: SovereigntyEvidenceBundle;
  if (typeof bundleInput === 'string') {
    try {
      bundle = JSON.parse(bundleInput) as SovereigntyEvidenceBundle;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        errors: [`Invalid bundle JSON: ${msg}`],
        errorCodes: [SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_HASH_MISMATCH],
        verifiedAt,
        details: {},
      };
    }
  } else {
    bundle = bundleInput;
  }

  // 1. Structural Validation
  const structuralCheck = validateBundleStructure(bundle);
  if (!structuralCheck.valid) {
    for (const err of structuralCheck.errors) {
      recordError(SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_HASH_MISMATCH, err);
    }
    return {
      valid: false,
      bundleId: bundle?.bundleId,
      status: bundle?.status,
      errors,
      errorCodes,
      verifiedAt,
      details: {},
    };
  }

  // 2. Canonical Bundle Hash Verification
  const computedBundleHash = computeCanonicalBundleHash(bundle);
  let bundleHashValid = true;
  if (bundle.bundleHash && bundle.bundleHash !== computedBundleHash) {
    bundleHashValid = false;
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_HASH_MISMATCH,
      `Bundle hash mismatch: expected ${computedBundleHash}, found ${bundle.bundleHash}`,
    );
  }

  // 3. Status and Operator Sign-off Verification
  let signoffValid = false;
  if (bundle.status === 'SIGNED_OFF') {
    if (!bundle.signoff) {
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.UNSIGNED_BUNDLE_MARKED_SIGNED_OFF,
        'Bundle status is SIGNED_OFF but operator sign-off metadata is missing.',
      );
    } else {
      const isSigValid = verifyBundleSignature(
        computedBundleHash,
        bundle.signoff,
        options.secretKey,
      );
      if (!isSigValid) {
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.INVALID_OPERATOR_SIGNATURE,
          'Operator signature verification failed against canonical bundle hash.',
        );
      } else {
        signoffValid = true;
      }
    }
  } else if (!options.allowDraft) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.UNSIGNED_BUNDLE_MARKED_SIGNED_OFF,
      `Bundle is in status ${bundle.status} but signed-off release is required.`,
    );
  } else {
    signoffValid = true;
  }

  // 4. Privacy & Epistemic Honesty Verification
  const privacyCheck = assertPrivacySafeBundle(bundle);
  let privacySafe = privacyCheck.valid;
  if (!privacyCheck.valid) {
    for (const violation of privacyCheck.violations) {
      if (violation.startsWith('PROHIBITED_MARKETING_CLAIM')) {
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.PROHIBITED_MARKETING_CLAIM,
          violation,
        );
      } else if (violation.startsWith('SENSITIVE_DATA_DETECTED')) {
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.SENSITIVE_DATA_DETECTED,
          violation,
        );
      } else {
        recordError(SOVEREIGNTY_BUNDLE_ERROR_CODES.SENSITIVE_DATA_DETECTED, violation);
      }
    }
  }

  // 5. Cross-Project Reference Check
  const expectedProjectId = bundle.projectId;
  if (bundle.evidence.boundary && bundle.evidence.boundary.projectId !== expectedProjectId) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      `Boundary project ID "${bundle.evidence.boundary.projectId}" does not match bundle project ID "${expectedProjectId}"`,
    );
  }
  if (bundle.evidence.endpointPolicy && bundle.evidence.endpointPolicy.projectId !== expectedProjectId) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      `Endpoint policy project ID "${bundle.evidence.endpointPolicy.projectId}" does not match bundle project ID "${expectedProjectId}"`,
    );
  }
  if (bundle.evidence.networkTrace && bundle.evidence.networkTrace.projectId !== expectedProjectId) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      `Network trace project ID "${bundle.evidence.networkTrace.projectId}" does not match bundle project ID "${expectedProjectId}"`,
    );
  }
  if (bundle.evidence.serviceMapping && bundle.evidence.serviceMapping.projectId !== expectedProjectId) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      `Service mapping project ID "${bundle.evidence.serviceMapping.projectId}" does not match bundle project ID "${expectedProjectId}"`,
    );
  }
  if (
    bundle.evidence.calculationTrace?.provenance?.projectId &&
    bundle.evidence.calculationTrace.provenance.projectId !== expectedProjectId
  ) {
    recordError(
      SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      `Calculation trace project ID "${bundle.evidence.calculationTrace.provenance.projectId}" does not match bundle project ID "${expectedProjectId}"`,
    );
  }

  // 6. Sovereignty Boundary Evidence Verification
  let boundaryValid = true;
  if (bundle.evidence.boundary) {
    const canonicalHash = computeCanonicalBoundaryHash(bundle.evidence.boundary);
    if (
      bundle.evidence.boundary.boundaryHash !== canonicalHash ||
      bundle.hashes.boundaryHash !== canonicalHash
    ) {
      boundaryValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.BOUNDARY_HASH_MISMATCH,
        `Boundary canonical hash mismatch (expected ${canonicalHash}, in-evidence: ${bundle.evidence.boundary.boundaryHash}, in-hashes: ${bundle.hashes.boundaryHash})`,
      );
    }
  }

  // 7. Endpoint Policy Evidence Verification
  let endpointPolicyValid = true;
  if (bundle.evidence.endpointPolicy) {
    const canonicalHash = computeCanonicalPolicyHash(bundle.evidence.endpointPolicy);
    if (
      bundle.evidence.endpointPolicy.policyHash !== canonicalHash ||
      bundle.hashes.endpointPolicyHash !== canonicalHash
    ) {
      endpointPolicyValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.ENDPOINT_POLICY_MISMATCH,
        `Endpoint policy canonical hash mismatch (expected ${canonicalHash}, in-evidence: ${bundle.evidence.endpointPolicy.policyHash}, in-hashes: ${bundle.hashes.endpointPolicyHash})`,
      );
    }
  }

  // 8. Firewall Evidence Verification
  let firewallValid = true;
  if (bundle.evidence.firewallPlan) {
    const canonicalPlanHash = computeCanonicalFirewallPlanHash(bundle.evidence.firewallPlan);
    if (
      bundle.evidence.firewallPlan.planHash !== canonicalPlanHash ||
      (bundle.hashes.firewallPlanHash && bundle.hashes.firewallPlanHash !== canonicalPlanHash)
    ) {
      firewallValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.FIREWALL_EVIDENCE_TAMPERED,
        `Firewall plan canonical hash mismatch (expected ${canonicalPlanHash}, in-evidence: ${bundle.evidence.firewallPlan.planHash})`,
      );
    }
  }
  if (bundle.evidence.firewallSnapshots) {
    for (const snap of bundle.evidence.firewallSnapshots) {
      const snapHash = computeCanonicalSnapshotHash(snap);
      if (snap.snapshotHash !== snapHash) {
        firewallValid = false;
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.FIREWALL_EVIDENCE_TAMPERED,
          `Firewall snapshot "${snap.snapshotId}" canonical hash mismatch.`,
        );
      }
    }
  }
  if (bundle.evidence.firewallStatus?.activePolicyHash) {
    if (
      bundle.hashes.endpointPolicyHash &&
      bundle.evidence.firewallStatus.activePolicyHash !== bundle.hashes.endpointPolicyHash
    ) {
      firewallValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.FIREWALL_EVIDENCE_TAMPERED,
        `Firewall status activePolicyHash does not match endpoint policy hash.`,
      );
    }
  }

  // 9. Network Observation Trace Verification
  let networkTraceValid = true;
  if (bundle.evidence.networkTrace) {
    const trace = bundle.evidence.networkTrace;
    const expectedTraceHash = computeCanonicalObservationTraceHash(trace);
    if (
      trace.traceHash !== expectedTraceHash ||
      bundle.hashes.networkTraceHash !== expectedTraceHash
    ) {
      networkTraceValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.NETWORK_TRACE_TAMPERED,
        `Network trace canonical hash mismatch (expected ${expectedTraceHash}, in-evidence: ${trace.traceHash}, in-hashes: ${bundle.hashes.networkTraceHash})`,
      );
    }
    if (
      trace.boundaryHash !== bundle.hashes.boundaryHash ||
      trace.policyHash !== bundle.hashes.endpointPolicyHash
    ) {
      networkTraceValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.NETWORK_TRACE_TAMPERED,
        'Network trace references unlinked boundary or endpoint policy hash.',
      );
    }
    if (trace.summary.violationsCount > 0 || !trace.summary.allObservedLoopback) {
      networkTraceValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.NETWORK_TRACE_TAMPERED,
        `Network trace contains ${trace.summary.violationsCount} violations or non-loopback sockets.`,
      );
    }
  }

  // 10. Service Endpoint Identity Mapping Verification
  let serviceIdentityValid = true;
  if (bundle.evidence.serviceMapping) {
    const mapping = bundle.evidence.serviceMapping;
    const expectedMappingHash = computeCanonicalIdentityMappingHash(mapping);
    if (
      mapping.mappingHash !== expectedMappingHash ||
      bundle.hashes.serviceMappingHash !== expectedMappingHash
    ) {
      serviceIdentityValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.SERVICE_IDENTITY_REVOKED,
        `Service identity mapping hash mismatch (expected ${expectedMappingHash}, in-evidence: ${mapping.mappingHash})`,
      );
    }
    if (
      mapping.boundaryHash !== bundle.hashes.boundaryHash ||
      mapping.endpointPolicyHash !== bundle.hashes.endpointPolicyHash
    ) {
      serviceIdentityValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.SERVICE_IDENTITY_REVOKED,
        'Service mapping references unlinked boundary or endpoint policy hash.',
      );
    }
    for (const proc of mapping.processes) {
      if (proc.status === 'revoked' || proc.status === 'terminated') {
        serviceIdentityValid = false;
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.SERVICE_IDENTITY_REVOKED,
          `Process PID ${proc.processId} (${proc.processName}) has revoked or terminated trust status.`,
        );
      }
    }
  }

  // 11. Calculation Trace Verification
  let calculationTraceValid = true;
  if (bundle.evidence.calculationTrace) {
    const calc = bundle.evidence.calculationTrace;
    const expectedCalcHash = computeCalculationTraceHash(calc);
    if (
      calc.traceHash !== expectedCalcHash ||
      (bundle.hashes.calculationTraceHash && bundle.hashes.calculationTraceHash !== expectedCalcHash)
    ) {
      calculationTraceValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.CALCULATION_TRACE_INVALID,
        `Calculation trace canonical hash mismatch (expected ${expectedCalcHash}, in-evidence: ${calc.traceHash})`,
      );
    }
    if (calc.verification?.verified !== true) {
      calculationTraceValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.UNVERIFIED_EVIDENCE,
        'Calculation trace has not been authoritatively verified by the engine.',
      );
    }
  }

  // 12. Audit Trail Verification
  let auditChainValid = true;
  if (bundle.evidence.auditTrail) {
    const trail = bundle.evidence.auditTrail;
    if (trail.chainVerified === false) {
      auditChainValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
        'Audit trail record chain is flagged as invalid.',
      );
    }
    if (trail.records && trail.records.length > 0) {
      for (let i = 0; i < trail.records.length; i++) {
        const r = trail.records[i];
        if (r.sequence !== i) {
          auditChainValid = false;
          recordError(
            SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
            `Audit record sequence mismatch at index ${i}: sequence is ${r.sequence}`,
          );
          break;
        }
        if (i === 0 && r.previous_hash !== '') {
          auditChainValid = false;
          recordError(
            SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
            `First audit record previous_hash must be empty.`,
          );
          break;
        }
        if (i > 0 && r.previous_hash !== trail.records[i - 1].hash) {
          auditChainValid = false;
          recordError(
            SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
            `Audit record hash break between sequence ${i - 1} and ${i}.`,
          );
          break;
        }
      }
      const actualLastHash = trail.records[trail.records.length - 1].hash;
      if (trail.latestHash !== actualLastHash) {
        auditChainValid = false;
        recordError(
          SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
          `Audit trail latestHash mismatch: expected ${actualLastHash}, recorded ${trail.latestHash}`,
        );
      }
    }
    if (
      bundle.hashes.auditChainHeadHash &&
      bundle.hashes.auditChainHeadHash !== trail.latestHash
    ) {
      auditChainValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
        `Bundle hashes auditChainHeadHash mismatch: expected ${trail.latestHash}, recorded ${bundle.hashes.auditChainHeadHash}`,
      );
    }
  }

  // 13. Rust Verifier Verification
  let rustVerifierValid = true;
  if (bundle.evidence.rustVerifier) {
    const rv = bundle.evidence.rustVerifier;
    if (rv.verified !== true) {
      rustVerifierValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.RUST_VERIFIER_MISMATCH,
        'Rust verifier manifest verification is false.',
      );
    }
    if (
      bundle.hashes.rustVerifierExecutableHash &&
      rv.executableHash !== bundle.hashes.rustVerifierExecutableHash
    ) {
      rustVerifierValid = false;
      recordError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.RUST_VERIFIER_MISMATCH,
        `Rust verifier executableHash mismatch: expected ${bundle.hashes.rustVerifierExecutableHash}, found ${rv.executableHash}`,
      );
    }
  }

  const isValid = errors.length === 0;

  return {
    valid: isValid,
    bundleId: bundle.bundleId,
    status: bundle.status,
    errors,
    errorCodes,
    verifiedAt,
    bundleHash: computedBundleHash,
    details: {
      boundaryValid,
      endpointPolicyValid,
      firewallValid,
      networkTraceValid,
      serviceIdentityValid,
      calculationTraceValid,
      auditChainValid,
      rustVerifierValid,
      signoffValid,
      privacySafe,
    },
  };
}

/**
 * Authoritative offline verifier for Sovereignty Evidence Bundle ZIP archives.
 */
export function verifySovereigntyBundleZip(
  zipBuffer: Buffer,
  options: SovereigntyBundleVerifierOptions = {},
): SovereigntyBundleVerificationResult {
  try {
    const bundle = extractBundleFromZip(zipBuffer);
    return verifySovereigntyBundle(bundle, options);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to verify sovereignty bundle zip archive: ${msg}`],
      errorCodes: [SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_HASH_MISMATCH],
      verifiedAt: new Date().toISOString(),
      details: {},
    };
  }
}
