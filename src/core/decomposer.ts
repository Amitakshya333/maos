import * as fs from 'fs';
import { IProvider, ChatMessage, ToolDef, ProviderResponse } from '../backends/provider';
import { createLogger } from '../utils/logger';
import { readTelemetry } from './telemetry';

/**
 * MAOS AI Task Decomposer
 *
 * Takes a high-level goal like "Build a todo app with auth and dark mode"
 * and uses an AI model (the ARCHITECT agent) to break it into atomic,
 * capability-tagged subtasks that the router can assign to the right agents.
 *
 * This is the "brain" of `maos plan` — the command that turns a one-liner
 * into a multi-agent build plan.
 *
 * Failure Modes (classified):
 *   - SCHEMA_FAILURE      : model returned something but it didn't match the expected shape
 *   - MALFORMED_RESPONSE  : JSON parse failed on tool args or extracted content block
 *   - EMPTY_PLAN          : model returned 0 tasks
 *   - PROVIDER_FAILURE    : network / auth / rate-limit error from the provider
 *   - UNSUPPORTED_TOOL_CALLING : provider does not support function calling at all
 */

// ─── Failure Classification ───────────────────────────────────

export type DecomposerFailureKind =
  'SCHEMA_FAILURE' | 'MALFORMED_RESPONSE' | 'EMPTY_PLAN' | 'PROVIDER_FAILURE' | 'UNSUPPORTED_TOOL_CALLING';

export class DecomposerError extends Error {
  readonly kind: DecomposerFailureKind;
  readonly rawResponse?: string;

  constructor(kind: DecomposerFailureKind, message: string, rawResponse?: string) {
    super(`Decomposer [${kind}]: ${message}`);
    this.name = 'DecomposerError';
    this.kind = kind;
    this.rawResponse = rawResponse;
  }
}

// ─── Types ────────────────────────────────────────────────────

export interface SubTask {
  /** Short title for the task */
  title: string;
  /** Detailed description of what to build */
  description: string;
  /** Which capabilities are needed (maps to agent capabilities) */
  requiredCapabilities: string[];
  /** Estimated complexity */
  complexity: 'low' | 'medium' | 'high';
  /** Task category for role-based routing */
  category: string;
  /** IDs of subtasks this depends on (empty = can start immediately) */
  dependsOn: string[];
  /** Suggested file paths this task will touch */
  suggestedFiles: string[];
}

export interface DecompositionResult {
  /** Original goal */
  goal: string;
  /** Generated subtasks */
  tasks: SubTask[];
  /** Total estimated complexity */
  estimatedComplexity: 'low' | 'medium' | 'high';
  /** Model used for decomposition */
  model: string;
  /** Tokens used for the decomposition call */
  tokensUsed: number;
  /** Latency in ms */
  latencyMs: number;
}

// ─── Decomposer Tool ──────────────────────────────────────────

/**
 * The decomposer uses a single structured tool call to get the model
 * to return well-formatted subtasks. This is more reliable than parsing
 * free-text output.
 */
const DECOMPOSE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_plan',
    description: 'Submit the decomposed task plan. Call this once with all subtasks.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of subtasks that together accomplish the goal',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short descriptive title (e.g., "Build Auth API")',
              },
              description: {
                type: 'string',
                description:
                  'Detailed instructions for the agent that will execute this task. Be specific about what to build, which files to create/modify, and acceptance criteria.',
              },
              requiredCapabilities: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Capabilities needed. Choose from: planning, coding, apis, database, refactoring, testing, design, css, frontend, layout, styling, review, debugging',
              },
              complexity: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Estimated complexity: low (< 5 files), medium (5-15 files), high (> 15 files)',
              },
              category: {
                type: 'string',
                description:
                  'Task category for routing. Choose from: backend, frontend, design, testing, planning, api, database, styling, devops',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Titles of other subtasks that must complete before this one can start. Empty array if no dependencies.',
              },
              suggestedFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths this task will likely create or modify',
              },
            },
            required: [
              'title',
              'description',
              'requiredCapabilities',
              'complexity',
              'category',
              'dependsOn',
              'suggestedFiles',
            ],
          },
        },
        estimatedComplexity: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Overall project complexity estimate',
        },
      },
      required: ['tasks', 'estimatedComplexity'],
    },
  },
};

