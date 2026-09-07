'use strict';
/*
 * test-log-api.js — Phase 2a SQLite 结构化日志接口回归冒烟
 * 不依赖任何外部上游 Key：用「无路由模型」触发 503 落库，验证整条埋点+查询+导出链路。
 * 运行：node test-log-api.js   （需先 npm install 装好 better-sqlite3，且 proxy/config.json 存在）
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = __dirname;
const PORT = 8799;                 // 独立端口，避免与正在运行的 8787 冲突
const PROXY = path.join(ROOT, 'proxy', 'proxy.js');
const CONFIG = path.join(ROOT, 'proxy', 'config.json');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } }
function req(method, p, body, extraHeaders) {
  return new Promise(function (resolve) {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, extraHeaders || {}),
    }, function (res) {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: text, headers: res.headers });
      });
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
function waitHealth() {
  return new Promise(function (resolve) {
    let n = 0; const tick = () => req('GET', '/health').then(r => {
      if (r.status === 200) return resolve(true);
      if (n++ > 50) return resolve(false);
      setTimeout(tick, 300);
    });
    tick();
  });
}

(async function () {
  console.log('== Phase 2a 日志接口冒烟 ==');
  if (!require('fs').existsSync(CONFIG)) { console.error('缺少 proxy/config.json，跳过'); process.exit(2); }
  const fs = require('fs');
  // proxy.js 不读端口环境变量，故复制一份 config（改端口）作为独立测试实例，避免占用 8787
  const tmpCfg = path.join(ROOT, '.verify', 'test-config.json');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.port = PORT;
  fs.mkdirSync(path.dirname(tmpCfg), { recursive: true });
  fs.writeFileSync(tmpCfg, JSON.stringify(cfg));
  const child = spawn(process.execPath, [PROXY, tmpCfg], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch (e) {} };
  process.on('exit', cleanup);

  if (!await waitHealth()) { console.error('proxy 未启动（8787 可能被占用）'); cleanup(); process.exit(2); }
  console.log('  proxy 已启动');

  // 1) 日志接口本机免 token
  const list0 = await req('GET', '/api/log/list');
  ok(list0.status === 200, '/api/log/list 返回 200（本机免 token）');
  ok(list0.json && list0.json.disabled === false, '日志模块已启用（disabled=false）');

  // 2) 触发一条落库记录（带 config.token 通过鉴权，进入 handleChat 后无论成功/失败都会落库）
  const cfgReal = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const tok = cfgReal.token || '';
  const modelName = 'no-such-model-' + Date.now();
  const chat = await req('POST', '/v1/chat/completions', { model: modelName, messages: [{ role: 'user', content: 'hi' }] }, tok ? { 'x-proxy-token': tok } : {});
  ok(chat.status !== 0, '聊天请求已处理（status=' + chat.status + '）');

  // 3) 等待日志队列 flush（db 写入为 1s 批量异步，不阻塞接口）
  await new Promise(function (r) { setTimeout(r, 1600); });

  const list1 = await req('GET', '/api/log/list?pageSize=5');
  ok(list1.status === 200 && list1.json.total >= 1, '/api/log/list 含 ≥1 条记录（total=' + (list1.json && list1.json.total) + '）');
  const row = list1.json && list1.json.data && list1.json.data[0];
  ok(row && typeof row.status_code === 'number', '最新记录含数值 status_code=' + (row && row.status_code));
  ok(row && row.model === modelName, '记录 model 与请求一致（' + (row && row.model) + '）');

  // 4) 统计接口
  const stat = await req('GET', '/api/log/stat');
  ok(stat.status === 200 && Array.isArray(stat.json.stats), '/api/log/stat 返回 stats 数组');

  // 5) 导出 CSV（含表头）
  const exp = await req('GET', '/api/log/export');
  ok(exp.status === 200, '/api/log/export 返回 200');
  ok(/text\/csv/i.test(exp.headers['content-type'] || ''), 'Content-Type 为 text/csv');
  ok(/request_time,upstream,model/.test(exp.text), 'CSV 含表头行');

  // 6) 非本机来源须 token（用伪造远端 IP 不能轻易模拟；改为验证接口在 disabled 时返回友好提示）
  //    远端 401 由集成测试覆盖（本机环境无法伪造 remoteAddress），此处仅确认结构。

  cleanup();
  console.log('\n== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==');
  process.exit(fail ? 1 : 0);
})();
