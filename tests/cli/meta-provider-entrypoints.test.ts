import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/cli/doctor';
import { runPlan } from '../../src/cli/plan';

const META_URL = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3';
const roots: string[] = [];
const envNames: string[] = [];
const servers: http.Server[] = [];

function createProject(configOverrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-meta-cli-'));
  roots.push(root);
  const envName = `MAOS_META_CLI_${Math.random().toString(36).slice(2).toUpperCase()}`;
  envNames.push(envName);
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'meta-cli-test',
    providers: { meta: { baseURL: META_URL, apiKey: 'synthetic-config-secret-not-real', apiKeyEnv: envName, ...configOverrides } },
    agents: [{ id: 'PLANNER', role: 'planner', provider: 'meta', model: MODEL, capabilities: [], scope: ['.'] }],
    routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'meta' },
  }));
  return { root, envName };
}

async function startMock() {
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    headers.push(request.headers);
    request.resume();
    request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: 'mock-doctor-completion', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, headers, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const originalCwds: string[] = [];

afterEach(async () => {
  const previous = originalCwds.pop();
  if (previous) process.chdir(previous);
  for (const name of envNames.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Meta provider policy through plan and doctor entrypoints', () => {
  it('rejects disabled Meta opt-in in plan before resolving its config key or making a request', async () => {
    const project = createProject({ metaApiEnabled: false });
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('plan-exit'); }) as any);

    await expect(runPlan('synthetic planning request', {})).rejects.toThrow('plan-exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join('\n')).toContain('metaApiEnabled=true');
    expect(requests).not.toHaveBeenCalled();
  });

  it('blocks doctor ping when opt-in is missing even if a config key is present', async () => {
    const project = createProject({ metaApiEnabled: undefined });
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor();

    expect(log.mock.calls.flat().join('\n')).toContain('metaApiEnabled=true');
    expect(requests).not.toHaveBeenCalled();
  });

  it('routes an opted-in doctor ping through the central provider policy using only the named environment key', async () => {
    const project = createProject({ metaApiEnabled: true });
    const key = 'synthetic-doctor-key-not-real';
    process.env[project.envName] = key;
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    const mock = await startMock();
    const nativeFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(META_URL)) return nativeFetch(`${mock.url}/v1/chat/completions`, init);
      return nativeFetch(input, init);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor();

    expect(mock.headers).toHaveLength(1);
    expect(mock.headers[0].authorization).toBe(`Bearer ${key}`);
  });
});
