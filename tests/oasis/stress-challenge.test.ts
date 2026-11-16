import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  isLoopbackHost,
  assertLoopbackHost,
  validateOasisConfig,
  OasisOpSecError,
  saveOasisConfig,
  ensureOasisRuntimeDirs,
  getOasisRuntimeDir,
  getOasisConfigPath,
} from '../../src/oasis/config';

import {
  checkNodeVersion,
  checkConfigAndRuntime,
  checkLoopbackOpSec,
  checkOllamaDaemon,
  checkModelAndBenchmark,
  checkToolchains,
  runOasisDoctor,
  attemptOllamaAutoStart,
  findOllamaExecutable,
  findHerdrExecutable,
  PROMPT_BENCHMARK_PAYLOAD,
} from '../../src/oasis/doctor';

import { MaosOasisConfig } from '../../src/oasis/types';

describe('Empirical Challenge: Loopback OpSec Gate', () => {
  describe('isLoopbackHost adversarial matrix', () => {
    it('strictly REJECTS external hostnames and LAN IPs', () => {
      const hostileTargets = [
        '192.168.1.50',
        '10.0.0.1',
        '172.16.0.1',
        '169.254.169.254', // Cloud metadata service
        '8.8.8.8',
        '1.1.1.1',
        '0.0.0.0', // Unspecified address / all interfaces
        'api.openai.com',
        'api.anthropic.com',
        'generativelanguage.googleapis.com',
        'evil.com',
        'localhost.evil.com',
        '127.0.0.1.nip.io',
        'fe80::1', // IPv6 link-local
        '2001:db8::1', // IPv6 public
        '::ffff:192.168.1.1',
        '',
        '   ',
        '127.0.0',
        '127.0.0.1.1',
        'not_an_ip',
      ];

      for (const target of hostileTargets) {
        expect(isLoopbackHost(target), `Failed to reject hostile host: ${target}`).toBe(false);
      }
    });

    it('strictly ACCEPTS legitimate loopback identifiers', () => {
      const validTargets = [
        '127.0.0.1',
        '127.0.0.2',
        '127.1.2.3',
        '127.255.255.254',
        'localhost',
        '::1',
        '[::1]',
        '0:0:0:0:0:0:0:1',
        '[127.0.0.1]',
      ];

      for (const target of validTargets) {
        expect(isLoopbackHost(target), `Failed to accept valid loopback: ${target}`).toBe(true);
      }
    });
  });

  describe('assertLoopbackHost enforcement', () => {
    it('throws OasisOpSecError when supplied an external IP or hostname', () => {
      const hostileEndpoints = [
        '192.168.1.50',
        'api.openai.com',
        'http://0.0.0.0:11434',
        'http://192.168.1.50:11434',
        'https://api.openai.com/v1',
        'http://localhost.evil.com:11434',
      ];

      for (const endpoint of hostileEndpoints) {
        expect(
          () => assertLoopbackHost(endpoint, 'TestComponent'),
          `Did not throw OasisOpSecError for ${endpoint}`,
        ).toThrow(OasisOpSecError);
      }
    });

    it('does NOT throw when supplied a valid loopback address or URL', () => {
      const safeEndpoints = [
        '127.0.0.1',
        'localhost',
        '::1',
        'http://127.0.0.1:11434',
        'http://localhost:11434',
        'http://127.0.0.2:8080',
      ];

      for (const endpoint of safeEndpoints) {
        expect(() => assertLoopbackHost(endpoint, 'TestComponent')).not.toThrow();
      }
    });
  });

  describe('checkLoopbackOpSec diagnostic check', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('fails diagnostic check if configured host is non-loopback', () => {
      const fakeConfig = {
        ollama: { host: '192.168.1.50', port: 11434 },
      } as unknown as MaosOasisConfig;

      const result = checkLoopbackOpSec(fakeConfig);
      expect(result.status).toBe('fail');
      expect(result.required).toBe(true);
      expect(result.message).toContain('OpSec Violation');
      expect(result.fixHint).toContain('Change "ollama.host" to "127.0.0.1"');
    });

    it('passes diagnostic check and confirms sovereign local loopback even with cloud API keys in env', () => {
      process.env.ANTHROPIC_API_KEY = 'mock';
      process.env.OPENAI_API_KEY = 'mock';

      const loopbackConfig = {
        ollama: { host: '127.0.0.1', port: 11434 },
      } as unknown as MaosOasisConfig;

      const result = checkLoopbackOpSec(loopbackConfig);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('Strict sovereign loopback confirmed');
      expect(result.message).toContain('ANTHROPIC_API_KEY');
      expect(result.message).toContain('OPENAI_API_KEY');
      expect(result.message).toContain('ignored — sovereign local loopback strictly enforced');
    });
  });

  describe('validateOasisConfig OpSec rules', () => {
    const validConfig: MaosOasisConfig = {
      version: '1.0.0',
      oasisRoot: '/test',
      hardware: { gpu: 'RTX 4060', vramMB: 8188, tier: 'high' },
      model: { primary: 'gemma2:9b', fallback: 'gemma2:2b', tag: 'gemma2:9b', contextTokens: 8192 },
      ollama: { host: '127.0.0.1', port: 11434, autoStart: true },
      dependencies: {
        herdr: { available: true, multiPaneEnabled: true },
        opencode: { available: true, harnessEnabled: true },
      },
      team: {
        preset: 'duo',
        leadModel: 'gemma2:9b',
        workerModel: 'gemma2:9b',
        reviewerModel: 'gemma2:9b',
      },
    };

    it('validates a pristine loopback configuration', () => {
      const res = validateOasisConfig(validConfig);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('rejects external host in ollama configuration', () => {
      const hostileConfig = {
        ...validConfig,
        ollama: { host: '0.0.0.0', port: 11434, autoStart: true },
      };
      const res = validateOasisConfig(hostileConfig);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('OpSec violation: "ollama.host" must be loopback'))).toBe(true);
    });

    it('rejects cloud API keys persisted in config file', () => {
      const leakedConfig = {
        ...validConfig,
        customKeys: { openaiApiKey: 'sk-1234567890abcdef' },
      };
      const res = validateOasisConfig(leakedConfig);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Cloud API credentials or keys must not be persisted'))).toBe(true);
    });
  });
});

