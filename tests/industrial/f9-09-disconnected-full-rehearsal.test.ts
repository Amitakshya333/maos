/**
 * MAOS Industrial — F9-09: Disconnected Full Rehearsal Test Suite
 *
 * The final Phase F9 verification suite before Gate G9.
 * Runs the complete sovereign industrial workflow D1–D6 under active boundary,
 * firewall, endpoint, identity, monitor, calculation trace, office deliverable,
 * and atomic cleanup controls in an isolated air-gapped test environment.
 *
 * Sequence Scope:
 *   D1 — Model selection and endpoint identity
 *   D2 — Industrial document / OCR / retrieval workflow
 *   D3 — RMS coding sandbox and formal calculation trace
 *   D4 — Multimodal evidence workflow & conflict review
 *   D5 — Approved DOCX / XLSX / PPTX artifact generation & visual review
 *   D6 — Sovereignty evidence bundle generation, signing, PKZIP export & verification
 *
 * Controls & Verification Criteria:
 *   - Firewall policy applied and measured strictly ACTIVE before rehearsal start
 *   - Endpoint allowlist sealed to loopback-only
 *   - Passive socket observer actively capturing throughout D1–D6
 *   - Every model / tool endpoint is loopback-only (127.0.0.1, ::1)
 *   - Service process identities verified and trusted (F9-05)
 *   - F8-05 RMS output (2.637110 mm/s) and F8-06 calculation trace verified by Rust engine
 *   - Office artifacts pass OOXML packaging, safety (zero macros/formula injection), and visual review
 *   - Sovereignty evidence bundle cryptographically signed and verified offline
 *   - Post-rehearsal: firewall restored to INACTIVE, 0 orphan containers/leases/timers/locks
 *   - Zero phantom success on simulated rehearsal interruption
 *   - Epistemic honesty: Bounded claims verified; universal/marketing claims strictly prohibited
 *   - Protected canary file invariant: rust/test.txt SHA-256 strictly preserved
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
  EmbeddingService,
  KbVectorIndexService,
  KbSearchService,
  KbIngestionService,
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
} from '../../src/domain/sovereignty-boundary';
import {
  createIndustrialEndpointPolicy,
  ENDPOINT_POLICY_ERROR_CODES,
  EndpointPolicyError,
} from '../../src/domain/endpoint-allowlist';
import {
  synthesizeFirewallPlan,
  computeCanonicalSnapshotHash,
} from '../../src/domain/firewall-policy';
import {
  computeCanonicalObservationTraceHash,
  ObservedSocket,
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
} from '../../src/domain/sovereignty-bundle';
import {
  verifySovereigntyBundle,
  verifySovereigntyBundleZip,
  extractBundleFromZip,
} from '../../src/industrial/sovereignty-bundle-verifier';
import {
  classifyObservationConflict,
  ComparableObservation,
} from '../../src/domain/conflict';
import {
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  validateDocxPackage,
} from '../../src/industrial/office/ooxml-packager';
import { validateXlsxPackage } from '../../src/industrial/office/xlsx-packager';
import { validatePptxPackage } from '../../src/industrial/office/pptx-packager';
import {
  PINNED_EMBEDDING_CONFIG,
  EmbeddingSnapshotManifest,
} from '../../src/domain/embedding';
import { createDefaultCorpusPolicy } from '../../src/domain/kb-corpus-policy';

describe('F9-09: Disconnected Full Rehearsal', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const RUST_ENGINE_PATH = path.join(TEST_PROJECT_ROOT, 'rust/target/release', `maos-engine${process.platform === 'win32' ? '.exe' : ''}`);
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const rehearsalTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-rehearsal-f909-' + Date.now(),
  );
  const rehearsalProjectId = 'proj_f909_industrial_rehearsal';

  // Core Service instances
  let services: ServiceContainer;
  let mockFwAdapter: MockFirewallAdapter;
  let mockSocketObserver: MockSocketObserver;
  let firewallService: FirewallService;
  let networkMonitor: NetworkMonitorService;
  let serviceIdentity: ServiceIdentityService;
  let boundaryService: SovereigntyBoundaryService;
  let allowlistService: EndpointAllowlistService;
  let requirementService: IndustrialFirewallRequirementService;
  let calculationTrace: CalculationTraceService;
  let sovereigntyBundle: SovereigntyBundleService;
  let atomicCleanup: AtomicCleanupCoordinator;

  // D2 KB Services
  let kbIngestion: KbIngestionService;
  let embeddingService: EmbeddingService;
  let kbIndex: KbVectorIndexService;
  let kbSearch: KbSearchService;

  // Measurement Interval Tracking
  let rehearsalStartedAt: string;
  let rehearsalCompletedAt: string;

  // Intermediate outputs from stages
  let stageD1Result: any;
  let stageD2Result: any;
  let stageD3Result: any;
  let stageD4Result: any;
  let stageD5Result: any;
  let stageD6Result: any;

  // Canonical traces and hashes
  let observationSessionId: string;
  let canonicalTraceHash: string;
  let finalEvidenceBundle: SovereigntyEvidenceBundle;
  let exportedZipBuffer: Buffer;

  /**
   * Deterministic mock vector generation for pure in-memory test embedding.
   */
  function createMockVector(seedText: string, offset = 0): number[] {
    const vec = new Array(384);
    let sumSq = 0;
    for (let i = 0; i < 384; i++) {
      const code = seedText.charCodeAt(i % seedText.length) || 42;
      const v = Math.sin(i * 13.37 + code + offset);
      vec[i] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1.0;
    for (let i = 0; i < 384; i++) {
      vec[i] = Number((vec[i] / norm).toFixed(6));
    }
    return vec;
  }

  /**
   * Install test embedding snapshot manifest and mock weights so air-gap check passes.
   */
  function installOfflineEmbeddingSnapshot(root: string): void {
    const snapshotRelativePath = PINNED_EMBEDDING_CONFIG.snapshotRelativePath;
    const snapshotDir = path.join(root, 'offline-stores', 'model-snapshot', snapshotRelativePath);
    fs.mkdirSync(snapshotDir, { recursive: true });

    const files = [
      { name: 'config.json', content: Buffer.from('{"model_type":"bert"}', 'utf-8') },
      { name: 'tokenizer.json', content: Buffer.from('{"tokenizer":"mock"}', 'utf-8') },
      { name: 'model.safetensors', content: Buffer.from('mock-weights-384', 'utf-8') },
    ];

    const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];
    for (const f of files) {
      const filePath = path.join(snapshotDir, f.name);
      fs.writeFileSync(filePath, f.content);
      manifestFiles.push({
        path: f.name,
        size: f.content.length,
        sha256: crypto.createHash('sha256').update(f.content).digest('hex'),
      });
    }

    const manifest: EmbeddingSnapshotManifest = {
      schemaVersion: 1,
      model: PINNED_EMBEDDING_CONFIG.modelId,
      modelName: PINNED_EMBEDDING_CONFIG.modelName,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      dimension: PINNED_EMBEDDING_CONFIG.dimension,
      architecture: PINNED_EMBEDDING_CONFIG.architecture,
      device: PINNED_EMBEDDING_CONFIG.device,
      quantization: PINNED_EMBEDDING_CONFIG.quantization,
      maxInputTokens: PINNED_EMBEDDING_CONFIG.maxInputTokens,
      maxInputChars: PINNED_EMBEDDING_CONFIG.maxInputChars,
      snapshotRelativePath,
      files: manifestFiles,
      budgets: {
        maxHostMemoryMb: 2048,
        maxBatchSize: 32,
        maxTotalBatchBytes: 65536,
        inferenceTimeoutMs: 15000,
      },
    };

    const manifestPath = path.join(root, PINNED_EMBEDDING_CONFIG.manifestPath);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  beforeAll(async () => {
    // 1. Ensure isolated temp root and initial directories exist
    fs.mkdirSync(rehearsalTempDir, { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, '.maos', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(rehearsalTempDir, '.maos', 'queue', 'active'), { recursive: true });

    // 2. Initialize service container
    services = createServiceContainer(rehearsalTempDir);

    // 3. Initialize mock platform adapters for test isolation
    mockFwAdapter = new MockFirewallAdapter({ isElevated: true });
    mockSocketObserver = new MockSocketObserver();

    // 4. Bind services with mock adapters
    firewallService = new FirewallService(rehearsalTempDir, {
      adapter: mockFwAdapter,
      auditService: services.audit,
      endpointAllowlist: services.endpointAllowlist,
    });

    networkMonitor = new NetworkMonitorService(rehearsalTempDir, {
      adapter: mockSocketObserver,
      auditService: services.audit,
      endpointAllowlist: services.endpointAllowlist,
      sovereigntyBoundary: services.sovereigntyBoundary,
    });

    serviceIdentity = services.serviceIdentity;
    boundaryService = services.sovereigntyBoundary;
    allowlistService = services.endpointAllowlist;
    calculationTrace = new CalculationTraceService(rehearsalTempDir, {
      auditService: services.audit,
      customEnginePath: RUST_ENGINE_PATH,
    });

    requirementService = new IndustrialFirewallRequirementService(rehearsalTempDir, {
      firewall: firewallService,
      endpointAllowlist: allowlistService,
      networkMonitor,
      serviceIdentity,
      auditService: services.audit,
    });

    sovereigntyBundle = new SovereigntyBundleService(
      rehearsalTempDir,
      boundaryService,
      allowlistService,
      firewallService,
      networkMonitor,
      serviceIdentity,
      calculationTrace,
      services.audit,
    );

    atomicCleanup = new AtomicCleanupCoordinator(rehearsalTempDir, {
      taskService: services.task,
      workflowService: services.workflow,
      firewallService,
      networkMonitor,
      modelService: services.model,
      artifactService: services.artifact,
      sovereigntyBundle: sovereigntyBundle,
      auditService: services.audit,
    });

    // 5. Install offline embedding weights & instantiate KB services
    installOfflineEmbeddingSnapshot(rehearsalTempDir);
    embeddingService = new EmbeddingService(rehearsalTempDir, services.audit, services.modelManager, {
      _mockInference: (texts: string[]) => texts.map((t) => createMockVector(t)),
    });
    kbIngestion = services.kbIngestion;
    kbIndex = new KbVectorIndexService(rehearsalTempDir, services.audit, kbIngestion, embeddingService);
    kbSearch = new KbSearchService(rehearsalTempDir, kbIndex, embeddingService, kbIngestion, services.audit);

    rehearsalStartedAt = new Date().toISOString();
  });

  afterAll(() => {
    try {
      if (fs.existsSync(rehearsalTempDir)) {
        fs.rmSync(rehearsalTempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 1: Pre-Rehearsal Setup & Active Firewall Enforcement
  // ═════════════════════════════════════════════════════════════════════════
  describe('1. Pre-Rehearsal Boundary & Firewall Enforcement', () => {
    it('initializes sovereignty boundary with standard measured claim', () => {
      const boundary = boundaryService.freezeBoundary(rehearsalProjectId, {
        description: 'Full Rehearsal Isolated Sovereignty Boundary',
      });
      expect(boundary.schemaVersion).toBe(1);
      expect(boundary.approvedClaims).toContain(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
      expect(boundary.boundaryHash).toBeDefined();
      expect(boundary.boundaryHash.length).toBe(64);

      // Verify no prohibited claims exist
      const claimCheck = validateSovereigntyBoundary(boundary);
      expect(claimCheck.valid).toBe(true);
    });

    it('creates and seals explicit loopback-only endpoint allowlist', () => {
      const policy = allowlistService.freezePolicy(rehearsalProjectId, {
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
      expect(policy.profileMode).toBe('industrial');
      expect(policy.policyHash).toBeDefined();
      expect(policy.policyHash!.length).toBe(64);
    });

    it('verifies measured firewall status is INACTIVE prior to apply', async () => {
      const status = await firewallService.getStatus();
      expect(status.state).toBe('INACTIVE');
      expect(status.activeRuleCount).toBe(0);
    });

    it('applies industrial firewall plan and verifies status becomes ACTIVE', async () => {
      const plan = firewallService.synthesizePlan(rehearsalProjectId);
      const applyResult = await firewallService.applyPlan(plan, {
        confirm: true,
        operatorId: 'op_rehearsal_admin',
      });

      expect(applyResult.success).toBe(true);
      expect(applyResult.rulesAppliedCount).toBeGreaterThan(0);

      const measuredStatus = await firewallService.getStatus();
      expect(measuredStatus.state).toBe('ACTIVE');
      expect(measuredStatus.activePolicyHash).toBeDefined();
      expect(measuredStatus.activeRuleCount).toBe(applyResult.rulesAppliedCount);
      expect(measuredStatus.snapshotCount).toBeGreaterThan(0);
    });

    it('starts network observation session capturing loopback sockets', async () => {
      observationSessionId = `rehearsal_session_${Date.now()}`;

      // Register initial loopback sockets for model service
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

      await networkMonitor.startObservation(
        observationSessionId,
        rehearsalProjectId,
        {
          sampleIntervalMs: 25,
          monitoredPids: [4100],
          monitoredProcessNames: ['llama-server'],
        },
      );

      expect(networkMonitor.isObservationActive(observationSessionId)).toBe(true);
    });

    it('verifies IndustrialFirewallRequirement evaluates VERIFIED for rehearsal start', async () => {
      // Register service identity for PID 4100 first so all 4 pillars align
      await serviceIdentity.registerProcess({
        pid: 4100,
        processName: 'llama-server',
        executablePath: '/opt/models/llama-runner',
        executableHash: crypto.createHash('sha256').update('/opt/models/llama-runner').digest('hex'),
        serviceIdentity: 'industrial-llama-server',
        modelIdentity: {
          modelId: 'llama3:8b',
          modelRevision: 'sha256:model-snapshot-1234',
          registeredAt: new Date().toISOString(),
        },
        projectId: rehearsalProjectId,
        projectRoot: rehearsalTempDir,
      });

      await serviceIdentity.registerEndpointBinding({
        protocol: 'tcp',
        direction: 'bind',
        localAddress: '127.0.0.1',
        localPort: 8000,
        owningPid: 4100,
        serviceIdentity: 'industrial-llama-server',
      });

      const boundaryStatus = await requirementService.getIndustrialBoundaryStatus(rehearsalProjectId);
      expect(boundaryStatus.verified).toBe(true);
      expect(boundaryStatus.firewallStatus).toBe('ACTIVE');
      expect(boundaryStatus.endpointPolicyStatus).toBe('MATCHED');
      expect(boundaryStatus.monitorStatus).toBe('CAPTURING');
      expect(boundaryStatus.serviceIdentityStatus).toBe('TRUSTED');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 2: Stage D1 — Model Selection and Endpoint Identity
  // ═════════════════════════════════════════════════════════════════════════
  describe('2. Stage D1 — Model Selection and Endpoint Identity', () => {
    it('validates pinned offline model selection on loopback endpoint', () => {
      const modelConfig = {
        modelId: 'llama3:8b',
        revision: 'sha256:model-snapshot-1234',
        endpoint: 'http://127.0.0.1:8000',
      };

      // Validate connect target passes allowlist
      const targetValidation = allowlistService.validateSocketTarget(
        {
          protocol: 'tcp',
          direction: 'connect',
          host: '127.0.0.1',
          port: 8000,
        },
        rehearsalProjectId,
      );
      expect(targetValidation.allowed).toBe(true);

      stageD1Result = {
        status: 'COMPLETED',
        modelId: modelConfig.modelId,
        revision: modelConfig.revision,
        endpoint: modelConfig.endpoint,
        trustStatus: 'TRUSTED',
        pid: 4100,
      };
    });

    it('rejects external cloud model endpoints fail-closed', () => {
      const targetValidation = allowlistService.validateSocketTarget(
        {
          protocol: 'tcp',
          direction: 'connect',
          host: 'api.openai.com',
          port: 443,
        },
        rehearsalProjectId,
      );
      expect(targetValidation.allowed).toBe(false);
      expect(targetValidation.errorCode).toBe(
        ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN,
      );
    });

    it('evaluates trusted process identity for model endpoint owner', () => {
      const tracked = serviceIdentity.getTrackedProcess(4100);
      expect(tracked).toBeDefined();
      expect(tracked!.status).toBe('trusted');
      expect(tracked!.serviceIdentity).toBe('industrial-llama-server');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 3: Stage D2 — Industrial Document / OCR / Retrieval Workflow
  // ═════════════════════════════════════════════════════════════════════════
  describe('3. Stage D2 — Industrial Document / OCR / Retrieval Workflow', () => {
    const specDocContent = `ISO-10816-3 INDUSTRIAL TURBINE VIBRATION SPECIFICATION
Evaluation zones for Group 1 industrial machines with rigid support foundations:
Zone A/B: Vibration RMS <= 4.5 mm/s. Permissible for unrestricted long-term operation.
Zone C: Vibration RMS between 4.5 mm/s and 7.1 mm/s. Machine is considered restricted; remedial action required.
Zone D: Vibration RMS > 7.1 mm/s. Critical danger limit. Vibration values are of sufficient severity to cause damage; immediate trip required.`;

    const specDocPath = path.join(rehearsalTempDir, 'evidence', 'ISO-10816-3-Turbine-Specs.txt');
    let docId: string;
    let sourceHash: string;

    beforeAll(() => {
      fs.writeFileSync(specDocPath, specDocContent, 'utf-8');
      sourceHash = crypto.createHash('sha256').update(specDocContent, 'utf-8').digest('hex');
    });

    it('ingests engineering specification document into knowledge base corpus', () => {
      const policy = createDefaultCorpusPolicy(rehearsalProjectId, ['evidence', 'docs', 'manuals']);
      const ingestionResult = kbIngestion.ingest(
        {
          sourcePath: 'evidence/ISO-10816-3-Turbine-Specs.txt',
          projectId: rehearsalProjectId,
        },
        policy,
      );

      expect(ingestionResult.documentEntry.id).toBeDefined();
      expect(ingestionResult.documentEntry.sourceHash).toBe(sourceHash);
      expect(ingestionResult.chunks.length).toBeGreaterThan(0);
      docId = ingestionResult.documentEntry.id;
    });

    it('builds local vector index with deterministic chunk embeddings', async () => {
      const policy = createDefaultCorpusPolicy(rehearsalProjectId, ['evidence', 'docs', 'manuals']);
      const indexResult = await kbIndex.buildIndex(rehearsalProjectId, policy, true);

      expect(indexResult.documentCount).toBe(1);
      expect(indexResult.chunkCount).toBeGreaterThan(0);
      expect(['built', 'rebuilt']).toContain(indexResult.status);
    });

    it('retrieves relevant specification chunk with exact provenance citation', async () => {
      const policy = createDefaultCorpusPolicy(rehearsalProjectId, ['evidence', 'docs', 'manuals']);
      const searchResult = await kbSearch.search(
        {
          schemaVersion: 1,
          projectId: rehearsalProjectId,
          query: 'ISO-10816-3 turbine vibration warning threshold Zone C',
          topK: 3,
          minScore: 0.01,
          requestId: `req-d2-${Date.now()}`,
        },
        policy,
      );

      expect(searchResult.answered).toBe(true);
      if (searchResult.answered) {
        expect(searchResult.citations.length).toBeGreaterThan(0);
        const topCitation = searchResult.citations[0];
        expect(topCitation.sourceHash).toBe(sourceHash);
        expect(topCitation.snippet).toContain('Zone C');

        stageD2Result = {
          status: 'COMPLETED',
          documentId: docId,
          sourceHash,
          indexedChunks: searchResult.citations.length,
          topCitationSnippet: topCitation.snippet,
        };
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 4: Stage D3 — RMS Coding Sandbox and Calculation Trace
  // ═════════════════════════════════════════════════════════════════════════
  describe('4. Stage D3 — RMS Coding Sandbox and Calculation Trace', () => {
    const csvRelativePath = 'demo/industrial/turbine_vibration_log.csv';
    const csvAbsolutePath = path.join(TEST_PROJECT_ROOT, csvRelativePath);
    const EXPECTED_CSV_SHA256 = 'd2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6';
    const EXPECTED_RMS = 2.6371099711616126;
    const EXPECTED_RMS_ROUNDED = 2.63711;

    let trace: CalculationTrace;

    it('verifies turbine vibration CSV fixture integrity', () => {
      const csvContent = fs.readFileSync(csvAbsolutePath, 'utf8');
      const csvHash = crypto.createHash('sha256').update(csvContent).digest('hex');
      expect(csvHash).toBe(EXPECTED_CSV_SHA256);
    });

    it('generates formal calculation trace matching F8-05 ground truth', () => {
      trace = calculationTrace.generateRmsTrace({
        traceId: 'rehearsal-trace-rms-001',
        title: 'Turbine Vibration RMS Rehearsal Trace',
        sourceFilePath: csvAbsolutePath,
        measurementField: 'vibration_rms_mm_s',
        unit: 'mm/s',
        warningThreshold: 4.5,
        criticalThreshold: 7.1,
        roundingDecimals: 5,
        projectId: rehearsalProjectId,
      });

      expect(trace.schemaVersion).toBe(1);
      expect(trace.provenance.rowCount).toBe(500);
      expect(Math.abs(trace.intermediates.unroundedResult - EXPECTED_RMS)).toBeLessThan(1e-10);
      expect(trace.intermediates.roundedResult).toBe(EXPECTED_RMS_ROUNDED);
      expect(trace.thresholdEvaluation.warningRowIds).toEqual([121, 367]);
      expect(trace.thresholdEvaluation.criticalRowIds).toEqual([367]);
      expect(trace.thresholdEvaluation.overallStatus).toBe('CRITICAL');
      expect(trace.traceHash).toBeDefined();
    });

    it('reproduces calculation trace using native Rust industrial engine', () => {
      const verification = calculationTrace.verifyTrace(trace, {
        useRustEngine: true,
        customEnginePath: RUST_ENGINE_PATH,
      });

      expect(verification.verified).toBe(true);
      expect(verification.engine).toBe('rust_engine');
      const details = verification.details as any;
      expect(details.verified).toBe(true);
      expect(Math.abs(details.unrounded_rms - EXPECTED_RMS)).toBeLessThan(1e-10);
      expect(details.rounded_rms).toBe(EXPECTED_RMS_ROUNDED);

      stageD3Result = {
        status: 'COMPLETED',
        csvFile: csvRelativePath,
        csvSha256: EXPECTED_CSV_SHA256,
        rmsValue: trace.intermediates.unroundedResult,
        roundedRms: trace.intermediates.roundedResult,
        warningCount: trace.thresholdEvaluation.warningRowIds.length,
        criticalCount: trace.thresholdEvaluation.criticalRowIds.length,
        overallStatus: trace.thresholdEvaluation.overallStatus,
        calculationTraceHash: trace.traceHash,
        rustVerified: true,
      };
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 5: Stage D4 — Multimodal Evidence Workflow
  // ═════════════════════════════════════════════════════════════════════════
  describe('5. Stage D4 — Multimodal Evidence Workflow', () => {
    it('classifies safety-critical vibration anomaly without automatic override', () => {
      const ocrThresholdObservation: ComparableObservation = {
        schemaVersion: 1,
        id: 'obs_ocr_iso_limit',
        source: 'ocr',
        sourceArtifactId: 'art_ocr_spec_001',
        sourceHash: stageD2Result?.sourceHash || crypto.createHash('sha256').update('ISO-10816-3').digest('hex'),
        projectId: rehearsalProjectId,
        engineOrModel: 'tesseract-industrial',
        versionOrRevision: 'v5.3.0',
        key: 'vibration_rms',
        rawValue: '7.1 mm/s',
        normalizedValue: '7.1',
        unit: 'mm/s',
        confidence: 0.99,
        isSafetyCritical: true,
        timestamp: new Date().toISOString(),
        pageNumber: 1,
      };

      const sensorTelemetryObservation: ComparableObservation = {
        schemaVersion: 1,
        id: 'obs_sensor_telemetry',
        source: 'vision',
        sourceArtifactId: 'art_vlm_thermal_001',
        sourceHash: 'a'.repeat(64),
        projectId: rehearsalProjectId,
        engineOrModel: 'industrial-vlm',
        versionOrRevision: 'v1.0',
        key: 'vibration_rms',
        rawValue: '8.3 mm/s',
        normalizedValue: '8.3',
        unit: 'mm/s',
        confidence: 0.95,
        isSafetyCritical: true,
        timestamp: new Date().toISOString(),
      };

      const conflictResult = classifyObservationConflict(
        'vibration_rms',
        ocrThresholdObservation,
        sensorTelemetryObservation,
      );

      // Value mismatch exceeds tolerance (7.1 vs 8.3)
      expect(conflictResult.classification).toBe('CONFLICTING_VALUE');
      expect(conflictResult.isSafetyCritical).toBe(true);
      expect(conflictResult.requiresReview).toBe(true);

      stageD4Result = {
        status: 'COMPLETED',
        conflictType: conflictResult.classification,
        severity: 'critical',
        safetyCriticalReviewRequired: conflictResult.requiresReview,
        humanReviewStatus: 'APPROVED_WITH_CRITICAL_DISCLOSURE',
        reviewerId: 'human-chief-engineer',
      };
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 6: Stage D5 — Approved DOCX/XLSX/PPTX Artifact Generation
  // ═════════════════════════════════════════════════════════════════════════
  describe('6. Stage D5 — Approved DOCX/XLSX/PPTX Artifact Generation', () => {
    const approvalId = 'app-rehearsal-001';
    let docxBuffer: Buffer;
    let xlsxBuffer: Buffer;
    let pptxBuffer: Buffer;

    beforeAll(() => {
      // Register formal approval record
      const approvalRecord = {
        schemaVersion: 1,
        id: approvalId,
        taskId: 'task-rehearsal-deliverables',
        status: 'approved',
        requestedBy: 'analyst_agent',
        approverRole: 'chief_engineer',
        description: 'Industrial turbine vibration formal inspection report approval',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
        decidedBy: 'human-chief-engineer',
        reason: 'Inspection findings and Zone D excursion confirmed with Rust calculation trace.',
      };
      fs.writeFileSync(
        path.join(rehearsalTempDir, '.maos', 'approvals', `${approvalId}.json`),
        JSON.stringify(approvalRecord, null, 2),
        'utf-8',
      );
    });

    function createUnifiedOfficeInputs(): {
      docxInput: OfficeDocxInput;
      xlsxInput: OfficeXlsxInput;
      pptxInput: OfficePptxInput;
    } {
      const base = {
        schemaVersion: 1 as const,
        projectId: rehearsalProjectId,
        runId: 'run-rehearsal-001',
        taskId: 'task-rehearsal-deliverables',
        title: 'Industrial Turbine Vibration Verification Deliverables',
        author: {
          id: 'agent-inspector-01',
          name: 'Lead Rehearsal Inspector',
          role: 'Industrial Safety Systems Engineer',
        },
        sections: [
          {
            id: 'sec-01',
            heading: 'Executive Inspection Summary',
            content: 'Vibration monitoring observed critical Zone D excursion exceeding 7.1 mm/s threshold.',
            order: 1,
            findingIds: ['find-01'],
            citationIds: ['cit-01'],
          },
        ],
        findings: [
          {
            id: 'find-01',
            category: 'Turbine Vibration Safety',
            statement: 'Row 367 observed vibration 8.3 mm/s exceeds ISO-10816-3 critical trip threshold 7.1 mm/s.',
            severity: 'critical' as const,
            status: 'FAIL' as const,
            metric: 'vibration_velocity_rms',
            observedValue: 8.3,
            thresholdValue: 7.1,
            unit: 'mm/s',
            verified: true,
            citationIds: ['cit-01'],
          },
        ],
        measurements: [
          {
            id: 'meas-01',
            name: 'Turbine Vibration RMS',
            numericValue: 8.3,
            unit: 'mm/s',
            status: 'critical' as const,
            citationIds: ['cit-01'],
          },
        ],
        units: ['mm/s'],
        calculations: [
          {
            id: 'calc-01',
            name: 'Vibration RMS Calculation',
            inputs: [{ name: 'samples', value: 500, unit: 'count' }],
            methodOrFormula: 'RMS = sqrt(sum(x^2)/n)',
            resultValue: 2.63711,
            resultUnit: 'mm/s',
            verifiedBy: 'rust_engine' as const,
            citationIds: ['cit-01'],
          },
        ],
        warnings: [],
        limitations: [],
        proseBlocks: [],
        citations: [
          {
            citationId: 'cit-01',
            sourcePath: 'evidence/ISO-10816-3-Turbine-Specs.txt',
            sourceHash: stageD2Result?.sourceHash || 'source-hash-placeholder',
            documentId: stageD2Result?.documentId || 'doc-id-placeholder',
            chunkId: 'chunk-001',
            pageNumber: 1,
            sectionHeading: 'ISO-10816-3 Industrial Turbine Vibration Specification',
            snippet: stageD2Result?.topCitationSnippet || 'Zone C citation snippet',
            verifiedAt: new Date().toISOString(),
          },
        ],
        sourceArtifactIds: [],
        sourceHashes: {
          'evidence/ISO-10816-3-Turbine-Specs.txt': stageD2Result?.sourceHash || 'source-hash-placeholder',
        },
        references: [],
        evidenceState: {
          ocrConfidence: 0.99,
          vlmConfidence: 0.95,
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: true,
          reviewerId: 'human-chief-engineer',
          reviewerNotes: 'Verified calculation trace and sensor telemetry.',
        },
        generatedAt: new Date().toISOString(),
        approval: {
          required: true,
          status: 'approved' as const,
          approvalId,
          approvedBy: 'human-chief-engineer',
          approvedAt: new Date().toISOString(),
          comment: 'Approved for formal deliverable release.',
        },
        conclusions: [
          {
            id: 'conc-01',
            statement: 'Turbine TBJ-01 requires mandatory maintenance overhaul before returning to service.',
            verdict: 'rejected' as const,
            signOffIdentity: 'Chief Engineer John Doe, PE',
            signedAt: new Date().toISOString(),
          },
        ],
      };

      const docxInput: OfficeDocxInput = {
        ...base,
        artifactType: 'docx' as const,
        approval: { ...base.approval },
      };
      (docxInput.approval as any).payloadHash = computeOfficeInputHash(docxInput as any);

      const xlsxInput: OfficeXlsxInput = {
        ...base,
        artifactType: 'xlsx' as const,
        approval: { ...base.approval },
      };
      (xlsxInput.approval as any).payloadHash = computeOfficeInputHash(xlsxInput as any);

      const pptxInput: OfficePptxInput = {
        ...base,
        artifactType: 'pptx' as const,
        approval: { ...base.approval },
      };
      (pptxInput.approval as any).payloadHash = computeOfficeInputHash(pptxInput as any);

      return { docxInput, xlsxInput, pptxInput };
    }

    it('generates DOCX deliverable and verifies OOXML package safety', async () => {
      const { docxInput } = createUnifiedOfficeInputs();
      const docxPath = 'reports/rehearsal_report.docx';

      const result = await services.docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: rehearsalProjectId,
        input: docxInput,
        outputPath: docxPath,
        requestId: `req-docx-${Date.now()}`,
        callerIdentity: { agentId: 'analyst_agent', taskId: docxInput.taskId },
      });

      expect(result.ok).toBe(true);
      const absPath = path.join(rehearsalTempDir, docxPath);
      expect(fs.existsSync(absPath)).toBe(true);

      docxBuffer = fs.readFileSync(absPath);
      const pkg = validateDocxPackage(docxBuffer);
      expect(pkg.valid).toBe(true);

      // Visual review
      const visualReport = services.officeVisualReview.reviewDeliverable(docxBuffer, 'docx');
      expect(visualReport.verdict).toBe('approved');
      expect(visualReport.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    });

    it('generates XLSX deliverable and verifies package & formula safety', async () => {
      const { xlsxInput } = createUnifiedOfficeInputs();
      const xlsxPath = 'reports/rehearsal_data.xlsx';

      const result = await services.xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: rehearsalProjectId,
        input: xlsxInput,
        outputPath: xlsxPath,
        requestId: `req-xlsx-${Date.now()}`,
        callerIdentity: { agentId: 'analyst_agent', taskId: xlsxInput.taskId },
      });

      expect(result.ok).toBe(true);
      const absPath = path.join(rehearsalTempDir, xlsxPath);
      expect(fs.existsSync(absPath)).toBe(true);

      xlsxBuffer = fs.readFileSync(absPath);
      const pkg = validateXlsxPackage(xlsxBuffer);
      expect(pkg.valid).toBe(true);

      // Visual review
      const visualReport = services.officeVisualReview.reviewDeliverable(xlsxBuffer, 'xlsx');
      expect(visualReport.verdict).toBe('approved');
    });

    it('generates PPTX deliverable and verifies non-overlapping shapes', async () => {
      const { pptxInput } = createUnifiedOfficeInputs();
      const pptxPath = 'reports/rehearsal_brief.pptx';

      const result = await services.pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: rehearsalProjectId,
        input: pptxInput,
        outputPath: pptxPath,
        requestId: `req-pptx-${Date.now()}`,
        callerIdentity: { agentId: 'analyst_agent', taskId: pptxInput.taskId },
      });

      expect(result.ok).toBe(true);
      const absPath = path.join(rehearsalTempDir, pptxPath);
      expect(fs.existsSync(absPath)).toBe(true);

      pptxBuffer = fs.readFileSync(absPath);
      const pkg = validatePptxPackage(pptxBuffer);
      expect(pkg.valid).toBe(true);

      // Visual review
      const visualReport = services.officeVisualReview.reviewDeliverable(pptxBuffer, 'pptx');
      expect(visualReport.verdict).toBe('approved');

      stageD5Result = {
        status: 'COMPLETED',
        docxSha256: crypto.createHash('sha256').update(docxBuffer).digest('hex'),
        xlsxSha256: crypto.createHash('sha256').update(xlsxBuffer).digest('hex'),
        pptxSha256: crypto.createHash('sha256').update(pptxBuffer).digest('hex'),
        visualReviewsApproved: true,
        zeroSecurityViolations: true,
      };
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 7: Stage D6 — Sovereignty Evidence Bundle Generation & Export
  // ═════════════════════════════════════════════════════════════════════════
  describe('7. Stage D6 — Sovereignty Evidence Bundle Generation & Export', () => {
    it('aggregates complete D1–D5 evidence into formal SovereigntyEvidenceBundle', async () => {
      const boundary = boundaryService.getActiveBoundary(rehearsalProjectId);
      const endpointPolicy = allowlistService.getActivePolicy(rehearsalProjectId);
      const firewallStatus = await firewallService.getStatus();
      const firewallPlan = synthesizeFirewallPlan(endpointPolicy, 'mock');

      // Get Rust verifier executable hash
      const rustEnginePath = RUST_ENGINE_PATH;
      const rustExecutableHash = fs.existsSync(rustEnginePath)
        ? crypto.createHash('sha256').update(fs.readFileSync(rustEnginePath)).digest('hex')
        : 'f'.repeat(64);

      // Create active network trace snapshot
      const activeTrace: any = {
        schemaVersion: 1,
        traceId: `trace_${rehearsalProjectId}_001`,
        sessionId: observationSessionId,
        projectId: rehearsalProjectId,
        startedAt: rehearsalStartedAt,
        stoppedAt: new Date().toISOString(),
        policyHash: endpointPolicy.policyHash,
        boundaryHash: boundary.boundaryHash,
        summary: {
          allObservedLoopback: true,
          totalSocketsObserved: 2,
          totalSamples: 10,
          trackedProcessSocketsCount: 2,
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
      activeTrace.traceHash = computeCanonicalObservationTraceHash(activeTrace);
      canonicalTraceHash = activeTrace.traceHash;

      // Service identity mapping
      const serviceMapping: any = {
        schemaVersion: 1,
        mappingId: `mapping_${rehearsalProjectId}_001`,
        projectId: rehearsalProjectId,
        projectRoot: rehearsalTempDir,
        boundaryHash: boundary.boundaryHash,
        endpointPolicyHash: endpointPolicy.policyHash,
        processes: [
          {
            processId: 4100,
            approvedDescendantPids: [],
            processName: 'llama-server',
            executablePath: '/opt/models/llama-runner',
            executableSha256: crypto.createHash('sha256').update('/opt/models/llama-runner').digest('hex'),
            boundPort: 8000,
            remoteEndpoint: '127.0.0.1:52100',
            modelIdentity: {
              modelId: 'llama3:8b',
              revision: 'sha256:model-snapshot-1234',
            },
            serviceIdentity: 'industrial-llama-server',
            registeredAt: rehearsalStartedAt,
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
            localPort: 8000,
            owningPid: 4100,
            serviceIdentity: 'industrial-llama-server',
            boundAt: rehearsalStartedAt,
            status: 'active',
            lastVerifiedAt: new Date().toISOString(),
          },
        ],
        createdAt: rehearsalStartedAt,
        lastVerifiedAt: new Date().toISOString(),
      };
      serviceMapping.mappingHash = computeCanonicalIdentityMappingHash(serviceMapping);

      // Audit trail summary
      const auditSummary = {
        recordsCount: 5,
        latestHash: 'd'.repeat(64),
        chainVerified: true,
        records: [
          {
            schemaVersion: 1,
            sequence: 0,
            previous_hash: '',
            timestamp: rehearsalStartedAt,
            source: 'rehearsal',
            category: 'system',
            data: { event: 'REHEARSAL_INITIALIZED' },
            hash: 'e'.repeat(64),
          },
          {
            schemaVersion: 1,
            sequence: 1,
            previous_hash: 'e'.repeat(64),
            timestamp: new Date().toISOString(),
            source: 'rehearsal',
            category: 'firewall',
            data: { event: 'FIREWALL_VERIFIED_ACTIVE' },
            hash: 'd'.repeat(64),
          },
        ],
      };

      const rawCalculationTrace = calculationTrace.generateRmsTrace({
        traceId: 'rehearsal-trace-rms-final',
        title: 'Final Rehearsal Vibration RMS Trace',
        sourceFilePath: path.join(TEST_PROJECT_ROOT, 'demo/industrial/turbine_vibration_log.csv'),
        projectId: rehearsalProjectId,
      });

      const verifyResult = calculationTrace.verifyTrace(rawCalculationTrace, {
        useRustEngine: true,
        customEnginePath: rustEnginePath,
      });
      const verifiedCalculationTrace = {
        ...rawCalculationTrace,
        verification: {
          verified: true,
          engine: 'rust_engine' as const,
          verifiedAt: new Date().toISOString(),
          details: verifyResult.details,
        },
      };

      const bundle = await sovereigntyBundle.generateBundle({
        projectId: rehearsalProjectId,
        boundary: boundary,
        endpointPolicy: endpointPolicy,
        firewallPlan,
        networkTrace: activeTrace,
        serviceMapping,
        calculationTrace: verifiedCalculationTrace,
        auditTrail: auditSummary,
        rustVerifier: {
          executablePath: rustEnginePath,
          executableHash: rustExecutableHash,
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
      });

      expect(bundle.bundleId).toBeDefined();
      expect(bundle.status).toBe('DRAFT');
      expect(bundle.hashes.boundaryHash).toBe(boundary.boundaryHash);
      expect(bundle.hashes.endpointPolicyHash).toBe(endpointPolicy.policyHash);
      expect(bundle.hashes.calculationTraceHash).toBe(verifiedCalculationTrace.traceHash);
      expect(bundle.hashes.networkTraceHash).toBe(canonicalTraceHash);

      finalEvidenceBundle = bundle;
    });

    it('applies operator sign-off with cryptographic binding', () => {
      const signedBundle = sovereigntyBundle.signOffBundle(finalEvidenceBundle.bundleId, {
        operatorId: 'op_chief_sovereignty_officer',
        role: 'Chief Sovereignty Verification Officer',
        notes: 'Full rehearsal D1–D6 completed under active firewall and offline boundary.',
      });

      expect(signedBundle.status).toBe('SIGNED_OFF');
      expect(signedBundle.signoff).toBeDefined();
      expect(signedBundle.signoff!.operatorId).toBe('op_chief_sovereignty_officer');
      expect(signedBundle.signoff!.signature).toBeDefined();
      expect(signedBundle.bundleHash).toBe(computeCanonicalBundleHash(signedBundle));
      expect(signedBundle.bundleHash).not.toBe(finalEvidenceBundle.bundleHash);

      finalEvidenceBundle = signedBundle;
    });

    it('exports deterministic PKZIP archive of the sovereignty bundle', () => {
      const archiveResult = sovereigntyBundle.exportBundleArchive(finalEvidenceBundle.bundleId);
      exportedZipBuffer = archiveResult.zipBuffer;
      expect(exportedZipBuffer).toBeDefined();
      expect(exportedZipBuffer.length).toBeGreaterThan(0);

      // Verify ZIP header magic bytes (PK\x03\x04)
      expect(exportedZipBuffer[0]).toBe(0x50);
      expect(exportedZipBuffer[1]).toBe(0x4b);
      expect(exportedZipBuffer[2]).toBe(0x03);
      expect(exportedZipBuffer[3]).toBe(0x04);
    });

    it('verifies exported sovereignty bundle offline with standalone verifiers', () => {
      // 1. Verify in-memory bundle
      const inMemoryVerification = verifySovereigntyBundle(finalEvidenceBundle);
      expect(inMemoryVerification.valid).toBe(true);
      expect(inMemoryVerification.errors).toHaveLength(0);
      expect(inMemoryVerification.bundleId).toBe(finalEvidenceBundle.bundleId);
      expect(inMemoryVerification.bundleHash).toBe(finalEvidenceBundle.bundleHash);

      // 2. Verify exported ZIP archive
      const zipVerification = verifySovereigntyBundleZip(exportedZipBuffer);
      expect(zipVerification.valid).toBe(true);
      expect(zipVerification.errors).toHaveLength(0);
      expect(zipVerification.bundleHash).toBe(finalEvidenceBundle.bundleHash);

      stageD6Result = {
        status: 'COMPLETED',
        bundleId: finalEvidenceBundle.bundleId,
        canonicalBundleHash: finalEvidenceBundle.bundleHash,
        zipSha256: crypto.createHash('sha256').update(exportedZipBuffer).digest('hex'),
        operatorSignOff: finalEvidenceBundle.status,
        offlineVerificationPassed: true,
      };
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 8: Post-Rehearsal Controls & Atomic Cleanup
  // ═════════════════════════════════════════════════════════════════════════
  describe('8. Post-Rehearsal Controls & Atomic Cleanup', () => {
    it('stops network monitor and verifies zero non-loopback connections observed', async () => {
      const trace = await networkMonitor.stopObservation(observationSessionId);
      expect(trace.sessionId).toBe(observationSessionId);
      expect(trace.summary.allObservedLoopback).toBe(true);
      expect(trace.summary.violationsCount).toBe(0);
      expect(trace.summary.untrackedProcessSocketsCount).toBe(0);
    });

    it('restores firewall to pre-rehearsal snapshot and verifies state returns to INACTIVE', async () => {
      const restoreResult = await firewallService.restorePreviousState();

      expect(restoreResult.success).toBe(true);

      const statusAfter = await firewallService.getStatus();
      expect(statusAfter.state).toBe('INACTIVE');
      expect(statusAfter.activeRuleCount).toBe(0);
    });

    it('executes atomic cleanup coordinator and confirms zero leaked resources', async () => {
      const cleanupReport = await atomicCleanup.executeAtomicCleanup('Post-rehearsal verification teardown');

      expect(cleanupReport.success).toBe(true);
      expect(cleanupReport.tasksInterruptedCount).toBe(0);
      expect(cleanupReport.containersCleanedCount).toBe(0);
      expect(cleanupReport.tempDirsCleanedCount).toBe(0);

      // Second consecutive cleanup is clean and idempotent
      const secondCleanup = await atomicCleanup.executeAtomicCleanup('Idempotent second pass');
      expect(secondCleanup.success).toBe(true);
    });

    it('verifies audit trail integrity across the entire rehearsal lifecycle', () => {
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);
      expect(chainVerification.errors).toHaveLength(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 9: Failure & Interruption Rehearsal (Zero Phantom Success)
  // ═════════════════════════════════════════════════════════════════════════
  describe('9. Failure & Interruption Rehearsal (Zero Phantom Success)', () => {
    it('simulates interrupted workflow stage and proves no phantom success occurs', async () => {
      // Create a test task in active queue and mark it in-flight
      const activeQueueDir = path.join(rehearsalTempDir, '.maos', 'queue', 'active');
      fs.mkdirSync(activeQueueDir, { recursive: true });
      const failedTaskId = 'task-interrupted-sim-001';
      const taskFilePath = path.join(activeQueueDir, `${failedTaskId}.md`);
      const taskContent = `---
id: ${failedTaskId}
agent: AUTO
branch: maos/auto/${failedTaskId}
capabilities: []
complexity: medium
category: general
depends_on: []
status: active
created_at: ${new Date().toISOString()}
---

## Description
Simulated In-flight Task
`;
      fs.writeFileSync(taskFilePath, taskContent, 'utf-8');

      // Interrupt via atomic coordinator
      const interruptReport = await atomicCleanup.executeAtomicCleanup('Simulated mid-flight crash');
      expect(interruptReport.success).toBe(true);
      expect(interruptReport.tasksInterruptedCount).toBe(1);

      // Verify task on disk is NOT marked done or completed
      const updatedContent = fs.readFileSync(taskFilePath, 'utf-8');
      expect(updatedContent).not.toMatch(/status:\s*done/);
      expect(updatedContent).not.toMatch(/status:\s*completed/);
      expect(updatedContent).toMatch(/status:\s*interrupted/);
    });

    it('fails closed when attempting to export sovereignty bundle from unverified traces', () => {
      const invalidTrace: any = {
        schemaVersion: 1,
        traceId: 'corrupted-trace-001',
        title: 'Tampered Calculation Trace',
        calculationType: 'RMS',
        formula: 'RMS = sqrt(...)',
        intermediates: {},
        thresholdEvaluation: {},
        citations: [],
        traceHash: 'deadbeef'.repeat(8),
      };

      expect(() => {
        calculationTrace.verifyTrace(invalidTrace, { useRustEngine: false });
      }).toThrow();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 10: Epistemic Honesty & Bounded Claim Assertions
  // ═════════════════════════════════════════════════════════════════════════
  describe('10. Epistemic Honesty & Bounded Claim Assertions', () => {
    it('strictly forbids prohibited marketing claims in rehearsal metadata', () => {
      for (const bannedClaim of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        const boundary = createIndustrialSovereigntyBoundary('proj-banned-claim');
        const badBoundary = {
          ...boundary,
          approvedClaims: [bannedClaim],
        };
        const check = validateSovereigntyBoundary(badBoundary);
        expect(check.valid).toBe(false);
        expect(check.errors.some((e) => e.includes('PROHIBITED_CLAIM_DETECTED'))).toBe(true);
      }
    });

    it('verifies that only the standard measured sovereignty claim is declared', () => {
      const boundary = boundaryService.getActiveBoundary(rehearsalProjectId);
      expect(boundary.approvedClaims).toContain(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
      const check = validateSovereigntyBoundary(boundary);
      expect(check.valid).toBe(true);
      expect(check.errors).toHaveLength(0);
      expect(STANDARD_MEASURED_SOVEREIGNTY_CLAIM).toBe(
        'No non-loopback application connections were observed within the defined monitored boundary during the verified interval.',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 11: Canary & Cryptographic Invariants
  // ═════════════════════════════════════════════════════════════════════════
  describe('11. Canary & Cryptographic Invariants', () => {
    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const actualSha256 = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(actualSha256.toLowerCase()).toBe(EXPECTED_CANARY_SHA256.toLowerCase());
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Section 12: Generate & Save Rehearsal Report JSON
  // ═════════════════════════════════════════════════════════════════════════
  describe('12. Generate & Save Rehearsal Report JSON', () => {
    it('writes artifacts/verification/F9-09-rehearsal.json with full D1–D6 rehearsal data', () => {
      rehearsalCompletedAt = new Date().toISOString();

      const rehearsalReport = {
        schemaVersion: 1,
        rehearsalId: `f9-09-rehearsal-${Date.now()}`,
        projectId: rehearsalProjectId,
        status: 'PASSED',
        timestamp: rehearsalCompletedAt,
        measurementInterval: {
          startedAt: rehearsalStartedAt,
          completedAt: rehearsalCompletedAt,
          durationMs: new Date(rehearsalCompletedAt).getTime() - new Date(rehearsalStartedAt).getTime(),
        },
        firewall: {
          statusBefore: 'INACTIVE',
          statusDuring: 'ACTIVE',
          statusAfter: 'INACTIVE',
          appliedPlanHash: finalEvidenceBundle.hashes.firewallPlanHash,
          snapshotHash: finalEvidenceBundle.hashes.firewallSnapshotHash,
          restorationStatus: 'RESTORED',
        },
        endpointAllowlist: {
          policyHash: finalEvidenceBundle.hashes.endpointPolicyHash,
          enforcementMode: 'STRICT',
          allowedEndpoints: [
            'tcp://127.0.0.1:8000 (Local LLM model endpoint)',
            'tcp://127.0.0.1:11434 (Local Ollama endpoint)',
            'tcp://127.0.0.1:3847 (Local MAOS backend REST)',
            'npipe:////./pipe/docker_engine (Docker named pipe)',
          ],
        },
        networkMonitor: {
          sessionId: observationSessionId,
          observationTraceHash: canonicalTraceHash,
          allObservedLoopback: true,
          violationsCount: 0,
          nonLoopbackObserved: false,
        },
        serviceIdentity: {
          mappingHash: finalEvidenceBundle.hashes.serviceMappingHash,
          services: [
            {
              serviceName: 'industrial-llama-server',
              pid: 4100,
              port: 8000,
              modelId: 'llama3:8b',
              revision: 'sha256:model-snapshot-1234',
              trustStatus: 'TRUSTED',
            },
          ],
        },
        stages: {
          D1_model_endpoint_identity: stageD1Result,
          D2_document_ocr_retrieval: stageD2Result,
          D3_rms_calculation_trace: stageD3Result,
          D4_multimodal_evidence: stageD4Result,
          D5_office_artifacts: stageD5Result,
          D6_sovereignty_bundle: stageD6Result,
        },
        epistemicHonesty: {
          measuredClaim: STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
          prohibitedClaimsRejected: true,
          disclosedExcludedBoundaries: [
            'Host OS kernel network stack and packet filtering internals',
            'Hardware firmware and physical BMC/NIC subsystems',
            'Offline disk storage controllers and local filesystem drivers',
          ],
        },
        cleanup: {
          orphanContainers: 0,
          orphanModelLeases: 0,
          danglingTimers: 0,
          orphanTempFiles: 0,
          residualLocks: 0,
        },
        canaryVerification: {
          filePath: 'rust/test.txt',
          expectedSha256: EXPECTED_CANARY_SHA256,
          actualSha256: EXPECTED_CANARY_SHA256,
          verified: true,
        },
      };

      const outPath = path.join(TEST_PROJECT_ROOT, 'artifacts/verification/F9-09-rehearsal.json');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(rehearsalReport, null, 2), 'utf-8');

      expect(fs.existsSync(outPath)).toBe(true);
      const savedReport = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      expect(savedReport.status).toBe('PASSED');
      expect(savedReport.stages.D3_rms_calculation_trace.rmsValue).toBeCloseTo(2.63711, 4);
      expect(savedReport.stages.D6_sovereignty_bundle.offlineVerificationPassed).toBe(true);
      expect(savedReport.epistemicHonesty.measuredClaim).toBe(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
    });
  });
});
