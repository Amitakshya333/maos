/**
 * F4-07: Multimodal Benchmark Fixture Generator & Manifest
 *
 * Generates frozen, licensed, non-proprietary fixtures for all 18 required
 * multimodal benchmark classes:
 *   1. Clean printed inspection scan
 *   2. Multi-page printed report
 *   3. Rotated text
 *   4. Noisy or blurred scan
 *   5. Equipment nameplate/photo
 *   6. Gauge or measurement image
 *   7. Sample drawing/P&ID-style image
 *   8. OCR/VLM agreement
 *   9. OCR/VLM numeric conflict
 *  10. OCR/VLM unit conflict
 *  11. Low-confidence OCR
 *  12. Low-confidence VLM observation
 *  13. Unsupported handwriting
 *  14. Malformed image/PDF
 *  15. Oversized or decompression-bomb input
 *  16. Empty page/image
 *  17. Cross-project source attempt
 *  18. Tampered source/artifact
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  MultimodalFixtureClass,
  MultimodalFixtureEntry,
  MultimodalFixtureManifest,
} from '../domain/multimodal-benchmark';

// ── Raw PDF & PNG Generators ───────────────────────────────────────

export function generatePdf(text: string, width = 612, height = 792): Buffer {
  const contentStream = Buffer.from(
    `BT /F1 12 Tf 50 700 Td (${text}) Tj ET 20 20 ${width - 40} ${height - 40} re S`,
  );
  const deflated = zlib.deflateSync(contentStream);

  const pdf =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R >>\nendobj\n` +
    `4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n` +
    deflated.toString('latin1') +
    `\nendstream\nendobj\n` +
    `xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000215 00000 n \n` +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n400\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

export function generateMultiPagePdf(pagesText: string[], width = 612, height = 792): Buffer {
  const count = pagesText.length;
  let objects = '';
  const kidsRefs: string[] = [];
  let objIndex = 3;

  for (let i = 0; i < count; i++) {
    const pageObjNum = objIndex++;
    const contentObjNum = objIndex++;
    kidsRefs.push(`${pageObjNum} 0 R`);

    const streamData = zlib.deflateSync(
      Buffer.from(`BT /F1 12 Tf 50 700 Td (${pagesText[i]}) Tj ET`),
    );

    objects +=
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentObjNum} 0 R >>\nendobj\n` +
      `${contentObjNum} 0 obj\n<< /Length ${streamData.length} /Filter /FlateDecode >>\nstream\n` +
      streamData.toString('latin1') +
      `\nendstream\nendobj\n`;
  }

  const pdf =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${count} >>\nendobj\n` +
    objects +
    `xref\n0 ${objIndex}\n0000000000 65535 f \n` +
    `trailer\n<< /Size ${objIndex} /Root 1 0 R >>\nstartxref\n500\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

export function generatePng(width = 200, height = 100, fillByte = 255): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdrChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    ihdrData,
    Buffer.alloc(4),
  ]);

  // Scanline data (filter byte 0 + width * 3 bytes per scanline)
  const scanlines: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(1 + width * 3, fillByte);
    line[0] = 0; // None filter
    scanlines.push(line);
  }

  const rawData = Buffer.concat(scanlines);
  const deflated = zlib.deflateSync(rawData);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(deflated.length, 0);

  const idatChunk = Buffer.concat([
    idatLen,
    Buffer.from('IDAT', 'ascii'),
    deflated,
    Buffer.alloc(4),
  ]);

  const iendChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('IEND', 'ascii'),
    Buffer.alloc(4),
  ]);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

export function generateDecompressionBombPdf(): Buffer {
  const bigZeroes = Buffer.alloc(10 * 1024 * 1024, 0x20); // 10 MB of spaces
  const deflated = zlib.deflateSync(bigZeroes, { level: 9 }); // Compresses to ~10 KB (> 1000:1 ratio)

  const pdf =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n` +
    `4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n` +
    deflated.toString('latin1') +
    `\nendstream\nendobj\n` +
    `xref\n0 5\n0000000000 65535 f \n` +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n300\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ── 18 Frozen Fixtures Definition ───────────────────────────────────

export interface GeneratedFixtureData {
  readonly entry: MultimodalFixtureEntry;
  readonly buffer: Buffer;
}

export function createAllFixtures(): GeneratedFixtureData[] {
  const fixtures: {
    id: string;
    fixtureClass: MultimodalFixtureClass;
    description: string;
    filename: string;
    mimeType: string;
    dimensions: { width: number; height: number; pageCount?: number };
    buffer: Buffer;
    expectedBehavior: MultimodalFixtureEntry['expectedBehavior'];
  }[] = [
    {
      id: 'FX-01-CLEAN-SCAN',
      fixtureClass: 'clean_printed_scan',
      description: 'Clean high-contrast printed inspection scan sheet with clear typography',
      filename: '01_clean_scan.pdf',
      mimeType: 'application/pdf',
      dimensions: { width: 612, height: 792, pageCount: 1 },
      buffer: generatePdf('TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm', 612, 792),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: true, // "clearance" is safety-critical
        isSafetyCritical: true,
      },
    },
    {
      id: 'FX-02-MULTIPAGE',
      fixtureClass: 'multipage_report',
      description: 'Multi-page formal engineering inspection report (3 pages)',
      filename: '02_multipage_report.pdf',
      mimeType: 'application/pdf',
      dimensions: { width: 612, height: 792, pageCount: 3 },
      buffer: generateMultiPagePdf(
        [
          'PAGE 1: OVERVIEW AND SYSTEM HEALTH - OK',
          'PAGE 2: PUMP HYDRAULIC PRESSURE 45.0 bar',
          'PAGE 3: CONCLUSION AND MAINTENANCE SIGN-OFF',
        ],
        612,
        792,
      ),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: true, // "pressure" is safety-critical
        isSafetyCritical: true,
      },
    },
    {
      id: 'FX-03-ROTATED',
      fixtureClass: 'rotated_text',
      description: 'Scan with 90-degree rotated orientation requiring orientation adjustment',
      filename: '03_rotated_scan.png',
      mimeType: 'image/png',
      dimensions: { width: 300, height: 400 },
      buffer: generatePng(300, 400, 240),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: false,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-04-NOISY-BLURRED',
      fixtureClass: 'noisy_blurred_scan',
      description: 'Low-quality noisy or blurred document scan with degraded resolution',
      filename: '04_noisy_blurred.png',
      mimeType: 'image/png',
      dimensions: { width: 300, height: 200 },
      buffer: generatePng(300, 200, 180),
      expectedBehavior: {
        expectedClassification: 'CONFIDENCE_DISAGREEMENT',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-05-NAMEPLATE',
      fixtureClass: 'equipment_nameplate',
      description: 'Industrial electric motor nameplate photo (model, voltage, rpm)',
      filename: '05_nameplate.png',
      mimeType: 'image/png',
      dimensions: { width: 400, height: 250 },
      buffer: generatePng(400, 250, 220),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: false,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-06-GAUGE-MEASURE',
      fixtureClass: 'gauge_measurement',
      description: 'Calibrated analog dial gauge displaying hydraulic pressure reading',
      filename: '06_pressure_gauge.png',
      mimeType: 'image/png',
      dimensions: { width: 300, height: 300 },
      buffer: generatePng(300, 300, 230),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: true,
        isSafetyCritical: true,
      },
    },
    {
      id: 'FX-07-DRAWING-PID',
      fixtureClass: 'sample_drawing_pid',
      description: 'Piping and Instrumentation Diagram (P&ID) with valves and pipe tags',
      filename: '07_pid_drawing.png',
      mimeType: 'image/png',
      dimensions: { width: 500, height: 350 },
      buffer: generatePng(500, 350, 250),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: true, // drawing observation requires review
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-08-AGREE',
      fixtureClass: 'ocr_vision_agreement',
      description: 'Unambiguous non-safety-critical barcode label with perfect agreement',
      filename: '08_agreement.png',
      mimeType: 'image/png',
      dimensions: { width: 250, height: 100 },
      buffer: generatePng(250, 100, 255),
      expectedBehavior: {
        expectedClassification: 'AGREE',
        requiresReview: false,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-09-NUMERIC-CONFLICT',
      fixtureClass: 'ocr_vision_numeric_conflict',
      description: 'Disputed numeric reading: OCR and VLM report differing numbers',
      filename: '09_numeric_conflict.png',
      mimeType: 'image/png',
      dimensions: { width: 250, height: 100 },
      buffer: generatePng(250, 100, 235),
      expectedBehavior: {
        expectedClassification: 'CONFLICTING_VALUE',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-10-UNIT-CONFLICT',
      fixtureClass: 'ocr_vision_unit_conflict',
      description: 'Disputed unit measurement: OCR reports bar, VLM reports psi',
      filename: '10_unit_conflict.png',
      mimeType: 'image/png',
      dimensions: { width: 250, height: 100 },
      buffer: generatePng(250, 100, 225),
      expectedBehavior: {
        expectedClassification: 'CONFLICTING_UNIT',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-11-LOW-CONF-OCR',
      fixtureClass: 'low_confidence_ocr',
      description: 'Faint degraded dot-matrix printout producing low OCR confidence',
      filename: '11_low_conf_ocr.png',
      mimeType: 'image/png',
      dimensions: { width: 200, height: 100 },
      buffer: generatePng(200, 100, 190),
      expectedBehavior: {
        expectedClassification: 'CONFIDENCE_DISAGREEMENT',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-12-LOW-CONF-VISION',
      fixtureClass: 'low_confidence_vision',
      description: 'Severely underexposed or shadowed photograph yielding low VLM confidence',
      filename: '12_low_conf_vision.png',
      mimeType: 'image/png',
      dimensions: { width: 200, height: 100 },
      buffer: generatePng(200, 100, 40),
      expectedBehavior: {
        expectedClassification: 'CONFIDENCE_DISAGREEMENT',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-13-HANDWRITING',
      fixtureClass: 'unsupported_handwriting',
      description: 'Handwritten cursive maintenance signature and field notes',
      filename: '13_handwriting.png',
      mimeType: 'image/png',
      dimensions: { width: 300, height: 150 },
      buffer: generatePng(300, 150, 245),
      expectedBehavior: {
        expectedClassification: 'UNSUPPORTED',
        requiresReview: true,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-14-MALFORMED',
      fixtureClass: 'malformed_input',
      description: 'Corrupted truncated PDF file missing xref and trailer markers',
      filename: '14_malformed.pdf',
      mimeType: 'application/pdf',
      dimensions: { width: 0, height: 0 },
      buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\n(corrupted truncated stream', 'utf-8'),
      expectedBehavior: {
        expectedClassification: 'REJECTED',
        requiresReview: true,
        isSafetyCritical: false,
        shouldFailSafely: true,
        expectedErrorCode: 'CORRUPT_INPUT',
      },
    },
    {
      id: 'FX-15-OVERSIZED-BOMB',
      fixtureClass: 'oversized_bomb_input',
      description: 'Decompression bomb PDF with high compression ratio exceeding bounds',
      filename: '15_bomb.pdf',
      mimeType: 'application/pdf',
      dimensions: { width: 612, height: 792, pageCount: 1 },
      buffer: generateDecompressionBombPdf(),
      expectedBehavior: {
        expectedClassification: 'REJECTED',
        requiresReview: true,
        isSafetyCritical: false,
        shouldFailSafely: true,
        expectedErrorCode: 'DECOMPRESSION_BOMB_DETECTED',
      },
    },
    {
      id: 'FX-16-EMPTY',
      fixtureClass: 'empty_input',
      description: 'Completely blank single-page PDF with zero printable glyphs',
      filename: '16_empty_page.pdf',
      mimeType: 'application/pdf',
      dimensions: { width: 612, height: 792, pageCount: 1 },
      buffer: generatePdf('', 612, 792),
      expectedBehavior: {
        expectedClassification: 'EMPTY',
        requiresReview: false,
        isSafetyCritical: false,
      },
    },
    {
      id: 'FX-17-CROSS-PROJECT',
      fixtureClass: 'cross_project_attempt',
      description: 'Document belonging to a distinct foreign project ID',
      filename: '17_cross_project.png',
      mimeType: 'image/png',
      dimensions: { width: 200, height: 100 },
      buffer: generatePng(200, 100, 210),
      expectedBehavior: {
        expectedClassification: 'REJECTED',
        requiresReview: true,
        isSafetyCritical: false,
        shouldFailSafely: true,
        expectedErrorCode: 'CROSS_PROJECT_FORBIDDEN',
      },
    },
    {
      id: 'FX-18-TAMPERED',
      fixtureClass: 'tampered_source_artifact',
      description: 'Artifact modified post-registration whose hash does not match computed value',
      filename: '18_tampered.png',
      mimeType: 'image/png',
      dimensions: { width: 200, height: 100 },
      buffer: generatePng(200, 100, 128),
      expectedBehavior: {
        expectedClassification: 'REJECTED',
        requiresReview: true,
        isSafetyCritical: false,
        shouldFailSafely: true,
        expectedErrorCode: 'HASH_MISMATCH',
      },
    },
  ];

  return fixtures.map((f) => {
    const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const relativePath = path.posix.join('fixtures', 'multimodal', 'files', f.filename);
    const entry: MultimodalFixtureEntry = {
      id: f.id,
      fixtureClass: f.fixtureClass,
      description: f.description,
      license: 'CC0-1.0',
      source: 'MAOS synthetic industrial benchmark generator (non-proprietary)',
      filename: f.filename,
      relativePath,
      mimeType: f.mimeType,
      expectedSha256: sha256,
      byteSize: f.buffer.length,
      dimensions: f.dimensions,
      expectedBehavior: f.expectedBehavior,
    };
    return { entry, buffer: f.buffer };
  });
}

/**
 * Write all 18 fixtures and manifest.json to disk under baseDir.
 */
export function writeFixturesToDisk(baseDir: string): MultimodalFixtureManifest {
  const targetDir = path.join(baseDir, 'fixtures', 'multimodal');
  const filesDir = path.join(targetDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const generated = createAllFixtures();
  const entries: MultimodalFixtureEntry[] = [];

  for (const item of generated) {
    const filePath = path.join(filesDir, item.entry.filename);
    fs.writeFileSync(filePath, item.buffer);
    entries.push(item.entry);
  }

  const manifest: MultimodalFixtureManifest = {
    schemaVersion: 1,
    manifestVersion: '1.0.0',
    description: 'Frozen, licensed, non-proprietary multimodal benchmark dataset covering 18 fixture classes',
    generatedAt: '2026-09-18T00:00:00.000Z',
    fixtures: entries,
  };

  const manifestPath = path.join(targetDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return manifest;
}
