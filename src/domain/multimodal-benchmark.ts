/**
 * F4-07: Multimodal Benchmark Suite Domain Schemas and Types
 *
 * Defines the schemas, manifests, iteration records, determinism contracts,
 * and validators for the comprehensive multimodal benchmark suite.
 *
 * Covers all 18 fixture classes, 3-iteration determinism tracking,
 * hardware resource budgets, and Rust audit verification.
 */

import { ValidationResult } from './validators';
import { ConflictClassification } from './conflict';

// ── 18 Benchmark Fixture Classes ───────────────────────────────────

export type MultimodalFixtureClass =
  | 'clean_printed_scan'
  | 'multipage_report'
  | 'rotated_text'
  | 'noisy_blurred_scan'
  | 'equipment_nameplate'
  | 'gauge_measurement'
  | 'sample_drawing_pid'
  | 'ocr_vision_agreement'
  | 'ocr_vision_numeric_conflict'
  | 'ocr_vision_unit_conflict'
  | 'low_confidence_ocr'
  | 'low_confidence_vision'
  | 'unsupported_handwriting'
  | 'malformed_input'
  | 'oversized_bomb_input'
  | 'empty_input'
  | 'cross_project_attempt'
  | 'tampered_source_artifact';

export const ALL_FIXTURE_CLASSES: readonly MultimodalFixtureClass[] = [
  'clean_printed_scan',
  'multipage_report',
  'rotated_text',
  'noisy_blurred_scan',
  'equipment_nameplate',
  'gauge_measurement',
  'sample_drawing_pid',
  'ocr_vision_agreement',
  'ocr_vision_numeric_conflict',
  'ocr_vision_unit_conflict',
  'low_confidence_ocr',
  'low_confidence_vision',
  'unsupported_handwriting',
  'malformed_input',
  'oversized_bomb_input',
  'empty_input',
  'cross_project_attempt',
  'tampered_source_artifact',
] as const;

// ── Fixture Manifest Schemas ────────────────────────────────────────

export interface MultimodalFixtureDimensions {
  readonly width: number;
  readonly height: number;
  readonly pageCount?: number;
}

export interface MultimodalFixtureExpectedBehavior {
  readonly expectedClassification?: ConflictClassification | 'REJECTED' | 'UNSUPPORTED' | 'EMPTY';
  readonly requiresReview: boolean;
  readonly isSafetyCritical: boolean;
  readonly shouldFailSafely?: boolean;
  readonly expectedErrorCode?: string;
}

export interface MultimodalFixtureEntry {
  readonly id: string;
  readonly fixtureClass: MultimodalFixtureClass;
  readonly description: string;
  readonly license: string;
  readonly source: string;
  readonly filename: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly expectedSha256: string;
  readonly byteSize: number;
  readonly dimensions?: MultimodalFixtureDimensions;
  readonly expectedBehavior: MultimodalFixtureExpectedBehavior;
}

export interface MultimodalFixtureManifest {
  readonly schemaVersion: 1;
  readonly manifestVersion: string;
  readonly description: string;
  readonly generatedAt: string;
  readonly fixtures: readonly MultimodalFixtureEntry[];
}

// ── Benchmark Execution & Iteration Schemas ─────────────────────────

export interface BenchmarkIterationRecord {
  readonly runIndex: number;
  readonly timestamp: string;
  readonly coldStartMs: number;
  readonly inferenceLatencyMs: number;
  readonly pipelineLatencyMs: number;
  readonly vramPeakMb: number;
  readonly hostMemoryMb: number;
  readonly inputSha256: string;
  readonly ocrEngineVersion?: string;
  readonly vlmModelRevision?: string;
  readonly ocrOutputHash?: string;
  readonly vlmOutputHash?: string;
  readonly conflictClassification?: ConflictClassification;
  readonly requiresReview?: boolean;
  readonly isSafetyCritical?: boolean;
  readonly artifactId?: string;
  readonly auditSequence?: number;
  readonly status: 'pass' | 'fail';
  readonly error?: string;
}

export interface BenchmarkFixtureResult {
  readonly fixtureId: string;
  readonly fixtureClass: MultimodalFixtureClass;
  readonly iterations: readonly BenchmarkIterationRecord[];
  readonly deterministic: boolean;
  readonly determinismErrors: readonly string[];
  readonly avgPipelineLatencyMs: number;
  readonly maxVramMb: number;
  readonly finalClassification?: string;
  readonly requiresReview: boolean;
  readonly status: 'pass' | 'fail';
  readonly error?: string;
}

