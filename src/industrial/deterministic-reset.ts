/**
 * F10-05: Deterministic Reset for Industrial Generated Test State
 *
 * Implements safe, allowlisted, dry-run-capable reset of confirmed generated state:
 *   - queue: generated tasks, objectives, plans, events, and checkpoints (.maos/queue/**, .maos/plans/**, .maos/events/**, .maos/checkpoints/**)
 *   - output: generated artifacts (artifacts/generated/**, .maos/generated/**, demo/industrial/generated/**)
 *   - index, sandbox, conversation: currently disabled until their writers share this reset guard
 *
 * Negative Invariants & Protection List:
 *   1. NEVER removes source fixtures (fixtures/**).
 *   2. NEVER removes demo pack source evidence (demo/industrial/turbine_vibration_log.csv, DEMO_PACK_PROVENANCE.json, etc.).
 *   3. NEVER touches or removes the canary file (rust/test.txt) or anything in rust/**.
 *   4. NEVER removes unrelated .maos files: config.json, settings.json, instance-identity.json, keys.json, profiles/**.
 *   5. NEVER removes immutable audit ledgers (.maos/audit/**).
 *   6. NEVER touches verification artifacts (artifacts/verification/**).
 *   7. Rejects any paths outside the target projectRoot.
 *   8. Strictly mandates explicit confirmation (--yes) for destructive live execution.
 */

import fs from 'node:fs';
import * as path from 'path';
import type { AuditService } from '../service/audit-service';
import { withJudgedRunOutputLock } from './judged-run-lock';
import {
  getActiveDir,
  getCancelledDir,
  getCheckpointsDir,
  getDoneDir,
  getEventsDir,
  getFailedDir,
  getObjectivesDir,
  getPendingDir,
  getPlansDir,
  getRetryDir,
} from '../utils/paths';

export const RESET_CATEGORIES = [
  'queue',
  'output',
  'index',
  'sandbox',
  'conversation',
] as const;

export type ResetCategory = (typeof RESET_CATEGORIES)[number];

export const RESET_ENABLED_CATEGORIES = ['queue', 'output'] as const satisfies readonly ResetCategory[];
export const RESET_DISABLED_CATEGORIES = ['index', 'sandbox', 'conversation'] as const satisfies readonly ResetCategory[];

export interface ResetCandidateFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly category: ResetCategory;
  readonly byteSize: number;
}

export interface DeterministicResetOptions {
  readonly projectRoot: string;
  readonly categories?: readonly ResetCategory[];
  readonly runId?: string;
  readonly dryRun?: boolean;
  readonly confirmed?: boolean;
  readonly auditService?: AuditService;
}

export interface DeterministicResetResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly projectRoot: string;
  readonly categories: readonly ResetCategory[];
  readonly runId?: string;
  readonly candidateFiles: readonly ResetCandidateFile[];
  readonly removedFiles: readonly ResetCandidateFile[];
  readonly scannedBytes: number;
  readonly removedBytes: number;
  readonly totalBytes: number;
  readonly message: string;
  readonly error?: string;
}

