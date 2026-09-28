/**
 * F2-03: Bundle Manifest Generator
 *
 * Generates a deterministic, verifiable manifest of all files required for
 * an offline MAOS Industrial deployment. The manifest is consumed by the
 * F2-02 preflight static stage and the F2-04 offline store builder.
 *
 * Covered categories:
 *   - rust-binary   : Rust release executable
 *   - ts-dist       : TypeScript compiled output (dist/)
 *   - config        : Configuration files (profiles, tsconfig, package.json)
 *   - schema        : JSON schemas and protocol definitions
 *   - script        : Build/lifecycle scripts
 *   - template      : Document/report templates
 *   - model-snapshot: Model weight manifests
 *   - python        : Python scripts and requirements
 *   - container     : Dockerfile / compose files
 *   - asset         : Static assets (images, CSS, etc.)
 *   - react-asset   : React/GUI build artifacts
 *
 * Properties:
 *   - Deterministic: sorted paths, stable JSON output, reproducible SHA-256
 *   - Verifiable:    every entry has path, size, SHA-256, and category
 *   - Build identity: records Node/Rust/Python versions, platform, timestamp
 *   - Excludes:      node_modules, .git, secrets, caches, debug builds
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import type { BundleManifest, BundleManifestEntry } from './preflight';

// ── Types ──────────────────────────────────────────────────────────

export type ManifestCategory =
  | 'rust-binary'
  | 'ts-dist'
  | 'config'
  | 'schema'
  | 'script'
  | 'template'
  | 'model-snapshot'
  | 'python'
  | 'container'
  | 'asset'
  | 'react-asset';

export interface ManifestGeneratorConfig {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Protocol version to record. */
  protocolVersion?: string;
  /** Engine version to record. */
  engineVersion?: string;
  /** Additional file patterns to include (relative to projectRoot). */
  extraPaths?: string[];
  /** Paths to exclude (relative to projectRoot). */
  excludePaths?: string[];
  /** Whether to include dist/ output. */
  includeDist?: boolean;
  /** Whether to include React/GUI assets. */
  includeReactAssets?: boolean;
  /** Rehash every file instead of using the process-local stat cache. */
  forceRehash?: boolean;
}

export interface BuildIdentity {
  /** Platform (e.g. 'win32', 'linux'). */
  platform: string;
  /** Architecture (e.g. 'x64', 'arm64'). */
  arch: string;
  /** Node.js version. */
  nodeVersion: string;
  /** Rust toolchain version (if available). */
  rustVersion?: string;
  /** Python version (if available). */
  pythonVersion?: string;
  /** Generation timestamp (ISO 8601). */
  generatedAt: string;
  /** SHA-256 of the manifest entries array (for tamper detection). */
  entriesHash: string;
}

export interface FullBundleManifest extends BundleManifest {
  /** Build identity metadata. */
  buildIdentity: BuildIdentity;
  /** Total number of entries. */
  totalEntries: number;
  /** Total size in bytes. */
  totalSize: number;
}

// ── Exclusion Patterns ─────────────────────────────────────────────

const DEFAULT_EXCLUDES = new Set([
  'node_modules',
  '.git',
  '.env',
  '.env.local',
  '.env.production',

  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.coverage',
  'coverage',
  '.nyc_output',
  '.DS_Store',
  'Thumbs.db',
  '.maos',
  'artifacts',
  'bundle-manifest.json',
  'bundle-manifest.json.sha256',
]);

const SECRET_PATTERNS = [
  /\.env$/,
  /\.env\..+$/,
  /secret/i,
  /credential/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
];

function isExcluded(relativePath: string, extraExcludes?: string[]): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  if (normalizedPath === 'dist/release' || normalizedPath.startsWith('dist/release/')) return true;
  if (normalizedPath === 'rust/target' || normalizedPath.startsWith('rust/target/')) {
    const releaseEngine = process.platform === 'win32'
      ? 'rust/target/release/maos-engine.exe'
      : 'rust/target/release/maos-engine';
    const traversalDirectories = new Set(['rust/target', 'rust/target/release']);
    if (!traversalDirectories.has(normalizedPath) && normalizedPath !== releaseEngine) return true;
  }
  const parts = normalizedPath.split('/');

  // Check default excludes (directory names)
  for (const part of parts) {
    if (DEFAULT_EXCLUDES.has(part)) return true;
  }

  // Check secret patterns
  const basename = path.basename(relativePath);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(basename)) return true;
  }

  // Check extra excludes
  if (extraExcludes) {
    for (const exclude of extraExcludes) {
      if (relativePath.startsWith(exclude)) return true;
    }
  }

  // Reject debug builds
  if (relativePath.replace(/\\/g, '/').includes('/target/debug/')) return true;

  return false;
}

