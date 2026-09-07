/**
 * free-API · 登录门 → 主界面 渲染冒烟测试（Task C 在线入口路径覆盖）
 * ------------------------------------------------------------
 * 用 jsdom 加载构建产物，mock 代理返回「已设访问密码 + 未登录」，验证：
 *   1) 启动后渲染登录门 #authGate（未登录态）
 *   2) 输入密码并点击登录 → 模拟进入主界面
 *   3) 登录后 #authGate 被移除、主内容 #content 已渲染（欢迎页/导航存在）
 * 说明：本测试覆盖「模拟进入主界面」的在线入口路径；「真连本地代理」的端到端
 * 已由 test-auth.js / e2e-api-test.js 覆盖，此处不重复以避免 jsdom 与硬编码
 * PROXY_BASE=8787 的端口冲突与随之而来的脆弱性。
 * 用法（需 jsdom，已装在 node 托管工作区）：
 *   NODE_PATH="<node-workspace>/node_modules" \
 *   "<node-binary>/node.exe" test-ui-auth-gate.js
 */
const fs = require('fs');
const { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

execSync('node build.js', { cwd: __dirname, stdio: 'inherit' });

const FILE = require('path').join(__dirname, 'dist', 'index.html');
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
    // 放行 file:// 兜底：jsdom 加载 dist/index.html 的 url 为 file://，
    // 但测试已准备 fetch mock，需要正常进入 SPA。
    window.__FILE_PROTOCOL_OK__ = true;
    // 模拟「已设密码、未登录」的代理；登录接口返回会话 token
    window.fetch = (url, opts) => {
      const u = String(url || '');
      const okJson = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
      if (u.indexOf('/api/auth/status') !== -1) return okJson({ hasPassword: true, authed: false });
      if (u.indexOf('/api/auth/login') !== -1) return okJson({ token: 'sess-test', noPassword: false });
      if (u.indexOf('/api/auth/logout') !== -1) return okJson({ ok: true });
      if (u.indexOf('/health') !== -1) return okJson({ ok: true, mode: 'balanced', version: '0.11.0', rateLimit: { disabled: false }, rateStore: { enabled: false }, store: { enabled: true }, logs: { enabled: true }, routes: [{ name: 'u1', healthy: true }] });
      if (u.indexOf('/routes') !== -1) {
        if (opts && /POST|PUT|DELETE/i.test(opts.method || '')) return okJson({ ok: true });
        return okJson({ routes: [] });
      }
      if (u.indexOf('/logs') !== -1) return okJson({ logs: [] });
      if (u.indexOf('/tokens') !== -1) return okJson({ tokens: [] });
      if (u.indexOf('/models') !== -1) return okJson({ data: [] });
      if (u.indexOf('/classifier') !== -1) return okJson({ text: '' });
      if (u.indexOf('/admin/token') !== -1) return okJson({ hasToken: false, text: '未设置' });
      return Promise.reject(new Error('offline-test: ' + u));
    };
    window.scrollTo = () => {};
    window.scroll = () => {};
  }
});

const { window } = dom;
const doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => window.addEventListener('load', r));
  await wait(400);

  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };

  // 1) 未登录 → 登录门渲染
  const gate = doc.getElementById('authGate');
  ok('未登录态渲染登录门 #authGate', !!gate, gate ? '' : '缺失');
  if (gate) {
    const btn = doc.getElementById('authBtn');
    ok('登录门含登录按钮', !!btn);
    ok('登录门含密码输入框', !!doc.getElementById('authPw'));
  }

  // 2) 模拟输入密码并点击登录
  const pw = doc.getElementById('authPw');
  const btn = doc.getElementById('authBtn');
  if (pw && btn) {
    pw.value = '1234';
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  await wait(500);

  // 3) 登录后进入主界面
  ok('登录后 #authGate 已移除', !doc.getElementById('authGate'));
  const content = doc.getElementById('content');
  ok('主内容 #content 已渲染', content && content.children.length > 0, content ? content.children.length + ' 子节点' : '缺失');
  ok('欢迎页 #viewWelcome 存在', !!doc.getElementById('viewWelcome'));
  ok('导航已渲染', !!doc.querySelector('.sidebar, nav, .nav') || !!doc.getElementById('viewWelcome'));

  // 3.1) 侧栏常驻健康徽标（Task E：可观测性，由 checkProxyStatus 同一探测结果驱动）
  const sideHealth = doc.getElementById('sideHealth');
  ok('侧栏常驻健康徽标已渲染 #sideHealth', !!sideHealth);
  if (sideHealth) {
    ok('健康徽标显示在线态 (is-on)', sideHealth.className.indexOf('is-on') !== -1, sideHealth.className);
    const shText = doc.getElementById('shText');
    ok('健康徽标文案含「在线」', !!shText && shText.textContent.indexOf('在线') !== -1, shText ? shText.textContent : '');
    const shVer = doc.getElementById('shVer');
    ok('健康徽标显示版本号', !!shVer && /^v/.test(shVer.textContent), shVer ? shVer.textContent : '');
  }
  ok('无未捕获 JS 异常', errors.length === 0, errors.join(' | '));

  console.log('\n登录门→主界面：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(2); });
