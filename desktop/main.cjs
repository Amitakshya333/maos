'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { URL } = require('node:url');
const ringOverlay = require('./ring-overlay-host.cjs');

// TASK RELEASE-GUI-01: packaged-app path fix. When running from source,
// __dirname is desktop/ and the backend lives at repo root. When packaged
// (app.isPackaged), backend/gui/profile/demo/engine files ship under
// process.resourcesPath. Dev behavior is unchanged.
function resolvePackageRoot() {
  try {
    if (process.versions.electron && require('electron').app.isPackaged) {
      return process.resourcesPath;
    }
  } catch {
    // Electron unavailable (unit tests) - fall through to source layout.
  }
  return path.resolve(__dirname, '..');
}

const packageRoot = resolvePackageRoot();

function findNodeExecutable() {
  const configured = process.env.MAOS_NODE_EXECUTABLE;
  const candidates = configured ? [configured] : process.versions.electron ? ['node'] : [process.execPath];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const major = /^v?(\d+)\./.exec((result.stdout || '').trim())?.[1];
    if (!result.error && result.status === 0 && Number(major) >= 20) return candidate;
  }
  throw new Error(
    'Node.js 20 or newer is required to start the authenticated MAOS service. Install Node.js and add it to PATH, or set MAOS_NODE_EXECUTABLE to node.exe.',
  );
}

function createUiServer(guiRoot, port = 0) {
  const root = fs.realpathSync(guiRoot);
  let apiPort;
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
    if (!apiPort) {
      res.writeHead(503).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(403).end();
      return;
    }
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      res.writeHead(403).end();
      return;
    }

    let file;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      file = fs.realpathSync(path.resolve(root, relative));
    } catch {
      res.writeHead(404).end();
      return;
    }
    const relative = path.relative(root, file);
    let isFile = false;
    try {
      isFile = fs.statSync(file).isFile();
    } catch {
      // The package asset may have been removed after the path check.
    }
    if (relative.startsWith('..') || path.isAbsolute(relative) || !isFile) {
      res.writeHead(404).end();
      return;
    }

    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' http://127.0.0.1:${apiPort} ws://127.0.0.1:${apiPort}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
    ].join('; ');
    const headers = {
      'Cache-Control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300',
      'Content-Security-Policy': csp,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res.writeHead(200, headers));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const port = server.address().port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        setApiPort: (port) => { apiPort = port; },
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

function buildBootstrap(host, session) {
  if (
    session.projectRootHash !== host.projectRootHash ||
    session.serviceInstanceId !== host.serviceInstanceId ||
    session.revoked ||
    session.expiresAt <= Date.now()
  ) {
    throw new Error('SESSION_IDENTITY_MISMATCH: Launcher session is not bound to the active project service.');
  }
  return {
    sessionToken: session.token,
    sessionId: session.sessionId,
    windowId: session.windowId,
    serviceInstanceId: host.serviceInstanceId,
    projectRootHash: host.projectRootHash,
    servicePort: host.port,
    baseUrl: `http://${host.host}:${host.port}`,
    projectRoot: host.projectRoot,
    projectId: host.project.config.projectName || 'default',
    expiresAt: session.expiresAt,
    protocolVersion: host.readiness.protocolVersion,
  };
}

function parseArgs(argv) {
  const args = { allowTemp: false, uiPort: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root') args.projectRoot = argv[++i];
    else if (argv[i] === '--allow-temp') args.allowTemp = true;
    else if (argv[i] === '--ui-port') {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--ui-port must be an available TCP port between 1 and 65535.');
      }
      args.uiPort = port;
    }
  }
  return args;
}

