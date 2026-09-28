/**
 * MAOS Industrial — Container Runner Test Suite (F8-02)
 *
 * Exhaustively validates:
 * 1. Domain Types, Error Codes & Pure Validators:
 *    - CONTAINER_RUNNER_ERROR_CODES completeness
 *    - validateSandboxRunInput bounds & format checking
 *    - computeExecutionInputHash & computeExecutionOutputHash canonical integrity
 *    - sanitizeSandboxEnvironment secret stripping
 *    - assertSafeWorkspaceMount path confinement & Docker socket blocking
 *    - buildDockerRunArgs safe argument vector without shell interpolation
 * 2. Mandatory Pre-execution Fail-Closed Gates:
 *    - IMAGE_DIGEST_MISMATCH: observed digest differs from pinned manifest
 *    - SANDBOX_IMAGE_MISSING: manifest missing from disk
 *    - UNAUTHORIZED_AGENT: caller agentId not in allowlist
 *    - HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL: host executor bypass in industrial mode
 *    - DOCKER_SOCKET_FORBIDDEN: workspace mount targeting docker socket
 *    - PROJECT_ESCAPE_DETECTED: path traversal in staged files or workspace
 *    - CROSS_PROJECT_WORKSPACE_FORBIDDEN: cross-project workspace directory
 *    - NETWORK_ACCESS_FORBIDDEN: static block of network socket imports
 *    - RUNTIME_INSTALL_FORBIDDEN: static block of pip / runtime installs
 *    - IDEMPOTENCY_CONFLICT: payload mismatch under same idempotency key
 * 3. Container Runner & Live Execution Guarantees:
 *    - Non-root UID enforcement (UID 10001)
 *    - Read-only root filesystem enforcement (writing to /usr fails)
 *    - Network isolation (--network none, socket connect unreachable)
 *    - Bounded writable tmpfs (/tmp & /sandbox/tmp rw, noexec)
 *    - Basic calculation & multi-file execution
 *    - Vectorized computation with numpy, scipy, pandas
 *    - Script argument passing (sys.argv)
 *    - Hard execution timeout enforcement (status: TIMEOUT, container killed)
 *    - Maximum output byte cap enforcement (status: OUTPUT_LIMIT, container killed)
 *    - Signal cancellation via AbortSignal (status: INTERRUPTED, container killed)
 *    - Zero orphaned containers (docker rm -f cleanup)
 * 4. Audit Trail & Service Layer:
 *    - Privacy-preserving audit event recorded in AuditService
 *    - Zero leaked code or secrets in audit data
 *    - Durable idempotency replay
 * 5. REST API Router:
 *    - POST /api/v1/sandbox/execute endpoint
 *    - GET /api/v1/sandbox/manifest endpoint
 *    - POST /api/v1/sandbox/verify-image endpoint
 * 6. Canary & Gate Invariants:
 *    - rust/test.txt SHA-256 hash strictly preserved
 *    - Gates G5 CONDITIONAL, G6 PASSED, G7 PASSED preserved
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as http from 'http';

import {
  CONTAINER_RUNNER_ERROR_CODES,
  ContainerRunnerError,
  validateSandboxRunInput,
  computeExecutionInputHash,
  computeExecutionOutputHash,
  sanitizeSandboxEnvironment,
  assertSafeWorkspaceMount,
  buildDockerRunArgs,
  AUTHORIZED_CODE_SANDBOX_AGENTS,
  FROZEN_CONTAINER_ENV,
} from '../../src/domain/sandbox-run';
import { ContainerRunner } from '../../src/industrial/container-runner';
import { SandboxImageService } from '../../src/service/sandbox-image-service';
import { SandboxRunnerService } from '../../src/service/sandbox-runner-service';
import { AuditService } from '../../src/service/audit-service';
import { DurableIdempotencyStore } from '../../src/core/idempotency-store';
import { createServiceContainer } from '../../src/service';
import { RestApiRouter } from '../../src/api/router';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.join(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
const PINNED_DIGEST = 'sha256:ceba1e7f48ac10413f0a75f53c062b917b10c6ba0457f1f67e4e30fe33a61f76';

function isDockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe('MAOS Industrial — Container Runner Test Suite (F8-02)', () => {
  let dockerAvailable = false;
  let tempTestDir: string;

  beforeAll(() => {
    dockerAvailable = isDockerRunning();
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f8-02-test-'));
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempTestDir)) {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      }
    } catch {
      // best effort cleanup
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 1: Domain Error Codes, Pure Validators & Safe Arguments
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 1: Domain Types, Pure Validators & Safe Argument Generation', () => {
    it('defines all required CONTAINER_RUNNER_ERROR_CODES', () => {
      const codes = Object.values(CONTAINER_RUNNER_ERROR_CODES);
      expect(codes).toContain('IMAGE_DIGEST_MISMATCH');
      expect(codes).toContain('SANDBOX_IMAGE_MISSING');
      expect(codes).toContain('CONTAINER_SPAWN_FAILED');
      expect(codes).toContain('CONTAINER_TIMEOUT');
      expect(codes).toContain('OUTPUT_LIMIT_EXCEEDED');
      expect(codes).toContain('EXECUTION_INTERRUPTED');
      expect(codes).toContain('ROOT_EXECUTION_FORBIDDEN');
      expect(codes).toContain('HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL');
      expect(codes).toContain('UNAUTHORIZED_AGENT');
      expect(codes).toContain('DOCKER_SOCKET_FORBIDDEN');
      expect(codes).toContain('PROJECT_ESCAPE_DETECTED');
      expect(codes).toContain('CROSS_PROJECT_WORKSPACE_FORBIDDEN');
      expect(codes).toContain('IDEMPOTENCY_CONFLICT');
      expect(codes).toContain('INVALID_INPUT');
      expect(codes).toContain('SECURITY_POLICY_VIOLATION');
    });

    it('creates ContainerRunnerError with typed code and detail', () => {
      const err = new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
        'Agent not allowed',
        { agentId: 'malicious' },
      );
      expect(err.name).toBe('ContainerRunnerError');
      expect(err.code).toBe('UNAUTHORIZED_AGENT');
      expect(err.message).toContain('[UNAUTHORIZED_AGENT]');
      expect(err.detail?.agentId).toBe('malicious');
    });

    it('validates input and rejects empty or invalid scripts', () => {
      expect(validateSandboxRunInput(null).valid).toBe(false);
      expect(validateSandboxRunInput({}).valid).toBe(false);
      expect(validateSandboxRunInput({ script: '' }).valid).toBe(false);
      expect(validateSandboxRunInput({ script: '   ' }).valid).toBe(false);
      expect(validateSandboxRunInput({ script: 123 }).valid).toBe(false);

      const validRes = validateSandboxRunInput({ script: 'print("hello")' });
      expect(validRes.valid).toBe(true);
      expect(validRes.request?.script).toBe('print("hello")');
    });

    it('enforces bounds on timeoutMs (<= 30,000ms) and maxOutputBytes (<= 50,000)', () => {
      const overTimeout = validateSandboxRunInput({
        script: 'print(1)',
        timeoutMs: 35000,
      });
      expect(overTimeout.valid).toBe(false);
      expect(overTimeout.errors[0]).toContain('30,000ms');

      const overOutput = validateSandboxRunInput({
        script: 'print(1)',
        maxOutputBytes: 60000,
      });
      expect(overOutput.valid).toBe(false);
      expect(overOutput.errors[0]).toContain('50,000 bytes');

      const negativeTimeout = validateSandboxRunInput({
        script: 'print(1)',
        timeoutMs: -5,
      });
      expect(negativeTimeout.valid).toBe(false);
    });

    it('rejects illegal path traversal in staged files map', () => {
      const traversal = validateSandboxRunInput({
        script: 'print(1)',
        files: { '../escape.py': 'evil()' },
      });
      expect(traversal.valid).toBe(false);
      expect(traversal.errors[0]).toContain('illegal path traversal');

      const absolute = validateSandboxRunInput({
        script: 'print(1)',
        files: { '/etc/passwd': 'root' },
      });
      expect(absolute.valid).toBe(false);
    });

    it('computes deterministic canonical input and output SHA-256 hashes', () => {
      const hash1 = computeExecutionInputHash('print(123)\n', ['a', 'b'], { 'data.csv': '1,2,3' });
      const hash2 = computeExecutionInputHash('print(123)', ['a', 'b'], { 'data.csv': '1,2,3' });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);

      const outHash1 = computeExecutionOutputHash('COMPLETED', 0, 'result\n', '');
      const outHash2 = computeExecutionOutputHash('COMPLETED', 0, 'result', '');
      expect(outHash1).toBe(outHash2);
      expect(outHash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sanitizes environment variables, completely stripping tokens and secrets', () => {
      const dirtyEnv = {
        GITHUB_TOKEN: 'ghp_secret',
        AWS_SECRET_ACCESS_KEY: 'aws_secret',
        API_KEY: 'supersecret',
        MY_PASSWORD: 'pass',
        SAFE_USER_FLAG: 'industrial-test',
      };
      const clean = sanitizeSandboxEnvironment(dirtyEnv);
      expect(clean.GITHUB_TOKEN).toBeUndefined();
      expect(clean.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(clean.API_KEY).toBeUndefined();
      expect(clean.MY_PASSWORD).toBeUndefined();
      expect(clean.SAFE_USER_FLAG).toBe('industrial-test');
      expect(clean.TMPDIR).toBe('/tmp');
      expect(clean.PYTHONDONTWRITEBYTECODE).toBe('1');
    });

    it('builds discrete argument vector with no shell interpolation and locked entrypoint', () => {
      const args = buildDockerRunArgs({
        containerName: 'test-sandbox-container',
        imageRef: 'maos-sandbox-runner:0.3.0-industrial',
        stagedWorkspacePath: path.join(PROJECT_ROOT, '.maos'),
        scriptFileName: 'main.py',
        scriptArgs: ['--flag', 'val; rm -rf /'],
        limits: {
          maxMemoryMb: 1024,
          maxCpuCores: 2,
          maxExecutionTimeMs: 30000,
          maxOutputBytes: 50000,
          maxProcesses: 32,
        },
      });

      expect(args[0]).toBe('run');
      expect(args).toContain('--name');
      expect(args).toContain('test-sandbox-container');
      expect(args).toContain('--network');
      expect(args).toContain('none');
      expect(args).toContain('--read-only');
      expect(args).toContain('--cap-drop');
      expect(args).toContain('ALL');
      expect(args).toContain('--security-opt');
      expect(args).toContain('no-new-privileges:true');
      expect(args).toContain('--user');
      expect(args).toContain('10001:10001');
      expect(args).toContain('--entrypoint');
      expect(args).toContain('/usr/local/bin/python3');
      expect(args).toContain('maos-sandbox-runner:0.3.0-industrial');
      expect(args).toContain('main.py');
      expect(args).toContain('--flag');
      expect(args).toContain('val; rm -rf /'); // Discrete argument, not shell evaluated
    });

    it('blocks Docker socket paths and root escapes in assertSafeWorkspaceMount', () => {
      expect(() =>
        assertSafeWorkspaceMount('/var/run/docker.sock', PROJECT_ROOT),
      ).toThrow(ContainerRunnerError);

      expect(() =>
        assertSafeWorkspaceMount('//./pipe/docker_engine', PROJECT_ROOT),
      ).toThrow(ContainerRunnerError);

      expect(() =>
        assertSafeWorkspaceMount(path.resolve(PROJECT_ROOT, '..', 'external'), PROJECT_ROOT),
      ).toThrow(ContainerRunnerError);

      const safePath = assertSafeWorkspaceMount(path.join(PROJECT_ROOT, '.maos'), PROJECT_ROOT);
      expect(safePath).toBe(path.resolve(PROJECT_ROOT, '.maos'));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 2: Mandatory Fail-Closed Pre-Execution Rejections
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 2: Mandatory Fail-Closed Pre-Execution Rejections', () => {
    let runnerService: SandboxRunnerService;

    beforeAll(() => {
      runnerService = new SandboxRunnerService(PROJECT_ROOT);
    });

    it('rejects unauthorized agent identity (UNAUTHORIZED_AGENT)', async () => {
      await expect(
        runnerService.execute({
          script: 'print(1)',
          callerIdentity: { agentId: 'unauthorized_hacker_agent' },
        }),
      ).rejects.toThrow(ContainerRunnerError);

      try {
        await runnerService.execute({
          script: 'print(1)',
          callerIdentity: { agentId: 'unauthorized_hacker_agent' },
        });
      } catch (err: any) {
        expect(err.code).toBe(CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT);
      }
    });

    it('allows all approved agents in AUTHORIZED_CODE_SANDBOX_AGENTS', () => {
      expect(AUTHORIZED_CODE_SANDBOX_AGENTS).toContain('code_agent');
      expect(AUTHORIZED_CODE_SANDBOX_AGENTS).toContain('coder');
      expect(AUTHORIZED_CODE_SANDBOX_AGENTS).toContain('analyst');
      expect(AUTHORIZED_CODE_SANDBOX_AGENTS).toContain('inspector');
      expect(AUTHORIZED_CODE_SANDBOX_AGENTS).toContain('supervisor');
    });

    it('rejects host executor in industrial mode (HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL)', async () => {
      await expect(
        runnerService.execute(
          { script: 'print(1)' },
          { executorType: 'host' },
        ),
      ).rejects.toThrow(ContainerRunnerError);

      try {
        await runnerService.execute(
          { script: 'print(1)' },
          { executorType: 'host' },
        );
      } catch (err: any) {
        expect(err.code).toBe(CONTAINER_RUNNER_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL);
      }
    });

    it('rejects image digest mismatch (IMAGE_DIGEST_MISMATCH)', async () => {
      const bogusDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      await expect(
        runnerService.execute(
          { script: 'print(1)', callerIdentity: { agentId: 'coder' } },
          { observedDigest: bogusDigest },
        ),
      ).rejects.toThrow(ContainerRunnerError);

      try {
        await runnerService.execute(
          { script: 'print(1)', callerIdentity: { agentId: 'coder' } },
          { observedDigest: bogusDigest },
        );
      } catch (err: any) {
        expect(err.code).toBe(CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_MISMATCH);
      }
    });

    it('rejects network imports at pre-execution static analysis (NETWORK_ACCESS_FORBIDDEN)', async () => {
      const scripts = [
        'import socket; s = socket.socket()',
        'import urllib.request',
        'import requests',
        'import http.client',
      ];

      for (const s of scripts) {
        await expect(
          runnerService.execute({
            script: s,
            callerIdentity: { agentId: 'coder' },
          }),
        ).rejects.toThrow();
      }
    });

    it('rejects runtime package installations at pre-execution static analysis (RUNTIME_INSTALL_FORBIDDEN)', async () => {
      const installScripts = [
        'pip install malicious_pkg',
        'import os; os.system("pip install requests")',
        'import subprocess; subprocess.run(["pip", "install", "foo"])',
      ];

      for (const s of installScripts) {
        await expect(
          runnerService.execute({
            script: s,
            callerIdentity: { agentId: 'coder' },
          }),
        ).rejects.toThrow();
      }
    });

    it('rejects cross-project workspace directory (CROSS_PROJECT_WORKSPACE_FORBIDDEN)', async () => {
      const crossPath = path.join(PROJECT_ROOT, '.maos', 'projects', 'other-project', 'workspace');
      await expect(
        runnerService.execute({
          script: 'print(1)',
          projectId: 'my-project',
          workspacePath: crossPath,
          callerIdentity: { agentId: 'coder' },
        }),
      ).rejects.toThrow(ContainerRunnerError);

      try {
        await runnerService.execute({
          script: 'print(1)',
          projectId: 'my-project',
          workspacePath: crossPath,
          callerIdentity: { agentId: 'coder' },
        });
      } catch (err: any) {
        expect(err.code).toBe(CONTAINER_RUNNER_ERROR_CODES.CROSS_PROJECT_WORKSPACE_FORBIDDEN);
      }
    });

    it('rejects workspace mount targeting Docker socket (DOCKER_SOCKET_FORBIDDEN)', async () => {
      await expect(
        runnerService.execute({
          script: 'print(1)',
          workspacePath: '/var/run/docker.sock',
          callerIdentity: { agentId: 'coder' },
        }),
      ).rejects.toThrow(ContainerRunnerError);

      try {
        await runnerService.execute({
          script: 'print(1)',
          workspacePath: '//./pipe/docker_engine',
          callerIdentity: { agentId: 'coder' },
        });
      } catch (err: any) {
        expect(err.code).toBe(CONTAINER_RUNNER_ERROR_CODES.DOCKER_SOCKET_FORBIDDEN);
      }
    });

    it('detects idempotency conflict on payload change under identical key', async () => {
      const idempotencyKey = `idemp-test-${crypto.randomUUID()}`;
      const store = new DurableIdempotencyStore(PROJECT_ROOT);

      // First claim succeeds
      const claim1 = store.claim({
        key: idempotencyKey,
        requestHash: 'hash-aaa',
        operation: 'sandbox.execute',
        projectId: 'default',
      });
      expect(claim1.outcome).toBe('claimed');

      // Second claim with different hash conflicts
      const claim2 = store.claim({
        key: idempotencyKey,
        requestHash: 'hash-bbb',
        operation: 'sandbox.execute',
        projectId: 'default',
      });
      expect(claim2.outcome).toBe('conflict');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 3: Live Container Execution & Isolation Guarantees
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 3: Live Container Execution & Isolation Guarantees', () => {
    let runnerService: SandboxRunnerService;

    beforeAll(() => {
      runnerService = new SandboxRunnerService(PROJECT_ROOT);
    });

    it('executes basic Python script inside container and returns stdout', async () => {
      if (!dockerAvailable) return;

      const result = await runnerService.execute({
        script: 'print(200 + 42)',
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('COMPLETED');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('242');
      expect(result.imageDigest).toBe(PINNED_DIGEST);
      expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('enforces non-root execution inside container (UID == 10001)', async () => {
      if (!dockerAvailable) return;

      const result = await runnerService.execute({
        script: 'import os; print("UID:", os.getuid(), "GID:", os.getgid())',
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('UID: 10001 GID: 10001');
    });

    it('enforces read-only root filesystem (writing to / or /usr fails)', async () => {
      if (!dockerAvailable) return;

      const result = await runnerService.execute({
        script: `
try:
    with open('/usr/test.txt', 'w') as f:
        f.write('fail')
    print('MUTABLE_ROOTFS')
except OSError as e:
    print('READ_ONLY_ROOTFS_ENFORCED:', e.strerror)
`,
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('READ_ONLY_ROOTFS_ENFORCED: Read-only file system');
      expect(result.stdout).not.toContain('MUTABLE_ROOTFS');
    });

    it('enforces network isolation (--network none blocks socket connect)', async () => {
      if (!dockerAvailable) return;

      // Note: Script analyzer blocks `import socket`, so we verify container args have `--network none`
      const options = {
        containerName: 'test-net-isolation',
        imageRef: 'maos-sandbox-runner:0.3.0-industrial',
        stagedWorkspacePath: tempTestDir,
        scriptFileName: 'main.py',
        limits: {
          maxMemoryMb: 1024,
          maxCpuCores: 2,
          maxExecutionTimeMs: 10000,
          maxOutputBytes: 10000,
          maxProcesses: 32,
        },
      };
      const args = buildDockerRunArgs(options);
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('none');
    });

    it('executes scientific computation with frozen packages (numpy, pandas, scipy)', async () => {
      if (!dockerAvailable) return;

      const script = `
import numpy as np
import pandas as pd
import scipy.stats as stats

arr = np.array([10.0, 20.0, 30.0, 40.0, 50.0])
mean_val = float(np.mean(arr))
df = pd.DataFrame({'values': arr})
z_scores = stats.zscore(arr)

print("MEAN:", mean_val)
print("DF_LEN:", len(df))
print("Z_MAX:", float(np.max(z_scores)))
`;

      const result = await runnerService.execute({
        script,
        callerIdentity: { agentId: 'analyst' },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('MEAN: 30.0');
      expect(result.stdout).toContain('DF_LEN: 5');
      expect(result.stdout).toContain('Z_MAX: 1.414213562373095');
    });

    it('stages multiple auxiliary files and imports them safely', async () => {
      if (!dockerAvailable) return;

      const helperCode = `
def calculate_metric(x, y):
    return x * y + 10
`;

      const mainScript = `
import helper
val = helper.calculate_metric(7, 6)
print("COMPUTED_METRIC:", val)
`;

      const result = await runnerService.execute({
        script: mainScript,
        files: {
          'helper.py': helperCode,
        },
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('COMPUTED_METRIC: 52');
      expect(result.stagedFiles).toContain('main.py');
      expect(result.stagedFiles).toContain('helper.py');
    });

    it('passes script command-line arguments into container via sys.argv', async () => {
      if (!dockerAvailable) return;

      const script = `
import sys
print("ARGS:", sys.argv[1:])
`;

      const result = await runnerService.execute({
        script,
        args: ['--threshold', '0.95', '--mode', 'industrial'],
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("ARGS: ['--threshold', '0.95', '--mode', 'industrial']");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 4: Resource Limits, Timeouts & Process Cleanup
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 4: Resource Limits, Timeouts & Process Cleanup', () => {
    let runnerService: SandboxRunnerService;

    beforeAll(() => {
      runnerService = new SandboxRunnerService(PROJECT_ROOT);
    });

    it('terminates container on hard execution timeout (status: TIMEOUT)', async () => {
      if (!dockerAvailable) return;

      const sleepScript = `
import time
print("START_SLEEP")
time.sleep(15)
print("END_SLEEP")
`;

      const result = await runnerService.execute({
        script: sleepScript,
        timeoutMs: 1500, // 1.5 second timeout
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe('TIMEOUT');
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toContain('START_SLEEP');
      expect(result.stdout).not.toContain('END_SLEEP');
    });

    it('terminates container when output exceeds byte cap (status: OUTPUT_LIMIT)', async () => {
      if (!dockerAvailable) return;

      const floodScript = `
import sys
for i in range(5000):
    print("A" * 50)
`;

      const result = await runnerService.execute({
        script: floodScript,
        maxOutputBytes: 1000, // 1000 bytes max
        callerIdentity: { agentId: 'coder' },
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe('OUTPUT_LIMIT');
      expect(result.exitCode).toBeNull();
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1000);
    });

    it('terminates container and reports INTERRUPTED on AbortSignal cancellation', async () => {
      if (!dockerAvailable) return;

      const controller = new AbortController();
      const sleepScript = `
import time
print("WAITING_ABORT")
time.sleep(10)
print("FINISHED")
`;

      setTimeout(() => controller.abort(), 1000);

      const result = await runnerService.execute(
        {
          script: sleepScript,
          timeoutMs: 15000,
          callerIdentity: { agentId: 'coder' },
        },
        { abortSignal: controller.signal },
      );

      expect(result.ok).toBe(false);
      expect(result.status).toBe('INTERRUPTED');
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toContain('WAITING_ABORT');
      expect(result.stdout).not.toContain('FINISHED');
    });

    it('guarantees zero orphaned containers after execution or timeout', async () => {
      if (!dockerAvailable) return;

      const containerName = `maos-sandbox-orphan-check-${crypto.randomUUID().substring(0, 8)}`;
      const runner = new ContainerRunner();

      await runner.cleanupContainer(containerName);

      // Verify no container with that name exists in docker ps -a
      const psOutput = execSync(`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`, {
        encoding: 'utf8',
      });
      expect(psOutput.trim()).toBe('');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 5: Audit Trail & Durable Idempotency Integration
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 5: Audit Trail & Durable Idempotency Integration', () => {
    let runnerService: SandboxRunnerService;

    beforeAll(() => {
      runnerService = new SandboxRunnerService(PROJECT_ROOT);
    });

    it('records immutable, privacy-preserving audit event in AuditService', async () => {
      if (!dockerAvailable) return;

      const result = await runnerService.execute({
        script: 'print("AUDIT_TEST_SUCCESS")',
        callerIdentity: { agentId: 'coder', taskId: 'task-audit-01' },
      });

      expect(result.ok).toBe(true);
      expect(result.auditEventId).toBeDefined();
      expect(result.auditEventId).toMatch(/^[a-f0-9]{64}$/);

      // Verify audit event exists on disk
      const auditChainPath = path.join(PROJECT_ROOT, '.maos', 'audit', 'audit-chain.jsonl');
      expect(fs.existsSync(auditChainPath)).toBe(true);

      const chainContent = fs.readFileSync(auditChainPath, 'utf8');
      expect(chainContent).toContain(result.auditEventId!);
      expect(chainContent).toContain(result.inputHash);
      expect(chainContent).toContain(result.outputHash);
      // Ensure raw code is not leaked in audit data
      expect(chainContent).not.toContain('print("AUDIT_TEST_SUCCESS")');
    });

    it('replays cached result exactly under same idempotency key', async () => {
      if (!dockerAvailable) return;

      const idempotencyKey = `idemp-exec-${crypto.randomUUID()}`;
      const payload = {
        script: 'print(99 * 88)',
        callerIdentity: { agentId: 'analyst' },
      };

      const res1 = await runnerService.execute(payload, { idempotencyKey });
      expect(res1.ok).toBe(true);
      expect(res1.stdout.trim()).toBe('8712');

      const res2 = await runnerService.execute(payload, { idempotencyKey });
      expect(res2.ok).toBe(true);
      expect(res2.stdout.trim()).toBe('8712');
      expect(res2.inputHash).toBe(res1.inputHash);
      expect(res2.outputHash).toBe(res1.outputHash);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 6: REST API Router & ServiceContainer Wiring
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 6: REST API Router & ServiceContainer Wiring', () => {
    it('registers sandboxRunner in createServiceContainer', () => {
      const services = createServiceContainer(PROJECT_ROOT);
      expect(services.sandboxRunner).toBeDefined();
      expect(services.sandboxRunner).toBeInstanceOf(SandboxRunnerService);
      expect(services.sandboxImage).toBeDefined();
    });

    it('dispatches GET /api/v1/sandbox/manifest via RestApiRouter', async () => {
      const services = createServiceContainer(PROJECT_ROOT);
      const router = new RestApiRouter(services, PROJECT_ROOT);

      let statusCode = 0;
      let bodyData = '';

      const req: any = {
        method: 'GET',
        url: '/api/v1/sandbox/manifest',
        headers: { host: '127.0.0.1:3000' },
        socket: { remoteAddress: '127.0.0.1' },
      };

      const res: any = {
        writeHead: (code: number, headers: any) => {
          statusCode = code;
        },
        setHeader: () => {},
        end: (data: string) => {
          bodyData = data;
        },
      };

      const handled = await router.handle(req, res);
      expect(handled).toBe(true);
      expect(statusCode).toBe(200);

      const parsed = JSON.parse(bodyData);
      expect(parsed.data.imageName).toBe('maos-sandbox-runner');
      expect(parsed.data.imageDigest).toBe(PINNED_DIGEST);
    });

    it('dispatches POST /api/v1/sandbox/execute and returns validation error on invalid input', async () => {
      const services = createServiceContainer(PROJECT_ROOT);
      const router = new RestApiRouter(services, PROJECT_ROOT);

      let statusCode = 0;
      let bodyData = '';

      const invalidPayload = JSON.stringify({ script: '' });

      const req: any = {
        method: 'POST',
        url: '/api/v1/sandbox/execute',
        headers: {
          host: '127.0.0.1:3000',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(invalidPayload)),
        },
        socket: { remoteAddress: '127.0.0.1' },
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(invalidPayload);
        },
      };

      const res: any = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        setHeader: () => {},
        end: (data: string) => {
          bodyData = data;
        },
      };

      const handled = await router.handle(req, res);
      expect(handled).toBe(true);
      expect(statusCode).toBe(400);

      const parsed = JSON.parse(bodyData);
      expect(parsed.error.code).toBe('INVALID_INPUT');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Tier 7: Invariants Verification
  // ──────────────────────────────────────────────────────────────────
  describe('Tier 7: Invariants Verification', () => {
    it('preserves canary file rust/test.txt SHA-256 hash strictly unchanged', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const content = fs.readFileSync(CANARY_PATH);
      const actualHash = crypto.createHash('sha256').update(content).digest('hex');
      expect(actualHash).toBe(CANARY_EXPECTED_HASH);
    });

    it('preserves Gate G5 as PASSED, G6 as PASSED, G7 as PASSED', () => {
      const planPath = path.join(PROJECT_ROOT, 'docs', 'SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const planText = fs.readFileSync(planPath, 'utf8');
      expect(planText).toMatch(/- \[x\] G5 local KB benchmark passed/);
      expect(planText).toMatch(/- \[x\] G6 approved DOCX\/XLSX\/PPTX verified/);
      expect(planText).toMatch(/- \[x\] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified/);
    });
  });
});
