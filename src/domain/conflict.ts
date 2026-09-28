/**
 * F4-06: Domain Schemas, Normalization, and Conflict Review
 *
 * Implements safety-critical OCR fact and VLM interpretation comparison,
 * conservative normalization, multi-source conflict classification,
 * human review gate, and provenance preservation.
 *
 * Invariants:
 * 1. OCR records (extracted text facts) and VLM observations (visual interpretation)
 *    are strictly independent and immutable. Never merge them prior to comparison.
 * 2. Conservative normalization: preserve raw values exactly; no heuristic letter/digit
 *    substitution (e.g., 7O -> 70 is forbidden; flag as AMBIGUOUS_SOURCE); no silent
 *    unit conversions or inferences.
 * 3. Safety-critical fields (vibration, pressure, temperature, clearance, etc.)
 *    MUST ALWAYS require human review. "Higher confidence wins" auto-resolution is
 *    strictly prohibited.
 * 4. Provenance preservation: resolved records retain authoritative references to both
 *    original OCR and VLM sources, conflict classification, and reviewer decision.
 */

import { ValidationResult } from './validators';
import { OcrBoundingBox } from './ocr';
import { ImageObservationBBox } from './vision';

// ── Error Definitions ───────────────────────────────────────────────

export type ConflictReviewErrorCode =
  | 'SOURCE_HASH_MISMATCH'
  | 'CROSS_PROJECT_FORBIDDEN'
  | 'SAFETY_CRITICAL_AUTO_RESOLVE_BLOCKED'
  | 'INVALID_REVIEW_DECISION'
  | 'MISSING_CORRECTION_VALUE'
  | 'AMBIGUOUS_SOURCE'
  | 'REPORT_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'EMPTY_OBSERVATIONS';

export class ConflictReviewError extends Error {
  constructor(
    public readonly code: ConflictReviewErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ConflictReviewError';
    Object.setPrototypeOf(this, ConflictReviewError.prototype);
  }
}

// ── Enums and Classifications ───────────────────────────────────────

export type ConflictClassification =
  | 'AGREE'
  | 'OCR_ONLY'
  | 'VISION_ONLY'
  | 'CONFLICTING_VALUE'
  | 'CONFLICTING_UNIT'
  | 'CONFLICTING_LOCATION'
  | 'CONFIDENCE_DISAGREEMENT'
  | 'AMBIGUOUS_SOURCE'
  | 'REQUIRES_HUMAN_REVIEW';

export type ConflictResolutionDecision =
  | 'accept_ocr'
  | 'accept_vision'
  | 'enter_corrected_value'
  | 'mark_unresolved'
  | 'reject_both';

export type ResolutionStatus =
  | 'accepted_ocr'
  | 'accepted_vision'
  | 'manually_corrected'
  | 'unresolved'
  | 'rejected';

// ── Safety Critical Keywords ────────────────────────────────────────

export const SAFETY_CRITICAL_KEYWORDS: readonly string[] = [
  'vibration',
  'temperature',
  'pressure',
  'clearance',
  'voltage',
  'current',
  'speed',
  'rpm',
  'torque',
  'flow',
  'flow_rate',
  'stress',
  'strain',
  'safety',
  'limit',
  'critical',
  'shutdown',
  'threshold',
  'tolerance',
  'overpressure',
  'emergency',
  'bearing',
  'hydraulic',
] as const;

export function isKnownSafetyKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SAFETY_CRITICAL_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Bounding Box Interface & IoU ────────────────────────────────────

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function computeBoundingBoxIoU(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const intersectionArea = w * h;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const unionArea = areaA + areaB - intersectionArea;

  if (unionArea <= 0) return 0;
  return intersectionArea / unionArea;
}

// ── Normalization Types & Rules ─────────────────────────────────────

export interface NormalizationRecord {
  readonly rawValue: string;
  readonly normalizedValue: string;
  readonly unit?: string;
  readonly isNumeric: boolean;
  readonly numericValue?: number;
  readonly isAmbiguous: boolean;
  readonly ambiguousReasons: readonly string[];
}

