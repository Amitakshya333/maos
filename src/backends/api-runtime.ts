/**
 * MAOS API Runtime
 *
 * Wraps the existing IProvider + agent-runner tool-calling loop
 * as an IRuntime implementation. This is what MAOS already does —
 * just exposed through the universal runtime interface.
 *
 * Zero behavior change from existing code. All the context compression,
 * semantic progress tracking, and auto-nudge logic lives in agent-runner.ts.
 * This is a thin adapter.
 */

import { IRuntime, RuntimeTask, RuntimeResult, RuntimeCapabilityProfile } from './runtime';
import { IProvider, ProviderConfig } from './provider';
import { runAgent, AgentConfig, AgentTask } from '../core/agent-runner';
import { MessageBus, createEvent } from '../core/message-bus';

export interface ApiRuntimeConfig {
  /** Provider instance (OpenAI, Anthropic, Gemini, etc.) */
  provider: IProvider;

  /** Agent role (planner, coder, designer, reviewer) */
  role: string;

  /** Agent capabilities */
  capabilities: string[];

  /** Optional role-specific instructions appended to the standard MAOS prompt */
  systemPrompt?: string;

  /** Optional least-privilege tool allowlist */
  allowedTools?: string[];

  /** Max tool-calling iterations */
  maxIterations: number;

  /** Cost per million tokens for this provider */
  costPerMillionTokens: number;
}

export class ApiRuntime implements IRuntime {
  readonly type = 'api' as const;
  readonly name: string;
  readonly model: string;

  constructor(
    private config: ApiRuntimeConfig,
    private bus: MessageBus,
  ) {
    this.name = config.provider.name;
    this.model = config.provider.model;
  }

  async execute(task: RuntimeTask): Promise<RuntimeResult> {
    // Build agent config (same shape as before)
    const agentConfig: AgentConfig = {
      id: task.agentId,
      role: this.config.role,
      provider: this.name,
      model: this.model,
      capabilities: this.config.capabilities,
      systemPrompt: this.config.systemPrompt,
      allowedTools: this.config.allowedTools,
      scope: task.scope,
      maxIterations: this.config.maxIterations,
    };

    const agentTask: AgentTask = {
      id: task.id,
      description: task.description,
      branch: task.branch,
    };

    try {
      // Run the existing agent loop (all the smart stuff is in agent-runner.ts)
      const result = await runAgent(
        this.config.provider,
        agentConfig,
        agentTask,
        task.projectRoot,
        this.config.costPerMillionTokens,
        (iteration, action) => {
          // Emit progress events to the bus (these are unique to API runtimes)
          this.bus.emit(
            createEvent(
              'TASK_PROGRESS',
              task.agentId,
              {
                iteration,
                action,
                provider: this.name,
              },
              task.id,
              'api',
            ),
          );
        },
      );

      // Map AgentRunResult -> RuntimeResult
      return {
        success: result.success,
        summary: result.summary,
        filesChanged: result.filesChanged,
        iterations: result.iterations,
        totalTokens: result.totalTokens,
        costUSD: result.costUSD,
        latencyMs: result.latencyMs,
        runtimeType: 'api',
        error: result.error,
        taskResult: result.taskResult,
        exitCode: result.exitCode,
      };
    } catch (err: any) {
      return {
        success: false,
        summary: `API runtime error: ${err.message}`,
        filesChanged: [],
        iterations: 0,
        totalTokens: 0,
        costUSD: 0,
        latencyMs: 0,
        runtimeType: 'api',
        error: err.message,
        taskResult: 'failed',
        exitCode: 1,
      };
    }
  }

  getCapabilityProfile(): RuntimeCapabilityProfile {
    return {
      runtimeId: 'api-runtime', // overridden by orchestrator per agent
      runtimeType: 'api',
      provider: this.name,
      supportsTools: true,
      supportsCodeMutation: true,
      supportsLongContext: true, // API models typically handle large contexts
      supportsStreaming: false, // MAOS uses non-streaming tool-calling
      supportsParallelism: false, // one task per agent instance
      estimatedAvgLatencyMs: 60_000, // 60s typical for tool-calling chains
      estimatedCostPerTask: 0.05, // ~$0.05 rough hint; real values from telemetry
      concurrencyLimit: 1,
    };
  }

  async dispose(): Promise<void> {
    this.bus.emit(
      createEvent('AGENT_DISPOSED', 'api-runtime', {
        provider: this.name,
      }),
    );
    // No resources to clean up for API runtimes
  }
}
