/**
 * MAOS Login Command
 *
 * Authenticates CLI-based agents with their respective tools.
 * Each agent gets its own isolated credential directory.
 *
 * Ported from ARIOTH's login-agent.ps1:
 *   c:\lovable workflow\.agent\orchestrator\login-agent.ps1
 *
 * Usage:
 *   maos login --agent CODER_1 --cli copilot
 *   maos login --agent CODER_2 --cli codex
 *   maos login --agent CODER_3 --cli opencode
 *   maos login --agent REVIEWER --cli claude
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { isMaosInitialized, getConfigPath } from '../utils/paths';
import { renderPanel, getBrandBadge, renderDivider, icons, padRight } from '../utils/ui';

// ---- CLI Login Profiles ----

interface LoginProfile {
  command: string;
  loginCmd: string[];
  authEnvKey: string;
  verifyCmd?: string[];
  instructions: string;
}

const LOGIN_PROFILES: Record<string, LoginProfile> = {
  copilot: {
    command: 'copilot',
    loginCmd: ['copilot', 'login'],
    authEnvKey: 'COPILOT_HOME',
    verifyCmd: ['copilot', '-p', 'Say hello', '--silent'],
    instructions: `1. The CLI will give you a one-time CODE.
2. Open an INCOGNITO browser window.
3. Go to https://github.com/login — log in with the GitHub ID for this agent.
4. Then go to https://github.com/login/device and paste the code.`,
  },
  codex: {
    command: 'codex',
    loginCmd: ['codex', 'auth', 'login'],
    authEnvKey: 'CODEX_HOME',
    instructions: `1. Follow the prompts to authenticate with OpenAI.
2. Each agent should use a separate API key or account.`,
  },
  opencode: {
    command: 'opencode',
    loginCmd: ['opencode', 'auth', 'login'],
    authEnvKey: 'OPENCODE_HOME',
    instructions: `1. Follow the prompts to authenticate with OpenCode.
2. Each agent should use a separate profile or directory.
3. If prompted for a provider, select your preferred one.`,
  },
  claude: {
    command: 'claude',
    loginCmd: ['claude', 'login'],
    authEnvKey: 'CLAUDE_CONFIG_DIR',
    instructions: `1. Follow the prompts to authenticate with Anthropic.
2. Each agent should use a separate profile or account.`,
  },
};

// ---- Login Options ----

export interface LoginOptions {
  agent?: string;
  cli?: string;
}

// ---- Main Login Command ----

export async function runLogin(options: LoginOptions): Promise<void> {
  // Pre-flight
  if (!isMaosInitialized()) {
    console.log(chalk.red('❌ MAOS is not initialized. Run: maos init'));
    process.exit(1);
  }

  // Load config
  const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  const cliAgents = config.agents.filter((a: any) => a.runtime === 'cli');

  if (cliAgents.length === 0 && !options.agent) {
    console.log(chalk.yellow('⚠️  No CLI agents configured.'));
    console.log(chalk.gray('  Use "maos init" with the "Mixed" preset to add CLI agents.'));
    console.log(chalk.gray('  Or manually add agents with "runtime": "cli" to maos.config.json'));
    return;
  }

  // Select agent
  let agentId = options.agent;
  if (!agentId) {
    const choices = cliAgents.map((a: any) => ({
      name: `${chalk.bold(a.id)} (${a.cliCommand || 'unknown'})`,
      value: a.id,
    }));

    const { selectedAgent } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedAgent',
      message: 'Select agent to authenticate:',
      choices,
    }]);
    agentId = selectedAgent;
  }

  // Find agent config
  const agentConfig = config.agents.find((a: any) => a.id === agentId);
  if (!agentConfig) {
    console.log(chalk.red(`❌ Agent "${agentId}" not found in config.`));
    process.exit(1);
  }

  // Determine CLI
  const cliName = options.cli || agentConfig.cliCommand;
  if (!cliName) {
    console.log(chalk.red(`❌ No CLI specified for agent "${agentId}".`));
    console.log(chalk.gray('  Use --cli copilot/codex/opencode/claude'));
    process.exit(1);
  }

  const profile = LOGIN_PROFILES[cliName];
  if (!profile) {
    console.log(chalk.red(`❌ Unknown CLI: "${cliName}".`));
    console.log(chalk.gray('  Supported: ' + Object.keys(LOGIN_PROFILES).join(', ')));
    process.exit(1);
  }

  // Setup auth directory
  const projectRoot = process.cwd();
  const authDir = path.resolve(
    projectRoot,
    agentConfig.auth?.[profile.authEnvKey] || `.maos/auth/${agentId}`,
  );

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Display banner
  const bannerLines = [
    `${getBrandBadge('AUTH')} ${chalk.bold.hex('#F1F5F9')('Agent Authentication')}`,
    `${chalk.gray('Secure workspace isolation folder mapping')}`
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#F59E0B')));
  console.log('');
  console.log(`  ${chalk.bold.hex('#94A3B8')('👥 Agent ID:')}   ${chalk.bold.green(agentId)}`);
  console.log(`  ${chalk.bold.hex('#94A3B8')('🔌 CLI Tool:')}   ${chalk.bold.cyan(cliName)}`);
  console.log(`  ${chalk.bold.hex('#94A3B8')('📁 Auth Dir:')}   ${chalk.gray(authDir)}`);
  console.log('');
  console.log(chalk.yellow('  ┌─────────────────────────────────────────────────────┐'));
  console.log(chalk.yellow('  │  IMPORTANT — READ BEFORE PROCEEDING:                │'));
  console.log(chalk.yellow('  │                                                     │'));
  for (const line of profile.instructions.split('\n')) {
    const padded = line.padEnd(53);
    console.log(chalk.yellow(`  │  ${padded}│`));
  }
  console.log(chalk.yellow('  │                                                     │'));
  console.log(chalk.yellow('  │  This ensures each agent has its OWN identity.      │'));
  console.log(chalk.yellow('  └─────────────────────────────────────────────────────┘'));
  console.log('');

  // Set auth env and run login
  console.log(chalk.white('  Starting login flow...\n'));

  try {
    const env = { ...process.env, [profile.authEnvKey]: authDir };

    // Use execFileSync with an array (NOT execSync with a joined string).
    // execSync(str) passes the command to PowerShell which misinterprets
    // 'login' as the Set-Location (cd) alias, causing:
    //   "Failed to change directory to ...\login"
    // execFileSync with [cmd, ...args] bypasses shell evaluation entirely.
    const [cmd, ...args] = profile.loginCmd;
    child_process.execFileSync(cmd, args, {
      cwd: projectRoot,
      env,
      stdio: 'inherit', // Show the login flow to the user
      shell: false,
    });

    console.log('');
    console.log(chalk.green(`  ✅ Login completed for ${agentId}.`));
    console.log('');

    // Show auth directory contents
    console.log(chalk.gray('  Auth directory contents:'));
    try {
      const files = listFilesRecursive(authDir, authDir);
      files.forEach(f => console.log(chalk.gray(`    ${f}`)));
    } catch {
      console.log(chalk.gray('    (empty or not readable)'));
    }

    // Verify identity if possible
    if (profile.verifyCmd) {
      console.log('');
      console.log(chalk.cyan('  Verifying identity...'));
      try {
        const result = child_process.execSync(profile.verifyCmd.join(' '), {
          cwd: projectRoot,
          env,
          encoding: 'utf-8',
          timeout: 15000,
        }).trim();
        console.log(chalk.green(`  Identity: ${result}`));
      } catch {
        console.log(chalk.yellow('  Could not verify identity automatically.'));
      }
    }
  } catch (err: any) {
    console.log('');
    console.log(chalk.red(`  ❌ Login FAILED for ${agentId}.`));
    console.log('');
    console.log(chalk.yellow('  Troubleshooting:'));
    console.log(chalk.yellow(`    1. Make sure '${cliName}' CLI is installed and on PATH.`));
    console.log(chalk.yellow(`    2. Try running: ${profile.loginCmd.join(' ')}`));
    console.log(chalk.yellow('       (without MAOS) to test if login works at all.'));
  }

  console.log('');
}

// ---- Helpers ----

function listFilesRecursive(dir: string, base: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(full, base));
      } else {
        results.push(relative);
      }
    }
  } catch { /* skip */ }
  return results;
}
