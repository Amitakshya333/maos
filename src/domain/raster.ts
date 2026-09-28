/**
 * MAOS Domain: Bounded PDF Rasterization Specifications (F4-01)
 *
 * Defines versioned schemas, options, metadata, and error types
 * for bounded, offline, project-confined PDF rasterization.
 */

// ── Security & Operational Bounds ─────────────────────────────────

export const RASTER_BOUNDS = {
  DEFAULT_MAX_SOURCE_BYTES: 50 * 1024 * 1024,      // 50 MB
  ABSOLUTE_MAX_SOURCE_BYTES: 50 * 1024 * 1024,     // frozen PDF limit
  // Frozen F0-05 production limits. Defaults and caller overrides may not exceed them.
  DEFAULT_MAX_PAGES: 20,
  ABSOLUTE_MAX_PAGES: 20,
  DEFAULT_MAX_PAGE_DIMENSION: 4096,                // bounded page dimension
  DEFAULT_MAX_RENDERED_PIXELS_PER_PAGE: 4096 * 4096,
  DEFAULT_MAX_TOTAL_OUTPUT_BYTES: 100 * 1024 * 1024, // 100 MB
  DEFAULT_MAX_DECOMPRESSION_RATIO: 100,            // 100:1 expansion limit
  DEFAULT_MAX_DECOMPRESSED_STREAM_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_PAGE_DIMENSION: 4096,
  MAX_RENDERED_PIXELS_PER_PAGE: 4096 * 4096,
  DEFAULT_TIMEOUT_MS: 30_000,                      // 30 seconds
  MAX_TIMEOUT_MS: 120_000,                         // 2 minutes
  DEFAULT_DPI: 150,
  MIN_DPI: 72,
  MAX_DPI: 600,
} as const;

// ── Error Codes ───────────────────────────────────────────────────

export type PdfRasterErrorCode =
  | 'NOT_FOUND'
  | 'TRAVERSAL_REJECTED'
  | 'SYMLINK_ESCAPE_REJECTED'
  | 'INVALID_MIME'
  | 'INVALID_EXTENSION'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'OVERSIZED_PAGE_DIMENSIONS'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'DECOMPRESSION_BOMB_DETECTED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'MALFORMED_PDF'
  | 'ENCRYPTED_PDF_UNSUPPORTED'
  | 'TIMEOUT'
  | 'OUT_OF_BOUNDS_PAGE'
  | 'RENDER_FAILED';

export class PdfRasterError extends Error {
  public readonly code: PdfRasterErrorCode;
  public readonly details?: string;
  public readonly path?: string;

  constructor(code: PdfRasterErrorCode, message: string, details?: string, filePath?: string) {
    super(message);
    this.name = 'PdfRasterError';
    this.code = code;
    this.details = details;
    this.path = filePath;
    Object.setPrototypeOf(this, PdfRasterError.prototype);
  }
}

// ── Options & Interfaces ──────────────────────────────────────────

export interface PdfRasterOptions {
  /** Maximum allowable source file size in bytes (default 50 MB). */
  maxSourceBytes?: number;
  /** Maximum number of pages allowed in the document (default 100). */
  maxPages?: number;
  /** Maximum page dimension (width or height) in points (default 10,000 pt). */
  maxPageDimension?: number;
  /** Maximum rendered pixels allowed per page (default 25,000,000 px). */
  maxRenderedPixelsPerPage?: number;
  /** Maximum cumulative output bytes across all rendered pages (default 100 MB). */
  maxTotalOutputBytes?: number;
  /** Maximum stream decompression expansion ratio (default 100x). */
  maxDecompressionRatio?: number;
  /** Maximum decompressed bytes for an individual stream (default 25 MB). */
  maxDecompressedStreamBytes?: number;
  /** Rendering timeout in milliseconds (default 30,000 ms). */
  timeoutMs?: number;
  /** Target resolution DPI (default 150). */
  dpi?: number;
  /** Output image format ('png' | 'jpeg', default 'png'). */
  format?: 'png' | 'jpeg';
  /** Specific 1-indexed page numbers to render. If omitted or empty, all pages are rendered. */
  targetPages?: number[];
  /** Whether to allow overwriting previously rasterized artifacts (default true). */
  allowOverwrite?: boolean;
  /** Explicit human approval ID for overwriting existing artifacts (required if already exists). */
  approvalId?: string;
  /** Optional correlation context */
  runId?: string;
  taskId?: string;
  correlationId?: string;
}

