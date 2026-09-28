/**
 * F9-02: Explicit Endpoint Allowlist Domain Schema & Invariants
 *
 * Implements the authoritative socket-level endpoint policy for MAOS.
 * Enforces loopback-only communication across TCP, UDP, and IPC (named pipes).
 * Strictly forbids external DNS resolution, non-loopback endpoints, public IPs,
 * private LANs, unapproved redirects, and service rebinding.
 */

import * as crypto from 'crypto';
import * as net from 'net';

// ── Types & Enums ───────────────────────────────────────────────────

export type SocketProtocol = 'tcp' | 'udp' | 'pipe';
export type SocketDirection = 'bind' | 'connect';

export type IpClassification =
  | 'loopback'
  | 'private_lan'
  | 'carrier_nat'
  | 'link_local'
  | 'multicast'
  | 'unspecified'
  | 'public'
  | 'invalid';

export interface EndpointDescriptor {
  readonly endpointId: string;
  readonly protocol: SocketProtocol;
  readonly direction: SocketDirection;
  readonly host: string;
  readonly port?: number | string;
  readonly pipeName?: string;
  readonly serviceId?: string;
  readonly processCategory?: string;
  readonly isLoopbackOnly: boolean;
  readonly description: string;
}

export interface EphemeralPortRange {
  readonly min: number;
  readonly max: number;
}

export interface EndpointAllowlistPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly projectId: string;
  readonly profileMode: 'industrial' | 'sovereign-local' | 'cloud' | string;
  readonly declaredEndpoints: readonly EndpointDescriptor[];
  readonly allowedNamedPipes: readonly string[];
  readonly allowEphemeralPorts: boolean;
  readonly ephemeralPortRange?: EphemeralPortRange;
  readonly enforceLoopbackStrict: boolean;
  readonly disallowDnsResolution: boolean;
  readonly createdAt: string;
  readonly policyHash?: string;
}

export interface SocketTargetRequest {
  readonly protocol: SocketProtocol;
  readonly direction: SocketDirection;
  readonly host?: string;
  readonly port?: number;
  readonly pipeName?: string;
  readonly serviceId?: string;
  readonly processId?: number;
}

export interface EndpointValidationResult {
  readonly allowed: boolean;
  readonly errorCode?: EndpointPolicyErrorCode;
  readonly reason?: string;
  readonly matchedEndpointId?: string;
  readonly classification?: IpClassification;
}

export interface PolicyValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly canonicalHash?: string;
}

// ── Error Codes & Hierarchy ─────────────────────────────────────────

export const ENDPOINT_POLICY_ERROR_CODES = {
  NON_LOOPBACK_ENDPOINT: 'NON_LOOPBACK_ENDPOINT',
  DNS_RESOLUTION_FORBIDDEN: 'DNS_RESOLUTION_FORBIDDEN',
  ENDPOINT_NOT_ALLOWLISTED: 'ENDPOINT_NOT_ALLOWLISTED',
  REDIRECTED_ENDPOINT_REJECTED: 'REDIRECTED_ENDPOINT_REJECTED',
  REBINDING_DETECTED: 'REBINDING_DETECTED',
  UNDECLARED_EPHEMERAL_SERVICE: 'UNDECLARED_EPHEMERAL_SERVICE',
  INVALID_ENDPOINT_METADATA: 'INVALID_ENDPOINT_METADATA',
  CROSS_PROJECT_ENDPOINT_VIOLATION: 'CROSS_PROJECT_ENDPOINT_VIOLATION',
  TAMPERED_POLICY_HASH: 'TAMPERED_POLICY_HASH',
} as const;

export type EndpointPolicyErrorCode =
  (typeof ENDPOINT_POLICY_ERROR_CODES)[keyof typeof ENDPOINT_POLICY_ERROR_CODES];

export class EndpointPolicyError extends Error {
  public readonly code: EndpointPolicyErrorCode;
  public readonly detail?: unknown;

  constructor(code: EndpointPolicyErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'EndpointPolicyError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, EndpointPolicyError.prototype);
  }
}

// ── Standard Default Values ─────────────────────────────────────────

export const STANDARD_APPROVED_NAMED_PIPES: readonly string[] = Object.freeze([
  'docker_engine',
  'dockerDesktopPluginEngine',
  'maos_ipc_default',
  'maos-engine-pipe',
]);

export const STANDARD_EPHEMERAL_RANGE: EphemeralPortRange = Object.freeze({
  min: 49152,
  max: 65535,
});

// ── IP Classification & Loopback Detection ──────────────────────────

/**
 * Classifies an IPv4 or IPv6 address string into security categories.
 */
