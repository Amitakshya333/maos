/**
 * F2-06: Service Health & Identity Manifests
 *
 * Every running service must declare and verify its identity:
 *   - version, protocol, executable/model revision
 *   - device, offline operations mode
 *   - mismatch or absent identity = UNHEALTHY
 *
 * Services:
 *   1. Launcher         — orchestration process
 *   2. Project Service   — per-project agent runtime
 *   3. Model Manager     — GPU model lifecycle
 *   4. Python/Model EP   — text-model, OCR, embedding, vision
 *   5. Rust Engine       — industrial analysis engine
 *
 * Each service has a ServiceIdentityManifest pinned at build time
 * and a runtime health probe that verifies the live service matches.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ── Types ──────────────────────────────────────────────────────────

export interface ServiceIdentityManifest {
  /** Unique service identifier. */
  serviceId: string;
  /** Human-readable service name. */
  name: string;
  /** Service version (semver). */
  version: string;
  /** Protocol version for IPC/API. */
  protocolVersion: string;
  /** SHA-256 of the executable (if applicable). */
  executableHash?: string;
  /** Model revision (if applicable). */
  modelRevision?: string;
  /** Model name (if applicable). */
  modelName?: string;
  /** Device type (cpu, cuda, mps). */
  device: string;
  /** Whether this service operates in offline mode only. */
  offlineOnly: boolean;
  /** Loopback host this service binds to. */
  host: string;
  /** Port this service binds to (0 = stdin/stdout). */
  port: number;
  /** Build timestamp (ISO 8601). */
  buildTimestamp: string;
  /** Platform this manifest was created on. */
  platform: string;
}

export interface HealthProbeResult {
  /** Service ID. */
  serviceId: string;
  /** Whether the probe passed. */
  healthy: boolean;
  /** Identity match status. */
  identityMatch: boolean;
  /** Individual check results. */
  checks: HealthCheck[];
  /** Probe latency in ms. */
  latencyMs: number;
  /** Timestamp of the probe. */
  timestamp: string;
}

