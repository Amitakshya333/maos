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
  let lastSnapshot = snapshotFilesystem(projectRoot);
  let hadMutatingToolCall = false; // Track if write_file/run_command was called

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

      // Call the model (with retry for transient errors)
      const response = await retryOnTransient(
        () => provider.generate(messages, AGENT_TOOLS),
        2, // max retries
        logger,
        agent.id,
      );
      totalTokens += response.usage.totalTokens;

      logger.debug(agent.id, `Iteration ${iterations}: ${response.usage.totalTokens} tokens, ${response.latencyMs}ms`);

      // Add assistant message with tool calls to the conversation history
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      // If no tool calls and model stopped → nudge to call task_complete
      if (response.toolCalls.length === 0) {
        if (response.finishReason === 'stop') {
          // Give the model a chance to call task_complete properly
          logger.warn(agent.id, 'Model stopped without calling task_complete — nudging to finalize');
          messages.push({
            role: 'user',
            content: 'You stopped without calling task_complete. Please call task_complete now with a summary of what you accomplished and the list of files you changed. If you cannot complete the task, still call task_complete with a partial summary.',
          });

          // Try one more time
          const retryResponse = await retryOnTransient(
            () => provider.generate(messages, AGENT_TOOLS),
            1,
            logger,
            agent.id,
          );
          totalTokens += retryResponse.usage.totalTokens;

          messages.push({
            role: 'assistant',
            content: retryResponse.content,
            tool_calls: retryResponse.toolCalls.length > 0 ? retryResponse.toolCalls : undefined,
          });

          // Check if it called task_complete this time
          if (retryResponse.toolCalls.length > 0) {
            for (const tc of retryResponse.toolCalls) {
              let tcArgs: Record<string, any>;
              try { tcArgs = JSON.parse(tc.function.arguments); } catch { tcArgs = {}; }
              const { result, isComplete: done } = executeTool(tc.function.name, tcArgs, projectRoot, agent.scope);
              messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
              if (done) {
                logger.success(agent.id, `Task completed (after nudge): ${tcArgs.summary || 'Task completed'}`);
                return {
                  agentId: agent.id, taskId: task.id, success: true,
                  summary: tcArgs.summary || 'Task completed',
                  filesChanged: tcArgs.files_changed || [],
                  iterations, totalTokens,
                  costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
                  latencyMs: Date.now() - startTime,
                };
              }
            }
          }
          // Still didn't call task_complete — break out
          logger.warn(agent.id, 'Model still did not call task_complete after nudge. Treating as partial completion.');
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
      hadMutatingToolCall = false;

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

        // Track mutating tool calls as progress signals
        if (toolName === 'write_file' || toolName === 'run_command' || toolName === 'git_commit') {
          hadMutatingToolCall = true;
        }

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

      // If task_complete was called, we're done (check BEFORE circuit breaker)
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

      // Check for stuck detection (circuit breaker)
      // Uses BOTH filesystem snapshots AND tool call tracking
      const currentSnapshot = snapshotFilesystem(projectRoot);
      const filesChanged = currentSnapshot !== lastSnapshot;

      if (filesChanged || hadMutatingToolCall) {
        // Progress detected — reset counter
        idleIterations = 0;
        lastSnapshot = currentSnapshot;
      } else {
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
      }
    }

    // Max iterations reached OR model stopped without task_complete
    // Check if the agent actually made progress (files changed on disk)
    const finalSnapshot = snapshotFilesystem(projectRoot);
    const madeProgress = finalSnapshot !== lastSnapshot;

    if (madeProgress) {
      logger.warn(agent.id, `Agent did not call task_complete but DID modify files. Treating as partial success.`);
      return {
        agentId: agent.id,
        taskId: task.id,
        success: true, // Partial success — work was done
        summary: `Partial completion: agent modified files but did not finalize (${iterations} iterations)`,
        filesChanged: [],
        iterations,
        totalTokens,
        costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
        latencyMs: Date.now() - startTime,
      };
    }

    logger.warn(agent.id, `Max iterations (${agent.maxIterations}) reached with no file changes`);
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
 * Snapshot the filesystem state for stuck detection.
 * Returns a hash based on file count + total modification time.
 * 
 * Uses recursive filesystem walk instead of `git ls-files` because:
 * - Files created via `run_command` are untracked and invisible to git ls-files
 * - We need to detect ALL filesystem changes, not just git-tracked ones
 */
function snapshotFilesystem(dir: string): number {
  try {
    const fs = require('fs');
    const path = require('path');
    let hash = 0;
    let count = 0;

    function walk(d: string, depth: number) {
      if (depth > 6) return; // Don't recurse too deep
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          // Skip hidden dirs, node_modules, .git, .maos
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile()) {
            count++;
            try {
              const stat = fs.statSync(full);
              hash += stat.mtimeMs + stat.size;
            } catch { /* skip */ }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }

    walk(dir, 0);
    return count * 100000 + Math.round(hash % 1_000_000_000);
  } catch {
    return 0;
  }
}

/**
 * Retry a function on transient errors (rate limits, server errors, connection errors).
 * Uses exponential backoff: 2s, 4s between retries.
 */
async function retryOnTransient<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  logger: Logger,
  agentId: string,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isTransient =
        err.message?.includes('429') ||
        err.message?.includes('rate limit') ||
        err.message?.includes('Rate limit') ||
        err.message?.includes('500') ||
        err.message?.includes('502') ||
        err.message?.includes('503') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('timed out') ||
        err.message?.includes('Request timed out') ||
        err.message?.includes('Empty or malformed response');

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const delayMs = (attempt + 1) * 2000; // 2s, 4s
      logger.warn(agentId, `Transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry failed');
}
