import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IProvider, ProviderResponse } from '../../src/backends/provider';
import { BASETEN_API_BASE_URL, BASETEN_API_KEY_ENV, BASETEN_API_MODEL } from '../../src/backends/meta-api-policy';
import { runAgent } from '../../src/core/agent-runner';
import { IndustrialAnalysisAgentError } from '../../src/industrial/analysis-agent-service';
import { verifyTelemetryAnalysis } from '../../src/industrial/telemetry-analysis';
import { createServiceContainer } from '../../src/service';

const projects: string[] = [];
const servers: http.Server[] = [];
const environmentNames: string[] = [];
const repoRoot = path.resolve(__dirname, '../..');

type Action = { status?: number; body?: unknown; hang?: boolean };

function completion(
  toolName: string,
  args: string,
  options: {
    model?: string;
    content?: string | null;
    finishReason?: string;
    omitToolCalls?: boolean;
  } = {},
) {
  return {
    id: 'chatcmpl-readonly-completion',
    object: 'chat.completion',
    created: 1,
    model: options.model || BASETEN_API_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: options.content ?? null,
          ...(options.omitToolCalls
            ? {}
            : {
                tool_calls: [
                  {
                    id: `call-${toolName}-${Date.now()}`,
                    type: 'function',
                    function: { name: toolName, arguments: args },
                  },
                ],
              }),
        },
        finish_reason: options.finishReason ?? 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

async function startServer(handler: (body: any, request: http.IncomingMessage) => Action | Promise<Action>) {
  const requests: Array<{ body: any; headers: http.IncomingHttpHeaders; url: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', async () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = undefined;
      }
      requests.push({ body, headers: req.headers, url: req.url || '' });
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
  return { server, requests, baseURL: `http://127.0.0.1:${port}/v1` };
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-readonly-completion-'));
  projects.push(root);
  const engineSource = process.env.MAOS_TEST_ENGINE_PATH;
  if (engineSource) {
    const enginePath = path.join(
      root,
      'rust',
      'target',
      'release',
      `maos-engine${process.platform === 'win32' ? '.exe' : ''}`,
    );
    fs.mkdirSync(path.dirname(enginePath), { recursive: true });
    fs.copyFileSync(engineSource, enginePath);
  }
  const keyEnv = BASETEN_API_KEY_ENV;
  environmentNames.push(keyEnv);
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'demo', 'industrial', 'safety_thresholds.json'),
    path.join(root, 'demo', 'industrial', 'safety_thresholds.json'),
  );
  fs.mkdirSync(path.join(root, 'commissioning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'commissioning', 'bearing-ramp.csv'),
    [
      'sample_time,vibration_rms_mm_s,bearing_temperature_c',
      '2026-02-11T08:00:00Z,1.2,70',
      '2026-02-11T08:01:00Z,4.8,88',
      '2026-02-11T08:02:00Z,8.2,96',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        projectName: 'baseten-readonly-completion-test',
        providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
        agents: [
          {
            id: 'ANALYST_AGENT',
            role: 'test analyst',
            provider: 'baseten',
            model: BASETEN_API_MODEL,
            timeoutMs: 7_000,
            capabilities: ['analysis'],
            scope: ['.'],
          },
        ],
        routing: {
          strategy: 'capability_score',
          costWeight: 0,
          capabilityWeight: 1,
          maxParallelAgents: 1,
          fallbackProvider: 'baseten',
        },
      },
      null,
      2,
    ),
  );
  return { root, keyEnv, sourcePath: 'commissioning/bearing-ramp.csv' };
}

function installBasetenFetchBridge(targetBaseURL: string, requests: Array<{ url: string; init?: RequestInit }>) {
  const originalFetch = globalThis.fetch;
  const nativeFetch = originalFetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const targetUrl = String(input);
    requests.push({ url: targetUrl, init });
    if (!targetUrl.startsWith(`${BASETEN_API_BASE_URL}/chat/completions`))
      throw new Error('Unexpected hosted-provider request URL.');
    return nativeFetch(`${targetBaseURL}/chat/completions`, { ...init, redirect: 'error' });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function textResponse(content: string): ProviderResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'stub-model',
    latencyMs: 0,
    finishReason: 'stop',
  };
}

function completeResponse(summary: string, filesChanged?: string[]): ProviderResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: 'call-task-complete',
        type: 'function',
        function: {
          name: 'task_complete',
          arguments: JSON.stringify(
            filesChanged === undefined ? { summary } : { summary, files_changed: filesChanged },
          ),
        },
      },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'stub-model',
    latencyMs: 0,
    finishReason: 'tool_calls',
  };
}

