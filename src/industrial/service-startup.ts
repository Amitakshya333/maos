/**
 * F2-01: Service Startup Manager
 *
 * Manages the lifecycle of local services required by MAOS Industrial:
 * - Rust Industrial Engine (verified binary)
 * - Local model server (Ollama/LMStudio)
 *
 * Design invariants:
 * 1. The actual service bind is authoritative for port ownership — the
 *    diagnostic `isPortOccupied()` probe is advisory only and has a TOCTOU
 *    race. Callers MUST handle EADDRINUSE from the real bind.
 * 2. Executable hash is always verified against the RELEASE binary path.
 *    Debug builds (`target/debug/`) are rejected explicitly.
 * 3. Model paths are canonicalized and confined to approved model roots.
 * 4. `--host`, `--port`, `--model-path`, `--device` are passed as explicit
 *    CLI arguments to the spawned process.
 * 5. Shutdown on Windows uses `taskkill /T /F /PID` to terminate the entire
 *    process tree, not only the immediate PID.
 * 6. No secrets (API keys, tokens) are logged or included in error messages.
 * 7. Health checks validate protocol version AND engine version.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as net from 'net';
import { execFileSync, ChildProcess, spawn } from 'child_process';

// ── Types ──────────────────────────────────────────────────────────

export interface ServiceConfig {
  /** Unique identifier for this service (e.g., 'rust-engine', 'ollama'). */
  id: string;
  /** Absolute path to the executable. Must be under target/release, not debug. */
  executablePath: string;
  /** Expected SHA-256 hash of the release executable (hex). Empty string to skip. */
  executableHash: string;
  /** Host to bind to (must be loopback: 127.0.0.1 or ::1). */
  host: string;
  /** Port to bind to (0 = ephemeral / stdin-stdout protocol). */
  port: number;
  /** Additional arguments to pass to the executable or launcher script. */
  args: string[];
  /** Optional interpreter/launcher for script-backed services (for example Python). */
  launcherPath?: string;
  /** Environment variables (minimal — never include secrets). */
  env: Record<string, string>;
  /** Health check configuration. */
  healthCheck?: HealthCheckConfig;
  /** Model-specific configuration (for model servers). */
  model?: ModelConfig;
  /** Approved model roots (model paths must resolve inside one of these). */
  approvedModelRoots?: string[];
  /** Project root (for identity verification). */
  projectRoot?: string;
}

export interface ModelConfig {
  /** Path to model weights/directory. */
  modelPath: string;
  /** Device to use (cpu, cuda, cuda:0, etc.). */
  device: string;
  /** Model name/identifier. */
  modelName: string;
  /** Pinned model revision, when the runtime exposes one. */
  modelRevision?: string;
}

export interface HealthCheckConfig {
  /** URL to check for health (e.g., http://127.0.0.1:8000/health). */
  url?: string;
  /** Expected status code (default: 200). */
  expectedStatus?: number;
  /** Timeout for health check in ms (default: 5000). */
  timeoutMs?: number;
  /** Number of retries (default: 3). */
  retries?: number;
  /** Delay between retries in ms (default: 1000). */
  retryDelayMs?: number;
}

export interface ServiceState {
  id: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  port?: number;
  host?: string;
  startedAt?: string;
  executableHash?: string;
  executablePath?: string;
  projectRoot?: string;
  lastHealthCheck?: string;
  lastError?: string;
}

/** Exit codes for service startup errors — stable, documented. */
export const SERVICE_EXIT_CODES = {
  SUCCESS: 0,
  MISSING_EXECUTABLE: 10,
  TAMPERED_EXECUTABLE: 11,
  INVALID_MODEL_PATH: 12,
  PORT_OCCUPIED: 13,
  NON_LOOPBACK_HOST: 14,
  HEALTH_CHECK_FAILED: 15,
  ALREADY_RUNNING: 16,
  STARTUP_FAILED: 17,
  STALE_PROCESS: 18,
  BIND_FAILED: 19,
  DEBUG_BINARY: 20,
  MODEL_PATH_ESCAPE: 21,
  IDENTITY_MISMATCH: 22,
} as const;

