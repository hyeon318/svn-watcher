# SVN Watcher

여러 SVN 저장소의 새 커밋을 감시해 Windows 알림을 띄우는 트레이 상주 앱 (Electron).

## 실행 / 빌드

```bash
npm install
npm start          # Tailwind CSS 빌드 후 실행 (개발)
npm test           # 단위 + svn 통합 테스트 (svnadmin 필요)
npm run smoke      # 임시 저장소로 앱 전체 흐름 확인, smoke-out/ 에 화면 캡처
npm run dist       # 아이콘/CSS 빌드 후 release/ 에 설치 파일 + 포터블 exe 생성
```

필요 조건: `svn.exe` 1.10 이상 (TortoiseSVN 설치 시 *command line client tools* 선택).

## 서버 부하를 줄이는 방식

| 단계 | 명령 | 언제 |
|---|---|---|
| 1. 핑 | `svn info --xml URL` (마지막 커밋 리비전·작성자·시간) | 매 주기 |
| 2. 로그 | `svn log --xml -v -r 최신:이전+1 -l 50 URL` | 1단계 리비전이 증가했을 때만 |

- 저장소 HEAD 가 아닌 **해당 경로의 마지막 커밋**(commit revision)과 비교 → 같은 저장소의 다른 경로 커밋에는 반응하지 않음
- 내 로컬 수정/업데이트 필요 여부는 `svn status -q` / `svn info` 를 작업 복사본에 실행 (로컬 디스크만 읽음, 서버 접속 없음)
- 처음 등록할 때는 기준 리비전만 저장 (과거 이력 조회 / 알림 폭탄 없음)
- 한 번에 최대 50건 (설정 가능)만 조회하며, 최신 커밋부터 가져옴
- 저장소마다 독립 타이머. 실행이 끝난 뒤 다음 실행을 예약하므로 호출이 겹치지 않음
- 앱 시작 시 저장소마다 시작 시점을 분산, 강제 동기화는 동시 3개까지
- 오류가 나면 확인 간격을 2배씩 늘려 재시도 (최대 60분)
- 절전·화면 잠금 중에는 중단. 잠금 해제 3초 / 절전 복귀 15초 후 전체 저장소를 순차 확인 (밀린 커밋 알림)

## 구조

```
src/main/
  main.js       앱 수명주기, 각 모듈 연결 (controller)
  poller.js     RepoPoller(저장소 1개) / PollerManager(전체 타이머)
  svn.js        svn 실행 (execFile, --non-interactive, 비밀번호는 stdin), 오류 분류
  logParser.js  log XML 파싱 + 작성자/경로 필터
  svnXml.js     info / status XML 파싱
  format.js     알림 문구
  config.js     electron-store: 저장소/리비전 상태/히스토리/설정, safeStorage 비밀번호 암호화
  notifier.js   Windows 알림 (클릭 동작)
  tray.js       트레이 아이콘·메뉴
  windows.js    설정 창
  ipc.js        렌더러 ↔ 메인 IPC
src/preload/preload.js   contextBridge 로 window.api 노출
src/renderer/            설정 화면 (Vanilla JS + 로컬 빌드 Tailwind, 인터넷 불필요)
scripts/gen-icons.js     아이콘 PNG 생성 (의존성 없음)
```

설정 파일 위치: `%APPDATA%\SVN Watcher\config.json`

> 예전 이름 RingTheSVN 에서 바뀌었습니다. 첫 실행 시 `%APPDATA%\RingTheSVN` 의 설정을 자동으로 복사합니다(원본은 백업으로 유지).
