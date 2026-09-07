import { describe, it, expect } from 'vitest';
import { createRouter, AgentProfile, TaskRequirements } from '../src/core/router';

describe('Router Module', () => {
  const router = createRouter({ strategy: 'capability_score' });

  const agents: AgentProfile[] = [
    {
      id: 'CODER',
      role: 'developer',
      provider: 'openai',
      model: 'gpt-4o',
      capabilities: ['typescript', 'react', 'nodejs'],
      costTier: 'medium',
      maxIterations: 10,
      idle: true,
      enabled: true,
    },
    {
      id: 'TESTER',
      role: 'tester',
      provider: 'openai',
      model: 'gpt-4o-mini',
      capabilities: ['testing', 'vitest', 'jest'],
      costTier: 'low',
      maxIterations: 5,
      idle: true,
      enabled: true,
    },
    {
      id: 'REVIEWER',
      role: 'reviewer',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      capabilities: ['code-review', 'security'],
      costTier: 'high',
      maxIterations: 5,
      idle: false, // Busy agent
      enabled: true,
    },
  ];

  it('should route directly to targetAgent if explicitly requested and available', () => {
    const task: TaskRequirements = {
      capabilities: ['testing'],
      complexity: 'low',
      category: 'testing',
      targetAgent: 'TESTER',
    };

    const decision = router.route(task, agents);
    expect(decision).not.toBeNull();
    expect(decision?.agentId).toBe('TESTER');
    expect(decision?.reasoning[0]).toContain('Explicitly targeted agent');
  });

  it('should match the most capable idle agent based on requested skills', () => {
    const task: TaskRequirements = {
      capabilities: ['typescript', 'react'],
      complexity: 'medium',
      category: 'development',
      targetAgent: 'AUTO',
    };

    const decision = router.route(task, agents);
    expect(decision).not.toBeNull();
    expect(decision?.agentId).toBe('CODER');
  });

  it('should filter out busy agents', () => {
    const task: TaskRequirements = {
      capabilities: ['code-review'],
      complexity: 'high',
      category: 'review',
      targetAgent: 'REVIEWER', // REVIEWER is idle: false
    };

    const decision = router.route(task, agents);
    // REVIEWER is busy and not in fallback blacklist mode
    expect(decision).toBeNull();
  });

  it('should respect blacklist and select next best candidate', () => {
    const task: TaskRequirements = {
      capabilities: ['typescript'],
      complexity: 'low',
      category: 'development',
      targetAgent: 'AUTO',
    };

    // Blacklist CODER
    const decision = router.route(task, agents, ['CODER']);
    expect(decision).not.toBeNull();
    expect(decision?.agentId).toBe('TESTER');
  });
});
