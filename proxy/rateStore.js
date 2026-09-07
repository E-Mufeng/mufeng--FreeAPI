'use strict';
/*
 * proxy/rateStore.js — 限流桶 SQLite 持久化（多实例共享，Task D）
 *
 * 作用：当 config.rateLimit.sqlite=true 时，把令牌桶状态落到 SQLite，
 *       多个代理实例（同一宿主、共享文件系统）即可共享同一套限流计数，
 *       避免「每实例各自计数」导致的全局限速被横向放大。
 *
 * 设计（与 db.js / stateStore.js 同构）：
 *   - 复用 free_api.db（WAL 模式，多连接/多进程可并发读写）。
 *   - better-sqlite3 缺失 / 建表失败 → enabled=false，限流回退内存模式（速率限制是旁路装饰，不阻断主链路）。
 *   - 仅作持久化层；限流决策逻辑仍在 rateLimiter.js，本模块提供「单事务内读-判-写」的原子能力。
 *   - runTx 用 better-sqlite3 事务 + busy_timeout，跨进程争用自动串行化。
 */

const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[rateStore] better-sqlite3 不可用，限流 SQLite 模式关闭（回退内存）：' + e.message);
}

let DB_PATH = path.join(__dirname, 'free_api.db');
let db = null;
let enabled = false;

function init(dbPath) {
  if (dbPath) DB_PATH = dbPath;
  if (!Database) { enabled = false; return false; }
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(
      'CREATE TABLE IF NOT EXISTS rate_buckets (' +
      ' key TEXT PRIMARY KEY,' +
      ' tokens REAL,' +
      ' last_refill INTEGER,' +
      ' token_count INTEGER,' +
      ' token_win_start INTEGER,' +
      ' token_limited INTEGER,' +
      ' last_access INTEGER' +
      ');' +
      'CREATE TABLE IF NOT EXISTS rate_global (' +
      ' id INTEGER PRIMARY KEY CHECK (id = 1),' +
      ' win_start INTEGER,' +
      ' count INTEGER' +
      ');'
    );
    enabled = true;
    console.log('[rateStore] 限流 SQLite 模式已启用（多实例共享）：' + DB_PATH);
    return true;
  } catch (e) {
    console.warn('[rateStore] 初始化失败，限流 SQLite 模式关闭（回退内存）：' + e.message);
    db = null;
    enabled = false;
    return false;
  }
}

function bucketFromRow(row) {
  return {
    tokens: row.tokens,
    lastRefill: row.last_refill,
    tokenCount: row.token_count,
    tokenWinStart: row.token_win_start,
    tokenLimited: !!row.token_limited,
    lastAccess: row.last_access
  };
}

/**
 * 在单个 SQLite 事务内执行 fn(helpers)，返回 fn 的返回值。
 * helpers 提供原子读写的 getBucket/putBucket/getGlobal/setGlobal。
 * 任一异常 → 返回 undefined（调用方据此放行，绝不抛到主链路）。
 */
function runTx(fn) {
  if (!enabled || !db) return undefined;
  try {
    return db.transaction(function () {
      const helpers = {
        getBucket: function (key) {
          const row = db.prepare('SELECT * FROM rate_buckets WHERE key = ?').get(key);
          return row ? bucketFromRow(row) : null;
        },
        putBucket: function (key, b) {
          db.prepare(
            'INSERT INTO rate_buckets(key, tokens, last_refill, token_count, token_win_start, token_limited, last_access) ' +
            'VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET ' +
            'tokens=excluded.tokens, last_refill=excluded.last_refill, token_count=excluded.token_count, ' +
            'token_win_start=excluded.token_win_start, token_limited=excluded.token_limited, last_access=excluded.last_access'
          ).run(key, b.tokens, b.lastRefill, b.tokenCount, b.tokenWinStart, b.tokenLimited ? 1 : 0, b.lastAccess);
        },
        getGlobal: function () {
          let row = db.prepare('SELECT * FROM rate_global WHERE id = 1').get();
          if (!row) {
            db.prepare('INSERT OR IGNORE INTO rate_global(id, win_start, count) VALUES (1,?,0)').run(Math.floor(Date.now() / 1000));
            row = db.prepare('SELECT * FROM rate_global WHERE id = 1').get();
          }
          return { winStart: row.win_start, count: row.count };
        },
        setGlobal: function (winStart, count) {
          db.prepare(
            'INSERT INTO rate_global(id, win_start, count) VALUES (1,?,?) ' +
            'ON CONFLICT(id) DO UPDATE SET win_start=excluded.win_start, count=excluded.count'
          ).run(winStart, count);
        }
      };
      return fn(helpers);
    })();
  } catch (e) {
    console.warn('[rateStore] 事务失败（限流放行）：' + e.message);
    return undefined;
  }
}

function pruneOld(ttlMs) {
  if (!enabled || !db) return;
  try {
    const cutoff = Date.now() - ttlMs;
    db.prepare('DELETE FROM rate_buckets WHERE last_access < ?').run(cutoff);
  } catch (e) { /* 清理失败忽略 */ }
}

function snapshot() {
  if (!enabled || !db) return [];
  try {
    return db.prepare('SELECT * FROM rate_buckets').all().map(function (r) {
      const b = bucketFromRow(r);
      b.key = r.key;
      return b;
    });
  } catch (e) { return []; }
}

function close() {
  if (db) { try { db.close(); } catch (e) {} db = null; }
  enabled = false;
}

module.exports = {
  init: init,
  isEnabled: function () { return enabled; },
  runTx: runTx,
  pruneOld: pruneOld,
  snapshot: snapshot,
  close: close,
  _dbPath: function () { return DB_PATH; }
};
