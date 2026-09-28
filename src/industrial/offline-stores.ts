/**
 * F2-04: Offline Store Builder
 *
 * Creates and validates offline dependency stores for air-gapped deployment.
 * A clean VM install MUST succeed with NO network access, using only:
 *
 *   1. npm archive   — `npm pack` tarball + `npm-cache-manifest.json`
 *   2. Rust vendor   — `cargo vendor` output in `rust/vendor/`
 *   3. Python wheels  — pip download wheelhouse from `requirements.lock`
 *   4. Tesseract      — pre-built binary/installer
 *   5. Sandbox image  — Docker image tarball (`docker save`)
 *   6. Model snapshot — HuggingFace snapshot in verified directory
 *
 * Each store has:
 *   - A build command (runs on a networked machine)
 *   - A validation check (runs on the air-gapped target)
 *   - A deterministic manifest entry
 *
 * Cache miss or runtime download MUST fail explicitly with an actionable
 * error — never silently fetch from the network.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ── Types ──────────────────────────────────────────────────────────

export type StoreName =
  | 'npm'
  | 'rust-vendor'
  | 'python-wheels'
  | 'tesseract'
  | 'sandbox-image'
  | 'model-snapshot';

export interface StoreStatus {
  store: StoreName;
  present: boolean;
  valid: boolean;
  detail: string;
  path: string;
  entryCount?: number;
  totalSizeBytes?: number;
}

export interface OfflineStoreConfig {
  /** Absolute path to project root. */
  projectRoot: string;
  /** Path to requirements.lock for Python wheels. */
  requirementsLockPath?: string;
  /** Path to model snapshot manifest. */
  modelManifestPath?: string;
  /** Docker image name:tag to save. */
  sandboxImage?: string;
  /** Path to Tesseract binary or installer. */
  tesseractPath?: string;
  /** Python wheel download platform (e.g., 'manylinux2014_x86_64'). */
  wheelPlatform?: string;
}

export const STORE_EXIT = {
  SUCCESS: 0,
  NPM_CACHE_MISSING: 100,
  NPM_MANIFEST_MISSING: 101,
  RUST_VENDOR_MISSING: 102,
  RUST_LOCKFILE_MISSING: 103,
  PYTHON_WHEELS_MISSING: 104,
  PYTHON_REQS_MISSING: 105,
  TESSERACT_MISSING: 106,
  SANDBOX_IMAGE_MISSING: 107,
  MODEL_SNAPSHOT_MISSING: 108,
  MODEL_FILE_MISSING: 109,
  MODEL_HASH_MISMATCH: 110,
  STORE_BUILD_FAILED: 111,
  NETWORK_REQUIRED: 112,
} as const;

export class OfflineStoreError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly store: StoreName,
  ) {
    super(message);
    this.name = 'OfflineStoreError';
  }
}

// ── Store Paths ────────────────────────────────────────────────────

