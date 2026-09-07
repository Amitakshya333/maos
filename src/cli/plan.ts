import * as fs from 'fs';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import inquirer from 'inquirer';
import { isMaosInitialized, getConfigPath } from '../utils/paths';
import { createProviderDirect } from '../backends/factory';
import { decompose, SubTask, DecompositionResult, DecomposerError } from '../core/decomposer';
import { createTask } from '../core/queue';
import { createRouter } from '../core/router';
import { renderPanel, getBrandBadge, renderDivider, icons, padRight } from '../utils/ui';

// ─── Safe Shutdown Helper ────────────────────────────────────────

/**
 * Stop any active spinner BEFORE calling process.exit().
 *
 * Background: ora holds open a readline/stream async handle internally.
 * Calling process.exit() while that handle is still "closing" triggers
 * a libuv assertion:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
 *   file src\win\async.c, line 76
 *
 * Calling spinner.stop() first flushes the handle synchronously,
 * allowing process.exit() to run without the assertion.
 */
function failAndExit(spinner: Ora | null, message: string, code = 1): never {
  if (spinner) {
    try {
      spinner.stop();
    } catch {
      /* already stopped */
    }
  }
  console.error(message);
  // Defer exit by one tick to let any pending I/O flush
  setImmediate(() => process.exit(code));
  // TypeScript needs this for `never` return type — setImmediate will fire first
  throw new Error('unreachable');
}

export interface PlanOptions {
  provider?: string;
  yes?: boolean; // Auto-confirm without prompting
}

/**
 * Render a subtask in the terminal with full detail.
 */
function renderSubTask(task: SubTask, index: number, totalTasks: number): void {
  const complexityColor = {
    low: chalk.bold.green,
    medium: chalk.bold.yellow,
    high: chalk.bold.red,
  };
  const complexityIcon = {
    low: '🟢',
    medium: '🟡',
    high: '🔴',
  };

  const catIcon = getCategoryIcon(task.category);

  console.log('');
  console.log(
    `  ${chalk.bold.hex('#F1F5F9')(`${index + 1}/${totalTasks}`)}  ${catIcon}  ${chalk.bold.white(task.title)}` +
      `  ${complexityIcon[task.complexity]} ${complexityColor[task.complexity](task.complexity)}`,
  );
  console.log(chalk.gray(`     └─ ${task.description.substring(0, 140)}${task.description.length > 140 ? '...' : ''}`));
  console.log(chalk.gray('        Capabilities: ') + chalk.cyan(task.requiredCapabilities.join(', ') || 'general'));
  if (task.suggestedFiles.length > 0) {
    console.log(
      chalk.gray('        Files:        ') +
        chalk.hex('#CBD5E1')(
          task.suggestedFiles.slice(0, 4).join(', ') +
            (task.suggestedFiles.length > 4 ? ` +${task.suggestedFiles.length - 4} more` : ''),
        ),
    );
  }
  if (task.dependsOn.length > 0) {
    console.log(chalk.gray('        Depends On:   ') + chalk.bold.yellow(task.dependsOn.join(', ')));
  }
}

function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    backend: '⚙️',
    frontend: '🎨',
    design: '🎨',
    styling: '🎨',
    api: '🔌',
    database: '🗄️',
    testing: '🧪',
    planning: '🧠',
    devops: '🚀',
  };
  return icons[category] || '📦';
}

/**
 * Render the full decomposition result as a beautiful terminal plan.
 */
