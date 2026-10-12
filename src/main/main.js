'use strict';

const fs = require('fs');
const path = require('path');
const { findSolutions } = require('./findSolutions');
const { spawn } = require('child_process');
const { app, powerMonitor, shell, clipboard, Menu, BrowserWindow } = require('electron');

const APP_ID = 'com.hyeon318.svnwatcher';
const APP_NAME = 'SVN Watcher';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  // 예전 RingTheSVN 설정을 새 폴더로 1회 복사 (config 를 읽기 전, app ready 전에 실행)
  let migratedFrom = null;
  try {
    migratedFrom = require('./migrate').migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'));
  } catch (err) {
    console.error(err);
  }

  // electron-store 는 app 준비 전에 require 해도 되지만 safeStorage 사용은 ready 이후
  const config = require('./config');
  const { SvnClient } = require('./svn');
  const { PollerManager } = require('./poller');
  const { Notifier } = require('./notifier');
  const { TrayController } = require('./tray');
  const { showMainWindow, send } = require('./windows');
  const { registerIpc } = require('./ipc');
  const { formatCommitNotification } = require('./format');

  // Windows 토스트 알림은 AppUserModelId 가 설치 바로가기와 일치해야 표시됨
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

  // 포터블 exe 는 임시 폴더에 풀려서 실행되므로 원래 exe 경로를 따로 사용
  const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE || '';
  const launcherExe = PORTABLE_EXE || process.execPath;

  const svn = new SvnClient(() => config.getSettings());
  let tray = null;
  let manager = null;
  let notifier = null;
  let unseen = 0;
  let svnInfo = { ok: false, version: '', path: '', error: '확인 전' };
  let tortoisePath = SvnClient.findTortoiseProc();
  let dndTimer = null;

  // ---------- 화면 갱신 (status 이벤트가 몰려도 1회로 합침) ----------
  let changeTimer = null;
  function changed() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      tray?.render({
        repos: config.getRepos(),
        statuses: manager?.statuses() || {},
        unseen,
        dndUntil: config.getSettings().dndUntil,
        globalPaused: config.getSettings().globalPaused,
        svnOk: svnInfo.ok,
        tortoise: !!tortoisePath,
      });
      send('changed');
    }, 150);
  }

  function snapshot() {
    const statuses = manager?.statuses() || {};
    return {
      repos: config.getRepos().map((r) => ({
        ...config.toPublicRepo(r),
        status: { ...statuses[r.id], lastCheckedAt: statuses[r.id]?.lastCheckedAt || config.getState(r.id)?.lastCheckedAt || null },
        lastRevision: config.getState(r.id)?.lastRevision ?? null,
        lastCommit: config.getState(r.id)?.lastCommit ?? null,
        local: localStatus.get(r.id) || null,
      })),
      settings: config.getSettings(),
      svn: svnInfo,
      tortoise: !!tortoisePath,
      unseen,
      appVersion: app.getVersion(),
      encryptionAvailable: require('electron').safeStorage.isEncryptionAvailable(),
    };
  }

  function isMuted() {
    return config.getSettings().dndUntil > Date.now();
  }

  // ---------- 폴링 콜백 ----------

  async function onCommits(repo, entries, range) {
    const added = config.addHistory(repo, entries);
    unseen += added;
    const { title, body } = formatCommitNotification(repo, entries, range);
    notifier.show({
      title,
      body,
      onClick: () => {
        if (config.getSettings().clickAction === 'tortoise' && tortoisePath) {
          openTortoise(repo.id, { from: range.from, to: range.to });
        } else {
          showMainWindow('history', { repoId: repo.id });
        }
      },
    });
    if (repo.autoUpdate && repo.localPath) {
      updateWorkingCopy(repo.id, { auto: true }).catch(() => {});
    }
    changed();
  }

  function onError(repo, err, consecutive) {
    // 상태가 정상 → 오류로 바뀐 첫 번째에만 알림 (반복 실패 스팸 방지)
    if (consecutive === 1 && config.getSettings().notifyErrors) {
      notifier.show({
        title: `${repo.name} · 확인 실패`,
        body: `${err.message}\n다음 확인까지 간격을 늘려 재시도합니다.`,
        onClick: () => showMainWindow('repos', { repoId: repo.id }),
      });
    }
  }

  // ---------- 동작 ----------

  async function checkSvn() {
    try {
      const version = await svn.version();
      const [maj, min] = version.split('.').map(Number);
      const tooOld = maj < 1 || (maj === 1 && min < 10);
      svnInfo = {
        ok: !tooOld,
        version,
        path: svn.resolveSvnPath(),
        error: tooOld ? `svn ${version} 은 지원하지 않습니다 (1.10 이상 필요)` : '',
      };
    } catch (err) {
      svnInfo = { ok: false, version: '', path: svn.resolveSvnPath(), error: err.message };
    }
    tortoisePath = SvnClient.findTortoiseProc();
    changed();
    return svnInfo;
  }

  // ---------- 로컬 작업 복사본 상태 (svn status, 서버 접속 없음) ----------

  const LOCAL_MIN_GAP = 30 * 1000;
  const localStatus = new Map(); // id -> { checking, checkedAt, error, total, counts, files, wcRevision }
  const localRunning = new Map();

  function refreshLocal(id, { force = false } = {}) {
    const repo = config.getRepo(id);
    if (!repo?.localPath) {
      localStatus.delete(id);
      return Promise.resolve(null);
    }
    if (localRunning.has(id)) return localRunning.get(id);
    const prev = localStatus.get(id);
    if (!force && prev?.checkedAt && Date.now() - prev.checkedAt < LOCAL_MIN_GAP) return Promise.resolve(prev);

    localStatus.set(id, { ...prev, checking: true });
    changed();
    const p = (async () => {
      try {
        if (!fs.existsSync(repo.localPath)) throw new Error(`폴더가 없습니다: ${repo.localPath}`);
        const r = await svn.localStatus(repo.localPath);
        localStatus.set(id, { ...r, checking: false, checkedAt: Date.now(), error: null });
      } catch (err) {
        localStatus.set(id, { checking: false, checkedAt: Date.now(), error: err.message });
      } finally {
        localRunning.delete(id);
        changed();
      }
      return localStatus.get(id);
    })();
    localRunning.set(id, p);
    return p;
  }

  /** 오래된 것만 순차 갱신 (창을 열거나 포커스할 때) */
  async function refreshAllLocal({ force = false } = {}) {
    for (const r of config.getRepos()) await refreshLocal(r.id, { force });
  }

  function saveRepo(draft, password) {
    const repo = config.saveRepo(draft, password);
    manager.upsert(repo);
    localStatus.delete(repo.id);
    refreshLocal(repo.id, { force: true });
    changed();
    return config.toPublicRepo(repo);
  }

  function deleteRepo(id) {
    manager.remove(id);
    config.deleteRepo(id);
    localStatus.delete(id);
    changed();
  }

  function setFavorite(id, favorite) {
    config.setRepoFavorite(id, favorite);
    changed();
  }

  function setPaused(id, paused) {
    const repo = config.setRepoPaused(id, paused);
    if (repo) manager.upsert(repo);
    changed();
  }

  async function syncOne(id) {
    const r = await manager.syncOne(id);
    changed();
    return r;
  }

  async function syncAll() {
    const results = await manager.syncAll();
    changed();
    return results;
  }

  async function updateWorkingCopy(id, { auto = false } = {}) {
    const repo = config.getRepo(id);
    if (!repo) throw new Error('등록되지 않은 저장소');
    if (!repo.localPath) throw new Error('작업 복사본 경로가 설정되지 않았습니다');
    try {
      const r = await svn.update(repo.localPath, config.getConn(repo));
      refreshLocal(id, { force: true });
      const conflictMsg = r.conflicts ? ` · 충돌 ${r.conflicts}건 확인 필요` : '';
      notifier.show({
        title: `${repo.name} · svn update ${r.conflicts ? '완료 (충돌)' : '완료'}`,
        body: `r${r.revision ?? '?'} · 변경 ${r.changed}건${conflictMsg}\n${repo.localPath}`,
        force: !auto, // 직접 실행한 경우는 방해 금지 중에도 결과 표시
      });
      return r;
    } catch (err) {
      notifier.show({ title: `${repo.name} · svn update 실패`, body: err.message, force: !auto });
      throw err;
    }
  }

  async function testConnection(draft, password) {
    const url = String(draft.url || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('URL을 입력하세요');
    const existing = draft.id ? config.getRepo(draft.id) : null;
    const repoLike = {
      trustCert: !!draft.trustCert,
      auth: {
        mode: draft.auth?.mode,
        username: String(draft.auth?.username || '').trim(),
        passwordEnc: existing?.auth?.passwordEnc,
      },
    };
    const conn = config.getConn(repoLike, password);
    const { commit } = await svn.info(url, conn);
    const result = { revision: commit.revision, commit, wcUrl: null, wcWarning: null };
    const localPath = String(draft.localPath || '').trim();
    if (localPath) {
      try {
        result.wcUrl = await svn.workingCopyUrl(localPath, conn);
        if (!result.wcUrl.toLowerCase().startsWith(url.toLowerCase()) && !url.toLowerCase().startsWith(result.wcUrl.toLowerCase())) {
          result.wcWarning = `작업 복사본 URL이 감시 URL과 다릅니다: ${result.wcUrl}`;
        }
      } catch (err) {
        result.wcWarning = `작업 복사본 확인 실패: ${err.message}`;
      }
    }
    return result;
  }

  function openTortoise(id, range) {
    const repo = config.getRepo(id);
    if (!repo) throw new Error('등록되지 않은 저장소');
    if (!tortoisePath) throw new Error('TortoiseSVN 이 설치되어 있지 않습니다');
    const args = ['/command:log', `/path:"${repo.url}"`];
    if (range?.to) args.push(`/startrev:${range.to}`, `/endrev:${range.from}`);
    spawn(tortoisePath, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  }

  function openTortoiseStatus(id) {
    if (!tortoisePath) throw new Error('TortoiseSVN 이 설치되어 있지 않습니다');
    spawn(tortoisePath, ['/command:repostatus', `/path:"${localPathOf(id)}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
  }

  function localPathOf(id) {
    const repo = config.getRepo(id);
    if (!repo) throw new Error('등록되지 않은 저장소');
    if (!repo.localPath) throw new Error('작업 복사본 경로가 설정되지 않았습니다 (편집에서 지정)');
    if (!fs.existsSync(repo.localPath)) throw new Error(`폴더가 없습니다: ${repo.localPath}`);
    return repo.localPath;
  }

  async function openExplorer(id) {
    const err = await shell.openPath(localPathOf(id));
    if (err) throw new Error(`탐색기를 열 수 없습니다: ${err}`);
  }

  /** Warp 터미널 설치 여부 (warp:// URI 처리기 등록 기준) */
  function warpAvailable() {
    try {
      return !!app.getApplicationNameForProtocol('warp://');
    } catch {
      return false;
    }
  }

  async function openWarp(id) {
    if (!warpAvailable()) throw new Error('Warp 가 설치되어 있지 않습니다 (https://www.warp.dev)');
    // 실행 중이면 새 탭, 아니면 Warp 를 띄우고 해당 경로에서 시작
    await shell.openExternal(`warp://action/new_tab?path=${encodeURIComponent(localPathOf(id))}`);
  }

  // ---------- Visual Studio / VS Code ----------

  function solutionsOf(id) {
    const repo = config.getRepo(id);
    if (!repo?.localPath || !fs.existsSync(repo.localPath)) return [];
    return findSolutions(repo.localPath);
  }

  async function openSolution(id, index) {
    const base = localPathOf(id);
    const list = findSolutions(base);
    const sln = list[index ?? 0];
    if (!sln) throw new Error('작업 복사본에서 .sln 파일을 찾지 못했습니다');
    const err = await shell.openPath(sln); // .sln 연결 프로그램 (Visual Studio Version Selector)
    if (err) throw new Error(`Visual Studio 로 열 수 없습니다: ${err}`);
  }

  function findVsCode() {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code', 'Code.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  function openVsCode(id) {
    const code = findVsCode();
    if (!code) throw new Error('VS Code 가 설치되어 있지 않습니다');
    spawn(code, [localPathOf(id)], { detached: true, stdio: 'ignore' }).unref();
  }

  function openCmd(id) {
    // start 로 새 콘솔 창을 띄우고 작업 디렉터리를 저장소 폴더로 지정
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K'], {
      cwd: localPathOf(id),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  }

  /**
   * 저장소 카드 우클릭 메뉴. 선택한 동작 이름을 돌려주고 실행은 렌더러가 담당 (결과/오류를 카드에 표시)
   * @returns {Promise<string|null>} 렌더러가 처리할 동작 이름
   */
  function showRepoMenu(event, id) {
    const repo = config.getRepo(id);
    if (!repo) return Promise.resolve(null);
    const hasPath = !!repo.localPath;
    const pathNote = hasPath ? '' : '  (작업 복사본 경로 없음)';
    return new Promise((resolve) => {
      let picked = null;
      const pick = (act) => () => (picked = act);
      const vsMenuItems = () => {
        if (!hasPath) return [{ label: `Visual Studio로 열기${pathNote}`, enabled: false }];
        const slns = solutionsOf(id);
        if (slns.length === 0) return [{ label: 'Visual Studio로 열기  (.sln 없음)', enabled: false }];
        if (slns.length === 1) return [{ label: `Visual Studio로 열기  (${path.basename(slns[0])})`, click: pick('vs:0') }];
        return [
          {
            label: 'Visual Studio로 열기',
            submenu: slns.map((s, i) => ({ label: path.relative(repo.localPath, s), click: pick(`vs:${i}`) })),
          },
        ];
      };
      const menu = Menu.buildFromTemplate([
        { label: `파일 탐색기에서 열기${pathNote}`, enabled: hasPath, click: pick('explorer') },
        { label: `명령 프롬프트(cmd) 열기${pathNote}`, enabled: hasPath, click: pick('cmd') },
        {
          label: `Warp에서 열기${pathNote || (warpAvailable() ? '' : '  (Warp 미설치)')}`,
          enabled: hasPath && warpAvailable(),
          click: pick('warp'),
        },
        { type: 'separator' },
        ...vsMenuItems(),
        { label: `VS Code로 열기${pathNote || (findVsCode() ? '' : '  (VS Code 미설치)')}`, enabled: hasPath && !!findVsCode(), click: pick('vscode') },
        { type: 'separator' },
        { label: '지금 확인', click: pick('sync') },
        { label: 'svn update', enabled: hasPath, click: pick('update') },
        { label: 'TortoiseSVN 로그 보기', enabled: !!tortoisePath, click: pick('tortoise') },
        { label: '로컬 변경 사항 보기 (TortoiseSVN)', enabled: hasPath && !!tortoisePath, click: pick('repostatus') },
        { label: '로컬 상태 새로고침', enabled: hasPath, click: pick('localRefresh') },
        { type: 'separator' },
        { label: 'URL 복사', click: () => clipboard.writeText(repo.url) },
        { label: '작업 복사본 경로 복사', enabled: hasPath, click: () => clipboard.writeText(repo.localPath) },
        { type: 'separator' },
        { label: repo.favorite ? '☆ 즐겨찾기 해제' : '★ 즐겨찾기 추가', click: pick('favorite') },
        { label: repo.paused ? '감시 재개' : '일시정지', click: pick('pause') },
        { label: '편집', click: pick('edit') },
        { label: '삭제', click: pick('delete') },
      ]);
      menu.popup({
        window: BrowserWindow.fromWebContents(event.sender),
        // 메뉴가 닫힌 뒤 click 이 호출되므로 한 틱 늦춰서 결과 전달
        callback: () => setTimeout(() => resolve(picked), 50),
      });
    });
  }

  function applyLoginItem() {
    if (!app.isPackaged) return; // 개발 중에는 electron.exe 가 등록되지 않도록
    app.setLoginItemSettings({ openAtLogin: config.getSettings().launchAtLogin, path: launcherExe });
  }

  /**
   * Windows 토스트 알림은 같은 AppUserModelId 를 가진 시작 메뉴 바로가기가 있어야 표시됨.
   * 설치판은 설치 프로그램이 만들고, 포터블은 여기서 직접 만든다.
   */
  function ensurePortableShortcut() {
    if (!PORTABLE_EXE) return;
    try {
      const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      // 예전 이름(RingTheSVN) 포터블이 만든 바로가기 정리
      for (const legacy of ['RingTheSVN.lnk']) {
        const old = path.join(programs, legacy);
        try {
          if (fs.existsSync(old) && shell.readShortcutLink(old).description === 'SVN 커밋 감시 알림') fs.unlinkSync(old);
        } catch {
          /* 무시 */
        }
      }
      const lnk = path.join(programs, `${APP_NAME}.lnk`);
      const opts = {
        target: PORTABLE_EXE,
        cwd: path.dirname(PORTABLE_EXE),
        icon: PORTABLE_EXE,
        iconIndex: 0,
        appUserModelId: APP_ID,
        description: 'SVN 커밋 감시 알림',
      };
      let current = null;
      try {
        current = shell.readShortcutLink(lnk);
      } catch {
        /* 없음 */
      }
      if (!current || current.target !== PORTABLE_EXE || current.appUserModelId !== APP_ID) {
        shell.writeShortcutLink(lnk, current ? 'replace' : 'create', opts);
      }
    } catch {
      /* 바로가기 생성 실패 시 알림만 안 보일 수 있음 */
    }
  }

  function scheduleDndExpiry() {
    clearTimeout(dndTimer);
    const until = config.getSettings().dndUntil;
    const ms = until - Date.now();
    if (ms > 0) dndTimer = setTimeout(changed, Math.min(ms + 500, 2 ** 31 - 1));
  }

  function setDnd(v) {
    let until = 0;
    if (v === 'today') {
      const d = new Date();
      d.setHours(23, 59, 59, 0);
      until = d.getTime();
    } else if (v > 0) {
      until = Date.now() + v;
    }
    config.saveSettings({ dndUntil: until });
    scheduleDndExpiry();
    changed();
  }

  function setGlobalPaused(paused) {
    config.saveSettings({ globalPaused: paused });
    manager.setGlobalPaused(paused);
    changed();
  }

  async function saveSettings(patch) {
    const prev = config.getSettings();
    const next = config.saveSettings(patch);
    if (prev.launchAtLogin !== next.launchAtLogin) applyLoginItem();
    if (prev.globalPaused !== next.globalPaused) manager.setGlobalPaused(next.globalPaused);
    if (prev.dndUntil !== next.dndUntil) scheduleDndExpiry();
    if (prev.svnPath !== next.svnPath) await checkSvn();
    changed();
    return next;
  }

  function importConfig(data) {
    const r = config.importData(data);
    manager.reload(config.getRepos());
    changed();
    return r;
  }

  function markSeen() {
    unseen = 0;
    changed();
  }

  function quit() {
    app.isQuitting = true;
    manager?.stopAll();
    tray?.destroy();
    app.quit();
  }

  const controller = {
    config,
    snapshot,
    changed,
    saveRepo,
    deleteRepo,
    setPaused,
    setFavorite,
    syncOne,
    syncAll,
    updateWorkingCopy,
    testConnection,
    openTortoise,
    openExplorer,
    openTortoiseStatus,
    openCmd,
    openWarp,
    openSolution,
    openVsCode,
    showRepoMenu,
    saveSettings,
    checkSvn,
    importConfig,
    markSeen,
    refreshLocal,
    refreshAllLocal,
  };

  // ---------- 앱 수명주기 ----------

  app.on('second-instance', () => showMainWindow('repos'));
  // 창이 모두 닫혀도 트레이 상주
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    notifier = new Notifier({ isMuted, isSilent: () => config.getSettings().silent });

    manager = new PollerManager({
      svn,
      getConn: (repo) => config.getConn(repo),
      getState: config.getState,
      setState: config.setState,
      getSettings: config.getSettings,
      onCommits,
      onError,
      onStatus: changed,
      // 서버 확인 직후 로컬 상태도 갱신 (업데이트 필요 여부 비교용)
      onChecked: (repo) => {
        config.setState(repo.id, { lastCheckedAt: Date.now() });
        refreshLocal(repo.id, { force: true }); // 로컬 디스크만 읽으므로 매 확인마다 갱신
      },
    });
    manager.globalPaused = config.getSettings().globalPaused;

    tray = new TrayController({
      openWindow: (tab) => showMainWindow(tab),
      syncAll: () => syncAll().catch(() => {}),
      syncOne: (id) => syncOne(id).catch(() => {}),
      togglePause: (id) => setPaused(id, !config.getRepo(id)?.paused),
      update: (id) => updateWorkingCopy(id).catch(() => {}),
      openTortoise: (id) => {
        try {
          openTortoise(id);
        } catch {
          /* 메뉴에서 비활성 처리됨 */
        }
      },
      setDnd,
      setGlobalPaused,
      quit,
    });

    registerIpc(controller);
    ensurePortableShortcut();
    applyLoginItem();
    scheduleDndExpiry();

    await checkSvn();
    manager.reload(config.getRepos());
    changed();

    if (!svnInfo.ok) {
      notifier.show({
        title: `${APP_NAME} · svn 확인 필요`,
        body: svnInfo.error || 'svn 명령줄 도구를 찾을 수 없습니다',
        force: true,
        onClick: () => showMainWindow('settings'),
      });
      showMainWindow('settings');
    } else if (migratedFrom) {
      notifier.show({
        title: `${APP_NAME} 로 이름이 바뀌었습니다`,
        body: `기존 RingTheSVN 설정(저장소 ${config.getRepos().length}개)을 그대로 가져왔습니다.`,
        force: true,
        onClick: () => showMainWindow('repos'),
      });
    } else if (config.getRepos().length === 0) {
      // 첫 실행: 아무것도 안 보이면 실행 여부를 알 수 없으므로 설정 창을 띄움
      showMainWindow('repos');
    }

    // 절전/화면 잠금 중에는 폴링 중단. 사유를 따로 기억해서 둘 다 풀렸을 때만 재개
    //  - 절전 복귀: 네트워크(VPN) 연결 시간을 두고 15초 후
    //  - 잠금 해제: 3초 후 (재개 시 모든 저장소를 순차 확인 → 밀린 커밋 알림)
    const pauseReasons = new Set();
    let resumeTimer = null;
    const hold = (reason) => {
      clearTimeout(resumeTimer);
      pauseReasons.add(reason);
      manager.suspend(pauseReasons.has('sleep') ? 'suspended' : 'locked');
      changed();
    };
    const release = (reason, delayMs) => {
      if (!pauseReasons.delete(reason)) return;
      clearTimeout(resumeTimer);
      if (pauseReasons.size > 0) {
        manager.suspend(pauseReasons.has('sleep') ? 'suspended' : 'locked');
        changed();
        return;
      }
      resumeTimer = setTimeout(() => {
        if (pauseReasons.size > 0) return;
        manager.resume(config.getRepos());
        changed();
      }, delayMs);
    };
    powerMonitor.on('suspend', () => hold('sleep'));
    powerMonitor.on('resume', () => release('sleep', 15000));
    powerMonitor.on('lock-screen', () => hold('lock'));
    powerMonitor.on('unlock-screen', () => release('lock', 3000));
  });
}