// ─── System Prompt ────────────────────────────────────────────

function buildDecomposePrompt(
  goal: string,
  agentRoster: { id: string; role: string; capabilities: string[]; scope?: string[] }[],
  projectContext?: string,
  telemetryHint?: string,
): string {
  const rosterText = agentRoster
    .map((a) => {
      const scopeInfo = a.scope && a.scope.length > 0 ? ' | scope = [' + a.scope.join(', ') + ']' : '';
      return '  - ' + a.id + ' (' + a.role + '): capabilities = [' + a.capabilities.join(', ') + ']' + scopeInfo;
    })
    .join('\n');

  let telemetrySection = '';
  if (telemetryHint) {
    telemetrySection = '\n## Historical Performance Data\n' + telemetryHint + '\n';
  }

  return `You are MAOS ARCHITECT — an expert software architect who decomposes high-level goals into atomic, actionable subtasks for a team of AI coding agents.

## Available Agent Team
${rosterText}

## Your Task
Decompose the following goal into atomic subtasks. Each subtask should be:
1. **Atomic** — one agent can complete it independently
2. **Specific** — include exact file paths, function names, and acceptance criteria
3. **Capability-tagged** — tag each with the capabilities needed so the router assigns the right agent
4. **Dependency-aware** — mark which tasks must finish before others can start
5. **Realistic** — 3-8 subtasks for simple goals, 5-15 for complex ones
6. **Scope-aligned** — each task should only touch files within ONE agent's scope

## CRITICAL OUTPUT RULES
- You MUST call the submit_plan function/tool with ALL subtasks as a single structured JSON call.
- Do NOT write any prose, explanation, or markdown before or after the function call.
- Do NOT wrap the JSON in code fences or markdown blocks.
- The ONLY valid output is a single function call to submit_plan.
- If you cannot use a function call, return ONLY a raw JSON object matching this exact schema:
  {"tasks": [...], "estimatedComplexity": "low|medium|high"}
  No markdown. No prose. No backticks. Only the JSON object.

## Task Rules
- Each subtask should take an agent 1-5 tool iterations to complete
- Don't create "setup" tasks unless genuinely needed (the project may already exist)
- Frontend tasks should include specific component names, layouts, and styling requirements
- Backend tasks should include API endpoints, data models, and business logic
- Prefer parallel execution: minimize dependencies between tasks
- If a task is clearly suited for a specific agent role, tag its category accordingly
- DO NOT create tasks that require files spanning multiple agent scopes
- When suggesting file paths, keep them within the scope of the agent best suited for the task
${projectContext ? '\n## Current Project Context\n' + projectContext : ''}${telemetrySection}
## Goal
"${goal}"

Call the submit_plan tool with your decomposition. Be thorough but practical.`;
}

// ─── Main Decompose Function ──────────────────────────────────

/**
 * Decompose a high-level goal into capability-tagged subtasks.
 *
 * @param provider   - The AI provider to use for decomposition
 * @param goal       - The high-level goal (e.g., "Build a todo app with auth")
 * @param agents     - Agent roster from config (for context in the prompt)
 * @param cwd        - Project root for context scanning
 */
