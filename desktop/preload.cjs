'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maosNative', Object.freeze({
  initialize: () => ipcRenderer.invoke('maos:initialize'),
}));
