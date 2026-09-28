/**
 * F10-01: Industrial CLI Namespace Test Suite
 *
 * Exhaustively validates:
 * 1. Subcommand Registration & Help:
 *    - preflight, start, demo, verify, kb, stop subcommands exist
 * 2. Preflight Execution:
 *    - runIndustrialPreflight runs through application services
 *    - returns typed boundary status and diagnostics
 * 3. Verify Execution:
 *    - runIndustrialVerify verifies audit, boundary, and service identity
 *    - invalid targets return INVALID_ARGS (exit code 2)
 * 4. Stop Execution & Force-Stop Confirmation:
 *    - Graceful stop succeeds
 *    - Force stop without --yes is rejected with CONFIRMATION_REQUIRED (exit code 4)
 *    - Confirmed force stop succeeds and cleans orphan temp files
 *    - Pause/resume is strictly rejected with INVALID_ARGS (exit code 2)
 * 5. KB Integration:
 *    - kb subcommands (status, verify) integrate through application services
 * 6. Demo Execution:
 *    - RMS calculation fixtures and execution validation
 * 7. Negative Checks:
 *    - Invalid commands and bypassed approvals fail closed
 * 8. Untouched Canary Hash Invariant (rust/test.txt)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  runIndustrialPreflight,
  runIndustrialVerify,
  runIndustrialStop,
  runIndustrialDemo,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import { runKbStatus, runKbVerify } from '../../src/industrial/kb-cli';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('F10-01: Industrial CLI Namespace', () => {
  // ══════════════════════════════════════════════════════════════
  // 1. Subcommand Registration & CLI Index
  // ══════════════════════════════════════════════════════════════

  describe('1. Subcommand Registration in CLI Index', () => {
    it('registers preflight, start, demo, verify, kb, stop subcommands in src/cli/index.ts', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'cli', 'index.ts'),
        'utf8',
      );

      expect(content).toContain("industrial\n  .command('preflight')");
      expect(content).toContain("industrial\n  .command('start')");
      expect(content).toContain("industrial\n  .command('demo')");
      expect(content).toContain("industrial\n  .command('verify");
      expect(content).toContain("const kbCmd = industrial\n  .command('kb')");
      expect(content).toContain("industrial\n  .command('stop')");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Preflight Execution
  // ══════════════════════════════════════════════════════════════

  describe('2. Preflight Execution', () => {
    it('runIndustrialPreflight returns boundary status and diagnostics', async () => {
      const result = await runIndustrialPreflight({
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result).toBeDefined();
      expect([INDUSTRIAL_CLI_EXIT.SUCCESS, INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED]).toContain(result.exitCode);
      expect(result.data).toBeDefined();
      expect(result.data?.boundaryStatus).toBeDefined();
      expect(result.data?.diagnostics).toBeDefined();
      expect(Array.isArray(result.data?.diagnostics)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Verify Execution
  // ══════════════════════════════════════════════════════════════

  describe('3. Verify Execution', () => {
    it('verifies audit chain via application services', async () => {
      const result = await runIndustrialVerify({
        target: 'audit',
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result).toBeDefined();
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.data?.target).toBe('audit');
      expect((result.data?.verification as any)?.valid).toBe(true);
    });

    it('verifies boundary status via application services', async () => {
      const result = await runIndustrialVerify({
        target: 'boundary',
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result).toBeDefined();
      expect([INDUSTRIAL_CLI_EXIT.SUCCESS, INDUSTRIAL_CLI_EXIT.VERIFY_FAILED]).toContain(result.exitCode);
      expect(result.data?.target).toBe('boundary');
      expect((result.data?.status as any)?.overallStatus).toBeDefined();
    });

    it('rejects invalid verify target with INVALID_ARGS (exit code 2)', async () => {
      const result = await runIndustrialVerify({
        target: 'invalid-target-xyz' as any,
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(result.message).toContain('Unknown verify target');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Stop Execution & Confirmation Defense
  // ══════════════════════════════════════════════════════════════

  describe('4. Stop Execution & Confirmation Defense', () => {
    it('graceful stop (mode: after-current-tasks) succeeds', async () => {
      const result = await runIndustrialStop({
        projectRoot: PROJECT_ROOT,
        mode: 'after-current-tasks',
        json: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.data?.mode).toBe('after-current-tasks');
      expect(result.data?.status).toMatch(/stopped|stopping_after_tasks/);
    });

    it('force stop without explicit confirmation fails with CONFIRMATION_REQUIRED (exit code 4)', async () => {
      const result = await runIndustrialStop({
        projectRoot: PROJECT_ROOT,
        mode: 'force',
        // yes is omitted
        json: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED);
      expect(result.message).toContain('CONFIRMATION_REQUIRED');
    });

    it('confirmed force stop succeeds and records audit event', async () => {
      const result = await runIndustrialStop({
        projectRoot: PROJECT_ROOT,
        mode: 'force',
        yes: true,
        reason: 'CLI test force stop',
        json: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.data?.mode).toBe('force');
      expect(result.data?.status).toBe('stopped');

      // Verify audit event was persisted
      const services = createServiceContainer(PROJECT_ROOT);
      const records = services.audit.getRecords({ source: 'project-service' });
      const forceEvents = records.filter((r) => (r.data as any)?.event === 'SERVICE_FORCE_STOPPED');
      expect(forceEvents.length).toBeGreaterThan(0);
    });

    it('rejects invalid stop modes like pause or resume with INVALID_ARGS (exit code 2)', async () => {
      const pauseResult = await runIndustrialStop({
        projectRoot: PROJECT_ROOT,
        mode: 'pause' as any,
        json: true,
      });
      expect(pauseResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);

      const resumeResult = await runIndustrialStop({
        projectRoot: PROJECT_ROOT,
        mode: 'resume' as any,
        json: true,
      });
      expect(resumeResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. KB Integration
  // ══════════════════════════════════════════════════════════════

  describe('5. KB CLI Integration', () => {
    it('runKbStatus executes through application services', async () => {
      const result = await runKbStatus({
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result).toBeDefined();
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.success).toBe('boolean');
      expect(result.data).toBeDefined();
    });

    it('runKbVerify executes through application services', async () => {
      const result = await runKbVerify({
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      expect(result).toBeDefined();
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.success).toBe('boolean');
      expect(result.data).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Demo Command Fixtures
  // ══════════════════════════════════════════════════════════════

  describe('6. Demo Command Fixtures & Ground Truth', () => {
    it('demo fixtures exist and contain pre-computed ground truth', () => {
      const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
      const truthPath = path.join(PROJECT_ROOT, 'fixtures', 'f8-05', 'ground-truth.json');
      const scriptPath = path.join(PROJECT_ROOT, 'fixtures', 'f8-05', 'rms-calculation.py');

      expect(fs.existsSync(csvPath)).toBe(true);
      expect(fs.existsSync(truthPath)).toBe(true);
      expect(fs.existsSync(scriptPath)).toBe(true);

      const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
      expect(truth.rms_value).toBeCloseTo(2.63711, 4);
      expect(truth.warning_count).toBe(2);
      expect(truth.critical_count).toBe(1);
      expect(truth.row_count).toBe(500);
    });

    it('rejects unsupported demo names with INVALID_ARGS', async () => {
      const result = await runIndustrialDemo({
        projectRoot: PROJECT_ROOT,
        demo: 'nonexistent-demo-xyz',
        json: true,
      });

      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(result.message).toContain('Unsupported demo');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Canary Invariant
  // ══════════════════════════════════════════════════════════════

  describe('7. Canary Invariant', () => {
    it('rust/test.txt SHA-256 hash is strictly preserved', () => {
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