export interface HealthCheck {
  /** Check name. */
  name: string;
  /** Passed? */
  passed: boolean;
  /** Expected value. */
  expected: string;
  /** Actual value. */
  actual: string;
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export interface ServiceHealthSummary {
  /** Overall status. */
  status: HealthStatus;
  /** Per-service results. */
  services: HealthProbeResult[];
  /** Services with identity mismatch. */
  mismatched: string[];
  /** Services with absent identity. */
  absent: string[];
  /** Timestamp. */
  timestamp: string;
}

// ── Manifest Registry ──────────────────────────────────────────────

const manifestRegistry = new Map<string, ServiceIdentityManifest>();

/**
 * Register a service identity manifest.
 */
export function registerManifest(manifest: ServiceIdentityManifest): void {
  manifestRegistry.set(manifest.serviceId, manifest);
}

/**
 * Get a registered manifest.
 */
export function getManifest(serviceId: string): ServiceIdentityManifest | undefined {
  return manifestRegistry.get(serviceId);
}

/**
 * Get all registered manifests.
 */
export function getAllManifests(): ServiceIdentityManifest[] {
  return Array.from(manifestRegistry.values());
}

/**
 * Clear all registered manifests (for testing).
 */
export function clearManifests(): void {
  manifestRegistry.clear();
}

// ── Manifest Creation ──────────────────────────────────────────────

/**
 * Create the Launcher service identity manifest.
 */
export function createLauncherManifest(version: string): ServiceIdentityManifest {
  return {
    serviceId: 'launcher',
    name: 'MAOS Launcher',
    version,
    protocolVersion: '1.0',
    device: 'cpu',
    offlineOnly: true,
    host: '127.0.0.1',
    port: 0, // ephemeral
    buildTimestamp: new Date().toISOString(),
    platform: process.platform,
  };
}

/**
 * Create the Project Service identity manifest.
 */
export function createProjectServiceManifest(
  version: string,
  port: number,
): ServiceIdentityManifest {
  return {
    serviceId: 'project-service',
    name: 'MAOS Project Service',
    version,
    protocolVersion: '1.0',
    device: 'cpu',
    offlineOnly: true,
    host: '127.0.0.1',
    port,
    buildTimestamp: new Date().toISOString(),
    platform: process.platform,
  };
}

/**
 * Create the Model Manager identity manifest.
 */
export function createModelManagerManifest(
  version: string,
  device: string,
): ServiceIdentityManifest {
  return {
    serviceId: 'model-manager',
    name: 'MAOS Model Manager',
    version,
    protocolVersion: '1.0',
    device,
    offlineOnly: true,
    host: '127.0.0.1',
    port: 0,
    buildTimestamp: new Date().toISOString(),
    platform: process.platform,
  };
}

/**
 * Create a Python/model endpoint identity manifest.
 */
export function createModelEndpointManifest(
  serviceId: string,
  name: string,
  version: string,
  port: number,
  modelName?: string,
  modelRevision?: string,
  device?: string,
): ServiceIdentityManifest {
  return {
    serviceId,
    name,
    version,
    protocolVersion: '1.0',
    modelName,
    modelRevision,
    device: device ?? 'cpu',
    offlineOnly: true,
    host: '127.0.0.1',
    port,
    buildTimestamp: new Date().toISOString(),
    platform: process.platform,
  };
}

/**
 * Create the Rust engine identity manifest.
 */
export function createRustEngineManifest(
  version: string,
  executableHash: string,
): ServiceIdentityManifest {
  return {
    serviceId: 'rust-engine',
    name: 'MAOS Industrial Engine',
    version,
    protocolVersion: '1.0',
    executableHash,
    device: 'cpu',
    offlineOnly: true,
    host: '127.0.0.1',
    port: 0, // stdin/stdout
    buildTimestamp: new Date().toISOString(),
    platform: process.platform,
  };
}

// ── Health Probes ──────────────────────────────────────────────────

/**
 * Probe a service's health and verify its identity against the manifest.
 */
export function probeServiceHealth(
  manifest: ServiceIdentityManifest,
  liveData?: Partial<ServiceIdentityManifest>,
): HealthProbeResult {
  const start = Date.now();
  const checks: HealthCheck[] = [];
  let identityMatch = true;

  if (!liveData) {
    return {
      serviceId: manifest.serviceId,
      healthy: false,
      identityMatch: false,
      checks: [{ name: 'reachable', passed: false, expected: 'running', actual: 'absent' }],
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  // Core identity is mandatory. Missing fields are not equivalent to a match.
  const versionMatch = liveData.version === manifest.version;
  checks.push({ name: 'version', passed: versionMatch, expected: manifest.version, actual: liveData.version ?? 'absent' });
  if (!versionMatch) identityMatch = false;

  const protocolMatch = liveData.protocolVersion === manifest.protocolVersion;
  checks.push({ name: 'protocolVersion', passed: protocolMatch, expected: manifest.protocolVersion, actual: liveData.protocolVersion ?? 'absent' });
  if (!protocolMatch) identityMatch = false;

  // Executable hash check
  if (manifest.executableHash) {
    const match = liveData.executableHash === manifest.executableHash;
    checks.push({ name: 'executableHash', passed: match, expected: manifest.executableHash.substring(0, 16) + '…', actual: liveData.executableHash ? liveData.executableHash.substring(0, 16) + '…' : 'absent' });
    if (!match) identityMatch = false;
  }

  // Model revision check
  if (manifest.modelRevision && liveData.modelRevision !== undefined) {
    const match = liveData.modelRevision === manifest.modelRevision;
    checks.push({ name: 'modelRevision', passed: match, expected: manifest.modelRevision, actual: liveData.modelRevision });
    if (!match) identityMatch = false;
  }

  // Model name check
  if (manifest.modelName && liveData.modelName !== undefined) {
    const match = liveData.modelName === manifest.modelName;
    checks.push({ name: 'modelName', passed: match, expected: manifest.modelName, actual: liveData.modelName });
    if (!match) identityMatch = false;
  }

  // Device check
  const deviceMatch = liveData.device === manifest.device;
  checks.push({ name: 'device', passed: deviceMatch, expected: manifest.device, actual: liveData.device ?? 'absent' });
  if (!deviceMatch) identityMatch = false;

  // Offline mode check
  const offlineMatch = liveData.offlineOnly === manifest.offlineOnly;
  checks.push({ name: 'offlineOnly', passed: offlineMatch, expected: String(manifest.offlineOnly), actual: liveData.offlineOnly === undefined ? 'absent' : String(liveData.offlineOnly) });
  if (!offlineMatch) identityMatch = false;

  // Host check (must be loopback)
  const hostMatch = liveData.host === manifest.host && (liveData.host === '127.0.0.1' || liveData.host === '::1');
  checks.push({ name: 'host', passed: hostMatch, expected: manifest.host, actual: liveData.host ?? 'absent' });
  if (!hostMatch) identityMatch = false;

  // Port check (port 0 denotes stdin/stdout and does not require a TCP port)
  if (manifest.port !== 0) {
    const portMatch = liveData.port === manifest.port;
    checks.push({ name: 'port', passed: portMatch, expected: String(manifest.port), actual: liveData.port === undefined ? 'absent' : String(liveData.port) });
    if (!portMatch) identityMatch = false;
  }

  return {
    serviceId: manifest.serviceId,
    healthy: identityMatch,
    identityMatch,
    checks,
    latencyMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ── Full Health Summary ────────────────────────────────────────────

/**
 * Probe all registered services and produce a summary.
 * Mismatch or absent identity = UNHEALTHY.
 */
export function probeAllServices(
  liveDataMap?: Map<string, Partial<ServiceIdentityManifest>>,
): ServiceHealthSummary {
  const manifests = getAllManifests();
  const services: HealthProbeResult[] = [];
  const mismatched: string[] = [];
  const absent: string[] = [];

  for (const manifest of manifests) {
    const liveData = liveDataMap?.get(manifest.serviceId);
    const result = probeServiceHealth(manifest, liveData);
    services.push(result);

    if (!liveData) {
      absent.push(manifest.serviceId);
    } else if (!result.identityMatch) {
      mismatched.push(manifest.serviceId);
    }
  }

  let status: HealthStatus;
  if (manifests.length === 0) {
    status = 'unknown';
  } else if (mismatched.length > 0 || absent.length > 0) {
    status = 'unhealthy';
  } else {
    status = 'healthy';
  }

  return {
    status,
    services,
    mismatched,
    absent,
    timestamp: new Date().toISOString(),
  };
}

// ── Manifest I/O ───────────────────────────────────────────────────

/**
 * Write all registered manifests to a directory.
 */
export function writeManifests(outputDir: string): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const manifest of getAllManifests()) {
    const filePath = path.join(outputDir, `${manifest.serviceId}.identity.json`);
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Load manifests from a directory and register them.
 */
export function loadManifests(inputDir: string): ServiceIdentityManifest[] {
  const loaded: ServiceIdentityManifest[] = [];

  if (!fs.existsSync(inputDir)) return loaded;

  const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.identity.json'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(inputDir, file), 'utf-8');
      const manifest = JSON.parse(content) as ServiceIdentityManifest;
      registerManifest(manifest);
      loaded.push(manifest);
    } catch {
      // Skip invalid files
    }
  }

  return loaded;
}

/**
 * Write a health summary to a file (for evidence).
 */
export function writeHealthSummary(summary: ServiceHealthSummary, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
}
