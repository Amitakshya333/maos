/**
 * MAOS Herdr Multi-Pane Action Harness
 *
 * Programmatic interface to the Herdr terminal multiplexer.
 * Provides multi-pane control, command execution, scrollback buffer
 * inspection, output waiting, agent lifecycle management, and prompt dispatch.
 *
 * Supports dual-mode transport:
 * 1. Low-latency JSON-RPC over Herdr IPC socket (Windows Named Pipe or Unix Domain Socket).
 * 2. Robust CLI fallback via the `herdr` executable.
 */

import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types & Enums
// ============================================================================

export type SplitDirection = 'right' | 'down' | 'horizontal' | 'vertical';

export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped' | 'recent_unwrapped' | 'detection';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  pane_id: string;
  agent: string;
  agent_status: AgentStatus;
  cwd?: string;
  name?: string;
  focused?: boolean;
  terminal_id?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  workspace_id?: string;
  tab_id?: string;
  revision?: number;
  state_change_seq?: number;
  [key: string]: any;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  focused?: boolean;
  agent_status?: AgentStatus;
  cwd?: string;
  revision?: number;
  [key: string]: any;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  source?: string;
  format?: string;
  text: string;
  revision?: number;
  truncated?: boolean;
}

export interface OutputMatchPayload {
  type: 'substring' | 'regex';
  value: string;
}

export interface WaitForOutputOptions {
  source?: ReadSource;
  lines?: number;
  timeoutMs?: number;
  stripAnsi?: boolean;
  pollIntervalMs?: number;
}

export interface HerdrClientOptions {
  /** Custom socket or pipe path (defaults to standard Herdr socket path) */
  socketPath?: string;
  /** Custom herdr binary path or command name (default: 'herdr') */
  cliPath?: string;
  /** Whether to prefer socket IPC before falling back to CLI (default: true) */
  preferSocket?: boolean;
  /** Default command timeout in milliseconds (default: 30000) */
  defaultTimeoutMs?: number;
  /** Custom socket factory for dependency injection / mocking */
  socketConnector?: (pipeOrSocketPath: string) => Promise<net.Socket>;
  /** Custom CLI executor for dependency injection / mocking */
  cliExecutor?: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;
}

export class HerdrError extends Error {
  public readonly code?: string;
  public readonly details?: any;

