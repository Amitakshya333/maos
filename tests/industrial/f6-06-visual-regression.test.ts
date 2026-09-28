/**
 * MAOS Industrial — Visual Regression & Quality Review Test Suite (F6-06)
 *
 * Validates the visual quality, layout bounds, typography hierarchy,
 * content readability, and visual determinism of generated DOCX, XLSX, and PPTX
 * deliverables without requiring Microsoft Office or LibreOffice binaries.
 *
 * Test Sections:
 * 1. Minimal Valid Deliverables: DOCX, XLSX, and PPTX pass with 'approved' verdict.
 * 2. Long Titles & Section Paragraphs: text wrapping, margin containment, overflow resistance.
 * 3. Large Findings & Measurement Tables: multi-row tables stay within printable bounds.
 * 4. Multiple Citations: complete 5-column cryptographic ledger layout.
 * 5. Empty Optional Sections: robust fallback text rendering without visual collapse.
 * 6. Multi-Slide PPTX Decks: slide numbering, header consistency, 16:9 widescreen canvas containment.
 * 7. XLSX Column Widths & Dimension Bounds: auto-width calculation and cell clipping defense.
 * 8. Layout Overflow & Bounding Violations: negative detection of artificial layout faults.
 * 9. Safety & Governance Visual Boundaries: detection of missing verdict, sign-off, or unsegregated prose.
 * 10. Repeated Generation Determinism: bit-for-bit visual snapshot hash stability.
 * 11. Immutability & Audit Confidentiality: zero side effects, zero credentials/tokens logged.
 * 12. Canary File Invariant: rust/test.txt SHA-256 remains intact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  OfficeVisualReviewService,
  OfficeVisualReviewReport,
  VisualReviewError,
} from '../../src/service/office-visual-review-service';
import {
  reviewOfficePackageVisuals,
  inspectDocxVisuals,
  inspectXlsxVisuals,
  inspectPptxVisuals,
  VISUAL_LAYOUT_CONSTANTS,
} from '../../src/industrial/office/visual-review';
import {
  DocxGeneratorService,
  XlsxGeneratorService,
  PptxGeneratorService,
  OfficeTemplateSafetyService,
  OfficeInputService,
  ArtifactService,
  ApprovalService,
  AuditService,
  EventService,
  DurableIdempotencyStore,
  createServiceContainer,
} from '../../src/service';
import {
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  buildZipArchive,
  parseZipArchive,
  ZipFileInput,
} from '../../src/industrial/office/ooxml-packager';

describe('F6-06: Visual Regression and Quality Review', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let eventService: EventService;
  let approvalService: ApprovalService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;
  let idempotencyStore: DurableIdempotencyStore;
  let templateSafetyService: OfficeTemplateSafetyService;
  let visualReviewService: OfficeVisualReviewService;
  let docxGenerator: DocxGeneratorService;
  let xlsxGenerator: XlsxGeneratorService;
  let pptxGenerator: PptxGeneratorService;

  const sampleSourceContent = 'Safety Valve PSV-101 certified calibration tolerance is 1.5% with set pressure 150 psi.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  // ── Fixture Factory Helpers ────────────────────────────────────────

  function createValidDocxInput(overrides: Partial<OfficeDocxInput> = {}): OfficeDocxInput {
    const base: OfficeDocxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-docx-001',
      taskId: 'task-inspect-01',
      artifactType: 'docx',
      title: 'Safety Valve Inspection Note',
      author: {
        id: 'agent-inspector-01',
        name: 'Lead Inspector Agent',
        role: 'Safety Verification Engineer',
      },
      sections: [
        {
          id: 'sec-1',
          heading: 'Executive Summary',
          content: 'Calibration inspection verified against ASME Section VIII standards.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
        },
      ],
      findings: [
        {
          id: 'find-1',
          category: 'Pressure Relief',
          statement: 'PSV-101 safety relief tolerance observed within approved bounds.',
          severity: 'info',
          status: 'PASS',
          metric: 'relief_tolerance',
          observedValue: 1.5,
          thresholdValue: 2.0,
          unit: '%',
          citationIds: ['cit-1'],
          verified: true,
        },
      ],
      measurements: [
        {
          id: 'meas-1',
          name: 'set_pressure',
          numericValue: 150.0,
          unit: 'psi',
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
      units: ['%', 'psi'],
      calculations: [
        {
          id: 'calc-1',
          name: 'Set Margin',
          inputs: [{ name: 'set_pressure', value: 150.0, unit: 'psi' }],
          methodOrFormula: 'set_pressure * 1.10',
          resultValue: 165.0,
          resultUnit: 'psi',
          verifiedBy: 'deterministic_calc',
        },
      ],
      warnings: [],
      limitations: ['Inspection valid under standard ambient temperature.'],
      proseBlocks: [
        {
          id: 'prose-1',
          label: 'Predictive Valve Life',
          text: 'Machine learning projection suggests next recertification required within 18 months.',
          isModelGenerated: true,
          verifiedAgainstData: false,
          approvedByReviewer: false,
          modelId: 'industrial-vlm-v1',
        },
      ],
      conclusions: [
        {
          id: 'conc-1',
          statement: 'Pressure relief configuration formally accepted for operational deployment.',
          verdict: 'approved',
          signOffIdentity: 'Lead Safety PE (Reg #94821)',
          signedAt: '2026-09-20T10:00:00Z',
        },
      ],
      citations: [
        {
          citationId: 'cit-1',
          sourcePath: 'docs/valves.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-valves-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'PSV Calibration Log',
          snippet: sampleSourceContent,
          verifiedAt: '2026-09-20T10:00:00Z',
        },
      ],
      sourceArtifactIds: [],
      sourceHashes: { 'docs/valves.txt': sampleSourceHash },
      references: [],
      evidenceState: {
        ocrConfidence: 0.98,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true,
        reviewerId: 'human-chief-engineer',
      },
      generatedAt: '2026-09-20T10:00:00Z',
      approval: {
        required: true,
        approvalId: 'appr-docx-001',
        approvedBy: 'lead-engineer@industrial.corp',
        status: 'approved',
        approvedAt: '2026-09-20T10:00:00Z',
      },
    };

    const combined: OfficeDocxInput = { ...base, ...overrides };
    if (overrides.approval) {
      (combined as any).approval = { ...base.approval, ...overrides.approval };
    }
    const hash = computeOfficeInputHash(combined);
    if (!overrides.approval?.payloadHash) {
      (combined as any).approval = {
        ...combined.approval,
        payloadHash: hash,
      };
    }
    return combined;
  }

  function createValidXlsxInput(overrides: Partial<OfficeXlsxInput> = {}): OfficeXlsxInput {
    const base: OfficeXlsxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-xlsx-001',
      taskId: 'task-inspect-xlsx-01',
      artifactType: 'xlsx',
      title: 'Safety Valve Verification Workbook',
      author: {
        id: 'agent-inspector-01',
        name: 'Lead Inspector Agent',
        role: 'Safety Verification Engineer',
      },
      sections: [
        {
          id: 'sec-1',
          heading: 'Executive Inspection Summary',
          content: 'Verification of PSV-101 overpressure mitigation system.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
        },
      ],
      findings: [
        {
          id: 'find-1',
          category: 'Pressure Relief',
          statement: 'PSV-101 safety relief tolerance observed within approved bounds.',
          severity: 'info',
          status: 'PASS',
          metric: 'relief_tolerance',
          observedValue: 1.5,
          thresholdValue: 2.0,
          unit: '%',
          citationIds: ['cit-1'],
          verified: true,
        },
      ],
      measurements: [
        {
          id: 'meas-1',
          name: 'set_pressure',
          numericValue: 150.0,
          unit: 'psi',
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
      units: ['%', 'psi'],
      calculations: [
        {
          id: 'calc-1',
          name: 'Set Margin',
          inputs: [{ name: 'set_pressure', value: 150.0, unit: 'psi' }],
          methodOrFormula: 'set_pressure * 1.10',
          resultValue: 165.0,
          resultUnit: 'psi',
          verifiedBy: 'deterministic_calc',
        },
      ],
      warnings: [],
      limitations: ['Standard plant operating envelope applies.'],
      proseBlocks: [
        {
          id: 'prose-1',
          label: 'Statistical Projection',
          text: 'Parametric degradation model suggests zero leakage risk over 10,000 cycles.',
          isModelGenerated: true,
          verifiedAgainstData: false,
          approvedByReviewer: false,
        },
      ],
      conclusions: [
        {
          id: 'conc-1',
          statement: 'Certified compliant with plant operating envelope.',
          verdict: 'approved',
          signOffIdentity: 'Lead Safety PE (Reg #94821)',
          signedAt: '2026-09-20T10:00:00Z',
        },
      ],
      citations: [
        {
          citationId: 'cit-1',
          sourcePath: 'docs/valves.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-valves-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'PSV Calibration Log',
          snippet: sampleSourceContent,
          verifiedAt: '2026-09-20T10:00:00Z',
        },
      ],
      sourceArtifactIds: [],
      sourceHashes: { 'docs/valves.txt': sampleSourceHash },
      references: [],
      evidenceState: {
        ocrConfidence: 0.98,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true,
        reviewerId: 'human-chief-engineer',
      },
      generatedAt: '2026-09-20T10:00:00Z',
      approval: {
        required: true,
        approvalId: 'appr-xlsx-001',
        approvedBy: 'lead-engineer@industrial.corp',
        status: 'approved',
        approvedAt: '2026-09-20T10:00:00Z',
      },
    };

    const combined: OfficeXlsxInput = { ...base, ...overrides };
    if (overrides.approval) {
      (combined as any).approval = { ...base.approval, ...overrides.approval };
    }
    const hash = computeOfficeInputHash(combined);
    if (!overrides.approval?.payloadHash) {
      (combined as any).approval = {
        ...combined.approval,
        payloadHash: hash,
      };
    }
    return combined;
  }

  function createValidPptxInput(overrides: Partial<OfficePptxInput> = {}): OfficePptxInput {
    const base: OfficePptxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-pptx-001',
      taskId: 'task-inspect-pptx-01',
      artifactType: 'pptx',
      title: 'Pressure Safety Valve Verification Presentation',
      author: {
        id: 'agent-inspector-01',
        name: 'Lead Inspector Agent',
        role: 'Safety Verification Engineer',
      },
      sections: [
        {
          id: 'sec-1',
          heading: 'Executive Inspection Summary',
          content: 'Verification of PSV-101 overpressure mitigation system according to ASME Section VIII.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
        },
      ],
      findings: [
        {
          id: 'find-1',
          category: 'Pressure Relief',
          statement: 'PSV-101 safety relief tolerance observed within approved bounds.',
          severity: 'info',
          status: 'PASS',
          metric: 'relief_tolerance',
          observedValue: 1.5,
          thresholdValue: 2.0,
          unit: '%',
          citationIds: ['cit-1'],
          verified: true,
        },
      ],
      measurements: [
        {
          id: 'meas-1',
          name: 'set_pressure',
          numericValue: 150.0,
          unit: 'psi',
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
      units: ['%', 'psi'],
      calculations: [
        {
          id: 'calc-1',
          name: 'Set Margin',
          inputs: [{ name: 'set_pressure', value: 150.0, unit: 'psi' }],
          methodOrFormula: 'set_pressure * 1.10',
          resultValue: 165.0,
          resultUnit: 'psi',
          verifiedBy: 'deterministic_calc',
        },
      ],
      warnings: [],
      limitations: ['Standard operational boundaries apply.'],
      proseBlocks: [
        {
          id: 'prose-1',
          label: 'Executive Briefing',
          text: 'Synthetic synthesis forecasts zero downtime across upcoming operating quarters.',
          isModelGenerated: true,
          verifiedAgainstData: false,
          approvedByReviewer: false,
        },
      ],
      conclusions: [
        {
          id: 'conc-1',
          statement: 'Plant safety sign-off completed.',
          verdict: 'approved',
          signOffIdentity: 'Lead Safety PE (Reg #94821)',
          signedAt: '2026-09-20T10:00:00Z',
        },
      ],
      citations: [
        {
          citationId: 'cit-1',
          sourcePath: 'docs/valves.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-valves-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'PSV Calibration Log',
          snippet: sampleSourceContent,
          verifiedAt: '2026-09-20T10:00:00Z',
        },
      ],
      sourceArtifactIds: [],
      sourceHashes: { 'docs/valves.txt': sampleSourceHash },
      references: [],
      evidenceState: {
        ocrConfidence: 0.98,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true,
        reviewerId: 'human-chief-engineer',
      },
      generatedAt: '2026-09-20T10:00:00Z',
      approval: {
        required: true,
        approvalId: 'appr-pptx-001',
        approvedBy: 'lead-engineer@industrial.corp',
        status: 'approved',
        approvedAt: '2026-09-20T10:00:00Z',
      },
    };

    const combined: OfficePptxInput = { ...base, ...overrides };
    if (overrides.approval) {
      (combined as any).approval = { ...base.approval, ...overrides.approval };
    }
    const hash = computeOfficeInputHash(combined);
    if (!overrides.approval?.payloadHash) {
      (combined as any).approval = {
        ...combined.approval,
        payloadHash: hash,
      };
    }
    return combined;
  }

  // ── Setup and Teardown ──────────────────────────────────────────────

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-06-test-'));

    // Create directories
    fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });

    // Seed physical source file
    fs.writeFileSync(path.join(projectRoot, 'docs', 'valves.txt'), sampleSourceContent, 'utf-8');

    // Seed approved records matching test fixtures
    for (const [id, task] of [
      ['appr-docx-001', 'task-inspect-01'],
      ['appr-xlsx-001', 'task-inspect-xlsx-01'],
      ['appr-pptx-001', 'task-inspect-pptx-01'],
    ]) {
      fs.writeFileSync(
        path.join(projectRoot, '.maos', 'approvals', `${id}.json`),
        JSON.stringify({
          schemaVersion: 1,
          id,
          taskId: task,
          status: 'approved',
          requestedBy: 'agent-inspector-01',
          approverRole: 'chief_engineer',
          description: `Approval note for ${id}`,
          createdAt: '2026-09-20T10:00:00Z',
          decidedAt: '2026-09-20T10:05:00Z',
          decidedBy: 'human-chief-engineer',
          reason: 'All criteria pass formal safety inspection requirements.',
        }),
        'utf-8',
      );
    }

    eventService = new EventService(projectRoot);
    approvalService = new ApprovalService(projectRoot);
    artifactService = new ArtifactService(projectRoot, eventService, approvalService);
    auditService = new AuditService(projectRoot);
    officeInputService = new OfficeInputService(projectRoot, artifactService, approvalService, auditService);
    idempotencyStore = new DurableIdempotencyStore(projectRoot);
    templateSafetyService = new OfficeTemplateSafetyService(projectRoot, auditService);
    visualReviewService = new OfficeVisualReviewService(projectRoot, auditService);

    docxGenerator = new DocxGeneratorService(
      projectRoot,
      artifactService,
      approvalService,
      auditService,
      officeInputService,
      idempotencyStore,
      templateSafetyService,
    );

    xlsxGenerator = new XlsxGeneratorService(
      projectRoot,
      artifactService,
      approvalService,
      auditService,
      officeInputService,
      idempotencyStore,
      templateSafetyService,
    );

    pptxGenerator = new PptxGeneratorService(
      projectRoot,
      artifactService,
      approvalService,
      auditService,
      officeInputService,
      idempotencyStore,
      templateSafetyService,
    );
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  // ── Section 1: Minimal Valid Deliverables ───────────────────────────

  describe('1. Minimal Valid Deliverables Visual Quality', () => {
    it('validates minimal valid DOCX with approved verdict and zero blocking errors', () => {
      const input = createValidDocxInput();
      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/note.docx',
        requestId: 'req-vis-docx-01',
      });

      expect(res.ok).toBe(true);
      const docxBytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));

      const report = visualReviewService.reviewDeliverable(docxBytes, 'docx');
      expect(report.verdict).toBe('approved');
      expect(report.overallScore).toBeGreaterThanOrEqual(90);
      expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
      expect(report.visualSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.layoutBounds.overflowDetected).toBe(false);

      // Assert visual acceptance does not throw
      expect(() => visualReviewService.assertVisualAcceptance(docxBytes, 'docx')).not.toThrow();
    });

    it('validates minimal valid XLSX with approved verdict and organized sheets', () => {
      const input = createValidXlsxInput();
      const res = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/sheet.xlsx',
        requestId: 'req-vis-xlsx-01',
      });

      expect(res.ok).toBe(true);
      const xlsxBytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));

      const report = visualReviewService.reviewDeliverable(xlsxBytes, 'xlsx');
      expect(report.verdict).toBe('approved');
      expect(report.overallScore).toBeGreaterThanOrEqual(90);
      expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
      expect(report.layoutBounds.pageOrSlideCount).toBeGreaterThanOrEqual(7);
      expect(report.visualSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

      expect(() => visualReviewService.assertVisualAcceptance(xlsxBytes, 'xlsx')).not.toThrow();
    });

    it('validates minimal valid PPTX with approved verdict, 16:9 canvas, and governance slides', () => {
      const input = createValidPptxInput();
      const res = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/deck.pptx',
        requestId: 'req-vis-pptx-01',
      });

      expect(res.ok).toBe(true);
      const pptxBytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));

      const report = visualReviewService.reviewDeliverable(pptxBytes, 'pptx');
      expect(report.verdict).toBe('approved');
      expect(report.overallScore).toBeGreaterThanOrEqual(90);
      expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
      expect(report.layoutBounds.pageOrSlideCount).toBeGreaterThanOrEqual(8);
      expect(report.layoutBounds.overflowDetected).toBe(false);
      expect(report.visualSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

      expect(() => visualReviewService.assertVisualAcceptance(pptxBytes, 'pptx')).not.toThrow();
    });
  });

  // ── Section 2: Long Titles and Section Paragraphs ───────────────────

  describe('2. Long Titles and Section Paragraphs Layout Bounds', () => {
    it('DOCX correctly bounds long title and lengthy multiline paragraph', () => {
      const longTitle = 'Comprehensive Multi-Stage Overpressure Safety Verification & Calibration Analysis for High-Pressure Critical Service Systems (ASME Section VIII Div 1)';
      const longContent = 'A'.repeat(500) + ' ' + 'B'.repeat(500) + ' ' + 'C'.repeat(500);

      const input = createValidDocxInput({
        title: longTitle,
        sections: [
          {
            id: 'sec-long',
            heading: 'Deep Narrative Technical Evaluation & Methodological Review',
            content: longContent,
            order: 1,
          },
        ],
      });

      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/long_docx.docx',
        requestId: 'req-vis-long-docx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'docx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.overflowDetected).toBe(false);
    });

    it('XLSX column widths accommodate extended titles and headings without clipping', () => {
      const longTitle = 'Super-Critical Safety Relief Calibration Ledger With Extended Column Headers';
      const input = createValidXlsxInput({ title: longTitle });

      const res = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/long_xlsx.xlsx',
        requestId: 'req-vis-long-xlsx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'xlsx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.maxContentWidth).toBeGreaterThanOrEqual(10);
    });

    it('PPTX title stays within title-safe canvas area with long title', () => {
      const longTitle = 'Comprehensive Technical Assessment of Plant Safety Valve PSV-101 Set Points and Margin';
      const input = createValidPptxInput({ title: longTitle });

      const res = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/long_pptx.pptx',
        requestId: 'req-vis-long-pptx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'pptx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.overflowDetected).toBe(false);
    });
  });

  // ── Section 3: Large Findings and Measurement Tables ────────────────

  describe('3. Large Findings and Measurement Tables', () => {
    it('DOCX table grid remains strictly bounded within printable width with 15 findings', () => {
      const manyFindings = Array.from({ length: 15 }, (_, i) => ({
        id: `find-${i + 1}`,
        category: 'Pressure Safety',
        statement: `Observed relief parameter #${i + 1} certified nominal within industrial test limits.`,
        severity: 'info' as const,
        status: 'PASS' as const,
        metric: `pressure_metric_${i + 1}`,
        observedValue: 140 + i,
        thresholdValue: 160,
        unit: 'psi',
        citationIds: ['cit-1'],
        verified: true,
      }));

      const input = createValidDocxInput({ findings: manyFindings });
      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/large_tables.docx',
        requestId: 'req-vis-large-docx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'docx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.overflowDetected).toBe(false);
      expect(report.layoutBounds.maxContentWidth).toBeLessThanOrEqual(VISUAL_LAYOUT_CONSTANTS.DOCX_PRINTABLE_WIDTH_TWIPS + 300);
    });

    it('PPTX renders dedicated slides for embedded section tables within 16:9 canvas', () => {
      const input = createValidPptxInput({
        sections: [
          {
            id: 'sec-table-1',
            heading: 'Detailed Calibration Matrix',
            content: 'Matrix of 10 sequential calibration tests across three thermal regimes.',
            order: 1,
            tables: [
              {
                id: 'tbl-matrix-01',
                title: 'Sensor Thermal Regime Log',
                columns: [
                  { key: 'run', label: 'Test #' },
                  { key: 'temp', label: 'Temp', unit: '°C' },
                  { key: 'psi', label: 'Pressure', unit: 'psi' },
                  { key: 'verdict', label: 'Status' },
                ],
                rows: Array.from({ length: 6 }, (_, i) => ({
                  run: i + 1,
                  temp: 20 + i * 5,
                  psi: 150.2 + i * 0.1,
                  verdict: 'PASS',
                })),
              },
            ],
          },
        ],
      });

      const res = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/table_deck.pptx',
        requestId: 'req-vis-tbl-pptx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'pptx');

      expect(report.verdict).toBe('approved');
      // Must contain standard 9 slides + 1 dynamic table slide = 10 slides
      expect(report.layoutBounds.pageOrSlideCount).toBeGreaterThanOrEqual(10);
      expect(report.layoutBounds.overflowDetected).toBe(false);
    });
  });

  // ── Section 4: Multiple Citations & Provenance Ledger ────────────────

  describe('4. Multiple Citations and Provenance Ledger', () => {
    it('verifies visual layout of citations ledger with 10 cryptographic citations', () => {
      const citations = Array.from({ length: 10 }, (_, i) => ({
        citationId: `cit-${i + 1}`,
        sourcePath: 'docs/valves.txt',
        sourceHash: sampleSourceHash,
        documentId: 'doc-valves-01',
        chunkId: `chunk-${String(i + 1).padStart(3, '0')}`,
        pageNumber: i + 1,
        sectionHeading: `Calibration Protocol Part ${i + 1}`,
        snippet: `Verified snippet for calibration verification record #${i + 1}.`,
        verifiedAt: '2026-09-20T10:00:00Z',
      }));

      const input = createValidDocxInput({ citations });
      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/citations.docx',
        requestId: 'req-vis-cit-docx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'docx');

      expect(report.verdict).toBe('approved');
      const citMetric = report.metrics.find((m) => m.name === 'docx_citations_ledger');
      expect(citMetric?.status).toBe('PASS');
    });
  });

  // ── Section 5: Empty Optional Sections Fallback ─────────────────────

  describe('5. Empty Optional Sections Fallback Handling', () => {
    it('DOCX gracefully renders clean fallbacks with empty optional collections', () => {
      const input = createValidDocxInput({
        calculations: [],
        warnings: [],
        limitations: [],
        proseBlocks: [],
      });

      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/empty_opt.docx',
        requestId: 'req-vis-empty-docx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'docx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.overflowDetected).toBe(false);
    });

    it('PPTX renders standard boundary cards when warnings and prose blocks are empty', () => {
      const input = createValidPptxInput({
        warnings: [],
        limitations: [],
        proseBlocks: [],
      });

      const res = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/empty_opt.pptx',
        requestId: 'req-vis-empty-pptx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'pptx');

      expect(report.verdict).toBe('approved');
      expect(report.layoutBounds.overflowDetected).toBe(false);
    });
  });

  // ── Section 6: XLSX Column Widths & Bounds ──────────────────────────

  describe('6. XLSX Column Auto-Widths & Bounds', () => {
    it('verifies column widths dynamically scale and bounds are correctly formed', () => {
      const input = createValidXlsxInput();
      const res = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/bounds.xlsx',
        requestId: 'req-vis-col-xlsx',
      });

      expect(res.ok).toBe(true);
      const bytes = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      const report = visualReviewService.reviewDeliverable(bytes, 'xlsx');

      expect(report.verdict).toBe('approved');
      const colMetric = report.metrics.find((m) => m.name === 'xlsx_column_widths');
      expect(colMetric?.status).toBe('PASS');
    });
  });

  // ── Section 7: Negative Fault & Overflow Detection ──────────────────

  describe('7. Negative Fault & Overflow Detection', () => {
    it('detects and rejects intentional table layout overflow in DOCX', () => {
      // Build artificial DOCX with an oversized table grid exceeding 15,000 twips (printable is ~9,360)
      const oversizedDocxFiles: ZipFileInput[] = [
        {
          path: '[Content_Types].xml',
          data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        },
        {
          path: 'word/document.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Sample</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid>
        <w:gridCol w:w="8000"/>
        <w:gridCol w:w="8000"/>
      </w:tblGrid>
      <w:tr><w:tc><w:p><w:r><w:t>Col 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Col 2</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:left="1440" w:right="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`,
        },
      ];

      const badBuf = buildZipArchive(oversizedDocxFiles);
      const report = visualReviewService.reviewDeliverable(badBuf, 'docx');

      expect(report.verdict).toBe('rejected');
      expect(report.layoutBounds.overflowDetected).toBe(true);
      const overflowIssue = report.issues.find((i) => i.code === 'LAYOUT_OVERFLOW');
      expect(overflowIssue).toBeDefined();
      expect(overflowIssue?.observed).toBe(16000);

      expect(() => visualReviewService.assertVisualAcceptance(badBuf, 'docx')).toThrow(VisualReviewError);
    });

    it('detects and rejects shape placed out-of-bounds in PPTX', () => {
      // Build artificial PPTX with a shape positioned at x=14,000,000 (canvas width is 12,192,000)
      const outOfBoundsPptxFiles: ZipFileInput[] = [
        {
          path: '[Content_Types].xml',
          data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        },
        {
          path: 'ppt/presentation.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" id2="rId1"/></p:sldIdLst></p:presentation>`,
        },
        {
          path: 'ppt/slides/slide1.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:spPr><a:xfrm><a:off x="13000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Out of bounds shape</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
        },
      ];

      const badBuf = buildZipArchive(outOfBoundsPptxFiles);
      const report = visualReviewService.reviewDeliverable(badBuf, 'pptx');

      expect(report.verdict).toBe('rejected');
      expect(report.layoutBounds.overflowDetected).toBe(true);
      const oobIssue = report.issues.find((i) => i.code === 'OUT_OF_BOUNDS');
      expect(oobIssue).toBeDefined();

      expect(() => visualReviewService.assertVisualAcceptance(badBuf, 'pptx')).toThrow(VisualReviewError);
    });

    it('detects and flags unsegregated model prose lacking warning disclaimer', () => {
      const unsegregatedDocxFiles: ZipFileInput[] = [
        {
          path: '[Content_Types].xml',
          data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        },
        {
          path: 'word/document.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Model Generated Content (Unverified)</w:t></w:r></w:p>
    <w:p><w:r><w:t>This generative text is presented without any warning banner or highlight.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
        },
      ];

      const badBuf = buildZipArchive(unsegregatedDocxFiles);
      const report = visualReviewService.reviewDeliverable(badBuf, 'docx');

      expect(report.verdict).toBe('rejected');
      const proseIssue = report.issues.find((i) => i.code === 'PROSE_NOT_SEGREGATED');
      expect(proseIssue).toBeDefined();
    });

    it('detects and flags missing verdict banner and reviewer sign-off block in DOCX', () => {
      const bareDocxFiles: ZipFileInput[] = [
        {
          path: '[Content_Types].xml',
          data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        },
        {
          path: 'word/document.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Bare document without governance blocks</w:t></w:r></w:p>
  </w:body>
</w:document>`,
        },
      ];

      const badBuf = buildZipArchive(bareDocxFiles);
      const report = visualReviewService.reviewDeliverable(badBuf, 'docx');

      expect(report.verdict).toBe('rejected');
      expect(report.issues.some((i) => i.code === 'MISSING_VERDICT_BANNER')).toBe(true);
      expect(report.issues.some((i) => i.code === 'MISSING_SIGN_OFF')).toBe(true);
    });
  });

  // ── Section 8: Repeated Generation Determinism ──────────────────────

  describe('8. Repeated Generation Determinism', () => {
    it('DOCX repeated generation produces identical visual snapshot hashes', () => {
      const input = createValidDocxInput();

      const res1 = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det1.docx',
        requestId: 'req-det-1',
      });
      const res2 = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det2.docx',
        requestId: 'req-det-2',
      });

      const buf1 = fs.readFileSync(path.join(projectRoot, res1.relativePath!));
      const buf2 = fs.readFileSync(path.join(projectRoot, res2.relativePath!));

      const report1 = visualReviewService.reviewDeliverable(buf1, 'docx');
      const report2 = visualReviewService.reviewDeliverable(buf2, 'docx');

      expect(report1.visualSnapshotHash).toBe(report2.visualSnapshotHash);
      expect(() => visualReviewService.assertDeterminism(buf1, buf2, 'docx')).not.toThrow();
    });

    it('XLSX repeated generation produces identical visual snapshot hashes', () => {
      const input = createValidXlsxInput();

      const res1 = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det1.xlsx',
        requestId: 'req-det-xlsx-1',
      });
      const res2 = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det2.xlsx',
        requestId: 'req-det-xlsx-2',
      });

      const buf1 = fs.readFileSync(path.join(projectRoot, res1.relativePath!));
      const buf2 = fs.readFileSync(path.join(projectRoot, res2.relativePath!));

      const report1 = visualReviewService.reviewDeliverable(buf1, 'xlsx');
      const report2 = visualReviewService.reviewDeliverable(buf2, 'xlsx');

      expect(report1.visualSnapshotHash).toBe(report2.visualSnapshotHash);
      expect(() => visualReviewService.assertDeterminism(buf1, buf2, 'xlsx')).not.toThrow();
    });

    it('PPTX repeated generation produces identical visual snapshot hashes', () => {
      const input = createValidPptxInput();

      const res1 = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det1.pptx',
        requestId: 'req-det-pptx-1',
      });
      const res2 = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/det2.pptx',
        requestId: 'req-det-pptx-2',
      });

      const buf1 = fs.readFileSync(path.join(projectRoot, res1.relativePath!));
      const buf2 = fs.readFileSync(path.join(projectRoot, res2.relativePath!));

      const report1 = visualReviewService.reviewDeliverable(buf1, 'pptx');
      const report2 = visualReviewService.reviewDeliverable(buf2, 'pptx');

      expect(report1.visualSnapshotHash).toBe(report2.visualSnapshotHash);
      expect(() => visualReviewService.assertDeterminism(buf1, buf2, 'pptx')).not.toThrow();
    });
  });

  // ── Section 9: Service Container & Privacy Audit Trail ──────────────

  describe('9. Service Container & Privacy Audit Trail', () => {
    it('OfficeVisualReviewService is accessible via ServiceContainer', () => {
      const container = createServiceContainer(projectRoot);
      expect(container.officeVisualReview).toBeInstanceOf(OfficeVisualReviewService);
    });

    it('records privacy-safe audit records with hashes and scores without leaking secrets', () => {
      const input = createValidDocxInput();
      const res = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/audit_check.docx',
        requestId: 'req-vis-audit-01',
      });

      const buf = fs.readFileSync(path.join(projectRoot, res.relativePath!));
      visualReviewService.reviewDeliverable(buf, 'docx');

      const auditRecords = auditService.getRecords();
      const visualEvents = auditRecords.filter((r) => r.source === 'office-visual-review-service');
      expect(visualEvents.length).toBeGreaterThan(0);

      for (const ev of visualEvents) {
        const jsonStr = JSON.stringify(ev.data);
        expect(jsonStr).not.toContain('password');
        expect(jsonStr).not.toContain('token');
        expect(jsonStr).not.toContain('apiKey');
        expect(jsonStr).not.toContain('secret');
        expect(ev.data).toHaveProperty('visualSnapshotHash');
        expect(ev.data).toHaveProperty('overallScore');
      }
    });
  });

  // ── Section 10: Invariant and Canary File Integrity ─────────────────

  describe('10. Invariants and Canary File Integrity', () => {
    it('guarantees rust/test.txt canary file hash remains strictly intact', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_HASH);
    });
  });
});