export const COMMON_INDUSTRIAL_UNITS: readonly string[] = [
  'mm/s', 'in/s', 'm/s', 'mm', 'cm', 'm', 'in', 'inch', 'inches', 'ft',
  'psi', 'bar', 'kpa', 'mpa', 'pa',
  '°c', '°f', 'deg c', 'deg f', 'k', 'c', 'f',
  'rpm', 'hz', 'khz', 'mhz',
  'v', 'mv', 'kv',
  'a', 'ma',
  'w', 'kw', 'mw',
  'kg', 'g', 'mg', 'lb', 'lbs',
  'nm', 'kn',
  'l/min', 'gpm', 'cfm',
  '%',
] as const;

/**
 * Conservative normalization of an observation value.
 *
 * Rules:
 * 1. Preserves rawValue exactly.
 * 2. Trims outer whitespace and collapses internal multiple spaces.
 * 3. Detects ambiguous alphanumeric mixtures (e.g., 7O, 1O0, B8, S5).
 *    Never heuristically replaces characters (e.g. 7O is NOT converted to 70).
 * 4. Extracts unit without silent conversions (e.g., '12.4 bar' -> value '12.4', unit 'bar').
 * 5. Parses standard numeric floats for comparison if purely numeric.
 */
export function normalizeObservationValue(raw: string, _key?: string): NormalizationRecord {
  const rawValue = raw;
  const trimmed = raw.trim();
  const collapsed = trimmed.replace(/\s+/g, ' ');

  const ambiguousReasons: string[] = [];
  let isAmbiguous = false;

  // Check for ambiguous alphanumeric substitutions:
  // 1. Digits mixed with 'O' or 'o' (e.g., 7O, 1O0, O.5, 2O24)
  if (/\b\d+[oO]\b/.test(collapsed) || /\b[oO]\d+\b/.test(collapsed) || /\b\d+[oO]\d+\b/.test(collapsed)) {
    isAmbiguous = true;
    ambiguousReasons.push(`Suspicious mix of digits and letter 'O'/'o' (possible 0 confusion) in "${collapsed}"`);
  }
  // 2. Digits mixed with 'I' or 'l' (e.g., 1I, l0, 5I)
  if (/\b\d+[I|l]\b/.test(collapsed) || /\b[I|l]\d+\b/.test(collapsed) || /\b\d+[I|l]\d+\b/.test(collapsed)) {
    isAmbiguous = true;
    ambiguousReasons.push(`Suspicious mix of digits and letter 'I'/'l' (possible 1 confusion) in "${collapsed}"`);
  }
  // 3. Digits mixed with 'B' (possible 8 confusion)
  if (/\b[B]\d+\b/.test(collapsed) || /\b\d+[B]\b/.test(collapsed)) {
    isAmbiguous = true;
    ambiguousReasons.push(`Suspicious mix of digit and letter 'B' (possible 8 confusion) in "${collapsed}"`);
  }
  // 4. Digits mixed with 'S' (possible 5 confusion)
  if (/\b[S]\d+\b/.test(collapsed) || /\b\d+[S]\b/.test(collapsed)) {
    isAmbiguous = true;
    ambiguousReasons.push(`Suspicious mix of digit and letter 'S' (possible 5 confusion) in "${collapsed}"`);
  }

  // Unit extraction
  let extractedValue = collapsed;
  let extractedUnit: string | undefined = undefined;

  const escapedUnits = [...COMMON_INDUSTRIAL_UNITS]
    .sort((a, b) => b.length - a.length)
    .map((u) => u.replace(/([.*+?^${}()|[\]/\\])/g, '\\$1'))
    .join('|');

  const unitRegex = new RegExp(`^([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*(${escapedUnits})$`, 'i');
  const unitMatch = collapsed.match(unitRegex);

  if (unitMatch) {
    extractedValue = unitMatch[1];
    extractedUnit = unitMatch[2].toLowerCase();
  }

  const numericVal = parseFloat(extractedValue);
  const isNumeric = !Number.isNaN(numericVal) && /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.test(extractedValue);

  return {
    rawValue,
    normalizedValue: extractedValue,
    unit: extractedUnit,
    isNumeric,
    numericValue: isNumeric ? numericVal : undefined,
    isAmbiguous,
    ambiguousReasons,
  };
}

