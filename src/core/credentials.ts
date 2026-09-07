/**
 * MAOS Credential Store
 *
 * Centralized credential management. Resolves API keys from multiple sources
 * with a clear priority chain:
 *
 *   1. .maos/credentials.json (managed by `maos configure`)
 *   2. .env file in project root
 *   3. Process environment variables
 *   4. maos.config.json (hardcoded — not recommended)
 *
 * This module replaces the scattered env: + .env pattern with a single
 * source of truth that never requires manual file editing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCredentialsPath, getMaosRoot } from '../utils/paths';

// ── Types ─────────────────────────────────────────────────────

export interface CredentialEntry {
  apiKey: string;
  savedAt: string;
  testedAt?: string;
  testResult?: 'ok' | 'failed';
}

export interface CredentialStore {
  version: 1;
  providers: Record<string, CredentialEntry>;
}

export type CredentialStatus = 'valid' | 'placeholder' | 'missing' | 'untested';

export interface CredentialCheckResult {
  agentId: string;
  provider: string;
  runtimeType: string;
  status: CredentialStatus;
  detail: string;
  source?: 'credential_store' | 'env_file' | 'environment' | 'config' | 'local';
}

export interface TestResult {
  success: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

// ── Placeholder Detection ─────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
  'your-key-here',
  'your-api-key-here',
  'your-api-key',
  'sk-your-key-here',
  'your_api_key',
  'change_me',
  'changeme',
  'change-me',
  'xxx',
  'placeholder',
  'example-key',
  'example_key',
  'your-key',
  'enter-your-key',
  'sk-...',
  'sk-xxxxx',
  'sk-xxx',
  'test-key',
  'test_key',
  'demo-key',
  'demo_key',
  'insert-key-here',
  'put-your-key-here',
  'api-key-goes-here',
  'todo',
  'fixme',
  'replace-me',
  'replace_me',
];

export function isPlaceholder(value: string): boolean {
  if (!value || value.trim().length === 0) return true;

  const normalized = value.toLowerCase().trim();

  // Known placeholder strings
  if (PLACEHOLDER_PATTERNS.some((p) => normalized.includes(p))) return true;

  // Too short to be a real key
  if (normalized.length < 8) return true;

  // All same character (e.g., 'aaaaaaaaaa')
  if (normalized.length >= 8 && new Set(normalized.replace(/[^a-z0-9]/g, '')).size <= 2) return true;

  return false;
}

// ── Local providers (no key needed) ───────────────────────────

const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio', 'huggingface-local']);

// ── Store I/O ─────────────────────────────────────────────────

function loadStore(cwd?: string): CredentialStore {
  const storePath = getCredentialsPath(cwd);
  if (!fs.existsSync(storePath)) {
    return { version: 1, providers: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return { version: 1, providers: {} };
  }
}

function saveStore(store: CredentialStore, cwd?: string): void {
  const storePath = getCredentialsPath(cwd);
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────

/**
 * Save an API key to the credential store.
 */
export function setCredential(provider: string, apiKey: string, cwd?: string): void {
  const store = loadStore(cwd);
  store.providers[provider] = {
    apiKey,
    savedAt: new Date().toISOString(),
  };
  saveStore(store, cwd);
}

/**
 * Mark a credential as tested.
 */
export function markCredentialTested(provider: string, result: 'ok' | 'failed', cwd?: string): void {
  const store = loadStore(cwd);
  const entry = store.providers[provider];
  if (entry) {
    entry.testedAt = new Date().toISOString();
    entry.testResult = result;
    saveStore(store, cwd);
  }
}

/**
 * Resolve an API key for a provider using the priority chain:
 *   1. .maos/credentials.json
 *   2. .env file (loaded via dotenv or already in process.env)
 *   3. Process environment variables
 *   4. Config file value
 *
 * Returns null if no valid key found.
 */
export function resolveCredential(
  provider: string,
  configApiKey?: string,
  cwd?: string,
): { key: string; source: CredentialCheckResult['source'] } | null {
  // 1. Credential store
  const store = loadStore(cwd);
  const storeEntry = store.providers[provider];
  if (storeEntry?.apiKey && !isPlaceholder(storeEntry.apiKey)) {
    return { key: storeEntry.apiKey, source: 'credential_store' };
  }

  // 2. Environment variable (common naming conventions)
  const envVarNames = [`${provider.toUpperCase()}_API_KEY`, `${provider.toUpperCase()}_KEY`];
  for (const envName of envVarNames) {
    const envVal = process.env[envName];
    if (envVal && !isPlaceholder(envVal)) {
      return { key: envVal, source: 'environment' };
    }
  }

  // 3. Config file value (resolve env: references)
  if (configApiKey) {
    if (configApiKey.startsWith('env:')) {
      const envVar = configApiKey.slice(4);
      const resolved = process.env[envVar];
      if (resolved && !isPlaceholder(resolved)) {
        return { key: resolved, source: 'env_file' };
      }
    } else if (!isPlaceholder(configApiKey)) {
      return { key: configApiKey, source: 'config' };
    }
  }

  return null;
}

/**
 * Get credential status for ALL agents in the config.
 * Used by fleet display, pre-flight checks, and the configure wizard.
 */
