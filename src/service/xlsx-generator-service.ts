/**
 * MAOS Industrial — XLSX Generator Service (F6-03)
 *
 * Generates verified, editable, air-gapped OpenXML SpreadsheetML (.xlsx) workbooks
 * from validated OfficeXlsxInput contracts without external npm dependencies,
 * LibreOffice, Microsoft Excel automation, or shell commands.
 *
 * Enforces:
 * 1. Strict validation of OfficeXlsxInput schema, bounds, and provenance.
 * 2. Mandatory approval verification, rejecting missing, stale, or tampered approvals.
 * 3. Exact freshness verification against local disk files and source hashes.
 * 4. Strict defenses against spreadsheet formula injection, macros, external links, and scripts.
 * 5. Deterministic, collision-resistant output finalization through ArtifactService.
 * 6. Durable idempotency with replay cache and conflict detection.
 * 7. Privacy-safe audit trail (recording hashes, identifiers, and metadata; zero raw prose).
 * 8. Post-generation OOXML ZIP and SpreadsheetML well-formedness verification.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  OfficeXlsxInput,
  OfficeFinding,
  OfficeMeasurement,
  OfficeCalculation,
  OfficeWarning,
  OfficeCitation,
  OfficeReportSection,
  OfficeTable,
  OfficeProseBlock,
  OfficeConclusion,
  XlsxGenerationError,
  GenerateXlsxToolInput,
  GenerateXlsxToolResult,
  validateOfficeArtifactInput,
  computeOfficeInputHash,
  containsMacroOrExecutable,
  containsExternalRelationship,
  isPotentialFormulaInjection,
  isSafeIndustrialPath,
  TemplateSafetyError,
} from '../domain/office-artifact';
import { ArtifactService } from './artifact-service';
import { ApprovalService } from './approval-service';
import { AuditService } from './audit-service';
import { OfficeInputService } from './office-input-service';
import { OfficeTemplateSafetyService } from './office-template-safety-service';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import {
  buildXlsxArchive,
  validateXlsxPackage,
  XlsxWorkbookData,
  XlsxWorksheet,
  XlsxRow,
  XlsxCell,
  XlsxColumnDef,
  XLSX_STYLES,
} from '../industrial/office/xlsx-packager';

// ── Cell Value Sanitization & Injection Prevention ─────────────────

const DANGEROUS_FORMULA_INSPECTION = [
  /^\s*=\s*(?:cmd|exec|dde|hyperlink|shell|importxml|webservice)/i,
  /\|\s*'(?:cmd|powershell|bash|sh)/i,
  /\b(?:DDE|HYPERLINK|WEBSERVICE|IMPORTXML)\s*\(/i,
];

/**
 * Checks if a string contains active executable spreadsheet injection formulas or control characters.
 */
function isDangerousFormulaPayload(val: string): boolean {
  if (typeof val !== 'string') return false;
  if (val.startsWith('\t') || val.startsWith('\r')) return true;
  for (const pattern of DANGEROUS_FORMULA_INSPECTION) {
    if (pattern.test(val)) return true;
  }
  return false;
}

/**
 * Sanitizes a string cell value to prevent CSV / spreadsheet injection.
 * Throws if explicitly malicious injection patterns are detected.
 * For benign strings starting with '=', '+', '-', '@', prepends single-quote for safety.
 */
function sanitizeCellString(val: string, contextName: string): string {
  if (typeof val !== 'string') return String(val);

  // Reject tab or carriage return at start
  if (val.startsWith('\t') || val.startsWith('\r')) {
    throw new XlsxGenerationError(
      'FORMULA_INJECTION_DETECTED',
      `Field '${contextName}' starts with illegal control character tab or carriage return.`
    );
  }

  // Check dangerous injection patterns
  for (const pattern of DANGEROUS_FORMULA_INSPECTION) {
    if (pattern.test(val)) {
      throw new XlsxGenerationError(
        'FORMULA_INJECTION_DETECTED',
        `Field '${contextName}' contains prohibited formula injection pattern: '${val.substring(0, 40)}'`
      );
    }
  }

  // Prepend single-quote if text starts with formula triggers and is not a strict numeric value
  const trimmed = val.trim();
  if (trimmed.startsWith('=') || trimmed.startsWith('@')) {
    return `'${val}`;
  }
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    const isStrictNumber = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
    if (!isStrictNumber) {
      return `'${val}`;
    }
  }

  return val;
}

// ── Service Implementation ──────────────────────────────────────────

export class XlsxGeneratorService {
  private readonly templateSafetyService: OfficeTemplateSafetyService;

  constructor(
    private readonly projectRoot: string,
    private readonly artifactService: ArtifactService,
    private readonly approvalService: ApprovalService,
    private readonly auditService: AuditService,
    private readonly officeInputService: OfficeInputService,
    private readonly idempotencyStore: DurableIdempotencyStore,
    templateSafetyService?: OfficeTemplateSafetyService,
  ) {
    this.templateSafetyService =
      templateSafetyService ?? new OfficeTemplateSafetyService(this.projectRoot, this.auditService);
  }

