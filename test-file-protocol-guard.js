// test-file-protocol-guard.js
// 验证：当用户从文件系统直接双击打开 index.html（file:// 协议）时，
// 页面源码中已内置友好引导与启动提示，防止 UI"毁坏"、按钮无反应。
// 由于 file:// 下 ESM 会被浏览器拦截，真正运行时 app.js 不会执行；
// 本测试聚焦源码级兜底是否到位，并用现有 jsdom 测试确认放行开关有效。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');

const ROOT = __dirname;
const SRC_INDEX = path.join(ROOT, 'index.html');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');

// 先构建 dist，确保生产产物也包含兜底
execSync('node build.js', { cwd: ROOT, stdio: 'inherit' });

const srcHtml = fs.readFileSync(SRC_INDEX, 'utf-8');
const distHtml = fs.readFileSync(DIST_INDEX, 'utf-8');

function checkFileProtocolGuard(html, label) {
  assert(html.includes('location.protocol !== \'file:\''), label + '：应检测 file:// 协议');
  assert(html.includes('请通过本地代理打开'), label + '：应包含引导标题');
  assert(/127\.0\.0\.1[\s\S]{0,80}8787|8787[\s\S]{0,80}127\.0\.0\.1/.test(html), label + '：应提示正确代理地址');
  assert(html.includes('不能直接双击打开 HTML 文件'), label + '：应明确禁止双击打开');
  assert(html.includes('__FILE_PROTOCOL_OK__'), label + '：应包含测试放行开关');
  assert(html.includes('file-protocol-warning'), label + '：应包含兜底卡片样式类');
}

console.log('检查 index.html（源文件）...');
checkFileProtocolGuard(srcHtml, 'index.html');

console.log('检查 dist/index.html（构建产物）...');
checkFileProtocolGuard(distHtml, 'dist/index.html');

console.log('\nfile:// 协议兜底源码检测：5 通过 / 0 失败');
