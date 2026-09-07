/**
 * MAOS Runtime Stats Store
 *
 * Tracks per-runtime execution statistics for adaptive scheduling.
 *
 * Three data flows:
 *   1. Bootstrap — reads .maos/telemetry/runs.jsonl on startup to seed
 *      historical stats (so the scheduler starts informed, not blind).
 *
 *   2. Live updates — orchestrator calls updateAfterTask() after every
 *      task completion or failure. Stats are recalculated incrementally.
 *
 *   3. Cooldown — after RUNTIME_CRASHED, the runtime is placed on cooldown
 *      for a configurable duration. The router reads isOnCooldown() and
 *      applies a heavy scheduling penalty during that window.
 *
 * Persistence: .maos/runtime-stats.json (atomic temp-file rename).
 * Format: { updatedAt, stats: RuntimeStats[] }
 *
 * NOTE: mutationRate is stored but ONLY consulted by the router when the
 * task being routed is mutation-heavy. Analysis/planning tasks must never
 * be penalized for a runtime's low mutation rate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readTelemetry, TelemetryRecord } from './telemetry';
import { RuntimeResult } from '../backends/runtime';

// ─── Types ─────────────────────────────────────────────────────

export interface RuntimeStats {
  /** Agent ID this record belongs to */
  runtimeId: string;

  /** Total tasks attempted */
  totalRuns: number;

  /** Tasks that completed successfully */
  successCount: number;

  /** Tasks that failed (non-crash) */
  failureCount: number;

  /** Tasks that ended with RUNTIME_CRASHED / exitCode -1 */
  crashCount: number;

  /**
   * Fraction of tasks where filesChanged.length > 0.
   * NOTE: only meaningful for mutation-heavy workloads.
   * Do not use this to penalise runtimes on analysis tasks.
   */
  mutationRate: number;

  /** Rolling average latency across all completed tasks (ms) */
  avgLatencyMs: number;

  /** Rolling average cost per task (USD) */
  avgCostPerTask: number;

  /** Derived: crashCount / totalRuns (0.0–1.0) */
  crashRate: number;

  /** Derived: successCount / totalRuns (0.0–1.0) */
  successRate: number;

  /** Epoch ms of last successful task (null = never) */
  lastSuccessAt: number | null;

  /** Epoch ms of last failed task (null = never) */
  lastFailureAt: number | null;

  /** Epoch ms of last crash (null = never) */
  lastCrashAt: number | null;

  /**
   * Epoch ms until which this runtime is on cooldown.
   * null = not on cooldown.
   * During cooldown, the router applies SCORING_WEIGHTS.cooldownPenalty.
   */
  cooldownUntil: number | null;

  /** Number of times cooldown was applied */
  cooldownCount: number;
}

// ─── Defaults ──────────────────────────────────────────────────

function blankStats(runtimeId: string): RuntimeStats {
  return {
    runtimeId,
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    crashCount: 0,
    mutationRate: 0,
    avgLatencyMs: 0,
    avgCostPerTask: 0,
    crashRate: 0,
    successRate: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastCrashAt: null,
    cooldownUntil: null,
    cooldownCount: 0,
  };
}

// ─── RuntimeStatsStore ─────────────────────────────────────────

export class RuntimeStatsStore {
  private stats = new Map<string, RuntimeStats>();
  private statsFile: string;