async function runElectron() {
  const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Tray } = require('electron');
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let launcher;
  let projectHost;
  let ui;
  let browserWindow;
  let sessionPartition;
  let bootstrap;
  let shutdownPromise;
  let shutdownComplete = false;

  const cleanup = async () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (projectHost) await projectHost.stop().catch(() => undefined);
      if (launcher) launcher.cleanupSync();
      if (ui) await ui.close().catch(() => undefined);
    })();
    return shutdownPromise;
  };

  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void cleanup().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());

  await app.whenReady();
  try {
    const args = parseArgs(process.argv.slice(process.defaultApp ? 2 : 1));
    const projectRoot = args.projectRoot || (await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Open MAOS project',
    })).filePaths[0];
    if (!projectRoot) return app.quit();

    const nodeExecutable = findNodeExecutable();
    const { ProjectHostLauncher } = require(path.join(packageRoot, 'dist/service/project-service/launcher.js'));
    const hostEntrypoint = path.join(packageRoot, 'dist/service/project-service/entrypoint.js');
    const guiRoot = path.join(packageRoot, 'dist/gui');
    if (!fs.existsSync(hostEntrypoint) || !fs.existsSync(path.join(guiRoot, 'index.html'))) {
      throw new Error('The installed MAOS package is incomplete. Rebuild or reinstall the package, then retry.');
    }

    ui = await createUiServer(guiRoot, args.uiPort);
    launcher = new ProjectHostLauncher({ executablePath: nodeExecutable, entrypointPath: hostEntrypoint });
    projectHost = await launcher.launch(projectRoot, {
      allowTemp: args.allowTemp,
      extraArgs: ['--allowed-origin', ui.origin],
    });
    ui.setApiPort(projectHost.port);
    const session = await projectHost.createSession(`desktop-${randomBytes(12).toString('hex')}`);
    bootstrap = buildBootstrap(projectHost, session);

    const overlayWebContents = () =>
      ringOverlay.overlayState.window && !ringOverlay.overlayState.window.isDestroyed()
        ? ringOverlay.overlayState.window.webContents
        : null;
    ipcMain.handle('maos:expand-ring', (event) => {
      if (!browserWindow || event.sender !== overlayWebContents()) {
        throw new Error('UNTRUSTED_RENDERER: expand is restricted to the active Ring overlay.');
      }
      ringOverlay.focusMainWindow(browserWindow);
    });
    // TASK DEV-C-FEEL-01 (feel 1: keyboard-first): Escape in the overlay
    // hides the window through the same toggle path (hide, not close).
    // Sender + origin checks mirror maos:expand-ring exactly.
    ipcMain.handle('maos:hide-ring-overlay', (event) => {
      if (!browserWindow || event.sender !== overlayWebContents()) {
        throw new Error('UNTRUSTED_RENDERER: hide is restricted to the active Ring overlay.');
      }
      ringOverlay.hideRingOverlay();
    });
    // TASK RING-DEV-B-01 (Day 1 fix): the overlay is a SECOND window with
    // its OWN main frame. The old check compared every sender against the
    // main window's mainFrame, so the overlay could never complete the
    // private-IPC session handshake. Each sender is now checked against
    // its own main frame; the loopback-origin check is unchanged.
    const expectedMainFrames = () => {
      const frames = [browserWindow.webContents.mainFrame];
      const overlay = overlayWebContents();
      if (overlay) {
        try { frames.push(overlay.mainFrame); } catch { /* overlay gone mid-check */ }
      }
      return frames;
    };
    ipcMain.handle('maos:initialize', (event) => {
      if (
        !browserWindow ||
        (event.sender !== browserWindow.webContents && event.sender !== overlayWebContents()) ||
        !expectedMainFrames().includes(event.senderFrame) ||
        new URL(event.senderFrame.url).origin !== ui.origin
      ) {
        throw new Error('UNTRUSTED_RENDERER: Session handoff is restricted to the active MAOS window.');
      }
      return bootstrap;
    });
    // TASK RING-DEV-B-01 (Day 2c): explicit user-triggered screen capture
    // for "What am I looking at?". The sandboxed renderer cannot call
    // getDisplayMedia (no picker exists in the overlay); the main process
    // captures the primary display via desktopCapturer ONLY when the user
    // clicks the button (this IPC is the trigger — never automatic, never
    // background). Returns PNG base64 held in memory; nothing is written
    // to disk and nothing leaves the machine (inspect_image is Dev C's
    // lane; until then the image chip is labelled local-only).
    ipcMain.handle('maos:capture-ring-screen', async (event) => {
      if (
        !browserWindow ||
        (event.sender !== browserWindow.webContents && event.sender !== overlayWebContents()) ||
        !expectedMainFrames().includes(event.senderFrame) ||
        new URL(event.senderFrame.url).origin !== ui.origin
      ) {
        throw new Error('UNTRUSTED_RENDERER: Screen capture is restricted to the active MAOS window.');
      }
      return ringOverlay.capturePrimaryDisplay({ desktopCapturer: require('electron').desktopCapturer, screen: require('electron').screen });
    });

    sessionPartition = `maos-${randomBytes(16).toString('hex')}`;
    browserWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 960,
      minHeight: 680,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: sessionPartition,
      },
    });
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browserWindow.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== ui.origin) event.preventDefault();
    });
    browserWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    await browserWindow.loadURL(`${ui.origin}/`);
    // TASK RING-DEV-B-01 (Day 1a): overlay companions — tray first (always
    // safe), then the global hotkey (loud failure, never silent).
    const overlayOptions = {
      BrowserWindow,
      ui,
      preloadPath: path.join(__dirname, 'preload.cjs'),
      sessionPartition,
    };
    const toggleOverlay = () => ringOverlay.toggleOverlay(ui, overlayOptions);
    const expandRing = () => {
      ringOverlay.focusMainWindow(browserWindow);
      try {
        const overlay = ringOverlay.overlayState.window;
        if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.loadURL(`${ui.origin}/${ringOverlay.OVERLAY_ROUTE}`);
      } catch { /* overlay navigation is best-effort */ }
    };
    ringOverlay.createRingTray({ Tray, Menu, nativeImage }, toggleOverlay, expandRing);
    ringOverlay.registerRingHotkey({ globalShortcut, dialog }, toggleOverlay);
    app.on('will-quit', () => {
      try { globalShortcut.unregisterAll(); } catch { /* best effort */ }
    });
  } catch (error) {
    dialog.showErrorBox('MAOS could not start securely', error instanceof Error ? error.message : String(error));
    app.quit();
  }
}

if (process.versions.electron && process.type === 'browser') void runElectron();

module.exports = { buildBootstrap, createUiServer, findNodeExecutable, parseArgs };