export function classifyIpAddress(ipStr: string): IpClassification {
  if (!ipStr || typeof ipStr !== 'string') return 'invalid';

  const clean = ipStr.trim().toLowerCase().replace(/^\[|\]$/g, '');

  const ipVersion = net.isIP(clean);
  if (ipVersion === 0) {
    return 'invalid';
  }

  if (ipVersion === 4) {
    const parts = clean.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return 'invalid';

    const [a, b] = parts;

    // Loopback: 127.0.0.0/8
    if (a === 127) return 'loopback';

    // Unspecified: 0.0.0.0/8 or 255.255.255.255
    if (a === 0 || clean === '255.255.255.255') return 'unspecified';

    // Private LAN RFC 1918
    if (a === 10) return 'private_lan';
    if (a === 172 && b >= 16 && b <= 31) return 'private_lan';
    if (a === 192 && b === 168) return 'private_lan';

    // Carrier-Grade NAT RFC 6598: 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return 'carrier_nat';

    // Link-Local RFC 3927: 169.254.0.0/16
    if (a === 169 && b === 254) return 'link_local';

    // Multicast RFC 5771: 224.0.0.0/4
    if (a >= 224 && a <= 239) return 'multicast';

    // Otherwise Public
    return 'public';
  }

  if (ipVersion === 6) {
    // IPv6 Loopback: ::1 or 0:0:0:0:0:0:0:1
    if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return 'loopback';

    // IPv4-mapped IPv6 loopback: ::ffff:127.*
    if (clean.startsWith('::ffff:127.')) return 'loopback';

    // IPv4-mapped private / public
    if (clean.startsWith('::ffff:')) {
      const ipv4Part = clean.slice(7);
      return classifyIpAddress(ipv4Part);
    }

    // Unspecified: ::
    if (clean === '::' || clean === '0:0:0:0:0:0:0:0') return 'unspecified';

    // Link-local: fe80::/10
    if (/^fe[89ab][0-9a-f]:/i.test(clean) || clean.startsWith('fe80:')) return 'link_local';

    // Unique Local Address (ULA) RFC 4193: fc00::/7
    if (/^f[cd][0-9a-f]{2}:/i.test(clean)) return 'private_lan';

    // Multicast: ff00::/8
    if (clean.startsWith('ff')) return 'multicast';

    return 'public';
  }

  return 'invalid';
}

/**
 * Checks if a host string is strictly a local loopback target.
 * Rejects public IPs, LANs, external domain names, and wildcard binds.
 */
export function isLoopbackHost(host: string): boolean {
  if (!host || typeof host !== 'string') return false;

  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === 'localhost') return true;

  const classification = classifyIpAddress(normalized);
  return classification === 'loopback';
}

/**
 * Validates whether a named pipe path is approved.
 * Handles both URL style `npipe:////./pipe/<name>` and Windows UNC style `\\.\pipe\<name>`.
 */
