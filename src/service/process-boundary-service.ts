/**
 * F9-10: Process-Scoped Boundary Service
 *
 * Owns the lifecycle of the Industrial sovereignty boundary at PROCESS scope:
 * enable -> measure -> disable.
 *
 * Design contract (see docs/BOUNDARY_SCOPE.md):
 *
 * 1. NO HOST MUTATION. This service never invokes New-NetFirewallRule, nft, or
 *    any host packet-filter API, and never requires administrator/root. Its
 *    adapter-free nature is the safety property, not a limitation.
 *
 * 2. ACTIVE IS MEASURED, NEVER INFERRED FROM A FILE. A boundary is ACTIVE only
 *    when, at the moment of the query:
 *      (a) a boundary record exists for the project,
 *      (b) the passive observation session for that record is genuinely running
 *          in-process, and
 *      (c) the recorded policy hash still matches the sealed active policy.
 *    A record with no live session reports INACTIVE. Nothing here can report a
 *    boundary that is not currently being enforced.
 *
 * 3. ATTRIBUTION IS EXPLICIT. The observation session is scoped to the MAOS
 *    process tree. A monitor without a PID filter evaluates every socket on the
 *    host, which would both misattribute unrelated traffic and make the boundary
 *    permanently unfalsifiable. The resolved scope is recorded and reported.
 *
 * 4. DISABLE IS A REAL RESTORE. It stops the live session, persists the
 *    observation trace as durable evidence, and removes the record — restoring
 *    the machine to exactly the state it was in before enable.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import type { NetworkMonitorService } from './network-monitor-service';
import {
  FirewallBoundaryScope,
  FirewallStatusResult,
  FIREWALL_ERROR_CODES,
  FirewallError,
} from '../domain/firewall-policy';
import {
  ProcessBoundaryPlan,
  PROCESS_BOUNDARY_ERROR_CODES,
  ProcessBoundaryError,
  synthesizeProcessBoundaryPlan,
  validateProcessBoundaryPlan,
  computeCanonicalProcessBoundaryPlanHash,
} from '../domain/process-boundary';
import { validateEndpointPolicy } from '../domain/endpoint-allowlist';
import { resolveProcessTree, mergeProcessScope } from '../industrial/process-tree';
import { isProcessAlive } from '../industrial/service-startup';

// ── Types ───────────────────────────────────────────────────────────

export interface ProcessBoundaryServiceOptions {
  readonly auditService?: AuditService;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly networkMonitor?: NetworkMonitorService;
  /** Overrides the attribution root. Defaults to the current process. */
  readonly rootPid?: number;
  /** Injected for deterministic tests. Defaults to a real process-tree walk. */
  readonly resolveTree?: (rootPid: number) => Promise<{
    pids: readonly number[];
    complete: boolean;
    reason?: string;
  }>;
}

export interface EnableProcessBoundaryOptions {
  /** Explicit operator confirmation. Required; there is no implicit enable. */
  readonly confirm?: boolean;
  readonly sessionId?: string;
  readonly samplingIntervalMs?: number;
  /** Additional PIDs to attribute (e.g. an externally launched model server). */
  readonly monitoredPids?: readonly number[];
  readonly monitoredProcessNames?: readonly string[];
  /**
   * Marks the lifecycle as a mechanism check rather than a real enforcement
   * session. Recorded in the audit chain so a reader can tell a preflight probe
   * apart from a boundary that guarded actual work.
   */
  readonly selfTest?: boolean;
}

export interface DisableProcessBoundaryOptions {
  readonly confirm?: boolean;
  readonly selfTest?: boolean;
  /**
   * Removes the observation trace after teardown. Used for self-test sessions,
   * which observe a process doing no work; persisting a trace per invocation
   * would grow the evidence directory without recording anything meaningful.
   */
  readonly discardEvidence?: boolean;
}

export interface ProcessBoundaryEnableResult {
  readonly success: boolean;
  readonly projectId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly policyHash: string;
  readonly constraintCount: number;
  readonly monitoredPids: readonly number[];
  readonly attributionComplete: boolean;
  readonly attributionReason?: string;
  readonly hostFirewallModified: false;
  readonly elevationRequired: false;
  readonly enabledAt: string;
  /** True when an identical boundary was already enforced (idempotent re-enable). */
  readonly alreadyActive?: boolean;
}

