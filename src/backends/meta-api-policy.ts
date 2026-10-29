export const META_API_BASE_URL = 'https://api.meta.ai/v1';
export const META_API_MODEL = 'muse-spark-1.3';
export const BASETEN_API_BASE_URL = 'https://inference.baseten.co/v1';
export const BASETEN_API_MODEL = 'meta-models/muse-spark-open-1026';
export const BASETEN_API_KEY_ENV = 'BASETEN_API_KEY';

const ENVIRONMENT_VARIABLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ProviderApiPolicyErrorCode =
  | 'META_API_OPT_IN_REQUIRED'
  | 'META_API_CONFIGURATION_INVALID'
  | 'BASETEN_API_OPT_IN_REQUIRED'
  | 'BASETEN_API_CONFIGURATION_INVALID'
  | 'MODEL_CREDENTIAL_MISSING';

export class ProviderApiPolicyError extends Error {
  constructor(public readonly code: ProviderApiPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ProviderApiPolicyError';
  }
}

export class MetaApiPolicyError extends ProviderApiPolicyError {
  constructor(code: 'META_API_OPT_IN_REQUIRED' | 'META_API_CONFIGURATION_INVALID' | 'MODEL_CREDENTIAL_MISSING', message: string) {
    super(code, message);
    this.name = 'MetaApiPolicyError';
  }
}

export interface HostedApiProviderConfig {
  providerName?: string;
  baseURL?: string;
  effectiveBaseURL?: string;
  model: string;
  metaApiEnabled?: boolean;
  basetenApiEnabled?: boolean;
  apiKeyEnv?: string;
  temperature?: number | null;
}

export interface HostedApiPolicy {
  provider: 'meta' | 'baseten';
  apiKey: string;
  apiKeyEnv: string;
  temperature: number | null;
}

export interface ProviderCredentialUseConfig extends HostedApiProviderConfig {
  apiKey?: string;
}

export type MetaApiProviderConfig = HostedApiProviderConfig;

/** Conservative identifier syntax only; a valid name is not proof that it is nonsecret. */
export function isEnvironmentVariableIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && ENVIRONMENT_VARIABLE_IDENTIFIER.test(value);
}

export function assertMetaApiKeyEnvIdentifier(value: unknown): asserts value is string {
  if (!isEnvironmentVariableIdentifier(value)) {
    throw policyError(
      'meta',
      'META_API_CONFIGURATION_INVALID',
      'Invalid providers.<name>.apiKeyEnv; use an environment-variable identifier matching [A-Za-z_][A-Za-z0-9_]*.',
    );
  }
}

