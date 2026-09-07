/**
 * free-API 配额 / 余额 UI 真实效果测试（端到端 jsdom）
 * ------------------------------------------------------------
 * 用真实数据形状驱动渲染，验证 v0.12.0 的「每模型 Token 余额」+「厂商余额条」
 * 在浏览器环境中真的渲染出来（而非仅逻辑层测试通过）：
 *   1) 代理在线时 pullQuota 拉到 vendorBalances + modelQuota
 *   2) 免费模型视图注入 .quota-strip 并展示厂商余额 chip + 刷新按钮
 *   3) 卡片「Token 余额」行渲染「剩余 X / Y（已用 Z）」+ 进度条
 *   4) 配额刷新按钮可点击（data-act=quota-refresh）
 * 用法（需 jsdom，已装在 node 托管工作区）：
 *   NODE_PATH="<node-workspace>/node_modules" "<node-binary>/node.exe" test-ui-quota.js
 */
const fs = require('fs');
const { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

execSync('node build.js', { cwd: __dirname, stdio: 'inherit' });

const FILE = require('path').join(__dirname, 'dist', 'index.html');

// 真实数据形状：模拟代理 /v1/quota 的返回（关键字段与 proxy/quota.js 一致）
const QUOTA_PAYLOAD = {
  ok: true,
  quota: {},                                   // 上游 rate-limit 剩余（兼容字段）
  vendorBalances: [                            // 厂商账户余额（DeepSeek/硅基流动）
    { vendor: '硅基流动', kind: 'siliconflow', balance: 12.34, currency: 'CNY', fetchedAt: Date.now() },
    { vendor: 'DeepSeek', kind: 'deepseek', balance: 0.5, currency: 'USD', fetchedAt: Date.now() }
  ],
  modelUsage: {                                // 日志累计已用 tokens（按模型）
    'sf/Qwen2.5-7B-Instruct': { prompt: 1500, completion: 1500, total: 3000, calls: 18 },
    'th/hy3': { prompt: 900, completion: 900, total: 1800, calls: 9 }
  },
  modelQuota: {                                // 每模型 token 余额（freeQuota - 已用）
    'sf/Qwen2.5-7B-Instruct': { freeQuota: 1000000, used: 3000, remaining: 997000, hasQuota: true },
    'th/hy3': { freeQuota: 1000000, used: 1800, remaining: 998200, hasQuota: true },
    'zhipu/glm-4-flash': { freeQuota: null, used: 0, remaining: null, hasQuota: false }
  },
  fetchedAt: Date.now()
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(FILE, 'utf-8'), {
  url: require('url').pathToFileURL(FILE).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.__FILE_PROTOCOL_OK__ = true;
    window.fetch = (url, opts) => {
      const u = String(url || '');
      const okJson = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
      if (u.indexOf('/health') !== -1) return okJson({ ok: true, mode: 'local', version: '1.0.0' });
      if (u.indexOf('/v1/quota') !== -1) return okJson(QUOTA_PAYLOAD);           // 关键：真实配额形状
      if (u.indexOf('/api/data/free-models') !== -1) return okJson({ freeModels: [], models: [] });
      if (u.indexOf('/routes') !== -1) return okJson({ routes: [] });
      if (u.indexOf('/logs') !== -1) return okJson({ logs: [] });
      if (u.indexOf('/tokens') !== -1) return okJson({ tokens: [] });
      if (u.indexOf('/models') !== -1) return okJson({ data: [] });
      if (u.indexOf('/classifier') !== -1) return okJson({ text: '' });
      if (u.indexOf('/admin/token') !== -1) return okJson({ hasToken: false, text: '未设置' });
      if (u.indexOf('/v1/enabled') !== -1) return okJson({ ok: true });
      return Promise.reject(new Error('offline-test: ' + u));
    };
    window.scrollTo = () => {};
    window.scroll = () => {};
  }
});

const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => window.addEventListener('load', r));
  await wait(600); // 等初始 checkProxyStatus → ensureQuotaSchedule → pullQuota 落地

  const doc = window.document;
  const pass = [], fail = [];
  const ok = (name, cond, extra) => (cond ? pass : fail).push(name + (extra ? ' — ' + extra : ''));

  const startBtn = doc.getElementById('startBtn') || doc.querySelector('#viewWelcome button');
  if (startBtn) startBtn.click();
  await wait(150);

  const freeNav = doc.querySelector('.nav-item[data-mod="free"]');
  if (freeNav) { freeNav.click(); await wait(300); }
  // 再切一次以复用已填充的 proxyModelQuota / proxyVendorBalances 重新渲染
  const ovNav = doc.querySelector('.nav-item[data-mod="overview"]');
  if (ovNav) { ovNav.click(); await wait(150); }
  if (freeNav) { freeNav.click(); await wait(300); }

  const content = doc.getElementById('content');
  const html = content ? content.innerHTML : '';

  // 1) 厂商余额条
  ok('配额条 .quota-strip 已注入', html.includes('quota-strip'));
  ok('厂商余额 chip 渲染（硅基流动）', html.includes('硅基流动') && html.includes('余额 ¥'));
  ok('厂商余额 chip 渲染（DeepSeek）', html.includes('DeepSeek'));
  ok('刷新配额按钮存在（data-act=quota-refresh）', html.includes('quota-refresh'));

  // 2) 卡片 Token 余额行
  ok('卡片含「Token 余额」标签', html.includes('Token 余额'));
  ok('Token 余额显示「剩余 X / Y（已用 Z）」', /剩余\s*[\d,]+\s*\/\s*[\d,]+\（已用\s*[\d,]+/.test(html));
  ok('Token 余额进度条渲染（.mc-bar / .bar）', html.includes('mc-bar') && html.includes('bar'));
  ok('进度条带色调 class（ok/warn/err）', /class="bar (ok|warn|err)"/.test(html));

  // 3) 刷新按钮可点击且会触发拉取（无异常即可）
  const refreshBtn = doc.querySelector('[data-act="quota-refresh"]');
  ok('刷新按钮可点击', !!refreshBtn);
  if (refreshBtn) {
    try { refreshBtn.click(); await wait(200); ok('点击刷新配额无异常', true); }
    catch (e) { ok('点击刷新配额无异常', false, e.message); }
  }

  ok('无未捕获 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass.length + ' 项：');
  pass.forEach(p => console.log('  ✓ ' + p));
  if (fail.length) {
    console.log('\n失败 ' + fail.length + ' 项：');
    fail.forEach(f => console.log('  ✗ ' + f));
  }
  if (errors.length) {
    console.log('\n运行时错误：');
    errors.slice(0, 8).forEach(e => console.log('  ! ' + e));
  }
  console.log('\n结果：' + (fail.length === 0 && errors.length === 0 ? '全部通过' : '存在问题'));
  process.exit(fail.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(2); });
