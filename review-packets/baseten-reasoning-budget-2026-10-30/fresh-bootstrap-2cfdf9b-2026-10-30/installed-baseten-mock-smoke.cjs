'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServiceContainer } = require(path.join(process.argv[2], 'dist', 'service', 'index.js'));
const { BASETEN_API_BASE_URL, BASETEN_API_MODEL } = require(path.join(process.argv[2], 'dist', 'backends', 'meta-api-policy.js'));

const appRoot = path.resolve(process.argv[2]);
const syntheticRoot = path.resolve(process.argv[3]);
const apiKey = 'synthetic-installed-baseten-smoke-key-not-real';
const privateReasoning = 'SYNTHETIC_INSTALLED_PRIVATE_REASONING_NOT_FOR_STORAGE';
const runs = [];
const servers = [];
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const consoleLines = [];

function completion(toolName, args, options = {}) {
  return {
    id: 'chatcmpl-installed-smoke',
    object: 'chat.completion',
    created: 1,
    model: options.model ?? BASETEN_API_MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: options.content === undefined ? null : options.content,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.reasoning_content === undefined ? {} : { reasoning_content: options.reasoning_content }),
        ...(options.omitToolCalls ? {} : {
          tool_calls: options.toolCalls || [{
            id: 'call-installed-smoke',
            type: 'function',
            function: { name: toolName, arguments: args },
          }],
        }),
      },
      finish_reason: options.finishReason ?? 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

function makeProject(label) {
  const root = fs.mkdtempSync(path.join(syntheticRoot, `${label}-`));
  const engineSource = process.env.MAOS_TEST_ENGINE_PATH;
  if (engineSource) {
    const enginePath = path.join(root, 'rust', 'target', 'release', `maos-engine${process.platform === 'win32' ? '.exe' : ''}`);
    fs.mkdirSync(path.dirname(enginePath), { recursive: true });
    fs.copyFileSync(engineSource, enginePath);
  }
  fs.mkdirSync(path.join(root, '.maos', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  fs.mkdirSync(path.join(root, 'commissioning'), { recursive: true });
  fs.copyFileSync(
    path.join(appRoot, 'demo', 'industrial', 'safety_thresholds.json'),
    path.join(root, 'demo', 'industrial', 'safety_thresholds.json'),
  );
  fs.writeFileSync(path.join(root, 'commissioning', 'bearing-ramp.csv'), [
    'timestamp,vibration_rms_mm_s,bearing_temperature_c',
    '2026-02-11T08:00:00Z,1.2,70',
    '2026-02-11T08:01:00Z,4.8,88',
    '2026-02-11T08:02:00Z,8.2,96',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: `installed-${label}`,
    providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
    agents: [{
      id: 'ANALYST_AGENT', role: 'synthetic installed smoke', provider: 'baseten', model: BASETEN_API_MODEL,
      timeoutMs: 60_000, capabilities: ['analysis'], scope: ['.'],
    }],
    routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'baseten' },
  }, null, 2));
  return { root, sourcePath: 'commissioning/bearing-ramp.csv' };
}

async function startMock(handler) {
  const requests = [];
  const waiters = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
      requests.push({ body, authorization: request.headers.authorization, path: request.url });
      waiters.splice(0).forEach((resolve) => resolve());
      try {
        const action = await handler(body, requests.length);
        if (action.hang || response.destroyed) return;
        response.writeHead(action.status ?? 200, { 'content-type': 'application/json', ...(action.headers || {}) });
        response.end(JSON.stringify(action.body));
      } catch {
        if (!response.destroyed) response.writeHead(500).end();
      }
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    server,
    requests,
    baseURL: `http://127.0.0.1:${port}/v1`,
    waitForRequest: async () => {
      if (requests.length) return;
      await new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function installLocalOnlyBridge(mock, expectedURL = `${BASETEN_API_BASE_URL}/chat/completions`) {
  const nativeFetch = originalFetch.bind(globalThis);
  const outbound = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url !== expectedURL) throw new Error('SMOKE_BLOCKED_UNEXPECTED_OUTBOUND_URL');
    const authorization = new Headers(init.headers).get('authorization');
    const observation = {
      url,
      redirect: init.redirect,
      authorizationMatchesSyntheticKey: authorization === `Bearer ${apiKey}`,
      signal: init.signal,
    };
    outbound.push(observation);
    return nativeFetch(`${mock.baseURL}/chat/completions`, { ...init, redirect: 'error' });
  };
  return { outbound, restore: () => { globalThis.fetch = originalFetch; } };
}

