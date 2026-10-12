'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'logentry' || name === 'path',
});

function text(node) {
  if (node == null) return '';
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return String(node);
}

/**
 * `svn log --xml -v` 출력 → 커밋 배열 (리비전 내림차순)
 */
function parseLogXml(xml) {
  const doc = parser.parse(xml);
  const entries = doc?.log?.logentry ?? [];
  return entries
    .map((e) => ({
      revision: Number(e.revision),
      author: text(e.author).trim() || '(no author)',
      date: text(e.date).trim(),
      message: text(e.msg).replace(/\r\n/g, '\n').trim(),
      paths: (e.paths?.path ?? []).map((p) => ({
        action: (typeof p === 'object' && p.action) || '?',
        kind: (typeof p === 'object' && p.kind) || '',
        path: text(p).trim(),
      })),
    }))
    .filter((e) => Number.isFinite(e.revision))
    .sort((a, b) => b.revision - a.revision);
}

function normalizePrefix(p) {
  let s = p.trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return s.toLowerCase();
}

/**
 * 저장소별 필터 적용
 *  - excludeAuthors: 대소문자 무시 작성자 제외 (예: 내 계정)
 *  - includePaths: 저장소 루트 기준 경로 접두사. 하나라도 걸리는 커밋만 통과 (비어있으면 전부 통과)
 */
function applyFilters(entries, filters = {}) {
  const excluded = new Set(
    (filters.excludeAuthors || []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const prefixes = (filters.includePaths || []).filter((s) => s && s.trim()).map(normalizePrefix);

  return entries.filter((e) => {
    if (excluded.has(e.author.toLowerCase())) return false;
    if (prefixes.length === 0) return true;
    return e.paths.some((p) => {
      const lower = p.path.toLowerCase();
      return prefixes.some((pre) => lower.startsWith(pre));
    });
  });
}

module.exports = { parseLogXml, applyFilters };
