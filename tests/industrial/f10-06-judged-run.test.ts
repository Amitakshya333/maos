/**
 * F10-06: One-Command Judged Run Test Suite
 *
 * Validates the end-to-end judged operator journey in a single command:
 *   PREFLIGHT → POLICY → SERVICES → DAG (Ingest → Analyze → Approval → Synthesize) → VERIFY → AUDIT EXPORT
 *
 * Negative & Safety Invariants:
 * 1. Zero mock bypass of ServiceContainer.
 * 2. Unconfirmed auto-approval halts with CONFIRMATION_REQUIRED (exit code 4).
 * 3. Interactive run without auto-approval halts at gate with GATE_REJECTED (exit code 10).
 * 4. Preflight failure halts immediately with PREFLIGHT_BLOCKED (exit code 3).
 * 5. Policy failure halts immediately with POLICY_VIOLATION (exit code 9).
 * 6. Generated deliverable is a valid OOXML .docx citing verified source hashes.
 * 7. Audit trail is cryptographically chained and sealed.
 * 8. Mandatory preservation of canary hash (rust/test.txt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import fsDefault from 'node:fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import {
  executeJudgedRun,
  getJudgedRunManifestPath,
  readJudgedRunManifest,
  resumeJudgedRunAfterApproval,
} from '../../src/industrial/judged-run';
import { runIndustrialRun, runIndustrialVerify, INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
let testProjectRoot: string;

function createIndustrialTestProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f10-06-'));
  fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.maos', 'maos.config.json'),
    JSON.stringify({ projectName: 'maos-f10-06-test' }),
  );
  const demoDir = path.join(projectRoot, 'demo', 'industrial');
  fs.mkdirSync(demoDir, { recursive: true });
  for (const name of [
    'safety_thresholds.json',
    'turbine_vibration_log.csv',
    'maintenance_report.txt',
    'turbine_inspection_scan.pdf',
  ]) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'demo', 'industrial', name), path.join(demoDir, name));
  }
  return projectRoot;
}

describe('F10-06: One-Command Judged Run', () => {
  beforeAll(() => {
    testProjectRoot = createIndustrialTestProject();
  });

  afterAll(() => {
    if (testProjectRoot) fs.rmSync(testProjectRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Assert canary invariant prior to each test
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  afterEach(() => {
    // Assert canary invariant after each test
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  // ══════════════════════════════════════════════════════════════
  // 1. End-to-End Judged Run Success Path
  // ══════════════════════════════════════════════════════════════

  describe('1. Full End-to-End Judged Run Flow', () => {
    it('executes all 6 stages in exact sequence with --auto-approve --yes', async () => {
      const services = createServiceContainer(testProjectRoot);
      const result = await executeJudgedRun({
        projectRoot: testProjectRoot,
        services,
        autoApprove: true,
        yes: true,
        json: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.stagesCompleted).toEqual([
        'PREFLIGHT',
        'POLICY',
        'SERVICES',
        'INGEST',
        'ANALYZE',
        'APPROVAL',
        'DAG',
        'VERIFY',
        'AUDIT_EXPORT',
      ]);
      expect(result.overallVerdict).toBe('FAIL');
      expect(result.approvalStatus).toBe('approved');
      expect(result.auditVerified).toBe(true);
      expect(result.boundaryVerified).toBe(true);
      expect(result.policyVerified).toBe(true);

      // Verify RMS calculation matches ground truth
      expect(result.details).toBeDefined();
      expect(result.details?.overallRms).toBeCloseTo(2.63711, 4);
      expect(result.details?.anomalyCount).toBeGreaterThan(0);

      // Verify deliverable document on disk
      expect(result.deliverablePath).toBe('artifacts/generated/turbine_safety_approval_note.docx');
      const docxAbsPath = path.join(testProjectRoot, result.deliverablePath!);
      expect(fs.existsSync(docxAbsPath)).toBe(true);

      const docxBytes = fs.readFileSync(docxAbsPath);
      const computedDocxHash = crypto.createHash('sha256').update(docxBytes).digest('hex');
      expect(computedDocxHash).toBe(result.deliverableSha256);
      const runArtifacts = services.artifact.listArtifacts(result.runId);
      expect(runArtifacts).toHaveLength(1);
      expect(runArtifacts[0]).toMatchObject({
        runId: result.runId,
        path: result.deliverablePath,
        hash: result.deliverableSha256,
      });

      // Validate OOXML ZIP header (PK\x03\x04)
      expect(docxBytes[0]).toBe(0x50);
      expect(docxBytes[1]).toBe(0x4b);
      expect(docxBytes[2]).toBe(0x03);
      expect(docxBytes[3]).toBe(0x04);

      // Verify audit trail export on disk
      expect(result.auditExportPath).toBe(`artifacts/generated/${result.runId}-audit-export.json`);
      const auditAbsPath = path.join(testProjectRoot, result.auditExportPath!);
      expect(fs.existsSync(auditAbsPath)).toBe(true);

      const auditContent = fs.readFileSync(auditAbsPath, 'utf8');
      const auditData = JSON.parse(auditContent);
      expect(auditData.verification).toBeDefined();
      expect(auditData.verification.valid).toBe(true);
      expect(Array.isArray(auditData.records)).toBe(true);
      expect(auditData.records.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Interactive / Non-Interactive Approval Confirmation Boundaries
  // ══════════════════════════════════════════════════════════════

  describe('2. Confirmation & Human Gate Boundaries', () => {
    it('halts with CONFIRMATION_REQUIRED (exit code 4) when --auto-approve is missing --yes', async () => {
      const result = await executeJudgedRun({
        projectRoot: testProjectRoot,
        autoApprove: true,
        yes: false,
        json: true,
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED);
      expect(result.approvalStatus).toBe('pending');
      expect(result.stagesCompleted).not.toContain('DAG');
      expect(result.stagesCompleted).not.toContain('VERIFY');
      expect(result.stagesCompleted).not.toContain('AUDIT_EXPORT');
      expect(result.message).toContain('CONFIRMATION_REQUIRED');
    });

    it('halts with GATE_REJECTED (exit code 10) in interactive run without auto-approve', async () => {
      const result = await executeJudgedRun({
        projectRoot: testProjectRoot,
        autoApprove: false,
        yes: false,
        json: true,
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.GATE_REJECTED);
      expect(result.approvalStatus).toBe('pending');
      expect(result.stagesCompleted).not.toContain('DAG');
      expect(result.stagesCompleted).not.toContain('VERIFY');
      expect(result.stagesCompleted).not.toContain('AUDIT_EXPORT');
      expect(result.message).toContain('WAITING_FOR_APPROVAL');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Fail-Closed Preflight Negative Checks
  // ══════════════════════════════════════════════════════════════

  describe('3. Fail-Closed Preflight Checks', () => {
    // NOTE (F9-10): `enforceFirewall` no longer means "require a boundary that
    // some other process activated". At process scope an enforcement session is
    // in-process state, so no separate command could ever satisfy that, and the
    // flag was unusable in practice. It now means "establish a boundary for the
    // lifetime of this run and execute inside it", which is a strictly stronger
    // guarantee: the workflow is observed while it runs, not merely authorized
    // once beforehand. The previous assertion — that the run must abort whenever
    // no boundary pre-exists — pinned behaviour that was unreachable by design.
    it('establishes a boundary for the run and leaves observation evidence behind', async () => {
      const result = await executeJudgedRun({
        projectRoot: testProjectRoot,
        autoApprove: true,
        yes: true,
        enforceFirewall: true,
        json: true,
      });

      // The boundary was established and the gate passed on a measured state.
      expect(result.boundaryVerified).toBe(true);
      expect(result.success).toBe(true);

      // Teardown persisted the observation trace — proof a boundary really was
      // held during the run rather than merely checked.
      const evidenceDir = path.join(testProjectRoot, '.maos', 'network-evidence');
      expect(fs.existsSync(evidenceDir)).toBe(true);
      const traces = fs
        .readdirSync(evidenceDir)
        .filter((f) => f.endsWith('.json'));
      expect(traces.length).toBeGreaterThan(0);

      // And no boundary record was left behind claiming enforcement that ended.
      const recordPath = path.join(testProjectRoot, '.maos', 'firewall', 'process-boundary.json');
      if (fs.existsSync(recordPath)) {
        const state = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        expect(state.records.default).toBeUndefined();
      }
    });

    it('aborts with PREFLIGHT_BLOCKED when the boundary cannot be established', async () => {
      // A project root where the boundary record cannot be written: the run must
      // refuse as a structured result rather than proceed unenforced or throw.
      const tempDir = path.resolve(testProjectRoot, '.maos', 'temp-f10-06-boundary-' + Date.now());
      fs.mkdirSync(path.join(tempDir, '.maos'), { recursive: true });
      // Occupy the record path with a file so the directory cannot be created.
      fs.writeFileSync(path.join(tempDir, '.maos', 'firewall'), 'not a directory');

      try {
        const result = await executeJudgedRun({
          projectRoot: tempDir,
          autoApprove: true,
          yes: true,
          enforceFirewall: true,
          json: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED);
        expect(result.message).toContain('PREFLIGHT_BLOCKED');
        expect(result.stagesCompleted).not.toContain('DAG');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('aborts with PREFLIGHT_BLOCKED when health diagnostics fail', async () => {
      const tempDir = path.resolve(testProjectRoot, '.maos', 'temp-f10-06-diag-' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        // Run with an empty project directory where maos.config.json is missing
        const result = await executeJudgedRun({
          projectRoot: tempDir,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED);
        expect(result.message).toContain('PREFLIGHT_BLOCKED');
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Fail-Closed Policy Negative Checks
  // ══════════════════════════════════════════════════════════════

  describe('4. Fail-Closed Policy Checks', () => {
    it('aborts with POLICY_VIOLATION (exit code 9) when safety_thresholds.json is missing', async () => {
      const tempDir = path.resolve(testProjectRoot, '.maos', 'temp-f10-06-policy-' + Date.now());
      fs.mkdirSync(path.join(tempDir, '.maos'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.maos', 'maos.config.json'),
        '{"projectName":"test-project"}',
      );
      fs.mkdirSync(path.join(tempDir, 'demo', 'industrial'), { recursive: true });

      try {
        const result = await executeJudgedRun({
          projectRoot: tempDir,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.POLICY_VIOLATION);
        expect(result.stagesCompleted).toContain('PREFLIGHT');
        expect(result.stagesCompleted).not.toContain('POLICY');
        expect(result.message).toContain('POLICY_VIOLATION');
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });

    it('aborts with POLICY_VIOLATION when safety thresholds file is malformed', async () => {
      const tempDir = path.resolve(testProjectRoot, '.maos', 'temp-f10-06-badpolicy-' + Date.now());
      fs.mkdirSync(path.join(tempDir, '.maos'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.maos', 'maos.config.json'),
        '{"projectName":"test-project"}',
      );
      fs.mkdirSync(path.join(tempDir, 'demo', 'industrial'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'demo', 'industrial', 'safety_thresholds.json'),
        '{"invalid": true}',
      );

      try {
        const result = await executeJudgedRun({
          projectRoot: tempDir,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.POLICY_VIOLATION);
        expect(result.message).toContain('POLICY_VIOLATION');
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Fail-Closed Ingest Checks
  // ══════════════════════════════════════════════════════════════

  describe('5. Fail-Closed Ingest Checks', () => {
    it('aborts when demo telemetry files are missing', async () => {
      const tempDir = path.resolve(testProjectRoot, '.maos', 'temp-f10-06-missing-csv-' + Date.now());
      fs.mkdirSync(path.join(tempDir, '.maos'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.maos', 'maos.config.json'),
        '{"projectName":"test-project"}',
      );
      fs.mkdirSync(path.join(tempDir, 'demo', 'industrial'), { recursive: true });

      // Provide valid policy thresholds
      const validThresholds = fs.readFileSync(
        path.join(PROJECT_ROOT, 'demo', 'industrial', 'safety_thresholds.json'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'demo', 'industrial', 'safety_thresholds.json'),
        validThresholds,
      );

      try {
        const result = await executeJudgedRun({
          projectRoot: tempDir,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(result.success).toBe(false);
        expect(result.stagesCompleted).toContain('PREFLIGHT');
        expect(result.stagesCompleted).toContain('POLICY');
        expect(result.stagesCompleted).toContain('SERVICES');
        expect(result.stagesCompleted).not.toContain('DAG');
        expect(result.message).toContain('INGEST_FAILED');
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. CLI Wrapper & Output Equivalence
  // ══════════════════════════════════════════════════════════════

  describe('6. CLI Subcommand Wrapper & Output', () => {
    it('reports the separate Rust engine prerequisite in structured CLI failures', async () => {
      const projectRoot = createIndustrialTestProject();
      const previousCwd = process.cwd();
      try {
        process.chdir(projectRoot);
        const cliResult = await runIndustrialRun({
          projectRoot,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.FAILURE);
        expect(cliResult.data?.success).toBe(false);
        expect(cliResult.data?.message).toContain('Engine executable not found');
        expect(cliResult.data?.message).toContain('cargo build --release --locked --manifest-path rust/Cargo.toml');
        expect(cliResult.data?.message).toContain('copy rust/target/release/maos-engine[.exe]');
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('fails verification when an auto-approved run cannot persist its finalizing manifest', async () => {
      const projectRoot = createIndustrialTestProject();
      const realRename = fsDefault.renameSync.bind(fsDefault);
      let rejectedFinalizingWrite = false;
      const renameSpy = vi.spyOn(fsDefault, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
        if (!rejectedFinalizingWrite && String(destination).includes(`${path.sep}industrial-runs${path.sep}`) && String(destination).endsWith('.json')) {
          const pending = JSON.parse(fs.readFileSync(String(source), 'utf8'));
          if (pending.status === 'finalizing') {
            rejectedFinalizingWrite = true;
            throw new Error('simulated finalizing-manifest persistence failure');
          }
        }
        return realRename(source, destination);
      }) as typeof fsDefault.renameSync);
      try {
        const cliResult = await runIndustrialRun({
          projectRoot,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.VERIFY_FAILED);
        expect(cliResult.message).toContain('RUN_MANIFEST_PERSIST_FAILED');
        expect(cliResult.data?.success).toBe(false);
        expect(cliResult.data?.stagesCompleted).not.toContain('DAG');
        expect(cliResult.data?.stagesCompleted).not.toContain('AUDIT_EXPORT');
        expect(rejectedFinalizingWrite).toBe(true);
      } finally {
        renameSpy.mockRestore();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('persists an auto-approved run manifest that same-run verification accepts', async () => {
      const projectRoot = createIndustrialTestProject();
      try {
        const cliResult = await runIndustrialRun({
          projectRoot,
          autoApprove: true,
          yes: true,
          json: true,
        });

        expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
        expect(cliResult.data).toBeDefined();
        expect(cliResult.data?.success).toBe(true);
        expect(cliResult.data?.overallVerdict).toBe('FAIL');
        expect(cliResult.data?.approvalStatus).toBe('approved');
        expect(cliResult.data?.auditVerified).toBe(true);
        expect(cliResult.data?.deliverablePath).toBe(
          'artifacts/generated/turbine_safety_approval_note.docx',
        );

        const runId = String(cliResult.data?.runId);
        expect(readJudgedRunManifest(projectRoot, runId)?.status).toBe('completed');
        const verification = await runIndustrialVerify({
          projectRoot,
          target: 'audit',
          runId,
          json: true,
        });
        expect(verification.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
        expect(verification.data?.judgedRun?.valid).toBe(true);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  it('resumes an unchanged report only after a reviewer decision and independently verifies it', async () => {
    const projectRoot = createIndustrialTestProject();
    try {
      const services = createServiceContainer(projectRoot);
      const result = await executeJudgedRun({ projectRoot, services, json: true });
      const approvalId = String(result.details?.approvalId || '');
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.GATE_REJECTED);
      expect(approvalId).not.toBe('');
      services.approval.decideApproval(
        approvalId,
        'approved',
        'synthetic-reviewer',
        'Reviewed the prepared synthetic evidence.',
        'reviewer',
      );

      const completed = await resumeJudgedRunAfterApproval(projectRoot, services, approvalId);
      expect(completed.status).toBe('completed');
      expect(completed.officeInput.evidenceState.reviewedByHuman).toBe(true);
      const runArtifacts = services.artifact.listArtifacts(result.runId);
      expect(runArtifacts).toHaveLength(1);
      expect(runArtifacts[0]).toMatchObject({
        runId: result.runId,
        path: completed.deliverablePath,
        hash: completed.deliverableSha256,
      });
      const verification = await runIndustrialVerify({ projectRoot, target: 'audit', runId: result.runId, json: true });
      expect(verification.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(verification.data.judgedRun.valid).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['source evidence', 'source'],
    ['threshold rules', 'rules'],
    ['report input', 'report'],
  ] as const)('refuses to resume an approved run after %s changes', async (_name, change) => {
    const projectRoot = createIndustrialTestProject();
    try {
      const services = createServiceContainer(projectRoot);
      const result = await executeJudgedRun({ projectRoot, services, json: true });
      const approvalId = String(result.details?.approvalId || '');
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.GATE_REJECTED);
      expect(approvalId).not.toBe('');

      if (change === 'source') {
        fs.appendFileSync(path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'), '\nchanged after analysis');
      } else if (change === 'rules') {
        const rulesPath = path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
        const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
        rules.thresholds.vibration_rms_mm_s.warning += 0.1;
        fs.writeFileSync(rulesPath, JSON.stringify(rules));
      } else {
        const manifest = readJudgedRunManifest(projectRoot, result.runId)!;
        const tamperedManifest = {
          ...manifest,
          officeInput: {
            ...manifest.officeInput,
            sections: manifest.officeInput.sections.map((section, index) =>
              index === 0 ? { ...section, content: 'Changed after analysis.' } : section,
            ),
          },
        };
        fs.writeFileSync(getJudgedRunManifestPath(projectRoot, result.runId), JSON.stringify(tamperedManifest, null, 2));
      }

      services.approval.decideApproval(
        approvalId,
        'approved',
        'synthetic-reviewer',
        'Reviewed the prepared synthetic evidence.',
        'reviewer',
      );
      const expectedError = change === 'report' ? /report input changed after analysis/ : /source changed after analysis/;
      await expect(resumeJudgedRunAfterApproval(projectRoot, services, approvalId)).rejects.toThrow(expectedError);
      expect(readJudgedRunManifest(projectRoot, result.runId)?.status).toBe('failed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
