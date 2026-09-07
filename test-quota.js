'use strict';
/*
 * test-quota.js — v0.12.0 配额数据层回归
 *   1) 纯单元测试（无需服务）：normalizeKey / vendorKind / computeModelQuota
 *      - 验证「剩余 = freeQuota - 已用」，并兼容日志 model 名与目录 id 归一化（sf/X ↔ X）
 *   2) 集成测试（真实代理）：GET /v1/quota 返回 ok + modelQuota（含 hasQuota 项）+ vendorBalances（容错数组）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROXY_DIR = path.join(__dirname, 'proxy');
// Git Bash 传入的 /c/... 路径 Node child_process 无法解析，需转为 Windows 盘符路径
function toWin(p) { return String(p || '').replace(/^\/([a-z])\//i, function (_, d) { return d.toUpperCase() + ':/'; }); }
const NODE = toWin(process.env.NODE_EXE || process.execPath);
const PORT = 8875 + Math.floor(Math.random() * 80);
const BASE = 'http://127.0.0.1:' + PORT;
const MASTER = 'test-quota-master';
const DB_TMP = path.join(os.tmpdir(), 'free-api-quota-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---------------- 1) 单元测试 ----------------
function unit() {
  const q = require('./proxy/quota');
  // normalizeKey
  ok('normalizeKey sf/Qwen2.5-7B-Instruct → qwen2.5-7b-instruct',
    q.normalizeKey('sf/Qwen2.5-7B-Instruct') === 'qwen2.5-7b-instruct');
  ok('normalizeKey 纯名 Qwen/X → x（仅取最后段并小写）', q.normalizeKey('Qwen/X') === 'x');

  // vendorKind
  ok('vendorKind DeepSeek', q.vendorKind('DeepSeek') === 'deepseek');
  ok('vendorKind 硅基流动', q.vendorKind('硅基流动') === 'siliconflow');
  ok('vendorKind OpenAI(不支持)', q.vendorKind('OpenAI') === null);

  // computeModelQuota：剩余 = freeQuota - 已用，且兼容归一化 key
  const models = [
    { id: 'sf/Qwen2.5-7B-Instruct', freeQuota: 1000000, freeQuotaPeriod: '90天' }, // 有额度
    { id: 'sf/RateLimited', freeQuota: null },                                     // 纯限流
    { id: 'openai/gpt-x', freeQuota: 500000 }                                      // 有额度
  ];
  // 日志里记录的 model 名可能是上游真实名（去掉 sf/ 前缀），归一化后应对齐
  const usage = {
    'Qwen2.5-7B-Instruct': { total: 100 }, // 对应 sf/Qwen2.5-7B-Instruct
    'openai/gpt-x': { total: 50 }
  };
  const mq = q.computeModelQuota(models, usage);
  ok('modelQuota 含 3 项', Object.keys(mq).length === 3, JSON.stringify(Object.keys(mq)));
  ok('有额度模型 remaining = 1000000-100 = 999900',
    mq['sf/Qwen2.5-7B-Instruct'].remaining === 999900 && mq['sf/Qwen2.5-7B-Instruct'].hasQuota === true,
    JSON.stringify(mq['sf/Qwen2.5-7B-Instruct']));
  ok('已用归一化对齐（日志名 Qwen2.5-7B-Instruct）', mq['sf/Qwen2.5-7B-Instruct'].used === 100);
  ok('纯限流模型 hasQuota=false, remaining=null',
    mq['sf/RateLimited'].hasQuota === false && mq['sf/RateLimited'].remaining === null);
  ok('openai 模型 remaining = 500000-50 = 499950',
    mq['openai/gpt-x'].remaining === 499950 && mq['openai/gpt-x'].used === 50);
  // 超额不至于负数
  const over = q.computeModelQuota([{ id: 'x', freeQuota: 10 }], { x: { total: 999 } });
  ok('超额剩余被夹到 0', over['x'].remaining === 0 && over['x'].used === 999);

  // computeModelQuota 阈值告警（alertCfg = {warnPct,critPct}）
  const am = [{ id: 'low', freeQuota: 1000 }, { id: 'crit', freeQuota: 1000 }, { id: 'ok', freeQuota: 1000000 }];
  const ausage = { low: { total: 900 }, crit: { total: 1000 }, ok: { total: 1000 } };
  // low: 剩 100/1000=10% < warnPct(20) → warn；crit: 剩 0 → crit；ok: 99.9% → 无告警
  const amq = q.computeModelQuota(am, ausage, { warnPct: 20, critPct: 5 });
  ok('low 剩余10% → warn', amq['low'].alert && amq['low'].alert.level === 'warn', JSON.stringify(amq['low'].alert));
  ok('crit 剩余0 → crit', amq['crit'].alert && amq['crit'].alert.level === 'crit', JSON.stringify(amq['crit'].alert));
  ok('ok 无告警（alert=null）', amq['ok'].alert === null, JSON.stringify(amq['ok'].alert));
  ok('pct 字段为数字', typeof amq['ok'].pct === 'number');
  ok('默认阈值（无 alertCfg）也能算', q.computeModelQuota(am, ausage)['low'].alert != null);

  // summarizeAlerts 聚合
  const sa = q.summarizeAlerts(amq, [{ vendor: 'DeepSeek', balance: 0.5, alert: { level: 'crit', reason: 'x' } }]);
  ok('summarizeAlerts count=3（2 模型 + 1 厂商）', sa.count === 3, JSON.stringify(sa));
  ok('summarizeAlerts hasCrit=true', sa.hasCrit === true);
  ok('summarizeAlerts models 中 crit 排在 warn 前', sa.models[0] && sa.models[0].level === 'crit');
  ok('summarizeAlerts 含 vendors 告警', sa.vendors.length === 1 && sa.vendors[0].level === 'crit');
}

// ---------------- 2) 集成测试 ----------------
function req(method, p) {
  return new Promise(function (resolve, reject) {
    const r = http.request(BASE + p, { method: method, headers: { 'Authorization': 'Bearer ' + MASTER } }, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () { resolve({ code: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
    });
    r.on('error', reject);
    r.end();
  });
}
function waitHealth() {
  return new Promise(function (resolve) {
    let n = 0;
    (function tick() {
      http.get(BASE + '/health', function (r) { r.resume(); if (r.statusCode === 200) return resolve(true); if (++n > 40) return resolve(false); setTimeout(tick, 250); })
        .on('error', function () { if (++n > 40) return resolve(false); setTimeout(tick, 250); });
    })();
  });
}

(async function () {
  unit();
  console.log('--- 集成测试 ---');
  const cfgPath = path.join(PROXY_DIR, '_tquota.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: PORT, mode: 'balanced', token: MASTER,
    upstreams: [
      { name: 'DeepSeek', vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-dummy-test', models: ['deepseek-chat'], weight: 1, priority: 1, cost: 0, enabled: true },
      { name: '硅基流动', vendor: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-dummy-test', models: ['*'], weight: 1, priority: 2, cost: 0, enabled: true }
    ],
    relay: [], catalog: { user: [], enabled: {}, vendorKey: {} }, freeModels: [], appTokens: []
  }));
  [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  const child = spawn(NODE, ['proxy.js', cfgPath], { cwd: PROXY_DIR, stdio: 'ignore', env: Object.assign({}, process.env, { FREE_API_STATE_DB: DB_TMP }) });
  const cleanup = function () {
    try { fs.unlinkSync(cfgPath); } catch (e) {}
    [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    try { child.kill(); } catch (e) {}
  };
  try {
    if (!await waitHealth()) { console.log('代理启动失败'); cleanup(); process.exit(1); }
    const res = await req('GET', '/v1/quota');
    ok('GET /v1/quota 返回 200', res.code === 200, JSON.stringify(res.body));
    ok('/v1/quota ok=true', res.body && res.body.ok === true);
    ok('modelQuota 为对象', res.body && res.body.modelQuota && typeof res.body.modelQuota === 'object');
    ok('vendorBalances 为数组（容错，dummy key 不崩）',
      res.body && Array.isArray(res.body.vendorBalances), JSON.stringify(res.body && res.body.vendorBalances));
    // 目录已加载含 12 个 freeQuota 模型（来自 models-catalog.json），应至少有 hasQuota 项
    const mq = (res.body && res.body.modelQuota) || {};
    const hasQuota = Object.keys(mq).filter(function (k) { return mq[k].hasQuota === true; });
    ok('modelQuota 含 ≥1 个 hasQuota 项（freeQuota 分母生效）', hasQuota.length >= 1, 'hasQuota=' + hasQuota.length);
    // 具体验证腾讯 TokenHub 体验包模型剩余 = freeQuota（无日志用量时）
    if (mq['th/hy-mt2-lite']) {
      ok('th/hy-mt2-lite hasQuota=true 且剩余=1000000',
        mq['th/hy-mt2-lite'].hasQuota === true && mq['th/hy-mt2-lite'].remaining === 1000000,
        JSON.stringify(mq['th/hy-mt2-lite']));
    } else {
      ok('th/hy-mt2-lite 在 modelQuota 中', false, '未找到');
    }
    // vendorBalances 容错：要么有 balance 数字，要么有 error 字段，绝不为 undefined/抛错
    const vbOk = (res.body.vendorBalances || []).every(function (v) {
      return (typeof v.balance === 'number') || (typeof v.error === 'string');
    });
    ok('vendorBalances 每项要么 balance 要么 error（容错）', vbOk);

    // thresholdAlerts（#130 额度不足阈值告警）
    ok('thresholdAlerts 返回对象且含 models/vendors/count',
      res.body && res.body.thresholdAlerts && Array.isArray(res.body.thresholdAlerts.models) &&
      Array.isArray(res.body.thresholdAlerts.vendors) && typeof res.body.thresholdAlerts.count === 'number',
      JSON.stringify(res.body && res.body.thresholdAlerts));

    // /v1/quota/usage（#131 额度消耗分析）
    const res2 = await req('GET', '/v1/quota/usage?days=14');
    ok('GET /v1/quota/usage 返回 200', res2.code === 200, JSON.stringify(res2.body));
    ok('/v1/quota/usage 含 totals/byModel/byVendor/byDay',
      res2.body && res2.body.totals && Array.isArray(res2.body.byModel) &&
      Array.isArray(res2.body.byVendor) && Array.isArray(res2.body.byDay),
      JSON.stringify(Object.keys(res2.body || {})));
    ok('/v1/quota/usage totals 含 requests/tokens 字段',
      res2.body && res2.body.totals && 'requests' in res2.body.totals && 'tokens' in res2.body.totals);

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    cleanup();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('测试异常：' + e.message);
    cleanup();
    process.exit(1);
  }
})();
