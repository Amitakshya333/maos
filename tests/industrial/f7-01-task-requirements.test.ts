/**
 * MAOS Industrial — Task Requirements & Non-Degradation Test Suite (F7-01)
 *
 * Verifies:
 * 1. Extended task requirements schema across modality, model, tool, input, output.
 * 2. Pure schema validators and bounds checking.
 * 3. Atomic queue markdown frontmatter serialization and parsing roundtrip.
 * 4. Backward compatibility migrations for legacy tasks without extended requirements.
 * 5. Strict negative requirements: unknown capabilities and unsupported modalities/tools
 *    CANNOT degrade to text-only mode and must fail closed.
 * 6. Hard router eligibility gates and scoring integration.
 * 7. End-to-end queue lifecycle with TaskService.
 * 8. Protected canary file integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  TASK_MODALITIES,
  TASK_MODEL_PARAMETER_TIERS,
  TASK_DEVICE_PREFERENCES,
  TASK_QUANTIZATIONS,
  type ExtendedTaskRequirements,
  type TaskModality,
  type Task,
  type CreateTaskInput,
} from '../../src/domain/schemas';
import {
  validateExtendedTaskRequirements,
  validateTask,
  canDegradeToTextOnly,
} from '../../src/domain/validators';
import {
  createTask,
  getPendingTasks,
  getActiveTasks,
  getDoneTasks,
  moveToActive,
  moveToDone,
  type TaskFile,
} from '../../src/core/queue';
import {
  createRouter,
  type AgentProfile,
  type TaskRequirements,
} from '../../src/core/router';
import { TaskService } from '../../src/service/task-service';
import {
  KNOWN_INDUSTRIAL_CAPABILITIES,
  TaskRequirementDegradationError,
  assertNonDegradableRequirements,
  evaluateAgentEligibility,
  migrateTaskFileToExtended,
} from '../../src/industrial/task-requirements';

describe('F7-01: Extend Task Requirements & Non-Degradation Authority', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f7-01-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Schema & Validator Tests
  // ─────────────────────────────────────────────────────────────

  describe('1. Schema & Validator Verification', () => {
    it('accepts valid extended requirements across all modalities', () => {
      for (const mod of TASK_MODALITIES) {
        const req: ExtendedTaskRequirements = {
          schemaVersion: 1,
          modalities: [mod],
          primaryModality: mod,
          allowDegradation: false,
        };
        const result = validateExtendedTaskRequirements(req);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }
    });

    it('accepts a complete multi-requirement specification', () => {
      const req: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['text', 'vision', 'code'],
        primaryModality: 'vision',
        model: {
          minContextTokens: 32768,
          modelFamily: 'qwen',
          architecture: 'transformer',
          requiredRevision: 'v2.5-frozen',
          parameterTier: 'standard',
          devicePreference: 'cuda',
          quantization: 'q4_k_m',
        },
        tools: {
          requiredTools: ['ocr_page', 'generate_docx'],
          optionalTools: ['search_knowledge_base'],
          forbiddenTools: ['exec_bash'],
        },
        input: {
          requiredArtifactTypes: ['file', 'report'],
          requiredMimeTypes: ['application/pdf', 'image/png'],
          schemaId: 'input_evidence_v1',
          maxInputSizeBytes: 50 * 1024 * 1024,
        },
        output: {
          expectedArtifactTypes: ['docx', 'report'],
          outputSchemaId: 'deliverable_run_v1',
          enforceFormat: true,
        },
        allowDegradation: false,
      };

      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects invalid schema versions', () => {
      const req = {
        schemaVersion: 2,
        modalities: ['text'],
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unsupported schemaVersion'))).toBe(true);
    });

    it('rejects empty modalities array', () => {
      const req = {
        schemaVersion: 1,
        modalities: [],
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least one modality'))).toBe(true);
    });

    it('rejects invalid or unsupported modalities', () => {
      const req = {
        schemaVersion: 1,
        modalities: ['telepathy', 'quantum'],
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid modality "telepathy"'))).toBe(true);
    });

    it('rejects primaryModality not included in modalities array', () => {
      const req = {
        schemaVersion: 1,
        modalities: ['text'],
        primaryModality: 'vision',
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must be included in modalities array'))).toBe(true);
    });

    it('rejects non-positive minContextTokens', () => {
      const req = {
        schemaVersion: 1,
        modalities: ['text'],
        model: {
          minContextTokens: -500,
        },
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must be a positive integer'))).toBe(true);
    });

    it('rejects invalid model parameter tiers, devices, and quantizations', () => {
      const req = {
        schemaVersion: 1,
        modalities: ['text'],
        model: {
          parameterTier: 'massive',
          devicePreference: 'quantum_chip',
          quantization: 'int2',
        },
      };
      const result = validateExtendedTaskRequirements(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('parameterTier'))).toBe(true);
      expect(result.errors.some((e) => e.includes('devicePreference'))).toBe(true);
      expect(result.errors.some((e) => e.includes('quantization'))).toBe(true);
    });

    it('validates extended requirements embedded in domain Task', () => {
      const task: Task = {
        schemaVersion: 1,
        id: 'TASK__101',
        type: 'task',
        agent: 'CODER',
        branch: 'maos/coder/101',
        description: 'Implement secure endpoint',
        capabilities: ['typescript'],
        complexity: 'medium',
        status: 'pending',
        category: 'backend',
        dependsOn: [],
        objectiveId: '',
        depth: 0,
        reviewRequired: false,
        fixAttempts: 0,
        parentTaskId: '',
        createdAt: new Date().toISOString(),
        filePath: '/tmp/test.md',
        requirements: {
          schemaVersion: 1,
          modalities: ['text', 'code'],
          tools: {
            requiredTools: ['generate_docx'],
          },
          allowDegradation: false,
        },
      };

      const result = validateTask(task);
      expect(result.valid).toBe(true);
    });

    it('fails validateTask when embedded requirements are malformed', () => {
      const task = {
        schemaVersion: 1,
        id: 'TASK__102',
        type: 'task',
        agent: 'CODER',
        branch: 'maos/coder/102',
        description: 'Test failure',
        capabilities: ['typescript'],
        complexity: 'medium',
        status: 'pending',
        category: 'backend',
        dependsOn: [],
        objectiveId: '',
        depth: 0,
        reviewRequired: false,
        fixAttempts: 0,
        parentTaskId: '',
        createdAt: new Date().toISOString(),
        requirements: {
          schemaVersion: 1,
          modalities: ['unsupported_modality'],
        },
      };

      const result = validateTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid modality'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Queue Frontmatter Serialization & Parsing Roundtrip
  // ─────────────────────────────────────────────────────────────

  describe('2. Queue Serialization & Parsing Roundtrip', () => {
    it('serializes extended requirements to markdown frontmatter and parses back losslessly', () => {
      const extReq: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['text', 'vision'],
        primaryModality: 'vision',
        model: {
          minContextTokens: 16384,
          modelFamily: 'qwen',
          architecture: 'transformer',
          requiredRevision: 'v2.5',
          parameterTier: 'standard',
          devicePreference: 'cuda',
          quantization: 'q4_k_m',
        },
        tools: {
          requiredTools: ['ocr_page', 'generate_docx'],
          optionalTools: ['vlm_inspect'],
          forbiddenTools: ['exec_bash'],
        },
        input: {
          requiredArtifactTypes: ['file', 'evidence'],
          requiredMimeTypes: ['application/pdf'],
          schemaId: 'pdf_doc_v1',
          maxInputSizeBytes: 10485760,
        },
        output: {
          expectedArtifactTypes: ['docx', 'report'],
          outputSchemaId: 'audit_report_v1',
          enforceFormat: true,
        },
        allowDegradation: false,
      };

      const task = createTask({
        agent: 'VISION_AGENT',
        description: 'Extract layout and parse document',
        capabilities: ['vision', 'ocr'],
        complexity: 'high',
        category: 'ocr',
        requirements: extReq,
        cwd: tempDir,
      });

      expect(task.requirements).toBeDefined();
      expect(task.requirements?.modalities).toEqual(['text', 'vision']);
      expect(task.requirements?.primaryModality).toBe('vision');
      expect(task.requirements?.model?.minContextTokens).toBe(16384);
      expect(task.requirements?.model?.modelFamily).toBe('qwen');
      expect(task.requirements?.tools?.requiredTools).toEqual(['ocr_page', 'generate_docx']);
      expect(task.requirements?.input?.requiredMimeTypes).toEqual(['application/pdf']);
      expect(task.requirements?.output?.expectedArtifactTypes).toEqual(['docx', 'report']);
      expect(task.requirements?.allowDegradation).toBe(false);

      // Verify file written to pending directory
      const rawContent = fs.readFileSync(task.filePath, 'utf-8');
      expect(rawContent).toContain('modalities: [text, vision]');
      expect(rawContent).toContain('primary_modality: vision');
      expect(rawContent).toContain('min_context_tokens: 16384');
      expect(rawContent).toContain('model_family: qwen');
      expect(rawContent).toContain('required_tools: [ocr_page, generate_docx]');
      expect(rawContent).toContain('allow_degradation: false');

      // Verify re-reading via getPendingTasks parses identical requirements
      const pending = getPendingTasks(tempDir);
      expect(pending.length).toBe(1);
      const loaded = pending[0];
      expect(loaded.requirements).toBeDefined();
      expect(loaded.requirements?.modalities).toEqual(['text', 'vision']);
      expect(loaded.requirements?.primaryModality).toBe('vision');
      expect(loaded.requirements?.model?.minContextTokens).toBe(16384);
      expect(loaded.requirements?.model?.modelFamily).toBe('qwen');
      expect(loaded.requirements?.model?.parameterTier).toBe('standard');
      expect(loaded.requirements?.tools?.requiredTools).toEqual(['ocr_page', 'generate_docx']);
      expect(loaded.requirements?.input?.schemaId).toBe('pdf_doc_v1');
      expect(loaded.requirements?.output?.enforceFormat).toBe(true);
      expect(loaded.requirements?.allowDegradation).toBe(false);
    });

    it('preserves extended requirements across moveToActive and moveToDone', () => {
      const extReq: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['vision'],
        tools: {
          requiredTools: ['ocr_page'],
        },
        allowDegradation: false,
      };

      const task = createTask({
        agent: 'OCR_WORKER',
        description: 'OCR scan',
        requirements: extReq,
        cwd: tempDir,
      });

      // Move to active
      const active = moveToActive(task, tempDir);
      expect(active.requirements).toBeDefined();
      expect(active.requirements?.modalities).toEqual(['vision']);

      const activeTasks = getActiveTasks(tempDir);
      expect(activeTasks.length).toBe(1);
      expect(activeTasks[0].requirements?.modalities).toEqual(['vision']);
      expect(activeTasks[0].requirements?.tools?.requiredTools).toEqual(['ocr_page']);

      // Move to done
      const done = moveToDone(active, tempDir);
      expect(done.requirements).toBeDefined();
      expect(done.requirements?.modalities).toEqual(['vision']);

      const doneTasks = getDoneTasks(tempDir);
      expect(doneTasks.length).toBe(1);
      expect(doneTasks[0].requirements?.modalities).toEqual(['vision']);
      expect(doneTasks[0].requirements?.tools?.requiredTools).toEqual(['ocr_page']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Backward Compatibility & Migration Tests
  // ─────────────────────────────────────────────────────────────

  describe('3. Backward Compatibility & Migrations', () => {
    it('loads legacy task files without extended requirements seamlessly', () => {
      const pendingDir = path.join(tempDir, '.maos', 'queue', 'pending');
      fs.mkdirSync(pendingDir, { recursive: true });

      const legacyContent = `---
id: LEGACY__12345
agent: CODER
branch: maos/coder/legacy
status: pending
capabilities: [typescript, testing]
complexity: low
category: testing
depends_on: []
created_at: 2026-09-20T10:00:00.000Z
---

# Task: LEGACY__12345

## Description

Legacy task without extended requirements.

## Instructions

Standard instructions.
`;
      const legacyPath = path.join(pendingDir, 'LEGACY__12345.md');
      fs.writeFileSync(legacyPath, legacyContent, 'utf-8');

      const tasks = getPendingTasks(tempDir);
      expect(tasks.length).toBe(1);
      const task = tasks[0];
      expect(task.id).toBe('LEGACY__12345');
      expect(task.capabilities).toEqual(['typescript', 'testing']);
      expect(task.requirements).toBeUndefined(); // Backwards-compatible undefined
    });

    it('migrates legacy tasks to full ExtendedTaskRequirements cleanly', () => {
      const legacyTask: TaskFile = {
        id: 'LEGACY__200',
        agent: 'CODER',
        branch: 'maos/coder/200',
        description: 'OCR and Vision task from older version',
        capabilities: ['vision', 'ocr', 'typescript'],
        complexity: 'medium',
        category: 'general',
        dependsOn: [],
        status: 'pending',
        createdAt: '2026-09-20T10:00:00.000Z',
        filePath: '/tmp/legacy.md',
        type: 'task',
        objectiveId: '',
        depth: 0,
        reviewRequired: false,
        fixAttempts: 0,
        parentTaskId: '',
      };

      const migrated = migrateTaskFileToExtended(legacyTask);
      expect(migrated.requirements).toBeDefined();
      expect(migrated.requirements?.schemaVersion).toBe(1);
      expect(migrated.requirements?.modalities).toContain('text');
      expect(migrated.requirements?.modalities).toContain('vision');
      expect(migrated.requirements?.modalities).toContain('code');
      expect(migrated.requirements?.tools?.requiredTools).toContain('ocr_page');
      // Invariant: allowDegradation must be strictly false
      expect(migrated.requirements?.allowDegradation).toBe(false);
      // All existing fields must be intact
      expect(migrated.id).toBe('LEGACY__200');
      expect(migrated.capabilities).toEqual(['vision', 'ocr', 'typescript']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Strict Negative Requirement & Non-Degradation Tests
  // ─────────────────────────────────────────────────────────────

  describe('4. Negative Requirements: Non-Degradation Authority', () => {
    it('rejects degradation when unknown capabilities are present', () => {
      expect(() => {
        assertNonDegradableRequirements(['unknown_teleportation_capability', 'quantum_leap']);
      }).toThrow(TaskRequirementDegradationError);
    });

    it('assertNonDegradableRequirements succeeds for recognized industrial capabilities', () => {
      expect(() => {
        assertNonDegradableRequirements(['text', 'vision', 'ocr_page', 'generate_docx', 'rust_analysis']);
      }).not.toThrow();
    });

    it('canDegradeToTextOnly returns false when allowDegradation is not explicitly true', () => {
      const req: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['vision'],
        allowDegradation: false,
      };
      expect(canDegradeToTextOnly(req)).toBe(false);
    });

    it('canDegradeToTextOnly returns false when non-text modalities are present even if degradation requested', () => {
      const req: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['vision'],
        allowDegradation: true,
      };
      // Vision cannot degrade to text-only mode
      expect(canDegradeToTextOnly(req)).toBe(false);
    });

    it('canDegradeToTextOnly returns false when tools are required', () => {
      const req: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['text'],
        tools: {
          requiredTools: ['ocr_page'],
        },
        allowDegradation: true,
      };
      // Tasks requiring specialized tools cannot degrade to text-only mode
      expect(canDegradeToTextOnly(req)).toBe(false);
    });

    it('canDegradeToTextOnly returns true only for pure text tasks with degradation allowed', () => {
      const req: ExtendedTaskRequirements = {
        schemaVersion: 1,
        modalities: ['text'],
        allowDegradation: true,
      };
      expect(canDegradeToTextOnly(req)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Router Hard Eligibility & Ineligible Elimination
  // ─────────────────────────────────────────────────────────────

  describe('5. Router Hard Eligibility & Ineligible Model Elimination', () => {
    const textAgent: AgentProfile = {
      id: 'TEXT_CODER',
      role: 'developer',
      provider: 'local',
      model: 'qwen2.5-coder',
      capabilities: ['typescript', 'coding', 'text'],
      modalities: ['text', 'code'],
      allowedTools: [],
      contextWindow: 8192,
      costTier: 'low',
      maxIterations: 10,
      idle: true,
      enabled: true,
    };

    const visionAgent: AgentProfile = {
      id: 'VLM_ANALYST',
      role: 'analyst',
      provider: 'local',
      model: 'qwen2-vl',
      capabilities: ['vision', 'ocr', 'vlm'],
      modalities: ['text', 'vision'],
      allowedTools: ['ocr_page', 'vlm_inspect'],
      contextWindow: 32768,
      costTier: 'medium',
      maxIterations: 10,
      idle: true,
      enabled: true,
    };

    const router = createRouter({ strategy: 'capability_score' });

    it('routes vision task to vision agent and eliminates text-only agent', () => {
      const task: TaskRequirements = {
        capabilities: ['vision'],
        complexity: 'medium',
        category: 'ocr',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['vision'],
          allowDegradation: false,
        },
      };

      // Both agents available
      const decision = router.route(task, [textAgent, visionAgent]);
      expect(decision).not.toBeNull();
      expect(decision?.agentId).toBe('VLM_ANALYST');
    });

    it('fails closed (returns null) when vision task has no eligible vision agent available', () => {
      const task: TaskRequirements = {
        capabilities: ['vision'],
        complexity: 'medium',
        category: 'ocr',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['vision'],
          allowDegradation: false,
        },
      };

      // Only text agent available — MUST NOT degrade to text-only!
      const decision = router.route(task, [textAgent]);
      expect(decision).toBeNull();
    });

    it('fails closed when task requires tools that no agent possesses', () => {
      const task: TaskRequirements = {
        capabilities: ['text'],
        complexity: 'low',
        category: 'general',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['text'],
          tools: {
            requiredTools: ['unsupported_specialized_scanner'],
          },
          allowDegradation: false,
        },
      };

      const decision = router.route(task, [textAgent, visionAgent]);
      expect(decision).toBeNull();
    });

    it('fails closed when task requires more context tokens than agent supports', () => {
      const task: TaskRequirements = {
        capabilities: ['typescript'],
        complexity: 'high',
        category: 'coding',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['text'],
          model: {
            minContextTokens: 65536, // Greater than textAgent's 8192
          },
          allowDegradation: false,
        },
      };

      const decision = router.route(task, [textAgent]);
      expect(decision).toBeNull();
    });

    it('rejects explicit targetAgent when target does not meet hard requirements', () => {
      const task: TaskRequirements = {
        capabilities: ['vision'],
        complexity: 'high',
        category: 'ocr',
        targetAgent: 'TEXT_CODER', // Explicitly targeting incapable agent
        extended: {
          schemaVersion: 1,
          modalities: ['vision'],
          allowDegradation: false,
        },
      };

      // Router must reject target agent because it does not satisfy vision requirement
      const decision = router.route(task, [textAgent, visionAgent]);
      expect(decision).toBeNull();
    });

    it('ranks ineligible agents with score 0 in rankAll', () => {
      const task: TaskRequirements = {
        capabilities: ['vision'],
        complexity: 'medium',
        category: 'ocr',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['vision'],
          allowDegradation: false,
        },
      };

      const rankings = router.rankAll(task, [textAgent, visionAgent]);
      expect(rankings.length).toBe(2);
      expect(rankings[0].agentId).toBe('VLM_ANALYST');
      expect(rankings[0].score).toBeGreaterThan(0);

      // textAgent must be scored 0
      expect(rankings[1].agentId).toBe('TEXT_CODER');
      expect(rankings[1].score).toBe(0);
      expect(rankings[1].reasoning.some((r) => r.includes('Ineligible (strict non-degradation)'))).toBe(true);
    });

    it('evaluates eligibility correctly using evaluateAgentEligibility', () => {
      const task: TaskRequirements = {
        capabilities: ['ocr'],
        complexity: 'medium',
        category: 'ocr',
        targetAgent: 'AUTO',
        extended: {
          schemaVersion: 1,
          modalities: ['vision'],
          tools: {
            requiredTools: ['ocr_page'],
          },
          allowDegradation: false,
        },
      };

      const textResult = evaluateAgentEligibility(task, textAgent);
      expect(textResult.eligible).toBe(false);
      expect(textResult.missingModalities).toContain('vision');
      expect(textResult.missingTools).toContain('ocr_page');

      const visionResult = evaluateAgentEligibility(task, visionAgent);
      expect(visionResult.eligible).toBe(true);
      expect(visionResult.missingModalities).toHaveLength(0);
      expect(visionResult.missingTools).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. TaskService End-to-End Integration
  // ─────────────────────────────────────────────────────────────

  describe('6. TaskService End-to-End Integration', () => {
    it('creates, lists, and retrieves tasks with extended requirements', () => {
      const taskService = new TaskService(tempDir);

      const input: CreateTaskInput = {
        agent: 'CODER',
        description: 'Service level extended requirements creation',
        capabilities: ['typescript'],
        complexity: 'low',
        category: 'development',
        requirements: {
          schemaVersion: 1,
          modalities: ['text', 'code'],
          primaryModality: 'code',
          tools: {
            requiredTools: ['generate_docx'],
          },
          allowDegradation: false,
        },
      };

      const created = taskService.createTask(input);
      expect(created.requirements).toBeDefined();
      expect(created.requirements?.modalities).toEqual(['text', 'code']);
      expect(created.requirements?.primaryModality).toBe('code');
      expect(created.requirements?.tools?.requiredTools).toEqual(['generate_docx']);

      const tasks = taskService.listTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(created.id);
      expect(tasks[0].requirements?.primaryModality).toBe('code');

      const fetched = taskService.getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.requirements?.tools?.requiredTools).toEqual(['generate_docx']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Protected Canary File Verification
  // ─────────────────────────────────────────────────────────────

  describe('7. Canary File Protection Invariant', () => {
    it('preserves rust/test.txt canary SHA-256 hash strictly', () => {
      const canaryPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      const EXPECTED_CANARY_HASH =
        '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
      expect(hash).toBe(EXPECTED_CANARY_HASH);
    });
  });
});
