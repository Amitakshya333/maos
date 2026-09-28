/**
 * Bounded asynchronous child-process execution for offline engines.
 *
 * The caller supplies an executable and argument vector; shell evaluation is
 * never used. Output is bounded in memory and a timed-out process is killed
 * together with its descendants before the promise rejects.
 */

import { ChildProcess, spawn } from 'child_process';

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface BoundedProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type BoundedProcessFailureKind = 'timeout' | 'output_limit' | 'spawn';

export class BoundedProcessError extends Error {
  constructor(
    public readonly kind: BoundedProcessFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'BoundedProcessError';
  }
}

function terminateProcessTree(child: ChildProcess, graceMs = 750): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let finished = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve();
      };
      const fallbackKill = (): void => {
        try {
          child.kill();
        } catch {
          // The process may already have exited.
        }
        finish();
      };

      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', fallbackKill);
        killer.once('close', (status) => {
          if (status !== 0) fallbackKill();
          else finish();
        });
        // A broken taskkill executable or child process must not keep the
        // engine promise pending indefinitely.
        graceTimer = setTimeout(fallbackKill, graceMs);
      } catch {
        fallbackKill();
      }
    });
  }

  // The child is started detached below, so its process group can be killed
  // without leaving a Python grandchild behind after a timeout.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
  return Promise.resolve();
}

export function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new BoundedProcessError('timeout', 'Process timeout must be a positive integer'));
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    return Promise.reject(new BoundedProcessError('output_limit', 'Process output limit must be a positive integer'));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new BoundedProcessError('spawn', `Unable to start '${executable}': ${String(error)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forcedSettlementTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forcedSettlementTimer) clearTimeout(forcedSettlementTimer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
    };

    const forceRejectAfterKill = (kind: 'timeout' | 'output_limit'): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const message = kind === 'timeout'
        ? `Process exceeded ${options.timeoutMs} ms`
        : `Process output exceeded ${options.maxOutputBytes} bytes`;
      reject(new BoundedProcessError(kind, message));
    };

    const terminateAndBoundWait = (kind: 'timeout' | 'output_limit'): void => {
      void terminateProcessTree(child);
      // Normally ChildProcess emits close promptly. This fallback guarantees
      // a bounded result if taskkill/child termination is unavailable.
      forcedSettlementTimer = setTimeout(() => forceRejectAfterKill(kind), 1_000);
    };

    const failForLimit = (): void => {
      if (settled || outputLimitExceeded) return;
      outputLimitExceeded = true;
      terminateAndBoundWait('output_limit');
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > options.maxOutputBytes) {
        failForLimit();
        return;
      }
      stdout += text;
    });
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > options.maxOutputBytes) {
        failForLimit();
        return;
      }
      stderr += text;
    });

    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateAndBoundWait('timeout');
    }, options.timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new BoundedProcessError('spawn', `Unable to execute '${executable}': ${error.message}`));
    });

    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new BoundedProcessError('timeout', `Process exceeded ${options.timeoutMs} ms`));
      } else if (outputLimitExceeded) {
        reject(new BoundedProcessError('output_limit', `Process output exceeded ${options.maxOutputBytes} bytes`));
      } else {
        resolve({ status, signal, stdout, stderr });
      }
    });
  });
}
