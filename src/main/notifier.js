'use strict';

const path = require('path');
const { Notification } = require('electron');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

class Notifier {
  /**
   * @param {{ isMuted: () => boolean, isSilent: () => boolean }} opts
   */
  constructor({ isMuted, isSilent }) {
    this.isMuted = isMuted;
    this.isSilent = isSilent;
    // 참조를 잡아두지 않으면 GC 되어 click 이벤트가 동작하지 않음
    this.live = new Set();
  }

  /**
   * @param {{title:string, body:string, onClick?:Function, force?:boolean}} n
   * @returns {boolean} 표시 여부
   */
  show({ title, body, onClick, force = false }) {
    if (!Notification.isSupported()) return false;
    if (!force && this.isMuted()) return false;

    const n = new Notification({ title, body, icon: ICON, silent: this.isSilent() });
    this.live.add(n);
    const release = () => this.live.delete(n);
    n.on('click', () => {
      release();
      onClick?.();
    });
    n.on('close', release);
    n.on('failed', release);
    n.show();
    // 알림 센터로 넘어간 뒤에도 click 이 가능하도록 일정 시간 유지
    setTimeout(release, 10 * 60 * 1000).unref?.();
    return true;
  }
}

module.exports = { Notifier };