export function getStorePaths(projectRoot: string) {
  const root = path.resolve(projectRoot);
  return {
    npmCache: path.join(root, 'offline-stores', 'npm'),
    npmManifest: path.join(root, 'npm-cache-manifest.json'),
    npmTarball: path.join(root, 'offline-stores', 'npm', 'maosorch.tgz'),
    rustVendor: path.join(root, 'rust', 'vendor'),
    rustLockfile: path.join(root, 'rust', 'Cargo.lock'),
    rustCargoConfig: path.join(root, 'rust', '.cargo', 'config.toml'),
    pythonWheels: path.join(root, 'offline-stores', 'python-wheels'),
    requirementsLock: path.join(root, 'requirements.lock'),
    tesseract: path.join(root, 'offline-stores', 'tesseract'),
    sandboxImage: path.join(root, 'offline-stores', 'sandbox-image'),
    modelSnapshot: path.join(root, 'offline-stores', 'model-snapshot'),
    modelManifest: path.join(root, 'model-snapshot-manifest.json'),
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function dirEntryCount(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  try {
    return fs.readdirSync(dirPath, { recursive: true })
      .filter((f) => {
        const full = path.join(dirPath, f as string);
        try { return fs.statSync(full).isFile(); } catch { return false; }
      }).length;
  } catch {
    return 0;
  }
}

function dirTotalSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const files = fs.readdirSync(dirPath, { recursive: true });
    for (const f of files) {
      const full = path.join(dirPath, f as string);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) total += stat.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024 * 1024); // 64 MB chunk
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// ── 1. npm Archive Store ───────────────────────────────────────────

/**
 * Validate the npm offline store.
 * Checks: npm-cache-manifest.json exists, tarball present.
 */
export function validateNpmStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);

  // Check npm-cache-manifest.json
  if (!fs.existsSync(paths.npmManifest)) {
    return {
      store: 'npm',
      present: false,
      valid: false,
      detail: `npm-cache-manifest.json not found at ${paths.npmManifest}. ` +
        `Build with: npm pack && mv *.tgz offline-stores/npm/`,
      path: paths.npmManifest,
    };
  }

  // Check package-lock.json and verify that the cache inventory belongs to it.
  const lockPath = path.join(projectRoot, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    return {
      store: 'npm',
      present: true,
      valid: false,
      detail: 'package-lock.json missing — required for reproducible install',
      path: lockPath,
    };
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(paths.npmManifest, 'utf8')) as Record<string, any>;
    const lockBytes = fs.readFileSync(lockPath);
    const lock = JSON.parse(lockBytes.toString('utf8')) as { packages?: Record<string, unknown> };
    const lockHash = crypto.createHash('sha256').update(lockBytes).digest('hex');
    const lockPackageCount = Object.keys(lock.packages || {}).filter((entry) => entry.length > 0).length;
    const manifestPackages = Array.isArray(manifest.packages) ? manifest.packages : [];
    if (manifest.schemaVersion !== 1) throw new Error('unsupported npm cache manifest schemaVersion');
    if (String(manifest.lockfileSha256 || '').toLowerCase() !== lockHash) throw new Error('package-lock.json SHA-256 does not match cache manifest');
    if (manifest.packageCount !== lockPackageCount || manifest.cachedPackageCount !== lockPackageCount || manifestPackages.length !== lockPackageCount) {
      throw new Error(`cache inventory is incomplete: lockfile=${lockPackageCount}, declared=${manifest.packageCount || 0}, cached=${manifest.cachedPackageCount || 0}, entries=${manifestPackages.length}`);
    }
    if (manifest.missingPackageCount !== 0 || manifest.inventoryStatus !== 'verified') throw new Error('cache inventory is not verified and complete');
    if (!fs.existsSync(paths.npmTarball) || !fs.statSync(paths.npmTarball).isFile() || fs.statSync(paths.npmTarball).size < 1024) {
      throw new Error('maosorch.tgz application archive is missing or invalid');
    }
    const archiveHeader = Buffer.alloc(2);
    const archiveFd = fs.openSync(paths.npmTarball, 'r');
    try { fs.readSync(archiveFd, archiveHeader, 0, archiveHeader.length, 0); } finally { fs.closeSync(archiveFd); }
    if (archiveHeader[0] !== 0x1f || archiveHeader[1] !== 0x8b) throw new Error('maosorch.tgz is not a gzip archive');

    return {
      store: 'npm',
      present: true,
      valid: true,
      detail: `Verified npm cache inventory for ${lockPackageCount} locked packages`,
      path: paths.npmManifest,
      entryCount: lockPackageCount,
      totalSizeBytes: fs.statSync(paths.npmTarball).size,
    };
  } catch (err: any) {
    return {
      store: 'npm',
      present: true,
      valid: false,
      detail: `Invalid npm offline store: ${err.message}`,
      path: paths.npmManifest,
    };
  }
}

/**
 * Build instructions for npm offline store (informational — not executed).
 */
export function npmStoreBuildCommands(): string[] {
  return [
    'mkdir -p offline-stores/npm',
    'npm pack --pack-destination offline-stores/npm/',
    'npm cache clean --force && npm install --prefer-offline --no-audit',
  ];
}

// ── 2. Rust Vendor Store ───────────────────────────────────────────

/**
 * Validate the Rust vendor store.
 * Checks: vendor/ exists, Cargo.lock exists, .cargo/config.toml has vendor source.
 */
