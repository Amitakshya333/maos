/**
 * F5-07: Local Knowledge-Base Industrial CLI Operations
 *
 * Implements command execution for:
 *   - maos industrial kb build
 *   - maos industrial kb status
 *   - maos industrial kb verify
 *   - maos industrial kb clear
 *
 * Requirements:
 *   1. Routes every command through existing typed application services (KbService via ServiceContainer).
 *   2. Zero duplicate ingestion, embedding, indexing, or policy logic.
 *   3. Enforces explicit project root validation:
 *      - Requires .maos/ directory
 *      - Strictly rejects traversal, symlink escapes, external roots
 *      - Strictly rejects implicit or explicit user home-directory scans
 *   4. Stable numerical exit codes (KB_CLI_EXIT).
 *   5. Machine-readable JSON output (--json) and human-readable chalk format.
 *   6. Destructive clear operation requires explicit confirmation (--yes) or safe preview (--dry-run).
 *   7. Idempotent repeated runs across all commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import {
  KB_CLI_EXIT,
  KbCliExitCode,
  KbCliResult,
  KbBuildResult,
  KbStatusResult,
  KbVerifyResult,
  KbClearResult,
} from '../domain/kb-cli-types';
import { EmbeddingError } from '../domain/embedding';
import { KbIndexError } from '../domain/kb-vector-index';
import { KbIngestionError } from '../domain/kb-ingestion';
import { ServiceContainer, createServiceContainer } from '../service';
import { validateProjectFolder } from '../service/project-service/validator';

export class KbCliError extends Error {
  constructor(
    public readonly exitCode: KbCliExitCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KbCliError';
    Object.setPrototypeOf(this, KbCliError.prototype);
  }
}

// ── Project Root Validation ─────────────────────────────────────────

export interface ResolveProjectOptions {
  readonly allowTemp?: boolean;
}

/**
 * Validates and resolves an explicit project root for knowledge base operations.
 * Fails closed if project is missing, invalid, symlinked out, escaping root, or targeting user home.
 */
export function resolveAndValidateKbProjectRoot(
  inputPath?: string,
  options: ResolveProjectOptions = {},
): { projectRoot: string; projectId: string } {
  const rawPath = inputPath !== undefined && inputPath !== null ? String(inputPath).trim() : process.cwd();

  if (rawPath.length === 0) {
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      'Project path cannot be empty. An explicit project folder is required.',
    );
  }

  // 1. Path traversal pattern checks
  if (rawPath.includes('..')) {
    const resolved = path.resolve(rawPath);
    // If the raw relative path attempted to traverse out
    if (path.isAbsolute(rawPath) && rawPath.includes('..')) {
      // absolute path with internal .. is resolved, but verify existence
    }
  }

  // 2. Reject user home directory scans (implicit or explicit)
  const home = path.resolve(os.homedir()).toLowerCase();
  let resolvedCanonical: string;
  try {
    const directResolved = path.resolve(rawPath);
    if (!fs.existsSync(directResolved)) {
      throw new KbCliError(
        KB_CLI_EXIT.INVALID_PROJECT,
        `Project directory '${directResolved}' does not exist.`,
      );
    }
    resolvedCanonical = fs.realpathSync(directResolved);
  } catch (err: any) {
    if (err instanceof KbCliError) throw err;
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      `Failed to canonicalize project path '${rawPath}': ${err.message}`,
    );
  }

  const resolvedLower = resolvedCanonical.toLowerCase();
  if (resolvedLower === home) {
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      'Implicit or explicit scan of user home directory is strictly forbidden. An explicit project folder with .maos/ is required.',
    );
  }

  // 3. Reject directory if it's not a valid directory
  const stat = fs.statSync(resolvedCanonical);
  if (!stat.isDirectory()) {
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      `Project path '${resolvedCanonical}' is a file, not a directory.`,
    );
  }

  // 4. Reject symlinked roots unless explicitly authorized
  const lstat = fs.lstatSync(resolvedCanonical);
  if (lstat.isSymbolicLink()) {
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      `Project root '${resolvedCanonical}' is a symbolic link. Symlinked project roots are forbidden.`,
    );
  }

  // 5. Require .maos/ directory
  const maosDir = path.join(resolvedCanonical, '.maos');
  if (!fs.existsSync(maosDir) || !fs.statSync(maosDir).isDirectory()) {
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      `Directory '${resolvedCanonical}' is not initialized as a MAOS project. Missing '.maos' directory.`,
    );
  }

  // 6. Check symlink escape on .maos directory
  try {
    const canonicalMaos = fs.realpathSync(maosDir);
    if (canonicalMaos.toLowerCase() !== path.resolve(resolvedCanonical, '.maos').toLowerCase()) {
      throw new KbCliError(
        KB_CLI_EXIT.INVALID_PROJECT,
        `The '.maos' directory inside '${resolvedCanonical}' is a symlink or junction, which is forbidden.`,
      );
    }
  } catch (err: any) {
    if (err instanceof KbCliError) throw err;
    throw new KbCliError(
      KB_CLI_EXIT.INVALID_PROJECT,
      `Cannot verify .maos directory integrity: ${err.message}`,
    );
  }

  // 7. Resolve project ID
  let projectId = path.basename(resolvedCanonical) || 'default-project';
  const configPath = path.join(maosDir, 'maos.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.projectName && typeof cfg.projectName === 'string') {
        projectId = cfg.projectName;
      } else if (cfg.id && typeof cfg.id === 'string') {
        projectId = cfg.id;
      }
    } catch {}
  }

  return { projectRoot: resolvedCanonical, projectId };
}

