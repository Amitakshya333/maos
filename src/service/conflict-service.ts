/**
 * F4-06: OCR/VLM Conflict Review Application Service
 *
 * Coordinates multi-source observation comparison, conservative normalization,
 * safety-critical human review gating, atomic artifact persistence,
 * and tamper-evident audit logging.
 *
 * Invariants:
 * 1. OCR facts and VLM interpretations are strictly independent immutable records.
 * 2. Conservative normalization: raw values are preserved; no heuristic substitutions.
 * 3. Safety-critical fields MUST NEVER be auto-resolved; "higher confidence wins" is strictly blocked.
 * 4. Audit events are recorded strictly AFTER atomic artifact finalization.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  ComparableObservation,
  ConflictItem,
  ConflictReport,
  ConflictReportSummary,
  ConflictReviewError,
  HumanReviewInput,
  ResolvedObservation,
  classifyObservationConflict,
  ClassifyConflictOptions,
  validateComparableObservation,
  validateConflictReport,
  validateHumanReviewInput,
  validateResolvedObservation,
} from '../domain/conflict';
import { ArtifactService } from './artifact-service';
import { AuditService } from './audit-service';

export interface CompareObservationsParams {
  readonly projectId: string;
  readonly ocrObservations?: readonly ComparableObservation[];
  readonly visionObservations?: readonly ComparableObservation[];
  readonly options?: ClassifyConflictOptions;
}

export class ConflictReviewService {
  private readonly reportsCache = new Map<string, ConflictReport>();
  private readonly resolvedCache = new Map<string, ResolvedObservation>();

  constructor(
    private readonly projectRoot: string,
    private readonly artifactService: ArtifactService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Pure comparison of OCR and Vision observations without disk persistence.
   */
  public compareObservations(params: CompareObservationsParams): ConflictReport {
    const ocrObsList = params.ocrObservations || [];
    const visionObsList = params.visionObservations || [];
    const allObs = [...ocrObsList, ...visionObsList];

    if (allObs.length === 0) {
      throw new ConflictReviewError(
        'EMPTY_OBSERVATIONS',
        'Cannot perform conflict review on empty observations list.',
      );
    }

    // 1. Cross-Project Isolation Check
    for (const obs of allObs) {
      const val = validateComparableObservation(obs);
      if (!val.valid) {
        throw new ConflictReviewError(
          'VALIDATION_FAILED',
          `Invalid ComparableObservation: ${val.errors.join(', ')}`,
          { observationId: obs.id, errors: val.errors },
        );
      }
      if (obs.projectId !== params.projectId) {
        throw new ConflictReviewError(
          'CROSS_PROJECT_FORBIDDEN',
          `Observation "${obs.id}" belongs to project "${obs.projectId}", which does not match target project "${params.projectId}".`,
          { observationId: obs.id, observationProjectId: obs.projectId, targetProjectId: params.projectId },
        );
      }
    }

    // 2. Source identity integrity: every observation in a report must refer
    // to the same source artifact and hash. Checking only the first item can
    // otherwise label mixed-document evidence as one source.
    const allSourceHashes = new Set(allObs.map(obs => obs.sourceHash));
    const allSourceArtifacts = new Set(allObs.map(obs => obs.sourceArtifactId));
    if (allSourceHashes.size > 1 || allSourceArtifacts.size > 1) {
      throw new ConflictReviewError(
        'SOURCE_HASH_MISMATCH',
        'Cannot compare observations from different source documents or artifacts.',
        {
          sourceHashes: Array.from(allSourceHashes),
          sourceArtifactIds: Array.from(allSourceArtifacts),
        },
      );
    }
    const ocrHash = ocrObsList[0]?.sourceHash;
    const visionHash = visionObsList[0]?.sourceHash;
    if (ocrHash && visionHash && ocrHash !== visionHash) {
      throw new ConflictReviewError(
        'SOURCE_HASH_MISMATCH',
        `Cannot compare observations from different source documents: OCR hash "${ocrHash}" does not match Vision hash "${visionHash}".`,
        { ocrHash, visionHash },
      );
    }

    const effectiveSourceHash = ocrHash || visionHash || 'unknown_source_hash';
    const effectiveSourceArtifactId =
      ocrObsList[0]?.sourceArtifactId || visionObsList[0]?.sourceArtifactId || 'unknown_source_artifact';

    // 3. Group by observation key
    const ocrByKey = new Map<string, ComparableObservation>();
    const visionByKey = new Map<string, ComparableObservation>();

    for (const obs of ocrObsList) {
      ocrByKey.set(obs.key, obs);
    }
    for (const obs of visionObsList) {
      visionByKey.set(obs.key, obs);
    }

    const allKeys = Array.from(new Set([...ocrByKey.keys(), ...visionByKey.keys()]));

    // 4. Classify each key
    const items: ConflictItem[] = allKeys.map((key) => {
      const ocr = ocrByKey.get(key);
      const vision = visionByKey.get(key);
      return classifyObservationConflict(key, ocr, vision, params.options);
    });

    // 5. Compute summary metrics
    const totalItems = items.length;
    const agreeCount = items.filter((i) => i.classification === 'AGREE').length;
    const conflictCount = items.filter((i) =>
      ['CONFLICTING_VALUE', 'CONFLICTING_UNIT', 'CONFLICTING_LOCATION', 'AMBIGUOUS_SOURCE'].includes(i.classification),
    ).length;
    const reviewRequiredCount = items.filter((i) => i.requiresReview).length;
    const ocrOnlyCount = items.filter((i) => i.classification === 'OCR_ONLY').length;
    const visionOnlyCount = items.filter((i) => i.classification === 'VISION_ONLY').length;
    const ambiguousCount = items.filter((i) => i.classification === 'AMBIGUOUS_SOURCE').length;
    const safetyCriticalCount = items.filter((i) => i.isSafetyCritical).length;

    const summary: ConflictReportSummary = {
      totalItems,
      agreeCount,
      conflictCount,
      reviewRequiredCount,
      ocrOnlyCount,
      visionOnlyCount,
      ambiguousCount,
      safetyCriticalCount,
    };

    const status = reviewRequiredCount > 0 ? 'pending_review' : 'auto_resolved';
    const reportId = crypto.randomUUID();

    const report: ConflictReport = {
      schemaVersion: 1,
      id: reportId,
      projectId: params.projectId,
      sourceArtifactId: effectiveSourceArtifactId,
      sourceHash: effectiveSourceHash,
      generatedAt: new Date().toISOString(),
      items,
      summary,
      status,
    };

    const validation = validateConflictReport(report);
    if (!validation.valid) {
      throw new ConflictReviewError(
        'VALIDATION_FAILED',
        `ConflictReport validation failed: ${validation.errors.join(', ')}`,
      );
    }

    return report;
  }

  /**
   * Compares observations, atomically persists report in Safe Artifact Store,
   * and records tamper-evident audit log event.
   */
  public async compareAndPersist(params: CompareObservationsParams): Promise<ConflictReport> {
    const unpersistedReport = this.compareObservations(params);

    // 1. Atomic artifact finalization in Safe Artifact Store
    const relativePath = path.posix.join(
      'evidence',
      'conflicts',
      unpersistedReport.sourceHash,
      `conflict-report-${unpersistedReport.id}.json`,
    );

    const finalized = this.artifactService.finalizeArtifact({
      id: unpersistedReport.id,
      relativePath,
      content: JSON.stringify(unpersistedReport, null, 2),
      type: 'evidence',
      projectId: unpersistedReport.projectId,
    });

    // 2. Append-only audit log strictly AFTER artifact finalization
    this.auditService.recordAuditEvent({
      source: 'conflict_review',
      category: 'tool',
      data: {
        action: 'CONFLICT_REVIEW_CREATED',
        reportId: unpersistedReport.id,
        projectId: unpersistedReport.projectId,
        sourceHash: unpersistedReport.sourceHash,
        sourceArtifactId: unpersistedReport.sourceArtifactId,
        totalItems: unpersistedReport.summary.totalItems,
        conflictCount: unpersistedReport.summary.conflictCount,
        reviewRequiredCount: unpersistedReport.summary.reviewRequiredCount,
        status: unpersistedReport.status,
        outputArtifactId: finalized.id,
        outputRelativePath: finalized.path,
      },
    });

    const report: ConflictReport = {
      ...unpersistedReport,
      artifactId: finalized.id,
      artifactHash: finalized.hash,
    };

    this.reportsCache.set(report.id, report);
    return report;
  }

  /**
   * Human review decision resolution for a specific conflict item.
   */
  public async resolveConflict(input: HumanReviewInput): Promise<ResolvedObservation> {
    // 1. Validate review input schema
    const val = validateHumanReviewInput(input);
    if (!val.valid) {
      throw new ConflictReviewError(
        'VALIDATION_FAILED',
        `Invalid HumanReviewInput: ${val.errors.join(', ')}`,
      );
    }

    // 2. Retrieve parent conflict report
    const report = this.getConflictReport(input.reportId);
    if (!report) {
      throw new ConflictReviewError(
        'REPORT_NOT_FOUND',
        `Conflict report "${input.reportId}" was not found.`,
      );
    }

    // 3. Locate target item
    const item = report.items.find((i) => i.id === input.itemId);
    if (!item) {
      throw new ConflictReviewError(
        'ITEM_NOT_FOUND',
        `Item "${input.itemId}" not found in report "${input.reportId}".`,
      );
    }

    // 4. Validate decision against item observations
    let resolvedValue: string | null = null;
    let resolvedUnit: string | undefined = undefined;
    let status: ResolvedObservation['status'];

    switch (input.decision) {
      case 'accept_ocr':
        if (!item.ocrObservation) {
          throw new ConflictReviewError(
            'INVALID_REVIEW_DECISION',
            `Cannot accept OCR: no OCR observation present for item "${item.id}".`,
          );
        }
        resolvedValue = item.ocrObservation.rawValue;
        resolvedUnit = item.ocrUnit;
        status = 'accepted_ocr';
        break;

      case 'accept_vision':
        if (!item.visionObservation) {
          throw new ConflictReviewError(
            'INVALID_REVIEW_DECISION',
            `Cannot accept Vision: no Vision observation present for item "${item.id}".`,
          );
        }
        resolvedValue = item.visionObservation.rawValue;
        resolvedUnit = item.visionUnit;
        status = 'accepted_vision';
        break;

      case 'enter_corrected_value':
        if (!input.correctedValue || !input.correctedValue.trim()) {
          throw new ConflictReviewError(
            'MISSING_CORRECTION_VALUE',
            `Decision "enter_corrected_value" requires a non-empty correctedValue.`,
          );
        }
        resolvedValue = input.correctedValue.trim();
        resolvedUnit = input.correctedUnit;
        status = 'manually_corrected';
        break;

      case 'mark_unresolved':
        resolvedValue = null;
        status = 'unresolved';
        break;

      case 'reject_both':
        resolvedValue = null;
        status = 'rejected';
        break;

      default:
        throw new ConflictReviewError(
          'INVALID_REVIEW_DECISION',
          `Unknown resolution decision: ${input.decision}`,
        );
    }

    const resolvedId = crypto.randomUUID();
    const resolvedAt = input.timestamp || new Date().toISOString();

    // 5. Build ResolvedObservation preserving full provenance
    const unfinalizedResolved: ResolvedObservation = {
      schemaVersion: 1,
      id: resolvedId,
      reportId: input.reportId,
      itemId: input.itemId,
      projectId: report.projectId,
      key: item.key,
      resolvedValue,
      resolvedUnit,
      status,
      reviewerDecision: input.decision,
      reviewerId: input.reviewerId,
      rationale: input.rationale,
      resolvedAt,
      ocrSource: item.ocrObservation
        ? {
            artifactId: item.ocrObservation.sourceArtifactId,
            sourceHash: item.ocrObservation.sourceHash,
            engine: item.ocrObservation.engineOrModel,
            engineVersion: item.ocrObservation.versionOrRevision,
            rawValue: item.ocrObservation.rawValue,
            confidence: item.ocrObservation.confidence,
            bbox: item.ocrObservation.bbox,
          }
        : undefined,
      visionSource: item.visionObservation
        ? {
            artifactId: item.visionObservation.sourceArtifactId,
            sourceHash: item.visionObservation.sourceHash,
            modelId: item.visionObservation.engineOrModel,
            modelRevision: item.visionObservation.versionOrRevision,
            rawValue: item.visionObservation.rawValue,
            confidence: item.visionObservation.confidence,
            bbox: item.visionObservation.bbox,
          }
        : undefined,
      conflictClassification: item.classification,
    };

    const resVal = validateResolvedObservation(unfinalizedResolved);
    if (!resVal.valid) {
      throw new ConflictReviewError(
        'VALIDATION_FAILED',
        `ResolvedObservation validation failed: ${resVal.errors.join(', ')}`,
      );
    }

    // 6. Safe Artifact Store atomic finalization
    const relativePath = path.posix.join(
      'evidence',
      'resolved',
      report.sourceHash,
      `resolved-${resolvedId}.json`,
    );

    const finalized = this.artifactService.finalizeArtifact({
      id: resolvedId,
      relativePath,
      content: JSON.stringify(unfinalizedResolved, null, 2),
      type: 'evidence',
      projectId: report.projectId,
    });

    // 7. Append-only audit record strictly AFTER artifact finalization
    this.auditService.recordAuditEvent({
      source: 'conflict_review',
      category: 'tool',
      data: {
        action: 'CONFLICT_RESOLVED',
        reportId: input.reportId,
        itemId: input.itemId,
        key: item.key,
        decision: input.decision,
        reviewerId: input.reviewerId,
        resolvedValue,
        status,
        outputArtifactId: finalized.id,
        outputRelativePath: finalized.path,
      },
    });

    const finalResolved: ResolvedObservation = {
      ...unfinalizedResolved,
      artifactId: finalized.id,
      artifactHash: finalized.hash,
    };

    this.resolvedCache.set(finalResolved.id, finalResolved);
    return finalResolved;
  }

  /**
   * Attempt to auto-resolve an item. Throws error if safety critical or review required.
   */
  public autoResolveItem(item: ConflictItem): string {
    if (item.isSafetyCritical) {
      throw new ConflictReviewError(
        'SAFETY_CRITICAL_AUTO_RESOLVE_BLOCKED',
        `Item "${item.key}" is SAFETY-CRITICAL and cannot be auto-resolved. Human review is mandatory.`,
      );
    }
    if (item.requiresReview) {
      throw new ConflictReviewError(
        'SAFETY_CRITICAL_AUTO_RESOLVE_BLOCKED',
        `Item "${item.key}" requires review (classification: ${item.classification}) and cannot be auto-resolved.`,
      );
    }
    if (item.classification !== 'AGREE') {
      throw new ConflictReviewError(
        'SAFETY_CRITICAL_AUTO_RESOLVE_BLOCKED',
        `Item "${item.key}" has classification "${item.classification}" and cannot be auto-resolved.`,
      );
    }

    return item.normalizedOcrValue || item.normalizedVisionValue || item.ocrObservation?.rawValue || '';
  }

  /**
   * Safe retrieval of a ConflictReport by ID.
   */
  public getConflictReport(reportId: string): ConflictReport | null {
    if (this.reportsCache.has(reportId)) {
      return this.reportsCache.get(reportId)!;
    }

    try {
      const art = this.artifactService.getArtifact(reportId);
      if (art) {
        const { content } = this.artifactService.getArtifactContent(art.id);
        const parsed = JSON.parse(content) as ConflictReport;
        this.reportsCache.set(reportId, parsed);
        return parsed;
      }
    } catch {
      // Fallback search in evidence/conflicts
    }

    const conflictsDir = path.join(this.projectRoot, 'evidence', 'conflicts');
    if (fs.existsSync(conflictsDir)) {
      const findInDir = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findInDir(full);
            if (found) return found;
          } else if (entry.isFile() && entry.name.includes(reportId) && entry.name.endsWith('.json')) {
            return full;
          }
        }
        return null;
      };

      const foundPath = findInDir(conflictsDir);
      if (foundPath) {
        try {
          const content = fs.readFileSync(foundPath, 'utf-8');
          const parsed = JSON.parse(content) as ConflictReport;
          this.reportsCache.set(reportId, parsed);
          return parsed;
        } catch {}
      }
    }

    return null;
  }

  /**
   * Safe retrieval of a ResolvedObservation by ID.
   */
  public getResolvedObservation(resolvedId: string): ResolvedObservation | null {
    if (this.resolvedCache.has(resolvedId)) {
      return this.resolvedCache.get(resolvedId)!;
    }

    try {
      const art = this.artifactService.getArtifact(resolvedId);
      if (art) {
        const { content } = this.artifactService.getArtifactContent(art.id);
        const parsed = JSON.parse(content) as ResolvedObservation;
        this.resolvedCache.set(resolvedId, parsed);
        return parsed;
      }
    } catch {
      // Fallback
    }

    const resolvedDir = path.join(this.projectRoot, 'evidence', 'resolved');
    if (fs.existsSync(resolvedDir)) {
      const findInDir = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findInDir(full);
            if (found) return found;
          } else if (entry.isFile() && entry.name.includes(resolvedId) && entry.name.endsWith('.json')) {
            return full;
          }
        }
        return null;
      };

      const foundPath = findInDir(resolvedDir);
      if (foundPath) {
        try {
          const content = fs.readFileSync(foundPath, 'utf-8');
          const parsed = JSON.parse(content) as ResolvedObservation;
          this.resolvedCache.set(resolvedId, parsed);
          return parsed;
        } catch {}
      }
    }

    return null;
  }

  /**
   * List all known conflict reports, optionally filtered by projectId.
   */
  public listConflictReports(projectId?: string): ConflictReport[] {
    const reportsMap = new Map<string, ConflictReport>();

    // 1. From in-memory cache
    for (const report of this.reportsCache.values()) {
      if (!projectId || report.projectId === projectId) {
        reportsMap.set(report.id, report);
      }
    }

    // 2. From Safe Artifact Store
    try {
      const artifacts = this.artifactService.listArtifacts();
      for (const art of artifacts) {
        if (art.type === 'evidence' && art.path.includes('conflict-report-')) {
          try {
            const { content } = this.artifactService.getArtifactContent(art.id);
            const parsed = JSON.parse(content) as ConflictReport;
            if (parsed && parsed.id && parsed.summary) {
              if (!projectId || parsed.projectId === projectId) {
                reportsMap.set(parsed.id, parsed);
                this.reportsCache.set(parsed.id, parsed);
              }
            }
          } catch {}
        }
      }
    } catch {}

    // 3. From evidence/conflicts directory on disk
    const conflictsDir = path.join(this.projectRoot, 'evidence', 'conflicts');
    if (fs.existsSync(conflictsDir)) {
      const scanDir = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(full);
            } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name.includes('conflict-report-')) {
              try {
                const content = fs.readFileSync(full, 'utf-8');
                const parsed = JSON.parse(content) as ConflictReport;
                if (parsed && parsed.id && parsed.summary) {
                  if (!projectId || parsed.projectId === projectId) {
                    if (!reportsMap.has(parsed.id)) {
                      reportsMap.set(parsed.id, parsed);
                      this.reportsCache.set(parsed.id, parsed);
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}
      };
      scanDir(conflictsDir);
    }

    return Array.from(reportsMap.values()).sort(
      (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
    );
  }

  /**
   * List all known resolved observations, optionally filtered by projectId.
   */
  public listResolvedObservations(projectId?: string): ResolvedObservation[] {
    const resolvedMap = new Map<string, ResolvedObservation>();

    // 1. From in-memory cache
    for (const res of this.resolvedCache.values()) {
      if (!projectId || res.projectId === projectId) {
        resolvedMap.set(res.id, res);
      }
    }

    // 2. From Safe Artifact Store
    try {
      const artifacts = this.artifactService.listArtifacts();
      for (const art of artifacts) {
        if (art.type === 'evidence' && art.path.includes('resolved-')) {
          try {
            const { content } = this.artifactService.getArtifactContent(art.id);
            const parsed = JSON.parse(content) as ResolvedObservation;
            if (parsed && parsed.id && parsed.status) {
              if (!projectId || parsed.projectId === projectId) {
                resolvedMap.set(parsed.id, parsed);
                this.resolvedCache.set(parsed.id, parsed);
              }
            }
          } catch {}
        }
      }
    } catch {}

    // 3. From evidence/resolved directory on disk
    const resolvedDir = path.join(this.projectRoot, 'evidence', 'resolved');
    if (fs.existsSync(resolvedDir)) {
      const scanDir = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(full);
            } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name.includes('resolved-')) {
              try {
                const content = fs.readFileSync(full, 'utf-8');
                const parsed = JSON.parse(content) as ResolvedObservation;
                if (parsed && parsed.id && parsed.status) {
                  if (!projectId || parsed.projectId === projectId) {
                    if (!resolvedMap.has(parsed.id)) {
                      resolvedMap.set(parsed.id, parsed);
                      this.resolvedCache.set(parsed.id, parsed);
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}
      };
      scanDir(resolvedDir);
    }

    return Array.from(resolvedMap.values()).sort(
      (a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime(),
    );
  }
}
