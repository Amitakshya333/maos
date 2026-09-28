/**
 * F9-04: Process-Attributed Network Monitor Service
 *
 * Implements real-time passive socket observation, process attribution,
 * allowlist and boundary correlation, anomaly/violation detection,
 * canonical trace generation, and privacy-safe audit logging.
 *
 * Guarantees:
 * 1. Passive only: zero live network socket modification or disruption.
 * 2. Strict epistemic honesty: rejects unmeasured or absolute claims.
 * 3. Fail-closed: detects non-loopback connections or unauthorized binds.
 * 4. Deterministic evidence bundles: persisted and cryptographically hashed.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import type { SovereigntyBoundaryService } from './sovereignty-boundary-service';
import {
  SocketObserverAdapter,
  SupportedNetworkPlatform,
  createPlatformSocketObserver,
} from '../industrial/network';
import {
  ObservedSocket,
  NetworkViolation,
  NetworkViolationType,
  NetworkObservationSnapshot,
  NetworkObservationSummary,
  NetworkObservationTrace,
  ObservationOptions,
  NetworkMonitorError,
  NETWORK_MONITOR_ERROR_CODES,
  evaluateObservedSocket,
  generateStandardMeasuredClaim,
  assertMeasuredObservationClaims,
  computeCanonicalObservationTraceHash,
  validateObservationTrace,
  TraceValidationResult,
  SocketEvaluationContext,
} from '../domain/network-monitor';
import {
  EndpointAllowlistPolicy,
  createIndustrialEndpointPolicy,
  computeCanonicalPolicyHash,
} from '../domain/endpoint-allowlist';
import {
  SovereigntyBoundary,
  createIndustrialSovereigntyBoundary,
  computeCanonicalBoundaryHash,
  STANDARD_OBSERVATION_LIMITATIONS,
} from '../domain/sovereignty-boundary';

export interface NetworkMonitorServiceOptions {
  readonly auditService?: AuditService;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly sovereigntyBoundary?: SovereigntyBoundaryService;
  readonly adapter?: SocketObserverAdapter;
  readonly platformOverride?: SupportedNetworkPlatform;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly startedAt: string;
  readonly options: ObservationOptions;
  readonly policy: EndpointAllowlistPolicy;
  readonly boundary: SovereigntyBoundary;
  readonly samples: NetworkObservationSnapshot[];
  readonly allViolations: NetworkViolation[];
  timer?: NodeJS.Timeout;
}

/** Cap on violation descriptions carried in a live observation summary. */
const MAX_SUMMARY_VIOLATION_DESCRIPTIONS = 25;

