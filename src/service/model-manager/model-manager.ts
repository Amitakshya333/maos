/**
 * MAOS Shared GPU Model Manager
 *
 * Section 4.2 & Phase F4-04: Shared Model Manager & Residency Strategy
 *
 * Core Invariants:
 * 1. Weight Ownership: Only the Shared Model Manager loads/unloads model weights.
 *    Project services do NOT load weights.
 * 2. Serialized Residency: Exactly one model loaded in VRAM at a time.
 *    Concurrent residency is prohibited without hardware manifest certification.
 * 3. 5-Class Priority Queue: Interactive chat > User task > Active workflow >
 *    Auto workflow > Background indexing, with 60s aging anti-starvation.
 * 4. Audited Leases: Project services obtain audited leases against a single pool.
 * 5. Fail-Closed Guardrails: Rejects OOM, unhealthy probes, revision mismatches,
 *    unpinned runtime downloads, and concurrent residency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ModelLease } from '../../domain/schemas';
import {
  PINNED_VLM_CONFIG,
  VLM_MANIFEST_BUDGETS,
  VLM_ERROR_CODES,
  VlmError,
  VlmSnapshotManifest,
} from '../../domain/vision';
import { PINNED_EMBEDDING_CONFIG } from '../../domain/embedding';
import {
  ModelRegistration,
  ModelResidencyStatus,
  ModelDevice,
  QueuePriorityClass,
  PRIORITY_WEIGHTS,
} from '../../domain/model-manifest';
import { GlobalResidencyCoordinator } from './global-residency';

export type { ModelRegistration, ModelResidencyStatus, ModelDevice, QueuePriorityClass };
export { PRIORITY_WEIGHTS };

export interface AcquireLeaseOptions {
  modelId: string;
  agentId: string;
  projectId?: string;
  runId?: string;
  priority?: QueuePriorityClass | number;
  timeoutMs?: number;
  expectedRevision?: string;
  allowCpuFallback?: boolean;
  port?: number;
}

export interface QueuedRequest {
  id: string;
  options: AcquireLeaseOptions;
  enqueuedAt: number;
  effectivePriority: number;
  resolve: (lease: ModelLease) => void;
  reject: (err: Error) => void;
}

export class SharedModelManager {
  private static instance: SharedModelManager | null = null;

  private readonly registeredModels = new Map<string, ModelRegistration>();
  private readonly activeLeases = new Map<string, ModelLease>();
  private readonly queue: QueuedRequest[] = [];
  private residentModelId: string | null = null;
  private residentRevision: string | null = null;
  private residentDevice: 'cuda' | 'cpu' | 'none' = 'none';
  private residentVramMb = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleUnloadMs: number;
  private readonly globalResidency: GlobalResidencyCoordinator;
  private consecutiveChatTurns = 0;
  private maxConsecutiveChatTurns = 3;

  constructor(
    private readonly projectRoot: string,
    options?: { idleUnloadMs?: number; maxConsecutiveChatTurns?: number },
  ) {
    this.idleUnloadMs = options?.idleUnloadMs ?? 180000; // Default 3 minutes
    this.maxConsecutiveChatTurns = options?.maxConsecutiveChatTurns ?? 3;
    this.globalResidency = new GlobalResidencyCoordinator();
    this.initializeDefaultRegistrations();
  }

  public static getInstance(projectRoot: string = process.cwd()): SharedModelManager {
    if (!SharedModelManager.instance) {
      SharedModelManager.instance = new SharedModelManager(projectRoot);
    }
    return SharedModelManager.instance;
  }

  public static resetInstance(): void {
    if (SharedModelManager.instance) {
      SharedModelManager.instance.releaseAllLeases();
      SharedModelManager.instance = null;
    }
  }

  private initializeDefaultRegistrations(): void {
    // 1. Text model: Qwen2.5-3B-Instruct
    this.registerModel({
      modelId: 'Qwen/Qwen2.5-3B-Instruct',
      modelName: 'qwen2.5-3b-instruct-local',
      revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1',
      architecture: 'Qwen2ForCausalLM',
      quantization: 'fp16',
      vramRequiredMb: 4096,
      device: 'cuda',
      port: 8000,
      manifestPath: path.join(this.projectRoot, 'model-snapshot-manifest.json'),
      snapshotPath: path.join(
        this.projectRoot,
        'offline-stores',
        'model-snapshot',
        'models--Qwen--Qwen2.5-3B-Instruct',
        'snapshots',
        'aa8e72537993ba99e69dfaafa59ed015b17504d1',
      ),
      isHealthy: true,
    });

    // 2. VLM: Qwen2-VL-2B-Instruct
    this.registerModel({
      modelId: PINNED_VLM_CONFIG.modelId,
      modelName: PINNED_VLM_CONFIG.modelName,
      revision: PINNED_VLM_CONFIG.revision,
      architecture: PINNED_VLM_CONFIG.architecture,
      quantization: PINNED_VLM_CONFIG.defaultQuantization,
      vramRequiredMb: 3072, // ~2.2 GB int4 + KV cache = ~3 GB total
      device: 'cuda',
      port: 8001,
      manifestPath: path.join(this.projectRoot, 'vlm-snapshot-manifest.json'),
      snapshotPath: path.join(this.projectRoot, 'offline-stores', 'model-snapshot', PINNED_VLM_CONFIG.snapshotRelativePath),
      isHealthy: true,
    });

    // 3. Embedding: all-MiniLM-L6-v2 (CPU only, 384d)
    this.registerModel({
      modelId: PINNED_EMBEDDING_CONFIG.modelId,
      modelName: PINNED_EMBEDDING_CONFIG.modelName,
      revision: PINNED_EMBEDDING_CONFIG.revision,
      architecture: PINNED_EMBEDDING_CONFIG.architecture,
      quantization: PINNED_EMBEDDING_CONFIG.quantization,
      vramRequiredMb: 0,
      device: 'cpu',
      port: 8002,
      manifestPath: path.join(this.projectRoot, 'embedding-snapshot-manifest.json'),
      snapshotPath: path.join(
        this.projectRoot,
        'offline-stores',
        'model-snapshot',
        PINNED_EMBEDDING_CONFIG.snapshotRelativePath,
      ),
      isHealthy: true,
    });
  }

  public registerModel(reg: ModelRegistration): void {
    this.registeredModels.set(reg.modelId, { ...reg });
    this.registeredModels.set(reg.modelName, { ...reg });
    if (reg.modelId.includes('/')) {
      const shortName = reg.modelId.slice(reg.modelId.lastIndexOf('/') + 1);
      this.registeredModels.set(shortName, { ...reg });
    }
  }

  public listRegisteredModels(): ModelRegistration[] {
    const models: ModelRegistration[] = [];
    const seen = new Set<string>();
    for (const reg of this.registeredModels.values()) {
      if (!seen.has(reg.modelId)) {
        seen.add(reg.modelId);
        models.push({ ...reg });
      }
    }
    return models;
  }

  public getModelRegistration(modelId: string): ModelRegistration | undefined {
    return this.resolveModelRegistration(modelId);
  }

  public getActiveGpuLeases(): ModelLease[] {
    const gpuLeases: ModelLease[] = [];
    for (const lease of this.activeLeases.values()) {
      const reg = this.resolveModelRegistration(lease.modelId);
      if (reg && reg.device !== 'cpu' && lease.device !== 'cpu') {
        gpuLeases.push({ ...lease });
      }
    }
    return gpuLeases;
  }

  public getActiveGpuLeasesCount(): number {
    let count = 0;
    for (const lease of this.activeLeases.values()) {
      const reg = this.resolveModelRegistration(lease.modelId);
      if (reg && reg.device !== 'cpu' && lease.device !== 'cpu') {
        count++;
      }
    }
    return count;
  }

  /**
   * Return the verified local snapshot path for a registered model.
   * Callers may pass this path to an offline runtime, but the manager remains
   * the only component allowed to validate and grant residency leases.
   */
  public getVerifiedSnapshotPath(modelId: string): string | undefined {
    return this.registeredModels.get(modelId)?.snapshotPath;
  }

  public setModelHealth(modelId: string, healthy: boolean, reason?: string): void {
    const reg = this.registeredModels.get(modelId);
    if (reg) {
      const updated: ModelRegistration = {
        ...reg,
        isHealthy: healthy,
        unhealthyReason: reason,
      };
      this.registeredModels.set(modelId, updated);
      if (reg.modelName && this.registeredModels.has(reg.modelName)) {
        this.registeredModels.set(reg.modelName, updated);
      }
    }
  }

  /**
   * Acquire an audited lease.
   * Enforces serialized residency, priority queuing, health checks, revision matching,
   * VRAM budget bounds, and zero-download offline verification.
   */
  public async acquireLease(opts: AcquireLeaseOptions): Promise<ModelLease> {
    this.pruneExpiredLeases();

    const reg = this.resolveModelRegistration(opts.modelId);
    if (!reg) {
      throw new VlmError(
        `Requested model '${opts.modelId}' is not registered with SharedModelManager`,
        VLM_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    // 1. Revision check
    if (opts.expectedRevision && opts.expectedRevision !== reg.revision) {
      throw new VlmError(
        `Model revision mismatch: requested '${opts.expectedRevision}', pinned is '${reg.revision}'`,
        VLM_ERROR_CODES.REVISION_MISMATCH,
      );
    }

    // 2. Health check
    if (!reg.isHealthy) {
      throw new VlmError(
        `Model '${opts.modelId}' is marked UNHEALTHY: ${reg.unhealthyReason || 'Health probe failed'}`,
        VLM_ERROR_CODES.MODEL_UNHEALTHY,
      );
    }

    // 3. VRAM budget check
    const maxBudgetMb = VLM_MANIFEST_BUDGETS.maxVramMb;
    if (reg.vramRequiredMb > maxBudgetMb && !opts.allowCpuFallback) {
      throw new VlmError(
        `Model '${opts.modelId}' requires ${reg.vramRequiredMb} MB VRAM, exceeding manifest budget of ${maxBudgetMb} MB`,
        VLM_ERROR_CODES.OOM_BUDGET_EXCEEDED,
      );
    }

    // 4. Offline snapshot verification (zero runtime download)
    this.assertSnapshotAvailable(reg);

    // 5. Check workflow-fixed model protection
    if (reg.device !== 'cpu' && this.residentModelId && this.residentModelId !== reg.modelId) {
      const activeGpu = this.getActiveGpuLeases();
      const fixedRun = activeGpu.find((l) => l.runId);
      if (fixedRun) {
        throw new VlmError(
          `WORKFLOW_FIXED_MODEL_PROTECTED: Cannot switch model. Resident model '${this.residentModelId}' is locked by active workflow run '${fixedRun.runId}'`,
          VLM_ERROR_CODES.CONCURRENCY_VIOLATION,
        );
      }
    }

    // 6. A project host is a separate process, so check the OS-level global
    // residency guard before considering the process-local queue (for GPU models only).
    if (reg.device !== 'cpu') {
      this.globalResidency.assertCanAcquire(reg.modelId);
    }

    // 7. Check if model can be immediately granted
    if (this.canGrantImmediately(reg)) {
      return this.grantLease(reg, opts);
    }

    // 8. Otherwise, enqueue request
    return this.enqueueRequest(reg, opts);
  }

  /**
   * Synchronous lease acquisition for synchronous tool execution workflows.
   */
  public acquireLeaseSync(opts: AcquireLeaseOptions): ModelLease {
    this.pruneExpiredLeases();

    const reg = this.resolveModelRegistration(opts.modelId);
    if (!reg) {
      throw new VlmError(
        `Requested model '${opts.modelId}' is not registered with SharedModelManager`,
        VLM_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    if (opts.expectedRevision && opts.expectedRevision !== reg.revision) {
      throw new VlmError(
        `Model revision mismatch: requested '${opts.expectedRevision}', pinned is '${reg.revision}'`,
        VLM_ERROR_CODES.REVISION_MISMATCH,
      );
    }

    if (!reg.isHealthy) {
      throw new VlmError(
        `Model '${opts.modelId}' is marked UNHEALTHY: ${reg.unhealthyReason || 'Health probe failed'}`,
        VLM_ERROR_CODES.MODEL_UNHEALTHY,
      );
    }

    const maxBudgetMb = VLM_MANIFEST_BUDGETS.maxVramMb;
    if (reg.vramRequiredMb > maxBudgetMb && !opts.allowCpuFallback) {
      throw new VlmError(
        `Model '${opts.modelId}' requires ${reg.vramRequiredMb} MB VRAM, exceeding manifest budget of ${maxBudgetMb} MB`,
        VLM_ERROR_CODES.OOM_BUDGET_EXCEEDED,
      );
    }

    this.assertSnapshotAvailable(reg);

    if (reg.device !== 'cpu') {
      this.globalResidency.assertCanAcquire(reg.modelId);

      // If another model is resident and has active GPU leases, cannot concurrently load
      if (this.residentModelId && this.residentModelId !== reg.modelId && this.getActiveGpuLeasesCount() > 0) {
        const activeGpu = this.getActiveGpuLeases();
        const fixedRun = activeGpu.find((l) => l.runId);
        if (fixedRun) {
          throw new VlmError(
            `WORKFLOW_FIXED_MODEL_PROTECTED: Cannot switch model. Resident model '${this.residentModelId}' is locked by active workflow run '${fixedRun.runId}'`,
            VLM_ERROR_CODES.CONCURRENCY_VIOLATION,
          );
        }
        throw new VlmError(
          `Concurrent GPU model residency violation: model '${this.residentModelId}' is active in VRAM with ${this.getActiveGpuLeasesCount()} leases. Serialized queue must be awaited.`,
          VLM_ERROR_CODES.CONCURRENCY_VIOLATION,
        );
      }
    }

    return this.grantLease(reg, opts);
  }

  /**
   * Look up a single lease with project boundary validation.
   */
  public getLease(leaseId: string, options?: { projectId?: string; runId?: string }): ModelLease | undefined {
    this.pruneExpiredLeases();
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return undefined;

    if (lease.projectId && options?.projectId && lease.projectId !== options.projectId) {
      throw new Error(
        `CROSS_PROJECT_LEASE_ACCESS: Lease '${leaseId}' belongs to project '${lease.projectId}', cannot be accessed by project '${options.projectId}'`,
      );
    }

    if (lease.runId && options?.runId && lease.runId !== options.runId) {
      throw new Error(
        `WRONG_RUN_LEASE_RELEASE: Lease '${leaseId}' belongs to run '${lease.runId}', cannot be accessed by run '${options.runId}'`,
      );
    }

    return { ...lease };
  }

  /**
   * Release an active lease with project and run scope validation.
   */
  public releaseLease(leaseId: string, options?: { projectId?: string; runId?: string }): boolean {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;

    // Project boundary validation
    if (lease.projectId && options?.projectId && lease.projectId !== options.projectId) {
      throw new Error(
        `CROSS_PROJECT_LEASE_ACCESS: Lease '${leaseId}' belongs to project '${lease.projectId}', cannot be released by project '${options.projectId}'`,
      );
    }

    // Run boundary validation
    if (lease.runId && options?.runId && lease.runId !== options.runId) {
      throw new Error(
        `WRONG_RUN_LEASE_RELEASE: Lease '${leaseId}' belongs to run '${lease.runId}', cannot be released by run '${options.runId}'`,
      );
    }

    // Keep the local lease until the global registry acknowledges release (GPU models only).
    const reg = this.resolveModelRegistration(lease.modelId);
    if (!reg || reg.device !== 'cpu') {
      try { this.globalResidency.releaseLease(leaseId); } catch {}
    }
    this.activeLeases.delete(leaseId);

    // If no active GPU leases remain, start idle timer and process queue
    if (this.getActiveGpuLeasesCount() === 0) {
      this.startIdleTimer();
    }

    this.processQueue();
    return true;
  }

  /**
   * Renew an active lease duration with project/run boundary enforcement.
   */
  public renewLease(
    leaseId: string,
    extensionMs: number,
    options?: { projectId?: string; runId?: string },
  ): ModelLease {
    this.pruneExpiredLeases();
    const lease = this.activeLeases.get(leaseId);
    if (!lease) {
      throw new Error(`LEASE_NOT_FOUND: Lease '${leaseId}' does not exist or has expired`);
    }

    if (lease.projectId && options?.projectId && lease.projectId !== options.projectId) {
      throw new Error(
        `CROSS_PROJECT_LEASE_ACCESS: Lease '${leaseId}' belongs to project '${lease.projectId}', cannot be renewed by project '${options.projectId}'`,
      );
    }

    if (lease.runId && options?.runId && lease.runId !== options.runId) {
      throw new Error(
        `WRONG_RUN_LEASE_RELEASE: Lease '${leaseId}' belongs to run '${lease.runId}', cannot be renewed by run '${options.runId}'`,
      );
    }

    const now = Date.now();
    const currentExpiry = lease.expiresAt ? new Date(lease.expiresAt).getTime() : now;
    if (currentExpiry <= now) {
      this.releaseLease(leaseId);
      throw new Error(`LEASE_EXPIRED: Lease '${leaseId}' has expired and cannot be renewed`);
    }

    const newExpiry = new Date(currentExpiry + extensionMs).toISOString();
    const renewed: ModelLease = {
      ...lease,
      expiresAt: newExpiry,
    };
    this.activeLeases.set(leaseId, renewed);
    return renewed;
  }

  /**
   * Scans and prunes expired leases.
   */
  public pruneExpiredLeases(): number {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, lease] of this.activeLeases.entries()) {
      if (lease.expiresAt) {
        const expiry = new Date(lease.expiresAt).getTime();
        if (expiry <= now) {
          expiredIds.push(id);
        }
      }
    }

    for (const id of expiredIds) {
      const lease = this.activeLeases.get(id);
      if (lease) {
        const reg = this.resolveModelRegistration(lease.modelId);
        if (!reg || reg.device !== 'cpu') {
          try { this.globalResidency.releaseLease(id); } catch {}
        }
        this.activeLeases.delete(id);
      }
    }

    if (expiredIds.length > 0) {
      if (this.getActiveGpuLeasesCount() === 0) {
        this.startIdleTimer();
      }
      this.processQueue();
    }

    return expiredIds.length;
  }

  /**
   * Explicitly reaps stale/expired leases for service recovery.
   */
  public reapStaleLeases(): number {
    return this.pruneExpiredLeases();
  }

  /**
   * Recovers state after service restart.
   */
  public recoverState(): { reapedLeases: number } {
    const reaped = this.pruneExpiredLeases();
    return { reapedLeases: reaped };
  }

  /**
   * Release all active leases.
   */
  public releaseAllLeases(projectId?: string): number {
    const leases = Array.from(this.activeLeases.values());
    let releasedCount = 0;
    for (const lease of leases) {
      if (!projectId || !lease.projectId || lease.projectId === projectId) {
        try { this.globalResidency.releaseLease(lease.id); } catch {}
        this.activeLeases.delete(lease.id);
        releasedCount++;
      }
    }

    if (this.getActiveGpuLeasesCount() === 0) {
      this.unloadCurrentModel();
    }
    return releasedCount;
  }

  public listLeases(projectId?: string): ModelLease[] {
    this.pruneExpiredLeases();
    const all = Array.from(this.activeLeases.values()).map((l) => ({ ...l }));
    if (projectId) {
      return all.filter((l) => !l.projectId || l.projectId === projectId);
    }
    return all;
  }

  public getResidencyStatus(): ModelResidencyStatus {
    this.pruneExpiredLeases();
    const reg = this.residentModelId ? this.registeredModels.get(this.residentModelId) : undefined;
    return {
      residentModelId: this.residentModelId,
      residentModelRevision: this.residentRevision,
      residentDevice: this.residentDevice,
      vramUsedMb: this.residentVramMb,
      vramBudgetMb: VLM_MANIFEST_BUDGETS.maxVramMb,
      activeLeases: this.activeLeases.size,
      queueLength: this.queue.length,
      healthy: reg ? reg.isHealthy : true,
      unhealthyReason: reg?.unhealthyReason,
      residentModels: this.residentModelId ? [this.residentModelId] : [],
      estimatedVramMb: this.residentVramMb,
    };
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getConsecutiveChatTurns(): number {
    return this.consecutiveChatTurns;
  }

  public getMaxConsecutiveChatTurns(): number {
    return this.maxConsecutiveChatTurns;
  }

  public resetConsecutiveChatTurns(): void {
    this.consecutiveChatTurns = 0;
  }

  public getQueuedRequests(): Array<{
    id: string;
    modelId: string;
    priority: any;
    enqueuedAt: number;
    effectivePriority: number;
    projectId?: string;
    runId?: string;
  }> {
    this.sortQueue();
    return this.queue.map((req) => ({
      id: req.id,
      modelId: req.options.modelId,
      priority: req.options.priority,
      enqueuedAt: req.enqueuedAt,
      effectivePriority: req.effectivePriority,
      projectId: req.options.projectId,
      runId: req.options.runId,
    }));
  }

  public cancelQueuedRequest(requestId: string): boolean {
    const index = this.queue.findIndex((r) => r.id === requestId);
    if (index === -1) return false;
    const [removed] = this.queue.splice(index, 1);
    removed.reject(new Error('Lease request cancelled by client'));
    return true;
  }

  /**
   * Unload the currently resident model from VRAM.
   */
  public unloadCurrentModel(releaseGlobal = true): boolean {
    if (!this.residentModelId) return false;
    if (this.getActiveGpuLeasesCount() > 0) {
      throw new VlmError(
        'Cannot unload a model while local leases are active',
        VLM_ERROR_CODES.CONCURRENCY_VIOLATION,
      );
    }
    this.clearIdleTimer();
    if (releaseGlobal) this.globalResidency.unload();
    this.residentModelId = null;
    this.residentRevision = null;
    this.residentDevice = 'none';
    this.residentVramMb = 0;
    return true;
  }

  /**
   * Verify an offline snapshot directory against its manifest.
   */
  public verifySnapshotManifest(manifestPath: string, snapshotDir: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, errors: [`Manifest not found at ${manifestPath}`] };
    }

    let manifest: VlmSnapshotManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err: any) {
      return { valid: false, errors: [`Malformed manifest JSON: ${err.message}`] };
    }

    if (!fs.existsSync(snapshotDir)) {
      return { valid: false, errors: [`Snapshot directory not found: ${snapshotDir}`] };
    }

    let canonicalSnapshot: string;
    let canonicalStore: string;
    try {
      canonicalSnapshot = fs.realpathSync(snapshotDir);
      canonicalStore = fs.realpathSync(path.join(this.projectRoot, 'offline-stores', 'model-snapshot'));
    } catch (err: any) {
      return { valid: false, errors: [`Snapshot path cannot be canonicalized: ${err.message}`] };
    }
    const snapshotRelative = path.relative(canonicalStore, canonicalSnapshot);
    if (!snapshotRelative || snapshotRelative.startsWith('..') || path.isAbsolute(snapshotRelative)) {
      return { valid: false, errors: ['Snapshot directory resolves outside the approved offline store'] };
    }
    if (manifest.snapshotRelativePath) {
      const declaredSnapshot = path.resolve(canonicalStore, manifest.snapshotRelativePath);
      if (path.resolve(declaredSnapshot) !== path.resolve(canonicalSnapshot)) {
        return { valid: false, errors: ['Snapshot directory does not match manifest snapshotRelativePath'] };
      }
    }

    for (const file of manifest.files) {
      const filePath = path.resolve(canonicalSnapshot, file.path);
      const relative = path.relative(canonicalSnapshot, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`Snapshot manifest path escapes snapshot directory: ${file.path}`);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        errors.push(`Missing model snapshot file: ${file.path}`);
        continue;
      }
      let canonicalFile: string;
      try {
        canonicalFile = fs.realpathSync(filePath);
      } catch {
        errors.push(`Model snapshot file cannot be canonicalized: ${file.path}`);
        continue;
      }
      const canonicalRelative = path.relative(canonicalSnapshot, canonicalFile);
      if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
        errors.push(`Model snapshot file symlink escapes snapshot directory: ${file.path}`);
        continue;
      }
      const stat = fs.statSync(canonicalFile);
      if (!stat.isFile()) {
        errors.push(`Missing model snapshot file: ${file.path}`);
        continue;
      }
      if (stat.size !== file.size) {
        errors.push(`Size mismatch for ${file.path}: expected ${file.size}, got ${stat.size}`);
        continue;
      }
      const actualHash = this.hashFile(canonicalFile);
      if (actualHash.toLowerCase() !== file.sha256.toLowerCase()) {
        errors.push(`SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private resolveModelRegistration(modelId: string): ModelRegistration | undefined {
    let reg = this.registeredModels.get(modelId);
    if (!reg && modelId.includes('/')) {
      const shortName = modelId.slice(modelId.lastIndexOf('/') + 1);
      reg = this.registeredModels.get(shortName);
    }
    if (!reg) {
      for (const [key, val] of this.registeredModels.entries()) {
        if (key.endsWith(`/${modelId}`) || val.modelId.endsWith(`/${modelId}`)) {
          return val;
        }
      }
    }
    return reg;
  }

  private assertSnapshotAvailable(reg: ModelRegistration): void {
    if (!reg.manifestPath || !reg.snapshotPath) {
      throw new VlmError(
        `Model '${reg.modelId}' has no verified offline snapshot identity. Runtime downloads are prohibited.`,
        VLM_ERROR_CODES.NO_RUNTIME_DOWNLOAD,
      );
    }
    if (!fs.existsSync(reg.manifestPath)) {
      throw new VlmError(
        `Model snapshot manifest missing: ${reg.manifestPath}. Runtime downloads are prohibited.`,
        VLM_ERROR_CODES.NO_RUNTIME_DOWNLOAD,
      );
    }

    let manifest: VlmSnapshotManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(reg.manifestPath, 'utf-8')) as VlmSnapshotManifest;
    } catch (err: any) {
      throw new VlmError(
        `Model snapshot manifest is malformed: ${err.message}`,
        VLM_ERROR_CODES.SNAPSHOT_CORRUPTED,
      );
    }

    if (
      manifest.schemaVersion !== 1 ||
      manifest.model !== reg.modelId ||
      manifest.revision !== reg.revision ||
      (manifest.quantization !== undefined && manifest.quantization !== reg.quantization)
    ) {
      throw new VlmError(
        `Model snapshot identity does not match pinned registration for '${reg.modelId}'.`,
        VLM_ERROR_CODES.REVISION_MISMATCH,
      );
    }

    const snapshotRoot = path.resolve(this.projectRoot, 'offline-stores', 'model-snapshot');
    const resolvedSnapshot = path.resolve(reg.snapshotPath);
    const relative = path.relative(snapshotRoot, resolvedSnapshot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new VlmError(
        `Model snapshot path is outside the approved offline store: ${reg.snapshotPath}`,
        VLM_ERROR_CODES.SNAPSHOT_CORRUPTED,
      );
    }

    const verification = this.verifySnapshotManifest(reg.manifestPath, resolvedSnapshot);
    if (!verification.valid) {
      throw new VlmError(
        `Model snapshot verification failed: ${verification.errors.join('; ')}`,
        VLM_ERROR_CODES.SNAPSHOT_CORRUPTED,
      );
    }
  }

  private hashFile(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024 * 1024);
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }

  private canGrantImmediately(reg: ModelRegistration): boolean {
    // 0. CPU models never contend for GPU VRAM
    if (reg.device === 'cpu') {
      return true;
    }

    // 1. If same model is already resident, we can grant another lease
    if (this.residentModelId === reg.modelId) {
      return true;
    }

    // 2. If no model is resident, we can load this model
    if (!this.residentModelId) {
      return true;
    }

    // 3. If another model is resident but has NO active GPU leases, we can switch
    if (this.getActiveGpuLeasesCount() === 0) {
      return true;
    }

    return false;
  }

  private grantLease(reg: ModelRegistration, opts: AcquireLeaseOptions): ModelLease {
    this.clearIdleTimer();
    const leaseId = `lease_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    if (reg.device !== 'cpu') {
      // Claim global residency before changing local state. The local unload does
      // not clear the global claim because the claim has already moved to the
      // new model under the registry lock.
      this.globalResidency.claimLease(reg.modelId, reg.revision, leaseId);
    }

    try {
      if (reg.device !== 'cpu') {
        // If switching models, unload current local residency first.
        if (this.residentModelId && this.residentModelId !== reg.modelId) {
          this.unloadCurrentModel(false);
        }

        // Load model into residency
        this.residentModelId = reg.modelId;
        this.residentRevision = reg.revision;
        this.residentDevice = opts.allowCpuFallback ? 'cpu' : reg.device;
        this.residentVramMb = opts.allowCpuFallback ? 0 : reg.vramRequiredMb;
      }

      // Track consecutive chat turns to prevent workflow starvation
      const isChat = opts.priority === 'interactive_chat' || opts.priority === 1;
      if (isChat) {
        this.consecutiveChatTurns++;
      } else {
        this.consecutiveChatTurns = 0;
      }

      const lease: ModelLease = {
        schemaVersion: 1,
        id: leaseId,
        modelId: reg.modelId,
        agentId: opts.agentId,
        projectId: opts.projectId,
        runId: opts.runId,
        revision: reg.revision,
        device: opts.allowCpuFallback ? 'cpu' : reg.device,
        grantedAt: new Date().toISOString(),
        expiresAt: opts.timeoutMs ? new Date(Date.now() + opts.timeoutMs).toISOString() : null,
        port: opts.port ?? reg.port,
      };

      this.activeLeases.set(leaseId, lease);
      return lease;
    } catch (err) {
      if (reg.device !== 'cpu') {
        try { this.globalResidency.releaseLease(leaseId); } catch {}
      }
      throw err;
    }
  }

  private enqueueRequest(reg: ModelRegistration, opts: AcquireLeaseOptions): Promise<ModelLease> {
    return new Promise<ModelLease>((resolve, reject) => {
      const priorityClass = typeof opts.priority === 'string' ? opts.priority : 'user_task';
      const basePriority = typeof opts.priority === 'number'
        ? opts.priority
        : PRIORITY_WEIGHTS[priorityClass] ?? 2;

      const request: QueuedRequest = {
        id: `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        options: opts,
        enqueuedAt: Date.now(),
        effectivePriority: basePriority,
        resolve,
        reject,
      };

      this.queue.push(request);
      this.sortQueue();
    });
  }

  private sortQueue(): void {
    const now = Date.now();
    for (const req of this.queue) {
      // 60s aging anti-starvation: increase priority by 1 (capped at priority 2)
      const ageSec = (now - req.enqueuedAt) / 1000;
      if (ageSec >= 60 && req.effectivePriority > 2) {
        req.effectivePriority = Math.max(2, req.effectivePriority - 1);
      }
    }

    // Sort ascending (priority 1 highest, priority 5 lowest), with strict FIFO tie-breaking
    this.queue.sort((a, b) => {
      // Fair limit: if interactive chat exceeded limit, prioritize workflow
      if (this.consecutiveChatTurns >= this.maxConsecutiveChatTurns) {
        if (a.options.priority === 'interactive_chat' && b.options.priority !== 'interactive_chat') return 1;
        if (b.options.priority === 'interactive_chat' && a.options.priority !== 'interactive_chat') return -1;
      }
      if (a.effectivePriority !== b.effectivePriority) {
        return a.effectivePriority - b.effectivePriority;
      }
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    this.sortQueue();
    const nextReq = this.queue[0];
    const reg = this.resolveModelRegistration(nextReq.options.modelId);

    if (!reg) {
      this.queue.shift();
      nextReq.reject(new VlmError(`Model '${nextReq.options.modelId}' unavailable`, VLM_ERROR_CODES.MODEL_UNAVAILABLE));
      return;
    }

    if (this.canGrantImmediately(reg)) {
      this.queue.shift();
      try {
        const lease = this.grantLease(reg, nextReq.options);
        nextReq.resolve(lease);
      } catch (err: any) {
        nextReq.reject(err);
      }
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.activeLeases.size === 0) {
        this.unloadCurrentModel();
      }
    }, this.idleUnloadMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
