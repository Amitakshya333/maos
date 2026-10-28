import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventParams, AuditRecord } from '../../src/domain';
import { ProjectServiceHost } from '../../src/service/project-service/host';
import { EndpointAllowlistService } from '../../src/service/endpoint-allowlist-service';
import { INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';
import { RestApiServer } from '../../src/api/server';
import { parseZipArchive } from '../../src/industrial/office/ooxml-packager';
import { isAcceptedJudgedRun, readJudgedRunManifest, resumeJudgedRunAfterApproval } from '../../src/industrial/judged-run';
import { executeDeterministicReset } from '../../src/industrial/deterministic-reset';
import { withJudgedRunOutputLock } from '../../src/industrial/judged-run-lock';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ALLOWED_ORIGIN = 'http://127.0.0.1:41731';
const CSV = [
  'timestamp,vibration_rms_mm_s,bearing_temperature_c',
  '2026-04-01T08:00:00Z,2.1,70',
  '2026-04-01T08:01:00Z,7.4,96',
].join('\n');

interface ModelBehavior {
  firstDelayMs?: number;
  secondDelayMs?: number;
  hangFirst?: boolean;
  hangSecond?: boolean;
  toolName?: string;
  toolArguments?: (body: any) => string;
}

interface MockInference {
  baseURL: string;
  requests: any[];
  behavior: ModelBehavior;
  waitForRequest(number: number): Promise<void>;
  waitForResponseClose(number: number): Promise<void>;
  close(): Promise<void>;
}

interface AgentSystem {
  root: string;
  host: ProjectServiceHost;
  baseURL: string;
  token: string;
  model: MockInference;
}

function mockAudit(system: AgentSystem) {
  const events: AuditEventParams[] = [];
  let nextFailure: { event: string; afterPersist: boolean } | null = null;
  let failNextExport = false;
  let afterRecord: ((params: AuditEventParams) => void) | undefined;
  const audit = system.host.getServer()!.getServices().audit;
  const spy = vi.spyOn(audit, 'recordAuditEvent').mockImplementation((params) => {
    if (nextFailure && nextFailure.event === params.data.event && !nextFailure.afterPersist) {
      nextFailure = null;
      throw new Error(`simulated ${String(params.data.event)} audit persistence failure`);
    }
    events.push(params);
    const record = makeAuditRecord(params, events.length - 1);
    afterRecord?.(params);
    if (nextFailure && nextFailure.event === params.data.event && nextFailure.afterPersist) {
      nextFailure = null;
      throw new Error(`simulated post-persist ${String(params.data.event)} failure`);
    }
    return record;
  });
  vi.spyOn(audit, 'exportAuditTrail').mockImplementation(() => {
    if (failNextExport) {
      failNextExport = false;
      throw new Error('simulated audit export failure');
    }
    const records = events.map((event, index) => makeAuditRecord(event, index));
    return {
      records,
      verification: { valid: true, errors: [], recordCount: records.length, latestHash: records.at(-1)?.hash || '' },
    } as any;
  });
  vi.spyOn(audit, 'getRecords').mockImplementation(() => events.map((event, index) => makeAuditRecord(event, index)));
  vi.spyOn(audit, 'verifyChain').mockImplementation(() => ({ valid: true, errors: [] } as any));
  return {
    events,
    spy,
    failNextEvent(event: string, afterPersist = false) { nextFailure = { event, afterPersist }; },
    failNextExport() { failNextExport = true; },
    onRecord(callback: (params: AuditEventParams) => void) { afterRecord = callback; },
  };
}

function resetCliFromChild(projectRoot: string, runId: string) {
  const cliModule = path.join(REPO_ROOT, 'src', 'industrial', 'industrial-cli.ts');
  const script = [
    "const fs = require('node:fs');",
    "const ts = require('typescript');",
    "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
    "console.log = () => {};",
    "const { runIndustrialReset } = require(process.argv[1]);",
    "runIndustrialReset({ projectRoot: process.argv[2], allowlist: 'output', runId: process.argv[3], yes: true, json: true }).then(result => { process.stdout.write(JSON.stringify(result)); process.exit(result.exitCode); }, error => { process.stderr.write(String(error)); process.exit(1); });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, cliModule, projectRoot, runId], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Reset CLI child did not exit: ${result.stderr}`);
  return { exitCode: result.status, output: `${result.stdout}${result.stderr}`, result: JSON.parse(result.stdout) };
}

function startPausedResetCli(projectRoot: string, runId: string) {
  const cliModule = path.join(REPO_ROOT, 'src', 'industrial', 'industrial-cli.ts');
  const script = [
    "const fs = require('node:fs');",
    "const originalUnlink = fs.unlinkSync.bind(fs);",
    "let paused = false;",
    "fs.unlinkSync = (target, ...args) => { if (!paused && String(target).includes(process.argv[3])) { paused = true; process.stdout.write('reset-lock-held\\n'); const signal = Buffer.alloc(1); if (fs.readSync(0, signal, 0, 1, null) !== 1) throw new Error('reset barrier closed before release'); } return originalUnlink(target, ...args); };",
    "const ts = require('typescript');",
    "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
    "console.log = () => {};",
    "const { runIndustrialReset } = require(process.argv[1]);",
    "runIndustrialReset({ projectRoot: process.argv[2], allowlist: 'output', runId: process.argv[3], yes: true, json: true }).then(result => { process.stdout.write(JSON.stringify(result) + '\\n'); process.exit(result.exitCode); }, error => { process.stderr.write(String(error)); process.exit(1); });",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, cliModule, projectRoot, runId], { cwd: REPO_ROOT, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return {
    child,
    output: () => output,
    waitForMarker(marker: string) {
      if (output.includes(marker)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Reset CLI did not reach '${marker}'. Output: ${output}`)), 15_000);
        const check = () => {
          if (output.includes(marker)) {
            clearTimeout(timer);
            child.stdout.off('data', check);
            child.once('exit', (code) => reject(new Error(`Reset CLI exited with ${code} before the barrier was released.`)));
            resolve();
          }
        };
        child.stdout.on('data', check);
      });
    },
    release() { child.stdin.write('x'); },
    waitForExit() {
      return new Promise<number>((resolve, reject) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('error', reject);
        child.once('exit', (code) => code === null ? reject(new Error('Reset CLI exited without a status.')) : resolve(code));
      });
    },
  };
}

function makeAuditRecord(params: AuditEventParams, sequence: number): AuditRecord {
  return {
    schemaVersion: 1,
    sequence,
    previous_hash: '',
    timestamp: new Date().toISOString(),
    source: params.source,
    category: params.category,
    data: params.data,
    hash: 'c'.repeat(64),
  };
}

const systems: AgentSystem[] = [];
const extraDirectories: string[] = [];

function toolCompletion(toolName: string, argumentsJson: string) {
  return {
    id: 'chatcmpl-agent-http',
    object: 'chat.completion',
    created: 1,
    model: 'mock-returned-model-v2',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-agent-http',
          type: 'function',
          function: { name: toolName, arguments: argumentsJson },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function findSelectedPath(body: any): string {
  const userMessage = body.messages.find((message: any) => message.role === 'user');
  const match = String(userMessage?.content || '').match(/Analyze only this user-selected project file: ([^\r\n]+)/);
  if (!match) throw new Error('The selected path was missing from the provider request.');
  return match[1];
}

async function createMockInference(): Promise<MockInference> {
  const requests: any[] = [];
  const closedResponses = new Set<number>();
  const requestWaiters = new Map<number, Array<() => void>>();
  const closeWaiters = new Map<number, Array<() => void>>();
  const notify = (queue: Map<number, Array<() => void>>, number: number) => {
    for (const resolve of queue.get(number) || []) resolve();
    queue.delete(number);
  };
  const model: MockInference = {
    baseURL: '',
    requests,
    behavior: {},
    waitForRequest(number) {
      if (requests.length >= number) return Promise.resolve();
      return new Promise((resolve) => {
        const waiters = requestWaiters.get(number) || [];
        waiters.push(resolve);
        requestWaiters.set(number, waiters);
      });
    },
    waitForResponseClose(number) {
      if (closedResponses.has(number)) return Promise.resolve();
      return new Promise((resolve) => {
        const waiters = closeWaiters.get(number) || [];
        waiters.push(resolve);
        closeWaiters.set(number, waiters);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const requestNumber = requests.length;
    notify(requestWaiters, requestNumber);
    res.once('close', () => {
      closedResponses.add(requestNumber);
      notify(closeWaiters, requestNumber);
    });

    const behavior = model.behavior;
    const isFirst = requestNumber === 1;
    const shouldHang = isFirst ? behavior.hangFirst : behavior.hangSecond;
    if (shouldHang) return;
    const delayMs = isFirst ? behavior.firstDelayMs || 0 : behavior.secondDelayMs || 0;
    const timer = setTimeout(() => {
      if (!res.destroyed) {
        if (isFirst) {
          const args = behavior.toolArguments?.(body) ?? JSON.stringify({ sourcePath: findSelectedPath(body) });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(toolCompletion(behavior.toolName || 'analyze_telemetry_csv', args)));
          return;
        }
        const toolMessage = [...body.messages].reverse().find((message: any) => message.role === 'tool');
        let result: any;
        try { result = toolMessage ? JSON.parse(toolMessage.content) : undefined; } catch { result = undefined; }
        const summary = `The sample has ${result?.result?.rowsAnalyzed ?? 0} rows; receipt ${result?.analysisId ?? 'telemetry-0000000000-deadbeef'}.`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toolCompletion('task_complete', JSON.stringify({ summary }))));
      }
    }, delayMs);
    res.once('close', () => clearTimeout(timer));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  model.baseURL = `http://127.0.0.1:${port}/v1`;
  return model;
}

async function createSystem(options: { modelTimeoutMs?: number } = {}): Promise<AgentSystem> {
  const model = await createMockInference();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-agent-auth-http-'));
  systems.push({ root, host: null as any, baseURL: '', token: '', model });
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'demo', 'industrial', 'safety_thresholds.json'), path.join(root, 'demo', 'industrial', 'safety_thresholds.json'));
  fs.writeFileSync(path.join(root, 'selected.csv'), CSV);
  fs.writeFileSync(path.join(root, 'other.csv'), CSV.replace(',2.1,70', ',1.0,65'));
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'agent-auth-http-test',
    routingMode: 'auto',
    providers: { mock: { apiKey: 'local-test-only', baseURL: model.baseURL, costPerMillionTokens: 0 } },
    agents: [{ id: 'ANALYST_AGENT', role: 'test analyst', provider: 'mock', model: 'configured-mock-model-v1', timeoutMs: options.modelTimeoutMs ?? 2000, capabilities: ['analysis'], scope: ['.'] }],
    routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'mock' },
  }, null, 2));

  const modelPort = Number(new URL(model.baseURL).port);
  const allowlist = new EndpointAllowlistService(root);
  allowlist.freezePolicy('default', {
    customEndpoints: [{
      endpointId: 'ep_agent_auth_http_test',
      protocol: 'tcp',
      direction: 'connect',
      host: '127.0.0.1',
      port: modelPort,
      serviceId: 'industrial_analysis_agent',
      processCategory: 'model',
      isLoopbackOnly: true,
      description: 'Temporary loopback mock inference for the authenticated route test.',
    }],
    ephemeralPortRange: { min: 1024, max: 65535 },
  });

  const host = new ProjectServiceHost(root, { port: 0, allowedOrigins: [ALLOWED_ORIGIN] });
  const started = await host.start();
  const system = systems[systems.length - 1];
  system.host = host;
  system.baseURL = `http://127.0.0.1:${started.port}`;
  system.token = host.createSession('agent-auth-http-test-window').token;
  return system;
}

