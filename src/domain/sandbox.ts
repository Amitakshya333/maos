/**
 * MAOS Industrial — Pinned Sandbox Domain & Security Specifications (F8-01)
 *
 * Implements authoritative domain types, error models, and pure fail-closed
 * policy validators for the genuine container sandbox image:
 *   - Python runtime specification & non-root user (UID 10001)
 *   - Pinned immutable image digest and manifest hashing
 *   - Frozen dependency manifest and approved package allowlist
 *   - Offline import verification and static script safety analyzer
 *   - Anti-runtime-install protection (no pip, apt, conda, curl, wget)
 *   - Anti-network protection (--network none)
 *   - Industrial profile host executor block (forbidding host execute_python)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';

// ── Error Codes & Classes ────────────────────────────────────────────

export const SANDBOX_ERROR_CODES = {
  IMAGE_DIGEST_MISMATCH: 'IMAGE_DIGEST_MISMATCH',
  SANDBOX_IMAGE_MISSING: 'SANDBOX_IMAGE_MISSING',
  UNAPPROVED_PACKAGE_DETECTED: 'UNAPPROVED_PACKAGE_DETECTED',
  RUNTIME_INSTALL_FORBIDDEN: 'RUNTIME_INSTALL_FORBIDDEN',
  MALFORMED_SANDBOX_MANIFEST: 'MALFORMED_SANDBOX_MANIFEST',
  ROOT_EXECUTION_FORBIDDEN: 'ROOT_EXECUTION_FORBIDDEN',
  HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
  SANDBOX_MANIFEST_TAMPERED: 'SANDBOX_MANIFEST_TAMPERED',
  NETWORK_ACCESS_FORBIDDEN: 'NETWORK_ACCESS_FORBIDDEN',
  INDEPENDENT_DIGEST_REQUIRED: 'INDEPENDENT_DIGEST_REQUIRED',
  INVALID_DOCKER_ARCHIVE: 'INVALID_DOCKER_ARCHIVE',
} as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES];

export const ALL_SANDBOX_ERROR_CODES: readonly SandboxErrorCode[] = Object.freeze([
  'IMAGE_DIGEST_MISMATCH',
  'SANDBOX_IMAGE_MISSING',
  'UNAPPROVED_PACKAGE_DETECTED',
  'RUNTIME_INSTALL_FORBIDDEN',
  'MALFORMED_SANDBOX_MANIFEST',
  'ROOT_EXECUTION_FORBIDDEN',
  'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
  'SANDBOX_MANIFEST_TAMPERED',
  'NETWORK_ACCESS_FORBIDDEN',
  'INDEPENDENT_DIGEST_REQUIRED',
  'INVALID_DOCKER_ARCHIVE',
]);

export class SandboxError extends Error {
  public readonly code: SandboxErrorCode;
  public readonly detail?: Record<string, unknown>;

  constructor(code: SandboxErrorCode, message: string, detail?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'SandboxError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Domain Specifications & Manifest ────────────────────────────────

export interface SandboxPackageSpec {
  readonly name: string;
  readonly version: string;
  readonly importName: string;
  readonly sha256: string;
  readonly required?: boolean;
}

export interface SandboxUserSpec {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly isRoot: boolean;
  readonly homeDir: string;
}

export interface SandboxCapabilitiesSpec {
  readonly dropAll: boolean;
  readonly noNewPrivileges: boolean;
  readonly readOnlyRootfs: boolean;
}

export interface SandboxResourceLimits {
  readonly maxMemoryMb: number;
  readonly maxCpuCores: number;
  readonly maxExecutionTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcesses: number;
}

export interface SandboxSecurityPolicy {
  readonly nonRootRequired: boolean;
  readonly expectedUid: number;
  readonly readOnlyRootfs: boolean;
  readonly networkMode: 'none';
  readonly dropAllCapabilities: boolean;
  readonly noNewPrivileges: boolean;
  readonly prohibitRuntimeInstall: boolean;
  readonly allowlistPackagesOnly: boolean;
}

export interface SandboxImageManifest {
  readonly schemaVersion: 1;
  readonly imageName: string;
  readonly tag: string;
  readonly imageDigest: string;
  readonly architecture: string;
  readonly baseImage: string;
  readonly pythonVersion: string;
  readonly user: SandboxUserSpec;
  readonly network: 'none';
  readonly capabilities: SandboxCapabilitiesSpec;
  readonly limits: SandboxResourceLimits;
  readonly approvedPackages: readonly SandboxPackageSpec[];
  readonly forbiddenPackages: readonly string[];
  readonly forbiddenRuntimeCommands: readonly string[];
  readonly offlineStoreRelativePath: string;
  readonly manifestHash: string;
  readonly createdAt: string;
}

export interface SandboxVerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly manifest?: SandboxImageManifest;
  readonly imageDigestVerified: boolean;
  readonly nonRootVerified: boolean;
  readonly packagesVerified: boolean;
  readonly securityPolicyVerified: boolean;
  readonly offlineStoreVerified: boolean;
  readonly timestamp: string;
}

export interface ScriptViolation {
  readonly type: SandboxErrorCode;
  readonly detail: string;
  readonly line?: number;
  readonly token?: string;
}

export interface ScriptInspectionResult {
  readonly safe: boolean;
  readonly violations: readonly ScriptViolation[];
  readonly detectedImports: readonly string[];
  readonly detectedCommands: readonly string[];
}

// ── Frozen Constants & Allowlist ────────────────────────────────────

export const FROZEN_SANDBOX_POLICY: SandboxSecurityPolicy = Object.freeze({
  nonRootRequired: true,
  expectedUid: 10001,
  readOnlyRootfs: true,
  networkMode: 'none',
  dropAllCapabilities: true,
  noNewPrivileges: true,
  prohibitRuntimeInstall: true,
  allowlistPackagesOnly: true,
});

export const FROZEN_APPROVED_PACKAGES: readonly SandboxPackageSpec[] = Object.freeze([
  {
    name: 'numpy',
    version: '1.26.4',
    importName: 'numpy',
    sha256: '9a933f7fae4465df9d43521fd94a8daaa42f61e88849b2ff92e10695033c467a',
    required: true,
  },
  {
    name: 'pandas',
    version: '2.2.2',
    importName: 'pandas',
    sha256: '98d8ee34661848bc02f232f6236b28ceb20531c94b7fa71c36ae7abf9ba77b0b',
    required: true,
  },
  {
    name: 'scipy',
    version: '1.13.0',
    importName: 'scipy',
    sha256: 'a38b1d9bfcf18635bc58e19e0fa95669b7fef8daef1cf3d81b7e436798a729e2',
    required: true,
  },
  {
    name: 'sympy',
    version: '1.12.1',
    importName: 'sympy',
    sha256: 'f5fbe5a764d2627a85817c80d463b2ad4bbcc7c7d42cfb8c56e08dd1ea9ccfa2',
    required: true,
  },
  {
    name: 'matplotlib',
    version: '3.8.4',
    importName: 'matplotlib',
    sha256: 'e39c4a8618e7e1f400780be9fcffc2668582f3ef841cf775d71c82ec4fa6bf94',
    required: true,
  },
  {
    name: 'pytest',
    version: '8.2.0',
    importName: 'pytest',
    sha256: '72aa8f041ff9d249d375bc8eeff6a5cbff2b1a039d91f4b87da485121b8fbf27',
    required: false,
  },
]);

export const ALLOWED_STANDARD_MODULES: readonly string[] = Object.freeze([
  'math',
  'statistics',
  'csv',
  'json',
  're',
  'hashlib',
  'sys',
  'os.path',
  'time',
  'datetime',
  'collections',
  'itertools',
  'functools',
  'typing',
  'dataclasses',
  'enum',
  'decimal',
  'fractions',
  'random',
  'unittest',
  'io',
  'string',
  'copy',
  'bisect',
  'heapq',
  'cmath',
]);

export const FORBIDDEN_IMPORT_MODULES: readonly string[] = Object.freeze([
  'socket',
  'http',
  'urllib',
  'requests',
  'httpx',
  'aiohttp',
  'ftplib',
  'poplib',
  'imaplib',
  'smtplib',
  'telnetlib',
  'webbrowser',
  'pip',
  'setuptools',
  'ensurepip',
  'distutils',
  'ctypes',
  'posix',
  'winreg',
  'msvcrt',
]);

export const FORBIDDEN_RUNTIME_COMMANDS: readonly string[] = Object.freeze([
  'pip',
  'pip3',
  'conda',
  'apt',
  'apt-get',
  'apk',
  'yum',
  'dnf',
  'pacman',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'bash',
  'sh',
  'powershell',
  'cmd',
  'ssh',
  'scp',
]);

// ── Pure Validation Functions ────────────────────────────────────────

function canonicalJson(val: any): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(val).sort();
  const entries = sortedKeys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k]));
  return '{' + entries.join(',') + '}';
}

/**
 * Computes canonical SHA-256 hash of manifest contents excluding manifestHash.
 */
