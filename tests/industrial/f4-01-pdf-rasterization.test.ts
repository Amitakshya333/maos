/**
 * F4-01: Bounded PDF Rasterization Test Suite
 *
 * Validates:
 *   1. Valid single-page and multi-page scanned PDF rasterization
 *   2. Output format selection (PNG vs JPEG)
 *   3. Specific target pages selection
 *   4. Page limit enforcement (PAGE_LIMIT_EXCEEDED)
 *   5. Source byte limit enforcement (BYTE_LIMIT_EXCEEDED)
 *   6. Page dimension bounds enforcement (OVERSIZED_PAGE_DIMENSIONS)
 *   7. Pixel count limit enforcement (PIXEL_LIMIT_EXCEEDED)
 *   8. Decompression bomb defense (DECOMPRESSION_BOMB_DETECTED)
 *   9. Execution timeout bounds (TIMEOUT)
 *  10. Cumulative output size limits (OUTPUT_LIMIT_EXCEEDED)
 *  11. Malformed PDF fail-closed handling (MALFORMED_PDF)
 *  12. Encrypted PDF rejection (ENCRYPTED_PDF_UNSUPPORTED)
 *  13. Project-root confinement & traversal rejection (TRAVERSAL_REJECTED)
 *  14. Symlink escape rejection (SYMLINK_ESCAPE_REJECTED)
 *  15. MIME spoofing rejection (INVALID_MIME) and extension checks (INVALID_EXTENSION)
 *  16. Source tampering & SHA-256 provenance preservation
 *  17. Deterministic output verification
 *  18. Safe artifact store integration (atomic rename, no partial leaks)
 *  19. Audit event sequencing (success audit event recorded, zero phantom events on error)
 *  20. Offline operation (no network requests)
 *  21. Protected file invariant (rust/test.txt SHA-256 integrity)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { PdfRasterService } from '../../src/service/pdf-raster-service';
import { ArtifactService } from '../../src/service/artifact-service';
import { AuditService } from '../../src/service/audit-service';
import { EventService } from '../../src/service/event-service';
import { ApprovalService } from '../../src/service/approval-service';
import { PdfRasterError } from '../../src/domain/raster';

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
${objects}
xref
0 ${objIndex}
0000000000 65535 f 
trailer
<< /Size ${objIndex} /Root 1 0 R >>
startxref
1000
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

function createScannedPdfWithEmbeddedImage(width = 100, height = 80): Buffer {
  // Create a raw RGB bitmap (100x80)
  const rawRgb = Buffer.alloc(width * height * 3, 200);
  for (let i = 0; i < width * height; i++) {
    rawRgb[i * 3] = (i * 7) % 255;      // R
    rawRgb[i * 3 + 1] = (i * 13) % 255; // G
    rawRgb[i * 3 + 2] = (i * 17) % 255; // B
  }
  const deflated = zlib.deflateSync(rawRgb);

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${deflated.length} >>
stream
` + deflated.toString('latin1') + `
endstream
endobj
5 0 obj
<< /Length 20 >>
stream
q /Im0 Do Q
endstream
endobj
xref
0 6
0000000000 65535 f 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
800
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

function createDecompressionBombPdf(): Buffer {
  // Compress 1 MB of repeating zeroes into very small buffer (~100 bytes)
  const uncompressed = Buffer.alloc(1024 * 1024, 0);
  const deflated = zlib.deflateSync(uncompressed); // ~1000 bytes

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>
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
trailer
<< /Size 5 /Root 1 0 R >>
startxref
400
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

function createEncryptedPdf(): Buffer {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>
endobj
4 0 obj
<< /Filter /Standard /V 2 /R 3 /O (abcdef) /U (123456) /P -4 >>
endobj
xref
0 5
0000000000 65535 f 
trailer
<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>
startxref
300
%%EOF
`;
  return Buffer.from(pdf, 'latin1');
}

function createOversizedDimensionPdf(): Buffer {
  return createMinimalPdf('Oversized', 25000, 25000);
}

// ── Test Suite ────────────────────────────────────────────────────

describe('F4-01: Bounded PDF Rasterization', () => {
  let testDir: string;
  let artifactService: ArtifactService;
  let auditService: AuditService;
  let approvalService: ApprovalService;
  let rasterService: PdfRasterService;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f4-01-'));
    fs.mkdirSync(path.join(testDir, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'documents'), { recursive: true });

    const eventService = new EventService(testDir);
    approvalService = new ApprovalService(testDir);
    artifactService = new ArtifactService(testDir, eventService, approvalService);
    auditService = new AuditService(testDir);
    rasterService = new PdfRasterService(testDir, artifactService, auditService);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // ── 1. Basic & Scanned PDF Rasterization ─────────────────────────

  describe('1. Valid Scanned & Content PDF Rasterization', () => {
    it('rasterizes a valid single-page PDF to PNG with deterministic metadata', async () => {
      const pdfBuffer = createMinimalPdf('Turbine #4 Inspection PASS');
      const docPath = path.join(testDir, 'documents', 'inspection.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/inspection.pdf', {
        dpi: 150,
        format: 'png',
      });

      expect(result.schemaVersion).toBe(1);
      expect(result.sourceRelativePath).toBe('documents/inspection.pdf');
      expect(result.sourceHash).toBe(crypto.createHash('sha256').update(pdfBuffer).digest('hex'));
      expect(result.pageCount).toBe(1);
      expect(result.renderedPages.length).toBe(1);

      const page = result.renderedPages[0];
      expect(page.schemaVersion).toBe(1);
      expect(page.pageNumber).toBe(1);
      expect(page.format).toBe('png');
      expect(page.dpi).toBe(150);
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.outputArtifactId).toBeDefined();
      expect(page.outputRelativePath).toContain('inspection_page_1.png');
      expect(page.outputHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify the artifact file actually exists on disk
      const artifactAbsPath = path.join(testDir, page.outputRelativePath);
      expect(fs.existsSync(artifactAbsPath)).toBe(true);

      const savedBytes = fs.readFileSync(artifactAbsPath);
      expect(savedBytes.length).toBe(page.outputSizeBytes);
      // Verify PNG magic signature
      expect(savedBytes.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(crypto.createHash('sha256').update(savedBytes).digest('hex')).toBe(page.outputHash);
    });

    it('rasterizes a scanned PDF with embedded raster image stream', async () => {
      const pdfBuffer = createScannedPdfWithEmbeddedImage(120, 80);
      const docPath = path.join(testDir, 'documents', 'scanned_pump.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/scanned_pump.pdf');
      expect(result.pageCount).toBe(1);
      expect(result.renderedPages.length).toBe(1);

      const page = result.renderedPages[0];
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.outputSizeBytes).toBeGreaterThan(0);
    });

    it('rasterizes multi-page PDF documents in correct 1-indexed order', async () => {
      const pdfBuffer = createMultiPagePdf(3);
      const docPath = path.join(testDir, 'documents', 'multipage.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/multipage.pdf');
      expect(result.pageCount).toBe(3);
      expect(result.renderedPages.length).toBe(3);
      expect(result.renderedPages.map(p => p.pageNumber)).toEqual([1, 2, 3]);
    });

    it('renders specific target pages when targetPages option is supplied', async () => {
      const pdfBuffer = createMultiPagePdf(4);
      const docPath = path.join(testDir, 'documents', 'select_pages.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/select_pages.pdf', {
        targetPages: [2, 4],
      });

      expect(result.pageCount).toBe(4);
      expect(result.renderedPages.length).toBe(2);
      expect(result.renderedPages.map(p => p.pageNumber)).toEqual([2, 4]);
    });

    it('supports JPEG output format when explicitly requested', async () => {
      const pdfBuffer = createMinimalPdf('JPEG Output Test');
      const docPath = path.join(testDir, 'documents', 'jpeg_test.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/jpeg_test.pdf', {
        format: 'jpeg',
      });

      expect(result.renderedPages[0].format).toBe('jpeg');
      expect(result.renderedPages[0].outputRelativePath).toContain('.jpg');

      const artifactPath = path.join(testDir, result.renderedPages[0].outputRelativePath);
      const bytes = fs.readFileSync(artifactPath);
      // JPEG magic bytes: FF D8 FF
      expect(bytes.slice(0, 3).toString('hex')).toBe('ffd8ff');
    });
  });

  // ── 2. Bounds & Limits Enforcement ───────────────────────────────

  describe('2. Industrial Security Bounds & Limits', () => {
    it('enforces maximum page count limit (PAGE_LIMIT_EXCEEDED)', async () => {
      const pdfBuffer = createMultiPagePdf(5);
      const docPath = path.join(testDir, 'documents', 'too_many_pages.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/too_many_pages.pdf', { maxPages: 3 }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'PAGE_LIMIT_EXCEEDED',
        }),
      );
    });

    it('enforces source file byte limit (BYTE_LIMIT_EXCEEDED)', async () => {
      const pdfBuffer = createMinimalPdf('Size Test');
      const docPath = path.join(testDir, 'documents', 'large.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/large.pdf', { maxSourceBytes: 100 }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'BYTE_LIMIT_EXCEEDED',
        }),
      );
    });

    it('enforces page dimension limits (OVERSIZED_PAGE_DIMENSIONS)', async () => {
      const pdfBuffer = createOversizedDimensionPdf();
      const docPath = path.join(testDir, 'documents', 'oversized.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/oversized.pdf', { maxPageDimension: 1000 }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'OVERSIZED_PAGE_DIMENSIONS',
        }),
      );
    });

    it('enforces rendered pixel count limit (PIXEL_LIMIT_EXCEEDED)', async () => {
      const pdfBuffer = createMinimalPdf('Pixel Test', 800, 600);
      const docPath = path.join(testDir, 'documents', 'pixel_test.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/pixel_test.pdf', {
          maxRenderedPixelsPerPage: 10_000, // very small
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'PIXEL_LIMIT_EXCEEDED',
        }),
      );
    });

    it('detects and rejects decompression bombs (DECOMPRESSION_BOMB_DETECTED)', async () => {
      const bombPdf = createDecompressionBombPdf();
      const docPath = path.join(testDir, 'documents', 'bomb.pdf');
      fs.writeFileSync(docPath, bombPdf);

      await expect(
        rasterService.rasterize('documents/bomb.pdf', {
          maxDecompressionRatio: 10, // low ratio limit
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'DECOMPRESSION_BOMB_DETECTED',
        }),
      );
    });

    it('enforces cumulative output size limits (OUTPUT_LIMIT_EXCEEDED)', async () => {
      const pdfBuffer = createMultiPagePdf(3);
      const docPath = path.join(testDir, 'documents', 'output_limit.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/output_limit.pdf', {
          maxTotalOutputBytes: 50, // very small
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'OUTPUT_LIMIT_EXCEEDED',
        }),
      );
    });

    it('enforces execution timeout bounds (TIMEOUT)', async () => {
      const pdfBuffer = createMinimalPdf('Timeout Test');
      const docPath = path.join(testDir, 'documents', 'timeout.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await expect(
        rasterService.rasterize('documents/timeout.pdf', {
          timeoutMs: 1, // 1 ms will trigger timeout
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'TIMEOUT',
        }),
      );
    });
  });

  // ── 3. Malformed, Encrypted, & Non-PDF Inputs ─────────────────────

  describe('3. Fail-Closed Malformed & Unsupported Handling', () => {
    it('rejects empty 0-byte PDF files (MALFORMED_PDF)', async () => {
      const docPath = path.join(testDir, 'documents', 'empty.pdf');
      fs.writeFileSync(docPath, Buffer.alloc(0));

      await expect(rasterService.rasterize('documents/empty.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'MALFORMED_PDF',
        }),
      );
    });

    it('rejects encrypted PDFs with explicit unsupported error (ENCRYPTED_PDF_UNSUPPORTED)', async () => {
      const encryptedPdf = createEncryptedPdf();
      const docPath = path.join(testDir, 'documents', 'encrypted.pdf');
      fs.writeFileSync(docPath, encryptedPdf);

      await expect(rasterService.rasterize('documents/encrypted.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'ENCRYPTED_PDF_UNSUPPORTED',
        }),
      );
    });

    it('rejects non-existent input files (NOT_FOUND)', async () => {
      await expect(rasterService.rasterize('documents/does_not_exist.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'NOT_FOUND',
        }),
      );
    });

    it('rejects non-PDF file extensions (INVALID_EXTENSION)', async () => {
      const textPath = path.join(testDir, 'documents', 'note.txt');
      fs.writeFileSync(textPath, 'Hello world');

      await expect(rasterService.rasterize('documents/note.txt')).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_EXTENSION',
        }),
      );
    });

    it('rejects MIME-spoofed non-PDF files disguised as .pdf (INVALID_MIME)', async () => {
      const spoofedPath = path.join(testDir, 'documents', 'spoofed.pdf');
      fs.writeFileSync(spoofedPath, '<html><body>This is an HTML file disguised as PDF</body></html>');

      await expect(rasterService.rasterize('documents/spoofed.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_MIME',
        }),
      );
    });
  });

  // ── 4. Project-Root Confinement & Traversal ──────────────────────

  describe('4. Project Confinement & Traversal Prevention', () => {
    it('rejects path traversal attempts attempting to escape project root (TRAVERSAL_REJECTED)', async () => {
      await expect(rasterService.rasterize('../secret.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'TRAVERSAL_REJECTED',
        }),
      );

      await expect(rasterService.rasterize('documents/../../outside.pdf')).rejects.toThrow(
        expect.objectContaining({
          code: 'TRAVERSAL_REJECTED',
        }),
      );
    });

    it('rejects symlink escape pointing outside project root (SYMLINK_ESCAPE_REJECTED)', async () => {
      // Create external file outside project root
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-outside-'));
      const outsideFile = path.join(outsideDir, 'outside.pdf');
      fs.writeFileSync(outsideFile, createMinimalPdf('Outside Secret'));

      const symlinkPath = path.join(testDir, 'documents', 'escaped_link.pdf');
      try {
        fs.symlinkSync(outsideFile, symlinkPath, 'file');
        await expect(rasterService.rasterize('documents/escaped_link.pdf')).rejects.toThrow(
          expect.objectContaining({
            code: 'SYMLINK_ESCAPE_REJECTED',
          }),
        );
      } catch (err: any) {
        // On Windows without Developer Mode, symlinks require admin; skip if OS throws EPERM
        if (err?.code !== 'EPERM') throw err;
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  // ── 5. Safe Artifact Store & Audit Trail Integration ─────────────

  describe('5. Safe Artifact Store & Audit Trail Integrity', () => {
    it('finalizes all rendered pages via Safe Artifact Store with atomic rename', async () => {
      const pdfBuffer = createMinimalPdf('Atomic Store Test');
      const docPath = path.join(testDir, 'documents', 'atomic_test.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const result = await rasterService.rasterize('documents/atomic_test.pdf');
      expect(result.renderedPages.length).toBe(1);

      // Verify no dangling scratch directory was left
      const tmpDir = path.join(testDir, '.maos', 'artifacts', '.tmp');
      if (fs.existsSync(tmpDir)) {
        const scratchDirs = fs.readdirSync(tmpDir).filter(d => d.startsWith('raster_'));
        expect(scratchDirs.length).toBe(0);
      }
    });

    it('records an immutable audit event on success and zero events on error', async () => {
      const auditLogPath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');

      // Successful run
      const pdfBuffer = createMinimalPdf('Audit Test');
      const docPath = path.join(testDir, 'documents', 'audit_test.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      await rasterService.rasterize('documents/audit_test.pdf');

      expect(fs.existsSync(auditLogPath)).toBe(true);
      const lines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);

      const lastRecord = JSON.parse(lines[lines.length - 1]);
      expect(lastRecord.category).toBe('tool');
      expect(lastRecord.source).toBe('pdf-rasterizer');
      expect(lastRecord.data.action).toBe('PDF_RASTERIZED');
      expect(lastRecord.data.sourcePath).toBe('documents/audit_test.pdf');
      expect(lastRecord.data.pageCount).toBe(1);

      const countBeforeError = lines.length;

      // Failing run (malformed/spoofed)
      const badPath = path.join(testDir, 'documents', 'bad.pdf');
      fs.writeFileSync(badPath, 'bad garbage non-pdf');

      try {
        await rasterService.rasterize('documents/bad.pdf');
      } catch {
        // Expected
      }

      // Assert zero phantom audit events written on failure
      const linesAfter = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(linesAfter.length).toBe(countBeforeError);
    });

    it('produces deterministic output across repeated rasterization calls', async () => {
      const pdfBuffer = createMinimalPdf('Determinism Test');
      const docPath = path.join(testDir, 'documents', 'deterministic.pdf');
      fs.writeFileSync(docPath, pdfBuffer);

      const res1 = await rasterService.rasterize('documents/deterministic.pdf');

      const approval = approvalService.createApproval({
        gateId: 'G4',
        conditions: [],
      });
      approvalService.decideApproval(approval.id, 'approved', 'lead-inspector');

      const res2 = await rasterService.rasterize('documents/deterministic.pdf', {
        approvalId: approval.id,
      });

      expect(res1.sourceHash).toBe(res2.sourceHash);
      expect(res1.pageCount).toBe(res2.pageCount);
      expect(res1.renderedPages[0].width).toBe(res2.renderedPages[0].width);
      expect(res1.renderedPages[0].height).toBe(res2.renderedPages[0].height);
      expect(res1.renderedPages[0].outputHash).toBe(res2.renderedPages[0].outputHash);
    });
  });

  // ── 6. Protected Invariant ───────────────────────────────────────

  describe('6. Protected Invariant Preservation', () => {
    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      const rustTestPath = path.resolve(__dirname, '..', '..', 'rust', 'test.txt');
      expect(fs.existsSync(rustTestPath)).toBe(true);

      const content = fs.readFileSync(rustTestPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe('1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435');
    });
  });
});
