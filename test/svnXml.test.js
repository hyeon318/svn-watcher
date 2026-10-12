'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseInfoXml, parseStatusXml } = require('../src/main/svnXml');

test('parseInfoXml: 리비전 / 마지막 커밋 정보', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="trunk" revision="130">
<url>https://svn/repos/MES/trunk</url>
<commit revision="125">
<author>김개발</author>
<date>2026-10-07T07:30:00.000000Z</date>
</commit>
</entry>
</info>`;
  assert.deepStrictEqual(parseInfoXml(xml), {
    revision: 130,
    url: 'https://svn/repos/MES/trunk',
    commit: { revision: 125, author: '김개발', date: '2026-10-07T07:30:00.000000Z' },
  });
});

test('parseStatusXml: 수정 유형별 집계, 미버전/외부 제외', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="C:\\SVN\\MES">
<entry path="C:\\SVN\\MES\\a.cs"><wc-status item="modified" props="none" revision="10"/></entry>
<entry path="C:\\SVN\\MES\\b.cs"><wc-status item="added" props="none" revision="-1"/></entry>
<entry path="C:\\SVN\\MES\\c.cs"><wc-status item="deleted" props="none" revision="10"/></entry>
<entry path="C:\\SVN\\MES\\d.cs"><wc-status item="conflicted" props="none" revision="10"/></entry>
<entry path="C:\\SVN\\MES\\dir"><wc-status item="normal" props="modified" revision="10"/></entry>
<entry path="C:\\SVN\\MES\\e.cs"><wc-status item="normal" props="none" tree-conflicted="true" revision="10"/></entry>
<entry path="C:\\SVN\\MES\\new.txt"><wc-status item="unversioned" props="none"/></entry>
<entry path="C:\\SVN\\MES\\ext"><wc-status item="external" props="none"/></entry>
</target>
</status>`;
  const r = parseStatusXml(xml, 'C:\\SVN\\MES');
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.counts.modified, 1);
  assert.strictEqual(r.counts.added, 1);
  assert.strictEqual(r.counts.deleted, 1);
  assert.strictEqual(r.counts.conflicted, 2);
  assert.strictEqual(r.counts.props, 1);
  assert.deepStrictEqual(r.files[0], { path: 'a.cs', item: 'modified', letter: 'M' });
  assert.strictEqual(r.files.find((f) => f.path === 'dir').letter, 'P');
});

test('parseStatusXml: 변경 없음 / 목록 개수 제한', () => {
  assert.strictEqual(parseStatusXml('<status><target path="x"></target></status>').total, 0);
  const many = Array.from({ length: 5 }, (_, i) => `<entry path="f${i}"><wc-status item="modified" props="none"/></entry>`).join('');
  const r = parseStatusXml(`<status><target path=".">${many}</target></status>`, '', 3);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.files.length, 3);
  assert.strictEqual(r.truncated, true);
});

test('parseStatusXml: bin/obj/.vs 빌드 산출물은 내 수정에서 분리 (충돌은 유지)', () => {
  const B = 'C:/SVN/project/source';
  const e = (rel, item = 'modified') => `<entry path="${B}/${rel}"><wc-status item="${item}" props="none"/></entry>`;
  const xml = `<status><target path="${B}">${[
    e('App/obj/Debug/App.dll'),
    e('App/bin/Debug/Common.dll'),
    e('.vs/App/v14/.suo'),
    e('App/App.csproj.user'),
    e('App/obj/Debug/x.cache', 'conflicted'),
    e('App/Form1.cs'),
    e('App/Binder.cs'),
  ].join('')}</target></status>`;
  const r = parseStatusXml(xml, B);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['App/obj/Debug/x.cache', 'App/Form1.cs', 'App/Binder.cs']);
  assert.strictEqual(r.counts.conflicted, 1);
  assert.strictEqual(r.buildTotal, 4);
  assert.strictEqual(r.buildFiles[0].path, 'App/obj/Debug/App.dll');
});
