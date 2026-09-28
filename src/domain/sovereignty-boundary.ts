/**
 * F9-01: Threat and Measurement Boundary Domain Schema & Invariants
 *
 * Formally defines what MAOS measures, what it protects, and what it does
 * NOT claim to prove.
 *
 * Wording Invariant:
 * The system must never claim:
 *   - "Zero data left the machine"
 *   - "The entire operating system is guaranteed offline"
 *   - "Universal host security"
 *   - "No network traffic of any kind"
 *
 * The system may only claim measured facts such as:
 *   - "No non-loopback application connections were observed within the
 *      defined monitored boundary during the verified interval."
 */

import * as crypto from 'crypto';

// ── Types & Enums ───────────────────────────────────────────────────

export type ProcessCategory =
  | 'backend'
  | 'frontend'
  | 'runtime'
  | 'model'
  | 'sandbox'
  | 'service'
  | 'launcher';

export type EndpointProtocol = 'tcp' | 'udp' | 'ipc' | 'unix' | 'npipe';

export type ExclusionCategory =
  | 'operating_system'
  | 'host_hypervisor'
  | 'hardware_dma'
  | 'background_system_services'
  | 'unmonitored_user_processes';

export interface MonitoredProcess {
  readonly processId: string;
  readonly name: string;
  readonly category: ProcessCategory;
  readonly executablePath?: string;
  readonly executableHash?: string;
  readonly pid?: number;
  readonly isolated: boolean;
  readonly description: string;
}

export interface ApprovedEndpointClass {
  readonly endpointId: string;
  readonly protocol: EndpointProtocol;
  readonly hostPattern: string;
  readonly portRange?: string;
  readonly isLoopbackOnly: boolean;
  readonly description: string;
}

export interface ExcludedInfrastructure {
  readonly exclusionId: string;
  readonly category: ExclusionCategory;
  readonly name: string;
  readonly description: string;
  readonly disclaimer: string;
}

export interface MeasurementInterval {
  readonly intervalId: string;
  readonly startCondition: string;
  readonly endCondition: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly isActive: boolean;
}

export interface BoundaryIdentityFields {
  readonly capturedProcessFields: readonly string[];
  readonly capturedConnectionFields: readonly string[];
  readonly capturedAuditFields: readonly string[];
}

export interface SovereigntyBoundary {
  readonly schemaVersion: 1;
  readonly boundaryId: string;
  readonly projectId: string;
  readonly profileMode: 'industrial' | 'sovereign-local' | 'cloud' | string;
  readonly monitoredProcesses: readonly MonitoredProcess[];
  readonly approvedEndpoints: readonly ApprovedEndpointClass[];
  readonly excludedInfrastructure: readonly ExcludedInfrastructure[];
  readonly measurementInterval: MeasurementInterval;
  readonly capturedIdentity: BoundaryIdentityFields;
  readonly observationLimitations: readonly string[];
  readonly redactedAuditFields: readonly string[];
  readonly approvedClaims: readonly string[];
  readonly createdAt: string;
  readonly boundaryHash?: string;
}

export interface BoundaryValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly canonicalHash?: string;
}

// ── Invariant Constants ─────────────────────────────────────────────

export const PROHIBITED_SOVEREIGNTY_CLAIMS: readonly string[] = Object.freeze([
  'zero data left the machine',
  'the entire operating system is guaranteed offline',
  'entire operating system is guaranteed offline',
  'universal host security',
  'no network traffic of any kind',
  'absolute host security',
  'bulletproof air-gap',
  '100% offline operating system',
  'guaranteed unhackable',
  'total workstation offline guarantee',
]);

export const STANDARD_MEASURED_SOVEREIGNTY_CLAIM =
  'No non-loopback application connections were observed within the defined monitored boundary during the verified interval.';

export const STANDARD_REDACTED_AUDIT_FIELDS: readonly string[] = Object.freeze([
  'authorization',
  'sessionToken',
  'apiKey',
  'token',
  'secret',
  'password',
  'promptProse',
  'promptText',
  'rawContent',
  'credential',
]);