  constructor(message: string, code?: string, details?: any) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Transport & Parsing Helper Functions
// ============================================================================

/**
 * Identifies whether an error is a transport-level failure
 * (meaning fallback to an alternative transport is sensible) versus
 * a business-logic error from the Herdr server (such as 'pane_not_found',
 * 'agent_not_found', 'timeout', etc., where retrying via another transport
 * is useless or harmful).
 */
export function isTransportError(err: any): boolean {
  if (!err) return false;
  const code = (err.code || '').toString().toUpperCase();
  const msg = (err.message || '').toLowerCase();

  // Socket transport-level connection failures
  if (
    code === 'CONNECT_FAILED' ||
    code === 'CONNECT_TIMEOUT' ||
    code === 'SOCKET_ERROR' ||
    code === 'CONNECTION_CLOSED' ||
    code === 'WRITE_ERROR' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOENT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }

  // CLI transport-level failures (binary missing, command not found)
  if (
    code === 'CLI_ERROR' &&
    (msg.includes('enoent') ||
      msg.includes('not found') ||
      msg.includes('cannot find') ||
      msg.includes('is not recognized'))
  ) {
    return true;
  }

  // Method not implemented by running Herdr server version
  if (code === 'METHOD_NOT_FOUND' || code === 'INVALID_REQUEST') {
    return true;
  }

  return false;
}

/**
 * Converts a string or RegExp to a pattern suitable for Herdr's Rust regex engine.
 * Preserves JS RegExp flags (i for case-insensitive, m for multiline, s for dot-all)
 * by converting them to Rust inline flag syntax (?ims).
 */
export function toRustRegexPattern(match: RegExp | string): string {
  if (typeof match === 'string') {
    return match;
  }
  let flags = '';
  if (match.flags) {
    const valid = match.flags.replace(/[^ims]/g, '');
    if (valid) {
      flags = `(?${valid})`;
    }
  }
  return `${flags}${match.source}`;
}

/**
 * Resolves the default socket or named pipe path for Herdr based on OS and environment.
 */
export function resolveHerdrSocketPath(customPath?: string): string {
  if (customPath) {
    if (process.platform === 'win32' && !customPath.startsWith('\\\\.\\pipe\\')) {
      return `\\\\.\\pipe\\${customPath}`;
    }
    return customPath;
  }

  // Check explicit environment overrides
  const envPath = process.env.HERDR_SOCKET_PATH || process.env.HERDR_SOCK;
  if (envPath) {
    if (process.platform === 'win32' && !envPath.startsWith('\\\\.\\pipe\\')) {
      return `\\\\.\\pipe\\${envPath}`;
    }
    return envPath;
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const rawSockPath = path.join(appData, 'herdr', 'herdr.sock');
    return `\\\\.\\pipe\\${rawSockPath}`;
  } else {
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const standardSock = path.join(xdgData, 'herdr', 'herdr.sock');
    if (fs.existsSync(standardSock)) {
      return standardSock;
    }
    const tmpSock = path.join('/tmp', 'herdr.sock');
    return tmpSock;
  }
}

/**
 * Normalizes split direction to 'right' or 'down'.
 */
export function normalizeDirection(direction?: SplitDirection): 'right' | 'down' {
  if (!direction) return 'right';
  const lower = direction.toLowerCase();
  if (lower === 'vertical' || lower === 'right') return 'right';
  if (lower === 'horizontal' || lower === 'down') return 'down';
  return 'right';
}

/**
 * Normalizes read source for socket protocol vs CLI.
 */
export function normalizeReadSource(source?: ReadSource): {
  socketSource: 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
  cliSource: string;
} {
  if (!source) {
    return { socketSource: 'recent_unwrapped', cliSource: 'recent-unwrapped' };
  }
  const clean = source.trim().toLowerCase();
  if (clean === 'recent-unwrapped' || clean === 'recent_unwrapped') {
    return { socketSource: 'recent_unwrapped', cliSource: 'recent-unwrapped' };
  }
  if (clean === 'visible') {
    return { socketSource: 'visible', cliSource: 'visible' };
  }
  if (clean === 'detection') {
    return { socketSource: 'detection', cliSource: 'detection' };
  }
  return { socketSource: 'recent', cliSource: 'recent' };
}

// ============================================================================
// Core Herdr Harness Implementation
// ============================================================================

export class HerdrHarness {
  private socketPath: string;
  private cliPath: string;
  private preferSocket: boolean;
  private defaultTimeoutMs: number;
  private socketConnector?: (pipeOrSocketPath: string) => Promise<net.Socket>;
  private cliExecutor?: (
    cmd: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  private requestCounter = 0;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = resolveHerdrSocketPath(options.socketPath);
    this.cliPath = options.cliPath || 'herdr';
    this.preferSocket = options.preferSocket ?? true;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.socketConnector = options.socketConnector;
    this.cliExecutor = options.cliExecutor;
  }

  // --------------------------------------------------------------------------
  // Transport Layer (Socket & CLI)
  // --------------------------------------------------------------------------

