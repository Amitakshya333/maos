/**
 * F4-03: Register ocr_document Tool Test Suite
 *
 * Validates:
 *   1. Tool definition & schema registration in AGENT_TOOLS
 *   2. F1-10 conformance (no unsupported ISO/certification claims)
 *   3. Tool advertisement filtering (getToolsForAgent)
 *   4. Authorized execution via executeTool and programmatic executeOcrDocumentTool
 *   5. Output provenance (sourceArtifactId, sourceHash, pageResults, blockCount)
 *   6. Safe Artifact Store integration (page JSON artifacts in evidence/ocr/)
 *   7. Immutable audit trail integration (DOCUMENT_OCRED event)
 *   8. Authorization enforcement & defense-in-depth (TOOL_UNAUTHORIZED, UNAUTHORIZED_TOOL_CALL)
 *   9. Input validation & path confinement (traversal, non-PDF, invalid magic bytes, byte limits)
 *  10. Page range validation (start < 1, end < start, page limit)
 *  11. Language allowlist validation (en/eng accepted, others rejected with UNSUPPORTED_LANGUAGE)
 *  12. Confidence mode handling (standard vs strict)
 *  13. Durable idempotency (exact replay with cached: true, conflict detection, auth mismatch)
 *  14. Zero phantom audit events on failure
 *  15. Scratch and failure cleanup
 *  16. Protected file invariant (rust/test.txt SHA-256 integrity)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  AGENT_TOOLS,
  getToolsForAgent,
  executeTool,
  executeOcrDocumentTool,
  executeOcrDocumentToolAsync,
  AUTHORIZED_OCR_AGENTS,
} from '../../src/integrations/tools';
import {
  OcrDocumentInput,
  OcrDocumentToolResult,
  OcrError,
  OCR_BOUNDS,
  validateOcrDocumentInput,
} from '../../src/domain/ocr';
import {
  createServiceContainer,
  ServiceContainer,
  OcrService,
  PdfRasterService,
  ArtifactService,
  AuditService,
  DurableIdempotencyStore,
} from '../../src/service';

// ── Test PDF Generators ───────────────────────────────────────────

function createMinimalPdf(text = 'Turbine Inspection Report', width = 300, height = 200): Buffer {
  const contentStream = Buffer.from(
    `BT /F1 12 Tf 30 150 Td (${text}) Tj ET 10 10 280 180 re S`
  );
  const deflated = zlib.deflateSync(contentStream);

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${deflated.length} /Filter /FlateDecode >>
stream
` + deflated.toString('latin1') + `
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000215 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
400
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

function createMultiPagePdf(count: number, width = 300, height = 200): Buffer {
  let objects = '';
  const kidsRefs: string[] = [];
  let objIndex = 3;

  for (let i = 1; i <= count; i++) {
    const pageObjNum = objIndex++;
    const contentObjNum = objIndex++;
    kidsRefs.push(`${pageObjNum} 0 R`);

    const streamData = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 20 150 Td (Page ${i} of ${count}) Tj ET`));

    objects += `${pageObjNum} 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentObjNum} 0 R >>
endobj
${contentObjNum} 0 obj
<< /Length ${streamData.length} /Filter /FlateDecode >>
stream
` + streamData.toString('latin1') + `
endstream
endobj
`;
  }

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${count} >>
endobj
${objects}xref
0 ${objIndex}
0000000000 65535 f 
trailer
<< /Size ${objIndex} /Root 1 0 R >>
startxref
500
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

describe('F4-03: Register ocr_document Tool', () => {
  let testDir: string;
  let services: ServiceContainer;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ocr-tool-test-'));
    fs.mkdirSync(path.join(testDir, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.maos', 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'evidence'), { recursive: true });

    services = createServiceContainer(testDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  // ── 1. Tool Registration & Schema Definition ──────────────────────────

  describe('Tool Definition & Schema Registration', () => {
    it('registers ocr_document in AGENT_TOOLS with valid JSON schema', () => {
      const tool = AGENT_TOOLS.find((t) => t.function.name === 'ocr_document');
      expect(tool).toBeDefined();
      expect(tool?.type).toBe('function');
      expect(tool?.function.description).toContain('Extract printed text');

      const params = tool?.function.parameters as any;
      expect(params.type).toBe('object');
      expect(params.required).toContain('schemaVersion');
      expect(params.required).toContain('projectId');
      expect(params.required).toContain('sourcePath');
      expect(params.required).toContain('requestId');
      expect(params.properties.pageRange).toBeDefined();
      expect(params.properties.confidenceMode.enum).toEqual(['standard', 'strict']);
    });

    it('conforms to F1-10 by making no unsupported ISO/certification claims in tool description', () => {
      const tool = AGENT_TOOLS.find((t) => t.function.name === 'ocr_document');
      const desc = tool?.function.description || '';
      expect(desc).not.toContain('ISO 10816');
      expect(desc).not.toContain('tamper-proof');
      expect(desc).not.toContain('certified');
    });

    it('advertises ocr_document to authorized agents via getToolsForAgent', () => {
      // When allowedTools is explicitly provided
      const withAllowed = getToolsForAgent(['ocr_document', 'read_file'], 'custom-agent');
      expect(withAllowed.map((t) => t.function.name)).toContain('ocr_document');
      expect(withAllowed.map((t) => t.function.name)).toContain('read_file');
      expect(withAllowed.map((t) => t.function.name)).not.toContain('write_file');

      // When allowedTools is omitted but agent is an authorized role
      const ingestTools = getToolsForAgent(undefined, 'INGEST_AGENT');
      expect(ingestTools.map((t) => t.function.name)).toContain('ocr_document');

      const analystTools = getToolsForAgent(undefined, 'analyst_agent');
      expect(analystTools.map((t) => t.function.name)).toContain('ocr_document');

      const inspectorTools = getToolsForAgent(undefined, 'lead-inspector');
      expect(inspectorTools.map((t) => t.function.name)).toContain('ocr_document');
    });

    it('omits ocr_document for unauthorized agents when allowedTools is not specified', () => {
      const rogueTools = getToolsForAgent(undefined, 'unauthorized-agent');
      expect(rogueTools.map((t) => t.function.name)).not.toContain('ocr_document');

      const defaultTools = getToolsForAgent(undefined, undefined);
      expect(defaultTools.map((t) => t.function.name)).not.toContain('ocr_document');
    });
  });

  // ── 2. Authorized Execution & Output Provenance ────────────────────────

  describe('Authorized Tool Execution & Provenance', () => {
    it('executes ocr_document via executeTool for an authorized agent and returns typed result', () => {
      const pdfBuffer = createMinimalPdf('PUMP-101 VIBRATION REPORT');
      const relPdfPath = 'evidence/report.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-auth-exec-1',
        language: 'en',
        confidenceMode: 'standard',
      };

      const res = executeTool(
        'ocr_document',
        input,
        testDir,
        ['evidence/'],
        'INGEST_AGENT',
        'task-1',
        ['ocr_document', 'read_file'],
      );

      expect(res.isComplete).toBe(false);
      const parsed = JSON.parse(res.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.sourceArtifactId).toBe('evidence/report.pdf');
      expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.totalPages).toBe(1);
      expect(parsed.pageResults).toHaveLength(1);

      const page1 = parsed.pageResults[0];
      expect(page1.pageNumber).toBe(1);
      expect(page1.artifactId).toMatch(/^art_ocr_/);
      expect(page1.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(page1.confidence).toBeGreaterThan(0);
      expect(page1.blockCount).toBeGreaterThan(0);

      // Verify audit event ID
      expect(parsed.auditEventId).toBeDefined();
      expect(typeof parsed.auditEventId).toBe('string');

      // Verify artifact on disk
      const storedArtifact = services.artifact.getArtifact(page1.artifactId);
      expect(storedArtifact).toBeDefined();
      expect(fs.existsSync(path.join(testDir, storedArtifact!.path))).toBe(true);

      // Verify audit chain on disk
      const auditChainPath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');
      const auditContent = fs.readFileSync(auditChainPath, 'utf8');
      expect(auditContent).toContain('DOCUMENT_OCRED');
      expect(auditContent).toContain(input.requestId);
    });

    it('processes multi-page documents via programmatic executeOcrDocumentTool', () => {
      const pdfBuffer = createMultiPagePdf(3);
      const relPdfPath = 'evidence/multipage.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-multi-page-1',
      };

      const result = executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'inspector',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      expect(result.schemaVersion).toBe(1);
      expect(result.totalPages).toBe(3);
      expect(result.pageResults).toHaveLength(3);
      expect(result.pageResults[0].pageNumber).toBe(1);
      expect(result.pageResults[1].pageNumber).toBe(2);
      expect(result.pageResults[2].pageNumber).toBe(3);
      expect(result.engine).toBe('maos-industrial-ocr');
    });

    it('supports async execution via executeOcrDocumentToolAsync', async () => {
      const pdfBuffer = createMinimalPdf('ASYNC OCR TEST');
      const relPdfPath = 'evidence/async_doc.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-async-1',
      };

      const result = await executeOcrDocumentToolAsync(
        input,
        {
          projectRoot: testDir,
          agentId: 'ANALYST_AGENT',
        },
        services,
      );

      expect(result.totalPages).toBe(1);
      expect(result.pageResults).toHaveLength(1);
      expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── 3. Authorization Enforcement & Defense-in-Depth ───────────────────

  describe('Authorization Enforcement', () => {
    it('blocks unauthorized tool call when allowedTools does not contain ocr_document', () => {
      const pdfBuffer = createMinimalPdf();
      const relPdfPath = 'evidence/test.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-unauth-1',
      };

      const res = executeTool(
        'ocr_document',
        input,
        testDir,
        ['evidence/'],
        'SYNTHESIZER_AGENT',
        'task-1',
        ['read_file', 'write_file', 'task_complete'], // ocr_document NOT allowed
      );

      expect(res.result).toContain('TOOL_UNAUTHORIZED');
      expect(res.result).toContain('SYNTHESIZER_AGENT');
    });

    it('rejects fabricated ocr_document execution from unprivileged agent role', () => {
      const pdfBuffer = createMinimalPdf();
      const relPdfPath = 'evidence/test.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-unauth-2',
      };

      // No allowedTools provided, agentId is not an authorized OCR role
      const res = executeTool(
        'ocr_document',
        input,
        testDir,
        ['/'],
        'rogue-agent',
        'task-1',
        undefined,
      );

      const parsed = JSON.parse(res.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('UNAUTHORIZED_TOOL_CALL');
    });

    it('throws UNAUTHORIZED_TOOL_CALL on direct executeOcrDocumentTool call by unauthorized agent', () => {
      const pdfBuffer = createMinimalPdf();
      const relPdfPath = 'evidence/test.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-unauth-3',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'general-assistant',
          },
          services,
        );
      }).toThrowError(/UNAUTHORIZED_TOOL_CALL/);
    });
  });

  // ── 4. Input Validation & Path Confinement ─────────────────────────────

  describe('Input Validation & Path Confinement', () => {
    it('rejects invalid schema version', () => {
      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 2,
          projectId: 'test-p',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'req-1',
        });
      }).toThrowError(/schemaVersion must be 1/);
    });

    it('rejects empty or missing required fields', () => {
      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: '',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'req-1',
        });
      }).toThrowError(/projectId must be a non-empty string/);

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'test-p',
          sourcePath: '',
          requestId: 'req-1',
        });
      }).toThrowError(/sourcePath must be a non-empty string/);

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'test-p',
          sourcePath: 'evidence/doc.pdf',
          requestId: '',
        });
      }).toThrowError(/requestId must be a non-empty string/);
    });

    it('rejects directory traversal attempts in sourcePath', () => {
      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'test-p',
          sourcePath: '../../etc/passwd.pdf',
          requestId: 'req-1',
        });
      }).toThrowError(/TRAVERSAL_REJECTED/);

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'test-p',
          sourcePath: 'evidence/../secret.pdf',
          requestId: 'req-1',
        });
      }).toThrowError(/TRAVERSAL_REJECTED/);
    });

    it('rejects non-PDF files (invalid extension)', () => {
      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'test-p',
          sourcePath: 'evidence/scan.png',
          requestId: 'req-1',
        });
      }).toThrowError(/INVALID_EXTENSION/);
    });

    it('rejects non-existent PDF file with NOT_FOUND', () => {
      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/nonexistent.pdf',
        requestId: 'req-notfound-1',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/NOT_FOUND/);
    });

    it('rejects file without %PDF- magic bytes header', () => {
      const fakePdfPath = path.join(testDir, 'evidence', 'corrupted.pdf');
      fs.writeFileSync(fakePdfPath, 'THIS IS NOT A VALID PDF FILE CONTENT');

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/corrupted.pdf',
        requestId: 'req-corrupted-1',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/INVALID_IMAGE_FORMAT/);
    });

    it('rejects empty PDF file (0 bytes)', () => {
      const emptyPdfPath = path.join(testDir, 'evidence', 'empty.pdf');
      fs.writeFileSync(emptyPdfPath, Buffer.alloc(0));

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/empty.pdf',
        requestId: 'req-empty-1',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/MALFORMED_INPUT/);
    });

    it('rejects out-of-scope files when scope is specified', () => {
      const pdfBuffer = createMinimalPdf();
      fs.mkdirSync(path.join(testDir, 'secrets'), { recursive: true });
      fs.writeFileSync(path.join(testDir, 'secrets', 'leak.pdf'), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'secrets/leak.pdf',
        requestId: 'req-scope-1',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            scope: ['evidence/'], // secrets/ is out of scope
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/TRAVERSAL_REJECTED/);
    });
  });

  // ── 5. Page Range & Language Validation ───────────────────────────────

  describe('Page Range & Language Validation', () => {
    it('restricts OCR to requested pageRange', () => {
      const pdfBuffer = createMultiPagePdf(4);
      const relPdfPath = 'evidence/pages4.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-range-1',
        pageRange: { start: 2, end: 3 },
      };

      const result = executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      expect(result.pageResults).toHaveLength(2);
      expect(result.pageResults.map((p) => p.pageNumber)).toEqual([2, 3]);
    });

    it('rejects invalid page ranges (start < 1, end < start, page limit)', () => {
      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'r1',
          pageRange: { start: 0, end: 5 },
        });
      }).toThrowError(/INVALID_PAGE_RANGE/);

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'r1',
          pageRange: { start: 5, end: 2 },
        });
      }).toThrowError(/INVALID_PAGE_RANGE/);

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'r1',
          pageRange: { start: 1, end: 200 },
        });
      }).toThrowError(/PAGE_LIMIT_EXCEEDED/);
    });

    it('accepts allowlisted language tags (en, eng) and rejects unsupported languages', () => {
      const validatedEn = validateOcrDocumentInput({
        schemaVersion: 1,
        projectId: 'p1',
        sourcePath: 'evidence/doc.pdf',
        requestId: 'r1',
        language: 'en',
      });
      expect(validatedEn.language).toBe('en');

      const validatedEng = validateOcrDocumentInput({
        schemaVersion: 1,
        projectId: 'p1',
        sourcePath: 'evidence/doc.pdf',
        requestId: 'r2',
        language: 'eng',
      });
      expect(validatedEng.language).toBe('eng');

      expect(() => {
        validateOcrDocumentInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/doc.pdf',
          requestId: 'r3',
          language: 'fr',
        });
      }).toThrowError(/UNSUPPORTED_LANGUAGE/);
    });

    it('supports confidenceMode: strict', () => {
      const pdfBuffer = createMinimalPdf();
      const relPdfPath = 'evidence/strict.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-strict-1',
        confidenceMode: 'strict',
      };

      const result = executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      expect(result.schemaVersion).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  // ── 6. Durable Idempotency & Conflict Detection ───────────────────────

  describe('Durable Idempotency & Replay', () => {
    it('returns cached result on exact replay with matching requestId', () => {
      const pdfBuffer = createMinimalPdf('IDEMPOTENCY TEST');
      const relPdfPath = 'evidence/idempotent.pdf';
      fs.writeFileSync(path.join(testDir, relPdfPath), pdfBuffer);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: relPdfPath,
        requestId: 'req-idem-12345',
        language: 'en',
      };

      // First run
      const firstResult = executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );
      expect(firstResult.cached).toBeUndefined();

      // Second run with exact same input and requestId
      const replayResult = executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      expect(replayResult.cached).toBe(true);
      expect(replayResult.sourceHash).toBe(firstResult.sourceHash);
      expect(replayResult.auditEventId).toBe(firstResult.auditEventId);
      expect(replayResult.pageResults[0].artifactId).toBe(firstResult.pageResults[0].artifactId);
    });

    it('rejects conflicting request payload with identical requestId (IDEMPOTENCY_CONFLICT)', () => {
      const pdf1 = createMinimalPdf('Doc 1');
      const pdf2 = createMinimalPdf('Doc 2');
      fs.writeFileSync(path.join(testDir, 'evidence', 'doc1.pdf'), pdf1);
      fs.writeFileSync(path.join(testDir, 'evidence', 'doc2.pdf'), pdf2);

      const input1: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/doc1.pdf',
        requestId: 'req-conflict-key',
      };

      executeOcrDocumentTool(
        input1,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      // Same requestId, different sourcePath
      const input2: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/doc2.pdf',
        requestId: 'req-conflict-key',
      };

      expect(() => {
        executeOcrDocumentTool(
          input2,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/IDEMPOTENCY_CONFLICT/);
    });

    it('rejects authorization context mismatch with identical requestId (UNAUTHORIZED_TOOL_CALL)', () => {
      const pdf = createMinimalPdf();
      fs.writeFileSync(path.join(testDir, 'evidence', 'doc.pdf'), pdf);

      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/doc.pdf',
        requestId: 'req-auth-mismatch-key',
      };

      executeOcrDocumentTool(
        input,
        {
          projectRoot: testDir,
          agentId: 'INGEST_AGENT',
          allowedTools: ['ocr_document'],
        },
        services,
      );

      // Replay with different agentId
      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'ANALYST_AGENT', // Different agent
            allowedTools: ['ocr_document'],
          },
          services,
        );
      }).toThrowError(/UNAUTHORIZED_TOOL_CALL/);
    });
  });

  // ── 7. Clean Failure & Zero Phantom Events ────────────────────────────

  describe('Clean Failure & Zero Phantom Events', () => {
    it('emits zero audit events when tool validation fails', () => {
      const auditChainPath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');
      const initialAuditLines = fs.existsSync(auditChainPath)
        ? fs.readFileSync(auditChainPath, 'utf8').trim().split('\n').filter(Boolean).length
        : 0;

      const input = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/missing_file.pdf',
        requestId: 'req-fail-audit',
      };

      try {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      } catch {
        // Expected
      }

      const finalAuditLines = fs.existsSync(auditChainPath)
        ? fs.readFileSync(auditChainPath, 'utf8').trim().split('\n').filter(Boolean).length
        : 0;

      expect(finalAuditLines).toBe(initialAuditLines);
    });

    it('leaves zero orphaned temp files in .tmp on failure', () => {
      const tmpDir = path.join(testDir, '.maos', 'artifacts', '.tmp');
      const input = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: 'evidence/corrupted.pdf',
        requestId: 'req-clean-tmp',
      };
      fs.writeFileSync(path.join(testDir, 'evidence', 'corrupted.pdf'), 'INVALID HEADER');

      try {
        executeOcrDocumentTool(
          input,
          {
            projectRoot: testDir,
            agentId: 'INGEST_AGENT',
            allowedTools: ['ocr_document'],
          },
          services,
        );
      } catch {
        // Expected
      }

      if (fs.existsSync(tmpDir)) {
        const remaining = fs.readdirSync(tmpDir);
        expect(remaining).toHaveLength(0);
      }
    });
  });

  // ── 8. Invariant Protection ───────────────────────────────────────────

  describe('Invariant Protection', () => {
    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      const target = path.resolve('rust/test.txt');
      expect(fs.existsSync(target)).toBe(true);
      const content = fs.readFileSync(target);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe('1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435');
    });
  });
});
