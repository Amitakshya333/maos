/**
 * MAOS Industrial — Office Artifact Input Domain Contract (F6-01)
 *
 * Defines versioned, strictly typed, verified schemas and pure validators for
 * generating real office deliverables (DOCX, XLSX, PPTX).
 *
 * Enforces:
 * 1. Explicit separation of:
 *    - Validated structured data (facts, measurements, calculations)
 *    - Cryptographic citations and exact source provenance
 *    - Unverified model prose (explicitly tagged, untrusted until approved)
 *    - Reviewer corrections (human overrides with audit record)
 *    - Final approved conclusions (binding human decision)
 * 2. Fail-closed security rules:
 *    - Reject formula injection in spreadsheet and tabular cells
 *    - Reject external relationships, remote media, and unconfined URLs
 *    - Reject macro references (.docm, .xlsm, vbaProject) and script execution
 *    - Strict project-root and path containment (no traversal, no absolute external paths)
 *    - Reject missing citations, missing units, stale hashes, and cross-project leaks
 *    - Reject unresolved OCR/VLM conflicts and low-confidence unreviewed evidence
 *    - Mandatory approval enforcement when policy or safety conditions require it
 * 3. Deterministic canonical serialization and SHA-256 input hashing
 * 4. Stale-input and tampering detection
 */

import * as crypto from 'crypto';
import type { FindingStatus } from './schemas';
import type { ConflictClassification, ResolutionStatus } from './conflict';

// ── Supported Office Output Artifact Types ──────────────────────────

export type OfficeArtifactType = 'docx' | 'xlsx' | 'pptx';

export const ALL_OFFICE_ARTIFACT_TYPES: readonly OfficeArtifactType[] = [
  'docx',
  'xlsx',
  'pptx',
] as const;

// ── Bounds and Limits ───────────────────────────────────────────────

export const OFFICE_INPUT_BOUNDS = {
  MIN_TITLE_LENGTH: 3,
  MAX_TITLE_LENGTH: 256,
  MAX_HEADING_LENGTH: 256,
  MAX_SECTION_CONTENT_LENGTH: 65536,
  MAX_SECTIONS: 100,
  MAX_FINDINGS: 500,
  MAX_CITATIONS: 1000,
  MAX_MEASUREMENTS: 500,
  MAX_CALCULATIONS: 200,
  MAX_WARNINGS: 200,
  MAX_TABLES: 50,
  MAX_ROWS_PER_TABLE: 10000,
  MAX_CELLS_PER_TABLE: 100000,
  MAX_INPUT_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_SOURCE_REFERENCES: 500,
  MIN_OCR_CONFIDENCE_THRESHOLD: 0.70,
  MIN_VLM_CONFIDENCE_THRESHOLD: 0.60,
} as const;

// ── Error Codes ─────────────────────────────────────────────────────

export type OfficeInputErrorCode =
  | 'SCHEMA_VERSION_INVALID'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_ARTIFACT_TYPE'
  | 'BOUNDS_EXCEEDED'
  | 'CROSS_PROJECT_FORBIDDEN'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'EXTERNAL_PATH_FORBIDDEN'
  | 'FORMULA_INJECTION_DETECTED'
  | 'EXTERNAL_RELATIONSHIP_FORBIDDEN'
  | 'MACRO_OR_EXECUTABLE_DETECTED'
  | 'MISSING_CITATION'
  | 'MISSING_UNIT'
  | 'UNRESOLVED_CONFLICT'
  | 'LOW_CONFIDENCE_UNREVIEWED'
  | 'APPROVAL_REQUIRED'
  | 'STALE_SOURCE_HASH'
  | 'TAMPERED_PROVENANCE'
  | 'SOURCE_NOT_FOUND'
  | 'INVALID_NUMERIC_VALUE';

export class OfficeInputError extends Error {
  constructor(
    public readonly code: OfficeInputErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'OfficeInputError';
    Object.setPrototypeOf(this, OfficeInputError.prototype);
  }
}

// ── DOCX Tool and Generation Error Types ────────────────────────────

export type DocxGenerationErrorCode =
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'INVALID_INPUT'
  | 'CROSS_PROJECT_FORBIDDEN'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'APPROVAL_REQUIRED'
  | 'STALE_APPROVAL'
  | 'CHANGED_INPUT_AFTER_APPROVAL'
  | 'STALE_SOURCE_HASH'
  | 'UNRESOLVED_CONFLICT'
  | 'QUARANTINED_EVIDENCE'
  | 'LOW_CONFIDENCE_UNREVIEWED'
  | 'MISSING_CITATION'
  | 'MISSING_UNIT'
  | 'EXTERNAL_RELATIONSHIP_FORBIDDEN'
  | 'MACRO_OR_EXECUTABLE_DETECTED'
  | 'REMOTE_URL_FORBIDDEN'
  | 'ARTIFACT_COLLISION'
  | 'UNAUTHORIZED_OVERWRITE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_MUTATION'
  | 'DOCX_PACKAGE_INVALID'
  | 'TEMPLATE_SAFETY_VIOLATION'
  | 'OUTPUT_SAFETY_VIOLATION'
  | 'GENERATION_FAILED';

export class DocxGenerationError extends Error {
  constructor(
    public readonly code: DocxGenerationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DocxGenerationError';
    Object.setPrototypeOf(this, DocxGenerationError.prototype);
  }
}

