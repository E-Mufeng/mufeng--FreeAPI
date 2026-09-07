/**
 * free-API 渲染冒烟测试
 * ------------------------------------------------------------
 * 用 jsdom 真实加载 index.html，逐个切换模块，验证：
 *   1) 脚本执行无未捕获异常
 *   2) 每个模块都能渲染出非空内容
 *   3) 概览页的关键结构（Hero / 统计卡 / 复合布局 / 快捷入口）齐全
 *   4) 设计系统引入的新组件类名确实出现在 DOM 里
 * 用法（需 jsdom，已装在 node 托管工作区）：
 *   NODE_PATH="<node-workspace>/node_modules"  *     "<node-binary>/node.exe" test-ui-render.js
 */
const fs = require('fs');
const { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

// 先以 esbuild 经典打包（IIFE）构建出 dist/，再用 jsdom 加载（jsdom 不支持 ESM，故走经典脚本产物）
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
    // 测试环境用智能 mock：让代理"在线"并填充样本路由，便于验证卡片形态；
    // 其余接口按场景返回合理结构，jsdom 不真正联网。
    window.fetch = (url, opts) => {
      const u = String(url || '');
      const okJson = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
      if (u.indexOf('/health') !== -1) return okJson({ ok: true, mode: 'local', version: '1.0.0' });
      if (u.indexOf('/routes') !== -1) {
        if (opts && /POST|PUT|DELETE/i.test(opts.method || '')) return okJson({ ok: true });
        return okJson({ routes: [
          { name: '测试路由A', vendor: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'], weight: 1, priority: 1, enabled: true, hasKey: true, keyMask: 'sk-or-****abcd' },
          { name: '测试路由B', vendor: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: [], weight: 2, priority: 2, enabled: false, hasKey: false, keyMask: '' }
        ] });
      }
      if (u.indexOf('/logs') !== -1) return okJson({ logs: [] });
      if (u.indexOf('/tokens') !== -1) return okJson({ tokens: [] });
      if (u.indexOf('/models') !== -1) return okJson({ data: [] });
      if (u.indexOf('/classifier') !== -1) return okJson({ text: '' });
      if (u.indexOf('/admin/token') !== -1) return okJson({ hasToken: false, text: '未设置' });
      return Promise.reject(new Error('offline-test: ' + u));
    };
    // jsdom 未实现滚动 API，补空实现以免产生与代码无关的噪声
    window.scrollTo = () => {};
    window.scroll = () => {};
  }
});

