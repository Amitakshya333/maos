/**
 * UI1-04: Project Host Launcher and Verification Protocol
 *
 * Implements the sovereign host launcher protocol:
 *   1. Pre-launch Project Folder Validation (fails closed)
 *   2. Dedicated Child Process Host Spawning (piped stdout + IPC)
 *   3. Structured HostReadinessEnvelope Decoding (never scrape logs)
 *   4. Independent Verification (Liveness, Loopback Port, TCP, Identity File, Hashes)
 *   5. Zero-Orphan Process Guarantee (Tree termination on failure/exit)
 *   6. Concurrent Project Management
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as readline from 'readline';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import {
  validateProjectFolder,
  assertValidProjectFolder,
  CanonicalProjectFolder,
  ProjectValidationOptions,
} from './validator';
import {
  ServiceInstanceIdentity,
  computeProjectRootHash,
  computeExecutableHash,
  readServiceIdentity,
  clearServiceIdentity,
} from './instance-identity';
import type { SessionInfo } from './session';
import type { HostReadinessEnvelope, HostErrorEnvelope } from './entrypoint';
import {
  RecentProjectStore,
  RecentProjectStoreOptions,
  RecentProject,
  RecentProjectStatus,
} from './recent-projects';

export interface ProjectHostLauncherOptions {
  /**
   * Path to executable. Defaults to process.execPath (Node).
   */
  readonly executablePath?: string;

  /**
   * Explicit path to host entrypoint script.
   */
  readonly entrypointPath?: string;

  /**
   * Default loopback interface to bind to. Default: '127.0.0.1'.
   */
  readonly defaultHost?: string;

  /**
   * Milliseconds to wait for child readiness before aborting. Default: 10,000 ms.
   */
  readonly timeoutMs?: number;

  /**
   * Whether to allow project roots located inside temporary directories.
   * Default: false (enforces sovereign directory isolation).
   */
  readonly allowTemp?: boolean;

  /**
   * Whether to allow symlinked project roots. Default: false.
   */
  readonly allowSymlinks?: boolean;

  /**
   * Custom recent projects store instance.
   */
  readonly recentStore?: RecentProjectStore;

  /**
   * Options for auto-instantiated RecentProjectStore.
   */
  readonly recentStoreOptions?: RecentProjectStoreOptions;
}


export interface LaunchOptions extends ProjectValidationOptions {
  /**
   * Explicit port to bind to. Default: 0 (ephemeral loopback port).
   */
  readonly port?: number;

  /**
   * Loopback host to bind to. Default: '127.0.0.1'.
   */
  readonly host?: string;

  /**
   * Timeout in milliseconds for host startup and verification.
   */
  readonly timeoutMs?: number;

  /**
   * Expected SHA-256 hash of the child executable.
   */
  readonly expectedExecutableHash?: string;

  /**
   * If true, returns already-running host instance instead of throwing ALREADY_RUNNING.
   */
  readonly reuseExisting?: boolean;

  /**
   * Custom environment variables for the child process.
   */
  readonly env?: NodeJS.ProcessEnv;

  /**
   * Additional CLI arguments to pass to the entrypoint.
   */
  readonly extraArgs?: string[];

  /**
   * Path to entrypoint script override.
   */
  readonly entrypointPath?: string;

  /**
   * If true, skips updating recent projects metadata on launch.
   */
  readonly skipRecentRecord?: boolean;
}


export interface LaunchedProjectHost {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly projectRoot: string;
  readonly projectRootHash: string;
  readonly serviceInstanceId: string;
  readonly identity: ServiceInstanceIdentity;
  readonly project: CanonicalProjectFolder;
  readonly readiness: HostReadinessEnvelope;

  /**
   * Check if child process is still actively running.
   */
  isAlive(): boolean;

  /**
   * Cleanly stop this host, terminate child process tree, and clear recorded identity.
   */
  stop(): Promise<void>;

