/**
 * F9-04: Process-Attributed Network Monitor Domain Schema & Invariants
 *
 * Defines domain types, socket observation models, fail-closed violation evaluators,
 * canonical hashing, and epistemic wording validators for passive network monitoring.
 *
 * Epistemic Honesty Invariant:
 * Monitor observations must never claim absolute or universal guarantees
 * (e.g. "Zero data left the machine", "Guaranteed 100% offline").
 * Claims must report precisely what was measured:
 * e.g. "No non-loopback application connections were observed for monitored processes during the observation window."
 */

import * as crypto from 'crypto';
import {
  IpClassification,
  classifyIpAddress,
  isLoopbackHost,
  EndpointAllowlistPolicy,
} from './endpoint-allowlist';
import {
  PROHIBITED_SOVEREIGNTY_CLAIMS,
  STANDARD_OBSERVATION_LIMITATIONS,
  SovereigntyBoundary,
} from './sovereignty-boundary';

// ── Types & Enums ───────────────────────────────────────────────────

export type ObservedSocketProtocol = 'tcp' | 'udp';

export type SocketState =
  | 'ESTABLISHED'
  | 'SYN_SENT'
  | 'SYN_RECV'
  | 'FIN_WAIT1'
  | 'FIN_WAIT2'
  | 'TIME_WAIT'
  | 'CLOSE'
  | 'CLOSE_WAIT'
  | 'LAST_ACK'
  | 'LISTEN'
  | 'CLOSING'
  | 'UNKNOWN';

export interface ObservedSocket {
  readonly protocol: ObservedSocketProtocol;
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly state?: SocketState | string;
  readonly pid: number;
  readonly processName?: string;
  readonly executablePath?: string;
  readonly executableHash?: string;
  readonly timestamp: string;
}

export const NETWORK_VIOLATION_TYPES = {
  NON_LOOPBACK_CONNECTION_DETECTED: 'NON_LOOPBACK_CONNECTION_DETECTED',
  EXTERNAL_INTERFACE_BIND: 'EXTERNAL_INTERFACE_BIND',
  UNDECLARED_LOOPBACK_PORT: 'UNDECLARED_LOOPBACK_PORT',
  UNAUTHORIZED_PROCESS_ACTIVITY: 'UNAUTHORIZED_PROCESS_ACTIVITY',
  PROHIBITED_CLAIM_ATTEMPT: 'PROHIBITED_CLAIM_ATTEMPT',
} as const;

export type NetworkViolationType =
  (typeof NETWORK_VIOLATION_TYPES)[keyof typeof NETWORK_VIOLATION_TYPES];

export type ViolationSeverity = 'warning' | 'critical';

export interface NetworkViolation {
  readonly violationId: string;
  readonly type: NetworkViolationType;
  readonly severity: ViolationSeverity;
  readonly socket: ObservedSocket;
  readonly pid: number;
  readonly processName?: string;
  readonly description: string;
  readonly classification: IpClassification;
  readonly timestamp: string;
}

export interface NetworkObservationSnapshot {
  readonly snapshotId: string;
  readonly timestamp: string;
  readonly totalSockets: number;
  readonly loopbackSockets: number;
  readonly nonLoopbackSockets: number;
  readonly sockets: readonly ObservedSocket[];
  readonly violations: readonly NetworkViolation[];
}

export interface NetworkObservationSummary {
  readonly allObservedLoopback: boolean;
  readonly totalSocketsObserved: number;
  readonly totalSamples: number;
  readonly trackedProcessSocketsCount: number;
  readonly untrackedProcessSocketsCount: number;
  readonly violationsCount: number;
  readonly violationTypes: readonly NetworkViolationType[];
  readonly monitoredPids: readonly number[];
}

export interface NetworkObservationTrace {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly startedAt: string;
  readonly stoppedAt: string;
  readonly policyHash: string;
  readonly boundaryHash: string;
  readonly summary: NetworkObservationSummary;
  readonly samples: readonly NetworkObservationSnapshot[];
  readonly violations: readonly NetworkViolation[];
  readonly observationLimitations: readonly string[];
  readonly claims: readonly string[];
  readonly traceHash?: string;
}

export interface ObservationOptions {
  readonly samplingIntervalMs?: number;
  readonly monitoredPids?: readonly number[];
  readonly monitoredProcessNames?: readonly string[];
  readonly trackAllHostSockets?: boolean;
  readonly failFastOnViolation?: boolean;
}

// ── Error Codes & Hierarchy ─────────────────────────────────────────