const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => window.addEventListener('load', r));
  await wait(400);

  const doc = window.document;
  const pass = [], fail = [];
  const ok = (name, cond, extra) => (cond ? pass : fail).push(name + (extra ? ' — ' + extra : ''));

  // 1. 欢迎页渲染
  const welcome = doc.getElementById('viewWelcome');
  ok('欢迎页存在且非空', welcome && welcome.innerHTML.trim().length > 500,
     welcome ? welcome.innerHTML.length + ' 字符' : '缺失');
  if (welcome) {
    const whtml = welcome.innerHTML;
    ok('欢迎页：3D 产品舞台', whtml.includes('wv-stage'));
    ok('欢迎页：悬浮功能卡片', whtml.includes('wv-cards'));
    ok('欢迎页：玻璃拟态卡片', whtml.includes('wv-card'));
    ok('欢迎页：无顶部重复横幅', !whtml.includes('Free API 工作台<small>本地体验版'));
  }

  // 2. 进入应用
  const startBtn = doc.getElementById('startBtn') || doc.querySelector('#viewWelcome button');
  if (startBtn) startBtn.click();
  await wait(120);
  const appView = doc.getElementById('viewApp');
  ok('主视图已激活', appView && !appView.hasAttribute('hidden'));

  const content = doc.getElementById('content');
  ok('内容容器存在', !!content);

  // 3. 逐个切换模块
  const mods = [
    ['overview', ['hero-banner', 'stat-grid', 'quick-grid', 'with-aside', 'hb-pulse', 'spark']],
    ['free',     ['filter-bar', 'card-grid']],
    ['api',      ['panel', 'stat-grid']],
    ['relay',    ['panel', 'relay-tabs', 'relay-tab', 'relay-grid', 'relay-card', 'rc-dot', 'rc-usage', 'rc-actions']],
    ['routes',   ['panel']]
  ];

  for (const [mod, need] of mods) {
    const nav = doc.querySelector('.nav-item[data-mod="' + mod + '"]');
    if (!nav) { fail.push(`模块 ${mod}：导航项缺失`); continue; }
    nav.click();
    await wait(150);
    const html = content ? content.innerHTML : '';
    ok(`模块 ${mod} 渲染非空`, html.trim().length > 200, html.length + ' 字符');
    for (const cls of need) {
      ok(`模块 ${mod} 含 .${cls}`, html.includes(cls));
    }
    if (mod === 'relay') {
      const cards = (html.match(/class="relay-card/g) || []).length;
      ok('中转：渲染出规则卡片', cards >= 1, cards + ' 张');
      ok('中转：状态点渲染', html.includes('rc-dot'));
      ok('中转：已启用状态点', html.includes('rc-dot on'));
      ok('中转：行内启停按钮', html.includes('data-act="route-toggle"'));
      ok('中转：行内测试按钮', html.includes('data-act="route-test"'));
      ok('中转：行内 curl 按钮', html.includes('data-act="route-curl"'));
      ok('中转：无调用时显示空用量提示', html.includes('rc-usage-empty') || html.includes('成功率'));
      ok('中转：模块标签切换已渲染', html.includes('class="relay-tabs"'));
      ok('中转：本地代理标签', html.includes('data-value="proxy"'));
      ok('中转：中转规则标签', html.includes('data-value="rules"'));
      ok('中转：最近调用标签', html.includes('data-value="logs"'));
      ok('中转：分类栏已渲染', html.includes('class="tab-bar"'));
      ok('中转：分类栏可交互', html.includes('data-act="relay-filter"'));
      ok('中转：模型以 tag 展示', html.includes('model-tag'));
      ok('中转：标签切换可交互', html.includes('data-act="relay-tab"'));
    }
    if (mod === 'free' || mod === 'api') {
      ok('生成面板可折叠', html.includes('is-collapsible'));
      ok('生成面板折叠按钮', html.includes('data-act="toggle-gen-panel"'));
    }
  }

  // 4.5 模型广场（阶段 2：厂商色块 / 排序 / 双视图 / 搜索空态）
  const freeNav = doc.querySelector('.nav-item[data-mod="free"]');
  if (freeNav) { freeNav.click(); await wait(200); }

  const cardCount = (content.innerHTML.match(/class="mcard/g) || []).length;
  ok('广场：默认网格视图', /class="card-grid[^"]*" id="catalogGrid"/.test(content.innerHTML));
  ok('广场：渲染出模型卡片', cardCount > 10, cardCount + ' 张');
  ok('广场：厂商色块图标', (content.innerHTML.match(/class="vendor-ico/g) || []).length > 10);
  ok('广场：排序控件', content.innerHTML.includes('data-act="catalog-sort"'));
  ok('广场：视图切换控件', content.innerHTML.includes('data-act="catalog-view"'));
  ok('广场：结果计数', content.innerHTML.includes('result-count'));
  ok('广场：厂商折叠按钮', content.innerHTML.includes('vendor-more'));

  const listBtn = doc.querySelector('[data-act="catalog-view"][data-view="list"]');
  if (listBtn) { listBtn.click(); await wait(200); }
  ok('广场：切到列表视图容器', /class="list-view[^"]*" id="catalogGrid"/.test(content.innerHTML));
  const rowCount = (content.innerHTML.match(/class="mrow"/g) || []).length
                 + (content.innerHTML.match(/class="mrow is-off"/g) || []).length;
  ok('广场：列表行数与卡片数一致', rowCount === cardCount, '卡片 ' + cardCount + ' / 行 ' + rowCount);

  const sortSel = doc.querySelector('[data-act="catalog-sort"]');
  if (sortSel) {
    sortSel.value = 'name';
    sortSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(200);
    ok('广场：排序切换后保持列表视图', /class="list-view[^"]*/.test(content.innerHTML));
    ok('广场：排序状态已选中', doc.querySelector('[data-act="catalog-sort"]').value === 'name');
  }

  let search = doc.getElementById('catalogSearch');
  if (search) {
    search.value = 'qwen';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(180);
    const hit = (content.innerHTML.match(/class="mrow[ "]/g) || []).length;
    ok('广场：搜索过滤生效', hit > 0 && hit < rowCount, '命中 ' + hit + ' / 原 ' + rowCount);
    const clearBtn = doc.querySelector('[data-act="catalog-clear-q"]');
    ok('广场：清除按钮随输入显示', clearBtn && !clearBtn.hasAttribute('hidden'));
    if (clearBtn) { clearBtn.click(); await wait(200); }
    const back = (doc.getElementById('content').innerHTML.match(/class="mrow[ "]/g) || []).length;
    ok('广场：清除搜索后恢复全量', back === rowCount, back + ' / ' + rowCount);
  }

  search = doc.getElementById('catalogSearch');
  if (search) {
    search.value = 'zzz-not-exist-model';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(180);
    ok('广场：无结果时显示空态', content.innerHTML.includes('没有匹配的模型'));
    const clearFilter = doc.querySelector('[data-act="catalog-clear-filter"]');
    ok('广场：空态提供清除筛选入口', !!clearFilter);
    if (clearFilter) {
      clearFilter.click();
      await wait(200);
      const restored = (doc.getElementById('content').innerHTML.match(/class="mrow[ "]/g) || []).length;
      ok('广场：清除筛选后恢复全量', restored === rowCount, restored + ' / ' + rowCount);
    }
  }

  // 4. 回到概览，做细粒度结构校验
  const ovNav = doc.querySelector('.nav-item[data-mod="overview"]');
  if (ovNav) { ovNav.click(); await wait(200); }
  const ov = content.innerHTML;
  ok('概览：Hero 标题', ov.includes('Free API 工作台'));
  ok('概览：状态脉冲环', ov.includes('hb-pulse'));
  ok('概览：4 张统计卡', (ov.match(/class="stat"/g) || []).length === 4,
     '实际 ' + (ov.match(/class="stat"/g) || []).length + ' 张');
  ok('概览：4 个快捷入口', (ov.match(/class="quick-card"/g) || []).length === 4,
     '实际 ' + (ov.match(/class="quick-card"/g) || []).length + ' 个');
  ok('概览：依次入场动画容器', ov.includes('stagger'));
  ok('概览：模型分布进度条', ov.includes('dist-row') || ov.includes('state-box'));
  ok('概览：7 日趋势 spark', ov.includes('spark'));
  ok('概览：调用地址展示', ov.includes('/v1'));

  // 4.6 API 管理统计卡（与中转页统一视觉语言）
  const apiNav = doc.querySelector('.nav-item[data-mod="api"]');
  if (apiNav) {
    apiNav.click();
    await wait(200);
    const apiHtml = content.innerHTML;
    ok('API：渲染统计卡区块', apiHtml.includes('stat-grid'));
    ok('API：4 张状态统计卡', (apiHtml.match(/class="stat"/g) || []).length === 4,
       '实际 ' + (apiHtml.match(/class="stat"/g) || []).length + ' 张');
    ok('API：含接口清单面板', apiHtml.includes('接口清单'));
  }

  // 4.7 无障碍与响应式基线（L9/L10 巡检）
  ok('A11y：跳到主内容链接存在', !!doc.querySelector('.skip-link'));
  ok('A11y：主内容区可聚焦', !!doc.getElementById('content') && doc.getElementById('content').getAttribute('tabindex') === '-1');
  ok('A11y：模块导航带 aria-label', !!doc.querySelector('.nav[aria-label]'));
  ok('A11y：弹窗为模态', !!doc.querySelector('.dialog[role="dialog"][aria-modal="true"]'));

  // 4.8 上游路由卡片化（代理在线时渲染卡片网格，复用 relay-card 框架）
  const routesNav = doc.querySelector('.nav-item[data-mod="routes"]');
  if (routesNav) {
    routesNav.click();
    await wait(500);
    const upBody = doc.getElementById('upRoutesBody');
    const upHtml = upBody ? upBody.innerHTML : '';
    ok('上游路由：渲染卡片网格', upHtml.includes('relay-grid'));
    ok('上游路由：渲染出路由卡片', (upHtml.match(/class="relay-card/g) || []).length >= 1,
       (upHtml.match(/class="relay-card/g) || []).length + ' 张');
    ok('上游路由：状态点', upHtml.includes('rc-dot'));
    ok('上游路由：URL 信息行', upHtml.includes('ur-url'));
    ok('上游路由：Key 状态行', upHtml.includes('ur-key'));
    ok('上游路由：未填 Key 警示', upHtml.includes('未填 Key'));
    ok('上游路由：行内编辑按钮', upHtml.includes('data-act="uproute-edit"'));
    ok('上游路由：行内启停按钮', upHtml.includes('data-act="uproute-toggle"'));
    ok('上游路由：行内测试按钮', upHtml.includes('data-act="uproute-test"'));
    ok('上游路由：模型以 tag 展示', upHtml.includes('model-tag'));
    ok('上游路由：URL+Key 双元行', upHtml.includes('ur-meta'));
  }

  // 4.9 代理详情抽屉（C：L8 悬浮交互补全）
  const ov2 = doc.querySelector('.nav-item[data-mod="overview"]');
  if (ov2) { ov2.click(); await wait(200); }
  ok('抽屉：DOM 容器存在', !!doc.getElementById('drawerRoot') && !!doc.getElementById('drawer'));
  ok('抽屉：标题/关闭/内容区存在',
     !!doc.getElementById('drawerTitle') && !!doc.getElementById('drawerClose') && !!doc.getElementById('drawerBody'));
  ok('概览：含代理详情入口按钮', !!doc.querySelector('[data-act="proxy-detail"]'));
  const pdBtn = doc.querySelector('[data-act="proxy-detail"]');
  if (pdBtn) {
    pdBtn.click();
    await wait(140);
    const dr = doc.getElementById('drawerRoot');
    ok('抽屉：点击入口后打开', dr && !dr.hidden);
    const db = doc.getElementById('drawerBody');
    ok('抽屉：含状态区', db && /drawer-status/.test(db.innerHTML));
    ok('抽屉：含调用地址', db && /drawer-addr/.test(db.innerHTML));
    ok('抽屉：含实时统计', db && /drawer-stat/.test(db.innerHTML));
    ok('抽屉：含内容区块', db && /drawer-block/.test(db.innerHTML));
    ok('抽屉：对话框语义完整', !!doc.querySelector('#drawer[role="dialog"][aria-modal="true"]'));
    const closeBtn = doc.getElementById('drawerClose');
    closeBtn.click();
    await wait(140);
    ok('抽屉：点击关闭后收起', dr && dr.hidden === true);
    ok('抽屉：遮罩为纯装饰已隐藏', doc.getElementById('drawerMask').getAttribute('aria-hidden') === 'true');
  }

  // 5. 设置弹窗（验证 switch-btn 修复生效）
  const settingBtn = doc.getElementById('settingBtn');
  if (settingBtn) {
    settingBtn.click();
    await wait(150);
    const dlg = doc.getElementById('dlgBody').innerHTML;
    ok('设置弹窗：开关已改用 switch-btn', dlg.includes('switch-btn'));
    ok('设置弹窗：无旧类名残留冲突', !/class="switch"[^"]*"[^>]*role="switch"/.test(dlg));
    ok('设置弹窗：卡片网格布局', dlg.includes('settings-grid'));
    ok('设置弹窗：显示/行为/安全卡片', dlg.includes('settings-card'));
    ok('设置弹窗：界面主题选择', dlg.includes('setTheme'));
    ok('设置弹窗：外观背景选择', dlg.includes('bg-thumb'));
    ok('设置弹窗：亮度滑块', dlg.includes('setBrightness'));
    ok('设置弹窗：字号缩放', dlg.includes('setFontScale'));
    ok('设置弹窗：字体选择', dlg.includes('setFontFamily'));
    ok('设置弹窗：启动页面选择', dlg.includes('setStartup'));
    ok('设置弹窗：快捷键列表', dlg.includes('shortcut-row'));
    ok('设置弹窗：清除数据按钮', dlg.includes('clear-data'));
    const closeBtn = doc.querySelector('#dlgBtns [data-mact="close"]');
    ok('设置弹窗：关闭按钮可识别', !!closeBtn);
  }

  // 6. 主题系统
  ok('主题：body 已应用 theme-light', doc.body.classList.contains('theme-light'));

  // 7. 未捕获异常
  ok('无未捕获 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 输出
  console.log('\n通过 ' + pass.length + ' 项：');
  pass.forEach(p => console.log('  \u2713 ' + p));
  if (fail.length) {
    console.log('\n失败 ' + fail.length + ' 项：');
    fail.forEach(f => console.log('  \u2717 ' + f));
  }
  if (errors.length) {
    console.log('\n运行时错误：');
    errors.slice(0, 8).forEach(e => console.log('  ! ' + e));
  }
  console.log('\n结果：' + (fail.length === 0 && errors.length === 0 ? '全部通过' : '存在问题'));
  process.exit(fail.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(2); });