  /**
   * Executes a raw JSON-RPC method over the Herdr socket.
   */
  public async sendSocketRequest<T = any>(
    method: string,
    params: Record<string, any> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const reqId = `maos_${Date.now()}_${++this.requestCounter}`;
    const payload = JSON.stringify({ id: reqId, method, params }) + '\n';

    let socket: net.Socket;
    if (this.socketConnector) {
      socket = await this.socketConnector(this.socketPath);
    } else {
      socket = await this.connectSocket(this.socketPath, timeout);
    }

    return new Promise<T>((resolve, reject) => {
      let buffer = '';
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket.end();
        socket.destroy();
      };

      timer = setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new HerdrError(`Socket request '${method}' timed out after ${timeout}ms`, 'TIMEOUT'));
        }
      }, timeout);

      const tryParseLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id === reqId) {
            cleanup();
            if (parsed.error) {
              reject(
                new HerdrError(
                  parsed.error.message || `Herdr error: ${parsed.error.code}`,
                  parsed.error.code,
                  parsed.error,
                ),
              );
            } else {
              resolve(parsed.result as T);
            }
            return true;
          }
        } catch {
          // Non-JSON or partial line, ignore
        }
        return false;
      };

      socket.setEncoding('utf8');

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        // Retain uncompleted fragment in buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (tryParseLine(line)) {
            return;
          }
        }
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          cleanup();
          reject(new HerdrError(`Socket error in '${method}': ${err.message}`, 'SOCKET_ERROR', err));
        }
      });

      socket.on('close', () => {
        if (!settled) {
          // Attempt to parse any remaining buffer before declaring closed prematurely
          if (buffer && tryParseLine(buffer)) {
            return;
          }
          cleanup();
          reject(new HerdrError(`Socket closed before response for '${method}'`, 'CONNECTION_CLOSED'));
        }
      });

      try {
        socket.write(payload, (err) => {
          if (err && !settled) {
            cleanup();
            reject(new HerdrError(`Failed to write to Herdr socket: ${err.message}`, 'WRITE_ERROR', err));
          }
        });
      } catch (err: any) {
        cleanup();
        reject(new HerdrError(`Failed to write to Herdr socket: ${err.message}`, 'WRITE_ERROR', err));
      }
    });
  }

  /**
   * Establishes a net.Socket connection to the Unix socket or Windows Named Pipe.
   */
  private async connectSocket(targetPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(targetPath);
      let settled = false;

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(
            new HerdrError(
              `Connection to Herdr socket '${targetPath}' timed out after ${timeoutMs}ms`,
              'CONNECT_TIMEOUT',
            ),
          );
        }
      }, timeoutMs);

      socket.once('connect', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          resolve(socket);
        }
      });

      socket.once('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          socket.destroy();
          reject(
            new HerdrError(
              `Failed to connect to Herdr socket at '${targetPath}': ${err.message}`,
              'CONNECT_FAILED',
              err,
            ),
          );
        }
      });
    });
  }

  /**
   * Executes a command via the `herdr` CLI executable.
   */
  public async execCli(args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    if (this.cliExecutor) {
      return this.cliExecutor(this.cliPath, args, timeout);
    }

    try {
      const result = await execFileAsync(this.cliPath, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        stdout: (result.stdout || '').toString().trim(),
        stderr: (result.stderr || '').toString().trim(),
      };
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString().trim() : '';
      const stdout = err.stdout ? err.stdout.toString().trim() : '';

      // Try parsing structured error from CLI stderr
      let serverErrorCode: string | undefined;
      let serverErrorMessage: string | undefined;
      if (stderr) {
        try {
          const parsedErr = JSON.parse(stderr);
          if (parsedErr.error) {
            serverErrorCode = parsedErr.error.code;
            serverErrorMessage = parsedErr.error.message;
          }
        } catch {
          // not JSON stderr
        }
      }

      throw new HerdrError(
        serverErrorMessage || `Herdr CLI command '${this.cliPath} ${args.join(' ')}' failed: ${stderr || err.message}`,
        serverErrorCode || (err.code ? String(err.code) : 'CLI_ERROR'),
        { stdout, stderr, code: err.code },
      );
    }
  }

  // --------------------------------------------------------------------------
  // Public API: 1. splitPane
  // --------------------------------------------------------------------------

  /**
   * 1. splitPane(direction, cwd, noFocus, targetPaneId) -> returns new pane_id
   *
   * Splits an existing pane or current view into a new pane.
   *
   * @param direction 'right' (vertical split) or 'down' (horizontal split). Defaults to 'right'.
   * @param cwd Working directory for the new pane. Defaults to current directory.
   * @param noFocus Whether to prevent stealing user focus. Defaults to true.
   * @param targetPaneId Optional explicit pane to split (defaults to HERDR_PANE_ID or focused pane).
   * @returns The newly created pane ID (e.g. 'wA:pB')
   */
  public async splitPane(
    direction?: SplitDirection,
    cwd?: string,
    noFocus: boolean = true,
    targetPaneId?: string,
  ): Promise<string> {
    const normalizedDir = normalizeDirection(direction);
    const resolvedTarget = targetPaneId || process.env.HERDR_PANE_ID || null;

    if (this.preferSocket) {
      try {
        const result = await this.sendSocketRequest<any>('pane.split', {
          direction: normalizedDir,
          cwd: cwd || null,
          focus: !noFocus,
          target_pane_id: resolvedTarget,
        });

        const paneId = result?.pane?.pane_id || result?.pane_id;
        if (paneId) {
          return paneId;
        }
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI on transport error
      }
    }

    // CLI fallback
    const args = ['pane', 'split', '--direction', normalizedDir];
    if (resolvedTarget) {
      args.push('--pane', resolvedTarget);
    } else if (process.env.HERDR_PANE_ID) {
      args.push('--current');
    }
    if (cwd) {
      args.push('--cwd', cwd);
    }
    if (noFocus) {
      args.push('--no-focus');
    } else {
      args.push('--focus');
    }

    const { stdout } = await this.execCli(args);
    try {
      const parsed = JSON.parse(stdout);
      const paneId = parsed.result?.pane?.pane_id || parsed.result?.pane_id;
      if (paneId) return paneId;
    } catch {
      const match = stdout.match(/(w[A-Za-z0-9]+:p[A-Za-z0-9]+)/);
      if (match) return match[1];
    }

    throw new HerdrError(`Failed to extract new pane_id from split output: ${stdout}`, 'INVALID_SPLIT_RESPONSE');
  }

  // --------------------------------------------------------------------------
  // Public API: 2. runCommand
  // --------------------------------------------------------------------------

  /**
   * 2. runCommand(paneId, command) -> runs command atomically with enter
   *
   * Executes a shell command inside the specified pane atomically appending Enter.
   *
   * @param paneId Target pane ID (e.g. 'wA:p6')
   * @param command Command string to execute
   */
  public async runCommand(paneId: string, command: string): Promise<void> {
    if (!paneId) throw new HerdrError('paneId is required for runCommand', 'INVALID_ARGUMENT');
    if (command === undefined || command === null)
      throw new HerdrError('command is required for runCommand', 'INVALID_ARGUMENT');

    if (this.preferSocket) {
      try {
        await this.sendSocketRequest('pane.send_input', {
          pane_id: paneId,
          text: command,
          keys: ['enter'],
        });
        return;
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall back to CLI only on transport failure
      }
    }

    // CLI execution
    try {
      await this.execCli(['pane', 'run', paneId, command]);
      return;
    } catch (cliErr: any) {
      if (!this.preferSocket && isTransportError(cliErr)) {
        try {
          await this.sendSocketRequest('pane.send_input', {
            pane_id: paneId,
            text: command,
            keys: ['enter'],
          });
          return;
        } catch {
          // propagate cliErr
        }
      }
      throw cliErr;
    }
  }

  // --------------------------------------------------------------------------
  // Public API: 3. readPaneBuffer
  // --------------------------------------------------------------------------

  /**
   * 3. readPaneBuffer(paneId, lines, source) -> reads recent-unwrapped or visible terminal buffer
   *
   * Reads raw scrollback or visible text buffer from a pane.
   *
   * @param paneId Target pane ID
   * @param lines Number of lines to read (defaults to 100)
   * @param source Snapshot source ('recent-unwrapped', 'visible', 'recent', 'detection'). Defaults to 'recent-unwrapped'.
   * @returns Raw string contents of the terminal buffer
   */
  public async readPaneBuffer(
    paneId: string,
    lines: number = 100,
    source: ReadSource = 'recent-unwrapped',
  ): Promise<string> {
    if (!paneId) throw new HerdrError('paneId is required for readPaneBuffer', 'INVALID_ARGUMENT');

    const { socketSource, cliSource } = normalizeReadSource(source);

    if (this.preferSocket) {
      try {
        const result = await this.sendSocketRequest<any>('pane.read', {
          pane_id: paneId,
          source: socketSource,
          lines: lines > 0 ? lines : null,
          format: 'text',
          strip_ansi: true,
        });

        if (result?.read?.text !== undefined) {
          return result.read.text;
        }
        if (result?.text !== undefined) {
          return result.text;
        }
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI only on transport failure
      }
    }

    // CLI fallback
    const args = ['pane', 'read', paneId, '--source', cliSource];
    if (lines > 0) {
      args.push('--lines', String(lines));
    }

    const { stdout } = await this.execCli(args);
    return stdout;
  }

  // --------------------------------------------------------------------------
  // Public API: 4. waitForOutput
  // --------------------------------------------------------------------------

  /**
   * 4. waitForOutput(paneId, match, timeoutMs, options) -> waits for string or regex in pane
   *
   * Searches recent terminal buffer and waits until matching text or regex pattern appears.
   *
   * @param paneId Target pane ID
   * @param match String substring or RegExp pattern to wait for
   * @param timeoutMs Maximum milliseconds to wait (defaults to 30000ms)
   * @param options Additional options (source, lines, poll interval)
   * @returns The matching line or matched buffer text
   */
  public async waitForOutput(
    paneId: string,
    match: string | RegExp,
    timeoutMs: number = 30000,
    options: WaitForOutputOptions = {},
  ): Promise<string> {
    if (!paneId) throw new HerdrError('paneId is required for waitForOutput', 'INVALID_ARGUMENT');
    if (!match) throw new HerdrError('match parameter is required for waitForOutput', 'INVALID_ARGUMENT');

    const source = options.source || 'recent-unwrapped';
    const { socketSource, cliSource } = normalizeReadSource(source);
    const lines = options.lines && options.lines > 0 ? options.lines : null;
    const isRegex = match instanceof RegExp;
    const rustPattern = toRustRegexPattern(match);
    const displayPattern = isRegex ? match.toString() : match;

    if (this.preferSocket) {
      try {
        const matchPayload: OutputMatchPayload = isRegex
          ? { type: 'regex', value: rustPattern }
          : { type: 'substring', value: rustPattern };

        const result = await this.sendSocketRequest<any>(
          'pane.wait_for_output',
          {
            pane_id: paneId,
            source: socketSource,
            match: matchPayload,
            lines,
            timeout_ms: timeoutMs,
            strip_ansi: options.stripAnsi ?? true,
          },
          timeoutMs + 2000,
        );

        if (result?.matched_line) {
          return result.matched_line;
        }
        if (result?.read?.text) {
          return result.read.text;
        }
        return isRegex ? match.source : match;
      } catch (err: any) {
        const code = (err.code || '').toLowerCase();
        if (code === 'timeout') {
          throw new HerdrError(
            `waitForOutput timed out after ${timeoutMs}ms waiting for '${displayPattern}' in pane '${paneId}'`,
            'WAIT_OUTPUT_TIMEOUT',
          );
        }
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI / Polling only on transport failure
      }
    }

    // CLI attempt
    try {
      const args = ['pane', 'wait-output', paneId];
      if (isRegex) {
        args.push('--regex', rustPattern);
      } else {
        args.push('--match', rustPattern);
      }
      args.push('--source', cliSource);
      if (lines) {
        args.push('--lines', String(lines));
      }
      if (timeoutMs > 0) {
        args.push('--timeout', String(timeoutMs));
      }

      const { stdout } = await this.execCli(args, timeoutMs + 3000);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.result?.matched_line) return parsed.result.matched_line;
        if (parsed.result?.read?.text) return parsed.result.read.text;
      } catch {
        if (stdout) return stdout;
      }
      return isRegex ? match.source : match;
    } catch (cliErr: any) {
      const msg = (cliErr.message || '').toLowerCase();
      const code = (cliErr.code || '').toLowerCase();
      if (msg.includes('timeout') || msg.includes('timed out') || code === 'timeout') {
        throw new HerdrError(
          `waitForOutput timed out after ${timeoutMs}ms waiting for '${displayPattern}' in pane '${paneId}'`,
          'WAIT_OUTPUT_TIMEOUT',
        );
      }
      if (msg.includes('pane_not_found') || msg.includes('not found') || code === 'pane_not_found') {
        throw cliErr;
      }
      // Fall through to client-side polling only if wait-output subcommand is unavailable
    }

    // Client-side polling fallback
    const startTime = Date.now();
    const pollInterval = options.pollIntervalMs || 250;

    while (Date.now() - startTime < timeoutMs) {
      const buffer = await this.readPaneBuffer(paneId, lines || 100, source);
      if (isRegex) {
        const matchResult = buffer.match(match);
        if (matchResult) {
          return matchResult[0];
        }
      } else {
        if (buffer.includes(match)) {
          const linesList = buffer.split('\n');
          const foundLine = linesList.find((l) => l.includes(match));
          return foundLine || match;
        }
      }
      await new Promise((res) => setTimeout(res, pollInterval));
    }

    throw new HerdrError(
      `waitForOutput timed out after ${timeoutMs}ms waiting for '${displayPattern}' in pane '${paneId}'`,
      'WAIT_OUTPUT_TIMEOUT',
    );
  }

  // --------------------------------------------------------------------------
  // Public API: 5. listAgents & getAgent
  // --------------------------------------------------------------------------

  /**
   * 5a. listAgents() -> returns active agent statuses
   *
   * Queries Herdr for all active agents recognized in any pane.
   *
   * @returns Array of AgentInfo records
   */
  public async listAgents(): Promise<AgentInfo[]> {
    if (this.preferSocket) {
      try {
        const result = await this.sendSocketRequest<any>('agent.list', {});
        if (Array.isArray(result?.agents)) {
          return result.agents;
        }
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI on transport error
      }
    }

    const { stdout } = await this.execCli(['agent', 'list']);
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.result?.agents)) {
        return parsed.result.agents;
      }
    } catch {
      // Malformed output
    }

    return [];
  }

  /**
   * 5b. getAgent(target) -> returns active agent status
   *
   * Queries status and metadata for a specific agent by unique name or pane ID.
   *
   * @param target Agent name or pane ID (e.g. 'reviewer' or 'wA:p1')
   * @returns AgentInfo object or null if not found
   */
  public async getAgent(target: string): Promise<AgentInfo | null> {
    if (!target) throw new HerdrError('target is required for getAgent', 'INVALID_ARGUMENT');

    if (this.preferSocket) {
      try {
        const result = await this.sendSocketRequest<any>('agent.get', { target });
        if (result?.agent) {
          return result.agent;
        }
      } catch (err: any) {
        const code = (err.code || '').toLowerCase();
        if (code === 'agent_not_found') {
          return null;
        }
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI on transport error
      }
    }

    try {
      const { stdout } = await this.execCli(['agent', 'get', target]);
      const parsed = JSON.parse(stdout);
      if (parsed.result?.agent) {
        return parsed.result.agent;
      }
    } catch {
      return null;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Public API: 6. sendPrompt
  // --------------------------------------------------------------------------

  /**
   * 6. sendPrompt(target, prompt, wait, timeoutMs) -> submits prompt to agent
   *
   * Sends a prompt string to an agent running in a pane.
   * If wait is true, waits until the agent transitions to a settled state (idle, done, or blocked).
   *
   * @param target Agent name or pane ID
   * @param prompt Prompt string to send
   * @param wait Whether to wait for prompt completion (idle/done/blocked)
   * @param timeoutMs Wait timeout in milliseconds (defaults to 120000ms)
   * @returns Updated AgentInfo
   */
  public async sendPrompt(
    target: string,
    prompt: string,
    wait: boolean = false,
    timeoutMs: number = 120000,
  ): Promise<AgentInfo> {
    if (!target) throw new HerdrError('target is required for sendPrompt', 'INVALID_ARGUMENT');
    if (prompt === undefined || prompt === null)
      throw new HerdrError('prompt is required for sendPrompt', 'INVALID_ARGUMENT');

    if (this.preferSocket) {
      try {
        const waitOptions = wait
          ? {
              timeout_ms: timeoutMs,
              until: ['idle', 'done', 'blocked'] as AgentStatus[],
            }
          : null;

        const result = await this.sendSocketRequest<any>(
          'agent.prompt',
          {
            target,
            text: prompt,
            wait: waitOptions,
          },
          wait ? timeoutMs + 5000 : this.defaultTimeoutMs,
        );

        if (result?.agent) {
          return result.agent;
        }
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall back to CLI on transport error
      }
    }

    // CLI fallback
    const args = ['agent', 'prompt', target, prompt];
    if (wait) {
      args.push('--wait');
      args.push('--timeout', String(timeoutMs));
    }

    const { stdout } = await this.execCli(args, wait ? timeoutMs + 5000 : this.defaultTimeoutMs);
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.result?.agent) {
        return parsed.result.agent;
      }
    } catch {
      // Fall through to query agent
    }

    // Retrieve fresh agent status
    const refreshed = await this.getAgent(target);
    if (refreshed) return refreshed;

    throw new HerdrError(`Failed to confirm prompt status for agent '${target}'`, 'PROMPT_UNCONFIRMED');
  }

  // --------------------------------------------------------------------------
  // Lifecycle & Utility Operations
  // --------------------------------------------------------------------------

  /**
   * Closes a pane cleanly.
   *
   * @param paneId Pane ID to close
   */
  public async closePane(paneId: string): Promise<boolean> {
    if (!paneId) return false;

    if (this.preferSocket) {
      try {
        await this.sendSocketRequest('pane.close', { pane_id: paneId });
        return true;
      } catch (err: any) {
        if (!isTransportError(err)) {
          return false;
        }
        // Fall back to CLI on transport error
      }
    }

    try {
      await this.execCli(['pane', 'close', paneId]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if Herdr multiplexer is running and responsive via socket or CLI.
   */
  public async isAvailable(): Promise<boolean> {
    if (this.preferSocket) {
      try {
        const pong = await this.sendSocketRequest<any>('ping', {}, 2000);
        if (pong?.type === 'pong') return true;
      } catch {
        // Socket probe failed, try CLI
      }
    }

    try {
      const { stdout } = await this.execCli(['status'], 3000);
      if (
        stdout.includes('not running') ||
        stdout.includes('error:') ||
        stdout.includes('failed to connect') ||
        stdout.includes('stopped')
      ) {
        return false;
      }
      return /server:\s*(?:running|(?:[^\n]*\r?\n\s+)*status:\s*running\b)/i.test(stdout);
    } catch {
      try {
        const { stdout } = await this.execCli(['agent', 'list'], 3000);
        return stdout.includes('agent_list') || stdout.includes('agents');
      } catch {
        return false;
      }
    }
  }

  /**
   * Lists all open panes.
   */
  public async listPanes(workspaceId?: string): Promise<PaneInfo[]> {
    if (this.preferSocket) {
      try {
        const result = await this.sendSocketRequest<any>('pane.list', {
          workspace_id: workspaceId || null,
        });
        if (Array.isArray(result?.panes)) {
          return result.panes;
        }
      } catch (err: any) {
        if (!isTransportError(err)) {
          throw err;
        }
        // Fall through to CLI on transport error
      }
    }

    const args = ['pane', 'list'];
    if (workspaceId) args.push('--workspace', workspaceId);

    const { stdout } = await this.execCli(args);
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.result?.panes)) {
        return parsed.result.panes;
      }
    } catch {
      // ignore
    }

    return [];
  }

  /**
   * Returns current active socket path.
   */
  public getSocketPath(): string {
    return this.socketPath;
  }
}