export function extractNamedPipeName(pipeUri: string): string | null {
  if (!pipeUri || typeof pipeUri !== 'string') return null;

  const clean = pipeUri.trim();

  // Pipe URL format or Windows UNC format:
  // e.g. npipe:////./pipe/my_pipe, npipe://./pipe/my_pipe, \\.\pipe\my_pipe, //./pipe/my_pipe
  const match = clean.match(/[/\\]pipe[/\\]([^/?#\\]+)/i);
  if (match) return match[1];

  // Bare pipe name (if alphanumeric, underscores, hyphens, or dots)
  if (/^[a-zA-Z0-9_\-.]+$/.test(clean) && !clean.includes('/') && !clean.includes('\\')) {
    return clean;
  }

  return null;
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
 * Computes canonical SHA-256 hash of an EndpointAllowlistPolicy.
 * Excludes `policyHash` itself.
 */
export function computeCanonicalPolicyHash(
  policy: Omit<EndpointAllowlistPolicy, 'policyHash'> | EndpointAllowlistPolicy,
): string {
  const { policyHash: _omitted, ...canonicalPayload } = policy as EndpointAllowlistPolicy;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

// ── Policy Validation Gate ──────────────────────────────────────────

/**
 * Validates an EndpointAllowlistPolicy for completeness, loopback constraints,
 * and canonical hash integrity.
 */
export function validateEndpointPolicy(
  policy: unknown,
  context?: { expectedProjectId?: string },
): PolicyValidationResult {
  const errors: string[] = [];

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { valid: false, errors: ['Policy must be a non-null object.'] };
  }

  const p = policy as Record<string, any>;

  // 1. Schema version
  if (p.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${p.schemaVersion}.`);
  }

  // 2. Policy ID & Project ID
  if (!p.policyId || typeof p.policyId !== 'string' || !p.policyId.trim()) {
    errors.push('policyId is required and must be a non-empty string.');
  }

  if (!p.projectId || typeof p.projectId !== 'string' || !p.projectId.trim()) {
    errors.push('projectId is required and must be a non-empty string.');
  } else if (context?.expectedProjectId && p.projectId !== context.expectedProjectId) {
    errors.push(
      `Cross-project endpoint violation: policy belongs to project "${p.projectId}" but context requested "${context.expectedProjectId}".`,
    );
  }

  // 3. Loopback strictness invariant
  if (p.enforceLoopbackStrict !== true) {
    errors.push('enforceLoopbackStrict must be true in sovereign profile.');
  }

  // 4. Declared Endpoints
  if (!Array.isArray(p.declaredEndpoints) || p.declaredEndpoints.length === 0) {
    errors.push('declaredEndpoints must be a non-empty array of endpoint descriptors.');
  } else {
    for (const ep of p.declaredEndpoints) {
      if (!ep.endpointId) {
        errors.push('Endpoint descriptor missing endpointId.');
      }
      if (!ep.isLoopbackOnly) {
        errors.push(`Endpoint "${ep.endpointId}": isLoopbackOnly must be true.`);
      }
      if (ep.protocol === 'pipe') {
        const pipeName = ep.pipeName || extractNamedPipeName(ep.host);
        if (!pipeName) {
          errors.push(`Pipe endpoint "${ep.endpointId}" must specify a valid pipeName or pipe URI.`);
        }
      } else {
        if (!isLoopbackHost(ep.host)) {
          errors.push(
            `Endpoint "${ep.endpointId}" specifies non-loopback host "${ep.host}". Only loopback targets are permitted.`,
          );
        }
      }
    }
  }

  // 5. Allowed Named Pipes
  if (!Array.isArray(p.allowedNamedPipes) || p.allowedNamedPipes.length === 0) {
    errors.push('allowedNamedPipes must contain at least one approved named pipe identifier.');
  }

  // 6. Canonical Hash Check
  let canonicalHash: string | undefined;
  try {
    canonicalHash = computeCanonicalPolicyHash(p as any);
    if (p.policyHash && p.policyHash !== canonicalHash) {
      errors.push(
        `Policy hash mismatch: expected canonical hash ${canonicalHash}, found ${p.policyHash}.`,
      );
    }
  } catch (err: any) {
    errors.push(`Failed to compute canonical policy hash: ${err.message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    canonicalHash,
  };
}

// ── Standard Industrial Policy Factory ──────────────────────────────

export interface CreateIndustrialPolicyOptions {
  readonly policyId?: string;
  readonly profileMode?: string;
  readonly customEndpoints?: readonly EndpointDescriptor[];
  readonly customNamedPipes?: readonly string[];
  readonly allowEphemeralPorts?: boolean;
  readonly ephemeralPortRange?: EphemeralPortRange;
  readonly createdAt?: string;
}

export function createIndustrialEndpointPolicy(
  projectId: string,
  options: CreateIndustrialPolicyOptions = {},
): EndpointAllowlistPolicy {
  if (!projectId || !projectId.trim()) {
    throw new EndpointPolicyError(
      ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
      'Cannot create EndpointAllowlistPolicy: projectId is required.',
    );
  }

  const policyId = options.policyId || `ep_policy_${projectId}_${Date.now()}`;
  const profileMode = options.profileMode || 'industrial';
  const createdAt = options.createdAt || new Date().toISOString();

  const declaredEndpoints: readonly EndpointDescriptor[] = Object.freeze([
    // Core REST/WS Backend
    {
      endpointId: 'ep_backend_rest',
      protocol: 'tcp',
      direction: 'bind',
      host: '127.0.0.1',
      port: 3847,
      serviceId: 'maos_backend',
      processCategory: 'backend',
      isLoopbackOnly: true,
      description: 'MAOS core orchestration and REST server loopback listener.',
    },
    // Core REST/WS Backend Connect
    {
      endpointId: 'ep_backend_rest_client',
      protocol: 'tcp',
      direction: 'connect',
      host: '127.0.0.1',
      port: 3847,
      serviceId: 'gui_dashboard',
      processCategory: 'frontend',
      isLoopbackOnly: true,
      description: 'Local GUI and internal client connection to MAOS backend.',
    },
    // Local Model Inference Server (scripts/huggingface-openai-server.py or Ollama)
    {
      endpointId: 'ep_model_server',
      protocol: 'tcp',
      direction: 'connect',
      host: '127.0.0.1',
      port: 8000,
      serviceId: 'local_model_server',
      processCategory: 'model',
      isLoopbackOnly: true,
      description: 'Loopback OpenAI-compatible local model inference server.',
    },
    // Alternate Model Server / Ollama Loopback Port
    {
      endpointId: 'ep_ollama_server',
      protocol: 'tcp',
      direction: 'connect',
      host: '127.0.0.1',
      port: 11434,
      serviceId: 'ollama_model_server',
      processCategory: 'model',
      isLoopbackOnly: true,
      description: 'Loopback Ollama inference server for industrial fallback.',
    },
    // IPv6 Loopback Backend Listener
    {
      endpointId: 'ep_backend_ipv6',
      protocol: 'tcp',
      direction: 'bind',
      host: '::1',
      port: 3847,
      serviceId: 'maos_backend',
      processCategory: 'backend',
      isLoopbackOnly: true,
      description: 'IPv6 local loopback listener for modern loopback binding.',
    },
    // Windows Docker Engine Named Pipe
    {
      endpointId: 'ep_docker_pipe',
      protocol: 'pipe',
      direction: 'connect',
      host: 'npipe:////./pipe/docker_engine',
      pipeName: 'docker_engine',
      serviceId: 'sandbox_runner',
      processCategory: 'sandbox',
      isLoopbackOnly: true,
      description: 'Hardened Windows named pipe for local Docker container runner execution.',
    },
    ...(options.customEndpoints || []),
  ]);

  const allowedNamedPipes: readonly string[] = Object.freeze([
    ...STANDARD_APPROVED_NAMED_PIPES,
    ...(options.customNamedPipes || []),
  ]);

  const draft: Omit<EndpointAllowlistPolicy, 'policyHash'> = {
    schemaVersion: 1,
    policyId,
    projectId,
    profileMode,
    declaredEndpoints,
    allowedNamedPipes,
    allowEphemeralPorts: options.allowEphemeralPorts ?? true,
    ephemeralPortRange: options.ephemeralPortRange || STANDARD_EPHEMERAL_RANGE,
    enforceLoopbackStrict: true,
    disallowDnsResolution: true,
    createdAt,
  };

  const policyHash = computeCanonicalPolicyHash(draft);

  return Object.freeze({
    ...draft,
    policyHash,
  });
}

// ── Deterministic Socket Target Validator ───────────────────────────

/**
 * Validates a single socket action (connect/bind/pipe) against an active policy.
 * Fail-closed on any non-loopback host, unknown named pipe, undeclared port,
 * or DNS resolution attempt.
 */
export function validateSocketEndpoint(
  request: SocketTargetRequest,
  policy: EndpointAllowlistPolicy,
): EndpointValidationResult {
  if (!request || typeof request !== 'object') {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
      reason: 'Socket target request must be a valid non-null object.',
    };
  }

  // 1. IPC / Named Pipe Validation
  if (request.protocol === 'pipe') {
    const pipeCandidate = request.pipeName || request.host;
    if (!pipeCandidate) {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
        reason: 'Pipe connection requires pipeName or pipe host URI.',
      };
    }

    const extracted = extractNamedPipeName(pipeCandidate);
    if (!extracted) {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED,
        reason: `Malformed or unparseable named pipe target "${pipeCandidate}".`,
      };
    }

    const isApproved = policy.allowedNamedPipes.some(
      (approved) => approved.toLowerCase() === extracted.toLowerCase(),
    );

    if (!isApproved) {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED,
        reason: `Named pipe "${extracted}" is not in approved list [${policy.allowedNamedPipes.join(', ')}].`,
      };
    }

    return {
      allowed: true,
      matchedEndpointId: 'ep_named_pipe',
    };
  }

  // 2. TCP / UDP Validation
  const rawHost = request.host?.trim() || '';
  if (!rawHost) {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
      reason: 'TCP/UDP socket target requires a non-empty host address.',
    };
  }

  // Check for DNS Hostnames (e.g. api.openai.com, google.com)
  const isDirectIp = net.isIP(rawHost) !== 0;
  const isLocalhost = rawHost.toLowerCase() === 'localhost';

  if (!isDirectIp && !isLocalhost) {
    if (policy.disallowDnsResolution) {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN,
        reason: `DNS resolution for host "${rawHost}" is forbidden in sovereign mode. Only direct loopback addresses (127.0.0.1, ::1) are permitted.`,
      };
    }
  }

  // Classify Host
  const classification = isLocalhost ? 'loopback' : classifyIpAddress(rawHost);

  if (classification !== 'loopback') {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT,
      classification,
      reason: `Host "${rawHost}" classified as "${classification}". Sovereign profile strictly permits only loopback endpoints.`,
    };
  }

  // Validate Port
  const port = request.port;
  if (port === undefined || port === null || isNaN(port) || port < 1 || port > 65535) {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
      reason: `Invalid or missing port number: ${port}.`,
    };
  }

  // Match against declared endpoints
  const matched = policy.declaredEndpoints.find((ep) => {
    if (ep.protocol !== request.protocol) return false;
    if (ep.direction !== request.direction) return false;

    // Host matching
    const epHost = ep.host.toLowerCase();
    const reqHost = rawHost.toLowerCase();
    const hostMatches =
      epHost === reqHost ||
      (epHost === 'localhost' && reqHost === '127.0.0.1') ||
      (epHost === '127.0.0.1' && reqHost === 'localhost');

    if (!hostMatches) return false;

    // Port matching
    if (ep.port === undefined || ep.port === '*') return true;
    if (typeof ep.port === 'number') return ep.port === port;
    if (typeof ep.port === 'string') {
      if (ep.port.includes('-')) {
        const [min, max] = ep.port.split('-').map(Number);
        return port >= min && port <= max;
      }
      return parseInt(ep.port, 10) === port;
    }
    return false;
  });

  if (matched) {
    return {
      allowed: true,
      matchedEndpointId: matched.endpointId,
      classification: 'loopback',
    };
  }

  // Check Ephemeral Port Policy (for client connects or declared ranges)
  if (policy.allowEphemeralPorts && request.direction === 'connect') {
    const range = policy.ephemeralPortRange || STANDARD_EPHEMERAL_RANGE;
    if (port >= range.min && port <= range.max) {
      return {
        allowed: true,
        matchedEndpointId: 'ep_ephemeral_client',
        classification: 'loopback',
      };
    }
  }

  // Undeclared ephemeral / bind attempt
  return {
    allowed: false,
    errorCode:
      request.direction === 'bind'
        ? ENDPOINT_POLICY_ERROR_CODES.UNDECLARED_EPHEMERAL_SERVICE
        : ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED,
    classification: 'loopback',
    reason: `Port ${port} on ${rawHost} (${request.protocol} ${request.direction}) is not allowlisted in policy ${policy.policyId}.`,
  };
}

