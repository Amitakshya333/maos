/**
 * UI1-04: Project Folder Validator
 *
 * Enforces strict pre-launch validation on project roots:
 *   - Folder exists and is a directory
 *   - Path is canonicalized and normalized
 *   - Symlink escapes and symlinked roots are rejected
 *   - Unsafe temporary directories rejected (unless explicitly allowed)
 *   - .maos/ directory exists and is a valid directory
 *   - maos.config.json exists, parses as valid JSON, matches schemaVersion: 1
 *   - Domain validation confirms schema compliance
 *   - Computes canonical project-root SHA-256 hash
 *
 * Invariant: Fails closed before any child process is started.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeProjectRootHash } from './instance-identity';
import { validateProject } from '../../domain/validators';
import type { Project } from '../../domain/schemas';

export interface ProjectValidationOptions {
  /**
   * Whether to allow project roots located inside system temp directories.
   * Default: false (enforces sovereign project isolation).
   */
  readonly allowTemp?: boolean;

  /**
   * Whether to allow symbolic links in the project root path.
   * Default: false (strictly prohibits symlink escapes).
   */
  readonly allowSymlinks?: boolean;

  /**
   * Expected schema version in maos.config.json. Default: 1.
   */
  readonly requiredSchemaVersion?: number;
}

export interface CanonicalProjectFolder {
  readonly canonicalPath: string;
  readonly projectRootHash: string;
  readonly projectName: string;
  readonly config: Project;
  readonly configPath: string;
  readonly maosDir: string;
}

export interface ProjectValidationResult {
  readonly valid: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly project?: CanonicalProjectFolder;
}

export class ProjectValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ProjectValidationError';
    this.code = code;
  }
}

/**
 * Validate a project folder against all required layout, schema, and security rules.
 */