// ============================================================================
// Singleton & Top-Level Standalone Functions
// ============================================================================

let defaultHarnessInstance: HerdrHarness | null = null;

export function getDefaultHerdrHarness(): HerdrHarness {
  if (!defaultHarnessInstance) {
    defaultHarnessInstance = new HerdrHarness();
  }
  return defaultHarnessInstance;
}

/**
 * 1. splitPane(direction, cwd, noFocus, targetPaneId) -> returns new pane_id
 */
export async function splitPane(
  direction?: SplitDirection,
  cwd?: string,
  noFocus: boolean = true,
  targetPaneId?: string,
): Promise<string> {
  return getDefaultHerdrHarness().splitPane(direction, cwd, noFocus, targetPaneId);
}

/**
 * 2. runCommand(paneId, command) -> runs command atomically with enter
 */
export async function runCommand(paneId: string, command: string): Promise<void> {
  return getDefaultHerdrHarness().runCommand(paneId, command);
}

/**
 * 3. readPaneBuffer(paneId, lines, source) -> reads recent-unwrapped or visible terminal buffer
 */
export async function readPaneBuffer(
  paneId: string,
  lines: number = 100,
  source: ReadSource = 'recent-unwrapped',
): Promise<string> {
  return getDefaultHerdrHarness().readPaneBuffer(paneId, lines, source);
}