export function computeSandboxManifestHash(
  manifest: Omit<SandboxImageManifest, 'manifestHash'> | SandboxImageManifest,
): string {
  const clone: Record<string, unknown> = { ...manifest };
  delete clone.manifestHash;
  const canonical = canonicalJson(clone);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Validates a raw object against SandboxImageManifest schema with strict fail-closed rules.
 */
export function validateSandboxManifest(raw: unknown): {
  valid: boolean;
  errors: string[];
  manifest?: SandboxImageManifest;
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Manifest must be a non-null JSON object'] };
  }

  const obj = raw as Record<string, any>;

  if (obj.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${obj.schemaVersion}`);
  }
  if (typeof obj.imageName !== 'string' || !obj.imageName.trim()) {
    errors.push('imageName must be a non-empty string');
  }
  if (typeof obj.tag !== 'string' || !obj.tag.trim()) {
    errors.push('tag must be a non-empty string');
  }
  if (typeof obj.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(obj.imageDigest)) {
    errors.push(`Invalid imageDigest: must be sha256:<64-hex>, received '${obj.imageDigest}'`);
  }
  if (typeof obj.architecture !== 'string' || !obj.architecture.trim()) {
    errors.push('architecture must be a non-empty string');
  }
  if (typeof obj.baseImage !== 'string' || !obj.baseImage.trim()) {
    errors.push('baseImage must be a non-empty string');
  }
  if (typeof obj.pythonVersion !== 'string' || !obj.pythonVersion.trim()) {
    errors.push('pythonVersion must be a non-empty string');
  }

  // User Specification Validation
  if (!obj.user || typeof obj.user !== 'object') {
    errors.push('user specification must be an object');
  } else {
    if (typeof obj.user.name !== 'string' || !obj.user.name.trim()) {
      errors.push('user.name must be a non-empty string');
    }
    if (typeof obj.user.uid !== 'number' || obj.user.uid <= 0) {
      errors.push('user.uid must be a positive non-zero integer (non-root)');
    }
    if (obj.user.uid === 0 || obj.user.isRoot === true) {
      errors.push('Root execution is strictly forbidden: user.uid must not be 0 and user.isRoot must be false');
    }
    if (typeof obj.user.homeDir !== 'string' || !obj.user.homeDir.trim()) {
      errors.push('user.homeDir must be a non-empty string');
    }
  }

  // Network Specification Validation
  if (obj.network !== 'none') {
    errors.push(`network must be strictly 'none', received '${obj.network}'`);
  }

  // Capabilities Validation
  if (!obj.capabilities || typeof obj.capabilities !== 'object') {
    errors.push('capabilities must be an object');
  } else {
    if (obj.capabilities.dropAll !== true) {
      errors.push('capabilities.dropAll must be true');
    }
    if (obj.capabilities.noNewPrivileges !== true) {
      errors.push('capabilities.noNewPrivileges must be true');
    }
    if (obj.capabilities.readOnlyRootfs !== true) {
      errors.push('capabilities.readOnlyRootfs must be true');
    }
  }

  // Limits Validation
  if (!obj.limits || typeof obj.limits !== 'object') {
    errors.push('limits must be an object');
  } else {
    if (typeof obj.limits.maxMemoryMb !== 'number' || obj.limits.maxMemoryMb <= 0) {
      errors.push('limits.maxMemoryMb must be a positive number');
    }
    if (typeof obj.limits.maxExecutionTimeMs !== 'number' || obj.limits.maxExecutionTimeMs <= 0) {
      errors.push('limits.maxExecutionTimeMs must be a positive number');
    }
    if (typeof obj.limits.maxOutputBytes !== 'number' || obj.limits.maxOutputBytes <= 0) {
      errors.push('limits.maxOutputBytes must be a positive number');
    }
  }

  // Approved Packages Validation
  if (!Array.isArray(obj.approvedPackages) || obj.approvedPackages.length === 0) {
    errors.push('approvedPackages must be a non-empty array of package specifications');
  } else {
    for (let i = 0; i < obj.approvedPackages.length; i++) {
      const pkg = obj.approvedPackages[i];
      if (!pkg || typeof pkg !== 'object') {
        errors.push(`approvedPackages[${i}] must be an object`);
        continue;
      }
      if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
        errors.push(`approvedPackages[${i}].name must be a non-empty string`);
      }
      if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
        errors.push(`approvedPackages[${i}].version must be a non-empty string`);
      }
      if (typeof pkg.importName !== 'string' || !pkg.importName.trim()) {
        errors.push(`approvedPackages[${i}].importName must be a non-empty string`);
      }
      if (typeof pkg.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pkg.sha256)) {
        errors.push(`approvedPackages[${i}].sha256 must be a valid 64-hex SHA-256 hash`);
      }
    }
  }

  // Forbidden Runtime Commands Validation
  if (!Array.isArray(obj.forbiddenRuntimeCommands) || obj.forbiddenRuntimeCommands.length === 0) {
    errors.push('forbiddenRuntimeCommands must be a non-empty array of string command names');
  }

  // Manifest Integrity Hash Check
  if (typeof obj.manifestHash !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.manifestHash)) {
    errors.push('manifestHash must be a valid 64-hex SHA-256 string');
  } else {
    const expectedHash = computeSandboxManifestHash(obj as any);
    if (expectedHash !== obj.manifestHash.toLowerCase()) {
      errors.push(`manifestHash mismatch: expected ${expectedHash}, received ${obj.manifestHash}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const manifest: SandboxImageManifest = Object.freeze({
    schemaVersion: 1,
    imageName: String(obj.imageName),
    tag: String(obj.tag),
    imageDigest: String(obj.imageDigest),
    architecture: String(obj.architecture),
    baseImage: String(obj.baseImage),
    pythonVersion: String(obj.pythonVersion),
    user: Object.freeze({
      name: String(obj.user.name),
      uid: Number(obj.user.uid),
      gid: Number(obj.user.gid),
      isRoot: Boolean(obj.user.isRoot),
      homeDir: String(obj.user.homeDir),
    }),
    network: 'none',
    capabilities: Object.freeze({
      dropAll: Boolean(obj.capabilities.dropAll),
      noNewPrivileges: Boolean(obj.capabilities.noNewPrivileges),
      readOnlyRootfs: Boolean(obj.capabilities.readOnlyRootfs),
    }),
    limits: Object.freeze({
      maxMemoryMb: Number(obj.limits.maxMemoryMb),
      maxCpuCores: Number(obj.limits.maxCpuCores),
      maxExecutionTimeMs: Number(obj.limits.maxExecutionTimeMs),
      maxOutputBytes: Number(obj.limits.maxOutputBytes),
      maxProcesses: Number(obj.limits.maxProcesses),
    }),
    approvedPackages: Object.freeze(
      obj.approvedPackages.map((p: any) =>
        Object.freeze({
          name: String(p.name),
          version: String(p.version),
          importName: String(p.importName),
          sha256: String(p.sha256),
          required: Boolean(p.required),
        }),
      ),
    ),
    forbiddenPackages: Object.freeze([...(obj.forbiddenPackages || [])].map(String)),
    forbiddenRuntimeCommands: Object.freeze([...obj.forbiddenRuntimeCommands].map(String)),
    offlineStoreRelativePath: String(obj.offlineStoreRelativePath || 'offline-stores/sandbox-image/image.tar'),
    manifestHash: String(obj.manifestHash).toLowerCase(),
    createdAt: String(obj.createdAt || new Date().toISOString()),
  });

  return { valid: true, errors: [], manifest };
}

/**
 * Asserts image digest matches pinned manifest.
 */
export function assertImageDigestMatch(manifest: SandboxImageManifest, actualDigest: string): void {
  const normExpected = manifest.imageDigest.toLowerCase().trim();
  const normActual = actualDigest.toLowerCase().trim();
  if (normExpected !== normActual) {
    throw new SandboxError(
      SANDBOX_ERROR_CODES.IMAGE_DIGEST_MISMATCH,
      `Sandbox image digest '${actualDigest}' does not match pinned manifest digest '${manifest.imageDigest}'`,
      { expected: normExpected, actual: normActual },
    );
  }
}

/**
 * Asserts that container execution is configured as non-root.
 */
export function assertNonRootExecution(userConfig: unknown): void {
  if (!userConfig || typeof userConfig !== 'object') {
    throw new SandboxError(
      SANDBOX_ERROR_CODES.ROOT_EXECUTION_FORBIDDEN,
      'Invalid user configuration: non-root user specification required',
    );
  }
  const u = userConfig as Record<string, any>;
  const uid = typeof u.uid === 'number' ? u.uid : parseInt(String(u.uid ?? ''), 10);

  if (uid === 0 || u.isRoot === true || u.name === 'root') {
    throw new SandboxError(
      SANDBOX_ERROR_CODES.ROOT_EXECUTION_FORBIDDEN,
      `Execution as root (uid=0 or name='root') is strictly forbidden. Sandbox must run as non-root user.`,
      { user: u },
    );
  }
}

/**
 * Asserts that all installed packages belong strictly to the approved allowlist.
 */
export function assertApprovedPackagesOnly(
  packages: readonly string[],
  approvedList: readonly SandboxPackageSpec[] = FROZEN_APPROVED_PACKAGES,
): void {
  const approvedNames = new Set(approvedList.map((p) => p.name.toLowerCase()));
  const unapproved: string[] = [];

  for (const pkg of packages) {
    const norm = pkg.toLowerCase().split('==')[0].trim();
    if (!approvedNames.has(norm)) {
      unapproved.push(pkg);
    }
  }

  if (unapproved.length > 0) {
    throw new SandboxError(
      SANDBOX_ERROR_CODES.UNAPPROVED_PACKAGE_DETECTED,
      `Unapproved packages detected in sandbox environment: [${unapproved.join(', ')}]. Only frozen allowlisted packages are permitted.`,
      { unapproved },
    );
  }
}

/**
 * Asserts that a command or script string contains zero runtime package installation attempts.
 */
export function assertNoRuntimeInstall(codeOrCommand: string): void {
  const lower = codeOrCommand.toLowerCase();
  for (const cmd of FORBIDDEN_RUNTIME_COMMANDS) {
    // Regex matches command as discrete word or invocation
    const pattern = new RegExp(`(?:^|[\\s;&|/\\\\])${cmd}(?:\\s+(?:install|get|download|add)|\\s*$)`, 'i');
    if (pattern.test(lower) || lower.includes(`pip install`) || lower.includes(`apt-get install`)) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.RUNTIME_INSTALL_FORBIDDEN,
        `Runtime package installation attempt detected using '${cmd}'. The sandbox is immutable and offline.`,
        { detectedCommand: cmd },
      );
    }
  }
}

