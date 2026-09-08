#!/usr/bin/env node
'use strict';
/*
 * free-API 本地代理（参考 ai-gateway / Governor 路由思想，零依赖、不依赖 Docker）
 *
 * 作用：
 *   把多个上游 API（硅基流动 / 百炼 / 智谱 / 本机 Ollama …）聚合成一个
 *   OpenAI 兼容的统一入口。支持：
 *     - 三种路由模式：economy（最省）/ balanced（加权轮询）/ strict（按优先级 failover）
 *     - 熔断：单上游连续失败 2 次进入 60s 冷却，期间跳过
 *     - failover：候选上游依次尝试，直到成功
 *     - 精确缓存：temperature=0 且非流式时，相同请求直接命中内存缓存
 *     - CORS：允许 file:// 页面直接调用
 *
 * 密钥只存在本机 config.json，绝不进前端。默认只监听 127.0.0.1（本机）。
 *
 * 运行：
 *   node proxy.js                 # 读取同目录 config.json
 *   node proxy.js /path/cfg.json  # 指定配置文件
 * 热加载：修改 config.json 后向进程发 SIGHUP（或文件被监听变化）即重新读取。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');
const logdb = require('./db');   // SQLite 结构化日志层（better-sqlite3 缺失时自动降级为 disabled）
const rateLimiter = require('./rateLimiter');   // 路线2b：代理层速率限制（令牌桶 + 全局窗口兜底）
const stateStore = require('./stateStore');     // 路线2c：可变状态 SQLite 存储层（catalog/relay/freeModels）
const rateStore = require('./rateStore');       // Task D：限流桶 SQLite 持久化（多实例共享，rateLimit.sqlite=true 时启用）
const quotaMod = require('./quota');            // 配额：厂商余额 + 模型用量聚合（页面驱动刷新）
const failover = require('./failover');         // 模型映射 + 429/限流自动 failover
const rl = rateLimiter.createRateLimiter();      // 限流实例（loadConfig 后 .init 注入配置；disabled 时 allow 恒放行）

// 读取包版本（用于 /health 与状态响应；避免硬编码过时版本号导致发布后版本错乱）
let VERSION = '0.0.0';
try { VERSION = require(path.join(__dirname, '..', 'package.json')).version || VERSION; } catch (e) {}

// 顶层异常防御：未捕获的 Promise rejection / 异常不得直接杀死代理进程
process.on('unhandledRejection', function (e) { console.error('[proxy][unhandledRejection]', (e && e.stack) || e); });
process.on('uncaughtException', function (e) { console.error('[proxy][uncaughtException]', (e && e.stack) || e); });

const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'config.json');
const DEFAULT_PORT = 8787;
const COOLDOWN_MS = 60 * 1000;   // 熔断冷却时长
const FAIL_THRESHOLD = 2;        // 连续失败几次后熔断
const CATALOG_DIR = path.join(__dirname, '..', 'catalog');
const CATALOG_JSON = path.join(CATALOG_DIR, 'models-catalog.json');
const SCRAPER = path.join(CATALOG_DIR, 'fetch-catalog.js');
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_RETENTION_DAYS = 30;   // 请求日志保留天数（用户要求：每月清理一次）
const ENABLED_JSON = path.join(__dirname, 'enabled-models.json');  // 已选中(开启)模型文档

let config = loadConfig();
// Task D：多实例限流共享 —— rateLimit.sqlite=true 时启用 SQLite 桶存储
let rateStoreRef = null;
if (config.rateLimit && config.rateLimit.sqlite) {
  if (rateStore.init()) rateStoreRef = rateStore;
  else console.warn('[proxy] rateLimit.sqlite=true 但 rateStore 初始化失败，回退内存限流');
}
rl.init(config.rateLimit, rateStoreRef);   // 路线2b：注入限流配置（校验失败仅关限流，不阻断启动）
stateStore.init(config);     // 路线2c：注入可变状态层（从 config.json 导入 catalog/relay/freeModels；降级时回退 config.*）
const health = {};               // name -> { fails, cooldownUntil, total, ok }
const cache = new Map();         // exact cache: key -> Buffer
const quotaStore = {};           // model -> 剩余额度(由前端推送)
const catalogCache = { models: [], updatedAt: '' };  // 启动时加载目录，供加权路由评分用
const enabledStore = [];         // 已选中(开启)模型文档: {id, available, failedAt, lastOk}
let rrCursor = 0;
const startedAt = Date.now();
const stats = { req: 0, ok: 0, fail: 0 };

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    // Task D：首次启动引导 —— 配置文件缺失时，从 config.example.json 自动生成默认配置，免去手动复制
    const ex = path.join(__dirname, 'config.example.json');
    if (fs.existsSync(ex)) {
      try {
        fs.copyFileSync(ex, CONFIG_PATH);
        console.log('[proxy] 首次启动：已从 config.example.json 生成默认配置 ' + CONFIG_PATH);
        console.log('[proxy] 请编辑该文件填入你的上游 API Key（当前为示例占位，调用会失败）');
        console.log('[proxy] 浏览器打开后按提示设置「访问密码」即可完成首次启动');
        raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      } catch (e2) {
        console.error('[proxy] 无法生成默认配置：' + e2.message);
        process.exit(1);
      }
    } else {
      console.error('[proxy] 找不到配置文件：' + CONFIG_PATH + '，且同目录无 config.example.json');
      process.exit(1);
    }
  }
  let c;
  try {
    c = JSON.parse(raw);
  } catch (e) {
    console.error('[proxy] 配置文件不是合法 JSON：' + e.message);
    process.exit(1);
  }
  c.port = c.port || DEFAULT_PORT;
  c.host = c.host || '127.0.0.1';
  // Task D：容器/测试友好 —— 允许用环境变量 PORT / HOST 覆盖（Docker 暴露、随机端口测试）
  const envPort = parseInt(process.env.PORT, 10);
  if (envPort > 0) c.port = envPort;
  if (process.env.HOST) c.host = process.env.HOST;
  c.mode = c.mode || 'balanced';
  c.classifier = c.classifier || '';   // 意图识别用的免费小模型 id
  c.token = c.token || '';             // 中转站 Key（主控 Key，管理端点 + 调用均可用）
  c.appTokens = (c.appTokens || []).map(function (t) {
    return { id: t.id || crypto.randomBytes(9).toString('base64url'), name: t.name || '未命名',
      key: t.key || crypto.randomBytes(18).toString('base64url'), createdAt: t.createdAt || new Date().toISOString(),
      lastUsed: t.lastUsed || '', enabled: t.enabled !== false };
  });
  c.upstreams = (c.upstreams || c.routes || []).map(function (r, i) {
    return {
      name: r.name || ('route-' + (i + 1)),
      vendor: r.vendor || '',
      baseUrl: (r.baseUrl || '').replace(/\/+$/, ''),
      apiKey: r.apiKey || '',
      models: (r.models && r.models.length) ? r.models : ['*'],
      weight: (r.weight == null) ? 1 : r.weight,
      priority: (r.priority == null) ? 99 : r.priority,
      cost: (r.cost == null) ? 0 : r.cost,
      enabled: r.enabled !== false,
    };
  });
  // 路线1 新增的持久化字段（SPA 经 PUT /api/config 镜像进来）
  c.relay = Array.isArray(c.relay) ? c.relay : [];
  c.catalog = (c.catalog && typeof c.catalog === 'object') ? c.catalog : { user: [], enabled: {}, vendorKey: {} };
  c.freeModels = Array.isArray(c.freeModels) ? c.freeModels : [];
  c.proxyMasterToken = c.proxyMasterToken || '';
  c.relayToken = c.relayToken || '';
  c.accessPassword = c.accessPassword || '';   // 账号体系：访问密码（scrypt hash: salt:hash，空=本地体验模式放行）
  // 路线2b：速率限制配置段（整段兜底默认值；校验失败仅关限流，不阻断代理启动）
  c.rateLimit = (c.rateLimit && typeof c.rateLimit === 'object') ? c.rateLimit : {};
  return c;
}

function reloadConfig() {
  try {
    const fresh = loadConfig();
    config = fresh;
    loadCatalogCache();
    // Task D：热加载重新评估多实例限流（sqlite 标志切换时按需初始化 rateStore）
    if (fresh.rateLimit && fresh.rateLimit.sqlite && !rateStore.isEnabled()) {
      if (rateStore.init()) rateStoreRef = rateStore;
    }
    rl.init(fresh.rateLimit, rateStoreRef);   // 热加载同步限流配置（失败仅关限流）
    // 路线2c：热加载后以 SQLite 状态层为权威，回写内存 config 保持展示一致（不覆盖 SQLite）
    config.relay = stateStore.getRelay();
    config.catalog = stateStore.getCatalog();
    config.freeModels = stateStore.getFreeModels();
    console.log('[proxy] 配置已热加载，当前 ' + config.upstreams.length + ' 条上游');
  } catch (e) {
    console.error('[proxy] 热加载失败：' + e.message);
  }
}

function loadCatalogCache() {
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8'));
    catalogCache.models = cat.models || [];
    catalogCache.updatedAt = cat.updatedAt || '';
  } catch (e) { catalogCache.models = []; catalogCache.updatedAt = ''; }
}

// ---------- 已选中(开启)模型文档：意图识别只读它，不读 config.json 全量 ----------
function loadEnabled() {
  try {
    const arr = JSON.parse(fs.readFileSync(ENABLED_JSON, 'utf8'));
    if (Array.isArray(arr)) {
      arr.forEach(function (e) { if (e && e.id) enabledStore.push({ id: e.id, available: e.available !== false, failedAt: e.failedAt || 0, lastOk: e.lastOk || 0 }); });
    }
  } catch (e) { /* 无文档则冷启动从 config 派生初始可用集 */ }
  if (!enabledStore.length) seedEnabledFromConfig();
}
function seedEnabledFromConfig() {
  // 冷启动无文档时，从已启用上游的模型派生初始可用集（不含 '*' 通配）
  config.upstreams.forEach(function (r) {
    if (r.enabled && r.models[0] !== '*') r.models.forEach(function (m) {
      if (!enabledStore.some(function (e) { return e.id === m; })) enabledStore.push({ id: m, available: true, failedAt: 0, lastOk: 0 });
    });
  });
}
function saveEnabled() {
  try {
    fs.writeFileSync(ENABLED_JSON, JSON.stringify(enabledStore.map(function (e) {
      return { id: e.id, available: e.available, failedAt: e.failedAt, lastOk: e.lastOk };
    }), null, 2));
  } catch (e) { /* 写文档失败不影响主流程 */ }
}
function findEnabled(id) {
  for (let i = 0; i < enabledStore.length; i++) if (enabledStore[i].id === id) return enabledStore[i];
  return null;
}
function isEnabledAvailable(id) {
  const e = findEnabled(id);
  // 根：必须有「启用且能服务该模型」的上游路由；路由被 disabled 后其模型一律不可用
  if (candidateRoutes(id).length === 0) return false;
  if (!e) return true;                                   // 文档外的模型（直接手动调用），有路由即视为可用
  if (e.available) return true;
  if (e.failedAt && Date.now() - e.failedAt > COOLDOWN_MS) return true;  // 冷却结束允许重试
  return false;
}
// 仅在状态翻转时落盘，避免每次成功都写文件
function markModelAvailable(id) {
  const e = findEnabled(id);
  if (e && (!e.available || e.failedAt)) { e.available = true; e.failedAt = 0; e.lastOk = Date.now(); saveEnabled(); }
}
function markModelUnavailable(id) {
  const e = findEnabled(id);
  if (e && e.available) { e.available = false; e.failedAt = Date.now(); saveEnabled(); }
}

