'use strict';
/*
 * proxy/rateLimiter.js — 代理层速率限制（Phase 2b）
 *
 * 算法（D1/D2 已拍板）：
 *   - 主算法：令牌桶（按 upstream::clientIp 粒度，支持合理突发）
 *       · capacity / refillPerSecond 控制请求速率（默认 cap=100, refill=2/s ≈ 120/min）
 *   - token 维度：每桶额外维护「每分钟 token 消耗」固定窗口（maxTokensPerMinute）
 *       · 默认开启（D5）；usage 为 NULL / 0 时 usedTokens=0，token 维度不累计 → 退化为请求数维度，不拒绝请求
 *   - 全局兜底：proxy 实例级全局固定窗口 QPS（global.maxPerMinute），防单实例被打满
 *   - 不做「单纯 client_ip 全局无区分限流」（D2）
 *
 * 优雅降级（§6 / §15，与 db.js 同构）：
 *   - init 校验失败 / enabled:false / 初始化异常 → disabled=true，allow() 恒返回 allowed:true
 *   - allow()/settle() 内部 try/catch，任何运行时异常 → 记 console.warn → 放行，绝不 throw 到 handleChat
 *   - 限流是「旁路装饰」，不是 handleChat→forwardTo 的硬依赖
 *
 * 内存安全（§4 / §10）：
 *   - 桶 idle TTL 淘汰（bucketIdleTtlSec）+ size 上限（MAX_BUCKETS）防 Map 无限增长
 */

const GLOBAL_WINDOW_SEC = 60;
const MAX_BUCKETS = 10000;

const DEFAULTS = {
  enabled: true,
  sqlite: false, // Task D：true 时令牌桶状态落 SQLite（多实例共享），需 rateStore 注入且可用；否则回退内存模式
  global: { maxPerMinute: 600 },
  perUpstream: { enabled: true, maxPerMinute: 120, maxTokensPerMinute: 50000 },
  perClientIp: { enabled: true, maxPerMinute: 60 }, // 注：D2 不做单纯 client_ip 全局，此段保留兼容解析，当前不单独触发全局限流
  tokenBucket: { capacity: 100, refillPerSecond: 2 },
  bucketIdleTtlSec: 3600
};

function deepMerge(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (!over || typeof over !== 'object') return out;
  Object.keys(over).forEach(function (k) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      out[k] = Object.assign(out[k] || {}, deepMerge(base[k] || {}, over[k]));
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  });
  return out;
}

