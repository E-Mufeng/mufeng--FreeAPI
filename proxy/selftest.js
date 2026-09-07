#!/usr/bin/env node
'use strict';
/*
 * proxy 自测：临时拉起 mock 上游 + 代理进程，验证核心能力。
 * 不依赖外网、不依赖真实 key。全部通过即代表代理可运行。
 *
 * 覆盖：健康检查 / chat 透传 / 精确缓存 / models 聚合 / CORS /
 *       无匹配上游 503 / 厂商路由查询与写入 / 额度推送 /
 *       意图识别自动选模型 / 目录刷新 / 中转站 Key 生成与鉴权。
 */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// 端口动态分配，避免与已运行的真实代理（默认 8787）冲突导致自检误报/崩溃
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const here = __dirname;
const proxyJs = path.join(here, 'proxy.js');
const testCfg = path.join(here, 'config.test.json');
const testCfg2 = path.join(here, 'config.test2.json');
const CATALOG = path.join(here, '..', 'catalog', 'models-catalog.json');
const CATALOG_BAK = path.join(here, '..', 'catalog', 'models-catalog.json.selftest-bak');
const ENABLED = path.join(here, 'enabled-models.json');   // 测试期间由代理写入「已选中模型文档」，需清理

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  [PASS] ' + msg);
  else { console.log('  [FAIL] ' + msg); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nonce = 0;
function startMock(MOCK) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(b || '{}'); } catch (e) {}
        const n = ++nonce;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-cmpl', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ECHO:' + ((body.messages || []).map((m) => m.content).join('|')) + '#' + n }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    srv.listen(MOCK, () => resolve(srv));
  });
}

function chat(port, body, headers) {
  return fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body),
  });
}

