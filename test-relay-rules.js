/*
 * free-API 中转规则真实回归测试
 * 直接经本地代理 127.0.0.1:8787 跑三条中转规则，验证连通、模型路由、鉴权。
 * 用法：node test-relay-rules.js
 */
const http = require('http');

const PROXY = 'http://127.0.0.1:8787';
// 鉴权 token（代理访问密码）从环境变量读取，绝不硬编码密钥进仓库。
// 运行前：FREE_API_TOKEN=你的访问密码 node test-relay-rules.js
const TOKEN = process.env.FREE_API_TOKEN || '';
if (!TOKEN) {
  console.error('缺少鉴权 token：请设置环境变量 FREE_API_TOKEN（代理访问密码）。');
  console.error('示例：FREE_API_TOKEN=your_password node test-relay-rules.js');
  process.exit(2);
}
const CASES = [
  { name: '对话-主线路', model: 'qwen-plus' },
  { name: '对话-备用线', model: 'glm-4-flash' },
  { name: '图像-理解', model: 'glm-4v-flash' }
];

function chat(model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
      stream: false
    });
    const t0 = Date.now();
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let data = {};
        try { data = JSON.parse(buf.toString('utf8')); } catch (e) {}
        resolve({
          status: res.statusCode,
          latency: Date.now() - t0,
          model: data.model || model,
          content: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '',
          usage: data.usage || {},
          raw: buf.toString('utf8').slice(0, 200)
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('测试代理:', PROXY);
  console.log('规则数:', CASES.length);
  console.log('');
  let allOk = true;
  for (const c of CASES) {
    process.stdout.write(`[${c.name}] model=${c.model} ... `);
    try {
      const r = await chat(c.model);
      if (r.status === 200 && r.content) {
        console.log('OK', `${r.latency}ms`, `response_model=${r.model}`, `tokens=${r.usage.total_tokens || '-'}`);
      } else {
        allOk = false;
        console.log('FAIL', `status=${r.status}`, r.raw);
      }
    } catch (e) {
      allOk = false;
      console.log('ERROR', e.message);
    }
  }
  console.log('');
  console.log(allOk ? '全部通过' : '存在失败');
  process.exit(allOk ? 0 : 1);
}

main();
