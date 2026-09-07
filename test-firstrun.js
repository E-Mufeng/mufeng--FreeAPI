'use strict';
/*
 * Free API 代理 - 首次启动引导测试（Task D，自包含）
 *
 * 验证：当 config.json 缺失时，代理从 config.example.json 自动生成默认配置并正常启动；
 *       /api/auth/status 返回 firstRun=true（尚未设置访问密码）。
 *
 * 运行：node test-firstrun.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failedNames = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failedNames.push(name); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

const NODE = process.execPath;
const PROXY_JS = path.join(__dirname, 'proxy', 'proxy.js');
const PORT = 8900 + Math.floor(Math.random() * 100);
const tmpConfig = path.join(os.tmpdir(), 'free-api-firstrun-' + Date.now() + '.json');

function getJson(p) {
  return new Promise(function (resolve, reject) {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', timeout: 5000 }, function (res) {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString()) }); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function () {
  // 确保临时配置不存在（触发首次启动）
  try { fs.unlinkSync(tmpConfig); } catch (e) {}
  assert.strictEqual(fs.existsSync(tmpConfig), false, '前置：临时配置不应存在');

  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  const proc = spawn(NODE, [PROXY_JS, tmpConfig], { env: env, stdio: 'ignore' });

  let healthy = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const h = await getJson('/health'); if (h.status === 200) { healthy = true; break; } } catch (e) {}
  }

  try {
    test('首次启动：代理成功启动并响应 /health', function () {
      assert.strictEqual(healthy, true, '代理未在超时内就绪');
    });

    test('首次启动：已从 config.example.json 自动生成 config.json', function () {
      assert.strictEqual(fs.existsSync(tmpConfig), true, '配置文件未被自动创建');
      const c = JSON.parse(fs.readFileSync(tmpConfig, 'utf8'));
      assert.ok(Array.isArray(c.upstreams) && c.upstreams.length >= 1, '生成的配置应含 upstreams');
    });

    test('首次启动：/api/auth/status 返回 firstRun=true 且 hasPassword=false', function () {
      // 注意：代理端口由 PORT 覆盖，但 status 接口路径固定
      return getJson('/api/auth/status').then(function (s) {
        assert.strictEqual(s.status, 200, 'status 接口应 200');
        assert.strictEqual(s.body.hasPassword, false, '首次启动不应有密码');
        assert.strictEqual(s.body.firstRun, true, '首次启动应标记 firstRun');
        assert.strictEqual(s.body.authed, false, '未登录');
      });
    });

    test('首次启动：/health 返回 enriched 可观测字段（version/rateLimit/store/logs/firstRun）', function () {
      return getJson('/health').then(function (h) {
        assert.strictEqual(h.status, 200, '/health 应 200');
        const b = h.body;
        assert.ok(typeof b.version === 'string' && b.version.length > 0, '应有 version');
        assert.strictEqual(b.firstRun, true, '首次启动 firstRun 应为 true');
        assert.ok(b.rateLimit && typeof b.rateLimit === 'object', '应有 rateLimit 对象');
        assert.ok(b.store && typeof b.store.enabled === 'boolean', '应有 store.enabled');
        assert.ok(b.logs && typeof b.logs.enabled === 'boolean', '应有 logs.enabled');
        assert.ok(b.rateStore && typeof b.rateStore.enabled === 'boolean', '应有 rateStore.enabled');
      });
    });
  } finally {
    try { proc.kill('SIGTERM'); } catch (e) {}
  }

  // 清理：临时配置
  [tmpConfig, tmpConfig + '-wal', tmpConfig + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  // 代理的 SQLite（free_api.db / logs.db）始终落在 proxy/ 目录（硬编码 __dirname），测试后清理，
  // 与 test-state-store.js 约定一致，避免污染开发态 DB。
  const proxyDir = path.join(__dirname, 'proxy');
  ['free_api.db', 'free_api.db-wal', 'free_api.db-shm', 'logs.db', 'logs.db-wal', 'logs.db-shm'].forEach(function (f) {
    try { fs.unlinkSync(path.join(proxyDir, f)); } catch (e) {}
  });
  try { fs.rmSync(path.join(proxyDir, 'logs'), { recursive: true, force: true }); } catch (e) {}

  console.log('\n首次启动引导测试：' + pass + ' 通过 / ' + fail + ' 失败' + (failedNames.length ? '（失败：' + failedNames.join('、') + '）' : ''));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('测试异常：' + e.message);
  process.exit(1);
});
