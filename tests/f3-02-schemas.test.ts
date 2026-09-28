/**
 * F3-02 — Domain Schema Validation Tests
 *
 * Tests all 15 versioned domain schemas:
 *   - Positive: valid objects pass validation
 *   - Negative: missing required fields, wrong types, bounds exceeded,
 *               wrong schemaVersion, extra unknown fields stripped
 */

import { describe, it, expect } from 'vitest';
import {
  validateProject,
  validateTask,
  validateMessage,
  validateRun,
  validateWorkflowStage,
  validateArtifact,
  validateFinding,
  validateEvidence,
  validateApproval,
  validateModel,
  validateModelLease,
  validateAuditEvent,
  validateServiceIdentity,
  validateProvenanceReference,
  validateMemoryEntry,
  stripUnknownFields,
} from '../src/domain/validators';
import {
  MAX_PROJECT_NAME_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_PATH_LENGTH,
  MAX_HASH_LENGTH,
  MAX_CHILDREN_PER_WORKFLOW,
  MAX_PLAN_HISTORY_ENTRIES,
  MAX_TAGS_PER_ENTITY,
} from '../src/domain/schemas';

// ── Helper ────────────────────────────────────────────────────

function longString(len: number): string {
  return 'x'.repeat(len);
}

// ── Project ───────────────────────────────────────────────────

