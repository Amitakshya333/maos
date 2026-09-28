/**
 * MAOS Industrial Bundle & Rehearsal Workflow CLI Commands
 *
 * Implements the two-stage offline bundle pipeline:
 *   Stage 1: Connected build machine
 *     - `industrial bundle prepare`
 *     - `industrial bundle verify`
 *   Stage 2: Clean disconnected VM
 *     - `industrial rehearsal`
 *     - `industrial evidence verify`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';
import {
  generateBundleManifest,
  verifyBundleManifest,
  FullBundleManifest,
  VerificationResult,
  hashFile,
  hashString,
} from './bundle-manifest';
import {
  validateAllStores,
  checkOfflineReadiness,
  getStorePaths,
  verifyModelSnapshotHashes,
  StoreStatus,
  ModelSnapshotManifest,
} from './offline-stores';
import { buildPackageManifest, PackageResult } from './package-assets';
import {
  runLifecycleCommand,
  LifecycleResult,
  LIFECYCLE_EXIT,
  readState,
} from './lifecycle';
import {
  INDUSTRIAL_PROFILE,
  RehearsalProfile,
  runRehearsal,
  verifyNetworkIsolation,
  RehearsalResult,
} from './vm-rehearsal';
import {
  getDefaultEnginePath,
  verifyExecutable,
  engineHealth,
  engineEvaluate,
} from './rust-engine-bridge';
import {
  spawnService,
  stopService,
  isProcessAlive,
  rejectDebugBinary,
  createRustEngineConfig,
  createModelServerConfig,
  ServiceConfig,
} from './service-startup';

// ── Types ──────────────────────────────────────────────────────────

export interface BundlePrepareOptions {
  projectRoot: string;
  outputDir?: string;
  skipTests?: boolean;
  modelCacheDir?: string;
}

export interface BundlePrepareResult {
  success: boolean;
  manifest: FullBundleManifest;
  storesStatus: StoreStatus[];
  archivePath?: string;
  archiveHash?: string;
  failures: string[];
  durationMs: number;
}

export interface BundleVerifyOptions {
  projectRoot: string;
  manifestPath?: string;
  checkUnlisted?: boolean;
}

export interface BundleVerifyResult {
  valid: boolean;
  missingFiles: string[];
  tamperedFiles: string[];
  debugBinaries: string[];
  missingStores: string[];
  unlistedExecutables: string[];
  manifestCheck: boolean;
  failures: string[];
  details: Record<string, unknown>;
}

export interface RehearsalOptions {
  projectRoot: string;
  allowNetwork?: boolean;
  reportPath?: string;
  profile?: RehearsalProfile;
  modelPort?: number;
  /** Test-only dependency injection; production always builds the pinned service. */
  textModelConfigOverride?: ServiceConfig;
  /** Test-only replacement for the real HTTP smoke probe. */
  textModelSmokeOverride?: (config: ServiceConfig) => Promise<TextModelSmokeResult>;
}

export interface TextModelSmokeResult {
  passed: boolean;
  protocol: 'openai-compatible-http';
  endpoint: string;
  modelId?: string;
  revision?: string;
  health?: { status: number; model?: string; revision?: string; latencyMs: number };
  models?: { status: number; modelId?: string; latencyMs: number };
  completion?: {
    status: number;
    latencyMs: number;
    responseHash: string;
    contentExact: boolean;
  };
  detail: string;
}

export interface RehearsalWorkflowResult {
  passed: boolean;
  machineIdentity: Record<string, string>;
  networkIsolated: boolean;
  emptyDeveloperCaches: boolean;
  bundleVerified: boolean;
  storesVerified: boolean;
  servicesStarted: boolean;
  healthPassed: boolean;
  smokePassed: boolean;
  lifecyclePassed: boolean;
  idempotencyPassed: boolean;
  negativeTestsPassed: boolean;
  zeroOrphans: boolean;
  failures: string[];
  rawOutputs: Record<string, unknown>;
  reportPath: string;
  timestamp: string;
}

export interface EvidenceVerificationResult {
  valid: boolean;
  g2Ready: boolean;
  blockers: string[];
  verifiedItems: string[];
  summary: string;
}

const LOCAL_MODEL_NAME = 'qwen2.5-3b-instruct-local';
const TEXT_MODEL_SCRIPT = 'scripts/huggingface-openai-server.py';

function resolvePythonLauncher(): string | undefined {
  const configured = process.env.MAOS_PYTHON || process.env.PYTHON;
  if (configured && fs.existsSync(configured)) return path.resolve(configured);

  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const output = execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split(/\r?\n/)[0];
      if (output && fs.existsSync(output)) return path.resolve(output);
    } catch {
      // Try the next interpreter name.
    }
  }
  return undefined;
}

interface LocalJsonResponse {
  status: number;
  body: any;
  latencyMs: number;
}

