/**
 * F2-05: Package Industrial Assets
 *
 * Builds a release package containing ONLY allowlisted contents.
 *
 * INCLUDED (allowlisted):
 *   - Industrial profile config and pool
 *   - Service definitions and schemas
 *   - Rust release binary (hash-verified)
 *   - TypeScript compiled dist/
 *   - React/GUI build output
 *   - Templates and report schemas
 *   - Lifecycle scripts
 *   - Demo materials
 *   - Offline store manifests (not store contents — those are separate)
 *   - Bundle manifest
 *   - requirements.lock, package.json, package-lock.json, Cargo.lock
 *
 * EXCLUDED (hard deny):
 *   - Secrets (.env, .pem, .key, credentials)
 *   - Caches (node_modules, __pycache__, .mypy_cache, target/debug)
 *   - Unintended model weights (multi-GB .safetensors, .bin, .onnx)
 *   - Confidential artifacts (internal docs, API keys, tokens)
 *   - Generated/temporary files (.tgz, coverage, .nyc_output)
 *   - Source control (.git, .github)
 *   - Development-only files (test fixtures, debug scripts)
 *
 * The allowlist is the source of truth. If a file is not in the allowlist,
 * it is excluded. This is defense-in-depth: even if the denylist misses
 * something, the allowlist catches it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────────────

export interface PackageConfig {
  /** Absolute project root. */
  projectRoot: string;
  /** Output directory for the package. */
  outputDir?: string;
  /** Include dist/ compiled output. */
  includeDist?: boolean;
  /** Include demo materials. */
  includeDemo?: boolean;
  /** Custom extra allowlist entries (relative paths). */
  extraAllowlist?: string[];
  /** Custom extra denylist patterns. */
  extraDenylist?: string[];
  /** Rehash every file instead of using the local build cache. */
  forceRehash?: boolean;
}

export interface PackageEntry {
  /** Relative path in the package. */
  relativePath: string;
  /** Absolute source path. */
  sourcePath: string;
  /** File size in bytes. */
  size: number;
  /** SHA-256 hash. */
  sha256: string;
  /** Allowlist rule that matched. */
  allowRule: string;
}

export interface PackageResult {
  /** Whether packaging succeeded. */
  success: boolean;
  /** Entries included in the package. */
  entries: PackageEntry[];
  /** Files that were denied (with reasons). */
  denied: Array<{ path: string; reason: string }>;
  /** Total size in bytes. */
  totalSize: number;
  /** Total entry count. */
  totalEntries: number;
  /** Package manifest hash. */
  manifestHash: string;
  /** Errors encountered. */
  errors: string[];
}

// ── Allowlist Rules ────────────────────────────────────────────────

export interface AllowlistRule {
  /** Rule identifier. */
  id: string;
  /** Description. */
  description: string;
  /** Glob-like pattern or path prefix (forward slashes). */
  pattern: string;
  /** File extensions to match (without dot). Empty = any. */
  extensions?: string[];
  /** Whether this is a directory prefix match. */
  isPrefix?: boolean;
}

/**
 * The canonical allowlist for industrial packaging.
 * Only files matching these rules are included.
 */
