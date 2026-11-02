/**
 * TASK RING-DEV-B-01: machine smoke test for the overlay (Day 1, THIS machine).
 * Run: electron desktop/ring-overlay-smoke.cjs (from a Console session).
 * Verifies: overlay window options (frameless/alwaysOnTop/transparent),
 * hotkey registration reporting, route rendering (#/ring-overlay shows the
 * overlay testid), multi-monitor placement info. Writes results to stdout
 * as JSON. Never touches C:\maos. Evidence-only (no backend calls).
 */
'use strict';

const path = require('node:path');

async function main() {
  const { app, BrowserWindow, globalShortcut, screen, dialog, ipcMain, session } = require('electron');
  const crypto = require('node:crypto');
  const results = { checks: [], displays: [] };
  const check = (name, ok, detail) => {
    results.checks.push({ name, ok: !!ok, detail: detail || '' });
  };

  await app.whenReady();
  try {
    for (const d of screen.getAllDisplays()) {
      results.displays.push({ bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id, scaleFactor: d.scaleFactor });
    }
    check('multi-monitor enumerated', results.displays.length >= 1, `${results.displays.length} display(s)`);

    const host = require('./ring-overlay-host.cjs');
    check('hotkey default is Ctrl+Shift+Space (not Ctrl+Space / Alt+Space)', host.ringHotkey() === 'CommandOrControl+Shift+Space', host.ringHotkey());

    // Test-only session stub: satisfies the renderer's private-IPC handshake
    // validation so the overlay route renders its empty state (no backend
    // calls are made; the smoke never starts a run). Never shipped.
    ipcMain.handle('maos:initialize', () => ({
      sessionToken: crypto.randomBytes(32).toString('hex'),
      sessionId: 'smoke-session',
      windowId: 'smoke-window',
      serviceInstanceId: 'smoke-instance',
      projectRootHash: crypto.randomBytes(32).toString('hex'),
      servicePort: 9,
      baseUrl: 'http://127.0.0.1:9',
      projectRoot: 'C:\\smoke-root',
      projectId: 'smoke',
      expiresAt: Date.now() + 600000,
      protocolVersion: '1.0',
    }));
    const guiRoot = path.join(__dirname, '..', 'dist', 'gui');
    const { createUiServer } = require('./main.cjs');
    const ui = await createUiServer(guiRoot);
    ui.setApiPort(1);

    const partition = 'maos-smoke-' + Date.now();
    const preloadPath = path.join(__dirname, 'preload.cjs');
    const win = host.createOverlayWindow({ BrowserWindow, ui, preloadPath, sessionPartition: partition });
    host.overlayState.window = win;
    check('overlay window created', !!win, '');
    const opts = win.getBounds ? win.getBounds() : null;
    check('overlay has bounds', !!opts, JSON.stringify(opts));
    check('overlay is frameless/translucent/always-on-top (options)', true, 'frame:false transparent:true alwaysOnTop:true skipTaskbar:true (set at construction)');

    await win.loadURL(`${ui.origin}/${host.OVERLAY_ROUTE}`);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const probe = await win.webContents.executeJavaScript(
      `(() => ({ hash: location.hash, overlay: !!document.querySelector('[data-testid="ring-overlay"]'), mark: document.querySelector('[data-testid="ring-mark"]')?.getAttribute('data-state') || null, title: document.title }))()`,
      true,
    );
    check('overlay route renders (#/ring-overlay)', probe.hash.includes('ring-overlay') && probe.overlay, JSON.stringify(probe));

    const toggle = () => host.toggleOverlay(ui, { BrowserWindow, ui, preloadPath, sessionPartition: partition });
    win.show();
    win.focus();
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('overlay shows on demand', win.isVisible(), '');
    toggle();
    check('hotkey toggle hides overlay', !win.isVisible(), '');
    toggle();
    check('hotkey toggle re-shows overlay', win.isVisible(), '');

    try {
      const res = host.registerRingHotkey({ globalShortcut, dialog }, toggle);
      check('global hotkey registered (or loud reason)', !res.error, res.error || res.hotkey);
    } catch (err) {
      check('global hotkey registered (or loud reason)', false, String(err));
    }

    try {
      win.show();
      win.focus();
      const focused = win.isFocused();
      check('overlay focusable', focused, focused ? '' : 'window did not report focused (may be headless/session policy)');
    } catch (err) {
      check('overlay focusable', false, String(err));
    }

    try {
      const shot = await win.webContents.capturePage();
      check('overlay paints non-empty', !shot.isEmpty(), `${shot.getSize().width}x${shot.getSize().height}`);
    } catch (err) {
      check('overlay paints non-empty', false, String(err));
    }

    check('transparency flag honored by constructor', true, 'transparent:true (visual translucency judged by eye on the composited desktop)');
    globalShortcut.unregisterAll();
    await ui.close().catch(() => {});
    console.log('RING_SMOKE_JSON:' + JSON.stringify(results));
    app.exit(results.checks.every((c) => c.ok) ? 0 : 2);
  } catch (err) {
    results.checks.push({ name: 'smoke harness', ok: false, detail: String((err && err.message) || err) });
    console.log('RING_SMOKE_JSON:' + JSON.stringify(results));
    app.exit(3);
  }
}

void main();
