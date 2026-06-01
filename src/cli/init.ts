import * as fs from 'fs';
import * as path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { getConfigPath, ensureMaosDirectories, isMaosInitialized } from '../utils/paths';
import { renderPanel, getBrandBadge, icons } from '../utils/ui';

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
      id: 'CODER_3',
      role: 'coder',
      provider: '',
      model: 'opencode',
      capabilities: ['coding', 'frontend', 'backend'],
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

export async function runInit(): Promise<void> {
  const bannerLines = [
    `${getBrandBadge()} ${chalk.bold.hex('#F1F5F9')('Multi-Agent Orchestrator')}`,
    `${chalk.gray('Isolated docker-compose system for AI coding agents')}`
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#6366F1')));
  console.log('');

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
  let ollamaModel = 'qwen2.5-coder';
  let customModel = 'gpt-4o';

  if (providerName === 'custom') {
    const customAnswers = await inquirer.prompt([
      { type: 'input', name: 'baseURL', message: 'API Base URL:' },
      { type: 'input', name: 'model', message: 'Custom Model Name:', default: 'gpt-4o' },
    ]);
    baseURL = customAnswers.baseURL;
    customModel = customAnswers.model;
  }

  if (providerName === 'ollama') {
    const ollamaAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'model',
        message: 'Local Ollama model name (e.g., qwen2.5-coder, llama3, deepseek-coder):',
        default: 'qwen2.5-coder',
      },
    ]);
    ollamaModel = ollamaAnswers.model;
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

  const DEFAULT_MODELS: Record<string, string> = {
    freemodel: 'gpt-5.4',
    openai: 'gpt-4o',
    deepseek: 'deepseek-chat',
    ollama: ollamaModel,
    custom: customModel,
  };

  const selectedModel = DEFAULT_MODELS[providerName] || 'gpt-5.4';

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
          auth: { CODEX_HOME: '.maos/auth/CODER_2' },
          timeoutMs: 300000,
          quiescenceMs: 30000,
        };
      }
      if (a.model === 'opencode') {
        return {
          ...a,
          runtime: 'cli',
          cliCommand: 'opencode',
          auth: { OPENCODE_HOME: '.maos/auth/CODER_3' },
          timeoutMs: 300000,
          quiescenceMs: 30000,
        };
      }
      // API agents use the selected provider
      return { ...a, provider: providerName, model: selectedModel };
    });
  } else {
    agents = PRESET_AGENTS[answers.teamSize].map(a => ({
      ...a,
      provider: providerName,
      model: selectedModel,
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

  // ── v0.3: INLINE API KEY SETUP ──
  // Instead of writing a placeholder to .env, prompt the user for the key right now.
  // This is the single biggest UX improvement: zero manual file editing.
  if (providerName !== 'ollama') {
    console.log('');
    console.log(chalk.bold.cyan(`  ${providerName} requires an API key.`));
    console.log('');

    const { setCredential, testCredential, markCredentialTested } = require('../core/credentials');

    const { apiKey } = await inquirer.prompt([{
      type: 'password',
      name: 'apiKey',
      message: `Enter your ${providerName} API key:`,
      mask: '•',
      validate: (val: string) => {
        if (!val || val.trim().length === 0) return 'API key cannot be empty. Press Ctrl+C to skip.';
        if (val.trim().length < 8) return 'API key seems too short';
        return true;
      },
    }]);

    if (apiKey && apiKey.trim().length >= 8) {
      console.log(chalk.gray('  ⏳ Validating key...'));
      const testResult = await testCredential(providerName, apiKey.trim(), baseURL);

      if (testResult.success) {
        console.log(chalk.green(`  ✅ Connected${testResult.model ? ` (${testResult.model})` : ''}${testResult.latencyMs ? `, ${testResult.latencyMs}ms` : ''}`));
        setCredential(providerName, apiKey.trim());
        markCredentialTested(providerName, 'ok');
        console.log(chalk.green('  ✅ Saved to .maos/credentials.json'));
      } else {
        console.log(chalk.yellow(`  ⚠️  Connection test failed: ${testResult.error}`));
        const { saveAnyway } = await inquirer.prompt([{
          type: 'confirm',
          name: 'saveAnyway',
          message: 'Save key anyway? (you can re-test later with: maos configure)',
          default: true,
        }]);
        if (saveAnyway) {
          setCredential(providerName, apiKey.trim());
          markCredentialTested(providerName, 'failed');
        }
      }
    }
  }

  // Create pool.json (all agents ON by default)
  const pool: Record<string, boolean> = {};
  agents.forEach(a => { pool[a.id] = true; });
  const poolPath = path.join(path.dirname(configPath), 'pool.json');
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2), 'utf-8');

  // ── TEAM STATUS SUMMARY ──
  // Show credential-aware status so the user knows immediately if anything needs attention.
  console.log('');
  console.log(chalk.green('✅ MAOS initialized successfully!'));
  console.log('');

  // Team status panel
  const { getAllCredentialStatuses } = require('../core/credentials');
  const credStatuses = getAllCredentialStatuses(config);
  const hasIssues = credStatuses.some((s: any) => s.status !== 'valid');

  console.log(chalk.bold('  Team Status'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));

  for (const agent of agents) {
    const icon = agent.role === 'planner' ? '🧠' : agent.role === 'coder' ? '⚙️' : agent.role === 'reviewer' ? '🔍' : '🎨';
    const cred = credStatuses.find((s: any) => s.agentId === agent.id);
    const runtimeLabel = agent.runtime === 'cli' ? agent.cliCommand : `${agent.provider}/${agent.model}`;

    if (cred && cred.status === 'valid') {
      const sourceLabel = agent.runtime === 'cli' ? 'CLI' : 'Connected';
      console.log(`  ${icon}  ${chalk.bold(agent.id).padEnd(20)} ${chalk.green('✅ ' + sourceLabel)}  ${chalk.gray(runtimeLabel)}`);
    } else if (cred && cred.status === 'placeholder') {
      console.log(`  ${icon}  ${chalk.bold(agent.id).padEnd(20)} ${chalk.yellow('⚠️  Placeholder key')}  ${chalk.gray(runtimeLabel)}`);
    } else {
      console.log(`  ${icon}  ${chalk.bold(agent.id).padEnd(20)} ${chalk.red('❌ Missing key')}  ${chalk.gray(runtimeLabel)}`);
    }
  }

  console.log('');

  if (hasIssues) {
    console.log(chalk.yellow('  ⚠️  Some agents need API key configuration.'));
    console.log(chalk.cyan('  Run: maos configure'));
    console.log('');
  }

  console.log(chalk.white('Next steps:'));
  console.log(chalk.white(`  1. Create a task:   ${chalk.cyan('maos task "Build a login page"')}`));
  console.log(chalk.white(`  2. Start agents:    ${chalk.cyan('maos start')}`));
  if (hasIssues) {
    console.log(chalk.white(`  ${chalk.yellow('⚡')} Fix credentials: ${chalk.cyan('maos configure')}`));
  }
  console.log('');
}
