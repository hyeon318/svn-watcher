'use strict';
// 개발용 스모크 테스트: 임시 userData + 로컬 file:// 저장소로 앱을 띄워
// 기준점 → 커밋 → 동기화 → 히스토리/알림 흐름을 확인하고 화면을 캡처한 뒤 종료.
//   실행: npx electron scripts/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ringsvn-smoke-'));
app.setPath('userData', path.join(tmp, 'userData'));
const outDir = path.join(__dirname, '..', 'smoke-out');
fs.mkdirSync(outDir, { recursive: true });

const { SvnClient } = require('../src/main/svn');
const svnBin = new SvnClient().resolveSvnPath();
const admin = svnBin.replace(/svn(\.exe)?$/i, 'svnadmin$1');
const repoDir = path.join(tmp, 'repo');
execFileSync(admin, ['create', repoDir]);
const url = 'file:///' + repoDir.replace(/\\/g, '/');
execFileSync(svnBin, ['mkdir', '-m', '초기 구조', `${url}/trunk`]);
const wc = path.join(tmp, 'wc');
const wc2 = path.join(tmp, 'wc2');
execFileSync(svnBin, ['checkout', `${url}/trunk`, wc]);
execFileSync(svnBin, ['checkout', `${url}/trunk`, wc2]);

const config = require('../src/main/config');
const repo = config.saveRepo({ name: '스모크 테스트 저장소', url: `${url}/trunk`, intervalMin: 1, localPath: wc2 });
const noPath = config.saveRepo({ name: '없는 서버', url: 'svn://127.0.0.1:1/nope', intervalMin: 5 });

require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { getWindow, showMainWindow } = require('../src/main/windows');

async function capture(name) {
  const img = await getWindow().webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
}

function commit(file, content, msg) {
  fs.writeFileSync(path.join(wc, file), content);
  try {
    execFileSync(svnBin, ['add', path.join(wc, file)], { stdio: 'ignore' });
  } catch {}
  execFileSync(svnBin, ['commit', '-m', msg, wc]);
}

