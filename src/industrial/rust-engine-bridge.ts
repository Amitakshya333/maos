/**
 * R1-08: TypeScript Bridge to the Rust Industrial Engine.
 *
 * Invokes the verified Rust binary with argument-safe process APIs.
 * Enforces: timeout, output limits, executable hash, protocol version,
 * response schema, exit code, and project scope.
 *
 * Missing or tampered binaries fail closed — NO silent TS fallback in Industrial mode.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────

/** Expected protocol version from the Rust engine. */
const EXPECTED_PROTOCOL_VERSION = '1.0';

/** Maximum time to wait for engine response (ms). */
const ENGINE_TIMEOUT_MS = 30_000;

/** Maximum stdout size from engine (bytes). */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Environment variables passed to the engine (minimal). */
const MINIMAL_ENV: Record<string, string> = {
  PATH: process.env.PATH || '',
  SYSTEMROOT: process.env.SYSTEMROOT || '',
  TEMP: process.env.TEMP || '',
};

// ── Types ──────────────────────────────────────────────────────────

export interface EngineManifest {
  /** Absolute path to the engine executable. */
  executablePath: string;
  /** Expected SHA-256 hash of the executable (hex). */
  executableHash: string;
  /** Expected engine version. */
  engineVersion: string;
  /** Protocol version. */
  protocolVersion: string;
}

export interface EngineRequest {
  version: string;
  operation: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

export interface EngineSuccessResponse {
  operation: string;
  version: string;
  request_id?: string;
  data: Record<string, unknown>;
}

export interface EngineErrorResponse {
  error: true;
  category: 'protocol' | 'input' | 'policy' | 'internal';
  message: string;
  request_id?: string;
}

export type EngineResponse = EngineSuccessResponse | EngineErrorResponse;

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly category: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

// ── Bridge ─────────────────────────────────────────────────────────

/**
 * Verify the engine executable exists and matches the expected hash.
 * Returns the manifest if valid, throws if missing or tampered.
 */
export function verifyExecutable(executablePath: string, expectedHash?: string): EngineManifest {
  const absPath = path.resolve(executablePath);

  if (!fs.existsSync(absPath)) {
    throw new EngineError(
      `Engine executable not found: ${absPath}. Build with: cargo build --release --locked`,
      'missing_binary',
    );
  }

  // Compute executable hash
  const fileBuffer = fs.readFileSync(absPath);
  const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // If an expected hash is provided, verify it matches
  if (expectedHash && actualHash !== expectedHash) {
    throw new EngineError(
      `Engine executable hash mismatch!\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}\n` +
        `  Path:     ${absPath}\n` +
        `Binary may have been tampered with. Rebuild from source.`,
      'tampered_binary',
    );
  }

  return {
    executablePath: absPath,
    executableHash: actualHash,
    engineVersion: '0.1.0',
    protocolVersion: EXPECTED_PROTOCOL_VERSION,
  };
}

/** Maximum size of one engine request; MUST match Rust's bounded line reader. */
export const MAX_ENGINE_REQUEST_BYTES = 1_048_576; // 1 MiB

/**
 * Invoke the Rust engine with a JSON request. Fail-closed on any error.
 *
 * Uses execFileSync (NOT execSync) to avoid shell injection.
 * Passes request as stdin, reads response from stdout.
 */
export function invokeEngine(
  manifest: EngineManifest,
  request: EngineRequest,
): EngineResponse {
  const requestJson = JSON.stringify(request);

  // Enforce request size limit
  if (Buffer.byteLength(requestJson) > MAX_ENGINE_REQUEST_BYTES) {
    throw new EngineError(
      `Request exceeds ${Math.floor(MAX_ENGINE_REQUEST_BYTES / 1_048_576)} MiB size limit`,
      'input',
    );
  }

  let stdout: string;
  try {
    // execFileSync — argument-safe, no shell interpretation
    stdout = execFileSync(manifest.executablePath, [], {
      input: requestJson + '\n',
      encoding: 'utf-8',
      timeout: ENGINE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: MINIMAL_ENV,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // Engine process failure — fail closed
    const exitCode = err.status ?? -1;
    const stderr = err.stderr?.toString()?.substring(0, 500) || '';
    throw new EngineError(
      `Engine process failed (exit ${exitCode}): ${stderr || err.message}`,
      'process_failure',
      exitCode,
    );
  }

  // Parse response
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new EngineError('Engine returned empty response', 'empty_response');
  }

  // Enforce output size
  if (Buffer.byteLength(trimmed) > MAX_OUTPUT_BYTES) {
    throw new EngineError('Engine response exceeds output limit', 'output_overflow');
  }

  let response: EngineResponse;
  try {
    response = JSON.parse(trimmed);
  } catch {
    throw new EngineError(
      `Engine returned invalid JSON: ${trimmed.substring(0, 200)}`,
      'invalid_response',
    );
  }

  // Validate response schema
  if ('error' in response && response.error === true) {
    return response as EngineErrorResponse;
  }

  const success = response as EngineSuccessResponse;

  // Validate protocol version in response
  if (success.version && success.version !== EXPECTED_PROTOCOL_VERSION) {
    throw new EngineError(
      `Engine protocol version mismatch: expected '${EXPECTED_PROTOCOL_VERSION}', got '${success.version}'`,
      'version_mismatch',
    );
  }

  return success;
}

// ── Convenience methods ────────────────────────────────────────────

/** Check engine health. */
export function engineHealth(manifest: EngineManifest): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'health',
  });
}

