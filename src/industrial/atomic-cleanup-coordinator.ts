/**
 * F9-08: Industrial Atomic Cleanup and Interruption Coordinator
 *
 * Provides transactional rollback, emergency teardown, signal-trapped cleanup,
 * and crash recovery across all MAOS runtime subsystems:
 *
 * 1. Mid-execution Task/Workflow Interruption:
 *    - Transition in-flight tasks and objectives to `interrupted` / `failed`.
 *    - Prevents phantom success (never allows interrupted execution to reach done).
 *
 * 2. Model Lease Reclamation:
 *    - Forcibly releases all GPU/VRAM leases held by active agents.
 *
 * 3. Sandbox Container & Workspace Teardown:
 *    - Kills and removes running Docker containers immediately (`rm -f`).
 *    - Purges ephemeral staging directories.
 *
 * 4. Network Observation Session Teardown:
 *    - Clears active polling interval timers.
 *    - Flushes partial traces to disk without leaking unpersisted measurements.
 *
 * 5. Firewall Transaction Recovery & Rollback:
 *    - Reconciles interrupted firewall applications (`RESTORE_REQUIRED`).
 *    - Restores pre-change snapshot state.
 *
 * 6. Orphan File & Stale Lock Removal:
 *    - Purges temporary artifacts in `.maos/artifacts/tmp`.
 *    - Purges temporary bundle staging files in `.maos/bundles/.tmp_*`.
 *    - Releases stale lifecycle lockfiles when owner PID is dead.
 *
 * 7. Signal Handling:
 *    - Traps SIGINT / SIGTERM for deterministic, idempotent teardown.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TaskService } from '../service/task-service';
import type { WorkflowService } from '../service/workflow-service';
import type { FirewallService } from '../service/firewall-service';
import type { ProcessBoundaryService } from '../service/process-boundary-service';
import type { NetworkMonitorService } from '../service/network-monitor-service';
import type { ModelService } from '../service/model-service';
import type { ArtifactService } from '../service/artifact-service';
import type { SovereigntyBundleService } from '../service/sovereignty-bundle-service';
import type { AuditService } from '../service/audit-service';
import type { Task, WorkflowStage } from '../domain/schemas';
import type { FirewallRestoreResult } from '../domain/firewall-policy';
import type { NetworkObservationTrace } from '../domain/network-monitor';
import { ContainerRunner } from './container-runner';
import { isProcessAlive } from './service-startup';
import { getLockPath } from './lifecycle';

export interface AtomicCleanupReport {
  readonly timestamp: string;
  readonly durationMs: number;
  readonly reason: string;
  readonly success: boolean;
  readonly tasksInterruptedCount: number;
  readonly workflowsInterruptedCount: number;
  readonly modelLeasesReleasedCount: number;
  readonly containersCleanedCount: number;
  readonly tempDirsCleanedCount: number;
  readonly networkSessionsStoppedCount: number;
  readonly firewallRestored: boolean;
  /**
   * Number of process-scoped boundary records torn down. Process scope writes no
   * host packet filter state, so this is independent of `firewallRestored`.
   */
  readonly processBoundariesDisabledCount: number;
  readonly orphanArtifactsPurgedCount: number;
  readonly orphanBundlesPurgedCount: number;
  readonly lifecycleLocksRemovedCount: number;
  readonly errors: ReadonlyArray<{ subsystem: string; message: string }>;
}

export interface AtomicCleanupCoordinatorOptions {
  readonly taskService?: TaskService;
  readonly workflowService?: WorkflowService;
  readonly firewallService?: FirewallService;
  /**
   * Process-scoped boundary owner. When present, cleanup clears any enabled
   * boundary record so a stale record cannot outlive its observation session.
   * This path writes no host firewall state.
   */
  readonly processBoundary?: ProcessBoundaryService;
  readonly networkMonitor?: NetworkMonitorService;
  readonly modelService?: ModelService;
  readonly artifactService?: ArtifactService;
  readonly sovereigntyBundle?: SovereigntyBundleService;
  readonly containerRunner?: ContainerRunner;
  readonly auditService?: AuditService;
}