export const INDUSTRIAL_ALLOWLIST: AllowlistRule[] = [
  // ── Profile & config ──
  {
    id: 'profile-config',
    description: 'Industrial profile configuration',
    pattern: 'profiles/industrial/',
    isPrefix: true,
  },
  {
    id: 'package-json',
    description: 'npm package manifest',
    pattern: 'package.json',
  },
  {
    id: 'package-lock',
    description: 'npm lockfile for reproducible install',
    pattern: 'package-lock.json',
  },
  {
    id: 'tsconfig',
    description: 'TypeScript configuration',
    pattern: 'tsconfig.json',
  },
  {
    id: 'requirements-lock',
    description: 'Python dependency lock',
    pattern: 'requirements.lock',
  },

  // ── Rust ──
  {
    id: 'rust-release-binary',
    description: 'Rust release executable',
    pattern: 'rust/target/release/',
    isPrefix: true,
    extensions: ['exe', 'dll', ''],
  },
  {
    id: 'rust-cargo-toml',
    description: 'Rust workspace manifest',
    pattern: 'rust/Cargo.toml',
  },
  {
    id: 'rust-cargo-lock',
    description: 'Rust dependency lock',
    pattern: 'rust/Cargo.lock',
  },
  {
    id: 'rust-toolchain',
    description: 'Rust toolchain pin',
    pattern: 'rust/rust-toolchain.toml',
  },
  {
    id: 'rust-cargo-config',
    description: 'Rust build/offline configuration',
    pattern: 'rust/.cargo/',
    isPrefix: true,
  },
  {
    id: 'rust-crate-sources',
    description: 'Rust engine source code',
    pattern: 'rust/crates/',
    isPrefix: true,
    extensions: ['rs', 'toml'],
  },
  {
    id: 'rust-vendor-store',
    description: 'Vendored Rust crates for offline builds',
    pattern: 'rust/vendor/',
    isPrefix: true,
  },

  // ── TypeScript source ──
  {
    id: 'ts-source',
    description: 'TypeScript source code',
    pattern: 'src/',
    isPrefix: true,
    extensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'svg', 'py'],
  },

  // ── Dist (opt-in) ──
  {
    id: 'ts-dist',
    description: 'Compiled TypeScript output',
    pattern: 'dist/',
    isPrefix: true,
  },

  // ── Scripts ──
  {
    id: 'lifecycle-scripts',
    description: 'Lifecycle and preflight scripts',
    pattern: 'scripts/',
    isPrefix: true,
    extensions: ['ps1', 'sh', 'js', 'py', 'bat', 'cmd'],
  },

  // ── Schemas/Templates ──
  {
    id: 'templates',
    description: 'Report and document templates',
    pattern: 'templates/',
    isPrefix: true,
  },

  // ── Demo ──
  {
    id: 'demo-materials',
    description: 'Demo datasets and scripts',
    pattern: 'demo/',
    isPrefix: true,
  },

  // ── Offline stores ──
  {
    id: 'offline-npm-store',
    description: 'Offline npm package store',
    pattern: 'offline-stores/npm/',
    isPrefix: true,
  },
  {
    id: 'offline-python-store',
    description: 'Offline Python wheelhouse',
    pattern: 'offline-stores/python-wheels/',
    isPrefix: true,
  },
  {
    id: 'offline-tesseract-store',
    description: 'Offline OCR assets',
    pattern: 'offline-stores/tesseract/',
    isPrefix: true,
  },
  {
    id: 'offline-sandbox-store',
    description: 'Offline sandbox image',
    pattern: 'offline-stores/sandbox-image/',
    isPrefix: true,
  },
  {
    id: 'offline-model-store',
    description: 'Pinned offline model payload',
    pattern: 'offline-stores/model-snapshot/',
    isPrefix: true,
  },

  // ── Manifests ──
  {
    id: 'model-snapshot-manifest',
    description: 'Model snapshot integrity manifest',
    pattern: 'model-snapshot-manifest.json',
  },
  {
    id: 'vlm-snapshot-manifest',
    description: 'Pinned VLM snapshot integrity manifest',
    pattern: 'vlm-snapshot-manifest.json',
  },
  {
    id: 'embedding-snapshot-manifest',
    description: 'Pinned Embedding snapshot integrity manifest',
    pattern: 'embedding-snapshot-manifest.json',
  },
  {
    id: 'npm-cache-manifest',
    description: 'npm cache manifest',
    pattern: 'npm-cache-manifest.json',
  },
  {
    id: 'bundle-manifest',
    description: 'Bundle integrity manifest',
    pattern: 'bundle-manifest.json',
  },

  // ── Documentation (release only) ──
  {
    id: 'readme',
    description: 'Project README',
    pattern: 'README.md',
  },
  {
    id: 'license',
    description: 'License file',
    pattern: 'LICENSE',
  },
  {
    id: 'contributing',
    description: 'Contributing guide',
    pattern: 'CONTRIBUTING.md',
  },

  // ── Preserved files ──
  {
    id: 'rust-test-txt',
    description: 'Preserved test marker (never delete)',
    pattern: 'rust/test.txt',
  },
];

// ── Denylist Patterns ──────────────────────────────────────────────

/**
 * Hard deny patterns. These override the allowlist.
 * Defense-in-depth: even if an allowlist rule accidentally matches,
 * these patterns block dangerous content.
 */
