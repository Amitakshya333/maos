/**
 * F6-04: Implement generate_pptx Tool Test Suite
 *
 * Validates the core requirements for Phase F6-04:
 *   1. Valid PPTX generation from OfficePptxInput producing a verifiable OpenXML PresentationML package (.pptx)
 *   2. Presence of all mandatory slides:
 *      - Title and project/run/task metadata
 *      - Formal decision or verdict (prominent status badge & resolution comment)
 *      - Findings and status (metrics, thresholds, units, citations, reviewer corrections)
 *      - Measurements and units (numeric values, explicit units, tolerances, citations)
 *      - Calculations and methods (inputs, formulas, result value + unit, verification method, citations)
 *      - Warnings and limitations (warning codes, severity, acknowledgment, operational limitations)
 *      - Citations and provenance (Citation ID, source file path, SHA-256 digest, page/section, snippet)
 *      - Reviewer approval and sign-off (Approval ID, approver, timestamp, payload hash, PE sign-off identity)
 *      - Clearly separated unverified model prose ([UNVERIFIED MODEL PROSE — NOT VERIFIED AGAINST STRUCTURED DATA — REQUIRES HUMAN REVIEW])
 *      - Embedded Section Tables (dedicated presentation slides for section tables)
 *   3. Offline package verification:
 *      - Zero external application dependencies (no Microsoft PowerPoint, no LibreOffice)
 *      - Zero npm packages or runtime asset downloads (pure Node.js zlib/crypto)
 *      - Well-formed XML, strictly valid relationships
 *      - Rejection of macros (.pptm, vbaProject.bin, vbaData.xml, activeX)
 *      - Rejection of external relationships (TargetMode="External") and remote URLs
 *      - Rejection of embedded OLE active objects
 *   4. Strict preservation of numbers, units, precision, citations, and source provenance
 *   5. Freshness verification: rejection when source files on disk are modified or missing
 *   6. Unit enforcement: rejection when measurements lack units or calculations lack result units
 *   7. Evidence gates: rejection of unresolved OCR/VLM conflicts, quarantined evidence, and unreviewed low confidence
 *   8. Approval enforcement: rejection of unapproved inputs, stale approvals, or changed input after approval (tampered payloadHash)
 *   9. Cross-project boundary confinement
 *  10. Path traversal and non-.pptx output path rejection
 *  11. Safe collision handling: rejection of silent overwrite, confirmed approved overwrite
 *  12. Durable idempotency: exact cached replay and conflicting request rejection via DurableIdempotencyStore
 *  13. Tool boundary authorization: allows authorized agents, rejects unauthorized agents, proper tool filtering
 *  14. Tool dispatch: synchronous execution via executeTool and asynchronous execution via executeGeneratePptxToolAsync
 *  15. Privacy-safe audit trail: records hashes, IDs, and metadata without raw prose or secrets
 *  16. Protected canary file invariant (rust/test.txt)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  OfficePptxInput,
  PptxGenerationError,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
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
  validatePptxPackage,
  parseZipArchive,
} from '../../src/industrial/office/pptx-packager';
import {
  buildZipArchive,
} from '../../src/industrial/office/ooxml-packager';
import {
  executeGeneratePptxTool,
  executeGeneratePptxToolAsync,
  getToolsForAgent,
  executeTool,
} from '../../src/integrations/tools';
import { createServiceContainer } from '../../src/service';

describe('F6-04: generate_pptx Tool', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let eventService: EventService;
  let approvalService: ApprovalService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;
  let idempotencyStore: DurableIdempotencyStore;
  let pptxGenerator: PptxGeneratorService;

  const sampleSourceContent = 'PSV-101 safety relief valve certified set pressure 150 psi with tolerance 1.5%.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

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
          reviewerCorrection: {
            reviewerId: 'human-chief-engineer',
            timestamp: '2026-09-19T20:00:00Z',
            field: 'relief_tolerance',
            originalValue: 1.6,
            correctedValue: 1.5,
            reason: 'Calibrated transducer secondary verification',
          },
        },
      ],
      measurements: [
        {
          id: 'meas-1',
          name: 'set_pressure',
          numericValue: 150.0,
          unit: 'psi',
          tolerance: 2.5,
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
      units: ['%', 'psi'],
      calculations: [
        {
          id: 'calc-1',
          name: 'Overpressure Margin',
          inputs: [{ name: 'set_pressure', value: 150.0, unit: 'psi' }],
          methodOrFormula: 'set_pressure * 1.10',
          resultValue: 165.0,
          resultUnit: 'psi',
          verifiedBy: 'deterministic_calc',
          citationIds: ['cit-1'],
        },
      ],
      warnings: [
        {
          code: 'WARN_TEMP_AMBIENT',
          message: 'Ambient test cell temperature 32 C exceeds standard 25 C reference.',
          severity: 'medium',
          acknowledged: true,
          acknowledgedBy: 'human-lead-engineer',
        },
      ],
      limitations: [
        'Applicable only to gaseous service PSV-100 series valves.',
      ],
      citations: [
        {
          citationId: 'cit-1',
          sourcePath: 'evidence/calibration.txt',
          sourceHash: sampleSourceHash,
          documentId: 'doc-calib-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'Relief Calibration Log',
          snippet: 'PSV-101 safety relief valve certified set pressure 150 psi with tolerance 1.5%.',
          verifiedAt: '2026-09-19T19:00:00Z',
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
      generatedAt: '2026-09-19T20:30:00Z',
      approval: {
        required: true,
        status: 'approved',
        approvalId: 'app-pptx-001',
        approvedBy: 'human-chief-engineer',
        approvedAt: '2026-09-19T20:35:00Z',
        comment: 'All criteria pass formal safety inspection requirements.',
      },
      proseBlocks: [
        {
          id: 'pb-1',
          label: 'AI Diagnostic Analysis',
          text: 'The valve demonstrates optimal spring seating with zero observed flutter during transient sweep.',
          isModelGenerated: true,
          verifiedAgainstData: false,
          approvedByReviewer: false,
          modelId: 'qwen2.5-vl-7b-instruct',
        },
      ],
      conclusions: [
        {
          id: 'conc-1',
          statement: 'PSV-101 certified for operational service under ASME Section VIII.',
          verdict: 'approved',
          signOffIdentity: 'Chief Engineer John Doe, PE',
          signedAt: '2026-09-19T20:40:00Z',
        },
      ],
    };

    const merged = { ...base, ...overrides };
    // Pre-calculate matching payloadHash if not explicitly overridden
    if (!overrides.approval || overrides.approval.payloadHash === undefined) {
      const hash = computeOfficeInputHash(merged);
      (merged as any).approval = {
        ...merged.approval,
        payloadHash: hash,
      };
    }
    return merged;
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-04-'));
    fs.mkdirSync(path.join(projectRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });

    // Write physical cited file
    fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), sampleSourceContent, 'utf-8');

    eventService = new EventService(projectRoot);
    approvalService = new ApprovalService(projectRoot);
    artifactService = new ArtifactService(projectRoot, eventService, approvalService);
    auditService = new AuditService(projectRoot);
    officeInputService = new OfficeInputService(projectRoot, artifactService, approvalService, auditService);
    idempotencyStore = new DurableIdempotencyStore(projectRoot);

    // Create the approved record matching test app-pptx-001
    const appFile = path.join(projectRoot, '.maos', 'approvals', 'app-pptx-001.json');
    fs.writeFileSync(
      appFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'app-pptx-001',
        taskId: 'task-inspect-pptx-01',
        status: 'approved',
        requestedBy: 'agent-inspector-01',
        approverRole: 'chief_engineer',
        description: 'PSV-101 inspection PPTX presentation approval note',
        createdAt: '2026-09-19T20:30:00Z',
        decidedAt: '2026-09-19T20:35:00Z',
        decidedBy: 'human-chief-engineer',
        reason: 'All criteria pass formal safety inspection requirements.',
      }),
      'utf-8',
    );

    pptxGenerator = new PptxGeneratorService(
      projectRoot,
      artifactService,
      approvalService,
      auditService,
      officeInputService,
      idempotencyStore,
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ── 1. Valid PPTX Generation & PresentationML Structure ────────────

  it('generates a valid, complete PPTX presentation package with all mandatory slides and offline validation', () => {
    const input = createValidPptxInput();
    const result = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/psv_verification.pptx',
      requestId: 'req-pptx-001',
      callerIdentity: { agentId: 'report_agent' },
    });

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBeDefined();
    expect(result.relativePath).toBe('artifacts/psv_verification.pptx');
    expect(result.artifactHash).toHaveLength(64);
    expect(result.canonicalHash).toHaveLength(64);
    expect(result.bytesWritten).toBeGreaterThan(1000);
    expect(result.slideCount).toBeGreaterThanOrEqual(9);

    // Verify physical file on disk
    const filePath = path.join(projectRoot, 'artifacts', 'psv_verification.pptx');
    expect(fs.existsSync(filePath)).toBe(true);
    const buffer = fs.readFileSync(filePath);

    // Offline OOXML package validation
    const pkgValidation = validatePptxPackage(buffer);
    expect(pkgValidation.valid).toBe(true);
    expect(pkgValidation.errors).toEqual([]);
    expect(pkgValidation.slideCount).toBeGreaterThanOrEqual(9);

    // Verify slide titles returned
    expect(result.slideTitles).toContain('Executive Decision & Formal Verdict');
    expect(result.slideTitles).toContain('Safety Findings & Compliance Status');
    expect(result.slideTitles).toContain('Critical Engineering Measurements & Units');
    expect(result.slideTitles).toContain('Verified Calculations & Computational Methods');
    expect(result.slideTitles).toContain('Warnings & Operational Limitations');
    expect(result.slideTitles).toContain('Evidence Citations & Source Provenance');
    expect(result.slideTitles).toContain('Reviewer Approval & Professional Sign-off');
    expect(result.slideTitles).toContain('Model Prose (Unverified — Segregated)');
  });

  it('preserves exact findings, measurements with units, calculations, citations, author, and approval metadata', () => {
    const input = createValidPptxInput();
    const result = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/detailed_deck.pptx',
      requestId: 'req-pptx-002',
      callerIdentity: { agentId: 'doc_agent' },
    });

    const buffer = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(buffer);

    // Verify mandatory PresentationML parts
    expect(entries.has('[Content_Types].xml')).toBe(true);
    const contentTypesXml = entries.get('[Content_Types].xml')!.toString('utf8');
    expect(contentTypesXml).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml');
    expect(contentTypesXml).toContain('application/vnd.openxmlformats-officedocument.presentationml.slide+xml');

    expect(entries.has('ppt/presentation.xml')).toBe(true);
    expect(entries.has('ppt/slideMasters/slideMaster1.xml')).toBe(true);
    expect(entries.has('ppt/slideLayouts/slideLayout1.xml')).toBe(true);
    expect(entries.has('ppt/slideLayouts/slideLayout2.xml')).toBe(true);
    expect(entries.has('ppt/theme/theme1.xml')).toBe(true);

    // Verify text content across slides
    let foundFinding = false;
    let foundMeasurementUnit = false;
    let foundCalculationFormula = false;
    let foundCitationSnippet = false;
    let foundSignOff = false;
    let foundModelProseWarning = false;

    for (const [name, buf] of entries.entries()) {
      if (name.startsWith('ppt/slides/slide') && name.endsWith('.xml')) {
        const slideXml = buf.toString('utf8');
        if (slideXml.includes('PSV-101 safety relief tolerance observed within approved bounds')) {
          foundFinding = true;
        }
        if (slideXml.includes('set_pressure') && slideXml.includes('150') && slideXml.includes('psi')) {
          foundMeasurementUnit = true;
        }
        if (slideXml.includes('set_pressure * 1.10') && slideXml.includes('165')) {
          foundCalculationFormula = true;
        }
        if (slideXml.includes('PSV-101 safety relief valve certified set pressure 150 psi with tolerance 1.5%.')) {
          foundCitationSnippet = true;
        }
        if (slideXml.includes('Chief Engineer John Doe, PE')) {
          foundSignOff = true;
        }
        if (slideXml.includes('[UNVERIFIED MODEL PROSE — NOT VERIFIED AGAINST STRUCTURED DATA — REQUIRES HUMAN REVIEW]')) {
          foundModelProseWarning = true;
        }
      }
    }

    expect(foundFinding).toBe(true);
    expect(foundMeasurementUnit).toBe(true);
    expect(foundCalculationFormula).toBe(true);
    expect(foundCitationSnippet).toBe(true);
    expect(foundSignOff).toBe(true);
    expect(foundModelProseWarning).toBe(true);
  });

  it('generates dedicated presentation slides for embedded section tables', () => {
    const input = createValidPptxInput({
      sections: [
        {
          id: 'sec-table-1',
          heading: 'Section With Data Tables',
          content: 'Details of recent calibration records and test bench parameters.',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
          tables: [
            {
              id: 'tbl-calib',
              title: 'PSV Calibration Matrix',
              columns: [
                { key: 'param', label: 'Parameter' },
                { key: 'target', label: 'Target', unit: 'psi', numeric: true },
                { key: 'observed', label: 'Observed', unit: 'psi', numeric: true },
                { key: 'status', label: 'Status' },
              ],
              rows: [
                { param: 'Set Point', target: 150, observed: 150.2, status: 'PASS' },
                { param: 'Reseat Point', target: 140, observed: 140.5, status: 'PASS' },
              ],
              citationIds: ['cit-1'],
            },
          ],
        },
      ],
    });

    const result = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/with_tables.pptx',
      requestId: 'req-table-01',
    });

    expect(result.ok).toBe(true);
    expect(result.slideTitles).toContain('Section With Data Tables: PSV Calibration Matrix');

    const buffer = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(buffer);

    let foundTableElements = false;
    let foundTableData = false;

    for (const [name, buf] of entries.entries()) {
      if (name.startsWith('ppt/slides/slide') && name.endsWith('.xml')) {
        const slideXml = buf.toString('utf8');
        if (slideXml.includes('Section With Data Tables: PSV Calibration Matrix')) {
          if (slideXml.includes('<a:tbl') && slideXml.includes('<a:tr')) {
            foundTableElements = true;
          }
          if (slideXml.includes('Parameter') && slideXml.includes('Set Point') && slideXml.includes('150.2')) {
            foundTableData = true;
          }
        }
      }
    }

    expect(foundTableElements).toBe(true);
    expect(foundTableData).toBe(true);
  });

  // ── 2. Security Rejection: Macros, URLs, OLE, and Malicious Parts ───

  it('rejects input containing macro or executable indicators', () => {
    const input = createValidPptxInput({
      title: 'Inspection Deck with auto_open macro',
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/macro_deck.pptx',
        requestId: 'req-macro-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/macro_deck.pptx',
        requestId: 'req-macro-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('MACRO_OR_EXECUTABLE_DETECTED');
    }
  });

  it('rejects input containing external URLs or protocols', () => {
    const input = createValidPptxInput({
      findings: [
        {
          id: 'find-url',
          category: 'Exfiltration',
          statement: 'See external report at https://malicious.corp/leak',
          severity: 'critical',
          status: 'FAIL',
          citationIds: ['cit-1'],
          verified: false,
        },
      ],
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/external_url.pptx',
        requestId: 'req-url-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/external_url.pptx',
        requestId: 'req-url-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('EXTERNAL_RELATIONSHIP_FORBIDDEN');
    }
  });

  it('offline package validator rejects packages containing malicious macro parts or external relationships', () => {
    // Generate valid package first
    const input = createValidPptxInput();
    const result = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/source_for_tampering.pptx',
      requestId: 'req-tamper-01',
    });

    const validBuf = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(validBuf);

    // Case A: Inject forbidden vbaProject.bin part
    const tamperedEntriesWithMacro = new Map(entries);
    tamperedEntriesWithMacro.set('ppt/vbaProject.bin', Buffer.from('RAW_VBA_CODE'));
    const zipFilesA = Array.from(tamperedEntriesWithMacro.entries()).map(([p, c]) => ({
      path: p,
      data: c,
    }));
    const macroZipBuf = buildZipArchive(zipFilesA);
    const macroValidation = validatePptxPackage(macroZipBuf);
    expect(macroValidation.valid).toBe(false);
    expect(macroValidation.errors.some((e) => e.includes('forbidden part name'))).toBe(true);

    // Case B: Inject external relationship TargetMode="External"
    const tamperedEntriesWithExtRel = new Map(entries);
    const badRelXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="http://evil.com/slide1.xml" TargetMode="External"/>
</Relationships>`;
    tamperedEntriesWithExtRel.set('ppt/_rels/presentation.xml.rels', Buffer.from(badRelXml, 'utf-8'));
    const zipFilesB = Array.from(tamperedEntriesWithExtRel.entries()).map(([p, c]) => ({
      path: p,
      data: c,
    }));
    const extRelZipBuf = buildZipArchive(zipFilesB);
    const extRelValidation = validatePptxPackage(extRelZipBuf);
    expect(extRelValidation.valid).toBe(false);
    expect(extRelValidation.errors.some((e) => e.includes('TargetMode="External"'))).toBe(true);

    // Case C: Inject embedded OLE object in slide XML
    const tamperedEntriesWithOle = new Map(entries);
    const slide1Xml = tamperedEntriesWithOle.get('ppt/slides/slide1.xml')!.toString('utf8');
    const oleInjectedXml = slide1Xml.replace('</p:spTree>', '<p:oleObj spid="1025" name="Object 1" progId="Excel.Sheet.12"/></p:spTree>');
    tamperedEntriesWithOle.set('ppt/slides/slide1.xml', Buffer.from(oleInjectedXml, 'utf-8'));
    const zipFilesC = Array.from(tamperedEntriesWithOle.entries()).map(([p, c]) => ({
      path: p,
      data: c,
    }));
    const oleZipBuf = buildZipArchive(zipFilesC);
    const oleValidation = validatePptxPackage(oleZipBuf);
    expect(oleValidation.valid).toBe(false);
    expect(oleValidation.errors.some((e) => e.includes('embedded OLE active object'))).toBe(true);
  });

  // ── 3. Dynamic Freshness Verification ──────────────────────────────

  it('rejects presentation generation when cited physical source file on disk is modified', () => {
    // Modify cited evidence file on disk
    fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), 'TAMPERED EVIDENCE CONTENT ON DISK', 'utf-8');

    const input = createValidPptxInput();

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/tampered_source.pptx',
        requestId: 'req-stale-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/tampered_source.pptx',
        requestId: 'req-stale-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('STALE_SOURCE_HASH');
    }
  });

  it('rejects presentation generation when cited physical source file is missing', () => {
    // Delete cited evidence file
    fs.unlinkSync(path.join(projectRoot, 'evidence', 'calibration.txt'));

    const input = createValidPptxInput();

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/missing_source.pptx',
        requestId: 'req-missing-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/missing_source.pptx',
        requestId: 'req-missing-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('SOURCE_FILE_MISSING');
    }
  });

  // ── 4. Unit Enforcement ────────────────────────────────────────────

  it('rejects measurements missing mandatory units', () => {
    const input = createValidPptxInput({
      measurements: [
        {
          id: 'meas-no-unit',
          name: 'orifice_diameter',
          numericValue: 0.5,
          unit: '', // Missing unit
          status: 'nominal',
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/no_unit.pptx',
        requestId: 'req-unit-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/no_unit.pptx',
        requestId: 'req-unit-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('MISSING_UNIT');
    }
  });

  it('rejects calculations missing mandatory result units', () => {
    const input = createValidPptxInput({
      calculations: [
        {
          id: 'calc-no-unit',
          name: 'Discharge Area',
          inputs: [],
          methodOrFormula: 'pi * r^2',
          resultValue: 0.196,
          resultUnit: '', // Missing resultUnit
          verifiedBy: 'deterministic_calc',
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/no_calc_unit.pptx',
        requestId: 'req-unit-02',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/no_calc_unit.pptx',
        requestId: 'req-unit-02',
      });
    } catch (err: any) {
      expect(err.code).toBe('MISSING_UNIT');
    }
  });

  // ── 5. Evidence Gates: Conflicts & Quarantined Evidence ────────────

  it('rejects generation when unresolved conflicts exist in evidence state', () => {
    const input = createValidPptxInput({
      evidenceState: {
        ocrConfidence: 0.95,
        vlmConfidence: 0.90,
        hasUnresolvedConflicts: true,
        isQuarantined: false,
        reviewedByHuman: false,
      },
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/unresolved_conflicts.pptx',
        requestId: 'req-conf-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/unresolved_conflicts.pptx',
        requestId: 'req-conf-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('UNRESOLVED_CONFLICT');
    }
  });

  it('rejects generation when evidence is quarantined', () => {
    const input = createValidPptxInput({
      evidenceState: {
        ocrConfidence: 0.95,
        vlmConfidence: 0.90,
        hasUnresolvedConflicts: false,
        isQuarantined: true,
        reviewedByHuman: false,
      },
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/quarantined.pptx',
        requestId: 'req-quar-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/quarantined.pptx',
        requestId: 'req-quar-01',
      });
    } catch (err: any) {
      expect(err.code === 'QUARANTINED_EVIDENCE' || err.code === 'UNRESOLVED_CONFLICT').toBe(true);
    }
  });

  it('rejects generation when OCR confidence is low and unreviewed by human', () => {
    const input = createValidPptxInput({
      evidenceState: {
        ocrConfidence: 0.40, // Below threshold 0.70
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: false,
      },
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/low_conf.pptx',
        requestId: 'req-lowconf-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/low_conf.pptx',
        requestId: 'req-lowconf-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('LOW_CONFIDENCE_UNREVIEWED');
    }
  });

  it('accepts low confidence evidence when human review override is provided', () => {
    const input = createValidPptxInput({
      evidenceState: {
        ocrConfidence: 0.40, // Below threshold 0.70
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true,
        reviewerId: 'human-chief-engineer',
        reviewerNotes: 'Verified calibration log manually with master meter.',
      },
    });

    const result = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/human_overridden_conf.pptx',
      requestId: 'req-override-01',
    });

    expect(result.ok).toBe(true);
    expect(result.slideCount).toBeGreaterThanOrEqual(9);
  });

  // ── 6. Mandatory Approval Verification & Anti-Tampering ────────────

  it('rejects generation when approval status is pending or rejected', () => {
    const input = createValidPptxInput({
      approval: {
        required: true,
        status: 'pending' as any,
        approvalId: 'app-pending-01',
      },
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/pending_app.pptx',
        requestId: 'req-pend-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/pending_app.pptx',
        requestId: 'req-pend-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('APPROVAL_REQUIRED');
    }
  });

  it('rejects generation when input was changed after approval (tampered payloadHash)', () => {
    const input = createValidPptxInput();
    // Tamper with payloadHash so it no longer matches the content
    (input as any).approval = {
      ...input.approval,
      payloadHash: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/tampered_payload.pptx',
        requestId: 'req-tamp-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/tampered_payload.pptx',
        requestId: 'req-tamp-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('CHANGED_INPUT_AFTER_APPROVAL');
    }
  });

  it('rejects generation when approval is revoked or rejected in ApprovalService', () => {
    // Overwrite the approval in ApprovalService with status 'rejected'
    const appFile = path.join(projectRoot, '.maos', 'approvals', 'app-pptx-001.json');
    fs.writeFileSync(
      appFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'app-pptx-001',
        taskId: 'task-inspect-pptx-01',
        status: 'rejected',
        requestedBy: 'agent-inspector-01',
        decidedBy: 'safety_director',
        decidedAt: '2026-09-19T21:00:00Z',
        reason: 'Revoked due to recalibration finding.',
      }),
      'utf-8',
    );

    const input = createValidPptxInput();

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/revoked_app.pptx',
        requestId: 'req-revoked-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/revoked_app.pptx',
        requestId: 'req-revoked-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('STALE_APPROVAL');
    }
  });

  // ── 7. Cross-Project Confinement & Safe Path Verification ──────────

  it('rejects cross-project access when input projectId does not match request', () => {
    const input = createValidPptxInput({
      projectId: 'other-project',
    });

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project', // Mismatch
        input,
        outputPath: 'artifacts/cross_project.pptx',
        requestId: 'req-proj-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/cross_project.pptx',
        requestId: 'req-proj-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects output paths with path traversal (..)', () => {
    const input = createValidPptxInput();

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: '../escape.pptx',
        requestId: 'req-trav-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: '../escape.pptx',
        requestId: 'req-trav-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('PATH_TRAVERSAL_DETECTED');
    }
  });

  it('rejects output paths without .pptx extension', () => {
    const input = createValidPptxInput();

    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/presentation.pptm', // Macro extension
        requestId: 'req-ext-01',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/presentation.pptm',
        requestId: 'req-ext-01',
      });
    } catch (err: any) {
      expect(err.code).toBe('INVALID_INPUT');
    }
  });

  // ── 8. Collision Handling & Confirmed Overwrite ────────────────────

  it('rejects silent overwrite when file already exists and allowOverwrite is false', () => {
    const input = createValidPptxInput();

    // First generation
    pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/collision_test.pptx',
      requestId: 'req-coll-first',
    });

    // Second generation to same path without allowOverwrite
    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/collision_test.pptx',
        requestId: 'req-coll-second',
        allowOverwrite: false,
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/collision_test.pptx',
        requestId: 'req-coll-second',
        allowOverwrite: false,
      });
    } catch (err: any) {
      expect(err.code).toBe('ARTIFACT_COLLISION');
    }
  });

  it('allows overwrite when allowOverwrite is true and approved approvalId is provided', () => {
    const input = createValidPptxInput();

    // First generation
    const res1 = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/overwrite_test.pptx',
      requestId: 'req-ow-1',
    });
    expect(res1.ok).toBe(true);

    // Second generation with allowOverwrite: true
    const res2 = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/overwrite_test.pptx',
      requestId: 'req-ow-2',
      allowOverwrite: true,
      approvalId: 'app-pptx-001',
    });

    expect(res2.ok).toBe(true);
    expect(res2.relativePath).toBe('artifacts/overwrite_test.pptx');
  });

  // ── 9. Durable Idempotency ────────────────────────────────────────

  it('replays identical cached result on exact idempotent duplicate request', () => {
    const input = createValidPptxInput();

    const res1 = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/idempotent_deck.pptx',
      requestId: 'req-idem-fixed-01',
      callerIdentity: { agentId: 'report_agent' },
    });
    expect(res1.ok).toBe(true);
    expect(res1.cached).toBe(false);

    // Exact duplicate request with same requestId
    const res2 = pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/idempotent_deck.pptx',
      requestId: 'req-idem-fixed-01',
      callerIdentity: { agentId: 'report_agent' },
    });

    expect(res2.ok).toBe(true);
    expect(res2.cached).toBe(true);
    expect(res2.artifactId).toBe(res1.artifactId);
    expect(res2.artifactHash).toBe(res1.artifactHash);
  });

  it('rejects conflicting request parameters with same requestId', () => {
    const input = createValidPptxInput();

    pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/deck_param_a.pptx',
      requestId: 'req-conflict-fixed',
    });

    // Conflicting request with different outputPath using same requestId
    expect(() => {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/deck_param_b.pptx',
        requestId: 'req-conflict-fixed',
      });
    }).toThrow(PptxGenerationError);

    try {
      pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/deck_param_b.pptx',
        requestId: 'req-conflict-fixed',
      });
    } catch (err: any) {
      expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  // ── 10. Agent Authorization & Tool Boundary ───────────────────────

  it('authorizes approved agents (report_agent, doc_agent, supervisor_agent, lead-inspector, auditor, test-agent, verification, admin)', () => {
    const approvedAgents = [
      'report_agent',
      'doc_agent',
      'supervisor_agent',
      'lead-inspector',
      'auditor',
      'test-agent',
      'verification',
      'admin',
    ];

    for (const [idx, agentId] of approvedAgents.entries()) {
      const input = createValidPptxInput();
      const res = pptxGenerator.generatePptx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: `artifacts/agent_deck_${idx}.pptx`,
        requestId: `req-agent-auth-${idx}`,
        callerIdentity: { agentId },
      });
      expect(res.ok).toBe(true);
    }
  });

  it('rejects unauthorized agent with UNAUTHORIZED_TOOL_CALL at tool boundary', () => {
    const input = createValidPptxInput();

    expect(() => {
      executeGeneratePptxTool(
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/unauthorized.pptx',
          requestId: 'req-unauth-pptx',
        },
        {
          projectRoot,
          agentId: 'unauthorized_random_agent',
        },
        {
          pptxGenerator,
          audit: auditService,
          idempotency: idempotencyStore,
        },
      );
    }).toThrow(/UNAUTHORIZED_TOOL_CALL/);
  });

  it('filters generate_pptx in getToolsForAgent based on authorization', () => {
    const reportTools = getToolsForAgent(undefined, 'report_agent');
    expect(reportTools.some((t) => t.function.name === 'generate_pptx')).toBe(true);

    const randomTools = getToolsForAgent(undefined, 'random_unauthorized_agent');
    expect(randomTools.some((t) => t.function.name === 'generate_pptx')).toBe(false);
  });

  // ── 11. Tool Execution Dispatch ───────────────────────────────────

  it('dispatches generate_pptx via synchronous executeTool', () => {
    const input = createValidPptxInput();

    const toolExecResult = executeTool(
      'generate_pptx',
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/execute_tool_test.pptx',
        requestId: 'req-exec-tool-pptx-01',
      },
      projectRoot,
      ['artifacts/'],
      'report_agent',
      'task-inspect-pptx-01',
      ['generate_pptx'],
      {
        pptxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    const parsed = JSON.parse(toolExecResult.result);
    expect(parsed.ok).toBe(true);
    expect(parsed.relativePath).toBe('artifacts/execute_tool_test.pptx');
    expect(parsed.slideCount).toBeGreaterThanOrEqual(9);
  });

  it('supports asynchronous execution via executeGeneratePptxToolAsync', async () => {
    const input = createValidPptxInput();

    const res = await executeGeneratePptxToolAsync(
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/async_test.pptx',
        requestId: 'req-async-pptx-01',
      },
      {
        projectRoot,
        agentId: 'report_agent',
      },
      {
        pptxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.artifactId).toBeDefined();
    expect(res.relativePath).toBe('artifacts/async_test.pptx');
    expect(res.slideCount).toBeGreaterThanOrEqual(9);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'async_test.pptx'))).toBe(true);
  });

  // ── 12. Privacy-Safe Audit Trail ──────────────────────────────────

  it('records privacy-safe audit events containing hashes and IDs without raw prose or secrets', () => {
    const input = createValidPptxInput();

    pptxGenerator.generatePptx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/audit_check.pptx',
      requestId: 'req-audit-01',
      callerIdentity: { agentId: 'report_agent' },
    });

    const auditChainPath = path.join(projectRoot, '.maos', 'audit', 'audit-chain.jsonl');
    expect(fs.existsSync(auditChainPath)).toBe(true);

    const auditLines = fs
      .readFileSync(auditChainPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    let foundStart = false;
    let foundGenerated = false;

    for (const entry of auditLines) {
      if (entry.data?.event === 'PPTX_GENERATION_STARTED') {
        foundStart = true;
        expect(entry.data.inputHash).toHaveLength(64);
        expect(entry.data.findingsCount).toBe(1);
        expect(entry.data.measurementsCount).toBe(1);
        // Confirm no raw prose text leaked
        expect(JSON.stringify(entry)).not.toContain('The valve demonstrates optimal spring seating');
      }
      if (entry.data?.event === 'PPTX_GENERATED') {
        foundGenerated = true;
        expect(entry.data.canonicalHash).toHaveLength(64);
        expect(entry.data.artifactHash).toHaveLength(64);
        expect(entry.data.slideCount).toBeGreaterThanOrEqual(9);
        // Confirm no raw prose text leaked
        expect(JSON.stringify(entry)).not.toContain('The valve demonstrates optimal spring seating');
      }
    }

    expect(foundStart).toBe(true);
    expect(foundGenerated).toBe(true);
  });

  // ── 13. Canary File Invariant ─────────────────────────────────────

  it('guarantees rust/test.txt canary file hash remains strictly intact', () => {
    const canaryPath = path.resolve(process.cwd(), 'rust', 'test.txt');
    expect(fs.existsSync(canaryPath)).toBe(true);
    const content = fs.readFileSync(canaryPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    expect(hash).toBe(CANARY_HASH);
  });
});