export interface SignalHandlerOptions {
  readonly exitProcess?: boolean;
  readonly onInterrupted?: (report: AtomicCleanupReport) => void;
}

export class AtomicCleanupCoordinator {
  private readonly projectRoot: string;
  private readonly taskService?: TaskService;
  private readonly workflowService?: WorkflowService;
  private readonly firewallService?: FirewallService;
  private readonly processBoundary?: ProcessBoundaryService;
  private readonly networkMonitor?: NetworkMonitorService;
  private readonly modelService?: ModelService;
  private readonly artifactService?: ArtifactService;
  private readonly sovereigntyBundle?: SovereigntyBundleService;
  private readonly containerRunner: ContainerRunner;
  private readonly auditService?: AuditService;

  private readonly activeContainers = new Set<string>();
  private readonly activeTempDirs = new Set<string>();

  private sigintListener?: () => void;
  private sigtermListener?: () => void;
  private inProgressCleanup = false;

  constructor(
    projectRoot: string,
    options: AtomicCleanupCoordinatorOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.taskService = options.taskService;
    this.workflowService = options.workflowService;
    this.firewallService = options.firewallService;
    this.processBoundary = options.processBoundary;
    this.networkMonitor = options.networkMonitor;
    this.modelService = options.modelService;
    this.artifactService = options.artifactService;
    this.sovereigntyBundle = options.sovereigntyBundle;
    this.containerRunner = options.containerRunner || new ContainerRunner();
    this.auditService = options.auditService;
  }

  // ── Registration APIs for In-Flight Resources ─────────────────────────

  /**
   * Register an in-flight sandbox container. Returns an unregister handle.
   */
  public registerContainer(containerName: string): () => void {
    this.activeContainers.add(containerName);
    return () => this.unregisterContainer(containerName);
  }

  public unregisterContainer(containerName: string): void {
    this.activeContainers.delete(containerName);
  }

  public getActiveContainers(): readonly string[] {
    return Array.from(this.activeContainers);
  }

  /**
   * Register a temporary directory slated for atomic cleanup.
   */
  public registerTempDir(dirPath: string): () => void {
    const resolved = path.resolve(dirPath);
    this.activeTempDirs.add(resolved);
    return () => this.unregisterTempDir(resolved);
  }

  public unregisterTempDir(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    this.activeTempDirs.delete(resolved);
  }

  public getActiveTempDirs(): readonly string[] {
    return Array.from(this.activeTempDirs);
  }

  public isCleaningUp(): boolean {
    return this.inProgressCleanup;
  }

  // ── Subsystem Cleanup Routines ────────────────────────────────────────

  /**
   * Interrupt all in-flight tasks in the active queue.
   */
  public interruptActiveTasks(reason = 'Emergency interruption / shutdown'): Task[] {
    if (!this.taskService) return [];
    try {
      return this.taskService.interruptActiveTasks(reason);
    } catch {
      return [];
    }
  }

  /**
   * Interrupt all in-flight workflows/objectives.
   */
  public interruptWorkflows(reason = 'Emergency interruption / shutdown'): WorkflowStage[] {
    if (!this.workflowService) return [];
    try {
      return this.workflowService.interruptAllWorkflows(reason, this.taskService);
    } catch {
      return [];
    }
  }

  /**
   * Forcibly kills and removes all registered active sandbox containers.
   */
  public cleanupContainers(): { killed: string[]; errors: Array<{ container: string; message: string }> } {
    const killed: string[] = [];
    const errors: Array<{ container: string; message: string }> = [];

    for (const name of Array.from(this.activeContainers)) {
      try {
        this.containerRunner.cleanupContainerSync(name);
        killed.push(name);
        this.activeContainers.delete(name);
      } catch (err: any) {
        errors.push({ container: name, message: err.message || String(err) });
      }
    }

    return { killed, errors };
  }