export interface ProcessBoundaryDisableResult {
  readonly success: boolean;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly tracePath?: string;
  readonly traceHash?: string;
  readonly disabledAt: string;
  readonly hostFirewallModified: false;
}

export interface ProcessBoundarySelfTestResult {
  readonly verified: boolean;
  readonly projectId: string;
  readonly sessionId: string;
  readonly planId?: string;
  readonly planHash?: string;
  readonly policyHash?: string;
  readonly constraintCount: number;
  readonly monitoredPids: readonly number[];
  readonly attributionComplete: boolean;
  readonly attributionReason?: string;
  readonly sampleCount: number;
  readonly observedSocketCount: number;
  readonly violationCount: number;
  readonly violations: readonly string[];
  readonly hostFirewallModified: false;
  readonly elevationRequired: false;
  readonly errors: readonly string[];
  readonly checkedAt: string;
}

interface ProcessBoundaryRecord {
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  planId: string;
  planHash: string;
  policyHash: string;
  plan: ProcessBoundaryPlan;
  monitoredPids: number[];
  monitoredProcessNames: string[];
  attributionComplete: boolean;
  attributionReason?: string;
  /**
   * PID of the process holding the observation session. The record is only valid
   * while this process lives; exit-hook cleanup and liveness reporting key off it.
   */
  holderPid: number;
  startedAt: string;
}

interface ProcessBoundaryStateFile {
  schemaVersion: 1;
  records: Record<string, ProcessBoundaryRecord>;
}

/** Sampling cadence for the passive observer while a boundary is enabled. */
const DEFAULT_SAMPLING_INTERVAL_MS = 5000;

/**
 * A socket sample younger than this is reused instead of re-taken. Host socket
 * enumeration is a subprocess round trip, so re-taking an identical sample
 * immediately is pure cost with no added information.
 */
const FRESH_SAMPLE_MAX_AGE_MS = 2000;

/**
 * Instances holding boundary records, served by one shared process-exit listener.
 * Module-level so that constructing many boundaries in one process registers one
 * listener, not one per instance.
 */
const boundaryRecordHolders = new Set<ProcessBoundaryService>();
let sharedExitHookInstalled = false;

// ── Service ─────────────────────────────────────────────────────────

export class ProcessBoundaryService {
  public readonly boundaryScope: FirewallBoundaryScope = 'process';
  public readonly hostFirewallModified = false;
  public readonly elevationRequired = false;

  private readonly boundaryDir: string;
  private readonly recordPath: string;
  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly networkMonitor?: NetworkMonitorService;
  private readonly rootPid: number;
  private readonly resolveTree: NonNullable<ProcessBoundaryServiceOptions['resolveTree']>;

  constructor(
    private readonly projectRoot: string,
    options: ProcessBoundaryServiceOptions = {},
  ) {
    this.boundaryDir = path.join(this.projectRoot, '.maos', 'firewall');
    this.recordPath = path.join(this.boundaryDir, 'process-boundary.json');
    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.networkMonitor = options.networkMonitor;
    this.rootPid = options.rootPid ?? process.pid;
    this.resolveTree = options.resolveTree ?? resolveProcessTree;
  }

  // ── Enable ────────────────────────────────────────────────────────

