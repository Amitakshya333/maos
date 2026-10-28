import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import fsDefault from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  executeDeterministicReset,
  discoverResetCandidates,
  isForbiddenPath,
  RESET_CATEGORIES,
  RESET_ENABLED_CATEGORIES,
  RESET_DISABLED_CATEGORIES,
} from '../../src/industrial/deterministic-reset';
import {
  runIndustrialReset,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import { withJudgedRunOutputLock } from '../../src/industrial/judged-run-lock';
import { createServiceContainer } from '../../src/service';
import { createTask as createCoreTask } from '../../src/core/queue';
import { loadCheckpoint, recoverOrphanedTasks, saveCheckpoint } from '../../src/core/checkpoint';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function startArtifactPublisher(projectRoot: string): ChildProcessWithoutNullStreams {
  const modulePath = path.join(PROJECT_ROOT, 'src', 'service', 'index.ts');
  const lockPath = path.join(PROJECT_ROOT, 'src', 'industrial', 'judged-run-lock.ts');
  const script = [
    "const fs = require('node:fs');",
    "const ts = require('typescript');",
    "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
    "const { createServiceContainer } = require(process.argv[1]);",
    "const { withJudgedRunOutputLock } = require(process.argv[2]);",
    "const root = process.argv[3];",
    "const services = createServiceContainer(root);",
    "withJudgedRunOutputLock(root, async () => {",
    "  const temp = require('node:path').join(root, 'artifacts', '.tmp', '.tmp_live-publisher');",
    "  fs.mkdirSync(require('node:path').dirname(temp), { recursive: true });",
    "  fs.writeFileSync(temp, 'writer staging');",
    "  process.stdout.write('publisher-ready\\n');",
    "  await new Promise(resolve => process.stdin.once('data', resolve));",
    "  services.artifact.finalizeArtifact({ id: 'art_cross_process', relativePath: 'artifacts/generated/cross-process.md', content: '# Published', type: 'report', runId: 'run-cross-process' });",
    "  process.stdout.write('publisher-complete\\n');",
    "});",
  ].join('\n');
  return spawn(process.execPath, ['-e', script, modulePath, lockPath, projectRoot], { cwd: PROJECT_ROOT, stdio: 'pipe' });
}

function waitForPublisher(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) resolve();
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes(marker)) reject(new Error(`Publisher exited ${code} before ${marker}: ${output}`));
    });
  });
}

