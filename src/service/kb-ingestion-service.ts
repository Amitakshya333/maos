/**
 * F5-02: Normalized Knowledge-Base Document Ingestion Service
 *
 * Ingests approved corpus documents and produces deterministic,
 * provenance-preserving text chunks for later embedding/indexing (F5-03/F5-04).
 *
 * Pipeline:
 *   validate path → resolve MIME → check limits → compute source SHA-256
 *   → extract text (per type) → normalize text → chunk → injection scan
 *   → persist manifest atomically → append audit event
 *
 * Invariants:
 *   1. Documents are DATA only — never executed, never treated as instructions.
 *   2. Original source files are NEVER modified or deleted.
 *   3. Identical source bytes + policy produce identical chunks and IDs.
 *   4. Changed hash/size/policy forces re-ingestion (stale data never served).
 *   5. All paths are project-root confined (no traversal, no symlinks out).
 *   6. Cross-project isolation enforced at every entry point.
 *   7. Prompt-injection patterns are detected, labelled, and quarantined.
 *   8. Malformed/encrypted/truncated files fail closed with typed errors.
 *   9. Persistence uses crash-safe temp → fsync → atomic rename.
 *  10. Audit events are appended only after successful finalization.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  // F5-01 policy types and validators
  KbCorpusPolicy,
  KbCorpusDocumentEntry,
  KbDocumentMimeType,
  KbDocumentStatus,
  KbQuarantineReason,
  KbReindexReason,
  KbQuarantineInfo,
  KbInjectionMatch,
  KbCorpusLimits,
  KbChunkingConfig,
  KB_MAX_SOURCE_BYTES,
  KB_MAX_PATH_LENGTH,
  KB_SUPPORTED_DOCUMENT_TYPES,
  validateCorpusPath,
  canonicalizeCorpusPath,
  resolveDocumentMimeType,
  isSupportedMimeType,
  checkDuplicate,
  needsReindex,
  scanForInjection,
  shouldQuarantine,
  validateDocumentLimits,
  validateCorpusCapacity,
  validateProjectIsolation,
  validateCorpusPolicy,
  createDefaultCorpusPolicy,
  // F5-02 domain types & validators
  KbTextChunk,
  KbIngestionResult,
  KbIngestionInput as BaseKbIngestionInput,
  KbIngestionManifest,
  KbPersistedDocumentRecord,
  KbIngestionErrorCode,
  KbIngestionError,
  EXTRACTION_ENGINE,
  EXTRACTION_VERSION,
  validateKbTextChunk,
  validateKbIngestionManifest,
} from '../domain';
import { AuditService } from './audit-service';
import { OcrService } from './ocr-service';
import { PdfRasterService } from './pdf-raster-service';

export {
  KbTextChunk,
  KbIngestionResult,
  KbIngestionManifest,
  KbPersistedDocumentRecord,
  KbIngestionErrorCode,
  KbIngestionError,
  EXTRACTION_ENGINE,
  EXTRACTION_VERSION,
};

export interface KbIngestionInput extends BaseKbIngestionInput {
  /** Force re-ingestion even if source hash is unchanged. */
  readonly forceReingest?: boolean;
}

// ── Text Extraction Types ───────────────────────────────────────────

export interface ExtractedText {
  readonly text: string;
  readonly pages: readonly ExtractedPage[];
  readonly warnings: string[];
}

export interface ExtractedPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly charOffsetStart: number;
  readonly charOffsetEnd: number;
  readonly sectionHeading: string | null;
}

// ── Text Extraction Implementations ─────────────────────────────────

function extractText(
  content: Buffer,
  mimeType: KbDocumentMimeType,
  filePath: string,
): ExtractedText {
  switch (mimeType) {
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      return extractPlainText(content, filePath);
    case 'application/pdf':
      return extractPdfText(content, filePath);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocxText(content, filePath);
    default:
      throw new KbIngestionError(
        'UNSUPPORTED_TYPE',
        `No extraction engine for MIME type: ${mimeType}`,
        { mimeType, filePath },
      );
  }
}

/**
 * Plain text / CSV / Markdown extraction.
 * Single-page document; detect section headings from markdown.
 */