  /**
   * Establishes an enforced, passively observed process-scoped boundary.
   * Writes no host firewall rules and requires no elevation.
   */
  public async enable(
    projectId: string = 'default',
    options: EnableProcessBoundaryOptions = {},
  ): Promise<ProcessBoundaryEnableResult> {
    if (options.confirm !== true) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED,
        'Enabling the Industrial boundary requires explicit operator confirmation (confirm: true).',
      );
    }

    if (!this.networkMonitor) {
      throw new ProcessBoundaryError(
        PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_SCOPE_UNRESOLVED,
        'Cannot enable process boundary: NetworkMonitorService is not configured. ' +
          'An unobserved boundary would be an unverifiable claim.',
      );
    }

    // 1. Resolve and validate the sealed endpoint policy.
    const policy = this.resolvePolicy(projectId);

    // 2. Resolve the attribution scope BEFORE synthesizing, so the plan records
    //    exactly which processes the boundary covers.
    const tree = await this.resolveTree(this.rootPid);
    const monitoredPids = mergeProcessScope(options.monitoredPids || [], tree.pids);
    const monitoredProcessNames = [...(options.monitoredProcessNames || [])];

    if (monitoredPids.length === 0) {
      throw new ProcessBoundaryError(
        PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_SCOPE_UNRESOLVED,
        'Cannot enable process boundary: attribution scope resolved to an empty PID set. ' +
          'Refusing to fall back to whole-host attribution.',
      );
    }

    // 3. Synthesize the deterministic boundary plan (fails closed on any
    //    non-loopback endpoint, tampered policy, or permitted DNS).
    const planIdentity = { monitoredPids, monitoredProcessNames };

    const existing = this.readRecord(projectId);
    if (existing) {
      // Idempotency must compare like with like: planId and createdAt are part of
      // the hashed payload, so re-derive using the RECORDED identity rather than
      // a fresh one (which would differ on every call and never match).
      let candidateHash: string | undefined;
      try {
        candidateHash = synthesizeProcessBoundaryPlan(policy, {
          planId: existing.planId,
          createdAt: existing.plan.createdAt,
          ...planIdentity,
        }).planHash;
      } catch {
        candidateHash = undefined;
      }

      if (
        candidateHash !== undefined &&
        candidateHash === existing.planHash &&
        this.networkMonitor.isObservationActive(existing.sessionId)
      ) {
        // Idempotent re-enable: the identical boundary is already enforced.
        return this.toEnableResult(existing, true);
      }

      // Stale record (session ended, or scope changed): tear it down before
      // re-establishing so no orphaned evidence is left behind.
      await this.teardownRecord(existing, 'superseded');
    }

    const plan = synthesizeProcessBoundaryPlan(policy, planIdentity);

    // 4. Start the passive observation session scoped to the process tree.
    const sessionId = options.sessionId || `pbs_${projectId}_${Date.now()}`;
    try {
      await this.networkMonitor.startObservation(sessionId, projectId, {
        samplingIntervalMs: options.samplingIntervalMs ?? DEFAULT_SAMPLING_INTERVAL_MS,
        monitoredPids,
        monitoredProcessNames,
        // Sampling must stay resilient; violations are read by the requirement
        // service and surfaced as boundary state rather than thrown from a timer.
        failFastOnViolation: false,
      });
    } catch (err: any) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        `Failed to start boundary observation session: ${err.message}`,
      );
    }

    // 5. Confirm the observation actually produced a measurement. A session that
    //    cannot sample is not a boundary; roll back rather than record a claim.
    try {
      const snapshot = await this.networkMonitor.captureSnapshot(sessionId);
      if (typeof snapshot.totalSockets !== 'number') {
        throw new Error('observation produced no measurable socket sample');
      }
    } catch (err: any) {
      try {
        await this.networkMonitor.stopObservation(sessionId);
      } catch {
        // Best-effort teardown; the failed enable is still reported as failed.
      }
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        `Boundary observation could not produce a measurement, so no boundary was recorded: ${err.message}`,
      );
    }

    // 6. Commit the record.
    const record: ProcessBoundaryRecord = {
      schemaVersion: 1,
      projectId,
      sessionId,
      planId: plan.planId,
      planHash: plan.planHash!,
      policyHash: plan.policyHash,
      plan,
      monitoredPids,
      monitoredProcessNames,
      attributionComplete: tree.complete,
      attributionReason: tree.reason,
      holderPid: process.pid,
      startedAt: new Date().toISOString(),
    };

    this.writeRecord(record);

    // A boundary record is only meaningful while the process holding the
    // observation session is alive. Register a synchronous exit hook so a
    // short-lived holder never leaves a stale record behind — without it,
    // `enable` from a one-shot CLI would exit and immediately orphan its record.
    this.registerExitHook();

    this.audit(projectId, {
      event: 'PROCESS_BOUNDARY_ENABLED',
      sessionId,
      planId: plan.planId,
      planHash: plan.planHash,
      policyHash: plan.policyHash,
      scope: 'process',
      hostFirewallModified: false,
      elevationRequired: false,
      monitoredPidCount: monitoredPids.length,
      attributionComplete: tree.complete,
      constraintCount: plan.constraints.length,
      // Distinguishes a preflight probe from a boundary that guarded real work.
      selfTest: options.selfTest === true,
    });

    return this.toEnableResult(record, false);
  }

  // ── Disable ───────────────────────────────────────────────────────

  /**
   * Tears the boundary down: stops the live observation session, persists the
   * observation trace as durable evidence, and removes the record.
   *
   * Idempotent — disabling an absent boundary is a success, not an error, so
   * cleanup paths cannot fail on a boundary that was never enabled.
   */
  public async disable(
    projectId: string = 'default',
    options: DisableProcessBoundaryOptions = {},
  ): Promise<ProcessBoundaryDisableResult> {
    if (options.confirm !== true) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED,
        'Disabling the Industrial boundary requires explicit operator confirmation (confirm: true).',
      );
    }

    const record = this.readRecord(projectId);
    if (!record) {
      return {
        success: true,
        projectId,
        disabledAt: new Date().toISOString(),
        hostFirewallModified: false,
      };
    }

    const teardown = await this.teardownRecord(record, 'operator', {
      selfTest: options.selfTest === true,
    });

    if (options.discardEvidence && teardown.tracePath) {
      try {
        fs.unlinkSync(teardown.tracePath);
      } catch {
        // Already removed, or never written.
      }
      return {
        success: true,
        projectId,
        sessionId: record.sessionId,
        disabledAt: new Date().toISOString(),
        hostFirewallModified: false,
      };
    }

    return {
      success: true,
      projectId,
      sessionId: record.sessionId,
      tracePath: teardown.tracePath,
      traceHash: teardown.traceHash,
      disabledAt: new Date().toISOString(),
      hostFirewallModified: false,
    };
  }

  /**
   * Stops the session for a record, persists its trace, and deletes the record.
   * Shared by disable, supersede, and cleanup paths.
   */
  private async teardownRecord(
    record: ProcessBoundaryRecord,
    reason: 'operator' | 'superseded' | 'cleanup',
    options: { selfTest?: boolean } = {},
  ): Promise<{ tracePath?: string; traceHash?: string }> {
    let tracePath: string | undefined;
    let traceHash: string | undefined;

    if (this.networkMonitor && this.networkMonitor.isObservationActive(record.sessionId)) {
      try {
        const trace = await this.networkMonitor.stopObservation(record.sessionId);
        traceHash = trace.traceHash;
        tracePath = path.join(
          this.projectRoot,
          '.maos',
          'network-evidence',
          `${record.sessionId}.json`,
        );
      } catch {
        // The session may have already ended; the record still must be cleared.
      }
    }

    this.deleteRecord(record.projectId);

    if (reason !== 'superseded') {
      this.audit(record.projectId, {
        event: 'PROCESS_BOUNDARY_DISABLED',
        sessionId: record.sessionId,
        planHash: record.planHash,
        reason,
        traceHash,
        hostFirewallModified: false,
        selfTest: options.selfTest === true,
      });
    }

    return { tracePath, traceHash };
  }

  // ── Status (measured, never inferred) ─────────────────────────────

  /**
   * Returns the measured boundary state for a project.
   *
   * ACTIVE requires a live observation session AND an unchanged policy hash.
   * Anything else is INACTIVE — including the case where a record exists but its
   * session is gone.
   */
  public async getStatus(projectId: string = 'default'): Promise<FirewallStatusResult> {
    const checkedAt = new Date().toISOString();
    const record = this.readRecord(projectId);

    const base = {
      platform: 'process' as const,
      boundaryScope: 'process' as const,
      hostFirewallModified: false as const,
      isElevated: false,
      checkedAt,
    };

    if (!record) {
      return {
        ...base,
        state: 'INACTIVE',
        activeRuleCount: 0,
        snapshotCount: 0,
        restoreRequired: false,
        details:
          'No MAOS process-scoped boundary is enabled. Host packet filter rules are not used by this scope and have not been modified.',
      };
    }

    const live = this.networkMonitor?.isObservationActive(record.sessionId) ?? false;
    const summary = this.networkMonitor?.getActiveObservationSummary(record.sessionId);

    if (!live) {
      // Distinguish the three genuinely different reasons a record has no session:
      // held by another live process, orphaned by a dead one, or ended in this one.
      const holderIsSelf = record.holderPid === process.pid;
      const holderAlive = !holderIsSelf && isProcessAlive(record.holderPid);

      let detail: string;
      if (holderAlive) {
        detail =
          `Boundary record for session "${record.sessionId}" is held by another live process ` +
          `(PID ${record.holderPid}). A process-scoped boundary is observable only within the ` +
          'process that holds it, so no session is active here.';
      } else if (holderIsSelf) {
        detail =
          `Boundary record for session "${record.sessionId}" exists but its observation session ` +
          'is no longer running. The boundary is not currently enforced.';
      } else {
        detail =
          `Boundary record for session "${record.sessionId}" was orphaned: its holder process ` +
          `(PID ${record.holderPid}) is no longer running. The boundary is not enforced. ` +
          'Run `maos industrial boundary disable --yes` to clear the record.';
      }

      return {
        ...base,
        state: 'INACTIVE',
        activeRuleCount: 0,
        activePlanId: record.planId,
        activePolicyHash: record.policyHash,
        snapshotCount: 0,
        restoreRequired: false,
        details: detail,
      };
    }

    const policyMatches = this.policyHashMatches(projectId, record.policyHash);
    if (!policyMatches) {
      return {
        ...base,
        state: 'RESTORE_REQUIRED',
        activeRuleCount: 0,
        activePlanId: record.planId,
        activePolicyHash: record.policyHash,
        snapshotCount: summary?.sampleCount ?? 0,
        restoreRequired: true,
        details:
          'Enabled boundary was sealed against a different endpoint policy than the one now active. ' +
          'Disable and re-enable the boundary to re-seal it against the current policy.',
      };
    }

    return {
      ...base,
      state: 'ACTIVE',
      activeRuleCount: record.plan.constraints.length,
      activePlanId: record.planId,
      activePolicyHash: record.policyHash,
      snapshotCount: summary?.sampleCount ?? 0,
      restoreRequired: false,
      details:
        `Process-scoped boundary ACTIVE (${record.plan.constraints.length} constraints). ` +
        `Attribution scope: ${record.monitoredPids.length} process(es)` +
        `${record.attributionComplete ? '' : ' (degraded — root process only)'}. ` +
        `Observed ${summary?.lastSnapshotSockets ?? 0} socket(s) in the last sample, ` +
        `${summary?.violationCount ?? 0} violation(s) total. ` +
        'Host packet filter rules were not modified.',
    };
  }

  // ── Self-test ─────────────────────────────────────────────────────

  /**
   * Establishes the boundary, takes one real measurement, and tears it down.
   *
   * This exists because a process-scoped boundary is only meaningful for the
   * lifetime of the process tree it constrains: a standalone check process
   * cannot inherit an enforcement session from a previous command. Rather than
   * report a boundary it does not hold, preflight proves the mechanism works by
   * exercising it — enabling, measuring, and disabling within one process.
   *
   * If a boundary is ALREADY live in this process, it is measured as-is and left
   * running; a self-test never tears down a real boundary it did not create.
   *
   * Side effects are local and reversible (an observation session and a record
   * that is removed before returning). Host packet filter state is never touched.
   */
  public async selfTest(
    projectId: string = 'default',
    options: Omit<EnableProcessBoundaryOptions, 'confirm' | 'sessionId'> = {},
  ): Promise<ProcessBoundarySelfTestResult> {
    const checkedAt = new Date().toISOString();

    // A live boundary is a better answer than a synthetic one: measure it and
    // leave it alone.
    const existing = this.readRecord(projectId);
    if (existing && this.isEnabled(projectId)) {
      return this.measureRecord(existing, checkedAt);
    }

    // A record whose session has ended is stale; clear it so the self-test can
    // establish a fresh one.
    if (existing) {
      await this.teardownRecord(existing, 'superseded');
    }

    const sessionId = `pbs_selftest_${projectId}_${Date.now()}`;
    const failure = (
      errors: readonly string[],
      extra: Partial<ProcessBoundarySelfTestResult> = {},
    ): ProcessBoundarySelfTestResult => ({
      verified: false,
      projectId,
      sessionId,
      constraintCount: 0,
      monitoredPids: [],
      attributionComplete: false,
      sampleCount: 0,
      observedSocketCount: 0,
      violationCount: 0,
      violations: [],
      hostFirewallModified: false,
      elevationRequired: false,
      errors,
      checkedAt,
      ...extra,
    });

    let enabled: ProcessBoundaryEnableResult;
    try {
      enabled = await this.enable(projectId, {
        confirm: true,
        sessionId,
        // No polling timer: a self-test takes exactly one measurement.
        samplingIntervalMs: 0,
        monitoredPids: options.monitoredPids,
        monitoredProcessNames: options.monitoredProcessNames,
        selfTest: true,
      });
    } catch (err: any) {
      // Roll back anything partially established before reporting failure.
      await this.disableAndDiscardScratchTrace(projectId);
      return failure([err.message]);
    }

    try {
      const record = this.readRecord(projectId);
      if (!record) {
        return failure(['Boundary record disappeared during self-test.']);
      }

      // `enable` is idempotent, so trust the record it actually committed
      // rather than the session ID this call proposed.
      return await this.measureRecord(record, checkedAt);
    } finally {
      // Teardown is best effort; the self-test result already reflects the
      // measurement, and a stale record can never report ACTIVE.
      await this.disableAndDiscardScratchTrace(projectId);
    }
  }

  /**
   * Tears down and removes the observation trace.
   *
   * A self-test observes a process doing no work, so its trace is a mechanism
   * check rather than evidence. Persisting one per invocation would grow
   * `.maos/network-evidence/` without recording anything meaningful, diluting a
   * directory whose contents are supposed to be evidence. Boundaries established
   * for real work (`enable`, `run --enforce-firewall`) keep their traces.
   */
  private async disableAndDiscardScratchTrace(projectId: string): Promise<void> {
    try {
      await this.disable(projectId, {
        confirm: true,
        selfTest: true,
        discardEvidence: true,
      });
    } catch {
      // Best effort: a boundary that cannot be torn down still reports INACTIVE.
    }
  }

  /**
   * Takes one real measurement against a record's live session and reports it.
   * Performs no lifecycle change.
   *
   * A host socket enumeration costs a PowerShell round trip, so a sample taken
   * moments ago is reused rather than re-taken. Without this, callers that enable
   * and immediately measure (preflight) enumerate the whole host twice for the
   * same instant. A stale sample is always re-taken, so the result still
   * describes the present.
   */
  private async measureRecord(
    record: ProcessBoundaryRecord,
    checkedAt: string,
  ): Promise<ProcessBoundarySelfTestResult> {
    const summary = this.networkMonitor?.getActiveObservationSummary(record.sessionId) ?? null;
    const violations: string[] = [];

    const lastSampleAgeMs = summary?.lastSnapshotAt
      ? Date.now() - new Date(summary.lastSnapshotAt).getTime()
      : Number.POSITIVE_INFINITY;
    const sampleIsFresh = lastSampleAgeMs <= FRESH_SAMPLE_MAX_AGE_MS;

    if (this.networkMonitor && !sampleIsFresh) {
      try {
        const snapshot = await this.networkMonitor.captureSnapshot(record.sessionId);
        for (const v of snapshot.violations) violations.push(v.description);
      } catch (err: any) {
        return {
          verified: false,
          projectId: record.projectId,
          sessionId: record.sessionId,
          planId: record.planId,
          planHash: record.planHash,
          policyHash: record.policyHash,
          constraintCount: record.plan.constraints.length,
          monitoredPids: record.monitoredPids,
          attributionComplete: record.attributionComplete,
          attributionReason: record.attributionReason,
          sampleCount: summary?.sampleCount ?? 0,
          observedSocketCount: summary?.lastSnapshotSockets ?? 0,
          violationCount: 0,
          violations: [],
          hostFirewallModified: false,
          elevationRequired: false,
          errors: [`Boundary measurement failed: ${err.message}`],
          checkedAt,
        };
      }
    }

    // With a fresh sample there is nothing to capture: the session-wide violation
    // list already reflects every sample taken, including the enable probe.
    if (violations.length === 0 && sampleIsFresh) {
      violations.push(...(summary?.violationDescriptions ?? []));
    }

    const violationCount = Math.max(violations.length, summary?.violationCount ?? 0);

    const errors: string[] = [];
    if (violationCount > 0) {
      errors.push(
        `Observed ${violationCount} boundary violation(s) in the attributed process scope.`,
      );
    }

    return {
      verified: errors.length === 0,
      projectId: record.projectId,
      sessionId: record.sessionId,
      planId: record.planId,
      planHash: record.planHash,
      policyHash: record.policyHash,
      constraintCount: record.plan.constraints.length,
      monitoredPids: record.monitoredPids,
      attributionComplete: record.attributionComplete,
      attributionReason: record.attributionReason,
      sampleCount: summary?.sampleCount ?? (sampleIsFresh ? 0 : 1),
      observedSocketCount: summary?.lastSnapshotSockets ?? 0,
      violationCount,
      violations,
      hostFirewallModified: false,
      elevationRequired: false,
      errors,
      checkedAt,
    };
  }

  // ── Introspection ─────────────────────────────────────────────────

  public getActivePlan(projectId: string = 'default'): ProcessBoundaryPlan | null {
    return this.readRecord(projectId)?.plan ?? null;
  }

  public getActiveSessionId(projectId: string = 'default'): string | null {
    return this.readRecord(projectId)?.sessionId ?? null;
  }

  public isEnabled(projectId: string = 'default'): boolean {
    const record = this.readRecord(projectId);
    if (!record) return false;
    return this.networkMonitor?.isObservationActive(record.sessionId) ?? false;
  }

  public listEnabledProjectIds(): readonly string[] {
    return Object.keys(this.readStateFile().records);
  }

  /**
   * Verifies that what is recorded matches what is enforced, re-deriving the
   * expected plan from the sealed policy rather than trusting the stored file.
   *
   * This is the process-scope analogue of host rule verification, and unlike the
   * host path it compares canonical plan hashes and constraint sets — not names.
   */
  public verifyEnabledBoundary(projectId: string = 'default'): {
    verified: boolean;
    planHash?: string;
    expectedPlanHash?: string;
    sessionLive: boolean;
    policyMatches: boolean;
    constraintCount: number;
    errors: readonly string[];
  } {
    const errors: string[] = [];
    const record = this.readRecord(projectId);

    if (!record) {
      return {
        verified: false,
        sessionLive: false,
        policyMatches: false,
        constraintCount: 0,
        errors: ['No process boundary record exists for this project.'],
      };
    }

    const validation = validateProcessBoundaryPlan(record.plan);
    if (!validation.valid) {
      errors.push(...validation.errors);
    }

    const recomputed = validation.canonicalHash
      ? validation.canonicalHash
      : computeCanonicalProcessBoundaryPlanHash(record.plan);

    if (record.planHash !== recomputed) {
      errors.push(
        `Recorded plan hash ${record.planHash} does not match the recomputed plan hash ${recomputed}.`,
      );
    }

    let expectedPlanHash: string | undefined;
    try {
      const policy = this.resolvePolicy(projectId);
      const expectedPlan = synthesizeProcessBoundaryPlan(policy, {
        planId: record.planId,
        createdAt: record.plan.createdAt,
        monitoredPids: record.monitoredPids,
        monitoredProcessNames: record.monitoredProcessNames,
      });
      expectedPlanHash = expectedPlan.planHash;
      if (expectedPlanHash !== record.planHash) {
        errors.push(
          `Enforced boundary does not match the boundary re-derived from the sealed policy ` +
            `(recorded ${record.planHash}, expected ${expectedPlanHash}).`,
        );
      }
    } catch (err: any) {
      errors.push(`Could not re-derive expected boundary plan: ${err.message}`);
    }

    const sessionLive = this.networkMonitor?.isObservationActive(record.sessionId) ?? false;
    if (!sessionLive) {
      errors.push('Observation session is not running; the boundary is not enforced.');
    }

    const policyMatches = this.policyHashMatches(projectId, record.policyHash);
    if (!policyMatches) {
      errors.push('Recorded policy hash does not match the currently sealed policy.');
    }

    return {
      verified: errors.length === 0,
      planHash: record.planHash,
      expectedPlanHash,
      sessionLive,
      policyMatches,
      constraintCount: record.plan.constraints.length,
      errors,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────

  private resolvePolicy(projectId: string) {
    if (!this.endpointAllowlist) {
      throw new ProcessBoundaryError(
        PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
        'Cannot resolve endpoint policy: EndpointAllowlistService is not configured.',
      );
    }

    const policy = this.endpointAllowlist.getActivePolicy(projectId);
    const validation = validateEndpointPolicy(policy, { expectedProjectId: projectId });
    if (!validation.valid) {
      throw new ProcessBoundaryError(
        PROCESS_BOUNDARY_ERROR_CODES.PROCESS_BOUNDARY_POLICY_INVALID,
        `Active endpoint policy for project "${projectId}" is invalid: ${validation.errors.join('; ')}`,
        { errors: validation.errors },
      );
    }

    return policy;
  }

  private policyHashMatches(projectId: string, recordedPolicyHash: string): boolean {
    try {
      const policy = this.resolvePolicy(projectId);
      return policy.policyHash === recordedPolicyHash;
    } catch {
      return false;
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.boundaryDir)) {
      fs.mkdirSync(this.boundaryDir, { recursive: true });
    }
  }

  /**
   * Registers this instance for exit-time record cleanup.
   *
   * A single shared `process.on('exit')` listener serves every instance. A
   * listener per instance would accumulate — one per container built in a process
   * — and eventually trip Node's max-listeners warning, which for a service that
   * may be constructed many times in a long-lived host is a real leak, not a
   * cosmetic one.
   */
  private registerExitHook(): void {
    boundaryRecordHolders.add(this);

    if (sharedExitHookInstalled) return;
    sharedExitHookInstalled = true;

    process.on('exit', () => {
      for (const holder of boundaryRecordHolders) {
        try {
          holder.releaseRecordsOwnedByThisProcessSync();
        } catch {
          // Never let cleanup interfere with process exit.
        }
      }
    });
  }

  private unregisterExitHook(): void {
    if (!this.ownsAnyRecord()) {
      boundaryRecordHolders.delete(this);
    }
  }

  private ownsAnyRecord(): boolean {
    try {
      const state = this.readStateFile();
      return Object.values(state.records).some(
        (record) => record.holderPid === process.pid,
      );
    } catch {
      return false;
    }
  }

  /**
   * Synchronously drops records this process owns. Written synchronously because
   * async work does not run during process exit.
   */
  private releaseRecordsOwnedByThisProcessSync(): void {
    const state = this.readStateFile();
    const projectIds = Object.keys(state.records);
    if (projectIds.length === 0) return;

    // Only clear records this process actually owns; a record committed by a
    // long-lived host must not be destroyed by an unrelated short-lived CLI.
    const remaining: Record<string, ProcessBoundaryRecord> = {};
    for (const [projectId, record] of Object.entries(state.records)) {
      if (record.holderPid === process.pid) continue;
      remaining[projectId] = record;
    }

    if (Object.keys(remaining).length !== projectIds.length) {
      fs.writeFileSync(
        this.recordPath,
        JSON.stringify({ ...state, records: remaining }, null, 2),
        'utf8',
      );
    }
  }

  private readStateFile(): ProcessBoundaryStateFile {
    if (fs.existsSync(this.recordPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.records) {
          return parsed as ProcessBoundaryStateFile;
        }
      } catch {
        // Corrupt record file: treat as no boundary rather than crashing. A
        // corrupt record can never report ACTIVE, so this fails closed.
      }
    }
    return { schemaVersion: 1, records: {} };
  }

  private readRecord(projectId: string): ProcessBoundaryRecord | null {
    return this.readStateFile().records[projectId] || null;
  }

  private writeRecord(record: ProcessBoundaryRecord): void {
    this.ensureDir();
    const state = this.readStateFile();
    state.records[record.projectId] = record;
    fs.writeFileSync(this.recordPath, JSON.stringify(state, null, 2), 'utf8');
  }

  private deleteRecord(projectId: string): void {
    const state = this.readStateFile();
    if (!state.records[projectId]) return;
    delete state.records[projectId];
    this.ensureDir();
    fs.writeFileSync(this.recordPath, JSON.stringify(state, null, 2), 'utf8');
    this.unregisterExitHook();
  }

  private toEnableResult(
    record: ProcessBoundaryRecord,
    alreadyActive: boolean,
  ): ProcessBoundaryEnableResult {
    return {
      success: true,
      projectId: record.projectId,
      sessionId: record.sessionId,
      planId: record.planId,
      planHash: record.planHash,
      policyHash: record.policyHash,
      constraintCount: record.plan.constraints.length,
      monitoredPids: record.monitoredPids,
      attributionComplete: record.attributionComplete,
      attributionReason: record.attributionReason,
      hostFirewallModified: false,
      elevationRequired: false,
      enabledAt: record.startedAt,
      alreadyActive,
    };
  }

  private audit(projectId: string, data: Record<string, unknown>): void {
    if (!this.auditService) return;
    try {
      this.auditService.recordAuditEvent({
        category: 'endpoint',
        source: 'process-boundary',
        data: { projectId, ...data },
      });
    } catch {
      // Fail-safe: audit must never break boundary lifecycle.
    }
  }
}