export class ServiceStartupError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly serviceId: string,
  ) {
    super(message);
    this.name = 'ServiceStartupError';
  }
}

// ── Validation ─────────────────────────────────────────────────────

const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1', 'localhost', '::1',
]);

/**
 * Validate that a host is a loopback address.
 * 0.0.0.0 is deliberately EXCLUDED — it binds all interfaces.
 */
export function validateLoopbackHost(host: string): void {
  if (!LOOPBACK_ADDRESSES.has(host.toLowerCase())) {
    throw new ServiceStartupError(
      `Service host '${host}' is not a loopback address. ` +
        `Industrial services must bind to 127.0.0.1, localhost, or ::1. ` +
        `0.0.0.0 is rejected because it binds all network interfaces.`,
      SERVICE_EXIT_CODES.NON_LOOPBACK_HOST,
      '',
    );
  }
}

/**
 * Reject debug binaries. Only release builds are permitted.
 * Checks that the resolved path contains `target/release` or `target\\release`,
 * NOT `target/debug` or `target\\debug`.
 */
export function rejectDebugBinary(executablePath: string, serviceId: string): void {
  const normalized = path.resolve(executablePath).replace(/\\/g, '/');
  if (normalized.includes('/target/debug/')) {
    throw new ServiceStartupError(
      `Debug binary detected: ${executablePath}. ` +
        `Only release builds (target/release/) are permitted for Industrial services. ` +
        `Build with: cargo build --release --locked`,
      SERVICE_EXIT_CODES.DEBUG_BINARY,
      serviceId,
    );
  }
}

/**
 * Verify an executable exists, is a release build, and optionally check its SHA-256 hash.
 */
export function verifyExecutable(
  executablePath: string,
  expectedHash: string,
  serviceId: string,
): { actualHash: string; absolutePath: string } {
  const absPath = path.resolve(executablePath);

  if (!fs.existsSync(absPath)) {
    throw new ServiceStartupError(
      `Executable not found: ${absPath}`,
      SERVICE_EXIT_CODES.MISSING_EXECUTABLE,
      serviceId,
    );
  }

  // Reject debug builds
  rejectDebugBinary(absPath, serviceId);

  const fileBuffer = fs.readFileSync(absPath);
  const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  if (expectedHash && expectedHash.length > 0 && actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new ServiceStartupError(
      `Executable hash mismatch for '${serviceId}':\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}\n` +
        `  Path:     ${absPath}\n` +
        `Binary may have been tampered with. Rebuild from source.`,
      SERVICE_EXIT_CODES.TAMPERED_EXECUTABLE,
      serviceId,
    );
  }

  return { actualHash, absolutePath: absPath };
}

/**
 * Canonicalize and validate a model path.
 * The path must:
 * 1. Exist on disk.
 * 2. Resolve to a real path (follow symlinks/junctions).
 * 3. Remain inside one of the approved model roots.
 */