// 给每个模型推断「能力档」(capTier) 与「适用难度」(tier)，供加权路由评分
function modelMeta(id) {
  const m = catalogCache.models.find(function (x) { return x.id === id; }) || {};
  const type = m.type || 'quota';
  // 上下文窗口：空或无法解析的视为中小
  let ctx = 0;
  try { ctx = parseInt(String(m.contextWindow || '0').replace(/[^0-9]/g, ''), 10) || 0; } catch (e) {}
  // 能力档：免费小模型=1，限额/限免中=2，大上下文(>=64k)或推理=3
  let cap = 1;
  if (type !== 'free') cap = 2;
  if (ctx >= 64000) cap = 3;
  if ((m.modality || []).indexOf('推理') >= 0) cap = Math.max(cap, 3);
  // 适用难度：cap=1 只适合简单/中等；cap=2 适合中等/困难；cap=3 适合困难
  const tier = cap;
  return { type: type, ctx: ctx, cap: cap, tier: tier };
}

function h(name) {
  if (!health[name]) health[name] = { fails: 0, cooldownUntil: 0, total: 0, ok: 0 };
  return health[name];
}
function isHealthy(name) {
  const x = health[name];
  if (!x) return true;
  if (x.fails >= FAIL_THRESHOLD && Date.now() < x.cooldownUntil) return false;
  return true;
}
function recordSuccess(name) { const x = h(name); x.fails = 0; x.cooldownUntil = 0; x.ok++; x.total++; }
function recordFailure(name) { const x = h(name); x.fails++; x.total++; if (x.fails >= FAIL_THRESHOLD) x.cooldownUntil = Date.now() + COOLDOWN_MS; }

// 裸名：取 '/' 之后的一段（厂商前缀不影响路由归属）
function bareOf(m) { var s = String(m == null ? '' : m); return s.indexOf('/') >= 0 ? s.split('/').pop() : s; }
function sameBare(a, b) { return bareOf(a).toLowerCase() === bareOf(b).toLowerCase(); }
// 目录友好 id -> 上游真实模型名 的别名映射。
// 仅当裸名对不上时才需要。字节豆包：目录用 bytedance/doubao-pro / bytedance/doubao-lite，
// 但火山方舟该账户仅激活了发布模型 doubao-seed-2-0-pro-260215（其余豆包模型 ModelNotOpen）。
// 方舟模型名带日期后缀，且需账户在控制台「开通模型」后才可用；控制台也可绑定 ep-xxxx 接入点。
const MODEL_ALIASES = {
  'bytedance/doubao-pro': 'doubao-seed-2-0-pro-260215',
  'bytedance/doubao-lite': 'doubao-seed-2-0-pro-260215'
};
function aliasOf(m) {
  var a = MODEL_ALIASES[String(m == null ? '' : m).toLowerCase()];
  return a || null;
}
// 路由 r 是否服务某模型（支持完整匹配 / 别名映射 / 裸名匹配，忽略大小写）
function routeServes(r, model) {
  if (!r.models || !r.models.length) return false;
  if (r.models.indexOf('*') >= 0) return true;
  if (r.models.indexOf(model) >= 0) return true;
  var al = aliasOf(model);
  if (al && r.models.indexOf(al) >= 0) return true;
  return r.models.some(function (m) { return sameBare(m, model); });
}
// 候选上游：按 model 匹配 + 启用 + 健康
function candidateRoutes(model) {
  return config.upstreams.filter(function (r) {
    if (!r.enabled) return false;
    return routeServes(r, model);
  });
}

function resolveRoutes(model, mode) {
  let list = candidateRoutes(model).filter(function (r) { return isHealthy(r.name); });
  if (!list.length) list = candidateRoutes(model); // 全不健康时仍尝试（可能只是冷却误判）
  if (mode === 'strict') {
    list.sort(function (a, b) { return a.priority - b.priority; });
  } else if (mode === 'economy') {
    list.sort(function (a, b) { return (a.cost - b.cost) || (a.priority - b.priority); });
  } else {
    list = balancedOrder(list); // balanced：加权轮询
  }
  return list;
}

function balancedOrder(list) {
  const expanded = [];
  list.forEach(function (r) {
    const w = Math.max(1, r.weight | 0);
    for (let i = 0; i < w; i++) expanded.push(r);
  });
  if (!expanded.length) return [];
  rrCursor = (rrCursor + 1) % expanded.length;
  return expanded.slice(rrCursor).concat(expanded.slice(0, rrCursor));
}

