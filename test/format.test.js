'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatCommitNotification } = require('../src/main/format');

const mk = (rev, msg, n = 1) => ({
  revision: rev, author: 'kim', message: msg,
  paths: Array.from({ length: n }, (_, i) => ({ action: 'M', path: `/trunk/f${i}.cs` })),
});

test('단일 커밋 알림', () => {
  const r = formatCommitNotification({ name: 'MES' }, [mk(5, '버그 수정\n\n상세', 5)]);
  assert.strictEqual(r.title, 'MES · r5 kim');
  assert.strictEqual(r.body, '버그 수정\n상세\n파일 5개: f0.cs, f1.cs, f2.cs 외 2개');
});

test('다건 커밋 알림 요약', () => {
  const entries = [6, 5, 4, 3, 2, 1].map((r) => mk(r, `msg${r}`));
  const r = formatCommitNotification({ name: 'MES' }, entries, { truncated: true });
  assert.strictEqual(r.title, 'MES · 새 커밋 6+건');
  const lines = r.body.split('\n');
  assert.strictEqual(lines.length, 5);
  assert.strictEqual(lines[0], 'r6 kim: msg6');
  assert.strictEqual(lines[4], '외 2건 이상');
});
