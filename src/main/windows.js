'use strict';

const path = require('path');
const { BrowserWindow, shell } = require('electron');

let win = null;
let loaded = false;
let pendingNav = null;

function send(channel, payload) {
  if (win && !win.isDestroyed() && loaded) win.webContents.send(channel, payload);
}

function create() {
  win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 930,
    minHeight: 600,
    show: false,
    title: 'SVN Watcher',
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  loaded = false;

  // 외부 페이지 이동/새 창 차단 (링크는 기본 브라우저로)
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    loaded = true;
    if (pendingNav) {
      send('navigate', pendingNav);
      pendingNav = null;
    }
  });
  win.once('ready-to-show', () => win.show());
  // 닫으면 창은 파기하고 앱은 트레이에 남음 (메모리 절약)
  win.on('closed', () => {
    win = null;
    loaded = false;
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/**
 * @param {'repos'|'history'|'settings'} tab
 * @param {object} [params] 예: { repoId }
 */
function showMainWindow(tab = 'repos', params = {}) {
  const nav = { tab, ...params };
  if (!win) {
    pendingNav = nav;
    create();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (loaded) send('navigate', nav);
  else pendingNav = nav;
}

function getWindow() {
  return win;
}

module.exports = { showMainWindow, send, getWindow };
