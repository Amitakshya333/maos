/**
 * MAOS Application Service: Printed-Text OCR (F4-02)
 *
 * Implements bounded, local-only printed text extraction from rasterized pages
 * while strictly preserving confidence scores, bounding boxes, and provenance.
 *
 * Invariant: OCR output is NEVER treated as an unqualified fact.
 * Every extracted result and text block retains authoritative source hash,
 * artifact reference, engine/version provenance, bounding box, and confidence.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { BoundedProcessError, runBoundedProcess } from '../industrial/async-process';
import {
  OcrOptions,
  OcrResult,
  OcrDocumentResult,
  OcrBoundingBox,
  OcrError,
  OCR_BOUNDS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  validateOcrOptions,
  validateOcrResult,
} from '../domain/ocr';
import { ArtifactService } from './artifact-service';
import { AuditService } from './audit-service';
import { PdfRasterService } from './pdf-raster-service';
import { PdfRasterError } from '../domain/raster';
import { engineHash, getDefaultEnginePath, verifyExecutable } from '../industrial/rust-engine-bridge';

export interface OcrServiceOptions {
  pythonExecutable?: string;
  backendScriptPath?: string;
}

export class OcrService {
  private readonly projectRoot: string;
  private readonly artifactService: ArtifactService;
  private readonly auditService: AuditService;
  private readonly pdfRasterService?: PdfRasterService;
  private readonly pythonExecutable: string;
  private readonly backendScriptPath: string;

  constructor(
    projectRoot: string,
    artifactService?: ArtifactService,
    auditService?: AuditService,
    pdfRasterService?: PdfRasterService,
    options: OcrServiceOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.artifactService = artifactService || new ArtifactService(this.projectRoot);
    this.auditService = auditService || new AuditService(this.projectRoot);
    this.pdfRasterService = pdfRasterService;
    this.pythonExecutable = options.pythonExecutable || 'python';
    this.backendScriptPath =
      options.backendScriptPath ||
      path.resolve(__dirname, '..', 'industrial', 'python', 'ocr_engine.py');
  }

  /**
   * Run OCR on a single image file (PNG, JPEG, etc.).
   */
  async ocrImage(
    inputRelativePath: string,
    rawOptions: OcrOptions = {},
    pageNumber = 1,
    sourceArtifactId?: string,
  ): Promise<OcrResult> {
    const options = validateOcrOptions(rawOptions);
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);
    if (!fs.existsSync(resolvedPath)) throw new OcrError('NOT_FOUND', `Image file not found: '${inputRelativePath}'`);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) throw new OcrError('NOT_FOUND', `Path is not a regular file: '${inputRelativePath}'`);

    const ext = path.extname(resolvedPath).toLowerCase();
    const validExtensions = ['.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.webp'];
    if (!validExtensions.includes(ext)) {
      throw new OcrError('INVALID_EXTENSION', `Unsupported image extension '${ext}'. Expected one of: ${validExtensions.join(', ')}`);
    }
    if (stat.size > options.maxSourceBytes) {
      throw new OcrError('BYTE_LIMIT_EXCEEDED', `Image size (${stat.size} bytes) exceeds limit of ${options.maxSourceBytes} bytes`);
    }

    const header = Buffer.alloc(Math.min(32, Math.max(1, stat.size)));
    const fd = fs.openSync(resolvedPath, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const isBmp = header.length >= 2 && header.subarray(0, 2).equals(Buffer.from([0x42, 0x4d]));
    const isTiff = header.length >= 4 && (header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])));
    const isWebp = header.length >= 12 && header.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) && header.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]));
    if (!isPng && !isJpeg && !isBmp && !isTiff && !isWebp) {
      throw new OcrError('INVALID_IMAGE_FORMAT', `Image header magic bytes invalid for '${inputRelativePath}'`);
    }
    if (isPng && header.length >= 24) {
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (width > options.maxImageDimension || height > options.maxImageDimension) {
        throw new OcrError('OVERSIZED_IMAGE_DIMENSIONS', `Image dimensions (${width}x${height}) exceed limit ${options.maxImageDimension}`);
      }
      if (width * height > options.maxImagePixels) {
        throw new OcrError('PIXEL_LIMIT_EXCEEDED', `Total image pixels (${width * height}) exceed limit ${options.maxImagePixels}`);
      }
    }

    const sourceHash = this.computeSourceHash(resolvedPath);
    if (options.expectedSourceHash && options.expectedSourceHash.toLowerCase() !== sourceHash.toLowerCase()) {
      throw new OcrError('SOURCE_HASH_MISMATCH', `Expected source hash '${options.expectedSourceHash}', but calculated '${sourceHash}'`);
    }
    const effectiveSourceArtifactId = sourceArtifactId || inputRelativePath.replace(/\\/g, '/');
    const scratchDir = path.join(this.projectRoot, '.maos', 'artifacts', '.tmp');
    fs.mkdirSync(scratchDir, { recursive: true });
    const tmpJsonPath = path.join(scratchDir, `ocr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);

    try {
      if (options.forceFallback) {
        throw new OcrError('MISSING_ENGINE_ASSETS', 'The TypeScript OCR fallback is disabled; install the pinned offline OCR engine.');
      }
      const rawResult = await this.runPythonOcrAsync(resolvedPath, pageNumber, effectiveSourceArtifactId, sourceHash, options);
      const validatedResult = validateOcrResult(rawResult);
      const serialized = JSON.stringify(validatedResult, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > OCR_BOUNDS.maxOutputBytes) {
        throw new OcrError('OUTPUT_LIMIT_EXCEEDED', 'Extracted OCR artifact exceeds maximum output bytes');
      }
      const artifactId = `art_ocr_${sourceHash.substring(0, 8)}_${pageNumber}_${Date.now()}`;
      const artifactRelativePath = `evidence/ocr/${sourceHash.substring(0, 16)}/page_${pageNumber}.json`;
      const finalized = this.artifactService.finalizeArtifact({
        id: artifactId,
        relativePath: artifactRelativePath,
        content: Buffer.from(serialized, 'utf8'),
        type: 'evidence',
        allowOverwrite: options.allowOverwrite,
        approvalId: options.approvalId || undefined,
        projectId: path.basename(this.projectRoot),
        metadata: { pageNumber, sourceArtifactId: effectiveSourceArtifactId, sourceHash, confidence: validatedResult.confidence, blocksCount: validatedResult.blocks.length },
        producer: { agentId: 'ocr-service', modelId: 'pinned-ocr-1.0.0' },
      });
      validatedResult.artifactId = finalized.id;
      validatedResult.artifactHash = finalized.hash;
      this.auditService.recordAuditEvent({
        source: 'ocr-service',
        category: 'tool',
        data: {
          action: 'DOCUMENT_OCRED', sourceArtifactId: effectiveSourceArtifactId, sourceHash, pageNumber,
          confidence: validatedResult.confidence, textLength: validatedResult.text.length,
          blockCount: validatedResult.blocks.length, warnings: validatedResult.warnings,
          outputArtifactId: artifactId, outputRelativePath: artifactRelativePath,
        },
      });
      return validatedResult;
    } catch (err: unknown) {
      if (err instanceof OcrError) throw err;
      throw new OcrError('OCR_ENGINE_FAILED', `OCR processing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (fs.existsSync(tmpJsonPath)) {
        try { fs.unlinkSync(tmpJsonPath); } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * Synchronous OCR execution on a single image.
   */
  ocrImageSync(
    inputRelativePath: string,
    rawOptions: OcrOptions = {},
    pageNumber = 1,
    sourceArtifactId?: string,
  ): OcrResult {
    const options = validateOcrOptions(rawOptions);

    // 1. Validate project-root confinement and traversal
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);

    // 2. Validate file existence and extension
    if (!fs.existsSync(resolvedPath)) {
      throw new OcrError('NOT_FOUND', `Image file not found: '${inputRelativePath}'`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new OcrError('NOT_FOUND', `Path is not a regular file: '${inputRelativePath}'`);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const validExtensions = ['.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.webp'];
    if (!validExtensions.includes(ext)) {
      throw new OcrError(
        'INVALID_EXTENSION',
        `Unsupported image extension '${ext}'. Expected one of: ${validExtensions.join(', ')}`,
      );
    }

    // 3. File size check
    if (stat.size > options.maxSourceBytes) {
      throw new OcrError(
        'BYTE_LIMIT_EXCEEDED',
        `Image size (${stat.size} bytes) exceeds limit of ${options.maxSourceBytes} bytes`,
      );
    }

    // 4. Magic bytes & header check
    const header = Buffer.alloc(Math.min(32, Math.max(1, stat.size)));
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const isBmp = header.length >= 2 && header.subarray(0, 2).equals(Buffer.from([0x42, 0x4d]));
    const isTiff =
      header.length >= 4 &&
      (header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
        header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])));
    const isWebp =
      header.length >= 12 &&
      header.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
      header.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]));

    if (!isPng && !isJpeg && !isBmp && !isTiff && !isWebp) {
      throw new OcrError('INVALID_IMAGE_FORMAT', `Image header magic bytes invalid for '${inputRelativePath}'`);
    }

    // Quick dimension pre-check for PNG
    if (isPng && header.length >= 24) {
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (width > options.maxImageDimension || height > options.maxImageDimension) {
        throw new OcrError(
          'OVERSIZED_IMAGE_DIMENSIONS',
          `Image dimensions (${width}x${height}) exceed limit ${options.maxImageDimension}`,
        );
      }
      if (width * height > options.maxImagePixels) {
        throw new OcrError(
          'PIXEL_LIMIT_EXCEEDED',
          `Total image pixels (${width * height}) exceed limit ${options.maxImagePixels}`,
        );
      }
    }

    // 5. Authoritative source SHA-256 calculation
    const sourceHash = this.computeSourceHash(resolvedPath);
    if (options.expectedSourceHash && options.expectedSourceHash.toLowerCase() !== sourceHash.toLowerCase()) {
      throw new OcrError(
        'SOURCE_HASH_MISMATCH',
        `Expected source hash '${options.expectedSourceHash}', but calculated '${sourceHash}'`,
      );
    }

    const effectiveSourceArtifactId = sourceArtifactId || inputRelativePath.replace(/\\/g, '/');

    // Scratch staging path
    const scratchDir = path.join(this.projectRoot, '.maos', 'artifacts', '.tmp');
    fs.mkdirSync(scratchDir, { recursive: true });
    const tmpJsonPath = path.join(
      scratchDir,
      `ocr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`,
    );

    let rawResult: OcrResult;

    try {
      if (options.forceFallback) {
        throw new OcrError(
          'MISSING_ENGINE_ASSETS',
          'The TypeScript OCR fallback is disabled because it cannot provide production-grade OCR provenance. Install the pinned offline OCR engine.',
        );
      }
      rawResult = this.runPythonOcr(
        resolvedPath,
        pageNumber,
        effectiveSourceArtifactId,
        sourceHash,
        options,
      );

      const validatedResult = validateOcrResult(rawResult);

      // Check cumulative output size
      const serialized = JSON.stringify(validatedResult, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > OCR_BOUNDS.maxOutputBytes) {
        throw new OcrError('OUTPUT_LIMIT_EXCEEDED', 'Extracted OCR artifact exceeds maximum output bytes');
      }

      // 6. Finalize artifact through Safe Artifact Store
      const artifactId = `art_ocr_${sourceHash.substring(0, 8)}_${pageNumber}_${Date.now()}`;
      const artifactRelativePath = `evidence/ocr/${sourceHash.substring(0, 16)}/page_${pageNumber}.json`;

      const finalized = this.artifactService.finalizeArtifact({
        id: artifactId,
        relativePath: artifactRelativePath,
        content: Buffer.from(serialized, 'utf8'),
        type: 'evidence',
        allowOverwrite: options.allowOverwrite,
        approvalId: options.approvalId || undefined,
        projectId: path.basename(this.projectRoot),
        metadata: {
          pageNumber,
          sourceArtifactId: effectiveSourceArtifactId,
          sourceHash,
          confidence: validatedResult.confidence,
          blocksCount: validatedResult.blocks.length,
        },
        producer: {
          agentId: 'ocr-service',
          modelId: 'pinned-ocr-1.0.0',
        },
      });

      validatedResult.artifactId = finalized.id;
      validatedResult.artifactHash = finalized.hash;

      // 7. Record immutable audit event
      this.auditService.recordAuditEvent({
        source: 'ocr-service',
        category: 'tool',
        data: {
          action: 'DOCUMENT_OCRED',
          sourceArtifactId: effectiveSourceArtifactId,
          sourceHash,
          pageNumber,
          confidence: validatedResult.confidence,
          textLength: validatedResult.text.length,
          blockCount: validatedResult.blocks.length,
          warnings: validatedResult.warnings,
          outputArtifactId: artifactId,
          outputRelativePath: artifactRelativePath,
        },
      });

      return validatedResult;
    } catch (err: unknown) {
      // Clean up scratch file
      if (fs.existsSync(tmpJsonPath)) {
        try {
          fs.unlinkSync(tmpJsonPath);
        } catch {
          // ignore cleanup errors
        }
      }

      if (err instanceof OcrError) {
        throw err;
      }
      throw new OcrError('OCR_ENGINE_FAILED', `OCR processing failed: ${(err as Error).message}`);
    }
  }

  /**
   * Run OCR on a document (either a PDF or a list of image paths).
   */
  async ocrDocument(
    inputRelativePath: string,
    rawOptions: OcrOptions = {},
  ): Promise<OcrDocumentResult> {
    const options = validateOcrOptions(rawOptions);
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const pageResults: OcrResult[] = [];
    let sourceHash = '';

    if (ext === '.pdf') {
      if (!this.pdfRasterService) {
        throw new OcrError('OCR_ENGINE_FAILED', 'PdfRasterService is required to perform OCR on a PDF document');
      }
      let rasterResult;
      try {
        rasterResult = await this.pdfRasterService.rasterize(inputRelativePath, {
          maxSourceBytes: options.maxSourceBytes,
          maxPages: options.maxPages,
          timeoutMs: options.timeoutMs,
          targetPages: options.targetPages.length > 0 ? options.targetPages : undefined,
          allowOverwrite: options.allowOverwrite,
          approvalId: options.approvalId,
        });
      } catch (err: any) {
        if (err instanceof PdfRasterError) {
          throw new OcrError(err.code as any, err.message, err.details ? { detail: err.details } : undefined);
        }
        throw err;
      }
      if (rasterResult.pageCount > options.maxPages) {
        throw new OcrError('PAGE_LIMIT_EXCEEDED', `Document has ${rasterResult.pageCount} pages, exceeding limit of ${options.maxPages}`);
      }
      sourceHash = rasterResult.sourceHash;
      for (const page of rasterResult.renderedPages) {
        pageResults.push(await this.ocrImage(page.outputRelativePath, options, page.pageNumber, rasterResult.sourceRelativePath));
      }
    } else {
      const singleRes = await this.ocrImage(inputRelativePath, options, 1);
      pageResults.push(singleRes);
      sourceHash = singleRes.sourceHash;
    }

    const combinedText = pageResults.map((p) => p.text).join('\\n\\n');
    const allWarnings = Array.from(new Set(pageResults.flatMap((p) => p.warnings)));
    const averageConfidence = pageResults.length > 0
      ? Math.round((pageResults.reduce((acc, p) => acc + p.confidence, 0) / pageResults.length) * 1000) / 1000
      : 0;
    return {
      schemaVersion: 1,
      sourceArtifactId: inputRelativePath.replace(/\\\\/g, '/'),
      sourceHash,
      totalPages: pageResults.length,
      pages: pageResults,
      text: combinedText,
      averageConfidence,
      warnings: allWarnings,
    };
  }

  /**
   * Synchronous OCR execution on a document.
   */
  ocrDocumentSync(
    inputRelativePath: string,
    rawOptions: OcrOptions = {},
  ): OcrDocumentResult {
    const options = validateOcrOptions(rawOptions);
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);
    const ext = path.extname(resolvedPath).toLowerCase();

    let pageResults: OcrResult[] = [];
    let sourceHash = '';

    if (ext === '.pdf') {
      if (!this.pdfRasterService) {
        throw new OcrError(
          'OCR_ENGINE_FAILED',
          'PdfRasterService is required to perform OCR on a PDF document',
        );
      }

      // Rasterize PDF using the synchronous service for synchronous callers.
      let rasterResult;
      try {
        rasterResult = this.pdfRasterService.rasterizeSync(inputRelativePath, {
          maxSourceBytes: options.maxSourceBytes,
          maxPages: options.maxPages,
          timeoutMs: options.timeoutMs,
          targetPages: options.targetPages.length > 0 ? options.targetPages : undefined,
          allowOverwrite: options.allowOverwrite,
          approvalId: options.approvalId,
        });
      } catch (err: any) {
        if (err instanceof PdfRasterError) {
          throw new OcrError(
            err.code as any,
            err.message,
            err.details ? { detail: err.details } : undefined,
          );
        }
        throw err;
      }

      if (rasterResult.pageCount > options.maxPages) {
        throw new OcrError(
          'PAGE_LIMIT_EXCEEDED',
          `Document has ${rasterResult.pageCount} pages, exceeding limit of ${options.maxPages}`,
        );
      }

      sourceHash = rasterResult.sourceHash;

      for (const page of rasterResult.renderedPages) {
        const pageRes = this.ocrImageSync(
          page.outputRelativePath,
          options,
          page.pageNumber,
          rasterResult.sourceRelativePath,
        );
        pageResults.push(pageRes);
      }
    } else {
      // Single image document
      const singleRes = this.ocrImageSync(inputRelativePath, options, 1);
      pageResults.push(singleRes);
      sourceHash = singleRes.sourceHash;
    }

    const combinedText = pageResults.map((p) => p.text).join('\n\n');
    const allWarnings = Array.from(new Set(pageResults.flatMap((p) => p.warnings)));
    const avgConfidence =
      pageResults.length > 0
        ? Math.round(
            (pageResults.reduce((acc, p) => acc + p.confidence, 0) / pageResults.length) * 1000,
          ) / 1000
        : 0;

    return {
      schemaVersion: 1,
      sourceArtifactId: inputRelativePath.replace(/\\/g, '/'),
      sourceHash,
      totalPages: pageResults.length,
      pages: pageResults,
      text: combinedText,
      averageConfidence: avgConfidence,
      warnings: allWarnings,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────

  private runPythonOcr(
    imagePath: string,
    pageNumber: number,
    sourceArtifactId: string,
    sourceHash: string,
    options: Required<OcrOptions>,
  ): OcrResult {
    if (!fs.existsSync(this.backendScriptPath)) {
      throw new OcrError(
        'MISSING_ENGINE_ASSETS',
        `OCR backend script missing: ${this.backendScriptPath}`,
      );
    }

    const args = [
      this.backendScriptPath,
      '--input',
      imagePath,
      '--page',
      String(pageNumber),
      '--source-artifact-id',
      sourceArtifactId,
      '--source-hash',
      sourceHash,
      '--language',
      options.language,
      '--max-dimension',
      String(options.maxImageDimension),
      '--max-pixels',
      String(options.maxImagePixels),
      '--high-threshold',
      String(options.confidenceThresholds.high),
      '--medium-threshold',
      String(options.confidenceThresholds.medium),
      '--low-threshold',
      String(options.confidenceThresholds.low),
    ];

    const proc = spawnSync(this.pythonExecutable, args, {
      cwd: this.projectRoot,
      env: { ...process.env },
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });

    if (proc.error) {
      if ((proc.error as any).code === 'ETIMEDOUT') {
        throw new OcrError('TIMEOUT', `OCR timed out after ${options.timeoutMs}ms`);
      }
      if ((proc.error as any).code === 'ENOENT') {
        throw new OcrError(
          'MISSING_ENGINE_ASSETS',
          `Python executable not found: '${this.pythonExecutable}'`,
        );
      }
      throw new OcrError('OCR_ENGINE_FAILED', `Execution error: ${proc.error.message}`);
    }

    if (proc.status !== 0) {
      const errStr = proc.stderr ? proc.stderr.toString('utf8') : '';
      try {
        const parsed = JSON.parse(errStr);
        if (parsed.code) {
          throw new OcrError(parsed.code, parsed.error || 'OCR engine failed');
        }
      } catch {
        // Not structured JSON
      }
      throw new OcrError('OCR_ENGINE_FAILED', `OCR worker failed (exit ${proc.status}): ${errStr}`);
    }

    const stdoutStr = proc.stdout ? proc.stdout.toString('utf8').trim() : '';
    if (!stdoutStr) {
      throw new OcrError('OCR_ENGINE_FAILED', 'OCR engine produced empty output');
    }

    try {
      return JSON.parse(stdoutStr) as OcrResult;
    } catch (e) {
      throw new OcrError('MALFORMED_INPUT', `Failed to parse OCR result JSON: ${(e as Error).message}`);
    }
  }

  private async runPythonOcrAsync(
    imagePath: string,
    pageNumber: number,
    sourceArtifactId: string,
    sourceHash: string,
    options: Required<OcrOptions>,
  ): Promise<OcrResult> {
    if (!fs.existsSync(this.backendScriptPath)) {
      throw new OcrError('MISSING_ENGINE_ASSETS', `OCR backend script missing: ${this.backendScriptPath}`);
    }
    const args = [
      this.backendScriptPath, '--input', imagePath, '--page', String(pageNumber),
      '--source-artifact-id', sourceArtifactId, '--source-hash', sourceHash,
      '--language', options.language, '--max-dimension', String(options.maxImageDimension),
      '--max-pixels', String(options.maxImagePixels),
      '--high-threshold', String(options.confidenceThresholds.high),
      '--medium-threshold', String(options.confidenceThresholds.medium),
      '--low-threshold', String(options.confidenceThresholds.low),
    ];

    try {
      const proc = await runBoundedProcess(this.pythonExecutable, args, {
        cwd: this.projectRoot,
        env: { ...process.env },
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      const stdoutStr = proc.stdout.trim();
      if (proc.status !== 0 || proc.signal) {
        const structured = stdoutStr || proc.stderr.trim();
        try {
          const parsed = JSON.parse(structured);
          if (parsed.code) throw new OcrError(parsed.code, parsed.error || 'OCR engine failed');
        } catch (err) {
          if (err instanceof OcrError) throw err;
        }
        throw new OcrError('OCR_ENGINE_FAILED', `OCR worker failed (exit ${proc.status}): ${structured}`);
      }
      if (!stdoutStr) throw new OcrError('OCR_ENGINE_FAILED', 'OCR engine produced empty output');
      try {
        return JSON.parse(stdoutStr) as OcrResult;
      } catch (err) {
        throw new OcrError('MALFORMED_INPUT', `Failed to parse OCR result JSON: ${(err as Error).message}`);
      }
    } catch (err: unknown) {
      if (err instanceof OcrError) throw err;
      if (err instanceof BoundedProcessError) {
        if (err.kind === 'timeout') throw new OcrError('TIMEOUT', `OCR timed out after ${options.timeoutMs}ms`);
        if (err.kind === 'output_limit') throw new OcrError('OUTPUT_LIMIT_EXCEEDED', err.message);
        throw new OcrError('MISSING_ENGINE_ASSETS', err.message);
      }
      throw new OcrError('OCR_ENGINE_FAILED', `Execution error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private resolveAndValidatePath(relPath: string): string {
    if (!relPath || typeof relPath !== 'string') {
      throw new OcrError('NOT_FOUND', 'Image path must be a non-empty string');
    }

    const norm = relPath.replace(/\\/g, '/');
    if (norm.includes('../') || norm.startsWith('../') || norm === '..') {
      throw new OcrError('TRAVERSAL_REJECTED', `Path traversal rejected: '${relPath}'`);
    }

    let candidate = path.resolve(this.projectRoot, relPath);

    // If candidate path contains symlinks, resolve and check containment
    try {
      if (fs.existsSync(candidate)) {
        const real = fs.realpathSync(candidate);
        const realRoot = fs.realpathSync(this.projectRoot);
        const rel = path.relative(realRoot, real);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new OcrError('SYMLINK_ESCAPE_REJECTED', `Path resolves outside project root: '${relPath}'`);
        }
      }
    } catch (e) {
      if (e instanceof OcrError) throw e;
    }

    const rel = path.relative(this.projectRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OcrError('TRAVERSAL_REJECTED', `Path outside project root: '${relPath}'`);
    }

    return candidate;
  }

  private computeSourceHash(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    const enginePath = getDefaultEnginePath(this.projectRoot);
    if (fs.existsSync(enginePath)) {
      try {
        const manifest = verifyExecutable(enginePath);
        engineHash(manifest, {
          content: buf.toString('base64'),
          size: buf.length,
        });
      } catch {
        // Fallback to node crypto
      }
    }
    return crypto.createHash('sha256').update(buf).digest('hex');
  }
}
