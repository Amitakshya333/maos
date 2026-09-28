/**
 * F2-05: Package Industrial Assets Tests
 *
 * Tests:
 * - Allowlist: only matched files included
 * - Denylist: secrets, caches, weights, debug builds excluded
 * - Denylist overrides allowlist
 * - Profile config, Rust binary, TS source, scripts included
 * - .env, .pem, node_modules, .git, safetensors excluded
 * - Deterministic output (sorted, stable hash)
 * - Custom extra allowlist/denylist
 * - Allowlist review generation
 * - Non-existent project fails cleanly
 * - dist/ and demo/ opt-in behavior
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildPackageManifest,
  matchesAllowlist,
  matchesDenylist,
  generateAllowlistReview,
  INDUSTRIAL_ALLOWLIST,
  HARD_DENY_PATTERNS,
  PackageConfig,
} from '../src/industrial/package-assets';

const PROJECT_ROOT = path.resolve(__dirname, '..');

function baseConfig(): PackageConfig {
  return { projectRoot: PROJECT_ROOT };
}

describe('F2-05: Package Industrial Assets', () => {

  // ══════════════════════════════════════════════════════════════
  // Allowlist matching
  // ══════════════════════════════════════════════════════════════

  describe('Allowlist matching', () => {
    it('should match package.json', () => {
      const rule = matchesAllowlist('package.json', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('package-json');
    });

    it('should match profiles/industrial/maos.config.json', () => {
      const rule = matchesAllowlist('profiles/industrial/maos.config.json', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('profile-config');
    });

    it('should match src/industrial/preflight.ts', () => {
      const rule = matchesAllowlist('src/industrial/preflight.ts', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('ts-source');
    });

    it('should match scripts/industrial-preflight.ps1', () => {
      const rule = matchesAllowlist('scripts/industrial-preflight.ps1', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('lifecycle-scripts');
    });

    it('should match rust/Cargo.toml', () => {
      const rule = matchesAllowlist('rust/Cargo.toml', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('rust-cargo-toml');
    });

    it('should match rust/crates/maos-industrial-engine/src/main.rs', () => {
      const rule = matchesAllowlist('rust/crates/maos-industrial-engine/src/main.rs', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('rust-crate-sources');
    });

    it('should match rust/test.txt as preserved file', () => {
      const rule = matchesAllowlist('rust/test.txt', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('rust-test-txt');
    });

    it('should NOT match dist/ by default', () => {
      const rule = matchesAllowlist('dist/index.js', INDUSTRIAL_ALLOWLIST, false);
      expect(rule).toBeNull();
    });

    it('should match dist/ when opted in', () => {
      const rule = matchesAllowlist('dist/index.js', INDUSTRIAL_ALLOWLIST, true);
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('ts-dist');
    });

    it('should NOT match demo/ by default', () => {
      const rule = matchesAllowlist('demo/sample.csv', INDUSTRIAL_ALLOWLIST, false, false);
      expect(rule).toBeNull();
    });

    it('should match demo/ when opted in', () => {
      const rule = matchesAllowlist('demo/sample.csv', INDUSTRIAL_ALLOWLIST, false, true);
      expect(rule).not.toBeNull();
    });

    it('should NOT match random top-level files', () => {
      const rule = matchesAllowlist('debug_script.js', INDUSTRIAL_ALLOWLIST);
      expect(rule).toBeNull();
    });

    it('should match model-snapshot-manifest.json', () => {
      const rule = matchesAllowlist('model-snapshot-manifest.json', INDUSTRIAL_ALLOWLIST);
      expect(rule).not.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Denylist matching
  // ══════════════════════════════════════════════════════════════

  describe('Denylist matching', () => {
    it('should deny .env', () => {
      const result = matchesDenylist('.env');
      expect(result.denied).toBe(true);
      expect(result.reason).toContain('secret');
    });

    it('should deny .env.production', () => {
      const result = matchesDenylist('.env.production');
      expect(result.denied).toBe(true);
    });

    it('should deny .pem files', () => {
      const result = matchesDenylist('certs/server.pem');
      expect(result.denied).toBe(true);
      expect(result.reason).toContain('key');
    });

    it('should deny .safetensors (model weights)', () => {
      const result = matchesDenylist('models/model.safetensors');
      expect(result.denied).toBe(true);
      expect(result.reason).toContain('weight');
    });

    it('should deny .gguf (model weights)', () => {
      const result = matchesDenylist('models/model.gguf');
      expect(result.denied).toBe(true);
    });

    it('should deny node_modules', () => {
      const result = matchesDenylist('node_modules/chalk/index.js');
      expect(result.denied).toBe(true);
      expect(result.reason).toContain('npm');
    });

    it('should deny __pycache__', () => {
      const result = matchesDenylist('scripts/__pycache__/server.pyc');
      expect(result.denied).toBe(true);
    });

    it('should deny target/debug/', () => {
      const result = matchesDenylist('rust/target/debug/maos-engine.exe');
      expect(result.denied).toBe(true);
      expect(result.reason).toContain('debug');
    });

    it('should deny .tgz files outside the offline npm payload', () => {
      const result = matchesDenylist('maosorch-0.3.0.tgz');
      expect(result.denied).toBe(true);
    });

    it('should allow explicitly pinned model and wheel payload files', () => {
      expect(matchesDenylist('offline-stores/model-snapshot/revision/model.safetensors').denied).toBe(false);
      expect(matchesDenylist('offline-stores/python-wheels/torch-2.11.0.whl').denied).toBe(false);
      expect(matchesDenylist('offline-stores/npm/maosorch.tgz').denied).toBe(false);
      expect(matchesAllowlist('offline-stores/model-snapshot/revision/model.safetensors', INDUSTRIAL_ALLOWLIST)).not.toBeNull();
    });

    it('should deny .git/', () => {
      const result = matchesDenylist('.git/HEAD');
      expect(result.denied).toBe(true);
    });

    it('should deny debug scripts', () => {
      const result = matchesDenylist('debug_script.js');
      expect(result.denied).toBe(true);
    });

    it('should NOT deny normal source files', () => {
      const result = matchesDenylist('src/core/agent-runner.ts');
      expect(result.denied).toBe(false);
    });

    it('should NOT deny profile configs', () => {
      const result = matchesDenylist('profiles/industrial/maos.config.json');
      expect(result.denied).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Denylist overrides allowlist
  // ══════════════════════════════════════════════════════════════

  describe('Denylist overrides allowlist', () => {
    it('should deny a file even if it matches an allowlist prefix', () => {
      // Imagine someone puts a .env inside src/
      const allowRule = matchesAllowlist('src/.env', INDUSTRIAL_ALLOWLIST);
      // allowlist might not match .env extension, but even if it did:
      const denyResult = matchesDenylist('src/.env');
      expect(denyResult.denied).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Build package manifest
  // ══════════════════════════════════════════════════════════════

  describe('Build package manifest', () => {
    it('should produce a non-empty manifest for the project', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.totalSize).toBeGreaterThan(0);
      expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    }, 60_000);

    it('should include profile configs', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      const profiles = result.entries.filter(e =>
        e.relativePath.startsWith('profiles/'));
      expect(profiles.length).toBeGreaterThan(0);
    });

    it('should include TS source files', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      const tsSources = result.entries.filter(e =>
        e.relativePath.startsWith('src/') && e.relativePath.endsWith('.ts'));
      expect(tsSources.length).toBeGreaterThan(0);
    });

    it('should include Rust crate sources', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      const rustSources = result.entries.filter(e =>
        e.relativePath.startsWith('rust/crates/') && e.relativePath.endsWith('.rs'));
      expect(rustSources.length).toBeGreaterThan(0);
    });

    it('should deny secrets in denied list', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      // .env should be in denied list
      const envDenied = result.denied.find(d => d.path.includes('.env'));
      if (fs.existsSync(path.resolve(PROJECT_ROOT, '.env'))) {
        expect(envDenied).toBeDefined();
      }
    });

    it('should deny .tgz files', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      const tgzDenied = result.denied.filter(d => d.path.endsWith('.tgz'));
      // Project has .tgz files
      expect(tgzDenied.length).toBeGreaterThan(0);
    });

    it('should NOT include node_modules', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      const nmEntries = result.entries.filter(e =>
        e.relativePath.includes('node_modules'));
      expect(nmEntries.length).toBe(0);
    });

    it('should produce deterministic output', () => {
      const config = baseConfig();
      const r1 = buildPackageManifest(config);
      const r2 = buildPackageManifest(config);

      expect(r1.manifestHash).toBe(r2.manifestHash);
      expect(r1.totalEntries).toBe(r2.totalEntries);
    });

    it('should fail cleanly for non-existent project', () => {
      const config: PackageConfig = { projectRoot: '/nonexistent' };
      const result = buildPackageManifest(config);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should record allowRule for each entry', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);

      for (const entry of result.entries) {
        expect(entry.allowRule).toBeDefined();
        expect(entry.allowRule.length).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Custom extra allowlist/denylist
  // ══════════════════════════════════════════════════════════════

  describe('Custom extensions', () => {
    it('should support extra allowlist entries', () => {
      const config = baseConfig();
      config.extraAllowlist = ['HACKATHON_SUBMISSION.md'];
      const result = buildPackageManifest(config);

      const hackathon = result.entries.find(e =>
        e.relativePath === 'HACKATHON_SUBMISSION.md');
      expect(hackathon).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Allowlist review
  // ══════════════════════════════════════════════════════════════

  describe('Allowlist review', () => {
    it('should generate a human-readable review', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);
      const review = generateAllowlistReview(result);

      expect(review).toContain('Package Allowlist Review');
      expect(review).toContain('Total entries:');
      expect(review).toContain('Manifest hash:');
      expect(review).toContain('Included by Rule');
    });

    it('should include denied section when files are denied', () => {
      const config = baseConfig();
      const result = buildPackageManifest(config);
      const review = generateAllowlistReview(result);

      if (result.denied.length > 0) {
        expect(review).toContain('Denied');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Allowlist/denylist completeness
  // ══════════════════════════════════════════════════════════════

  describe('Rule completeness', () => {
    it('should have unique allowlist rule IDs', () => {
      const ids = INDUSTRIAL_ALLOWLIST.map(r => r.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('should have descriptions for all allowlist rules', () => {
      for (const rule of INDUSTRIAL_ALLOWLIST) {
        expect(rule.description.length).toBeGreaterThan(0);
      }
    });

    it('should have reasons for all denylist patterns', () => {
      for (const deny of HARD_DENY_PATTERNS) {
        expect(deny.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
