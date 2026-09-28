/**
 * F9-02: Endpoint Allowlist Application Service
 *
 * Enforces the authoritative socket-level endpoint policy for MAOS.
 * Provides validation for TCP/UDP connect/bind operations, Windows named pipes,
 * HTTP redirect verification, service rebinding defense, and DNS resolution blocking.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import type { AuditService } from './audit-service';
import type { SovereigntyBoundaryService } from './sovereignty-boundary-service';
import {
  EndpointAllowlistPolicy,
  EndpointDescriptor,
  SocketTargetRequest,
  EndpointValidationResult,
  PolicyValidationResult,
  EndpointPolicyError,
  ENDPOINT_POLICY_ERROR_CODES,
  createIndustrialEndpointPolicy,
  validateEndpointPolicy,
  validateSocketEndpoint,
  validateHttpRedirect,
  validateServiceRebinding as domainValidateRebinding,
  classifyIpAddress,
  CreateIndustrialPolicyOptions,
} from '../domain/endpoint-allowlist';

export interface EndpointAllowlistServiceOptions {
  readonly auditService?: AuditService;
  readonly sovereigntyBoundary?: SovereigntyBoundaryService;
}

export interface RegisteredServiceRecord {
  readonly serviceId: string;
  readonly host: string;
  readonly port: number;
  readonly processId?: number;
  readonly registeredAt: string;
}

export class EndpointAllowlistService {
  private readonly policiesDir: string;
  private readonly auditService?: AuditService;
  private readonly sovereigntyBoundary?: SovereigntyBoundaryService;
  private readonly serviceRegistry: Map<string, RegisteredServiceRecord> = new Map();

  constructor(
    private readonly projectRoot: string,
    options: EndpointAllowlistServiceOptions = {},
  ) {
    this.policiesDir = path.join(this.projectRoot, '.maos', 'policies');
    this.auditService = options.auditService;
    this.sovereigntyBoundary = options.sovereigntyBoundary;
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.policiesDir)) {
      fs.mkdirSync(this.policiesDir, { recursive: true });
    }
  }

  /**
   * Retrieves or initializes the active EndpointAllowlistPolicy for a project.
   */
  public getActivePolicy(projectId = 'default'): EndpointAllowlistPolicy {
    const policyPath = path.join(this.policiesDir, `${projectId}.endpoint-policy.json`);
    if (fs.existsSync(policyPath)) {
      try {
        const raw = fs.readFileSync(policyPath, 'utf8');
        const parsed = JSON.parse(raw);
        const val = this.verifyPolicy(parsed, { expectedProjectId: projectId });
        if (val.valid) {
          return parsed;
        }
      } catch {
        // Fall through to re-freeze if disk policy is tampered/corrupt
      }
    }

    return this.freezePolicy(projectId);
  }

  /**
   * Freezes and cryptographically seals a new EndpointAllowlistPolicy.
   */
  public freezePolicy(
    projectId = 'default',
    options: CreateIndustrialPolicyOptions = {},
  ): EndpointAllowlistPolicy {
    this.ensureDirectory();

    const policy = createIndustrialEndpointPolicy(projectId, options);
    const validation = validateEndpointPolicy(policy, { expectedProjectId: projectId });
    if (!validation.valid) {
      throw new EndpointPolicyError(
        ENDPOINT_POLICY_ERROR_CODES.INVALID_ENDPOINT_METADATA,
        `Constructed invalid endpoint policy: ${validation.errors.join('; ')}`,
        { errors: validation.errors },
      );
    }

    const targetFile = path.join(this.policiesDir, `${projectId}.endpoint-policy.json`);
    fs.writeFileSync(targetFile, JSON.stringify(policy, null, 2), 'utf8');

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'endpoint-allowlist',
          data: {
            event: 'ENDPOINT_POLICY_FROZEN',
            policyId: policy.policyId,
            policyHash: policy.policyHash,
            projectId: policy.projectId,
            profileMode: policy.profileMode,
            declaredEndpointsCount: policy.declaredEndpoints.length,
            allowedNamedPipesCount: policy.allowedNamedPipes.length,
          },
        });
      } catch {
        // Audit failure must not crash service
      }
    }

    return policy;
  }

  /**
   * Validates a socket connect or bind operation against the active policy.
   */
  public validateSocketTarget(
    request: SocketTargetRequest,
    projectId = 'default',
  ): EndpointValidationResult {
    const policy = this.getActivePolicy(projectId);
    const result = validateSocketEndpoint(request, policy);

    if (!result.allowed && this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'warning',
          source: 'endpoint-allowlist',
          data: {
            event: 'ENDPOINT_ACCESS_REJECTED',
            projectId,
            protocol: request.protocol,
            direction: request.direction,
            host: request.host || request.pipeName || 'unknown',
            port: request.port,
            serviceId: request.serviceId,
            errorCode: result.errorCode,
            classification: result.classification,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return result;
  }

  /**
   * Validates whether an HTTP redirect target stays within the approved loopback policy.
   */
  public validateRedirect(
    originalUrl: string,
    targetUrl: string,
    projectId = 'default',
  ): EndpointValidationResult {
    const policy = this.getActivePolicy(projectId);
    const result = validateHttpRedirect(originalUrl, targetUrl, policy);

    if (!result.allowed && this.auditService) {
      try {
        // Sanitize URLs to avoid leaking sensitive query params
        const origSanitized = new URL(originalUrl).origin;
        let targetSanitized = 'invalid-url';
        try {
          const t = new URL(targetUrl, originalUrl);
          targetSanitized = `${t.origin}${t.pathname}`;
        } catch {
          // ignore
        }

        this.auditService.recordAuditEvent({
          category: 'warning',
          source: 'endpoint-allowlist',
          data: {
            event: 'REDIRECTED_ENDPOINT_REJECTED',
            projectId,
            originalOrigin: origSanitized,
            targetOrigin: targetSanitized,
            errorCode: result.errorCode,
            reason: result.reason,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return result;
  }

  /**
   * Registers a service endpoint and ensures it does not execute a dynamic host/port rebind.
   */
  public registerServiceEndpoint(
    serviceId: string,
    host: string,
    port: number,
    processId?: number,
    projectId = 'default',
  ): EndpointValidationResult {
    const existing = this.serviceRegistry.get(serviceId);

    if (existing) {
      const rebindCheck = domainValidateRebinding(
        serviceId,
        host,
        port,
        existing.host,
        existing.port,
      );
      if (!rebindCheck.allowed) {
        if (this.auditService) {
          try {
            this.auditService.recordAuditEvent({
              category: 'warning',
              source: 'endpoint-allowlist',
              data: {
                event: 'SERVICE_REBINDING_DETECTED',
                serviceId,
                previousHost: existing.host,
                previousPort: existing.port,
                attemptedHost: host,
                attemptedPort: port,
                projectId,
              },
            });
          } catch {
            // Fail-safe
          }
        }
        return rebindCheck;
      }
    }

    // Verify bind target is allowlisted
    const socketValidation = this.validateSocketTarget(
      {
        protocol: 'tcp',
        direction: 'bind',
        host,
        port,
        serviceId,
        processId,
      },
      projectId,
    );

    if (!socketValidation.allowed) {
      return socketValidation;
    }

    this.serviceRegistry.set(serviceId, {
      serviceId,
      host,
      port,
      processId,
      registeredAt: new Date().toISOString(),
    });

    return { allowed: true, matchedEndpointId: socketValidation.matchedEndpointId };
  }

  /**
   * Validates service identity rebinding without mutating registry.
   */
  public validateServiceRebinding(
    serviceId: string,
    currentHost: string,
    currentPort: number,
    _processId?: number,
  ): EndpointValidationResult {
    const existing = this.serviceRegistry.get(serviceId);
    if (!existing) {
      // If service not previously registered, rebinding is not triggered
      return { allowed: true };
    }

    return domainValidateRebinding(serviceId, currentHost, currentPort, existing.host, existing.port);
  }

  /**
   * Validates DNS resolution requests. In sovereign mode, arbitrary hostname
   * resolution is rejected; only direct loopback addresses (127.0.0.1, ::1)
   * or hostnames resolving exclusively to loopback are permitted.
   */
  public validateDnsResolution(
    hostname: string,
    resolvedIps: string[] = [],
    projectId = 'default',
  ): EndpointValidationResult {
    const policy = this.getActivePolicy(projectId);
    const cleanHost = (hostname || '').trim().toLowerCase();

    const isIp = net.isIP(cleanHost) !== 0;
    const isLocalhost = cleanHost === 'localhost';

    // 1. If resolved IPs are provided, verify every single one is strictly loopback
    if (resolvedIps.length > 0) {
      for (const ip of resolvedIps) {
        const cls = classifyIpAddress(ip);
        if (cls !== 'loopback') {
          if (this.auditService) {
            try {
              this.auditService.recordAuditEvent({
                category: 'warning',
                source: 'endpoint-allowlist',
                data: {
                  event: 'NON_LOOPBACK_DNS_RESOLUTION',
                  hostname: cleanHost,
                  resolvedIp: ip,
                  classification: cls,
                  projectId,
                },
              });
            } catch {
              // Fail-safe
            }
          }
          return {
            allowed: false,
            errorCode: ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT,
            classification: cls,
            reason: `Hostname "${hostname}" resolved to non-loopback IP "${ip}" (${cls}).`,
          };
        }
      }
      return { allowed: true, classification: 'loopback' };
    }

    // 2. If no resolved IPs provided, enforce DNS resolution blocking policy
    if (policy.disallowDnsResolution && !isIp && !isLocalhost) {
      if (this.auditService) {
        try {
          this.auditService.recordAuditEvent({
            category: 'warning',
            source: 'endpoint-allowlist',
            data: {
              event: 'DNS_RESOLUTION_FORBIDDEN',
              hostname: cleanHost,
              projectId,
            },
          });
        } catch {
          // Fail-safe
        }
      }
      return {
        allowed: false,
        errorCode: ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN,
        reason: `DNS resolution for host "${hostname}" is forbidden in sovereign mode.`,
      };
    }

    return { allowed: true, classification: 'loopback' };
  }

  /**
   * Verifies an existing policy against schema rules, project context, and canonical hash.
   */
  public verifyPolicy(
    policy: EndpointAllowlistPolicy,
    context?: { expectedProjectId?: string },
  ): PolicyValidationResult {
    const result = validateEndpointPolicy(policy, context);

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: result.valid ? 'endpoint' : 'warning',
          source: 'endpoint-allowlist',
          data: {
            event: 'ENDPOINT_POLICY_VERIFIED',
            policyId: policy?.policyId ?? 'unknown',
            policyHash: policy?.policyHash ?? 'unknown',
            valid: result.valid,
            errorCount: result.errors.length,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return result;
  }

  /**
   * Lists declared endpoints for a project.
   */
  public listDeclaredEndpoints(projectId = 'default'): readonly EndpointDescriptor[] {
    return this.getActivePolicy(projectId).declaredEndpoints;
  }

  /**
   * Returns current service registry.
   */
  public getRegisteredServices(): Record<string, RegisteredServiceRecord> {
    return Object.fromEntries(this.serviceRegistry.entries());
  }
}