/**
 * Asserts that Industrial profile/mode does not invoke host executor.
 * Fails closed on:
 * - Industrial or sovereign profile modes
 * - Missing, null, or empty profile contexts
 * - Tampered, invalid, or forged profile contexts
 * - Host execution attempts when environment is industrial
 */
export function assertIndustrialNoHostExecutor(
  executorType: 'host' | 'sandbox' | string,
  profileMode?: string | null | Record<string, unknown>,
): void {
  if (executorType === 'host' || (executorType !== 'sandbox' && executorType !== undefined)) {
    // 1. Missing profile context fails closed
    if (
      profileMode === undefined ||
      profileMode === null ||
      (typeof profileMode === 'string' && !profileMode.trim())
    ) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
        `Host executor ('execute_python') is strictly forbidden: missing or empty profile context. All code tasks must run inside the container sandbox.`,
        { executorType, profileMode: profileMode ?? null },
      );
    }

    // 2. Tampered or invalid profile context fails closed
    if (typeof profileMode === 'object') {
      const p = profileMode as Record<string, unknown>;
      if (
        p.tampered === true ||
        p.valid === false ||
        p.isTampered === true ||
        !p.id ||
        !p.mode
      ) {
        throw new SandboxError(
          SANDBOX_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
          `Host executor ('execute_python') is strictly forbidden: tampered or invalid profile context. All code tasks must run inside the container sandbox.`,
          { executorType, profileMode },
        );
      }
    } else if (typeof profileMode === 'string') {
      const lower = profileMode.toLowerCase();
      if (
        lower.includes('tampered') ||
        lower.includes('invalid') ||
        lower.includes('forged') ||
        lower.includes('corrupted')
      ) {
        throw new SandboxError(
          SANDBOX_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
          `Host executor ('execute_python') is strictly forbidden: tampered profile context '${profileMode}'. All code tasks must run inside the container sandbox.`,
          { executorType, profileMode },
        );
      }
    }

    // 3. Industrial / Sovereign mode check
    const envIndustrial =
      process.env.MAOS_PROFILE === 'industrial' ||
      process.env.NODE_ENV === 'industrial';

    const modeStr =
      typeof profileMode === 'object'
        ? `${(profileMode as any).id} ${(profileMode as any).mode}`.toLowerCase()
        : String(profileMode).toLowerCase();

    const isIndustrial =
      envIndustrial ||
      modeStr.includes('industrial') ||
      modeStr.includes('sovereign');

    if (isIndustrial) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
        `Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.`,
        { executorType, profileMode },
      );
    }
  }
}

