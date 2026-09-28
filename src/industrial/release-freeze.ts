/**
 * F11-08: Industrial Release Freeze & Integrity Verifier
 *
 * Implements authoritative freeze packaging, asset fingerprinting,
 * fallback recording/screens ledger, and post-freeze mutation rejection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FrozenAssetRecord {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly category: 'code' | 'config' | 'engine' | 'template' | 'gui' | 'demo';
  readonly required: boolean;
}

export interface FallbackScreenRecord {
  readonly screenId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface RecordingPlanLedger {
  readonly plan: string;
  readonly scriptPath: string;
  readonly runbookPath: string;
  readonly stepsCovered: readonly string[];
}

export interface ReleaseFreezeManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly frozenAt: string;
  readonly freezeDigest: string;
  readonly canarySha256: string;
  readonly assets: readonly FrozenAssetRecord[];
  readonly fallbackScreens: readonly FallbackScreenRecord[];
  readonly recordingLedger: RecordingPlanLedger;
}

export interface FreezeVerificationResult {
  readonly valid: boolean;
  readonly verifiedCount: number;
  readonly missingFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly errors: readonly string[];
  readonly computedDigest: string;
}

export const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

/**
 * Core assets designated for the release freeze.
 */
export const FROZEN_ASSET_TARGETS: ReadonlyArray<{ path: string; category: FrozenAssetRecord['category']; required: boolean }> = [
  // Configuration
  { path: 'package.json', category: 'config', required: true },
  { path: 'profiles/industrial/maos.config.json', category: 'config', required: true },
  
  // Public Demo Evidence Pack
  { path: 'demo/industrial/turbine_vibration_log.csv', category: 'demo', required: true },
  { path: 'demo/industrial/DEMO_PACK_PROVENANCE.json', category: 'demo', required: true },
  { path: 'demo/industrial/ground_truth.json', category: 'demo', required: true },
  { path: 'demo/industrial/sop_turbine_vibration_monitoring.md', category: 'demo', required: true },
  { path: 'demo/industrial/turbine_inspection_scan.pdf', category: 'demo', required: true },
  
  // Fallback Presentation Assets
  { path: 'demo/industrial/PRESENTATION_SCRIPT.md', category: 'demo', required: true },
  { path: 'demo/industrial/RUNBOOK.md', category: 'demo', required: true },
  { path: 'demo/industrial/images/pid_drawing.png', category: 'demo', required: true },
  { path: 'demo/industrial/images/pressure_gauge.png', category: 'demo', required: true },
  { path: 'demo/industrial/images/turbine_nameplate.png', category: 'demo', required: true },

  // Release SBOM
  { path: 'industrial/release-sbom.json', category: 'config', required: true },

  // Offline Embedding Snapshot Manifest
  { path: 'embedding-snapshot-manifest.json', category: 'config', required: true },
];

/**
 * Computes SHA-256 for a given file.
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Computes root freeze digest across all sorted asset records.
 */
export function computeFreezeDigest(assets: readonly FrozenAssetRecord[], canaryHash: string): string {
  const sorted = [...assets].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hasher = crypto.createHash('sha256');
  hasher.update(`CANARY:${canaryHash}\n`);
  for (const asset of sorted) {
    hasher.update(`${asset.relativePath}|${asset.sha256}|${asset.byteSize}\n`);
  }
  return hasher.digest('hex');
}

/**
 * Generates an authoritative ReleaseFreezeManifest for the project.
 */
