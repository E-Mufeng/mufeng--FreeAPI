'use strict';
/*
 * proxy/quota.js —— 配额数据层（页面驱动刷新，无后台常驻定时器）
 *
 * 两层余额：
 *   1) 每模型 token 余额（用户核心诉求）：
 *      剩余 = 模型公开免费额度(freeQuota) - 本代理日志累计已用 tokens。
 *      已用来自 db.modelUsage()（api_request_log 聚合），与页面是否打开无关，
 *      但「刷新」动作由前端在页面打开时发起，关页不跑。
 *   2) 厂商账户余额（仅 DeepSeek / 硅基流动，按用户要求）：
 *      调官方余额接口，5min 内存缓存，避免每次轮询都打上游。
 *
 * 优雅降级：日志层/网络不可用 → 返回空或 error 项，不抛异常中断主链路。
 */

const logdb = require('./db');

// 阈值告警默认配置（可被 config.quotaAlert 覆盖）
const DEFAULT_ALERT = {
  warnPct: 20,      // 剩余比例 < 20% → warn
  critPct: 5,       // 剩余比例 < 5%  → crit
  warnTokens: null, // 绝对 token 下限（可选）
  critTokens: null,
  vendorWarnCny: 5, // 厂商余额 < ¥5  → warn
  vendorCritCny: 1  // 厂商余额 ≤ ¥1  → crit
};