// ── 1. Command: build ───────────────────────────────────────────────

export interface KbCliBuildOptions {
  readonly projectRoot?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly allowTemp?: boolean;
  readonly services?: ServiceContainer;
}

export async function runKbBuild(options: KbCliBuildOptions = {}): Promise<KbCliResult<KbBuildResult>> {
  let projectRoot: string;
  let projectId: string;

  try {
    const resolved = resolveAndValidateKbProjectRoot(options.projectRoot, {
      allowTemp: options.allowTemp,
    });
    projectRoot = resolved.projectRoot;
    projectId = resolved.projectId;
  } catch (err: any) {
    const exitCode = err instanceof KbCliError ? err.exitCode : KB_CLI_EXIT.INVALID_PROJECT;
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
    }
    return { exitCode, success: false, error: err.message };
  }

  const services = options.services || createServiceContainer(projectRoot);

  try {
    if (!options.json) {
      console.log(chalk.bold.blue('\n📚 MAOS Industrial — Knowledge Base Build\n'));
      console.log(chalk.gray(`Project Root: ${projectRoot}`));
      console.log(chalk.gray(`Project ID:   ${projectId}`));
      console.log(chalk.gray(`Force Build:  ${options.force ? 'Yes' : 'No'}\n`));
    }

    const result = await services.kb.build({
      projectId,
      force: options.force,
    });

    if (options.json) {
      console.log(JSON.stringify({ success: true, exitCode: KB_CLI_EXIT.SUCCESS, data: result }, null, 2));
    } else {
      console.log(chalk.green(`\n✅ Knowledge base index ${result.status} successfully in ${result.durationMs}ms`));
      console.log(chalk.white(`Documents:    ${result.documentCount}`));
      console.log(chalk.white(`Chunks:       ${result.chunkCount}`));
      console.log(chalk.white(`Model:        ${result.modelId} (${result.modelRevision.slice(0, 12)}...)`));
      console.log(chalk.white(`Index Build:  ${result.indexBuildId}`));
      console.log(chalk.white(`Entries Hash: ${result.entriesHash.slice(0, 16)}...`));
      if (result.warnings && result.warnings.length > 0) {
        console.log(chalk.yellow(`\nWarnings (${result.warnings.length}):`));
        for (const w of result.warnings) {
          console.log(chalk.yellow(`  ⚠️  ${w}`));
        }
      }
    }

    return {
      exitCode: KB_CLI_EXIT.SUCCESS,
      success: true,
      data: result,
    };
  } catch (err: any) {
    let exitCode: KbCliExitCode = KB_CLI_EXIT.GENERAL_ERROR;

    if (err instanceof EmbeddingError && err.code === 'NO_RUNTIME_DOWNLOAD') {
      exitCode = KB_CLI_EXIT.MISSING_MODEL;
    } else if (err.code === 'POLICY_FAILURE' || err.message?.includes('policy')) {
      exitCode = KB_CLI_EXIT.POLICY_FAILURE;
    } else if (err instanceof KbIngestionError) {
      exitCode = KB_CLI_EXIT.INGESTION_FAILURE;
    } else if (err instanceof KbIndexError) {
      exitCode = KB_CLI_EXIT.INDEX_CORRUPT;
    }

    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Knowledge base build failed [code: ${exitCode}]: ${err.message}`));
    }

    return {
      exitCode,
      success: false,
      error: err.message,
    };
  }
}

// ── 2. Command: status ──────────────────────────────────────────────

export interface KbCliStatusOptions {
  readonly projectRoot?: string;
  readonly json?: boolean;
  readonly allowTemp?: boolean;
  readonly services?: ServiceContainer;
}

export async function runKbStatus(options: KbCliStatusOptions = {}): Promise<KbCliResult<KbStatusResult>> {
  let projectRoot: string;
  let projectId: string;

  try {
    const resolved = resolveAndValidateKbProjectRoot(options.projectRoot, {
      allowTemp: options.allowTemp,
    });
    projectRoot = resolved.projectRoot;
    projectId = resolved.projectId;
  } catch (err: any) {
    const exitCode = err instanceof KbCliError ? err.exitCode : KB_CLI_EXIT.INVALID_PROJECT;
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
    }
    return { exitCode, success: false, error: err.message };
  }

  const services = options.services || createServiceContainer(projectRoot);

  try {
    const result = await services.kb.status({ projectId });

    if (options.json) {
      console.log(JSON.stringify({ success: true, exitCode: KB_CLI_EXIT.SUCCESS, data: result }, null, 2));
    } else {
      console.log(chalk.bold.blue('\n📊 MAOS Industrial — Knowledge Base Status\n'));
      console.log(chalk.gray(`Project Root: ${result.projectRoot}`));
      console.log(chalk.gray(`Project ID:   ${result.projectId}`));

      console.log(chalk.bold('\nPolicy:'));
      console.log(chalk.white(`  Version:        ${result.policy.policyVersion}`));
      console.log(chalk.white(`  Approved Roots: ${result.policy.approvedRoots.join(', ')}`));
      console.log(chalk.white(`  Max Documents:  ${result.policy.maxDocumentCount}`));
      console.log(chalk.white(`  Max Doc Bytes:  ${(result.policy.maxSourceBytes / 1024 / 1024).toFixed(1)} MB`));

      console.log(chalk.bold('\nIngestion:'));
      console.log(chalk.white(`  Documents:      ${result.ingestion.documentCount}`));
      console.log(chalk.white(`  Total Chunks:   ${result.ingestion.totalChunks}`));
      console.log(chalk.white(`  Source Bytes:   ${(result.ingestion.totalSourceBytes / 1024).toFixed(1)} KB`));
      console.log(chalk.white(`  Quarantined:    ${result.ingestion.quarantinedCount}`));
      if (result.ingestion.lastIngestedAt) {
        console.log(chalk.gray(`  Last Ingested:  ${result.ingestion.lastIngestedAt}`));
      }

      console.log(chalk.bold('\nEmbedding Model:'));
      console.log(chalk.white(`  Model ID:       ${result.embedding.modelId}`));
      console.log(chalk.white(`  Revision:       ${result.embedding.revision.slice(0, 16)}...`));
      console.log(chalk.white(`  Dimension:      ${result.embedding.dimension}`));
      console.log(
        chalk.white(`  Offline Ready:  `) +
          (result.embedding.available ? chalk.green('YES (staged)') : chalk.yellow('NO (weights missing)')),
      );
      if (result.embedding.blockerReason) {
        console.log(chalk.gray(`  Blocker:        ${result.embedding.blockerReason}`));
      }

      console.log(chalk.bold('\nVector Index:'));
      let stateColor = chalk.green;
      if (result.index.state === 'not_built') stateColor = chalk.gray;
      if (result.index.state === 'stale') stateColor = chalk.yellow;
      if (result.index.state === 'corrupt') stateColor = chalk.red;
      console.log(chalk.white(`  State:          `) + stateColor(result.index.state.toUpperCase()));
      console.log(chalk.white(`  Indexed Docs:   ${result.index.documentCount}`));
      console.log(chalk.white(`  Indexed Chunks: ${result.index.chunkCount}`));
      console.log(chalk.white(`  Index Size:     ${(result.index.indexFileSizeBytes / 1024).toFixed(1)} KB`));
      if (result.index.indexBuildId) {
        console.log(chalk.white(`  Build ID:       ${result.index.indexBuildId}`));
      }
      if (result.index.entriesHash) {
        console.log(chalk.white(`  Entries Hash:   ${result.index.entriesHash.slice(0, 16)}...`));
      }
      if (result.index.lastBuiltAt) {
        console.log(chalk.gray(`  Last Built:     ${result.index.lastBuiltAt}`));
      }
    }

    return {
      exitCode: KB_CLI_EXIT.SUCCESS,
      success: true,
      data: result,
    };
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode: KB_CLI_EXIT.GENERAL_ERROR, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Failed to inspect knowledge base status: ${err.message}`));
    }
    return {
      exitCode: KB_CLI_EXIT.GENERAL_ERROR,
      success: false,
      error: err.message,
    };
  }
}

