'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
let currentStage = 'startup';
const diagnosticRequests = [];
const diagnosticResponses = [];
const diagnosticFailures = [];
const diagnosticPageErrors = [];
const diagnosticModelPrompts = [];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function response(model, toolName, args) {
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

async function startMockInference() {
  const requests = [];
  const closedResponses = new Set();
  const requestWaiters = new Map();
  const closeWaiters = new Map();
  const notify = (queue, number) => {
    for (const resolve of queue.get(number) || []) resolve();
    queue.delete(number);
  };
  const waitFor = (queue, predicate, number) => predicate(number)
    ? Promise.resolve()
    : new Promise((resolve) => {
        const waiters = queue.get(number) || [];
        waiters.push(resolve);
        queue.set(number, waiters);
      });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const number = requests.length;
    notify(requestWaiters, number);
    res.once('close', () => {
      if (!res.writableEnded) {
        closedResponses.add(number);
        notify(closeWaiters, number);
      }
    });
    if (number === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic mock failure' } }));
      return;
    }
    if (number === 2) return;
    if (number >= 3 && number % 2 === 1) {
      const userMessage = body.messages.find((message) => message.role === 'user');
      const selectedPath = /Analyze only this user-selected project file: ([^\r\n]+)/.exec(String(userMessage?.content || ''))?.[1];
      if (!selectedPath) {
        diagnosticModelPrompts.push(String(userMessage?.content || '').slice(0, 1200));
        return res.writeHead(422).end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response('mock-returned-model-v1', 'analyze_telemetry_csv', { sourcePath: selectedPath })));
      return;
    }
    if (number >= 4 && number % 2 === 0) {
      const toolMessage = [...body.messages].reverse().find((message) => message.role === 'tool');
      const evidence = toolMessage && JSON.parse(toolMessage.content);
      const summary = `Receipt ${evidence?.analysisId || 'missing'} records ${evidence?.result?.rowsAnalyzed || 0} held-out observations; deterministic peaks were ${evidence?.result?.peakVibration || 0} mm/s and ${evidence?.result?.peakTemperature || 0} deg C.`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response('mock-returned-model-v1', 'task_complete', { summary })));
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    waitForRequest: (number) => waitFor(requestWaiters, (n) => requests.length >= n, number),
    waitForResponseClose: (number) => waitFor(closeWaiters, (n) => closedResponses.has(n), number),
    close: (() => {
      let closed = false;
      return () => {
        if (closed) return Promise.resolve();
        closed = true;
        return new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections?.();
        });
      };
    })(),
  };
}

async function postJson(apiOrigin, uiOrigin, projectRoot, projectId, pathname, body, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: options.origin ?? uiOrigin,
    'X-Project-Root': options.projectRoot ?? projectRoot,
    'X-Project-ID': options.projectId ?? projectId,
  };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? ''}`;
  const responseValue = await fetch(`${apiOrigin}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let payload;
  try { payload = await responseValue.json(); } catch { payload = undefined; }
  return { response: responseValue, payload };
}

function waitForDownload(app, savePath, timeoutMs = 30_000) {
  return app.evaluate(({ BrowserWindow }, options) => new Promise((resolve) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) return resolve({ triggered: false, reason: 'window-closed' });
    const session = window.webContents.session;
    const timer = setTimeout(() => finish({ triggered: false, reason: 'timeout' }), options.timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      session.removeListener('will-download', onDownload);
      resolve(value);
    };
    const onDownload = (_event, item, webContents) => {
      if (webContents !== window.webContents) return;
      item.setSavePath(options.savePath);
      item.once('done', (_downloadEvent, state) => finish({
        triggered: true,
        state,
        filePath: item.getSavePath(),
        filename: item.getFilename(),
      }));
    };
    session.on('will-download', onDownload);
  }), { savePath, timeoutMs });
}

