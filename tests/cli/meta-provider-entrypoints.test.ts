import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/cli/doctor';
import { runPlan } from '../../src/cli/plan';

const META_URL = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3';
const roots: string[] = [];
const envNames: string[] = [];

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

const originalCwds: string[] = [];

afterEach(async () => {
  const previous = originalCwds.pop();
  if (previous) process.chdir(previous);
  for (const name of envNames.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('reports disabled Meta policy without sending an inference request', async () => {
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

  it('checks configured credentials without sending them to a provider', async () => {
    const project = createProject({ metaApiEnabled: true });
    const key = 'synthetic-doctor-key-not-real';
    process.env[project.envName] = key;
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.exitCode).toBe(0);
    expect(requests).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).not.toContain(key);
    expect(log.mock.calls.flat().join('\n')).toContain('never sends inference requests');
  });
});
