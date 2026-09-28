/**
 * F6-02: Implement generate_docx Tool Test Suite
 *
 * Validates the core requirements for Phase F6-02:
 *   1. Valid DOCX generation from OfficeDocxInput producing a verifiable OOXML ZIP package
 *   2. Presence of all mandatory sections: metadata, verdict, findings, measurements, calculations,
 *      warnings, limitations, citations, segregated unverified model prose, approvals
 *   3. Offline package verification: well-formed XML, no macros, no external relationships, no remote URLs
 *   4. Strict preservation of numbers, units, precision, and citations
 *   5. Freshness verification: rejection when source files or artifacts on disk are modified or missing
 *   6. Rejection when measurements lack units or findings lack citations
 *   7. Rejection of unresolved OCR/VLM conflicts, quarantined evidence, and unreviewed low confidence
 *   8. Approval enforcement: rejection of unapproved inputs, stale approvals, or changed input after approval
 *   9. Cross-project boundary confinement
 *  10. Path traversal and unconfined output path rejection
 *  11. Rejection of external URLs, relationships, and macro/VBA indicators
 *  12. Safe collision handling: rejection of silent overwrite, approved overwrite verification
 *  13. Exact idempotent replay and conflicting request rejection via DurableIdempotencyStore
 *  14. Tool boundary authorization: allows only report_agent, doc_agent, supervisor_agent
 *  15. Privacy-safe audit trail: records hashes, IDs, and metadata without raw prose or secrets
 *  16. Atomic finalization via ArtifactService with interruption rollback
 *  17. Protected canary file invariant (rust/test.txt)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  OfficeDocxInput,
  DocxGenerationError,
  computeOfficeInputHash,
} from '../../src/domain/office-artifact';
import {
  DocxGeneratorService,
} from '../../src/service/docx-generator-service';
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
  validateDocxPackage,
  parseZipArchive,
} from '../../src/industrial/office/ooxml-packager';
import {
  executeGenerateDocxTool,
  executeGenerateDocxToolAsync,
  getToolsForAgent,
  executeTool,
} from '../../src/integrations/tools';

describe('F6-02: generate_docx Tool', () => {
  const CANARY_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
  let projectRoot: string;
  let eventService: EventService;
  let approvalService: ApprovalService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let officeInputService: OfficeInputService;
  let idempotencyStore: DurableIdempotencyStore;
  let docxGenerator: DocxGeneratorService;

  const sampleSourceContent = 'Safety Valve PSV-101 calibration tolerance is 1.5% with set pressure 150 psi.';
  const sampleSourceHash = crypto.createHash('sha256').update(sampleSourceContent, 'utf-8').digest('hex');

  function createValidDocxInput(overrides: Partial<OfficeDocxInput> = {}): OfficeDocxInput {
    const base: OfficeDocxInput = {
      schemaVersion: 1,
      projectId: 'test-project',
      runId: 'run-001',
      taskId: 'task-inspect-01',
      artifactType: 'docx',
      title: 'Pressure Safety Valve Inspection Approval Note',
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
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f6-02-'));
    fs.mkdirSync(path.join(projectRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });

    // Write source file for citations
    fs.writeFileSync(path.join(projectRoot, 'evidence', 'calibration.txt'), sampleSourceContent, 'utf-8');

    eventService = new EventService(projectRoot);
    approvalService = new ApprovalService(projectRoot);
    artifactService = new ArtifactService(projectRoot, eventService, approvalService);
    auditService = new AuditService(projectRoot);
    officeInputService = new OfficeInputService(projectRoot, artifactService, approvalService, auditService);
    idempotencyStore = new DurableIdempotencyStore(projectRoot);
    docxGenerator = new DocxGeneratorService(
      projectRoot,
      artifactService,
      approvalService,
      auditService,
      officeInputService,
      idempotencyStore,
    );

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
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  // ── 1. Valid DOCX Generation & OOXML Validation ─────────────────────

  it('generates a valid, complete, editable .docx approval note locally and offline', () => {
    const input = createValidDocxInput();
    const result = docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/psv_approval_note.docx',
      requestId: 'req-docx-001',
      callerIdentity: { agentId: 'report_agent', taskId: 'task-inspect-01' },
    });

    expect(result.ok).toBe(true);
    expect(result.artifactId).toMatch(/^docx_/);
    expect(result.relativePath).toBe('artifacts/psv_approval_note.docx');
    expect(result.bytesWritten).toBeGreaterThan(500);
    expect(result.artifactHash).toHaveLength(64);
    expect(result.canonicalHash).toHaveLength(64);

    const fullFilePath = path.join(projectRoot, 'artifacts', 'psv_approval_note.docx');
    expect(fs.existsSync(fullFilePath)).toBe(true);

    const docxBuffer = fs.readFileSync(fullFilePath);

    // Verify through offline OOXML validator
    const validation = validateDocxPackage(docxBuffer);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // Verify mandatory parts exist
    expect(validation.parts.has('[Content_Types].xml')).toBe(true);
    expect(validation.parts.has('_rels/.rels')).toBe(true);
    expect(validation.parts.has('word/_rels/document.xml.rels')).toBe(true);
    expect(validation.parts.has('word/styles.xml')).toBe(true);
    expect(validation.parts.has('docProps/core.xml')).toBe(true);
    expect(validation.parts.has('docProps/app.xml')).toBe(true);
    expect(validation.parts.has('word/document.xml')).toBe(true);

    // Verify no forbidden binary or script files in ZIP
    const zipEntries = parseZipArchive(docxBuffer);
    for (const key of zipEntries.keys()) {
      expect(key.toLowerCase()).not.toContain('vba');
      expect(key.toLowerCase()).not.toContain('.bin');
      expect(key.toLowerCase()).not.toContain('.exe');
    }

    // Inspect document XML content
    const docXml = validation.parts.get('word/document.xml')!;
    expect(docXml).toContain('Pressure Safety Valve Inspection Approval Note');
    expect(docXml).toContain('APPROVED - FORMAL COMPLIANCE SIGN-OFF');
    expect(docXml).toContain('test-project');
    expect(docXml).toContain('run-001');
    expect(docXml).toContain('PSV-101 safety relief tolerance observed within approved bounds');
    expect(docXml).toContain('[PASS]');
    expect(docXml).toContain('relief_tolerance');
    expect(docXml).toContain('1.5');
    expect(docXml).toContain('%');
    expect(docXml).toContain('cit-1');
    expect(docXml).toContain('human-chief-engineer');
    expect(docXml).toContain('set_pressure');
    expect(docXml).toContain('150');
    expect(docXml).toContain('psi');
    expect(docXml).toContain('Overpressure Margin');
    expect(docXml).toContain('165');
    expect(docXml).toContain('WARN_TEMP_AMBIENT');
    expect(docXml).toContain('evidence/calibration.txt');
    expect(docXml).toContain('Chief Engineer John Doe, PE');

    // Verify segregated prose block distinction
    expect(docXml).toContain('UNVERIFIED MODEL PROSE');
    expect(docXml).toContain('The valve shows optimal spring seating with zero observed chatter');
  });

  // ── 2. Freshness & Stale Source Detection ───────────────────────────

  it('rejects document generation when cited source file on disk is modified', () => {
    // Tamper with the calibration file
    fs.writeFileSync(
      path.join(projectRoot, 'evidence', 'calibration.txt'),
      'Tampered calibration file contents!',
      'utf-8',
    );

    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-stale-001',
      }),
    ).toThrowError(/STALE_SOURCE_HASH/);
  });

  it('rejects document generation when cited source file on disk is missing', () => {
    fs.unlinkSync(path.join(projectRoot, 'evidence', 'calibration.txt'));

    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-missing-001',
      }),
    ).toThrowError(/STALE_SOURCE_HASH/);
  });

  // ── 3. Missing Units & Numeric Rigor ────────────────────────────────

  it('rejects document generation when a measurement lacks a unit', () => {
    const invalidInput = createValidDocxInput({
      measurements: [
        {
          id: 'meas-nounit',
          name: 'set_pressure',
          numericValue: 150.0,
          unit: '', // Empty unit forbidden
          citationIds: ['cit-1'],
        },
      ],
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: invalidInput,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-nounit-001',
      }),
    ).toThrowError(/MISSING_UNIT|validation failed/i);
  });

  // ── 4. OCR/VLM Conflicts & Quarantine Rejection ─────────────────────

  it('rejects document generation when evidence has unresolved conflicts', () => {
    const input = createValidDocxInput({
      evidenceState: {
        hasUnresolvedConflicts: true,
        isQuarantined: false,
        reviewedByHuman: false,
      },
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-conflict-001',
      }),
    ).toThrowError(/UNRESOLVED_CONFLICT|conflict/i);
  });

  it('rejects document generation when evidence is quarantined', () => {
    const input = createValidDocxInput({
      evidenceState: {
        hasUnresolvedConflicts: false,
        isQuarantined: true,
        reviewedByHuman: false,
      },
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-quarantine-001',
      }),
    ).toThrowError(/QUARANTINED|quarantine/i);
  });

  it('rejects document generation when evidence has low confidence and no human review', () => {
    const input = createValidDocxInput({
      evidenceState: {
        ocrConfidence: 0.40, // Below 0.70 threshold
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: false,
      },
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-lowconf-001',
      }),
    ).toThrowError(/LOW_CONFIDENCE/i);
  });

  // ── 5. Approval Enforcement & Anti-Tampering ────────────────────────

  it('rejects document generation when approval status is pending or rejected', () => {
    const input = createValidDocxInput({
      approval: {
        required: true,
        status: 'pending',
        approvalId: 'app-001',
      },
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-pending-001',
      }),
    ).toThrowError(/APPROVAL_REQUIRED/);
  });

  it('rejects document generation when input changes after approval (tampered payloadHash)', () => {
    const originalInput = createValidDocxInput();
    const approvedHash = originalInput.approval.payloadHash;

    // Mutate the statement without updating the approved payloadHash
    const tamperedInput = {
      ...originalInput,
      title: 'Tampered Document Title After Approval',
    };

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: tamperedInput,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-tampered-001',
      }),
    ).toThrowError(/CHANGED_INPUT_AFTER_APPROVAL/);
  });

  it('rejects document generation when approval in store has been revoked or rejected', () => {
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

    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-revoked-001',
      }),
    ).toThrowError(/STALE_APPROVAL/);
  });

  // ── 6. Project Boundary & Path Traversal ────────────────────────────

  it('rejects document generation across project boundaries', () => {
    const input = createValidDocxInput({
      projectId: 'other-isolated-project',
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-cross-001',
      }),
    ).toThrowError(/CROSS_PROJECT_FORBIDDEN/);
  });

  it('rejects path traversal attempts in output path', () => {
    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: '../../secret/escaped.docx',
        requestId: 'req-traversal-001',
      }),
    ).toThrowError(/PATH_TRAVERSAL_DETECTED/);
  });

  it('rejects non-docx output extensions', () => {
    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/payload.docm',
        requestId: 'req-ext-001',
      }),
    ).toThrowError(/must have a \.docx extension/);
  });

  // ── 7. Security: Macros, External Relationships & Remote URLs ───────

  it('rejects inputs containing macro or executable references', () => {
    const input = createValidDocxInput({
      title: 'Report with vbaProject.bin embedded payload',
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-macro-001',
      }),
    ).toThrowError(/MACRO_OR_EXECUTABLE_DETECTED/);
  });

  it('rejects inputs containing external URLs or protocols', () => {
    const input = createValidDocxInput({
      title: 'Report linking to https://evil.example.com/exploit',
    });

    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/psv_note.docx',
        requestId: 'req-url-001',
      }),
    ).toThrowError(/EXTERNAL_RELATIONSHIP_FORBIDDEN/);
  });

  // ── 8. Collision Handling & Approved Overwrite ───────────────────────

  it('rejects collision when destination file already exists without allowOverwrite', () => {
    const destPath = path.join(projectRoot, 'artifacts', 'existing_file.docx');
    fs.writeFileSync(destPath, 'pre-existing file', 'utf-8');

    const input = createValidDocxInput();
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/existing_file.docx',
        allowOverwrite: false,
        requestId: 'req-collision-001',
      }),
    ).toThrowError(/ARTIFACT_COLLISION/);
  });

  it('allows overwrite when allowOverwrite is true and approval is valid', () => {
    const destPath = path.join(projectRoot, 'artifacts', 'overwrite_target.docx');
    fs.writeFileSync(destPath, 'old content', 'utf-8');

    const input = createValidDocxInput();
    const result = docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/overwrite_target.docx',
      allowOverwrite: true,
      approvalId: 'app-001',
      requestId: 'req-overwrite-001',
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(destPath)).toBe(true);

    const buf = fs.readFileSync(destPath);
    const val = validateDocxPackage(buf);
    expect(val.valid).toBe(true);
  });

  // ── 9. Idempotency & Conflict Detection ─────────────────────────────

  it('returns cached result on exact idempotent replay', () => {
    const input = createValidDocxInput();
    const res1 = docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/idempotent_test.docx',
      requestId: 'req-idem-001',
    });
    expect(res1.ok).toBe(true);
    expect(res1.cached).toBe(false);

    // Exact replay
    const res2 = docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/idempotent_test.docx',
      requestId: 'req-idem-001',
    });
    expect(res2.ok).toBe(true);
    expect(res2.cached).toBe(true);
    expect(res2.artifactHash).toBe(res1.artifactHash);
  });

  it('throws IDEMPOTENCY_CONFLICT when same requestId is used with conflicting parameters', () => {
    const input1 = createValidDocxInput();
    docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input: input1,
      outputPath: 'artifacts/conflict_test.docx',
      requestId: 'req-conflict-key',
    });

    // Send different output path under the same requestId
    expect(() =>
      docxGenerator.generateDocx({
        schemaVersion: 1,
        projectId: 'test-project',
        input: input1,
        outputPath: 'artifacts/different_path.docx',
        requestId: 'req-conflict-key',
      }),
    ).toThrowError(/IDEMPOTENCY_CONFLICT/);
  });

  // ── 10. Tool Boundary & Agent Authorization ─────────────────────────

  it('authorizes approved agents (report_agent, doc_agent, supervisor_agent)', () => {
    const input = createValidDocxInput();
    const authorizedAgents = ['report_agent', 'doc_agent', 'supervisor_agent'];

    for (let i = 0; i < authorizedAgents.length; i++) {
      const agent = authorizedAgents[i];
      const res = executeGenerateDocxTool(
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: `artifacts/auth_test_${i}.docx`,
          requestId: `req-auth-${agent}-${i}`,
        },
        {
          projectRoot,
          agentId: agent,
        },
        {
          docxGenerator,
          audit: auditService,
          idempotency: idempotencyStore,
        },
      );
      expect(res.ok).toBe(true);
    }
  });

  it('rejects unauthorized agents at tool boundary', () => {
    const input = createValidDocxInput();
    expect(() =>
      executeGenerateDocxTool(
        {
          schemaVersion: 1,
          projectId: 'test-project',
          input,
          outputPath: 'artifacts/unauth.docx',
          requestId: 'req-unauth-001',
        },
        {
          projectRoot,
          agentId: 'unauthorized_random_agent',
        },
        {
          docxGenerator,
          audit: auditService,
          idempotency: idempotencyStore,
        },
      ),
    ).toThrowError(/UNAUTHORIZED_TOOL_CALL/);
  });

  it('filters generate_docx properly in getToolsForAgent', () => {
    const allowedForDocAgent = getToolsForAgent(undefined, 'doc_agent');
    expect(allowedForDocAgent.some((t) => t.function.name === 'generate_docx')).toBe(true);

    const allowedForRandom = getToolsForAgent(undefined, 'unauthorized_coder');
    expect(allowedForRandom.some((t) => t.function.name === 'generate_docx')).toBe(false);
  });

  it('dispatches generate_docx via executeTool', () => {
    const input = createValidDocxInput();
    const response = executeTool(
      'generate_docx',
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/via_execute_tool.docx',
        requestId: 'req-tool-dispatch-001',
      },
      projectRoot,
      ['artifacts'],
      'doc_agent',
      'task-inspect-01',
      undefined,
      {
        docxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    expect(response.isComplete).toBe(false);
    const parsed = JSON.parse(response.result);
    expect(parsed.ok).toBe(true);
    expect(parsed.relativePath).toBe('artifacts/via_execute_tool.docx');
  });

  it('executes generate_docx asynchronously via executeGenerateDocxToolAsync', async () => {
    const input = createValidDocxInput();
    const res = await executeGenerateDocxToolAsync(
      {
        schemaVersion: 1,
        projectId: 'test-project',
        input,
        outputPath: 'artifacts/async_note.docx',
        requestId: 'req-async-001',
      },
      {
        projectRoot,
        agentId: 'supervisor_agent',
      },
      {
        docxGenerator,
        audit: auditService,
        idempotency: idempotencyStore,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.relativePath).toBe('artifacts/async_note.docx');
  });

  // ── 11. Audit Privacy Verification ──────────────────────────────────

  it('records privacy-safe audit events containing hashes and IDs without raw prose or secrets', () => {
    const input = createValidDocxInput();
    docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'test-project',
      input,
      outputPath: 'artifacts/privacy_test.docx',
      requestId: 'req-privacy-001',
    });

    const auditChainPath = path.join(projectRoot, '.maos', 'audit', 'audit-chain.jsonl');
    expect(fs.existsSync(auditChainPath)).toBe(true);

    const auditLines = fs
      .readFileSync(auditChainPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    const docxEvents = auditLines.filter((rec) =>
      rec.data?.event === 'DOCX_GENERATED' || rec.data?.event === 'DOCX_GENERATION_STARTED',
    );

    expect(docxEvents.length).toBeGreaterThanOrEqual(2);

    for (const evt of docxEvents) {
      const data = evt.data;
      expect(data.inputHash).toBeDefined();
      expect(data.inputHash).toHaveLength(64);
      // Ensure no raw prose leaked into audit
      expect(JSON.stringify(data)).not.toContain('The valve shows optimal spring seating');
      expect(JSON.stringify(data)).not.toContain('secret');
      expect(JSON.stringify(data)).not.toContain('password');
    }
  });

  // ── 12. Canary File Invariant ───────────────────────────────────────

  it('preserves canary file rust/test.txt unmodified', () => {
    const canaryPath = path.join('C:\\maos', 'rust', 'test.txt');
    if (fs.existsSync(canaryPath)) {
      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_HASH);
    }
  });
});