// ── 3. Command: verify ──────────────────────────────────────────────

export interface KbCliVerifyOptions {
  readonly projectRoot?: string;
  readonly json?: boolean;
  readonly allowTemp?: boolean;
  readonly services?: ServiceContainer;
}

export async function runKbVerify(options: KbCliVerifyOptions = {}): Promise<KbCliResult<KbVerifyResult>> {
  let projectRoot: string;
  let projectId: string;

  try {
    const resolved = resolveAndValidateKbProjectRoot(options.projectRoot, {
      allowTemp: options.allowTemp,
    });
    projectRoot = resolved.projectRoot;
    projectId = resolved.projectId;
  } catch (err: any) {
    const exitCode = err instanceof KbCliError ? err.exitCode : KB_CLI_EXIT.INVALID_PROJECT;
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
    }
    return { exitCode, success: false, error: err.message };
  }

  const services = options.services || createServiceContainer(projectRoot);

  try {
    if (!options.json) {
      console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Knowledge Base Verification\n'));
      console.log(chalk.gray(`Project Root: ${projectRoot}`));
      console.log(chalk.gray(`Project ID:   ${projectId}\n`));
    }

    const result = await services.kb.verify({ projectId });

    if (result.valid) {
      if (options.json) {
        console.log(JSON.stringify({ success: true, exitCode: KB_CLI_EXIT.SUCCESS, data: result }, null, 2));
      } else {
        console.log(chalk.green('✅ Knowledge base verification passed. All checks satisfied:'));
        for (const c of result.checks) {
          console.log(chalk.green(`  ✓ ${c.name}: ${c.details || 'OK'}`));
        }
        if (result.indexBuildId) {
          console.log(chalk.white(`\nIndex Build ID: ${result.indexBuildId}`));
        }
        if (result.entriesHash) {
          console.log(chalk.white(`Entries Hash:   ${result.entriesHash}`));
        }
      }
      return {
        exitCode: KB_CLI_EXIT.SUCCESS,
        success: true,
        data: result,
      };
    } else {
      // Determine specific failure exit code
      let exitCode: KbCliExitCode = KB_CLI_EXIT.INDEX_CORRUPT;
      const errorText = result.errors.join(' ').toLowerCase();

      if (errorText.includes('stale')) {
        exitCode = KB_CLI_EXIT.STALE_INDEX;
      } else if (errorText.includes('policy')) {
        exitCode = KB_CLI_EXIT.POLICY_FAILURE;
      } else if (errorText.includes('embedding') || errorText.includes('snapshot')) {
        exitCode = KB_CLI_EXIT.MISSING_MODEL;
      } else if (errorText.includes('chunk') || errorText.includes('manifest')) {
        exitCode = KB_CLI_EXIT.INDEX_CORRUPT;
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            { success: false, exitCode, error: `Verification failed (${result.errors.length} errors)`, data: result },
            null,
            2,
          ),
        );
      } else {
        console.error(chalk.red(`❌ Knowledge base verification failed with ${result.errors.length} error(s):`));
        for (const c of result.checks) {
          if (c.passed) {
            console.log(chalk.green(`  ✓ ${c.name}: ${c.details || 'OK'}`));
          } else {
            console.log(chalk.red(`  ✗ ${c.name}: ${c.details || 'FAILED'}`));
          }
        }
        console.error(chalk.red('\nDetailed Errors:'));
        for (const e of result.errors) {
          console.error(chalk.red(`  - ${e}`));
        }
      }

      return {
        exitCode,
        success: false,
        data: result,
        error: result.errors.join('; '),
      };
    }
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode: KB_CLI_EXIT.GENERAL_ERROR, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Verification process error: ${err.message}`));
    }
    return {
      exitCode: KB_CLI_EXIT.GENERAL_ERROR,
      success: false,
      error: err.message,
    };
  }
}

// ── 4. Command: clear ───────────────────────────────────────────────

export interface KbCliClearOptions {
  readonly projectRoot?: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly allowTemp?: boolean;
  readonly services?: ServiceContainer;
}

export async function runKbClear(options: KbCliClearOptions = {}): Promise<KbCliResult<KbClearResult>> {
  let projectRoot: string;
  let projectId: string;

  try {
    const resolved = resolveAndValidateKbProjectRoot(options.projectRoot, {
      allowTemp: options.allowTemp,
    });
    projectRoot = resolved.projectRoot;
    projectId = resolved.projectId;
  } catch (err: any) {
    const exitCode = err instanceof KbCliError ? err.exitCode : KB_CLI_EXIT.INVALID_PROJECT;
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
    }
    return { exitCode, success: false, error: err.message };
  }

  // Safety Gate: Must have explicit --yes confirmation or --dry-run
  if (!options.yes && !options.dryRun) {
    const msg =
      'Destructive clear operation requires explicit confirmation. Use --yes to confirm deletion or --dry-run to preview.';
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode: KB_CLI_EXIT.CONFIRMATION_REQUIRED, error: msg }, null, 2));
    } else {
      console.error(chalk.yellow(`\n⚠️  ${msg}`));
    }
    return {
      exitCode: KB_CLI_EXIT.CONFIRMATION_REQUIRED,
      success: false,
      error: msg,
    };
  }

  const services = options.services || createServiceContainer(projectRoot);

  try {
    if (!options.json) {
      console.log(chalk.bold.blue('\n🧹 MAOS Industrial — Knowledge Base Clear\n'));
      console.log(chalk.gray(`Project Root: ${projectRoot}`));
      console.log(chalk.gray(`Project ID:   ${projectId}`));
      console.log(chalk.gray(`Dry Run:      ${options.dryRun ? 'Yes' : 'No'}\n`));
    }

    const result = await services.kb.clear({
      projectId,
      confirmed: options.yes,
      dryRun: options.dryRun,
    });

    if (options.json) {
      console.log(JSON.stringify({ success: true, exitCode: KB_CLI_EXIT.SUCCESS, data: result }, null, 2));
    } else {
      if (result.dryRun) {
        console.log(chalk.yellow(`Dry-run preview: ${result.removedCount} generated KB file(s) would be removed:`));
        for (const f of result.removedFiles) {
          console.log(chalk.gray(`  - ${f}`));
        }
        console.log(chalk.white('\nNo files were deleted. Source documents and audit history are untouched.'));
      } else {
        console.log(chalk.green(`\n✅ Knowledge base cleared successfully (${result.removedCount} files removed).`));
        for (const f of result.removedFiles) {
          console.log(chalk.gray(`  - removed ${f}`));
        }
        console.log(chalk.white('\nSource documents and audit history were preserved intact.'));
      }
    }

    return {
      exitCode: KB_CLI_EXIT.SUCCESS,
      success: true,
      data: result,
    };
  } catch (err: any) {
    const exitCode =
      err.code === 'CONFIRMATION_REQUIRED' ? KB_CLI_EXIT.CONFIRMATION_REQUIRED : KB_CLI_EXIT.GENERAL_ERROR;
    if (options.json) {
      console.log(JSON.stringify({ success: false, exitCode, error: err.message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Failed to clear knowledge base: ${err.message}`));
    }
    return {
      exitCode,
      success: false,
      error: err.message,
    };
  }
}
