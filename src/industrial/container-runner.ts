/**
 * MAOS Industrial — Container Runner (F8-02)
 *
 * Low-level execution gateway that spawns isolated Docker containers
 * using strictly discrete argument arrays (shell: false) and guarantees
 * resource limits, hard timeouts, bounded output, signal cancellation,
 * and zero container orphans.
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import {
  buildDockerRunArgs,
  ContainerRunOptions,
  CONTAINER_RUNNER_ERROR_CODES,
  ContainerRunnerError,
  SandboxRunStatus,
} from '../domain/sandbox-run';

export interface ContainerRunnerOptions {
  readonly executable?: string;
}

export interface RawContainerRunResult {
  readonly status: SandboxRunStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly containerName: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly interrupted: boolean;
}

export class ContainerRunner {
  private readonly executable: string;

  constructor(options: ContainerRunnerOptions = {}) {
    this.executable = options.executable || 'docker';
  }

  getExecutable(): string {
    return this.executable;
  }

  /**
   * Reads the digest Docker currently resolves for an image reference.
   *
   * RepoDigests are required; the mutable image tag and the local config ID
   * are deliberately not accepted as substitutes for an independently
   * observed content digest.
   */
  inspectImageDigest(imageRef: string): string {
    const result = spawnSync(
      this.executable,
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageRef],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    if (result.error || result.status !== 0) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_OBSERVATION_FAILED,
        `Docker could not independently inspect image '${imageRef}'.`,
        {
          imageRef,
          error: result.error?.message,
          stderr: result.stderr ? String(result.stderr).trim().slice(0, 500) : undefined,
        },
      );
    }

    let repoDigests: unknown;
    try {
      repoDigests = JSON.parse(String(result.stdout || '').trim());
    } catch (err: any) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_OBSERVATION_FAILED,
        `Docker returned malformed repository digest metadata for '${imageRef}'.`,
        { imageRef, error: err.message },
      );
    }

    if (!Array.isArray(repoDigests)) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_OBSERVATION_FAILED,
        `Docker returned no repository digest metadata for '${imageRef}'.`,
        { imageRef },
      );
    }

    const digest = repoDigests
      .map((entry) => String(entry))
      .map((entry) => entry.match(/@((?:sha256):[0-9a-f]{64})$/i)?.[1])
      .find((entry): entry is string => Boolean(entry));

    if (!digest) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_OBSERVATION_FAILED,
        `Docker returned no usable SHA-256 repository digest for '${imageRef}'.`,
        { imageRef, repoDigests },
      );
    }

    return digest.toLowerCase();
  }

  /**
   * Forcibly removes a container by name synchronously.
   * Guarantees zero orphaned containers on the host.
   */
  cleanupContainerSync(containerName: string): void {
    try {
      spawnSync(this.executable, ['rm', '-f', containerName], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // best effort cleanup
    }
  }

  /**
   * Forcibly removes a container by name if it exists.
   * Guarantees zero orphaned containers on the host.
   */
  async cleanupContainer(containerName: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const rmProc = spawn(this.executable, ['rm', '-f', containerName], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        rmProc.once('error', () => resolve());
        rmProc.once('close', () => resolve());
        // Do not wait more than 3 seconds for cleanup
        setTimeout(() => {
          try {
            rmProc.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 3000);
      } catch {
        resolve();
      }
    });
  }

  /**
   * Synchronously executes code inside an isolated container according to options.
   */
  runSync(options: ContainerRunOptions): RawContainerRunResult {
    const startTime = Date.now();
    const args = buildDockerRunArgs(options);
    const maxOutput = options.limits.maxOutputBytes;

    let timedOut = false;
    let outputLimitExceeded = false;
    let exitCode: number | null = null;
    let stdout = '';
    let stderr = '';
    let status: SandboxRunStatus = 'COMPLETED';

    try {
      const res = spawnSync(this.executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.limits.maxExecutionTimeMs,
        maxBuffer: maxOutput * 4,
        encoding: 'utf8',
      });

      if (res.error) {
        if ((res.error as any).code === 'ETIMEDOUT') {
          timedOut = true;
          status = 'TIMEOUT';
        } else if ((res.error as any).code === 'ENOBUFS') {
          outputLimitExceeded = true;
          status = 'OUTPUT_LIMIT';
        } else {
          throw new ContainerRunnerError(
            CONTAINER_RUNNER_ERROR_CODES.CONTAINER_SPAWN_FAILED,
            `Failed to spawn container runner executable '${this.executable}': ${res.error.message}`,
            { executable: this.executable, originalError: res.error.message },
          );
        }
      }

      stdout = res.stdout ? String(res.stdout) : '';
      stderr = res.stderr ? String(res.stderr) : '';
      exitCode = typeof res.status === 'number' ? res.status : null;

      if (stdout.length + stderr.length > maxOutput) {
        outputLimitExceeded = true;
        status = 'OUTPUT_LIMIT';
        const allowed = Math.max(0, maxOutput - stdout.length);
        if (stdout.length > maxOutput) {
          stdout = stdout.slice(0, maxOutput);
          stderr = '';
        } else {
          stderr = stderr.slice(0, allowed);
        }
      }

      if (timedOut) {
        this.cleanupContainerSync(options.containerName);
      } else if (exitCode !== 0 && status === 'COMPLETED') {
        status = 'FAILED';
      }
    } catch (err: any) {
      if (err instanceof ContainerRunnerError) throw err;
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.CONTAINER_EXECUTION_FAILED,
        `Synchronous container execution failed: ${err.message}`,
        { originalError: err.message },
      );
    } finally {
      this.cleanupContainerSync(options.containerName);
    }

    const durationMs = Date.now() - startTime;
    return {
      status,
      exitCode,
      stdout,
      stderr,
      durationMs,
      containerName: options.containerName,
      timedOut,
      outputLimitExceeded,
      interrupted: false,
    };
  }

  /**
   * Executes code inside an isolated container according to options.
   */
  async run(
    options: ContainerRunOptions,
    abortSignal?: AbortSignal,
  ): Promise<RawContainerRunResult> {
    const startTime = Date.now();
    const args = buildDockerRunArgs(options);

    return new Promise<RawContainerRunResult>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.executable, [...args], {
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err: any) {
        reject(
          new ContainerRunnerError(
            CONTAINER_RUNNER_ERROR_CODES.CONTAINER_SPAWN_FAILED,
            `Failed to spawn container runner executable '${this.executable}': ${err.message}`,
            { executable: this.executable, originalError: err.message },
          ),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let interrupted = false;
      let settled = false;

      let timeoutTimer: NodeJS.Timeout | undefined;
      let forceCleanupTimer: NodeJS.Timeout | undefined;

      const finish = async (
        status: SandboxRunStatus,
        exitCode: number | null,
      ): Promise<void> => {
        if (settled) return;
        settled = true;

        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceCleanupTimer) clearTimeout(forceCleanupTimer);
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }

        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');

        // Always ensure container is removed
        await this.cleanupContainer(options.containerName);

        const durationMs = Date.now() - startTime;
        resolve({
          status,
          exitCode,
          stdout,
          stderr,
          durationMs,
          containerName: options.containerName,
          timedOut,
          outputLimitExceeded,
          interrupted,
        });
      };

      const terminateAndClean = (reason: 'timeout' | 'limit' | 'abort'): void => {
        if (reason === 'timeout') timedOut = true;
        if (reason === 'limit') outputLimitExceeded = true;
        if (reason === 'abort') interrupted = true;

        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            }).once('error', () => {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            });
          } else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }

        // Bounded fallback: if child doesn't exit within 1500ms, force settlement
        forceCleanupTimer = setTimeout(() => {
          const status: SandboxRunStatus = interrupted
            ? 'INTERRUPTED'
            : timedOut
              ? 'TIMEOUT'
              : 'OUTPUT_LIMIT';
          void finish(status, null);
        }, 1500);
      };

      // AbortSignal listener
      let abortHandler: (() => void) | undefined;
      if (abortSignal) {
        if (abortSignal.aborted) {
          terminateAndClean('abort');
        } else {
          abortHandler = () => terminateAndClean('abort');
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      // Output stream handlers with strict byte caps
      const maxBytes = options.limits.maxOutputBytes;

      const handleData = (chunk: string | Buffer, isStderr: boolean): void => {
        if (settled || outputLimitExceeded) return;
        const text = chunk.toString();
        const chunkLen = Buffer.byteLength(text, 'utf8');

        if (outputBytes + chunkLen > maxBytes) {
          const allowed = Math.max(0, maxBytes - outputBytes);
          if (allowed > 0) {
            const truncated = Buffer.from(text, 'utf8').subarray(0, allowed).toString('utf8');
            if (isStderr) stderr += truncated;
            else stdout += truncated;
            outputBytes += allowed;
          }
          terminateAndClean('limit');
          return;
        }

        outputBytes += chunkLen;
        if (isStderr) stderr += text;
        else stdout += text;
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c) => handleData(c, false));
      child.stderr?.on('data', (c) => handleData(c, true));

      // Execution timeout timer
      timeoutTimer = setTimeout(() => {
        terminateAndClean('timeout');
      }, options.limits.maxExecutionTimeMs);

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceCleanupTimer) clearTimeout(forceCleanupTimer);
        void this.cleanupContainer(options.containerName);
        reject(
          new ContainerRunnerError(
            CONTAINER_RUNNER_ERROR_CODES.CONTAINER_SPAWN_FAILED,
            `Container process error: ${err.message}`,
            { error: err.message },
          ),
        );
      });

      child.once('close', (code) => {
        if (settled) return;

        let status: SandboxRunStatus = 'COMPLETED';
        let finalExitCode: number | null = code;

        if (interrupted) {
          status = 'INTERRUPTED';
          finalExitCode = null;
        } else if (timedOut) {
          status = 'TIMEOUT';
          finalExitCode = null;
        } else if (outputLimitExceeded) {
          status = 'OUTPUT_LIMIT';
          finalExitCode = null;
        } else if (code !== 0) {
          status = 'FAILED';
        }

        void finish(status, finalExitCode);
      });
    });
  }
}
