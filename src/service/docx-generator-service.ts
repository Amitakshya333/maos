/**
 * MAOS Industrial — DOCX Generator Service (F6-02)
 *
 * Generates verified, editable, air-gapped OOXML (.docx) approval notes from
 * validated OfficeDocxInput contracts without external dependencies, LibreOffice,
 * Microsoft Word automation, or shell commands.
 *
 * Enforces:
 * 1. Strict validation of OfficeDocxInput schema, bounds, and provenance.
 * 2. Mandatory approval verification, rejecting missing, stale, or tampered approvals.
 * 3. Exact freshness verification against local disk files and source hashes.
 * 4. Sanitization and fail-closed rejection of macros, external relationships, and scripts.
 * 5. Deterministic, collision-resistant output finalization through ArtifactService.
 * 6. Durable idempotency with replay cache and conflict detection.
 * 7. Privacy-safe audit trail (recording hashes, identifiers, and metadata; zero raw prose).
 * 8. Post-generation OOXML ZIP and XML well-formedness verification.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  OfficeDocxInput,
  OfficeFinding,
  OfficeMeasurement,
  OfficeCalculation,
  OfficeWarning,
  OfficeCitation,
  OfficeReportSection,
  OfficeProseBlock,
  OfficeConclusion,
  OFFICE_INPUT_BOUNDS,
  DocxGenerationError,
  GenerateDocxToolInput,
  GenerateDocxToolResult,
  validateOfficeArtifactInput,
  computeOfficeInputHash,
  containsMacroOrExecutable,
  containsExternalRelationship,
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
  buildZipArchive,
  validateDocxPackage,
  ZipFileInput,
} from '../industrial/office/ooxml-packager';

// ── XML Sanitization & Helpers ──────────────────────────────────────

function escapeXml(str: unknown): string {
  if (str === null || str === undefined) return '';
  const text = String(str);
  // Strip control characters except \t, \n, \r
  const sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlPara(text: string, style?: string, isBold?: boolean, colorHex?: string): string {
  const pPrParts: string[] = [];
  if (style) {
    pPrParts.push(`<w:pStyle w:val="${style}"/>`);
  }
  const pPr = pPrParts.length > 0 ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';

  const rPrParts: string[] = [];
  if (isBold) rPrParts.push('<w:b/>');
  if (colorHex) rPrParts.push(`<w:color w:val="${colorHex}"/>`);
  const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';

  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function xmlHeading(text: string, level: 1 | 2 | 3): string {
  const style = `Heading${level}`;
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function xmlTableCell(contentXml: string, isHeader = false, bgColorHex?: string): string {
  const tcPrParts: string[] = [];
  if (bgColorHex) {
    tcPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${bgColorHex}"/>`);
  }
  const tcPr = tcPrParts.length > 0 ? `<w:tcPr>${tcPrParts.join('')}</w:tcPr>` : '';
  return `<w:tc>${tcPr}${contentXml}</w:tc>`;
}

function xmlTableRow(cells: string[]): string {
  return `<w:tr>${cells.join('')}</w:tr>`;
}

function xmlTable(rows: string[]): string {
  return `
<w:tbl>
  <w:tblPr>
    <w:tblStyle w:val="TableGrid"/>
    <w:tblW w:w="5000" w:type="pct"/>
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="D3D3D3"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="D3D3D3"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="D3D3D3"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="D3D3D3"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E5E5"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E5E5E5"/>
    </w:tblBorders>
  </w:tblPr>
  ${rows.join('\n')}
</w:tbl>`;
}

// ── Service Implementation ──────────────────────────────────────────

export class DocxGeneratorService {
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
   * Generates a safe, verified .docx approval note from validated OfficeDocxInput.
   */
  generateDocx(params: GenerateDocxToolInput & {
    callerIdentity?: { agentId?: string; taskId?: string };
  }): GenerateDocxToolResult {
    // 0. Template Safety validation (if templatePath provided)
    const templatePath =
      params.templatePath ||
      (params.input as any)?.templatePath ||
      (params.input as any)?.docxOptions?.templatePath;

    if (templatePath) {
      try {
        this.templateSafetyService.assertTemplateSafety(templatePath, 'docx', {
          runId: params.input?.runId || 'unknown',
          actor: params.callerIdentity?.agentId || 'docx_generator',
        });
      } catch (err: any) {
        if (err instanceof TemplateSafetyError) {
          throw new DocxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
        }
        throw err;
      }
    }

    // 1. Schema version validation
    if (params.schemaVersion !== 1) {
      throw new DocxGenerationError(
        'INVALID_INPUT',
        `Unsupported schemaVersion ${params.schemaVersion}. Expected schemaVersion 1.`,
      );
    }

    // 2. Validate input is defined
    if (!params.input || typeof params.input !== 'object') {
      throw new DocxGenerationError('INVALID_INPUT', 'Missing required input object.');
    }

    // 3. Project confinement & cross-project verification
    if (!params.projectId || typeof params.projectId !== 'string') {
      throw new DocxGenerationError('INVALID_INPUT', 'Missing required projectId parameter.');
    }
    if (params.input.projectId !== params.projectId) {
      this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'CROSS_PROJECT_FORBIDDEN',
        inputProjectId: params.input.projectId,
        requestProjectId: params.projectId,
      });
      throw new DocxGenerationError(
        'CROSS_PROJECT_FORBIDDEN',
        `Input projectId '${params.input.projectId}' does not match requested projectId '${params.projectId}'.`,
      );
    }

    // 4. Output path validation & containment
    if (!params.outputPath || typeof params.outputPath !== 'string') {
      throw new DocxGenerationError('INVALID_INPUT', 'Missing required outputPath parameter.');
    }
    if (!isSafeIndustrialPath(params.outputPath)) {
      throw new DocxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${params.outputPath}' violates safe path constraints (traversal, absolute, or invalid characters detected).`,
      );
    }
    const normalizedRelPath = params.outputPath.replace(/\\/g, '/');
    if (!normalizedRelPath.toLowerCase().endsWith('.docx')) {
      throw new DocxGenerationError(
        'INVALID_INPUT',
        `Output path '${params.outputPath}' must have a .docx extension.`,
      );
    }

    // 5. OfficeDocxInput domain validation (F6-01 pure validator)
    const validation = validateOfficeArtifactInput(params.input);
    if (!validation.valid) {
      this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'INVALID_INPUT',
        errors: validation.errors,
      });
      throw new DocxGenerationError(
        'INVALID_INPUT',
        `OfficeDocxInput validation failed: ${validation.errors.join('; ')}`,
      );
    }

    if (params.input.artifactType !== 'docx') {
      throw new DocxGenerationError(
        'INVALID_INPUT',
        `Invalid artifactType '${params.input.artifactType}'. Expected 'docx'.`,
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
        throw new DocxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
      }
      throw err;
    }

    // 9. Dynamic Freshness & Provenance Verification
    const freshness = this.officeInputService.verifyFreshnessSync(params.input);
    if (!freshness.fresh) {
      this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'STALE_SOURCE_HASH',
        inputHash: canonicalHash,
        errors: freshness.errors,
      });

      // Map specific freshness failures to standard error codes
      const joined = freshness.errors.join('; ');
      if (joined.includes('UNRESOLVED_CONFLICT') || joined.includes('conflict')) {
        throw new DocxGenerationError('UNRESOLVED_CONFLICT', joined);
      }
      if (joined.includes('QUARANTINED') || joined.includes('quarantined')) {
        throw new DocxGenerationError('QUARANTINED_EVIDENCE', joined);
      }
      if (joined.includes('LOW_CONFIDENCE') || joined.includes('confidence')) {
        throw new DocxGenerationError('LOW_CONFIDENCE_UNREVIEWED', joined);
      }
      throw new DocxGenerationError('STALE_SOURCE_HASH', joined);
    }

    // 10. Durable Idempotency Claim
    const requestId = params.requestId;
    if (!requestId || typeof requestId !== 'string') {
      throw new DocxGenerationError('INVALID_INPUT', 'Missing required requestId for idempotency.');
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
      operation: 'generate_docx',
      projectId: params.projectId,
      authContext: params.callerIdentity?.agentId,
    });

    if (claimOutcome.outcome === 'replay') {
      return {
        ...(claimOutcome.record.responsePayload as GenerateDocxToolResult),
        cached: true,
      };
    }
    if (claimOutcome.outcome === 'conflict') {
      throw new DocxGenerationError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'in_progress') {
      throw new DocxGenerationError('CONCURRENT_MUTATION', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'auth_mismatch') {
      throw new DocxGenerationError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
    }

    // 11. Collision & Overwrite verification
    const destAbsPath = path.resolve(this.projectRoot, normalizedRelPath);
    if (fs.existsSync(destAbsPath)) {
      if (!params.allowOverwrite) {
        this.idempotencyStore.fail(requestId, 'Destination file already exists (collision).');
        throw new DocxGenerationError(
          'ARTIFACT_COLLISION',
          `Destination path '${normalizedRelPath}' already exists. Overwriting requires allowOverwrite: true and approved approval.`,
        );
      }
      // Overwrite is requested; ensure explicit approval
      const effectiveApprovalId = params.approvalId || params.input.approval.approvalId;
      if (!effectiveApprovalId) {
        this.idempotencyStore.fail(requestId, 'Overwrite requires approvalId.');
        throw new DocxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          'Overwriting an existing document requires an explicit approvalId.',
        );
      }
      const appRecord = this.approvalService.getApproval(effectiveApprovalId);
      if (appRecord && appRecord.status !== 'approved') {
        this.idempotencyStore.fail(requestId, 'Approval status for overwrite is not approved.');
        throw new DocxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          `Approval '${effectiveApprovalId}' has status '${appRecord.status}'. Overwrite denied.`,
        );
      }
    }

    // 12. Audit Event: DOCX_GENERATION_STARTED (Privacy-safe: no raw text)
    this.recordAudit('DOCX_GENERATION_STARTED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
      projectId: params.projectId,
      inputHash: canonicalHash,
      outputPath: normalizedRelPath,
      findingsCount: params.input.findings.length,
      measurementsCount: params.input.measurements.length,
      citationsCount: params.input.citations.length,
      approvalId: params.input.approval.approvalId,
    });

    let zipBuffer: Buffer;
    try {
      // 13. Build OOXML document package
      zipBuffer = this.buildDocxPackage(params.input, canonicalHash);
    } catch (err: any) {
      this.idempotencyStore.fail(requestId, `Package build error: ${err.message}`);
      this.recordAudit('DOCX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'BUILD_FAILED',
        message: err.message,
        inputHash: canonicalHash,
      });
      throw new DocxGenerationError('GENERATION_FAILED', `Failed to build DOCX package: ${err.message}`);
    }

    // 14. Validate generated DOCX package (reopen and parse offline)
    const packageValidation = validateDocxPackage(zipBuffer);
    if (!packageValidation.valid) {
      const msg = packageValidation.errors.join('; ');
      this.idempotencyStore.fail(requestId, `Validation failed: ${msg}`);
      this.recordAudit('DOCX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'PACKAGE_VALIDATION_FAILED',
        errors: packageValidation.errors,
        inputHash: canonicalHash,
      });
      throw new DocxGenerationError('DOCX_PACKAGE_INVALID', `Generated DOCX package failed offline validation: ${msg}`);
    }

    // 14b. Validate output package safety before finalization (F6-05)
    try {
      this.templateSafetyService.assertOutputSafety(zipBuffer, 'docx', normalizedRelPath, {
        runId: params.input.runId,
        actor: params.callerIdentity?.agentId || 'docx_generator',
      });
    } catch (err: any) {
      const reason = err instanceof TemplateSafetyError ? err.message : String(err.message || err);
      this.idempotencyStore.fail(requestId, `Output safety validation failed: ${reason}`);
      this.recordAudit('DOCX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'OUTPUT_SAFETY_VIOLATION',
        message: reason,
        inputHash: canonicalHash,
      });
      throw new DocxGenerationError('OUTPUT_SAFETY_VIOLATION', `Output package safety verification failed: ${reason}`);
    }

    // 15. Finalize artifact atomically through ArtifactService
    const artifactId = `docx_${crypto.randomBytes(8).toString('hex')}`;
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
          generator: 'MAOS_DOCX_GENERATOR_V1',
          inputCanonicalHash: canonicalHash,
          projectId: params.projectId,
          runId: params.input.runId,
          taskId: params.input.taskId,
          approvalId: params.input.approval.approvalId,
          approvedBy: params.input.approval.approvedBy,
          findingsCount: params.input.findings.length,
          measurementsCount: params.input.measurements.length,
          citationsCount: params.input.citations.length,
          templatePath: templatePath || undefined,
          generatedAt: params.input.generatedAt,
        },
      });
    } catch (err: any) {
      this.idempotencyStore.fail(requestId, `Finalization error: ${err.message}`);
      this.recordAudit('DOCX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'FINALIZATION_FAILED',
        message: err.message,
        inputHash: canonicalHash,
      });
      throw new DocxGenerationError('GENERATION_FAILED', `Failed to finalize artifact: ${err.message}`);
    }

    // 16. Audit Event: DOCX_GENERATED (Privacy-safe: no raw text)
    this.recordAudit('DOCX_GENERATED', finalizedArtifact.id, params.callerIdentity?.agentId || 'docx_generator', {
      artifactId: finalizedArtifact.id,
      artifactHash: finalizedArtifact.hash,
      inputHash: canonicalHash,
      relativePath: normalizedRelPath,
      bytesWritten: finalizedArtifact.size,
      approvalId: params.input.approval.approvalId,
    });

    const result: GenerateDocxToolResult = {
      ok: true,
      artifactId: finalizedArtifact.id,
      relativePath: normalizedRelPath,
      canonicalHash,
      artifactHash: finalizedArtifact.hash,
      bytesWritten: finalizedArtifact.size,
      generatedAt: params.input.generatedAt,
      approvalId: params.input.approval.approvalId,
      cached: false,
    };

    // 17. Complete idempotency claim
    this.idempotencyStore.complete(requestId, 200, result);

    return result;
  }

  /**
   * Asynchronous variant of generateDocx.
   */
  public async generateDocxAsync(params: GenerateDocxToolInput & {
    callerIdentity?: { agentId?: string; taskId?: string };
  }): Promise<GenerateDocxToolResult> {
    return Promise.resolve(this.generateDocx(params));
  }

  // ── Private Validation & Construction Helpers ───────────────────────

  private assertNoForbiddenPayloads(input: OfficeDocxInput): void {
    // Check title
    if (containsMacroOrExecutable(input.title)) {
      throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', 'Title contains macro or executable reference.');
    }
    if (containsExternalRelationship(input.title)) {
      throw new DocxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', 'Title contains external URL/relationship.');
    }

    // Check findings
    for (const f of input.findings) {
      if (containsMacroOrExecutable(f.statement)) {
        throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Finding '${f.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(f.statement)) {
        throw new DocxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Finding '${f.id}' contains external relationship/URL.`);
      }
    }

    // Check measurements
    for (const m of input.measurements) {
      if (containsMacroOrExecutable(m.name)) {
        throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Measurement '${m.id}' contains macro reference.`);
      }
    }

    // Check prose blocks
    for (const pb of (input.proseBlocks || [])) {
      if (containsMacroOrExecutable(pb.text)) {
        throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Prose block '${pb.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(pb.text)) {
        throw new DocxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Prose block '${pb.id}' contains external relationship/URL.`);
      }
    }

    // Check sections
    for (const sec of input.sections) {
      if (sec.content && containsMacroOrExecutable(sec.content)) {
        throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Section '${sec.id}' contains macro reference.`);
      }
      if (sec.content && containsExternalRelationship(sec.content)) {
        throw new DocxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Section '${sec.id}' contains external relationship/URL.`);
      }
      if (sec.unverifiedModelProse && containsMacroOrExecutable(sec.unverifiedModelProse)) {
        throw new DocxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Section '${sec.id}' prose contains macro reference.`);
      }
      if (sec.unverifiedModelProse && containsExternalRelationship(sec.unverifiedModelProse)) {
        throw new DocxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Section '${sec.id}' prose contains external URL.`);
      }
    }
  }

  private recordAudit(
    event: 'DOCX_GENERATION_STARTED' | 'DOCX_GENERATED' | 'DOCX_GENERATION_REJECTED' | 'DOCX_GENERATION_FAILED',
    entityId: string,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'docx-generator-service',
        data: {
          event,
          entityId,
          actor,
          ...data,
        },
      });
    }
  }

  private assertValidApproval(
    params: GenerateDocxToolInput & {
      callerIdentity?: { agentId?: string; taskId?: string };
    },
    canonicalHash: string,
  ): void {
    const approval = params.input.approval;

    // Must be approved
    if (!approval || approval.status !== 'approved') {
      this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'APPROVAL_REQUIRED',
        status: approval?.status || 'missing',
      });
      throw new DocxGenerationError(
        'APPROVAL_REQUIRED',
        `Document generation requires approval status 'approved'. Current status: '${approval?.status || 'missing'}'.`,
      );
    }

    // Must have approval identity
    if (!approval.approvalId || !approval.approvedBy) {
      throw new DocxGenerationError(
        'APPROVAL_REQUIRED',
        'Approval is missing mandatory approvalId or approvedBy field.',
      );
    }

    // If caller provided explicit approvalId, must match
    if (params.approvalId && params.approvalId !== approval.approvalId) {
      throw new DocxGenerationError(
        'INVALID_INPUT',
        `Request approvalId '${params.approvalId}' does not match input approvalId '${approval.approvalId}'.`,
      );
    }

    // Check for changed input after approval (hash tampering / modification)
    if (approval.payloadHash && approval.payloadHash !== canonicalHash) {
      this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
        reason: 'CHANGED_INPUT_AFTER_APPROVAL',
        approvalHash: approval.payloadHash,
        currentInputHash: canonicalHash,
      });
      throw new DocxGenerationError(
        'CHANGED_INPUT_AFTER_APPROVAL',
        `Input has changed after approval. Approved payload hash '${approval.payloadHash}' does not match current hash '${canonicalHash}'.`,
      );
    }

    // If input had a stated canonicalHash, check it
    if (params.input.canonicalHash && params.input.canonicalHash !== canonicalHash) {
      throw new DocxGenerationError(
        'CHANGED_INPUT_AFTER_APPROVAL',
        `Input stated canonicalHash '${params.input.canonicalHash}' does not match computed canonical hash '${canonicalHash}'.`,
      );
    }

    // Check approval service status if registered
    const appRecord = this.approvalService.getApproval(approval.approvalId);
    if (appRecord) {
      if (appRecord.status !== 'approved') {
        this.recordAudit('DOCX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'docx_generator', {
          reason: 'STALE_APPROVAL',
          approvalId: approval.approvalId,
          status: appRecord.status,
        });
        throw new DocxGenerationError(
          'STALE_APPROVAL',
          `Approval '${approval.approvalId}' is stale or revoked (status in store: '${appRecord.status}').`,
        );
      }
    }
  }

  // ── OOXML Package Builder ──────────────────────────────────────────

  private buildDocxPackage(input: OfficeDocxInput, canonicalHash: string): Buffer {
    const files: ZipFileInput[] = [
      {
        path: '[Content_Types].xml',
        data: this.buildContentTypesXml(),
      },
      {
        path: '_rels/.rels',
        data: this.buildRootRelsXml(),
      },
      {
        path: 'word/_rels/document.xml.rels',
        data: this.buildDocumentRelsXml(),
      },
      {
        path: 'word/styles.xml',
        data: this.buildStylesXml(),
      },
      {
        path: 'docProps/core.xml',
        data: this.buildCorePropsXml(input),
      },
      {
        path: 'docProps/app.xml',
        data: this.buildAppPropsXml(input),
      },
      {
        path: 'word/document.xml',
        data: this.buildDocumentXml(input, canonicalHash),
      },
    ];

    return buildZipArchive(files);
  }

  private buildContentTypesXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }

  private buildRootRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  private buildDocumentRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  private buildCorePropsXml(input: OfficeDocxInput): string {
    const now = input.generatedAt || new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(input.title)}</dc:title>
  <dc:creator>${escapeXml(input.author?.name || 'MAOS Industrial Agent')}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(input.approval.approvedBy || input.author?.name || 'MAOS')}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(now)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(now)}</dcterms:modified>
</cp:coreProperties>`;
  }

  private buildAppPropsXml(input: OfficeDocxInput): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>MAOS Industrial Office Engine</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>1</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="1" baseType="lpstr">
      <vt:lpstr>${escapeXml(input.title)}</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
  <Company>MAOS Industrial Operations</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0000</AppVersion>