  /**
   * Request a new per-window session token from the running host.
   */
  createSession(windowId?: string, timeoutMs?: number): Promise<SessionInfo>;

  /**
   * Ping running host over IPC/stdin to measure IPC latency.
   */
  ping(timeoutMs?: number): Promise<number>;
}

export class LauncherError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'LauncherError';
    this.code = code;
  }
}

/**
 * Check if a process with given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate a process and all its descendants (process tree).
 * On Windows: taskkill /T /F /PID <pid>
 * On Unix: SIGKILL to process group or pid
 */
export async function killProcessTree(pid: number, timeoutMs = 3000): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process may have exited
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process may have exited
      }
    }
  }

  // Poll briefly to verify termination
  const start = Date.now();
  while (isProcessAlive(pid) && Date.now() - start < 1000) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Independently test if a TCP port on host is actively accepting connections.
 */
export function verifyTcpListening(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      resolve(true);
    });
    socket.once('timeout', () => {
      cleanup();
      resolve(false);
    });
    socket.once('error', () => {
      cleanup();
      resolve(false);
    });

    const connectHost = host === 'localhost' ? '127.0.0.1' : host;
    socket.connect(port, connectHost);
  });
}

/**
 * Resolve the appropriate entrypoint script (.js or .ts).
 */
export function resolveEntrypoint(customPath?: string): { scriptPath: string; isTs: boolean } {
  if (customPath) {
    const resolved = path.resolve(customPath);
    return { scriptPath: resolved, isTs: resolved.endsWith('.ts') };
  }

  // Check compiled JS in same directory
  const distSameDir = path.resolve(__dirname, 'entrypoint.js');
  if (fs.existsSync(distSameDir)) {
    return { scriptPath: distSameDir, isTs: false };
  }

  // Check dist from workspace root
  const distRoot = path.resolve(process.cwd(), 'dist', 'service', 'project-service', 'entrypoint.js');
  if (fs.existsSync(distRoot)) {
    return { scriptPath: distRoot, isTs: false };
  }

  // Check TS in same directory
  const tsSameDir = path.resolve(__dirname, 'entrypoint.ts');
  if (fs.existsSync(tsSameDir)) {
    return { scriptPath: tsSameDir, isTs: true };
  }

  // Check TS in src/service/project-service
  const tsRoot = path.resolve(process.cwd(), 'src', 'service', 'project-service', 'entrypoint.ts');
  if (fs.existsSync(tsRoot)) {
    return { scriptPath: tsRoot, isTs: true };
  }

  return { scriptPath: distSameDir, isTs: false };
}

interface ActiveHostRecord {
  readonly child: ChildProcess;
  readonly canonicalPath: string;
  readonly host: LaunchedProjectHost;
  isAlive: boolean;
}

const activeLauncherInstances = new Set<ProjectHostLauncher>();
let processExitHandlerInstalled = false;

function ensureGlobalExitHandler(): void {
  if (processExitHandlerInstalled) return;
  processExitHandlerInstalled = true;

  process.once('exit', () => {
    for (const launcher of activeLauncherInstances) {
      launcher.cleanupSync();
    }
    activeLauncherInstances.clear();
  });
}

export class ProjectHostLauncher {
  private readonly options: ProjectHostLauncherOptions;
  private readonly activeHosts = new Map<string, ActiveHostRecord>();
  private readonly recentStore: RecentProjectStore;

  constructor(options: ProjectHostLauncherOptions = {}) {
    this.options = options;
    this.recentStore =
      options.recentStore ??
      new RecentProjectStore({
        allowTemp: options.allowTemp,
        allowSymlinks: options.allowSymlinks,
        ...options.recentStoreOptions,
      });
    activeLauncherInstances.add(this);
    ensureGlobalExitHandler();
  }


