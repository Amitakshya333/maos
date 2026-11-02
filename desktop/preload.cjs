'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maosNative', Object.freeze({
  initialize: () => ipcRenderer.invoke('maos:initialize'),
  // TASK RING-DEV-B-01: overlay asks the main window to focus the full Ring
  // view on the same thread. Private IPC only; no token, no URL, no shell.
  expandRing: () => ipcRenderer.invoke('maos:expand-ring'),
  // TASK DEV-C-FEEL-01 (feel 1: keyboard-first): Escape hides the overlay
  // through the same toggle path (no new close semantics).
  hideRingOverlay: () => ipcRenderer.invoke('maos:hide-ring-overlay'),
  // TASK RING-DEV-B-01 (Day 2c): explicit screenshot trigger. The main
  // process captures ONLY on this call (user button press); there is no
  // background capture path in the main process.
  captureRingScreen: () => ipcRenderer.invoke('maos:capture-ring-screen'),
}));
