/**
 * F8-06: Calculation Trace Domain Schema & Invariants
 *
 * Formalizes engineering calculation traces:
 * - Mathematical formulas (e.g. RMS = sqrt((x₁² + x₂² + ... + xₙ²) / n))
 * - Cryptographic input provenance (source CSV path, SHA-256 hash, row count)
 * - Exact units (e.g. mm/s, (mm/s)²)
 * - Deterministic intermediate steps (sum of squares, mean square, unrounded, rounded)
 * - Safety threshold evaluation (warning/critical bounds, anomaly row IDs)
 * - Source and document citations
 * - Authoritative canonical hashing and fail-closed validation
 */

import * as crypto from 'crypto';

// ── Types & Interfaces ──────────────────────────────────────────────

export type RoundingPolicy = 'round_half_up' | 'truncate' | 'none';

export type CalculationComplianceStatus = 'PASS' | 'WARNING' | 'CRITICAL';

export interface CalculationTraceProvenance {
  readonly sourceFile: string;
  readonly sourceFileHash: string;
  readonly rowCount: number;
  readonly measurementField: string;
  readonly unit: string;
  readonly generatedAt: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly containerIdentity?: string;
}

export interface CalculationTraceIntermediates {
  readonly sampleCount: number;
  readonly sumOfSquares: number;
  readonly sumOfSquaresUnit: string;
  readonly meanSquare: number;
  readonly meanSquareUnit: string;
  readonly unroundedResult: number;
  readonly roundingPolicy: RoundingPolicy;
  readonly roundingDecimals: number;
  readonly roundedResult: number;
  readonly finalUnit: string;
}

export interface CalculationTraceThresholds {
  readonly warningThreshold: number;
  readonly criticalThreshold: number;
  readonly unit: string;
  readonly warningRowIds: readonly number[];
  readonly criticalRowIds: readonly number[];
  readonly overallStatus: CalculationComplianceStatus;
}

export interface CalculationTraceCitation {
  readonly citationId: string;
  readonly documentTitle: string;
  readonly sectionOrPage?: string;
  readonly documentHash?: string;
  readonly notes?: string;
}

export interface CalculationTraceVerificationStatus {
  readonly verified: boolean;
  readonly engine: 'rust_engine' | 'typescript_strict';
  readonly verifiedAt: string;
  readonly durationMs?: number;
  readonly errors?: readonly string[];
}

export interface CalculationTrace {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly title: string;
  readonly calculationType: string;
  readonly formula: string;
  readonly formulaLatex?: string;
  readonly provenance: CalculationTraceProvenance;
  readonly intermediates: CalculationTraceIntermediates;
  readonly thresholdEvaluation: CalculationTraceThresholds;
  readonly citations: readonly CalculationTraceCitation[];
  readonly traceHash?: string;
  readonly verification?: CalculationTraceVerificationStatus;
}

// ── Validation Errors ───────────────────────────────────────────────

export class CalculationTraceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CalculationTraceError';
  }
}

// ── Deterministic Math Helpers ──────────────────────────────────────