export function validateRustVendorStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);

  // Cargo.lock must exist
  if (!fs.existsSync(paths.rustLockfile)) {
    return {
      store: 'rust-vendor',
      present: false,
      valid: false,
      detail: `Cargo.lock not found at ${paths.rustLockfile}. ` +
        `Build with: cargo generate-lockfile --manifest-path rust/Cargo.toml`,
      path: paths.rustLockfile,
    };
  }

  // A real vendored dependency tree is mandatory for an offline build.
  const vendorExists = fs.existsSync(paths.rustVendor);
  const entryCount = vendorExists ? dirEntryCount(paths.rustVendor) : 0;

  // .cargo/config.toml must exist
  if (!fs.existsSync(paths.rustCargoConfig)) {
    return {
      store: 'rust-vendor',
      present: vendorExists,
      valid: false,
      detail: `.cargo/config.toml not found. Required for offline builds.`,
      path: paths.rustCargoConfig,
    };
  }

  const cargoConfig = fs.readFileSync(paths.rustCargoConfig, 'utf8');
  const configuredForVendor = /replace-with\s*=\s*["']vendored-sources["']/.test(cargoConfig) && /directory\s*=\s*["']vendor["']/.test(cargoConfig);
  if (!vendorExists || entryCount === 0 || !configuredForVendor) {
    return {
      store: 'rust-vendor',
      present: vendorExists,
      valid: false,
      detail: !vendorExists || entryCount === 0
        ? 'Cargo vendor directory is missing or empty'
        : '.cargo/config.toml does not replace crates-io with the vendor directory',
      path: paths.rustVendor,
      entryCount,
    };
  }

  return {
    store: 'rust-vendor',
    present: true,
    valid: true,
    detail: `Cargo.lock + vendor/ (${entryCount} files) + verified .cargo/config.toml present`,
    path: paths.rustVendor,
    entryCount,
  };
}

/**
 * Build instructions for Rust vendor store.
 */
export function rustVendorBuildCommands(): string[] {
  return [
    'cd rust && cargo vendor > .cargo/vendor-config.toml',
    '# Merge vendor-config.toml into .cargo/config.toml',
    'cargo build --release --locked --manifest-path rust/Cargo.toml',
  ];
}

// ── 3. Python Wheelhouse Store ─────────────────────────────────────

/**
 * Validate the Python wheels store.
 * Checks: requirements.lock exists, wheelhouse directory has .whl files.
 */
function normalizeDistributionName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function lockedRequirementNames(requirementsPath: string): string[] {
  if (!fs.existsSync(requirementsPath)) return [];
  return fs.readFileSync(requirementsPath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('-'))
    .map(line => line.split(/[<>=!~;\[]/, 1)[0].trim())
    .filter(Boolean)
    .map(normalizeDistributionName);
}

function wheelDistributionName(fileName: string): string {
  const base = fileName.replace(/\.(whl|tar\.gz)$/i, '');
  return normalizeDistributionName(base.split('-')[0]);
}

export function validatePythonWheelStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);

  // requirements.lock must exist
  if (!fs.existsSync(paths.requirementsLock)) {
    return {
      store: 'python-wheels',
      present: false,
      valid: false,
      detail: `requirements.lock not found at ${paths.requirementsLock}. ` +
        `Create with: pip freeze > requirements.lock`,
      path: paths.requirementsLock,
    };
  }

  // Wheelhouse directory
  const wheelsExist = fs.existsSync(paths.pythonWheels);
  if (wheelsExist) {
    const whlFiles = fs.readdirSync(paths.pythonWheels)
      .filter(f => f.endsWith('.whl') || f.endsWith('.tar.gz'));
    const totalSize = dirTotalSize(paths.pythonWheels);
    const requiredPackages = lockedRequirementNames(paths.requirementsLock);
    const availablePackages = new Set(whlFiles.map(wheelDistributionName));
    const missingPackages = requiredPackages.filter(pkg => !availablePackages.has(pkg));
    const complete = whlFiles.length > 0 && missingPackages.length === 0;

    return {
      store: 'python-wheels',
      present: true,
      valid: complete,
      detail: whlFiles.length === 0
        ? 'Wheelhouse directory exists but contains no .whl files'
        : complete
          ? `${whlFiles.length} wheel files (${(totalSize / 1024 / 1024).toFixed(1)} MB); ` +
            `all ${requiredPackages.length} locked distributions present`
          : `${whlFiles.length} wheel files, missing locked distributions: ${missingPackages.join(', ')}`,
      path: paths.pythonWheels,
      entryCount: whlFiles.length,
      totalSizeBytes: totalSize,
    };
  }

  return {
    store: 'python-wheels',
    present: false,
    valid: false,
    detail: `Wheelhouse not found at ${paths.pythonWheels}. ` +
      `Build with: pip download -r requirements.lock -d offline-stores/python-wheels/`,
    path: paths.pythonWheels,
  };
}