function renderPlan(result: DecompositionResult): void {
  const complexityColor = {
    low: chalk.bold.green,
    medium: chalk.bold.yellow,
    high: chalk.bold.red,
  };

  const bannerLines = [
    `${getBrandBadge('DECOMPOSITION')} ${chalk.bold.hex('#F1F5F9')('Build Plan Ready')}`,
    `${chalk.gray('Goal:')} ${chalk.bold.hex('#A78BFA')(`"${result.goal}"`)}`,
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#A78BFA')));

  console.log('');
  console.log(
    `  ${chalk.bold.hex('#CBD5E1')('Subtasks:')}   ${chalk.bold.green(String(result.tasks.length))} tasks` +
      ' │ ' +
      `  ${chalk.bold.hex('#CBD5E1')('Complexity:')} ${complexityColor[result.estimatedComplexity](result.estimatedComplexity)}` +
      ' │ ' +
      `  ${chalk.bold.hex('#CBD5E1')('Model:')}      ${chalk.gray(result.model)}`,
  );
  console.log(renderDivider(75));

  // Dependency graph summary
  const independent = result.tasks.filter((t) => t.dependsOn.length === 0);
  const dependent = result.tasks.filter((t) => t.dependsOn.length > 0);
  console.log('');
  console.log(
    `  ${chalk.bold.hex('#94A3B8')('⚡ Pipeline:')}  ` +
      chalk.bold.green(`${independent.length} Parallel Initializers`) +
      chalk.gray(' ➔ ') +
      chalk.bold.yellow(`${dependent.length} Sequential Chain-links`),
  );

  // Render each task
  for (let i = 0; i < result.tasks.length; i++) {
    renderSubTask(result.tasks[i], i, result.tasks.length);
  }

  console.log('');
  console.log(renderDivider(75));
}

// ─── Main Plan Command ────────────────────────────────────────

export async function runPlan(goal: string, options: PlanOptions): Promise<void> {
  // Pre-flight checks
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  // Load config
  const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

  // Pick the provider — use the first planner/architect agent, or fallback to first agent
  const plannerAgent = config.agents.find((a: any) => a.role === 'planner') || config.agents[0];
  const providerName = options.provider || plannerAgent.provider;
  const providerConfig = config.providers[providerName];

  if (!providerConfig) {
    console.log(chalk.red(`❌ Provider "${providerName}" not found in config.`));
    console.log(chalk.gray('Available: ' + Object.keys(config.providers).join(', ')));
    process.exit(1);
  }

  // Create provider — resolve key from credential store first
  let provider;
  try {
    const { resolveCredential } = require('../core/credentials');
    const resolved = resolveCredential(providerName, providerConfig.apiKey);
    const enrichedConfig = resolved ? { ...providerConfig, apiKey: resolved.key } : providerConfig;
    provider = createProviderDirect(providerName, enrichedConfig, plannerAgent.model);
  } catch (err: any) {
    console.log(chalk.red(`❌ Failed to create provider: ${err.message}`));
    process.exit(1);
  }

  // Show spinner while decomposing
  const spinner = ora({
    text: chalk.cyan(`Decomposing goal with ${providerName}/${plannerAgent.model}...`),
    spinner: 'dots',
  }).start();

  let result: DecompositionResult;
  try {
    result = await decompose(
      provider,
      goal,
      config.agents.map((a: any) => ({
        id: a.id,
        role: a.role,
        capabilities: a.capabilities,
      })),
      process.cwd(),
    );
    spinner.succeed(
      chalk.green(`Decomposed into ${result.tasks.length} subtasks`) +
        chalk.gray(` (${result.tokensUsed} tokens, ${(result.latencyMs / 1000).toFixed(1)}s)`),
    );
  } catch (err: any) {
    // ── SAFE SHUTDOWN: stop spinner BEFORE exiting to prevent UV_HANDLE_CLOSING assertion ──
    spinner.stop();

    if (err instanceof DecomposerError) {
      // Provide kind-specific guidance
      console.error(chalk.red(`\n❌ Decomposition failed [${err.kind}]`));

      switch (err.kind) {
        case 'UNSUPPORTED_TOOL_CALLING':
          console.error(chalk.white(err.message));
          console.error(chalk.yellow('\n  Hint: This model/provider does not support structured tool calling.'));
          console.error(chalk.gray('  Try: maos plan "..." --provider openai'));
          console.error(chalk.gray('  Or:  maos plan "..." --provider anthropic'));
          break;

        case 'SCHEMA_FAILURE':
          console.error(chalk.white(err.message));
          console.error(chalk.yellow('\n  Hint: The model responded but the output could not be parsed as a plan.'));
          console.error(chalk.gray('  Try: MAOS_DEBUG=1 maos plan "..." to see the raw response.'));
          console.error(chalk.gray('  Or:  Switch to a provider with better structured output support.'));
          break;

        case 'MALFORMED_RESPONSE':
          console.error(chalk.white(err.message));
          console.error(chalk.yellow('\n  Hint: The plan JSON was malformed.'));
          console.error(chalk.gray('  Try: MAOS_DEBUG=1 maos plan "..." to inspect the raw tool call arguments.'));
          break;

        case 'PROVIDER_FAILURE':
          console.error(chalk.white(err.message));
          console.error(chalk.yellow('\n  Hint: The AI provider returned an error.'));
          console.error(chalk.gray('  Check: API key, rate limits, and provider status.'));
          break;

        case 'EMPTY_PLAN':
          console.error(chalk.white(err.message));
          console.error(chalk.yellow('\n  Hint: Try rephrasing your goal to be more specific.'));
          break;

        default:
          console.error(chalk.white(err.message));
      }
    } else {
      // Non-decomposer error (network, config, etc.)
      console.error(chalk.red(`\n❌ Decomposition failed: ${err.message}`));
      if (process.env.MAOS_DEBUG) {
        console.error(chalk.gray(err.stack || ''));
      }
    }

    // Defer exit to let any pending I/O flush — prevents UV_HANDLE_CLOSING
    setImmediate(() => process.exit(1));
    return;
  }

  // Render the plan
  renderPlan(result);

  // Show routing preview — where would each task go?
  const router = createRouter(config.routing, process.cwd());
  const agentProfiles = config.agents.map((a: any) => ({
    id: a.id,
    role: a.role,
    provider: a.provider,
    model: a.model,
    capabilities: a.capabilities,
    costTier: a.costTier,
    maxIterations: a.maxIterations,
    idle: true,
    enabled: true,
  }));

  console.log(chalk.bold('  Routing Preview:'));
  for (const task of result.tasks) {
    const decision = router.route(
      {
        capabilities: task.requiredCapabilities,
        complexity: task.complexity,
        category: task.category,
        targetAgent: '',
      },
      agentProfiles,
    );
    if (decision) {
      const agent = config.agents.find((a: any) => a.id === decision.agentId);
      const icon = agent?.role === 'planner' ? '🧠' : agent?.role === 'coder' ? '⚙️' : '🎨';
      console.log(
        chalk.gray('    ') +
          `${icon} ${chalk.bold(task.title)}` +
          chalk.gray(' → ') +
          chalk.cyan(`${decision.agentId}`) +
          chalk.gray(` (score: ${decision.score.toFixed(2)})`),
      );
    }
  }

  console.log('');

  // Confirm before queuing
  let shouldQueue = options.yes || false;
  if (!shouldQueue) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Queue all ${result.tasks.length} tasks for execution?`,
        default: true,
      },
    ]);
    shouldQueue = confirm;
  }

  if (!shouldQueue) {
    console.log(chalk.gray('\n  Plan discarded. No tasks queued.\n'));
    return;
  }

  // Create all tasks in the queue
  console.log('');
  const createdIds: string[] = [];

  // Build a deterministic title -> taskId map FIRST so dependencies can
  // reference IDs regardless of task creation order.
  const titleToId = new Map<string, string>();
  for (const task of result.tasks) {
    const stableTitleSlug = task.title
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 24);
    const stableId = `AUTO__${Date.now()}_${stableTitleSlug}`;
    titleToId.set(task.title, stableId);
  }

  for (const task of result.tasks) {
    // Resolve dependsOn titles -> actual task IDs; drop dangling/self refs.
    const resolvedDeps = task.dependsOn
      .map((depTitle) => titleToId.get(depTitle))
      .filter((depId): depId is string => Boolean(depId))
      .filter((depId) => depId !== titleToId.get(task.title));

    const created = createTask({
      id: titleToId.get(task.title),
      description: `## ${task.title}\n\n${task.description}`,
      capabilities: task.requiredCapabilities,
      complexity: task.complexity,
      category: task.category,
      dependsOn: resolvedDeps,
    });
    createdIds.push(created.id);
    console.log(
      `  ${icons.done} ${chalk.bold.green(`Queued:`)} ${chalk.white(task.title)} ${chalk.gray(`➔ ${created.id}`)}`,
    );
  }

  console.log('');
  console.log(`  ${icons.success} ${chalk.bold.green(`${createdIds.length} tasks queued successfully!`)}`);
  console.log(`  ${chalk.gray('To launch your new fleet execution pipeline, run:')} ${chalk.bold.cyan('maos start')}`);
  console.log('');
}