function cacheKeyOf(body) {
  if (body && body.temperature === 0 && !body.stream) {
    const norm = { model: body.model, messages: body.messages, tools: body.tools, json: body.response_format };
    return 'c:' + crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
  }
  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-governor-mode, x-proxy-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// 判断请求是否来自本机：管理类端点在本机访问时免主控 Key，
// 这样用户通过前端页面即可重置/管理 token，无需手动编辑 config.json。
function isLocalhost(req) {
  const addr = (req.socket && req.socket.remoteAddress) ||
               (req.connection && req.connection.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

function filterHopHeaders(hdrs) {
  const out = {};
  Object.keys(hdrs).forEach(function (k) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') return;
    out[k] = hdrs[k];
  });
  return out;
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// 路线2b：限流触发响应（D3）——429 + Retry-After + 结构化 JSON 错误体
function send429(res, retryAfter, scope, message) {
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(retryAfter)
  });
  res.end(JSON.stringify({
    error: 'rate_limited',
    retryAfter: retryAfter,
    scope: scope,
    message: message || '请求过于频繁，请稍后重试'
  }));
}

function sendHealth(res) {
  const routes = config.upstreams.map(function (r) {
    const x = health[r.name] || { fails: 0, total: 0, ok: 0, cooldownUntil: 0 };
    return {
      name: r.name, vendor: r.vendor, enabled: r.enabled, healthy: isHealthy(r.name),
      fails: x.fails, total: x.total, ok: x.ok, models: r.models,
    };
  });
  const rlStatus = (typeof rl.status === 'function') ? rl.status() : { disabled: true };
  sendJson(res, 200, {
    ok: true, service: 'free-api-proxy', version: VERSION, mode: config.mode,
    classifier: config.classifier, quotaCount: Object.keys(quotaStore).length,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    hasPassword: !!config.accessPassword,
    firstRun: !config.accessPassword,
    models: countActiveModels(),
    upstreams: config.upstreams.filter(function (r) { return r.enabled; }).length,
    rateLimit: rlStatus,
    rateStore: { enabled: rateStore.isEnabled() },
    store: { enabled: stateStore.isEnabled() },
    logs: { enabled: logdb.isEnabled() },
    stats: stats, routes: routes, cacheSize: cache.size,
  });
}

  // ---------- 路线1：配置镜像 + 状态端点（前缀 /api） ----------
  function countActiveModels() {
    var set = {};
    config.upstreams.forEach(function (r) {
      if (!r.enabled) return;
      (r.models || []).forEach(function (m) { if (m && m !== '*') set[m] = 1; });
    });
    return Object.keys(set).length;
  }
  function sendStatus(res) {
    sendJson(res, 200, {
      online: true, version: VERSION, mode: config.mode,
      models: countActiveModels(),
      upstreams: config.upstreams.filter(function (r) { return r.enabled; }).length,
      relay: (config.relay || []).length,
      ts: Date.now()
    });
  }
  function maskConfig() {
    return {
      proxy: { port: config.port, host: config.host, mode: config.mode, classifier: config.classifier || '',
        token: config.token ? '***' : '', appTokens: config.appTokens.map(function (t) { return { id: t.id, name: t.name, enabled: t.enabled }; }) },
      upstreams: config.upstreams.map(maskRoute),
      relay: config.relay || [],
      catalog: { user: (config.catalog.user || []).length, enabled: config.catalog.enabled || {}, vendorKey: Object.keys(config.catalog.vendorKey || {}).length },
      freeModels: (config.freeModels || []).length,
      tokens: { relayToken: config.relayToken ? '***' : '', proxyMasterToken: config.proxyMasterToken ? '***' : '' }
    };
  }
  function handleConfigGet(res, exportFull) {
    if (exportFull) {
      // 备份导出：返回未掩码全量（本机备份用途）
      return sendJson(res, 200, {
        host: config.host, port: config.port, mode: config.mode, token: config.token || '',
        classifier: config.classifier || '', appTokens: config.appTokens, upstreams: config.upstreams,
        relay: stateStore.getRelay(), catalog: stateStore.getCatalog(), freeModels: stateStore.getFreeModels(),
        tokens: { relayToken: config.relayToken || '', proxyMasterToken: config.proxyMasterToken || '' }
      });
    }
    return sendJson(res, 200, maskConfig());
  }
  function mergeConfigPatch(body) {
    if (!body || typeof body !== 'object') return;
    if (Array.isArray(body.upstreams)) {
      body.upstreams.forEach(function (u) {
        if (!u || !u.name) return;
        var r = config.upstreams.find(function (x) { return x.name === u.name; });
        if (!r) { r = { name: u.name, vendor: '', baseUrl: '', apiKey: '', models: ['*'], weight: 1, priority: 99, cost: 0, enabled: true }; config.upstreams.push(r); }
        if (u.vendor != null) r.vendor = u.vendor;
        if (u.baseUrl != null) r.baseUrl = (u.baseUrl || '').replace(/\/+$/, '');
        if (u.apiKey != null) r.apiKey = u.apiKey;
        if (Array.isArray(u.models)) r.models = u.models;
        if (u.weight != null) r.weight = Number(u.weight) || 1;
        if (u.priority != null) r.priority = Number(u.priority) || 99;
        if (u.cost != null) r.cost = Number(u.cost) || 0;
        if (u.enabled !== undefined) r.enabled = !!u.enabled;
      });
    }
    if (Array.isArray(body.relay)) { config.relay = body.relay; stateStore.setRelay(body.relay); }
    if (body.catalog && typeof body.catalog === 'object') { config.catalog = body.catalog; stateStore.setCatalog(body.catalog); }
    if (Array.isArray(body.freeModels)) { config.freeModels = body.freeModels; stateStore.setFreeModels(body.freeModels); }
    if (body.modelMapping && typeof body.modelMapping === 'object') config.modelMapping = body.modelMapping;
    if (body.tokens && typeof body.tokens === 'object') {
      if (body.tokens.relayToken != null) config.relayToken = body.tokens.relayToken;
      if (body.tokens.proxyMasterToken != null) config.proxyMasterToken = body.tokens.proxyMasterToken;
    }
    // 安全：禁止经此接口改写 config.token / appTokens（防锁死）
  }
  function handleConfigPut(res, body) {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: { message: '请求体非法' } });
    mergeConfigPatch(body);
    var ok = saveConfig();
    return sendJson(res, ok ? 200 : 500, { ok: ok, updated: Object.keys(body), version: 2 });
  }
  function handleConfigImport(res, body) {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: { message: '备份内容为空或非法' } });
    if (Array.isArray(body.upstreams)) config.upstreams = body.upstreams;
    if (Array.isArray(body.relay)) { config.relay = body.relay; stateStore.setRelay(body.relay); }
    if (body.catalog && typeof body.catalog === 'object') { config.catalog = body.catalog; stateStore.setCatalog(body.catalog); }
    if (Array.isArray(body.freeModels)) { config.freeModels = body.freeModels; stateStore.setFreeModels(body.freeModels); }
    if (body.modelMapping && typeof body.modelMapping === 'object') config.modelMapping = body.modelMapping;
    if (body.tokens && typeof body.tokens === 'object') {
      if (body.tokens.relayToken != null) config.relayToken = body.tokens.relayToken;
      if (body.tokens.proxyMasterToken != null) config.proxyMasterToken = body.tokens.proxyMasterToken;
    }
    if (body.token != null) config.token = body.token;          // 备份带主控 token 允许恢复（本机备份）
    if (Array.isArray(body.appTokens)) config.appTokens = body.appTokens;
    if (body.mode) config.mode = body.mode;
    if (body.classifier != null) config.classifier = body.classifier;
    var ok = saveConfig();
    return sendJson(res, ok ? 200 : 500, { ok: ok, imported: ['upstreams', 'relay', 'catalog', 'freeModels', 'tokens', 'proxy'] });
  }

  // ---------- 目录 / 厂商 key / 额度 / 意图识别 管理端点 ----------
  function readCatalog() {
    try { return JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8')); }
    catch (e) { return { models: [], updatedAt: '' }; }
  }
  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 6) return '******';
    return k.slice(0, 3) + '…' + k.slice(-4);
  }
  function maskRoute(r) {
    return { name: r.name, vendor: r.vendor, baseUrl: r.baseUrl, models: r.models,
      weight: r.weight, priority: r.priority, cost: r.cost, enabled: r.enabled,
      keyMask: maskKey(r.apiKey), hasKey: !!r.apiKey };
  }
  function saveConfig() {
    var out = {
      host: config.host, port: config.port, mode: config.mode,
      token: config.token || '', classifier: config.classifier || '',
      appTokens: config.appTokens.map(function (t) {
        return { id: t.id, name: t.name, key: t.key, createdAt: t.createdAt, lastUsed: t.lastUsed, enabled: t.enabled };
      }),
      upstreams: config.upstreams.map(function (r) {
        return { name: r.name, vendor: r.vendor, baseUrl: r.baseUrl, apiKey: r.apiKey,
          models: r.models, weight: r.weight, priority: r.priority, cost: r.cost, enabled: r.enabled };
      }),
      relay: config.relay || [],
      catalog: config.catalog || { user: [], enabled: {}, vendorKey: {} },
      freeModels: config.freeModels || [],
      modelMapping: config.modelMapping || {},
      proxyMasterToken: config.proxyMasterToken || '',
      relayToken: config.relayToken || '',
      accessPassword: config.accessPassword || ''
    };
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2)); return true; }
    catch (e) { console.error('[proxy] 写配置失败：' + e.message); return false; }
  }
  function readBody(req) {
    return new Promise(function (resolve, reject) {
      var b = ''; req.on('data', function (c) { b += c; });
      req.on('end', function () { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
      req.on('error', function (e) { reject(e); });
    });
  }
  function fetchUpstreamBuffer(r, body) {
    return new Promise(function (resolve, reject) {
      var u; try { u = new URL(r.baseUrl + '/chat/completions'); } catch (e) { return reject(new Error('上游地址非法：' + r.baseUrl)); }
      var data = Buffer.from(JSON.stringify(body));
      var proto = u.protocol === 'https:' ? https : http;
      var opt = { method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + r.apiKey, 'Content-Length': data.length } };
      var up = proto.request(opt, function (upRes) {
        var chunks = []; upRes.on('data', function (c) { chunks.push(c); });
        upRes.on('end', function () { resolve(Buffer.concat(chunks)); }); upRes.on('error', function (e) { reject(e); });
      });
      up.on('error', function (e) { reject(e); }); up.write(data); up.end();
    });
  }
  function handleCatalogRefresh(res) {
    if (!fs.existsSync(SCRAPER)) return sendJson(res, 500, { error: { message: '找不到抓取脚本：' + SCRAPER } });
    var prev = readCatalog().models || [];
    var child = spawn(process.execPath, [SCRAPER], { cwd: CATALOG_DIR });
    var errOut = '';
    child.stderr.on('data', function (d) { errOut += d.toString(); });
    child.on('error', function (e) { return sendJson(res, 500, { error: { message: '启动抓取失败：' + e.message } }); });
    child.on('close', function (code) {
      if (code !== 0) return sendJson(res, 502, { error: { message: '抓取脚本退出码 ' + code, detail: errOut.slice(0, 600) } });
      var cat = readCatalog(); var models = cat.models || [];
      // 静默保守合并：保留用户对各模型的 enabled 覆盖；只更新元数据；不删已启用项、绝不碰 key
      var prevEnabled = {};
      try {
        var pf = stateStore.getFreeModels();
        (pf || []).forEach(function (m) { if (m && m.id) prevEnabled[m.id] = !!m.enabled; });
      } catch (e) { /* ignore */ }
      models.forEach(function (m) {
        if (prevEnabled[m.id] === true) m.enabled = true;
        else if (prevEnabled[m.id] === false) m.enabled = false;
      });
      // 持久化到 stateStore（覆盖 freeModels，但保留 enabled 覆盖；key 在 config.json，不在此）
      try { stateStore.setFreeModels(models); } catch (e) { /* ignore */ }
      // 同步内存目录缓存，使「每模型 token 余额」freeQuota 分母立即生效（否则需重启代理）
      try { catalogCache.models = models; catalogCache.updatedAt = cat.updatedAt || ''; } catch (e) { /* ignore */ }
      // diff 计数（新增 / 转过期 / 其它变更）
      var prevIds = {}; prev.forEach(function (m) { prevIds[m.id] = m; });
      var added = 0, expired = 0, changed = 0;
      models.forEach(function (m) {
        if (!prevIds[m.id]) { added++; return; }
        var p = prevIds[m.id];
        if (p.type !== m.type) { if (m.type === 'expired') expired++; else changed++; }
        else if ((p.quota || '') !== (m.quota || '')) changed++;
      });
      sendJson(res, 200, {
        ok: true, updatedAt: cat.updatedAt, count: models.length,
        added: added, expired: expired, changed: changed, models: models
      });
    });
  }
  function handleRouteUpsert(res, body) {
    // 删除：按 name 移除路由（真正从 config.json 移除，而非仅停用）
    if (body && body.action === 'delete') {
      var dn = (body.name || '').trim();
      if (!dn) return sendJson(res, 400, { error: { message: '删除需提供 name' } });
      var di = config.upstreams.findIndex(function (x) { return x.name === dn; });
      if (di < 0) return sendJson(res, 404, { ok: false, error: { message: '未找到路由 ' + dn } });
      config.upstreams.splice(di, 1);
      saveConfig();
      return sendJson(res, 200, { ok: true, deleted: dn });
    }
    var vendor = (body.vendor || '').trim();
    var name = (body.name || '').trim();
    if (!vendor && !name) return sendJson(res, 400, { error: { message: '缺少 vendor 或 name' } });
    // 按 name 优先、vendor 次之定位已有路由（前端用 name 作稳定主键）
    var r = config.upstreams.find(function (x) { return name && x.name === name; });
    if (!r) r = config.upstreams.find(function (x) { return vendor && x.vendor === vendor; });
    if (!r) {
      r = { name: name || vendor, vendor: vendor || name, baseUrl: '', apiKey: '', models: ['*'], weight: 1, priority: 99, cost: 0, enabled: true };
      config.upstreams.push(r);
    }
    if (name) r.name = name;
    if (vendor) r.vendor = vendor;
    if (body.apiKey != null) r.apiKey = body.apiKey;
    if (body.baseUrl != null) r.baseUrl = (body.baseUrl || '').replace(/\/+$/, '');
    if (body.models && body.models.length) r.models = body.models;
    if (body.weight != null) r.weight = Number(body.weight) || 1;
    if (body.priority != null) r.priority = Number(body.priority) || 99;
    if (body.cost != null) r.cost = Number(body.cost) || 0;
    if (body.enabled !== undefined) r.enabled = !!body.enabled;
    saveConfig();
    sendJson(res, 200, { ok: true, route: maskRoute(r) });
  }
  function handleQuota(req, res, body) {
    if (req.method === 'GET') {
      return Promise.resolve().then(async function () {
        const vendorBalances = await quotaMod.fetchVendorBalances(config);
        const usage = quotaMod.aggregateModelUsage();
        const modelQuota = quotaMod.computeModelQuota(catalogCache.models, usage, config.quotaAlert);
        const thresholdAlerts = quotaMod.summarizeAlerts(modelQuota, vendorBalances, config.quotaAlert);
        return sendJson(res, 200, {
          ok: true, quota: quotaStore,
          vendorBalances: vendorBalances, modelUsage: usage, modelQuota: modelQuota,
          thresholdAlerts: thresholdAlerts,
          fetchedAt: Date.now()
        });
      }).catch(function (e) {
        return sendJson(res, 200, {
          ok: true, quota: quotaStore,
          vendorBalances: [], modelUsage: {}, modelQuota: {}, thresholdAlerts: { models: [], vendors: [], count: 0 },
          error: String((e && e.message) || e)
        });
      });
    }
    if (body && body.quota && typeof body.quota === 'object') {
      Object.keys(body.quota).forEach(function (k) { quotaStore[k] = body.quota[k]; });
    }
    sendJson(res, 200, { ok: true, count: Object.keys(quotaStore).length });
  }
  function handleTokenGen(res) {
    var t = crypto.randomBytes(18).toString('base64url');
    config.token = t; saveConfig();
    sendJson(res, 200, { ok: true, token: t });
  }
  // 主控 token 管理：GET 返回是否已设置；POST 设置/重置 token。
  // 本机来源在 isLocalhost 处已放行；非本机来源必须提供旧 token 才能修改。
  function handleAdminToken(res, body) {
    if (!body) {
      return sendJson(res, 200, { ok: true, hasToken: !!config.token });
    }
    var newToken = (body.token || '').trim();
    if (!newToken) return sendJson(res, 400, { error: { message: 'token 不能为空' } });
    config.token = newToken;
    var ok = saveConfig();
    if (!ok) return sendJson(res, 500, { error: { message: '保存 config.json 失败' } });
    sendJson(res, 200, { ok: true, hasToken: true });
  }
  // 多应用 Key 管理（每个外部 AI 应用一个命名 Key，可单独停用/撤销）
  function maskAppToken(t) {
    return { id: t.id, name: t.name, keyMask: maskKey(t.key), createdAt: t.createdAt, lastUsed: t.lastUsed, enabled: t.enabled };
  }
  function handleTokens(res, body) {
    var action = body.action || 'list';
    if (action === 'create') {
      var name = (body.name || '').trim() || ('应用-' + (config.appTokens.length + 1));
      var t = { id: crypto.randomBytes(9).toString('base64url'), name: name,
        key: crypto.randomBytes(18).toString('base64url'), createdAt: new Date().toISOString(), lastUsed: '', enabled: true };
      config.appTokens.push(t); saveConfig();
      return sendJson(res, 200, { ok: true, token: maskAppToken(t), rawKey: t.key });
    }
    if (action === 'delete') {
      config.appTokens = config.appTokens.filter(function (t) { return t.id !== body.id; }); saveConfig();
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'rename') {
      var rt = config.appTokens.find(function (t) { return t.id === body.id; });
      if (!rt) return sendJson(res, 404, { error: { message: '找不到该 Key' } });
      rt.name = (body.name || '').trim() || rt.name; saveConfig();
      return sendJson(res, 200, { ok: true, token: maskAppToken(rt) });
    }
    if (action === 'toggle') {
      var tg = config.appTokens.find(function (t) { return t.id === body.id; });
      if (!tg) return sendJson(res, 404, { error: { message: '找不到该 Key' } });
      tg.enabled = !tg.enabled; saveConfig();
      return sendJson(res, 200, { ok: true, token: maskAppToken(tg) });
    }
    return sendJson(res, 200, { ok: true, tokens: config.appTokens.map(maskAppToken) });
  }
  function handleClassifier(res, body) {
    if (body && body.model != null) {
      config.classifier = (body.model || '').trim(); saveConfig();
      return sendJson(res, 200, { ok: true, classifier: config.classifier });
    }
    return sendJson(res, 200, { ok: true, classifier: config.classifier });
  }
  // 已选中模型文档：前端每次开关模型就同步（意图识别只读它，不读 config 全量）
  function handleEnabledSet(res, body) {
    var models = (body && Array.isArray(body.models)) ? body.models : [];
    models = models.filter(function (x) { return typeof x === 'string' && x; });
    var prev = {}; enabledStore.forEach(function (e) { prev[e.id] = e; });
    enabledStore.length = 0;
    models.forEach(function (id) {
      var ex = prev[id];
      enabledStore.push(ex ? { id: id, available: ex.available, failedAt: ex.failedAt, lastOk: ex.lastOk }
                            : { id: id, available: true, failedAt: 0, lastOk: 0 });
    });
    saveEnabled();
    sendJson(res, 200, { ok: true, count: enabledStore.length });
  }
  function handleEnabledGet(res) {
    sendJson(res, 200, { ok: true, models: enabledStore, count: enabledStore.length });
  }
  function handleLogsClear(res) {
    try {
      if (fs.existsSync(LOGS_DIR)) {
        fs.readdirSync(LOGS_DIR).forEach(function (f) {
          if (/^proxy-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) { try { fs.unlinkSync(path.join(LOGS_DIR, f)); } catch (e) {} }
        });
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 500, { error: { message: e.message } }); }
  }
  function lastUserText(body) {
    var msgs = (body && body.messages) || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i]; if (m.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    }
    return '';
  }
  function enabledModelIds() {
    var ids = [];
    config.upstreams.forEach(function (r) { if (r.enabled && r.models[0] !== '*') r.models.forEach(function (m) { ids.push(m); }); });
    return ids;
  }
  async function classifyAndPick(body, candidates) {
    if (!candidates.length) return null;
    var clf = config.classifier;
    // 1) 分类模型给出任务难度(1简单/2中等/3困难) + 建议模型
    var difficulty = 1;        // 默认按简单处理，避免误用限额模型
    var suggested = null;
    if (clf) {
      var cat = readCatalog(); var typeMap = {}; (cat.models || []).forEach(function (m) { typeMap[m.id] = m.type; });
      var list = candidates.map(function (id) { return { id: id, tier: typeMap[id] || '?', remaining: quotaStore[id] != null ? quotaStore[id] : '未知' }; });
      var sys = '你是模型路由分类器。只输出 JSON {"difficulty":1|2|3,"model":"<id>","reason":"..."}。'
        + '难度: 1=简单(闲聊/短文本/翻译/简单代码), 2=中等(总结/中等代码/多轮), 3=困难(长文档分析/复杂推理/大上下文)。'
        + '规则: 优先把免费模型分给简单与中等任务，把限额高质量模型留给困难任务，避免浪费额度。';
      var usr = '候选模型:\n' + list.map(function (x) { return '- ' + x.id + ' (类型:' + x.tier + ', 剩余额度:' + x.remaining + ')'; }).join('\n')
        + '\n\n用户问题:\n' + lastUserText(body);
      var clfBody = { model: clf, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0, stream: false };
      var routes = resolveRoutes(clf, 'balanced');
      if (routes.length) {
        try {
          var buf = await fetchUpstreamBuffer(routes[0], clfBody);
          var j = JSON.parse(buf.toString('utf8'));
          if (j && j.difficulty) difficulty = Math.min(3, Math.max(1, Number(j.difficulty) || 1));
          if (j && j.model && candidates.indexOf(j.model) >= 0) suggested = j.model;
        } catch (e) { /* 分类失败则用评分兜底 */ }
      }
    }
    // 2) 综合评分：难度匹配 + 能力 + 额度保护 + 成本
    function score(id) {
      var meta = modelMeta(id);
      var rem = quotaStore[id];
      var hasRem = (typeof rem === 'number');
      var diffMatch = 3 - Math.abs(meta.tier - difficulty);     // 1..3，越接近越好
      var cap = meta.tier;                                       // 能力档
      var freeBonus = (meta.type === 'free' && difficulty <= 2) ? 2 : 0;
      // 额度保护：简单/中等任务使用限额模型重罚，防止不必要的额度损耗
      var quotaPenalty = (meta.type !== 'free' && difficulty <= 2) ? (difficulty === 1 ? 6 : 3) : 0;
      // 限额模型之间的额度充足分（剩余越多越优先，作为平手项）
      var quotaBonus = (meta.type !== 'free' && hasRem) ? Math.min(3, (rem || 0) / 10) : 0;
      return diffMatch * 2 + cap * 0.5 + freeBonus + quotaBonus - quotaPenalty;
    }
    var ranked = candidates.map(function (id) { return { id: id, s: score(id) }; }).sort(function (a, b) { return b.s - a.s; });
    if (!ranked.length) return null;
    var chosen = ranked[0].id;
    // 分类建议作为同档偏好：差距不大时尊重建议模型
    if (suggested) {
      var sug = ranked.find(function (r) { return r.id === suggested; });
      if (sug && (ranked[0].s - sug.s) <= 1.5) chosen = suggested;
    }
    return { chosen: chosen, ranked: ranked.map(function (r) { return r.id; }) };
  }
  async function handleAuto(req, res, body) {
    // 候选基础集：请求体带的 models > 已选中文档 > config 派生
    var base = (body.models && body.models.length) ? body.models.slice()
      : (enabledStore.length ? enabledStore.map(function (e) { return e.id; }) : enabledModelIds());
    if (!base.length) return sendJson(res, 400, { error: { message: '没有可用候选模型（请先在目录启用模型并同步到代理）' } });
    // 过滤掉临时不可用(某家挂了)的模型；全部不可用时仍尝试（容错：不整体报错）
    var candidates = base.filter(function (id) { return isEnabledAvailable(id); });
    if (!candidates.length) candidates = base;
    var pick = await classifyAndPick(body, candidates);
    if (!pick) return sendJson(res, 502, { error: { message: '分类模型未能选出模型' } });
    // 按评分排序逐个尝试；某模型所有上游失败则回退到下一个候选（非流式可安全回退）
    var order = [pick.chosen].concat(pick.ranked.filter(function (id) { return id !== pick.chosen; }));
    var lastErr = null;
    for (var i = 0; i < order.length; i++) {
      try {
        await handleChat(req, res, Object.assign({}, body, { model: order[i] }), 'auto');
        return; // 任一候选成功即写出响应并结束
      } catch (e) {
        lastErr = e;
        if (res.headersSent) return; // 流式已开始发头，无法回退
      }
    }
    if (!res.headersSent) sendJson(res, 502, { error: { message: '所有候选模型均失败', detail: String((lastErr && lastErr.message) || lastErr) } });
  }

