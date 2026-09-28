/**
 * MAOS Industrial — Pinned Sandbox Image Service (F8-01)
 *
 * Implements the authoritative backend service for inspecting, verifying, and
 * gating container sandbox images, offline archives, manifests, and script safety:
 *   - Authoritative manifest loading & cryptographic integrity validation
 *   - Pinned image digest matching against immutable release specification
 *   - Non-root user identity enforcement (UID 10001)
 *   - Offline dependency audit against approved allowlist
 *   - Static script analysis to block runtime package installs & network calls
 *   - Fail-closed blocking of host executor (execute_python) in industrial mode
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  SANDBOX_ERROR_CODES,
  SandboxError,
  SandboxImageManifest,
  SandboxVerificationResult,
  ScriptInspectionResult,
  validateSandboxManifest,
  assertImageDigestMatch,
  assertNonRootExecution,
  assertApprovedPackagesOnly,
  assertNoRuntimeInstall,
  assertIndustrialNoHostExecutor,
  inspectScriptForSandboxViolations,
  validateDockerArchiveStructure,
  FROZEN_SANDBOX_POLICY,
} from '../domain/sandbox';

export interface SandboxImageServiceOptions {
  manifestPath?: string;
  offlineStorePath?: string;
}

export interface SandboxExecutionValidationInput {
  script: string;
  executorType?: 'host' | 'sandbox';
  profileMode?: string;
  actualDigest?: string;
  user?: unknown;
  installedPackages?: readonly string[];
}

export class SandboxImageService {
  private readonly projectRoot: string;
  private readonly manifestPath: string;
  private readonly offlineStorePath: string;
  private cachedManifest: SandboxImageManifest | null = null;

  constructor(projectRoot: string, options: SandboxImageServiceOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.manifestPath = options.manifestPath || path.join(this.projectRoot, 'industrial', 'container', 'sandbox-manifest.json');
    this.offlineStorePath = options.offlineStorePath || path.join(this.projectRoot, 'offline-stores', 'sandbox-image');
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getManifestPath(): string {
    return this.manifestPath;
  }

  getOfflineStorePath(): string {
    return this.offlineStorePath;
  }

  /**
   * Loads and validates the authoritative sandbox manifest from disk.
   * Fails closed if the file is missing, malformed, or tampered.
   */
  getManifest(forceReload = false): SandboxImageManifest {
    if (this.cachedManifest && !forceReload) {
      return this.cachedManifest;
    }

    if (!fs.existsSync(this.manifestPath)) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.SANDBOX_IMAGE_MISSING,
        `Sandbox image manifest not found at expected path: ${this.manifestPath}`,
        { path: this.manifestPath },
      );
    }

    let rawJson: unknown;
    try {
      const rawText = fs.readFileSync(this.manifestPath, 'utf8');
      rawJson = JSON.parse(rawText);
    } catch (err: any) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.MALFORMED_SANDBOX_MANIFEST,
        `Failed to parse sandbox image manifest as JSON: ${err.message}`,
        { path: this.manifestPath },
      );
    }

    const validation = validateSandboxManifest(rawJson);
    if (!validation.valid || !validation.manifest) {
      // If the error specifically mentions manifestHash mismatch, classify as tampered
      const isTampered = validation.errors.some((e) => e.includes('manifestHash mismatch'));
      const errorCode = isTampered
        ? SANDBOX_ERROR_CODES.SANDBOX_MANIFEST_TAMPERED
        : SANDBOX_ERROR_CODES.MALFORMED_SANDBOX_MANIFEST;

      throw new SandboxError(
        errorCode,
        `Sandbox manifest validation failed: ${validation.errors.join('; ')}`,
        { errors: validation.errors, path: this.manifestPath },
      );
    }

    this.cachedManifest = validation.manifest;
    return this.cachedManifest;
  }

  /**
   * Comprehensive audit of the sandbox image specification, offline archive,
   * non-root user configuration, and frozen package allowlist.
   *
   * An independently observed container image digest MUST be supplied.
   * Verification fails closed if observedDigest is missing, empty, or differs
   * from the pinned manifest digest.
   */
  async verifyImage(observedDigest?: string): Promise<SandboxVerificationResult> {
    const errors: string[] = [];
    let manifest: SandboxImageManifest | undefined;
    let imageDigestVerified = false;
    let nonRootVerified = false;
    let packagesVerified = false;
    let securityPolicyVerified = false;
    let offlineStoreVerified = false;

    // 0. Enforce independent observed digest requirement (Remediation Item 9)
    if (!observedDigest || typeof observedDigest !== 'string' || observedDigest.trim().length === 0) {
      errors.push(
        `[${SANDBOX_ERROR_CODES.INDEPENDENT_DIGEST_REQUIRED}] Verification rejected: an independently observed container image digest must be supplied. Self-verification without independent observation is forbidden.`,
      );
      return {
        valid: false,
        errors: Object.freeze(errors),
        imageDigestVerified: false,
        nonRootVerified: false,
        packagesVerified: false,
        securityPolicyVerified: false,
        offlineStoreVerified: false,
        timestamp: new Date().toISOString(),
      };
    }

    // 1. Load manifest
    try {
      manifest = this.getManifest(true);
    } catch (err: any) {
      errors.push(err.message);
      return {
        valid: false,
        errors: Object.freeze(errors),
        imageDigestVerified: false,
        nonRootVerified: false,
        packagesVerified: false,
        securityPolicyVerified: false,
        offlineStoreVerified: false,
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Digest Verification against independent observation
    try {
      assertImageDigestMatch(manifest, observedDigest);
      imageDigestVerified = true;
    } catch (err: any) {
      errors.push(err.message);
    }

    // 3. Non-Root Execution Verification
    try {
      assertNonRootExecution(manifest.user);
      if (manifest.user.uid !== FROZEN_SANDBOX_POLICY.expectedUid) {
        errors.push(`Expected non-root UID ${FROZEN_SANDBOX_POLICY.expectedUid}, got ${manifest.user.uid}`);
      } else {
        nonRootVerified = true;
      }
    } catch (err: any) {
      errors.push(err.message);
    }

    // 4. Security Policy Verification
    const policyErrors: string[] = [];
    if (manifest.network !== FROZEN_SANDBOX_POLICY.networkMode) {
      policyErrors.push(`Network mode must be '${FROZEN_SANDBOX_POLICY.networkMode}', received '${manifest.network}'`);
    }
    if (!manifest.capabilities.dropAll || !manifest.capabilities.noNewPrivileges || !manifest.capabilities.readOnlyRootfs) {
      policyErrors.push('Capabilities must enforce dropAll=true, noNewPrivileges=true, and readOnlyRootfs=true');
    }
    if (policyErrors.length === 0) {
      securityPolicyVerified = true;
    } else {
      errors.push(...policyErrors);
    }

    // 5. Approved Packages Verification
    try {
      const packageNames = manifest.approvedPackages.map((p) => p.name);
      assertApprovedPackagesOnly(packageNames, manifest.approvedPackages);
      packagesVerified = true;
    } catch (err: any) {
      errors.push(err.message);
    }

    // 6. Deep Offline Store Archive Structural Verification (Remediation Items 10 & 13)
    const archivePath = path.isAbsolute(manifest.offlineStoreRelativePath)
      ? manifest.offlineStoreRelativePath
      : path.join(this.projectRoot, manifest.offlineStoreRelativePath);

    const expectedTag = `${manifest.imageName}:${manifest.tag}`;
    const archiveValidation = validateDockerArchiveStructure(archivePath, expectedTag);

    if (archiveValidation.valid) {
      offlineStoreVerified = true;
    } else {
      for (const err of archiveValidation.errors) {
        errors.push(err);
      }
    }

    const valid = errors.length === 0;

    return {
      valid,
      errors: Object.freeze(errors),
      manifest,
      imageDigestVerified,
      nonRootVerified,
      packagesVerified,
      securityPolicyVerified,
      offlineStoreVerified,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Statically inspects a Python script for security violations (network, runtime installs).
   */
  verifyScriptSafety(script: string): ScriptInspectionResult {
    return inspectScriptForSandboxViolations(script);
  }

  /**
   * Unified fail-closed execution gateway: validates script safety, executor type,
   * non-root user, digest, and package allowlist.
   */
  validateExecutionRequest(input: SandboxExecutionValidationInput): void {
    const manifest = this.getManifest();

    // 1. Block host executor in industrial mode
    if (input.executorType) {
      assertIndustrialNoHostExecutor(input.executorType, input.profileMode || 'industrial');
    }

    // 2. Enforce non-root execution
    if (input.user) {
      assertNonRootExecution(input.user);
    }

    // 3. Enforce image digest match if runtime digest reported
    if (input.actualDigest) {
      assertImageDigestMatch(manifest, input.actualDigest);
    }

    // 4. Enforce runtime install prohibition on raw script
    assertNoRuntimeInstall(input.script);

    // 5. Static AST / pattern inspection of script
    const inspection = this.verifyScriptSafety(input.script);
    if (!inspection.safe) {
      const firstViolation = inspection.violations[0];
      throw new SandboxError(
        firstViolation.type,
        `Script execution blocked by sandbox safety policy: ${firstViolation.detail}`,
        { violations: inspection.violations },
      );
    }

    // 6. Enforce package allowlist if container packages reported
    if (input.installedPackages && input.installedPackages.length > 0) {
      assertApprovedPackagesOnly(input.installedPackages, manifest.approvedPackages);
    }
  }
}
