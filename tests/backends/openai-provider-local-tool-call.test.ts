import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../../src/backends/openai-provider';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('OpenAI-compatible local tool request', () => {
  it('omits unsupported tool_choice, bounds output, and parses the returned tool call', async () => {
    let requestBody: any;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-local-tool-test',
        object: 'chat.completion',
        created: 1,
        model: 'local-returned-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-local-tool-test',
              type: 'function',
              function: { name: 'analyze_telemetry_csv', arguments: '{"sourcePath":"selected.csv"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAIProvider({
      name: 'ollama-local',
      apiKey: 'local-only',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      maxRetries: 0,
    });

    const response = await provider.generate(
      [{ role: 'user', content: 'Analyze the selected CSV.' }],
      [{ type: 'function', function: { name: 'analyze_telemetry_csv', description: 'Analyze the selected CSV.', parameters: { type: 'object' } } }],
      { maxTokens: 256 },
    );

    expect(requestBody.model).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(requestBody.max_tokens).toBe(256);
    expect(requestBody.tools[0].function.name).toBe('analyze_telemetry_csv');
    expect(requestBody).not.toHaveProperty('tool_choice');
    expect(response.model).toBe('local-returned-model');
    expect(response.reportedModel).toBe('local-returned-model');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls).toEqual([{
      id: 'call-local-tool-test',
      type: 'function',
      function: { name: 'analyze_telemetry_csv', arguments: '{"sourcePath":"selected.csv"}' },
    }]);
  });

  it.each([
    ['provider confirms the requested ID', 'requested-model', 'requested-model'],
    ['provider omits its ID', undefined, undefined],
  ])('preserves provider identity when %s', async (_label, responseModel, expectedReported) => {
    const server = http.createServer(async (_req, res) => {
      const completion: Record<string, unknown> = {
        id: 'chatcmpl-model-identity',
        object: 'chat.completion',
        created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      };
      if (responseModel) completion.model = responseModel;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAIProvider({
      name: 'test-provider',
      apiKey: 'local-test-only',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'requested-model',
      maxRetries: 0,
    });
    const result = await provider.generate([{ role: 'user', content: 'hello' }]);
    expect(result.model).toBe(responseModel || 'requested-model');
    expect(result.reportedModel).toBe(expectedReported);
  });
});