function extractPlainText(content: Buffer, filePath: string): ExtractedText {
  const warnings: string[] = [];
  let rawText: string;
  try {
    rawText = content.toString('utf-8');
  } catch {
    throw new KbIngestionError(
      'MALFORMED_DOCUMENT',
      'Failed to decode text content as UTF-8',
      { filePath },
    );
  }

  // Detect binary content
  if (hasBinaryBytes(content)) {
    throw new KbIngestionError(
      'MALFORMED_DOCUMENT',
      'File appears to contain binary data, not valid text',
      { filePath },
    );
  }

  if (rawText.trim().length === 0) {
    throw new KbIngestionError(
      'EMPTY_DOCUMENT',
      'Document contains no extractable text',
      { filePath },
    );
  }

  const sections = detectSections(rawText, filePath);
  const pages: ExtractedPage[] = [{
    pageNumber: 1,
    text: rawText,
    charOffsetStart: 0,
    charOffsetEnd: rawText.length,
    sectionHeading: sections.length > 0 ? sections[0] : null,
  }];

  return { text: rawText, pages, warnings };
}

/**
 * PDF text extraction — uses text content layer.
 * For scanned PDFs, text may be empty (would need OCR from F4).
 */
function extractPdfText(content: Buffer, filePath: string): ExtractedText {
  const warnings: string[] = [];

  // Validate PDF magic bytes
  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new KbIngestionError(
      'MALFORMED_DOCUMENT',
      'File does not have valid PDF magic bytes (%PDF-)',
      { filePath },
    );
  }

  // Check for encryption markers
  if (content.includes(Buffer.from('/Encrypt'))) {
    throw new KbIngestionError(
      'ENCRYPTED_DOCUMENT',
      'PDF appears to be encrypted — cannot extract text without decryption',
      { filePath },
    );
  }

  const rawString = content.toString('latin1');
  const textSegments: string[] = [];
  const pageTexts: ExtractedPage[] = [];

  // Find text between BT and ET markers (PDF text objects)
  const textObjectPattern = /BT\s([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;

  // Count pages from /Type /Page markers
  const pageCount = (rawString.match(/\/Type\s*\/Page[^s]/g) || []).length;

  while ((match = textObjectPattern.exec(rawString)) !== null) {
    const textContent = extractPdfTextOperands(match[1]);
    if (textContent.trim().length > 0) {
      textSegments.push(textContent);
    }
  }

  const fullText = textSegments.join('\n');

  if (fullText.trim().length === 0) {
    // Scanned PDF with no text layer
    warnings.push('PDF has no extractable text layer — may be a scanned document requiring OCR');
    for (let p = 1; p <= Math.max(1, pageCount); p++) {
      pageTexts.push({
        pageNumber: p,
        text: '',
        charOffsetStart: 0,
        charOffsetEnd: 0,
        sectionHeading: null,
      });
    }
    return { text: '', pages: pageTexts, warnings };
  }

  const effectivePages = Math.max(1, pageCount);
  const textPerPage = Math.ceil(fullText.length / effectivePages);
  for (let p = 0; p < effectivePages; p++) {
    const start = p * textPerPage;
    const end = Math.min((p + 1) * textPerPage, fullText.length);
    const pageText = fullText.slice(start, end);
    pageTexts.push({
      pageNumber: p + 1,
      text: pageText,
      charOffsetStart: start,
      charOffsetEnd: end,
      sectionHeading: null,
    });
  }

  return { text: fullText, pages: pageTexts, warnings };
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
    const arrayContent = m[1];
    const stringPattern = /\(([^)]*)\)/g;
    let sm: RegExpExecArray | null;
    while ((sm = stringPattern.exec(arrayContent)) !== null) {
      parts.push(decodePdfString(sm[1]));
    }
  }

  return parts.join('');
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * DOCX text extraction — reads XML content from OOXML zip.
 * Safe local fallback using standard zip/XML parsing.
 * Does NOT download any external libraries at runtime.
 */
