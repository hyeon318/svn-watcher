'use strict';

// 이전 이름(RingTheSVN) → SVN Watcher 설정 이전
// app ready 전에 실행해야 함 (Chromium 이 Local State 를 읽기 전)

const fs = require('fs');
const path = require('path');

const LEGACY_NAMES = ['RingTheSVN'];

// config.json: 저장소/상태/기록/설정
// Local State: 앱에서 입력한 비밀번호 암호화 키 (없으면 기존 비밀번호를 풀 수 없음)
// Local Storage: 화면 선택 상태 (최근 커밋 저장소 필터 등)
const COPY_ITEMS = ['config.json', 'Local State', 'Local Storage'];

/**
 * 새 설정 폴더에 config.json 이 없고 예전 폴더에 있으면 1회 복사. 원본은 백업으로 그대로 둠
 * @returns {string|null} 복사해 온 예전 폴더 경로
 */
function migrateLegacyUserData(appDataDir, userDataDir) {
  if (fs.existsSync(path.join(userDataDir, 'config.json'))) return null;

  for (const name of LEGACY_NAMES) {
    const src = path.join(appDataDir, name);
    if (path.resolve(src).toLowerCase() === path.resolve(userDataDir).toLowerCase()) continue;
    if (!fs.existsSync(path.join(src, 'config.json'))) continue;

    fs.mkdirSync(userDataDir, { recursive: true });
    for (const item of COPY_ITEMS) {
      const from = path.join(src, item);
      if (!fs.existsSync(from)) continue;
      try {
        fs.cpSync(from, path.join(userDataDir, item), { recursive: true, force: true });
      } catch {
        // Local Storage 는 예전 앱이 실행 중이면 일부 잠겨 있을 수 있음 (필수 아님)
        if (item === 'config.json') throw new Error(`설정 복사 실패: ${from}`);
      }
    }
    try {
      fs.writeFileSync(
        path.join(src, '_SVN Watcher 로 이전됨.txt'),
        `이 폴더의 설정은 ${new Date().toLocaleString('ko-KR')} 에 SVN Watcher 로 복사되었습니다.\r\n` +
          `새 설정 위치: ${userDataDir}\r\n` +
          `SVN Watcher 가 정상 동작하면 이 폴더는 삭제해도 됩니다.\r\n`,
        'utf8'
      );
    } catch {
      /* 안내 파일은 실패해도 무관 */
    }
    return src;
  }
  return null;
}

module.exports = { migrateLegacyUserData, LEGACY_NAMES };
