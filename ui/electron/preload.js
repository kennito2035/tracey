'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracey', {
  getState: () => ipcRenderer.invoke('tracey:get-state'),
  setEnabled: (on) => ipcRenderer.invoke('tracey:set-enabled', on),
  setParams: (p) => ipcRenderer.invoke('tracey:set-params', p),
  calibrate: () => ipcRenderer.invoke('tracey:calibrate'),
  startCore: () => ipcRenderer.invoke('tracey:start-core'),
  stopCore: () => ipcRenderer.invoke('tracey:stop-core'),
  openFolder: () => ipcRenderer.invoke('tracey:open-folder'),
  clearCalibration: () => ipcRenderer.invoke('tracey:clear-calibration'),
  getPadState: () => ipcRenderer.invoke('tracey:get-pad-state'),
  setPadState: (s) => ipcRenderer.invoke('tracey:set-pad-state', s),
  contentOrigin: () => ipcRenderer.invoke('tracey:content-origin'),

  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('tracey:state', h);
    return () => ipcRenderer.removeListener('tracey:state', h);
  },
  onCalibration: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('tracey:calibration', h);
    return () => ipcRenderer.removeListener('tracey:calibration', h);
  },
  onResetView: (fn) => {
    const h = () => fn();
    ipcRenderer.on('tracey:reset-view', h);
    return () => ipcRenderer.removeListener('tracey:reset-view', h);
  },
  onOpenCalibration: (fn) => {
    const h = () => fn();
    ipcRenderer.on('tracey:open-calibration', h);
    return () => ipcRenderer.removeListener('tracey:open-calibration', h);
  },
  onWindowOrigin: (fn) => {
    const h = (_e, o) => fn(o);
    ipcRenderer.on('tracey:window-origin', h);
    return () => ipcRenderer.removeListener('tracey:window-origin', h);
  },
});