async function requestLocalJson(
  url: string,
  method: 'GET' | 'POST',
  payload?: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<LocalJsonResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { status: response.status, body, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exercise the real local OpenAI-compatible model server. File hashes are not
 * accepted as a substitute for this probe: the server must answer health,
 * model identity, and a deterministic chat completion over loopback HTTP.
 */
export async function runLocalModelSmoke(config: ServiceConfig): Promise<TextModelSmokeResult> {
  const endpoint = `http://${config.host}:${config.port}`;
  const expectedModel = config.model?.modelName || LOCAL_MODEL_NAME;
  const expectedRevision = config.model?.modelRevision;
  let health: LocalJsonResponse | undefined;
  let models: LocalJsonResponse | undefined;

  try {
    // Model loading can take a few minutes on a clean machine. Poll health,
    // but never treat a dead process or a non-200 response as success.
    let lastError = 'model server did not become healthy';
    for (let attempt = 0; attempt < 180; attempt++) {
      try {
        const candidate = await requestLocalJson(`${endpoint}/health`, 'GET', undefined, 5_000);
        if (candidate.status === 200) {
          health = candidate;
          break;
        }
        lastError = `health returned HTTP ${candidate.status}`;
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
      await wait(1_000);
    }
    if (!health) {
      return {
        passed: false,
        protocol: 'openai-compatible-http',
        endpoint,
        detail: `Local model health failed: ${lastError}`,
      };
    }

    const healthModel = health.body?.model;
    const healthRevision = health.body?.revision;
    if (health.body?.status !== 'ok' || healthModel !== expectedModel ||
        (expectedRevision && healthRevision !== expectedRevision)) {
      return {
        passed: false,
        protocol: 'openai-compatible-http',
        endpoint,
        modelId: healthModel,
        revision: healthRevision,
        health: {
          status: health.status,
          model: healthModel,
          revision: healthRevision,
          latencyMs: health.latencyMs,
        },
        detail: `Local model health identity mismatch: expected ${expectedModel} @ ${expectedRevision || 'unspecified'}, ` +
          `got ${healthModel || 'unknown'} @ ${healthRevision || 'unknown'}`,
      };
    }

    models = await requestLocalJson(`${endpoint}/v1/models`, 'GET', undefined, 10_000);
    const listedModel = Array.isArray(models.body?.data)
      ? models.body.data.find((item: any) => item?.id === expectedModel)
      : undefined;
    if (models.status !== 200 || !listedModel) {
      return {
        passed: false,
        protocol: 'openai-compatible-http',
        endpoint,
        modelId: expectedModel,
        revision: expectedRevision,
        health: {
          status: health.status,
          model: healthModel,
          revision: healthRevision,
          latencyMs: health.latencyMs,
        },
        models: { status: models.status, modelId: listedModel?.id, latencyMs: models.latencyMs },
        detail: `Local model registry mismatch: expected ${expectedModel}, HTTP ${models.status}`,
      };
    }

    const completion = await requestLocalJson(`${endpoint}/v1/chat/completions`, 'POST', {
      model: expectedModel,
      messages: [{ role: 'user', content: 'Reply with exactly: LOCAL_OK' }],
      temperature: 0,
      top_p: 1,
      max_tokens: 32,
      stream: false,
    }, 120_000);
    const content = completion.body?.choices?.[0]?.message?.content;
    const contentExact = typeof content === 'string' && content.trim() === 'LOCAL_OK';
    const responseHash = crypto.createHash('sha256')
      .update(JSON.stringify(completion.body))
      .digest('hex');
    const passed = completion.status === 200 && contentExact;

    return {
      passed,
      protocol: 'openai-compatible-http',
      endpoint,
      modelId: expectedModel,
      revision: expectedRevision,
      health: {
        status: health.status,
        model: healthModel,
        revision: healthRevision,
        latencyMs: health.latencyMs,
      },
      models: { status: models.status, modelId: listedModel.id, latencyMs: models.latencyMs },
      completion: {
        status: completion.status,
        latencyMs: completion.latencyMs,
        responseHash,
        contentExact,
      },
      detail: passed
        ? `HTTP completion passed for ${expectedModel} @ ${expectedRevision || 'unknown'} (${completion.latencyMs} ms)`
        : `HTTP completion failed: expected exact LOCAL_OK, HTTP ${completion.status}`,
    };
  } catch (err: any) {
    return {
      passed: false,
      protocol: 'openai-compatible-http',
      endpoint,
      modelId: expectedModel,
      revision: expectedRevision,
      detail: `Local model HTTP smoke failed: ${err?.message || String(err)}`,
    };
  }
}

// ── Stage 1: Bundle Preparation ─────────────────────────────────────

/**
 * Materialize offline stores from local caches and environment.
 */
export function materializeOfflineStores(projectRoot: string, modelCacheDir?: string): string[] {
  const root = path.resolve(projectRoot);
  const paths = getStorePaths(root);
  const logs: string[] = [];

  // 1. npm store: ensure directory and pack tarball
  if (!fs.existsSync(paths.npmCache)) {
    fs.mkdirSync(paths.npmCache, { recursive: true });
  }
  const npmTarball = path.join(paths.npmCache, 'maosorch.tgz');
  const pkgJson = path.join(root, 'package.json');
  if (!fs.existsSync(npmTarball) && fs.existsSync(pkgJson)) {
    try {
      execFileSync('npm', ['pack', '--pack-destination', paths.npmCache], {
        cwd: root,
        stdio: 'pipe',
      });
      // Rename any generated maosorch-*.tgz to maosorch.tgz if needed
      const files = fs.readdirSync(paths.npmCache).filter(f => f.startsWith('maosorch') && f.endsWith('.tgz'));
      if (files.length > 0 && !fs.existsSync(npmTarball)) {
        fs.copyFileSync(path.join(paths.npmCache, files[0]), npmTarball);
      }
      logs.push(`[npm] Materialized package tarball in ${paths.npmCache}`);
    } catch (err: any) {
      logs.push(`[npm] Note: npm pack returned: ${err.message}`);
    }
  } else if (!fs.existsSync(npmTarball)) {
    logs.push(`[npm] Package tarball is unavailable; no placeholder was created`);
  }

  // 2. Rust vendor store: run cargo vendor if vendor directory is empty and Cargo.toml exists
  const vendorDir = path.join(root, 'rust', 'vendor');
  const cargoToml = path.join(root, 'rust', 'Cargo.toml');
  if (fs.existsSync(cargoToml) && (!fs.existsSync(vendorDir) || fs.readdirSync(vendorDir).length === 0)) {
    fs.mkdirSync(vendorDir, { recursive: true });
    try {
      execSync('cargo vendor rust/vendor --manifest-path rust/Cargo.toml', {
        cwd: root,
        stdio: 'pipe',
      });
      logs.push('[rust-vendor] Materialized cargo vendor in rust/vendor');
    } catch (err: any) {
      logs.push(`[rust-vendor] Note: cargo vendor returned: ${err.message}`);
    }
  } else if (!fs.existsSync(vendorDir)) {
    logs.push('[rust-vendor] Cargo vendor store is unavailable; no placeholder was created');
  }

  // 3. Python wheelhouse — download ALL packages from requirements.lock
  if (!fs.existsSync(paths.pythonWheels)) {
    fs.mkdirSync(paths.pythonWheels, { recursive: true });
  }
  const wheelMarker = path.join(paths.pythonWheels, '.wheelhouse-manifest.json');
  const reqLockPath = path.join(root, 'requirements.lock');
  const existingWheels = fs.readdirSync(paths.pythonWheels).filter(f => f.endsWith('.whl') || f.endsWith('.tar.gz'));

  // Parse requirements.lock to get expected package count
  let expectedPkgCount = 0;
  if (fs.existsSync(reqLockPath)) {
    const reqLines = fs.readFileSync(reqLockPath, 'utf-8').split('\n')
      .filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    expectedPkgCount = reqLines.length;
  }

  if (existingWheels.length < expectedPkgCount && fs.existsSync(reqLockPath)) {
    try {
      // Download all packages from requirements.lock using PyTorch CUDA index for torch
      execFileSync(
        'pip',
        [
          'download',
          '-r', reqLockPath,
          '--extra-index-url', 'https://download.pytorch.org/whl/cu128',
          '-d', paths.pythonWheels,
        ],
        { stdio: 'pipe', timeout: 600000 }, // 10 min timeout for large downloads
      );
      const newWheels = fs.readdirSync(paths.pythonWheels).filter(f => f.endsWith('.whl') || f.endsWith('.tar.gz'));
      logs.push(`[python-wheels] Downloaded ${newWheels.length} wheel(s) from requirements.lock (expected ${expectedPkgCount})`);
    } catch (err: any) {
      // Bulk download failed — try individual packages as fallback
      logs.push(`[python-wheels] Bulk pip download failed: ${err.message?.slice(0, 200)}`);
      try {
        const reqLines = fs.readFileSync(reqLockPath, 'utf-8').split('\n')
          .filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
        let downloaded = 0;
        for (const pkg of reqLines) {
          const pkgName = pkg.split('==')[0];
          // Check if this package wheel already exists
          const alreadyHave = existingWheels.some(w => w.toLowerCase().startsWith(pkgName.toLowerCase().replace(/-/g, '_')));
          if (alreadyHave) continue;
          try {
            if (pkg.startsWith('-')) {
              logs.push(`[python-wheels] Refused option-like requirement line: ${pkg.slice(0, 120)}`);
              continue;
            }
            const pipArgs = ['download', '--no-deps'];
            if (pkg.includes('+cu')) {
              pipArgs.push('--extra-index-url', 'https://download.pytorch.org/whl/cu128');
            }
            pipArgs.push(pkg, '-d', paths.pythonWheels);
            execFileSync('pip', pipArgs, { stdio: 'pipe', timeout: 300000 });
            downloaded++;
          } catch {
            logs.push(`[python-wheels] Failed to download: ${pkg}`);
          }
        }
        logs.push(`[python-wheels] Individual fallback downloaded ${downloaded} additional packages`);
      } catch {
        logs.push('[python-wheels] Individual fallback also failed');
      }
    }
  } else if (existingWheels.length >= expectedPkgCount) {
    logs.push(`[python-wheels] Verified ${existingWheels.length} wheel(s) in python-wheels directory (expected ${expectedPkgCount})`);
  } else {
    logs.push(`[python-wheels] No requirements.lock found — skipping wheelhouse materialization`);
  }

  // Update wheelhouse manifest
  const finalWheels = fs.readdirSync(paths.pythonWheels).filter(f => f.endsWith('.whl') || f.endsWith('.tar.gz'));
  fs.writeFileSync(
    wheelMarker,
    JSON.stringify({
      schemaVersion: 1,
      created: new Date().toISOString(),
      packages: finalWheels,
      expectedCount: expectedPkgCount,
      actualCount: finalWheels.length,
      complete: finalWheels.length >= expectedPkgCount,
    }, null, 2),
  );

  // 4. Tesseract and sandbox stores are never synthesized. A marker JSON or
  // tiny placeholder is not a runtime engine/image and must not make a bundle
  // appear deployable. Their absence is reported by validation below.
  if (!fs.existsSync(paths.tesseract)) {
    fs.mkdirSync(paths.tesseract, { recursive: true });
    logs.push('[tesseract] Created empty store directory; pinned executable is still required');
  }
  if (!fs.existsSync(paths.sandboxImage)) {
    fs.mkdirSync(paths.sandboxImage, { recursive: true });
    logs.push('[sandbox-image] Created empty store directory; Docker save archive is still required');
  }

  // 6. Text model snapshot: copy from local HuggingFace cache if available
  if (fs.existsSync(paths.modelManifest)) {
    const manifest: ModelSnapshotManifest = JSON.parse(fs.readFileSync(paths.modelManifest, 'utf-8'));
    const targetDir = path.resolve(paths.modelSnapshot, manifest.snapshotRelativePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const defaultHFCache = path.join(
      os.homedir(),
      '.cache',
      'huggingface',
      'hub',
      'models--Qwen--Qwen2.5-3B-Instruct',
      'snapshots',
      manifest.revision,
    );
    const sourceDir = modelCacheDir || defaultHFCache;

    if (fs.existsSync(sourceDir)) {
      for (const f of manifest.files) {
        const srcFile = path.join(sourceDir, f.path);
        const destFile = path.join(targetDir, f.path);
        if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
          try {
            // Attempt hardlink first to save space, fall back to copy
            fs.linkSync(srcFile, destFile);
          } catch {
            fs.copyFileSync(srcFile, destFile);
          }
        }
      }
      logs.push(`[model-snapshot] Materialized Qwen2.5-3B model snapshot into ${targetDir}`);
    } else {
      logs.push(`[model-snapshot] Source HF cache not found at ${sourceDir}`);
    }
  }

  return logs;
}

/**
 * Execute bundle preparation (Stage 1).
 */
export async function bundlePrepare(options: BundlePrepareOptions): Promise<BundlePrepareResult> {
  const start = Date.now();
  const root = path.resolve(options.projectRoot);
  const failures: string[] = [];

  // 1. Build Rust release binary
  try {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', 'rust/Cargo.toml'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    failures.push(`Rust release build failed: ${err.message}`);
  }

  // Check Rust release binary exists
  const rustEnginePath = getDefaultEnginePath(root);
  if (!fs.existsSync(rustEnginePath)) {
    failures.push(`Expected Rust release binary not found at ${rustEnginePath}`);
  }

  // 2. Run locked Rust checks and tests unless skipped
  if (!options.skipTests) {
    try {
      execFileSync('cargo', ['fmt', '--manifest-path', 'rust/Cargo.toml', '--all', '--', '--check'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      execFileSync(
        'cargo',
        [
          'clippy',
          '--manifest-path',
          'rust/Cargo.toml',
          '--workspace',
          '--all-targets',
          '--all-features',
          '--locked',
          '--',
          '-D',
          'warnings',
        ],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      execFileSync(
        'cargo',
        ['test', '--manifest-path', 'rust/Cargo.toml', '--workspace', '--all-targets', '--all-features', '--locked'],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err: any) {
      failures.push(`Rust verification checks failed: ${err.message}`);
    }

  }

  // The release bundle must always contain a freshly compiled TypeScript and
  // GUI build. --skip-tests only disables test execution; it must never allow
  // stale or missing runtime output into an archive.
  try {
    execSync('npm run build', { cwd: root, stdio: 'pipe' });
  } catch (err: any) {
    failures.push(`TypeScript build failed: ${err.message}`);
  }

  if (!options.skipTests) {
    try {
      execSync('npm test', { cwd: root, stdio: 'pipe' });
    } catch (err: any) {
      failures.push(`TypeScript tests failed: ${err.message}`);
    }
  }

  // 3. Materialize all six offline stores
  materializeOfflineStores(root, options.modelCacheDir);

  // Validate stores
  const storesStatus = validateAllStores({ projectRoot: root });
  for (const s of storesStatus) {
    if (!s.present || !s.valid) {
      failures.push(`Store ${s.store} validation failed: ${s.detail}`);
    }
  }

  // 4. Generate bundle manifest
  // A preliminary manifest is used only to carry build/protocol identity into
  // the package-derived manifest below. The authoritative release manifest is
  // rebuilt from the exact allowlisted entries staged into the archive.
  let manifest = generateBundleManifest({
    projectRoot: root,
    includeDist: true,
    forceRehash: true,
  });

  const manifestPath = path.join(root, 'bundle-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // 5. Create immutable release archive in output directory
  const outputDir = path.resolve(options.outputDir || path.join(root, 'dist', 'release'));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const archivePath = path.join(
    outputDir,
    process.platform === 'win32' ? 'maos-industrial-bundle.zip' : 'maos-industrial-bundle.tar.gz',
  );
  const bundleContentsDir = path.join(outputDir, 'bundle-contents');
  let archiveHash: string | undefined;
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  if (fs.existsSync(bundleContentsDir)) fs.rmSync(bundleContentsDir, { recursive: true, force: true });

  // Package assets using the allowlist. A release archive is created only when
  // all prerequisite stores and verification steps are valid.
  try {
    const pkgResult: PackageResult = buildPackageManifest({
      projectRoot: root,
      includeDist: true,
      includeDemo: true,
      forceRehash: true,
    });
    if (!pkgResult.success) failures.push(...pkgResult.errors);

    // The manifest itself is excluded from the package-derived entry set to
    // avoid a circular self-hash. It is copied into the archive separately.
    const packageEntries = pkgResult.entries.filter((entry) => entry.relativePath !== 'bundle-manifest.json');
    const packageManifestEntries: FullBundleManifest['entries'] = packageEntries.map((entry) => {
      const normalized = entry.relativePath.replace(/\\/g, '/');
      let category: FullBundleManifest['entries'][number]['category'] = 'asset';
      if (normalized.startsWith('rust/target/release/')) category = 'rust-binary';
      else if (normalized.startsWith('dist/')) category = 'ts-dist';
      else if (normalized.startsWith('src/')) category = normalized.endsWith('.py') ? 'python' : 'asset';
      else if (normalized.startsWith('scripts/')) category = normalized.endsWith('.py') ? 'python' : 'script';
      else if (normalized.startsWith('templates/')) category = 'template';
      else if (normalized.startsWith('offline-stores/model-snapshot/')) category = 'model-snapshot';
      else if (normalized.endsWith('.py') || normalized === 'requirements.lock') category = 'python';
      else if (normalized.startsWith('profiles/') || normalized.startsWith('rust/')) category = 'config';
      return { path: normalized, size: entry.size, sha256: entry.sha256, category };
    });
    const packageEntriesHash = hashString(JSON.stringify(packageManifestEntries));
    manifest = {
      version: '1.0',
      protocolVersion: manifest.protocolVersion,
      engineVersion: manifest.engineVersion,
      modelManifestHash: manifest.modelManifestHash,
      entries: packageManifestEntries,
      buildIdentity: {
        ...manifest.buildIdentity,
        generatedAt: new Date().toISOString(),
        entriesHash: packageEntriesHash,
      },
      totalEntries: packageManifestEntries.length,
      totalSize: packageManifestEntries.reduce((sum, entry) => sum + entry.size, 0),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const requiredEntries = [
      path.relative(root, rustEnginePath).replace(/\\/g, '/'),
      'dist/industrial/python/pdf_rasterizer.py',
      'dist/industrial/python/ocr_engine.py',
      'dist/industrial/python/vlm_engine.py',
    ];
    for (const required of requiredEntries) {
      if (!pkgResult.entries.some((entry) => entry.relativePath === required)) {
        failures.push(`Required release asset is absent from package allowlist output: ${required}`);
      }
    }

    if (failures.length === 0) {
      fs.mkdirSync(bundleContentsDir, { recursive: true });
      for (const entry of packageEntries) {
        const dest = path.resolve(bundleContentsDir, entry.relativePath);
        const relativeDest = path.relative(bundleContentsDir, dest);
        if (!relativeDest || relativeDest.startsWith('..') || path.isAbsolute(relativeDest)) {
          throw new Error(`Package entry escapes staging directory: ${entry.relativePath}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.sourcePath, dest);
        const copied = fs.statSync(dest);
        if (copied.size !== entry.size || hashFile(dest, true) !== entry.sha256) {
          throw new Error(`Staged package entry failed size/hash verification: ${entry.relativePath}`);
        }
      }

      const stagedManifestPath = path.join(bundleContentsDir, 'bundle-manifest.json');
      fs.copyFileSync(manifestPath, stagedManifestPath);
      const stagedManifestStat = fs.statSync(stagedManifestPath);
      if (stagedManifestStat.size !== fs.statSync(manifestPath).size ||
          hashFile(stagedManifestPath, true) !== hashFile(manifestPath, true)) {
        throw new Error('Staged bundle manifest failed size/hash verification');
      }

      const infoPath = path.join(bundleContentsDir, 'bundle-info.json');
      fs.writeFileSync(infoPath, JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        totalEntries: packageEntries.length,
        totalSize: packageEntries.reduce((sum, entry) => sum + entry.size, 0),
        entriesHash: packageEntriesHash,
        rustBinarySha256: packageEntries.find((entry) => entry.relativePath === requiredEntries[0])?.sha256,
      }, null, 2));

      const archiveArgs = process.platform === 'win32'
        ? ['-a', '-c', '-f', archivePath, '.']
        : ['-c', '-z', '-f', archivePath, '.'];
      execFileSync('tar', archiveArgs, { cwd: bundleContentsDir, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
        throw new Error('Archive command did not produce a non-empty release archive');
      }

      const listing = execFileSync('tar', ['-t', '-f', archivePath], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const archivedPaths = new Set(listing.split(/\r?\n/)
        .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
        .filter(Boolean));
      const missingArchiveEntries = [...packageEntries.map((entry) => entry.relativePath), 'bundle-manifest.json']
        .filter((entry) => !archivedPaths.has(entry));
      if (missingArchiveEntries.length > 0) {
        throw new Error(`Archive omitted ${missingArchiveEntries.length} package entries: ${missingArchiveEntries.slice(0, 5).join(', ')}`);
      }
      archiveHash = hashFile(archivePath, true);
    }
  } catch (err: any) {
    failures.push(`Archive packaging failed: ${err.message}`);
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  }

  return {
    success: failures.length === 0,
    manifest,
    storesStatus,
    archivePath: fs.existsSync(archivePath) ? archivePath : undefined,
    archiveHash,
    failures,
    durationMs: Date.now() - start,
  };
}

// ── Stage 1: Bundle Verification ───────────────────────────────────

/**
 * Verify bundle integrity and completeness.
 * Fails on missing files, debug binaries, store misses, unlisted executables, manifest mismatches.
 */
export function bundleVerify(options: BundleVerifyOptions): BundleVerifyResult {
  const root = path.resolve(options.projectRoot);
  const manifestPath = path.resolve(options.manifestPath || path.join(root, 'bundle-manifest.json'));
  const failures: string[] = [];
  const debugBinaries: string[] = [];
  const missingStores: string[] = [];
  const unlistedExecutables: string[] = [];

  // 1. Check bundle manifest existence
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      missingFiles: ['bundle-manifest.json'],
      tamperedFiles: [],
      debugBinaries: [],
      missingStores: ['all'],
      unlistedExecutables: [],
      manifestCheck: false,
      failures: [`Bundle manifest not found at ${manifestPath}`],
      details: {},
    };
  }

  let manifest: FullBundleManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err: any) {
    return {
      valid: false,
      missingFiles: [],
      tamperedFiles: [],
      debugBinaries: [],
      missingStores: [],
      unlistedExecutables: [],
      manifestCheck: false,
      failures: [`Bundle manifest is invalid JSON: ${err.message}`],
      details: {},
    };
  }

  // 2. Verify manifest against filesystem
  const verifyResult: VerificationResult = verifyBundleManifest(manifest, root, options.checkUnlisted);

  // Fail explicitly if manifest verification found mismatches
  if (!verifyResult.valid) {
    const detail = typeof verifyResult.details === 'string' ? verifyResult.details : JSON.stringify(verifyResult.details);
    failures.push(`Bundle manifest verification failed: ${detail}`);
    for (const error of verifyResult.manifestErrors) {
      failures.push(`Bundle manifest schema error: ${error}`);
    }
  }

  // 3. Verify Rust release binary and reject debug binary
  const enginePath = getDefaultEnginePath(root);
  if (!fs.existsSync(enginePath)) {
    failures.push(`Rust release binary missing at ${enginePath}`);
  } else {
    // Reject debug binaries
    try {
      rejectDebugBinary(enginePath, 'rust-engine');
    } catch (err: any) {
      debugBinaries.push(enginePath);
      failures.push(`Debug binary detected (rejected): ${err.message}`);
    }
  }

  // Check for any debug binaries in rust/target/debug
  const debugDir = path.join(root, 'rust', 'target', 'debug');
  if (fs.existsSync(debugDir)) {
    const debugExes = fs.readdirSync(debugDir).filter(f => f.endsWith('.exe') && f.startsWith('maos'));
    if (debugExes.length > 0) {
      for (const d of debugExes) {
        debugBinaries.push(path.join(debugDir, d));
      }
      failures.push(`Debug binaries found in bundle (${debugExes.length}): ${debugExes.join(', ')}. ` +
        `Remove rust/target/debug/ before bundling.`);
    }
  }

  // 4. Validate all six offline stores
  const storeReadiness = checkOfflineReadiness({ projectRoot: root });
  if (!storeReadiness.ready) {
    for (const m of storeReadiness.missingStores) {
      missingStores.push(m);
      const status = storeReadiness.stores.find((store) => store.store === m);
      failures.push(`Missing required offline store: ${m}${status?.detail ? ` — ${status.detail}` : ''}`);
    }
    for (const inv of storeReadiness.invalidStores) {
      missingStores.push(inv);
      const status = storeReadiness.stores.find((store) => store.store === inv);
      failures.push(`Invalid offline store: ${inv}${status?.detail ? ` — ${status.detail}` : ''}`);
    }
  }

  // Specific store checks:
  const storePaths = getStorePaths(root);

  // Model snapshot: require both the pinned manifest and a multi-GB payload
  // represented in the bundle manifest. A manifest-only release is not offline.
  if (!fs.existsSync(storePaths.modelManifest)) {
    failures.push('Missing model snapshot manifest (model-snapshot-manifest.json)');
  } else {
    const manifestEntries = Array.isArray((manifest as any)?.entries) ? manifest.entries : [];
    const modelEntries = manifestEntries.filter(entry =>
      entry.path.startsWith('offline-stores/model-snapshot/') &&
      !entry.path.endsWith('/'),
    );
    const modelPayloadBytes = modelEntries.reduce((sum, entry) => sum + entry.size, 0);
    if (modelEntries.length === 0 || modelPayloadBytes < 1_000_000_000) {
      failures.push(
        `Model payload missing or undersized in bundle manifest: ${modelEntries.length} files, ` +
        `${modelPayloadBytes} bytes; expected the pinned multi-GB snapshot`,
      );
    }
  }

  // Python wheels
  if (!fs.existsSync(storePaths.pythonWheels)) {
    failures.push('Missing Python wheelhouse directory');
  }

  // Cargo vendor
  if (!fs.existsSync(storePaths.rustVendor)) {
    failures.push('Missing Cargo vendor directory (rust/vendor)');
  }

  // Sandbox image
  if (!fs.existsSync(storePaths.sandboxImage)) {
    failures.push('Missing sandbox container image store');
  }

  // OCR assets (Tesseract)
  if (!fs.existsSync(storePaths.tesseract)) {
    failures.push('Missing OCR assets store (offline-stores/tesseract)');
  }

  // 5. Check for unlisted executables if requested
  if (options.checkUnlisted && verifyResult.unlisted) {
    for (const u of verifyResult.unlisted) {
      if (u.endsWith('.exe') || u.endsWith('.dll') || u.endsWith('.bat') || u.endsWith('.cmd')) {
        unlistedExecutables.push(u);
        failures.push(`Unlisted executable found in bundle: ${u}`);
      }
    }
  }

  if (verifyResult.missing.length > 0) {
    failures.push(`Missing files in bundle (${verifyResult.missing.length}): ${verifyResult.missing.slice(0, 5).join(', ')}`);
  }
  if (verifyResult.tampered.length > 0) {
    failures.push(`Tampered files in bundle (${verifyResult.tampered.length}): ${verifyResult.tampered.slice(0, 5).join(', ')}`);
  }

  const valid = failures.length === 0;

  return {
    valid,
    missingFiles: verifyResult.missing,
    tamperedFiles: verifyResult.tampered,
    debugBinaries,
    missingStores,
    unlistedExecutables,
    manifestCheck: verifyResult.valid && failures.every(f => !f.startsWith('Bundle manifest verification failed')), 
    failures,
    details: {
      totalEntries: (manifest as any)?.totalEntries,
      totalSize: (manifest as any)?.totalSize,
      entriesHash: (manifest as any)?.buildIdentity?.entriesHash,
      manifestErrors: verifyResult.manifestErrors,
      verificationDetails: verifyResult.details,
    },
  };
}

// ── Stage 2: Clean Disconnected Rehearsal ───────────────────────────

/**
 * Execute clean rehearsal workflow (Stage 2).
 */
export async function runRehearsalWorkflow(options: RehearsalOptions): Promise<RehearsalWorkflowResult> {
  const root = path.resolve(options.projectRoot);
  const failures: string[] = [];
  const rawOutputs: Record<string, unknown> = {};
  const timestamp = new Date().toISOString();

  // 1. Machine identity
  const machineIdentity = {
    hostname: os.hostname(),
    username: process.env.USERNAME || process.env.USER || 'unknown',
    platform: os.platform(),
    osRelease: os.release(),
    architecture: os.arch(),
    nodeVersion: process.version,
    cpuCount: String(os.cpus().length),
    totalMemoryBytes: String(os.totalmem()),
  };
  rawOutputs.machineIdentity = machineIdentity;

  // 2. Network isolation check
  const netIsolation = verifyNetworkIsolation(false);
  rawOutputs.networkIsolation = netIsolation;

  let networkIsolated = false;
  // External DNS resolution must be blocked
  const dnsCheck = netIsolation.checks?.find(c => c.label.includes('DNS'));
  if (dnsCheck && dnsCheck.passed) {
    networkIsolated = true;
  }

  const environmentBlocked = !networkIsolated && !options.allowNetwork;
  if (environmentBlocked) {
    failures.push('NETWORK_NOT_DISABLED: External network access is reachable. Clean rehearsal requires air-gapped / disabled network.');
  }

  // 3. Developer caches check
  let emptyDeveloperCaches = true;
  const npmGlobalCache = path.join(os.homedir(), 'AppData', 'Roaming', 'npm-cache');
  if (fs.existsSync(npmGlobalCache) && fs.readdirSync(npmGlobalCache).length > 0) {
    emptyDeveloperCaches = false;
  }
  rawOutputs.developerCaches = {
    emptyDeveloperCaches,
    npmGlobalCacheExists: fs.existsSync(npmGlobalCache),
  };

  // A connected host is not eligible for a clean disconnected rehearsal. Stop
  // before lifecycle or model work so the fail-closed result is deterministic
  // and cannot leave services running on a host that failed the boundary check.
  if (environmentBlocked) {
    const reportPath = path.resolve(
      options.reportPath || path.join(root, 'artifacts', 'verification', 'G2-rehearsal.json'),
    );
    const reportDir = path.dirname(reportPath);
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const workflowResult: RehearsalWorkflowResult = {
      passed: false,
      machineIdentity,
      networkIsolated,
      emptyDeveloperCaches,
      bundleVerified: false,
      storesVerified: false,
      servicesStarted: false,
      healthPassed: false,
      smokePassed: false,
      lifecyclePassed: false,
      idempotencyPassed: false,
      negativeTestsPassed: false,
      zeroOrphans: true,
      failures,
      rawOutputs,
      reportPath,
      timestamp,
    };

    fs.writeFileSync(reportPath, JSON.stringify(workflowResult, null, 2), 'utf-8');
    return workflowResult;
  }

  // 4. Bundle verification. Network isolation passed, so the clean rehearsal
  // may proceed to bundle, service, and model verification.
  const bundleCheck: BundleVerifyResult = bundleVerify({ projectRoot: root });
  rawOutputs.bundleVerification = bundleCheck;
  const bundleVerified = bundleCheck.valid;
  if (!bundleVerified) {
    failures.push(`Bundle verification failed: ${bundleCheck.failures.join('; ')}`);
  }

  // 5. Offline stores check
  const storeCheck = checkOfflineReadiness({ projectRoot: root });
  rawOutputs.offlineStores = storeCheck;
  const storesVerified = storeCheck.ready;
  if (!storesVerified) {
    failures.push(`Offline stores incomplete: ${storeCheck.summary}`);
  }

  // 6. Start real service processes (Rust engine + text-model)
  let servicesStarted = false;
  let healthPassed = false;
  let smokePassed = false;
  const storePaths = getStorePaths(root);
  let engineManifest: ReturnType<typeof verifyExecutable>;
  let rustEngineConfig: ServiceConfig | undefined;
  let textModelConfig: ServiceConfig | undefined;

  try {
    engineManifest = verifyExecutable(getDefaultEnginePath(root));
    rustEngineConfig = createRustEngineConfig(root, engineManifest.executableHash);

    if (environmentBlocked) {
      rawOutputs.serviceStartup = { skipped: true, reason: 'network isolation failed' };
    } else if (options.textModelConfigOverride) {
      textModelConfig = options.textModelConfigOverride;
    } else if (fs.existsSync(storePaths.modelManifest)) {
      const modelManifest: ModelSnapshotManifest = JSON.parse(
        fs.readFileSync(storePaths.modelManifest, 'utf-8'),
      );
      const modelPath = path.resolve(storePaths.modelSnapshot, modelManifest.snapshotRelativePath);
      const modelScriptPath = path.resolve(root, TEXT_MODEL_SCRIPT);
      const pythonPath = resolvePythonLauncher();
      const snapshotRoot = path.resolve(storePaths.modelSnapshot);
      const insideSnapshotRoot = modelPath === snapshotRoot || modelPath.startsWith(snapshotRoot + path.sep);
      if (fs.existsSync(modelPath) && fs.existsSync(modelScriptPath) && insideSnapshotRoot && pythonPath) {
        textModelConfig = createModelServerConfig({
          id: 'text-model',
          // The Python script is the identity-verified service payload. The
          // interpreter is only its launcher and is never confused with Rust.
          executablePath: modelScriptPath,
          executableHash: hashFile(modelScriptPath),
          launcherPath: pythonPath,
          port: options.modelPort || 8190,
          modelPath,
          modelName: LOCAL_MODEL_NAME,
          modelRevision: modelManifest.revision,
          device: 'cuda',
          approvedModelRoots: [storePaths.modelSnapshot],
          projectRoot: root,
        });
      } else {
        const missing: string[] = [];
        if (!fs.existsSync(modelPath)) missing.push('model snapshot');
        if (!fs.existsSync(modelScriptPath)) missing.push(TEXT_MODEL_SCRIPT);
        if (!pythonPath) missing.push('Python interpreter');
        if (!insideSnapshotRoot) missing.push('model path confinement');
        failures.push(`MISSING_TEXT_MODEL: ${missing.join(', ') || 'text-model prerequisites unavailable'}`);
      }
    } else {
      failures.push('MISSING_TEXT_MODEL: model snapshot manifest is missing or unreadable');
    }
  } catch (err: any) {
    failures.push(`SERVICE_CONFIG_FAILED: ${err.message}`);
  }

  const serviceConfigs: ServiceConfig[] = [];
  if (rustEngineConfig) serviceConfigs.push(rustEngineConfig);
  if (textModelConfig) serviceConfigs.push(textModelConfig);
  if (!rustEngineConfig) failures.push('MISSING_RUST_ENGINE: release Rust engine could not be configured');

  try {
    // 1. Ensure lifecycle is installed
    const installResult = runLifecycleCommand(root, 'install');
    rawOutputs.lifecycleInstall = installResult;

    // 2. Run lifecycle start with real service configs
    const startResult = runLifecycleCommand(root, 'start', serviceConfigs);
    rawOutputs.lifecycleStart = startResult;
    servicesStarted = startResult.success;

    // Verify ownedServices includes both required services
    const ownedIds = ((startResult as any).detail?.ownedServices || []).map((s: any) => s.id);
    if (!ownedIds.includes('text-model') && textModelConfig) {
      failures.push('text-model service did not appear in ownedServices after start');
    }

    // 7. Verify health and smoke
    const healthResult = runLifecycleCommand(root, 'health');
    rawOutputs.lifecycleHealth = healthResult;
    healthPassed = healthResult.success;

    // Run Rust smoke evaluation
    const healthResp = engineHealth(engineManifest!);
    const evalResp = engineEvaluate(
      engineManifest!,
      {
        vibration_rms: 4.2,
        temperature_c: 68.5,
      },
      {
        vibration_rms: { warning: 4.5, critical: 7.1, unit: 'mm/s' },
        temperature_c: { warning: 75.0, critical: 90.0, unit: 'celsius' },
      },
      'TEST-SMOKE',
    );

    let rustSmokePassed = false;
    if (!('error' in healthResp) && !('error' in evalResp)) {
      rustSmokePassed = healthResp.operation === 'health' && evalResp.operation === 'evaluate';
    }

    // Model integrity and model inference are separate criteria. Hashing the
    // snapshot can never make an HTTP completion pass.
    const modelHashResult = environmentBlocked
      ? { valid: false, mismatched: ['skipped because network isolation failed'], checked: 0 }
      : verifyModelSnapshotHashes(root, { forceRehash: false });
    rawOutputs.modelSnapshotHashes = modelHashResult;
    if (!modelHashResult.valid) {
      failures.push(`Model snapshot hash verification failed: ${modelHashResult.mismatched.join('; ')}`);
    }

    let textCompletionResult: TextModelSmokeResult = {
      passed: false,
      protocol: 'openai-compatible-http',
      endpoint: textModelConfig ? `http://${textModelConfig.host}:${textModelConfig.port}` : 'unconfigured',
      detail: 'text-model not configured',
    };
    if (textModelConfig) {
      textCompletionResult = options.textModelSmokeOverride
        ? await options.textModelSmokeOverride(textModelConfig)
        : await runLocalModelSmoke(textModelConfig);
    }

    if (!textCompletionResult.passed) {
      failures.push(`Text completion smoke failed: ${textCompletionResult.detail}`);
    }
    smokePassed = rustSmokePassed && modelHashResult.valid && textCompletionResult.passed;
    rawOutputs.smokeResults = { healthResp, evalResp, textCompletion: textCompletionResult };
  } catch (err: any) {
    failures.push(`Service startup / health / smoke check failed: ${err.message}`);
  }

  // 8. Lifecycle start/status/health/stop and idempotency
  let lifecyclePassed = false;
  let idempotencyPassed = false;

  try {
    const statusResult = runLifecycleCommand(root, 'status');
    rawOutputs.lifecycleStatus = statusResult;

    // Idempotent double start
    const doubleStartResult = runLifecycleCommand(root, 'start', serviceConfigs);
    rawOutputs.doubleStart = doubleStartResult;

    // Stop services
    const stopResult = runLifecycleCommand(root, 'stop');
    rawOutputs.lifecycleStop = stopResult;

    // Idempotent double stop
    const doubleStopResult = runLifecycleCommand(root, 'stop');
    rawOutputs.doubleStop = doubleStopResult;

    lifecyclePassed = statusResult.success && stopResult.success;
    idempotencyPassed = doubleStartResult.idempotentSkip === true && doubleStopResult.idempotentSkip === true;
  } catch (err: any) {
    failures.push(`Lifecycle commands failed: ${err.message}`);
  }

  // 9. Negative tests:
  // a) required service unconfigured must fail rehearsal
  // b) missing required file must fail preflight
  let negativeTestsPassed = false;
  try {
    const profile = options.profile || INDUSTRIAL_PROFILE;
    const rehearsalResult: RehearsalResult = runRehearsal({
      projectRoot: root,
      skipNetworkProbe: true,
      profile: {
        required: ['rust-engine', 'text-model', 'offline-stores', 'bundle-manifest'],
        optional: ['ocr-service', 'react-assets', 'container-runtime'],
      },
      // Model port not provided -> required text-model missing -> MUST fail
    });
    const failedOnMissingModel = rehearsalResult.failures.includes('Text completion');

    // Missing required file install failure test
    const tempDir = path.join(root, '.maos', 'neg-test-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    const missingFileInstall = runLifecycleCommand(tempDir, 'install');
    fs.rmSync(tempDir, { recursive: true, force: true });

    negativeTestsPassed = failedOnMissingModel && missingFileInstall.success === false;
    rawOutputs.negativeTests = {
      failedOnMissingModel,
      missingFileExitCode: missingFileInstall.exitCode,
      rehearsalFailures: rehearsalResult.failures,
    };
  } catch (err: any) {
    failures.push(`Negative tests failed: ${err.message}`);
  }

  // 10. Check for orphan processes
  let zeroOrphans = true;
  const state = readState(root);
  if (state.ownedServices && state.ownedServices.length > 0) {
    for (const svc of state.ownedServices) {
      if (isProcessAlive(svc.pid)) {
        zeroOrphans = false;
        failures.push(`Orphan process detected: PID ${svc.pid} (${svc.serviceId}) still alive after stop`);
      }
    }
  }

  const passed = failures.length === 0;

  // 11. Write raw machine evidence
  const reportPath = path.resolve(
    options.reportPath || path.join(root, 'artifacts', 'verification', 'G2-rehearsal.json'),
  );
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const workflowResult: RehearsalWorkflowResult = {
    passed,
    machineIdentity,
    networkIsolated,
    emptyDeveloperCaches,
    bundleVerified,
    storesVerified,
    servicesStarted,
    healthPassed,
    smokePassed,
    lifecyclePassed,
    idempotencyPassed,
    negativeTestsPassed,
    zeroOrphans,
    failures,
    rawOutputs,
    reportPath,
    timestamp,
  };

  fs.writeFileSync(reportPath, JSON.stringify(workflowResult, null, 2), 'utf-8');

  return workflowResult;
}

// ── Stage 2: Evidence Verification ─────────────────────────────────

/**
 * Verify rehearsal evidence against Gate G2 criteria.
 */
export function verifyRehearsalEvidence(evidencePath: string): EvidenceVerificationResult {
  const absPath = path.resolve(evidencePath);
  if (!fs.existsSync(absPath)) {
    return {
      valid: false,
      g2Ready: false,
      blockers: [`Evidence file not found at ${absPath}`],
      verifiedItems: [],
      summary: 'Evidence file missing',
    };
  }

  let data: RehearsalWorkflowResult;
  try {
    data = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err: any) {
    return {
      valid: false,
      g2Ready: false,
      blockers: [`Evidence file is invalid JSON: ${err.message}`],
      verifiedItems: [],
      summary: 'Invalid JSON evidence',
    };
  }

  const blockers: string[] = [];
  const verifiedItems: string[] = [];
  const raw = (data.rawOutputs || {}) as Record<string, any>;

  // A valid JSON file is not valid G2 evidence. The final workflow result
  // must itself report success; raw subchecks below still remain authoritative.
  if (data.passed !== true) {
    blockers.push('Rehearsal top-level passed flag is not true');
  }

  // ── 1. Machine identity ──────────────────────────────────────────
  if (data.machineIdentity && data.machineIdentity.hostname && data.machineIdentity.osRelease) {
    verifiedItems.push(`Machine identity recorded: ${data.machineIdentity.hostname} (${data.machineIdentity.osRelease})`);
  } else {
    blockers.push('Machine identity missing or incomplete');
  }

  // ── 2. Network isolation ─────────────────────────────────────────
  if (data.networkIsolated) {
    verifiedItems.push('Network isolation verified (external DNS blocked)');
  } else {
    blockers.push('Network isolation not verified (network was active / reachable)');
  }

  // ── 3. Developer caches ──────────────────────────────────────────
  if (data.emptyDeveloperCaches) {
    verifiedItems.push('Empty developer caches confirmed');
  } else {
    blockers.push('Developer caches detected (not an empty / clean machine)');
  }

  // ── 4. Bundle verification (DEEP INSPECTION) ────────────────────
  // Never trust only the top-level bundleVerified boolean.
  const bv = raw.bundleVerification as Record<string, any> | undefined;
  if (bv) {
    // 4a. Both the aggregate and the cryptographic manifest check must pass.
    if (bv.valid !== true) {
      blockers.push('Bundle verification aggregate is not valid');
    }
    if (bv.manifestCheck !== true) {
      blockers.push('Bundle manifest verification failed (manifestCheck is not true)');
    }

    // 4b. No debug binaries
    const debugBins = Array.isArray(bv.debugBinaries) ? bv.debugBinaries : [];
    if (debugBins.length > 0) {
      blockers.push(`Debug binaries present in verified bundle: ${debugBins.map((d: string) => path.basename(d)).join(', ')}`);
    }

    // 4c. No size/hash mismatches in verificationDetails
    const vDetails = bv.details?.verificationDetails || bv.verificationDetails;
    if (typeof vDetails === 'string' && vDetails.toLowerCase().includes('mismatch')) {
      blockers.push(`Bundle verification has file mismatches: ${vDetails}`);
    }

    // 4d. No missing or tampered files
    if (Array.isArray(bv.missingFiles) && bv.missingFiles.length > 0) {
      blockers.push(`Bundle has ${bv.missingFiles.length} missing files`);
    }
    if (Array.isArray(bv.tamperedFiles) && bv.tamperedFiles.length > 0) {
      blockers.push(`Bundle has ${bv.tamperedFiles.length} tampered files`);
    }

    // 4e. No failures array entries
    if (Array.isArray(bv.failures) && bv.failures.length > 0) {
      blockers.push(`Bundle verification failures: ${bv.failures.join('; ')}`);
    }

    // Only mark verified if ALL sub-checks passed
    if (bv.valid === true && bv.manifestCheck === true && debugBins.length === 0 &&
        !(typeof vDetails === 'string' && vDetails.toLowerCase().includes('mismatch')) &&
        (!Array.isArray(bv.missingFiles) || bv.missingFiles.length === 0) &&
        (!Array.isArray(bv.tamperedFiles) || bv.tamperedFiles.length === 0) &&
        (!Array.isArray(bv.failures) || bv.failures.length === 0)) {
      verifiedItems.push('Bundle manifest and file hashes verified (deep inspection passed)');
    }
  } else {
    blockers.push('Bundle verification raw evidence is missing — top-level flags are insufficient');
  }

  // ── 5. Offline stores (DEEP INSPECTION) ──────────────────────────
  const stores = raw.offlineStores as Record<string, any> | undefined;
  if (stores) {
    if (stores.ready !== true) {
      blockers.push('Offline stores readiness is not true');
    }
    const storeList = Array.isArray(stores.stores) ? stores.stores : [];

    // 5a. Python wheels — must have complete wheelhouse, not just 1 package
    const pyStore = storeList.find((s: any) => s.store === 'python-wheels');
    if (pyStore) {
      // Read requirements.lock to get expected package count
      let reqLockPath = '';
      let cursor = path.dirname(path.resolve(evidencePath));
      for (let depth = 0; depth < 6; depth++) {
        const candidate = path.join(cursor, 'requirements.lock');
        if (fs.existsSync(candidate)) {
          reqLockPath = candidate;
          break;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      let expectedPkgCount = 36; // Conservative fallback when evidence is detached.
      if (reqLockPath && fs.existsSync(reqLockPath)) {
        const lines = fs.readFileSync(reqLockPath, 'utf-8').split('\n')
          .filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
        expectedPkgCount = lines.length;
      }
      const wheelCount = pyStore.entryCount || 0;
      if (wheelCount < expectedPkgCount) {
        blockers.push(`Python wheelhouse incomplete: ${wheelCount} wheel(s) present, ${expectedPkgCount} required by requirements.lock`);
      } else {
        verifiedItems.push(`Python wheelhouse complete: ${wheelCount} wheels`);
      }
    } else {
      blockers.push('Python wheelhouse store not found in evidence');
    }

    // 5b. Model snapshot — must be multi-GB, not a stub
    const modelStore = storeList.find((s: any) => s.store === 'model-snapshot');
    if (modelStore) {
      const modelSize = modelStore.totalSizeBytes || 0;
      const ONE_GB = 1_000_000_000;
      if (modelSize < ONE_GB) {
        blockers.push(`Model snapshot too small (${(modelSize / 1024 / 1024).toFixed(1)} MB) — expected multi-GB model payload`);
      } else {
        verifiedItems.push(`Model snapshot verified: ${modelStore.entryCount} files (${(modelSize / 1024 / 1024 / 1024).toFixed(1)} GB)`);
      }
    } else {
      blockers.push('Model snapshot store not found in evidence');
    }

    // 5c. Overall store readiness (missing/invalid stores)
    if (Array.isArray(stores.missingStores) && stores.missingStores.length > 0) {
      blockers.push(`Missing offline stores: ${stores.missingStores.join(', ')}`);
    }
    if (Array.isArray(stores.invalidStores) && stores.invalidStores.length > 0) {
      blockers.push(`Invalid offline stores: ${stores.invalidStores.join(', ')}`);
    }

    const modelHashes = raw.modelSnapshotHashes as Record<string, any> | undefined;
    if (!modelHashes || modelHashes.valid !== true || modelHashes.checked <= 0) {
      blockers.push('Model snapshot cryptographic hash verification missing or failed');
    } else {
      verifiedItems.push(`Model snapshot hashes verified: ${modelHashes.checked} files`);
    }
  } else {
    blockers.push('Offline stores raw evidence is missing — top-level flags are insufficient');
  }

  // ── 6. Services — both rust-engine AND text-model required ───────
  const lifecycleStart = raw.lifecycleStart as Record<string, any> | undefined;
  if (lifecycleStart) {
    if (lifecycleStart.success !== true) {
      blockers.push('Lifecycle start command did not succeed');
    }
    const ownedServices = lifecycleStart.detail?.ownedServices;
    if (Array.isArray(ownedServices)) {
      const serviceIds = ownedServices.map((s: any) => s.id || s.serviceId);
      if (!serviceIds.includes('rust-engine')) {
        blockers.push('Required service "rust-engine" not found in ownedServices');
      }
      if (!serviceIds.includes('text-model')) {
        blockers.push('Required service "text-model" not found in ownedServices');
      }
      if (serviceIds.includes('rust-engine') && serviceIds.includes('text-model')) {
        verifiedItems.push(`Both required services started: ${serviceIds.join(', ')}`);
      }
    } else {
      blockers.push('ownedServices not found in lifecycle start evidence');
    }
  } else {
    blockers.push('Lifecycle service-start evidence is missing');
  }

  // ── 7. Smoke test — must include text completion ─────────────────
  const smokeResults = raw.smokeResults as Record<string, any> | undefined;
  if (smokeResults) {
    // Check Rust engine smoke
    const healthResp = smokeResults.healthResp;
    const evalResp = smokeResults.evalResp;
    if (healthResp && !healthResp.error && healthResp.operation === 'health') {
      verifiedItems.push('Rust engine health check passed');
    } else {
      blockers.push('Rust engine health check failed or returned error');
    }
    if (evalResp && !evalResp.error && evalResp.operation === 'evaluate') {
      verifiedItems.push('Rust engine evaluation smoke passed');
    } else {
      blockers.push('Rust engine evaluation smoke failed');
    }

    // Check text completion. A boolean alone is not evidence: require the
    // OpenAI-compatible HTTP protocol, model identity, HTTP 200 completion,
    // response hash, and exact deterministic output marker.
    const textCompletion = smokeResults.textCompletion;
    const completion = textCompletion?.completion;
    const validTextEvidence = textCompletion?.passed === true &&
      textCompletion.protocol === 'openai-compatible-http' &&
      typeof textCompletion.endpoint === 'string' &&
      textCompletion.endpoint.startsWith('http://127.0.0.1:') &&
      typeof textCompletion.modelId === 'string' &&
      typeof textCompletion.revision === 'string' &&
      completion?.status === 200 &&
      typeof completion.responseHash === 'string' && /^[0-9a-f]{64}$/i.test(completion.responseHash) &&
      completion.contentExact === true;
    if (validTextEvidence) {
      verifiedItems.push(`Text completion smoke test passed over ${textCompletion.endpoint}`);
    } else {
      blockers.push('Text completion smoke test missing, synthetic, or failed');
    }
  } else if (!data.smokePassed) {
    blockers.push('Smoke tests failed');
  } else {
    blockers.push('Smoke results raw data missing — cannot verify text completion');
  }

  // ── 8. Health check ──────────────────────────────────────────────
  if (data.healthPassed === true) {
    verifiedItems.push('Health check passed');
  } else {
    blockers.push('Health check failed');
  }

  // ── 9. Lifecycle idempotency ─────────────────────────────────────
  if (data.lifecyclePassed === true && data.idempotencyPassed === true) {
    verifiedItems.push('Lifecycle start/stop and double start/stop idempotency verified');
  } else {
    blockers.push('Lifecycle commands or idempotency checks failed');
  }

  // ── 10. Negative / tamper tests ──────────────────────────────────
  const negTests = raw.negativeTests as Record<string, any> | undefined;
  if (negTests) {
    if (data.negativeTestsPassed !== true) {
      blockers.push('Negative test aggregate did not pass');
    }
    if (negTests.failedOnMissingModel !== true) {
      blockers.push('Negative test: missing required model did not fail rehearsal');
    }
    // Ensure rehearsalFailures doesn't contain items that should have passed
    const rehearsalFailures = Array.isArray(negTests.rehearsalFailures) ? negTests.rehearsalFailures : [];
    verifiedItems.push(`Negative tests verified: failedOnMissingModel=${negTests.failedOnMissingModel}, failures=[${rehearsalFailures.join(', ')}]`);
  } else if (data.negativeTestsPassed) {
    verifiedItems.push('Negative tests passed (top-level only)');
  } else {
    blockers.push('Negative tests failed');
  }

  // ── 11. Zero orphans ─────────────────────────────────────────────
  if (data.zeroOrphans === true) {
    verifiedItems.push('Zero orphan processes remaining after stop');
  } else {
    blockers.push('Orphan processes detected after stop');
  }

  // ── 12. Top-level failures array must be empty ───────────────────
  if (Array.isArray(data.failures) && data.failures.length > 0) {
    blockers.push(`Top-level failures recorded: ${data.failures.join('; ')}`);
  }

  const g2Ready = blockers.length === 0;

  return {
    valid: true,
    g2Ready,
    blockers,
    verifiedItems,
    summary: g2Ready
      ? 'All G2 clean disconnected rehearsal criteria satisfied'
      : `G2 BLOCKED by ${blockers.length} criteria: ${blockers.join('; ')}`,
  };
}