function numOr(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function resolveAlert(cfg) {
  const a = (cfg && typeof cfg === 'object') ? cfg : {};
  return {
    warnPct: numOr(a.warnPct, DEFAULT_ALERT.warnPct),
    critPct: numOr(a.critPct, DEFAULT_ALERT.critPct),
    warnTokens: a.warnTokens != null ? Number(a.warnTokens) : DEFAULT_ALERT.warnTokens,
    critTokens: a.critTokens != null ? Number(a.critTokens) : DEFAULT_ALERT.critTokens,
    vendorWarnCny: numOr(a.vendorWarnCny, DEFAULT_ALERT.vendorWarnCny),
    vendorCritCny: numOr(a.vendorCritCny, DEFAULT_ALERT.vendorCritCny)
  };
}

// 归一化 key：取「/」之后最后一段并转小写，用于把目录 id（如 sf/Qwen2.5-7B-Instruct）
// 与日志里记录的上游真实模型名（如 Qwen/Qwen2.5-7B-Instruct）对齐。
function normalizeKey(s) {
  return String(s || '').split('/').pop().toLowerCase();
}

function aggregateModelUsage() {
  if (!logdb.isEnabled || !logdb.isEnabled()) return {};
  try { return logdb.modelUsage(); } catch (e) { return {}; }
}

// 单模型告警等级：remaining<=0 / 比例或绝对额低于 crit/warn 线
function modelAlertLevel(remaining, pct, alert) {
  if (remaining <= 0) return { level: 'crit', reason: '额度已用尽' };
  if (alert.critPct != null && pct < alert.critPct) return { level: 'crit', reason: '剩余 ' + pct + '% 低于告急线 ' + alert.critPct + '%' };
  if (alert.critTokens != null && remaining < alert.critTokens) return { level: 'crit', reason: '剩余 ' + fmtNum0(remaining) + ' tokens 低于告急线 ' + alert.critTokens };
  if (alert.warnPct != null && pct < alert.warnPct) return { level: 'warn', reason: '剩余 ' + pct + '% 低于提醒线 ' + alert.warnPct + '%' };
  if (alert.warnTokens != null && remaining < alert.warnTokens) return { level: 'warn', reason: '剩余 ' + fmtNum0(remaining) + ' tokens 低于提醒线 ' + alert.warnTokens };
  return null;
}
function fmtNum0(n) { return Number(n || 0).toLocaleString(); }

function computeModelQuota(models, usage, alertCfg) {
  const out = {};
  const alert = resolveAlert(alertCfg);
  // 归一化 usage 键（去前缀 + 小写），兼容日志里记录的上游真实模型名（如 Qwen2.5-7B-Instruct / Qwen/Qwen2.5-7B-Instruct）
  const normUsage = {};
  Object.keys(usage || {}).forEach(function (k) { normUsage[normalizeKey(k)] = usage[k]; });
  (models || []).forEach(function (m) {
    const fq = (typeof m.freeQuota === 'number') ? m.freeQuota : null;
    const key = normalizeKey(m.id);
    const u = normUsage[key] || usage[m.id] || null;
    const used = u ? u.total : 0;
    const remaining = fq != null ? Math.max(0, fq - used) : null;
    const hasQuota = fq != null;
    let pct = null, al = null;
    if (hasQuota) {
      pct = Math.round(remaining / fq * 100);
      al = modelAlertLevel(remaining, pct, alert);
    }
    out[m.id] = {
      freeQuota: fq,
      used: used,
      remaining: remaining,
      hasQuota: hasQuota,
      pct: pct,
      alert: al
    };
  });
  return out;
}

// ---------------- 厂商账户余额（仅 DeepSeek / 硅基流动） ----------------
const VB_CACHE = { at: 0, data: [] };
const VB_TTL = 5 * 60 * 1000; // 5min

function vendorKind(v) {
  v = String(v || '').toLowerCase();
  if (v.indexOf('deepseek') >= 0) return 'deepseek';
  if (v.indexOf('硅基') >= 0 || v.indexOf('siliconflow') >= 0) return 'siliconflow';
  return null;
}

async function fetchOneBalance(kind, key) {
  if (kind === 'deepseek') {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
    if (!r.ok) throw new Error('DeepSeek HTTP ' + r.status);
    const j = await r.json();
    const infos = j.balance_infos || [];
    let total = 0;
    infos.forEach(function (b) { total += Number(b.total_balance || 0); });
    return { vendor: 'DeepSeek', kind: kind, balance: total, currency: 'CNY', fetchedAt: Date.now() };
  }
  if (kind === 'siliconflow') {
    const r = await fetch('https://api.siliconflow.cn/v1/user/info/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
    if (!r.ok) throw new Error('SiliconFlow HTTP ' + r.status);
    const j = await r.json();
    const d = j.data || {};
    const bal = Number(d.totalBalance != null ? d.totalBalance : (d.balance != null ? d.balance : 0));
    return { vendor: '硅基流动', kind: kind, balance: bal, currency: 'CNY', fetchedAt: Date.now() };
  }
  throw new Error('unsupported vendor ' + kind);
}

async function fetchVendorBalances(config) {
  const now = Date.now();
  if (VB_CACHE.at && now - VB_CACHE.at < VB_TTL && VB_CACHE.data.length) return VB_CACHE.data;
  const alert = resolveAlert(config && config.quotaAlert);
  const out = [];
  for (const up of (config.upstreams || [])) {
    if (!up.enabled) continue;
    const kind = vendorKind(up.vendor);
    if (!kind) continue;
    const key = up.apiKey;
    if (!key || /^sk-your-/.test(key)) continue; // 跳过占位 key
    try {
      const item = await fetchOneBalance(kind, key);
      item.alert = vendorAlertLevel(item.balance, alert);
      out.push(item);
    }
    catch (e) {
      out.push({
        vendor: up.vendor, kind: kind, error: String(e.message || e), fetchedAt: now,
        alert: { level: 'crit', reason: '读取失败' }
      });
    }
  }
  VB_CACHE.at = now;
  VB_CACHE.data = out;
  return out;
}

function vendorAlertLevel(balance, alert) {
  if (balance == null) return null;
  if (alert.vendorCritCny != null && balance <= alert.vendorCritCny) return { level: 'crit', reason: '余额 ¥' + round2(balance) + ' 偏低' };
  if (alert.vendorWarnCny != null && balance < alert.vendorWarnCny) return { level: 'warn', reason: '余额 ¥' + round2(balance) + ' 偏低' };
  return null;
}

// 聚合模型 + 厂商告警为单一视图（前端渲染告警条/徽标）
function summarizeAlerts(modelQuota, vendorBalances, alertCfg) {
  const alert = resolveAlert(alertCfg);
  const models = [], vendors = [];
  Object.keys(modelQuota || {}).forEach(function (id) {
    const m = modelQuota[id];
    if (m && m.alert) {
      models.push({
        id: id, level: m.alert.level, reason: m.alert.reason,
        pct: m.pct, remaining: m.remaining, freeQuota: m.freeQuota
      });
    }
  });
  (vendorBalances || []).forEach(function (b) {
    if (b && b.alert) {
      vendors.push({ vendor: b.vendor, level: b.alert.level, reason: b.alert.reason, balance: b.balance });
    }
  });
  models.sort(function (a, b) { return (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1); });
  const hasCrit = models.some(function (m) { return m.level === 'crit'; }) || vendors.some(function (v) { return v.level === 'crit'; });
  const hasWarn = models.some(function (m) { return m.level === 'warn'; }) || vendors.some(function (v) { return v.level === 'warn'; });
  return { models: models, vendors: vendors, count: models.length + vendors.length, hasCrit: hasCrit, hasWarn: hasWarn, cfg: alert };
}

module.exports = {
  normalizeKey: normalizeKey,
  aggregateModelUsage: aggregateModelUsage,
  computeModelQuota: computeModelQuota,
  fetchVendorBalances: fetchVendorBalances,
  vendorKind: vendorKind,
  resolveAlert: resolveAlert,
  summarizeAlerts: summarizeAlerts,
  DEFAULT_ALERT: DEFAULT_ALERT,
};