/**
 * 4. waitForOutput(paneId, match, timeoutMs, options) -> waits for string or regex in pane
 */
export async function waitForOutput(
  paneId: string,
  match: string | RegExp,
  timeoutMs: number = 30000,
  options?: WaitForOutputOptions,
): Promise<string> {
  return getDefaultHerdrHarness().waitForOutput(paneId, match, timeoutMs, options);
}

/**
 * 5a. listAgents() -> returns active agent statuses
 */
export async function listAgents(): Promise<AgentInfo[]> {
  return getDefaultHerdrHarness().listAgents();
}

/**
 * 5b. getAgent(target) -> returns active agent status
 */
export async function getAgent(target: string): Promise<AgentInfo | null> {
  return getDefaultHerdrHarness().getAgent(target);
}

/**
 * 6. sendPrompt(target, prompt, wait, timeoutMs) -> submits prompt to agent
 */
export async function sendPrompt(
  target: string,
  prompt: string,
  wait: boolean = false,
  timeoutMs?: number,
): Promise<AgentInfo> {
  return getDefaultHerdrHarness().sendPrompt(target, prompt, wait, timeoutMs);
}

/**
 * Cleanly closes a pane.
 */
export async function closePane(paneId: string): Promise<boolean> {
  return getDefaultHerdrHarness().closePane(paneId);
}

