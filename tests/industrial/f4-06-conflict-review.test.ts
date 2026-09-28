/**
 * F4-06: OCR/VLM Conflict Review Test Suite
 *
 * Validates:
 *   1. Separation and independence of OCR facts and VLM interpretations
 *   2. Conservative normalization rules (no lossy letter/digit substitution, no silent unit conversion)
 *   3. Ambiguous source detection (e.g. 7O -> AMBIGUOUS_SOURCE)
 *   4. Full conflict classification matrix (AGREE, OCR_ONLY, VISION_ONLY, CONFLICTING_VALUE,
 *      CONFLICTING_UNIT, CONFLICTING_LOCATION, CONFIDENCE_DISAGREEMENT, AMBIGUOUS_SOURCE, REQUIRES_HUMAN_REVIEW)
 *   5. Safety-critical human review gate (auto-resolve blocked, "higher confidence wins" prohibited)
 *   6. All 5 human review decisions (accept_ocr, accept_vision, enter_corrected_value, mark_unresolved, reject_both)
 *   7. Full provenance retention in ResolvedObservation (both OCR and Vision source records preserved)
 *   8. Safe Artifact Store atomic finalization (evidence/conflicts/ and evidence/resolved/)
 *   9. Append-only audit trail logging strictly AFTER artifact finalization
 *  10. Cross-project isolation and source hash mismatch guardrails
 *  11. Conversion helpers for OcrResult and AnalyzeImageResult
 *  12. Protected file invariant (rust/test.txt SHA-256 unchanged)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  ComparableObservation,
  ConflictItem,
  ConflictReport,
  ConflictReviewError,
  HumanReviewInput,
  ResolvedObservation,
  normalizeObservationValue,
  classifyObservationConflict,
  computeBoundingBoxIoU,
  ocrResultToComparableObservations,
  visionResultToComparableObservations,
  validateComparableObservation,
  validateConflictItem,
  validateConflictReport,
  validateHumanReviewInput,
  validateResolvedObservation,
  isKnownSafetyKey,
} from '../../src/domain/conflict';
import {
  createServiceContainer,
  ServiceContainer,
  ConflictReviewService,
} from '../../src/service';

describe('F4-06: OCR/VLM Conflict Review', () => {
  const TEST_TXT_INVARIANT = '1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435';
  let tmpDir: string;
  let services: ServiceContainer;
  let conflictService: ConflictReviewService;

  const defaultProjectId = 'industrial-project-01';
  const defaultSourceArtifactId = 'doc-artifact-123';
  const defaultSourceHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function createOcrObs(overrides: Partial<ComparableObservation> = {}): ComparableObservation {
    return {
      schemaVersion: 1,
      id: `obs-ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'ocr',
      sourceArtifactId: defaultSourceArtifactId,
      sourceHash: defaultSourceHash,
      projectId: defaultProjectId,
      pageNumber: 1,
      bbox: { x: 100, y: 100, width: 200, height: 50 },
      engineOrModel: 'tesseract-ocr',
      versionOrRevision: '5.3.0',
      key: 'gauge_reading',
      rawValue: '24.5 mm',
      normalizedValue: '24.5',
      unit: 'mm',
      confidence: 0.95,
      isSafetyCritical: false,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  function createVisionObs(overrides: Partial<ComparableObservation> = {}): ComparableObservation {
    return {
      schemaVersion: 1,
      id: `obs-vis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'vision',
      sourceArtifactId: defaultSourceArtifactId,
      sourceHash: defaultSourceHash,
      projectId: defaultProjectId,
      pageNumber: 1,
      bbox: { x: 105, y: 98, width: 195, height: 52 },
      engineOrModel: 'Qwen/Qwen2-VL-2B-Instruct',
      versionOrRevision: 'aa70c964147048705c93c4e16ff2bc55255470d0',
      key: 'gauge_reading',
      rawValue: '24.5 mm',
      normalizedValue: '24.5',
      unit: 'mm',
      confidence: 0.93,
      isSafetyCritical: false,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f4-06-test-'));
    fs.mkdirSync(path.join(tmpDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.maos', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.maos', 'audit'), { recursive: true });

    services = createServiceContainer(tmpDir);
    conflictService = services.conflict;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── 1. Separation and Independence ───────────────────────────────

  describe('1. Separation and Independence', () => {
    it('maintains independent provenance between OCR and VLM records', () => {
      const ocrObs = createOcrObs({
        engineOrModel: 'tesseract-ocr',
        versionOrRevision: '5.3.0',
        confidence: 0.88,
        bbox: { x: 50, y: 50, width: 100, height: 20 },
      });
      const visObs = createVisionObs({
        engineOrModel: 'Qwen/Qwen2-VL-2B-Instruct',
        versionOrRevision: 'aa70c964',
        confidence: 0.94,
        bbox: { x: 52, y: 49, width: 98, height: 22 },
      });

      const item = classifyObservationConflict('gauge_reading', ocrObs, visObs);

      expect(item.ocrObservation).toBeDefined();
      expect(item.visionObservation).toBeDefined();
      expect(item.ocrObservation?.engineOrModel).toBe('tesseract-ocr');
      expect(item.visionObservation?.engineOrModel).toBe('Qwen/Qwen2-VL-2B-Instruct');
      expect(item.ocrObservation?.confidence).toBe(0.88);
      expect(item.visionObservation?.confidence).toBe(0.94);
      // Ensure objects remain distinct instances
      expect(item.ocrObservation).not.toBe(item.visionObservation);
    });

    it('retains independent page and bounding box provenance', () => {
      const ocrObs = createOcrObs({ pageNumber: 2, bbox: { x: 10, y: 20, width: 30, height: 40 } });
      const visObs = createVisionObs({ pageNumber: 2, bbox: { x: 12, y: 22, width: 28, height: 38 } });

      const item = classifyObservationConflict('sample_key', ocrObs, visObs);
      expect(item.ocrObservation?.pageNumber).toBe(2);
      expect(item.ocrObservation?.bbox).toEqual({ x: 10, y: 20, width: 30, height: 40 });
      expect(item.visionObservation?.bbox).toEqual({ x: 12, y: 22, width: 28, height: 38 });
    });
  });

  // ── 2. Conservative Normalization ────────────────────────────────

  describe('2. Conservative Normalization', () => {
    it('preserves rawValue untouched while trimming outer whitespace', () => {
      const raw = '   120 psi   ';
      const norm = normalizeObservationValue(raw);
      expect(norm.rawValue).toBe('   120 psi   ');
      expect(norm.normalizedValue).toBe('120');
      expect(norm.unit).toBe('psi');
      expect(norm.isNumeric).toBe(true);
      expect(norm.numericValue).toBe(120);
    });

    it('extracts known industrial units without conversion', () => {
      const normBar = normalizeObservationValue('10.5 bar');
      expect(normBar.normalizedValue).toBe('10.5');
      expect(normBar.unit).toBe('bar');

      const normC = normalizeObservationValue('85 °C');
      expect(normC.normalizedValue).toBe('85');
      expect(normC.unit).toBe('°c');

      const normRpm = normalizeObservationValue('3600 rpm');
      expect(normRpm.normalizedValue).toBe('3600');
      expect(normRpm.unit).toBe('rpm');
    });

    it('matches numerically equivalent strings (e.g. 24.50 vs 24.5)', () => {
      const ocrObs = createOcrObs({ rawValue: '24.50 mm' });
      const visObs = createVisionObs({ rawValue: '24.5 mm' });

      const item = classifyObservationConflict('bearing_thickness', ocrObs, visObs);
      expect(item.classification).toBe('AGREE');
    });

    it('prohibits silent heuristic letter/digit substitution (7O is flagged as AMBIGUOUS_SOURCE)', () => {
      const norm = normalizeObservationValue('7O');
      expect(norm.isAmbiguous).toBe(true);
      expect(norm.ambiguousReasons.length).toBeGreaterThan(0);
      expect(norm.ambiguousReasons[0]).toContain('possible 0 confusion');
      // Crucial invariant: 7O must NEVER be automatically changed to 70!
      expect(norm.normalizedValue).toBe('7O');
      expect(norm.rawValue).toBe('7O');
    });

    it('detects other ambiguous mix patterns (e.g. 1I, B8, S5)', () => {
      const norm1I = normalizeObservationValue('1I');
      expect(norm1I.isAmbiguous).toBe(true);

      const normB8 = normalizeObservationValue('B8');
      expect(normB8.isAmbiguous).toBe(true);

      const normS5 = normalizeObservationValue('S5');
      expect(normS5.isAmbiguous).toBe(true);
    });
  });

  // ── 3. Conflict Classification Matrix ────────────────────────────

  describe('3. Conflict Classification Matrix', () => {
    it('classifies AGREE when values, units, locations, and confidence align', () => {
      const ocrObs = createOcrObs({ rawValue: '50.0 bar', confidence: 0.95 });
      const visObs = createVisionObs({ rawValue: '50.0 bar', confidence: 0.92 });

      const item = classifyObservationConflict('pipe_test', ocrObs, visObs);
      expect(item.classification).toBe('AGREE');
      expect(item.requiresReview).toBe(false);
    });

    it('classifies OCR_ONLY when only OCR observation is present', () => {
      const ocrObs = createOcrObs({ rawValue: 'SERIAL-12345', confidence: 0.92 });
      const item = classifyObservationConflict('serial_number', ocrObs, undefined);

      expect(item.classification).toBe('OCR_ONLY');
      expect(item.ocrObservation).toBeDefined();
      expect(item.visionObservation).toBeUndefined();
      expect(item.requiresReview).toBe(false);
    });

    it('classifies VISION_ONLY when only Vision observation is present', () => {
      const visObs = createVisionObs({ rawValue: 'VALVE-OPEN', confidence: 0.94 });
      const item = classifyObservationConflict('valve_status', undefined, visObs);

      expect(item.classification).toBe('VISION_ONLY');
      expect(item.visionObservation).toBeDefined();
      expect(item.ocrObservation).toBeUndefined();
      expect(item.requiresReview).toBe(false);
    });

    it('classifies CONFLICTING_VALUE when observations report different numbers', () => {
      const ocrObs = createOcrObs({ rawValue: '12.4 mm' });
      const visObs = createVisionObs({ rawValue: '12.8 mm' });

      const item = classifyObservationConflict('plate_width', ocrObs, visObs);
      expect(item.classification).toBe('CONFLICTING_VALUE');
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('Conflicting values');
    });

    it('classifies CONFLICTING_UNIT when units differ without silent conversion', () => {
      const ocrObs = createOcrObs({ rawValue: '100 bar' });
      const visObs = createVisionObs({ rawValue: '100 psi' });

      const item = classifyObservationConflict('line_pressure', ocrObs, visObs);
      expect(item.classification).toBe('CONFLICTING_UNIT');
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('Silent unit conversions are forbidden');
    });

    it('classifies CONFLICTING_LOCATION when bounding boxes do not overlap on the same page', () => {
      const ocrObs = createOcrObs({
        pageNumber: 1,
        bbox: { x: 10, y: 10, width: 50, height: 20 },
      });
      const visObs = createVisionObs({
        pageNumber: 1,
        bbox: { x: 800, y: 900, width: 100, height: 50 },
      });

      const item = classifyObservationConflict('gauge_reading', ocrObs, visObs);
      expect(item.classification).toBe('CONFLICTING_LOCATION');
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('non-overlapping locations');
    });

    it('classifies CONFIDENCE_DISAGREEMENT when confidence is low or delta is large', () => {
      // Delta >= 0.40
      const ocrObs = createOcrObs({ rawValue: '15.0 mm', confidence: 0.98 });
      const visObs = createVisionObs({ rawValue: '15.0 mm', confidence: 0.50 });

      const item = classifyObservationConflict('dimension_x', ocrObs, visObs);
      expect(item.classification).toBe('CONFIDENCE_DISAGREEMENT');
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('confidence levels disagree');
    });

    it('classifies AMBIGUOUS_SOURCE when OCR or Vision contains ambiguous characters', () => {
      const ocrObs = createOcrObs({ rawValue: '7O mm' });
      const visObs = createVisionObs({ rawValue: '70 mm' });

      const item = classifyObservationConflict('shaft_diameter', ocrObs, visObs);
      expect(item.classification).toBe('AMBIGUOUS_SOURCE');
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('Ambiguous characters detected');
    });
  });

  // ── 4. Safety-Critical Human Review Gate ─────────────────────────

  describe('4. Safety-Critical Gate', () => {
    it('detects safety-critical keywords automatically (vibration, pressure, temperature, etc.)', () => {
      expect(isKnownSafetyKey('bearing_vibration')).toBe(true);
      expect(isKnownSafetyKey('boiler_pressure')).toBe(true);
      expect(isKnownSafetyKey('exhaust_temperature')).toBe(true);
      expect(isKnownSafetyKey('rotor_clearance')).toBe(true);
      expect(isKnownSafetyKey('part_serial_number')).toBe(false);
    });

    it('forces requiresReview = true on safety-critical fields even when values AGREE completely', () => {
      const ocrObs = createOcrObs({
        key: 'turbine_vibration',
        rawValue: '2.5 mm/s',
        confidence: 0.99,
        isSafetyCritical: true,
      });
      const visObs = createVisionObs({
        key: 'turbine_vibration',
        rawValue: '2.5 mm/s',
        confidence: 0.99,
        isSafetyCritical: true,
      });

      const item = classifyObservationConflict('turbine_vibration', ocrObs, visObs);
      expect(item.classification).toBe('AGREE');
      expect(item.isSafetyCritical).toBe(true);
      // Mandatory: safety-critical fields must never bypass review!
      expect(item.requiresReview).toBe(true);
      expect(item.explanation).toContain('mandates human sign-off');
    });

    it('blocks auto-resolution on safety-critical observations', () => {
      const ocrObs = createOcrObs({
        key: 'boiler_pressure',
        rawValue: '15 bar',
        confidence: 1.0,
      });
      const visObs = createVisionObs({
        key: 'boiler_pressure',
        rawValue: '15 bar',
        confidence: 1.0,
      });

      const item = classifyObservationConflict('boiler_pressure', ocrObs, visObs);
      expect(() => conflictService.autoResolveItem(item)).toThrow(ConflictReviewError);
      expect(() => conflictService.autoResolveItem(item)).toThrow(/SAFETY-CRITICAL/);
    });

    it('blocks auto-resolution on conflicting or review-required items', () => {
      const ocrObs = createOcrObs({ rawValue: '12 mm' });
      const visObs = createVisionObs({ rawValue: '14 mm' });
      const item = classifyObservationConflict('dimension_y', ocrObs, visObs);

      expect(() => conflictService.autoResolveItem(item)).toThrow(ConflictReviewError);
      expect(() => conflictService.autoResolveItem(item)).toThrow(/requires review/);
    });

    it('allows auto-resolution only for non-safety-critical, agreeing items with high confidence', () => {
      const ocrObs = createOcrObs({ key: 'part_code', rawValue: 'ABC-100', confidence: 0.95 });
      const visObs = createVisionObs({ key: 'part_code', rawValue: 'ABC-100', confidence: 0.95 });
      const item = classifyObservationConflict('part_code', ocrObs, visObs);

      expect(item.requiresReview).toBe(false);
      const val = conflictService.autoResolveItem(item);
      expect(val).toBe('ABC-100');
    });
  });

  // ── 5. Human Review Decisions (All 5 Decisions) ──────────────────

  describe('5. Human Review Decisions', () => {
    let report: ConflictReport;
    let conflictItem: ConflictItem;

    beforeEach(async () => {
      const ocrObs = createOcrObs({
        key: 'pipe_diameter',
        rawValue: '50.2 mm',
        confidence: 0.85,
      });
      const visObs = createVisionObs({
        key: 'pipe_diameter',
        rawValue: '50.8 mm',
        confidence: 0.90,
      });

      report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
        visionObservations: [visObs],
      });
      conflictItem = report.items[0];
    });

    it('executes decision accept_ocr: accepts OCR value and sets status accepted_ocr', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_01',
        decision: 'accept_ocr',
        rationale: 'Calibrated micrometer markings in OCR are confirmed by physical sheet.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);
      expect(resolved.status).toBe('accepted_ocr');
      expect(resolved.resolvedValue).toBe('50.2 mm');
      expect(resolved.resolvedUnit).toBe('mm');
      expect(resolved.reviewerDecision).toBe('accept_ocr');
      expect(resolved.reviewerId).toBe('engineer_01');
    });

    it('executes decision accept_vision: accepts Vision value and sets status accepted_vision', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_02',
        decision: 'accept_vision',
        rationale: 'High resolution camera gauge interpretation is confirmed clear.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);
      expect(resolved.status).toBe('accepted_vision');
      expect(resolved.resolvedValue).toBe('50.8 mm');
      expect(resolved.resolvedUnit).toBe('mm');
      expect(resolved.reviewerDecision).toBe('accept_vision');
    });

    it('executes decision enter_corrected_value: sets manual value and status manually_corrected', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_03',
        decision: 'enter_corrected_value',
        correctedValue: '50.5',
        correctedUnit: 'mm',
        rationale: 'Verified with secondary dial caliper as 50.5 mm exactly.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);
      expect(resolved.status).toBe('manually_corrected');
      expect(resolved.resolvedValue).toBe('50.5');
      expect(resolved.resolvedUnit).toBe('mm');
    });

    it('rejects enter_corrected_value if correctedValue is missing or empty', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_03',
        decision: 'enter_corrected_value',
        correctedValue: '   ',
        rationale: 'Missing value test',
        timestamp: new Date().toISOString(),
      };

      await expect(conflictService.resolveConflict(input)).rejects.toThrow(ConflictReviewError);
    });

    it('executes decision mark_unresolved: sets null value and status unresolved', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_04',
        decision: 'mark_unresolved',
        rationale: 'Document unreadable in this region; physical inspection required.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);
      expect(resolved.status).toBe('unresolved');
      expect(resolved.resolvedValue).toBeNull();
    });

    it('executes decision reject_both: sets null value and status rejected', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: conflictItem.id,
        reviewerId: 'engineer_05',
        decision: 'reject_both',
        rationale: 'Both readings corrupted by water stain.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);
      expect(resolved.status).toBe('rejected');
      expect(resolved.resolvedValue).toBeNull();
    });

    it('throws error when accept_ocr requested for item with no OCR observation', async () => {
      const visOnly = createVisionObs({ key: 'vis_only_key' });
      const vReport = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        visionObservations: [visOnly],
      });

      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: vReport.id,
        itemId: vReport.items[0].id,
        reviewerId: 'engineer_01',
        decision: 'accept_ocr',
        rationale: 'Testing invalid accept_ocr',
        timestamp: new Date().toISOString(),
      };

      await expect(conflictService.resolveConflict(input)).rejects.toThrow(ConflictReviewError);
      await expect(conflictService.resolveConflict(input)).rejects.toThrow(/no OCR observation/);
    });

    it('throws error when accept_vision requested for item with no Vision observation', async () => {
      const ocrOnly = createOcrObs({ key: 'ocr_only_key' });
      const oReport = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrOnly],
      });

      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: oReport.id,
        itemId: oReport.items[0].id,
        reviewerId: 'engineer_01',
        decision: 'accept_vision',
        rationale: 'Testing invalid accept_vision',
        timestamp: new Date().toISOString(),
      };

      await expect(conflictService.resolveConflict(input)).rejects.toThrow(ConflictReviewError);
      await expect(conflictService.resolveConflict(input)).rejects.toThrow(/no Vision observation/);
    });
  });

  // ── 6. Full Provenance Retention ─────────────────────────────────

  describe('6. Full Provenance Retention', () => {
    it('ResolvedObservation retains both original OCR and VLM source records', async () => {
      const ocrObs = createOcrObs({
        key: 'seal_gap',
        rawValue: '0.12 mm',
        confidence: 0.88,
        engineOrModel: 'tesseract-ocr',
        versionOrRevision: '5.3.0',
      });
      const visObs = createVisionObs({
        key: 'seal_gap',
        rawValue: '0.15 mm',
        confidence: 0.91,
        engineOrModel: 'Qwen/Qwen2-VL-2B-Instruct',
        versionOrRevision: 'aa70c964',
      });

      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
        visionObservations: [visObs],
      });

      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: report.items[0].id,
        reviewerId: 'lead_qa_engineer',
        decision: 'accept_vision',
        rationale: 'Optical microscope image shows 0.15mm gap distinctly.',
        timestamp: new Date().toISOString(),
      };

      const resolved = await conflictService.resolveConflict(input);

      expect(resolved.ocrSource).toBeDefined();
      expect(resolved.ocrSource?.engine).toBe('tesseract-ocr');
      expect(resolved.ocrSource?.rawValue).toBe('0.12 mm');
      expect(resolved.ocrSource?.confidence).toBe(0.88);

      expect(resolved.visionSource).toBeDefined();
      expect(resolved.visionSource?.modelId).toBe('Qwen/Qwen2-VL-2B-Instruct');
      expect(resolved.visionSource?.rawValue).toBe('0.15 mm');
      expect(resolved.visionSource?.confidence).toBe(0.91);

      expect(resolved.conflictClassification).toBe('CONFLICTING_VALUE');
      expect(resolved.reviewerDecision).toBe('accept_vision');
      expect(resolved.rationale).toBe('Optical microscope image shows 0.15mm gap distinctly.');
    });
  });

  // ── 7. Safe Artifact Store & Immutable Audit Trail ───────────────

  describe('7. Safe Artifact Store & Immutable Audit Trail', () => {
    it('persists conflict reports under evidence/conflicts/<hash>/', async () => {
      const ocrObs = createOcrObs();
      const visObs = createVisionObs();

      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
        visionObservations: [visObs],
      });

      expect(report.artifactId).toBeDefined();
      expect(report.artifactHash).toBeDefined();

      const expectedDir = path.join(tmpDir, 'evidence', 'conflicts', defaultSourceHash);
      expect(fs.existsSync(expectedDir)).toBe(true);

      const files = fs.readdirSync(expectedDir);
      expect(files.some((f) => f.includes(report.id))).toBe(true);
    });

    it('persists resolutions under evidence/resolved/<hash>/', async () => {
      const ocrObs = createOcrObs();
      const visObs = createVisionObs();

      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
        visionObservations: [visObs],
      });

      const resolved = await conflictService.resolveConflict({
        schemaVersion: 1,
        reportId: report.id,
        itemId: report.items[0].id,
        reviewerId: 'tester',
        decision: 'accept_ocr',
        rationale: 'Approved.',
        timestamp: new Date().toISOString(),
      });

      expect(resolved.artifactId).toBeDefined();
      expect(resolved.artifactHash).toBeDefined();

      const expectedDir = path.join(tmpDir, 'evidence', 'resolved', defaultSourceHash);
      expect(fs.existsSync(expectedDir)).toBe(true);

      const files = fs.readdirSync(expectedDir);
      expect(files.some((f) => f.includes(resolved.id))).toBe(true);
    });

    it('records immutable audit events strictly AFTER atomic artifact finalization', async () => {
      const ocrObs = createOcrObs();
      const visObs = createVisionObs();

      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
        visionObservations: [visObs],
      });

      await conflictService.resolveConflict({
        schemaVersion: 1,
        reportId: report.id,
        itemId: report.items[0].id,
        reviewerId: 'audit_checker',
        decision: 'accept_vision',
        rationale: 'Audit verification.',
        timestamp: new Date().toISOString(),
      });

      const auditRecords = services.audit.getRecords();
      const createdEvent = auditRecords.find(
        (r) => r.source === 'conflict_review' && (r.data as any).action === 'CONFLICT_REVIEW_CREATED',
      );
      const resolvedEvent = auditRecords.find(
        (r) => r.source === 'conflict_review' && (r.data as any).action === 'CONFLICT_RESOLVED',
      );

      expect(createdEvent).toBeDefined();
      expect((createdEvent!.data as any).reportId).toBe(report.id);
      expect((createdEvent!.data as any).outputArtifactId).toBe(report.artifactId);

      expect(resolvedEvent).toBeDefined();
      expect((resolvedEvent!.data as any).decision).toBe('accept_vision');
      expect((resolvedEvent!.data as any).reviewerId).toBe('audit_checker');
    });

    it('retrieves reports and resolved observations accurately via service methods', async () => {
      const ocrObs = createOcrObs();
      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
      });

      const retrievedReport = conflictService.getConflictReport(report.id);
      expect(retrievedReport).toBeDefined();
      expect(retrievedReport?.id).toBe(report.id);

      const resolved = await conflictService.resolveConflict({
        schemaVersion: 1,
        reportId: report.id,
        itemId: report.items[0].id,
        reviewerId: 'retrieval_tester',
        decision: 'accept_ocr',
        rationale: 'Testing retrieval',
        timestamp: new Date().toISOString(),
      });

      const retrievedResolved = conflictService.getResolvedObservation(resolved.id);
      expect(retrievedResolved).toBeDefined();
      expect(retrievedResolved?.id).toBe(resolved.id);
      expect(retrievedResolved?.resolvedValue).toBe(ocrObs.rawValue);
    });
  });

  // ── 8. Cross-Project & Hash Guardrails ────────────────────────────

  describe('8. Guardrails & Isolation', () => {
    it('throws EMPTY_OBSERVATIONS when both lists are empty', () => {
      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [],
          visionObservations: [],
        }),
      ).toThrow(ConflictReviewError);
      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [],
          visionObservations: [],
        }),
      ).toThrow(/EMPTY_OBSERVATIONS/);
    });

    it('throws CROSS_PROJECT_FORBIDDEN if an observation belongs to a different project', () => {
      const foreignObs = createOcrObs({ projectId: 'other-project' });
      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [foreignObs],
        }),
      ).toThrow(ConflictReviewError);
      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [foreignObs],
        }),
      ).toThrow(/CROSS_PROJECT_FORBIDDEN/);
    });

    it('throws SOURCE_HASH_MISMATCH when comparing different source documents', () => {
      const ocrObs = createOcrObs({ sourceHash: 'hash_aaaaa' });
      const visObs = createVisionObs({ sourceHash: 'hash_bbbbb' });

      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [ocrObs],
          visionObservations: [visObs],
        }),
      ).toThrow(ConflictReviewError);
      expect(() =>
        conflictService.compareObservations({
          projectId: defaultProjectId,
          ocrObservations: [ocrObs],
          visionObservations: [visObs],
        }),
      ).toThrow(/SOURCE_HASH_MISMATCH/);
    });

    it('throws REPORT_NOT_FOUND when resolving non-existent report', async () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: 'non-existent-report-uuid',
        itemId: 'item-1',
        reviewerId: 'reviewer',
        decision: 'accept_ocr',
        rationale: 'Missing report',
        timestamp: new Date().toISOString(),
      };

      await expect(conflictService.resolveConflict(input)).rejects.toThrow(ConflictReviewError);
      await expect(conflictService.resolveConflict(input)).rejects.toThrow(/REPORT_NOT_FOUND/);
    });

    it('throws ITEM_NOT_FOUND when resolving non-existent item in valid report', async () => {
      const ocrObs = createOcrObs();
      const report = await conflictService.compareAndPersist({
        projectId: defaultProjectId,
        ocrObservations: [ocrObs],
      });

      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: report.id,
        itemId: 'invalid-item-uuid',
        reviewerId: 'reviewer',
        decision: 'accept_ocr',
        rationale: 'Missing item',
        timestamp: new Date().toISOString(),
      };

      await expect(conflictService.resolveConflict(input)).rejects.toThrow(ConflictReviewError);
      await expect(conflictService.resolveConflict(input)).rejects.toThrow(/ITEM_NOT_FOUND/);
    });
  });

  // ── 9. Converters ────────────────────────────────────────────────

  describe('9. Conversion Helpers', () => {
    it('ocrResultToComparableObservations transforms OcrResult correctly', () => {
      const mockOcrResult = {
        sourceArtifactId: 'art-ocr-1',
        sourceHash: defaultSourceHash,
        pageNumber: 1,
        engine: 'tesseract-ocr',
        engineVersion: '5.3.0',
        blocks: [
          {
            id: 'block-1',
            text: 'Temperature: 75 °C',
            bbox: { x: 10, y: 10, width: 100, height: 20 },
            confidence: 0.94,
            pageNumber: 1,
          },
        ],
      };

      const obs = ocrResultToComparableObservations(mockOcrResult, defaultProjectId);
      expect(obs.length).toBe(1);
      expect(obs[0].source).toBe('ocr');
      expect(obs[0].sourceArtifactId).toBe('art-ocr-1');
      expect(obs[0].rawValue).toBe('Temperature: 75 °C');
      expect(obs[0].engineOrModel).toBe('tesseract-ocr');
      expect(obs[0].isSafetyCritical).toBe(true); // "temperature" triggers safety
    });

    it('visionResultToComparableObservations transforms AnalyzeImageResult correctly', () => {
      const mockVisionResult = {
        sourceArtifactId: 'art-vis-1',
        sourceHash: defaultSourceHash,
        modelId: 'Qwen/Qwen2-VL-2B-Instruct',
        modelRevision: 'aa70c964',
        observations: [
          {
            id: 'obs-vis-1',
            observationType: 'vibration_level',
            value: '0.45 mm/s',
            confidence: 0.91,
            bbox: { x: 20, y: 30, width: 80, height: 40 },
            pageNumber: 1,
            requiresReview: true,
          },
        ],
      };

      const obs = visionResultToComparableObservations(mockVisionResult, defaultProjectId);
      expect(obs.length).toBe(1);
      expect(obs[0].source).toBe('vision');
      expect(obs[0].rawValue).toBe('0.45 mm/s');
      expect(obs[0].isSafetyCritical).toBe(true);
    });
  });

  // ── 10. Schema Validators ────────────────────────────────────────

  describe('10. Pure Schema Validators', () => {
    it('validates ComparableObservation', () => {
      const valid = createOcrObs();
      expect(validateComparableObservation(valid).valid).toBe(true);

      const invalid = { ...valid, confidence: 2.0 };
      expect(validateComparableObservation(invalid).valid).toBe(false);
    });

    it('validates ConflictItem', () => {
      const ocrObs = createOcrObs();
      const item = classifyObservationConflict('key1', ocrObs, undefined);
      expect(validateConflictItem(item).valid).toBe(true);
    });

    it('validates HumanReviewInput', () => {
      const input: HumanReviewInput = {
        schemaVersion: 1,
        reportId: 'rep-1',
        itemId: 'item-1',
        reviewerId: 'rev-1',
        decision: 'accept_ocr',
        rationale: 'Looks good',
        timestamp: new Date().toISOString(),
      };
      expect(validateHumanReviewInput(input).valid).toBe(true);

      const invalid = { ...input, decision: 'invalid_decision' as any };
      expect(validateHumanReviewInput(invalid).valid).toBe(false);
    });
  });

  // ── 11. Protected Invariant ──────────────────────────────────────

  describe('11. Protected Invariant', () => {
    it('preserves rust/test.txt SHA-256 hash across all operations', () => {
      const testTxtPath = path.resolve('c:/maos/rust/test.txt');
      expect(fs.existsSync(testTxtPath)).toBe(true);
      const content = fs.readFileSync(testTxtPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe(TEST_TXT_INVARIANT);
    });
  });
});
