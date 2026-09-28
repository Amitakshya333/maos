/**
 * F8-05: Sovereign RMS Coding Demo Test Suite
 *
 * Verifies:
 * 1. CSV fixture staging and SHA-256 hash preservation.
 * 2. Deterministic RMS calculation matching known ground truth to 6 decimal places.
 * 3. Exact detection of warning (>= 4.5 mm/s RMS) and critical (>= 7.1 mm/s RMS) anomalies.
 * 4. Input and output SHA-256 hash stability.
 * 5. Static script security inspection.
 * 6. Nonzero exit code propagation and failure rejection.
 * 7. Live Docker container sandbox execution with isolation invariants when Docker is available.
 * 8. Audit event recording without leaking raw calculation stdout.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { executeCodeSandboxTool } from '../../src/integrations/tools';
import { createServiceContainer } from '../../src/service';
import {
  computeExecutionInputHash,
  computeExecutionOutputHash,
  buildDockerRunArgs,
  CONTAINER_RUNNER_ERROR_CODES,
  ContainerRunnerError,
} from '../../src/domain/sandbox-run';
import { inspectScriptForSandboxViolations } from '../../src/domain/sandbox';

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CSV_SHA256 = 'd2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6';
const EXPECTED_RMS = 2.6371099711616126;
const EXPECTED_RMS_ROUNDED = 2.63711;
const EXPECTED_WARNING_COUNT = 2;
const EXPECTED_CRITICAL_COUNT = 1;
const EXPECTED_ROW_COUNT = 500;

const context = {
  agentId: 'analyst_agent',
  taskId: 'f8-05-rms-demo',
  projectRoot: path.resolve(__dirname, '../..'),
  allowedTools: ['execute_code_sandbox'],
};

const dockerAvailable = isDockerAvailable();

describe('F8-05: Sovereign RMS Coding Demo', () => {
  const csvContent = fs.readFileSync(path.join(__dirname, '../../demo/industrial/turbine_vibration_log.csv'), 'utf8');
  const rmsScript = fs.readFileSync(path.join(__dirname, '../../fixtures/f8-05/rms-calculation.py'), 'utf8');
  const verificationScript = fs.readFileSync(path.join(__dirname, '../../fixtures/f8-05/rms-verification-test.py'), 'utf8');

  const csvHash = crypto.createHash('sha256').update(csvContent).digest('hex');
  const scriptHash = crypto.createHash('sha256').update(rmsScript).digest('hex');

  const services = createServiceContainer(context.projectRoot);

  describe('CSV Fixture Integrity & Ground Truth', () => {
    it('CSV SHA-256 strictly matches pinned hash', () => {
      expect(csvHash).toBe(CSV_SHA256);
    });

    it('offline Python execution verifies deterministic calculation matching ground truth', () => {
      const tempDir = path.join(context.projectRoot, '.maos', 'scratch', 'f8-05-test');
      fs.mkdirSync(tempDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(tempDir, 'turbine_vibration_log.csv'), csvContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'rms-calculation.py'), rmsScript, 'utf8');
        const output = execSync('python rms-calculation.py', { cwd: tempDir, encoding: 'utf8' });
        const parsed = JSON.parse(output.trim());
        expect(Math.abs(parsed.rms_value - EXPECTED_RMS)).toBeLessThan(1e-6);
        expect(parsed.warning_count).toBe(EXPECTED_WARNING_COUNT);
        expect(parsed.critical_count).toBe(EXPECTED_CRITICAL_COUNT);
        expect(parsed.row_count).toBe(EXPECTED_ROW_COUNT);
        expect(parsed.warning_rows).toEqual([[121, 5.2], [367, 8.3]]);
        expect(parsed.critical_rows).toEqual([[367, 8.3]]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('static security inspection confirms zero violations in calculation script', () => {
      const inspection = inspectScriptForSandboxViolations(rmsScript);
      expect(inspection.violations.length).toBe(0);
      expect(inspection.safe).toBe(true);
    });

    it('static security inspection detects and rejects forbidden commands', () => {
      const hostileScript = 'import sys\nimport requests\nprint("exfiltrate")';
      const inspection = inspectScriptForSandboxViolations(hostileScript);
      expect(inspection.violations.length).toBeGreaterThan(0);
      expect(inspection.safe).toBe(false);
    });
  });

  describe('Hash Stability & Provenance', () => {
    it('computeExecutionInputHash is deterministic across multiple calls', () => {
      const hash1 = computeExecutionInputHash(rmsScript, undefined, { 'turbine_vibration_log.csv': csvContent });
      const hash2 = computeExecutionInputHash(rmsScript, undefined, { 'turbine_vibration_log.csv': csvContent });
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBe(64);
    });

    it('computeExecutionOutputHash is deterministic for identical execution output', () => {
      const outHash1 = computeExecutionOutputHash('COMPLETED', 0, '{"rms_value": 2.63711}', '');
      const outHash2 = computeExecutionOutputHash('COMPLETED', 0, '{"rms_value": 2.63711}', '');
      expect(outHash1).toBe(outHash2);
      expect(outHash1.length).toBe(64);
    });

    it('source file hashes match expected constants', () => {
      expect(csvHash).toBe(CSV_SHA256);
      expect(typeof scriptHash).toBe('string');
      expect(scriptHash.length).toBe(64);
    });
  });

  describe('Docker Container Sandbox Execution', () => {
    let result: any;

    beforeAll(() => {
      if (!dockerAvailable) return;
      result = executeCodeSandboxTool(
        {
          script: rmsScript,
          files: {
            'turbine_vibration_log.csv': csvContent,
          },
          requestId: 'f8-05-rms-calc-001',
        },
        context,
        services,
      );
    });

    it('container execution succeeds with exit 0', () => {
      if (!dockerAvailable) return;
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('staged files include the CSV inside container workspace', () => {
      if (!dockerAvailable) return;
      expect(result.stagedFiles).toContain('turbine_vibration_log.csv');
    });

    it('stdout contains valid JSON output', () => {
      if (!dockerAvailable) return;
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toBeDefined();
      expect(typeof parsed.rms_value).toBe('number');
    });

    it('container RMS value matches ground truth to 6 decimal places', () => {
      if (!dockerAvailable) return;
      const parsed = JSON.parse(result.stdout.trim());
      expect(Math.abs(parsed.rms_value - EXPECTED_RMS)).toBeLessThan(1e-6);
    });

    it('warning count matches expected inside container', () => {
      if (!dockerAvailable) return;
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.warning_count).toBe(EXPECTED_WARNING_COUNT);
    });

    it('critical count matches expected inside container', () => {
      if (!dockerAvailable) return;
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.critical_count).toBe(EXPECTED_CRITICAL_COUNT);
    });

    it('row count matches expected inside container', () => {
      if (!dockerAvailable) return;
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.row_count).toBe(EXPECTED_ROW_COUNT);
    });

    it('output hash is deterministic for container runs', () => {
      if (!dockerAvailable) return;
      const result2 = executeCodeSandboxTool(
        {
          script: rmsScript,
          files: { 'turbine_vibration_log.csv': csvContent },
          requestId: 'f8-05-hash-stability-002',
        },
        context,
        services,
      );
      expect(result.outputHash).toBe(result2.outputHash);
      expect(result.outputHash.length).toBe(64);
    });

    it('rejects execution with nonzero exit code', () => {
      if (!dockerAvailable) return;
      const badScript = 'import sys\nprint("error")\nsys.exit(1)';
      const badResult = executeCodeSandboxTool(
        {
          script: badScript,
          files: { 'turbine_vibration_log.csv': csvContent },
          requestId: 'f8-05-reject-nonzero-001',
        },
        context,
        services,
      );
      expect(badResult.ok).toBe(false);
      expect(badResult.exitCode).not.toBe(0);
    });

    it('rejects when verification test fails with wrong data', () => {
      if (!dockerAvailable) return;
      const mutatedCsv = csvContent.replace('5.2', '50.2');
      const failResult = executeCodeSandboxTool(
        {
          script: verificationScript,
          files: {
            'turbine_vibration_log.csv': mutatedCsv,
            'rms-calculation.py': rmsScript,
          },
          requestId: 'f8-05-reject-wrong-data-001',
        },
        context,
        services,
      );
      expect(failResult.exitCode).not.toBe(0);
    });

    it('audit event is recorded after execution without leaking raw content', () => {
      if (!dockerAvailable) return;
      const auditService = services.audit;
      const events = auditService.getRecords ? auditService.getRecords({ category: 'tool' }) : [];
      const sandboxEvents = events.filter((e: any) =>
        e.source === 'sandbox-runner' ||
        e.source === 'sandbox-runner-service'
      );
      expect(sandboxEvents.length).toBeGreaterThan(0);
      for (const evt of sandboxEvents) {
        const eventStr = JSON.stringify(evt);
        expect(eventStr).not.toContain('2.6371099711616126');
      }
    });
  });

  describe('Agent Authority & Sandbox Invocation Permissions', () => {
    it('strictly rejects invocation when agent is unauthorized', () => {
      const unauthorizedContext = {
        agentId: 'unauthorized_guest',
        taskId: 'f8-05-rms-demo',
        projectRoot: context.projectRoot,
        allowedTools: ['read_file'],
      };
      expect(() => {
        executeCodeSandboxTool(
          {
            script: rmsScript,
            files: { 'turbine_vibration_log.csv': csvContent },
            requestId: 'f8-05-unauthorized-001',
          },
          unauthorizedContext,
          services,
        );
      }).toThrowError(/UNAUTHORIZED_AGENT/);
    });

    it('rejects when allowedTools explicitly omits execute_code_sandbox', () => {
      const restrictedContext = {
        agentId: 'code_agent',
        taskId: 'f8-05-rms-demo',
        projectRoot: context.projectRoot,
        allowedTools: ['read_file', 'write_file'],
      };
      expect(() => {
        executeCodeSandboxTool(
          {
            script: rmsScript,
            files: { 'turbine_vibration_log.csv': csvContent },
            requestId: 'f8-05-restricted-001',
          },
          restrictedContext,
          services,
        );
      }).toThrowError(/UNAUTHORIZED_AGENT/);
    });

    it('authorizes CODE_AGENT when allowedTools contains execute_code_sandbox', () => {
      const codeAgentContext = {
        agentId: 'CODE_AGENT',
        taskId: 'f8-05-rms-demo',
        projectRoot: context.projectRoot,
        allowedTools: ['execute_code_sandbox'],
      };
      let authError: any = null;
      try {
        executeCodeSandboxTool(
          {
            script: rmsScript,
            files: { 'turbine_vibration_log.csv': csvContent },
            requestId: 'f8-05-code-agent-001',
          },
          codeAgentContext,
          services,
        );
      } catch (err: any) {
        authError = err;
      }
      if (authError) {
        expect(authError.code).not.toBe(CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT);
      }
    });
  });

  describe('Container Network Isolation Invariants', () => {
    it('buildDockerRunArgs explicitly passes --network none', () => {
      const args = buildDockerRunArgs({
        containerName: 'maos-rms-demo-container',
        imageRef: 'maos-sandbox-runner:0.3.0-industrial',
        stagedWorkspacePath: path.join(context.projectRoot, '.maos'),
        scriptFileName: 'rms-calculation.py',
        limits: {
          maxMemoryMb: 512,
          maxCpuCores: 2,
          maxExecutionTimeMs: 30000,
          maxOutputBytes: 50000,
          maxProcesses: 32,
        },
      });
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('none');
    });

    it('static security inspection detects and flags network socket attempts', () => {
      const socketScript = 'import socket\ns = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\ns.connect(("1.1.1.1", 80))';
      const insp = inspectScriptForSandboxViolations(socketScript);
      expect(insp.safe).toBe(false);
      expect(insp.violations.length).toBeGreaterThan(0);
    });

    it('static security inspection detects and flags HTTP client libraries', () => {
      const httpScript = 'import urllib.request\nurllib.request.urlopen("https://example.com")';
      const insp = inspectScriptForSandboxViolations(httpScript);
      expect(insp.safe).toBe(false);
      expect(insp.violations.length).toBeGreaterThan(0);
    });
  });

  describe('Source File Immutability', () => {
    it('turbine vibration CSV file on disk remains strictly unchanged with pristine SHA-256', () => {
      const csvDiskPath = path.join(__dirname, '../../demo/industrial/turbine_vibration_log.csv');
      const currentDiskContent = fs.readFileSync(csvDiskPath, 'utf8');
      const currentDiskHash = crypto.createHash('sha256').update(currentDiskContent).digest('hex');
      expect(currentDiskHash).toBe(CSV_SHA256);
      expect(currentDiskContent).toBe(csvContent);
    });
  });
});

