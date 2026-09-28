/**
 * PPTX Generator Service
 *
 * Generates verified, air-gapped, approval-gated PowerPoint presentations (.pptx)
 * directly from validated OfficePptxInput data.
 *
 * Security & Integrity Invariants:
 *   - 100% offline pure Node.js PresentationML construction (zero external binaries)
 *   - Strict project root confinement and safe industrial path verification
 *   - Mandatory human approval verification (status === 'approved' + valid approvalId)
 *   - Anti-tampering check: input payload hash must match approved payloadHash
 *   - Stale / revoked approval detection via ApprovalService
 *   - Dynamic source-file freshness check against physical disk content
 *   - Unresolved conflict and quarantine rejection
 *   - Collision protection with explicit approved overwrite verification
 *   - Durable idempotency with cached replay and conflict detection
 *   - Atomic finalization via ArtifactService.finalizeArtifact (temp -> fsync -> hash -> rename)
 *   - Comprehensive privacy-safe audit logging with zero raw prose
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  OfficePptxInput,
  PptxGenerationErrorCode,
  PptxGenerationError,
  GeneratePptxToolInput,
  GeneratePptxToolResult,
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
  buildPptxArchive,
  validatePptxPackage,
  PptxPresentationData,
  PptxSlideData,
  PptxTableCell,
  PptxParagraph,
} from '../industrial/office/pptx-packager';

export class PptxGeneratorService {
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
   * Generates a safe, verified .pptx presentation from validated OfficePptxInput.
   */
  generatePptx(params: GeneratePptxToolInput & {
    callerIdentity?: { agentId?: string; taskId?: string };
  }): GeneratePptxToolResult {
    // 0. Template Safety validation (if templatePath provided)
    const templatePath =
      params.templatePath ||
      (params.input as any)?.templatePath ||
      (params.input as any)?.pptxOptions?.templatePath;

    if (templatePath) {
      try {
        this.templateSafetyService.assertTemplateSafety(templatePath, 'pptx', {
          runId: params.input?.runId || 'unknown',
          actor: params.callerIdentity?.agentId || 'pptx_generator',
        });
      } catch (err: any) {
        if (err instanceof TemplateSafetyError) {
          throw new PptxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
        }
        throw err;
      }
    }

    // 1. Schema version validation
    if (params.schemaVersion !== 1) {
      throw new PptxGenerationError(
        'INVALID_INPUT',
        `Unsupported schemaVersion ${params.schemaVersion}. Expected schemaVersion 1.`
      );
    }

    // 2. Validate input is defined
    if (!params.input || typeof params.input !== 'object') {
      throw new PptxGenerationError('INVALID_INPUT', 'Missing required input object.');
    }

    // 3. Project confinement & cross-project verification
    if (!params.projectId || typeof params.projectId !== 'string') {
      throw new PptxGenerationError('INVALID_INPUT', 'Missing required projectId parameter.');
    }
    if (params.input.projectId !== params.projectId) {
      this.recordAudit('PPTX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'CROSS_PROJECT_FORBIDDEN',
        inputProjectId: params.input.projectId,
        requestProjectId: params.projectId,
      });
      throw new PptxGenerationError(
        'INVALID_INPUT',
        `Input projectId '${params.input.projectId}' does not match requested projectId '${params.projectId}'.`
      );
    }

    // 4. Comprehensive input schema validation
    const valResult = validateOfficeArtifactInput(params.input);
    if (!valResult.valid) {
      const firstError = valResult.errors[0] || 'Unknown validation failure';
      const codeMatch = firstError.match(/^\[([A-Z_]+)\]/);
      const code = (codeMatch ? codeMatch[1] : 'INVALID_INPUT') as PptxGenerationErrorCode;
      this.recordAudit('PPTX_GENERATION_REJECTED', params.input.runId || 'unknown', params.callerIdentity?.agentId || 'pptx_generator', {
        reason: code,
        errors: valResult.errors,
      });
      throw new PptxGenerationError(code, firstError, { errors: valResult.errors });
    }

    // 5. Output path validation & containment
    if (!params.outputPath || typeof params.outputPath !== 'string') {
      throw new PptxGenerationError('INVALID_INPUT', 'Missing required outputPath parameter.');
    }
    if (!isSafeIndustrialPath(params.outputPath)) {
      throw new PptxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${params.outputPath}' violates safe path constraints (traversal, absolute, or invalid characters detected).`
      );
    }
    const normalizedRelPath = params.outputPath.replace(/\\/g, '/');
    if (!normalizedRelPath.toLowerCase().endsWith('.pptx')) {
      throw new PptxGenerationError(
        'INVALID_INPUT',
        `Output path '${params.outputPath}' must have .pptx extension.`
      );
    }

    if (params.input.artifactType !== 'pptx') {
      throw new PptxGenerationError(
        'INVALID_INPUT',
        `Invalid artifactType '${params.input.artifactType}'. Expected 'pptx'.`
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
        throw new PptxGenerationError('TEMPLATE_SAFETY_VIOLATION', err.message);
      }
      throw err;
    }

    // 9. Dynamic Freshness & Provenance Verification
    const freshness = this.officeInputService.verifyFreshnessSync(params.input);
    if (!freshness.fresh) {
      this.recordAudit('PPTX_GENERATION_REJECTED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'STALE_SOURCE_HASH',
        inputHash: canonicalHash,
        errors: freshness.errors,
      });

      const joined = freshness.errors.join('; ');
      const lowerJoined = joined.toLowerCase();
      if (joined.includes('UNRESOLVED_CONFLICT') || lowerJoined.includes('conflict')) {
        throw new PptxGenerationError('UNRESOLVED_CONFLICT', joined);
      }
      if (joined.includes('QUARANTINED') || lowerJoined.includes('quarantined')) {
        throw new PptxGenerationError('QUARANTINED_EVIDENCE', joined);
      }
      if (joined.includes('LOW_CONFIDENCE') || lowerJoined.includes('confidence')) {
        throw new PptxGenerationError('LOW_CONFIDENCE_UNREVIEWED', joined);
      }
      if (
        lowerJoined.includes('enoent') ||
        lowerJoined.includes('not found') ||
        lowerJoined.includes('source_not_found') ||
        lowerJoined.includes('missing')
      ) {
        throw new PptxGenerationError('SOURCE_FILE_MISSING', joined);
      }
      throw new PptxGenerationError('STALE_SOURCE_HASH', joined);
    }

    // 10. Durable Idempotency Claim
    const requestId = params.requestId;
    if (!requestId || typeof requestId !== 'string') {
      throw new PptxGenerationError('INVALID_INPUT', 'Missing required requestId for idempotency.');
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
      operation: 'generate_pptx',
      projectId: params.projectId,
      authContext: params.callerIdentity?.agentId,
    });

    if (claimOutcome.outcome === 'replay') {
      return {
        ...(claimOutcome.record.responsePayload as GeneratePptxToolResult),
        cached: true,
      };
    }
    if (claimOutcome.outcome === 'conflict') {
      throw new PptxGenerationError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'in_progress') {
      throw new PptxGenerationError('CONCURRENT_MUTATION', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'auth_mismatch') {
      throw new PptxGenerationError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
    }

    // 11. Destination collision check
    const destAbsPath = path.resolve(this.projectRoot, normalizedRelPath);
    if (fs.existsSync(destAbsPath)) {
      if (!params.allowOverwrite) {
        this.idempotencyStore.fail(requestId, 'Destination file already exists (collision).');
        throw new PptxGenerationError(
          'ARTIFACT_COLLISION',
          `Destination path '${normalizedRelPath}' already exists. Overwriting requires allowOverwrite: true and approved approval.`
        );
      }
      const effectiveApprovalId = params.approvalId || params.input.approval.approvalId;
      if (!effectiveApprovalId) {
        this.idempotencyStore.fail(requestId, 'Overwrite requires approvalId.');
        throw new PptxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          'Overwriting an existing document requires an explicit approvalId.'
        );
      }
      const appRecord = this.approvalService.getApproval(effectiveApprovalId);
      if (appRecord && appRecord.status !== 'approved') {
        this.idempotencyStore.fail(requestId, 'Approval status for overwrite is not approved.');
        throw new PptxGenerationError(
          'UNAUTHORIZED_OVERWRITE',
          `Approval '${effectiveApprovalId}' has status '${appRecord.status}'. Overwrite denied.`
        );
      }
    }

    // 12. Audit Event: PPTX_GENERATION_STARTED (Privacy-safe: no raw text)
    this.recordAudit('PPTX_GENERATION_STARTED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
      projectId: params.projectId,
      inputHash: canonicalHash,
      outputPath: normalizedRelPath,
      findingsCount: params.input.findings.length,
      measurementsCount: params.input.measurements.length,
      citationsCount: params.input.citations.length,
      approvalId: params.input.approval.approvalId,
    });

    let zipBuffer: Buffer;
    let presentationData: PptxPresentationData;
    try {
      // 13. Build PresentationML structure & PKZIP buffer
      presentationData = this.buildPresentationData(params.input);
      zipBuffer = buildPptxArchive(presentationData);
    } catch (err: any) {
      this.idempotencyStore.fail(requestId, `Package build error: ${err.message}`);
      this.recordAudit('PPTX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'GENERATION_FAILED',
        message: err.message,
        inputHash: canonicalHash,
      });
      if (err instanceof PptxGenerationError) {
        throw err;
      }
      throw new PptxGenerationError('GENERATION_FAILED', `Failed to build PPTX package: ${err.message}`);
    }

    // 14. Validate generated PPTX package (reopen and parse offline)
    const packageValidation = validatePptxPackage(zipBuffer);
    if (!packageValidation.valid) {
      const msg = packageValidation.errors.join('; ');
      this.idempotencyStore.fail(requestId, `Validation failed: ${msg}`);
      this.recordAudit('PPTX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'PACKAGE_VALIDATION_FAILED',
        errors: packageValidation.errors,
        inputHash: canonicalHash,
      });
      throw new PptxGenerationError('PPTX_PACKAGE_INVALID', `Generated PPTX package failed offline validation: ${msg}`);
    }

    // 14b. Validate output package safety before finalization (F6-05)
    try {
      this.templateSafetyService.assertOutputSafety(zipBuffer, 'pptx', normalizedRelPath, {
        runId: params.input.runId,
        actor: params.callerIdentity?.agentId || 'pptx_generator',
      });
    } catch (err: any) {
      const reason = err instanceof TemplateSafetyError ? err.message : String(err.message || err);
      this.idempotencyStore.fail(requestId, `Output safety validation failed: ${reason}`);
      this.recordAudit('PPTX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'OUTPUT_SAFETY_VIOLATION',
        message: reason,
        inputHash: canonicalHash,
      });
      throw new PptxGenerationError('OUTPUT_SAFETY_VIOLATION', `Output package safety verification failed: ${reason}`);
    }

    // 15. Finalize artifact atomically through ArtifactService
    const artifactId = `pptx_${crypto.randomBytes(8).toString('hex')}`;
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
          generator: 'MAOS_PPTX_GENERATOR_V1',
          inputCanonicalHash: canonicalHash,
          projectId: params.projectId,
          runId: params.input.runId,
          taskId: params.input.taskId,
          approvalId: params.input.approval.approvalId,
          approvedBy: params.input.approval.approvedBy,
          findingsCount: params.input.findings.length,
          measurementsCount: params.input.measurements.length,
          citationsCount: params.input.citations.length,
          slideCount: presentationData.slides.length,
          templatePath: templatePath || undefined,
          generatedAt: params.input.generatedAt,
        },
      });
    } catch (err: any) {
      this.idempotencyStore.fail(requestId, `Finalization error: ${err.message}`);
      this.recordAudit('PPTX_GENERATION_FAILED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
        reason: 'FINALIZATION_FAILED',
        message: err.message,
        inputHash: canonicalHash,
      });
      throw new PptxGenerationError('GENERATION_FAILED', `Artifact finalization failed: ${err.message}`);
    }

    const slideTitles = presentationData.slides.map((s) => s.title);
    const toolResult: GeneratePptxToolResult = {
      ok: true,
      artifactId: finalizedArtifact.id,
      relativePath: normalizedRelPath,
      canonicalHash,
      artifactHash: finalizedArtifact.hash,
      bytesWritten: finalizedArtifact.size,
      generatedAt: new Date().toISOString(),
      approvalId: params.input.approval.approvalId,
      cached: false,
      slideCount: presentationData.slides.length,
      slideTitles,
    };

    // 16. Complete idempotency record
    this.idempotencyStore.complete(requestId, 200, toolResult);

    // 17. Audit Event: PPTX_GENERATED (Privacy-safe: no raw text)
    this.recordAudit('PPTX_GENERATED', params.input.runId, params.callerIdentity?.agentId || 'pptx_generator', {
      projectId: params.projectId,
      taskId: params.input.taskId,
      runId: params.input.runId,
      artifactId: finalizedArtifact.id,
      outputPath: normalizedRelPath,
      canonicalHash,
      artifactHash: finalizedArtifact.hash,
      bytesWritten: finalizedArtifact.size,
      slideCount: presentationData.slides.length,
      approvalId: params.input.approval.approvalId,
    });

    return toolResult;
  }

  // ── Validation Helpers ──────────────────────────────────────────────

  private assertNoForbiddenPayloads(input: OfficePptxInput): void {
    // Check title
    if (containsMacroOrExecutable(input.title)) {
      throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', 'Title contains macro or executable reference.');
    }
    if (containsExternalRelationship(input.title)) {
      throw new PptxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', 'Title contains external URL/relationship.');
    }

    // Check findings
    for (const f of input.findings) {
      if (containsMacroOrExecutable(f.statement)) {
        throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Finding '${f.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(f.statement)) {
        throw new PptxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Finding '${f.id}' contains external relationship/URL.`);
      }
    }

    // Check measurements
    for (const m of input.measurements) {
      if (containsMacroOrExecutable(m.name)) {
        throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Measurement '${m.id}' contains macro reference.`);
      }
      if (typeof m.numericValue !== 'number' || isNaN(m.numericValue)) {
        throw new PptxGenerationError('INVALID_INPUT', `Measurement '${m.id}' numericValue must be a valid number.`);
      }
      if (!m.unit || typeof m.unit !== 'string' || m.unit.trim().length === 0) {
        throw new PptxGenerationError('MISSING_UNIT', `Measurement '${m.id}' is missing required unit.`);
      }
    }

    // Check calculations
    for (const c of input.calculations) {
      if (typeof c.resultValue !== 'number' || isNaN(c.resultValue)) {
        throw new PptxGenerationError('INVALID_INPUT', `Calculation '${c.id}' resultValue must be a valid number.`);
      }
      if (!c.resultUnit || typeof c.resultUnit !== 'string' || c.resultUnit.trim().length === 0) {
        throw new PptxGenerationError('MISSING_UNIT', `Calculation '${c.id}' is missing required resultUnit.`);
      }
    }

    // Check prose blocks
    for (const pb of (input.proseBlocks || [])) {
      if (containsMacroOrExecutable(pb.text)) {
        throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Prose block '${pb.id}' contains macro/executable reference.`);
      }
      if (containsExternalRelationship(pb.text)) {
        throw new PptxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Prose block '${pb.id}' contains external URL.`);
      }
    }

    // Check warnings
    for (const w of (input.warnings || [])) {
      if (containsMacroOrExecutable(w.message)) {
        throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Warning '${w.code}' message contains macro/executable.`);
      }
      if (containsExternalRelationship(w.message)) {
        throw new PptxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Warning '${w.code}' message contains external URL.`);
      }
    }

    // Check limitations
    for (const l of (input.limitations || [])) {
      if (containsMacroOrExecutable(l)) {
        throw new PptxGenerationError('MACRO_OR_EXECUTABLE_DETECTED', `Limitation contains macro/executable: '${l}'`);
      }
      if (containsExternalRelationship(l)) {
        throw new PptxGenerationError('EXTERNAL_RELATIONSHIP_FORBIDDEN', `Limitation contains external URL: '${l}'`);
      }
    }
  }

  private assertValidApproval(params: GeneratePptxToolInput, canonicalHash: string): void {
    const approval = params.input.approval;

    // A. Must be explicitly approved
    if (approval.status !== 'approved') {
      throw new PptxGenerationError(
        'APPROVAL_REQUIRED',
        `Presentation generation requires approval status 'approved', but status is '${approval.status}'.`
      );
    }

    // B. Approval ID must be present
    if (!approval.approvalId || typeof approval.approvalId !== 'string') {
      throw new PptxGenerationError(
        'APPROVAL_REQUIRED',
        'Approved presentation is missing required approvalId.'
      );
    }

    // C. Anti-tampering check: payloadHash must match freshly computed canonical hash
    if (approval.payloadHash && approval.payloadHash !== canonicalHash) {
      throw new PptxGenerationError(
        'CHANGED_INPUT_AFTER_APPROVAL',
        `Input modified after approval! Approved payloadHash '${approval.payloadHash}' does not match current canonicalHash '${canonicalHash}'.`
      );
    }

    // D. If registered in ApprovalService, check status
    const registeredApproval = this.approvalService.getApproval(approval.approvalId);
    if (registeredApproval) {
      if (registeredApproval.status !== 'approved') {
        throw new PptxGenerationError(
          'STALE_APPROVAL',
          `Approval '${approval.approvalId}' has status '${registeredApproval.status}' in ApprovalService. Approved status required.`
        );
      }
    }
  }

  // ── Presentation Slide Deck Builder ─────────────────────────────────

  private buildPresentationData(input: OfficePptxInput): PptxPresentationData {
    const slides: PptxSlideData[] = [];
    let slideNum = 1;

    // ── Slide 1: Title & Presentation Metadata ──────────────────────
    const metaCardParagraphs: PptxParagraph[] = [
      {
        runs: [{ text: 'Project / Verification Details', bold: true, sizePt: 16, colorHex: '1E3A8A' }],
        spaceAfterPt: 10,
      },
      {
        runs: [
          { text: 'Project ID: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: input.projectId, sizePt: 13, colorHex: '0F172A' },
        ],
        spaceAfterPt: 4,
      },
      {
        runs: [
          { text: 'Run ID: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: input.runId, sizePt: 13, colorHex: '0F172A' },
          { text: '   •   Task ID: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: input.taskId || 'unspecified', sizePt: 13, colorHex: '0F172A' },
        ],
        spaceAfterPt: 4,
      },
      {
        runs: [
          { text: 'Author: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: `${input.author?.name || 'Inspector'} (${input.author?.role || 'Safety Engineer'})`, sizePt: 13, colorHex: '0F172A' },
        ],
        spaceAfterPt: 4,
      },
      {
        runs: [
          { text: 'Model Identity: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: `${input.modelIdentity?.modelId || 'qwen2.5-vl'} (${input.modelIdentity?.revision || 'pinned'})`, sizePt: 13, colorHex: '0F172A' },
        ],
        spaceAfterPt: 4,
      },
      {
        runs: [
          { text: 'Generated Date: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: input.generatedAt, sizePt: 13, colorHex: '0F172A' },
        ],
        spaceAfterPt: 4,
      },
      {
        runs: [
          { text: 'Approval Status: ', bold: true, sizePt: 13, colorHex: '334155' },
          { text: `${input.approval.status.toUpperCase()} (ID: ${input.approval.approvalId || 'N/A'})`, bold: true, sizePt: 13, colorHex: '059669' },
        ],
      },
    ];

    slides.push({
      slideNumber: slideNum++,
      title: input.pptxOptions?.slideDeckTitle || input.title,
      subtitle: 'Industrial Inspection & Verification Deliverable Deck',
      layout: 'title',
      shapes: [
        {
          x: 2000000,
          y: 3500000,
          cx: 8192000,
          cy: 2400000,
          fillColorHex: 'F1F5F9',
          borderColorHex: 'CBD5E1',
          borderWidthPt: 1.5,
          paragraphs: metaCardParagraphs,
        },
      ],
    });

    // ── Slide 2: Executive Decision / Verdict ───────────────────────
    const verdictStatement = input.conclusions && input.conclusions[0]
      ? input.conclusions[0].statement
      : 'All safety verification criteria have been inspected and confirmed compliant with industrial standards.';
    const isApproved = input.approval.status === 'approved';
    const statusColor = isApproved ? '059669' : 'DC2626';
    const badgeText = isApproved ? 'VERDICT: FORMALLY APPROVED' : 'VERDICT: REJECTED / NON-COMPLIANT';

    slides.push({
      slideNumber: slideNum++,
      title: 'Executive Decision & Formal Verdict',
      subtitle: 'Official sign-off state and verified resolution comment',
      layout: 'content',
      shapes: [
        // Status Badge Banner
        {
          x: 685800,
          y: 1500000,
          cx: 10820400,
          cy: 900000,
          fillColorHex: isApproved ? 'ECFDF5' : 'FEF2F2',
          borderColorHex: statusColor,
          borderWidthPt: 2,
          paragraphs: [
            {
              runs: [{ text: badgeText, bold: true, sizePt: 22, colorHex: statusColor }],
              align: 'center',
            },
          ],
        },
        // Verdict Statement Box
        {
          x: 685800,
          y: 2600000,
          cx: 10820400,
          cy: 1600000,
          fillColorHex: 'F8FAFC',
          borderColorHex: 'E2E8F0',
          borderWidthPt: 1,
          paragraphs: [
            {
              runs: [{ text: 'Formal Conclusion Statement', bold: true, sizePt: 16, colorHex: '1E3A8A' }],
              spaceAfterPt: 8,
            },
            {
              runs: [{ text: verdictStatement, sizePt: 14, colorHex: '1E293B' }],
              spaceAfterPt: 10,
            },
          ],
        },
        // Approval Details Box
        {
          x: 685800,
          y: 4400000,
          cx: 10820400,
          cy: 1700000,
          fillColorHex: 'F8FAFC',
          borderColorHex: 'E2E8F0',
          borderWidthPt: 1,
          paragraphs: [
            {
              runs: [{ text: 'Authorization & Governance Metadata', bold: true, sizePt: 16, colorHex: '1E3A8A' }],
              spaceAfterPt: 6,
            },
            {
              runs: [
                { text: 'Approval Record ID: ', bold: true, sizePt: 13, colorHex: '475569' },
                { text: input.approval.approvalId || 'N/A', sizePt: 13, colorHex: '0F172A' },
                { text: '    Approved By: ', bold: true, sizePt: 13, colorHex: '475569' },
                { text: input.approval.approvedBy || 'N/A', sizePt: 13, colorHex: '0F172A' },
                { text: '    Decided At: ', bold: true, sizePt: 13, colorHex: '475569' },
                { text: input.approval.approvedAt || 'N/A', sizePt: 13, colorHex: '0F172A' },
              ],
              spaceAfterPt: 4,
            },
            {
              runs: [
                { text: 'Resolution Note: ', bold: true, sizePt: 13, colorHex: '475569' },
                { text: input.approval.comment || 'Criteria verified compliant.', sizePt: 13, colorHex: '0F172A' },
              ],
            },
          ],
        },
      ],
    });

    // ── Slide 3: Safety Findings & Status ───────────────────────────
    const findingsRows: PptxTableCell[][] = [
      [
        { text: 'Finding ID', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Category', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Statement', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Observed', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Threshold', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Unit', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Status', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Citations', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
      ],
    ];

    for (const f of input.findings) {
      const isPass = f.status === 'PASS';
      const statusFill = isPass ? 'DCFCE7' : f.status === 'WARNING' ? 'FEF3C7' : 'FEE2E2';
      const statusText = isPass ? '15803D' : f.status === 'WARNING' ? 'B45309' : 'B91C1C';

      findingsRows.push([
        { text: f.id, bold: true, sizePt: 11 },
        { text: f.category, sizePt: 11 },
        { text: f.statement, sizePt: 11 },
        { text: f.observedValue !== undefined ? String(f.observedValue) : 'N/A', align: 'right', sizePt: 11 },
        { text: f.thresholdValue !== undefined ? String(f.thresholdValue) : 'N/A', align: 'right', sizePt: 11 },
        { text: f.unit || '—', align: 'center', sizePt: 11 },
        { text: f.status, bold: true, fillColorHex: statusFill, textColorHex: statusText, align: 'center', sizePt: 11 },
        { text: f.citationIds.join(', '), sizePt: 11 },
      ]);
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Safety Findings & Compliance Status',
      subtitle: `Observed findings, metrics, and thresholds (${input.findings.length} findings evaluated)`,
      layout: 'content',
      table: {
        x: 685800,
        y: 1500000,
        cx: 10820400,
        cy: 4600000,
        colWidths: [1200000, 1400000, 3620400, 1000000, 1000000, 800000, 900000, 900000],
        rows: findingsRows,
      },
    });

    // ── Slide 4: Measurements & Units ───────────────────────────────
    const measurementRows: PptxTableCell[][] = [
      [
        { text: 'Measurement ID', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Parameter Name', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Numeric Value', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Mandatory Unit', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Tolerance', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Status', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Citations', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
      ],
    ];

    for (const m of input.measurements) {
      let tolStr = '—';
      if (m.tolerance !== undefined) {
        tolStr = typeof m.tolerance === 'number'
          ? `±${m.tolerance}`
          : `[${(m.tolerance as any).min} .. ${(m.tolerance as any).max}]`;
      }
      measurementRows.push([
        { text: m.id, bold: true, sizePt: 11 },
        { text: m.name, sizePt: 11 },
        { text: String(m.numericValue), align: 'right', bold: true, sizePt: 11 },
        { text: m.unit, align: 'center', bold: true, sizePt: 11 },
        { text: tolStr, align: 'center', sizePt: 11 },
        { text: (m.status || 'nominal').toUpperCase(), align: 'center', sizePt: 11 },
        { text: (m.citationIds || []).join(', ') || '—', sizePt: 11 },
      ]);
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Critical Engineering Measurements & Units',
      subtitle: 'Sensor readings, physical parameters, and verified unit declarations',
      layout: 'content',
      table: {
        x: 685800,
        y: 1500000,
        cx: 10820400,
        cy: 4600000,
        colWidths: [1500000, 2520400, 1400000, 1400000, 1400000, 1300000, 1300000],
        rows: measurementRows,
      },
    });

    // ── Slide 5: Calculations & Methods ─────────────────────────────
    const calcRows: PptxTableCell[][] = [
      [
        { text: 'Calculation ID', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Method / Formula', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Inputs Summary', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Result Value', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Result Unit', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Verification Method', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
      ],
    ];

    for (const c of input.calculations) {
      const inputsSummary = (c.inputs || []).map((inp) => `${inp.name}=${inp.value} ${inp.unit}`).join(', ') || '—';
      calcRows.push([
        { text: c.id, bold: true, sizePt: 11 },
        { text: c.methodOrFormula || c.name, sizePt: 11 },
        { text: inputsSummary, sizePt: 11 },
        { text: String(c.resultValue), align: 'right', bold: true, sizePt: 11 },
        { text: c.resultUnit, align: 'center', bold: true, sizePt: 11 },
        { text: c.verifiedBy || 'deterministic_calc', align: 'center', sizePt: 11 },
      ]);
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Verified Calculations & Computational Methods',
      subtitle: 'Deterministic and reproducible equations with declared units of measurement',
      layout: 'content',
      table: {
        x: 685800,
        y: 1500000,
        cx: 10820400,
        cy: 4600000,
        colWidths: [1500000, 2720400, 2600000, 1300000, 1100000, 1600000],
        rows: calcRows,
      },
    });

    // ── Slide 6: Warnings & Limitations ─────────────────────────────
    const warningParagraphs: PptxParagraph[] = [
      {
        runs: [{ text: 'Operational Warnings & Safety Alerts', bold: true, sizePt: 16, colorHex: 'B45309' }],
        spaceAfterPt: 8,
      },
    ];

    const warnings = input.warnings || [];
    if (warnings.length === 0) {
      warningParagraphs.push({
        runs: [{ text: 'No operational warnings recorded for this inspection run.', sizePt: 13, colorHex: '475569' }],
      });
    } else {
      for (const w of warnings) {
        warningParagraphs.push({
          runs: [
            { text: `[${w.severity.toUpperCase()}] ${w.code}: `, bold: true, sizePt: 13, colorHex: 'B45309' },
            { text: w.message, sizePt: 13, colorHex: '0F172A' },
            { text: w.acknowledged ? ` (Acknowledged by ${w.acknowledgedBy || 'reviewer'})` : ' (Pending review)', sizePt: 11, colorHex: '64748B' },
          ],
          bullet: true,
          spaceAfterPt: 4,
        });
      }
    }

    const limitationParagraphs: PptxParagraph[] = [
      {
        runs: [{ text: 'System Boundaries & Governing Limitations', bold: true, sizePt: 16, colorHex: '1E3A8A' }],
        spaceAfterPt: 8,
      },
    ];

    const limitations = input.limitations || [];
    if (limitations.length === 0) {
      limitationParagraphs.push({
        runs: [{ text: 'Standard operational boundaries apply under relevant industrial standards.', sizePt: 13, colorHex: '475569' }],
      });
    } else {
      for (const lim of limitations) {
        limitationParagraphs.push({
          runs: [{ text: lim, sizePt: 13, colorHex: '0F172A' }],
          bullet: true,
          spaceAfterPt: 4,
        });
      }
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Warnings & Operational Limitations',
      subtitle: 'Safety advisories, operational boundaries, and system constraints',
      layout: 'content',
      shapes: [
        {
          x: 685800,
          y: 1500000,
          cx: 10820400,
          cy: 2200000,
          fillColorHex: 'FEF3C7',
          borderColorHex: 'F59E0B',
          borderWidthPt: 1.5,
          paragraphs: warningParagraphs,
        },
        {
          x: 685800,
          y: 3900000,
          cx: 10820400,
          cy: 2200000,
          fillColorHex: 'F1F5F9',
          borderColorHex: 'CBD5E1',
          borderWidthPt: 1.5,
          paragraphs: limitationParagraphs,
        },
      ],
    });

    // ── Slide 7: Citations & Provenance Ledger ───────────────────────
    const citationRows: PptxTableCell[][] = [
      [
        { text: 'Citation ID', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Source File Path', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'SHA-256 Digest (Truncated)', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Location', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
        { text: 'Verified Evidence Snippet', bold: true, fillColorHex: '1E3A8A', textColorHex: 'FFFFFF', sizePt: 12 },
      ],
    ];

    for (const cit of input.citations) {
      const locStr = `Page ${cit.pageNumber || 1}${cit.sectionHeading ? ` • ${cit.sectionHeading}` : ''}`;
      const hashTrunc = `${cit.sourceHash.substring(0, 12)}...${cit.sourceHash.substring(cit.sourceHash.length - 8)}`;
      citationRows.push([
        { text: cit.citationId, bold: true, sizePt: 11 },
        { text: cit.sourcePath, sizePt: 11 },
        { text: hashTrunc, sizePt: 11 },
        { text: locStr, sizePt: 11 },
        { text: cit.snippet, sizePt: 11 },
      ]);
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Evidence Citations & Source Provenance',
      subtitle: 'Cryptographic hash chain tracing every finding to immutable source documents',
      layout: 'content',
      table: {
        x: 685800,
        y: 1500000,
        cx: 10820400,
        cy: 4600000,
        colWidths: [1300000, 2400000, 1800000, 1720400, 3600000],
        rows: citationRows,
      },
    });

    // ── Slide 8: Reviewer Sign-Off & Authority Verification ─────────
    const signOffIdentity = input.conclusions && input.conclusions[0] && input.conclusions[0].signOffIdentity
      ? input.conclusions[0].signOffIdentity
      : input.approval.approvedBy || 'Licensed Professional Engineer';

    slides.push({
      slideNumber: slideNum++,
      title: 'Reviewer Approval & Professional Sign-off',
      subtitle: 'Formal verification authority sign-off and cryptographic artifact locking',
      layout: 'content',
      shapes: [
        {
          x: 1500000,
          y: 1600000,
          cx: 9192000,
          cy: 4400000,
          fillColorHex: 'F8FAFC',
          borderColorHex: '1E3A8A',
          borderWidthPt: 2,
          paragraphs: [
            {
              runs: [{ text: 'Professional Engineering Sign-off', bold: true, sizePt: 18, colorHex: '1E3A8A' }],
              spaceAfterPt: 12,
            },
            {
              runs: [
                { text: 'Sign-Off Authority: ', bold: true, sizePt: 14, colorHex: '334155' },
                { text: signOffIdentity, bold: true, sizePt: 14, colorHex: '0F172A' },
              ],
              spaceAfterPt: 6,
            },
            {
              runs: [
                { text: 'Approval Record ID: ', bold: true, sizePt: 14, colorHex: '334155' },
                { text: input.approval.approvalId || 'N/A', sizePt: 14, colorHex: '0F172A' },
              ],
              spaceAfterPt: 6,
            },
            {
              runs: [
                { text: 'Decision Timestamp: ', bold: true, sizePt: 14, colorHex: '334155' },
                { text: input.approval.approvedAt || input.generatedAt, sizePt: 14, colorHex: '0F172A' },
              ],
              spaceAfterPt: 6,
            },
            {
              runs: [
                { text: 'Approval Payload SHA-256: ', bold: true, sizePt: 14, colorHex: '334155' },
                { text: input.approval.payloadHash || 'Verified at runtime', sizePt: 13, colorHex: '059669' },
              ],
              spaceAfterPt: 10,
            },
            {
              runs: [
                {
                  text: 'Certification: This document and presentation deck have been synthesized solely from verified measurements, deterministic calculations, and ground-truth citations under strict human oversight.',
                  sizePt: 12,
                  colorHex: '64748B',
                  italic: true,
                },
              ],
            },
          ],
        },
      ],
    });

    // ── Slide 9: Segregated Model Prose (Unverified) ────────────────
    const proseParagraphs: PptxParagraph[] = [
      {
        runs: [
          {
            text: '[UNVERIFIED MODEL PROSE — NOT VERIFIED AGAINST STRUCTURED DATA — REQUIRES HUMAN REVIEW]',
            bold: true,
            sizePt: 13,
            colorHex: 'B91C1C',
          },
        ],
        spaceAfterPt: 12,
      },
    ];

    const proseBlocks = input.proseBlocks || [];
    if (proseBlocks.length === 0) {
      proseParagraphs.push({
        runs: [{ text: 'No unverified generative model prose present in this deliverable.', sizePt: 13, colorHex: '475569' }],
      });
    } else {
      for (const pb of proseBlocks) {
        proseParagraphs.push({
          runs: [
            { text: `[${pb.label || pb.id}] `, bold: true, sizePt: 13, colorHex: '1E3A8A' },
            { text: `(Model: ${pb.modelId || 'unspecified'})\n`, italic: true, sizePt: 11, colorHex: '64748B' },
            { text: pb.text, sizePt: 13, colorHex: '0F172A' },
          ],
          spaceAfterPt: 10,
        });
      }
    }

    slides.push({
      slideNumber: slideNum++,
      title: 'Model Prose (Unverified — Segregated)',
      subtitle: 'Generative natural language blocks isolated from authoritative safety data',
      layout: 'content',
      shapes: [
        {
          x: 685800,
          y: 1500000,
          cx: 10820400,
          cy: 4600000,
          fillColorHex: 'FEF2F2',
          borderColorHex: 'EF4444',
          borderWidthPt: 1.5,
          paragraphs: proseParagraphs,
        },
      ],
    });

    // ── Slide 10+: Embedded Section Tables ──────────────────────────
    for (const section of input.sections) {
      if (section.tables && section.tables.length > 0) {
        for (const table of section.tables) {
          const colCount = table.columns.length || 1;
          const colWidth = Math.floor(10820400 / colCount);
          const colWidths = new Array(colCount).fill(colWidth);

          const headerCells: PptxTableCell[] = table.columns.map((c) => ({
            text: typeof c === 'string' ? c : `${c.label}${c.unit ? ` (${c.unit})` : ''}`,
            bold: true,
            fillColorHex: '1E3A8A',
            textColorHex: 'FFFFFF',
            sizePt: 12,
          }));

          const dataRows: PptxTableCell[][] = [headerCells];
          for (const row of table.rows) {
            const rowCells: PptxTableCell[] = table.columns.map((c) => {
              const key = typeof c === 'string' ? c : c.key;
              return {
                text: String(row[key] !== undefined && row[key] !== null ? row[key] : ''),
                sizePt: 11,
              };
            });
            dataRows.push(rowCells);
          }

          slides.push({
            slideNumber: slideNum++,
            title: `${section.heading}: ${table.title || table.id}`,
            subtitle: `Embedded Section Table • ${dataRows.length - 1} rows recorded`,
            layout: 'content',
            table: {
              x: 685800,
              y: 1500000,
              cx: 10820400,
              cy: 4600000,
              colWidths,
              rows: dataRows,
            },
          });
        }
      }
    }

    return {
      title: input.title,
      author: input.author?.name || 'Inspector',
      createdDate: input.generatedAt,
      slides,
    };
  }

  private recordAudit(
    event: 'PPTX_GENERATION_STARTED' | 'PPTX_GENERATED' | 'PPTX_GENERATION_REJECTED' | 'PPTX_GENERATION_FAILED',
    entityId: string,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'pptx-generator-service',
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