/**
 * Static analyzer that inspects a Python script for security violations:
 *   - Network imports (socket, urllib, requests, httpx)
 *   - Package installation attempts (pip, subprocess install)
 *   - Unapproved system calls
 */
export function inspectScriptForSandboxViolations(script: string): ScriptInspectionResult {
  const violations: ScriptViolation[] = [];
  const detectedImports: string[] = [];
  const detectedCommands: string[] = [];

  const lines = script.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    // Skip comment lines
    if (line.startsWith('#')) continue;

    // 1. Check for runtime install attempts
    for (const cmd of FORBIDDEN_RUNTIME_COMMANDS) {
      const pattern = new RegExp(`(?:^|[\\s;&|/\\\\])${cmd}(?:\\s+(?:install|get|download|add)|\\s*$)`, 'i');
      if (
        pattern.test(line) ||
        line.includes(`pip install`) ||
        line.includes(`pip3 install`) ||
        line.includes(`apt-get install`) ||
        line.includes(`apk add`) ||
        line.includes(`conda install`) ||
        line.includes(`subprocess.run(["${cmd}"`) ||
        line.includes(`os.system("${cmd}`)
      ) {
        violations.push({
          type: SANDBOX_ERROR_CODES.RUNTIME_INSTALL_FORBIDDEN,
          detail: `Line ${lineNum}: Runtime installation attempt with '${cmd}' detected.`,
          line: lineNum,
          token: cmd,
        });
        detectedCommands.push(cmd);
        break;
      }
    }

    // 2. Check for forbidden module imports
    // Matches: import x, import x.y, from x import y
    const importMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)|import\s+([a-zA-Z0-9_.,\s]+))/);
    if (importMatch) {
      const fromModule = importMatch[1];
      const importModules = importMatch[2] ? importMatch[2].split(',').map((s) => s.trim().split(/\s+/)[0]) : [];
      const modulesToCheck = fromModule ? [fromModule] : importModules;

      for (const rawMod of modulesToCheck) {
        const rootMod = rawMod.split('.')[0];
        detectedImports.push(rawMod);

        if (FORBIDDEN_IMPORT_MODULES.includes(rootMod)) {
          violations.push({
            type: SANDBOX_ERROR_CODES.NETWORK_ACCESS_FORBIDDEN,
            detail: `Line ${lineNum}: Forbidden network/system module import '${rawMod}' detected.`,
            line: lineNum,
            token: rawMod,
          });
        }
      }
    }
  }

  return Object.freeze({
    safe: violations.length === 0,
    violations: Object.freeze(violations),
    detectedImports: Object.freeze([...new Set(detectedImports)]),
    detectedCommands: Object.freeze([...new Set(detectedCommands)]),
  });
}

