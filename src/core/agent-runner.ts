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

// ---- Constants ----
const CONTEXT_TOKEN_LIMIT = 60_000;  // Compress context when exceeding this
const NUDGE_AT_PERCENT = 0.80;       // Nudge agent to finish at 80% of iteration budget
const MAX_BONUS_ITERATIONS = 5;      // Extra iterations granted for productive agents

// ---- SEMANTIC PROGRESS TRACKER ----

/**
 * Tracks whether the agent is making genuine progress vs spinning in place.
 *
 * Progress is detected when the agent:
 *   - Reads a file it has never read before
 *   - Lists a directory it has never listed before
 *   - Runs a search query it has never run before
 *   - Uses a write/exec/commit tool (always productive)
 *   - Calls a diverse mix of tool types
 *
 * Idle is ONLY counted when:
 *   - Repeated identical reads (same path, same content)
 *   - Repeated identical searches (same query)
 *   - No new files/directories discovered
 *   - No tool diversity (same tool called repeatedly)
 *   - No state progression whatsoever
 */
class ProgressTracker {
  private seenFiles = new Set<string>();       // Files already read
  private seenDirs = new Set<string>();        // Dirs already listed
  private seenSearches = new Set<string>();    // Search queries already run
  private toolCallsThisIteration = new Set<string>(); // Tool types this iteration
  private lastIterationTools: string[] = [];   // Tool names from last iteration

  idleCount = 0;
  private readonly MAX_IDLE = 6;

  /**
   * Record all tool calls from one iteration and return whether this
   * iteration was productive (true) or idle (false).
   */
  recordIteration(toolCalls: Array<{ name: string; args: Record<string, any> }>): boolean {
    this.toolCallsThisIteration.clear();
    let newContextDiscovered = false;
    let hasMutatingCall = false;
    const thisIterToolNames: string[] = [];

    for (const { name, args } of toolCalls) {
      this.toolCallsThisIteration.add(name);
      thisIterToolNames.push(name);

      switch (name) {
        case 'read_file': {
          const p = (args.path || '').toLowerCase().trim();
          if (p && !this.seenFiles.has(p)) {
            this.seenFiles.add(p);
            newContextDiscovered = true; // New file = new context
          }
          break;
        }
        case 'list_dir': {
          const d = (args.path || '.').toLowerCase().trim();
          if (!this.seenDirs.has(d)) {
            this.seenDirs.add(d);
            newContextDiscovered = true; // New directory = new context
          }
          break;
        }
        case 'search_code': {
          // Normalize query for dedup
          const q = (args.query || '').toLowerCase().trim().substring(0, 80);
          if (q && !this.seenSearches.has(q)) {
            this.seenSearches.add(q);
            newContextDiscovered = true; // New search = new context
          }
          break;
        }
        case 'write_file':
        case 'run_command':
        case 'git_commit':
          hasMutatingCall = true; // Always productive
          newContextDiscovered = true;
          break;
      }
    }

    // Tool diversity: using different tool types from last iteration = exploration
    const toolDiversitySignal = !this.arraysIdentical(thisIterToolNames, this.lastIterationTools)
      && thisIterToolNames.length > 0;
    this.lastIterationTools = thisIterToolNames;

    const productive = hasMutatingCall || newContextDiscovered || toolDiversitySignal;

    if (productive) {
      this.idleCount = 0;
    } else {
      this.idleCount++;
    }

    return productive;
  }

  isStuck(): boolean {
    return this.idleCount >= this.MAX_IDLE;
  }

  statusLine(): string {
    return `files_seen=${this.seenFiles.size} dirs_seen=${this.seenDirs.size} searches_seen=${this.seenSearches.size} idle=${this.idleCount}/${this.MAX_IDLE}`;
  }

  private arraysIdentical(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
}


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