export interface GenerateDocxToolInput {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly input: OfficeDocxInput;
  readonly outputPath: string;
  readonly allowOverwrite?: boolean;
  readonly approvalId?: string;
  readonly requestId: string;
  readonly templatePath?: string;
}

export interface GenerateDocxToolResult {
  readonly ok: boolean;
  readonly artifactId?: string;
  readonly relativePath?: string;
  readonly canonicalHash?: string;
  readonly artifactHash?: string;
  readonly bytesWritten?: number;
  readonly generatedAt?: string;
  readonly approvalId?: string;
  readonly cached?: boolean;
  readonly error?: DocxGenerationErrorCode | string;
  readonly message?: string;
}

// ── XLSX Tool and Generation Error Types ────────────────────────────

export type XlsxGenerationErrorCode =
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'INVALID_INPUT'
  | 'CROSS_PROJECT_FORBIDDEN'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'APPROVAL_REQUIRED'
  | 'STALE_APPROVAL'
  | 'CHANGED_INPUT_AFTER_APPROVAL'
  | 'STALE_SOURCE_HASH'
  | 'UNRESOLVED_CONFLICT'
  | 'QUARANTINED_EVIDENCE'
  | 'LOW_CONFIDENCE_UNREVIEWED'
  | 'MISSING_CITATION'
  | 'MISSING_UNIT'
  | 'FORMULA_INJECTION_DETECTED'
  | 'EXTERNAL_RELATIONSHIP_FORBIDDEN'
  | 'MACRO_OR_EXECUTABLE_DETECTED'
  | 'REMOTE_URL_FORBIDDEN'
  | 'ARTIFACT_COLLISION'
  | 'UNAUTHORIZED_OVERWRITE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_MUTATION'
  | 'XLSX_PACKAGE_INVALID'
  | 'TEMPLATE_SAFETY_VIOLATION'
  | 'OUTPUT_SAFETY_VIOLATION'
  | 'GENERATION_FAILED';

export class XlsxGenerationError extends Error {
  constructor(
    public readonly code: XlsxGenerationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'XlsxGenerationError';
    Object.setPrototypeOf(this, XlsxGenerationError.prototype);
  }
}

export interface GenerateXlsxToolInput {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly input: OfficeXlsxInput;
  readonly outputPath: string;
  readonly allowOverwrite?: boolean;
  readonly approvalId?: string;
  readonly requestId: string;
  readonly templatePath?: string;
}

export interface GenerateXlsxToolResult {
  readonly ok: boolean;
  readonly artifactId?: string;
  readonly relativePath?: string;
  readonly canonicalHash?: string;
  readonly artifactHash?: string;
  readonly bytesWritten?: number;
  readonly generatedAt?: string;
  readonly approvalId?: string;
  readonly cached?: boolean;
  readonly sheetCount?: number;
  readonly sheetNames?: readonly string[];
  readonly error?: XlsxGenerationErrorCode | string;
  readonly message?: string;
}

// ── PPTX Tool & Service Types ───────────────────────────────────────

export type PptxGenerationErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'STALE_SOURCE_HASH'
  | 'SOURCE_FILE_MISSING'
  | 'APPROVAL_REQUIRED'
  | 'CHANGED_INPUT_AFTER_APPROVAL'
  | 'STALE_APPROVAL'
  | 'UNRESOLVED_CONFLICT'
  | 'QUARANTINED_EVIDENCE'
  | 'LOW_CONFIDENCE_UNREVIEWED'
  | 'MISSING_CITATION'
  | 'MISSING_UNIT'
  | 'EXTERNAL_RELATIONSHIP_FORBIDDEN'
  | 'MACRO_OR_EXECUTABLE_DETECTED'
  | 'REMOTE_URL_FORBIDDEN'
  | 'ARTIFACT_COLLISION'
  | 'UNAUTHORIZED_OVERWRITE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_MUTATION'
  | 'PPTX_PACKAGE_INVALID'
  | 'TEMPLATE_SAFETY_VIOLATION'
  | 'OUTPUT_SAFETY_VIOLATION'
  | 'GENERATION_FAILED';

export class PptxGenerationError extends Error {
  constructor(
    public readonly code: PptxGenerationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PptxGenerationError';
    Object.setPrototypeOf(this, PptxGenerationError.prototype);
  }
}

export interface GeneratePptxToolInput {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly input: OfficePptxInput;
  readonly outputPath: string;
  readonly allowOverwrite?: boolean;
  readonly approvalId?: string;
  readonly requestId: string;
  readonly templatePath?: string;
}

export interface GeneratePptxToolResult {
  readonly ok: boolean;
  readonly artifactId?: string;
  readonly relativePath?: string;
  readonly canonicalHash?: string;
  readonly artifactHash?: string;
  readonly bytesWritten?: number;
  readonly generatedAt?: string;
  readonly approvalId?: string;
  readonly cached?: boolean;
  readonly slideCount?: number;
  readonly slideTitles?: readonly string[];
  readonly error?: PptxGenerationErrorCode | string;
  readonly message?: string;
}

// ── Provenance & Citations ──────────────────────────────────────────

