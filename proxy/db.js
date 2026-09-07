'use strict';
/*
 * proxy/db.js — SQLite 请求日志结构化存储层
 *
 * 设计要点（Phase 2a / 2a 决策固化）：
 *   - 仅作「结构化查询层」；原有 JSONL 日志（proxy/logs/*.jsonl）保持不变、继续落盘。
 *   - better-sqlite3 为原生模块：加载或建表失败 → 模块降级为 disabled，proxy 其余功能（转发/聊天）完全不受影响。
 *   - 写入走内存队列 + 1s 定时批量 flush（setImmediate 不阻塞 SSE 流式返回）。
 *   - retention：proxy 启动时 trim 至最近 MAX_ROWS 行（默认 5 万，可用 env LOG_MAX_ROWS 覆盖），防无限膨胀。
 *   - CSV 导出对 error_msg 做 Excel 公式注入防护（= + - @ 开头前置单引号）。
 */

const path = require('path');
const fs = require('fs');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[db] better-sqlite3 不可用，日志模块关闭：' + e.message);
}

const DB_PATH = path.join(__dirname, 'logs.db');
const MAX_ROWS = (process.env.LOG_MAX_ROWS && parseInt(process.env.LOG_MAX_ROWS, 10) > 0)
  ? parseInt(process.env.LOG_MAX_ROWS, 10) : 50000;

let db = null;
let enabled = false;

function init() {
  if (!Database) return false;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS api_request_log (' +
      ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' request_time TEXT,' +
      ' upstream TEXT,' +
      ' model TEXT,' +
      ' prompt_tokens INTEGER,' +
      ' completion_tokens INTEGER,' +
      ' total_tokens INTEGER,' +
      ' status_code INTEGER,' +
      ' latency_ms INTEGER,' +
      ' error_msg TEXT,' +
      ' client_ip TEXT' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_request_time ON api_request_log(request_time);' +
      'CREATE INDEX IF NOT EXISTS idx_model ON api_request_log(model);' +
      'CREATE INDEX IF NOT EXISTS idx_upstream ON api_request_log(upstream);'
    );
    // retention：启动 trim 至最近 MAX_ROWS 行
    const count = db.prepare('SELECT COUNT(*) AS c FROM api_request_log').get().c;
    if (count > MAX_ROWS) {
      const minRow = db.prepare(
        'SELECT MIN(id) AS m FROM (SELECT id FROM api_request_log ORDER BY id DESC LIMIT ?)'
      ).get(MAX_ROWS);
      if (minRow && minRow.m != null) {
        db.prepare('DELETE FROM api_request_log WHERE id < ?').run(minRow.m);
        console.log('[db] retention 清理：保留最近 ' + MAX_ROWS + ' 行（已删 id < ' + minRow.m + '）');
      }
    }
    enabled = true;
    console.log('[db] SQLite 日志模块已启用：' + DB_PATH);
    return true;
  } catch (e) {
    console.warn('[db] 初始化失败，日志模块关闭：' + e.message);
    db = null;
    enabled = false;
    return false;
  }
}

// ---------- 写入队列（批量 flush，不阻塞事件循环） ----------
const queue = [];
let flushTimer = null;
const FLUSH_MS = 1000;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref(); // 不单独保活进程
}
function flush() {
  if (!enabled || !db) return;
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    const stmt = db.prepare(
      'INSERT INTO api_request_log' +
      ' (request_time, upstream, model, prompt_tokens, completion_tokens, total_tokens, status_code, latency_ms, error_msg, client_ip)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    const tx = db.transaction(function (rows) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        stmt.run(r.request_time, r.upstream, r.model, r.prompt_tokens,
          r.completion_tokens, r.total_tokens, r.status_code, r.latency_ms, r.error_msg, r.client_ip);
      }
    });
    tx(batch);
  } catch (e) {
    console.warn('[db] 批量写入失败（已丢弃本批 ' + batch.length + ' 条）：' + e.message);
  }
}

function recordRequest(rec) {
  if (!enabled) return;
  queue.push(rec);
  scheduleFlush();
}

// ---------- 查询 ----------
function buildWhere(o) {
  const cond = [];
  const p = [];
  if (o.upstream) { cond.push('upstream = ?'); p.push(o.upstream); }
  if (o.model) { cond.push('model = ?'); p.push(o.model); }
  if (o.status) { cond.push('status_code = ?'); p.push(o.status); }
  if (o.startTime) { cond.push('request_time >= ?'); p.push(o.startTime); }
  if (o.endTime) { cond.push('request_time <= ?'); p.push(o.endTime); }
  return { where: cond.length ? ' WHERE ' + cond.join(' AND ') : '', params: p };
}

