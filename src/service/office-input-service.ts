/**
 * MAOS Industrial — Office Input Validation Service (F6-01)
 *
 * Implements server-side validation, cross-project confinement, cryptographic
 * freshness verification, stale-input detection, and privacy-preserving audit logging
 * for office deliverable inputs (DOCX, XLSX, PPTX).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  ValidatedOfficeArtifactInput,
  OfficeInputValidationResult,
  validateOfficeArtifactInput,
  computeOfficeInputHash,
  isSafeIndustrialPath,
} from '../domain/office-artifact';
import { ArtifactService } from './artifact-service';
import { ApprovalService } from './approval-service';
import { AuditService } from './audit-service';

export interface OfficeInputValidationOptions {
  /**
   * If true, skips active project ID matching against the local projectRoot configuration.
   * Default is false (strictly enforces project boundary).
   */
  readonly allowForeignProject?: boolean;
  /**
   * If true, skips audit recording during validation.
   */
  readonly skipAudit?: boolean;
}

export interface OfficeInputFreshnessResult {
  readonly fresh: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly verifiedSourceCount: number;
  readonly checkedAt: string;
}

export class OfficeInputService {
  constructor(
    private readonly projectRoot: string,
    private readonly artifactService?: ArtifactService,
    private readonly approvalService?: ApprovalService,
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Resolve project ID from configuration or folder name.
   */
  public resolveProjectId(explicitId?: string): string {
    if (explicitId && explicitId.trim().length > 0) {
      return explicitId.trim();
    }
    const configPath = path.join(this.projectRoot, '.maos', 'maos.config.json');
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (raw.projectName && typeof raw.projectName === 'string') {
          return raw.projectName;
        }
        if (raw.id && typeof raw.id === 'string') {
          return raw.id;
        }
      } catch {
        /* fallback to basename */
      }
    }
    return path.basename(path.resolve(this.projectRoot));
  }

  /**
   * Validates an office artifact input against pure domain constraints and project boundaries.
   */
  public validateInput(
    rawInput: unknown,
    options: OfficeInputValidationOptions = {},
  ): OfficeInputValidationResult {
    // 1. Pure validation
    const baseResult = validateOfficeArtifactInput(rawInput);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];

    let canonicalHash = baseResult.canonicalHash;

    if (rawInput && typeof rawInput === 'object') {
      const input = rawInput as Record<string, unknown>;

      // 2. Project confinement
      if (!options.allowForeignProject && typeof input.projectId === 'string') {
        const activeProjectId = this.resolveProjectId();
        if (input.projectId !== activeProjectId) {
          errors.push(
            `[CROSS_PROJECT_FORBIDDEN] Input projectId '${input.projectId}' does not match active project '${activeProjectId}'`,
          );
        }
      }
    }

    const isValid = errors.length === 0;

    // Recalculate or clear hash if errors occurred
    if (!isValid) {
      canonicalHash = undefined;
    } else if (!canonicalHash && rawInput && typeof rawInput === 'object') {
      try {
        canonicalHash = computeOfficeInputHash(rawInput as ValidatedOfficeArtifactInput);
      } catch (e: any) {
        errors.push(`Failed to compute canonical hash: ${e.message}`);
      }
    }

    // 3. Privacy-preserving audit event
    if (!options.skipAudit && this.auditService && rawInput && typeof rawInput === 'object') {
      const input = rawInput as Record<string, unknown>;
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'office-input-service',
        data: {
          event: isValid ? 'OFFICE_INPUT_VALIDATED' : 'OFFICE_INPUT_REJECTED',
          inputHash: canonicalHash || null,
          artifactType: input.artifactType || null,
          projectId: input.projectId || null,
          errorCount: errors.length,
          warningCount: warnings.length,
          timestamp: new Date().toISOString(),
        },
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      canonicalHash,
    };
  }

  /**
   * Verifies the cryptographic freshness of all source documents, artifacts, and approvals referenced by the input.
   * Invalidates input if disk sources or artifacts have changed since citations were generated.
   */
  public verifyFreshnessSync(
    input: ValidatedOfficeArtifactInput,
  ): OfficeInputFreshnessResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let verifiedSourceCount = 0;
    const checkedAt = new Date().toISOString();

    // 1. Verify citations against source files on disk
    for (const citation of input.citations) {
      if (!isSafeIndustrialPath(citation.sourcePath)) {
        errors.push(`[PATH_TRAVERSAL_DETECTED] Citation ${citation.citationId} has unconfined path: ${citation.sourcePath}`);
        continue;
      }

      const diskPath = path.join(this.projectRoot, citation.sourcePath);
      if (!fs.existsSync(diskPath)) {
        errors.push(
          `[SOURCE_NOT_FOUND] Source file for citation '${citation.citationId}' does not exist on disk: ${citation.sourcePath}`,
        );
        continue;
      }

      try {
        const fileBytes = fs.readFileSync(diskPath);
        const actualHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
        if (actualHash.toLowerCase() !== citation.sourceHash.toLowerCase()) {
          errors.push(
            `[STALE_SOURCE_HASH] Source file '${citation.sourcePath}' on disk (SHA-256: ${actualHash.slice(0, 12)}...) does not match citation '${citation.citationId}' sourceHash (${citation.sourceHash.slice(0, 12)}...)`,
          );
        } else {
          verifiedSourceCount++;
        }
      } catch (err: any) {
        errors.push(`[SOURCE_NOT_FOUND] Failed to read source file '${citation.sourcePath}': ${err.message}`);
      }
    }

    // 2. Verify sourceArtifactIds against ArtifactService
    if (this.artifactService && input.sourceArtifactIds && input.sourceArtifactIds.length > 0) {
      for (const artifactId of input.sourceArtifactIds) {
        const artifact = this.artifactService.getArtifact(artifactId);
        if (!artifact) {
          errors.push(`[SOURCE_NOT_FOUND] Referenced source artifact '${artifactId}' not found in artifact store`);
          continue;
        }

        // If sourceHashes has an entry for this artifactId, verify hash
        if (input.sourceHashes && input.sourceHashes[artifactId]) {
          const expectedHash = input.sourceHashes[artifactId];
          if (artifact.hash.toLowerCase() !== expectedHash.toLowerCase()) {
            errors.push(
              `[STALE_SOURCE_HASH] Artifact '${artifactId}' current hash (${artifact.hash.slice(0, 12)}...) does not match expected hash (${expectedHash.slice(0, 12)}...)`,
            );
          }
        }
      }
    }

    // 3. Verify Approval Status in ApprovalService
    if (input.approval.required) {
      if (!input.approval.approvalId) {
        errors.push('[APPROVAL_REQUIRED] Approval is marked required but no approvalId is provided');
      } else if (this.approvalService) {
        const storedApproval = this.approvalService.getApproval(input.approval.approvalId);
        if (!storedApproval) {
          errors.push(
            `[APPROVAL_REQUIRED] Approval ID '${input.approval.approvalId}' was not found in the approval store`,
          );
        } else if (storedApproval.status !== 'approved') {
          errors.push(
            `[APPROVAL_REQUIRED] Approval '${input.approval.approvalId}' status is '${storedApproval.status}', but 'approved' is required`,
          );
        } else if (input.approval.payloadHash && storedApproval.evidenceId) {
          // If stored approval contains evidence/payload reference, check consistency
          if (storedApproval.evidenceId !== input.approval.payloadHash && storedApproval.evidenceId !== input.runId) {
            warnings.push(
              `Approval evidence ID '${storedApproval.evidenceId}' differs from input payload hash`,
            );
          }
        }
      }
    }

    // 4. Record freshness verification in audit log
    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'office-input-service',
        data: {
          event: errors.length === 0 ? 'OFFICE_INPUT_FRESHNESS_VERIFIED' : 'OFFICE_INPUT_STALE_DETECTED',
          inputHash: input.canonicalHash || computeOfficeInputHash(input),
          artifactType: input.artifactType,
          projectId: input.projectId,
          verifiedSourceCount,
          errorCount: errors.length,
          timestamp: checkedAt,
        },
      });
    }

    return {
      fresh: errors.length === 0,
      errors,
      warnings,
      verifiedSourceCount,
      checkedAt,
    };
  }

  /**
   * Asynchronously verifies freshness of input sources.
   */
  public async verifyFreshness(
    input: ValidatedOfficeArtifactInput,
  ): Promise<OfficeInputFreshnessResult> {
    return Promise.resolve(this.verifyFreshnessSync(input));
  }

  /**
   * Deterministic canonical SHA-256 calculation for office deliverable input.
   */
  public computeCanonicalHash(input: ValidatedOfficeArtifactInput): string {
    return computeOfficeInputHash(input);
  }
}