function recordQuotaFromHeaders(model, headers) {
  if (!model) return;
  const tokens = headers['x-ratelimit-remaining-tokens'];
  const requests = headers['x-ratelimit-remaining-requests'];
  if (tokens == null && requests == null) return;
  quotaStore[model] = {
    tokens: tokens != null ? Number(tokens) : null,
    requests: requests != null ? Number(requests) : null,
    updatedAt: Date.now()
  };
}

// 转发到单一上游
function forwardTo(r, body, req, res, ck, isStreaming, extraHeaders) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(r.baseUrl + '/chat/completions'); }
    catch (e) { return reject(new Error('上游地址非法：' + r.baseUrl)); }
    // 模型名归一化：请求用 catalog 自定义前缀（如 sf/DeepSeek-V3 / bytedance/doubao-pro），
    // 路由内存的是平台真实名（如 deepseek-ai/DeepSeek-V3 / doubao-pro-32k）。
    // 优先级：① 别名映射（目录友好 id -> 上游真实名）② 裸名（忽略大小写）映射。
    let sendBody = body;
    if (r.models[0] !== '*') {
      let target = body.model;
      const al = aliasOf(body.model);
      if (al && r.models.indexOf(al) >= 0) {
        target = al;
      } else if (r.models.indexOf(body.model) < 0) {
        const hit = r.models.filter(function (m) { return sameBare(m, body.model); })[0];
        if (hit) target = hit;
      }
      if (target !== body.model) sendBody = Object.assign({}, body, { model: target });
    }
    const data = Buffer.from(JSON.stringify(sendBody));
    const proto = u.protocol === 'https:' ? https : http;
    const opt = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + r.apiKey,
        'Content-Length': data.length,
      },
    };
    if (config.passthroughAuth && req.headers['authorization']) opt.headers['Authorization'] = req.headers['authorization'];

    const up = proto.request(opt, function (upRes) {
      // 从响应头读取剩余额度（rate limit），作为「剩余额度」自动同步给前端
      recordQuotaFromHeaders(body.model, upRes.headers);
      // 非 2xx（如 401/403/500）视为上游失败，触发 failover / 熔断
      if (upRes.statusCode >= 400) {
        const errChunks = [];
        upRes.on('data', function (c) { errChunks.push(c); });
        upRes.on('end', function () {
          const detail = Buffer.concat(errChunks).toString('utf8').slice(0, 400);
          const err = new Error('上游返回 ' + upRes.statusCode + (detail ? '：' + detail : ''));
          err.statusCode = upRes.statusCode;
          err.body = detail;
          reject(err);
        });
        upRes.on('error', function (e) { reject(e); });
        return;
      }
      if (ck && !isStreaming) {
        // 非流式 + temperature=0：收集后写缓存并回传
        const chunks = [];
        upRes.on('data', function (c) { chunks.push(c); });
        upRes.on('end', function () {
          const buf = Buffer.concat(chunks);
          cache.set(ck, buf);
          res.writeHead(upRes.statusCode, Object.assign({}, filterHopHeaders(upRes.headers), extraHeaders || {}));
          res.end(buf);
          let usage = null;
          try { const j = JSON.parse(buf.toString('utf8')); if (j && j.usage) usage = j.usage; } catch (e) {}
          resolve({ usage: usage });
        });
        upRes.on('error', function (e) { reject(e); });
        return;
      }
      // 流式 / 普通：透传并采集 final usage（不阻塞流式返回）
      res.writeHead(upRes.statusCode, Object.assign({}, filterHopHeaders(upRes.headers), extraHeaders || {}));
      const acc = [];
      upRes.on('data', function (c) { res.write(c); acc.push(c); });
      upRes.on('end', function () {
        try { res.end(); } catch (e) {}
        let usage = null;
        if (isStreaming) {
          usage = parseSseUsage(acc);
        } else {
          try { const j = JSON.parse(Buffer.concat(acc).toString('utf8')); if (j && j.usage) usage = j.usage; } catch (x) {}
        }
        resolve({ usage: usage });
      });
      upRes.on('error', function (e) { try { res.end(); } catch (x) {} reject(e); });
    });
    up.on('error', function (e) { reject(e); });
    up.write(data);
    up.end();
  });
}