// ── Redirect & Rebinding Validators ─────────────────────────────────

/**
 * Validates whether an HTTP redirect target URL remains within the approved loopback policy.
 * Fails closed if the redirect leaves loopback, changes port to an unapproved port,
 * or switches protocol.
 */
export function validateHttpRedirect(
  originalUrlStr: string,
  targetUrlStr: string,
  policy: EndpointAllowlistPolicy,
): EndpointValidationResult {
  try {
    const orig = new URL(originalUrlStr);
    const target = new URL(targetUrlStr, originalUrlStr);

    // Protocol must remain http or ws
    if (target.protocol !== 'http:' && target.protocol !== 'ws:') {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED,
        reason: `Redirect attempted protocol change to unapproved protocol "${target.protocol}".`,
      };
    }

    const targetPort = target.port ? parseInt(target.port, 10) : target.protocol === 'http:' ? 80 : 3847;

    const socketReq: SocketTargetRequest = {
      protocol: 'tcp',
      direction: 'connect',
      host: target.hostname,
      port: targetPort,
    };

    const res = validateSocketEndpoint(socketReq, policy);
    if (!res.allowed) {
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED,
        reason: `Redirect target "${targetUrlStr}" rejected: ${res.reason}`,
      };
    }

    return { allowed: true, matchedEndpointId: res.matchedEndpointId };
  } catch (err: any) {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED,
      reason: `Malformed redirect URL: ${err.message}`,
    };
  }
}

/**
 * Validates service identity stability to prevent DNS rebinding or port hijacking.
 */
export function validateServiceRebinding(
  serviceId: string,
  currentHost: string,
  currentPort: number,
  expectedHost: string,
  expectedPort: number,
): EndpointValidationResult {
  if (currentHost.toLowerCase() !== expectedHost.toLowerCase() || currentPort !== expectedPort) {
    return {
      allowed: false,
      errorCode: ENDPOINT_POLICY_ERROR_CODES.REBINDING_DETECTED,
      reason: `Service "${serviceId}" rebind detected: expected ${expectedHost}:${expectedPort}, but observed ${currentHost}:${currentPort}. Dynamic rebinding is prohibited.`,
    };
  }

  return { allowed: true };
}
