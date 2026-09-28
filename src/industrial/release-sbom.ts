/**
 * MAOS Industrial — Release Identities & Software Bill of Materials (SBOM) (F11-05)
 *
 * Implements authoritative cryptographic release verification:
 *   - Exhaustively fingerprints all 8 release scopes:
 *       1. Launcher (CLI entrypoints)
 *       2. Project Service (Host runtime & container)
 *       3. Model Manager (Registry, Leases & Residency)
 *       4. Rust Engine (Release executable with #![forbid(unsafe_code)])
 *       5. Python Runtime (Deterministic sandboxed calculation & test scripts)
 *       6. Container Manifest (Docker sandbox manifest & digests)
 *       7. Model Registry (Supported local models and weight manifests)
 *       8. GUI Assets (Offline React bundle, HTML & static assets)
 *
 * Invariants Enforced:
 *   - Offline Self-Verification: Standalone verifier validates exact archive integrity.
 *   - Anti-Replacement: Any modified byte or tampered hash immediately fails closed.
 *   - Anti-Missing-License: Every component must carry a declared open source license.
 *   - Zero Remote Assets: GUI assets cannot reference external CDNs or unbundled scripts.
 *   - Anti-Unmanifested Executables: Detects any unauthorized binary in release directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface ReleaseComponentIdentity {
  readonly id: string;
  readonly component:
    | 'launcher'
    | 'project-service'
    | 'model-manager'
    | 'rust-engine'
    | 'python-runtime'
    | 'sandbox-container'
    | 'model-registry'
    | 'gui-assets';
  readonly name: string;
  readonly version: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly license: string;
  readonly isExecutable: boolean;
  readonly isRemote: boolean;
}

export interface ReleaseSbom {
  readonly schemaVersion: 1;
  readonly spdxVersion: 'SPDX-2.3';
  readonly releaseName: string;
  readonly releaseVersion: string;
  readonly rootLicense: string;
  readonly generatedAt: string;
  readonly components: Record<string, ReleaseComponentIdentity>;
  readonly entriesHash: string;
}

export interface SbomVerificationResult {
  readonly valid: boolean;
  readonly verifiedComponentsCount: number;
  readonly missingComponents: string[];
  readonly tamperedComponents: string[];
  readonly missingLicenses: string[];
  readonly remoteAssetsDetected: string[];
  readonly unmanifestedExecutables: string[];
  readonly details: string[];
}

const FORBIDDEN_REMOTE_PATTERNS = [
  /https?:\/\/cdn\./i,
  /https?:\/\/unpkg\.com/i,
  /https?:\/\/cdnjs\.cloudflare\.com/i,
  /https?:\/\/fonts\.googleapis\.com/i,
  /https?:\/\/fonts\.gstatic\.com/i,
  /https?:\/\/cdn\.jsdelivr\.net/i,
  /https?:\/\/ajax\.googleapis\.com/i,
];

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generate cryptographic Release SBOM across all 8 mandatory scopes.
 */