export function generateReleaseFreezeManifest(projectRoot: string): ReleaseFreezeManifest {
  const canaryPath = path.resolve(projectRoot, 'rust', 'test.txt');
  if (!fs.existsSync(canaryPath)) {
    throw new Error('Canary file rust/test.txt is missing from project root');
  }
  const canarySha256 = computeFileHash(canaryPath);
  if (canarySha256 !== CANARY_EXPECTED_HASH) {
    throw new Error(`Canary hash mismatch: expected ${CANARY_EXPECTED_HASH}, got ${canarySha256}`);
  }

  const assets: FrozenAssetRecord[] = [];
  for (const target of FROZEN_ASSET_TARGETS) {
    const absPath = path.resolve(projectRoot, target.path);
    if (!fs.existsSync(absPath)) {
      if (target.required) {
        throw new Error(`Required frozen asset missing: ${target.path}`);
      }
      continue;
    }
    const stat = fs.statSync(absPath);
    assets.push({
      relativePath: target.path,
      sha256: computeFileHash(absPath),
      byteSize: stat.size,
      category: target.category,
      required: target.required,
    });
  }

  // Also include rust release engine binary if present
  const rustExt = process.platform === 'win32' ? '.exe' : '';
  const rustRel = path.join('rust', 'target', 'release', `maos-engine${rustExt}`);
  const rustAbs = path.resolve(projectRoot, rustRel);
  if (fs.existsSync(rustAbs)) {
    const stat = fs.statSync(rustAbs);
    assets.push({
      relativePath: rustRel.replace(/\\/g, '/'),
      sha256: computeFileHash(rustAbs),
      byteSize: stat.size,
      category: 'engine',
      required: true,
    });
  }

  // Fallback screen ledger
  const fallbackScreens: FallbackScreenRecord[] = [
    {
      screenId: 'SCREEN-01-PID',
      title: 'Piping and Instrumentation Diagram',
      relativePath: 'demo/industrial/images/pid_drawing.png',
      sha256: computeFileHash(path.resolve(projectRoot, 'demo/industrial/images/pid_drawing.png')),
    },
    {
      screenId: 'SCREEN-02-GAUGE',
      title: 'Pressure Gauge Inspection Calibration',
      relativePath: 'demo/industrial/images/pressure_gauge.png',
      sha256: computeFileHash(path.resolve(projectRoot, 'demo/industrial/images/pressure_gauge.png')),
    },
    {
      screenId: 'SCREEN-03-NAMEPLATE',
      title: 'Turbine Generator Nameplate Specification',
      relativePath: 'demo/industrial/images/turbine_nameplate.png',
      sha256: computeFileHash(path.resolve(projectRoot, 'demo/industrial/images/turbine_nameplate.png')),
    },
  ];

  const freezeDigest = computeFreezeDigest(assets, canarySha256);

  return {
    schemaVersion: 1,
    releaseVersion: '1.0.0-industrial',
    frozenAt: '2026-09-25T00:00:00.000Z',
    freezeDigest,
    canarySha256,
    assets,
    fallbackScreens,
    recordingLedger: {
      plan: '15-minute judged novice journey D1-D7',
      scriptPath: 'demo/industrial/PRESENTATION_SCRIPT.md',
      runbookPath: 'demo/industrial/RUNBOOK.md',
      stepsCovered: [
        'D1_PREFLIGHT',
        'D2_AGENTIC_DOCS',
        'D3_RMS_CALCULATION',
        'D4_MULTIMODAL_EVIDENCE',
        'D5_OFFICE_DELIVERABLES',
        'D6_SOVEREIGNTY_BUNDLE',
        'D7_JUDGED_RUN',
      ],
    },
  };
}

/**
 * Validates a ReleaseFreezeManifest against current project filesystem on disk.
 */
export function verifyReleaseFreeze(
  projectRoot: string,
  manifest: ReleaseFreezeManifest,
): FreezeVerificationResult {
  const missingFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const errors: string[] = [];

  // 1. Canary integrity
  const canaryPath = path.resolve(projectRoot, 'rust', 'test.txt');
  if (!fs.existsSync(canaryPath)) {
    missingFiles.push('rust/test.txt');
    errors.push('Canary file missing');
  } else {
    const currentCanary = computeFileHash(canaryPath);
    if (currentCanary !== manifest.canarySha256 || currentCanary !== CANARY_EXPECTED_HASH) {
      modifiedFiles.push('rust/test.txt');
      errors.push(`Canary file altered: expected ${manifest.canarySha256}, got ${currentCanary}`);
    }
  }

  // 2. Verify all asset records
  let verifiedCount = 0;
  for (const asset of manifest.assets) {
    const absPath = path.resolve(projectRoot, asset.relativePath);
    if (!fs.existsSync(absPath)) {
      if (asset.required) {
        missingFiles.push(asset.relativePath);
        errors.push(`Missing frozen asset: ${asset.relativePath}`);
      }
      continue;
    }

    const currentHash = computeFileHash(absPath);
    if (currentHash !== asset.sha256) {
      modifiedFiles.push(asset.relativePath);
      errors.push(`Post-freeze modification in ${asset.relativePath}: expected ${asset.sha256}, got ${currentHash}`);
    } else {
      verifiedCount++;
    }
  }

  // 3. Verify fallback screens
  for (const screen of manifest.fallbackScreens) {
    const absPath = path.resolve(projectRoot, screen.relativePath);
    if (!fs.existsSync(absPath)) {
      missingFiles.push(screen.relativePath);
      errors.push(`Missing fallback screen: ${screen.relativePath}`);
      continue;
    }
    const currentHash = computeFileHash(absPath);
    if (currentHash !== screen.sha256) {
      modifiedFiles.push(screen.relativePath);
      errors.push(`Modified fallback screen: ${screen.relativePath}`);
    }
  }

  // 4. Verify overall freeze digest
  const computedDigest = computeFreezeDigest(manifest.assets, manifest.canarySha256);
  if (computedDigest !== manifest.freezeDigest) {
    errors.push(`Freeze digest mismatch: expected ${manifest.freezeDigest}, computed ${computedDigest}`);
  }

  return {
    valid: errors.length === 0,
    verifiedCount,
    missingFiles,
    modifiedFiles,
    errors,
    computedDigest,
  };
}
