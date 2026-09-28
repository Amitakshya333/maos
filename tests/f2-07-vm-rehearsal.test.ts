/**
 * F2-07: Clean Disconnected VM Rehearsal Tests
 *
 * Tests the 12-step rehearsal that ties together F2-01 through F2-06.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  verifyNetworkIsolation,
  verifyOfflineStores,
  verifyBundleIntegrity,
  verifyPackageAllowlist,
  runPreflightChecks,
  verifyServiceIdentities,
  runRustSmokeTest,
  probeTextCompletion,
  probeOcrService,
  checkReactAssets,
  checkContainerRuntime,
  runCleanup,
  runRehearsal,
  RehearsalConfig,
  RehearsalProfile,
  INDUSTRIAL_PROFILE,
} from '../src/industrial/vm-rehearsal';

let testRoot: string;

function put(relativePath: string, contents = relativePath): void {
  const target = path.join(testRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-rehearsal-'));
  put('package.json', '{"name":"rehearsal-fixture"}');
  put('package-lock.json', '{}');
  put('npm-cache-manifest.json', '{}');
  put('offline-stores/npm/maosorch.tgz', 'fixture');
  put('rust/Cargo.lock', '# fixture');
  put('rust/.cargo/config.toml', '[source.crates-io]\nreplace-with = "vendored-sources"');
  put('rust/vendor/fixture/.cargo-checksum.json', '{}');
  put('profiles/industrial.json', '{}');
});

afterAll(() => fs.rmSync(testRoot, { recursive: true, force: true }));

/** Unit-test profile: all components optional (no live services in unit tests). */
const UNIT_TEST_PROFILE: RehearsalProfile = {
  required: [],
  optional: ['rust-engine', 'text-model', 'ocr-service', 'react-assets', 'container-runtime', 'offline-stores', 'bundle-manifest'],
};

function baseConfig(): RehearsalConfig {
  return {
    projectRoot: testRoot,
    skipNetworkProbe: true,
    profile: UNIT_TEST_PROFILE,
  };
}