export interface RasterPageMetadata {
  readonly schemaVersion: 1;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
  readonly format: 'png' | 'jpeg';
  readonly outputArtifactId: string;
  readonly outputRelativePath: string;
  readonly outputHash: string;
  readonly outputSizeBytes: number;
  readonly renderer: {
    readonly name: string;
    readonly version: string;
  };
  readonly warnings: string[];
}

export interface PdfRasterResult {
  readonly schemaVersion: 1;
  readonly sourceRelativePath: string;
  readonly sourceHash: string;
  readonly sourceSizeBytes: number;
  readonly pageCount: number;
  readonly renderedPages: RasterPageMetadata[];
  readonly totalOutputBytes: number;
  readonly durationMs: number;
  readonly warnings: string[];
}

/**
 * Validates and normalizes PDF raster options against bounded constraints.
 */
export function validatePdfRasterOptions(options: PdfRasterOptions = {}): Required<PdfRasterOptions> {
  const maxSourceBytes = Math.min(
    Math.max(1, options.maxSourceBytes ?? RASTER_BOUNDS.DEFAULT_MAX_SOURCE_BYTES),
    RASTER_BOUNDS.ABSOLUTE_MAX_SOURCE_BYTES,
  );

  const maxPages = Math.min(
    Math.max(1, options.maxPages ?? RASTER_BOUNDS.DEFAULT_MAX_PAGES),
    RASTER_BOUNDS.ABSOLUTE_MAX_PAGES,
  );

  const maxPageDimension = Math.min(
    Math.max(1, options.maxPageDimension ?? RASTER_BOUNDS.DEFAULT_MAX_PAGE_DIMENSION),
    RASTER_BOUNDS.MAX_PAGE_DIMENSION,
  );

  const maxRenderedPixelsPerPage = Math.min(
    Math.max(1, options.maxRenderedPixelsPerPage ?? RASTER_BOUNDS.DEFAULT_MAX_RENDERED_PIXELS_PER_PAGE),
    RASTER_BOUNDS.MAX_RENDERED_PIXELS_PER_PAGE,
  );

  const maxTotalOutputBytes = Math.max(
    1,
    options.maxTotalOutputBytes ?? RASTER_BOUNDS.DEFAULT_MAX_TOTAL_OUTPUT_BYTES,
  );

  const maxDecompressionRatio = Math.max(
    1,
    options.maxDecompressionRatio ?? RASTER_BOUNDS.DEFAULT_MAX_DECOMPRESSION_RATIO,
  );

  const maxDecompressedStreamBytes = Math.max(
    1,
    options.maxDecompressedStreamBytes ?? RASTER_BOUNDS.DEFAULT_MAX_DECOMPRESSED_STREAM_BYTES,
  );

  const timeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? RASTER_BOUNDS.DEFAULT_TIMEOUT_MS),
    RASTER_BOUNDS.MAX_TIMEOUT_MS,
  );

  const dpi = Math.min(
    Math.max(RASTER_BOUNDS.MIN_DPI, options.dpi ?? RASTER_BOUNDS.DEFAULT_DPI),
    RASTER_BOUNDS.MAX_DPI,
  );

  const format: 'png' | 'jpeg' = options.format === 'jpeg' ? 'jpeg' : 'png';

  const targetPages = Array.isArray(options.targetPages)
    ? options.targetPages.filter(p => typeof p === 'number' && Number.isInteger(p) && p >= 1)
    : [];

  const allowOverwrite = options.allowOverwrite ?? true;

  return {
    maxSourceBytes,
    maxPages,
    maxPageDimension,
    maxRenderedPixelsPerPage,
    maxTotalOutputBytes,
    maxDecompressionRatio,
    maxDecompressedStreamBytes,
    timeoutMs,
    dpi,
    format,
    targetPages,
    allowOverwrite,
    approvalId: options.approvalId ?? '',
    runId: options.runId ?? '',
    taskId: options.taskId ?? '',
    correlationId: options.correlationId ?? '',
  };
}