export const NETWORK_MONITOR_ERROR_CODES = {
  OBSERVATION_ALREADY_ACTIVE: 'OBSERVATION_ALREADY_ACTIVE',
  NO_ACTIVE_OBSERVATION: 'NO_ACTIVE_OBSERVATION',
  OBSERVATION_TAMPERED: 'OBSERVATION_TAMPERED',
  PROHIBITED_CLAIM_DETECTED: 'PROHIBITED_CLAIM_DETECTED',
  OBSERVER_ADAPTER_ERROR: 'OBSERVER_ADAPTER_ERROR',
  PROCESS_RESOLUTION_FAILED: 'PROCESS_RESOLUTION_FAILED',
  NETWORK_VIOLATION_DETECTED: 'NETWORK_VIOLATION_DETECTED',
  INVALID_TRACE_SCHEMA: 'INVALID_TRACE_SCHEMA',
} as const;

export type NetworkMonitorErrorCode =
  (typeof NETWORK_MONITOR_ERROR_CODES)[keyof typeof NETWORK_MONITOR_ERROR_CODES];

export class NetworkMonitorError extends Error {
  public readonly code: NetworkMonitorErrorCode;
  public readonly detail?: unknown;

  constructor(code: NetworkMonitorErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'NetworkMonitorError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, NetworkMonitorError.prototype);
  }
}

// ── Epistemic Claim Checking ────────────────────────────────────────

/**
 * Asserts that claims in a network observation trace adhere to strict epistemic honesty.
 * Strictly rejects any prohibited absolute claims.
 */
export function assertMeasuredObservationClaims(claims: readonly string[]): void {
  for (const claim of claims) {
    const lower = claim.toLowerCase().trim();
    for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
      if (lower.includes(prohibited)) {
        throw new NetworkMonitorError(
          NETWORK_MONITOR_ERROR_CODES.PROHIBITED_CLAIM_DETECTED,
          `Claim contains prohibited unmeasured absolute assertion "${prohibited}": "${claim}"`,
          { claim, prohibited },
        );
      }
    }
  }
}

export function generateStandardMeasuredClaim(summary: NetworkObservationSummary): string {
  if (summary.violationsCount === 0 && summary.allObservedLoopback) {
    return 'No non-loopback application connections were observed for monitored processes during the observation window.';
  }
  return `Observed ${summary.violationsCount} network boundary violation(s) across ${summary.totalSocketsObserved} evaluated socket(s) during the observation window.`;
}

// ── Canonical Hashing ───────────────────────────────────────────────

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sortedKeys) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
    }
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Computes canonical SHA-256 hash of a NetworkObservationTrace.
 * Excludes `traceHash` itself.
 */
