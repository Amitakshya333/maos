/**
 * MAOS Capability-Based Routing Engine
 *
 * The router decides which agent handles which task.
 * It scores agents based on:
 *   - Capability match (does the agent have the skills the task needs?)
 *   - Role alignment (is the agent's role suited for this task category?)
 *   - Cost efficiency (prefer cheaper models when capable)
 *   - Complexity matching (route hard tasks to powerful models)
 *   - Historical performance (future: learn from telemetry)
 *
 * This is the "brain" that makes MAOS smarter than round-robin assignment.
 */

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

  constructor(config: RoutingConfig) {
    this.config = config;
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
      reasoning.push('No required capabilities → neutral (0.5)');
    } else {
      const matched = task.capabilities.filter(c => agent.capabilities.includes(c));
      capabilityScore = matched.length / task.capabilities.length;
      reasoning.push(
        `Capabilities: ${matched.length}/${task.capabilities.length} match ` +
        `(${matched.join(', ') || 'none'}) → ${capabilityScore.toFixed(2)}`
      );
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
}): Router {
  return new Router({
    strategy: (routingConfig.strategy || 'capability_score') as RoutingConfig['strategy'],
    costWeight: routingConfig.costWeight ?? 0.3,
    capabilityWeight: routingConfig.capabilityWeight ?? 0.7,
  });
}
