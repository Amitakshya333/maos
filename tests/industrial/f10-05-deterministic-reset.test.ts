import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  executeDeterministicReset,
  discoverResetCandidates,
  isForbiddenPath,
  RESET_CATEGORIES,
} from '../../src/industrial/deterministic-reset';
import {
  runIndustrialReset,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('F10-05: Deterministic Reset for Industrial Generated Test State', () => {
  const testRoot = path.resolve(__dirname, '../../.maos/test-temp-f10-05-' + Date.now());

  beforeEach(() => {
    // Scaffold isolated test project environment
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'queue', 'objectives'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'events'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'generated'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'artifacts', 'generated'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'artifacts', 'verification'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'demo', 'industrial', 'generated'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'industrial', 'kb'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'sandbox'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, '.maos', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'fixtures'), { recursive: true });

    // Populate generated state files
    fs.writeFileSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'), '{"taskId":"task-runA-01","runId":"run-A"}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runB-01.json'), '{"taskId":"task-runB-01","runId":"run-B"}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'queue', 'objectives', 'obj-runA.json'), '{"objectiveId":"obj-runA","runId":"run-A"}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'plans', 'plan-runA.json'), '{"planId":"plan-runA","runId":"run-A"}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'events', 'events-runA.jsonl'), '{"sequence":1,"runId":"run-A"}\n');
    fs.writeFileSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'), 'dummy docx content');
    fs.writeFileSync(path.join(testRoot, 'demo', 'industrial', 'generated', 'output.md'), 'dummy report');
    fs.writeFileSync(path.join(testRoot, '.maos', 'industrial', 'kb', 'vector_index.json'), '{"vectors":[]}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'), 'print("sandbox")');
    fs.writeFileSync(path.join(testRoot, '.maos', 'tmp', 'temp.txt'), 'temp data');
    fs.writeFileSync(path.join(testRoot, '.maos', 'sessions', 'session-01.json'), '{"session":1}');

    // Populate protected files that MUST NOT be touched
    fs.writeFileSync(path.join(testRoot, '.maos', 'config.json'), '{"project":"sovereign"}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'settings.json'), '{"settings":true}');
    fs.writeFileSync(path.join(testRoot, '.maos', 'instance-identity.json'), '{"instanceId":"inst-1"}');
    const initialServices = createServiceContainer(testRoot);
    initialServices.audit.recordAuditEvent({
      category: 'stage',
      source: 'test-seed',
      data: { init: true },
    });
    fs.writeFileSync(path.join(testRoot, 'artifacts', 'verification', 'F10-01.md'), '# F10-01 Report');
    fs.writeFileSync(path.join(testRoot, 'fixtures', 'fixture.csv'), 'a,b,c\n1,2,3\n');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('Discovery & Category Allowlist', () => {
    it('discovers all generated files when category is all', () => {
      const candidates = discoverResetCandidates(testRoot, RESET_CATEGORIES);
      const relativePaths = candidates.map((c) => c.relativePath);

      expect(relativePaths).toContain('.maos/queue/tasks/task-runA-01.json');
      expect(relativePaths).toContain('.maos/queue/tasks/task-runB-01.json');
      expect(relativePaths).toContain('.maos/queue/objectives/obj-runA.json');
      expect(relativePaths).toContain('.maos/plans/plan-runA.json');
      expect(relativePaths).toContain('.maos/events/events-runA.jsonl');
      expect(relativePaths).toContain('artifacts/generated/report-run-A.docx');
      expect(relativePaths).toContain('demo/industrial/generated/output.md');
      expect(relativePaths).toContain('.maos/industrial/kb/vector_index.json');
      expect(relativePaths).toContain('.maos/sandbox/script.py');
      expect(relativePaths).toContain('.maos/tmp/temp.txt');
      expect(relativePaths).toContain('.maos/sessions/session-01.json');

      // Protected files must never be candidate
      expect(relativePaths).not.toContain('.maos/config.json');
      expect(relativePaths).not.toContain('.maos/settings.json');
      expect(relativePaths).not.toContain('.maos/instance-identity.json');
      expect(relativePaths).not.toContain('.maos/audit/audit-chain.jsonl');
      expect(relativePaths).not.toContain('artifacts/verification/F10-01.md');
      expect(relativePaths).not.toContain('fixtures/fixture.csv');
    });

    it('filters discovery strictly to specified allowlist categories', () => {
      const candidates = discoverResetCandidates(testRoot, ['queue']);
      const relativePaths = candidates.map((c) => c.relativePath);

      expect(relativePaths).toContain('.maos/queue/tasks/task-runA-01.json');
      expect(relativePaths).not.toContain('artifacts/generated/report-run-A.docx');
      expect(relativePaths).not.toContain('.maos/industrial/kb/vector_index.json');
      expect(relativePaths).not.toContain('.maos/sandbox/script.py');
    });

    it('filters discovery by runId when specified', () => {
      const candidates = discoverResetCandidates(testRoot, RESET_CATEGORIES, 'run-A');
      const relativePaths = candidates.map((c) => c.relativePath);

      expect(relativePaths).toContain('.maos/queue/tasks/task-runA-01.json');
      expect(relativePaths).toContain('.maos/queue/objectives/obj-runA.json');
      expect(relativePaths).toContain('.maos/plans/plan-runA.json');
      expect(relativePaths).toContain('.maos/events/events-runA.jsonl');
      expect(relativePaths).toContain('artifacts/generated/report-run-A.docx');

      // run-B must not be matched
      expect(relativePaths).not.toContain('.maos/queue/tasks/task-runB-01.json');
    });
  });

  describe('Dry-Run Safety Guarantee', () => {
    it('reports candidates without removing any files during dry-run', async () => {
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_CATEGORIES,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.candidateFiles.length).toBeGreaterThanOrEqual(10);
      expect(result.removedFiles).toHaveLength(0);

      // Verify files still exist on disk
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'))).toBe(true);
    });
  });

  describe('Confirmation & Live Execution', () => {
    it('rejects live execution when confirmed is false or omitted', async () => {
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_CATEGORIES,
        dryRun: false,
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('CONFIRMATION_REQUIRED');
      expect(result.removedFiles).toHaveLength(0);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'))).toBe(true);
    });

    it('deletes allowlisted files when live reset is explicitly confirmed', async () => {
      const services = createServiceContainer(testRoot);

      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_CATEGORIES,
        dryRun: false,
        confirmed: true,
        auditService: services.audit,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(result.removedFiles.length).toBeGreaterThanOrEqual(10);

      // Verify targeted generated files were removed
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'))).toBe(false);
      expect(fs.existsSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'))).toBe(false);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'))).toBe(false);

      // Verify protected files are 100% intact
      expect(fs.existsSync(path.join(testRoot, '.maos', 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'instance-identity.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'audit', 'audit-chain.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, 'artifacts', 'verification', 'F10-01.md'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, 'fixtures', 'fixture.csv'))).toBe(true);

      // Verify audit event recorded
      const auditRecords = services.audit.getRecords();
      const resetRecord = auditRecords.find((r) => r.data?.event === 'DETERMINISTIC_RESET_EXECUTED');
      expect(resetRecord).toBeDefined();
    });
  });

  describe('CLI Wrapper: runIndustrialReset', () => {
    it('defaults to dry-run when --yes is omitted', async () => {
      const result = await runIndustrialReset({
        projectRoot: testRoot,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect((result.data as any).dryRun).toBe(true);
      expect((result.data as any).totalFiles).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'))).toBe(true);
    });

    it('rejects invalid category with INVALID_ARGS exit code 2', async () => {
      const result = await runIndustrialReset({
        projectRoot: testRoot,
        allowlist: 'invalid_category_xyz',
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
    });

    it('executes confirmed live reset with --yes and returns exit code 0', async () => {
      const result = await runIndustrialReset({
        projectRoot: testRoot,
        yes: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect((result.data as any).dryRun).toBe(false);
      expect((result.data as any).totalFiles).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'tasks', 'task-runA-01.json'))).toBe(false);
    });
  });

  describe('Strict Negative Invariants', () => {
    it('isForbiddenPath rejects canary file rust/test.txt', () => {
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'rust', 'test.txt'), PROJECT_ROOT)).toBe(true);
    });

    it('isForbiddenPath rejects anything in fixtures/', () => {
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'fixtures', 'multimodal', 'manifest.json'), PROJECT_ROOT)).toBe(true);
    });

    it('isForbiddenPath rejects demo/industrial source files', () => {
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv'), PROJECT_ROOT)).toBe(true);
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'demo', 'industrial', 'DEMO_PACK_PROVENANCE.json'), PROJECT_ROOT)).toBe(true);
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'demo', 'industrial', 'safety_thresholds.json'), PROJECT_ROOT)).toBe(true);
    });

    it('isForbiddenPath allows demo/industrial/generated outputs', () => {
      expect(isForbiddenPath(path.join(PROJECT_ROOT, 'demo', 'industrial', 'generated', 'report.md'), PROJECT_ROOT)).toBe(false);
    });

    it('isForbiddenPath rejects audit logs and root configs', () => {
      expect(isForbiddenPath(path.join(PROJECT_ROOT, '.maos', 'audit', 'audit-chain.jsonl'), PROJECT_ROOT)).toBe(true);
      expect(isForbiddenPath(path.join(PROJECT_ROOT, '.maos', 'config.json'), PROJECT_ROOT)).toBe(true);
      expect(isForbiddenPath(path.join(PROJECT_ROOT, '.maos', 'settings.json'), PROJECT_ROOT)).toBe(true);
    });

    it('preserves canary hash byte-for-byte throughout all operations', () => {
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
