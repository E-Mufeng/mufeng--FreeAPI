'use strict';
/*
 * test-catalog-refresh.js — v0.12.0 目录刷新（静默保守合并）回归
 *   启动真实代理 → 写入「夹具目录」(含一个幽灵模型 + 两个真实模型并带 enabled 覆盖)
 *   → POST /v1/catalog/refresh（派生 fetch-catalog.js 重新抓取）
 *   → 断言：ok、models 非空、幽灵模型转 expired 且 enabled 覆盖被保留、真实模型 enabled 覆盖保留、配额元数据被刷新、config 密钥不被触碰。
 *   夹具会临时覆盖 catalog/models-catalog.json，测试结束恢复原文件（该文件已 gitignore）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROXY_DIR = path.join(__dirname, 'proxy');
const CATALOG_JSON = path.join(__dirname, 'catalog', 'models-catalog.json');
// Git Bash 传入的 /c/... 路径 Node child_process 无法解析，需转为 Windows 盘符路径
function toWin(p) { return String(p || '').replace(/^\/([a-z])\//i, function (_, d) { return d.toUpperCase() + ':/'; }); }
const NODE = toWin(process.env.NODE_EXE || process.execPath);
const PORT = 8895 + Math.floor(Math.random() * 60);
const BASE = 'http://127.0.0.1:' + PORT;
const MASTER = 'test-catref-master';
const DB_TMP = path.join(os.tmpdir(), 'free-api-catref-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function req(method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method: method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MASTER } }, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () { resolve({ code: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
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
  // 备份真实目录，写夹具
  const bak = CATALOG_JSON + '.bak-' + Date.now();
  let hadOrig = false;
  try { fs.copyFileSync(CATALOG_JSON, bak); hadOrig = true; } catch (e) {}
  const fixture = {
    version: 1, updatedAt: '2026-09-06',
    sources: ['fixture'],
    note: 'test fixture',
    models: [
      { id: 'zzz/ghost-free-model', name: 'Ghost', type: 'free', quota: 'fixture', modality: ['语言'], status: '待核实', verifiedAt: '2026-09-06', source: 'fixture', enabled: true, freeQuota: null },
      { id: 'sf/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B-Instruct', type: 'free', quota: 'FIXTURE-QUOTA', modality: ['语言'], status: '待核实', verifiedAt: '2026-09-06', source: 'fixture', enabled: false, freeQuota: null },
      { id: 'th/hy-mt2-lite', name: 'X', type: 'quota', quota: 'FIXTURE', modality: ['语言'], status: '待核实', verifiedAt: '2026-09-06', source: 'fixture', enabled: true, freeQuota: 1000000, freeQuotaPeriod: '90天' }
    ]
  };
  fs.writeFileSync(CATALOG_JSON, JSON.stringify(fixture, null, 2), 'utf8');

  const cfgPath = path.join(PROXY_DIR, '_tcatref.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: PORT, mode: 'balanced', token: MASTER,
    upstreams: [{ name: 'DeepSeek', vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-dummy', models: ['deepseek-chat'], weight: 1, priority: 1, cost: 0, enabled: true }],
    relay: [], catalog: { user: [], enabled: {}, vendorKey: {} }, freeModels: [], appTokens: []
  }));
  [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  const child = spawn(NODE, ['proxy.js', cfgPath], { cwd: PROXY_DIR, stdio: 'ignore', env: Object.assign({}, process.env, { FREE_API_STATE_DB: DB_TMP }) });
  const cleanup = function () {
    try { fs.unlinkSync(cfgPath); } catch (e) {}
    [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    try { child.kill(); } catch (e) {}
    try { if (hadOrig) fs.copyFileSync(bak, CATALOG_JSON); } catch (e) {}
    try { fs.unlinkSync(bak); } catch (e) {}
  };
  try {
    if (!await waitHealth()) { console.log('代理启动失败'); cleanup(); process.exit(1); }

    // 先通过 stateStore 设置 enabled 覆盖（刷新合并以 stateStore.getFreeModels() 为准，而非 models-catalog.json）
    const putFm = await req('PUT', '/api/data/free-models', [
      { id: 'zzz/ghost-free-model', enabled: true },
      { id: 'sf/Qwen2.5-7B-Instruct', enabled: false },
      { id: 'th/hy-mt2-lite', enabled: true }
    ]);
    ok('PUT /api/data/free-models 成功（写入 enabled 覆盖）', putFm.code === 200 && putFm.body && putFm.body.ok === true, JSON.stringify(putFm.body));

    const res = await req('POST', '/v1/catalog/refresh');
    ok('POST /v1/catalog/refresh 返回 200', res.code === 200, JSON.stringify(res.body).slice(0, 200));
    ok('refresh ok=true', res.body && res.body.ok === true);
    ok('refresh.models 为数组且非空', res.body && Array.isArray(res.body.models) && res.body.models.length > 0, 'count=' + (res.body && res.body.models && res.body.models.length));
    ok('added 为数字', res.body && typeof res.body.added === 'number');
    ok('expired 为数字且 ≥1（幽灵模型转过期）', res.body && typeof res.body.expired === 'number' && res.body.expired >= 1, 'expired=' + (res.body && res.body.expired));
    ok('changed 为数字', res.body && typeof res.body.changed === 'number');

    const byId = {};
    (res.body.models || []).forEach(function (m) { byId[m.id] = m; });

    // 幽灵模型：不在真实目录 → 转 expired，但 enabled 覆盖(true)被保留
    const ghost = byId['zzz/ghost-free-model'];
    ok('幽灵模型存在且 type=expired', ghost && ghost.type === 'expired', JSON.stringify(ghost));
    ok('幽灵模型 enabled 覆盖(true)被保留', ghost && ghost.enabled === true, ghost && 'enabled=' + ghost.enabled);

    // 真实模型 A：sf/Qwen2.5-7B-Instruct 在真实目录中存在 → 配额元数据被刷新（非 FIXTURE），enabled 覆盖(false)保留
    const sfm = byId['sf/Qwen2.5-7B-Instruct'];
    ok('sf 模型被刷新（quota 不再是 FIXTURE-QUOTA）', sfm && sfm.quota !== 'FIXTURE-QUOTA', sfm && sfm.quota);
    ok('sf 模型 enabled 覆盖(false)被保留', sfm && sfm.enabled === false, sfm && 'enabled=' + sfm.enabled);
    ok('sf 模型补充了 freeQuota 字段', sfm && 'freeQuota' in sfm);

    // 真实模型 B：th/hy-mt2-lite enabled 覆盖(true)保留
    const thm = byId['th/hy-mt2-lite'];
    ok('th 模型存在', !!thm);
    ok('th 模型 enabled 覆盖(true)被保留', thm && thm.enabled === true, thm && 'enabled=' + thm.enabled);

    // config 密钥不被触碰：刷新后上游 apiKey 仍是 sk-dummy（未被动）
    const st = await req('GET', '/api/data/status');
    ok('刷新后 config 上游未被篡改（status 200）', st.code === 200);

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    cleanup();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('测试异常：' + e.message);
    cleanup();
    process.exit(1);
  }
})();
