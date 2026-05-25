import * as fs from 'fs';
import { IProvider, ChatMessage, ToolDef } from '../backends/provider';
import { createLogger } from '../utils/logger';

/**
 * MAOS AI Task Decomposer
 *
 * Takes a high-level goal like "Build a todo app with auth and dark mode"
 * and uses an AI model (the ARCHITECT agent) to break it into atomic,
 * capability-tagged subtasks that the router can assign to the right agents.
 *
 * This is the "brain" of `maos plan` — the command that turns a one-liner
 * into a multi-agent build plan.
 */

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
                description: 'Detailed instructions for the agent that will execute this task. Be specific about what to build, which files to create/modify, and acceptance criteria.',
              },
              requiredCapabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capabilities needed. Choose from: planning, coding, apis, database, refactoring, testing, design, css, frontend, layout, styling, review, debugging',
              },
              complexity: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Estimated complexity: low (< 5 files), medium (5-15 files), high (> 15 files)',
              },
              category: {
                type: 'string',
                description: 'Task category for routing. Choose from: backend, frontend, design, testing, planning, api, database, styling, devops',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'Titles of other subtasks that must complete before this one can start. Empty array if no dependencies.',
              },
              suggestedFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths this task will likely create or modify',
              },
            },
            required: ['title', 'description', 'requiredCapabilities', 'complexity', 'category', 'dependsOn', 'suggestedFiles'],
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
  agentRoster: { id: string; role: string; capabilities: string[] }[],
  projectContext?: string,
): string {
  const rosterText = agentRoster
    .map(a => `  - ${a.id} (${a.role}): capabilities = [${a.capabilities.join(', ')}]`)
    .join('\n');

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

## Rules
- Each subtask should take an agent 1-5 tool iterations to complete
- Don't create "setup" tasks unless genuinely needed (the project may already exist)
- Frontend tasks should include specific component names, layouts, and styling requirements
- Backend tasks should include API endpoints, data models, and business logic
- Prefer parallel execution: minimize dependencies between tasks
- If a task is clearly suited for a specific agent role, tag its category accordingly
${projectContext ? `\n## Current Project Context\n${projectContext}` : ''}

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
  agents: { id: string; role: string; capabilities: string[] }[],
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
        projectContext = `Existing files in project:\n${files.map(f => `  - ${f}`).join('\n')}`;
      }
    }
  } catch {
    // No project context available — that's fine
  }

  const systemPrompt = buildDecomposePrompt(goal, agents, projectContext);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Decompose this goal into subtasks: "${goal}"` },
  ];

  // Call the model with the structured tool
  const response = await provider.generate(messages, [DECOMPOSE_TOOL]);

  logger.info('DECOMPOSER', `Model responded in ${response.latencyMs}ms, ${response.usage.totalTokens} tokens`);

  // Extract the tool call result
  if (response.toolCalls.length === 0) {
    // Model didn't use the tool — try to parse from content
    throw new Error(
      'Decomposer: Model did not return a structured plan. ' +
      'This may happen if the model is not capable of tool calling. ' +
      'Try a different provider or model.'
    );
  }

  const planCall = response.toolCalls.find(tc => tc.function.name === 'submit_plan');
  if (!planCall) {
    throw new Error('Decomposer: Model called an unexpected tool instead of submit_plan');
  }

  let planData: any;
  try {
    planData = JSON.parse(planCall.function.arguments);
  } catch (err) {
    throw new Error(`Decomposer: Failed to parse tool call arguments — ${err}`);
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
    throw new Error('Decomposer: Model returned an empty task list. Try rephrasing the goal.');
  }

  const result: DecompositionResult = {
    goal,
    tasks,
    estimatedComplexity: planData.estimatedComplexity || 'medium',
    model: response.model,
    tokensUsed: response.usage.totalTokens,
    latencyMs: response.latencyMs,
  };

  logger.success('DECOMPOSER', `Decomposed into ${tasks.length} subtasks (${result.estimatedComplexity} complexity)`);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────

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

function scanDirRecursive(
  basePath: string,
  relativePath: string,
  depth: number,
  maxFiles: number,
): string[] {
  if (depth > 4) return []; // Don't go too deep

  const IGNORE = new Set([
    'node_modules', '.git', '.maos', 'dist', '.next',
    '__pycache__', '.venv', 'venv', 'target', 'build',
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
