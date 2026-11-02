/**
 * TASK RING-DEV-A-DAY2: OpenAI provider incremental streaming (synthetic only).
 *
 * Loopback SSE server on 127.0.0.1 (no network, no BASETEN_API_KEY, no live
 * calls). Covers: fragment reassembly == whole-path result, tool-call args
 * arriving in pieces, empty/reasoning heartbeats emitting no delta, zero-chunk
 * transport signalling streamEmpty, throwing onDelta not breaking the stream,
 * identical request bodies apart from `stream: true`, and Baseten
 * empty/length guards applying to the assembled stream.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../../src/backends/openai-provider';
import {
  BASETEN_API_BASE_URL,
  BASETEN_API_MODEL,
} from '../../src/backends/meta-api-policy';
import type { ChatMessage, ToolDef } from '../../src/backends/provider';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type ChunkChoice = {
  finish?: string | null;
  delta?: {
    content?: string | null;
    tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  };
};

function sseHandler(chunks: ChunkChoice[], opts?: { model?: string; capture?: (body: unknown) => void }) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const buf: Buffer[] = [];
    for await (const part of req) buf.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    try { opts?.capture?.(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const c of chunks) {
      const body = {
        id: 'chatcmpl-ring-day2-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: opts?.model ?? 'synthetic-stream-model',
        choices: [{ index: 0, delta: c.delta ?? {}, finish_reason: c.finish ?? null }],
      };
      res.write(`data: ${JSON.stringify(body)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void) {
  const server = http.createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const userMsg: ChatMessage[] = [{ role: 'user', content: 'Summarize turbine T-07.' }];
const telTools: ToolDef[] = [{
  type: 'function',
  function: { name: 'analyze_telemetry', description: 'telemetry', parameters: { type: 'object', properties: {} } },
}];

function localProvider(baseURL: string, opts?: { temperature?: number | null }) {
  return new OpenAIProvider({
    name: 'synthetic-stream-loopback',
    apiKey: 'synthetic-stream-key-not-real',
    baseURL: `${baseURL}/v1`,
    model: 'synthetic-stream-model',
    maxRetries: 0,
    temperature: opts?.temperature ?? null,
  });
}

describe('TASK RING-DEV-A-DAY2: OpenAI provider streaming', () => {
  it('reassembles content fragments in order; deltas match the assembled whole', async () => {
    const seen: string[] = [];
    const url = await listen(sseHandler([
      { delta: { content: 'Turbine ' } },
      { delta: {} },
      { delta: { content: 'T-07 is ' } },
      { delta: { content: 'CRITICAL.' }, finish: 'stop' },
    ]));
    const res = await localProvider(url).generateStream(userMsg, undefined, { onDelta: (d) => { seen.push(d); } });
    expect(seen).toEqual(['Turbine ', 'T-07 is ', 'CRITICAL.']);
    expect(res.content).toBe('Turbine T-07 is CRITICAL.');
    expect(res.finishReason).toBe('stop');
    expect(res.streamEmpty).not.toBe(true);
    expect(res.toolCalls).toEqual([]);
    // identity honesty: served id passes through reportedModel only
    expect(res.reportedModel).toBe('synthetic-stream-model');
    expect(res.model).toBe('synthetic-stream-model');
  });

  it('joins fragmented tool-call arguments before any JSON parsing', async () => {
    const url = await listen(sseHandler([
      { delta: {} },
      { delta: { tool_calls: [{ index: 0, id: 'call_tel_1', type: 'function', function: { name: 'analyze_telemetry', arguments: '' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{"csv' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: 'Path": "demo/x.csv"}' } }] } },
      { delta: {}, finish: 'tool_calls' },
    ]));
    const deltas: string[] = [];
    const res = await localProvider(url).generateStream(userMsg, telTools, { onDelta: (d) => { deltas.push(d); } });
    // content-free tool-call turn emits no content deltas
    expect(deltas).toEqual([]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].id).toBe('call_tel_1');
    expect(res.toolCalls[0].function.name).toBe('analyze_telemetry');
    expect(JSON.parse(res.toolCalls[0].function.arguments)).toEqual({ csvPath: 'demo/x.csv' });
  });

  it('fails closed when a streamed tool call has no function name', async () => {
    const url = await listen(sseHandler([
      { delta: { tool_calls: [{ index: 0, id: 'call_nameless', function: { arguments: '{}' } }] } },
      { delta: {}, finish: 'tool_calls' },
    ]));
    await expect(localProvider(url).generateStream(userMsg, telTools)).rejects.toThrow(/STREAM_TOOL_CALL_INVALID/);
  });

  it('a throwing onDelta never breaks the stream', async () => {
    const url = await listen(sseHandler([
      { delta: { content: 'hello ' } },
      { delta: { content: 'world' }, finish: 'stop' },
    ]));
    const res = await localProvider(url).generateStream(userMsg, undefined, {
      onDelta: () => { throw new Error('observer blew up'); },
    });
    expect(res.content).toBe('hello world');
  });

  it('zero-chunk transport signals streamEmpty so the caller can fall back', async () => {
    const url = await listen(async (req, res) => {
      const buf: Buffer[] = [];
      for await (const part of req) buf.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      const body = JSON.parse(Buffer.concat(buf).toString('utf8'));
      expect(body.stream).toBe(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-plain',
        object: 'chat.completion',
        created: 1,
        model: 'synthetic-stream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'plain JSON answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    const res = await localProvider(url).generateStream(userMsg);
    expect(res.streamEmpty).toBe(true);
    expect(res.toolCalls).toEqual([]);
    expect(res.content).toBeNull();
  });

  it('sends the identical request body apart from stream:true', async () => {
    const bodies: unknown[] = [];
    // Dual-mode server: SSE for stream:true, whole JSON otherwise.
    const url = await listen(async (req, res) => {
      const buf: Buffer[] = [];
      for await (const part of req) buf.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      const body = JSON.parse(Buffer.concat(buf).toString('utf8'));
      bodies.push(body);
      if (body.stream === true) {
        await sseHandler([{ delta: { content: 'ok' }, finish: 'stop' }])(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-whole-body',
        object: 'chat.completion',
        created: 1,
        model: 'synthetic-stream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    const provider = localProvider(url, { temperature: 0.2 });
    const whole = await provider.generate(userMsg, telTools, { maxTokens: 256 });
    const streamed = await provider.generateStream(userMsg, telTools, { maxTokens: 256 });
    expect(bodies).toHaveLength(2);
    const [wholeBody, streamBody] = bodies as Array<Record<string, unknown>>;
    expect(streamBody.stream).toBe(true);
    expect(wholeBody.stream).toBeUndefined();
    const { stream: _drop, ...restStream } = streamBody;
    expect(restStream).toEqual(wholeBody);
    expect(streamed.content).toBe(whole.content);
  });

  it('Baseten guards apply to the assembled stream (empty + length)', async () => {
    // Armed Baseten shape via the fetch-bridge pattern (synthetic key, loopback SSE).
    const chunks: ChunkChoice[][] = [
      [{ delta: {}, finish: 'stop' }],
      [{ delta: {}, finish: 'length' }],
    ];
    let call = 0;
    const server2 = http.createServer((req, res) => {
      const use = chunks[Math.min(call++, chunks.length - 1)];
      void sseHandler(use)(req, res);
    });
    servers.push(server2);
    await new Promise<void>((resolve, reject) => {
      server2.once('error', reject);
      server2.listen(0, '127.0.0.1', resolve);
    });
    const sseBase = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const bridgedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.startsWith(`${BASETEN_API_BASE_URL}/chat/completions`)) {
        return nativeFetch(`${sseBase}/chat/completions`, { ...init, redirect: 'error' });
      }
      return nativeFetch(target, init);
    }) as typeof globalThis.fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = bridgedFetch;
    process.env.BASETEN_API_KEY = 'synthetic-baseten-stream-key-not-real';
    try {
      const armed = new OpenAIProvider({
        name: 'baseten',
        apiKey: 'synthetic-unused-policy-key',
        baseURL: BASETEN_API_BASE_URL,
        model: BASETEN_API_MODEL,
        basetenApiEnabled: true,
        fetch: bridgedFetch,
        maxRetries: 0,
      });
      expect(armed.isBasetenApi).toBe(true);
      await expect(armed.generateStream(userMsg)).rejects.toThrow(/BASETEN_EMPTY_GENERATION/);
      await expect(armed.generateStream(userMsg)).rejects.toThrow(/BASETEN_INCOMPLETE_GENERATION/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.BASETEN_API_KEY;
    }
  });

  it('non-streaming generate() is unchanged by the refactor', async () => {
    const url = await listen(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-whole',
        object: 'chat.completion',
        created: 1,
        model: 'synthetic-stream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'whole answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));
    });
    const res = await localProvider(url).generate(userMsg);
    expect(res.content).toBe('whole answer');
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(res.streamEmpty).toBeUndefined();
  });
});
