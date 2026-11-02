/**
 * TASK DEV-A-01 (Dev A): ocr_document tool (OcrService wrapper).
 *
 * Reads a scanned document or PDF under the evidence root (path checks
 * reuse the isWithin/isStrictlyWithin pattern) and returns extracted text.
 * Resolution order (documented, honest):
 *   1. PDFs: embedded text-layer extraction first (deterministic; the demo
 *      scan PDF carries a real text layer, so no OCR is needed for it).
 *   2. Real `OcrService.ocrDocumentSync` for true scans / images.
 *   3. Honest unavailable/error results when neither works. Nothing is
 *      fabricated: empty extraction reports that, engine failures surface
 *      as errors, missing service as unavailable.
 * Non-consequential (read-only).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { inflateSync } from 'zlib';
import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { readEvidenceText, resolveEvidencePath } from './common';
import { auditToolExecution, type RingToolDeps } from './tool-deps';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Decode PDF string escapes (mirrors kb-ingestion decodePdfString). */
function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}
function extractPdfTextOperands(btContent: string): string {
  const parts: string[] = [];
  const tjPattern = /\(([^)]*)\)\s*(?:Tj|'|")/g;
  let m: RegExpExecArray | null;
  while ((m = tjPattern.exec(btContent)) !== null) {
    parts.push(decodePdfString(m[1]));
  }
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrayPattern.exec(btContent)) !== null) {
    const stringPattern = /\(([^)]*)\)/g;
    let sm: RegExpExecArray | null;
    while ((sm = stringPattern.exec(m[1])) !== null) {
      parts.push(decodePdfString(sm[1]));
    }
  }
  return parts.join('');
}

/**
 * Deterministic embedded-text extraction for PDFs (stdlib + zlib only).
 * Returns null when the file has no usable text layer.
 */
function extractPdfTextLayer(abs: string): string | null {
  const bytes = fs.readFileSync(abs);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  if (bytes.includes(Buffer.from('/Encrypt'))) {
    throw new Error('OCR_ENCRYPTED: PDF appears to be encrypted; text cannot be extracted without decryption.');
  }
  const latin = bytes.toString('latin1');
  const segments: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm: RegExpExecArray | null;
  while ((sm = streamPattern.exec(latin)) !== null) {
    const dictStart = Math.max(0, sm.index - 400);
    const dict = latin.slice(dictStart, sm.index);
    const raw = Buffer.from(sm[1], 'latin1');
    let decoded: string | null = null;
    if (/\/Fl(ateDecode)?\b/.test(dict)) {
      try {
        decoded = inflateSync(raw).toString('latin1');
      } catch {
        decoded = null;
      }
    } else {
      decoded = sm[1];
    }
    if (decoded) segments.push(decoded);
  }
  const textSegments: string[] = [];
  const textObjectPattern = /BT\s([\s\S]*?)ET/g;
  for (const seg of segments) {
    let tm: RegExpExecArray | null;
    while ((tm = textObjectPattern.exec(seg)) !== null) {
      const text = extractPdfTextOperands(tm[1]);
      if (text.trim()) textSegments.push(text);
    }
  }
  // Fallback: raw Tj operands outside BT/ET (minimal synthetic fixtures).
  if (textSegments.length === 0) {
    const joined = segments.join('\n');
    const fallback = extractPdfTextOperands(joined);
    if (fallback.trim()) textSegments.push(fallback);
  }
  const full = textSegments.join('\n').trim();
  return full ? full : null;
}

export function createOcrDocumentTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'ocr_document',
    description:
      'Extract text from a scanned document or PDF under the evidence root via the OCR service (embedded text layer first, real OCR for true scans). Honest unavailable result when OCR cannot run.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Document path relative to the evidence root (PDF or image).' },
      },
      required: ['path'],
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      const requested = typeof toolArgs.path === 'string' ? toolArgs.path : '';
      let resolved: { abs: string; rel: string };
      try {
        resolved = resolveEvidencePath(toolCtx.evidenceRoot, toolCtx.projectRoot, requested);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const ext = path.extname(resolved.abs).toLowerCase();
      // 1. PDF text layer: deterministic, exact, no engine needed.
      if (ext === '.pdf') {
        try {
          if (fs.statSync(resolved.abs).size <= MAX_PDF_BYTES) {
            const layered = extractPdfTextLayer(resolved.abs);
            if (layered) {
              const fileBytes = fs.readFileSync(resolved.abs);
              const out = {
                ok: true,
                path: resolved.rel,
                text: truncate(layered, 6000),
                truncated: layered.length > 6000,
                pages: 1,
                method: 'text-layer',
                source: 'embedded-pdf-text',
                bytes: fileBytes.length,
                sha256: crypto.createHash('sha256').update(fileBytes).digest('hex'),
                disclaimer: 'Text extracted deterministically from the embedded PDF text layer; no OCR engine was needed.',
              };
              auditToolExecution(deps, toolCtx, 'ocr_document', true, { path: resolved.rel, method: 'text-layer' });
              return out;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith('OCR_ENCRYPTED')) return { ok: false, error: message };
          // Otherwise fall through to the real OCR engine.
        }
      } else {
        // Non-PDF evidence text that is directly readable needs no OCR engine.
        if (['.txt', '.md', '.json'].includes(ext)) {
          try {
            const read = readEvidenceText(resolved.abs, resolved.rel);
            const out = {
              ok: true,
              path: resolved.rel,
              text: truncate(read.text, 6000),
              truncated: read.text.length > 6000,
              pages: 1,
              method: 'plain-text',
              source: 'evidence-file',
              bytes: read.bytes,
              sha256: read.sha256,
              disclaimer: 'Plain evidence text read directly; no OCR engine was needed.',
            };
            auditToolExecution(deps, toolCtx, 'ocr_document', true, { path: resolved.rel, method: 'plain-text' });
            return out;
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }
      // 2. Real OCR engine for true scans / images / layer-less PDFs.
      if (!deps.ocrService) {
        return {
          ok: true,
          available: false,
          answered: false,
          path: resolved.rel,
          message: 'OCR is unavailable: no OCR service is configured for this run and the document has no directly extractable text. No text was fabricated.',
        };
      }
      try {
        const doc = deps.ocrService.ocrDocumentSync(resolved.rel);
        const text = typeof doc.text === 'string' ? doc.text : '';
        if (!text.trim()) {
          return {
            ok: true,
            available: true,
            answered: false,
            path: resolved.rel,
            totalPages: doc.totalPages,
            message: 'OCR completed but extracted no text from ' + resolved.rel + '. No text was fabricated.',
          };
        }
        const out = {
          ok: true,
          available: true,
          answered: true,
          path: resolved.rel,
          text: truncate(text, 6000),
          truncated: text.length > 6000,
          totalPages: doc.totalPages,
          averageConfidence: doc.averageConfidence,
          warnings: doc.warnings,
          method: 'ocr-engine',
          source: 'ocr-service',
          disclaimer: 'Text produced by the OCR engine from a scanned document; verify against the source image on camera.',
        };
        auditToolExecution(deps, toolCtx, 'ocr_document', true, { path: resolved.rel, method: 'ocr-engine' });
        return out;
      } catch (err) {
        return { ok: false, error: 'OCR engine failed on ' + resolved.rel + ': ' + (err instanceof Error ? err.message : String(err)) };
      }
    },
  };
}
