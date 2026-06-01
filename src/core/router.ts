/**
 * MAOS Capability-Based Routing Engine (Adaptive)
 *
 * The router decides which agent handles which task.
 * It scores agents based on:
 *   - Capability match (does the agent have the skills the task needs?)
 *   - Role alignment (is the agent's role suited for this task category?)
 *   - Cost efficiency (prefer cheaper models when capable)
 *   - Complexity matching (route hard tasks to powerful models)
 *   - Historical performance (ADAPTIVE: learns from telemetry)
 *   - Recency (distributes tasks across equally-capable agents)
 *
 * P3.2: The router now reads telemetry data and builds a performance
 * matrix per agent. Agents that historically succeed on certain
 * capability types get boosted; agents that fail get penalized.
 * This creates a self-improving routing loop.
 *
 * P3.3: Persistent dispatch history — the recency penalty is now
 * persisted to disk so it survives across restarts and maos plan
 * invocations, ensuring tasks are spread across all agents.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readTelemetry, TelemetryRecord } from './telemetry';
import { RuntimeStats } from './runtime-stats';
import { AgentHealthBase } from './health-monitor';

// ─── Types ────────────────────────────────────────────────────

export interface TaskRequirements {
  /** Required capabilities for this task */
  capabilities: string[];
  /** Task complexity: low, medium, high */
  complexity: 'low' | 'medium' | 'high';
  /** Task category for role matching */
  category: string;
  /** Specific agent requested (empty or 'AUTO' = let router decide) */
  targetAgent: string;
}

export interface AgentProfile {
  id: string;
  role: string;
  provider: string;
  model: string;
  capabilities: string[];
  costTier: string;
  maxIterations: number;
  /** Is this agent currently idle? */
  idle: boolean;
  /** Is this agent enabled in the pool? */
  enabled: boolean;
  /** Live runtime stats (optional — from RuntimeStatsStore) */
  runtimeStats?: RuntimeStats;
  /** Current health state from HealthMonitor (optional) */
  healthState?: AgentHealthBase;
  /** How many tasks this agent is currently running (for load penalty) */
  activeTasks?: number;
}

export interface RoutingConfig {
  strategy: 'capability_score' | 'round_robin' | 'cheapest_first' | 'best_model';
  costWeight: number;
  capabilityWeight: number;
}

export interface RoutingDecision {
  agentId: string;
  score: number;
  reasoning: string[];
  /** Breakdown of score components */
  breakdown: {
    capabilityScore:  number;
    roleBonus:        number;
    costPenalty:      number;
    complexityBonus:  number;
    // Runtime-aware terms (zero when runtimeContext not provided)
    healthBonus:      number;
    crashPenalty:     number;
    cooldownPenalty:  number;
    loadPenalty:      number;
    mutationPenalty:  number;  // non-zero only for mutation-heavy tasks
  };
}

// ─── Constants ────────────────────────────────────────────────

const COST_TIERS: Record<string, number> = {
  free: 0,
  low: 2,
  medium: 5,
  high: 10,
  premium: 15,
};

/** Role → category affinity map */
const ROLE_CATEGORY_AFFINITY: Record<string, string[]> = {
  planner: ['planning', 'architecture', 'decomposition', 'review', 'reasoning'],
  coder: ['coding', 'backend', 'frontend', 'api', 'database', 'refactoring', 'testing', 'debugging', 'styling', 'css', 'layout'],
  designer: ['design', 'frontend', 'ui', 'ux', 'css', 'styling', 'layout'],
  tester: ['testing', 'qa', 'e2e', 'integration', 'unit'],
  devops: ['deployment', 'ci', 'docker', 'infrastructure', 'monitoring'],
};

/** Complexity → minimum cost tier mapping (guides routing hard tasks to better models) */
const COMPLEXITY_MIN_TIER: Record<string, number> = {
  low: 0,     // Any model is fine
  medium: 2,  // Prefer at least "low" tier
  high: 5,    // Prefer at least "medium" tier
};

/**
 * Task categories that are considered mutation-heavy.
 * ONLY for these categories does the router apply mutationPenalty.
 * Analysis, planning, diagnostics, and replay tasks are intentionally
 * excluded — a low mutation rate on those is CORRECT, not a flaw.
 */
const MUTATION_HEAVY_CATEGORIES = new Set([
  'coding', 'feature', 'refactoring', 'backend', 'frontend', 'api',
  'database', 'migration', 'scaffolding', 'implementation',
]);

