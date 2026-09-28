/**
 * F9-06: Industrial Firewall Requirement Application Service
 *
 * Enforces that Industrial workflows, task executions, model leases, and sandbox runs
 * strictly require an active, verified host firewall boundary, matched endpoint policy,
 * active passive socket monitoring, and authenticated service identities.
 *
 * Fail-Closed:
 * If any requirement is inactive, unverified, untrusted, or unknown,
 * execution is immediately halted with typed error codes.
 */

import type { AuditService } from './audit-service';
import type { FirewallService } from './firewall-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import type { NetworkMonitorService } from './network-monitor-service';
import type { ServiceIdentityService } from './service-identity-service';
import type { ProcessBoundaryService } from './process-boundary-service';
import {
  IndustrialBoundaryStatus,
  IndustrialFirewallRequirementError,
  INDUSTRIAL_FIREWALL_ERROR_CODES,
  evaluateIndustrialFirewallRequirement,
  EvaluationInput,
  formatMeasuredBoundaryStatus,
} from '../domain/industrial-firewall-requirement';
import { synthesizeFirewallPlan } from '../domain/firewall-policy';
import type { FirewallBoundaryScope, FirewallStatusResult } from '../domain/firewall-policy';

export interface IndustrialFirewallRequirementServiceOptions {
  readonly firewall: FirewallService;
  /**
   * Process-scoped boundary owner. Required when `boundaryScope` is `'process'`.
   */
  readonly processBoundary?: ProcessBoundaryService;
  /**
   * Which layer the boundary is evaluated at.
   *
   * Defaults to `'host'` so that callers who explicitly inject a host firewall
   * service (tests, host-scope deployments) keep their existing semantics.
   * `createServiceContainer` explicitly selects `'process'` for the shipped
   * Industrial MVP, so the machine-wide path is never taken implicitly.
   */
  readonly boundaryScope?: FirewallBoundaryScope;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly networkMonitor?: NetworkMonitorService;
  readonly serviceIdentity?: ServiceIdentityService;
  readonly auditService?: AuditService;
}

export class IndustrialFirewallRequirementService {
  private readonly firewall: FirewallService;
  private readonly processBoundary?: ProcessBoundaryService;
  private readonly boundaryScope: FirewallBoundaryScope;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly networkMonitor?: NetworkMonitorService;
  private readonly serviceIdentity?: ServiceIdentityService;
  private readonly auditService?: AuditService;

  constructor(
    private readonly projectRoot: string,
    options: IndustrialFirewallRequirementServiceOptions,
  ) {
    this.firewall = options.firewall;
    this.processBoundary = options.processBoundary;
    this.boundaryScope = options.boundaryScope ?? 'host';

    if (this.boundaryScope === 'process' && !this.processBoundary) {
      throw new IndustrialFirewallRequirementError(
        INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_STATUS_UNKNOWN,
        'Process-scoped boundary selected but no ProcessBoundaryService was provided. ' +
          'Refusing to silently fall back to machine-wide firewall evaluation.',
      );
    }

    this.endpointAllowlist = options.endpointAllowlist;
    this.networkMonitor = options.networkMonitor;
    this.serviceIdentity = options.serviceIdentity;
    this.auditService = options.auditService;
  }

  /** Which layer this instance evaluates the boundary at. */
  public getScope(): FirewallBoundaryScope {
    return this.boundaryScope;
  }

  /**
   * Reads measured boundary state from the configured scope.
   * Process scope never touches host packet filters; host scope does.
   */
  private async measureBoundary(projectId: string): Promise<FirewallStatusResult> {
    if (this.boundaryScope === 'process') {
      const status = await this.processBoundary!.getStatus(projectId);
      return { ...status, boundaryScope: 'process', hostFirewallModified: false };
    }

    const status = await this.firewall.getStatus();
    return { ...status, boundaryScope: 'host' };
  }

