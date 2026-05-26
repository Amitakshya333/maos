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

import { IRuntime, RuntimeTask, RuntimeResult } from './runtime';
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
    // Emit TASK_STARTED
    this.bus.emit(createEvent('TASK_STARTED', task.agentId, {
      taskId: task.id,
      provider: this.name,
      model: this.model,
    }, task.id, 'api'));

    // Build agent config (same shape as before)
    const agentConfig: AgentConfig = {
      id: task.agentId,
      role: this.config.role,
      provider: this.name,
      model: this.model,
      capabilities: this.config.capabilities,
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
          // Emit progress events to the bus
          this.bus.emit(createEvent('TASK_PROGRESS', task.agentId, {
            iteration,
            action,
            provider: this.name,
          }, task.id, 'api'));
        },
      );

      // Emit completion event
      const eventType = result.success ? 'TASK_COMPLETED' : 'TASK_FAILED';
      this.bus.emit(createEvent(eventType, task.agentId, {
        summary: result.summary,
        filesChanged: result.filesChanged,
        iterations: result.iterations,
        totalTokens: result.totalTokens,
        costUSD: result.costUSD,
        latencyMs: result.latencyMs,
      }, task.id, 'api'));

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
      };
    } catch (err: any) {
      // Emit failure
      this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
        error: err.message,
      }, task.id, 'api'));

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
      };
    }
  }

  async dispose(): Promise<void> {
    this.bus.emit(createEvent('AGENT_DISPOSED', 'api-runtime', {
      provider: this.name,
    }));
    // No resources to clean up for API runtimes
  }
}
