'use strict';

const { parseLogXml, applyFilters } = require('./logParser');

const MINUTE = 60 * 1000;
const MAX_BACKOFF = 60 * MINUTE;

/**
 * 저장소 1개의 폴링 담당.
 * setInterval 대신 "실행 완료 후 다음 예약" 방식이라 svn 응답이 느려도 호출이 겹치지 않음.
 *
 * ctx: {
 *   svn, getConn(repo), getState(id), setState(id, patch), getSettings(),
 *   onCommits(repo, entries, range), onStatus(id, status), onError?(repo, err, consecutive)
 * }
 */
class RepoPoller {
  constructor(repo, ctx) {
    this.repo = repo;
    this.ctx = ctx;
    this.timer = null;
    this.running = null;
    this.errors = 0;
    this.stopped = true;
    this.status = { state: repo.paused ? 'paused' : 'idle', lastCheckedAt: null, lastError: null, nextAt: null };
  }

  start(delayMs = 0) {
    this.stopped = false;
    this._schedule(delayMs);
  }

  stop(state = 'paused') {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this._emit({ state: this.running ? 'checking' : state, nextAt: null });
    this._stoppedState = state;
  }

  /** 수동 확인. 일시정지 중이어도 1회 실행 (다음 예약은 하지 않음) */
  checkNow() {
    clearTimeout(this.timer);
    this.timer = null;
    return this._run();
  }

  nextDelay() {
    const base = Math.max(1, Number(this.repo.intervalMin) || 5) * MINUTE;
    if (this.errors === 0) return base;
    // 오류 시 지수 백오프: 2x, 4x, ... 최대 60분 (주기가 60분보다 길면 주기 그대로)
    return Math.min(base * 2 ** Math.min(this.errors, 10), Math.max(base, MAX_BACKOFF));
  }

  _schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._run(), ms);
    this._emit({ nextAt: Date.now() + ms });
  }

  _emit(patch) {
    Object.assign(this.status, patch);
    this.ctx.onStatus?.(this.repo.id, { ...this.status, errors: this.errors });
  }

  _run() {
    if (this.running) return this.running;
    this.running = (async () => {
      this._emit({ state: 'checking' });
      try {
        const result = await this.check();
        this.errors = 0;
        this._emit({ state: this.stopped ? this._stoppedState || 'paused' : 'ok', lastCheckedAt: Date.now(), lastError: null });
        this.ctx.onChecked?.(this.repo);
        return { ok: true, ...result };
      } catch (err) {
        this.errors++;
        this._emit({
          state: 'error',
          lastCheckedAt: Date.now(),
          lastError: err.message,
        });
        this.ctx.onError?.(this.repo, err, this.errors);
        return { ok: false, error: err.message };
      } finally {
        this.running = null;
        this._schedule(this.nextDelay());
      }
    })();
    return this.running;
  }

  async check() {
    const { svn } = this.ctx;
    const repo = this.repo;
    const conn = this.ctx.getConn(repo);

    // 1단계: 가벼운 핑 (svn info 1회 → 마지막 커밋 리비전/작성자/시간)
    const { commit } = await svn.info(repo.url, conn);
    const latest = commit.revision;
    const prev = this.ctx.getState(repo.id)?.lastRevision;
    this.ctx.setState(repo.id, { lastCommit: commit });

    // 첫 등록 / 저장소 재생성 등으로 리비전이 줄어든 경우 → 기준점만 저장, 알림 없음
    if (prev == null || latest < prev) {
      this.ctx.setState(repo.id, { lastRevision: latest });
      return { baseline: latest, newCount: 0 };
    }
    if (latest === prev) return { latest, newCount: 0 };

    // 2단계: 변경이 있을 때만 로그 조회
    const limit = this.ctx.getSettings().maxLogEntries || 50;
    const from = prev + 1;
    const xml = await svn.log(repo.url, from, latest, limit, conn);
    const all = parseLogXml(xml);
    const entries = applyFilters(all, repo.filters);
    const range = { from, to: latest, truncated: all.length >= limit };

    if (entries.length > 0) await this.ctx.onCommits(repo, entries, range);

    // 알림 후 상태 갱신 (로그 조회 실패 시엔 여기 안 오므로 다음 주기에 재시도)
    this.ctx.setState(repo.id, { lastRevision: latest });
    return { latest, newCount: entries.length, range };
  }
}

class PollerManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.pollers = new Map();
    this.suspended = false;
    this.suspendState = 'suspended';
    this.globalPaused = false;
  }

  _shouldRun(repo) {
    return !repo.paused && !this.globalPaused && !this.suspended;
  }

  _create(repo, delayMs) {
    const p = new RepoPoller(repo, this.ctx);
    this.pollers.set(repo.id, p);
    if (this._shouldRun(repo)) p.start(delayMs);
    else p.stop(this.suspended ? this.suspendState : 'paused');
    return p;
  }

  /** 전체 재구성. 여러 저장소가 동시에 서버를 치지 않도록 시작 시점을 분산 */
  reload(repos) {
    this.stopAll();
    this.pollers.clear();
    let i = 0;
    for (const repo of repos) {
      const delay = this._shouldRun(repo) ? 1500 + i++ * 3000 + Math.random() * 2000 : 0;
      this._create(repo, delay);
    }
  }

  /** 저장소 1개만 갱신 (설정 저장 시 즉시 재시작) */
  upsert(repo) {
    this.pollers.get(repo.id)?.stop();
    this._create(repo, 500);
  }

  remove(id) {
    this.pollers.get(id)?.stop();
    this.pollers.delete(id);
  }

  stopAll(state) {
    for (const p of this.pollers.values()) p.stop(state);
  }

  setGlobalPaused(paused) {
    this.globalPaused = paused;
    for (const p of this.pollers.values()) {
      if (this._shouldRun(p.repo)) p.start(1000 + Math.random() * 3000);
      else p.stop();
    }
  }

  /** @param {'suspended'|'locked'} state 절전 / 화면 잠금 (상태 표시용) */
  suspend(state = 'suspended') {
    this.suspended = true;
    this.suspendState = state;
    this.stopAll(state);
  }

  resume(repos) {
    this.suspended = false;
    this.reload(repos);
  }

  syncOne(id) {
    const p = this.pollers.get(id);
    return p ? p.checkNow() : Promise.resolve({ ok: false, error: '등록되지 않은 저장소' });
  }

  /** 강제 동기화: 동시 실행 3개로 제한 */
  async syncAll(concurrency = 3) {
    const queue = [...this.pollers.values()].filter((p) => !p.repo.paused);
    const results = [];
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift();
        results.push({ id: p.repo.id, ...(await p.checkNow()) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }

  statuses() {
    const out = {};
    for (const [id, p] of this.pollers) out[id] = { ...p.status, errors: p.errors };
    return out;
  }
}

module.exports = { RepoPoller, PollerManager };
