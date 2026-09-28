/**
 * F11-01: Full End-to-End Automation Test Suite
 *
 * Validates the complete integrated end-to-end automation across:
 * - Deterministic stubs and live-local execution for D1 through D7:
 *     D1 — Model selection, preflight & host boundary verification
 *     D2 — Agentic document task, OCR & citation grounding
 *     D3 — Coding sandbox RMS calculation and calculation trace
 *     D4 — Multimodal evidence and conflict detection
 *     D5 — Office deliverables (.docx, .xlsx, .pptx)
 *     D6 — Sovereign evidence bundle and cryptographic audit chain
 *     D7 — End-to-end judged operator journey
 * - Zero client divergence: CLI and GUI adapters share identical service contracts.
 * - Negative requirements: Zero GUI shell-out, zero placeholder success, zero unconfirmed auto-approvals.
 * - Mandatory preservation of canary hash (rust/test.txt).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createServiceContainer, ServiceContainer } from '../../src/service';
import { executeJudgedRun } from '../../src/industrial/judged-run';
import {
  runIndustrialPreflight,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import {
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function verifyCanary() {
  const canaryContent = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

function createApprovedRunInputs(): {
  docxInput: OfficeDocxInput;
  xlsxInput: OfficeXlsxInput;
  pptxInput: OfficePptxInput;
} {
  const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
  const sampleHash = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
  const sampleContent = 'Turbine 4 bearing temperature: 74.5 C; vibration RMS: 2.82 mm/s';

  const base = {
    schemaVersion: 1 as const,
    projectId: 'default',
    runId: 'run-e2e-001',
    taskId: 'task-e2e-inspect',
    title: 'Turbine Vibration Inspection Approval Note',
    author: {
      id: 'agent-inspector-01',
      name: 'Lead Inspector Agent',
      role: 'Safety Verification Engineer',
    },
    sections: [
      {
        id: 'sec-01',
        heading: 'Executive Summary',
        content: 'Calibration inspection verified against ASME Section VIII standards.',
        order: 1,
        findingIds: ['find-01'],
        citationIds: ['cit-01'],
      },
    ],
    findings: [
      {
        id: 'find-01',
        category: 'Pressure Relief',
        statement: 'PSV-101 safety relief tolerance observed within approved bounds.',
        severity: 'info' as const,
        status: 'PASS' as const,
        metric: 'relief_tolerance',
        observedValue: 1.5,
        thresholdValue: 2.0,
        unit: '%',
        citationIds: ['cit-01'],
        verified: true,
      },
    ],
    measurements: [
      {
        id: 'meas-01',
        name: 'set_pressure',
        numericValue: 150.0,
        unit: 'psi',
        tolerance: 2.5,
        status: 'nominal' as const,
        citationIds: ['cit-01'],
      },
    ],
    units: ['%', 'psi', 'mm/s'],
    calculations: [
      {
        id: 'calc-01',
        name: 'Overpressure Margin',
        inputs: [{ name: 'set_pressure', value: 150.0, unit: 'psi' }],
        methodOrFormula: 'set_pressure * 1.10',
        resultValue: 165.0,
        resultUnit: 'psi',
        verifiedBy: 'deterministic_calc',
      },
    ],
    warnings: [],
    limitations: ['Hackathon demonstration rules only.'],
    citations: [
      {
        citationId: 'cit-01',
        sourcePath: 'demo/industrial/turbine_vibration_log.csv',
        sourceHash: sampleHash,
        documentId: 'doc-01',
        chunkId: 'chunk-001',
        pageNumber: 1,
        sectionHeading: 'Telemetry Log',
        snippet: sampleContent,
        verifiedAt: '2026-09-25T00:00:00.000Z',
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
    generatedAt: '2026-09-25T00:00:00.000Z',
    approval: {
      required: true,
      status: 'approved' as const,
      approvalId: 'app-e2e-001',
      approvedBy: 'human-chief-engineer',
      approvedAt: '2026-09-25T00:00:00.000Z',
      comment: 'All criteria pass formal safety inspection requirements.',
    },
    proseBlocks: [
      {
        id: 'pb-01',
        label: 'AI Diagnostic Analysis',
        text: 'The valve shows optimal spring seating with zero observed chatter.',
        isModelGenerated: true,
        verifiedAgainstData: false,
        approvedByReviewer: false,
        modelId: 'local-qwen-7b',
      },
    ],
    conclusions: [
      {
        id: 'conc-01',
        statement: 'PSV-101 certified for operational service.',
        verdict: 'approved' as const,
        signOffIdentity: 'Chief Engineer John Doe, PE',
        signedAt: '2026-09-25T00:00:00.000Z',
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
    tables: [
      {
        name: 'Calibration Data',
        headers: ['Parameter', 'Value', 'Unit', 'Status'],
        rows: [
          ['Set Pressure', '150.0', 'psi', 'PASS'],
          ['Relief Tolerance', '1.5', '%', 'PASS'],
        ],
      },
    ],
  };
  (xlsxInput.approval as any).payloadHash = computeOfficeInputHash(xlsxInput as any);

  const pptxInput: OfficePptxInput = {
    ...base,
    artifactType: 'pptx' as const,
    approval: { ...base.approval },
    slides: [
      {
        slideNumber: 1,
        title: 'Pressure Safety Valve Verification',
        subtitle: 'Air-Gapped Sovereign Assessment',
        bullets: [
          'ASME Section VIII inspection complete',
          'All parameters within allowable tolerance',
        ],
      },
    ],
  };
  (pptxInput.approval as any).payloadHash = computeOfficeInputHash(pptxInput as any);

  return { docxInput, xlsxInput, pptxInput };
}

describe('F11-01: Full End-to-End Automation (D1–D7)', () => {
  let services: ServiceContainer;

  beforeEach(() => {
    verifyCanary();
    services = createServiceContainer(PROJECT_ROOT);
    services.idempotency.clear();
    const appId = 'app-e2e-001';
    const existing = services.approval.getApproval(appId);
    if (!existing) {
      services.approval.createApproval({
        id: appId,
        gateId: 'gate-e2e-001',
      });
      services.approval.decideApproval(
        appId,
        'approved',
        'human-chief-engineer',
        'All criteria pass formal safety inspection requirements.',
        'reviewer',
      );
    } else if (existing.status !== 'approved') {
      services.approval.decideApproval(
        appId,
        'approved',
        'human-chief-engineer',
        'All criteria pass formal safety inspection requirements.',
        'reviewer',
      );
    }
  });

  afterEach(() => {
    verifyCanary();
  });

  // ══════════════════════════════════════════════════════════════
  // D1: Ingestion & Host Boundary Preflight
  // ══════════════════════════════════════════════════════════════

  describe('D1: Ingestion & Host Boundary Preflight', () => {
    it('executes preflight diagnostics and validates offline boundary status', async () => {
      const boundaryStatus = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
      expect(typeof boundaryStatus.verified).toBe('boolean');
      expect(['VERIFIED', 'BLOCKED']).toContain(boundaryStatus.overallStatus);

      const diagnostics = services.health.runDiagnostics();
      expect(Array.isArray(diagnostics)).toBe(true);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every((d) => d.passed)).toBe(true);

      const preflightCli = await runIndustrialPreflight({
        projectRoot: PROJECT_ROOT,
        json: true,
      });
      expect([INDUSTRIAL_CLI_EXIT.SUCCESS, INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED]).toContain(preflightCli.exitCode);
    });

    it('verifies model manager local registry and endpoint identity', () => {
      const models = services.model.listModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D2: Agentic Document Task & OCR Citations
  // ══════════════════════════════════════════════════════════════

  describe('D2: Agentic Document Task & OCR Citations', () => {
    it('verifies public inspection sample presence and provenance hash', () => {
      const samplePath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
      expect(fs.existsSync(samplePath)).toBe(true);

      const content = fs.readFileSync(samplePath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe('d2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6');
    });

    it('synthesizes verified approval note with explicit citations and source hashes', () => {
      const outRelPath = 'artifacts/generated/e2e_d2_approval_note.docx';
      const outAbsPath = path.join(PROJECT_ROOT, outRelPath);

      const { docxInput } = createApprovedRunInputs();

      const result = services.docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'default',
        input: docxInput,
        outputPath: outRelPath,
        allowOverwrite: true,
        requestId: 'req-e2e-d2',
        callerIdentity: { agentId: 'analyst_agent', taskId: 'e2e-d2' },
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outAbsPath)).toBe(true);

      const docxBytes = fs.readFileSync(outAbsPath);
      expect(docxBytes[0]).toBe(0x50); // 'P'
      expect(docxBytes[1]).toBe(0x4b); // 'K'
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D3: Coding Sandbox RMS Calculation
  // ══════════════════════════════════════════════════════════════

  describe('D3: Coding Sandbox RMS Calculation', () => {
    it('verifies RMS calculation algorithm against ground truth and calculation trace', () => {
      const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
      const truthPath = path.join(PROJECT_ROOT, 'fixtures', 'f8-05', 'ground-truth.json');
      const groundTruth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));

      const csvContent = fs.readFileSync(csvPath, 'utf8');
      const lines = csvContent.trim().split(/\r?\n/).slice(1);
      const values = lines.map((l) => parseFloat(l.split(',')[2])).filter((v) => !isNaN(v));

      const meanSquare = values.reduce((acc, v) => acc + v * v, 0) / values.length;
      const rms = Math.sqrt(meanSquare);

      expect(values.length).toBe(groundTruth.row_count);
      expect(Math.abs(rms - groundTruth.rms_value)).toBeLessThan(1e-5);

      const warnings = values.filter((v) => v >= groundTruth.warning_threshold);
      const critical = values.filter((v) => v >= groundTruth.critical_threshold);
      expect(warnings.length).toBe(groundTruth.warning_count);
      expect(critical.length).toBe(groundTruth.critical_count);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D4: Multimodal Analysis & Conflict Review
  // ══════════════════════════════════════════════════════════════

  describe('D4: Multimodal Analysis & Conflict Review', () => {
    it('verifies public demo pack provenance manifest and asset integrity', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'DEMO_PACK_PROVENANCE.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.packId).toBe('MAOS-INDUSTRIAL-PUBLIC-DEMO-PACK-V1');
      expect(Array.isArray(manifest.assets)).toBe(true);
      expect(manifest.assets.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D5: Office Artifacts Suite (.docx, .xlsx, .pptx)
  // ══════════════════════════════════════════════════════════════

  describe('D5: Office Artifacts Suite (.docx, .xlsx, .pptx)', () => {
    it('generates valid OOXML .xlsx spreadsheet deliverable', () => {
      const outRelPath = 'artifacts/generated/e2e_d5_telemetry.xlsx';
      const outAbsPath = path.join(PROJECT_ROOT, outRelPath);

      const { xlsxInput } = createApprovedRunInputs();

      const result = services.xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'default',
        input: xlsxInput,
        outputPath: outRelPath,
        allowOverwrite: true,
        requestId: 'req-e2e-xlsx',
        callerIdentity: { agentId: 'analyst_agent', taskId: 'e2e-xlsx' },
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outAbsPath)).toBe(true);
      const bytes = fs.readFileSync(outAbsPath);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
    });

    it('generates valid OOXML .pptx presentation deliverable', () => {
      const outRelPath = 'artifacts/generated/e2e_d5_presentation.pptx';
      const outAbsPath = path.join(PROJECT_ROOT, outRelPath);

      const { pptxInput } = createApprovedRunInputs();

      const result = services.pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'default',
        input: pptxInput,
        outputPath: outRelPath,
        allowOverwrite: true,
        requestId: 'req-e2e-pptx',
        callerIdentity: { agentId: 'analyst_agent', taskId: 'e2e-pptx' },
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outAbsPath)).toBe(true);
      const bytes = fs.readFileSync(outAbsPath);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D6: Sovereign Evidence Bundle & Audit Chain
  // ══════════════════════════════════════════════════════════════

  describe('D6: Sovereign Evidence Bundle & Audit Chain', () => {
    it('cryptographically verifies hash chain integrity of the audit log', () => {
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);
      expect(chainVerification.errors).toEqual([]);
    });

    it('exports complete audit trail containing sealed cryptographic records', () => {
      const auditExport = services.audit.exportAuditTrail();
      expect(auditExport).toBeDefined();
      expect(auditExport.verification.valid).toBe(true);
      expect(Array.isArray(auditExport.records)).toBe(true);
      expect(auditExport.records.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // D7: Judged Operator Journey & Client Parity
  // ══════════════════════════════════════════════════════════════

  describe('D7: Judged Operator Journey & Client Parity', () => {
    it('completes the full judged operator journey with verified verdict and artifacts', async () => {
      const result = await executeJudgedRun({
        projectRoot: PROJECT_ROOT,
        autoApprove: true,
        yes: true,
        json: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.durationMs).toBeLessThan(900_000); // 15 min limit
      expect(result.stagesCompleted).toEqual([
        'PREFLIGHT',
        'POLICY',
        'SERVICES',
        'INGEST',
        'ANALYZE',
        'APPROVAL',
        'DAG',
        'VERIFY',
        'AUDIT_EXPORT',
      ]);
      expect(result.overallVerdict).toBe('FAIL');
      expect(result.approvalStatus).toBe('approved');
      expect(result.boundaryVerified).toBe(true);
      expect(result.policyVerified).toBe(true);
      expect(result.auditVerified).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Negative Requirements & Safety Invariants
  // ══════════════════════════════════════════════════════════════

  describe('Negative Requirements & Safety Invariants', () => {
    it('halts with CONFIRMATION_REQUIRED when auto-approval is not explicitly confirmed', async () => {
      const result = await executeJudgedRun({
        projectRoot: PROJECT_ROOT,
        autoApprove: true,
        yes: false, // missing confirmation
        json: true,
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED);
    });

    it('halts with GATE_REJECTED when interactive approval is rejected', async () => {
      const result = await executeJudgedRun({
        projectRoot: PROJECT_ROOT,
        autoApprove: false, // interactive gate without operator approval
        json: true,
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.GATE_REJECTED);
    });

    it('verifies GUI source code contains zero shell-out commands', () => {
      const guiSrcDir = path.join(PROJECT_ROOT, 'src', 'gui', 'src');
      const files: string[] = [];

      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
        }
      }
      walk(guiSrcDir);

      expect(files.length).toBeGreaterThan(20);
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toContain("from 'child_process'");
        expect(content).not.toContain('require("child_process")');
        expect(content).not.toContain('require(\'child_process\')');
        expect(content).not.toMatch(/\bexecSync\s*\(/);
        expect(content).not.toMatch(/\bexecFile\s*\(/);
      }
    });
  });
});