function queryList(o) {
  if (!enabled) return { disabled: true, total: 0, page: o.page, pageSize: o.pageSize, data: [] };
  const w = buildWhere(o);
  const total = db.prepare('SELECT COUNT(*) AS c FROM api_request_log' + w.where).get(w.params).c;
  const rows = db.prepare(
    'SELECT * FROM api_request_log' + w.where + ' ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(w.params.concat([o.pageSize, (o.page - 1) * o.pageSize]));
  return { disabled: false, total: total, page: o.page, pageSize: o.pageSize, data: rows };
}

// ---------- 导出 CSV ----------
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Excel 公式注入防护：以 = + - @ 开头前置单引号
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv(o) {
  if (!enabled) return { disabled: true, csv: '' };
  const w = buildWhere(o);
  const rows = db.prepare('SELECT * FROM api_request_log' + w.where + ' ORDER BY id DESC').all(w.params);
  const cols = ['id', 'request_time', 'upstream', 'model', 'prompt_tokens', 'completion_tokens',
    'total_tokens', 'status_code', 'latency_ms', 'error_msg', 'client_ip'];
  let out = cols.join(',') + '\n';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out += cols.map(function (c) { return csvCell(r[c]); }).join(',') + '\n';
  }
  return { disabled: false, csv: out };
}

// ---------- 简易统计 ----------
function stat() {
  if (!enabled) return { disabled: true, stats: [] };
  const rows = db.prepare(
    'SELECT upstream, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS total_tokens' +
    ' FROM api_request_log GROUP BY upstream ORDER BY calls DESC'
  ).all();
  return { disabled: false, stats: rows };
}

  // 每模型 token 用量聚合（配额模块用：剩余 = 模型免费额度 - 已用）
  function modelUsage() {
    if (!enabled) return {};
    try {
      const rows = db.prepare(
        'SELECT model, COALESCE(SUM(prompt_tokens),0) AS prompt, ' +
        'COALESCE(SUM(completion_tokens),0) AS completion, ' +
        'COALESCE(SUM(total_tokens),0) AS total, COUNT(*) AS calls ' +
        'FROM api_request_log GROUP BY model'
      ).all();
      const out = {};
      rows.forEach(function (r) {
        out[r.model] = { prompt: r.prompt, completion: r.completion, total: r.total, calls: r.calls };
      });
      return out;
    } catch (e) { return {}; }
  }

  init();

  // 本地日期字符串 YYYY-MM-DD（request_time 为本地时间 TEXT，可直接字符串比较）
  function localDateStr(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 额度消耗分析：按模型 / 厂商 / 日聚合，含成功率、429、错误数
  function consumptionStats(opts) {
    opts = opts || {};
    if (!enabled) return { disabled: true, totals: null, byModel: [], byVendor: [], byDay: [] };
    const days = (opts.days && opts.days > 0) ? Math.min(opts.days, 90) : 14;
    let since;
    if (opts.startTime) since = opts.startTime;
    else {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (days - 1));
      since = localDateStr(d); // 'YYYY-MM-DD' <= 'YYYY-MM-DDTHH:MM:SS'
    }
    const totals = db.prepare(
      'SELECT COUNT(*) AS requests,' +
      ' COALESCE(SUM(total_tokens),0) AS tokens,' +
      ' COALESCE(SUM(prompt_tokens),0) AS prompt,' +
      ' COALESCE(SUM(completion_tokens),0) AS completion,' +
      ' COALESCE(ROUND(AVG(latency_ms)),0) AS avgLatency,' +
      ' SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS rateLimited,' +
      ' SUM(CASE WHEN status_code >= 400 AND status_code <> 429 THEN 1 ELSE 0 END) AS errors,' +
      ' SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS success' +
      ' FROM api_request_log WHERE request_time >= ?'
    ).get(since);
    const byModel = db.prepare(
      'SELECT model, COUNT(*) AS requests,' +
      ' COALESCE(SUM(total_tokens),0) AS tokens,' +
      ' SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS rateLimited,' +
      ' SUM(CASE WHEN status_code >= 400 AND status_code <> 429 THEN 1 ELSE 0 END) AS errors,' +
      ' SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS success' +
      ' FROM api_request_log WHERE request_time >= ? GROUP BY model ORDER BY tokens DESC LIMIT 50'
    ).all(since);
    const byVendor = db.prepare(
      'SELECT upstream AS vendor, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens' +
      ' FROM api_request_log WHERE request_time >= ? GROUP BY upstream ORDER BY requests DESC'
    ).all(since);
    const byDay = db.prepare(
      'SELECT substr(request_time,1,10) AS day, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens' +
      ' FROM api_request_log WHERE request_time >= ? GROUP BY day ORDER BY day ASC'
    ).all(since);
    return { disabled: false, totals: totals, byModel: byModel, byVendor: byVendor, byDay: byDay, since: since, days: days };
  }

  module.exports = {
    isEnabled: function () { return enabled; },
    recordRequest: recordRequest,
    queryList: queryList,
    exportCsv: exportCsv,
    stat: stat,
    modelUsage: modelUsage,
    consumptionStats: consumptionStats,
  };
