import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createServiceContainer } from '../../src/service';
import { handleIndustrialTrigger, IndustrialTriggerResult } from '../../src/cli/dashboard';

describe('F10-02: Typed Dashboard Workflow Trigger', () => {
  const testRoot = path.resolve(__dirname, '../../.maos/test-temp-f10-02-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'objectives'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'events'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('handleIndustrialTrigger execution', () => {
    it('dispatches typed workflow stage and returns run and stage links', () => {
      const services = createServiceContainer(testRoot);
      const result: IndustrialTriggerResult = handleIndustrialTrigger(services, testRoot);

      expect(result.success).toBe(true);
      expect(result.runId).toBeDefined();
      expect(result.stageId).toBeDefined();
      expect(result.stageId).toBe(result.runId);

      // Verify returned stage structure
      expect(result.stage).toBeDefined();
      expect(result.stage.id).toBe(result.stageId);
      expect(result.stage.status).toBe('planning');
      expect(result.stage.goal).toContain('Turbine T-07 Safety Audit');

      // Verify links
      expect(result.links).toBeDefined();
      expect(result.links.run).toBe(`/api/v1/runs/${result.runId}`);
      expect(result.links.stage).toBe(`/api/v1/workflows/${result.stageId}`);
      expect(result.links.stages).toBe(`/api/v1/workflows/${result.stageId}`);
      expect(result.links.cockpit).toBe(`/api/v1/cockpit/${result.runId}`);
    });

    it('creates persistent workflow objective accessible through WorkflowService', () => {
      const services = createServiceContainer(testRoot);
      const result = handleIndustrialTrigger(services, testRoot);

      const loadedObjective = services.workflow.getObjective(result.stageId);
      expect(loadedObjective).not.toBeNull();
      expect(loadedObjective?.id).toBe(result.stageId);
      expect(loadedObjective?.goal).toBe(result.stage.goal);
      expect(loadedObjective?.plannerAgentId).toBe('AUTO');
    });

    it('creates objective task accessible through TaskService without direct fake INGEST assignment', () => {
      const services = createServiceContainer(testRoot);
      const result = handleIndustrialTrigger(services, testRoot);

      const task = services.task.getTask(result.runId);
      expect(task).not.toBeNull();
      expect(task?.id).toBe(result.runId);
      expect(task?.type).toBe('objective');
      // Negative check: Must NOT be hardcoded fake INGEST_AGENT assignment
      expect(task?.agent).not.toBe('INGEST_AGENT');
      expect(task?.category).toBe('industrial-safety');
      expect(task?.capabilities).toContain('planning');
      expect(task?.capabilities).toContain('decomposition');
      expect(task?.capabilities).toContain('document-ingestion');
    });

    it('supports custom goal parameter', () => {
      const services = createServiceContainer(testRoot);
      const customGoal = 'Custom Generator Hydro-Pump Safety Evaluation';
      const result = handleIndustrialTrigger(services, testRoot, customGoal);

      expect(result.stage.goal).toBe(customGoal);
      const loaded = services.workflow.getObjective(result.stageId);
      expect(loaded?.goal).toBe(customGoal);
    });

    it('records audited event in audit trail', () => {
      const services = createServiceContainer(testRoot);
      const result = handleIndustrialTrigger(services, testRoot);

      const events = services.audit.getRecords({ category: 'stage' });
      const triggerEvent = events.find(
        (e) => (e.data as any)?.event === 'WORKFLOW_TRIGGERED' && (e.data as any)?.runId === result.runId,
      );

      expect(triggerEvent).toBeDefined();
      expect((triggerEvent?.data as any)?.stageId).toBe(result.stageId);
      expect((triggerEvent?.data as any)?.goal).toContain('Turbine T-07 Safety Audit');
    });
  });

  describe('HTTP endpoint execution', () => {
    it('handles POST /api/industrial/trigger via server and returns JSON with run/stage links', async () => {
      const services = createServiceContainer(testRoot);
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/industrial/trigger') {
          const result = handleIndustrialTrigger(services, testRoot);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address() as { port: number };

      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/industrial/trigger`, {
          method: 'POST',
        });

        expect(response.status).toBe(200);
        const data = (await response.json()) as IndustrialTriggerResult;

        expect(data.success).toBe(true);
        expect(data.runId).toBeDefined();
        expect(data.stageId).toBeDefined();
        expect(data.links.run).toBe(`/api/v1/runs/${data.runId}`);
        expect(data.links.stage).toBe(`/api/v1/workflows/${data.stageId}`);
        expect(data.links.stages).toBe(`/api/v1/workflows/${data.stageId}`);
        expect(data.links.cockpit).toBe(`/api/v1/cockpit/${data.runId}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('Static code verification for negative requirements', () => {
    it('verifies src/cli/dashboard.ts does not directly import core/queue createTask', () => {
      const content = fs.readFileSync(path.resolve(__dirname, '../../src/cli/dashboard.ts'), 'utf8');
      expect(content).not.toMatch(/import\s*\{\s*createTask\s*\}\s*from\s*['"]\.\.\/core\/queue['"]/);
    });

    it('verifies src/cli/dashboard.ts does not assign fake INGEST_AGENT in trigger endpoint', () => {
      const content = fs.readFileSync(path.resolve(__dirname, '../../src/cli/dashboard.ts'), 'utf8');
      expect(content).not.toMatch(/agent:\s*['"]INGEST_AGENT['"]/);
    });

    it('exposes typed workflow run and stage links from the dashboard trigger', () => {
      const content = fs.readFileSync(path.resolve(__dirname, '../../src/cli/dashboard.ts'), 'utf8');
      expect(content).toContain('run: `/api/v1/runs/${runId}`');
      expect(content).toContain('stage: `/api/v1/workflows/${stage.id}`');
      expect(content).toContain('stages: `/api/v1/workflows/${stage.id}`');
      expect(content).toContain('cockpit: `/api/v1/cockpit/${runId}`');
    });
  });
});