export async function decompose(
  provider: IProvider,
  goal: string,
  agents: { id: string; role: string; capabilities: string[]; scope?: string[] }[],
  cwd?: string,
): Promise<DecompositionResult> {
  const logger = createLogger(cwd);
  logger.info('DECOMPOSER', `Decomposing goal: "${goal}"`);

  // Scan project for context (if project exists)
  let projectContext: string | undefined;
  try {
    if (cwd) {
      const files = scanProjectFiles(cwd);
      if (files.length > 0) {
        projectContext = `Existing files in project:\n${files.map((f) => `  - ${f}`).join('\n')}`;
      }
    }
  } catch {
    // No project context available — that's fine
  }

  const systemPrompt = buildDecomposePrompt(goal, agents, projectContext, buildTelemetryHint(cwd));
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Decompose this goal into subtasks: "${goal}"` },
  ];

  // Call the model with the structured tool
  let response: ProviderResponse;
  try {
    response = await provider.generate(messages, [DECOMPOSE_TOOL]);
  } catch (err: any) {
    throw new DecomposerError('PROVIDER_FAILURE', err.message);
  }

  // ── DIAGNOSTIC: log the full raw response before any parsing ──
  logger.info('DECOMPOSER', `Model responded in ${response.latencyMs}ms, ${response.usage.totalTokens} tokens`);
  logger.info('DECOMPOSER', `Finish reason: ${response.finishReason}`);
  if (process.env.MAOS_DEBUG) {
    console.log('[DECOMPOSER] RAW RESPONSE CONTENT:', JSON.stringify(response.content, null, 2));
    console.log('[DECOMPOSER] RAW TOOL CALLS:', JSON.stringify(response.toolCalls, null, 2));
  }

  // ── Step 1: Try the happy path — model returned a proper tool call ──
  let planData: any;
  let extractionSource = 'tool_call';

  const planCall = response.toolCalls.find((tc) => tc.function.name === 'submit_plan');

  if (planCall) {
    // Model used the tool correctly — parse the arguments
    try {
      planData = JSON.parse(planCall.function.arguments);
    } catch (err) {
      const rawArgs = planCall.function.arguments;
      // Try to recover a JSON block from within the arguments string
      planData = tryExtractJsonFromString(rawArgs);
      if (!planData) {
        throw new DecomposerError(
          'MALFORMED_RESPONSE',
          `Failed to parse tool call arguments: ${err}. Arguments (first 500 chars): ${rawArgs.substring(0, 500)}`,
          rawArgs,
        );
      }
      logger.warn('DECOMPOSER', 'Tool call arguments were malformed JSON — recovered via extraction fallback');
    }
  } else {
    // ── Step 2: Model didn't use the tool — try to extract JSON from content ──
    // This handles models that respond with JSON in the content body instead of
    // a structured tool call (e.g., freemodel with certain model variants).

    if (process.env.MAOS_DEBUG) {
      console.log('[DECOMPOSER] No tool call found. Attempting JSON extraction from content...');
    }

    if (!response.content || response.content.trim().length === 0) {
      throw new DecomposerError(
        'UNSUPPORTED_TOOL_CALLING',
        `Model (${provider.name}/${provider.model}) returned neither a tool call nor any content. ` +
          `This provider may not support structured output. Try: openai, anthropic, or gemini.`,
      );
    }

    // Log full content for debugging
    if (process.env.MAOS_DEBUG) {
      console.log('[DECOMPOSER] Content to parse (first 2000 chars):');
      console.log(response.content.substring(0, 2000));
    }

    planData = tryExtractJsonFromString(response.content);

    if (!planData) {
      throw new DecomposerError(
        'SCHEMA_FAILURE',
        `Model (${provider.name}/${provider.model}) responded with text but no valid JSON plan could be extracted. ` +
          `The model may not support tool calling. Try a different provider. ` +
          `Set MAOS_DEBUG=1 to see the full raw response.`,
        response.content,
      );
    }

    extractionSource = 'content_fallback';
    logger.warn(
      'DECOMPOSER',
      `Plan extracted from content body (not tool call) — provider may not fully support function calling`,
    );
  }

  logger.info('DECOMPOSER', `Plan extraction source: ${extractionSource}`);

  // ── Step 3: Validate the plan shape ──
  if (!planData || typeof planData !== 'object') {
    throw new DecomposerError('SCHEMA_FAILURE', 'Extracted plan is not a valid object');
  }

  if (!Array.isArray(planData.tasks)) {
    // Some models return the tasks directly as the top-level array
    if (Array.isArray(planData)) {
      planData = { tasks: planData, estimatedComplexity: 'medium' };
    } else {
      throw new DecomposerError(
        'SCHEMA_FAILURE',
        `Plan is missing the required "tasks" array. Got keys: [${Object.keys(planData).join(', ')}]`,
        JSON.stringify(planData).substring(0, 500),
      );
    }
  }

  // Validate and normalize the tasks
  const tasks: SubTask[] = (planData.tasks || []).map((t: any, i: number) => ({
    title: t.title || `Task ${i + 1}`,
    description: t.description || '',
    requiredCapabilities: Array.isArray(t.requiredCapabilities) ? t.requiredCapabilities : [],
    complexity: ['low', 'medium', 'high'].includes(t.complexity) ? t.complexity : 'medium',
    category: t.category || 'general',
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    suggestedFiles: Array.isArray(t.suggestedFiles) ? t.suggestedFiles : [],
  }));

  if (tasks.length === 0) {
    throw new DecomposerError(
      'EMPTY_PLAN',
      'Model returned an empty task list. Try rephrasing the goal or switching providers.',
    );
  }

  // ── Step 4: Dependency graph validation ──
  const depWarnings = validateDependencyGraph(tasks);
  for (const warn of depWarnings) {
    logger.warn('DECOMPOSER', warn);
  }

  // ── Step 5: Telemetry-informed complexity override ──
  const overriddenComplexity = estimateComplexityFromTelemetry(tasks, cwd);

  const result: DecompositionResult = {
    goal,
    tasks,
    estimatedComplexity: overriddenComplexity || planData.estimatedComplexity || 'medium',
    model: response.model,
    tokensUsed: response.usage.totalTokens,
    latencyMs: response.latencyMs,
  };

  logger.success(
    'DECOMPOSER',
    'Decomposed into ' + tasks.length + ' subtasks (' + result.estimatedComplexity + ' complexity)',
  );
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Attempt to extract a JSON object or array from a string that may contain
 * markdown code fences, prose contamination, or mixed content.
 *
 * Strategies (in order):
 *   1. Direct JSON.parse of the trimmed string
 *   2. Extract from ```json ... ``` or ``` ... ``` code fence
 *   3. Extract the first {...} or [...] block via balanced brace scan
 *
 * Returns the parsed object/array, or null if all strategies fail.
 */
function tryExtractJsonFromString(text: string): any | null {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // Strategy 1: direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // Strategy 2: extract from markdown code fence
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    try {
      return JSON.parse(codeFenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }

  // Strategy 3: find the first balanced { ... } or [ ... ] block
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let startIdx = -1;
  let openChar = '{';
  let closeChar = '}';

  if (firstBrace === -1 && firstBracket === -1) return null;

  if (firstBrace === -1) {
    startIdx = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else if (firstBracket === -1) {
    startIdx = firstBrace;
  } else if (firstBracket < firstBrace) {
    startIdx = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    startIdx = firstBrace;
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < trimmed.length; i++) {
    if (trimmed[i] === openChar) depth++;
    else if (trimmed[i] === closeChar) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  try {
    return JSON.parse(trimmed.substring(startIdx, endIdx + 1));
  } catch {
    /* fall through */
  }

  return null;
}

/**
 * Quick project file scan for context injection.
 * Returns up to 50 file paths (excludes node_modules, .git, etc.)
 */
function scanProjectFiles(cwd: string): string[] {
  try {
    const { execSync } = require('child_process');
    const output = execSync('git ls-files', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .split('\n')
      .filter((line: string) => line.trim().length > 0)
      .slice(0, 50);
  } catch {
    // Not a git repo or git not available — try manual scan
    return scanDirRecursive(cwd, '', 0, 50);
  }
}

function scanDirRecursive(basePath: string, relativePath: string, depth: number, maxFiles: number): string[] {
  if (depth > 4) return []; // Don't go too deep

  const IGNORE = new Set([
    'node_modules',
    '.git',
    '.maos',
    'dist',
    '.next',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'build',
  ]);

  const results: string[] = [];
  const fullPath = require('path').join(basePath, relativePath);

  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        results.push(...scanDirRecursive(basePath, entryRelative, depth + 1, maxFiles - results.length));
      } else {
        results.push(entryRelative);
      }
    }
  } catch {
    // Permission denied or similar — skip
  }

  return results;
}

// ─── P3.4 Intelligence Enhancements ──────────────────────────

/**
 * Validate the dependency graph returned by the model.
 * Returns an array of warning messages.
 * Auto-fixes: removes invalid dependency references.
 */
function validateDependencyGraph(tasks: SubTask[]): string[] {
  const warnings: string[] = [];
  const titleSet = new Set(tasks.map((t) => t.title));

  // 1. Remove dangling dependency references
  for (const task of tasks) {
    const validDeps: string[] = [];
    for (const dep of task.dependsOn) {
      if (titleSet.has(dep)) {
        validDeps.push(dep);
      } else {
        warnings.push('Removed invalid dependency: "' + task.title + '" depends on "' + dep + '" which does not exist');
      }
    }
    task.dependsOn = validDeps;
  }

  // 2. Detect cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(title: string): boolean {
    if (inStack.has(title)) return true;
    if (visited.has(title)) return false;

    visited.add(title);
    inStack.add(title);

    const task = tasks.find((t) => t.title === title);
    if (task) {
      for (const dep of task.dependsOn) {
        if (hasCycle(dep)) {
          // Break the cycle by removing this edge
          task.dependsOn = task.dependsOn.filter((d) => d !== dep);
          warnings.push('Broke dependency cycle: "' + title + '" -> "' + dep + '"');
          return false; // Fixed, continue
        }
      }
    }

    inStack.delete(title);
    return false;
  }

  for (const task of tasks) {
    visited.clear();
    inStack.clear();
    hasCycle(task.title);
  }

  // 3. Check for orphaned tasks (no path to any root)
  const roots = tasks.filter((t) => t.dependsOn.length === 0);
  if (roots.length === 0 && tasks.length > 0) {
    warnings.push(
      'No root tasks (tasks with empty dependsOn). All tasks have dependencies. ' +
        'This may cause a deadlock. Consider removing unnecessary dependencies.',
    );
  }

  return warnings;
}

/**
 * Estimate overall complexity from telemetry history.
 * Returns a complexity string or null if insufficient data.
 */
function estimateComplexityFromTelemetry(tasks: SubTask[], cwd?: string): 'low' | 'medium' | 'high' | null {
  if (!cwd) return null;

  try {
    const records = readTelemetry(cwd);
    if (records.length < 3) return null; // Not enough data

    // Gather capabilities across all tasks
    const allCaps = new Set<string>();
    for (const t of tasks) {
      for (const c of t.requiredCapabilities) {
        allCaps.add(c);
      }
    }

    // Find past tasks with similar capabilities
    const similar = records.filter((r) => r.capabilities.some((c) => allCaps.has(c)));

    if (similar.length < 2) return null;

    // Calculate average iterations for similar tasks
    const avgIterations = similar.reduce((s, r) => s + r.iterations, 0) / similar.length;
    const successRate = similar.filter((r) => r.success).length / similar.length;

    // High iteration count or low success rate → higher complexity
    if (avgIterations > 15 || successRate < 0.5) return 'high';
    if (avgIterations > 8 || successRate < 0.75) return 'medium';
    return 'low';
  } catch {
    return null;
  }
}

/**
 * Build a telemetry hint for the decomposer prompt.
 * Summarizes past performance to guide complexity estimation.
 */
function buildTelemetryHint(cwd?: string): string | undefined {
  if (!cwd) return undefined;

  try {
    const records = readTelemetry(cwd);
    if (records.length === 0) return undefined;

    const successes = records.filter((r) => r.success).length;
    const avgIterations = records.reduce((s, r) => s + r.iterations, 0) / records.length;
    const avgTokens = records.reduce((s, r) => s + r.totalTokens, 0) / records.length;

    // Count capability frequencies
    const capFreq: Record<string, number> = {};
    for (const r of records) {
      for (const c of r.capabilities) {
        capFreq[c] = (capFreq[c] || 0) + 1;
      }
    }
    const topCaps = Object.entries(capFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cap, count]) => cap + ' (' + count + ')')
      .join(', ');

    return (
      'From ' +
      records.length +
      ' past task executions:\n' +
      '- Success rate: ' +
      Math.round((successes / records.length) * 100) +
      '%\n' +
      '- Average iterations per task: ' +
      Math.round(avgIterations) +
      '\n' +
      '- Average tokens per task: ' +
      Math.round(avgTokens) +
      '\n' +
      '- Most common capabilities: ' +
      topCaps +
      '\n' +
      'Use this data to set realistic complexity estimates.'
    );
  } catch {
    return undefined;
  }
}
