/**
 * MAOS Industrial — Office Visual Review Service (F6-06)
 *
 * Provides application-level visual quality, layout bounds, readability,
 * and visual regression review for generated DOCX, XLSX, and PPTX packages.
 *
 * Enforces:
 * 1. Air-gapped, offline visual and layout bounds inspection.
 * 2. Determinism assertion across repeated generations.
 * 3. Privacy-safe audit events without raw content or credentials.
 * 4. Fail-closed rejection on layout overflow, out-of-bounds rendering, or unsegregated prose.
 */

import type { AuditService } from './audit-service';
import type { OfficeArtifactType } from '../domain/office-artifact';
import {
  reviewOfficePackageVisuals,
  OfficeVisualReviewReport,
  OfficeVisualReviewOptions,
  VisualReviewError,
  VisualReviewIssue,
} from '../industrial/office/visual-review';

export {
  OfficeVisualReviewReport,
  OfficeVisualReviewOptions,
  VisualReviewError,
  VisualReviewIssue,
};

export class OfficeVisualReviewService {
  constructor(
    private readonly projectRoot: string,
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Reviews the visual, layout, and structural quality of an in-memory Office deliverable package.
   */
  public reviewDeliverable(
    buffer: Buffer,
    artifactType: OfficeArtifactType,
    options: OfficeVisualReviewOptions = {},
  ): OfficeVisualReviewReport {
    const report = reviewOfficePackageVisuals(buffer, artifactType, options);

    // Record privacy-safe audit record
    if (this.auditService) {
      const passed = report.verdict === 'approved';
      this.auditService.recordAuditEvent({
        category: 'tool',
        source: 'office-visual-review-service',
        data: {
          event: passed ? 'VISUAL_REVIEW_PASSED' : 'VISUAL_REVIEW_FAILED',
          artifactType,
          overallScore: report.overallScore,
          verdict: report.verdict,
          issueCount: report.issues.length,
          errorCount: report.issues.filter((i) => i.severity === 'error').length,
          warningCount: report.issues.filter((i) => i.severity === 'warning').length,
          visualSnapshotHash: report.visualSnapshotHash,
          overflowDetected: report.layoutBounds.overflowDetected,
          timestamp: report.reviewedAt,
        },
      });
    }

    return report;
  }

  /**
   * Asynchronous visual review wrapper.
   */
  public async reviewDeliverableAsync(
    buffer: Buffer,
    artifactType: OfficeArtifactType,
    options: OfficeVisualReviewOptions = {},
  ): Promise<OfficeVisualReviewReport> {
    return this.reviewDeliverable(buffer, artifactType, options);
  }

  /**
   * Asserts that a deliverable passes visual review with zero blocking layout or safety errors.
   * Throws VisualReviewError if the report contains errors or has a rejected verdict.
   */
  public assertVisualAcceptance(
    buffer: Buffer,
    artifactType: OfficeArtifactType,
    options: OfficeVisualReviewOptions = {},
  ): OfficeVisualReviewReport {
    const report = this.reviewDeliverable(buffer, artifactType, options);
    const errors = report.issues.filter((i) => i.severity === 'error');

    if (errors.length > 0 || report.verdict === 'rejected') {
      const first = errors[0] || report.issues[0];
      throw new VisualReviewError(
        first ? first.code : 'LAYOUT_OVERFLOW',
        `Visual review failed with score ${report.overallScore}/100: ${first ? first.message : 'Visual acceptance rejected.'}`,
        report.issues,
      );
    }

    return report;
  }

  /**
   * Asserts that two repeated generations from identical inputs produce identical visual layout snapshots.
   */
  public assertDeterminism(
    run1Buffer: Buffer,
    run2Buffer: Buffer,
    artifactType: OfficeArtifactType,
  ): void {
    const report1 = this.reviewDeliverable(run1Buffer, artifactType);
    const report2 = this.reviewDeliverable(run2Buffer, artifactType);

    if (report1.visualSnapshotHash !== report2.visualSnapshotHash) {
      throw new VisualReviewError(
        'LAYOUT_OVERFLOW',
        `Visual layout nondeterminism detected between repeated runs. Hash 1: '${report1.visualSnapshotHash}', Hash 2: '${report2.visualSnapshotHash}'.`,
      );
    }
  }
}
