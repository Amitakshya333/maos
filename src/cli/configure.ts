/**
 * MAOS Configure Command
 *
 * Interactive credential wizard for API providers.
 * Replaces manual .env editing with a guided flow.
 *
 * Usage:
 *   maos configure              — Interactive provider selection
 *   maos configure freemodel    — Configure a specific provider
 */

import * as fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { getConfigPath, isMaosInitialized } from '../utils/paths';
import { renderPanel, getBrandBadge, icons } from '../utils/ui';
import {
  getAllCredentialStatuses,
  setCredential,
  markCredentialTested,
  testCredential,
  resolveCredential,
  CredentialCheckResult,
} from '../core/credentials';

// ── Status Icons ──────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'valid':
      return chalk.green('✅');
    case 'placeholder':
      return chalk.yellow('⚠️');
    case 'missing':
      return chalk.red('❌');
    default:
      return chalk.gray('○');
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'valid':
      return chalk.green('Connected');
    case 'placeholder':
      return chalk.yellow('Placeholder key');
    case 'missing':
      return chalk.red('Missing API key');
    default:
      return chalk.gray('Unknown');
  }
}

// ── Provider Display ──────────────────────────────────────────

function showProviderStatus(statuses: CredentialCheckResult[]): void {
  // Group by provider (multiple agents may share a provider)
  const providerMap = new Map<string, { status: string; agents: string[]; detail: string; source?: string }>();

  for (const s of statuses) {
    const existing = providerMap.get(s.provider);
    if (existing) {
      existing.agents.push(s.agentId);
      // Use the worst status
      if (s.status === 'missing' || (s.status === 'placeholder' && existing.status !== 'missing')) {
        existing.status = s.status;
        existing.detail = s.detail;
      }
    } else {
      providerMap.set(s.provider, {
        status: s.status,
        agents: [s.agentId],
        detail: s.detail,
        source: s.source,
      });
    }
  }

  console.log('');
  console.log(chalk.bold('  Provider Status'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));

  for (const [provider, info] of providerMap) {
    const icon = statusIcon(info.status);
    const label = statusLabel(info.status);
    const agents = info.agents.map((a) => chalk.gray(a)).join(', ');
    console.log(`  ${icon}  ${chalk.bold.white(provider.padEnd(14))} ${label}`);
    console.log(chalk.gray(`      Agents: ${agents}`));
    if (info.source && info.status === 'valid') {
      console.log(chalk.gray(`      Source: ${info.source}`));
    }
  }
  console.log('');
}

// ── Configure Flow ────────────────────────────────────────────

async function configureProvider(providerName: string, config: any): Promise<void> {
  const providerConfig = config.providers?.[providerName];
  const baseURL = providerConfig?.baseURL;

  console.log('');
  console.log(chalk.bold(`  Configure: ${providerName}`));
  if (baseURL) {
    console.log(chalk.gray(`  Base URL: ${baseURL}`));
  }

  // Show current key status
  const existing = resolveCredential(providerName, providerConfig?.apiKey);
  if (existing) {
    const masked =
      existing.key.length > 8
        ? existing.key.substring(0, 4) +
          '•'.repeat(Math.min(20, existing.key.length - 8)) +
          existing.key.substring(existing.key.length - 4)
        : '•'.repeat(8);
    console.log(chalk.gray(`  Current key: ${masked} (from ${existing.source})`));
  }

  console.log('');

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: `Enter ${providerName} API key:`,
      mask: '•',
      validate: (val: string) => {
        if (!val || val.trim().length === 0) return 'API key cannot be empty';
        if (val.trim().length < 8) return 'API key seems too short (minimum 8 characters)';
        return true;
      },
    },
  ]);

  // Test the key
  console.log('');
  console.log(chalk.gray('  ⏳ Validating key...'));

  const result = await testCredential(providerName, apiKey.trim(), baseURL);

  if (result.success) {
    console.log(
      chalk.green(
        `  ✅ Connected successfully${result.model ? ` (${result.model})` : ''}${result.latencyMs ? `, ${result.latencyMs}ms` : ''}`,
      ),
    );
    setCredential(providerName, apiKey.trim());
    markCredentialTested(providerName, 'ok');
    console.log(chalk.green('  ✅ Saved to .maos/credentials.json'));
  } else {
    console.log(chalk.yellow(`  ⚠️  Connection test failed: ${result.error}`));
    console.log('');

    const { saveAnyway } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'saveAnyway',
        message: 'Save key anyway? (you can re-test later)',
        default: true,
      },
    ]);

    if (saveAnyway) {
      setCredential(providerName, apiKey.trim());
      markCredentialTested(providerName, 'failed');
      console.log(chalk.gray('  Saved. Re-test with: maos configure'));
    } else {
      console.log(chalk.gray('  Key not saved.'));
    }
  }

  // Show which agents are affected
  const statuses = getAllCredentialStatuses(config);
  const affected = statuses.filter((s) => s.provider === providerName);
  if (affected.length > 0) {
    console.log('');
    console.log(chalk.gray('  Agents using this provider:'));
    for (const a of affected) {
      const roleIcon = a.agentId.includes('ARCHITECT')
        ? '🧠'
        : a.agentId.includes('REVIEWER')
          ? '🔍'
          : a.agentId.includes('CODER')
            ? '⚙️'
            : '📦';
      console.log(chalk.gray(`    ${roleIcon}  ${a.agentId}`));
    }
  }
}

// ── Main Entry ────────────────────────────────────────────────

export async function runConfigure(args: string[] = []): Promise<void> {
  if (!isMaosInitialized()) {
    console.log(chalk.red('  ❌ MAOS is not initialized. Run: maos init'));
    return;
  }

  const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

  // Banner
  const bannerLines = [
    `${getBrandBadge('CFG')} ${chalk.bold.hex('#F1F5F9')('Provider Configuration')}`,
    `${chalk.gray('Configure API keys for your agent fleet')}`,
  ];
  console.log(renderPanel(bannerLines, chalk.hex('#F59E0B')));

  // If a specific provider was given as argument
  if (args[0] && args[0] !== 'list') {
    await configureProvider(args[0], config);
    return;
  }

  // Show current status
  const statuses = getAllCredentialStatuses(config);
  showProviderStatus(statuses);

  // Find unique API providers
  const apiProviders = new Set<string>();
  for (const agent of config.agents || []) {
    const rt = agent.runtime || 'api';
    if (rt === 'api' && agent.provider) {
      apiProviders.add(agent.provider);
    }
  }

  if (apiProviders.size === 0) {
    console.log(chalk.gray('  No API providers configured. All agents use CLI runtimes.'));
    return;
  }

  // Let user select which provider to configure
  const choices = Array.from(apiProviders).map((p) => {
    const providerStatuses = statuses.filter((s) => s.provider === p);
    const worst =
      providerStatuses.find((s) => s.status === 'missing') ||
      providerStatuses.find((s) => s.status === 'placeholder') ||
      providerStatuses[0];
    const icon = worst ? statusIcon(worst.status) : chalk.gray('○');
    return {
      name: `${icon}  ${p}`,
      value: p,
    };
  });

  const { selectedProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedProvider',
      message: 'Select provider to configure:',
      choices,
    },
  ]);

  await configureProvider(selectedProvider, config);
}