/**
 * List of path fragments that MUST NEVER be deleted under any circumstances.
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = Object.freeze([
  'rust/test.txt',
  'rust\\test.txt',
  '/rust/',
  '\\rust\\',
  '/fixtures/',
  '\\fixtures\\',
  '/.maos/audit/',
  '\\..maos\\audit\\',
  '/.maos/config',
  '\\.maos\\config',
  '/.maos/settings',
  '\\.maos\\settings',
  '/.maos/instance-identity',
  '\\.maos\\instance-identity',
  '/.maos/keys',
  '\\.maos\\keys',
  '/.maos/profiles',
  '\\.maos\\profiles',
  '/.maos/credentials',
  '\\.maos\\credentials',
  '/artifacts/verification/',
  '\\artifacts\\verification\\',
  'demo/industrial/turbine_vibration_log.csv',
  'demo\\industrial\\turbine_vibration_log.csv',
  'demo/industrial/DEMO_PACK_PROVENANCE.json',
  'demo\\industrial\\DEMO_PACK_PROVENANCE.json',
  'demo/industrial/expected_findings.json',
  'demo\\industrial\\expected_findings.json',
  'demo/industrial/safety_thresholds.json',
  'demo\\industrial\\safety_thresholds.json',
  'demo/industrial/ground_truth.json',
  'demo\\industrial\\ground_truth.json',
  'demo/industrial/maintenance_report.txt',
  'demo\\industrial\\maintenance_report.txt',
  'demo/industrial/turbine_inspection_scan.pdf',
  'demo\\industrial\\turbine_inspection_scan.pdf',
  'demo/industrial/sop_turbine_vibration_monitoring.md',
  'demo\\industrial\\sop_turbine_vibration_monitoring.md',
  'demo/industrial/RUNBOOK.md',
  'demo\\industrial\\RUNBOOK.md',
  'demo/industrial/PRESENTATION_SCRIPT.md',
  'demo\\industrial\\PRESENTATION_SCRIPT.md',
  'demo/industrial/images',
  'demo\\industrial\\images',
]);

/**
 * Validates whether a file is strictly forbidden from deletion.
 */
export function isForbiddenPath(targetPath: string, projectRoot: string): boolean {
  const normalizedTarget = path.normalize(path.resolve(targetPath));
  const normalizedRoot = path.normalize(path.resolve(projectRoot));

  // Must be inside project root
  if (!normalizedTarget.startsWith(normalizedRoot)) {
    return true;
  }

  const relative = path.relative(normalizedRoot, normalizedTarget).replace(/\\/g, '/');

  // Canary check
  if (relative === 'rust/test.txt' || relative.startsWith('rust/')) {
    return true;
  }

  // Fixtures check
  if (relative.startsWith('fixtures/')) {
    return true;
  }

  // Audit check
  if (relative.startsWith('.maos/audit/')) {
    return true;
  }

  // Verification artifacts check
  if (relative.startsWith('artifacts/verification/')) {
    return true;
  }

  // Root configuration check
  if (
    relative === '.maos/config.json' ||
    relative === '.maos/settings.json' ||
    relative === '.maos/instance-identity.json' ||
    relative === '.maos/keys.json' ||
    relative.startsWith('.maos/profiles/') ||
    relative.startsWith('.maos/credentials/')
  ) {
    return true;
  }

  // Demo source files check (allow only demo/industrial/generated/**)
  if (relative.startsWith('demo/industrial/')) {
    if (!relative.startsWith('demo/industrial/generated/')) {
      return true;
    }
  }

  // Check any generic forbidden fragments
  for (const frag of FORBIDDEN_FRAGMENTS) {
    if (normalizedTarget.includes(frag) || relative.includes(frag)) {
      return true;
    }
  }

  return false;
}

/**
 * Discovers candidate files for deterministic reset according to category allowlists.
 */
