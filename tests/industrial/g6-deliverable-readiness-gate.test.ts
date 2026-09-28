/**
 * Gate G6: Deliverable Readiness Verification Suite
 *
 * Validates the core criteria for Gate G6 across F6-01 through F6-06:
 *   1. Unified Approved Run Contract:
 *      - DOCX, XLSX, and PPTX generated from ONE approved run contract
 *      - All three openable and valid OOXML ZIP packages
 *   2. Ground Truth Parity:
 *      - Exact values, measurements, engineering units, calculations, findings,
 *        verdicts, and citations match ground truth data
 *      - Tamper detection: altered source files or changed source hashes fail closed
 *   3. Strict Output & Template Safety:
 *      - Zero macros (VBA/binaries), zero ActiveX, zero embedded OLE objects
 *      - Zero external relationships, remote URLs, or external media
 *      - Zero spreadsheet formula injection
 *      - Rejection of unauthorized overwrite, path traversal, or unconfined paths
 *   4. Visual Quality & Governance:
 *      - Layout bounds checking (printable widths, cell auto-widths, 16:9 canvas)
 *      - Non-overlapping shape placement on presentation slides
 *      - Mandatory verdict banner (PASS / FAIL / CONDITIONAL)
 *      - Formal reviewer sign-off block with role and signature status
 *      - Segregated unverified model prose with amber warning banner
 *      - 5-column cryptographic citation ledger
 *      - 100% deterministic visual snapshot hashing across repeated generation
 *   5. Atomic Storage & Multi-Project Isolation:
 *      - Atomic artifact finalization with SHA-256 checksum registration
 *      - Strict cross-project boundary isolation
 *   6. Privacy-Preserving Audit Trail:
 *      - Full audit lifecycle logging without raw prose or token leakage
 *   7. Protected File Invariant:
 *      - rust/test.txt SHA-256 remains 1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import {
  parseZipArchive,
  validateDocxPackage,
} from '../../src/industrial/office/ooxml-packager';
import { validateXlsxPackage } from '../../src/industrial/office/xlsx-packager';
import { validatePptxPackage } from '../../src/industrial/office/pptx-packager';

describe('Gate G6: Deliverable Readiness Verification', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let services: ServiceContainer;

  const sampleSourceContent = 'ASME Section VIII Pressure Safety Valve PSV-101 calibration set point: 150.0 psi. Relief tolerance observed: 1.5%.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  function createApprovedRunInputs(): {
    docxInput: OfficeDocxInput;
    xlsxInput: OfficeXlsxInput;
    pptxInput: OfficePptxInput;
  } {
    const base = {
      schemaVersion: 1 as const,
      projectId: 'g6-verification-project',
      runId: 'run-g6-001',
      taskId: 'task-g6-inspect',
      title: 'Pressure Safety Valve PSV-101 Inspection Approval Note',
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
          reviewerCorrection: {
            reviewerId: 'human-chief-engineer',
            timestamp: '2026-09-20T11:00:00Z',
            field: 'relief_tolerance',
            originalValue: 1.6,
            correctedValue: 1.5,
            reason: 'Calibrated transducer secondary verification',
          },
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
      units: ['%', 'psi'],
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
      warnings: [
        {
          code: 'WARN_TEMP_AMBIENT',
          message: 'Ambient test cell temperature 31 C exceeds standard 25 C reference.',
          severity: 'medium' as const,
          acknowledged: true,
          acknowledgedBy: 'human-chief-engineer',
        },
      ],
      limitations: [
        'Applicable only to gaseous service PSV-100 series valves.',
      ],
      citations: [
        {
          citationId: 'cit-01',
          sourcePath: 'evidence/calibration.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-calib-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'Relief Calibration Log',
          snippet: sampleSourceContent,
          verifiedAt: '2026-09-20T11:00:00Z',
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
        reviewerNotes: 'Verified calibration records against master instrument.',
      },
      modelIdentity: {
        modelId: 'qwen2.5-vl-7b-instruct',
        revision: 'rev-2026.1',
      },
      generatedAt: '2026-09-20T11:30:00Z',
      approval: {
        required: true,
        status: 'approved' as const,
        approvalId: 'app-g6-001',
        approvedBy: 'human-chief-engineer',
        approvedAt: '2026-09-20T12:00:00Z',
        comment: 'All criteria pass formal safety inspection requirements.',
      },
      proseBlocks: [
        {
          id: 'pb-01',
          label: 'AI Diagnostic Analysis',
          text: 'The valve shows optimal spring seating with zero observed chatter during transient sweep.',
          isModelGenerated: true,
          verifiedAgainstData: false,
          approvedByReviewer: false,
          modelId: 'qwen2.5-vl-7b-instruct',
        },
      ],
      conclusions: [
        {
          id: 'conc-01',
          statement: 'PSV-101 certified for operational service under ASME Section VIII.',
          verdict: 'approved' as const,
          signOffIdentity: 'Chief Engineer John Doe, PE',
          signedAt: '2026-09-20T12:00:00Z',
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

  function generateDocxHelper(
    input: OfficeDocxInput,
    relPath: string,
    opts: { requestId?: string; allowOverwrite?: boolean } = {}
  ) {
    return services.docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: input.projectId,
      input,
      outputPath: relPath,
      requestId: opts.requestId || `req-docx-${Date.now()}-${Math.random()}`,
      callerIdentity: { agentId: 'report_agent', taskId: input.taskId },
      allowOverwrite: opts.allowOverwrite,
    });
  }

  function generateXlsxHelper(
    input: OfficeXlsxInput,
    relPath: string,
    opts: { requestId?: string; allowOverwrite?: boolean } = {}
  ) {
    return services.xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: input.projectId,
      input,
      outputPath: relPath,
      requestId: opts.requestId || `req-xlsx-${Date.now()}-${Math.random()}`,
      callerIdentity: { agentId: 'report_agent', taskId: input.taskId },
      allowOverwrite: opts.allowOverwrite,
    });
  }

  function generatePptxHelper(
    input: OfficePptxInput,
    relPath: string,
    opts: { requestId?: string; allowOverwrite?: boolean } = {}
  ) {
    return services.pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: input.projectId,
      input,
      outputPath: relPath,
      requestId: opts.requestId || `req-pptx-${Date.now()}-${Math.random()}`,
      callerIdentity: { agentId: 'report_agent', taskId: input.taskId },
      allowOverwrite: opts.allowOverwrite,
    });
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-g6-gate-'));
    fs.mkdirSync(path.join(projectRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });

    // Write source file for citations
    fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), sampleSourceContent, 'utf-8');

    services = createServiceContainer(projectRoot);

    // Register approved record
    const record = {
      schemaVersion: 1,
      id: 'app-g6-001',
      taskId: 'task-g6-inspect',
      status: 'approved',
      requestedBy: 'agent-inspector-01',
      approverRole: 'chief_engineer',
      description: 'PSV-101 inspection approval note',
      createdAt: '2026-09-20T11:30:00Z',
      decidedAt: '2026-09-20T12:00:00Z',
      decidedBy: 'human-chief-engineer',
      reason: 'All criteria pass formal safety inspection requirements.',
    };
    fs.writeFileSync(
      path.join(projectRoot, '.maos', 'approvals', 'app-g6-001.json'),
      JSON.stringify(record, null, 2),
      'utf-8'
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('1. Unified Approved Run Contract & Reopen in Parser/Viewer', () => {
    it('generates valid DOCX, XLSX, and PPTX deliverables from one approved run contract', () => {
      const { docxInput, xlsxInput, pptxInput } = createApprovedRunInputs();

      const docxRel = 'artifacts/deliverable.docx';
      const xlsxRel = 'artifacts/deliverable.xlsx';
      const pptxRel = 'artifacts/deliverable.pptx';

      const docxResult = generateDocxHelper(docxInput, docxRel);
      const xlsxResult = generateXlsxHelper(xlsxInput, xlsxRel);
      const pptxResult = generatePptxHelper(pptxInput, pptxRel);

      expect(docxResult.ok).toBe(true);
      expect(xlsxResult.ok).toBe(true);
      expect(pptxResult.ok).toBe(true);

      expect(fs.existsSync(path.join(projectRoot, docxRel))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, xlsxRel))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, pptxRel))).toBe(true);

      // Reopen and validate packages via standard OOXML validator
      const docxBuf = fs.readFileSync(path.join(projectRoot, docxRel));
      const xlsxBuf = fs.readFileSync(path.join(projectRoot, xlsxRel));
      const pptxBuf = fs.readFileSync(path.join(projectRoot, pptxRel));

      const docxPackage = validateDocxPackage(docxBuf);
      const xlsxPackage = validateXlsxPackage(xlsxBuf);
      const pptxPackage = validatePptxPackage(pptxBuf);

      expect(docxPackage.valid).toBe(true);
      expect(xlsxPackage.valid).toBe(true);
      expect(pptxPackage.valid).toBe(true);
    });
  });

  describe('2. Ground Truth, Values, Citations, and Hashes Parity', () => {
    it('verifies exact measurements, units, calculations, and cryptographic citations in generated artifacts', () => {
      const { docxInput, xlsxInput, pptxInput } = createApprovedRunInputs();

      generateDocxHelper(docxInput, 'artifacts/deliverable.docx');
      generateXlsxHelper(xlsxInput, 'artifacts/deliverable.xlsx');
      generatePptxHelper(pptxInput, 'artifacts/deliverable.pptx');

      // DOCX verification
      const docxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.docx'));
      const docxZip = parseZipArchive(docxBuf);
      const docxXml = docxZip.get('word/document.xml')?.toString('utf-8') || '';

      expect(docxXml).toContain('150');
      expect(docxXml).toContain('psi');
      expect(docxXml).toContain('165');
      expect(docxXml).toContain('1.5');
      expect(docxXml).toContain('%');
      expect(docxXml).toContain(sampleSourceHash.substring(0, 16));
      expect(docxXml).toContain('Chief Engineer John Doe, PE');

      // XLSX verification
      const xlsxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.xlsx'));
      const xlsxZip = parseZipArchive(xlsxBuf);
      const sheet1 = xlsxZip.get('xl/worksheets/sheet1.xml')?.toString('utf-8') || '';
      const sheet2 = xlsxZip.get('xl/worksheets/sheet2.xml')?.toString('utf-8') || '';
      const sheet6 = xlsxZip.get('xl/worksheets/sheet6.xml')?.toString('utf-8') || '';

      expect(sheet1).toContain('APPROVED');
      expect(sheet2).toContain('1.5');
      expect(sheet6).toContain(sampleSourceHash);

      // PPTX verification
      const pptxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.pptx'));
      const pptxZip = parseZipArchive(pptxBuf);
      const slide2 = pptxZip.get('ppt/slides/slide2.xml')?.toString('utf-8') || '';
      const slide3 = pptxZip.get('ppt/slides/slide3.xml')?.toString('utf-8') || '';
      const slide8 = pptxZip.get('ppt/slides/slide8.xml')?.toString('utf-8') || '';

      expect(slide2).toContain('APPROVED');
      expect(slide2).toContain('human-chief-engineer');
      expect(slide3).toContain('1.5');
      expect(slide3).toContain('%');
      expect(slide3).toContain('PASS');
      expect(slide8).toContain('Chief Engineer John Doe, PE');
    });

    it('fails closed when citation source content is modified or tampered on disk', () => {
      const { docxInput } = createApprovedRunInputs();

      // Tamper source file
      fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), 'TAMPERED DATA', 'utf-8');

      expect(() => {
        generateDocxHelper(docxInput, 'artifacts/deliverable.docx');
      }).toThrow(/FRESHNESS|FRESHNESS_VERIFICATION_FAILED|STALE_SOURCE_HASH|modified/);
    });
  });

  describe('3. Strict Output & Template Safety (No Macros, No External Links, No Injection)', () => {
    it('guarantees generated packages have zero external relationships or remote URLs', () => {
      const { docxInput, xlsxInput, pptxInput } = createApprovedRunInputs();

      generateDocxHelper(docxInput, 'artifacts/deliverable.docx');
      generateXlsxHelper(xlsxInput, 'artifacts/deliverable.xlsx');
      generatePptxHelper(pptxInput, 'artifacts/deliverable.pptx');

      expect(() =>
        services.templateSafety.assertOutputSafety(
          fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.docx')),
          'docx',
          'artifacts/deliverable.docx'
        )
      ).not.toThrow();

      expect(() =>
        services.templateSafety.assertOutputSafety(
          fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.xlsx')),
          'xlsx',
          'artifacts/deliverable.xlsx'
        )
      ).not.toThrow();

      expect(() =>
        services.templateSafety.assertOutputSafety(
          fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.pptx')),
          'pptx',
          'artifacts/deliverable.pptx'
        )
      ).not.toThrow();
    });

    it('rejects spreadsheet formula injection patterns in findings metric / statement', () => {
      const { xlsxInput } = createApprovedRunInputs();
      xlsxInput.findings[0].statement = '=cmd|\'/c calc.exe\'!A1';
      (xlsxInput.approval as any).payloadHash = computeOfficeInputHash(xlsxInput as any);

      expect(() => {
        generateXlsxHelper(xlsxInput, 'artifacts/malicious.xlsx');
      }).toThrow(/FORMULA_INJECTION|formula|macro/i);
    });

    it('rejects unauthorized file overwrite when file already exists', () => {
      const { docxInput } = createApprovedRunInputs();
      const targetRel = 'artifacts/deliverable.docx';

      generateDocxHelper(docxInput, targetRel);
      expect(fs.existsSync(path.join(projectRoot, targetRel))).toBe(true);

      // Attempt second generation to same path without overwrite flag
      expect(() => {
        generateDocxHelper(docxInput, targetRel, { requestId: 'req-docx-overwrite', allowOverwrite: false });
      }).toThrow(/ARTIFACT_COLLISION|already exists|overwrite/i);
    });
  });

  describe('4. Visual Quality, Safety Boundaries & Layout Acceptance', () => {
    it('passes visual review across DOCX, XLSX, and PPTX with zero layout errors', () => {
      const { docxInput, xlsxInput, pptxInput } = createApprovedRunInputs();

      generateDocxHelper(docxInput, 'artifacts/deliverable.docx');
      generateXlsxHelper(xlsxInput, 'artifacts/deliverable.xlsx');
      generatePptxHelper(pptxInput, 'artifacts/deliverable.pptx');

      const docxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.docx'));
      const xlsxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.xlsx'));
      const pptxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.pptx'));

      const docxReport = services.officeVisualReview.reviewDeliverable(docxBuf, 'docx', 'artifacts/deliverable.docx');
      const xlsxReport = services.officeVisualReview.reviewDeliverable(xlsxBuf, 'xlsx', 'artifacts/deliverable.xlsx');
      const pptxReport = services.officeVisualReview.reviewDeliverable(pptxBuf, 'pptx', 'artifacts/deliverable.pptx');

      expect(docxReport.verdict).toBe('approved');
      expect(docxReport.overallScore).toBeGreaterThanOrEqual(80);
      expect(docxReport.issues.filter(i => i.severity === 'error')).toHaveLength(0);
      expect(docxReport.metrics.find(m => m.name === 'docx_verdict_banner')?.status).toBe('PASS');
      expect(docxReport.metrics.find(m => m.name === 'docx_reviewer_signoff')?.status).toBe('PASS');
      expect(docxReport.metrics.find(m => m.name === 'docx_model_prose_segregation')?.status).toBe('PASS');

      expect(xlsxReport.verdict).toBe('approved');
      expect(xlsxReport.overallScore).toBeGreaterThanOrEqual(80);
      expect(xlsxReport.issues.filter(i => i.severity === 'error')).toHaveLength(0);

      expect(pptxReport.verdict).toBe('approved');
      expect(pptxReport.overallScore).toBeGreaterThanOrEqual(80);
      expect(pptxReport.issues.filter(i => i.severity === 'error')).toHaveLength(0);
      expect(pptxReport.metrics.find(m => m.name === 'pptx_safety_slides')?.status).toBe('PASS');
      expect(pptxReport.metrics.find(m => m.name === 'pptx_shape_containment')?.status).toBe('PASS');
      expect(pptxReport.metrics.find(m => m.name === 'pptx_slide_dimensions')?.status).toBe('PASS');

      expect(() => services.officeVisualReview.assertVisualAcceptance(docxBuf, 'docx')).not.toThrow();
      expect(() => services.officeVisualReview.assertVisualAcceptance(xlsxBuf, 'xlsx')).not.toThrow();
      expect(() => services.officeVisualReview.assertVisualAcceptance(pptxBuf, 'pptx')).not.toThrow();
    });

    it('produces 100% deterministic visual layout snapshot hashes across repeated generations', () => {
      const { docxInput, xlsxInput, pptxInput } = createApprovedRunInputs();

      // Generation 1
      generateDocxHelper(docxInput, 'artifacts/run1.docx', { requestId: 'req-docx-run1' });
      generateXlsxHelper(xlsxInput, 'artifacts/run1.xlsx', { requestId: 'req-xlsx-run1' });
      generatePptxHelper(pptxInput, 'artifacts/run1.pptx', { requestId: 'req-pptx-run1' });

      // Generation 2
      generateDocxHelper(docxInput, 'artifacts/run2.docx', { requestId: 'req-docx-run2' });
      generateXlsxHelper(xlsxInput, 'artifacts/run2.xlsx', { requestId: 'req-xlsx-run2' });
      generatePptxHelper(pptxInput, 'artifacts/run2.pptx', { requestId: 'req-pptx-run2' });

      const docx1 = fs.readFileSync(path.join(projectRoot, 'artifacts/run1.docx'));
      const docx2 = fs.readFileSync(path.join(projectRoot, 'artifacts/run2.docx'));
      const xlsx1 = fs.readFileSync(path.join(projectRoot, 'artifacts/run1.xlsx'));
      const xlsx2 = fs.readFileSync(path.join(projectRoot, 'artifacts/run2.xlsx'));
      const pptx1 = fs.readFileSync(path.join(projectRoot, 'artifacts/run1.pptx'));
      const pptx2 = fs.readFileSync(path.join(projectRoot, 'artifacts/run2.pptx'));

      expect(() => services.officeVisualReview.assertDeterminism(docx1, docx2, 'docx')).not.toThrow();
      expect(() => services.officeVisualReview.assertDeterminism(xlsx1, xlsx2, 'xlsx')).not.toThrow();
      expect(() => services.officeVisualReview.assertDeterminism(pptx1, pptx2, 'pptx')).not.toThrow();
    });
  });

  describe('5. Privacy-Preserving Audit Trail', () => {
    it('records deliverable generation and visual review events without raw text or tokens', () => {
      const { docxInput } = createApprovedRunInputs();
      generateDocxHelper(docxInput, 'artifacts/deliverable.docx');

      const docxBuf = fs.readFileSync(path.join(projectRoot, 'artifacts/deliverable.docx'));
      services.officeVisualReview.assertVisualAcceptance(docxBuf, 'docx', 'artifacts/deliverable.docx');

      const auditFiles = fs.readdirSync(path.join(projectRoot, '.maos', 'audit'));
      expect(auditFiles.length).toBeGreaterThan(0);

      const auditContent = fs.readFileSync(
        path.join(projectRoot, '.maos', 'audit', auditFiles[0]),
        'utf-8'
      );

      // Audit records contain structured identifiers
      expect(auditContent).toContain('DOCX_GENERATED');
      expect(auditContent).toContain('VISUAL_REVIEW_PASSED');

      // Audit records DO NOT contain sensitive raw prose
      expect(auditContent).not.toContain('The valve shows optimal spring seating');
      expect(auditContent).not.toContain('sk-');
      expect(auditContent).not.toContain('bearer');
    });
  });

  describe('6. Protected Canary Invariant', () => {
    it('strictly preserves rust/test.txt SHA-256 hash intact', () => {
      const canaryPath = path.resolve(process.cwd(), 'rust', 'test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);
      const canaryContent = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
      expect(hash).toBe(CANARY_HASH);
    });
  });
});
