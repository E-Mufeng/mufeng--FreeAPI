'use strict';
/*
 * Free API 代理 - 多实例限流 SQLite 共享测试（Task D，自包含）
 *
 * 验证 config.rateLimit.sqlite=true 时，令牌桶状态落到 SQLite，
 * 两个限流实例（模拟两个代理进程）共享同一套计数：
 *   - 实例 A 消耗配额 → 实例 B 立即可见剩余不足（跨实例共享）
 *   - 不同 key（clientIp）互不干扰
 *   - 关闭 sqlite（内存模式）时两个实例互相独立（对照组）
 *
 * 运行：node test-rate-limit-sqlite.js
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createRateLimiter } = require('./proxy/rateLimiter');
const rateStore = require('./proxy/rateStore');

let pass = 0, fail = 0;
const failedNames = [];

function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failedNames.push(name); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

// 临时 DB（避免污染 proxy/free_api.db）
const tmpDb = path.join(os.tmpdir(), 'free-api-rl-sqlite-' + Date.now() + '.db');

// 极小配额：capacity=2，refill=0（不补充，便于断言共享消耗），全局/窗口放得很宽
const SQLITE_CFG = {
  enabled: true,
  sqlite: true,
  global: { maxPerMinute: 100000 },
  perUpstream: { enabled: true, maxPerMinute: 100000, maxTokensPerMinute: 100000 },
  tokenBucket: { capacity: 2, refillPerSecond: 0 },
  bucketIdleTtlSec: 3600
};

function cleanupTmp() {
  [tmpDb, tmpDb + '-wal', tmpDb + '-shm'].forEach(function (f) {
    try { fs.unlinkSync(f); } catch (e) {}
  });
}

try {
  const ok = rateStore.init(tmpDb);
  if (!ok) { console.log('  ⚠ better-sqlite3 不可用，跳过 SQLite 共享测试'); }
  else {
    // ---- 1. 两个实例共享同一 store：A 消耗后 B 立即可见 ----
    test('sqlite 模式初始化成功（rateStore.enabled）', function () {
      assert.strictEqual(rateStore.isEnabled(), true);
    });

    const l1 = createRateLimiter(); l1.init(SQLITE_CFG, rateStore);
    const l2 = createRateLimiter(); l2.init(SQLITE_CFG, rateStore);

    test('实例 A 前两次放行（capacity=2）', function () {
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '1.1.1.1' }).allowed, true);
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '1.1.1.1' }).allowed, true);
    });

    test('实例 A 第三次被拒（桶空，sqlite 模式）', function () {
      const d = l1.allow({ upstream: 'u1', clientIp: '1.1.1.1' });
      assert.strictEqual(d.allowed, false);
      assert.strictEqual(d.scope, 'upstream');
    });

    test('实例 B 可见共享状态：同一 key 同样被拒（多实例共享核心断言）', function () {
      const d = l2.allow({ upstream: 'u1', clientIp: '1.1.1.1' });
      assert.strictEqual(d.allowed, false);
    });

    test('不同 clientIp 的 key 不受共享消耗影响', function () {
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '2.2.2.2' }).allowed, true);
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '2.2.2.2' }).allowed, true);
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '2.2.2.2' }).allowed, false);
    });

    test('status() 标记 sqlite:true 且桶快照共享', function () {
      const s = l1.status();
      assert.strictEqual(s.sqlite, true);
      assert.ok(Array.isArray(s.buckets) && s.buckets.length >= 2);
    });

    test('跨实例 settle 回填（token 维度）也共享', function () {
      // 新 key 先 allow（建桶），再 settle 触碰 tokenCount，另一实例能看到 limited 状态
      const key = 'u1::3.3.3.3';
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '3.3.3.3' }).allowed, true);
      // 耗尽 tokenBucket（capacity=2 已用 1，再 allow 1 次到 2，再 deny）
      assert.strictEqual(l1.allow({ upstream: 'u1', clientIp: '3.3.3.3' }).allowed, true);
      l1.settle({ upstream: 'u1', clientIp: '3.3.3.3', usedTokens: 999999 }); // 超过 maxTokensPerMinute
      const sync = l2.status().buckets.find(function (b) { return b.key === key; });
      assert.ok(sync && sync.limited === true, '实例 B 应看到该 key 的 token 维度被限');
    });

    rateStore.close();
  }
} catch (e) {
  console.log('  ✗ SQLite 共享测试异常：' + e.message);
  fail++;
  failedNames.push('sqlite-suite');
}

// ---- 对照组：内存模式（sqlite=false）两个实例互相独立 ----
(function () {
  const m1 = createRateLimiter(); m1.init({ enabled: true, tokenBucket: { capacity: 1, refillPerSecond: 0 } });
  const m2 = createRateLimiter(); m2.init({ enabled: true, tokenBucket: { capacity: 1, refillPerSecond: 0 } });
  test('内存模式（对照组）实例 A 消耗不影响实例 B（互相独立）', function () {
    assert.strictEqual(m1.allow({ upstream: 'x', clientIp: '9.9.9.9' }).allowed, true);
    assert.strictEqual(m1.allow({ upstream: 'x', clientIp: '9.9.9.9' }).allowed, false); // A 已空
    assert.strictEqual(m2.allow({ upstream: 'x', clientIp: '9.9.9.9' }).allowed, true);  // B 仍独立有额度
  });
})();

cleanupTmp();

console.log('\n多实例限流 SQLite 共享测试：' + pass + ' 通过 / ' + fail + ' 失败' + (failedNames.length ? '（失败：' + failedNames.join('、') + '）' : ''));
process.exit(fail ? 1 : 0);
