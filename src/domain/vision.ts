/**
 * MAOS VLM Domain Schemas & Constants
 *
 * Phase F4-04: Benchmark and Pin VLM
 *
 * Defines the pinned Vision-Language Model configuration, resource & latency budgets,
 * snapshot manifests, 3-run benchmark report structures, and error codes.
 */

import type { ValidationResult } from './validators';

function checkField(
  obj: Record<string, unknown>,
  field: string,
  type: 'string' | 'number' | 'boolean' | 'object' | 'array',
  errors: string[],
): boolean {
  const val = obj[field];
  if (val === undefined || val === null || val === '') {
    errors.push(`Missing required field: ${field}`);
    return false;
  }
  if (type === 'string' && typeof val !== 'string') {
    errors.push(`Field "${field}" must be a string, got ${typeof val}`);
    return false;
  }
  if (type === 'number' && (typeof val !== 'number' || Number.isNaN(val))) {
    errors.push(`Field "${field}" must be a number, got ${typeof val}`);
    return false;
  }
  if (type === 'boolean' && typeof val !== 'boolean') {
    errors.push(`Field "${field}" must be a boolean, got ${typeof val}`);
    return false;
  }
  if (type === 'object' && (typeof val !== 'object' || val === null || Array.isArray(val))) {
    errors.push(`Field "${field}" must be an object, got ${typeof val}`);
    return false;
  }
  if (type === 'array' && !Array.isArray(val)) {
    errors.push(`Field "${field}" must be an array, got ${typeof val}`);
    return false;
  }
  return true;
}

// ── Pinned Model Configuration ─────────────────────────────────────

export const PINNED_VLM_CONFIG = {
  modelId: 'Qwen/Qwen2-VL-2B-Instruct',
  modelName: 'qwen2-vl-2b-instruct-local',
  revision: 'aa70c964147048705c93c4e16ff2bc55255470d0',
  architecture: 'Qwen2VLForConditionalGeneration',
  defaultQuantization: 'int4',
  supportedQuantizations: ['int4', 'float16', 'float32'] as const,
  device: 'cuda',
  fallbackDevice: 'cpu',
  parameterCount: '2.21B',
  snapshotRelativePath: 'models--Qwen--Qwen2-VL-2B-Instruct/snapshots/aa70c964147048705c93c4e16ff2bc55255470d0',
} as const;

// ── Resource & Performance Budgets ─────────────────────────────────

export const VLM_MANIFEST_BUDGETS = {
  /** Maximum VRAM allocated to the VLM (6144 MiB / 6.0 GiB) — fits within RTX 4060 Laptop (8188 MiB total, ~6920 MiB idle) */
  maxVramBytes: 6144 * 1024 * 1024,
  maxVramMb: 6144,
  /** Maximum host memory allocated */
  maxHostMemoryMb: 8192,
  /** Context window limit in tokens */
  maxContextTokens: 4096,
  /** Maximum supported single image dimension in pixels (frozen F0-05 limit) */
  maxImageDimension: 4096,
  /** Maximum cold start latency in milliseconds */
  coldStartBudgetMs: 45000,
  coldStartBudgetCpuMs: 180000,
  /** Maximum inference latency in milliseconds for standard multimodal prompt */
  inferenceBudgetMs: 15000,
  inferenceBudgetCpuMs: 60000,
  /** Maximum warm load/switch latency in milliseconds */
  warmStartBudgetMs: 5000,
  warmStartBudgetCpuMs: 15000,
  /** Minimum throughput */
  minTokensPerSecond: 5.0,
  /** Number of required consecutive benchmark iterations */
  benchmarkIterations: 3,
} as const;

// ── Image & Vision Tool Bounds ─────────────────────────────────────

export const VISION_BOUNDS = {
  /** Maximum source image bytes (20 MB) */
  maxSourceBytes: 20 * 1024 * 1024,
  /** Maximum image dimension in pixels (frozen F0-05 limit) */
  maxImageDimension: 4096,
  /** Maximum total image pixels (frozen F0-05 limit) */
  maxImagePixels: 4096 * 4096,
  /** Maximum user prompt length in characters */
  maxPromptLength: 4096,
  /** Maximum requested output tokens */
  maxOutputTokens: 2048,
  /** Default execution timeout in ms */
  timeoutMs: 30000,
  /** Supported image file extensions */
  supportedExtensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] as const,
  /** Supported MIME types */
  supportedMimes: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'] as const,
  /** Supported industrial analysis task types */
  supportedTaskTypes: ['measurement', 'label-reading', 'drawing-observation', 'general-observation'] as const,
} as const;

