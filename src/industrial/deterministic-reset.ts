/**
 * F10-05: Deterministic Reset for Industrial Generated Test State
 *
 * Implements safe, allowlisted, dry-run-capable reset of confirmed generated state:
 *   - queue: generated tasks, objectives, plans, and events (.maos/queue/**, .maos/plans/**, .maos/events/**)
 *   - output: generated artifacts (artifacts/generated/**, .maos/generated/**, demo/industrial/generated/**)
 *   - index: local KB vector index (.maos/industrial/kb/**)
 *   - sandbox: temporary sandbox execution files (.maos/sandbox/**, .maos/tmp/**)
 *   - conversation: session/chat records (.maos/sessions/**, .maos/conversations/**)
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

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from '../service/audit-service';

export const RESET_CATEGORIES = [
  'queue',
  'output',
  'index',
  'sandbox',
  'conversation',
] as const;

export type ResetCategory = (typeof RESET_CATEGORIES)[number];

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
      path.join(normalizedRoot, '.maos', 'queue', 'tasks'),
      path.join(normalizedRoot, '.maos', 'queue', 'objectives'),
      path.join(normalizedRoot, '.maos', 'plans'),
      path.join(normalizedRoot, '.maos', 'events'),
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

          if (absPath.endsWith('.json') || absPath.endsWith('.jsonl')) {
            try {
              const fileSnippet = fs.readFileSync(absPath, 'utf8').substring(0, 2048);
              if (fileSnippet.includes(runId)) {
                matchesRunIdInContent = true;
              }
            } catch {
              // Ignore read errors during filter
            }
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
    : RESET_CATEGORIES;

  if (!fs.existsSync(projectRoot)) {
    return {
      success: false,
      dryRun,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: [],
      removedFiles: [],
      totalBytes: 0,
      message: `Project root directory does not exist: ${projectRoot}`,
      error: 'PROJECT_ROOT_NOT_FOUND',
    };
  }

  const candidates = discoverResetCandidates(projectRoot, categories, options.runId);
  const totalBytes = candidates.reduce((sum, c) => sum + c.byteSize, 0);

  // Dry run mode
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: candidates,
      removedFiles: [],
      totalBytes,
      message: `[DRY-RUN] Deterministic reset would remove ${candidates.length} generated files (${totalBytes} bytes). No files were deleted.`,
    };
  }

  // Live execution mandates explicit confirmation
  if (!options.confirmed) {
    return {
      success: false,
      dryRun: false,
      projectRoot,
      categories,
      runId: options.runId,
      candidateFiles: candidates,
      removedFiles: [],
      totalBytes,
      message: 'CONFIRMATION_REQUIRED: Live reset mandates explicit confirmation (--yes).',
      error: 'CONFIRMATION_REQUIRED',
    };
  }

  // Execute deletion
  const removed: ResetCandidateFile[] = [];
  const errors: string[] = [];

  for (const file of candidates) {
    // Double-check forbidden guard before physical deletion
    if (isForbiddenPath(file.absolutePath, projectRoot)) {
      errors.push(`Attempted deletion of protected path skipped: ${file.relativePath}`);
      continue;
    }

    try {
      if (fs.existsSync(file.absolutePath)) {
        fs.unlinkSync(file.absolutePath);
        removed.push(file);
      }
    } catch (err: any) {
      errors.push(`Failed to delete ${file.relativePath}: ${err.message}`);
    }
  }

  // Record audit log if audit service is available
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
          totalBytesRemoved: totalBytes,
          timestamp: new Date().toISOString(),
        },
      });
    } catch {
      // Non-fatal audit recording
    }
  }

  const msg = `Deterministic reset removed ${removed.length} generated files (${totalBytes} bytes) across categories [${categories.join(', ')}].`;

  return {
    success: errors.length === 0,
    dryRun: false,
    projectRoot,
    categories,
    runId: options.runId,
    candidateFiles: candidates,
    removedFiles: removed,
    totalBytes,
    message: msg,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}