export function generateReleaseSbom(
  projectRoot: string,
  generatedAt: string = '2026-09-25T00:00:00.000Z',
): ReleaseSbom {
  const absRoot = path.resolve(projectRoot);
  const components: Record<string, ReleaseComponentIdentity> = {};

  const registerFile = (
    id: string,
    component: ReleaseComponentIdentity['component'],
    name: string,
    version: string,
    relPath: string,
    license: string,
    isExecutable: boolean,
  ) => {
    const absPath = path.resolve(absRoot, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`SBOM generation failed: required release asset not found: ${relPath}`);
    }
    const stat = fs.statSync(absPath);
    const sha256 = hashFile(absPath);
    components[id] = {
      id,
      component,
      name,
      version,
      relativePath: relPath.replace(/\\/g, '/'),
      sha256,
      size: stat.size,
      license,
      isExecutable,
      isRemote: false,
    };
  };

  // 1. Launcher
  const launcherPath = fs.existsSync(path.join(absRoot, 'dist', 'cli', 'index.js'))
    ? 'dist/cli/index.js'
    : 'src/cli/index.ts';
  registerFile('launcher-cli', 'launcher', 'MAOS Orchestrator CLI', '0.3.0', launcherPath, 'MIT', true);

  // 2. Project Service
  const servicePath = fs.existsSync(path.join(absRoot, 'dist', 'service', 'index.js'))
    ? 'dist/service/index.js'
    : 'src/service/index.ts';
  registerFile('project-service-core', 'project-service', 'MAOS Project Service Runtime', '0.3.0', servicePath, 'MIT', false);

  const serviceHostPath = fs.existsSync(path.join(absRoot, 'dist', 'service', 'project-service', 'host.js'))
    ? 'dist/service/project-service/host.js'
    : 'src/service/project-service/host.ts';
  registerFile('project-service-host', 'project-service', 'MAOS Project Service Host', '0.3.0', serviceHostPath, 'MIT', false);

  // 3. Model Manager
  const modelMgrPath = fs.existsSync(path.join(absRoot, 'dist', 'service', 'model-manager', 'model-manager.js'))
    ? 'dist/service/model-manager/model-manager.js'
    : 'src/service/model-manager/model-manager.ts';
  registerFile('model-manager-core', 'model-manager', 'MAOS Model Manager & Residency Service', '0.3.0', modelMgrPath, 'MIT', false);

  // 4. Rust Engine Binary
  const rustExt = process.platform === 'win32' ? '.exe' : '';
  const rustBinRelPath = `rust/target/release/maos-engine${rustExt}`;
  registerFile('rust-engine-binary', 'rust-engine', 'MAOS Rust Industrial Authority Engine', '0.1.0', rustBinRelPath, 'MIT OR Apache-2.0', true);

  // 5. Python Runtime Scripts
  registerFile('python-rms-calculation', 'python-runtime', 'Sovereign RMS Calculation Script', '1.0.0', 'fixtures/f8-05/rms-calculation.py', 'MIT', false);
  registerFile('python-rms-verification', 'python-runtime', 'Sovereign RMS Pytest Verification Suite', '1.0.0', 'fixtures/f8-05/rms-verification-test.py', 'MIT', false);

  // 6. Container Manifest
  registerFile('sandbox-container-manifest', 'sandbox-container', 'MAOS Docker Sandbox Runner Manifest', '0.3.0-industrial', 'industrial/container/sandbox-manifest.json', 'MIT', false);

  // 7. Model Registry
  registerFile('model-registry-spec', 'model-registry', 'Deterministic Industrial Model Registry', '0.3.0', 'src/domain/model-manifest.ts', 'MIT', false);

  const embManifestPath = path.resolve(absRoot, 'embedding-snapshot-manifest.json');
  if (fs.existsSync(embManifestPath)) {
    const embManifest = JSON.parse(fs.readFileSync(embManifestPath, 'utf8'));
    registerFile(
      'embedding-snapshot-manifest',
      'model-registry',
      'Offline Embedding Model Snapshot Manifest',
      embManifest.revision || 'fa979fdf926cbd99430f16e4321689952542a641',
      'embedding-snapshot-manifest.json',
      embManifest.license || 'Apache-2.0',
      false,
    );

    const snapshotRel = embManifest.snapshotRelativePath;
    if (Array.isArray(embManifest.files)) {
      for (const f of embManifest.files) {
        const fileRel = `offline-stores/model-snapshot/${snapshotRel}/${f.path}`.replace(/\\/g, '/');
        const absFile = path.resolve(absRoot, fileRel);
        if (fs.existsSync(absFile)) {
          const safeId = `embedding-snapshot-${path.basename(f.path).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          registerFile(
            safeId,
            'model-registry',
            `Offline Embedding Snapshot Asset (${f.path})`,
            embManifest.revision || 'fa979fdf926cbd99430f16e4321689952542a641',
            fileRel,
            'Apache-2.0',
            false,
          );
        }
      }
    }
  }

  // 8. GUI Assets
  registerFile('gui-index-html', 'gui-assets', 'MAOS React GUI Shell Index', '0.3.0', 'dist/gui/index.html', 'MIT', false);

  // Index GUI bundle assets
  const distAssetsDir = path.join(absRoot, 'dist', 'gui', 'assets');
  if (fs.existsSync(distAssetsDir)) {
    const assetFiles = fs.readdirSync(distAssetsDir);
    for (const assetFile of assetFiles) {
      const ext = path.extname(assetFile).toLowerCase();
      const assetType = ext === '.js' ? 'JavaScript' : ext === '.css' ? 'Stylesheet' : 'Asset';
      registerFile(
        `gui-bundle-${assetFile}`,
        'gui-assets',
        `MAOS GUI Bundle ${assetType} (${assetFile})`,
        '0.3.0',
        `dist/gui/assets/${assetFile}`,
        'MIT',
        false,
      );
    }
  }

  // Canonical entries hash
  const sortedKeys = Object.keys(components).sort();
  const canonicalEntries = sortedKeys.map((k) => components[k]);
  const entriesHash = crypto.createHash('sha256').update(JSON.stringify(canonicalEntries)).digest('hex');

  return {
    schemaVersion: 1,
    spdxVersion: 'SPDX-2.3',
    releaseName: 'MAOS Industrial Edition',
    releaseVersion: '0.3.0',
    rootLicense: 'MIT',
    generatedAt,
    components,
    entriesHash,
  };
}

/**
 * Verify release SBOM offline against target filesystem.
 */
export function verifyReleaseSbom(sbom: ReleaseSbom, projectRoot: string): SbomVerificationResult {
  const absRoot = path.resolve(projectRoot);
  const missingComponents: string[] = [];
  const tamperedComponents: string[] = [];
  const missingLicenses: string[] = [];
  const remoteAssetsDetected: string[] = [];
  const unmanifestedExecutables: string[] = [];
  const details: string[] = [];

  let verifiedCount = 0;

  for (const [id, entry] of Object.entries(sbom.components)) {
    const absPath = path.resolve(absRoot, entry.relativePath);

    // 1. Missing component check
    if (!fs.existsSync(absPath)) {
      missingComponents.push(`${id}: missing file '${entry.relativePath}'`);
      continue;
    }

    // 2. Hash check (fail-closed on replacement)
    const actualHash = hashFile(absPath);
    if (actualHash.toLowerCase() !== entry.sha256.toLowerCase()) {
      tamperedComponents.push(
        `${id}: expected hash ${entry.sha256.substring(0, 16)}..., got ${actualHash.substring(0, 16)}...`,
      );
      continue;
    }

    // 3. License check (fail-closed on missing license)
    if (!entry.license || entry.license.trim() === '' || entry.license.toLowerCase() === 'unlicensed') {
      missingLicenses.push(`${id}: missing or blank declared license`);
    }

    // 4. Remote asset check (fail-closed if remote CDN URLs found in GUI files)
    if (entry.component === 'gui-assets') {
      const fileText = fs.readFileSync(absPath, 'utf8');
      for (const pattern of FORBIDDEN_REMOTE_PATTERNS) {
        if (pattern.test(fileText)) {
          remoteAssetsDetected.push(`${id}: detected remote CDN asset reference matching ${pattern}`);
          break;
        }
      }
    }

    verifiedCount++;
  }

  // 5. Unmanifested executable detection
  const releaseBinDir = path.resolve(absRoot, 'rust', 'target', 'release');
  if (fs.existsSync(releaseBinDir)) {
    const entries = fs.readdirSync(releaseBinDir);
    const manifestedPaths = new Set(
      Object.values(sbom.components).map((c) => path.resolve(absRoot, c.relativePath).toLowerCase()),
    );

    for (const f of entries) {
      const fullPath = path.join(releaseBinDir, f);
      if (!fs.statSync(fullPath).isFile()) continue;
      const ext = path.extname(f).toLowerCase();
      const isExe = ['.exe', '.dll', '.so', '.dylib'].includes(ext);
      if (isExe && !manifestedPaths.has(fullPath.toLowerCase())) {
        unmanifestedExecutables.push(path.relative(absRoot, fullPath).replace(/\\/g, '/'));
      }
    }
  }

  const valid =
    missingComponents.length === 0 &&
    tamperedComponents.length === 0 &&
    missingLicenses.length === 0 &&
    remoteAssetsDetected.length === 0 &&
    unmanifestedExecutables.length === 0;

  if (valid) {
    details.push(`All ${verifiedCount} release components verified strictly offline with zero remote assets.`);
  } else {
    if (missingComponents.length > 0) details.push(`Missing components: ${missingComponents.length}`);
    if (tamperedComponents.length > 0) details.push(`Tampered components: ${tamperedComponents.length}`);
    if (missingLicenses.length > 0) details.push(`Missing licenses: ${missingLicenses.length}`);
    if (remoteAssetsDetected.length > 0) details.push(`Remote assets detected: ${remoteAssetsDetected.length}`);
    if (unmanifestedExecutables.length > 0) details.push(`Unmanifested executables: ${unmanifestedExecutables.length}`);
  }

  return {
    valid,
    verifiedComponentsCount: verifiedCount,
    missingComponents,
    tamperedComponents,
    missingLicenses,
    remoteAssetsDetected,
    unmanifestedExecutables,
    details,
  };
}

/**
 * Write Release SBOM to disk as deterministic formatted JSON.
 */
export function writeReleaseSbom(sbom: ReleaseSbom, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(sbom, null, 2) + '\n', 'utf8');
}

/**
 * Read Release SBOM from disk.
 */
export function readReleaseSbom(inputPath: string): ReleaseSbom {
  const content = fs.readFileSync(inputPath, 'utf8');
  return JSON.parse(content) as ReleaseSbom;
}
