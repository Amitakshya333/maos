/**
 * F9-05: Service and Process Endpoint Identity Domain Schema & Invariants
 *
 * Establishes trusted, verifiable bindings between observed network endpoints
 * (TCP/UDP ports, pipes) and the processes, services, and model leases that own them.
 *
 * Fail-Closed Invariant:
 * Identity trust is immediately revoked and workflows blocked/terminated if:
 *   - PID_REUSED
 *   - PORT_REUSED
 *   - EXECUTABLE_HASH_MISMATCH
 *   - PROJECT_ROOT_MISMATCH
 *   - SERVICE_IDENTITY_MISMATCH
 *   - MODEL_REVISION_MISMATCH
 *   - UNTRUSTED_DESCENDANT
 *   - ENDPOINT_OWNER_UNRESOLVED
 *   - SERVICE_HIJACK_DETECTED
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { PROHIBITED_SOVEREIGNTY_CLAIMS } from './sovereignty-boundary';

// ── Types & Enums ───────────────────────────────────────────────────

export type IdentityStatus = 'trusted' | 'revoked' | 'terminated';
export type EndpointBindingStatus = 'active' | 'closed' | 'hijacked';
export type ProcessRuntimeType = 'node' | 'python' | 'native' | 'docker_container';

export const SERVICE_IDENTITY_ERROR_CODES = {
  PID_REUSED: 'PID_REUSED',
  PORT_REUSED: 'PORT_REUSED',
  EXECUTABLE_HASH_MISMATCH: 'EXECUTABLE_HASH_MISMATCH',
  PROJECT_ROOT_MISMATCH: 'PROJECT_ROOT_MISMATCH',
  SERVICE_IDENTITY_MISMATCH: 'SERVICE_IDENTITY_MISMATCH',
  MODEL_REVISION_MISMATCH: 'MODEL_REVISION_MISMATCH',
  UNTRUSTED_DESCENDANT: 'UNTRUSTED_DESCENDANT',
  ENDPOINT_OWNER_UNRESOLVED: 'ENDPOINT_OWNER_UNRESOLVED',
  SERVICE_HIJACK_DETECTED: 'SERVICE_HIJACK_DETECTED',
  CROSS_PROJECT_IDENTITY_REJECTED: 'CROSS_PROJECT_IDENTITY_REJECTED',
  IDENTITY_TAMPERED: 'IDENTITY_TAMPERED',
  PROHIBITED_CLAIM_DETECTED: 'PROHIBITED_CLAIM_DETECTED',
} as const;

export type ServiceIdentityErrorCode =
  (typeof SERVICE_IDENTITY_ERROR_CODES)[keyof typeof SERVICE_IDENTITY_ERROR_CODES];

export class ServiceIdentityError extends Error {
  public readonly code: ServiceIdentityErrorCode;
  public readonly detail?: unknown;

  constructor(code: ServiceIdentityErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ServiceIdentityError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, ServiceIdentityError.prototype);
  }
}

export interface RuntimeManifest {
  readonly runtimeType: ProcessRuntimeType;
  readonly version: string;
  readonly containerImageDigest?: string;
  readonly environmentType?: string;
}

export interface ModelIdentityRecord {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly manifestHash: string;
  readonly weightsHash?: string;
}

export interface TrackedProcessIdentity {
  readonly processId: number; // Operating-system PID
  readonly parentPid?: number;
  readonly approvedDescendantPids: readonly number[];
  readonly processName: string;
  readonly executablePath: string;
  readonly executableHash: string; // SHA-256 of the binary
  readonly commandLineHash?: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectRootHash: string;
  readonly serviceIdentity: string; // e.g., 'maos_backend', 'local_model_server'
  readonly runtimeManifest: RuntimeManifest;
  readonly modelIdentity?: ModelIdentityRecord;
  readonly activeModelLeases: readonly string[];
  readonly registeredAt: string;
  readonly lastVerifiedAt: string;
  readonly status: IdentityStatus;
  readonly revocationReason?: ServiceIdentityErrorCode;
}

export interface TrackedEndpointBinding {
  readonly bindingId: string;
  readonly protocol: 'tcp' | 'udp' | 'pipe';
  readonly direction: 'bind' | 'connect';
  readonly localAddress: string;
  readonly localPort?: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly pipeName?: string;
  readonly owningPid: number;
  readonly serviceIdentity: string;
  readonly boundAt: string;
  readonly status: EndpointBindingStatus;
  readonly lastVerifiedAt: string;
}

export interface ServiceEndpointIdentityMapping {
  readonly schemaVersion: 1;
  readonly mappingId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly boundaryHash: string;
  readonly endpointPolicyHash: string;
  readonly processes: readonly TrackedProcessIdentity[];
  readonly endpointBindings: readonly TrackedEndpointBinding[];
  readonly createdAt: string;
  readonly lastVerifiedAt: string;
  readonly mappingHash?: string;
}

export interface IdentityTrustResult {
  readonly trusted: boolean;
  readonly errorCode?: ServiceIdentityErrorCode;
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
}

// ── Invariant Functions ─────────────────────────────────────────────

export function computeProjectRootHash(projectRoot: string): string {
  const canonical = path.resolve(projectRoot).toLowerCase().replace(/\\/g, '/');
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Checks that no sensitive credentials, API keys, or raw prompts exist in an identity record.
 */
