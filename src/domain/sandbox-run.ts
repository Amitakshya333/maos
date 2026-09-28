/**
 * MAOS Industrial — Sandbox Container Execution Domain & Contracts (F8-02)
 *
 * Defines domain types, pure input validators, canonical hashing,
 * environment sanitization, safe argument vector generation, and
 * fail-closed security invariants for container sandbox execution.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Error Codes & Classes ────────────────────────────────────────────

export const CONTAINER_RUNNER_ERROR_CODES = {
  IMAGE_DIGEST_MISMATCH: 'IMAGE_DIGEST_MISMATCH',
  SANDBOX_IMAGE_MISSING: 'SANDBOX_IMAGE_MISSING',
  CONTAINER_SPAWN_FAILED: 'CONTAINER_SPAWN_FAILED',
  CONTAINER_TIMEOUT: 'CONTAINER_TIMEOUT',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  EXECUTION_INTERRUPTED: 'EXECUTION_INTERRUPTED',
  ROOT_EXECUTION_FORBIDDEN: 'ROOT_EXECUTION_FORBIDDEN',
  HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
  UNAUTHORIZED_AGENT: 'UNAUTHORIZED_AGENT',
  DOCKER_SOCKET_FORBIDDEN: 'DOCKER_SOCKET_FORBIDDEN',
  PROJECT_ESCAPE_DETECTED: 'PROJECT_ESCAPE_DETECTED',
  CROSS_PROJECT_WORKSPACE_FORBIDDEN: 'CROSS_PROJECT_WORKSPACE_FORBIDDEN',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CONTAINER_EXECUTION_FAILED: 'CONTAINER_EXECUTION_FAILED',
  IMAGE_DIGEST_OBSERVATION_FAILED: 'IMAGE_DIGEST_OBSERVATION_FAILED',
  SECURITY_POLICY_VIOLATION: 'SECURITY_POLICY_VIOLATION',
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

export type ContainerRunnerErrorCode =
  (typeof CONTAINER_RUNNER_ERROR_CODES)[keyof typeof CONTAINER_RUNNER_ERROR_CODES];

export class ContainerRunnerError extends Error {
  public readonly code: ContainerRunnerErrorCode;
  public readonly detail?: Record<string, unknown>;

  constructor(
    code: ContainerRunnerErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ContainerRunnerError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Execution Contracts ──────────────────────────────────────────────

export interface CallerIdentity {
  readonly agentId?: string;
  readonly taskId?: string;
}

export interface SandboxExecutionRequest {
  readonly script: string;
  readonly args?: readonly string[];
  readonly files?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly callerIdentity?: CallerIdentity;
  readonly requestId?: string;
  readonly projectId?: string;
  readonly workspacePath?: string;
}

export type SandboxRunStatus =
  | 'COMPLETED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'INTERRUPTED'
  | 'FAILED';

export interface SandboxExecutionResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly status: SandboxRunStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly containerName: string;
  readonly containerId?: string;
  readonly imageDigest: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly stagedFiles: readonly string[];
  readonly auditEventId?: string;
}

export interface ContainerRunOptions {
  readonly containerName: string;
  readonly imageRef: string;
  readonly stagedWorkspacePath: string;
  readonly scriptFileName: string;
  readonly scriptArgs?: readonly string[];
  readonly limits: {
    readonly maxMemoryMb: number;
    readonly maxCpuCores: number;
    readonly maxExecutionTimeMs: number;
    readonly maxOutputBytes: number;
    readonly maxProcesses: number;
  };
  readonly environment?: Record<string, string>;
}

// ── Frozen Allowlisted Constants ─────────────────────────────────────

export const AUTHORIZED_CODE_SANDBOX_AGENTS: readonly string[] = Object.freeze([
  'code_agent',
  'coder',
  'coder_agent',
  'analyst_agent',
  'analyst',
  'lead-inspector',
  'inspector',
  'supervisor_agent',
  'supervisor',
  'test-agent',
  'verification',
  'admin',
]);

export const FROZEN_CONTAINER_ENV: Readonly<Record<string, string>> = Object.freeze({
  TMPDIR: '/tmp',
  MPLCONFIGDIR: '/tmp',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUNBUFFERED: '1',
  PYTHONNOUSERSITE: '1',
  HOME: '/home/sandboxuser',
  PATH: '/usr/local/bin:/usr/bin:/bin',
});

// ── Pure Validation & Formatting Functions ───────────────────────────

/**
 * Validates raw input payload against SandboxExecutionRequest specification.
 */