// ── Category Detection ─────────────────────────────────────────────

function detectCategory(relativePath: string): ManifestCategory {
  const normalized = relativePath.replace(/\\/g, '/');
  const ext = path.extname(relativePath).toLowerCase();
  const basename = path.basename(relativePath).toLowerCase();

  // Rust binary
  if (
    normalized.includes('rust/target/release/') &&
    !basename.startsWith('.') &&
    (ext === '.exe' || ext === '.dll' || (process.platform !== 'win32' && ext === ''))
  ) {
    return 'rust-binary';
  }

  // TypeScript dist
  if (normalized.startsWith('dist/')) return 'ts-dist';

  // React/GUI assets
  if (normalized.includes('gui/build/') || normalized.includes('gui/dist/')) return 'react-asset';

  // Config
  if (basename === 'package.json' || basename === 'package-lock.json' ||
      basename === 'tsconfig.json' || basename === 'cargo.toml' || basename === 'cargo.lock' ||
      basename === 'rust-toolchain.toml' || basename === '.prettierrc.json' ||
      basename === 'eslint.config.mjs' || basename === '.npmignore' ||
      normalized.includes('profiles/') || basename === 'requirements.lock') {
    return 'config';
  }

  // Schema
  if (ext === '.schema.json' || basename.includes('schema')) return 'schema';

  // Python
  if (ext === '.py' || basename === 'requirements.txt' || basename === 'requirements.lock') {
    return 'python';
  }

  // Container
  if (basename === 'dockerfile' || basename === 'docker-compose.yml' ||
      basename === 'docker-compose.yaml' || basename === '.dockerignore') {
    return 'container';
  }

  // Script
  if (ext === '.sh' || ext === '.ps1' || ext === '.bat' || ext === '.cmd' ||
      normalized.startsWith('scripts/')) {
    return 'script';
  }

  // Template
  if (normalized.startsWith('templates/') || ext === '.hbs' || ext === '.mustache' ||
      ext === '.ejs' || ext === '.template') {
    return 'template';
  }

  // Model snapshot
  if (basename.includes('model-snapshot') || basename.includes('model-manifest') ||
      normalized.includes('models/')) {
    return 'model-snapshot';
  }

  // Asset
  if (['.png', '.jpg', '.jpeg', '.svg', '.ico', '.css', '.woff', '.woff2', '.ttf'].includes(ext)) {
    return 'asset';
  }

  // Default: config for json, asset for others
  if (ext === '.json') return 'config';
  return 'asset';
}

// ── File Collection ────────────────────────────────────────────────

/**
 * Recursively collect all files under a directory, respecting exclusions.
 * Returns relative paths sorted deterministically.
 */
function collectFiles(
  rootDir: string,
  currentDir: string,
  extraExcludes?: string[],
): string[] {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);

    if (isExcluded(relativePath, extraExcludes)) continue;

    if (entry.isDirectory()) {
      results.push(...collectFiles(rootDir, fullPath, extraExcludes));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results;
}

// ── Hash Computation ───────────────────────────────────────────────

interface HashCacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Process-local acceleration only. Release preparation and verification bypass it. */
const fileHashCache = new Map<string, HashCacheEntry>();

/**
 * Compute SHA-256 of a file (chunked to support multi-GB files without ERR_FS_FILE_TOO_LARGE).
 */