  /**
   * Synchronous cleanup on process exit.
   */
  cleanupSync(): void {
    for (const [projectRoot, record] of this.activeHosts.entries()) {
      if (record.child.pid && isProcessAlive(record.child.pid)) {
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/T', '/F', '/PID', String(record.child.pid)], {
              windowsHide: true,
              stdio: 'ignore',
            });
          } else {
            process.kill(record.child.pid, 'SIGKILL');
          }
        } catch {
          // Best effort during exit
        }
        clearServiceIdentity(projectRoot);
      }
    }
    this.activeHosts.clear();
  }


  /**
   * Launch and verify a project service host for the given project folder.
   */
  async launch(folderPath: string, options: LaunchOptions = {}): Promise<LaunchedProjectHost> {
    const allowTemp = options.allowTemp ?? this.options.allowTemp ?? false;
    const allowSymlinks = options.allowSymlinks ?? this.options.allowSymlinks ?? false;

    // 1. Pre-launch Project Folder Validation (fails closed immediately)
    const validation = validateProjectFolder(folderPath, {
      allowTemp,
      allowSymlinks,
      requiredSchemaVersion: options.requiredSchemaVersion,
    });

    if (!validation.valid || !validation.project) {
      throw new LauncherError(
        validation.code || 'PROJECT_VALIDATION_FAILED',
        validation.message || 'Project folder validation failed.',
      );
    }

    const project = validation.project;
    const canonicalPath = project.canonicalPath;

    // 2. Concurrency check: already running in this launcher?
    if (this.activeHosts.has(canonicalPath)) {
      const active = this.activeHosts.get(canonicalPath)!;
      if (active.isAlive && active.child.pid && isProcessAlive(active.child.pid)) {
        if (options.reuseExisting) {
          return active.host;
        }
        throw new LauncherError(
          'ALREADY_RUNNING',
          `Project at '${canonicalPath}' is already running under PID ${active.child.pid}.`,
        );
      } else {
        // Child died previously, clear entry
        this.activeHosts.delete(canonicalPath);
      }
    }

    // 3. Stale identity file check
    const existingIdentity = readServiceIdentity(canonicalPath);
    if (existingIdentity) {
      if (isProcessAlive(existingIdentity.servicePid)) {
        throw new LauncherError(
          'ALREADY_RUNNING',
          `Project at '${canonicalPath}' is already being served by active external process PID ${existingIdentity.servicePid}.`,
        );
      } else {
        // Process is dead: clean up stale identity file before spawning
        clearServiceIdentity(canonicalPath);
      }
    }

    // 4. Resolve entrypoint & spawn arguments
    const executable = this.options.executablePath || process.execPath;
    const entrypoint = resolveEntrypoint(options.entrypointPath ?? this.options.entrypointPath);

    const cliArgs: string[] = [];
    if (entrypoint.isTs) {
      cliArgs.push('-r', 'ts-node/register');
    }
    cliArgs.push(entrypoint.scriptPath);
    cliArgs.push('--project-root', canonicalPath);

    const bindPort = options.port ?? 0;
    cliArgs.push('--port', String(bindPort));

    const bindHost = options.host ?? this.options.defaultHost ?? '127.0.0.1';
    cliArgs.push('--host', bindHost);

    if (allowTemp) {
      cliArgs.push('--allow-temp');
    }
    if (allowSymlinks) {
      cliArgs.push('--allow-symlinks');
    }
    if (options.extraArgs) {
      cliArgs.push(...options.extraArgs);
    }

    // 5. Spawn child process
    let child: ChildProcess;
    try {
      child = spawn(executable, cliArgs, {
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        detached: false,
        windowsHide: true,
      });
    } catch (err: any) {
      throw new LauncherError('SPAWN_FAILED', `Failed to spawn project service child process: ${err.message}`);
    }

    if (!child.pid) {
      throw new LauncherError('SPAWN_FAILED', 'Failed to obtain PID for spawned project service child process.');
    }

    const childPid = child.pid;
    let isTerminated = false;

    // Helper to kill this child and clean up on any failure
    const abortAndCleanup = async () => {
      if (isTerminated) return;
      isTerminated = true;
      await killProcessTree(childPid);
      clearServiceIdentity(canonicalPath);
    };

    // 6. Wait for HostReadinessEnvelope or early termination
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 10000;

    let readiness: HostReadinessEnvelope;
    try {
      readiness = await new Promise<HostReadinessEnvelope>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          await abortAndCleanup();
          reject(new LauncherError('STARTUP_TIMEOUT', `Project service host failed to start within ${timeoutMs}ms.`));
        }, timeoutMs);

        const onEarlyExit = async (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          await abortAndCleanup();
          reject(
            new LauncherError(
              'HOST_EXITED_PREMATURELY',
              `Project service child process exited before signaling readiness (code=${code}, signal=${signal}).`,
            ),
          );
        };

        child.once('exit', onEarlyExit);

        const onMessage = async (msg: any) => {
          if (settled || !msg || typeof msg !== 'object') return;
          if (msg.type === 'service_ready') {
            settled = true;
            clearTimeout(timer);
            child.removeListener('exit', onEarlyExit);
            resolve(msg as HostReadinessEnvelope);
          } else if (msg.type === 'service_error') {
            settled = true;
            clearTimeout(timer);
            child.removeListener('exit', onEarlyExit);
            await abortAndCleanup();
            reject(new LauncherError(msg.code || 'HOST_START_FAILED', msg.message || 'Host emitted error envelope.'));
          }
        };

        // Listen over IPC
        child.on('message', onMessage);

        // Also listen over stdout lines
        if (child.stdout) {
          const rl = readline.createInterface({
            input: child.stdout,
            terminal: false,
          });

          rl.on('line', (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              const parsed = JSON.parse(trimmed);
              onMessage(parsed);
            } catch {
              // Ignore non-JSON stdout lines
            }
          });
        }
      });
    } catch (err) {
      await abortAndCleanup();
      throw err;
    }

    // 7. Independent Launcher Verification Protocol
    try {
      // (a) Envelope structure check
      if (readiness.type !== 'service_ready') {
        throw new LauncherError(
          'INVALID_READINESS_ENVELOPE',
          `Expected type 'service_ready', got '${(readiness as any).type}'.`,
        );
      }

      if (readiness.protocolVersion !== '1.0') {
        throw new LauncherError(
          'INCOMPATIBLE_PROTOCOL_VERSION',
          `Incompatible service protocol version '${readiness.protocolVersion}'. Expected '1.0'.`,
        );
      }

      if (typeof readiness.pid !== 'number' || readiness.pid <= 0) {
        throw new LauncherError('INVALID_READINESS_ENVELOPE', 'Readiness envelope missing valid PID.');
      }

      if (typeof readiness.port !== 'number' || readiness.port <= 0 || readiness.port > 65535) {
        throw new LauncherError(
          'VERIFICATION_PORT_INVALID',
          `Readiness envelope port ${readiness.port} is outside valid range (1-65535).`,
        );
      }

      // (b) Loopback interface check
      if (
        readiness.host !== '127.0.0.1' &&
        readiness.host !== '::1' &&
        readiness.host !== 'localhost'
      ) {
        throw new LauncherError(
          'VERIFICATION_HOST_NON_LOOPBACK',
          `Host interface '${readiness.host}' is forbidden. Must be loopback (127.0.0.1 or ::1).`,
        );
      }

      // (c) PID match and process liveness check
      if (readiness.pid !== childPid) {
        throw new LauncherError(
          'VERIFICATION_PID_MISMATCH',
          `Reported PID ${readiness.pid} does not match spawned child PID ${childPid}.`,
        );
      }

      if (!isProcessAlive(childPid)) {
        throw new LauncherError(
          'HOST_EXITED_PREMATURELY',
          `Child process PID ${childPid} is not alive after readiness.`,
        );
      }

      // (d) Project root and hash verification
      const expectedProjectRootHash = computeProjectRootHash(canonicalPath);
      if (readiness.projectRootHash !== expectedProjectRootHash) {
        throw new LauncherError(
          'VERIFICATION_ROOT_HASH_MISMATCH',
          `Project root hash mismatch. Reported: ${readiness.projectRootHash}, expected: ${expectedProjectRootHash}.`,
        );
      }

      const reportedResolved = path.resolve(readiness.projectRoot).toLowerCase();
      if (reportedResolved !== canonicalPath.toLowerCase()) {
        throw new LauncherError(
          'VERIFICATION_ROOT_PATH_MISMATCH',
          `Project root mismatch. Reported: '${readiness.projectRoot}', expected: '${canonicalPath}'.`,
        );
      }

      // (e) Executable hash check (if expected hash provided)
      if (options.expectedExecutableHash) {
        if (readiness.executableHash !== options.expectedExecutableHash) {
          throw new LauncherError(
            'VERIFICATION_EXECUTABLE_HASH_MISMATCH',
            `Executable hash mismatch. Reported: ${readiness.executableHash}, expected: ${options.expectedExecutableHash}.`,
          );
        }
      }

      // (f) Independent TCP connectivity check
      const isListening = await verifyTcpListening(readiness.host, readiness.port, 3000);
      if (!isListening) {
        throw new LauncherError(
          'VERIFICATION_PORT_UNREACHABLE',
          `Child service port ${readiness.port} on ${readiness.host} is not accepting TCP connections.`,
        );
      }

      // (g) Durably recorded service identity verification
      const recorded = readServiceIdentity(canonicalPath);
      if (!recorded) {
        throw new LauncherError(
          'VERIFICATION_IDENTITY_FILE_INVALID',
          `Service identity file was not recorded in '${canonicalPath}/.maos/status/service-identity.json'.`,
        );
      }

      if (recorded.servicePid !== childPid) {
        throw new LauncherError(
          'VERIFICATION_IDENTITY_FILE_INVALID',
          `Recorded servicePid (${recorded.servicePid}) does not match child PID (${childPid}).`,
        );
      }

      if (recorded.servicePort !== readiness.port) {
        throw new LauncherError(
          'VERIFICATION_IDENTITY_FILE_INVALID',
          `Recorded servicePort (${recorded.servicePort}) does not match readiness port (${readiness.port}).`,
        );
      }

      if (recorded.serviceInstanceId !== readiness.serviceInstanceId) {
        throw new LauncherError(
          'VERIFICATION_IDENTITY_FILE_INVALID',
          `Recorded serviceInstanceId mismatch.`,
        );
      }

      if (recorded.projectRootHash !== expectedProjectRootHash) {
        throw new LauncherError(
          'VERIFICATION_IDENTITY_FILE_INVALID',
          `Recorded projectRootHash mismatch.`,
        );
      }
    } catch (verificationErr) {
      await abortAndCleanup();
      throw verificationErr;
    }

    // 8. Construct LaunchedProjectHost handle
    let alive = true;
    const recordedIdentity = readServiceIdentity(canonicalPath)!;

    const stopFn = async () => {
      if (!alive) return;
      alive = false;
      this.activeHosts.delete(canonicalPath);

      // Send shutdown command first for clean session revocation
      if (child.connected) {
        try {
          child.send({ type: 'shutdown' });
        } catch {
          // Ignored
        }
      }

      // Wait a moment for graceful shutdown, then terminate tree
      await new Promise((r) => setTimeout(r, 100));
      await killProcessTree(childPid);
      clearServiceIdentity(canonicalPath);
    };

    child.once('exit', () => {
      alive = false;
      this.activeHosts.delete(canonicalPath);
      clearServiceIdentity(canonicalPath);
    });

    const createSessionFn = async (windowId?: string, sessionTimeoutMs = 5000): Promise<SessionInfo> => {
      if (!alive || !isProcessAlive(childPid)) {
        throw new LauncherError('SERVICE_DEAD', 'Cannot create session: project service process is not running.');
      }

      const reqId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      return new Promise<SessionInfo>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new LauncherError('SESSION_TIMEOUT', `Session creation timed out after ${sessionTimeoutMs}ms.`));
        }, sessionTimeoutMs);

        const onMsg = (msg: any) => {
          if (done || !msg || typeof msg !== 'object') return;
          if (msg.requestId === reqId) {
            if (msg.type === 'session_created') {
              done = true;
              clearTimeout(timer);
              cleanup();
              resolve(msg.session as SessionInfo);
            } else if (msg.type === 'session_error') {
              done = true;
              clearTimeout(timer);
              cleanup();
              reject(new LauncherError(msg.code || 'SESSION_ERROR', msg.message || 'Session creation failed.'));
            }
          }
        };

        const onLine = (line: string) => {
          try {
            const parsed = JSON.parse(line.trim());
            onMsg(parsed);
          } catch {
            // Ignored
          }
        };

        const cleanup = () => {
          child.removeListener('message', onMsg);
          if (rl) {
            rl.removeListener('line', onLine);
          }
        };

        let rl: readline.Interface | null = null;
        child.on('message', onMsg);

        if (child.stdout) {
          rl = readline.createInterface({ input: child.stdout, terminal: false });
          rl.on('line', onLine);
        }

        const cmd = { type: 'create_session', requestId: reqId, windowId };
        if (child.connected) {
          try {
            child.send(cmd);
          } catch {
            // Fallback to stdin
            if (child.stdin?.writable) {
              child.stdin.write(JSON.stringify(cmd) + '\n');
            }
          }
        } else if (child.stdin?.writable) {
          child.stdin.write(JSON.stringify(cmd) + '\n');
        } else {
          done = true;
          clearTimeout(timer);
          cleanup();
          reject(new LauncherError('CHANNEL_CLOSED', 'IPC and stdin channels are closed.'));
        }
      });
    };

    const pingFn = async (pingTimeoutMs = 3000): Promise<number> => {
      if (!alive || !isProcessAlive(childPid)) {
        throw new LauncherError('SERVICE_DEAD', 'Cannot ping: project service process is not running.');
      }

      const reqId = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const startTime = Date.now();

      return new Promise<number>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new LauncherError('PING_TIMEOUT', `Ping timed out after ${pingTimeoutMs}ms.`));
        }, pingTimeoutMs);

        const onMsg = (msg: any) => {
          if (done || !msg || typeof msg !== 'object') return;
          if (msg.requestId === reqId && msg.type === 'pong') {
            done = true;
            clearTimeout(timer);
            cleanup();
            resolve(Date.now() - startTime);
          }
        };

        const onLine = (line: string) => {
          try {
            const parsed = JSON.parse(line.trim());
            onMsg(parsed);
          } catch {
            // Ignored
          }
        };

        const cleanup = () => {
          child.removeListener('message', onMsg);
          if (rl) {
            rl.removeListener('line', onLine);
          }
        };

        let rl: readline.Interface | null = null;
        child.on('message', onMsg);

        if (child.stdout) {
          rl = readline.createInterface({ input: child.stdout, terminal: false });
          rl.on('line', onLine);
        }

        const cmd = { type: 'ping', requestId: reqId };
        if (child.connected) {
          try {
            child.send(cmd);
          } catch {
            if (child.stdin?.writable) {
              child.stdin.write(JSON.stringify(cmd) + '\n');
            }
          }
        } else if (child.stdin?.writable) {
          child.stdin.write(JSON.stringify(cmd) + '\n');
        } else {
          done = true;
          clearTimeout(timer);
          cleanup();
          reject(new LauncherError('CHANNEL_CLOSED', 'Cannot send ping: communication channels closed.'));
        }
      });
    };

    const launchedHost: LaunchedProjectHost = {
      pid: childPid,
      port: readiness.port,
      host: readiness.host,
      projectRoot: canonicalPath,
      projectRootHash: readiness.projectRootHash,
      serviceInstanceId: readiness.serviceInstanceId,
      identity: recordedIdentity,
      project,
      readiness,
      isAlive: () => alive && isProcessAlive(childPid),
      stop: stopFn,
      createSession: createSessionFn,
      ping: pingFn,
    };

    this.activeHosts.set(canonicalPath, {
      child,
      canonicalPath,
      host: launchedHost,
      isAlive: true,
    });

    // Durably record opened project in global recent history (unless skipped)
    if (!options.skipRecentRecord) {
      try {
        await this.recentStore.recordProjectOpened(canonicalPath, {
          allowTemp,
          allowSymlinks,
          requiredSchemaVersion: options.requiredSchemaVersion,
        });
      } catch {
        // Best effort: do not fail launch if recent store fails
      }
    }

    return launchedHost;
  }

  /**
   * Reopen a project by its stable projectId from recent history.
   * Revalidates folder existence, configuration, and project identity before launching.
   */
  async launchRecent(projectId: string, options: LaunchOptions = {}): Promise<LaunchedProjectHost> {
    const project = await this.recentStore.getRecentProject(projectId);
    if (!project) {
      throw new LauncherError(
        'PROJECT_NOT_FOUND',
        `Recent project with ID '${projectId}' was not found in registry.`,
      );
    }

    const allowTemp = options.allowTemp ?? this.options.allowTemp ?? false;
    const allowSymlinks = options.allowSymlinks ?? this.options.allowSymlinks ?? false;

    // Revalidate status against current filesystem
    const refreshed = await this.recentStore.refreshProjectStatus(projectId);
    const status = refreshed?.status ?? project.status;

    if (status === 'unavailable') {
      throw new LauncherError(
        'PROJECT_UNAVAILABLE',
        `Project '${project.displayName}' at '${project.canonicalPath}' is unavailable. Please check the folder or use Locate/Relocate.`,
      );
    }

    if (status === 'relocation_required') {
      throw new LauncherError(
        'RELOCATION_REQUIRED',
        `Project identity or path has changed for '${project.displayName}'. Explicit relocation or confirmation is required before launching.`,
      );
    }

    return this.launch(project.canonicalPath, {
      ...options,
      allowTemp,
      allowSymlinks,
    });
  }

  /**
   * Get the underlying RecentProjectStore instance.
   */
  getRecentStore(): RecentProjectStore {
    return this.recentStore;
  }

  /**
   * Stop a running project host by project root path. Idempotent.
   */
  async stop(folderPath: string): Promise<void> {
    const canonicalPath = path.resolve(folderPath);
    const active = this.activeHosts.get(canonicalPath);
    if (active) {
      await active.host.stop();
    } else {
      // Check if there is an identity file with a running process
      const recorded = readServiceIdentity(canonicalPath);
      if (recorded && isProcessAlive(recorded.servicePid)) {
        await killProcessTree(recorded.servicePid);
      }
      clearServiceIdentity(canonicalPath);
    }
  }

  /**
   * Stop all active project hosts managed by this launcher.
   */
  async stopAll(): Promise<void> {
    const hosts = Array.from(this.activeHosts.values());
    await Promise.all(hosts.map((h) => h.host.stop()));
    this.activeHosts.clear();
  }

  /**
   * Get an active host by project root, or undefined if not active.
   */
  getActiveHost(folderPath: string): LaunchedProjectHost | undefined {
    const canonicalPath = path.resolve(folderPath);
    const active = this.activeHosts.get(canonicalPath);
    if (active && active.isAlive && isProcessAlive(active.child.pid ?? 0)) {
      return active.host;
    }
    return undefined;
  }
}