async function handleChat(req, res, body, tag) {
  const mode = (req.headers['x-governor-mode'] || config.mode || 'balanced').toString().toLowerCase();
  const originalModel = body && body.model;
  if (!originalModel) return sendJson(res, 400, { error: { message: '缺少 model 字段' } });
  const t0 = Date.now();
  const auto = (tag === 'auto');

  const ck = cacheKeyOf(body);
  if (ck && cache.has(ck)) {
    const hit = cache.get(ck);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': hit.length });
    res.end(hit);
    stats.ok++; stats.req++;
    logRequest({ model: originalModel, upstream: 'cache', status: 200, latency: Date.now() - t0, auto: auto, usage: null, clientIp: clientIpOf(req) });
    return;
  }

  const ip = clientIpOf(req);
  // 构建 failover 链：原模型 + 映射/能力相近备用模型（仅 429/quota 类错误触发）
  const chain = failover.fallbackChain(originalModel, {
    catalogModels: catalogCache.models,
    enabledIds: enabledStore.map(function (e) { return e.id; }).filter(Boolean),
    metaFn: modelMeta,
    userMapping: config.modelMapping || {},
    servableIds: failover.servableModelIds(config)
  });
  let lastErr = null;
  let lastIsRetryable = false;
  for (let ci = 0; ci < chain.length; ci++) {
    const model = chain[ci];
    const tryBody = (ci === 0) ? body : Object.assign({}, body, { model: model });
    const result = await tryModelChat(req, res, tryBody, tag, t0, ck, ip, mode, auto, model, ci);
    if (result.ok) return;
    lastErr = result.error;
    lastIsRetryable = result.isRetryable;
    // 第一个模型非可重试错误时不 failover，避免用 401/403 污染其他模型；后续模型同样
    if (!result.isRetryable) break;
  }
  // 全部失败
  stats.fail++; stats.req++;
  const status = lastIsRetryable ? 429 : (lastErr && lastErr.clientError ? 400 : 502);
  const errOut = String((lastErr && lastErr.message) || lastErr || '所有上游均失败');
  logRequest({ model: originalModel, upstream: '-', status: status, latency: Date.now() - t0, auto: auto, error: errOut, usage: null, clientIp: clientIpOf(req) });
  if (!res.headersSent) {
    if (lastIsRetryable) {
      // 本机限流保持原有结构化错误体（测试/客户端兼容）
      if (lastErr && lastErr.isRateLimit) {
        return send429(res, lastErr.retryAfter, lastErr.scope, String(lastErr.message).replace(/^rate_limited：/, ''));
      }
      return sendJson(res, 429, { error: { message: errOut, code: 'rate_limit' } });
    }
    if (auto) throw new Error(errOut);
    return sendJson(res, status, { error: { message: errOut } });
  }
  // 流式已开始发头：无法回退，只能补错误帧
  try { res.end('\n[data: {"error":"all upstreams failed"}]\n\n'); } catch (e) {}
}

