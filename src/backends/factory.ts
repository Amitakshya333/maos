import * as fs from 'fs';
import { IProvider, ProviderConfig } from './provider';
import { OpenAIProvider } from './openai-provider';

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
 * Resolve an API key value.
 * Supports:
 *   - "env:VAR_NAME" → reads from process.env
 *   - Direct string → used as-is
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

// ─── Factory ──────────────────────────────────────────────────

/**
 * ProviderFactory creates the right IProvider instance for any provider name.
 * 
 * The key insight: most providers are OpenAI-compatible. So one adapter
 * class (OpenAIProvider) covers 80%+ of the market. We just swap the
 * baseURL and apiKey.
 * 
 * Usage:
 *   const provider = ProviderFactory.create('freemodel', config, 'gpt-5.4');
 *   const response = await provider.generate(messages, tools);
 */
export class ProviderFactory {
  /**
   * Create a provider instance.
   * 
   * @param providerName - Name of the provider (e.g., 'freemodel', 'deepseek', 'ollama')
   * @param config - Provider configuration from maos.config.json
   * @param model - Model identifier (e.g., 'gpt-5.4', 'deepseek-coder-v3')
   */
  static create(
    providerName: string,
    config: ProviderConfig,
    model: string,
  ): IProvider {
    const name = providerName.toLowerCase();
    const apiKey = resolveApiKey(config.apiKey, name);

    // Resolve base URL: config override → known URL → SDK default
    const baseURL = config.baseURL || KNOWN_BASE_URLS[name] || undefined;

    // All OpenAI-compatible providers use the same adapter
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
        return new OpenAIProvider({
          name,
          apiKey,
          model,
          baseURL,
        });

      // Future native adapters (Day 5+):
      // case 'anthropic':
      //   return new AnthropicProvider({ name, apiKey, model });
      // case 'gemini':
      //   return new GeminiProvider({ name, apiKey, model });

      default:
        // Unknown provider → try OpenAI-compatible format as fallback
        // This lets users plug in ANY OpenAI-compat endpoint
        return new OpenAIProvider({
          name,
          apiKey,
          model,
          baseURL,
        });
    }
  }

  /**
   * Create all provider instances from a full MAOS config.
   * Returns a map of agentId → IProvider.
   */
  static createFromConfig(config: {
    providers: Record<string, ProviderConfig>;
    agents: Array<{ id: string; provider: string; model: string }>;
  }): Map<string, IProvider> {
    const providers = new Map<string, IProvider>();

    for (const agent of config.agents) {
      const providerConfig = config.providers[agent.provider];
      if (!providerConfig) {
        throw new Error(
          `Agent "${agent.id}" references provider "${agent.provider}" ` +
          `which is not defined in the providers section of maos.config.json`
        );
      }

      const provider = ProviderFactory.create(
        agent.provider,
        providerConfig,
        agent.model,
      );

      providers.set(agent.id, provider);
    }

    return providers;
  }

  /**
   * List all known provider names for the CLI help text.
   */
  static getKnownProviders(): string[] {
    return Object.keys(KNOWN_BASE_URLS);
  }
}