function createRateLimiter(input) {
  let disabled = false;
  let cfg = null;
  let store = null;                     // Task D：注入的 rateStore（sqlite 模式源），null=内存模式
  const buckets = new Map();            // key: `${upstream}::${clientIp}` -> bucket（仅内存模式使用）
  let globalWin = { start: Math.floor(Date.now() / 1000), count: 0 };
  let cleanupTimer = null;

  function validate(c) {
    if (typeof c !== 'object' || !c) return false;
    if (c.enabled !== undefined && typeof c.enabled !== 'boolean') return false;
    if (c.sqlite !== undefined && typeof c.sqlite !== 'boolean') return false;
    if (c.global && (typeof c.global.maxPerMinute !== 'number' || c.global.maxPerMinute < 0)) return false;
    if (c.perUpstream) {
      if (typeof c.perUpstream.enabled !== 'boolean') return false;
      if (typeof c.perUpstream.maxPerMinute !== 'number' || c.perUpstream.maxPerMinute < 0) return false;
      if (typeof c.perUpstream.maxTokensPerMinute !== 'number' || c.perUpstream.maxTokensPerMinute < 0) return false;
    }
    if (c.perClientIp) {
      if (typeof c.perClientIp.enabled !== 'boolean') return false;
      if (typeof c.perClientIp.maxPerMinute !== 'number' || c.perClientIp.maxPerMinute < 0) return false;
    }
    if (c.tokenBucket) {
      if (typeof c.tokenBucket.capacity !== 'number' || c.tokenBucket.capacity < 1) return false;
      if (typeof c.tokenBucket.refillPerSecond !== 'number' || c.tokenBucket.refillPerSecond < 0) return false; // 0 = 不补充（固定配额桶，合法）
    }
    if (c.bucketIdleTtlSec !== undefined && (typeof c.bucketIdleTtlSec !== 'number' || c.bucketIdleTtlSec < 0)) return false;
    return true;
  }

  function init(raw, storeArg) {
    try {
      store = (storeArg && typeof storeArg.runTx === 'function') ? storeArg : null;
      if (raw == null) { cfg = deepMerge(DEFAULTS, {}); disabled = false; startCleanup(); return true; }
      if (raw.enabled === false) { cfg = deepMerge(DEFAULTS, raw); disabled = true; return false; }
      const merged = deepMerge(DEFAULTS, raw);
      if (!validate(merged)) {
        console.warn('[rateLimiter] 配置校验失败，限流模块关闭（代理继续正常运行）');
        cfg = merged; disabled = true; return false;
      }
      // sqlite 模式但 store 未注入/不可用 → 回退内存，不阻断启动
      if (merged.sqlite && !store) {
        console.warn('[rateLimiter] 配置了 sqlite=true 但 rateStore 不可用，回退内存模式');
        merged.sqlite = false;
      }
      cfg = merged; disabled = false; startCleanup();
      return true;
    } catch (e) {
      console.warn('[rateLimiter] 初始化异常，限流关闭：' + e.message);
      disabled = true; return false;
    }
  }

  function nowSec() { return Math.floor(Date.now() / 1000); }
  function nowMs() { return Date.now(); }

  function makeBucket() {
    return {
      tokens: cfg.tokenBucket.capacity,
      lastRefill: nowMs(),
      tokenCount: 0,
      tokenWinStart: nowSec(),
      tokenLimited: false,
      lastAccess: nowMs()
    };
  }

  function refillBucket(b) {
    const cap = cfg.tokenBucket.capacity;
    const rate = cfg.tokenBucket.refillPerSecond;
    const t = nowMs();
    const dt = (t - b.lastRefill) / 1000;
    if (dt > 0) b.tokens = Math.min(cap, b.tokens + dt * rate);
    b.lastRefill = t;
    const ws = nowSec();
    if (ws - b.tokenWinStart >= GLOBAL_WINDOW_SEC) {
      b.tokenWinStart = ws; b.tokenCount = 0; b.tokenLimited = false;
    }
    b.lastAccess = t;
  }

  function getBucket(upstream, clientIp) {
    const key = upstream + '::' + clientIp;
    let b = buckets.get(key);
    if (!b) {
      b = makeBucket();
      buckets.set(key, b);
      if (buckets.size > MAX_BUCKETS) evictOldest();
    }
    refillBucket(b);
    return b;
  }

  function evictOldest() {
    let oldestKey = null, oldest = Infinity;
    for (const pair of buckets) {
      if (pair[1].lastAccess < oldest) { oldest = pair[1].lastAccess; oldestKey = pair[0]; }
    }
    if (oldestKey) buckets.delete(oldestKey);
  }

  function collectExpired() {
    if (!cfg) return;
    if (store) { store.pruneOld(cfg.bucketIdleTtlSec * 1000); return; }   // Task D：sqlite 模式由 store 清理
    const ttl = cfg.bucketIdleTtlSec * 1000;
    const t = nowMs();
    for (const pair of buckets) {
      if (t - pair[1].lastAccess > ttl) buckets.delete(pair[0]);
    }
  }

  function startCleanup() {
    if (cleanupTimer || !cfg) return;
    const interval = Math.max(10000, Math.floor((cfg.bucketIdleTtlSec * 1000) / 6));
    cleanupTimer = setInterval(collectExpired, interval);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }

  function checkGlobal() {
    const max = cfg.global.maxPerMinute;
    const t = nowSec();
    if (t - globalWin.start >= GLOBAL_WINDOW_SEC) { globalWin.start = t; globalWin.count = 0; }
    if (globalWin.count >= max) {
      return { allowed: false, retryAfter: Math.max(1, GLOBAL_WINDOW_SEC - (t - globalWin.start)), scope: 'global', reason: 'rate_limited: global QPS exceeded' };
    }
    return { allowed: true };
  }

  function allow(opts) {
    if (disabled) return { allowed: true };
    if (store) return allowSqlite(opts);   // Task D：sqlite 模式（多实例共享），单事务原子决策
    try {
      const upstream = (opts && opts.upstream) ? opts.upstream : 'global';
      const clientIp = (opts && opts.clientIp) ? opts.clientIp : '';
      const g = checkGlobal();
      if (!g.allowed) return g;
      globalWin.count++;   // 通过全局检查即计入（全局维度）
      if (cfg.perUpstream.enabled) {
        const b = getBucket(upstream, clientIp);
        if (b.tokenLimited) {
          return { allowed: false, retryAfter: Math.max(1, GLOBAL_WINDOW_SEC - (nowSec() - b.tokenWinStart)), scope: 'upstream', reason: 'rate_limited: upstream tokens-per-minute exceeded' };
        }
        if (b.tokens < 1) {
          const rr = Math.ceil((1 - b.tokens) / cfg.tokenBucket.refillPerSecond);
          return { allowed: false, retryAfter: Math.max(1, rr), scope: 'upstream', reason: 'rate_limited: upstream token-bucket empty' };
        }
        b.tokens -= 1;
      }
      return { allowed: true };
    } catch (e) {
      console.warn('[rateLimiter] allow 异常，放行：' + e.message);
      return { allowed: true };
    }
  }

  function settle(opts) {
    if (disabled) return;
    if (store) { settleSqlite(opts); return; }   // Task D：sqlite 模式
    try {
      const upstream = (opts && opts.upstream) ? opts.upstream : 'global';
      const clientIp = (opts && opts.clientIp) ? opts.clientIp : '';
      const used = (opts && typeof opts.usedTokens === 'number' && isFinite(opts.usedTokens) && opts.usedTokens > 0) ? opts.usedTokens : 0;
      if (!cfg.perUpstream.enabled || used === 0) return;   // D5：usage NULL/0 退化为请求数维度
      const b = getBucket(upstream, clientIp);
      b.tokenCount += used;
      if (b.tokenCount >= cfg.perUpstream.maxTokensPerMinute) b.tokenLimited = true;
    } catch (e) {
      console.warn('[rateLimiter] settle 异常，忽略：' + e.message);
    }
  }

  // ---------- Task D：sqlite 模式（多实例共享） ----------
  // 单事务内完成「读桶→补充→判定→扣减→写回」，跨进程由 SQLite 写锁串行化。
  function allowSqlite(opts) {
    try {
      const upstream = (opts && opts.upstream) ? opts.upstream : 'global';
      const clientIp = (opts && opts.clientIp) ? opts.clientIp : '';
      const key = upstream + '::' + clientIp;
      const out = store.runTx(function (tx) {
        // 全局窗口（共享）
        const g = tx.getGlobal();
        const t = nowSec();
        if (t - g.winStart >= GLOBAL_WINDOW_SEC) { g.winStart = t; g.count = 0; }
        if (g.count >= cfg.global.maxPerMinute) {
          tx.setGlobal(g.winStart, g.count);
          return { allowed: false, retryAfter: Math.max(1, GLOBAL_WINDOW_SEC - (t - g.winStart)), scope: 'global', reason: 'rate_limited: global QPS exceeded' };
        }
        g.count++;
        tx.setGlobal(g.winStart, g.count);
        if (cfg.perUpstream.enabled) {
          const tms = nowMs();
          let b = tx.getBucket(key);
          if (!b) b = { tokens: cfg.tokenBucket.capacity, lastRefill: tms, tokenCount: 0, tokenWinStart: nowSec(), tokenLimited: false, lastAccess: tms };
          const cap = cfg.tokenBucket.capacity, rate = cfg.tokenBucket.refillPerSecond, dt = (tms - b.lastRefill) / 1000;
          if (dt > 0) b.tokens = Math.min(cap, b.tokens + dt * rate);
          b.lastRefill = tms;
          const ws = nowSec();
          if (ws - b.tokenWinStart >= GLOBAL_WINDOW_SEC) { b.tokenWinStart = ws; b.tokenCount = 0; b.tokenLimited = false; }
          if (b.tokenLimited) {
            b.lastAccess = tms; tx.putBucket(key, b);
            return { allowed: false, retryAfter: Math.max(1, GLOBAL_WINDOW_SEC - (ws - b.tokenWinStart)), scope: 'upstream', reason: 'rate_limited: upstream tokens-per-minute exceeded' };
          }
          if (b.tokens < 1) {
            b.lastAccess = tms; tx.putBucket(key, b);
            const rr = Math.ceil((1 - b.tokens) / rate);
            return { allowed: false, retryAfter: Math.max(1, rr), scope: 'upstream', reason: 'rate_limited: upstream token-bucket empty' };
          }
          b.tokens -= 1;
          b.lastAccess = tms;
          tx.putBucket(key, b);
        }
        return { allowed: true };
      });
      return out || { allowed: true };   // 事务异常 → 放行
    } catch (e) {
      console.warn('[rateLimiter] sqlite allow 异常，放行：' + e.message);
      return { allowed: true };
    }
  }

  function settleSqlite(opts) {
    try {
      const upstream = (opts && opts.upstream) ? opts.upstream : 'global';
      const clientIp = (opts && opts.clientIp) ? opts.clientIp : '';
      const used = (opts && typeof opts.usedTokens === 'number' && isFinite(opts.usedTokens) && opts.usedTokens > 0) ? opts.usedTokens : 0;
      if (!cfg.perUpstream.enabled || used === 0) return;   // D5
      const key = upstream + '::' + clientIp;
      store.runTx(function (tx) {
        let b = tx.getBucket(key);
        if (!b) return;   // 该 key 从未被 allow 创建 → 无需累计
        const tms = nowMs();
        const ws = nowSec();
        if (ws - b.tokenWinStart >= GLOBAL_WINDOW_SEC) { b.tokenWinStart = ws; b.tokenCount = 0; b.tokenLimited = false; }
        b.tokenCount += used;
        if (b.tokenCount >= cfg.perUpstream.maxTokensPerMinute) b.tokenLimited = true;
        b.lastAccess = tms;
        tx.putBucket(key, b);
      });
    } catch (e) {
      console.warn('[rateLimiter] sqlite settle 异常，忽略：' + e.message);
    }
  }

  function status() {
    const t = nowSec();
    if (store) {
      const gInfo = store.runTx(function (tx) { return tx.getGlobal(); }) || { winStart: t, count: 0 };
      let globalRemain = GLOBAL_WINDOW_SEC - (t - gInfo.winStart);
      if (globalRemain < 0) globalRemain = 0;
      const snaps = store.snapshot();
      const out = snaps.map(function (v) {
        return {
          key: v.key,
          tokens: Math.round(v.tokens * 100) / 100,
          capacity: cfg.tokenBucket.capacity,
          refillPerSecond: cfg.tokenBucket.refillPerSecond,
          tokenCount: v.tokenCount,
          tokenMax: cfg.perUpstream.maxTokensPerMinute,
          limited: v.tokenLimited
        };
      });
      return {
        disabled: disabled,
        sqlite: true,
        global: { count: gInfo.count, maxPerMinute: cfg.global.maxPerMinute, windowRemainSec: globalRemain },
        buckets: out
      };
    }
    let globalRemain = GLOBAL_WINDOW_SEC - (t - globalWin.start);
    if (globalRemain < 0) globalRemain = 0;
    const out = [];
    for (const pair of buckets) {
      const v = pair[1];
      out.push({
        key: pair[0],
        tokens: Math.round(v.tokens * 100) / 100,
        capacity: cfg.tokenBucket.capacity,
        refillPerSecond: cfg.tokenBucket.refillPerSecond,
        tokenCount: v.tokenCount,
        tokenMax: cfg.perUpstream.maxTokensPerMinute,
        limited: v.tokenLimited
      });
    }
    return {
      disabled: disabled,
      sqlite: false,
      global: {
        count: globalWin.count,
        maxPerMinute: cfg.global.maxPerMinute,
        windowRemainSec: globalRemain
      },
      buckets: out
    };
  }

  return {
    init: init,
    allow: allow,
    settle: settle,
    status: status,
    isEnabled: function () { return !disabled; },
    collectExpired: collectExpired,
    // 仅供单测断言内部状态（不计入对外 API）
    _state: function () { return { disabled: disabled, buckets: buckets, globalWin: globalWin }; }
  };
}

module.exports = { createRateLimiter: createRateLimiter };