export function validateSandboxRunInput(raw: unknown): {
  valid: boolean;
  errors: string[];
  request?: SandboxExecutionRequest;
} {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Execution input must be a non-null object'] };
  }

  const obj = raw as Record<string, any>;

  if (typeof obj.script !== 'string' || obj.script.trim().length === 0) {
    errors.push("'script' must be a non-empty string of Python source code");
  }

  let args: string[] | undefined;
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      errors.push("'args' must be an array of strings if provided");
    } else {
      args = [];
      for (let i = 0; i < obj.args.length; i++) {
        if (typeof obj.args[i] !== 'string') {
          errors.push(`args[${i}] must be a string`);
        } else {
          args.push(obj.args[i]);
        }
      }
    }
  }

  let files: Record<string, string> | undefined;
  if (obj.files !== undefined) {
    if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) {
      errors.push("'files' must be a map of relative filenames to file contents");
    } else {
      files = {};
      for (const [filename, content] of Object.entries(obj.files)) {
        if (filename.includes('..') || path.isAbsolute(filename)) {
          errors.push(`Staged file path '${filename}' contains illegal path traversal or is absolute`);
        } else if (typeof content !== 'string') {
          errors.push(`Staged file content for '${filename}' must be a string`);
        } else {
          files[filename] = content;
        }
      }
    }
  }

  let timeoutMs: number | undefined;
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== 'number' || obj.timeoutMs <= 0) {
      errors.push("'timeoutMs' must be a positive number");
    } else if (obj.timeoutMs > 30000) {
      errors.push(`'timeoutMs' cannot exceed hard manifest limit of 30,000ms (received ${obj.timeoutMs})`);
    } else {
      timeoutMs = Math.floor(obj.timeoutMs);
    }
  }

  let maxOutputBytes: number | undefined;
  if (obj.maxOutputBytes !== undefined) {
    if (typeof obj.maxOutputBytes !== 'number' || obj.maxOutputBytes <= 0) {
      errors.push("'maxOutputBytes' must be a positive number");
    } else if (obj.maxOutputBytes > 50000) {
      errors.push(`'maxOutputBytes' cannot exceed hard manifest limit of 50,000 bytes (received ${obj.maxOutputBytes})`);
    } else {
      maxOutputBytes = Math.floor(obj.maxOutputBytes);
    }
  }

  let callerIdentity: CallerIdentity | undefined;
  if (obj.callerIdentity !== undefined) {
    if (typeof obj.callerIdentity !== 'object' || Array.isArray(obj.callerIdentity)) {
      errors.push("'callerIdentity' must be an object if provided");
    } else {
      callerIdentity = {
        agentId: obj.callerIdentity.agentId ? String(obj.callerIdentity.agentId) : undefined,
        taskId: obj.callerIdentity.taskId ? String(obj.callerIdentity.taskId) : undefined,
      };
    }
  }

  if (obj.executorType === 'host') {
    errors.push(
      "Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.",
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    request: {
      script: String(obj.script),
      args: args ? Object.freeze(args) : undefined,
      files: files ? Object.freeze(files) : undefined,
      timeoutMs: timeoutMs || 30000,
      maxOutputBytes: maxOutputBytes || 50000,
      callerIdentity: callerIdentity ? Object.freeze(callerIdentity) : undefined,
      requestId: obj.requestId ? String(obj.requestId) : undefined,
      projectId: obj.projectId ? String(obj.projectId) : undefined,
      workspacePath: obj.workspacePath ? String(obj.workspacePath) : undefined,
    },
  };
}

/**
 * Computes canonical SHA-256 hash of execution inputs (script, args, staged files).
 */
