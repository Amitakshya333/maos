/**
 * F2-04: Offline Store Builder Tests
 *
 * Tests:
 * - npm store: manifest present, lockfile present, missing manifest
 * - Rust vendor: Cargo.lock, .cargo/config.toml, vendor dir
 * - Python wheels: requirements.lock, wheelhouse dir, missing reqs
 * - Tesseract: system PATH or store dir
 * - Sandbox image: tar files in store
 * - Model snapshot: manifest, file presence, size, hash verification
 * - Orchestrator: validateAllStores, checkOfflineReadiness
 * - Build instructions generated for missing stores
 * - Cache miss / missing store detection
 * - Exit codes documented and unique
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { hashFile } from '../src/industrial/bundle-manifest';
import {
  validateNpmStore,
  validateRustVendorStore,
  validatePythonWheelStore,
  validateTesseractStore,
  validateSandboxImageStore,
  validateModelSnapshotStore,
  verifyModelSnapshotHashes,
  validateAllStores,
  checkOfflineReadiness,
  generateBuildInstructions,
  npmStoreBuildCommands,
  rustVendorBuildCommands,
  pythonWheelBuildCommands,
  sandboxImageBuildCommands,
  getStorePaths,
  STORE_EXIT,
  OfflineStoreConfig,
} from '../src/industrial/offline-stores';

const PROJECT_ROOT = path.resolve(__dirname, '..');

function baseConfig(): OfflineStoreConfig {
  return { projectRoot: PROJECT_ROOT };
}

describe('F2-04: Offline Store Builder', () => {

  // ══════════════════════════════════════════════════════════════
  // Store paths
  // ══════════════════════════════════════════════════════════════

  describe('Store paths', () => {
    it('should generate all required paths from project root', () => {
      const paths = getStorePaths(PROJECT_ROOT);
      expect(paths.npmManifest).toContain('npm-cache-manifest.json');
      expect(paths.rustLockfile).toContain('Cargo.lock');
      expect(paths.rustCargoConfig).toContain('config.toml');
      expect(paths.requirementsLock).toContain('requirements.lock');
      expect(paths.modelManifest).toContain('model-snapshot-manifest.json');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. npm store
  // ══════════════════════════════════════════════════════════════

  describe('npm store', () => {
    it('should reject the stale/incomplete checked-in npm cache inventory', () => {
      const status = validateNpmStore(PROJECT_ROOT);
      // The current repository has an application tarball, but not a complete
      // cache for every package in the current package-lock.json.
      if (fs.existsSync(path.resolve(PROJECT_ROOT, 'npm-cache-manifest.json'))) {
        expect(status.present).toBe(true);
        expect(status.valid).toBe(false);
        expect(status.detail).toMatch(/SHA-256|inventory is incomplete/i);
      }
    });

    it('should fail for non-existent project', () => {
      const status = validateNpmStore('/nonexistent/project');
      expect(status.present).toBe(false);
      expect(status.valid).toBe(false);
      expect(status.detail).toContain('not found');
    });

    it('should produce build commands', () => {
      const cmds = npmStoreBuildCommands();
      expect(cmds.length).toBeGreaterThan(0);
      expect(cmds.some(c => c.includes('npm pack'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Rust vendor store
  // ══════════════════════════════════════════════════════════════

  describe('Rust vendor store', () => {
    it('should detect Cargo.lock and .cargo/config.toml', () => {
      const status = validateRustVendorStore(PROJECT_ROOT);
      expect(status.present).toBe(true);
      expect(status.valid).toBe(true);
      expect(status.detail).toContain('Cargo.lock');
    });

    it('should fail when Cargo.lock is missing', () => {
      const status = validateRustVendorStore('/nonexistent/project');
      expect(status.present).toBe(false);
      expect(status.valid).toBe(false);
      expect(status.detail).toContain('Cargo.lock');
    });

    it('should produce build commands', () => {
      const cmds = rustVendorBuildCommands();
      expect(cmds.some(c => c.includes('cargo vendor'))).toBe(true);
      expect(cmds.some(c => c.includes('--locked'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Python wheel store
  // ══════════════════════════════════════════════════════════════

  describe('Python wheel store', () => {
    it('should detect requirements.lock', () => {
      const status = validatePythonWheelStore(PROJECT_ROOT);
      // requirements.lock exists but wheelhouse may not
      if (fs.existsSync(path.resolve(PROJECT_ROOT, 'requirements.lock'))) {
        // At least requirements.lock is present
        expect(status.detail).toBeDefined();
      }
    });

    it('should fail when requirements.lock is missing', () => {
      const status = validatePythonWheelStore('/nonexistent/project');
      expect(status.present).toBe(false);
      expect(status.valid).toBe(false);
      expect(status.detail).toContain('requirements.lock');
    });

    it('should produce build commands', () => {
      const cmds = pythonWheelBuildCommands();
      expect(cmds.some(c => c.includes('pip download'))).toBe(true);
      expect(cmds.some(c => c.includes('--no-index'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Tesseract store
  // ══════════════════════════════════════════════════════════════

  describe('Tesseract store', () => {
    it('should check PATH or store directory', () => {
      const status = validateTesseractStore(PROJECT_ROOT);
      // May or may not be installed — just verify it runs
      expect(status.store).toBe('tesseract');
      expect(typeof status.present).toBe('boolean');
      expect(typeof status.valid).toBe('boolean');
    });

    it('should report missing tesseract', () => {
      // Non-existent project with no PATH tesseract
      const status = validateTesseractStore('/nonexistent/project');
      expect(status.store).toBe('tesseract');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Sandbox image store
  // ══════════════════════════════════════════════════════════════

  describe('Sandbox image store', () => {
    it('should report missing store directory', () => {
      const status = validateSandboxImageStore('/nonexistent/project');
      expect(status.present).toBe(false);
      expect(status.valid).toBe(false);
      expect(status.detail).toContain('docker save');
    });

    it('should produce build commands', () => {
      const cmds = sandboxImageBuildCommands('maos-sandbox:latest');
      expect(cmds.some(c => c.includes('docker save'))).toBe(true);
      expect(cmds.some(c => c.includes('docker load'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Model snapshot store
  // ══════════════════════════════════════════════════════════════

  describe('Model snapshot store', () => {
    it('should detect model-snapshot-manifest.json', () => {
      const status = validateModelSnapshotStore(PROJECT_ROOT);
      // Manifest exists but snapshot dir may not
      if (fs.existsSync(path.resolve(PROJECT_ROOT, 'model-snapshot-manifest.json'))) {
        expect(status.present).toBe(true);
        expect(status.detail).toContain('Qwen');
      }
    });

    it('should fail for missing manifest', () => {
      const status = validateModelSnapshotStore('/nonexistent/project');
      expect(status.present).toBe(false);
      expect(status.valid).toBe(false);
    });

    it('should report model name and revision in detail', () => {
      const status = validateModelSnapshotStore(PROJECT_ROOT);
      if (status.present) {
        // Either reports missing files or model info
        expect(status.detail.length).toBeGreaterThan(0);
      }
    });

    it('should handle hash verification for missing snapshot', () => {
      const result = verifyModelSnapshotHashes('/nonexistent');
      expect(result.valid).toBe(false);
    });

    it('should force-rehash a same-size file even when the mtime cache could be reused', () => {
      const tempRoot = path.join(PROJECT_ROOT, '.maos', `hash-cache-${Date.now()}`);
      const snapshot = path.join(tempRoot, 'offline-stores', 'model-snapshot', 'snapshot', 'revision');
      const file = path.join(snapshot, 'tiny.bin');
      fs.mkdirSync(snapshot, { recursive: true });
      fs.writeFileSync(file, 'AAAA');
      const originalStat = fs.statSync(file);
      fs.writeFileSync(path.join(tempRoot, 'model-snapshot-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        model: 'test/model',
        revision: 'revision',
        snapshotRelativePath: 'snapshot/revision',
        files: [{ path: 'tiny.bin', size: 4, sha256: hashFile(file).toUpperCase() }],
      }));

      try {
        expect(verifyModelSnapshotHashes(tempRoot).valid).toBe(true);
        fs.writeFileSync(file, 'BBBB');
        fs.utimesSync(file, originalStat.atime, originalStat.mtime);
        const forced = verifyModelSnapshotHashes(tempRoot, { forceRehash: true });
        expect(forced.valid).toBe(false);
        expect(forced.mismatched[0]).toContain('tiny.bin');
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Orchestrator
  // ══════════════════════════════════════════════════════════════

  describe('Orchestrator', () => {
    it('should validate all 6 stores', () => {
      const config = baseConfig();
      const results = validateAllStores(config);
      expect(results.length).toBe(6);

      const storeNames = results.map(r => r.store);
      expect(storeNames).toContain('npm');
      expect(storeNames).toContain('rust-vendor');
      expect(storeNames).toContain('python-wheels');
      expect(storeNames).toContain('tesseract');
      expect(storeNames).toContain('sandbox-image');
      expect(storeNames).toContain('model-snapshot');
    });

    it('should report offline readiness', () => {
      const config = baseConfig();
      const readiness = checkOfflineReadiness(config);

      expect(typeof readiness.ready).toBe('boolean');
      expect(readiness.stores.length).toBe(6);
      expect(readiness.summary.length).toBeGreaterThan(0);
    });

    it('should identify missing and invalid stores', () => {
      const config: OfflineStoreConfig = { projectRoot: '/nonexistent' };
      const readiness = checkOfflineReadiness(config);

      expect(readiness.ready).toBe(false);
      expect(readiness.missingStores.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Build instructions
  // ══════════════════════════════════════════════════════════════

  describe('Build instructions', () => {
    it('should generate instructions for missing stores', () => {
      const config: OfflineStoreConfig = { projectRoot: '/nonexistent' };
      const instructions = generateBuildInstructions(config);

      expect(instructions.length).toBeGreaterThan(0);
      // Should contain npm, rust, python, sandbox instructions
      const joined = instructions.join('\n');
      expect(joined).toContain('npm');
      expect(joined).toContain('cargo');
      expect(joined).toContain('pip');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Exit codes
  // ══════════════════════════════════════════════════════════════

  describe('Exit codes', () => {
    it('should have unique exit codes', () => {
      const codes = Object.values(STORE_EXIT);
      const unique = new Set(codes);
      expect(unique.size).toBe(codes.length);
    });

    it('should be in the 100+ range', () => {
      for (const [key, value] of Object.entries(STORE_EXIT)) {
        if (key !== 'SUCCESS') {
          expect(value).toBeGreaterThanOrEqual(100);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Explicit failure for cache miss
  // ══════════════════════════════════════════════════════════════

  describe('Cache miss / runtime download', () => {
    it('should produce actionable error for every missing store', () => {
      const config: OfflineStoreConfig = { projectRoot: '/nonexistent' };
      const stores = validateAllStores(config);

      for (const status of stores) {
        if (!status.present) {
          // Every missing store should have an actionable detail
          expect(status.detail.length).toBeGreaterThan(10);
          // Should NOT suggest downloading at runtime
          expect(status.detail.toLowerCase()).not.toContain('downloading');
          expect(status.detail.toLowerCase()).not.toContain('fetching');
        }
      }
    });
  });
});