function applyLogCapture() {
  consoleLines.length = 0;
  console.log = (...values) => consoleLines.push(values.map(String).join(' '));
}
function restoreLogCapture() { console.log = originalConsoleLog; }
function auditRecords(container) { return container.audit.getRecords(); }
function readIfExists(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function assertRequestBudget(requests, expectedCount) {
  assert.equal(requests.length, expectedCount);
  for (const { body } of requests) {
    assert.equal(body.model, BASETEN_API_MODEL);
    assert.equal(body.max_tokens, 1500);
    assert.equal(body.reasoning_effort, 'low');
  }
}
async function closeServers() {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
}

async function runSuccess() {
  const mock = await startMock((body, count) => {
    if (count === 1) return { body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' }), {
      model: apiKey,
      content: `Synthetic provider prose ${apiKey}`,
      reasoning: privateReasoning,
      reasoning_content: `${privateReasoning}_CONTENT`,
    }) };
    const toolMessage = body.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'second generation must include the telemetry tool result');
    const evidence = JSON.parse(toolMessage.content);
    return { body: completion('task_complete', JSON.stringify({ summary: `Synthetic replay receipt ${evidence.analysisId}.` }), {
      model: apiKey,
      content: `Synthetic provider prose ${apiKey}`,
      reasoning: privateReasoning,
      reasoning_content: `${privateReasoning}_CONTENT`,
    }) };
  });
  const project = makeProject('success');
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  applyLogCapture();
  const started = Date.now();
  try {
    const container = createServiceContainer(project.root);
    const result = await container.industrialAnalysisAgent.analyze(project.root, {
      request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
    });
    const report = readJson(path.join(project.root, result.reportPath));
    const receipt = fs.readFileSync(path.join(project.root, result.evidence.receiptPath), 'utf8');
    const audit = JSON.stringify(auditRecords(container));
    const logs = readIfExists(path.join(project.root, '.maos', 'logs', 'orchestrator.log'));
    const visible = JSON.stringify({ result, report, receipt, audit, logs, console: consoleLines });
    assertRequestBudget(mock.requests, 2);
    assert.equal(bridge.outbound.length, 2);
    assert.ok(bridge.outbound.every((entry) => entry.url === `${BASETEN_API_BASE_URL}/chat/completions`));
    assert.ok(bridge.outbound.every((entry) => entry.redirect === 'error'));
    assert.ok(bridge.outbound.every((entry) => entry.authorizationMatchesSyntheticKey));
    assert.ok(mock.requests.every((entry) => entry.authorization === `Bearer ${apiKey}`));
    assert.equal(result.requestedModel, BASETEN_API_MODEL);
    assert.equal(result.reportedModel, null);
    assert.equal(result.evidence.verification.valid, true);
    assert.equal(report.acceptance, 'accepted');
    assert.equal(report.explanation.status, 'unverified');
    assert.ok(!visible.includes(apiKey), 'synthetic key must not appear in result, report, receipt, audit or logs');
    assert.ok(!visible.includes(privateReasoning), 'reasoning must not be persisted or returned');
    assert.ok(!JSON.stringify(mock.requests[1].body.messages).includes(privateReasoning));
    const priorAssistant = mock.requests[1].body.messages.find((message) => message.role === 'assistant');
    assert.ok(priorAssistant.content.includes('[REDACTED]'));
    const completed = auditRecords(container).filter((record) => record.data?.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED');
    assert.equal(completed.length, 1);
    runs.push({ name: 'installed-successful-tool-round-trip', passed: true, generations: mock.requests.length, telemetryExecutions: 1, reportAccepted: true, durationMs: Date.now() - started });
  } finally {
    bridge.restore();
    restoreLogCapture();
  }
}