export function validateProjectFolder(
  folderPath: string,
  options: ProjectValidationOptions = {},
): ProjectValidationResult {
  if (!folderPath || typeof folderPath !== 'string' || folderPath.trim().length === 0) {
    return {
      valid: false,
      code: 'INVALID_PROJECT_PATH',
      message: 'Project folder path must be a non-empty string.',
    };
  }

  const rawPath = folderPath.trim();

  // 1. Existence check
  if (!fs.existsSync(rawPath)) {
    return {
      valid: false,
      code: 'PROJECT_NOT_FOUND',
      message: `Project directory '${rawPath}' does not exist.`,
    };
  }

  // 2. Directory check
  try {
    const stat = fs.statSync(rawPath);
    if (!stat.isDirectory()) {
      return {
        valid: false,
        code: 'PROJECT_NOT_A_DIRECTORY',
        message: `Path '${rawPath}' is a file or special node, not a directory.`,
      };
    }
  } catch (err: any) {
    return {
      valid: false,
      code: 'PROJECT_ACCESS_ERROR',
      message: `Cannot access project path '${rawPath}': ${err.message}`,
    };
  }

  // 3. Symlink check
  try {
    const lstat = fs.lstatSync(rawPath);
    if (lstat.isSymbolicLink() && !options.allowSymlinks) {
      return {
        valid: false,
        code: 'SYMLINK_PROJECT_ROOT_FORBIDDEN',
        message: `Project root '${rawPath}' is a symbolic link. Symlinked project roots are forbidden for sovereign safety.`,
      };
    }
  } catch (err: any) {
    return {
      valid: false,
      code: 'PROJECT_ACCESS_ERROR',
      message: `Cannot inspect symlink attributes for '${rawPath}': ${err.message}`,
    };
  }

  // 4. Canonical path resolution
  let canonicalPath: string;
  try {
    const real = fs.realpathSync(rawPath);
    canonicalPath = path.resolve(real);
  } catch (err: any) {
    return {
      valid: false,
      code: 'CANONICALIZATION_FAILED',
      message: `Failed to resolve canonical path for '${rawPath}': ${err.message}`,
    };
  }

  // Check if realpath differed from resolved path due to symlink escape
  if (!options.allowSymlinks) {
    const directResolved = path.resolve(rawPath);
    if (directResolved.toLowerCase() !== canonicalPath.toLowerCase()) {
      return {
        valid: false,
        code: 'SYMLINK_PROJECT_ROOT_FORBIDDEN',
        message: `Project path '${rawPath}' resolves to a different canonical path ('${canonicalPath}') via symbolic link.`,
      };
    }
  }

  // 5. Unsafe temporary location check
  if (!options.allowTemp) {
    const tempRoot = path.resolve(os.tmpdir()).toLowerCase();
    const resolvedLower = canonicalPath.toLowerCase();
    if (resolvedLower === tempRoot || resolvedLower.startsWith(tempRoot + path.sep)) {
      return {
        valid: false,
        code: 'UNSAFE_TEMP_PROJECT_ROOT',
        message: `Project root '${canonicalPath}' is located inside the system temporary directory '${tempRoot}'. Opening projects in temporary directories is unsafe without explicit authorization.`,
      };
    }
  }

  // 6. .maos/ directory check
  const maosDir = path.join(canonicalPath, '.maos');
  if (!fs.existsSync(maosDir)) {
    return {
      valid: false,
      code: 'MISSING_MAOS_DIRECTORY',
      message: `Directory '${canonicalPath}' is not initialized as a MAOS project. Missing '.maos' metadata directory.`,
    };
  }

  try {
    const maosLinkStat = fs.lstatSync(maosDir);
    const maosStat = fs.statSync(maosDir);
    if (!maosStat.isDirectory()) {
      return {
        valid: false,
        code: 'MAOS_NOT_A_DIRECTORY',
        message: `Path '${maosDir}' exists but is a file, not a directory.`,
      };
    }
    const canonicalMaosDir = fs.realpathSync(maosDir);
    const expectedMaosDir = path.resolve(canonicalPath, '.maos');
    if (maosLinkStat.isSymbolicLink() || canonicalMaosDir.toLowerCase() !== expectedMaosDir.toLowerCase()) {
      return {
        valid: false,
        code: 'SYMLINK_MAOS_DIRECTORY_FORBIDDEN',
        message: `The trusted '.maos' control directory must be a physical directory inside the canonical project root.`,
      };
    }
  } catch (err: any) {
    return {
      valid: false,
      code: 'PROJECT_ACCESS_ERROR',
      message: `Cannot access '.maos' directory: ${err.message}`,
    };
  }

  // 7. maos.config.json check
  const configPath = path.join(maosDir, 'maos.config.json');
  if (!fs.existsSync(configPath)) {
    return {
      valid: false,
      code: 'MISSING_PROJECT_CONFIG',
      message: `MAOS project configuration file not found at '${configPath}'.`,
    };
  }

  let rawConfig: string;
  let parsedConfig: any;
  try {
    const configLinkStat = fs.lstatSync(configPath);
    const canonicalConfigPath = fs.realpathSync(configPath);
    const configRelative = path.relative(maosDir, canonicalConfigPath);
    if (configLinkStat.isSymbolicLink() || !configRelative || configRelative.startsWith('..') || path.isAbsolute(configRelative)) {
      return {
        valid: false,
        code: 'SYMLINK_PROJECT_CONFIG_FORBIDDEN',
        message: `The trusted project configuration must be a physical file inside '.maos'.`,
      };
    }
    rawConfig = fs.readFileSync(canonicalConfigPath, 'utf-8');
  } catch (err: any) {
    return {
      valid: false,
      code: 'CONFIG_READ_ERROR',
      message: `Cannot read configuration file '${configPath}': ${err.message}`,
    };
  }

  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch (err: any) {
    return {
      valid: false,
      code: 'INVALID_PROJECT_CONFIG',
      message: `Configuration file '${configPath}' contains invalid JSON: ${err.message}`,
    };
  }

  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return {
      valid: false,
      code: 'INVALID_PROJECT_CONFIG',
      message: `Configuration in '${configPath}' must be a JSON object.`,
    };
  }

  // 8. Schema version check
  const expectedSchemaVersion = options.requiredSchemaVersion ?? 1;
  if (parsedConfig.schemaVersion === undefined) {
    return {
      valid: false,
      code: 'INCOMPATIBLE_SCHEMA_VERSION',
      message: `Configuration in '${configPath}' is missing mandatory 'schemaVersion'. Expected: ${expectedSchemaVersion}.`,
    };
  }

  if (parsedConfig.schemaVersion !== expectedSchemaVersion) {
    return {
      valid: false,
      code: 'INCOMPATIBLE_SCHEMA_VERSION',
      message: `Configuration schemaVersion (${parsedConfig.schemaVersion}) does not match expected version (${expectedSchemaVersion}).`,
    };
  }

  // 9. Domain schema validation
  const validation = validateProject(parsedConfig);
  if (!validation.valid) {
    return {
      valid: false,
      code: 'INVALID_PROJECT_CONFIG',
      message: `Configuration schema validation failed: ${validation.errors.join('; ')}`,
    };
  }

  // 10. Canonical hash computation
  const projectRootHash = computeProjectRootHash(canonicalPath);

  const canonicalProject: CanonicalProjectFolder = {
    canonicalPath,
    projectRootHash,
    projectName: parsedConfig.projectName || path.basename(canonicalPath),
    config: parsedConfig as Project,
    configPath,
    maosDir,
  };

  return {
    valid: true,
    project: canonicalProject,
  };
}

/**
 * Assert that a project folder is valid. Throws ProjectValidationError if invalid.
 */
export function assertValidProjectFolder(
  folderPath: string,
  options: ProjectValidationOptions = {},
): CanonicalProjectFolder {
  const result = validateProjectFolder(folderPath, options);
  if (!result.valid || !result.project) {
    throw new ProjectValidationError(
      result.code || 'VALIDATION_FAILED',
      result.message || 'Project validation failed.',
    );
  }
  return result.project;
}