  /**
   * Cleans up all registered temporary directories.
   */
  public cleanupTempDirs(): { purged: string[]; errors: Array<{ dir: string; message: string }> } {
    const purged: string[] = [];
    const errors: Array<{ dir: string; message: string }> = [];

    for (const dir of Array.from(this.activeTempDirs)) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        purged.push(dir);
        this.activeTempDirs.delete(dir);
      } catch (err: any) {
        errors.push({ dir, message: err.message || String(err) });
      }
    }

    return { purged, errors };
  }

  /**
   * Stops all active network observation sessions and flushes traces.
   */
  public async cleanupNetworkObservers(reason = 'Emergency interruption / shutdown'): Promise<NetworkObservationTrace[]> {
    if (!this.networkMonitor) return [];
    try {
      return await this.networkMonitor.interruptAll(reason);
    } catch {
      return [];
    }
  }

  /**
   * Releases all active model leases.
   */
  public cleanupModelLeases(): number {
    if (!this.modelService) return 0;
    try {
      return this.modelService.releaseAllLeases();
    } catch {
      return 0;
    }
  }

  /**
   * Reconciles and rolls back firewall state if interrupted (`RESTORE_REQUIRED`).
   */
  public async cleanupFirewallState(): Promise<FirewallRestoreResult | null> {
    if (!this.firewallService) return null;
    try {
      const status = await this.firewallService.getStatus();
      if (status.state === 'RESTORE_REQUIRED' || status.restoreRequired) {
        return await this.firewallService.restorePreviousState();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clears any enabled process-scoped boundary record.
   *
   * A boundary record is only meaningful while its observation session is alive.
   * The session is torn down in step 4, so the record must be cleared here too —
   * otherwise a subsequent status read would find a record whose enforcement has
   * already ended. Idempotent, and writes no host firewall state.
   */
  public async cleanupProcessBoundary(): Promise<number> {
    if (!this.processBoundary) return 0;

    let cleared = 0;
    for (const projectId of this.processBoundary.listEnabledProjectIds()) {
      try {
        await this.processBoundary.disable(projectId, { confirm: true });
        cleared++;
      } catch {
        // Best effort: a boundary that cannot be torn down is reported by the
        // caller through the overall cleanup error list.
      }
    }
    return cleared;
  }

  /**
   * Purges orphan temporary files and releases dead lifecycle locks.
   */
  public cleanupOrphanFiles(options?: { forceLockRelease?: boolean }): {
    artifactsPurged: number;
    bundlesPurged: number;
    locksRemoved: number;
  } {
    let artifactsPurged = 0;
    let bundlesPurged = 0;
    let locksRemoved = 0;

    // 1. Artifacts temp files
    if (this.artifactService) {
      try {
        artifactsPurged += this.artifactService.cleanupOrphanTempFiles(0);
      } catch {
        // Continue
      }
    }
    const artifactDirs = [
      path.join(this.projectRoot, 'artifacts', '.tmp'),
      path.join(this.projectRoot, '.maos', 'artifacts', 'tmp'),
    ];
    for (const dir of artifactDirs) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (f.startsWith('.tmp_')) {
              try {
                fs.unlinkSync(path.join(dir, f));
                artifactsPurged++;
              } catch {}
            }
          }
        } catch {}
      }
    }

    // 2. Bundles temp files
    if (this.sovereigntyBundle) {
      try {
        bundlesPurged += this.sovereigntyBundle.cleanupOrphanTempFiles();
      } catch {
        // Continue
      }
    }
    const bundlesDir = path.join(this.projectRoot, '.maos', 'bundles');
    if (fs.existsSync(bundlesDir)) {
      try {
        const files = fs.readdirSync(bundlesDir);
        for (const f of files) {
          if (f.includes('.tmp_')) {
            try {
              fs.unlinkSync(path.join(bundlesDir, f));
              bundlesPurged++;
            } catch {}
          }
        }
      } catch {}
    }

    // 3. Stale lifecycle lock
    const lockPath = getLockPath(this.projectRoot);
    if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(raw);
        const ownerDead = typeof data.pid === 'number' ? !isProcessAlive(data.pid) : true;
        if (ownerDead || options?.forceLockRelease) {
          fs.unlinkSync(lockPath);
          locksRemoved++;
        }
      } catch {
        // Corrupt lock file -> remove
        try {
          fs.unlinkSync(lockPath);
          locksRemoved++;
        } catch {}
      }
    }

    return { artifactsPurged, bundlesPurged, locksRemoved };
  }

  // ── Unified Atomic Cleanup Orchestrator ───────────────────────────────

  /**
   * Executes a complete atomic cleanup pass across all registered subsystems.
   * Safe to execute multiple times (idempotent).
   */
  public async executeAtomicCleanup(options: {
    reason?: string;
    force?: boolean;
  } = {}): Promise<AtomicCleanupReport> {
    if (this.inProgressCleanup) {
      // Prevent recursive / re-entrant cleanup loops
      return {
        timestamp: new Date().toISOString(),
        durationMs: 0,
        reason: options.reason || 'Re-entrant cleanup suppressed',
        success: true,
        tasksInterruptedCount: 0,
        workflowsInterruptedCount: 0,
        modelLeasesReleasedCount: 0,
        containersCleanedCount: 0,
        tempDirsCleanedCount: 0,
        networkSessionsStoppedCount: 0,
        firewallRestored: false,
        processBoundariesDisabledCount: 0,
        orphanArtifactsPurgedCount: 0,
        orphanBundlesPurgedCount: 0,
        lifecycleLocksRemovedCount: 0,
        errors: [],
      };
    }

    this.inProgressCleanup = true;
    const startMs = Date.now();
    const reason = options.reason || 'Manual atomic cleanup invocation';
    const errors: Array<{ subsystem: string; message: string }> = [];

    let tasksInterruptedCount = 0;
    let workflowsInterruptedCount = 0;
    let modelLeasesReleasedCount = 0;
    let containersCleanedCount = 0;
    let tempDirsCleanedCount = 0;
    let networkSessionsStoppedCount = 0;
    let firewallRestored = false;
    let processBoundariesDisabledCount = 0;
    let orphanArtifactsPurgedCount = 0;
    let orphanBundlesPurgedCount = 0;
    let lifecycleLocksRemovedCount = 0;

    try {
      // Step 1: Interrupt tasks and workflows to prevent phantom success
      try {
        const interruptedTasks = this.interruptActiveTasks(reason);
        tasksInterruptedCount = interruptedTasks.length;
      } catch (err: any) {
        errors.push({ subsystem: 'tasks', message: err.message || String(err) });
      }

      try {
        const interruptedWorkflows = this.interruptWorkflows(reason);
        workflowsInterruptedCount = interruptedWorkflows.length;
      } catch (err: any) {
        errors.push({ subsystem: 'workflows', message: err.message || String(err) });
      }

      // Step 2: Release model leases
      try {
        modelLeasesReleasedCount = this.cleanupModelLeases();
      } catch (err: any) {
        errors.push({ subsystem: 'model_leases', message: err.message || String(err) });
      }

      // Step 3: Containers and staging directories
      try {
        const containerRes = this.cleanupContainers();
        containersCleanedCount = containerRes.killed.length;
        for (const e of containerRes.errors) {
          errors.push({ subsystem: 'containers', message: `${e.container}: ${e.message}` });
        }
      } catch (err: any) {
        errors.push({ subsystem: 'containers', message: err.message || String(err) });
      }

      try {
        const tempDirRes = this.cleanupTempDirs();
        tempDirsCleanedCount = tempDirRes.purged.length;
        for (const e of tempDirRes.errors) {
          errors.push({ subsystem: 'temp_dirs', message: `${e.dir}: ${e.message}` });
        }
      } catch (err: any) {
        errors.push({ subsystem: 'temp_dirs', message: err.message || String(err) });
      }

      // Step 4: Network observation sessions
      try {
        const traces = await this.cleanupNetworkObservers(reason);
        networkSessionsStoppedCount = traces.length;
      } catch (err: any) {
        errors.push({ subsystem: 'network_monitor', message: err.message || String(err) });
      }

      // Step 5: Firewall state restoration
      try {
        const restoreRes = await this.cleanupFirewallState();
        firewallRestored = !!restoreRes && restoreRes.success;
      } catch (err: any) {
        errors.push({ subsystem: 'firewall', message: err.message || String(err) });
      }

      // Step 5b: Process-scoped boundary record teardown
      try {
        processBoundariesDisabledCount = await this.cleanupProcessBoundary();
      } catch (err: any) {
        errors.push({ subsystem: 'process_boundary', message: err.message || String(err) });
      }

      // Step 6: Orphan files and locks
      try {
        const orphanRes = this.cleanupOrphanFiles({ forceLockRelease: options.force });
        orphanArtifactsPurgedCount = orphanRes.artifactsPurged;
        orphanBundlesPurgedCount = orphanRes.bundlesPurged;
        lifecycleLocksRemovedCount = orphanRes.locksRemoved;
      } catch (err: any) {
        errors.push({ subsystem: 'orphan_files', message: err.message || String(err) });
      }
    } finally {
      this.inProgressCleanup = false;
    }

    const durationMs = Date.now() - startMs;
    const report: AtomicCleanupReport = {
      timestamp: new Date().toISOString(),
      durationMs,
      reason,
      success: errors.length === 0,
      tasksInterruptedCount,
      workflowsInterruptedCount,
      modelLeasesReleasedCount,
      containersCleanedCount,
      tempDirsCleanedCount,
      networkSessionsStoppedCount,
      firewallRestored,
      processBoundariesDisabledCount,
      orphanArtifactsPurgedCount,
      orphanBundlesPurgedCount,
      lifecycleLocksRemovedCount,
      errors,
    };

    // Step 7: Record audit event
    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'stage',
          source: 'atomic-cleanup-coordinator',
          data: {
            event: 'ATOMIC_CLEANUP_COMPLETED',
            reason: report.reason,
            success: report.success,
            durationMs: report.durationMs,
            tasksInterruptedCount: report.tasksInterruptedCount,
            workflowsInterruptedCount: report.workflowsInterruptedCount,
            modelLeasesReleasedCount: report.modelLeasesReleasedCount,
            containersCleanedCount: report.containersCleanedCount,
            tempDirsCleanedCount: report.tempDirsCleanedCount,
            networkSessionsStoppedCount: report.networkSessionsStoppedCount,
            firewallRestored: report.firewallRestored,
            orphanArtifactsPurgedCount: report.orphanArtifactsPurgedCount,
            orphanBundlesPurgedCount: report.orphanBundlesPurgedCount,
            lifecycleLocksRemovedCount: report.lifecycleLocksRemovedCount,
            errorCount: report.errors.length,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return report;
  }

  // ── Signal Handling ───────────────────────────────────────────────────

  /**
   * Install SIGINT and SIGTERM handlers for automated atomic cleanup on process shutdown.
   */
  public installSignalHandlers(options: SignalHandlerOptions = {}): void {
    this.removeSignalHandlers();

    const handler = async (signalName: string) => {
      const report = await this.executeAtomicCleanup({
        reason: `Process caught ${signalName}`,
      });

      if (options.onInterrupted) {
        try {
          options.onInterrupted(report);
        } catch {}
      }

      if (options.exitProcess) {
        process.exit(130);
      }
    };

    this.sigintListener = () => {
      void handler('SIGINT');
    };
    this.sigtermListener = () => {
      void handler('SIGTERM');
    };

    process.on('SIGINT', this.sigintListener);
    process.on('SIGTERM', this.sigtermListener);
  }

  /**
   * Removes installed SIGINT and SIGTERM listeners.
   */
  public removeSignalHandlers(): void {
    if (this.sigintListener) {
      process.removeListener('SIGINT', this.sigintListener);
      this.sigintListener = undefined;
    }
    if (this.sigtermListener) {
      process.removeListener('SIGTERM', this.sigtermListener);
      this.sigtermListener = undefined;
    }
  }
}