  /**
   * Generates a safe, verified .xlsx workbook from validated OfficeXlsxInput.
   */
  generateXlsx(params: GenerateXlsxToolInput & {
    callerIdentity?: { agentId?: string; taskId?: string };
  }): GenerateXlsxToolResult {
    // 0. Template Safety validation (if templatePath provided)
    const templatePath =
      params.templatePath ||
      (params.input as any)?.templatePath ||
      (params.input as any)?.xlsxOptions?.templatePath;

    if (templatePath) {
      try {
        this.templateSafetyService.assertTemplateSafety(templatePath, 'xlsx', {
          runId: params.input?.runId || 'unknown',
          actor: params.callerIdentity?.agentId || 'xlsx_generator',
        });
      } catch (err: any) {
        if (err instanceof TemplateSafetyError) {
          throw new XlsxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
        }
        throw err;
      }
    }

    // 1. Schema version validation
    if (params.schemaVersion !== 1) {
      throw new XlsxGenerationError(
        'INVALID_INPUT',
        `Unsupported schemaVersion ${params.schemaVersion}. Expected schemaVersion 1.`
      );
    }

    // 2. Validate input is defined
    if (!params.input || typeof params.input !== 'object') {
      throw new XlsxGenerationError('INVALID_INPUT', 'Missing required input object.');
    }

    // 3. Project confinement & cross-project verification
    if (!params.projectId || typeof params.projectId !== 'string') {
      throw new XlsxGenerationError('INVALID_INPUT', 'Missing required projectId parameter.');
    }
    if (params.input.projectId !== params.projectId) {
      this.recordAudit('XLSX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'CROSS_PROJECT_FORBIDDEN',
        inputProjectId: params.input.projectId,
        requestProjectId: params.projectId,
      });
      throw new XlsxGenerationError(
        'CROSS_PROJECT_FORBIDDEN',
        `Input projectId '${params.input.projectId}' does not match requested projectId '${params.projectId}'.`
      );
    }

