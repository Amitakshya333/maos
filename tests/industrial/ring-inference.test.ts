import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AddressInfo } from 'net';
import {
  BASETEN_API_BASE_URL,
  BASETEN_API_KEY_ENV,
  BASETEN_API_MODEL,
  ProviderApiPolicyError,
} from '../../src/backends/meta-api-policy';
import {
  RingInferenceService,
  RingAskResult,
} from '../../src/service/ring-inference-service';
import { RestApiRouter } from '../../src/api/router';
import { createServiceContainer } from '../../src/service';

describe('TASK RING-SVC-01: Ring Inference Service & Router Integration', () => {
  let tempProjectRoot: string;
  let mockServer: http.Server | null = null;
  let mockServerPort = 0;
  let capturedRequests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    // Create temporary project root
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-svc-test-'));

    // Stage required industrial demo assets
    const repoRoot = path.resolve(__dirname, '../..');
    fs.mkdirSync(path.join(tempProjectRoot, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(tempProjectRoot, 'demo', 'industrial'), { recursive: true });

    fs.copyFileSync(
      path.join(repoRoot, 'demo', 'industrial', 'sop_turbine_vibration_monitoring.md'),
      path.join(tempProjectRoot, 'demo', 'industrial', 'sop_turbine_vibration_monitoring.md'),
    );
    fs.copyFileSync(
      path.join(repoRoot, 'demo', 'industrial', 'maintenance_report.txt'),
      path.join(tempProjectRoot, 'demo', 'industrial', 'maintenance_report.txt'),
    );
    fs.copyFileSync(
      path.join(repoRoot, 'demo', 'industrial', 'safety_thresholds.json'),
      path.join(tempProjectRoot, 'demo', 'industrial', 'safety_thresholds.json'),
    );
    fs.copyFileSync(
      path.join(repoRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'),
      path.join(tempProjectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'),
    );

    // Default configuration with Baseten armed
    fs.writeFileSync(
      path.join(tempProjectRoot, '.maos', 'maos.config.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: 'ring-test-project',
          profile: {
            id: 'industrial',
            displayName: 'MAOS Industrial',
            mode: 'sovereign-local',
            zeroCloud: true,
          },
          providers: {
            baseten: {
              baseURL: BASETEN_API_BASE_URL,
              basetenApiEnabled: true,
            },
          },
          agents: [
            {
              id: 'ANALYST_AGENT',
              role: 'analyst',
              provider: 'baseten',
              model: BASETEN_API_MODEL,
            },
          ],
        },
        null,
        2,
      ),
    );

    capturedRequests = [];
  });

  afterEach(async () => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
    delete process.env[BASETEN_API_KEY_ENV];
    try {
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {}
  });

  const startMockServer = (
    responseBody: any,
    statusCode = 200,
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          let body: any;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined;
          }
          capturedRequests.push({ url: req.url || '', headers: req.headers, body });
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        });
      });

      mockServer.once('error', reject);
      mockServer.listen(0, '127.0.0.1', () => {
        mockServerPort = (mockServer!.address() as AddressInfo).port;
        const mockBaseURL = `http://127.0.0.1:${mockServerPort}`;

        // Install bridge redirecting Baseten calls to loopback mock
        const originalFetch = globalThis.fetch;
        const nativeFetch = originalFetch.bind(globalThis);
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const targetUrl = String(input);
          if (targetUrl.startsWith(`${BASETEN_API_BASE_URL}/chat/completions`)) {
            return nativeFetch(`${mockBaseURL}/chat/completions`, { ...init, redirect: 'error' });
          }
          return nativeFetch(input, init);
        }) as typeof globalThis.fetch;

        restoreFetch = () => {
          globalThis.fetch = originalFetch;
        };

        resolve(mockBaseURL);
      });
    });
  };

  // (a) armed + mock returns a message -> mode 'hosted', served id only when echoed
  it('(a) armed + mock returns a message -> mode hosted, served id only when echoed', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-baseten-key-armed-test';
    const mockEchoModel = 'meta-models/muse-spark-open-1026-echoed-from-mock';

    await startMockServer({
      id: 'chatcmpl-mock-baseten-a',
      object: 'chat.completion',
      created: 1730000000,
      model: mockEchoModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Analysis shows vibration RMS of 2.637 mm/s exceeding ISO demo alarm threshold.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    const service = new RingInferenceService({ projectRoot: tempProjectRoot });
    const result: RingAskResult = await service.ask({
      question: 'What is the turbine condition verdict?',
    });

    expect(result.mode).toBe('hosted');
    expect(result.providerName).toBe('baseten');
    expect(result.modelId).toBe(BASETEN_API_MODEL);
    expect(result.servedModelId).toBe(mockEchoModel);
    expect(result.answer).toBe('Analysis shows vibration RMS of 2.637 mm/s exceeding ISO demo alarm threshold.');
    expect(result.deterministic.attempted).toBe(true);
    expect(result.deterministic.verdict).toBe('CRITICAL');
    expect(result.deterministic.overallRms).toBeCloseTo(2.637, 2);
    expect(result.refusalTest).toEqual({ prepared: false });
    expect(result.sources.length).toBeGreaterThanOrEqual(3);

    // Verify subcase: served id is undefined when response does NOT echo a model
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    if (mockServer) {
      await new Promise<void>((res) => mockServer!.close(() => res()));
    }
    await startMockServer({
      id: 'chatcmpl-mock-baseten-a2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Echo without model identity' }, finish_reason: 'stop' }],
    });

    const resultWithoutEcho = await service.ask({ question: 'Check without echo' });
    expect(resultWithoutEcho.mode).toBe('hosted');
    expect(resultWithoutEcho.servedModelId).toBeUndefined();
  });

  // (b) key missing -> evidence-only, deterministic verdict still present
  it('(b) key missing -> evidence-only, deterministic verdict still present', async () => {
    delete process.env[BASETEN_API_KEY_ENV];

    const service = new RingInferenceService({ projectRoot: tempProjectRoot });
    const result = await service.ask({
      question: 'Provide turbine inspection verdict without API key',
    });

    expect(result.mode).toBe('evidence-only');
    expect(result.modelId).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.servedModelId).toBeUndefined();
    expect(result.deterministic.attempted).toBe(true);
    expect(result.deterministic.verdict).toBe('CRITICAL');
    expect(result.deterministic.overallRms).toBeCloseTo(2.637, 2);
    expect(result.answer).toContain('Engineering Verdict: CRITICAL');
    expect(result.answer).toContain('Overall Vibration RMS: 2.637 mm/s');
    expect(result.refusalTest).toEqual({ prepared: false });
  });

  // (c) basetenApiEnabled false -> evidence-only
  it('(c) basetenApiEnabled false -> evidence-only', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-key-but-optin-disabled';

    const service = new RingInferenceService({
      projectRoot: tempProjectRoot,
      loadProjectConfig: () => ({
        schemaVersion: 1,
        projectName: 'ring-optin-disabled',
        profile: { id: 'industrial', mode: 'sovereign-local', zeroCloud: true },
        providers: {
          baseten: {
            baseURL: BASETEN_API_BASE_URL,
            basetenApiEnabled: false,
          },
        },
      }),
    });

    const result = await service.ask({
      question: 'Inquiry when opt-in is false',
    });

    expect(result.mode).toBe('evidence-only');
    expect(result.modelId).toBeUndefined();
    expect(result.deterministic.verdict).toBe('CRITICAL');
    expect(result.answer).toContain('Deterministic Evidence Summary');
    expect(result.refusalTest).toEqual({ prepared: false });
  });

  // (d) endpoint/model mismatch -> evidence-only or the existing policy error, exactly as meta-api-policy behaves
  it('(d) endpoint/model mismatch -> rejected with BASETEN_API_CONFIGURATION_INVALID', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-key-for-mismatch-test';

    // Subcase d1: Hostile/mismatched endpoint
    const serviceBadEndpoint = new RingInferenceService({
      projectRoot: tempProjectRoot,
      loadProjectConfig: () => ({
        schemaVersion: 1,
        projectName: 'ring-bad-endpoint',
        profile: { id: 'industrial', mode: 'sovereign-local', zeroCloud: true },
        providers: {
          baseten: {
            baseURL: 'https://attacker.invalid/v1',
            basetenApiEnabled: true,
          },
        },
      }),
    });

    await expect(serviceBadEndpoint.ask({ question: 'Test bad endpoint' })).rejects.toThrow(
      ProviderApiPolicyError,
    );
    try {
      await serviceBadEndpoint.ask({ question: 'Test bad endpoint' });
    } catch (err: any) {
      expect(err.code).toBe('BASETEN_API_CONFIGURATION_INVALID');
      expect(err.message).toContain('Baseten Model API is limited to provider "baseten"');
    }

    // Subcase d2: Mismatched model
    const serviceBadModel = new RingInferenceService({
      projectRoot: tempProjectRoot,
      loadProjectConfig: () => ({
        schemaVersion: 1,
        projectName: 'ring-bad-model',
        profile: { id: 'industrial', mode: 'sovereign-local', zeroCloud: true },
        providers: {
          baseten: {
            baseURL: BASETEN_API_BASE_URL,
            model: 'unapproved/model-slug',
            basetenApiEnabled: true,
          },
        },
      }),
    });

    await expect(serviceBadModel.ask({ question: 'Test bad model' })).rejects.toThrow(
      ProviderApiPolicyError,
    );
    try {
      await serviceBadModel.ask({ question: 'Test bad model' });
    } catch (err: any) {
      expect(err.code).toBe('BASETEN_API_CONFIGURATION_INVALID');
    }
  });

  // (e) prompt sent to mock contains the summary and NOT raw telemetry rows (assert on captured request body)
  it('(e) prompt sent to mock contains the summary and NOT raw telemetry rows', async () => {
    process.env[BASETEN_API_KEY_ENV] = 'synthetic-baseten-key-prompt-leak-test';

    await startMockServer({
      id: 'chatcmpl-mock-prompt-check',
      model: BASETEN_API_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Verified summary received.' }, finish_reason: 'stop' }],
    });

    const service = new RingInferenceService({ projectRoot: tempProjectRoot });
    const userQuestion = 'Explain why turbine T-07 is showing high vibration?';
    await service.ask({ question: userQuestion });

    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0].body;
    expect(captured.messages).toBeDefined();

    const userMessage = captured.messages.find((m: any) => m.role === 'user');
    expect(userMessage).toBeDefined();
    const content = userMessage.content as string;

    // Must contain high-level summary & user question
    expect(content).toContain('Deterministic Engineering Context:');
    expect(content).toContain('Engineering Verdict: CRITICAL');
    expect(content).toContain('Overall Vibration RMS: 2.637 mm/s');
    expect(content).toContain(`Question:\n${userQuestion}`);

    // MUST NOT contain raw CSV header or bulk raw row dumps
    expect(content).not.toContain('sample_time,vibration_rms_mm_s,bearing_temperature_c');
    expect(content).not.toContain('2026-08-22T09:00:00+05:30,1.25,62.1');
    expect(content).not.toContain('2026-08-22T09:00:15+05:30,1.28,62.3');
  });

  // (f) malformed route body rejected
  it('(f) malformed route body rejected by REST API router', async () => {
    const services = createServiceContainer(tempProjectRoot);
    const router = new RestApiRouter(services, tempProjectRoot);

    const executeRoute = async (payload: any): Promise<{ status: number; body: any }> => {
      const payloadBuf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const req = {
        method: 'POST',
        url: '/api/v1/ring/ask',
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
      return { status: statusCode, body: resBody ? JSON.parse(resBody) : {} };
    };

    // Missing question
    const resEmpty = await executeRoute({});
    expect(resEmpty.status).toBe(400);
    expect(resEmpty.body.error.code).toBe('VALIDATION_FAILED');
    expect(resEmpty.body.error.message).toContain('question is required');

    // Blank question string
    const resBlank = await executeRoute({ question: '   ' });
    expect(resBlank.status).toBe(400);
    expect(resBlank.body.error.code).toBe('VALIDATION_FAILED');

    // Non-string question
    const resNonString = await executeRoute({ question: 12345 });
    expect(resNonString.status).toBe(400);
    expect(resNonString.body.error.code).toBe('VALIDATION_FAILED');

    // Blank analysisId
    const resBadAnalysisId = await executeRoute({ question: 'Valid question', analysisId: '   ' });
    expect(resBadAnalysisId.status).toBe(400);
    expect(resBadAnalysisId.body.error.code).toBe('VALIDATION_FAILED');

    // Valid request succeeds (evidence-only without key)
    const resValid = await executeRoute({ question: 'Is T-07 healthy?' });
    expect(resValid.status).toBe(200);
    expect(resValid.body.data.mode).toBe('evidence-only');
    expect(resValid.body.data.deterministic.verdict).toBe('CRITICAL');
  });
});
