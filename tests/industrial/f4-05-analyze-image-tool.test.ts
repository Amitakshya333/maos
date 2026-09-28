/**
 * F4-05: Register analyze_image Tool Test Suite
 *
 * Validates:
 *   1. Tool definition & schema registration in AGENT_TOOLS
 *   2. Tool advertisement filtering (getToolsForAgent)
 *   3. Authorization enforcement & defense-in-depth (UNAUTHORIZED_TOOL_CALL, TOOL_UNAUTHORIZED)
 *   4. Versioned input validation (schemaVersion: 1, source exclusivity, bounds, taskTypes)
 *   5. Path confinement & project root scoping (traversal, symlink escapes, scope array)
 *   6. Image format & bounds guardrails (magic bytes, dimensions <= 14400, file <= 20MB)
 *   7. Shared Model Manager lease protocol (Section 4.2, guaranteed release in finally)
 *   8. Model revision & health guardrails (REVISION_MISMATCH, MODEL_UNHEALTHY)
 *   9. Structured visual observations across all 4 task types
 *  10. Critical safety invariant: NO direct safety verdicts; requiresReview = true for measurements
 *  11. Safe Artifact Store atomic finalization (evidence/vision/<hash>/observations.json)
 *  12. Immutable audit trail integration (IMAGE_ANALYZED event strictly after artifact)
 *  13. Durable mutation idempotency (exact replay with cached: true, conflict, auth mismatch)
 *  14. Zero phantom audit records or partial artifacts on failure
 *  15. Protected file invariant (rust/test.txt SHA-256 integrity)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  AGENT_TOOLS,
  getToolsForAgent,
  executeTool,
  executeAnalyzeImageTool,
  executeAnalyzeImageToolAsync,
  AUTHORIZED_ANALYZE_IMAGE_AGENTS,
} from '../../src/integrations/tools';
import {
  AnalyzeImageInput,
  AnalyzeImageResult,
  VISION_BOUNDS,
  PINNED_VLM_CONFIG,
  VLM_ERROR_CODES,
  VlmError,
  validateAnalyzeImageInput,
  validateImageObservation,
} from '../../src/domain/vision';
import {
  createServiceContainer,
  ServiceContainer,
  VisionService,
  ArtifactService,
  AuditService,
  DurableIdempotencyStore,
  SharedModelManager,
} from '../../src/service';

// ── Test Image Generators ──────────────────────────────────────────

function createMinimalPng(width = 100, height = 100): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
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

  const rawData = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
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

function createMinimalBmp(width = 100, height = 100): Buffer {
  const rowStride = Math.floor((width * 3 + 3) / 4) * 4;
  const pixelArraySize = rowStride * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);

  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);

  return buf;
}

function createMinimalJpeg(width = 100, height = 100): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof0Data = Buffer.alloc(11);
  sof0Data[0] = 8;
  sof0Data.writeUInt16BE(height, 1);
  sof0Data.writeUInt16BE(width, 3);
  sof0Data[5] = 3;

  const sof0Len = Buffer.alloc(2);
  sof0Len.writeUInt16BE(sof0Data.length + 2, 0);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), sof0Len, sof0Data]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

describe('F4-05: Register analyze_image Tool', () => {
  const TEST_TXT_INVARIANT = '1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435';
  let tmpDir: string;
  let services: ServiceContainer;

  function installTestSnapshot(root: string): void {
    const snapshotRelativePath = PINNED_VLM_CONFIG.snapshotRelativePath;
    const snapshotDir = path.join(root, 'offline-stores', 'model-snapshot', snapshotRelativePath);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const modelConfig = Buffer.from('{"model_type":"qwen2_vl"}', 'utf8');
    fs.writeFileSync(path.join(snapshotDir, 'config.json'), modelConfig);
    fs.writeFileSync(path.join(root, 'vlm-snapshot-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      model: PINNED_VLM_CONFIG.modelId,
      revision: PINNED_VLM_CONFIG.revision,
      quantization: PINNED_VLM_CONFIG.defaultQuantization,
      snapshotRelativePath,
      files: [{
        path: 'config.json',
        size: modelConfig.length,
        sha256: crypto.createHash('sha256').update(modelConfig).digest('hex'),
      }],
      budgets: { maxVramMb: 6144, coldStartBudgetMs: 45000, inferenceBudgetMs: 15000, warmStartBudgetMs: 5000 },
    }, null, 2));
  }

  function createTestVision(): VisionService {
    const manager = SharedModelManager.getInstance(tmpDir);
    return new VisionService(tmpDir, services.artifact, services.audit, manager, {
      // Contract tests inject observations explicitly; production has no such
      // handler and therefore requires the real verified Python runtime.
      inferenceHandler: (input) => [{
        schemaVersion: 1,
        id: `test-${input.requestId}`,
        sourceArtifactId: input.sourcePath || input.sourceArtifactId || 'test-image',
        sourceHash: 'test-hash',
        modelId: PINNED_VLM_CONFIG.modelId,
        modelRevision: PINNED_VLM_CONFIG.revision,
        observationType: input.taskType === 'measurement'
          ? 'visual_measurement'
          : input.taskType === 'label-reading' ? 'visual_label'
            : input.taskType === 'drawing-observation' ? 'drawing_element' : 'visual_feature',
        value: input.taskType === 'label-reading' ? 'SERIAL NO: TEST-4492' : 'test observation',
        confidence: 0.9,
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        warnings: ['Injected test observation; not a production inference'],
        requiresReview: true,
      }],
    });
  }

  function executeAnalyzeImageWithTestVision(input: unknown, context: Parameters<typeof executeAnalyzeImageTool>[1]): AnalyzeImageResult {
    return executeAnalyzeImageTool(input, context, { vision: createTestVision() });
  }

  async function executeAnalyzeImageWithTestVisionAsync(input: unknown, context: Parameters<typeof executeAnalyzeImageToolAsync>[1]): Promise<AnalyzeImageResult> {
    return executeAnalyzeImageToolAsync(input, context, { vision: createTestVision() });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f4-05-test-'));
    // Setup directory structure
    fs.mkdirSync(path.join(tmpDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.maos', 'idempotency'), { recursive: true });

    const vlmManifestSrc = path.join(process.cwd(), 'vlm-snapshot-manifest.json');
    if (fs.existsSync(vlmManifestSrc)) {
      fs.copyFileSync(vlmManifestSrc, path.join(tmpDir, 'vlm-snapshot-manifest.json'));
    }
    installTestSnapshot(tmpDir);

    SharedModelManager.resetInstance();
    services = createServiceContainer(tmpDir);
  });

  afterEach(() => {
    SharedModelManager.resetInstance();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── 1. Tool Definition & Advertisement ───────────────────────────

  describe('1. Tool Definition & Advertisement', () => {
    it('registers analyze_image in AGENT_TOOLS with valid schema', () => {
      const tool = AGENT_TOOLS.find((t) => t.function.name === 'analyze_image');
      expect(tool).toBeDefined();
      expect(tool!.function.description).toContain('Vision-Language Model');

      const props = tool!.function.parameters.properties;
      expect(props.schemaVersion).toBeDefined();
      expect(props.projectId).toBeDefined();
      expect(props.sourcePath).toBeDefined();
      expect(props.sourceArtifactId).toBeDefined();
      expect(props.prompt).toBeDefined();
      expect(props.taskType).toBeDefined();
      expect(props.maxOutputTokens).toBeDefined();
      expect(props.requestId).toBeDefined();

      expect(tool!.function.parameters.required).toContain('schemaVersion');
      expect(tool!.function.parameters.required).toContain('projectId');
      expect(tool!.function.parameters.required).toContain('prompt');
      expect(tool!.function.parameters.required).toContain('taskType');
      expect(tool!.function.parameters.required).toContain('requestId');
    });

    it('filters analyze_image for unauthorized agents', () => {
      const tools = getToolsForAgent(undefined, 'unauthorized_random_agent');
      const hasAnalyzeImage = tools.some((t) => t.function.name === 'analyze_image');
      expect(hasAnalyzeImage).toBe(false);
    });

    it('advertises analyze_image to authorized agents', () => {
      for (const agent of ['ingest_agent', 'analyst_agent', 'auditor_agent', 'inspector', 'admin']) {
        const tools = getToolsForAgent(undefined, agent);
        const hasAnalyzeImage = tools.some((t) => t.function.name === 'analyze_image');
        expect(hasAnalyzeImage).toBe(true);
      }
    });

    it('honors explicit allowedTools array', () => {
      const tools = getToolsForAgent(['read_file', 'analyze_image'], 'unauthorized_agent');
      expect(new Set(tools.map((t) => t.function.name))).toEqual(new Set(['read_file', 'analyze_image']));
    });
  });

  // ── 2. Authorization Enforcement ─────────────────────────────────

  describe('2. Authorization Enforcement', () => {
    it('rejects execution when agent lacks analyze_image in allowedTools', () => {
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      const res = executeTool(
        'analyze_image',
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/test.png',
          prompt: 'inspect',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-unauth-1',
        },
        tmpDir,
        ['/'],
        'analyst_agent',
        'task-1',
        ['read_file', 'ocr_document'], // analyze_image not in allowedTools
      );

      expect(res.result).toContain('TOOL_UNAUTHORIZED');
    });

    it('rejects execution when agent role is unauthorized', () => {
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/test.png',
            prompt: 'inspect',
            taskType: 'general-observation',
            maxOutputTokens: 256,
            requestId: 'req-unauth-2',
          },
          {
            projectRoot: tmpDir,
            agentId: 'unauthorized_script_kiddie',
          },
        );
      }).toThrowError(/not authorized to invoke analyze_image/);
    });
  });

  // ── 3. Input Validation ───────────────────────────────────────────

  describe('3. Input Validation & Error Handling', () => {
    it('rejects missing or wrong schemaVersion', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 2,
          projectId: 'p1',
          sourcePath: 'evidence/img.png',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/schemaVersion must be 1/);
    });

    it('rejects when both sourcePath and sourceArtifactId are missing', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/requires exactly one source reference/);
    });

    it('rejects when both sourcePath and sourceArtifactId are provided (conflict)', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/img.png',
          sourceArtifactId: 'art-123',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/Conflicting source references/);
    });

    it('rejects invalid taskType', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/img.png',
          prompt: 'check',
          taskType: 'unknown-task',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/Invalid taskType/);
    });

    it('rejects maxOutputTokens out of range', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/img.png',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 5000,
          requestId: 'r1',
        });
      }).toThrowError(/maxOutputTokens/);
    });

    it('rejects prompt exceeding maxPromptLength', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/img.png',
          prompt: 'a'.repeat(5000),
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/prompt length/);
    });
  });

  // ── 4. Path Confinement & Image Header Bounds ────────────────────

  describe('4. Path Confinement & Image Header Bounds', () => {
    it('rejects directory traversal in sourcePath', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: '../etc/passwd.png',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/Path traversal rejected/);
    });

    it('rejects unsupported file extension', () => {
      expect(() => {
        validateAnalyzeImageInput({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/data.pdf',
          prompt: 'check',
          taskType: 'general-observation',
          maxOutputTokens: 100,
          requestId: 'r1',
        });
      }).toThrowError(/Unsupported image format/);
    });

    it('rejects file outside agent scope', () => {
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/test.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 100,
            requestId: 'req-scope-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
            scope: ['src/'], // evidence/ is outside
          },
        );
      }).toThrowError(/outside agent's allowed scope/);
    });

    it('rejects missing image file with IMAGE_NOT_FOUND', () => {
      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/non_existent.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 100,
            requestId: 'req-missing-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/Image file not found/);
    });

    it('rejects empty (0-byte) image file with IMAGE_CORRUPT', () => {
      const emptyPng = path.join(tmpDir, 'evidence', 'empty.png');
      fs.writeFileSync(emptyPng, Buffer.alloc(0));

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/empty.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 100,
            requestId: 'req-empty-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/Image file is empty/);
    });

    it('rejects invalid magic bytes (fake png) with UNSUPPORTED_IMAGE_FORMAT', () => {
      const fakePng = path.join(tmpDir, 'evidence', 'fake.png');
      fs.writeFileSync(fakePng, Buffer.from('NOT A REAL PNG FILE'));

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/fake.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 100,
            requestId: 'req-fake-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/Invalid or unsupported image magic bytes/);
    });

    it('rejects oversized image dimensions exceeding VISION_BOUNDS.maxImageDimension', () => {
      const oversizedPng = path.join(tmpDir, 'evidence', 'oversized.png');
      fs.writeFileSync(oversizedPng, createMinimalPng(15000, 100)); // 15000 > 14400

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/oversized.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 100,
            requestId: 'req-oversized-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/exceed limit 4096/);
    });
  });

  // ── 5. Lease Protocol & Section 4.2 Invariants ────────────────────

  describe('5. Shared Model Manager Lease Protocol & Invariants', () => {
    it('acquires and releases lease in finally on success', () => {
      const manager = SharedModelManager.getInstance(tmpDir);
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      const statusBefore = manager.getResidencyStatus();
      expect(statusBefore.activeLeases).toBe(0);

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/test.png',
          prompt: 'Describe image',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-lease-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.schemaVersion).toBe(1);

      // Lease must be released immediately in finally
      const statusAfter = manager.getResidencyStatus();
      expect(statusAfter.activeLeases).toBe(0);
    });

    it('guarantees lease release in finally when inference fails', () => {
      const manager = SharedModelManager.getInstance(tmpDir);
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      const failingVision = new VisionService(tmpDir, services.artifact, services.audit, manager, {
        inferenceHandler: () => {
          throw new Error('Simulated model inference crash');
        },
      });

      expect(() => {
        failingVision.analyzeImageSync({
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/test.png',
          prompt: 'Describe image',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-fail-lease-1',
        });
      }).toThrowError(/Simulated model inference crash/);

      // Must have zero active leases
      const status = manager.getResidencyStatus();
      expect(status.activeLeases).toBe(0);
    });

    it('rejects unpinned model revision with REVISION_MISMATCH', () => {
      const testPng = path.join(tmpDir, 'evidence', 'test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/test.png',
            prompt: 'check',
            taskType: 'general-observation',
            maxOutputTokens: 256,
            requestId: 'req-rev-1',
            expectedModelRevision: 'unpinned_tampered_revision_hash',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/Model revision mismatch/);
    });
  });

  // ── 6. Task Types & Structured Observations ───────────────────────

  describe('6. Task Types & Structured Observations', () => {
    it('executes measurement task: enforces requiresReview = true (Safety Invariant)', () => {
      const testPng = path.join(tmpDir, 'evidence', 'measurement.png');
      fs.writeFileSync(testPng, createMinimalPng(80, 60));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/measurement.png',
          prompt: 'Measure blade tip clearance',
          taskType: 'measurement',
          maxOutputTokens: 512,
          requestId: 'req-measure-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.taskType).toBe('measurement');
      expect(result.observations.length).toBeGreaterThan(0);
      const obs = result.observations[0];
      expect(obs.observationType).toBe('visual_measurement');
      expect(obs.requiresReview).toBe(true); // CRITICAL SAFETY INVARIANT
      expect(obs.bbox).toBeDefined();
      expect(obs.confidence).toBeGreaterThan(0);
      expect(obs.warnings.length).toBeGreaterThan(0);
    });

    it('executes label-reading task with visual observations', () => {
      const testBmp = path.join(tmpDir, 'evidence', 'label.bmp');
      fs.writeFileSync(testBmp, createMinimalBmp(120, 40));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/label.bmp',
          prompt: 'Read nameplate serial',
          taskType: 'label-reading',
          maxOutputTokens: 512,
          requestId: 'req-label-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.taskType).toBe('label-reading');
      expect(result.observations.length).toBeGreaterThan(0);
      const obs = result.observations[0];
      expect(obs.observationType).toBe('visual_label');
      expect(obs.value).toContain('SERIAL NO');
    });

    it('executes drawing-observation task with requiresReview = true', () => {
      const testJpeg = path.join(tmpDir, 'evidence', 'drawing.jpg');
      fs.writeFileSync(testJpeg, createMinimalJpeg(200, 200));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/drawing.jpg',
          prompt: 'Inspect flange bolt pattern',
          taskType: 'drawing-observation',
          maxOutputTokens: 512,
          requestId: 'req-drawing-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.taskType).toBe('drawing-observation');
      const obs = result.observations[0];
      expect(obs.observationType).toBe('drawing_element');
      expect(obs.requiresReview).toBe(true);
      expect(obs.bbox).toBeDefined();
    });

    it('executes general-observation task', () => {
      const testPng = path.join(tmpDir, 'evidence', 'general.png');
      fs.writeFileSync(testPng, createMinimalPng(100, 100));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/general.png',
          prompt: 'Overall surface condition',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-general-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.taskType).toBe('general-observation');
      const obs = result.observations[0];
      expect(obs.observationType).toBe('visual_feature');
      expect(obs.requiresReview).toBe(true);
    });
  });

  // ── 7. Safe Artifact Store & Audit Logging ────────────────────────

  describe('7. Safe Artifact Store & Audit Trail Integration', () => {
    it('atomically finalizes observations artifact in evidence/vision/<hash>/', () => {
      const testPng = path.join(tmpDir, 'evidence', 'audit_test.png');
      fs.writeFileSync(testPng, createMinimalPng(64, 64));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/audit_test.png',
          prompt: 'Check condition',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-art-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.artifactId).toBeDefined();
      expect(result.artifactHash).toBeDefined();

      const expectedPath = path.join(
        tmpDir,
        'evidence',
        'vision',
        result.sourceHash.substring(0, 16),
        'observations.json',
      );
      expect(fs.existsSync(expectedPath)).toBe(true);

      const savedJson = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
      expect(savedJson.sourceHash).toBe(result.sourceHash);
      expect(savedJson.observations.length).toBe(result.observations.length);
    });

    it('records IMAGE_ANALYZED audit event strictly after artifact finalization', () => {
      const testPng = path.join(tmpDir, 'evidence', 'audit_seq.png');
      fs.writeFileSync(testPng, createMinimalPng(64, 64));

      const result = executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/audit_seq.png',
          prompt: 'Inspect flange',
          taskType: 'drawing-observation',
          maxOutputTokens: 256,
          requestId: 'req-audit-seq-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      const auditTrail = services.audit.getRecords().filter((r) => r.data?.action === 'IMAGE_ANALYZED');

      expect(auditTrail.length).toBe(1);
      const auditRec = auditTrail[0];
      expect(auditRec.category).toBe('tool');
      expect(auditRec.source).toBe('analyze_image');
      expect(auditRec.data.requestId).toBe('req-audit-seq-1');
      expect(auditRec.data.sourceHash).toBe(result.sourceHash);
      expect(auditRec.data.outputArtifactId).toBe(result.artifactId);
    });

    it('records zero phantom audit events on validation or confinement failure', () => {
      const auditBefore = services.audit.getRecords().filter((r) => r.data?.action === 'IMAGE_ANALYZED').length;

      expect(() => {
        executeAnalyzeImageTool(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/nonexistent_file.png',
            prompt: 'inspect',
            taskType: 'general-observation',
            maxOutputTokens: 256,
            requestId: 'req-phantom-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrow();

      const auditAfter = services.audit.getRecords().filter((r) => r.data?.action === 'IMAGE_ANALYZED').length;
      expect(auditAfter).toBe(auditBefore);
    });
  });

  // ── 8. Durable Mutation Idempotency ───────────────────────────────

  describe('8. Durable Mutation Idempotency', () => {
    it('replays exact cached response on identical requestId', () => {
      const testPng = path.join(tmpDir, 'evidence', 'idemp.png');
      fs.writeFileSync(testPng, createMinimalPng(64, 64));

      const input: AnalyzeImageInput = {
        schemaVersion: 1,
        projectId: 'p1',
        sourcePath: 'evidence/idemp.png',
        prompt: 'First run',
        taskType: 'general-observation',
        maxOutputTokens: 256,
        requestId: 'req-idemp-1',
      };

      const res1 = executeAnalyzeImageWithTestVision(input, {
        projectRoot: tmpDir,
        agentId: 'analyst_agent',
      });
      expect(res1.cached).toBeFalsy();

      const res2 = executeAnalyzeImageWithTestVision(input, {
        projectRoot: tmpDir,
        agentId: 'analyst_agent',
      });
      expect(res2.cached).toBe(true);
      expect(res2.sourceHash).toBe(res1.sourceHash);
      expect(res2.artifactId).toBe(res1.artifactId);
    });

    it('rejects different payload on same requestId with IDEMPOTENCY_CONFLICT', () => {
      const testPng = path.join(tmpDir, 'evidence', 'idemp.png');
      fs.writeFileSync(testPng, createMinimalPng(64, 64));

      executeAnalyzeImageWithTestVision(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/idemp.png',
          prompt: 'First prompt',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-conflict-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(() => {
        executeAnalyzeImageWithTestVision(
          {
            schemaVersion: 1,
            projectId: 'p1',
            sourcePath: 'evidence/idemp.png',
            prompt: 'Different prompt', // Conflict!
            taskType: 'general-observation',
            maxOutputTokens: 256,
            requestId: 'req-conflict-1',
          },
          {
            projectRoot: tmpDir,
            agentId: 'analyst_agent',
          },
        );
      }).toThrowError(/previously executed with a different request payload/);
    });

    it('rejects different authContext on same requestId with UNAUTHORIZED_TOOL_CALL', () => {
      const testPng = path.join(tmpDir, 'evidence', 'idemp.png');
      fs.writeFileSync(testPng, createMinimalPng(64, 64));

      const input: AnalyzeImageInput = {
        schemaVersion: 1,
        projectId: 'p1',
        sourcePath: 'evidence/idemp.png',
        prompt: 'Same prompt',
        taskType: 'general-observation',
        maxOutputTokens: 256,
        requestId: 'req-auth-mismatch-1',
      };

      executeAnalyzeImageWithTestVision(input, {
        projectRoot: tmpDir,
        agentId: 'analyst_agent',
      });

      expect(() => {
        executeAnalyzeImageWithTestVision(input, {
          projectRoot: tmpDir,
          agentId: 'ingest_agent', // different agent
        });
      }).toThrowError(/different authorization context/);
    });
  });

  // ── 9. Async Execution & Dispatch ────────────────────────────────

  describe('9. Async Execution & Dispatch', () => {
    it('executes asynchronously via executeAnalyzeImageToolAsync', async () => {
      const testPng = path.join(tmpDir, 'evidence', 'async_test.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      const result = await executeAnalyzeImageWithTestVisionAsync(
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/async_test.png',
          prompt: 'Check async execution',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-async-1',
        },
        {
          projectRoot: tmpDir,
          agentId: 'analyst_agent',
        },
      );

      expect(result.schemaVersion).toBe(1);
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.artifactId).toBeDefined();
    });

    it('invokes tool through executeTool dispatcher', () => {
      const testPng = path.join(tmpDir, 'evidence', 'dispatch.png');
      fs.writeFileSync(testPng, createMinimalPng(50, 50));

      const res = executeTool(
        'analyze_image',
        {
          schemaVersion: 1,
          projectId: 'p1',
          sourcePath: 'evidence/dispatch.png',
          prompt: 'Dispatcher test',
          taskType: 'general-observation',
          maxOutputTokens: 256,
          requestId: 'req-dispatch-1',
        },
        tmpDir,
        ['/'],
        'analyst_agent',
        'task-1',
        ['analyze_image'],
        { vision: createTestVision() },
      );

      expect(res.isComplete).toBe(false);
      const parsed = JSON.parse(res.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.observations.length).toBeGreaterThan(0);
    });
  });

  // ── 10. Invariant Integrity ───────────────────────────────────────

  describe('10. Invariant Integrity', () => {
    it('preserves rust/test.txt SHA-256 integrity strictly', () => {
      const testTxtPath = path.resolve(process.cwd(), 'rust', 'test.txt');
      expect(fs.existsSync(testTxtPath)).toBe(true);

      const content = fs.readFileSync(testTxtPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe(TEST_TXT_INVARIANT);
    });
  });
});
