'use strict';
/*
 * proxy/stateStore.js — 代理可变状态 SQLite 存储层（Phase 2c / 路线2）
 *
 * 职责（D1 混合存储）：
 *   - 仅承载「非密钥的可变业务状态」：catalog(user/enabled/vendorKey)、relay(routes)、freeModels(models)。
 *   - 密钥（master token / upstreams[].apiKey / appTokens[].key / relayToken）仍留 config.json（gitignore），不进本层。
 *   - 代理启动若 SQLite 为空，从 config.json 对应段导入（迁移起点，D4：config.json 优先）。
 *
 * 优雅降级（与 db.js 同构）：
 *   - better-sqlite3 缺失 / 建表失败 / 运行异常 → enabled=false，所有 getter 回退读内存 config.*，
 *     所有 setter 仅更新内存 config.*；代理转发/聊天主链路完全不受影响。
 *   - 不抛异常到调用方。
 */

const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[stateStore] better-sqlite3 不可用，状态层关闭（回退 config.json）：' + e.message);
}

// 支持环境变量覆盖 DB 路径，便于测试隔离（避免固定 free_api.db 被残留进程锁定）
const DB_PATH = process.env.FREE_API_STATE_DB
  ? path.resolve(process.env.FREE_API_STATE_DB)
  : path.join(__dirname, 'free_api.db');
const KEYS = ['catalog', 'relay', 'freeModels'];

let db = null;
let enabled = false;
let configRef = null; // 内存 config 引用（降级回退源 + setters 同步目标）

function init(cfg) {
  configRef = cfg || null;
  if (!Database) { enabled = false; return false; }
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS state_kv (' +
      ' key TEXT PRIMARY KEY,' +
      ' value TEXT,' +
      ' updated_at TEXT' +
      ');'
    );
    // 迁移起点：SQLite 为空则从 config.json 导入（D4：config.json 优先）
    const importStmt = db.prepare('INSERT OR IGNORE INTO state_kv(key, value, updated_at) VALUES (?, ?, ?)');
    const tx = db.transaction(function () {
      KEYS.forEach(function (k) {
        const existing = db.prepare('SELECT key FROM state_kv WHERE key = ?').get(k);
        if (!existing) {
          const v = configRef ? configRef[k] : undefined;
          const safe = (k === 'catalog')
            ? ((v && typeof v === 'object') ? v : { user: [], enabled: {}, vendorKey: {} })
            : (Array.isArray(v) ? v : []);
          importStmt.run(k, JSON.stringify(safe), new Date().toISOString());
        }
      });
    });
    tx();
    enabled = true;
    console.log('[stateStore] SQLite 状态层已启用：' + DB_PATH);
    return true;
  } catch (e) {
    console.warn('[stateStore] 初始化失败，状态层关闭（回退 config.json）：' + e.message);
    db = null;
    enabled = false;
    return false;
  }
}

function rawGet(key) {
  if (!enabled || !db) return undefined;
  try {
    const row = db.prepare('SELECT value FROM state_kv WHERE key = ?').get(key);
    return row ? row.value : undefined;
  } catch (e) {
    return undefined;
  }
}

function rawSet(key, obj) {
  if (!enabled || !db) return false;
  try {
    db.prepare(
      'INSERT INTO state_kv(key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, JSON.stringify(obj), new Date().toISOString());
    return true;
  } catch (e) {
    console.warn('[stateStore] 写入失败（' + key + '）：' + e.message);
    return false;
  }
}

function parse(key, fallback) {
  const raw = rawGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// ---------- 对外读取（降级回退 config.*） ----------
function getCatalog() {
  const fb = (configRef && configRef.catalog && typeof configRef.catalog === 'object')
    ? configRef.catalog : { user: [], enabled: {}, vendorKey: {} };
  return enabled ? parse('catalog', fb) : fb;
}
function getRelay() {
  const fb = (configRef && Array.isArray(configRef.relay)) ? configRef.relay : [];
  return enabled ? parse('relay', fb) : fb;
}
function getFreeModels() {
  const fb = (configRef && Array.isArray(configRef.freeModels)) ? configRef.freeModels : [];
  return enabled ? parse('freeModels', fb) : fb;
}

// ---------- 对外写入（同步内存 config.*，保持 in-memory 一致） ----------
function setCatalog(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const v = { user: Array.isArray(obj.user) ? obj.user : [], enabled: obj.enabled || {}, vendorKey: obj.vendorKey || {} };
  if (configRef) configRef.catalog = v;
  return rawSet('catalog', v);
}
function setRelay(arr) {
  const v = Array.isArray(arr) ? arr : [];
  if (configRef) configRef.relay = v;
  return rawSet('relay', v);
}
function setFreeModels(arr) {
  const v = Array.isArray(arr) ? arr : [];
  if (configRef) configRef.freeModels = v;
  return rawSet('freeModels', v);
}

// ---------- 迁移辅助（P2） ----------
function exportAll() {
  return { catalog: getCatalog(), relay: getRelay(), freeModels: getFreeModels() };
}
function importFrom(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.catalog) setCatalog(obj.catalog);
  if (obj.relay) setRelay(obj.relay);
  if (obj.freeModels) setFreeModels(obj.freeModels);
}
// 重新以 config.json 为权威源覆盖 SQLite（幂等，供迁移/重置使用）
function resetFromConfig(cfg) {
  if (!cfg) return;
  configRef = cfg;
  setCatalog(cfg.catalog);
  setRelay(cfg.relay);
  setFreeModels(cfg.freeModels);
}

module.exports = {
  init: init,
  isEnabled: function () { return enabled; },
  getCatalog: getCatalog,
  getRelay: getRelay,
  getFreeModels: getFreeModels,
  setCatalog: setCatalog,
  setRelay: setRelay,
  setFreeModels: setFreeModels,
  exportAll: exportAll,
  importFrom: importFrom,
  resetFromConfig: resetFromConfig,
  _dbPath: DB_PATH,
};
