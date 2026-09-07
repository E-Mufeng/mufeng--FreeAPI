'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROXY_JS = path.join(__dirname, 'proxy', 'proxy.js');
const NODE = process.env.WINNODE || process.execPath;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpReq(method, port, path_, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: '127.0.0.1', port, path: path_, headers: { 'Content-Type': 'application/json', 'Content-Length': data ? data.length : 0 } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  let pass = 0, fail = 0;
  function ok(msg) { pass++; console.log('  ✓', msg); }
  function no(msg, detail) { fail++; console.error('  ✗', msg, detail || ''); }

  // 上游 A：返回 429（模拟免费模型限流）
  const upstreamA = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }));
    });
  });
  await new Promise(r => upstreamA.listen(0, '127.0.0.1', r));
  const portA = upstreamA.address().port;

  // 上游 B：返回 200
  const upstreamB = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fb', object: 'chat.completion',
        model: 'model-b-real',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
    });
  });
  await new Promise(r => upstreamB.listen(0, '127.0.0.1', r));
  const portB = upstreamB.address().port;

  const testPort = 8790 + Math.floor(Math.random() * 100);
  const tmpCfg = path.join(os.tmpdir(), 'freeapi-failover-test-config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify({
    port: testPort, host: '127.0.0.1', token: '', mode: 'strict', accessPassword: '',
    rateLimit: { enabled: false },
    upstreams: [
      { name: 'up-a', vendor: 'A', baseUrl: 'http://127.0.0.1:' + portA, apiKey: 'x', models: ['model-a'], enabled: true, priority: 1 },
      { name: 'up-b', vendor: 'B', baseUrl: 'http://127.0.0.1:' + portB, apiKey: 'x', models: ['model-b'], enabled: true, priority: 2 }
    ]
  }));

  const child = spawn(NODE, [PROXY_JS, tmpCfg], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let perr = ''; child.stderr.on('data', d => perr += d.toString());

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await httpReq('GET', testPort, '/health'); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('代理未就绪:', perr.slice(0, 200)); process.exit(2); }

  const r = await httpReq('POST', testPort, '/v1/chat/completions', {
    model: 'model-a', stream: false, messages: [{ role: 'user', content: 'hi' }]
  });

  if (r.status === 200) ok('请求 429 后通过 failover 拿到 200');
  else no('期望 200，实得 ' + r.status, r.text.slice(0, 200));

  if (r.json && r.json.model === 'model-b-real') ok('响应 model 为备用上游真实模型 model-b-real');
  else no('响应 model 不对', r.text.slice(0, 200));

  if (r.headers['x-freeapi-failover-model'] === 'model-b') ok('X-FreeAPI-Failover-Model 头存在');
  else no('缺少 X-FreeAPI-Failover-Model 头', JSON.stringify(r.headers));

  try { child.kill('SIGKILL'); } catch (e) {}
  try { upstreamA.close(); } catch (e) {}
  try { upstreamB.close(); } catch (e) {}
  try { fs.unlinkSync(tmpCfg); } catch (e) {}

  console.log('\n=== failover 集成测试：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