// ── Docker Archive Parsing & Structural Verification (Remediation Items 10 & 13) ────

export interface DockerArchiveManifestEntry {
  readonly Config: string;
  readonly RepoTags?: readonly string[];
  readonly Layers?: readonly string[];
}

export interface DockerArchiveValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly manifest?: readonly DockerArchiveManifestEntry[];
  readonly config?: Record<string, unknown>;
  readonly user?: string;
  readonly entryNames?: readonly string[];
  readonly layerDigestsVerified?: boolean;
  readonly configDigestVerified?: boolean;
  readonly runtimeFilesVerified?: boolean;
}

interface TarIndexEntry {
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly typeflag: string;
}

/**
 * Parses a POSIX ustar tar archive buffer into a Map of relative file paths to their content Buffers.
 * Rejects archives with malformed headers or invalid ustar magic bytes.
 */
export function parseTarArchiveEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  if (buffer.length < 512) {
    throw new SandboxError(
      SANDBOX_ERROR_CODES.INVALID_DOCKER_ARCHIVE,
      `Archive buffer is too small (${buffer.length} bytes) to contain a 512-byte tar header block`,
    );
  }

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);

    // Two consecutive 512-byte zero blocks mark EOF in standard POSIX tar
    let isAllZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) {
      break;
    }

    // Name (0..100)
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
    // Prefix (345..500)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
    if (prefix) {
      name = `${prefix}/${name}`;
    }

    // Check magic (257..262) - POSIX tar requires 'ustar'
    const magic = header.subarray(257, 262).toString('ascii');
    if (!magic.startsWith('ustar')) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.INVALID_DOCKER_ARCHIVE,
        `Invalid tar header at offset ${offset}: missing POSIX 'ustar' magic identifier (got '${magic}')`,
      );
    }

    // Parse size (124..136) in octal
    const sizeStr = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8);
    if (isNaN(size) || size < 0) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.INVALID_DOCKER_ARCHIVE,
        `Invalid tar header at offset ${offset}: malformed entry size '${sizeStr}'`,
      );
    }

    // Typeflag (156..157): '0' or '\0' or '' is regular file
    const typeflag = header.subarray(156, 157).toString('ascii');
    const isRegularFile = typeflag === '0' || typeflag === '\0' || typeflag === '';

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;

    if (contentEnd > buffer.length) {
      throw new SandboxError(
        SANDBOX_ERROR_CODES.INVALID_DOCKER_ARCHIVE,
        `Truncated tar archive: entry '${name}' expects ${size} bytes but archive buffer ends at ${buffer.length}`,
      );
    }

    if (isRegularFile && name) {
      entries.set(name, buffer.subarray(contentStart, contentEnd));
    }

    // Next header begins at the next 512-byte boundary
    const paddedSize = Math.ceil(size / 512) * 512;
    offset = contentStart + paddedSize;
  }

  return entries;
}