// ── Domain Schemas ──────────────────────────────────────────────────

export interface ComparableObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: 'ocr' | 'vision';
  readonly sourceArtifactId: string;
  readonly sourceHash: string;
  readonly projectId: string;
  readonly pageNumber?: number;
  readonly bbox?: BoundingBox;
  readonly engineOrModel: string;
  readonly versionOrRevision: string;
  readonly key: string;
  readonly rawValue: string;
  readonly normalizedValue: string;
  readonly unit?: string;
  readonly confidence: number;
  readonly isSafetyCritical?: boolean;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ConflictItem {
  readonly id: string;
  readonly key: string;
  readonly classification: ConflictClassification;
  readonly requiresReview: boolean;
  readonly isSafetyCritical: boolean;
  readonly ocrObservation?: ComparableObservation;
  readonly visionObservation?: ComparableObservation;
  readonly normalizedOcrValue?: string;
  readonly normalizedVisionValue?: string;
  readonly ocrUnit?: string;
  readonly visionUnit?: string;
  readonly locationIoU?: number;
  readonly confidenceDelta?: number;
  readonly explanation: string;
}

export interface ConflictReportSummary {
  readonly totalItems: number;
  readonly agreeCount: number;
  readonly conflictCount: number;
  readonly reviewRequiredCount: number;
  readonly ocrOnlyCount: number;
  readonly visionOnlyCount: number;
  readonly ambiguousCount: number;
  readonly safetyCriticalCount: number;
}

export interface ConflictReport {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly sourceArtifactId: string;
  readonly sourceHash: string;
  readonly generatedAt: string;
  readonly items: readonly ConflictItem[];
  readonly summary: ConflictReportSummary;
  readonly status: 'pending_review' | 'auto_resolved' | 'resolved';
  readonly artifactId?: string;
  readonly artifactHash?: string;
}

export interface HumanReviewInput {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly itemId: string;
  readonly reviewerId: string;
  readonly decision: ConflictResolutionDecision;
  readonly correctedValue?: string;
  readonly correctedUnit?: string;
  readonly rationale: string;
  readonly timestamp: string;
}

export interface ResolvedObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reportId: string;
  readonly itemId: string;
  readonly projectId: string;
  readonly key: string;
  readonly resolvedValue: string | null;
  readonly resolvedUnit?: string;
  readonly status: ResolutionStatus;
  readonly reviewerDecision: ConflictResolutionDecision;
  readonly reviewerId: string;
  readonly rationale: string;
  readonly resolvedAt: string;
  readonly ocrSource?: {
    readonly artifactId: string;
    readonly sourceHash: string;
    readonly engine: string;
    readonly engineVersion: string;
    readonly rawValue: string;
    readonly confidence: number;
    readonly bbox?: OcrBoundingBox;
  };
  readonly visionSource?: {
    readonly artifactId: string;
    readonly sourceHash: string;
    readonly modelId: string;
    readonly modelRevision: string;
    readonly rawValue: string;
    readonly confidence: number;
    readonly bbox?: ImageObservationBBox;
  };
  readonly conflictClassification: ConflictClassification;
  readonly artifactId?: string;
  readonly artifactHash?: string;
}

// ── Conflict Classification Engine ──────────────────────────────────

export interface ClassifyConflictOptions {
  /** Low confidence threshold below which review is required (default: 0.60) */
  minConfidence?: number;
  /** Maximum confidence delta before flagging confidence disagreement (default: 0.40) */
  maxConfidenceDelta?: number;
  /** Minimum IoU threshold to consider locations matching (default: 0.05) */
  minLocationIoU?: number;
}

