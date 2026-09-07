'use strict';
/*
 * Free API 代理 - 速率限制单元测试（Phase 2b，自包含）
 * 策略（§9）：以全内存场景为主，仅用例 10 走 HTTP（dummy 上游，不调真实硅基流动/智谱）。
 * 运行：node test-rate-limit.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createRateLimiter } = require('./proxy/rateLimiter');

let pass = 0, fail = 0;
const failedNames = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failedNames.push(name); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

// 复刻 proxy.js send429，验证响应结构（D3）
function mockRes() { return { _code: 0, _headers: {}, _body: '', writeHead(c, h) { this._code = c; this._headers = h || {}; }, end(b) { this._body = b || ''; } }; }
function send429(res, retryAfter, scope, message) {
  res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(retryAfter) });
  res.end(JSON.stringify({ error: 'rate_limited', retryAfter: retryAfter, scope: scope, message: message || '请求过于频繁，请稍后重试' }));
}

const NODE = process.execPath;
const PROXY_JS = path.join(__dirname, 'proxy', 'proxy.js');

function mk(cfg) { const r = createRateLimiter(); r.init(cfg); return r; }

function httpReq(method, p, port, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (opts.auth) headers['Authorization'] = 'Bearer ' + opts.auth;
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers, timeout: 10000 }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const t = Buffer.concat(ch).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: t, headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, json: null, text: '', headers: {}, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 1. 令牌桶消耗 / 补充
  await test('1. 令牌桶：耗尽后拒绝，补充后恢复', async () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 1e9 }, perUpstream: { enabled: true }, tokenBucket: { capacity: 2, refillPerSecond: 1 } });
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true);
    const d = rl.allow({ upstream: 'U', clientIp: '1.1.1.1' });
    assert.strictEqual(d.allowed, false, '第3次应被令牌桶拒绝');
    assert.strictEqual(d.scope, 'upstream');
    assert.ok(d.retryAfter >= 1);
    await sleep(1100);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true, '补充后应恢复');
  });

  // 2. 全局固定窗口 QPS
  await test('2. 全局固定窗口：超 maxPerMinute 触发 429', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 2 }, perUpstream: { enabled: false }, tokenBucket: { capacity: 1e9, refillPerSecond: 1e9 } });
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true);
    const d = rl.allow({ upstream: 'U', clientIp: '1.1.1.1' });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.scope, 'global', '全局兜底应标记 scope=global');
  });

  // 3. 429 + Retry-After 结构
  await test('3. 429 响应结构：Retry-After 头 + JSON 错误体', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 2 }, perUpstream: { enabled: false }, tokenBucket: { capacity: 1e9, refillPerSecond: 1e9 } });
    rl.allow({ upstream: 'U', clientIp: '2.2.2.2' }); rl.allow({ upstream: 'U', clientIp: '2.2.2.2' });
    const d = rl.allow({ upstream: 'U', clientIp: '2.2.2.2' });
    const res = mockRes();
    send429(res, d.retryAfter, d.scope, '请求过于频繁，请稍后重试');
    assert.strictEqual(res._code, 429);
    assert.ok(res._headers['Retry-After'], '应含 Retry-After 响应头');
    const body = JSON.parse(res._body);
    assert.strictEqual(body.error, 'rate_limited');
    assert.strictEqual(body.scope, 'global');
    assert.ok(typeof body.retryAfter === 'number');
    assert.ok(typeof body.message === 'string');
  });

  // 4. 多 upstream 隔离
  await test('4. 多 upstream 隔离：A 限流不影响 B', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 1e9 }, perUpstream: { enabled: true }, tokenBucket: { capacity: 1, refillPerSecond: 0.1 } });
    assert.strictEqual(rl.allow({ upstream: 'A', clientIp: '1.1.1.1' }).allowed, true);
    assert.strictEqual(rl.allow({ upstream: 'A', clientIp: '1.1.1.1' }).allowed, false, 'A 应被限');
    assert.strictEqual(rl.allow({ upstream: 'B', clientIp: '1.1.1.1' }).allowed, true, 'B 不受影响');
  });

  // 5. 多 client_ip 隔离
  await test('5. 多 clientIp 隔离：IP1 限流不影响 IP2', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 1e9 }, perUpstream: { enabled: true }, tokenBucket: { capacity: 1, refillPerSecond: 0.1 } });
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: 'IP1' }).allowed, true);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: 'IP1' }).allowed, false);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: 'IP2' }).allowed, true);
  });

  // 6. 优雅降级：配置校验失败 → disabled → 放行
  await test('6. 降级：配置校验失败 disabled → allow 恒放行（§7/§15）', () => {
    const rl = createRateLimiter();
    const ok = rl.init({ enabled: true, global: { maxPerMinute: 0 }, tokenBucket: { capacity: 'bad', refillPerSecond: 0 } }); // capacity 非法 → 校验失败
    assert.strictEqual(ok, false, 'init 应返回 false');
    assert.strictEqual(rl.isEnabled(), false);
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true, '降级后恒放行');
    rl.settle({ upstream: 'U', clientIp: '1.1.1.1', usedTokens: 999999 }); // 不应抛
  });

  // 7. enabled:false 全放行
  await test('7. 配置 enabled:false → 全放行', () => {
    const rl = mk({ enabled: false, global: { maxPerMinute: 0 }, perUpstream: { enabled: true }, tokenBucket: { capacity: 1, refillPerSecond: 0 } });
    assert.strictEqual(rl.isEnabled(), false);
    for (let i = 0; i < 5; i++) assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true);
  });

  // 8. token 维度：usage NULL 退化 + 超上限拒
  await test('8. token 维度：usage NULL 退化为请求数；超 maxTokensPerMinute 拒（D5）', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 1e9 }, perUpstream: { enabled: true, maxTokensPerMinute: 10 }, tokenBucket: { capacity: 1e9, refillPerSecond: 1e9 } });
    for (let i = 0; i < 5; i++) { rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }); rl.settle({ upstream: 'U', clientIp: '1.1.1.1', usedTokens: 0 }); }
    assert.strictEqual(rl.allow({ upstream: 'U', clientIp: '1.1.1.1' }).allowed, true, 'usage=0 不应触发 token 限流');
    rl.settle({ upstream: 'U', clientIp: '1.1.1.1', usedTokens: 100 }); // 超大 → 触发 limited
    const d = rl.allow({ upstream: 'U', clientIp: '1.1.1.1' });
    assert.strictEqual(d.allowed, false, '超 token 上限应拒');
    assert.strictEqual(d.scope, 'upstream');
    assert.ok(/tokens-per-minute/.test(d.reason));
  });

  // 9. 内存 TTL 清理
  await test('9. 内存 TTL：久未用桶被淘汰，Map size 不无限增长', () => {
    const rl = mk({ enabled: true, global: { maxPerMinute: 1e9 }, perUpstream: { enabled: true }, tokenBucket: { capacity: 1e9, refillPerSecond: 1e9 }, bucketIdleTtlSec: 1 });
    ['1', '2', '3'].forEach((ip) => rl.allow({ upstream: 'U', clientIp: ip }));
    assert.strictEqual(rl._state().buckets.size, 3, '应建 3 个桶');
    rl._state().buckets.forEach((b) => { b.lastAccess = Date.now() - 10000; });
    rl.collectExpired();
    assert.strictEqual(rl._state().buckets.size, 0, '过期桶应被清理');
  });

  // 10. HTTP 集成（dummy upstream，全局窗口触发 429）
  await test('10. HTTP 集成：代理返回 429（dummy upstream，不调真实上游）', async () => {
    const dummy = http.createServer((reqq, ress) => {
      let b = ''; reqq.on('data', (c) => b += c); reqq.on('end', () => {
        ress.writeHead(200, { 'Content-Type': 'application/json' });
        ress.end(JSON.stringify({
          id: 'chatcmpl-dummy', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      });
    });
    await new Promise((r) => dummy.listen(0, '127.0.0.1', r));
    const dummyPort = dummy.address().port;

    const testPort = 8790 + Math.floor(Math.random() * 100);  // 随机端口，避免 Windows 上 SIGKILL 不杀进程导致端口残留互相污染
    const tmpCfg = path.join(os.tmpdir(), 'freeapi-rl-test-config.json');
    const hadDb = fs.existsSync(path.join(__dirname, 'proxy', 'logs.db'));
    fs.writeFileSync(tmpCfg, JSON.stringify({
      port: testPort, host: '127.0.0.1', token: '', mode: 'strict',
      upstreams: [{ name: 'dummy', baseUrl: 'http://127.0.0.1:' + dummyPort, apiKey: 'x', models: ['dummy-model'], enabled: true }],
      rateLimit: { enabled: true, global: { maxPerMinute: 2 }, perUpstream: { enabled: false }, tokenBucket: { capacity: 1e9, refillPerSecond: 1e9 } }
    }));
    const child = spawn(NODE, [PROXY_JS, tmpCfg], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let perr = ''; child.stderr.on('data', (d) => perr += d.toString());

    let ready = false;
    for (let i = 0; i < 40; i++) { const r = await httpReq('GET', '/health', testPort); if (r.status === 200) { ready = true; break; } await sleep(200); }
    assert.ok(ready, '代理未就绪: ' + perr.slice(0, 200));

    const out = [];
    for (let i = 0; i < 3; i++) {
      out.push(await httpReq('POST', '/v1/chat/completions', testPort, { body: { model: 'dummy-model', stream: false, messages: [{ role: 'user', content: 'hi' }] } }));
    }
    assert.strictEqual(out[0].status, 200, '第1次应 200');
    assert.strictEqual(out[1].status, 200, '第2次应 200');
    assert.strictEqual(out[2].status, 429, '第3次应 429，实得 ' + out[2].status + ' body=' + out[2].text.slice(0, 120));
    const b2 = JSON.parse(out[2].text || '{}');
    assert.strictEqual(b2.error, 'rate_limited');

    try { child.kill('SIGKILL'); } catch (e) {}
    try { dummy.close(); } catch (e) {}
    try { fs.unlinkSync(tmpCfg); } catch (e) {}
    if (!hadDb) { try { fs.unlinkSync(path.join(__dirname, 'proxy', 'logs.db')); } catch (e) {} }
  });

  console.log('\n=== 速率限制测试汇总：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' ===');
  if (fail > 0) console.log('失败项：' + failedNames.join('、'));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(2); });
