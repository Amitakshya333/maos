import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Plugin Registry Tests ---
import { getPluginRegistry } from '../src/backends/plugin-registry';

describe('PluginRegistry', () => {
  // We can't easily reset the singleton, so test all in sequence
  const registry = getPluginRegistry();

  it('should register and create a provider plugin', () => {
    registry.registerProvider(
      'test-provider',
      (config) => ({
        name: 'test',
        model: (config.model as string) || 'test-model',
        generate: async () => ({
          content: 'test',
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: 'test-model',
          latencyMs: 0,
          finishReason: 'stop' as const,
        }),
      }),
      { version: '1.0.0', description: 'Test provider' },
    );

    expect(registry.hasProvider('test-provider')).toBe(true);
    expect(registry.hasProvider('nonexistent')).toBe(false);

    const provider = registry.createProvider('test-provider', { model: 'custom' });
    expect(provider.name).toBe('test');
    expect(provider.model).toBe('custom');
  });

  it('should register and create a runtime plugin', () => {
    registry.registerRuntime(
      'test-runtime',
      (_config) => ({
        type: 'test' as any,
        executeTask: async () => ({
          success: true,
          taskResult: 'success' as const,
          output: 'done',
          iterationCount: 1,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        stop: async () => {},
      }),
      { version: '1.0.0' },
    );

    expect(registry.hasRuntime('test-runtime')).toBe(true);
    expect(registry.hasRuntime('nonexistent')).toBe(false);
  });

  it('should list registered plugin names', () => {
    expect(registry.getProviderNames()).toContain('test-provider');
    expect(registry.getRuntimeNames()).toContain('test-runtime');
  });

  it('should return manifests for all plugins', () => {
    const manifests = registry.getManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(2);
    const providerManifest = manifests.find((m) => m.name === 'test-provider');
    expect(providerManifest?.version).toBe('1.0.0');
    expect(providerManifest?.type).toBe('provider');
  });

  it('should throw on unknown provider', () => {
    expect(() => registry.createProvider('nonexistent')).toThrow('not registered');
  });

  it('should throw on unknown runtime', () => {
    expect(() => registry.createRuntime('nonexistent')).toThrow('not registered');
  });

  it('should handle loadFromConfig with missing modules gracefully', () => {
    const result = registry.loadFromConfig(
      {
        providers: {
          'bad-plugin': { module: './nonexistent-path.js' },
          'no-module': {},
        },
      },
      os.tmpdir(),
    );

    expect(result.loaded).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors[1]).toContain('missing "module"');
  });
});

// --- Worktree Module Tests ---
import { isWorktreeSupported } from '../src/integrations/worktree';

describe('Worktree', () => {
  it('should check if worktrees are supported', () => {
    // In the MAOS repo, git worktrees should be supported
    const supported = isWorktreeSupported(process.cwd());
    expect(typeof supported).toBe('boolean');
  });
});

// --- Persistent File Locks Tests ---
import { getFileLockRegistry } from '../src/core/scope-guard';

describe('FileOwnershipEngine Persistence', () => {
  const engine = getFileLockRegistry();

  it('should claim and release file ownership', () => {
    const result = engine.claimWrite('/test/file.ts', 'AGENT_1', 'TASK_1');
    expect(result).toBeNull(); // No conflict

    const owner = engine.getOwner('/test/file.ts');
    expect(owner?.owner).toBe('AGENT_1');

    const released = engine.release('/test/file.ts', 'AGENT_1');
    expect(released).toBe(true);
  });

  it('should detect write conflicts between agents', () => {
    engine.claimWrite('/conflict/file.ts', 'AGENT_A', 'TASK_A');
    const conflict = engine.claimWrite('/conflict/file.ts', 'AGENT_B', 'TASK_B');
    expect(conflict).not.toBeNull();
    expect(conflict?.type).toBe('FILE_LOCKED');

    // Cleanup
    engine.releaseAll('AGENT_A');
  });

  it('should allow same agent to re-acquire', () => {
    engine.claimWrite('/reacquire.ts', 'AGENT_X', 'TASK_X');
    const result = engine.claimWrite('/reacquire.ts', 'AGENT_X', 'TASK_X');
    expect(result).toBeNull(); // Same agent, no conflict
    engine.releaseAll('AGENT_X');
  });

  it('should release all files for an agent', () => {
    engine.claimWrite('/a.ts', 'AGENT_R', 'TASK_R');
    engine.claimWrite('/b.ts', 'AGENT_R', 'TASK_R');
    engine.claimWrite('/c.ts', 'AGENT_R', 'TASK_R');

    const count = engine.releaseAll('AGENT_R');
    expect(count).toBe(3);
  });

  it('should get all files owned by an agent', () => {
    engine.claimWrite('/owned/x.ts', 'AGENT_O', 'TASK_O');
    engine.claimWrite('/owned/y.ts', 'AGENT_O', 'TASK_O');

    const files = engine.getAgentFiles('AGENT_O');
    expect(files.length).toBe(2);
    engine.releaseAll('AGENT_O');
  });
});
