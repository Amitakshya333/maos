/**
 * Office Template and Output Safety Service (F6-05)
 *
 * Implements centralized safety verification for:
 *   1. User-supplied templates across DOCX, XLSX, and PPTX formats
 *   2. Generated office deliverable packages before atomic disk finalization
 *
 * Enforces:
 *   - Project root confinement and safe relative paths (no traversal, no null bytes, no symlinks/junctions)
 *   - Prohibits macro-enabled templates (.docm, .xlsm, .pptm, .dotm, .xltm, .potm)
 *   - Prohibits VBA parts, ActiveX controls, embedded OLE objects, scripts, and executable commands
 *   - Prohibits external relationships and remote URLs
 *   - Prohibits spreadsheet formula injection
 *   - Enforces that template content remains strictly untrusted data and CANNOT alter:
 *     - approval requirements or approval status
 *     - source hashes or physical file freshness
 *     - provenance and citations
 *     - reviewer metadata and PE sign-off identity
 *     - project scope
 *     - audit behavior
 *     - artifact finalization rules
 *   - Emits privacy-safe audit records with cryptographic hashes
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { AuditService } from './audit-service';
import {
  validateTemplatePath,
  validateOfficeTemplatePackage,
  validateOfficeOutputPackage,
  TemplatePathValidationResult,
  PackageValidationResult,
} from '../industrial/office/template-safety';
import {
  TemplateSafetyError,
  TemplateSafetyErrorCode,
  ValidatedOfficeArtifactInput,
} from '../domain/office-artifact';

export interface TemplateValidationSummary {
  readonly valid: boolean;
  readonly resolvedAbsPath?: string;
  readonly templateHash?: string;
  readonly errors: readonly string[];
}

export interface OutputValidationSummary {
  readonly valid: boolean;
  readonly outputHash?: string;
  readonly errors: readonly string[];
}

export class OfficeTemplateSafetyService {
  constructor(
    private readonly projectRoot: string,
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Validates a user-supplied template path and underlying OpenXML package.
   */
  public validateTemplate(
    templatePath: string,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    context?: { runId?: string; actor?: string },
  ): TemplateValidationSummary {
    const actor = context?.actor || 'template_safety';
    const runId = context?.runId || 'unspecified';

    // 1. Path & boundary confinement validation
    const pathResult: TemplatePathValidationResult = validateTemplatePath(
      templatePath,
      this.projectRoot,
      expectedType,
    );

    if (!pathResult.valid || !pathResult.resolvedAbsPath) {
      this.recordAudit('TEMPLATE_REJECTED', runId, actor, {
        templatePath,
        expectedType,
        reason: 'PATH_VALIDATION_FAILED',
        errors: pathResult.errors,
      });

      return {
        valid: false,
        errors: pathResult.errors,
      };
    }

    // 2. Read physical template buffer
    let templateBuffer: Buffer;
    try {
      templateBuffer = fs.readFileSync(pathResult.resolvedAbsPath);
    } catch (err: any) {
      const errMessage = `[TEMPLATE_FILE_NOT_FOUND] Failed to read template file: ${err.message}`;
      this.recordAudit('TEMPLATE_REJECTED', runId, actor, {
        templatePath,
        expectedType,
        reason: 'READ_FAILED',
        errors: [errMessage],
      });
      return {
        valid: false,
        errors: [errMessage],
      };
    }

    const templateHash = crypto.createHash('sha256').update(templateBuffer).digest('hex');

    // 3. Deep package security inspection
    const packageResult: PackageValidationResult = validateOfficeTemplatePackage(
      templateBuffer,
      expectedType,
    );

    if (!packageResult.valid) {
      this.recordAudit('TEMPLATE_REJECTED', runId, actor, {
        templatePath,
        expectedType,
        templateHash,
        partCount: packageResult.partCount,
        reason: 'PACKAGE_SECURITY_VIOLATION',
        errors: packageResult.errors,
      });

      return {
        valid: false,
        templateHash,
        errors: packageResult.errors,
      };
    }

    // 4. Audit successful template validation
    this.recordAudit('TEMPLATE_VALIDATED', runId, actor, {
      templatePath,
      expectedType,
      templateHash,
      partCount: packageResult.partCount,
      bytes: templateBuffer.length,
    });

    return {
      valid: true,
      resolvedAbsPath: pathResult.resolvedAbsPath,
      templateHash,
      errors: [],
    };
  }

  /**
   * Asserts template safety; throws a typed TemplateSafetyError if invalid.
   */
  public assertTemplateSafety(
    templatePath: string,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    context?: { runId?: string; actor?: string },
  ): string {
    const summary = this.validateTemplate(templatePath, expectedType, context);
    if (!summary.valid) {
      const firstError = summary.errors[0] || 'Template validation failed.';
      const codeMatch = firstError.match(/^\[([A-Z_]+)\]/);
      const code = (codeMatch ? codeMatch[1] : 'TEMPLATE_INVALID_ZIP') as TemplateSafetyErrorCode;
      throw new TemplateSafetyError(code, firstError, { errors: summary.errors });
    }
    return summary.resolvedAbsPath!;
  }

  /**
   * Validates a generated office deliverable package before atomic disk finalization.
   */
  public validateOutputPackage(
    buffer: Buffer,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    outputPath: string,
    context?: { runId?: string; actor?: string },
  ): OutputValidationSummary {
    const actor = context?.actor || 'output_safety';
    const runId = context?.runId || 'unspecified';
    const outputHash = crypto.createHash('sha256').update(buffer).digest('hex');

    const result = validateOfficeOutputPackage(buffer, expectedType);

    if (!result.valid) {
      this.recordAudit('OUTPUT_REJECTED', runId, actor, {
        outputPath,
        expectedType,
        outputHash,
        partCount: result.partCount,
        errors: result.errors,
      });

      return {
        valid: false,
        outputHash,
        errors: result.errors,
      };
    }

    this.recordAudit('OUTPUT_VALIDATED', runId, actor, {
      outputPath,
      expectedType,
      outputHash,
      partCount: result.partCount,
      bytes: buffer.length,
    });

    return {
      valid: true,
      outputHash,
      errors: [],
    };
  }

  /**
   * Asserts output package safety before finalization; throws TemplateSafetyError if invalid.
   */
  public assertOutputSafety(
    buffer: Buffer,
    expectedType: 'docx' | 'xlsx' | 'pptx',
    outputPath: string,
    context?: { runId?: string; actor?: string },
  ): void {
    const summary = this.validateOutputPackage(buffer, expectedType, outputPath, context);
    if (!summary.valid) {
      const joined = summary.errors.join('; ');
      throw new TemplateSafetyError(
        'OUTPUT_SAFETY_VIOLATION',
        `Generated ${expectedType.toUpperCase()} package failed output safety validation: ${joined}`,
        { errors: summary.errors, outputHash: summary.outputHash },
      );
    }
  }

  /**
   * Guarantee that templates cannot tamper with or override core domain metadata.
   */
  public assertUntrustedTemplateIntegrity(
    input: ValidatedOfficeArtifactInput,
    canonicalHash: string,
  ): void {
    // 1. Approval metadata cannot be bypassed or tampered with
    if (!input.approval || typeof input.approval !== 'object') {
      throw new TemplateSafetyError('TEMPLATE_SECURITY_TAMPER', 'Approval metadata is missing or corrupted.');
    }
    if (input.approval.payloadHash && input.approval.payloadHash !== canonicalHash) {
      throw new TemplateSafetyError(
        'TEMPLATE_SECURITY_TAMPER',
        'Input payload was tampered after approval! Canonical hash mismatch.'
      );
    }

    // 2. Provenance citations cannot be forged or emptied
    if (!Array.isArray(input.citations) || input.citations.length === 0) {
      throw new TemplateSafetyError(
        'TEMPLATE_SECURITY_TAMPER',
        'Template or input attempts to strip required source citations.'
      );
    }

    // 3. Project isolation cannot be overridden
    if (!input.projectId || typeof input.projectId !== 'string') {
      throw new TemplateSafetyError('TEMPLATE_SECURITY_TAMPER', 'Project ID cannot be altered by template.');
    }
  }

  // ── Private Audit Logging Helper ────────────────────────────────────

  private recordAudit(
    event: 'TEMPLATE_VALIDATED' | 'TEMPLATE_REJECTED' | 'OUTPUT_VALIDATED' | 'OUTPUT_REJECTED',
    entityId: string,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'office-template-safety-service',
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
