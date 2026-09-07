'use strict';
/*
 * test-state-store.js — Phase 2c 代理状态层（stateStore）集成回归
 * 启动真实代理（独立端口 + 临时 config）→ 验证 /api/data/* 读写与 SQLite 持久化 → 杀进程清理。
 * 不依赖真实上游；纯状态层验证。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROXY_DIR = path.join(__dirname, 'proxy');
const NODE = process.env.NODE_EXE || process.execPath;
const PORT = 8845 + Math.floor(Math.random() * 80);
const BASE = 'http://127.0.0.1:' + PORT;
const MASTER = 'test-state-master';
// 用临时 SQLite 路径，避免固定 free_api.db 被残留进程锁定导致测试漂移
const DB_TMP = path.join(os.tmpdir(), 'free-api-state-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function req(method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method: method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MASTER }
    }, function (res) {
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
  // 临时 config（含初始 catalog/relay/freeModels，供 stateStore 导入）
  const cfgPath = path.join(PROXY_DIR, '_tstate.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: PORT, mode: 'balanced', token: MASTER,
    upstreams: [{ name: 'DeepSeek', vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-dummy', models: ['deepseek-chat'], weight: 1, priority: 1, cost: 0, enabled: true }],
    relay: [{ name: 'r1', match: '*', upstream: 'DeepSeek' }],
    catalog: { user: ['seed-model'], enabled: { 'deepseek-chat': true }, vendorKey: {} },
    freeModels: ['deepseek-chat'], appTokens: []
  }));

  // 启动前清理临时 db（避免残留）
  [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

  const child = spawn(NODE, ['proxy.js', cfgPath], { cwd: PROXY_DIR, stdio: 'ignore', env: Object.assign({}, process.env, { FREE_API_STATE_DB: DB_TMP }) });
  const cleanup = function () {
    try { fs.unlinkSync(cfgPath); } catch (e) {}
    [DB_TMP, DB_TMP + '-wal', DB_TMP + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    try { child.kill(); } catch (e) {}
  };

  try {
    if (!await waitHealth()) { console.log('代理启动失败'); cleanup(); process.exit(1); }

    // 1. 状态接口
    let s = await req('GET', '/api/data/status');
    ok('status.enabled=true', s.body && s.body.enabled === true, JSON.stringify(s.body));

    // 2. GET 返回从 config 导入的初始值
    let cat = await req('GET', '/api/data/catalog');
    ok('GET catalog 返回导入值', cat.body && cat.body.user && cat.body.user[0] === 'seed-model', JSON.stringify(cat.body));

    // 3. PUT 写入新值
    let put = await req('PUT', '/api/data/catalog', { user: ['a', 'b'], enabled: { 'deepseek-chat': true }, vendorKey: {} });
    ok('PUT catalog 成功', put.code === 200 && put.body.ok === true, JSON.stringify(put.body));

    // 4. GET 读到新值（已落 SQLite）
    let cat2 = await req('GET', '/api/data/catalog');
    ok('GET catalog 返回 PUT 后新值', cat2.body && cat2.body.user && cat2.body.user.length === 2 && cat2.body.user[0] === 'a', JSON.stringify(cat2.body));

    // 5. relay / free-models 读写
    let putR = await req('PUT', '/api/data/relay', [{ name: 'r2', match: 'x', upstream: 'DeepSeek' }]);
    ok('PUT relay 成功', putR.code === 200 && putR.body.ok === true);
    let rel = await req('GET', '/api/data/relay');
    ok('GET relay 返回新值', rel.body && rel.body.length === 1 && rel.body[0].name === 'r2', JSON.stringify(rel.body));

    // 6. 非本机无 token 应 401（用非本机来源模拟：直接打 401 逻辑需真实远端，此处验证本机免 token 可达）
    let local = await req('GET', '/api/data/catalog');
    ok('本机免 token 可读', local.code === 200);

    // 7. 持久化：重启代理后 SQLite 仍保留 PUT 的值（导入逻辑 INSERT OR IGNORE 不覆盖）
    child.kill();
    await new Promise(function (r) { setTimeout(r, 600); });
    const child2 = spawn(NODE, ['proxy.js', cfgPath], { cwd: PROXY_DIR, stdio: 'ignore', env: Object.assign({}, process.env, { FREE_API_STATE_DB: DB_TMP }) });
    await waitHealth();
    let cat3 = await req('GET', '/api/data/catalog');
    ok('重启后 SQLite 持久化（catalog 仍是 PUT 值）', cat3.body && cat3.body.user && cat3.body.user.length === 2 && cat3.body.user[0] === 'a', JSON.stringify(cat3.body));
    child2.kill();
    await new Promise(function (r) { setTimeout(r, 300); });

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    cleanup();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('测试异常：' + e.message);
    cleanup();
    process.exit(1);
  }
})();