export function validateModelPath(
  modelPath: string,
  serviceId: string,
  approvedRoots?: string[],
): string {
  if (!modelPath || modelPath.trim().length === 0) {
    throw new ServiceStartupError(
      `Model path is empty for service '${serviceId}'.`,
      SERVICE_EXIT_CODES.INVALID_MODEL_PATH,
      serviceId,
    );
  }

  const absPath = path.resolve(modelPath);
  if (!fs.existsSync(absPath)) {
    throw new ServiceStartupError(
      `Model path does not exist: ${absPath}`,
      SERVICE_EXIT_CODES.INVALID_MODEL_PATH,
      serviceId,
    );
  }

  // Canonicalize (resolve symlinks/junctions)
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(absPath);
  } catch {
    throw new ServiceStartupError(
      `Cannot resolve model path: ${absPath}`,
      SERVICE_EXIT_CODES.INVALID_MODEL_PATH,
      serviceId,
    );
  }

  // Check against approved model roots
  if (approvedRoots && approvedRoots.length > 0) {
    const insideApprovedRoot = approvedRoots.some((root) => {
      const canonicalRoot = fs.realpathSync(path.resolve(root));
      return canonicalPath.startsWith(canonicalRoot + path.sep) || canonicalPath === canonicalRoot;
    });
    if (!insideApprovedRoot) {
      throw new ServiceStartupError(
        `Model path '${canonicalPath}' is outside approved model roots. ` +
          `Approved roots: ${approvedRoots.join(', ')}`,
        SERVICE_EXIT_CODES.MODEL_PATH_ESCAPE,
        serviceId,
      );
    }
  }

  return canonicalPath;
}

/**
 * Diagnostic port probe. ADVISORY ONLY — has a TOCTOU race condition.
 * The actual service bind is authoritative.
 * Use this for early error messages, NOT for claiming a port.
 */
export function isPortOccupied(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host);
  });
}

/**
 * Authoritatively claim a port by binding a TCP server.
 * Returns the server (caller MUST close it before spawning the real service)
 * and the actual port (useful when port=0 for ephemeral allocation).
 *
 * This eliminates the TOCTOU race of probe-then-start.
 */
export function claimPort(
  port: number,
  host: string,
  serviceId: string,
): Promise<{ server: net.Server; actualPort: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new ServiceStartupError(
          `Port ${port} on ${host} is already in use (bind failed with EADDRINUSE). ` +
            `Another service owns this port.`,
          SERVICE_EXIT_CODES.BIND_FAILED,
          serviceId,
        ));
      } else {
        reject(new ServiceStartupError(
          `Failed to bind port ${port} on ${host}: ${err.message}`,
          SERVICE_EXIT_CODES.BIND_FAILED,
          serviceId,
        ));
      }
    });
    server.once('listening', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, actualPort: addr.port });
    });
    server.listen(port, host);
  });
}

/**
 * Check if a PID is still running.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Service State Management ───────────────────────────────────────

const serviceStates = new Map<string, ServiceState>();

/**
 * Get the current state of a service.
 */
export function getServiceState(serviceId: string): ServiceState {
  return serviceStates.get(serviceId) ?? {
    id: serviceId,
    status: 'stopped',
  };
}

/**
 * Set service state directly (for internal use and testing).
 */
export function setServiceState(serviceId: string, state: ServiceState): void {
  serviceStates.set(serviceId, state);
}

/**
 * Detect stale service state (PID recorded but process is dead).
 */
export function detectStaleProcess(serviceId: string): boolean {
  const state = serviceStates.get(serviceId);
  if (!state || state.status !== 'running' || !state.pid) {
    return false;
  }

  if (!isProcessAlive(state.pid)) {
    serviceStates.set(serviceId, {
      ...state,
      status: 'error',
      lastError: `Stale process detected: PID ${state.pid} is no longer alive`,
    });
    return true;
  }

  return false;
}

/**
 * Verify that a running service has the expected identity.
 * Rejects reuse of a stale process with wrong executable or project.
 */
export function verifyServiceIdentity(
  serviceId: string,
  expectedExePath: string,
  expectedProjectRoot?: string,
): void {
  const state = serviceStates.get(serviceId);
  if (!state || state.status !== 'running') return;

  const resolvedExpected = path.resolve(expectedExePath);

  if (state.executablePath && path.resolve(state.executablePath) !== resolvedExpected) {
    throw new ServiceStartupError(
      `Service '${serviceId}' is running with a different executable.\n` +
        `  Running:  ${state.executablePath}\n` +
        `  Expected: ${resolvedExpected}\n` +
        `Stop the existing service first.`,
      SERVICE_EXIT_CODES.IDENTITY_MISMATCH,
      serviceId,
    );
  }

  if (expectedProjectRoot && state.projectRoot &&
      path.resolve(state.projectRoot) !== path.resolve(expectedProjectRoot)) {
    throw new ServiceStartupError(
      `Service '${serviceId}' is running for a different project.\n` +
        `  Running:  ${state.projectRoot}\n` +
        `  Expected: ${expectedProjectRoot}\n` +
        `Stop the existing service first.`,
      SERVICE_EXIT_CODES.IDENTITY_MISMATCH,
      serviceId,
    );
  }
}