function hasHost(config: Pick<HostedApiProviderConfig, 'baseURL' | 'effectiveBaseURL'>, hostname: string): boolean {
  return [config.baseURL, config.effectiveBaseURL].some((baseURL) => {
    try {
      return new URL(baseURL || '').hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
}

export function isMetaApiConfigCandidate(config: Pick<HostedApiProviderConfig, 'providerName' | 'baseURL' | 'effectiveBaseURL' | 'metaApiEnabled'>): boolean {
  return config.metaApiEnabled === true || config.providerName?.toLowerCase() === 'meta' || hasHost(config, 'api.meta.ai');
}

export function isBasetenApiConfigCandidate(config: Pick<HostedApiProviderConfig, 'providerName' | 'baseURL' | 'effectiveBaseURL' | 'basetenApiEnabled'>): boolean {
  return config.basetenApiEnabled === true || config.providerName?.toLowerCase() === 'baseten' || hasHost(config, 'inference.baseten.co');
}

export function isHostedApiConfigCandidate(config: HostedApiProviderConfig): boolean {
  return isMetaApiConfigCandidate(config) || isBasetenApiConfigCandidate(config);
}

/** Collects Meta key names from project config so another provider cannot alias them. */
export function collectReservedMetaApiKeyEnvVars(providerConfigs: Record<string, unknown> | undefined): string[] {
  const reserved = new Set<string>();
  for (const [providerName, value] of Object.entries(providerConfigs || {})) {
    if (!value || typeof value !== 'object') continue;
    const config = value as HostedApiProviderConfig;
    if (!isMetaApiConfigCandidate({ providerName, baseURL: config.baseURL, metaApiEnabled: config.metaApiEnabled })) continue;
    assertMetaApiKeyEnvIdentifier(config.apiKeyEnv);
    reserved.add(config.apiKeyEnv);
  }
  return [...reserved];
}

function isExactMetaDestination(config: ProviderCredentialUseConfig): boolean {
  return isMetaApiConfigCandidate(config) &&
    config.baseURL === META_API_BASE_URL && config.model === META_API_MODEL &&
    isEnvironmentVariableIdentifier(config.apiKeyEnv);
}

function isExactBasetenDestination(config: ProviderCredentialUseConfig): boolean {
  return config.providerName?.toLowerCase() === 'baseten' &&
    config.baseURL === BASETEN_API_BASE_URL && config.model === BASETEN_API_MODEL &&
    (config.apiKeyEnv === undefined || config.apiKeyEnv === BASETEN_API_KEY_ENV);
}

function reservedCredentialOwner(envName: string, metaApiKeyEnvVars: readonly string[]): 'meta' | 'baseten' | undefined {
  if (envName === BASETEN_API_KEY_ENV) return 'baseten';
  if (metaApiKeyEnvVars.includes(envName)) return 'meta';
  return undefined;
}

function reservedCredentialError(owner: 'meta' | 'baseten'): ProviderApiPolicyError {
  return owner === 'meta'
    ? policyError('meta', 'META_API_CONFIGURATION_INVALID', 'A credential reference in providers.<name>.apiKey or apiKeyEnv is reserved for the exact enabled Meta Model API destination.')
    : policyError('baseten', 'BASETEN_API_CONFIGURATION_INVALID', `${BASETEN_API_KEY_ENV} is reserved for the explicitly enabled exact Baseten endpoint and model.`);
}

/**
 * Prevents reserved hosted credentials from being used through generic providers.
 * Literal-key equality is checked in memory only; error text contains names, never values.
 */
export function assertCredentialUsePolicy(
  config: ProviderCredentialUseConfig,
  metaApiKeyEnvVars: readonly string[] = [],
): void {
  if (isMetaApiConfigCandidate(config)) assertMetaApiKeyEnvIdentifier(config.apiKeyEnv);
  for (const name of metaApiKeyEnvVars) assertMetaApiKeyEnvIdentifier(name);

  const reservedMetaNames = new Set(metaApiKeyEnvVars);
  if (isMetaApiConfigCandidate(config)) reservedMetaNames.add(config.apiKeyEnv!);
  const reservedNames = [BASETEN_API_KEY_ENV, ...reservedMetaNames];
  const metaDestination = isExactMetaDestination(config);
  const basetenDestination = isExactBasetenDestination(config);
  const references = [
    config.apiKeyEnv,
    typeof config.apiKey === 'string' && config.apiKey.startsWith('env:') ? config.apiKey.slice(4) : undefined,
  ].filter((name): name is string => typeof name === 'string');

  for (const name of references) {
    const owner = reservedCredentialOwner(name, [...reservedMetaNames]);
    if (!owner) continue;
    const allowed = owner === 'baseten'
      ? basetenDestination
      : metaDestination && config.apiKeyEnv === name;
    if (!allowed) throw reservedCredentialError(owner);
  }

  if (typeof config.apiKey === 'string' && !config.apiKey.startsWith('env:')) {
    for (const name of reservedNames) {
      const owner = reservedCredentialOwner(name, [...reservedMetaNames]);
      const currentReservedValue = process.env[name];
      if (!owner || !currentReservedValue || config.apiKey !== currentReservedValue) continue;
      const allowed = owner === 'baseten'
        ? basetenDestination
        : metaDestination && config.apiKeyEnv === name;
      if (!allowed) throw reservedCredentialError(owner);
    }
  }
}

/** Generic credential lookup is never permitted to consume a hosted-reserved key. */
export function assertGenericCredentialUse(
  apiKey: string | undefined,
  reservedMetaApiKeyEnvVars: readonly string[] = [],
): void {
  for (const name of reservedMetaApiKeyEnvVars) assertMetaApiKeyEnvIdentifier(name);
  const reservedMetaNames = new Set(reservedMetaApiKeyEnvVars);
  const reference = apiKey?.startsWith('env:') ? apiKey.slice(4) : undefined;
  for (const name of [BASETEN_API_KEY_ENV, ...reservedMetaNames]) {
    const owner = reservedCredentialOwner(name, [...reservedMetaNames]);
    if (!owner) continue;
    if (reference === name || (apiKey && !reference && process.env[name] && apiKey === process.env[name])) {
      throw reservedCredentialError(owner);
    }
  }
}

function policyError(provider: 'meta' | 'baseten', code: ProviderApiPolicyErrorCode, message: string): ProviderApiPolicyError {
  return provider === 'meta'
    ? new MetaApiPolicyError(code as 'META_API_OPT_IN_REQUIRED' | 'META_API_CONFIGURATION_INVALID' | 'MODEL_CREDENTIAL_MISSING', message)
    : new ProviderApiPolicyError(code, message);
}

export function resolveHostedApiPolicy(config: HostedApiProviderConfig): HostedApiPolicy | undefined {
  const isMeta = isMetaApiConfigCandidate(config);
  const isBaseten = isBasetenApiConfigCandidate(config);
  if (isMeta) assertMetaApiKeyEnvIdentifier(config.apiKeyEnv);
  if (!isMeta && !isBaseten) return undefined;
  if (isMeta && isBaseten) {
    throw new ProviderApiPolicyError('META_API_CONFIGURATION_INVALID', 'Select exactly one approved hosted provider policy.');
  }

  const provider = isMeta ? 'meta' : 'baseten';
  const providerName = config.providerName?.toLowerCase();
  const optIn = isMeta ? config.metaApiEnabled : config.basetenApiEnabled;
  const endpoint = isMeta ? META_API_BASE_URL : BASETEN_API_BASE_URL;
  const model = isMeta ? META_API_MODEL : BASETEN_API_MODEL;
  const optInField = isMeta ? 'metaApiEnabled' : 'basetenApiEnabled';
  const errorPrefix = isMeta ? 'META_API' : 'BASETEN_API';

  if (optIn !== true) {
    throw policyError(provider, `${errorPrefix}_OPT_IN_REQUIRED`, `${provider === 'meta' ? 'Meta' : 'Baseten'} Model API use requires providers.<name>.${optInField}=true.`);
  }
  if (config.baseURL !== endpoint || config.model !== model || (provider === 'baseten' && providerName !== 'baseten')) {
    throw policyError(
      provider,
      `${errorPrefix}_CONFIGURATION_INVALID`,
      provider === 'meta'
        ? `Meta Model API is limited to ${META_API_BASE_URL} and model ${META_API_MODEL}.`
        : `Baseten Model API is limited to provider "baseten", ${BASETEN_API_BASE_URL}, and model ${BASETEN_API_MODEL}.`,
    );
  }

  if (!isMeta && config.apiKeyEnv !== undefined && config.apiKeyEnv !== BASETEN_API_KEY_ENV) {
    throw policyError('baseten', 'BASETEN_API_CONFIGURATION_INVALID', `Baseten credentials must come from ${BASETEN_API_KEY_ENV}.`);
  }
  if (isMeta && config.temperature !== undefined && config.temperature !== null &&
      (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) {
    throw policyError('meta', 'META_API_CONFIGURATION_INVALID', 'Meta provider temperature must be a number from 0 to 2 when configured.');
  }

  const apiKeyEnv = isMeta ? config.apiKeyEnv! : BASETEN_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey?.trim()) {
    throw policyError(
      provider,
      'MODEL_CREDENTIAL_MISSING',
      provider === 'meta'
        ? 'The configured credential environment reference is empty. Set the configured environment variable before using the Meta Model API.'
        : `The configured environment variable ${BASETEN_API_KEY_ENV} is empty. Set it before using the Baseten Model API.`,
    );
  }
  return { provider, apiKey, apiKeyEnv, temperature: isMeta ? config.temperature ?? null : null };
}

export function resolveMetaApiPolicy(config: MetaApiProviderConfig): HostedApiPolicy | undefined {
  if (!isMetaApiConfigCandidate(config)) return undefined;
  const policy = resolveHostedApiPolicy(config);
  return policy?.provider === 'meta' ? policy : undefined;
}
