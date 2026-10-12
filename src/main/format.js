'use strict';

// 알림 문구 생성 (Electron 의존 없음 → 테스트 가능)

const MAX_LINES = 4;

function firstLine(msg) {
  const line = (msg || '').split('\n').find((l) => l.trim()) || '(메시지 없음)';
  return line.trim();
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function basename(p) {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function filesSummary(paths) {
  if (!paths || paths.length === 0) return '';
  const names = paths.slice(0, 3).map((p) => basename(p.path));
  const rest = paths.length - names.length;
  return `파일 ${paths.length}개: ${names.join(', ')}${rest > 0 ? ` 외 ${rest}개` : ''}`;
}

/**
 * @param {{name:string}} repo
 * @param {Array} entries 리비전 내림차순
 * @param {{truncated?:boolean}} range
 */
function formatCommitNotification(repo, entries, range = {}) {
  if (entries.length === 1) {
    const e = entries[0];
    const msgLines = (e.message || '(메시지 없음)')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 3)
      .map((l) => clip(l.trim(), 80));
    const files = filesSummary(e.paths);
    return {
      title: `${repo.name} · r${e.revision} ${e.author}`,
      body: [...msgLines, files].filter(Boolean).join('\n'),
    };
  }

  const count = `${entries.length}${range.truncated ? '+' : ''}`;
  const lines = entries
    .slice(0, MAX_LINES)
    .map((e) => clip(`r${e.revision} ${e.author}: ${firstLine(e.message)}`, 70));
  const rest = entries.length - MAX_LINES;
  if (rest > 0) lines.push(`외 ${rest}건${range.truncated ? ' 이상' : ''}`);
  return {
    title: `${repo.name} · 새 커밋 ${count}건`,
    body: lines.join('\n'),
  };
}

module.exports = { formatCommitNotification, firstLine };