describe('F3-02 Schema: Project', () => {
  const validProject = {
    schemaVersion: 1,
    projectName: 'test-project',
    routingMode: 'auto',
    providers: { ollama: { baseURL: 'http://127.0.0.1:8000/v1' } },
    agents: [{ id: 'A1', role: 'coder', capabilities: ['coding'], scope: ['src/'] }],
    routing: {
      strategy: 'capability_score',
      costWeight: 0.2,
      capabilityWeight: 0.8,
      maxParallelAgents: 4,
      fallbackProvider: 'ollama',
    },
  };

  it('should accept a valid project', () => {
    expect(validateProject(validProject).valid).toBe(true);
  });

  it('should accept a project with a valid profile', () => {
    const withProfile = {
      ...validProject,
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
        evidenceRoot: 'demo/industrial',
      },
    };
    expect(validateProject(withProfile).valid).toBe(true);
  });

  it('should reject missing projectName', () => {
    const { projectName, ...rest } = validProject;
    const result = validateProject(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: projectName');
  });

  it('should reject wrong schemaVersion', () => {
    const result = validateProject({ ...validProject, schemaVersion: 99 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('should reject non-object input', () => {
    expect(validateProject('not an object').valid).toBe(false);
    expect(validateProject(null).valid).toBe(false);
    expect(validateProject(42).valid).toBe(false);
  });

  it('should reject projectName exceeding max length', () => {
    const result = validateProject({
      ...validProject,
      projectName: longString(MAX_PROJECT_NAME_LENGTH + 1),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds max length'))).toBe(true);
  });

  it('should reject invalid profile mode', () => {
    const result = validateProject({
      ...validProject,
      profile: {
        id: 'x',
        displayName: 'X',
        mode: 'invalid-mode',
        zeroCloud: false,
        evidenceRoot: '',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mode'))).toBe(true);
  });
});

// ── Task ──────────────────────────────────────────────────────

describe('F3-02 Schema: Task', () => {
  const validTask = {
    schemaVersion: 1,
    id: 'TASK_001',
    type: 'task',
    agent: 'CODER_1',
    branch: 'maos/coder_1/TASK_001',
    description: 'Fix the login bug',
    capabilities: ['coding'],
    complexity: 'medium',
    status: 'pending',
    category: 'bugfix',
    dependsOn: [],
    createdAt: '2026-09-01T00:00:00Z',
    filePath: '.maos/queue/pending/TASK_001.md',
  };

  it('should accept a valid task', () => {
    expect(validateTask(validTask).valid).toBe(true);
  });

  it('should reject invalid type enum', () => {
    const result = validateTask({ ...validTask, type: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('type'))).toBe(true);
  });

  it('should reject invalid status enum', () => {
    const result = validateTask({ ...validTask, status: 'running' });
    expect(result.valid).toBe(false);
  });

  it('should reject invalid complexity enum', () => {
    const result = validateTask({ ...validTask, complexity: 'extreme' });
    expect(result.valid).toBe(false);
  });

  it('should reject description exceeding max length', () => {
    const result = validateTask({
      ...validTask,
      description: longString(MAX_TASK_DESCRIPTION_LENGTH + 1),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('should reject missing id', () => {
    const { id, ...rest } = validTask;
    const result = validateTask(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: id');
  });

  it('should reject agent exceeding max length', () => {
    const result = validateTask({
      ...validTask,
      agent: longString(MAX_AGENT_ID_LENGTH + 1),
    });
    expect(result.valid).toBe(false);
  });
});

// ── Message ───────────────────────────────────────────────────

describe('F3-02 Schema: Message', () => {
  const validMessage = {
    schemaVersion: 1,
    id: 'msg-001',
    role: 'user',
    content: 'Hello',
    timestamp: '2026-09-01T00:00:00Z',
  };

  it('should accept a valid message', () => {
    expect(validateMessage(validMessage).valid).toBe(true);
  });

  it('should accept null content', () => {
    expect(validateMessage({ ...validMessage, content: null }).valid).toBe(true);
  });

  it('should reject invalid role', () => {
    const result = validateMessage({ ...validMessage, role: 'admin' });
    expect(result.valid).toBe(false);
  });

  it('should reject content exceeding max length', () => {
    const result = validateMessage({
      ...validMessage,
      content: longString(MAX_MESSAGE_CONTENT_LENGTH + 1),
    });
    expect(result.valid).toBe(false);
  });

  it('should reject numeric content', () => {
    const result = validateMessage({ ...validMessage, content: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('content'))).toBe(true);
  });
});

// ── Run ───────────────────────────────────────────────────────

describe('F3-02 Schema: Run', () => {
  const validRun = {
    schemaVersion: 1,
    id: 'run-001',
    taskId: 'TASK_001',
    agentId: 'CODER_1',
    startedAt: '2026-09-01T00:00:00Z',
    completedAt: '2026-09-01T00:05:00Z',
    success: true,
    summary: 'Fixed the bug',
    filesChanged: ['src/login.ts'],
    iterations: 5,
    totalTokens: 10000,
    costUSD: 0.05,
    latencyMs: 30000,
    runtimeType: 'api',
  };

  it('should accept a valid run', () => {
    expect(validateRun(validRun).valid).toBe(true);
  });

  it('should accept optional result field', () => {
    expect(validateRun({ ...validRun, result: 'success' }).valid).toBe(true);
  });

  it('should reject invalid result enum', () => {
    const result = validateRun({ ...validRun, result: 'crashed' });
    expect(result.valid).toBe(false);
  });

  it('should reject invalid runtimeType', () => {
    const result = validateRun({ ...validRun, runtimeType: 'docker' });
    expect(result.valid).toBe(false);
  });

  it('should reject missing success field', () => {
    const { success, ...rest } = validRun;
    const result = validateRun(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: success');
  });
});

// ── WorkflowStage ─────────────────────────────────────────────

describe('F3-02 Schema: WorkflowStage', () => {
  const validWorkflow = {
    schemaVersion: 1,
    id: 'obj-001',
    goal: 'Build login feature',
    status: 'executing',
    version: 1,
    childTaskIds: ['SUB_001', 'SUB_002'],
    completedChildIds: ['SUB_001'],
    failedChildIds: [],
    cancelledChildIds: [],
    plannerAgentId: 'ARCHITECT',
    planHistory: [{ version: 1, createdAt: '2026-09-01T00:00:00Z', taskIds: ['SUB_001', 'SUB_002'], reason: 'initial' }],
    createdAt: '2026-09-01T00:00:00Z',
    planCompletedAt: '2026-09-01T00:01:00Z',
    doneAt: null,
    maxReplanAttempts: 3,
    replanCount: 0,
  };

  it('should accept a valid workflow stage', () => {
    expect(validateWorkflowStage(validWorkflow).valid).toBe(true);
  });

  it('should reject invalid status enum', () => {
    const result = validateWorkflowStage({ ...validWorkflow, status: 'running' });
    expect(result.valid).toBe(false);
  });

  it('should reject childTaskIds exceeding max count', () => {
    const result = validateWorkflowStage({
      ...validWorkflow,
      childTaskIds: Array.from({ length: MAX_CHILDREN_PER_WORKFLOW + 1 }, (_, i) => `T${i}`),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('childTaskIds'))).toBe(true);
  });

  it('should reject planHistory exceeding max count', () => {
    const result = validateWorkflowStage({
      ...validWorkflow,
      planHistory: Array.from({ length: MAX_PLAN_HISTORY_ENTRIES + 1 }, (_, i) => ({
        version: i,
        createdAt: '2026-01-01',
        taskIds: [],
        reason: 'test',
      })),
    });
    expect(result.valid).toBe(false);
  });
});

// ── Artifact ──────────────────────────────────────────────────

describe('F3-02 Schema: Artifact', () => {
  const validArtifact = {
    schemaVersion: 1,
    id: 'art-001',
    runId: 'run-001',
    path: 'artifacts/report.json',
    type: 'report',
    hash: 'abc123',
    size: 1024,
    createdAt: '2026-09-01T00:00:00Z',
    finalizedAt: null,
  };

  it('should accept a valid artifact', () => {
    expect(validateArtifact(validArtifact).valid).toBe(true);
  });

  it('should reject invalid type enum', () => {
    const result = validateArtifact({ ...validArtifact, type: 'binary' });
    expect(result.valid).toBe(false);
  });

  it('should reject path exceeding max length', () => {
    const result = validateArtifact({ ...validArtifact, path: longString(MAX_PATH_LENGTH + 1) });
    expect(result.valid).toBe(false);
  });

  it('should reject hash exceeding max length', () => {
    const result = validateArtifact({ ...validArtifact, hash: longString(MAX_HASH_LENGTH + 1) });
    expect(result.valid).toBe(false);
  });
});

// ── Finding ───────────────────────────────────────────────────

describe('F3-02 Schema: Finding', () => {
  const validFinding = {
    schemaVersion: 1,
    id: 'f-001',
    runId: 'run-001',
    metric: 'vibration_rms',
    observed: '12.5',
    threshold: '10.0',
    status: 'WARNING',
    ruleId: 'VIB-001',
    unit: 'mm/s',
    timestamp: '2026-09-01T00:00:00Z',
  };

  it('should accept a valid finding', () => {
    expect(validateFinding(validFinding).valid).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = validateFinding({ ...validFinding, status: 'CRITICAL' });
    expect(result.valid).toBe(false);
  });
});

// ── Evidence ──────────────────────────────────────────────────

describe('F3-02 Schema: Evidence', () => {
  const validEvidence = {
    schemaVersion: 1,
    id: 'ev-001',
    gateId: 'G2',
    criteria: ['network isolation', 'bundle integrity'],
    verifiedItems: ['network isolation'],
    blockers: ['bundle integrity'],
    machineIdentity: { hostname: 'HIDEZX', osBuild: '10.0.26200' },
    timestamp: '2026-09-01T00:00:00Z',
    summary: 'Partially verified',
    g2Ready: false,
  };

  it('should accept a valid evidence', () => {
    expect(validateEvidence(validEvidence).valid).toBe(true);
  });

  it('should reject missing machineIdentity', () => {
    const { machineIdentity, ...rest } = validEvidence;
    const result = validateEvidence(rest);
    expect(result.valid).toBe(false);
  });

  it('should reject machineIdentity missing hostname', () => {
    const result = validateEvidence({
      ...validEvidence,
      machineIdentity: { osBuild: '10.0' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hostname'))).toBe(true);
  });
});

// ── Approval ──────────────────────────────────────────────────

describe('F3-02 Schema: Approval', () => {
  const validApproval = {
    schemaVersion: 1,
    id: 'apr-001',
    gateId: 'G2',
    status: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:00:00Z',
    conditions: [],
  };

  it('should accept a valid approval', () => {
    expect(validateApproval(validApproval).valid).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = validateApproval({ ...validApproval, status: 'maybe' });
    expect(result.valid).toBe(false);
  });
});

// ── Model ─────────────────────────────────────────────────────

describe('F3-02 Schema: Model', () => {
  const validModel = {
    schemaVersion: 1,
    id: 'ollama/qwen2.5-3b',
    name: 'qwen2.5-3b-instruct',
    revision: 'aa8e7253',
    provider: 'ollama',
    device: 'cuda',
    snapshotPath: '/path/to/snapshot',
    hash: 'abc123def456',
  };

  it('should accept a valid model', () => {
    expect(validateModel(validModel).valid).toBe(true);
  });

  it('should reject snapshotPath exceeding max length', () => {
    const result = validateModel({ ...validModel, snapshotPath: longString(MAX_PATH_LENGTH + 1) });
    expect(result.valid).toBe(false);
  });
});

// ── ModelLease ─────────────────────────────────────────────────

describe('F3-02 Schema: ModelLease', () => {
  const validLease = {
    schemaVersion: 1,
    id: 'lease-001',
    modelId: 'ollama/qwen2.5-3b',
    agentId: 'CODER_1',
    grantedAt: '2026-09-01T00:00:00Z',
    expiresAt: null,
    port: 8000,
  };

  it('should accept a valid model lease', () => {
    expect(validateModelLease(validLease).valid).toBe(true);
  });

  it('should reject agentId exceeding max length', () => {
    const result = validateModelLease({ ...validLease, agentId: longString(MAX_AGENT_ID_LENGTH + 1) });
    expect(result.valid).toBe(false);
  });
});

// ── AuditEvent ────────────────────────────────────────────────

describe('F3-02 Schema: AuditEvent', () => {
  const validEvent = {
    schemaVersion: 1,
    seq: 1,
    type: 'TASK_STARTED',
    agentId: 'CODER_1',
    taskId: 'TASK_001',
    timestamp: Date.now(),
    data: { foo: 'bar' },
  };

  it('should accept a valid audit event', () => {
    expect(validateAuditEvent(validEvent).valid).toBe(true);
  });

  it('should reject missing seq', () => {
    const { seq, ...rest } = validEvent;
    const result = validateAuditEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: seq');
  });

  it('should reject missing timestamp', () => {
    const { timestamp, ...rest } = validEvent;
    const result = validateAuditEvent(rest);
    expect(result.valid).toBe(false);
  });
});

// ── ServiceIdentity ───────────────────────────────────────────

describe('F3-02 Schema: ServiceIdentity', () => {
  const validService = {
    schemaVersion: 1,
    id: 'svc-001',
    executablePath: '/usr/local/bin/maos-engine',
    executableHash: 'abc123',
    host: '127.0.0.1',
    port: 8000,
    pid: 12345,
    status: 'healthy',
    startedAt: '2026-09-01T00:00:00Z',
  };

  it('should accept a valid service identity', () => {
    expect(validateServiceIdentity(validService).valid).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = validateServiceIdentity({ ...validService, status: 'unknown' });
    expect(result.valid).toBe(false);
  });
});

// ── ProvenanceReference ───────────────────────────────────────

describe('F3-02 Schema: ProvenanceReference', () => {
  const validProv = {
    schemaVersion: 1,
    id: 'prov-001',
    sourceFile: 'demo/industrial/vibration_data.csv',
    sourceHash: 'abc123',
    extractedAt: '2026-09-01T00:00:00Z',
    chainPosition: 0,
  };

  it('should accept a valid provenance reference', () => {
    expect(validateProvenanceReference(validProv).valid).toBe(true);
  });

  it('should reject sourceFile exceeding max length', () => {
    const result = validateProvenanceReference({ ...validProv, sourceFile: longString(MAX_PATH_LENGTH + 1) });
    expect(result.valid).toBe(false);
  });
});

// ── MemoryEntry ───────────────────────────────────────────────

describe('F3-02 Schema: MemoryEntry', () => {
  const validEntry = {
    id: 'mem-001',
    agentId: 'CODER_1',
    type: 'DISCOVERY',
    content: 'Found that the login module uses JWT',
    tags: ['auth', 'jwt'],
    confidence: 0.95,
    timestamp: Date.now(),
    ttlMs: 3600000,
  };

  it('should accept a valid memory entry', () => {
    expect(validateMemoryEntry(validEntry).valid).toBe(true);
  });

  it('should reject invalid memory type', () => {
    const result = validateMemoryEntry({ ...validEntry, type: 'INSIGHT' });
    expect(result.valid).toBe(false);
  });

  it('should reject tags exceeding max count', () => {
    const result = validateMemoryEntry({
      ...validEntry,
      tags: Array.from({ length: MAX_TAGS_PER_ENTITY + 1 }, (_, i) => `tag${i}`),
    });
    expect(result.valid).toBe(false);
  });
});

// ── Unknown Field Stripping ───────────────────────────────────

describe('F3-02 Utility: stripUnknownFields', () => {
  it('should keep only known fields', () => {
    const input = { a: 1, b: 2, c: 3 };
    const result = stripUnknownFields(input, ['a', 'c']);
    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('should handle empty known fields list', () => {
    const result = stripUnknownFields({ a: 1, b: 2 }, []);
    expect(result).toEqual({});
  });

  it('should handle missing fields gracefully', () => {
    const result = stripUnknownFields({ a: 1 }, ['a', 'b']);
    expect(result).toEqual({ a: 1 });
  });
});

// ── Cross-Schema schemaVersion Consistency ────────────────────

describe('F3-02 Cross-Schema: schemaVersion', () => {
  const validators = [
    { name: 'Task', fn: validateTask, version: 1, minimal: { schemaVersion: 1, id: 'x', type: 'task', agent: 'A', branch: 'b', description: 'd', capabilities: [], complexity: 'low', status: 'pending', createdAt: 'now' } },
    { name: 'Message', fn: validateMessage, version: 1, minimal: { schemaVersion: 1, id: 'x', role: 'user', content: 'hi', timestamp: 'now' } },
    { name: 'AuditEvent', fn: validateAuditEvent, version: 1, minimal: { schemaVersion: 1, seq: 1, type: 'HEARTBEAT', agentId: 'A', timestamp: 0 } },
  ];

  for (const { name, fn, version, minimal } of validators) {
    it(`${name}: should reject schemaVersion 0`, () => {
      const result = fn({ ...minimal, schemaVersion: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('schemaVersion'))).toBe(true);
    });

    it(`${name}: should reject schemaVersion 2`, () => {
      const result = fn({ ...minimal, schemaVersion: 2 });
      expect(result.valid).toBe(false);
    });

    it(`${name}: should accept schemaVersion ${version}`, () => {
      expect(fn(minimal).valid).toBe(true);
    });
  }
});