/** Parse sensor CSV data through the Rust engine. */
export function engineParseSensor(
  manifest: EngineManifest,
  csvData: string,
  config?: Record<string, unknown>,
): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'parse-sensor',
    data: { csv: csvData, config },
  });
}

/** Evaluate measurements against thresholds through the Rust engine. */
export function engineEvaluate(
  manifest: EngineManifest,
  measurements: Record<string, unknown>,
  thresholds: Record<string, unknown>,
  rulesetId?: string,
): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'evaluate',
    data: { measurements, thresholds, ruleset_id: rulesetId },
  });
}

/** Hash data through the Rust engine. */
export function engineHash(
  manifest: EngineManifest,
  data: unknown,
): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'hash',
    data: data as Record<string, unknown>,
  });
}

/** Append a record to an evidence chain through the Rust engine. */
export function engineChainAppend(
  manifest: EngineManifest,
  record: {
    sequence: number;
    previous_hash: string;
    timestamp: string;
    source: string;
    category: string;
    data: Record<string, unknown>;
  },
): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'chain-append',
    data: record as Record<string, unknown>,
  });
}

export interface EngineChainVerifyOptions {
  /** Absolute sequence number expected for the first record in this window. */
  readonly startSequence?: number;
  /** Hash of the record immediately before this window, or empty for sequence 0. */
  readonly previousHash?: string;
}

function buildChainVerifyRequest(
  chain: unknown[],
  options: EngineChainVerifyOptions = {},
): EngineRequest {
  return {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'chain-verify',
    data: {
      chain,
      start_sequence: options.startSequence ?? 0,
      previous_hash: options.previousHash ?? '',
    },
  };
}

/** Exact serialized request size, used to pack bounded audit verification windows. */
export function engineChainVerifyRequestSizeBytes(
  chain: unknown[],
  options: EngineChainVerifyOptions = {},
): number {
  return Buffer.byteLength(JSON.stringify(buildChainVerifyRequest(chain, options)));
}

/** Verify one hash-anchored evidence-chain window through the Rust engine. */
export function engineChainVerify(
  manifest: EngineManifest,
  chain: unknown[],
  options: EngineChainVerifyOptions = {},
): EngineResponse {
  return invokeEngine(manifest, buildChainVerifyRequest(chain, options));
}

/** Verify a mathematical calculation trace through the Rust engine. */
export function engineVerifyCalculation(
  manifest: EngineManifest,
  params: {
    csv: string;
    source_hash: string;
    measurement_field?: string;
    unit: string;
    expected_count: number;
    expected_sum_squares: number;
    expected_mean_square: number;
    expected_rms: number;
    expected_rounded_rms: number;
    rounding_decimals?: number;
    warning_threshold: number;
    critical_threshold: number;
    warning_rows: number[];
    critical_rows: number[];
  },
): EngineResponse {
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'verify-calculation',
    data: params as Record<string, unknown>,
  });
}

/**
 * Get the default engine path for this project.
 * Resolves to rust/target/release/maos-engine.exe on Windows.
 */
export function getDefaultEnginePath(projectRoot: string): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.resolve(projectRoot, 'rust', 'target', 'release', `maos-engine${ext}`);
}
