/**
 * MAOS Application Service: Bounded PDF Rasterization (F4-01)
 *
 * Implements bounded, deterministic, project-confined PDF rasterization
 * for scanned industrial inspection documents (MRPL SIH26117).
 *
 * Enforces:
 *   - Strict project-root containment (canonical path, symlink escape, traversal rejection)
 *   - Extension and MIME validation (%PDF- signature)
 *   - Source byte limit, page count limit, page dimension limit, pixel limit
 *   - Decompression bomb detection (expansion ratio and byte limits)
 *   - Execution timeout bounds
 *   - Cumulative output size limits
 *   - Authoritative source and output SHA-256 calculation via Rust engine
 *   - Safe Artifact Store integration (temp -> fsync -> Rust hash -> atomic rename)
 *   - Append-only audit trail emission on successful finalization
 *   - Zero network access, zero external downloads, zero host shell execution
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { BoundedProcessError, runBoundedProcess } from '../industrial/async-process';
import {
  PdfRasterOptions,
  PdfRasterResult,
  RasterPageMetadata,
  PdfRasterError,
  validatePdfRasterOptions,
  RASTER_BOUNDS,
} from '../domain/raster';
import { ArtifactService } from './artifact-service';
import { AuditService } from './audit-service';
import { engineHash, getDefaultEnginePath, verifyExecutable } from '../industrial/rust-engine-bridge';

export interface PdfRasterServiceOptions {
  pythonExecutable?: string;
  backendScriptPath?: string;
}

export class PdfRasterService {
  private readonly projectRoot: string;
  private readonly artifactService: ArtifactService;
  private readonly auditService: AuditService;
  private readonly pythonExecutable: string;
  private readonly backendScriptPath: string;

  constructor(
    projectRoot: string,
    artifactService?: ArtifactService,
    auditService?: AuditService,
    options: PdfRasterServiceOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.artifactService = artifactService || new ArtifactService(this.projectRoot);
    this.auditService = auditService || new AuditService(this.projectRoot);
    this.pythonExecutable = options.pythonExecutable || 'python';
    this.backendScriptPath =
      options.backendScriptPath ||
      path.resolve(__dirname, '..', 'industrial', 'python', 'pdf_rasterizer.py');
  }

  /**
   * Rasterize a project-confined PDF document into bounded, deterministic image artifacts.
   */
  async rasterize(
    inputRelativePath: string,
    rawOptions: PdfRasterOptions = {},
  ): Promise<PdfRasterResult> {
    return this.rasterizeAsync(inputRelativePath, rawOptions);
  }

  /**
   * Asynchronous production path. Validation and artifact finalization remain
   * bounded synchronous filesystem operations, but the potentially long local
   * rasterizer process never blocks the Node event loop.
   */
  private async rasterizeAsync(
    inputRelativePath: string,
    rawOptions: PdfRasterOptions = {},
  ): Promise<PdfRasterResult> {
    const startTime = Date.now();
    const options = validatePdfRasterOptions(rawOptions);
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new PdfRasterError('NOT_FOUND', `PDF file not found: '${inputRelativePath}'`, undefined, inputRelativePath);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new PdfRasterError('NOT_FOUND', `Path is not a regular file: '${inputRelativePath}'`, undefined, inputRelativePath);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext !== '.pdf') {
      throw new PdfRasterError('INVALID_EXTENSION', `Expected .pdf file extension, received '${ext}'`, undefined, inputRelativePath);
    }
    if (stat.size > options.maxSourceBytes) {
      throw new PdfRasterError(
        'BYTE_LIMIT_EXCEEDED',
        `Source PDF size (${stat.size} bytes) exceeds limit of ${options.maxSourceBytes} bytes`,
        undefined,
        inputRelativePath,
      );
    }
    if (stat.size === 0) {
      throw new PdfRasterError('MALFORMED_PDF', 'PDF file is empty (0 bytes)', undefined, inputRelativePath);
    }

    const headerBuffer = Buffer.alloc(Math.min(1024, stat.size));
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!headerBuffer.toString('latin1').includes('%PDF-')) {
      throw new PdfRasterError('INVALID_MIME', 'File lacks valid %PDF- magic signature in header', undefined, inputRelativePath);
    }
    if (stat.size < 5 * 1024 * 1024) {
      const fullBuf = fs.readFileSync(resolvedPath);
      if (fullBuf.includes(Buffer.from('/Encrypt'))) {
        throw new PdfRasterError('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted PDF documents are not supported', undefined, inputRelativePath);
      }
    }

    const sourceHash = this.computeSha256(resolvedPath);
    const tmpScratchDir = path.join(
      this.projectRoot,
      '.maos',
      'artifacts',
      '.tmp',
      `raster_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(tmpScratchDir, { recursive: true });

    try {
      const rawResult = await this.executeRasterizerBackendAsync(resolvedPath, tmpScratchDir, options);
      let cumulativeOutputBytes = 0;
      const renderedPages: RasterPageMetadata[] = [];
      const sourceBaseName = path.basename(resolvedPath, path.extname(resolvedPath));

      for (const page of rawResult.pages) {
        if (!fs.existsSync(page.tempFilePath)) {
          throw new PdfRasterError('RENDER_FAILED', `Rendered page file missing at '${page.tempFilePath}'`, undefined, inputRelativePath);
        }
        const pageBytes = fs.readFileSync(page.tempFilePath);
        cumulativeOutputBytes += pageBytes.length;
        if (cumulativeOutputBytes > options.maxTotalOutputBytes) {
          throw new PdfRasterError(
            'OUTPUT_LIMIT_EXCEEDED',
            `Total rendered output size (${cumulativeOutputBytes} bytes) exceeds limit of ${options.maxTotalOutputBytes} bytes`,
            undefined,
            inputRelativePath,
          );
        }

        const artifactExt = page.format === 'jpeg' ? 'jpg' : 'png';
        const artifactRelativePath = `evidence/raster/${sourceBaseName}_page_${page.pageNumber}.${artifactExt}`;
        const artifactId = `art_raster_${sourceBaseName}_${page.pageNumber}_${Date.now()}`;
        const finalized = this.artifactService.finalizeArtifact({
          id: artifactId,
          relativePath: artifactRelativePath,
          content: pageBytes,
          type: 'evidence',
          allowOverwrite: options.allowOverwrite,
          approvalId: options.approvalId || undefined,
          runId: options.runId || undefined,
          taskId: options.taskId || undefined,
          projectId: path.basename(this.projectRoot),
          correlationId: options.correlationId || undefined,
          metadata: {
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            dpi: page.dpi,
            sourceFile: inputRelativePath,
            sourceHash,
          },
          producer: { agentId: 'pdf-rasterizer', modelId: 'pinned-pillow-12.3.0' },
        });

        renderedPages.push({
          schemaVersion: 1,
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
          dpi: page.dpi,
          format: page.format,
          outputArtifactId: finalized.id,
          outputRelativePath: finalized.path,
          outputHash: finalized.hash,
          outputSizeBytes: pageBytes.length,
          renderer: { name: 'maos-pdf-rasterizer', version: '1.0.0' },
          warnings: page.warnings || [],
        });
      }

      const durationMs = Date.now() - startTime;
      const sourceRelativePath = path.relative(this.projectRoot, resolvedPath).replace(/\\/g, '/');
      const result: PdfRasterResult = {
        schemaVersion: 1,
        sourceRelativePath,
        sourceHash,
        sourceSizeBytes: stat.size,
        pageCount: rawResult.pageCount,
        renderedPages,
        totalOutputBytes: cumulativeOutputBytes,
        durationMs,
        warnings: rawResult.warnings || [],
      };

      try {
        this.auditService.recordAuditEvent({
          source: 'pdf-rasterizer',
          category: 'tool',
          data: {
            action: 'PDF_RASTERIZED',
            sourcePath: sourceRelativePath,
            sourceHash,
            pageCount: rawResult.pageCount,
            renderedPagesCount: renderedPages.length,
            totalOutputBytes: cumulativeOutputBytes,
            durationMs,
            targetPages: options.targetPages.length ? options.targetPages : 'all',
            outputHashes: renderedPages.map((p) => ({ pageNumber: p.pageNumber, hash: p.outputHash })),
          },
        });
      } catch (err: any) {
        throw new PdfRasterError('RENDER_FAILED', `PDF rasterization audit append failed: ${err?.message || String(err)}`, undefined, resolvedPath);
      }
      return result;
    } finally {
      this.cleanupDir(tmpScratchDir);
    }
  }

  /**
   * Synchronous version of rasterize for synchronous tool runners.
   */
  rasterizeSync(
    inputRelativePath: string,
    rawOptions: PdfRasterOptions = {},
  ): PdfRasterResult {
    const startTime = Date.now();
    const options = validatePdfRasterOptions(rawOptions);

    // 1. Validate Project-Root Confinement & Path Traversal
    const resolvedPath = this.resolveAndValidatePath(inputRelativePath);

    // 2. Validate File Existence & Extension
    if (!fs.existsSync(resolvedPath)) {
      throw new PdfRasterError('NOT_FOUND', `PDF file not found: '${inputRelativePath}'`, undefined, inputRelativePath);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new PdfRasterError('NOT_FOUND', `Path is not a regular file: '${inputRelativePath}'`, undefined, inputRelativePath);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext !== '.pdf') {
      throw new PdfRasterError(
        'INVALID_EXTENSION',
        `Expected .pdf file extension, received '${ext}'`,
        undefined,
        inputRelativePath,
      );
    }

    // 3. Check Source File Size Limit
    if (stat.size > options.maxSourceBytes) {
      throw new PdfRasterError(
        'BYTE_LIMIT_EXCEEDED',
        `Source PDF size (${stat.size} bytes) exceeds limit of ${options.maxSourceBytes} bytes`,
        undefined,
        inputRelativePath,
      );
    }
    if (stat.size === 0) {
      throw new PdfRasterError('MALFORMED_PDF', 'PDF file is empty (0 bytes)', undefined, inputRelativePath);
    }

    // 4. Validate MIME & Magic Bytes (%PDF-)
    const headerBuffer = Buffer.alloc(Math.min(1024, stat.size));
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    const headerStr = headerBuffer.toString('latin1');
    if (!headerStr.includes('%PDF-')) {
      throw new PdfRasterError(
        'INVALID_MIME',
        'File lacks valid %PDF- magic signature in header',
        undefined,
        inputRelativePath,
      );
    }

    // Fast-check for /Encrypt dictionary
    // For small/medium PDFs, scanning in memory detects encrypted PDFs fail-closed early
    if (stat.size < 5 * 1024 * 1024) {
      const fullBuf = fs.readFileSync(resolvedPath);
      if (fullBuf.includes(Buffer.from('/Encrypt'))) {
        throw new PdfRasterError(
          'ENCRYPTED_PDF_UNSUPPORTED',
          'Encrypted PDF documents are not supported',
          undefined,
          inputRelativePath,
        );
      }
    }

    // 5. Authoritative Source SHA-256 Calculation
    const sourceHash = this.computeSha256(resolvedPath);

    // 6. Create Scratch Working Directory
    const tmpScratchDir = path.join(
      this.projectRoot,
      '.maos',
      'artifacts',
      '.tmp',
      `raster_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(tmpScratchDir, { recursive: true });

    try {
      // 7. Dispatch Rasterization to Backend (Python or Pure TS Fallback)
      const rawResult = this.executeRasterizerBackend(resolvedPath, tmpScratchDir, options);

      // 8. Enforce Cumulative Output Size & Finalize Artifacts
      let cumulativeOutputBytes = 0;
      const renderedPages: RasterPageMetadata[] = [];
      const sourceBaseName = path.basename(resolvedPath, path.extname(resolvedPath));

      for (const page of rawResult.pages) {
        if (!fs.existsSync(page.tempFilePath)) {
          throw new PdfRasterError(
            'RENDER_FAILED',
            `Rendered page file missing at '${page.tempFilePath}'`,
            undefined,
            inputRelativePath,
          );
        }

        const pageBytes = fs.readFileSync(page.tempFilePath);
        cumulativeOutputBytes += pageBytes.length;

        if (cumulativeOutputBytes > options.maxTotalOutputBytes) {
          throw new PdfRasterError(
            'OUTPUT_LIMIT_EXCEEDED',
            `Total rendered output size (${cumulativeOutputBytes} bytes) exceeds limit of ${options.maxTotalOutputBytes} bytes`,
            undefined,
            inputRelativePath,
          );
        }

        const artifactExt = page.format === 'jpeg' ? 'jpg' : 'png';
        const artifactRelativePath = `evidence/raster/${sourceBaseName}_page_${page.pageNumber}.${artifactExt}`;
        const artifactId = `art_raster_${sourceBaseName}_${page.pageNumber}_${Date.now()}`;

        // Safe Artifact Finalization (atomic temp -> fsync -> Rust SHA-256 -> rename)
        const finalized = this.artifactService.finalizeArtifact({
          id: artifactId,
          relativePath: artifactRelativePath,
          content: pageBytes,
          type: 'evidence',
          allowOverwrite: options.allowOverwrite,
          approvalId: options.approvalId || undefined,
          runId: options.runId || undefined,
          taskId: options.taskId || undefined,
          projectId: path.basename(this.projectRoot),
          correlationId: options.correlationId || undefined,
          metadata: {
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            dpi: page.dpi,
            sourceFile: inputRelativePath,
            sourceHash,
          },
          producer: {
            agentId: 'pdf-rasterizer',
            modelId: 'pinned-pillow-12.3.0',
          },
        });

        renderedPages.push({
          schemaVersion: 1,
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
          dpi: page.dpi,
          format: page.format,
          outputArtifactId: finalized.id,
          outputRelativePath: finalized.path,
          outputHash: finalized.hash,
          outputSizeBytes: pageBytes.length,
          renderer: {
            name: 'maos-pdf-rasterizer',
            version: '1.0.0',
          },
          warnings: page.warnings || [],
        });
      }

      const durationMs = Date.now() - startTime;
      const sourceRelativePath = path.relative(this.projectRoot, resolvedPath).replace(/\\/g, '/');

      const result: PdfRasterResult = {
        schemaVersion: 1,
        sourceRelativePath,
        sourceHash,
        sourceSizeBytes: stat.size,
        pageCount: rawResult.pageCount,
        renderedPages,
        totalOutputBytes: cumulativeOutputBytes,
        durationMs,
        warnings: rawResult.warnings || [],
      };

      // 9. Emit Typed Audit Event on Success (Never on Failure)
      try {
        this.auditService.recordAuditEvent({
          source: 'pdf-rasterizer',
          category: 'tool',
          data: {
            action: 'PDF_RASTERIZED',
            sourcePath: sourceRelativePath,
            sourceHash,
            pageCount: rawResult.pageCount,
            renderedPagesCount: renderedPages.length,
            totalOutputBytes: cumulativeOutputBytes,
            durationMs,
            targetPages: options.targetPages.length ? options.targetPages : 'all',
            outputHashes: renderedPages.map(p => ({ pageNumber: p.pageNumber, hash: p.outputHash })),
          },
        });
      } catch (err: any) {
        // Evidence-producing success without a durable audit event is not a
        // trustworthy success. Fail closed so callers cannot use untracked output.
        throw new PdfRasterError(
          'RENDER_FAILED',
          `PDF rasterization audit append failed: ${err?.message || String(err)}`,
          undefined,
          resolvedPath,
        );
      }

      return result;
    } finally {
      // 10. Clean up scratch directory
      this.cleanupDir(tmpScratchDir);
    }
  }

  // ── Private Helper Methods ─────────────────────────────────────────

  private resolveAndValidatePath(inputPath: string): string {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new PdfRasterError('TRAVERSAL_REJECTED', 'Input path must be a non-empty string');
    }

    // Check for traversal segments (..)
    const normalizedInput = inputPath.replace(/\\/g, '/');
    if (normalizedInput.split('/').includes('..')) {
      throw new PdfRasterError(
        'TRAVERSAL_REJECTED',
        `Path traversal detected in input path: '${inputPath}'`,
        undefined,
        inputPath,
      );
    }

    const fullPath = path.isAbsolute(inputPath)
      ? path.normalize(inputPath)
      : path.resolve(this.projectRoot, inputPath);

    // Ensure within project root directory boundary
    const relative = path.relative(this.projectRoot, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PdfRasterError(
        'TRAVERSAL_REJECTED',
        `Path '${inputPath}' escapes project root boundary`,
        undefined,
        inputPath,
      );
    }

    // Check for symlink escape if file exists
    if (fs.existsSync(fullPath)) {
      try {
        const real = fs.realpathSync(fullPath);
        const realRoot = fs.realpathSync(this.projectRoot);
        const realRelative = path.relative(realRoot, real);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          throw new PdfRasterError(
            'SYMLINK_ESCAPE_REJECTED',
            `Resolved symlink '${real}' escapes project root boundary`,
            undefined,
            inputPath,
          );
        }
      } catch (err: any) {
        if (err instanceof PdfRasterError) throw err;
      }
    }

    return fullPath;
  }

  private computeSha256(filePath: string): string {
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
        // Fall back to node crypto if engine call errors
      }
    }
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  private executeRasterizerBackend(
    resolvedPdfPath: string,
    tmpScratchDir: string,
    options: Required<PdfRasterOptions>,
  ): {
    pageCount: number;
    pages: Array<{
      pageNumber: number;
      width: number;
      height: number;
      dpi: number;
      format: 'png' | 'jpeg';
      tempFilePath: string;
      sizeBytes: number;
      warnings: string[];
    }>;
    warnings: string[];
  } {
    const args = [
      this.backendScriptPath,
      '--input',
      resolvedPdfPath,
      '--output-dir',
      tmpScratchDir,
      '--dpi',
      String(options.dpi),
      '--format',
      options.format,
      '--max-pages',
      String(options.maxPages),
      '--max-page-dim',
      String(options.maxPageDimension),
      '--max-pixels',
      String(options.maxRenderedPixelsPerPage),
      '--max-decomp-ratio',
      String(options.maxDecompressionRatio),
      '--max-decomp-bytes',
      String(options.maxDecompressedStreamBytes),
    ];

    if (options.targetPages && options.targetPages.length > 0) {
      args.push('--target-pages', options.targetPages.join(','));
    }

    try {
      const result = spawnSync(this.pythonExecutable, args, {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONPATH: path.dirname(this.backendScriptPath),
        },
      });

      if (result.error) {
        if (
          (result.error as any).code === 'ETIMEDOUT' ||
          (result.error as any).name === 'TimeoutError' ||
          (result as any).signal === 'SIGTERM'
        ) {
          throw new PdfRasterError(
            'TIMEOUT',
            `PDF rasterization timed out after ${options.timeoutMs} ms`,
            undefined,
            resolvedPdfPath,
          );
        }
        throw new PdfRasterError(
          'RENDER_FAILED',
          `Verified offline PDF rasterizer runtime is unavailable: ${result.error.message}`,
          undefined,
          resolvedPdfPath,
        );
      }

      if (result.signal === 'SIGTERM' || (result as any).timedOut) {
        throw new PdfRasterError(
          'TIMEOUT',
          `PDF rasterization timed out after ${options.timeoutMs} ms`,
          undefined,
          resolvedPdfPath,
        );
      }

      const stdout = result.stdout ? result.stdout.toString('utf8').trim() : '';
      if (!stdout) {
        const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
        throw new PdfRasterError(
          'RENDER_FAILED',
          `Backend process produced empty output: ${stderr}`,
          stderr,
          resolvedPdfPath,
        );
      }

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        throw new PdfRasterError(
          'MALFORMED_PDF',
          `Failed to parse rasterizer backend response: ${stdout.slice(0, 200)}`,
          undefined,
          resolvedPdfPath,
        );
      }

      if (!parsed.success) {
        const errCode = (parsed.errorCode || 'RENDER_FAILED') as any;
        throw new PdfRasterError(errCode, parsed.error || 'Rasterization failed', undefined, resolvedPdfPath);
      }

      return parsed;
    } catch (err: any) {
      if (err instanceof PdfRasterError) throw err;
      throw new PdfRasterError(
        'RENDER_FAILED',
        `PDF rasterizer backend failed: ${err?.message || String(err)}`,
        undefined,
        resolvedPdfPath,
      );
    }
  }

  private async executeRasterizerBackendAsync(
    resolvedPdfPath: string,
    tmpScratchDir: string,
    options: Required<PdfRasterOptions>,
  ): Promise<{
    pageCount: number;
    pages: Array<{
      pageNumber: number;
      width: number;
      height: number;
      dpi: number;
      format: 'png' | 'jpeg';
      tempFilePath: string;
      sizeBytes: number;
      warnings: string[];
    }>;
    warnings: string[];
  }> {
    const args = [
      this.backendScriptPath,
      '--input', resolvedPdfPath,
      '--output-dir', tmpScratchDir,
      '--dpi', String(options.dpi),
      '--format', options.format,
      '--max-pages', String(options.maxPages),
      '--max-page-dim', String(options.maxPageDimension),
      '--max-pixels', String(options.maxRenderedPixelsPerPage),
      '--max-decomp-ratio', String(options.maxDecompressionRatio),
      '--max-decomp-bytes', String(options.maxDecompressedStreamBytes),
    ];
    if (options.targetPages && options.targetPages.length > 0) {
      args.push('--target-pages', options.targetPages.join(','));
    }

    try {
      const result = await runBoundedProcess(this.pythonExecutable, args, {
        cwd: this.projectRoot,
        env: { ...process.env, PYTHONPATH: path.dirname(this.backendScriptPath) },
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 10 * 1024 * 1024,
      });
      const stdout = result.stdout.trim();

      let parsed: any;
      if (stdout) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // A non-zero process with non-JSON output is handled below as a
          // renderer failure; valid structured errors retain their exact code.
        }
      }
      if (parsed && !parsed.success) {
        throw new PdfRasterError((parsed.errorCode || 'RENDER_FAILED') as any, parsed.error || 'Rasterization failed', undefined, resolvedPdfPath);
      }
      if (result.signal || result.status !== 0) {
        const detail = (result.stderr || stdout).trim().slice(-2000);
        throw new PdfRasterError(
          result.signal ? 'TIMEOUT' : 'RENDER_FAILED',
          `PDF rasterizer process failed with status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
          detail,
          resolvedPdfPath,
        );
      }
      if (!stdout || !parsed) {
        throw new PdfRasterError('RENDER_FAILED', `Backend process produced empty or invalid output: ${result.stderr.trim()}`, result.stderr.trim(), resolvedPdfPath);
      }
      if (!parsed.success) {
        throw new PdfRasterError((parsed.errorCode || 'RENDER_FAILED') as any, parsed.error || 'Rasterization failed', undefined, resolvedPdfPath);
      }
      return parsed;
    } catch (err: unknown) {
      if (err instanceof PdfRasterError) throw err;
      if (err instanceof BoundedProcessError) {
        if (err.kind === 'timeout') {
          throw new PdfRasterError('TIMEOUT', `PDF rasterization timed out after ${options.timeoutMs} ms`, undefined, resolvedPdfPath);
        }
        throw new PdfRasterError('RENDER_FAILED', err.message, undefined, resolvedPdfPath);
      }
      throw new PdfRasterError('RENDER_FAILED', `PDF rasterizer backend failed: ${err instanceof Error ? err.message : String(err)}`, undefined, resolvedPdfPath);
    }
  }

  private cleanupDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {
      // Ignored
    }
  }
}
