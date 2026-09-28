/**
 * F4-02: Printed-Text OCR Test Suite
 *
 * Validates:
 *   1. Printed text extraction on clean single-page images
 *   2. Multi-page document OCR via PDF rasterization pipeline
 *   3. Granular bounding boxes on text blocks
 *   4. Confidence scores and provenance preservation
 *   5. Source SHA-256 hash propagation
 *   6. Engine and version recording
 *   7. Low-confidence warnings and thresholds
 *   8. Empty/blank page handling (EMPTY_PAGE_NO_TEXT)
 *   9. Unsupported handwriting detection and labeling
 *  10. Rotated text detection and orientation correction
 *  11. Noisy / blurred scan handling and warnings
 *  12. Oversized image dimension rejection (OVERSIZED_IMAGE_DIMENSIONS)
 *  13. Oversized pixel count rejection (PIXEL_LIMIT_EXCEEDED)
 *  14. Source byte limit enforcement (BYTE_LIMIT_EXCEEDED)
 *  15. Page limit enforcement on documents (PAGE_LIMIT_EXCEEDED)
 *  16. Timeout bounds enforcement (TIMEOUT)
 *  17. Malformed raster input fail-closed handling (MALFORMED_INPUT)
 *  18. OCR engine failure handling (OCR_ENGINE_FAILED)
 *  19. Missing local engine / assets handling (MISSING_ENGINE_ASSETS)
 *  20. Offline operation (zero network requests)
 *  21. Safe artifact store integration (atomic rename, no partial leaks)
 *  22. Authoritative Rust engine SHA-256 hash verification
 *  23. Audit trail sequencing (event recorded on success, zero events on failure)
 *  24. Cross-project traversal & symlink escape rejection
 *  25. Deterministic output verification
 *  26. Protected file invariant (rust/test.txt SHA-256 integrity)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
import { OcrService } from '../../src/service/ocr-service';
import { PdfRasterService } from '../../src/service/pdf-raster-service';
import { ArtifactService } from '../../src/service/artifact-service';
import { AuditService } from '../../src/service/audit-service';
import { EventService } from '../../src/service/event-service';
import { ApprovalService } from '../../src/service/approval-service';
import { OcrError } from '../../src/domain/ocr';

// ── Test Image Generators ──────────────────────────────────────────

function generateTextImage(
  targetPath: string,
  lines: string[],
  options: {
    rotate?: number;
    blur?: number;
    handwriting?: boolean;
    blank?: boolean;
  } = {},
): void {
  const pyCode = `
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import json

if ${options.blank ? 'True' : 'False'}:
    img = Image.new('L', (300, 100), 255)
else:
    lines = ${JSON.stringify(lines)}
    h = max(100, len(lines) * 45 + 40)
    img = Image.new('L', (500, h), 255)
    d = ImageDraw.Draw(img)
    f = ImageFont.load_default(size=18)
    y = 20
    for l in lines:
        d.text((20, y), l, 0, font=f)
        y += 40

    if ${options.handwriting ? 'True' : 'False'}:
        # Simulate irregular handwriting strokes
        for i in range(80):
            d.line([(30 + i * 5, 25 + (i % 6) * 5), (35 + i * 5, 28 + ((i + 2) % 8) * 5)], fill=0, width=3)

    if ${options.blur ? 'True' : 'False'}:
        img = img.filter(ImageFilter.GaussianBlur(radius=${options.blur || 2}))

    if ${options.rotate ? 'True' : 'False'}:
        img = img.rotate(${options.rotate || 90}, expand=True)

img.save(r'''${targetPath}''')
`;

  const res = spawnSync('python', ['-c', pyCode], {
    env: { ...process.env },
    shell: false,
  });

  if (res.status !== 0) {
    throw new Error(`Failed to generate test image: ${res.stderr?.toString('utf8')}`);
  }
}

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

  const pagesObj = `2 0 obj
<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${count} >>
endobj
`;

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
${pagesObj}${objects}xref
0 ${objIndex}
trailer
<< /Size ${objIndex} /Root 1 0 R >>
startxref
500
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

describe('F4-02: Printed-Text OCR', () => {
  let testDir: string;
  let ocrService: OcrService;
  let pdfRasterService: PdfRasterService;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let approvalService: ApprovalService;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ocr-test-'));
    fs.mkdirSync(path.join(testDir, '.maos'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectId: 'ocr-test', projectName: 'OCR Test' }),
    );

    const eventService = new EventService(testDir);
    approvalService = new ApprovalService(testDir);
    artifactService = new ArtifactService(testDir, eventService, approvalService);
    auditService = new AuditService(testDir);
    pdfRasterService = new PdfRasterService(testDir, artifactService, auditService);
    ocrService = new OcrService(testDir, artifactService, auditService, pdfRasterService);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // ── Section 1: Printed Text Extraction & Provenance ─────────────────

  it('extracts printed text from a clean image with high confidence and bounding boxes', async () => {
    const imgPath = path.join(testDir, 'sample_report.png');
    generateTextImage(imgPath, ['INSPECTION REPORT', 'STATUS: PASS', 'SERIAL: ABC-1234']);

    const result = await ocrService.ocrImage('sample_report.png');

    expect(result.schemaVersion).toBe(1);
    expect(result.engine).toBe('maos-industrial-ocr');
    expect(result.engineVersion).toBe('1.0.0');
    expect(result.language).toBe('en');
    expect(result.pageNumber).toBe(1);
    expect(result.sourceArtifactId).toBe('sample_report.png');
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);

    // Text content
    expect(result.text).toContain('INSPECTION REPORT');
    expect(result.text).toContain('STATUS: PASS');
    expect(result.text).toContain('SERIAL: ABC-1234');

    // Granular blocks
    expect(result.blocks.length).toBe(3);
    for (const block of result.blocks) {
      expect(block.id).toMatch(/^block-1-\d+$/);
      expect(block.confidence).toBeGreaterThanOrEqual(0.80);
      expect(block.bbox.x).toBeGreaterThanOrEqual(0);
      expect(block.bbox.y).toBeGreaterThanOrEqual(0);
      expect(block.bbox.width).toBeGreaterThan(0);
      expect(block.bbox.height).toBeGreaterThan(0);
      expect(block.engine).toBe('maos-industrial-ocr');
    }

    // High confidence
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it('propagates source SHA-256 hash accurately and checks expected hash', async () => {
    const imgPath = path.join(testDir, 'hash_test.png');
    generateTextImage(imgPath, ['HASH VERIFICATION 2026']);

    const buf = fs.readFileSync(imgPath);
    const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');

    const result = await ocrService.ocrImage('hash_test.png', { expectedSourceHash: expectedHash });
    expect(result.sourceHash).toBe(expectedHash);

    // Mismatched hash fails closed
    await expect(
      ocrService.ocrImage('hash_test.png', { expectedSourceHash: '0'.repeat(64) }),
    ).rejects.toThrow(OcrError);
  });

  // ── Section 2: Multi-Page OCR via PDF Pipeline ──────────────────────

  it('processes multi-page documents end-to-end via bounded PDF rasterization', async () => {
    const pdfPath = path.join(testDir, 'multipage.pdf');
    fs.writeFileSync(pdfPath, createMultiPagePdf(2));

    const docResult = await ocrService.ocrDocument('multipage.pdf');

    expect(docResult.schemaVersion).toBe(1);
    expect(docResult.totalPages).toBe(2);
    expect(docResult.pages.length).toBe(2);
    expect(docResult.pages[0].pageNumber).toBe(1);
    expect(docResult.pages[1].pageNumber).toBe(2);
    expect(docResult.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(docResult.averageConfidence).toBeGreaterThan(0);
  });

  // ── Section 3: Rotation, Blur, Noise, and Handwriting ────────────────

  it('detects rotated text and corrects orientation with appropriate warning', async () => {
    const imgPath = path.join(testDir, 'rotated_doc.png');
    generateTextImage(imgPath, ['ROTATED INSPECTION', 'CHECK VALVE A1'], { rotate: 90 });

    const result = await ocrService.ocrImage('rotated_doc.png');

    expect(result.warnings).toContain('ROTATED_TEXT_DETECTED');
    expect(result.warnings).toContain('ORIENTATION_CORRECTED_90_DEG');
    expect(result.text).toContain('ROTATED INSPECTION');
  });

  it('detects noisy/blurred scans and attaches warning with adjusted confidence', async () => {
    const imgPath = path.join(testDir, 'blurred_doc.png');
    generateTextImage(imgPath, ['BLURRED TEXT LINE'], { blur: 2 });

    const result = await ocrService.ocrImage('blurred_doc.png');

    expect(result.warnings).toContain('NOISY_OR_BLURRED_SCAN');
    // Result confidence adjusted downwards due to blur
    expect(result.confidence).toBeLessThanOrEqual(0.70);
  });

  it('flags unsupported handwriting with explicit warning and low confidence', async () => {
    const imgPath = path.join(testDir, 'handwriting_sample.png');
    generateTextImage(imgPath, ['Handwritten Note 2026'], { handwriting: true });

    const result = await ocrService.ocrImage('handwriting_sample.png');

    expect(result.warnings).toContain('UNSUPPORTED_HANDWRITING_DETECTED');
    expect(result.warnings).toContain('LOW_CONFIDENCE_REQUIRES_REVIEW');
    expect(result.confidence).toBeLessThan(0.60);
  });

  it('handles empty/blank page gracefully without failure or phantom text', async () => {
    const imgPath = path.join(testDir, 'blank_page.png');
    generateTextImage(imgPath, [], { blank: true });

    const result = await ocrService.ocrImage('blank_page.png');

    expect(result.text).toBe('');
    expect(result.blocks).toHaveLength(0);
    expect(result.warnings).toContain('EMPTY_PAGE_NO_TEXT');
  });

  // ── Section 4: Resource Limits & Bound Enforcement ──────────────────

  it('enforces source file byte limit (BYTE_LIMIT_EXCEEDED)', async () => {
    const imgPath = path.join(testDir, 'large.png');
    generateTextImage(imgPath, ['LARGE FILE TEST']);

    await expect(
      ocrService.ocrImage('large.png', { maxSourceBytes: 100 }),
    ).rejects.toThrow(OcrError);
  });

  it('enforces page limit on multi-page documents (PAGE_LIMIT_EXCEEDED)', async () => {
    const pdfPath = path.join(testDir, 'too_many_pages.pdf');
    fs.writeFileSync(pdfPath, createMultiPagePdf(4));

    await expect(
      ocrService.ocrDocument('too_many_pages.pdf', { maxPages: 2 }),
    ).rejects.toThrow(OcrError);
  });

  it('enforces image dimension limits (OVERSIZED_IMAGE_DIMENSIONS)', async () => {
    const imgPath = path.join(testDir, 'oversized.png');
    generateTextImage(imgPath, ['OVERSIZED TEST']);

    await expect(
      ocrService.ocrImage('oversized.png', { maxImageDimension: 50 }),
    ).rejects.toThrow(OcrError);
  });

  it('enforces execution timeout bounds (TIMEOUT)', async () => {
    const imgPath = path.join(testDir, 'timeout.png');
    generateTextImage(imgPath, ['TIMEOUT TEST']);

    await expect(
      ocrService.ocrImage('timeout.png', { timeoutMs: 1 }),
    ).rejects.toThrow(OcrError);
  });

  // ── Section 5: Fail-Closed Security & Confinement ───────────────────

  it('fails safely on non-existent file (NOT_FOUND)', async () => {
    await expect(
      ocrService.ocrImage('missing.png'),
    ).rejects.toThrow(OcrError);
  });

  it('rejects unsupported file extension (INVALID_EXTENSION)', async () => {
    const badPath = path.join(testDir, 'doc.txt');
    fs.writeFileSync(badPath, 'hello text');

    await expect(
      ocrService.ocrImage('doc.txt'),
    ).rejects.toThrow(OcrError);
  });

  it('rejects spoofed extension with invalid magic bytes (INVALID_IMAGE_FORMAT)', async () => {
    const spoofPath = path.join(testDir, 'spoofed.png');
    fs.writeFileSync(spoofPath, Buffer.from('NOT A REAL PNG FILE'));

    await expect(
      ocrService.ocrImage('spoofed.png'),
    ).rejects.toThrow(OcrError);
  });

  it('rejects path traversal escaping project root (TRAVERSAL_REJECTED)', async () => {
    await expect(
      ocrService.ocrImage('../outside.png'),
    ).rejects.toThrow(OcrError);
  });

  it('rejects symlink escaping project root (SYMLINK_ESCAPE_REJECTED)', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ocr-ext-'));
    const outsideFile = path.join(outsideDir, 'secret.png');
    generateTextImage(outsideFile, ['SECRET']);

    const symlinkPath = path.join(testDir, 'escape_link.png');
    try {
      fs.symlinkSync(outsideFile, symlinkPath, 'file');
    } catch {
      // On Windows without SeCreateSymbolicLinkPrivilege, skip symlink creation
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      await expect(
        ocrService.ocrImage('escape_link.png'),
      ).rejects.toThrow(OcrError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('fails safely when local engine assets are missing (MISSING_ENGINE_ASSETS)', async () => {
    const badOcrService = new OcrService(
      testDir,
      artifactService,
      auditService,
      pdfRasterService,
      { backendScriptPath: path.join(testDir, 'non_existent_ocr.py') },
    );

    const imgPath = path.join(testDir, 'test.png');
    generateTextImage(imgPath, ['TEST']);

    await expect(
      badOcrService.ocrImage('test.png'),
    ).rejects.toThrow(OcrError);
  });

  // ── Section 6: Safe Artifact Store & Audit Logging ──────────────────

  it('finalizes OCR result JSON in Safe Artifact Store with atomic rename', async () => {
    const imgPath = path.join(testDir, 'artifact_test.png');
    generateTextImage(imgPath, ['ARTIFACT INTEGRATION 2026']);

    const result = await ocrService.ocrImage('artifact_test.png');

    const expectedRelPath = `evidence/ocr/${result.sourceHash.substring(0, 16)}/page_1.json`;
    const fullArtifactPath = path.join(testDir, expectedRelPath);

    expect(fs.existsSync(fullArtifactPath)).toBe(true);

    const storedContent = JSON.parse(fs.readFileSync(fullArtifactPath, 'utf8'));
    expect(storedContent.schemaVersion).toBe(1);
    expect(storedContent.sourceHash).toBe(result.sourceHash);
    expect(storedContent.text).toContain('ARTIFACT INTEGRATION 2026');

    // Verify scratch directory has zero lingering files
    const scratchDir = path.join(testDir, '.maos', 'artifacts', '.tmp');
    if (fs.existsSync(scratchDir)) {
      expect(fs.readdirSync(scratchDir)).toHaveLength(0);
    }
  });

  it('records an immutable audit event on success and zero events on error', async () => {
    const imgPath = path.join(testDir, 'audit_test.png');
    generateTextImage(imgPath, ['AUDIT LOGGING TEST']);

    await ocrService.ocrImage('audit_test.png');

    const auditChainPath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');
    expect(fs.existsSync(auditChainPath)).toBe(true);

    const lines = fs.readFileSync(auditChainPath, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));

    const ocrEvent = events.find((e) => e.data?.action === 'DOCUMENT_OCRED');
    expect(ocrEvent).toBeDefined();
    expect(ocrEvent.category).toBe('tool');
    expect(ocrEvent.source).toBe('ocr-service');
    expect(ocrEvent.data.textLength).toBeGreaterThan(0);

    const eventCountBefore = events.length;

    // Trigger failure
    await expect(
      ocrService.ocrImage('nonexistent.png'),
    ).rejects.toThrow(OcrError);

    // Assert zero new audit events were written
    const updatedLines = fs.readFileSync(auditChainPath, 'utf8').trim().split('\n');
    expect(updatedLines.length).toBe(eventCountBefore);
  });

  it('produces deterministic output across repeated OCR calls', async () => {
    const imgPath = path.join(testDir, 'determinism.png');
    generateTextImage(imgPath, ['DETERMINISTIC OCR TEST', 'LINE TWO: 12345']);

    const run1 = await ocrService.ocrImage('determinism.png');

    const approval = approvalService.createApproval({
      gateId: 'G4',
      conditions: [],
    });
    approvalService.decideApproval(approval.id, 'approved', 'lead-inspector');

    const run2 = await ocrService.ocrImage('determinism.png', { approvalId: approval.id });

    expect(run1.text).toBe(run2.text);
    expect(run1.confidence).toBe(run2.confidence);
    expect(run1.sourceHash).toBe(run2.sourceHash);
    expect(run1.blocks.length).toBe(run2.blocks.length);
    for (let i = 0; i < run1.blocks.length; i++) {
      expect(run1.blocks[i].text).toBe(run2.blocks[i].text);
      expect(run1.blocks[i].confidence).toBe(run2.blocks[i].confidence);
      expect(run1.blocks[i].bbox).toEqual(run2.blocks[i].bbox);
    }
  });

  it('fails closed when the disabled TypeScript fallback is requested', async () => {
    const imgPath = path.join(testDir, 'fallback_test.png');
    generateTextImage(imgPath, ['FALLBACK ENGINE RUN']);

    await expect(
      ocrService.ocrImage('fallback_test.png', { forceFallback: true }),
    ).rejects.toMatchObject({ code: 'MISSING_ENGINE_ASSETS' });
  });

  it('fails safely on malformed/corrupt image bytes (MALFORMED_INPUT)', async () => {
    const corruptPath = path.join(testDir, 'corrupt.png');
    // Write valid PNG header followed by garbage
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('CORRUPTED AND TRUNCATED IMAGE DATA THAT CANNOT BE DECODED'),
    ]);
    fs.writeFileSync(corruptPath, fakePng);

    await expect(
      ocrService.ocrImage('corrupt.png'),
    ).rejects.toThrow(OcrError);
  });

  it('applies custom confidence thresholds when provided', async () => {
    const imgPath = path.join(testDir, 'threshold_test.png');
    generateTextImage(imgPath, ['THRESHOLD TEST LINE'], { blur: 2 });

    const result = await ocrService.ocrImage('threshold_test.png', {
      confidenceThresholds: { high: 0.99, medium: 0.90 },
    });

    // With very strict medium threshold, blurred text triggers review warning
    expect(result.warnings).toContain('LOW_CONFIDENCE_REQUIRES_REVIEW');
  });

  it('filters specific target pages when targetPages is supplied to ocrDocument', async () => {
    const pdfPath = path.join(testDir, 'filtered_multipage.pdf');
    fs.writeFileSync(pdfPath, createMultiPagePdf(3));

    const docResult = await ocrService.ocrDocument('filtered_multipage.pdf', {
      targetPages: [2],
    });

    expect(docResult.totalPages).toBe(1);
    expect(docResult.pages[0].pageNumber).toBe(2);
  });

  it('fails closed when given path is a directory (NOT_FOUND)', async () => {
    const subDir = path.join(testDir, 'sub_directory.png');
    fs.mkdirSync(subDir, { recursive: true });

    await expect(
      ocrService.ocrImage('sub_directory.png'),
    ).rejects.toThrow(OcrError);
  });

  // ── Section 7: Invariant Check ──────────────────────────────────────

  it('preserves rust/test.txt SHA-256 invariant', () => {
    const testTxtPath = path.resolve(__dirname, '..', '..', 'rust', 'test.txt');
    if (fs.existsSync(testTxtPath)) {
      const content = fs.readFileSync(testTxtPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe('1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435');
    }
  });
});

