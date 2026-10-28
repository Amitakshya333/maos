'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const DEMO_VIEWS = new Map([
  ['cockpit', 'Agent Cockpit View'],
  ['evidence', 'Evidence & Telemetry Workbench'],
  ['approvals', 'Approvals Queue View'],
  ['documents', 'Document Generator View'],
  ['audit', 'Audit & Sovereign Panel View'],
]);

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function requestJson(apiOrigin, uiOrigin, token, projectRoot, pathname, options = {}) {
  const headers = { ...options.headers };
  if (options.includeToken !== false) headers.Authorization = `Bearer ${token}`;
  if (options.includeRoot !== false) headers['X-Project-Root'] = options.projectHeader ?? projectRoot;
  if (options.origin !== null) headers.Origin = options.origin ?? uiOrigin;
  const response = await fetch(`${apiOrigin}${pathname}`, { headers });
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  return { response, body };
}

async function selectView(page, id) {
  const direct = page.getByTestId(`activity-btn-${id}`);
  if (await direct.count() && await direct.isVisible()) {
    await direct.click();
    return;
  }
  await page.getByTestId('more-modules-btn').click();
  await page.getByTestId(`more-module-item-${id}`).click();
}

async function verifyVisibleNavigation(page) {
  const expectedTestIds = [...DEMO_VIEWS.keys()].map((view) => `activity-btn-${view}`).sort();
  const activityItems = await page.locator('[data-testid^="activity-btn-"]:visible').evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-testid')).sort());
  assert.deepEqual(activityItems, expectedTestIds, 'The demo activity bar contains a missing, duplicate, or unfinished route.');
  assert.equal(await page.getByTestId('more-modules-btn').count(), 0, 'The demo exposes unfinished secondary modules.');

  let quickLinksChecked = 0;
  for (const [view, panelName] of DEMO_VIEWS) {
    await page.getByTestId(`activity-btn-${view}`).click();
    await page.getByRole('tabpanel', { name: panelName, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#/${view}`, `Activity navigation did not route to ${view}.`);

    const quickLinkIds = await page.locator('[data-testid^="quick-link-"]:visible').evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-testid')));
    for (const testId of quickLinkIds) {
      const targetView = testId.slice('quick-link-'.length);
      const targetPanel = DEMO_VIEWS.get(targetView);
      assert(targetPanel, `The demo sidebar exposes an unfinished or misrouted quick link: ${testId}.`);
      await page.getByTestId(`activity-btn-${view}`).click();
      await page.getByTestId(testId).click();
      await page.getByRole('tabpanel', { name: targetPanel, exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, `#/${targetView}`, `Sidebar navigation did not route to ${targetView}.`);
      quickLinksChecked += 1;
    }
  }
  await page.getByTestId('activity-btn-cockpit').click();
  await page.getByRole('tabpanel', { name: DEMO_VIEWS.get('cockpit'), exact: true }).waitFor();
  return { activityViews: [...DEMO_VIEWS.keys()], quickLinksChecked };
}

function waitForElectronDownload(app, { savePath, timeoutMs = 5000 }) {
  return app.evaluate(({ BrowserWindow }, options) => new Promise((resolve) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) return resolve({ triggered: false, reason: 'window-closed' });
    const downloadSession = window.webContents.session;
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      downloadSession.removeListener('will-download', onDownload);
      resolve(result);
    };
    const onDownload = (_event, item, webContents) => {
      if (webContents !== window.webContents) return;
      if (!options.savePath) {
        item.cancel();
        return finish({ triggered: true });
      }
      item.setSavePath(options.savePath);
      item.once('done', (_downloadEvent, state) => finish({
        triggered: true,
        state,
        filePath: item.getSavePath(),
        filename: item.getFilename(),
      }));
    };
    timer = setTimeout(() => finish({ triggered: false, reason: 'timeout' }), options.timeoutMs);
    downloadSession.on('will-download', onDownload);
  }), { savePath, timeoutMs });
}