function requestHeaders(system: AgentSystem, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Origin: ALLOWED_ORIGIN,
    Authorization: `Bearer ${system.token}`,
    'X-Project-Root': system.root,
    'X-Project-ID': 'agent-auth-http-test',
    ...overrides,
  };
}

async function post(system: AgentSystem, route: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${system.baseURL}${route}`, {
    method: 'POST',
    headers: requestHeaders(system, headers),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function prepareReview(system: AgentSystem) {
  const analysis = await post(system, '/api/v1/industrial/analysis-agent', {
    request: 'Review the selected synthetic CSV against the demonstration rules.',
    sourcePath: 'selected.csv',
  });
  expect(analysis.status).toBe(200);
  const prepared = await post(system, '/api/v1/industrial/judged-runs', {
    analysisId: analysis.payload.data.evidence.analysisId,
  });
  expect(prepared.status, JSON.stringify(prepared.payload)).toBe(202);
  return { analysis, prepared };
}

async function approveReview(system: AgentSystem, approvalId: string, notes?: string, headers: Record<string, string> = {}) {
  return post(system, `/api/v1/approvals/${encodeURIComponent(approvalId)}/decide`, {
    decision: 'approved', actorId: 'synthetic-reviewer', actorRole: 'reviewer', ...(notes ? { notes } : {}),
  }, headers);
}

async function expectFailedRunArtifactsHidden(system: AgentSystem, runId: string) {
  const services = system.host.getServer()!.getServices();
  const retained = services.artifact.listArtifacts(runId);
  expect(retained.length).toBeGreaterThan(0);
  const artifact = retained.find((item) => item.path.endsWith('.docx'))!;
  const listing = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(runId)}`, { headers: requestHeaders(system) });
  expect(listing.status).toBe(200);
  expect((await listing.json()).data).not.toContainEqual(expect.objectContaining({ id: artifact.id }));
  const detail = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}`, { headers: requestHeaders(system) });
  const content = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, { headers: requestHeaders(system) });
  expect(detail.status).toBe(404);
  expect(content.status).toBe(404);
  const generatorListing = await fetch(`${system.baseURL}/api/v1/generator/artifacts`, { headers: requestHeaders(system) });
  expect(generatorListing.status).toBe(200);
  expect((await generatorListing.json()).data).not.toContainEqual(expect.objectContaining({ id: artifact.id }));
  expect(services.idempotency.getRecord(`req-${runId}`)?.status).not.toBe('completed');
}

function sendAndDisconnect(system: AgentSystem, body: unknown) {
  let resolveStatus!: (status: number | undefined) => void;
  let responseStatus: number | undefined;
  let resolved = false;
  const status = new Promise<number | undefined>((resolve) => { resolveStatus = resolve; });
  const finish = () => {
    if (!resolved) {
      resolved = true;
      resolveStatus(responseStatus);
    }
  };
  const address = new URL(system.baseURL);
  const req = http.request({
    hostname: address.hostname,
    port: Number(address.port),
    method: 'POST',
    path: '/api/v1/industrial/analysis-agent',
    headers: { ...requestHeaders(system), 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
  }, (res) => {
    responseStatus = res.statusCode;
    res.resume();
    res.once('end', finish);
  });
  req.on('error', finish);
  req.once('close', finish);
  req.end(JSON.stringify(body));
  return { disconnect: () => req.destroy(), status };
}

function telemetryReceiptFiles(root: string): string[] {
  const folder = path.join(root, '.maos', 'industrial', 'telemetry-analyses');
  return fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((name) => name.endsWith('.json')).map((name) => path.join(folder, name))
    : [];
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  for (const system of systems.splice(0)) {
    await system.host?.stop().catch(() => undefined);
    await system.model.close();
    fs.rmSync(system.root, { recursive: true, force: true });
  }
  for (const directory of extraDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('authenticated Industrial analysis agent HTTP integration', () => {
  it('uploads the selected CSV and links authenticated completion to replay evidence, report, and audit', async () => {
    const system = await createSystem();
    const upload = await post(system, '/api/v1/industrial/telemetry/analyze', {
      name: 'held-out-selected.csv',
      contentBase64: Buffer.from(CSV).toString('base64'),
    });
    expect(upload.status).toBe(201);
    const sourcePath = upload.payload.data.source.relativePath;
    expect(sourcePath).toContain('held-out-selected.csv');

    const audit = mockAudit(system);
    const requestText = 'Summarize these measured values and threshold crossings.';

    const result = await post(system, '/api/v1/industrial/analysis-agent', {
      request: requestText,
      sourcePath,
    });
    expect(result.status).toBe(200);
    expect(result.payload.data.requestedModel).toBe('configured-mock-model-v1');
    expect(result.payload.data.reportedModel).toBe('mock-returned-model-v2');
    expect(result.payload.data.evidence.source.selectedPath).toBe(sourcePath);
    expect(result.payload.data.evidence.verification.valid).toBe(true);
    expect(result.payload.data.evidence.verification.method).toBe('same-implementation-replay');
    expect(result.payload.data.explanation).toContain(result.payload.data.evidence.analysisId);
    const reportPath = path.join(system.root, result.payload.data.reportPath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.analysisId).toBe(result.payload.data.evidence.analysisId);
    expect(report.runId).toBe(result.payload.data.runId);
    expect(report.numericFindings.receiptPath).toBe(result.payload.data.evidence.receiptPath);
    expect(report.numericFindings.status).toBe('replay-matched');
    expect(report.numericFindings.verificationMethod).toBe('same-implementation-replay');
    expect(report.verification.method).toBe('same-implementation-replay');
    expect(report.explanation.status).toBe('unverified');
    expect(report.model).toEqual({ provider: 'mock', requested: 'configured-mock-model-v1', reported: 'mock-returned-model-v2' });
    const completionAudit = audit.events.find((event) => event.data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED');
    expect(result.payload.data.audit).toEqual({ sequence: audit.events.indexOf(completionAudit!), hash: 'c'.repeat(64) });
    expect(completionAudit).toMatchObject({ source: 'industrial-analysis-agent', category: 'stage' });
    expect(completionAudit!.data).toEqual({
      event: 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      runId: result.payload.data.runId,
      analysisId: result.payload.data.evidence.analysisId,
      sourceSha256: result.payload.data.evidence.source.sha256,
      receiptSha256: result.payload.data.evidence.receiptSha256,
      reportSha256: result.payload.data.reportSha256,
      outcome: 'completed',
    });
    expect(JSON.stringify(completionAudit!.data)).not.toContain(requestText);
    expect(system.model.requests).toHaveLength(2);
    expect(system.model.requests.every((request) => request.model === 'configured-mock-model-v1')).toBe(true);
    expect(system.model.requests.every((request) => request.max_tokens === 256)).toBe(true);
  });

  it('returns a structured initialization error before mock inference when the project config is absent', async () => {
    const system = await createSystem();
    fs.rmSync(path.join(system.root, '.maos', 'maos.config.json'));

    const result = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Review the selected synthetic CSV.',
      sourcePath: 'selected.csv',
    });

    expect(result.status).toBe(503);
    expect(result.payload.error).toMatchObject({
      code: 'PROJECT_NOT_INITIALIZED',
      message: expect.stringContaining('maos init'),
    });
    expect(system.model.requests).toHaveLength(0);
  });

  it('reports malformed analysis configuration instead of falling back to a provider', async () => {
    const system = await createSystem();
    const configPath = path.join(system.root, '.maos', 'maos.config.json');
    fs.writeFileSync(configPath, '{malformed json');

    const malformed = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Review the selected synthetic CSV.',
      sourcePath: 'selected.csv',
    });
    expect(malformed.status).toBe(503);
    expect(malformed.payload.error).toMatchObject({ code: 'PROJECT_CONFIG_INVALID' });
    expect(system.model.requests).toHaveLength(0);
  });

  it('surfaces config read failures without attempting mock inference', async () => {
    const system = await createSystem();
    const project = system.host.getServer()!.getServices().project;
    vi.spyOn(project, 'loadConfig').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    const result = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Review the selected synthetic CSV.',
      sourcePath: 'selected.csv',
    });

    expect(result.status).toBe(503);
    expect(result.payload.error).toMatchObject({ code: 'PROJECT_CONFIG_INVALID' });
    expect(result.payload.error.message).toContain('permissions');
    expect(system.model.requests).toHaveLength(0);
  });

  it('does not substitute another configured agent when ANALYST_AGENT lacks a provider', async () => {
    const system = await createSystem();
    const configPath = path.join(system.root, '.maos', 'maos.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.agents = [
      { id: 'ANALYST_AGENT', role: 'analyst', model: 'missing-provider-model' },
      { id: 'CODER_1', role: 'coder', provider: 'mock', model: 'must-not-be-used' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config));

    const result = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Review the selected synthetic CSV.',
      sourcePath: 'selected.csv',
    });

    expect(result.status).toBe(503);
    expect(result.payload.error).toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(system.model.requests).toHaveLength(0);
  });

  it('rejects missing/invalid sessions, wrong project identities, and wrong origins', async () => {
    const system = await createSystem();
    const payload = { request: 'Check it.', sourcePath: 'selected.csv' };
    const missing = await post(system, '/api/v1/industrial/analysis-agent', payload, { Authorization: '' });
    const invalid = await post(system, '/api/v1/industrial/analysis-agent', payload, { Authorization: `Bearer ${'0'.repeat(64)}` });
    const wrongProjectRoot = await post(system, '/api/v1/industrial/analysis-agent', payload, { 'X-Project-Root': path.join(system.root, 'wrong') });
    const wrongProjectId = await post(system, '/api/v1/industrial/analysis-agent', payload, { 'X-Project-ID': 'another-project' });
    const wrongOrigin = await post(system, '/api/v1/industrial/analysis-agent', payload, { Origin: 'http://127.0.0.1:41732' });
    const missingOriginHeaders = requestHeaders(system);
    delete missingOriginHeaders.Origin;
    const missingOriginResponse = await fetch(`${system.baseURL}/api/v1/industrial/analysis-agent`, {
      method: 'POST',
      headers: missingOriginHeaders,
      body: JSON.stringify(payload),
    });
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(wrongProjectRoot.status).toBe(400);
    expect(wrongProjectId.status).toBe(400);
    expect(wrongOrigin.status).toBe(403);
    expect(missingOriginResponse.status).toBe(403);
    expect(system.model.requests).toHaveLength(0);
  });

  it('allows the authenticated browser preflight headers used by the selected-project API client', async () => {
    const system = await createSystem();
    const response = await fetch(`${system.baseURL}/api/v1/industrial/analysis-agent`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-project-root,x-project-id,idempotency-key',
      },
    });
    const allowedHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() || '';
    expect(response.status).toBe(204);
    expect(allowedHeaders).toContain('x-project-id');
    expect(allowedHeaders).toContain('authorization');
    expect(system.model.requests).toHaveLength(0);
  });

  it('rejects traversal and a symlink/junction escape before contacting inference', async () => {
    const system = await createSystem();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-agent-outside-'));
    extraDirectories.push(outside);
    fs.writeFileSync(path.join(outside, 'outside.csv'), CSV);
    fs.symlinkSync(outside, path.join(system.root, 'escape-link'), 'junction');

    const traversal = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: '../outside.csv' });
    const symlink = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: 'escape-link/outside.csv' });
    const absolute = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: path.join(system.root, 'selected.csv') });
    expect(traversal.status).toBe(400);
    expect(symlink.status).toBe(400);
    expect(absolute.status).toBe(400);
    expect(system.model.requests).toHaveLength(0);
  });

  it('rejects attempts to analyze another file, unknown tools, and undeclared tool arguments without success', async () => {
    const system = await createSystem();
    system.model.behavior = { toolArguments: () => JSON.stringify({ sourcePath: 'other.csv' }) };
    const otherFile = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Analyze selected.csv.', sourcePath: 'selected.csv' });
    expect(otherFile.status).toBe(422);
    expect(telemetryReceiptFiles(system.root)).toHaveLength(0);

    system.model.requests.length = 0;
    system.model.behavior = { toolName: 'run_shell', toolArguments: () => JSON.stringify({ command: 'whoami' }) };
    const unknownTool = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Analyze selected.csv.', sourcePath: 'selected.csv' });
    expect(unknownTool.status).toBe(422);

    system.model.requests.length = 0;
    system.model.behavior = { toolArguments: () => JSON.stringify({ sourcePath: 'selected.csv', otherPath: 'other.csv' }) };
    const undeclaredArgument = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Analyze selected.csv.', sourcePath: 'selected.csv' });
    expect(undeclaredArgument.status).toBe(422);
    expect(telemetryReceiptFiles(system.root)).toHaveLength(0);
  });

  it('allows the authenticated caller to explicitly select another project-local CSV', async () => {
    const system = await createSystem();
    mockAudit(system);
    const result = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Analyze the other project CSV I selected.',
      sourcePath: 'other.csv',
    });

    expect(result.status).toBe(200);
    expect(result.payload.data.evidence.source.selectedPath).toBe('other.csv');
  });

  it('carries the accepted agent receipt through one persisted review, DOCX, artifact and audit run', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const analysis = await post(system, '/api/v1/industrial/analysis-agent', {
      request: 'Assess the selected synthetic CSV against the displayed demonstration rules.',
      sourcePath: 'selected.csv',
    });
    expect(analysis.status).toBe(200);

    const requestBody = { analysisId: analysis.payload.data.evidence.analysisId };
    const missingSession = await post(system, '/api/v1/industrial/judged-runs', requestBody, { Authorization: '' });
    const wrongProject = await post(system, '/api/v1/industrial/judged-runs', requestBody, { 'X-Project-ID': 'another-project' });
    const wrongOrigin = await post(system, '/api/v1/industrial/judged-runs', requestBody, { Origin: 'http://127.0.0.1:41732' });
    expect(missingSession.status).toBe(401);
    expect(wrongProject.status).toBe(400);
    expect(wrongOrigin.status).toBe(403);
    const prepared = await post(system, '/api/v1/industrial/judged-runs', requestBody);
    const duplicate = await post(system, '/api/v1/industrial/judged-runs', requestBody);
    expect(prepared.status, JSON.stringify(prepared.payload)).toBe(202);
    expect(prepared.payload.data.status).toBe('pending_approval');
    expect(prepared.payload.data.verdict).toBe('FAIL');
    expect(prepared.payload.data.details.engineeringVerdict).toBe('CRITICAL');
    expect(duplicate.payload.data.runId).toBe(prepared.payload.data.runId);
    expect(duplicate.payload.data.approvalId).toBe(prepared.payload.data.approvalId);

    const manifestResponse = await fetch(`${system.baseURL}/api/v1/industrial/judged-runs/${encodeURIComponent(prepared.payload.data.runId)}`, {
      headers: requestHeaders(system),
    });
    const manifestPayload = await manifestResponse.json();
    expect(manifestResponse.status).toBe(200);
    expect(manifestPayload.data.details.agentAnalysis).toMatchObject({
      analysisId: analysis.payload.data.evidence.analysisId,
      agentRunId: analysis.payload.data.runId,
      receiptSha256: analysis.payload.data.evidence.receiptSha256,
      explanationStatus: 'unverified',
    });
    expect(manifestPayload.data.sourceHashes['selected.csv']).toBe(analysis.payload.data.evidence.source.sha256);
    expect(manifestPayload.data.officeInput.proseBlocks[0]).toMatchObject({
      verifiedAgainstData: false,
      approvedByReviewer: false,
    });
    const unauthenticatedManifest = await fetch(`${system.baseURL}/api/v1/industrial/judged-runs/${encodeURIComponent(prepared.payload.data.runId)}`, {
      headers: requestHeaders(system, { Authorization: '' }),
    });
    const unauthenticatedApproval = await post(system, `/api/v1/approvals/${encodeURIComponent(prepared.payload.data.approvalId)}/decide`, {
      decision: 'approved', actorId: 'synthetic-reviewer', actorRole: 'reviewer',
    }, { Authorization: '' });
    expect(unauthenticatedManifest.status).toBe(401);
    expect(unauthenticatedApproval.status).toBe(401);

    const approval = await post(system, `/api/v1/approvals/${encodeURIComponent(prepared.payload.data.approvalId)}/decide`, {
      decision: 'approved',
      actorId: 'synthetic-reviewer',
      actorRole: 'reviewer',
      notes: 'Reviewed the replayed findings and unverified model explanation separately.',
    });
    expect(approval.status).toBe(200);
    expect(approval.payload.judgedRun.status).toBe('completed');
    expect(approval.payload.judgedRun.verdict).toBe('FAIL');
    expect(approval.payload.judgedRun.officeInput.proseBlocks[0]).toMatchObject({
      verifiedAgainstData: false,
      approvedByReviewer: true,
    });

    const artifactResponse = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(prepared.payload.data.runId)}`, {
      headers: requestHeaders(system),
    });
    const artifactPayload = await artifactResponse.json();
    expect(artifactResponse.status).toBe(200);
    const docx = artifactPayload.data.find((artifact: any) => artifact.path === approval.payload.judgedRun.deliverablePath);
    expect(docx).toBeDefined();
    expect(docx.runId).toBe(prepared.payload.data.runId);
    const unauthenticatedArtifacts = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(prepared.payload.data.runId)}`, {
      headers: requestHeaders(system, { Authorization: '' }),
    });
    const unauthenticatedDownload = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(docx.id)}/content`, {
      headers: requestHeaders(system, { Authorization: '' }),
    });
    expect(unauthenticatedArtifacts.status).toBe(401);
    expect(unauthenticatedDownload.status).toBe(401);
    const download = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(docx.id)}/content`, {
      headers: requestHeaders(system),
    });
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    expect(download.status).toBe(200);
    expect(downloadedBytes.subarray(0, 2).toString()).toBe('PK');
    expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe(approval.payload.judgedRun.deliverableSha256);

    const auditExport = await fetch(`${system.baseURL}/api/v1/audit/export`, { headers: requestHeaders(system) });
    const auditPayload = await auditExport.json();
    const finalAudit = auditPayload.data.records.find((record: any) => record.data.event === 'JUDGED_RUN_COMPLETED' && record.data.runId === prepared.payload.data.runId);
    expect(auditExport.status).toBe(200);
    expect(finalAudit.data).toMatchObject({
      analysisId: analysis.payload.data.evidence.analysisId,
      agentRunId: analysis.payload.data.runId,
      receiptSha256: analysis.payload.data.evidence.receiptSha256,
      verdict: 'FAIL',
      deliverableSha256: approval.payload.judgedRun.deliverableSha256,
    });
    const auditSnapshot = JSON.parse(fs.readFileSync(path.join(system.root, approval.payload.judgedRun.auditExportPath), 'utf8'));
    expect(auditSnapshot.verification.recordCount).toBe(approval.payload.judgedRun.auditExportThroughSequence + 1);
    expect(auditSnapshot.records.some((record: any) => record.data.event === 'DOCX_GENERATED' && record.data.runId === prepared.payload.data.runId)).toBe(true);
    expect(auditSnapshot.records.some((record: any) => record.data.event === 'JUDGED_RUN_COMPLETED' && record.data.runId === prepared.payload.data.runId)).toBe(false);
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toHaveLength(1);
  });

  it('keeps blank reviewer notes neutral for a selected non-T-07 CSV', async () => {
    const system = await createSystem();
    mockAudit(system);
    const { analysis, prepared } = await prepareReview(system);
    const approved = await approveReview(system, prepared.payload.data.approvalId);
    expect(approved.status).toBe(200);
    expect(approved.payload.judgedRun.officeInput.evidenceState.reviewerNotes).toBeUndefined();
    expect(approved.payload.judgedRun.officeInput.approval.comment).toBeUndefined();
    expect(approved.payload.judgedRun.details.agentAnalysis.sourcePath).toBe('selected.csv');
    const artifact = system.host.getServer()!.getServices().artifact.listArtifacts(prepared.payload.data.runId)[0];
    const response = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, { headers: requestHeaders(system) });
    expect(response.status).toBe(200);
    const documentXml = parseZipArchive(Buffer.from(await response.arrayBuffer())).get('word/document.xml')!.toString('utf8');
    expect(documentXml).toContain('System note: No reviewer comment provided.');
    expect(documentXml).not.toContain('T-07');
    expect(documentXml).not.toContain('Approved after reviewing');
    expect(analysis.payload.data.reportPath).toContain(analysis.payload.data.evidence.analysisId);
  });

  it('fails closed when DOCX_GENERATED audit persistence fails after artifact registration', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const idempotencyKey = 'review-docx-audit-failure';
    audit.failNextEvent('DOCX_GENERATED');
    const decision = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': idempotencyKey });
    expect(decision.status).toBe(503);
    const manifest = JSON.parse(fs.readFileSync(path.join(system.root, '.maos', 'industrial-runs', `${prepared.payload.data.runId}.json`), 'utf8'));
    expect(manifest).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('DOCX_GENERATED') });
    expect(manifest.deliverablePath).toBeUndefined();
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toBe(false);
    expect(system.host.getServer()!.getServices().idempotency.getRecord(idempotencyKey)?.status).toBe('failed');
    const retry = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': idempotencyKey });
    expect(retry.status).toBe(409);
    expect(retry.payload.error.code).toBe('IDEMPOTENCY_FAILED');
    await expectFailedRunArtifactsHidden(system, prepared.payload.data.runId);
  });

  it('fails closed on audit-export failure and rejects retry after service restart', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { analysis, prepared } = await prepareReview(system);
    audit.failNextExport();
    const decision = await approveReview(system, prepared.payload.data.approvalId);
    expect(decision.status).toBeGreaterThanOrEqual(500);
    const manifestPath = path.join(system.root, '.maos', 'industrial-runs', `${prepared.payload.data.runId}.json`);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status).toBe('failed');
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toBe(false);

    const restarted = await system.host.restart(0);
    system.baseURL = `http://127.0.0.1:${restarted.port}`;
    system.token = system.host.createSession('agent-auth-http-test-restarted').token;
    const retry = await post(system, '/api/v1/industrial/judged-runs', { analysisId: analysis.payload.data.evidence.analysisId });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    await expectFailedRunArtifactsHidden(system, prepared.payload.data.runId);
  });

  it('fails closed when the completed manifest replacement fails after export', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const manifestPath = path.join(system.root, '.maos', 'industrial-runs', `${prepared.payload.data.runId}.json`);
    const realRename = fsDefault.renameSync.bind(fsDefault);
    let failedCompletedWrite = false;
    const renameSpy = vi.spyOn(fsDefault, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (!failedCompletedWrite && String(destination) === manifestPath && fs.existsSync(String(source))) {
        const pending = JSON.parse(fs.readFileSync(String(source), 'utf8'));
        if (pending.status === 'completed') {
          failedCompletedWrite = true;
          throw new Error('simulated completed-manifest persistence failure');
        }
      }
      return realRename(source, destination);
    }) as typeof fs.renameSync);
    try {
      const decision = await approveReview(system, prepared.payload.data.approvalId);
      expect(decision.status).toBeGreaterThanOrEqual(500);
      expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('completed-manifest') });
      expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toBe(false);
      await expectFailedRunArtifactsHidden(system, prepared.payload.data.runId);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('accepts a completion audit append that persisted before its call failed and does not duplicate it on resume', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    audit.failNextEvent('JUDGED_RUN_COMPLETED', true);
    const decision = await approveReview(system, prepared.payload.data.approvalId);
    expect(decision.status).toBe(200);
    expect(decision.payload.judgedRun.status).toBe('completed');
    const services = system.host.getServer()!.getServices();
    await expect(resumeJudgedRunAfterApproval(system.root, services, prepared.payload.data.approvalId)).resolves.toMatchObject({ status: 'completed' });
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toHaveLength(1);
    const artifactResponse = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(prepared.payload.data.runId)}`, { headers: requestHeaders(system) });
    expect(artifactResponse.status).toBe(200);
    const artifact = (await artifactResponse.json()).data[0];
    const download = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, { headers: requestHeaders(system) });
    expect(download.status).toBe(200);
  });

  it('serializes approval finalization against preparation and duplicate requests with all idempotency-key forms', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { analysis, prepared } = await prepareReview(system);
    const services = system.host.getServer()!.getServices();
    const entered = deferred();
    const release = deferred();
    const generator = services.docxGenerator;
    const generate = generator.generateDocxAsync.bind(generator);
    vi.spyOn(generator, 'generateDocxAsync').mockImplementation(async (params: any) => {
      entered.resolve();
      await release.promise;
      return generate(params);
    });

    const first = approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': 'finalize-equal-key' });
    await entered.promise;

    const equalKey = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': 'finalize-equal-key' });
    const busyKey = 'finalize-different-key';
    const differentKey = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': busyKey });
    const noKey = await approveReview(system, prepared.payload.data.approvalId);
    const preparation = await post(system, '/api/v1/industrial/judged-runs', { analysisId: analysis.payload.data.evidence.analysisId });

    expect(equalKey.status).toBe(409);
    expect(equalKey.payload.error.code).toBe('CONCURRENT_MUTATION');
    expect(differentKey.status).toBe(409);
    expect(differentKey.payload.error.code).toBe('JUDGED_RUN_BUSY');
    expect(noKey.status).toBe(409);
    expect(noKey.payload.error.code).toBe('JUDGED_RUN_BUSY');
    expect(preparation.status).toBe(409);
    expect(preparation.payload.error.code).toBe('JUDGED_RUN_BUSY');
    expect(readJudgedRunManifest(system.root, prepared.payload.data.runId)?.status).toBe('finalizing');
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_FAILED')).toBe(false);

    release.resolve();
    const finalized = await first;
    expect(finalized.status).toBe(200);
    const sameBusyKeyRetry = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': busyKey });
    const sameKeyReplay = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': 'finalize-equal-key' });
    const newKeyReplay = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': 'finalize-after-busy-key' });
    const noKeyReplay = await approveReview(system, prepared.payload.data.approvalId);
    expect(sameBusyKeyRetry.status).toBe(200);
    expect(sameKeyReplay.status).toBe(200);
    expect(newKeyReplay.status).toBe(200);
    expect(noKeyReplay.status).toBe(200);
    const finalManifest = readJudgedRunManifest(system.root, prepared.payload.data.runId)!;
    expect(finalManifest.status).toBe('completed');
    expect(services.artifact.listArtifacts(prepared.payload.data.runId)).toHaveLength(1);
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === prepared.payload.data.runId)).toHaveLength(1);
    expect(isAcceptedJudgedRun(system.root, services, finalManifest)).toBe(true);
    const listing = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(prepared.payload.data.runId)}`, { headers: requestHeaders(system) });
    const listed = await listing.json();
    expect(listing.status).toBe(200);
    expect(listed.data).toHaveLength(1);
    const download = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(listed.data[0].id)}/content`, { headers: requestHeaders(system) });
    expect(download.status).toBe(200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.subarray(0, 2).toString()).toBe('PK');
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(finalManifest.deliverableSha256);
  });

  it('keeps concurrent recovery single-terminal and retries only the accepted persisted attempt', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const approved = await approveReview(system, prepared.payload.data.approvalId);
    expect(approved.status).toBe(200);

    const runId = prepared.payload.data.runId;
    const completedIndex = audit.events.findIndex((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === runId);
    audit.events.splice(completedIndex, 1);
    const manifestPath = path.join(system.root, '.maos', 'industrial-runs', `${runId}.json`);
    const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    interrupted.status = 'finalizing';
    fs.writeFileSync(manifestPath, JSON.stringify(interrupted, null, 2));

    const services = system.host.getServer()!.getServices();
    const recoveries = await Promise.allSettled([
      resumeJudgedRunAfterApproval(system.root, services, prepared.payload.data.approvalId),
      resumeJudgedRunAfterApproval(system.root, services, prepared.payload.data.approvalId),
    ]);
    expect(recoveries.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(recoveries.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = recoveries.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as any).code).toBe('JUDGED_RUN_BUSY');
    await expect(resumeJudgedRunAfterApproval(system.root, services, prepared.payload.data.approvalId)).resolves.toMatchObject({ status: 'completed' });
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === runId)).toHaveLength(1);
    expect(services.artifact.listArtifacts(runId)).toHaveLength(1);
    expect(readJudgedRunManifest(system.root, runId)?.status).toBe('completed');
  });

  it('rejects acceptance when a completed attempt has contradictory terminal audit history', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const approved = await approveReview(system, prepared.payload.data.approvalId);
    expect(approved.status).toBe(200);
    const runId = prepared.payload.data.runId;
    const services = system.host.getServer()!.getServices();
    const manifest = readJudgedRunManifest(system.root, runId)!;
    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(true);

    services.audit.recordAuditEvent({
      category: 'stage',
      source: 'test-injected-history',
      data: { event: 'JUDGED_RUN_FAILED', runId, attempt: 1, approvalId: manifest.approvalId, reason: 'contradiction injection' },
    });

    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(false);
    const listing = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(runId)}`, { headers: requestHeaders(system) });
    expect(listing.status).toBe(200);
    expect((await listing.json()).data).toHaveLength(0);
    const artifact = services.artifact.listArtifacts(runId)[0];
    const content = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, { headers: requestHeaders(system) });
    expect(content.status).toBe(404);
    expect(audit.events.filter((event) => ['JUDGED_RUN_COMPLETED', 'JUDGED_RUN_FAILED', 'JUDGED_RUN_REJECTED'].includes(String(event.data.event)) && event.data.runId === runId)).toHaveLength(2);
  });

  it('does not accept or expose output when finalization fails after a competing request receives busy', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const services = system.host.getServer()!.getServices();
    const entered = deferred();
    const release = deferred();
    const generator = services.docxGenerator;
    const generate = generator.generateDocxAsync.bind(generator);
    vi.spyOn(generator, 'generateDocxAsync').mockImplementation(async (params: any) => {
      entered.resolve();
      await release.promise;
      await generate(params);
      throw Object.assign(new Error('simulated caller cancellation after generation'), { name: 'AbortError' });
    });

    const first = approveReview(system, prepared.payload.data.approvalId);
    await entered.promise;
    const competing = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': 'cancel-competitor' });
    expect(competing.status).toBe(409);
    expect(competing.payload.error.code).toBe('JUDGED_RUN_BUSY');
    release.resolve();
    const canceled = await first;
    expect(canceled.status).toBeGreaterThanOrEqual(500);
    expect(readJudgedRunManifest(system.root, prepared.payload.data.runId)?.status).toBe('failed');
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === prepared.payload.data.runId)).toHaveLength(0);
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_FAILED' && event.data.runId === prepared.payload.data.runId)).toHaveLength(1);
    await expectFailedRunArtifactsHidden(system, prepared.payload.data.runId);
  });

  it('reconciles a restart after the export and finalizing manifest are durable but before the terminal audit append', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { analysis, prepared } = await prepareReview(system);
    const approved = await approveReview(system, prepared.payload.data.approvalId);
    expect(approved.status).toBe(200);
    const runId = prepared.payload.data.runId;
    audit.events.splice(audit.events.findIndex((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === runId), 1);
    const manifestPath = path.join(system.root, '.maos', 'industrial-runs', `${runId}.json`);
    const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    interrupted.status = 'finalizing';
    fs.writeFileSync(manifestPath, JSON.stringify(interrupted, null, 2));

    const resumed = await post(system, '/api/v1/industrial/judged-runs', { analysisId: analysis.payload.data.evidence.analysisId });
    expect(resumed.status).toBe(200);
    expect(resumed.payload.data.status).toBe('completed');
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === runId)).toHaveLength(1);
    const artifacts = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(runId)}`, { headers: requestHeaders(system) });
    expect(artifacts.status).toBe(200);
    expect((await artifacts.json()).data).toHaveLength(1);
  });

  it.each(['selected source', 'ruleset', 'report payload'])('rejects approval after the %s changes', async (changedPart) => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const analysis = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Review this source.', sourcePath: 'selected.csv' });
    const prepared = await post(system, '/api/v1/industrial/judged-runs', { analysisId: analysis.payload.data.evidence.analysisId });
    expect(prepared.status).toBe(202);

    const manifestPath = path.join(system.root, '.maos', 'industrial-runs', `${prepared.payload.data.runId}.json`);
    if (changedPart === 'selected source') {
      fs.writeFileSync(path.join(system.root, 'selected.csv'), CSV.replace(',7.4,96', ',1.1,66'));
    } else if (changedPart === 'ruleset') {
      const rulesPath = path.join(system.root, 'demo', 'industrial', 'safety_thresholds.json');
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      rules.thresholds.vibration_rms_mm_s.critical += 1;
      fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.officeInput.sections[0].content += ' changed after review preparation';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    const decision = await post(system, `/api/v1/approvals/${encodeURIComponent(prepared.payload.data.approvalId)}/decide`, {
      decision: 'approved', actorId: 'synthetic-reviewer', actorRole: 'reviewer', notes: 'Attempt stale approval.',
    });
    expect(decision.status).toBe(409);
    expect(decision.payload.error.code).toBe('STALE_APPROVAL');
    const failedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(failedManifest.status).toBe('failed');
    expect(failedManifest.deliverablePath).toBeUndefined();
    const failedAudit = audit.events.find((event) => event.data.event === 'JUDGED_RUN_FAILED' && event.data.runId === prepared.payload.data.runId);
    expect(failedAudit?.data).toMatchObject({ analysisId: analysis.payload.data.evidence.analysisId, receiptSha256: analysis.payload.data.evidence.receiptSha256 });
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toBe(false);
    expect(system.host.getServer()!.getServices().artifact.listArtifacts(prepared.payload.data.runId)).toHaveLength(0);
  });

  it('keeps a rejected agent review from creating a DOCX or completed audit event', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const analysis = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Review this source.', sourcePath: 'selected.csv' });
    const prepared = await post(system, '/api/v1/industrial/judged-runs', { analysisId: analysis.payload.data.evidence.analysisId });
    const decision = await post(system, `/api/v1/approvals/${encodeURIComponent(prepared.payload.data.approvalId)}/decide`, {
      decision: 'rejected', actorId: 'synthetic-reviewer', actorRole: 'reviewer', notes: 'Reject this synthetic report.',
    });

    expect(decision.status).toBe(200);
    expect(decision.payload.judgedRun.status).toBe('rejected');
    expect(decision.payload.judgedRun.deliverablePath).toBeUndefined();
    const rejectedAudit = audit.events.find((event) => event.data.event === 'JUDGED_RUN_REJECTED' && event.data.runId === prepared.payload.data.runId);
    expect(rejectedAudit?.data).toMatchObject({ analysisId: analysis.payload.data.evidence.analysisId, receiptSha256: analysis.payload.data.evidence.receiptSha256 });
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_COMPLETED')).toBe(false);
    expect(system.host.getServer()!.getServices().artifact.listArtifacts(prepared.payload.data.runId)).toHaveLength(0);
  });

  it('does not cancel a valid request when the ordinary request body ends', async () => {
    const system = await createSystem();
    mockAudit(system);
    const result = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: 'selected.csv' });
    expect(result.status).toBe(200);
    expect(result.payload.data.evidence.verification.valid).toBe(true);
  });

  it('fails closed when the completion audit append fails', async () => {
    const system = await createSystem();
    const auditAttempts: AuditEventParams[] = [];
    vi.spyOn(system.host.getServer()!.getServices().audit, 'recordAuditEvent')
      .mockImplementation((params) => {
        auditAttempts.push(params);
        if (params.data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED') throw new Error('simulated audit chain failure');
        return makeAuditRecord(params, auditAttempts.length - 1);
      });
    const result = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: 'selected.csv' });
    const reportRoot = path.join(system.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports');

    expect(result.status).toBe(503);
    expect(result.payload.error.code).toBe('AUDIT_PERSISTENCE_FAILED');
    expect(result.payload.data).toBeUndefined();
    expect(auditAttempts.some((event) => event.data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED')).toBe(true);
    const reportFiles = fs.readdirSync(reportRoot).filter((name) => name.endsWith('.json'));
    expect(reportFiles).toHaveLength(1);
    const reportPath = path.join(reportRoot, reportFiles[0]);
    const failedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(failedReport).toMatchObject({
      status: 'failed',
      acceptance: 'unaccepted',
      failure: { code: 'AUDIT_PERSISTENCE_FAILED' },
    });

    const artifacts = await fetch(`${system.baseURL}/api/v1/artifacts`, {
      headers: requestHeaders(system),
    });
    const artifactPayload = await artifacts.json();
    expect(artifacts.status).toBe(200);
    expect(JSON.stringify(artifactPayload.data)).not.toContain('agent-reports');
    const reportRelativePath = path.relative(system.root, reportPath).split(path.sep).join('/');
    const download = await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(reportRelativePath)}/content`, {
      headers: requestHeaders(system),
    });
    expect(download.status).toBe(404);
  });

  it('cancels an actual disconnected client before the model requests the analysis tool', async () => {
    const system = await createSystem({ modelTimeoutMs: 4000 });
    system.model.behavior = { firstDelayMs: 1500 };
    const request = sendAndDisconnect(system, { request: 'Check it.', sourcePath: 'selected.csv' });
    await system.model.waitForRequest(1);
    request.disconnect();
    await system.model.waitForResponseClose(1);
    expect(await request.status).not.toBe(200);
    expect(telemetryReceiptFiles(system.root)).toHaveLength(0);
  });

  it('cancels an actual disconnected client after the tool ran and does not return success', async () => {
    const system = await createSystem({ modelTimeoutMs: 4000 });
    system.model.behavior = { secondDelayMs: 1500 };
    const request = sendAndDisconnect(system, { request: 'Check it.', sourcePath: 'selected.csv' });
    await system.model.waitForRequest(2);
    expect(telemetryReceiptFiles(system.root)).toHaveLength(1);
    request.disconnect();
    await system.model.waitForResponseClose(2);
    expect(await request.status).not.toBe(200);
    expect(fs.existsSync(path.join(system.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports'))).toBe(false);
  });

  it('returns failure after a model timeout before the tool call', async () => {
    const system = await createSystem({ modelTimeoutMs: 120 });
    system.model.behavior = { firstDelayMs: 600 };
    const result = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: 'selected.csv' });
    expect(result.status).toBe(502);
    expect(result.payload.error.code).toBe('AGENT_EXECUTION_FAILED');
    expect(telemetryReceiptFiles(system.root)).toHaveLength(0);
  });

  it('returns failure when inference times out after tool execution, despite a persisted receipt', async () => {
    const system = await createSystem({ modelTimeoutMs: 120 });
    system.model.behavior = { hangSecond: true };
    const result = await post(system, '/api/v1/industrial/analysis-agent', { request: 'Check it.', sourcePath: 'selected.csv' });
    expect(result.status).toBe(502);
    expect(result.payload.error.code).toBe('AGENT_EXECUTION_FAILED');
    expect(telemetryReceiptFiles(system.root)).toHaveLength(1);
    expect(fs.existsSync(path.join(system.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports'))).toBe(false);
  });

  it('refuses destructive reset while DOCX finalization is active', async () => {
    const system = await createSystem();
    mockAudit(system);
    const { prepared } = await prepareReview(system);
    const services = system.host.getServer()!.getServices();
    const entered = deferred<void>();
    const release = deferred<void>();
    const generate = services.docxGenerator.generateDocxAsync.bind(services.docxGenerator);
    vi.spyOn(services.docxGenerator, 'generateDocxAsync').mockImplementation(async (params: any) => {
      entered.resolve();
      await release.promise;
      return generate(params);
    });

    const finalization = approveReview(system, prepared.payload.data.approvalId);
    await entered.promise;
    await expect(executeDeterministicReset({
      projectRoot: system.root,
      categories: ['output'],
      runId: prepared.payload.data.runId,
      dryRun: false,
      confirmed: true,
      auditService: services.audit,
    })).rejects.toMatchObject({ code: 'JUDGED_RUN_BUSY' });
    expect(readJudgedRunManifest(system.root, prepared.payload.data.runId)?.status).toBe('finalizing');
    expect(services.artifact.listArtifacts(prepared.payload.data.runId)).toHaveLength(0);

    release.resolve();
    expect((await finalization).status).toBe(200);
    const manifest = readJudgedRunManifest(system.root, prepared.payload.data.runId)!;
    expect(manifest.status).toBe('completed');
    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(true);
    expect(services.artifact.listArtifacts(prepared.payload.data.runId)).toHaveLength(1);
  });

  it('blocks a separate CLI reset process between terminal audit append and acceptance', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    let childResult: ReturnType<typeof resetCliFromChild> | undefined;
    audit.onRecord((event) => {
      if (event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === prepared.payload.data.runId) {
        expect(readJudgedRunManifest(system.root, prepared.payload.data.runId)?.status).toBe('completed');
        childResult = resetCliFromChild(system.root, prepared.payload.data.runId);
      }
    });

    const approved = await approveReview(system, prepared.payload.data.approvalId);
    expect(approved.status).toBe(200);
    expect(childResult?.exitCode).toBe(INDUSTRIAL_CLI_EXIT.RESET_FAILED);
    expect(childResult?.result.message).toContain('Reset busy:');
    const services = system.host.getServer()!.getServices();
    const manifest = readJudgedRunManifest(system.root, prepared.payload.data.runId)!;
    expect(manifest.status).toBe('completed');
    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(true);
    expect(services.artifact.listArtifacts(manifest.runId)).toHaveLength(1);
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === manifest.runId)).toHaveLength(1);
  });

  it.each(['selected source mutation', 'output corruption'] as const)('invalidates a successful start replay after %s without rerunning work', async (mutation) => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { analysis, prepared } = await prepareReview(system);
    expect((await approveReview(system, prepared.payload.data.approvalId)).status).toBe(200);
    const startBody = { analysisId: analysis.payload.data.evidence.analysisId };
    const key = `completed-start-${mutation.replaceAll(' ', '-')}`;
    const start = await post(system, '/api/v1/industrial/judged-runs', startBody, { 'Idempotency-Key': key });
    expect(start.status).toBe(200);
    expect(start.payload.data).toMatchObject({ success: true, status: 'completed' });
    expect((await post(system, '/api/v1/industrial/judged-runs', startBody, { 'Idempotency-Key': key })).status).toBe(200);

    const services = system.host.getServer()!.getServices();
    const manifest = readJudgedRunManifest(system.root, prepared.payload.data.runId)!;
    if (mutation === 'selected source mutation') {
      fs.writeFileSync(path.join(system.root, 'selected.csv'), CSV.replace(',7.4,96', ',1.1,66'));
    } else {
      fs.writeFileSync(path.join(system.root, manifest.deliverablePath!), 'corrupted after acceptance');
    }

    const replay = await post(system, '/api/v1/industrial/judged-runs', startBody, { 'Idempotency-Key': key });
    expect(replay.status).toBe(409);
    expect(replay.payload.error.code).toBe('JUDGED_RUN_NOT_ACCEPTED');
    expect(services.idempotency.getRecord(key)?.status).toBe('completed');
    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(false);
    expect(services.artifact.listArtifacts(manifest.runId)).toHaveLength(1);
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === manifest.runId)).toHaveLength(1);
    expect(system.model.requests).toHaveLength(2);
  });

  it('marks completed output unavailable after authorized reset and preserves the historical replay record', async () => {
    const system = await createSystem();
    const audit = mockAudit(system);
    const { prepared } = await prepareReview(system);
    const key = 'accepted-approval-reset-replay';
    expect((await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key })).status).toBe(200);
    expect((await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key })).status).toBe(200);

    const services = system.host.getServer()!.getServices();
    const manifest = readJudgedRunManifest(system.root, prepared.payload.data.runId)!;
    const artifact = services.artifact.listArtifacts(manifest.runId)[0];
    expect(artifact).toBeDefined();
    const reset = await executeDeterministicReset({
      projectRoot: system.root,
      categories: ['output'],
      runId: manifest.runId,
      dryRun: false,
      confirmed: true,
      auditService: services.audit,
    });
    expect(reset.success).toBe(true);
    expect(reset.removedFiles.map((file) => file.relativePath)).toContain(manifest.deliverablePath);
    expect(readJudgedRunManifest(system.root, manifest.runId)?.status).toBe('completed');
    expect(isAcceptedJudgedRun(system.root, services, manifest)).toBe(false);

    const listing = await fetch(`${system.baseURL}/api/v1/artifacts?runId=${encodeURIComponent(manifest.runId)}`, { headers: requestHeaders(system) });
    expect(listing.status).toBe(200);
    expect((await listing.json()).data).toHaveLength(0);
    const generatorListing = await fetch(`${system.baseURL}/api/v1/generator/artifacts`, { headers: requestHeaders(system) });
    expect(generatorListing.status).toBe(200);
    expect((await generatorListing.json()).data).not.toContainEqual(expect.objectContaining({ id: artifact.id }));
    expect((await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}`, { headers: requestHeaders(system) })).status).toBe(404);
    expect((await fetch(`${system.baseURL}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, { headers: requestHeaders(system) })).status).toBe(404);
    expect((await fetch(`${system.baseURL}/api/v1/industrial/judged-runs/${encodeURIComponent(manifest.runId)}`, { headers: requestHeaders(system) })).status).toBe(409);

    const staleReplay = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key });
    expect(staleReplay.status).toBe(409);
    expect(staleReplay.payload.error.code).toBe('JUDGED_RUN_NOT_ACCEPTED');
    expect(services.idempotency.getRecord(key)?.status).toBe('completed');
    expect(audit.events.filter((event) => event.data.event === 'JUDGED_RUN_COMPLETED' && event.data.runId === manifest.runId)).toHaveLength(1);
    expect(audit.events.some((event) => event.data.event === 'JUDGED_RUN_FAILED' && event.data.runId === manifest.runId)).toBe(false);
    expect(audit.events.some((event) => event.data.event === 'DETERMINISTIC_RESET_EXECUTED' && event.data.runId === manifest.runId)).toBe(true);
  });

  it('keeps a successful replay record intact while reset and replay contend across service and CLI processes', async () => {
    const system = await createSystem();
    mockAudit(system);
    const { prepared } = await prepareReview(system);
    const key = 'accepted-approval-reset-race';
    expect((await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key })).status).toBe(200);

    const resetChild = startPausedResetCli(system.root, prepared.payload.data.runId);
    try {
      await resetChild.waitForMarker('reset-lock-held');
      const busyReplay = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key });
      expect(busyReplay.status).toBe(409);
      expect(busyReplay.payload.error.code).toBe('JUDGED_RUN_BUSY');
      expect(system.host.getServer()!.getServices().idempotency.getRecord(key)?.status).toBe('completed');
      resetChild.release();
      expect(await resetChild.waitForExit()).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      const resetResultLine = resetChild.output().split(/\r?\n/).find((line) => line.startsWith('{'));
      expect(resetResultLine).toBeDefined();
      const resetResult = JSON.parse(resetResultLine!);
      expect(resetResult.data.success).toBe(true);
      const staleReplay = await approveReview(system, prepared.payload.data.approvalId, undefined, { 'Idempotency-Key': key });
      expect(staleReplay.status).toBe(409);
      expect(staleReplay.payload.error.code).toBe('JUDGED_RUN_NOT_ACCEPTED');
      expect(system.host.getServer()!.getServices().idempotency.getRecord(key)?.status).toBe('completed');
    } finally {
      resetChild.release();
      if (resetChild.child.exitCode === null) await resetChild.waitForExit();
    }
  });

  it('serializes a T-07 API attempt behind output work and reports an unavailable verdict', async () => {
    const system = await createSystem();
    mockAudit(system);
    const response = await withJudgedRunOutputLock(system.root, () =>
      post(system, '/api/v1/industrial/judged-runs', {}));
    expect(response.status).toBe(409);
    expect(response.payload.error).toMatchObject({
      code: 'JUDGED_RUN_BUSY',
      details: {
        runId: expect.any(String),
        status: 'in_progress',
        verdict: 'UNAVAILABLE',
        executionErrorCode: 'JUDGED_RUN_BUSY',
      },
    });
    expect(response.payload.error.details.verdict).not.toBe('FAIL');
  });

  it('returns a structured unavailable verdict when the coordination lock cannot be created', async () => {
    const system = await createSystem();
    mockAudit(system);
    const lockDirectory = path.join(system.root, '.maos', 'industrial-runs');
    const movedLockDirectory = `${lockDirectory}.test-backup`;
    if (fs.existsSync(movedLockDirectory)) fs.rmSync(movedLockDirectory, { recursive: true, force: true });
    if (fs.existsSync(lockDirectory)) fs.renameSync(lockDirectory, movedLockDirectory);
    fs.writeFileSync(lockDirectory, 'blocks directory creation');

    try {
      const response = await post(system, '/api/v1/industrial/judged-runs', {});
      expect(response.status).toBe(503);
      expect(response.payload.error).toMatchObject({
        code: 'JUDGED_RUN_LOCK_UNAVAILABLE',
        details: {
          runId: expect.any(String),
          status: 'unavailable',
          verdict: 'UNAVAILABLE',
          executionErrorCode: 'JUDGED_RUN_LOCK_UNAVAILABLE',
        },
      });
      expect(response.payload.error.details.verdict).not.toBe('FAIL');
    } finally {
      fs.unlinkSync(lockDirectory);
      if (fs.existsSync(movedLockDirectory)) fs.renameSync(movedLockDirectory, lockDirectory);
    }
  });

  it('disables the route on the legacy authentication-optional REST server', async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-agent-legacy-rest-'));
    extraDirectories.push(legacyRoot);
    fs.mkdirSync(path.join(legacyRoot, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, '.maos', 'maos.config.json'), JSON.stringify({ projectName: 'legacy-route-test' }));
    const legacy = new RestApiServer(legacyRoot, { host: '127.0.0.1', port: 0, authEnabled: false });
    const port = await legacy.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/industrial/analysis-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ request: 'Check it.', sourcePath: 'selected.csv' }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('AUTHENTICATED_HOST_REQUIRED');
    } finally {
      await legacy.stop();
    }
  });
});
