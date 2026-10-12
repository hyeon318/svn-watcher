'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacyUserData } = require('../src/main/migrate');

function setup() {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const legacy = path.join(appData, 'RingTheSVN');
  fs.mkdirSync(path.join(legacy, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), '{"repos":[1,2]}');
  fs.writeFileSync(path.join(legacy, 'Local State'), '{"os_crypt":{}}');
  fs.writeFileSync(path.join(legacy, 'Local Storage', 'leveldb', '000.log'), 'x');
  fs.mkdirSync(path.join(legacy, 'Cache'));
  return { appData, legacy, target: path.join(appData, 'SVN Watcher') };
}

test('migrate: 예전 설정(config / 암호화 키 / 화면 상태)만 복사, 원본 유지', () => {
  const { appData, legacy, target } = setup();
  assert.strictEqual(migrateLegacyUserData(appData, target), legacy);
  assert.strictEqual(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"repos":[1,2]}');
  assert.ok(fs.existsSync(path.join(target, 'Local State')));
  assert.ok(fs.existsSync(path.join(target, 'Local Storage', 'leveldb', '000.log')));
  assert.ok(!fs.existsSync(path.join(target, 'Cache')), '캐시는 복사하지 않음');
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')), '원본은 백업으로 유지');
  fs.rmSync(appData, { recursive: true, force: true });
});

test('migrate: 새 설정이 이미 있으면 덮어쓰지 않음 / 예전 설정 없으면 아무것도 안 함', () => {
  const { appData, target } = setup();
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'config.json'), '{"repos":[]}');
  assert.strictEqual(migrateLegacyUserData(appData, target), null);
  assert.strictEqual(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"repos":[]}');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  assert.strictEqual(migrateLegacyUserData(empty, path.join(empty, 'SVN Watcher')), null);
  fs.rmSync(appData, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
