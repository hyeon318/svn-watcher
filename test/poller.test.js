'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RepoPoller } = require('../src/main/poller');

const logXml = (revs) =>
  `<?xml version="1.0"?><log>${revs
    .map((r) => `<logentry revision="${r}"><author>a${r}</author><date>d</date><paths><path action="M" kind="file">/trunk/x${r}</path></paths><msg>m${r}</msg></logentry>`)
    .join('')}</log>`;

function setup({ latest, prev, logFails = false, filters } = {}) {
  const state = {};
  if (prev != null) state.r1 = { lastRevision: prev };
  const calls = { log: [], commits: [] };
  const svn = {
    latest,
    async info() {
      if (svn.latest instanceof Error) throw svn.latest;
      return { revision: svn.latest, commit: { revision: svn.latest, author: 'kim', date: '2026-10-07T00:00:00Z' } };
    },
    async log(url, from, to, limit) {
      calls.log.push({ from, to, limit });
      if (logFails) throw new Error('log fail');
      const revs = [];
      for (let r = to; r >= from && revs.length < limit; r--) revs.push(r);
      return logXml(revs);
    },
  };
  const ctx = {
    svn,
    getConn: () => ({}),
    getState: (id) => state[id],
    setState: (id, patch) => { state[id] = { ...state[id], ...patch }; },
    getSettings: () => ({ maxLogEntries: 3 }),
    onCommits: async (repo, entries, range) => calls.commits.push({ entries, range }),
  };
  const repo = { id: 'r1', name: 'R', url: 'file:///x', intervalMin: 1, filters };
  return { poller: new RepoPoller(repo, ctx), state, calls, svn };
}

test('첫 실행은 기준점만 저장하고 로그 조회/알림 없음', async () => {
  const { poller, state, calls } = setup({ latest: 100 });
  const r = await poller.checkNow();
  assert.strictEqual(r.baseline, 100);
  assert.strictEqual(state.r1.lastRevision, 100);
  assert.strictEqual(calls.log.length, 0);
});

test('변경 없으면 로그 조회 안 함', async () => {
  const { poller, calls } = setup({ latest: 100, prev: 100 });
  await poller.checkNow();
  assert.strictEqual(calls.log.length, 0);
});

test('리비전 증가 시 로그 조회 → 알림 → 상태 갱신', async () => {
  const { poller, state, calls } = setup({ latest: 102, prev: 100 });
  const r = await poller.checkNow();
  assert.deepStrictEqual(calls.log[0], { from: 101, to: 102, limit: 3 });
  assert.deepStrictEqual(calls.commits[0].entries.map((e) => e.revision), [102, 101]);
  assert.strictEqual(calls.commits[0].range.truncated, false);
  assert.strictEqual(state.r1.lastRevision, 102);
  assert.deepStrictEqual(state.r1.lastCommit, { revision: 102, author: 'kim', date: '2026-10-07T00:00:00Z' });
  assert.strictEqual(r.newCount, 2);
});

test('대량 변경은 최신 limit 개만, truncated 표시', async () => {
  const { poller, calls } = setup({ latest: 200, prev: 100 });
  await poller.checkNow();
  assert.deepStrictEqual(calls.commits[0].entries.map((e) => e.revision), [200, 199, 198]);
  assert.strictEqual(calls.commits[0].range.truncated, true);
});

test('로그 조회 실패 시 리비전을 갱신하지 않음 (다음에 재시도)', async () => {
  const { poller, state } = setup({ latest: 105, prev: 100, logFails: true });
  const r = await poller.checkNow();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(state.r1.lastRevision, 100);
  assert.strictEqual(poller.status.state, 'error');
});

test('필터로 전부 걸러지면 알림 없이 리비전만 갱신', async () => {
  const { poller, state, calls } = setup({ latest: 101, prev: 100, filters: { excludeAuthors: ['a101'] } });
  await poller.checkNow();
  assert.strictEqual(calls.commits.length, 0);
  assert.strictEqual(state.r1.lastRevision, 101);
});

test('리비전 감소(저장소 재생성)는 재기준점', async () => {
  const { poller, state, calls } = setup({ latest: 5, prev: 100 });
  await poller.checkNow();
  assert.strictEqual(state.r1.lastRevision, 5);
  assert.strictEqual(calls.log.length, 0);
});

test('오류 시 지수 백오프, 성공하면 복귀', async () => {
  const { poller, svn } = setup({ latest: new Error('down'), prev: 1 });
  await poller.checkNow();
  assert.strictEqual(poller.nextDelay(), 2 * 60000);
  await poller.checkNow();
  assert.strictEqual(poller.nextDelay(), 4 * 60000);
  for (let i = 0; i < 10; i++) await poller.checkNow();
  assert.strictEqual(poller.nextDelay(), 60 * 60000);
  svn.latest = 1;
  await poller.checkNow();
  assert.strictEqual(poller.nextDelay(), 60000);
});

test('동시 호출은 하나로 합쳐짐', async () => {
  const { poller, calls } = setup({ latest: 101, prev: 100 });
  await Promise.all([poller.checkNow(), poller.checkNow(), poller.checkNow()]);
  assert.strictEqual(calls.log.length, 1);
});

test('PollerManager: 잠금 중에는 타이머 중단, 해제 시 재개', () => {
  const { PollerManager } = require('../src/main/poller');
  const statuses = {};
  const m = new PollerManager({
    svn: {},
    getConn: () => ({}),
    getState: () => null,
    setState: () => {},
    getSettings: () => ({}),
    onStatus: (id, s) => (statuses[id] = s),
  });
  const repos = [
    { id: 'a', name: 'A', url: 'file:///a', intervalMin: 30 },
    { id: 'b', name: 'B', url: 'file:///b', intervalMin: 30, paused: true },
  ];
  m.reload(repos);
  assert.ok(m.pollers.get('a').timer, '시작 후 타이머 예약');

  m.suspend('locked');
  assert.strictEqual(m.pollers.get('a').timer, null, '잠금 시 타이머 해제');
  assert.strictEqual(statuses.a.state, 'locked');

  m.resume(repos);
  assert.ok(m.pollers.get('a').timer, '해제 후 다시 예약');
  assert.ok(m.pollers.get('a').status.nextAt - Date.now() < 10000, '해제 직후 곧바로 확인');
  assert.strictEqual(m.pollers.get('b').timer, null, '일시정지 저장소는 그대로 정지');
  m.stopAll();
});