export class NetworkMonitorService {
  private readonly evidenceDir: string;
  private readonly adapter: SocketObserverAdapter;
  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly sovereigntyBoundary?: SovereigntyBoundaryService;

  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(
    private readonly projectRoot: string,
    options: NetworkMonitorServiceOptions = {},
  ) {
    this.evidenceDir = path.join(this.projectRoot, '.maos', 'network-evidence');
    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.sovereigntyBoundary = options.sovereigntyBoundary;
    this.adapter =
      options.adapter || createPlatformSocketObserver(options.platformOverride);

    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.evidenceDir)) {
      fs.mkdirSync(this.evidenceDir, { recursive: true });
    }
  }

  /**
   * Starts a new passive socket observation session.
   * Resolves active endpoint policy and boundary, captures baseline sample,
   * sets up polling if configured, and logs an audit start event.
   */
  public async startObservation(
    sessionId: string,
    projectId: string,
    options: ObservationOptions = {},
  ): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.OBSERVATION_ALREADY_ACTIVE,
        `An observation session with ID "${sessionId}" is already active.`,
        { sessionId },
      );
    }

    // 1. Resolve Policy
    let policy: EndpointAllowlistPolicy | undefined;
    if (this.endpointAllowlist) {
      policy = this.endpointAllowlist.getActivePolicy(projectId);
    }
    if (!policy) {
      policy = createIndustrialEndpointPolicy(projectId);
    }

    // 2. Resolve Boundary
    let boundary: SovereigntyBoundary | undefined;
    if (this.sovereigntyBoundary) {
      boundary = this.sovereigntyBoundary.getActiveBoundary(projectId);
    }
    if (!boundary) {
      boundary = createIndustrialSovereigntyBoundary(projectId);
    }

    const session: ActiveSession = {
      sessionId,
      projectId,
      startedAt: new Date().toISOString(),
      options,
      policy,
      boundary,
      samples: [],
      allViolations: [],
    };

    // 3. Capture baseline snapshot
    await this.captureSnapshotInternal(session);

    // 4. Setup periodic sampling if interval specified
    if (options.samplingIntervalMs && options.samplingIntervalMs > 0) {
      session.timer = setInterval(() => {
        this.captureSnapshotInternal(session).catch((err) => {
          // Keep background polling resilient
        });
      }, options.samplingIntervalMs);

      if (typeof session.timer.unref === 'function') {
        session.timer.unref();
      }
    }

    this.activeSessions.set(sessionId, session);

    // 5. Audit log
    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'network-monitor',
          data: {
            event: 'NETWORK_OBSERVATION_STARTED',
            sessionId,
            projectId,
            samplingIntervalMs: options.samplingIntervalMs,
            monitoredPids: options.monitoredPids,
            monitoredProcessNames: options.monitoredProcessNames,
            policyHash: policy.policyHash || computeCanonicalPolicyHash(policy),
            boundaryHash: boundary.boundaryHash || computeCanonicalBoundaryHash(boundary),
          },
        });
      } catch {
        // Continue even if audit fails
      }
    }
  }

  /**
   * Captures a live snapshot of sockets for an active session.
   */
  public async captureSnapshot(sessionId?: string): Promise<NetworkObservationSnapshot> {
    const session = this.resolveActiveSession(sessionId);
    return this.captureSnapshotInternal(session);
  }

  private resolveActiveSession(sessionId?: string): ActiveSession {
    if (sessionId) {
      const s = this.activeSessions.get(sessionId);
      if (!s) {
        throw new NetworkMonitorError(
          NETWORK_MONITOR_ERROR_CODES.NO_ACTIVE_OBSERVATION,
          `No active observation session found for ID "${sessionId}".`,
          { sessionId },
        );
      }
      return s;
    }

    if (this.activeSessions.size === 1) {
      return this.activeSessions.values().next().value!;
    }

    if (this.activeSessions.size === 0) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.NO_ACTIVE_OBSERVATION,
        'No active network observation sessions currently running.',
      );
    }

    throw new NetworkMonitorError(
      NETWORK_MONITOR_ERROR_CODES.NO_ACTIVE_OBSERVATION,
      `Multiple observation sessions active (${this.activeSessions.size}). You must specify a sessionId.`,
    );
  }

  private async captureSnapshotInternal(
    session: ActiveSession,
  ): Promise<NetworkObservationSnapshot> {
    const rawSockets = await this.adapter.captureActiveSockets();
    const enrichedSockets: ObservedSocket[] = [];
    const snapshotViolations: NetworkViolation[] = [];

    const evalCtx: SocketEvaluationContext = {
      monitoredPids: session.options.monitoredPids
        ? new Set(session.options.monitoredPids)
        : undefined,
      monitoredProcessNames: session.options.monitoredProcessNames
        ? new Set(session.options.monitoredProcessNames.map((n) => n.toLowerCase()))
        : undefined,
      strictPorts: true,
    };

    let loopbackCount = 0;
    let nonLoopbackCount = 0;

    /**
     * Metadata resolution spawns a PowerShell query per PID. On a host with a
     * normal number of sockets that is hundreds of subprocesses per sample, so it
     * is restricted to sockets inside the attribution scope.
     *
     * This is also the privacy-correct behaviour: the monitor should not be
     * resolving executable paths for unrelated processes on the machine, and
     * sockets outside the scope are never evaluated anyway
     * (`evaluateObservedSocket` skips them).
     */
    const isInScope = (pid: number, processName?: string): boolean => {
      if (!evalCtx.monitoredPids && !evalCtx.monitoredProcessNames) return true;
      if (evalCtx.monitoredPids?.has(pid)) return true;
      if (processName && evalCtx.monitoredProcessNames?.has(processName.toLowerCase())) {
        return true;
      }
      return false;
    };

    for (const raw of rawSockets) {
      let enriched = { ...raw };

      // Resolve metadata if missing, and only for sockets we actually attribute.
      if (
        !enriched.processName &&
        this.adapter.resolveProcessMetadata &&
        isInScope(enriched.pid, enriched.processName)
      ) {
        try {
          const meta = await this.adapter.resolveProcessMetadata(enriched.pid);
          if (meta) {
            enriched = {
              ...enriched,
              processName: meta.processName || enriched.processName,
              executablePath: meta.executablePath || enriched.executablePath,
              executableHash: meta.executableHash || enriched.executableHash,
            };
          }
        } catch {
          // Graceful fallback
        }
      }

      enrichedSockets.push(enriched);

      // Evaluate socket against policy
      const violation = evaluateObservedSocket(
        enriched,
        session.policy,
        session.boundary,
        evalCtx,
      );

      if (violation) {
        snapshotViolations.push(violation);
        session.allViolations.push(violation);

        if (this.auditService) {
          try {
            this.auditService.recordAuditEvent({
              category: 'endpoint',
              source: 'network-monitor',
              data: {
                event: 'NETWORK_ANOMALY_DETECTED',
                sessionId: session.sessionId,
                violationId: violation.violationId,
                violationType: violation.type,
                severity: violation.severity,
                pid: violation.pid,
                processName: violation.processName,
                description: violation.description,
                projectId: session.projectId,
              },
            });
          } catch {
            // Ignore audit recording failure
          }
        }
      }

      if (enriched.remoteAddress) {
        const isLp =
          enriched.remoteAddress === '127.0.0.1' ||
          enriched.remoteAddress === '::1' ||
          enriched.remoteAddress.startsWith('127.');
        if (isLp) {
          loopbackCount++;
        } else {
          nonLoopbackCount++;
        }
      } else {
        const isLp =
          enriched.localAddress === '127.0.0.1' ||
          enriched.localAddress === '::1' ||
          enriched.localAddress.startsWith('127.');
        if (isLp) {
          loopbackCount++;
        } else {
          nonLoopbackCount++;
        }
      }
    }

    const snapshot: NetworkObservationSnapshot = {
      snapshotId: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      totalSockets: enrichedSockets.length,
      loopbackSockets: loopbackCount,
      nonLoopbackSockets: nonLoopbackCount,
      sockets: enrichedSockets,
      violations: snapshotViolations,
    };

    session.samples.push(snapshot);

    // Fail-fast if violation detected and configured
    if (snapshotViolations.length > 0 && session.options.failFastOnViolation) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.NETWORK_VIOLATION_DETECTED,
        `Network boundary violation detected in session "${session.sessionId}": ${snapshotViolations[0].description}`,
        { violation: snapshotViolations[0] },
      );
    }

    return snapshot;
  }

  /**
   * Stops an active observation session, clears polling timers,
   * compiles the summary and measured claims, hashes the trace canonically,
   * persists it to `.maos/network-evidence/<sessionId>.json`, and logs audit records.
   */
  public async stopObservation(sessionId: string): Promise<NetworkObservationTrace> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.NO_ACTIVE_OBSERVATION,
        `Cannot stop observation: no active session found for ID "${sessionId}".`,
        { sessionId },
      );
    }

    // 1. Clear timer
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = undefined;
    }

    // 2. Final snapshot
    try {
      await this.captureSnapshotInternal(session);
    } catch (err: any) {
      // If failFast threw, capture what we have
    }

    // 3. Compile Summary
    const totalSamples = session.samples.length;
    const totalSocketsObserved = session.samples.reduce((acc, s) => acc + s.totalSockets, 0);
    const violationsCount = session.allViolations.length;
    const violationTypes = Array.from(
      new Set(session.allViolations.map((v) => v.type)),
    ) as NetworkViolationType[];
    const allObservedLoopback =
      session.allViolations.filter(
        (v) => v.type === 'NON_LOOPBACK_CONNECTION_DETECTED',
      ).length === 0;

    const monitoredPidSet = new Set(session.options.monitoredPids || []);
    const monitoredNameSet = new Set(
      (session.options.monitoredProcessNames || []).map((n) => n.toLowerCase()),
    );

    let trackedCount = 0;
    let untrackedCount = 0;

    for (const snap of session.samples) {
      for (const sock of snap.sockets) {
        const isTracked =
          monitoredPidSet.has(sock.pid) ||
          (sock.processName && monitoredNameSet.has(sock.processName.toLowerCase()));
        if (isTracked) {
          trackedCount++;
        } else {
          untrackedCount++;
        }
      }
    }

    const summary: NetworkObservationSummary = {
      allObservedLoopback,
      totalSocketsObserved,
      totalSamples,
      trackedProcessSocketsCount: trackedCount,
      untrackedProcessSocketsCount: untrackedCount,
      violationsCount,
      violationTypes,
      monitoredPids: session.options.monitoredPids || [],
    };

    // 4. Claims formulation & verification
    const standardClaim = generateStandardMeasuredClaim(summary);
    const claims = Object.freeze([standardClaim]);
    assertMeasuredObservationClaims(claims);

    const policyHash =
      session.policy.policyHash || computeCanonicalPolicyHash(session.policy);
    const boundaryHash =
      session.boundary.boundaryHash || computeCanonicalBoundaryHash(session.boundary);

    const stoppedAt = new Date().toISOString();

    const tracePayload: Omit<NetworkObservationTrace, 'traceHash'> = {
      schemaVersion: 1,
      traceId: `trace_${session.sessionId}_${Date.now()}`,
      sessionId: session.sessionId,
      projectId: session.projectId,
      startedAt: session.startedAt,
      stoppedAt,
      policyHash,
      boundaryHash,
      summary,
      samples: session.samples,
      violations: session.allViolations,
      observationLimitations:
        session.boundary.observationLimitations || STANDARD_OBSERVATION_LIMITATIONS,
      claims,
    };

    const traceHash = computeCanonicalObservationTraceHash(tracePayload);
    const fullTrace: NetworkObservationTrace = Object.freeze({
      ...tracePayload,
      traceHash,
    });

    // 5. Persist to disk
    this.ensureDirectory();
    const traceFilePath = path.join(this.evidenceDir, `${session.sessionId}.json`);
    fs.writeFileSync(traceFilePath, JSON.stringify(fullTrace, null, 2), 'utf-8');

    // 6. Audit log
    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'network-monitor',
          data: {
            event: 'NETWORK_OBSERVATION_STOPPED',
            sessionId: session.sessionId,
            traceHash,
            violationsCount,
            allObservedLoopback,
            totalSamples,
            totalSocketsObserved,
            projectId: session.projectId,
          },
        });
      } catch {
        // Continue
      }
    }

    // 7. Cleanup active session
    this.activeSessions.delete(sessionId);

    return fullTrace;
  }

  /**
   * Loads a persisted observation trace from disk.
   */
  public getObservationTrace(sessionId: string): NetworkObservationTrace {
    const traceFilePath = path.join(this.evidenceDir, `${sessionId}.json`);
    if (!fs.existsSync(traceFilePath)) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.NO_ACTIVE_OBSERVATION,
        `No persisted observation trace found for session ID "${sessionId}".`,
        { sessionId, traceFilePath },
      );
    }

    const content = fs.readFileSync(traceFilePath, 'utf-8');
    const parsed = JSON.parse(content) as NetworkObservationTrace;

    const validation = validateObservationTrace(parsed);
    if (!validation.valid) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.OBSERVATION_TAMPERED,
        `Persisted observation trace for session "${sessionId}" is invalid or tampered: ${validation.errors.join('; ')}`,
        { errors: validation.errors },
      );
    }

    return parsed;
  }

  /**
   * Verifies the cryptographic integrity, schema, and epistemic claims of a trace.
   */
  public verifyObservationTrace(trace: NetworkObservationTrace): TraceValidationResult {
    return validateObservationTrace(trace);
  }

  public isObservationActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  public listActiveObservations(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Live, non-destructive summary of an active observation session.
   *
   * Exists so boundary reporting can state what was *actually* observed —
   * how many sockets, under what attribution scope, with how many violations —
   * rather than inferring activity from the mere existence of a session.
   */
  public getActiveObservationSummary(sessionId: string): {
    sessionId: string;
    projectId: string;
    startedAt: string;
    sampleCount: number;
    violationCount: number;
    /** Most recent violation descriptions, newest last. Capped for memory. */
    violationDescriptions: readonly string[];
    lastSnapshotAt?: string;
    lastSnapshotSockets: number;
    lastSnapshotViolations: number;
    monitoredPidCount: number;
    monitoredProcessNames: readonly string[];
  } | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;

    const last = session.samples[session.samples.length - 1];

    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      startedAt: session.startedAt,
      sampleCount: session.samples.length,
      violationCount: session.allViolations.length,
      violationDescriptions: session.allViolations
        .slice(-MAX_SUMMARY_VIOLATION_DESCRIPTIONS)
        .map((v) => v.description),
      lastSnapshotAt: last?.timestamp,
      lastSnapshotSockets: last?.totalSockets ?? 0,
      lastSnapshotViolations: last?.violations.length ?? 0,
      monitoredPidCount: session.options.monitoredPids?.length ?? 0,
      monitoredProcessNames: session.options.monitoredProcessNames ?? [],
    };
  }

  /**
   * Interrupts and halts all active observation sessions immediately.
   * Clears all running timers and flushes partial traces to disk.
   */
  public async interruptAll(reason = 'Emergency interruption / shutdown'): Promise<NetworkObservationTrace[]> {
    const traces: NetworkObservationTrace[] = [];
    const sessionIds = this.listActiveObservations();
    for (const sessionId of sessionIds) {
      try {
        const trace = await this.stopObservation(sessionId);
        traces.push(trace);
      } catch {
        // Fallback: forcefully clear timer and purge session
        const session = this.activeSessions.get(sessionId);
        if (session?.timer) {
          clearInterval(session.timer);
          session.timer = undefined;
        }
        this.activeSessions.delete(sessionId);
      }
    }
    return traces;
  }
}