async function run() {
  const projectRoot = path.resolve(argument('--project-root') || '');
  const scenario = argument('--scenario');
  const evidencePath = path.resolve(argument('--evidence-path') || '');
  const expectedScenarios = new Set(['source', 'rules', 'reject']);
  assert(projectRoot && evidencePath && expectedScenarios.has(scenario), 'Expected --project-root, --evidence-path and --scenario source|rules|reject.');
  assert(inside(fs.realpathSync.native(os.tmpdir()).toLowerCase(), fs.realpathSync.native(projectRoot).toLowerCase()), 'The browser project must be inside the system temporary directory.');
  assert(fs.existsSync(path.join(projectRoot, '.maos', 'maos.config.json')), 'The temporary Industrial profile is missing.');

  const packageRoot = path.resolve(argument('--package-root') || path.resolve(__dirname, '../..'));
  const mainPath = path.join(packageRoot, 'desktop', 'main.cjs');
  const sourcePath = path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv');
  const rulesPath = path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
  const mutatedPath = scenario === 'source' ? sourcePath : rulesPath;
  const originalBytes = fs.readFileSync(mutatedPath);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });

  let token;
  let apiOrigin;
  const apiProjectRoots = new Set();
  const sockets = [];
  const requestCaptures = [];
  const pageErrors = [];
  let app;
  let uiOrigin;
  let finalRunId;
  let negativeRunId;
  let identity;
  let artifact;
  let downloadedPath;
  let downloadHash;
  let failedDownloadWasSuppressed = false;
  let workflowFacts;
  let auditFacts;
  let navigationFacts;

  try {
    const uiPort = await reserveLoopbackPort();
    app = await electron.launch({
      executablePath: require('electron'),
      args: [mainPath, '--project-root', projectRoot, '--allow-temp', '--ui-port', String(uiPort)],
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    page.on('request', (request) => {
      requestCaptures.push((async () => {
        const headers = await request.allHeaders();
        if (headers['x-project-root']) apiProjectRoots.add(headers['x-project-root']);
        if (!token && headers.authorization?.startsWith('Bearer ')) {
          token = headers.authorization.slice('Bearer '.length);
          apiOrigin = new URL(request.url()).origin;
        }
      })());
    });
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => pageErrors.push(String(error.message).replace(/[0-9a-f]{64}/gi, '[REDACTED]')));
    await page.locator('main[role="main"]').waitFor();
    await page.getByTestId('role-onboarding-modal').waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
    const onboarding = page.getByRole('button', { name: /Skip \(Use Developer\)/ });
    if (await onboarding.isVisible().catch(() => false)) await onboarding.click();

    uiOrigin = new URL(page.url()).origin;
    assert.equal(uiOrigin, `http://127.0.0.1:${uiPort}`, 'The Electron renderer did not load at the requested loopback origin.');
    await page.getByRole('tabpanel', { name: DEMO_VIEWS.get('cockpit'), exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/cockpit', 'The Industrial demo did not open on its primary workflow view.');
    assert.equal(new URL(page.url()).username, '', 'Renderer URL contains credentials.');
    assert.equal(new URL(page.url()).password, '', 'Renderer URL contains credentials.');
    await selectView(page, 'cockpit');
    await page.getByRole('button', { name: 'Run T-07 Safety Audit', exact: true }).waitFor();
    try {
      await page.getByText(/LIVE STREAM/, { exact: false }).waitFor();
    } catch {
      const state = await page.locator('[title^="WebSocket:"]').getAttribute('title').catch(() => 'unavailable');
      const apiStatus = await page.locator('body').innerText().then((body) => body.split('\n').find((line) => line.startsWith('API: ')) || 'unavailable');
      const socketOrigins = sockets.map((url) => {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      });
      throw new Error(`LIVE STREAM did not connect; state=${state}; ${apiStatus}; websocket=${socketOrigins.join(',') || 'none'}; pageErrors=${pageErrors.join(' | ') || 'none'}`);
    }

    await page.waitForFunction(() => document.body.innerText.includes('API: HEALTHY'), null, { timeout: 30_000 });
    await Promise.all(requestCaptures);
    assert(token && /^[0-9a-f]{64}$/i.test(token), 'The renderer did not initialize a launcher-issued REST session.');
    assert(apiOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin), 'The runtime API origin is not loopback HTTP.');
    assert.notEqual(apiOrigin, uiOrigin, 'The test did not exercise the separate authenticated API service.');
    assert.deepEqual([...apiProjectRoots], [projectRoot], 'REST requests did not use the runtime project root.');
    assert(!page.url().includes(token), 'The launcher token appeared in the renderer URL.');

    const identityResult = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/service/identity');
    assert.equal(identityResult.response.status, 200, 'The authenticated service identity request failed.');
    identity = identityResult.body?.data;
    assert.equal(path.resolve(identity?.projectRoot), projectRoot, 'The running service belongs to a different project root.');
    assert.equal(identity?.host, '127.0.0.1', 'The authenticated service is not bound to IPv4 loopback.');
    assert.equal(identity?.servicePort, Number(new URL(apiOrigin).port), 'The API port did not come from the running service identity.');
    assert.equal(identity?.projectRootHash, sha256(projectRoot.toLowerCase()), 'The service project-root identity hash does not match this project.');

    const noSession = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/service/identity', { includeToken: false });
    const invalidSession = await requestJson(apiOrigin, uiOrigin, '0'.repeat(64), projectRoot, '/api/v1/service/identity');
    const wrongProject = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/service/identity', { projectHeader: path.join(projectRoot, 'wrong-project') });
    const missingOrigin = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/service/identity', { origin: null });
    const wrongOrigin = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/service/identity', { origin: 'http://127.0.0.1:1' });
    assert.equal(noSession.response.status, 401, 'A missing session was accepted.');
    assert.equal(invalidSession.response.status, 401, 'An invalid session was accepted.');
    assert.equal(wrongProject.response.status, 400, 'A wrong project root was accepted.');
    assert.equal(missingOrigin.response.status, 403, 'A missing renderer origin was accepted.');
    assert.equal(wrongOrigin.response.status, 403, 'A wrong renderer origin was accepted.');

    const eventSocket = () => sockets.map((url) => new URL(url)).find((url) => url.pathname === '/api/v1/events');
    await page.waitForFunction(() => document.body.innerText.includes('LIVE STREAM'), null, { timeout: 30_000 });
    const initialSocket = eventSocket();
    assert(initialSocket, 'The authenticated event stream did not connect.');
    assert.equal(initialSocket.origin, apiOrigin.replace(/^http:/, 'ws:'), 'The event stream did not use the runtime API port.');
    const projectId = initialSocket.searchParams.get('projectId');
    assert(projectId, 'The event stream did not carry the runtime project identity.');
    assert(!initialSocket.href.includes(token), 'The launcher token appeared in the event URL.');
    assert.equal(projectId, 'maos-industrial-demo', 'The browser rehearsal did not use the Industrial demo identity.');
    navigationFacts = await verifyVisibleNavigation(page);

    async function startPendingRun() {
      await selectView(page, 'cockpit');
      const responsePromise = page.waitForResponse((response) =>
        response.url().endsWith('/api/v1/industrial/judged-runs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Run T-07 Safety Audit', exact: true }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 202, 'Synthetic analysis did not pause for human review.');
      const section = page.getByRole('region', { name: 'T-07 judged run' });
      await section.getByText(/PENDING APPROVAL · FAIL/).waitFor();
      const match = /Run\s+(judged-run-[a-zA-Z0-9-]+)/.exec(await section.innerText());
      assert(match, 'The pending run ID was not visible in Cockpit.');
      return match[1];
    }

    async function resumePendingReview(runId) {
      await page.getByRole('link', { name: 'Review the evidence' }).click();
      await page.getByRole('button', { name: 'Review & Approve' }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Refresh approvals' }).click();
      await page.getByRole('button', { name: 'Review & Approve' }).waitFor();
      await selectView(page, 'cockpit');
      const section = page.getByRole('region', { name: 'T-07 judged run' });
      await section.getByText(/PENDING APPROVAL · FAIL/).waitFor();
      assert((await section.innerText()).includes(runId), 'Reload did not resume the same pending run.');
      await page.getByRole('link', { name: 'Review the evidence' }).click();
      await page.getByRole('button', { name: 'Review & Approve' }).waitFor();
    }

    async function submitDecision(decision, notes) {
      if (decision === 'rejected') await page.getByRole('button', { name: 'Reject', exact: true }).click();
      else await page.getByRole('button', { name: 'Review & Approve', exact: true }).click();
      await page.locator('form input[type="radio"][value="' + (decision === 'approved' ? 'approved' : 'rejected') + '"]').check();
      await page.locator('form input[type="text"]').fill('release-reviewer');
      await page.locator('form textarea').first().fill(notes);
      await page.getByRole('button', { name: decision === 'approved' ? 'Confirm Approval' : 'Confirm Rejection', exact: true }).click();
    }

    negativeRunId = await startPendingRun();
    await resumePendingReview(negativeRunId);
    if (scenario === 'reject') {
      await submitDecision('rejected', 'Rejected for the release rehearsal.');
      await page.getByText(`Approval rejected by release-reviewer. T-07 run ${negativeRunId} is rejected.`, { exact: true }).waitFor();
      await selectView(page, 'cockpit');
      const section = page.getByRole('region', { name: 'T-07 judged run' });
      await section.getByText(/REJECTED · FAIL/).waitFor();
      assert(!(await section.innerText()).includes('Report:'), 'A rejected run was presented with a report.');
      const rejected = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial-runs', `${negativeRunId}.json`), 'utf8'));
      assert.equal(rejected.status, 'rejected');
      assert(!fs.existsSync(path.join(projectRoot, 'artifacts', 'generated', `${negativeRunId}-turbine_safety_approval_note.docx`)), 'Rejected run generated a DOCX.');
    } else {
      const changedText = scenario === 'source'
        ? Buffer.concat([originalBytes, Buffer.from('\n')])
        : Buffer.from(originalBytes.toString('utf8').replace('"critical": 7.1', '"critical": 7.2'));
      assert.notDeepEqual(changedText, originalBytes, 'The fixture/rules mutation did not change bytes.');
      if (scenario === 'rules') assert(changedText.toString('utf8').includes('"critical": 7.2'), 'The safety rule was not changed.');
      fs.writeFileSync(mutatedPath, changedText);
      try {
        await submitDecision('approved', 'Reviewed the prepared synthetic evidence.');
        await page.getByText(new RegExp(`source changed after analysis: demo/industrial/${scenario === 'source' ? 'turbine_vibration_log.csv' : 'safety_thresholds.json'}`), { exact: false }).waitFor();
        const body = await page.locator('body').innerText();
        assert(!/report generated/i.test(body), 'A stale approval failure was presented as report success.');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      } finally {
        fs.writeFileSync(mutatedPath, originalBytes);
      }
      await selectView(page, 'cockpit');
      const section = page.getByRole('region', { name: 'T-07 judged run' });
      await section.getByText(/FAILED · FAIL/).waitFor();
      const failed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial-runs', `${negativeRunId}.json`), 'utf8'));
      assert.equal(failed.status, 'failed');
      assert(!failed.deliverablePath, 'A stale run claims a deliverable path.');
      assert(!fs.existsSync(path.join(projectRoot, 'artifacts', 'generated', `${negativeRunId}-turbine_safety_approval_note.docx`)), 'A stale approval generated a DOCX.');
      await page.reload();
      await page.getByRole('region', { name: 'T-07 judged run' }).getByText(/FAILED · FAIL/).waitFor();
    }

    finalRunId = await startPendingRun();
    await resumePendingReview(finalRunId);
    await submitDecision('approved', 'Approved the synthetic T-07 evidence for report generation.');
    await page.getByText(new RegExp(`Report generated for ${finalRunId}`), { exact: false }).waitFor();
    await selectView(page, 'cockpit');
    const completedSection = page.getByRole('region', { name: 'T-07 judged run' });
    await completedSection.getByText(/COMPLETED · FAIL/).waitFor();
    assert((await completedSection.innerText()).includes(finalRunId), 'Cockpit shows a different completed run.');

    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, '.maos', 'industrial-runs', `${finalRunId}.json`), 'utf8'));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.verdict, 'FAIL', 'Successful workflow execution must preserve the critical engineering verdict.');
    assert(manifest.deliverablePath && manifest.auditExportPath, 'Completed manifest is missing report or audit export.');
    assert(fs.existsSync(path.join(projectRoot, manifest.deliverablePath)), 'The completed report is missing.');
    assert(fs.existsSync(path.join(projectRoot, manifest.auditExportPath)), 'The audit export is missing.');
    const reportBytes = fs.readFileSync(path.join(projectRoot, manifest.deliverablePath));
    assert.equal(sha256(reportBytes), manifest.deliverableSha256, 'The saved report hash does not match the manifest.');

    const artifactsResponse = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/generator/artifacts');
    assert.equal(artifactsResponse.response.status, 200, 'Authenticated artifact history request failed.');
    artifact = artifactsResponse.body?.data?.find((item) => item.runId === finalRunId);
    assert(artifact, 'The finalized report artifact is not linked to the completed run ID.');
    assert.equal(artifact.path, manifest.deliverablePath);
    assert.equal(artifact.hash, manifest.deliverableSha256);

    const auditResponse = await requestJson(apiOrigin, uiOrigin, token, projectRoot, '/api/v1/audit/export');
    assert.equal(auditResponse.response.status, 200, 'Authenticated audit export request failed.');
    auditFacts = auditResponse.body?.data;
    assert(auditFacts?.verification?.valid, 'The API audit export is not verified.');
    assert(auditFacts.records.some((record) => JSON.stringify(record).includes(finalRunId)), 'Audit records do not link to the completed run ID.');

    await selectView(page, 'documents');
    await page.getByRole('button', { name: /Deliverables \(/ }).click();
    const filename = path.basename(artifact.path);
    const downloadButton = page.getByRole('button', { name: `Download ${filename}`, exact: true });
    await downloadButton.waitFor();
    const artifactUrl = `${apiOrigin}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`;
    const failOnce = (route) => route.abort('failed');
    await page.route(artifactUrl, failOnce, { times: 1 });
    const failedDownloadEvent = waitForElectronDownload(app, { timeoutMs: 1500 });
    await downloadButton.click();
    await page.getByRole('alert').filter({ hasText: 'Download failed' }).waitFor();
    failedDownloadWasSuppressed = !(await failedDownloadEvent).triggered;
    assert(failedDownloadWasSuppressed, 'A failed artifact request triggered a native download.');
    await page.unroute(artifactUrl);
    downloadedPath = path.join(projectRoot, '.maos', 'test-downloads', `${finalRunId}.docx`);
    fs.mkdirSync(path.dirname(downloadedPath), { recursive: true });
    const downloadPromise = waitForElectronDownload(app, { savePath: downloadedPath, timeoutMs: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    assert(download.triggered && download.state === 'completed', `Electron artifact download did not complete: ${download.reason || download.state}`);
    assert.equal(path.resolve(download.filePath), path.resolve(downloadedPath), 'Electron saved the browser artifact outside the temporary project.');
    assert.equal(download.filename, filename, 'Electron download filename does not match the artifact record.');
    const downloadedBytes = fs.readFileSync(downloadedPath);
    downloadHash = sha256(downloadedBytes);
    assert.equal(downloadHash, manifest.deliverableSha256, 'Browser-downloaded DOCX bytes differ from the final artifact.');

    await selectView(page, 'audit');
    await page.getByTestId('btn-verify-chain').click();
    await page.getByTestId('audit-chain-badge').filter({ hasText: 'CHAIN: VERIFIED' }).waitFor();
    const recordCount = Number(await page.getByTestId('audit-record-count').innerText());
    assert(recordCount > 0, 'The UI audit chain contains no records.');

    const storageState = await page.evaluate(() => ({
      url: location.href,
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      cookies: document.cookie,
    }));
    assert(!storageState.url.includes(token), 'The launcher token appeared in the browser URL.');
    assert(!JSON.stringify(storageState.local).includes(token), 'The launcher token appeared in localStorage.');
    assert(!JSON.stringify(storageState.session).includes(token), 'The launcher token appeared in sessionStorage.');
    assert(!storageState.cookies.includes(token), 'The launcher token appeared in a browser cookie.');
    assert.equal(new URL(page.url()).origin, uiOrigin, 'The browser origin changed during the workflow.');

    const projectIdFromEvents = eventSocket()?.searchParams.get('projectId');
    assert.equal(projectIdFromEvents, projectId, 'The event stream project identity changed during the run.');
    workflowFacts = {
      runId: finalRunId,
      status: manifest.status,
      verdict: manifest.verdict,
      artifactId: artifact.id,
      artifactPath: artifact.path,
      artifactSha256: artifact.hash,
      auditRecords: auditFacts.records.length,
      uiAuditRecords: recordCount,
      downloadedBytes: downloadedBytes.length,
      downloadedSha256: downloadHash,
    };

    await app.close();
    app = undefined;
    const serviceStopped = await fetch(`${apiOrigin}/api/v1/service/identity`, { signal: AbortSignal.timeout(1500) })
      .then(() => false).catch(() => true);
    const uiStopped = await fetch(`${uiOrigin}/`, { signal: AbortSignal.timeout(1500) })
      .then(() => false).catch(() => true);
    assert(serviceStopped && uiStopped, 'Electron quit but left a test service listening.');

    const result = {
      result: 'PASS',
      scenario,
      negativeRunId,
      finalRunId,
      workflowStatus: 'completed',
      engineeringVerdict: 'FAIL',
      browserOrigin: uiOrigin,
      apiOrigin,
      projectRoot,
      projectId,
      serviceInstanceId: identity.serviceInstanceId,
      projectRootHash: identity.projectRootHash,
      restSession: 'authenticated via private launcher IPC',
      eventSession: 'connected with runtime project ID',
      missingInvalidSessionRejected: noSession.response.status === 401 && invalidSession.response.status === 401,
      missingWrongOriginRejected: missingOrigin.response.status === 403 && wrongOrigin.response.status === 403,
      wrongProjectRejected: wrongProject.response.status === 400,
      tokenAbsentFromUrlStorageCookies: true,
      failedDownloadReportedWithoutDownload: failedDownloadWasSuppressed,
      downloadTransport: 'Electron BrowserWindow session will-download',
      downloadSha256: downloadHash,
      auditChain: 'CHAIN: VERIFIED',
      sameRunArtifactAndAuditLinkage: true,
      navigationFacts,
      serviceCleanup: 'UI and API listeners closed',
      workflowFacts,
      evidencePath,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    fs.writeFileSync(mutatedPath, originalBytes);
    if (app) await app.close().catch(() => undefined);
    if (token) token = undefined;
  }
}

run().catch((error) => {
  const message = String(error?.message || error).replace(/[0-9a-f]{64}/gi, '[REDACTED_TOKEN]');
  process.stderr.write(`Browser rehearsal failed: ${message}\n`);
  process.exitCode = 1;
});
