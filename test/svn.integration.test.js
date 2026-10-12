'use strict';
// 실제 svn.exe + 로컬 file:// 저장소로 2-Step 명령 검증 (svnadmin 없으면 skip)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SvnClient } = require('../src/main/svn');
const { parseLogXml } = require('../src/main/logParser');

const svn = new SvnClient(() => ({ timeoutSec: 30 }));
const bin = svn.resolveSvnPath();
const admin = bin.replace(/svn(\.exe)?$/i, 'svnadmin$1');
let hasSvn = true;
try {
  execFileSync(admin, ['--version', '--quiet']);
} catch {
  hasSvn = false;
}

test('svn 통합: info/log/update', { skip: !hasSvn && 'svnadmin 없음' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ringsvn-'));
  const repoDir = path.join(root, 'repo');
  execFileSync(admin, ['create', repoDir]);
  const url = 'file:///' + repoDir.replace(/\\/g, '/');
  const wc1 = path.join(root, 'wc1');
  const wc2 = path.join(root, 'wc2');
  execFileSync(bin, ['mkdir', '-m', 'init', `${url}/trunk`, `${url}/other`]);
  execFileSync(bin, ['checkout', `${url}/trunk`, wc1]);
  execFileSync(bin, ['checkout', `${url}/trunk`, wc2]);

  assert.strictEqual(await svn.lastChangedRevision(`${url}/trunk`), 1);

  const file = path.join(wc1, '한글파일.txt');
  fs.writeFileSync(file, 'a');
  execFileSync(bin, ['add', file]);
  execFileSync(bin, ['commit', '-m', '한글 커밋 메시지', wc1]);
  // 다른 경로 커밋은 trunk 의 last-changed 를 바꾸지 않아야 함
  execFileSync(bin, ['mkdir', '-m', 'other change', `${url}/other/sub`]);

  assert.strictEqual(await svn.lastChangedRevision(`${url}/trunk`), 2);
  const entries = parseLogXml(await svn.log(`${url}/trunk`, 2, 2, 50));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].message, '한글 커밋 메시지');
  assert.strictEqual(entries[0].paths[0].path, '/trunk/한글파일.txt');
  assert.strictEqual(entries[0].paths[0].action, 'A');

  const info = await svn.info(`${url}/trunk`);
  assert.strictEqual(info.commit.revision, 2);
  assert.ok(info.commit.author.length > 0);
  assert.ok(info.commit.date.startsWith('20'));
  assert.ok(info.revision >= 3); // 저장소 HEAD 는 other 경로 커밋까지 포함

  // 로컬 상태: 업데이트 전 wc2 는 r1, 수정/추가 사항 반영
  fs.writeFileSync(path.join(wc1, '한글파일.txt'), 'changed');
  const extra = path.join(wc1, 'added.txt');
  fs.writeFileSync(extra, 'x');
  execFileSync(bin, ['add', extra]);
  fs.writeFileSync(path.join(wc1, 'unversioned.txt'), 'x');
  const local = await svn.localStatus(wc1);
  assert.strictEqual(local.total, 2);
  assert.strictEqual(local.counts.modified, 1);
  assert.strictEqual(local.counts.added, 1);
  assert.deepStrictEqual(local.files.map((f) => f.path).sort(), ['added.txt', '한글파일.txt']);
  assert.strictEqual((await svn.localStatus(wc2)).wcRevision, 1);

  assert.strictEqual(await svn.workingCopyUrl(wc2), `${url}/trunk`);
  const up = await svn.update(wc2);
  assert.strictEqual(up.changed, 1);
  assert.strictEqual(up.conflicts, 0);
  assert.ok(up.revision >= 2);

  await assert.rejects(svn.lastChangedRevision(`${url}/nope`), (e) => e.kind === 'notfound');
  await assert.rejects(svn.workingCopyUrl(root), (e) => e.kind === 'notwc');
  fs.rmSync(root, { recursive: true, force: true });
});