export interface OfficeCitation {
  readonly citationId: string;
  readonly sourceArtifactId?: string;
  readonly sourcePath: string;
  readonly sourceHash: string; // SHA-256 of source file/chunk
  readonly documentId?: string;
  readonly chunkId?: string;
  readonly pageNumber?: number;
  readonly sectionHeading?: string;
  readonly snippet: string;
  readonly verifiedAt: string;
}

export interface OfficeSourceReference {
  readonly id: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceArtifactId?: string;
  readonly documentVersion?: number;
  readonly documentId?: string;
  readonly chunkId?: string;
  readonly pageNumber?: number;
  readonly sectionHeading?: string;
}

// ── Measurements & Units ────────────────────────────────────────────

export type OfficeMeasurementStatus =
  | 'nominal'
  | 'out_of_spec'
  | 'critical'
  | 'unverified';

export interface OfficeMeasurement {
  readonly id: string;
  readonly name: string;
  readonly numericValue: number;
  readonly unit: string; // Required, non-empty
  readonly tolerance?: number | { readonly min?: number; readonly max?: number };
  readonly status?: OfficeMeasurementStatus;
  readonly citationIds: readonly string[]; // Must cite at least one citation
}

// ── Calculations & Determinism ──────────────────────────────────────

export interface OfficeCalculationInput {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

export interface OfficeCalculation {
  readonly id: string;
  readonly name: string;
  readonly inputs: readonly OfficeCalculationInput[];
  readonly methodOrFormula: string;
  readonly resultValue: number;
  readonly resultUnit: string;
  readonly verifiedBy: 'rust_engine' | 'deterministic_calc' | 'human_expert';
  readonly citationIds?: readonly string[];
}

// ── Reviewer Corrections & Approvals ────────────────────────────────

export interface OfficeReviewerCorrection {
  readonly reviewerId: string;
  readonly timestamp: string;
  readonly field: string;
  readonly originalValue: string | number;
  readonly correctedValue: string | number;
  readonly reason: string;
}

export type OfficeApprovalStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'conditional';

export interface OfficeApproval {
  readonly required: boolean;
  readonly status: OfficeApprovalStatus;
  readonly approvalId?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly payloadHash?: string;
  readonly comment?: string;
  readonly conditions?: readonly string[];
}

// ── Findings & Warnings ─────────────────────────────────────────────

export type OfficeFindingSeverity = 'info' | 'warning' | 'critical';

export interface OfficeFinding {
  readonly id: string;
  readonly category: string;
  readonly statement: string;
  readonly severity: OfficeFindingSeverity;
  readonly status: FindingStatus; // 'PASS' | 'WARNING' | 'FAIL'
  readonly metric?: string;
  readonly observedValue?: string | number;
  readonly thresholdValue?: string | number;
  readonly unit?: string;
  readonly citationIds: readonly string[]; // Must cite at least one citation
  readonly verified: boolean;
  readonly ruleId?: string;
  readonly reviewerCorrection?: OfficeReviewerCorrection;
}

export interface OfficeWarning {
  readonly code: string;
  readonly message: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly acknowledged: boolean;
  readonly acknowledgedBy?: string;
}

// ── Tabular Data for Spreadsheets & Reports ─────────────────────────

export interface OfficeTableColumn {
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  readonly numeric?: boolean;
}

export interface OfficeTable {
  readonly id: string;
  readonly title: string;
  readonly columns: readonly OfficeTableColumn[];
  readonly rows: readonly Record<string, string | number | boolean | null>[];
  readonly citationIds?: readonly string[];
}

// ── Unverified Model Prose & Clear Separation ───────────────────────

export interface OfficeProseBlock {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly isModelGenerated: boolean;
  readonly verifiedAgainstData: boolean;
  readonly approvedByReviewer: boolean;
  readonly modelId?: string;
}

// ── Sections & Conclusions ──────────────────────────────────────────

export interface OfficeReportSection {
  readonly id: string;
  readonly heading: string;
  readonly content?: string;
  readonly order: number;
  readonly findingIds?: readonly string[];
  readonly citationIds?: readonly string[];
  readonly tables?: readonly OfficeTable[];
  readonly unverifiedModelProse?: string;
}

export interface OfficeConclusion {
  readonly id: string;
  readonly statement: string;
  readonly verdict: 'approved' | 'rejected' | 'conditional';
  readonly signOffIdentity: string;
  readonly signedAt: string;
  readonly conditions?: readonly string[];
}

// ── Author & Evidence State ─────────────────────────────────────────

export interface OfficeAuthorIdentity {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
}

export interface OfficeEvidenceState {
  readonly ocrConfidence?: number;
  readonly vlmConfidence?: number;
  readonly conflictClassification?: ConflictClassification;
  readonly resolutionStatus?: ResolutionStatus;
  readonly hasUnresolvedConflicts: boolean;
  readonly isQuarantined: boolean;
  readonly reviewedByHuman: boolean;
  readonly reviewerId?: string;
  readonly reviewerNotes?: string;
}

// ── Core Common Validated Artifact Input Contract ───────────────────

export interface ValidatedOfficeArtifactInput {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly artifactType: OfficeArtifactType;
  readonly title: string;
  readonly author: OfficeAuthorIdentity;
  readonly sections: readonly OfficeReportSection[];
  readonly findings: readonly OfficeFinding[];
  readonly measurements: readonly OfficeMeasurement[];
  readonly units: readonly string[];
  readonly calculations: readonly OfficeCalculation[];
  readonly warnings: readonly OfficeWarning[];
  readonly limitations: readonly string[];
  readonly citations: readonly OfficeCitation[];
  readonly sourceArtifactIds: readonly string[];
  readonly sourceHashes: Record<string, string>;
  readonly references: readonly OfficeSourceReference[];
  readonly evidenceState: OfficeEvidenceState;
  readonly modelIdentity?: {
    readonly modelId: string;
    readonly revision: string;
  };
  readonly generatedAt: string;
  readonly approval: OfficeApproval;
  readonly proseBlocks: readonly OfficeProseBlock[];
  readonly conclusions: readonly OfficeConclusion[];
  readonly canonicalHash?: string;
}

// ── Specialized Type Definitions ────────────────────────────────────

export interface OfficeDocxInput extends ValidatedOfficeArtifactInput {
  readonly artifactType: 'docx';
  readonly docxOptions?: {
    readonly headerText?: string;
    readonly footerText?: string;
    readonly tableOfContents?: boolean;
    readonly templatePath?: string;
  };
}

export interface OfficeXlsxInput extends ValidatedOfficeArtifactInput {
  readonly artifactType: 'xlsx';
  readonly xlsxOptions?: {
    readonly sheets?: readonly {
      readonly sheetName: string;
      readonly tableId: string;
    }[];
    readonly templatePath?: string;
  };
}

export interface OfficePptxInput extends ValidatedOfficeArtifactInput {
  readonly artifactType: 'pptx';
  readonly pptxOptions?: {
    readonly slideDeckTitle?: string;
    readonly maxSlides?: number;
    readonly templatePath?: string;
  };
}

// ── Template & Output Safety Error Types ────────────────────────────

export type TemplateSafetyErrorCode =
  | 'TEMPLATE_FILE_NOT_FOUND'
  | 'TEMPLATE_PATH_TRAVERSAL'
  | 'TEMPLATE_PATH_OUTSIDE_PROJECT'
  | 'TEMPLATE_FORBIDDEN_EXTENSION'
  | 'TEMPLATE_INVALID_ZIP'
  | 'TEMPLATE_MACRO_DETECTED'
  | 'TEMPLATE_ACTIVE_CONTENT_DETECTED'
  | 'TEMPLATE_EXTERNAL_RELATIONSHIP'
  | 'TEMPLATE_FORMULA_INJECTION'
  | 'TEMPLATE_XML_MALFORMED'
  | 'TEMPLATE_SECURITY_TAMPER'
  | 'OUTPUT_SAFETY_VIOLATION';

export class TemplateSafetyError extends Error {
  constructor(
    public readonly code: TemplateSafetyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'TemplateSafetyError';
    Object.setPrototypeOf(this, TemplateSafetyError.prototype);
  }
}

// ── Security Detection Functions ────────────────────────────────────

const DANGEROUS_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

const DANGEROUS_FORMULA_PATTERNS = [
  /^\s*=\s*(?:cmd|exec|dde|hyperlink|shell|importxml|webservice)/i,
  /\|\s*'(?:cmd|powershell|bash|sh)/i,
  /\b(?:DDE|HYPERLINK|WEBSERVICE|IMPORTXML)\s*\(/i,
];

const DISALLOWED_URL_PROTOCOLS = [
  'http:',
  'https:',
  'ftp:',
  'file:',
  'ms-appx:',
  'javascript:',
  'data:',
  'vbscript:',
];

const DISALLOWED_MACRO_INDICATORS = [
  '.docm',
  '.xlsm',
  '.pptm',
  'vbaproject',
  'vba_project',
  '<script',
  '</script>',
  'wscript.shell',
  'powershell.exe',
  'cmd.exe',
  'auto_open',
  'document_open',
  'autoopen',
];

/**
 * Checks if a string or primitive is a potential spreadsheet formula injection.
 * Pure numeric values (numbers or valid signed numeric strings) are safe literals.
 */
export function isPotentialFormulaInjection(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const raw = value;
  const trimmed = raw.trim();

  // If raw string starts with a control character tab or CR
  if (raw.startsWith('\t') || raw.startsWith('\r')) {
    return true;
  }

  // Check dangerous formula patterns
  for (const pattern of DANGEROUS_FORMULA_PATTERNS) {
    if (pattern.test(raw)) {
      return true;
    }
  }

  // String starts with '=' or '@'
  if (trimmed.startsWith('=') || trimmed.startsWith('@')) {
    return true;
  }

  // String starts with '+' or '-'
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    // If it's a valid plain decimal/integer number, it's a safe literal (e.g. "-12.5", "+5")
    const isStrictNumber = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
    if (!isStrictNumber) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a string contains external URLs or forbidden protocol relationships.
 */
export function containsExternalRelationship(value: string): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return DISALLOWED_URL_PROTOCOLS.some((proto) => lower.includes(proto));
}

/**
 * Checks if a string contains macro indicators, script execution, or executable payloads.
 */
export function containsMacroOrExecutable(value: string): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return DISALLOWED_MACRO_INDICATORS.some((indicator) => lower.includes(indicator));
}

/**
 * Checks if a path is safe and confined (no traversal, no external absolute paths, no null bytes).
 */
export function isSafeIndustrialPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('\0')) return false;

  // No URL schemes
  if (p.includes('://') || p.startsWith('file:') || p.startsWith('http:') || p.startsWith('https:')) {
    return false;
  }

  // No absolute paths (Windows drive or root slashes)
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')) {
    return false;
  }

  // Normalize slashes for traversal detection
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return false;
    }
  }

  return true;
}