/**
 * Centralized scoring weights.
 * ALL numeric score constants live here — no scattered magic numbers.
 * These can be overridden at Router construction time via scoringWeights option.
 */
export interface ScoringWeights {
  /** Boost for HEALTHY runtime (+ve). Applied to HEALTHY only. */
  healthyBonus: number;
  /** Penalty for DEGRADED runtime (−ve applied as reduction). */
  degradedPenalty: number;
  /** Penalty for DEAD runtime (−ve). Effectively removes it from contention. */
  deadPenalty: number;
  /** Max penalty from crash rate: crashRate × crashWeight (0.0–1.0 range). */
  crashWeight: number;
  /** Flat penalty when runtime is on cooldown. */
  cooldownPenalty: number;
  /** Max penalty from load: (activeTasks/concurrencyLimit) × loadWeight. */
  loadWeight: number;
  /** Max penalty from low mutation rate (only for mutation-heavy tasks). */
  mutationWeight: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  healthyBonus:    0.30,
  degradedPenalty: 0.50,
  deadPenalty:     0.80,
  crashWeight:     0.40,
  cooldownPenalty: 0.80,
  loadWeight:      0.20,
  mutationWeight:  0.25,
};

// ─── Router ───────────────────────────────────────────────────

export class Router {
  private config: RoutingConfig;
  private weights: ScoringWeights;
  readonly feedback: TelemetryFeedbackLoop | null;

  /**
   * Tracks when each agent was last dispatched a task.
   * Used to break ties: when two agents score equally, the one that
   * was dispatched LESS recently gets a small boost.
   *
   * Now PERSISTED to disk at projectRoot/.maos/router-dispatch-history.json
   * so the penalty applies across restarts and separate plan/start runs.
   */
  private dispatchHistory: Map<string, number> = new Map();
  private dispatchCounter: number = 0;
  private historyFilePath: string | null = null;

  constructor(
    config: RoutingConfig,
    projectRoot?: string,
    scoringWeights?: Partial<ScoringWeights>,
  ) {
    this.config  = config;
    this.weights = { ...DEFAULT_SCORING_WEIGHTS, ...scoringWeights };
    this.feedback = null;

    // Load telemetry for adaptive routing
    if (projectRoot) {
      try {
        this.feedback = new TelemetryFeedbackLoop(projectRoot);
      } catch { /* telemetry not available — pure static routing */ }

      // Load persistent dispatch history for cross-restart distribution
      try {
        this.historyFilePath = path.join(projectRoot, '.maos', 'router-dispatch-history.json');
        if (fs.existsSync(this.historyFilePath)) {
          const raw = JSON.parse(fs.readFileSync(this.historyFilePath, 'utf-8'));
          this.dispatchCounter = raw.counter ?? 0;
          this.dispatchHistory = new Map(Object.entries(raw.history ?? {})
            .map(([k, v]) => [k, v as number]));
        }
      } catch { /* ignore — start fresh */ }
    }
  }

  /**
   * Route a task to the best available agent.
   *
   * @param task           Task requirements
   * @param agents         All known agent profiles (idle + busy + enabled/disabled)
   * @param blacklist      Agent IDs to exclude from routing (used for retry rerouting)
   *
   * Returns null if no agent is available.
   * Returns a RoutingDecision with full score breakdown for logging/analytics.
   */
  route(
    task: TaskRequirements,
    agents: AgentProfile[],
    blacklist: string[] = [],
  ): RoutingDecision | null {
    // If a specific agent is targeted
    if (task.targetAgent && task.targetAgent !== 'AUTO') {
      const target = agents.find(
        a => a.id === task.targetAgent && a.idle && a.enabled && !blacklist.includes(a.id),
      );
      if (target) {
        return {
          agentId: target.id,
          score: 100,
          reasoning: [`Explicitly targeted agent: ${target.id}`],
          breakdown: {
            capabilityScore: 1.0,
            roleBonus:       0,
            costPenalty:     0,
            complexityBonus: 0,
            healthBonus:     0,
            crashPenalty:    0,
            cooldownPenalty: 0,
            loadPenalty:     0,
            mutationPenalty: 0,
          },
        };
      }
      // Target on blacklist or not available
      if (blacklist.includes(task.targetAgent)) {
        // Fall through to auto-route — retry rerouting
      } else {
        return null; // Target agent not available
      }
    }

    // Filter to available agents (exclude blacklist)
    const available = agents.filter(a => a.idle && a.enabled && !blacklist.includes(a.id));
    if (available.length === 0) return null;

    // Apply routing strategy
    switch (this.config.strategy) {
      case 'capability_score':
        return this.scoreBasedRouting(task, available);
      case 'round_robin':
        return this.roundRobinRouting(available);
      case 'cheapest_first':
        return this.cheapestFirstRouting(task, available);
      case 'best_model':
        return this.bestModelRouting(task, available);
      default:
        return this.scoreBasedRouting(task, available);
    }
  }