  constructor(private projectRoot: string) {
    this.statsFile = path.join(projectRoot, '.maos', 'runtime-stats.json');
    this.loadFromDisk();
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Get stats for a runtime. Returns blank record if unknown.
   */
  getStats(runtimeId: string): RuntimeStats {
    if (!this.stats.has(runtimeId)) {
      this.stats.set(runtimeId, blankStats(runtimeId));
    }
    return this.stats.get(runtimeId)!;
  }

  /**
   * Get all known runtime stats (for dashboard / logging).
   */
  getAllStats(): RuntimeStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * Returns true if the runtime is currently on scheduling cooldown.
   */
  isOnCooldown(runtimeId: string): boolean {
    const s = this.stats.get(runtimeId);
    if (!s || s.cooldownUntil === null) return false;
    return Date.now() < s.cooldownUntil;
  }

  /**
   * Remaining cooldown in ms (0 if not on cooldown).
   */
  cooldownRemainingMs(runtimeId: string): number {
    const s = this.stats.get(runtimeId);
    if (!s || s.cooldownUntil === null) return 0;
    return Math.max(0, s.cooldownUntil - Date.now());
  }

  /**
   * Place a runtime on scheduling cooldown.
   * Called by the orchestrator after RUNTIME_CRASHED.
   * @param durationMs  How long to penalise (default: 120s).
   */
  applyCooldown(runtimeId: string, durationMs = 120_000): void {
    const s = this.getOrCreate(runtimeId);
    s.cooldownUntil = Date.now() + durationMs;
    s.cooldownCount++;
    s.lastCrashAt = Date.now();
    s.crashCount++;
    this.recalcRates(s);
    this.persistToDisk();
  }

  /**
   * Update stats after a task completes (success or failure).
   *
   * @param runtimeId   Agent ID
   * @param result      RuntimeResult from runtime.execute()
   * @param isCrash     True when the task ended via RUNTIME_CRASHED
   */
  updateAfterTask(runtimeId: string, result: RuntimeResult, isCrash = false): void {
    const s = this.getOrCreate(runtimeId);
    const now = Date.now();

    s.totalRuns++;

    if (isCrash) {
      s.crashCount++;
      s.failureCount++;
      s.lastCrashAt = now;
      s.lastFailureAt = now;
    } else if (result.success) {
      s.successCount++;
      s.lastSuccessAt = now;
    } else {
      s.failureCount++;
      s.lastFailureAt = now;
    }

    // Rolling avg latency (weighted toward recent)
    const alpha = 0.2; // blend factor — recent tasks weighted at 20%
    if (s.avgLatencyMs === 0) {
      s.avgLatencyMs = result.latencyMs;
    } else {
      s.avgLatencyMs = s.avgLatencyMs * (1 - alpha) + result.latencyMs * alpha;
    }

    // Rolling avg cost
    if (s.avgCostPerTask === 0) {
      s.avgCostPerTask = result.costUSD;
    } else {
      s.avgCostPerTask = s.avgCostPerTask * (1 - alpha) + result.costUSD * alpha;
    }

    // mutationRate: rolling average of (filesChanged > 0)
    const mutated = result.filesChanged.length > 0 ? 1 : 0;
    if (s.totalRuns === 1) {
      s.mutationRate = mutated;
    } else {
      s.mutationRate = s.mutationRate * (1 - alpha) + mutated * alpha;
    }

    this.recalcRates(s);
    this.persistToDisk();
  }

  /**
   * Seed stats from existing telemetry records (run on startup).
   * This bootstraps the stats store from historical data so routing
   * is informed from the first dispatch, not the 10th.
   */
  loadFromTelemetry(): void {
    const records = readTelemetry(this.projectRoot);
    if (records.length === 0) return;

    // Group by agentId
    const byAgent = new Map<string, TelemetryRecord[]>();
    for (const r of records) {
      if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []);
      byAgent.get(r.agentId)!.push(r);
    }

    for (const [agentId, agentRecords] of byAgent) {
      // Only seed if we have no live data yet (don't overwrite live tracking)
      if (this.stats.has(agentId) && this.stats.get(agentId)!.totalRuns > 0) continue;

      const s = this.getOrCreate(agentId);
      s.totalRuns = agentRecords.length;

      const successes = agentRecords.filter((r) => r.success);
      const crashes = agentRecords.filter((r) => r.exitCode === -1);
      const failures = agentRecords.filter((r) => !r.success);
      const mutations = agentRecords.filter((r) => (r.filesChanged?.length ?? 0) > 0);

      s.successCount = successes.length;
      s.failureCount = failures.length;
      s.crashCount = crashes.length;
      s.mutationRate = agentRecords.length > 0 ? mutations.length / agentRecords.length : 0;

      const latencies = agentRecords.map((r) => r.latencyMs).filter((l) => l > 0);
      s.avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

      const costs = agentRecords.map((r) => r.costUSD).filter((c) => c > 0);
      s.avgCostPerTask = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;

      // Find most recent timestamps
      const sorted = [...agentRecords].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const lastSuccess = sorted.find((r) => r.success);
      const lastFailure = sorted.find((r) => !r.success);
      s.lastSuccessAt = lastSuccess ? new Date(lastSuccess.timestamp).getTime() : null;
      s.lastFailureAt = lastFailure ? new Date(lastFailure.timestamp).getTime() : null;

      this.recalcRates(s);
    }

    this.persistToDisk();
  }

  // ── Persistence ──────────────────────────────────────────────

  persistToDisk(): void {
    try {
      const payload = {
        updatedAt: Date.now(),
        stats: Array.from(this.stats.values()),
      };
      const tmp = this.statsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, this.statsFile);
    } catch {
      // Non-fatal: routing will fall back to default weights
    }
  }

  loadFromDisk(): void {
    if (!fs.existsSync(this.statsFile)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
      for (const s of payload.stats ?? []) {
        this.stats.set(s.runtimeId, s as RuntimeStats);
      }
    } catch {
      // Corrupted or missing — start fresh
    }
  }

  // ── Internal helpers ──────────────────────────────────────────

  private getOrCreate(runtimeId: string): RuntimeStats {
    if (!this.stats.has(runtimeId)) {
      this.stats.set(runtimeId, blankStats(runtimeId));
    }
    return this.stats.get(runtimeId)!;
  }

  private recalcRates(s: RuntimeStats): void {
    s.crashRate = s.totalRuns > 0 ? s.crashCount / s.totalRuns : 0;
    s.successRate = s.totalRuns > 0 ? s.successCount / s.totalRuns : 0;
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _store: RuntimeStatsStore | null = null;

export function createRuntimeStatsStore(projectRoot: string): RuntimeStatsStore {
  _store = new RuntimeStatsStore(projectRoot);
  return _store;
}

export function getRuntimeStatsStore(): RuntimeStatsStore | null {
  return _store;
}
