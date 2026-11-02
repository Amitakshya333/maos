/**
 * TASK RING-DEV-B-01 (Day 1a): Electron overlay companion helpers —
 * second window, tray icon, and configurable global hotkey.
 *
 * Pure helpers (no Electron import at top level) so they stay unit-testable
 * in plain Node; the Electron objects are injected by `desktop/main.cjs`.
 *
 * Security posture (mirrors the main window):
 * - contextIsolation on, sandbox on, nodeIntegration off, webSecurity on,
 *   same preload (private IPC only), same UI origin. The overlay NEVER
 *   receives the token in a URL: it loads `${ui.origin}/#/ring-overlay`
 *   (hash route only; the session handshake runs over IPC after load).
 * - Hotkey default is Ctrl+Shift+Space (configurable via
 *   MAOS_RING_HOTKEY). NOT Ctrl+Space (switches input language on Windows)
 *   and NOT Alt+Space (the Windows window menu). Registration failure is
 *   reported loudly (dialog + console), never silent.
 */
'use strict';

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';
const OVERLAY_ROUTE = '#/ring-overlay';

function ringHotkey() {
  const configured = process.env.MAOS_RING_HOTKEY;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return DEFAULT_HOTKEY;
}

/**
 * Creates the frameless always-on-top translucent overlay window loading
 * the same GUI bundle on the dedicated `#/ring-overlay` route.
 *
 * `sessionPartition` should be the SAME partition string as the main window
 * so both renderers share the loopback origin session; the private-IPC
 * session handshake (`maos:initialize`) still runs per-window after load.
 */
function createOverlayWindow({ BrowserWindow, ui, preloadPath, sessionPartition }) {
  const overlay = new BrowserWindow({
    width: 400,
    height: 640,
    minWidth: 320,
    minHeight: 480,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: sessionPartition,
    },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  if (typeof overlay.setVisibleOnAllWorkspaces === 'function') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== ui.origin) event.preventDefault();
  });
  overlay.webContents.on('will-attach-webview', (event) => event.preventDefault());
  return overlay;
}

const overlayState = { window: null, hotkey: null, hotkeyError: null, tray: null };

function toggleOverlay(ui, options) {
  const win = overlayState.window;
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    const created = createOverlayWindow(options);
    overlayState.window = created;
    if (typeof created.loadURL === 'function') {
      created.loadURL(`${ui.origin}/${OVERLAY_ROUTE}`);
    }
    if (typeof created.once === 'function') {
      created.once('ready-to-show', () => {
        if (typeof created.show === 'function') created.show();
      });
    }
    return 'shown';
  }
  if (typeof win.isVisible === 'function' && win.isVisible()) {
    if (typeof win.hide === 'function') win.hide();
    return 'hidden';
  }
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  return 'shown';
}

function focusMainWindow(mainWindow) {
  if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) return false;
  if (typeof mainWindow.show === 'function' && typeof mainWindow.isVisible === 'function' && !mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (typeof mainWindow.focus === 'function') mainWindow.focus();
  return true;
}

/**
 * Registers the global hotkey. Returns { hotkey, error }: error is set
 * (never silent) when registration fails so the main process can report
 * the reason via dialog.
 */
function registerRingHotkey({ globalShortcut, dialog }, toggle) {
  const hotkey = ringHotkey();
  let error = null;
  try {
    const ok = globalShortcut.register(hotkey, toggle);
    if (!ok) {
      error =
        `globalShortcut.register('${hotkey}') returned false — the accelerator is already taken ` +
        'or unsupported on this machine. Set MAOS_RING_HOTKEY to a free accelerator and restart.';
    }
  } catch (err) {
    error = `globalShortcut.register('${hotkey}') threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  overlayState.hotkey = error ? null : hotkey;
  overlayState.hotkeyError = error;
  if (error) {
    try {
      dialog.showErrorBox('Ring overlay hotkey unavailable', error);
    } catch {
      /* dialog failure must not crash startup */
    }
    console.error(`[ring-overlay] ${error}`);
  }
  return { hotkey, error };
}

function createRingTray({ Tray, Menu, nativeImage }, toggle, expand) {
  let tray = null;
  try {
    const icon = typeof nativeImage.createEmpty === 'function' ? nativeImage.createEmpty() : nativeImage;
    tray = new Tray(icon);
    if (typeof tray.setToolTip === 'function') tray.setToolTip('MAOS Ring');
    if (typeof tray.setContextMenu === 'function') {
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Ring overlay', click: () => toggle() },
          { label: 'Expand Ring to full app', click: () => expand() },
          { type: 'separator' },
          {
            label: 'Quit MAOS',
            click: () => {
              try {
                require('electron').app.quit();
              } catch {
                /* not under Electron in tests */
              }
            },
          },
        ]),
      );
    }
    if (typeof tray.on === 'function') tray.on('click', () => toggle());
  } catch (err) {
    console.error(`[ring-overlay] tray unavailable: ${err instanceof Error ? err.message : String(err)}`);
    tray = null;
  }
  overlayState.tray = tray;
  return tray;
}

/**
 * Explicit user-triggered screen capture (Day 2c). Runs in the MAIN process:
 * grabs the primary display via desktopCapturer at native size. Called only
 * from the `maos:capture-ring-screen` IPC handler, which itself only fires
 * when the user clicks "What am I looking at?" — never automatic.
 * Returns { pngBase64, width, height } or { dismissed, reason } — never
 * throws silently: failures carry a reason string for the loud UI message.
 */
async function capturePrimaryDisplay({ desktopCapturer, screen }) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const size = (primary && primary.size) || { width: 1920, height: 1080 };
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: size.width, height: size.height },
    });
  } catch (err) {
    return { dismissed: true, reason: 'Screen capture failed: ' + (err instanceof Error ? err.message : String(err)) };
  }
  const primarySource =
    sources.find((s) => {
      try {
        const did = typeof s.display_id === 'string' ? s.display_id : String(s.display_id || '');
        return did !== '' && Number(did) === primary.id;
      } catch { return false; }
    }) || sources[0];
  if (!primarySource || !primarySource.thumbnail || typeof primarySource.thumbnail.toPNG !== 'function') {
    return { dismissed: true, reason: 'Screen capture dismissed: no screen was shared.' };
  }
  const png = primarySource.thumbnail.toPNG();
  if (!png || png.length === 0) {
    return { dismissed: true, reason: 'Screen capture failed: the captured image was empty.' };
  }
  return {
    pngBase64: png.toString('base64'),
    width: primarySource.thumbnail.getSize().width,
    height: primarySource.thumbnail.getSize().height,
    displays: displays.length,
  };
}

module.exports = {
  DEFAULT_HOTKEY,
  OVERLAY_ROUTE,
  overlayState,
  ringHotkey,
  createOverlayWindow,
  toggleOverlay,
  focusMainWindow,
  registerRingHotkey,
  createRingTray,
  capturePrimaryDisplay,
};