// ── Types ──────────────────────────────────────────────────────────

export type AnalyzeImageTaskType =
  | 'measurement'
  | 'label-reading'
  | 'drawing-observation'
  | 'general-observation';

export interface AnalyzeImageInput {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sourceArtifactId?: string;
  readonly sourcePath?: string;
  readonly imageHash?: string;
  readonly prompt: string;
  readonly taskType: AnalyzeImageTaskType;
  readonly maxOutputTokens: number;
  readonly requestId: string;
  readonly expectedModelId?: string;
  readonly expectedModelRevision?: string;
  readonly allowCpuFallback?: boolean;
}

export interface ImageObservationBBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceArtifactId: string;
  readonly sourceHash: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly observationType: string;
  readonly value: string;
  readonly confidence: number;
  readonly bbox?: ImageObservationBBox;
  readonly pageNumber?: number;
  readonly warnings: readonly string[];
  readonly requiresReview: boolean;
}

export interface AnalyzeImageResult {
  readonly schemaVersion: 1;
  readonly sourceArtifactId: string;
  readonly sourceHash: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly device: 'cuda' | 'cpu';
  readonly taskType: AnalyzeImageTaskType;
  readonly prompt: string;
  readonly observations: readonly ImageObservation[];
  readonly artifactId?: string;
  readonly artifactHash?: string;
  readonly warnings: readonly string[];
  readonly cached?: boolean;
}

export type VlmQuantization = 'int4' | 'float16' | 'float32';
export type VlmDevice = 'cuda' | 'cpu' | 'mps' | 'auto';

export interface VlmModelConfig {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly quantization: VlmQuantization;
  readonly device: VlmDevice;
  readonly architecture: string;
  readonly vramBudgetMb: number;
  readonly contextTokens: number;
  readonly snapshotPath: string;
  readonly hash: string;
}

export interface VlmSnapshotFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface VlmSnapshotManifest {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly revision: string;
  readonly quantization: string;
  readonly snapshotRelativePath: string;
  readonly files: readonly VlmSnapshotFile[];
  readonly budgets: {
    readonly maxVramMb: number;
    readonly coldStartBudgetMs: number;
    readonly inferenceBudgetMs: number;
    readonly warmStartBudgetMs: number;
  };
}

export interface VlmBenchmarkRun {
  readonly runIndex: number;
  readonly coldStartMs: number;
  readonly inferenceLatencyMs: number;
  readonly vramUsedMb: number;
  readonly memoryPeakMb: number;
  readonly tokensPerSec: number;
  readonly outputHash: string;
  readonly status: 'pass' | 'fail';
  readonly withinBudget: boolean;
  readonly error?: string;
}

export interface VlmBenchmarkSummary {
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly avgColdStartMs: number;
  readonly avgInferenceMs: number;
  readonly maxVramUsedMb: number;
  readonly p95LatencyMs: number;
  readonly allWithinBudget: boolean;
}

export interface VlmBenchmarkReport {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly quantization: string;
  readonly device: string;
  readonly executionMode?: 'measured' | 'simulation';
  readonly runs: readonly VlmBenchmarkRun[];
  readonly summary: VlmBenchmarkSummary;
  readonly budgetPassed: boolean;
  readonly errors: readonly string[];
  readonly timestamp: string;
}

// ── Error Codes ────────────────────────────────────────────────────

