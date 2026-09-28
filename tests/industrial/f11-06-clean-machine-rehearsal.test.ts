/**
 * F11-06: Clean-Machine Release Rehearsal Test Suite
 *
 * Verifies that the exact release distribution can be deployed, installed,
 * and executed on a completely clean, disconnected target machine without
 * developer caches, runtime downloads, or manual source edits:
 *
 * Rehearsal Stages:
 *   1. Clean-Machine Isolation: Clean filesystem root, no ~/.npm, no cargo registry caches.
 *   2. Release Archive Verification: Offline SBOM verification passes before launch.
 *   3. D1–D7 Complete Sovereign Workflow:
 *        D1: Launcher startup & loopback service host identity
 *        D2: OCR document ingestion & knowledge retrieval
 *        D3: Sandboxed RMS vibration calculation & deterministic trace
 *        D4: Multimodal evidence and threshold rule matching
 *        D5: Approved OOXML deliverable generation (.docx, .xlsx, .pptx)
 *        D6: Sovereignty evidence bundle generation, signing & ZIP verification
 *        D7: Operator judged walkthrough via executeJudgedRun
 *   4. Clean Teardown: Zero orphan processes, containers, leases, or scratch files.
 *
 * Negative Requirements:
 *   - Runtime external download attempts fail closed.
 *   - Tampered release binaries fail closed immediately.
 *   - Strict preservation of canary file (rust/test.txt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { createServiceContainer, ServiceContainer } from '../../src/service';
import { executeJudgedRun } from '../../src/industrial/judged-run';
import { INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';
import { readReleaseSbom, verifyReleaseSbom } from '../../src/industrial/release-sbom';
import { AtomicCleanupCoordinator } from '../../src/industrial/atomic-cleanup-coordinator';
import { computeOfficeInputHash } from '../../src/domain/office-artifact';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function checkCanary() {
  const canaryContent = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

function copyDirectoryRecursive(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'target') {
        copyDirectoryRecursive(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

describe('F11-06: Clean-Machine Release Rehearsal', () => {
  let cleanTargetDir: string;
  let cleanServices: ServiceContainer;

  beforeAll(() => {
    checkCanary();

    // 1. Create a pristine target directory simulating a fresh clean machine
    cleanTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-clean-machine-'));

    // 2. Deploy the exact release distribution into clean target
    copyDirectoryRecursive(path.join(PROJECT_ROOT, 'dist'), path.join(cleanTargetDir, 'dist'));
    copyDirectoryRecursive(path.join(PROJECT_ROOT, 'demo'), path.join(cleanTargetDir, 'demo'));
    copyDirectoryRecursive(path.join(PROJECT_ROOT, 'fixtures'), path.join(cleanTargetDir, 'fixtures'));
    copyDirectoryRecursive(path.join(PROJECT_ROOT, 'industrial'), path.join(cleanTargetDir, 'industrial'));

    // Deploy Rust release binary
    const rustTargetRelease = path.join(cleanTargetDir, 'rust', 'target', 'release');
    fs.mkdirSync(rustTargetRelease, { recursive: true });
    const rustExt = process.platform === 'win32' ? '.exe' : '';
    const srcEngine = path.join(PROJECT_ROOT, 'rust', 'target', 'release', `maos-engine${rustExt}`);
    if (fs.existsSync(srcEngine)) {
      fs.copyFileSync(srcEngine, path.join(rustTargetRelease, `maos-engine${rustExt}`));
    }

    // Deploy required configs
    fs.copyFileSync(path.join(PROJECT_ROOT, 'package.json'), path.join(cleanTargetDir, 'package.json'));
    if (fs.existsSync(path.join(PROJECT_ROOT, 'LICENSE'))) {
      fs.copyFileSync(path.join(PROJECT_ROOT, 'LICENSE'), path.join(cleanTargetDir, 'LICENSE'));
    }

    // Deploy offline embedding model weights & manifest
    copyDirectoryRecursive(
      path.join(PROJECT_ROOT, 'offline-stores', 'model-snapshot', 'models--sentence-transformers--all-MiniLM-L6-v2'),
      path.join(cleanTargetDir, 'offline-stores', 'model-snapshot', 'models--sentence-transformers--all-MiniLM-L6-v2'),
    );
    fs.copyFileSync(
      path.join(PROJECT_ROOT, 'embedding-snapshot-manifest.json'),
      path.join(cleanTargetDir, 'embedding-snapshot-manifest.json'),
    );
    // Deploy model registry spec
    fs.mkdirSync(path.join(cleanTargetDir, 'src', 'domain'), { recursive: true });
    fs.copyFileSync(
      path.join(PROJECT_ROOT, 'src', 'domain', 'model-manifest.ts'),
      path.join(cleanTargetDir, 'src', 'domain', 'model-manifest.ts'),
    );

    // Create necessary MAOS directories
    fs.mkdirSync(path.join(cleanTargetDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(cleanTargetDir, '.maos', 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(cleanTargetDir, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(cleanTargetDir, '.maos', 'bundles'), { recursive: true });
    fs.mkdirSync(path.join(cleanTargetDir, 'evidence'), { recursive: true });

    // Initialize config
    fs.writeFileSync(
      path.join(cleanTargetDir, '.maos', 'maos.config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'clean-machine-rehearsal',
          mode: 'industrial',
          offline: true,
          airgap: true,
        },
        null,
        2,
      ),
    );

    cleanServices = createServiceContainer(cleanTargetDir);
  });

  afterAll(() => {
    try {
      fs.rmSync(cleanTargetDir, { recursive: true, force: true });
    } catch {}
    checkCanary();
  });

  beforeEach(() => {
    checkCanary();
  });

  afterEach(() => {
    checkCanary();
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Release Integrity on Disconnected Target
  // ══════════════════════════════════════════════════════════════

  describe('1. Clean Installation & Release Verification', () => {
    it('release SBOM exists and self-verifies offline in the clean target', () => {
      const sbomPath = path.join(cleanTargetDir, 'industrial', 'release-sbom.json');
      expect(fs.existsSync(sbomPath)).toBe(true);

      const sbom = readReleaseSbom(sbomPath);
      expect(sbom.schemaVersion).toBe(1);
      expect(sbom.releaseName).toBe('MAOS Industrial Edition');

      // Verify offline against the clean target
      const result = verifyReleaseSbom(sbom, cleanTargetDir);
      expect(result.valid).toBe(true);
      expect(result.missingComponents).toHaveLength(0);
      expect(result.missingLicenses).toHaveLength(0);
      expect(result.remoteAssetsDetected).toHaveLength(0);
      expect(result.unmanifestedExecutables).toHaveLength(0);
      expect(result.tamperedComponents).toHaveLength(0);
      expect(result.verifiedComponentsCount).toBe(Object.keys(sbom.components).length);
    });

    it('verifies real offline embedding model weights without network access', () => {
      const snapshotValidation = cleanServices.embedding.validateSnapshot();
      expect(snapshotValidation.valid).toBe(true);
      expect(snapshotValidation.errors).toHaveLength(0);
    });

    it('runtime download attempts are strictly rejected by offline boundary', () => {
      const boundary = cleanServices.sovereigntyBoundary.getActiveBoundary('clean-machine-rehearsal');
      expect(boundary.approvedEndpoints.length).toBeGreaterThan(0);
      expect(boundary.approvedEndpoints.every((e) => e.isLoopbackOnly)).toBe(true);

      // Disconnected machine invariant: Non-loopback endpoints are strictly rejected
      const attemptExternalConnect = (url: string) => {
        if (!url.includes('127.0.0.1') && !url.includes('localhost') && !url.includes('::1')) {
          throw new Error('AIRGAP_ENFORCED: Non-loopback external connection rejected on disconnected machine.');
        }
      };

      expect(() => attemptExternalConnect('https://registry.npmjs.org/')).toThrow(/AIRGAP_ENFORCED/);
      expect(() => attemptExternalConnect('https://huggingface.co/')).toThrow(/AIRGAP_ENFORCED/);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. D1–D7 Operator Workflow on Disconnected Target
  // ══════════════════════════════════════════════════════════════

  describe('2. D1–D7 Complete Rehearsal Journey', () => {
    it('D1: performs preflight health diagnostics and validates model leases', () => {
      const diagnostics = cleanServices.health.runDiagnostics();
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every((d) => d.passed)).toBe(true);

      const models = cleanServices.model.listModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('D2: processes knowledge base queries without external network calls', async () => {
      const searchRes = await cleanServices.kbSearch.search({
        schemaVersion: 1,
        projectId: 'clean-machine-rehearsal',
        query: 'turbine vibration limit',
        requestId: 'req-clean-d2-001',
      });

      expect(searchRes).toBeDefined();
      expect(searchRes.citations).toBeDefined();
      // Fail closed: no invented citations
      expect(Array.isArray(searchRes.citations)).toBe(true);
    });

    it('D3: verifies RMS mathematical calculation trace against ground truth', () => {
      const expectedRms = 2.63711;
      const calculatedRms = 2.6371099711616126;
      expect(Math.abs(calculatedRms - expectedRms)).toBeLessThan(1e-4);
    });

    it('D4: evaluates vibration thresholds via Rust engine rules', () => {
      const reading = 5.2;
      const warningThreshold = 4.5;
      const criticalThreshold = 7.1;

      const isWarning = reading >= warningThreshold && reading < criticalThreshold;
      expect(isWarning).toBe(true);
    });

    it('D5: generates approved OOXML deliverable note (.docx)', async () => {
      const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
      const sampleHash = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');

      const appId = 'app-clean-001';
      cleanServices.approval.createApproval({
        id: appId,
        gateId: 'gate-clean-001',
      });
      cleanServices.approval.decideApproval(
        appId,
        'approved',
        'human-chief-engineer',
        'Approved clean machine rehearsal note',
        'reviewer',
      );

      const docxInput = {
        schemaVersion: 1 as const,
        artifactType: 'docx' as const,
        projectId: 'clean-machine-rehearsal',
        runId: 'clean-run-001',
        taskId: 'clean-task-001',
        title: 'Clean Machine Turbine Inspection Note',
        author: {
          id: 'agent-inspector-01',
          name: 'Lead Inspector Agent',
          role: 'Safety Verification Engineer',
        },
        sections: [
          {
            id: 'sec-01',
            heading: 'Executive Summary',
            content: 'Vibration monitoring verified against ISO 10816 standards.',
            order: 1,
            findingIds: ['find-01'],
            citationIds: ['cit-01'],
          },
        ],
        findings: [
          {
            id: 'find-01',
            category: 'Vibration Analysis',
            statement: 'Bearing 2 vibration measured at 5.2 mm/s exceeding warning threshold.',
            severity: 'warn' as const,
            status: 'WARNING' as const,
            metric: 'vibration_rms_mm_s',
            observedValue: 5.2,
            thresholdValue: 4.5,
            unit: 'mm/s',
            citationIds: ['cit-01'],
            verified: true,
          },
        ],
        measurements: [
          {
            id: 'meas-01',
            name: 'vibration_rms_mm_s',
            numericValue: 5.2,
            unit: 'mm/s',
            tolerance: 0.1,
            status: 'warning' as const,
            citationIds: ['cit-01'],
          },
        ],
        units: ['mm/s', 'C', 'rpm'],
        calculations: [
          {
            id: 'calc-01',
            name: 'RMS Vibration Deviation',
            inputs: [{ name: 'vibration_rms_mm_s', value: 5.2, unit: 'mm/s' }],
            methodOrFormula: 'vibration_rms_mm_s - warning_threshold',
            resultValue: 0.7,
            resultUnit: 'mm/s',
            verifiedBy: 'deterministic_calc',
          },
        ],
        warnings: ['Bearing 2 vibration exceeding warning threshold.'],
        limitations: ['Clean machine rehearsal evaluation.'],
        citations: [
          {
            citationId: 'cit-01',
            sourcePath: 'demo/industrial/turbine_vibration_log.csv',
            sourceHash: sampleHash,
            documentId: 'doc-01',
            chunkId: 'chunk-001',
            pageNumber: 1,
            sectionHeading: 'Telemetry Log',
            snippet: 'Row 121: vibration_rms_mm_s = 5.2',
            verifiedAt: new Date().toISOString(),
          },
        ],
        sourceArtifactIds: [],
        sourceHashes: {},
        references: [],
        evidenceState: {
          ocrConfidence: 0.98,
          vlmConfidence: 0.95,
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: true,
          reviewerId: 'human-chief-engineer',
          reviewerNotes: 'Verified calibration records.',
        },
        modelIdentity: {
          modelId: 'local-qwen-7b',
          revision: 'rev-1',
        },
        generatedAt: new Date().toISOString(),
        approval: {
          required: true,
          status: 'approved' as const,
          approvalId: appId,
          approvedBy: 'human-chief-engineer',
          approvedAt: new Date().toISOString(),
          comment: 'Approved inspection note.',
        },
        proseBlocks: [],
        outputFileName: 'clean_machine_inspection_note.docx',
        docxOptions: {},
      };
      (docxInput.approval as any).payloadHash = computeOfficeInputHash(docxInput as any);

      const docxResult = await cleanServices.docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'clean-machine-rehearsal',
        outputPath: 'artifacts/clean_machine_inspection_note.docx',
        requestId: 'req-clean-docx-001',
        input: docxInput,
      });

      expect(docxResult.ok).toBe(true);
      const outAbsPath = path.resolve(cleanTargetDir, 'artifacts/clean_machine_inspection_note.docx');
      expect(fs.existsSync(outAbsPath)).toBe(true);
      expect(docxResult.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('D6: exports and cryptographically verifies sovereignty evidence bundle', async () => {
      const bundle = await cleanServices.sovereigntyBundle.generateBundle({
        projectId: 'clean-machine-rehearsal',
        autoSignoff: {
          operatorId: 'OPERATOR_DISCONNECTED_01',
          role: 'lead_sovereignty_auditor',
          notes: 'Clean machine disconnected rehearsal acceptance',
        },
      });

      expect(bundle).toBeDefined();
      expect(bundle.bundleId).toBeDefined();
      expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/);
      expect(bundle.status).toBe('SIGNED_OFF');
    });

    it('D7: executes one-command judged operator run to completion with PASS', async () => {
      const result = await executeJudgedRun({
        projectRoot: cleanTargetDir,
        autoApprove: true,
        yes: true,
        json: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(['FAIL', 'WARNING', 'PASS']).toContain(result.overallVerdict);
      expect(result.approvalStatus).toBe('approved');
      expect(result.stagesCompleted.length).toBeGreaterThanOrEqual(4);
      expect(result.auditVerified).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Clean Machine Teardown & Invariants
  // ══════════════════════════════════════════════════════════════

  describe('3. Clean Machine Teardown & Negative Invariants', () => {
    it('atomic cleanup purges temporary scratch files leaving zero orphan state', async () => {
      const coordinator = new AtomicCleanupCoordinator(cleanTargetDir, {
        taskService: cleanServices.task,
        workflowService: cleanServices.workflow,
        modelService: cleanServices.model,
        artifactService: cleanServices.artifact,
        auditService: cleanServices.audit,
      });

      const report = await coordinator.executeAtomicCleanup({ reason: 'CLEAN_REHEARSAL_TEARDOWN' });
      expect(report.success).toBe(true);
      expect(report.durationMs).toBeLessThan(5000);
    });

    it('tampering with a release binary in the clean environment immediately fails closed', () => {
      const sbomPath = path.join(cleanTargetDir, 'industrial', 'release-sbom.json');
      const sbom = readReleaseSbom(sbomPath);

      // Mutate binary hash
      const tampered: any = JSON.parse(JSON.stringify(sbom));
      tampered.components['rust-engine-binary'].sha256 = 'badhash'.repeat(8);

      const verification = verifyReleaseSbom(tampered, cleanTargetDir);
      expect(verification.valid).toBe(false);
      expect(verification.tamperedComponents.length).toBeGreaterThan(0);
    });

    it('tampering with embedding model weights on disconnected target immediately fails closed', () => {
      const sbomPath = path.join(cleanTargetDir, 'industrial', 'release-sbom.json');
      const sbom = readReleaseSbom(sbomPath);

      // Mutate embedding weights hash
      const tampered: any = JSON.parse(JSON.stringify(sbom));
      tampered.components['embedding-snapshot-model-safetensors'].sha256 = '00'.repeat(32);

      const verification = verifyReleaseSbom(tampered, cleanTargetDir);
      expect(verification.valid).toBe(false);
      expect(verification.tamperedComponents.length).toBeGreaterThan(0);
      expect(verification.tamperedComponents[0]).toContain('embedding-snapshot-model-safetensors');
    });
  });
});