// 尝试单一模型：按路由顺序转发；返回 { ok, isRetryable, error }
async function tryModelChat(req, res, body, tag, t0, ck, ip, mode, auto, model, chainIndex) {
  const routes = resolveRoutes(model, mode);
  if (!routes.length) {
    const e = new Error('没有可服务模型 ' + model + ' 的上游');
    e.clientError = true;
    return { ok: false, isRetryable: false, error: e };
  }
  // —— 路线2b：限流前置检查（本机限流超限视为可 failover）——
  const rlDecision = rl.allow({ upstream: routes[0].name, clientIp: ip });
  if (!rlDecision.allowed) {
    logRequest({ model: model, upstream: rlDecision.scope === 'global' ? 'global' : routes[0].name, status: 429, latency: 0, error: rlDecision.reason, clientIp: ip });
    const rlErr = new Error('rate_limited：' + rlDecision.reason);
    rlErr.isRateLimit = true;
    rlErr.retryAfter = rlDecision.retryAfter;
    rlErr.scope = rlDecision.scope;
    return { ok: false, isRetryable: true, error: rlErr };
  }

  const isStreaming = !!body.stream;
  let lastErr = null;
  let lastRetryableErr = null;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    try {
      const extraHeaders = chainIndex > 0 ? { 'X-FreeAPI-Failover-Model': model } : null;
      const fr = await forwardTo(r, body, req, res, ck, isStreaming, extraHeaders);
      const usage = (fr && fr.usage) || null;
      const totalTokens = (usage && typeof usage.total_tokens === 'number' && isFinite(usage.total_tokens)) ? usage.total_tokens : 0;
      rl.settle({ upstream: r.name, clientIp: ip, usedTokens: totalTokens });
      recordSuccess(r.name);
      markModelAvailable(model);
      stats.ok++; stats.req++;
      logRequest({ model: model, upstream: r.name, status: 200, latency: Date.now() - t0, auto: auto, usage: usage, clientIp: ip });
      return { ok: true };
    } catch (e) {
      recordFailure(r.name);
      lastErr = e;
      const detail = (e && e.body) || (e && e.message) || '';
      if (failover.isRetryableError(e.statusCode, detail)) lastRetryableErr = e;
      // 流式已开始发头：无法继续 failover
      if (res.headersSent) return { ok: false, isRetryable: false, error: e };
    }
  }
  markModelUnavailable(model);
  const isRetryable = !!lastRetryableErr;
  return { ok: false, isRetryable: isRetryable, error: (lastRetryableErr || lastErr) };
}

function handleModels(res) {
  // 对齐 New API /v1/models：返回 config 路由中所有可用模型（外部应用 LobsterAI/CherryStudio 等需要完整列表）
  // 同时叠加「已选中文档」的可用状态；文档外的模型只要存在路由即视为可用。
  const ids = new Set();
  const vendorById = {};
  config.upstreams.forEach(function (r) {
    if (!r.enabled) return;
    (r.models || []).forEach(function (m) {
      if (m === '*') return;
      ids.add(m);
      if (!vendorById[m]) vendorById[m] = r.vendor || r.name || 'free-api-proxy';
    });
  });
  const baseIds = Array.from(ids);
  // 已选中文档作为补充（有些模型只在前端目录中存在）
  enabledStore.forEach(function (e) { if (e.id && !ids.has(e.id)) { ids.add(e.id); baseIds.push(e.id); } });
  const created = Math.floor(startedAt / 1000);
  const data = baseIds.map(function (id) {
    const meta = catalogCache.models.find(function (m) { return m.id === id; }) || {};
    const available = isEnabledAvailable(id);
    return {
      id: id,
      object: 'model',
      created: created,
      owned_by: meta.vendor || vendorById[id] || 'free-api-proxy',
      supported_endpoint_types: ['openai'],
      available: available
    };
  });
  sendJson(res, 200, { object: 'list', data: data, source: 'config' });
}

// ---------- 请求日志落盘 ----------
function logFileFor(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, 'proxy-' + y + '-' + m + '-' + d + '.jsonl');
}
// ---------- 日志辅助（供 SQLite 结构化层使用） ----------
function clientIpOf(req) {
  var xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  var ip = req.socket && req.socket.remoteAddress;
  return ip ? String(ip).replace(/^::ffff:/, '') : '';
}
function fmtLocalIso(ms) {
  var d = new Date(ms);
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function parseSseUsage(chunks) {
  try {
    var text = Buffer.concat(chunks).toString('utf8');
    var lines = text.split('\n');
    var usage = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (ln.indexOf('data:') !== 0) continue;
      var json = ln.slice(5).trim();
      if (json === '[DONE]') continue;
      try { var obj = JSON.parse(json); if (obj && obj.usage) usage = obj.usage; } catch (e) {}
    }
    return usage;
  } catch (e) { return null; }
}
function logRequest(entry) {
  // 保留既有 JSONL 落盘（结构化查询层之外的可读备份）
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const line = JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n';
    fs.appendFileSync(logFileFor(new Date()), line);
  } catch (e) { /* 日志失败不应影响主流程 */ }
  // SQLite 结构化层（队列异步写入，失败不打断正常接口）
  if (logdb.isEnabled()) {
    logdb.recordRequest({
      request_time: fmtLocalIso(entry.ts || Date.now()),
      upstream: entry.upstream || '-',
      model: entry.model || '',
      prompt_tokens: entry.usage ? numOrNull(entry.usage.prompt_tokens) : null,
      completion_tokens: entry.usage ? numOrNull(entry.usage.completion_tokens) : null,
      total_tokens: entry.usage ? numOrNull(entry.usage.total_tokens) : null,
      status_code: entry.status || 0,
      latency_ms: entry.latency || 0,
      error_msg: entry.error || null,
      client_ip: entry.clientIp || ''
    });
  }
}
function pruneLogs() {
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    fs.readdirSync(LOGS_DIR).forEach(function (f) {
      const mm = f.match(/^proxy-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!mm) return;
      const t = new Date(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3])).getTime();
      if (t < cutoff) { try { fs.unlinkSync(path.join(LOGS_DIR, f)); } catch (e) {} }
    });
    console.log('[proxy] 日志清理完成（保留 ' + LOG_RETENTION_DAYS + ' 天）');
  } catch (e) { console.error('[proxy] 日志清理失败：' + e.message); }
}
function readLogs(limit) {
  limit = limit || 50;
  try {
    if (!fs.existsSync(LOGS_DIR)) return [];
    const files = fs.readdirSync(LOGS_DIR)
      .filter(function (f) { return /^proxy-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f); })
      .sort().reverse().slice(0, 3); // 最多读最近 3 天
    const lines = [];
    files.forEach(function (f) {
      const content = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8');
      content.split('\n').forEach(function (ln) { if (ln.trim()) { try { lines.push(JSON.parse(ln)); } catch (e) {} } });
    });
    return lines.slice(-limit).reverse();
  } catch (e) { return []; }
}

