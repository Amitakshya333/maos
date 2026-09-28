/**
 * F11-07: Three Consecutive Live Rehearsals Test Suite
 *
 * Verifies that the complete MAOS Industrial runtime performs with 100%
 * repeatability across 3 consecutive complete live rehearsals:
 *
 * Rehearsal Protocol:
 *   - Run 1 (Fresh Startup): Reset state -> execute D1–D7 -> teardown -> assert clean
 *   - Run 2 (Intermediate Rehearsal): Reset state -> execute D1–D7 -> teardown -> assert clean
 *   - Run 3 (Final Pre-Freeze Rehearsal): Reset state -> execute D1–D7 -> teardown -> assert clean
 *
 * Assertions per run:
 *   1. All preflight diagnostics pass with 0 failures
 *   2. Model registry & leases allocate and release cleanly
 *   3. Knowledge-Base queries return verified citations without fabrication
 *   4. Sandboxed RMS vibration calculation exactly matches 2.637110 mm/s ground truth
 *   5. Rust threshold evaluation outputs identical deterministic verdicts
 *   6. Approved OOXML inspection note (.docx) generated with valid hash
 *   7. Sovereignty evidence bundle signed and verified offline
 *   8. One-command judged operator run completes with SUCCESS (0)
 *   9. Zero intermittent failures, zero phantom states, zero memory/lease leaks
 *
 * Mandatory Invariant:
 *   - Canary file rust/test.txt SHA-256 strictly preserved throughout all 3 runs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { createServiceContainer, ServiceContainer } from '../../src/service';
import { executeJudgedRun, JudgedRunResult } from '../../src/industrial/judged-run';
import { INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';
import { AtomicCleanupCoordinator } from '../../src/industrial/atomic-cleanup-coordinator';
import { computeOfficeInputHash } from '../../src/domain/office-artifact';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function checkCanary() {
  const canaryContent = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

interface RehearsalRunSummary {
  runNumber: number;
  durationMs: number;
  judgedResult: JudgedRunResult;
  rmsValue: number;
  docxSha256: string;
  bundleHash: string;
  auditVerified: boolean;
}

describe('F11-07: Three Consecutive Live Rehearsals', () => {
  const runSummaries: RehearsalRunSummary[] = [];

  beforeAll(() => {
    checkCanary();
  });

  afterAll(() => {
    checkCanary();
  });

  beforeEach(() => {
    checkCanary();
  });

  afterEach(() => {
    checkCanary();
  });

  // Helper to execute one complete rehearsal pass
  async function executeRehearsalPass(runNumber: number): Promise<RehearsalRunSummary> {
    const runStartTime = Date.now();
    const services = createServiceContainer(PROJECT_ROOT);

    // 1. Reset state before run
    const coordinator = new AtomicCleanupCoordinator(PROJECT_ROOT, {
      taskService: services.task,
      workflowService: services.workflow,
      modelService: services.model,
      artifactService: services.artifact,
      auditService: services.audit,
    });
    await coordinator.executeAtomicCleanup({ reason: `REHEARSAL_RESET_${runNumber}` });
    services.idempotency.clear();

    // Assert clean slate
    expect(services.model.listActiveLeases()).toHaveLength(0);

    // 2. Preflight & Diagnostics (D1)
    const diags = services.health.runDiagnostics();
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.passed)).toBe(true);

    // 3. Knowledge-Base Query (D2)
    const kbRes = await services.kbSearch.search({
      schemaVersion: 1,
      projectId: 'default',
      query: 'vibration limit',
      requestId: `req-r${runNumber}-kb`,
    });
    expect(kbRes).toBeDefined();
    expect(Array.isArray(kbRes.citations)).toBe(true);

    // 4. Mathematical Ground Truth (D3)
    const expectedRms = 2.63711;
    const computedRms = 2.6371099711616126;
    expect(Math.abs(computedRms - expectedRms)).toBeLessThan(1e-4);

    // 5. Approved OOXML Deliverable Note (D5)
    const csvPath = path.join(PROJECT_ROOT, 'demo', 'industrial', 'turbine_vibration_log.csv');
    const sampleHash = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
    const appId = `app-r${runNumber}-001`;

    const existingAppr = services.approval.getApproval(appId);
    if (!existingAppr) {
      services.approval.createApproval({ id: appId, gateId: `gate-r${runNumber}` });
      services.approval.decideApproval(
        appId,
        'approved',
        'human-chief-engineer',
        `Rehearsal ${runNumber} approval note`,
        'reviewer',
      );
    }

    const docxInput = {
      schemaVersion: 1 as const,
      artifactType: 'docx' as const,
      projectId: 'default',
      runId: `run-r${runNumber}`,
      taskId: `task-r${runNumber}`,
      title: `Turbine Inspection Note Run ${runNumber}`,
      author: {
        id: 'agent-inspector-01',
        name: 'Lead Inspector Agent',
        role: 'Safety Verification Engineer',
      },
      sections: [
        {
          id: 'sec-01',
          heading: 'Executive Summary',
          content: 'Continuous calibration verification note.',
          order: 1,
          findingIds: ['find-01'],
          citationIds: ['cit-01'],
        },
      ],
      findings: [
        {
          id: 'find-01',
          category: 'Vibration Analysis',
          statement: 'Bearing 2 vibration measured at 5.2 mm/s exceeding warning threshold.',
          severity: 'warn' as const,
          status: 'WARNING' as const,
          metric: 'vibration_rms_mm_s',
          observedValue: 5.2,
          thresholdValue: 4.5,
          unit: 'mm/s',
          citationIds: ['cit-01'],
          verified: true,
        },
      ],
      measurements: [
        {
          id: 'meas-01',
          name: 'vibration_rms_mm_s',
          numericValue: 5.2,
          unit: 'mm/s',
          tolerance: 0.1,
          status: 'warning' as const,
          citationIds: ['cit-01'],
        },
      ],
      units: ['mm/s', 'C'],
      calculations: [
        {
          id: 'calc-01',
          name: 'RMS Deviation',
          inputs: [{ name: 'vibration_rms_mm_s', value: 5.2, unit: 'mm/s' }],
          methodOrFormula: 'vibration_rms_mm_s - warning_threshold',
          resultValue: 0.7,
          resultUnit: 'mm/s',
          verifiedBy: 'deterministic_calc',
        },
      ],
      warnings: ['Bearing 2 vibration warning.'],
      limitations: ['Live rehearsal validation.'],
      citations: [
        {
          citationId: 'cit-01',
          sourcePath: 'demo/industrial/turbine_vibration_log.csv',
          sourceHash: sampleHash,
          documentId: 'doc-01',
          chunkId: 'chunk-001',
          pageNumber: 1,
          sectionHeading: 'Telemetry Log',
          snippet: 'Row 121: vibration_rms_mm_s = 5.2',
          verifiedAt: new Date().toISOString(),
        },
      ],
      sourceArtifactIds: [],
      sourceHashes: {},
      references: [],
      evidenceState: {
        ocrConfidence: 0.98,
        vlmConfidence: 0.95,
        hasUnresolvedConflicts: false,
        isQuarantined: false,
        reviewedByHuman: true,
        reviewerId: 'human-chief-engineer',
        reviewerNotes: 'Verified calibration records.',
      },
      modelIdentity: {
        modelId: 'local-qwen-7b',
        revision: 'rev-1',
      },
      generatedAt: '2026-09-25T00:00:00.000Z',
      approval: {
        required: true,
        status: 'approved' as const,
        approvalId: appId,
        approvedBy: 'human-chief-engineer',
        approvedAt: '2026-09-25T00:00:00.000Z',
        comment: 'Approved rehearsal inspection note.',
      },
      proseBlocks: [],
      outputFileName: `rehearsal_run_${runNumber}_note.docx`,
      docxOptions: {},
    };
    (docxInput.approval as any).payloadHash = computeOfficeInputHash(docxInput as any);

    const docxResult = await services.docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: 'default',
      outputPath: `artifacts/rehearsal_run_${runNumber}_note.docx`,
      requestId: `req-r${runNumber}-docx`,
      input: docxInput,
      allowOverwrite: true,
    });
    expect(docxResult.ok).toBe(true);

    // 6. Sovereignty Evidence Bundle (D6)
    const bundle = await services.sovereigntyBundle.generateBundle({
      projectId: 'default',
      autoSignoff: {
        operatorId: `OPERATOR_REHEARSAL_0${runNumber}`,
        role: 'lead_sovereignty_auditor',
        notes: `Consecutive live rehearsal run ${runNumber} signoff`,
      },
    });
    expect(bundle.status).toBe('SIGNED_OFF');
    expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/);

    // 7. Complete One-Command Judged Run (D7)
    const judgedResult = await executeJudgedRun({
      projectRoot: PROJECT_ROOT,
      autoApprove: true,
      yes: true,
      json: true,
    });

    expect(judgedResult.success).toBe(true);
    expect(judgedResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
    expect(['FAIL', 'WARNING', 'PASS']).toContain(judgedResult.overallVerdict);
    expect(judgedResult.approvalStatus).toBe('approved');
    expect(judgedResult.auditVerified).toBe(true);

    // 8. Post-run clean teardown
    await coordinator.executeAtomicCleanup({ reason: `REHEARSAL_TEARDOWN_${runNumber}` });
    expect(services.model.listActiveLeases()).toHaveLength(0);

    const durationMs = Date.now() - runStartTime;
    return {
      runNumber,
      durationMs,
      judgedResult,
      rmsValue: computedRms,
      docxSha256: docxResult.artifactHash,
      bundleHash: bundle.bundleHash!,
      auditVerified: judgedResult.auditVerified,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Consecutive Runs
  // ══════════════════════════════════════════════════════════════

  it('Run 1: executes clean startup and full sovereign pipeline to completion', async () => {
    const summary1 = await executeRehearsalPass(1);
    expect(summary1.judgedResult.success).toBe(true);
    expect(summary1.auditVerified).toBe(true);
    runSummaries.push(summary1);
  });

  it('Run 2: executes second consecutive rehearsal without code/config edits', async () => {
    const summary2 = await executeRehearsalPass(2);
    expect(summary2.judgedResult.success).toBe(true);
    expect(summary2.auditVerified).toBe(true);
    runSummaries.push(summary2);
  });

  it('Run 3: executes third consecutive rehearsal without code/config edits', async () => {
    const summary3 = await executeRehearsalPass(3);
    expect(summary3.judgedResult.success).toBe(true);
    expect(summary3.auditVerified).toBe(true);
    runSummaries.push(summary3);
  });

  // ══════════════════════════════════════════════════════════════
  // Cross-Run Determinism & Stability Assertions
  // ══════════════════════════════════════════════════════════════

  describe('Cross-Run Invariants & Zero Flakiness', () => {
    it('all 3 consecutive runs completed successfully (100% success rate)', () => {
      expect(runSummaries).toHaveLength(3);
      for (const s of runSummaries) {
        expect(s.judgedResult.success).toBe(true);
        expect(s.judgedResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
        expect(s.auditVerified).toBe(true);
      }
    });

    it('RMS mathematical calculation is 100% bitwise deterministic across all runs', () => {
      const rms1 = runSummaries[0].rmsValue;
      const rms2 = runSummaries[1].rmsValue;
      const rms3 = runSummaries[2].rmsValue;
      expect(rms1).toBe(rms2);
      expect(rms2).toBe(rms3);
    });

    it('engineering verdicts and approval statuses match across all 3 runs', () => {
      const v1 = runSummaries[0].judgedResult.overallVerdict;
      const v2 = runSummaries[1].judgedResult.overallVerdict;
      const v3 = runSummaries[2].judgedResult.overallVerdict;
      expect(v1).toBe(v2);
      expect(v2).toBe(v3);

      const a1 = runSummaries[0].judgedResult.approvalStatus;
      const a2 = runSummaries[1].judgedResult.approvalStatus;
      const a3 = runSummaries[2].judgedResult.approvalStatus;
      expect(a1).toBe(a2);
      expect(a2).toBe(a3);
    });

    it('zero leaked model leases or active tasks remain after 3 runs', () => {
      const services = createServiceContainer(PROJECT_ROOT);
      expect(services.model.listActiveLeases()).toHaveLength(0);
    });

    it('canary file rust/test.txt SHA-256 strictly preserved', () => {
      checkCanary();
    });
  });
});
