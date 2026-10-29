import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  engineHealth: vi.fn(),
  getDefaultEnginePath: vi.fn((root: string) => `${root}/rust/target/release/maos-engine${process.platform === 'win32' ? '.exe' : ''}`),
  verifyExecutable: vi.fn(),
}));

vi.mock('../../src/industrial/rust-engine-bridge', () => engine);

import { runDoctor } from '../../src/cli/doctor';

const roots: string[] = [];
let originalCwd = '';

function createProject(config?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-doctor-'));
  roots.push(root);
  if (config !== undefined) {
    const maosRoot = path.join(root, '.maos');
    fs.mkdirSync(maosRoot, { recursive: true });
    fs.writeFileSync(path.join(maosRoot, 'maos.config.json'), JSON.stringify(config));
  }
  originalCwd = process.cwd();
  process.chdir(root);
  return root;
}

function localConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectName: 'doctor-test',
    providers: { ollama: { baseURL: 'http://127.0.0.1:11434/v1' } },
    agents: [{ id: 'LOCAL', runtime: 'local', provider: 'ollama', model: 'local-model' }],
    ...overrides,
  };
}

afterEach(() => {
  if (originalCwd) process.chdir(originalCwd);
  originalCwd = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  engine.engineHealth.mockReset();
  engine.verifyExecutable.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('maos doctor readiness', () => {
  it('reports a configured local project ready without sending inference requests', async () => {
    createProject(localConfig());
    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.exitCode).toBe(0);
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.checks.find((check) => check.label === 'CLI runtimes')).toMatchObject({ required: false, status: 'warn' });
    expect(requests).not.toHaveBeenCalled();
  });

  it('returns a required nonzero readiness result for missing configuration', async () => {
    createProject();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result).toMatchObject({ readiness: 'not_ready', exitCode: 1 });
    expect(result.checks.find((check) => check.label === 'Config')).toMatchObject({ required: true, status: 'fail' });
  });

  it('returns a required nonzero readiness result for missing credentials', async () => {
    createProject({
      schemaVersion: 1,
      projectName: 'doctor-test',
      providers: { freemodel: { baseURL: 'http://127.0.0.1:9000/v1' } },
      agents: [{ id: 'API', runtime: 'api', provider: 'freemodel', model: 'local-test' }],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.label === 'freemodel')).toMatchObject({ required: true, status: 'fail' });
  });

  it('never prints a configured credential and does not send it to a provider', async () => {
    createProject({
      schemaVersion: 1,
      projectName: 'doctor-test',
      providers: { freemodel: { baseURL: 'http://127.0.0.1:9000/v1', apiKey: 'synthetic-doctor-key-not-real-123456' } },
      agents: [{ id: 'API', runtime: 'api', provider: 'freemodel', model: 'local-test' }],
    });
    const requests = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', requests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.exitCode).toBe(0);
    expect(log.mock.calls.flat().join('\n')).not.toContain('synthetic-doctor-key-not-real-123456');
    expect(requests).not.toHaveBeenCalled();
  });

  it('keeps an absent Industrial engine optional for non-Industrial projects', async () => {
    createProject(localConfig());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.checks.some((check) => check.label === 'Rust engine')).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('requires and verifies engine identity and protocol for Industrial projects', async () => {
    createProject(localConfig({ profile: { id: 'industrial', mode: 'sovereign-local' } }));
    engine.verifyExecutable.mockReturnValue({ executablePath: 'engine.exe', executableHash: 'a'.repeat(64), engineVersion: '0.1.0', protocolVersion: '1.0' });
    engine.engineHealth.mockReturnValue({
      operation: 'health',
      version: '1.0',
      data: { status: 'ok', engine: 'maos-industrial-engine', version: '0.1.0', protocol_version: '1.0', unsafe_code: false },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const ready = await runDoctor();
    expect(ready.checks.find((check) => check.label === 'Rust engine')).toMatchObject({ required: true, status: 'pass' });

    engine.engineHealth.mockReturnValue({
      operation: 'health',
      version: '2.0',
      data: { status: 'ok', engine: 'other-engine', version: '9.9.9', protocol_version: '2.0', unsafe_code: false },
    });
    const incompatible = await runDoctor();
    expect(incompatible.exitCode).toBe(1);
    expect(incompatible.checks.find((check) => check.label === 'Rust engine')).toMatchObject({ required: true, status: 'fail' });

    engine.verifyExecutable.mockImplementation(() => {
      const error = new Error('Engine executable not found at the required project path.') as Error & { category: string };
      error.category = 'missing_binary';
      throw error;
    });
    const missing = await runDoctor();
    expect(missing.exitCode).toBe(1);
    expect(missing.checks.find((check) => check.label === 'Rust engine')?.detail).toContain('required project path');
  });

  it('handles malformed configuration as a readiness failure without throwing', async () => {
    const root = createProject();
    fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), '{');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runDoctor();

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.label === 'Config')?.detail).toContain('malformed');
  });
});