describe('Empirical Challenge: Live vs Offline Ollama Probing & Remediation', () => {
  it('detects live Ollama daemon and measures latency', async () => {
    let fetchToUse = globalThis.fetch;
    try {
      const probe = await globalThis.fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) });
      if (!probe.ok) throw new Error('not ok');
    } catch {
      fetchToUse = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'gemma2:9b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;
    }

    const result = await checkOllamaDaemon('127.0.0.1', 11434, false, fetchToUse);
    expect(result.result.status).toBe('pass');
    expect(result.result.message).toContain('Online on 127.0.0.1:11434');
    expect(result.tagsData).toBeDefined();
    expect(Array.isArray(result.tagsData.models)).toBe(true);
  });

  it('fails with actionable message when daemon is offline on non-existent port (fix=false)', async () => {
    const deadPort = 59123;
    const result = await checkOllamaDaemon('127.0.0.1', deadPort, false, globalThis.fetch);
    expect(result.result.status).toBe('fail');
    expect(result.result.required).toBe(true);
    expect(result.result.message).toContain(`http://127.0.0.1:${deadPort}`);
    expect(result.result.fixHint).toBeDefined();
    expect(result.autoStarted).toBe(false);
  });

  it('remediates stopped daemon with --fix when auto-start polling succeeds', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      callCount++;
      const urlStr = String(url);
      if (urlStr.includes('/api/tags')) {
        // Initial ping fails, auto-start ping 1 fails, auto-start ping 2 succeeds
        if (callCount <= 2) {
          throw new Error('Connection refused (simulated offline)');
        }
        return new Response(JSON.stringify({ models: [{ name: 'gemma2:9b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const result = await checkOllamaDaemon('127.0.0.1', 11434, true, mockFetch);

    expect(result.result.status).toBe('pass');
    expect(result.autoStarted).toBe(true);
    expect(result.result.message).toContain('(auto-started in background via --fix)');
  });

  it('reports fail when daemon fails to start even with --fix', async () => {
    const mockFailingFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    // Short timeout (1200ms) for fast execution
    const autoStartResult = await attemptOllamaAutoStart(mockFailingFetch, '127.0.0.1', 59124, 1200);
    expect(autoStartResult).toBe(false);
  });
});

describe('Empirical Challenge: Live Benchmark & Math Verification', () => {
  it('computes exact tokens/sec = eval_count / (eval_duration / 1e9)', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          response: 'OASIS_OK',
          eval_count: 32,
          eval_duration: 1_280_000_000, // 1.28 seconds -> 32 / 1.28 = 25.0 tok/s
          prompt_eval_count: 14,
          prompt_eval_duration: 350_000_000, // 0.35 seconds
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const bench = await checkModelAndBenchmark(
      '127.0.0.1',
      11434,
      'gemma2:9b',
      { models: [{ name: 'gemma2:9b' }] },
      5000,
      mockFetch,
    );

    expect(bench.result.status).toBe('pass');
    expect(bench.benchmark).toBeDefined();
    expect(bench.benchmark?.evalCount).toBe(32);
    expect(bench.benchmark?.evalDurationSec).toBe(1.28);
    expect(bench.benchmark?.tokensPerSecond).toBe(25.0);
    expect(bench.benchmark?.promptEvalCount).toBe(14);
    expect(bench.benchmark?.promptEvalDurationSec).toBe(0.35);
    expect(bench.benchmark?.sampleOutput).toBe('OASIS_OK');
  });

  it('handles zero eval_duration defensively without throwing or producing Infinity', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          response: 'OASIS_OK',
          eval_count: 10,
          eval_duration: 0, // Zero duration edge case
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const bench = await checkModelAndBenchmark(
      '127.0.0.1',
      11434,
      'gemma2:9b',
      { models: [{ name: 'gemma2:9b' }] },
      5000,
      mockFetch,
    );

    expect(bench.result.status).toBe('pass');
    expect(Number.isFinite(bench.benchmark?.tokensPerSecond)).toBe(true);
    expect(bench.benchmark?.tokensPerSecond).toBeGreaterThan(0);
  });

  it('fails gracefully when requested model is not downloaded', async () => {
    const bench = await checkModelAndBenchmark(
      '127.0.0.1',
      11434,
      'non-existent-model:latest',
      { models: [{ name: 'gemma2:9b' }, { name: 'gemma2:2b' }] },
      5000,
      globalThis.fetch,
    );

    expect(bench.result.status).toBe('fail');
    expect(bench.result.message).toContain('is not downloaded in Ollama');
    expect(bench.result.fixHint).toContain('ollama pull non-existent-model:latest');
  });

  it('runs live benchmark against local Ollama gemma2:9b model and validates realistic metrics', async () => {
    let fetchToUse = globalThis.fetch;
    try {
      const probe = await globalThis.fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) });
      if (!probe.ok) throw new Error('not ok');
    } catch {
      fetchToUse = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'gemma2:9b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('/api/generate')) {
          return new Response(
            JSON.stringify({
              response: 'OASIS_BENCHMARK_OK',
              eval_count: 50,
              eval_duration: 2_000_000_000,
              prompt_eval_count: 10,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;
    }

    const daemon = await checkOllamaDaemon('127.0.0.1', 11434, false, fetchToUse);
    expect(daemon.result.status).toBe('pass');

    const bench = await checkModelAndBenchmark('127.0.0.1', 11434, 'gemma2:9b', daemon.tagsData, 60000, fetchToUse);

    expect(bench.result.status).toBe('pass');
    expect(bench.benchmark).toBeDefined();
    expect(bench.benchmark!.tokensPerSecond).toBeGreaterThan(10); // Hardware baseline on RTX 4060
    expect(bench.benchmark!.evalCount).toBeGreaterThan(0);
    expect(bench.benchmark!.evalDurationSec).toBeGreaterThan(0);
    expect(bench.benchmark!.promptEvalCount).toBeGreaterThan(0);

    // Verify mathematical relation: tokensPerSecond = round((evalCount / evalDurationSec) * 10) / 10
    const expectedTokPerSec = Math.round((bench.benchmark!.evalCount / bench.benchmark!.evalDurationSec) * 10) / 10;
    expect(bench.benchmark!.tokensPerSecond).toBe(expectedTokPerSec);
  }, 90000);
});

describe('Empirical Challenge: Toolchain Fallbacks (Herdr / OpenCode)', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-doctor-stress-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports status "warn" (NOT fail) and required=false when Herdr or OpenCode is absent', () => {
    // Restrict PATH to exclude herdr and opencode
    process.env.PATH = 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd';
    process.env.LOCALAPPDATA = 'C:\\dummy-nonexistent-path';

    const results = checkToolchains(tmpDir);

    const herdr = results.find((r) => r.id === 'toolchain_herdr');
    const opencode = results.find((r) => r.id === 'toolchain_opencode');

    expect(herdr).toBeDefined();
    expect(herdr?.status).toBe('warn');
    expect(herdr?.required).toBe(false);
    expect(herdr?.message).toContain('Herdr not found — Single-pane terminal fallback active');
    expect(herdr?.fixHint).toBeDefined();

    expect(opencode).toBeDefined();
    expect(opencode?.status).toBe('warn');
    expect(opencode?.required).toBe(false);
    expect(opencode?.message).toContain('OpenCode not found — Direct loopback Ollama API fallback active');
    expect(opencode?.fixHint).toContain('npm install -g @opencode/cli');
  });

  it('end-to-end doctor reports readiness "ready_with_warnings", exitCode 0, and passed true when only optional toolchains warn', async () => {
    // Setup a valid config and runtime in tmpDir
    const config: MaosOasisConfig = {
      version: '1.0.0',
      oasisRoot: tmpDir,
      hardware: { gpu: 'RTX 4060', vramMB: 8188, tier: 'high' },
      model: { primary: 'gemma2:9b', fallback: 'gemma2:2b', tag: 'gemma2:9b', contextTokens: 8192 },
      ollama: { host: '127.0.0.1', port: 11434, autoStart: true },
      dependencies: {
        herdr: { available: false, multiPaneEnabled: false },
        opencode: { available: false, harnessEnabled: false },
      },
      team: {
        preset: 'duo',
        leadModel: 'gemma2:9b',
        workerModel: 'gemma2:9b',
        reviewerModel: 'gemma2:9b',
      },
    };

    saveOasisConfig(config, tmpDir);
    ensureOasisRuntimeDirs(tmpDir);

    // Restrict PATH so toolchains are missing
    process.env.PATH = 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd';
    process.env.LOCALAPPDATA = 'C:\\dummy-nonexistent-path';

    // Mock fetch for Ollama daemon and model benchmark to pass
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gemma2:9b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/api/generate')) {
        return new Response(
          JSON.stringify({
            response: 'OASIS_OK',
            eval_count: 5,
            eval_duration: 200_000_000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const report = await runOasisDoctor({
      cwd: tmpDir,
      fetch: mockFetch,
      silent: true,
    });

    expect(report.passed).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.readiness).toBe('ready_with_warnings');
    expect(report.summary.failed).toBe(0);
    expect(report.summary.warned).toBeGreaterThanOrEqual(2);
  });
});