export function discoverResetCandidates(
  projectRoot: string,
  categories: readonly ResetCategory[],
  runId?: string,
): ResetCandidateFile[] {
  const normalizedRoot = path.normalize(path.resolve(projectRoot));
  const candidates: ResetCandidateFile[] = [];

  const categoryDirs: Record<ResetCategory, string[]> = {
    queue: [
      getPendingDir(normalizedRoot),
      getDoneDir(normalizedRoot),
      getRetryDir(normalizedRoot),
      getFailedDir(normalizedRoot),
      getCancelledDir(normalizedRoot),
      getCheckpointsDir(normalizedRoot),
      getObjectivesDir(normalizedRoot),
      getPlansDir(normalizedRoot),
      getEventsDir(normalizedRoot),
    ],
    output: [
      path.join(normalizedRoot, 'artifacts', 'generated'),
      path.join(normalizedRoot, '.maos', 'generated'),
      path.join(normalizedRoot, 'demo', 'industrial', 'generated'),
    ],
    index: [
      path.join(normalizedRoot, '.maos', 'industrial', 'kb'),
    ],
    sandbox: [
      path.join(normalizedRoot, '.maos', 'sandbox'),
      path.join(normalizedRoot, '.maos', 'tmp'),
      path.join(normalizedRoot, '.maos', 'artifacts', 'tmp'),
    ],
    conversation: [
      path.join(normalizedRoot, '.maos', 'sessions'),
      path.join(normalizedRoot, '.maos', 'conversations'),
    ],
  };

  for (const cat of categories) {
    const dirs = categoryDirs[cat] || [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const parent = entry.parentPath || (entry as any).path || dir;
        const absPath = path.join(parent, entry.name);
        const relPath = path.relative(normalizedRoot, absPath).replace(/\\/g, '/');

        // Verify guardrails
        if (isForbiddenPath(absPath, normalizedRoot)) {
          continue;
        }

        // If runId filter is specified, filter files relevant to runId
        if (runId) {
          const matchesRunIdInName = entry.name.includes(runId);
          let matchesRunIdInContent = false;

          try {
            const fileSnippet = fs.readFileSync(absPath, 'utf8').substring(0, 2048);
            if (fileSnippet.includes(runId)) {
              matchesRunIdInContent = true;
            }
          } catch {
            // Ignore read errors during filter
          }

          if (!matchesRunIdInName && !matchesRunIdInContent) {
            continue;
          }
        }

        try {
          const stat = fs.statSync(absPath);
          candidates.push({
            relativePath: relPath,
            absolutePath: absPath,
            category: cat,
            byteSize: stat.size,
          });
        } catch {
          // File may have been removed or locked
        }
      }
    }
  }

  return candidates;
}

function activeQueueWork(projectRoot: string): string[] {
  const activeTasksDir = getActiveDir(projectRoot);
  const activeTasks = fs.existsSync(activeTasksDir)
    ? fs.readdirSync(activeTasksDir).filter((name) => !name.startsWith('.'))
      .map((name) => path.relative(projectRoot, path.join(activeTasksDir, name)).replace(/\\/g, '/'))
    : [];
  const objectivesDir = getObjectivesDir(projectRoot);
  const activeObjectives = fs.existsSync(objectivesDir)
    ? fs.readdirSync(objectivesDir).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const objective = JSON.parse(fs.readFileSync(path.join(objectivesDir, name), 'utf8'));
        return ['planning', 'replanning', 'executing', 'reviewing'].includes(objective.status)
          ? [path.relative(projectRoot, path.join(objectivesDir, name)).replace(/\\/g, '/')]
          : [];
      } catch {
        return [path.relative(projectRoot, path.join(objectivesDir, name)).replace(/\\/g, '/')];
      }
    })
    : [];
  return [...activeTasks, ...activeObjectives];
}

/**
 * Executes deterministic reset over allowlisted generated test state.
 */
