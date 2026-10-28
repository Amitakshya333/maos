import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { runAgent } from '../../src/core/agent-runner';
import { enqueueRetry, drainRetryQueue, getRetryQueueStatus } from '../../src/core/retry-queue';
import type { TaskFile } from '../../src/core/queue';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-agent-budget-'));
  roots.push(root);
  return root;
}

function toolResponse(name: string): ProviderResponse {
  return {
    content: null,
    toolCalls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify({ command: 'echo executed > blocked-command.txt', path: 'blocked.txt', content: 'blocked' }) } }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'budget-test-model',
    latencyMs: 0,
    finishReason: 'tool_calls',
  };
}

function baseAgent(allowedTools: string[], maxIterations = 1) {
  return {
    id: 'budget-test-agent', role: 'test worker', provider: 'mock', model: 'budget-test-model',
    capabilities: [], scope: ['*'], allowedTools, maxIterations,
  };
}

function task() {
  return { id: 'budget-test-task', description: 'Test a bounded agent run.', branch: 'local' };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('agent generation and adaptive iteration budgets', () => {
  it.each(['run_command', 'write_file', 'git_commit'])('does not grant adaptive iterations for unauthorized %s calls', async (toolName) => {
    const root = makeRoot();
    const generate = vi.fn(async () => toolResponse(toolName));
    const result = await runAgent(
      { name: 'mock', model: 'budget-test-model', generate } as unknown as IProvider,
      baseAgent(['task_complete']), task(), root, 0,
      undefined, undefined,
      { allowPartialSuccess: false, maxProviderRetries: 0 },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, 'blocked.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'blocked-command.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('enforces a hard generation ceiling even after a successful mutation earns an adaptive iteration', async () => {
    const root = makeRoot();
    const generate = vi.fn(async () => toolResponse('write_file'));
    const result = await runAgent(
      { name: 'mock', model: 'budget-test-model', generate } as unknown as IProvider,
      baseAgent(['write_file'], 1), task(), root, 0,
      undefined, undefined,
      { allowPartialSuccess: false, maxProviderRetries: 0, maxGenerationAttempts: 1 },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum model generation attempts (1) reached.');
  });

  it('counts transient retries toward the same hard generation ceiling', async () => {
    const root = makeRoot();
    let calls = 0;
    const provider = {
      name: 'mock', model: 'budget-test-model',
      async generate() { calls++; throw new Error('503 service unavailable'); },
    } as unknown as IProvider;
    vi.useFakeTimers();
    const pending = runAgent(
      provider, baseAgent(['task_complete'], 20), task(), root, 0,
      undefined, undefined,
      { allowPartialSuccess: false, maxProviderRetries: 5, maxGenerationAttempts: 2 },
    );
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await pending;

    expect(calls).toBe(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum model generation attempts (2) reached.');
  });

  it.each([undefined, 5])('does not exceed a provider-owned zero retry ceiling when caller config is %s', async (requestedRetries) => {
    const root = makeRoot();
    const generate = vi.fn(async () => { throw new Error('503 service unavailable'); });
    const provider = { name: 'meta', model: 'muse-spark-1.3', maxApplicationRetries: 0, generate } as unknown as IProvider;
    const result = await runAgent(
      provider, baseAgent(['task_complete'], 1), task(), root, 0,
      undefined, undefined,
      { allowPartialSuccess: false, ...(requestedRetries === undefined ? {} : { maxProviderRetries: requestedRetries }) },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('503 service unavailable');
  });

  it('holds queued whole-task retries for runtimes with an explicit zero retry cap', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.maos', 'queue', 'pending'), { recursive: true });
    const taskFile = {
      id: 'meta-retry-task', agent: 'META_AGENT', filePath: path.join(root, '.maos', 'queue', 'active', 'meta-retry-task.md'),
    } as TaskFile;
    const queued = enqueueRetry(taskFile, 'synthetic task', '503 provider unavailable', [], 0, {
      maxRetries: 2, initialDelayMs: 0, backoffMultiplier: 2,
    }, root);

    expect(queued).not.toBeNull();
    expect(drainRetryQueue(root, new Set(['META_AGENT']))).toBe(0);
    expect(getRetryQueueStatus(root)).toHaveLength(1);
    expect(drainRetryQueue(root)).toBe(1);
    expect(getRetryQueueStatus(root)).toHaveLength(0);
  });
});