/**
 * Build instructions for Python wheelhouse.
 */
export function pythonWheelBuildCommands(): string[] {
  return [
    'mkdir -p offline-stores/python-wheels',
    'pip download -r requirements.lock -d offline-stores/python-wheels/',
    '# Install offline: pip install --no-index --find-links=offline-stores/python-wheels/ -r requirements.lock',
  ];
}

// ── 4. Tesseract Store ─────────────────────────────────────────────

/**
 * Validate the Tesseract store.
 * Checks: tesseract binary or installer exists in store.
 */
export function validateTesseractStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);

  // A system installation is valid only when the executable responds to the
  // version probe. A directory in the project is not enough: marker JSON,
  // README files, and empty installers must never satisfy readiness.
  if (!fs.existsSync(paths.tesseract)) {
    try {
      const version = execFileSync('tesseract', ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!/tesseract\s+\d+\.\d+/i.test(version)) throw new Error('unparseable version');
      return { store: 'tesseract', present: true, valid: true, detail: 'Tesseract found in system PATH', path: 'PATH' };
    } catch {
      return {
        store: 'tesseract', present: false, valid: false,
        detail: `Tesseract not found in PATH or verified store at ${paths.tesseract}. Build a pinned offline package before deployment.`,
        path: paths.tesseract,
      };
    }
  }

  const manifestPath = path.join(paths.tesseract, 'tesseract-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { store: 'tesseract', present: true, valid: false, detail: 'tesseract-manifest.json is missing', path: paths.tesseract };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const relativeBinary = typeof manifest.relativePath === 'string'
      ? manifest.relativePath
      : typeof manifest.binaryPath === 'string' ? manifest.binaryPath : undefined;
    const version = typeof manifest.version === 'string' ? manifest.version : '';
    const expectedHash = typeof manifest.sha256 === 'string' ? manifest.sha256 : '';
    if (manifest.schemaVersion !== 1 || !relativeBinary || !version || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      throw new Error('manifest requires schemaVersion, version, relativePath, and a 64-character sha256');
    }
    const binaryPath = path.resolve(paths.tesseract, relativeBinary);
    const relative = path.relative(paths.tesseract, binaryPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
      throw new Error('declared executable is missing or escapes the store');
    }
    const actualHash = hashFile(binaryPath);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('declared executable hash mismatch');
    return { store: 'tesseract', present: true, valid: true, detail: `Tesseract ${version} verified from pinned offline binary`, path: binaryPath, entryCount: 1, totalSizeBytes: fs.statSync(binaryPath).size };
  } catch (err: any) {
    return { store: 'tesseract', present: true, valid: false, detail: `Invalid Tesseract store: ${err.message}`, path: paths.tesseract };
  }
}

// ── 5. Sandbox Image Store ─────────────────────────────────────────

interface TarArchiveEntry {
  offset: number;
  size: number;
}

/**
 * Index POSIX tar headers without reading layer payloads into memory. Docker
 * Desktop can emit a legacy Docker-save manifest, an OCI layout, or both.
 */
