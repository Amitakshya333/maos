import * as fs from 'fs';
import * as path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { getConfigPath, ensureMaosDirectories, isMaosInitialized } from '../utils/paths';

interface AgentDefinition {
  id: string;
  role: string;
  provider: string;
  model: string;
  capabilities: string[];
  scope: string[];
  maxIterations: number;
  costTier: string;
}

interface MaosConfig {
  projectName: string;
  routingMode: string;
  providers: Record<string, { apiKey: string; baseURL?: string; costPerMillionTokens: number }>;
  agents: AgentDefinition[];
  routing: {
    strategy: string;
    costWeight: number;
    capabilityWeight: number;
    maxParallelAgents: number;
    fallbackProvider: string;
  };
}

const PRESET_AGENTS: Record<string, AgentDefinition[]> = {
  'solo': [
    {
      id: 'DEV',
      role: 'coder',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['planning', 'coding', 'design', 'testing'],
      scope: ['/'],
      maxIterations: 25,
      costTier: 'low',
    },
  ],
  'duo': [
    {
      id: 'BACKEND_DEV',
      role: 'coder',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['coding', 'apis', 'database', 'refactoring'],
      scope: ['src/', 'package.json', 'tsconfig.json'],
      maxIterations: 25,
      costTier: 'low',
    },
    {
      id: 'FRONTEND_DEV',
      role: 'designer',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['design', 'css', 'frontend', 'layout'],
      scope: ['src/', 'public/', 'index.html'],
      maxIterations: 20,
      costTier: 'low',
    },
  ],
  'team': [
    {
      id: 'ARCHITECT',
      role: 'planner',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['planning', 'reasoning', 'decomposition', 'review'],
      scope: ['/'],
      maxIterations: 10,
      costTier: 'medium',
    },
    {
      id: 'BACKEND_DEV',
      role: 'coder',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['coding', 'apis', 'database', 'refactoring'],
      scope: ['src/', 'package.json', 'tsconfig.json'],
      maxIterations: 25,
      costTier: 'low',
    },
    {
      id: 'FRONTEND_DEV',
      role: 'designer',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['design', 'css', 'frontend', 'layout', 'styling'],
      scope: ['src/', 'public/', 'index.html'],
      maxIterations: 20,
      costTier: 'low',
    },
  ],
  'mixed': [
    {
      id: 'ARCHITECT',
      role: 'planner',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['planning', 'reasoning', 'decomposition'],
      scope: ['/'],
      maxIterations: 10,
      costTier: 'medium',
    },
    {
      id: 'CODER_1',
      role: 'coder',
      provider: '',
      model: 'copilot',
      capabilities: ['coding', 'frontend', 'apis'],
      scope: ['src/'],
      maxIterations: 1,
      costTier: 'low',
    },
    {
      id: 'CODER_2',
      role: 'coder',
      provider: '',
      model: 'codex',
      capabilities: ['coding', 'backend', 'database'],
      scope: ['src/'],
      maxIterations: 1,
      costTier: 'low',
    },
    {
      id: 'REVIEWER',
      role: 'reviewer',
      provider: 'freemodel',
      model: 'gpt-5.4',
      capabilities: ['review', 'testing', 'debugging'],
      scope: ['/'],
      maxIterations: 10,
      costTier: 'low',
    },
  ],
};

const BANNER = `
${chalk.bold.cyan('╔══════════════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold.white('M A O S')}  ${chalk.gray('— Multi-Agent Orchestrator System')}  ${chalk.bold.cyan('║')}
${chalk.bold.cyan('║')}  ${chalk.gray('docker-compose for AI coding agents')}          ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════════════╝')}
`;

