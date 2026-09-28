/**
 * MAOS Industrial — F9-07: Sovereignty Evidence Bundle Test Suite
 *
 * Verifies that the complete F8/F9 evidence chain can be aggregated into a
 * deterministic, self-contained, tamper-evident sovereignty bundle and verified
 * strictly offline with zero network access.
 *
 * Test Sections:
 * 1. Deterministic Bundle Generation & Hashes Assembly
 * 2. Canonical Hashing & Idempotency
 * 3. Operator Sign-Off & Status Transitions
 * 4. Offline Standalone Verifier (Pure In-Memory Evaluation)
 * 5. Fail-Closed on Tampered Bundle Hash
 * 6. Fail-Closed on Tampered Boundary Hash
 * 7. Fail-Closed on Tampered Endpoint Policy Hash
 * 8. Fail-Closed on Tampered Firewall Evidence
 * 9. Fail-Closed on Tampered Network Observation Trace
 * 10. Fail-Closed on Revoked or Terminated Service Identities
 * 11. Fail-Closed on Invalid or Unverified Calculation Trace
 * 12. Fail-Closed on Broken Audit Trail Chain
 * 13. Fail-Closed on Rust Verifier Mismatch
 * 14. Fail-Closed on Cross-Project Evidence References
 * 15. Privacy-Safe Export & Epistemic Honesty Rules
 * 16. Fail-Closed on Unsigned Releases Marked SIGNED_OFF
 * 17. Deterministic PKZIP Archive & Offline ZIP Verification
 * 18. REST API Endpoints (/api/v1/industrial/bundles/*)
 * 19. Canary & Cryptographic Invariants (rust/test.txt SHA-256)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';

import {
  createServiceContainer,
  ServiceContainer,
  SovereigntyBundleService,
  createDeterministicZip,
} from '../../src/service';
import {
  SovereigntyEvidenceBundle,
  SOVEREIGNTY_BUNDLE_ERROR_CODES,
  computeCanonicalBundleHash,
  computeBundleSignature,
  verifyBundleSignature,
  assertPrivacySafeBundle,
} from '../../src/domain/sovereignty-bundle';
import {
  createIndustrialSovereigntyBoundary,
  STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
} from '../../src/domain/sovereignty-boundary';
import { createIndustrialEndpointPolicy } from '../../src/domain/endpoint-allowlist';
import { synthesizeFirewallPlan } from '../../src/domain/firewall-policy';
import {
  verifySovereigntyBundle,
  verifySovereigntyBundleZip,
  extractBundleFromZip,
} from '../../src/industrial/sovereignty-bundle-verifier';
import { computeCanonicalObservationTraceHash } from '../../src/domain/network-monitor';
import { computeCanonicalIdentityMappingHash } from '../../src/domain/service-identity';
import { computeCalculationTraceHash } from '../../src/domain/calculation-trace';
import { RestApiRouter } from '../../src/api/router';

describe('F9-07: Sovereignty Evidence Bundle', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    `.maos/test-temp-f907-${Date.now()}`,
  );
  const testProjectId = 'proj_f907_industrial_test';

  let services: ServiceContainer;
  let bundleService: SovereigntyBundleService;

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
    services = createServiceContainer(testTempDir);
    bundleService = services.sovereigntyBundle;
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  });

  // Helper to create fully-populated test evidence
  function createSampleEvidence() {
    const boundary = createIndustrialSovereigntyBoundary(testProjectId);
    const endpointPolicy = createIndustrialEndpointPolicy(testProjectId);
    const firewallPlan = synthesizeFirewallPlan(endpointPolicy, 'mock');

    const networkTrace: any = {
      schemaVersion: 1,
      traceId: `trace_${testProjectId}_001`,
      sessionId: 'session_001',
      projectId: testProjectId,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      stoppedAt: new Date().toISOString(),
      policyHash: endpointPolicy.policyHash,
      boundaryHash: boundary.boundaryHash,
      summary: {
        allObservedLoopback: true,
        totalSocketsObserved: 12,
        totalSamples: 5,
        trackedProcessSocketsCount: 12,
        untrackedProcessSocketsCount: 0,
        violationsCount: 0,
        violationTypes: [],
        monitoredPids: [1001, 1002],
      },
      samples: [],
      violations: [],
      observationLimitations: boundary.observationLimitations,
      claims: [STANDARD_MEASURED_SOVEREIGNTY_CLAIM],
    };
    // Compute canonical trace hash
    const { traceHash: _omitted, ...canonicalTrace } = networkTrace;
    const sortedKeys = Object.keys(canonicalTrace).sort();
    const traceJson =
      '{' +
      sortedKeys
        .map((k) => `${JSON.stringify(k)}:${JSON.stringify((canonicalTrace as any)[k])}`)
        .join(',') +
      '}';
    networkTrace.traceHash = computeCanonicalObservationTraceHash(canonicalTrace);

    const serviceMapping: any = {
      schemaVersion: 1,
      mappingId: `mapping_${testProjectId}_001`,
      projectId: testProjectId,
      projectRoot: testTempDir,
      boundaryHash: boundary.boundaryHash,
      endpointPolicyHash: endpointPolicy.policyHash,
      processes: [
        {
          processId: 1001,
          approvedDescendantPids: [],
          processName: 'maos_backend',
          executablePath: 'dist/cli/index.js',
          executableHash: 'a'.repeat(64),
          projectId: testProjectId,
          projectRoot: testTempDir,
          projectRootHash: 'b'.repeat(64),
          serviceIdentity: 'maos_backend',
          runtimeManifest: { runtimeType: 'node', version: '20.0.0' },
          activeModelLeases: [],
          registeredAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          status: 'trusted',
        },
      ],
      endpointBindings: [
        {
          bindingId: 'bind_1',
          protocol: 'tcp',
          direction: 'bind',
          localAddress: '127.0.0.1',
          localPort: 3000,
          owningPid: 1001,
          serviceIdentity: 'maos_backend',
          boundAt: new Date().toISOString(),
          status: 'active',
          lastVerifiedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
    serviceMapping.mappingHash = computeCanonicalIdentityMappingHash(serviceMapping);

    const calculationTrace: any = {
      schemaVersion: 1,
      traceId: `calc_${testProjectId}_001`,
      title: 'Turbine Vibration RMS',
      calculationType: 'vibration_rms',
      formula: 'RMS = sqrt((x1^2 + ... + xn^2) / n)',
      provenance: {
        sourceFile: 'demo/industrial/turbine_vibration_log.csv',
        sourceFileHash: 'c'.repeat(64),
        rowCount: 500,
        measurementField: 'vibration_rms_mm_s',
        unit: 'mm/s',
        generatedAt: new Date().toISOString(),
        projectId: testProjectId,
      },
      intermediates: {
        sampleCount: 500,
        sumOfSquares: 3477.193,
        sumOfSquaresUnit: '(mm/s)^2',
        meanSquare: 6.954386,
        meanSquareUnit: '(mm/s)^2',
        unroundedResult: 2.63711,
        roundingPolicy: 'round_half_up',
        roundingDecimals: 5,
        roundedResult: 2.63711,
        finalUnit: 'mm/s',
      },
      thresholdEvaluation: {
        warningThreshold: 4.5,
        criticalThreshold: 7.1,
        unit: 'mm/s',
        warningRowIds: [121, 367],
        criticalRowIds: [367],
        overallStatus: 'CRITICAL',
      },
      citations: [],
      verification: {
        verified: true,
        engine: 'rust_engine',
        verifiedAt: new Date().toISOString(),
      },
    };
    calculationTrace.traceHash = computeCalculationTraceHash(calculationTrace);

    const auditTrail = {
      recordsCount: 2,
      latestHash: 'd'.repeat(64),
      chainVerified: true,
      records: [
        {
          schemaVersion: 1,
          sequence: 0,
          previous_hash: '',
          timestamp: new Date().toISOString(),
          source: 'test',
          category: 'system',
          data: { event: 'INIT' },
          hash: 'e'.repeat(64),
        },
        {
          schemaVersion: 1,
          sequence: 1,
          previous_hash: 'e'.repeat(64),
          timestamp: new Date().toISOString(),
          source: 'test',
          category: 'system',
          data: { event: 'START' },
          hash: 'd'.repeat(64),
        },
      ],
    };

    const rustVerifier = {
      executablePath: `rust/target/release/maos-engine${process.platform === 'win32' ? '.exe' : ''}`,
      executableHash: 'f'.repeat(64),
      engineVersion: '0.3.0-industrial',
      verified: true,
    };

    return {
      boundary,
      endpointPolicy,
      firewallPlan,
      networkTrace,
      serviceMapping,
      calculationTrace,
      auditTrail,
      rustVerifier,
    };
  }

  // ── 1. Deterministic Bundle Generation & Hashes Assembly ───────────
  describe('1. Deterministic Bundle Generation & Hashes Assembly', () => {
    it('generates a complete evidence bundle with all upstream evidence hashes', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        firewallPlan: evidence.firewallPlan,
        networkTrace: evidence.networkTrace,
        serviceMapping: evidence.serviceMapping,
        calculationTrace: evidence.calculationTrace,
        auditTrail: evidence.auditTrail,
        rustVerifier: evidence.rustVerifier,
      });

      expect(bundle.schemaVersion).toBe(1);
      expect(bundle.bundleId).toBeDefined();
      expect(bundle.projectId).toBe(testProjectId);
      expect(bundle.status).toBe('DRAFT');
      expect(bundle.bundleHash).toBeDefined();
      expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify hashes block
      expect(bundle.hashes.boundaryHash).toBe(evidence.boundary.boundaryHash);
      expect(bundle.hashes.endpointPolicyHash).toBe(evidence.endpointPolicy.policyHash);
      expect(bundle.hashes.firewallPlanHash).toBe(evidence.firewallPlan.planHash);
      expect(bundle.hashes.networkTraceHash).toBe(evidence.networkTrace.traceHash);
      expect(bundle.hashes.serviceMappingHash).toBe(evidence.serviceMapping.mappingHash);
      expect(bundle.hashes.calculationTraceHash).toBe(evidence.calculationTrace.traceHash);
      expect(bundle.hashes.auditChainHeadHash).toBe(evidence.auditTrail.latestHash);
      expect(bundle.hashes.rustVerifierExecutableHash).toBe(evidence.rustVerifier.executableHash);

      // Verify disclosures
      expect(bundle.excludedBoundaries.length).toBeGreaterThan(0);
      expect(bundle.claims).toContain(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
      expect(bundle.verificationReportRefs).toContain('F8-06');
      expect(bundle.verificationReportRefs).toContain('F9-06');
    });

    it('persists bundle as JSON in .maos/bundles/<bundleId>.json', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const loaded = bundleService.loadBundle(bundle.bundleId);
      expect(loaded.bundleId).toBe(bundle.bundleId);
      expect(loaded.bundleHash).toBe(bundle.bundleHash);
    });
  });

  // ── 2. Canonical Hashing & Idempotency ─────────────────────────────
  describe('2. Canonical Hashing & Idempotency', () => {
    it('produces identical bundleHash regardless of object property ordering', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const hash1 = computeCanonicalBundleHash(bundle);

      // Create object with reversed keys
      const reversed: any = {};
      const keys = Object.keys(bundle).reverse();
      for (const k of keys) {
        reversed[k] = (bundle as any)[k];
      }

      const hash2 = computeCanonicalBundleHash(reversed);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(bundle.bundleHash);
    });

    it('excludes bundleHash and signoff from hash calculation to prevent cycle', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const hashWithoutSignoff = computeCanonicalBundleHash(bundle);

      const signedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        signoff: {
          operatorId: 'operator_test',
          signedAt: new Date().toISOString(),
          signature: 'abcd1234',
        },
      };

      const hashWithSignoff = computeCanonicalBundleHash(signedBundle);
      expect(hashWithoutSignoff).toBe(hashWithSignoff);
    });
  });

  // ── 3. Operator Sign-Off & Status Transitions ───────────────────────
  describe('3. Operator Sign-Off & Status Transitions', () => {
    it('transitions DRAFT to SIGNED_OFF with valid cryptographic signature', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      expect(bundle.status).toBe('DRAFT');
      expect(bundle.signoff).toBeUndefined();

      const signed = bundleService.signOffBundle(bundle.bundleId, {
        operatorId: 'auditor_lead',
        role: 'Chief Sovereignty Officer',
        notes: 'Verified offline and confirmed isolation.',
      });

      expect(signed.status).toBe('SIGNED_OFF');
      expect(signed.signoff).toBeDefined();
      expect(signed.signoff?.operatorId).toBe('auditor_lead');
      expect(signed.signoff?.role).toBe('Chief Sovereignty Officer');
      expect(signed.signoff?.signature).toMatch(/^[a-f0-9]{64}$/);

      // Verify signature validity
      const isValid = verifyBundleSignature(
        signed.bundleHash!,
        signed.signoff!,
      );
      expect(isValid).toBe(true);
    });

    it('supports HMAC-SHA256 signature when secretKey is provided', async () => {
      const secret = 'super-secret-operator-key-999';
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const signed = bundleService.signOffBundle(bundle.bundleId, {
        operatorId: 'auditor_hmac',
        secretKey: secret,
      });

      expect(signed.status).toBe('SIGNED_OFF');
      expect(verifyBundleSignature(signed.bundleHash!, signed.signoff!, secret)).toBe(true);
      // Fails with wrong key
      expect(verifyBundleSignature(signed.bundleHash!, signed.signoff!, 'wrong-key')).toBe(false);
    });
  });

  // ── 4. Offline Standalone Verifier ────────────────────────────────
  describe('4. Offline Standalone Verifier (Pure In-Memory Evaluation)', () => {
    it('validates a complete signed-off bundle offline without network access', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        firewallPlan: evidence.firewallPlan,
        networkTrace: evidence.networkTrace,
        serviceMapping: evidence.serviceMapping,
        calculationTrace: evidence.calculationTrace,
        auditTrail: evidence.auditTrail,
        rustVerifier: evidence.rustVerifier,
        autoSignoff: {
          operatorId: 'auto_auditor',
          notes: 'Full pipeline verification signoff.',
        },
      });

      const verification = verifySovereigntyBundle(bundle);
      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
      expect(verification.errorCodes).toHaveLength(0);
      expect(verification.details.boundaryValid).toBe(true);
      expect(verification.details.endpointPolicyValid).toBe(true);
      expect(verification.details.firewallValid).toBe(true);
      expect(verification.details.networkTraceValid).toBe(true);
      expect(verification.details.serviceIdentityValid).toBe(true);
      expect(verification.details.calculationTraceValid).toBe(true);
      expect(verification.details.auditChainValid).toBe(true);
      expect(verification.details.rustVerifierValid).toBe(true);
      expect(verification.details.signoffValid).toBe(true);
      expect(verification.details.privacySafe).toBe(true);
    });

    it('allows verifying raw JSON string directly without object deserialization step', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        firewallPlan: evidence.firewallPlan,
        networkTrace: evidence.networkTrace,
        serviceMapping: evidence.serviceMapping,
        calculationTrace: evidence.calculationTrace,
        auditTrail: evidence.auditTrail,
        rustVerifier: evidence.rustVerifier,
        autoSignoff: { operatorId: 'raw_json_operator' },
      });

      const jsonStr = JSON.stringify(bundle);
      const verification = verifySovereigntyBundle(jsonStr);
      expect(verification.valid).toBe(true);
      expect(verification.bundleId).toBe(bundle.bundleId);
    });
  });

  // ── 5. Fail-Closed on Tampered Bundle Hash ──────────────────────────
  describe('5. Fail-Closed on Tampered Bundle Hash', () => {
    it('fails closed when any field in the bundle is modified without updating bundleHash', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        autoSignoff: { operatorId: 'auditor' },
      });

      const tampered: SovereigntyEvidenceBundle = {
        ...bundle,
        claims: ['Modified claim statement'],
      };

      const verification = verifySovereigntyBundle(tampered);
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_HASH_MISMATCH,
      );
    });
  });

  // ── 6. Fail-Closed on Tampered Boundary Hash ────────────────────────
  describe('6. Fail-Closed on Tampered Boundary Hash', () => {
    it('fails closed when boundary evidence has been tampered', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const tamperedBoundary: any = {
        ...evidence.boundary,
        monitoredProcesses: [], // Stripped monitored processes
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          boundary: tamperedBoundary,
        },
      };
      // Recompute bundle hash so bundle-level hash matches
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.BOUNDARY_HASH_MISMATCH,
      );
    });
  });

  // ── 7. Fail-Closed on Tampered Endpoint Policy Hash ──────────────────
  describe('7. Fail-Closed on Tampered Endpoint Policy Hash', () => {
    it('fails closed when endpoint policy evidence hash disagrees', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const tamperedPolicy: any = {
        ...evidence.endpointPolicy,
        disallowDnsResolution: false, // Altered policy
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          endpointPolicy: tamperedPolicy,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.ENDPOINT_POLICY_MISMATCH,
      );
    });
  });

  // ── 8. Fail-Closed on Tampered Firewall Evidence ────────────────────
  describe('8. Fail-Closed on Tampered Firewall Evidence', () => {
    it('fails closed when firewall plan hash is altered', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        firewallPlan: evidence.firewallPlan,
      });

      const tamperedPlan: any = {
        ...evidence.firewallPlan,
        rules: [], // Removed rules
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          firewallPlan: tamperedPlan,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.FIREWALL_EVIDENCE_TAMPERED,
      );
    });
  });

  // ── 9. Fail-Closed on Tampered Network Observation Trace ────────────
  describe('9. Fail-Closed on Tampered Network Observation Trace', () => {
    it('fails closed when network trace has violation or tampered hash', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        networkTrace: evidence.networkTrace,
      });

      const tamperedTrace: any = {
        ...evidence.networkTrace,
        summary: {
          ...evidence.networkTrace.summary,
          violationsCount: 1, // Violation present!
          allObservedLoopback: false,
        },
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          networkTrace: tamperedTrace,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.NETWORK_TRACE_TAMPERED,
      );
    });
  });

  // ── 10. Fail-Closed on Revoked Service Identity ─────────────────────
  describe('10. Fail-Closed on Revoked Service Identity', () => {
    it('fails closed when service identity mapping contains revoked processes', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        serviceMapping: evidence.serviceMapping,
      });

      const tamperedMapping: any = {
        ...evidence.serviceMapping,
        processes: [
          {
            ...evidence.serviceMapping.processes[0],
            status: 'revoked', // Trust revoked!
          },
        ],
      };
      tamperedMapping.mappingHash = computeCanonicalIdentityMappingHash(tamperedMapping);

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        hashes: {
          ...bundle.hashes,
          serviceMappingHash: tamperedMapping.mappingHash,
        },
        evidence: {
          ...bundle.evidence,
          serviceMapping: tamperedMapping,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.SERVICE_IDENTITY_REVOKED,
      );
    });
  });

  // ── 11. Fail-Closed on Invalid Calculation Trace ────────────────────
  describe('11. Fail-Closed on Invalid Calculation Trace', () => {
    it('fails closed when calculation trace is not authoritatively verified', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        calculationTrace: evidence.calculationTrace,
      });

      const unverifiedCalc: any = {
        ...evidence.calculationTrace,
        verification: { verified: false }, // Not verified!
      };
      unverifiedCalc.traceHash = computeCalculationTraceHash(unverifiedCalc);

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        hashes: {
          ...bundle.hashes,
          calculationTraceHash: unverifiedCalc.traceHash,
        },
        evidence: {
          ...bundle.evidence,
          calculationTrace: unverifiedCalc,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.UNVERIFIED_EVIDENCE,
      );
    });
  });

  // ── 12. Fail-Closed on Broken Audit Trail Chain ─────────────────────
  describe('12. Fail-Closed on Broken Audit Trail Chain', () => {
    it('fails closed when audit records sequence or previous_hash chain is corrupted', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        auditTrail: evidence.auditTrail,
      });

      const brokenAudit: any = {
        ...evidence.auditTrail,
        records: [
          evidence.auditTrail.records[0],
          {
            ...evidence.auditTrail.records[1],
            previous_hash: 'corrupted_broken_link', // Broken chain!
          },
        ],
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          auditTrail: brokenAudit,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.AUDIT_CHAIN_BROKEN,
      );
    });
  });

  // ── 13. Fail-Closed on Rust Verifier Mismatch ───────────────────────
  describe('13. Fail-Closed on Rust Verifier Mismatch', () => {
    it('fails closed when rust verifier is not verified or executable hash mismatches', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        rustVerifier: evidence.rustVerifier,
      });

      const tamperedRust: any = {
        ...evidence.rustVerifier,
        verified: false,
      };

      const tamperedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          rustVerifier: tamperedRust,
        },
      };
      (tamperedBundle as any).bundleHash = computeCanonicalBundleHash(tamperedBundle);

      const verification = verifySovereigntyBundle(tamperedBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.RUST_VERIFIER_MISMATCH,
      );
    });
  });

  // ── 14. Fail-Closed on Cross-Project Evidence References ───────────
  describe('14. Fail-Closed on Cross-Project Evidence References', () => {
    it('fails closed when evidence has a conflicting projectId', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const foreignPolicy = createIndustrialEndpointPolicy('other_project_999');

      const crossProjectBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          endpointPolicy: foreignPolicy,
        },
      };
      (crossProjectBundle as any).bundleHash = computeCanonicalBundleHash(crossProjectBundle);

      const verification = verifySovereigntyBundle(crossProjectBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.CROSS_PROJECT_REFERENCE,
      );
    });
  });

  // ── 15. Privacy-Safe Export & Epistemic Honesty Rules ───────────────
  describe('15. Privacy-Safe Export & Epistemic Honesty Rules', () => {
    it('fails closed when prohibited marketing claims exist in bundle', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        claims: ['MAOS guarantees 100% offline operating system and zero data left the machine.'],
      });

      const privacyCheck = assertPrivacySafeBundle(bundle);
      expect(privacyCheck.valid).toBe(false);
      expect(privacyCheck.violations.some((v) => v.includes('PROHIBITED_MARKETING_CLAIM'))).toBe(true);

      const verification = verifySovereigntyBundle(bundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.PROHIBITED_MARKETING_CLAIM,
      );
    });

    it('fails closed when unredacted sensitive tokens exist in bundle payload', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const leakingBundle: any = {
        ...bundle,
        evidence: {
          ...bundle.evidence,
          leakedTokenData: {
            apiKey: 'sk-ant-live-secret-unredacted-token-12345',
          },
        },
      };
      leakingBundle.bundleHash = computeCanonicalBundleHash(leakingBundle);

      const privacyCheck = assertPrivacySafeBundle(leakingBundle);
      expect(privacyCheck.valid).toBe(false);
      expect(privacyCheck.violations.some((v) => v.includes('SENSITIVE_DATA_DETECTED'))).toBe(true);

      const verification = verifySovereigntyBundle(leakingBundle, { allowDraft: true });
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.SENSITIVE_DATA_DETECTED,
      );
    });
  });

  // ── 16. Fail-Closed on Unsigned Releases Marked SIGNED_OFF ──────────
  describe('16. Fail-Closed on Unsigned Releases Marked SIGNED_OFF', () => {
    it('fails closed when bundle status is SIGNED_OFF but signoff is missing', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const fraudulentBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        status: 'SIGNED_OFF',
        signoff: undefined, // Missing signoff!
      };
      (fraudulentBundle as any).bundleHash = computeCanonicalBundleHash(fraudulentBundle);

      const verification = verifySovereigntyBundle(fraudulentBundle);
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.UNSIGNED_BUNDLE_MARKED_SIGNED_OFF,
      );
    });

    it('fails closed when operator signature does not match canonical bundle hash', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
      });

      const forgedBundle: SovereigntyEvidenceBundle = {
        ...bundle,
        status: 'SIGNED_OFF',
        signoff: {
          operatorId: 'malicious_actor',
          signedAt: new Date().toISOString(),
          signature: 'deadbeef'.repeat(8), // Forged signature!
        },
      };
      (forgedBundle as any).bundleHash = computeCanonicalBundleHash(forgedBundle);

      const verification = verifySovereigntyBundle(forgedBundle);
      expect(verification.valid).toBe(false);
      expect(verification.errorCodes).toContain(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.INVALID_OPERATOR_SIGNATURE,
      );
    });
  });

  // ── 17. Deterministic PKZIP Archive & Offline ZIP Verification ──────
  describe('17. Deterministic PKZIP Archive & Offline ZIP Verification', () => {
    it('generates a valid, deterministic ZIP archive containing bundle.json and evidence sub-files', async () => {
      const evidence = createSampleEvidence();
      const bundle = await bundleService.generateBundle({
        projectId: testProjectId,
        boundary: evidence.boundary,
        endpointPolicy: evidence.endpointPolicy,
        firewallPlan: evidence.firewallPlan,
        networkTrace: evidence.networkTrace,
        serviceMapping: evidence.serviceMapping,
        calculationTrace: evidence.calculationTrace,
        auditTrail: evidence.auditTrail,
        rustVerifier: evidence.rustVerifier,
        autoSignoff: { operatorId: 'zip_auditor' },
      });

      const { zipBuffer, zipPath } = bundleService.exportBundleArchive(bundle.bundleId);
      expect(fs.existsSync(zipPath)).toBe(true);
      expect(zipBuffer.length).toBeGreaterThan(0);

      // Verify that bundle.json can be extracted from ZIP in pure Node.js
      const extracted = extractBundleFromZip(zipBuffer);
      expect(extracted.bundleId).toBe(bundle.bundleId);
      expect(extracted.bundleHash).toBe(bundle.bundleHash);

      // Verify ZIP directly using standalone offline verifier
      const zipVerification = verifySovereigntyBundleZip(zipBuffer);
      expect(zipVerification.valid).toBe(true);
      expect(zipVerification.bundleId).toBe(bundle.bundleId);
      expect(zipVerification.details.signoffValid).toBe(true);
    });

    it('createDeterministicZip produces identical bytes for identical input entries', () => {
      const entries = [
        { path: 'manifest.json', content: '{"version": 1}' },
        { path: 'bundle.json', content: '{"bundle": true}' },
      ];

      const zip1 = createDeterministicZip(entries);
      // Pass in reverse order to ensure alphabetical sorting guarantees byte equivalence
      const zip2 = createDeterministicZip([entries[1], entries[0]]);

      expect(zip1.equals(zip2)).toBe(true);
    });
  });

  // ── 18. REST API Endpoints ──────────────────────────────────────────
  describe('18. REST API Endpoints (/api/v1/industrial/bundles/*)', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const router = new RestApiRouter(services, testTempDir);
      server = http.createServer(async (req, res) => {
        const handled = await router.handle(req, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('supports full lifecycle via REST: generate, list, get, sign-off, verify', async () => {
      // 1. Generate Bundle
      const genRes = await fetch(`${baseUrl}/api/v1/industrial/bundles/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: testProjectId }),
      });
      expect(genRes.status).toBe(201);
      const genBody = await genRes.json();
      expect(genBody.data.bundleId).toBeDefined();
      const bundleId = genBody.data.bundleId;

      // 2. List Bundles
      const listRes = await fetch(`${baseUrl}/api/v1/industrial/bundles`);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(Array.isArray(listBody.data)).toBe(true);
      expect(listBody.data.some((b: any) => b.bundleId === bundleId)).toBe(true);

      // 3. Get Bundle JSON
      const getRes = await fetch(`${baseUrl}/api/v1/industrial/bundles/${bundleId}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.data.bundleId).toBe(bundleId);

      // 4. Download Bundle Archive ZIP
      const archiveRes = await fetch(`${baseUrl}/api/v1/industrial/bundles/${bundleId}?archive=true`);
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.headers.get('content-type')).toBe('application/zip');
      const zipBytes = await archiveRes.arrayBuffer();
      expect(zipBytes.byteLength).toBeGreaterThan(0);

      // 5. Sign-off Bundle
      const signRes = await fetch(`${baseUrl}/api/v1/industrial/bundles/${bundleId}/sign-off`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operatorId: 'rest_api_auditor',
          notes: 'REST verified release.',
        }),
      });
      expect(signRes.status).toBe(200);
      const signBody = await signRes.json();
      expect(signBody.data.status).toBe('SIGNED_OFF');

      // 6. Verify Bundle
      const verifyRes = await fetch(`${baseUrl}/api/v1/industrial/bundles/${bundleId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(verifyRes.status).toBe(200);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.valid).toBe(true);
      expect(verifyBody.data.details.signoffValid).toBe(true);
    });
  });

  // ── 19. Canary & Cryptographic Invariants ───────────────────────────
  describe('19. Canary & Cryptographic Invariants', () => {
    it('strictly preserves the rust/test.txt canary SHA-256 hash', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(hash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
