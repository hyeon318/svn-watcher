'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSolutions } = require('../src/main/findSolutions');

test('findSolutions: 2단계까지, bin/obj/.svn 제외', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sln-'));
  const mk = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  };
  mk('Main.sln');
  mk('Tools/Tool.sln');
  mk('a/b/Deep.sln');
  mk('a/b/c/TooDeep.sln');
  mk('bin/Skip.sln');
  mk('.svn/Skip.sln');
  const rel = findSolutions(root).map((p) => path.relative(root, p).replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(rel, ['Main.sln', 'Tools/Tool.sln', 'a/b/Deep.sln']);
  assert.deepStrictEqual(findSolutions(path.join(root, 'nope')), []);
  fs.rmSync(root, { recursive: true, force: true });
});