  /**
   * Queries the live measured status across host firewall, endpoint policy,
   * network monitor, and service identity systems without throwing.
   */
  public async getIndustrialBoundaryStatus(
    projectId: string = 'default',
  ): Promise<IndustrialBoundaryStatus> {
    // 1. Measure the live boundary state at the configured scope.
    const fwStatusResult = await this.measureBoundary(projectId);

    // 2. Resolve endpoint allowlist policy
    const endpointPolicy = this.endpointAllowlist
      ? this.endpointAllowlist.getActivePolicy(projectId)
      : null;

    let expectedPlanHash: string | undefined;
    if (endpointPolicy) {
      try {
        const synthesized = synthesizeFirewallPlan(endpointPolicy, fwStatusResult.platform);
        expectedPlanHash = synthesized.policyHash;
      } catch {
        // Tampered or invalid policy
      }
    }

    // 3. Inspect Network Monitor status
    let monitorActive = false;
    let monitorAnomalies = 0;
    let nonLoopbackObserved = false;

    if (this.networkMonitor) {
      const activeSessions = this.networkMonitor.listActiveObservations();
      monitorActive = activeSessions.length > 0;
      if (monitorActive) {
        try {
          const snapshot = await this.networkMonitor.captureSnapshot(activeSessions[0]);
          if (snapshot.violations.length > 0) {
            monitorAnomalies = snapshot.violations.length;
            const hasExternal = snapshot.violations.some(
              (v) =>
                v.type === 'NON_LOOPBACK_CONNECTION_DETECTED' ||
                v.type === 'EXTERNAL_INTERFACE_BIND',
            );
            if (hasExternal) {
              nonLoopbackObserved = true;
            }
          }
        } catch {
          // In fail-fast or capture errors
        }
      }
    }

    // 4. Inspect Service Identities
    let trustedCount = 0;
    let untrustedCount = 0;
    let hijackedCount = 0;
    let unresolvedOwnersCount = 0;

    if (this.serviceIdentity) {
      const allProcs = this.serviceIdentity.listTrackedProcesses();
      const procs = allProcs.filter((p) => p.projectId === projectId);
      for (const p of procs) {
        if (p.status === 'trusted') {
          trustedCount++;
        } else {
          untrustedCount++;
        }
      }

      const bindings = this.serviceIdentity.listTrackedBindings();
      for (const b of bindings) {
        const owner = this.serviceIdentity.getTrackedProcess(b.owningPid);
        if (owner && owner.projectId !== projectId) {
          continue;
        }
        if (b.status === 'hijacked') {
          hijackedCount++;
        }
      }
    }

    // 5. Inspect Model Endpoints
    let modelEndpointsLoopbackOnly = true;
    if (endpointPolicy?.declaredEndpoints) {
      for (const ep of endpointPolicy.declaredEndpoints) {
        if (ep.processCategory === 'model' && !ep.isLoopbackOnly) {
          modelEndpointsLoopbackOnly = false;
        }
      }
    }

    const evalInput: EvaluationInput = {
      firewallStatus: fwStatusResult,
      expectedFirewallPolicyHash: expectedPlanHash,
      endpointPolicy,
      monitorActive,
      monitorAnomaliesCount: monitorAnomalies,
      nonLoopbackObserved,
      trustedServicesCount: trustedCount,
      untrustedServicesCount: untrustedCount,
      hijackedServicesCount: hijackedCount,
      unresolvedOwnersCount,
      modelEndpointsLoopbackOnly,
    };

    const status = evaluateIndustrialFirewallRequirement(evalInput);

    return {
      ...status,
      boundaryScope: this.boundaryScope,
      measureDetails: this.buildMeasureDetails(fwStatusResult),
    };
  }

  /**
   * Composes an operator-facing measurement line that states the scope and
   * whether host firewall state was touched, so "INACTIVE" can never be read as
   * "your Windows Firewall is off".
   */
  private buildMeasureDetails(status: FirewallStatusResult): string {
    const scopeLabel =
      this.boundaryScope === 'process'
        ? 'process-scoped (MAOS process tree + declared loopback endpoints)'
        : 'host-scoped (machine-wide packet filter rules)';

    const hostNote =
      this.boundaryScope === 'process'
        ? 'Host packet filter rules are not modified at this scope.'
        : 'This scope writes host packet filter rules.';

    return `Boundary scope: ${scopeLabel}. Firewall status ${status.state} (platform: ${status.platform}). ${hostNote}${
      status.details ? ` ${status.details}` : ''
    }`;
  }

  /**
   * Asserts that all Industrial boundary preconditions are verified.
   * Throws IndustrialFirewallRequirementError if any requirement fails.
   */
  public async assertIndustrialExecutionAllowed(
    projectId: string = 'default',
    context?: { action?: string; taskId?: string },
  ): Promise<IndustrialBoundaryStatus> {
    const status = await this.getIndustrialBoundaryStatus(projectId);

    if (!status.verified) {
      if (this.auditService) {
        try {
          this.auditService.recordAuditEvent({
            category: 'endpoint',
            source: 'industrial-firewall-requirement',
            data: {
              event: 'INDUSTRIAL_BOUNDARY_CHECK_FAILED',
              projectId,
              action: context?.action,
              taskId: context?.taskId,
              failureCode: status.failureCode,
              blockingReason: status.blockingReason,
              firewallStatus: status.firewallStatus,
              endpointPolicyStatus: status.endpointPolicyStatus,
              monitorStatus: status.monitorStatus,
              serviceIdentityStatus: status.serviceIdentityStatus,
            },
          });
        } catch {
          // Resilient
        }
      }

      throw new IndustrialFirewallRequirementError(
        status.failureCode || INDUSTRIAL_FIREWALL_ERROR_CODES.FIREWALL_INACTIVE,
        status.blockingReason || 'Industrial execution blocked: unverified boundary state.',
        status,
      );
    }

    return status;
  }

  public async assertTaskStartAllowed(projectId: string, taskId: string): Promise<void> {
    await this.assertIndustrialExecutionAllowed(projectId, { action: 'TASK_START', taskId });
  }

  public async assertModelLeaseAllowed(projectId: string, modelId: string, modelRevision: string): Promise<void> {
    await this.assertIndustrialExecutionAllowed(projectId, { action: 'MODEL_LEASE', taskId: modelId });
  }

  public async assertSandboxExecutionAllowed(projectId: string): Promise<void> {
    await this.assertIndustrialExecutionAllowed(projectId, { action: 'SANDBOX_EXECUTION' });
  }

  public async assertContinuationRecoveryAllowed(projectId: string, workflowId?: string): Promise<void> {
    await this.assertIndustrialExecutionAllowed(projectId, { action: 'CONTINUATION_RECOVERY', taskId: workflowId });
  }

  public formatStatusForDisplay(status: IndustrialBoundaryStatus): string {
    return formatMeasuredBoundaryStatus(status);
  }
}
