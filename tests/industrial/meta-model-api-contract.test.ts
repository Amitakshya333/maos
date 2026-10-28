import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../src/backends/openai-provider';
import { IndustrialAnalysisAgentError } from '../../src/industrial/analysis-agent-service';
import { createServiceContainer } from '../../src/service';

const projects: string[] = [];
const servers: http.Server[] = [];
const environmentNames: string[] = [];
const repoRoot = path.resolve(__dirname, '../..');
const META_URL = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3';

type Action = { status?: number; body?: unknown; hang?: boolean };

function completion(toolName: string, args: string, options: { omitModel?: boolean; model?: string; content?: string | null } = {}) {
  return {
    id: 'chatcmpl-meta-contract',
    object: 'chat.completion',
    created: 1,
    ...(options.omitModel ? {} : { model: options.model || MODEL }),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: options.content ?? null,
        tool_calls: [{ id: 'call-meta-tool', type: 'function', function: { name: toolName, arguments: args } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

async function startServer(handler: (body: any, request: http.IncomingMessage) => Action | Promise<Action>) {
  const requests: Array<{ body: any; headers: http.IncomingHttpHeaders; url: string }> = [];
  const requestWaiters: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', async () => {
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
      requests.push({ body, headers: req.headers, url: req.url || '' });
      requestWaiters.splice(0).forEach((resolve) => resolve());
      try {
        const action = await handler(body, req);
        if (action.hang || res.destroyed) return;
        res.writeHead(action.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(action.body));
      } catch {
        if (!res.destroyed) res.writeHead(500).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    requests,
    baseURL: `http://127.0.0.1:${port}/v1`,
    waitForRequest: async () => {
      if (requests.length) return;
      await new Promise<void>((resolve) => requestWaiters.push(resolve));
    },
  };
}

function makeProject(options: {
  baseURL: string;
  model?: string;
  enabled?: boolean;
  omitOptIn?: boolean;
  keyEnv?: string;
  temperature?: number;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-meta-contract-'));
  projects.push(root);
  const keyEnv = options.keyEnv || `MAOS_TEST_META_KEY_${randomUUID().replace(/-/g, '').toUpperCase()}`;
  if (options.enabled !== false) environmentNames.push(keyEnv);
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', 'safety_thresholds.json'), path.join(root, 'demo', 'industrial', 'safety_thresholds.json'));
  fs.mkdirSync(path.join(root, 'commissioning'), { recursive: true });
  fs.writeFileSync(path.join(root, 'commissioning', 'bearing-ramp.csv'), [
    'sample_time,vibration_rms_mm_s,bearing_temperature_c',
    '2026-02-11T08:00:00Z,1.2,70',
    '2026-02-11T08:01:00Z,4.8,88',
    '2026-02-11T08:02:00Z,8.2,96',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'meta-contract-test',
    providers: {
      meta: {
        baseURL: options.baseURL,
        metaApiEnabled: options.omitOptIn ? undefined : options.enabled !== false,
        ...(options.enabled === false ? {} : { apiKeyEnv: keyEnv }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      },
    },
    agents: [{
      id: 'ANALYST_AGENT', role: 'test analyst', provider: 'meta', model: options.model || MODEL,
      timeoutMs: 7_000, capabilities: ['analysis'], scope: ['.'],
    }],
    routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'meta' },
  }, null, 2));
  return { root, keyEnv, sourcePath: 'commissioning/bearing-ramp.csv' };
}

function installMetaFetchBridge(targetBaseURL: string, requests: Array<{ url: string; init?: RequestInit }>) {
  const originalFetch = globalThis.fetch;
  const nativeFetch = originalFetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const targetUrl = String(input);
    requests.push({ url: targetUrl, init });
    if (!targetUrl.startsWith(`${META_URL}/chat/completions`)) throw new Error('Unexpected non-Meta request URL.');
    const localUrl = `${targetBaseURL}/chat/completions`;
    return nativeFetch(localUrl, { ...init, redirect: 'error' });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = originalFetch; };
}

function chatTool() {
  return [{
    type: 'function' as const,
    function: {
      name: 'analyze_telemetry_csv',
      description: 'Analyze the selected project-local CSV.',
      parameters: { type: 'object', properties: { sourcePath: { type: 'string' } }, required: ['sourcePath'] },
    },
  }];
}

afterEach(async () => {
  for (const name of environmentNames.splice(0)) delete process.env[name];
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const root of projects.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Meta Model API opt-in and OpenAI-compatible contract (loopback mock only)', () => {
  it.each([
    ['default Muse temperature is omitted', undefined, false],
    ['configured Muse temperature is sent', 1, true],
  ])('uses the documented Chat Completions tool-call round trip when %s', async (_label, temperature, hasTemperature) => {
    let count = 0;
    const mock = await startServer((body) => {
      count++;
      expect(body.model).toBe(MODEL);
      expect(body.max_tokens).toBe(256);
      expect(Object.prototype.hasOwnProperty.call(body, 'temperature')).toBe(hasTemperature);
      if (hasTemperature) expect(body.temperature).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
      expect(body.messages.at(-1).role).toBe(count === 1 ? 'user' : 'tool');
      if (count === 1) return { body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' }), { omitModel: true }) };
      const assistant = body.messages.find((message: any) => message.role === 'assistant' && message.tool_calls);
      expect(assistant.tool_calls[0].id).toBe('call-meta-tool');
      const tool = body.messages.find((message: any) => message.role === 'tool');
      expect(tool.tool_call_id).toBe('call-meta-tool');
      const evidence = JSON.parse(tool.content);
      return { body: completion('task_complete', JSON.stringify({ summary: `Replay receipt ${evidence.analysisId}.` }), { omitModel: true }) };
    });
    const project = makeProject({ baseURL: META_URL, temperature });
    const apiKey = 'meta-contract-secret-never-log';
    process.env[project.keyEnv] = apiKey;
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    try {
      const result = await createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
      });

      expect(mock.requests).toHaveLength(2);
      expect(outbound).toHaveLength(2);
      expect(outbound.every((request) => request.url === `${META_URL}/chat/completions`)).toBe(true);
      expect(outbound.every((request) => new Headers(request.init?.headers).get('authorization') === `Bearer ${apiKey}`)).toBe(true);
      expect(result.requestedModel).toBe(MODEL);
      expect(result.reportedModel).toBeNull();
      expect(result.evidence.verification.valid).toBe(true);
      expect(JSON.stringify(result).includes(apiKey)).toBe(false);
      expect(JSON.stringify(createServiceContainer(project.root).audit.getRecords()).includes(apiKey)).toBe(false);
      expect(fs.readFileSync(path.join(project.root, result.reportPath), 'utf8').includes(apiKey)).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it('fails before fetch when the configured key environment variable is missing', async () => {
    const mock = await startServer(() => ({ body: completion('task_complete', '{}') }));
    const project = makeProject({ baseURL: META_URL });
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Analyze the selected CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'MODEL_CREDENTIAL_MISSING' });
      expect(outbound).toHaveLength(0);
      expect(mock.requests).toHaveLength(0);
    } finally {
      restoreFetch();
    }
  });

  it('redacts successful prose and provider model identity before service output, report, audit and logs', async () => {
    const apiKey = 'synthetic-success-secret-not-a-real-key';
    const mock = await startServer((body, _request) => {
      const count = mock.requests.length;
      if (count === 1) return { body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' }), { model: apiKey, content: `Synthetic note: ${apiKey}` }) };
      const tool = body.messages.find((message: any) => message.role === 'tool');
      const evidence = JSON.parse(tool.content);
      return { body: completion('task_complete', JSON.stringify({ summary: `Replay receipt ${evidence.analysisId}.` }), { model: apiKey, content: `Additional prose ${apiKey}` }) };
    });
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = apiKey;
    fs.mkdirSync(path.join(project.root, '.maos', 'logs'), { recursive: true });
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
      });
      const report = fs.readFileSync(path.join(project.root, result.reportPath), 'utf8');
      const receipt = fs.readFileSync(path.join(project.root, result.evidence.receiptPath), 'utf8');
      const audit = JSON.stringify(createServiceContainer(project.root).audit.getRecords());
      const logs = fs.readFileSync(path.join(project.root, '.maos', 'logs', 'orchestrator.log'), 'utf8');
      const publicOutput = JSON.stringify({ result, report, receipt, audit, logs, console: consoleLog.mock.calls });

      expect(result.reportedModel).toBeNull();
      expect(result.requestedModel).toBe(MODEL);
      expect(publicOutput).not.toContain(apiKey);
      const secondRequest = mock.requests[1].body;
      const priorAssistant = secondRequest.messages.find((message: any) => message.role === 'assistant');
      expect(priorAssistant.content).toContain('[REDACTED]');
      expect(priorAssistant.content).not.toContain(apiKey);
      expect(JSON.parse(report).explanation.status).toBe('unverified');
    } finally {
      restoreFetch();
      consoleLog.mockRestore();
    }
  });

  it('blocks task_complete arguments whose JSON-decoded content contains the configured key', async () => {
    const apiKey = 'synthetic-argument-secret-not-a-real-key';
    const mock = await startServer((body, _request) => {
      const count = mock.requests.length;
      if (count === 1) return { body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })) };
      const tool = body.messages.find((message: any) => message.role === 'tool');
      const evidence = JSON.parse(tool.content);
      const escapedKey = [...apiKey].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      return { body: completion('task_complete', `{"summary":"Receipt ${evidence.analysisId}; ${escapedKey}"}`) };
    });
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = apiKey;
    fs.mkdirSync(path.join(project.root, '.maos', 'logs'), { recursive: true });
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'PROVIDER_CREDENTIAL_CONTAMINATION' });
      const reports = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports');
      const logs = fs.readFileSync(path.join(project.root, '.maos', 'logs', 'orchestrator.log'), 'utf8');
      expect(fs.existsSync(reports)).toBe(false);
      expect(logs).not.toContain(apiKey);
      expect(consoleLog.mock.calls.flat().join('\n')).not.toContain(apiKey);
      expect(JSON.stringify(createServiceContainer(project.root).audit.getRecords())).not.toContain(apiKey);
    } finally {
      restoreFetch();
      consoleLog.mockRestore();
    }
  });

  it('blocks credential contamination in provider-controlled tool names before Core can log it', async () => {
    const apiKey = 'synthetic-tool-name-secret-not-a-real-key';
    const mock = await startServer(() => ({ body: completion(apiKey, '{}') }));
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = apiKey;
    fs.mkdirSync(path.join(project.root, '.maos', 'logs'), { recursive: true });
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'PROVIDER_CREDENTIAL_CONTAMINATION' });
      const logs = fs.readFileSync(path.join(project.root, '.maos', 'logs', 'orchestrator.log'), 'utf8');
      expect(logs).not.toContain(apiKey);
      expect(consoleLog.mock.calls.flat().join('\n')).not.toContain(apiKey);
      expect(mock.requests).toHaveLength(1);
    } finally {
      restoreFetch();
      consoleLog.mockRestore();
    }
  });

  it.each([
    ['other host', 'https://example.invalid/v1', MODEL, true, 'PROJECT_CONFIG_INVALID'],
    ['other model', META_URL, 'muse-spark-1.3-contributor', true, 'PROJECT_CONFIG_INVALID'],
    ['Meta endpoint with no opt-in field', META_URL, MODEL, true, 'MODEL_ENDPOINT_BLOCKED', true],
    ['Meta endpoint without opt-in', META_URL, MODEL, false, 'MODEL_ENDPOINT_BLOCKED'],
    ['remote endpoint without opt-in', 'https://example.invalid/v1', MODEL, false, 'MODEL_ENDPOINT_BLOCKED'],
  ])('rejects %s without a request', async (_label, baseURL, model, enabled, code, omitOptIn) => {
    const mock = await startServer(() => ({ body: completion('task_complete', '{}') }));
    const project = makeProject({ baseURL, model, enabled, omitOptIn });
    if (enabled) process.env[project.keyEnv] = 'not-used-test-value';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Analyze the selected CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code });
      expect(outbound).toHaveLength(0);
      expect(mock.requests).toHaveLength(0);
    } finally {
      restoreFetch();
    }
  });

  it('does not accept a malformed tool-call argument response', async () => {
    const mock = await startServer(() => ({ body: completion('analyze_telemetry_csv', '{"sourcePath":') }));
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = 'meta-test-key';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Analyze the selected CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });
      expect(outbound.length).toBeGreaterThan(0);
      expect(outbound.length).toBeLessThanOrEqual(4);
      expect(mock.requests).toHaveLength(outbound.length);
      expect(fs.existsSync(path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports'))).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503, 504])('makes one HTTP attempt for %i responses with SDK retries disabled', async (status) => {
    let attempts = 0;
    const mock = await startServer(() => {
      attempts++;
      return { status, body: { error: { message: 'synthetic provider failure' } } };
    });
    const provider = new OpenAIProvider({ name: 'meta-model-api-mock', apiKey: 'test-key', baseURL: mock.baseURL, model: MODEL, maxRetries: 0 });
    await expect(provider.generate([{ role: 'user', content: 'synthetic test' }], chatTool())).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(mock.requests).toHaveLength(1);
  });

  it.each([429, 503])('makes one HTTP attempt for an integrated Meta %i failure with application retries disabled', async (status) => {
    const mock = await startServer(() => ({ status, body: { error: { message: 'synthetic provider failure' } } }));
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = 'meta-integration-retry-test-key';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    try {
      await expect(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Analyze the selected CSV.', sourcePath: project.sourcePath,
      })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });
      expect(outbound).toHaveLength(1);
      expect(mock.requests).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });

  it('redacts an API key echoed by a 401 response from errors and stacks', async () => {
    const key = 'meta-secret-redaction-only';
    const mock = await startServer(() => ({ status: 401, body: { error: { message: `rejected ${key}` } } }));
    const provider = new OpenAIProvider({ name: 'meta-model-api-mock', apiKey: key, baseURL: mock.baseURL, model: MODEL, maxRetries: 0 });
    let failure: Error | undefined;
    try {
      await provider.generate([{ role: 'user', content: 'synthetic test' }]);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure instanceof Error).toBe(true);
    expect((failure?.message || '').includes(key)).toBe(false);
    expect((failure?.stack || '').includes(key)).toBe(false);
  });

  it('propagates caller cancellation to the in-flight Meta-compatible request', async () => {
    let serverRequest: http.IncomingMessage | undefined;
    const mock = await startServer((_body, request) => {
      serverRequest = request;
      return { hang: true };
    });
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = 'meta-cancel-test-key';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    const controller = new AbortController();
    try {
      const pending = createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Cancel the synthetic request.', sourcePath: project.sourcePath,
      }, { signal: controller.signal });
      await mock.waitForRequest();
      controller.abort();
      await expect(pending).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_CANCELLED' });
      expect(outbound).toHaveLength(1);
      expect(outbound[0].init?.signal?.aborted).toBe(true);
      expect(serverRequest?.aborted || serverRequest?.destroyed).toBe(true);
      expect(fs.existsSync(path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports'))).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it('enforces the single sixty-second deadline on the configured Meta runtime', async () => {
    const mock = await startServer(() => ({ hang: true }));
    const project = makeProject({ baseURL: META_URL });
    process.env[project.keyEnv] = 'meta-timeout-test-key';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installMetaFetchBridge(mock.baseURL, outbound);
    vi.useFakeTimers();
    try {
      const pending = createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Time out the synthetic request.', sourcePath: project.sourcePath,
      });
      const assertion = expect(pending).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_TIMEOUT' });
      await mock.waitForRequest();
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(outbound).toHaveLength(1);
      expect(outbound[0].init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      restoreFetch();
    }
  });
});