async function run() {
  const packageRoot = path.resolve(arg('--package-root') || path.resolve(__dirname, '../..'));
  const evidenceArgument = arg('--evidence-path');
  assert(evidenceArgument, 'Pass --evidence-path.');
  const evidencePath = path.resolve(evidenceArgument);
  const tempParent = fs.realpathSync(os.tmpdir());
  const workRoot = fs.mkdtempSync(path.join(tempParent, 'maos-electron-agent-'));
  const projectRoot = path.join(workRoot, 'project');
  const userDataPath = path.join(workRoot, 'electron-user-data');
  fs.mkdirSync(userDataPath, { recursive: true });
  const selectedFilePath = path.join(projectRoot, 'held-out', 'shift-end-pressure-ripple.csv');
  const projectId = 'maos-industrial-demo';
  const syntheticCsv = [
    'timestamp,vibration_rms_mm_s,bearing_temperature_c',
    '2026-10-26T17:40:00Z,2.4,69',
    '2026-10-26T17:45:00Z,6.6,93',
    '2026-10-26T17:50:00Z,8.7,101',
  ].join('\n');
  const sourceExpectation = {
    rowsAnalyzed: 3,
    peakVibration: 8.7,
    peakTemperature: 101,
    verdict: 'CRITICAL',
  };
  const enginePath = process.env.MAOS_TEST_RUST_ENGINE || path.join(packageRoot, 'rust', 'target', 'release', 'maos-engine.exe');
  assert(fs.existsSync(enginePath), `Separate Rust engine prerequisite is missing: ${enginePath}`);
  const mock = await startMockInference();
  let uiPort = await reservePort();
  let app;
  let apiOrigin;
  let uiOrigin;
  let token;
  let identity;
  let selectedRunId;
  let finalRunId;
  let finalAnalysisId;
  let finalArtifact;
  let finalAudit;
  let finalDownloadHash;
  let serviceStopped = false;
  let uiStopped = false;
  let mockStopped = false;
  const sockets = [];
  const requests = [];
  const pageErrors = [];
  const mainLogs = [];
  try {
    fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'demo', 'industrial'), { recursive: true });
    fs.mkdirSync(path.dirname(selectedFilePath), { recursive: true });
    for (const name of ['safety_thresholds.json', 'turbine_vibration_log.csv', 'maintenance_report.txt', 'turbine_inspection_scan.pdf']) {
      fs.copyFileSync(path.join(packageRoot, 'demo', 'industrial', name), path.join(projectRoot, 'demo', 'industrial', name));
    }
    fs.writeFileSync(selectedFilePath, `${syntheticCsv}\n`, 'utf8');
    const config = {
      schemaVersion: 1,
      projectName: projectId,
      routingMode: 'auto',
      providers: { 'mock-local': { apiKey: 'local-only', baseURL: mock.baseURL, costPerMillionTokens: 0 } },
      agents: [{ id: 'ANALYST_AGENT', role: 'held-out CSV analyst', runtime: 'local', provider: 'mock-local', model: 'mock-configured-model-v1', timeoutMs: 15_000, capabilities: ['analysis'], scope: ['.'] }],
      routing: { strategy: 'capability_score', costWeight: 0, capabilityWeight: 1, maxParallelAgents: 1, fallbackProvider: 'mock-local' },
    };
    fs.writeFileSync(path.join(projectRoot, '.maos', 'maos.config.json'), JSON.stringify(config, null, 2));
    const { EndpointAllowlistService } = require(path.join(packageRoot, 'dist', 'service', 'endpoint-allowlist-service.js'));
    new EndpointAllowlistService(projectRoot).freezePolicy('default', {
      customEndpoints: [{
        endpointId: 'ep_agent_electron_mock',
        protocol: 'tcp',
        direction: 'connect',
        host: '127.0.0.1',
        port: Number(new URL(mock.baseURL).port),
        serviceId: 'industrial_analysis_agent',
        processCategory: 'model',
        isLoopbackOnly: true,
        description: 'Temporary loopback mock inference for the authenticated Electron rehearsal.',
      }],
      ephemeralPortRange: { min: 1024, max: 65535 },
    });
    const projectEnginePath = path.join(projectRoot, 'rust', 'target', 'release', 'maos-engine.exe');
    fs.mkdirSync(path.dirname(projectEnginePath), { recursive: true });
    fs.copyFileSync(enginePath, projectEnginePath);
    const engineManifest = require(path.join(packageRoot, 'dist', 'industrial', 'rust-engine-bridge.js')).verifyExecutable(projectEnginePath);
    assert.equal(engineManifest.protocolVersion, '1.0', 'The separate local Rust prerequisite has an incompatible protocol.');

    app = await electron.launch({
      executablePath: require('electron'),
      args: [path.join(packageRoot, 'desktop', 'main.cjs'), '--project-root', projectRoot, '--allow-temp', '--ui-port', String(uiPort), '--user-data-dir', userDataPath],
      timeout: 60_000,
    });
    const electronProcess = app.process();
    electronProcess.stdout?.on('data', (chunk) => mainLogs.push(String(chunk)));
    electronProcess.stderr?.on('data', (chunk) => mainLogs.push(String(chunk)));
    let page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('request', (request) => {
      requests.push((async () => {
        const headers = await request.allHeaders();
        const url = new URL(request.url());
        diagnosticRequests.push({ path: url.pathname, method: request.method() });
        if (headers['x-project-root']) assert.equal(path.resolve(headers['x-project-root']), projectRoot, 'Renderer sent a different project root.');
        if (!token && headers.authorization?.startsWith('Bearer ')) {
          token = headers.authorization.slice('Bearer '.length);
          apiOrigin = url.origin;
        }
        return {
          path: url.pathname,
          method: request.method(),
          hasSession: Boolean(headers.authorization?.startsWith('Bearer ')),
          projectRootMatched: headers['x-project-root'] ? path.resolve(headers['x-project-root']) === projectRoot : false,
          projectIdMatched: headers['x-project-id'] === projectId,
        };
      })().catch(() => undefined));
    });
    page.on('response', (responseValue) => {
      const url = new URL(responseValue.url());
      if (url.pathname.startsWith('/api/')) diagnosticResponses.push({ path: url.pathname, status: responseValue.status() });
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) diagnosticFailures.push({ path: url.pathname, failure: request.failure()?.errorText || 'unknown' });
    });
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => { pageErrors.push(error.message); diagnosticPageErrors.push(error.message); });
    currentStage = 'wait-for-renderer';
    await page.locator('main[role="main"]').waitFor();
    const onboarding = page.getByRole('button', { name: /Skip \(Use Developer\)/ });
    if (await onboarding.isVisible().catch(() => false)) await onboarding.click();
    uiOrigin = new URL(page.url()).origin;
    assert.equal(uiOrigin, `http://127.0.0.1:${uiPort}`, 'Electron loaded a different renderer origin.');
    await page.getByRole('tabpanel', { name: 'Agent Cockpit View', exact: true }).waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('API: HEALTHY'));
    await page.waitForFunction(() => document.body.innerText.includes('LIVE STREAM'));
    await Promise.all(requests);
    assert.match(token || '', /^[0-9a-f]{64}$/i, 'Renderer did not receive an in-memory launcher-issued session.');
    assert(apiOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin), 'Project service did not choose a runtime loopback port.');
    assert.notEqual(apiOrigin, uiOrigin, 'The authenticated service was not separate from the UI server.');
    assert.equal(new URL(page.url()).username, '', 'Renderer URL contains a username.');
    assert.equal(new URL(page.url()).password, '', 'Renderer URL contains a password.');

    const identityResponse = await fetch(`${apiOrigin}/api/v1/service/identity`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    const identityPayload = await identityResponse.json();
    identity = identityPayload.data;
    assert.equal(identityResponse.status, 200);
    assert.equal(path.resolve(identity.projectRoot), projectRoot);
    assert.equal(identity.host, '127.0.0.1');
    assert.equal(identity.servicePort, Number(new URL(apiOrigin).port));
    assert.equal(identity.projectRootHash, sha256(projectRoot.toLowerCase()));
    let eventSocket = sockets.map((value) => new URL(value)).find((url) => url.pathname === '/api/v1/events');
    assert(eventSocket, 'The renderer did not connect its authenticated event stream.');
    assert.equal(eventSocket.searchParams.get('projectId'), projectId);
    assert(!eventSocket.href.includes(token), 'The token appeared in the event stream URL.');

    const chooseSource = async () => {
      await page.getByLabel('Choose telemetry CSV from this device').setInputFiles(selectedFilePath);
      await page.getByLabel('Request about selected CSV').fill('Compare these shift-end readings with the demonstration limits. Report measured values only.');
    };
    const agentResponse = () => page.waitForResponse((responseValue) =>
      responseValue.url().endsWith('/api/v1/industrial/analysis-agent') && responseValue.request().method() === 'POST');
    const runAgent = async () => {
      currentStage = 'select-file-and-request-agent';
      await chooseSource();
      const responsePromise = agentResponse();
      await page.getByRole('button', { name: 'Ask about this CSV' }).click();
      const responseValue = await responsePromise;
      return { response: responseValue, payload: await responseValue.json().catch(() => undefined) };
    };
    const agentRoute = '/api/v1/industrial/analysis-agent';

    currentStage = 'mock-failure-attempt';
    const failed = await runAgent();
    assert.equal(failed.response.status(), 502, 'The failed synthetic model operation was not reported as a failure.');
    await page.getByRole('alert').filter({ hasText: 'Retry is available.' }).waitFor();
    assert.equal(await page.getByTestId('industrial-agent-result').count(), 0, 'A failed model request appeared successful.');
    assert.equal(fs.existsSync(path.join(projectRoot, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports')), false);

    currentStage = 'mock-cancel-attempt';
    await chooseSource();
    await page.getByRole('button', { name: 'Ask about this CSV' }).click();
    await mock.waitForRequest(2);
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await mock.waitForResponseClose(2);
    await page.getByRole('status').filter({ hasText: 'cancelled' }).waitFor();
    assert.equal(await page.getByTestId('industrial-agent-result').count(), 0, 'A cancelled model request appeared successful.');
    assert.equal(fs.existsSync(path.join(projectRoot, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports')), false);

    const analyzeSelected = async () => {
      const completed = await runAgent();
      assert.equal(completed.response.status(), 200, `Mock tool-call analysis did not complete: ${JSON.stringify(completed.payload?.error || completed.payload?.data?.error || completed.payload)}`);
      await page.getByTestId('industrial-agent-result').waitFor();
      const resultText = await page.getByTestId('industrial-agent-result').innerText();
      assert(resultText.includes('shift-end-pressure-ripple.csv'), 'The GUI did not present the selected held-out CSV.');
      assert(resultText.includes('mock-configured-model-v1') && resultText.includes('mock-returned-model-v1'));
      assert(resultText.includes('same-analyzer replay matched') && resultText.includes('UNVERIFIED'));
      const result = completed.payload.data;
      assert.deepEqual({
        rowsAnalyzed: result.evidence.result.rowsAnalyzed,
        peakVibration: result.evidence.result.peakVibration,
        peakTemperature: result.evidence.result.peakTemperature,
        verdict: result.evidence.result.verdict,
      }, sourceExpectation, 'Verified numeric findings did not match the independent held-out-data oracle.');
      assert.equal(result.evidence.verification.method, 'same-implementation-replay');
      assert.equal(result.evidence.verification.valid, true);
      assert.equal(result.explanation.includes(result.evidence.analysisId), true);
      return result;
    };
    const prepareReview = async (result) => {
      const preparedResponse = page.waitForResponse((responseValue) =>
        responseValue.url().endsWith('/api/v1/industrial/judged-runs') && responseValue.request().method() === 'POST');
      await page.getByRole('button', { name: 'Send this receipt to human review' }).click();
      const prepared = await preparedResponse;
      assert.equal(prepared.status(), 202, 'The accepted receipt did not create a pending review.');
      const payload = (await prepared.json()).data;
      assert.equal(payload.details.agentAnalysis.analysisId, result.evidence.analysisId);
      assert.equal(payload.details.agentAnalysis.agentRunId, result.runId);
      assert.equal(payload.details.engineeringVerdict, 'CRITICAL');
      return payload;
    };
    const reviewCard = (analysisId) => page.locator('.state-box').filter({ hasText: analysisId }).first();
    const decide = async (analysisId, decision, notes, expectedStatus = 200) => {
      const card = reviewCard(analysisId);
      await card.getByRole('button', { name: decision === 'approved' ? 'Review & Approve' : 'Reject', exact: true }).click();
      await page.locator(`form input[type="radio"][value="${decision}"]`).check();
      await page.locator('form input[type="text"]').fill('electron-reviewer');
      await page.locator('form textarea').first().fill(notes);
      const reviewResponsePromise = page.waitForResponse((responseValue) =>
        responseValue.url().includes('/api/v1/approvals/') && responseValue.url().endsWith('/review') && responseValue.request().method() === 'POST');
      await page.getByRole('button', { name: decision === 'approved' ? 'Confirm Approval' : 'Confirm Rejection', exact: true }).click();
      const reviewResponse = await reviewResponsePromise;
      const reviewPayload = await reviewResponse.json().catch(() => undefined);
      assert.equal(reviewResponse.status(), expectedStatus, `Review operation failed: ${JSON.stringify(reviewPayload?.error || reviewPayload)}`);
      return reviewPayload;
    };
    currentStage = 'first-successful-analysis';
    const rejectedAnalysis = await analyzeSelected();
    currentStage = 'first-review-preparation';
    const rejectedRun = await prepareReview(rejectedAnalysis);
    await page.getByText('Selected CSV pre-review findings', { exact: false }).waitFor();
    await page.getByText('Model-generated explanation · UNVERIFIED', { exact: true }).waitFor();
    await decide(rejectedAnalysis.evidence.analysisId, 'rejected', 'Reject the first mock report for this rehearsal.');
    await page.getByText(new RegExp(`Industrial run ${rejectedRun.runId} is rejected`), { exact: false }).waitFor();
    const rejectedManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial-runs', `${rejectedRun.runId}.json`), 'utf8'));
    assert.equal(rejectedManifest.status, 'rejected');
    assert.equal(rejectedManifest.deliverablePath, undefined);
    assert.equal((await fetch(`${apiOrigin}/api/v1/artifacts?runId=${encodeURIComponent(rejectedRun.runId)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    })).status, 200);
    assert.equal((await fetch(`${apiOrigin}/api/v1/artifacts?runId=${encodeURIComponent(rejectedRun.runId)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    }).then((responseValue) => responseValue.json())).data.length, 0, 'Rejected run exposed a completed artifact.');

    currentStage = 'stale-analysis';
    await page.getByTestId('activity-btn-cockpit').click();
    const staleAnalysis = await analyzeSelected();
    currentStage = 'stale-review-preparation';
    const staleRun = await prepareReview(staleAnalysis);
    selectedRunId = staleRun.runId;
    currentStage = 'reload-and-resume-pending-review';
    await page.reload();
    await page.getByRole('button', { name: 'Refresh approvals' }).waitFor();
    await reviewCard(staleAnalysis.evidence.analysisId).getByRole('button', { name: 'Review & Approve' }).waitFor();
    await page.getByTestId('activity-btn-cockpit').click();
    await page.getByText(new RegExp(`Saved analysis review · run ${staleRun.runId}`), { exact: false }).waitFor();
    const oldSessionToken = token;
    const oldApiOrigin = apiOrigin;
    const oldUiOrigin = uiOrigin;
    const oldServiceInstanceId = identity.serviceInstanceId;
    const oldServicePort = identity.servicePort;
    await app.close();
    app = undefined;
    const restartOldServiceStopped = await fetch(`${oldApiOrigin}/api/v1/service/identity`, { signal: AbortSignal.timeout(1500) }).then(() => false).catch(() => true);
    const restartOldUiStopped = await fetch(`${oldUiOrigin}/`, { signal: AbortSignal.timeout(1500) }).then(() => false).catch(() => true);
    assert(restartOldServiceStopped && restartOldUiStopped, 'The first Electron process left a project listener running.');

    token = undefined;
    apiOrigin = undefined;
    uiOrigin = undefined;
    identity = undefined;
    eventSocket = undefined;
    currentStage = 'process-restart';
    app = await electron.launch({
      executablePath: require('electron'),
      args: [path.join(packageRoot, 'desktop', 'main.cjs'), '--project-root', projectRoot, '--allow-temp', '--ui-port', String(uiPort), '--user-data-dir', userDataPath],
      timeout: 60_000,
    });
    const restartedElectronProcess = app.process();
    restartedElectronProcess.stdout?.on('data', (chunk) => mainLogs.push(String(chunk)));
    restartedElectronProcess.stderr?.on('data', (chunk) => mainLogs.push(String(chunk)));
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('request', (request) => {
      requests.push((async () => {
        const headers = await request.allHeaders();
        const url = new URL(request.url());
        diagnosticRequests.push({ path: url.pathname, method: request.method() });
        if (headers['x-project-root']) assert.equal(path.resolve(headers['x-project-root']), projectRoot, 'Renderer sent a different project root after restart.');
        if (!token && headers.authorization?.startsWith('Bearer ')) {
          token = headers.authorization.slice('Bearer '.length);
          apiOrigin = url.origin;
        }
        return {
          path: url.pathname,
          method: request.method(),
          hasSession: Boolean(headers.authorization?.startsWith('Bearer ')),
          projectRootMatched: headers['x-project-root'] ? path.resolve(headers['x-project-root']) === projectRoot : false,
          projectIdMatched: headers['x-project-id'] === projectId,
        };
      })().catch(() => undefined));
    });
    page.on('response', (responseValue) => {
      const url = new URL(responseValue.url());
      if (url.pathname.startsWith('/api/')) diagnosticResponses.push({ path: url.pathname, status: responseValue.status() });
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) diagnosticFailures.push({ path: url.pathname, failure: request.failure()?.errorText || 'unknown' });
    });
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => { pageErrors.push(error.message); diagnosticPageErrors.push(error.message); });
    currentStage = 'restart-wait-for-renderer';
    await page.locator('main[role="main"]').waitFor();
    const restartOnboarding = page.getByRole('button', { name: /Skip \(Use Developer\)/ });
    if (await restartOnboarding.isVisible().catch(() => false)) await restartOnboarding.click();
    uiOrigin = new URL(page.url()).origin;
    assert.equal(uiOrigin, `http://127.0.0.1:${uiPort}`, 'Restarted Electron loaded a different renderer origin.');
    await page.getByRole('tabpanel', { name: 'Agent Cockpit View', exact: true }).waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('API: HEALTHY'));
    await page.waitForFunction(() => document.body.innerText.includes('LIVE STREAM'));
    await Promise.all(requests);
    assert.match(token || '', /^[0-9a-f]{64}$/i, 'Restarted launcher did not issue a renderer session through private IPC.');
    assert.notEqual(token, oldSessionToken, 'Restart reused the prior launcher session token.');
    const restartedIdentityResponse = await fetch(`${apiOrigin}/api/v1/service/identity`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    const restartedIdentityPayload = await restartedIdentityResponse.json();
    identity = restartedIdentityPayload.data;
    assert.equal(restartedIdentityResponse.status, 200);
    assert.equal(path.resolve(identity.projectRoot), projectRoot);
    assert.notEqual(identity.serviceInstanceId, oldServiceInstanceId);
    assert.equal(identity.servicePort, Number(new URL(apiOrigin).port));
    const restartedEventSocket = sockets.map((value) => new URL(value)).filter((url) => url.pathname === '/api/v1/events').at(-1);
    assert(restartedEventSocket, 'The restarted renderer did not reconnect its event stream.');
    assert.equal(restartedEventSocket.searchParams.get('projectId'), projectId);
    assert(!restartedEventSocket.href.includes(token));
    eventSocket = restartedEventSocket;
    const oldSessionResponse = await fetch(`${apiOrigin}/api/v1/service/identity`, {
      headers: { Authorization: `Bearer ${oldSessionToken}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    assert.equal(oldSessionResponse.status, 401, 'A token from the stopped process was accepted by the restarted host.');
    await page.getByTestId('activity-btn-approvals').click();
    await page.getByRole('button', { name: 'Refresh approvals' }).waitFor();
    await reviewCard(staleAnalysis.evidence.analysisId).getByRole('button', { name: 'Review & Approve' }).waitFor();
    await page.getByTestId('activity-btn-cockpit').click();
    await page.getByText(new RegExp(`Saved analysis review · run ${staleRun.runId}`), { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Resume in Approvals' }).click();
    await reviewCard(staleAnalysis.evidence.analysisId).getByRole('button', { name: 'Review & Approve' }).waitFor();
    const processRestartResume = {
      processRestarted: true,
      oldServiceStopped: restartOldServiceStopped,
      oldUiStopped: restartOldUiStopped,
      newSessionIssued: token !== oldSessionToken,
      oldSessionRejected: oldSessionResponse.status === 401,
      pendingRunResumed: true,
      pendingRunId: staleRun.runId,
      oldServiceInstanceId,
      newServiceInstanceId: identity.serviceInstanceId,
      oldServicePort,
      newServicePort: identity.servicePort,
      userDataPath,
    };

    const invalidStartMissing = await postJson(apiOrigin, uiOrigin, projectRoot, projectId, '/api/v1/industrial/judged-runs', { analysisId: staleAnalysis.evidence.analysisId }, { token: null });
    const invalidStartToken = await postJson(apiOrigin, uiOrigin, projectRoot, projectId, '/api/v1/industrial/judged-runs', { analysisId: staleAnalysis.evidence.analysisId }, { token: '0'.repeat(64) });
    const invalidStartProject = await postJson(apiOrigin, uiOrigin, projectRoot, projectId, '/api/v1/industrial/judged-runs', { analysisId: staleAnalysis.evidence.analysisId }, { projectId: 'wrong-project' });
    const invalidStartOrigin = await postJson(apiOrigin, uiOrigin, projectRoot, projectId, '/api/v1/industrial/judged-runs', { analysisId: staleAnalysis.evidence.analysisId }, { origin: 'http://127.0.0.1:1' });
    assert.equal(invalidStartMissing.response.status, 401);
    assert.equal(invalidStartToken.response.status, 401);
    assert.equal(invalidStartProject.response.status, 400);
    assert.equal(invalidStartOrigin.response.status, 403);

    const staleReport = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports', `${staleAnalysis.evidence.analysisId}.json`), 'utf8'));
    fs.appendFileSync(path.join(projectRoot, staleReport.source.selectedPath), '\n');
    currentStage = 'stale-source-decision';
    const staleDecision = await decide(staleAnalysis.evidence.analysisId, 'approved', 'Attempt approval after changing the selected source.', 409);
    assert.equal(staleDecision.error.code, 'STALE_APPROVAL');
    await page.getByRole('alert').filter({ hasText: 'source changed after analysis' }).waitFor();
    assert.equal((await page.locator('body').innerText()).toLowerCase().includes('report generated'), false, 'Stale approval was presented as a generated report.');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const staleManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial-runs', `${staleRun.runId}.json`), 'utf8'));
    assert.equal(staleManifest.status, 'failed');
    assert.equal(staleManifest.deliverablePath, undefined);
    const staleArtifactResponse = await fetch(`${apiOrigin}/api/v1/artifacts?runId=${encodeURIComponent(staleRun.runId)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    assert.equal((await staleArtifactResponse.json()).data.length, 0, 'A stale approval failure registered a deliverable artifact.');

    currentStage = 'final-analysis';
    await page.getByTestId('activity-btn-cockpit').click();
    const finalAnalysis = await analyzeSelected();
    currentStage = 'final-review-preparation';
    finalAnalysisId = finalAnalysis.evidence.analysisId;
    const finalRun = await prepareReview(finalAnalysis);
    finalRunId = finalRun.runId;
    assert.notEqual(finalRunId, staleRun.runId);
    currentStage = 'final-approval';
    await decide(finalAnalysisId, 'approved', 'Approve replayed numeric findings; leave model prose unverified.');
    await page.getByText(new RegExp(`Report generated for ${finalRunId}`), { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Download DOCX', exact: true }).waitFor();

    const manifestPath = path.join(projectRoot, '.maos', 'industrial-runs', `${finalRunId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.verdict, 'FAIL');
    assert.equal(manifest.details.engineeringVerdict, 'CRITICAL');
    assert.equal(manifest.details.agentAnalysis.analysisId, finalAnalysisId);
    assert.equal(manifest.details.agentAnalysis.explanationStatus, 'unverified');
    assert.equal(manifest.officeInput.proseBlocks[0].verifiedAgainstData, false);
    assert.equal(manifest.officeInput.proseBlocks[0].approvedByReviewer, true);
    assert.equal(sha256(fs.readFileSync(path.join(projectRoot, manifest.deliverablePath))), manifest.deliverableSha256);
    const artifactResponse = await fetch(`${apiOrigin}/api/v1/artifacts?runId=${encodeURIComponent(finalRunId)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    const artifactPayload = await artifactResponse.json();
    finalArtifact = artifactPayload.data.find((item) => item.path === manifest.deliverablePath);
    assert.equal(artifactResponse.status, 200);
    assert(finalArtifact && finalArtifact.runId === finalRunId);
    const unauthenticatedDownload = await fetch(`${apiOrigin}/api/v1/artifacts/${encodeURIComponent(finalArtifact.id)}/content`, {
      headers: { Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    assert.equal(unauthenticatedDownload.status, 401, 'Agent artifact download was accessible without the launcher session.');

    const downloadPath = path.join(projectRoot, '.maos', 'test-downloads', path.basename(manifest.deliverablePath));
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
    const downloadPromise = waitForDownload(app, downloadPath);
    currentStage = 'final-authenticated-download';
    await page.getByRole('button', { name: 'Download DOCX', exact: true }).click();
    const download = await downloadPromise;
    assert(download.triggered && download.state === 'completed', `Electron download failed: ${download.reason || download.state}`);
    assert.equal(path.resolve(download.filePath), path.resolve(downloadPath));
    const downloadedBytes = fs.readFileSync(downloadPath);
    finalDownloadHash = sha256(downloadedBytes);
    assert.equal(finalDownloadHash, manifest.deliverableSha256, 'Downloaded DOCX did not match the accepted manifest hash.');

    currentStage = 'final-audit-verification';
    const auditResponse = await fetch(`${apiOrigin}/api/v1/audit/export`, {
      headers: { Authorization: `Bearer ${token}`, Origin: uiOrigin, 'X-Project-Root': projectRoot, 'X-Project-ID': projectId },
    });
    const auditPayload = await auditResponse.json();
    assert.equal(auditResponse.status, 200);
    assert.equal(auditPayload.data.verification.valid, true);
    finalAudit = auditPayload.data.records.find((record) => record.data.event === 'JUDGED_RUN_COMPLETED' && record.data.runId === finalRunId);
    assert(finalAudit, 'The completed judged-run audit event was not persisted.');
    assert.deepEqual({
      analysisId: finalAudit.data.analysisId,
      agentRunId: finalAudit.data.agentRunId,
      receiptSha256: finalAudit.data.receiptSha256,
      verdict: finalAudit.data.verdict,
      deliverableSha256: finalAudit.data.deliverableSha256,
    }, {
      analysisId: finalAnalysisId,
      agentRunId: finalAnalysis.runId,
      receiptSha256: finalAnalysis.evidence.receiptSha256,
      verdict: 'FAIL',
      deliverableSha256: manifest.deliverableSha256,
    });
    const rejectedAudit = auditPayload.data.records.find((record) => record.data.event === 'JUDGED_RUN_REJECTED' && record.data.runId === rejectedRun.runId);
    assert.equal(rejectedAudit?.data.analysisId, rejectedAnalysis.evidence.analysisId, 'Rejected audit outcome lost its receipt identity.');
    const failedAudit = auditPayload.data.records.find((record) => record.data.event === 'JUDGED_RUN_FAILED' && record.data.runId === staleRun.runId);
    assert.equal(failedAudit?.data.analysisId, staleAnalysis.evidence.analysisId, 'Stale-failure audit outcome lost its receipt identity.');

    const storageState = await page.evaluate(() => ({
      url: location.href,
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      cookies: document.cookie,
    }));
    assert(!storageState.url.includes(token));
    assert(!storageState.url.includes(oldSessionToken));
    assert(!JSON.stringify(storageState.local).includes(token));
    assert(!JSON.stringify(storageState.local).includes(oldSessionToken));
    assert(!JSON.stringify(storageState.session).includes(token));
    assert(!JSON.stringify(storageState.session).includes(oldSessionToken));
    assert(!storageState.cookies.includes(token));
    assert(!storageState.cookies.includes(oldSessionToken));
    assert.equal(new URL(page.url()).origin, uiOrigin);
    assert(!eventSocket.href.includes(token));
    assert.equal(pageErrors.length, 0, `Renderer page errors: ${pageErrors.join(' | ')}`);
    assert.equal(mock.requests.length, 8, 'Mock inference requests do not cover fail, cancel, reject, stale and approve slices.');

    await app.close();
    app = undefined;
    serviceStopped = await fetch(`${apiOrigin}/api/v1/service/identity`, { signal: AbortSignal.timeout(1500) }).then(() => false).catch(() => true);
    uiStopped = await fetch(`${uiOrigin}/`, { signal: AbortSignal.timeout(1500) }).then(() => false).catch(() => true);
    assert(serviceStopped && uiStopped, 'Electron quit but left the project service or UI listener running.');
    await mock.close();
    mockStopped = true;
    const combinedLogs = mainLogs.join('');
    assert(!combinedLogs.includes(token), 'Launcher token appeared in captured Electron stdout/stderr.');
    assert(!combinedLogs.includes(oldSessionToken), 'Previous launcher token appeared in captured Electron stdout/stderr.');

    const report = {
      status: 'PASS',
      timestamp: new Date().toISOString(),
      browser: 'Visible Electron BrowserWindow controlled through Playwright; no personal browser profile.',
      topology: 'desktop/main.cjs -> ProjectHostLauncher -> ProjectServiceHost; renderer session initialized through the actual private preload IPC bridge.',
      inference: 'MOCK ONLY — loopback synthetic HTTP inference, no live Meta or other model inference.',
      projectRoot,
      projectId,
      uiOrigin,
      apiOrigin,
      apiPort: identity.servicePort,
      projectRootHash: identity.projectRootHash,
      serviceInstanceId: identity.serviceInstanceId,
      session: 'real launcher-issued session delivered to renderer through private IPC; token not recorded in evidence.',
      model: { requested: 'mock-configured-model-v1', providerReported: 'mock-returned-model-v1', requests: mock.requests.length },
      syntheticOracle: sourceExpectation,
      attempts: [
        { outcome: 'mock inference failure', httpStatus: failed.response.status(), acceptedSuccess: false },
        { outcome: 'client cancelled while mock inference was pending', acceptedSuccess: false },
        { outcome: 'rejected', runId: rejectedRun.runId, analysisId: rejectedAnalysis.evidence.analysisId, artifactCreated: false },
        { outcome: 'stale source approval refused', runId: staleRun.runId, analysisId: staleAnalysis.evidence.analysisId, artifactCreated: false },
        { outcome: 'approved and downloaded', runId: finalRunId, analysisId: finalAnalysisId, engineeringVerdict: manifest.verdict, artifactSha256: finalArtifact.hash, downloadSha256: finalDownloadHash },
      ],
      sameRunAudit: {
        event: finalAudit.data.event,
        runId: finalAudit.data.runId,
        analysisId: finalAudit.data.analysisId,
        agentRunId: finalAudit.data.agentRunId,
        receiptSha256: finalAudit.data.receiptSha256,
        deliverableSha256: finalAudit.data.deliverableSha256,
        chainVerified: auditPayload.data.verification.valid,
      },
      invalidRequestRejections: {
        missingSession: invalidStartMissing.response.status,
        invalidSession: invalidStartToken.response.status,
        wrongProject: invalidStartProject.response.status,
        wrongOrigin: invalidStartOrigin.response.status,
        unauthenticatedDownload: unauthenticatedDownload.status,
      },
      privacy: { tokenInUrl: false, tokenInPersistentStorage: false, tokenInCookies: false, tokenInCapturedElectronLogs: false },
      processCleanup: { electronClosed: true, projectServiceStopped: serviceStopped, uiServerStopped: uiStopped, mockStopped },
      processRestartResume,
      rustPrerequisite: { version: engineManifest.engineVersion, protocolVersion: engineManifest.protocolVersion, capturedBinarySha256: engineManifest.executableHash, trustManifestComparison: 'not performed' },
      evidencePath,
    };
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: report.status, evidencePath, finalRunId, finalAnalysisId, engineeringVerdict: manifest.verdict, downloadedSha256: finalDownloadHash })}\n`);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`Electron rehearsal failed at ${currentStage}: ${String(error?.message || error).replace(/[0-9a-f]{64}/gi, '[REDACTED]')}; requests=${JSON.stringify(diagnosticRequests)}; responses=${JSON.stringify(diagnosticResponses)}; requestFailures=${JSON.stringify(diagnosticFailures)}; pageErrors=${JSON.stringify(diagnosticPageErrors)}; modelPrompts=${JSON.stringify(diagnosticModelPrompts)}\n`);
  process.exitCode = 1;
});
