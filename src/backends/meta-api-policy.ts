export const META_API_BASE_URL = 'https://api.meta.ai/v1';
export const META_API_MODEL = 'muse-spark-1.3';

export class MetaApiPolicyError extends Error {
  constructor(public readonly code: 'META_API_OPT_IN_REQUIRED' | 'META_API_CONFIGURATION_INVALID' | 'MODEL_CREDENTIAL_MISSING', message: string) {
    super(message);
    this.name = 'MetaApiPolicyError';
  }
}

export interface MetaApiProviderConfig {
  providerName?: string;
  baseURL?: string;
  effectiveBaseURL?: string;
  model: string;
  metaApiEnabled?: boolean;
  apiKeyEnv?: string;
  temperature?: number | null;
}

export function isMetaApiConfigCandidate(config: Pick<MetaApiProviderConfig, 'providerName' | 'baseURL' | 'effectiveBaseURL' | 'metaApiEnabled'>): boolean {
  if (config.metaApiEnabled === true || config.providerName?.toLowerCase() === 'meta') return true;
  for (const baseURL of [config.baseURL, config.effectiveBaseURL]) {
    try {
      if (new URL(baseURL || '').hostname.toLowerCase() === 'api.meta.ai') return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function resolveMetaApiPolicy(config: MetaApiProviderConfig): { apiKey: string; apiKeyEnv: string; temperature: number | null } | undefined {
  if (!isMetaApiConfigCandidate(config)) return undefined;

  if (config.metaApiEnabled !== true) {
    throw new MetaApiPolicyError('META_API_OPT_IN_REQUIRED', 'Meta Model API use requires providers.<name>.metaApiEnabled=true.');
  }
  if (config.baseURL !== META_API_BASE_URL || config.model !== META_API_MODEL) {
    throw new MetaApiPolicyError(
      'META_API_CONFIGURATION_INVALID',
      `Meta Model API is limited to ${META_API_BASE_URL} and model ${META_API_MODEL}.`,
    );
  }
  if (typeof config.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
    throw new MetaApiPolicyError('META_API_CONFIGURATION_INVALID', 'Set providers.<name>.apiKeyEnv to the environment variable that holds the Meta API key.');
  }
  if (config.temperature !== undefined && config.temperature !== null &&
      (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) {
    throw new MetaApiPolicyError('META_API_CONFIGURATION_INVALID', 'Meta provider temperature must be a number from 0 to 2 when configured.');
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey?.trim()) {
    throw new MetaApiPolicyError(
      'MODEL_CREDENTIAL_MISSING',
      `The configured environment variable ${config.apiKeyEnv} is empty. Set it before using the Meta Model API.`,
    );
  }
  return { apiKey, apiKeyEnv: config.apiKeyEnv, temperature: config.temperature ?? null };
}