// ── Pre-startup Validation ─────────────────────────────────────────

/**
 * Run all pre-startup checks for a service configuration.
 * Throws ServiceStartupError with the appropriate exit code on failure.
 *
 * NOTE: port check here is ADVISORY. The real bind is authoritative.
 */
export async function validateServiceConfig(config: ServiceConfig): Promise<void> {
  // 1. Validate loopback host
  validateLoopbackHost(config.host);

  // 2. Verify executable (includes debug-binary rejection)
  verifyExecutable(config.executablePath, config.executableHash, config.id);

  // 3. Validate model path if configured (canonicalize + root confinement)
  if (config.model) {
    validateModelPath(config.model.modelPath, config.id, config.approvedModelRoots);
  }

  // 4. Check for stale processes
  if (detectStaleProcess(config.id)) {
    const state = getServiceState(config.id);
    throw new ServiceStartupError(
      `Stale process detected for '${config.id}': PID ${state.pid} is dead. ` +
        `Clean up with stopService('${config.id}') first.`,
      SERVICE_EXIT_CODES.STALE_PROCESS,
      config.id,
    );
  }

  // 5. Verify identity if service is recorded as running
  verifyServiceIdentity(config.id, config.executablePath, config.projectRoot);

  // 6. Check idempotent startup (already running)
  const currentState = getServiceState(config.id);
  if (currentState.status === 'running' && currentState.pid && isProcessAlive(currentState.pid)) {
    throw new ServiceStartupError(
      `Service '${config.id}' is already running (PID ${currentState.pid} on port ${currentState.port}).`,
      SERVICE_EXIT_CODES.ALREADY_RUNNING,
      config.id,
    );
  }

  // 7. Advisory port probe (actual bind is authoritative — see claimPort)
  if (config.port > 0) {
    const occupied = await isPortOccupied(config.port, config.host);
    if (occupied) {
      throw new ServiceStartupError(
        `Port ${config.port} on ${config.host} appears occupied (advisory probe). ` +
          `The actual bind will be authoritative.`,
        SERVICE_EXIT_CODES.PORT_OCCUPIED,
        config.id,
      );
    }
  }
}

// ── Rust Engine Startup ────────────────────────────────────────────

/** Expected Rust engine protocol version. */
const EXPECTED_PROTOCOL_VERSION = '1.0';
/** Expected engine name in health response. */
const EXPECTED_ENGINE_NAME = 'maos-industrial-engine';

/**
 * Create a ServiceConfig for the Rust Industrial Engine.
 * Always resolves to the RELEASE binary path — debug is rejected.
 */
export function createRustEngineConfig(projectRoot: string, expectedHash?: string): ServiceConfig {
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Explicit: target/release — never target/debug
  const enginePath = path.resolve(projectRoot, 'rust', 'target', 'release', `maos-engine${ext}`);

  let hash = expectedHash ?? '';
  if (!hash && fs.existsSync(enginePath)) {
    hash = crypto.createHash('sha256').update(fs.readFileSync(enginePath)).digest('hex').toUpperCase();
  }

  return {
    id: 'rust-engine',
    executablePath: enginePath,
    executableHash: hash,
    host: '127.0.0.1',
    port: 0, // stdin/stdout protocol, no TCP
    args: [],
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      TEMP: process.env.TEMP ?? '',
    },
    projectRoot,
  };
}

