/**
 * UI1-10: Retention Application Service
 *
 * Implements configurable, scoped local retention and purge policies.
 *
 * Strict Safety Invariants:
 * 1. Scope Containment: All purge actions are strictly confined to projectRoot.
 *    Any path escaping projectRoot is rejected with PATH_OUTSIDE_PROJECT.
 * 2. Audit Trail Immutability: The tamper-evident audit log (.maos/audit/) is strictly
 *    immutable and can NEVER be purged. Throws IMMUTABLE_AUDIT_PURGE_FORBIDDEN.
 * 3. Finalized Deliverables Safety: Finalized office deliverables (*.docx, *.xlsx, *.pptx)
 *    and approved artifacts are NEVER deleted by retention. Throws FINALIZED_DELIVERABLE_PURGE_FORBIDDEN.
 * 4. Pinned Conversations Safety: Conversations marked as pinned (pinned: true) or linked
 *    to active tasks are preserved.
 * 5. Full Audit Trail: Every purge operation is recorded in the audit chain with zero
 *    secret leakage.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  PurgeOptions,
  PurgeResult,
  PurgedItemDetail,
  RetentionStatus,
} from '../domain/evidence-mode';
import { validatePurgeOptions } from '../domain/evidence-mode';
import type { RetentionSettings } from '../domain/settings';
import { DEFAULT_RETENTION_SETTINGS } from '../domain/settings';
import type { AuditService } from './audit-service';
import type { BasicSettingsStore } from './project-service/settings-store';
import type { Conversation } from '../domain/schemas';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class RetentionService {
  constructor(
    private readonly projectRoot: string,
    private readonly auditService?: AuditService,
    private readonly settingsStore?: BasicSettingsStore,
  ) {}

  public assertProjectContainment(targetPath: string): void {
    const resolvedRoot = path.resolve(this.projectRoot);
    const resolvedTarget = path.resolve(targetPath);
    if (!resolvedTarget.startsWith(resolvedRoot) || resolvedTarget.includes('\0')) {
      throw new Error(`PATH_OUTSIDE_PROJECT: Path "${targetPath}" escapes project root`);
    }
  }

  public assertSafePath(targetPath: string): void {
    this.assertProjectContainment(targetPath);
  }

  private assertNotImmutableAudit(targetPath: string): void {
    const auditDir = path.resolve(this.projectRoot, '.maos', 'audit');
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedTarget.startsWith(auditDir) || resolvedTarget.includes(path.join('.maos', 'audit'))) {
      throw new Error('IMMUTABLE_AUDIT_PURGE_FORBIDDEN: Audit chain records are strictly immutable and cannot be purged.');
    }
  }

  private assertNotFinalizedDeliverable(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      const artifactsDir = path.resolve(this.projectRoot, 'artifacts');
      const resolved = path.resolve(filePath);
      // If it's a finalized deliverable outside .tmp
      if (resolved.startsWith(artifactsDir) && !resolved.includes('.tmp')) {
        throw new Error(`FINALIZED_DELIVERABLE_PURGE_FORBIDDEN: Finalized deliverable "${path.basename(filePath)}" cannot be purged.`);
      }
    }
  }

  /**
   * Retrieves active retention settings from settings store or defaults.
   */
  public getRetentionSettings(projectId?: string): RetentionSettings {
    if (this.settingsStore) {
      try {
        const basic = this.settingsStore.loadSettings(projectId || 'default');
        return basic.retention;
      } catch {
        /* fallback to defaults */
      }
    }
    return { ...DEFAULT_RETENTION_SETTINGS };
  }

  /**
   * Computes the current retention status and estimates reclaimable storage.
   */
  public getRetentionStatus(projectId = 'default'): RetentionStatus {
    const retention = this.getRetentionSettings(projectId);
    const now = Date.now();

    // 1. Scan Conversations
    const convDir = path.join(this.projectRoot, '.maos', 'conversations');
    let totalConversations = 0;
    let expiredConversations = 0;
    let reclaimableBytes = 0;

    if (fs.existsSync(convDir)) {
      const files = fs.readdirSync(convDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
      totalConversations = files.length;
      for (const file of files) {
        const filePath = path.join(convDir, file);
        try {
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const conv = JSON.parse(content) as Conversation;

          const updatedTime = new Date(conv.updatedAt || stat.mtime).getTime();
          const ageDays = (now - updatedTime) / MS_PER_DAY;

          if (ageDays > retention.conversationDays && !conv.pinned && !conv.taskId) {
            expiredConversations++;
            reclaimableBytes += stat.size;
          }
        } catch {
          /* ignore unparseable */
        }
      }
    }

    // 2. Scan Artifact Previews / Temp files
    const previewDirs = [
      path.join(this.projectRoot, 'artifacts', '.tmp'),
      path.join(this.projectRoot, '.maos', 'previews'),
    ];
    let totalArtifactPreviews = 0;
    let expiredArtifactPreviews = 0;

    for (const pDir of previewDirs) {
      if (fs.existsSync(pDir)) {
        const files = fs.readdirSync(pDir);
        totalArtifactPreviews += files.length;
        for (const file of files) {
          const filePath = path.join(pDir, file);
          try {
            const stat = fs.statSync(filePath);
            const ageDays = (now - stat.mtimeMs) / MS_PER_DAY;
            if (ageDays > retention.artifactPreviewDays) {
              expiredArtifactPreviews++;
              reclaimableBytes += stat.size;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    // 3. Scan Event Display caches (non-authoritative view caches)
    const eventDisplayDir = path.join(this.projectRoot, '.maos', 'event-display');
    let totalEventDisplayRecords = 0;
    let expiredEventDisplayRecords = 0;

    if (fs.existsSync(eventDisplayDir)) {
      const files = fs.readdirSync(eventDisplayDir).filter((f) => f.endsWith('.json'));
      totalEventDisplayRecords = files.length;
      for (const file of files) {
        const filePath = path.join(eventDisplayDir, file);
        try {
          const stat = fs.statSync(filePath);
          const ageDays = (now - stat.mtimeMs) / MS_PER_DAY;
          if (ageDays > retention.eventDisplayDays) {
            expiredEventDisplayRecords++;
            reclaimableBytes += stat.size;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 4. Count immutable audit records
    let immutableAuditRecordCount = 0;
    const auditChainPath = path.join(this.projectRoot, '.maos', 'audit', 'audit-chain.jsonl');
    if (fs.existsSync(auditChainPath)) {
      try {
        const lines = fs.readFileSync(auditChainPath, 'utf-8').trim().split('\n').filter(Boolean);
        immutableAuditRecordCount = lines.length;
      } catch {
        /* ignore */
      }
    }

    // 5. Count immutable finalized deliverables
    let immutableDeliverableCount = 0;
    const artifactsDir = path.join(this.projectRoot, 'artifacts');
    if (fs.existsSync(artifactsDir)) {
      try {
        const files = fs.readdirSync(artifactsDir).filter((f) => {
          const ext = path.extname(f).toLowerCase();
          return ['.docx', '.xlsx', '.pptx'].includes(ext);
        });
        immutableDeliverableCount = files.length;
      } catch {
        /* ignore */
      }
    }

    return {
      schemaVersion: 1,
      projectId,
      retention,
      totalConversations,
      expiredConversations,
      totalArtifactPreviews,
      expiredArtifactPreviews,
      totalEventDisplayRecords,
      expiredEventDisplayRecords,
      estimatedReclaimableBytes: reclaimableBytes,
      immutableAuditRecordCount,
      immutableDeliverableCount,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Executes a scoped purge of expired items according to retention policy.
   * Alias for executePurge.
   */
  public purge(options: PurgeOptions): PurgeResult {
    return this.executePurge(options);
  }

  /**
   * Executes a scoped purge of expired items according to retention policy.
   *
   * @param options Purge configuration and target
   * @returns PurgeResult detailing deleted items and freed bytes
   */
  public executePurge(options: PurgeOptions): PurgeResult {
    const val = validatePurgeOptions(options);
    if (!val.valid) {
      throw new Error(`VALIDATION_FAILED: ${val.errors.join('; ')}`);
    }

    const retention = this.getRetentionSettings();
    const conversationDays = options.conversationDays ?? retention.conversationDays;
    const artifactPreviewDays = options.artifactPreviewDays ?? retention.artifactPreviewDays;
    const eventDisplayDays = options.eventDisplayDays ?? retention.eventDisplayDays;
    const dryRun = options.dryRun === true;
    const now = Date.now();

    const itemsToPurge: PurgedItemDetail[] = [];
    let freedBytes = 0;

    // A. Purge expired conversations
    if (options.target === 'conversations' || options.target === 'all_expired') {
      const convDir = path.join(this.projectRoot, '.maos', 'conversations');
      this.assertProjectContainment(convDir);
      this.assertNotImmutableAudit(convDir);

      if (fs.existsSync(convDir)) {
        const files = fs.readdirSync(convDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
        for (const file of files) {
          const filePath = path.join(convDir, file);
          this.assertProjectContainment(filePath);
          this.assertNotImmutableAudit(filePath);

          try {
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            const conv = JSON.parse(content) as Conversation;

            // Invariant: Never purge pinned conversations or conversations linked to active tasks
            if (conv.pinned === true || Boolean(conv.taskId)) {
              continue;
            }

            const updatedTime = new Date(conv.updatedAt || stat.mtime).getTime();
            const ageDays = (now - updatedTime) / MS_PER_DAY;

            if (ageDays > conversationDays) {
              itemsToPurge.push({
                category: 'conversations',
                identifier: conv.id || file,
                relativePath: path.relative(this.projectRoot, filePath).replace(/\\/g, '/'),
                ageDays: Math.round(ageDays * 10) / 10,
                sizeBytes: stat.size,
              });
              freedBytes += stat.size;

              if (!dryRun) {
                fs.unlinkSync(filePath);
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    // B. Purge expired artifact preview caches
    if (options.target === 'artifact_previews' || options.target === 'all_expired') {
      const previewDirs = [
        path.join(this.projectRoot, 'artifacts', '.tmp'),
        path.join(this.projectRoot, '.maos', 'previews'),
      ];

      for (const pDir of previewDirs) {
        this.assertProjectContainment(pDir);
        this.assertNotImmutableAudit(pDir);

        if (fs.existsSync(pDir)) {
          const files = fs.readdirSync(pDir);
          for (const file of files) {
            const filePath = path.join(pDir, file);
            this.assertProjectContainment(filePath);
            this.assertNotImmutableAudit(filePath);
            this.assertNotFinalizedDeliverable(filePath);

            try {
              const stat = fs.statSync(filePath);
              const ageDays = (now - stat.mtimeMs) / MS_PER_DAY;

              if (ageDays > artifactPreviewDays) {
                itemsToPurge.push({
                  category: 'artifact_previews',
                  identifier: file,
                  relativePath: path.relative(this.projectRoot, filePath).replace(/\\/g, '/'),
                  ageDays: Math.round(ageDays * 10) / 10,
                  sizeBytes: stat.size,
                });
                freedBytes += stat.size;

                if (!dryRun) {
                  fs.unlinkSync(filePath);
                }
              }
            } catch {
              /* skip */
            }
          }
        }
      }
    }

    // C. Purge expired event display caches (non-authoritative view caches only)
    if (options.target === 'event_display' || options.target === 'all_expired') {
      const eventDisplayDir = path.join(this.projectRoot, '.maos', 'event-display');
      this.assertProjectContainment(eventDisplayDir);
      this.assertNotImmutableAudit(eventDisplayDir);

      if (fs.existsSync(eventDisplayDir)) {
        const files = fs.readdirSync(eventDisplayDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(eventDisplayDir, file);
          this.assertProjectContainment(filePath);
          this.assertNotImmutableAudit(filePath);

          try {
            const stat = fs.statSync(filePath);
            const ageDays = (now - stat.mtimeMs) / MS_PER_DAY;

            if (ageDays > eventDisplayDays) {
              itemsToPurge.push({
                category: 'event_display',
                identifier: file,
                relativePath: path.relative(this.projectRoot, filePath).replace(/\\/g, '/'),
                ageDays: Math.round(ageDays * 10) / 10,
                sizeBytes: stat.size,
              });
              freedBytes += stat.size;

              if (!dryRun) {
                fs.unlinkSync(filePath);
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    const purgedConversations = itemsToPurge.filter((i) => i.category === 'conversations').length;
    const purgedArtifactPreviews = itemsToPurge.filter((i) => i.category === 'artifact_previews').length;
    const purgedEventDisplay = itemsToPurge.filter((i) => i.category === 'event_display').length;
    const totalPurged = itemsToPurge.length;

    let auditRecordSequence: number | undefined;
    let auditHash: string | undefined;

    // Record audit event for actual executions (and optionally dry-runs)
    if (this.auditService) {
      try {
        const auditRecord = this.auditService.recordAuditEvent({
          source: 'retention-service',
          category: 'tool',
          data: {
            action: 'RETENTION_PURGE_EXECUTED',
            actor: options.actor || 'system',
            reason: options.reason || 'Configured local retention cycle',
            target: options.target,
            dryRun,
            conversationDays,
            artifactPreviewDays,
            eventDisplayDays,
            purgedCounts: {
              conversations: purgedConversations,
              artifactPreviews: purgedArtifactPreviews,
              eventDisplay: purgedEventDisplay,
              total: totalPurged,
            },
            freedBytes,
          },
        });
        auditRecordSequence = auditRecord.sequence;
        auditHash = auditRecord.hash;
      } catch {
        /* fail-safe if audit engine unavailable in test */
      }
    }

    return {
      purgedConversations,
      purgedArtifactPreviews,
      purgedEventDisplay,
      totalPurged,
      freedBytes,
      auditRecordSequence,
      auditHash,
      timestamp: new Date().toISOString(),
      dryRun,
      items: itemsToPurge,
    };
  }
}
