'use strict';

// svn info --xml / svn status --xml 파서

const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'entry' || name === 'target',
});

const text = (n) => (n == null ? '' : typeof n === 'object' ? String(n['#text'] ?? '') : String(n));

/**
 * @returns {{ revision:number, url:string, commit:{revision:number, author:string, date:string} }}
 */
function parseInfoXml(xml) {
  const entry = parser.parse(xml)?.info?.entry?.[0];
  if (!entry) throw new Error('svn info 결과를 해석할 수 없습니다');
  const commit = entry.commit || {};
  return {
    revision: Number(entry.revision),
    url: text(entry.url),
    commit: {
      revision: Number(commit.revision),
      author: text(commit.author) || '(no author)',
      date: text(commit.date),
    },
  };
}

const COUNTED = ['modified', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'obstructed', 'incomplete'];
const LETTER = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  replaced: 'R',
  conflicted: 'C',
  missing: '!',
  obstructed: '~',
  incomplete: '!',
  normal: ' ',
};

// 빌드할 때마다 바뀌는 산출물 (저장소에 잘못 커밋돼 있어도 "내 수정"으로 세지 않음)
const BUILD_OUTPUT_RE = /(^|\/)(bin|obj|\.vs)(\/|$)|\.(suo|user)$/i;

function isBuildOutput(relPath) {
  return BUILD_OUTPUT_RE.test(relPath);
}

/**
 * `svn status --xml -q` → 로컬 수정 요약
 *  - total/counts/files: 소스 수정 (빌드 산출물 제외, 단 충돌은 항상 포함)
 *  - buildTotal/buildFiles: bin·obj·.vs 등 빌드 산출물 변경
 * @param {string} base 작업 복사본 경로 (표시용 상대경로 계산)
 */
function parseStatusXml(xml, base = '', maxFiles = 300) {
  const targets = parser.parse(xml)?.status?.target ?? [];
  const counts = Object.fromEntries([...COUNTED, 'props'].map((k) => [k, 0]));
  const files = [];
  const buildFiles = [];
  let total = 0;
  let buildTotal = 0;

  for (const t of targets) {
    for (const e of t.entry ?? []) {
      const st = e['wc-status'] || {};
      const item = st.item || 'normal';
      const propsChanged = st.props === 'modified' || st.props === 'conflicted';
      const treeConflict = st['tree-conflicted'] === 'true';
      if (item === 'unversioned' || item === 'external' || item === 'ignored') continue;

      let kind = null;
      if (treeConflict || st.props === 'conflicted') kind = 'conflicted';
      else if (COUNTED.includes(item)) kind = item;
      else if (propsChanged) kind = 'props';
      if (!kind) continue;

      const abs = String(e.path || '');
      const rel = (base ? path.relative(base, abs) || abs : abs).replace(/\\/g, '/');
      const file = { path: rel, item: kind, letter: kind === 'props' ? 'P' : LETTER[kind] || '?' };

      if (kind !== 'conflicted' && isBuildOutput(rel)) {
        buildTotal++;
        if (buildFiles.length < maxFiles) buildFiles.push(file);
        continue;
      }
      counts[kind]++;
      total++;
      if (files.length < maxFiles) files.push(file);
    }
  }
  return { total, counts, files, truncated: total > files.length, buildTotal, buildFiles };
}

module.exports = { parseInfoXml, parseStatusXml, isBuildOutput };
