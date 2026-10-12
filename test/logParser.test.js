'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLogXml, applyFilters } = require('../src/main/logParser');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="12">
<author>kim</author>
<date>2026-10-07T07:00:00.000000Z</date>
<paths>
<path prop-mods="false" text-mods="true" kind="file" action="M">/trunk/MES/Server/A.cs</path>
<path prop-mods="false" text-mods="true" kind="file" action="A">/trunk/MES/Server/B.cs</path>
</paths>
<msg>라인 상태 수정
두번째 줄 &lt;태그&gt;</msg>
</logentry>
<logentry revision="11">
<author>lee</author>
<date>2026-10-07T06:00:00.000000Z</date>
<paths>
<path kind="file" action="D">/branches/x/readme.txt</path>
</paths>
<msg></msg>
</logentry>
<logentry revision="13">
<date>2026-10-07T08:00:00.000000Z</date>
<msg>123</msg>
</logentry>
</log>`;

test('parseLogXml: 필드 추출 및 리비전 내림차순 정렬', () => {
  const list = parseLogXml(XML);
  assert.deepStrictEqual(list.map((e) => e.revision), [13, 12, 11]);
  const e12 = list[1];
  assert.strictEqual(e12.author, 'kim');
  assert.strictEqual(e12.message, '라인 상태 수정\n두번째 줄 <태그>');
  assert.deepStrictEqual(e12.paths, [
    { action: 'M', kind: 'file', path: '/trunk/MES/Server/A.cs' },
    { action: 'A', kind: 'file', path: '/trunk/MES/Server/B.cs' },
  ]);
  assert.strictEqual(list[2].message, '');
  assert.strictEqual(list[0].author, '(no author)');
  assert.strictEqual(list[0].message, '123');
  assert.deepStrictEqual(list[0].paths, []);
});

test('parseLogXml: 빈 로그', () => {
  assert.deepStrictEqual(parseLogXml('<?xml version="1.0"?><log>\n</log>'), []);
});

test('applyFilters: 작성자 제외 / 경로 접두사', () => {
  const list = parseLogXml(XML);
  assert.deepStrictEqual(applyFilters(list, { excludeAuthors: ['KIM'] }).map((e) => e.revision), [13, 11]);
  assert.deepStrictEqual(applyFilters(list, { includePaths: ['trunk/mes'] }).map((e) => e.revision), [12]);
  assert.deepStrictEqual(applyFilters(list, {}).length, 3);
});