export const STANDARD_CAPTURED_IDENTITY: BoundaryIdentityFields = Object.freeze({
  capturedProcessFields: Object.freeze([
    'pid',
    'processName',
    'executablePath',
    'executableHash',
    'commandLineHash',
  ]),
  capturedConnectionFields: Object.freeze([
    'protocol',
    'localAddress',
    'localPort',
    'remoteAddress',
    'remotePort',
    'processId',
    'timestamp',
  ]),
  capturedAuditFields: Object.freeze([
    'eventId',
    'sequence',
    'category',
    'source',
    'timestamp',
    'projectId',
    'hash',
  ]),
});

export const STANDARD_OBSERVATION_LIMITATIONS: readonly string[] = Object.freeze([
  'Application-level monitoring attributes connections only to designated processes within the monitored boundary.',
  'Raw network adapter telemetry outside process-attributed sockets cannot be bound to specific MAOS operations.',
  'Host operating-system services (e.g. Windows Update, mDNS, telemetry) operate outside the MAOS boundary and are not measured.',
  'Virtualization hypervisors and container bridges (e.g. WSL2, Docker Desktop vswitch) maintain independent virtual network stacks.',
  'Physical hardware taps, bus sniffing, and Direct Memory Access (DMA) devices are outside observation capabilities.',
]);

export const STANDARD_EXCLUDED_INFRASTRUCTURE: readonly ExcludedInfrastructure[] = Object.freeze([
  {
    exclusionId: 'exc_os_kernel',
    category: 'operating_system',
    name: 'Operating System Kernel & Host Stack',
    description: 'Windows host kernel, TCP/IP stack, and non-attributed OS network drivers.',
    disclaimer: 'MAOS does not monitor or guarantee offline state for kernel-level OS operations.',
  },
  {
    exclusionId: 'exc_hypervisor',
    category: 'host_hypervisor',
    name: 'Virtualization & Hypervisor Bridges',
    description: 'WSL2 virtual network switch, Hyper-V, and Docker Desktop internal VM networks.',
    disclaimer: 'Hypervisor virtual adapters operate outside the application measurement boundary.',
  },
  {
    exclusionId: 'exc_dma_hardware',
    category: 'hardware_dma',
    name: 'Hardware DMA & Physical Interfaces',
    description: 'Direct Memory Access controllers, PCIe buses, BIOS/UEFI firmware, physical taps.',
    disclaimer: 'Physical hardware exfiltration vectors are beyond software measurement boundaries.',
  },
  {
    exclusionId: 'exc_bg_services',
    category: 'background_system_services',
    name: 'Workstation Background Services',
    description: 'Windows Update, telemetry, Defender definitions, mDNS/LLMNR discovery, time sync.',
    disclaimer: 'OS background services communicate independently and are outside the MAOS boundary.',
  },
  {
    exclusionId: 'exc_user_procs',
    category: 'unmonitored_user_processes',
    name: 'Concurrent Workstation Processes',
    description: 'Third-party user applications, web browsers, background utilities on the host.',
    disclaimer: 'MAOS only measures designated processes inside its defined sovereignty boundary.',
  },
]);

// ── Error Hierarchy ─────────────────────────────────────────────────

export const SOVEREIGNTY_BOUNDARY_ERROR_CODES = {
  INVALID_BOUNDARY_SCHEMA: 'INVALID_BOUNDARY_SCHEMA',
  CROSS_PROJECT_BOUNDARY_VIOLATION: 'CROSS_PROJECT_BOUNDARY_VIOLATION',
  PROHIBITED_CLAIM_DETECTED: 'PROHIBITED_CLAIM_DETECTED',
  AMBIGUOUS_SCOPE: 'AMBIGUOUS_SCOPE',
  MISSING_EXCLUSIONS_DISCLOSURE: 'MISSING_EXCLUSIONS_DISCLOSURE',
  UNAPPROVED_ENDPOINT_CLASS: 'UNAPPROVED_ENDPOINT_CLASS',
  TAMPERED_BOUNDARY_HASH: 'TAMPERED_BOUNDARY_HASH',
} as const;

export type SovereigntyBoundaryErrorCode =
  (typeof SOVEREIGNTY_BOUNDARY_ERROR_CODES)[keyof typeof SOVEREIGNTY_BOUNDARY_ERROR_CODES];

export class SovereigntyBoundaryError extends Error {
  public readonly code: SovereigntyBoundaryErrorCode;
  public readonly detail?: unknown;

