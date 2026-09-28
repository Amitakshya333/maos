/**
 * MAOS Model Service
 *
 * Wraps model selection, backend factory, credential validation, and model leases.
 * Extracted from: backends/factory.ts, core/credentials.ts.
 */

import * as fs from 'fs';
import { getConfigPath } from '../utils/paths';
import type { Model, ModelLease, CredentialStatus } from '../domain/schemas';
import { SharedModelManager } from './model-manager';
import { VLM_ERROR_CODES, VlmError } from '../domain/vision';
import type { ModelRegistration, ModelResidencyStatus, QueuePriorityClass } from '../domain/model-manifest';
import type { AuditService } from './audit-service';

export class ModelService {
  private readonly manager: SharedModelManager;

  constructor(
    private readonly projectRoot: string,
    manager?: SharedModelManager,
    private readonly auditService?: AuditService,
  ) {
    this.manager = manager ?? SharedModelManager.getInstance(projectRoot);
  }

  /**
   * Get the underlying SharedModelManager instance.
   */
  getModelManager(): SharedModelManager {
    return this.manager;
  }

  /**
   * List registered models pinned to verified snapshots.
   */
  listRegisteredModels(): ModelRegistration[] {
    return this.manager.listRegisteredModels();
  }

  /**
   * List models configured in the project plus registered pinned models.
   */
  listModels(): Model[] {
    const configPath = getConfigPath(this.projectRoot);
    const seen = new Set<string>();
    const models: Model[] = [];

    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const agents = config.agents ?? [];

        for (const agent of agents) {
          const key = `${agent.provider ?? 'local'}/${agent.model ?? 'unknown'}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const reg = this.manager.getModelRegistration(agent.model ?? '');
          models.push({
            schemaVersion: 1,
            id: key,
            name: agent.model ?? 'unknown',
            revision: reg?.revision ?? '',
            provider: agent.provider ?? 'local',
            device: reg?.device ?? 'cpu',
            snapshotPath: reg?.snapshotPath ?? '',
            hash: reg?.revision ?? '',
          });
        }
      } catch {
        // Fall back to registrations if config parse fails
      }
    }

    // Ensure all pinned registered models are also represented
    for (const reg of this.manager.listRegisteredModels()) {
      const key = `local/${reg.modelId}`;
      if (!seen.has(key) && !seen.has(reg.modelId)) {
        seen.add(key);
        models.push({
          schemaVersion: 1,
          id: key,
          name: reg.modelId,
          revision: reg.revision,
          provider: 'local',
          device: reg.device,
          snapshotPath: reg.snapshotPath ?? '',
          hash: reg.revision,
        });
      }
    }

    return models;
  }

  /**
   * Validate credentials for a provider.
   */
  validateCredentials(provider: string): CredentialStatus {
    const configPath = getConfigPath(this.projectRoot);
    if (!fs.existsSync(configPath)) {
      return { provider, valid: false, error: 'Config not found' };
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const providerConfig = config.providers?.[provider];
    if (!providerConfig) {
      return { provider, valid: false, error: `Provider "${provider}" not configured` };
    }

    // For local providers with no API key, treat as valid
    if (providerConfig.baseURL?.includes('127.0.0.1') || providerConfig.baseURL?.includes('localhost')) {
      return { provider, valid: true };
    }

    if (!providerConfig.apiKey) {
      return { provider, valid: false, error: 'API key not configured' };
    }

    return { provider, valid: true };
  }

  /**
   * List active model leases, optionally filtered by project ID.
   */
  listLeases(projectId?: string): ModelLease[] {
    return this.manager.listLeases(projectId);
  }

  /**
   * Alias for listLeases to query active model leases.
   */
  listActiveLeases(projectId?: string): ModelLease[] {
    return this.listLeases(projectId);
  }

  /**
   * Look up a single active lease by ID.
   */
  getLease(leaseId: string, options?: { projectId?: string; runId?: string }): ModelLease | undefined {
    return this.manager.getLease(leaseId, options);
  }

  /**
   * Acquire a lease for a model and agent through the Shared GPU Model Manager (sync).
   */
  acquireLease(opts: {
    modelId: string;
    agentId: string;
    port?: number;
    projectId?: string;
    runId?: string;
    priority?: QueuePriorityClass | number;
    timeoutMs?: number;
    expectedRevision?: string;
    allowCpuFallback?: boolean;
  }): ModelLease {
    const configuredName = opts.modelId.includes('/') ? opts.modelId.slice(opts.modelId.indexOf('/') + 1) : opts.modelId;
    const reg = this.manager.getModelRegistration(opts.modelId) ?? this.manager.getModelRegistration(configuredName);
    if (!reg) {
      throw new VlmError(
        `Model '${opts.modelId}' is not pinned to a verified offline snapshot`,
        VLM_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    const lease = this.manager.acquireLeaseSync({
      modelId: reg.modelId,
      agentId: opts.agentId,
      port: opts.port ?? reg.port,
      projectId: opts.projectId,
      runId: opts.runId,
      priority: opts.priority,
      timeoutMs: opts.timeoutMs,
      expectedRevision: opts.expectedRevision ?? reg.revision,
      allowCpuFallback: opts.allowCpuFallback,
    });

    this.auditLog('lease', 'ACQUIRE', {
      leaseId: lease.id,
      modelId: lease.modelId,
      agentId: lease.agentId,
      projectId: lease.projectId,
      runId: lease.runId,
      port: lease.port,
    });

    return lease;
  }

  /**
   * Acquire a lease for a model and agent asynchronously (joins serialized queue if necessary).
   */
  async acquireLeaseAsync(opts: {
    modelId: string;
    agentId: string;
    port?: number;
    projectId?: string;
    runId?: string;
    priority?: QueuePriorityClass | number;
    timeoutMs?: number;
    expectedRevision?: string;
    allowCpuFallback?: boolean;
  }): Promise<ModelLease> {
    const configuredName = opts.modelId.includes('/') ? opts.modelId.slice(opts.modelId.indexOf('/') + 1) : opts.modelId;
    const reg = this.manager.getModelRegistration(opts.modelId) ?? this.manager.getModelRegistration(configuredName);
    if (!reg) {
      throw new VlmError(
        `Model '${opts.modelId}' is not pinned to a verified offline snapshot`,
        VLM_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    const lease = await this.manager.acquireLease({
      modelId: reg.modelId,
      agentId: opts.agentId,
      port: opts.port ?? reg.port,
      projectId: opts.projectId,
      runId: opts.runId,
      priority: opts.priority,
      timeoutMs: opts.timeoutMs,
      expectedRevision: opts.expectedRevision ?? reg.revision,
      allowCpuFallback: opts.allowCpuFallback,
    });

    this.auditLog('lease', 'ACQUIRE', {
      leaseId: lease.id,
      modelId: lease.modelId,
      agentId: lease.agentId,
      projectId: lease.projectId,
      runId: lease.runId,
      port: lease.port,
    });

    return lease;
  }

  /**
   * Renew an active lease duration with project/run boundary enforcement.
   */
  renewLease(
    leaseId: string,
    extensionMs: number,
    options?: { projectId?: string; runId?: string },
  ): ModelLease {
    const renewed = this.manager.renewLease(leaseId, extensionMs, options);
    this.auditLog('lease', 'RENEW', {
      leaseId,
      extensionMs,
      projectId: options?.projectId,
      runId: options?.runId,
      newExpiresAt: renewed.expiresAt,
    });
    return renewed;
  }

  /**
   * Release an active model lease by ID with project/run boundary enforcement.
   */
  releaseLease(leaseId: string, options?: { projectId?: string; runId?: string }): boolean {
    const released = this.manager.releaseLease(leaseId, options);
    if (released) {
      this.auditLog('lease', 'RELEASE', {
        leaseId,
        projectId: options?.projectId,
        runId: options?.runId,
      });
    }
    return released;
  }

  /**
   * Release all active model leases and trigger unload.
   */
  releaseAllLeases(): number {
    const count = this.manager.releaseAllLeases();
    if (count > 0) {
      this.auditLog('lease', 'RELEASE_ALL', { releasedCount: count });
    }
    return count;
  }

  /**
   * Reaps expired/stale leases.
   */
  reapStaleLeases(): number {
    const reaped = this.manager.reapStaleLeases();
    if (reaped > 0) {
      this.auditLog('lease', 'REAP_STALE', { reapedCount: reaped });
    }
    return reaped;
  }

  /**
   * Get current model residency and VRAM status.
   */
  getModelResidencyStatus(): ModelResidencyStatus & {
    residentModels: string[];
    estimatedVramMb: number;
  } {
    const status = this.manager.getResidencyStatus();
    return {
      ...status,
      residentModels: status.residentModelId ? [status.residentModelId] : [],
      estimatedVramMb: status.vramUsedMb,
    };
  }

  private auditLog(category: 'model' | 'lease', action: string, data: Record<string, unknown>): void {
    if (!this.auditService) return;
    try {
      this.auditService.recordAuditEvent({
        category,
        source: 'model-service',
        data: { action, ...data },
      });
    } catch {
      // Best-effort audit logging; do not throw if audit chain is uninitialized in isolated test harness
    }
  }
}
