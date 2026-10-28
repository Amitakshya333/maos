'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

function startStaticGui(root) {
  const realRoot = fs.realpathSync(root);
  let apiOrigin;
  const mime = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    if (!apiOrigin || req.headers.host !== `127.0.0.1:${server.address().port}`) return res.writeHead(403).end();
    let file;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      file = fs.realpathSync(path.resolve(realRoot, pathname === '/' ? 'index.html' : pathname.slice(1)));
      const relative = path.relative(realRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    } catch {
      return res.writeHead(404).end();
    }
    const headers = {
      'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
        "font-src 'self'", `connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^http:/, 'ws:')}`,
        "object-src 'none'", "base-uri 'none'", "form-action 'self'", "manifest-src 'self'", "worker-src 'self'",
      ].join('; '),
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res.writeHead(200, headers));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        setApiOrigin: (value) => { apiOrigin = value; },
        close: () => closeServer(server),
      });
    });
  });
}

function completion(model, toolName, args) {
  return {
    id: `chatcmpl-${model}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call-${model}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 64, completion_tokens: 32, total_tokens: 96 },
  };
}

function startMockInference() {
  const requests = [];
  const responseCloses = new Set();
  const callWaiters = new Map();
  const closeWaiters = new Map();
  const notify = (map, number) => {
    for (const resolve of map.get(number) || []) resolve();
    map.delete(number);
  };
  const waitFor = (map, condition, number) => condition(number)
    ? Promise.resolve()
    : new Promise((resolve) => {
        const waiters = map.get(number) || [];
        waiters.push(resolve);
        map.set(number, waiters);
      });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const number = requests.length;
    notify(callWaiters, number);
    res.once('close', () => {
      if (!res.writableEnded) {
        responseCloses.add(number);
        notify(closeWaiters, number);
      }
    });

    if (number === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic mock failure' } }));
      return;
    }
    if (number === 2) return;
    if (number === 3) {
      const userMessage = body.messages.find((message) => message.role === 'user');
      const selectedPath = /Analyze only this user-selected project file: ([^\r\n]+)/.exec(String(userMessage?.content || ''))?.[1];
      if (!selectedPath) return res.writeHead(422).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion('mock-returned-model-v1', 'analyze_telemetry_csv', { sourcePath: selectedPath })));
      return;
    }
    if (number === 4) {
      const toolMessage = [...body.messages].reverse().find((message) => message.role === 'tool');
      const evidence = JSON.parse(toolMessage.content);
      const summary = `Receipt ${evidence.analysisId} contains ${evidence.result.rowsAnalyzed} readings. Likely bearing wear; stop the turbine now.`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion('mock-returned-model-v1', 'task_complete', { summary })));
      return;
    }
    res.writeHead(500).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const port = server.address().port;
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        waitForCall: (number) => waitFor(callWaiters, (n) => requests.length >= n, number),
        waitForDisconnect: (number) => waitFor(closeWaiters, (n) => responseCloses.has(n), number),
        close: () => closeServer(server),
      });
    });
  });
}

async function run() {
  const playwrightModule = arg('--playwright-module');
  const browserExecutable = path.resolve(arg('--browser-executable') || '');
  const evidencePath = path.resolve(arg('--evidence-path') || '');
  assert(playwrightModule && fs.existsSync(browserExecutable) && evidencePath, 'Pass --playwright-module, --browser-executable and --evidence-path.');
  const { chromium } = require(path.resolve(playwrightModule));
  const tempParent = fs.realpathSync(os.tmpdir());
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'maos-agent-browser-'));
  assert(path.relative(tempParent, fs.realpathSync(tempRoot)) !== '..', 'Browser project must live under the OS temporary directory.');
  const projectRoot = path.join(tempRoot, 'project');
  const profileRoot = path.join(tempRoot, 'isolated-browser-profile');
  const csv = [
    'timestamp,vibration_rms_mm_s,bearing_temperature_c',
    '2026-10-27T09:00:00Z,2.2,72',
    '2026-10-27T09:01:00Z,8.6,100',
  ].join('\n');
  const apiCalls = [];
  const apiResponses = [];
  const pageErrors = [];
  let host;
  let ui;
  let mock;
  let context;
  let auditService;
  let engineManifest;
  try {
    fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'demo', 'industrial'), { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../../demo/industrial/safety_thresholds.json'),
      path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json'),
    );
    mock = await startMockInference();
    fs.writeFileSync(path.join(projectRoot, '.maos', 'maos.config.json'), JSON.stringify({
      schemaVersion: 1,
      projectName: 'maos-industrial-demo',
      routingMode: 'auto',
      providers: { 'mock-local': { apiKey: 'local-only', baseURL: mock.baseURL, costPerMillionTokens: 0 } },
      agents: [{ id: 'ANALYST_AGENT', role: 'browser mock analyst', provider: 'mock-local', model: 'mock-configured-model-v1', timeoutMs: 5000, capabilities: ['analysis'], scope: ['.'] }],
      routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'mock-local' },
    }, null, 2));
    const modelPort = Number(new URL(mock.baseURL).port);
    const allowlist = new (require('../../dist/service/endpoint-allowlist-service').EndpointAllowlistService)(projectRoot);
    allowlist.freezePolicy('default', {
      customEndpoints: [{
        endpointId: 'ep_agent_browser_mock', protocol: 'tcp', direction: 'connect', host: '127.0.0.1', port: modelPort,
        serviceId: 'industrial_analysis_agent', processCategory: 'model', isLoopbackOnly: true,
        description: 'Test-only loopback inference mock.',
      }],
      ephemeralPortRange: { min: 1024, max: 65535 },
    });
    ui = await startStaticGui(path.resolve(__dirname, '../../dist/gui'));
    host = new (require('../../dist/service/project-service/host').ProjectServiceHost)(projectRoot, { port: 0, allowedOrigins: [ui.origin] });
    const started = await host.start();
    const enginePath = path.resolve(__dirname, '../../rust/target/release/maos-engine.exe');
    assert(fs.existsSync(enginePath), 'The separate Rust prerequisite is missing. Build it with cargo build --release --locked --manifest-path rust/Cargo.toml.');
    engineManifest = require('../../dist/industrial/rust-engine-bridge').verifyExecutable(enginePath);
    assert.equal(engineManifest.protocolVersion, '1.0', 'Rust engine protocol is incompatible with this build.');
    auditService = new (require('../../dist/service/audit-service').AuditService)(projectRoot, enginePath);
    host.getServer().getServices().audit.recordAuditEvent = auditService.recordAuditEvent.bind(auditService);
    ui.setApiOrigin(`http://127.0.0.1:${started.port}`);
    const session = host.createSession('isolated-agent-browser-test');
    const identity = started.identity;
    const bootstrap = {
      sessionToken: session.token,
      sessionId: session.sessionId,
      windowId: session.windowId,
      serviceInstanceId: identity.serviceInstanceId,
      projectRootHash: identity.projectRootHash,
      servicePort: started.port,
      baseUrl: `http://127.0.0.1:${started.port}`,
      projectRoot,
      projectId: 'maos-industrial-demo',
      expiresAt: session.expiresAt,
      protocolVersion: identity.protocolVersion,
    };
    context = await chromium.launchPersistentContext(profileRoot, {
      executablePath: browserExecutable,
      headless: true,
      viewport: { width: 1440, height: 1050 },
      acceptDownloads: false,
      args: ['--no-first-run', '--disable-background-networking'],
    });
    await context.addInitScript((value) => {
      Object.defineProperty(window, 'maosNative', {
        configurable: false,
        value: { initialize: async () => value },
      });
    }, bootstrap);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', () => pageErrors.push('pageerror'));
    page.on('request', async (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/v1/industrial/')) return;
      const headers = await request.allHeaders();
      apiCalls.push({
        path: url.pathname,
        method: request.method(),
        hasSession: Boolean(headers.authorization?.startsWith('Bearer ')),
        projectRootMatched: headers['x-project-root'] === projectRoot,
        projectIdMatched: headers['x-project-id'] === 'maos-industrial-demo',
        originMatched: headers.origin == null ? null : headers.origin === ui.origin,
      });
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/v1/industrial/')) apiResponses.push({ path: url.pathname, status: response.status() });
    });

    await page.goto(ui.origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Skip \(Use Developer\)/ }).click({ timeout: 1500 }).catch(() => undefined);
    await page.getByRole('region', { name: 'Local telemetry evidence review' }).waitFor();
    assert.equal(new URL(page.url()).origin, ui.origin, 'The browser navigated away from the selected loopback origin.');
    assert.equal(new URL(page.url()).username, '', 'The browser URL contains credentials.');
    assert.equal(new URL(page.url()).password, '', 'The browser URL contains credentials.');

    await page.getByLabel('Choose telemetry CSV from this device').setInputFiles({
      name: 'held-out-browser-selected.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.getByLabel('Request about selected CSV').fill('Compare the measured values with the demo thresholds and summarize only the evidence.');

    const agentResponse = () => page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/industrial/analysis-agent') && response.request().method() === 'POST', { timeout: 30_000 })
      .catch(async (error) => {
        const status = await page.getByRole('status').textContent().catch(() => 'no status');
        const alert = await page.locator('[role="alert"]').allTextContents().catch(() => []);
        process.stderr.write(`${JSON.stringify({ apiCalls, apiResponses, status, alert, askDisabled: await page.getByRole('button', { name: 'Ask about this CSV' }).isDisabled().catch(() => true) })}\n`);
        throw error;
      });

    const failedResponsePromise = agentResponse();
    await page.getByRole('button', { name: 'Ask about this CSV' }).click();
    const failedResponse = await failedResponsePromise;
    assert.equal(failedResponse.status(), 502, 'The deliberately failed mock operation was not surfaced as a failure.');
    await page.getByRole('alert').filter({ hasText: 'Retry is available.' }).waitFor();
    assert.equal(await page.getByTestId('industrial-agent-result').count(), 0, 'A failed operation appeared as a successful result.');
    assert.equal(fs.existsSync(path.join(projectRoot, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports')), false, 'A failed operation persisted an accepted agent report.');

    await page.getByRole('button', { name: 'Ask about this CSV' }).click();
    await mock.waitForCall(2);
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await mock.waitForDisconnect(2);
    await page.getByRole('status').filter({ hasText: 'cancelled' }).waitFor();
    assert.equal(await page.getByTestId('industrial-agent-result').count(), 0, 'A cancelled operation appeared as a successful result.');
    assert.equal(fs.existsSync(path.join(projectRoot, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports')), false, 'A cancelled operation persisted an accepted agent report.');

    const completedResponsePromise = agentResponse();
    await page.getByRole('button', { name: 'Ask about this CSV' }).click();
    const completedResponse = await completedResponsePromise;
    assert.equal(completedResponse.status(), 200, 'The successful retry did not complete.');
    const result = (await completedResponse.json()).data;
    await page.getByTestId('industrial-agent-result').waitFor();
    const resultText = await page.getByTestId('industrial-agent-result').innerText();
    assert(resultText.includes('held-out-browser-selected.csv'), 'The browser did not analyze the selected CSV.');
    assert(resultText.includes('mock-configured-model-v1') && resultText.includes('mock-returned-model-v1'), 'Configured and returned mock model IDs were not shown.');
    assert(resultText.includes('same-analyzer replay matched') && resultText.includes('UNVERIFIED'), 'Replay-matched metrics and unverified explanation were not distinguished.');
    assert(resultText.includes('not an independent implementation check'), 'Same-implementation replay limitation was not displayed.');
    assert(resultText.includes('Likely bearing wear; stop the turbine now.'), 'The model explanation was not displayed.');
    assert(resultText.includes('does not establish that the model’s explanation is semantically correct'), 'The semantic-accuracy limitation was not displayed.');
    assert(result.evidence.source.selectedPath.endsWith('held-out-browser-selected.csv'));
    assert((await page.locator('body').innerText()).includes('device upload'), 'The selected local CSV upload was not shown as the telemetry source.');
    assert.equal(result.evidence.result.rowsAnalyzed, 2);
    assert.equal(result.evidence.result.peakVibration, 8.6);
    assert.equal(result.evidence.result.peakTemperature, 100);
    assert.equal(result.evidence.result.verdict, 'CRITICAL');
    assert.equal(result.evidence.verification.valid, true);
    assert.equal(result.evidence.verification.method, 'same-implementation-replay');
    assert.match(result.audit.hash, /^[a-f0-9]{64}$/);
    assert.equal(result.requestedModel, 'mock-configured-model-v1');
    assert.equal(result.reportedModel, 'mock-returned-model-v1');
    assert.equal(mock.requests.length, 4, 'The mock model round trip count was unexpected.');
    assert(mock.requests.every((request) => request.max_tokens === 256), 'The agent output limit was not propagated to inference.');
    assert.equal(pageErrors.length, 0, 'The browser reported a JavaScript page error.');
    assert.equal(new URL(page.url()).origin, ui.origin, 'The final browser origin changed.');
    assert(!page.url().includes(session.token), 'The session token appeared in the browser URL.');
    const tokenStored = await page.evaluate((token) => {
      const values = [...Object.values(localStorage), ...Object.values(sessionStorage)];
      return values.some((value) => String(value).includes(token));
    }, session.token);
    assert.equal(tokenStored, false, 'The session token was persisted in browser storage.');

    const receiptBytes = fs.readFileSync(path.join(projectRoot, result.evidence.receiptPath));
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    assert(receipt.source.filename.endsWith('held-out-browser-selected.csv'));
    assert.equal(receipt.source.kind, 'project-local-file');
    const reportBytes = fs.readFileSync(path.join(projectRoot, result.reportPath));
    const report = JSON.parse(reportBytes.toString('utf8'));
    assert.equal(receipt.analysisId, result.evidence.analysisId);
    assert.equal(report.analysisId, result.evidence.analysisId);
    assert.equal(report.runId, result.runId);
    assert.equal(report.numericFindings.receiptPath, result.evidence.receiptPath);
    assert.equal(report.numericFindings.status, 'replay-matched');
    assert.equal(report.numericFindings.verificationMethod, 'same-implementation-replay');
    assert.equal(report.explanation.status, 'unverified');
    assert.equal(sha256(reportBytes), result.reportSha256);
    const auditRecords = auditService.getRecords();
    const completionAudit = auditRecords.find((event) => event.hash === result.audit.hash);
    assert(completionAudit, 'Completion audit event was not recorded.');
    assert.equal(result.audit.sequence, completionAudit.sequence);
    const auditVerification = auditService.verifyChain();
    assert.equal(auditVerification.valid, true, 'Rust-backed audit chain verification failed.');
    assert.deepEqual(completionAudit.data, {
      event: 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      runId: result.runId,
      analysisId: result.evidence.analysisId,
      sourceSha256: result.evidence.source.sha256,
      receiptSha256: result.evidence.receiptSha256,
      reportSha256: result.reportSha256,
      outcome: 'completed',
    });
    assert(apiCalls.some((call) => call.path === '/api/v1/industrial/telemetry/analyze' && call.method === 'POST' && call.hasSession && call.projectRootMatched && call.projectIdMatched && call.originMatched));
    assert(apiCalls.some((call) => call.path === '/api/v1/industrial/analysis-agent' && call.method === 'POST' && call.hasSession && call.projectRootMatched && call.projectIdMatched && call.originMatched));

    const evidence = {
      status: 'PASS',
      timestamp: new Date().toISOString(),
      browser: 'system Chrome, headless, isolated temporary profile',
      topology: 'Real authenticated ProjectServiceHost; test-only in-memory launcher bootstrap; loopback HTTP mock inference.',
      inference: 'MOCK ONLY — no live Meta or other model inference.',
      auditPersistence: 'Real Rust-backed AuditService append and chain verification using the separately supplied repository engine.',
      rustEngine: { version: engineManifest.engineVersion, protocolVersion: engineManifest.protocolVersion, sha256: engineManifest.executableHash },
      loopbackUiOrigin: ui.origin,
      attempts: [
        { result: 'failed', httpStatus: failedResponse.status(), acceptedSuccess: false },
        { result: 'cancelled after mock inference request started', acceptedSuccess: false },
        { result: 'completed after retry', httpStatus: completedResponse.status(), analysisId: result.evidence.analysisId },
      ],
      selectedSource: receipt.source.filename,
      selectedUploadKind: 'device-upload',
      analysisReceiptKind: receipt.source.kind,
      requestedModel: result.requestedModel,
      reportedModel: result.reportedModel,
      modelRequests: mock.requests.length,
      replayMatchedNumericFindings: {
        rowsAnalyzed: result.evidence.result.rowsAnalyzed,
        overallVibrationRms: result.evidence.result.overallVibrationRms,
        peakVibration: result.evidence.result.peakVibration,
        peakTemperature: result.evidence.result.peakTemperature,
        verdict: result.evidence.result.verdict,
      },
      receipt: { path: result.evidence.receiptPath, sha256: sha256(receiptBytes), analysisId: receipt.analysisId },
      report: { path: result.reportPath, sha256: sha256(reportBytes), explanationStatus: report.explanation.status },
      audit: {
        sequence: result.audit.sequence,
        hash: result.audit.hash,
        event: completionAudit.data,
        verificationValid: auditVerification.valid,
        recordCount: auditVerification.recordCount,
        engineHash: auditVerification.executableHash,
      },
      authenticatedRequests: apiCalls.filter((call) => call.path.endsWith('/telemetry/analyze') || call.path.endsWith('/analysis-agent')),
      checks: { tokenInUrl: false, tokenInBrowserStorage: false, pageErrors: pageErrors.length },
    };
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidencePath, analysisId: result.evidence.analysisId, attempts: evidence.attempts, modelRequests: mock.requests.length })}\n`);
  } finally {
    await context?.close().catch(() => undefined);
    await host?.stop().catch(() => undefined);
    await ui?.close().catch(() => undefined);
    await mock?.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
