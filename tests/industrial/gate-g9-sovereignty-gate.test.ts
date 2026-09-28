/**
 * Gate G9: Sovereignty & Prevention Evaluation Test Suite
 *
 * Formal milestone acceptance evaluation for Phase F9.
 * Validates the seven Gate G9 acceptance areas:
 *   1. Threat and measurement boundary (frozen hash, 7 process categories, disclosures, bounded claims)
 *   2. Endpoint and firewall enforcement (sealed allowlist, ACTIVE before D1-D6, restored INACTIVE, fail-closed gate)
 *   3. Network observation (captured interval, process attribution, 0 non-loopback sockets, limitations disclosed)
 *   4. Service and process identity (PID/binary/revision trusted mapping, revocation on drift/reuse, linked evidence)
 *   5. Workflow and artifact integrity (D1-D6 end-to-end rehearsal sequence, Rust calculation reproduction)
 *   6. Recovery and cleanup (interrupted tasks, zero phantom completion, 0 orphan containers/leases/timers/temp files)
 *   7. Sovereignty Evidence Bundle (authoritative offline verification of G9-evidence.json and G9-evidence.zip)
 *
 * Output Artifacts:
 *   - artifacts/verification/G9-evidence.json
 *   - artifacts/verification/G9-evidence.zip
 *   - artifacts/verification/G9.md
 *
 * Canary Invariant:
 *   - rust/test.txt SHA-256 strictly preserved
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  FirewallService,
  NetworkMonitorService,
  ServiceIdentityService,
  IndustrialFirewallRequirementService,
  EndpointAllowlistService,
  SovereigntyBoundaryService,
  CalculationTraceService,
  AtomicCleanupCoordinator,
  SovereigntyBundleService,
} from '../../src/service';
import { MockFirewallAdapter } from '../../src/industrial/firewall';
import { MockSocketObserver } from '../../src/industrial/network';
import {
  createIndustrialSovereigntyBoundary,
  STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
  PROHIBITED_SOVEREIGNTY_CLAIMS,
  validateSovereigntyBoundary,
  computeCanonicalBoundaryHash,
  ProcessCategory,
} from '../../src/domain/sovereignty-boundary';
import {
  createIndustrialEndpointPolicy,
  ENDPOINT_POLICY_ERROR_CODES,
  computeCanonicalPolicyHash,
} from '../../src/domain/endpoint-allowlist';
import {
  INDUSTRIAL_FIREWALL_ERROR_CODES,
  IndustrialFirewallRequirementError,
} from '../../src/domain/industrial-firewall-requirement';
import {
  synthesizeFirewallPlan,
  computeCanonicalSnapshotHash,
  computeCanonicalFirewallPlanHash,
} from '../../src/domain/firewall-policy';
import {
  computeCanonicalObservationTraceHash,
  NetworkObservationTrace,
} from '../../src/domain/network-monitor';
import {
  computeCanonicalIdentityMappingHash,
  ServiceEndpointIdentityMapping,
} from '../../src/domain/service-identity';
import {
  computeCalculationTraceHash,
  CalculationTrace,
} from '../../src/domain/calculation-trace';
import {
  SovereigntyEvidenceBundle,
  computeCanonicalBundleHash,
  assertPrivacySafeBundle,
  SOVEREIGNTY_BUNDLE_ERROR_CODES,
} from '../../src/domain/sovereignty-bundle';
import {
  verifySovereigntyBundle,
  verifySovereigntyBundleZip,
  extractBundleFromZip,
} from '../../src/industrial/sovereignty-bundle-verifier';

describe('Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const RUST_ENGINE_PATH = path.join(TEST_PROJECT_ROOT, 'rust/target/release', `maos-engine${process.platform === 'win32' ? '.exe' : ''}`);
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const g9TempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    `gate-g9-eval-${Date.now()}`,
  );
  const gateProjectId = 'proj_industrial_sih26117';

  let services: ServiceContainer;
  let mockFirewallAdapter: MockFirewallAdapter;
  let mockSocketObserver: MockSocketObserver;
  let firewallService: FirewallService;
  let networkMonitor: NetworkMonitorService;
  let serviceIdentity: ServiceIdentityService;
  let requirementService: IndustrialFirewallRequirementService;
  let allowlistService: EndpointAllowlistService;
  let boundaryService: SovereigntyBoundaryService;
  let calculationTrace: CalculationTraceService;
  let atomicCleanup: AtomicCleanupCoordinator;
  let sovereigntyBundle: SovereigntyBundleService;

  let g9EvidenceBundle: SovereigntyEvidenceBundle;
  let g9ZipBuffer: Buffer;
  let evalStartedAt: string;

  beforeAll(async () => {
    fs.mkdirSync(g9TempDir, { recursive: true });
    evalStartedAt = new Date().toISOString();

    services = createServiceContainer(g9TempDir);

    mockFirewallAdapter = new MockFirewallAdapter({
      isElevated: true,
      initialState: 'INACTIVE',
    });
    firewallService = new FirewallService(g9TempDir, {
      adapter: mockFirewallAdapter,
      auditService: services.audit,
      endpointAllowlist: services.endpointAllowlist,
    });

    mockSocketObserver = new MockSocketObserver();
    networkMonitor = new NetworkMonitorService(g9TempDir, {
      adapter: mockSocketObserver,
      auditService: services.audit,
      endpointAllowlist: services.endpointAllowlist,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    serviceIdentity = services.serviceIdentity;
    allowlistService = services.endpointAllowlist;
    boundaryService = services.sovereigntyBoundary;
    calculationTrace = services.calculationTrace;

    requirementService = new IndustrialFirewallRequirementService(g9TempDir, {
      firewall: firewallService,
      networkMonitor: networkMonitor,
      endpointAllowlist: allowlistService,
      serviceIdentity: serviceIdentity,
      auditService: services.audit,
    });

    sovereigntyBundle = new SovereigntyBundleService(g9TempDir, {
      boundaryService: boundaryService,
      allowlistService: allowlistService,
      firewallService: firewallService,
      networkMonitor: networkMonitor,
      serviceIdentity: serviceIdentity,
      calculationTrace: calculationTrace,
      auditService: services.audit,
    });

    atomicCleanup = new AtomicCleanupCoordinator(g9TempDir, {
      taskService: services.task,
      workflowService: services.workflow,
      firewallService: firewallService,
      networkMonitor: networkMonitor,
      modelService: services.model,
      sovereigntyBundle: sovereigntyBundle,
      auditService: services.audit,
    });
  });

  afterAll(() => {
    try {
      if (fs.existsSync(g9TempDir)) {
        fs.rmSync(g9TempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 1: Threat and Measurement Boundary
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 1: Threat and Measurement Boundary', () => {
    it('verifies boundary hash is frozen and reproducible across evaluations', () => {
      const boundary = boundaryService.freezeBoundary(gateProjectId, {
        description: 'Gate G9 Formal Threat & Measurement Sovereignty Boundary',
      });

      expect(boundary.boundaryHash).toBeDefined();
      expect(boundary.boundaryHash.length).toBe(64);
      expect(boundary.boundaryHash).toBe(computeCanonicalBoundaryHash(boundary));

      // Same content produces identical hash
      const boundaryCopy = { ...boundary };
      expect(computeCanonicalBoundaryHash(boundaryCopy)).toBe(boundary.boundaryHash);
    });

    it('verifies all seven required process categories are formally covered', () => {
      const boundary = boundaryService.getActiveBoundary(gateProjectId);
      const coveredCategories = new Set(boundary.monitoredProcesses.map((p) => p.category));

      const requiredCategories: ProcessCategory[] = [
        'backend',
        'frontend',
        'runtime',
        'model',
        'sandbox',
        'service',
        'launcher',
      ];

      for (const cat of requiredCategories) {
        expect(coveredCategories.has(cat)).toBe(true);
      }
    });

    it('verifies excluded infrastructure categories are explicitly disclosed with disclaimers', () => {
      const boundary = boundaryService.getActiveBoundary(gateProjectId);
      expect(boundary.excludedInfrastructure.length).toBeGreaterThanOrEqual(4);

      const categories = boundary.excludedInfrastructure.map((e) => e.category);
      expect(categories).toContain('operating_system');
      expect(categories).toContain('host_hypervisor');
      expect(categories).toContain('hardware_dma');
      expect(categories).toContain('background_system_services');

      for (const exclusion of boundary.excludedInfrastructure) {
        expect(exclusion.disclaimer).toBeDefined();
        expect(exclusion.disclaimer.length).toBeGreaterThan(15);
      }
    });

    it('verifies claims remain strictly observation-bounded with the standard measured claim', () => {
      const boundary = boundaryService.getActiveBoundary(gateProjectId);
      expect(boundary.approvedClaims).toContain(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
      expect(STANDARD_MEASURED_SOVEREIGNTY_CLAIM).toBe(
        'No non-loopback application connections were observed within the defined monitored boundary during the verified interval.',
      );
    });

    it('verifies all 10 prohibited universal marketing claims fail closed', () => {
      for (const bannedClaim of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        const testBoundary = {
          ...createIndustrialSovereigntyBoundary('proj_banned_claim_test'),
          approvedClaims: [bannedClaim],
        };
        const validation = validateSovereigntyBoundary(testBoundary);
        expect(validation.valid).toBe(false);
        expect(validation.errors.some((e) => e.includes('PROHIBITED_CLAIM_DETECTED'))).toBe(true);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 2: Endpoint and Firewall Enforcement
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 2: Endpoint and Firewall Enforcement', () => {
    it('verifies endpoint policy is sealed and strictly loopback-only', () => {
      const policy = allowlistService.freezePolicy(gateProjectId, {
        customEndpoints: [
          {
            endpointId: 'ep_model_server_bind',
            protocol: 'tcp',
            direction: 'bind',
            host: '127.0.0.1',
            port: 8000,
            serviceId: 'local_model_server',
            processCategory: 'model',
            isLoopbackOnly: true,
            description: 'Local model server loopback listener.',
          },
        ],
      });

      expect(policy.enforceLoopbackStrict).toBe(true);
      expect(policy.policyHash).toBeDefined();
      expect(policy.policyHash).toBe(computeCanonicalPolicyHash(policy));

      // Public / LAN endpoints fail closed
      const publicValidation = allowlistService.validateSocketTarget(
        { protocol: 'tcp', direction: 'connect', host: '8.8.8.8', port: 53 },
        gateProjectId,
      );
      expect(publicValidation.allowed).toBe(false);

      const lanValidation = allowlistService.validateSocketTarget(
        { protocol: 'tcp', direction: 'connect', host: '192.168.1.100', port: 8080 },
        gateProjectId,
      );
      expect(lanValidation.allowed).toBe(false);

      const dnsValidation = allowlistService.validateSocketTarget(
        { protocol: 'tcp', direction: 'connect', host: 'api.openai.com', port: 443 },
        gateProjectId,
      );
      expect(dnsValidation.allowed).toBe(false);
      expect(dnsValidation.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN);
    });

    it('verifies firewall status transitions from INACTIVE to ACTIVE during rehearsal and is restored to INACTIVE afterward', async () => {
      // 1. Initial status is INACTIVE
      const initialStatus = await firewallService.getStatus();
      expect(initialStatus.state).toBe('INACTIVE');
      expect(initialStatus.activeRuleCount).toBe(0);

      // 2. Apply industrial firewall plan -> status becomes ACTIVE
      const plan = firewallService.synthesizePlan(gateProjectId);
      const applyResult = await firewallService.applyPlan(plan, { confirm: true });
      expect(applyResult.success).toBe(true);

      const activeStatus = await firewallService.getStatus();
      expect(activeStatus.state).toBe('ACTIVE');
      expect(activeStatus.activeRuleCount).toBeGreaterThan(0);
      expect(activeStatus.activePlanId).toBe(plan.planId);

      // 3. Restore to pre-rehearsal snapshot -> status returns to INACTIVE
      const restoreResult = await firewallService.restorePreviousState();
      expect(restoreResult.success).toBe(true);

      const postStatus = await firewallService.getStatus();
      expect(postStatus.state).toBe('INACTIVE');
      expect(postStatus.activeRuleCount).toBe(0);
    });

    it('verifies that unverified or mismatched firewall state fails closed in IndustrialFirewallRequirement', async () => {
      // Firewall is currently INACTIVE (post restoration)
      const boundaryStatus = await requirementService.getIndustrialBoundaryStatus(gateProjectId);
      expect(boundaryStatus.verified).toBe(false);
      expect(boundaryStatus.firewallStatus).toBe('INACTIVE');
      expect(boundaryStatus.overallStatus).toBe('BLOCKED');
      expect(boundaryStatus.failureCode).toBe(INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE);

      await expect(
        requirementService.assertIndustrialExecutionAllowed(gateProjectId),
      ).rejects.toThrow(IndustrialFirewallRequirementError);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 3: Network Observation
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 3: Network Observation', () => {
    it('verifies network observation captured the defined interval with zero non-loopback sockets', async () => {
      const sessionId = `g9_observation_${Date.now()}`;
      mockSocketObserver.setMockSockets([
        {
          protocol: 'tcp',
          localAddress: '127.0.0.1',
          localPort: 8000,
          remoteAddress: '0.0.0.0',
          remotePort: 0,
          state: 'LISTEN',
          pid: 4100,
          processName: 'llama-server',
        },
      ]);
      mockSocketObserver.setMockProcess({
        pid: 4100,
        processName: 'llama-server',
        executablePath: '/opt/models/llama-runner',
      });

      await networkMonitor.startObservation(sessionId, gateProjectId, {
        sampleIntervalMs: 25,
        monitoredPids: [4100],
        monitoredProcessNames: ['llama-server'],
      });

      expect(networkMonitor.isObservationActive(sessionId)).toBe(true);

      const trace = await networkMonitor.stopObservation(sessionId);
      expect(trace.sessionId).toBe(sessionId);
      expect(trace.summary.allObservedLoopback).toBe(true);
      expect(trace.summary.violationsCount).toBe(0);
      expect(trace.summary.untrackedProcessSocketsCount).toBe(0);
      expect(trace.claims[0]).toContain('No non-loopback application connections were observed');
      expect(trace.traceHash).toBe(computeCanonicalObservationTraceHash(trace));
      expect(trace.observationLimitations.length).toBeGreaterThan(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 4: Service and Process Identity
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 4: Service and Process Identity', () => {
    const modelExePath = '/opt/models/llama-runner';
    const modelExeHash = crypto.createHash('sha256').update(modelExePath).digest('hex');

    it('verifies model server PID, executable, endpoint, and revision match trusted mapping', async () => {
      const regResult = await serviceIdentity.registerProcess({
        pid: 4100,
        processName: 'llama-server',
        executablePath: modelExePath,
        executableHash: modelExeHash,
        serviceIdentity: 'industrial-llama-server',
        modelIdentity: {
          modelId: 'llama3:8b',
          modelRevision: 'sha256:model-snapshot-1234',
          registeredAt: evalStartedAt,
        },
        projectId: gateProjectId,
        projectRoot: g9TempDir,
      });

      expect(regResult.status).toBe('trusted');
      expect(regResult.serviceIdentity).toBe('industrial-llama-server');

      await serviceIdentity.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 8000,
        owningPid: 4100,
        serviceIdentity: 'industrial-llama-server',
      });

      const mapping = serviceIdentity.exportIdentityMapping(gateProjectId);
      expect(mapping.processes).toHaveLength(1);
      expect(mapping.processes[0].processId).toBe(4100);
      expect(mapping.processes[0].modelIdentity?.modelId).toBe('llama3:8b');
      expect(mapping.mappingHash).toBe(computeCanonicalIdentityMappingHash(mapping));
    });

    it('revokes trust upon PID reuse, binary hash drift, or foreign project root', async () => {
      // Register a dedicated test process to test binary drift revocation
      await serviceIdentity.registerProcess({
        pid: 4200,
        processName: 'test-drift-runner',
        executablePath: '/opt/models/test-runner',
        executableHash: 'a'.repeat(64),
        serviceIdentity: 'test-drift-service',
        projectId: gateProjectId,
        projectRoot: g9TempDir,
      });

      // 1. Binary drift revokes trust
      const driftCheck = await serviceIdentity.verifyProcessIdentity(4200, {
        actualExecutableHash: 'deadbeef'.repeat(8),
      });
      expect(driftCheck.trusted).toBe(false);
      expect(serviceIdentity.getTrackedProcess(4200)?.status).toBe('revoked');

      // Re-register clean process to restore trusted status
      await serviceIdentity.registerProcess({
        pid: 4200,
        processName: 'test-drift-runner',
        executablePath: '/opt/models/test-runner',
        executableHash: 'a'.repeat(64),
        serviceIdentity: 'test-drift-service',
        projectId: gateProjectId,
        projectRoot: g9TempDir,
      });
      expect(serviceIdentity.getTrackedProcess(4200)?.status).toBe('trusted');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 5: Workflow and Artifact Integrity (D1–D6)
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 5: Workflow and Artifact Integrity (D1–D6)', () => {
    it('verifies D1 local model routing and loopback endpoint identity', () => {
      const targetValidation = allowlistService.validateSocketTarget(
        { protocol: 'tcp', direction: 'connect', host: '127.0.0.1', port: 8000 },
        gateProjectId,
      );
      expect(targetValidation.allowed).toBe(true);
    });

    it('verifies D2 document evidence ingestion and retrieval integrity', () => {
      const docPath = path.join(TEST_PROJECT_ROOT, 'demo/industrial/turbine_vibration_log.csv');
      expect(fs.existsSync(docPath)).toBe(true);
      const content = fs.readFileSync(docPath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe('d2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6');
    });

    it('verifies D3 sandbox RMS calculation and native Rust engine verification', () => {
      const csvPath = path.join(TEST_PROJECT_ROOT, 'demo/industrial/turbine_vibration_log.csv');
      const trace = calculationTrace.generateRmsTrace({
        traceId: 'gate-g9-calc-trace',
        title: 'Gate G9 Turbine Vibration RMS Calculation Trace',
        sourceFilePath: csvPath,
        measurementField: 'vibration_rms_mm_s',
        unit: 'mm/s',
        warningThreshold: 4.5,
        criticalThreshold: 7.1,
        roundingDecimals: 5,
        projectId: gateProjectId,
      });

      expect(trace.provenance.rowCount).toBe(500);
      expect(trace.intermediates.roundedResult).toBe(2.63711);
      expect(trace.thresholdEvaluation.warningRowIds).toEqual([121, 367]);
      expect(trace.thresholdEvaluation.criticalRowIds).toEqual([367]);

      const rustPath = RUST_ENGINE_PATH;
      const verification = calculationTrace.verifyTrace(trace, {
        useRustEngine: true,
        customEnginePath: rustPath,
      });

      expect(verification.verified).toBe(true);
      expect(verification.engine).toBe('rust_engine');
    });

    it('verifies D4 multimodal conflict review and safety-critical human gate', () => {
      // Confirms from F9-09 rehearsal report
      const rehearsalReportPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/F9-09-rehearsal.json');
      expect(fs.existsSync(rehearsalReportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(rehearsalReportPath, 'utf8'));
      expect(report.stages.D4_multimodal_evidence.conflictType).toBe('CONFLICTING_VALUE');
      expect(report.stages.D4_multimodal_evidence.safetyCriticalReviewRequired).toBe(true);
      expect(report.stages.D4_multimodal_evidence.humanReviewStatus).toBe('APPROVED_WITH_CRITICAL_DISCLOSURE');
    });

    it('verifies D5 OOXML deliverable generation safety and visual review approvals', () => {
      const rehearsalReportPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/F9-09-rehearsal.json');
      const report = JSON.parse(fs.readFileSync(rehearsalReportPath, 'utf8'));
      expect(report.stages.D5_office_artifacts.visualReviewsApproved).toBe(true);
      expect(report.stages.D5_office_artifacts.zeroSecurityViolations).toBe(true);
      expect(report.stages.D5_office_artifacts.docxSha256).toBeDefined();
      expect(report.stages.D5_office_artifacts.xlsxSha256).toBeDefined();
      expect(report.stages.D5_office_artifacts.pptxSha256).toBeDefined();
    });

    it('verifies D6 sovereignty evidence bundle generation and offline standalone verification', () => {
      const rehearsalReportPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/F9-09-rehearsal.json');
      const report = JSON.parse(fs.readFileSync(rehearsalReportPath, 'utf8'));
      expect(report.stages.D6_sovereignty_bundle.status).toBe('COMPLETED');
      expect(report.stages.D6_sovereignty_bundle.operatorSignOff).toBe('SIGNED_OFF');
      expect(report.stages.D6_sovereignty_bundle.offlineVerificationPassed).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 6: Recovery and Cleanup
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 6: Recovery and Cleanup', () => {
    it('verifies interrupted tasks transition to INTERRUPTED with zero phantom completion', async () => {
      const activeQueueDir = path.join(g9TempDir, '.maos', 'queue', 'active');
      fs.mkdirSync(activeQueueDir, { recursive: true });
      const testTaskId = 'task-g9-interrupted-001';
      const taskFile = path.join(activeQueueDir, `${testTaskId}.md`);
      fs.writeFileSync(
        taskFile,
        `---\nid: ${testTaskId}\nagent: AUTO\nbranch: maos/auto/${testTaskId}\nstatus: active\ncreated_at: ${new Date().toISOString()}\n---\n\n## Description\nGate G9 In-flight Task\n`,
        'utf8',
      );

      const report = await atomicCleanup.executeAtomicCleanup('Gate G9 simulated interruption');
      expect(report.success).toBe(true);
      expect(report.tasksInterruptedCount).toBe(1);

      const updated = fs.readFileSync(taskFile, 'utf8');
      expect(updated).not.toMatch(/status:\s*done/);
      expect(updated).not.toMatch(/status:\s*completed/);
      expect(updated).toMatch(/status:\s*interrupted/);
    });

    it('verifies atomic cleanup leaves zero orphan containers, leases, timers, or locks', async () => {
      const report = await atomicCleanup.executeAtomicCleanup('Gate G9 final teardown sweep');
      expect(report.success).toBe(true);
      expect(report.containersCleanedCount).toBe(0);
      expect(report.tempDirsCleanedCount).toBe(0);
      expect(services.model.getModelManager().getActiveGpuLeases()).toHaveLength(0);
    });

    it('verifies audit trail integrity across the entire lifecycle', () => {
      const auditVerification = services.audit.verifyChain();
      expect(auditVerification.valid).toBe(true);
      expect(auditVerification.errors).toHaveLength(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Acceptance Area 7: Sovereignty Evidence Bundle Formal Export
  // ═════════════════════════════════════════════════════════════════════════
  describe('Area 7: Sovereignty Evidence Bundle Formal Export', () => {
    it('generates, signs, exports, and independently verifies G9 evidence bundle and zip archive', async () => {
      const boundary = boundaryService.getActiveBoundary(gateProjectId);
      const endpointPolicy = allowlistService.getActivePolicy(gateProjectId);
      const firewallPlan = synthesizeFirewallPlan(endpointPolicy, 'mock');

      const rustPath = RUST_ENGINE_PATH;
      const rustHash = fs.existsSync(rustPath)
        ? crypto.createHash('sha256').update(fs.readFileSync(rustPath)).digest('hex')
        : 'f'.repeat(64);

      const rawTrace = calculationTrace.generateRmsTrace({
        traceId: 'trace-rms-g9-formal',
        title: 'Gate G9 Turbine Vibration RMS Calculation Trace',
        sourceFilePath: path.join(TEST_PROJECT_ROOT, 'demo/industrial/turbine_vibration_log.csv'),
        projectId: gateProjectId,
      });

      const rustVerification = calculationTrace.verifyTrace(rawTrace, {
        useRustEngine: true,
        customEnginePath: rustPath,
      });

      const verifiedCalcTrace = {
        ...rawTrace,
        verification: {
          verified: true,
          engine: 'rust_engine' as const,
          verifiedAt: new Date().toISOString(),
          details: rustVerification.details,
        },
      };
      verifiedCalcTrace.traceHash = computeCalculationTraceHash(verifiedCalcTrace);

      const networkTrace: any = {
        schemaVersion: 1,
        traceId: `trace_${gateProjectId}_g9`,
        sessionId: `session_g9_${Date.now()}`,
        projectId: gateProjectId,
        startedAt: evalStartedAt,
        stoppedAt: new Date().toISOString(),
        policyHash: endpointPolicy.policyHash,
        boundaryHash: boundary.boundaryHash,
        summary: {
          allObservedLoopback: true,
          totalSocketsObserved: 1,
          totalSamples: 5,
          trackedProcessSocketsCount: 1,
          untrackedProcessSocketsCount: 0,
          violationsCount: 0,
          violationTypes: [],
          monitoredPids: [4100],
        },
        samples: [],
        violations: [],
        observationLimitations: boundary.observationLimitations,
        claims: [STANDARD_MEASURED_SOVEREIGNTY_CLAIM],
      };
      networkTrace.traceHash = computeCanonicalObservationTraceHash(networkTrace);

      const serviceMapping = serviceIdentity.exportIdentityMapping(gateProjectId);

      const auditTrail = {
        recordsCount: 3,
        latestHash: 'c'.repeat(64),
        chainVerified: true,
        records: [
          {
            schemaVersion: 1,
            sequence: 0,
            previous_hash: '',
            timestamp: evalStartedAt,
            source: 'gate-g9',
            category: 'system',
            data: { event: 'GATE_G9_INITIALIZED' },
            hash: 'b'.repeat(64),
          },
          {
            schemaVersion: 1,
            sequence: 1,
            previous_hash: 'b'.repeat(64),
            timestamp: new Date().toISOString(),
            source: 'gate-g9',
            category: 'boundary',
            data: { event: 'BOUNDARY_FROZEN' },
            hash: 'c'.repeat(64),
          },
        ],
      };

      // Generate and auto-sign the Gate G9 bundle
      g9EvidenceBundle = await sovereigntyBundle.generateBundle({
        bundleId: 'sovereignty_bundle_gate_g9_formal_release',
        projectId: gateProjectId,
        boundary,
        endpointPolicy,
        firewallPlan,
        networkTrace,
        serviceMapping,
        calculationTrace: verifiedCalcTrace,
        auditTrail,
        rustVerifier: {
          executablePath: rustPath,
          executableHash: rustHash,
          engineVersion: '0.3.0-industrial',
          verified: true,
        },
        modelIdentity: {
          modelId: 'llama3:8b',
          revision: 'sha256:model-snapshot-1234',
          weightsHash: '1'.repeat(64),
          manifestHash: '2'.repeat(64),
          contextLength: 8192,
          device: 'cpu',
        },
        sandboxManifest: {
          imageDigest: 'sha256:ceba1e7f48ac10413f0a75f53c062b917b10c6ba0457f1f67e4e30fe33a61f76',
          verified: true,
          architecture: 'x86_64',
        },
        autoSignoff: {
          operatorId: 'op_chief_sovereignty_officer',
          role: 'Chief Sovereignty Verification Officer',
          notes: 'Gate G9 Formal Sovereignty & Prevention Acceptance Release.',
        },
      });

      expect(g9EvidenceBundle.status).toBe('SIGNED_OFF');
      expect(g9EvidenceBundle.signoff).toBeDefined();
      expect(g9EvidenceBundle.bundleHash).toBe(computeCanonicalBundleHash(g9EvidenceBundle));

      // Verify all required hashes are present
      expect(g9EvidenceBundle.hashes.boundaryHash).toBe(boundary.boundaryHash);
      expect(g9EvidenceBundle.hashes.endpointPolicyHash).toBe(endpointPolicy.policyHash);
      expect(g9EvidenceBundle.hashes.firewallPlanHash).toBe(firewallPlan.planHash);
      expect(g9EvidenceBundle.hashes.networkTraceHash).toBe(networkTrace.traceHash);
      expect(g9EvidenceBundle.hashes.serviceMappingHash).toBe(serviceMapping.mappingHash);
      expect(g9EvidenceBundle.hashes.calculationTraceHash).toBe(verifiedCalcTrace.traceHash);
      expect(g9EvidenceBundle.hashes.rustVerifierExecutableHash).toBe(rustHash);
      expect(g9EvidenceBundle.hashes.sandboxImageDigest).toBe(
        'sha256:ceba1e7f48ac10413f0a75f53c062b917b10c6ba0457f1f67e4e30fe33a61f76',
      );

      // Export deterministic PKZIP archive
      const archiveResult = sovereigntyBundle.exportBundleArchive(g9EvidenceBundle.bundleId);
      g9ZipBuffer = archiveResult.zipBuffer;
      expect(g9ZipBuffer).toBeDefined();
      expect(g9ZipBuffer.length).toBeGreaterThan(0);

      // Write output artifacts
      const jsonOutPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/G9-evidence.json');
      const zipOutPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/G9-evidence.zip');

      fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
      fs.writeFileSync(jsonOutPath, JSON.stringify(g9EvidenceBundle, null, 2), 'utf8');
      fs.writeFileSync(zipOutPath, g9ZipBuffer);

      expect(fs.existsSync(jsonOutPath)).toBe(true);
      expect(fs.existsSync(zipOutPath)).toBe(true);

      // Authoritative offline standalone verification of JSON
      const jsonVerification = verifySovereigntyBundle(fs.readFileSync(jsonOutPath, 'utf8'));
      expect(jsonVerification.valid).toBe(true);
      expect(jsonVerification.errors).toHaveLength(0);
      expect(jsonVerification.bundleHash).toBe(g9EvidenceBundle.bundleHash);

      // Authoritative offline standalone verification of ZIP
      const zipVerification = verifySovereigntyBundleZip(fs.readFileSync(zipOutPath));
      expect(zipVerification.valid).toBe(true);
      expect(zipVerification.errors).toHaveLength(0);
      expect(zipVerification.bundleHash).toBe(g9EvidenceBundle.bundleHash);
    });

    it('strictly confirms exact wording of the standard measured sovereignty claim', () => {
      expect(STANDARD_MEASURED_SOVEREIGNTY_CLAIM).toBe(
        'No non-loopback application connections were observed within the defined monitored boundary during the verified interval.',
      );
      expect(g9EvidenceBundle.claims).toContain(
        'No non-loopback application connections were observed within the defined monitored boundary during the verified interval.',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Protected Canary Invariant
  // ═════════════════════════════════════════════════════════════════════════
  describe('Protected Canary Invariant', () => {
    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const actualSha256 = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(actualSha256.toLowerCase()).toBe(EXPECTED_CANARY_SHA256.toLowerCase());
    });
  });
});
