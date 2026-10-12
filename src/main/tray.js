'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const TRAY_DIR = path.join(__dirname, '..', '..', 'assets', 'tray');
const STATE_LABEL = {
  ok: '정상',
  idle: '대기',
  checking: '확인 중…',
  error: '오류',
  paused: '일시정지',
  suspended: '절전 대기',
  locked: '잠금 대기',
};

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

class TrayController {
  /**
   * actions: openWindow(tab), syncAll(), syncOne(id), togglePause(id), update(id), openTortoise(id),
   *          setDnd(ms|0), setGlobalPaused(bool), quit()
   */
  constructor(actions) {
    this.actions = actions;
    this.icons = {};
    for (const s of ['normal', 'new', 'error', 'paused']) {
      // tray-xxx.png 와 tray-xxx@2x.png 를 HiDPI 에 맞춰 자동 선택
      this.icons[s] = nativeImage.createFromPath(path.join(TRAY_DIR, `tray-${s}.png`));
    }
    this.tray = new Tray(this.icons.normal);
    this.tray.on('click', () => actions.openWindow('repos'));
    this.tray.on('double-click', () => actions.openWindow('repos'));
  }

  /**
   * @param {{ repos: Array, statuses: Object, unseen: number, dndUntil: number, globalPaused: boolean, svnOk: boolean, tortoise: boolean }} m
   */
  render(m) {
    const a = this.actions;
    const now = Date.now();
    const dnd = m.dndUntil > now;
    const errors = m.repos.filter((r) => m.statuses[r.id]?.state === 'error').length;
    const active = m.repos.filter((r) => !r.paused).length;

    let icon = 'normal';
    if (m.globalPaused || (m.repos.length > 0 && active === 0)) icon = 'paused';
    if (m.unseen > 0) icon = 'new';
    if (errors > 0 || !m.svnOk) icon = 'error';
    this.tray.setImage(this.icons[icon]);

    const lastChecked = Math.max(0, ...Object.values(m.statuses).map((s) => s.lastCheckedAt || 0));
    const tip = [
      'SVN Watcher',
      !m.svnOk ? 'svn.exe 를 찾을 수 없음' : `감시 ${active}/${m.repos.length}개${errors ? ` · 오류 ${errors}개` : ''}`,
      m.unseen ? `새 커밋 ${m.unseen}건` : null,
      m.globalPaused ? '전체 일시정지 중' : null,
      dnd ? `방해 금지 ~${fmtTime(m.dndUntil)}` : null,
      `마지막 확인 ${fmtTime(lastChecked)}`,
    ]
      .filter(Boolean)
      .join('\n');
    this.tray.setToolTip(tip.slice(0, 127));

    const ordered = [...m.repos.filter((r) => r.favorite), ...m.repos.filter((r) => !r.favorite)];
    const repoItems = ordered.length
      ? ordered.map((r) => {
          const st = m.statuses[r.id] || {};
          const label = r.paused ? '일시정지' : STATE_LABEL[st.state] || '대기';
          return {
            label: `${r.favorite ? '★ ' : ''}${r.name}  (${label})`,
            submenu: [
              { label: '지금 확인', click: () => a.syncOne(r.id) },
              { label: r.paused ? '감시 재개' : '일시정지', click: () => a.togglePause(r.id) },
              { type: 'separator' },
              { label: 'svn update', enabled: !!r.localPath, click: () => a.update(r.id) },
              { label: 'TortoiseSVN 로그 보기', enabled: m.tortoise, click: () => a.openTortoise(r.id) },
            ],
          };
        })
      : [{ label: '등록된 저장소 없음', enabled: false }];

    const menu = Menu.buildFromTemplate([
      { label: `SVN Watcher${m.unseen ? `  —  새 커밋 ${m.unseen}건` : ''}`, enabled: false },
      { type: 'separator' },
      { label: '설정 열기', click: () => a.openWindow('repos') },
      { label: '최근 커밋 보기', click: () => a.openWindow('history') },
      { type: 'separator' },
      { label: '강제 동기화 (전체)', enabled: m.svnOk, click: () => a.syncAll() },
      { label: '저장소', submenu: repoItems },
      { type: 'separator' },
      {
        label: dnd ? `방해 금지 (~${fmtTime(m.dndUntil)})` : '방해 금지',
        submenu: [
          { label: '1시간', click: () => a.setDnd(60 * 60 * 1000) },
          { label: '3시간', click: () => a.setDnd(3 * 60 * 60 * 1000) },
          { label: '오늘 하루', click: () => a.setDnd('today') },
          { type: 'separator' },
          { label: '해제', enabled: dnd, click: () => a.setDnd(0) },
        ],
      },
      {
        label: '전체 일시정지',
        type: 'checkbox',
        checked: m.globalPaused,
        click: (item) => a.setGlobalPaused(item.checked),
      },
      { type: 'separator' },
      { label: '종료', click: () => a.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { TrayController };