// ── Validation Result ───────────────────────────────────────────────

export interface OfficeInputValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly canonicalHash?: string;
}

// ── Pure Canonicalization & Hashing ─────────────────────────────────

/**
 * Recursively sort object keys for deterministic canonical JSON representation.
 */
export function canonicalizeJson(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(canonicalizeJson);
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    // Skip canonicalHash and payloadHash fields when computing canonical representation
    // because payloadHash records the hash of the payload itself
    if (key === 'canonicalHash' || key === 'payloadHash') {
      continue;
    }
    result[key] = canonicalizeJson(record[key]);
  }

  return result;
}

/**
 * Computes a deterministic canonical SHA-256 hash for a validated office input.
 * Order of object keys does not alter the output hash.
 */
export function computeOfficeInputHash(input: ValidatedOfficeArtifactInput): string {
  const canonicalObj = canonicalizeJson(input);
  const jsonStr = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(jsonStr, 'utf-8').digest('hex');
}

// ── Pure Validator ──────────────────────────────────────────────────

/**
 * Validates an office artifact input against all schema, security, provenance,
 * unit, citation, and bounding rules.
 */
export function validateOfficeArtifactInput(
  rawInput: unknown,
): OfficeInputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rawInput || typeof rawInput !== 'object') {
    return {
      valid: false,
      errors: ['[MISSING_REQUIRED_FIELD] Input must be a non-null object'],
      warnings: [],
    };
  }

  const input = rawInput as Record<string, unknown>;

  // Check total JSON size bound
  try {
    const rawBytes = Buffer.byteLength(JSON.stringify(input), 'utf-8');
    if (rawBytes > OFFICE_INPUT_BOUNDS.MAX_INPUT_BYTES) {
      errors.push(
        `[BOUNDS_EXCEEDED] Total input size ${rawBytes} bytes exceeds maximum limit of ${OFFICE_INPUT_BOUNDS.MAX_INPUT_BYTES} bytes`,
      );
    }
  } catch {
    errors.push('[BOUNDS_EXCEEDED] Input cannot be serialized to JSON');
  }

  // 1. Schema Version
  if (input.schemaVersion !== 1) {
    errors.push(`[SCHEMA_VERSION_INVALID] schemaVersion must be 1, received ${input.schemaVersion}`);
  }

  // 2. Project ID
  if (!input.projectId || typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    errors.push('[MISSING_REQUIRED_FIELD] projectId is required and must be a non-empty string');
  } else if (!isSafeIndustrialPath(input.projectId)) {
    errors.push(`[PATH_TRAVERSAL_DETECTED] projectId contains illegal characters or traversal: ${input.projectId}`);
  }

  // 3. Run ID
  if (!input.runId || typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push('[MISSING_REQUIRED_FIELD] runId is required and must be a non-empty string');
  }

  // 4. Artifact Type
  if (
    !input.artifactType ||
    typeof input.artifactType !== 'string' ||
    !ALL_OFFICE_ARTIFACT_TYPES.includes(input.artifactType as OfficeArtifactType)
  ) {
    errors.push(
      `[INVALID_ARTIFACT_TYPE] artifactType must be one of [${ALL_OFFICE_ARTIFACT_TYPES.join(', ')}], received ${input.artifactType}`,
    );
  }

  // 5. Title
  if (!input.title || typeof input.title !== 'string') {
    errors.push('[MISSING_REQUIRED_FIELD] title is required and must be a string');
  } else {
    const titleTrimmed = input.title.trim();
    if (titleTrimmed.length < OFFICE_INPUT_BOUNDS.MIN_TITLE_LENGTH) {
      errors.push(`[BOUNDS_EXCEEDED] title length must be at least ${OFFICE_INPUT_BOUNDS.MIN_TITLE_LENGTH} characters`);
    }
    if (titleTrimmed.length > OFFICE_INPUT_BOUNDS.MAX_TITLE_LENGTH) {
      errors.push(`[BOUNDS_EXCEEDED] title length must not exceed ${OFFICE_INPUT_BOUNDS.MAX_TITLE_LENGTH} characters`);
    }
    if (isPotentialFormulaInjection(input.title)) {
      errors.push(`[FORMULA_INJECTION_DETECTED] title contains formula injection pattern`);
    }
    if (containsExternalRelationship(input.title)) {
      errors.push(`[EXTERNAL_RELATIONSHIP_FORBIDDEN] title contains external URL or protocol relationship`);
    }
    if (containsMacroOrExecutable(input.title)) {
      errors.push(`[MACRO_OR_EXECUTABLE_DETECTED] title contains macro or executable reference`);
    }
  }

  // 6. Author Identity
  if (!input.author || typeof input.author !== 'object') {
    errors.push('[MISSING_REQUIRED_FIELD] author identity is required');
  } else {
    const author = input.author as Record<string, unknown>;
    if (!author.id || typeof author.id !== 'string') {
      errors.push('[MISSING_REQUIRED_FIELD] author.id is required');
    }
    if (!author.name || typeof author.name !== 'string') {
      errors.push('[MISSING_REQUIRED_FIELD] author.name is required');
    }
  }

  // 7. Citations Map & Validation
  const citationMap = new Map<string, OfficeCitation>();
  if (!Array.isArray(input.citations)) {
    errors.push('[MISSING_REQUIRED_FIELD] citations must be an array');
  } else {
    if (input.citations.length > OFFICE_INPUT_BOUNDS.MAX_CITATIONS) {
      errors.push(`[BOUNDS_EXCEEDED] citations count ${input.citations.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_CITATIONS}`);
    }
    for (const [idx, cit] of input.citations.entries()) {
      if (!cit || typeof cit !== 'object') {
        errors.push(`[MISSING_REQUIRED_FIELD] citation at index ${idx} is not an object`);
        continue;
      }
      const c = cit as Record<string, unknown>;
      if (!c.citationId || typeof c.citationId !== 'string') {
        errors.push(`[MISSING_REQUIRED_FIELD] citation at index ${idx} missing citationId`);
        continue;
      }
      if (!c.sourcePath || typeof c.sourcePath !== 'string') {
        errors.push(`[MISSING_REQUIRED_FIELD] citation ${c.citationId} missing sourcePath`);
      } else if (!isSafeIndustrialPath(c.sourcePath as string)) {
        errors.push(`[PATH_TRAVERSAL_DETECTED] citation ${c.citationId} has unconfined sourcePath: ${c.sourcePath}`);
      }
      if (!c.sourceHash || typeof c.sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(c.sourceHash as string)) {
        errors.push(`[TAMPERED_PROVENANCE] citation ${c.citationId} sourceHash is not a valid 64-character SHA-256 hash`);
      }
      if (c.snippet !== undefined && typeof c.snippet === 'string') {
        if (containsMacroOrExecutable(c.snippet)) {
          errors.push(`[MACRO_OR_EXECUTABLE_DETECTED] citation ${c.citationId} snippet contains script or executable`);
        }
      }
      citationMap.set(c.citationId as string, cit as OfficeCitation);
    }
  }

  // 8. Measurements & Units Validation
  if (!Array.isArray(input.measurements)) {
    errors.push('[MISSING_REQUIRED_FIELD] measurements must be an array');
  } else {
    if (input.measurements.length > OFFICE_INPUT_BOUNDS.MAX_MEASUREMENTS) {
      errors.push(`[BOUNDS_EXCEEDED] measurements count ${input.measurements.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_MEASUREMENTS}`);
    }
    for (const [idx, mRaw] of input.measurements.entries()) {
      if (!mRaw || typeof mRaw !== 'object') {
        errors.push(`[MISSING_REQUIRED_FIELD] measurement at index ${idx} is not an object`);
        continue;
      }
      const m = mRaw as Record<string, unknown>;
      if (!m.id || typeof m.id !== 'string') {
        errors.push(`[MISSING_REQUIRED_FIELD] measurement at index ${idx} missing id`);
      }
      if (typeof m.numericValue !== 'number' || isNaN(m.numericValue)) {
        errors.push(`[INVALID_NUMERIC_VALUE] measurement ${m.id || idx} numericValue must be a valid number`);
      }
      if (!m.unit || typeof m.unit !== 'string' || (m.unit as string).trim().length === 0) {
        errors.push(`[MISSING_UNIT] measurement ${m.id || idx} is missing a required unit`);
      }
      if (!Array.isArray(m.citationIds) || m.citationIds.length === 0) {
        errors.push(`[MISSING_CITATION] measurement ${m.id || idx} must cite at least one citation`);
      } else {
        for (const cid of m.citationIds) {
          if (!citationMap.has(cid)) {
            errors.push(`[MISSING_CITATION] measurement ${m.id || idx} references non-existent citationId: ${cid}`);
          }
        }
      }
    }
  }

  // 9. Findings Validation
  if (!Array.isArray(input.findings)) {
    errors.push('[MISSING_REQUIRED_FIELD] findings must be an array');
  } else {
    if (input.findings.length > OFFICE_INPUT_BOUNDS.MAX_FINDINGS) {
      errors.push(`[BOUNDS_EXCEEDED] findings count ${input.findings.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_FINDINGS}`);
    }
    for (const [idx, fRaw] of input.findings.entries()) {
      if (!fRaw || typeof fRaw !== 'object') {
        errors.push(`[MISSING_REQUIRED_FIELD] finding at index ${idx} is not an object`);
        continue;
      }
      const f = fRaw as Record<string, unknown>;
      if (!f.id || typeof f.id !== 'string') {
        errors.push(`[MISSING_REQUIRED_FIELD] finding at index ${idx} missing id`);
      }
      if (!f.statement || typeof f.statement !== 'string' || (f.statement as string).trim().length === 0) {
        errors.push(`[MISSING_REQUIRED_FIELD] finding ${f.id || idx} statement is required`);
      } else {
        if (isPotentialFormulaInjection(f.statement)) {
          errors.push(`[FORMULA_INJECTION_DETECTED] finding ${f.id} statement contains formula injection pattern`);
        }
        if (containsExternalRelationship(f.statement as string)) {
          errors.push(`[EXTERNAL_RELATIONSHIP_FORBIDDEN] finding ${f.id} statement contains external URL or protocol`);
        }
      }
      // Citations required for findings
      if (!Array.isArray(f.citationIds) || f.citationIds.length === 0) {
        errors.push(`[MISSING_CITATION] finding ${f.id || idx} must cite at least one citation`);
      } else {
        for (const cid of f.citationIds) {
          if (!citationMap.has(cid)) {
            errors.push(`[MISSING_CITATION] finding ${f.id || idx} references non-existent citationId: ${cid}`);
          }
        }
      }
      // Unit required if metric is specified
      if (f.metric && (!f.unit || typeof f.unit !== 'string' || (f.unit as string).trim().length === 0)) {
        errors.push(`[MISSING_UNIT] finding ${f.id || idx} specifies metric '${f.metric}' but is missing unit`);
      }
    }
  }

  // 10. Calculations Validation
  if (!Array.isArray(input.calculations)) {
    errors.push('[MISSING_REQUIRED_FIELD] calculations must be an array');
  } else {
    if (input.calculations.length > OFFICE_INPUT_BOUNDS.MAX_CALCULATIONS) {
      errors.push(`[BOUNDS_EXCEEDED] calculations count ${input.calculations.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_CALCULATIONS}`);
    }
    for (const [idx, cRaw] of input.calculations.entries()) {
      if (!cRaw || typeof cRaw !== 'object') continue;
      const c = cRaw as Record<string, unknown>;
      if (typeof c.resultValue !== 'number' || isNaN(c.resultValue)) {
        errors.push(`[INVALID_NUMERIC_VALUE] calculation ${c.id || idx} resultValue must be a valid number`);
      }
      if (!c.resultUnit || typeof c.resultUnit !== 'string' || (c.resultUnit as string).trim().length === 0) {
        errors.push(`[MISSING_UNIT] calculation ${c.id || idx} is missing resultUnit`);
      }
      if (c.citationIds && Array.isArray(c.citationIds)) {
        for (const cid of c.citationIds) {
          if (!citationMap.has(cid)) {
            errors.push(`[MISSING_CITATION] calculation ${c.id || idx} references non-existent citationId: ${cid}`);
          }
        }
      }
    }
  }

  // 11. Sections Validation & Tables
  if (!Array.isArray(input.sections)) {
    errors.push('[MISSING_REQUIRED_FIELD] sections must be an array');
  } else {
    if (input.sections.length > OFFICE_INPUT_BOUNDS.MAX_SECTIONS) {
      errors.push(`[BOUNDS_EXCEEDED] sections count ${input.sections.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_SECTIONS}`);
    }
    let totalTablesCount = 0;
    for (const [idx, sRaw] of input.sections.entries()) {
      if (!sRaw || typeof sRaw !== 'object') {
        errors.push(`[MISSING_REQUIRED_FIELD] section at index ${idx} is not an object`);
        continue;
      }
      const s = sRaw as Record<string, unknown>;
      if (!s.heading || typeof s.heading !== 'string') {
        errors.push(`[MISSING_REQUIRED_FIELD] section ${s.id || idx} missing heading`);
      } else {
        if (s.heading.length > OFFICE_INPUT_BOUNDS.MAX_HEADING_LENGTH) {
          errors.push(`[BOUNDS_EXCEEDED] section ${s.id || idx} heading exceeds max length of ${OFFICE_INPUT_BOUNDS.MAX_HEADING_LENGTH}`);
        }
        if (isPotentialFormulaInjection(s.heading)) {
          errors.push(`[FORMULA_INJECTION_DETECTED] section ${s.id || idx} heading contains formula injection pattern`);
        }
        if (containsExternalRelationship(s.heading)) {
          errors.push(`[EXTERNAL_RELATIONSHIP_FORBIDDEN] section ${s.id || idx} heading contains external URL`);
        }
      }
      if (s.content && typeof s.content === 'string') {
        if (s.content.length > OFFICE_INPUT_BOUNDS.MAX_SECTION_CONTENT_LENGTH) {
          errors.push(`[BOUNDS_EXCEEDED] section ${s.id || idx} content exceeds max length of ${OFFICE_INPUT_BOUNDS.MAX_SECTION_CONTENT_LENGTH}`);
        }
        if (containsMacroOrExecutable(s.content)) {
          errors.push(`[MACRO_OR_EXECUTABLE_DETECTED] section ${s.id || idx} content contains script or executable`);
        }
        if (containsExternalRelationship(s.content)) {
          errors.push(`[EXTERNAL_RELATIONSHIP_FORBIDDEN] section ${s.id || idx} content contains external URL`);
        }
      }
      // Section Tables Validation
      if (s.tables && Array.isArray(s.tables)) {
        totalTablesCount += s.tables.length;
        if (totalTablesCount > OFFICE_INPUT_BOUNDS.MAX_TABLES) {
          errors.push(`[BOUNDS_EXCEEDED] total tables count exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_TABLES}`);
        }
        for (const tRaw of s.tables) {
          if (!tRaw || typeof tRaw !== 'object') continue;
          const t = tRaw as Record<string, unknown>;
          if (Array.isArray(t.rows)) {
            if (t.rows.length > OFFICE_INPUT_BOUNDS.MAX_ROWS_PER_TABLE) {
              errors.push(`[BOUNDS_EXCEEDED] table ${t.id || 'unnamed'} row count ${t.rows.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_ROWS_PER_TABLE}`);
            }
            // Check each cell for formula injection and external relationships
            for (const row of t.rows) {
              if (row && typeof row === 'object') {
                for (const [colKey, cellVal] of Object.entries(row)) {
                  if (typeof cellVal === 'string') {
                    if (isPotentialFormulaInjection(cellVal)) {
                      errors.push(`[FORMULA_INJECTION_DETECTED] table ${t.id} column '${colKey}' cell contains formula injection: '${cellVal}'`);
                    }
                    if (containsExternalRelationship(cellVal)) {
                      errors.push(`[EXTERNAL_RELATIONSHIP_FORBIDDEN] table ${t.id} column '${colKey}' cell contains external relationship: '${cellVal}'`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 12. Evidence State & Confidence Review Enforcement
  if (!input.evidenceState || typeof input.evidenceState !== 'object') {
    errors.push('[MISSING_REQUIRED_FIELD] evidenceState is required');
  } else {
    const ev = input.evidenceState as Record<string, unknown>;
    // Check for unresolved conflicts
    if (ev.hasUnresolvedConflicts === true) {
      errors.push('[UNRESOLVED_CONFLICT] Input contains unresolved OCR/VLM conflicts');
    }
    if (ev.conflictClassification === 'REQUIRES_HUMAN_REVIEW' && ev.resolutionStatus === 'unresolved') {
      errors.push('[UNRESOLVED_CONFLICT] OCR/VLM conflict classification REQUIRES_HUMAN_REVIEW is unresolved');
    }
    // Check for quarantine
    if (ev.isQuarantined === true) {
      errors.push('[UNRESOLVED_CONFLICT] Input references quarantined or prompt-injected evidence');
    }
    // Check confidence thresholds
    const isHumanReviewed = ev.reviewedByHuman === true;
    if (typeof ev.ocrConfidence === 'number' && ev.ocrConfidence < OFFICE_INPUT_BOUNDS.MIN_OCR_CONFIDENCE_THRESHOLD) {
      if (!isHumanReviewed) {
        errors.push(
          `[LOW_CONFIDENCE_UNREVIEWED] OCR confidence ${ev.ocrConfidence.toFixed(2)} is below minimum threshold ${OFFICE_INPUT_BOUNDS.MIN_OCR_CONFIDENCE_THRESHOLD} and has not been reviewed by human`,
        );
      } else {
        warnings.push(`Low OCR confidence (${ev.ocrConfidence.toFixed(2)}) accepted via human review override`);
      }
    }
    if (typeof ev.vlmConfidence === 'number' && ev.vlmConfidence < OFFICE_INPUT_BOUNDS.MIN_VLM_CONFIDENCE_THRESHOLD) {
      if (!isHumanReviewed) {
        errors.push(
          `[LOW_CONFIDENCE_UNREVIEWED] VLM confidence ${ev.vlmConfidence.toFixed(2)} is below minimum threshold ${OFFICE_INPUT_BOUNDS.MIN_VLM_CONFIDENCE_THRESHOLD} and has not been reviewed by human`,
        );
      } else {
        warnings.push(`Low VLM confidence (${ev.vlmConfidence.toFixed(2)}) accepted via human review override`);
      }
    }
  }

  // 13. Approval Enforcement
  if (!input.approval || typeof input.approval !== 'object') {
    errors.push('[MISSING_REQUIRED_FIELD] approval state is required');
  } else {
    const app = input.approval as Record<string, unknown>;
    const required = app.required === true;
    const status = app.status as string;
    if (required && status !== 'approved') {
      errors.push(`[APPROVAL_REQUIRED] Document generation requires approval, but approval status is '${status}'`);
    }
  }

  // 14. References & Cross-Project Checks
  if (Array.isArray(input.references)) {
    if (input.references.length > OFFICE_INPUT_BOUNDS.MAX_SOURCE_REFERENCES) {
      errors.push(`[BOUNDS_EXCEEDED] references count ${input.references.length} exceeds limit ${OFFICE_INPUT_BOUNDS.MAX_SOURCE_REFERENCES}`);
    }
    for (const ref of input.references) {
      if (ref && typeof ref === 'object') {
        const r = ref as Record<string, unknown>;
        if (r.sourcePath && typeof r.sourcePath === 'string') {
          if (!isSafeIndustrialPath(r.sourcePath)) {
            errors.push(`[PATH_TRAVERSAL_DETECTED] reference sourcePath contains unconfined path: ${r.sourcePath}`);
          }
        }
      }
    }
  }

  // Compute canonical hash if valid
  let canonicalHash: string | undefined;
  if (errors.length === 0) {
    try {
      canonicalHash = computeOfficeInputHash(input as unknown as ValidatedOfficeArtifactInput);
    } catch (e: any) {
      errors.push(`Failed to compute canonical hash: ${e.message}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    canonicalHash,
  };
}

// ── Visual Review Domain Types ──────────────────────────────────────

export type {
  VisualReviewSeverity,
  VisualReviewIssueCode,
  VisualReviewIssue,
  VisualReviewMetric,
  VisualLayoutBounds,
  OfficeVisualReviewReport,
  OfficeVisualReviewOptions,
} from '../industrial/office/visual-review';
export { VisualReviewError } from '../industrial/office/visual-review';
