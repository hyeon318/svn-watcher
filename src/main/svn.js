'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { parseInfoXml, parseStatusXml } = require('./svnXml');

const SVN_CANDIDATES = [
  'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
  'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
  'C:\\Program Files\\VisualSVN\\bin\\svn.exe',
  'C:\\Program Files (x86)\\VisualSVN\\bin\\svn.exe',
  'C:\\Program Files\\CollabNet\\Subversion Client\\svn.exe',
];

const TORTOISE_CANDIDATES = [
  'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe',
  'C:\\Program Files (x86)\\TortoiseSVN\\bin\\TortoiseProc.exe',
];

const TRUST_FAILURES = 'unknown-ca,cn-mismatch,expired,not-yet-valid,other';

class SvnError extends Error {
  constructor(message, { kind = 'other', stderr = '' } = {}) {
    super(message);
    this.name = 'SvnError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

// svn 의 일반 출력은 시스템 코드페이지(한글 Windows = CP949), --xml 은 UTF-8
function decode(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('euc-kr').decode(buf);
  } catch {
    return utf8;
  }
}

function classify(stderr) {
  const s = stderr || '';
  if (/E170001|E215004|E170013.*auth|authoriz/i.test(s)) return { kind: 'auth', label: '인증 실패' };
  if (/E230001|certificate/i.test(s)) return { kind: 'cert', label: '서버 인증서 오류' };
  if (/E170013|E175002|E731001|E730|E120|Unable to connect|No such host/i.test(s))
    return { kind: 'network', label: '서버 연결 실패' };
  if (/E160013|E170000|non-existent|path not found/i.test(s)) return { kind: 'notfound', label: '경로 없음' };
  if (/E155007|is not a working copy/i.test(s)) return { kind: 'notwc', label: '작업 복사본이 아님' };
  if (/E155004|locked|E155037/i.test(s)) return { kind: 'locked', label: '작업 복사본 잠김 (svn cleanup 필요)' };
  return { kind: 'other', label: 'svn 오류' };
}

function firstErrorLine(stderr) {
  const lines = (stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // "svn: E170013: Unable to connect..." 중 가장 구체적인 마지막 E 코드 줄
  const eLines = lines.filter((l) => /svn: E\d+/.test(l));
  return (eLines[eLines.length - 1] || lines[0] || '').replace(/^svn:\s*/, '');
}

function parseUpdateOutput(out) {
  const lines = out.split(/\r?\n/);
  let revision = null;
  let changed = 0;
  let conflicts = 0;
  for (const line of lines) {
    const m = line.match(/(?:Updated to|At) revision (\d+)/);
    if (m) revision = Number(m[1]);
    const c = line.match(/^([ADUCGER ])([ADUCGER ])[ B]?[ C]?\s+\S/);
    if (c && (c[1] !== ' ' || c[2] !== ' ')) {
      changed++;
      if (c[1] === 'C' || c[2] === 'C') conflicts++;
    }
  }
  const summary = out.match(/conflicts:\s*(\d+)/gi);
  if (summary && conflicts === 0) {
    conflicts = summary.reduce((n, s) => n + Number(s.match(/\d+/)[0]), 0);
  }
  return { revision, changed, conflicts };
}

class SvnClient {
  /**
   * @param {() => {svnPath?: string, timeoutSec?: number}} getConfig
   */
  constructor(getConfig = () => ({})) {
    this.getConfig = getConfig;
  }

  resolveSvnPath() {
    const configured = (this.getConfig().svnPath || '').trim();
    if (configured) return configured;
    return SVN_CANDIDATES.find((p) => fs.existsSync(p)) || 'svn';
  }

  static findTortoiseProc() {
    return TORTOISE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  }

  _exec(args, { input, timeoutMs } = {}) {
    const bin = this.resolveSvnPath();
    const timeout = timeoutMs ?? (this.getConfig().timeoutSec || 60) * 1000;
    return new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        {
          encoding: 'buffer',
          windowsHide: true,
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, LANGUAGE: 'en' },
        },
        (err, stdoutBuf, stderrBuf) => {
          const stdout = decode(stdoutBuf);
          const stderr = decode(stderrBuf);
          if (!err) return resolve({ stdout, stderr });
          if (err.code === 'ENOENT') {
            return reject(new SvnError(`svn 실행 파일을 찾을 수 없습니다 (${bin})`, { kind: 'nosvn' }));
          }
          if (err.killed) {
            return reject(new SvnError(`응답 시간 초과 (${Math.round(timeout / 1000)}초)`, { kind: 'timeout', stderr }));
          }
          const { kind, label } = classify(stderr);
          const detail = firstErrorLine(stderr) || err.message;
          reject(new SvnError(`${label}: ${detail}`, { kind, stderr }));
        }
      );
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  /**
   * @param {string} sub 서브커맨드
   * @param {string[]} args
   * @param {{username?:string, password?:string, trustCert?:boolean}} conn
   */
  run(sub, args, conn = {}) {
    const full = [sub, '--non-interactive'];
    let input;
    if (conn.username) full.push('--username', conn.username);
    if (conn.password != null && conn.password !== '') {
      // 커맨드라인에 비밀번호를 남기지 않도록 stdin 으로 전달 (svn 1.10+)
      full.push('--password-from-stdin', '--no-auth-cache');
      input = conn.password + '\n';
    }
    if (conn.trustCert) full.push(`--trust-server-cert-failures=${TRUST_FAILURES}`);
    full.push(...args);
    return this._exec(full, { input });
  }

  async version() {
    const { stdout } = await this._exec(['--version', '--quiet'], { timeoutMs: 15000 });
    return stdout.trim();
  }

  /** 1단계 핑: 해당 경로가 마지막으로 바뀐 리비전 (숫자 하나) */
  async lastChangedRevision(url, conn) {
    const { stdout } = await this.run('info', ['--show-item', 'last-changed-revision', url], conn);
    const rev = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(rev)) throw new SvnError(`리비전을 해석할 수 없습니다: "${stdout.trim()}"`);
    return rev;
  }

