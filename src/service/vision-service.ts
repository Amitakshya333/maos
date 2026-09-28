/**
 * MAOS Application Service: Local Vision & VLM Analysis (F4-05)
 *
 * Implements bounded, local-only visual observation extraction using
 * the pinned Vision-Language Model (Qwen/Qwen2-VL-2B-Instruct).
 *
 * Invariant: Visual observations are NEVER converted directly into safety verdicts.
 * All measurements and findings require independent review and are strictly separated
 * from OCR facts until multi-modal conflict review (F4-06).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { BoundedProcessError, runBoundedProcess } from '../industrial/async-process';
import {
  VISION_BOUNDS,
  PINNED_VLM_CONFIG,
  VLM_ERROR_CODES,
  VlmError,
  AnalyzeImageInput,
  ImageObservation,
  AnalyzeImageResult,
  validateAnalyzeImageInput,
  validateImageObservation,
  validateAnalyzeImageResult,
} from '../domain/vision';
import { ModelLease } from '../domain/schemas';
import { ArtifactService } from './artifact-service';
import { AuditService } from './audit-service';
import { SharedModelManager, AcquireLeaseOptions } from './model-manager';
import { engineHash, getDefaultEnginePath, verifyExecutable } from '../industrial/rust-engine-bridge';

export interface VisionServiceOptions {
  pythonExecutable?: string;
  backendScriptPath?: string;
  forceFallback?: boolean;
  inferenceHandler?: (
    input: AnalyzeImageInput,
    imagePath: string,
    lease: ModelLease,
  ) => Promise<ImageObservation[]> | ImageObservation[];
}

export class VisionService {
  private readonly projectRoot: string;
  private readonly artifactService: ArtifactService;
  private readonly auditService: AuditService;
  private readonly modelManager: SharedModelManager;
  private readonly pythonExecutable: string;
  private readonly backendScriptPath: string;
  private readonly options: VisionServiceOptions;

  constructor(
    projectRoot: string,
    artifactService?: ArtifactService,
    auditService?: AuditService,
    modelManager?: SharedModelManager,
    options: VisionServiceOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.artifactService = artifactService || new ArtifactService(this.projectRoot);
    this.auditService = auditService || new AuditService(this.projectRoot);
    this.modelManager = modelManager || SharedModelManager.getInstance(this.projectRoot);
    this.options = options;
    this.pythonExecutable = options.pythonExecutable || 'python';
    this.backendScriptPath =
      options.backendScriptPath ||
      path.resolve(__dirname, '..', 'industrial', 'python', 'vlm_engine.py');
  }

  /**
   * Asynchronous image analysis with pinned VLM.
   */
  public async analyzeImage(
    rawInput: unknown,
    callerAgentId?: string,
  ): Promise<AnalyzeImageResult> {
    const validatedInput = validateAnalyzeImageInput(rawInput);
    const { resolvedPath, effectiveSourceArtifactId, ext } = this.resolveSource(validatedInput);

    this.validateImageFormatAndBounds(resolvedPath, ext);
    const sourceHash = this.computeSourceHash(resolvedPath);

    if (validatedInput.imageHash && validatedInput.imageHash !== sourceHash) {
      throw new VlmError(
        `Image hash mismatch: expected '${validatedInput.imageHash}', calculated '${sourceHash}'`,
        VLM_ERROR_CODES.MALFORMED_INPUT,
      );
    }

    const modelId = validatedInput.expectedModelId || PINNED_VLM_CONFIG.modelId;
    const revision = validatedInput.expectedModelRevision || PINNED_VLM_CONFIG.revision;

    const leaseOptions: AcquireLeaseOptions = {
      modelId,
      agentId: callerAgentId || 'vision-service',
      priority: 'user_task',
      expectedRevision: revision,
      allowCpuFallback: validatedInput.allowCpuFallback ?? false,
    };

    const lease = await this.modelManager.acquireLease(leaseOptions);
    try {
      let observations: ImageObservation[];
      if (this.options.inferenceHandler) {
        const handlerRes = this.options.inferenceHandler(validatedInput, resolvedPath, lease);
        observations = Array.isArray(handlerRes) ? handlerRes : await handlerRes;
      } else if (this.options.forceFallback) {
        throw new VlmError(
          'Synthetic VLM fallback is disabled; a verified offline model runtime is required.',
          VLM_ERROR_CODES.MODEL_RUNTIME_UNAVAILABLE,
        );
      } else if (!fs.existsSync(this.backendScriptPath)) {
        throw new VlmError(
          `Offline VLM backend not found at ${this.backendScriptPath}`,
          VLM_ERROR_CODES.MODEL_RUNTIME_UNAVAILABLE,
        );
      } else {
        observations = await this.runPythonInference(
          resolvedPath,
          validatedInput,
          lease,
          sourceHash,
          effectiveSourceArtifactId,
        );
      }

      observations = observations.map((observation) =>
        validateImageObservation(this.normalizeObservation(
          observation,
          validatedInput,
          lease,
          sourceHash,
          effectiveSourceArtifactId,
        )),
      );

      return this.finalizeAndAudit(
        validatedInput,
        effectiveSourceArtifactId,
        sourceHash,
        lease,
        observations,
        callerAgentId,
      );
    } finally {
      this.modelManager.releaseLease(lease.id);
    }
  }

  /**
   * Synchronous image analysis with pinned VLM.
   */
  public analyzeImageSync(
    rawInput: unknown,
    callerAgentId?: string,
  ): AnalyzeImageResult {
    const validatedInput = validateAnalyzeImageInput(rawInput);
    const { resolvedPath, effectiveSourceArtifactId, ext } = this.resolveSource(validatedInput);

    this.validateImageFormatAndBounds(resolvedPath, ext);
    const sourceHash = this.computeSourceHash(resolvedPath);

    if (validatedInput.imageHash && validatedInput.imageHash !== sourceHash) {
      throw new VlmError(
        `Image hash mismatch: expected '${validatedInput.imageHash}', calculated '${sourceHash}'`,
        VLM_ERROR_CODES.MALFORMED_INPUT,
      );
    }

    const modelId = validatedInput.expectedModelId || PINNED_VLM_CONFIG.modelId;
    const revision = validatedInput.expectedModelRevision || PINNED_VLM_CONFIG.revision;

    const leaseOptions: AcquireLeaseOptions = {
      modelId,
      agentId: callerAgentId || 'vision-service',
      priority: 'user_task',
      expectedRevision: revision,
      allowCpuFallback: validatedInput.allowCpuFallback ?? false,
    };

    const lease = this.modelManager.acquireLeaseSync(leaseOptions);
    try {
      let observations: ImageObservation[];
      if (this.options.inferenceHandler) {
        const handlerRes = this.options.inferenceHandler(validatedInput, resolvedPath, lease);
        if (handlerRes instanceof Promise) {
          throw new VlmError('Async inferenceHandler cannot be used in analyzeImageSync', VLM_ERROR_CODES.INFERENCE_FAILED);
        }
        observations = handlerRes;
      } else if (this.options.forceFallback) {
        throw new VlmError(
          'Synthetic VLM fallback is disabled; a verified offline model runtime is required.',
          VLM_ERROR_CODES.MODEL_RUNTIME_UNAVAILABLE,
        );
      } else if (!fs.existsSync(this.backendScriptPath)) {
        throw new VlmError(
          `Offline VLM backend not found at ${this.backendScriptPath}`,
          VLM_ERROR_CODES.MODEL_RUNTIME_UNAVAILABLE,
        );
      } else {
        observations = this.runPythonInferenceSync(
          resolvedPath,
          validatedInput,
          lease,
          sourceHash,
          effectiveSourceArtifactId,
        );
      }

      observations = observations.map((observation) =>
        validateImageObservation(this.normalizeObservation(
          observation,
          validatedInput,
          lease,
          sourceHash,
          effectiveSourceArtifactId,
        )),
      );

      return this.finalizeAndAudit(
        validatedInput,
        effectiveSourceArtifactId,
        sourceHash,
        lease,
        observations,
        callerAgentId,
      );
    } finally {
      this.modelManager.releaseLease(lease.id);
    }
  }

  // ── Source Resolution & Validation ─────────────────────────────────

  private resolveSource(input: AnalyzeImageInput): {
    resolvedPath: string;
    effectiveSourceArtifactId: string;
    ext: string;
  } {
    if (input.sourcePath) {
      const resolved = this.resolveAndValidatePath(input.sourcePath);
      if (!fs.existsSync(resolved)) {
        throw new VlmError(`Image file not found: '${input.sourcePath}'`, VLM_ERROR_CODES.IMAGE_NOT_FOUND);
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        throw new VlmError(`Path is not a regular file: '${input.sourcePath}'`, VLM_ERROR_CODES.IMAGE_NOT_FOUND);
      }
      const ext = path.extname(resolved).toLowerCase();
      return {
        resolvedPath: resolved,
        effectiveSourceArtifactId: input.sourcePath.replace(/\\/g, '/'),
        ext,
      };
    }

    if (input.sourceArtifactId) {
      const artifact = this.artifactService.getArtifact(input.sourceArtifactId);
      if (!artifact) {
        throw new VlmError(
          `Artifact not found in store: '${input.sourceArtifactId}'`,
          VLM_ERROR_CODES.IMAGE_NOT_FOUND,
        );
      }
      const artifactPath = artifact.path || (artifact as any).relativePath;
      const resolved = path.resolve(this.projectRoot, artifactPath);
      if (!fs.existsSync(resolved)) {
        throw new VlmError(
          `Artifact content missing on disk: '${artifactPath}'`,
          VLM_ERROR_CODES.IMAGE_NOT_FOUND,
        );
      }
      const ext = path.extname(resolved).toLowerCase();
      if (!VISION_BOUNDS.supportedExtensions.includes(ext as any)) {
        throw new VlmError(
          `Artifact has unsupported image format '${ext}'`,
          VLM_ERROR_CODES.UNSUPPORTED_IMAGE_FORMAT,
        );
      }
      return {
        resolvedPath: resolved,
        effectiveSourceArtifactId: input.sourceArtifactId,
        ext,
      };
    }

    throw new VlmError(
      'analyze_image requires exactly one source reference',
      VLM_ERROR_CODES.INVALID_SOURCE_REFERENCE,
    );
  }

  private resolveAndValidatePath(inputPath: string): string {
    const norm = inputPath.replace(/\\/g, '/');
    if (norm.includes('../') || norm.startsWith('../') || norm === '..' || norm.includes('\0')) {
      throw new VlmError(`Path traversal rejected: '${inputPath}'`, VLM_ERROR_CODES.TRAVERSAL_REJECTED);
    }
    const resolved = path.resolve(this.projectRoot, inputPath);
    const relative = path.relative(this.projectRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new VlmError(`Path escapes project root: '${inputPath}'`, VLM_ERROR_CODES.TRAVERSAL_REJECTED);
    }
    if (fs.existsSync(resolved)) {
      const realRoot = fs.realpathSync(this.projectRoot);
      const realFile = fs.realpathSync(resolved);
      const realRel = path.relative(realRoot, realFile);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new VlmError(`Symlink target escapes project root: '${inputPath}'`, VLM_ERROR_CODES.TRAVERSAL_REJECTED);
      }
    }
    return resolved;
  }

  // ── Header, Bounds, and Hash Checking ──────────────────────────────

  private validateImageFormatAndBounds(
    filePath: string,
    ext: string,
  ): { width?: number; height?: number } {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      throw new VlmError(`Image file is empty (0 bytes): '${filePath}'`, VLM_ERROR_CODES.IMAGE_CORRUPT);
    }
    if (stat.size > VISION_BOUNDS.maxSourceBytes) {
      throw new VlmError(
        `Image size (${stat.size} bytes) exceeds limit of ${VISION_BOUNDS.maxSourceBytes} bytes`,
        VLM_ERROR_CODES.IMAGE_BOUNDS_EXCEEDED,
      );
    }

    const readLen = Math.min(64, stat.size);
    const header = Buffer.alloc(readLen);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, header, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }

    const isPng =
      header.length >= 8 &&
      header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg =
      header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const isBmp =
      header.length >= 2 && header.subarray(0, 2).equals(Buffer.from([0x42, 0x4d]));
    const isWebp =
      header.length >= 12 &&
      header.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
      header.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]));

    if (!isPng && !isJpeg && !isBmp && !isWebp) {
      throw new VlmError(
        `Invalid or unsupported image magic bytes for '${filePath}'`,
        VLM_ERROR_CODES.UNSUPPORTED_IMAGE_FORMAT,
      );
    }

    // Read full or larger header to extract dimensions
    const dimHeaderLen = Math.min(4096, stat.size);
    let dimBuffer = header;
    if (stat.size > readLen) {
      const fd2 = fs.openSync(filePath, 'r');
      dimBuffer = Buffer.alloc(dimHeaderLen);
      try {
        fs.readSync(fd2, dimBuffer, 0, dimHeaderLen, 0);
      } finally {
        fs.closeSync(fd2);
      }
    }

    const dims = this.extractDimensions(dimBuffer, ext);
    if (dims) {
      if (
        dims.width > VISION_BOUNDS.maxImageDimension ||
        dims.height > VISION_BOUNDS.maxImageDimension
      ) {
        throw new VlmError(
          `Image dimensions (${dims.width}x${dims.height}) exceed limit ${VISION_BOUNDS.maxImageDimension}`,
          VLM_ERROR_CODES.IMAGE_BOUNDS_EXCEEDED,
        );
      }
      if (dims.width * dims.height > VISION_BOUNDS.maxImagePixels) {
        throw new VlmError(
          `Total image pixels (${dims.width * dims.height}) exceed limit ${VISION_BOUNDS.maxImagePixels}`,
          VLM_ERROR_CODES.IMAGE_BOUNDS_EXCEEDED,
        );
      }
    }

    return dims || {};
  }

  private extractDimensions(
    buffer: Buffer,
    ext: string,
  ): { width: number; height: number } | null {
    try {
      if (ext === '.png' && buffer.length >= 24) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }
      if (ext === '.bmp' && buffer.length >= 26) {
        const dibSize = buffer.readUInt32LE(14);
        if (dibSize === 12 && buffer.length >= 22) {
          return {
            width: buffer.readUInt16LE(18),
            height: buffer.readUInt16LE(20),
          };
        } else if (dibSize >= 40 && buffer.length >= 26) {
          return {
            width: Math.abs(buffer.readInt32LE(18)),
            height: Math.abs(buffer.readInt32LE(22)),
          };
        }
      }
      if ((ext === '.jpg' || ext === '.jpeg') && buffer.length >= 4) {
        let offset = 2;
        while (offset < buffer.length - 8) {
          if (buffer[offset] !== 0xff) {
            offset++;
            continue;
          }
          const marker = buffer[offset + 1];
          if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
          ) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7),
            };
          }
          if (marker === 0xda || marker === 0xd9) break;
          const length = buffer.readUInt16BE(offset + 2);
          if (length < 2) break;
          offset += 2 + length;
        }
      }
      if (ext === '.webp' && buffer.length >= 30) {
        const chunkType = buffer.subarray(12, 16).toString('ascii');
        if (chunkType === 'VP8 ' && buffer.length >= 30) {
          return {
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff,
          };
        }
        if (chunkType === 'VP8L' && buffer.length >= 25) {
          const val = buffer.readUInt32LE(21);
          return {
            width: (val & 0x3fff) + 1,
            height: ((val >> 14) & 0x3fff) + 1,
          };
        }
        if (chunkType === 'VP8X' && buffer.length >= 30) {
          return {
            width: 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16),
            height: 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16),
          };
        }
      }
    } catch {
      return null;
    }
    return null;
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
        // fallback to crypto
      }
    }
    return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  }

  // ── Inference Execution ────────────────────────────────────────────

  private buildPythonArgs(
    imagePath: string,
    outputPath: string,
    input: AnalyzeImageInput,
    lease: ModelLease,
  ): string[] {
    const registration = this.modelManager.getModelRegistration(lease.modelId);
    const modelPath = registration?.snapshotPath;
    if (!modelPath) {
      throw new VlmError(
        `No verified local snapshot is registered for '${lease.modelId}'`,
        VLM_ERROR_CODES.SNAPSHOT_MISSING,
      );
    }
    return [
      this.backendScriptPath,
      '--image', imagePath,
      '--output', outputPath,
      '--task-type', input.taskType,
      '--prompt', input.prompt,
      '--max-tokens', String(input.maxOutputTokens),
      '--model-id', lease.modelId,
      '--revision', input.expectedModelRevision || PINNED_VLM_CONFIG.revision,
      '--device', (registration.device as 'cuda' | 'cpu') || 'cuda',
      '--model-path', modelPath,
      '--source-artifact-id', input.sourceArtifactId || input.sourcePath || 'unknown',
    ];
  }

  private readPythonOutput(tmpJsonPath: string): ImageObservation[] {
    if (!fs.existsSync(tmpJsonPath)) {
      throw new VlmError('VLM backend did not produce an output artifact', VLM_ERROR_CODES.INFERENCE_FAILED);
    }
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(tmpJsonPath, 'utf8'));
    } catch (err: any) {
      throw new VlmError(`VLM output is not valid JSON: ${err.message}`, VLM_ERROR_CODES.MALFORMED_OUTPUT);
    }
    if (!raw || !Array.isArray(raw.observations)) {
      throw new VlmError('VLM output missing observations array', VLM_ERROR_CODES.MALFORMED_OUTPUT);
    }
    return raw.observations;
  }

  private runPythonInferenceSync(
    imagePath: string,
    input: AnalyzeImageInput,
    lease: ModelLease,
    _sourceHash: string,
    _effectiveSourceArtifactId: string,
  ): ImageObservation[] {
    const scratchDir = path.join(this.projectRoot, '.maos', 'artifacts', '.tmp');
    fs.mkdirSync(scratchDir, { recursive: true });
    const tmpJsonPath = path.join(scratchDir, `vlm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      const proc = spawnSync(this.pythonExecutable, this.buildPythonArgs(imagePath, tmpJsonPath, input, lease), {
        cwd: this.projectRoot,
        timeout: VISION_BOUNDS.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (proc.error) {
        throw new VlmError(`Python VLM execution failed: ${proc.error.message}`, VLM_ERROR_CODES.INFERENCE_FAILED);
      }
      if (proc.signal || proc.status !== 0) {
        const detail = String(proc.stderr || proc.stdout || '').trim().slice(-1000);
        throw new VlmError(
          `Python VLM execution failed with status ${proc.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
          proc.signal ? VLM_ERROR_CODES.TIMEOUT : VLM_ERROR_CODES.INFERENCE_FAILED,
        );
      }
      return this.readPythonOutput(tmpJsonPath);
    } finally {
      if (fs.existsSync(tmpJsonPath)) {
        try { fs.unlinkSync(tmpJsonPath); } catch { /* best-effort cleanup */ }
      }
    }
  }

  private runPythonInference(
    imagePath: string,
    input: AnalyzeImageInput,
    lease: ModelLease,
    _sourceHash: string,
    _effectiveSourceArtifactId: string,
  ): Promise<ImageObservation[]> {
    const scratchDir = path.join(this.projectRoot, '.maos', 'artifacts', '.tmp');
    fs.mkdirSync(scratchDir, { recursive: true });
    const tmpJsonPath = path.join(scratchDir, `vlm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);
    const args = this.buildPythonArgs(imagePath, tmpJsonPath, input, lease);

    return runBoundedProcess(this.pythonExecutable, args, {
      cwd: this.projectRoot,
      env: { ...process.env },
      timeoutMs: VISION_BOUNDS.timeoutMs,
      maxOutputBytes: 1024 * 1024,
    })
      .then((result) => {
        if (result.signal || result.status !== 0) {
          const detail = result.stderr.trim().slice(-2000);
          throw new VlmError(
            `Python VLM execution failed with status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
            VLM_ERROR_CODES.INFERENCE_FAILED,
          );
        }
        return this.readPythonOutput(tmpJsonPath);
      })
      .catch((error: unknown) => {
        if (error instanceof VlmError) throw error;
        if (error instanceof BoundedProcessError) {
          if (error.kind === 'timeout') {
            throw new VlmError('VLM inference exceeded the execution timeout', VLM_ERROR_CODES.TIMEOUT);
          }
          if (error.kind === 'output_limit') {
            throw new VlmError('VLM backend output exceeded the bounded limit', VLM_ERROR_CODES.MALFORMED_OUTPUT);
          }
        }
        throw new VlmError(
          `Python VLM execution failed: ${error instanceof Error ? error.message : String(error)}`,
          VLM_ERROR_CODES.INFERENCE_FAILED,
        );
      })
      .finally(() => {
        if (fs.existsSync(tmpJsonPath)) {
          try { fs.unlinkSync(tmpJsonPath); } catch { /* best-effort cleanup */ }
        }
      });
  }

  private normalizeObservation(
    raw: unknown,
    input: AnalyzeImageInput,
    lease: ModelLease,
    sourceHash: string,
    sourceArtifactId: string,
  ): ImageObservation {
    if (!raw || typeof raw !== 'object') {
      throw new VlmError('VLM observation must be an object', VLM_ERROR_CODES.MALFORMED_OUTPUT);
    }
    const observation = raw as Record<string, any>;
    return {
      ...observation,
      schemaVersion: 1,
      id: typeof observation.id === 'string' && observation.id ? observation.id : `obs_${sourceHash.slice(0, 12)}`,
      sourceArtifactId,
      sourceHash,
      modelId: lease.modelId,
      modelRevision: input.expectedModelRevision || PINNED_VLM_CONFIG.revision,
      observationType: typeof observation.observationType === 'string' && observation.observationType
        ? observation.observationType
        : `visual_${input.taskType}`,
      value: typeof observation.value === 'string' ? observation.value : '',
      confidence: observation.confidence,
      warnings: Array.isArray(observation.warnings) ? observation.warnings : ['VLM output requires human review'],
      // VLM output is an observation only; no visual result is an automatic verdict.
      requiresReview: true,
    } as ImageObservation;
  }

  // ── Finalization & Audit Logging ───────────────────────────────────

  private finalizeAndAudit(
    input: AnalyzeImageInput,
    effectiveSourceArtifactId: string,
    sourceHash: string,
    lease: ModelLease,
    observations: readonly ImageObservation[],
    callerAgentId?: string,
  ): AnalyzeImageResult {
    // 1. Safe Artifact Store finalization
    const artifactId = `art_vision_${sourceHash.substring(0, 8)}_${Date.now()}`;
    const artifactRelativePath = `evidence/vision/${sourceHash.substring(0, 16)}/observations.json`;

    const modelRevision = input.expectedModelRevision || PINNED_VLM_CONFIG.revision;
    const device =
      (this.modelManager.getModelRegistration(lease.modelId)?.device as 'cuda' | 'cpu') || 'cuda';

    const unfinalizedResult: AnalyzeImageResult = {
      schemaVersion: 1,
      sourceArtifactId: effectiveSourceArtifactId,
      sourceHash,
      modelId: lease.modelId,
      modelRevision,
      device,
      taskType: input.taskType,
      prompt: input.prompt,
      observations,
      warnings: [],
    };

    const serialized = JSON.stringify(unfinalizedResult, null, 2);
    const finalized = this.artifactService.finalizeArtifact({
      id: artifactId,
      relativePath: artifactRelativePath,
      content: Buffer.from(serialized, 'utf8'),
      type: 'evidence',
      allowOverwrite: true,
      projectId: input.projectId,
      metadata: {
        sourceArtifactId: effectiveSourceArtifactId,
        sourceHash,
        taskType: input.taskType,
        prompt: input.prompt,
        observationsCount: observations.length,
        requiresReviewCount: observations.filter((o) => o.requiresReview).length,
      },
      producer: {
        agentId: callerAgentId || 'vision-service',
        modelId: lease.modelId,
      },
    });

    const finalResult: AnalyzeImageResult = {
      ...unfinalizedResult,
      artifactId: finalized.id,
      artifactHash: finalized.hash,
    };

    // 2. Append-only audit record (strictly AFTER artifact finalization)
    this.auditService.recordAuditEvent({
      source: 'analyze_image',
      category: 'tool',
      data: {
        action: 'IMAGE_ANALYZED',
        requestId: input.requestId,
        projectId: input.projectId,
        sourceArtifactId: effectiveSourceArtifactId,
        sourceHash,
        taskType: input.taskType,
        prompt: input.prompt,
        observationCount: observations.length,
        requiresReviewCount: observations.filter((o) => o.requiresReview).length,
        modelId: lease.modelId,
        modelRevision,
        device,
        outputArtifactId: finalized.id,
        outputRelativePath: finalized.path,
      },
    });

    return validateAnalyzeImageResult(finalResult);
  }
}
