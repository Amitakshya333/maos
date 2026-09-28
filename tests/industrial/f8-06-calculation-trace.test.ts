/**
 * F8-06: Formal Calculation Trace Test Suite
 *
 * Verifies:
 * 1. Calculation trace schema, formula, and cryptographic provenance.
 * 2. Intermediate calculation values (sample count, sum of squares, mean square, unrounded/rounded RMS).
 * 3. Threshold evaluation with warning/critical bounds and exact anomaly row IDs.
 * 4. Citations and ISO reference requirements.
 * 5. Native Rust industrial engine deterministic verification reproducing 2.6371099711616126 mm/s.
 * 6. Comprehensive fail-closed checks:
 *    - Missing units
 *    - Missing source hash
 *    - Changed CSV contents (hash mismatch)
 *    - Numeric overflow / non-finite values
 *    - Invalid rounding policy
 *    - Mismatched final result
 *    - Missing intermediate values
 *    - Missing citations
 * 7. Audit trail recording without raw payload leakage.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  CalculationTrace,
  CalculationTraceError,
  validateCalculationTrace,
  computeCalculationTraceHash,
} from '../../src/domain/calculation-trace';
import { CalculationTraceService } from '../../src/service/calculation-trace-service';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CSV_REL_PATH = 'demo/industrial/turbine_vibration_log.csv';
const CSV_ABS_PATH = path.join(PROJECT_ROOT, CSV_REL_PATH);
const PINNED_CSV_SHA256 = 'd2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6';
const EXPECTED_RMS_RAW = 2.6371099711616126;
const EXPECTED_RMS_ROUNDED = 2.63711;

describe('F8-06: Formal Calculation Trace', () => {
  const services = createServiceContainer(PROJECT_ROOT);
  const traceService = services.calculationTrace;

  // ── 1. Trace Generation & Schema ────────────────────────────────────

  describe('1. Trace Generation & Schema Invariants', () => {
    it('generates a complete calculation trace from real turbine vibration log', () => {
      const trace = traceService.generateRmsTrace({
        traceId: 'test-rms-trace-001',
        title: 'Turbine Vibration RMS Trace',
        sourceFilePath: CSV_REL_PATH,
      });

      expect(trace.schemaVersion).toBe(1);
      expect(trace.traceId).toBe('test-rms-trace-001');
      expect(trace.calculationType).toBe('RMS');
      expect(trace.formula).toBe('RMS = sqrt((x₁² + x₂² + ... + xₙ²) / n)');
      expect(trace.formulaLatex).toContain('\\sqrt');

      // Provenance
      expect(trace.provenance.sourceFile).toBe(CSV_REL_PATH);
      expect(trace.provenance.sourceFileHash).toBe(PINNED_CSV_SHA256);
      expect(trace.provenance.rowCount).toBe(500);
      expect(trace.provenance.measurementField).toBe('vibration_rms_mm_s');
      expect(trace.provenance.unit).toBe('mm/s');

      // Intermediates
      expect(trace.intermediates.sampleCount).toBe(500);
      expect(trace.intermediates.sumOfSquares).toBeCloseTo(3477.1745, 4);
      expect(trace.intermediates.sumOfSquaresUnit).toBe('(mm/s)²');
      expect(trace.intermediates.meanSquare).toBeCloseTo(6.954349, 6);
      expect(trace.intermediates.meanSquareUnit).toBe('(mm/s)²');
      expect(Math.abs(trace.intermediates.unroundedResult - EXPECTED_RMS_RAW)).toBeLessThan(1e-12);
      expect(trace.intermediates.roundedResult).toBe(EXPECTED_RMS_ROUNDED);
      expect(trace.intermediates.finalUnit).toBe('mm/s');

      // Thresholds
      expect(trace.thresholdEvaluation.warningThreshold).toBe(4.5);
      expect(trace.thresholdEvaluation.criticalThreshold).toBe(7.1);
      expect(trace.thresholdEvaluation.unit).toBe('mm/s');
      expect(trace.thresholdEvaluation.warningRowIds).toEqual([121, 367]);
      expect(trace.thresholdEvaluation.criticalRowIds).toEqual([367]);
      expect(trace.thresholdEvaluation.overallStatus).toBe('CRITICAL');

      // Citations
      expect(trace.citations.length).toBeGreaterThan(0);
      expect(trace.citations[0].citationId).toBe('ISO-10816-3');

      // Canonical Hash
      expect(trace.traceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(trace.traceHash).toBe(computeCalculationTraceHash(trace));
    });

    it('verifies the on-disk canonical artifact F8-06-RMS-turbine-vibration.json', () => {
      const artifactPath = path.join(PROJECT_ROOT, 'artifacts/calculation-traces/F8-06-RMS-turbine-vibration.json');
      expect(fs.existsSync(artifactPath)).toBe(true);

      const raw = fs.readFileSync(artifactPath, 'utf8');
      const trace: CalculationTrace = JSON.parse(raw);

      const validation = validateCalculationTrace(trace);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(trace.traceId).toBe('F8-06-RMS-turbine-vibration');
      expect(trace.provenance.sourceFileHash).toBe(PINNED_CSV_SHA256);
      expect(trace.intermediates.sampleCount).toBe(500);
      expect(trace.intermediates.roundedResult).toBe(2.63711);
      expect(trace.traceHash).toBe(computeCalculationTraceHash(trace));
    });
  });

  // ── 2. Native Rust Industrial Engine Verification ───────────────────

  describe('2. Native Rust Deterministic Verifier', () => {
    it('authoritatively reproduces 2.6371099711616126 mm/s via Rust engine', () => {
      const trace = traceService.generateRmsTrace({
        traceId: 'test-rust-verify-001',
        sourceFilePath: CSV_REL_PATH,
      });

      const res = traceService.verifyTrace(trace, { useRustEngine: true });
      expect(res.verified).toBe(true);
      expect(res.engine).toBe('rust_engine');

      const details = res.details as any;
      expect(details.verified).toBe(true);
      expect(details.unit).toBe('mm/s');
      expect(details.sample_count).toBe(500);
      expect(details.sum_squares).toBeCloseTo(3477.1745, 4);
      expect(details.mean_square).toBeCloseTo(6.954349, 6);
      expect(Math.abs(details.unrounded_rms - EXPECTED_RMS_RAW)).toBeLessThan(1e-12);
      expect(details.rounded_rms).toBe(2.63711);
      expect(details.warning_rows).toEqual([121, 367]);
      expect(details.critical_rows).toEqual([367]);
    });
  });

  // ── 3. Fail-Closed Validation Checks ────────────────────────────────

  describe('3. Fail-Closed Security & Correctness Checks', () => {
    it('fails closed when unit is missing or empty', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const mutatedTrace = {
        ...trace,
        provenance: { ...trace.provenance, unit: '' },
      };

      expect(() => traceService.verifyTrace(mutatedTrace as any)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(mutatedTrace as any);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('Provenance missing unit');
      }
    });

    it('fails closed when sourceFileHash is missing or invalid', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const mutatedTrace = {
        ...trace,
        provenance: { ...trace.provenance, sourceFileHash: 'invalid-hash' },
      };

      expect(() => traceService.verifyTrace(mutatedTrace as any)).toThrow(CalculationTraceError);
    });

    it('fails closed when source CSV content has been modified (tampering / drift)', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      // Point to a forged hash that does not match disk content
      const tamperedTrace: CalculationTrace = {
        ...trace,
        provenance: {
          ...trace.provenance,
          sourceFileHash: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      };

      expect(() => traceService.verifyTrace(tamperedTrace)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(tamperedTrace);
      } catch (err: any) {
        expect(err.code).toBe('CHANGED_CSV_CONTENTS');
      }
    });

    it('fails closed on numeric overflow or non-finite intermediate values', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const overflowTrace = {
        ...trace,
        intermediates: {
          ...trace.intermediates,
          sumOfSquares: Infinity,
        },
      };

      expect(() => traceService.verifyTrace(overflowTrace as any)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(overflowTrace as any);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('sumOfSquares must be a non-negative finite number');
      }
    });

    it('fails closed when rounding policy is invalid', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const invalidRoundingTrace = {
        ...trace,
        intermediates: {
          ...trace.intermediates,
          roundingPolicy: 'bad_policy_xyz',
        },
      };

      expect(() => traceService.verifyTrace(invalidRoundingTrace as any)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(invalidRoundingTrace as any);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain("Invalid roundingPolicy 'bad_policy_xyz'");
      }
    });

    it('fails closed when final result is mismatched with intermediates', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const mismatchedTrace: CalculationTrace = {
        ...trace,
        intermediates: {
          ...trace.intermediates,
          unroundedResult: 99.9999, // Mismatched with sqrt(meanSquare)
        },
      };

      expect(() => traceService.verifyTrace(mismatchedTrace)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(mismatchedTrace);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('RMS inconsistency');
      }
    });

    it('fails closed when intermediate values are inconsistent (sumOfSquares / n != meanSquare)', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const inconsistentTrace: CalculationTrace = {
        ...trace,
        intermediates: {
          ...trace.intermediates,
          meanSquare: 100.0, // Inconsistent with sumOfSquares / 500
        },
      };

      expect(() => traceService.verifyTrace(inconsistentTrace)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(inconsistentTrace);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('Mean square inconsistency');
      }
    });

    it('fails closed when citations are missing', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const noCitationsTrace = {
        ...trace,
        citations: [],
      };

      expect(() => traceService.verifyTrace(noCitationsTrace as any)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(noCitationsTrace as any);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('must contain at least one citation');
      }
    });

    it('fails closed when formula is missing or empty', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      const noFormulaTrace = {
        ...trace,
        formula: '',
      };

      expect(() => traceService.verifyTrace(noFormulaTrace as any)).toThrow(CalculationTraceError);
      try {
        traceService.verifyTrace(noFormulaTrace as any);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_CALCULATION_TRACE');
        expect(err.message).toContain('Missing or empty formula');
      }
    });

    it('Rust engine independently rejects mismatched expected RMS', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      // Craft a trace where TypeScript internal math is bypassed but Rust catches the lie
      const forgedTrace: CalculationTrace = {
        ...trace,
        intermediates: {
          ...trace.intermediates,
          sumOfSquares: 3477.1745,
          meanSquare: 3477.1745 / 500,
          unroundedResult: Math.sqrt(3477.1745 / 500),
          roundedResult: 9.99999, // Lie about the rounded result
        },
      };

      expect(() => traceService.verifyTrace(forgedTrace, { useRustEngine: true })).toThrow();
    });
  });

  // ── 4. Audit & Provenance ───────────────────────────────────────────

  describe('4. Audit Trail & Provenance Invariants', () => {
    it('records privacy-preserving audit events for generation and verification', () => {
      const audit = services.audit;
      const initialCount = audit.getRecords().length;

      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
      });

      traceService.verifyTrace(trace, { useRustEngine: true });

      const records = audit.getRecords();
      expect(records.length).toBeGreaterThan(initialCount);

      const newRecords = records.slice(initialCount);
      const traceEvents = newRecords.filter(
        (r) => r.source === 'calculation-trace-service',
      );
      expect(traceEvents.length).toBeGreaterThanOrEqual(2);

      const generatedEvent = traceEvents.find((e) => (e.data as any)?.event === 'CALCULATION_TRACE_GENERATED');
      const verifiedEvent = traceEvents.find((e) => (e.data as any)?.event === 'CALCULATION_TRACE_VERIFIED');

      expect(generatedEvent).toBeDefined();
      expect((generatedEvent!.data as any).traceHash).toBe(trace.traceHash);

      expect(verifiedEvent).toBeDefined();
      expect((verifiedEvent!.data as any).engine).toBe('rust_engine');
      expect((verifiedEvent!.data as any).verified).toBe(true);

      // Verify no raw CSV text is leaked in audit records
      for (const evt of traceEvents) {
        const rawJson = JSON.stringify(evt.data);
        expect(rawJson).not.toContain('timestamp,asset_id');
      }
    });
  });

  // ── 5. Reproducibility & Invariant Verification ─────────────────────

  describe('5. Reproducibility & Invariant Verification', () => {
    it('records and verifies container/sandbox identity in calculation trace provenance', () => {
      const trace = traceService.generateRmsTrace({
        sourceFilePath: CSV_REL_PATH,
        containerIdentity: 'maos-sandbox-runner:0.3.0-industrial',
      });

      expect(trace.provenance.containerIdentity).toBe('maos-sandbox-runner:0.3.0-industrial');
      const res = traceService.verifyTrace(trace);
      expect(res.verified).toBe(true);
    });

    it('strictly reproduces identical calculation intermediates across repeated executions', () => {
      const trace1 = traceService.generateRmsTrace({
        traceId: 'repeat-001',
        sourceFilePath: CSV_REL_PATH,
      });
      const trace2 = traceService.generateRmsTrace({
        traceId: 'repeat-002',
        sourceFilePath: CSV_REL_PATH,
      });

      expect(trace1.intermediates).toEqual(trace2.intermediates);
      expect(trace1.thresholdEvaluation).toEqual(trace2.thresholdEvaluation);
      expect(trace1.provenance.sourceFileHash).toBe(trace2.provenance.sourceFileHash);
      expect(trace1.intermediates.unroundedResult).toBe(trace2.intermediates.unroundedResult);
      expect(trace1.intermediates.roundedResult).toBe(trace2.intermediates.roundedResult);
      expect(trace1.thresholdEvaluation.warningRowIds).toEqual([121, 367]);
      expect(trace1.thresholdEvaluation.criticalRowIds).toEqual([367]);
    });

    it('confirms 500-row input dataset remains bit-for-bit unchanged after trace operations', () => {
      const currentDiskContent = fs.readFileSync(CSV_ABS_PATH, 'utf8');
      const currentDiskHash = crypto.createHash('sha256').update(currentDiskContent).digest('hex');
      expect(currentDiskHash).toBe(PINNED_CSV_SHA256);
      const rowCount = currentDiskContent.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1;
      expect(rowCount).toBe(500);
    });
  });
});

