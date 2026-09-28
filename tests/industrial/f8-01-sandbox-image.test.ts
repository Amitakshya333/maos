/**
 * MAOS Industrial — Pinned Sandbox Image Test Suite (F8-01)
 *
 * Exhaustively validates:
 * 1. Domain Types, Pure Validators & Canonical Manifest:
 *    - ALL_SANDBOX_ERROR_CODES completeness
 *    - FROZEN_SANDBOX_POLICY, FROZEN_APPROVED_PACKAGES, ALLOWED_STANDARD_MODULES
 *    - validateSandboxManifest parsing, bounds checking, and canonical hashing
 * 2. Mandatory Fail-Closed Rejection Behavior:
 *    - IMAGE_DIGEST_MISMATCH: digest mismatch against pinned manifest
 *    - SANDBOX_IMAGE_MISSING: missing manifest or offline archive
 *    - UNAPPROVED_PACKAGE_DETECTED: unexpected/unapproved packages
 *    - RUNTIME_INSTALL_FORBIDDEN: pip, apt, conda, curl, wget runtime installs
 *    - MALFORMED_SANDBOX_MANIFEST: malformed or incomplete metadata
 *    - ROOT_EXECUTION_FORBIDDEN: root user (UID 0) execution attempt
 *    - HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL: host execute_python bypass attempt
 *    - SANDBOX_MANIFEST_TAMPERED: hash mismatch / tampered contents
 *    - NETWORK_ACCESS_FORBIDDEN: socket, urllib, requests, httpx imports
 * 3. Container Definition & Offline Assets:
 *    - industrial/container/Dockerfile inspection (UID 10001, pip stripped, read-only rootfs)
 *    - industrial/container/requirements.txt (exact frozen versions)
 *    - industrial/container/smoke-test.py (non-root check, approved imports, arithmetic)
 *    - industrial/container/build-image.sh and verify-image.sh
 * 4. Static Script Safety Analyzer (AST/token analysis):
 *    - Rejects network sockets, HTTP clients, and package installation
 *    - Allows safe numeric and statistical scripts
 * 5. SandboxImageService & ServiceContainer Integration:
 *    - Authoritative manifest loading and disk verification
 *    - Unified fail-closed execution gateway
 * 6. Gate Preconditions & Canary Hash:
 *    - Preserves canary rust/test.txt SHA-256 hash verbatim
 *    - Verifies Gate G5 CONDITIONAL, G6 PASSED, G7 PASSED
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  SANDBOX_ERROR_CODES,
  ALL_SANDBOX_ERROR_CODES,
  SandboxError,
  SandboxImageManifest,
  FROZEN_SANDBOX_POLICY,
  FROZEN_APPROVED_PACKAGES,
  ALLOWED_STANDARD_MODULES,
  FORBIDDEN_IMPORT_MODULES,
  FORBIDDEN_RUNTIME_COMMANDS,
  validateSandboxManifest,
  assertImageDigestMatch,
  assertNonRootExecution,
  assertApprovedPackagesOnly,
  assertNoRuntimeInstall,
  assertIndustrialNoHostExecutor,
  inspectScriptForSandboxViolations,
  computeSandboxManifestHash,
  validateDockerArchiveStructure,
  parseTarArchiveEntries,
} from '../../src/domain/sandbox';
import { validateSandboxManifest as validatorValidateManifest } from '../../src/domain/validators';
import { SandboxImageService } from '../../src/service/sandbox-image-service';
import { createServiceContainer, ServiceContainer } from '../../src/service';

function computeSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('F8-01: Build the Pinned Sandbox Image', () => {
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  let tempDir: string;
  let services: ServiceContainer;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-f8-01-test-'));

    // Create minimal required layout in tempDir
    fs.mkdirSync(path.join(tempDir, 'industrial', 'container'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'offline-stores', 'sandbox-image'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.maos'), { recursive: true });

    // Copy live container assets to tempDir for service testing
    const liveContainerDir = path.join(PROJECT_ROOT, 'industrial', 'container');
    if (fs.existsSync(liveContainerDir)) {
      for (const f of fs.readdirSync(liveContainerDir)) {
        const srcPath = path.join(liveContainerDir, f);
        if (fs.statSync(srcPath).isFile()) {
          fs.copyFileSync(srcPath, path.join(tempDir, 'industrial', 'container', f));
        }
      }
    }

    // Copy live or build genuine POSIX ustar Docker archive in tempDir
    const liveArchive = path.join(PROJECT_ROOT, 'offline-stores', 'sandbox-image', 'image.tar');
    const destArchive = path.join(tempDir, 'offline-stores', 'sandbox-image', 'image.tar');
    if (fs.existsSync(liveArchive) && fs.statSync(liveArchive).size >= 1024) {
      try {
        fs.linkSync(liveArchive, destArchive);
      } catch {
        fs.copyFileSync(liveArchive, destArchive);
      }
    } else {
      const { buildDockerArchive } = require('../../scripts/generate-sandbox-archive');
      buildDockerArchive(destArchive);
    }

    services = createServiceContainer(tempDir);
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 1: Domain Schemas, Pure Types & Manifest Validation
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 1: Domain Schemas, Pure Types & Manifest Validation', () => {
    it('verifies ALL_SANDBOX_ERROR_CODES completeness', () => {
      expect(ALL_SANDBOX_ERROR_CODES).toContain('IMAGE_DIGEST_MISMATCH');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('SANDBOX_IMAGE_MISSING');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('UNAPPROVED_PACKAGE_DETECTED');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('RUNTIME_INSTALL_FORBIDDEN');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('MALFORMED_SANDBOX_MANIFEST');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('ROOT_EXECUTION_FORBIDDEN');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('SANDBOX_MANIFEST_TAMPERED');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('NETWORK_ACCESS_FORBIDDEN');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('INDEPENDENT_DIGEST_REQUIRED');
      expect(ALL_SANDBOX_ERROR_CODES).toContain('INVALID_DOCKER_ARCHIVE');
      expect(ALL_SANDBOX_ERROR_CODES.length).toBe(11);
    });

    it('verifies FROZEN_SANDBOX_POLICY enforces all mandatory controls', () => {
      expect(FROZEN_SANDBOX_POLICY.nonRootRequired).toBe(true);
      expect(FROZEN_SANDBOX_POLICY.expectedUid).toBe(10001);
      expect(FROZEN_SANDBOX_POLICY.readOnlyRootfs).toBe(true);
      expect(FROZEN_SANDBOX_POLICY.networkMode).toBe('none');
      expect(FROZEN_SANDBOX_POLICY.dropAllCapabilities).toBe(true);
      expect(FROZEN_SANDBOX_POLICY.noNewPrivileges).toBe(true);
      expect(FROZEN_SANDBOX_POLICY.prohibitRuntimeInstall).toBe(true);
      expect(FROZEN_SANDBOX_POLICY.allowlistPackagesOnly).toBe(true);
    });

    it('verifies FROZEN_APPROVED_PACKAGES contains required scientific packages', () => {
      const names = FROZEN_APPROVED_PACKAGES.map((p) => p.name);
      expect(names).toContain('numpy');
      expect(names).toContain('pandas');
      expect(names).toContain('scipy');
      expect(names).toContain('sympy');
      expect(names).toContain('matplotlib');
      expect(names).toContain('pytest');

      for (const pkg of FROZEN_APPROVED_PACKAGES) {
        expect(pkg.version).toBeTruthy();
        expect(pkg.importName).toBeTruthy();
        expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/i);
      }
    });

    it('validates canonical sandbox-manifest.json from repository', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'industrial', 'container', 'sandbox-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const res = validateSandboxManifest(raw);

      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.manifest).toBeDefined();

      const m = res.manifest!;
      expect(m.schemaVersion).toBe(1);
      expect(m.imageName).toBe('maos-sandbox-runner');
      expect(m.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/i);
      expect(m.user.uid).toBe(10001);
      expect(m.user.isRoot).toBe(false);
      expect(m.network).toBe('none');
      expect(m.capabilities.dropAll).toBe(true);
      expect(m.capabilities.noNewPrivileges).toBe(true);
      expect(m.capabilities.readOnlyRootfs).toBe(true);
      expect(m.approvedPackages.length).toBeGreaterThanOrEqual(5);

      // Re-export in domain/validators.ts works identically
      const validatorRes = validatorValidateManifest(raw);
      expect(validatorRes.valid).toBe(true);
    });

    it('computes deterministic manifestHash and detects modifications', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'industrial', 'container', 'sandbox-manifest.json');
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      const hash1 = computeSandboxManifestHash(raw);
      const hash2 = computeSandboxManifestHash(raw);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(raw.manifestHash);

      // Modifying any field alters the computed hash
      const tampered = { ...raw, pythonVersion: '3.12.0' };
      const tamperedHash = computeSandboxManifestHash(tampered);
      expect(tamperedHash).not.toBe(hash1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 2: Mandatory Fail-Closed Rejection Behavior
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 2: Mandatory Fail-Closed Rejection Behavior', () => {
    it('rejects image digest mismatch (IMAGE_DIGEST_MISMATCH)', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'industrial', 'container', 'sandbox-manifest.json');
      const manifest: SandboxImageManifest = validateSandboxManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      ).manifest!;

      const wrongDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

      expect(() => assertImageDigestMatch(manifest, wrongDigest)).toThrowError(SandboxError);
      try {
        assertImageDigestMatch(manifest, wrongDigest);
      } catch (err: any) {
        expect(err.code).toBe(SANDBOX_ERROR_CODES.IMAGE_DIGEST_MISMATCH);
        expect(err.message).toContain('does not match pinned manifest digest');
      }

      // Exact digest passes without error
      expect(() => assertImageDigestMatch(manifest, manifest.imageDigest)).not.toThrow();
    });

    it('rejects missing sandbox manifest or image store (SANDBOX_IMAGE_MISSING)', () => {
      const service = new SandboxImageService('/nonexistent/project/path');

      expect(() => service.getManifest()).toThrowError(SandboxError);
      try {
        service.getManifest();
      } catch (err: any) {
        expect(err.code).toBe(SANDBOX_ERROR_CODES.SANDBOX_IMAGE_MISSING);
        expect(err.message).toContain('manifest not found');
      }
    });

    it('rejects unexpected or unapproved packages (UNAPPROVED_PACKAGE_DETECTED)', () => {
      const validPackages = ['numpy==1.26.4', 'pandas==2.2.2', 'scipy==1.13.0'];
      expect(() => assertApprovedPackagesOnly(validPackages)).not.toThrow();

      const taintedPackages = ['numpy==1.26.4', 'requests==2.31.0', 'torch==2.1.0'];
      expect(() => assertApprovedPackagesOnly(taintedPackages)).toThrowError(SandboxError);

      try {
        assertApprovedPackagesOnly(taintedPackages);
      } catch (err: any) {
        expect(err.code).toBe(SANDBOX_ERROR_CODES.UNAPPROVED_PACKAGE_DETECTED);
        expect(err.message).toContain('Unapproved packages detected in sandbox environment');
        expect(err.detail.unapproved).toContain('requests==2.31.0');
        expect(err.detail.unapproved).toContain('torch==2.1.0');
      }
    });

    it('rejects runtime package installation attempts (RUNTIME_INSTALL_FORBIDDEN)', () => {
      const forbiddenAttempts = [
        'pip install requests',
        'pip3 install scikit-learn',
        'apt-get install -y curl',
        'apk add python3-dev',
        'conda install scipy',
        'python -m pip install flask',
      ];

      for (const cmd of forbiddenAttempts) {
        expect(() => assertNoRuntimeInstall(cmd)).toThrowError(SandboxError);
        try {
          assertNoRuntimeInstall(cmd);
        } catch (err: any) {
          expect(err.code).toBe(SANDBOX_ERROR_CODES.RUNTIME_INSTALL_FORBIDDEN);
          expect(err.message).toContain('Runtime package installation attempt detected');
        }
      }

      // Ordinary computational code passes without error
      expect(() => assertNoRuntimeInstall('import numpy as np\nx = np.array([1, 2, 3])')).not.toThrow();
    });

    it('rejects malformed or incomplete sandbox manifest (MALFORMED_SANDBOX_MANIFEST)', () => {
      const malformedManifests = [
        null,
        {},
        { schemaVersion: 2 },
        { schemaVersion: 1, imageName: '' },
        { schemaVersion: 1, imageName: 'img', imageDigest: 'not-a-sha' },
        { schemaVersion: 1, imageName: 'img', imageDigest: 'sha256:abcd', user: { uid: 0 } },
      ];

      for (const m of malformedManifests) {
        const val = validateSandboxManifest(m);
        expect(val.valid).toBe(false);
        expect(val.errors.length).toBeGreaterThan(0);
      }
    });

    it('rejects tampered manifest content with mismatched hash (SANDBOX_MANIFEST_TAMPERED)', () => {
      const manifestPath = path.join(PROJECT_ROOT, 'industrial', 'container', 'sandbox-manifest.json');
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Tamper with limits without changing manifestHash
      const tampered = { ...raw, limits: { ...raw.limits, maxMemoryMb: 99999 } };
      const val = validateSandboxManifest(tampered);

      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('manifestHash mismatch'))).toBe(true);

      // Verify service throws SANDBOX_MANIFEST_TAMPERED
      const customManifestPath = path.join(tempDir, 'tampered-manifest.json');
      fs.writeFileSync(customManifestPath, JSON.stringify(tampered));

      const service = new SandboxImageService(tempDir, { manifestPath: customManifestPath });
      expect(() => service.getManifest(true)).toThrowError(SandboxError);
      try {
        service.getManifest(true);
      } catch (err: any) {
        expect(err.code).toBe(SANDBOX_ERROR_CODES.SANDBOX_MANIFEST_TAMPERED);
      }
    });

    it('rejects root execution attempts (ROOT_EXECUTION_FORBIDDEN)', () => {
      const rootConfigs = [
        { uid: 0, name: 'root', isRoot: true },
        { uid: 0, name: 'sandboxuser', isRoot: false },
        { uid: 10001, name: 'root', isRoot: false },
        { uid: 10001, name: 'sandboxuser', isRoot: true },
      ];

      for (const cfg of rootConfigs) {
        expect(() => assertNonRootExecution(cfg)).toThrowError(SandboxError);
        try {
          assertNonRootExecution(cfg);
        } catch (err: any) {
          expect(err.code).toBe(SANDBOX_ERROR_CODES.ROOT_EXECUTION_FORBIDDEN);
          expect(err.message).toContain('strictly forbidden');
        }
      }

      // Valid non-root passes
      expect(() => assertNonRootExecution({ uid: 10001, name: 'sandboxuser', isRoot: false })).not.toThrow();
    });

    it('rejects host executor in industrial mode (HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL)', () => {
      expect(() => assertIndustrialNoHostExecutor('host', 'industrial')).toThrowError(SandboxError);
      expect(() => assertIndustrialNoHostExecutor('host', 'sovereign-local')).toThrowError(SandboxError);

      try {
        assertIndustrialNoHostExecutor('host', 'industrial');
      } catch (err: any) {
        expect(err.code).toBe(SANDBOX_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL);
        expect(err.message).toContain("Host executor ('execute_python') is strictly forbidden in Industrial mode");
      }

      // Sandbox executor is permitted in industrial mode
      expect(() => assertIndustrialNoHostExecutor('sandbox', 'industrial')).not.toThrow();
      expect(() => assertIndustrialNoHostExecutor('sandbox', 'sovereign-local')).not.toThrow();
    });

    it('rejects verification when no independently observed digest is supplied (INDEPENDENT_DIGEST_REQUIRED)', async () => {
      const service = new SandboxImageService(tempDir);

      // Undefined or empty observedDigest is rejected
      const auditMissing = await service.verifyImage();
      expect(auditMissing.valid).toBe(false);
      expect(auditMissing.errors.some((e) => e.includes(SANDBOX_ERROR_CODES.INDEPENDENT_DIGEST_REQUIRED))).toBe(true);

      const auditEmpty = await service.verifyImage('');
      expect(auditEmpty.valid).toBe(false);
      expect(auditEmpty.errors.some((e) => e.includes(SANDBOX_ERROR_CODES.INDEPENDENT_DIGEST_REQUIRED))).toBe(true);

      const auditWhitespace = await service.verifyImage('   ');
      expect(auditWhitespace.valid).toBe(false);
      expect(auditWhitespace.errors.some((e) => e.includes(SANDBOX_ERROR_CODES.INDEPENDENT_DIGEST_REQUIRED))).toBe(true);
    });

    it('exhaustively validates Docker save archive structure (validateDockerArchiveStructure)', () => {
      const liveTar = path.join(PROJECT_ROOT, 'offline-stores', 'sandbox-image', 'image.tar');
      const expectedTag = 'maos-sandbox-runner:0.3.0-industrial';

      // 1. Valid real archive passes cleanly
      const validResult = validateDockerArchiveStructure(liveTar, expectedTag);
      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toEqual([]);
      expect(validResult.user).toBe('10001:10001');
      expect(validResult.manifest).toBeDefined();
      expect(validResult.entryNames).toContain('manifest.json');
      expect(validResult.layerDigestsVerified).toBe(true);
      expect(validResult.configDigestVerified).toBe(true);
      expect(validResult.runtimeFilesVerified).toBe(true);

      // 2. Missing file rejected
      const missingResult = validateDockerArchiveStructure('/path/that/does/not/exist.tar');
      expect(missingResult.valid).toBe(false);
      expect(missingResult.errors[0]).toContain('not found');

      // 3. File too small (< 1024 bytes) rejected
      const tinyFile = path.join(tempDir, 'tiny.tar');
      fs.writeFileSync(tinyFile, Buffer.alloc(100));
      const tinyResult = validateDockerArchiveStructure(tinyFile);
      expect(tinyResult.valid).toBe(false);
      expect(tinyResult.errors[0]).toContain('too small');

      // 4. Non-tar plain text file (size >= 1024 bytes) rejected for missing POSIX ustar header
      const fakeTar = path.join(tempDir, 'plain-text.tar');
      fs.writeFileSync(fakeTar, Buffer.alloc(2048, 0x41)); // 'A' repeated
      const fakeResult = validateDockerArchiveStructure(fakeTar);
      expect(fakeResult.valid).toBe(false);
      expect(fakeResult.errors.some((e) => e.includes('ustar') || e.includes('tar header parsing failed'))).toBe(true);

      // 5. Mismatched expected tag rejected
      const tagMismatchResult = validateDockerArchiveStructure(liveTar, 'wrong-repo:wrong-tag');
      expect(tagMismatchResult.valid).toBe(false);
      expect(tagMismatchResult.errors.some((e) => e.includes('does not contain expected tag'))).toBe(true);

      // 6. Tar archive with forbidden root user rejected
      const rootTarPath = path.join(tempDir, 'root-user.tar');
      const { createTarFileEntry } = require('../../scripts/generate-sandbox-archive');
      const rootManifest = [{ Config: 'root-config.json', RepoTags: ['test:root'], Layers: [] }];
      const rootConfig = { config: { User: '0:0' } };
      const rootArchiveBuf = Buffer.concat([
        createTarFileEntry('manifest.json', Buffer.from(JSON.stringify(rootManifest))),
        createTarFileEntry('root-config.json', Buffer.from(JSON.stringify(rootConfig))),
        Buffer.alloc(1024),
      ]);
      fs.writeFileSync(rootTarPath, rootArchiveBuf);

      const rootResult = validateDockerArchiveStructure(rootTarPath, 'test:root');
      expect(rootResult.valid).toBe(false);
      expect(rootResult.errors.some((e) => e.includes('forbidden root user'))).toBe(true);
    });

    it('explicitly rejects synthetic or hollow placeholder archives lacking runtime files or matching digests', () => {
      const syntheticTarPath = path.join(tempDir, 'synthetic-hollow.tar');
      const { buildDockerArchive } = require('../../scripts/generate-sandbox-archive');
      buildDockerArchive(syntheticTarPath);

      const result = validateDockerArchiveStructure(syntheticTarPath, 'maos-sandbox-runner:0.3.0-industrial');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);

      // Must fail on content digest mismatch and missing runtime files
      expect(result.errors.some((e) => e.includes('hash mismatch') || e.includes('digest mismatch'))).toBe(true);
      expect(result.errors.some((e) => e.includes('missing required runtime files in layers'))).toBe(true);
      expect(result.runtimeFilesVerified).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 3: Container Definition & Reproducibility
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 3: Container Definition & Reproducibility', () => {
    it('verifies Dockerfile enforces non-root execution and stripped package managers', () => {
      const dockerfilePath = path.join(PROJECT_ROOT, 'industrial', 'container', 'Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);

      const content = fs.readFileSync(dockerfilePath, 'utf8');

      // 1. Pinned base image
      expect(content).toContain('python:3.11.9-slim-bookworm');

      // 2. Non-root user with UID 10001
      expect(content).toContain('10001');
      expect(content).toContain('useradd -u 10001');
      expect(content).toContain('USER 10001:10001');

      // 3. Anti-runtime-install: pip stripped
      expect(content).toContain('rm -rf /usr/local/bin/pip*');
      expect(content).toContain('rm -rf /usr/local/lib/python3.11/ensurepip');

      // 4. Isolated workspace
      expect(content).toContain('/sandbox/workspace');
      expect(content).toContain('WORKDIR /sandbox/workspace');

      // 5. Hardened environment variables
      expect(content).toContain('PYTHONDONTWRITEBYTECODE=1');
      expect(content).toContain('PYTHONNOUSERSITE=1');
    });

    it('verifies requirements.txt contains frozen packages matching approved list', () => {
      const reqPath = path.join(PROJECT_ROOT, 'industrial', 'container', 'requirements.txt');
      expect(fs.existsSync(reqPath)).toBe(true);

      const content = fs.readFileSync(reqPath, 'utf8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));

      const parsedPackages = lines.map((l) => l.split('==')[0].trim());

      expect(parsedPackages).toContain('numpy');
      expect(parsedPackages).toContain('pandas');
      expect(parsedPackages).toContain('scipy');
      expect(parsedPackages).toContain('sympy');
      expect(parsedPackages).toContain('matplotlib');
      expect(parsedPackages).toContain('pytest');

      // All lines must use strict equality pinning (==)
      for (const line of lines) {
        expect(line).toContain('==');
      }
    });

    it('verifies smoke-test.py validates non-root and approved arithmetic', () => {
      const smokePath = path.join(PROJECT_ROOT, 'industrial', 'container', 'smoke-test.py');
      expect(fs.existsSync(smokePath)).toBe(true);

      const content = fs.readFileSync(smokePath, 'utf8');
      expect(content).toContain('os.getuid() == 0');
      expect(content).toContain('import numpy as np');
      expect(content).toContain('import pandas as pd');
      expect(content).toContain('import scipy');
      expect(content).toContain('import sympy');
      expect(content).toContain('import matplotlib');
      expect(content).toContain('import pytest');
      expect(content).toContain('shutil.which("pip")');
    });

    it('verifies build-image.sh and verify-image.sh provide reproducible scripts', () => {
      const buildScript = path.join(PROJECT_ROOT, 'industrial', 'container', 'build-image.sh');
      const verifyScript = path.join(PROJECT_ROOT, 'industrial', 'container', 'verify-image.sh');

      expect(fs.existsSync(buildScript)).toBe(true);
      expect(fs.existsSync(verifyScript)).toBe(true);

      const buildContent = fs.readFileSync(buildScript, 'utf8');
      expect(buildContent).toContain('docker build');
      expect(buildContent).toContain('docker save');
      expect(buildContent).toContain('offline-stores/sandbox-image/image.tar');
      expect(buildContent).toContain('Pinned Manifest Digest');
      expect(buildContent).toContain('sandbox-manifest.json');

      const verifyContent = fs.readFileSync(verifyScript, 'utf8');
      expect(verifyContent).toContain('--network none');
      expect(verifyContent).toContain('--read-only');
      expect(verifyContent).toContain('--cap-drop ALL');
      expect(verifyContent).toContain('--security-opt no-new-privileges:true');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 4: Offline Import Verification & Script Static Safety Analyzer
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 4: Offline Import Verification & Script Static Safety Analyzer', () => {
    it('allows valid calculation scripts with standard library and approved scientific libraries', () => {
      const validScript = `
import math
import statistics
import numpy as np
import pandas as pd
from scipy import stats

def calculate_vibration_rms(readings):
    arr = np.array(readings, dtype=np.float64)
    rms = np.sqrt(np.mean(arr**2))
    return float(rms)

readings = [0.12, 0.45, 0.23, 0.88, 0.31]
result = calculate_vibration_rms(readings)
print(f"RMS: {result}")
`;
      const inspection = inspectScriptForSandboxViolations(validScript);
      expect(inspection.safe).toBe(true);
      expect(inspection.violations).toEqual([]);
      expect(inspection.detectedImports).toContain('numpy');
      expect(inspection.detectedImports).toContain('pandas');
      expect(inspection.detectedImports).toContain('scipy');
    });

    it('detects and blocks forbidden network module imports (NETWORK_ACCESS_FORBIDDEN)', () => {
      const networkScripts = [
        'import socket\ns = socket.socket()',
        'import urllib.request\nurllib.request.urlopen("http://example.com")',
        'import requests\nr = requests.get("http://127.0.0.1:8000")',
        'import httpx\nclient = httpx.Client()',
        'import aiohttp\nasync def fetch(): pass',
        'from urllib import parse\nfrom socket import AF_INET',
      ];

      for (const script of networkScripts) {
        const inspection = inspectScriptForSandboxViolations(script);
        expect(inspection.safe).toBe(false);
        expect(inspection.violations.length).toBeGreaterThan(0);
        expect(inspection.violations[0].type).toBe(SANDBOX_ERROR_CODES.NETWORK_ACCESS_FORBIDDEN);
      }
    });

    it('detects and blocks script-level package install invocations (RUNTIME_INSTALL_FORBIDDEN)', () => {
      const maliciousScripts = [
        'import os\nos.system("pip install malicious-pkg")',
        'import subprocess\nsubprocess.run(["pip", "install", "requests"])',
        '# Trying to install via apt\nos.system("apt-get install -y nmap")',
      ];

      for (const script of maliciousScripts) {
        const inspection = inspectScriptForSandboxViolations(script);
        expect(inspection.safe).toBe(false);
        expect(inspection.violations.some((v) => v.type === SANDBOX_ERROR_CODES.RUNTIME_INSTALL_FORBIDDEN)).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 5: SandboxImageService & ServiceContainer Integration
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 5: SandboxImageService & ServiceContainer Integration', () => {
    it('verifies SandboxImageService loads manifest and performs disk audit', async () => {
      const service = new SandboxImageService(tempDir);
      const manifest = service.getManifest();

      expect(manifest.imageName).toBe('maos-sandbox-runner');
      expect(manifest.user.uid).toBe(10001);

      // Verification fails closed without independently observed digest
      const rejectedAudit = await service.verifyImage();
      expect(rejectedAudit.valid).toBe(false);
      expect(rejectedAudit.errors.some((e) => e.includes('INDEPENDENT_DIGEST_REQUIRED'))).toBe(true);

      // Verification succeeds with independently observed digest matching pinned manifest
      const audit = await service.verifyImage(manifest.imageDigest);
      expect(audit.valid).toBe(true);
      expect(audit.imageDigestVerified).toBe(true);
      expect(audit.nonRootVerified).toBe(true);
      expect(audit.packagesVerified).toBe(true);
      expect(audit.securityPolicyVerified).toBe(true);
      expect(audit.offlineStoreVerified).toBe(true);

      // Verification fails if observed digest does not match
      const wrongAudit = await service.verifyImage('sha256:1111111111111111111111111111111111111111111111111111111111111111');
      expect(wrongAudit.valid).toBe(false);
      expect(wrongAudit.imageDigestVerified).toBe(false);
    });

    it('verifies validateExecutionRequest acts as a unified fail-closed gate', () => {
      const service = new SandboxImageService(tempDir);

      // 1. Host executor blocked in industrial mode
      expect(() =>
        service.validateExecutionRequest({
          script: 'print(1)',
          executorType: 'host',
          profileMode: 'industrial',
        }),
      ).toThrowError(/Host executor/);

      // 2. Root execution blocked
      expect(() =>
        service.validateExecutionRequest({
          script: 'print(1)',
          executorType: 'sandbox',
          user: { uid: 0, isRoot: true },
        }),
      ).toThrowError(/Execution as root/);

      // 3. Digest mismatch blocked
      expect(() =>
        service.validateExecutionRequest({
          script: 'print(1)',
          executorType: 'sandbox',
          actualDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        }),
      ).toThrowError(/does not match pinned manifest digest/);

      // 4. Runtime install blocked
      expect(() =>
        service.validateExecutionRequest({
          script: 'pip install requests',
          executorType: 'sandbox',
        }),
      ).toThrowError(/Runtime package installation attempt/);

      // 5. Network import blocked
      expect(() =>
        service.validateExecutionRequest({
          script: 'import socket',
          executorType: 'sandbox',
        }),
      ).toThrowError(/Script execution blocked/);

      // 6. Valid calculation request passes cleanly
      expect(() =>
        service.validateExecutionRequest({
          script: 'import numpy as np\nprint(np.mean([1, 2, 3]))',
          executorType: 'sandbox',
          profileMode: 'industrial',
          user: { uid: 10001, isRoot: false, name: 'sandboxuser' },
          actualDigest: service.getManifest().imageDigest,
          installedPackages: ['numpy', 'pandas', 'scipy', 'sympy', 'matplotlib', 'pytest'],
        }),
      ).not.toThrow();
    });

    it('verifies ServiceContainer exposes sandboxImage service', () => {
      expect(services.sandboxImage).toBeDefined();
      expect(services.sandboxImage instanceof SandboxImageService).toBe(true);
      expect(services.sandboxImage.getManifest().imageName).toBe('maos-sandbox-runner');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tier 6: Gate Preconditions & Canary Hash Integrity
  // ══════════════════════════════════════════════════════════════════════

  describe('Tier 6: Gate Preconditions & Canary Hash Integrity', () => {
    it('preserves canary rust/test.txt SHA-256 hash verbatim', () => {
      const canaryPath = path.join(PROJECT_ROOT, 'rust', 'test.txt');
      expect(fs.existsSync(canaryPath)).toBe(true);

      const content = fs.readFileSync(canaryPath, 'utf8');
      const hash = computeSha256(content);
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });

    it('verifies Gate G5 is PASSED, G6 is PASSED, G7 is PASSED', () => {
      const planPath = path.join(PROJECT_ROOT, 'docs', 'SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);

      const content = fs.readFileSync(planPath, 'utf8');
      expect(content).toMatch(/- \[x\] G5 local KB benchmark passed/);
      expect(content).toMatch(/- \[x\] G6 approved DOCX\/XLSX\/PPTX verified/);
      expect(content).toMatch(/- \[x\] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified/);
    });
  });
});