export function roundHalfUp(val: number, decimals: number): number {
  if (!Number.isFinite(val)) return NaN;
  const factor = Math.pow(10, decimals);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

// ── Canonical Hashing ───────────────────────────────────────────────

function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const val = obj[k];
    if (val !== undefined) {
      entries.push(JSON.stringify(k) + ':' + canonicalJson(val));
    }
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Computes canonical SHA-256 hash over calculation trace contents
 * (excluding dynamic verification status and the traceHash field itself).
 */
export function computeCalculationTraceHash(trace: CalculationTrace): string {
  const { traceHash, verification, ...rest } = trace as any;
  const canonical = canonicalJson(rest);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Validation Logic ────────────────────────────────────────────────

export interface CalculationTraceValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Strict fail-closed validator for CalculationTrace objects.
 */
export function validateCalculationTrace(trace: unknown): CalculationTraceValidationResult {
  const errors: string[] = [];

  if (!trace || typeof trace !== 'object') {
    return { valid: false, errors: ['Calculation trace must be a non-null object'] };
  }

  const t = trace as Partial<CalculationTrace>;

  // Schema version
  if (t.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, got ${t.schemaVersion}`);
  }

  // Identity
  if (!t.traceId || typeof t.traceId !== 'string' || !t.traceId.trim()) {
    errors.push('Missing or empty traceId');
  }
  if (!t.title || typeof t.title !== 'string' || !t.title.trim()) {
    errors.push('Missing or empty title');
  }
  if (!t.formula || typeof t.formula !== 'string' || !t.formula.trim()) {
    errors.push('Missing or empty formula');
  }

  // Provenance
  if (!t.provenance || typeof t.provenance !== 'object') {
    errors.push('Missing required provenance object');
  } else {
    const p = t.provenance;
    if (!p.sourceFile || typeof p.sourceFile !== 'string') {
      errors.push('Provenance missing sourceFile');
    }
    if (!p.sourceFileHash || typeof p.sourceFileHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(p.sourceFileHash)) {
      errors.push('Provenance missing or invalid sourceFileHash (must be 64-char SHA-256 hex)');
    }
    if (typeof p.rowCount !== 'number' || !Number.isInteger(p.rowCount) || p.rowCount <= 0) {
      errors.push('Provenance rowCount must be a positive integer');
    }
    if (!p.measurementField || typeof p.measurementField !== 'string') {
      errors.push('Provenance missing measurementField');
    }
    if (!p.unit || typeof p.unit !== 'string' || !p.unit.trim()) {
      errors.push('Provenance missing unit');
    }
  }

  // Intermediates
  if (!t.intermediates || typeof t.intermediates !== 'object') {
    errors.push('Missing required intermediates object');
  } else {
    const im = t.intermediates;
    if (typeof im.sampleCount !== 'number' || !Number.isInteger(im.sampleCount) || im.sampleCount <= 0) {
      errors.push('Intermediates sampleCount must be a positive integer');
    }
    if (typeof im.sumOfSquares !== 'number' || !Number.isFinite(im.sumOfSquares) || im.sumOfSquares < 0) {
      errors.push('Intermediates sumOfSquares must be a non-negative finite number');
    }
    if (!im.sumOfSquaresUnit || typeof im.sumOfSquaresUnit !== 'string' || !im.sumOfSquaresUnit.trim()) {
      errors.push('Intermediates missing sumOfSquaresUnit');
    }
    if (typeof im.meanSquare !== 'number' || !Number.isFinite(im.meanSquare) || im.meanSquare < 0) {
      errors.push('Intermediates meanSquare must be a non-negative finite number');
    }
    if (!im.meanSquareUnit || typeof im.meanSquareUnit !== 'string' || !im.meanSquareUnit.trim()) {
      errors.push('Intermediates missing meanSquareUnit');
    }
    if (typeof im.unroundedResult !== 'number' || !Number.isFinite(im.unroundedResult) || im.unroundedResult < 0) {
      errors.push('Intermediates unroundedResult must be a non-negative finite number');
    }
    if (!['round_half_up', 'truncate', 'none'].includes(im.roundingPolicy)) {
      errors.push(`Invalid roundingPolicy '${im.roundingPolicy}'. Must be 'round_half_up', 'truncate', or 'none'`);
    }
    if (typeof im.roundingDecimals !== 'number' || !Number.isInteger(im.roundingDecimals) || im.roundingDecimals < 0) {
      errors.push('Intermediates roundingDecimals must be a non-negative integer');
    }
    if (typeof im.roundedResult !== 'number' || !Number.isFinite(im.roundedResult) || im.roundedResult < 0) {
      errors.push('Intermediates roundedResult must be a non-negative finite number');
    }
    if (!im.finalUnit || typeof im.finalUnit !== 'string' || !im.finalUnit.trim()) {
      errors.push('Intermediates missing finalUnit');
    }

    // Mathematical consistency check between intermediates
    if (
      Number.isFinite(im.sampleCount) &&
      Number.isFinite(im.sumOfSquares) &&
      Number.isFinite(im.meanSquare) &&
      im.sampleCount > 0
    ) {
      const calculatedMeanSquare = im.sumOfSquares / im.sampleCount;
      if (Math.abs(calculatedMeanSquare - im.meanSquare) > 1e-9) {
        errors.push(
          `Mean square inconsistency: sumOfSquares/sampleCount (${calculatedMeanSquare}) does not match recorded meanSquare (${im.meanSquare})`,
        );
      }
    }

    if (Number.isFinite(im.meanSquare) && Number.isFinite(im.unroundedResult)) {
      const calculatedRms = Math.sqrt(im.meanSquare);
      if (Math.abs(calculatedRms - im.unroundedResult) > 1e-9) {
        errors.push(
          `RMS inconsistency: sqrt(meanSquare) (${calculatedRms}) does not match recorded unroundedResult (${im.unroundedResult})`,
        );
      }
    }

    if (
      Number.isFinite(im.unroundedResult) &&
      Number.isFinite(im.roundedResult) &&
      im.roundingPolicy === 'round_half_up'
    ) {
      const expectedRounded = roundHalfUp(im.unroundedResult, im.roundingDecimals);
      if (Math.abs(expectedRounded - im.roundedResult) > 1e-6) {
        errors.push(
          `Rounding inconsistency: roundHalfUp(${im.unroundedResult}, ${im.roundingDecimals}) = ${expectedRounded}, but got ${im.roundedResult}`,
        );
      }
    }
  }

  // Threshold Evaluation
  if (!t.thresholdEvaluation || typeof t.thresholdEvaluation !== 'object') {
    errors.push('Missing required thresholdEvaluation object');
  } else {
    const te = t.thresholdEvaluation;
    if (typeof te.warningThreshold !== 'number' || !Number.isFinite(te.warningThreshold)) {
      errors.push('thresholdEvaluation warningThreshold must be a finite number');
    }
    if (typeof te.criticalThreshold !== 'number' || !Number.isFinite(te.criticalThreshold)) {
      errors.push('thresholdEvaluation criticalThreshold must be a finite number');
    }
    if (!te.unit || typeof te.unit !== 'string' || !te.unit.trim()) {
      errors.push('thresholdEvaluation missing unit');
    }
    if (!Array.isArray(te.warningRowIds)) {
      errors.push('thresholdEvaluation warningRowIds must be an array');
    }
    if (!Array.isArray(te.criticalRowIds)) {
      errors.push('thresholdEvaluation criticalRowIds must be an array');
    }
    if (!['PASS', 'WARNING', 'CRITICAL'].includes(te.overallStatus)) {
      errors.push(`Invalid overallStatus: '${te.overallStatus}'. Must be PASS, WARNING, or CRITICAL`);
    }

    // Semantic consistency
    if (Array.isArray(te.criticalRowIds) && te.criticalRowIds.length > 0 && te.overallStatus !== 'CRITICAL') {
      errors.push(`Threshold inconsistency: critical anomalies exist but overallStatus is '${te.overallStatus}'`);
    } else if (
      Array.isArray(te.warningRowIds) &&
      te.warningRowIds.length > 0 &&
      te.criticalRowIds?.length === 0 &&
      te.overallStatus !== 'WARNING'
    ) {
      errors.push(`Threshold inconsistency: warning anomalies exist without critical, but overallStatus is '${te.overallStatus}'`);
    }
  }

  // Citations
  if (!Array.isArray(t.citations) || t.citations.length === 0) {
    errors.push('Calculation trace must contain at least one citation or source reference');
  } else {
    for (const [idx, c] of t.citations.entries()) {
      if (!c.citationId || typeof c.citationId !== 'string') {
        errors.push(`Citation at index ${idx} missing citationId`);
      }
      if (!c.documentTitle || typeof c.documentTitle !== 'string') {
        errors.push(`Citation at index ${idx} missing documentTitle`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