function extractDocxText(content: Buffer, filePath: string): ExtractedText {
  const warnings: string[] = [];

  if (content.length < 4 || content[0] !== 0x50 || content[1] !== 0x4B) {
    throw new KbIngestionError(
      'MALFORMED_DOCUMENT',
      'File does not have valid DOCX/ZIP magic bytes (PK)',
      { filePath },
    );
  }

  if (content.includes(Buffer.from('EncryptedPackage'))) {
    throw new KbIngestionError(
      'ENCRYPTED_DOCUMENT',
      'DOCX appears to be encrypted — cannot extract text',
      { filePath },
    );
  }

  const documentXml = extractZipEntry(content, 'word/document.xml');
  if (!documentXml) {
    throw new KbIngestionError(
      'MALFORMED_DOCUMENT',
      'DOCX missing word/document.xml — not a valid Word document',
      { filePath },
    );
  }

  const xmlString = documentXml.toString('utf-8');
  const paragraphs: string[] = [];
  const sectionHeadings: string[] = [];

  const paraPattern = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;

  while ((pm = paraPattern.exec(xmlString)) !== null) {
    const paraXml = pm[0];
    const paraTexts: string[] = [];
    const tPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tPattern.exec(paraXml)) !== null) {
      paraTexts.push(tm[1]);
    }
    const paraText = paraTexts.join('');

    if (paraXml.includes('<w:pStyle') && paraXml.match(/w:val="Heading/)) {
      sectionHeadings.push(paraText);
    }

    if (paraText.length > 0) {
      paragraphs.push(paraText);
    }
  }

  const fullText = paragraphs.join('\n');

  if (fullText.trim().length === 0) {
    throw new KbIngestionError(
      'EMPTY_DOCUMENT',
      'DOCX contains no extractable text',
      { filePath },
    );
  }

  const pages: ExtractedPage[] = [{
    pageNumber: 1,
    text: fullText,
    charOffsetStart: 0,
    charOffsetEnd: fullText.length,
    sectionHeading: sectionHeadings.length > 0 ? sectionHeadings[0] : null,
  }];

  if (sectionHeadings.length > 0) {
    warnings.push(`Detected ${sectionHeadings.length} section heading(s)`);
  }

  return { text: fullText, pages, warnings };
}

function extractZipEntry(zipBuffer: Buffer, entryName: string): Buffer | null {
  const eocdOffset = findEOCD(zipBuffer);
  if (eocdOffset < 0) return null;

  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const numEntries = zipBuffer.readUInt16LE(eocdOffset + 10);

  let pos = cdOffset;
  for (let i = 0; i < numEntries && pos < cdOffset + cdSize; i++) {
    if (zipBuffer.readUInt32LE(pos) !== 0x02014b50) break;

    const nameLen = zipBuffer.readUInt16LE(pos + 28);
    const extraLen = zipBuffer.readUInt16LE(pos + 30);
    const commentLen = zipBuffer.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);
    const name = zipBuffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');

    if (name === entryName) {
      const localPos = localHeaderOffset;
      if (zipBuffer.readUInt32LE(localPos) !== 0x04034b50) return null;

      const compressionMethod = zipBuffer.readUInt16LE(localPos + 8);
      const compressedSize = zipBuffer.readUInt32LE(localPos + 18);
      const localNameLen = zipBuffer.readUInt16LE(localPos + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localPos + 28);
      const dataStart = localPos + 30 + localNameLen + localExtraLen;

      if (compressionMethod === 0) {
        return zipBuffer.subarray(dataStart, dataStart + compressedSize);
      } else if (compressionMethod === 8) {
        try {
          const { inflateRawSync } = require('zlib') as typeof import('zlib');
          return inflateRawSync(zipBuffer.subarray(dataStart, dataStart + compressedSize));
        } catch {
          return null;
        }
      }
      return null;
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function findEOCD(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ── Text Normalization ──────────────────────────────────────────────

export function normalizeText(raw: string): string {
  return raw
    .normalize('NFC')           // Stable Unicode NFC
    .replace(/\r\n/g, '\n')     // CRLF → LF
    .replace(/\r/g, '\n')       // CR → LF
    .replace(/[\t ]+/g, ' ')    // Collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n') // Collapse excessive blank lines
    .replace(/ +\n/g, '\n')     // Trim trailing spaces on lines
    .replace(/\n +/g, '\n');    // Trim leading spaces on lines
}

function detectSections(text: string, filePath: string): string[] {
  const headings: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.markdown') {
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        headings.push(match[2].trim());
      }
    }
  }

  return headings;
}