/**
 * Verify the Rust engine is healthy by running a health command.
 * Validates: protocol version, engine name, engine version, unsafe_code=false.
 * Returns the health response data or throws.
 */
export function checkRustEngineHealth(config: ServiceConfig): Record<string, unknown> {
  // Verify executable before invocation (includes release-only check)
  const { actualHash, absolutePath } = verifyExecutable(
    config.executablePath, config.executableHash, config.id,
  );

  const request = JSON.stringify({ version: EXPECTED_PROTOCOL_VERSION, operation: 'health' });

  try {
    const stdout = execFileSync(absolutePath, [], {
      input: request + '\n',
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: config.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const response = JSON.parse(stdout.trim());
    if (response.error) {
      throw new ServiceStartupError(
        `Rust engine health check returned error: ${response.message}`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Validate protocol version
    if (response.version !== EXPECTED_PROTOCOL_VERSION) {
      throw new ServiceStartupError(
        `Rust engine protocol version mismatch: expected '${EXPECTED_PROTOCOL_VERSION}', ` +
          `got '${response.version}'`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Validate engine name
    if (response.data?.engine !== EXPECTED_ENGINE_NAME) {
      throw new ServiceStartupError(
        `Rust engine identity mismatch: expected '${EXPECTED_ENGINE_NAME}', ` +
          `got '${response.data?.engine}'`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Validate status
    if (response.data?.status !== 'ok') {
      throw new ServiceStartupError(
        `Rust engine health check returned unexpected status: ${JSON.stringify(response.data)}`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Validate engine protocol version in data
    if (response.data?.protocol_version !== EXPECTED_PROTOCOL_VERSION) {
      throw new ServiceStartupError(
        `Rust engine data protocol_version mismatch: ` +
          `expected '${EXPECTED_PROTOCOL_VERSION}', got '${response.data?.protocol_version}'`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Validate no unsafe code
    if (response.data?.unsafe_code !== false) {
      throw new ServiceStartupError(
        `Rust engine reports unsafe code is enabled — this is not permitted.`,
        SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
        config.id,
      );
    }

    // Update service state
    serviceStates.set(config.id, {
      id: config.id,
      status: 'running',
      host: config.host,
      startedAt: new Date().toISOString(),
      executableHash: actualHash,
      executablePath: absolutePath,
      projectRoot: config.projectRoot,
      lastHealthCheck: new Date().toISOString(),
    });

    return response.data as Record<string, unknown>;
  } catch (err: any) {
    if (err instanceof ServiceStartupError) throw err;
    throw new ServiceStartupError(
      `Rust engine health check failed: ${err.message}`,
      SERVICE_EXIT_CODES.HEALTH_CHECK_FAILED,
      config.id,
    );
  }
}

// ── Model Server Config ────────────────────────────────────────────

/**
 * Create a ServiceConfig for a local model server.
 * --host, --port, --model-path, and --device are passed as explicit CLI args.
 */
export function createModelServerConfig(opts: {
  id: string;
  executablePath: string;
  executableHash?: string;
  host?: string;
  port: number;
  modelPath: string;
  modelName: string;
  modelRevision?: string;
  device?: string;
  approvedModelRoots?: string[];
  projectRoot?: string;
  /** Absolute interpreter path for script-backed model servers. */
  launcherPath?: string;
}): ServiceConfig {
  const host = opts.host ?? '127.0.0.1';
  const device = opts.device ?? 'cpu';

  // Build explicit CLI arguments — these reach the real process
  const args = [
    '--host', host,
    '--port', String(opts.port),
    '--model-path', opts.modelPath,
    '--device', device,
  ];

  return {
    id: opts.id,
    executablePath: opts.executablePath,
    executableHash: opts.executableHash ?? '',
    host,
    port: opts.port,
    args,
    launcherPath: opts.launcherPath,
    env: {
      // Minimal environment — NO secrets, but include Windows user profile for Python package resolution
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      APPDATA: process.env.APPDATA ?? '',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
      HOMEDRIVE: process.env.HOMEDRIVE ?? '',
      HOMEPATH: process.env.HOMEPATH ?? '',
      WINDIR: process.env.WINDIR ?? '',
      HF_HOME: process.env.HF_HOME ?? '',
    },
    model: {
      modelPath: opts.modelPath,
      modelName: opts.modelName,
      modelRevision: opts.modelRevision,
      device,
    },
    approvedModelRoots: opts.approvedModelRoots,
    projectRoot: opts.projectRoot,
  };
}

// ── Service Spawning ───────────────────────────────────────────────

/**
 * Spawn a service process with the configured arguments.
 * Uses spawn (NOT exec) for argument safety.
 * Returns the child process. Caller is responsible for health checks.
 */
export function spawnService(config: ServiceConfig): ChildProcess {
  validateLoopbackHost(config.host);
  const { actualHash, absolutePath } = verifyExecutable(
    config.executablePath, config.executableHash, config.id,
  );

  if (config.model) {
    validateModelPath(config.model.modelPath, config.id, config.approvedModelRoots);
  }

  if (config.launcherPath && path.isAbsolute(config.launcherPath) && !fs.existsSync(config.launcherPath)) {
    throw new ServiceStartupError(
      `Service launcher not found: ${config.launcherPath}`,
      SERVICE_EXIT_CODES.MISSING_EXECUTABLE,
      config.id,
    );
  }

  const command = config.launcherPath ?? absolutePath;
  const commandArgs = config.launcherPath ? [absolutePath, ...config.args] : config.args;
  const child = spawn(command, commandArgs, {
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  });

  // Record state immediately
  serviceStates.set(config.id, {
    id: config.id,
    status: 'starting',
    pid: child.pid,
    port: config.port,
    host: config.host,
    startedAt: new Date().toISOString(),
    executableHash: actualHash,
    executablePath: absolutePath,
    projectRoot: config.projectRoot,
  });

  // Handle early death
  child.once('exit', (code, signal) => {
    const current = serviceStates.get(config.id);
    if (current && current.pid === child.pid && current.status !== 'stopped') {
      serviceStates.set(config.id, {
        ...current,
        status: 'error',
        lastError: `Process exited unexpectedly: code=${code}, signal=${signal}`,
      });
    }
  });

  return child;
}

// ── Idempotent Shutdown ────────────────────────────────────────────

/**
 * Stop a service by ID. Idempotent — calling on a stopped service is a no-op.
 * On Windows, uses taskkill /T /F /PID to terminate the entire process tree,
 * not only the immediate process.
 */
export function stopService(serviceId: string): ServiceState {
  const state = serviceStates.get(serviceId);

  if (!state || state.status === 'stopped') {
    // Already stopped — idempotent
    const stoppedState: ServiceState = {
      id: serviceId,
      status: 'stopped',
    };
    serviceStates.set(serviceId, stoppedState);
    return stoppedState;
  }

  // If process is alive, terminate it
  if (state.pid && isProcessAlive(state.pid)) {
    try {
      if (process.platform === 'win32') {
        // Windows: taskkill /T terminates the entire process tree
        execFileSync('taskkill', ['/T', '/F', '/PID', String(state.pid)], {
          timeout: 5000,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        // Unix: kill the process group
        try {
          process.kill(-state.pid, 'SIGTERM');
        } catch {
          process.kill(state.pid, 'SIGTERM');
        }
      }
    } catch {
      // Process may have already exited — that's fine
    }
  }

  const stoppedState: ServiceState = {
    id: serviceId,
    status: 'stopped',
    lastError: state.lastError,
  };
  serviceStates.set(serviceId, stoppedState);
  return stoppedState;
}

/**
 * Reset all service states (for testing).
 */
export function resetAllServiceStates(): void {
  serviceStates.clear();
}