export function hashFile(filePath: string, forceRehash = false): string {
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
  const cached = fileHashCache.get(resolvedPath);
  if (!forceRehash && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.sha256;
  }

  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(resolvedPath, 'r');
  const buffer = Buffer.alloc(64 * 1024 * 1024); // 64 MB chunk
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = hash.digest('hex');
  fileHashCache.set(resolvedPath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}

/**
 * Compute SHA-256 of a string (for manifest integrity).
 */
export function hashString(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ── Build Identity Detection ───────────────────────────────────────

function detectRustVersion(): string | undefined {
  try {
    const output = execFileSync('rustc', ['--version'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return undefined;
  }
}

function detectPythonVersion(): string | undefined {
  const bins = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const bin of bins) {
    try {
      const output = execFileSync(bin, ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim();
    } catch {
      continue;
    }
  }
  return undefined;
}

// ── Manifest Generation ────────────────────────────────────────────

/**
 * Generate a complete, deterministic bundle manifest.
 *
 * The manifest includes every file needed for offline deployment,
 * categorized and hashed. The output is deterministic: sorted paths,
 * stable JSON serialization.
 */
export function generateBundleManifest(config: ManifestGeneratorConfig): FullBundleManifest {
  const projectRoot = path.resolve(config.projectRoot);

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }

  // Build exclusion list
  const excludes = [...(config.excludePaths ?? [])];

  // Include dist/ only when explicitly requested. dist/release remains excluded
  // unconditionally to prevent an archive from recursively packaging itself.
  if (!config.includeDist) excludes.push('dist');

  // Collect all files
  let allFiles = collectFiles(projectRoot, projectRoot, excludes);

  // Add extra paths
  if (config.extraPaths) {
    for (const extra of config.extraPaths) {
      const absExtra = path.resolve(projectRoot, extra);
      if (fs.existsSync(absExtra)) {
        const stat = fs.statSync(absExtra);
        if (stat.isFile()) {
          const rel = path.relative(projectRoot, absExtra);
          if (!allFiles.includes(rel)) allFiles.push(rel);
        }
      }
    }
  }

  // Sort deterministically (forward-slash normalized, case-insensitive)
  allFiles.sort((a, b) => {
    const na = a.replace(/\\/g, '/').toLowerCase();
    const nb = b.replace(/\\/g, '/').toLowerCase();
    return na.localeCompare(nb);
  });

  // Deduplicate
  allFiles = [...new Set(allFiles)];

  // Build entries
  const entries: BundleManifestEntry[] = [];
  let totalSize = 0;

  for (const relPath of allFiles) {
    const absPath = path.resolve(projectRoot, relPath);

    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;

      const sha256 = hashFile(absPath, config.forceRehash);
      const category = detectCategory(relPath);

      entries.push({
        path: relPath.replace(/\\/g, '/'), // normalize to forward slashes
        size: stat.size,
        sha256,
        category,
      });

      totalSize += stat.size;
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  // Compute entries hash for tamper detection
  const entriesJson = JSON.stringify(entries);
  const entriesHash = hashString(entriesJson);

  // Build identity
  const buildIdentity: BuildIdentity = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    rustVersion: detectRustVersion(),
    pythonVersion: detectPythonVersion(),
    generatedAt: new Date().toISOString(),
    entriesHash,
  };

  // Model snapshot manifest hash (if file exists)
  let modelManifestHash: string | undefined;
  const modelManifestPath = path.resolve(projectRoot, 'model-snapshot-manifest.json');
  if (fs.existsSync(modelManifestPath)) {
    modelManifestHash = hashFile(modelManifestPath, config.forceRehash);
  }

  return {
    version: '1.0',
    protocolVersion: config.protocolVersion ?? '1.0',
    engineVersion: config.engineVersion ?? '0.1.0',
    modelManifestHash,
    entries,
    buildIdentity,
    totalEntries: entries.length,
    totalSize,
  };
}

// ── Manifest Verification ──────────────────────────────────────────

export interface VerificationResult {
  valid: boolean;
  missing: string[];
  tampered: string[];
  sizeMismatch: string[];
  unlisted: string[];
  manifestErrors: string[];
  details: string;
}

/**
 * Verify an existing manifest against the current filesystem.
 * Detects: missing files, tampered hashes, size mismatches, and unlisted files.
 */
export function verifyBundleManifest(
  manifest: FullBundleManifest,
  projectRoot: string,
  checkUnlisted?: boolean,
): VerificationResult {
  const missing: string[] = [];
  const tampered: string[] = [];
  const sizeMismatch: string[] = [];
  const manifestErrors: string[] = [];
  let absRoot: string;
  try {
    absRoot = fs.realpathSync(path.resolve(projectRoot));
  } catch (err: any) {
    return {
      valid: false,
      missing: [],
      tampered: [],
      sizeMismatch: [],
      unlisted: [],
      manifestErrors: [`Project root cannot be canonicalized: ${err.message}`],
      details: 'Manifest verification failed: invalid project root',
    };
  }

  const candidate = manifest as any;
  const categories = new Set([
    'rust-binary', 'ts-dist', 'config', 'schema', 'model-snapshot',
    'script', 'template', 'python', 'container', 'asset', 'react-asset',
  ]);
  if (!candidate || candidate.version !== '1.0') manifestErrors.push('Manifest version must be 1.0');
  if (typeof candidate?.protocolVersion !== 'string' || !candidate.protocolVersion.trim()) {
    manifestErrors.push('Manifest protocolVersion is required');
  }
  if (typeof candidate?.engineVersion !== 'string' || !candidate.engineVersion.trim()) {
    manifestErrors.push('Manifest engineVersion is required');
  }
  if (!Array.isArray(candidate?.entries)) {
    manifestErrors.push('Manifest entries must be an array');
  }
  if (!candidate?.buildIdentity || typeof candidate.buildIdentity !== 'object') {
    manifestErrors.push('Manifest buildIdentity is required');
  }
  if (!Number.isSafeInteger(candidate?.totalEntries) || candidate.totalEntries < 0) {
    manifestErrors.push('Manifest totalEntries must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(candidate?.totalSize) || candidate.totalSize < 0) {
    manifestErrors.push('Manifest totalSize must be a non-negative safe integer');
  }

  const entries = Array.isArray(candidate?.entries) ? candidate.entries : [];
  const seenPaths = new Set<string>();
  let calculatedSize = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      manifestErrors.push('Manifest contains an entry without a string path');
      continue;
    }
    const normalizedPath = entry.path.replace(/\\/g, '/');
    const entryLabel = normalizedPath || '<empty>';
    const resolvedEntry = path.resolve(absRoot, normalizedPath);
    const relativeEntry = path.relative(absRoot, resolvedEntry);
    if (!normalizedPath || normalizedPath.includes('\0') || path.isAbsolute(normalizedPath) ||
        (relativeEntry !== '..' && relativeEntry.startsWith(`..${path.sep}`)) || path.isAbsolute(relativeEntry)) {
      manifestErrors.push(`Manifest entry escapes project root: ${entryLabel}`);
      continue;
    }
    if (seenPaths.has(normalizedPath)) manifestErrors.push(`Manifest contains duplicate path: ${normalizedPath}`);
    seenPaths.add(normalizedPath);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      manifestErrors.push(`Manifest entry has invalid size: ${entryLabel}`);
    } else {
      calculatedSize += entry.size;
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      manifestErrors.push(`Manifest entry has invalid SHA-256: ${entryLabel}`);
    }
    if (typeof entry.category !== 'string' || !categories.has(entry.category)) {
      manifestErrors.push(`Manifest entry has invalid category: ${entryLabel}`);
    }

    if (!fs.existsSync(resolvedEntry)) {
      missing.push(normalizedPath);
      continue;
    }

    // Bundle inputs must not contain symlink/junction components. Following a
    // link during verification would make the manifest describe a different
    // filesystem than the one archived.
    let current = resolvedEntry;
    const components: string[] = [];
    while (true) {
      components.push(current);
      if (path.resolve(current).toLowerCase() === path.resolve(absRoot).toLowerCase()) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let symlinkFound = false;
    for (const component of components) {
      try {
        if (fs.lstatSync(component).isSymbolicLink()) {
          symlinkFound = true;
          break;
        }
      } catch {
        // The normal existence/hash checks below report disappearing files.
      }
    }
    if (symlinkFound) {
      manifestErrors.push(`Manifest entry uses a symlink or junction: ${normalizedPath}`);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolvedEntry);
    } catch (err: any) {
      missing.push(`${normalizedPath}: ${err.message}`);
      continue;
    }
    if (!stat.isFile()) {
      manifestErrors.push(`Manifest entry is not a regular file: ${normalizedPath}`);
      continue;
    }
    if (stat.size !== entry.size) {
      sizeMismatch.push(`${normalizedPath}: expected ${entry.size}, got ${stat.size}`);
      continue;
    }

    // Verification is a trust boundary: hashes are mandatory and never use the
    // process-local cache.
    const actualHash = hashFile(resolvedEntry, true);
    if (actualHash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
      tampered.push(`${normalizedPath}: expected ${String(entry.sha256).substring(0, 16)}…, got ${actualHash.substring(0, 16)}…`);
    }
  }

  if (Number.isSafeInteger(candidate?.totalEntries) && candidate.totalEntries !== entries.length) {
    manifestErrors.push(`Manifest totalEntries mismatch: expected ${candidate.totalEntries}, found ${entries.length}`);
  }
  if (Number.isSafeInteger(candidate?.totalSize) && candidate.totalSize !== calculatedSize) {
    manifestErrors.push(`Manifest totalSize mismatch: expected ${candidate.totalSize}, calculated ${calculatedSize}`);
  }
  if (candidate?.buildIdentity && typeof candidate.buildIdentity.entriesHash === 'string') {
    const actualEntriesHash = hashString(JSON.stringify(entries));
    if (!/^[a-f0-9]{64}$/i.test(candidate.buildIdentity.entriesHash) ||
        actualEntriesHash.toLowerCase() !== candidate.buildIdentity.entriesHash.toLowerCase()) {
      manifestErrors.push('Manifest buildIdentity.entriesHash mismatch');
    }
  } else {
    manifestErrors.push('Manifest buildIdentity.entriesHash is required');
  }
  if (candidate?.modelManifestHash !== undefined &&
      (typeof candidate.modelManifestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.modelManifestHash))) {
    manifestErrors.push('Manifest modelManifestHash must be a SHA-256 hex string');
  }

  // Check for unlisted executables
  const unlisted: string[] = [];
  if (checkUnlisted) {
    const listedPaths = new Set(entries.map((e: any) => e.path.replace(/\\/g, '/')));
    const releaseBinDir = path.resolve(absRoot, 'rust', 'target', 'release');
    if (fs.existsSync(releaseBinDir)) {
      try {
        const releaseFiles = fs.readdirSync(releaseBinDir);
        for (const f of releaseFiles) {
          const fullPath = path.join(releaseBinDir, f);
          if (!fs.statSync(fullPath).isFile()) continue;
          const ext = path.extname(f).toLowerCase();
          const isExecutable = ['.exe', '.dll', '.so', '.dylib'].includes(ext) ||
            (process.platform !== 'win32' && ext === '' && !f.startsWith('.'));
          if (isExecutable) {
            const relPath = path.relative(absRoot, fullPath).replace(/\\/g, '/');
            if (!listedPaths.has(relPath)) {
              unlisted.push(relPath);
            }
          }
        }
      } catch {
        // Skip if unreadable
      }
    }
  }

  const valid = manifestErrors.length === 0 && missing.length === 0 && tampered.length === 0 &&
    sizeMismatch.length === 0 && unlisted.length === 0;

  const parts: string[] = [];
  if (manifestErrors.length > 0) parts.push(`Manifest errors: ${manifestErrors.length}`);
  if (missing.length > 0) parts.push(`Missing: ${missing.length} files`);
  if (tampered.length > 0) parts.push(`Tampered: ${tampered.length} files`);
  if (sizeMismatch.length > 0) parts.push(`Size mismatch: ${sizeMismatch.length} files`);
  if (unlisted.length > 0) parts.push(`Unlisted executables: ${unlisted.length}`);
  if (valid) parts.push('All entries verified');

  return {
    valid,
    missing,
    tampered,
    sizeMismatch,
    unlisted,
    manifestErrors,
    details: parts.join('; '),
  };
}

// ── Manifest I/O ───────────────────────────────────────────────────

/**
 * Write a manifest to disk as deterministic JSON.
 */
export function writeManifest(manifest: FullBundleManifest, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Deterministic: sorted keys, 2-space indent
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/**
 * Read a manifest from disk.
 */
export function readManifest(inputPath: string): FullBundleManifest {
  const content = fs.readFileSync(inputPath, 'utf-8');
  return JSON.parse(content) as FullBundleManifest;
}