async function runIncomplete(label, finishReason, toolCalls) {
  const partialTool = { id: 'call-partial', type: 'function', function: { name: 'analyze_telemetry_csv', arguments: '{"sourcePath":"commissioning/bearing-ramp.csv' } };
  const mock = await startMock(() => ({ body: completion('unused', '{}', {
    omitToolCalls: !toolCalls,
    ...(toolCalls ? { toolCalls: [partialTool] } : {}),
    finishReason,
    content: null,
    reasoning: privateReasoning,
    reasoning_content: `${privateReasoning}_CONTENT`,
  }) }));
  const project = makeProject(label);
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  applyLogCapture();
  try {
    const container = createServiceContainer(project.root);
    let failure;
    try {
      await container.industrialAnalysisAgent.analyze(project.root, {
        request: 'Review this selected synthetic bearing CSV.', sourcePath: project.sourcePath,
      });
    } catch (error) { failure = error; }
    assert.ok(failure, 'incomplete generation must reject');
    assert.match(failure.message, finishReason === 'length' ? /BASETEN_INCOMPLETE_GENERATION/ : /BASETEN_EMPTY_GENERATION/);
    assert.ok(!failure.message.includes(apiKey));
    assert.ok(!failure.message.includes(privateReasoning));
    assertRequestBudget(mock.requests, 1);
    assert.equal(bridge.outbound.length, 1);
    const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
    assert.equal(fs.existsSync(analysisRoot), false, 'no telemetry tool may execute for incomplete output');
    assert.equal(fs.existsSync(path.join(analysisRoot, 'agent-reports')), false);
    assert.equal(auditRecords(container).some((record) => record.data?.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED'), false);
    const logs = readIfExists(path.join(project.root, '.maos', 'logs', 'orchestrator.log'));
    assert.ok(!logs.includes(apiKey));
    assert.ok(!logs.includes(privateReasoning));
    assert.ok(!consoleLines.join('\n').includes(privateReasoning));
    runs.push({ name: label, passed: true, generations: mock.requests.length, partialToolIncluded: Boolean(toolCalls), reportAccepted: false });
  } finally {
    bridge.restore();
    restoreLogCapture();
  }
}

async function runGenerationCeiling() {
  const mock = await startMock((body, count) => {
    if (count === 1) return { body: completion('analyze_telemetry_csv', JSON.stringify({ sourcePath: 'commissioning/bearing-ramp.csv' })) };
    return { body: completion('run_command', JSON.stringify({ command: 'echo should-not-run' })) };
  });
  const project = makeProject('generation-ceiling');
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  try {
    const container = createServiceContainer(project.root);
    await assert.rejects(container.industrialAnalysisAgent.analyze(project.root, {
      request: 'Analyze only this synthetic CSV; do not run commands.', sourcePath: project.sourcePath,
    }));
    assertRequestBudget(mock.requests, 4);
    assert.equal(bridge.outbound.length, 4);
    assert.equal(fs.existsSync(path.join(project.root, 'should-not-run')), false);
    const analysisRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses');
    assert.equal(fs.readdirSync(analysisRoot).filter((entry) => entry.endsWith('.json')).length, 1);
    assert.equal(fs.existsSync(path.join(analysisRoot, 'agent-reports')), false);
    runs.push({ name: 'four-generation-ceiling-and-single-telemetry-tool', passed: true, generations: mock.requests.length, telemetryExecutions: 1, unauthorizedCommandExecuted: false, reportAccepted: false });
  } finally { bridge.restore(); }
}

async function runNoRetry() {
  const mock = await startMock(() => ({ status: 503, body: { error: { message: 'synthetic mock outage' } } }));
  const project = makeProject('no-retry');
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  try {
    await assert.rejects(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
      request: 'Exercise one synthetic provider failure.', sourcePath: project.sourcePath,
    }));
    assertRequestBudget(mock.requests, 1);
    assert.equal(bridge.outbound.length, 1);
    runs.push({ name: 'provider-error-no-retry', passed: true, httpAttempts: mock.requests.length, reportAccepted: false });
  } finally { bridge.restore(); }
}

