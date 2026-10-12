'use strict';

const crypto = require('crypto');
const Store = require('electron-store');
const { safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  svnPath: '',
  launchAtLogin: true,
  clickAction: 'history', // 'history' | 'tortoise'
  silent: false,
  notifyErrors: true,
  maxLogEntries: 50,
  historyLimit: 300,
  timeoutSec: 60,
  dndUntil: 0,
  globalPaused: false,
  repoSort: 'created', // 'created' | 'name' | 'commit' | 'attention'
  favoritesOnly: false,
};

const store = new Store({
  name: 'config',
  defaults: {
    repos: [],
    state: {}, // repoId -> { lastRevision }
    history: [],
    settings: DEFAULT_SETTINGS,
  },
});

const MAX_INTERVAL_MIN = 7 * 24 * 60;
const URL_RE = /^(https?|svn|svn\+ssh|file):\/\/\S+$/i;

// ---------- 비밀번호 (Windows DPAPI 기반 safeStorage) ----------

function encrypt(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서는 비밀번호 암호화를 사용할 수 없습니다');
  return safeStorage.encryptString(plain).toString('base64');
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

// ---------- 설정 ----------

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...store.get('settings') };
}

function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur };
  if ('svnPath' in patch) next.svnPath = String(patch.svnPath || '').trim();
  if ('launchAtLogin' in patch) next.launchAtLogin = !!patch.launchAtLogin;
  if ('clickAction' in patch) next.clickAction = patch.clickAction === 'tortoise' ? 'tortoise' : 'history';
  if ('silent' in patch) next.silent = !!patch.silent;
  if ('notifyErrors' in patch) next.notifyErrors = !!patch.notifyErrors;
  if ('maxLogEntries' in patch) next.maxLogEntries = clampInt(patch.maxLogEntries, 1, 500, 50);
  if ('historyLimit' in patch) next.historyLimit = clampInt(patch.historyLimit, 10, 5000, 300);
  if ('timeoutSec' in patch) next.timeoutSec = clampInt(patch.timeoutSec, 5, 600, 60);
  if ('dndUntil' in patch) next.dndUntil = Number(patch.dndUntil) || 0;
  if ('globalPaused' in patch) next.globalPaused = !!patch.globalPaused;
  if ('repoSort' in patch) next.repoSort = ['created', 'name', 'commit', 'attention'].includes(patch.repoSort) ? patch.repoSort : 'created';
  if ('favoritesOnly' in patch) next.favoritesOnly = !!patch.favoritesOnly;
  store.set('settings', next);
  trimHistory(next.historyLimit);
  return next;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------- 저장소 ----------

function getRepos() {
  return store.get('repos');
}

function getRepo(id) {
  return getRepos().find((r) => r.id === id) || null;
}

function splitList(v, sep) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 입력 검증 + 정규화. 비밀번호는 별도 인자로 받아 암호화 저장 (빈 값이면 기존 유지)
 */
function buildRepo(draft, password, existing) {
  const name = String(draft.name || '').trim();
  const url = String(draft.url || '').trim().replace(/\/+$/, '');
  if (!name) throw new Error('저장소 이름을 입력하세요');
  if (!URL_RE.test(url)) throw new Error('SVN URL 형식이 올바르지 않습니다 (http(s)://, svn://, file:// 등)');

  const intervalMin = parseInt(draft.intervalMin, 10);
  if (!Number.isFinite(intervalMin) || intervalMin < 1 || intervalMin > MAX_INTERVAL_MIN) {
    throw new Error('감시 주기는 1분 ~ 7일 사이로 입력하세요');
  }

  const mode = draft.auth?.mode === 'app' ? 'app' : 'cached';
  const username = String(draft.auth?.username || '').trim();
  let passwordEnc = existing?.auth?.passwordEnc || '';
  if (mode === 'app') {
    if (!username) throw new Error('앱 인증을 선택한 경우 사용자 이름을 입력하세요');
    if (password) passwordEnc = encrypt(password);
    if (!passwordEnc) throw new Error('비밀번호를 입력하세요');
  } else {
    passwordEnc = '';
  }

  return {
    id: existing?.id || crypto.randomUUID(),
    name,
    url,
    intervalMin,
    paused: existing ? !!existing.paused : false,
    favorite: existing ? !!existing.favorite : false,
    localPath: String(draft.localPath || '').trim(),
    autoUpdate: !!draft.autoUpdate,
    trustCert: !!draft.trustCert,
    auth: { mode, username: mode === 'app' ? username : '', passwordEnc },
    filters: {
      excludeAuthors: splitList(draft.filters?.excludeAuthors, /[,\n]/),
      includePaths: splitList(draft.filters?.includePaths, /\n/),
    },
  };
}

