import * as fs from 'fs';
import { IProvider, ProviderConfig } from './provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { IRuntime, AgentRuntimeConfig } from './runtime';
import { ApiRuntime } from './api-runtime';
import { CliRuntime } from './cli-runtime';
import { MessageBus } from '../core/message-bus';

/**
 * Known provider base URLs.
 * Anything not listed here can be passed as a custom baseURL in config.
 */
const KNOWN_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  freemodel: 'https://api.freemodel.dev/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
};

/**
 * Providers that don't need an API key (local runners).
 */
const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio']);

/**
 * Default cost per million tokens for known providers.
 */
const DEFAULT_COSTS: Record<string, number> = {
  openai: 2.50,
  freemodel: 0.50,
  deepseek: 0.14,
  qwen: 0.50,
  together: 0.50,
  groq: 0.27,
  fireworks: 0.20,
  ollama: 0,
  lmstudio: 0,
  anthropic: 3.00,
  gemini: 1.25,
};

/**
 * Resolve an API key value.
 * Supports:
 *   - "env:VAR_NAME" -> reads from process.env
 *   - Direct string -> used as-is
 */
function resolveApiKey(value: string | undefined, providerName: string): string {
  if (!value) {
    if (NO_KEY_PROVIDERS.has(providerName.toLowerCase())) {
      return 'local'; // Ollama/LM Studio don't need keys
    }
    throw new Error(
      `No API key configured for provider "${providerName}". ` +
      `Set it in maos.config.json or as an environment variable.`
    );
  }

  if (value.startsWith('env:')) {
    const envVar = value.slice(4);
    const resolved = process.env[envVar];
    if (!resolved) {
      throw new Error(
        `Environment variable "${envVar}" is not set.\n` +
        `Set it with: export ${envVar}="your-key-here"\n` +
        `Or on Windows: $env:${envVar}="your-key-here"`
      );
    }
    return resolved;
  }

  return value;
}

/**
 * Create an IProvider instance (for API runtimes).
 */
function createProvider(
  providerName: string,
  config: ProviderConfig,
  model: string,
): IProvider {
  const name = providerName.toLowerCase();
  const apiKey = resolveApiKey(config.apiKey, name);
  const baseURL = config.baseURL || KNOWN_BASE_URLS[name] || undefined;

  switch (name) {
    case 'openai':
    case 'freemodel':
    case 'deepseek':
    case 'qwen':
    case 'together':
    case 'groq':
    case 'fireworks':
    case 'ollama':
    case 'lmstudio':
      return new OpenAIProvider({ name, apiKey, model, baseURL });

    case 'anthropic':
      return new AnthropicProvider({ name, apiKey, model });

    case 'gemini':
    case 'google':
      return new GeminiProvider({ name, apiKey, model });

    default:
      // Unknown provider -> try OpenAI-compatible format as fallback
      return new OpenAIProvider({ name, apiKey, model, baseURL });
  }
}

// ---- Runtime Factory ----

/**
 * RuntimeFactory creates the right IRuntime for any agent configuration.
 *
 * The evolution of ProviderFactory:
 *   - runtime: 'api'   -> ApiRuntime (wraps IProvider + agent-runner)
 *   - runtime: 'cli'   -> CliRuntime (spawns CLI in WT tab)
 *   - runtime: 'local' -> ApiRuntime (via localhost, same as Ollama/LM Studio)
 *
 * Backward compatible: if 'runtime' is missing, defaults to 'api'.
 */
export class RuntimeFactory {
  /**
   * Create a runtime instance for an agent.
   */
  static create(
    agentConfig: AgentRuntimeConfig,
    providerConfigs: Record<string, ProviderConfig & { costPerMillionTokens?: number }>,
    bus: MessageBus,
  ): IRuntime {
    const runtimeType = agentConfig.runtime || 'api';

    switch (runtimeType) {
      case 'api':
      case 'local': {
        // API and Local both use the same ApiRuntime —
        // local just uses a localhost URL (Ollama/LM Studio)
        const providerName = agentConfig.provider || 'freemodel';
        const model = agentConfig.model || 'gpt-5.4';
        const providerConfig = providerConfigs[providerName];

        if (!providerConfig) {
          throw new Error(
            `Agent "${agentConfig.id}" references provider "${providerName}" ` +
            `which is not defined in the providers section of maos.config.json`
          );
        }

        const provider = createProvider(providerName, providerConfig, model);
        const costPerMillion = providerConfig.costPerMillionTokens
          ?? DEFAULT_COSTS[providerName.toLowerCase()]
          ?? 0.50;

        return new ApiRuntime({
          provider,
          role: agentConfig.role,
          capabilities: agentConfig.capabilities,
          maxIterations: agentConfig.maxIterations || 25,
          costPerMillionTokens: costPerMillion,
        }, bus);
      }

      case 'cli': {
        if (!agentConfig.cliCommand) {
          throw new Error(
            `Agent "${agentConfig.id}" has runtime "cli" but no cliCommand specified. ` +
            `Set cliCommand to: copilot, codex, claude, or a custom CLI.`
          );
        }

        return new CliRuntime({
          cliCommand: agentConfig.cliCommand,
          cliArgs: agentConfig.cliArgs || [],
          authEnv: agentConfig.auth || {},
          timeoutMs: agentConfig.timeoutMs || 300_000,
          quiescenceMs: agentConfig.quiescenceMs || 30_000,
          role: agentConfig.role,
          capabilities: agentConfig.capabilities,
        }, bus);
      }

      default:
        throw new Error(`Unknown runtime type: "${runtimeType}" for agent "${agentConfig.id}"`);
    }
  }

  /**
   * Create all runtime instances from a full MAOS config.
   * Returns a map of agentId -> IRuntime.
   */
  static createFromConfig(
    agents: AgentRuntimeConfig[],
    providerConfigs: Record<string, ProviderConfig & { costPerMillionTokens?: number }>,
    bus: MessageBus,
  ): Map<string, IRuntime> {
    const runtimes = new Map<string, IRuntime>();

    for (const agent of agents) {
      const runtime = RuntimeFactory.create(agent, providerConfigs, bus);
      runtimes.set(agent.id, runtime);
    }

    return runtimes;
  }

  /**
   * List all known provider names for CLI help text.
   */
  static getKnownProviders(): string[] {
    return Object.keys(KNOWN_BASE_URLS);
  }

  /**
   * List all known CLI runtimes for CLI help text.
   */
  static getKnownCliRuntimes(): string[] {
    return ['copilot', 'codex', 'claude', 'antigravity'];
  }
}

// ---- Direct Provider Creation ----
// Used by decomposer/plan.ts which needs raw IProvider.generate() access.

export function createProviderDirect(
  providerName: string,
  config: ProviderConfig,
  model: string,
): IProvider {
  return createProvider(providerName, config, model);
}

// ---- Backward Compatibility ----
// Keep ProviderFactory as an alias so existing code doesn't break during transition.

export { RuntimeFactory as ProviderFactory };