export interface MultimodalBenchmarkSummary {
  readonly totalFixtures: number;
  readonly passedFixtures: number;
  readonly failedFixtures: number;
  readonly totalIterations: number;
  readonly deterministicFixtureCount: number;
  readonly maxVramPeakMb: number;
  readonly avgPipelineLatencyMs: number;
  readonly allBudgetsPassed: boolean;
  readonly auditChainVerified: boolean;
  readonly offlineEnforced: boolean;
}

export interface MultimodalBenchmarkReport {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly projectId: string;
  readonly timestamp: string;
  readonly manifestVersion: string;
  readonly vlmModelId: string;
  readonly vlmRevision: string;
  readonly vlmQuantization: string;
  /** Measured reports require a real runtime; simulation reports are never production evidence. */
  readonly executionMode?: 'measured' | 'simulation';
  readonly vlmSnapshotHash: string;
  readonly ocrEngine: string;
  readonly ocrEngineVersion: string;
  readonly fixtureResults: readonly BenchmarkFixtureResult[];
  readonly summary: MultimodalBenchmarkSummary;
  readonly artifactId?: string;
  readonly artifactHash?: string;
  readonly auditVerification?: {
    readonly valid: boolean;
    readonly recordCount: number;
    readonly latestHash: string;
  };
}

// ── Helper Validation Functions ─────────────────────────────────────

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateMultimodalFixtureEntry(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['MultimodalFixtureEntry must be an object']);

  if (!isString(data.id) || !data.id.trim()) errors.push('id must be a non-empty string');
  if (!ALL_FIXTURE_CLASSES.includes(data.fixtureClass as MultimodalFixtureClass)) {
    errors.push(`Invalid fixtureClass: ${data.fixtureClass}`);
  }
  if (!isString(data.description)) errors.push('description must be a string');
  if (!isString(data.license) || !data.license.trim()) errors.push('license must be a non-empty string');
  if (!isString(data.source) || !data.source.trim()) errors.push('source must be a non-empty string');
  if (!isString(data.filename) || !data.filename.trim()) errors.push('filename must be a non-empty string');
  if (!isString(data.relativePath) || !data.relativePath.trim()) errors.push('relativePath must be a non-empty string');
  if (!isString(data.mimeType) || !data.mimeType.trim()) errors.push('mimeType must be a non-empty string');
  if (!isString(data.expectedSha256) || !data.expectedSha256.trim()) errors.push('expectedSha256 must be a non-empty string');
  if (!isNumber(data.byteSize) || data.byteSize < 0) errors.push('byteSize must be a non-negative number');

  if (!isObject(data.expectedBehavior)) {
    errors.push('expectedBehavior must be an object');
  } else {
    const eb = data.expectedBehavior as Record<string, unknown>;
    if (!isBoolean(eb.requiresReview)) errors.push('expectedBehavior.requiresReview must be a boolean');
    if (!isBoolean(eb.isSafetyCritical)) errors.push('expectedBehavior.isSafetyCritical must be a boolean');
  }

  return errors.length ? fail(errors) : ok();
}

export function validateMultimodalFixtureManifest(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['MultimodalFixtureManifest must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.manifestVersion) || !data.manifestVersion.trim()) {
    errors.push('manifestVersion must be a non-empty string');
  }
  if (!isString(data.description)) errors.push('description must be a string');
  if (!isString(data.generatedAt) || !data.generatedAt.trim()) {
    errors.push('generatedAt must be a non-empty string');
  }

  if (!Array.isArray(data.fixtures)) {
    errors.push('fixtures must be an array');
  } else {
    data.fixtures.forEach((f, idx) => {
      const v = validateMultimodalFixtureEntry(f);
      if (!v.valid) {
        errors.push(...v.errors.map((e) => `fixtures[${idx}]: ${e}`));
      }
    });
  }

  return errors.length ? fail(errors) : ok();
}

