/**
 * Free API 工作台 - 真实上游 API 端到端测试（自包含）
 * 脚本自己拉起 proxy/proxy.js（子进程）→ 轮询 /health 就绪 → 真实调用上游 → 杀掉代理。
 * 只调用「明确免费」的模型，避免误扣费；密钥运行时从 config.json 读取，绝不写死。
 * 运行：node e2e-api-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'proxy', 'config.json'), 'utf8'));
const HOST = CONFIG.host || '127.0.0.1';
const PORT = CONFIG.port || 8787;
const TOKEN = CONFIG.token || '';
const BASE = `http://${HOST}:${PORT}`;

const results = [];
let proxyProc = null;

function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
function mask(s) { return s ? (s.slice(0, 4) + '…' + s.slice(-4)) : '(空)'; }

function req(method, p, { body, auth, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = 'Bearer ' + auth;
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', (e) => resolve({ status: 0, json: null, text: '', headers: {}, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
// 对真实上游调用做瞬时连接错误（status=0，如上游免费层偶发 ECONNRESET）退避重试；
// 真实路由/鉴权错误（非 0 状态）不会被掩盖，仅抗上游抖动，保证 e2e 反映真实路由健康。
async function reqRetry(method, p, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await req(method, p, opts);
    if (last.status !== 0) return last;
    if (i < tries - 1) await new Promise((s) => setTimeout(s, 1500));
  }
  return last;
}

async function waitHealth(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req('GET', '/health');
    if (r.status === 200) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

function startProxy() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'proxy', 'proxy.js')], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', (e) => { errBuf += '\n[spawn error] ' + e.message; });
    child.on('exit', (code) => { if (!resolved) console.log('[proxy] 进程退出 code=' + code + (errBuf ? ' err=' + errBuf.slice(0, 300) : '')); });
    let resolved = false;
    const tick = setInterval(async () => {
      const up = await waitHealth(1500).catch(() => false);
      if (up && !resolved) { resolved = true; clearInterval(tick); resolve(child); }
    }, 400);
    // 兜底：6s 后若仍未就绪也返回，让上层判 ready
    setTimeout(() => { if (!resolved) { resolved = true; clearInterval(tick); resolve(child); } }, 6000);
  });
}

function firstContent(json) {
  try {
    if (json.choices && json.choices[0] && json.choices[0].message) return json.choices[0].message.content;
    if (json.error) return '[error] ' + (json.error.message || JSON.stringify(json.error));
  } catch (e) {}
  return null;
}

async function main() {
  console.log('=== Free API 代理 真实上游 E2E ===');
  console.log('代理地址 ' + BASE + '，主控 Key ' + mask(TOKEN) + '，上游路由 ' + (CONFIG.routes || CONFIG.upstreams).length + ' 条');

  proxyProc = await startProxy();
  const ready = await waitHealth(3000);
  rec('代理启动并监听 /health', ready, ready ? BASE + '/health' : '代理未就绪');

  if (!ready) {
    rec('后续真实调用', false, '代理未启动，无法继续');
  } else {
    // 1) 鉴权：错误 Key 应 401，正确 Key 应 200
    const badAuth = await req('GET', '/v1/test/auth', { auth: 'wrong-key' });
    rec('鉴权拒绝-错误Key→401', badAuth.status === 401, 'status=' + badAuth.status);
    const goodAuth = await req('GET', '/v1/test/auth', { auth: TOKEN });
    rec('鉴权通过-主控Key→200', goodAuth.status === 200, 'status=' + goodAuth.status);

    // 2) /v1/models 列表
    const models = await req('GET', '/v1/models');
    const modelCount = models.json && models.json.data ? models.json.data.length : 0;
    rec('模型目录可枚举', modelCount > 0, '模型数=' + modelCount);

    // 3) 真实调用-智谱 glm-4-flash（免费）
    const zhipu = await reqRetry('POST', '/v1/chat/completions', {
      auth: TOKEN,
      body: { model: 'glm-4-flash', stream: false, messages: [{ role: 'user', content: '用一句话介绍北京。' }] },
    });
    const zhipuText = firstContent(zhipu.json);
    rec('真实调用-智谱 glm-4-flash', zhipu.status === 200 && zhipuText && !String(zhipuText).startsWith('[error]'),
      'status=' + zhipu.status + (zhipuText ? ' 回复=' + String(zhipuText).slice(0, 40) + '…' : ' err=' + zhipu.text.slice(0, 120)));

    // 4) 真实调用-硅基流动 Qwen/Qwen2.5-7B-Instruct（免费）跨供应商
    // 与上一真实调用拉开间隔，避免触发免费层突发限流导致的瞬时连接重置
    await new Promise((s) => setTimeout(s, 1500));
    const sf = await reqRetry('POST', '/v1/chat/completions', {
      auth: TOKEN,
      body: { model: 'Qwen/Qwen2.5-7B-Instruct', stream: false, messages: [{ role: 'user', content: '1+1 等于几？只回答数字。' }] },
    });
    const sfText = firstContent(sf.json);
    rec('真实调用-硅基流动 Qwen2.5-7B', sf.status === 200 && sfText && !String(sfText).startsWith('[error]'),
      'status=' + sf.status + (sfText ? ' 回复=' + String(sfText).slice(0, 40) + '…' : ' err=' + sf.text.slice(0, 120)));

    // 5) auto 意图路由：简单任务应优先免费模型
    const auto = await reqRetry('POST', '/v1/auto/chat/completions', {
      auth: TOKEN,
      body: { stream: false, messages: [{ role: 'user', content: '把这句中文翻译成英文：今天天气真好。' }] },
    });
    const autoText = firstContent(auto.json);
    rec('auto 意图路由-简单翻译', auto.status === 200 && autoText && !String(autoText).startsWith('[error]'),
      'status=' + auto.status + (autoText ? ' 回复=' + String(autoText).slice(0, 40) + '…' : ' err=' + auto.text.slice(0, 120)));

    // 6) 额度同步：上游 rate-limit 头应被记录
    const quota = await req('GET', '/v1/quota');
    const quotaObj = quota.json && quota.json.quota ? quota.json.quota : {};
    const quotaCount = Object.keys(quotaObj).length;
    rec('额度同步端点可访问', quota.status === 200, 'status=' + quota.status + ' 已同步额度条目=' + quotaCount + (quotaCount ? ' 样例=' + JSON.stringify(quotaObj).slice(0, 80) : '（上游未回 rate-limit 头，待前端推送）'));

    // 7) 健康检查字段
    const h = await req('GET', '/health');
    rec('健康检查含上游/模式', h.json && h.json.mode && Array.isArray(h.json.routes),
      'mode=' + (h.json && h.json.mode) + ' upstreams=' + (h.json && h.json.routes ? h.json.routes.length : '?'));
  }

  // 收尾：杀掉代理，不留进程
  if (proxyProc && !proxyProc.killed) {
    try { proxyProc.kill('SIGKILL'); } catch (e) {}
    console.log('[proxy] 已终止子进程');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 / 共 ${results.length} ===`);
  if (failed > 0) {
    console.log('失败项：' + results.filter((r) => !r.ok).map((r) => r.name).join('、'));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); if (proxyProc && !proxyProc.killed) try { proxyProc.kill('SIGKILL'); } catch (x) {} process.exit(2); });