/**
 * Checks if Herdr multiplexer is running.
 */
export async function isHerdrAvailable(): Promise<boolean> {
  return getDefaultHerdrHarness().isAvailable();
}

export interface SymmetricSplitPlan {
  targetWorkerIndex: number;
  direction: 'right' | 'down';
}

/**
 * Computes a symmetric, balanced grid split plan for N worker panes.
 *
 * For N=2: 1x2 (left/right split 50/50).
 * For N=3: 1 top / 2 bottom (balanced 50% height, bottom split 50/50).
 * For N=4: 2x2 grid (top split 50/50, bottom split 50/50).
 * For N=5: 2 top / 3 bottom balanced.
 * For N=6: 2x3 grid (2 equal rows of 3 columns).
 * For N=8: 2x4 grid (2 equal rows of 4 columns).
 */
export function computeSymmetricGridPlan(totalWorkers: number): SymmetricSplitPlan[] {
  if (totalWorkers <= 1) return [];

  if (totalWorkers === 2) {
    return [{ targetWorkerIndex: 0, direction: 'right' }];
  }

  if (totalWorkers === 3) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 1, direction: 'right' },
    ];
  }

  if (totalWorkers === 4) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 0, direction: 'right' },
      { targetWorkerIndex: 1, direction: 'right' },
    ];
  }

  if (totalWorkers === 5) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 0, direction: 'right' },
      { targetWorkerIndex: 1, direction: 'right' },
      { targetWorkerIndex: 3, direction: 'right' },
    ];
  }

  if (totalWorkers === 6) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 0, direction: 'right' },
      { targetWorkerIndex: 2, direction: 'right' },
      { targetWorkerIndex: 1, direction: 'right' },
      { targetWorkerIndex: 4, direction: 'right' },
    ];
  }

  if (totalWorkers === 7) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 0, direction: 'right' },
      { targetWorkerIndex: 2, direction: 'right' },
      { targetWorkerIndex: 1, direction: 'right' },
      { targetWorkerIndex: 4, direction: 'right' },
      { targetWorkerIndex: 5, direction: 'right' },
    ];
  }

  if (totalWorkers === 8) {
    return [
      { targetWorkerIndex: 0, direction: 'down' },
      { targetWorkerIndex: 0, direction: 'right' },
      { targetWorkerIndex: 2, direction: 'right' },
      { targetWorkerIndex: 3, direction: 'right' },
      { targetWorkerIndex: 1, direction: 'right' },
      { targetWorkerIndex: 5, direction: 'right' },
      { targetWorkerIndex: 6, direction: 'right' },
    ];
  }

  // General fallback for N > 8
  const plans: SymmetricSplitPlan[] = [];
  for (let i = 1; i < totalWorkers; i++) {
    const isDown = i % 2 === 1;
    const target = isDown ? Math.floor(i / 2) : i - 1;
    plans.push({ targetWorkerIndex: Math.min(target, i - 1), direction: isDown ? 'down' : 'right' });
  }
  return plans;
}

export default HerdrHarness;