export function getAllCredentialStatuses(config: any, cwd?: string): CredentialCheckResult[] {
  const results: CredentialCheckResult[] = [];
  const providers: Record<string, any> = config.providers || {};

  for (const agent of config.agents || []) {
    const providerName = agent.provider;
    const runtimeType = agent.runtime || 'api';

    // CLI agents don't need API keys
    if (runtimeType === 'cli') {
      results.push({
        agentId: agent.id,
        provider: agent.cliCommand || providerName || 'cli',
        runtimeType,
        status: 'valid',
        detail: `CLI runtime (${agent.cliCommand || 'unknown'})`,
        source: 'local',
      });
      continue;
    }

    // Local providers (ollama, lmstudio)
    if (NO_KEY_PROVIDERS.has(providerName?.toLowerCase())) {
      results.push({
        agentId: agent.id,
        provider: providerName,
        runtimeType,
        status: 'valid',
        detail: 'Local provider (no key required)',
        source: 'local',
      });
      continue;
    }

    // API providers — resolve credential
    const providerConfig = providers[providerName];
    const resolved = resolveCredential(providerName, providerConfig?.apiKey, cwd);

    if (resolved) {
      const masked = maskKey(resolved.key);
      results.push({
        agentId: agent.id,
        provider: providerName,
        runtimeType,
        status: 'valid',
        detail: `Connected (${masked})`,
        source: resolved.source,
      });
    } else {
      // Determine if it's placeholder or truly missing
      const configKey = providerConfig?.apiKey;
      let detail = 'No API key configured';
      let status: CredentialStatus = 'missing';

      if (configKey) {
        if (configKey.startsWith('env:')) {
          const envVar = configKey.slice(4);
          const envVal = process.env[envVar];
          if (envVal && isPlaceholder(envVal)) {
            detail = `API key is a placeholder (${envVar})`;
            status = 'placeholder';
          } else if (!envVal) {
            detail = `Environment variable "${envVar}" is not set`;
            status = 'missing';
          }
        } else if (isPlaceholder(configKey)) {
          detail = 'API key is a placeholder';
          status = 'placeholder';
        }
      }

      results.push({
        agentId: agent.id,
        provider: providerName,
        runtimeType,
        status,
        detail,
      });
    }
  }

  return results;
}

/**
 * Test an API key by making a lightweight completions request to the provider.
 * Uses /chat/completions with max_tokens=1 — this is the ONLY reliable test
 * because some providers allow /models publicly but gate completions behind billing.
 */
export async function testCredential(provider: string, apiKey: string, baseURL?: string): Promise<TestResult> {
  const start = Date.now();

  // Known base URLs
  const KNOWN_URLS: Record<string, string> = {
    freemodel: 'https://api.freemodel.dev/v1',
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    together: 'https://api.together.xyz/v1',
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com',
  };

  // Known cheap test models per provider
  const TEST_MODELS: Record<string, string> = {
    freemodel: 'gpt-5.4-mini',
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    groq: 'llama-3.1-8b-instant',
    together: 'meta-llama/Meta-Llama-3-8B-Instruct-Turbo',
    anthropic: 'claude-haiku-4-5',
  };

  const url = baseURL || KNOWN_URLS[provider.toLowerCase()];
  if (!url) {
    // Unknown provider — skip test, assume valid (factory will throw at runtime if not)
    return { success: true, latencyMs: 0 };
  }

  // Anthropic uses a completely different API format
  if (provider.toLowerCase() === 'anthropic') {
    return testAnthropicCredential(apiKey, url, start);
  }

  // Gemini uses its own SDK — skip completions test
  if (provider.toLowerCase() === 'gemini' || provider.toLowerCase() === 'google') {
    return { success: true, latencyMs: 0 };
  }

  // OpenAI-compatible providers: test with a real completions request (max_tokens=1)
  try {
    const model = TEST_MODELS[provider.toLowerCase()] || 'gpt-4o-mini';
    const completionsUrl = `${url}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
      temperature: 0,
    });

    const response = await fetch(completionsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      /* ignore */
    }

    if (response.ok) {
      // Parse model name from response if available
      try {
        const data = JSON.parse(responseText);
        const usedModel = data?.model || model;
        return { success: true, model: usedModel, latencyMs };
      } catch {
        return { success: true, model, latencyMs };
      }
    } else if (response.status === 401 || response.status === 403) {
      let detail = 'Invalid API key';
      try {
        const errData = JSON.parse(responseText);
        detail = errData?.error?.message || errData?.message || detail;
      } catch {
        /* use default */
      }
      return { success: false, error: `Authentication failed: ${detail}`, latencyMs };
    } else if (response.status === 429) {
      return { success: false, error: 'Rate limit hit — try again shortly', latencyMs };
    } else if (response.status === 404) {
      // Model not found — key is valid but model doesn't exist, try with fallback model check
      // The key itself is valid if we got a 404 (auth passed)
      return { success: true, model: `(model ${model} not found — key valid)`, latencyMs };
    } else {
      return { success: false, error: `HTTP ${response.status}: ${responseText.substring(0, 100)}`, latencyMs };
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    if (err.name === 'AbortError') {
      return { success: false, error: 'Connection timed out (15s)', latencyMs };
    }
    return { success: false, error: err.message || 'Connection failed', latencyMs };
  }
}

async function testAnthropicCredential(apiKey: string, baseURL: string, start: number): Promise<TestResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    if (response.ok) {
      return { success: true, model: 'claude-haiku-4-5', latencyMs };
    } else if (response.status === 401 || response.status === 403) {
      return { success: false, error: 'Invalid Anthropic API key', latencyMs };
    }
    return { success: true, model: 'anthropic', latencyMs };
  } catch (err: any) {
    return { success: false, error: err.message || 'Connection failed', latencyMs: Date.now() - start };
  }
}

// ── Helpers ───────────────────────────────────────────────────

function maskKey(value: string): string {
  if (value.length <= 8) return '***';
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}