</Properties>`;
  }

  private buildStylesXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="262626"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="276" w:lineRule="auto" w:after="160"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="360" w:after="160"/>
      <w:keepNext/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="1F4E79"/>
      <w:sz w:val="32"/>
      <w:szCs w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="240" w:after="120"/>
      <w:keepNext/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="2F5597"/>
      <w:sz w:val="26"/>
      <w:szCs w:val="26"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="180" w:after="80"/>
      <w:keepNext/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="595959"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>
  <w:style w:type="table" w:default="1" w:styleId="TableNormal">
    <w:name w:val="Normal Table"/>
    <w:uiPriority w:val="99"/>
    <w:semiHidden/>
    <w:unhideWhenUsed/>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:basedOn w:val="TableNormal"/>
    <w:uiPriority w:val="59"/>
    <w:rsid w:val="00B41234"/>
  </w:style>
</w:styles>`;
  }

  // ── Main Document XML Body Construction ─────────────────────────────

  private buildDocumentXml(input: OfficeDocxInput, canonicalHash: string): string {
    const bodyElements: string[] = [];

    // 1. Document Title
    bodyElements.push(xmlHeading(input.title, 1));

    // 2. Metadata Header Box
    bodyElements.push(this.renderMetadataBlock(input, canonicalHash));

    // 3. Final Decision / Verdict Banner
    bodyElements.push(this.renderVerdictBanner(input));

    // 4. Findings & Compliance Table
    const findings = input.findings || [];
    if (findings.length > 0) {
      bodyElements.push(xmlHeading('Findings and Compliance Status', 2));
      bodyElements.push(this.renderFindingsTable(findings));
    }

    // 5. Validated Measurements Table
    const measurements = input.measurements || [];
    if (measurements.length > 0) {
      bodyElements.push(xmlHeading('Validated Measurements', 2));
      bodyElements.push(this.renderMeasurementsTable(measurements));
    }

    // 6. Verified Calculations Table
    const calculations = input.calculations || [];
    if (calculations.length > 0) {
      bodyElements.push(xmlHeading('Verified Calculations', 2));
      bodyElements.push(this.renderCalculationsTable(calculations));
    }

    // 7. Warnings & System Limitations
    const warnings = input.warnings || [];
    const limitations = input.limitations || [];
    if (warnings.length > 0 || limitations.length > 0) {
      bodyElements.push(xmlHeading('Warnings and System Limitations', 2));
      if (warnings.length > 0) {
        bodyElements.push(this.renderWarningsTable(warnings));
      }
      if (limitations.length > 0) {
        bodyElements.push(xmlPara('Operating Limitations & Bounds:', undefined, true));
        for (const lim of limitations) {
          bodyElements.push(xmlPara(`• ${lim}`));
        }
      }
    }

    // 8. Evidence State Summary
    bodyElements.push(xmlHeading('Evidence State and Grounding Quality', 2));
    bodyElements.push(this.renderEvidenceStateBlock(input));

    // 9. Structured Report Sections
    const sections = input.sections || [];
    if (sections.length > 0) {
      const sortedSections = [...sections].sort((a, b) => a.order - b.order);
      for (const section of sortedSections) {
        bodyElements.push(xmlHeading(section.heading, 2));
        if (section.content) {
          bodyElements.push(xmlPara(section.content));
        }
        if (section.unverifiedModelProse) {
          bodyElements.push(this.renderSegregatedProseBlock({
            id: `sec_prose_${section.id}`,
            label: `Section '${section.heading}' Model Summary`,
            text: section.unverifiedModelProse,
            isModelGenerated: true,
            verifiedAgainstData: false,
            approvedByReviewer: false,
          }));
        }
      }
    }

    // 10. Segregated Model Prose Blocks (Clear Distinction from Facts)
    const proseBlocks = input.proseBlocks || [];
    if (proseBlocks.length > 0) {
      bodyElements.push(xmlHeading('Model Generated Content (Unverified)', 2));
      for (const pb of proseBlocks) {
        bodyElements.push(this.renderSegregatedProseBlock(pb));
      }
    }

    // 11. Citations & Provenance Ledger
    const citations = input.citations || [];
    if (citations.length > 0) {
      bodyElements.push(xmlHeading('Cryptographic Citations and Provenance Ledger', 2));
      bodyElements.push(this.renderCitationsTable(citations));
    }

    // 12. Reviewer Identity, Approval, and Sign-Off
    bodyElements.push(xmlHeading('Formal Review and Sign-Off Ledger', 2));
    bodyElements.push(this.renderApprovalSignOffBlock(input, canonicalHash));

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyElements.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  // ── Render Block Implementations ────────────────────────────────────

  private renderMetadataBlock(input: OfficeDocxInput, canonicalHash: string): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Project ID:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(input.projectId), false),
        xmlTableCell(xmlPara('Run / Task ID:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(`${input.runId}${input.taskId ? ` / ${input.taskId}` : ''}`), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Author Identity:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(`${input.author?.name || 'N/A'} (${input.author?.role || 'Engineer'})`), false),
        xmlTableCell(xmlPara('Generation Date:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(input.generatedAt), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Model Identity:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(input.modelIdentity ? `${input.modelIdentity.modelId} (${input.modelIdentity.revision})` : 'Deterministic / Local Service'), false),
        xmlTableCell(xmlPara('Input Hash (SHA-256):', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(canonicalHash.substring(0, 24) + '...'), false),
      ]),
    ];
    return xmlTable(rows);
  }

  private renderVerdictBanner(input: OfficeDocxInput): string {
    const app = input.approval;
    const isApproved = app.status === 'approved';
    const bgColor = isApproved ? 'E6F4EA' : 'FEF7E0';
    const textColor = isApproved ? '137333' : 'B06000';
    const verdictText = isApproved ? 'APPROVED - FORMAL COMPLIANCE SIGN-OFF' : `STATUS: ${app.status.toUpperCase()}`;

    const lines: string[] = [
      xmlPara(verdictText, undefined, true, textColor),
      xmlPara(`Approval ID: ${app.approvalId || 'N/A'} | Approved By: ${app.approvedBy || 'N/A'} | Timestamp: ${app.approvedAt || 'N/A'}`),
    ];
    if (app.comment) {
      lines.push(xmlPara(`Reviewer Rationale: ${app.comment}`));
    }
    if (app.conditions && app.conditions.length > 0) {
      lines.push(xmlPara(`Conditions: ${app.conditions.join('; ')}`));
    }

    const row = xmlTableRow([
      xmlTableCell(lines.join(''), false, bgColor),
    ]);
    return xmlTable([row]);
  }

  private renderFindingsTable(findings: readonly OfficeFinding[]): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Finding ID', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Category', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Status', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Statement', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Metric & Value', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Citations', undefined, true), true, 'F2F4F8'),
      ]),
    ];

    for (const f of findings) {
      let statusColor = '595959';
      let statusBg = 'F2F4F8';
      if (f.status === 'PASS') {
        statusColor = '137333';
        statusBg = 'E6F4EA';
      } else if (f.status === 'WARNING') {
        statusColor = 'B06000';
        statusBg = 'FEF7E0';
      } else if (f.status === 'FAIL') {
        statusColor = 'C5221F';
        statusBg = 'FCE8E6';
      }

      const metricValueStr = f.metric
        ? `${f.metric}: ${f.observedValue ?? 'N/A'}${f.unit ? ` ${f.unit}` : ''} (thresh: ${f.thresholdValue ?? 'N/A'})`
        : 'N/A';

      const citationsStr = (f.citationIds || []).join(', ');

      const statementParts = [xmlPara(f.statement)];
      if (f.reviewerCorrection) {
        statementParts.push(
          xmlPara(
            `[Reviewer Correction by ${f.reviewerCorrection.reviewerId}: '${f.reviewerCorrection.originalValue}' -> '${f.reviewerCorrection.correctedValue}' (Reason: ${f.reviewerCorrection.reason})]`,
            undefined,
            false,
            '2F5597',
          ),
        );
      }

      rows.push(
        xmlTableRow([
          xmlTableCell(xmlPara(f.id)),
          xmlTableCell(xmlPara(f.category)),
          xmlTableCell(xmlPara(`[${f.status}]`, undefined, true, statusColor), false, statusBg),
          xmlTableCell(statementParts.join('')),
          xmlTableCell(xmlPara(metricValueStr)),
          xmlTableCell(xmlPara(citationsStr)),
        ]),
      );
    }

    return xmlTable(rows);
  }

  private renderMeasurementsTable(measurements: readonly OfficeMeasurement[]): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('ID', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Measurement Metric', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Numeric Value', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Unit', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Tolerance', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Status', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Citations', undefined, true), true, 'F2F4F8'),
      ]),
    ];

    for (const m of measurements) {
      let tolStr = 'N/A';
      if (typeof m.tolerance === 'number') {
        tolStr = `±${m.tolerance}`;
      } else if (m.tolerance && typeof m.tolerance === 'object') {
        tolStr = `[${m.tolerance.min ?? '-∞'}, ${m.tolerance.max ?? '+∞'}]`;
      }

      rows.push(
        xmlTableRow([
          xmlTableCell(xmlPara(m.id)),
          xmlTableCell(xmlPara(m.name)),
          xmlTableCell(xmlPara(String(m.numericValue))),
          xmlTableCell(xmlPara(m.unit)),
          xmlTableCell(xmlPara(tolStr)),
          xmlTableCell(xmlPara(m.status || 'nominal')),
          xmlTableCell(xmlPara((m.citationIds || []).join(', '))),
        ]),
      );
    }

    return xmlTable(rows);
  }

  private renderCalculationsTable(calculations: readonly OfficeCalculation[]): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Calculation', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Formula / Method', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Inputs', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Result Value', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Unit', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Verified By', undefined, true), true, 'F2F4F8'),
      ]),
    ];

    for (const c of calculations) {
      const inputsStr = (c.inputs || []).map((i) => `${i.name}=${i.value} ${i.unit}`).join('; ');
      rows.push(
        xmlTableRow([
          xmlTableCell(xmlPara(c.name)),
          xmlTableCell(xmlPara(c.methodOrFormula)),
          xmlTableCell(xmlPara(inputsStr)),
          xmlTableCell(xmlPara(String(c.resultValue))),
          xmlTableCell(xmlPara(c.resultUnit)),
          xmlTableCell(xmlPara(c.verifiedBy)),
        ]),
      );
    }

    return xmlTable(rows);
  }

  private renderWarningsTable(warnings: readonly OfficeWarning[]): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Code', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Severity', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Warning Message', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Acknowledged', undefined, true), true, 'F2F4F8'),
      ]),
    ];

    for (const w of warnings) {
      rows.push(
        xmlTableRow([
          xmlTableCell(xmlPara(w.code)),
          xmlTableCell(xmlPara(w.severity)),
          xmlTableCell(xmlPara(w.message)),
          xmlTableCell(xmlPara(w.acknowledged ? `Yes (${w.acknowledgedBy || 'reviewer'})` : 'No')),
        ]),
      );
    }

    return xmlTable(rows);
  }

  private renderEvidenceStateBlock(input: OfficeDocxInput): string {
    const ev = input.evidenceState;
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('OCR Confidence:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.ocrConfidence !== undefined ? `${(ev.ocrConfidence * 100).toFixed(1)}%` : 'N/A'), false),
        xmlTableCell(xmlPara('VLM Confidence:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.vlmConfidence !== undefined ? `${(ev.vlmConfidence * 100).toFixed(1)}%` : 'N/A'), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Conflict Status:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.hasUnresolvedConflicts ? 'UNRESOLVED CONFLICTS' : 'Clean / Resolved'), false),
        xmlTableCell(xmlPara('Quarantine Status:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.isQuarantined ? 'QUARANTINED' : 'Verified Safe'), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Human Review:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.reviewedByHuman ? `Reviewed by ${ev.reviewerId || 'Human'}` : 'Not Required / Clean'), false),
        xmlTableCell(xmlPara('Reviewer Notes:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(ev.reviewerNotes || 'None'), false),
      ]),
    ];
    return xmlTable(rows);
  }

  private renderSegregatedProseBlock(pb: OfficeProseBlock): string {
    const content = [
      xmlPara(
        '*** [UNVERIFIED MODEL PROSE — NOT VERIFIED AGAINST STRUCTURED DATA — REQUIRES HUMAN REVIEW] ***',
        undefined,
        true,
        'B45309',
      ),
      xmlPara(`Label: ${pb.label}${pb.modelId ? ` | Generator Model: ${pb.modelId}` : ''}`),
      xmlPara(pb.text),
    ];
    const row = xmlTableRow([
      xmlTableCell(content.join(''), false, 'FFFBEB'),
    ]);
    return xmlTable([row]);
  }

  private renderCitationsTable(citations: readonly OfficeCitation[]): string {
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Citation ID', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Source Path', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('SHA-256 Digest', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Location Reference', undefined, true), true, 'F2F4F8'),
        xmlTableCell(xmlPara('Verified Snippet', undefined, true), true, 'F2F4F8'),
      ]),
    ];

    for (const c of citations) {
      const locParts: string[] = [];
      if (c.pageNumber !== undefined) locParts.push(`Page ${c.pageNumber}`);
      if (c.sectionHeading) locParts.push(`Sec: ${c.sectionHeading}`);
      if (c.chunkId) locParts.push(`Chunk: ${c.chunkId}`);
      const locStr = locParts.length > 0 ? locParts.join(', ') : (c.documentId || 'Document root');

      rows.push(
        xmlTableRow([
          xmlTableCell(xmlPara(c.citationId)),
          xmlTableCell(xmlPara(c.sourcePath)),
          xmlTableCell(xmlPara(c.sourceHash.substring(0, 16) + '...')),
          xmlTableCell(xmlPara(locStr)),
          xmlTableCell(xmlPara(c.snippet)),
        ]),
      );
    }

    return xmlTable(rows);
  }

  private renderApprovalSignOffBlock(input: OfficeDocxInput, canonicalHash: string): string {
    const app = input.approval;
    const rows: string[] = [
      xmlTableRow([
        xmlTableCell(xmlPara('Approval ID:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(app.approvalId || 'N/A'), false),
        xmlTableCell(xmlPara('Approved Status:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(app.status.toUpperCase(), undefined, true, app.status === 'approved' ? '137333' : 'B06000'), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Approved By:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(app.approvedBy || 'N/A'), false),
        xmlTableCell(xmlPara('Approved At:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(app.approvedAt || 'N/A'), false),
      ]),
      xmlTableRow([
        xmlTableCell(xmlPara('Approved Hash:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(app.payloadHash || canonicalHash), false),
        xmlTableCell(xmlPara('Sign-Off Identity:', undefined, true), false, 'F9FAFB'),
        xmlTableCell(xmlPara(input.conclusions?.[0]?.signOffIdentity || app.approvedBy || 'Engineer'), false),
      ]),
    ];
    return xmlTable(rows);
  }
}