function hasBinaryBytes(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) return true;
  }
  return false;
}

// ── Deterministic Chunking ──────────────────────────────────────────

export function chunkText(
  text: string,
  chunkSizeChars: number,
  overlapChars: number,
): Array<{ text: string; charOffsetStart: number; charOffsetEnd: number }> {
  if (text.length === 0) return [];
  if (text.length <= chunkSizeChars) {
    return [{ text, charOffsetStart: 0, charOffsetEnd: text.length }];
  }

  const chunks: Array<{ text: string; charOffsetStart: number; charOffsetEnd: number }> = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSizeChars, text.length);

    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(chunkSizeChars * 0.7), start);
      const lastParagraph = text.lastIndexOf('\n\n', end);
      if (lastParagraph > searchStart) {
        end = lastParagraph + 1;
      } else {
        const lastSentence = text.lastIndexOf('. ', end);
        if (lastSentence > searchStart) {
          end = lastSentence + 2;
        } else {
          const lastSpace = text.lastIndexOf(' ', end);
          if (lastSpace > searchStart) {
            end = lastSpace + 1;
          }
        }
      }
    }

    chunks.push({
      text: text.slice(start, end),
      charOffsetStart: start,
      charOffsetEnd: end,
    });

    const advance = end - start - overlapChars;
    if (advance <= 0) {
      start = end;
    } else {
      start += advance;
    }
  }

  return chunks;
}

