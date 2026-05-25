import chalk from 'chalk';
import { createTask } from '../core/queue';
import { isMaosInitialized } from '../utils/paths';

export interface TaskOptions {
  agent?: string;
  branch?: string;
  capabilities?: string;
  complexity?: string;
  category?: string;
}

export function runTask(description: string, options: TaskOptions): void {
  // Check initialization
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized in this directory.'));
    console.log(chalk.gray('Run: maos init'));
    process.exit(1);
  }

  // Parse capabilities if provided
  const capabilities = options.capabilities
    ? options.capabilities.split(',').map(s => s.trim())
    : [];

  const complexity = (options.complexity || 'medium') as 'low' | 'medium' | 'high';

  try {
    const task = createTask({
      agent: options.agent,
      branch: options.branch,
      description,
      capabilities,
      complexity,
      category: options.category,
    });

    console.log('');
    console.log(chalk.green('✅ Task created'));
    console.log('');
    console.log(`  ${chalk.gray('ID:')}          ${chalk.bold(task.id)}`);
    console.log(`  ${chalk.gray('Agent:')}       ${chalk.cyan(task.agent)}`);
    console.log(`  ${chalk.gray('Branch:')}      ${chalk.yellow(task.branch)}`);
    console.log(`  ${chalk.gray('Complexity:')}  ${task.complexity}`);
    if (capabilities.length > 0) {
      console.log(`  ${chalk.gray('Capabilities:')} ${capabilities.join(', ')}`);
    }
    console.log(`  ${chalk.gray('Queue:')}       .maos/queue/pending/`);
    console.log('');
    console.log(chalk.gray(`Description: ${description}`));
    console.log('');
  } catch (err: any) {
    console.log(chalk.red(`❌ Failed to create task: ${err.message}`));
    process.exit(1);
  }
}