async function main() {
  const PORT = await getFreePort();
  const MOCK = await getFreePort();
  const mock = await startMock(MOCK);

  // 配置：代理 -> mock，承接所有模型；启用一个分类模型（意图识别用）
  fs.writeFileSync(testCfg, JSON.stringify({
    port: PORT, host: '127.0.0.1', mode: 'balanced', classifier: 'clf-model', token: '',
    routes: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + MOCK + '/v1', apiKey: 'x', models: ['*'], weight: 1, priority: 1, enabled: true }],
  }));
  const proxy = spawn(process.execPath, [proxyJs, testCfg], { stdio: 'ignore' });
  await sleep(800);

  // 1. 健康检查
  const h = await (await fetch('http://127.0.0.1:' + PORT + '/health')).json();
  assert(h.ok === true, 'GET /health 返回 ok');
  assert(Array.isArray(h.routes) && h.routes.length === 1, 'health 含 1 条上游');
  assert(h.routes[0].healthy === true, '上游初始健康');
  assert(h.classifier === 'clf-model', 'health 回传 classifier 字段');

  // 2. chat 透传回显
  const c = await (await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'hi' }], stream: false })).json();
  assert(c.choices && c.choices[0].message.content.indexOf('ECHO:hi') === 0, 'chat/completions 透传并回显');

  // 3. 精确缓存：两次相同 temperature=0 请求应命中缓存（nonce 相同）
  const a = await (await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'cache-me' }], stream: false, temperature: 0 })).json();
  const b2 = await (await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'cache-me' }], stream: false, temperature: 0 })).json();
  assert(a.choices && b2.choices, 'temperature=0 请求正常返回');
  assert(a.choices[0].message.content === b2.choices[0].message.content, '精确缓存命中（两次相同请求返回一致结果）');

  // 4. /v1/models 聚合
  const m = await (await fetch('http://127.0.0.1:' + PORT + '/v1/models')).json();
  assert(m.object === 'list' && Array.isArray(m.data), '/v1/models 返回模型列表');

  // 5. CORS 头（允许 file:// 调用）
  const cor = await fetch('http://127.0.0.1:' + PORT + '/health');
  assert(cor.headers.get('access-control-allow-origin') === '*', '响应带 CORS 头（允许 file:// 调用）');

  // 6. 无匹配上游 -> 503（另起一个端口，models 限定）
  const PORT2 = await getFreePort();
  fs.writeFileSync(testCfg2, JSON.stringify({
    port: PORT2, host: '127.0.0.1', mode: 'balanced',
    routes: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + MOCK + '/v1', apiKey: 'x', models: ['only-this'], weight: 1, enabled: true }],
  }));
  const proxy2 = spawn(process.execPath, [proxyJs, testCfg2], { stdio: 'ignore' });
  await sleep(800);
  const nr = await chat(PORT2, { model: 'unknown-model', messages: [{ role: 'user', content: 'x' }], stream: false });
  assert(nr.status === 503, '无匹配上游返回 503');
  proxy2.kill();
  fs.unlinkSync(testCfg2);

  // 7. GET /v1/routes 返回掩码（不泄露 apiKey）
  const gr = await (await fetch('http://127.0.0.1:' + PORT + '/v1/routes')).json();
  assert(gr.routes && gr.routes.length === 1, 'GET /v1/routes 返回 1 条');
  assert(gr.routes[0].hasKey === true, '掩码路由保留 hasKey 标记');
  assert(!('apiKey' in gr.routes[0]), 'GET /v1/routes 不返回明文 apiKey');

  // 8. POST /v1/routes 写入厂商 key（新增一条上游）
  const ups = await (await fetch('http://127.0.0.1:' + PORT + '/v1/routes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor: 'test-vendor', apiKey: 'sk-secret-123', baseUrl: 'http://127.0.0.1:' + MOCK + '/v1' }),
  })).json();
  assert(ups.ok === true && ups.route && ups.route.vendor === 'test-vendor', 'POST /v1/routes 写入厂商路由');
  assert(ups.route.hasKey === true && ups.route.keyMask && ups.route.keyMask !== 'sk-secret-123', '写入后掩码显示，不回显明文');
  const gr2 = await (await fetch('http://127.0.0.1:' + PORT + '/v1/routes')).json();
  assert(gr2.routes.some((r) => r.vendor === 'test-vendor'), '新厂商路由已出现在列表');

  // 9. POST /v1/quota 推送额度（意图识别读取用）
  const q = await (await fetch('http://127.0.0.1:' + PORT + '/v1/quota', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota: { 'any-model': '剩余 80%', 'other-model': '未知' } }),
  })).json();
  assert(q.ok === true && q.count >= 2, 'POST /v1/quota 推送并被代理记录');
  const hq = await (await fetch('http://127.0.0.1:' + PORT + '/health')).json();
  assert(hq.quotaCount >= 2, 'health 回传 quotaCount 已更新');

  // 10. POST /v1/auto/chat/completions（意图识别自动选模型）
  const au = await (await fetch('http://127.0.0.1:' + PORT + '/v1/auto/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello auto' }], stream: false, models: ['any-model'] }),
  })).json();
  assert(au.choices && au.choices[0].message.content.indexOf('ECHO:hello auto') === 0, '自动选模型后仍透传并回显');
  assert(au.model === 'any-model', '代理从候选里选定 any-model');

  // 11. POST /v1/catalog/refresh（备份真实目录，测完还原，避免污染项目）
  let catalogRefreshed = false;
  try {
    if (fs.existsSync(CATALOG)) fs.copyFileSync(CATALOG, CATALOG_BAK);
    const cr = await (await fetch('http://127.0.0.1:' + PORT + '/v1/catalog/refresh', { method: 'POST' })).json();
    catalogRefreshed = true;
    assert(cr.ok === true && Array.isArray(cr.models) && cr.models.length > 0, 'catalog/refresh 返回结构化目录（ok + 模型数组）');
    assert(typeof cr.updatedAt === 'string' && cr.updatedAt, 'catalog/refresh 返回 updatedAt');
  } catch (e) {
    assert(false, 'catalog/refresh 调用异常：' + e.message);
  } finally {
    if (fs.existsSync(CATALOG_BAK)) { fs.copyFileSync(CATALOG_BAK, CATALOG); fs.unlinkSync(CATALOG_BAK); }
  }

  // 12. POST /v1/token/generate 生成中转站 Key
  const tk = await (await fetch('http://127.0.0.1:' + PORT + '/v1/token/generate', { method: 'POST' })).json();
  assert(tk.ok === true && typeof tk.token === 'string' && tk.token.length >= 8, 'token/generate 返回中转站 Key');
  const cfgAfter = JSON.parse(fs.readFileSync(testCfg, 'utf8'));
  assert(cfgAfter.token === tk.token, '生成的 token 已写入 config.json');

  // 13. token 鉴权：设了 token 后，chat 必须带 token 才放行
  const noTok = await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'nokey' }], stream: false });
  assert(noTok.status === 401, '未带 token 的 chat 返回 401');
  const withTok = await (await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'withkey' }], stream: false }, { 'x-proxy-token': tk.token })).json();
  assert(withTok.choices && withTok.choices[0].message.content.indexOf('ECHO:withkey') === 0, '带正确 token 的 chat 正常通过');
  const wrongTok = await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'x' }], stream: false }, { 'x-proxy-token': 'wrong' });
  assert(wrongTok.status === 401, '错误 token 的 chat 返回 401');

  // 14. 模型加权路由：简单任务不应误用限额模型（额度保护）
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const freeId = (cat.models.find(function (m) { return m.type === 'free'; }) || {}).id;
  const quotaId = (cat.models.find(function (m) { return m.type !== 'free' && m.type !== 'expired'; }) || {}).id;
  assert(!!freeId && !!quotaId, '目录含免费与限额模型，用于加权路由测试');
  if (freeId && quotaId) {
    const hdr = { 'Content-Type': 'application/json', 'x-proxy-token': tk.token };
    const wr = await (await fetch('http://127.0.0.1:' + PORT + '/v1/auto/chat/completions', {
      method: 'POST', headers: hdr, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '翻译：你好' }], stream: false, models: [freeId, quotaId] }),
    })).json();
    assert(wr.model === freeId, '简单任务自动选免费模型（未误用限额模型，额度保护生效）');
    const wr2 = await (await fetch('http://127.0.0.1:' + PORT + '/v1/auto/chat/completions', {
      method: 'POST', headers: hdr, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x' }], stream: false, models: [quotaId] }),
    })).json();
    assert(wr2.model === quotaId, '仅限额候选时正常选中该模型');
  }

  // 15. 应用 Key（多 Key）管理
  const tokHdr = { 'Content-Type': 'application/json' };
  const tc = await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens', { method: 'POST', headers: tokHdr, body: JSON.stringify({ action: 'create', name: 'CherryStudio' }) })).json();
  assert(tc.ok && tc.token && tc.rawKey, 'tokens create 返回明文 Key');
  const tl = await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens')).json();
  assert(tl.tokens.some(function (t) { return t.id === tc.token.id; }), 'tokens list 含新 Key');
  await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens', { method: 'POST', headers: tokHdr, body: JSON.stringify({ action: 'toggle', id: tc.token.id }) }));
  const td = await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens', { method: 'POST', headers: tokHdr, body: JSON.stringify({ action: 'delete', id: tc.token.id }) })).json();
  assert(td.ok, 'tokens delete 返回 ok');
  const tl2 = await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens')).json();
  assert(!tl2.tokens.some(function (t) { return t.id === tc.token.id; }), 'tokens delete 后列表不再含该 Key');
  // 应用 Key 可用于 chat 调用（鉴权）
  const tc2 = await (await fetch('http://127.0.0.1:' + PORT + '/v1/tokens', { method: 'POST', headers: tokHdr, body: JSON.stringify({ action: 'create', name: 'NextChat' }) })).json();
  const withApp = await (await chat(PORT, { model: 'any-model', messages: [{ role: 'user', content: 'appkey' }], stream: false }, { 'x-proxy-token': tc2.rawKey })).json();
  assert(withApp.choices && withApp.choices[0].message.content.indexOf('ECHO:appkey') === 0, '应用 Key 可正常调用 chat');

  // 16. 分类器模型设置
  const cs = await (await fetch('http://127.0.0.1:' + PORT + '/v1/classifier', { method: 'POST', headers: tokHdr, body: JSON.stringify({ model: freeId }) })).json();
  assert(cs.ok && cs.classifier === freeId, 'classifier set 生效');
  const cg = await (await fetch('http://127.0.0.1:' + PORT + '/v1/classifier')).json();
  assert(cg.classifier === freeId, 'classifier get 回传设置值');

  // 17. 请求日志落盘（30 天保留）+ 清空
  const lg = await (await fetch('http://127.0.0.1:' + PORT + '/v1/logs?limit=20')).json();
  assert(lg.ok && Array.isArray(lg.logs) && lg.logs.length > 0, 'logs 返回真实调用记录（落盘生效）');
  assert(lg.retentionDays === 30, 'logs retentionDays=30（每月清理）');
  assert(lg.logs.every(function (l) { return l.status && l.model; }), '日志条目含 status/model 字段');
  const cl = await (await fetch('http://127.0.0.1:' + PORT + '/v1/logs/clear', { method: 'POST' })).json();
  assert(cl.ok, 'logs clear 成功');
  const lg2 = await (await fetch('http://127.0.0.1:' + PORT + '/v1/logs?limit=20')).json();
  assert(lg2.logs.length === 0, 'clear 后日志为空');

  // 18. 已选中(开启)模型文档：意图识别只读它，不读 config 全量
  const enHdr = { 'Content-Type': 'application/json', 'x-proxy-token': tk.token };
  const es = await (await fetch('http://127.0.0.1:' + PORT + '/v1/enabled', { method: 'POST', headers: enHdr, body: JSON.stringify({ models: ['doc-a', 'doc-b'] }) })).json();
  assert(es.ok && es.count === 2, 'POST /v1/enabled 写入 2 个已开启模型');
  const eg = await (await fetch('http://127.0.0.1:' + PORT + '/v1/enabled')).json();
  assert(eg.count === 2 && eg.models.length === 2, 'GET /v1/enabled 回传文档内容');
  // /v1/models 现在只读该文档（source=enabled-doc），不再暴露未开启模型
  const me = await (await fetch('http://127.0.0.1:' + PORT + '/v1/models')).json();
  assert(me.source === 'enabled-doc', '/v1/models 来源为已选中文档（不读 config 全量）');
  assert(me.data.length === 2, '/v1/models 只返回文档里的 2 个模型');
  assert(me.data.every(function (m) { return m.id === 'doc-a' || m.id === 'doc-b'; }), '/v1/models 不含未开启模型');
  // 自动选模型在无 body.models 时，从已选中文档取候选并成功透传
  const ae = await (await fetch('http://127.0.0.1:' + PORT + '/v1/auto/chat/completions', {
    method: 'POST', headers: enHdr, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'from-doc' }], stream: false }),
  })).json();
  assert(ae.choices && ae.choices[0].message.content.indexOf('ECHO:from-doc') === 0, 'auto 从无 body.models 时从已选中文档取候选并透传');
  assert(['doc-a', 'doc-b'].indexOf(ae.model) >= 0, 'auto 选中的模型来自已选中文档');

  // 清理
  proxy.kill();
  mock.close();
  fs.unlinkSync(testCfg);
  if (fs.existsSync(ENABLED)) fs.unlinkSync(ENABLED);
  console.log('\n' + (failures ? ('❌ ' + failures + ' 项失败') : '✅ 全部通过（18 组断言）'));
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