export function classifyObservationConflict(
  key: string,
  ocrObs?: ComparableObservation,
  visionObs?: ComparableObservation,
  options?: ClassifyConflictOptions,
): ConflictItem {
  const minConfidence = options?.minConfidence ?? 0.60;
  const maxConfidenceDelta = options?.maxConfidenceDelta ?? 0.40;
  const minLocationIoU = options?.minLocationIoU ?? 0.05;

  const id = `conflict-${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const isSafetyCritical =
    Boolean(ocrObs?.isSafetyCritical) ||
    Boolean(visionObs?.isSafetyCritical) ||
    isKnownSafetyKey(key);

  // Case 1: OCR Only
  if (ocrObs && !visionObs) {
    const norm = normalizeObservationValue(ocrObs.rawValue, key);
    const requiresReview = isSafetyCritical || ocrObs.confidence < 0.85 || norm.isAmbiguous;
    const classification: ConflictClassification = norm.isAmbiguous ? 'AMBIGUOUS_SOURCE' : 'OCR_ONLY';
    return {
      id,
      key,
      classification,
      requiresReview,
      isSafetyCritical,
      ocrObservation: ocrObs,
      normalizedOcrValue: norm.normalizedValue,
      ocrUnit: norm.unit,
      explanation: norm.isAmbiguous
        ? `OCR-only observation has ambiguous characters: ${norm.ambiguousReasons.join('; ')}`
        : `Only OCR extracted a value for "${key}" (confidence: ${ocrObs.confidence}).`,
    };
  }

  // Case 2: Vision Only
  if (!ocrObs && visionObs) {
    const norm = normalizeObservationValue(visionObs.rawValue, key);
    const requiresReview = isSafetyCritical || visionObs.confidence < 0.85 || norm.isAmbiguous;
    const classification: ConflictClassification = norm.isAmbiguous ? 'AMBIGUOUS_SOURCE' : 'VISION_ONLY';
    return {
      id,
      key,
      classification,
      requiresReview,
      isSafetyCritical,
      visionObservation: visionObs,
      normalizedVisionValue: norm.normalizedValue,
      visionUnit: norm.unit,
      explanation: norm.isAmbiguous
        ? `Vision-only observation has ambiguous characters: ${norm.ambiguousReasons.join('; ')}`
        : `Only Vision model extracted an observation for "${key}" (confidence: ${visionObs.confidence}).`,
    };
  }

  // Case 3: Neither present (defensive)
  if (!ocrObs && !visionObs) {
    return {
      id,
      key,
      classification: 'REQUIRES_HUMAN_REVIEW',
      requiresReview: true,
      isSafetyCritical,
      explanation: `No observations provided for key "${key}".`,
    };
  }

  // Case 4: Both present -> Deep comparison
  const ocr = ocrObs!;
  const vision = visionObs!;

  const normOcr = normalizeObservationValue(ocr.rawValue, key);
  const normVision = normalizeObservationValue(vision.rawValue, key);

  const confidenceDelta = Math.abs(ocr.confidence - vision.confidence);

  // Calculate location IoU if both have bounding boxes
  let locationIoU: number | undefined;
  let locationConflict = false;
  if (ocr.bbox && vision.bbox) {
    const samePage = ocr.pageNumber === undefined || vision.pageNumber === undefined || ocr.pageNumber === vision.pageNumber;
    if (!samePage) {
      locationConflict = true;
    } else {
      locationIoU = computeBoundingBoxIoU(ocr.bbox, vision.bbox);
      if (locationIoU < minLocationIoU) {
        locationConflict = true;
      }
    }
  }

  // Step 1: Check Ambiguous Source
  if (normOcr.isAmbiguous || normVision.isAmbiguous) {
    const reasons = [...normOcr.ambiguousReasons, ...normVision.ambiguousReasons].join('; ');
    return {
      id,
      key,
      classification: 'AMBIGUOUS_SOURCE',
      requiresReview: true,
      isSafetyCritical,
      ocrObservation: ocr,
      visionObservation: vision,
      normalizedOcrValue: normOcr.normalizedValue,
      normalizedVisionValue: normVision.normalizedValue,
      ocrUnit: normOcr.unit,
      visionUnit: normVision.unit,
      locationIoU,
      confidenceDelta,
      explanation: `Ambiguous characters detected: ${reasons}. Heuristic character replacement is prohibited.`,
    };
  }

  // Step 2: Check Unit Conflict
  const unitOcr = normOcr.unit?.toLowerCase();
  const unitVision = normVision.unit?.toLowerCase();
  if (unitOcr !== unitVision && (unitOcr !== undefined || unitVision !== undefined)) {
    return {
      id,
      key,
      classification: 'CONFLICTING_UNIT',
      requiresReview: true,
      isSafetyCritical,
      ocrObservation: ocr,
      visionObservation: vision,
      normalizedOcrValue: normOcr.normalizedValue,
      normalizedVisionValue: normVision.normalizedValue,
      ocrUnit: normOcr.unit,
      visionUnit: normVision.unit,
      locationIoU,
      confidenceDelta,
      explanation: `Conflicting units: OCR reported "${unitOcr ?? 'none'}" while Vision reported "${unitVision ?? 'none'}". Silent unit conversions are forbidden.`,
    };
  }

  // Step 3: Check Location Conflict
  if (locationConflict) {
    return {
      id,
      key,
      classification: 'CONFLICTING_LOCATION',
      requiresReview: true,
      isSafetyCritical,
      ocrObservation: ocr,
      visionObservation: vision,
      normalizedOcrValue: normOcr.normalizedValue,
      normalizedVisionValue: normVision.normalizedValue,
      ocrUnit: normOcr.unit,
      visionUnit: normVision.unit,
      locationIoU,
      confidenceDelta,
      explanation: `Observations for "${key}" point to non-overlapping locations (IoU: ${locationIoU?.toFixed(3) ?? '0.000'}).`,
    };
  }

  // Step 4: Check Value Agreement
  let valuesMatch = false;
  if (normOcr.isNumeric && normVision.isNumeric) {
    valuesMatch = Math.abs(normOcr.numericValue! - normVision.numericValue!) < 1e-5;
  } else {
    valuesMatch = normOcr.normalizedValue.toLowerCase() === normVision.normalizedValue.toLowerCase();
  }

  if (!valuesMatch) {
    return {
      id,
      key,
      classification: 'CONFLICTING_VALUE',
      requiresReview: true,
      isSafetyCritical,
      ocrObservation: ocr,
      visionObservation: vision,
      normalizedOcrValue: normOcr.normalizedValue,
      normalizedVisionValue: normVision.normalizedValue,
      ocrUnit: normOcr.unit,
      visionUnit: normVision.unit,
      locationIoU,
      confidenceDelta,
      explanation: `Conflicting values for "${key}": OCR reported "${normOcr.normalizedValue}", Vision reported "${normVision.normalizedValue}".`,
    };
  }

  // Step 5: Values match -> Check Confidence
  if (ocr.confidence < minConfidence || vision.confidence < minConfidence || confidenceDelta >= maxConfidenceDelta) {
    return {
      id,
      key,
      classification: 'CONFIDENCE_DISAGREEMENT',
      requiresReview: true,
      isSafetyCritical,
      ocrObservation: ocr,
      visionObservation: vision,
      normalizedOcrValue: normOcr.normalizedValue,
      normalizedVisionValue: normVision.normalizedValue,
      ocrUnit: normOcr.unit,
      visionUnit: normVision.unit,
      locationIoU,
      confidenceDelta,
      explanation: `Values agree on "${normOcr.normalizedValue}", but confidence levels disagree (OCR: ${ocr.confidence}, Vision: ${vision.confidence}, delta: ${confidenceDelta.toFixed(2)}).`,
    };
  }

  // Step 6: Complete Agreement
  // Safety critical values STILL require human review even if they agree completely!
  const requiresReview = isSafetyCritical;

  return {
    id,
    key,
    classification: 'AGREE',
    requiresReview,
    isSafetyCritical,
    ocrObservation: ocr,
    visionObservation: vision,
    normalizedOcrValue: normOcr.normalizedValue,
    normalizedVisionValue: normVision.normalizedValue,
    ocrUnit: normOcr.unit,
    visionUnit: normVision.unit,
    locationIoU,
    confidenceDelta,
    explanation: isSafetyCritical
      ? `Observations agree on "${normOcr.normalizedValue}", but field is SAFETY-CRITICAL and mandates human sign-off.`
      : `Complete agreement on "${normOcr.normalizedValue}" with consistent units and high confidence.`,
  };
}

// ── Converters ──────────────────────────────────────────────────────

export function ocrResultToComparableObservations(
  result: {
    sourceArtifactId: string;
    sourceHash: string;
    pageNumber: number;
    engine: string;
    engineVersion: string;
    blocks: readonly {
      id: string;
      text: string;
      bbox: OcrBoundingBox;
      confidence: number;
      pageNumber: number;
    }[];
  },
  projectId: string,
  options?: {
    keyPrefix?: string;
    safetyCriticalKeys?: string[];
  },
): ComparableObservation[] {
  const timestamp = new Date().toISOString();
  return result.blocks.map((block) => {
    const rawValue = block.text;
    const norm = normalizeObservationValue(rawValue);
    const key = options?.keyPrefix ? `${options.keyPrefix}_${block.id}` : block.id;
    const isSafetyCritical =
      options?.safetyCriticalKeys?.includes(key) ||
      isKnownSafetyKey(key) ||
      isKnownSafetyKey(rawValue);

    return {
      schemaVersion: 1,
      id: `obs-ocr-${block.id}`,
      source: 'ocr',
      sourceArtifactId: result.sourceArtifactId,
      sourceHash: result.sourceHash,
      projectId,
      pageNumber: block.pageNumber ?? result.pageNumber,
      bbox: {
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
      },
      engineOrModel: result.engine,
      versionOrRevision: result.engineVersion,
      key,
      rawValue,
      normalizedValue: norm.normalizedValue,
      unit: norm.unit,
      confidence: block.confidence,
      isSafetyCritical,
      timestamp,
      metadata: {
        blockId: block.id,
      },
    };
  });
}

export function visionResultToComparableObservations(
  result: {
    sourceArtifactId: string;
    sourceHash: string;
    modelId: string;
    modelRevision: string;
    observations: readonly {
      id: string;
      observationType: string;
      value: string;
      confidence: number;
      bbox?: ImageObservationBBox;
      pageNumber?: number;
      requiresReview?: boolean;
    }[];
  },
  projectId: string,
  options?: {
    safetyCriticalKeys?: string[];
  },
): ComparableObservation[] {
  const timestamp = new Date().toISOString();
  return result.observations.map((obs) => {
    const rawValue = obs.value;
    const norm = normalizeObservationValue(rawValue);
    const key = obs.observationType || obs.id;
    const isSafetyCritical =
      Boolean(obs.requiresReview) ||
      options?.safetyCriticalKeys?.includes(key) ||
      isKnownSafetyKey(key) ||
      isKnownSafetyKey(rawValue);

    return {
      schemaVersion: 1,
      id: `obs-vis-${obs.id}`,
      source: 'vision',
      sourceArtifactId: result.sourceArtifactId,
      sourceHash: result.sourceHash,
      projectId,
      pageNumber: obs.pageNumber,
      bbox: obs.bbox
        ? {
            x: obs.bbox.x,
            y: obs.bbox.y,
            width: obs.bbox.width,
            height: obs.bbox.height,
          }
        : undefined,
      engineOrModel: result.modelId,
      versionOrRevision: result.modelRevision,
      key,
      rawValue,
      normalizedValue: norm.normalizedValue,
      unit: norm.unit,
      confidence: obs.confidence,
      isSafetyCritical,
      timestamp,
      metadata: {
        observationId: obs.id,
      },
    };
  });
}

// ── Validation Functions ────────────────────────────────────────────

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

export function validateComparableObservation(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['ComparableObservation must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.id) || !data.id.trim()) errors.push('id must be a non-empty string');
  if (data.source !== 'ocr' && data.source !== 'vision') {
    errors.push('source must be "ocr" or "vision"');
  }
  if (!isString(data.sourceArtifactId) || !data.sourceArtifactId.trim()) {
    errors.push('sourceArtifactId must be a non-empty string');
  }
  if (!isString(data.sourceHash) || !data.sourceHash.trim()) {
    errors.push('sourceHash must be a non-empty string');
  }
  if (!isString(data.projectId) || !data.projectId.trim()) {
    errors.push('projectId must be a non-empty string');
  }
  if (!isString(data.engineOrModel) || !data.engineOrModel.trim()) {
    errors.push('engineOrModel must be a non-empty string');
  }
  if (!isString(data.versionOrRevision) || !data.versionOrRevision.trim()) {
    errors.push('versionOrRevision must be a non-empty string');
  }
  if (!isString(data.key) || !data.key.trim()) {
    errors.push('key must be a non-empty string');
  }
  if (!isString(data.rawValue)) {
    errors.push('rawValue must be a string');
  }
  if (!isString(data.normalizedValue)) {
    errors.push('normalizedValue must be a string');
  }
  if (!isNumber(data.confidence) || data.confidence < 0 || data.confidence > 1) {
    errors.push('confidence must be a number between 0 and 1');
  }
  if (!isString(data.timestamp) || !data.timestamp.trim()) {
    errors.push('timestamp must be a non-empty string');
  }

  if (data.bbox !== undefined) {
    if (!isObject(data.bbox)) {
      errors.push('bbox must be an object if provided');
    } else {
      const b = data.bbox as Record<string, unknown>;
      if (!isNumber(b.x) || !isNumber(b.y) || !isNumber(b.width) || !isNumber(b.height)) {
        errors.push('bbox must have numeric x, y, width, and height');
      }
    }
  }

  return errors.length ? fail(errors) : ok();
}

export function validateConflictItem(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['ConflictItem must be an object']);

  if (!isString(data.id) || !data.id.trim()) errors.push('id must be a non-empty string');
  if (!isString(data.key) || !data.key.trim()) errors.push('key must be a non-empty string');
  if (!isBoolean(data.requiresReview)) errors.push('requiresReview must be a boolean');
  if (!isBoolean(data.isSafetyCritical)) errors.push('isSafetyCritical must be a boolean');
  if (!isString(data.explanation)) errors.push('explanation must be a string');

  const validClassifications: ConflictClassification[] = [
    'AGREE',
    'OCR_ONLY',
    'VISION_ONLY',
    'CONFLICTING_VALUE',
    'CONFLICTING_UNIT',
    'CONFLICTING_LOCATION',
    'CONFIDENCE_DISAGREEMENT',
    'AMBIGUOUS_SOURCE',
    'REQUIRES_HUMAN_REVIEW',
  ];
  if (!validClassifications.includes(data.classification as ConflictClassification)) {
    errors.push(`Invalid classification: ${data.classification}`);
  }

  if (data.ocrObservation !== undefined) {
    const v = validateComparableObservation(data.ocrObservation);
    if (!v.valid) errors.push(...v.errors.map((e) => `ocrObservation: ${e}`));
  }
  if (data.visionObservation !== undefined) {
    const v = validateComparableObservation(data.visionObservation);
    if (!v.valid) errors.push(...v.errors.map((e) => `visionObservation: ${e}`));
  }

  return errors.length ? fail(errors) : ok();
}

export function validateConflictReport(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['ConflictReport must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.id) || !data.id.trim()) errors.push('id must be a non-empty string');
  if (!isString(data.projectId) || !data.projectId.trim()) errors.push('projectId must be a non-empty string');
  if (!isString(data.sourceArtifactId) || !data.sourceArtifactId.trim()) {
    errors.push('sourceArtifactId must be a non-empty string');
  }
  if (!isString(data.sourceHash) || !data.sourceHash.trim()) {
    errors.push('sourceHash must be a non-empty string');
  }
  if (!isString(data.generatedAt) || !data.generatedAt.trim()) {
    errors.push('generatedAt must be a non-empty string');
  }

  if (!Array.isArray(data.items)) {
    errors.push('items must be an array');
  } else {
    data.items.forEach((item, index) => {
      const v = validateConflictItem(item);
      if (!v.valid) errors.push(...v.errors.map((e) => `items[${index}]: ${e}`));
    });
  }

  if (!isObject(data.summary)) {
    errors.push('summary must be an object');
  } else {
    const s = data.summary as Record<string, unknown>;
    if (!isNumber(s.totalItems)) errors.push('summary.totalItems must be a number');
    if (!isNumber(s.agreeCount)) errors.push('summary.agreeCount must be a number');
    if (!isNumber(s.conflictCount)) errors.push('summary.conflictCount must be a number');
    if (!isNumber(s.reviewRequiredCount)) errors.push('summary.reviewRequiredCount must be a number');
  }

  const validStatuses = ['pending_review', 'auto_resolved', 'resolved'];
  if (!validStatuses.includes(data.status as string)) {
    errors.push(`status must be one of ${validStatuses.join(', ')}`);
  }

  return errors.length ? fail(errors) : ok();
}

export function validateHumanReviewInput(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['HumanReviewInput must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.reportId) || !data.reportId.trim()) errors.push('reportId must be a non-empty string');
  if (!isString(data.itemId) || !data.itemId.trim()) errors.push('itemId must be a non-empty string');
  if (!isString(data.reviewerId) || !data.reviewerId.trim()) errors.push('reviewerId must be a non-empty string');
  if (!isString(data.rationale) || !data.rationale.trim()) errors.push('rationale must be a non-empty string');
  if (!isString(data.timestamp) || !data.timestamp.trim()) errors.push('timestamp must be a non-empty string');

  const validDecisions: ConflictResolutionDecision[] = [
    'accept_ocr',
    'accept_vision',
    'enter_corrected_value',
    'mark_unresolved',
    'reject_both',
  ];
  if (!validDecisions.includes(data.decision as ConflictResolutionDecision)) {
    errors.push(`decision must be one of ${validDecisions.join(', ')}`);
  }

  if (data.decision === 'enter_corrected_value') {
    if (!isString(data.correctedValue) || !data.correctedValue.trim()) {
      errors.push('correctedValue must be a non-empty string when decision is enter_corrected_value');
    }
  }

  return errors.length ? fail(errors) : ok();
}

export function validateResolvedObservation(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return fail(['ResolvedObservation must be an object']);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isString(data.id) || !data.id.trim()) errors.push('id must be a non-empty string');
  if (!isString(data.reportId) || !data.reportId.trim()) errors.push('reportId must be a non-empty string');
  if (!isString(data.itemId) || !data.itemId.trim()) errors.push('itemId must be a non-empty string');
  if (!isString(data.projectId) || !data.projectId.trim()) errors.push('projectId must be a non-empty string');
  if (!isString(data.key) || !data.key.trim()) errors.push('key must be a non-empty string');
  if (!isString(data.reviewerId) || !data.reviewerId.trim()) errors.push('reviewerId must be a non-empty string');
  if (!isString(data.rationale) || !data.rationale.trim()) errors.push('rationale must be a non-empty string');
  if (!isString(data.resolvedAt) || !data.resolvedAt.trim()) errors.push('resolvedAt must be a non-empty string');

  const validStatuses: ResolutionStatus[] = [
    'accepted_ocr',
    'accepted_vision',
    'manually_corrected',
    'unresolved',
    'rejected',
  ];
  if (!validStatuses.includes(data.status as ResolutionStatus)) {
    errors.push(`status must be one of ${validStatuses.join(', ')}`);
  }

  return errors.length ? fail(errors) : ok();
}