  /**
   * Score all available agents and return rankings.
   * Useful for dashboard analytics.
   */
  rankAll(
    task: TaskRequirements,
    agents: AgentProfile[],
    blacklist: string[] = [],
  ): RoutingDecision[] {
    const available = agents.filter(a => a.idle && a.enabled && !blacklist.includes(a.id));
    return available
      .map(agent => this.scoreAgent(task, agent))
      .sort((a, b) => b.score - a.score);
  }

  // ─── Strategies ─────────────────────────────────────────────

  private scoreBasedRouting(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision {
    const scored = agents.map(agent => this.scoreAgent(task, agent));
    scored.sort((a, b) => b.score - a.score);

    // Record that this agent was dispatched (for future recency penalty)
    const winner = scored[0];
    this.dispatchCounter++;
    this.dispatchHistory.set(winner.agentId, this.dispatchCounter);
    this.saveDispatchHistory();

    return winner;
  }

  private roundRobinRouting(agents: AgentProfile[]): RoutingDecision {
    // Round-robin: pick the agent dispatched LEAST recently
    const sorted = [...agents].sort((a, b) => {
      const lastA = this.dispatchHistory.get(a.id) ?? -1;
      const lastB = this.dispatchHistory.get(b.id) ?? -1;
      return lastA - lastB; // smallest = least recently dispatched
    });
    const agent = sorted[0];

    this.dispatchCounter++;
    this.dispatchHistory.set(agent.id, this.dispatchCounter);
    this.saveDispatchHistory();

    return {
      agentId: agent.id,
      score: 50,
      reasoning: ['Round-robin: least recently dispatched agent'],
      breakdown: {
        capabilityScore: 0.5,
        roleBonus:       0,
        costPenalty:     0,
        complexityBonus: 0,
        healthBonus:     0,
        crashPenalty:    0,
        cooldownPenalty: 0,
        loadPenalty:     0,
        mutationPenalty: 0,
      },
    };
  }

  /** Persist dispatch history to disk so it survives across restarts. */
  private saveDispatchHistory(): void {
    if (!this.historyFilePath) return;
    try {
      const data = {
        counter: this.dispatchCounter,
        history: Object.fromEntries(this.dispatchHistory),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.historyFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
  }

  private cheapestFirstRouting(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision {
    const capable = agents.filter(a => {
      if (task.capabilities.length === 0) return true;
      const overlap = task.capabilities.filter(c => a.capabilities.includes(c));
      return overlap.length > 0;
    });

    const pool = capable.length > 0 ? [...capable] : [...agents];
    pool.sort((a, b) => (COST_TIERS[a.costTier] || 5) - (COST_TIERS[b.costTier] || 5));

    return {
      agentId: pool[0].id,
      score: 60,
      reasoning: [`Cheapest capable agent: ${pool[0].provider}/${pool[0].model} (${pool[0].costTier})`],
      breakdown: {
        capabilityScore: 0.5,
        roleBonus:       0,
        costPenalty:     0,
        complexityBonus: 0,
        healthBonus:     0,
        crashPenalty:    0,
        cooldownPenalty: 0,
        loadPenalty:     0,
        mutationPenalty: 0,
      },
    };
  }

  private bestModelRouting(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision {
    const sorted = [...agents];
    sorted.sort((a, b) => (COST_TIERS[b.costTier] || 5) - (COST_TIERS[a.costTier] || 5));

    return {
      agentId: sorted[0].id,
      score: 70,
      reasoning: [`Best model available: ${sorted[0].provider}/${sorted[0].model} (${sorted[0].costTier})`],
      breakdown: {
        capabilityScore: 0.7,
        roleBonus:       0,
        costPenalty:     0,
        complexityBonus: 0,
        healthBonus:     0,
        crashPenalty:    0,
        cooldownPenalty: 0,
        loadPenalty:     0,
        mutationPenalty: 0,
      },
    };
  }

  // ─── Scoring ──────────────────────────────────────────────────

  private scoreAgent(
    task: TaskRequirements,
    agent: AgentProfile,
  ): RoutingDecision {
    const reasoning: string[] = [];
    const W = this.weights;  // Alias — all weight lookups go through W

    // ── 1. Capability match (0.0 → 1.0) ──────────────────────────
    let capabilityScore: number;
    if (task.capabilities.length === 0) {
      capabilityScore = 0.5;
      reasoning.push('No required capabilities → neutral (0.5)');
    } else {
      const matched = task.capabilities.filter(c => agent.capabilities.includes(c));
      capabilityScore = matched.length / task.capabilities.length;
      reasoning.push(
        'Capabilities: ' + matched.length + '/' + task.capabilities.length + ' match ' +
        '(' + (matched.join(', ') || 'none') + ') → ' + capabilityScore.toFixed(2)
      );
    }

    // ── 1b. Adaptive boost — blend static with learned performance ──
    if (this.feedback && task.capabilities.length > 0) {
      const learnedRate = this.feedback.getSuccessRate(agent.id, task.capabilities);
      if (learnedRate !== null) {
        const blendedScore = capabilityScore * 0.6 + learnedRate * 0.4;
        reasoning.push(
          'Adaptive: learned ' + learnedRate.toFixed(2) +
          ' → blended ' + capabilityScore.toFixed(2) + '*0.6 + ' +
          learnedRate.toFixed(2) + '*0.4 = ' + blendedScore.toFixed(2)
        );
        capabilityScore = blendedScore;
      }
    }

    // ── 2. Role bonus (0.0 → 0.25) ───────────────────────────────
    let roleBonus = 0;
    const affinities = ROLE_CATEGORY_AFFINITY[agent.role] || [];
    if (affinities.includes(task.category)) {
      roleBonus = 0.25;
      reasoning.push(`Role match: ${agent.role} ↔ ${task.category} → +0.25`);
    } else if (task.category && affinities.some(a => task.category.includes(a))) {
      roleBonus = 0.15;
      reasoning.push(`Role partial match: ${agent.role} ~ ${task.category} → +0.15`);
    }

    // ── 3. Cost penalty (0.0 → 0.15) ─────────────────────────────
    const costTierValue = COST_TIERS[agent.costTier] || 5;
    const costPenalty = costTierValue / 100;
    reasoning.push(`Cost: ${agent.costTier} (${costTierValue}) → -${costPenalty.toFixed(3)}`);

    // ── 4. Complexity bonus (0.0 → 0.2) ─────────────────────────
    let complexityBonus = 0;
    const complexityMinTier = COMPLEXITY_MIN_TIER[task.complexity] || 0;
    if (task.complexity === 'high' && costTierValue >= complexityMinTier) {
      complexityBonus = 0.2;
      reasoning.push(`Complexity match: high task + capable model → +0.2`);
    } else if (task.complexity === 'medium' && costTierValue >= complexityMinTier) {
      complexityBonus = 0.1;
      reasoning.push(`Complexity match: medium task + adequate model → +0.1`);
    }

    // ── 5. Health bonus/penalty (runtime-aware) ───────────────────
    // Only applied when agent has a healthState populated from HealthMonitor.
    // All values read from W (centralized SCORING_WEIGHTS).
    let healthBonus = 0;
    if (agent.healthState !== undefined) {
      switch (agent.healthState) {
        case 'HEALTHY':
          healthBonus = W.healthyBonus;
          reasoning.push(`Health: HEALTHY → +${W.healthyBonus.toFixed(2)}`);
          break;
        case 'DEGRADED':
          healthBonus = -W.degradedPenalty;
          reasoning.push(`Health: DEGRADED → -${W.degradedPenalty.toFixed(2)}`);
          break;
        case 'DEAD':
          healthBonus = -W.deadPenalty;
          reasoning.push(`Health: DEAD → -${W.deadPenalty.toFixed(2)} (effectively excluded)`);
          break;
        case 'IDLE':
          // Neutral — no bonus/penalty for idle
          break;
        default:
          // Phase states (THINKING, WAITING_ON_PROVIDER, etc.) — treat as HEALTHY
          healthBonus = W.healthyBonus;
          break;
      }
    }

    // ── 6. Crash penalty ─────────────────────────────────────────
    // Reads from RuntimeStats (from RuntimeStatsStore).
    // penalty = crashRate × crashWeight
    let crashPenalty = 0;
    if (agent.runtimeStats && agent.runtimeStats.totalRuns >= 3) {
      crashPenalty = agent.runtimeStats.crashRate * W.crashWeight;
      if (crashPenalty > 0.01) {
        reasoning.push(
          `Crash rate: ${(agent.runtimeStats.crashRate * 100).toFixed(0)}% → -${crashPenalty.toFixed(3)}`
        );
      }
    }

    // ── 7. Cooldown penalty ───────────────────────────────────────
    // Flat penalty applied when the runtime is in post-crash cooldown.
    let cooldownPenalty = 0;
    if (agent.runtimeStats?.cooldownUntil && Date.now() < agent.runtimeStats.cooldownUntil) {
      cooldownPenalty = W.cooldownPenalty;
      const remainSec = Math.round((agent.runtimeStats.cooldownUntil - Date.now()) / 1000);
      reasoning.push(`Cooldown: ${remainSec}s remaining → -${W.cooldownPenalty.toFixed(2)}`);
    }

    // ── 8. Load penalty ───────────────────────────────────────────
    // Discourages routing to overloaded runtimes.
    // penalty = (activeTasks / concurrencyLimit) × loadWeight
    let loadPenalty = 0;
    const activeTasks     = agent.activeTasks ?? 0;
    const concurrencyLimit = 1; // CLI/API default; override from profile when available
    if (activeTasks > 0) {
      loadPenalty = Math.min(1, activeTasks / concurrencyLimit) * W.loadWeight;
      reasoning.push(`Load: ${activeTasks} active → -${loadPenalty.toFixed(3)}`);
    }

    // ── 9. Mutation penalty (CONDITIONAL — mutation-heavy tasks only) ──
    // IMPORTANT: Only applied when task.category is mutation-heavy.
    // Analysis, planning, diagnostics tasks intentionally have low mutation
    // rates — penalizing them here would produce wrong routing decisions.
    let mutationPenalty = 0;
    const isMutationHeavy = MUTATION_HEAVY_CATEGORIES.has(task.category.toLowerCase());
    if (isMutationHeavy && agent.runtimeStats && agent.runtimeStats.totalRuns >= 3) {
      const lowMutation = 1 - agent.runtimeStats.mutationRate;
      mutationPenalty = lowMutation * W.mutationWeight;
      if (mutationPenalty > 0.02) {
        reasoning.push(
          `Mutation rate: ${(agent.runtimeStats.mutationRate * 100).toFixed(0)}% ` +
          `(mutation-heavy task) → -${mutationPenalty.toFixed(3)}`
        );
      }
    }

    // ── 10. Recency penalty (distribution tiebreaker) ──────────────
    // When multiple agents score identically (e.g. CODER_1 and CODER_3
    // both have [coding, frontend]), the one dispatched most recently
    // gets a small penalty so the OTHER agent gets the next task.
    // The penalty is tiny (0.001) — just enough to break ties without
    // overriding genuine capability/health differences.
    let recencyPenalty = 0;
    const lastDispatch = this.dispatchHistory.get(agent.id);
    if (lastDispatch !== undefined && this.dispatchCounter > 0) {
      // Higher lastDispatch = more recent = larger penalty
      // Scale: 0.0 to 0.005 (never more than 0.5% of total score)
      recencyPenalty = (lastDispatch / this.dispatchCounter) * 0.005;
      if (recencyPenalty > 0.001) {
        reasoning.push(`Recency: last dispatched ${this.dispatchCounter - lastDispatch} ago → -${recencyPenalty.toFixed(4)}`);
      }
    }

    // ── Final score ───────────────────────────────────────────────
    const score =
      capabilityScore * this.config.capabilityWeight
      + roleBonus
      + complexityBonus
      - costPenalty * this.config.costWeight
      + healthBonus
      - crashPenalty
      - cooldownPenalty
      - loadPenalty
      - mutationPenalty
      - recencyPenalty;

    reasoning.push(`TOTAL: ${score.toFixed(4)}`);

    return {
      agentId: agent.id,
      score,
      reasoning,
      breakdown: {
        capabilityScore,
        roleBonus,
        costPenalty,
        complexityBonus,
        healthBonus,
        crashPenalty,
        cooldownPenalty,
        loadPenalty,
        mutationPenalty,
      },
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────

/**
 * Create a router from a MAOS config routing section.
 */
export function createRouter(routingConfig: {
  strategy?: string;
  costWeight?: number;
  capabilityWeight?: number;
}, projectRoot?: string, scoringWeights?: Partial<ScoringWeights>): Router {
  return new Router({
    strategy: (routingConfig.strategy || 'capability_score') as RoutingConfig['strategy'],
    costWeight: routingConfig.costWeight ?? 0.3,
    capabilityWeight: routingConfig.capabilityWeight ?? 0.7,
  }, projectRoot, scoringWeights);
}

// ─── Telemetry Feedback Loop (P3.2) ────────────────────────

export interface PerformanceCell {
  successes: number;
  total: number;
  rate: number;
}

export type PerformanceMatrix = Record<string, Record<string, PerformanceCell>>;

/**
 * Reads telemetry history and builds a performance profile per agent.
 *
 * Performance matrix:
 *                  coding    frontend    testing    planning
 *   CODER_1         0.92      0.45        0.80       —
 *   CODER_2         0.88      0.91        0.60       —
 *   ARCHITECT       0.20      —           —          0.95
 *
 * Each cell = successes / total for that agent × capability pair.
 */
export class TelemetryFeedbackLoop {
  private matrix: PerformanceMatrix = {};
  private records: TelemetryRecord[];

  constructor(projectRoot: string) {
    this.records = readTelemetry(projectRoot);
    this.buildMatrix();
  }

  /**
   * Get success rate for an agent on a set of capabilities.
   * Returns null if no data exists.
   */
  getSuccessRate(agentId: string, capabilities: string[]): number | null {
    const agentData = this.matrix[agentId];
    if (!agentData) return null;

    let totalRate = 0;
    let count = 0;

    for (const cap of capabilities) {
      const cell = agentData[cap];
      if (cell && cell.total >= 1) {
        totalRate += cell.rate;
        count++;
      }
    }

    if (count === 0) return null;
    return totalRate / count;
  }

  /**
   * Get the full performance matrix (for dashboard display).
   */
  getMatrix(): PerformanceMatrix {
    return this.matrix;
  }

  /**
   * Get a formatted summary for CLI display.
   */
  getSummary(): string {
    if (this.records.length === 0) {
      return 'No telemetry data. Run some tasks first.';
    }

    const agents = Object.keys(this.matrix);
    if (agents.length === 0) return 'No performance data.';

    // Collect all capabilities across all agents
    const allCaps = new Set<string>();
    for (const agentData of Object.values(this.matrix)) {
      for (const cap of Object.keys(agentData)) {
        allCaps.add(cap);
      }
    }
    const caps = Array.from(allCaps).sort();

    // Build table
    const capWidth = 10;
    const header = '  ' + 'Agent'.padEnd(16) + caps.map(c => c.substring(0, capWidth).padEnd(capWidth)).join(' ');
    const separator = '  ' + '-'.repeat(header.length - 2);

    const rows = agents.map(agentId => {
      const agentData = this.matrix[agentId];
      const cells = caps.map(cap => {
        const cell = agentData[cap];
        if (!cell) return '-'.padEnd(capWidth);
        const pct = Math.round(cell.rate * 100);
        const label = pct + '% (' + cell.total + ')';
        return label.padEnd(capWidth);
      });
      return '  ' + agentId.padEnd(16) + cells.join(' ');
    });

    return [
      'Performance Matrix (' + this.records.length + ' telemetry records):',
      '',
      header,
      separator,
      ...rows,
    ].join('\n');
  }

  /**
   * Get the number of telemetry records used.
   */
  get recordCount(): number {
    return this.records.length;
  }

  // ---- Build the matrix ----

  private buildMatrix(): void {
    for (const record of this.records) {
      if (!this.matrix[record.agentId]) {
        this.matrix[record.agentId] = {};
      }
      const agentData = this.matrix[record.agentId];

      for (const cap of record.capabilities) {
        if (!agentData[cap]) {
          agentData[cap] = { successes: 0, total: 0, rate: 0 };
        }
        agentData[cap].total++;
        if (record.success) {
          agentData[cap].successes++;
        }
        agentData[cap].rate = agentData[cap].successes / agentData[cap].total;
      }
    }
  }
}
