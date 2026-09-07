import { IProvider, ChatMessage } from '../backends/provider';
import { AGENT_TOOLS, executeTool } from '../integrations/tools';
import { Logger, createLogger } from '../utils/logger';
import { getFileLockRegistry } from './scope-guard';
import { saveCheckpoint, deleteCheckpoint, TaskCheckpoint } from './checkpoint';
import { getMessageBus, createEvent } from './message-bus';
import { getBrainContext } from './brain';
import { getMemoryStore } from './context-memory';
import { ProgressTracker } from './progress-tracker';
import { compressContext, snapshotFilesystem, getChangedFiles, retryOnTransient } from './context-manager';

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
  systemPrompt?: string;
  allowedTools?: string[];
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
  taskResult?: 'success' | 'no_mutation' | 'partial_success' | 'failed';
  exitCode?: number;
}

// ---- Constants ----
const CONTEXT_TOKEN_LIMIT = 60_000; // Compress context when exceeding this
const NUDGE_AT_PERCENT = 0.8; // Nudge agent to finish at 80% of iteration budget
const MAX_BONUS_ITERATIONS = 5; // Extra iterations granted for productive agents

function buildSystemPrompt(agent: AgentConfig, task: AgentTask, projectRoot: string): string {
  // ---- BRAIN INJECTION ----
  // If brain has been initialized, inject compact project context.
  // This saves the agent 2-5 exploration iterations.
  let brainSection = '';
  try {
    const brainCtx = getBrainContext(projectRoot);
    if (brainCtx) {
      brainSection = `\n\n${brainCtx}\n`;
    }
  } catch {
    /* brain not available — non-fatal */
  }

  // ---- CONTEXT MEMORY INJECTION ----
  // Inject recent team memories so this agent benefits from other agents' discoveries.
  let memorySection = '';
  try {
    const memStore = getMemoryStore();
    if (memStore && memStore.size > 0) {
      const memCtx = memStore.getForPrompt(agent.id);
      if (memCtx) {
        memorySection = memCtx;
      }
    }
  } catch {
    /* memory not available — non-fatal */
  }

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
${brainSection}${memorySection}
## Your Task
${task.description}

## Rules
1. FIRST, use read_file and list_dir to understand the existing codebase.
2. Follow the project's existing patterns, conventions, and code style.
3. Write clean, production-quality code. No placeholder comments like "TODO" or "implement later".
4. After completing your work, use git_commit with a descriptive message.
5. Finally, call task_complete with a summary of what you accomplished.
6. Do NOT merge to main. Leave your work on branch: ${task.branch}
7. Use share_knowledge to share important discoveries with other agents (tech stack, patterns, constraints).

## Important
- You have a maximum of ${agent.maxIterations} tool calls. Be efficient.
- If you get stuck, commit what you have and call task_complete with a partial summary.
- Read before you write. Always check existing files first.
- ALWAYS call task_complete when you are done. This is mandatory.
- Do NOT re-read files you already read unless they changed.`;
}

/**
 * Run an agent on a task.
 *
 * Agentic loop with:
 * - Sliding context window (prevents token explosion)
 * - Productive iteration detection (extends budget for working agents)
 * - Auto-nudge at 80% budget (forces task_complete)
 * - Partial success detection (files changed = success even without task_complete)
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
  let lastSnapshot = snapshotFilesystem(projectRoot);
  let hadMutatingToolCall = false;
  let bonusIterationsGranted = 0;
  let nudgeSent = false;
  const initialSnapshot = lastSnapshot;

  // Semantic progress tracker -- smarter than blunt file-count diffing
  const progress = new ProgressTracker();

  // File lock cleanup: release all locks held by this agent when done
  const releaseLocks = () => {
    const released = getFileLockRegistry().releaseAll(agent.id);
    if (released > 0) {
      logger.debug(agent.id, `Released ${released} file lock(s)`);
    }
  };

  // Build conversation
  const systemPrompt = buildSystemPrompt(agent, task, projectRoot);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Please complete this task:\n\n${task.description}` },
  ];

  logger.info(agent.id, `Starting task: ${task.id}`);
  logger.info(agent.id, `Branch: ${task.branch} | Model: ${provider.name}/${provider.model}`);

  // Effective max = base + bonus for productive agents
  const getEffectiveMax = () => agent.maxIterations + bonusIterationsGranted;

  try {
    while (iterations < getEffectiveMax()) {
      iterations++;
      onProgress?.(iterations, 'thinking');

      // ---- HEARTBEAT (every 5 iterations) ----
      // Emitted so the HealthMonitor knows the agent is alive.
      if (iterations % 5 === 0) {
        try {
          getMessageBus().emit(
            createEvent(
              'HEARTBEAT',
              agent.id,
              { iteration: iterations, maxIterations: getEffectiveMax(), totalTokens },
              task.id,
              'api',
            ),
          );
        } catch {
          /* non-fatal */
        }
      }

      // ---- CONTEXT COMPRESSION ----
      // If estimated tokens are too high, compress old messages
      if (totalTokens > CONTEXT_TOKEN_LIMIT) {
        compressContext(messages, logger, agent.id);
      }

      // ---- AUTO-NUDGE at 80% budget ----
      if (!nudgeSent && iterations >= Math.floor(getEffectiveMax() * NUDGE_AT_PERCENT)) {
        const remaining = getEffectiveMax() - iterations;
        logger.info(agent.id, `Budget warning: ${remaining} iterations remaining. Nudging to finalize.`);
        messages.push({
          role: 'user',
          content: `IMPORTANT: You have only ${remaining} iterations remaining. Please wrap up your work NOW. Commit any changes with git_commit and then call task_complete with a summary. Do not start new work.`,
        });
        nudgeSent = true;
      }

      // Call the model (with retry for transient errors including 504)
      const response = await retryOnTransient(
        () => provider.generate(messages, AGENT_TOOLS),
        3, // 3 retries for 504/timeout resilience
        logger,
        agent.id,
      );
      totalTokens += response.usage.totalTokens;

      logger.debug(
        agent.id,
        `Iteration ${iterations}/${getEffectiveMax()}: ${response.usage.totalTokens} tokens, ${response.latencyMs}ms (total: ${totalTokens})`,
      );

      // Add assistant message
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      // If no tool calls and model stopped -> nudge to call task_complete
      if (response.toolCalls.length === 0) {
        if (response.finishReason === 'stop') {
          // Give the model a chance to call task_complete properly
          logger.warn(agent.id, 'Model stopped without calling task_complete -- nudging to finalize');
          messages.push({
            role: 'user',
            content:
              'You stopped without calling task_complete. Please call task_complete now with a summary of what you accomplished and the list of files you changed. If you cannot complete the task, still call task_complete with a partial summary.',
          });

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
              try {
                tcArgs = JSON.parse(tc.function.arguments);
              } catch {
                tcArgs = {};
              }
              const { result, isComplete: done } = executeTool(
                tc.function.name,
                tcArgs,
                projectRoot,
                agent.scope,
                agent.id,
                task.id,
              );
              messages.push({ role: 'tool', name: tc.function.name, content: result, tool_call_id: tc.id });
              if (done) {
                logger.success(agent.id, `Task completed (after nudge): ${tcArgs.summary || 'Task completed'}`);
                deleteCheckpoint(projectRoot, task.id);
                return {
                  agentId: agent.id,
                  taskId: task.id,
                  success: true,
                  summary: tcArgs.summary || 'Task completed',
                  filesChanged: tcArgs.files_changed || [],
                  iterations,
                  totalTokens,
                  costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
                  latencyMs: Date.now() - startTime,
                };
              }
            }
          }
          // Still didn't call task_complete -- break out
          logger.warn(agent.id, 'Model still did not call task_complete after nudge. Treating as partial completion.');
          break;
        }
        // Model returned content but no tools -- continue
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

        // Track mutating tool calls as progress signals (for bonus iterations)
        if (toolName === 'write_file' || toolName === 'run_command' || toolName === 'git_commit') {
          hadMutatingToolCall = true;
          // Emit TASK_PROGRESS so HealthMonitor counts this as an implicit heartbeat
          try {
            getMessageBus().emit(
              createEvent(
                'TASK_PROGRESS',
                agent.id,
                {
                  tool: toolName,
                  iteration: iterations,
                  file: args.path || args.command || undefined,
                },
                task.id,
                'api',
              ),
            );
          } catch {
            /* non-fatal */
          }
        }

        const { result, isComplete: done } = executeTool(toolName, args, projectRoot, agent.scope, agent.id, task.id);

        // Truncate huge tool results to prevent context bloat
        const truncatedResult =
          result.length > 8000 ? result.substring(0, 8000) + '\n... [truncated, showing first 8000 chars]' : result;

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          name: toolName,
          content: truncatedResult,
          tool_call_id: toolCall.id,
        });

        if (done) {
          isComplete = true;
          completionSummary = args.summary || 'Task completed';
          completionFiles = args.files_changed || [];
        }
      }

      // If task_complete was called, we're done
      if (isComplete) {
        logger.success(agent.id, `Task completed: ${completionSummary}`);
        deleteCheckpoint(projectRoot, task.id);
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

      // ---- SEMANTIC PROGRESS / IDLE DETECTION ----
      const currentSnapshot = snapshotFilesystem(projectRoot);
      const filesChanged = currentSnapshot !== lastSnapshot;

      // Build tool call list for the tracker
      const toolCallsForTracker = response.toolCalls.map((tc) => {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* skip */
        }
        return { name: tc.function.name, args };
      });

      const productive = progress.recordIteration(toolCallsForTracker);

      if (filesChanged) {
        lastSnapshot = currentSnapshot;
      }

      if (productive || filesChanged) {
        // Grant bonus iterations only for actual mutations
        if (hadMutatingToolCall && bonusIterationsGranted < MAX_BONUS_ITERATIONS) {
          bonusIterationsGranted++;
          logger.debug(agent.id, `Productive mutation. Budget extended to ${getEffectiveMax()}`);
        }
      } else {
        logger.debug(agent.id, `Idle iteration ${progress.idleCount}/${6}. ${progress.statusLine()}`);
        if (progress.isStuck()) {
          logger.warn(
            agent.id,
            `Circuit breaker: agent truly stuck (no new files, no new searches, no new dirs, repeated calls). Stopping. ${progress.statusLine()}`,
          );
          break; // Fall through to partial-success check below
        }
      }

      // ---- CHECKPOINT SAVE (every iteration) ----
      // Snapshot current progress to disk so we can recover if MAOS crashes.
      try {
        const changedFiles = getChangedFiles(projectRoot, initialSnapshot);
        const cp: TaskCheckpoint = {
          taskId: task.id,
          agentId: agent.id,
          iteration: iterations,
          maxIterations: getEffectiveMax(),
          progressPct: iterations / getEffectiveMax(),
          totalTokens,
          filesChanged: changedFiles,
          lastToolCalls: response.toolCalls.map((tc) => {
            let args: Record<string, any> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              /* skip */
            }
            return { name: tc.function.name, summary: JSON.stringify(args).substring(0, 100) };
          }),
          wasProductive: productive || filesChanged,
          idleCount: progress.idleCount,
          costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
          savedAt: Date.now(),
          startedAt: startTime,
          progressSummary: `Iteration ${iterations}/${getEffectiveMax()}: ${changedFiles.length} files changed, ${totalTokens} tokens used`,
          retryCount: 0,
        };
        saveCheckpoint(projectRoot, cp);
      } catch {
        // Checkpoint save failure is non-fatal — don't crash the agent
      }
    }

    // ---- PARTIAL SUCCESS DETECTION ----
    // Agent exited loop without task_complete. Check if it actually did useful work.
    const finalSnapshot = snapshotFilesystem(projectRoot);
    const madeProgress = finalSnapshot !== initialSnapshot;

    if (madeProgress) {
      logger.warn(agent.id, `Agent did not call task_complete but DID modify files. Treating as partial success.`);
      return {
        agentId: agent.id,
        taskId: task.id,
        success: true,
        summary: `Partial completion: agent modified files but did not finalize (${iterations} iterations)`,
        filesChanged: [],
        iterations,
        totalTokens,
        costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
        latencyMs: Date.now() - startTime,
      };
    }

    logger.warn(agent.id, `Max iterations (${getEffectiveMax()}) reached with no file changes`);
    return {
      agentId: agent.id,
      taskId: task.id,
      success: false,
      summary: `Reached max iterations (${getEffectiveMax()}) without completing`,
      filesChanged: [],
      iterations,
      totalTokens,
      costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
      latencyMs: Date.now() - startTime,
      error: 'MAX_ITERATIONS',
    };
  } catch (err: any) {
    // ---- GRACEFUL FAILURE WITH PARTIAL SUCCESS ----
    const crashSnapshot = snapshotFilesystem(projectRoot);
    const crashedButWorked = crashSnapshot !== initialSnapshot;

    if (crashedButWorked) {
      logger.warn(agent.id, `Agent crashed but DID modify files. Treating as partial success. Error: ${err.message}`);
      return {
        agentId: agent.id,
        taskId: task.id,
        success: true,
        summary: `Partial completion (crashed): agent modified files before error (${iterations} iterations). Error: ${err.message}`,
        filesChanged: [],
        iterations,
        totalTokens,
        costUSD: (totalTokens / 1_000_000) * costPerMillionTokens,
        latencyMs: Date.now() - startTime,
      };
    }

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
  } finally {
    // ALWAYS release file locks when the agent finishes (success or failure)
    releaseLocks();
  }
}