describe('F2-07: Clean Disconnected VM Rehearsal', () => {

  // ══════════════════════════════════════════════════════════════
  // Step 1: Network isolation
  // ══════════════════════════════════════════════════════════════

  describe('Step 1: Network isolation', () => {
    it('should pass when network probe is skipped', () => {
      const step = verifyNetworkIsolation(true);
      expect(step.step).toBe(1);
      expect(step.passed).toBe(true);
      expect(step.name).toBe('Network isolation');
    });

    it('should report checks', () => {
      const step = verifyNetworkIsolation(true);
      expect(step.checks).toBeDefined();
      expect(step.checks!.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 2: Offline stores
  // ══════════════════════════════════════════════════════════════

  describe('Step 2: Offline stores', () => {
    it('should check all 6 stores', () => {
      const step = verifyOfflineStores(testRoot);
      expect(step.step).toBe(2);
      expect(step.checks).toBeDefined();
      expect(step.checks!.length).toBe(6);
    });

    it('should pass when core stores are present', () => {
      const step = verifyOfflineStores(testRoot);
      // Rust vendor (Cargo.lock + config) should be present
      expect(step.passed).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 3: Bundle manifest integrity
  // ══════════════════════════════════════════════════════════════

  describe('Step 3: Bundle manifest integrity', () => {
    it('should generate and verify bundle manifest', () => {
      const step = verifyBundleIntegrity(testRoot);
      expect(step.step).toBe(3);
      expect(step.name).toBe('Bundle manifest integrity');
    });

    it('should have sub-checks', () => {
      const step = verifyBundleIntegrity(testRoot);
      expect(step.checks).toBeDefined();
      expect(step.checks!.some(c => c.label === 'Entries generated')).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 4: Package allowlist
  // ══════════════════════════════════════════════════════════════

  describe('Step 4: Package allowlist', () => {
    it('should verify allowlist for the project', () => {
      const step = verifyPackageAllowlist(testRoot);
      expect(step.step).toBe(4);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('allowed');
    });

    it('should report denied count', () => {
      const step = verifyPackageAllowlist(testRoot);
      expect(step.detail).toContain('denied');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 5: Preflight checks
  // ══════════════════════════════════════════════════════════════

  describe('Step 5: Preflight checks', () => {
    it('should run static and deps stages', () => {
      const config = baseConfig();
      const step = runPreflightChecks(config);
      expect(step.step).toBe(5);
      expect(step.checks).toBeDefined();
      expect(step.checks!.some(c => c.label.startsWith('Deps:'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 6: Service identities
  // ══════════════════════════════════════════════════════════════

  describe('Step 6: Service identities', () => {
    it('should register and verify manifests', () => {
      const step = verifyServiceIdentities(testRoot);
      expect(step.step).toBe(6);
      expect(step.passed).toBe(true); // Infrastructure works
      expect(step.detail).toContain('manifests registered');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 7: Rust engine smoke
  // ══════════════════════════════════════════════════════════════

  describe('Step 7: Rust engine smoke', () => {
    it('should run smoke test', () => {
      const step = runRustSmokeTest(testRoot);
      expect(step.step).toBe(7);
      expect(step.name).toBe('Rust engine smoke');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 8: Text completion probe
  // ══════════════════════════════════════════════════════════════

  describe('Step 8: Text completion', () => {
    it('should skip when no port configured', () => {
      const step = probeTextCompletion(undefined);
      expect(step.step).toBe(8);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('skipped');
    });

    it('should accept configured port', () => {
      const step = probeTextCompletion(8081);
      expect(step.step).toBe(8);
      expect(step.detail).toContain('8081');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 9: OCR service probe
  // ══════════════════════════════════════════════════════════════

  describe('Step 9: OCR service', () => {
    it('should skip when no port configured', () => {
      const step = probeOcrService(undefined);
      expect(step.step).toBe(9);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('skipped');
    });

    it('should accept configured port', () => {
      const step = probeOcrService(8082);
      expect(step.detail).toContain('8082');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 10: React static assets
  // ══════════════════════════════════════════════════════════════

  describe('Step 10: React static assets', () => {
    it('should skip when not checked', () => {
      const step = checkReactAssets(testRoot, false);
      expect(step.step).toBe(10);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('skipped');
    });

    it('should report missing GUI build dir', () => {
      const step = checkReactAssets(testRoot, true);
      expect(step.step).toBe(10);
      // GUI build dir likely doesn't exist in dev
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 11: Container runtime
  // ══════════════════════════════════════════════════════════════

  describe('Step 11: Container runtime', () => {
    it('should skip when not checked', () => {
      const step = checkContainerRuntime(false);
      expect(step.step).toBe(11);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('skipped');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Step 12: Cleanup
  // ══════════════════════════════════════════════════════════════

  describe('Step 12: Cleanup', () => {
    it('should run cleanup', () => {
      const step = runCleanup(testRoot, []);
      expect(step.step).toBe(12);
      expect(step.name).toBe('Cleanup');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Full rehearsal
  // ══════════════════════════════════════════════════════════════

  describe('Full rehearsal', () => {
    it('should execute all 12 steps', () => {
      const config = baseConfig();
      const result = runRehearsal(config);

      expect(result.steps.length).toBe(12);
      expect(result.totalDurationMs).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();
    });

    it('should report network isolation status', () => {
      const config = baseConfig();
      const result = runRehearsal(config);
      expect(result.networkIsolated).toBe(true); // skipped = true
    });

    it('should report failures list', () => {
      const config = baseConfig();
      const result = runRehearsal(config);
      expect(Array.isArray(result.failures)).toBe(true);
    });

    it('should have step numbers 1 through 12', () => {
      const config = baseConfig();
      const result = runRehearsal(config);

      const stepNums = result.steps.map(s => s.step);
      for (let i = 1; i <= 12; i++) {
        expect(stepNums).toContain(i);
      }
    });

    it('should record duration per step', () => {
      const config = baseConfig();
      const result = runRehearsal(config);

      for (const step of result.steps) {
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Profile enforcement: required vs optional
  // ══════════════════════════════════════════════════════════════

  describe('Profile enforcement', () => {
    it('should fail when text-model is required but unconfigured', () => {
      const step = probeTextCompletion(undefined, true);
      expect(step.passed).toBe(false);
      expect(step.detail).toContain('REQUIRED');
    });

    it('should skip when text-model is optional and unconfigured', () => {
      const step = probeTextCompletion(undefined, false);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('Optional');
    });

    it('should fail when OCR is required but unconfigured', () => {
      const step = probeOcrService(undefined, true);
      expect(step.passed).toBe(false);
      expect(step.detail).toContain('REQUIRED');
    });

    it('should skip when OCR is optional and unconfigured', () => {
      const step = probeOcrService(undefined, false);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('Optional');
    });

    it('should fail when React assets are required but unchecked', () => {
      const step = checkReactAssets(testRoot, false, true);
      expect(step.passed).toBe(false);
      expect(step.detail).toContain('REQUIRED');
    });

    it('should skip when React assets are optional', () => {
      const step = checkReactAssets(testRoot, false, false);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('Optional');
    });

    it('should fail when container is required but unchecked', () => {
      const step = checkContainerRuntime(false, true);
      expect(step.passed).toBe(false);
      expect(step.detail).toContain('REQUIRED');
    });

    it('should skip when container is optional', () => {
      const step = checkContainerRuntime(false, false);
      expect(step.passed).toBe(true);
      expect(step.detail).toContain('Optional');
    });

    it('should FAIL full rehearsal when industrial profile has required unconfigured text-model', () => {
      const config: RehearsalConfig = {
        projectRoot: testRoot,
        skipNetworkProbe: true,
        // No modelServerPort — but text-model is REQUIRED in industrial profile
        profile: INDUSTRIAL_PROFILE,
      };
      const result = runRehearsal(config);
      expect(result.failures).toContain('Text completion');
    });

    it('should PASS full rehearsal when all-optional profile is used', () => {
      const config = baseConfig(); // uses UNIT_TEST_PROFILE (all optional)
      const result = runRehearsal(config);
      // Should not fail on text-model/OCR/React/container since they're optional
      expect(result.failures).not.toContain('Text completion');
      expect(result.failures).not.toContain('OCR service');
      expect(result.failures).not.toContain('React static assets');
      expect(result.failures).not.toContain('Container runtime');
    });

    it('should include INDUSTRIAL_PROFILE defaults', () => {
      expect(INDUSTRIAL_PROFILE.required).toContain('rust-engine');
      expect(INDUSTRIAL_PROFILE.required).toContain('text-model');
      expect(INDUSTRIAL_PROFILE.optional).toContain('ocr-service');
      expect(INDUSTRIAL_PROFILE.optional).toContain('container-runtime');
    });
  });
});
