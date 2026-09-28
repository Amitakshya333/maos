/**
 * F6-01: Validated Office Artifact Inputs Test Suite
 *
 * Validates the core requirements for Phase F6-01:
 *   1. Complete valid input for DOCX, XLSX, and PPTX
 *   2. Strict separation of structured data, citations, unverified prose, corrections, and conclusions
 *   3. Missing citations and provenance validation
 *   4. Missing units and numeric validation
 *   5. OCR/VLM confidence, conflict review, and quarantine guardrails
 *   6. Mandatory approval state enforcement
 *   7. Cross-project boundary confinement
 *   8. Path traversal and external path rejection
 *   9. Spreadsheet formula injection rejection
 *  10. Macro, script, and external URL/relationship rejection
 *  11. Bounds and limits enforcement (lengths, counts, bytes)
 *  12. Deterministic canonical input hashing and tampering detection
 *  13. Dynamic freshness verification (stale source, missing file, altered artifact, revoked approval)
 *  14. Privacy-safe audit trail integration
 *  15. Protected canary file invariant (rust/test.txt)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  ValidatedOfficeArtifactInput,
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  validateOfficeArtifactInput,
  computeOfficeInputHash,
  isPotentialFormulaInjection,
  containsExternalRelationship,
  containsMacroOrExecutable,
  isSafeIndustrialPath,
  OFFICE_INPUT_BOUNDS,
} from '../../src/domain/office-artifact';
import {
  OfficeInputService,
} from '../../src/service/office-input-service';
import {
  ArtifactService,
} from '../../src/service/artifact-service';
import {
  ApprovalService,
} from '../../src/service/approval-service';
import {
  AuditService,
} from '../../src/service/audit-service';

describe('F6-01: Validated Office Artifact Inputs', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let artifactService: ArtifactService;
  let approvalService: ApprovalService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;

  const sampleSourceContent = 'Safety Valve PSV-101 calibration tolerance is 1.5% with set pressure 150 psi.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  function createValidInput(overrides: Partial<ValidatedOfficeArtifactInput> = {}): ValidatedOfficeArtifactInput {
    return {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-001',
      taskId: 'task-inspect-01',
      artifactType: 'docx',
      title: 'Pressure Safety Valve Inspection Report',
      author: {
        id: 'agent-inspector-01',
        name: 'Lead Inspector Agent',
        role: 'Inspection Engineer',
      },
      sections: [
        {
          id: 'sec-1',
          heading: '1. Executive Summary',
          content: 'Calibration inspection verified against standard procedures.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
        },
      ],
      findings: [
        {
          id: 'find-1',
          category: 'Calibration',
          statement: 'PSV-101 safety relief tolerance observed within approved limits.',
          severity: 'info',
          status: 'PASS',
          metric: 'tolerance',
          observedValue: 1.5,
          thresholdValue: 2.0,
          unit: '%',
          citationIds: ['cit-1'],
          verified: true,
          ruleId: 'RULE-PSV-TOLERANCE-01',
        },
      ],
      measurements: [
        {
          id: 'meas-1',
          name: 'Set Pressure',
          numericValue: 150,
          unit: 'psi',
          tolerance: 2.0,
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
      units: ['%', 'psi'],
      calculations: [
        {
          id: 'calc-1',
          name: 'Variance Calculation',
          inputs: [
            { name: 'Nominal', value: 150, unit: 'psi' },
            { name: 'Observed', value: 152.25, unit: 'psi' },
          ],
          methodOrFormula: 'abs(Observed - Nominal) / Nominal * 100',
          resultValue: 1.5,
          resultUnit: '%',
          verifiedBy: 'rust_engine',
          citationIds: ['cit-1'],
        },
      ],
      warnings: [],
      limitations: [
        'Visual observation confined to nameplate and calibration gauge dial face.',
      ],
      citations: [
        {
          citationId: 'cit-1',
          sourcePath: 'docs/psv_manual.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-psv-01',
          chunkId: 'chk-psv-001',
          pageNumber: 1,
          sectionHeading: 'Tolerance Specifications',
          snippet: 'calibration tolerance is 1.5% with set pressure 150 psi',
          verifiedAt: '2026-09-19T20:00:00Z',
        },
      ],
      sourceArtifactIds: [],
      sourceHashes: {
        'docs/psv_manual.txt': sampleSourceHash,
      },
      references: [
        {
          id: 'ref-1',
          sourcePath: 'docs/psv_manual.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-psv-01',
        },
      ],
      evidenceState: {
        ocrConfidence: 0.98,
        vlmConfidence: 0.95,
        conflictClassification: 'AGREE',
        resolutionStatus: 'accepted_ocr',
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: false,
      },
      modelIdentity: {
        modelId: 'Qwen/Qwen2-VL-2B-Instruct',
        revision: 'aa70c964147048705c93c4e16ff2bc55255470d0',
      },
      generatedAt: '2026-09-19T22:00:00Z',
      approval: {
        required: true,
        status: 'approved',
        approvalId: 'appr-001',
        approvedBy: 'Chief Engineer',
        approvedAt: '2026-09-19T22:05:00Z',
      },
      proseBlocks: [
        {
          id: 'prose-1',
          label: 'System Commentary',
          text: 'The equipment operates under normal industrial parameters.',
          isModelGenerated: true,
          verifiedAgainstData: true,
          approvedByReviewer: true,
        },
      ],
      conclusions: [
        {
          id: 'concl-1',
          statement: 'PSV-101 is fit for continued industrial operation.',
          verdict: 'approved',
          signOffIdentity: 'Chief Engineer (PE #88412)',
          signedAt: '2026-09-19T22:10:00Z',
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-01-test-'));
    fs.mkdirSync(path.join(projectRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });

    // Seed config
    fs.writeFileSync(
      path.join(projectRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'test-project', id: 'test-project' }),
    );

    // Seed physical file on disk matching sampleSourceHash
    fs.writeFileSync(path.join(projectRoot, 'docs', 'psv_manual.txt'), sampleSourceContent, 'utf-8');

    approvalService = new ApprovalService(projectRoot);
    auditService = new AuditService(projectRoot);
    artifactService = new ArtifactService(projectRoot, undefined, approvalService);
    officeInputService = new OfficeInputService(projectRoot, artifactService, approvalService, auditService);

    // Create and approve appr-001 in approval store
    approvalService.createApproval({ id: 'appr-001', gateId: 'G6' });
    approvalService.decideApproval('appr-001', 'approved', 'Chief Engineer');
  });

  afterEach(() => {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Valid Complete Inputs Across Output Types ───────────────────

  describe('1. Valid Complete Inputs for Output Types', () => {
    it('validates a complete DOCX input successfully', () => {
      const docxInput: OfficeDocxInput = {
        ...createValidInput({ artifactType: 'docx' }),
        docxOptions: {
          headerText: 'CONFIDENTIAL INDUSTRIAL REPORT',
          footerText: 'Page 1 of 1',
          tableOfContents: true,
        },
      };

      const result = officeInputService.validateInput(docxInput);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.canonicalHash).toBeDefined();
      expect(result.canonicalHash).toHaveLength(64);
    });

    it('validates a complete XLSX input with tabular sheets', () => {
      const xlsxInput: OfficeXlsxInput = {
        ...createValidInput({
          artifactType: 'xlsx',
          sections: [
            {
              id: 'sec-sheet1',
              heading: 'PSV Log Sheet',
              order: 1,
              tables: [
                {
                  id: 'tbl-psv-data',
                  title: 'Pressure Measurements',
                  columns: [
                    { key: 'tag', label: 'Tag No.' },
                    { key: 'pressure', label: 'Set Pressure', unit: 'psi', numeric: true },
                    { key: 'tolerance', label: 'Tolerance', unit: '%', numeric: true },
                  ],
                  rows: [
                    { tag: 'PSV-101', pressure: 150, tolerance: 1.5 },
                    { tag: 'PSV-102', pressure: 220, tolerance: 1.8 },
                  ],
                  citationIds: ['cit-1'],
                },
              ],
            },
          ],
        }),
        xlsxOptions: {
          sheets: [{ sheetName: 'PSV Calibration', tableId: 'tbl-psv-data' }],
        },
      };

      const result = officeInputService.validateInput(xlsxInput);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.canonicalHash).toBeDefined();
    });

    it('validates a complete PPTX input with slide presentation structure', () => {
      const pptxInput: OfficePptxInput = {
        ...createValidInput({ artifactType: 'pptx' }),
        pptxOptions: {
          slideDeckTitle: 'Industrial PSV Executive Review',
          maxSlides: 10,
        },
      };

      const result = officeInputService.validateInput(pptxInput);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.canonicalHash).toBeDefined();
    });

    it('strictly preserves separation between structured data, prose, corrections, and conclusions', () => {
      const input = createValidInput({
        findings: [
          {
            id: 'find-1',
            category: 'Calibration',
            statement: 'Observed set pressure deviates from baseline.',
            severity: 'warning',
            status: 'WARNING',
            metric: 'pressure',
            observedValue: 154.5,
            thresholdValue: 150.0,
            unit: 'psi',
            citationIds: ['cit-1'],
            verified: true,
            reviewerCorrection: {
              reviewerId: 'reviewer-senior-01',
              timestamp: '2026-09-19T21:00:00Z',
              field: 'observedValue',
              originalValue: 158.0,
              correctedValue: 154.5,
              reason: 'Parallax error on dial face corrected by micrometer gauge check',
            },
          },
        ],
        proseBlocks: [
          {
            id: 'prose-unverified',
            label: 'Draft Summary',
            text: 'Draft summary generated by model.',
            isModelGenerated: true,
            verifiedAgainstData: false,
            approvedByReviewer: false,
          },
        ],
        conclusions: [
          {
            id: 'concl-final',
            statement: 'Approved for operation pending recalibration within 30 days.',
            verdict: 'conditional',
            signOffIdentity: 'Senior Reviewer #4102',
            signedAt: '2026-09-19T22:15:00Z',
            conditions: ['Recalibrate within 30 days'],
          },
        ],
      });

      const result = officeInputService.validateInput(input);
      expect(result.valid).toBe(true);
      // Data remains distinctly separated in the typed contract
      expect(input.findings[0].reviewerCorrection?.correctedValue).toBe(154.5);
      expect(input.proseBlocks[0].verifiedAgainstData).toBe(false);
      expect(input.conclusions[0].verdict).toBe('conditional');
    });
  });

  // ── 2. Citations & Provenance Validation ───────────────────────────

  describe('2. Citations and Provenance Validation', () => {
    it('rejects finding with empty citationIds', () => {
      const input = createValidInput({
        findings: [
          {
            id: 'find-uncited',
            category: 'Safety',
            statement: 'Uncited finding claim.',
            severity: 'critical',
            status: 'FAIL',
            citationIds: [], // Missing citation!
            verified: false,
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_CITATION'))).toBe(true);
    });

    it('rejects finding referencing non-existent citationId', () => {
      const input = createValidInput({
        findings: [
          {
            id: 'find-bad-cit',
            category: 'Safety',
            statement: 'Finding citing non-existent citation.',
            severity: 'info',
            status: 'PASS',
            citationIds: ['non-existent-cit-id'],
            verified: true,
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_CITATION'))).toBe(true);
    });

    it('rejects measurement with empty citationIds', () => {
      const input = createValidInput({
        measurements: [
          {
            id: 'meas-uncited',
            name: 'Flow rate',
            numericValue: 45.2,
            unit: 'l/min',
            citationIds: [], // Missing citation!
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_CITATION'))).toBe(true);
    });

    it('rejects citation with invalid or tampered SHA-256 hash', () => {
      const input = createValidInput({
        citations: [
          {
            citationId: 'cit-1',
            sourcePath: 'docs/psv_manual.txt',
            sourceHash: 'short-invalid-hash', // Not 64 hex chars
            snippet: 'sample',
            verifiedAt: '2026-09-19T20:00:00Z',
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TAMPERED_PROVENANCE'))).toBe(true);
    });
  });

  // ── 3. Units and Numeric Validation ────────────────────────────────

  describe('3. Units and Numeric Validation', () => {
    it('rejects measurement with missing unit', () => {
      const input = createValidInput({
        measurements: [
          {
            id: 'meas-no-unit',
            name: 'Clearance',
            numericValue: 0.05,
            unit: '', // Empty unit
            citationIds: ['cit-1'],
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_UNIT'))).toBe(true);
    });

    it('rejects measurement with NaN numericValue', () => {
      const input = createValidInput({
        measurements: [
          {
            id: 'meas-nan',
            name: 'Clearance',
            numericValue: NaN,
            unit: 'mm',
            citationIds: ['cit-1'],
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('INVALID_NUMERIC_VALUE'))).toBe(true);
    });

    it('rejects finding with metric but missing unit', () => {
      const input = createValidInput({
        findings: [
          {
            id: 'find-no-unit',
            category: 'Inspection',
            statement: 'Clearance is 0.05 without unit.',
            severity: 'warning',
            status: 'WARNING',
            metric: 'clearance',
            observedValue: 0.05,
            citationIds: ['cit-1'],
            verified: true,
            unit: '', // Missing unit
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_UNIT'))).toBe(true);
    });

    it('rejects calculation with missing resultUnit', () => {
      const input = createValidInput({
        calculations: [
          {
            id: 'calc-bad',
            name: 'Ratio',
            inputs: [],
            methodOrFormula: '1/2',
            resultValue: 0.5,
            resultUnit: '',
            verifiedBy: 'deterministic_calc',
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MISSING_UNIT'))).toBe(true);
    });
  });

  // ── 4. OCR / VLM Confidence, Conflicts, and Quarantine ─────────────

  describe('4. OCR/VLM Confidence and Conflict Guardrails', () => {
    it('rejects input with unresolved conflicts', () => {
      const input = createValidInput({
        evidenceState: {
          hasUnresolvedConflicts: true,
          isQuarantined: false,
          reviewedByHuman: false,
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('UNRESOLVED_CONFLICT'))).toBe(true);
    });

    it('rejects input with REQUIRES_HUMAN_REVIEW that is still unresolved', () => {
      const input = createValidInput({
        evidenceState: {
          hasUnresolvedConflicts: false,
          conflictClassification: 'REQUIRES_HUMAN_REVIEW',
          resolutionStatus: 'unresolved',
          isQuarantined: false,
          reviewedByHuman: false,
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('UNRESOLVED_CONFLICT'))).toBe(true);
    });

    it('rejects input referencing quarantined evidence', () => {
      const input = createValidInput({
        evidenceState: {
          hasUnresolvedConflicts: false,
          isQuarantined: true, // Prompt-injected or quarantined!
          reviewedByHuman: false,
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('UNRESOLVED_CONFLICT'))).toBe(true);
    });

    it('rejects low OCR confidence without human review', () => {
      const input = createValidInput({
        evidenceState: {
          ocrConfidence: 0.65, // < 0.70 threshold
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: false,
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('LOW_CONFIDENCE_UNREVIEWED'))).toBe(true);
    });

    it('accepts low OCR confidence when reviewedByHuman is true with warning', () => {
      const input = createValidInput({
        evidenceState: {
          ocrConfidence: 0.65,
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: true, // Human review override
          reviewerId: 'engineer-expert-01',
          reviewerNotes: 'Verified against physical stamped nameplate',
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(true);
      expect(res.warnings.some((w) => w.includes('Low OCR confidence'))).toBe(true);
    });

    it('rejects low VLM confidence without human review', () => {
      const input = createValidInput({
        evidenceState: {
          vlmConfidence: 0.50, // < 0.60 threshold
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: false,
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('LOW_CONFIDENCE_UNREVIEWED'))).toBe(true);
    });

    it('accepts low VLM confidence when reviewedByHuman is true with warning', () => {
      const input = createValidInput({
        evidenceState: {
          vlmConfidence: 0.50,
          hasUnresolvedConflicts: false,
          isQuarantined: false,
          reviewedByHuman: true,
          reviewerId: 'engineer-expert-01',
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(true);
      expect(res.warnings.some((w) => w.includes('Low VLM confidence'))).toBe(true);
    });
  });

  // ── 5. Approval Enforcement ────────────────────────────────────────

  describe('5. Approval Enforcement', () => {
    it('rejects input when approval is required but status is pending', () => {
      const input = createValidInput({
        approval: {
          required: true,
          status: 'pending', // Not yet approved!
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('APPROVAL_REQUIRED'))).toBe(true);
    });

    it('rejects input when approval is required but status is rejected', () => {
      const input = createValidInput({
        approval: {
          required: true,
          status: 'rejected',
          approvedBy: 'Safety Officer',
          comment: 'Rejected due to missing calibration certificate',
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('APPROVAL_REQUIRED'))).toBe(true);
    });

    it('accepts input when approval is required and status is approved', () => {
      const input = createValidInput({
        approval: {
          required: true,
          status: 'approved',
          approvalId: 'appr-001',
          approvedBy: 'Chief Engineer',
          approvedAt: '2026-09-19T22:05:00Z',
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(true);
    });

    it('accepts input when approval is not required', () => {
      const input = createValidInput({
        approval: {
          required: false,
          status: 'not_required',
        },
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(true);
    });
  });

  // ── 6. Cross-Project Boundary Confinement ──────────────────────────

  describe('6. Cross-Project Confinement', () => {
    it('rejects input whose projectId does not match active projectRoot', () => {
      const input = createValidInput({
        projectId: 'foreign-project-xyz', // Mismatch!
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('CROSS_PROJECT_FORBIDDEN'))).toBe(true);
    });

    it('permits matching projectId', () => {
      const input = createValidInput({
        projectId: 'test-project',
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(true);
    });
  });

  // ── 7. Path Traversal and Confinement Attacks ──────────────────────

  describe('7. Path Traversal & External Path Confinement', () => {
    it('rejects citation sourcePath with path traversal (..)', () => {
      const input = createValidInput({
        citations: [
          {
            citationId: 'cit-trav',
            sourcePath: '../../etc/shadow',
            sourceHash: sampleSourceHash,
            snippet: 'malicious',
            verifiedAt: '2026-09-19T20:00:00Z',
          },
        ],
        findings: [
          {
            id: 'find-1',
            category: 'Safety',
            statement: 'Test statement',
            severity: 'info',
            status: 'PASS',
            citationIds: ['cit-trav'],
            verified: true,
          },
        ],
        measurements: [
          {
            id: 'meas-1',
            name: 'Set Pressure',
            numericValue: 150,
            unit: 'psi',
            citationIds: ['cit-trav'],
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('PATH_TRAVERSAL_DETECTED'))).toBe(true);
    });

    it('rejects citation sourcePath with absolute Windows path', () => {
      const input = createValidInput({
        citations: [
          {
            citationId: 'cit-abs',
            sourcePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
            sourceHash: sampleSourceHash,
            snippet: 'sample',
            verifiedAt: '2026-09-19T20:00:00Z',
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('PATH_TRAVERSAL_DETECTED'))).toBe(true);
    });

    it('rejects citation sourcePath with null byte', () => {
      const input = createValidInput({
        citations: [
          {
            citationId: 'cit-null',
            sourcePath: 'docs/test.txt\0.exe',
            sourceHash: sampleSourceHash,
            snippet: 'sample',
            verifiedAt: '2026-09-19T20:00:00Z',
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('PATH_TRAVERSAL_DETECTED'))).toBe(true);
    });

    it('evaluates pure isSafeIndustrialPath correctly', () => {
      expect(isSafeIndustrialPath('docs/file.txt')).toBe(true);
      expect(isSafeIndustrialPath('sops/valve_procedure.pdf')).toBe(true);
      expect(isSafeIndustrialPath('../escape.txt')).toBe(false);
      expect(isSafeIndustrialPath('docs/../../etc/passwd')).toBe(false);
      expect(isSafeIndustrialPath('C:\\Windows')).toBe(false);
      expect(isSafeIndustrialPath('/etc/shadow')).toBe(false);
      expect(isSafeIndustrialPath('http://remote.com')).toBe(false);
      expect(isSafeIndustrialPath('docs/file\0.txt')).toBe(false);
    });
  });

  // ── 8. Spreadsheet Security: Formula Injection ─────────────────────

  describe('8. Spreadsheet Security: Formula Injection', () => {
    it('detects formula injection patterns with isPotentialFormulaInjection', () => {
      expect(isPotentialFormulaInjection('=CMD|"/c calc"!A0')).toBe(true);
      expect(isPotentialFormulaInjection('=SUM(A1:A10)')).toBe(true);
      expect(isPotentialFormulaInjection('@SUM(A1:A10)')).toBe(true);
      expect(isPotentialFormulaInjection('\t=1+1')).toBe(true);
      expect(isPotentialFormulaInjection('\r=1+1')).toBe(true);
      expect(isPotentialFormulaInjection('+SUM(1,2)')).toBe(true);
      expect(isPotentialFormulaInjection('-cmd.exe')).toBe(true);
      expect(isPotentialFormulaInjection('=HYPERLINK("http://evil.com","click")')).toBe(true);

      // Safe numbers and plain text
      expect(isPotentialFormulaInjection(150)).toBe(false);
      expect(isPotentialFormulaInjection('150')).toBe(false);
      expect(isPotentialFormulaInjection('-15.5')).toBe(false);
      expect(isPotentialFormulaInjection('+25')).toBe(false);
      expect(isPotentialFormulaInjection('Normal equipment description')).toBe(false);
    });

    it('rejects formula injection in spreadsheet table cells', () => {
      const input = createValidInput({
        artifactType: 'xlsx',
        sections: [
          {
            id: 'sec-sheet',
            heading: 'Sheet 1',
            order: 1,
            tables: [
              {
                id: 'tbl-injected',
                title: 'Malicious Table',
                columns: [{ key: 'col1', label: 'Col 1' }],
                rows: [
                  { col1: '=CMD|\' /C calc\'!A0' }, // Formula injection!
                ],
              },
            ],
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('FORMULA_INJECTION_DETECTED'))).toBe(true);
    });

    it('rejects formula injection in finding statement', () => {
      const input = createValidInput({
        findings: [
          {
            id: 'find-inj',
            category: 'Calculation',
            statement: '=DDE("cmd";"/C calc";"__DUMMY__")',
            severity: 'critical',
            status: 'FAIL',
            citationIds: ['cit-1'],
            verified: true,
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('FORMULA_INJECTION_DETECTED'))).toBe(true);
    });
  });

  // ── 9. Document Security: Macros, Scripts, and External URLs ───────

  describe('9. Document Security: Macros, Scripts, and External URLs', () => {
    it('detects external URLs and relationships with containsExternalRelationship', () => {
      expect(containsExternalRelationship('Visit http://evil.com for docs')).toBe(true);
      expect(containsExternalRelationship('See https://malicious.org')).toBe(true);
      expect(containsExternalRelationship('file:///c:/secret.txt')).toBe(true);
      expect(containsExternalRelationship('ms-appx://package')).toBe(true);
      expect(containsExternalRelationship('javascript:alert(1)')).toBe(true);
      expect(containsExternalRelationship('Normal local documentation')).toBe(false);
    });

    it('detects macro indicators and scripts with containsMacroOrExecutable', () => {
      expect(containsMacroOrExecutable('Template file: report.docm')).toBe(true);
      expect(containsMacroOrExecutable('Spreadsheet template: data.xlsm')).toBe(true);
      expect(containsMacroOrExecutable('Contains vbaProject.bin reference')).toBe(true);
      expect(containsMacroOrExecutable('<script>alert("xss")</script>')).toBe(true);
      expect(containsMacroOrExecutable('Execute powershell.exe -Command ...')).toBe(true);
      expect(containsMacroOrExecutable('Clean engineering documentation')).toBe(false);
    });

    it('rejects external URL in document title', () => {
      const input = createValidInput({
        title: 'Report with https://external-exfil.com link',
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('EXTERNAL_RELATIONSHIP_FORBIDDEN'))).toBe(true);
    });

    it('rejects macro reference in section content', () => {
      const input = createValidInput({
        sections: [
          {
            id: 'sec-macro',
            heading: 'Macros Section',
            content: 'Please open report.docm with macros enabled to view calculations.',
            order: 1,
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MACRO_OR_EXECUTABLE_DETECTED'))).toBe(true);
    });

    it('rejects script injection in section content', () => {
      const input = createValidInput({
        sections: [
          {
            id: 'sec-xss',
            heading: 'Overview',
            content: '<script>fetch("http://evil.com")</script>',
            order: 1,
          },
        ],
      });

      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('MACRO_OR_EXECUTABLE_DETECTED'))).toBe(true);
    });
  });

  // ── 10. Bounds and Limits Enforcement ──────────────────────────────

  describe('10. Bounds and Limits Enforcement', () => {
    it('rejects title shorter than minimum length', () => {
      const input = createValidInput({ title: 'AB' }); // < 3 chars
      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('BOUNDS_EXCEEDED'))).toBe(true);
    });

    it('rejects title exceeding maximum length', () => {
      const input = createValidInput({ title: 'A'.repeat(OFFICE_INPUT_BOUNDS.MAX_TITLE_LENGTH + 1) });
      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('BOUNDS_EXCEEDED'))).toBe(true);
    });

    it('rejects sections count exceeding limit', () => {
      const sections = Array.from({ length: OFFICE_INPUT_BOUNDS.MAX_SECTIONS + 1 }, (_, i) => ({
        id: `sec-${i}`,
        heading: `Section ${i}`,
        order: i,
      }));
      const input = createValidInput({ sections });
      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('BOUNDS_EXCEEDED'))).toBe(true);
    });

    it('rejects findings count exceeding limit', () => {
      const findings = Array.from({ length: OFFICE_INPUT_BOUNDS.MAX_FINDINGS + 1 }, (_, i) => ({
        id: `find-${i}`,
        category: 'Inspection',
        statement: `Finding ${i}`,
        severity: 'info' as const,
        status: 'PASS' as const,
        citationIds: ['cit-1'],
        verified: true,
      }));
      const input = createValidInput({ findings });
      const res = officeInputService.validateInput(input);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('BOUNDS_EXCEEDED'))).toBe(true);
    });
  });

  // ── 11. Deterministic Canonical Hashing & Tamper Detection ─────────

  describe('11. Deterministic Canonical Hashing & Tampering Detection', () => {
    it('produces identical canonical SHA-256 hash regardless of object key ordering', () => {
      const input1 = createValidInput();
      // Permute key ordering in input2
      const input2: any = {
        title: input1.title,
        artifactType: input1.artifactType,
        schemaVersion: input1.schemaVersion,
        generatedAt: input1.generatedAt,
        author: {
          name: input1.author.name,
          id: input1.author.id,
          role: input1.author.role,
        },
        projectId: input1.projectId,
        runId: input1.runId,
        taskId: input1.taskId,
        sections: input1.sections,
        findings: input1.findings,
        measurements: input1.measurements,
        units: input1.units,
        calculations: input1.calculations,
        warnings: input1.warnings,
        limitations: input1.limitations,
        citations: input1.citations,
        sourceArtifactIds: input1.sourceArtifactIds,
        sourceHashes: input1.sourceHashes,
        references: input1.references,
        evidenceState: input1.evidenceState,
        modelIdentity: input1.modelIdentity,
        approval: input1.approval,
        proseBlocks: input1.proseBlocks,
        conclusions: input1.conclusions,
      };

      const hash1 = computeOfficeInputHash(input1);
      const hash2 = computeOfficeInputHash(input2);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('changes canonical hash when any value or citation is modified', () => {
      const baseInput = createValidInput();
      const baseHash = computeOfficeInputHash(baseInput);

      // 1. Modify title
      const modifiedTitle = { ...baseInput, title: baseInput.title + ' Modified' };
      expect(computeOfficeInputHash(modifiedTitle)).not.toBe(baseHash);

      // 2. Modify measurement numericValue
      const modifiedMeas = {
        ...baseInput,
        measurements: [
          {
            ...baseInput.measurements[0],
            numericValue: 155, // Changed from 150
          },
        ],
      };
      expect(computeOfficeInputHash(modifiedMeas)).not.toBe(baseHash);

      // 3. Modify citation sourceHash
      const modifiedCit = {
        ...baseInput,
        citations: [
          {
            ...baseInput.citations[0],
            sourceHash: crypto.createHash('sha256').update('tampered').digest('hex'),
          },
        ],
      };
      expect(computeOfficeInputHash(modifiedCit)).not.toBe(baseHash);
    });
  });

  // ── 12. Freshness & Stale-Input Detection ───────────────────────────

  describe('12. Dynamic Freshness and Stale-Input Verification', () => {
    it('verifies freshness when all disk sources match citation hashes', async () => {
      const input = createValidInput();
      const freshness = await officeInputService.verifyFreshness(input);

      expect(freshness.fresh).toBe(true);
      expect(freshness.errors).toEqual([]);
      expect(freshness.verifiedSourceCount).toBe(1);
    });

    it('detects stale input when source file on disk is modified', async () => {
      const input = createValidInput();

      // Tamper source file on disk
      fs.writeFileSync(path.join(projectRoot, 'docs', 'psv_manual.txt'), 'Modified source content on disk.');

      const freshness = await officeInputService.verifyFreshness(input);
      expect(freshness.fresh).toBe(false);
      expect(freshness.errors.some((e) => e.includes('STALE_SOURCE_HASH'))).toBe(true);
    });

    it('detects missing source file on disk', async () => {
      const input = createValidInput();

      // Remove source file from disk
      fs.unlinkSync(path.join(projectRoot, 'docs', 'psv_manual.txt'));

      const freshness = await officeInputService.verifyFreshness(input);
      expect(freshness.fresh).toBe(false);
      expect(freshness.errors.some((e) => e.includes('SOURCE_NOT_FOUND'))).toBe(true);
    });

    it('detects unapproved or revoked approval in approval store', async () => {
      // Create a pending approval
      approvalService.createApproval({ id: 'appr-pending', gateId: 'G6' });

      const input = createValidInput({
        approval: {
          required: true,
          status: 'approved', // Claims approved in input, but in store it is pending!
          approvalId: 'appr-pending',
        },
      });

      const freshness = await officeInputService.verifyFreshness(input);
      expect(freshness.fresh).toBe(false);
      expect(freshness.errors.some((e) => e.includes('APPROVAL_REQUIRED'))).toBe(true);
    });
  });

  // ── 13. Privacy-Safe Audit Trail Integration ───────────────────────

  describe('13. Privacy-Safe Audit Trail Integration', () => {
    it('records audit events with cryptographic input hash and zero raw prose', () => {
      const input = createValidInput();
      officeInputService.validateInput(input);

      const records = auditService.getRecords({ source: 'office-input-service' });
      expect(records.length).toBeGreaterThan(0);

      const lastRecord = records[records.length - 1];
      expect(lastRecord.data.event).toBe('OFFICE_INPUT_VALIDATED');
      expect(lastRecord.data.inputHash).toHaveLength(64);
      expect(lastRecord.data.projectId).toBe('test-project');

      // Verify privacy hygiene: no raw sensitive prose in audit record
      const serialized = JSON.stringify(lastRecord);
      expect(serialized).not.toContain('PSV-101 safety relief tolerance');
      expect(serialized).not.toContain('The equipment operates under normal');
    });
  });

  // ── 14. Protected Canary File Invariant ─────────────────────────────

  describe('14. Protected Canary File Invariant', () => {
    it('preserves rust/test.txt SHA-256 integrity unchanged', () => {
      const canaryPath = path.resolve(__dirname, '..', '..', 'rust', 'test.txt');
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(canaryPath)).digest('hex');
      expect(actualHash).toBe(CANARY_HASH);
    });
  });
});