export const VLM_ERROR_CODES = {
  OOM_BUDGET_EXCEEDED: 'OOM_BUDGET_EXCEEDED',
  MODEL_UNHEALTHY: 'MODEL_UNHEALTHY',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  NO_RUNTIME_DOWNLOAD: 'NO_RUNTIME_DOWNLOAD',
  CONCURRENCY_VIOLATION: 'CONCURRENCY_VIOLATION',
  BENCHMARK_BUDGET_EXCEEDED: 'BENCHMARK_BUDGET_EXCEEDED',
  INVALID_LEASE_REQUEST: 'INVALID_LEASE_REQUEST',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  SNAPSHOT_MISSING: 'SNAPSHOT_MISSING',
  SNAPSHOT_CORRUPTED: 'SNAPSHOT_CORRUPTED',
  INVALID_SOURCE_REFERENCE: 'INVALID_SOURCE_REFERENCE',
  CONFLICTING_SOURCE: 'CONFLICTING_SOURCE',
  UNSUPPORTED_IMAGE_FORMAT: 'UNSUPPORTED_IMAGE_FORMAT',
  IMAGE_BOUNDS_EXCEEDED: 'IMAGE_BOUNDS_EXCEEDED',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  IMAGE_CORRUPT: 'IMAGE_CORRUPT',
  PROMPT_TOO_LONG: 'PROMPT_TOO_LONG',
  INVALID_TOKEN_REQUEST: 'INVALID_TOKEN_REQUEST',
  UNAUTHORIZED_TOOL_CALL: 'UNAUTHORIZED_TOOL_CALL',
  LEASE_FAILED: 'LEASE_FAILED',
  INFERENCE_FAILED: 'INFERENCE_FAILED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  TRAVERSAL_REJECTED: 'TRAVERSAL_REJECTED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CONCURRENT_MUTATION: 'CONCURRENT_MUTATION',
  MALFORMED_INPUT: 'MALFORMED_INPUT',
  MALFORMED_OUTPUT: 'MALFORMED_OUTPUT',
  MODEL_RUNTIME_UNAVAILABLE: 'MODEL_RUNTIME_UNAVAILABLE',
} as const;

export type VlmErrorCode = (typeof VLM_ERROR_CODES)[keyof typeof VLM_ERROR_CODES];

export class VlmError extends Error {
  readonly code: VlmErrorCode;
  readonly details?: unknown;

  constructor(message: string, code: VlmErrorCode, details?: unknown) {
    super(message);
    this.name = 'VlmError';
    this.code = code;
    this.details = details;
  }
}

// ── Validation Functions ───────────────────────────────────────────

