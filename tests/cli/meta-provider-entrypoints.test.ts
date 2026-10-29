import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConfigure } from '../../src/cli/configure';
import { runDoctor } from '../../src/cli/doctor';
import { runPlan } from '../../src/cli/plan';
import { resolveHostedApiPolicy } from '../../src/backends/meta-api-policy';
import { getAllCredentialStatuses } from '../../src/core/credentials';

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

  it('does not print malformed Meta apiKeyEnv values from configure, policy, doctor, or preflight', async () => {
    const secretMarker = 'sk-test-SYNTHETIC_SECRET_MARKER';
    const project = createProject({ apiKeyEnv: secretMarker, metaApiEnabled: true });
    envNames.push(secretMarker);

    const configureLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    await runConfigure(['meta']);
    const configureOutput = configureLog.mock.calls.flat().join('\n');
    expect(configureOutput).not.toContain(secretMarker);
    expect(configureOutput).toContain('providers.<name>.apiKeyEnv');
    configureLog.mockRestore();

    let policyMessage = '';
    try {
      resolveHostedApiPolicy({ providerName: 'meta', baseURL: META_URL, model: MODEL, metaApiEnabled: true, apiKeyEnv: secretMarker });
    } catch (error) {
      policyMessage = error instanceof Error ? error.message : String(error);
    }
    expect(policyMessage).toContain('providers.<name>.apiKeyEnv');
    expect(policyMessage).not.toContain(secretMarker);

    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const doctorLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const doctor = await runDoctor(project.root);
    const doctorOutput = `${JSON.stringify(doctor)}\n${doctorLog.mock.calls.flat().join('\n')}`;
    expect(doctor.exitCode).toBe(1);
    expect(doctorOutput).toContain('providers.<name>.apiKeyEnv');
    expect(doctorOutput).not.toContain(secretMarker);
    expect(requests).not.toHaveBeenCalled();

    const preflight = getAllCredentialStatuses({
      providers: {
        openai: { apiKey: 'synthetic-unrelated-provider-key-not-real' },
        meta: { baseURL: META_URL, metaApiEnabled: true, apiKeyEnv: secretMarker },
      },
      agents: [
        { id: 'OPENAI', provider: 'openai', model: 'synthetic-model' },
        { id: 'PLANNER', provider: 'meta', model: MODEL },
      ],
    });
    expect(preflight).toHaveLength(2);
    expect(preflight[0]).toMatchObject({ status: 'missing', detail: expect.stringContaining('providers.<name>.apiKeyEnv') });
    expect(JSON.stringify(preflight)).not.toContain(secretMarker);
  });

  it('keeps valid but secret-like environment identifiers out of configure and readiness diagnostics', async () => {
    const secretMarker = 'SYNTHETIC_SECRET_MARKER_123';
    envNames.push(secretMarker);
    process.env[secretMarker] = 'synthetic-meta-key-not-real';
    const project = createProject({ apiKeyEnv: secretMarker, metaApiEnabled: true });

    const configureLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwds.push(process.cwd());
    process.chdir(project.root);
    await runConfigure(['meta']);
    const configureOutput = configureLog.mock.calls.flat().join('\n');
    expect(configureOutput).toContain('configured credential environment reference');
    expect(configureOutput).not.toContain(secretMarker);
    configureLog.mockRestore();

    const policy = resolveHostedApiPolicy({ providerName: 'meta', baseURL: META_URL, model: MODEL, metaApiEnabled: true, apiKeyEnv: secretMarker });
    expect(policy?.apiKeyEnv).toBe(secretMarker);

    let disabledPolicyMessage = '';
    try {
      resolveHostedApiPolicy({ providerName: 'meta', baseURL: META_URL, model: MODEL, metaApiEnabled: false, apiKeyEnv: secretMarker });
    } catch (error) {
      disabledPolicyMessage = error instanceof Error ? error.message : String(error);
    }
    expect(disabledPolicyMessage).toContain('metaApiEnabled=true');
    expect(disabledPolicyMessage).not.toContain(secretMarker);

    const preflight = getAllCredentialStatuses({
      providers: { meta: { baseURL: META_URL, metaApiEnabled: true, apiKeyEnv: secretMarker } },
      agents: [{ id: 'PLANNER', provider: 'meta', model: MODEL }],
    });
    expect(preflight[0]).toMatchObject({ status: 'valid', detail: 'Credential environment reference configured' });
    expect(JSON.stringify(preflight)).not.toContain(secretMarker);

    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const doctorLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const doctor = await runDoctor(project.root);
    expect(doctor.exitCode).toBe(0);
    expect(`${JSON.stringify(doctor)}\n${doctorLog.mock.calls.flat().join('\n')}`).not.toContain(secretMarker);
    expect(requests).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'VALID_NAME\n'])('rejects missing or malformed Meta apiKeyEnv before environment lookup', (apiKeyEnv) => {
    let message = '';
    try {
      resolveHostedApiPolicy({ providerName: 'meta', baseURL: META_URL, model: MODEL, metaApiEnabled: true, apiKeyEnv });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('providers.<name>.apiKeyEnv');
    expect(message).toContain('[A-Za-z_][A-Za-z0-9_]*');
  });

  it('does not echo a valid but unset Meta apiKeyEnv in policy, doctor, or preflight errors', async () => {
    const secretMarker = 'SYNTHETIC_SECRET_MARKER_UNSET';
    envNames.push(secretMarker);
    delete process.env[secretMarker];
    const project = createProject({ apiKeyEnv: secretMarker, metaApiEnabled: true });

    let policyMessage = '';
    try {
      resolveHostedApiPolicy({ providerName: 'meta', baseURL: META_URL, model: MODEL, metaApiEnabled: true, apiKeyEnv: secretMarker });
    } catch (error) {
      policyMessage = error instanceof Error ? error.message : String(error);
    }
    expect(policyMessage).toContain('credential environment reference is empty');
    expect(policyMessage).not.toContain(secretMarker);

    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const doctor = await runDoctor(project.root);
    expect(doctor.exitCode).toBe(1);
    expect(`${JSON.stringify(doctor)}\n${log.mock.calls.flat().join('\n')}`).not.toContain(secretMarker);
    const preflight = getAllCredentialStatuses({
      providers: { meta: { baseURL: META_URL, metaApiEnabled: true, apiKeyEnv: secretMarker } },
      agents: [{ id: 'PLANNER', provider: 'meta', model: MODEL }],
    });
    expect(preflight[0]).toMatchObject({ status: 'missing', detail: 'The configured credential environment reference is empty. Set the configured environment variable before using the Meta Model API.' });
    expect(JSON.stringify(preflight)).not.toContain(secretMarker);
    expect(requests).not.toHaveBeenCalled();
  });
});
