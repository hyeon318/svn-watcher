'use strict';

/* global api — preload 의 contextBridge 가 window.api 로 노출 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;
let history = [];
let currentTab = 'repos';
// 최근 커밋 저장소 필터: null = 전체, Set = 선택한 저장소만 (비어 있으면 아무것도 안 보임)
// 선택은 이 PC 에만 기억
let historyRepos = null;
try {
  const saved = JSON.parse(localStorage.getItem('historyRepos') || 'null');
  historyRepos = Array.isArray(saved) ? new Set(saved) : null;
} catch {
  /* 저장소 접근 불가 시 전체 */
}
function saveHistoryRepos() {
  try {
    localStorage.setItem('historyRepos', JSON.stringify(historyRepos ? [...historyRepos] : null));
  } catch {
    /* 무시 */
  }
}
let highlightRepoId = null;

// ---------- 유틸 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DAY = 1440;

/** 분 → 가장 큰 단위로 나누어 떨어지는 { value, unit } */
function splitInterval(min) {
  if (min % DAY === 0) return { value: min / DAY, unit: DAY };
  if (min % 60 === 0) return { value: min / 60, unit: 60 };
  return { value: min, unit: 1 };
}

function rel(ts) {
  if (!ts) return '';
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

/** 오늘이면 시:분, 아니면 월/일 시:분 */
function fmtShort(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (new Date().toDateString() === d.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtInterval(min) {
  const { value, unit } = splitInterval(min);
  return `${value}${unit === DAY ? '일' : unit === 60 ? '시간' : '분'}`;
}

// ---------- 안내 문구 (팝업 대신 화면 안에 표시, 길면 다음 줄로) ----------

const NOTICE_STYLE = {
  info: 'bg-slate-100 text-slate-700',
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-600',
};
const noticeTimers = {};

/**
 * @param {string} id 안내 영역 요소 id
 * @param {boolean} [sticky] true 면 자동으로 숨기지 않음 (오류는 항상 유지)
 */
function notice(id, msg, kind = 'info', sticky = false) {
  const el = document.getElementById(id);
  clearTimeout(noticeTimers[id]);
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.className = `notice ${el.dataset.base || ''} ${NOTICE_STYLE[kind]}`;
  el.textContent = msg;
  if (!sticky && kind !== 'error') noticeTimers[id] = setTimeout(() => el.classList.add('hidden'), 8000);
}

// 원래 마크업의 여백 클래스 보존
['repos-notice', 'history-notice'].forEach((id) => ($(`#${id}`).dataset.base = 'mx-5 mt-4'));

const TAB_NOTICE = { repos: 'repos-notice', history: 'history-notice', settings: 'settings-notice' };
const pageNotice = (msg, kind) => notice(TAB_NOTICE[currentTab], msg, kind);

// 저장소 카드 안 안내 (카드가 다시 그려져도 유지)
const cardMsg = {};
function cardNotice(id, msg, kind = 'info') {
  const item = { msg, kind };
  cardMsg[id] = item;
  renderRepos();
  if (kind !== 'error') {
    setTimeout(() => {
      if (cardMsg[id] === item) {
        delete cardMsg[id];
        renderRepos();
      }
    }, 8000);
  }
}

async function run(btn, fn, onError = (m) => pageNotice(m, 'error')) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    onError(err.message);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 탭 ----------

function showTab(tab) {
  currentTab = tab;
  $$('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${tab}`));
  $$('.nav-btn').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  if (tab === 'history') {
    loadHistory();
    api.markSeen().catch(() => {});
  }
  if (tab === 'settings') fillSettings();
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- 상태 로드 ----------

async function refresh() {
  state = await api.getState();
  renderSidebar();
  renderRepos();
  renderHistoryRepoSelect();
  if (currentTab === 'history') loadHistory();
  if (currentTab === 'settings') renderSvnStatus();
}

let refreshTimer = null;
api.onChanged(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 100);
});

api.onNavigate((nav) => {
  if (nav.repoId) {
    if (nav.tab === 'history') {
      historyRepos = new Set([nav.repoId]);
      saveHistoryRepos();
    }
    else highlightRepoId = nav.repoId;
  }
  showTab(nav.tab || 'repos');
  refresh();
});

function renderSidebar() {
  $('#app-version').textContent = `v${state.appVersion}`;
  $('#nav-repo-count').textContent = state.repos.length || '';
  const unseen = $('#nav-unseen');
  unseen.textContent = state.unseen;
  unseen.classList.toggle('hidden', !state.unseen);

  $('#side-svn').innerHTML = state.svn.ok
    ? `<span class="text-emerald-400">●</span> svn ${esc(state.svn.version)}`
    : `<span class="text-red-400">●</span> svn 확인 필요`;

  const s = state.settings;
  const modes = [];
  if (s.globalPaused) modes.push('<span class="text-amber-400">전체 일시정지 중</span>');
  if (s.dndUntil > Date.now()) modes.push(`<span class="text-amber-400">방해 금지 ~${esc(fmtTime(s.dndUntil))}</span>`);
  $('#side-mode').innerHTML = modes.join('<br>');
}

// ---------- 저장소 목록 ----------

const STATUS = {
  ok: ['bg-emerald-500', '정상'],
  idle: ['bg-slate-300', '대기'],
  checking: ['bg-blue-500 animate-pulse', '확인 중'],
  error: ['bg-red-500', '오류'],
  paused: ['bg-slate-400', '일시정지'],
  suspended: ['bg-slate-400', '절전 대기'],
  locked: ['bg-slate-400', '잠금 대기'],
};

// ---------- 즐겨찾기 / 정렬 ----------

/** 확인 필요 점수: 오류 > 충돌 > 내 수정 > 업데이트 필요 */
function attentionScore(r) {
  const l = r.local || {};
  let score = 0;
  if (r.status?.state === 'error' || l.error) score += 1000;
  if (l.counts?.conflicted) score += 500;
  if (l.total) score += 100 + Math.min(l.total, 99);
  if (r.lastCommit && Number.isFinite(l.wcRevision) && l.wcRevision < r.lastCommit.revision) score += 50;
  return score;
}

const SORTERS = {
  created: () => 0,
  name: (a, b) => a.name.localeCompare(b.name, 'ko'),
  commit: (a, b) => new Date(b.lastCommit?.date || 0) - new Date(a.lastCommit?.date || 0),
  attention: (a, b) => attentionScore(b) - attentionScore(a),
};

function visibleRepos() {
  const { repoSort = 'created', favoritesOnly } = state.settings;
  const sorter = SORTERS[repoSort] || SORTERS.created;
  return state.repos
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !favoritesOnly || r.favorite)
    .sort((a, b) => (b.r.favorite ? 1 : 0) - (a.r.favorite ? 1 : 0) || sorter(a.r, b.r) || a.i - b.i)
    .map(({ r }) => r);
}

function renderRepoToolbar() {
  const s = state.settings;
  $('#repo-sort').value = s.repoSort || 'created';
  const fav = $('#btn-fav-only');
  fav.textContent = s.favoritesOnly ? '★ 즐겨찾기만' : '☆ 즐겨찾기만';
  fav.classList.toggle('btn-primary', !!s.favoritesOnly);
  const favCount = state.repos.filter((r) => r.favorite).length;
  $('#repo-count').textContent = `전체 ${state.repos.length}개 · 즐겨찾기 ${favCount}개`;
}

$('#repo-sort').addEventListener('change', (e) => run(null, () => api.saveSettings({ repoSort: e.target.value })));
$('#btn-fav-only').addEventListener('click', (e) =>
  run(e.currentTarget, () => api.saveSettings({ favoritesOnly: !state.settings.favoritesOnly }))
);

function renderRepos() {
  const list = $('#repo-list');
  renderRepoToolbar();
  if (!state.repos.length) {
    list.innerHTML = `
      <div class="card flex flex-col items-center gap-2 p-10 text-center text-slate-500">
        <div class="text-3xl">🔔</div>
        <div class="font-medium text-slate-700">등록된 저장소가 없습니다</div>
        <div class="text-xs">오른쪽 폼에서 감시할 SVN 저장소를 추가하세요.</div>
      </div>`;
    return;
  }

  const globalPaused = state.settings.globalPaused;
  const repos = visibleRepos();
  if (!repos.length) {
    list.innerHTML = `
      <div class="card flex flex-col items-center gap-2 p-10 text-center text-slate-500">
        <div class="text-3xl">☆</div>
        <div class="font-medium text-slate-700">즐겨찾기한 저장소가 없습니다</div>
        <div class="text-xs">카드 이름 옆 ☆ 를 누르거나 우클릭 메뉴에서 즐겨찾기에 추가하세요.</div>
      </div>`;
    return;
  }
  list.innerHTML = repos
    .map((r) => {
      const st = r.status || {};
      const key = r.paused ? 'paused' : globalPaused && st.state !== 'checking' ? 'paused' : st.state || 'idle';
      const [dot, label] = STATUS[key] || STATUS.idle;
      const editing = $('#repo-form').elements.id.value === r.id;
      const hl = highlightRepoId === r.id;
      const running = !r.paused && !globalPaused;
      const extra = [
        r.auth.mode === 'app' ? `👤 ${r.auth.username}` : null,
        r.filters.excludeAuthors.length || r.filters.includePaths.length ? '필터 적용' : null,
      ].filter(Boolean);

      return `
      <div class="card p-4 ${editing ? 'ring-2 ring-blue-400' : ''} ${hl ? 'ring-2 ring-amber-400' : ''}" data-id="${esc(r.id)}" title="우클릭: 탐색기 / cmd / Warp / Visual Studio / VS Code 열기 등">
        <div class="flex items-center gap-2">
          <button class="shrink-0 text-lg leading-none ${r.favorite ? 'text-amber-400 hover:text-amber-500' : 'text-slate-300 hover:text-amber-400'}" data-act="favorite" title="${r.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}">${r.favorite ? '★' : '☆'}</button>
          <span class="h-2.5 w-2.5 shrink-0 rounded-full ${dot}" title="${esc(label)}"></span>
          <span class="min-w-0 truncate font-semibold">${esc(r.name)}</span>
          <span class="chip shrink-0 whitespace-nowrap bg-slate-100 text-slate-500">${esc(label)}</span>
          ${r.autoUpdate && r.localPath ? '<span class="chip shrink-0 whitespace-nowrap bg-violet-50 text-violet-600">자동 update</span>' : ''}
        </div>
        <div class="mt-1.5 truncate font-mono text-xs text-slate-500" title="${esc(r.url)}">${esc(r.url)}</div>
        ${r.localPath ? `<div class="truncate text-xs text-slate-400" title="${esc(r.localPath)}">📁 ${esc(r.localPath)}</div>` : ''}
        <dl class="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 rounded-md bg-slate-50 px-3 py-2.5 text-[13px]">
          <dt class="whitespace-nowrap text-slate-400">최근 커밋</dt>
          <dd class="min-w-0 text-slate-700">${renderLastCommit(r)}</dd>
          <dt class="whitespace-nowrap text-slate-400">마지막 조회</dt>
          <dd class="flex min-w-0 flex-wrap items-center gap-x-3 text-slate-700">
            ${[
              st.lastCheckedAt
                ? `<span class="whitespace-nowrap">${esc(fmtTime(st.lastCheckedAt))} <span class="text-slate-400">(${esc(rel(st.lastCheckedAt))})</span></span>`
                : '<span class="whitespace-nowrap text-slate-400">아직 조회 전</span>',
              `<span class="whitespace-nowrap text-slate-400">주기 ${esc(fmtInterval(r.intervalMin))}</span>`,
              st.nextAt && running ? `<span class="whitespace-nowrap text-slate-400">다음 ${esc(fmtShort(st.nextAt))}</span>` : '',
              ...extra.map((x) => `<span class="whitespace-nowrap text-slate-400">${esc(x)}</span>`),
            ].join('')}
          </dd>
          <dt class="whitespace-nowrap text-slate-400">내 로컬</dt>
          <dd class="flex min-w-0 flex-wrap items-center gap-1.5">${renderLocal(r)}</dd>
        </dl>
        ${renderLocalFiles(r)}
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <div class="ml-auto flex min-w-0 flex-wrap justify-end gap-1">
            <button class="btn btn-sm" data-act="sync" title="지금 확인">⟳ 확인</button>
            <button class="btn btn-sm" data-act="pause">${r.paused ? '▶ 재개' : '⏸ 정지'}</button>
            ${r.localPath ? '<button class="btn btn-sm" data-act="update" title="svn update">⇩ Update</button>' : ''}
            ${state.tortoise ? '<button class="btn btn-sm" data-act="tortoise" title="TortoiseSVN 로그">로그</button>' : ''}
            <button class="btn btn-sm" data-act="edit">편집</button>
            <button class="btn btn-sm btn-danger" data-act="delete">삭제</button>
          </div>
        </div>
        ${st.lastError ? `<div class="notice mt-2 bg-red-50 text-red-600">${esc(st.lastError)}${st.errors > 1 ? ` (연속 ${st.errors}회)` : ''}</div>` : ''}
        ${cardMsg[r.id] ? `<div class="notice mt-2 ${NOTICE_STYLE[cardMsg[r.id].kind]}">${esc(cardMsg[r.id].msg)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function renderLastCommit(r) {
  const c = r.lastCommit;
  if (!c) return '<span class="text-slate-400">조회 전 (첫 확인 후 표시)</span>';
  // 각 묶음은 줄바꿈 없이, 공간이 부족하면 묶음 단위로 다음 줄로
  return `<span class="inline-flex flex-wrap items-center gap-x-1.5">
    <span class="chip bg-blue-50 font-mono text-blue-700">r${c.revision}</span>
    <span class="whitespace-nowrap font-medium">${esc(c.author)}</span>
    <span class="whitespace-nowrap text-slate-500">${esc(fmtShort(c.date))} <span class="text-slate-400">(${esc(rel(c.date))})</span></span>
  </span>`;
}

const LOCAL_LABEL = { modified: '수정', added: '추가', deleted: '삭제', replaced: '교체', conflicted: '충돌', missing: '누락', obstructed: '방해', incomplete: '미완료', props: '속성' };
const expandedFiles = new Set();

function renderLocal(r) {
  if (!r.localPath) return '<span class="chip bg-slate-200 text-slate-500" title="편집에서 작업 복사본 경로를 지정하면 내 수정 사항 / 업데이트 필요 여부를 비교합니다">작업 복사본 미지정</span>';
  const l = r.local;
  if (!l || (l.checking && !l.checkedAt)) return '<span class="text-slate-400">확인 중…</span>';
  if (l.error) return `<span class="text-red-600">${esc(l.error)}</span>`;

  const chips = [];
  if (l.total > 0) {
    const parts = Object.entries(l.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${LOCAL_LABEL[k] || k} ${n}`)
      .join(' · ');
    const open = expandedFiles.has(r.id);
    chips.push(
      `<button class="chip cursor-pointer bg-amber-100 text-amber-800 hover:bg-amber-200" data-act="toggleFiles" title="파일 목록 ${open ? '접기' : '펼치기'}">✎ 내 수정 ${l.total}건 (${esc(parts)}) ${open ? '▴' : '▾'}</button>`
    );
    if (l.counts.conflicted) chips.push(`<span class="chip bg-red-100 text-red-700">충돌 ${l.counts.conflicted}건 해결 필요</span>`);
  } else {
    chips.push('<span class="chip bg-emerald-50 text-emerald-700">✓ 수정 없음</span>');
  }
  if (l.buildTotal > 0) {
    const open = expandedBuild.has(r.id);
    chips.push(
      `<button class="chip cursor-pointer bg-slate-200 text-slate-500 hover:bg-slate-300" data-act="toggleBuild" title="빌드할 때 바뀌는 bin / obj / .vs 파일 (저장소에 커밋돼 있어 SVN 이 수정으로 표시). 내 수정에서 제외했습니다.">빌드 산출물 ${l.buildTotal}건 ${open ? '▴' : '▾'}</button>`
    );
  }

  const server = r.lastCommit?.revision;
  if (server != null && Number.isFinite(l.wcRevision)) {
    chips.push(
      l.wcRevision < server
        ? `<span class="chip bg-blue-100 text-blue-800" title="svn update 로 받을 수 있는 커밋이 있습니다 (내 작업 복사본 r${l.wcRevision} / 서버 최근 커밋 r${server})">⇩ 업데이트 필요 r${l.wcRevision} → r${server}</span>`
        : `<span class="chip bg-slate-200 text-slate-600">최신 (r${l.wcRevision})</span>`
    );
  }
  chips.push(
    `<span class="whitespace-nowrap text-xs text-slate-400">${l.checking ? '갱신 중…' : `${esc(rel(l.checkedAt))} 확인`}</span>`
  );
  return chips.join('');
}

const LETTER_COLOR = { M: 'text-blue-600', A: 'text-emerald-600', D: 'text-red-500', C: 'text-red-700', R: 'text-amber-600', P: 'text-violet-600', '!': 'text-red-500' };

const expandedBuild = new Set();

function fileList(files, total, title, muted) {
  return `<ul class="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-slate-200 px-3 py-2 font-mono text-xs ${muted ? 'bg-slate-50 text-slate-500' : ''}">
    <li class="mb-1 font-sans text-[13px] text-slate-400">${esc(title)}</li>
    ${files
      .map((f) => `<li class="truncate" title="${esc(f.path)}"><span class="inline-block w-4 font-bold ${LETTER_COLOR[f.letter] || 'text-slate-500'}">${esc(f.letter)}</span>${esc(f.path)}</li>`)
      .join('')}
    ${total > files.length ? `<li class="text-slate-400">… 외 ${total - files.length}개</li>` : ''}
  </ul>`;
}

function renderLocalFiles(r) {
  const l = r.local;
  if (!l) return '';
  let html = '';
  if (expandedFiles.has(r.id) && l.files?.length) html += fileList(l.files, l.total, '내 수정', false);
  if (expandedBuild.has(r.id) && l.buildFiles?.length) html += fileList(l.buildFiles, l.buildTotal, '빌드 산출물 (내 수정에서 제외)', true);
  return html;
}

$('#repo-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  repoAction(btn.closest('[data-id]').dataset.id, btn.dataset.act, btn);
});

// 우클릭: 탐색기 / cmd / 기타 동작 메뉴 (네이티브 메뉴)
$('#repo-list').addEventListener('contextmenu', async (e) => {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  try {
    const act = await api.showRepoMenu(id);
    if (act) repoAction(id, act, card.querySelector(`button[data-act="${act}"]`));
  } catch (err) {
    cardNotice(id, err.message, 'error');
  }
});

async function repoAction(id, act, btn) {
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  highlightRepoId = null;

  const onError = (m) => cardNotice(id, m, 'error');
  if (act.startsWith('vs:')) {
    await run(null, () => api.openSolution(id, Number(act.slice(3))), onError);
    return;
  }
  switch (act) {
    case 'favorite':
      await run(null, () => api.setFavorite(id, !repo.favorite), onError);
      break;
    case 'toggleFiles':
      if (expandedFiles.has(id)) expandedFiles.delete(id);
      else expandedFiles.add(id);
      renderRepos();
      break;
    case 'toggleBuild':
      if (expandedBuild.has(id)) expandedBuild.delete(id);
      else expandedBuild.add(id);
      renderRepos();
      break;
    case 'localRefresh':
      await run(null, () => api.refreshLocal(id, true), onError);
      break;
    case 'repostatus':
      await run(null, () => api.openTortoiseStatus(id), onError);
      break;
    case 'explorer':
      await run(null, () => api.openExplorer(id), onError);
      break;
    case 'cmd':
      await run(null, () => api.openCmd(id), onError);
      break;
    case 'warp':
      await run(null, () => api.openWarp(id), onError);
      break;
    case 'vscode':
      await run(null, () => api.openVsCode(id), onError);
      break;
    case 'sync':
      await run(
        btn,
        async () => {
          cardNotice(id, '확인 중…');
          const r = await api.sync(id);
          if (!r.ok) cardNotice(id, r.error, 'error');
          else if (r.baseline != null) cardNotice(id, `기준 리비전 r${r.baseline} 저장 (다음 커밋부터 알림)`, 'ok');
          else cardNotice(id, r.newCount ? `새 커밋 ${r.newCount}건` : '변경 없음', 'ok');
        },
        onError
      );
      break;
    case 'pause':
      await run(btn, () => api.setPaused(id, !repo.paused), onError);
      break;
    case 'update':
      await run(
        btn,
        async () => {
          cardNotice(id, 'svn update 실행 중…');
          const r = await api.update(id);
          cardNotice(
            id,
            `svn update 완료 · r${r.revision ?? '?'} · 변경 ${r.changed}건${r.conflicts ? ` · 충돌 ${r.conflicts}건 확인 필요` : ''}`,
            r.conflicts ? 'warn' : 'ok'
          );
        },
        onError
      );
      break;
    case 'tortoise':
      await run(btn, () => api.openTortoise(id), onError);
      break;
    case 'edit':
      fillRepoForm(repo);
      break;
    case 'delete':
      if (confirm(`'${repo.name}' 저장소를 삭제할까요?\n해당 저장소의 커밋 기록도 함께 삭제됩니다.`)) {
        await run(btn, async () => {
          await api.deleteRepo(id);
          if ($('#repo-form').elements.id.value === id) resetRepoForm();
          pageNotice(`'${repo.name}' 저장소를 삭제했습니다`, 'ok');
        });
      }
      break;
  }
}

$('#btn-sync-all').addEventListener('click', (e) =>
  run(e.currentTarget, async () => {
    const results = await api.sync();
    const fails = results.filter((r) => !r.ok).length;
    const news = results.reduce((n, r) => n + (r.newCount || 0), 0);
    pageNotice(
      `동기화 ${results.length}개 · 새 커밋 ${news}건${fails ? ` · 실패 ${fails}개 (각 저장소의 오류 내용 확인)` : ''}`,
      fails ? 'warn' : 'ok'
    );
  })
);

// ---------- 저장소 폼 ----------

const form = $('#repo-form');

function setAuthMode(mode) {
  form.elements.authMode.value = mode;
  $('#auth-app').classList.toggle('hidden', mode !== 'app');
  $('#auth-cached-hint').classList.toggle('hidden', mode === 'app');
}

function intervalMinutes() {
  return Number(form.elements.intervalValue.value) * Number(form.elements.intervalUnit.value);
}

function setIntervalMinutes(min) {
  const { value, unit } = splitInterval(min);
  form.elements.intervalValue.value = value;
  form.elements.intervalUnit.value = String(unit);
  syncPresets();
}

function syncPresets() {
  const v = intervalMinutes();
  $$('#presets .preset').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === v));
}

function hideTestResult() {
  notice('form-notice', '');
}

function resetRepoForm() {
  form.reset();
  form.elements.id.value = '';
  setIntervalMinutes(30);
  $('#form-title').textContent = '새 저장소 추가';
  $('#btn-form-cancel').classList.add('hidden');
  $('#pw-hint').textContent = 'Windows 사용자 계정으로 암호화되어 저장됩니다.';
  setAuthMode('cached');
  syncPresets();
  hideTestResult();
  if (state) renderRepos();
}

function fillRepoForm(r) {
  form.reset();
  const el = form.elements;
  el.id.value = r.id;
  el.name.value = r.name;
  el.url.value = r.url;
  setIntervalMinutes(r.intervalMin);
  el.username.value = r.auth.username || '';
  el.password.value = '';
  el.trustCert.checked = !!r.trustCert;
  el.localPath.value = r.localPath || '';
  el.autoUpdate.checked = !!r.autoUpdate;
  el.excludeAuthors.value = r.filters.excludeAuthors.join(', ');
  el.includePaths.value = r.filters.includePaths.join('\n');
  setAuthMode(r.auth.mode);
  $('#pw-hint').textContent = r.auth.hasPassword ? '비워두면 기존 비밀번호를 유지합니다.' : '비밀번호를 입력하세요.';
  $('#form-title').textContent = `편집: ${r.name}`;
  $('#btn-form-cancel').classList.remove('hidden');
  syncPresets();
  hideTestResult();
  renderRepos();
  el.name.focus();
}

function readRepoForm() {
  const el = form.elements;
  return {
    draft: {
      id: el.id.value || undefined,
      name: el.name.value,
      url: el.url.value,
      intervalMin: intervalMinutes(),
      localPath: el.localPath.value,
      autoUpdate: el.autoUpdate.checked,
      trustCert: el.trustCert.checked,
      auth: { mode: el.authMode.value, username: el.username.value },
      filters: { excludeAuthors: el.excludeAuthors.value, includePaths: el.includePaths.value },
    },
    password: el.authMode.value === 'app' ? el.password.value : '',
  };
}

$$('input[name=authMode]').forEach((r) => r.addEventListener('change', () => setAuthMode(r.value)));
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('.preset');
  if (!b) return;
  setIntervalMinutes(Number(b.dataset.min));
});
form.elements.intervalValue.addEventListener('input', syncPresets);
form.elements.intervalUnit.addEventListener('change', syncPresets);
$('#btn-form-cancel').addEventListener('click', resetRepoForm);

$('#btn-browse').addEventListener('click', async () => {
  const p = await run(null, () => api.pickFolder(form.elements.localPath.value), (m) => notice('form-notice', m, 'error'));
  if (p) form.elements.localPath.value = p;
});

$('#btn-test').addEventListener('click', (e) =>
  run(e.currentTarget, async () => {
    notice('form-notice', '연결 확인 중…', 'info', true);
    const { draft, password } = readRepoForm();
    try {
      const r = await api.testConnection(draft, password);
      const lines = [`✔ 연결 성공 · 최근 커밋 r${r.revision} · ${r.commit.author} · ${fmtShort(r.commit.date)} (${rel(r.commit.date)})`];
      if (r.wcUrl && !r.wcWarning) lines.push(`✔ 작업 복사본 확인 (${r.wcUrl})`);
      if (r.wcWarning) lines.push(`⚠ ${r.wcWarning}`);
      notice('form-notice', lines.join('\n'), r.wcWarning ? 'warn' : 'ok', true);
    } catch (err) {
      notice('form-notice', `✖ ${err.message}`, 'error');
    }
  })
);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(
    $('#btn-save'),
    async () => {
      const { draft, password } = readRepoForm();
      const saved = await api.saveRepo(draft, password);
      resetRepoForm();
      await refresh();
      cardNotice(saved.id, draft.id ? '수정했습니다 — 타이머를 재시작했습니다' : '추가했습니다 — 기준 리비전을 확인합니다', 'ok');
    },
    (m) => notice('form-notice', `✖ ${m}`, 'error')
  );
});

// ---------- 최근 커밋 ----------

function renderHistoryRepoSelect() {
  // 삭제된 저장소는 선택에서 제거
  const ids = new Set(state.repos.map((r) => r.id));
  if (historyRepos) for (const id of historyRepos) if (!ids.has(id)) historyRepos.delete(id);

  const all = historyRepos === null;
  const sel = all ? state.repos : state.repos.filter((r) => historyRepos.has(r.id));
  $('#h-repo-label').textContent = all
    ? '전체 저장소'
    : sel.length === 0
      ? '선택 없음'
      : sel.length === 1
        ? sel[0].name
        : `${sel[0].name} 외 ${sel.length - 1}개`;
  $('#h-repo-btn').title = all ? '전체 저장소' : sel.map((r) => r.name).join('\n') || '선택 없음';

  const counts = {};
  for (const h of history) counts[h.repoId] = (counts[h.repoId] || 0) + 1;
  const ordered = [...state.repos.filter((r) => r.favorite), ...state.repos.filter((r) => !r.favorite)];

  $('#h-repo-menu').innerHTML = `
    <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs">
      <button type="button" class="text-blue-600 hover:underline" data-hsel="all">전체 선택</button>
      <span class="text-slate-300">|</span>
      <button type="button" class="text-blue-600 hover:underline" data-hsel="none">선택 해제</button>
      <span class="text-slate-300">|</span>
      <button type="button" class="text-blue-600 hover:underline" data-hsel="favorites">즐겨찾기만</button>
      <span class="ml-auto text-slate-400">${all ? '전체' : `${historyRepos.size}개 선택`}</span>
    </div>
    <div class="max-h-72 overflow-y-auto py-1">
      ${ordered
        .map(
          (r) => `
        <label class="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
          <input type="checkbox" data-hrepo="${esc(r.id)}" ${all || historyRepos.has(r.id) ? 'checked' : ''} />
          <span class="min-w-0 flex-1 truncate">${r.favorite ? '<span class="text-amber-400">★</span> ' : ''}${esc(r.name)}</span>
          <span class="shrink-0 text-xs text-slate-400">${counts[r.id] || 0}</span>
        </label>`
        )
        .join('')}
    </div>`;
}

function toggleHistoryMenu(open) {
  const menu = $('#h-repo-menu');
  const show = open ?? menu.classList.contains('hidden');
  if (show) renderHistoryRepoSelect();
  menu.classList.toggle('hidden', !show);
}

$('#h-repo-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleHistoryMenu();
});
$('#h-repo-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => toggleHistoryMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleHistoryMenu(false);
});

$('#h-repo-menu').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-hrepo]');
  if (!cb) return;
  // "전체" 상태에서 하나를 끄면 나머지 전부 선택된 상태로 시작
  if (historyRepos === null) historyRepos = new Set(state.repos.map((r) => r.id));
  if (cb.checked) historyRepos.add(cb.dataset.hrepo);
  else historyRepos.delete(cb.dataset.hrepo);
  // 전부 선택 = 전체 (이후 추가되는 저장소도 포함)
  if (historyRepos.size === state.repos.length) historyRepos = null;
  saveHistoryRepos();
  renderHistoryRepoSelect();
  renderHistory();
});

$('#h-repo-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hsel]');
  if (!b) return;
  const pick = b.dataset.hsel;
  historyRepos =
    pick === 'all' ? null : pick === 'none' ? new Set() : new Set(state.repos.filter((r) => r.favorite).map((r) => r.id));
  saveHistoryRepos();
  renderHistoryRepoSelect();
  renderHistory();
});

async function loadHistory() {
  history = await api.getHistory().catch(() => []);
  renderHistoryRepoSelect();
  renderHistory();
}

const ACTION_COLOR = { A: 'text-emerald-600', M: 'text-blue-600', D: 'text-red-500', R: 'text-amber-600' };

const MAX_HISTORY_CARDS = 500;

/** 검색/필터 결과 개수 + 적용 중인 조건 표시 */
function renderHistoryCount(count, q) {
  const total = history.length;
  const filtered = !!q || !!historyRepos;
  const shown = Math.min(count, MAX_HISTORY_CARDS);
  $('#h-count').innerHTML = filtered
    ? `<b class="text-sm text-slate-800">${count}</b>건 <span class="text-slate-400">/ 전체 ${total}건</span>${
        count > shown ? ` <span class="text-amber-600">(최근 ${shown}건만 표시)</span>` : ''
      }`
    : `전체 <b class="text-sm text-slate-800">${total}</b>건${count > shown ? ` <span class="text-amber-600">(최근 ${shown}건만 표시)</span>` : ''}`;

  const chips = [];
  if (historyRepos) {
    const names = state.repos.filter((r) => historyRepos.has(r.id)).map((r) => r.name);
    chips.push(names.length ? `저장소: ${names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}개`}` : '저장소: 선택 없음');
  }
  if (q) chips.push(`검색: "${$('#h-search').value.trim()}"`);
  $('#h-filters').innerHTML = chips.map((c) => `<span class="chip bg-slate-100 text-slate-600">${esc(c)}</span>`).join('');
  $('#h-reset').classList.toggle('hidden', !filtered);
}

$('#h-reset').addEventListener('click', () => {
  historyRepos = null;
  saveHistoryRepos();
  $('#h-search').value = '';
  renderHistoryRepoSelect();
  renderHistory();
});

function renderHistory() {
  const q = $('#h-search').value.trim().toLowerCase();
  const items = history.filter((h) => {
    if (historyRepos && !historyRepos.has(h.repoId)) return false;
    if (!q) return true;
    return (
      h.message.toLowerCase().includes(q) ||
      h.author.toLowerCase().includes(q) ||
      String(h.revision) === q.replace(/^r/, '') ||
      h.paths.some((p) => p.path.toLowerCase().includes(q))
    );
  });

  renderHistoryCount(items.length, q);

  const list = $('#history-list');
  if (!items.length) {
    const msg = !history.length
      ? '아직 감지된 커밋이 없습니다'
      : historyRepos && historyRepos.size === 0
        ? '저장소를 선택하세요 (왼쪽 위 저장소 선택)'
        : '조건에 맞는 커밋이 없습니다';
    list.innerHTML = `<div class="card p-10 text-center text-slate-400">${msg}</div>`;
    return;
  }

  list.innerHTML = items
    .slice(0, MAX_HISTORY_CARDS)
    .map(
      (h) => `
      <div class="card p-4" data-repo="${esc(h.repoId)}" data-rev="${h.revision}">
        <div class="flex items-center gap-2 text-xs">
          <span class="chip bg-blue-50 font-mono text-blue-700">r${h.revision}</span>
          <span class="font-medium text-slate-700">${esc(h.repoName)}</span>
          <span class="text-slate-500">${esc(h.author)}</span>
          <span class="text-slate-400">${esc(h.date ? fmtTime(h.date) : '')}</span>
          ${state?.tortoise ? '<button class="btn btn-sm ml-auto" data-act="tortoise">TortoiseSVN 로그</button>' : ''}
        </div>
        <div class="mt-2 whitespace-pre-wrap break-words text-[15px] text-slate-800">${esc(h.message || '(메시지 없음)')}</div>
        ${
          h.paths.length
            ? `<details class="mt-2">
                <summary class="cursor-pointer text-xs text-slate-500">변경 파일 ${h.paths.length}개</summary>
                <ul class="mt-1 max-h-60 space-y-0.5 overflow-y-auto font-mono text-[13px]">
                  ${h.paths
                    .map((p) => `<li class="truncate" title="${esc(p.path)}"><span class="inline-block w-4 font-bold ${ACTION_COLOR[p.action] || 'text-slate-500'}">${esc(p.action)}</span>${esc(p.path)}</li>`)
                    .join('')}
                </ul>
              </details>`
            : ''
        }
      </div>`
    )
    .join('');
}

$('#h-search').addEventListener('input', renderHistory);
$('#history-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act=tortoise]');
  if (!btn) return;
  const card = btn.closest('[data-repo]');
  const rev = Number(card.dataset.rev);
  run(btn, () => api.openTortoise(card.dataset.repo, { from: rev, to: rev }));
});
$('#btn-clear-history').addEventListener('click', (e) => {
  if (!confirm('커밋 기록을 모두 지울까요?')) return;
  run(e.currentTarget, async () => {
    await api.clearHistory();
    await loadHistory();
  });
});

// ---------- 설정 ----------

const sform = $('#settings-form');

function renderSvnStatus() {
  const s = state.svn;
  const box = $('#svn-status');
  box.className = `mb-3 rounded-md px-3 py-2 text-xs ${s.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`;
  box.textContent = s.ok ? `✔ svn ${s.version} — ${s.path}` : `✖ ${s.error || 'svn 을 찾을 수 없습니다'} (${s.path})`;
  const dnd = state.settings.dndUntil > Date.now();
  $('#dnd-status').textContent = dnd
    ? `방해 금지 중 — ${fmtTime(state.settings.dndUntil)} 까지 알림을 표시하지 않습니다 (트레이 메뉴에서 설정)`
    : '방해 금지 꺼짐 (트레이 메뉴 › 방해 금지 에서 설정)';
  $('#btn-dnd-off').disabled = !dnd;
}

function fillSettings() {
  if (!state) return;
  const s = state.settings;
  const el = sform.elements;
  el.svnPath.value = s.svnPath;
  el.clickAction.value = s.clickAction;
  el.silent.checked = s.silent;
  el.notifyErrors.checked = s.notifyErrors;
  el.launchAtLogin.checked = s.launchAtLogin;
  el.globalPaused.checked = s.globalPaused;
  el.maxLogEntries.value = s.maxLogEntries;
  el.timeoutSec.value = s.timeoutSec;
  el.historyLimit.value = s.historyLimit;
  el.clickAction.querySelector('[value=tortoise]').disabled = !state.tortoise;
  renderSvnStatus();
}

sform.addEventListener('submit', (e) => {
  e.preventDefault();
  const el = sform.elements;
  run(sform.querySelector('[type=submit]'), async () => {
    await api.saveSettings({
      svnPath: el.svnPath.value,
      clickAction: el.clickAction.value,
      silent: el.silent.checked,
      notifyErrors: el.notifyErrors.checked,
      launchAtLogin: el.launchAtLogin.checked,
      globalPaused: el.globalPaused.checked,
      maxLogEntries: el.maxLogEntries.value,
      timeoutSec: el.timeoutSec.value,
      historyLimit: el.historyLimit.value,
    });
    await refresh();
    fillSettings();
    pageNotice('설정을 저장했습니다', 'ok');
  });
});

$('#btn-pick-svn').addEventListener('click', async () => {
  const p = await run(null, () => api.pickSvnExe());
  if (p) sform.elements.svnPath.value = p;
});
$('#btn-check-svn').addEventListener('click', (e) =>
  run(e.currentTarget, async () => {
    await api.saveSettings({ svnPath: sform.elements.svnPath.value });
    await api.checkSvn();
    await refresh();
  })
);
$('#btn-dnd-off').addEventListener('click', (e) => run(e.currentTarget, () => api.saveSettings({ dndUntil: 0 })));
$('#btn-export').addEventListener('click', (e) =>
  run(e.currentTarget, async () => {
    const p = await api.exportConfig();
    if (p) pageNotice(`저장했습니다\n${p}`, 'ok');
  })
);
$('#btn-import').addEventListener('click', (e) =>
  run(e.currentTarget, async () => {
    const r = await api.importConfig();
    if (!r) return;
    pageNotice(
      `${r.added}개 저장소를 가져왔습니다${r.needPassword ? `\n${r.needPassword}개는 비밀번호 입력 후 재개하세요` : ''}`,
      'ok'
    );
  })
);

// ---------- 시작 ----------

window.addEventListener('focus', () => api.refreshLocal().catch(() => {}));
setInterval(() => {
  if (state && currentTab === 'repos' && !document.hidden) renderRepos();
}, 30000);

resetRepoForm();
api.refreshLocal().catch(() => {});
refresh().then(() => {
  if (!$$('.nav-btn.active').length) showTab('repos');
});
