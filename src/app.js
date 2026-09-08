
import { ICON, STAGES, GOALS, SCOPES, API_TEMPLATES } from './modules/constants.js';

  /* ============================================================
     常量与图标
     ============================================================ */
  var KEY = 'wb_freeapi_db_v2';

  var PROXY_BASE = 'http://127.0.0.1:8787';

  // ===== 账号体系（A）：会话 token 状态与请求包装 =====
  var SESSION_KEY = 'fa_session';
  var sessionToken = '';
  try { sessionToken = localStorage.getItem(SESSION_KEY) || ''; } catch (e) {}
  function setSession(t) {
    sessionToken = t || '';
    try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  // 管理请求头：自动附带会话 token（若已登录）
  function mhdr(extra) {
    var h = { 'Content-Type': 'application/json' };
    if (sessionToken) h['Authorization'] = 'Bearer ' + sessionToken;
    if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k]; }
    return h;
  }
  // 管理请求包装：带会话头；若收到 401 且代理已启用密码，自动弹出登录页
  function mfetch(url, opts) {
    opts = opts || {};
    opts.headers = mhdr(opts.headers || {});
    return fetch(url, opts).then(function (r) {
      if (r.status === 401 && /\/api\/|\/v1\/admin\/|\/v1\/token/.test(url)) {
        fetch(PROXY_BASE + '/api/auth/status', { cache: 'no-store' })
          .then(function (sr) { return sr.ok ? sr.json() : null; })
          .then(function (s) { if (s && s.hasPassword && !s.authed) renderLogin(s); })
          .catch(function () {});
      }
      return r;
    });
  }
  // 代理账号状态（由 bootAuth 拉取 /api/auth/status 后填充）：设置页据此渲染密码卡
  var authState = { hasPassword: false, authed: false };
  var PROXY_V1 = PROXY_BASE + '/v1';
  var PROXY_HEALTH = PROXY_BASE + '/health';

  /* ============================================================
     代理依赖矩阵：哪些功能必须本地代理运行，哪些可以离线使用
     ============================================================
     判定依据：proxy/proxy.js 是「统一入口 / 意图识别 / 配置持久化」的后端，
     但前端自身也维护一份本地数据（localStorage：DB.apis / DB.models / DB.routes
     / DB.catalogUser 等）。因此功能分为三类：

     A. 必须代理运行（逻辑上只能由代理完成）
        - /v1/auto 意图识别自动选模型
        - /v1/chat/completions 走统一入口的调用
        - 写入/修改代理 config.json 的 routes（上游路由、卡片「配置Key」在线模式）
        - 生成/管理中转站 Key（config.token / appTokens）
        - 读取上游剩余额度（quotaStore）
        - 刷新实时免费模型目录（/v1/catalog/refresh，也可本机跑 fetch-catalog.js）
        - 清空代理日志

     B. 无需代理（纯前端本地数据管理）
        - 浏览免费模型目录（使用内嵌 EMBEDDED_CATALOG，静态 JSON）
        - API 管理：增删改查本地接口清单（DB.apis）
        - 模型库 / 规则库 / 本地目录的增删改查
        - 生成调用示例 curl（基于 DB.apis 中的 BaseURL + Key）
        - 导入/导出本地 JSON 备份

     C. 代理不在线时的降级路径
        - 卡片「配置Key」：在线 → 写入代理 routes；离线 → 暂存到 DB.apis，
          用户仍可在「API 管理」查看、编辑、生成 curl，启动代理后再到「上游路由」同步。
        - 刷新目录：在线 → 代理执行 fetch-catalog.js；离线 → 提示用户本机运行
          catalog/fetch-catalog.js 后刷新页面。

     前端使用 proxyOnline 变量（由 checkProxyStatus 维护）作为统一判定条件。
     任何需要代理的操作都应当先检查 proxyOnline，并给出明确的在线/离线提示。
     ============================================================ */

  /* ============================================================
     数据层：只负责读写，不碰 DOM
     ============================================================ */
  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function seed() {
    var now = Date.now();
    var day = 86400000;
    return {
      version: 2,
      module: 'overview',
      models: [
        { id: uid(), name: 'qwen-plus', vendor: '阿里云百炼', site: 'bailian.console.aliyun.com',
          free: '新用户赠额度，以官网为准', scopes: ['语言', '对话'], status: '可用', note: '示例数据，免费额度请以官网公告为准；中转规则调用时请填上游真实模型名', updatedAt: now - 1 * day },
        { id: uid(), name: 'glm-4-flash', vendor: '智谱 AI', site: 'open.bigmodel.cn',
          free: '官方标注长期免费', scopes: ['语言', '对话'], status: '可用', note: '示例数据，速率限制以官网为准', updatedAt: now - 2 * day },
        { id: uid(), name: 'gemini-1.5-flash', vendor: 'Google', site: 'aistudio.google.com',
          free: '免费层级，限频次', scopes: ['多模态', '对话'], status: '限频', note: '示例数据，地区可用性需自行确认', updatedAt: now - 3 * day },
        { id: uid(), name: 'hy-mt2-lite', vendor: '腾讯混元', site: 'tokenhub.tencentmaas.com',
          free: 'TokenHub 轻量版，额度以官方为准', scopes: ['语言'], status: '可用', note: '示例数据：旧平台已迁移到 TokenHub，模型名以新控制台为准', updatedAt: now - 5 * day },
        { id: uid(), name: 'stable-diffusion-xl', vendor: 'Stability AI', site: 'platform.stability.ai',
          free: '试用额度已取消', scopes: ['图像'], status: '已停用', note: '示例数据：原免费试用已结束，列为停用不再推荐', updatedAt: now - 9 * day },
        { id: uid(), name: 'deepseek-chat', vendor: 'DeepSeek', site: 'platform.deepseek.com',
          free: '活动期赠送，以公告为准', scopes: ['语言', '代码'], status: '限频', note: '示例数据，活动期限需到官网确认', updatedAt: now - 4 * day }
      ],
      apis: [
        { id: uid(), name: '百炼-通用', vendor: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          key: 'sk-demo-bailian-key', status: '示例', expire: fmtDate(now + 60 * day), scopes: ['语言', '对话'] },
        { id: uid(), name: '智谱-主账号', vendor: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          key: 'sk-demo-zhipu-key', status: '示例', expire: fmtDate(now + 20 * day), scopes: ['语言'] },
        { id: uid(), name: '本地 Ollama', vendor: '本机', baseUrl: 'http://127.0.0.1:11434/v1',
          key: '', status: '正常', expire: '', scopes: ['语言', '代码'] },
        { id: uid(), name: 'Google AI Studio', vendor: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          key: 'sk-demo3m4n5o6p7q8r', status: '已过期', expire: fmtDate(now - 3 * day), scopes: ['多模态'] }
      ],
      routes: [
        { id: uid(), name: '对话-主线路', upstream: '百炼-通用', model: 'qwen-plus', enabled: true, weight: 70, note: '优先走，失败切备用' },
        { id: uid(), name: '对话-备用线', upstream: '智谱-主账号', model: 'glm-4-flash', enabled: true, weight: 30, note: '主线路超时后接管' },
        { id: uid(), name: '图像-理解', upstream: '智谱-主账号', model: 'glm-4v-flash', enabled: true, weight: 0, note: '视觉理解备用（权重 0，可手动启用并提权）' }
      ],
      logs: [],
      sources: [],
      catalogUser: [],
      catalogEnabled: {},
      catalogVendorKey: {},
      relayToken: '',
      proxyMasterToken: '',
      gen: { stage: STAGES[0], scene: '', goal: GOALS[0], custom: '', collapsed: {} },
      settings: { demoState: 'normal', density: 'comfortable', showMasked: true, confirmDelete: true, intent: false, vaultOn: false, theme: 'cyberpunk', themeBg: 'cyberpunk', brightness: 100, fontScale: 100, fontFamily: 'system', startup: 'overview', proxyAutostart: false }
    };
  }

  // 路线2（Phase 2c）：浏览器 localStorage 仅持久化「用户密钥库(DB.apis) + UI 偏好(settings/gen)」。
  // catalog/relay/freeModels/relayToken/proxyMasterToken 等可变业务状态已收口到代理 SQLite（/api/data/*），
  // 启动时由 loadConfigFromProxy() 从代理拉取，不再落浏览器。
  function load() {
    var d = seed();   // 内存初始（示例占位；业务真相源在代理，启动后由 loadConfigFromProxy 覆盖）
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.version === 2) {
          if (Array.isArray(s.apis)) d.apis = s.apis;   // 用户密钥库仍留浏览器（D5：vaultOn 浏览器加密）
          d.settings = Object.assign(d.settings || {}, s.settings || {});
          d.gen = Object.assign(d.gen || {}, s.gen || {});
          d.settings.intent = !!d.settings.intent;
          d.settings.vaultOn = !!d.settings.vaultOn;
          if (!d.settings.theme) d.settings.theme = 'light';
          if (!d.settings.themeBg) d.settings.themeBg = 'default';
          if (d.settings.proxyAutostart == null) d.settings.proxyAutostart = false;
          if (d.settings.brightness == null) d.settings.brightness = 100;
          if (d.settings.fontScale == null) d.settings.fontScale = 100;
          if (!d.settings.fontFamily) d.settings.fontFamily = 'system';
          if (!d.settings.startup) d.settings.startup = 'overview';
          (d.apis || []).forEach(function (a) { if (a && a.keyEnc === undefined) a.keyEnc = ''; });
          // 本地接口（Ollama/LM Studio/本地代理）key 为空是正常状态，不应显示未配置
          (d.apis || []).forEach(function (a) {
            if (!a) return;
            var isLocal = /127\.0\.0\.1|localhost|::1/.test(a.baseUrl || '') || /本机|LocalAI|LM Studio|本地代理/.test((a.vendor || '') + (a.name || ''));
            if (isLocal && a.status === '未配置') a.status = '正常';
          });
        }
      }
    } catch (e) { /* 损坏则重建 */ }
    return d;
  }

  // 仅持久化「用户密钥库 + UI 偏好」到浏览器（路线2：业务状态已收口代理 SQLite，不再落浏览器）
  function save() {
    try {
      var ser = { version: 2, apis: DB.apis || [], settings: DB.settings || {}, gen: DB.gen || {} };
      if (DB.settings.vaultOn) {
        (ser.apis || []).forEach(function (a) {
          if (a.keyEnc) a.key = '';        // 有密文则不落明文
          else if (a.key) a.key = '';     // 防御：保险库开启却未加密，绝不写明文
        });
      }
      localStorage.setItem(KEY, JSON.stringify(ser));
    } catch (e) { /* 忽略 */ }
    scheduleCfgSync();   // catalog/relay/freeModels/tokens 镜像进代理 SQLite（浏览器不再持久化这些）
  }

  // 路线2（Phase 2c）：可变业务状态经 /api/data/* 推送到代理 SQLite；密钥类 token 仍走 /api/config
  var cfgSyncTimer = null;
  function scheduleCfgSync() {
    if (cfgSyncTimer) clearTimeout(cfgSyncTimer);
    cfgSyncTimer = setTimeout(pushStateToProxy, 800);
  }
  function pushStateToProxy() {
    if (!proxyOnline) return;
    var hdr = mhdr();
    fetch(PROXY_BASE + '/api/data/relay', { method: 'PUT', headers: hdr, body: JSON.stringify(DB.routes || []) }).catch(function () {});
    fetch(PROXY_BASE + '/api/data/catalog', { method: 'PUT', headers: hdr, body: JSON.stringify({ user: DB.catalogUser || [], enabled: DB.catalogEnabled || {}, vendorKey: DB.catalogVendorKey || {} }) }).catch(function () {});
    fetch(PROXY_BASE + '/api/data/free-models', { method: 'PUT', headers: hdr, body: JSON.stringify(DB.models || []) }).catch(function () {});
    // 密钥类（relayToken / 主控 token）仍走 /api/config
    fetch(PROXY_BASE + '/api/config', { method: 'PUT', headers: hdr, body: JSON.stringify({ tokens: { relayToken: DB.relayToken || '', proxyMasterToken: DB.proxyMasterToken || '' } }) }).catch(function () {});
  }
  function syncConfigToProxy() { pushStateToProxy(); }
  // 代理上线时把本机 config.json 的权威配置拉回 SPA（用 export 全量接口，含未掩码目录/令牌）
  function loadConfigFromProxy() {
    if (!proxyOnline) return;
    fetch(PROXY_BASE + '/api/config/export', { cache: 'no-store', headers: mhdr() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        if (Array.isArray(j.relay)) DB.routes = j.relay;
        if (j.catalog && typeof j.catalog === 'object') {
          DB.catalogUser = Array.isArray(j.catalog.user) ? j.catalog.user : [];
          DB.catalogEnabled = j.catalog.enabled || {};
          DB.catalogVendorKey = j.catalog.vendorKey || {};
        }
        if (Array.isArray(j.freeModels) && j.freeModels.length) DB.models = j.freeModels;
        if (j.tokens && typeof j.tokens === 'object') {
          if (typeof j.tokens.relayToken === 'string' && j.tokens.relayToken) DB.relayToken = j.tokens.relayToken;
          if (j.tokens.proxyMasterToken != null) DB.proxyMasterToken = j.tokens.proxyMasterToken;
        }
        save();
      })
      .catch(function () { /* 忽略 */ });
  }
  // 导出全部配置为 tool-backup.json（前端通道，代理离线也能用）
  function exportAllConfig() {
    try {
      var data = JSON.parse(JSON.stringify(DB));
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'tool-backup.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已导出 tool-backup.json', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }
  // 从备份文件导入（覆盖式恢复），导入后 save() 会镜像进代理 config.json
  function importAllConfig(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        if (!obj || typeof obj !== 'object' || !obj.models || !obj.apis) throw new Error('不是有效的备份文件');
        if (!window.confirm('导入将覆盖当前全部本地配置，确定继续？')) return;
        DB = obj; DB.version = 2;
        save();
        pushStateToProxy();   // 导入的业务状态同步推送到代理 SQLite
        toast('已导入配置，正在刷新…', 'ok');
        setTimeout(function () { location.reload(); }, 400);
      } catch (e) { toast('导入失败：' + e.message, 'err'); }
    };
    reader.readAsText(file);
  }

  function cleanupOpenRouterApis() {
    try {
      var before = (DB.apis || []).length;
      DB.apis = (DB.apis || []).filter(function (a) {
        var isOpenRouter = (a.name || '').toLowerCase().indexOf('openrouter') !== -1 ||
                           (a.vendor || '').toLowerCase().indexOf('openrouter') !== -1 ||
                           (a.baseUrl || '').indexOf('openrouter.ai') !== -1;
        if (isOpenRouter) {
          console.log('[cleanup] 移除冗余 OpenRouter 账号条目：', a.name);
        }
        return !isOpenRouter;
      });
      var removed = before - (DB.apis || []).length;
      if (removed > 0) {
        save();
        setTimeout(function () { toast('已清理 ' + removed + ' 条冗余 OpenRouter 账号条目（代理路由已覆盖 OpenRouter 免费层）'); }, 0);
      }
    } catch (e) { console.error('[cleanup] OpenRouter 清理失败', e); }
  }

  function ensureDefaultApis() {
    try {
      var seedApis = seed().apis || [];
      var routes = DB.routes || [];
      var changed = false;
      var byName = {};
      (DB.apis || []).forEach(function (a) { if (a && a.name) byName[a.name] = a; });
      // 补齐 seed 中声明的默认上游接口（防止用户清空/损坏 localStorage 后规则找不到接口）
      seedApis.forEach(function (def) {
        if (!def || !def.name) return;
        if (!byName[def.name]) {
          DB.apis.push(JSON.parse(JSON.stringify(def)));
          changed = true;
          console.log('[ensureDefaultApis] 补齐默认上游接口：', def.name);
        }
      });
      // 若规则指向的上游接口不存在，自动用 seed 中的同名接口创建
      routes.forEach(function (r) {
        if (!r || !r.upstream) return;
        if (!findApiByName(r.upstream)) {
          var matched = seedApis.find(function (a) { return a.name === r.upstream; });
          if (matched) {
            DB.apis.push(JSON.parse(JSON.stringify(matched)));
            changed = true;
            console.log('[ensureDefaultApis] 按规则需求补齐上游接口：', matched.name);
          }
        }
      });
      if (changed) {
        save();
        setTimeout(function () { toast('已自动补齐缺失的默认上游接口，请重新测试中转规则'); }, 0);
      }
    } catch (e) { console.error('[ensureDefaultApis] 失败', e); }
  }

  // 路线2（Phase 2c）：relay 规则已收口到代理 SQLite（/api/data/relay），由服务端权威管理；
  // 不再在浏览器本地做示例规则的模型名修正（避免本地改动与服务端不一致）。保留函数为空实现以免动调用点。
  function fixRelayRules() { /* no-op：relay 规则现为服务端权威 */ }

  // 确保本地至少保留 2 条示例中转规则，避免空数据时中转规则页显示 0 条
  function ensureDefaultRoutes() {
    try {
      if (!Array.isArray(DB.routes)) DB.routes = [];
      if (DB.routes.length >= 2) return;
      var defs = seed().routes || [];
      var existing = {};
      DB.routes.forEach(function (r) { if (r && r.name) existing[r.name] = true; });
      var added = 0;
      defs.forEach(function (r) {
        if (!r || !r.name) return;
        if (existing[r.name]) return;
        DB.routes.push(JSON.parse(JSON.stringify(r)));
        added++;
      });
      if (added) { save(); console.log('[ensureDefaultRoutes] 已补齐 ' + added + ' 条默认中转规则'); }
    } catch (e) { console.error('[ensureDefaultRoutes] 失败', e); }
  }

  var DB = load();
  cleanupOpenRouterApis();
  ensureDefaultApis();
  ensureDefaultRoutes();
  fixRelayRules();
  var vaultPass = null;        // 会话内口令（不落盘）
  var vaultUnlocked = false;   // 当前会话是否已解锁

  /* ============================================================
     计算层：纯函数，不碰 DOM
     ============================================================ */
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function p2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(ts) {
    var d = new Date(ts);
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function fmtFull(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function relTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + ' 天前';
    return fmtDate(ts);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function maskKey(k) {
    if (!k) return '未填写';
    if (k.length <= 8) return k.slice(0, 2) + '****';
    return k.slice(0, 6) + '····' + k.slice(-4);
  }

  function statusChip(s) {
    var cls = 'chip-mute';
    if (s === '可用' || s === '正常' || s === '启用') cls = 'chip-ok';
    else if (s === '限额') cls = 'chip-quota';
    else if (s === '限免') cls = 'chip-trial';
    else if (s === '限频' || s === '待核实') cls = 'chip-warn';
    else if (s === '已过期' || s === '已下架' || s === '停用' || s === '已停用') cls = 'chip-err';
    return '<span class="chip ' + cls + '"><i></i>' + esc(s || '待核实') + '</span>';
  }

  function scopeTags(list) {
    if (!list || !list.length) return '<span class="tag">未标注</span>';
    return list.map(function (s) { return '<span class="tag tag-violet">' + esc(s) + '</span>'; }).join('');
  }

  // 统计：只算，不渲染
  function calcStats() {
    var logs = (proxyOnline && proxyLogs.length) ? proxyLogs : DB.logs, total = logs.length, ok = 0, lat = 0, latN = 0, tokens = 0;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var todayN = 0, yestN = 0;
    var yestStart = today.getTime() - 86400000;
    logs.forEach(function (l) {
      if (l.status === 200) { ok++; lat += l.latency; latN++; tokens += l.tokens; }
      if (l.ts >= today.getTime()) todayN++;
      else if (l.ts >= yestStart) yestN++;
    });
    var byModel = {};
    logs.forEach(function (l) {
      if (l.status !== 200) return;
      byModel[l.model] = (byModel[l.model] || 0) + 1;
    });
    var days = daySeries();
    var deltaTxt = '与昨日持平', deltaCls = 'flat';
    if (yestN === 0 && todayN > 0) { deltaTxt = '昨日无调用'; deltaCls = 'up'; }
    else if (todayN > yestN) { deltaTxt = '较昨日 +' + (todayN - yestN); deltaCls = 'up'; }
    else if (todayN < yestN) { deltaTxt = '较昨日 ' + (todayN - yestN); deltaCls = 'down'; }
    return {
      total: total,
      today: todayN,
      yest: yestN,
      okRate: total ? Math.round(ok / total * 1000) / 10 : 0,
      avgLat: latN ? Math.round(lat / latN) : 0,
      tokens: tokens,
      byModel: byModel,
      days: days,
      routesOn: DB.routes.filter(function (r) { return r.enabled; }).length,
      deltaTxt: deltaTxt, deltaCls: deltaCls
    };
  }

  function daySeries() {
    var out = [], i, base = new Date(); base.setHours(0, 0, 0, 0);
    for (i = 6; i >= 0; i--) {
      var s = base.getTime() - i * 86400000;
      var e = s + 86400000;
      var n = DB.logs.filter(function (l) { return l.ts >= s && l.ts < e; }).length;
      out.push({ ts: s, n: n });
    }
    return out;
  }

  function findById(arr, id) {
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; }
    return null;
  }

  function genPayload() {
    var g = DB.gen;
    var goal = g.goal === '自定义目标' ? (g.custom || '（未填写）') : g.goal;
    var scene = g.scene || '（未填写情境描述）';
    var api = DB.apis.filter(function (a) { return a.status === '正常'; })[0];
    var model = DB.models.filter(function (m) { return m.status === '可用'; })[0];
    var host = (api && api.baseUrl) || 'https://your-gateway.example.com/v1';
    var mname = (model && model.name) || 'qwen2.5-7b-instruct';
    return {
      summary: '阶段：' + g.stage + ' ｜ 目标：' + goal + ' ｜ 情境：' + (scene.length > 40 ? scene.slice(0, 40) + '…' : scene),
      curl: [
        '# ' + g.stage + ' · ' + goal,
        'curl ' + host + '/chat/completions \\',
        '  -H "Authorization: Bearer $YOUR_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"model":"' + mname + '","messages":[{"role":"user","content":"' + esc(scene).slice(0, 60) + '"}]}\''
      ].join('\n'),
      json: [
        '{',
        '  "stage": "' + g.stage + '",',
        '  "goal": "' + goal + '",',
        '  "scene": "' + esc(scene).slice(0, 80) + '",',
        '  "upstream": "' + host + '",',
        '  "model": "' + mname + '",',
        '  "params": { "temperature": 0.7, "max_tokens": 1024 }',
        '}'
      ].join('\n')
    };
  }

  /* ============================================================
     渲染层：只读数据 + 写 DOM，渲染函数之间严禁互调
     ============================================================ */
  var elContent = null;
  // 代理侧实时状态（不入 localStorage，仅本次会话）
  var proxyLogs = [];
  var appTokens = [];
  var proxyClassifier = '';
  var proxyModelCount = 0;   // 当前生效模型数（由 /api/proxy/status 或 /health 计算）
  var enabledCount = 0;   // 代理「已选中文档」中记录的模型数
  var proxyOnline = false;
  var appTokenRaw = {};   // id -> 明文 Key（仅创建时拿到，供复制；不持久化）

  function eqJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function pullProxyLogs() {
    fetch(PROXY_V1 + '/logs?limit=60', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (j) {
        var logs = (j && j.logs) || [];
        if (!eqJson(logs, proxyLogs)) { proxyLogs = logs; if (DB.module === 'relay' || DB.module === 'overview') renderContent(); }
      })
      .catch(function () { proxyLogs = []; });
  }
  function pullAppTokens() {
    fetch(PROXY_V1 + '/tokens', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (j) {
        var tokens = (j && j.tokens) || [];
        if (!eqJson(tokens, appTokens)) { appTokens = tokens; if (DB.module === 'relay') renderContent(); }
      })
      .catch(function () { appTokens = []; });
  }
  function pullClassifier() {
    fetch(PROXY_V1 + '/classifier', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (j) {
        var clf = (j && j.classifier) || '';
        if (clf !== proxyClassifier) { proxyClassifier = clf; if (DB.module === 'relay') renderContent(); }
      })
      .catch(function () { proxyClassifier = ''; });
  }
  // 读取代理「已选中文档」记录的模型数，用于意图面板展示同步状态
  function pullEnabled() {
    if (!proxyOnline) return;
    fetch(PROXY_V1 + '/enabled', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (j) {
        var n = (j && j.count) || 0;
        if (n !== enabledCount) { enabledCount = n; if (DB.module === 'relay') renderContent(); }
      })
      .catch(function () { enabledCount = 0; });
  }

  function renderBadges() {
    set('badgeFree', getCatalog().length);
    set('badgeApi', DB.apis.length);
    set('badgeRelay', DB.routes.length);
    set('badgeRoutes', (proxyRoutes || []).length);
  }

  function renderNav() {
    var items = document.querySelectorAll('#nav .nav-item');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-mod') === DB.module;
      items[i].classList.toggle('is-active', on);
      items[i].setAttribute('aria-current', on ? 'page' : 'false');
    }
  }

  function renderContent() {
    if (!elContent) return;
    if (DB.module === 'overview') { elContent.innerHTML = viewOverview(); loadOverviewData(); }
    else if (DB.module === 'free') elContent.innerHTML = viewFree();
    else if (DB.module === 'api') elContent.innerHTML = viewApi();
    else if (DB.module === 'routes') { elContent.innerHTML = viewRoutes(); loadProxyRoutes(); }
    else if (DB.module === 'logs') { elContent.innerHTML = viewLogs(); loadLogsData(); }
    else elContent.innerHTML = viewRelay();
    elContent.scrollTop = 0;
  }

  // 统一刷新入口
  function resolveThemeMode() {
    var m = (DB.settings.theme || 'light');
    if (m === 'system') {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      return 'light';
    }
    return m;
  }
  function applyTheme() {
    var s = DB.settings;
    var body = document.body;
    var html = document.documentElement;
    var mode = 'theme-' + resolveThemeMode();
    // 背景主题
    body.classList.remove('bg-default','bg-nature','bg-nebula','bg-cyberpunk','bg-tech');
    body.classList.add('bg-' + (s.themeBg || 'default'));
    // 界面模式：同步到 body 与 html，html 用于根滚动条轨道底色
    body.classList.remove('theme-light','theme-dark','theme-eyecare','theme-cyberpunk');
    body.classList.add(mode);
    html.classList.remove('theme-light','theme-dark','theme-eyecare','theme-cyberpunk');
    html.classList.add(mode);
    // 亮度
    body.style.filter = s.brightness === 100 ? '' : 'brightness(' + s.brightness + '%)';
    // 字号缩放
    var fs = s.fontScale || 100;
    document.documentElement.style.setProperty('--app-font-scale', fs + '%');
    if (fs !== 100) body.style.fontSize = 'calc(14px * ' + (fs/100) + ')';
    else body.style.fontSize = '';
    // 字体
    var families = {
      system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      serif: 'Georgia, "Noto Serif SC", "Songti SC", serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace'
    };
    body.style.fontFamily = families[s.fontFamily] || families.system;
  }

  function refreshAll() {
    renderNav();
    renderBadges();
    renderContent();
    // 任何模块下都探测一次代理状态：Free 模块的「配置Key」「刷新目录」等操作都依赖 proxyOnline
    checkProxyStatus();
  }

  // 异步探测本地代理健康状态，只更新 #proxyStatus，不触发其它渲染（保持单向调用）
  var proxyProbeBusy = false;
  var proxyRoutes = [];          // 代理 config.json 的 routes（上游路由），由 loadProxyRoutes 拉取
  var proxyQuota = {};           // 代理 quotaStore（上游 rate-limit 剩余），由 pullQuota 拉取
  var proxyVendorBalances = [];  // 厂商账户余额（DeepSeek/硅基流动），由 pullQuota 拉取
  var proxyModelQuota = {};      // 每模型 token 余额：{freeQuota, used, remaining, hasQuota}
  var proxyModelUsage = {};      // 每模型已用 tokens：{model:{prompt,completion,total,calls}}
  var proxyQuotaAt = 0;          // 配额拉取时间戳
  var proxyThresholdAlerts = { models: [], vendors: [], count: 0, hasCrit: false, hasWarn: false }; // 额度不足告警
  var proxyConsumption = null;  // 额度消耗分析（/v1/quota/usage）
  var catalogUpdatedAt = '';     // 目录最后更新时间
  var quotaSchedStarted = false; // 30min 轮询 + 每日2:00 刷新是否已启动（页面驱动）
  var proxyRoutesLoading = false;
  var proxyAdminTokenState = { hasToken: false, text: '检测中…' }; // /v1/admin/token 状态
  function checkProxyStatus() {
    if (proxyProbeBusy) return;
    proxyProbeBusy = true;
    var el = document.getElementById('proxyStatus');
    fetch(PROXY_HEALTH, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('bad');
        return r.json();
      })
      .then(function (j) {
        var wasOnline = proxyOnline;
        proxyOnline = true;
        if (el) {
          var healthy = (j.routes || []).filter(function (x) { return x.healthy; }).length;
          el.innerHTML = '<span class="chip chip-ok"><i></i>在线</span> 模式 ' + esc(j.mode) +
            ' | 上游 ' + healthy + '/' + (j.routes ? j.routes.length : 0) + ' 健康 | 缓存 ' + (j.cacheSize || 0) + ' 条' +
            '<div class="proxy-hint">把某个接口的 Base URL 设为 <code>' + esc(PROXY_V1) + '</code> 即可走统一入口</div>';
        }
        // 计算当前生效模型数（去重，排除 '*'）
        var mset = {};
        (j.routes || []).forEach(function (r) { (r.models || []).forEach(function (m) { if (m && m !== '*') mset[m] = 1; }); });
        proxyModelCount = Object.keys(mset).length;
        renderWelcomeStatus();
        updateSideHealth(j);
        pullProxyLogs(); pullAppTokens(); pullClassifier(); pullEnabled();
        if (DB.settings.intent) { pushEnabledToProxy(); pullQuota(); }
        ensureQuotaSchedule();   // 页面驱动：30min 轮询配额 + 每日2:00 刷新目录（仅开页触发）
        // 代理状态发生变化（离线→在线）才需要重绘 routes 表格；稳定后仅更新本区域，避免 DOM 重建闪烁
        if (DB.module === 'routes' && !wasOnline) renderContent();
        if (!wasOnline) loadConfigFromProxy();   // 代理上线：把本机 config.json 权威配置拉回 SPA
        loadProxyRoutes();
      })
      .catch(function () {
        var wasOnline = proxyOnline;
        proxyOnline = false; proxyLogs = []; appTokens = []; proxyClassifier = '';
        proxyModelCount = 0;
        updateSideHealth(null);
        renderWelcomeStatus();
        if (el) el.innerHTML = '<span class="chip chip-err"><i></i>未运行</span> 代理未在本地启动' +
          '<div class="proxy-hint">运行：<code>node proxy/proxy.js</code>（详见 proxy/README.md）</div>';
        // 在线→离线才需要重绘为离线提示；稳定后仅更新本区域
        if (DB.module === 'routes' && wasOnline) renderContent();
      })
      .finally(function () { proxyProbeBusy = false; });
  }

  // 导航侧栏常驻健康徽标：由 checkProxyStatus 的同一探测结果驱动（单一真相源）
  function updateSideHealth(j) {
    var root = document.getElementById('sideHealth');
    var dot = document.getElementById('shDot');
    var txt = document.getElementById('shText');
    var ver = document.getElementById('shVer');
    if (!root || !dot || !txt) return;
    if (!j || !j.ok) {
      root.className = 'side-health is-off';
      dot.className = 'sh-dot';
      txt.textContent = '代理离线';
      if (ver) ver.textContent = '';
      return;
    }
    var rl = j.rateLimit || {};
    var store = (j.store && j.store.enabled) ? '存储✓' : '存储✗';
    var logs = (j.logs && j.logs.enabled) ? '日志✓' : '日志✗';
    var rlTxt = rl.disabled ? '限流关' : '限流开';
    var rateStore = (j.rateStore && j.rateStore.enabled) ? '·共享' : '';
    root.className = 'side-health is-on';
    dot.className = 'sh-dot';
    txt.textContent = '在线 · ' + (j.mode || '') + ' · ' + rlTxt + (rl.disabled ? '' : rateStore) + ' · ' + store + ' · ' + logs;
    if (ver) ver.textContent = 'v' + (j.version || '?');
  }

  // 欢迎页主卡：根据代理在线状态渲染真实状态，离线降级不崩
  function renderWelcomeStatus() {
    var stateEl = document.getElementById('wvProxyState');
    var chipEl = document.getElementById('wvProxyChip');
    var modelEl = document.getElementById('wvModelCount');
    var hintEl = document.getElementById('wvProxyHint');
    if (!stateEl || !chipEl || !modelEl) return;
    if (proxyOnline) {
      stateEl.textContent = '本地代理在线';
      chipEl.className = 'wv-mock-chip ok'; chipEl.textContent = '正常';
      modelEl.textContent = proxyModelCount > 0 ? (proxyModelCount + ' 个') : '示例 · 免费/限额';
      if (hintEl) hintEl.hidden = true;
    } else {
      stateEl.textContent = '本地代理离线';
      chipEl.className = 'wv-mock-chip err'; chipEl.textContent = '离线';
      modelEl.textContent = '未知（代理离线）';
      if (hintEl) hintEl.hidden = false;
    }
  }

  // 模块刷新：进入加载态（卡片/行骨架）约 650ms，模拟读取本地数据
  function doRefresh(mod) {
    if (pendingRefresh) return;
    pendingRefresh = mod;
    refreshAll();
    setTimeout(function () {
      pendingRefresh = null;
      refreshAll();
      toast('已刷新');
    }, 650);
  }

  /* ---------- 生成面板（Free 模型 / API 管理 共用） ---------- */
  function genPanel(title, desc, key) {
    var g = DB.gen;
    var collapsed = !!(DB.gen.collapsed && DB.gen.collapsed[key]);
    var stageOpts = STAGES.map(function (s) {
      return '<option value="' + esc(s) + '"' + (g.stage === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    var goalOpts = GOALS.map(function (s) {
      return '<option value="' + esc(s) + '"' + (g.goal === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    var customShow = g.goal === '自定义目标' ? '' : ' hidden';
    var toggle = '<button class="btn btn-ghost btn-icon collapse-btn" type="button" data-act="toggle-gen-panel" data-key="' + esc(key) + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-label="' + (collapsed ? '展开' : '收起') + '" title="' + (collapsed ? '展开' : '收起') + '">' + (collapsed ? ICON.chevronDown : ICON.chevronUp) + '</button>';

    return '' +
    '<section class="panel is-collapsible' + (collapsed ? ' is-collapsed' : '') + '" data-gen-key="' + esc(key) + '">' +
      '<div class="panel-head">' +
        '<div>' +
          '<h2>' + esc(title) + '</h2>' +
          '<p class="ph-sub">' + esc(desc) + '</p>' +
        '</div>' +
        '<div class="ph-right">' + toggle + '<span class="chip chip-mute"><i></i>本地生成，不联网</span></div>' +
      '</div>' +
      '<div class="panel-body">' +
        '<div class="gen-grid">' +
          '<div class="field" id="fStage">' +
            '<label for="genStage">关系阶段<span class="req">*</span></label>' +
            '<select class="select" id="genStage" data-gen="stage">' + stageOpts + '</select>' +
            '<p class="hint">选一个当前所处的阶段，决定生成结果的语气与侧重点</p>' +
            '<p class="err-msg">请选择关系阶段</p>' +
          '</div>' +
          '<div class="field" id="fGoal">' +
            '<label for="genGoal">当前目标<span class="req">*</span></label>' +
            '<select class="select" id="genGoal" data-gen="goal">' + goalOpts + '</select>' +
            '<p class="hint">想先解决哪件事，就选对应的目标</p>' +
            '<p class="err-msg">请选择或填写当前目标</p>' +
          '</div>' +
          '<div class="field gen-full" id="fCustom"' + (customShow ? ' hidden' : '') + '>' +
            '<label for="genCustom">自定义目标</label>' +
            '<input class="input" id="genCustom" type="text" data-gen="custom" maxlength="60" ' +
              'placeholder="例如：把百炼的额度接到本地测试脚本" value="' + esc(g.custom) + '">' +
            '<p class="hint">最多 60 字，写清楚要给谁用、用来做什么</p>' +
            '<p class="err-msg">请填写自定义目标，或改选一个预设目标</p>' +
          '</div>' +
          '<div class="field gen-full" id="fScene">' +
            '<label for="genScene">情境描述<span class="req">*</span></label>' +
            '<textarea class="textarea" id="genScene" data-gen="scene" maxlength="500" ' +
              'placeholder="说明现在的处境与限制。例如：我有一台本地机器跑 Ollama，想在下班前把百炼的免费额度接进来，先验证一次对话能不能通，后面再考虑多模型切换。">' + esc(g.scene) + '</textarea>' +
            '<p class="hint">已输入 <b id="sceneCount">' + g.scene.length + '</b>/500 字，写得越具体，生成的配置越贴合</p>' +
            '<p class="err-msg">情境描述至少需要 10 个字</p>' +
          '</div>' +
        '</div>' +
        '<div class="gen-foot">' +
          '<span class="gf-note">生成结果只在本地拼接，不会向任何地址发请求</span>' +
          '<span class="gf-right">' +
            '<button class="btn btn-outline" type="button" data-act="gen-reset">重置</button>' +
            '<button class="btn btn-accent" type="button" id="genBtn" data-act="gen-run">' + ICON.spark + '生成配置与示例</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* ---------- 边界状态区 ---------- */
  function stateArea(cfg) {
    // cfg: { state, emptyTitle, emptyDesc, emptyAct, cols }
    var s = cfg.state || 'normal';
    if (s === 'loading') {
      var rows = '', i;
      for (i = 0; i < 3; i++) {
        rows += '<div class="sk-row">' +
          '<div class="sk sk-ava"></div>' +
          '<div class="sk-lines">' +
            '<div class="sk" style="height:13px;width:58%"></div>' +
            '<div class="sk" style="height:11px;width:82%"></div>' +
          '</div></div>';
      }
      return '<div class="panel-body"><div class="sk-list">' + rows + '</div>' +
             '<p class="gf-note" style="text-align:center;margin-top:14px">正在读取本地数据…</p></div>';
    }
    if (s === 'error') {
      return '<div class="state-box">' +
        '<div class="state-ico err">' + ICON.alert + '</div>' +
        '<p class="state-title">读取失败</p>' +
        '<p class="state-desc">没能拿到数据。可能是存储被清空，或者数据格式变了。</p>' +
        '<div class="state-act">' +
          '<button class="btn btn-outline" type="button" data-act="retry">' + ICON.refresh + '重试</button>' +
          '<button class="btn btn-primary" type="button" data-act="reset-data">恢复示例数据</button>' +
        '</div></div>';
    }
    if (s === 'empty') {
      return '<div class="state-box">' +
        '<div class="state-ico empty">' + ICON.empty + '</div>' +
        '<p class="state-title">' + esc(cfg.emptyTitle) + '</p>' +
        '<p class="state-desc">' + esc(cfg.emptyDesc) + '</p>' +
        '<div class="state-act">' + (cfg.emptyAct || '') + '</div>' +
      '</div>';
    }
    return null;
  }

  // 本地代理状态条：各模块共用，供 checkProxyStatus 探测并展示统一入口状态
  function proxyStripHtml() {
    return '<section class="panel proxy-strip">' +
      '<div class="panel-head"><div><h2>本地代理</h2><p class="ph-sub">统一入口 ' + PROXY_V1 + '</p></div></div>' +
      '<div class="panel-body"><div id="proxyStatus" class="proxy-status">检测中…</div></div>' +
    '</section>';
  }

  /* ---------- 模块零：概览（运行态势总览） ---------- */
  function viewOverview() {
    var stats = calcStats();
    var live = !!proxyOnline;

    var head = '<div class="page-head">' +
      '<div class="ph-text"><h1>概览</h1>' +
        '<p>代理健康、调用统计与快捷入口，一眼看清系统状态。</p></div>' +
      '<div class="ph-actions">' +
        '<button class="btn btn-outline" type="button" data-act="refresh">' + ICON.refresh + '刷新状态</button>' +
      '</div></div>';

    /* ---- Hero 封面：状态 + 一句话定位 + 主动作 ---- */
    var dotCss = live
      ? 'background:#34d8ac;box-shadow:0 0 0 3px rgba(52,216,172,.25)'
      : 'background:#e26374;box-shadow:0 0 0 3px rgba(226,99,116,.25)';
    var hero = '<section class="hero-banner"><div class="hb-inner">' +
      '<div class="hb-text">' +
        '<span class="hb-eyebrow"><i style="' + dotCss + '"></i>' + (live ? '本地代理运行中' : '本地代理未连接') + '</span>' +
        '<h2>Free API 工作台</h2>' +
        '<p>统一管理各平台免费模型与凭证，经本地代理 <code>' + esc(PROXY_V1) + '</code> 对外提供 OpenAI 兼容接口，LobsterAI / CherryStudio 等应用可直接接入。</p>' +
        '<div class="hb-actions">' +
          '<button class="btn btn-accent" type="button" data-act="refresh">' + ICON.refresh + '刷新状态</button>' +
          '<button class="btn btn-ghost" type="button" data-act="catalog-health">健康巡检</button>' +
          '<button class="btn btn-ghost" type="button" data-act="copy-endpoint">复制调用地址</button>' +
          '<button class="btn btn-ghost" type="button" data-act="proxy-detail">代理详情</button>' +
        '</div>' +
      '</div>' +
      '<div class="hb-pulse' + (live ? '' : ' is-off') + '">' +
        '<div class="hbp-core">' + (live
          ? '<b>' + stats.today + '</b><span>今日调用</span>'
          : '<b>—</b><span>代理离线</span>') + '</div>' +
      '</div>' +
    '</div></section>';

    /* ---- 四张统计卡 ---- */
    var statCards = '<section class="stat-grid is-bento stagger">' +
      statCard('今日调用', stats.today, '次', 'navy', ICON.bolt, stats.deltaTxt, stats.deltaCls) +
      statCard('调用成功率', stats.okRate, '%', 'ok', ICON.check, '近 ' + stats.total + ' 次统计', 'flat') +
      statCard('平均延迟', stats.avgLat, 'ms', 'violet', ICON.clock, '仅统计成功请求', 'flat') +
      statCard('启用规则', stats.routesOn + '/' + DB.routes.length, '', 'warn', ICON.layers, '累计 ' + stats.tokens.toLocaleString('zh-CN') + ' tokens', 'flat') +
    '</section>';

    /* ---- 快捷入口 ---- */
    var quick = '<section class="panel">' +
      '<div class="panel-head"><div><h2>快捷入口</h2>' +
        '<p class="ph-sub">模型、接口、规则与路由</p></div></div>' +
      '<div class="panel-body"><div class="quick-grid stagger">' +
        quickCard('free', ICON.search, 'Free 模型', '浏览、筛选、核验各平台免费与限额模型') +
        quickCard('api', ICON.key, 'API 管理', '记录上游 Base URL 与密钥') +
        quickCard('relay', ICON.layers, '中转规则', '配置外部应用可直接调用的规则') +
        quickCard('routes', ICON.gauge, '上游路由', '同步本地代理 config.json 的路由') +
      '</div></div></section>';

    /* ---- 复合布局：左（调用记录） + 右（分布 / 趋势） ---- */
    var realLogs = proxyOnline ? proxyLogs : [];
    var srcLogs = realLogs.length ? realLogs.slice(0, 8) : DB.logs.slice(0, 8);
    var logRows = srcLogs.map(logRowHtml).join('');
    var logSub = realLogs.length
      ? '真实记录（来自本地代理）'
      : (proxyOnline ? '暂无调用记录' : '代理未运行，暂无真实调用记录');

    var logsPanel = '<section class="panel">' +
      '<div class="panel-head"><div><h2>最近调用</h2><p class="ph-sub">' + esc(logSub) + '</p></div>' +
        '<div class="ph-right"><button class="btn btn-ghost btn-sm" type="button" data-act="log-more">查看全部</button></div></div>' +
      '<div class="panel-body is-flush">' +
        (logRows
          ? '<div class="tbl-wrap" style="border:none;border-radius:0"><table class="tbl">' +
              '<thead><tr><th>时间</th><th>模型</th><th>上游</th><th>状态</th><th>延迟</th><th>Tokens</th></tr></thead>' +
              '<tbody>' + logRows + '</tbody></table></div>'
          : emptyState('暂无调用记录', '代理运行并发起一次请求后，记录会实时出现在这里。', '')) +
      '</div></section>';

    /* 模型调用分布（Top 5） */
    var pairs = Object.keys(stats.byModel).map(function (k) { return [k, stats.byModel[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
    var maxM = pairs.length ? pairs[0][1] : 1;
    var distBody = pairs.length
      ? '<div class="stack-3">' + pairs.map(function (p) {
          var pct = Math.max(4, Math.round(p[1] / maxM * 100));
          return '<div class="dist-row">' +
            '<div class="dist-top">' +
              '<span class="dist-name" title="' + esc(p[0]) + '">' + esc(p[0]) + '</span>' +
              '<span class="dist-n">' + p[1] + ' 次</span>' +
            '</div>' +
            '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '</div>';
        }).join('') + '</div>'
      : emptyState('暂无分布数据', '成功调用后按模型统计用量。', '');

    var distPanel = '<section class="panel">' +
      '<div class="panel-head"><div><h2>模型分布</h2><p class="ph-sub">调用量 Top 5</p></div></div>' +
      '<div class="panel-body">' + distBody + '</div></section>';

    /* 近 7 日趋势 */
    var maxD = 1;
    stats.days.forEach(function (d) { if (d.n > maxD) maxD = d.n; });
    var spark = '<div class="spark">' + stats.days.map(function (d) {
      var h = d.n ? Math.max(6, Math.round(d.n / maxD * 34)) : 4;
      return '<i class="' + (d.n ? '' : 'is-zero') + '" style="height:' + h + 'px" title="' + fmtDate(d.ts) + '：' + d.n + ' 次"></i>';
    }).join('') + '</div>';
    var weekTotal = stats.days.reduce(function (s, d) { return s + d.n; }, 0);

    var trendPanel = '<section class="panel">' +
      '<div class="panel-head"><div><h2>近 7 日趋势</h2><p class="ph-sub">共 ' + weekTotal + ' 次调用</p></div></div>' +
      '<div class="panel-body">' + spark +
        '<div class="cluster justify" style="margin-top:8px;font-size:12px;color:var(--ink-4)">' +
          '<span>' + fmtDate(stats.days[0].ts) + '</span><span>今天</span>' +
        '</div>' +
      '</div></section>';

    var main = '<div class="with-aside">' +
      '<div class="stack">' + logsPanel + '</div>' +
      '<aside class="stack">' + distPanel + trendPanel + '</aside>' +
    '</div>';

    return head + hero +
      '<div class="stack-5 stagger">' + statCards + quick + main + '</div>';
  }

  function quickCard(mod, icon, title, desc) {
    return '<button class="quick-card" type="button" data-act="goto-mod" data-mod="' + mod + '">' +
      '<span class="qc-ico">' + icon + '</span>' +
      '<span class="qc-title">' + esc(title) + '</span>' +
      '<span class="qc-desc">' + esc(desc) + '</span>' +
    '</button>';
  }

  /* 通用空状态（概览页用，紧凑版） */
  function emptyState(title, desc, actions) {
    return '<div class="state-box" style="padding:32px 16px">' +
      '<div class="state-ico empty">' + ICON.empty + '</div>' +
      '<p class="state-title">' + esc(title) + '</p>' +
      '<p class="state-desc">' + esc(desc) + '</p>' +
      (actions ? '<div class="state-act">' + actions + '</div>' : '') +
    '</div>';
  }

  function showAllLogs() {
    var realLogs = proxyOnline ? proxyLogs : [];
    var src = realLogs.length ? realLogs : DB.logs;
    var rows = src.slice(0, 200).map(logRowHtml).join('');
    openModal({
      title: '调用记录',
      sub: (realLogs.length ? '来自本地代理' : '本地演示数据') + '，最多显示 200 条',
      size: 'lg',
      body: rows
        ? '<div class="tbl-wrap"><table class="tbl">' +
            '<thead><tr><th>时间</th><th>模型</th><th>上游</th><th>状态</th><th>延迟</th><th>Tokens</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>'
        : emptyState('暂无调用记录', '代理运行并发起一次请求后，记录会实时出现在这里。', ''),
      buttons: '<button class="btn btn-outline" type="button" data-mact="close">关闭</button>'
    });
  }

  function loadOverviewData() {
    checkProxyStatus();
    pullProxyLogs();
  }

  /* ---------- 模块一：Free 模型（情报目录） ---------- */
  function viewFree() {
    var all = getCatalog();
    var st = effectiveState(all.length);
    var counts = { all: all.length, free: 0, quota: 0, trial: 0, expired: 0 };
    all.forEach(function (c) { if (counts[c.type] != null) counts[c.type]++; });
    // 厂商分类：统计每个厂商的模型数，按数量降序（用于「按厂商」筛选）
    var vendorCounts = {};
    all.forEach(function (c) { var v = c.vendor || '未标注'; vendorCounts[v] = (vendorCounts[v] || 0) + 1; });
    var vendorList = Object.keys(vendorCounts).sort(function (a, b) { return vendorCounts[b] - vendorCounts[a]; });

    var head = '<div class="page-head">' +
      '<div class="ph-text">' +
        '<h1>Free 模型</h1>' +
        '<p>汇总市面主流 AI 网站的免费 / 限额免费 / 限免 / 已过期模型：模型名、厂商、免费额度与适用方向。点「刷新核验」可经本地代理重新抓取并更新（需代理在运行）；下架或转收费的模型会自动移入「过期」。实际调用请自行申请 API 后接入中转站。</p>' +
      '</div>' +
      '<div class="ph-actions">' +
        '<button class="btn btn-outline" type="button" data-act="catalog-refresh">' + ICON.refresh + '刷新核验</button>' +
        '<button class="btn btn-outline" type="button" data-act="catalog-health">' + ICON.gauge + '健康巡检</button>' +
        '<button class="btn btn-outline" type="button" data-act="catalog-import">' + ICON.copy + '导入目录</button>' +
        '<button class="btn btn-primary" type="button" data-act="catalog-add">' + ICON.plus + '新增模型</button>' +
      '</div></div>';

    var strip = proxyStripHtml();
    var panel = genPanel('按场景生成调用配置', '选择关系阶段、描述情境与当前目标，生成一段可直接照抄的配置和调用示例。', 'api');

    var note = '<div class="catalog-note">' +
      ICON.alert +
      '<div><b>官方额度 ≠ 你账户的真实剩余。</b>卡片上的「免费额度」是厂商公开的免费层 / 限额说明，可能随时调整；<b>「我的额度」</b>由你申请后自行填写，用于本地记录。模型名会漂移，请以官网公告为准。</div>' +
      '</div>';

    var vLimit = 10;
    var vShow = freeFilter.vendorOpen ? vendorList : vendorList.slice(0, vLimit);
    var vRest = vendorList.length - vShow.length;

    var filterBar = '<div class="filter-bar">' +
      '<div class="search' + (freeFilter.q ? ' has-value' : '') + '">' + ICON.search +
        '<input class="input" id="catalogSearch" type="text" placeholder="搜索模型名 / 厂商" value="' + esc(freeFilter.q) + '" aria-label="搜索模型">' +
        '<button class="clear" type="button" data-act="catalog-clear-q" aria-label="清除搜索"' + (freeFilter.q ? '' : ' hidden') + '>' + ICON.close + '</button>' +
      '</div>' +
      '<div class="filter-chips">' +
        filterChip('all', '全部', counts.all) +
        filterChip('free', '免费', counts.free) +
        filterChip('quota', '限额', counts.quota) +
        filterChip('trial', '限免', counts.trial) +
        filterChip('expired', '过期', counts.expired) +
      '</div>' +
      '<div class="filter-tools">' +
        '<div class="custom-select" data-act="catalog-sort-wrap" aria-label="排序方式" tabindex="0">' +
          '<button class="custom-select-trigger" type="button" data-act="catalog-sort-trigger">' + esc(SORT_LABEL[curSort()]) + '</button>' +
          '<div class="custom-select-menu" role="listbox" hidden>' +
            '<button type="button" class="custom-select-option' + (curSort() === 'vendor' ? ' is-active' : '') + '" data-act="catalog-sort" data-value="vendor" role="option">按厂商</button>' +
            '<button type="button" class="custom-select-option' + (curSort() === 'name' ? ' is-active' : '') + '" data-act="catalog-sort" data-value="name" role="option">按名称</button>' +
            '<button type="button" class="custom-select-option' + (curSort() === 'type' ? ' is-active' : '') + '" data-act="catalog-sort" data-value="type" role="option">按免费类型</button>' +
          '</div>' +
        '</div>' +
        '<div class="seg" role="group" aria-label="视图切换">' +
          '<button type="button" class="' + (isListView() ? '' : 'is-active') + '" data-act="catalog-view" data-view="grid" data-tip="网格视图" aria-label="网格视图">' + ICON.grid + '</button>' +
          '<button type="button" class="' + (isListView() ? 'is-active' : '') + '" data-act="catalog-view" data-view="list" data-tip="列表视图" aria-label="列表视图">' + ICON.list + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="filter-chips filter-vendors">' +
        '<span class="filter-label">厂商</span>' +
        vendorChip('all', '全部厂商', all.length) +
        vShow.map(function (v) { return vendorChip(v, v, vendorCounts[v]); }).join('') +
        (vRest > 0 ? '<button class="vendor-more" type="button" data-act="catalog-vendor-more">+' + vRest + ' 个厂商</button>' : '') +
        (freeFilter.vendorOpen && vendorList.length > vLimit ? '<button class="vendor-more" type="button" data-act="catalog-vendor-more">收起</button>' : '') +
      '</div>' +
      '<div class="result-count">' + resultCountHtml(all.length) + '</div>' +
    '</div>';

    var s = stateArea({
      state: st,
      emptyTitle: '目录还是空的',
      emptyDesc: '本地目录文件 catalog/models-catalog.json 未加载。可在本机运行 catalog/fetch-catalog.js 重新生成，或用上方「导入目录」加载一份 JSON。',
      emptyAct: '<button class="btn btn-primary" type="button" data-act="catalog-import">' + ICON.copy + '导入目录</button>'
    });
    if (s) return head + strip + panel + note + filterBar + s;

    var listPanel = '<section class="panel">' +
      '<div class="panel-head">' +
        '<div><h2>免费模型目录</h2><p class="ph-sub">共 ' + all.length + ' 条 · ' + esc(SORT_LABEL[curSort()] || '按厂商') + ' · ' + (isListView() ? '列表视图' : '网格视图') + '</p></div>' +
        '<div class="ph-right"><span class="chip chip-warn"><i></i>示例数据，请以官网公告为准</span></div>' +
      '</div>' +
      '<div class="panel-body"><div class="' + (isListView() ? 'list-view stagger' : 'card-grid stagger') + '" id="catalogGrid">' + catalogGridHTML() + '</div></div></section>';

    return head + strip + panel + note + quotaStripHtml() + consumptionPanelHtml() + filterBar + listPanel + intellPanel();
  }

  /* 健康巡检：对目录中 status=已验证 的免费/限额免费型号，经代理逐一直连实测，
     展示当前可用/受阻。复用代理的 x-proxy-token 鉴权与多上游 failover，结果真实反映调用路径。 */
  function upstreamNameOf(c) {
    var m = (c.note || '').match(/上游模型名\s*([^\s；;]+)/);
    if (m) return m[1];
    var p = (c.id || '').split('/');
    return p[p.length - 1];
  }
  function catalogHealth() {
    if (!proxyOnline) { toast('代理未运行，无法健康巡检（需代理在线以走真实调用路径）', 'err'); return; }
    var verified = getCatalog().filter(function (c) { return c.status === STATUS.AVAILABLE; });
    if (!verified.length) { toast('没有已验证的免费型号可巡检', 'err'); return; }
    var items = verified.map(function (c) { return { id: c.id, name: c.name, vendor: c.vendor, model: upstreamNameOf(c) }; });
    ensureRelayToken().then(function (tok) {
      openModal({
        title: '免费型号健康巡检',
        sub: '经代理实测 ' + items.length + ' 个已验证免费型号（上游名取自目录备注）',
        size: 'lg',
        body: '<div id="healthBody" class="health-progress">正在逐个实测…</div>',
        buttons: btn('关闭', 'close')
      });
      runHealth(items, tok);
    }).catch(function (e) { toast('无法获取中转站 Key：' + e.message, 'err'); });
  }
  function runHealth(items, tok) {
    var ok = 0, bad = 0, rows = [];
    var step = function (i) {
      if (i >= items.length) {
        var box = document.getElementById('healthBody');
        if (box) {
          var rest = box.innerHTML.replace(/<div class="health-sum">[\s\S]*?<\/div>/, '');
          box.innerHTML = '<div class="health-sum big">巡检完成：<b class="t-ok">' + ok + ' 可用</b> · <b class="t-bad">' + bad + ' 受阻</b></div>' + rest;
        }
        if (bad > 0) toast('健康巡检：' + bad + ' 个已验证免费型号受阻，建议复跑 verify_drift.js', 'err');
        else toast('健康巡检通过：所有已验证免费型号当前可用', 'ok');
        return;
      }
      var it = items[i];
      fetch(PROXY_V1 + '/chat/completions', {
        method: 'POST',
        headers: mhdr({ 'x-proxy-token': tok }),
        body: JSON.stringify({ model: it.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false })
      })
        .then(function (r) { return { st: r.ok ? 200 : r.status }; })
        .catch(function () { return { st: 'ERR' }; })
        .then(function (res) {
          if (res.st === 200) ok++; else bad++;
          rows.push({ it: it, st: res.st });
          var box = document.getElementById('healthBody');
          if (box) {
            box.innerHTML = '<div class="health-sum">' + (i + 1) + '/' + items.length + ' · 可用 ' + ok + ' · 受阻 ' + bad + '</div>' +
              '<div class="health-list">' + rows.map(function (ro) {
                var cls = ro.st === 200 ? 'ok' : 'bad';
                var ic = ro.st === 200 ? '正常' : '异常';
                return '<div class="health-row ' + cls + '"><span class="h-ic">' + ic + '</span>' +
                  '<span class="h-name">' + esc(ro.it.name) + '</span>' +
                  '<span class="h-ven">' + esc(ro.it.vendor) + '</span>' +
                  '<span class="h-st">' + esc(String(ro.st)) + '</span></div>';
              }).join('') + '</div>';
          }
          step(i + 1);
        });
    };
    step(0);
  }

  /* 情报采集面板：粘贴网页/表格内容，解析后加入本地目录（标为待核实） */
  function intellPanel() {
    return '<section class="panel">' +
      '<div class="panel-head"><div>' +
        '<h2>情报采集</h2><p class="ph-sub">把网页、公告或表格里的免费模型信息粘贴进来，解析后加入本地目录（标为待核实）</p>' +
      '</div></div>' +
      '<div class="panel-body">' +
        '<div class="field">' +
          '<label for="intellText">粘贴内容（支持 Markdown 表格、JSON 数组、或「名称：xxx」格式）</label>' +
          '<textarea class="textarea" id="intellText" placeholder="例如：\n| 模型 | 厂商 | 网站 | 免费额度 | 方向 |\n|------|------|------|----------|------|\n| Qwen2.5 | 阿里云 | bailian.console.aliyun.com | 新用户赠额度 | 语言 |" style="min-height:110px"></textarea>' +
          '<p class="hint">浏览器受 CORS 限制无法直接抓大多数网站，这里提供手动粘贴解析。自动抓取请在本机运行 catalog/fetch-catalog.js。</p>' +
        '</div>' +
        '<div class="gen-foot">' +
          '<span class="gf-note">解析结果加入本地目录，标记为「待核实」，不覆盖已有同名条目</span>' +
          '<span class="gf-right">' +
            '<button class="btn btn-outline" type="button" data-act="intell-clear">清空</button>' +
            '<button class="btn btn-primary" type="button" data-act="intell-parse">' + ICON.bolt + '解析并导入</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* ---------- Free 模块：目录数据 + 卡片渲染（情报层，不依赖网络） ---------- */
  function getCatalog() {
    var base = (window.EMBEDDED_CATALOG || []).slice();
    var user = DB.catalogUser || [];
    var map = {};
    base.forEach(function (m) { if (m && m.id) map[m.id] = m; });
    user.forEach(function (m) { if (m && m.id) map[m.id] = m; });
    var arr = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) arr.push(map[k]);
    arr.sort(function (a, b) { return (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0); });
    return arr;
  }
  function findCatalog(id) {
    var all = getCatalog();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function typeChip(t) {
    if (t === 'quota') return '<span class="chip chip-quota"><i></i>限额免费</span>';
    if (t === 'trial') return '<span class="chip chip-trial"><i></i>限免</span>';
    if (t === 'expired') return '<span class="chip chip-expired"><i></i>已过期</span>';
    return '<span class="chip chip-free"><i></i>免费</span>';
  }
  function isStale(c) {
    if (!c || !c.verifiedAt) return true;
    var d = new Date(c.verifiedAt + 'T00:00:00').getTime();
    return isNaN(d) ? true : (Date.now() - d) > STALE_DAYS * 86400000;
  }
  function daysAgo(c) {
    if (!c || !c.verifiedAt) return '未核验';
    var d = new Date(c.verifiedAt + 'T00:00:00').getTime();
    if (isNaN(d)) return '未核验';
    var days = Math.floor((Date.now() - d) / 86400000);
    if (days <= 0) return '今日核验';
    if (days <= 7) return days + '天前核验';
    return days + '天前核验（信息较旧）';
  }
  function freshnessHtml(c) {
    var stale = isStale(c);
    var cls = stale ? 'fresh-stale' : 'fresh-ok';
    var text = daysAgo(c);
    if (c.expiresAt) {
      var ed = new Date(c.expiresAt + 'T00:00:00').getTime();
      if (!isNaN(ed)) {
        var left = Math.ceil((ed - Date.now()) / 86400000);
        text += left > 0 ? ' · 活动剩 ' + left + ' 天' : ' · 活动已结束';
      }
    }
    return '<span class="fresh-tag ' + cls + '" title="情报来源：' + esc(c.source || '未知') + '">' + esc(text) + '</span>';
  }
  function filterChip(type, label, cnt) {
    var on = freeFilter.type === type ? ' is-on' : '';
    return '<button class="filter-chip' + on + '" type="button" data-act="catalog-filter" data-kind="type" data-type="' + type + '">' + label + '<span class="cnt">' + cnt + '</span></button>';
  }
  // 按厂商筛选的芯片（data-kind=vendor，data-vendor=厂商名）
  function vendorChip(vendor, label, cnt) {
    var on = freeFilter.vendor === vendor ? ' is-on' : '';
    return '<button class="filter-chip' + on + '" type="button" data-act="catalog-filter" data-kind="vendor" data-vendor="' + esc(vendor) + '">' + esc(label) + '<span class="cnt">' + cnt + '</span></button>';
  }
  function catalogGridHTML() {
    var list = sortCatalog(filteredCatalog());
    if (!list.length) return catalogEmpty();
    return isListView() ? list.map(catalogRow).join('') : list.map(catalogCard).join('');
  }

  /* ---------- 模型广场：筛选 / 排序 / 视图 ---------- */
  function filteredCatalog() {
    return getCatalog().filter(function (c) {
      if (freeFilter.type !== 'all' && c.type !== freeFilter.type) return false;
      if (freeFilter.vendor !== 'all' && (c.vendor || '未标注') !== freeFilter.vendor) return false;
      if (freeFilter.q) {
        var q = freeFilter.q.toLowerCase();
        if ((c.name || '').toLowerCase().indexOf(q) < 0 && (c.vendor || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function curSort() { return DB.freeSort || 'vendor'; }
  function isListView() { return DB.freeView === 'list'; }
  function sortCatalog(list) {
    var arr = list.slice(), s = curSort();
    if (s === 'name') {
      arr.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'); });
    } else if (s === 'type') {
      var order = { free: 0, quota: 1, trial: 2, expired: 3 };
      arr.sort(function (a, b) {
        var d = (order[a.type] == null ? 9 : order[a.type]) - (order[b.type] == null ? 9 : order[b.type]);
        return d !== 0 ? d : String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
      });
    }
    return arr; // vendor：getCatalog() 已按厂商排好序，保持原序
  }
  function sortOption(v) {
    return '<option value="' + v + '"' + (curSort() === v ? ' selected' : '') + '>' + esc(SORT_LABEL[v]) + '</option>';
  }
  function resultCountHtml(total) {
    var n = filteredCatalog().length, tips = [];
    if (freeFilter.type !== 'all') tips.push('类型：' + (TYPE_LABEL[freeFilter.type] || freeFilter.type));
    if (freeFilter.vendor !== 'all') tips.push('厂商：' + freeFilter.vendor);
    if (freeFilter.q) tips.push('关键词：' + freeFilter.q);
    if (!tips.length) return '<span>显示 <b>' + n + '</b> / 共 <b>' + total + '</b> 条</span>';
    return '<span>显示 <b>' + n + '</b> / 共 <b>' + total + '</b> 条</span>' +
      '<span class="chip chip-mute">' + esc(tips.join(' · ')) + '</span>' +
      '<button class="btn btn-ghost btn-sm rc-act" type="button" data-act="catalog-clear-filter">清除筛选</button>';
  }
  /* 厂商色块：按名称哈希着色，同一厂商始终同色，零依赖 */
  function vendorIcon(vendor, small) {
    var v = String(vendor || '?'), hue = 0, i;
    for (i = 0; i < v.length; i++) hue = (hue * 31 + v.charCodeAt(i)) % 360;
    var ch = v.replace(/[^A-Za-z0-9一-龥]/g, '').slice(0, 1).toUpperCase() || '?';
    return '<span class="vendor-ico' + (small ? ' sm' : '') + '" style="background:hsl(' + hue +
           ' 62% 94%);color:hsl(' + hue + ' 56% 38%)" aria-hidden="true">' + esc(ch) + '</span>';
  }
  function catalogEmpty() {
    var hasFilter = freeFilter.type !== 'all' || freeFilter.vendor !== 'all' || !!freeFilter.q;
    return '<div class="empty"><div class="empty-ico">' + ICON.empty + '</div>' +
      '<p class="empty-title">' + (hasFilter ? '没有匹配的模型' : '目录还是空的') + '</p>' +
      '<p class="empty-desc">' + (hasFilter ? '换个关键词，或放宽筛选条件试试。' : '用上方「导入目录」加载一份 JSON，或点「新增模型」手动添加。') + '</p>' +
      (hasFilter
        ? '<div class="state-act"><button class="btn btn-outline" type="button" data-act="catalog-clear-filter">清除筛选</button></div>'
        : '<div class="state-act"><button class="btn btn-primary" type="button" data-act="catalog-import">' + ICON.copy + '导入目录</button></div>') +
    '</div>';
  }
  var VENDOR_BASE = {
    '硅基流动': 'https://api.siliconflow.cn/v1',
    '硅基流动 SiliconFlow': 'https://api.siliconflow.cn/v1',
    '阿里百炼': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    '阿里云百炼': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    '智谱 AI': 'https://open.bigmodel.cn/api/paas/v4',
    'DeepSeek': 'https://api.deepseek.com/v1',
    '腾讯混元': 'https://api.hunyuan.cloud.tencent.com/v1',
    '字节豆包': 'https://ark.cn-beijing.volces.com/api/v3',
    '百度文心': 'https://qianfan.baidubce.com/v2',
    'MiniMax': 'https://api.minimax.io/v1',
    'Minimax': 'https://api.minimax.io/v1',
    'Moonshot': 'https://api.moonshot.cn/v1',
    '阶跃星辰': 'https://api.stepfun.com/v1',
    '百川智能': 'https://api.baichuan-ai.com/v1',
    '零一万物': 'https://api.01.ai/v1',
    'Cohere': 'https://api.cohere.com/v1',
    'Google': 'https://generativelanguage.googleapis.com/v1beta',
    'NVIDIA': 'https://integrate.api.nvidia.com/v1',
    'Openrouter': 'https://openrouter.ai/api/v1',
    // OpenRouter aggregated vendors (no public direct OpenAI-compatible endpoint known)
    'Dots-studio': 'https://openrouter.ai/api/v1',
    'Inclusionai': 'https://openrouter.ai/api/v1',
    'Liquid': 'https://openrouter.ai/api/v1',
    'Poolside': 'https://openrouter.ai/api/v1',
    'Thinkingmachines': 'https://openrouter.ai/api/v1',
    'Z-ai': 'https://openrouter.ai/api/v1'
  };
  function isCatalogEnabled(c) {
    // 显式开关优先（用户手动切换过）
    if (DB.catalogEnabled[c.id] !== undefined) return !!DB.catalogEnabled[c.id];
    // 意图识别关闭时：未手动设置默认不启用，避免「全选」歧义
    // （关闭意图识别只允许单选，第一个启用模型在 init 时初始化）
    if (!DB.settings.intent) return false;
    // 意图识别开启时：默认启用所有非过期模型
    return c.type !== 'expired';
  }
  function switchHTML(c) {
    var on = isCatalogEnabled(c);
    return '<label class="switch" title="启用 / 停用该模型">' +
      '<input type="checkbox" data-act="catalog-toggle" data-id="' + esc(c.id) + '"' + (on ? ' checked' : '') + '>' +
      '<span class="slider"></span></label>';
  }
  function keyBadge(vendor) {
    return DB.catalogVendorKey[vendor] ? '<span class="chip chip-ok-mini">已配Key</span>' : '';
  }
  function fmtNum(n) {
    if (n == null) return '—';
    if (typeof n === 'number') return n.toLocaleString();
    return String(n);
  }
  function quotaText(c) {
    var pq = proxyQuota[c.id];
    if (pq && (pq.tokens != null || pq.requests != null)) {
      var parts = [];
      if (pq.tokens != null) parts.push('Tokens ' + fmtNum(pq.tokens));
      if (pq.requests != null) parts.push('Requests ' + fmtNum(pq.requests));
      return { has: true, text: parts.join(' · '), pct: (pq.pct != null ? pq.pct : null), at: pq.updatedAt };
    }
    return { has: false, text: '未配置 Key，代理无法自动读取', pct: null, at: 0 };
  }
  function quotaBar(q) {
    if (q.pct == null) return '';
    var pct = Math.max(2, Math.min(100, Math.round(q.pct)));
    var tone = pct < 20 ? ' err' : (pct < 50 ? ' warn' : ' ok');
    return '<div class="mc-bar"><div class="mc-bar-top"><span>剩余额度</span><b>' + pct + '%</b></div>' +
      '<div class="bar' + tone + '"><i style="width:' + pct + '%"></i></div></div>';
  }
  /* 网格视图：信息密度高的一张卡 */
  function catalogCard(c) {
    var isUser = DB.catalogUser.some(function (x) { return x.id === c.id; });
    var q = quotaText(c);
    var remainHtml = q.has
      ? esc(q.text) + (q.at ? ' <span class="t-sub">（' + esc(fmtDate(q.at)) + '）</span>' : '')
      : '<span class="t-sub">' + esc(q.text) + '</span>';
    var meta = '<div class="mc-meta">' +
      (c.verifiedAt ? '<span>核验 ' + esc(c.verifiedAt) + '</span>' : '') +
      (c.sourceUrl ? '<a href="' + esc(c.sourceUrl) + '" target="_blank" rel="noopener">来源</a>' : '') +
      (c.contextWindow ? '<span>上下文 ' + esc(c.contextWindow) + '</span>' : '') +
      (c.source ? '<span>来源：' + esc(c.source) + '</span>' : '') +
    '</div>';
    var foot = '<div class="mc-foot">' +
      '<div class="mc-foot-left">' +
        '<button class="btn btn-outline btn-sm" type="button" data-act="catalog-copy" data-id="' + esc(c.id) + '">' + ICON.copy + '复制ID</button>' +
        (c.applyUrl ? '<button class="btn btn-outline btn-sm" type="button" data-act="catalog-apply" data-id="' + esc(c.id) + '">' + ICON.external + '申请</button>' : '') +
        '<button class="btn btn-outline btn-sm" type="button" data-act="catalog-key" data-id="' + esc(c.id) + '">' + ICON.key + '配置Key</button>' +
        (isUser ? '<button class="btn btn-danger btn-sm" type="button" data-act="catalog-del" data-id="' + esc(c.id) + '">' + ICON.trash + '</button>' : '') +
      '</div>' +
      '<button class="btn btn-primary btn-sm" type="button" data-act="catalog-toApi" data-id="' + esc(c.id) + '">去接入</button>' +
    '</div>';
    return '<article class="mcard' + (isCatalogEnabled(c) ? '' : ' is-off') + '">' +
      '<div class="mc-top">' +
        vendorIcon(c.vendor) +
        '<div class="mc-id">' +
          '<div class="mc-name">' + esc(c.name) + '</div>' +
          '<div class="mc-vendor">' + esc(c.vendor) + ' ' + keyBadge(c.vendor) + '</div>' +
        '</div>' +
        '<div class="mc-top-actions">' + switchHTML(c) + '</div>' +
      '</div>' +
      '<div class="mc-tags">' + typeChip(c.type) + statusChip(c.status) + scopeTags(c.modality) + freshnessHtml(c) + '</div>' +
      '<div class="mc-rows">' +
        '<dl class="mc-row"><dt>免费额度</dt><dd>' + esc(c.quota || '待核实') + '</dd></dl>' +
        '<dl class="mc-row"><dt>剩余额度</dt><dd>' + remainHtml + '</dd></dl>' +
        '<dl class="mc-row"><dt>Token 余额</dt><dd>' + tokenBalanceHtml(c) + '</dd></dl>' +
      '</div>' +
      quotaBar(q) +
      (c.note ? '<p class="hint" style="margin-top:10px;color:var(--ink-3);font-size:12.5px">' + esc(c.note) + '</p>' : '') +
      meta + foot +
    '</article>';
  }
  /* 列表视图：一行一个模型，扫读效率优先 */
  function catalogRow(c) {
    var q = quotaText(c);
    var bits = [esc(c.vendor), (c.modality || []).join(' / '), esc(c.quota || '待核实')].filter(Boolean);
    return '<div class="mrow' + (isCatalogEnabled(c) ? '' : ' is-off') + '">' +
      vendorIcon(c.vendor, true) +
      '<div class="mrow-main">' +
        '<div class="mrow-name">' +
          '<span class="t">' + esc(c.name) + '</span>' +
          typeChip(c.type) +
          statusChip(c.status) +
          freshnessHtml(c) +
          (DB.catalogVendorKey[c.vendor] ? '<span class="chip chip-ok-mini">已配Key</span>' : '') +
        '</div>' +
        '<div class="mrow-sub">' + bits.join('<span class="sep">·</span>') + '</div>' +
      '</div>' +
      '<div class="mrow-quota">' + tokenBalanceHtml(c) + (q.has ? '<div class="rq">' + esc(q.text) + '</div>' : '') + '</div>' +
      '<div class="mrow-act">' +
        '<button class="btn btn-outline btn-sm" type="button" data-act="catalog-copy" data-id="' + esc(c.id) + '">' + ICON.copy + 'ID</button>' +
        (c.applyUrl ? '<button class="btn btn-outline btn-sm" type="button" data-act="catalog-apply" data-id="' + esc(c.id) + '">' + ICON.external + '</button>' : '') +
        '<button class="btn btn-primary btn-sm" type="button" data-act="catalog-toApi" data-id="' + esc(c.id) + '">接入</button>' +
        switchHTML(c) +
      '</div>' +
    '</div>';
  }

  function refreshCatalogGrid() {
    var g = document.getElementById('catalogGrid');
    if (g) {
      g.className = isListView() ? 'list-view' : 'card-grid';
      g.innerHTML = catalogGridHTML();
    }
    var rc = document.querySelector('#content .result-count');
    if (rc) rc.innerHTML = resultCountHtml(getCatalog().length);
  }
  function updateFilterChips() {
    var chips = document.querySelectorAll('#content .filter-chip');
    for (var i = 0; i < chips.length; i++) {
      var kind = chips[i].getAttribute('data-kind');
      if (kind === 'vendor') chips[i].classList.toggle('is-on', chips[i].getAttribute('data-vendor') === freeFilter.vendor);
      else chips[i].classList.toggle('is-on', chips[i].getAttribute('data-type') === freeFilter.type);
    }
  }
  function toggleCatalogSortMenu(btn) {
    var wrap = btn && btn.closest ? btn.closest('.custom-select') : null;
    if (!wrap) return;
    var menu = wrap.querySelector('.custom-select-menu');
    var isOpen = menu && !menu.hidden;
    closeAllCatalogSortMenus();
    if (menu && isOpen) { menu.hidden = true; wrap.classList.remove('is-open'); }
    else if (menu) { menu.hidden = false; wrap.classList.add('is-open'); }
  }
  function closeAllCatalogSortMenus() {
    document.querySelectorAll('.custom-select').forEach(function (w) {
      var m = w.querySelector('.custom-select-menu'); if (m) m.hidden = true; w.classList.remove('is-open');
    });
  }
  function catalogEnabledIds() {
    return getCatalog().filter(function (c) { return isCatalogEnabled(c); }).map(function (c) { return c.id; });
  }
  function pullQuota() {
    fetch(PROXY_V1 + '/quota', { method: 'GET', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error('代理返回失败');
        proxyQuota = j.quota || {};
        proxyVendorBalances = j.vendorBalances || [];
        proxyModelQuota = j.modelQuota || {};
        proxyModelUsage = j.modelUsage || {};
        proxyThresholdAlerts = j.thresholdAlerts || { models: [], vendors: [], count: 0, hasCrit: false, hasWarn: false };
        proxyQuotaAt = j.fetchedAt || Date.now();
        if (DB.module === 'free') { refreshCatalogGrid(); renderVendorBalanceBar(); pullConsumption(); }
      })
      .catch(function () { proxyQuota = {}; });
  }
  function pullConsumption() {
    if (!proxyOnline) return;
    fetch(PROXY_V1 + '/quota/usage?days=14', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { proxyConsumption = j; if (DB.module === 'free') renderConsumptionPanel(); })
      .catch(function () { /* 代理未运行或日志模块关闭，静默 */ });
  }
  function renderConsumptionPanel() {
    var el = document.getElementById('consumptionBody');
    if (el) el.innerHTML = consumptionBodyHtml();
  }
  // 页面驱动调度：开页即拉一次；开着期间每 30min 轮询；每日 2:00 触发目录刷新（仅开页时）
  function ensureQuotaSchedule() {
    if (quotaSchedStarted) return;
    quotaSchedStarted = true;
    pullQuota();
    setInterval(function () { if (proxyOnline) pullQuota(); }, 30 * 60 * 1000);
    scheduleDailyCatalogRefresh();
  }
  function scheduleDailyCatalogRefresh() {
    var now = new Date();
    var next = new Date(now); next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(function () {
      if (proxyOnline) catalogRefresh();
      scheduleDailyCatalogRefresh();
    }, next - now);
  }
  function quotaStripHtml() {
    var parts = [];
    if (proxyVendorBalances && proxyVendorBalances.length) {
      proxyVendorBalances.forEach(function (b) {
        var dot = '';
        if (b.alert && b.alert.level === 'crit') dot = ' <span class="al-dot al-crit" title="' + esc(b.alert.reason || '') + '"></span>';
        else if (b.alert && b.alert.level === 'warn') dot = ' <span class="al-dot al-warn" title="' + esc(b.alert.reason || '') + '"></span>';
        if (b.error) parts.push('<span class="vb vb-err" title="' + esc(b.error) + '">' + esc(b.vendor) + '：读取失败' + dot + '</span>');
        else parts.push('<span class="vb">💰 ' + esc(b.vendor) + ' 余额 ¥' + fmtNum(Math.round((b.balance || 0) * 100) / 100) + dot + '</span>');
      });
    }
    var alertParts = [];
    if (proxyThresholdAlerts && proxyThresholdAlerts.count) {
      if (proxyThresholdAlerts.hasCrit) alertParts.push('<button class="al-chip al-crit" type="button" data-act="quota-alert-jump" title="查看额度告警明细">⚠ ' + proxyThresholdAlerts.count + ' 项额度告急</button>');
      else if (proxyThresholdAlerts.hasWarn) alertParts.push('<button class="al-chip al-warn" type="button" data-act="quota-alert-jump" title="查看额度告警明细">⚠ ' + proxyThresholdAlerts.count + ' 项额度偏低</button>');
    }
    var meta = [];
    if (catalogUpdatedAt) meta.push('目录 ' + esc(catalogUpdatedAt));
    if (proxyQuotaAt) meta.push('用量 ' + esc(fmtDate(proxyQuotaAt)));
    return '<div class="quota-strip" id="vendorBalanceBar">' +
      (parts.length ? parts.join('') : '<span class="vb vb-empty">厂商余额：未配置 Key 或未上线</span>') +
      (alertParts.length ? '<span class="vb-sep"></span>' + alertParts.join('') : '') +
      (meta.length ? '<span class="vb-sep"></span><span class="vb-meta">' + meta.join(' · ') + '</span>' : '') +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="quota-refresh">' + ICON.refresh + '刷新配额</button>' +
      '</div>';
  }
  function renderVendorBalanceBar() {
    var el = document.getElementById('vendorBalanceBar');
    if (el) el.outerHTML = quotaStripHtml();
  }
  function showThresholdAlerts() {
    var a = proxyThresholdAlerts || { models: [], vendors: [], count: 0 };
    if (!a.count) { toast('当前没有额度告警', 'ok'); return; }
    var rows = [];
    a.models.forEach(function (m) {
      rows.push('<tr><td>' + esc(m.id) + '</td><td><span class="al-badge ' + (m.level === 'crit' ? 'al-crit' : 'al-warn') + '">' + (m.level === 'crit' ? '告急' : '偏低') + '</span></td><td>' + esc(m.reason || '') + '</td></tr>');
    });
    a.vendors.forEach(function (v) {
      rows.push('<tr><td>' + esc(v.vendor) + '</td><td><span class="al-badge ' + (v.level === 'crit' ? 'al-crit' : 'al-warn') + '">' + (v.level === 'crit' ? '告急' : '偏低') + '</span></td><td>' + esc(v.reason || '') + '</td></tr>');
    });
    var cfg = a.cfg || {};
    openModal({
      title: '额度不足告警（' + a.count + ' 项）',
      sub: '告警阈值：剩余比例 提醒 ' + (cfg.warnPct != null ? cfg.warnPct : 20) + '% / 告急 ' + (cfg.critPct != null ? cfg.critPct : 5) + '% · 厂商余额 提醒 ¥' + (cfg.vendorWarnCny != null ? cfg.vendorWarnCny : 5) + ' / 告急 ¥' + (cfg.vendorCritCny != null ? cfg.vendorCritCny : 1) + '（可在 config.json 的 quotaAlert 调整）',
      size: 'lg',
      body: '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>模型 / 厂商</th><th>级别</th><th>说明</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>',
      buttons: '<button class="btn btn-outline" type="button" data-mact="close">关闭</button>'
    });
  }
  /* ---------- 额度消耗分析面板（零依赖 CSS 条形图） ---------- */
  function consumptionPanelHtml() {
    var days = proxyConsumption && proxyConsumption.days ? proxyConsumption.days : 14;
    return '<section class="panel" id="consumptionPanel">' +
      '<div class="panel-head"><div><h2>额度消耗分析</h2><p class="ph-sub">近 ' + days + ' 天 · 来自本机请求日志（SQLite）</p></div>' +
      '<div class="ph-right"><button class="btn btn-ghost btn-sm" type="button" data-act="consumption-refresh">' + ICON.refresh + '刷新</button></div></div>' +
      '<div class="panel-body" id="consumptionBody">' + consumptionBodyHtml() + '</div></section>';
  }
  function consStat(label, val, tone) {
    return '<div class="cons-stat">' +
      (tone ? '<span class="cons-stat-tone tone-' + tone + '"></span>' : '') +
      '<div class="cons-stat-val">' + esc(val) + '</div><div class="cons-stat-label">' + esc(label) + '</div></div>';
  }
  function hbarHtml(label, value, max, tone, requests, rl, err, extraTok) {
    var pct = max > 0 ? Math.max(2, Math.round(value / max * 100)) : 0;
    var sub = [];
    if (requests != null) sub.push(fmtNum(requests) + ' 次');
    if (rl) sub.push('<span class="t-rl">429 ' + rl + '</span>');
    if (err) sub.push('<span class="t-err">错误 ' + err + '</span>');
    if (extraTok != null) sub.push(fmtNum(extraTok) + ' tok');
    return '<div class="hbar-row"><div class="hbar-label" title="' + esc(label) + '">' + esc(label) + '</div>' +
      '<div class="hbar-track"><div class="hbar-bar tone-' + (tone || 'ok') + '" style="width:' + pct + '%"></div></div>' +
      '<div class="hbar-val">' + fmtNum(value) + (sub.length ? ' <span class="hbar-sub">' + sub.join(' · ') + '</span>' : '') + '</div></div>';
  }
  function dayTrendHtml(days) {
    if (!days.length) return '<div class="t-sub">无</div>';
    var max = days.reduce(function (m, x) { return Math.max(m, x.tokens || 0); }, 0);
    var bars = days.map(function (x) {
      var pct = max > 0 ? Math.max(3, Math.round((x.tokens || 0) / max * 100)) : 0;
      return '<div class="vbar" style="height:' + pct + '%" title="' + esc(x.day) + '：' + fmtNum(x.tokens || 0) + ' tok / ' + fmtNum(x.requests || 0) + ' 次"><span>' + fmtNum(x.tokens || 0) + '</span></div>';
    }).join('');
    var labels = days.map(function (x) { return '<span class="vbar-label">' + esc(x.day.slice(5)) + '</span>'; }).join('');
    return '<div class="vbar-chart">' + bars + '</div><div class="vbar-labels">' + labels + '</div>';
  }
  function consumptionBodyHtml() {
    var c = proxyConsumption;
    if (!c) return '<div class="loading-row">加载中…</div>';
    if (c.disabled) return emptyState('日志模块未启用', 'better-sqlite3 不可用，消耗分析已关闭（不影响转发）。', '');
    var t = c.totals || {};
    var reqs = t.requests || 0;
    if (!reqs) return emptyState('近 ' + (c.days || 14) + ' 天暂无调用记录', '经代理发起请求后，这里会显示按模型 / 厂商 / 日期的消耗分布。', '');
    var successRate = reqs ? Math.round((t.success || 0) / reqs * 1000) / 10 : 0;
    var rlRate = reqs ? Math.round((t.rateLimited || 0) / reqs * 1000) / 10 : 0;
    var sum = '<div class="cons-stats">' +
      consStat('总请求', fmtNum(reqs)) +
      consStat('总 Token', fmtNum(t.tokens || 0)) +
      consStat('成功率', successRate + '%', successRate < 90 ? 'warn' : 'ok') +
      consStat('429 限流率', rlRate + '%', rlRate > 5 ? 'warn' : 'ok') +
      consStat('平均延迟', fmtNum(t.avgLatency || 0) + ' ms') +
      '</div>';
    var byModel = (c.byModel || []).slice(0, 8);
    var modelMax = byModel.reduce(function (m, x) { return Math.max(m, x.tokens || 0); }, 0);
    var modelBars = byModel.length ? byModel.map(function (x) {
      return hbarHtml(x.model, x.tokens || 0, modelMax, 'ok', x.requests || 0, x.rateLimited || 0, x.errors || 0);
    }).join('') : '<div class="t-sub">无</div>';
    var byVendor = (c.byVendor || []).slice(0, 8);
    var vendorMax = byVendor.reduce(function (m, x) { return Math.max(m, x.requests || 0); }, 0);
    var vendorBars = byVendor.length ? byVendor.map(function (x) {
      return hbarHtml(x.vendor, x.requests || 0, vendorMax, 'info', null, null, null, x.tokens || 0);
    }).join('') : '<div class="t-sub">无</div>';
    var dayBars = dayTrendHtml(c.byDay || []);
    return sum +
      '<div class="cons-cols">' +
        '<div class="cons-col"><h3>按模型 · Token 消耗（Top 8）</h3>' + modelBars + '</div>' +
        '<div class="cons-col"><h3>按厂商 · 请求数</h3>' + vendorBars + '</div>' +
      '</div>' +
      '<div class="cons-col cons-day"><h3>近 ' + (c.days || 14) + ' 天 · 每日 Token 趋势</h3>' + dayBars + '</div>';
  }
  function tokenBalanceHtml(c) {
    if (c && c.type === 'paid') return '<span class="t-sub">付费模型（不计入免费余额）</span>';
    var mq = proxyModelQuota[c.id];
    if (mq && mq.hasQuota) {
      var pct = Math.max(0, Math.min(100, Math.round(mq.remaining / mq.freeQuota * 100)));
      var badge = '';
      if (mq.alert && mq.alert.level === 'crit') badge = '<span class="al-badge al-crit" title="' + esc(mq.alert.reason || '') + '">⚠ 告急</span> ';
      else if (mq.alert && mq.alert.level === 'warn') badge = '<span class="al-badge al-warn" title="' + esc(mq.alert.reason || '') + '">⚠ 偏低</span> ';
      return badge + '剩余 ' + fmtNum(mq.remaining) + ' / ' + fmtNum(mq.freeQuota) + '（已用 ' + fmtNum(mq.used) + '）' + tokenBar(pct);
    }
    if (mq && mq.used > 0) return '已用 ' + fmtNum(mq.used) + ' tokens（按厂商限流，无公开上限）';
    return '<span class="t-sub">按厂商限流 / 暂无额度数据</span>';
  }
  function tokenBar(pct) {
    var tone = pct < 20 ? ' err' : (pct < 50 ? ' warn' : ' ok');
    return '<div class="mc-bar"><div class="bar' + tone + '"><i style="width:' + pct + '%"></i></div></div>';
  }
  // 把「已选中(开启)模型」同步到代理的 enabled-models.json（意图识别只读这个文档，不读 config 全量）
  function pushEnabledToProxy() {
    var ids = catalogEnabledIds();
    fetch(PROXY_V1 + '/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: ids }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j.ok) console.log('[free-api] 已同步 ' + (j.count || ids.length) + ' 个已开启模型到代理'); })
      .catch(function () { /* 代理未运行则静默，下次探测上线会补推 */ });
  }
  function catalogRefresh() {
    // 刷新实时目录必须代理或本机脚本；纯静态目录浏览不需要代理
    if (!proxyOnline) {
      toast('代理未运行，无法在线刷新。可本机运行 catalog/fetch-catalog.js，完成后刷新页面。', 'err');
      return;
    }
    toast('正在通过本地代理重新抓取目录…', 'ok');
    fetch(PROXY_V1 + '/catalog/refresh', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error('代理返回失败');
        window.EMBEDDED_CATALOG = j.models || [];
        catalogUpdatedAt = j.updatedAt || '';
        refreshAll();
        var chg = [];
        if (j.added) chg.push('新增 ' + j.added);
        if (j.expired) chg.push('过期 ' + j.expired);
        if (j.changed) chg.push('变更 ' + j.changed);
        toast('目录已更新：共 ' + (j.models || []).length + ' 条' + (chg.length ? '（' + chg.join(' / ') + '）' : '') + '（见「过期」筛选）', 'ok');
        // 目录刷新后，自动把免费/限额模型同步到上游路由，保持 /v1/auto 候选集最新
        setTimeout(function () { syncCatalogToRoutes(); }, 200);
      })
      .catch(function (e) {
        toast('抓取失败：' + e.message + '。可尝试本机运行 catalog/fetch-catalog.js', 'err');
      });
  }
  function catalogToApi(id) {
    var c = findCatalog(id);
    if (!c) return;
    pendingApiPrefill = { vendor: c.vendor, baseUrl: c.vendorSite || '' };
    switchModule('api');
    modalApi(null);
  }

  /* ---------- 中转站：意图识别 + 中转站 Key ---------- */
  // 开关意图识别（内容区与设置弹窗共用）
  function setIntentIntent(on) {
    if (DB.settings.intent === on) { toast(on ? '意图识别已处于开启' : '意图识别已处于关闭'); return; }
    DB.settings.intent = on; save();
    toast(on ? '已开启意图识别（调用走本地代理自动选模型）' : '已关闭意图识别（只允许启用一个模型）');
    if (on) { pushEnabledToProxy(); pullQuota(); }
    else {
      // 关闭意图识别：强制单选，只保留当前第一个已启用模型
      var enabled = catalogEnabledIds();
      if (enabled.length > 1) {
        var keep = enabled[0];
        getCatalog().forEach(function (c) { DB.catalogEnabled[c.id] = (c.id === keep); });
        save();
        toast('已关闭意图识别，仅保留「' + esc(findCatalog(keep).name) + '」为启用模型', 'ok');
      } else if (enabled.length === 0) {
        // 没有显式启用时，自动启用第一个非过期模型，避免页面全灰
        var first = getCatalog().find(function (c) { return c.type !== 'expired'; });
        if (first) { DB.catalogEnabled[first.id] = true; save(); }
      }
    }
    refreshAll();
  }
  // 生成中转站 Key（代理已有的 config.token 机制）
  function genRelayToken() {
    fetch(PROXY_V1 + '/token/generate', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.token) throw new Error('代理未返回 token');
        DB.relayToken = j.token; save();
        var el = document.getElementById('relayToken');
        if (el) el.textContent = j.token;
        var cp = document.querySelector('[data-mact="relay-token-copy"]');
        if (cp) cp.removeAttribute('disabled');
        toast('已生成中转站 Key 并保存到本机', 'ok');
      })
      .catch(function (e) { toast('生成失败（代理未运行？）：' + e.message, 'err'); });
  }
  function copyRelayToken() {
    if (!DB.relayToken) { toast('请先生成中转站 Key', 'err'); return; }
    copyText(DB.relayToken, '已复制中转站 Key');
  }
  // 试用意图识别：把已启用模型列表发给代理 /v1/auto，由分类模型挑选
  function tryIntent() {
    var ta = document.getElementById('intentPrompt');
    var text = ta ? ta.value.trim() : '';
    if (!text) { toast('请输入要发送的内容', 'err'); return; }
    if (!DB.settings.intent) { toast('请先在上方开启意图识别', 'err'); return; }
    if (!DB.proxyMasterToken && !DB.relayToken) { toast('请先在设置里配置主控 Key（代理已启用鉴权）', 'err'); return; }
    var ids = catalogEnabledIds();
    if (!ids.length) { toast('没有已启用的模型，请先到 Free 模型模块启用', 'err'); return; }
    var res = document.getElementById('intentResult');
    if (res) res.innerHTML = '<span class="chip chip-warn"><i></i>请求中…</span>';
    var body = { model: 'auto', messages: [{ role: 'user', content: text }], stream: false, models: ids };
    var headers = mhdr();
    if (DB.proxyMasterToken) headers['x-proxy-token'] = DB.proxyMasterToken; else if (DB.relayToken) headers['x-proxy-token'] = DB.relayToken;
    fetch(PROXY_V1 + '/auto/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var chosen = (j && j.model) ? j.model : '?';
        var msg = (j && j.choices && j.choices[0] && j.choices[0].message) ? j.choices[0].message.content : '';
        if (!msg && j && j.error) msg = '错误：' + (j.error.message || JSON.stringify(j.error));
        if (res) res.innerHTML = '<div class="intent-chosen">代理选择模型：<b>' + esc(chosen) + '</b></div>' +
          '<pre class="intent-reply">' + (msg ? esc(String(msg)) : '(空回复)') + '</pre>';
      })
      .catch(function (e) {
        if (res) res.innerHTML = '<span class="chip chip-err"><i></i>' + esc(e.message) + '</span>';
        toast('意图识别调用失败（代理未运行或 Key 不匹配？）', 'err');
      });
  }
  function classifierOptionsHtml() {
    var free = getCatalog().filter(function (c) { return c.type === 'free'; });
    return free.map(function (c) {
      var sel = (c.id === proxyClassifier) ? ' selected' : '';
      return '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.id) + ' · ' + esc(c.name) + '</option>';
    }).join('');
  }
  function modalRelayStation() {
    var on = DB.settings.intent;
    var tokenTxt = DB.relayToken ? DB.relayToken : '尚未生成';
    var enabledN = catalogEnabledIds().length;
    var appRows = appTokens.map(function (t) {
      return '<div class="apptoken-row">' +
        '<div class="at-main"><b>' + esc(t.name) + '</b> <span class="mono">' + esc(t.keyMask) + '</span>' +
          (t.enabled ? '' : ' <span class="chip chip-expired"><i></i>已停用</span>') +
          (t.lastUsed ? ' <span class="hint">最近使用 ' + esc(fmtFull(new Date(t.lastUsed).getTime())) + '</span>' : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-mact="app-token-copy" data-id="' + esc(t.id) + '">' + ICON.copy + '复制</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-mact="app-token-toggle" data-id="' + esc(t.id) + '">' + (t.enabled ? '停用' : '启用') + '</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-mact="app-token-rename" data-id="' + esc(t.id) + '">' + ICON.edit + '改名</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-mact="app-token-del" data-id="' + esc(t.id) + '">' + ICON.trash + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
    var body =
      '<section class="panel">' +
        '<div class="panel-head"><div><h2>意图识别 · 中转站 Key</h2><p class="ph-sub">本地代理按额度与难度自动选模型，并对外发放配对 Key</p></div></div>' +
        '<div class="panel-body">' +
          '<div class="intent-row">' +
            '<span class="intent-state">意图识别：<b>' + (on ? '已开启' : '已关闭') + '</b></span>' +
            '<button class="btn btn-' + (on ? 'outline' : 'primary') + ' btn-sm" type="button" data-mact="intent-toggle">' + (on ? '关闭' : '开启') + '意图识别</button>' +
            '<span class="intent-state">已启用模型 <b>' + enabledN + '</b> 个</span>' +
            (proxyOnline ? '<span class="intent-state">代理已记录 <b>' + enabledCount + '</b> 个</span>' : '') +
          '</div>' +
          (on ? '' : '<p class="hint" style="margin:-4px 0 14px">关闭时只允许启用一个模型（避免歧义）；开启后由代理从已启用模型里自动挑。</p>') +
          '<div class="intent-token">' +
            '<div class="ro-label">中转站主控 Key（外部 AI 应用配对 / 管理端点用）</div>' +
            '<div class="token-display">' +
              '<code id="relayToken">' + esc(tokenTxt) + '</code>' +
              '<button class="btn btn-outline btn-sm" type="button" data-mact="relay-token-gen">' + ICON.refresh + '生成</button>' +
              '<button class="btn btn-ghost btn-sm" type="button" data-mact="relay-token-copy"' + (DB.relayToken ? '' : ' disabled') + '>' + ICON.copy + '复制</button>' +
            '</div>' +
            '<p class="hint" style="margin-top:8px">外部 AI 应用填 <code>BaseURL = ' + esc(PROXY_V1) + '</code> 并填此 Key 即可配对调用。Key 同时保存在本机，供本页「试用」调用。</p>' +
            '<p class="hint" style="margin-top:6px;color:var(--warn)">注意：部分客户端（如 LobsterAI / CherryStudio）的「测试连接」只访问 <code>/v1/models</code>，该端点无需密钥也会返回成功；实际对话必须填对上述主控 Key 或任意应用 Key，否则会出现 timeout / Connection error。</p>' +
          '</div>' +
          '<div class="intent-try">' +
            '<label class="ro-label">试用（自动选模型）</label>' +
            '<textarea id="intentPrompt" class="input" placeholder="输入一段需求，代理会按额度/难度自动挑选已启用模型并回复…"></textarea>' +
            '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" type="button" data-mact="intent-try">' + ICON.bolt + '发送（自动选模型）</button></div>' +
            '<div id="intentResult" class="intent-result"></div>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<section class="panel">' +
        '<div class="panel-head"><div><h2>应用 Key 管理</h2><p class="ph-sub">为每个外部 AI 应用生成独立 Key，可单独停用 / 撤销</p></div></div>' +
        '<div class="panel-body">' +
          (appTokens.length
            ? '<div class="apptoken-list">' + appRows + '</div>'
            : '<p class="hint">还没有应用 Key。点「新增应用 Key」为 CherryStudio / NextChat 等生成一个独立配对 Key。</p>') +
          '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" type="button" data-mact="app-token-new">' + ICON.plus + '新增应用 Key</button></div>' +
          '<p class="hint" style="margin-top:8px">应用 Key 仅用于 <code>chat/completions</code> 与 <code>auto/chat/completions</code> 调用；主控 Key 用于管理端点与「试用」。两者都在本机 <code>config.json</code>。代理未运行时此处为空。</p>' +
        '</div>' +
      '</section>' +
      '<section class="panel">' +
        '<div class="panel-head"><div><h2>分类模型（意图识别）</h2><p class="ph-sub">选哪个模型做意图分类；不设则用难度评分兜底</p></div></div>' +
        '<div class="panel-body">' +
          '<div class="intent-row">' +
            '<select id="classifierSel" class="input" style="max-width:380px">' +
              '<option value="">（不使用分类模型，按难度评分兜底）</option>' + classifierOptionsHtml() +
            '</select>' +
            '<button class="btn btn-primary btn-sm" type="button" data-mact="classifier-set">设为分类器</button>' +
          '</div>' +
          '<p class="hint" style="margin-top:8px">当前分类模型：<b>' + esc(proxyClassifier || '未设置（评分兜底）') + '</b></p>' +
          '<div class="intent-try" style="margin-top:6px">' +
            '<label class="ro-label">测试选模型</label>' +
            '<textarea id="classifierTest" class="input" placeholder="输入一句需求，看代理会挑哪个模型（需开启意图识别并启用模型）"></textarea>' +
            '<div style="margin-top:8px"><button class="btn btn-outline btn-sm" type="button" data-mact="classifier-test">' + ICON.bolt + '测试选模型</button></div>' +
            '<div id="classifierResult" class="intent-result"></div>' +
          '</div>' +
        '</div>' +
      '</section>';
    openModal({ title: '中转站配置', sub: '意图识别、主控 Key 与应用 Key 管理', size: 'lg', body: body, buttons: btn('关闭', 'close', 'btn-primary') });
  }

  function newAppToken() {
    if (!proxyOnline) { toast('代理未运行，无法生成应用 Key', 'err'); return; }
    var name = window.prompt('给这个应用 Key 起个名字（如 CherryStudio / NextChat）', '新应用');
    if (name === null) return;
    fetch(PROXY_V1 + '/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name: name }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.token) throw new Error('代理未返回');
        appTokenRaw[j.token.id] = j.rawKey;
        pullAppTokens();
        copyText(j.rawKey, '已生成并复制应用 Key：' + j.token.name);
      })
      .catch(function (e) { toast('生成失败：' + e.message, 'err'); });
  }
  function copyAppToken(id) {
    if (appTokenRaw[id]) { copyText(appTokenRaw[id], '已复制应用 Key'); return; }
    toast('明文 Key 仅在生成时可见，请重新生成该 Key 以复制', 'err');
  }
  function toggleAppToken(id) {
    fetch(PROXY_V1 + '/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle', id: id }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j.ok) pullAppTokens(); })
      .catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }
  function renameAppToken(id) {
    var cur = (appTokens.find(function (t) { return t.id === id; }) || {}).name || '';
    var name = window.prompt('修改应用 Key 名称', cur);
    if (name === null) return;
    fetch(PROXY_V1 + '/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', id: id, name: name }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j.ok) pullAppTokens(); })
      .catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }
  function delAppToken(id) {
    if (DB.settings.confirmDelete && !window.confirm('确定撤销该应用 Key？撤销后对应 AI 应用将无法调用。')) return;
    fetch(PROXY_V1 + '/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: id }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j.ok) { delete appTokenRaw[id]; pullAppTokens(); toast('已撤销应用 Key', 'ok'); } })
      .catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }
  function setClassifier() {
    var sel = document.getElementById('classifierSel');
    if (!sel) return;
    var model = sel.value;
    fetch(PROXY_V1 + '/classifier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { proxyClassifier = j.classifier || ''; toast(proxyClassifier ? '已设为分类模型：' + proxyClassifier : '已切换为评分兜底（不使用分类模型）', 'ok'); refreshAll(); })
      .catch(function (e) { toast('设置失败（代理未运行？）：' + e.message, 'err'); });
  }
  function testClassifier() {
    var ta = document.getElementById('classifierTest');
    var text = ta ? ta.value.trim() : '';
    if (!text) { toast('请输入要测试的需求', 'err'); return; }
    if (!DB.settings.intent) { toast('请先开启意图识别', 'err'); return; }
    if (!DB.proxyMasterToken && !DB.relayToken) { toast('请先在设置里配置主控 Key（代理已启用鉴权）', 'err'); return; }
    var ids = catalogEnabledIds();
    if (!ids.length) { toast('没有已启用模型', 'err'); return; }
    var res = document.getElementById('classifierResult');
    if (res) res.innerHTML = '<span class="chip chip-warn"><i></i>分析中…</span>';
    var body = { model: 'auto', messages: [{ role: 'user', content: text }], stream: false, models: ids };
    var headers = mhdr();
    if (DB.proxyMasterToken) headers['x-proxy-token'] = DB.proxyMasterToken; else if (DB.relayToken) headers['x-proxy-token'] = DB.relayToken;
    fetch(PROXY_V1 + '/auto/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var chosen = (j && j.model) ? j.model : '?';
        if (res) res.innerHTML = '<div class="intent-chosen">代理选择模型：<b>' + esc(chosen) + '</b></div>';
      })
      .catch(function (e) { if (res) res.innerHTML = '<span class="chip chip-err"><i></i>' + esc(e.message) + '</span>'; });
  }
  function clearProxyLogs() {
    fetch(PROXY_V1 + '/logs/clear', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (j.ok) { pullProxyLogs().then(modalLogs); toast('已清空代理日志', 'ok'); } })
      .catch(function (e) { toast('清空失败：' + e.message, 'err'); });
  }
  /* ---------- 模块二：API 管理 ---------- */
  function viewApi() {
    var st = effectiveState(DB.apis.length);
    var loading = pendingRefresh === 'api';
    var head = '<div class="page-head">' +
      '<div class="ph-text">' +
        '<h1>API 管理</h1>' +
        '<p>集中记录各平台的 Base URL、密钥与到期时间。密钥默认掩码显示，点眼睛图标可临时查看。</p>' +
      '</div>' +
      '<div class="ph-actions">' +
        '<button class="btn btn-outline" type="button" data-act="refresh">' + ICON.refresh + '刷新</button>' +
        '<button class="btn btn-outline" type="button" data-act="import">' + ICON.copy + '导入备份</button>' +
        '<button class="btn btn-outline" type="button" data-act="export">' + ICON.copy + '导出备份</button>' +
        '<button class="btn btn-primary" type="button" data-act="api-add">' + ICON.plus + '新增接口</button>' +
      '</div></div>';

    var strip = proxyStripHtml();
    var panel = genPanel('按场景生成接入方案', '描述你要接的场景与目标，生成对应的接入步骤、请求示例和需要提前准备的东西。', 'routes');

    var ac = apiCounts();
    var warnN = ac.unconfig + ac.expired + ac.abnormal;
    var statCards = '<section class="stat-grid stagger">' +
      statCard('接口总数', ac.total, '个', 'navy', ICON.layers, ac.local + ' 个本地模式', 'flat') +
      statCard('可用', ac.ok, '个', 'ok', ICON.check, ac.local + ' 个本地免密钥', 'flat') +
      statCard('待处理', ac.unconfig, '个', 'violet', ICON.bolt, '已填 Key 待测试', 'flat') +
      statCard('需关注', warnN, '个', warnN ? 'warn' : 'ok', ICON.alert, (ac.expired ? ac.expired + ' 过期' : '') + (ac.abnormal ? ' ' + ac.abnormal + ' 异常' : '') || '一切正常', 'flat') +
    '</section>';

    var listPanel = '<section class="panel">' +
      '<div class="panel-head">' +
        '<div><h2>接口清单</h2><p class="ph-sub">共 ' + DB.apis.length + ' 条</p></div>' +
        '<div class="ph-right">' + statusChip(summaryOf(DB.apis)) + '</div>' +
      '</div>';

    var s = stateArea({
      state: st,
      emptyTitle: '还没有接口记录',
      emptyDesc: '把你手上平台的 Base URL 和密钥记进来，注意别填真实密钥，用占位值先跑通流程。',
      emptyAct: '<button class="btn btn-primary" type="button" data-act="api-add">' + ICON.plus + '新增接口</button>' +
                '<button class="btn btn-outline" type="button" data-act="reset-data">恢复示例数据</button>'
    });
    if (s) return head + strip + panel + statCards + listPanel + s + '</section>';

    var rows = DB.apis.map(function (a) {
      var isLocalMode = /127\.0\.0\.1|localhost|::1/.test(a.baseUrl || '') || /本机|LocalAI|LM Studio|本地代理/.test((a.vendor || '') + (a.name || ''));
      var shown = DB.settings.showMasked ? maskKey(a.key) : (a.key || (isLocalMode ? '本地模式' : '未填写'));
      return '<tr' + (loading ? ' class="is-loading"' : '') + '>' +
        '<td data-label="名称"><div class="t-main">' + esc(a.name) + '</div><div class="t-sub">' + esc(a.vendor) + '</div></td>' +
        '<td data-label="Base URL"><span class="mono">' + esc(a.baseUrl) + '</span></td>' +
        '<td data-label="密钥"><span class="mono">' + esc(shown) + '</span></td>' +
        '<td data-label="状态">' + statusChip(a.status) + '</td>' +
        '<td data-label="到期"><span class="num">' + (a.expire ? esc(a.expire) : '—') + '</span></td>' +
        '<td data-label="用途"><div class="mc-tags" style="margin:0">' + scopeTags(a.scopes) + '</div></td>' +
        '<td class="col-act"><span class="row-actions">' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="api-test" data-id="' + a.id + '">' + ICON.bolt + '测试</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="api-edit" data-id="' + a.id + '">' + ICON.edit + '编辑</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-act="api-del" data-id="' + a.id + '">' + ICON.trash + '</button>' +
        '</span></td>' +
      '</tr>';
    }).join('');

    return head + strip + panel + statCards + listPanel +
      '<div class="panel-body"><div class="tbl-wrap"><table class="tbl">' +
        '<thead><tr><th>名称 / 平台</th><th>Base URL</th><th>密钥</th><th>状态</th><th>到期</th><th>用途</th><th class="col-act">操作</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '<p class="hint" style="margin-top:12px">本地接口（如 Ollama）无需密钥，显示「本地模式」。其它密钥只存在本机浏览器，页面不会发送到任何服务器。真实密钥建议配合环境变量使用。</p>' +
      '</div></section>';
  }

  /* ---------- 模块三：中转站模型管理 ---------- */
  function logRowHtml(l) {
    var ok = l.status === 200;
    var autoTag = l.auto ? ' <span class="chip chip-auto-mini"><i></i>自动</span>' : '';
    return '<tr>' +
      '<td data-label="时间"><span class="num">' + fmtFull(l.ts) + '</span></td>' +
      '<td data-label="模型"><span class="mono">' + esc(l.model) + '</span>' + autoTag + '</td>' +
      '<td data-label="上游">' + esc(l.upstream) + '</td>' +
      '<td data-label="状态">' + (ok ? '<span class="chip chip-ok"><i></i>200</span>' : '<span class="chip chip-err"><i></i>' + l.status + '</span>') + '</td>' +
      '<td data-label="延迟"><span class="num">' + (ok ? l.latency + ' ms' : '—') + '</span></td>' +
      '<td data-label="Tokens"><span class="num">' + (ok ? l.tokens : '—') + '</span></td>' +
    '</tr>';
  }
  function viewRelay() {
    var stats = calcStats();
    var head = '<div class="page-head">' +
      '<div class="ph-text">' +
        '<h1>中转站模型管理</h1>' +
        '<p>把上游接口按规则聚合成一个统一入口：配置本地代理、管理中转规则、查看最近调用。</p>' +
      '</div>' +
      '<div class="ph-actions">' +
        '<button class="btn btn-ghost" type="button" data-act="relay-station">' + ICON.layers + '中转站配置</button>' +
        '<button class="btn btn-outline" type="button" data-act="refresh">' + ICON.refresh + '刷新</button>' +
        '<button class="btn btn-primary" type="button" data-act="route-add">' + ICON.plus + '新增规则</button>' +
      '</div></div>';

    // 概览统计卡
    var statCards = '<section class="stat-grid stagger">' +
      statCard('今日调用', stats.today, '次', 'navy', ICON.bolt, stats.deltaTxt, stats.deltaCls) +
      statCard('调用成功率', stats.okRate, '%', 'ok', ICON.check, '近 ' + stats.total + ' 次统计', 'flat') +
      statCard('平均延迟', stats.avgLat, 'ms', 'violet', ICON.clock, '仅统计成功请求', 'flat') +
      statCard('启用规则', stats.routesOn + '/' + DB.routes.length, '', 'warn', ICON.layers, '累计消耗 ' + stats.tokens.toLocaleString('zh-CN') + ' tokens', 'flat') +
    '</section>';

    var tabs = relayTabsHtml();
    var body = '<div class="relay-tab-wrap stagger">' + tabs + relayTabContentHtml() + '</div>';
    return head + statCards + body;
  }

  function relayTabsHtml() {
    var items = [
      { key: 'proxy', label: '本地代理' },
      { key: 'rules', label: '中转规则' },
      { key: 'logs',  label: '最近调用' }
    ];
    var cnt = {
      proxy: proxyOnline ? 1 : 0,
      rules: DB.routes.length,
      logs: (proxyOnline && proxyLogs.length ? proxyLogs.length : DB.logs.length)
    };
    var html = items.map(function (it) {
      var on = relayTab === it.key ? ' is-on' : '';
      return '<button class="relay-tab' + on + '" type="button" data-act="relay-tab" data-value="' + it.key + '">' +
        '<span class="rt-label">' + esc(it.label) + '</span>' +
        '<span class="rt-cnt">' + cnt[it.key] + '</span>' +
      '</button>';
    }).join('');
    return '<div class="relay-tabs" role="tablist" aria-label="中转站模块">' + html + '</div>';
  }

  function relayTabContentHtml() {
    if (relayTab === 'proxy') {
      return '<section class="panel relay-tab-panel" id="relayTabPanel">' +
        '<div class="panel-head"><div><h2>本地代理</h2><p class="ph-sub">统一入口 ' + PROXY_V1 + '</p></div></div>' +
        '<div class="panel-body"><div id="proxyStatus" class="proxy-status">检测中…</div></div>' +
      '</section>';
    }
    if (relayTab === 'logs') {
      return '<section class="panel relay-tab-panel" id="relayTabPanel">' + relayLogPanelInner() + '</section>';
    }
    // rules
    var filtered = filteredRoutes();
    return '<section class="panel relay-tab-panel" id="relayTabPanel">' +
      '<div class="panel-head"><div><h2>中转规则</h2><p class="ph-sub">共 ' + DB.routes.length + ' 条，当前显示 ' + filtered.length + ' 条</p></div>' +
        '<div class="ph-right"><button class="btn btn-primary btn-sm" type="button" data-act="route-add">' + ICON.plus + '新增</button></div></div>' +
      relayFilterBarHTML(DB.routes) +
      '<div class="panel-body is-flush">' + relayGridHtml() + '</div>' +
    '</section>';
  }

  function relayLogPanelInner() {
    var realLogs = proxyOnline ? proxyLogs : [];
    var srcLogs = realLogs.length ? realLogs : DB.logs;
    var logRows = srcLogs.slice(0, 12).map(logRowHtml).join('');
    var logSub = realLogs.length
      ? '真实记录（来自本地代理，保留 30 天）'
      : (proxyOnline ? '暂无调用记录' : '代理未运行，暂无真实调用记录（启动代理后这里显示真实日志）');
    if (logRows) {
      return '<div class="panel-head"><div><h2>最近调用</h2><p class="ph-sub">' + esc(logSub) + '</p></div>' +
          '<div class="ph-right"><button class="btn btn-ghost btn-sm" type="button" data-act="log-more">查看全部</button></div></div>' +
          '<div class="panel-body"><div class="tbl-wrap"><table class="tbl">' +
            '<thead><tr><th>时间</th><th>模型</th><th>上游</th><th>状态</th><th>延迟</th><th>Tokens</th></tr></thead>' +
            '<tbody>' + logRows + '</tbody></table></div></div>';
    }
    return '<div class="panel-head"><div><h2>最近调用</h2><p class="ph-sub">' + esc(logSub) + '</p></div></div>' +
      '<div class="panel-body">' + emptyState('暂无调用记录', '代理运行并发起一次请求后，记录会实时出现在这里。', '') + '</div>';
  }

  function relayGridHtml() {
    var routes = filteredRoutes();
    var cards = routes.map(relayCardHtml).join('');
    var emptyMsg = routes.length ? '' : '<div class="state-box" style="padding:28px 10px"><div class="state-ico">' + ICON.empty + '</div><p class="state-title">没有符合当前筛选的规则</p><p class="state-desc">切换上方分类可查看全部规则</p></div>';
    return '<div class="relay-grid">' + (cards || emptyMsg) + '</div>';
  }

  function routeUsage(r) {
    var logs = (proxyOnline && proxyLogs.length) ? proxyLogs : DB.logs;
    var models = (r.models && r.models.length) ? r.models : [r.model];
    var recs = logs.filter(function (l) { return models.indexOf(l.model) !== -1; });
    var total = recs.length, ok = 0, lat = 0, latN = 0, todayN = 0;
    var t0 = new Date(); t0.setHours(0, 0, 0, 0);
    recs.forEach(function (l) {
      if (l.status === 200) { ok++; lat += l.latency; latN++; }
      if (l.ts >= t0.getTime()) todayN++;
    });
    return {
      count: total,
      today: todayN,
      okRate: total ? Math.round(ok / total * 1000) / 10 : null,
      avgLat: latN ? Math.round(lat / latN) : null
    };
  }

  function routeClassOf(r) {
    var ms = (r.models && r.models.length) ? r.models : [r.model];
    for (var i = 0; i < ms.length; i++) {
      var m = (ms[i] || '').toLowerCase();
      if (/vision|4v|vl|image|mm-| multimodal|多模态/.test(m)) return 'vision';
    }
    return 'chat';
  }
  function filteredRoutes() {
    return (DB.routes || []).filter(function (r) {
      if (relayFilter === 'all') return true;
      if (relayFilter === 'on') return r.enabled;
      if (relayFilter === 'off') return !r.enabled;
      return routeClassOf(r) === relayFilter;
    });
  }
  function relayFilterChip(value, label, cnt) {
    var on = relayFilter === value ? ' is-on' : '';
    return '<button class="tab-item' + on + '" type="button" data-act="relay-filter" data-value="' + value + '"><span class="ti-label">' + esc(label) + '</span><span class="cnt">' + cnt + '</span></button>';
  }
  function relayFilterBarHTML(routes) {
    var chat = 0, vision = 0, on = 0, off = 0;
    routes.forEach(function (r) {
      if (routeClassOf(r) === 'vision') vision++; else chat++;
      if (r.enabled) on++; else off++;
    });
    return '<div class="tab-bar">' +
      relayFilterChip('all', '全部', routes.length) +
      relayFilterChip('chat', '对话', chat) +
      relayFilterChip('vision', '图像', vision) +
      relayFilterChip('on', '已启用', on) +
      relayFilterChip('off', '已停用', off) +
    '</div>';
  }

  function relayCardHtml(r) {
    var on = !!r.enabled;
    var u = routeUsage(r);
    var usage = u.count
      ? '<span><b>' + u.today + '</b> 今日</span>' +
        '<span><b>' + (u.okRate != null ? u.okRate : '—') + '%</b> 成功率</span>' +
        '<span><b>' + (u.avgLat != null ? u.avgLat : '—') + '</b> ms</span>'
      : '<span class="rc-usage-empty">暂无调用数据</span>';
    var models = (r.models && r.models.length) ? r.models : [r.model];
    var modelTags = models.map(function (m) {
      var cls = /vision|4v|vl|image|mm-| multimodal|多模态/i.test(m) ? 'is-vision' : 'is-chat';
      return '<span class="model-tag ' + cls + '">' + esc(m) + '</span>';
    }).join('');
    return '<article class="relay-card' + (on ? '' : ' is-off') + '" data-id="' + r.id + '">' +
      '<div class="rc-head">' +
        '<span class="rc-dot ' + (on ? 'on' : 'off') + '" aria-hidden="true"></span>' +
        '<div class="rc-title">' +
          '<div class="rc-name">' + esc(r.name) + '</div>' +
          '<div class="rc-sub">' + esc(r.upstream) + '</div>' +
        '</div>' +
        '<span class="chip ' + (on ? 'chip-ok' : 'chip-mute') + '">' + (on ? '已启用' : '已停用') + '</span>' +
      '</div>' +
      '<div class="rc-body">' +
        '<div class="rc-models">' + modelTags + '</div>' +
        (r.note ? '<div class="rc-note">' + esc(r.note) + '</div>' : '') +
        '<div class="rc-usage">' + usage + '</div>' +
      '</div>' +
      '<div class="rc-foot">' +
        '<span class="rc-weight">权重 <b>' + (r.weight != null ? r.weight : 0) + '%</b></span>' +
        '<span class="rc-actions">' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="route-toggle" data-id="' + r.id + '">' + (on ? '停用' : '启用') + '</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="route-test" data-id="' + r.id + '"' + (on ? '' : ' disabled') + ' title="' + (on ? '向目标模型发一条测试请求' : '规则已停用，请先启用再测试') + '>' + ICON.bolt + '测试</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="route-curl" data-id="' + r.id + '" data-tip="复制 curl">' + ICON.copy + 'curl</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="route-edit" data-id="' + r.id + '" data-tip="编辑">' + ICON.edit + '</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-act="route-del" data-id="' + r.id + '" data-tip="删除">' + ICON.trash + '</button>' +
        '</span>' +
      '</div>' +
    '</article>';
  }

  function statCard(label, value, unit, tone, icon, delta, deltaCls) {
    return '<div class="stat">' +
      '<div class="stat-top">' +
        '<span class="stat-ico ' + tone + '">' + icon + '</span>' +
        '<span class="stat-label">' + esc(label) + '</span>' +
      '</div>' +
      '<div class="stat-value">' + esc(value) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>' +
      '<div class="stat-delta ' + deltaCls + '">' + esc(delta) + '</div>' +
    '</div>';
  }

  function barChart(days) {
    var max = 1;
    days.forEach(function (d) { if (d.n > max) max = d.n; });
    var W = 640, H = 220, padL = 34, padB = 46, padR = 16, plotW = W - padL - padR;
    var n = days.length || 1;
    var slot = plotW / n, bw = Math.max(18, slot * 0.46);
    var bars = '', labels = '', ticks = '';
    days.forEach(function (d, i) {
      var cx = padL + i * slot + slot / 2;
      var h = Math.max(4, (d.n / max) * (H - padB - 18));
      var x = cx - bw / 2;
      var y = H - padB - h;
      bars += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) +
              '" rx="5" fill="url(#barGrad)"><title>' + fmtDate(d.ts) + '：' + d.n + ' 次</title></rect>';
      if (h >= 16) {
        bars += '<text x="' + cx.toFixed(2) + '" y="' + (y + 14).toFixed(2) + '" text-anchor="middle" font-size="11" fill="#fff" font-weight="600">' + d.n + '</text>';
      } else {
        bars += '<text x="' + cx.toFixed(2) + '" y="' + (y - 8).toFixed(2) + '" text-anchor="middle" font-size="11" fill="#737f9a">' + d.n + '</text>';
      }
      var dd = new Date(d.ts);
      labels += '<text x="' + cx.toFixed(2) + '" y="' + (H - 14) + '" text-anchor="end" transform="rotate(-40 ' + cx.toFixed(2) + ' ' + (H - 14) + ')" font-size="12" fill="#737f9a">' +
                (dd.getMonth() + 1) + '/' + dd.getDate() + '</text>';
    });
    ticks += '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#e4e8f2" stroke-width="1"/>';
    ticks += '<text x="6" y="18" font-size="11" fill="#9aa5bd">' + max + '</text>';
    ticks += '<text x="6" y="' + (H - padB - 4) + '" font-size="11" fill="#9aa5bd">0</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="240" preserveAspectRatio="xMidYMid meet" role="img" aria-label="近 7 日调用量柱状图">' +
      '<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#5b6ef5"/><stop offset="100%" stop-color="#7c5cf0"/>' +
      '</linearGradient></defs>' +
      ticks + bars + labels +
    '</svg>';
  }

  function donutChart(byModel) {
    var keys = Object.keys(byModel);
    if (!keys.length) {
      return '<div class="state-box" style="padding:26px 10px">' +
        '<div class="state-ico empty">' + ICON.empty + '</div>' +
        '<p class="state-title" style="font-size:14px">还没有成功调用</p>' +
        '<p class="state-desc">跑通一次请求后，这里会显示各模型的调用占比。</p></div>';
    }
    var colors = ['#5b6ef5', '#7c5cf0', '#0f1e3d', '#0f9d76', '#c77c0a', '#d13f52'];
    var total = keys.reduce(function (a, k) { return a + byModel[k]; }, 0);
    var R = 42, C = 2 * Math.PI * R, off = 0, segs = '';
    keys.slice(0, 6).forEach(function (k, i) {
      var frac = byModel[k] / total;
      var len = frac * C;
      segs += '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + colors[i % colors.length] + '" stroke-width="14" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" ' +
        'transform="rotate(-90 60 60)"><title>' + esc(k) + '：' + byModel[k] + ' 次</title></circle>';
      off += len;
    });
    var legend = keys.slice(0, 6).map(function (k, i) {
      var pct = Math.round(byModel[k] / total * 100);
      return '<span><i style="background:' + colors[i % colors.length] + '"></i>' + esc(k) + ' ' + pct + '%</span>';
    }).join('');
    return '<svg viewBox="0 0 120 120" width="100%" height="150" role="img" aria-label="模型调用分布环形图">' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="#eef1f7" stroke-width="14"/>' + segs +
      '<text x="60" y="56" text-anchor="middle" font-size="17" font-weight="700" fill="#0f1e3d">' + total + '</text>' +
      '<text x="60" y="70" text-anchor="middle" font-size="8.5" fill="#9aa5bd">成功调用</text>' +
    '</svg><div class="chart-legend">' + legend + '</div>';
  }

  function apiCounts() {
    var local = 0, unconfig = 0, expired = 0, abnormal = 0, ok = 0;
    DB.apis.forEach(function (a) {
      var isLocal = /127\.0\.0\.1|localhost|::1/.test(a.baseUrl || '') || /本机|LocalAI|LM Studio|本地代理/.test((a.vendor || '') + (a.name || ''));
      if (isLocal) { local++; ok++; return; }
      if (a.status === '正常') { ok++; return; }
      if (a.status === '未配置') {
        if (a.key && !/^sk-demo/i.test(a.key)) unconfig++;
      } else if (a.status === '已过期') {
        expired++;
      } else if (a.status) {
        abnormal++;
      }
    });
    return { total: DB.apis.length, ok: ok, local: local, unconfig: unconfig, expired: expired, abnormal: abnormal };
  }
  function summaryOf(apis) {
    var c = apiCounts();
    var parts = [];
    if (c.unconfig) parts.push(c.unconfig + ' 条待测试');
    if (c.expired) parts.push(c.expired + ' 条已过期');
    if (c.abnormal) parts.push(c.abnormal + ' 条异常');
    if (c.local) parts.push(c.local + ' 条本地模式');
    return parts.length ? parts.join(' | ') : '全部正常';
  }

  function effectiveState(count) {
    var d = DB.settings.demoState;
    // 设置里显式指定的状态优先；未指定时，数据为空才显示空状态
    if (d === 'loading' || d === 'error' || d === 'empty') return d;
    if (count === 0) return 'empty';
    return 'normal';
  }

  function set(id, v) {
    var e = document.getElementById(id);
    if (e) e.textContent = v;
  }

  /* ============================================================
     弹窗系统
     ============================================================ */
  var modalRoot = null, dlgTitle = null, dlgSub = null, dlgBody = null, dlgBtns = null,
      dlgNote = null, dlgBusy = null, dialogEl = null;
  var lastFocus = null;
  var pendingRefresh = null; // 模块级刷新加载态：'free' | 'api' | null
  var freeFilter = { type: 'all', vendor: 'all', q: '', vendorOpen: false }; // Free 模块筛选状态
  var relayFilter = 'all'; // 中转规则分类栏状态（不持久化）
  var relayTab = 'rules'; // 中转站页面标签：proxy | rules | logs
  var TYPE_LABEL = { all: '全部', free: '免费', quota: '限额免费', trial: '限免', expired: '已过期' };
  var STALE_DAYS = 7;
  var SORT_LABEL = { vendor: '按厂商', name: '按名称', type: '按免费类型' };
  var pendingApiPrefill = null; // 从目录「去接入」时带过来的预填信息

  function openModal(cfg) {
    lastFocus = document.activeElement;
    dlgTitle.textContent = cfg.title || '';
    dlgSub.textContent = cfg.sub || '';
    dlgSub.style.display = cfg.sub ? '' : 'none';
    dlgBody.innerHTML = cfg.body || '';
    dlgBtns.innerHTML = cfg.buttons || '';
    dlgNote.textContent = cfg.note || '';
    dlgNote.style.display = cfg.note ? '' : 'none';
    dlgBusy.hidden = true;
    dialogEl.className = 'dialog' + (cfg.size === 'lg' ? ' size-lg' : '');
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    var first = dlgBody.querySelector('input, select, textarea, button');
    if (first) first.focus();
    else document.getElementById('dlgClose').focus();
  }

  function closeModal() {
    modalRoot.hidden = true;
    dlgBusy.hidden = true;
    dlgBody.innerHTML = '';
    dlgBtns.innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // 弹窗加载态：提交中禁用整块内容
  function setDialogBusy(on, text) {
    dlgBusy.hidden = !on;
    if (text) {
      var t = dlgBusy.querySelector('span:last-child');
      if (t) t.textContent = text;
    }
    if (on) {
      var b = dlgBtns.querySelector('.btn-primary');
      if (b) { b.classList.add('is-loading'); b.disabled = true; }
    }
  }

  // 校验通过后再走这个：先置加载态，延时后真正提交，让加载态可见
  function submitWithBusy(commit, tipText) {
    setDialogBusy(true, tipText || '提交中…');
    setTimeout(function () {
      setDialogBusy(false);
      commit();
    }, 480);
  }

  function isModalOpen() { return modalRoot && !modalRoot.hidden; }

  /* ===== 抽屉（代理详情）===== */
  var drawerRoot = null, drawerEl = null, drawerTitle = null, drawerSub = null, drawerBody = null, drawerCloseBtn = null;
  function openDrawer(cfg) {
    lastFocus = document.activeElement;
    drawerTitle.textContent = cfg.title || '';
    drawerSub.textContent = cfg.sub || '';
    drawerSub.style.display = cfg.sub ? '' : 'none';
    drawerBody.innerHTML = cfg.body || '';
    drawerRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    var first = drawerBody.querySelector('button, a, input, select, textarea');
    if (first) first.focus(); else drawerCloseBtn.focus();
  }
  function closeDrawer() {
    drawerRoot.hidden = true;
    drawerBody.innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function isDrawerOpen() { return drawerRoot && !drawerRoot.hidden; }
  function trapFocusDrawer(e) {
    var f = drawerEl.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var firstEl = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }
  function maskToken(t) {
    if (!t || t.length < 12) return t || '';
    return t.slice(0, 6) + '••••••' + t.slice(-4);
  }
  function statMini(k, v) {
    return '<div class="sm"><b>' + esc(String(v)) + '</b><span>' + esc(k) + '</span></div>';
  }
  function openProxyDetail() {
    var stats = calcStats();
    var live = !!proxyOnline;
    var token = DB.proxyMasterToken || DB.relayToken || '';
    var statusRow = '<div class="drawer-status ' + (live ? 'on' : 'off') + '"><i></i>' +
      (live ? '代理在线' : '代理离线') + '<span class="db-addr">' + esc(PROXY_V1) + '</span></div>';
    var addrBlock = '<div class="drawer-block"><div class="db-label">调用地址（OpenAI 兼容）</div>' +
      '<div class="drawer-addr"><code>' + esc(PROXY_V1) + '</code>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + esc(PROXY_V1) + '">' + ICON.copy + '复制</button></div></div>';
    var tokenBlock = token
      ? '<div class="drawer-block"><div class="db-label">鉴权 Token（请求头 x-proxy-token）</div>' +
        '<div class="drawer-addr"><code>' + esc(maskToken(token)) + '</code>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + esc(token) + '">' + ICON.copy + '复制</button></div>' +
        '<p class="hint" style="margin-top:8px">外部应用（LobsterAI / CherryStudio）接入时，在请求头带上此 Token 即可通过代理鉴权。</p></div>'
      : '<div class="drawer-block"><div class="db-label">鉴权 Token</div>' +
        '<p class="hint">尚未生成中转站 Key，代理当前未启用鉴权。可在「中转规则」页生成。</p></div>';
    var statBlock = '<div class="drawer-block"><div class="db-label">实时统计</div>' +
      '<div class="drawer-stat">' +
        statMini('今日调用', stats.today) +
        statMini('成功率', stats.okRate + '%') +
        statMini('平均延迟', stats.avgLat + 'ms') +
        statMini('启用规则', stats.routesOn + '/' + DB.routes.length) +
      '</div></div>';
    var logs = (proxyOnline && proxyLogs.length) ? proxyLogs : DB.logs;
    var last5 = logs.slice(0, 5).map(logRowHtml).join('');
    var logBlock = '<div class="drawer-block"><div class="db-label">最近 5 条调用</div>' +
      (last5
        ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>延迟</th></tr></thead><tbody>' + last5 + '</tbody></table></div>'
        : emptyState('暂无调用记录', '代理运行后这里会显示真实调用日志。', '')) +
      '</div>';
    openDrawer({ title: '代理详情', sub: live ? '本地代理运行中' : '本地代理未连接', body: statusRow + addrBlock + tokenBlock + statBlock + logBlock });
  }

  function btn(text, act, cls) {
    return '<button class="btn ' + (cls || 'btn-outline') + '" type="button" data-mact="' + act + '">' + text + '</button>';
  }

  /* ---------- 各弹窗内容 ---------- */

  function modalExample() {
    var body =
      '<div class="seg" id="exSeg" style="margin-bottom:18px">' +
        '<button type="button" class="is-active" data-ex="use">如何使用</button>' +
        '<button type="button" data-ex="cfg">如何配置</button>' +
      '</div>' +
      '<div id="exBody"></div>';
    openModal({
      title: '快捷示例',
      sub: '照着走一遍，大约三分钟能跑通第一条调用',
      size: 'lg',
      body: body,
      note: '示例中的接口与密钥都是占位值',
      buttons: btn('关闭', 'close', 'btn-primary')
    });
    renderExample('use');
  }

  function renderExample(tab) {
    var box = document.getElementById('exBody');
    if (!box) return;
    if (tab === 'use') {
      box.innerHTML = '<div class="steps">' +
        step(1, '先确认有没有可用的上游',
             '到「API 管理」看有没有状态为「正常」的接口。没有就点「新增接口」，Base URL 填平台给的地址，密钥先填一个占位值。') +
        step(2, '在模型清单里挑一个模型',
             '到「Free 模型」找一个适用方向对得上的模型，点「复制名称」，后面填请求体要用到。') +
        step(3, '用生成面板拼出请求',
             '选关系阶段和当前目标，写清楚情境，点「生成配置与示例」，会输出一段 curl 和对应的 JSON。') +
        step(4, '在本机跑一次',
             '把示例里的 <code>$YOUR_API_KEY</code> 换成真实密钥，先在终端跑一次，确认能拿到回复再写进代码。') +
        step(5, '回头看统计',
             '调用成功后到「中转站模型管理」填写规则，之后的成功率、延迟和用量会自动汇总。') +
      '</div>';
    } else {
      box.innerHTML = '<div class="steps">' +
        step(1, '接口要填哪些字段',
             '名称随便起，自己认得就行；Base URL 必须以 <code>http</code> 或 <code>https</code> 开头，末尾的 <code>/v1</code> 别漏。') +
        step(2, '密钥怎么处理',
             '页面里填的密钥只存本机浏览器，默认掩码显示。真实项目建议放到环境变量，页面里留占位值。') +
        step(3, '到期时间用来干嘛',
             '填了才会出现在到期列，方便提前续期。留空表示长期有效。') +
        step(4, '中转规则怎么配',
             '同一用途配两条以上规则才能 failover。权重决定分配比例，主线路给 70，备线给 30 就行。') +
        step(5, '数据备份',
             '在「API 管理」点「导出备份」会下载一个 JSON。换电脑或清缓存前先导一份。') +
      '</div>';
    }
    var segs = document.querySelectorAll('#exSeg button');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('is-active', segs[i].getAttribute('data-ex') === tab);
    }
  }

  function step(n, title, desc) {
    return '<div class="step"><span class="step-no">' + n + '</span><div>' +
      '<b>' + esc(title) + '</b><p>' + desc + '</p></div></div>';
  }

  function modalSettings() {
    var s = DB.settings;
    var card = function(ico, title, desc, body) {
      return '<div class="settings-card"><div class="sc-head"><span class="sc-ico">' + ico + '</span><div><h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p></div></div><div class="sc-body">' + body + '</div></div>';
    };
    var range = function(id, val, min, max, unit, label) {
      return '<div class="field" style="margin:0">' +
        '<label style="font-size:var(--fs-sm);margin-bottom:8px">' + esc(label) + '</label>' +
        '<div class="range-wrap">' +
          '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" value="' + val + '" data-mact="range">' +
          '<span class="range-val">' + val + (unit || '') + '</span>' +
        '</div>' +
      '</div>';
    };
    var selectRow = function(id, label, opts) {
      return '<div class="field" style="margin:0">' +
        '<label style="font-size:var(--fs-sm);margin-bottom:8px">' + esc(label) + '</label>' +
        '<select class="select" id="' + id + '" data-mact="select">' + opts + '</select>' +
      '</div>';
    };
    var bgOpts = [
      { k: 'default', l: '默认极光' },
      { k: 'nature', l: '自然风景' },
      { k: 'nebula', l: '科幻星云' },
      { k: 'cyberpunk', l: '赛博朋克' },
      { k: 'tech', l: '数字科技' }
    ].map(function(o) { return '<option value="' + o.k + '"' + (s.themeBg === o.k ? ' selected' : '') + '>' + esc(o.l) + '</option>'; }).join('');
    var themeOpts = [
      { k: 'light', l: '白天' },
      { k: 'dark', l: '黑暗' },
      { k: 'eyecare', l: '护眼' },
      { k: 'cyberpunk', l: '赛博朋克' },
      { k: 'system', l: '跟随系统' }
    ].map(function(o) { return '<option value="' + o.k + '"' + (s.theme === o.k ? ' selected' : '') + '>' + esc(o.l) + '</option>'; }).join('');
    var fontOpts = [
      { k: 'system', l: '系统默认' },
      { k: 'serif', l: '衬线字体' },
      { k: 'mono', l: '等宽字体' }
    ].map(function(o) { return '<option value="' + o.k + '"' + (s.fontFamily === o.k ? ' selected' : '') + '>' + esc(o.l) + '</option>'; }).join('');
    var startupOpts = [
      { k: 'overview', l: '概览' },
      { k: 'free', l: 'Free 模型' },
      { k: 'api', l: 'API 管理' },
      { k: 'relay', l: '中转站模型管理' },
      { k: 'routes', l: '上游路由' }
    ].map(function(o) { return '<option value="' + o.k + '"' + (s.startup === o.k ? ' selected' : '') + '>' + esc(o.l) + '</option>'; }).join('');
    var demoRadio = '<div class="radio-list compact" id="demoList">' +
          radio('normal',  '正常展示', '按真实数据渲染', s.demoState === 'normal') +
          radio('loading', '加载中',   '显示骨架屏', s.demoState === 'loading') +
          radio('empty',   '空数据',   '显示空状态插画', s.demoState === 'empty') +
          radio('error',   '请求失败', '显示错误提示', s.demoState === 'error') +
        '</div>';
    var appearanceBody =
      selectRow('setTheme', '界面主题', themeOpts) +
      '<div class="field" style="margin:0">' +
        '<label style="font-size:var(--fs-sm);margin-bottom:8px">主界面背景</label>' +
        '<div class="bg-thumb-list" id="bgList">' +
          bgOpts.replace(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g, function(_, v, t) {
            return '<button type="button" class="bg-thumb' + (s.themeBg === v ? ' is-on' : '') + '" data-bg="' + v + '" aria-pressed="' + (s.themeBg === v ? 'true' : 'false') + '">' + esc(t) + '</button>';
          }) +
        '</div>' +
        '<p class="hint" style="margin-top:8px">背景图片与界面主题互相独立，均内嵌在单文件中</p>' +
      '</div>' +
      selectRow('setStartup', '启动页面', startupOpts) +
      range('setBrightness', s.brightness, 60, 120, '%', '全局亮度：' + s.brightness + '%') +
      selectRow('setFontFamily', '界面字体', fontOpts) +
      range('setFontScale', s.fontScale, 80, 130, '%', '字号缩放：' + s.fontScale + '%');
    var displayBody = '<div class="field" style="margin:0">' +
        '<label style="font-size:var(--fs-sm);margin-bottom:8px">界面数据状态</label>' + demoRadio +
        '<p class="hint" style="margin-top:8px">仅切换界面呈现，不改真实数据</p>' +
      '</div>' +
      '<div class="switch-row">' +
        '<span class="sw-text"><b>密钥掩码显示</b><span>关掉后密钥完整显示，注意周围环境</span></span>' +
        '<button class="switch-btn" type="button" role="switch" data-mact="toggle-mask" aria-checked="' + (s.showMasked ? 'true' : 'false') + '" aria-label="密钥掩码显示"></button>' +
      '</div>';
    var behaviorBody =
      '<div class="switch-row">' +
        '<span class="sw-text"><b>删除前二次确认</b><span>关闭后删除操作会立即执行</span></span>' +
        '<button class="switch-btn" type="button" role="switch" data-mact="toggle-confirm" aria-checked="' + (s.confirmDelete ? 'true' : 'false') + '" aria-label="删除前二次确认"></button>' +
      '</div>' +
      '<div class="switch-row">' +
        '<span class="sw-text"><b>意图识别（自动选模型）</b><span>开启后由本地代理按额度/难度自动选模型</span></span>' +
        '<button class="switch-btn" type="button" role="switch" data-mact="toggle-intent" aria-checked="' + (s.intent ? 'true' : 'false') + '" aria-label="意图识别"></button>' +
      '</div>';
    var securityBody =
      '<div class="switch-row">' +
        '<span class="sw-text"><b>密钥保险库（口令加密）</b><span>开启后本地密钥以密文存储，打开需输入口令</span></span>' +
        '<button class="switch-btn" type="button" role="switch" data-mact="toggle-vault" aria-checked="' + (s.vaultOn ? 'true' : 'false') + '" aria-label="密钥保险库"></button>' +
      '</div>';
    var systemBody =
      '<div class="switch-row">' +
        '<span class="sw-text"><b>代理开机自启</b><span id="autostartDesc">检测中…</span></span>' +
        '<button class="switch-btn" type="button" role="switch" data-mact="toggle-autostart" id="autostartSwitch" aria-checked="false" aria-label="代理开机自启" disabled></button>' +
      '</div>' +
      '<p class="hint" style="margin:8px 0 0">开启后会在 Windows 启动文件夹创建 free-api-proxy.lnk，下次登录自动在后台运行 http://127.0.0.1:8787。受限环境/沙箱可能注册失败，需真机管理员权限；失败时会提示你手动运行命令。</p>';
    var shortcutsBody =
      '<div class="shortcut-list">' +
        '<div class="shortcut-row"><span class="sc-key">?</span><span>打开快捷示例</span></div>' +
        '<div class="shortcut-row"><span class="sc-key">Esc</span><span>关闭弹窗 / 返回</span></div>' +
        '<div class="shortcut-row"><span class="sc-key">1-5</span><span>切换左侧模块</span></div>' +
        '<div class="shortcut-row"><span class="sc-key">Ctrl / ⌘ + S</span><span>保存当前弹窗表单</span></div>' +
      '</div>';
    var dataBody =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
        '<button class="btn btn-outline btn-sm" type="button" data-mact="export-config">导出全部配置</button>' +
        '<button class="btn btn-outline btn-sm" type="button" data-mact="import-config">从备份导入</button>' +
        '<input type="file" id="cfgImportFile" accept="application/json,.json" hidden>' +
      '</div>' +
      '<p class="hint" style="margin:0 0 12px">导出为 tool-backup.json（含全部配置），换电脑导入即可恢复；代理运行时配置也会镜像进本机 config.json。</p>' +
      '<div class="settings-danger">' +
        '<p><b>清除本地数据</b><span>会清空所有模型、API、规则与设置，不可恢复</span></p>' +
        '<button class="btn btn-danger btn-sm" type="button" data-mact="clear-data">' + ICON.broom + ' 清除全部本地数据</button>' +
      '</div>';

    var accountBody;
    if (authState.hasPassword) {
      accountBody =
        '<div class="field" style="margin:0">' +
          '<label style="font-size:var(--fs-sm);margin-bottom:8px">当前密码</label>' +
          '<input class="input" id="acctCur" type="password" placeholder="输入当前访问密码" autocomplete="current-password" />' +
        '</div>' +
        '<div class="field" style="margin:0">' +
          '<label style="font-size:var(--fs-sm);margin-bottom:8px">新密码（至少 4 位）</label>' +
          '<input class="input" id="acctNew" type="password" placeholder="设置新的访问密码" autocomplete="new-password" />' +
        '</div>' +
        '<div class="field" style="margin:0">' +
          '<label style="font-size:var(--fs-sm);margin-bottom:8px">确认新密码</label>' +
          '<input class="input" id="acctNew2" type="password" placeholder="再次输入新密码" autocomplete="new-password" />' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">' +
          '<button class="btn btn-primary btn-sm" type="button" data-mact="acct-change">修改访问密码</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-mact="acct-logout">退出登录</button>' +
        '</div>' +
        '<div id="acctErr" class="acct-err"></div>' +
        '<p class="hint" style="margin:6px 0 0">访问密码用于保护本地代理的管理接口，与模型平台密钥无关；修改后下次进入需输新密码。</p>';
    } else {
      accountBody =
        '<div class="field" style="margin:0">' +
          '<label style="font-size:var(--fs-sm);margin-bottom:8px">访问密码（至少 4 位）</label>' +
          '<input class="input" id="acctNew" type="password" placeholder="设置访问密码" autocomplete="new-password" />' +
        '</div>' +
        '<div class="field" style="margin:0">' +
          '<label style="font-size:var(--fs-sm);margin-bottom:8px">确认密码</label>' +
          '<input class="input" id="acctNew2" type="password" placeholder="再次输入访问密码" autocomplete="new-password" />' +
        '</div>' +
        '<button class="btn btn-primary btn-sm" type="button" data-mact="acct-setup" style="margin-top:4px">设置访问密码</button>' +
        '<div id="acctErr" class="acct-err"></div>' +
        '<p class="hint" style="margin:6px 0 0">尚未设置访问密码，本机管理接口任何人可访问；设置后每次进入需输密码。</p>';
    }
    var accountCard = card(ICON.key, '访问密码', '保护本地代理管理接口（与模型密钥无关）', accountBody);

    var body =
      '<div class="settings-grid is-wide">' +
        card(ICON.image, '外观', '背景、亮度、字体与启动页面', appearanceBody) +
        card(ICON.eye, '显示与调试', '界面呈现方式与密钥可见性', displayBody) +
        card(ICON.bolt, '行为', '交互确认与模型自动选择策略', behaviorBody) +
        card(ICON.key, '安全', '本地密钥加密存储开关', securityBody) +
        card(ICON.power, '系统', '代理进程开机自启与系统级设置', systemBody) +
        accountCard +
        card(ICON.keyboard, '快捷键', '常用键盘操作', shortcutsBody) +
        card(ICON.trash, '数据', '本地缓存与清除', dataBody) +
      '</div>';
    openModal({
      title: '页面设置',
      sub: '偏好项保存在本机，换设备不会同步',
      body: body,
      note: '关闭后自动保存',
      size: 'lg',
      buttons: btn('恢复示例数据', 'reset-data', 'btn-danger') + btn('完成', 'close', 'btn-primary')
    });
    fetchAutostartStatus();
  }

  function fetchAutostartStatus() {
    var sw = document.getElementById('autostartSwitch');
    var desc = document.getElementById('autostartDesc');
    if (!sw || !desc) return;
    fetch(PROXY_BASE + '/api/autostart/status', { cache: 'no-store', headers: mhdr() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var on = !!j.enabled;
        DB.settings.proxyAutostart = on;
        sw.disabled = false;
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        desc.textContent = on ? '已注册开机自启' : '未注册开机自启';
        save();
      })
      .catch(function (e) {
        sw.disabled = true;
        sw.setAttribute('aria-checked', 'false');
        desc.textContent = '无法检测（代理未运行？）';
      });
  }
  function setProxyAutostart(enable) {
    var sw = document.getElementById('autostartSwitch');
    var desc = document.getElementById('autostartDesc');
    if (sw) sw.disabled = true;
    if (desc) desc.textContent = (enable ? '注册中…' : '取消中…');
    fetch(PROXY_BASE + '/api/autostart/' + (enable ? 'install' : 'uninstall'), { method: 'POST', headers: mhdr() })
      .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
      .then(function (o) {
        var j = o.j;
        if (o.r.ok) {
          DB.settings.proxyAutostart = enable;
          save();
          if (sw) { sw.setAttribute('aria-checked', enable ? 'true' : 'false'); sw.disabled = false; }
          if (desc) desc.textContent = enable ? '已注册开机自启' : '已取消开机自启';
          toast('开机自启' + (enable ? '已开启' : '已关闭'), 'ok');
        } else {
          var msg = (j && j.error && j.error.message) || (j && j.message) || '注册失败';
          if (sw) { sw.setAttribute('aria-checked', enable ? 'false' : 'true'); sw.disabled = false; }
          if (desc) desc.textContent = (enable ? '注册失败：' : '取消失败：') + msg;
          toast(msg, 'err');
        }
      })
      .catch(function (e) {
        if (sw) { sw.setAttribute('aria-checked', enable ? 'false' : 'true'); sw.disabled = false; }
        if (desc) desc.textContent = (enable ? '注册失败：' : '取消失败：') + e.message;
        toast('开机自启操作失败：' + e.message, 'err');
      });
  }

  function radio(val, title, desc, on) {
    return '<label class="radio-item' + (on ? ' is-on' : '') + '">' +
      '<input type="radio" name="demo" value="' + val + '"' + (on ? ' checked' : '') + '>' +
      '<span><b>' + esc(title) + '</b><span>' + esc(desc) + '</span></span></label>';
  }

  function modalModel(id) {
    var m = id ? findById(DB.models, id) : null;
    var cur = m ? m.scopes : [];
    var body =
      '<div class="form-grid">' +
        '<div class="field full">' +
          '<label for="mName">模型名称<span class="req">*</span></label>' +
          '<input class="input" id="mName" type="text" maxlength="60" placeholder="例如：Qwen2.5-7B-Instruct" value="' + esc(m ? m.name : '') + '">' +
          '<p class="hint">照抄官网写的完整名称，调用时要作为参数传</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="mVendor">提供方</label>' +
          '<input class="input" id="mVendor" type="text" maxlength="30" placeholder="例如：阿里云百炼" value="' + esc(m ? m.vendor : '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="mSite">网站</label>' +
          '<input class="input" id="mSite" type="text" maxlength="60" placeholder="例如：bailian.console.aliyun.com" value="' + esc(m ? m.site : '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="mFree">免费额度 / 期限</label>' +
          '<input class="input" id="mFree" type="text" maxlength="50" placeholder="例如：新用户赠额度，以官网为准" value="' + esc(m ? m.free : '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="mStatus">状态</label>' +
          '<select class="select" id="mStatus">' +
            opt('可用', m && m.status === '可用') + opt('限频', m && m.status === '限频') + opt('待核实', m && m.status === '待核实') + opt('已停用', m && m.status === '已停用') +
          '</select>' +
        '</div>' +
        '<div class="field full">' +
          '<label>适用方向</label>' +
          '<div class="mc-tags" id="mScopes" style="gap:8px">' +
            SCOPES.map(function (s) {
              return '<button class="tag' + (cur.indexOf(s) >= 0 ? ' tag-violet' : '') + '" type="button" data-scope="' + s + '" style="height:30px;padding:0 12px;cursor:pointer">' + s + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="field full">' +
          '<label for="mNote">备注</label>' +
          '<textarea class="textarea" id="mNote" maxlength="200" placeholder="记录核实时间、限制条件等，方便以后回看" style="min-height:70px">' + esc(m ? m.note : '') + '</textarea>' +
        '</div>' +
      '</div>';
    openModal({
      title: m ? '编辑模型' : '新增模型',
      sub: '带星号的必填，其余可以之后补',
      size: 'lg',
      body: body,
      note: '免费政策会变，记得定期核实',
      buttons: btn('取消', 'close') + btn(m ? '保存修改' : '确认新增', 'save-model', 'btn-primary')
    });
    dlgBody.dataset.editId = m ? m.id : '';
  }

  function opt(v, on) {
    return '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(v) + '</option>';
  }

  function modalApi(id) {
    var a = id ? findById(DB.apis, id) : null;
    var cur = a ? a.scopes : [];
    var pName = (a ? a.name : (pendingApiPrefill ? pendingApiPrefill.vendor : ''));
    var pVendor = (a ? a.vendor : (pendingApiPrefill ? pendingApiPrefill.vendor : ''));
    var pUrl = (a ? a.baseUrl : (pendingApiPrefill ? pendingApiPrefill.baseUrl : ''));
    pendingApiPrefill = null;
    var tplOpts = '<option value="">（自定义）</option>' +
      Object.keys(API_TEMPLATES).map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(API_TEMPLATES[k].label) + '</option>';
      }).join('');
    var body =
      '<div class="form-grid">' +
        '<div class="field">' +
          '<label for="aName">接口名称<span class="req">*</span></label>' +
          '<input class="input" id="aName" type="text" maxlength="30" placeholder="例如：百炼-通用" value="' + esc(pName) + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="aTpl">平台模板（快速填充）</label>' +
          '<select class="select" id="aTpl">' + tplOpts + '</select>' +
          '<p class="hint">选一个常见平台会自动填入 Base URL 和厂商</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="aVendor">平台</label>' +
          '<input class="input" id="aVendor" type="text" maxlength="30" placeholder="例如：阿里云百炼" value="' + esc(pVendor) + '">' +
        '</div>' +
        '<div class="field full">' +
          '<label for="aUrl">Base URL<span class="req">*</span></label>' +
          '<input class="input" id="aUrl" type="text" maxlength="120" placeholder="https://example.com/v1" value="' + esc(pUrl) + '">' +
          '<p class="hint">以 http 或 https 开头，通常结尾带 /v1</p>' +
        '</div>' +
        '<div class="field full">' +
          '<label for="aKey">API Key</label>' +
          '<input class="input" id="aKey" type="text" maxlength="120" placeholder="不填也可以保存，后续再补" value="' + esc(a ? a.key : '') + '">' +
          '<p class="hint">只存在本机浏览器。不确定就先留占位值，别填真实密钥</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="aStatus">状态</label>' +
          '<select class="select" id="aStatus">' +
            opt('正常', a && a.status === '正常') + opt('未配置', a && a.status === '未配置') + opt('已过期', a && a.status === '已过期') +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="aExpire">到期日期</label>' +
          '<input class="input" id="aExpire" type="date" value="' + esc(a ? a.expire : '') + '">' +
          '<p class="hint">留空表示长期有效</p>' +
        '</div>' +
        '<div class="field full">' +
          '<label>用途</label>' +
          '<div class="mc-tags" id="aScopes" style="gap:8px">' +
            SCOPES.map(function (s) {
              return '<button class="tag' + (cur.indexOf(s) >= 0 ? ' tag-violet' : '') + '" type="button" data-scope="' + s + '" style="height:30px;padding:0 12px;cursor:pointer">' + s + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>';
    openModal({
      title: a ? '编辑接口' : '新增接口',
      sub: '密钥默认掩码显示，可在设置里临时关闭',
      size: 'lg',
      body: body,
      note: '信息只保存在这台电脑',
      buttons: btn('取消', 'close') + btn(a ? '保存修改' : '确认新增', 'save-api', 'btn-primary')
    });
    dlgBody.dataset.editId = a ? a.id : '';
  }

  /* ---------- 模块：上游路由（代理 config.json routes 管理） ---------- */
  function adminHeaders() {
    var h = mhdr();
    if (DB.proxyMasterToken) h['x-proxy-token'] = DB.proxyMasterToken;
    return h;
  }

  // 拉取代理主控 token 状态（仅知是否已设置，不返回 token 值）
  function loadAdminTokenState() {
    if (!proxyOnline) {
      proxyAdminTokenState = { hasToken: false, text: '代理未运行' };
      renderAdminTokenState();
      return;
    }
    fetch(PROXY_V1 + '/admin/token', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        proxyAdminTokenState = j.hasToken
          ? { hasToken: true, text: '已设置主控 Key（本地来源免校验可直接管理）' }
          : { hasToken: false, text: '未设置主控 Key（当前为本地体验模式）' };
        renderAdminTokenState();
      })
      .catch(function () {
        proxyAdminTokenState = { hasToken: false, text: '读取状态失败' };
        renderAdminTokenState();
      });
  }
  function renderAdminTokenState() {
    var box = document.getElementById('adminTokenState');
    if (box) box.textContent = proxyAdminTokenState.text;
  }

  function openAdminTokenModal() {
    openModal({
      title: '设置/重置代理主控 Key',
      sub: '写入 config.json 的 token 字段，所有管理操作（路由/Key）本地来源均免校验',
      size: 'md',
      body: '<div class="field">' +
          '<label for="adminToken">新的主控 Key</label>' +
          '<input class="input" id="adminToken" type="password" placeholder="建议 24 位以上随机字符串，或留空让系统生成">' +
          '<p class="hint">留空则自动生成。设置后 config.json 立即更新，当前页面刷新后仍可用本地模式管理。</p>' +
        '</div>',
      buttons: btn('取消', 'close') + btn('确认设置', 'save-admin-token', 'btn-primary')
    });
  }

  function saveAdminToken() {
    var token = val('adminToken').trim();
    if (!token) {
      var arr = new Uint8Array(24);
      (window.crypto || crypto).getRandomValues(arr);
      token = Array.from(arr, function (b) { return b.toString(36); }).join('');
      toast('已自动生成主控 Key', 'ok');
    }
    fetch(PROXY_V1 + '/admin/token', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ token: token }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error && j.error.message ? j.error.message : '设置失败');
        DB.proxyMasterToken = token; save();
        proxyAdminTokenState = { hasToken: true, text: '已设置主控 Key（本地来源免校验可直接管理）' };
        closeModal(); renderAdminTokenState();
        toast('主控 Key 已更新并写入 config.json', 'ok');
      })
      .catch(function (e) { toast('设置失败：' + e.message, 'err'); });
  }

  function loadProxyRoutes() {
    if (proxyRoutesLoading) return Promise.resolve();
    proxyRoutesLoading = true;
    loadAdminTokenState();
    return fetch(PROXY_V1 + '/routes', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        proxyRoutes = (j.routes || []).map(function (r) {
          return {
            name: r.name, vendor: r.vendor, baseUrl: r.baseUrl,
            models: r.models || [], weight: (r.weight != null ? r.weight : 1),
            priority: (r.priority != null ? r.priority : 99), cost: (r.cost != null ? r.cost : 0),
            enabled: r.enabled !== false, hasKey: !!r.hasKey, keyMask: r.keyMask || ''
          };
        });
        renderBadges();
        renderRoutesBody();
      })
      .catch(function () { renderRoutesBody(); })
      .finally(function () { proxyRoutesLoading = false; });
  }

  // 目录模型 id 的裸名（用于判断是否已等价存在于路由 models）
  function bareModelId(id) { return String(id || '').split('/').pop().toLowerCase(); }
  function sameModelId(a, b) {
    if (a === b) return true;
    return bareModelId(a) === bareModelId(b);
  }

  // 将免费/限额模型目录同步到上游路由 models。
  // 触发点：目录刷新成功后、或用户手动点上游路由「同步免费模型」。
  // 同步规则：
  //   1) 只同步 type 为 free/quota/trial 的模型，跳过 expired；
  //   2) 按 vendor 匹配路由：OpenRouter 聚合厂商（无直连地址的）全部归到 OpenRouter 路由；
  //   3) 若路由 models 中已存在等价模型（完整匹配或裸名相同），不重复添加；
  //   4) 不删除路由中已有的模型，只做增量同步。
  function syncCatalogToRoutes() {
    // 目标：保证「免费目录」与「上游路由」的模型名一致，且路由里只保留上游真实模型名。
    // 关键约束：目录 id 带厂商前缀（如 sf/Qwen2.5-7B-Instruct、zhipu/glm-4-flash），
    // 它不是上游真实模型名。若把带前缀的 id 写进路由，代理 forwardTo 会原样发给上游 → 调不通。
    // 因此本函数只做「一致性校验」：路由里已存在裸名相同的真实模型名即视为已匹配；
    // 对无匹配的真实模型名，提示用户去路由面板手动添加，绝不注入带前缀的目录 id。
    if (!proxyOnline) { toast('代理未运行，无法同步路由', 'err'); return Promise.resolve(); }
    return loadProxyRoutes().then(function () {
      var routesByVendor = {};
      var openrouterRoute = null;
      proxyRoutes.forEach(function (r) {
        routesByVendor[r.vendor] = r;
        if (r.vendor === 'Openrouter' || r.baseUrl === 'https://openrouter.ai/api/v1') openrouterRoute = r;
      });
      var matched = 0, warnings = [];
      getCatalog().forEach(function (c) {
        if (c.type === 'expired') return;
        var isOpenRouterAgg = VENDOR_BASE[c.vendor] === 'https://openrouter.ai/api/v1' && c.vendor !== 'Openrouter';
        var r = isOpenRouterAgg ? openrouterRoute : routesByVendor[c.vendor];
        if (!r) return;
        // 路由里是否已存在「裸名相同」的真实上游模型名（如 Qwen/Qwen2.5-7B-Instruct）
        var hasReal = r.models.some(function (m) { return sameModelId(m, c.id); });
        if (hasReal) { matched++; return; }
        // 无匹配：目录 id 带前缀，不是上游真实名，不能写入路由。提示手动在路由里添加真实模型名。
        warnings.push(r.name + ' ← 目录『' + c.vendor + ' / ' + c.id + '』');
      });
      if (warnings.length) {
        console.warn('[syncCatalogToRoutes] 以下免费模型在路由中无对应真实模型名，未自动写入（避免调不通），请到对应路由手动添加真实上游模型名：\n' + warnings.join('\n'));
        toast('有 ' + warnings.length + ' 个免费模型在路由无对应真实模型名，已跳过写入（详见控制台）。路由模型名必须填上游真实名，不能是带前缀的目录 id。', 'warn');
      } else {
        toast('上游路由已与免费目录一致（' + matched + ' 个模型名匹配）', 'ok');
      }
      return Promise.resolve();
    }).catch(function (e) { toast('同步失败：' + e.message, 'err'); });
  }

  function upRouteCardHtml(r) {
    var on = !!r.enabled;
    var models = r.models || [];
    var modelTags = models.slice(0, 8).map(function (m) {
      var cls = /vision|4v|vl|image|mm-| multimodal|多模态/i.test(m) ? 'is-vision' : 'is-chat';
      return '<span class="model-tag ' + cls + '">' + esc(m) + '</span>';
    }).join('');
    if (models.length > 8) modelTags += '<span class="more">+' + (models.length - 8) + '</span>';
    var keyChip = r.hasKey
      ? '<span class="chip chip-ok"><i></i>已配置</span>'
      : '<span class="chip chip-warn"><i></i>未填 Key</span>';
    return '<article class="relay-card' + (on ? '' : ' is-off') + '" data-name="' + esc(r.name) + '">' +
      '<div class="rc-head">' +
        '<span class="rc-dot ' + (on ? 'on' : 'off') + '" aria-hidden="true"></span>' +
        '<div class="rc-title">' +
          '<div class="rc-name">' + esc(r.name) + '</div>' +
          '<div class="rc-sub">' + esc(r.vendor) + '</div>' +
        '</div>' +
        '<span class="chip ' + (on ? 'chip-ok' : 'chip-mute') + '">' + (on ? '已启用' : '已停用') + '</span>' +
      '</div>' +
      '<div class="rc-body">' +
        '<div class="ur-meta">' +
          '<span class="ur-url" title="Base URL"><span class="mono">' + esc(r.baseUrl || '—') + '</span></span>' +
          '<span class="ur-key">Key ' + keyChip + '</span>' +
        '</div>' +
        '<div class="rc-models">' + (modelTags || '<span class="rc-usage-empty">未配置模型</span>') + '</div>' +
      '</div>' +
      '<div class="rc-foot">' +
        '<span class="rc-weight">权重 <b>' + (r.weight != null ? r.weight : 1) + '</b> · 优先级 <b>' + (r.priority != null ? r.priority : 99) + '</b></span>' +
        '<span class="rc-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="uproute-edit" data-name="' + esc(r.name) + '" data-tip="编辑">' + ICON.edit + '</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="uproute-toggle" data-name="' + esc(r.name) + '">' + (on ? '停用' : '启用') + '</button>' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="uproute-test" data-name="' + esc(r.name) + '" data-tip="测试连通性">' + ICON.bolt + '测试</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-act="uproute-del" data-name="' + esc(r.name) + '" data-tip="删除">' + ICON.trash + '</button>' +
        '</span>' +
      '</div>' +
    '</article>';
  }

  function routesTableHtml(routes) {
    if (!proxyOnline) {
      return '<div class="panel-body"><div class="state-empty"><p>代理未在本地运行，无法读取 / 写入上游路由。</p>' +
        '<p class="hint">启动代理：<code>node proxy/proxy.js</code>（或双击 <code>proxy/start-proxy.bat</code>）。代理运行后点「刷新」即可加载路由表。</p></div></div>';
    }
    var listPanel = '<div class="panel-head"><div><h2>上游路由</h2><p class="ph-sub">共 ' + routes.length + ' 条，保存即写入 config.json 并热加载</p></div></div>';
    if (!routes.length) {
      return listPanel + '<div class="panel-body"><div class="state-empty"><p>还没有任何上游路由。</p>' +
        '<p class="hint">点「新增路由」配置一个厂商的 Base URL + Key；或点「从 API 管理导入」把已记录的接口一键转为路由。</p></div></div>';
    }
    var cards = routes.map(upRouteCardHtml).join('');
    return listPanel + '<div class="panel-body"><div class="relay-grid">' + cards + '</div>' +
      '<p class="hint" style="margin-top:12px">路由保存后自动写入 config.json 并热加载；填写了具体模型的路由可勾选「同步为已启用模型」，让 <code>/v1/auto</code> 能直接选用。</p>' +
      '</div>';
  }

  function renderRoutesBody() {
    var box = document.getElementById('upRoutesBody');
    if (!box) return;
    box.innerHTML = '<section class="panel">' + routesTableHtml(proxyRoutes) + '</section>';
  }

  // 把前端「账号清单（接口配置）」里已填的 key，按厂商同步进代理路由的 config.json。
  // 这是根治「前端确认 key 有效、但代理一直用旧 key 导致 401/404」断开的关键：
  // 代理调用上游用的是 config.json 的 apiKey，与前端 DB.apis 的 key 是两套独立存储。
  function syncKeysToProxy() {
    if (!proxyOnline) { toast('代理未运行，无法同步密钥', 'err'); return; }
    var synced = 0, skipped = 0, noRoute = 0;
    var seq = Promise.resolve();
    DB.apis.forEach(function (a) {
      if (!a.key) { skipped++; return; }
      var r = proxyRoutes.find(function (x) { return x.vendor === a.vendor || x.baseUrl === a.baseUrl; });
      if (!r) { noRoute++; return; }
      seq = seq.then(function () {
        return fetch(PROXY_V1 + '/routes', {
          method: 'POST', headers: adminHeaders(),
          body: JSON.stringify({ name: r.name, vendor: r.vendor, apiKey: a.key })
        }).then(function (x) {
          if (x.ok) { synced++; r.apiKey = a.key; }
          else { console.warn('[syncKeysToProxy] 路由 ' + r.name + ' 写入失败 HTTP ' + x.status); }
        });
      });
    });
    return seq.then(function () {
      var msg = '已把 ' + synced + ' 个接口密钥同步到代理路由';
      if (noRoute) msg += '；' + noRoute + ' 个接口无对应路由';
      if (skipped) msg += '；' + skipped + ' 个接口未填密钥已跳过';
      toast(msg, synced ? 'ok' : 'warn');
      return loadProxyRoutes();
    }).catch(function (e) { toast('同步失败：' + e.message, 'err'); });
  }
  function viewRoutes() {
    var head = '<div class="page-head">' +
      '<div class="ph-text">' +
        '<h1>上游路由</h1>' +
        '<p>直接管理本地代理 <code>config.json</code> 的 <code>routes</code>（上游路由）：逐厂商配置 Base URL 与 API Key，保存即同步到代理并热加载。这是 <code>/v1/auto</code> 意图识别真正读取的路由表。</p>' +
      '</div>' +
      '<div class="ph-actions">' +
        '<button class="btn btn-outline" type="button" data-act="refresh">' + ICON.refresh + '刷新</button>' +
        '<button class="btn btn-outline" type="button" data-act="uproute-sync-catalog">' + ICON.layers + '同步免费模型</button>' +
        '<button class="btn btn-primary" type="button" data-act="uproute-sync-keys">' + ICON.key + '同步密钥到代理</button>' +
        '<button class="btn btn-outline" type="button" data-act="uproute-import">' + ICON.copy + '从 API 管理导入</button>' +
        '<button class="btn btn-primary" type="button" data-act="uproute-add">' + ICON.plus + '新增路由</button>' +
      '</div></div>';

    var strip = '<section class="panel proxy-strip">' +
      '<div class="panel-head"><div><h2>本地代理</h2><p class="ph-sub">统一入口 ' + PROXY_V1 + '</p></div>' +
        '<span class="row-actions">' +
          '<button class="btn btn-outline btn-sm" type="button" data-act="admin-token">' + ICON.key + '设置主控 Key</button>' +
        '</span></div>' +
      '<div class="panel-body"><div id="proxyStatus" class="proxy-status">检测中…</div>' +
      '<div class="field" style="margin-top:12px">' +
        '<label>代理管理 Key 状态</label>' +
        '<div id="adminTokenState" class="readonly-box">' + esc(proxyAdminTokenState.text) + '</div>' +
        '<p class="hint">本地页面可直接设置/重置主控 Key，无需手动编辑 config.json。设置后会写入 config.json 并立即生效。调用接口时仍可额外配置「应用 Key」。</p>' +
      '</div>' +
      '</div></section>';

    return head + strip + '<div id="upRoutesBody">' + routesTableHtml(proxyRoutes) + '</div>';
  }

  function findProxyRoute(name) {
    for (var i = 0; i < proxyRoutes.length; i++) if (proxyRoutes[i].name === name) return proxyRoutes[i];
    return null;
  }

  function openUpRouteModal(route) {
    var r = route || null;
    var body =
      '<div class="form-grid">' +
        '<div class="field">' +
          '<label for="upName">路由名称<span class="req">*</span></label>' +
          '<input class="input" id="upName" type="text" maxlength="40" placeholder="例如：OpenRouter / DeepSeek" value="' + esc(r ? r.name : '') + '">' +
          '<p class="hint">作为路由主键；与代理 config.json 的 name 一致，重复名会覆盖更新。</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="upVendor">厂商标识</label>' +
          '<input class="input" id="upVendor" type="text" maxlength="40" placeholder="例如：DeepSeek / OpenRouter" value="' + esc(r ? r.vendor : '') + '">' +
        '</div>' +
        '<div class="field full">' +
          '<label for="upBase">Base URL（OpenAI 兼容 /v1）</label>' +
          '<input class="input" id="upBase" type="text" placeholder="https://api.deepseek.com/v1" value="' + esc(r ? r.baseUrl : '') + '">' +
        '</div>' +
        '<div class="field full">' +
          '<label for="upKey">API Key</label>' +
          '<input class="input" id="upKey" type="password" placeholder="sk-..." value="">' +
          '<p class="hint">留空则保留代理中已有的 Key（不覆盖）。保存即写入 config.json。</p>' +
        '</div>' +
        '<div class="field full">' +
          '<label for="upModels">模型列表（逗号或换行分隔）</label>' +
          '<textarea class="input" id="upModels" rows="3" placeholder="deepseek-chat, deepseek-reasoner">' + esc(r ? (r.models || []).join(', ') : '') + '</textarea>' +
          '<p class="hint">带厂商前缀（如 <code>deepseek/deepseek-chat</code>）也能命中；代理会自动归一化为上游原生名。</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="upWeight">权重（1-100）</label>' +
          '<input class="input" id="upWeight" type="number" min="1" max="100" step="1" value="' + (r ? r.weight : 1) + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="upPriority">优先级（越小越优先）</label>' +
          '<input class="input" id="upPriority" type="number" min="1" max="999" step="1" value="' + (r ? r.priority : 99) + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="upEnabled">是否启用</label>' +
          '<select class="select" id="upEnabled">' +
            '<option value="1"' + (!r || r.enabled ? ' selected' : '') + '>启用</option>' +
            '<option value="0"' + (r && !r.enabled ? ' selected' : '') + '>停用</option>' +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="upSync">同步为已启用模型</label>' +
          '<select class="select" id="upSync">' +
            '<option value="1"' + (!r ? ' selected' : '') + '>是（供 /v1/auto 选用）</option>' +
            '<option value="0">否</option>' +
          '</select>' +
        '</div>' +
      '</div>';
    openModal({
      title: r ? '编辑上游路由：' + r.name : '新增上游路由',
      sub: '保存即写入本地代理 config.json（热加载）',
      size: 'lg',
      body: body,
      buttons: btn('取消', 'close') + btn(r ? '保存修改' : '确认新增', 'save-uproute', 'btn-primary')
    });
    dlgBody.dataset.editName = r ? r.name : '';
  }

  function saveUpRoute() {
    if (!proxyOnline) { toast('代理未运行，无法写入路由', 'err'); return; }
    var name = val('upName').trim();
    if (!name) { toast('请填写路由名称', 'err'); return; }
    var vendor = val('upVendor').trim() || name;
    var baseUrl = val('upBase').trim();
    var apiKey = val('upKey').trim();
    var modelsRaw = val('upModels');
    var models = modelsRaw.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    var weight = Number(val('upWeight')) || 1;
    var priority = Number(val('upPriority')) || 99;
    var enabled = val('upEnabled') === '1';
    var sync = val('upSync') === '1';
    var editName = dlgBody.dataset.editName || '';
    var body = { name: name, vendor: vendor, baseUrl: baseUrl, models: models, weight: weight, priority: priority, enabled: enabled };
    if (apiKey) body.apiKey = apiKey;
    if (editName && editName !== name) body.oldName = editName;
    if (dlgBusy) dlgBusy.hidden = false;
    fetch(PROXY_V1 + '/routes', { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok && j.error) throw new Error(j.error.message || '代理返回失败');
        if (editName && editName !== name) {
          return fetch(PROXY_V1 + '/routes', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'delete', name: editName }) });
        }
        return null;
      })
      .then(function () {
        closeModal();
        toast('已写入本地代理：' + name, 'ok');
        if (sync && models.length) syncEnabledForRoute(models);
        loadProxyRoutes();
      })
      .catch(function (e) {
        toast('写入失败：' + e.message + (e.message.indexOf('401') >= 0 ? '（管理 Key 不匹配？）' : ''), 'err');
      })
      .finally(function () { if (dlgBusy) dlgBusy.hidden = true; });
  }

  function toggleUpRoute(name) {
    var r = findProxyRoute(name);
    if (!r) return;
    fetch(PROXY_V1 + '/routes', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ name: name, enabled: !r.enabled })
    })
      .then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); })
      .then(function () { toast(name + ' 已' + (r.enabled ? '停用' : '启用'), 'ok'); loadProxyRoutes(); })
      .catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }

  function deleteUpRoute(name) {
    modalConfirm('删除上游路由', '确认删除路由「' + name + '」？该操作会从 config.json 真正移除它。', '删除', 'do-uproute-del:' + name, true);
  }

  function doDeleteUpRoute(name) {
    fetch(PROXY_V1 + '/routes', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ action: 'delete', name: name })
    })
      .then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); })
      .then(function () { toast('已删除路由：' + name, 'ok'); closeModal(); loadProxyRoutes(); })
      .catch(function (e) { toast('删除失败：' + e.message, 'err'); });
  }

  function ensureRelayToken() {
    if (typeof DB.proxyMasterToken === 'string' && DB.proxyMasterToken) return Promise.resolve(DB.proxyMasterToken);
    if (typeof DB.relayToken === 'string' && DB.relayToken) return Promise.resolve(DB.relayToken);
    // 生成「应用 Key」而非重置主控 Key；/token/generate 会覆盖 config.token，改用 /tokens create
    return fetch(PROXY_V1 + '/tokens', {
      method: 'POST',
      headers: mhdr(),
      body: JSON.stringify({ action: 'create', name: '中转测试Key' })
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.token) throw new Error('代理未返回 token');
        DB.relayToken = j.token; save();
        return j.token;
      });
  }
  function testUpRoute(name) {
    var r = findProxyRoute(name);
    if (!r) return;
    if (!proxyOnline) { toast('代理未运行，无法测试路由', 'err'); return; }
    // 调用端点必须鉴权：优先用已生成的中转站 Key；没有则自动生成（代理会回写 config.token）。
    ensureRelayToken().then(function (tok) {
      var model = (r.models && r.models.length) ? r.models[0] : name;
      toast('正在测试路由 ' + name + '（' + model + '）…', 'ok');
      fetch(PROXY_V1 + '/chat/completions', {
        method: 'POST',
        headers: mhdr({ 'x-proxy-token': tok }),
        body: JSON.stringify({ model: model, messages: [{ role: 'user', content: 'ping' }], stream: false })
      })
        .then(function (x) {
          if (x.ok) return x.json().then(function (j) {
            if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            toast('路由 ' + name + ' 连通成功', 'ok');
          });
          // 非 2xx：尽量解析上游真实错误体透出，避免只甩 HTTP 码
          return x.text().then(function (t) {
            var msg = 'HTTP ' + x.status;
            try { var j = JSON.parse(t); if (j && j.error && j.error.message) msg += '：' + j.error.message; } catch (e) {}
            throw new Error(msg);
          });
        })
        .then(function () {})
        .catch(function (e) {
          var m = e.message || '';
          var hint = /invalid model|model not found|not exist|unsupported model|does not exist/i.test(m)
            ? '；多为模型名不是该平台真实模型 id，请在路由里改成上游实际 model' : '';
          toast('路由 ' + name + ' 测试失败：' + m + hint, 'err');
        });
    }).catch(function (e) { toast('无法获取中转站 Key：' + e.message, 'err'); });
  }

  function importUpRoute() {
    if (!DB.apis.length) { toast('API 管理里还没有任何接口', 'err'); return; }
    var body = '<p class="hint">选择要转为上游路由的接口（按厂商 Base URL + Key 生成一条 routes 记录）：</p>' +
      '<div class="pick-list">' + DB.apis.map(function (a, i) {
        return '<button class="pick-item" type="button" data-mact="uproute-pick:' + i + '">' +
          '<div class="t-main">' + esc(a.name) + '</div>' +
          '<div class="t-sub mono">' + esc(a.baseUrl) + '</div>' +
        '</button>';
      }).join('') + '</div>';
    openModal({ title: '从 API 管理导入', sub: '生成上游路由草稿', size: 'md', body: body, buttons: btn('取消', 'close') });
  }

  function syncEnabledForRoute(models) {
    if (!proxyOnline || !models || !models.length) return;
    fetch(PROXY_V1 + '/enabled', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var cur = (j.models || []).map(function (m) { return (m && m.id) ? m.id : m; });
        var merged = cur.slice();
        models.forEach(function (m) { if (merged.indexOf(m) < 0) merged.push(m); });
        return fetch(PROXY_V1 + '/enabled', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ models: merged }) });
      })
      .then(function () { toast('已同步为已启用模型（供 /v1/auto）', 'ok'); })
      .catch(function () { /* 非致命：路由本身已生效 */ });
  }

  function modalRoute(id) {
    var r = id ? findById(DB.routes, id) : null;
    var apiOpts = DB.apis.map(function (a) {
      return '<option value="' + esc(a.name) + '"' + (r && r.upstream === a.name ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('');
    var modelOpts = DB.models.map(function (m) {
      return '<option value="' + esc(m.name) + '"' + (r && r.model === m.name ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('');
    var body =
      '<div class="form-grid">' +
        '<div class="field full">' +
          '<label for="rName">规则名称<span class="req">*</span></label>' +
          '<input class="input" id="rName" type="text" maxlength="30" placeholder="例如：对话-主线路" value="' + esc(r ? r.name : '') + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="rUp">上游接口</label>' +
          '<select class="select" id="rUp">' + (apiOpts || '<option value="">（请先在 API 管理里新增接口）</option>') + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="rModel">目标模型</label>' +
          '<select class="select" id="rModel">' + (modelOpts || '<option value="">（请先新增模型）</option>') + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="rWeight">权重（0-100）</label>' +
          '<input class="input" id="rWeight" type="number" min="0" max="100" step="5" value="' + (r ? r.weight : 50) + '">' +
          '<p class="hint">同一用途的多条规则按权重分配</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="rEnabled">是否启用</label>' +
          '<select class="select" id="rEnabled">' +
            '<option value="1"' + (!r || r.enabled ? ' selected' : '') + '>启用</option>' +
            '<option value="0"' + (r && !r.enabled ? ' selected' : '') + '>停用</option>' +
          '</select>' +
        '</div>' +
        '<div class="field full">' +
          '<label for="rNote">备注</label>' +
          '<input class="input" id="rNote" type="text" maxlength="60" placeholder="例如：主线路超时后接管" value="' + esc(r ? r.note : '') + '">' +
        '</div>' +
      '</div>';
    openModal({
      title: r ? '编辑规则' : '新增规则',
      sub: '上游接口和模型都从已有列表里选',
      size: 'lg',
      body: body,
      note: '至少配两条同用途规则才有 failover 效果',
      buttons: btn('取消', 'close') + btn(r ? '保存修改' : '确认新增', 'save-route', 'btn-primary')
    });
    dlgBody.dataset.editId = r ? r.id : '';
  }

  function modalConfirm(title, desc, okText, act, danger) {
    openModal({
      title: title,
      body: '<p style="font-size:14.5px;color:var(--ink-2);line-height:1.7">' + esc(desc) + '</p>',
      buttons: btn('取消', 'close') + btn(okText, act, danger ? 'btn-danger' : 'btn-primary')
    });
  }

  function modalResult(payload) {
    var body =
      '<div class="result-block">' +
        '<div class="rb-head">' + ICON.check + '场景摘要</div>' +
        '<div class="rb-body"><dl class="kv">' +
          '<dt>生成时间</dt><dd>' + fmtFull(Date.now()) + '</dd>' +
          '<dt>摘要</dt><dd>' + esc(payload.summary) + '</dd>' +
        '</dl></div>' +
      '</div>' +
      '<div class="result-block">' +
        '<div class="rb-head">' + ICON.bolt + '调用示例（curl）' +
          '<span class="rb-right"><button class="btn btn-ghost btn-sm" type="button" data-mact="copy-curl">' + ICON.copy + '复制</button></span>' +
        '</div>' +
        '<div class="rb-body"><div class="code-block"><pre id="codeCurl">' + esc(payload.curl) + '</pre>' +
          '<button class="copy btn btn-ghost btn-sm" type="button" data-mact="copy-curl" aria-label="复制 curl">复制</button></div></div>' +
      '</div>' +
      '<div class="result-block">' +
        '<div class="rb-head">' + ICON.layers + '请求体（JSON）' +
          '<span class="rb-right"><button class="btn btn-ghost btn-sm" type="button" data-mact="copy-json">' + ICON.copy + '复制</button></span>' +
        '</div>' +
        '<div class="rb-body"><div class="code-block"><pre id="codeJson">' + esc(payload.json) + '</pre>' +
          '<button class="copy btn btn-ghost btn-sm" type="button" data-mact="copy-json" aria-label="复制 JSON">复制</button></div></div>' +
      '</div>' +
      '<p class="hint" style="margin-top:14px">把 <code>$YOUR_API_KEY</code> 换成真实密钥再执行。示例按你填的情境拼接，未做任何联网请求。</p>';
    openModal({
      title: '生成结果',
      sub: '内容基于你填写的场景，在本地拼接生成',
      size: 'lg',
      body: body,
      note: '结果不会自动保存',
      buttons: btn('重新生成', 'regen', 'btn-outline') + btn('知道了', 'close', 'btn-primary')
    });
  }

  function modalLogs() {
    var realLogs = proxyOnline ? proxyLogs : [];
    var src = realLogs.length ? realLogs : DB.logs;
    var rows = src.map(logRowHtml).join('');
    var sub = realLogs.length
      ? '真实记录（来自本地代理）· 共 ' + src.length + ' 条'
      : (proxyOnline ? '暂无调用记录' : '代理未运行，显示本地示例/测试数据 · 共 ' + src.length + ' 条');
    var btns = (proxyOnline ? btn('清空代理日志', 'clear-proxy-logs', 'btn-danger') : '') + btn('关闭', 'close', 'btn-primary');
    openModal({
      title: '全部调用记录',
      sub: sub,
      size: 'lg',
      body: '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>模型</th><th>上游</th><th>状态</th><th>延迟</th><th>Tokens</th></tr></thead><tbody>' + rows + '</tbody></table></div>',
      buttons: btns
    });
  }

  /* ============================================================
     交互层：改数据 → 调 refreshAll
     ============================================================ */
  var toastTimer = null;
  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2400);
  }

  function enterApp() {
    DB.entered = true; DB.enteredAt = Date.now();
    save();
    document.getElementById('viewWelcome').hidden = true;
    document.getElementById('viewApp').hidden = false;
    window.scrollTo(0, 0);
    refreshAll();
    toast('已进入工作台，当前是本地体验版');
  }

  function backHome() {
    document.getElementById('viewApp').hidden = true;
    document.getElementById('viewWelcome').hidden = false;
    window.scrollTo(0, 0);
  }

  function switchModule(mod) {
    if (DB.module === mod) return;
    DB.module = mod;
    save();
    refreshAll();
  }

  function setDemoState(v) {
    DB.settings.demoState = v;
    save();
    refreshAll();
  }

  function markError(fieldId, on) {
    var f = document.getElementById(fieldId);
    if (f) f.classList.toggle('is-error', !!on);
  }

  function validateGen() {
    var g = DB.gen;
    var ok = true;
    if (!g.stage) { markError('fStage', true); ok = false; } else markError('fStage', false);
    if (g.goal === '自定义目标' && !g.custom.trim()) { markError('fGoal', true); markError('fCustom', true); ok = false; }
    else { markError('fGoal', false); markError('fCustom', false); }
    if (g.scene.trim().length < 10) { markError('fScene', true); ok = false; } else markError('fScene', false);
    return ok;
  }

  function runGenerate() {
    if (!validateGen()) { toast('还有必填项没写完', 'err'); return; }
    var b = document.getElementById('genBtn');
    if (!b) return;
    b.classList.add('is-loading');
    b.disabled = true;
    setTimeout(function () {
      b.classList.remove('is-loading');
      b.disabled = false;
      modalResult(genPayload());
    }, 900);
  }

  function copyText(txt, tip) {
    var done = function () { toast(tip || '已复制到剪贴板', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { toast('复制失败，请手动选择文本', 'err'); }
    }
  }

  function exportData() {
    try {
      var blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'free-api-backup-' + fmtDate(Date.now()) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('备份文件已下载', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  /* ============================================================
     真实功能：导入导出、情报采集、连通测试、中转调用
     ============================================================ */
  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();

  function ab2b64(buf) {
    var bytes = new Uint8Array(buf), binary = '', i;
    for (i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }
  function b642ab(str) {
    var binary = window.atob(str), bytes = new Uint8Array(binary.length), i;
    for (i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  async function deriveKey(password, salt) {
    var mat = await crypto.subtle.importKey('raw', textEncoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, mat, 256);
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptData(plain, password) {
    var salt = randomBytes(16), iv = randomBytes(12);
    var key = await deriveKey(password, salt);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, textEncoder.encode(plain));
    return JSON.stringify({ v: 1, salt: ab2b64(salt), iv: ab2b64(iv), ct: ab2b64(ct) });
  }

  async function decryptData(payload, password) {
    var p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    var key = await deriveKey(password, b642ab(p.salt));
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b642ab(p.iv) }, key, b642ab(p.ct));
    return textDecoder.decode(pt);
  }

  // ---------- 密钥保险库（本地静态加密，口令解锁） ----------
  function vaultIsLocked() {
    if (!DB.settings.vaultOn) return false;
    return DB.apis.some(function (a) { return a && a.keyEnc && !a.key; });
  }
  async function encryptAllKeys(pass) {
    for (var i = 0; i < DB.apis.length; i++) {
      var a = DB.apis[i];
      if (a && a.key) a.keyEnc = await encryptData(a.key, pass);
    }
  }
  async function decryptAllKeys(pass) {
    var dec = [];
    for (var i = 0; i < DB.apis.length; i++) {
      dec.push((DB.apis[i] && DB.apis[i].keyEnc) ? await decryptData(DB.apis[i].keyEnc, pass) : undefined);
    }
    for (var i = 0; i < DB.apis.length; i++) {
      if (DB.apis[i] && dec[i] !== undefined) DB.apis[i].key = dec[i];
    }
  }
  async function enableVault(pass) {
    DB.settings.vaultOn = true;
    await encryptAllKeys(pass);
    vaultPass = pass; vaultUnlocked = true;
    save();
  }
  function disableVault() {
    DB.settings.vaultOn = false;
    DB.apis.forEach(function (a) { if (a) a.keyEnc = ''; });
    vaultPass = null; vaultUnlocked = false;
    save();
  }
  function vaultPassFormHtml() {
    return '<div class="field"><label for="vPass">设置口令（至少 4 位）</label>' +
      '<input class="input" id="vPass" type="password" maxlength="64" placeholder="设置口令"></div>' +
      '<div class="field"><label for="vPass2">确认口令</label>' +
      '<input class="input" id="vPass2" type="password" maxlength="64" placeholder="再输一次"></div>' +
      '<p class="hint">口令仅用于本次加密，不会保存在浏览器；忘记后已加密的密钥无法恢复。</p>';
  }
  function showVaultUnlock() {
    openModal({
      title: '解锁密钥保险库', sub: '输入口令以解密本地密钥',
      body: '<div class="field"><label for="vuPass">保险库口令</label>' +
        '<input class="input" id="vuPass" type="password" maxlength="64" placeholder="输入口令"></div>',
      buttons: btn('取消', 'close') + btn('解锁', 'do-vault-unlock', 'btn-primary')
    });
  }
  function toggleVault(b) {
    if (!DB.settings.vaultOn) {
      openModal({
        title: '设置保险库口令', sub: '此口令用于加密本地密钥，不会保存；忘记后密钥无法恢复',
        body: vaultPassFormHtml(),
        buttons: btn('取消', 'close') + btn('启用加密', 'do-vault-enable', 'btn-primary')
      });
    } else if (window.confirm('关闭后本地密钥将以明文存储，确定关闭？')) {
      disableVault();
      b.setAttribute('aria-checked', 'false');
      toast('已关闭保险库，密钥转为明文存储', 'ok');
    }
  }
  async function doVaultEnable(b) {
    var p1 = (val('vPass') || '').trim(), p2 = (val('vPass2') || '').trim();
    if (p1.length < 4) { toast('口令至少 4 位', 'err'); return; }
    if (p1 !== p2) { toast('两次输入不一致', 'err'); return; }
    await enableVault(p1);
    closeModal();
    b.setAttribute('aria-checked', 'true');
    toast('保险库已启用，密钥已加密', 'ok');
  }
  async function doVaultUnlock(b) {
    var p = (val('vuPass') || '').trim();
    if (!p) { toast('请输入口令', 'err'); return; }
    try {
      await decryptAllKeys(p);
      vaultPass = p; vaultUnlocked = true;
      closeModal(); refreshAll();
      toast('已解锁', 'ok');
    } catch (e) { toast('口令错误，无法解密', 'err'); }
  }

  function modalExport() {
    openModal({
      title: '导出备份',
      sub: '普通导出可直接打开；加密导出需要密码，适合包含真实密钥时传输',
      body:
        '<div class="field">' +
          '<label for="expPass">加密密码（留空则为普通 JSON 备份）</label>' +
          '<input class="input" id="expPass" type="password" maxlength="64" placeholder="设置一个导出密码">' +
          '<p class="hint">密码只用于本次导出文件，不会保存在浏览器里</p>' +
        '</div>',
      buttons: btn('取消', 'close') + btn('导出', 'do-export', 'btn-primary')
    });
  }

  async function doExport() {
    var pass = val('expPass').trim();
    try {
      var json = JSON.stringify(DB, null, 2);
      var blob;
      if (pass) {
        var enc = await encryptData(json, pass);
        blob = new Blob([enc], { type: 'application/json' });
      } else {
        blob = new Blob([json], { type: 'application/json' });
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'free-api-backup-' + fmtDate(Date.now()) + (pass ? '.encrypted.json' : '.json');
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      closeModal();
      toast(pass ? '加密备份已下载' : '备份文件已下载', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function modalImport() {
    openModal({
      title: '导入备份',
      sub: '支持普通 JSON 备份或加密备份',
      body:
        '<div class="field">' +
          '<label for="impText">备份内容</label>' +
          '<textarea class="textarea" id="impText" placeholder="将备份文件内容粘贴到这里" style="min-height:120px"></textarea>' +
        '</div>' +
        '<div class="field">' +
          '<label for="impPass">加密密码（普通备份留空）</label>' +
          '<input class="input" id="impPass" type="password" maxlength="64" placeholder="如果文件是加密的，填导出密码">' +
        '</div>' +
        '<p class="hint">导入会覆盖当前所有数据，建议先导出一份现有备份</p>',
      buttons: btn('取消', 'close') + btn('确认导入', 'do-import', 'btn-primary')
    });
  }

  async function doImport() {
    var text = val('impText').trim();
    var pass = val('impPass').trim();
    if (!text) { toast('请先粘贴备份内容', 'err'); return; }
    try {
      var raw = text;
      if (pass) raw = await decryptData(text, pass);
      var d = JSON.parse(raw);
      if (!d || d.version !== 2 || !Array.isArray(d.models) || !Array.isArray(d.apis)) {
        throw new Error('备份格式不正确');
      }
      DB = d;
      save();
      closeModal();
      refreshAll();
      if (DB.settings.vaultOn && vaultIsLocked()) showVaultUnlock();
      toast('导入成功', 'ok');
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
  }

  /* 目录新增 / 额度记录 / 导入弹窗 */
  function modalCatalogAdd() {
    var body =
      '<div class="form-grid">' +
        '<div class="field full">' +
          '<label for="cName">模型名称<span class="req">*</span></label>' +
          '<input class="input" id="cName" type="text" maxlength="60" placeholder="例如：Qwen2.5-7B-Instruct">' +
        '</div>' +
        '<div class="field">' +
          '<label for="cVendor">厂商</label>' +
          '<input class="input" id="cVendor" type="text" maxlength="30" placeholder="例如：阿里云百炼">' +
        '</div>' +
        '<div class="field">' +
          '<label for="cType">免费类型</label>' +
          '<select class="select" id="cType">' + opt('免费', true) + opt('限额', false) + opt('限免', false) + '</select>' +
        '</div>' +
        '<div class="field full">' +
          '<label for="cSite">申请 / 官网地址</label>' +
          '<input class="input" id="cSite" type="text" maxlength="120" placeholder="https://...">' +
        '</div>' +
        '<div class="field full">' +
          '<label for="cQuota">免费额度说明</label>' +
          '<input class="input" id="cQuota" type="text" maxlength="80" placeholder="例如：新用户赠 100 万 tokens">' +
        '</div>' +
        '<div class="field">' +
          '<label for="cMod">适用方向（逗号分隔）</label>' +
          '<input class="input" id="cMod" type="text" maxlength="40" placeholder="语言,对话,代码">' +
        '</div>' +
      '</div>';
    openModal({
      title: '新增免费模型', sub: '加入本地目录，标为待核实', size: 'lg',
      body: body, buttons: btn('取消', 'close') + btn('确认新增', 'save-catalog', 'btn-primary')
    });
  }
  function saveCatalog() {
    var name = val('cName').trim();
    if (!name) { var f = document.getElementById('cName'); if (f) f.focus(); toast('模型名称不能为空', 'err'); return; }
    DB.catalogUser.unshift({
      id: uid(), name: name, vendor: val('cVendor').trim() || '未标注',
      applyUrl: val('cSite').trim(), type: val('cType') || 'free',
      quota: val('cQuota').trim() || '待核实',
      modality: val('cMod').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      status: '待核实', verifiedAt: fmtDate(Date.now()), source: '手动新增', sourceUrl: '',
      note: '本地目录手动添加，请核实官网信息'
    });
    save(); closeModal(); refreshAll();
    toast('已加入本地目录', 'ok');
  }
  function modalCatalogKey(id) {
    var c = findCatalog(id);
    if (!c) { toast('模型不存在', 'err'); return; }
    var base = VENDOR_BASE[c.vendor] || c.vendorSite || '';
    // 根据代理在线状态切换提示与保存目标，避免“必须开启代理才能配置 Key”的误解
    var hint = proxyOnline
      ? '保存后写入本地代理的 routes，代理据此调用该模型。如需为同一厂商所有模型配置通用 Key，请去「上游路由」模块新增 models=* 的路由。'
      : '代理当前未运行。本次 Key 将暂存到「API 管理」，供你生成 curl 或后续同步到代理；如需直接写入代理 routes，请先启动本地代理。';
    var sub = proxyOnline ? '写入本地代理 routes' : '代理离线，暂存到本地 API 管理';
    var body =
      '<div class="field">' +
        '<label>模型</label>' +
        '<div class="readonly-box">' + esc(c.name) + '</div>' +
        '<p class="hint">' + esc(c.id) + ' · ' + esc(c.vendor) + '</p>' +
      '</div>' +
      '<div class="field">' +
        '<label for="kKey">API Key（只存本机，不发送第三方）</label>' +
        '<input class="input" id="kKey" type="password" placeholder="sk-...">' +
        '<p class="hint">' + hint + '</p>' +
      '</div>' +
      '<div class="field">' +
        '<label for="kBase">Base URL（OpenAI 兼容）</label>' +
        '<input class="input" id="kBase" type="text" placeholder="https://..." value="' + esc(base) + '">' +
      '</div>';
    openModal({
      title: '配置模型 Key：' + c.name, sub: sub, size: 'lg',
      body: body, buttons: btn('取消', 'close') + btn('保存', 'save-catalog-key:' + id, 'btn-primary')
    });
  }
  function saveCatalogKey(id) {
    var c = findCatalog(id);
    if (!c) { toast('模型不存在', 'err'); return; }
    var key = val('kKey').trim();
    if (!key) { toast('请填写 API Key', 'err'); return; }
    var base = val('kBase').trim();

    // 代理在线：直接写入代理 routes（这是主要路径）
    if (proxyOnline) {
      fetch(PROXY_V1 + '/routes', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ vendor: c.vendor, apiKey: key, baseUrl: base, models: [c.id], enabled: true })
      })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error('代理返回失败');
          DB.catalogVendorKey[c.vendor] = true; save(); closeModal(); refreshCatalogGrid();
          toast('已写入本地代理：' + c.name, 'ok');
        })
        .catch(function (e) {
          toast('写入失败：' + e.message + '。请确认本地代理已启动（双击 start-free-api-proxy.bat）', 'err');
        });
      return;
    }

    // 代理离线：降级为写入前端本地 DB.apis，确保非意图识别/非代理场景仍可继续配置
    var existing = null;
    for (var i = 0; i < DB.apis.length; i++) {
      var a = DB.apis[i];
      if (a.vendor === c.vendor && a.baseUrl === base) { existing = a; break; }
    }
    if (existing) {
      existing.key = key;
      existing.name = c.name + '（来自免费目录）';
      existing.status = '未配置';
    } else {
      DB.apis.unshift({
        id: uid(),
        name: c.name + '（来自免费目录）',
        vendor: c.vendor,
        baseUrl: base,
        key: key,
        status: '未配置',
        expire: '',
        scopes: (c.modality && c.modality.length) ? c.modality : ['语言']
      });
    }
    DB.catalogVendorKey[c.vendor] = true;
    save(); closeModal(); refreshCatalogGrid();
    toast('代理未运行，Key 已暂存到「API 管理」。启动代理后请到「上游路由」同步。', 'ok');
  }
  function modalCatalogImport() {
    var body =
      '<div class="field">' +
        '<label for="catFile">选择 models-catalog.json</label>' +
        '<input class="input" id="catFile" type="file" accept=".json,application/json">' +
        '<p class="hint">选择一份由 catalog/fetch-catalog.js 生成的目录 JSON，其中的模型会合并进本地目录（按 id 去重，同名覆盖）。</p>' +
      '</div>';
    openModal({
      title: '导入目录', sub: '合并到本地目录', size: 'lg',
      body: body, buttons: btn('取消', 'close') + btn('开始导入', 'do-catalog-import', 'btn-primary')
    });
  }
  function doCatalogImport() {
    var inp = document.getElementById('catFile');
    if (!inp || !inp.files || !inp.files.length) { toast('请先选择文件', 'err'); return; }
    var file = inp.files[0];
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var list = data.models || (Array.isArray(data) ? data : []);
        if (!list.length) { toast('文件里没有 models 数组', 'err'); return; }
        var added = 0;
        list.forEach(function (c) {
          if (!c || !c.id) return;
          DB.catalogUser = DB.catalogUser.filter(function (x) { return x.id !== c.id; });
          DB.catalogUser.push(c); added++;
        });
        save(); closeModal(); refreshAll();
        toast('已合并 ' + added + ' 条到本地目录', 'ok');
      } catch (e) { toast('解析失败：' + (e.message || '格式错误'), 'err'); }
    };
    reader.onerror = function () { toast('读取文件失败', 'err'); };
    reader.readAsText(file);
  }

  function parseIntellInput() {
    var ta = document.getElementById('intellText');
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) { toast('请先粘贴内容', 'err'); return; }
    var list = parseIntell(text);
    if (!list.length) { toast('没能解析出模型条目，请检查格式', 'err'); return; }
    var added = 0;
    list.forEach(function (c) {
      var name = (c.name || '').trim();
      if (!name) return;
      if (getCatalog().some(function (m) { return m.name === name; })) return;
      DB.catalogUser.unshift({
        id: uid(), name: name, vendor: (c.vendor || '未标注').slice(0, 30),
        applyUrl: (c.site || '').slice(0, 120), type: 'free',
        quota: (c.free || '待核实').slice(0, 60), modality: normalizeScopes(c.scopes),
        status: '待核实', verifiedAt: fmtDate(Date.now()), source: '情报采集', sourceUrl: '',
        note: '来自情报采集，请手动核实官网信息'
      });
      added++;
    });
    save(); refreshAll();
    ta.value = '';
    toast('已解析并导入 ' + added + ' 条模型到本地目录（标记为待核实）', 'ok');
  }

  function parseIntell(text) {
    var t = text.trim();
    if (t.charAt(0) === '[') {
      try { return JSON.parse(t); } catch (e) { return []; }
    }
    var lines = t.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l; });
    var sepIdx = -1, headers = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\|?[-:]+\|/.test(lines[i].replace(/\s/g, ''))) { sepIdx = i; headers = parseCells(lines[i - 1]); break; }
    }
    if (headers.length) {
      var map = mapHeaders(headers);
      var out = [];
      for (var j = sepIdx + 1; j < lines.length; j++) {
        if (!lines[j] || lines[j].indexOf('|') < 0) continue;
        var cells = parseCells(lines[j]);
        var obj = {};
        for (var k in map) { if (cells[map[k]] != null) obj[k] = cells[map[k]]; }
        if (obj.name) out.push(obj);
      }
      return out;
    }
    // 回退：按行解析“名称：xxx”模式
    var cur = {}, out2 = [];
    lines.forEach(function (line) {
      var m = line.match(/^\s*[-*]?\s*(模型|名称|Name)[：:]\s*(.+)/i);
      if (m) {
        if (cur.name) out2.push(cur);
        cur = { name: m[2] };
      } else if (cur.name) {
        var mm = line.match(/(?:厂商|提供方|Vendor)[：:]\s*(.+)/i); if (mm) cur.vendor = mm[1];
        mm = line.match(/(?:网站|Site|URL)[：:]\s*(.+)/i); if (mm) cur.site = mm[1];
        mm = line.match(/(?:免费额度|期限|Free)[：:]\s*(.+)/i); if (mm) cur.free = mm[1];
        mm = line.match(/(?:方向|适用|Scopes?)[：:]\s*(.+)/i); if (mm) cur.scopes = mm[1];
        mm = line.match(/(?:状态|Status)[：:]\s*(.+)/i); if (mm) cur.status = mm[1];
      }
    });
    if (cur.name) out2.push(cur);
    return out2;
  }

  function parseCells(line) {
    return line.split('|').map(function (c) { return c.trim(); }).filter(function (c) { return c !== ''; });
  }
  function mapHeaders(headers) {
    var map = {};
    headers.forEach(function (h, i) {
      var l = h.toLowerCase();
      if (/模型|名称|name|model/.test(l)) map.name = i;
      else if (/厂商|提供方|平台|vendor/.test(l)) map.vendor = i;
      else if (/网站|site|url|地址|链接/.test(l)) map.site = i;
      else if (/免费|额度|期限|free|tier/.test(l)) map.free = i;
      else if (/方向|适用|scope|类型|能力/.test(l)) map.scopes = i;
      else if (/状态|status|可用/.test(l)) map.status = i;
    });
    return map;
  }
  function normalizeScopes(s) {
    if (Array.isArray(s)) return s.filter(function (x) { return SCOPES.indexOf(x) >= 0; });
    if (!s) return [];
    return String(s).split(/[,，、\/]/).map(function (x) { return x.trim(); }).filter(function (x) { return SCOPES.indexOf(x) >= 0; });
  }
  function normalizeStatus(s) {
    var map = { '可用': '可用', '正常': '可用', '限频': '限频', '待核实': '待核实', '停用': '已停用', '已停用': '已停用', '已过期': '已停用' };
    return map[String(s || '').trim()] || '待核实';
  }

  function joinUrl(base, path) {
    base = (base || '').replace(/\/$/, '');
    path = (path || '').replace(/^\//, '');
    return base + '/' + path;
  }

  function fetchWithTimeout(url, opts, ms) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); reject(new Error('请求超时')); }, ms || 10000);
      fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}))
        .then(function (r) { clearTimeout(timer); resolve(r); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  async function testApi(id) {
    var a = findById(DB.apis, id);
    if (!a) return;
    if (!a.key) { toast('「' + a.name + '」还没填密钥，无法测试', 'err'); return; }
    var b = document.querySelector('[data-act="api-test"][data-id="' + id + '"]');
    if (b) { b.classList.add('is-loading'); b.disabled = true; }
    var started = Date.now();
    try {
      var url = joinUrl(a.baseUrl, '/models');
      var res = await fetchWithTimeout(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + a.key } }, 10000);
      var lat = Date.now() - started;
      recordLog({ model: '连通测试', upstream: a.name, status: res.status, latency: res.ok ? lat : 0, tokens: 0 });
      if (res.ok) { a.status = '正常'; toast('「' + a.name + '」连通正常（' + res.status + '，' + lat + ' ms）', 'ok'); }
      else if (res.status === 401) { a.status = '异常'; toast('「' + a.name + '」返回 401，密钥可能无效', 'err'); }
      else { a.status = '异常'; toast('「' + a.name + '」返回 ' + res.status, 'warn'); }
      save(); renderContent();
    } catch (e) {
      recordLog({ model: '连通测试', upstream: a.name, status: 0, latency: 0, tokens: 0 });
      a.status = '异常'; save(); renderContent();
      toast('「' + a.name + '」请求失败：' + (e.message || '网络/CORS 错误'), 'err');
    } finally {
      if (b) { b.classList.remove('is-loading'); b.disabled = false; }
    }
  }

  function recordLog(entry) {
    if (!entry || !entry.status) return;
    DB.logs.unshift({
      id: uid(), ts: Date.now(), model: entry.model || '—',
      upstream: entry.upstream || '—', status: entry.status,
      latency: entry.latency || 0, tokens: entry.tokens || 0
    });
    // 保留最近 500 条
    if (DB.logs.length > 500) DB.logs = DB.logs.slice(0, 500);
    save();
    refreshAll();
  }

  function askTestRoute(id) {
    var r = findById(DB.routes, id);
    if (!r) return;
    var a = findApiByName(r.upstream);
    if (!a) {
      modalConfirm('上游接口缺失，是否直接走本地代理测试？',
        '规则「' + esc(r.name) + '」指向的上游接口「' + esc(r.upstream) + '」未配置。将直接向本地代理 ' + esc(PROXY_V1) + ' 发送请求，由代理按模型名自动路由。确认继续？',
        '直接走代理测试', 'do-route-test:' + id, false);
      return;
    }
    if (!a.key) { toast('「' + a.name + '」未配置密钥，无法测试', 'err'); return; }
    modalConfirm('确认发送真实请求',
      '将向 ' + esc(a.baseUrl) + ' 发送一条最小的 chat.completions 测试请求，可能消耗少量 token。确认继续？',
      '确认发送', 'do-route-test:' + id, false);
  }

  async function testRoute(id) {
    var r = findById(DB.routes, id);
    if (!r) return;
    if (!r.enabled) { toast('「' + r.name + '」已停用，启用后再测试', 'warn'); return; }
    var a = findApiByName(r.upstream);
    closeModal();
    var b = document.querySelector('[data-act="route-test"][data-id="' + id + '"]');
    if (b) { b.classList.add('is-loading'); b.disabled = true; }
    var started = Date.now();
    try {
      // 中转规则测试统一走本地代理，和 LobsterAI / CherryStudio 等外部应用的实际路径一致
      var tok = DB.proxyMasterToken || DB.relayToken || await ensureRelayToken();
      var body = JSON.stringify({ model: r.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false });
      var res = await fetchWithTimeout(PROXY_V1 + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: body
      }, 15000);
      var lat = Date.now() - started;
      var data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      var tokens = (data.usage && data.usage.total_tokens) || 0;
      var upstreamLabel = a ? r.upstream + '(经代理)' : r.upstream + '(代理自动路由)';
      recordLog({ model: r.model, upstream: upstreamLabel, status: res.status, latency: res.ok ? lat : 0, tokens: tokens });
      if (res.ok) { toast('「' + r.name + '」调用成功（' + lat + ' ms，' + tokens + ' tokens）', 'ok'); }
      else { toast('「' + r.name + '」调用失败：' + (data.error && data.error.message ? data.error.message : res.status), 'err'); }
    } catch (e) {
      recordLog({ model: r.model, upstream: (a ? r.upstream + '(经代理)' : r.upstream + '(代理自动路由)'), status: 0, latency: 0, tokens: 0 });
      var hint = '';
      var msg = e.message || '';
      if (/invalid model|model not found|not exist|unsupported model|no upstream/i.test(msg)) {
        hint = '；目标模型名「' + r.model + '」在代理路由中找不到，请改为已收录的真实模型名';
      } else if (/access.?denied|403|account.*not|not.*authorized|无权限|未授权|未开通|ModelNotOpen/i.test(msg)) {
        hint = '；模型名存在但当前上游账户无权限调用（免费额度未开通/已过期/不在白名单），请到上游控制台确认权限';
      } else if (/timeout|timed out/i.test(msg)) {
        hint = '；请求超时，可能是网络波动或上游响应慢，建议重试或切备用规则';
      } else if (/401|令牌|token|key/i.test(msg)) {
        hint = '；代理 Key 无效，请在「中转站」面板重新生成中转 Key 或使用主控 Key';
      }
      toast('「' + r.name + '」请求失败：' + (msg || '网络/CORS 错误') + hint, 'err');
    } finally {
      if (b) { b.classList.remove('is-loading'); b.disabled = false; }
    }
  }

  function routeCurl(id) {
    var r = findById(DB.routes, id);
    if (!r) return;
    var a = findApiByName(r.upstream);
    if (!a) { toast('找不到对应的上游接口', 'err'); return; }
    var curl = buildCurl(a, r.model, 'Hi');
    copyText(curl, '已复制 curl 到剪贴板');
  }

  function buildCurl(api, model, prompt) {
    var url = joinUrl(api.baseUrl, '/chat/completions');
    var body = JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 });
    return 'curl ' + url + ' \\\n  -H "Authorization: Bearer ' + (api.key || '$YOUR_API_KEY') + '" \\\n  -H "Content-Type: application/json" \\\n  -d \'' + body + '\'';
  }

  function findApiByName(name) {
    for (var i = 0; i < DB.apis.length; i++) { if (DB.apis[i].name === name) return DB.apis[i]; }
    return null;
  }

  function resetData() {
    DB = seed();
    DB.module = 'free';
    save();
    closeModal();
    refreshAll();
    toast('已恢复为示例数据', 'ok');
  }

  function askReset() {
    modalConfirm('恢复示例数据',
      '这会覆盖当前所有模型、接口和规则记录，恢复到初始的示例数据。操作不可撤销。',
      '确认恢复', 'do-reset', true);
  }

  function delItem(kind, id) {
    if (!DB.settings.confirmDelete) { doDelete(kind, id); return; }
    var name = '';
    if (kind === 'model') { var m = findById(DB.models, id); name = m ? m.name : ''; }
    if (kind === 'api') { var a = findById(DB.apis, id); name = a ? a.name : ''; }
    if (kind === 'route') { var r = findById(DB.routes, id); name = r ? r.name : ''; }
    if (kind === 'catalog') { var c2 = findCatalog(id); name = c2 ? c2.name : ''; }
    modalConfirm('删除确认', '确定要删除「' + name + '」吗？删除后无法找回。', '删除', 'do-del:' + kind + ':' + id, true);
  }

  function doDelete(kind, id) {
    if (kind === 'model') DB.models = DB.models.filter(function (x) { return x.id !== id; });
    if (kind === 'api') DB.apis = DB.apis.filter(function (x) { return x.id !== id; });
    if (kind === 'route') DB.routes = DB.routes.filter(function (x) { return x.id !== id; });
    if (kind === 'catalog') { DB.catalogUser = DB.catalogUser.filter(function (x) { return x.id !== id; }); }
    save();
    closeModal();
    refreshAll();
    toast('已删除', 'ok');
  }

  function saveModel() {
    var name = val('mName').trim();
    if (!name) { var f = document.getElementById('mName'); if (f) f.focus(); toast('模型名称不能为空', 'err'); return; }
    var scopes = pickedScopes('mScopes');
    var data = {
      name: name, vendor: val('mVendor').trim(), site: val('mSite').trim(),
      free: val('mFree').trim() || '未标注', scopes: scopes,
      status: val('mStatus'), note: val('mNote').trim(), updatedAt: Date.now()
    };
    var id = dlgBody.dataset.editId;
    if (id) {
      var m = findById(DB.models, id);
      if (m) { for (var k in data) { m[k] = data[k]; } }
    } else {
      data.id = uid();
      DB.models.unshift(data);
    }
    save(); closeModal(); refreshAll();
    toast(id ? '已保存修改' : '已新增模型', 'ok');
  }

  async function saveApi() {
    var name = val('aName').trim();
    var url = val('aUrl').trim();
    if (!name) { toast('接口名称不能为空', 'err'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('Base URL 要以 http 或 https 开头', 'err'); return; }
    var id = dlgBody.dataset.editId;
    var vendor = val('aVendor').trim() || '未标注';
    var isLocal = /127\.0\.0\.1|localhost|::1/.test(url || '') || /本机|LocalAI|LM Studio|本地代理/.test((vendor || '') + (name || ''));
    var st = val('aStatus');
    if (isLocal && st === '未配置') st = '正常';
    var data = {
      name: name, vendor: vendor, baseUrl: url,
      key: val('aKey').trim(), status: st, expire: val('aExpire'),
      scopes: pickedScopes('aScopes')
    };
    if (id) {
      var a = findById(DB.apis, id);
      if (a) { for (var k in data) { a[k] = data[k]; } }
    } else {
      data.id = uid();
      DB.apis.unshift(data);
    }
    // 保险库开启且已解锁：保存前先加密明文 key 到 keyEnc
    var target = id ? a : data;
    if (DB.settings.vaultOn && vaultPass) {
      if (target.key) target.keyEnc = await encryptData(target.key, vaultPass);
      else target.keyEnc = '';
    }
    save(); closeModal(); refreshAll();
    toast(id ? '已保存修改' : '已新增接口', 'ok');
  }

  function saveRoute() {
    var name = val('rName').trim();
    if (!name) { toast('规则名称不能为空', 'err'); return; }
    var w = parseInt(val('rWeight'), 10);
    if (isNaN(w) || w < 0) w = 0;
    if (w > 100) w = 100;
    var id = dlgBody.dataset.editId;
    var data = {
      name: name, upstream: val('rUp'), model: val('rModel'), weight: w,
      enabled: val('rEnabled') === '1', note: val('rNote').trim()
    };
    if (id) {
      var r = findById(DB.routes, id);
      if (r) { for (var k in data) { r[k] = data[k]; } }
    } else {
      data.id = uid();
      DB.routes.push(data);
    }
    save(); closeModal(); refreshAll();
    toast(id ? '已保存修改' : '已新增规则', 'ok');
  }

  function toggleRoute(id) {
    var r = findById(DB.routes, id);
    if (!r) return;
    r.enabled = !r.enabled;
    save(); refreshAll();
    toast(r.enabled ? '已启用「' + r.name + '」' : '已停用「' + r.name + '」');
  }

  function val(id) {
    var e = document.getElementById(id);
    return e ? e.value : '';
  }

  function pickedScopes(containerId) {
    var box = document.getElementById(containerId);
    if (!box) return [];
    var out = [];
    var btns = box.querySelectorAll('[data-scope]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('tag-violet')) out.push(btns[i].getAttribute('data-scope'));
    }
    return out;
  }

  /* ============================================================
     事件绑定与初始化
     ============================================================ */
  function bindStatic() {
    document.getElementById('enterBtn').addEventListener('click', enterApp);
    document.getElementById('wvPlanBtn').addEventListener('click', function () {
      var t = document.getElementById('wvPlan');
      if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('tbBackBtn').addEventListener('click', backHome);
    document.getElementById('exampleBtn').addEventListener('click', modalExample);
    document.getElementById('settingBtn').addEventListener('click', modalSettings);
    document.getElementById('mExampleBtn').addEventListener('click', modalExample);
    document.getElementById('mSettingBtn').addEventListener('click', modalSettings);

    // 模块导航（事件委托）
    document.getElementById('nav').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.nav-item') : null;
      if (!b) return;
      var mod = b.getAttribute('data-mod');
      if (mod) switchModule(mod);
    });

    // 内容区（事件委托，渲染后无需重新绑定）
    elContent.addEventListener('click', onContentClick);

    // 排序下拉：点击页面任意区域（含 header/sidebar/modal 等）或按 ESC 时收回
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.custom-select')) closeAllCatalogSortMenus();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllCatalogSortMenus();
    });

    // 悬浮工具条：内容区滚动超过 300px 才显示「回到顶部」
    var fabWrap = document.getElementById('fabStack');
    var fabTop = document.getElementById('fabTop');
    if (fabWrap && fabTop) {
      fabTop.addEventListener('click', function () {
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
        catch (e) { window.scrollTo(0, 0); }
      });
      window.addEventListener('scroll', function () {
        var y = window.pageYOffset || document.documentElement.scrollTop || 0;
        fabWrap.hidden = y < 300;
      }, { passive: true });
    }
    elContent.addEventListener('input', onGenInput);
    elContent.addEventListener('change', onGenChange);

    // 弹窗
    document.getElementById('dlgClose').addEventListener('click', closeModal);
    document.getElementById('modalMask').addEventListener('click', closeModal);
    dlgBody.addEventListener('click', onModalClick);
    dlgBody.addEventListener('change', onModalClick);
    dlgBtns.addEventListener('click', onModalClick);
    dlgBody.addEventListener('click', onSettingsBgClick);

    // 键盘：ESC 关闭弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isModalOpen()) closeModal();
      if (e.key === 'Tab' && isModalOpen()) trapFocus(e);
      if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
      if (e.key === 'Tab' && isDrawerOpen()) trapFocusDrawer(e);
    });

    // 弹窗内作用域标签切换
    dlgBody.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-scope]') : null;
      if (b) b.classList.toggle('tag-violet');
    });
  }

  function trapFocus(e) {
    var dlg = document.getElementById('dialog');
    var nodes = dlg.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function onGenInput(e) {
    var t = e.target;
    if (t && t.id === 'upMasterToken') { DB.proxyMasterToken = t.value; save(); return; }
    var k = t.getAttribute && t.getAttribute('data-gen');
    if (!k) return;
    DB.gen[k] = t.value;
    if (k === 'scene') {
      var c = document.getElementById('sceneCount');
      if (c) c.textContent = t.value.length;
      if (t.value.trim().length >= 10) markError('fScene', false);
    }
    save();
  }

  function onGenChange(e) {
    var t = e.target;
    // 原生的生成场景/目标 select（catalog-sort 已改为自定义下拉，不再走 change）
    var k = t.getAttribute && t.getAttribute('data-gen');
    if (!k) return;
    DB.gen[k] = t.value;
    if (k === 'goal') {
      var box = document.getElementById('fCustom');
      if (box) box.hidden = (t.value !== '自定义目标');
      markError('fGoal', false);
      markError('fCustom', false);
    }
    if (k === 'stage') markError('fStage', false);
    save();
  }

  function onContentClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    // 点击自定义下拉外部时收起菜单
    if (!b || !b.closest || !b.closest('.custom-select')) closeAllCatalogSortMenus();
    if (!b) return;
    var act = b.getAttribute('data-act');
    var id = b.getAttribute('data-id');
    var nm = b.getAttribute('data-name');

    if (act === 'refresh') { doRefresh(DB.module); }
    else if (act === 'copy-endpoint') { copyText(PROXY_V1, '已复制代理调用地址'); }
    else if (act === 'proxy-detail') { openProxyDetail(); }
    else if (act === 'log-more') { showAllLogs(); }
    else if (act === 'goto-mod') { var gm = b.getAttribute('data-mod'); if (gm) switchModule(gm); }
    else if (act === 'export-log') { exportLogs(); }
    else if (act === 'logs-query') { logsState.page = 1; loadLogsData(); }
    else if (act === 'logs-reset') { resetLogsFilters(); loadLogsData({ reset: true }); }
    else if (act === 'logs-page') { var pg = parseInt(b.getAttribute('data-page') || '1', 10); loadLogsData({ page: pg }); }
    else if (act === 'retry') { setDemoState('normal'); toast('已重试'); }
    else if (act === 'reset-data') { askReset(); }
    else if (act === 'gen-run') { runGenerate(); }
    else if (act === 'gen-reset') {
      DB.gen = { stage: STAGES[0], scene: '', goal: GOALS[0], custom: '', collapsed: DB.gen.collapsed };
      save(); refreshAll(); toast('已重置为初始选项');
    }
    else if (act === 'toggle-gen-panel') {
      var key = b.getAttribute('data-key') || '';
      if (!key) return;
      if (!DB.gen.collapsed) DB.gen.collapsed = {};
      DB.gen.collapsed[key] = !DB.gen.collapsed[key];
      save();
      var panel = b.closest('.panel.is-collapsible');
      if (panel) {
        var isCollapsed = panel.classList.toggle('is-collapsed');
        b.setAttribute('aria-expanded', String(!isCollapsed));
        b.setAttribute('aria-label', isCollapsed ? '展开' : '收起');
        b.title = isCollapsed ? '展开' : '收起';
        b.innerHTML = isCollapsed ? ICON.chevronDown : ICON.chevronUp;
      }
      return;
    }
    else if (act === 'model-add') { modalModel(null); }
    else if (act === 'model-edit') { modalModel(id); }
    else if (act === 'model-del') { delItem('model', id); }
    else if (act === 'model-copy') {
      var m = findById(DB.models, id);
      if (m) copyText(m.name, '已复制模型名称');
    }
    else if (act === 'api-add') { modalApi(null); }
    else if (act === 'api-edit') { modalApi(id); }
    else if (act === 'api-del') { delItem('api', id); }
    else if (act === 'api-test') { testApi(id); }
    else if (act === 'export') { modalExport(); }
    else if (act === 'import') { modalImport(); }
    else if (act === 'intell-clear') { var ta = document.getElementById('intellText'); if (ta) ta.value = ''; }
    else if (act === 'intell-parse') { parseIntellInput(); }
    else if (act === 'catalog-refresh') { catalogRefresh(); }
    else if (act === 'catalog-health') { catalogHealth(); }
    else if (act === 'catalog-import') { modalCatalogImport(); }
    else if (act === 'catalog-add') { modalCatalogAdd(); }
    else if (act === 'catalog-sort-trigger') { toggleCatalogSortMenu(b); }
    else if (act === 'catalog-sort') {
      var val = b.getAttribute('data-value') || 'vendor';
      DB.freeSort = val; save(); renderContent();
      closeAllCatalogSortMenus();
    }
    else if (act === 'catalog-view') { DB.freeView = b.getAttribute('data-view') || 'grid'; save(); renderContent(); }
    else if (act === 'catalog-vendor-more') { freeFilter.vendorOpen = !freeFilter.vendorOpen; renderContent(); }
    else if (act === 'catalog-clear-q') {
      freeFilter.q = '';
      renderContent();
      var si = document.getElementById('catalogSearch');
      if (si) si.focus();
    }
    else if (act === 'catalog-clear-filter') {
      freeFilter.type = 'all'; freeFilter.vendor = 'all'; freeFilter.q = '';
      renderContent();
    }
    else if (act === 'catalog-filter') {
      var kind = b.getAttribute('data-kind');
      if (kind === 'vendor') freeFilter.vendor = b.getAttribute('data-vendor') || 'all';
      else freeFilter.type = b.getAttribute('data-type') || 'all';
      updateFilterChips(); refreshCatalogGrid();
    }
    else if (act === 'relay-filter') {
      relayFilter = b.getAttribute('data-value') || 'all';
      renderContent();
    }
    else if (act === 'relay-tab') {
      relayTab = b.getAttribute('data-value') || 'rules';
      renderContent();
    }
    else if (act === 'catalog-copy') { var cc = findCatalog(id); if (cc) copyText(cc.id, '已复制模型 ID'); }
    else if (act === 'catalog-apply') { var ca = findCatalog(id); if (ca && ca.applyUrl) { try { window.open(ca.applyUrl, '_blank'); } catch (e) {} } }
    else if (act === 'catalog-toApi') { catalogToApi(id); }
    else if (act === 'catalog-del') { delItem('catalog', id); }
    else if (act === 'catalog-toggle') {
      var on = !!b.checked;
      DB.catalogEnabled[id] = on;
      if (on && !DB.settings.intent) {
        // 意图识别关闭：只允许启用一个模型（单选，避免歧义）
        getCatalog().forEach(function (c) { if (c.id !== id) DB.catalogEnabled[c.id] = false; });
      }
      save(); refreshCatalogGrid();
      if (DB.settings.intent && on) { pushEnabledToProxy(); pullQuota(); }
      pushEnabledToProxy();   // 任意开关变更都同步「已选中文档」到代理
    }
    else if (act === 'catalog-key') { modalCatalogKey(id); }
    else if (act === 'quota-refresh') { pullQuota(); toast('配额已刷新', 'ok'); }
    else if (act === 'quota-alert-jump') { showThresholdAlerts(); }
    else if (act === 'consumption-refresh') { pullConsumption(); toast('消耗分析已刷新', 'ok'); }
    else if (act === 'intent-toggle') { setIntentIntent(!DB.settings.intent); }
    else if (act === 'relay-token-gen') { genRelayToken(); }
    else if (act === 'relay-token-copy') { copyRelayToken(); }
    else if (act === 'intent-try') { tryIntent(); }
    else if (act === 'app-token-new') { newAppToken(); }
    else if (act === 'app-token-copy') { copyAppToken(id); }
    else if (act === 'app-token-toggle') { toggleAppToken(id); }
    else if (act === 'app-token-rename') { renameAppToken(id); }
    else if (act === 'app-token-del') { delAppToken(id); }
    else if (act === 'classifier-set') { setClassifier(); }
    else if (act === 'classifier-test') { testClassifier(); }
    else if (act === 'relay-station') { modalRelayStation(); }
    else if (act === 'route-add') { modalRoute(null); }
    else if (act === 'route-test') { askTestRoute(id); }
    else if (act === 'route-curl') { routeCurl(id); }
    else if (act === 'route-edit') { modalRoute(id); }
    else if (act === 'route-del') { delItem('route', id); }
    else if (act === 'route-toggle') { toggleRoute(id); }
    else if (act === 'uproute-add') { openUpRouteModal(null); }
    else if (act === 'uproute-sync-catalog') { syncCatalogToRoutes(); }
    else if (act === 'uproute-sync-keys') { syncKeysToProxy(); }
    else if (act === 'uproute-import') { importUpRoute(); }
    else if (act === 'admin-token') { openAdminTokenModal(); }
    else if (act === 'uproute-edit') { var ur = findProxyRoute(nm); if (ur) openUpRouteModal(ur); }
    else if (act === 'uproute-toggle') { toggleUpRoute(nm); }
    else if (act === 'uproute-del') { deleteUpRoute(nm); }
    else if (act === 'uproute-test') { testUpRoute(nm); }
    else if (act === 'log-more') { modalLogs(); }
  }

  function onContentInput(e) {
    var t = e.target;
    if (t && t.id === 'catalogSearch') {
      freeFilter.q = t.value.trim();
      refreshCatalogGrid();
      var cl = document.querySelector('#content .search .clear');
      if (cl) cl.hidden = !t.value.trim();
    }
  }

  async function onModalClick(e) {
    var b = e.target.closest ? e.target.closest('[data-mact]') : null;
    if (!b) return;
    var act = b.getAttribute('data-mact') || '';

    if (act === 'close') { closeModal(); }
    else if (act === 'save-model') { saveModel(); }
    else if (act === 'save-api') { saveApi(); }
    else if (act === 'save-route') { saveRoute(); }
    else if (act === 'reset-data') { askReset(); }
    else if (act === 'do-reset') { resetData(); }
    else if (act === 'regen') { closeModal(); runGenerate(); }
    else if (act === 'copy-curl') { copyText(genPayload().curl, '已复制 curl 示例'); }
    else if (act === 'copy-json') { copyText(genPayload().json, '已复制 JSON 配置'); }
    else if (act === 'toggle-mask') {
      DB.settings.showMasked = !DB.settings.showMasked;
      save();
      b.setAttribute('aria-checked', DB.settings.showMasked ? 'true' : 'false');
      refreshAll();
    }
    else if (act === 'toggle-confirm') {
      DB.settings.confirmDelete = !DB.settings.confirmDelete;
      save();
      b.setAttribute('aria-checked', DB.settings.confirmDelete ? 'true' : 'false');
      toast(DB.settings.confirmDelete ? '已开启删除确认' : '已关闭删除确认');
    }
    else if (act === 'toggle-intent') {
      setIntentIntent(!DB.settings.intent);
      b.setAttribute('aria-checked', DB.settings.intent ? 'true' : 'false');
    }
    else if (act === 'toggle-vault') { toggleVault(b); }
    else if (act === 'toggle-autostart') {
      if (b.disabled) return;
      var enable = b.getAttribute('aria-checked') !== 'true';
      setProxyAutostart(enable);
    }
    else if (act === 'intent-toggle') { setIntentIntent(!DB.settings.intent); }
    else if (act === 'relay-token-gen') { genRelayToken(); }
    else if (act === 'relay-token-copy') { copyRelayToken(); }
    else if (act === 'intent-try') { tryIntent(); }
    else if (act === 'app-token-new') { newAppToken(); }
    else if (act === 'app-token-copy') { copyAppToken(b.getAttribute('data-id')); }
    else if (act === 'app-token-toggle') { toggleAppToken(b.getAttribute('data-id')); }
    else if (act === 'app-token-rename') { renameAppToken(b.getAttribute('data-id')); }
    else if (act === 'app-token-del') { delAppToken(b.getAttribute('data-id')); }
    else if (act === 'classifier-set') { setClassifier(); }
    else if (act === 'classifier-test') { testClassifier(); }
    else if (act === 'do-vault-enable') { doVaultEnable(b); }
    else if (act === 'do-vault-unlock') { doVaultUnlock(b); }
    else if (act.indexOf('do-del:') === 0) {
      var dRest = act.substring('do-del:'.length);
      var dCi = dRest.indexOf(':');
      doDelete(dRest.slice(0, dCi), dRest.slice(dCi + 1));
    }
    else if (act === 'do-export') { doExport(); }
    else if (act === 'do-import') { doImport(); }
    else if (act === 'save-catalog') { saveCatalog(); }
    else if (act.indexOf('save-catalog-key:') === 0) { saveCatalogKey(act.substring('save-catalog-key:'.length)); }
    else if (act === 'do-catalog-import') { doCatalogImport(); }
    else if (act === 'clear-proxy-logs') { clearProxyLogs(); }
    else if (act.indexOf('do-route-test:') === 0) { testRoute(act.substring('do-route-test:'.length)); }
    else if (act === 'save-uproute') { saveUpRoute(); }
    else if (act === 'save-admin-token') { saveAdminToken(); }
    else if (act.indexOf('uproute-pick:') === 0) {
      var pi = Number(act.substring('uproute-pick:'.length));
      var pa = DB.apis[pi];
      if (pa) { closeModal(); openUpRouteModal({ name: pa.name, vendor: pa.vendor || pa.name, baseUrl: pa.baseUrl, models: [], weight: 1, priority: 99, enabled: true, hasKey: false }); }
    }
    else if (act.indexOf('do-uproute-del:') === 0) { doDeleteUpRoute(act.substring('do-uproute-del:'.length)); }
    else if (act === 'range') {
      var id = b.id;
      var v = Number(b.value);
      if (id === 'setBrightness') DB.settings.brightness = v;
      if (id === 'setFontScale') DB.settings.fontScale = v;
      var valSpan = b.parentNode.querySelector('.range-val');
      if (valSpan) valSpan.textContent = v + (b.getAttribute('id') === 'setBrightness' ? '%' : '%');
      save(); applyTheme();
    }
    else if (act === 'select') {
      var sid = b.id, sv = b.value;
      if (sid === 'setTheme') DB.settings.theme = sv;
      if (sid === 'setStartup') DB.settings.startup = sv;
      if (sid === 'setFontFamily') DB.settings.fontFamily = sv;
      save(); applyTheme();
    }
    else if (act === 'clear-data') {
      if (!window.confirm('确定清除全部本地数据？此操作不可恢复。')) return;
      localStorage.removeItem(KEY);
      location.reload();
    }
    else if (act === 'export-config') { exportAllConfig(); }
    else if (act === 'import-config') {
      var inp = document.getElementById('cfgImportFile');
      if (inp) inp.click();
    }
    else if (act === 'acct-setup') { acctSetup(); }
    else if (act === 'acct-change') { acctChange(); }
    else if (act === 'acct-logout') { acctLogout(); }
  }

  function onSettingsBgClick(e) {
    var b = e.target.closest ? e.target.closest('[data-bg]') : null;
    if (!b) return;
    var v = b.getAttribute('data-bg');
    DB.settings.themeBg = v;
    save(); applyTheme();
    var list = document.getElementById('bgList');
    if (list) {
      [].forEach.call(list.children, function(c) {
        var on = c.getAttribute('data-bg') === v;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }

  var appBooted = false;
  function init() { bootAuth(); }
  function bootAuth() {
    fetch(PROXY_BASE + '/api/auth/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) { initApp(); return; }                                 // 代理离线：保持原离线体验
        authState.hasPassword = !!s.hasPassword;
        authState.authed = !!s.authed;
        if (s.authed) { initApp(); return; }                            // 已有会话
        if (!s.hasPassword) {
          toast('建议到「设置」配置访问密码', 'ok');
          doLogin({ noPassword: true, then: initApp });
          return;
        }
        renderLogin(s);                                                 // 需输入密码
      })
      .catch(function () { initApp(); });                              // 网络异常（代理离线）走原流程
  }
  function doLogin(opts) {
    opts = opts || {};
    var pw = opts.password || '';
    return fetch(PROXY_BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j.token) { if (opts.render) showAuthErr((o.j && o.j.error && o.j.error.message) || '登录失败'); return; }
        setSession(o.j.token);
        var gate = document.getElementById('authGate'); if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
        if (opts.then) opts.then();
      });
  }
  function renderLogin(status) {
    var gate = document.getElementById('authGate');
    if (!gate) {
      gate = document.createElement('div'); gate.id = 'authGate'; gate.className = 'auth-gate';
      gate.innerHTML = '<div class="auth-card">' +
        '<div class="auth-logo">Free API 工作台</div>' +
        '<div class="auth-sub">请输入访问密码以继续使用</div>' +
        '<input id="authPw" class="auth-input" type="password" placeholder="访问密码" autocomplete="current-password" />' +
        '<button id="authBtn" class="auth-btn" type="button">登录</button>' +
        '<div id="authErr" class="auth-err"></div>' +
        (status && status.noPassword === false ? '<div class="auth-hint">首次使用？可登录后在「设置」中配置访问密码</div>' : '') +
        '</div>';
      document.body.appendChild(gate);
    }
    var input = document.getElementById('authPw');
    var btn = document.getElementById('authBtn');
    function submit() {
      var errEl = document.getElementById('authErr'); if (errEl) errEl.textContent = '';
      doLogin({ password: (input && input.value) || '', render: true, then: initApp });
    }
    if (btn) btn.onclick = submit;
    if (input) { input.onkeydown = function (e) { if (e.key === 'Enter') submit(); }; setTimeout(function () { try { input.focus(); } catch (e) {} }, 50); }
  }
  function showAuthErr(msg) { var el = document.getElementById('authErr'); if (el) el.textContent = msg; }
  function acctSetup() {
    var pw = (document.getElementById('acctNew') || {}).value || '';
    var pw2 = (document.getElementById('acctNew2') || {}).value || '';
    var err = document.getElementById('acctErr');
    if (pw.length < 4) { if (err) err.textContent = '密码至少 4 位'; return; }
    if (pw !== pw2) { if (err) err.textContent = '两次输入的密码不一致'; return; }
    if (err) err.textContent = '';
    mfetch(PROXY_BASE + '/api/auth/setup', { method: 'POST', headers: mhdr(), body: JSON.stringify({ password: pw }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j.ok) { if (err) err.textContent = (o.j && o.j.error && o.j.error.message) || '设置失败'; return; }
        if (o.j.token) setSession(o.j.token);
        authState.hasPassword = true; authState.authed = true;
        toast('访问密码已设置', 'ok'); closeModal();
      })
      .catch(function () { if (err) err.textContent = '网络异常，代理可能未运行'; });
  }
  function acctChange() {
    var cur = (document.getElementById('acctCur') || {}).value || '';
    var pw = (document.getElementById('acctNew') || {}).value || '';
    var pw2 = (document.getElementById('acctNew2') || {}).value || '';
    var err = document.getElementById('acctErr');
    if (pw.length < 4) { if (err) err.textContent = '新密码至少 4 位'; return; }
    if (pw !== pw2) { if (err) err.textContent = '两次输入的新密码不一致'; return; }
    if (err) err.textContent = '';
    mfetch(PROXY_BASE + '/api/auth/change', { method: 'POST', headers: mhdr(), body: JSON.stringify({ current: cur, password: pw }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j.ok) { if (err) err.textContent = (o.j && o.j.error && o.j.error.message) || '修改失败'; return; }
        toast('访问密码已修改', 'ok'); closeModal();
      })
      .catch(function () { if (err) err.textContent = '网络异常，代理可能未运行'; });
  }
  function acctLogout() {
    mfetch(PROXY_BASE + '/api/auth/logout', { method: 'POST', headers: mhdr() })
      .then(function () {})
      .catch(function () {})
      .then(function () {
        setSession('');
        authState.authed = false;
        authState.hasPassword = true;
        toast('已退出登录');
        closeModal();
        renderLogin({ hasPassword: true, authed: false });
      });
  }
  function initApp() {
    if (appBooted) return;
    appBooted = true;
    elContent = document.getElementById('content');
    modalRoot = document.getElementById('modalRoot');
    dlgTitle = document.getElementById('dlgTitle');
    dlgSub = document.getElementById('dlgSub');
    dlgBody = document.getElementById('dlgBody');
    dlgBtns = document.getElementById('dlgBtns');
    dlgNote = document.getElementById('dlgNote');
    dlgBusy = document.getElementById('dlgBusy');
    dialogEl = document.getElementById('dialog');

    // 代理详情抽屉
    drawerRoot = document.getElementById('drawerRoot');
    drawerEl = document.getElementById('drawer');
    drawerTitle = document.getElementById('drawerTitle');
    drawerSub = document.getElementById('drawerSub');
    drawerBody = document.getElementById('drawerBody');
    drawerCloseBtn = document.getElementById('drawerClose');
    drawerCloseBtn.addEventListener('click', closeDrawer);
    document.getElementById('drawerMask').addEventListener('click', closeDrawer);
    drawerBody.addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-copy]') : null;
      if (c) copyText(c.getAttribute('data-copy'), '已复制到剪贴板');
    });

    // 弹窗内分段控件（示例弹窗）
    dlgBody.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('#exSeg button') : null;
      if (b) renderExample(b.getAttribute('data-ex'));
    });
    // 设置弹窗里的单选
    dlgBody.addEventListener('change', function (e) {
      var r = e.target;
      if (r && r.name === 'demo') {
        setDemoState(r.value);
        var items = document.querySelectorAll('#demoList .radio-item');
        for (var i = 0; i < items.length; i++) {
          items[i].classList.toggle('is-on', items[i].querySelector('input').checked);
        }
      }
      if (r && r.id === 'aTpl') {
        var t = API_TEMPLATES[r.value];
        if (t) {
          var u = document.getElementById('aUrl'), v = document.getElementById('aVendor');
          if (u) u.value = t.baseUrl;
          if (v) v.value = t.vendor;
        }
      }
      if (r && r.id === 'cfgImportFile') {
        if (r.files && r.files[0]) importAllConfig(r.files[0]);
        r.value = ''; // 允许重复选择同一文件再次触发
      }
    });

    elContent.addEventListener('input', onContentInput);
    bindStatic();
    // 意图识别关闭且没有显式启用记录时，默认启用第一个非过期模型，避免全部开关打开造成歧义
    if (!DB.settings.intent) {
      var hasExplicit = Object.keys(DB.catalogEnabled || {}).some(function (k) { return DB.catalogEnabled[k] === true; });
      if (!hasExplicit) {
        var first = getCatalog().find(function (c) { return c.type !== 'expired'; });
        if (first) { DB.catalogEnabled[first.id] = true; save(); }
      }
    }
    save();
    applyTheme();
    // 跟随系统主题时，监听系统切换
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { if (DB.settings.theme === 'system') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    // 欢迎页 mockup 鼠标视差（尊重减少动画偏好）
    (function () {
      var welcome = document.querySelector('.welcome-view');
      var stage = document.querySelector('.wv-stage-inner');
      if (!welcome || !stage) return;
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;
      var rafId = null, tx = 0, ty = 0;
      function apply() {
        stage.style.setProperty('--px', tx.toFixed(3));
        stage.style.setProperty('--py', ty.toFixed(3));
        rafId = null;
      }
      welcome.addEventListener('mousemove', function (e) {
        var rect = welcome.getBoundingClientRect();
        tx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
        ty = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
        if (!rafId) rafId = requestAnimationFrame(apply);
      });
      welcome.addEventListener('mouseleave', function () {
        tx = 0; ty = 0;
        if (!rafId) rafId = requestAnimationFrame(apply);
      });
    })();

    // 使用设置中的启动页
    if (DB.settings.startup && DB.settings.startup !== 'overview' && ['overview','free','api','relay','routes'].indexOf(DB.settings.startup) !== -1) {
      DB.module = DB.settings.startup;
    }
    refreshAll();
    // 密钥保险库：若启用且本地为密文，弹出解锁框
    if (DB.settings.vaultOn && vaultIsLocked()) showVaultUnlock();
    // 欢迎页主卡立即渲染代理状态（离线默认），随后 checkProxyStatus 间隔探测会刷新为真实值
    renderWelcomeStatus();
    if (typeof checkProxyStatus === 'function') checkProxyStatus();
    // 定时探测本地代理：代理启动后页面会自动感知（无需手动刷新），并补推额度/已选模型
    setInterval(function () { checkProxyStatus(); }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // =================== 路线2a：请求日志页（SQLite 结构化日志前端） ===================
  var logsState = { page: 1, pageSize: 20, total: 0 };

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function logsApiGet(p) {
    return mfetch(PROXY_BASE + p, { cache: 'no-store' }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function viewLogs() {
    return '' +
      '<div class="logs-wrap">' +
        '<div class="logs-head">' +
          '<h2 class="logs-title">请求日志</h2>' +
          '<div class="logs-head-actions">' +
            '<button class="btn btn-primary" type="button" data-act="export-log">导出 CSV</button>' +
          '</div>' +
        '</div>' +
        '<div class="logs-stats" id="logsStats"><span class="logs-stat-hint">加载中…</span></div>' +
        '<div class="logs-filters">' +
          '<label class="logs-f">上游<select id="fUpstream" class="logs-input"><option value="">全部</option></select></label>' +
          '<label class="logs-f">模型<input id="fModel" class="logs-input" type="text" placeholder="模型名"></label>' +
          '<label class="logs-f">状态码<select id="fStatus" class="logs-input"><option value="">全部</option><option value="200">200</option><option value="401">401</option><option value="429">429</option><option value="502">502</option><option value="503">503</option></select></label>' +
          '<label class="logs-f">起始<input id="fStart" class="logs-input" type="text" placeholder="YYYY-MM-DDTHH:MM:SS"></label>' +
          '<label class="logs-f">结束<input id="fEnd" class="logs-input" type="text" placeholder="YYYY-MM-DDTHH:MM:SS"></label>' +
          '<button class="btn" type="button" data-act="logs-query">查询</button>' +
          '<button class="btn btn-ghost" type="button" data-act="logs-reset">重置</button>' +
        '</div>' +
        '<div class="logs-tablewrap">' +
          '<table class="logs-table" id="logsTable"><thead><tr>' +
            '<th>时间</th><th>上游</th><th>模型</th><th class="num">提示</th><th class="num">补全</th><th class="num">总计</th><th>状态</th><th class="num">耗时</th><th>来源IP</th><th>错误</th>' +
          '</tr></thead><tbody id="logsBody"></tbody></table>' +
        '</div>' +
        '<div class="logs-pager" id="logsPager"></div>' +
      '</div>';
  }
  function logsFiltersQuery(q) {
    var up = document.getElementById('fUpstream');
    var mo = document.getElementById('fModel');
    var st = document.getElementById('fStatus');
    var s1 = document.getElementById('fStart');
    var s2 = document.getElementById('fEnd');
    if (up && up.value) q.set('upstream', up.value);
    if (mo && mo.value) q.set('model', mo.value);
    if (st && st.value) q.set('status', st.value);
    if (s1 && s1.value) q.set('startTime', s1.value);
    if (s2 && s2.value) q.set('endTime', s2.value);
  }
  function loadLogsData(opts) {
    opts = opts || {};
    if (opts.reset) logsState.page = 1;
    if (opts.page) logsState.page = opts.page;
    var q = new URLSearchParams();
    q.set('page', String(logsState.page));
    q.set('pageSize', String(logsState.pageSize));
    logsFiltersQuery(q);
    Promise.all([
      logsApiGet('/api/log/list?' + q.toString()),
      logsApiGet('/api/log/stat')
    ]).then(function (rs) {
      var list = rs[0] || {}; var stat = rs[1] || {};
      if (list.disabled) { renderLogsEmpty('日志功能已关闭（better-sqlite3 不可用）'); return; }
      logsState.total = list.total || 0;
      renderLogsStats(stat.stats || []);
      renderLogsTable(list.data || []);
      renderLogsPager();
      populateUpstreamFilter(list.data || []);
    }).catch(function (e) {
      renderLogsEmpty('加载失败：' + (e && e.message ? e.message : e));
    });
  }
  function renderLogsStats(stats) {
    var el = document.getElementById('logsStats'); if (!el) return;
    if (!stats.length) { el.innerHTML = '<span class="logs-stat-hint">暂无统计数据</span>'; return; }
    var totalCalls = 0, totalTok = 0;
    stats.forEach(function (s) { totalCalls += s.calls | 0; totalTok += s.total_tokens | 0; });
    var cards = '';
    cards += logsStatCard('总调用', fmtNum(totalCalls));
    cards += logsStatCard('总 Token 消耗', fmtNum(totalTok));
    cards += logsStatCard('上游数', fmtNum(stats.length));
    stats.slice(0, 6).forEach(function (s) {
      cards += logsStatCard(s.upstream, fmtNum(s.calls) + ' 次 / ' + fmtNum(s.total_tokens | 0) + ' tok');
    });
    el.innerHTML = cards;
  }
  function logsStatCard(label, val) {
    return '<div class="logs-stat"><div class="logs-stat-val">' + escHtml(val) + '</div><div class="logs-stat-label">' + escHtml(label) + '</div></div>';
  }
  function renderLogsTable(rows) {
    var b = document.getElementById('logsBody'); if (!b) return;
    if (!rows.length) { b.innerHTML = '<tr><td colspan="10" class="logs-empty">暂无日志记录</td></tr>'; return; }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var errCls = r.error_msg ? ' class="logs-err"' : '';
      var statusCls = (r.status_code >= 400) ? ' is-bad' : ' is-ok';
      html += '<tr>' +
        '<td>' + escHtml(r.request_time || '') + '</td>' +
        '<td>' + escHtml(r.upstream || '') + '</td>' +
        '<td>' + escHtml(r.model || '') + '</td>' +
        '<td class="num">' + fmtNum(r.prompt_tokens) + '</td>' +
        '<td class="num">' + fmtNum(r.completion_tokens) + '</td>' +
        '<td class="num">' + fmtNum(r.total_tokens) + '</td>' +
        '<td><span class="logs-badge' + statusCls + '">' + escHtml(String(r.status_code || '')) + '</span></td>' +
        '<td class="num">' + (r.latency_ms != null ? fmtNum(r.latency_ms) + 'ms' : '') + '</td>' +
        '<td>' + escHtml(r.client_ip || '') + '</td>' +
        '<td' + errCls + '>' + escHtml(r.error_msg || '') + '</td>' +
      '</tr>';
    }
    b.innerHTML = html;
  }
  function renderLogsPager() {
    var el = document.getElementById('logsPager'); if (!el) return;
    var totalPages = Math.max(1, Math.ceil(logsState.total / logsState.pageSize));
    var cur = logsState.page;
    var html = '<button class="btn btn-ghost" type="button" data-act="logs-page" data-page="' + (cur - 1) + '"' + (cur <= 1 ? ' disabled' : '') + '>上一页</button>';
    html += '<span class="logs-page-info">第 ' + cur + ' / ' + totalPages + ' 页 · 共 ' + logsState.total + ' 条</span>';
    html += '<button class="btn btn-ghost" type="button" data-act="logs-page" data-page="' + (cur + 1) + '"' + (cur >= totalPages ? ' disabled' : '') + '>下一页</button>';
    el.innerHTML = html;
  }
  function populateUpstreamFilter(rows) {
    var sel = document.getElementById('fUpstream'); if (!sel) return;
    var seen = {};
    Array.prototype.forEach.call(sel.options, function (o) { seen[o.value] = 1; });
    rows.forEach(function (r) {
      var u = r.upstream || '';
      if (u && !seen[u]) { var op = document.createElement('option'); op.value = u; op.textContent = u; sel.appendChild(op); seen[u] = 1; }
    });
  }
  function renderLogsEmpty(msg) {
    var b = document.getElementById('logsBody'); if (b) b.innerHTML = '<tr><td colspan="10" class="logs-empty">' + escHtml(msg) + '</td></tr>';
    var s = document.getElementById('logsStats'); if (s) s.innerHTML = '';
    var p = document.getElementById('logsPager'); if (p) p.innerHTML = '';
  }
  function resetLogsFilters() {
    ['fUpstream', 'fModel', 'fStatus', 'fStart', 'fEnd'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.value = '';
    });
  }
  function exportLogs() {
    var q = new URLSearchParams();
    logsFiltersQuery(q);
    mfetch(PROXY_BASE + '/api/log/export?' + q.toString(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.message) || ('HTTP ' + r.status)); });
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'api-log-export.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已导出 CSV');
    }).catch(function (e) { toast('导出失败：' + (e && e.message ? e.message : e)); });
  }
