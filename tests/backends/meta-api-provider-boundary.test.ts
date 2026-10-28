import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderDirect, RuntimeFactory } from '../../src/backends/factory';
import { OpenAIProvider } from '../../src/backends/openai-provider';
import { ApiRuntime } from '../../src/backends/api-runtime';
import { MessageBus } from '../../src/core/message-bus';
import { MetaApiPolicyError } from '../../src/backends/meta-api-policy';

const META_URL = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3';
const servers: http.Server[] = [];
const environmentNames: string[] = [];

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function metaConfig(overrides: Record<string, unknown> = {}) {
  const envName = `MAOS_META_BOUNDARY_${Math.random().toString(36).slice(2).toUpperCase()}`;
  environmentNames.push(envName);
  return {
    baseURL: META_URL,
    apiKey: 'synthetic-config-key-must-not-be-used',
    apiKeyEnv: envName,
    metaApiEnabled: true,
    ...overrides,
  };
}

afterEach(async () => {
  for (const name of environmentNames.splice(0)) delete process.env[name];
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('shared Meta provider construction policy', () => {
  it.each([
    ['direct constructor without opt-in', () => new OpenAIProvider({ name: 'meta', apiKey: 'synthetic-key', baseURL: META_URL, model: MODEL })],
    ['disabled opt-in', () => createProviderDirect('meta', metaConfig({ metaApiEnabled: false }), MODEL)],
    ['hostile endpoint', () => createProviderDirect('meta', metaConfig({ baseURL: 'https://attacker.invalid/v1' }), MODEL)],
    ['wrong model', () => createProviderDirect('meta', metaConfig(), 'muse-spark-other')],
  ])('rejects %s before transport or credential fallback', (_label, construct) => {
    const fetchMock = vi.fn(async () => { throw new Error('unexpected network request'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(construct).toThrow(MetaApiPolicyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the SDK-level OPENAI_BASE_URL Meta override on direct construction', () => {
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = META_URL;
    const fetchMock = vi.fn(async () => { throw new Error('unexpected network request'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(() => new OpenAIProvider({ name: 'openai', apiKey: 'synthetic-key', model: MODEL })).toThrow(MetaApiPolicyError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }
  });

  it('requires the approved Meta endpoint to be explicit in provider configuration', () => {
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = META_URL;
    try {
      expect(() => new OpenAIProvider({
        name: 'meta', apiKey: 'synthetic-key', model: MODEL, metaApiEnabled: true, apiKeyEnv: 'MAOS_META_NOT_CONFIGURED',
      })).toThrow(MetaApiPolicyError);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }
  });

  it('uses only the named environment key and rejects before network when it is missing', () => {
    const config = metaConfig();
    expect(() => createProviderDirect('meta', config, MODEL)).toThrow(/environment variable/);
    expect(() => new OpenAIProvider({ name: 'meta', apiKey: 'synthetic-config-key-must-not-be-used', baseURL: META_URL, model: MODEL, metaApiEnabled: true, apiKeyEnv: config.apiKeyEnv as string })).toThrow(/environment variable/);
  });

  it('sets the provider-owned Core retry ceiling to zero for Meta', () => {
    const config = metaConfig();
    process.env[config.apiKeyEnv as string] = 'synthetic-meta-key-not-real';
    const provider = createProviderDirect('meta', config, MODEL) as OpenAIProvider;
    expect(provider.maxApplicationRetries).toBe(0);
    const runtime = RuntimeFactory.create(
      { id: 'planner', role: 'planner', provider: 'meta', model: MODEL, capabilities: [] },
      { meta: config as any },
      new MessageBus(),
    ) as ApiRuntime;
    expect(runtime.maxTaskRetries).toBe(0);
  });

  it('applies the shared guard to RuntimeFactory and doctor credential validation', () => {
    const config = metaConfig({ baseURL: 'https://attacker.invalid/v1' });
    expect(() => RuntimeFactory.create(
      { id: 'planner', role: 'planner', provider: 'meta', model: MODEL, capabilities: [] },
      { meta: config as any },
      new MessageBus(),
    )).toThrow(MetaApiPolicyError);
    expect(RuntimeFactory.validateCredentials(
      [{ id: 'planner', role: 'planner', provider: 'meta', model: MODEL, capabilities: [] }],
      { meta: config as any },
    )[0]).toMatchObject({ status: 'missing' });
  });

  it('rejects the Meta endpoint when another provider factory is selected', () => {
    const fetchMock = vi.fn(async () => { throw new Error('unexpected network request'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => RuntimeFactory.create(
      { id: 'planner', role: 'planner', provider: 'anthropic', model: MODEL, capabilities: [] },
      { anthropic: { baseURL: META_URL, apiKey: 'synthetic-key', metaApiEnabled: true } as any },
      new MessageBus(),
    )).toThrow(MetaApiPolicyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects redirects before the redirected host receives a request', async () => {
    const redirectTarget = await listen((_request, response) => response.writeHead(200).end('{"choices":[]}'));
    const primary = await listen((_request, response) => {
      response.writeHead(302, { Location: `http://localhost:${new URL(redirectTarget.url).port}/v1/chat/completions` }).end();
    });
    const originalFetch = globalThis.fetch.bind(globalThis);
    const redirects: Array<RequestRedirect | undefined> = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(META_URL)) {
        redirects.push(init?.redirect);
        return originalFetch(primary.url + '/v1/chat/completions', init);
      }
      return originalFetch(input, init);
    });

    const config = metaConfig();
    const apiKey = 'synthetic-meta-key-not-real';
    process.env[config.apiKeyEnv as string] = apiKey;
    const provider = createProviderDirect('meta', config, MODEL);
    await expect(provider.generate([{ role: 'user', content: 'bounded synthetic request' }])).rejects.toThrow();

    expect(primary.requests).toHaveLength(1);
    expect(primary.requests[0].headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(redirectTarget.requests).toHaveLength(0);
    expect(redirects).toEqual(['error']);
  });
});
