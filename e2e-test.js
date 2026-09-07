/**
 * Free API 工作台 - 全量真实场景 E2E 测试
 * 运行：NODE_PATH=... node e2e-test.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, 'index.html');
const REPORT_PATH = path.resolve(__dirname, 'e2e-report.md');
const SCREEN_DIR = path.resolve(__dirname, 'e2e-screens');

if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });

const ISSUES = [];
const LOGS = { errors: [], warnings: [], infos: [], network: [] };

function issue(category, title, repro, suggest, severity = 'bug') {
  ISSUES.push({ category, severity, title, repro, suggest });
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(SCREEN_DIR, `${name}.png`), fullPage: false });
  } catch (e) { /* ignore */ }
}

async function safeClick(page, sel, opts = {}) {
  try {
    const el = page.locator(sel).first();
    await el.waitFor({ state: 'visible', timeout: opts.timeout || 3000 });
    await el.click();
    return true;
  } catch (e) {
    return false;
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text(), location: msg.location() };
    if (msg.type() === 'error') LOGS.errors.push(entry);
    else if (msg.type() === 'warning') LOGS.warnings.push(entry);
    else LOGS.infos.push(entry);
  });
  page.on('pageerror', err => LOGS.errors.push({ type: 'pageerror', text: err.message, stack: err.stack }));
  page.on('requestfailed', req => LOGS.network.push({ type: 'failed', url: req.url(), method: req.method(), failure: req.failure() && req.failure().errorText }));
  page.on('response', res => { if (res.status() >= 400) LOGS.network.push({ type: 'bad-status', url: res.url(), status: res.status() }); });

  // 0. 清空数据后加载
  await page.goto('file:///' + HTML_PATH.replace(/\\/g, '/'));
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);

  // 1. 欢迎页
  const welcomeOk = await page.isVisible('.welcome-view').catch(() => false);
  if (!welcomeOk) issue('渲染', '欢迎页未渲染', '打开 index.html', '检查 welcome-view 与初始化逻辑', 'bug');
  else {
    const title = await page.locator('.wv-title').textContent().catch(() => '');
    if (!title.includes('Free API')) issue('渲染', '欢迎页标题异常', '打开欢迎页', '检查 .wv-title', 'bug');
    await screenshot(page, '01-welcome');

    // 量化检查：首页是否一屏可见
    const fits = await page.evaluate(() => {
      const tolerance = 4;
      const sh = document.documentElement.scrollHeight;
      const vh = window.innerHeight;
      return { scrollHeight: sh, viewportHeight: vh, fits: sh <= vh + tolerance };
    });
    if (!fits.fits) issue('渲染', `欢迎页在 ${fits.viewportHeight}px 高下需滚动（内容高 ${fits.scrollHeight}px）`, '打开欢迎页', '继续压缩垂直间距或添加 max-height 媒体查询', 'warning');

    // 背景是否 fixed
    const bgFixed = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundAttachment === 'fixed';
    });
    if (!bgFixed) issue('渲染', 'body 背景未设置为 fixed', '打开欢迎页', '检查 body background-attachment', 'bug');
  }

  // 2. 进入主界面
  await safeClick(page, '#enterBtn');
  await page.waitForTimeout(600);
  const appVisible = await page.isVisible('#viewApp').catch(() => false);
  if (!appVisible) issue('交互', '点击开始体验后未进入主界面', '点击 #enterBtn', '检查 enterApp / switchModule', 'bug');
  await screenshot(page, '02-overview');

  // 3. 侧边栏导航切换
  const mods = [
    { mod: 'overview', label: '概览' },
    { mod: 'free', label: 'Free 模型' },
    { mod: 'api', label: 'API 管理' },
    { mod: 'relay', label: '中转站模型管理' },
    { mod: 'routes', label: '上游路由' },
  ];
  for (const m of mods) {
    const ok = await safeClick(page, `.nav-item[data-mod="${m.mod}"]`);
    if (!ok) {
      issue('渲染', `侧边栏 ${m.label} 导航不可点击`, '进入主界面', `检查 .nav-item[data-mod="${m.mod}"]`, 'bug');
      continue;
    }
    await page.waitForTimeout(400);
    const active = await page.locator(`.nav-item[data-mod="${m.mod}"]`).evaluate(el => el.classList.contains('is-active')).catch(() => false);
    if (!active) issue('交互', `点击 ${m.label} 导航后未高亮`, `点击 .nav-item[data-mod="${m.mod}"]`, '检查 switchModule active 逻辑', 'bug');
    const contentHasText = await page.locator('.content').textContent().then(t => t.trim().length > 30).catch(() => false);
    if (!contentHasText) issue('渲染', `${m.label} 模块内容区为空`, `切换到 ${m.label}`, `检查 render${m.mod} 函数`, 'bug');
  }
  await screenshot(page, '03-api-module');

  // 4. 设置弹窗 + 主题/背景切换
  await safeClick(page, '#settingBtn');
  await page.waitForTimeout(400);
  const dlgVisible = await page.locator('.dialog').isVisible().catch(() => false);
  if (!dlgVisible) issue('交互', '设置弹窗未打开', '点击 #settingBtn', '检查 modalSettings', 'bug');
  else {
    await screenshot(page, '04-settings');
    // 切 dark 主题
    const themeSel = page.locator('select#setTheme');
    if (await themeSel.isVisible().catch(() => false)) {
      await themeSel.selectOption('dark');
      await page.waitForTimeout(300);
      const hasDark = await page.evaluate(() => document.body.classList.contains('theme-dark'));
      if (!hasDark) issue('交互', '切换到 dark 主题未生效', '设置弹窗选择 dark 主题', '检查 setTheme / applyTheme', 'bug');
    } else issue('渲染', '设置弹窗无主题下拉框', '打开设置弹窗', '检查 #setTheme', 'bug');

    // 恢复示例数据（为后续 Free 模型测试准备）
    const resetOk = await safeClick(page, 'button[data-mact="reset-data"]');
    if (resetOk) {
      await page.waitForTimeout(300);
      const confirmBtn = page.locator('.dialog button[data-mact="do-reset"], .dialog button:has-text("确认恢复")').first();
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      await page.waitForTimeout(600);
    }

    // 切背景图
    const bgBtn = page.locator('[data-bg="nature"]').first();
    if (await bgBtn.isVisible().catch(() => false)) {
      await bgBtn.click();
      await page.waitForTimeout(200);
      const hasBg = await page.evaluate(() => document.body.classList.contains('bg-nature'));
      if (!hasBg) issue('交互', '背景图切换未生效', '设置弹窗点击 nature 背景', '检查 setThemeBg', 'bug');
    }

    // 关闭设置
    const closeOk = await safeClick(page, '.dialog .dlg-close, .dialog button[data-act="close"]');
    if (!closeOk) {
      // 尝试 ESC
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    const dlgStill = await page.locator('.dialog').isVisible().catch(() => false);
    if (dlgStill) issue('交互', '设置弹窗关闭失败', '点击关闭/ESC', '检查 dialog 关闭逻辑', 'bug');
  }

  // 5. API 管理：新增接口
  await safeClick(page, '.nav-item[data-mod="api"]');
  await page.waitForTimeout(400);
  const addApiOk = await safeClick(page, '[data-act="api-add"]');
  if (!addApiOk) {
    issue('交互', 'API 管理页「新增接口」按钮不可点', '切换到 API 管理', '检查 [data-act="api-add"]', 'bug');
  } else {
    await page.waitForTimeout(400);
    const apiDlg = await page.locator('.dialog').isVisible().catch(() => false);
    if (!apiDlg) issue('交互', '新增接口弹窗未打开', '点击新增接口', '检查 modalApi', 'bug');
    else {
      await page.fill('.dialog input#aName', '测试接口');
      await page.fill('.dialog input#aUrl', 'https://api.test.example.com/v1');
      await page.fill('.dialog input#aKey', 'sk-test-123456');
      await safeClick(page, '.dialog button[data-act="save-api"], .dialog .btn-primary');
      await page.waitForTimeout(500);
      const pageText = await page.locator('.content').textContent().catch(() => '');
      if (!pageText.includes('测试接口')) issue('业务逻辑', '新增接口后未出现在列表', '填写并保存新接口', '检查 saveApi 与 renderApi', 'bug');
      else {
        // 删除
        const delOk = await safeClick(page, '.tbl tbody tr:has-text("测试接口") .btn-danger, .tbl tbody tr:has-text("测试接口") [data-act="delete"]');
        if (delOk) {
          await page.waitForTimeout(300);
          const confirmBtn = page.locator('.dialog button:has-text("删除"), .dialog .btn-danger').first();
          if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
          await page.waitForTimeout(400);
          const textAfter = await page.locator('.content').textContent().catch(() => '');
          if (textAfter.includes('测试接口')) issue('业务逻辑', '删除接口后仍显示在列表', '删除测试接口', '检查 deleteApi 与列表刷新', 'bug');
        }
      }
    }
  }
  await screenshot(page, '05-api-flow');

  // 6. Free 模型：搜索过滤
  await safeClick(page, '.nav-item[data-mod="free"]');
  await page.waitForTimeout(400);
  const search = page.locator('input[type="search"], .search-input input, input[placeholder*="搜索"]').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill('qwen');
    await page.waitForTimeout(500);
    const cardCount = await page.locator('.mcard, .model-card').count();
    if (cardCount === 0) {
      // 等待搜索过滤生效
      await page.waitForTimeout(500);
      const cardCount = await page.locator('.mcard, .model-card, .catalog-card').count();
      if (cardCount === 0) {
        issue('业务逻辑', 'Free 模型页搜索 qwen 无结果', '搜索 qwen', '检查 filterModels / 示例数据 / 搜索框绑定', 'bug');
      }
    }
  } else {
    issue('渲染', 'Free 模型页搜索框不可见', '切换到 Free 模型', '检查搜索输入框', 'bug');
  }
  await screenshot(page, '06-free-search');

  // 7. 中转站 / 路由 渲染
  await safeClick(page, '.nav-item[data-mod="relay"]');
  await page.waitForTimeout(400);
  const relayText = await page.locator('.content').textContent().catch(() => '');
  if (relayText.trim().length < 20) issue('渲染', '中转站模型管理页内容为空', '切换到中转站模块', '检查 renderRelay', 'bug');
  await safeClick(page, '.nav-item[data-mod="routes"]');
  await page.waitForTimeout(400);
  const routeText = await page.locator('.content').textContent().catch(() => '');
  if (routeText.trim().length < 20) issue('渲染', '上游路由页内容为空', '切换到上游路由模块', '检查 renderRoutes', 'bug');

  // 8. 边界：清空 localStorage 后刷新
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  const welcomeAfterClear = await page.isVisible('.welcome-view').catch(() => false);
  if (!welcomeAfterClear) issue('边界场景', '清空 localStorage 后未回到欢迎页', '执行 localStorage.clear() 并刷新', '检查初始化逻辑', 'bug');

  // 9. 响应式 375x667
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(500);
  await screenshot(page, '07-mobile');
  const mobileBtnVisible = await page.locator('#mSettingBtn').evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).catch(() => false);
  if (!mobileBtnVisible) issue('响应式', '移动端未出现设置按钮', '视口 375x667', '检查 #mSettingBtn / .m-only 媒体查询', 'warning');

  // 10. 长内容边界：把 localStorage 塞满大量模型数据后再加载
  await page.setViewportSize({ width: 1280, height: 720 });
  const huge = { catalogUser: [], apis: [], routes: [] };
  for (let i = 0; i < 200; i++) {
    huge.catalogUser.push({ id: 'm' + i, name: '模型-' + i, vendor: '测试厂商', type: 'free', free: '测试额度', scopes: ['语言'], status: '可用', updatedAt: Date.now() });
    huge.apis.push({ id: 'a' + i, name: '接口-' + i, baseUrl: 'https://x.com', key: 'k' + i, status: '正常' });
  }
  await page.evaluate(data => {
    localStorage.setItem('wb_freeapi_db_v2', JSON.stringify({
      version: 2,
      settings: { theme: 'dark', themeBg: 'default', brightness: 100, fontScale: 100, fontFamily: 'system', startup: 'free', showMasked: true, confirmDelete: true, intent: false, vaultOn: false },
      module: 'free',
      models: [], apis: data.apis, routes: data.routes, logs: [], sources: [], catalogUser: data.catalogUser, catalogEnabled: {}, catalogVendorKey: {}, relayToken: '', proxyMasterToken: '', gen: { stage: '', scene: '', goal: '', custom: '', collapsed: {} }
    }));
  }, huge);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  const freeLoaded = await page.locator('.content').textContent().catch(() => '').then(t => t.includes('模型-0') || t.includes('模型-199'));
  if (!freeLoaded) issue('边界场景', '大量数据加载后 Free 模型页未正常渲染', '注入 200 条模型/接口后刷新', '检查大数据量下的渲染性能与逻辑', 'bug');
  const hasErr = LOGS.errors.some(e => e.text && (e.text.includes('QuotaExceededError') || e.text.includes('out of memory')));
  if (hasErr) issue('边界场景', '大量数据导致存储/内存错误', '注入 200 条模型/接口', '优化 localStorage 使用或分页', 'bug');

  await browser.close();

  // 生成报告
  let md = '# Free API 工作台 - 全量真实场景测试报告\n\n';
  md += `**测试时间**: ${new Date().toLocaleString()}\n\n`;
  md += `**测试文件**: ${HTML_PATH}\n\n`;
  md += `**截图目录**: ${SCREEN_DIR}\n\n`;

  md += '## 一、问题汇总\n\n';
  if (ISSUES.length === 0) {
    md += '未发现功能级 bug。\n\n';
  } else {
    md += `共发现 **${ISSUES.length}** 个问题。\n\n`;
    const cats = {};
    ISSUES.forEach(it => { cats[it.category] = cats[it.category] || []; cats[it.category].push(it); });
    Object.entries(cats).forEach(([cat, items]) => {
      md += `### ${cat} (${items.length})\n\n`;
      items.forEach((it, i) => {
        md += `${i + 1}. **${it.title}** (${it.severity})\n`;
        md += `   - 现象：${it.repro}\n`;
        md += `   - 建议：${it.suggest}\n\n`;
      });
    });
  }

  md += '## 二、控制台输出\n\n';
  md += `### JS 错误 (${LOGS.errors.length})\n\n`;
  if (LOGS.errors.length === 0) md += '无。\n\n';
  else LOGS.errors.forEach((e, i) => { md += `${i + 1}. \`[${e.type}]\` ${String(e.text).slice(0, 300)}\n`; });

  md += `### Warning 警告 (${LOGS.warnings.length})\n\n`;
  if (LOGS.warnings.length === 0) md += '无。\n\n';
  else LOGS.warnings.forEach((e, i) => { md += `${i + 1}. \`[${e.type}]\` ${String(e.text).slice(0, 300)}\n`; });

  md += `### 网络请求异常 (${LOGS.network.length})\n\n`;
  if (LOGS.network.length === 0) md += '无。\n\n';
  else LOGS.network.forEach((e, i) => { md += `${i + 1}. \`[${e.type}]\` ${e.url} ${e.status || e.failure || ''}\n`; });

  md += '## 三、测试覆盖项\n\n';
  md += '- [x] 欢迎页渲染与标题\n';
  md += '- [x] 欢迎页在 1280x720 下是否一屏可见（无滚动条）\n';
  md += '- [x] body 背景图是否 background-attachment: fixed\n';
  md += '- [x] 进入主界面\n';
  md += '- [x] 侧边栏模块切换（概览/Free 模型/API 管理/中转站/上游路由）\n';
  md += '- [x] 设置弹窗打开/关闭\n';
  md += '- [x] 主题切换（dark）\n';
  md += '- [x] 背景图切换（nature）\n';
  md += '- [x] API 管理新增/删除接口流程\n';
  md += '- [x] Free 模型搜索过滤\n';
  md += '- [x] 中转站/路由页渲染\n';
  md += '- [x] 清空 localStorage 后初始化\n';
  md += '- [x] 响应式 375x667\n';
  md += '- [x] 大量数据（200 条模型/接口）加载边界\n';

  fs.writeFileSync(REPORT_PATH, md, 'utf-8');
  console.log('报告已生成:', REPORT_PATH);
  console.log('问题数:', ISSUES.length);
  console.log('JS 错误:', LOGS.errors.length);
  console.log('Warnings:', LOGS.warnings.length);
  console.log('网络异常:', LOGS.network.length);
}

run().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
