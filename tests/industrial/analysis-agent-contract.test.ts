import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../../src/backends/openai-provider';
import type { AuditRecord } from '../../src/domain';
import { IndustrialAnalysisAgentError, IndustrialAnalysisAgentService } from '../../src/industrial/analysis-agent-service';
import type { AuditService } from '../../src/service/audit-service';

type MockAction = { status?: number; body?: unknown; hang?: boolean };
type MockHandler = (request: any, requestNumber: number) => MockAction | Promise<MockAction>;

interface MockTransport {
  baseURL: string;
  requests: any[];
  waitForRequest(requestNumber: number): Promise<void>;
  close(): Promise<void>;
}

const projects: string[] = [];
const transports: MockTransport[] = [];
const repoRoot = path.resolve(__dirname, '../..');

function makeChatCompletion(toolCall: { id: string; name: string; arguments: string }) {
  return {
    id: 'chatcmpl-contract',
    object: 'chat.completion',
    created: 1,
    model: 'mock-transport-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: toolCall.arguments },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

function completionAction(toolCall: { id: string; name: string; arguments: string }): MockAction {
  return { body: makeChatCompletion(toolCall) };
}

function createTransport(handler: MockHandler): Promise<MockTransport> {
  const requests: any[] = [];
  const waiters = new Map<number, Array<() => void>>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      for (const resolve of waiters.get(requests.length) || []) resolve();
      waiters.delete(requests.length);
      try {
        const action = await handler(body, requests.length);
        if (action.hang || res.destroyed) return;
        res.writeHead(action.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(action.body));
      } catch {
        if (!res.destroyed) {
          res.writeHead(500);
          res.end();
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const transport: MockTransport = {
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        waitForRequest(requestNumber) {
          if (requests.length >= requestNumber) return Promise.resolve();
          return new Promise((done) => {
            const queued = waiters.get(requestNumber) || [];
            queued.push(done);
            waiters.set(requestNumber, queued);
          });
        },
        async close() {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      };
      transports.push(transport);
      resolve(transport);
    });
  });
}

function createProject(csv = [
  'sample_time,vibration_rms_mm_s,bearing_temperature_c',
  '2026-02-11T08:00:00Z,1.2,70',
  '2026-02-11T08:01:00Z,4.8,88',
  '2026-02-11T08:02:00Z,8.2,96',
  '2026-02-11T08:03:00Z,3.0,82',
].join('\n')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-agent-contract-'));
  projects.push(root);
  fs.mkdirSync(path.join(root, 'demo/industrial'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'demo/industrial/safety_thresholds.json'),
    path.join(root, 'demo/industrial/safety_thresholds.json'),
  );
  const sourcePath = 'commissioning/bearing-ramp.csv';
  fs.mkdirSync(path.dirname(path.join(root, sourcePath)), { recursive: true });
  fs.writeFileSync(path.join(root, sourcePath), csv);
  return { root, sourcePath };
}

function createService(transport: MockTransport, timeout = 2_000) {
  return new IndustrialAnalysisAgentService(new OpenAIProvider({
    name: 'mock-openai-compatible-transport',
    apiKey: 'not-needed',
    baseURL: transport.baseURL,
    model: 'contract-test-model',
    timeout,
    maxRetries: 0,
  }), transport.baseURL, {
    recordAuditEvent(params) {
      return {
        schemaVersion: 1,
        sequence: 0,
        previous_hash: '',
        timestamp: new Date().toISOString(),
        source: params.source,
        category: params.category,
        data: params.data,
        hash: 'b'.repeat(64),
      } satisfies AuditRecord;
    },
  } satisfies Pick<AuditService, 'recordAuditEvent'>);
}

function requestedPath(request: any): string {
  const userMessage = request.messages.find((message: any) => message.role === 'user');
  const match = String(userMessage?.content || '').match(/Analyze only this user-selected project file: ([^\r\n]+)/);
  if (!match) throw new Error('The selected project path was not present in the model request.');
  return match[1];
}

function completeWithFakeEvidence(): MockAction {
  return completionAction({
    id: 'call-forged-completion',
    name: 'task_complete',
    arguments: JSON.stringify({ summary: 'Evidence reference: telemetry-0000000000-deadbeef.' }),
  });
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const root of projects.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Industrial analysis agent OpenAI-compatible transport contract', () => {
  it('round-trips a model-requested allowlisted tool and links its explanation to held-out same-implementation replay results', async () => {
    const project = createProject();
    const transport = await createTransport((request, requestNumber) => {
      if (requestNumber === 1) {
        return completionAction({
          id: 'call-analysis',
          name: 'analyze_telemetry_csv',
          arguments: JSON.stringify({ sourcePath: requestedPath(request) }),
        });
      }

      const returnedTool = request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call-analysis');
      const evidence = JSON.parse(returnedTool.content);
      const { result } = evidence;
      return completionAction({
        id: 'call-complete',
        name: 'task_complete',
        arguments: JSON.stringify({
          summary: `The deterministic thresholds classify ${result.rowsAnalyzed} rows as ${result.verdict}; peak vibration ${result.peakVibration} mm/s and peak temperature ${result.peakTemperature} C. Receipt ${evidence.analysisId}.`,
        }),
      });
    });
    const service = createService(transport);

    const result = await service.analyze(project.root, {
      request: 'Review this bearing ramp, count threshold crossings, and explain the measured peaks.',
      sourcePath: project.sourcePath,
    });

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'analyze_telemetry_csv',
      'task_complete',
    ]);
    expect(requestedPath(transport.requests[0])).toBe('commissioning/bearing-ramp.csv');
    const returnedTool = transport.requests[1].messages.find((message: any) => message.role === 'tool');
    const handedOff = JSON.parse(returnedTool.content);
    expect(returnedTool.tool_call_id).toBe('call-analysis');
    expect(handedOff.analysisId).toBe(result.evidence.analysisId);
    expect(handedOff.result).toEqual(result.evidence.result);
    expect(result.provider).toBe('mock-openai-compatible-transport');
    expect(result.requestedModel).toBe('contract-test-model');
    expect(result.reportedModel).toBe('mock-transport-model');
    const reportPath = path.join(project.root, result.reportPath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.analysisId).toBe(result.evidence.analysisId);
    expect(report.runId).toBe(result.runId);
    expect(report.model).toEqual({ provider: 'mock-openai-compatible-transport', requested: 'contract-test-model', reported: 'mock-transport-model' });
    expect(report.numericFindings.receiptSha256).toBe(result.evidence.receiptSha256);
    expect(report.numericFindings.status).toBe('replay-matched');
    expect(report.explanation.status).toBe('unverified');
    expect(result.execution).toBe('provider-tool-call');
    expect(result.evidence.source.selectedPath).toBe(project.sourcePath);
    expect(result.evidence.result).toMatchObject({
      rowsAnalyzed: 4,
      overallVibrationRms: Math.sqrt((1.2 ** 2 + 4.8 ** 2 + 8.2 ** 2 + 3.0 ** 2) / 4),
      peakVibration: 8.2,
      peakTemperature: 96,
      warningCount: 2,
      criticalCount: 2,
      verdict: 'CRITICAL',
    });
    expect(result.evidence.verification.valid).toBe(true);
    expect(result.explanation).toContain(result.evidence.analysisId);
    expect(result.explanation).not.toBe(JSON.stringify(result.evidence.result));
  });

  it.each([
    ['malformed JSON arguments', '{"sourcePath":'],
    ['an undeclared argument', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv', extra: true })],
  ])('rejects %s and does not accept the model’s false completion', async (_label, toolArguments) => {
    const project = createProject();
    const transport = await createTransport((_request, requestNumber) => requestNumber === 1
      ? completionAction({ id: 'call-bad-analysis', name: 'analyze_telemetry_csv', arguments: toolArguments })
      : completeWithFakeEvidence());
    const service = createService(transport);

    await expect(service.analyze(project.root, {
      request: 'Check this file for threshold crossings and summarize the result.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'ANALYSIS_TOOL_FAILED' });

    expect(transport.requests).toHaveLength(2);
    const returnedTool = transport.requests[1].messages.find((message: any) => message.role === 'tool');
    expect(JSON.parse(returnedTool.content).ok).toBe(false);
  });

  it('rejects an unknown tool request and does not treat a later task_complete as analysis success', async () => {
    const project = createProject();
    const transport = await createTransport((_request, requestNumber) => requestNumber === 1
      ? completionAction({ id: 'call-unknown', name: 'run_shell', arguments: '{"command":"echo unsafe"}' })
      : completeWithFakeEvidence());
    const service = createService(transport);

    await expect(service.analyze(project.root, {
      request: 'Analyze this selected telemetry file.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'ANALYSIS_TOOL_NOT_USED' });

    expect(transport.requests).toHaveLength(2);
    const returnedTool = transport.requests[1].messages.find((message: any) => message.role === 'tool');
    expect(returnedTool.content).toContain('TOOL_UNAUTHORIZED');
  });

  it('keeps a deterministic tool execution failure failed even when the model calls task_complete', async () => {
    const project = createProject([
      'sample_time,vibration_rms_mm_s,bearing_temperature_c',
      '2026-02-11T08:00:00Z,not-a-number,70',
    ].join('\n'));
    const transport = await createTransport((request, requestNumber) => requestNumber === 1
      ? completionAction({
        id: 'call-analysis',
        name: 'analyze_telemetry_csv',
        arguments: JSON.stringify({ sourcePath: requestedPath(request) }),
      })
      : completeWithFakeEvidence());
    const service = createService(transport);

    await expect(service.analyze(project.root, {
      request: 'Check this commissioning sample against the thresholds.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'ANALYSIS_TOOL_FAILED' });

    expect(transport.requests).toHaveLength(2);
    const returnedTool = transport.requests[1].messages.find((message: any) => message.role === 'tool');
    expect(JSON.parse(returnedTool.content).ok).toBe(false);
  });

  it('stops on a bounded model timeout without retrying', async () => {
    const project = createProject();
    const transport = await createTransport(() => ({ hang: true }));
    const service = createService(transport, 40);

    await expect(service.analyze(project.root, {
      request: 'Review this telemetry sample.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });

    expect(transport.requests).toHaveLength(1);
  });

  it('does not complete when the model times out after the analysis receipt is written', async () => {
    const project = createProject();
    const transport = await createTransport((request, requestNumber) => requestNumber === 1
      ? completionAction({
        id: 'call-analysis',
        name: 'analyze_telemetry_csv',
        arguments: JSON.stringify({ sourcePath: requestedPath(request) }),
      })
      : ({ hang: true }));
    const service = createService(transport, 60);

    await expect(service.analyze(project.root, {
      request: 'Review this bearing ramp against the demo thresholds.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });

    expect(transport.requests).toHaveLength(2);
  });

  it('cancels an in-flight local model request and returns no completion', async () => {
    const project = createProject();
    const transport = await createTransport(() => ({ hang: true }));
    const service = createService(transport);
    const controller = new AbortController();
    const pending = service.analyze(project.root, {
      request: 'Review this telemetry sample.',
      sourcePath: project.sourcePath,
    }, { signal: controller.signal });

    await transport.waitForRequest(1);
    controller.abort();

    await expect(pending).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_CANCELLED' });
    expect(transport.requests).toHaveLength(1);
  });

  it('caps transient retries at one request for the industrial path', async () => {
    const project = createProject();
    const transport = await createTransport(() => ({ status: 503, body: { error: { message: 'local model unavailable' } } }));
    const service = createService(transport);

    await expect(service.analyze(project.root, {
      request: 'Review this telemetry sample.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });

    expect(transport.requests).toHaveLength(1);
  });

  it('caps tool-loop iterations and never completes after repeated unknown calls', async () => {
    const project = createProject();
    const transport = await createTransport(() => completionAction({
      id: 'call-unknown',
      name: 'run_shell',
      arguments: '{"command":"echo unsafe"}',
    }));
    const service = createService(transport);

    await expect(service.analyze(project.root, {
      request: 'Analyze this selected telemetry file.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_EXECUTION_FAILED' });

    expect(transport.requests).toHaveLength(4);
  });
});