export async function executeDeterministicReset(
  options: DeterministicResetOptions,
): Promise<DeterministicResetResult> {
  const projectRoot = path.normalize(path.resolve(options.projectRoot));
  const dryRun = options.dryRun ?? true;
  const categories = options.categories && options.categories.length > 0
    ? options.categories
    : RESET_ENABLED_CATEGORIES;

  if (!fs.existsSync(projectRoot)) {
    return {
      success: false,
      dryRun,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: [],
      removedFiles: [],
      scannedBytes: 0,
      removedBytes: 0,
      totalBytes: 0,
      message: `Project root directory does not exist: ${projectRoot}`,
      error: 'PROJECT_ROOT_NOT_FOUND',
    };
  }

  const disabledCategories = categories.filter((category) =>
    (RESET_DISABLED_CATEGORIES as readonly ResetCategory[]).includes(category));
  if (disabledCategories.length > 0) {
    const message = `RESET_CATEGORY_UNSUPPORTED: ${disabledCategories.join(', ')} reset is disabled until its active writers use the shared reset guard. Stop the owning service and remove that state through its service-specific cleanup.`;
    return {
      success: false,
      dryRun,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: [],
      removedFiles: [],
      scannedBytes: 0,
      removedBytes: 0,
      totalBytes: 0,
      message,
      error: 'RESET_CATEGORY_UNSUPPORTED',
    };
  }

  // Dry run mode
  if (dryRun) {
    const candidates = discoverResetCandidates(projectRoot, categories, options.runId);
    const scannedBytes = candidates.reduce((sum, c) => sum + c.byteSize, 0);
    return {
      success: true,
      dryRun: true,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: candidates,
      removedFiles: [],
      scannedBytes,
      removedBytes: 0,
      totalBytes: scannedBytes,
      message: `[DRY-RUN] Deterministic reset found ${candidates.length} generated files (${scannedBytes} bytes scanned). No files were deleted.`,
    };
  }

  // Live execution mandates explicit confirmation
  if (!options.confirmed) {
    const candidates = discoverResetCandidates(projectRoot, categories, options.runId);
    const scannedBytes = candidates.reduce((sum, c) => sum + c.byteSize, 0);
    return {
      success: false,
      dryRun: false,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: candidates,
      removedFiles: [],
      scannedBytes,
      removedBytes: 0,
      totalBytes: scannedBytes,
      message: 'CONFIRMATION_REQUIRED: Live reset mandates explicit confirmation (--yes).',
      error: 'CONFIRMATION_REQUIRED',
    };
  }

  return withJudgedRunOutputLock(projectRoot, () => {
    // Scan under the same project lock as deletion so a publisher cannot appear between them.
    if (categories.includes('queue')) {
      const active = activeQueueWork(projectRoot);
      if (active.length > 0) {
        return {
          success: false,
          dryRun: false,
          projectRoot,
          categories,
          runId: options.runId,
          candidateFiles: [],
          removedFiles: [],
          scannedBytes: 0,
          removedBytes: 0,
          totalBytes: 0,
          message: `QUEUE_RESET_REFUSED: Active queue entries or workflows remain (including interrupted entries whose worker exit is unconfirmed): ${active.join(', ')}. Stop the owning MAOS worker; after it exits, restart MAOS to recover orphaned work, then retry reset.`,
          error: 'ACTIVE_QUEUE_WORK',
        };
      }
    }
    const candidates = discoverResetCandidates(projectRoot, categories, options.runId);
    const scannedBytes = candidates.reduce((sum, c) => sum + c.byteSize, 0);
    const removed: ResetCandidateFile[] = [];
    let removedBytes = 0;
    const errors: string[] = [];

    for (const file of candidates) {
      // Double-check forbidden guard before physical deletion
      if (isForbiddenPath(file.absolutePath, projectRoot)) {
        errors.push(`Attempted deletion of protected path skipped: ${file.relativePath}`);
        continue;
      }

      try {
        if (fs.existsSync(file.absolutePath)) {
          const actualBytes = fs.statSync(file.absolutePath).size;
          fs.unlinkSync(file.absolutePath);
          removed.push({ ...file, byteSize: actualBytes });
          removedBytes += actualBytes;
        }
      } catch (err: any) {
        errors.push(`Failed to delete ${file.relativePath}: ${err.message}`);
      }
    }

    // Record the reset without changing a judged run's historical terminal state.
    if (options.auditService) {
      try {
        options.auditService.recordAuditEvent({
          category: 'interruption',
          source: 'deterministic-reset',
          data: {
            event: 'DETERMINISTIC_RESET_EXECUTED',
            categories,
            runId: options.runId,
            filesRemovedCount: removed.length,
            scannedBytes,
            totalBytesRemoved: removedBytes,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err: any) {
        errors.push(`Failed to record reset audit event after removing ${removed.length} files: ${err.message}`);
      }
    }

    const msg = `Deterministic reset removed ${removed.length} generated files (${removedBytes} bytes; ${scannedBytes} bytes scanned) across categories [${categories.join(', ')}].`;

    return {
      success: errors.length === 0,
      dryRun: false,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: candidates,
      removedFiles: removed,
      scannedBytes,
      removedBytes,
      totalBytes: removedBytes,
      message: msg,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  });
}
