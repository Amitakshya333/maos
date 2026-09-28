/** F2-03 bundle manifest tests using a small isolated project fixture. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FullBundleManifest,
  ManifestGeneratorConfig,
  generateBundleManifest,
  hashFile,
  hashString,
  readManifest,
  verifyBundleManifest,
  writeManifest,
} from '../src/industrial/bundle-manifest';

let projectRoot: string;
const engineName = process.platform === 'win32' ? 'maos-engine.exe' : 'maos-engine';

function put(relativePath: string, contents = relativePath): void {
  const target = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function baseConfig(overrides: Partial<ManifestGeneratorConfig> = {}): ManifestGeneratorConfig {
  return {
    projectRoot,
    protocolVersion: '1.0',
    engineVersion: '0.1.0',
    ...overrides,
  };
}

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-manifest-'));
  put('package.json', '{"name":"fixture"}');
  put('package-lock.json', '{}');
  put('tsconfig.json', '{}');
  put('profiles/industrial.json', '{}');
  put('scripts/install.ps1', 'Write-Output ok');
  put('scripts/server.py', 'print("ok")');
  put('schemas/run.schema.json', '{}');
  put('templates/report.hbs', 'report');
  put('models/model-manifest.json', '{}');
  put('model-snapshot-manifest.json', '{"revision":"pinned"}');
  put('assets/logo.svg', '<svg/>');
  put('dist/index.js', 'console.log("dist")');
  put(`rust/target/release/${engineName}`, 'release');
  put('rust/target/.rustc_info.json', '{"volatile":true}');
  put('rust/target/release/build/dependency/output', 'volatile');

  // Files which must never appear.
  put('node_modules/dependency/index.js', 'dependency');
  put('.git/config', 'git');
  put('.env', 'SECRET=x');
  put('__pycache__/server.pyc', 'cache');
  put('rust/target/debug/maos-engine.exe', 'debug');
  put('dist/release/maos-industrial-bundle.zip', 'recursive-output');
});

afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

describe('F2-03: Bundle Manifest Generator', () => {
  describe('deterministic generation', () => {
    it('sorts and normalizes paths', () => {
      const manifest = generateBundleManifest(baseConfig());
      expect(manifest.entries.length).toBeGreaterThan(0);
      const paths = manifest.entries.map(entry => entry.path);
      expect(paths.every(value => !value.includes('\\'))).toBe(true);
      expect(paths).toEqual([...paths].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    });

    it('produces identical entries on repeated calls', () => {
      const first = generateBundleManifest(baseConfig());
      const second = generateBundleManifest(baseConfig());
      expect(second.entries).toEqual(first.entries);
      expect(second.buildIdentity.entriesHash).toBe(first.buildIdentity.entriesHash);
      expect(second.totalSize).toBe(first.totalSize);
    });
  });

  describe('category detection', () => {
    const expected: Array<[string, string]> = [
      ['package.json', 'config'],
      ['tsconfig.json', 'config'],
      ['profiles/industrial.json', 'config'],
      ['scripts/install.ps1', 'script'],
      ['scripts/server.py', 'python'],
      ['schemas/run.schema.json', 'schema'],
      ['templates/report.hbs', 'template'],
      ['models/model-manifest.json', 'model-snapshot'],
      ['assets/logo.svg', 'asset'],
      [`rust/target/release/${engineName}`, 'rust-binary'],
    ];

    it.each(expected)('categorizes %s as %s', (file, category) => {
      const entry = generateBundleManifest(baseConfig()).entries.find(candidate => candidate.path === file);
      expect(entry?.category).toBe(category);
    });
  });

  describe('exclusions and dist behavior', () => {
    it('excludes secrets, caches, source control, debug output, and release archives', () => {
      const paths = generateBundleManifest(baseConfig({ includeDist: true })).entries.map(entry => entry.path);
      expect(paths.some(value => value.includes('node_modules'))).toBe(false);
      expect(paths.some(value => value.startsWith('.git/'))).toBe(false);
      expect(paths.some(value => path.basename(value).startsWith('.env'))).toBe(false);
      expect(paths.some(value => value.includes('__pycache__'))).toBe(false);
      expect(paths.some(value => value.includes('target/debug/'))).toBe(false);
      expect(paths.some(value => value === 'rust/target/.rustc_info.json')).toBe(false);
      expect(paths.some(value => value.startsWith('rust/target/release/build/'))).toBe(false);
      expect(paths.some(value => value.startsWith('dist/release/'))).toBe(false);
    });

    it('excludes dist by default and includes it explicitly', () => {
      expect(generateBundleManifest(baseConfig()).entries.some(entry => entry.path === 'dist/index.js')).toBe(false);
      expect(generateBundleManifest(baseConfig({ includeDist: true })).entries.some(entry => entry.path === 'dist/index.js')).toBe(true);
    });
  });

  describe('build identity', () => {
    it('records platform, versions, totals, timestamp, and entries hash', () => {
      const manifest = generateBundleManifest(baseConfig());
      expect(manifest.buildIdentity.platform).toBe(process.platform);
      expect(manifest.buildIdentity.arch).toBe(process.arch);
      expect(manifest.buildIdentity.nodeVersion).toBe(process.versions.node);
      expect(new Date(manifest.buildIdentity.generatedAt).getTime()).toBeGreaterThan(0);
      expect(manifest.protocolVersion).toBe('1.0');
      expect(manifest.engineVersion).toBe('0.1.0');
      expect(manifest.totalEntries).toBe(manifest.entries.length);
      expect(manifest.totalSize).toBe(manifest.entries.reduce((sum, entry) => sum + entry.size, 0));
      expect(manifest.buildIdentity.entriesHash).toBe(hashString(JSON.stringify(manifest.entries)));
      expect(manifest.modelManifestHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('verification', () => {
    it('passes a fresh manifest', () => {
      const result = verifyBundleManifest(generateBundleManifest(baseConfig()), projectRoot);
      expect(result).toMatchObject({ valid: true, missing: [], tampered: [], sizeMismatch: [] });
    });

    it('detects missing files', () => {
      const manifest = generateBundleManifest(baseConfig());
      manifest.entries.push({ path: 'missing.dat', size: 1, sha256: 'a', category: 'asset' });
      expect(verifyBundleManifest(manifest, projectRoot).missing).toContain('missing.dat');
    });

    it('detects bad hashes without trusting the generation cache', () => {
      const manifest = generateBundleManifest(baseConfig());
      const entry = manifest.entries.find(candidate => candidate.path === 'package.json')!;
      entry.sha256 = '0'.repeat(64);
      const result = verifyBundleManifest(manifest, projectRoot);
      expect(result.valid).toBe(false);
      expect(result.tampered.some(value => value.startsWith('package.json:'))).toBe(true);
    });

    it('detects size mismatches', () => {
      const manifest = generateBundleManifest(baseConfig());
      manifest.entries.find(candidate => candidate.path === 'package.json')!.size = 1;
      expect(verifyBundleManifest(manifest, projectRoot).sizeMismatch.length).toBe(1);
    });

    it('detects unlisted release executables', () => {
      const manifest = generateBundleManifest(baseConfig());
      const withoutEngine: FullBundleManifest = {
        ...manifest,
        entries: manifest.entries.filter(entry => entry.category !== 'rust-binary'),
      };
      expect(verifyBundleManifest(withoutEngine, projectRoot, true).unlisted).toContain(
        `rust/target/release/${engineName}`,
      );
    });

    it('forced generation rehashes files instead of trusting stat cache', () => {
      const target = path.join(projectRoot, 'cache-test.bin');
      const fixedTime = new Date('2020-01-01T00:00:00.000Z');
      fs.writeFileSync(target, 'AAAA');
      fs.utimesSync(target, fixedTime, fixedTime);
      const cachedHash = hashFile(target);
      fs.writeFileSync(target, 'BBBB');
      fs.utimesSync(target, fixedTime, fixedTime);

      expect(hashFile(target)).toBe(cachedHash);
      const forced = generateBundleManifest(baseConfig({ forceRehash: true })).entries.find(
        entry => entry.path === 'cache-test.bin',
      )!;
      expect(forced.sha256).toBe(crypto.createHash('sha256').update('BBBB').digest('hex'));
    });
  });

  describe('manifest I/O and hash utilities', () => {
    it('round-trips a manifest', () => {
      const manifest = generateBundleManifest(baseConfig());
      const output = path.join(projectRoot, '.maos', 'manifest.json');
      writeManifest(manifest, output);
      expect(readManifest(output)).toEqual(manifest);
    });

    it('computes stable SHA-256 values', () => {
      expect(hashFile(path.join(projectRoot, 'package.json'))).toMatch(/^[0-9a-f]{64}$/);
      expect(hashString('test data')).toBe(hashString('test data'));
      expect(hashString('input A')).not.toBe(hashString('input B'));
    });
  });

  it('rejects a missing project root', () => {
    expect(() => generateBundleManifest({ projectRoot: path.join(projectRoot, 'missing') })).toThrow('does not exist');
  });
});
