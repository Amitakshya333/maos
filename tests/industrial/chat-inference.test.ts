/**
 * Chat Inference Service & Route Verification Tests
 *
 * Verifies:
 * 1. ChatInferenceService calls local loopback endpoint with deterministic settings (temperature=0, top_p=1).
 * 2. Prepend sovereign system prompt without leaking secrets.
 * 3. Fails closed with MODEL_SERVER_UNAVAILABLE when server is unreachable.
 * 4. Audit events are recorded without raw conversational text.
 * 5. REST API routes POST /api/v1/chat/completions and GET /api/v1/chat/health.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import {
  ChatInferenceService,
  ChatInferenceError,
} from '../../src/service/chat-inference-service';
import { RestApiRouter } from '../../src/api/router';
import { createServiceContainer } from '../../src/service';

describe('ChatInferenceService (Model-Backed Chat)', () => {
  let mockServer: http.Server | null = null;
  let mockServerPort = 0;
  let receivedRequests: Array<{ url: string; method: string; body: any }> = [];

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
    receivedRequests = [];
  });

  const startMockServer = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> => {
    return new Promise((resolve) => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer!.address() as any;
        mockServerPort = addr.port;
        resolve(mockServerPort);
      });
    });
  };

  it('fails closed with MODEL_SERVER_UNAVAILABLE when endpoint is not running', async () => {
    // Port 59999 is almost certainly closed
    const service = new ChatInferenceService({
      modelEndpoint: 'http://127.0.0.1:59999',
      timeoutMs: 1000,
    });

    await expect(
      service.chatCompletion({
        conversationId: 'conv-test-1',
        messages: [{ role: 'user', content: 'Hello sovereign model' }],
      }),
    ).rejects.toThrow(ChatInferenceError);

    try {
      await service.chatCompletion({
        conversationId: 'conv-test-1',
        messages: [{ role: 'user', content: 'Hello sovereign model' }],
      });
    } catch (err: any) {
      expect(err.code).toBe('MODEL_SERVER_UNAVAILABLE');
      expect(err.message).toContain('Cannot connect to local model server');
    }
  });

  it('isModelServerAvailable returns false when server is down', async () => {
    const service = new ChatInferenceService({
      modelEndpoint: 'http://127.0.0.1:59999',
    });
    const available = await service.isModelServerAvailable();
    expect(available).toBe(false);
  });

  it('sends deterministic request parameters and returns completion', async () => {
    const port = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedRequests.push({
          url: req.url || '',
          method: req.method || '',
          body: JSON.parse(body),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock-1',
            object: 'chat.completion',
            model: 'qwen2.5-3b-instruct-local',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Turbine bearing vibration RMS is within normal operating limits.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 42,
              completion_tokens: 15,
              total_tokens: 57,
            },
          }),
        );
      });
    });

    const mockAudit = {
      recordAuditEvent: vi.fn(),
    };

    const service = new ChatInferenceService({
      modelEndpoint: `http://127.0.0.1:${port}`,
      auditService: mockAudit as any,
    });

    const result = await service.chatCompletion({
      conversationId: 'conv-audit-123',
      messages: [
        { role: 'user', content: 'Analyze turbine vibration log.' },
      ],
    });

    // 1. Verify result structure
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('Turbine bearing vibration RMS is within normal operating limits.');
    expect(result.usage.totalTokens).toBe(57);
    expect(result.deterministic).toBe(true);
    expect(result.model).toBe('qwen2.5-3b-instruct-local');

    // 2. Verify payload sent to model server
    expect(receivedRequests.length).toBe(1);
    const reqBody = receivedRequests[0].body;
    expect(reqBody.temperature).toBe(0);
    expect(reqBody.top_p).toBe(1);
    expect(reqBody.stream).toBe(false);
    expect(reqBody.max_tokens).toBe(768);
    // Messages must have system prompt first
    expect(reqBody.messages[0].role).toBe('system');
    expect(reqBody.messages[0].content).toContain('MAOS Sovereign Assistant');
    expect(reqBody.messages[1].role).toBe('user');
    expect(reqBody.messages[1].content).toBe('Analyze turbine vibration log.');

    // 3. Verify privacy-preserving audit event
    expect(mockAudit.recordAuditEvent).toHaveBeenCalledWith({
      category: 'stage',
      source: 'chat-inference-service',
      data: expect.objectContaining({
        event: 'CHAT_INFERENCE_COMPLETED',
        conversationId: 'conv-audit-123',
        model: 'qwen2.5-3b-instruct-local',
        totalTokens: 57,
        deterministic: true,
      }),
    });
    // Ensure raw text is NOT in audit data
    const auditCallArg = mockAudit.recordAuditEvent.mock.calls[0][0];
    expect(JSON.stringify(auditCallArg.data)).not.toContain('Turbine bearing vibration RMS');
  });

  it('handles 503 from model server as MODEL_SERVER_UNAVAILABLE', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Model weights not loaded');
    });

    const service = new ChatInferenceService({
      modelEndpoint: `http://127.0.0.1:${port}`,
    });

    try {
      await service.chatCompletion({
        conversationId: 'conv-503',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.fail('Should have thrown ChatInferenceError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ChatInferenceError);
      expect(err.code).toBe('MODEL_SERVER_UNAVAILABLE');
    }
  });
});

describe('REST API Router — Chat Endpoints', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const services = createServiceContainer(projectRoot);
  const router = new RestApiRouter(services, projectRoot);

  it('rejects POST /api/v1/chat/completions with missing messages', async () => {
    const payloadBuf = Buffer.from(JSON.stringify({ conversationId: 'c1' }));
    const req = {
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield payloadBuf;
      },
      on: (event: string, cb: any) => {
        if (event === 'data') cb(payloadBuf);
        if (event === 'end') cb();
      },
    } as any;

    let statusCode = 0;
    let resBody = '';
    const res = {
      writeHead: (status: number) => {
        statusCode = status;
      },
      setHeader: () => {},
      end: (data: string) => {
        resBody = data;
      },
    } as any;

    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(400);
    const parsed = JSON.parse(resBody);
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
  });

  it('GET /api/v1/chat/health returns status object', async () => {
    const req = {
      method: 'GET',
      url: '/api/v1/chat/health',
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
      on: (event: string, cb: any) => {
        if (event === 'end') cb();
      },
    } as any;

    let statusCode = 0;
    let resBody = '';
    const res = {
      writeHead: (status: number) => {
        statusCode = status;
      },
      setHeader: () => {},
      end: (data: string) => {
        resBody = data;
      },
    } as any;

    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(resBody);
    expect(parsed.data).toBeDefined();
    expect(typeof parsed.data.available).toBe('boolean');
    expect(typeof parsed.data.status).toBe('string');
  });
});
