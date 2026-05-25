import { IProvider, ChatMessage } from '../backends/provider';
import { AGENT_TOOLS, executeTool } from '../integrations/tools';
import { Logger, createLogger } from '../utils/logger';

/**
 * Agent configuration passed to the runner.
 */
export interface AgentConfig {
  id: string;
  role: string;
  provider: string;
  model: string;
  capabilities: string[];
  scope: string[];
  maxIterations: number;
}

/**
 * Task to execute.
 */
export interface AgentTask {
  id: string;
  description: string;
  branch: string;
}

/**
 * Result of an agent run.
 */
export interface AgentRunResult {
  agentId: string;
  taskId: string;
  success: boolean;
  summary: string;
  filesChanged: string[];
  iterations: number;
  totalTokens: number;
  costUSD: number;
  latencyMs: number;
  error?: string;
}

/**
 * Build the system prompt for an agent.
 */
function buildSystemPrompt(agent: AgentConfig, task: AgentTask, projectRoot: string): string {
  return `You are ${agent.id}, a ${agent.role} agent working on this project.

## Your Identity
- Agent ID: ${agent.id}
- Role: ${agent.role}
- Model: ${agent.provider}/${agent.model}
- Capabilities: ${agent.capabilities.join(', ')}

## Your Scope
You may ONLY modify files in: [${agent.scope.join(', ')}]
You are on git branch: ${task.branch}
Project root: ${projectRoot}
DO NOT touch files outside your scope. The system will reject out-of-scope writes.

## Your Task
${task.description}

## Rules
1. FIRST, use read_file and list_dir to understand the existing codebase.
2. Follow the project's existing patterns, conventions, and code style.
3. Write clean, production-quality code. No placeholder comments like "TODO" or "implement later".
4. After completing your work, use git_commit with a descriptive message.
5. Finally, call task_complete with a summary of what you accomplished.
6. Do NOT merge to main. Leave your work on branch: ${task.branch}

## Important
- You have a maximum of ${agent.maxIterations} tool calls. Be efficient.
- If you get stuck, commit what you have and call task_complete with a partial summary.
- Read before you write. Always check existing files first.`;
}

/**
 * Run an agent on a task.
 * 
 * This is the agentic loop:
 * 1. Send system prompt + task to the model
 * 2. Model responds with text or tool calls
 * 3. Execute tool calls, feed results back
 * 4. Repeat until task_complete is called or max iterations reached
 */
export async function runAgent(
  provider: IProvider,
  agent: AgentConfig,
  task: AgentTask,
  projectRoot: string,
  costPerMillionTokens: number,
  onProgress?: (iteration: number, action: string) => void,
): Promise<AgentRunResult> {
  const logger = createLogger(projectRoot);
  const startTime = Date.now();
  let totalTokens = 0;
  let iterations = 0;
  let idleIterations = 0; // Iterations with no file changes
  let lastFileCount = countFiles(projectRoot);

  // Build conversation
  const systemPrompt = buildSystemPrompt(agent, task, projectRoot);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Please complete this task:\n\n${task.description}` },
  ];

  logger.info(agent.id, `Starting task: ${task.id}`);
  logger.info(agent.id, `Branch: ${task.branch} | Model: ${provider.name}/${provider.model}`);

  try {
    while (iterations < agent.maxIterations) {
      iterations++;
      onProgress?.(iterations, 'thinking');

      // Call the model
      const response = await provider.generate(messages, AGENT_TOOLS);
      totalTokens += response.usage.totalTokens;

      logger.debug(agent.id, `Iteration ${iterations}: ${response.usage.totalTokens} tokens, ${response.latencyMs}ms`);

      // Add assistant message with tool calls to the conversation history
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      // If no tool calls and model stopped → done (shouldn't happen without task_complete)
      if (response.toolCalls.length === 0) {
        if (response.finishReason === 'stop') {
          logger.warn(agent.id, 'Model stopped without calling task_complete');
          break;
        }
        // Model returned content but no tools — continue
        messages.push({ role: 'user', content: 'Continue with your task. Use the available tools.' });
        continue;
      }

      // Process each tool call
      let isComplete = false;
      let completionSummary = '';
      let completionFiles: string[] = [];

      for (const toolCall of response.toolCalls) {
        let args: Record<string, any>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        const toolName = toolCall.function.name;
        onProgress?.(iterations, `tool:${toolName}`);
        logger.info(agent.id, `Tool: ${toolName}(${JSON.stringify(args).substring(0, 100)})`);

        const { result, isComplete: done } = executeTool(
          toolName,
          args,
          projectRoot,
          agent.scope,
        );

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });

        if (done) {
          isComplete = true;
          completionSummary = args.summary || 'Task completed';
          completionFiles = args.files_changed || [];
        }
      }

      // Check for stuck detection (circuit breaker)
      const currentFileCount = countFiles(projectRoot);
      if (currentFileCount === lastFileCount) {
        idleIterations++;
        if (idleIterations >= 5) {
          logger.warn(agent.id, `Circuit breaker: ${idleIterations} iterations with no file changes. Stopping.`);
          return {
            agentId: agent.id,
            taskId: task.id,
            success: false,
            summary: 'Agent stuck — no progress detected after 5 iterations',
            filesChanged: [],
            iterations,
            totalTokens,
            costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
            latencyMs: Date.now() - startTime,
            error: 'STUCK: No file changes detected',
          };
        }
      } else {
        idleIterations = 0;
        lastFileCount = currentFileCount;
      }

      // If task_complete was called, we're done
      if (isComplete) {
        logger.success(agent.id, `Task completed: ${completionSummary}`);
        return {
          agentId: agent.id,
          taskId: task.id,
          success: true,
          summary: completionSummary,
          filesChanged: completionFiles,
          iterations,
          totalTokens,
          costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    // Max iterations reached
    logger.warn(agent.id, `Max iterations (${agent.maxIterations}) reached without task_complete`);
    return {
      agentId: agent.id,
      taskId: task.id,
      success: false,
      summary: `Reached max iterations (${agent.maxIterations}) without completing`,
      filesChanged: [],
      iterations,
      totalTokens,
      costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
      latencyMs: Date.now() - startTime,
      error: 'MAX_ITERATIONS',
    };

  } catch (err: any) {
    logger.error(agent.id, `Agent error: ${err.stack || err.message}`);
    return {
      agentId: agent.id,
      taskId: task.id,
      success: false,
      summary: `Agent failed: ${err.message}`,
      filesChanged: [],
      iterations,
      totalTokens,
      costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

/**
 * Quick file count for stuck detection.
 * Cross-platform: counts lines from git ls-files directly in Node
 * instead of piping through wc (Unix-only).
 */
function countFiles(dir: string): number {
  try {
    const { execSync } = require('child_process');
    const output = execSync('git ls-files', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Count non-empty lines
    return output.split('\n').filter((line: string) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}