export function validateVlmModelConfig(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['VlmModelConfig must be an object'] };
  }

  const obj = input as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    errors.push('VlmModelConfig.schemaVersion must be 1');
  }

  checkField(obj, 'modelId', 'string', errors);
  checkField(obj, 'modelName', 'string', errors);
  checkField(obj, 'revision', 'string', errors);
  checkField(obj, 'quantization', 'string', errors);
  checkField(obj, 'device', 'string', errors);
  checkField(obj, 'architecture', 'string', errors);
  checkField(obj, 'vramBudgetMb', 'number', errors);
  checkField(obj, 'contextTokens', 'number', errors);
  checkField(obj, 'snapshotPath', 'string', errors);
  checkField(obj, 'hash', 'string', errors);

  if (typeof obj.vramBudgetMb === 'number') {
    if (obj.vramBudgetMb < 1 || obj.vramBudgetMb > VLM_MANIFEST_BUDGETS.maxVramMb) {
      errors.push(`vramBudgetMb must be between 1 and ${VLM_MANIFEST_BUDGETS.maxVramMb}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateVlmSnapshotManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['VlmSnapshotManifest must be an object'] };
  }

  const obj = input as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    errors.push('VlmSnapshotManifest.schemaVersion must be 1');
  }

  checkField(obj, 'model', 'string', errors);
  checkField(obj, 'revision', 'string', errors);
  checkField(obj, 'quantization', 'string', errors);
  checkField(obj, 'snapshotRelativePath', 'string', errors);

  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    errors.push('VlmSnapshotManifest.files must be a non-empty array');
  } else {
    for (let i = 0; i < obj.files.length; i++) {
      const file = obj.files[i];
      if (typeof file !== 'object' || file === null) {
        errors.push(`VlmSnapshotManifest.files[${i}] must be an object`);
        continue;
      }
      if (typeof file.path !== 'string' || !file.path) {
        errors.push(`VlmSnapshotManifest.files[${i}].path is required`);
      }
      if (typeof file.size !== 'number' || file.size <= 0) {
        errors.push(`VlmSnapshotManifest.files[${i}].size must be positive number`);
      }
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
        errors.push(`VlmSnapshotManifest.files[${i}].sha256 must be 64-char hex string`);
      }
    }
  }

  if (typeof obj.budgets !== 'object' || obj.budgets === null) {
    errors.push('VlmSnapshotManifest.budgets is required');
  }

  return { valid: errors.length === 0, errors };
}

export function validateVlmBenchmarkReport(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['VlmBenchmarkReport must be an object'] };
  }

  const obj = input as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    errors.push('VlmBenchmarkReport.schemaVersion must be 1');
  }

  checkField(obj, 'modelId', 'string', errors);
  checkField(obj, 'modelName', 'string', errors);
  checkField(obj, 'revision', 'string', errors);
  checkField(obj, 'quantization', 'string', errors);
  checkField(obj, 'device', 'string', errors);
  checkField(obj, 'budgetPassed', 'boolean', errors);
  checkField(obj, 'timestamp', 'string', errors);

  if (!Array.isArray(obj.runs)) {
    errors.push('VlmBenchmarkReport.runs must be an array');
  } else if (obj.runs.length < VLM_MANIFEST_BUDGETS.benchmarkIterations) {
    errors.push(`VlmBenchmarkReport.runs must contain at least ${VLM_MANIFEST_BUDGETS.benchmarkIterations} runs`);
  }

  if (typeof obj.summary !== 'object' || obj.summary === null) {
    errors.push('VlmBenchmarkReport.summary is required');
  }

  return { valid: errors.length === 0, errors };
}

export function validateAnalyzeImageInput(input: unknown): AnalyzeImageInput {
  if (!input || typeof input !== 'object') {
    throw new VlmError('analyze_image input must be an object', VLM_ERROR_CODES.MALFORMED_INPUT);
  }
  const i = input as Record<string, unknown>;

  if (i.schemaVersion !== 1) {
    throw new VlmError(
      `analyze_image input.schemaVersion must be 1, received ${i.schemaVersion}`,
      VLM_ERROR_CODES.MALFORMED_INPUT,
    );
  }

  if (typeof i.projectId !== 'string' || !i.projectId.trim()) {
    throw new VlmError('analyze_image input.projectId must be a non-empty string', VLM_ERROR_CODES.MALFORMED_INPUT);
  }

  const hasPath = typeof i.sourcePath === 'string' && i.sourcePath.trim().length > 0;
  const hasArtifact = typeof i.sourceArtifactId === 'string' && i.sourceArtifactId.trim().length > 0;

  if (!hasPath && !hasArtifact) {
    throw new VlmError(
      'analyze_image requires exactly one source reference: sourcePath or sourceArtifactId',
      VLM_ERROR_CODES.INVALID_SOURCE_REFERENCE,
    );
  }

  if (hasPath && hasArtifact) {
    throw new VlmError(
      'Conflicting source references: both sourcePath and sourceArtifactId were provided',
      VLM_ERROR_CODES.CONFLICTING_SOURCE,
    );
  }

  let normPath: string | undefined;
  if (hasPath) {
    const rawPath = (i.sourcePath as string).trim();
    normPath = rawPath.replace(/\\/g, '/');
    if (normPath.includes('../') || normPath.startsWith('../') || normPath === '..' || normPath.includes('\0')) {
      throw new VlmError(`Path traversal rejected: '${rawPath}'`, VLM_ERROR_CODES.TRAVERSAL_REJECTED);
    }
    const ext = (normPath.split('.').pop() || '').toLowerCase();
    const dotExt = `.${ext}`;
    if (!VISION_BOUNDS.supportedExtensions.includes(dotExt as any)) {
      throw new VlmError(
        `Unsupported image format '.${ext}'. Supported formats: ${VISION_BOUNDS.supportedExtensions.join(', ')}`,
        VLM_ERROR_CODES.UNSUPPORTED_IMAGE_FORMAT,
      );
    }
  }

  if (typeof i.prompt !== 'string' || !i.prompt.trim()) {
    throw new VlmError('analyze_image input.prompt must be a non-empty string', VLM_ERROR_CODES.MALFORMED_INPUT);
  }
  if (i.prompt.length > VISION_BOUNDS.maxPromptLength) {
    throw new VlmError(
      `analyze_image prompt length (${i.prompt.length}) exceeds maximum of ${VISION_BOUNDS.maxPromptLength}`,
      VLM_ERROR_CODES.PROMPT_TOO_LONG,
    );
  }

  if (
    typeof i.taskType !== 'string' ||
    !VISION_BOUNDS.supportedTaskTypes.includes(i.taskType as any)
  ) {
    throw new VlmError(
      `Invalid taskType '${i.taskType}'. Supported task types: ${VISION_BOUNDS.supportedTaskTypes.join(', ')}`,
      VLM_ERROR_CODES.MALFORMED_INPUT,
    );
  }

  if (
    typeof i.maxOutputTokens !== 'number' ||
    !Number.isInteger(i.maxOutputTokens) ||
    i.maxOutputTokens < 1 ||
    i.maxOutputTokens > VISION_BOUNDS.maxOutputTokens
  ) {
    throw new VlmError(
      `maxOutputTokens must be an integer between 1 and ${VISION_BOUNDS.maxOutputTokens}, received ${i.maxOutputTokens}`,
      VLM_ERROR_CODES.INVALID_TOKEN_REQUEST,
    );
  }

  if (typeof i.requestId !== 'string' || !i.requestId.trim()) {
    throw new VlmError('analyze_image input.requestId must be a non-empty string', VLM_ERROR_CODES.MALFORMED_INPUT);
  }

  let imageHash: string | undefined;
  if (i.imageHash !== undefined && i.imageHash !== null) {
    if (typeof i.imageHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(i.imageHash)) {
      throw new VlmError(
        'analyze_image input.imageHash must be a 64-character hex SHA-256 string',
        VLM_ERROR_CODES.MALFORMED_INPUT,
      );
    }
    imageHash = i.imageHash.toLowerCase();
  }

  let expectedModelId: string | undefined;
  if (i.expectedModelId !== undefined && i.expectedModelId !== null) {
    if (typeof i.expectedModelId !== 'string' || !i.expectedModelId.trim()) {
      throw new VlmError('expectedModelId must be a non-empty string if specified', VLM_ERROR_CODES.MALFORMED_INPUT);
    }
    expectedModelId = i.expectedModelId.trim();
  }

  let expectedModelRevision: string | undefined;
  if (i.expectedModelRevision !== undefined && i.expectedModelRevision !== null) {
    if (typeof i.expectedModelRevision !== 'string' || !i.expectedModelRevision.trim()) {
      throw new VlmError('expectedModelRevision must be a non-empty string if specified', VLM_ERROR_CODES.MALFORMED_INPUT);
    }
    expectedModelRevision = i.expectedModelRevision.trim();
  }

  return {
    schemaVersion: 1,
    projectId: (i.projectId as string).trim(),
    sourcePath: normPath,
    sourceArtifactId: hasArtifact ? (i.sourceArtifactId as string).trim() : undefined,
    imageHash,
    prompt: i.prompt,
    taskType: i.taskType as AnalyzeImageTaskType,
    maxOutputTokens: i.maxOutputTokens,
    requestId: (i.requestId as string).trim(),
    expectedModelId,
    expectedModelRevision,
    allowCpuFallback: typeof i.allowCpuFallback === 'boolean' ? i.allowCpuFallback : undefined,
  };
}

export function validateImageObservation(input: unknown): ImageObservation {
  if (!input || typeof input !== 'object') {
    throw new VlmError('ImageObservation must be an object', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  const o = input as Record<string, unknown>;

  if (o.schemaVersion !== 1) {
    throw new VlmError(`ImageObservation.schemaVersion must be 1, received ${o.schemaVersion}`, VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }

  if (typeof o.id !== 'string' || !o.id.trim()) {
    throw new VlmError('ImageObservation.id must be a non-empty string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.sourceArtifactId !== 'string') {
    throw new VlmError('ImageObservation.sourceArtifactId must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(o.sourceHash)) {
    throw new VlmError('ImageObservation.sourceHash must be a 64-character hex SHA-256 string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.modelId !== 'string' || !o.modelId.trim()) {
    throw new VlmError('ImageObservation.modelId must be a non-empty string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.modelRevision !== 'string' || !o.modelRevision.trim()) {
    throw new VlmError('ImageObservation.modelRevision must be a non-empty string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.observationType !== 'string' || !o.observationType.trim()) {
    throw new VlmError('ImageObservation.observationType must be a non-empty string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.value !== 'string') {
    throw new VlmError('ImageObservation.value must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) {
    throw new VlmError('ImageObservation.confidence must be a number between 0.0 and 1.0', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof o.requiresReview !== 'boolean') {
    throw new VlmError('ImageObservation.requiresReview must be a boolean', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }

  let bbox: ImageObservationBBox | undefined;
  if (o.bbox !== undefined && o.bbox !== null) {
    if (typeof o.bbox !== 'object') {
      throw new VlmError('ImageObservation.bbox must be an object', VLM_ERROR_CODES.MALFORMED_OUTPUT);
    }
    const b = o.bbox as Record<string, unknown>;
    if (typeof b.x !== 'number' || b.x < 0 || typeof b.y !== 'number' || b.y < 0 ||
        typeof b.width !== 'number' || b.width < 0 || typeof b.height !== 'number' || b.height < 0) {
      throw new VlmError('ImageObservation.bbox coordinates must be non-negative numbers', VLM_ERROR_CODES.MALFORMED_OUTPUT);
    }
    bbox = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    };
  }

  const warnings = Array.isArray(o.warnings)
    ? o.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  return {
    schemaVersion: 1,
    id: o.id.trim(),
    sourceArtifactId: o.sourceArtifactId.trim(),
    sourceHash: o.sourceHash.toLowerCase(),
    modelId: o.modelId.trim(),
    modelRevision: o.modelRevision.trim(),
    observationType: o.observationType.trim(),
    value: o.value,
    confidence: o.confidence,
    bbox,
    pageNumber: typeof o.pageNumber === 'number' && o.pageNumber >= 1 ? Math.floor(o.pageNumber) : undefined,
    warnings,
    requiresReview: o.requiresReview,
  };
}

export function validateAnalyzeImageResult(input: unknown): AnalyzeImageResult {
  if (!input || typeof input !== 'object') {
    throw new VlmError('AnalyzeImageResult must be an object', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  const r = input as Record<string, unknown>;

  if (r.schemaVersion !== 1) {
    throw new VlmError(`AnalyzeImageResult.schemaVersion must be 1, received ${r.schemaVersion}`, VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }

  if (typeof r.sourceArtifactId !== 'string') {
    throw new VlmError('AnalyzeImageResult.sourceArtifactId must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof r.sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(r.sourceHash)) {
    throw new VlmError('AnalyzeImageResult.sourceHash must be a 64-character hex SHA-256 string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof r.modelId !== 'string') {
    throw new VlmError('AnalyzeImageResult.modelId must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof r.modelRevision !== 'string') {
    throw new VlmError('AnalyzeImageResult.modelRevision must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (r.device !== 'cuda' && r.device !== 'cpu') {
    throw new VlmError(`AnalyzeImageResult.device must be 'cuda' or 'cpu', received ${r.device}`, VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (typeof r.prompt !== 'string') {
    throw new VlmError('AnalyzeImageResult.prompt must be a string', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }
  if (!Array.isArray(r.observations)) {
    throw new VlmError('AnalyzeImageResult.observations must be an array', VLM_ERROR_CODES.MALFORMED_OUTPUT);
  }

  const observations = r.observations.map(validateImageObservation);
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  return {
    schemaVersion: 1,
    sourceArtifactId: r.sourceArtifactId,
    sourceHash: r.sourceHash.toLowerCase(),
    modelId: r.modelId,
    modelRevision: r.modelRevision,
    device: r.device,
    taskType: r.taskType as AnalyzeImageTaskType,
    prompt: r.prompt,
    observations,
    artifactId: typeof r.artifactId === 'string' ? r.artifactId : undefined,
    artifactHash: typeof r.artifactHash === 'string' ? r.artifactHash : undefined,
    warnings,
    cached: typeof r.cached === 'boolean' ? r.cached : undefined,
  };
}