function indexTarArchive(archivePath: string): Map<string, TarArchiveEntry> {
  const stat = fs.statSync(archivePath);
  const fd = fs.openSync(archivePath, 'r');
  const header = Buffer.alloc(512);
  const entries = new Map<string, TarArchiveEntry>();
  let offset = 0;
  let zeroBlocks = 0;

  try {
    while (offset + 512 <= stat.size) {
      fs.readSync(fd, header, 0, 512, offset);
      let isZero = true;
      for (let i = 0; i < header.length; i++) {
        if (header[i] !== 0) {
          isZero = false;
          break;
        }
      }
      if (isZero) {
        zeroBlocks++;
        if (zeroBlocks >= 2) break;
        offset += 512;
        continue;
      }
      zeroBlocks = 0;

      if (header.subarray(257, 262).toString('ascii') !== 'ustar') {
        throw new Error(`missing POSIX ustar header at offset ${offset}`);
      }
      let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
      if (prefix) name = `${prefix}/${name}`;
      const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeText, 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar entry size '${sizeText}'`);
      const contentOffset = offset + 512;
      if (contentOffset + size > stat.size) throw new Error(`truncated tar entry '${name}'`);
      if (name) entries.set(name, { offset: contentOffset, size });
      offset = contentOffset + Math.ceil(size / 512) * 512;
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries;
}

function readTarMetadata(archivePath: string, entry: TarArchiveEntry): string {
  // Metadata files (manifest/index/config) must be small. Never allocate based
  // on an untrusted tar header without a bound.
  if (entry.size > 16 * 1024 * 1024) throw new Error('metadata entry is unexpectedly large');
  const buffer = Buffer.alloc(entry.size);
  const fd = fs.openSync(archivePath, 'r');
  try { fs.readSync(fd, buffer, 0, entry.size, entry.offset); } finally { fs.closeSync(fd); }
  return buffer.toString('utf8');
}

function validateArchiveMetadata(archivePath: string, entries: Map<string, TarArchiveEntry>): string {
  const legacyManifest = entries.get('manifest.json');
  if (legacyManifest) {
    const parsed = JSON.parse(readTarMetadata(archivePath, legacyManifest));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('manifest.json must contain a non-empty image array');
    return 'Docker save manifest';
  }

  // Docker Desktop's containerd image store may export an OCI image layout.
  // Validate the layout and all descriptors in the index without accepting a
  // hollow archive that merely happens to contain oci-layout text.
  const layoutEntry = entries.get('oci-layout');
  const indexEntry = entries.get('index.json');
  if (!layoutEntry || !indexEntry) throw new Error('archive contains neither Docker manifest.json nor OCI index.json/oci-layout');
  const layout = JSON.parse(readTarMetadata(archivePath, layoutEntry));
  if (layout.imageLayoutVersion !== '1.0.0') throw new Error('unsupported OCI image layout version');
  const index = JSON.parse(readTarMetadata(archivePath, indexEntry));
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length === 0) {
    throw new Error('OCI index.json must contain at least one image descriptor');
  }
  for (const descriptor of index.manifests) {
    const digest = typeof descriptor?.digest === 'string' ? descriptor.digest : '';
    if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('OCI index contains an invalid descriptor digest');
    const blobPath = `blobs/sha256/${digest.slice('sha256:'.length)}`;
    if (!entries.has(blobPath)) throw new Error(`OCI descriptor blob is missing: ${blobPath}`);
  }
  return 'OCI image layout';
}

/**
 * Validate the sandbox container image store.
 * Checks: image tarball or digest available, full tar structure, and either a
 * legacy Docker manifest or a valid OCI image layout. Layer payloads are
 * cryptographically/deeply inspected by SandboxImageService at the F8 gate.
 */
export function validateSandboxImageStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);
  if (!fs.existsSync(paths.sandboxImage)) {
    return { store: 'sandbox-image', present: false, valid: false, detail: `Sandbox image store not found at ${paths.sandboxImage}. Build with: docker save <image> -o offline-stores/sandbox-image/image.tar`, path: paths.sandboxImage };
  }
  const tarFiles = fs.readdirSync(paths.sandboxImage).filter(f => f.endsWith('.tar'));
  if (tarFiles.length === 0) {
    return { store: 'sandbox-image', present: true, valid: false, detail: 'Sandbox image store contains no Docker archive', path: paths.sandboxImage, entryCount: 0 };
  }
  for (const name of tarFiles) {
    const archivePath = path.join(paths.sandboxImage, name);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile() || stat.size < 1024) throw new Error('archive is empty or too small to be a Docker save archive');
      const entries = indexTarArchive(archivePath);
      const format = validateArchiveMetadata(archivePath, entries);
      return {
        store: 'sandbox-image',
        present: true,
        valid: true,
        detail: `Verified ${format} archive: ${name}`,
        path: archivePath,
        entryCount: entries.size,
        totalSizeBytes: stat.size,
      };
    } catch (err: any) {
      if (name === tarFiles[tarFiles.length - 1]) {
        return { store: 'sandbox-image', present: true, valid: false, detail: `Invalid Docker image archive: ${err.message}`, path: archivePath, entryCount: tarFiles.length };
      }
    }
  }
  return { store: 'sandbox-image', present: true, valid: false, detail: 'No valid Docker image archive found', path: paths.sandboxImage, entryCount: tarFiles.length };
}

/**
 * Build instructions for sandbox image store.
 */
export function sandboxImageBuildCommands(imageName: string): string[] {
  return [
    'mkdir -p offline-stores/sandbox-image',
    `docker save ${imageName} -o offline-stores/sandbox-image/image.tar`,
    '# Load offline: docker load -i offline-stores/sandbox-image/image.tar',
  ];
}

// ── 6. Model Snapshot Store ────────────────────────────────────────

export interface ModelSnapshotManifest {
  schemaVersion: number;
  model: string;
  revision: string;
  snapshotRelativePath: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * Validate the model snapshot store.
 * Checks: model-snapshot-manifest.json exists, snapshot directory has all files
 * with correct sizes and hashes.
 */
export function validateModelSnapshotStore(projectRoot: string): StoreStatus {
  const paths = getStorePaths(projectRoot);

  // Model manifest must exist
  if (!fs.existsSync(paths.modelManifest)) {
    return {
      store: 'model-snapshot',
      present: false,
      valid: false,
      detail: `model-snapshot-manifest.json not found at ${paths.modelManifest}`,
      path: paths.modelManifest,
    };
  }

  let manifest: ModelSnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.modelManifest, 'utf-8'));
  } catch (err: any) {
    return {
      store: 'model-snapshot',
      present: true,
      valid: false,
      detail: `Failed to parse model manifest: ${err.message}`,
      path: paths.modelManifest,
    };
  }

  if (manifest.schemaVersion !== 1 || !manifest.model || !manifest.revision || !manifest.snapshotRelativePath || !Array.isArray(manifest.files)) {
    return { store: 'model-snapshot', present: true, valid: false, detail: 'Malformed model snapshot manifest', path: paths.modelManifest };
  }

  // Check snapshot directory and reject manifest paths that escape the store.
  const snapshotRoot = path.resolve(projectRoot, 'offline-stores', 'model-snapshot');
  const snapshotDir = path.resolve(snapshotRoot, manifest.snapshotRelativePath);
  const snapshotRelative = path.relative(snapshotRoot, snapshotDir);
  if (!snapshotRelative || snapshotRelative.startsWith('..') || path.isAbsolute(snapshotRelative)) {
    return { store: 'model-snapshot', present: true, valid: false, detail: 'Model snapshot path escapes offline store', path: snapshotDir };
  }
  if (!fs.existsSync(snapshotDir)) {
    return {
      store: 'model-snapshot',
      present: true,
      valid: false,
      detail: `Model snapshot directory not found: ${snapshotDir}. ` +
        `Model: ${manifest.model} revision: ${manifest.revision}`,
      path: snapshotDir,
      entryCount: 0,
    };
  }

  let canonicalSnapshotDir: string;
  try {
    const canonicalRoot = fs.realpathSync(snapshotRoot);
    canonicalSnapshotDir = fs.realpathSync(snapshotDir);
    const canonicalRelative = path.relative(canonicalRoot, canonicalSnapshotDir);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error('snapshot symlink resolves outside offline store');
    }
  } catch (err: any) {
    return { store: 'model-snapshot', present: true, valid: false, detail: `Invalid model snapshot path: ${err.message}`, path: snapshotDir };
  }

  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  let totalSize = 0;

  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
      sizeMismatch.push(`${String(entry?.path || 'unknown')}: malformed manifest entry`);
      continue;
    }
    const filePath = path.resolve(canonicalSnapshotDir, entry.path);
    const relative = path.relative(canonicalSnapshotDir, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      sizeMismatch.push(`${entry.path}: path escapes snapshot directory`);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      missing.push(entry.path);
      continue;
    }
    let canonicalFile: string;
    try {
      canonicalFile = fs.realpathSync(filePath);
    } catch {
      missing.push(entry.path);
      continue;
    }
    const canonicalRelative = path.relative(canonicalSnapshotDir, canonicalFile);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      sizeMismatch.push(`${entry.path}: symlink escapes snapshot directory`);
      continue;
    }

    const stat = fs.statSync(canonicalFile);
    if (!stat.isFile()) {
      missing.push(entry.path);
      continue;
    }
    if (stat.size !== entry.size) {
      sizeMismatch.push(`${entry.path}: expected ${entry.size}, got ${stat.size}`);
    }
    totalSize += stat.size;
  }

  if (missing.length > 0) {
    return {
      store: 'model-snapshot',
      present: true,
      valid: false,
      detail: `Missing ${missing.length} model files: ${missing.join(', ')}`,
      path: snapshotDir,
      entryCount: manifest.files.length - missing.length,
    };
  }

  if (sizeMismatch.length > 0) {
    return {
      store: 'model-snapshot',
      present: true,
      valid: false,
      detail: `Size mismatch: ${sizeMismatch.join('; ')}`,
      path: snapshotDir,
      entryCount: manifest.files.length,
    };
  }

  const hashVerification = verifyModelSnapshotHashes(projectRoot, { forceRehash: true });
  if (!hashVerification.valid) {
    return {
      store: 'model-snapshot',
      present: true,
      valid: false,
      detail: `Model snapshot SHA-256 verification failed: ${hashVerification.mismatched.join('; ')}`,
      path: snapshotDir,
      entryCount: hashVerification.checked,
      totalSizeBytes: totalSize,
    };
  }

  return {
    store: 'model-snapshot',
    present: true,
    valid: true,
    detail: `${manifest.model} @ ${manifest.revision.substring(0, 12)}… — ` +
      `${manifest.files.length} files (${(totalSize / 1024 / 1024 / 1024).toFixed(1)} GB), hashes verified`,
    path: snapshotDir,
    entryCount: manifest.files.length,
    totalSizeBytes: totalSize,
  };
}

// Memory cache for large model file hashes to avoid re-reading multi-GB weights repeatedly
const modelFileHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

/**
 * Verify model snapshot file hashes.
 * Uses mtime+size caching so multi-GB files are only hashed when modified.
 */
export function verifyModelSnapshotHashes(
  projectRoot: string,
  options: { forceRehash?: boolean } = {},
): { valid: boolean; mismatched: string[]; checked: number } {
  const paths = getStorePaths(projectRoot);

  if (!fs.existsSync(paths.modelManifest)) {
    return { valid: false, mismatched: ['manifest missing'], checked: 0 };
  }

  let manifest: ModelSnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.modelManifest, 'utf-8'));
  } catch (err: any) {
    return { valid: false, mismatched: [`manifest parse failed: ${err.message}`], checked: 0 };
  }

  const snapshotRoot = path.resolve(projectRoot, 'offline-stores', 'model-snapshot');
  const snapshotDir = path.resolve(snapshotRoot, manifest.snapshotRelativePath);
  const snapshotRelative = path.relative(snapshotRoot, snapshotDir);
  if (!snapshotRelative || snapshotRelative.startsWith('..') || path.isAbsolute(snapshotRelative)) {
    return { valid: false, mismatched: ['snapshot path escapes offline store'], checked: 0 };
  }
  let canonicalSnapshot: string;
  try {
    const canonicalRoot = fs.realpathSync(snapshotRoot);
    canonicalSnapshot = fs.realpathSync(snapshotDir);
    const canonicalRelative = path.relative(canonicalRoot, canonicalSnapshot);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      return { valid: false, mismatched: ['snapshot symlink escapes offline store'], checked: 0 };
    }
  } catch (err: any) {
    return { valid: false, mismatched: [`snapshot canonicalization failed: ${err.message}`], checked: 0 };
  }

  const mismatched: string[] = [];
  let checked = 0;

  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
      mismatched.push(`${String(entry?.path || 'unknown')}: malformed manifest entry`);
      continue;
    }
    const filePath = path.resolve(canonicalSnapshot, entry.path);
    const relative = path.relative(canonicalSnapshot, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      mismatched.push(`${entry.path}: path escapes snapshot directory`);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      mismatched.push(`${entry.path}: missing`);
      continue;
    }

    try {
      const canonicalFile = fs.realpathSync(filePath);
      const canonicalRelative = path.relative(canonicalSnapshot, canonicalFile);
      if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
        mismatched.push(`${entry.path}: symlink escapes snapshot directory`);
        continue;
      }
      const stat = fs.statSync(canonicalFile);
      if (!stat.isFile()) {
        mismatched.push(`${entry.path}: not a regular file`);
        continue;
      }
      const cached = modelFileHashCache.get(canonicalFile);
      let actualHash: string;
      if (!options.forceRehash && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        actualHash = cached.hash;
      } else {
        actualHash = hashFile(canonicalFile).toUpperCase();
        modelFileHashCache.set(canonicalFile, { mtimeMs: stat.mtimeMs, size: stat.size, hash: actualHash });
      }

      const expectedHash = entry.sha256.toUpperCase();
      if (actualHash !== expectedHash) {
        mismatched.push(`${entry.path}: expected ${expectedHash.substring(0, 16)}…, got ${actualHash.substring(0, 16)}…`);
      }
      checked++;
    } catch (err: any) {
      mismatched.push(`${entry.path}: read error (${err.message})`);
    }
  }

  return { valid: mismatched.length === 0, mismatched, checked };
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Validate all offline stores. Returns status for each store.
 */
export function validateAllStores(config: OfflineStoreConfig): StoreStatus[] {
  const results: StoreStatus[] = [];

  results.push(validateNpmStore(config.projectRoot));
  results.push(validateRustVendorStore(config.projectRoot));
  results.push(validatePythonWheelStore(config.projectRoot));
  results.push(validateTesseractStore(config.projectRoot));
  results.push(validateSandboxImageStore(config.projectRoot));
  results.push(validateModelSnapshotStore(config.projectRoot));

  return results;
}

/**
 * Check if ALL required stores are present and valid.
 * Returns an actionable summary.
 */
export function checkOfflineReadiness(config: OfflineStoreConfig): {
  ready: boolean;
  stores: StoreStatus[];
  missingStores: StoreName[];
  invalidStores: StoreName[];
  summary: string;
} {
  const stores = validateAllStores(config);
  const missingStores = stores.filter(s => !s.present).map(s => s.store);
  const invalidStores = stores.filter(s => s.present && !s.valid).map(s => s.store);
  const ready = missingStores.length === 0 && invalidStores.length === 0;

  const parts: string[] = [];
  if (ready) {
    parts.push('All offline stores ready');
  } else {
    if (missingStores.length > 0) parts.push(`Missing: ${missingStores.join(', ')}`);
    if (invalidStores.length > 0) parts.push(`Invalid: ${invalidStores.join(', ')}`);
  }

  return { ready, stores, missingStores, invalidStores, summary: parts.join('; ') };
}

/**
 * Generate build instructions for all missing or invalid stores.
 */
export function generateBuildInstructions(config: OfflineStoreConfig): string[] {
  const { missingStores, invalidStores } = checkOfflineReadiness(config);
  const needsBuild = new Set([...missingStores, ...invalidStores]);
  const instructions: string[] = [];

  if (needsBuild.has('npm')) {
    instructions.push('# npm offline store:', ...npmStoreBuildCommands(), '');
  }
  if (needsBuild.has('rust-vendor')) {
    instructions.push('# Rust vendor store:', ...rustVendorBuildCommands(), '');
  }
  if (needsBuild.has('python-wheels')) {
    instructions.push('# Python wheelhouse:', ...pythonWheelBuildCommands(), '');
  }
  if (needsBuild.has('sandbox-image')) {
    const image = config.sandboxImage ?? 'maos-sandbox:latest';
    instructions.push('# Sandbox image:', ...sandboxImageBuildCommands(image), '');
  }

  return instructions;
}
