'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  getHistory: () => call('history:get'),
  clearHistory: () => call('history:clear'),
  markSeen: () => call('history:seen'),

  saveRepo: (draft, password) => call('repo:save', draft, password),
  deleteRepo: (id) => call('repo:delete', id),
  setPaused: (id, paused) => call('repo:pause', id, paused),
  setFavorite: (id, fav) => call('repo:favorite', id, fav),
  sync: (id) => call('repo:sync', id),
  update: (id) => call('repo:update', id),
  testConnection: (draft, password) => call('repo:test', draft, password),
  openTortoise: (id, range) => call('repo:tortoise', id, range),
  openExplorer: (id) => call('repo:explorer', id),
  openCmd: (id) => call('repo:cmd', id),
  openWarp: (id) => call('repo:warp', id),
  openSolution: (id, index) => call('repo:vs', id, index),
  openVsCode: (id) => call('repo:vscode', id),
  openTortoiseStatus: (id) => call('repo:repostatus', id),
  showRepoMenu: (id) => call('repo:menu', id),
  refreshLocal: (id, force) => call('local:refresh', id, force),

  saveSettings: (patch) => call('settings:save', patch),
  checkSvn: () => call('svn:check'),
  pickFolder: (current) => call('dialog:folder', current),
  pickSvnExe: () => call('dialog:svnExe'),
  exportConfig: () => call('config:export'),
  importConfig: () => call('config:import'),

  onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, nav) => cb(nav)),
});