export const HARD_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Secrets
  { pattern: /\.env$/, reason: 'Environment secrets' },
  { pattern: /\.env\.[a-z]+$/i, reason: 'Environment secrets' },
  { pattern: /\.pem$/, reason: 'Private key' },
  { pattern: /\.key$/, reason: 'Private key' },
  { pattern: /\.p12$/, reason: 'Certificate bundle' },
  { pattern: /\.pfx$/, reason: 'Certificate bundle' },
  { pattern: /secret/i, reason: 'Potential secret' },
  { pattern: /credential/i, reason: 'Potential credential' },
  { pattern: /api[_-]?key/i, reason: 'Potential API key' },
  { pattern: /token\.json$/i, reason: 'Auth token' },

  // Model weights are denied everywhere except the explicitly allowlisted
  // offline model store, where they are the release payload by definition.
  { pattern: /\.safetensors$/, reason: 'Model weights (use offline store)' },
  { pattern: /\.gguf$/, reason: 'Model weights (use offline store)' },
  { pattern: /\.onnx$/, reason: 'Model weights (use offline store)' },
  { pattern: /\.bin$/, reason: 'Potential model weights' },
  { pattern: /pytorch_model/, reason: 'PyTorch model weights' },

  // Caches
  { pattern: /node_modules/, reason: 'npm cache' },
  { pattern: /__pycache__/, reason: 'Python cache' },
  { pattern: /\.mypy_cache/, reason: 'Mypy cache' },
  { pattern: /\.pytest_cache/, reason: 'Pytest cache' },
  { pattern: /\.tox\//, reason: 'Tox cache' },
  { pattern: /target\/debug\//, reason: 'Rust debug build' },

  // Generated/temp
  { pattern: /\.tgz$/, reason: 'Generated tarball' },
  { pattern: /\.tar\.gz$/, reason: 'Generated tarball' },
  { pattern: /coverage\//, reason: 'Test coverage output' },
  { pattern: /\.nyc_output/, reason: 'NYC coverage' },

  // Source control
  { pattern: /^\.git\//, reason: 'Git directory' },
  { pattern: /^\.github\//, reason: 'GitHub config' },
  { pattern: /^\.husky\//, reason: 'Git hooks' },

  // Debug scripts
  { pattern: /^debug_/, reason: 'Debug script' },
];

// ── Matching Logic ─────────────────────────────────────────────────

/**
 * Check if a relative path matches an allowlist rule.
 */
export function matchesAllowlist(
  relativePath: string,
  rules: AllowlistRule[],
  includeDist?: boolean,
  includeDemo?: boolean,
): AllowlistRule | null {
  const normalized = relativePath.replace(/\\/g, '/');

  for (const rule of rules) {
    // Skip dist/ if not opted in
    if (rule.id === 'ts-dist' && !includeDist) continue;
    // Skip demo/ if not opted in
    if (rule.id === 'demo-materials' && !includeDemo) continue;

    if (rule.isPrefix) {
      if (!normalized.startsWith(rule.pattern)) continue;

      // Check extensions if specified
      if (rule.extensions && rule.extensions.length > 0) {
        const ext = path.extname(normalized).replace('.', '');
        // Empty extension means no extension (executables)
        if (!rule.extensions.includes(ext)) continue;
      }

      return rule;
    } else {
      // Exact match
      if (normalized === rule.pattern) return rule;
    }
  }

  return null;
}

/**
 * Check if a relative path is hard-denied.
 */
export function matchesDenylist(
  relativePath: string,
  extraPatterns?: Array<{ pattern: RegExp; reason: string }>,
): { denied: boolean; reason: string } {
  const normalized = relativePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);

  const allPatterns = [...HARD_DENY_PATTERNS, ...(extraPatterns ?? [])];

  const offlineModelPayload = normalized.startsWith('offline-stores/model-snapshot/');
  const offlineNpmPayload = normalized.startsWith('offline-stores/npm/');
  const offlinePythonPayload = normalized.startsWith('offline-stores/python-wheels/');

  for (const { pattern, reason } of allPatterns) {
    const payloadException =
      (offlineModelPayload && (/\.(safetensors|gguf|onnx|bin)$/i.test(basename) || /pytorch_model/i.test(basename))) ||
      (offlineNpmPayload && /\.tgz$/i.test(basename)) ||
      (offlinePythonPayload && /\.(whl|tar\.gz)$/i.test(basename));
    if (payloadException && /Model weights|Potential model weights|PyTorch model weights|Generated tarball/.test(reason)) {
      continue;
    }
    if (pattern.test(normalized) || pattern.test(basename)) {
      return { denied: true, reason };
    }
  }

  return { denied: false, reason: '' };
}

// ── Package Builder ────────────────────────────────────────────────

/**
 * Recursively collect all files under a directory.
 */
const packageHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

function hashFile(filePath: string, forceRehash = false): string {
  const stat = fs.statSync(filePath);
  const cached = packageHashCache.get(filePath);
  if (!forceRehash && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }

  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  packageHashCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash: digest });
  return digest;
}

function collectAllFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
      // Traverse only the Rust release tree; debug/dependency build output is
      // not a deployable package input and is intentionally excluded.
      if (entry.name === 'target') {
        const releaseDir = path.join(full, 'release');
        if (fs.existsSync(releaseDir)) results.push(...collectAllFiles(releaseDir));
        continue;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...collectAllFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Build the industrial release package.
 *
 * This is a DRY-RUN by default — it computes what WOULD be packaged
 * and returns the result. The actual packaging (tar/zip) is a separate step.
 */
export function buildPackageManifest(config: PackageConfig): PackageResult {
  const projectRoot = path.resolve(config.projectRoot);
  const entries: PackageEntry[] = [];
  const denied: Array<{ path: string; reason: string }> = [];
  const errors: string[] = [];

  if (!fs.existsSync(projectRoot)) {
    return {
      success: false,
      entries: [],
      denied: [],
      totalSize: 0,
      totalEntries: 0,
      manifestHash: '',
      errors: [`Project root does not exist: ${projectRoot}`],
    };
  }

  // Merge allowlist with extras
  const allowlist = [...INDUSTRIAL_ALLOWLIST];
  if (config.extraAllowlist) {
    for (const extra of config.extraAllowlist) {
      allowlist.push({
        id: `extra-${extra}`,
        description: `Custom allowlist: ${extra}`,
        pattern: extra,
        isPrefix: extra.endsWith('/'),
      });
    }
  }

  // Merge denylist with extras
  const extraDeny = config.extraDenylist?.map(p => ({
    pattern: new RegExp(p),
    reason: `Custom deny: ${p}`,
  }));

  // Collect all files
  const allFiles = collectAllFiles(projectRoot);

  for (const absPath of allFiles) {
    const relativePath = path.relative(projectRoot, absPath).replace(/\\/g, '/');

    // 1. Check denylist FIRST (overrides allowlist)
    const denyResult = matchesDenylist(relativePath, extraDeny);
    if (denyResult.denied) {
      denied.push({ path: relativePath, reason: denyResult.reason });
      continue;
    }

    // 2. Check allowlist
    const allowRule = matchesAllowlist(
      relativePath, allowlist, config.includeDist, config.includeDemo,
    );
    if (!allowRule) {
      // Not in allowlist — silently excluded (not an error, just not packaged)
      continue;
    }

    // 3. Compute hash and add entry
    try {
      const stat = fs.statSync(absPath);
      const hash = hashFile(absPath, config.forceRehash);

      entries.push({
        relativePath,
        sourcePath: absPath,
        size: stat.size,
        sha256: hash,
        allowRule: allowRule.id,
      });
    } catch (err: any) {
      errors.push(`Failed to read ${relativePath}: ${err.message}`);
    }
  }

  // Sort entries deterministically
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Compute manifest hash
  const manifestData = JSON.stringify(entries.map(e => ({
    path: e.relativePath,
    size: e.size,
    sha256: e.sha256,
  })));
  const manifestHash = crypto.createHash('sha256').update(manifestData).digest('hex');

  const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

  return {
    success: errors.length === 0,
    entries,
    denied,
    totalSize,
    totalEntries: entries.length,
    manifestHash,
    errors,
  };
}

// ── Allowlist Review ───────────────────────────────────────────────

/**
 * Generate a human-readable allowlist review.
 * Used for the gate G2 package allowlist review.
 */
export function generateAllowlistReview(result: PackageResult): string {
  const lines: string[] = [];

  lines.push('# Package Allowlist Review');
  lines.push('');
  lines.push(`Total entries: ${result.totalEntries}`);
  lines.push(`Total size: ${(result.totalSize / 1024 / 1024).toFixed(2)} MB`);
  lines.push(`Manifest hash: ${result.manifestHash}`);
  lines.push('');

  // Group by allowRule
  const byRule = new Map<string, PackageEntry[]>();
  for (const entry of result.entries) {
    const group = byRule.get(entry.allowRule) ?? [];
    group.push(entry);
    byRule.set(entry.allowRule, group);
  }

  lines.push('## Included by Rule');
  lines.push('');
  for (const [ruleId, ruleEntries] of byRule) {
    const rule = INDUSTRIAL_ALLOWLIST.find(r => r.id === ruleId);
    lines.push(`### ${ruleId} — ${rule?.description ?? 'Custom'}`);
    lines.push('');
    for (const entry of ruleEntries) {
      lines.push(`- \`${entry.relativePath}\` (${entry.size} bytes)`);
    }
    lines.push('');
  }

  if (result.denied.length > 0) {
    lines.push('## Denied');
    lines.push('');
    for (const d of result.denied) {
      lines.push(`- \`${d.path}\` — ${d.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