app.whenReady().then(async () => {
  try {
    showMainWindow('repos');
    getWindow().webContents.on('console-message', (e) =>
      console.log('[renderer]', e.level, e.message, e.lineNumber)
    );
    await wait(9000); // 시작 분산 지연 후 기준점 확보
    const st1 = config.getState(repo.id);
    console.log('[smoke] baseline', st1);

    commit('Main.cs', 'class A {}', '라인 상태 조회 로직 추가\n\n- 상세 설명');
    commit('Util.cs', 'class B {}', 'Util 정리');

    // wc2 (r1) 에 내 로컬 수정 추가 → "내 수정" + "업데이트 필요" 표시 확인
    const mine = path.join(wc2, '내작업.cs');
    fs.writeFileSync(mine, 'wip');
    execFileSync(svnBin, ['add', mine], { stdio: 'ignore' });
    const objDir = path.join(wc2, 'App', 'obj', 'Debug');
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(objDir, 'App.dll'), 'bin');
    execFileSync(svnBin, ['add', path.join(wc2, 'App')], { stdio: 'ignore' });

    const js = (code) => getWindow().webContents.executeJavaScript(code);
    await js(`document.querySelector('#btn-sync-all').click()`);
    await wait(5000);
    console.log('[smoke] after sync', config.getState(repo.id), 'history', config.getHistory().length);
    const local = await js(`api.getState().then((s) => JSON.stringify(s.repos[0].local && { total: s.repos[0].local.total, buildTotal: s.repos[0].local.buildTotal, wcRevision: s.repos[0].local.wcRevision, files: s.repos[0].local.files.map((f) => f.path), build: s.repos[0].local.buildFiles.map((f) => f.path) }))`);
    await js(`document.querySelector('[data-act=toggleBuild]')?.click()`);
    console.log('[smoke] local status', local);
    await js(`document.querySelector('[data-id="${repo.id}"] [data-act=toggleFiles]')?.click()`);
    await wait(500);
    await capture('1-repos');
    getWindow().setSize(1, 1); // 최소 크기 레이아웃 확인
    await wait(500);
    console.log('[smoke] window size', getWindow().getSize());
    await capture('1b-repos-min');

    await js(`document.querySelector('[data-id="${repo.id}"] [data-act=update]').click()`);
    await wait(3000);
    await js(`document.querySelector('[data-id="${repo.id}"] [data-act=edit]').click()`);
    await wait(500);
    await js(`document.querySelector('#presets [data-min="4320"]').click()`);
    await js(`document.querySelector('#btn-test').click()`);
    await wait(1500);
    await capture('2-edit');
    await js(`document.querySelector('#btn-save').click()`);
    await wait(1500);
    console.log('[smoke] interval after preset 3일 =', config.getRepo(repo.id).intervalMin);
    await capture('2b-saved');

    const cmdErr = await js('api.openCmd(' + JSON.stringify(noPath.id) + ').then(() => "no error", (e) => e.message)');
    console.log('[smoke] openCmd without path ->', cmdErr);
    const exists = await js('typeof api.showRepoMenu + "/" + typeof api.openExplorer');
    console.log('[smoke] api', exists);
    if (process.env.SMOKE_WARP) {
      const w = await js('api.openWarp(' + JSON.stringify(repo.id) + ').then(() => "opened", (e) => e.message)');
      console.log('[smoke] openWarp ->', w, wc2);
    }
    const warpErr = await js('api.openWarp(' + JSON.stringify(noPath.id) + ').then(() => "no error", (e) => e.message)');
    console.log('[smoke] openWarp without path ->', warpErr);
    const vsErr = await js('api.openSolution(' + JSON.stringify(repo.id) + ', 0).then(() => "no error", (e) => e.message)');
    console.log('[smoke] openSolution (sln 없음) ->', vsErr);
    const codeErr = await js('api.openVsCode(' + JSON.stringify(noPath.id) + ').then(() => "no error", (e) => e.message)');
    console.log('[smoke] openVsCode without path ->', codeErr);

    // 즐겨찾기 / 정렬
    const order = () => js(`[...document.querySelectorAll('#repo-list [data-id]')].map((c) => c.querySelector('.font-semibold').textContent).join(' | ')`);
    console.log('[smoke] order(default)', await order());
    await js(`document.querySelector('[data-id="${noPath.id}"] [data-act=favorite]').click()`);
    await wait(800);
    console.log('[smoke] favorite saved =', config.getRepo(noPath.id).favorite, '/ order', await order());
    await js(`document.querySelector('[data-id="${noPath.id}"] [data-act=favorite]').click()`); // 해제 후 정렬만 확인
    await wait(600);
    for (const sort of ['name', 'commit', 'attention', 'created']) {
      await js(`(() => { const s = document.querySelector('#repo-sort'); s.value = '${sort}'; s.dispatchEvent(new Event('change')); })()`);
      await wait(600);
      console.log(`[smoke] order(${sort})`, await order());
    }
    await js(`document.querySelector('[data-id="${noPath.id}"] [data-act=favorite]').click()`);
    await wait(600);
    await js(`document.querySelector('#btn-fav-only').click()`);
    await wait(600);
    console.log('[smoke] order(favoritesOnly)', await order());
    await capture('5-favorites');
    await js(`document.querySelector('#btn-fav-only').click()`);
    await wait(400);

    // 화면 잠금 → 커밋 → (잠금 중 동기화 없음) → 잠금 해제 → 즉시 동기화
    const { powerMonitor } = require('electron');
    const statusOf = () => js(`api.getState().then((s) => s.repos[0].status.state)`);
    const revBefore = config.getState(repo.id).lastRevision;
    powerMonitor.emit('lock-screen');
    await wait(300);
    commit('Locked.cs', 'class L {}', '잠금 중 커밋');
    await wait(4000);
    console.log('[smoke] locked: state =', await statusOf(), 'rev', revBefore, '->', config.getState(repo.id).lastRevision);
    powerMonitor.emit('unlock-screen');
    await wait(3000 + 1500 + 2500 + 1500);
    console.log('[smoke] unlocked: state =', await statusOf(), 'rev ->', config.getState(repo.id).lastRevision,
      'history', config.getHistory().length);

    showMainWindow('history');
    await wait(1200);
    await js(`document.querySelector('#history-list details')?.setAttribute('open','')`);
    await capture('3-history');

    // 저장소 다중 선택 필터
    const hState = () =>
      js(`JSON.stringify({ label: document.querySelector('#h-repo-label').textContent, cards: document.querySelectorAll('#history-list [data-rev]').length })`);
    const toggleRepo = (id) =>
      js(`(() => { const cb = document.querySelector('#h-repo-menu input[data-hrepo="${id}"]'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await js(`document.querySelector('#h-repo-btn').click()`);
    await wait(300);
    console.log('[smoke] history all', await hState());
    await toggleRepo(repo.id); // 스모크 저장소 해제 → 없는 서버만
    await wait(300);
    console.log('[smoke] history only 없는 서버', await hState());
    await capture('3b-history-multiselect');
    await toggleRepo(noPath.id); // 둘 다 해제
    await toggleRepo(repo.id); // 스모크만 선택
    await wait(300);
    console.log('[smoke] history only 스모크', await hState());
    await js(`document.querySelector('[data-hsel=all]').click()`);
    await wait(300);
    console.log('[smoke] history 전체 선택', await hState());
    await js(`document.body.click()`);
    await wait(200);
    const countText = () => js("document.querySelector('#h-count').textContent + ' | ' + document.querySelector('#h-filters').textContent + ' | reset hidden=' + document.querySelector('#h-reset').classList.contains('hidden')");
    console.log('[smoke] count(all)', await countText());
    await js("(() => { const i = document.querySelector('#h-search'); i.value = 'Util'; i.dispatchEvent(new Event('input')); })()");
    await wait(300);
    console.log('[smoke] count(search Util)', await countText());
    await capture('3c-history-count');
    await js("document.querySelector('#h-reset').click()");
    await wait(300);
    console.log('[smoke] count(reset)', await countText());
    console.log('[smoke] menu closed', await js(`document.querySelector('#h-repo-menu').classList.contains('hidden')`));

    showMainWindow('settings');
    await wait(1000);
    await capture('4-settings');

    const wcRev = execFileSync(svnBin, ['info', '--show-item', 'revision', wc2]).toString().trim();
    console.log('[smoke] wc2 revision after update', wcRev);
    console.log('[smoke] OK');
  } catch (e) {
    console.error('[smoke] FAIL', e);
  } finally {
    app.exit(0);
  }
});
