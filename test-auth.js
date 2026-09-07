'use strict';
// 账号体系（A）集成回归：启动真实代理，验证登录/会话/状态/setup/401/兼容 config.token
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 8800 + Math.floor(Math.random() * 300);  // 随机端口，避免 Windows 上残留进程占用固定端口
const DIR = __dirname;
const cfgPath = path.join(DIR, 'proxy', 'config.auth-test.json');
const base = JSON.parse(fs.readFileSync(path.join(DIR, 'proxy', 'config.example.json'), 'utf8'));
base.port = PORT;
base.token = 'legacy-master-key';   // 预设主控 Key，用于验证设密码后仍兼容 config.token 访问（不依赖 Windows 不支持的 SIGHUP 热加载）
fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: b, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(process.execPath, ['proxy/proxy.js', cfgPath], { cwd: DIR, env: process.env });
  proc.stderr.on('data', d => process.stderr.write('[proxy] ' + d.toString()));
  proc.on('exit', (code, sig) => console.error('[proxy exit] code=' + code + ' signal=' + sig));
  // 等待监听
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await wait(250);
  }
  if (!up) { console.error('代理未启动'); proc.kill('SIGTERM'); fs.unlinkSync(cfgPath); process.exit(1); }

  try {
    console.log('账号体系回归：');
    // 1) 初始无密码
    const s0 = await req('GET', '/api/auth/status');
    ok('初始 hasPassword=false', s0.json && s0.json.hasPassword === false);

    // 2) 无密码直接登录得会话
    const l0 = await req('POST', '/api/auth/login', {});
    ok('无密码 login 返回 sess token', l0.json && /^sess-/.test(l0.json.token) && l0.json.noPassword === true);

    // 3) 带会话访问管理端点 200
    const d1 = await req('GET', '/api/data/status', null, { Authorization: 'Bearer ' + l0.json.token });
    ok('带会话 /api/data/status=200', d1.status === 200);

    // 4) 无密码时本地体验放行（不带会话也 200）
    const d2 = await req('GET', '/api/data/status');
    ok('无密码无会话仍放行=200', d2.status === 200);

    // 5) 首次设置访问密码
    const setup = await req('POST', '/api/auth/setup', { password: '1234' });
    ok('setup 设置密码成功', setup.json && setup.json.ok === true && /^sess-/.test(setup.json.token));

    // 6) 设密码后状态
    const s1 = await req('GET', '/api/auth/status');
    ok('设密码后 hasPassword=true', s1.json && s1.json.hasPassword === true);

    // 7) 设密码后无会话访问管理端点 401
    const d3 = await req('GET', '/api/data/status');
    ok('设密码后无会话=401', d3.status === 401);

    // 8) 错密码登录 401
    const lw = await req('POST', '/api/auth/login', { password: 'wrong' });
    ok('错密码 login=401', lw.status === 401);

    // 9) 对密码登录 200
    const l1 = await req('POST', '/api/auth/login', { password: '1234' });
    ok('对密码 login=200', l1.status === 200 && /^sess-/.test(l1.json.token));

    // 10) 对密码会话访问管理端点 200
    const d4 = await req('GET', '/api/data/status', null, { Authorization: 'Bearer ' + l1.json.token });
    ok('对密码会话 /api/data/status=200', d4.status === 200);

    // 11) 登出后会话失效 401
    const lo = await req('POST', '/api/auth/logout', null, { Authorization: 'Bearer ' + l1.json.token });
    ok('logout=200', lo.status === 200);
    const d5 = await req('GET', '/api/data/status', null, { Authorization: 'Bearer ' + l1.json.token });
    ok('登出后原会话=401', d5.status === 401);

    // 12) 兼容 config.token（旧主控 Key）仍可访问管理端点（代理已预设 token，不依赖 SIGHUP）
    const d6 = await req('GET', '/api/data/status', null, { 'x-proxy-token': 'legacy-master-key' });
    ok('config.token 兼容访问=200', d6.status === 200);
    const d7 = await req('GET', '/api/data/status', null, { Authorization: 'Bearer legacy-master-key' });
    ok('config.token 作 Bearer 兼容=200', d7.status === 200);

    // 13) 重新登录拿有效会话（密码 1234）
    const l2 = await req('POST', '/api/auth/login', { password: '1234' });
    ok('重新登录=200 得会话', l2.status === 200 && /^sess-/.test(l2.json.token));

    // 14) change 用错当前密码 → 401
    const chErr = await req('POST', '/api/auth/change', { current: 'wrong', password: '5678' }, { Authorization: 'Bearer ' + l2.json.token });
    ok('change 错当前密码=401', chErr.status === 401);

    // 15) change 改密码为 5678 → 200
    const chOk = await req('POST', '/api/auth/change', { current: '1234', password: '5678' }, { Authorization: 'Bearer ' + l2.json.token });
    ok('change 改密成功=200', chOk.status === 200 && chOk.json.ok === true);

    // 16) 新密码可登录 / 旧密码 1234 失败 401
    const lNew = await req('POST', '/api/auth/login', { password: '5678' });
    ok('新密码登录=200', lNew.status === 200 && /^sess-/.test(lNew.json.token));
    const lOld = await req('POST', '/api/auth/login', { password: '1234' });
    ok('旧密码登录=401', lOld.status === 401);

  } catch (e) {
    console.error('测试异常：', e);
    fail++;
  } finally {
    proc.kill('SIGTERM');
    try { fs.unlinkSync(cfgPath); } catch (e) {}
    console.log('\n账号体系：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
})();
