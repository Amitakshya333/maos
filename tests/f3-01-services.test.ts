/**
 * F3-01 — Application Service Boundary Tests
 *
 * Verifies:
 *   - Service container creation
 *   - Each service operates on domain types
 *   - Services do not import CLI modules
 *   - Services do not call process.exit()
 *   - Services do not import chalk
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServiceContainer, ServiceContainer } from '../src/service';

// ── Test Fixtures ─────────────────────────────────────────────

let testDir: string;
let services: ServiceContainer;

function initTestProject(dir: string): void {
  const maosDir = path.join(dir, '.maos');
  fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'memory'), { recursive: true });

  const config = {
    projectName: 'test-project',
    routingMode: 'auto',
    providers: {
      ollama: { baseURL: 'http://127.0.0.1:8000/v1', costPerMillionTokens: 0 },
    },
    agents: [
      {
        id: 'CODER_1',
        role: 'coder',
        provider: 'ollama',
        model: 'test-model',
        capabilities: ['coding'],
        scope: ['src/'],
        maxIterations: 5,
        costTier: 'low',
      },
    ],
    routing: {
      strategy: 'capability_score',
      costWeight: 0.2,
      capabilityWeight: 0.8,
      maxParallelAgents: 2,
      fallbackProvider: 'ollama',
    },
  };

  fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f3-01-'));
  initTestProject(testDir);
  services = createServiceContainer(testDir);
});

afterEach(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

// ── Service Container ─────────────────────────────────────────

describe('F3-01 Service Container', () => {
  it('should create all 8 services', () => {
    expect(services.project).toBeDefined();
    expect(services.task).toBeDefined();
    expect(services.workflow).toBeDefined();
    expect(services.orchestration).toBeDefined();
    expect(services.event).toBeDefined();
    expect(services.memory).toBeDefined();
    expect(services.health).toBeDefined();
    expect(services.model).toBeDefined();
  });
});

// ── Project Service ───────────────────────────────────────────

describe('F3-01 ProjectService', () => {
  it('should detect initialized project', () => {
    expect(services.project.isInitialized()).toBe(true);
  });

  it('should detect non-initialized project', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-empty-'));
    const emptySvc = createServiceContainer(emptyDir);
    expect(emptySvc.project.isInitialized()).toBe(false);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should load config as domain Project type', () => {
    const config = services.project.loadConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.projectName).toBe('test-project');
    expect(config.routingMode).toBe('auto');
    expect(config.providers).toBeDefined();
    expect(config.agents).toBeInstanceOf(Array);
    expect(config.routing).toBeDefined();
  });

  it('should return agents', () => {
    const agents = services.project.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe('CODER_1');
  });

  it('should return providers', () => {
    const providers = services.project.getProviders();
    expect(providers.ollama).toBeDefined();
  });

  it('should not detect industrial profile for non-industrial config', () => {
    expect(services.project.isIndustrialProfile()).toBe(false);
  });
});

// ── Task Service ──────────────────────────────────────────────

describe('F3-01 TaskService', () => {
  it('should create a task with domain Task type', () => {
    const task = services.task.createTask({
      description: 'Test task for F3',
      agent: 'CODER_1',
      complexity: 'low',
    });

    expect(task.schemaVersion).toBe(1);
    expect(task.id).toBeTruthy();
    expect(task.description).toBe('Test task for F3');
    expect(task.status).toBe('pending');
    expect(task.agent).toBe('CODER_1');
  });

  it('should list tasks', () => {
    services.task.createTask({ description: 'Task A' });
    services.task.createTask({ description: 'Task B' });

    const tasks = services.task.listTasks({ status: 'pending' });
    expect(tasks.length).toBe(2);
    expect(tasks[0].schemaVersion).toBe(1);
  });

  it('should return queue counts', () => {
    services.task.createTask({ description: 'Task X' });

    const counts = services.task.getQueueCounts();
    expect(counts.pending).toBe(1);
    expect(counts.active).toBe(0);
    expect(counts.done).toBe(0);
  });

  it('should clean all queues', () => {
    services.task.createTask({ description: 'To be cleaned' });
    const result = services.task.clean();
    expect(result.tasksRemoved).toBeGreaterThanOrEqual(1);
    expect(services.task.getQueueCounts().pending).toBe(0);
  });
});

// ── Event Service ─────────────────────────────────────────────

describe('F3-01 EventService', () => {
  it('should return empty timeline for unknown task', () => {
    const events = services.event.getTaskTimeline('nonexistent');
    expect(events).toEqual([]);
  });

  it('should return empty query results', () => {
    const events = services.event.query();
    expect(events).toEqual([]);
  });

  it('should return stats with zero events', () => {
    const stats = services.event.getStats();
    expect(stats.totalEvents).toBe(0);
  });
});

// ── Memory Service ────────────────────────────────────────────

describe('F3-01 MemoryService', () => {
  it('should return empty live memories', () => {
    const live = services.memory.getLive();
    expect(live).toEqual([]);
  });

  it('should return stats', () => {
    const stats = services.memory.getStats();
    expect(stats.total).toBe(0);
    expect(stats.live).toBe(0);
  });

  it('should clear without error', () => {
    expect(() => services.memory.clear()).not.toThrow();
  });
});

// ── Health Service ────────────────────────────────────────────

describe('F3-01 HealthService', () => {
  it('should return agent pool entries', () => {
    const pool = services.health.getAgentPool([
      { id: 'CODER_1', capabilities: ['coding'], provider: 'ollama', model: 'test' },
    ]);
    expect(pool.length).toBe(1);
    expect(pool[0].agentId).toBe('CODER_1');
    expect(pool[0].status).toBe('IDLE');
  });

  it('should return empty retry queue', () => {
    const retries = services.health.getRetryQueueStatus();
    expect(retries).toEqual([]);
  });

  it('should return empty dead letter queue', () => {
    const dead = services.health.getDeadLetterQueue();
    expect(dead).toEqual([]);
  });
});

// ── Model Service ─────────────────────────────────────────────

describe('F3-01 ModelService', () => {
  it('should list configured models', () => {
    const models = services.model.listModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
    const ollamaModel = models.find((m) => m.provider === 'ollama');
    expect(ollamaModel).toBeDefined();
    expect(ollamaModel!.schemaVersion).toBe(1);
    expect(ollamaModel!.provider).toBe('ollama');
  });

  it('should validate local provider credentials', () => {
    const result = services.model.validateCredentials('ollama');
    expect(result.valid).toBe(true);
  });

  it('should reject unknown provider', () => {
    const result = services.model.validateCredentials('unknown_provider');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not configured');
  });
});

// ── Boundary Verification: No CLI imports in services ─────────

describe('F3-01 Boundary: Service files do not import CLI modules', () => {
  const serviceDir = path.resolve(__dirname, '..', 'src', 'service');

  it('should not import chalk in any service file', () => {
    const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serviceDir, file), 'utf-8');
      expect(content).not.toContain("from 'chalk'");
      expect(content).not.toContain('require(\'chalk\')');
    }
  });

  it('should not import commander in any service file', () => {
    const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serviceDir, file), 'utf-8');
      expect(content).not.toContain("from 'commander'");
    }
  });

  it('should not call process.exit in any service file', () => {
    const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serviceDir, file), 'utf-8');
      expect(content).not.toContain('process.exit');
    }
  });

  it('should not import from cli/ in any service file', () => {
    const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serviceDir, file), 'utf-8');
      expect(content).not.toMatch(/from ['"]\.\.\/cli\//);
    }
  });
});

// ── Boundary Verification: All domain schemas have schemaVersion ──

describe('F3-01 Boundary: Domain schemas have schemaVersion', () => {
  it('should define schemaVersion in all primary schemas', () => {
    const schemaFile = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'domain', 'schemas.ts'),
      'utf-8',
    );

    const primarySchemas = [
      'Project',
      'Conversation',
      'Message',
      'Task',
      'Run',
      'WorkflowStage',
      'Artifact',
      'Finding',
      'Evidence',
      'Approval',
      'Model',
      'ModelLease',
      'AuditEvent',
      'ServiceIdentity',
      'ProvenanceReference',
    ];

    for (const schema of primarySchemas) {
      // Find the interface block and check it has schemaVersion
      const interfaceRegex = new RegExp(`export interface ${schema}\\s*\\{[^}]*schemaVersion`, 's');
      expect(
        interfaceRegex.test(schemaFile),
        `${schema} should have schemaVersion field`,
      ).toBe(true);
    }
  });
});
