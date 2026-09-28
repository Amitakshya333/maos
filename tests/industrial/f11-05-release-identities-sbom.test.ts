/**
 * F11-05: Release Identities & Software Bill of Materials (SBOM) Test Suite
 *
 * Verifies that all components of the MAOS Industrial Edition have verified
 * cryptographic identities and that the release self-verifies offline.
 *
 * Scopes tested:
 *   1. Launcher (CLI entrypoints)
 *   2. Project Service (Host runtime & container)
 *   3. Model Manager (Registry, Leases & Residency)
 *   4. Rust Engine (Release executable with #![forbid(unsafe_code)])
 *   5. Python Runtime (Sandboxed calculation & test scripts)
 *   6. Container Manifest (Docker sandbox manifest & digests)
 *   7. Model Registry (Supported local models and weight manifests)
 *   8. GUI Assets (Offline React bundle, HTML & static assets)
 *
 * Negative tests:
 *   - Replacement / tampered component fails verification closed
 *   - Missing declared license fails verification closed
 *   - Remote CDN asset in GUI bundle fails verification closed
 *   - Unmanifested executable in release bin dir fails verification closed
 *   - Canary file rust/test.txt SHA-256 strictly preserved
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  generateReleaseSbom,
  verifyReleaseSbom,
  writeReleaseSbom,
  readReleaseSbom,
  ReleaseSbom,
} from '../../src/industrial/release-sbom';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function checkCanary() {
  const canaryContent = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(canaryContent).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

describe('F11-05: Release Identities & SBOM Verification', () => {
  let canonicalSbom: ReleaseSbom;
  const sbomOutputPath = path.join(PROJECT_ROOT, 'industrial', 'release-sbom.json');

  beforeAll(() => {
    checkCanary();
    if (fs.existsSync(sbomOutputPath)) {
      canonicalSbom = readReleaseSbom(sbomOutputPath);
    } else {
      canonicalSbom = generateReleaseSbom(PROJECT_ROOT);
      writeReleaseSbom(canonicalSbom, sbomOutputPath);
    }
  });

  beforeEach(() => {
    checkCanary();
  });

  afterEach(() => {
    checkCanary();
  });

  // ══════════════════════════════════════════════════════════════
  // 1. All 8 Release Scopes Present & Valid
  // ══════════════════════════════════════════════════════════════

  describe('1. Release Scopes Coverage & Identity Hashes', () => {
    it('1. Launcher identity is fingerprinted and valid', () => {
      const launcher = canonicalSbom.components['launcher-cli'];
      expect(launcher).toBeDefined();
      expect(launcher.component).toBe('launcher');
      expect(launcher.isExecutable).toBe(true);
      expect(launcher.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(launcher.license).toBe('MIT');
    });

    it('2. Project Service host & core runtime are fingerprinted and valid', () => {
      const host = canonicalSbom.components['project-service-host'];
      const core = canonicalSbom.components['project-service-core'];
      expect(host).toBeDefined();
      expect(core).toBeDefined();
      expect(host.component).toBe('project-service');
      expect(core.component).toBe('project-service');
      expect(host.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(core.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('3. Model Manager & residency service are fingerprinted and valid', () => {
      const mgr = canonicalSbom.components['model-manager-core'];
      expect(mgr).toBeDefined();
      expect(mgr.component).toBe('model-manager');
      expect(mgr.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(mgr.license).toBe('MIT');
    });

    it('4. Rust Engine binary is fingerprinted with release hash', () => {
      const rustBin = canonicalSbom.components['rust-engine-binary'];
      expect(rustBin).toBeDefined();
      expect(rustBin.component).toBe('rust-engine');
      expect(rustBin.isExecutable).toBe(true);
      expect(rustBin.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rustBin.license).toContain('MIT');
    });

    it('5. Python runtime scripts are fingerprinted with deterministic hashes', () => {
      const rmsCalc = canonicalSbom.components['python-rms-calculation'];
      const rmsVerif = canonicalSbom.components['python-rms-verification'];
      expect(rmsCalc).toBeDefined();
      expect(rmsVerif).toBeDefined();
      expect(rmsCalc.component).toBe('python-runtime');
      expect(rmsVerif.component).toBe('python-runtime');
      expect(rmsCalc.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rmsVerif.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('6. Container manifest is fingerprinted with docker digest', () => {
      const container = canonicalSbom.components['sandbox-container-manifest'];
      expect(container).toBeDefined();
      expect(container.component).toBe('sandbox-container');
      expect(container.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('7. Model registry spec and offline embedding snapshot assets are fingerprinted', () => {
      const registry = canonicalSbom.components['model-registry-spec'];
      expect(registry).toBeDefined();
      expect(registry.component).toBe('model-registry');
      expect(registry.sha256).toMatch(/^[a-f0-9]{64}$/);

      const embManifest = canonicalSbom.components['embedding-snapshot-manifest'];
      expect(embManifest).toBeDefined();
      expect(embManifest.component).toBe('model-registry');
      expect(embManifest.license).toBe('Apache-2.0');
      expect(embManifest.sha256).toMatch(/^[a-f0-9]{64}$/);

      const embSafetensors = canonicalSbom.components['embedding-snapshot-model-safetensors'];
      expect(embSafetensors).toBeDefined();
      expect(embSafetensors.component).toBe('model-registry');
      expect(embSafetensors.license).toBe('Apache-2.0');
      expect(embSafetensors.sha256).toBe('53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db');
    });

    it('8. GUI bundle assets are fingerprinted and strictly offline', () => {
      const guiIndex = canonicalSbom.components['gui-index-html'];
      expect(guiIndex).toBeDefined();
      expect(guiIndex.component).toBe('gui-assets');
      expect(guiIndex.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(guiIndex.isRemote).toBe(false);

      const guiAssets = Object.values(canonicalSbom.components).filter((c) => c.component === 'gui-assets');
      expect(guiAssets.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Offline Standalone Self-Verification
  // ══════════════════════════════════════════════════════════════

  describe('2. Offline Standalone Self-Verification', () => {
    it('exact release self-verifies strictly offline against disk', () => {
      const readSbom = readReleaseSbom(sbomOutputPath);
      const result = verifyReleaseSbom(readSbom, PROJECT_ROOT);

      expect(result.valid).toBe(true);
      expect(result.verifiedComponentsCount).toBeGreaterThan(5);
      expect(result.missingComponents).toHaveLength(0);
      expect(result.tamperedComponents).toHaveLength(0);
      expect(result.missingLicenses).toHaveLength(0);
      expect(result.remoteAssetsDetected).toHaveLength(0);
      expect(result.unmanifestedExecutables).toHaveLength(0);
    });

    it('canonical entries hash is reproducible and tamper-evident', () => {
      const regenerated = generateReleaseSbom(PROJECT_ROOT);
      expect(regenerated.entriesHash).toBe(canonicalSbom.entriesHash);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Negative Invariants & Fail-Closed Behavior
  // ══════════════════════════════════════════════════════════════

  describe('3. Negative Invariants & Fail-Closed Enforcement', () => {
    it('fails closed when a component has been replaced or tampered', () => {
      const tamperedSbom: ReleaseSbom = JSON.parse(JSON.stringify(canonicalSbom));
      const firstKey = Object.keys(tamperedSbom.components)[0];
      const tamperedEntry = {
        ...tamperedSbom.components[firstKey],
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      };
      tamperedSbom.components[firstKey] = tamperedEntry;

      const result = verifyReleaseSbom(tamperedSbom, PROJECT_ROOT);
      expect(result.valid).toBe(false);
      expect(result.tamperedComponents.length).toBeGreaterThan(0);
      expect(result.tamperedComponents[0]).toContain(firstKey);
    });

    it('fails closed when a component is missing declared license', () => {
      const unlicensedSbom: ReleaseSbom = JSON.parse(JSON.stringify(canonicalSbom));
      const firstKey = Object.keys(unlicensedSbom.components)[0];
      const unlicensedEntry = {
        ...unlicensedSbom.components[firstKey],
        license: '',
      };
      unlicensedSbom.components[firstKey] = unlicensedEntry;

      const result = verifyReleaseSbom(unlicensedSbom, PROJECT_ROOT);
      expect(result.valid).toBe(false);
      expect(result.missingLicenses.length).toBeGreaterThan(0);
      expect(result.missingLicenses[0]).toContain(firstKey);
    });

    it('fails closed if any GUI asset references external CDN or remote resources', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-remote-asset-test-'));
      try {
        const fakeGui = path.join(tempDir, 'dist', 'gui');
        fs.mkdirSync(fakeGui, { recursive: true });
        const fakeIndex = path.join(fakeGui, 'index.html');
        // Inject remote CDN link
        fs.writeFileSync(fakeIndex, '<html><head><script src="https://cdn.jsdelivr.net/npm/vue"></script></head></html>');

        const testSbom: ReleaseSbom = {
          schemaVersion: 1,
          spdxVersion: 'SPDX-2.3',
          releaseName: 'Test',
          releaseVersion: '0.3.0',
          rootLicense: 'MIT',
          generatedAt: new Date().toISOString(),
          entriesHash: '00'.repeat(32),
          components: {
            'gui-test': {
              id: 'gui-test',
              component: 'gui-assets',
              name: 'Remote CDN Injected Asset',
              version: '0.3.0',
              relativePath: 'dist/gui/index.html',
              sha256: crypto.createHash('sha256').update(fs.readFileSync(fakeIndex)).digest('hex'),
              size: fs.statSync(fakeIndex).size,
              license: 'MIT',
              isExecutable: false,
              isRemote: false,
            },
          },
        };

        const result = verifyReleaseSbom(testSbom, tempDir);
        expect(result.valid).toBe(false);
        expect(result.remoteAssetsDetected.length).toBeGreaterThan(0);
        expect(result.remoteAssetsDetected[0]).toContain('detected remote CDN asset reference');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('fails closed if an unmanifested executable is found in release directory', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-unmanifested-test-'));
      try {
        const releaseDir = path.join(tempDir, 'rust', 'target', 'release');
        fs.mkdirSync(releaseDir, { recursive: true });
        // Place an unmanifested binary
        const badExePath = path.join(releaseDir, 'unauthorized_payload.exe');
        fs.writeFileSync(badExePath, 'MZ_FAKE_EXECUTABLE');

        const testSbom: ReleaseSbom = {
          schemaVersion: 1,
          spdxVersion: 'SPDX-2.3',
          releaseName: 'Test',
          releaseVersion: '0.3.0',
          rootLicense: 'MIT',
          generatedAt: new Date().toISOString(),
          entriesHash: '00'.repeat(32),
          components: {},
        };

        const result = verifyReleaseSbom(testSbom, tempDir);
        expect(result.valid).toBe(false);
        expect(result.unmanifestedExecutables.length).toBeGreaterThan(0);
        expect(result.unmanifestedExecutables[0]).toContain('unauthorized_payload.exe');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