export function validateBenchmarkIterationRecord(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['BenchmarkIterationRecord must be an object']);

  if (!isNumber(data.runIndex) || data.runIndex < 1) errors.push('runIndex must be a positive integer');
  if (!isString(data.timestamp)) errors.push('timestamp must be a string');
  if (!isNumber(data.coldStartMs)) errors.push('coldStartMs must be a number');
  if (!isNumber(data.inferenceLatencyMs)) errors.push('inferenceLatencyMs must be a number');
  if (!isNumber(data.pipelineLatencyMs)) errors.push('pipelineLatencyMs must be a number');
  if (!isNumber(data.vramPeakMb)) errors.push('vramPeakMb must be a number');
  if (!isNumber(data.hostMemoryMb)) errors.push('hostMemoryMb must be a number');
  if (!isString(data.inputSha256)) errors.push('inputSha256 must be a string');
  if (data.status !== 'pass' && data.status !== 'fail') errors.push('status must be "pass" or "fail"');

  return errors.length ? fail(errors) : ok();
}

export function validateBenchmarkFixtureResult(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['BenchmarkFixtureResult must be an object']);

  if (!isString(data.fixtureId)) errors.push('fixtureId must be a string');
  if (!ALL_FIXTURE_CLASSES.includes(data.fixtureClass as MultimodalFixtureClass)) {
    errors.push(`Invalid fixtureClass: ${data.fixtureClass}`);
  }
  if (!Array.isArray(data.iterations)) errors.push('iterations must be an array');
  if (!isBoolean(data.deterministic)) errors.push('deterministic must be a boolean');
  if (!Array.isArray(data.determinismErrors)) errors.push('determinismErrors must be an array');
  if (!isNumber(data.avgPipelineLatencyMs)) errors.push('avgPipelineLatencyMs must be a number');
  if (!isNumber(data.maxVramMb)) errors.push('maxVramMb must be a number');
  if (!isBoolean(data.requiresReview)) errors.push('requiresReview must be a boolean');
  if (data.status !== 'pass' && data.status !== 'fail') errors.push('status must be "pass" or "fail"');

  return errors.length ? fail(errors) : ok();
}

export function validateMultimodalBenchmarkReport(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['MultimodalBenchmarkReport must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.reportId) || !data.reportId.trim()) errors.push('reportId must be a non-empty string');
  if (!isString(data.projectId) || !data.projectId.trim()) errors.push('projectId must be a non-empty string');
  if (!isString(data.timestamp) || !data.timestamp.trim()) errors.push('timestamp must be a non-empty string');
  if (!isString(data.manifestVersion)) errors.push('manifestVersion must be a string');
  if (!isString(data.vlmModelId)) errors.push('vlmModelId must be a string');
  if (!isString(data.vlmRevision)) errors.push('vlmRevision must be a string');
  if (data.executionMode !== undefined && data.executionMode !== 'measured' && data.executionMode !== 'simulation') {
    errors.push('executionMode must be measured or simulation');
  }
  if (!isString(data.ocrEngine)) errors.push('ocrEngine must be a string');
  if (!isString(data.ocrEngineVersion)) errors.push('ocrEngineVersion must be a string');

  if (!Array.isArray(data.fixtureResults)) {
    errors.push('fixtureResults must be an array');
  } else {
    data.fixtureResults.forEach((r, idx) => {
      const v = validateBenchmarkFixtureResult(r);
      if (!v.valid) {
        errors.push(...v.errors.map((e) => `fixtureResults[${idx}]: ${e}`));
      }
    });
  }

  if (!isObject(data.summary)) {
    errors.push('summary must be an object');
  } else {
    const s = data.summary as Record<string, unknown>;
    if (!isNumber(s.totalFixtures)) errors.push('summary.totalFixtures must be a number');
    if (!isNumber(s.passedFixtures)) errors.push('summary.passedFixtures must be a number');
    if (!isNumber(s.failedFixtures)) errors.push('summary.failedFixtures must be a number');
    if (!isNumber(s.totalIterations)) errors.push('summary.totalIterations must be a number');
    if (!isNumber(s.deterministicFixtureCount)) errors.push('summary.deterministicFixtureCount must be a number');
    if (!isNumber(s.maxVramPeakMb)) errors.push('summary.maxVramPeakMb must be a number');
    if (!isNumber(s.avgPipelineLatencyMs)) errors.push('summary.avgPipelineLatencyMs must be a number');
    if (!isBoolean(s.allBudgetsPassed)) errors.push('summary.allBudgetsPassed must be a boolean');
    if (!isBoolean(s.auditChainVerified)) errors.push('summary.auditChainVerified must be a boolean');
    if (!isBoolean(s.offlineEnforced)) errors.push('summary.offlineEnforced must be a boolean');
  }

  return errors.length ? fail(errors) : ok();
}