export function computeCanonicalObservationTraceHash(
  trace: Omit<NetworkObservationTrace, 'traceHash'> | NetworkObservationTrace,
): string {
  const { traceHash: _omitted, ...canonicalPayload } = trace as NetworkObservationTrace;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

// ── Socket Evaluation & Violation Detection ─────────────────────────

export interface SocketEvaluationContext {
  readonly monitoredPids?: ReadonlySet<number>;
  readonly monitoredProcessNames?: ReadonlySet<string>;
  readonly strictPorts?: boolean;
}

/**
 * Evaluates an observed socket against an EndpointAllowlistPolicy.
 * Identifies non-loopback destinations, external interface binds,
 * or undeclared loopback ports.
 */
export function evaluateObservedSocket(
  socket: ObservedSocket,
  policy: EndpointAllowlistPolicy,
  boundary?: SovereigntyBoundary,
  context?: SocketEvaluationContext,
): NetworkViolation | null {
  // If PID filtering is active and this PID / process is not monitored, skip unless trackAllHostSockets
  const isMonitored =
    (context?.monitoredPids && context.monitoredPids.has(socket.pid)) ||
    (context?.monitoredProcessNames &&
      socket.processName &&
      context.monitoredProcessNames.has(socket.processName.toLowerCase())) ||
    (!context?.monitoredPids && !context?.monitoredProcessNames);

  if (!isMonitored) {
    return null;
  }

  const stateUpper = (socket.state || '').toUpperCase();
  const isListen = stateUpper === 'LISTEN';

  // 1. Check Local Address Bind
  if (isListen) {
    const localClass = classifyIpAddress(socket.localAddress);
    if (localClass !== 'loopback') {
      // Listening on 0.0.0.0, ::, or a physical interface exposes services to external traffic
      return {
        violationId: `viol_bind_${socket.pid}_${socket.localPort}_${Date.now()}`,
        type: NETWORK_VIOLATION_TYPES.EXTERNAL_INTERFACE_BIND,
        severity: 'critical',
        socket,
        pid: socket.pid,
        processName: socket.processName,
        description: `Monitored process ${socket.processName || socket.pid} bound to non-loopback interface ${socket.localAddress}:${socket.localPort} in LISTEN state (${localClass}).`,
        classification: localClass,
        timestamp: socket.timestamp || new Date().toISOString(),
      };
    }

    // It's a loopback listener. Check if the port is declared in policy if strictPorts is enabled
    if (context?.strictPorts && policy.declaredEndpoints) {
      const portAllowed = policy.declaredEndpoints.some(
        (ep) =>
          ep.protocol === socket.protocol &&
          ep.direction === 'bind' &&
          (Number(ep.port) === socket.localPort || ep.port === '*'),
      );
      if (!portAllowed) {
        return {
          violationId: `viol_port_${socket.pid}_${socket.localPort}_${Date.now()}`,
          type: NETWORK_VIOLATION_TYPES.UNDECLARED_LOOPBACK_PORT,
          severity: 'warning',
          socket,
          pid: socket.pid,
          processName: socket.processName,
          description: `Monitored process ${socket.processName || socket.pid} listening on undeclared loopback port ${socket.localPort}.`,
          classification: 'loopback',
          timestamp: socket.timestamp || new Date().toISOString(),
        };
      }
    }

    return null;
  }

  // 2. Check Remote Address for Connected / Outbound Sockets
  if (socket.remoteAddress && socket.remoteAddress !== '0.0.0.0' && socket.remoteAddress !== '::') {
    const remoteClass = classifyIpAddress(socket.remoteAddress);

    if (remoteClass !== 'loopback') {
      return {
        violationId: `viol_remote_${socket.pid}_${socket.remotePort || 0}_${Date.now()}`,
        type: NETWORK_VIOLATION_TYPES.NON_LOOPBACK_CONNECTION_DETECTED,
        severity: 'critical',
        socket,
        pid: socket.pid,
        processName: socket.processName,
        description: `Monitored process ${socket.processName || socket.pid} connected to non-loopback destination ${socket.remoteAddress}:${socket.remotePort || 0} (${remoteClass}, state: ${stateUpper || 'UNKNOWN'}).`,
        classification: remoteClass,
        timestamp: socket.timestamp || new Date().toISOString(),
      };
    }

    // Loopback target: check if port is declared in policy connect endpoints if strictPorts
    if (context?.strictPorts && socket.remotePort && policy.declaredEndpoints) {
      const portAllowed = policy.declaredEndpoints.some(
        (ep) =>
          ep.protocol === socket.protocol &&
          ep.direction === 'connect' &&
          (Number(ep.port) === socket.remotePort || ep.port === '*'),
      );
      if (!portAllowed) {
        return {
          violationId: `viol_port_conn_${socket.pid}_${socket.remotePort}_${Date.now()}`,
          type: NETWORK_VIOLATION_TYPES.UNDECLARED_LOOPBACK_PORT,
          severity: 'warning',
          socket,
          pid: socket.pid,
          processName: socket.processName,
          description: `Monitored process ${socket.processName || socket.pid} connected to undeclared loopback port ${socket.remotePort}.`,
          classification: 'loopback',
          timestamp: socket.timestamp || new Date().toISOString(),
        };
      }
    }
  }

  return null;
}

// ── Trace Validation ────────────────────────────────────────────────

export interface TraceValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly canonicalHash?: string;
}

export function validateObservationTrace(trace: unknown): TraceValidationResult {
  const errors: string[] = [];

  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    return { valid: false, errors: ['Trace must be a non-null object.'] };
  }

  const t = trace as Record<string, any>;

  if (t.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${t.schemaVersion}.`);
  }

  if (!t.traceId || typeof t.traceId !== 'string') {
    errors.push('traceId is required.');
  }

  if (!t.sessionId || typeof t.sessionId !== 'string') {
    errors.push('sessionId is required.');
  }

  if (!t.policyHash || typeof t.policyHash !== 'string' || t.policyHash.length !== 64) {
    errors.push('policyHash must be a 64-character SHA-256 hex string.');
  }

  if (!t.boundaryHash || typeof t.boundaryHash !== 'string' || t.boundaryHash.length !== 64) {
    errors.push('boundaryHash must be a 64-character SHA-256 hex string.');
  }

  if (!t.summary || typeof t.summary !== 'object') {
    errors.push('summary is required and must be an object.');
  }

  if (!Array.isArray(t.samples)) {
    errors.push('samples must be an array.');
  }

  if (!Array.isArray(t.violations)) {
    errors.push('violations must be an array.');
  }

  if (!Array.isArray(t.claims)) {
    errors.push('claims must be an array of strings.');
  } else {
    try {
      assertMeasuredObservationClaims(t.claims);
    } catch (err: any) {
      errors.push(err.message);
    }
  }

  const canonicalHash = computeCanonicalObservationTraceHash(trace as NetworkObservationTrace);

  if (t.traceHash && t.traceHash !== canonicalHash) {
    errors.push(`traceHash mismatch: expected ${canonicalHash}, found ${t.traceHash}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    canonicalHash,
  };
}