function saveRepo(draft, password) {
  const repos = getRepos();
  const idx = draft.id ? repos.findIndex((r) => r.id === draft.id) : -1;
  const existing = idx >= 0 ? repos[idx] : null;
  const repo = buildRepo(draft, password, existing);

  const dup = repos.find((r) => r.id !== repo.id && r.url.toLowerCase() === repo.url.toLowerCase());
  if (dup) throw new Error(`이미 등록된 URL입니다 (${dup.name})`);

  if (existing) repos[idx] = repo;
  else repos.push(repo);
  store.set('repos', repos);

  // URL 이 바뀌면 리비전 기준점을 다시 잡음
  if (existing && existing.url !== repo.url) clearState(repo.id);
  return repo;
}

function deleteRepo(id) {
  store.set(
    'repos',
    getRepos().filter((r) => r.id !== id)
  );
  clearState(id);
  store.set(
    'history',
    getHistory().filter((h) => h.repoId !== id)
  );
}

function setRepoFavorite(id, favorite) {
  const repos = getRepos().map((r) => (r.id === id ? { ...r, favorite: !!favorite } : r));
  store.set('repos', repos);
  return repos.find((r) => r.id === id);
}

function setRepoPaused(id, paused) {
  const repos = getRepos().map((r) => (r.id === id ? { ...r, paused: !!paused } : r));
  store.set('repos', repos);
  return repos.find((r) => r.id === id);
}

/** svn 실행 시 넘길 접속 정보 (비밀번호 복호화). draftPassword 는 연결 테스트용 */
function getConn(repo, draftPassword) {
  const conn = { trustCert: !!repo.trustCert };
  if (repo.auth?.mode === 'app') {
    conn.username = repo.auth.username;
    conn.password = draftPassword || decrypt(repo.auth.passwordEnc);
  }
  return conn;
}

/** 렌더러로 보낼 때 암호문 제거 */
function toPublicRepo(repo) {
  const { auth, ...rest } = repo;
  return { ...rest, auth: { mode: auth.mode, username: auth.username, hasPassword: !!auth.passwordEnc } };
}

// ---------- 리비전 상태 ----------

function getState(id) {
  return store.get('state')[id] || null;
}

function setState(id, patch) {
  const all = store.get('state');
  all[id] = { ...all[id], ...patch, updatedAt: Date.now() };
  store.set('state', all);
}

function clearState(id) {
  const all = store.get('state');
  delete all[id];
  store.set('state', all);
}

// ---------- 히스토리 ----------

function getHistory() {
  return store.get('history');
}

function addHistory(repo, entries) {
  const existing = getHistory();
  const seen = new Set(existing.map((h) => `${h.repoId}:${h.revision}`));
  const items = entries
    .filter((e) => !seen.has(`${repo.id}:${e.revision}`))
    .map((e) => ({ ...e, repoId: repo.id, repoName: repo.name, receivedAt: Date.now() }));
  const merged = [...items, ...existing];
  store.set('history', merged.slice(0, getSettings().historyLimit));
  return items.length;
}

function trimHistory(limit) {
  const h = getHistory();
  if (h.length > limit) store.set('history', h.slice(0, limit));
}

function clearHistory() {
  store.set('history', []);
}

// ---------- 내보내기 / 가져오기 ----------

function exportData() {
  return {
    app: 'SVN Watcher',
    version: 1,
    exportedAt: new Date().toISOString(),
    // 비밀번호는 PC/사용자 단위로 암호화되므로 내보내지 않음
    repos: getRepos().map((r) => ({ ...r, id: undefined, auth: { mode: r.auth.mode, username: r.auth.username } })),
  };
}

function importData(data) {
  if (!data || !Array.isArray(data.repos)) throw new Error('SVN Watcher 설정 파일이 아닙니다');
  const repos = getRepos();
  const urls = new Set(repos.map((r) => r.url.toLowerCase()));
  let added = 0;
  let needPassword = 0;
  for (const raw of data.repos) {
    try {
      const appAuth = raw.auth?.mode === 'app';
      // 비밀번호가 없으므로 앱 인증 저장소는 '저장된 인증' + 일시정지 상태로 가져온 뒤 사용자가 입력
      const draft = { ...raw, auth: { mode: 'cached' } };
      const repo = buildRepo(draft, '', null);
      if (urls.has(repo.url.toLowerCase())) continue;
      if (appAuth) {
        repo.paused = true;
        repo.auth.username = raw.auth.username || '';
        repo.auth.mode = 'app';
        needPassword++;
      }
      repos.push(repo);
      urls.add(repo.url.toLowerCase());
      added++;
    } catch {
      /* 잘못된 항목은 건너뜀 */
    }
  }
  store.set('repos', repos);
  return { added, needPassword };
}

module.exports = {
  store,
  getSettings,
  saveSettings,
  getRepos,
  getRepo,
  saveRepo,
  buildRepo,
  deleteRepo,
  setRepoPaused,
  setRepoFavorite,
  getConn,
  toPublicRepo,
  getState,
  setState,
  getHistory,
  addHistory,
  clearHistory,
  exportData,
  importData,
};
