/**
 * MAOS Industrial — F9-01: Freeze Threat and Measurement Boundary Test Suite
 *
 * Verifies the formal definition, cryptographic sealing, fail-closed validation,
 * and lifecycle management of the MAOS Threat & Measurement Boundary.
 *
 * Wording Invariant:
 * The system must NEVER claim:
 *   - "Zero data left the machine"
 *   - "The entire operating system is guaranteed offline"
 *   - "Universal host security"
 *   - "No network traffic of any kind"
 *
 * The system may ONLY claim measured facts:
 *   - "No non-loopback application connections were observed within the
 *      defined monitored boundary during the verified interval."
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  SovereigntyBoundaryService,
} from '../../src/service';
import {
  SovereigntyBoundary,
  PROHIBITED_SOVEREIGNTY_CLAIMS,
  STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
  STANDARD_REDACTED_AUDIT_FIELDS,
  STANDARD_CAPTURED_IDENTITY,
  STANDARD_OBSERVATION_LIMITATIONS,
  SOVEREIGNTY_BOUNDARY_ERROR_CODES,
  createIndustrialSovereigntyBoundary,
  validateSovereigntyBoundary,
  computeCanonicalBoundaryHash,
  SovereigntyBoundaryError,
} from '../../src/domain/sovereignty-boundary';

describe('F9-01: Threat and Measurement Boundary', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f901-' + Date.now(),
  );

  let services: ServiceContainer;

  beforeAll(() => {
    // Ensure test temporary directory exists
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
    services = createServiceContainer(testTempDir);
  });

  afterAll(() => {
    // Clean up temporary directory
    if (fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  });

  // ── 1. Boundary Generation & Determinism ──────────────────────────

  describe('1. Boundary Generation & Determinism', () => {
    it('creates standard industrial boundary with schemaVersion=1 and all required fields', () => {
      const boundary = createIndustrialSovereigntyBoundary('proj-alpha');

      expect(boundary.schemaVersion).toBe(1);
      expect(boundary.projectId).toBe('proj-alpha');
      expect(boundary.profileMode).toBe('industrial');
      expect(boundary.boundaryId).toBeDefined();
      expect(boundary.boundaryHash).toBeDefined();
      expect(boundary.boundaryHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify all 7 required monitored process categories
      const categories = boundary.monitoredProcesses.map((p) => p.category);
      expect(categories).toContain('backend');
      expect(categories).toContain('frontend');
      expect(categories).toContain('runtime');
      expect(categories).toContain('model');
      expect(categories).toContain('sandbox');
      expect(categories).toContain('service');
      expect(categories).toContain('launcher');
      expect(boundary.monitoredProcesses.length).toBeGreaterThanOrEqual(7);

      // Verify all 5 required exclusion categories
      const exclusionCategories = boundary.excludedInfrastructure.map((e) => e.category);
      expect(exclusionCategories).toContain('operating_system');
      expect(exclusionCategories).toContain('host_hypervisor');
      expect(exclusionCategories).toContain('hardware_dma');
      expect(exclusionCategories).toContain('background_system_services');
      expect(exclusionCategories).toContain('unmonitored_user_processes');

      // Verify approved loopback endpoints
      expect(boundary.approvedEndpoints.length).toBeGreaterThanOrEqual(3);
      for (const ep of boundary.approvedEndpoints) {
        expect(ep.isLoopbackOnly).toBe(true);
      }

      // Verify measurement interval initialized active
      expect(boundary.measurementInterval.isActive).toBe(true);
      expect(boundary.measurementInterval.startCondition).toBe('PROJECT_SESSION_INITIALIZED');
      expect(boundary.measurementInterval.endCondition).toBe('PROJECT_SESSION_CLOSED');
      expect(boundary.measurementInterval.startedAt).toBeDefined();

      // Verify approved claim is the measured factual claim
      expect(boundary.approvedClaims).toEqual([STANDARD_MEASURED_SOVEREIGNTY_CLAIM]);
    });

    it('computes deterministic canonical SHA-256 hash regardless of object key order', () => {
      const fixedDate = '2026-09-24T12:00:00.000Z';
      const boundaryA = createIndustrialSovereigntyBoundary('proj-det', {
        boundaryId: 'boundary-fixed-1',
        startedAt: fixedDate,
      });

      // Construct identical boundary payload with rearranged keys
      const rearranged: any = {
        profileMode: boundaryA.profileMode,
        createdAt: boundaryA.createdAt,
        boundaryId: boundaryA.boundaryId,
        schemaVersion: boundaryA.schemaVersion,
        measurementInterval: {
          isActive: boundaryA.measurementInterval.isActive,
          startCondition: boundaryA.measurementInterval.startCondition,
          endCondition: boundaryA.measurementInterval.endCondition,
          intervalId: boundaryA.measurementInterval.intervalId,
          startedAt: boundaryA.measurementInterval.startedAt,
        },
        projectId: boundaryA.projectId,
        monitoredProcesses: boundaryA.monitoredProcesses,
        approvedEndpoints: boundaryA.approvedEndpoints,
        excludedInfrastructure: boundaryA.excludedInfrastructure,
        redactedAuditFields: boundaryA.redactedAuditFields,
        approvedClaims: boundaryA.approvedClaims,
        observationLimitations: boundaryA.observationLimitations,
        capturedIdentity: boundaryA.capturedIdentity,
      };

      const hashA = computeCanonicalBoundaryHash(boundaryA);
      const hashB = computeCanonicalBoundaryHash(rearranged);

      expect(hashA).toBe(hashB);
      expect(hashA).toBe(boundaryA.boundaryHash);
    });
  });

  // ── 2. Scope Sensitivity & Cryptographic Hash ─────────────────────

  describe('2. Scope Sensitivity & Tamper Evidence', () => {
    it('alters canonical hash when monitored processes are modified', () => {
      const base = createIndustrialSovereigntyBoundary('proj-scope', {
        boundaryId: 'boundary-test-mod',
        startedAt: '2026-09-24T12:00:00.000Z',
      });
      const originalHash = computeCanonicalBoundaryHash(base);

      // Modify a process name
      const modifiedProcs = base.monitoredProcesses.map((p, idx) =>
        idx === 0 ? { ...p, name: 'maos_backend_tampered' } : p,
      );
      const modifiedBoundary = { ...base, monitoredProcesses: modifiedProcs };
      const newHash = computeCanonicalBoundaryHash(modifiedBoundary);

      expect(newHash).not.toBe(originalHash);
    });

    it('alters canonical hash when approved endpoints are modified', () => {
      const base = createIndustrialSovereigntyBoundary('proj-scope', {
        boundaryId: 'boundary-test-mod',
        startedAt: '2026-09-24T12:00:00.000Z',
      });
      const originalHash = computeCanonicalBoundaryHash(base);

      const modifiedEndpoints = [
        ...base.approvedEndpoints,
        {
          endpointId: 'ep_extra_loopback',
          protocol: 'tcp' as const,
          hostPattern: '127.0.0.99',
          portRange: '8080',
          isLoopbackOnly: true,
          description: 'Extra test endpoint',
        },
      ];
      const modifiedBoundary = { ...base, approvedEndpoints: modifiedEndpoints };
      const newHash = computeCanonicalBoundaryHash(modifiedBoundary);

      expect(newHash).not.toBe(originalHash);
    });

    it('fails closed when boundaryHash does not match computed canonical hash', () => {
      const boundary = createIndustrialSovereigntyBoundary('proj-tamper');
      const tampered = {
        ...boundary,
        boundaryHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const result = validateSovereigntyBoundary(tampered);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Boundary hash mismatch'))).toBe(true);
    });
  });

  // ── 3. Ambiguous or Missing Scope Rejection ────────────────────────

  describe('3. Ambiguous or Missing Scope Rejection (Fail-Closed)', () => {
    it('throws SovereigntyBoundaryError if projectId is empty or whitespace', () => {
      expect(() => createIndustrialSovereigntyBoundary('')).toThrow(SovereigntyBoundaryError);
      expect(() => createIndustrialSovereigntyBoundary('   ')).toThrow(SovereigntyBoundaryError);

      try {
        createIndustrialSovereigntyBoundary('');
      } catch (err: any) {
        expect(err.code).toBe(SOVEREIGNTY_BOUNDARY_ERROR_CODES.AMBIGUOUS_SCOPE);
      }
    });

    it('rejects boundary when schemaVersion is invalid or missing', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-schema');
      const invalid = { ...valid, schemaVersion: 2 };
      const res = validateSovereigntyBoundary(invalid);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Invalid schemaVersion'))).toBe(true);
    });

    it('rejects boundary when monitoredProcesses is empty or omitted', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-empty-proc');
      const emptyProcs = { ...valid, monitoredProcesses: [] };
      const res = validateSovereigntyBoundary(emptyProcs);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('monitoredProcesses must be a non-empty array'))).toBe(
        true,
      );
    });

    it('rejects boundary when any required process category is omitted', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-missing-cat');
      // Omit 'sandbox' process
      const missingSandbox = {
        ...valid,
        monitoredProcesses: valid.monitoredProcesses.filter((p) => p.category !== 'sandbox'),
      };
      const res = validateSovereigntyBoundary(missingSandbox);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('missing required process category "sandbox"'))).toBe(
        true,
      );
    });

    it('rejects non-object or null input as invalid boundary', () => {
      expect(validateSovereigntyBoundary(null).valid).toBe(false);
      expect(validateSovereigntyBoundary(undefined).valid).toBe(false);
      expect(validateSovereigntyBoundary('not an object').valid).toBe(false);
      expect(validateSovereigntyBoundary([]).valid).toBe(false);
    });
  });

  // ── 4. Endpoint Allowlist & Loopback Invariant ─────────────────────

  describe('4. Endpoint Allowlist & Loopback Invariant', () => {
    it('rejects endpoint with isLoopbackOnly=false', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-non-loopback');
      const badEndpoint = {
        ...valid,
        approvedEndpoints: [
          ...valid.approvedEndpoints,
          {
            endpointId: 'ep_external',
            protocol: 'tcp' as const,
            hostPattern: '127.0.0.1',
            isLoopbackOnly: false,
            description: 'Non-loopback test',
          },
        ],
      };
      const res = validateSovereigntyBoundary(badEndpoint);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('must have isLoopbackOnly=true'))).toBe(true);
    });

    it('rejects non-loopback host patterns (public IP, remote host, 0.0.0.0)', () => {
      const forbiddenPatterns = [
        '0.0.0.0',
        '192.168.1.50',
        '10.0.0.1',
        '8.8.8.8',
        'api.openai.com',
        'huggingface.co',
        '*',
      ];

      for (const pattern of forbiddenPatterns) {
        const valid = createIndustrialSovereigntyBoundary('proj-forb-ep');
        const badEndpoint = {
          ...valid,
          approvedEndpoints: [
            ...valid.approvedEndpoints,
            {
              endpointId: `ep_bad_${pattern.replace(/[^a-zA-Z0-9]/g, '_')}`,
              protocol: 'tcp' as const,
              hostPattern: pattern,
              isLoopbackOnly: true, // falsely claiming loopback
              description: 'External host attempt',
            },
          ],
        };
        const res = validateSovereigntyBoundary(badEndpoint);
        expect(res.valid).toBe(false);
        expect(
          res.errors.some((e) => e.includes(`Non-loopback endpoint pattern "${pattern}" is forbidden`)),
        ).toBe(true);
      }
    });

    it('permits approved loopback host patterns (127.0.0.1, ::1, localhost, npipe)', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-ok-loopback');
      const res = validateSovereigntyBoundary(valid);
      expect(res.valid).toBe(true);
      expect(res.errors.length).toBe(0);
    });
  });

  // ── 5. Excluded Infrastructure Disclosure ─────────────────────────

  describe('5. Excluded Infrastructure Disclosure', () => {
    it('requires explicit disclosure of all 5 out-of-scope infrastructure categories', () => {
      const requiredCategories = [
        'operating_system',
        'host_hypervisor',
        'hardware_dma',
        'background_system_services',
        'unmonitored_user_processes',
      ];

      for (const missingCat of requiredCategories) {
        const valid = createIndustrialSovereigntyBoundary('proj-missing-exc');
        const filteredExclusions = valid.excludedInfrastructure.filter(
          (e) => e.category !== missingCat,
        );
        const badBoundary = {
          ...valid,
          excludedInfrastructure: filteredExclusions,
        };
        const res = validateSovereigntyBoundary(badBoundary);
        expect(res.valid).toBe(false);
        expect(
          res.errors.some((e) =>
            e.includes(`Missing mandatory exclusion disclosure category: "${missingCat}"`),
          ),
        ).toBe(true);
      }
    });

    it('rejects boundary when excludedInfrastructure array is missing or empty', () => {
      const valid = createIndustrialSovereigntyBoundary('proj-no-exc');
      const bad = { ...valid, excludedInfrastructure: [] };
      const res = validateSovereigntyBoundary(bad);
      expect(res.valid).toBe(false);
      expect(
        res.errors.some((e) =>
          e.includes('excludedInfrastructure must explicitly disclose all out-of-scope host infrastructure'),
        ),
      ).toBe(true);
    });
  });

  // ── 6. Prohibited Claims vs. Measured Factual Statements ──────────

  describe('6. Prohibited Claims vs. Measured Factual Statements (Wording Invariant)', () => {
    it('strictly forbids all 10 prohibited marketing/universal claims', () => {
      for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        const valid = createIndustrialSovereigntyBoundary('proj-claim-test');
        const badBoundary = {
          ...valid,
          approvedClaims: [...valid.approvedClaims, `This system guarantees that ${prohibited}.`],
        };
        const res = validateSovereigntyBoundary(badBoundary);
        expect(res.valid).toBe(false);
        expect(
          res.errors.some(
            (e) =>
              e.includes('PROHIBITED_CLAIM_DETECTED') &&
              e.toLowerCase().includes(prohibited.toLowerCase()),
          ),
        ).toBe(true);
      }
    });

    it('service.validateClaim rejects prohibited claims and accepts measured factual claims', () => {
      const boundaryService = services.sovereigntyBoundary;

      // Check all prohibited phrases
      for (const phrase of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        const testClaim = `We ensure that ${phrase} across all operations.`;
        const res = boundaryService.validateClaim(testClaim);
        expect(res.allowed).toBe(false);
        expect(res.reason).toContain('PROHIBITED_CLAIM_DETECTED');
      }

      // Check permitted measured factual claim
      const goodRes = boundaryService.validateClaim(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
      expect(goodRes.allowed).toBe(true);

      // Check another measured statement
      const measuredStatement =
        'No egress network packets outside loopback 127.0.0.1 were logged by the process socket observer during step 3.';
      const secondGood = boundaryService.validateClaim(measuredStatement);
      expect(secondGood.allowed).toBe(true);
    });

    it('standard boundary uses only the verified measured claim', () => {
      const boundary = createIndustrialSovereigntyBoundary('proj-claim-std');
      expect(boundary.approvedClaims).toEqual([STANDARD_MEASURED_SOVEREIGNTY_CLAIM]);
      const res = validateSovereigntyBoundary(boundary);
      expect(res.valid).toBe(true);
    });
  });

  // ── 7. Cross-Project Boundary Isolation ───────────────────────────

  describe('7. Cross-Project Boundary Isolation', () => {
    it('fails closed when boundary projectId does not match expected context projectId', () => {
      const boundary = createIndustrialSovereigntyBoundary('project-alpha');
      const res = validateSovereigntyBoundary(boundary, {
        expectedProjectId: 'project-beta',
      });

      expect(res.valid).toBe(false);
      expect(
        res.errors.some((e) =>
          e.includes('Cross-project boundary violation: boundary belongs to project "project-alpha"'),
        ),
      ).toBe(true);
    });

    it('service.verifyBoundary enforces cross-project isolation', () => {
      const boundary = services.sovereigntyBoundary.freezeBoundary('project-isolated-1');
      const verification = services.sovereigntyBoundary.verifyBoundary(boundary, {
        expectedProjectId: 'project-isolated-2',
      });

      expect(verification.valid).toBe(false);
      expect(
        verification.errors.some((e) => e.includes('Cross-project boundary violation')),
      ).toBe(true);
    });
  });

  // ── 8. Service Persistence & Measurement Interval Lifecycle ───────

  describe('8. Service Persistence & Measurement Interval Lifecycle', () => {
    it('freezes, saves to disk, and retrieves active boundary', () => {
      const boundary = services.sovereigntyBoundary.freezeBoundary('proj-persisted');
      expect(boundary.projectId).toBe('proj-persisted');

      const loaded = services.sovereigntyBoundary.getActiveBoundary('proj-persisted');
      expect(loaded.boundaryId).toBe(boundary.boundaryId);
      expect(loaded.boundaryHash).toBe(boundary.boundaryHash);
      expect(loaded.measurementInterval.isActive).toBe(true);
    });

    it('closes measurement interval and computes durationMs deterministically', async () => {
      const boundary = services.sovereigntyBoundary.freezeBoundary('proj-interval-test');
      expect(boundary.measurementInterval.isActive).toBe(true);

      // Short delay to have non-zero duration
      await new Promise((r) => setTimeout(r, 20));

      const closed = services.sovereigntyBoundary.closeMeasurementInterval(
        'proj-interval-test',
        'PROJECT_SESSION_CLOSED',
      );

      expect(closed.measurementInterval.isActive).toBe(false);
      expect(closed.measurementInterval.endedAt).toBeDefined();
      expect(closed.measurementInterval.durationMs).toBeGreaterThanOrEqual(0);
      expect(closed.measurementInterval.endCondition).toBe('PROJECT_SESSION_CLOSED');

      // Boundary hash is updated and valid
      const verification = services.sovereigntyBoundary.verifyBoundary(closed);
      expect(verification.valid).toBe(true);
    });

    it('returns already closed boundary without error if closeMeasurementInterval called again', () => {
      const closedFirst = services.sovereigntyBoundary.closeMeasurementInterval(
        'proj-interval-test',
        'PROJECT_SESSION_CLOSED',
      );
      const closedSecond = services.sovereigntyBoundary.closeMeasurementInterval(
        'proj-interval-test',
        'PROJECT_SESSION_CLOSED',
      );

      expect(closedSecond.measurementInterval.isActive).toBe(false);
      expect(closedSecond.boundaryHash).toBe(closedFirst.boundaryHash);
    });
  });

  // ── 9. Audit Trail & Redacted Sensitive Fields ────────────────────

  describe('9. Audit Trail & Redacted Sensitive Fields', () => {
    it('logs boundary lifecycle events with endpoint category and sovereignty-boundary source', () => {
      const audit = services.audit;
      const initialCount = audit.getRecords().length;

      services.sovereigntyBoundary.freezeBoundary('proj-audit-test');
      services.sovereigntyBoundary.closeMeasurementInterval('proj-audit-test');

      const events = audit.getRecords().slice(initialCount);
      const boundaryEvents = events.filter((e) => e.source === 'sovereignty-boundary');

      expect(boundaryEvents.length).toBeGreaterThanOrEqual(2);
      expect(
        boundaryEvents.some((e) => (e.data as any)?.event === 'SOVEREIGNTY_BOUNDARY_FROZEN'),
      ).toBe(true);
      expect(
        boundaryEvents.some((e) => (e.data as any)?.event === 'SOVEREIGNTY_INTERVAL_CLOSED'),
      ).toBe(true);
    });

    it('verifies standard redacted audit fields protect secrets and prose prompts', () => {
      expect(STANDARD_REDACTED_AUDIT_FIELDS).toContain('apiKey');
      expect(STANDARD_REDACTED_AUDIT_FIELDS).toContain('authorization');
      expect(STANDARD_REDACTED_AUDIT_FIELDS).toContain('sessionToken');
      expect(STANDARD_REDACTED_AUDIT_FIELDS).toContain('promptProse');
      expect(STANDARD_REDACTED_AUDIT_FIELDS).toContain('secret');

      // Verify audit chain integrity remains valid
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);
    });
  });

  // ── 10. Invariants & Cryptographic Integrity ──────────────────────

  describe('10. Invariants & Cryptographic Integrity', () => {
    it('verifies rust/test.txt canary SHA-256 is strictly preserved', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const computedHash = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(computedHash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