export async function runInit(): Promise<void> {
  console.log(BANNER);

  // Check if already initialized
  if (isMaosInitialized()) {
    console.log(chalk.yellow('⚠️  This directory is already initialized with MAOS.'));
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Overwrite existing configuration?',
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  // Interactive prompts
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: path.basename(process.cwd()),
    },
    {
      type: 'list',
      name: 'teamSize',
      message: 'Team configuration:',
      choices: [
        { name: `${chalk.bold('Solo')}    — 1 agent (fastest setup)`, value: 'solo' },
        { name: `${chalk.bold('Duo')}     — 2 agents (backend + frontend)`, value: 'duo' },
        { name: `${chalk.bold('Team')}    — 3 agents (architect + backend + frontend)`, value: 'team' },
        { name: `${chalk.bold('Mixed')}   — 4 agents (API + CLI runtimes)  ${chalk.yellow('★ NEW')}`, value: 'mixed' },
      ],
      default: 'team',
    },
    {
      type: 'list',
      name: 'provider',
      message: 'Default AI provider:',
      choices: [
        { name: `${chalk.bold('Freemodel')}  — api.freemodel.dev (OpenAI-compatible)`, value: 'freemodel' },
        { name: `${chalk.bold('OpenAI')}     — api.openai.com`, value: 'openai' },
        { name: `${chalk.bold('DeepSeek')}   — api.deepseek.com`, value: 'deepseek' },
        { name: `${chalk.bold('Ollama')}     — localhost (free, local models)`, value: 'ollama' },
        { name: `${chalk.bold('Custom')}     — enter your own base URL`, value: 'custom' },
      ],
      default: 'freemodel',
    },
  ]);

  // Provider configuration
  let providerConfig: Record<string, any> = {};
  const providerName = answers.provider;

  const PROVIDER_URLS: Record<string, string | undefined> = {
    freemodel: 'https://api.freemodel.dev/v1',
    openai: undefined, // SDK default
    deepseek: 'https://api.deepseek.com/v1',
    ollama: 'http://localhost:11434/v1',
  };

  let baseURL = PROVIDER_URLS[providerName];
  let costPerMillion = 0.50;

  if (providerName === 'custom') {
    const customAnswers = await inquirer.prompt([
      { type: 'input', name: 'baseURL', message: 'API Base URL:' },
    ]);
    baseURL = customAnswers.baseURL;
  }

  if (providerName === 'ollama') {
    costPerMillion = 0.00;
  } else if (providerName === 'openai') {
    costPerMillion = 10.00;
  } else if (providerName === 'deepseek') {
    costPerMillion = 0.14;
  }

  const envKeyName = `${providerName.toUpperCase()}_API_KEY`;
  providerConfig[providerName] = {
    apiKey: providerName === 'ollama' ? 'ollama' : `env:${envKeyName}`,
    ...(baseURL ? { baseURL } : {}),
    costPerMillionTokens: costPerMillion,
  };

  // Build agents with selected provider
  let agents: any[];
  if (answers.teamSize === 'mixed') {
    // Mixed preset: some agents are API, some are CLI
    agents = PRESET_AGENTS['mixed'].map(a => {
      if (a.model === 'copilot') {
        return {
          ...a,
          runtime: 'cli',
          cliCommand: 'copilot',
          auth: { COPILOT_HOME: '.maos/auth/CODER_1' },
          timeoutMs: 300000,
          quiescenceMs: 30000,
        };
      }
      if (a.model === 'codex') {
        return {
          ...a,
          runtime: 'cli',
          cliCommand: 'codex',
          cliArgs: ['-a', 'full-auto'],
          auth: { CODEX_HOME: '.maos/auth/CODER_2' },
          timeoutMs: 300000,
          quiescenceMs: 30000,
        };
      }
      // API agents use the selected provider
      return { ...a, provider: providerName };
    });
  } else {
    agents = PRESET_AGENTS[answers.teamSize].map(a => ({
      ...a,
      provider: providerName,
    }));
  }

  // Build config
  const config: MaosConfig = {
    projectName: answers.projectName,
    routingMode: 'auto',
    providers: providerConfig,
    agents,
    routing: {
      strategy: 'capability_score',
      costWeight: 0.3,
      capabilityWeight: 0.7,
      maxParallelAgents: agents.length,
      fallbackProvider: providerName,
    },
  };

  // Create directories + write config
  ensureMaosDirectories();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Initialize git repo if none exists (prevents git operations from escaping upward)
  const cwd = process.cwd();
  const gitDir = path.join(cwd, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      const { execSync } = require('child_process');
      execSync('git init', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(chalk.gray('  Initialized git repo for branch isolation'));
    } catch {
      console.log(chalk.yellow('  ⚠ Could not auto-init git repo. Git features may not work.'));
    }
  }

  // Create .gitignore if it doesn't exist
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, [
      'node_modules/',
      '.env',
      '.maos/logs/',
      '.maos/telemetry/',
      '.maos/brain/',
      '.maos/status/',
      '',
    ].join('\n'), 'utf-8');
  }

  // Create .env file if it doesn't exist
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath) && providerName !== 'ollama') {
    fs.writeFileSync(envPath, `${envKeyName}=your-api-key-here\n`, 'utf-8');
  }

  // Create pool.json (all agents ON by default)
  const pool: Record<string, boolean> = {};
  agents.forEach(a => { pool[a.id] = true; });
  const poolPath = path.join(path.dirname(configPath), 'pool.json');
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');

  // Output
  console.log('');
  console.log(chalk.green('✅ MAOS initialized successfully!'));
  console.log('');
  console.log(chalk.gray('Created:'));
  console.log(chalk.gray('  .maos/maos.config.json     — agent configuration'));
  console.log(chalk.gray('  .maos/pool.json             — agent pool state'));
  console.log(chalk.gray('  .maos/queue/                — task queue directories'));
  console.log(chalk.gray('  .maos/status/               — agent status tracking'));
  console.log(chalk.gray('  .maos/logs/                 — orchestrator logs'));
  console.log('');
  console.log(chalk.cyan('Your team:'));
  agents.forEach(a => {
    const icon = a.role === 'planner' ? '🧠' : a.role === 'coder' ? '⚙️' : a.role === 'reviewer' ? '🔍' : '🎨';
    const runtimeLabel = a.runtime === 'cli' ? `${a.cliCommand}-cli` : `${a.provider}/${a.model}`;
    const runtimeBadge = a.runtime === 'cli' ? chalk.magenta(' [CLI]') : chalk.blue(' [API]');
    console.log(`  ${icon}  ${chalk.bold(a.id)} (${a.role}) → ${runtimeLabel}${runtimeBadge}`);
  });
  console.log('');
  console.log(chalk.white('Next steps:'));
  if (providerName !== 'ollama') {
    console.log(chalk.white(`  1. Set your API key: export ${envKeyName}="sk-..."`));
  }
  console.log(chalk.white(`  ${providerName === 'ollama' ? '1' : '2'}. Create a task:   ${chalk.cyan('maos task "Build a login page"')}`));
  console.log(chalk.white(`  ${providerName === 'ollama' ? '2' : '3'}. Start agents:    ${chalk.cyan('maos start')}`));
  console.log('');
}