async function runStopNudge(allowedTools: string[] | undefined, agentId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-readonly-nudge-'));
  projects.push(root);
  const seenMessages: Array<any[]> = [];
  const generate = vi.fn(async (messages: any[]) => {
    seenMessages.push(messages);
    if (seenMessages.length === 1) return textResponse('Plain summary without a completion call.');
    return completeResponse('Work is done.', []);
  });
  const result = await runAgent(
    { name: 'mock', model: 'stub-model', generate } as unknown as IProvider,
    {
      id: agentId,
      role: 'test worker',
      provider: 'mock',
      model: 'stub-model',
      capabilities: [],
      scope: ['.'],
      ...(allowedTools === undefined ? {} : { allowedTools }),
      maxIterations: 4,
    },
    { id: `${agentId}-task`, description: 'Test a completion reminder.', branch: 'local' },
    root,
    0,
    undefined,
    undefined,
    { allowPartialSuccess: false, maxProviderRetries: 0 },
  );
  const nudge = (seenMessages[1] as any[]).filter((message: any) => message.role === 'user').at(-1).content as string;
  return { result, nudge, calls: generate.mock.calls.length };
}

afterEach(async () => {
  for (const name of environmentNames.splice(0)) delete process.env[name];
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of projects.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('read-only completion at the root cause (mock only)', () => {
  it('reminds the actual Industrial read-only tool set that an empty files_changed list is valid', async () => {
    const { result, nudge, calls } = await runStopNudge(['analyze_telemetry_csv', 'task_complete'], 'readonly-agent');

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(calls).toBe(2);
    expect(nudge).toContain('files_changed: []');
  });

  it('keeps the existing reminder verbatim for mutating agents', async () => {
    const { result, nudge } = await runStopNudge(['write_file', 'task_complete'], 'mutating-agent');

    expect(result.success).toBe(true);
    expect(nudge).toContain('the list of files you changed');
    expect(nudge).not.toContain('files_changed: []');
  });

  it('keeps the existing reminder for a file-generating tool', async () => {
    const { result, nudge, calls } = await runStopNudge(['generate_docx', 'task_complete'], 'report-agent');

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(nudge).toContain('the list of files you changed');
    expect(nudge).not.toContain('files_changed: []');
  });

  it('does not assume an uncertain registry tool is read-only', async () => {
    const { result, nudge, calls } = await runStopNudge(
      ['read_file', 'share_knowledge', 'task_complete'],
      'uncertain-agent',
    );

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(nudge).toContain('the list of files you changed');
    expect(nudge).not.toContain('files_changed: []');
  });

  it('ignores names dropped by tool filtering when classifying', async () => {
    const { result, nudge, calls } = await runStopNudge(
      ['read_file', 'not_a_real_tool', 'task_complete'],
      'filtered-agent',
    );

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(nudge).toContain('files_changed: []');
  });

  it('drops the industrial-forbidden executor from the effective set', async () => {
    const previous = process.env.MAOS_PROFILE;
    process.env.MAOS_PROFILE = 'industrial';
    try {
      const { result, nudge, calls } = await runStopNudge(
        ['analyze_telemetry_csv', 'execute_python', 'task_complete'],
        'industrial-agent',
      );

      expect(result.success).toBe(true);
      expect(calls).toBe(2);
      expect(nudge).toContain('files_changed: []');
    } finally {
      if (previous === undefined) delete process.env.MAOS_PROFILE;
      else process.env.MAOS_PROFILE = previous;
    }
  });

  it('keeps the existing reminder for unrestricted agents', async () => {
    const { result, nudge, calls } = await runStopNudge(undefined, 'unrestricted-agent');

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(nudge).toContain('the list of files you changed');
    expect(nudge).not.toContain('files_changed: []');
  });

  it('recovers the observed live sequence: tool success, plain text, then read-only completion', async () => {
    const mock = await startServer((body) => {
      const requestNumber = mock.requests.length;
      if (requestNumber === 1) {
        return {
          body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })),
        };
      }
      if (requestNumber === 2) {
        return {
          body: completion('unused', '{}', {
            omitToolCalls: true,
            finishReason: 'stop',
            content: 'The readings cross the demo limits.',
          }),
        };
      }
      const tool = body.messages.find((message: any) => message.role === 'tool');
      const evidence = JSON.parse(tool.content);
      return {
        body: completion(
          'task_complete',
          JSON.stringify({ summary: `Replay receipt ${evidence.analysisId}. No files changed.` }),
        ),
      };
    });
    const project = makeProject();
    process.env[project.keyEnv] = 'synthetic-baseten-readonly-key-not-real';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installBasetenFetchBridge(mock.baseURL, outbound);
    try {
      const result = await createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV without changing files.',
        sourcePath: project.sourcePath,
      });

      expect(mock.requests).toHaveLength(3);
      expect(mock.requests.length).toBeLessThanOrEqual(4);
      expect(
        mock.requests.every((request) => request.body.max_tokens === 1500 && request.body.reasoning_effort === 'low'),
      ).toBe(true);
      const nudge = (mock.requests[2].body.messages as any[]).filter((message) => message.role === 'user').at(-1)
        .content as string;
      expect(nudge).toContain('files_changed: []');
      expect(result.evidence.verification.valid).toBe(true);
      expect(result.explanation).toContain(result.evidence.analysisId);
      const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
      expect(fs.readdirSync(analysisRoot).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
      expect(fs.readdirSync(path.join(analysisRoot, 'agent-reports'))).toHaveLength(1);
      const report = JSON.parse(fs.readFileSync(path.join(project.root, result.reportPath), 'utf8'));
      expect(report.acceptance).toBe('accepted');
      expect(report.explanation.status).toBe('unverified');
    } finally {
      restoreFetch();
    }
  });

  it('lets continued omission of completion terminate within the hard budget', async () => {
    const mock = await startServer((body) => {
      const requestNumber = mock.requests.length;
      if (requestNumber === 1) {
        return {
          body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })),
        };
      }
      return {
        body: completion('unused', '{}', {
          omitToolCalls: true,
          finishReason: 'stop',
          content: 'Still only prose, no completion call.',
        }),
      };
    });
    const project = makeProject();
    process.env[project.keyEnv] = 'synthetic-baseten-omission-key-not-real';
    const outbound: Array<{ url: string; init?: RequestInit }> = [];
    const restoreFetch = installBasetenFetchBridge(mock.baseURL, outbound);
    try {
      const failure = await createServiceContainer(project.root)
        .industrialAnalysisAgent.analyze(project.root, {
          request: 'Review this selected synthetic bearing CSV.',
          sourcePath: project.sourcePath,
        })
        .then(
          () => {
            throw new Error('Expected continued omission to fail closed.');
          },
          (error: Error) => error,
        );

      expect(failure).toMatchObject<Partial<IndustrialAnalysisAgentError>>({
        code: 'AGENT_EXECUTION_FAILED',
        message: expect.stringContaining('MAX_ITERATIONS'),
      });
      expect(mock.requests.length).toBeLessThanOrEqual(4);
      expect(
        mock.requests.every((request) => request.body.max_tokens === 1500 && request.body.reasoning_effort === 'low'),
      ).toBe(true);
      const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
      expect(fs.readdirSync(analysisRoot).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
      expect(fs.existsSync(path.join(analysisRoot, 'agent-reports'))).toBe(false);
      expect(JSON.stringify(createServiceContainer(project.root).audit.getRecords())).not.toContain(
        'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      );
    } finally {
      restoreFetch();
    }
  });

  it('shows receipt success separately from agent failure instead of fabricating success', async () => {
    const mock = await startServer((body) => {
      const requestNumber = mock.requests.length;
      if (requestNumber === 1) {
        return {
          body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })),
        };
      }
      return {
        body: completion('unused', '{}', {
          omitToolCalls: true,
          finishReason: 'stop',
          content: 'Prose without a completion call.',
        }),
      };
    });
    const project = makeProject();
    process.env[project.keyEnv] = 'synthetic-baseten-separate-states-key-not-real';
    const restoreFetch = installBasetenFetchBridge(mock.baseURL, []);
    try {
      const failure = await createServiceContainer(project.root)
        .industrialAnalysisAgent.analyze(project.root, {
          request: 'Review this selected synthetic bearing CSV.',
          sourcePath: project.sourcePath,
        })
        .then(
          () => {
            throw new Error('Expected the agent run to fail.');
          },
          (error: Error) => error,
        );

      expect(failure).toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });
      const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
      const receiptFile = fs.readdirSync(analysisRoot).find((entry) => entry.endsWith('.json'));
      expect(receiptFile).toBeDefined();
      const receipt = JSON.parse(fs.readFileSync(path.join(analysisRoot, receiptFile!), 'utf8'));
      const verification = verifyTelemetryAnalysis(project.root, receipt.analysisId);
      expect(verification).toMatchObject({
        valid: true,
        sourceHashMatched: true,
        rulesetHashMatched: true,
        recomputationMatched: true,
      });
      expect(fs.existsSync(path.join(analysisRoot, 'agent-reports'))).toBe(false);
      expect(JSON.stringify(createServiceContainer(project.root).audit.getRecords())).not.toContain(
        'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      );
    } finally {
      restoreFetch();
    }
  });

  it('does not accept arbitrary model prose as completed', async () => {
    const mock = await startServer((body) => {
      const requestNumber = mock.requests.length;
      if (requestNumber === 1) {
        return {
          body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })),
        };
      }
      return {
        body: completion('task_complete', JSON.stringify({ summary: 'Everything looks critical, trust this prose.' })),
      };
    });
    const project = makeProject();
    process.env[project.keyEnv] = 'synthetic-baseten-prose-key-not-real';
    const restoreFetch = installBasetenFetchBridge(mock.baseURL, []);
    try {
      await expect(
        createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
          request: 'Review this selected synthetic bearing CSV.',
          sourcePath: project.sourcePath,
        }),
      ).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'EVIDENCE_REFERENCE_REQUIRED' });
      const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
      expect(fs.existsSync(path.join(analysisRoot, 'agent-reports'))).toBe(false);
      expect(JSON.stringify(createServiceContainer(project.root).audit.getRecords())).not.toContain(
        'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      );
    } finally {
      restoreFetch();
    }
  });
});
