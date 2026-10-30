import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRuntime } from '../../src/backends/api-runtime';
import { createProviderDirect, RuntimeFactory } from '../../src/backends/factory';
import { OpenAIProvider } from '../../src/backends/openai-provider';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL, META_API_BASE_URL, META_API_MODEL, ProviderApiPolicyError } from '../../src/backends/meta-api-policy';
import { runDoctor } from '../../src/cli/doctor';
import { runPlan } from '../../src/cli/plan';
import { getAllCredentialStatuses } from '../../src/core/credentials';
import { MessageBus } from '../../src/core/message-bus';
import { runAgent } from '../../src/core/agent-runner';

const apiKey = 'synthetic-baseten-key-not-real';
const servers: http.Server[] = [];
const projects: string[] = [];
const originalCwds: string[] = [];

async function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse, body: any) => void | Promise<void>) {
  const requests: Array<{ body: any; headers: http.IncomingHttpHeaders; url: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
      requests.push({ body, headers: request.headers, url: request.url || '' });
      await handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: BASETEN_API_BASE_URL,
    basetenApiEnabled: true,
    apiKey: 'synthetic-config-key-must-not-be-used',
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return (request: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function toolCompletion() {
  return {
    id: 'chatcmpl-baseten-contract',
    object: 'chat.completion',
    created: 1,
    model: BASETEN_API_MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-baseten', type: 'function', function: { name: 'analyze_telemetry_csv', arguments: '{"sourcePath":"selected.csv"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

afterEach(async () => {
  const previous = originalCwds.pop();
  if (previous) process.chdir(previous);
  delete process.env[BASETEN_API_KEY_ENV];
  delete process.env.META_RESERVED_TEST_KEY;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const project of projects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('Baseten exact opt-in provider policy (loopback/injected transport only)', () => {
  it('pins the hackathon grant model exactly', () => {
    expect(BASETEN_API_MODEL).toBe('meta-models/muse-spark-open-1026');
  });

  it.each([
    ['direct constructor without opt-in', () => new OpenAIProvider({ name: 'baseten', apiKey: 'synthetic-direct-key', baseURL: BASETEN_API_BASE_URL, model: BASETEN_API_MODEL })],
    ['disabled opt-in', () => createProviderDirect('baseten', config({ basetenApiEnabled: false }), BASETEN_API_MODEL)],
    ['hostile endpoint', () => createProviderDirect('baseten', config({ baseURL: 'https://attacker.invalid/v1' }), BASETEN_API_MODEL)],
    ['old Beam grant model', () => createProviderDirect('baseten', config(), 'reflection/Beam-1.0')],
    ['generic Muse Spark docs slug', () => createProviderDirect('baseten', config(), 'meta-models/muse-spark-open')],
    ['Baseten endpoint under a different provider name', () => createProviderDirect('openai', config(), BASETEN_API_MODEL)],
    ['arbitrary credential variable', () => createProviderDirect('baseten', config({ apiKeyEnv: 'OTHER_API_KEY' }), BASETEN_API_MODEL)],
  ])('rejects %s before network use', (_label, construct) => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const fetchMock = vi.fn(async () => { throw new Error('unexpected request'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(construct).toThrow(ProviderApiPolicyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires BASETEN_API_KEY even when a direct key fallback is supplied', () => {
    delete process.env[BASETEN_API_KEY_ENV];
    const fetchMock = vi.fn(async () => { throw new Error('unexpected request'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => createProviderDirect('baseten', config(), BASETEN_API_MODEL)).toThrow(/BASETEN_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('covers plan provider construction and doctor credential checks without inference', () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const fetchMock = vi.fn(async () => { throw new Error('unexpected inference request'); });
    vi.stubGlobal('fetch', fetchMock);
    const providerConfig = config();
    const provider = createProviderDirect('baseten', providerConfig, BASETEN_API_MODEL) as OpenAIProvider;
    expect(provider.isBasetenApi).toBe(true);
    expect(provider.isMetaApi).toBe(false);
    expect(provider.maxApplicationRetries).toBe(0);
    expect(RuntimeFactory.getKnownProviders()).toContain('baseten');

    const agent = { id: 'planner', role: 'planner', provider: 'baseten', model: BASETEN_API_MODEL, capabilities: [] };
    const runtime = RuntimeFactory.create(agent, { baseten: providerConfig as any }, new MessageBus()) as ApiRuntime;
    expect(runtime.maxTaskRetries).toBe(0);
    expect(RuntimeFactory.validateCredentials([agent], { baseten: providerConfig as any })[0])
      .toMatchObject({ status: 'ok', source: 'environment' });

    delete process.env[BASETEN_API_KEY_ENV];
    expect(RuntimeFactory.validateCredentials([agent], { baseten: providerConfig as any })[0])
      .toMatchObject({ status: 'missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks the reserved Baseten variable in generic factory and plan/direct paths before credential lookup or HTTP', () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const fetchMock = vi.fn(async () => { throw new Error('unexpected request'); });
    vi.stubGlobal('fetch', fetchMock);
    const hostileOpenAi = { baseURL: 'https://attacker.invalid/v1', apiKey: `env:${BASETEN_API_KEY_ENV}` };
    const projectProviders = { openai: hostileOpenAi, baseten: config() };
    const agent = { id: 'planner', role: 'planner', provider: 'openai', model: 'gpt-test', capabilities: [] };

    expect(() => RuntimeFactory.create(agent, projectProviders as any, new MessageBus())).toThrow(ProviderApiPolicyError);
    expect(() => createProviderDirect('openai', hostileOpenAi, 'gpt-test', projectProviders as any)).toThrow(ProviderApiPolicyError);
    expect(() => new OpenAIProvider({ name: 'openai', apiKey: `env:${BASETEN_API_KEY_ENV}`, baseURL: 'https://attacker.invalid/v1', model: 'gpt-test' })).toThrow(ProviderApiPolicyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes a real plan invocation through the project-wide reserved-key check', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-baseten-plan-'));
    projects.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.maos', 'maos.config.json'), JSON.stringify({
      schemaVersion: 1,
      projectName: 'reserved-key-plan-test',
      providers: {
        openai: { baseURL: 'https://attacker.invalid/v1', apiKey: `env:${BASETEN_API_KEY_ENV}` },
        baseten: config(),
      },
      agents: [{ id: 'planner', role: 'planner', provider: 'openai', model: 'gpt-test', capabilities: [] }],
    }));
    originalCwds.push(process.cwd());
    process.chdir(projectRoot);
    const fetchMock = vi.fn(async () => { throw new Error('unexpected request'); });
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('plan-exit'); }) as any);

    await expect(runPlan('synthetic plan request', {})).rejects.toThrow('plan-exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join('\n')).toContain(BASETEN_API_KEY_ENV);
    expect(log.mock.calls.flat().join('\n')).not.toContain(apiKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a generic reserved-key credential unavailable in the shared preflight resolver', () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-baseten-credential-preflight-'));
    projects.push(projectRoot);
    const statuses = getAllCredentialStatuses({
      projectName: 'reserved-key-preflight-test',
      providers: { openai: { baseURL: 'https://attacker.invalid/v1', apiKey: `env:${BASETEN_API_KEY_ENV}` }, baseten: config() },
      agents: [{ id: 'generic', provider: 'openai', model: 'gpt-test' }],
    }, projectRoot);

    expect(statuses[0]).toMatchObject({ status: 'missing', detail: expect.stringContaining(BASETEN_API_KEY_ENV) });
    expect(JSON.stringify(statuses)).not.toContain(apiKey);
  });

  it('blocks direct-key reuse and a configured Meta key alias through doctor validation', () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    process.env.META_RESERVED_TEST_KEY = 'synthetic-meta-key-not-real';
    const fetchMock = vi.fn(async () => { throw new Error('unexpected request'); });
    vi.stubGlobal('fetch', fetchMock);
    const directReuse = { baseURL: 'http://127.0.0.1:9999/v1', apiKey };
    const providers = {
      openai: { baseURL: 'https://attacker.invalid/v1', apiKey: 'env:META_RESERVED_TEST_KEY' },
      baseten: config(),
      meta: { baseURL: META_API_BASE_URL, metaApiEnabled: true, apiKeyEnv: 'META_RESERVED_TEST_KEY' },
    };
    const agent = { id: 'generic', role: 'analyst', provider: 'openai', model: 'gpt-test', capabilities: [] };

    expect(() => createProviderDirect('openai', directReuse, 'gpt-test', providers as any)).toThrow(ProviderApiPolicyError);
    const status = RuntimeFactory.validateCredentials([agent], providers as any)[0];
    expect(status).toMatchObject({ status: 'missing', message: expect.stringContaining('apiKey') });
    expect(status.message).not.toContain('META_RESERVED_TEST_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed Meta apiKeyEnv without echoing it or attempting inference', () => {
    const secretMarker = 'sk-test-META_SYNTHETIC_SECRET_MARKER';
    const fetchMock = vi.fn(async () => { throw new Error('unexpected inference request'); });
    vi.stubGlobal('fetch', fetchMock);
    const message = (() => {
      try {
        createProviderDirect('meta', {
          baseURL: META_API_BASE_URL,
          metaApiEnabled: true,
          apiKeyEnv: secretMarker,
        }, META_API_MODEL);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '';
    })();

    expect(message).toContain('providers.<name>.apiKeyEnv');
    expect(message).not.toContain(secretMarker);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a generic provider using the reserved key as not ready in doctor without inference', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-baseten-credential-doctor-'));
    projects.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.maos', 'maos.config.json'), JSON.stringify({
      schemaVersion: 1,
      projectName: 'reserved-key-doctor-test',
      providers: {
        openai: { baseURL: 'https://attacker.invalid/v1', apiKey: `env:${BASETEN_API_KEY_ENV}` },
        baseten: config(),
      },
      agents: [{ id: 'generic', role: 'analyst', provider: 'openai', model: 'gpt-test' }],
    }));
    const fetchMock = vi.fn(async () => { throw new Error('doctor must not make inference requests'); });
    vi.stubGlobal('fetch', fetchMock);
    const report = await runDoctor(projectRoot);

    expect(report.checks.find((check) => check.label === 'openai')).toMatchObject({ status: 'fail', required: true });
    expect(JSON.stringify(report)).toContain(BASETEN_API_KEY_ENV);
    expect(JSON.stringify(report)).not.toContain(apiKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves unrelated provider credentials and requests through the existing generic path', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const mock = await listen((_request, res) => response(toolCompletion())(_request, res));
    const provider = createProviderDirect('openai', {
      baseURL: `${mock.url}/v1`,
      apiKey: 'synthetic-openai-key-not-real',
    }, 'unrelated-model');
    await provider.generate([{ role: 'user', content: 'synthetic unrelated-provider request' }]);

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].headers.authorization).toBe('Bearer synthetic-openai-key-not-real');
    expect(mock.requests[0].headers.authorization).not.toBe(`Bearer ${apiKey}`);
  });

  it('makes doctor readiness fail when Baseten credentials are missing without making inference calls', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-baseten-doctor-'));
    projects.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.maos', 'maos.config.json'), JSON.stringify({
      schemaVersion: 1,
      projectName: 'baseten-doctor-test',
      providers: { baseten: config() },
      agents: [{ id: 'planner', role: 'planner', provider: 'baseten', model: BASETEN_API_MODEL, capabilities: [] }],
    }));
    const fetchMock = vi.fn(async () => { throw new Error('doctor must not make inference requests'); });
    vi.stubGlobal('fetch', fetchMock);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    try {
      const ready = await runDoctor(projectRoot);
      expect(ready.checks.find((check) => check.label === 'baseten')).toMatchObject({ status: 'pass', required: true });
      expect(JSON.stringify(ready)).not.toContain(apiKey);

      delete process.env[BASETEN_API_KEY_ENV];
      const missing = await runDoctor(projectRoot);
      expect(missing.exitCode).toBe(1);
      expect(missing.checks.find((check) => check.label === 'baseten')).toMatchObject({ status: 'fail', required: true });
      expect(JSON.stringify(missing)).toContain(BASETEN_API_KEY_ENV);
      expect(JSON.stringify(missing)).not.toContain(apiKey);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('uses the structured tool-call shape with the fixed hackathon reasoning and output budget', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const mock = await listen((_request, res, _body) => response(toolCompletion())(_request, res));
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith(`${BASETEN_API_BASE_URL}/chat/completions`)) throw new Error('unexpected request destination');
      return originalFetch(`${mock.url}/v1/chat/completions`, init);
    });
    const provider = createProviderDirect('baseten', config(), BASETEN_API_MODEL);
    const result = await provider.generate(
      [{ role: 'user', content: 'Analyze the selected synthetic CSV.' }],
      [{ type: 'function', function: { name: 'analyze_telemetry_csv', description: 'Analyze CSV', parameters: { type: 'object' } } }],
      { maxTokens: 256 },
    );

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(mock.requests[0].body).toMatchObject({ model: BASETEN_API_MODEL, max_tokens: 1500, reasoning_effort: 'low' });
    expect(mock.requests[0].body).not.toHaveProperty('tool_choice');
    expect(result.reportedModel).toBe(BASETEN_API_MODEL);
    expect(result.toolCalls[0].function).toEqual({ name: 'analyze_telemetry_csv', arguments: '{"sourcePath":"selected.csv"}' });
  });

  it.each([429, 503])('makes one HTTP attempt on status %i', async (status) => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const mock = await listen((_request, res) => response({ error: { message: 'synthetic failure' } }, status)(_request, res));
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${mock.url}/v1/chat/completions`, init));
    const provider = createProviderDirect('baseten', config(), BASETEN_API_MODEL);

    await expect(provider.generate([{ role: 'user', content: 'bounded synthetic request' }])).rejects.toThrow();
    expect(mock.requests).toHaveLength(1);
  });

  it('does not let Core retry a transient Baseten failure beyond the provider policy', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const mock = await listen((_request, res) => response({ error: { message: 'synthetic failure' } }, 503)(_request, res));
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${mock.url}/v1/chat/completions`, init));
    const provider = createProviderDirect('baseten', config(), BASETEN_API_MODEL);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-baseten-core-retry-'));
    projects.push(projectRoot);

    const result = await runAgent(
      provider,
      { id: 'baseten-test-agent', role: 'test', provider: 'baseten', model: BASETEN_API_MODEL, capabilities: [], allowedTools: [], scope: [], maxIterations: 1 },
      { id: 'baseten-test-task', description: 'Make one bounded synthetic model request.', branch: 'local' },
      projectRoot,
      0,
      undefined,
      undefined,
      { maxProviderRetries: 5, maxGenerationAttempts: 4 },
    );

    expect(result.success).toBe(false);
    expect(mock.requests).toHaveLength(1);
  });

  it('rejects redirects before another host receives a credential-bearing request', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    const redirected = await listen((_request, res) => response({ choices: [] })(_request, res));
    const primary = await listen((_request, res) => {
      res.writeHead(302, { location: `${redirected.url}/v1/chat/completions` }).end();
    });
    const originalFetch = globalThis.fetch.bind(globalThis);
    const redirects: Array<RequestRedirect | undefined> = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(BASETEN_API_BASE_URL)) {
        redirects.push(init?.redirect);
        return originalFetch(`${primary.url}/v1/chat/completions`, init);
      }
      return originalFetch(input, init);
    });
    const provider = createProviderDirect('baseten', config(), BASETEN_API_MODEL);

    await expect(provider.generate([{ role: 'user', content: 'bounded synthetic request' }])).rejects.toThrow();
    expect(primary.requests).toHaveLength(1);
    expect(primary.requests[0].headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(redirected.requests).toHaveLength(0);
    expect(redirects).toEqual(['error']);
  });

  it('propagates caller cancellation to the injected transport', async () => {
    process.env[BASETEN_API_KEY_ENV] = apiKey;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const provider = new OpenAIProvider({ name: 'baseten', apiKey: 'unused-fallback', model: BASETEN_API_MODEL, baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true, fetch: fetchMock });
    const controller = new AbortController();
    const pending = provider.generate([{ role: 'user', content: 'bounded synthetic request' }], undefined, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
