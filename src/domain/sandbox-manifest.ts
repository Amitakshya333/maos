import type { SandboxImageManifest } from './sandbox';
import { sha256Hex } from './sha256';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

/** Computes the canonical SHA-256 manifest hash without Node-only APIs. */
export function computeSandboxManifestHash(
  manifest: Omit<SandboxImageManifest, 'manifestHash'> | SandboxImageManifest,
): string {
  const clone: Record<string, unknown> = { ...manifest };
  delete clone.manifestHash;
  return sha256Hex(canonicalJson(clone));
}

/** Validates a raw object against the pinned sandbox manifest contract. */
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

  if (obj.schemaVersion !== 1) errors.push(`Invalid schemaVersion: expected 1, received ${obj.schemaVersion}`);
  if (typeof obj.imageName !== 'string' || !obj.imageName.trim()) errors.push('imageName must be a non-empty string');
  if (typeof obj.tag !== 'string' || !obj.tag.trim()) errors.push('tag must be a non-empty string');
  if (typeof obj.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(obj.imageDigest)) {
    errors.push(`Invalid imageDigest: must be sha256:<64-hex>, received '${obj.imageDigest}'`);
  }
  if (typeof obj.architecture !== 'string' || !obj.architecture.trim()) errors.push('architecture must be a non-empty string');
  if (typeof obj.baseImage !== 'string' || !obj.baseImage.trim()) errors.push('baseImage must be a non-empty string');
  if (typeof obj.pythonVersion !== 'string' || !obj.pythonVersion.trim()) errors.push('pythonVersion must be a non-empty string');

  if (!obj.user || typeof obj.user !== 'object') {
    errors.push('user specification must be an object');
  } else {
    if (typeof obj.user.name !== 'string' || !obj.user.name.trim()) errors.push('user.name must be a non-empty string');
    if (typeof obj.user.uid !== 'number' || !Number.isInteger(obj.user.uid) || obj.user.uid <= 0) {
      errors.push('user.uid must be a positive non-zero integer (non-root)');
    }
    if (obj.user.uid === 0 || obj.user.isRoot === true) {
      errors.push('Root execution is strictly forbidden: user.uid must not be 0 and user.isRoot must be false');
    }
    if (typeof obj.user.homeDir !== 'string' || !obj.user.homeDir.trim()) errors.push('user.homeDir must be a non-empty string');
  }

  if (obj.network !== 'none') errors.push(`network must be strictly 'none', received '${obj.network}'`);

  if (!obj.capabilities || typeof obj.capabilities !== 'object') {
    errors.push('capabilities must be an object');
  } else {
    if (obj.capabilities.dropAll !== true) errors.push('capabilities.dropAll must be true');
    if (obj.capabilities.noNewPrivileges !== true) errors.push('capabilities.noNewPrivileges must be true');
    if (obj.capabilities.readOnlyRootfs !== true) errors.push('capabilities.readOnlyRootfs must be true');
  }

  if (!obj.limits || typeof obj.limits !== 'object') {
    errors.push('limits must be an object');
  } else {
    if (typeof obj.limits.maxMemoryMb !== 'number' || obj.limits.maxMemoryMb <= 0) errors.push('limits.maxMemoryMb must be a positive number');
    if (typeof obj.limits.maxExecutionTimeMs !== 'number' || obj.limits.maxExecutionTimeMs <= 0) errors.push('limits.maxExecutionTimeMs must be a positive number');
    if (typeof obj.limits.maxOutputBytes !== 'number' || obj.limits.maxOutputBytes <= 0) errors.push('limits.maxOutputBytes must be a positive number');
  }

  if (!Array.isArray(obj.approvedPackages) || obj.approvedPackages.length === 0) {
    errors.push('approvedPackages must be a non-empty array of package specifications');
  } else {
    for (let i = 0; i < obj.approvedPackages.length; i++) {
      const pkg = obj.approvedPackages[i];
      if (!pkg || typeof pkg !== 'object') {
        errors.push(`approvedPackages[${i}] must be an object`);
        continue;
      }
      if (typeof pkg.name !== 'string' || !pkg.name.trim()) errors.push(`approvedPackages[${i}].name must be a non-empty string`);
      if (typeof pkg.version !== 'string' || !pkg.version.trim()) errors.push(`approvedPackages[${i}].version must be a non-empty string`);
      if (typeof pkg.importName !== 'string' || !pkg.importName.trim()) errors.push(`approvedPackages[${i}].importName must be a non-empty string`);
      if (typeof pkg.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pkg.sha256)) {
        errors.push(`approvedPackages[${i}].sha256 must be a valid 64-hex SHA-256 hash`);
      }
    }
  }

  if (!Array.isArray(obj.forbiddenRuntimeCommands) || obj.forbiddenRuntimeCommands.length === 0) {
    errors.push('forbiddenRuntimeCommands must be a non-empty array of string command names');
  }

  if (typeof obj.manifestHash !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.manifestHash)) {
    errors.push('manifestHash must be a valid 64-hex SHA-256 string');
  } else {
    const expectedHash = computeSandboxManifestHash(obj as SandboxImageManifest);
    if (expectedHash !== obj.manifestHash.toLowerCase()) {
      errors.push(`manifestHash mismatch: expected ${expectedHash}, received ${obj.manifestHash}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

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
      obj.approvedPackages.map((pkg: any) =>
        Object.freeze({
          name: String(pkg.name),
          version: String(pkg.version),
          importName: String(pkg.importName),
          sha256: String(pkg.sha256),
          required: Boolean(pkg.required),
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
