/**
 * F9-05: Service and Process Endpoint Identity Application Service
 *
 * Maintains trusted mappings between observed endpoints (ports, pipes) and the
 * processes/services that own them. Enforces fail-closed trust revocation on
 * PID reuse, port reuse, hash drift, project root deviation, or model revision mismatch.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import type { SovereigntyBoundaryService } from './sovereignty-boundary-service';
import {
  TrackedProcessIdentity,
  TrackedEndpointBinding,
  ServiceEndpointIdentityMapping,
  IdentityTrustResult,
  CurrentProcessProbe,
  RuntimeManifest,
  ModelIdentityRecord,
  ServiceIdentityError,
  SERVICE_IDENTITY_ERROR_CODES,
  ServiceIdentityErrorCode,
  computeProjectRootHash,
  computeCanonicalIdentityMappingHash,
  validateProcessTrust,
  validateIdentityMapping,
  assertPrivacySafeIdentity,
} from '../domain/service-identity';
import { computeCanonicalBoundaryHash } from '../domain/sovereignty-boundary';
import { computeCanonicalPolicyHash } from '../domain/endpoint-allowlist';
import { ObservedSocket } from '../domain/network-monitor';

export interface ServiceIdentityServiceOptions {
  readonly auditService?: AuditService;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly sovereigntyBoundary?: SovereigntyBoundaryService;
}

export interface RegisterProcessParams {
  readonly pid: number;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly serviceIdentity: string;
  readonly processName: string;
  readonly executablePath: string;
  readonly executableHash: string;
  readonly parentPid?: number;
  readonly approvedDescendantPids?: readonly number[];
  readonly runtimeManifest?: RuntimeManifest;
  readonly modelIdentity?: ModelIdentityRecord;
  readonly activeModelLeases?: readonly string[];
}

export interface RegisterEndpointBindingParams {
  readonly protocol: 'tcp' | 'udp' | 'pipe';
  readonly direction: 'bind' | 'connect';
  readonly owningPid: number;
  readonly serviceIdentity: string;
  readonly localAddress: string;
  readonly localPort?: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly pipeName?: string;
}

export class ServiceIdentityService {
  private readonly identityDir: string;
  private readonly mappingFilePath: string;

  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly sovereigntyBoundary?: SovereigntyBoundaryService;

  private readonly processes = new Map<number, TrackedProcessIdentity>();
  private readonly endpointBindings = new Map<string, TrackedEndpointBinding>();

  constructor(
    private readonly projectRoot: string,
    options: ServiceIdentityServiceOptions = {},
  ) {
    this.identityDir = path.join(this.projectRoot, '.maos', 'identity');
    this.mappingFilePath = path.join(this.identityDir, 'trusted-identity-mapping.json');

    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.sovereigntyBoundary = options.sovereigntyBoundary;

    this.ensureDirectory();
    this.loadPersistedMapping();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.identityDir)) {
      fs.mkdirSync(this.identityDir, { recursive: true });
    }
  }

  private loadPersistedMapping(): void {
    if (!fs.existsSync(this.mappingFilePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.mappingFilePath, 'utf-8');
      if (!content.trim()) return;

      const mapping = JSON.parse(content) as ServiceEndpointIdentityMapping;
      const val = validateIdentityMapping(mapping);
      if (val.valid) {
        for (const p of mapping.processes) {
          this.processes.set(p.processId, p);
        }
        for (const b of mapping.endpointBindings) {
          const key = this.buildBindingKey(b.protocol, b.direction, b.localPort || b.remotePort, b.pipeName);
          this.endpointBindings.set(key, b);
        }
      }
    } catch {
      // Invalidation or corruption triggers clean state
    }
  }

  private buildBindingKey(
    protocol: string,
    direction: string,
    port?: number,
    pipeName?: string,
  ): string {
    return `${protocol.toLowerCase()}_${direction.toLowerCase()}_${port !== undefined ? port : pipeName || '*'}`;
  }

  /**
   * Registers a new process into the trusted identity store.
   * Fails closed if cross-project mismatch or PID reuse is detected.
   */
  public async registerProcess(params: RegisterProcessParams): Promise<TrackedProcessIdentity> {
    // 1. Cross-Project Isolation Check
    const expectedRoot = path.resolve(this.projectRoot).toLowerCase();
    const providedRoot = path.resolve(params.projectRoot).toLowerCase();
    if (expectedRoot !== providedRoot) {
      throw new ServiceIdentityError(
        SERVICE_IDENTITY_ERROR_CODES.CROSS_PROJECT_IDENTITY_REJECTED,
        `Cross-project registration rejected: project root "${params.projectRoot}" does not match service project root "${this.projectRoot}".`,
        { expectedRoot: this.projectRoot, providedRoot: params.projectRoot },
      );
    }

    // 2. PID Reuse Detection
    const existing = this.processes.get(params.pid);
    if (existing && existing.status === 'trusted') {
      if (
        existing.executableHash.toLowerCase() !== params.executableHash.toLowerCase() ||
        existing.serviceIdentity !== params.serviceIdentity
      ) {
        await this.revokeProcess(params.pid, SERVICE_IDENTITY_ERROR_CODES.PID_REUSED, false);
        throw new ServiceIdentityError(
          SERVICE_IDENTITY_ERROR_CODES.PID_REUSED,
          `PID reuse detected: PID ${params.pid} previously trusted as "${existing.serviceIdentity}" (${existing.executableHash}) attempted re-registration as "${params.serviceIdentity}" (${params.executableHash}).`,
          { existing, attempted: params },
        );
      }
    }

    const now = new Date().toISOString();
    const projectRootHash = computeProjectRootHash(params.projectRoot);

    const processIdentity: TrackedProcessIdentity = {
      processId: params.pid,
      parentPid: params.parentPid,
      approvedDescendantPids: Object.freeze(params.approvedDescendantPids ? [...params.approvedDescendantPids] : []),
      processName: params.processName,
      executablePath: params.executablePath,
      executableHash: params.executableHash,
      projectId: params.projectId,
      projectRoot: params.projectRoot,
      projectRootHash,
      serviceIdentity: params.serviceIdentity,
      runtimeManifest: params.runtimeManifest || {
        runtimeType: 'node',
        version: process.version,
      },
      modelIdentity: params.modelIdentity,
      activeModelLeases: Object.freeze(params.activeModelLeases ? [...params.activeModelLeases] : []),
      registeredAt: now,
      lastVerifiedAt: now,
      status: 'trusted',
    };

    assertPrivacySafeIdentity(processIdentity);

    this.processes.set(params.pid, processIdentity);
    this.persistMapping();

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'service-identity',
          data: {
            event: 'SERVICE_IDENTITY_REGISTERED',
            pid: params.pid,
            serviceIdentity: params.serviceIdentity,
            executableHash: params.executableHash,
            projectId: params.projectId,
          },
        });
      } catch {
        // Keep registration resilient
      }
    }

    return processIdentity;
  }

  /**
   * Binds an endpoint (port or pipe) to a registered process and service identity.
   * Fails closed if the owner PID is not trusted or if port reuse / hijacking is detected.
   */
  public async registerEndpointBinding(
    params: RegisterEndpointBindingParams,
  ): Promise<TrackedEndpointBinding> {
    // 1. Verify owner PID
    const ownerProcess = this.processes.get(params.owningPid);
    if (!ownerProcess || ownerProcess.status !== 'trusted') {
      throw new ServiceIdentityError(
        SERVICE_IDENTITY_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED,
        `Cannot bind endpoint: owner PID ${params.owningPid} is not registered or is not in trusted status.`,
        { owningPid: params.owningPid },
      );
    }

    if (ownerProcess.serviceIdentity !== params.serviceIdentity) {
      throw new ServiceIdentityError(
        SERVICE_IDENTITY_ERROR_CODES.SERVICE_IDENTITY_MISMATCH,
        `Service identity mismatch: PID ${params.owningPid} is registered as "${ownerProcess.serviceIdentity}", but attempted binding as "${params.serviceIdentity}".`,
        { expected: ownerProcess.serviceIdentity, actual: params.serviceIdentity },
      );
    }

    // 2. Port / Pipe Reuse & Hijack Detection
    const key = this.buildBindingKey(
      params.protocol,
      params.direction,
      params.localPort || params.remotePort,
      params.pipeName,
    );

    const existingBinding = this.endpointBindings.get(key);
    if (existingBinding && existingBinding.status === 'active') {
      if (existingBinding.owningPid !== params.owningPid) {
        throw new ServiceIdentityError(
          SERVICE_IDENTITY_ERROR_CODES.PORT_REUSED,
          `Port reuse detected on ${key}: previously bound by PID ${existingBinding.owningPid} (${existingBinding.serviceIdentity}), new binding requested by PID ${params.owningPid} (${params.serviceIdentity}).`,
          { existingBinding, requested: params },
        );
      }
    }

    const now = new Date().toISOString();
    const binding: TrackedEndpointBinding = {
      bindingId: `bind_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      protocol: params.protocol,
      direction: params.direction,
      localAddress: params.localAddress,
      localPort: params.localPort,
      remoteAddress: params.remoteAddress,
      remotePort: params.remotePort,
      pipeName: params.pipeName,
      owningPid: params.owningPid,
      serviceIdentity: params.serviceIdentity,
      boundAt: now,
      status: 'active',
      lastVerifiedAt: now,
    };

    assertPrivacySafeIdentity(binding);

    this.endpointBindings.set(key, binding);
    this.persistMapping();

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'service-identity',
          data: {
            event: 'ENDPOINT_BINDING_REGISTERED',
            bindingId: binding.bindingId,
            protocol: binding.protocol,
            direction: binding.direction,
            localPort: binding.localPort,
            owningPid: binding.owningPid,
            serviceIdentity: binding.serviceIdentity,
          },
        });
      } catch {
        // Resilient
      }
    }

    return binding;
  }

  /**
   * Verifies an observed socket against the registered identity mapping.
   * Fails closed if the PID is unknown, if the executable hash changed,
   * or if port hijacking is detected.
   */
  public async verifyObservedEndpoint(observed: ObservedSocket): Promise<IdentityTrustResult> {
    // 1. Resolve Process Owner
    const processIdentity = this.processes.get(observed.pid);
    if (!processIdentity) {
      return {
        trusted: false,
        errorCode: SERVICE_IDENTITY_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED,
        reason: `Observed socket on port ${observed.localPort || observed.remotePort} owned by unresolved PID ${observed.pid} (${observed.processName || 'unknown'}).`,
        details: { observed },
      };
    }

    if (processIdentity.status !== 'trusted') {
      return {
        trusted: false,
        errorCode: processIdentity.revocationReason || SERVICE_IDENTITY_ERROR_CODES.SERVICE_IDENTITY_MISMATCH,
        reason: `Observed socket owned by untrusted/revoked process PID ${observed.pid} (${processIdentity.serviceIdentity}, reason: ${processIdentity.revocationReason}).`,
        details: { processIdentity },
      };
    }

    // 2. Verify Executable Hash
    if (observed.executableHash && processIdentity.executableHash) {
      if (observed.executableHash.toLowerCase() !== processIdentity.executableHash.toLowerCase()) {
        await this.revokeProcess(observed.pid, SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH, true);
        return {
          trusted: false,
          errorCode: SERVICE_IDENTITY_ERROR_CODES.EXECUTABLE_HASH_MISMATCH,
          reason: `Executable hash mismatch for observed PID ${observed.pid}: expected ${processIdentity.executableHash}, observed ${observed.executableHash}. Trust revoked.`,
          details: { expected: processIdentity.executableHash, actual: observed.executableHash },
        };
      }
    }

    // 3. Check for Port Hijacking
    if (observed.localPort) {
      const key = this.buildBindingKey(observed.protocol, 'bind', observed.localPort);
      const registered = this.endpointBindings.get(key);
      if (registered && registered.status === 'active' && registered.owningPid !== observed.pid) {
        await this.revokeProcess(observed.pid, SERVICE_IDENTITY_ERROR_CODES.SERVICE_HIJACK_DETECTED, true);
        return {
          trusted: false,
          errorCode: SERVICE_IDENTITY_ERROR_CODES.SERVICE_HIJACK_DETECTED,
          reason: `Service hijack detected on port ${observed.localPort}: registered to PID ${registered.owningPid} (${registered.serviceIdentity}), but observed active under PID ${observed.pid}.`,
          details: { registeredOwner: registered.owningPid, hijackingPid: observed.pid },
        };
      }
    }

    return { trusted: true };
  }

  /**
   * Verifies the live status and invariants of a registered process.
   */
  public async verifyProcessIdentity(
    pid: number,
    currentMeta: CurrentProcessProbe,
  ): Promise<IdentityTrustResult> {
    const processIdentity = this.processes.get(pid);
    if (!processIdentity) {
      return {
        trusted: false,
        errorCode: SERVICE_IDENTITY_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED,
        reason: `Process PID ${pid} is not registered in the identity store.`,
      };
    }

    const result = validateProcessTrust(processIdentity, currentMeta);
    if (!result.trusted) {
      await this.revokeProcess(pid, result.errorCode!, false);
      return result;
    }

    // Update lastVerifiedAt
    const updated: TrackedProcessIdentity = {
      ...processIdentity,
      lastVerifiedAt: new Date().toISOString(),
    };
    this.processes.set(pid, updated);
    this.persistMapping();

    return { trusted: true };
  }

  /**
   * Revokes trust from a process and all its associated endpoint bindings.
   * Optionally terminates the offending process.
   */
  public async revokeProcess(
    pid: number,
    reason: ServiceIdentityErrorCode,
    terminate = false,
  ): Promise<void> {
    const processIdentity = this.processes.get(pid);
    if (processIdentity) {
      const updated: TrackedProcessIdentity = {
        ...processIdentity,
        status: terminate ? 'terminated' : 'revoked',
        revocationReason: reason,
        lastVerifiedAt: new Date().toISOString(),
      };
      this.processes.set(pid, updated);

      // Revoke endpoint bindings
      for (const [key, binding] of this.endpointBindings.entries()) {
        if (binding.owningPid === pid) {
          this.endpointBindings.set(key, {
            ...binding,
            status: reason === SERVICE_IDENTITY_ERROR_CODES.SERVICE_HIJACK_DETECTED ? 'hijacked' : 'closed',
            lastVerifiedAt: new Date().toISOString(),
          });
        }
      }

      if (terminate) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // May not have permissions or process already exited
        }
      }

      this.persistMapping();

      if (this.auditService) {
        try {
          this.auditService.recordAuditEvent({
            category: 'endpoint',
            source: 'service-identity',
            data: {
              event: 'SERVICE_IDENTITY_REVOKED',
              pid,
              serviceIdentity: processIdentity.serviceIdentity,
              reason,
              terminated: terminate,
            },
          });
        } catch {
          // Resilient
        }
      }
    }
  }

  /**
   * Updates model leases for a registered process. Fails closed if revision does not match.
   */
  public async updateModelLease(
    pid: number,
    modelId: string,
    modelRevision: string,
    leases: string[],
  ): Promise<void> {
    const processIdentity = this.processes.get(pid);
    if (!processIdentity) {
      throw new ServiceIdentityError(
        SERVICE_IDENTITY_ERROR_CODES.ENDPOINT_OWNER_UNRESOLVED,
        `Cannot update model lease: PID ${pid} is not registered.`,
      );
    }

    if (processIdentity.modelIdentity) {
      if (processIdentity.modelIdentity.modelRevision !== modelRevision) {
        await this.revokeProcess(pid, SERVICE_IDENTITY_ERROR_CODES.MODEL_REVISION_MISMATCH, false);
        throw new ServiceIdentityError(
          SERVICE_IDENTITY_ERROR_CODES.MODEL_REVISION_MISMATCH,
          `Model revision mismatch on PID ${pid}: registered revision "${processIdentity.modelIdentity.modelRevision}" does not match requested revision "${modelRevision}".`,
          { expected: processIdentity.modelIdentity.modelRevision, actual: modelRevision },
        );
      }
    }

    const updated: TrackedProcessIdentity = {
      ...processIdentity,
      activeModelLeases: Object.freeze([...leases]),
      lastVerifiedAt: new Date().toISOString(),
    };

    this.processes.set(pid, updated);
    this.persistMapping();

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'service-identity',
          data: {
            event: 'MODEL_LEASE_UPDATED',
            pid,
            modelId,
            modelRevision,
            leases,
          },
        });
      } catch {
        // Resilient
      }
    }
  }

  /**
   * Exports the complete canonical identity mapping sealed with a canonical SHA-256 hash.
   */
  public exportIdentityMapping(projectId: string = 'default'): ServiceEndpointIdentityMapping {
    let boundaryHash = '0'.repeat(64);
    if (this.sovereigntyBoundary) {
      const b = this.sovereigntyBoundary.getActiveBoundary(projectId);
      if (b) boundaryHash = b.boundaryHash || computeCanonicalBoundaryHash(b);
    }

    let endpointPolicyHash = '0'.repeat(64);
    if (this.endpointAllowlist) {
      const p = this.endpointAllowlist.getActivePolicy(projectId);
      if (p) endpointPolicyHash = p.policyHash || computeCanonicalPolicyHash(p);
    }

    const now = new Date().toISOString();
    const processes = Array.from(this.processes.values());
    const endpointBindings = Array.from(this.endpointBindings.values());

    const draft: Omit<ServiceEndpointIdentityMapping, 'mappingHash'> = {
      schemaVersion: 1,
      mappingId: `mapping_${projectId}_${Date.now()}`,
      projectId,
      projectRoot: this.projectRoot,
      boundaryHash,
      endpointPolicyHash,
      processes: Object.freeze(processes),
      endpointBindings: Object.freeze(endpointBindings),
      createdAt: now,
      lastVerifiedAt: now,
    };

    const mappingHash = computeCanonicalIdentityMappingHash(draft);
    const mapping: ServiceEndpointIdentityMapping = Object.freeze({
      ...draft,
      mappingHash,
    });

    return mapping;
  }

  /**
   * Verifies the cryptographic integrity of an identity mapping.
   */
  public verifyIdentityMappingIntegrity(
    mapping: ServiceEndpointIdentityMapping,
  ): { valid: boolean; errors: string[] } {
    return validateIdentityMapping(mapping);
  }

  private persistMapping(): void {
    try {
      this.ensureDirectory();
      const mapping = this.exportIdentityMapping();
      fs.writeFileSync(this.mappingFilePath, JSON.stringify(mapping, null, 2), 'utf-8');
    } catch {
      // In-memory state remains authoritative
    }
  }

  public getTrackedProcess(pid: number): TrackedProcessIdentity | undefined {
    return this.processes.get(pid);
  }

  public getTrackedBinding(protocol: string, direction: string, port?: number, pipeName?: string): TrackedEndpointBinding | undefined {
    const key = this.buildBindingKey(protocol, direction, port, pipeName);
    return this.endpointBindings.get(key);
  }

  public listTrackedProcesses(): TrackedProcessIdentity[] {
    return Array.from(this.processes.values());
  }

  public listTrackedBindings(): TrackedEndpointBinding[] {
    return Array.from(this.endpointBindings.values());
  }
}
