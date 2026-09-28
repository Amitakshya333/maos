/**
 * Tests for F2 Industrial Bundle & Rehearsal Commands
 *
 * Covers:
 *   - industrial bundle prepare
 *   - industrial bundle verify (all failure conditions)
 *   - industrial rehearsal (network check, lifecycle, negative tests, orphans)
 *   - industrial evidence verify (G2 blocker evaluation)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import {
  bundleVerify,
  materializeOfflineStores,
  runLocalModelSmoke,
  runRehearsalWorkflow,
  verifyRehearsalEvidence,
} from '../src/industrial/bundle-cli';
import type { ServiceConfig } from '../src/industrial/service-startup';
import { hashFile } from '../src/industrial/bundle-manifest';
import { getStorePaths } from '../src/industrial/offline-stores';
import { verifyNetworkIsolation } from '../src/industrial/vm-rehearsal';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('F2 Industrial Commands: Bundle & Rehearsal Workflow', () => {
  const testTempDir = path.join(PROJECT_ROOT, '.maos', 'test-bundle-cli-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(testTempDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Bundle Verification Failure Conditions
  // ══════════════════════════════════════════════════════════════

  describe('bundle verify failure conditions', () => {
    it('should fail when bundle manifest is missing', () => {
      const result = bundleVerify({
        projectRoot: testTempDir,
        manifestPath: path.join(testTempDir, 'nonexistent-manifest.json'),
      });

      expect(result.valid).toBe(false);
      expect(result.failures[0]).toContain('not found');
      expect(result.missingFiles).toContain('bundle-manifest.json');
    });

    it('should fail when required offline stores are missing', () => {
      // Create a dummy manifest
      const dummyManifest = {
        version: '1.0',
        protocolVersion: '1.0',
        engineVersion: '0.1.0',
        entries: [],
        buildIdentity: {
          platform: 'win32',
          arch: 'x64',
          nodeVersion: process.version,
          generatedAt: new Date().toISOString(),
          entriesHash: 'dummy',
        },
        totalEntries: 0,
        totalSize: 0,
      };

      const manifestPath = path.join(testTempDir, 'bundle-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(dummyManifest, null, 2));

      const result = bundleVerify({
        projectRoot: testTempDir,
        manifestPath,
      });

      expect(result.valid).toBe(false);
      expect(result.missingStores.length).toBeGreaterThan(0);
    });

    it('should detect and report tampered files', () => {
      const testFile = path.join(testTempDir, 'test-asset.txt');
      fs.writeFileSync(testFile, 'original content');
      const origHash = hashFile(testFile);

      // Manifest with original hash
      const manifest = {
        version: '1.0',
        protocolVersion: '1.0',
        engineVersion: '0.1.0',
        entries: [
          {
            path: 'test-asset.txt',
            size: 16,
            sha256: origHash,
            category: 'asset' as const,
          },
        ],
        buildIdentity: {
          platform: 'win32',
          arch: 'x64',
          nodeVersion: process.version,
          generatedAt: new Date().toISOString(),
          entriesHash: 'dummy',
        },
        totalEntries: 1,
        totalSize: 16,
      };

      const manifestPath = path.join(testTempDir, 'bundle-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Tamper the file
      fs.writeFileSync(testFile, 'TAMPERED content');

      const result = bundleVerify({
        projectRoot: testTempDir,
        manifestPath,
      });

      expect(result.valid).toBe(false);
      expect(result.tamperedFiles.some(f => f.includes('test-asset.txt'))).toBe(true);
    });

    it('should detect missing files declared in manifest', () => {
      const manifest = {
        version: '1.0',
        protocolVersion: '1.0',
        engineVersion: '0.1.0',
        entries: [
          {
            path: 'ghost-file.txt',
            size: 100,
            sha256: 'a'.repeat(64),
            category: 'config' as const,
          },
        ],
        buildIdentity: {
          platform: 'win32',
          arch: 'x64',
          nodeVersion: process.version,
          generatedAt: new Date().toISOString(),
          entriesHash: 'dummy',
        },
        totalEntries: 1,
        totalSize: 100,
      };

      const manifestPath = path.join(testTempDir, 'bundle-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = bundleVerify({
        projectRoot: testTempDir,
        manifestPath,
      });

      expect(result.valid).toBe(false);
      expect(result.missingFiles).toContain('ghost-file.txt');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Materialize Offline Stores
  // ══════════════════════════════════════════════════════════════

  describe('materializeOfflineStores', () => {
    it('should materialize store directories in a project', () => {
      const logs = materializeOfflineStores(testTempDir);
      const paths = getStorePaths(testTempDir);

      expect(fs.existsSync(paths.npmCache)).toBe(true);
      expect(fs.existsSync(paths.pythonWheels)).toBe(true);
      expect(fs.existsSync(paths.tesseract)).toBe(true);
      expect(fs.existsSync(paths.sandboxImage)).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
    }, 15000);
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Rehearsal Workflow
  // ══════════════════════════════════════════════════════════════

  describe('runRehearsalWorkflow', () => {
    it('should fail when network is not disabled and allowNetwork is false', async ({ skip }) => {
      // This is an online-host rejection test. An offline runner should not
      // start a full disconnected rehearsal as a side effect of this unit test.
      if (verifyNetworkIsolation(false).passed) skip();

      const reportPath = path.join(testTempDir, 'rehearsal-report.json');

      const result = await runRehearsalWorkflow({
        projectRoot: PROJECT_ROOT,
        allowNetwork: false,
        reportPath,
      });

      // On a connected dev machine without air-gapping, this MUST fail
      if (!result.networkIsolated) {
        expect(result.passed).toBe(false);
        expect(result.failures.some(f => f.includes('NETWORK_NOT_DISABLED'))).toBe(true);
      }
      expect(fs.existsSync(reportPath)).toBe(true);
    }, 120_000);

    it('should exercise the real local HTTP smoke contract without loading a GPU model in unit tests', async () => {
      const server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health') {
          response.end(JSON.stringify({
            status: 'ok', model: 'qwen2.5-3b-instruct-local',
            revision: 'test-revision', offline: true,
          }));
          return;
        }
        if (request.url === '/v1/models') {
          response.end(JSON.stringify({
            object: 'list', data: [{ id: 'qwen2.5-3b-instruct-local' }],
          }));
          return;
        }
        if (request.url === '/v1/chat/completions') {
          response.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'LOCAL_OK' } }],
          }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as http.AddressInfo).port;
      const config: ServiceConfig = {
        id: 'text-model', executablePath: __filename, executableHash: '',
        host: '127.0.0.1', port, args: [], env: {},
        model: { modelPath: PROJECT_ROOT, modelName: 'qwen2.5-3b-instruct-local', modelRevision: 'test-revision', device: 'cpu' },
      };
      try {
        const result = await runLocalModelSmoke(config);
        expect(result.passed).toBe(true);
        expect(result.protocol).toBe('openai-compatible-http');
        expect(result.completion?.status).toBe(200);
        expect(result.completion?.contentExact).toBe(true);
        expect(result.completion?.responseHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 15_000);

    it('should record a failed HTTP completion rather than treating model hashes as inference', async () => {
      const server = http.createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', model: 'qwen2.5-3b-instruct-local', revision: 'test-revision' }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as http.AddressInfo).port;
      const config: ServiceConfig = {
        id: 'text-model', executablePath: __filename, executableHash: '',
        host: '127.0.0.1', port, args: [], env: {},
        model: { modelPath: PROJECT_ROOT, modelName: 'qwen2.5-3b-instruct-local', modelRevision: 'test-revision', device: 'cpu' },
      };
      try {
        const result = await runLocalModelSmoke(config);
        expect(result.passed).toBe(false);
        expect(result.completion).toBeUndefined();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 15_000);
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Evidence Verification
  // ══════════════════════════════════════════════════════════════

  describe('verifyRehearsalEvidence', () => {
    it('should fail when evidence file does not exist', () => {
      const result = verifyRehearsalEvidence(path.join(testTempDir, 'missing.json'));
      expect(result.valid).toBe(false);
      expect(result.g2Ready).toBe(false);
      expect(result.blockers[0]).toContain('not found');
    });

    it('should identify blockers when rehearsal was run on a connected machine', () => {
      const dummyEvidence = {
        passed: false,
        machineIdentity: {
          hostname: 'DEV-MACHINE',
          username: 'developer',
          platform: 'win32',
          osRelease: '10.0.26200',
          architecture: 'x64',
          nodeVersion: 'v24.11.0',
        },
        networkIsolated: false, // Connected!
        emptyDeveloperCaches: false, // Polluted caches!
        bundleVerified: true,
        storesVerified: false, // Missing stores!
        servicesStarted: true,
        healthPassed: true,
        smokePassed: true,
        lifecyclePassed: true,
        idempotencyPassed: true,
        negativeTestsPassed: true,
        zeroOrphans: true,
        failures: ['NETWORK_NOT_DISABLED'],
      };

      const evidencePath = path.join(testTempDir, 'dev-evidence.json');
      fs.writeFileSync(evidencePath, JSON.stringify(dummyEvidence, null, 2));

      const result = verifyRehearsalEvidence(evidencePath);

      expect(result.valid).toBe(true);
      expect(result.g2Ready).toBe(false);
      expect(result.blockers.some(b => b.includes('Network isolation'))).toBe(true);
      expect(result.blockers.some(b => b.includes('Developer caches'))).toBe(true);
      expect(result.blockers.some(b => b.includes('Offline stores'))).toBe(true);
      expect(result.summary).toContain('G2 BLOCKED');
    });

    it('should report g2Ready true only when all criteria are fully satisfied (with rawOutputs)', () => {
      const perfectEvidence = {
        passed: true,
        machineIdentity: {
          hostname: 'CLEAN-VM',
          username: 'operator',
          platform: 'win32',
          osRelease: '10.0.26200',
          architecture: 'x64',
          nodeVersion: 'v24.11.0',
        },
        networkIsolated: true,
        emptyDeveloperCaches: true,
        bundleVerified: true,
        storesVerified: true,
        servicesStarted: true,
        healthPassed: true,
        smokePassed: true,
        lifecyclePassed: true,
        idempotencyPassed: true,
        negativeTestsPassed: true,
        zeroOrphans: true,
        failures: [],
        rawOutputs: {
          bundleVerification: {
            valid: true,
            manifestCheck: true,
            debugBinaries: [],
            missingFiles: [],
            tamperedFiles: [],
            failures: [],
            details: { verificationDetails: 'All files verified' },
          },
          offlineStores: {
            ready: true,
            stores: [
              { store: 'python-wheels', present: true, valid: true, entryCount: 42, totalSizeBytes: 5000000000 },
              { store: 'model-snapshot', present: true, valid: true, entryCount: 9, totalSizeBytes: 6183451098 },
            ],
            missingStores: [],
            invalidStores: [],
          },
          modelSnapshotHashes: { valid: true, checked: 9, mismatched: [] },
          lifecycleStart: {
            success: true,
            detail: {
              ownedServices: [
                { id: 'rust-engine', pid: 1234 },
                { id: 'text-model', pid: 5678 },
              ],
            },
          },
          smokeResults: {
            healthResp: { operation: 'health', version: '1.0' },
            evalResp: { operation: 'evaluate', version: '1.0' },
            textCompletion: {
              passed: true,
              protocol: 'openai-compatible-http',
              endpoint: 'http://127.0.0.1:8190',
              modelId: 'qwen2.5-3b-instruct-local',
              revision: 'test-revision',
              completion: {
                status: 200,
                latencyMs: 10,
                responseHash: 'a'.repeat(64),
                contentExact: true,
              },
              detail: 'completion returned',
            },
          },
          negativeTests: {
            failedOnMissingModel: true,
            rehearsalFailures: ['Text completion'],
          },
        },
      };

      const evidencePath = path.join(testTempDir, 'clean-vm-evidence.json');
      fs.writeFileSync(evidencePath, JSON.stringify(perfectEvidence, null, 2));

      const result = verifyRehearsalEvidence(evidencePath);

      expect(result.valid).toBe(true);
      expect(result.g2Ready).toBe(true);
      expect(result.blockers.length).toBe(0);
      expect(result.summary).toContain('All G2 clean disconnected rehearsal criteria satisfied');
    });

    it('should catch contradictory evidence (top-level true but sub-fields fail)', () => {
      // This reproduces the exact contradictions found in the rejected G2-rehearsal.json
      const contradictoryEvidence = {
        passed: true,
        machineIdentity: { hostname: 'HIDEZX', osRelease: '10.0.26200' },
        networkIsolated: true,
        emptyDeveloperCaches: true,
        bundleVerified: true, // <-- top-level says true
        storesVerified: true,
        servicesStarted: true,
        healthPassed: true,
        smokePassed: true, // <-- but text completion failed
        lifecyclePassed: true,
        idempotencyPassed: true,
        negativeTestsPassed: true,
        zeroOrphans: true,
        failures: [],
        rawOutputs: {
          bundleVerification: {
            valid: true,
            manifestCheck: false, // <-- CONTRADICTION: manifestCheck is false
            debugBinaries: ['C:\\maos\\rust\\target\\debug\\maos-engine.exe'], // <-- debug binary present
            missingFiles: [],
            tamperedFiles: [],
            failures: [],
            details: { verificationDetails: 'Size mismatch: 3 files' }, // <-- size mismatches
          },
          offlineStores: {
            stores: [
              { store: 'python-wheels', present: true, valid: true, entryCount: 1, totalSizeBytes: 45654 }, // <-- only 1 wheel
              { store: 'model-snapshot', present: true, valid: true, entryCount: 9, totalSizeBytes: 6183451098 },
            ],
            missingStores: [],
            invalidStores: [],
          },
          lifecycleStart: {
            detail: {
              ownedServices: [
                { id: 'rust-engine', pid: 30964 }, // <-- text-model missing
              ],
            },
          },
          smokeResults: {
            healthResp: { operation: 'health' },
            evalResp: { operation: 'evaluate' },
            // textCompletion missing
          },
          negativeTests: {
            failedOnMissingModel: true,
            rehearsalFailures: ['Text completion'],
          },
        },
      };

      const evidencePath = path.join(testTempDir, 'contradictory-evidence.json');
      fs.writeFileSync(evidencePath, JSON.stringify(contradictoryEvidence, null, 2));

      const result = verifyRehearsalEvidence(evidencePath);

      expect(result.valid).toBe(true); // File is valid JSON
      expect(result.g2Ready).toBe(false); // Must NOT be g2Ready
      expect(result.blockers.length).toBeGreaterThanOrEqual(4); // At least 4 contradictions

      // Check specific blockers caught
      expect(result.blockers.some(b => b.includes('manifestCheck'))).toBe(true);
      expect(result.blockers.some(b => b.includes('Debug binaries') || b.includes('debug'))).toBe(true);
      expect(result.blockers.some(b => b.includes('mismatch'))).toBe(true);
      expect(result.blockers.some(b => b.includes('text-model'))).toBe(true);
      expect(result.blockers.some(b => b.includes('wheelhouse') || b.includes('wheel'))).toBe(true);
      expect(result.blockers.some(b => b.includes('Text completion'))).toBe(true);
    });
  });

  describe('bundleVerify strict failure conditions', () => {
    it('should fail when debug binaries exist in target/debug', () => {
      // Create a minimal setup with debug binary
      const debugDir = path.join(testTempDir, 'rust', 'target', 'debug');
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, 'maos-engine.exe'), 'FAKE_DEBUG_BINARY');

      // Create a valid manifest
      const manifest = {
        version: '1.0',
        protocolVersion: '1.0',
        engineVersion: '0.1.0',
        entries: [],
        buildIdentity: {
          platform: 'win32',
          arch: 'x64',
          nodeVersion: process.version,
          generatedAt: new Date().toISOString(),
          entriesHash: 'dummy',
        },
        totalEntries: 0,
        totalSize: 0,
      };
      const manifestPath = path.join(testTempDir, 'bundle-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = bundleVerify({ projectRoot: testTempDir, manifestPath });

      expect(result.valid).toBe(false);
      expect(result.debugBinaries.length).toBeGreaterThan(0);
      expect(result.failures.some(f => f.includes('Debug binaries') || f.includes('debug'))).toBe(true);
    });
  });
});
