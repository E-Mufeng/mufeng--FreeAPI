# Phase 2c（路线2 架构重构）+ v0.9.0 发版 — 总览

## 目标
将 SPA 业务状态（catalog/relay/freeModels/tokens）收口到代理 SQLite 单一真相源，浏览器仅持久化用户密钥库 + UI 偏好；并修复过程中发现的两个缺陷，发布干净可用的最终版本 v0.9.0。

## 完成内容

### 代理侧（P0/P1/P2，commit d5db0ad）
- 新增 `proxy/stateStore.js`：better-sqlite3 键值层 `state_kv`，与 db.js 同构降级；启动从 config.json 导入（INSERT OR IGNORE）。
- `proxy.js` 接线：stateStore 读写经代理、`reloadConfig` 热加载以 SQLite 为权威、`/api/data/{catalog,relay,free-models}` + `/api/data/status` 端点（与 /api/log 同级鉴权）；向后兼容既有 `PUT /api/config`。

### SPA 数据层瘦身（P3，commit 2e7cbc5）
- `load()` 只从 localStorage 读 `apis`（用户密钥库）/ `settings` / `gen`；业务数据启动后由 `loadConfigFromProxy()` 从代理拉取。
- `save()` 仅持久化 `{version:2, apis, settings, gen}`（`vaultOn` 仍剥离明文 key）。
- `pushStateToProxy()`：relay/catalog/free-models 走 `/api/data/*` PUT，tokens 走 `/api/config` PUT；`importAllConfig` 导入后镜像服务端；`fixRelayRules` 改 no-op（relay 现服务端权威）。

### 🔴 缺陷修复
1. **export token 形状 bug**（proxy.js）：`GET /api/config/export` 原把 `relayToken`/`proxyMasterToken` 放顶层，与 SPA 拉取（`j.tokens.*`）、import（`body.tokens.*`）不一致 → 导出→导入往返丢 token。改为 `tokens.{relayToken,proxyMasterToken}` 对齐，临时校验脚本 5/5 通过。
2. **发布物污染**（build-release.yml）：Phase 2c 引入 stateStore 后代理启动即建 `free_api.db` 并写入冒烟配置，CI 冒烟清理只删 `logs.db*` 漏删 `free_api.db*`，导致 zip 打包了含 CI 测试残留的库。补删 `proxy/free_api.db*`（commit 83c0d47），删旧 Release+tag 重打 v0.9.0 重发。

## 测试门禁（全绿）
- test-ui-render.js **119/119**（P3 未破坏渲染/交互）
- test-rate-limit.js 10/10
- test-state-store.js **8/8**（`/api/data/*` 读写 + 重启持久化）
- test-log-api.js 10/10
- e2e-api-test.js **9/9**（真实上游）

## 真机冒烟验证（发布包解压实跑）
解压干净 Release 包，复制 `config.example.json`→`config.json` 启动代理（8787），curl 真机验证 P3 改革后链路：
- 首页 `GET /` 200；`/api/config/export` 返回 `tokens.{relayToken,proxyMasterToken}`（export 修复生效）；`/api/data/status` → `{"enabled":true,"keys":["catalog","relay","free-models"]}`。
- 静态资源：`/assets/app.<hash>.js`、`/assets/app.<hash>.css`、`/catalog/catalog-embedded.js` 均 200（代理 web 根 = `dist/`，不带 `/dist` 前缀，故 `/dist/...` 404 是预期非 bug）。
- catalog `PUT /api/data/catalog` → 200，`GET` 回读持久化通；启动即生成 `proxy/free_api.db`（stateStore 初始化）。
- 结论：**SPA 实际从代理拉取配置的链路真机全绿**，P3 改革无运行时断点。

## 发版
- 两次 CI（首轮 33978380285 含缺陷 → 修复后 33978715891 clean）均 success。
- 最终 Release：`https://github.com/E-Mufeng/Free-API/releases/tag/v0.9.0`
- 干净包核验：`proxy/free_api.db*` 与 `logs.db*` 均**未进包**，stateStore.js 在位，export 修复在位，版本 0.9.0。

## 待用户（技术侧已闭环，仅剩签字）
1. **肉眼验收 UI**：硬链路已真机验证通过，但仍需使用者解压运行、肉眼确认渲染/交互无回归。
2. 视觉验收通过后，Phase 2 全部正式收口（2a/2b/2c 均完成）。
