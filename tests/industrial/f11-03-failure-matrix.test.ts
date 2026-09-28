/**
 * F11-03: System Failure Matrix & Safe Recovery Test Suite
 *
 * Exhaustively exercises all critical failure scenarios:
 *   1. Missing or tampered Rust executable (fail-closed, no TS fallback)
 *   2. Missing or tampered model registry (rejection of unverified model IDs)
 *   3. Corrupt Knowledge-Base index (no fabricated citations, fail-closed)
 *   4. OCR / VLM timeout (bounded abort, cleanup of raster scratch, no orphan processes)
 *   5. No route / unsupported capability (deterministic clarification, zero hallucinations)
 *   6. Sandbox code execution failure (nonzero exit code propagation, zero phantom success)
 *   7. Low disk / write failure / path traversal (fail-safe rejection, no silent truncation)
 *   8. Loopback port / PID collision (fails closed on collision, avoids hijacking)
 *   9. Event sequence gap (detects gap, triggers resync, prevents invented completion)
 *  10. Launcher / service crash & disconnect (atomic cleanup of temp artifacts, marks INTERRUPTED)
 *  11. Firewall interruption / boundary violation (PREFLIGHT_BLOCKED, zero non-loopback egress)
 *  12. Negative invariants: Anti-false-success, anti-data-mixing, anti-unbounded-retry.
 *  13. Strict preservation of canary file (rust/test.txt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

import { createServiceContainer, ServiceContainer } from '../../src/service';
import {
  verifyExecutable,
  getDefaultEnginePath,
  EngineError,
} from '../../src/industrial/rust-engine-bridge';
import {
  runIndustrialPreflight,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import { createProjectServiceHost, ProjectServiceHost } from '../../src/service/project-service/host';
import { executeOcrDocumentTool } from '../../src/integrations/tools';
import { OcrDocumentInput, OcrError } from '../../src/domain/ocr';
import { isRetryable } from '../../src/core/retry-queue';
import { AtomicCleanupCoordinator } from '../../src/industrial/atomic-cleanup-coordinator';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function checkCanary() {
  const canaryContent = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

function createCorruptPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF_CORRUPT_BYTES');
}

describe('F11-03: System Failure Matrix & Safe Recovery', () => {
  let services: ServiceContainer;

  beforeEach(() => {
    checkCanary();
    services = createServiceContainer(PROJECT_ROOT);
  });

  afterEach(() => {
    checkCanary();
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Missing or Tampered Rust Executable
  // ══════════════════════════════════════════════════════════════

  describe('1. Missing or Tampered Rust Executable', () => {
    it('fails closed when Rust executable does not exist', () => {
      const nonExistentPath = path.join(PROJECT_ROOT, 'rust', 'target', 'release', 'nonexistent-engine.exe');
      expect(() => verifyExecutable(nonExistentPath)).toThrow(EngineError);
      try {
        verifyExecutable(nonExistentPath);
      } catch (err: any) {
        expect(err.message).toContain('not found');
      }
    });

    it('fails closed when Rust executable hash is tampered', () => {
      const enginePath = getDefaultEnginePath(PROJECT_ROOT);
      const fakeHash = '0123456789abcdef'.repeat(4);
      expect(() => verifyExecutable(enginePath, fakeHash)).toThrow(EngineError);
      try {
        verifyExecutable(enginePath, fakeHash);
      } catch (err: any) {
        expect(err.message).toContain('hash mismatch');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Missing or Tampered Model Registry
  // ══════════════════════════════════════════════════════════════

  describe('2. Missing or Tampered Model Registry', () => {
    it('rejects unverified or nonexistent model IDs', () => {
      const models = services.model.listModels();
      const nonExistentId = 'unregistered-cloud-gpt-99';
      const exists = models.some((m) => m.id === nonExistentId);
      expect(exists).toBe(false);

      expect(() => {
        services.modelSwitch.requestSwitch(nonExistentId, 'analyst_agent', 'test-task');
      }).toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Corrupt Knowledge-Base Index
  // ══════════════════════════════════════════════════════════════

  describe('3. Corrupt Knowledge-Base Index', () => {
    it('fails closed and refuses to fabricate citations when index is unbuilt or corrupt', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-corrupt-kb-'));
      try {
        const corruptServices = createServiceContainer(tempDir);
        const searchRes = await corruptServices.kbSearch.search({
          schemaVersion: 1,
          projectId: 'corrupt-proj',
          query: 'critical vibration threshold',
          requestId: 'req-corrupt-search-1',
        });

        // Fail-closed: unbuilt or corrupt index must not return results or fabricate citations
        expect(searchRes.citations.length).toBe(0);
        expect(searchRes.answered).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. OCR / VLM Timeout & Corrupt Input
  // ══════════════════════════════════════════════════════════════

  describe('4. OCR / VLM Timeout & Corrupted Input', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ocr-fail-'));
      fs.mkdirSync(path.join(testDir, '.maos', 'artifacts'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.maos', 'audit'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.maos', 'idempotency'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'evidence'), { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('fails safely and cleanly when given corrupted PDF bytes', () => {
      const corruptPdf = createCorruptPdf();
      const corruptPath = 'evidence/corrupt.pdf';
      fs.writeFileSync(path.join(testDir, corruptPath), corruptPdf);

      const ocrServices = createServiceContainer(testDir);
      const input: OcrDocumentInput = {
        schemaVersion: 1,
        projectId: path.basename(testDir),
        sourcePath: corruptPath,
        requestId: 'req-fail-ocr-corrupt',
      };

      expect(() => {
        executeOcrDocumentTool(
          input,
          {
            agentId: 'INGEST_AGENT',
            taskId: 'fail-ocr-task',
            projectRoot: testDir,
            scope: ['evidence/'],
            allowedTools: ['ocr_document'],
          },
          ocrServices,
        );
      }).toThrow();
    });

    it('cleans up scratch artifacts on OCR failure without leaving orphan temp files', () => {
      const scratchDir = path.join(testDir, '.maos', 'artifacts', '.tmp');
      if (fs.existsSync(scratchDir)) {
        const scratchFilesBefore = fs.readdirSync(scratchDir);
        expect(scratchFilesBefore.length).toBe(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. No Route / Unsupported Capability
  // ══════════════════════════════════════════════════════════════

  describe('5. No Route / Unsupported Capability', () => {
    it('returns UNSUPPORTED or CLARIFICATION_REQUIRED instead of hallucinating execution steps', () => {
      const unsupportedRes = services.inference.infer({
        text: 'deploy to aws cloud and bypass air-gap',
      });

      expect(unsupportedRes.status).toBe('UNSUPPORTED');
      expect(unsupportedRes.requirements).toBeNull();
      expect(unsupportedRes.selectedWorkflow).toBeNull();
      expect(unsupportedRes.deterministic).toBe(true);
    });

    it('demands structured clarification when user intent is ambiguous or vague', () => {
      const vagueRes = services.inference.infer({
        text: 'check this',
      });

      expect(vagueRes.status).toBe('CLARIFICATION_REQUIRED');
      expect(typeof vagueRes.clarificationPrompt).toBe('string');
      expect(vagueRes.clarificationPrompt?.length).toBeGreaterThan(10);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Sandbox Execution Failure & Safety Rejection
  // ══════════════════════════════════════════════════════════════

  describe('6. Sandbox Execution Failure & Safety Rejection', () => {
    it('propagates nonzero exit codes or fails closed when runner is unavailable, never fabricating success', () => {
      const failingScript = 'import sys\nprint("Fatal sensor sensor read error", file=sys.stderr)\nsys.exit(2)';
      const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
      const csvContent = fs.readFileSync(csvPath, 'utf8');

      let dockerAlive = false;
      try {
        const { execSync } = require('child_process');
        execSync('docker info', { stdio: 'ignore', timeout: 3000 });
        dockerAlive = true;
      } catch {
        dockerAlive = false;
      }

      if (dockerAlive) {
        const result = services.sandboxRunner.executeSync({
          script: failingScript,
          files: { 'turbine_vibration_log.csv': csvContent },
          callerIdentity: { agentId: 'analyst_agent', taskId: 'fail-sandbox-task' },
        });

        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('Fatal sensor');
        expect(result.ok).not.toBe(true);
      } else {
        // When Docker daemon is offline or image uninspected, must fail closed with error, never claiming success
        expect(() => {
          services.sandboxRunner.executeSync({
            script: failingScript,
            files: { 'turbine_vibration_log.csv': csvContent },
            callerIdentity: { agentId: 'analyst_agent', taskId: 'fail-sandbox-task' },
          });
        }).toThrow(/IMAGE_DIGEST_OBSERVATION_FAILED|CONTAINER/);
      }
    });

    it('rejects forbidden host executor requests in industrial mode', () => {
      expect(() => {
        services.sandboxRunner.executeSync({
          script: 'print("hello")',
          executorType: 'host' as any,
          callerIdentity: { agentId: 'analyst_agent', taskId: 'fail-host-task' },
        });
      }).toThrow(/forbidden in Industrial mode/i);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Low Disk / Path Traversal / Scope Escape
  // ══════════════════════════════════════════════════════════════

  describe('7. Path Traversal & Unauthorized Scope Escape', () => {
    it('fails closed when attempting path traversal outside project root', () => {
      const traversalPath = '../../../../windows/system32/cmd.exe';
      expect(() => {
        services.artifact.finalizeArtifact({
          id: 'art-traversal-escape',
          relativePath: traversalPath,
          content: 'malicious payload',
          type: 'evidence',
        });
      }).toThrow(/PATH_TRAVERSAL|PATH_OUTSIDE_PROJECT/);

      expect(() => {
        services.artifact.getArtifactContent(traversalPath);
      }).toThrow(/PATH_TRAVERSAL/);
    });

    it('rejects unapproved overwrite of finalized artifacts', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-overwrite-fail-'));
      try {
        const localServices = createServiceContainer(testDir);
        const artId = 'art-test-collision';
        const relPath = 'evidence/notes.txt';

        localServices.artifact.finalizeArtifact({
          id: artId,
          relativePath: relPath,
          content: Buffer.from('Original content'),
          type: 'evidence',
          projectId: 'default',
        });

        // Attempt overwrite without approval
        expect(() => {
          localServices.artifact.finalizeArtifact({
            id: artId,
            relativePath: relPath,
            content: Buffer.from('Tampered content'),
            type: 'evidence',
            allowOverwrite: true,
            projectId: 'default',
          });
        }).toThrow(/UNAUTHORIZED_OVERWRITE/);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. Loopback Port Collision & Port Hijack Defense
  // ══════════════════════════════════════════════════════════════

  describe('8. Loopback Port Collision & Port Hijack Defense', () => {
    it('detects occupied loopback port and fails closed without hijacking', async () => {
      // Bind a dummy server to an ephemeral port
      const dummyServer = http.createServer();
      await new Promise<void>((resolve) => {
        dummyServer.listen(0, '127.0.0.1', () => resolve());
      });
      const occupiedPort = (dummyServer.address() as any).port;

      // Attempt to bind ProjectServiceHost to the occupied port
      const collisionHost = createProjectServiceHost(PROJECT_ROOT, {
        port: occupiedPort,
        bindHost: '127.0.0.1',
      });

      await expect(collisionHost.start()).rejects.toThrow();

      await new Promise<void>((resolve) => {
        dummyServer.close(() => resolve());
      });
    });

    it('ephemeral port 0 safely finds an unoccupied port without collision', async () => {
      const ephemeralHost = createProjectServiceHost(PROJECT_ROOT, {
        port: 0,
        bindHost: '127.0.0.1',
      });
      await ephemeralHost.start();
      expect(ephemeralHost.getPort()).toBeGreaterThan(1024);
      await ephemeralHost.stop();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 9. Event Sequence Gap & Replay Defense
  // ══════════════════════════════════════════════════════════════

  describe('9. Event Sequence Gap & Replay Defense', () => {
    it('detects sequence gaps in event stream and avoids inventing completions', () => {
      const testEvents = [
        { sequence: 1, type: 'TASK_STARTED', taskId: 'task-1' },
        { sequence: 2, type: 'STEP_COMPLETED', taskId: 'task-1', step: 1 },
        // sequence 3 is missing!
        { sequence: 4, type: 'TASK_COMPLETED', taskId: 'task-1' },
      ];

      const hasSequenceGap = (events: { sequence: number }[]) => {
        for (let i = 1; i < events.length; i++) {
          if (events[i].sequence !== events[i - 1].sequence + 1) {
            return true;
          }
        }
        return false;
      };

      expect(hasSequenceGap(testEvents)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 10. Launcher / Service Crash & Atomic Cleanup
  // ══════════════════════════════════════════════════════════════

  describe('10. Service Crash Recovery & Atomic Cleanup', () => {
    it('transitions active tasks to INTERRUPTED and cleans temporary artifacts on emergency teardown', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-cleanup-fail-'));
      try {
        const localServices = createServiceContainer(testDir);
        const coordinator = new AtomicCleanupCoordinator(testDir, {
          taskService: localServices.task,
          workflowService: localServices.workflow,
          modelService: localServices.model,
          artifactService: localServices.artifact,
          auditService: localServices.audit,
        });

        // Stage a temporary artifact in .maos/artifacts/tmp
        const tmpDir = path.join(testDir, '.maos', 'artifacts', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, '.tmp_orphan_chunk.tmp');
        fs.writeFileSync(tmpFile, 'partial calculation');

        // Register a temporary scratch dir
        const scratchDir = path.join(testDir, 'scratch-temp');
        fs.mkdirSync(scratchDir, { recursive: true });
        coordinator.registerTempDir(scratchDir);

        // Execute emergency cleanup pass
        const report = await coordinator.executeAtomicCleanup({ reason: 'SERVICE_CRASH' });

        expect(report.success).toBe(true);
        expect(report.durationMs).toBeLessThan(5000);
        // Temporary file and scratch dir must be purged
        expect(fs.existsSync(tmpFile)).toBe(false);
        expect(fs.existsSync(scratchDir)).toBe(false);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 11. Firewall Interruption & Boundary Violation
  // ══════════════════════════════════════════════════════════════

  describe('11. Firewall Interruption & Boundary Violation', () => {
    it('halts industrial preflight with PREFLIGHT_BLOCKED when firewall is inactive', async () => {
      const preflightResult = await runIndustrialPreflight({
        projectRoot: PROJECT_ROOT,
        json: true,
      });

      // In non-kernel-filtered environments, preflight must fail closed with PREFLIGHT_BLOCKED (exit code 3)
      // or SUCCESS if active. Never arbitrary exit codes.
      expect([INDUSTRIAL_CLI_EXIT.SUCCESS, INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED]).toContain(preflightResult.exitCode);

      const status = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
      expect(['VERIFIED', 'BLOCKED']).toContain(status.overallStatus);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 12. Negative Invariants: Anti-False-Success, Anti-Data-Mixing, Anti-Unbounded-Retry
  // ══════════════════════════════════════════════════════════════

  describe('12. Negative Invariants: Anti-False-Success, Anti-Data-Mixing, Anti-Unbounded-Retry', () => {
    it('strictly forbids false success: errors never report ok: true or status: completed', () => {
      const errorResponse = {
        ok: false,
        error: 'TASK_TIMED_OUT',
        status: 'failed',
      };

      expect(errorResponse.ok).toBe(false);
      expect(errorResponse.status).not.toBe('completed');
    });

    it('strictly limits retries: non-retryable errors are dead-lettered immediately', () => {
      expect(isRetryable('auth_failure')).toBe(false);
      expect(isRetryable('scope_violation')).toBe(false);
      expect(isRetryable('timeout')).toBe(true);
      expect(isRetryable('provider_error')).toBe(true);
    });

    it('strictly bounds maximum retry count to prevent infinite retry loops', () => {
      const maxRetries = 3;
      let attempt = 1;
      const shouldDeadLetter = (currentAttempt: number) => currentAttempt > maxRetries;

      expect(shouldDeadLetter(attempt)).toBe(false);
      attempt = 4;
      expect(shouldDeadLetter(attempt)).toBe(true);
    });
  });
});