/**
 * Validates the structure, cryptographic digests, and security posture of a Docker save archive (.tar):
 *   - Verifies file existence and minimum valid size (>= 1024 bytes)
 *   - Scans POSIX ustar formatting block-by-block without unbounded RAM buffering
 *   - Extracts and parses Docker manifest.json
 *   - Verifies expected repository tag (if provided)
 *   - Extracts container configuration JSON and verifies content SHA-256 against filename digest
 *   - Enforces non-root user configuration (User must be UID 10001, never root / 0)
 *   - Verifies all referenced layers exist and match their declared cryptographic layer digests
 *   - Deep-inspects layer contents to verify presence of required runtime files (python3, sandbox/workspace, numpy)
 *   - Rejects synthetic or hollow placeholder archives fail-closed
 */
export function validateDockerArchiveStructure(
  archivePath: string,
  expectedTag?: string,
): DockerArchiveValidationResult {
  const errors: string[] = [];

  if (!fs.existsSync(archivePath)) {
    return {
      valid: false,
      errors: Object.freeze([`Docker archive not found at ${archivePath}`]),
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(archivePath);
  } catch (err: any) {
    return {
      valid: false,
      errors: Object.freeze([`Failed to stat Docker archive: ${err.message}`]),
    };
  }

  if (!stat.isFile()) {
    return {
      valid: false,
      errors: Object.freeze([`Docker archive path ${archivePath} is not a regular file`]),
    };
  }

  if (stat.size < 1024) {
    return {
      valid: false,
      errors: Object.freeze([
        `Docker archive at ${archivePath} is too small (${stat.size} bytes) to be a valid Docker save archive (minimum 1024 bytes required)`,
      ]),
    };
  }

  let fd: number;
  try {
    fd = fs.openSync(archivePath, 'r');
  } catch (err: any) {
    return {
      valid: false,
      errors: Object.freeze([`Failed to open Docker archive: ${err.message}`]),
    };
  }

  try {
    const entries = new Map<string, TarIndexEntry>();
    const headerBuf = Buffer.alloc(512);
    let pos = 0;
    let consecutiveZeroBlocks = 0;

    while (pos + 512 <= stat.size) {
      fs.readSync(fd, headerBuf, 0, 512, pos);

      let isZeroBlock = true;
      for (let i = 0; i < 512; i++) {
        if (headerBuf[i] !== 0) {
          isZeroBlock = false;
          break;
        }
      }

      if (isZeroBlock) {
        consecutiveZeroBlocks++;
        if (consecutiveZeroBlocks >= 2) {
          break;
        }
        pos += 512;
        continue;
      }
      consecutiveZeroBlocks = 0;

      const magic = headerBuf.subarray(257, 262).toString('ascii');
      if (!magic.startsWith('ustar')) {
        return {
          valid: false,
          errors: Object.freeze([
            `Docker archive tar header parsing failed: Invalid tar header at offset ${pos}: missing POSIX 'ustar' magic identifier (got '${magic}')`,
          ]),
        };
      }

      let name = headerBuf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
      const prefix = headerBuf.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
      if (prefix) {
        name = `${prefix}/${name}`;
      }

      const sizeStr = headerBuf.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeStr, 8);
      if (isNaN(size) || size < 0) {
        return {
          valid: false,
          errors: Object.freeze([
            `Docker archive tar header parsing failed: Invalid tar header at offset ${pos}: malformed entry size '${sizeStr}'`,
          ]),
        };
      }

      const typeflag = headerBuf.subarray(156, 157).toString('ascii');
      const contentStart = pos + 512;
      const contentEnd = contentStart + size;

      if (contentEnd > stat.size) {
        return {
          valid: false,
          errors: Object.freeze([
            `Docker archive tar header parsing failed: Truncated tar archive: entry '${name}' expects ${size} bytes but archive buffer ends at ${stat.size}`,
          ]),
        };
      }

      if (name) {
        entries.set(name, {
          name,
          size,
          offset: contentStart,
          typeflag,
        });
      }

      const paddedSize = Math.ceil(size / 512) * 512;
      pos = contentStart + paddedSize;
    }

    const entryNames = Array.from(entries.keys());

    // 1. Verify manifest.json presence
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) {
      return {
        valid: false,
        errors: Object.freeze([
          `Docker archive is missing required 'manifest.json' entry. Found entries: [${entryNames.join(', ')}]`,
        ]),
        entryNames: Object.freeze(entryNames),
      };
    }

    // 2. Parse manifest.json
    let manifestEntries: DockerArchiveManifestEntry[];
    try {
      const manifestBuf = Buffer.alloc(manifestEntry.size);
      fs.readSync(fd, manifestBuf, 0, manifestEntry.size, manifestEntry.offset);
      manifestEntries = JSON.parse(manifestBuf.toString('utf8'));
      if (!Array.isArray(manifestEntries) || manifestEntries.length === 0) {
        throw new Error('manifest.json must contain a non-empty array of image specifications');
      }
    } catch (err: any) {
      return {
        valid: false,
        errors: Object.freeze([`Malformed manifest.json in Docker archive: ${err.message}`]),
        entryNames: Object.freeze(entryNames),
      };
    }

    const primaryEntry = manifestEntries[0];
    if (!primaryEntry.Config || typeof primaryEntry.Config !== 'string') {
      errors.push(`Docker manifest.json missing valid 'Config' file pointer`);
    }

    // 3. Verify RepoTags if expectedTag is specified
    if (expectedTag) {
      const hasTag = manifestEntries.some(
        (entry) => Array.isArray(entry.RepoTags) && entry.RepoTags.includes(expectedTag),
      );
      if (!hasTag) {
        const availableTags = manifestEntries.flatMap((e) => (e.RepoTags ? [...e.RepoTags] : []));
        errors.push(
          `Docker archive manifest does not contain expected tag '${expectedTag}'. Available tags: [${availableTags.join(', ')}]`,
        );
      }
    }

    // 4. Verify config file presence & parse JSON & verify content digest
    let configObj: Record<string, unknown> | undefined;
    let userSpec: string | undefined;
    let configDigestVerified = false;

    if (primaryEntry.Config) {
      const configEntry = entries.get(primaryEntry.Config);
      if (!configEntry) {
        errors.push(`Docker config file '${primaryEntry.Config}' referenced by manifest.json was not found in archive`);
      } else {
        const configBuf = Buffer.alloc(configEntry.size);
        fs.readSync(fd, configBuf, 0, configEntry.size, configEntry.offset);

        // Check if config filename has a 64-hex SHA-256 digest
        const configHashMatch = primaryEntry.Config.match(/([0-9a-f]{64})/i);
        if (configHashMatch) {
          const expectedConfigHash = configHashMatch[1].toLowerCase();
          const actualConfigHash = crypto.createHash('sha256').update(configBuf).digest('hex');
          if (actualConfigHash !== expectedConfigHash) {
            errors.push(
              `Docker archive config content hash mismatch: expected '${expectedConfigHash}', calculated '${actualConfigHash}' for '${primaryEntry.Config}'`,
            );
          } else {
            configDigestVerified = true;
          }
        }

        try {
          configObj = JSON.parse(configBuf.toString('utf8'));
          const containerConfig = (configObj?.config || configObj?.container_config || {}) as Record<string, any>;
          userSpec = typeof containerConfig.User === 'string' ? containerConfig.User.trim() : undefined;

          if (!userSpec) {
            errors.push(
              `Docker archive config '${primaryEntry.Config}' does not specify a non-root 'User'. Root execution is forbidden.`,
            );
          } else {
            // Reject root execution configurations: "0", "0:0", "root", etc.
            const uidPart = userSpec.split(':')[0].trim().toLowerCase();
            if (uidPart === '0' || uidPart === 'root') {
              errors.push(
                `Docker archive config specifies forbidden root user (User='${userSpec}'). Execution as root is strictly prohibited.`,
              );
            } else if (uidPart !== '10001' && !uidPart.startsWith('10001')) {
              errors.push(
                `Docker archive config specifies unexpected user '${userSpec}'. Expected UID 10001 for container-isolated sandbox.`,
              );
            }
          }
        } catch (err: any) {
          errors.push(`Failed to parse Docker config file '${primaryEntry.Config}': ${err.message}`);
        }
      }
    }

    // 5. Verify layer presence and layer digests
    let layerDigestsVerified = false;
    if (!Array.isArray(primaryEntry.Layers) || primaryEntry.Layers.length === 0) {
      errors.push(`Docker manifest.json does not specify any 'Layers'`);
    } else {
      const chunk = Buffer.alloc(64 * 1024);
      let allLayersMatched = true;

      for (const layerName of primaryEntry.Layers) {
        const layerInfo = entries.get(layerName);
        if (!layerInfo) {
          errors.push(`Docker layer file '${layerName}' referenced by manifest.json was not found in archive`);
          allLayersMatched = false;
          continue;
        }

        const layerHashMatch = layerName.match(/([0-9a-f]{64})/i);
        if (layerHashMatch) {
          const expectedLayerHash = layerHashMatch[1].toLowerCase();
          const hasher = crypto.createHash('sha256');
          let rem = layerInfo.size;
          let curOffset = layerInfo.offset;
          while (rem > 0) {
            const toRead = Math.min(rem, chunk.length);
            fs.readSync(fd, chunk, 0, toRead, curOffset);
            hasher.update(chunk.subarray(0, toRead));
            curOffset += toRead;
            rem -= toRead;
          }
          const actualLayerHash = hasher.digest('hex');
          if (actualLayerHash !== expectedLayerHash) {
            errors.push(
              `Docker layer digest mismatch for '${layerName}': expected '${expectedLayerHash}', calculated '${actualLayerHash}'`,
            );
            allLayersMatched = false;
          }
        }
      }

      if (allLayersMatched) {
        layerDigestsVerified = true;
      }
    }

    // 6. Deep layer runtime files inspection (python3, sandbox/workspace, numpy)
    let foundPython = false;
    let foundWorkspace = false;
    let foundNumpy = false;
    let runtimeFilesVerified = false;

    if (Array.isArray(primaryEntry.Layers) && primaryEntry.Layers.length > 0) {
      const sortedLayers = [...primaryEntry.Layers]
        .map((layerName) => entries.get(layerName))
        .filter((l): l is TarIndexEntry => Boolean(l && l.offset))
        .sort((a, b) => a.size - b.size);

      for (const layer of sortedLayers) {
        if (foundPython && foundWorkspace && foundNumpy) break;
        if (layer.size > 35 * 1024 * 1024) continue;

        const layerBuf = Buffer.alloc(layer.size);
        fs.readSync(fd, layerBuf, 0, layer.size, layer.offset);

        let unzipped: Buffer;
        if (layerBuf.length >= 2 && layerBuf[0] === 0x1f && layerBuf[1] === 0x8b) {
          try {
            unzipped = zlib.gunzipSync(layerBuf);
          } catch {
            continue;
          }
        } else {
          unzipped = layerBuf;
        }

        let p = 0;
        while (p + 512 <= unzipped.length) {
          const h = unzipped.subarray(p, p + 512);
          let isZ = true;
          for (let i = 0; i < 512; i++) {
            if (h[i] !== 0) {
              isZ = false;
              break;
            }
          }
          if (isZ) break;

          let n = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
          const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
          if (prefix) n = `${prefix}/${n}`;

          const sStr = h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
          const s = parseInt(sStr, 8);

          if (n.includes('python3') && (n.includes('bin/') || n.endsWith('python3'))) {
            foundPython = true;
          }
          if (n.includes('sandbox/workspace') || n === 'sandbox/workspace' || n === 'sandbox/workspace/') {
            foundWorkspace = true;
          }
          if (n.includes('numpy') || n.includes('numpy-')) {
            foundNumpy = true;
          }

          p += 512 + Math.ceil((isNaN(s) ? 0 : s) / 512) * 512;
        }
      }
    }

    const missingFiles: string[] = [];
    if (!foundPython) missingFiles.push('python3');
    if (!foundWorkspace) missingFiles.push('sandbox/workspace');
    if (!foundNumpy) missingFiles.push('numpy');

    if (missingFiles.length > 0) {
      errors.push(`Docker archive missing required runtime files in layers: [${missingFiles.join(', ')}]`);
    } else {
      runtimeFilesVerified = true;
    }

    return Object.freeze({
      valid: errors.length === 0,
      errors: Object.freeze(errors),
      manifest: Object.freeze(manifestEntries),
      config: configObj,
      user: userSpec,
      entryNames: Object.freeze(entryNames),
      layerDigestsVerified,
      configDigestVerified,
      runtimeFilesVerified,
    });
  } finally {
    fs.closeSync(fd);
  }
}