// ---------- 静态资源托管（SPA 兜底；API 优先已由上方各路由 return） ----------
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PROJECT_ROOT = path.join(__dirname, '..');
const STATIC_DEV = process.env.FREEAPI_DEV === '1';
// 默认提供构建产物 dist/；开发模式（FREEAPI_DEV=1）或 dist 尚未构建时回退读项目源码根
const STATIC_DIR = (STATIC_DEV || !fs.existsSync(DIST_DIR)) ? PROJECT_ROOT : DIST_DIR;
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};
// 静态托管不暴露密钥/日志文件（即便开发模式回退到项目根）
const STATIC_BLOCK = { 'config.json': 1, 'enabled-models.json': 1 };
function isApiPath(p) {
  return p === '/health' || p.indexOf('/v1/') === 0 || p.indexOf('/api/') === 0;
}
function serveStatic(req, res, p) {
  var rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (STATIC_BLOCK[path.basename(rel)] || /\.log$/.test(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('403 Forbidden'); return;
  }
  var hasExt = path.extname(rel) !== '';
  var filePath = path.normalize(path.join(STATIC_DIR, rel));
  if (filePath.indexOf(path.resolve(STATIC_DIR)) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('403 Forbidden'); return;
  }
  fs.stat(filePath, function (err, st) {
    if (!err && st.isFile()) {
      var ext = path.extname(filePath).toLowerCase();
      var headers = { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' };
      headers['Cache-Control'] = (ext === '.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (hasExt) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    // SPA 路由兜底：无扩展名路径返回 index.html
    fs.readFile(path.join(STATIC_DIR, 'index.html'), function (e2, buf) {
      if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
}

// ---------- 账号体系：访问密码 + 会话（/api/auth/*） ----------
// 设计：所有管理类端点（含本机）统一要求「会话 token」或「主控 Key(config.token)」；
// 未设置访问密码时本地体验模式放行（前端会提示设置）。转发端点(/v1/chat/completions)仍走
// config.token/appTokens，与用户登录无关——那是给外部客户端用的，不是给用户登录的。
const sessions = new Map();                 // sid -> { createdAt, expiresAt }
const SESSION_TTL = 7 * 24 * 3600 * 1000;   // 会话有效期 7 天

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const salt = parts[0], hash = parts[1];
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession() {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
  return id;
}
function sessionIdFromReq(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+sess-([\w\-]+)$/i);
  return m ? m[1] : null;
}
function mgmtAuth(req) {
  // 1) 会话优先
  const sid = sessionIdFromReq(req);
  if (sid && sessions.has(sid) && sessions.get(sid).expiresAt > Date.now()) return true;
  // 2) 兼容旧主控 Key / 应用 Key（机器 / CI / 外部脚本）
  const ah = req.headers['x-proxy-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (config.token && ah === config.token) return true;
  if (config.appTokens.some(function (t) { return t.enabled && t.key === ah; })) return true;
  // 3) 未设置访问密码：本地体验模式放行（前端会提示设置）
  if (!config.accessPassword) return true;
  return false;
}
function handleAuth(req, res, u) {
  const sub = u.pathname.slice('/api/auth/'.length).replace(/\/+$/, '');
  if (req.method === 'GET' && sub === 'status') {
    const sid = sessionIdFromReq(req);
    const authed = !!(sid && sessions.has(sid) && sessions.get(sid).expiresAt > Date.now());
    return sendJson(res, 200, { hasPassword: !!config.accessPassword, authed: authed, firstRun: !config.accessPassword });
  }
  if (req.method === 'POST' && sub === 'login') {
    return readBody(req).then(function (b) {
      if (!config.accessPassword) {
        // 尚未设置访问密码：直接发会话（本地体验模式）
        const sid = newSession();
        return sendJson(res, 200, { token: 'sess-' + sid, expiresAt: sessions.get(sid).expiresAt, noPassword: true });
      }
      const pw = (b && b.password) || '';
      if (!pw) return sendJson(res, 400, { error: { message: '需要密码' } });
      if (!verifyPassword(pw, config.accessPassword)) return sendJson(res, 401, { error: { message: '密码错误' } });
      const sid = newSession();
      return sendJson(res, 200, { token: 'sess-' + sid, expiresAt: sessions.get(sid).expiresAt });
    });
  }
  if (req.method === 'POST' && sub === 'logout') {
    const sid = sessionIdFromReq(req);
    if (sid) sessions.delete(sid);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && sub === 'setup') {
    if (config.accessPassword) return sendJson(res, 409, { error: { message: '访问密码已设置，如需修改请到「设置」中改密' } });
    return readBody(req).then(function (b) {
      const pw = (b && b.password) || '';
      if (pw.length < 4) return sendJson(res, 400, { error: { message: '密码至少 4 位' } });
      config.accessPassword = hashPassword(pw);
      saveConfig();
      const sid = newSession();
      return sendJson(res, 200, { ok: true, token: 'sess-' + sid, expiresAt: sessions.get(sid).expiresAt });
    });
  }
  if (req.method === 'POST' && sub === 'change') {
    // 改密：需已登录会话（mgmtAuth 含会话/主控Key），校验当前密码后设置新密码
    if (!mgmtAuth(req)) return sendJson(res, 401, { error: { message: '改密需先登录' } });
    if (!config.accessPassword) return sendJson(res, 400, { error: { message: '尚未设置访问密码，请先设置' } });
    return readBody(req).then(function (b) {
      const cur = (b && b.current) || '';
      const pw = (b && b.password) || '';
      if (!verifyPassword(cur, config.accessPassword)) return sendJson(res, 401, { error: { message: '当前密码错误' } });
      if (pw.length < 4) return sendJson(res, 400, { error: { message: '新密码至少 4 位' } });
      if (pw === cur) return sendJson(res, 400, { error: { message: '新密码不能与当前密码相同' } });
      config.accessPassword = hashPassword(pw);
      saveConfig();
      return sendJson(res, 200, { ok: true });
    });
  }
  return sendJson(res, 404, { error: { message: '未知认证路径 /api/auth/' + sub } });
}

// ---------- SQLite 结构化日志接口（/api/log/*） ----------
function handleLogApi(req, res, u) {
  var p = u.pathname;
  // 鉴权：会话 / 主控 Key / 未设密码放行（含本机）
  if (!mgmtAuth(req)) {
    return sendJson(res, 401, { error: { message: '日志接口需登录或主控 Key' } });
  }
  if (!logdb.isEnabled()) {
    return sendJson(res, 200, { disabled: true, message: '日志功能已关闭（better-sqlite3 不可用）' });
  }
  if (p === '/api/log/list') {
    var page = parseInt(u.searchParams.get('page') || '1', 10) || 1;
    var pageSize = Math.min(parseInt(u.searchParams.get('pageSize') || '20', 10) || 20, 200);
    var list = logdb.queryList({
      page: page, pageSize: pageSize,
      upstream: u.searchParams.get('upstream') || '',
      model: u.searchParams.get('model') || '',
      status: parseInt(u.searchParams.get('status') || '0', 10) || 0,
      startTime: u.searchParams.get('startTime') || '',
      endTime: u.searchParams.get('endTime') || ''
    });
    return sendJson(res, 200, list);
  }
  if (p === '/api/log/stat') {
    return sendJson(res, 200, logdb.stat());
  }
  if (p === '/api/log/export') {
    var csv = logdb.exportCsv({
      upstream: u.searchParams.get('upstream') || '',
      model: u.searchParams.get('model') || '',
      status: parseInt(u.searchParams.get('status') || '0', 10) || 0,
      startTime: u.searchParams.get('startTime') || '',
      endTime: u.searchParams.get('endTime') || ''
    });
    if (csv.disabled) return sendJson(res, 200, { disabled: true, message: '日志功能已关闭' });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="api-log-export.csv"'
    });
    return res.end(csv.csv);
  }
  return sendJson(res, 404, { error: { message: '未知日志路径 ' + p } });
}

// ---------- 路线2c：可变状态读写端点（/api/data/*，鉴权与 /api/log 同级） ----------
function handleDataApi(req, res, u) {
  var sub = u.pathname.slice('/api/data/'.length).replace(/\/+$/, '');
  // 鉴权：会话 / 主控 Key / 未设密码放行（含本机）
  if (!mgmtAuth(req)) {
    return sendJson(res, 401, { error: { message: '数据接口需登录或主控 Key' } });
  }
  if (req.method === 'GET') {
    if (sub === 'catalog') return sendJson(res, 200, stateStore.getCatalog());
    if (sub === 'relay') return sendJson(res, 200, stateStore.getRelay());
    if (sub === 'free-models') return sendJson(res, 200, stateStore.getFreeModels());
    if (sub === '' || sub === 'status') return sendJson(res, 200, { enabled: stateStore.isEnabled(), keys: ['catalog', 'relay', 'free-models'] });
    return sendJson(res, 404, { error: { message: '未知数据路径 /api/data/' + sub } });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    return readBody(req).then(function (body) {
      if (sub === 'catalog') { stateStore.setCatalog(body); config.catalog = stateStore.getCatalog(); return sendJson(res, 200, { ok: true, catalog: stateStore.getCatalog() }); }
      if (sub === 'relay') { stateStore.setRelay(body); config.relay = stateStore.getRelay(); return sendJson(res, 200, { ok: true, relay: stateStore.getRelay() }); }
      if (sub === 'free-models') { stateStore.setFreeModels(body); config.freeModels = stateStore.getFreeModels(); return sendJson(res, 200, { ok: true, freeModels: stateStore.getFreeModels() }); }
      return sendJson(res, 404, { error: { message: '未知数据路径 /api/data/' + sub } });
    });
  }
  return sendJson(res, 405, { error: { message: '仅支持 GET / PUT' } });
}

// ---------- 开机自启管理（Windows 启动文件夹快捷方式） ----------
const AUTOSTART_LNK = path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'free-api-proxy.lnk');
function autostartStatus() { try { return fs.existsSync(AUTOSTART_LNK); } catch (e) { return false; } }
function runAutostartScript(scriptName, callback) {
  var bat = path.join(__dirname, scriptName);
  if (!fs.existsSync(bat)) {
    return callback(new Error('找不到 ' + scriptName + '，请确认仓库文件完整'));
  }
  var out = '', err = '';
  var child = spawn('cmd', ['/c', bat], { cwd: __dirname });
  child.stdout.on('data', function (d) { out += d.toString(); });
  child.stderr.on('data', function (d) { err += d.toString(); });
  child.on('error', function (e) { callback(e); });
  child.on('close', function (code) { callback(null, { code: code, out: out, err: err }); });
}
function handleAutostartStatus(res) {
  sendJson(res, 200, { ok: true, enabled: autostartStatus(), path: AUTOSTART_LNK });
}
function handleAutostartAction(res, action) {
  var script = action === 'install' ? 'install-autostart.bat' : 'uninstall-autostart.bat';
  runAutostartScript(script, function (e, r) {
    if (e) {
      return sendJson(res, 503, { error: { message: '无法执行自启脚本（受限环境/沙箱拦截）：' + e.message + '。请在真机以管理员运行：' + path.join(__dirname, script) } });
    }
    var ok = r && r.code === 0;
    if (ok) {
      return sendJson(res, 200, { ok: true, enabled: action === 'install', message: action === 'install' ? '已注册开机自启' : '已取消开机自启' });
    }
    var detail = (r && (r.out || r.err)) || '';
    // 批处理输出可能是系统 OEM 编码（如 GBK），Node 按 UTF-8 读会乱码；只保留可打印 ASCII 避免 JSON 里出现乱码
    detail = detail.replace(/[^\x20-\x7E\n\r]/g, '?');
    return sendJson(res, 500, { error: { message: '脚本返回错误（exit=' + (r ? r.code : '?') + '）。请在真机手动运行：' + path.join(__dirname, script) + (detail ? '\n' + detail.slice(-200) : '') } });
  });
}

// ---------- 路线2b：限流状态查询（/api/rate/status，鉴权与 /api/log 同级） ----------
function handleRateStatus(req, res, u) {
  // 鉴权：会话 / 主控 Key / 未设密码放行（含本机）
  if (!mgmtAuth(req)) {
    return sendJson(res, 401, { error: { message: '限流状态接口需登录或主控 Key' } });
  }
  sendJson(res, 200, rl.status());
}

const server = http.createServer(function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 静态资源兜底（非 API 路径的 GET/HEAD）：API 路径已由上方专门路由 return，这里只接非 API 路径
  if ((req.method === 'GET' || req.method === 'HEAD') && !isApiPath(p)) {
    return serveStatic(req, res, p);
  }

  if (p === '/' || p === '/health') return sendHealth(res);
  if (p === '/v1/models') return handleModels(res);
  if (p === '/v1/routes' && req.method === 'GET') return sendJson(res, 200, { routes: config.upstreams.map(maskRoute) });
  if (p === '/v1/tokens' && req.method === 'GET') return sendJson(res, 200, { tokens: config.appTokens.map(maskAppToken) });
  if (p === '/v1/logs' && req.method === 'GET') {
    var lim = parseInt(u.searchParams.get('limit') || '50', 10) || 50;
    return sendJson(res, 200, { ok: true, logs: readLogs(lim), retentionDays: LOG_RETENTION_DAYS });
  }
  if (p === '/v1/classifier' && req.method === 'GET') return handleClassifier(res, null);
  if (p === '/v1/enabled' && req.method === 'GET') return handleEnabledGet(res);
  if (p === '/v1/quota' && req.method === 'GET') return handleQuota(req, res, null);
  if (p === '/v1/quota/usage' && req.method === 'GET') {
    const days = parseInt(u.searchParams.get('days') || '14', 10) || 14;
    return sendJson(res, 200, logdb.consumptionStats({ days: days }));
  }
  // 账号体系：登录/会话/状态（公开端点，不受 mgmtAuth 保护；必须放在管理端点路由之前）
  if (p.indexOf('/api/auth/') === 0) return handleAuth(req, res, u);
  // 路线1：配置镜像 + 状态（前缀 /api）
  if (p === '/api/proxy/status' && req.method === 'GET') return sendStatus(res);
  // 可观测性：/api/health 与根 /health 等价（供 SPA 导航徽标轮询，无需鉴权）
  if (p === '/api/health' && req.method === 'GET') return sendHealth(res);
  // 开机自启状态（本机免鉴权，外网需管理权限）
  if (p === '/api/autostart/status' && req.method === 'GET') {
    if (!mgmtAuth(req)) {
      return sendJson(res, 401, { error: { message: '管理操作需登录或主控 Key' } });
    }
    return handleAutostartStatus(res);
  }
  if (p === '/api/config' && req.method === 'GET') return handleConfigGet(res, u.searchParams.get('export') === '1');
  if (p === '/api/config/export' && req.method === 'GET') return handleConfigGet(res, true);
  if (p === '/v1/admin/token' && req.method === 'GET') return handleAdminToken(res, null);
  if (p === '/v1/test/auth') {
    // 供外部客户端做「连通 + 鉴权」双重测试； LobsterAI / CherryStudio 等的「测试连接」往往只访问 /v1/models（免鉴权），
    // 无法暴露错填 Key 的问题。此端点要求与 chat.completions 相同的鉴权策略，错钥直接 401。
    var authHeader = req.headers['x-proxy-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    var validMaster = config.token && authHeader === config.token;
    var appTok = config.appTokens.find(function (t) { return t.enabled && t.key === authHeader; });
    if (config.token || config.appTokens.length) {
      if (!validMaster && !appTok) {
        return sendJson(res, 401, { error: { message: '代理令牌错误（需主控 Key 或任一应用 Key）' } });
      }
      if (appTok) { appTok.lastUsed = new Date().toISOString(); saveConfig(); }
    }
    return sendJson(res, 200, { ok: true, message: '鉴权通过', mode: 'auth' });
  }

  // 路线2b：限流状态查询（D4，鉴权与 /api/log 同级：本机免 token，非本机须 proxy token；否则 401）
  if (p === '/api/rate/status' && req.method === 'GET') return handleRateStatus(req, res, u);
  // 路线2a：SQLite 结构化日志接口（鉴权：本机 127.0.0.1 免 token；非本机须 proxy token；否则 401）
  if (p.indexOf('/api/log/') === 0 && req.method === 'GET') return handleLogApi(req, res, u);
  // 路线2c：可变状态读写端点（D6：新增 /api/data/*，鉴权与 /api/log 同级）
  if (p.indexOf('/api/data/') === 0) return handleDataApi(req, res, u);

  if (req.method !== 'POST' && req.method !== 'PUT') {
    return sendJson(res, 405, { error: { message: '仅支持 POST / PUT' } });
  }

  readBody(req).then(function (body) {
    var needsToken = (p === '/v1/chat/completions' || p === '/v1/auto/chat/completions');
    // 管理类端点（路由写入 / 主控 token 设置 / 配置镜像）在本机访问时免 token，
    // 非本机来源仍按原策略校验主控 Key，兼顾便利与安全。
    var isRouteWrite = (p === '/v1/routes');
    var isAdminToken = (p === '/v1/admin/token');
    var isConfigWrite = (p === '/api/config');
    var isAutostartWrite = (p === '/api/autostart/install' || p === '/api/autostart/uninstall');
    var authHeader = req.headers['x-proxy-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (needsToken) {
      const validMaster = config.token && authHeader === config.token;
      const appTok = config.appTokens.find(function (t) { return t.enabled && t.key === authHeader; });
      if (validMaster) {
        // 主控 Key：放行
      } else if (appTok) {
        appTok.lastUsed = new Date().toISOString(); saveConfig();
      } else if (config.token || config.appTokens.length) {
        return sendJson(res, 401, { error: { message: '代理令牌错误（需主控 Key 或任一应用 Key）' } });
      }
      // 未配置任何 Key：本地体验模式，放行
    } else if (isRouteWrite || isAdminToken || isConfigWrite || isAutostartWrite) {
      // 账号体系：管理端点统一要求会话 / 主控 Key / 未设密码放行（含本机）
      if (!mgmtAuth(req)) {
        return sendJson(res, 401, { error: { message: '管理操作需登录或主控 Key' } });
      }
    }
    if (p === '/v1/admin/token') return handleAdminToken(res, body);
    if (p === '/v1/catalog/refresh') return handleCatalogRefresh(res);
    if (p === '/v1/routes') return handleRouteUpsert(res, body);
    if (p === '/v1/quota') return handleQuota(req, res, body);
    if (p === '/v1/token/generate') return handleTokenGen(res);
    if (p === '/v1/tokens') return handleTokens(res, body);
    if (p === '/v1/classifier') return handleClassifier(res, body);
    if (p === '/v1/enabled') return handleEnabledSet(res, body);
    if (p === '/v1/logs/clear') return handleLogsClear(res);
    if (p === '/api/config' && req.method === 'PUT') return handleConfigPut(res, body);
    if (p === '/api/config/import' && req.method === 'POST') return handleConfigImport(res, body);
    if (p === '/api/autostart/install' && req.method === 'POST') return handleAutostartAction(res, 'install');
    if (p === '/api/autostart/uninstall' && req.method === 'POST') return handleAutostartAction(res, 'uninstall');
    if (p === '/v1/auto/chat/completions') return handleAuto(req, res, body);
    if (p === '/v1/chat/completions') {
      return handleChat(req, res, body).catch(function (e) {
        if (!res.headersSent) sendJson(res, 502, { error: { message: '上游失败：' + e.message } });
      });
    }
    sendJson(res, 404, { error: { message: '未知路径 ' + p } });
  }).catch(function (e) {
    if (!res.headersSent) sendJson(res, 400, { error: { message: e.message } });
  });
});

loadCatalogCache();
loadEnabled();
pruneLogs();

server.listen(config.port, config.host, function () {
  console.log('[proxy] free-API 本地代理已启动');
  console.log('[proxy] 监听 ' + config.host + ':' + config.port);
  console.log('[proxy] 模式 ' + config.mode + '，上游 ' + config.upstreams.length + ' 条');
  console.log('[proxy] 健康检查： http://' + config.host + ':' + config.port + '/health');
  console.log('[proxy] 聊天接口： http://' + config.host + ':' + config.port + '/v1/chat/completions');
  console.log('[proxy] CORS 已开启，file:// 页面可直接调用');
});

process.on('SIGHUP', reloadConfig);
try { fs.watch(CONFIG_PATH, function () { reloadConfig(); }); } catch (e) {}