export function computeExecutionInputHash(
  script: string,
  args?: readonly string[],
  files?: Record<string, string>,
): string {
  const normalized: Record<string, unknown> = {
    script: script.replace(/\r\n/g, '\n').trim(),
    args: args ? [...args] : [],
    files: {},
  };

  if (files) {
    const sortedFileKeys = Object.keys(files).sort();
    const sortedFiles: Record<string, string> = {};
    for (const key of sortedFileKeys) {
      sortedFiles[key] = files[key].replace(/\r\n/g, '\n');
    }
    normalized.files = sortedFiles;
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex');
}

/**
 * Computes canonical SHA-256 hash of execution outputs (status, exitCode, stdout, stderr).
 */
export function computeExecutionOutputHash(
  status: SandboxRunStatus,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  const payload = {
    status,
    exitCode,
    stdout: stdout.replace(/\r\n/g, '\n').trim(),
    stderr: stderr.replace(/\r\n/g, '\n').trim(),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

/**
 * Sanitizes container execution environment variables.
 * Completely strips host secrets, tokens, AWS keys, and host paths.
 * Exposes strictly the frozen, approved sandbox variables.
 */
export function sanitizeSandboxEnvironment(
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const cleanEnv: Record<string, string> = { ...FROZEN_CONTAINER_ENV };

  if (extraEnv) {
    const FORBIDDEN_ENV_PATTERNS = [
      /token/i,
      /secret/i,
      /key/i,
      /password/i,
      /auth/i,
      /cred/i,
      /aws/i,
      /azure/i,
      /gcp/i,
      /api/i,
    ];

    for (const [k, v] of Object.entries(extraEnv)) {
      const isForbidden = FORBIDDEN_ENV_PATTERNS.some((p) => p.test(k));
      if (!isForbidden && typeof v === 'string') {
        cleanEnv[k] = v;
      }
    }
  }

  return Object.freeze(cleanEnv);
}

/**
 * Asserts that a staged workspace mount path is strictly confined,
 * safe, and does not target host roots or the Docker socket.
 */
export function assertSafeWorkspaceMount(
  workspacePath: string,
  projectRoot: string,
): string {
  const lower = workspacePath.toLowerCase();

  // 1. Docker socket protection
  if (
    lower.includes('docker.sock') ||
    lower.includes('docker_engine') ||
    lower.includes('//./pipe/docker_engine') ||
    lower.includes('\\\\.\\pipe\\docker_engine')
  ) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.DOCKER_SOCKET_FORBIDDEN,
      `Workspace path '${workspacePath}' references the Docker socket. Docker socket access is strictly forbidden.`,
      { workspacePath },
    );
  }

  // 2. Canonical containment check. Do not allow paths merely because their
  // spelling contains '.maos' or 'maos-sandbox-'; those substrings are not
  // trust boundaries and can be attacker-controlled directory names.
  if (workspacePath.includes('\0')) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
      'Workspace path contains a forbidden null byte.',
      { workspacePath },
    );
  }

  let resolved: string;
  let resolvedProject: string;
  try {
    resolved = path.resolve(workspacePath);
    resolvedProject = fs.realpathSync(path.resolve(projectRoot));
  } catch (err: any) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
      `Workspace or project root could not be canonicalized: ${err.message}`,
      { workspacePath, projectRoot },
    );
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
      `Workspace path '${workspacePath}' must exist as a regular directory before it can be mounted.`,
      { workspacePath, resolved },
    );
  }

  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = fs.realpathSync(resolved);
  } catch (err: any) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
      `Workspace path could not be canonicalized: ${err.message}`,
      { workspacePath, resolved },
    );
  }

  const relative = path.relative(resolvedProject, canonicalWorkspace);
  const isInsideProject = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isInsideProject) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
      `Workspace path '${workspacePath}' resolves outside project root '${projectRoot}'. Host project escape is forbidden.`,
      { workspacePath, resolved: canonicalWorkspace, projectRoot: resolvedProject },
    );
  }

  return canonicalWorkspace;
}

/**
 * Constructs the discrete, safe argument array for `docker run`.
 * Guaranteed to have zero shell interpolation.
 */
export function buildDockerRunArgs(options: ContainerRunOptions): readonly string[] {
  const args: string[] = [
    'run',
    '--name',
    options.containerName,
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '10001:10001',
    '--memory',
    `${options.limits.maxMemoryMb}m`,
    '--cpus',
    `${options.limits.maxCpuCores}.0`,
    '--pids-limit',
    `${options.limits.maxProcesses}`,
    '--tmpfs',
    '/sandbox/tmp:rw,noexec,nosuid,size=64m',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--entrypoint',
    '/usr/local/bin/python3',
    '-v',
    `${path.resolve(options.stagedWorkspacePath)}:/sandbox/workspace:rw`,
    '-w',
    '/sandbox/workspace',
  ];

  // Environment variables
  const env = options.environment || FROZEN_CONTAINER_ENV;
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }

  // Image reference
  args.push(options.imageRef);

  // Command to run inside container: strictly python3 with script and args
  args.push(options.scriptFileName);

  if (options.scriptArgs && options.scriptArgs.length > 0) {
    for (const a of options.scriptArgs) {
      args.push(String(a));
    }
  }

  return Object.freeze(args);
}