  constructor(code: SovereigntyBoundaryErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'SovereigntyBoundaryError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, SovereigntyBoundaryError.prototype);
  }
}

// ── Canonical Hashing ───────────────────────────────────────────────

/**
 * Deterministically sorts object keys for canonical cryptographic hashing.
 */
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
 * Computes canonical SHA-256 hash of a SovereigntyBoundary.
 * Excludes the `boundaryHash` field itself to guarantee tamper-evidence.
 */
export function computeCanonicalBoundaryHash(
  boundary: Omit<SovereigntyBoundary, 'boundaryHash'> | SovereigntyBoundary,
): string {
  const { boundaryHash: _omitted, ...canonicalPayload } = boundary as SovereigntyBoundary;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

// ── Validation Gate ─────────────────────────────────────────────────

/**
 * Validates a SovereigntyBoundary against schema rules, prohibited claims,
 * endpoint allowlists, and project isolation boundaries.
 */
export function validateSovereigntyBoundary(
  boundary: unknown,
  context?: { expectedProjectId?: string },
): BoundaryValidationResult {
  const errors: string[] = [];

  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    return { valid: false, errors: ['Boundary must be a non-null object.'] };
  }

  const b = boundary as Record<string, any>;

  // 1. Schema version
  if (b.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${b.schemaVersion}.`);
  }

  // 2. Boundary and Project IDs
  if (!b.boundaryId || typeof b.boundaryId !== 'string' || !b.boundaryId.trim()) {
    errors.push('boundaryId is required and must be a non-empty string.');
  }

  if (!b.projectId || typeof b.projectId !== 'string' || !b.projectId.trim()) {
    errors.push('projectId is required and must be a non-empty string.');
  } else if (context?.expectedProjectId && b.projectId !== context.expectedProjectId) {
    errors.push(
      `Cross-project boundary violation: boundary belongs to project "${b.projectId}" but context requested "${context.expectedProjectId}".`,
    );
  }

  // 3. Monitored Processes (Ambiguous Scope Check)
  if (!Array.isArray(b.monitoredProcesses) || b.monitoredProcesses.length === 0) {
    errors.push('monitoredProcesses must be a non-empty array of monitored process specifications.');
  } else {
    const requiredCategories: ProcessCategory[] = [
      'backend',
      'frontend',
      'runtime',
      'model',
      'sandbox',
      'service',
      'launcher',
    ];
    const presentCategories = new Set<string>(b.monitoredProcesses.map((p: any) => p?.category));

    for (const cat of requiredCategories) {
      if (!presentCategories.has(cat)) {
        errors.push(`Scope incomplete: missing required process category "${cat}".`);
      }
    }
  }

  // 4. Approved Endpoints (Loopback-Only Invariant)
  if (!Array.isArray(b.approvedEndpoints) || b.approvedEndpoints.length === 0) {
    errors.push('approvedEndpoints must be a non-empty array of approved endpoint classes.');
  } else {
    for (const ep of b.approvedEndpoints) {
      if (!ep.isLoopbackOnly) {
        errors.push(`Unapproved endpoint class "${ep.endpointId}": must have isLoopbackOnly=true.`);
      }
      const host = (ep.hostPattern || '').toLowerCase();
      const isLoopbackHost =
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'localhost' ||
        host.startsWith('127.') ||
        host === 'npipe:////./pipe/' ||
        host.includes('loopback');
      if (!isLoopbackHost) {
        errors.push(
          `Non-loopback endpoint pattern "${ep.hostPattern}" is forbidden in sovereign boundary.`,
        );
      }
    }
  }

  // 5. Excluded Infrastructure Disclosure
  if (!Array.isArray(b.excludedInfrastructure) || b.excludedInfrastructure.length === 0) {
    errors.push('excludedInfrastructure must explicitly disclose all out-of-scope host infrastructure.');
  } else {
    const requiredExclusions: ExclusionCategory[] = [
      'operating_system',
      'host_hypervisor',
      'hardware_dma',
      'background_system_services',
      'unmonitored_user_processes',
    ];
    const presentExclusions = new Set<string>(b.excludedInfrastructure.map((e: any) => e?.category));
    for (const exc of requiredExclusions) {
      if (!presentExclusions.has(exc)) {
        errors.push(`Missing mandatory exclusion disclosure category: "${exc}".`);
      }
    }
  }

  // 6. Prohibited Claims Inspection (Wording Invariant)
  const claimsToCheck: string[] = [];
  if (Array.isArray(b.approvedClaims)) {
    claimsToCheck.push(...b.approvedClaims);
  }
  for (const claim of claimsToCheck) {
    const lower = claim.toLowerCase();
    for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
      if (lower.includes(prohibited)) {
        errors.push(
          `PROHIBITED_CLAIM_DETECTED: Claim "${claim}" makes forbidden absolute guarantee "${prohibited}". Only measured factual statements are permitted.`,
        );
      }
    }
  }

  // 7. Redacted Audit Fields Check
  if (!Array.isArray(b.redactedAuditFields) || b.redactedAuditFields.length === 0) {
    errors.push('redactedAuditFields must be defined to prevent leakage of credentials or prompts.');
  }

  // 8. Canonical Hash Check (if present)
  let canonicalHash: string | undefined;
  try {
    canonicalHash = computeCanonicalBoundaryHash(b as any);
    if (b.boundaryHash && b.boundaryHash !== canonicalHash) {
      errors.push(
        `Boundary hash mismatch: expected canonical hash ${canonicalHash}, found ${b.boundaryHash}.`,
      );
    }
  } catch (err: any) {
    errors.push(`Failed to compute canonical boundary hash: ${err.message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    canonicalHash,
  };
}

// ── Standard Industrial Boundary Factory ────────────────────────────

export interface CreateIndustrialBoundaryOptions {
  readonly boundaryId?: string;
  readonly profileMode?: string;
  readonly customProcesses?: readonly MonitoredProcess[];
  readonly customEndpoints?: readonly ApprovedEndpointClass[];
  readonly measurementIntervalId?: string;
  readonly startedAt?: string;
}

/**
 * Creates a fully-populated, cryptographically sealed SovereigntyBoundary
 * for the Industrial profile with standard monitored processes, loopback-only
 * endpoints, mandatory exclusions, and verified factual claims.
 */
export function createIndustrialSovereigntyBoundary(
  projectId: string,
  options: CreateIndustrialBoundaryOptions = {},
): SovereigntyBoundary {
  if (!projectId || !projectId.trim()) {
    throw new SovereigntyBoundaryError(
      SOVEREIGNTY_BOUNDARY_ERROR_CODES.AMBIGUOUS_SCOPE,
      'Cannot create SovereigntyBoundary: projectId is required.',
    );
  }

  const boundaryId = options.boundaryId || `boundary_${projectId}_${Date.now()}`;
  const profileMode = options.profileMode || 'industrial';
  const createdAt = options.startedAt || new Date().toISOString();

  const monitoredProcesses: readonly MonitoredProcess[] = Object.freeze([
    {
      processId: 'proc_backend',
      name: 'maos_backend',
      category: 'backend',
      executablePath: 'dist/cli/index.js',
      isolated: true,
      description: 'MAOS core orchestration and REST server process bound strictly to loopback.',
    },
    {
      processId: 'proc_gui',
      name: 'gui_dashboard',
      category: 'frontend',
      executablePath: 'dist/gui/index.html',
      isolated: true,
      description: 'Local browser dashboard communicating exclusively via 127.0.0.1 loopback REST/WS.',
    },
    {
      processId: 'proc_agents',
      name: 'agent_runtimes',
      category: 'runtime',
      executablePath: 'dist/core/agent-runner.js',
      isolated: true,
      description: 'Autonomous agent runtime workers operating under strict capability routing.',
    },
    {
      processId: 'proc_model',
      name: 'model_server_and_leases',
      category: 'model',
      executablePath: 'ollama / local-model-runner',
      isolated: true,
      description: 'Local loopback model inference server and cryptographic residency lease manager.',
    },
    {
      processId: 'proc_sandbox',
      name: 'docker_sandbox_containers',
      category: 'sandbox',
      executablePath: 'maos-sandbox-runner:0.3.0-industrial',
      isolated: true,
      description: 'Hardened Docker container instances with --network none, read-only rootfs, and dropped caps.',
    },
    {
      processId: 'proc_services',
      name: 'project_services',
      category: 'service',
      executablePath: 'dist/service/index.js',
      isolated: true,
      description: 'Internal project services (audit, task, verifier, trace, idempotency).',
    },
    {
      processId: 'proc_launcher',
      name: 'cli_launcher_processes',
      category: 'launcher',
      executablePath: 'node dist/cli/index.js',
      isolated: true,
      description: 'Command line interface launcher and local process coordinator.',
    },
    ...(options.customProcesses || []),
  ]);

  const approvedEndpoints: readonly ApprovedEndpointClass[] = Object.freeze([
    {
      endpointId: 'ep_loopback_ipv4',
      protocol: 'tcp',
      hostPattern: '127.0.0.1',
      portRange: '1024-65535',
      isLoopbackOnly: true,
      description: 'Standard local loopback IPv4 interface for intra-process and model server calls.',
    },
    {
      endpointId: 'ep_loopback_ipv6',
      protocol: 'tcp',
      hostPattern: '::1',
      portRange: '1024-65535',
      isLoopbackOnly: true,
      description: 'Standard local loopback IPv6 interface.',
    },
    {
      endpointId: 'ep_loopback_pipe',
      protocol: 'npipe',
      hostPattern: 'npipe:////./pipe/',
      isLoopbackOnly: true,
      description: 'Windows named pipe interface for local container runtime and IPC.',
    },
    ...(options.customEndpoints || []),
  ]);

  const excludedInfrastructure: readonly ExcludedInfrastructure[] = Object.freeze([
    {
      exclusionId: 'exc_os_kernel',
      category: 'operating_system',
      name: 'Operating System Kernel & Host Stack',
      description: 'Windows host kernel, TCP/IP stack, and non-attributed OS network drivers.',
      disclaimer: 'MAOS does not monitor or guarantee offline state for kernel-level OS operations.',
    },
    {
      exclusionId: 'exc_hypervisor',
      category: 'host_hypervisor',
      name: 'Virtualization & Hypervisor Bridges',
      description: 'WSL2 virtual network switch, Hyper-V, and Docker Desktop internal VM networks.',
      disclaimer: 'Hypervisor virtual adapters operate outside the application measurement boundary.',
    },
    {
      exclusionId: 'exc_dma_hardware',
      category: 'hardware_dma',
      name: 'Hardware DMA & Physical Interfaces',
      description: 'Direct Memory Access controllers, PCIe buses, BIOS/UEFI firmware, physical taps.',
      disclaimer: 'Physical hardware exfiltration vectors are beyond software measurement boundaries.',
    },
    {
      exclusionId: 'exc_bg_services',
      category: 'background_system_services',
      name: 'Workstation Background Services',
      description: 'Windows Update, telemetry, Defender definitions, mDNS/LLMNR discovery, time sync.',
      disclaimer: 'OS background services communicate independently and are outside the MAOS boundary.',
    },
    {
      exclusionId: 'exc_user_procs',
      category: 'unmonitored_user_processes',
      name: 'Concurrent Workstation Processes',
      description: 'Third-party user applications, web browsers, background utilities on the host.',
      disclaimer: 'MAOS only measures designated processes inside its defined sovereignty boundary.',
    },
  ]);

  const measurementInterval: MeasurementInterval = Object.freeze({
    intervalId: options.measurementIntervalId || `interval_${boundaryId}`,
    startCondition: 'PROJECT_SESSION_INITIALIZED',
    endCondition: 'PROJECT_SESSION_CLOSED',
    startedAt: createdAt,
    isActive: true,
  });

  const draft: Omit<SovereigntyBoundary, 'boundaryHash'> = {
    schemaVersion: 1,
    boundaryId,
    projectId,
    profileMode,
    monitoredProcesses,
    approvedEndpoints,
    excludedInfrastructure,
    measurementInterval,
    capturedIdentity: STANDARD_CAPTURED_IDENTITY,
    observationLimitations: STANDARD_OBSERVATION_LIMITATIONS,
    redactedAuditFields: STANDARD_REDACTED_AUDIT_FIELDS,
    approvedClaims: Object.freeze([STANDARD_MEASURED_SOVEREIGNTY_CLAIM]),
    createdAt,
  };

  const boundaryHash = computeCanonicalBoundaryHash(draft);

  return Object.freeze({
    ...draft,
    boundaryHash,
  });
}