export function generateChunkId(sourceHash: string, chunkIndex: number): string {
  const input = `${sourceHash}:${chunkIndex}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export function generateDocumentId(projectId: string, canonicalPath: string): string {
  const input = `${projectId}:${canonicalPath}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ── Path Security ───────────────────────────────────────────────────

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveAndValidatePath(
  sourcePath: string,
  projectRoot: string,
): { absolutePath: string; canonicalPath: string } {
  const pathResult = validateCorpusPath(sourcePath);
  if (!pathResult.valid) {
    throw new KbIngestionError(
      'INVALID_PATH',
      `Invalid source path: ${pathResult.errors.join('; ')}`,
      { sourcePath },
    );
  }

  const canonicalRelative = canonicalizeCorpusPath(sourcePath);
  const absolutePath = path.resolve(projectRoot, canonicalRelative);

  const resolvedProject = path.resolve(projectRoot);
  if (!isPathWithinRoot(absolutePath, resolvedProject)) {
    throw new KbIngestionError(
      'PATH_OUTSIDE_ROOT',
      'Resolved path escapes project root',
      { sourcePath, absolutePath, projectRoot: resolvedProject },
    );
  }

  let canonicalProject = resolvedProject;
  try {
    canonicalProject = fs.realpathSync(resolvedProject);
  } catch {
    // Keep the resolved root so the regular SOURCE_NOT_FOUND check remains authoritative.
  }

  let canonicalFile = absolutePath;
  try {
    canonicalFile = fs.realpathSync(absolutePath);
  } catch {
    // Missing files are reported by the regular SOURCE_NOT_FOUND check below.
  }

  if (!isPathWithinRoot(canonicalFile, canonicalProject)) {
    throw new KbIngestionError(
      'SYMLINK_ESCAPE',
      'Source file is a symlink/junction that escapes the project root',
      { sourcePath, absolutePath, realPath: canonicalFile, projectRoot: canonicalProject },
    );
  }

  return { absolutePath, canonicalPath: canonicalRelative };
}

// ── Ingestion Service ───────────────────────────────────────────────

export interface KbIngestionServiceOptions {
  skipAudit?: boolean;
  _mockExtraction?: (content: Buffer, mime: KbDocumentMimeType, path: string) => ExtractedText;
  _simulateInterruption?: 'before_persist' | 'before_audit';
}

export class KbIngestionService {
  private readonly kbDir: string;
  private readonly manifestPath: string;
  private readonly chunksDir: string;

  constructor(
    private readonly projectRoot: string,
    private readonly audit?: AuditService,
    private readonly ocr?: OcrService,
    private readonly pdfRaster?: PdfRasterService,
    private readonly options: KbIngestionServiceOptions = {},
  ) {
    this.kbDir = path.join(this.projectRoot, '.maos', 'kb');
    this.manifestPath = path.join(this.kbDir, 'ingestion-manifest.json');
    this.chunksDir = path.join(this.kbDir, 'chunks');
  }

  private ensureDirs(): void {
    for (const dir of [this.kbDir, this.chunksDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Ingest a single document into the knowledge base.
   */
  ingest(
    input: KbIngestionInput,
    policy: KbCorpusPolicy,
  ): KbIngestionResult {
    // 1. Validate policy
    const policyResult = validateCorpusPolicy(policy);
    if (!policyResult.valid) {
      throw new KbIngestionError(
        'POLICY_INVALID',
        `Invalid corpus policy: ${policyResult.errors.join('; ')}`,
      );
    }

    // 2. Project isolation
    if (policy.projectId !== input.projectId) {
      throw new KbIngestionError(
        'CROSS_PROJECT',
        `Policy project "${policy.projectId}" does not match input project "${input.projectId}"`,
      );
    }

    // 3. Path validation and resolution
    const { absolutePath, canonicalPath } = resolveAndValidatePath(
      input.sourcePath,
      this.projectRoot,
    );

    // 4. Check source exists and is a file
    if (!fs.existsSync(absolutePath)) {
      throw new KbIngestionError(
        'SOURCE_NOT_FOUND',
        `Source file not found: ${input.sourcePath}`,
        { absolutePath },
      );
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      throw new KbIngestionError(
        'SOURCE_IS_DIRECTORY',
        'Source path points to a directory, not a file',
        { sourcePath: input.sourcePath },
      );
    }

    // 5. MIME type resolution (fail-closed)
    const mimeType = resolveDocumentMimeType(input.sourcePath);
    if (!mimeType) {
      throw new KbIngestionError(
        'UNSUPPORTED_TYPE',
        `Unsupported file type: ${path.extname(input.sourcePath)}`,
        { sourcePath: input.sourcePath },
      );
    }

    // 6. Source size check
    if (stat.size > policy.limits.maxSourceBytes) {
      throw new KbIngestionError(
        'SOURCE_TOO_LARGE',
        `Source file (${stat.size} bytes) exceeds maximum (${policy.limits.maxSourceBytes} bytes)`,
        { sourcePath: input.sourcePath, size: stat.size, max: policy.limits.maxSourceBytes },
      );
    }

    // 7. Read source content
    const content = fs.readFileSync(absolutePath);

    // 8. Compute authoritative SHA-256
    const sourceHash = crypto.createHash('sha256').update(content).digest('hex');

    // 9. Verify expected hash if provided
    if (input.expectedHash && sourceHash.toLowerCase() !== input.expectedHash.toLowerCase()) {
      throw new KbIngestionError(
        'HASH_MISMATCH',
        `Source SHA-256 mismatch: expected ${input.expectedHash}, got ${sourceHash}`,
        { expected: input.expectedHash, actual: sourceHash },
      );
    }

    // 10. Check existing manifest for duplicates / re-ingestion
    const manifest = this.readManifest();
    const documentId = input.documentId || generateDocumentId(input.projectId, canonicalPath);
    let docVersion = 1;

    if (manifest) {
      const existing = manifest.entries[documentId];
      if (existing) {
        const hashChanged = existing.entry.sourceHash !== sourceHash;
        const sizeChanged = existing.entry.sourceBytes !== stat.size;
        const policyChanged = existing.entry.indexVersion < policy.policyVersion;
        const isStale = existing.entry.status === 'stale';
        const needsReingest = input.forceReingest || hashChanged || sizeChanged || policyChanged || isStale;

        if (!needsReingest) {
          throw new KbIngestionError(
            'ALREADY_INGESTED',
            'Document is already ingested with identical content',
            { documentId, sourceHash },
          );
        }

        docVersion = existing.entry.indexVersion + 1;
      }

      // Corpus capacity check
      const currentCount = Object.keys(manifest.entries).length;
      const currentBytes = manifest.totalSourceBytes;
      const isUpdate = !!existing;
      const capacityResult = validateCorpusCapacity(
        isUpdate ? currentCount - 1 : currentCount,
        isUpdate ? currentBytes - (existing?.entry.sourceBytes || 0) : currentBytes,
        stat.size,
        policy.limits,
      );
      if (!capacityResult.valid) {
        throw new KbIngestionError(
          'CORPUS_CAPACITY_EXCEEDED',
          `Corpus capacity exceeded: ${capacityResult.errors.join('; ')}`,
        );
      }
    }

    // 11. Extract text
    let extracted: ExtractedText;
    try {
      if (this.options._mockExtraction) {
        extracted = this.options._mockExtraction(content, mimeType, absolutePath);
      } else {
        extracted = extractText(content, mimeType, absolutePath);
      }
    } catch (err: any) {
      if (err instanceof KbIngestionError) throw err;
      throw new KbIngestionError(
        'EXTRACTION_FAILED',
        `Text extraction failed: ${err.message}`,
        { sourcePath: input.sourcePath, mimeType },
      );
    }

    // 12. Normalize text
    const normalizedText = normalizeText(extracted.text);
    const extractedTextBytes = Buffer.byteLength(normalizedText, 'utf-8');
    const pageCount = extracted.pages.length;
    const allWarnings = [...extracted.warnings];

    // 13. Document limits check
    const limitsResult = validateDocumentLimits(
      stat.size,
      pageCount,
      extractedTextBytes,
      0,
      policy.limits,
    );
    if (!limitsResult.valid) {
      throw new KbIngestionError(
        'DOCUMENT_LIMIT_EXCEEDED',
        `Document limits exceeded: ${limitsResult.errors.join('; ')}`,
      );
    }

    // 14. Chunk the normalized text
    const rawChunks = chunkText(
      normalizedText,
      policy.chunking.chunkSizeChars,
      policy.chunking.overlapChars,
    );

    // Check chunk count limit
    if (rawChunks.length > policy.limits.maxChunksPerDocument) {
      throw new KbIngestionError(
        'DOCUMENT_LIMIT_EXCEEDED',
        `Chunk count (${rawChunks.length}) exceeds maximum (${policy.limits.maxChunksPerDocument})`,
      );
    }

    // 15. Scan for prompt injection
    const injectionMatches = scanForInjection(normalizedText);
    const isQuarantined = shouldQuarantine(injectionMatches);

    if (isQuarantined) {
      allWarnings.push(`QUARANTINED: ${injectionMatches.length} prompt-injection pattern(s) detected`);
    }

    // 16. Build typed chunks with provenance (Requirement 6)
    const now = new Date().toISOString();
    const chunks: KbTextChunk[] = rawChunks.map((rc, index) => {
      const chunkId = generateChunkId(sourceHash, index);
      const byteOffsetStart = Buffer.byteLength(normalizedText.slice(0, rc.charOffsetStart), 'utf-8');
      const byteOffsetEnd = Buffer.byteLength(normalizedText.slice(0, rc.charOffsetEnd), 'utf-8');

      let pageNumber: number | null = null;
      let sectionHeading: string | null = null;
      for (const page of extracted.pages) {
        if (rc.charOffsetStart < page.charOffsetEnd) {
          pageNumber = page.pageNumber;
          sectionHeading = page.sectionHeading;
          break;
        }
      }

      const chunkWarnings: string[] = [];
      for (const im of injectionMatches) {
        if (im.offsetStart >= rc.charOffsetStart && im.offsetStart < rc.charOffsetEnd) {
          chunkWarnings.push(`INJECTION_DETECTED: ${im.category}`);
        }
      }

      const chunk: KbTextChunk = {
        schemaVersion: 1,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        canonicalPath,
        sourceHash,
        mimeType,
        fileSize: stat.size,
        sourceBytes: stat.size,
        documentVersion: docVersion,
        documentId,
        pageNumber,
        sectionHeading,
        chunkId,
        chunkIndex: index,
        chunkText: rc.text,
        text: rc.text,
        charOffsetStart: rc.charOffsetStart,
        charOffsetEnd: rc.charOffsetEnd,
        byteOffsetStart,
        byteOffsetEnd,
        extractionEngine: EXTRACTION_ENGINE,
        extractionVersion: EXTRACTION_VERSION,
        warnings: chunkWarnings,
        createdAt: now,
        updatedAt: now,
      };

      const validChunk = validateKbTextChunk(chunk);
      if (!validChunk.valid) {
        throw new KbIngestionError(
          'MALFORMED_DOCUMENT',
          `Generated chunk failed validation: ${validChunk.errors.join('; ')}`,
        );
      }

      return chunk;
    });

    // 17. Build document entry
    const quarantineInfo: KbQuarantineInfo | undefined = isQuarantined
      ? {
          reason: 'PROMPT_INJECTION_DETECTED' as KbQuarantineReason,
          details: `${injectionMatches.length} injection pattern(s) detected`,
          detectedAt: now,
          injectionMatches,
        }
      : undefined;

    const documentEntry: KbCorpusDocumentEntry = {
      schemaVersion: 1,
      id: documentId,
      projectId: input.projectId,
      canonicalPath,
      originalPath: input.sourcePath,
      sourceHash,
      sourceBytes: stat.size,
      mimeType,
      pageCount,
      chunkCount: chunks.length,
      extractedTextBytes,
      indexVersion: docVersion,
      status: isQuarantined ? 'quarantined' : 'indexed',
      quarantine: quarantineInfo,
      ingestedAt: now,
      lastIndexedAt: now,
      sourceModifiedAt: stat.mtime.toISOString(),
    };

    // 18. Simulate interruption for testing
    if (this.options._simulateInterruption === 'before_persist') {
      throw new KbIngestionError('PERSIST_FAILED', 'Simulated interruption before persist');
    }

    // 19. Persist atomically
    this.persistIngestion(documentEntry, chunks, policy);

    // 20. Simulate interruption for testing
    if (this.options._simulateInterruption === 'before_audit') {
      return {
        documentEntry,
        chunks,
        warnings: allWarnings,
        injectionMatches,
        quarantined: isQuarantined,
      };
    }

    // 21. Append audit event (only after successful finalization)
    if (this.audit && !this.options.skipAudit) {
      try {
        this.audit.recordAuditEvent({
          source: 'kb-ingestion',
          category: 'io_hash',
          data: {
            event: 'DOCUMENT_INGESTED',
            documentId,
            projectId: input.projectId,
            canonicalPath,
            sourceHash,
            mimeType,
            chunkCount: chunks.length,
            extractedTextBytes,
            quarantined: isQuarantined,
            policyVersion: policy.policyVersion,
            documentVersion: docVersion,
          },
        });
      } catch {
        allWarnings.push('Audit event emission failed (non-fatal)');
      }
    }

    return {
      documentEntry,
      chunks,
      warnings: allWarnings,
      injectionMatches,
      quarantined: isQuarantined,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────

  private persistIngestion(
    entry: KbCorpusDocumentEntry,
    chunks: readonly KbTextChunk[],
    policy: KbCorpusPolicy,
  ): void {
    this.ensureDirs();

    const chunkFilePath = path.join(this.chunksDir, `${entry.id}.json`);
    this.atomicWriteJson(chunkFilePath, {
      schemaVersion: 1,
      documentId: entry.id,
      projectId: entry.projectId,
      sourceHash: entry.sourceHash,
      chunkCount: chunks.length,
      chunks,
    });

    const existingManifest = this.readManifest();
    const manifest: KbIngestionManifest = existingManifest
      ? { ...existingManifest }
      : {
          schemaVersion: 1,
          projectId: policy.projectId,
          documentCount: 0,
          totalSourceBytes: 0,
          totalChunks: 0,
          policyVersion: policy.policyVersion,
          updatedAt: '',
          entries: {},
        };

    const oldEntry = manifest.entries[entry.id];
    let newDocCount = manifest.documentCount;
    let newTotalBytes = manifest.totalSourceBytes;
    let newTotalChunks = manifest.totalChunks;

    if (oldEntry) {
      newDocCount--;
      newTotalBytes -= oldEntry.entry.sourceBytes;
      newTotalChunks -= oldEntry.chunkCount;
    }

    newDocCount++;
    newTotalBytes += entry.sourceBytes;
    newTotalChunks += chunks.length;

    const updatedEntries = { ...manifest.entries };
    updatedEntries[entry.id] = { entry, chunkCount: chunks.length };

    const updatedManifest: KbIngestionManifest = {
      schemaVersion: 1,
      projectId: policy.projectId,
      documentCount: newDocCount,
      totalSourceBytes: newTotalBytes,
      totalChunks: newTotalChunks,
      policyVersion: policy.policyVersion,
      updatedAt: new Date().toISOString(),
      entries: updatedEntries,
    };

    const validManifest = validateKbIngestionManifest(updatedManifest);
    if (!validManifest.valid) {
      throw new KbIngestionError(
        'PERSIST_FAILED',
        `Manifest validation failed: ${validManifest.errors.join('; ')}`,
      );
    }

    this.atomicWriteJson(this.manifestPath, updatedManifest);
  }

  private atomicWriteJson(targetPath: string, data: unknown): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${targetPath}.tmp_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
      throw new KbIngestionError(
        'PERSIST_FAILED',
        `Failed to atomically rename ${tempPath} to ${targetPath}`,
      );
    }
  }

  // ── Manifest Operations ─────────────────────────────────────────

  readManifest(): KbIngestionManifest | null {
    if (!fs.existsSync(this.manifestPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
      if (raw.schemaVersion !== 1) return null;
      return raw as KbIngestionManifest;
    } catch {
      return null;
    }
  }

  readChunks(documentId: string): readonly KbTextChunk[] | null {
    const chunkPath = path.join(this.chunksDir, `${documentId}.json`);
    if (!fs.existsSync(chunkPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(chunkPath, 'utf-8'));
      return raw.chunks as readonly KbTextChunk[];
    } catch {
      return null;
    }
  }

  getDocumentEntry(documentId: string, projectId: string): KbCorpusDocumentEntry | null {
    const manifest = this.readManifest();
    if (!manifest) return null;
    if (manifest.projectId !== projectId) return null;

    const record = manifest.entries[documentId];
    return record ? record.entry : null;
  }

  removeDocument(documentId: string, projectId: string): boolean {
    const manifest = this.readManifest();
    if (!manifest || manifest.projectId !== projectId) return false;

    const record = manifest.entries[documentId];
    if (!record) return false;

    const chunkPath = path.join(this.chunksDir, `${documentId}.json`);
    try {
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
    } catch { /* best effort */ }

    const updatedEntries = { ...manifest.entries };
    delete updatedEntries[documentId];

    const updatedManifest: KbIngestionManifest = {
      schemaVersion: 1,
      projectId: manifest.projectId,
      documentCount: manifest.documentCount - 1,
      totalSourceBytes: manifest.totalSourceBytes - record.entry.sourceBytes,
      totalChunks: manifest.totalChunks - record.chunkCount,
      policyVersion: manifest.policyVersion,
      updatedAt: new Date().toISOString(),
      entries: updatedEntries,
    };

    this.atomicWriteJson(this.manifestPath, updatedManifest);
    return true;
  }

  clearAll(projectId: string): { documentsRemoved: number; chunksRemoved: number } {
    const manifest = this.readManifest();
    if (!manifest || manifest.projectId !== projectId) {
      return { documentsRemoved: 0, chunksRemoved: 0 };
    }

    const documentsRemoved = manifest.documentCount;
    const chunksRemoved = manifest.totalChunks;

    try {
      if (fs.existsSync(this.chunksDir)) {
        const files = fs.readdirSync(this.chunksDir);
        for (const file of files) {
          try { fs.unlinkSync(path.join(this.chunksDir, file)); } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }

    try {
      if (fs.existsSync(this.manifestPath)) {
        fs.unlinkSync(this.manifestPath);
      }
    } catch { /* best effort */ }

    return { documentsRemoved, chunksRemoved };
  }
}
