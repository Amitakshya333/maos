/**
 * F9-01: Sovereignty Boundary Service
 *
 * Manages the definition, cryptographic sealing, disk persistence,
 * and fail-closed validation of the MAOS Threat & Measurement Boundary.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import {
  SovereigntyBoundary,
  BoundaryValidationResult,
  SovereigntyBoundaryError,
  SOVEREIGNTY_BOUNDARY_ERROR_CODES,
  PROHIBITED_SOVEREIGNTY_CLAIMS,
  STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
  createIndustrialSovereigntyBoundary,
  validateSovereigntyBoundary,
  computeCanonicalBoundaryHash,
  CreateIndustrialBoundaryOptions,
} from '../domain/sovereignty-boundary';

export interface SovereigntyBoundaryServiceOptions {
  readonly auditService?: AuditService;
}

export class SovereigntyBoundaryService {
  private readonly boundariesDir: string;
  private readonly auditService?: AuditService;

  constructor(
    private readonly projectRoot: string,
    options: SovereigntyBoundaryServiceOptions = {},
  ) {
    this.boundariesDir = path.join(this.projectRoot, '.maos', 'boundaries');
    this.auditService = options.auditService;
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.boundariesDir)) {
      fs.mkdirSync(this.boundariesDir, { recursive: true });
    }
  }

  /**
   * Retrieves or initializes the active SovereigntyBoundary for a project.
   */
  public getActiveBoundary(projectId = 'default'): SovereigntyBoundary {
    const boundaryPath = path.join(this.boundariesDir, `${projectId}.boundary.json`);
    if (fs.existsSync(boundaryPath)) {
      try {
        const raw = fs.readFileSync(boundaryPath, 'utf8');
        const parsed = JSON.parse(raw);
        const val = this.verifyBoundary(parsed, { expectedProjectId: projectId });
        if (val.valid) {
          return parsed;
        }
      } catch (err: any) {
        // Fall through to re-freeze valid boundary if disk artifact is invalid
      }
    }

    return this.freezeBoundary(projectId);
  }

  /**
   * Creates, seals, and persists a canonical SovereigntyBoundary.
   */
  public freezeBoundary(
    projectId: string,
    options: CreateIndustrialBoundaryOptions = {},
  ): SovereigntyBoundary {
    if (!projectId || !projectId.trim()) {
      throw new SovereigntyBoundaryError(
        SOVEREIGNTY_BOUNDARY_ERROR_CODES.AMBIGUOUS_SCOPE,
        'Cannot freeze boundary without an explicit projectId.',
      );
    }

    this.ensureDirectory();

    const boundary = createIndustrialSovereigntyBoundary(projectId, options);

    const validation = validateSovereigntyBoundary(boundary, { expectedProjectId: projectId });
    if (!validation.valid) {
      throw new SovereigntyBoundaryError(
        SOVEREIGNTY_BOUNDARY_ERROR_CODES.INVALID_BOUNDARY_SCHEMA,
        `Constructed invalid boundary: ${validation.errors.join('; ')}`,
        { errors: validation.errors },
      );
    }

    // Persist to disk
    const targetFile = path.join(this.boundariesDir, `${projectId}.boundary.json`);
    fs.writeFileSync(targetFile, JSON.stringify(boundary, null, 2), 'utf8');

    // Record privacy-safe audit record without leaking secrets
    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'sovereignty-boundary',
          data: {
            event: 'SOVEREIGNTY_BOUNDARY_FROZEN',
            boundaryId: boundary.boundaryId,
            boundaryHash: boundary.boundaryHash,
            projectId: boundary.projectId,
            profileMode: boundary.profileMode,
            processCount: boundary.monitoredProcesses.length,
            endpointCount: boundary.approvedEndpoints.length,
            exclusionCount: boundary.excludedInfrastructure.length,
          },
        });
      } catch {
        // Audit failure must not crash service
      }
    }

    return boundary;
  }

  /**
   * Verifies an existing boundary against schema, project context, and wording invariants.
   */
  public verifyBoundary(
    boundary: SovereigntyBoundary,
    context?: { expectedProjectId?: string },
  ): BoundaryValidationResult {
    const result = validateSovereigntyBoundary(boundary, context);

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: result.valid ? 'endpoint' : 'warning',
          source: 'sovereignty-boundary',
          data: {
            event: 'SOVEREIGNTY_BOUNDARY_VERIFIED',
            boundaryId: boundary?.boundaryId ?? 'unknown',
            boundaryHash: boundary?.boundaryHash ?? 'unknown',
            valid: result.valid,
            errorCount: result.errors.length,
          },
        });
      } catch {
        // Audit failure must not crash service
      }
    }

    return result;
  }

  /**
   * Validates a candidate sovereignty claim text against prohibited absolute assertions.
   */
  public validateClaim(claimText: string): { valid: boolean; allowed: boolean; reason?: string } {
    if (!claimText || typeof claimText !== 'string' || !claimText.trim()) {
      return { valid: false, allowed: false, reason: 'Claim text must be a non-empty string.' };
    }

    const lower = claimText.toLowerCase();
    for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
      if (lower.includes(prohibited)) {
        return {
          valid: false,
          allowed: false,
          reason: `PROHIBITED_CLAIM_DETECTED: Claim contains prohibited absolute guarantee "${prohibited}". Only measured factual statements are permitted.`,
        };
      }
    }

    return { valid: true, allowed: true };
  }

  /**
   * Closes an active measurement interval, recording the duration and endedAt timestamp.
   */
  public closeMeasurementInterval(
    projectId: string,
    endCondition = 'TASK_COMPLETED',
  ): SovereigntyBoundary {
    const active = this.getActiveBoundary(projectId);
    if (!active.measurementInterval.isActive) {
      return active;
    }

    const endedAt = new Date().toISOString();
    const startedAt = active.measurementInterval.startedAt || active.createdAt;
    const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());

    const updatedInterval = {
      ...active.measurementInterval,
      endCondition,
      endedAt,
      durationMs,
      isActive: false,
    };

    const draft: Omit<SovereigntyBoundary, 'boundaryHash'> = {
      ...active,
      measurementInterval: updatedInterval,
    };

    const boundaryHash = computeCanonicalBoundaryHash(draft);

    const closedBoundary: SovereigntyBoundary = Object.freeze({
      ...draft,
      boundaryHash,
    });

    const targetFile = path.join(this.boundariesDir, `${projectId}.boundary.json`);
    fs.writeFileSync(targetFile, JSON.stringify(closedBoundary, null, 2), 'utf8');

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'sovereignty-boundary',
          data: {
            event: 'SOVEREIGNTY_INTERVAL_CLOSED',
            boundaryId: closedBoundary.boundaryId,
            boundaryHash: closedBoundary.boundaryHash,
            projectId: closedBoundary.projectId,
            durationMs,
            endCondition,
          },
        });
      } catch {
        // Audit failure must not crash service
      }
    }

    return closedBoundary;
  }
}