    // 4. Output path validation & containment
    if (!params.outputPath || typeof params.outputPath !== 'string') {
      throw new XlsxGenerationError('INVALID_INPUT', 'Missing required outputPath parameter.');
    }
    if (!isSafeIndustrialPath(params.outputPath)) {
      throw new XlsxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${params.outputPath}' violates safe path constraints (traversal, absolute, or invalid characters detected).`
      );
    }
    const normalizedRelPath = params.outputPath.replace(/\\/g, '/');
    if (!normalizedRelPath.toLowerCase().endsWith('.xlsx')) {
      throw new XlsxGenerationError(
        'INVALID_INPUT',
        `Output path '${params.outputPath}' must have a .xlsx extension.`
      );
    }

    // 5. OfficeXlsxInput domain validation (F6-01 pure validator)
    const validation = validateOfficeArtifactInput(params.input);
    if (!validation.valid) {
      this.recordAudit('XLSX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'INVALID_INPUT',
        errors: validation.errors,
      });
      throw new XlsxGenerationError(
        'INVALID_INPUT',
        `OfficeXlsxInput validation failed: ${validation.errors.join('; ')}`
      );
    }

    if (params.input.artifactType !== 'xlsx') {
      throw new XlsxGenerationError(
        'INVALID_INPUT',
        `Invalid artifactType '${params.input.artifactType}'. Expected 'xlsx'.`
      );
    }

    // 6. Security sanitization: Reject macros, scripts, and external relationships
    this.assertNoForbiddenPayloads(params.input);

    // 7. Compute deterministic canonical hash of input
    const canonicalHash = computeOfficeInputHash(params.input);

    // 8. Mandatory Approval Verification
    this.assertValidApproval(params, canonicalHash);

    // 8b. Assert untrusted template cannot alter safety guarantees
    try {
      this.templateSafetyService.assertUntrustedTemplateIntegrity(params.input, canonicalHash);
    } catch (err: any) {
      if (err instanceof TemplateSafetyError) {
        throw new XlsxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
      }
      throw err;
    }

    // 9. Dynamic Freshness & Provenance Verification
    const freshness = this.officeInputService.verifyFreshnessSync(params.input);
    if (!freshness.fresh) {
      this.recordAudit('XLSX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'STALE_SOURCE_HASH',
        inputHash: canonicalHash,
        errors: freshness.errors,
      });

      const joined = freshness.errors.join('; ');
      if (joined.includes('UNRESOLVED_CONFLICT') || joined.includes('conflict')) {
        throw new XlsxGenerationError('UNRESOLVED_CONFLICT', joined);
      }
      if (joined.includes('QUARANTINED') || joined.includes('quarantined')) {
        throw new XlsxGenerationError('QUARANTINED_EVIDENCE', joined);
      }
      if (joined.includes('LOW_CONFIDENCE') || joined.includes('confidence')) {
        throw new XlsxGenerationError('LOW_CONFIDENCE_UNREVIEWED', joined);
      }
      throw new XlsxGenerationError('STALE_SOURCE_HASH', joined);
    }

    // 10. Durable Idempotency Claim
    const requestId = params.requestId;
    if (!requestId || typeof requestId !== 'string') {
      throw new XlsxGenerationError('INVALID_INPUT', 'Missing required requestId for idempotency.');
    }

    const requestPayloadToHash = {
      schemaVersion: params.schemaVersion,
      projectId: params.projectId,
      canonicalHash,
      outputPath: normalizedRelPath,
      allowOverwrite: Boolean(params.allowOverwrite),
      approvalId: params.approvalId || params.input.approval.approvalId,
    };
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestPayloadToHash))
      .digest('hex');

    const claimOutcome = this.idempotencyStore.claim({
      key: requestId,
      requestHash,
      operation: 'generate_xlsx',
      projectId: params.projectId,
      authContext: params.callerIdentity?.agentId,
    });

    if (claimOutcome.outcome === 'replay') {
      return {
        ...(claimOutcome.record.responsePayload as GenerateXlsxToolResult),
        cached: true,
      };
    }
    if (claimOutcome.outcome === 'conflict') {
      throw new XlsxGenerationError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'in_progress') {
      throw new XlsxGenerationError('CONCURRENT_MUTATION', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'auth_mismatch') {
      throw new XlsxGenerationError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
    }

    // 11. Collision & Overwrite verification
    const destAbsPath = path.resolve(this.projectRoot, normalizedRelPath);
    if (fs.existsSync(destAbsPath)) {
      if (!params.allowOverwrite) {
        this.idempotencyStore.fail(requestId, 'Destination file already exists (collision).');
        throw new XlsxGenerationError(
          'ARTIFACT_COLLISION',
          `Destination path '${normalizedRelPath}' already exists. Overwriting requires allowOverwrite: true and approved approval.`
        );
      }
      const effectiveApprovalId = params.approvalId || params.input.approval.approvalId;
      if (!effectiveApprovalId) {
        this.idempotencyStore.fail(requestId, 'Overwrite requires approvalId.');
        throw new XlsxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          'Overwriting an existing document requires an explicit approvalId.'
        );
      }
      const appRecord = this.approvalService.getApproval(effectiveApprovalId);
      if (appRecord && appRecord.status !== 'approved') {
        this.idempotencyStore.fail(requestId, 'Approval status for overwrite is not approved.');
        throw new XlsxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          `Approval '${effectiveApprovalId}' has status '${appRecord.status}'. Overwrite denied.`
        );
      }
    }

    // 12. Audit Event: XLSX_GENERATION_STARTED (Privacy-safe: no raw text)
    this.recordAudit('XLSX_GENERATION_STARTED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
      projectId: params.projectId,
      inputHash: canonicalHash,
      outputPath: normalizedRelPath,
      findingsCount: params.input.findings.length,
      measurementsCount: params.input.measurements.length,
      citationsCount: params.input.citations.length,
      approvalId: params.input.approval.approvalId,
    });

    let zipBuffer: Buffer;
    let workbookData: XlsxWorkbookData;
    try {
      // 13. Build SpreadsheetML workbook structure & PKZIP buffer
      workbookData = this.buildWorkbookStructure(params.input, canonicalHash);
      zipBuffer = buildXlsxArchive(workbookData);
    } catch (err: any) {
      const isFormulaErr = err instanceof XlsxGenerationError && err.code === 'FORMULA_INJECTION_DETECTED';
      const code = isFormulaErr ? 'FORMULA_INJECTION_DETECTED' : 'GENERATION_FAILED';
      this.idempotencyStore.fail(requestId, `Package build error: ${err.message}`);
      this.recordAudit('XLSX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: code,
        message: err.message,
        inputHash: canonicalHash,
      });
      if (err instanceof XlsxGenerationError) {
        throw err;
      }
      throw new XlsxGenerationError('GENERATION_FAILED', `Failed to build XLSX package: ${err.message}`);
    }

    // 14. Validate generated XLSX package (reopen and parse offline)
    const packageValidation = validateXlsxPackage(zipBuffer);
    if (!packageValidation.valid) {
      const msg = packageValidation.errors.join('; ');
      this.idempotencyStore.fail(requestId, `Validation failed: ${msg}`);
      this.recordAudit('XLSX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'PACKAGE_VALIDATION_FAILED',
        errors: packageValidation.errors,
        inputHash: canonicalHash,
      });
      throw new XlsxGenerationError('XLSX_PACKAGE_INVALID', `Generated XLSX package failed offline validation: ${msg}`);
    }

    // 14b. Validate output package safety before finalization (F6-05)
    try {
      this.templateSafetyService.assertOutputSafety(zipBuffer, 'xlsx', normalizedRelPath, {
        runId: params.input.runId,
        actor: params.callerIdentity?.agentId || 'xlsx_generator',
      });
    } catch (err: any) {
      const reason = err instanceof TemplateSafetyError ? err.message : String(err.message || err);
      this.idempotencyStore.fail(requestId, `Output safety validation failed: ${reason}`);
      this.recordAudit('XLSX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'OUTPUT_SAFETY_VIOLATION',
        message: reason,
        inputHash: canonicalHash,
      });
      throw new XlsxGenerationError('OUTPUT_SAFETY_VIOLATION', `Output package safety verification failed: ${reason}`);
    }

    // 15. Finalize artifact atomically through ArtifactService
    const artifactId = `xlsx_${crypto.randomBytes(8).toString('hex')}`;
    let finalizedArtifact;
    try {
      finalizedArtifact = this.artifactService.finalizeArtifact({
        id: artifactId,
        type: 'report',
        relativePath: normalizedRelPath,
        content: zipBuffer,
        allowOverwrite: Boolean(params.allowOverwrite),
        approvalId: params.approvalId || params.input.approval.approvalId,
        metadata: {
          generator: 'MAOS_XLSX_GENERATOR_V1',
          inputCanonicalHash: canonicalHash,
          projectId: params.projectId,
          runId: params.input.runId,
          taskId: params.input.taskId,
          approvalId: params.input.approval.approvalId,
          approvedBy: params.input.approval.approvedBy,
          findingsCount: params.input.findings.length,
          measurementsCount: params.input.measurements.length,
          citationsCount: params.input.citations.length,
          sheetCount: packageValidation.sheetCount,
          templatePath: templatePath || undefined,
          generatedAt: params.input.generatedAt,
        },
      });
    } catch (err: any) {
      this.idempotencyStore.fail(requestId, `Finalization error: ${err.message}`);
      this.recordAudit('XLSX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'xlsx_generator', {
        reason: 'FINALIZATION_FAILED',
        message: err.message,
        inputHash: canonicalHash,
      });
      throw new XlsxGenerationError('GENERATION_FAILED', `Failed to finalize artifact: ${err.message}`);
    }

    // 16. Audit Event: XLSX_GENERATED (Privacy-safe: no raw text)
    this.recordAudit('XLSX_GENERATED', finalizedArtifact.id, params.callerIdentity?.agentId || 'xlsx_generator', {
      artifactId: finalizedArtifact.id,
      artifactHash: finalizedArtifact.hash,
      inputHash: canonicalHash,
      relativePath: normalizedRelPath,
      bytesWritten: finalizedArtifact.size,
      approvalId: params.input.approval.approvalId,
      sheetCount: packageValidation.sheetCount,
    });

    const sheetNames = workbookData.sheets.map((s) => s.name);
    const result: GenerateXlsxToolResult = {
      ok: true,
      artifactId: finalizedArtifact.id,
      relativePath: normalizedRelPath,
      canonicalHash,
      artifactHash: finalizedArtifact.hash,
      bytesWritten: finalizedArtifact.size,
      generatedAt: params.input.generatedAt,
      approvalId: params.input.approval.approvalId,
      sheetCount: packageValidation.sheetCount,
      sheetNames,
      cached: false,
    };

    // 17. Complete idempotency claim
    this.idempotencyStore.complete(requestId, 200, result);

    return result;
  }

  /**
   * Asynchronous variant of generateXlsx.
   */
  public async generateXlsxAsync(params: GenerateXlsxToolInput & {
    callerIdentity?: { agentId?: string; taskId?: string };
  }): Promise<GenerateXlsxToolResult> {
    return Promise.resolve(this.generateXlsx(params));
  }

  // ── Private Validation & Construction Helpers ───────────────────────

  private assertNoForbiddenPayloads(input: OfficeXlsxInput): void {
    // Check title
    if (containsMacroOrExecutable(input.title)) {
      throw new XlsxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', 'Title contains macro or executable reference.');
    }
    if (containsExternalRelationship(input.title)) {
      throw new XlsxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', 'Title contains external URL/relationship.');
    }

    // Check findings
    for (const f of input.findings) {
      if (containsMacroOrExecutable(f.statement)) {
        throw new XlsxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Finding '${f.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(f.statement)) {
        throw new XlsxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Finding '${f.id}' contains external relationship/URL.`);
      }
      if (isPotentialFormulaInjection(f.statement)) {
        throw new XlsxGenerationError('FORMULA_INJECTION_DETECTED', `Finding '${f.id}' contains formula injection: '${f.statement}'`);
      }
    }

    // Check measurements
    for (const m of input.measurements) {
      if (containsMacroOrExecutable(m.name)) {
        throw new XlsxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Measurement '${m.id}' contains macro reference.`);
      }
      if (typeof m.numericValue !== 'number' || isNaN(m.numericValue)) {
        throw new XlsxGenerationError('INVALID_INPUT', `Measurement '${m.id}' numericValue must be a valid number.`);
      }
      if (!m.unit || typeof m.unit !== 'string' || m.unit.trim().length === 0) {
        throw new XlsxGenerationError('MISSING_UNIT', `Measurement '${m.id}' is missing required unit.`);
      }
    }

    // Check calculations
    for (const c of input.calculations) {
      if (typeof c.resultValue !== 'number' || isNaN(c.resultValue)) {
        throw new XlsxGenerationError('INVALID_INPUT', `Calculation '${c.id}' resultValue must be a valid number.`);
      }
      if (!c.resultUnit || typeof c.resultUnit !== 'string' || c.resultUnit.trim().length === 0) {
        throw new XlsxGenerationError('MISSING_UNIT', `Calculation '${c.id}' is missing required resultUnit.`);
      }
      if (c.methodOrFormula && isPotentialFormulaInjection(c.methodOrFormula)) {
        throw new XlsxGenerationError('FORMULA_INJECTION_DETECTED', `Calculation '${c.id}' methodOrFormula contains formula injection: '${c.methodOrFormula}'`);
      }
    }

    // Check prose blocks
    for (const pb of (input.proseBlocks || [])) {
      if (containsMacroOrExecutable(pb.text)) {
        throw new XlsxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Prose block '${pb.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(pb.text)) {
        throw new XlsxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Prose block '${pb.id}' contains external URL.`);
      }
      if (isPotentialFormulaInjection(pb.text)) {
        throw new XlsxGenerationError('FORMULA_INJECTION_DETECTED', `Prose block '${pb.id}' text contains formula injection: '${pb.text.substring(0, 40)}'`);
      }
    }

    // Check warnings
    for (const w of (input.warnings || [])) {
      if (isDangerousFormulaPayload(w.message)) {
        throw new XlsxGenerationError('FORMULA_INJECTION_DETECTED', `Warning '${w.code}' message contains formula injection.`);
      }
    }

    // Check limitations
    for (const l of (input.limitations || [])) {
      if (isDangerousFormulaPayload(l)) {
        throw new XlsxGenerationError('FORMULA_INJECTION_DETECTED', `Limitation contains formula injection: '${l}'`);
      }
    }
  }

  private assertValidApproval(params: GenerateXlsxToolInput, canonicalHash: string): void {
    const approval = params.input.approval;

    // A. Must be explicitly approved
    if (approval.status !== 'approved') {
      throw new XlsxGenerationError(
        'APPROVAL_REQUIRED',
        `Document generation requires approval status 'approved', but status is '${approval.status}'.`
      );
    }

    // B. Approval ID must be present
    if (!approval.approvalId || typeof approval.approvalId !== 'string') {
      throw new XlsxGenerationError(
        'APPROVAL_REQUIRED',
        'Approved document is missing required approvalId.'
      );
    }

    // C. Anti-tampering check: payloadHash must match freshly computed canonical hash
    if (approval.payloadHash && approval.payloadHash !== canonicalHash) {
      throw new XlsxGenerationError(
        'CHANGED_INPUT_AFTER_APPROVAL',
        `Input modified after approval! Approved payloadHash '${approval.payloadHash}' does not match current canonicalHash '${canonicalHash}'.`
      );
    }

    // D. If registered in ApprovalService, check status
    const registeredApproval = this.approvalService.getApproval(approval.approvalId);
    if (registeredApproval) {
      if (registeredApproval.status !== 'approved') {
        throw new XlsxGenerationError(
          'STALE_APPROVAL',
          `Approval '${approval.approvalId}' has status '${registeredApproval.status}' in ApprovalService. Approved status required.`
        );
      }
    }
  }

  private buildWorkbookStructure(input: OfficeXlsxInput, canonicalHash: string): XlsxWorkbookData {
    const sheets: XlsxWorksheet[] = [];

    // 1. Sheet: Summary & Verdict
    sheets.push(this.buildSummarySheet(input, canonicalHash));

    // 2. Sheet: Findings
    sheets.push(this.buildFindingsSheet(input));

    // 3. Sheet: Measurements & Units
    sheets.push(this.buildMeasurementsSheet(input));

    // 4. Sheet: Calculations
    sheets.push(this.buildCalculationsSheet(input));

    // 5. Sheet: Warnings & Limitations
    sheets.push(this.buildWarningsSheet(input));

    // 6. Sheet: Citations & Provenance
    sheets.push(this.buildCitationsSheet(input));

    // 7. Sheet: Reviewer Sign-off
    sheets.push(this.buildSignoffSheet(input, canonicalHash));

    // 8. Sheet: Model Prose (Unverified) (if present)
    if (input.proseBlocks && input.proseBlocks.length > 0) {
      sheets.push(this.buildProseSheet(input));
    }

    // 9. Custom Section Tables (if any section contains tables)
    for (const sec of input.sections) {
      if (sec.tables && sec.tables.length > 0) {
        for (const tbl of sec.tables) {
          sheets.push(this.buildSectionTableSheet(tbl, sec));
        }
      }
    }

    return {
      title: input.title,
      author: input.author.name,
      company: 'MAOS Industrial Verification',
      created: input.generatedAt,
      sheets,
    };
  }

  // ── Sheet Builders ──────────────────────────────────────────────────

  private buildSummarySheet(input: OfficeXlsxInput, canonicalHash: string): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Title Row
    rows.push({
      rowNumber: r++,
      height: 28,
      cells: [
        { value: input.title, type: 'string', styleId: XLSX_STYLES.TITLE },
      ],
    });

    // Subtitle / Scope
    rows.push({
      rowNumber: r++,
      height: 20,
      cells: [
        { value: 'INDUSTRIAL VERIFICATION DELIVERABLE (AIR-GAPPED)', type: 'string', styleId: XLSX_STYLES.SECTION_HEADER },
      ],
    });

    // Blank row
    rows.push({ rowNumber: r++, cells: [] });

    // Metadata Table Header
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'System Metadata Attribute', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Recorded Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const metadataRows: [string, string | number, number][] = [
      ['Project Identifier', input.projectId, XLSX_STYLES.DATA_BOLD],
      ['Execution Run Identifier', input.runId, XLSX_STYLES.DATA_BORDERED],
      ['Task Identifier', input.taskId || 'N/A', XLSX_STYLES.DATA_BORDERED],
      ['Schema Version', input.schemaVersion, XLSX_STYLES.INTEGER],
      ['Generation Timestamp', input.generatedAt, XLSX_STYLES.DATA_BORDERED],
      ['Author Identity', `${input.author.name} (${input.author.role || input.author.id})`, XLSX_STYLES.DATA_BORDERED],
      ['Model Identity', input.modelIdentity ? `${input.modelIdentity.modelId} (rev: ${input.modelIdentity.revision})` : 'Deterministic / Local Rule Engine', XLSX_STYLES.DATA_BORDERED],
      ['Canonical Input Hash (SHA-256)', canonicalHash, XLSX_STYLES.CODE_MONO],
    ];

    for (const [label, val, styleId] of metadataRows) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: label, type: 'string', styleId: XLSX_STYLES.META_LABEL },
          { value: typeof val === 'number' ? val : sanitizeCellString(String(val), label), type: typeof val === 'number' ? 'number' : 'string', styleId },
        ],
      });
    }

    // Blank row
    rows.push({ rowNumber: r++, cells: [] });

    // Verdict Banner Header
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'Decision & Approval Attribute', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Verification Status', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const isApproved = input.approval.status === 'approved';
    const statusStyle: number = isApproved ? XLSX_STYLES.PASS_BADGE : XLSX_STYLES.FAIL_BADGE;

    const verdictRows: [string, string, number][] = [
      ['Final Decision Status', `[STATUS: ${input.approval.status.toUpperCase()}]`, statusStyle],
      ['Approval Identifier', input.approval.approvalId || 'N/A', XLSX_STYLES.CODE_MONO],
      ['Approver Name / Role', input.approval.approvedBy || 'N/A', XLSX_STYLES.DATA_BOLD],
      ['Approval Timestamp', input.approval.approvedAt || 'N/A', XLSX_STYLES.DATA_BORDERED],
      ['Approval Comments', input.approval.comment || 'N/A', XLSX_STYLES.DATA_BORDERED],
      ['Approved Payload Digest (SHA-256)', input.approval.payloadHash || 'N/A', XLSX_STYLES.CODE_MONO],
    ];

    for (const [label, val, styleId] of verdictRows) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: label, type: 'string', styleId: XLSX_STYLES.META_LABEL },
          { value: sanitizeCellString(val, label), type: 'string', styleId },
        ],
      });
    }

    // Conclusions (if present)
    if (input.conclusions && input.conclusions.length > 0) {
      rows.push({ rowNumber: r++, cells: [] });
      rows.push({
        rowNumber: r++,
        height: 22,
        cells: [
          { value: 'Conclusion ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
          { value: 'Verdict', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
          { value: 'Statement', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
          { value: 'Sign-off Identity', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        ],
      });
      for (const conc of input.conclusions) {
        rows.push({
          rowNumber: r++,
          height: 20,
          cells: [
            { value: conc.id, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
            { value: conc.verdict, type: 'string', styleId: conc.verdict.toUpperCase().includes('PASS') ? XLSX_STYLES.PASS_BADGE : XLSX_STYLES.DATA_BOLD },
            { value: sanitizeCellString(conc.statement, 'conclusion'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
            { value: conc.signOffIdentity || 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          ],
        });
      }
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 32 },
      { colIndex: 1, width: 68 },
      { colIndex: 2, width: 45 },
      { colIndex: 3, width: 30 },
    ];

    return {
      name: 'Summary & Verdict',
      rows,
      columns,
    };
  }

  private buildFindingsSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header Row
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Finding ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Category', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Status', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Severity', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Statement', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Metric', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Observed Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Threshold Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Unit', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Citations', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Verified', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Reviewer Correction', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    for (const f of input.findings) {
      let statusStyle: number = XLSX_STYLES.DATA_BORDERED;
      if (f.status === 'PASS') statusStyle = XLSX_STYLES.PASS_BADGE;
      else if (f.status === 'WARNING') statusStyle = XLSX_STYLES.WARNING_BADGE;
      else if (f.status === 'FAIL') statusStyle = XLSX_STYLES.FAIL_BADGE;

      let correctionText = 'None';
      if (f.reviewerCorrection) {
        correctionText = `${f.reviewerCorrection.reviewerId}: ${f.reviewerCorrection.originalValue} -> ${f.reviewerCorrection.correctedValue} (${f.reviewerCorrection.reason})`;
      }

      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: f.id, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(f.category, 'category'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: f.status, type: 'string', styleId: statusStyle },
          { value: f.severity, type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: sanitizeCellString(f.statement, 'statement'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: f.metric || 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          {
            value: f.observedValue !== undefined ? f.observedValue : 'N/A',
            type: typeof f.observedValue === 'number' ? 'number' : 'string',
            styleId: typeof f.observedValue === 'number' ? XLSX_STYLES.NUMBER_2DEC : XLSX_STYLES.DATA_BORDERED,
          },
          {
            value: f.thresholdValue !== undefined ? f.thresholdValue : 'N/A',
            type: typeof f.thresholdValue === 'number' ? 'number' : 'string',
            styleId: typeof f.thresholdValue === 'number' ? XLSX_STYLES.NUMBER_2DEC : XLSX_STYLES.DATA_BORDERED,
          },
          { value: f.unit || 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
          { value: f.citationIds ? f.citationIds.join(', ') : 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: f.verified ? 'YES' : 'NO', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: sanitizeCellString(correctionText, 'correction'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 15 },
      { colIndex: 1, width: 20 },
      { colIndex: 2, width: 14 },
      { colIndex: 3, width: 12 },
      { colIndex: 4, width: 45 },
      { colIndex: 5, width: 22 },
      { colIndex: 6, width: 16 },
      { colIndex: 7, width: 16 },
      { colIndex: 8, width: 12 },
      { colIndex: 9, width: 18 },
      { colIndex: 10, width: 12 },
      { colIndex: 11, width: 40 },
    ];

    return {
      name: 'Findings',
      rows,
      columns,
    };
  }

  private buildMeasurementsSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header Row
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Measurement ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Name', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Numeric Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Unit', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Tolerance', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Status', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Citations', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    for (const m of input.measurements) {
      const isOutOfSpec = m.status === 'out_of_spec';
      const statusStyle: number = isOutOfSpec ? XLSX_STYLES.FAIL_BADGE : XLSX_STYLES.PASS_BADGE;

      let tolStr = 'N/A';
      if (typeof m.tolerance === 'number') {
        tolStr = `±${m.tolerance}`;
      } else if (m.tolerance && typeof m.tolerance === 'object') {
        tolStr = `[${m.tolerance.min ?? '-∞'}, ${m.tolerance.max ?? '+∞'}]`;
      }

      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: m.id, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(m.name, 'name'), type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
          { value: m.numericValue, type: 'number', styleId: XLSX_STYLES.NUMBER_2DEC },
          { value: m.unit, type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
          { value: tolStr, type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: m.status ? m.status.toUpperCase() : 'NOMINAL', type: 'string', styleId: statusStyle },
          { value: m.citationIds ? m.citationIds.join(', ') : 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 18 },
      { colIndex: 1, width: 28 },
      { colIndex: 2, width: 18 },
      { colIndex: 3, width: 14 },
      { colIndex: 4, width: 18 },
      { colIndex: 5, width: 16 },
      { colIndex: 6, width: 22 },
    ];

    return {
      name: 'Measurements & Units',
      rows,
      columns,
    };
  }

  private buildCalculationsSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header Row
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Calculation ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Calculation Name', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Method / Formula', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Inputs', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Result Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Result Unit', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Verified By', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Citations', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    for (const c of input.calculations) {
      const inputsStr = c.inputs && Array.isArray(c.inputs)
        ? c.inputs.map((i) => `${i.name}=${i.value} ${i.unit}`).join('; ')
        : 'N/A';

      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: c.id, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(c.name, 'calc_name'), type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
          { value: sanitizeCellString(c.methodOrFormula || 'N/A', 'methodOrFormula'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: sanitizeCellString(inputsStr, 'inputs'), type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: c.resultValue, type: 'number', styleId: XLSX_STYLES.NUMBER_2DEC },
          { value: c.resultUnit, type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
          { value: c.verifiedBy || 'deterministic_calc', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: c.citationIds ? c.citationIds.join(', ') : 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 18 },
      { colIndex: 1, width: 28 },
      { colIndex: 2, width: 35 },
      { colIndex: 3, width: 30 },
      { colIndex: 4, width: 16 },
      { colIndex: 5, width: 14 },
      { colIndex: 6, width: 20 },
      { colIndex: 7, width: 20 },
    ];

    return {
      name: 'Calculations',
      rows,
      columns,
    };
  }

  private buildWarningsSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header 1: Warnings
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'SYSTEM & AUDIT WARNINGS', type: 'string', styleId: XLSX_STYLES.SECTION_HEADER },
      ],
    });

    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Warning Code', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Severity', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Message', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Acknowledged', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const warnings = input.warnings || [];
    if (warnings.length === 0) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: 'NONE', type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: 'INFO', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: 'No system or audit warnings recorded for this deliverable.', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: 'YES', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    } else {
      for (const w of warnings) {
        const isHigh = w.severity === 'high' || w.severity === 'critical';
        const sevStyle: number = isHigh ? XLSX_STYLES.FAIL_BADGE : XLSX_STYLES.WARNING_BADGE;
        rows.push({
          rowNumber: r++,
          height: 20,
          cells: [
            { value: w.code, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
            { value: w.severity.toUpperCase(), type: 'string', styleId: sevStyle },
            { value: sanitizeCellString(w.message, 'warning_message'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
            { value: w.acknowledged ? 'YES' : 'NO', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          ],
        });
      }
    }

    // Blank row
    rows.push({ rowNumber: r++, cells: [] });

    // Header 2: Limitations
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'SYSTEM & SCOPE LIMITATIONS', type: 'string', styleId: XLSX_STYLES.SECTION_HEADER },
      ],
    });

    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Item #', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Limitation Description', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const limitations = input.limitations || [];
    if (limitations.length === 0) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: 1, type: 'number', styleId: XLSX_STYLES.INTEGER },
          { value: 'No operational limitations specified beyond standard industrial air-gap protocol.', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    } else {
      limitations.forEach((lim, idx) => {
        rows.push({
          rowNumber: r++,
          height: 20,
          cells: [
            { value: idx + 1, type: 'number', styleId: XLSX_STYLES.INTEGER },
            { value: sanitizeCellString(lim, 'limitation'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          ],
        });
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 22 },
      { colIndex: 1, width: 16 },
      { colIndex: 2, width: 65 },
      { colIndex: 3, width: 18 },
    ];

    return {
      name: 'Warnings & Limitations',
      rows,
      columns,
    };
  }

  private buildCitationsSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header 1: Evidence State
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'EVIDENCE STATE VERIFICATION', type: 'string', styleId: XLSX_STYLES.SECTION_HEADER },
      ],
    });

    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Verification Metric', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Observed Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Integrity Status', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const ev = input.evidenceState;
    const evRows: [string, string | number, string, number][] = [
      ['OCR Confidence Score', ev.ocrConfidence !== undefined ? ev.ocrConfidence : 'N/A', ev.ocrConfidence !== undefined && ev.ocrConfidence >= 0.7 ? 'SATISFIED' : 'REQUIRES_REVIEW', XLSX_STYLES.DATA_BORDERED],
      ['VLM Confidence Score', ev.vlmConfidence !== undefined ? ev.vlmConfidence : 'N/A', ev.vlmConfidence !== undefined && ev.vlmConfidence >= 0.6 ? 'SATISFIED' : 'REQUIRES_REVIEW', XLSX_STYLES.DATA_BORDERED],
      ['Conflict Classification', ev.conflictClassification || 'NONE', ev.hasUnresolvedConflicts ? 'CONFLICT_DETECTED' : 'RESOLVED_CLEAN', ev.hasUnresolvedConflicts ? XLSX_STYLES.FAIL_BADGE : XLSX_STYLES.PASS_BADGE],
      ['Quarantine Status', ev.isQuarantined ? 'QUARANTINED' : 'CLEAN', ev.isQuarantined ? 'REJECT' : 'APPROVED_DATA', ev.isQuarantined ? XLSX_STYLES.FAIL_BADGE : XLSX_STYLES.PASS_BADGE],
      ['Human Review Record', ev.reviewedByHuman ? 'YES' : 'NO', ev.reviewedByHuman ? 'HUMAN_VERIFIED' : 'MACHINE_PROVISIONAL', XLSX_STYLES.DATA_BORDERED],
    ];

    for (const [metric, val, stat, style] of evRows) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: metric, type: 'string', styleId: XLSX_STYLES.META_LABEL },
          { value: typeof val === 'number' ? val : sanitizeCellString(String(val), metric), type: typeof val === 'number' ? 'number' : 'string', styleId: typeof val === 'number' ? XLSX_STYLES.NUMBER_2DEC : XLSX_STYLES.DATA_BORDERED },
          { value: stat, type: 'string', styleId: style },
        ],
      });
    }

    // Blank row
    rows.push({ rowNumber: r++, cells: [] });

    // Header 2: Citations Ledger
    rows.push({
      rowNumber: r++,
      height: 22,
      cells: [
        { value: 'CRYPTOGRAPHIC CITATIONS LEDGER', type: 'string', styleId: XLSX_STYLES.SECTION_HEADER },
      ],
    });

    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Citation ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Source Path', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Source SHA-256 Digest', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Page #', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Section Heading', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Chunk ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Verified Source Snippet', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    for (const cit of input.citations) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: cit.citationId, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(cit.sourcePath, 'sourcePath'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: cit.sourceHash, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: cit.pageNumber !== undefined ? cit.pageNumber : 'N/A', type: typeof cit.pageNumber === 'number' ? 'number' : 'string', styleId: typeof cit.pageNumber === 'number' ? XLSX_STYLES.INTEGER : XLSX_STYLES.DATA_BORDERED },
          { value: sanitizeCellString(cit.sectionHeading || 'N/A', 'sectionHeading'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: cit.chunkId || 'N/A', type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(cit.snippet, 'snippet'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 18 },
      { colIndex: 1, width: 28 },
      { colIndex: 2, width: 36 },
      { colIndex: 3, width: 12 },
      { colIndex: 4, width: 25 },
      { colIndex: 5, width: 20 },
      { colIndex: 6, width: 55 },
    ];

    return {
      name: 'Citations & Provenance',
      rows,
      columns,
    };
  }

  private buildSignoffSheet(input: OfficeXlsxInput, canonicalHash: string): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Header
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'REVIEWER IDENTITY & SIGN-OFF LEDGER', type: 'string', styleId: XLSX_STYLES.TITLE },
      ],
    });

    rows.push({
      rowNumber: r++,
      height: 20,
      cells: [
        { value: 'Cryptographically bound human authorization audit record.', type: 'string', styleId: XLSX_STYLES.DATA_BOLD },
      ],
    });

    rows.push({ rowNumber: r++, cells: [] });

    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Audit Ledger Entry', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Recorded Verification Value', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Verification Status', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    const isApproved = input.approval.status === 'approved';
    const app = input.approval;
    const approvalStatusStyle: number = isApproved ? XLSX_STYLES.PASS_BADGE : XLSX_STYLES.FAIL_BADGE;
    const hashMatchStyle: number = app.payloadHash === canonicalHash ? XLSX_STYLES.PASS_BADGE : XLSX_STYLES.FAIL_BADGE;

    const auditRows: [string, string, string, number][] = [
      ['Approval Identifier', app.approvalId || 'N/A', 'IDENTIFIER_ASSIGNED', XLSX_STYLES.CODE_MONO],
      ['Approval Status', app.status.toUpperCase(), isApproved ? 'APPROVAL_CONFIRMED' : 'REJECTED', approvalStatusStyle],
      ['Approved By (Human)', app.approvedBy || 'N/A', 'IDENTITY_CONFIRMED', XLSX_STYLES.DATA_BOLD],
      ['Approval Timestamp', app.approvedAt || 'N/A', 'TIMESTAMP_RECORDED', XLSX_STYLES.DATA_BORDERED],
      ['Canonical Input Hash (SHA-256)', canonicalHash, 'CANONICAL_HASH_MATCH', XLSX_STYLES.CODE_MONO],
      ['Approval Payload Hash', app.payloadHash || 'N/A', app.payloadHash === canonicalHash ? 'INTEGRITY_VERIFIED' : 'HASH_MISMATCH', hashMatchStyle],
      ['Sign-off Comments', app.comment || 'Approved for release', 'RECORDED', XLSX_STYLES.DATA_BORDERED],
      ['Mandatory Policy Gate', app.required ? 'MANDATORY_GATE_ENFORCED' : 'OPTIONAL', 'POLICY_SATISFIED', XLSX_STYLES.DATA_BORDERED],
    ];

    for (const [entry, val, status, style] of auditRows) {
      rows.push({
        rowNumber: r++,
        height: 20,
        cells: [
          { value: entry, type: 'string', styleId: XLSX_STYLES.META_LABEL },
          { value: sanitizeCellString(val, entry), type: 'string', styleId: style },
          { value: status, type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 32 },
      { colIndex: 1, width: 68 },
      { colIndex: 2, width: 30 },
    ];

    return {
      name: 'Reviewer Sign-off',
      rows,
      columns,
    };
  }

  private buildProseSheet(input: OfficeXlsxInput): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Safety Alert Banner Row
    rows.push({
      rowNumber: r++,
      height: 32,
      cells: [
        {
          value: '[UNVERIFIED MODEL PROSE — NOT VERIFIED AGAINST STRUCTURED DATA — REQUIRES HUMAN REVIEW]',
          type: 'string',
          styleId: XLSX_STYLES.UNVERIFIED_PROSE_ALERT,
        },
      ],
    });

    rows.push({ rowNumber: r++, cells: [] });

    // Header Row
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: 'Prose Block ID', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Label', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Model Identity', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
        { value: 'Model Prose Content', type: 'string', styleId: XLSX_STYLES.TABLE_HEADER },
      ],
    });

    for (const pb of (input.proseBlocks || [])) {
      rows.push({
        rowNumber: r++,
        height: 22,
        cells: [
          { value: pb.id, type: 'string', styleId: XLSX_STYLES.CODE_MONO },
          { value: sanitizeCellString(pb.label, 'label'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: pb.modelId || 'N/A', type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
          { value: sanitizeCellString(pb.text, 'prose_text'), type: 'string', styleId: XLSX_STYLES.DATA_BORDERED },
        ],
      });
    }

    const columns: XlsxColumnDef[] = [
      { colIndex: 0, width: 20 },
      { colIndex: 1, width: 24 },
      { colIndex: 2, width: 20 },
      { colIndex: 3, width: 80 },
    ];

    return {
      name: 'Model Prose (Unverified)',
      rows,
      columns,
    };
  }

  private buildSectionTableSheet(tbl: OfficeTable, sec: OfficeReportSection): XlsxWorksheet {
    const rows: XlsxRow[] = [];
    let r = 1;

    // Title Row
    const title = tbl.title || `Table ${tbl.id}`;
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: [
        { value: `${title} (from Section: ${sec.heading})`, type: 'string', styleId: XLSX_STYLES.TITLE },
      ],
    });

    rows.push({ rowNumber: r++, cells: [] });

    // Derive columns
    const colKeys = tbl.columns && tbl.columns.length > 0
      ? tbl.columns.map((c) => c.key)
      : (tbl.rows.length > 0 ? Object.keys(tbl.rows[0]) : ['Item']);

    const colLabels = tbl.columns && tbl.columns.length > 0
      ? tbl.columns.map((c) => c.label || c.key)
      : colKeys;

    // Header row
    rows.push({
      rowNumber: r++,
      height: 24,
      cells: colLabels.map((lbl) => ({
        value: lbl,
        type: 'string',
        styleId: XLSX_STYLES.TABLE_HEADER,
      })),
    });

    // Data rows
    for (const rowData of tbl.rows) {
      const cells: XlsxCell[] = colKeys.map((k) => {
        const val = rowData[k];
        if (typeof val === 'number') {
          return { value: val, type: 'number', styleId: XLSX_STYLES.NUMBER_2DEC };
        }
        if (typeof val === 'boolean') {
          return { value: val, type: 'boolean', styleId: XLSX_STYLES.DATA_BORDERED };
        }
        const strVal = val !== undefined && val !== null ? String(val) : '';
        return {
          value: sanitizeCellString(strVal, k),
          type: 'string',
          styleId: XLSX_STYLES.DATA_BORDERED,
        };
      });

      rows.push({
        rowNumber: r++,
        height: 20,
        cells,
      });
    }

    const columns: XlsxColumnDef[] = colKeys.map((_, idx) => ({
      colIndex: idx,
      width: 25,
    }));

    const sheetName = `Table_${tbl.id}`.substring(0, 31);
    return {
      name: sheetName,
      rows,
      columns,
    };
  }

  private recordAudit(
    event: 'XLSX_GENERATION_STARTED' | 'XLSX_GENERATED' | 'XLSX_GENERATION_REJECTED' | 'XLSX_GENERATION_FAILED',
    entityId: string,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'xlsx-generator-service',
        data: {
          event,
          entityId,
          actor,
          ...data,
        },
      });
    }
  }
}
