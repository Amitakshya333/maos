import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { isMaosInitialized, getConfigPath } from '../utils/paths';
import { ProviderFactory } from '../backends/factory';
import { decompose, SubTask, DecompositionResult } from '../core/decomposer';
import { createTask } from '../core/queue';
import { createRouter } from '../core/router';

export interface PlanOptions {
  provider?: string;
  yes?: boolean; // Auto-confirm without prompting
}

/**
 * Render a subtask in the terminal with full detail.
 */
function renderSubTask(task: SubTask, index: number, totalTasks: number): void {
  const complexityColor = {
    low: chalk.green,
    medium: chalk.yellow,
    high: chalk.red,
  };
  const complexityIcon = {
    low: '🟢',
    medium: '🟡',
    high: '🔴',
  };

  const catIcon = getCategoryIcon(task.category);

  console.log('');
  console.log(
    chalk.bold(`  ${index + 1}/${totalTasks}  ${catIcon}  ${task.title}`) +
    `  ${complexityIcon[task.complexity]} ${complexityColor[task.complexity](task.complexity)}`
  );
  console.log(chalk.gray(`      ${task.description.substring(0, 120)}${task.description.length > 120 ? '...' : ''}`));
  console.log(
    chalk.gray('      Capabilities: ') +
    chalk.cyan(task.requiredCapabilities.join(', ') || 'general')
  );
  if (task.suggestedFiles.length > 0) {
    console.log(
      chalk.gray('      Files: ') +
      chalk.white(task.suggestedFiles.slice(0, 4).join(', ') +
        (task.suggestedFiles.length > 4 ? ` +${task.suggestedFiles.length - 4} more` : ''))
    );
  }
  if (task.dependsOn.length > 0) {
    console.log(
      chalk.gray('      Depends on: ') +
      chalk.yellow(task.dependsOn.join(', '))
    );
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
    low: chalk.green,
    medium: chalk.yellow,
    high: chalk.red,
  };

  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('  M A O S  ') + chalk.gray('— Build Plan Generated') + '              ' + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════════════════╝'));

  console.log('');
  console.log(chalk.bold('  Goal: ') + chalk.white(`"${result.goal}"`));
  console.log(
    chalk.bold('  Tasks: ') + chalk.white(String(result.tasks.length)) +
    chalk.bold('  Complexity: ') + complexityColor[result.estimatedComplexity](result.estimatedComplexity) +
    chalk.bold('  Model: ') + chalk.gray(result.model) +
    chalk.bold('  Tokens: ') + chalk.gray(String(result.tokensUsed))
  );
  console.log(chalk.gray('  ─────────────────────────────────────────────────────'));

  // Dependency graph summary
  const independent = result.tasks.filter(t => t.dependsOn.length === 0);
  const dependent = result.tasks.filter(t => t.dependsOn.length > 0);
  console.log('');
  console.log(
    chalk.bold('  Execution: ') +
    chalk.green(`${independent.length} parallel`) +
    chalk.gray(' → ') +
    chalk.yellow(`${dependent.length} sequential`)
  );

  // Render each task
  for (let i = 0; i < result.tasks.length; i++) {
    renderSubTask(result.tasks[i], i, result.tasks.length);
  }

  console.log('');
  console.log(chalk.gray('  ─────────────────────────────────────────────────────'));
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

  // Create provider
  let provider;
  try {
    provider = ProviderFactory.create(providerName, providerConfig, plannerAgent.model);
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
      chalk.gray(` (${result.tokensUsed} tokens, ${(result.latencyMs / 1000).toFixed(1)}s)`)
    );
  } catch (err: any) {
    spinner.fail(chalk.red(`Decomposition failed: ${err.message}`));
    process.exit(1);
  }

  // Render the plan
  renderPlan(result);

  // Show routing preview — where would each task go?
  const router = createRouter(config.routing);
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
        chalk.gray(` (score: ${decision.score.toFixed(2)})`)
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

  for (const task of result.tasks) {
    const created = createTask({
      description: `## ${task.title}\n\n${task.description}`,
      capabilities: task.requiredCapabilities,
      complexity: task.complexity,
      category: task.category,
      dependsOn: task.dependsOn,
    });
    createdIds.push(created.id);
    console.log(chalk.green(`  ✅ Queued: ${task.title}`) + chalk.gray(` → ${created.id}`));
  }

  console.log('');
  console.log(chalk.bold.green(`  🚀 ${createdIds.length} tasks queued!`));
  console.log(chalk.gray(`  Start the orchestrator: `) + chalk.cyan('maos start'));
  console.log('');
}