describe('F10-05: Deterministic Reset for Industrial Generated Test State', () => {
  let testRoot: string;
  let taskAPath: string;
  let taskBPath: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-test-temp-f10-05-'));
    // Scaffold isolated test project environment
    for (const state of ['pending', 'active', 'done', 'retry', 'failed', 'cancelled']) {
      fs.mkdirSync(path.join(testRoot, '.maos', 'queue', state), { recursive: true });
    }
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
    fs.writeFileSync(path.join(testRoot, '.maos', 'maos.config.json'), JSON.stringify({ schemaVersion: 1, projectName: 'f10-05-reset-test' }));

    // Populate a task through the same service path used by the application.
    const initialServices = createServiceContainer(testRoot);
    taskAPath = initialServices.task.createTask({ description: 'run-A pending reset task' }).filePath!;
    taskBPath = initialServices.task.createTask({ description: 'run-B pending reset task' }).filePath!;

    // Populate generated state files
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

      expect(relativePaths).toContain(path.relative(testRoot, taskAPath).replace(/\\/g, '/'));
      expect(relativePaths).toContain(path.relative(testRoot, taskBPath).replace(/\\/g, '/'));
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

      expect(relativePaths).toContain(path.relative(testRoot, taskAPath).replace(/\\/g, '/'));
      expect(relativePaths).not.toContain('artifacts/generated/report-run-A.docx');
      expect(relativePaths).not.toContain('.maos/industrial/kb/vector_index.json');
      expect(relativePaths).not.toContain('.maos/sandbox/script.py');
    });

    it('filters discovery by runId when specified', () => {
      const candidates = discoverResetCandidates(testRoot, RESET_CATEGORIES, 'run-A');
      const relativePaths = candidates.map((c) => c.relativePath);

      expect(relativePaths).toContain(path.relative(testRoot, taskAPath).replace(/\\/g, '/'));
      expect(relativePaths).toContain('.maos/queue/objectives/obj-runA.json');
      expect(relativePaths).toContain('.maos/plans/plan-runA.json');
      expect(relativePaths).toContain('.maos/events/events-runA.jsonl');
      expect(relativePaths).toContain('artifacts/generated/report-run-A.docx');

      // run-B must not be matched
      expect(relativePaths).not.toContain(path.relative(testRoot, taskBPath).replace(/\\/g, '/'));
    });
  });

  describe('Dry-Run Safety Guarantee', () => {
    it('reports candidates without removing any files during dry-run', async () => {
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_ENABLED_CATEGORIES,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.candidateFiles.length).toBeGreaterThanOrEqual(7);
      expect(result.removedFiles).toHaveLength(0);

      // Verify files still exist on disk
      expect(fs.existsSync(taskAPath)).toBe(true);
      expect(fs.existsSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'))).toBe(true);
    });
  });

  describe('Reset categories without coordinated writers', () => {
    it.each(RESET_DISABLED_CATEGORIES)('refuses %s even in dry-run mode', async (category) => {
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: [category],
        dryRun: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('RESET_CATEGORY_UNSUPPORTED');
      expect(result.message).toContain('Stop the owning service');
      expect(result.candidateFiles).toHaveLength(0);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'industrial', 'kb', 'vector_index.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sessions', 'session-01.json'))).toBe(true);
    });

    it('returns an actionable failure from the Industrial CLI for a disabled category', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await runIndustrialReset({ projectRoot: testRoot, allowlist: 'index', json: true });
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.RESET_FAILED);
        expect((result.data as any).error).toBe('RESET_CATEGORY_UNSUPPORTED');
        expect(result.message).toContain('Stop the owning service');
        expect(fs.existsSync(path.join(testRoot, '.maos', 'industrial', 'kb', 'vector_index.json'))).toBe(true);
      } finally {
        consoleLog.mockRestore();
      }
    });
  });

  describe('Confirmation & Live Execution', () => {
    it('rejects live execution when confirmed is false or omitted', async () => {
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_ENABLED_CATEGORIES,
        dryRun: false,
        confirmed: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('CONFIRMATION_REQUIRED');
      expect(result.removedFiles).toHaveLength(0);
      expect(fs.existsSync(taskAPath)).toBe(true);
    });

    it('deletes allowlisted files when live reset is explicitly confirmed', async () => {
      const services = createServiceContainer(testRoot);

      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_ENABLED_CATEGORIES,
        dryRun: false,
        confirmed: true,
        auditService: services.audit,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(result.removedFiles.length).toBeGreaterThanOrEqual(7);

      // Verify targeted generated files were removed
      expect(fs.existsSync(taskAPath)).toBe(false);
      expect(fs.existsSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'))).toBe(false);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sandbox', 'script.py'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'industrial', 'kb', 'vector_index.json'))).toBe(true);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'sessions', 'session-01.json'))).toBe(true);

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

  describe('Shared publication/reset boundary', () => {
    it('keeps an active generic publisher temp file out of cleanup and serializes CLI reset across processes', async () => {
      const services = createServiceContainer(testRoot);
      const publisher = startArtifactPublisher(testRoot);
      try {
        await waitForPublisher(publisher, 'publisher-ready');
        const tempPath = path.join(testRoot, 'artifacts', '.tmp', '.tmp_live-publisher');
        expect(services.artifact.cleanupOrphanTempFiles(0)).toBe(0);
        expect(fs.existsSync(tempPath)).toBe(true);

        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        const busyReset = await runIndustrialReset({ projectRoot: testRoot, allowlist: 'output', yes: true, json: true });
        consoleLog.mockRestore();
        expect(busyReset.exitCode).toBe(INDUSTRIAL_CLI_EXIT.RESET_FAILED);
        expect(busyReset.message).toContain('JUDGED_RUN_BUSY');

        publisher.stdin.end('continue');
        await waitForPublisher(publisher, 'publisher-complete');
        const exitCode = await new Promise<number>((resolve, reject) => {
          if (publisher.exitCode !== null) return resolve(publisher.exitCode);
          publisher.once('error', reject);
          publisher.once('exit', (code) => code === null ? reject(new Error('Publisher exited without a code.')) : resolve(code));
        });
        expect(exitCode).toBe(0);
        expect(services.artifact.listArtifacts('run-cross-process').map((artifact) => artifact.id)).toContain('art_cross_process');

        const resetLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reset = await runIndustrialReset({ projectRoot: testRoot, allowlist: 'output', yes: true, json: true });
        resetLog.mockRestore();
        expect(reset.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
        expect((reset.data as any).scannedBytes).toBeGreaterThan(0);
        expect((reset.data as any).removedBytes).toBe((reset.data as any).scannedBytes);
        expect(services.artifact.listArtifacts('run-cross-process')).toHaveLength(0);
      } finally {
        if (publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
      }
    }, 30_000);

    it('rejects a cross-process retry-queue writer while the project reset lock is held', () => {
      const retryModule = path.join(PROJECT_ROOT, 'src', 'core', 'retry-queue.ts');
      const script = [
        "const fs = require('node:fs');",
        "const ts = require('typescript');",
        "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
        "const { enqueueRetry } = require(process.argv[1]);",
        "try { enqueueRetry({ id: 'task-cross-process', agent: 'agent', filePath: 'active/task.md' }, 'task', 'timeout', [], 0, undefined, process.argv[2]); process.stdout.write('written'); }",
        "catch (error) { process.stdout.write(error.code || String(error)); process.exitCode = error.code === 'JUDGED_RUN_BUSY' ? 0 : 1; }",
      ].join('\n');
      const result = withJudgedRunOutputLock(testRoot, () => spawnSync(
        process.execPath,
        ['-e', script, retryModule, testRoot],
        { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15_000 },
      ));

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('JUDGED_RUN_BUSY');
      expect(fs.readdirSync(path.join(testRoot, '.maos', 'queue', 'retry'))).toHaveLength(0);
    });

    it('rejects cross-process event and checkpoint writers while the reset lock is held', () => {
      const eventModule = path.join(PROJECT_ROOT, 'src', 'core', 'event-store.ts');
      const checkpointModule = path.join(PROJECT_ROOT, 'src', 'core', 'checkpoint.ts');
      const script = [
        "const fs = require('node:fs');",
        "const ts = require('typescript');",
        "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
        "const { EventStore } = require(process.argv[1]);",
        "const { saveCheckpoint } = require(process.argv[2]);",
        "const root = process.argv[3];",
        "const store = new EventStore(root);",
        "const attempts = [() => store.writeSequenced({ eventType: 'RESET_LOCK_PROBE', projectId: 'test', correlationId: 'corr-test', payload: {} }), () => saveCheckpoint(root, { taskId: 'checkpoint-probe', agentId: 'agent', iteration: 1, maxIterations: 5, progressPct: 0.2, totalTokens: 0, filesChanged: [], lastToolCalls: [], wasProductive: false, idleCount: 0, costUSD: 0, savedAt: Date.now(), startedAt: Date.now(), progressSummary: '', retryCount: 0 })];",
        "let failures = 0; for (const attempt of attempts) { try { attempt(); process.stdout.write('written;'); failures++; } catch (error) { process.stdout.write((error.code || String(error)) + ';'); if (error.code !== 'JUDGED_RUN_BUSY') failures++; } }",
        "process.exitCode = failures ? 1 : 0;",
      ].join('\n');
      const result = withJudgedRunOutputLock(testRoot, () => spawnSync(
        process.execPath,
        ['-e', script, eventModule, checkpointModule, testRoot],
        { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15_000 },
      ));

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('JUDGED_RUN_BUSY;JUDGED_RUN_BUSY;');
      expect(fs.existsSync(path.join(testRoot, '.maos', 'events', 'events.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'checkpoints', 'checkpoint-probe.json'))).toBe(false);
    });

    it('refuses queue reset while a normal TaskService task is active', async () => {
      const services = createServiceContainer(testRoot);
      const task = services.task.createTask({ description: 'active worker must survive reset' });
      services.task.moveToActive({ id: task.id, filePath: task.filePath!, status: 'pending' } as any);
      expect(() => services.task.clean()).toThrow('QUEUE_CLEAN_REFUSED');
      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: ['queue'],
        dryRun: false,
        confirmed: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACTIVE_QUEUE_WORK');
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'active', path.basename(task.filePath!)))).toBe(true);
      services.task.interruptTask(task.id, 'test cleanup');
    });

    it('queue reset clears old checkpoints before a reused task ID can be recovered', async () => {
      const services = createServiceContainer(testRoot);
      const taskId = 'task-reset-checkpoint-reuse';
      const oldTask = createCoreTask({ id: taskId, description: 'old attempt with saved progress', agent: 'analyst_agent', cwd: testRoot });
      saveCheckpoint(testRoot, {
        taskId,
        agentId: 'analyst_agent',
        iteration: 8,
        maxIterations: 10,
        progressPct: 0.9,
        totalTokens: 900,
        filesChanged: ['old-attempt-output.ts'],
        lastToolCalls: [{ name: 'write_file', summary: 'old attempt output' }],
        wasProductive: true,
        idleCount: 0,
        costUSD: 0.01,
        savedAt: Date.now(),
        startedAt: Date.now() - 1000,
        progressSummary: 'Old attempt made progress before the queue reset.',
        retryCount: 0,
      });
      expect(fs.existsSync(oldTask.filePath)).toBe(true);
      expect(loadCheckpoint(testRoot, taskId)?.progressPct).toBe(0.9);

      const reset = await executeDeterministicReset({ projectRoot: testRoot, categories: ['queue'], dryRun: false, confirmed: true });
      expect(reset.success).toBe(true);
      expect(reset.removedFiles.map((file) => file.relativePath)).toContain(`.maos/checkpoints/${taskId}.json`);
      expect(loadCheckpoint(testRoot, taskId)).toBeNull();

      const newAttempt = createCoreTask({ id: taskId, description: 'new attempt before its first checkpoint', agent: 'analyst_agent', cwd: testRoot });
      services.task.moveToActive(newAttempt);
      expect(services.task.interruptTask(taskId, 'simulated crash before replacement checkpoint')?.status).toBe('interrupted');
      const recovery = recoverOrphanedTasks(testRoot);
      expect(recovery.markedDone).toBe(0);
      expect(recovery.recovered).toBe(1);
      expect(recovery.details[0]).toMatchObject({ taskId, action: 'requeued' });
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'active', `${taskId}.md`))).toBe(false);
      expect(fs.existsSync(path.join(testRoot, '.maos', 'queue', 'pending', `${taskId}.md`))).toBe(true);
      expect(loadCheckpoint(testRoot, taskId)).toBeNull();
    });

    it('refuses queue reset after TaskService interrupt until worker exit is established', async () => {
      const services = createServiceContainer(testRoot);
      const task = services.task.createTask({ description: 'interrupt marker does not prove worker exit' });
      services.task.moveToActive({ id: task.id, filePath: task.filePath!, status: 'pending' } as any);
      saveCheckpoint(testRoot, {
        taskId: task.id,
        agentId: task.agent,
        iteration: 2,
        maxIterations: 10,
        progressPct: 0.2,
        totalTokens: 100,
        filesChanged: ['in-progress.ts'],
        lastToolCalls: [],
        wasProductive: true,
        idleCount: 0,
        costUSD: 0,
        savedAt: Date.now(),
        startedAt: Date.now() - 1000,
        progressSummary: 'Task was interrupted while worker ownership is unknown.',
        retryCount: 0,
      });
      expect(services.task.interruptTask(task.id, 'test interruption')?.status).toBe('interrupted');

      const reset = await executeDeterministicReset({ projectRoot: testRoot, categories: ['queue'], dryRun: false, confirmed: true });
      expect(reset.success).toBe(false);
      expect(reset.error).toBe('ACTIVE_QUEUE_WORK');
      expect(reset.message).toContain('worker exit is unconfirmed');
      const activeTaskPath = path.join(testRoot, '.maos', 'queue', 'active', path.basename(task.filePath!));
      expect(fs.existsSync(activeTaskPath)).toBe(true);
      expect(loadCheckpoint(testRoot, task.id)).not.toBeNull();
      expect(() => services.task.clean()).toThrow('worker exit is unconfirmed');
      expect(fs.existsSync(activeTaskPath)).toBe(true);
      expect(loadCheckpoint(testRoot, task.id)).not.toBeNull();
    });

    it('reports scanned and actually removed bytes separately when candidates disappear', async () => {
      fs.unlinkSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'));
      fs.unlinkSync(path.join(testRoot, 'demo', 'industrial', 'generated', 'output.md'));
      const first = path.join(testRoot, 'artifacts', 'generated', 'first.txt');
      const second = path.join(testRoot, 'artifacts', 'generated', 'second.txt');
      fs.writeFileSync(first, 'first');
      fs.writeFileSync(second, 'second');
      const originalUnlink = fsDefault.unlinkSync.bind(fsDefault);
      const unlink = vi.spyOn(fsDefault, 'unlinkSync').mockImplementation((target: any) => {
        if (String(target) === first) originalUnlink(second);
        return originalUnlink(target);
      });
      try {
        const result = await executeDeterministicReset({ projectRoot: testRoot, categories: ['output'], dryRun: false, confirmed: true });
        expect(result.success).toBe(true);
        expect(result.scannedBytes).toBe(Buffer.byteLength('first') + Buffer.byteLength('second'));
        expect(result.removedBytes).toBe(Buffer.byteLength('first'));
        expect(result.totalBytes).toBe(result.removedBytes);
      } finally {
        unlink.mockRestore();
      }
    });

    it('counts only successful unlinks when one candidate cannot be removed', async () => {
      fs.unlinkSync(path.join(testRoot, 'artifacts', 'generated', 'report-run-A.docx'));
      fs.unlinkSync(path.join(testRoot, 'demo', 'industrial', 'generated', 'output.md'));
      const first = path.join(testRoot, 'artifacts', 'generated', 'first.txt');
      const second = path.join(testRoot, 'artifacts', 'generated', 'second.txt');
      fs.writeFileSync(first, 'first');
      fs.writeFileSync(second, 'second');
      const originalUnlink = fsDefault.unlinkSync.bind(fsDefault);
      const unlink = vi.spyOn(fsDefault, 'unlinkSync').mockImplementation((target: any) => {
        if (String(target) === first) throw new Error('injected unlink failure');
        return originalUnlink(target);
      });
      try {
        const result = await executeDeterministicReset({ projectRoot: testRoot, categories: ['output'], dryRun: false, confirmed: true });
        expect(result.success).toBe(false);
        expect(result.scannedBytes).toBe(Buffer.byteLength('first') + Buffer.byteLength('second'));
        expect(result.removedBytes).toBe(Buffer.byteLength('second'));
        expect(result.error).toContain('injected unlink failure');
      } finally {
        unlink.mockRestore();
      }
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
      expect(fs.existsSync(taskAPath)).toBe(true);
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
      expect(fs.existsSync(taskAPath)).toBe(false);
    });
  });

  describe('Strict Negative Invariants', () => {
    it('never scans or deletes review packets', async () => {
      const packet = path.join(testRoot, 'review-packets', 'reset-replay-review', 'candidate.patch');
      fs.mkdirSync(path.dirname(packet), { recursive: true });
      fs.writeFileSync(packet, 'review evidence');
      expect(discoverResetCandidates(testRoot, RESET_CATEGORIES).map((candidate) => candidate.relativePath))
        .not.toContain('review-packets/reset-replay-review/candidate.patch');

      const result = await executeDeterministicReset({
        projectRoot: testRoot,
        categories: RESET_ENABLED_CATEGORIES,
        dryRun: false,
        confirmed: true,
      });
      expect(result.success).toBe(true);
      expect(fs.existsSync(packet)).toBe(true);
    });

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