  /** 2단계: 변경 범위의 로그 (최신 → 과거 순, limit 개까지) */
  async log(url, fromRev, toRev, limit, conn) {
    const { stdout } = await this.run(
      'log',
      ['--xml', '-v', '-r', `${toRev}:${fromRev}`, '-l', String(limit), url],
      conn
    );
    return stdout;
  }

  /**
   * 1단계 핑 (요청 1회): 해당 경로의 마지막 커밋 리비전/작성자/시간
   * @returns {{ revision:number, url:string, commit:{revision:number, author:string, date:string} }}
   */
  async info(target, conn) {
    const { stdout } = await this.run('info', ['--xml', target], conn);
    const info = parseInfoXml(stdout);
    if (!Number.isFinite(info.commit.revision)) throw new SvnError('리비전을 해석할 수 없습니다');
    return info;
  }

  /**
   * 로컬 작업 복사본 상태 (서버 접속 없음): 내 수정 사항 + 작업 복사본 리비전
   */
  async localStatus(localPath) {
    const [{ stdout: infoXml }, { stdout: statusXml }] = await Promise.all([
      this.run('info', ['--xml', localPath]),
      this.run('status', ['--xml', '-q', '--ignore-externals', localPath]),
    ]);
    const info = parseInfoXml(infoXml);
    return { wcRevision: info.revision, wcUrl: info.url, ...parseStatusXml(statusXml, localPath) };
  }

  async workingCopyUrl(localPath, conn) {
    const { stdout } = await this.run('info', ['--show-item', 'url', localPath], conn);
    return stdout.trim();
  }

  async update(localPath, conn) {
    const { stdout } = await this.run('update', ['--accept', 'postpone', localPath], conn);
    return { ...parseUpdateOutput(stdout), output: stdout };
  }
}

module.exports = { SvnClient, SvnError, parseUpdateOutput, classify };