      logger.debug(agent.id, `Iteration ${iterations}/${getEffectiveMax()}: ${response.usage.totalTokens} tokens, ${response.latencyMs}ms (total: ${totalTokens})`);

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
            content: 'You stopped without calling task_complete. Please call task_complete now with a summary of what you accomplished and the list of files you changed. If you cannot complete the task, still call task_complete with a partial summary.',
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
        }

        const { result, isComplete: done } = executeTool(
          toolName,
          args,
          projectRoot,
          agent.scope,
        );

        // Truncate huge tool results to prevent context bloat
        const truncatedResult = result.length > 8000
          ? result.substring(0, 8000) + '\n... [truncated, showing first 8000 chars]'
          : result;

        // Add tool result to conversation
        messages.push({
          role: 'tool',
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
      const toolCallsForTracker = response.toolCalls.map(tc => {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* skip */ }
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
          logger.warn(agent.id, `Circuit breaker: agent truly stuck (no new files, no new searches, no new dirs, repeated calls). Stopping. ${progress.statusLine()}`);
          break; // Fall through to partial-success check below
        }
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
  }
}

// ---- CONTEXT COMPRESSION ----

/**
 * Sliding context window: when conversation gets too large,
 * compress older messages into a summary, keeping:
 * - System prompt (always)
 * - Last 6 message pairs (recent context)
 * - A compressed summary of everything in between
 */
function compressContext(messages: ChatMessage[], logger: Logger, agentId: string): void {
  // Keep at least system + user + 12 recent messages (6 pairs)
  const KEEP_RECENT = 12;
  if (messages.length <= KEEP_RECENT + 2) return;

  const systemMsg = messages[0]; // System prompt
  const recentMessages = messages.slice(-KEEP_RECENT);
  const middleMessages = messages.slice(1, messages.length - KEEP_RECENT);

  // Build a compressed summary of the middle messages
  const summaryParts: string[] = [];
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  let toolCallCount = 0;

  for (const msg of middleMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallCount++;
        try {
          const args = JSON.parse(tc.function.arguments);
          switch (tc.function.name) {
            case 'read_file': filesRead.add(args.path); break;
            case 'write_file': filesWritten.add(args.path); break;
            case 'run_command': commandsRun.push(args.command?.substring(0, 80)); break;
            case 'list_dir': filesRead.add(`DIR:${args.path}`); break;
          }
        } catch { /* skip */ }
      }
    }
  }

  if (filesRead.size > 0) summaryParts.push(`Files read: ${[...filesRead].join(', ')}`);
  if (filesWritten.size > 0) summaryParts.push(`Files written: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) summaryParts.push(`Commands run: ${commandsRun.slice(-5).join('; ')}`);
  summaryParts.push(`Total tool calls compressed: ${toolCallCount}`);

  const compressedSummary: ChatMessage = {
    role: 'user',
    content: `[CONTEXT COMPRESSED - Previous ${middleMessages.length} messages summarized]\n${summaryParts.join('\n')}\n\nContinue your current task. The recent messages below are the most relevant context.`,
  };

  // Replace messages array in-place
  messages.length = 0;
  messages.push(systemMsg, compressedSummary, ...recentMessages);

  logger.info(agentId, `Context compressed: ${middleMessages.length} messages -> 1 summary. Keeping ${KEEP_RECENT} recent.`);
}

// ---- FILESYSTEM SNAPSHOT ----

/**
 * Snapshot the filesystem state for stuck detection.
 * Returns a hash based on file count + total modification time.
 */
function snapshotFilesystem(dir: string): number {
  try {
    const fs = require('fs');
    const path = require('path');
    let hash = 0;
    let count = 0;

    function walk(d: string, depth: number) {
      if (depth > 6) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
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

// ---- RETRY WITH EXPONENTIAL BACKOFF ----

/**
 * Retry on transient errors with exponential backoff.
 * Handles: 429 rate limits, 500/502/503/504 server errors,
 * connection resets, timeouts, and malformed responses.
 * 
 * Backoff: 3s, 6s, 12s (doubles each attempt)
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
      const msg = err.message || '';
      const isTransient =
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('Rate limit') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('Gateway') ||
        msg.includes('gateway') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EPIPE') ||
        msg.includes('timed out') ||
        msg.includes('Request timed out') ||
        msg.includes('timeout') ||
        msg.includes('Timeout') ||
        msg.includes('Empty or malformed response') ||
        msg.includes('socket hang up') ||
        msg.includes('network');

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff: 3s, 6s, 12s
      const delayMs = 3000 * Math.pow(2, attempt);
      logger.warn(agentId, `Transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.substring(0, 120)}. Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry failed');
}
