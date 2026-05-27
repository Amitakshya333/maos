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
 *
 * P3.2: The router now reads telemetry data and builds a performance
 * matrix per agent. Agents that historically succeed on certain
 * capability types get boosted; agents that fail get penalized.
 * This creates a self-improving routing loop.
 */

import { readTelemetry, TelemetryRecord } from './telemetry';

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
    capabilityScore: number;
    roleBonus: number;
    costPenalty: number;
    complexityBonus: number;
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
  coder: ['coding', 'backend', 'api', 'database', 'refactoring', 'testing', 'debugging'],
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

// ─── Router ───────────────────────────────────────────────────

export class Router {
  private config: RoutingConfig;
  readonly feedback: TelemetryFeedbackLoop | null;

  constructor(config: RoutingConfig, projectRoot?: string) {
    this.config = config;
    this.feedback = null;

    // Load telemetry for adaptive routing
    if (projectRoot) {
      try {
        this.feedback = new TelemetryFeedbackLoop(projectRoot);
      } catch { /* telemetry not available — pure static routing */ }
    }
  }

  /**
   * Route a task to the best available agent.
   *
   * Returns null if no agent is available.
   * Returns a RoutingDecision with score breakdown for logging/analytics.
   */
  route(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision | null {
    // If a specific agent is targeted
    if (task.targetAgent && task.targetAgent !== 'AUTO') {
      const target = agents.find(
        a => a.id === task.targetAgent && a.idle && a.enabled,
      );
      if (target) {
        return {
          agentId: target.id,
          score: 100, // Max score for explicit targeting
          reasoning: [`Explicitly targeted agent: ${target.id}`],
          breakdown: {
            capabilityScore: 1.0,
            roleBonus: 0,
            costPenalty: 0,
            complexityBonus: 0,
          },
        };
      }
      return null; // Target agent not available
    }

    // Filter to available agents
    const available = agents.filter(a => a.idle && a.enabled);
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
  ): RoutingDecision[] {
    const available = agents.filter(a => a.idle && a.enabled);
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
    return scored[0];
  }

  private roundRobinRouting(agents: AgentProfile[]): RoutingDecision {
    // Simple: pick the first available agent
    const agent = agents[0];
    return {
      agentId: agent.id,
      score: 50,
      reasoning: ['Round-robin: first available agent'],
      breakdown: {
        capabilityScore: 0.5,
        roleBonus: 0,
        costPenalty: 0,
        complexityBonus: 0,
      },
    };
  }

  private cheapestFirstRouting(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision {
    // Sort by cost tier (cheapest first), but filter out agents
    // that don't meet minimum capability threshold
    const capable = agents.filter(a => {
      if (task.capabilities.length === 0) return true;
      const overlap = task.capabilities.filter(c => a.capabilities.includes(c));
      return overlap.length > 0; // At least 1 matching capability
    });

    const pool = capable.length > 0 ? capable : agents; // Fallback to all if none match
    pool.sort((a, b) => (COST_TIERS[a.costTier] || 5) - (COST_TIERS[b.costTier] || 5));

    return {
      agentId: pool[0].id,
      score: 60,
      reasoning: [`Cheapest capable agent: ${pool[0].provider}/${pool[0].model} (${pool[0].costTier})`],
      breakdown: {
        capabilityScore: 0.5,
        roleBonus: 0,
        costPenalty: 0,
        complexityBonus: 0,
      },
    };
  }

  private bestModelRouting(
    task: TaskRequirements,
    agents: AgentProfile[],
  ): RoutingDecision {
    // Sort by cost tier (most expensive = presumably best)
    const sorted = [...agents];
    sorted.sort((a, b) => (COST_TIERS[b.costTier] || 5) - (COST_TIERS[a.costTier] || 5));

    return {
      agentId: sorted[0].id,
      score: 70,
      reasoning: [`Best model available: ${sorted[0].provider}/${sorted[0].model} (${sorted[0].costTier})`],
      breakdown: {
        capabilityScore: 0.7,
        roleBonus: 0,
        costPenalty: 0,
        complexityBonus: 0,
      },
    };
  }

  // ─── Scoring ────────────────────────────────────────────────

  private scoreAgent(
    task: TaskRequirements,
    agent: AgentProfile,
  ): RoutingDecision {
    const reasoning: string[] = [];

    // 1. Capability match (0.0 → 1.0)
    let capabilityScore: number;
    if (task.capabilities.length === 0) {
      capabilityScore = 0.5; // Neutral — no capabilities specified
      reasoning.push('No required capabilities \u2192 neutral (0.5)');
    } else {
      const matched = task.capabilities.filter(c => agent.capabilities.includes(c));
      capabilityScore = matched.length / task.capabilities.length;
      reasoning.push(
        'Capabilities: ' + matched.length + '/' + task.capabilities.length + ' match ' +
        '(' + (matched.join(', ') || 'none') + ') \u2192 ' + capabilityScore.toFixed(2)
      );
    }

    // 1b. ADAPTIVE BOOST (P3.2) — blend static score with learned performance
    let adaptiveBoost = 0.5; // Neutral default (no data)
    if (this.feedback && task.capabilities.length > 0) {
      const learnedRate = this.feedback.getSuccessRate(agent.id, task.capabilities);
      if (learnedRate !== null) {
        adaptiveBoost = learnedRate;
        // Blend: 60% static match + 40% learned performance
        const blendedScore = capabilityScore * 0.6 + adaptiveBoost * 0.4;
        reasoning.push(
          'Adaptive: learned success rate ' + adaptiveBoost.toFixed(2) +
          ' \u2192 blended ' + capabilityScore.toFixed(2) + '*0.6 + ' +
          adaptiveBoost.toFixed(2) + '*0.4 = ' + blendedScore.toFixed(2)
        );
        capabilityScore = blendedScore;
      }
    }

    // 2. Role bonus (0.0 → 0.25)
    let roleBonus = 0;
    const affinities = ROLE_CATEGORY_AFFINITY[agent.role] || [];
    if (affinities.includes(task.category)) {
      roleBonus = 0.25;
      reasoning.push(`Role match: ${agent.role} ↔ ${task.category} → +0.25`);
    } else if (task.category && affinities.some(a => task.category.includes(a))) {
      roleBonus = 0.15; // Partial match
      reasoning.push(`Role partial match: ${agent.role} ~ ${task.category} → +0.15`);
    }

    // 3. Cost penalty (0.0 → 0.15)
    const costTierValue = COST_TIERS[agent.costTier] || 5;
    const costPenalty = costTierValue / 100;
    reasoning.push(`Cost: ${agent.costTier} (${costTierValue}) → -${costPenalty.toFixed(3)}`);

    // 4. Complexity bonus — reward capable models for hard tasks (0.0 → 0.2)
    let complexityBonus = 0;
    const complexityMinTier = COMPLEXITY_MIN_TIER[task.complexity] || 0;
    if (task.complexity === 'high' && costTierValue >= complexityMinTier) {
      complexityBonus = 0.2;
      reasoning.push(`Complexity match: high task + capable model → +0.2`);
    } else if (task.complexity === 'medium' && costTierValue >= complexityMinTier) {
      complexityBonus = 0.1;
      reasoning.push(`Complexity match: medium task + adequate model → +0.1`);
    }

    // Final score
    const score =
      capabilityScore * this.config.capabilityWeight +
      roleBonus +
      complexityBonus -
      costPenalty * this.config.costWeight;

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
}, projectRoot?: string): Router {
  return new Router({
    strategy: (routingConfig.strategy || 'capability_score') as RoutingConfig['strategy'],
    costWeight: routingConfig.costWeight ?? 0.3,
    capabilityWeight: routingConfig.capabilityWeight ?? 0.7,
  }, projectRoot);
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
