/**
 * UI1-10: Evidence Mode Service
 *
 * Implements mode-aware claim enforcement, silent downgrade defense,
 * and review gates for transitions between Evidence/Industrial mode and Brainstorm mode.
 */

import {
  OperationalMode,
  CitedClaim,
  validateOperationalMode,
  validateModeTransition,
  validateCitedClaim,
  normalizeOperationalMode,
  EvidenceValidationResult,
} from '../domain/evidence-mode';
import type { Conversation, Message } from '../domain/schemas';
import type { AuditService } from './audit-service';

export interface PromotionCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly unverifiedClaimCount: number;
}

export class EvidenceModeService {
  constructor(
    private readonly projectRoot: string,
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Validates a cited claim under the requested operational mode.
   */
  validateClaim(claim: unknown, mode: OperationalMode = 'evidence'): EvidenceValidationResult {
    return validateCitedClaim(claim, mode);
  }

  /**
   * Asserts whether a mode transition is permitted, preventing silent downgrades.
   */
  checkModeTransition(
    currentMode: OperationalMode,
    targetMode: OperationalMode,
    confirmed = false,
  ): EvidenceValidationResult {
    return validateModeTransition(currentMode, targetMode, confirmed);
  }

  /**
   * Validates if a conversation can be promoted to a tracked task,
   * checking whether unverified brainstorm claims exist and require review.
   */
  evaluatePromotionReadiness(
    conv: Conversation,
    allowUnreviewedBrainstorm = false,
  ): PromotionCheckResult {
    let unverifiedCount = 0;

    const convMode = conv.mode ? normalizeOperationalMode(conv.mode) : 'evidence';

    for (const msg of conv.messages) {
      if (msg.claims && Array.isArray(msg.claims)) {
        for (const claim of msg.claims) {
          if (claim.isModelGenerated && !claim.verifiedAgainstData) {
            unverifiedCount++;
          }
        }
      }
    }

    if (convMode === 'brainstorm' || unverifiedCount > 0) {
      if (!allowUnreviewedBrainstorm) {
        return {
          allowed: false,
          reason: `BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW: Conversation has ${unverifiedCount} unverified exploratory claim(s). Explicit review confirmation (allowUnreviewedBrainstorm: true) is required before orchestrating tasks.`,
          unverifiedClaimCount: unverifiedCount,
        };
      }
    }

    return {
      allowed: true,
      unverifiedClaimCount: unverifiedCount,
    };
  }

  /**
   * Audits mode-related operations to the immutable audit log.
   */
  recordModeAudit(
    action: string,
    data: Record<string, unknown>,
  ): void {
    if (!this.auditService) return;
    try {
      this.auditService.recordAuditEvent({
        source: 'evidence-mode-service',
        category: 'tool',
        data: {
          action,
          ...data,
          recordedAt: new Date().toISOString(),
        },
      });
    } catch {
      /* fail safe if audit fails */
    }
  }
}
