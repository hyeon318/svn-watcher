'use strict';

const fs = require('fs');
const { ipcMain, dialog, BrowserWindow } = require('electron');

/**
 * 모든 핸들러는 { ok, data } / { ok:false, error } 로 감싸서 반환 (preload 에서 풀어줌)
 * @param {object} c main.js 의 controller
 */
function registerIpc(c) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(event, ...args) };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    });

  const parentOf = (event) => BrowserWindow.fromWebContents(event.sender);

  handle('state:get', () => c.snapshot());
  handle('history:get', () => c.config.getHistory());
  handle('history:clear', () => {
    c.config.clearHistory();
    c.changed();
  });
  handle('history:seen', () => c.markSeen());

  handle('repo:save', (e, draft, password) => c.saveRepo(draft, password));
  handle('repo:delete', (e, id) => c.deleteRepo(id));
  handle('repo:pause', (e, id, paused) => c.setPaused(id, paused));
  handle('repo:favorite', (e, id, fav) => c.setFavorite(id, fav));
  handle('repo:sync', (e, id) => (id ? c.syncOne(id) : c.syncAll()));
  handle('repo:update', (e, id) => c.updateWorkingCopy(id));
  handle('repo:test', (e, draft, password) => c.testConnection(draft, password));
  handle('repo:tortoise', (e, id, rev) => c.openTortoise(id, rev));
  handle('repo:explorer', (e, id) => c.openExplorer(id));
  handle('repo:cmd', (e, id) => c.openCmd(id));
  handle('repo:warp', (e, id) => c.openWarp(id));
  handle('repo:vs', (e, id, index) => c.openSolution(id, Number(index) || 0));
  handle('repo:vscode', (e, id) => c.openVsCode(id));
  handle('repo:repostatus', (e, id) => c.openTortoiseStatus(id));
  handle('repo:menu', (e, id) => c.showRepoMenu(e, id));
  handle('local:refresh', (e, id, force) => (id ? c.refreshLocal(id, { force }) : c.refreshAllLocal({ force })));

  handle('settings:save', (e, patch) => c.saveSettings(patch));
  handle('svn:check', () => c.checkSvn());

  handle('dialog:folder', async (event, current) => {
    const r = await dialog.showOpenDialog(parentOf(event), {
      title: '작업 복사본 폴더 선택',
      defaultPath: current || undefined,
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:svnExe', async (event) => {
    const r = await dialog.showOpenDialog(parentOf(event), {
      title: 'svn.exe 선택',
      filters: [{ name: 'svn.exe', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('config:export', async (event) => {
    const r = await dialog.showSaveDialog(parentOf(event), {
      title: '설정 내보내기',
      defaultPath: 'SVN-Watcher-repos.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(c.config.exportData(), null, 2), 'utf8');
    return r.filePath;
  });

  handle('config:import', async (event) => {
    const r = await dialog.showOpenDialog(parentOf(event), {
      title: '설정 가져오기',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return null;
    const raw = fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, '');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('JSON 파일을 읽을 수 없습니다');
    }
    return c.importConfig(data);
  });
}

module.exports = { registerIpc };