async function runRedirectRefusal() {
  let redirectHits = 0;
  const target = await startMock(() => { redirectHits += 1; return { body: { ok: true } }; });
  const mock = await startMock(() => ({ status: 302, headers: { location: `${target.baseURL}/credential-capture` }, body: {} }));
  const project = makeProject('redirect-refusal');
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  try {
    await assert.rejects(createServiceContainer(project.root).industrialAnalysisAgent.analyze(project.root, {
      request: 'Exercise a synthetic redirect refusal.', sourcePath: project.sourcePath,
    }));
    assert.equal(mock.requests.length, 1);
    assert.equal(bridge.outbound.length, 1);
    assert.equal(bridge.outbound[0].redirect, 'error');
    assert.equal(redirectHits, 0, 'redirect destination must receive no request or credential');
    runs.push({ name: 'redirect-refused-before-destination', passed: true, sourceRequests: mock.requests.length, redirectDestinationRequests: redirectHits });
  } finally { bridge.restore(); }
}

async function runDeadline() {
  const mock = await startMock(() => ({ hang: true }));
  const project = makeProject('deadline');
  process.env.BASETEN_API_KEY = apiKey;
  const bridge = installLocalOnlyBridge(mock);
  const started = Date.now();
  try {
    const container = createServiceContainer(project.root);
    let failure;
    try {
      await container.industrialAnalysisAgent.analyze(project.root, {
        request: 'Exercise the fixed local mock deadline.', sourcePath: project.sourcePath,
      });
    } catch (error) { failure = error; }
    assert.ok(failure, 'hung local mock must time out');
    assert.equal(failure.code, 'AGENT_TIMEOUT');
    assert.equal(mock.requests.length, 1);
    assert.equal(bridge.outbound.length, 1);
    assert.equal(bridge.outbound[0].signal.aborted, true);
    const durationMs = Date.now() - started;
    assert.ok(durationMs >= 58_000 && durationMs <= 75_000, `deadline elapsed unexpectedly: ${durationMs}ms`);
    runs.push({ name: 'overall-60-second-deadline', passed: true, generations: mock.requests.length, durationMs, requestAborted: bridge.outbound[0].signal.aborted });
  } finally { bridge.restore(); }
}

(async () => {
  assert.ok(fs.existsSync(appRoot), `installed app path does not exist: ${appRoot}`);
  assert.equal(BASETEN_API_BASE_URL, 'https://inference.baseten.co/v1');
  assert.equal(BASETEN_API_MODEL, 'meta-models/muse-spark-open-1026');
  fs.mkdirSync(syntheticRoot, { recursive: false });
  process.env.BASETEN_API_KEY = apiKey;
  try {
    await runSuccess();
    await runIncomplete('truncated-partial-tool-response', 'length', true);
    await runIncomplete('empty-reasoning-only-response', 'stop', false);
    await runGenerationCeiling();
    await runNoRetry();
    await runRedirectRefusal();
    await runDeadline();
  } finally {
    globalThis.fetch = originalFetch;
    restoreLogCapture();
    delete process.env.BASETEN_API_KEY;
    await closeServers();
  }
  const summary = {
    schemaVersion: 1,
    bundleCommit: '2cfdf9b81f56eada7df2041625da18e44531151e',
    scope: 'Installed package dist via isolated temporary synthetic projects and loopback HTTP mocks only.',
    hostedRequests: 0,
    sourceURLInterceptedByHarness: `${BASETEN_API_BASE_URL}/chat/completions`,
    installedAppPath: appRoot,
    syntheticProjectRoot: syntheticRoot,
    cases: runs,
    passed: runs.every((run) => run.passed),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.passed) process.exitCode = 1;
})().catch(async (error) => {
  globalThis.fetch = originalFetch;
  restoreLogCapture();
  delete process.env.BASETEN_API_KEY;
  await closeServers();
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
