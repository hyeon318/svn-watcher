'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.svn', '.git', '.vs', 'bin', 'obj', 'node_modules', 'packages']);

/** 작업 복사본에서 .sln 찾기 (하위 depth 단계까지, 빌드/패키지 폴더 제외) */
function findSolutions(dir, depth = 2) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.sln')) out.push(path.join(dir, e.name));
  }
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase())) {
        out.push(...findSolutions(path.join(dir, e.name), depth - 1));
      }
    }
  }
  return out;
}

module.exports = { findSolutions };