export function assertPrivacySafeIdentity(obj: unknown): void {
  const SENSITIVE_KEYS = [
    'authorization',
    'apikey',
    'api_key',
    'sessiontoken',
    'secret',
    'password',
    'promptprose',
    'rawprompt',
    'token',
  ];

  function check(val: any, pathStr: string) {
    if (!val || typeof val !== 'object') return;

    if (Array.isArray(val)) {
      val.forEach((item, idx) => check(item, `${pathStr}[${idx}]`));
      return;
    }

    for (const key of Object.keys(val)) {
      const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const sensitive of SENSITIVE_KEYS) {
        if (lowerKey.includes(sensitive)) {
          throw new ServiceIdentityError(
            SERVICE_IDENTITY_ERROR_CODES.IDENTITY_TAMPERED,
            `Privacy leak detected: identity record contains sensitive field "${key}" at ${pathStr}`,
          );
        }
      }
      check(val[key], `${pathStr}.${key}`);
    }
  }

  check(obj, 'identity');
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
 * Computes canonical SHA-256 hash of a ServiceEndpointIdentityMapping.
 * Excludes `mappingHash` itself.
 */
export function computeCanonicalIdentityMappingHash(
  mapping: Omit<ServiceEndpointIdentityMapping, 'mappingHash'> | ServiceEndpointIdentityMapping,
): string {
  const { mappingHash: _omitted, ...canonicalPayload } = mapping as ServiceEndpointIdentityMapping;
  const canonicalString = canonicalJson(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

// ── Validation Evaluators ───────────────────────────────────────────

export interface CurrentProcessProbe {
  readonly pid: number;
  readonly executableHash: string;
  readonly projectRoot: string;
  readonly parentPid?: number;
  readonly descendantPids?: readonly number[];
  readonly modelRevision?: string;
  readonly activeModelLeases?: readonly string[];
}

/**
 * Evaluates whether a live process matches its registered trusted identity.
 * Fails closed on hash change, project root deviation, unapproved descendants,
 * or model revision drift.
 */
export function validateProcessTrust(
  registered: TrackedProcessIdentity,
  current: CurrentProcessProbe,
): IdentityTrustResult {
  if (registered.status === 'revoked' || registered.status === 'terminated') {
    return {
      trusted: false,
      errorCode: registered.revocationReason || SERVICE_IDENTITY_ERROR_CODES.SERVICE_IDENTITY_MISMATCH,
      reason: `Process PID ${registered.processId} (${registered.serviceIdentity}) is already ${registered.status}.`,
    };
  }

  if (registered.processId !== current.pid) {
    return {
      trusted: false,
      errorCode: SERVICE_IDENTITY_ERROR_CODES.PID_REUSED,
      reason: `PID mismatch: registered PID ${registered.processId} does not match probed PID ${current.pid}.`,
    };
  }

  // 1. Executable Hash
  if (registered.executableHash.toLowerCase() !== current.executableHash.toLowerCase()) {
    return {
      trusted: false,
      errorCode: SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH,
      reason: `Executable hash mismatch for PID ${current.pid} (${registered.serviceIdentity}): expected ${registered.executableHash}, found ${current.executableHash}.`,
      details: {
        expected: registered.executableHash,
        actual: current.executableHash,
      },
    };
  }

  // 2. Project Root
  const expectedRoot = path.resolve(registered.projectRoot).toLowerCase();
  const currentRoot = path.resolve(current.projectRoot).toLowerCase();
  if (expectedRoot !== currentRoot) {
    return {
      trusted: false,
      errorCode: SERVICE_IDENTITY_ERROR_CODES.PROJECT_ROOT_MISMATCH,
      reason: `Project root mismatch for PID ${current.pid}: registered root "${registered.projectRoot}" does not match probed root "${current.projectRoot}".`,
      details: {
        expected: registered.projectRoot,
        actual: current.projectRoot,
      },
    };
  }

  // 3. Model Revision (if modelIdentity defined)
  if (registered.modelIdentity && current.modelRevision) {
    if (registered.modelIdentity.modelRevision !== current.modelRevision) {
      return {
        trusted: false,
        errorCode: SERVICE_IDENTITY_ERROR_CODES.MODEL_REVISION_MISMATCH,
        reason: `Model revision mismatch for model service PID ${current.pid}: expected revision "${registered.modelIdentity.modelRevision}", observed "${current.modelRevision}".`,
        details: {
          expected: registered.modelIdentity.modelRevision,
          actual: current.modelRevision,
        },
      };
    }
  }

  // 4. Descendant Process Check
  if (current.descendantPids && current.descendantPids.length > 0) {
    const approvedSet = new Set(registered.approvedDescendantPids);
    for (const dPid of current.descendantPids) {
      if (!approvedSet.has(dPid)) {
        return {
          trusted: false,
          errorCode: SERVICE_IDENTITY_ERROR_CODES.UNTRUSTED_DESCENDANT,
          reason: `Untrusted descendant PID ${dPid} spawned under monitored process ${registered.serviceIdentity} (PID ${current.pid}).`,
          details: { untrustedPid: dPid, approvedDescendants: registered.approvedDescendantPids },
        };
      }
    }
  }

  return { trusted: true };
}

/**
 * Validates identity mapping schema and hash integrity.
 */
export function validateIdentityMapping(
  mapping: unknown,
): { valid: boolean; errors: string[]; canonicalHash?: string } {
  const errors: string[] = [];

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { valid: false, errors: ['Identity mapping must be a non-null object.'] };
  }

  const m = mapping as Record<string, any>;

  if (m.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${m.schemaVersion}.`);
  }

  if (!m.mappingId || typeof m.mappingId !== 'string') {
    errors.push('mappingId is required.');
  }

  if (!m.projectId || typeof m.projectId !== 'string') {
    errors.push('projectId is required.');
  }

  if (!m.projectRoot || typeof m.projectRoot !== 'string') {
    errors.push('projectRoot is required.');
  }

  if (!m.boundaryHash || typeof m.boundaryHash !== 'string' || m.boundaryHash.length !== 64) {
    errors.push('boundaryHash must be a 64-character SHA-256 hex string.');
  }

  if (!m.endpointPolicyHash || typeof m.endpointPolicyHash !== 'string' || m.endpointPolicyHash.length !== 64) {
    errors.push('endpointPolicyHash must be a 64-character SHA-256 hex string.');
  }

  if (!Array.isArray(m.processes)) {
    errors.push('processes must be an array.');
  }

  if (!Array.isArray(m.endpointBindings)) {
    errors.push('endpointBindings must be an array.');
  }

  try {
    assertPrivacySafeIdentity(m);
  } catch (err: any) {
    errors.push(err.message);
  }

  const canonicalHash = computeCanonicalIdentityMappingHash(m as ServiceEndpointIdentityMapping);
  if (m.mappingHash && m.mappingHash !== canonicalHash) {
    errors.push(`mappingHash mismatch: expected ${canonicalHash}, found ${m.mappingHash}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    canonicalHash,
  };
}
