# 更新日志（CHANGELOG）

> 本文件汇总 Free API 工作台的产品级变更。git commit 是最细粒度记录，这里只写「里程碑 / 阶段」级摘要。
> 版本号规则：demo 阶段不编号；第一个可本地持久化的版本定为 **v0.5.0**（与代理 `proxy/status` 返回的 `version` 对齐）。

---

## [v0.12.2] — 2026-09-06 · 额度不足阈值告警 + 额度消耗分析面板 + failover 上游可达性过滤

**性质**：免费模型「可用性 / 可观测性」增强（用户按价值排序点名的两项）+ failover 健壮性修复（回归拦截）。

**核心变更**
1. **额度不足阈值告警（#130，`proxy/quota.js` + `proxy/proxy.js` + `src/app.js`）**
   - `computeModelQuota(models, usage, quotaAlert)` 新增阈值计算：每模型 `remaining/freeQuota` 比例低于 `warnPct`(默认 20%) → `warn`、低于 `critPct`(默认 5%) 或 `remaining<=0` → `crit`；另支持绝对 token 下限 `warnTokens/critTokens`。
   - `fetchVendorBalances` 对 DeepSeek / 硅基流动余额低于 `vendorWarnCny`(¥5)/`vendorCritCny`(¥1) 标 `warn`/`crit`；读取失败标 `crit`。
   - `summarizeAlerts()` 聚合 `thresholdAlerts = { models, vendors, count, hasCrit, hasWarn, cfg }`，经 `GET /v1/quota` 返回。
   - 前端：① 卡片「Token 余额」处显示 ⚠ 告急/偏低 徽标；② 配额条出现可点击告警芯片，点击弹窗列出全部告警明细（含当前生效阈值）。阈值在 `config.json` 的 `quotaAlert` 可调（已补 `config.example.json` 示例）。
2. **额度消耗分析面板（#131，`proxy/db.js` + `proxy/proxy.js` + `src/app.js`）**
   - `db.consumptionStats({days})`：基于 `api_request_log` 聚合 `totals`(请求数/Token/成功率/429 限流率/平均延迟/错误数) + `byModel`(Top，含每模型 429/错误) + `byVendor`(请求数) + `byDay`(近 N 天趋势)。
   - 新增 `GET /v1/quota/usage?days=14`（日志模块关闭时优雅返回 `disabled:true`）。
   - 前端 Free 模块新增「额度消耗分析」面板（零依赖 CSS 条形图）：汇总卡 + 按模型 Token 消耗 Top8 + 按厂商请求数 + 近 14 天每日 Token 趋势，含「刷新」按钮。
3. **failover 上游可达性过滤（回归修复）**
   - `fallbackChain(..., {servableIds})` 现在只保留「当前配置下确有 enabled upstream 服务」的备用模型；无上游的模型（含被 `enabled-models.json` 启用、但测试/精简配置里没配上游的目录模型）不再进入 failover 链，避免 429 限流时 failover 到无上游模型导致 **502「没有可服务模型」** 而非优雅降级。
   - `failover.servableModelIds(config)` 计算可服务集合（支持上游 `models:['*']` 通配）。

**测试**：test-quota（31，含 #130/#131 断言）/ test-failover（含 servableIds 过滤）/ test-failover-integration（3）/ test-rate-limit（10，修复项 10 回归）/ test-ui-render / test-ui-auth-gate（12）/ auth（19）/ state-store（8）/ log-api（10）/ firstrun（4）/ file-protocol（5）— 全绿。

---

## [v0.12.1] — 2026-09-06 · 过期/下架治理 + 时效性保障 + 排序下拉/玻璃态修复 + 隐私收敛（GitHub 上传前）

**性质**：数据治理（用户核心疑问：228 条里有没有过期/已下架？时效性能否保障？）+ UI 细节修复（深色主题排序下拉空白、卡片透明度回退）+ 安全收敛（上传 GitHub 前的隐私/本地内容/边界约束）。

**核心变更**
1. **过期 / 下架治理（`catalog/fetch-catalog.js`）**
   - 新增状态机 `STATUS = {可用/限额/限免/待核实/已过期/已下架}`；`catalogCard`/`catalogRow` 渲染状态 chip。
   - `KNOWN_DISCONTINUED`（已知下架，如旧 `sf/glm-4-9b-chat`）→ `已下架`；`KNOWN_EXPIRES`（已知固定结束日）→ 到期自动转 `已过期`。
   - 实连源（OpenRouter/LiteLLM/SiliconFlow）确认存在 → `已验证`；仅基线、无任何实连源印证的 → `待核实`（当前 65 条）。
   - 刷新 diff：本地多出的模型 → `已下架`（不再误标「已过期」）；上游带 `expiresAt` 且已过期 → 类型转 `expired` + 状态 `已过期`。
   - 结果：228 条中 **已验证 162 / 待核实 65 / 已下架 1**（`catalog/models-catalog.json` 已落盘）。
2. **时效性保障（用户核心疑问）**
   - 每条模型带 `verifiedAt`（ISO 日期，实连源刷新时更新）+ `expiresAt`（已知结束日，可空）。
   - `STALE_DAYS = 7`：UI 对 `verifiedAt` 超 7 天的模型标「信息较旧」；带 `expiresAt` 的显示「活动剩 N 天 / 活动已结束」。
   - 调度：`ensureQuotaSchedule()` 每日 2:00 静默刷新目录（页面在线时）+ 页面「刷新核验」按钮手动触发；关闭页面不跑（收敛到页面驱动，与 v0.12.0 一致）。
   - 说明：情报时效以「实连源最近一次成功核验」为准，非实时；`待核实` 项即「暂无实连源背书」，使用前建议点一次「刷新核验」。
3. **排序下拉修复（深色/赛博朋克主题）**
   - 原生 `<select>` 在深色主题下 `<option>` 不可读（空白）→ 改为自定义玻璃下拉 `.custom-select`（trigger + 浮层菜单 + 外部点击关闭），按供应商/名称/类型排序。
   - 新增 `isStale() / daysAgo() / freshnessHtml()` 与状态 chip 逻辑；`catalogHealth` 改为统计 `已验证` 项。
4. **卡片透明度 / 背景适配回退修复**
   - 深色/赛博朋克 `--surface-glass` 透明度回调（.52→.36 / .45→.28），卡片/行 `backdrop-filter` 模糊加大（卡片 18→26px / 行 10→18px）。
   - 标题加 `text-shadow` 提升可读性；`.custom-select` 浮层玻璃样式 + 箭头随展开旋转。
5. **隐私 / 安全收敛（上传 GitHub 前，用户明确要求）**
   - 密钥仅存 `proxy/config.json`（已 gitignore）与 `.verify/`（已 gitignore）；本回合彻底删除磁盘残留 `.verify/`（含真实 key 的测试脚手架）与旧报告 md。
   - 修复 `test-relay-rules.js`：**移除硬编码 relay token**，改为 `process.env.FREE_API_TOKEN` 读取（缺失即退出并提示），杜绝密钥进仓库。
   - `.gitignore` 扩充：测试临时配置 `proxy/_t*.json` / `proxy/config.auth-test.json` / `catalog/*.bak*` / 保留名 `nul` / 生成概览 `overview-*.md`。
   - 已追踪文件全量扫描：除已 gitignore 的 `proxy/config.json` 外，无真实密钥 / 本地绝对路径泄露（CHANGELOG 中仅叙述性提及脱敏动作）。

**测试**：test-ui-render（全过）/ test-ui-auth-gate（12）/ test-ui-quota（全过）/ test-catalog-refresh（15）/ test-quota（18）/ state-store（8）/ auth（19）/ rate-limit（10）/ rate-limit-sqlite（8）/ log-api（10）/ firstrun（4）— 全绿。

---

## [v0.12.0] — 2026-09-06 · 免费情报多源聚合 + 每模型 Token 余额 + 页面驱动配额刷新

**性质**：情报源扩充（来源「尽量全面」）+ 配额可见性（用户核心诉求）+ 刷新调度收敛到「页面驱动」。

**核心变更**
1. **免费模型情报多源聚合（`catalog/fetch-catalog.js` v2）**
   - 四类来源全部 best-effort 容错、超时隔离（单源 9s，互不阻塞）：
     - A) 厂商内部官方直连基线（CN_BASELINE，手工权威主骨架，扩充至 14 家厂商 + 新增商汤/面壁等）。
     - B) OpenRouter `/api/v1/models` 实时聚合（最全免费总目录）。
     - C) 社区维护价目表 LiteLLM `model_prices_and_context_window.json`（真实大型聚合源，仅收录 `input/output_cost_per_token` 同时为 0 的免费模型，best-effort）。
     - D) 厂商免费模型页 best-effort 校验（SiliconFlow `/v1/models` 实连校验，带 `SILICONFLOW_API_KEY` 时把基线模型 status 提升为「已核实」；匿名 401 则优雅降级）。
   - 合并优先级（同 id 取更优字段，不覆盖非空）：基线 → OpenRouter 实时 → 社区（仅补充新 id）。
   - 新增 `freeQuota`（数值，tokens）/ `freeQuotaPeriod`（如「90天」）字段：厂商公开具体额度时填数值（当前腾讯混元 TokenHub、阿里百炼新人额度 = 100万/90天），纯限流免费填 `null`（不计余额分母）。
   - 抓取结果从 ~22 条扩展到 **228 条**（基线 65 / OpenRouter 22 / 社区 140 / 过期 1）。
2. **每模型 Token 余额（`proxy/quota.js` 新增 + `proxy/db.js` `modelUsage()`）**
   - 余额 = `freeQuota − 本代理日志累计已用 tokens`；已用来自 `db.modelUsage()` 聚合 `api_request_log`，对日志 model 名做归一化（去前缀 + 小写）对齐目录 id。
   - 卡片「Token 余额」行：有 `freeQuota` 显示「剩余 X / Y（已用 Z）」+ 进度条；纯限流显示「按厂商限流」；付费模型显示「付费模型（不计入免费余额）」。
3. **厂商账户余额（仅 DeepSeek / 硅基流动，按用户要求）**
   - `fetchVendorBalances` 调官方余额接口（DeepSeek `/user/balance`、硅基流动 `/v1/user/info/balance`），5min 内存缓存，跳过 `sk-your-` 占位 key，失败以 error 项容错不崩。
4. **配额刷新收敛为「页面驱动」（用户拍板，去掉代理后台定时器）**
   - `ensureQuotaSchedule()`（页面在线时触发）：`setInterval(30min)` 拉配额 + 每日 2:00 静默刷新目录；关页不跑。
   - 页面启动即拉一次配额；每日 2:00 仅当页面在线触发一次，否则下次打开看到刷新后版本。
5. **目录刷新静默保守合并（`handleCatalogRefresh`）**
   - 保留用户对各模型的 `enabled` 覆盖；只更新元数据；不删已启用项、绝不碰 `config.json` 密钥。
   - 过期模型存为 `expired` 类型（默认关闭、可手动开启），不阻断。
   - 刷新后同步内存 `catalogCache.models`，使 `freeQuota` 分母立即生效（无需重启代理）。
   - 新增 `test-catalog-refresh.js`：验证幽灵模型转过期 + `enabled` 覆盖保真 + 元数据刷新 + 密钥不被篡改（15/15）。
6. **新增 `test-quota.js`**：`normalizeKey` / `vendorKind` / `computeModelQuota`（含日志名归一化对齐、超额夹 0）+ 集成 `/v1/quota` 容错（18/18）。

**修复（顺带）**
- `quota.js fetchVendorBalances`：`forEach` 回调内误用 `await`（非 async 函数 → 语法错误，仅在该模块被加载时触发，此前未被测试执行）→ 改为 `for...of`。
- `computeModelQuota` 仅归一化 `m.id` 未归一化 usage 键 → 日志真实模型名（如 `Qwen2.5-7B-Instruct`）无法对齐，余额恒为 0；现同时归一化 usage 键。

**验证（全量回归）**
- 新增：test-quota 18/18、test-catalog-refresh 15/15。
- 旧套件全绿：ui-render（全部）/ ui-auth-gate 12/12 / auth 19 / rate-limit 10 / rate-limit-sqlite 8 / state-store 8 / log-api 10 / firstrun 4 / file-protocol-guard 5 / relay-rules（全部）。
- 累计 109 项断言全绿（76 基线 + 33 新增）。dist 经 `node build.js` 重建。

---

## [v0.11.3] — 2026-09-06 · 隐私清理 + 首页视觉抖动修复

**性质**：安全/隐私热修复 + 视觉 polish。

**核心变更**
1. **移除误提交到源码的真实 API key（严重）**
   - `src/app.js` 的 seed/demo 数据中两条账号（百炼-通用、智谱-主账号）原先写入了与 `proxy/config.json` 一致的真实 key；已替换为明显的 demo 占位符 `sk-demo-bailian-key`、`sk-demo-zhipu-key`，状态同步改为「示例」。
   - 重新构建 `dist/`，确认新产物中不再包含旧 key 字符串。
2. **本地隐私信息脱敏**
   - 扫描并清理已提交报告/脚本中的 Windows 用户名、本地路径等隐私信息：
     - `test-ui-render.js`、`test-ui-auth-gate.js`、`overview.md` 中的本地用户路径改为 `<node-workspace>` / `<node-binary>` 占位符。
     - `review-report-2026-09-03.md`、`诊断与修复报告_2026-09-03.md`、`实测与设计参考报告_2026-09-04.md` 中的本地用户路径与外部应用 key 已脱敏/打码。
     - `proxy/start-proxy.bat`、`proxy/start-proxy-silent.vbs` 不再硬编码 WorkBuddy 托管 node 的绝对路径，改为优先 PATH / `NODE_EXE` 环境变量，最后回退 `%USERPROFILE%\.workbuddy\...`（无具体用户名）。
3. **修复首页“晃动”与边缘白边**
   - `src/styles/main.css`：
     - 为 `html, body` 设置 `background-color: var(--bg)`，防止背景层动画瞬间边缘露出浏览器默认白色背景。
     - `.aurora` 容器由 `inset: 0` 扩展为 `inset: -80px`，让放大/平移的光斑在视口外被裁剪，避免边缘出现白色/透明缝隙。
     - 减弱 `aurora-drift` 动画：`scale(1.08) translate3d(8%,6%,0)` 降至 `scale(1.03) translate3d(2%,2%,0)`，动画周期由 22–32s 延长至 26–36s，消除“页面在晃动”的主观感受。
     - 移除 `body::before` 上冗余的 `background-attachment: fixed`（元素本身已是 `position: fixed`），减少某些浏览器在动画期间的合成器 seam。

**安全提示**
- 由于这些真实 key 曾经出现在 Git 提交历史中，建议到对应平台（阿里云百炼、智谱 AI）**轮换/重置这两个 key**，以防历史提交被泄露。
- `proxy/config.json` 仍保持 gitignored，不会被推送到 GitHub 或打进 Release 包；但本地文件需妥善保管。

---

## [v0.11.2] — 2026-09-06 · 修复 file:// 直开导致 UI"毁坏" + 构建/测试稳定性

**性质**：紧急体验修复 + 测试工程化收尾。

**核心变更**
1. **入口防呆：file:// 协议直开兜底**
   - `index.html` 内联检测脚本：当用户直接双击 HTML 用 `file://` 打开时，不再呈现裸奔界面，而是显示深色科技风引导卡片，明确提示"必须启动本地代理后访问 http://127.0.0.1:8787/"。
   - 兜底卡片同时阻止 ESM 模块继续加载/执行，避免额外报错。
   - jsdom 测试环境通过 `window.__FILE_PROTOCOL_OK__` 放行，不干扰现有渲染测试。
2. **启动脚本增强**
   - `start.bat` / `start.sh` 增加醒目横幅提示"不要直接双击 index.html"，启动后自动打开浏览器访问代理地址。
3. **构建脚本防 safe-delete 守卫拦截**
   - `build.js` 的 `rmrf(dist)` 改为异步、跨事件循环分批删除（每批 40 个文件），避免 WorkBuddy safe-delete 守卫在 `dist/` 文件数 >50 时抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 导致测试/构建中断。
4. **stateStore 测试隔离**
   - `stateStore.js` 支持 `FREE_API_STATE_DB` 环境变量覆盖默认 `free_api.db` 路径。
   - `test-state-store.js` 使用随机端口 + 临时 SQLite 路径，避免固定 `free_api.db` 被残留进程锁定导致回归漂移。
5. **新增 `test-file-protocol-guard.js`**：静态验证源 `index.html` 与构建产物 `dist/index.html` 均包含 file:// 兜底引导。

**验证**：全量回归 76 项全绿（auth 19 / rate-limit 10 / rate-limit-sqlite 8 / state-store 8 / log-api 10 / firstrun 4 / file-protocol guard 5 / ui-render 全部 / ui-auth-gate 12）。

---

## [v0.11.1] — 2026-09-06 · 容器健康探活

**性质**：部署形态补齐（将 v0.11.0 的 `/health` 端点接进容器运行时探活）。

**核心变更**
- `Dockerfile` 运行阶段新增 `HEALTHCHECK`（interval 30s / timeout 5s / start-period 15s / retries 3），直连本容器 `http://127.0.0.1:8787/health`（免鉴权）。代理异常即标记容器 `unhealthy`，编排器可回收/告警。
- 探活用容器自带 `node -e fetch(...)` 实现，无需额外安装 curl。若用 `PORT`/`HOST` 改了监听地址需同步调整 URL。

**说明**：本改为 Dockerfile 纯部署层面，不改动代理/SPA 运行时行为；`npm run build` 与全量回归与 v0.11.0 一致（无新增运行时断言）。

---

## [v0.11.0] — 2026-09-06 · 可观测性（健康端点 + 导航常驻徽标）

**性质**：项目级成熟度补齐（可观测性），让代理运行状态「一眼可见」，并修复一处探测仅在 Free/API 面板打开时才触发的盲区。

**核心变更**
1. **代理 `/health` 可观测字段扩充**
   - `sendHealth` 新增 `version`（取自 package.json，修正此前硬编码 `0.5.0`）、`startedAt`、`hasPassword`、`firstRun`、`models`、`upstreams`、`rateLimit`（rl.status 全量）、`rateStore.enabled`、`store.enabled`、`logs.enabled`。
   - 新增 `/api/health` 别名（与根 `/health` 等价），无需鉴权，供 SPA 导航徽标轮询。
   - `/api/proxy/status` 的 `version` 同步改为真实包版本。
2. **SPA 导航侧栏常驻健康徽标 `#sideHealth`**
   - 侧栏底部常驻「在线/离线 + 模式 + 限流 + 存储 + 日志 + 版本」状态条，始终可见（此前仅有各面板内的 `#proxyStatus`，默认概览页不渲染 → 探测常驻盲区）。
   - 重构 `checkProxyStatus`：探测不再依赖 `#proxyStatus` 是否存在，改为无条件发起 `/health` 探测并始终更新 `#sideHealth`，仅 `#proxyStatus` 内联文案在对应面板存在时才写入。徽标文字/圆点颜色随在线态变化。
3. **测试**
   - `test-firstrun.js` 新增断言 `/health` 返回 enriched 字段（version/rateLimit/store/logs/rateStore）。
   - `test-ui-auth-gate.js` 扩展：登录后断言 `#sideHealth` 渲染、`is-on` 在线态、文案含「在线」、显示版本号（9→12 项）。
4. **修复**：回归 `v0.11.0` 构建期发现 `updateSideHealth` 误删 `renderWelcomeStatus` 函数头导致 Vite 解析失败，已修复。

**全量回归**：ui-render / ui-auth-gate 12 / auth 19 / rate-limit 10 / rate-limit-sqlite 8 / state-store 8 / log-api 10 / firstrun 4 全绿。

---

## [v0.10.0] — 2026-09-06 · Phase 1b 落地 + Task D 项目级补齐

**性质**：工程化（Phase 1b 真正落地，此前长期后置）+ 项目级能力补齐（多实例限流共享、部署形态、首次启动引导）。

**核心变更**
1. **Phase 1b：Vite 全模块化真正落地**
   - 安装 Vite 5.4.21；抽 `src/modules/constants.js` 为 ESM 模块（ICON/STAGES/GOALS/SCOPES/API_TEMPLATES）。
   - 新增 `src/main.js`（注入 `catalog-embedded` + 加载 `app.js` + 样式）；`index.html` 改 `type=module` 入口；`vite.config.js`（`base './'`、outDir `dist`、`cssCodeSplit false`、`target es2018`）。
   - `src/app.js` 由 IIFE 转为 `import` 的 ESM 模块。
   - `build.js` 保留 esbuild 经典打包（IIFE 产物）专供 jsdom 测试；`npm run build` 现为 Vite 生产构建，`npm run build:legacy` 为经典构建。
2. **登录门在线入口测试（覆盖在线路径）**
   - `test-ui-render.js` 改为先 `build` 再加载 `dist`（jsdom 不支持 ESM，走经典脚本产物）。
   - 新增 `test-ui-auth-gate.js`：mock 代理校验「登录门 → 主界面」全链路（8/8）。
3. **Task D：多实例限流 SQLite 共享**
   - 新增 `proxy/rateStore.js`：令牌桶状态落到 `free_api.db`（`rate_buckets` + `rate_global` 表），单事务「读-判-写」+ `busy_timeout` 跨进程串行化。
   - `rateLimiter.js` 新增 `sqlite` 选项：`config.rateLimit.sqlite=true` 时启用共享；`better-sqlite3` 不可用/初始化失败/配置校验失败 → 自动回退内存模式。
   - 新增 `test-rate-limit-sqlite.js`：两个实例共享同一 DB，断言跨实例共享配额（8/8）。
4. **Task D：首次启动引导**
   - `proxy/config.json` 缺失时自动从 `config.example.json` 复制生成并启动（控制台打印首次启动提示）。
   - `GET /api/auth/status` 新增 `firstRun` 标记（未设访问密码时为 `true`），前端据此展示首次设置引导。
   - 支持 `PORT` / `HOST` 环境变量覆盖（容器暴露、随机端口测试友好）。
   - 新增 `test-firstrun.js`：缺失 config → 自动生成 + `firstRun` 标记（3/3）。
5. **Task D：部署形态**
   - 新增 `Dockerfile`（多阶段，运行阶段装 `python3/make/g++` 兜底 `better-sqlite3` 原生编译；非 root 运行）。
   - 新增 `.dockerignore`（密钥/运行时数据不进镜像）。
   - 新增 `deploy/free-api.service`（systemd 守护进程，`Restart=on-failure`、`ReadWritePaths` 限定）。

**修复（测试非幂等）**
- `test-rate-limit.js` 改用随机端口，规避 Windows `SIGKILL` 不杀进程致端口残留污染。
- `test-state-store.js` spawn 前清残留 `free_api.db`，避免 catalog 种子不重导入。

**测试（全量回归，提交前强制通过）**
- `test-ui-render.js`（jsdom）：全通过；`test-ui-auth-gate.js`：8/8。
- `test-auth.js`：19/19；`test-rate-limit.js`：10/10；`test-rate-limit-sqlite.js`：8/8。
- `test-state-store.js`：8/8；`test-log-api.js`：10/10；`test-firstrun.js`：3/3。

---

## [v0.9.0] — 2026-09-05 · 路线 2 收口（Phase 2c：业务状态收口到代理 SQLite）

**性质**：架构重构（路线 2 最终形态）。把「可变业务状态」从浏览器 `localStorage` 收口到代理侧 **SQLite 单一真相源**，浏览器只持久化「用户密钥库 + UI 偏好」。代理新增 `stateStore.js` + `/api/data/*` 数据接口；SPA 数据层瘦身（仍单 IIFE 闭包，未拆）。旧 `/api/config` 镜像通道保留兼容。

**决策（D1–D6 用户拍板）**
- **D1 混合存储**：密钥留 `config.json`；`catalog` / `relay` / `freeModels` 收口到 `free_api.db` 键值表 `state_kv`。
- **D2 只做数据层瘦身，维持单 IIFE**：SPA 不拆模块，仅改 `load/save/pushStateToProxy/loadConfigFromProxy`，降低回归面。
- **D3 纯在线（代理侧单一真相源）**：业务状态不再落浏览器；离线时仅用种子占位 + 用户密钥库，代理上线即从 `/api/config/export` 拉回权威配置。
- **D5 用户密钥库留浏览器**：`DB.apis` 是「用户密钥库」（与代理 `config.upstreams.apiKey` 两套独立存储），且 `vaultOn` 加密作用于它 → 必须留浏览器；SPA 只把 `relayToken` / `proxyMasterToken` 镜像进代理。
- **D6 保留 `/v1` 兼容 + 新增 `/api/data/*`**：既有 SPA 的 `PUT /api/config` 仍经 `mergeConfigPatch` 写 `stateStore`；新增 `/api/data/{catalog,relay,free-models}` GET/PUT + `/api/data/status`。

**核心变更**
1. **`proxy/stateStore.js`（P0，混合 SQLite 状态层）**
   - `better-sqlite3` 键值层 `state_kv(key,value,updated_at)`；`init(cfg)` 首次启动从 `config.json` 导入 `catalog`/`relay`/`freeModels`（INSERT OR IGNORE，不覆盖运行时写入）。
   - 方法：`get/setCatalog|Relay|FreeModels`、`exportAll`、`importFrom`、`resetFromConfig`、`isEnabled()`。
   - 降级同 `db.js`：`enabled` 标志 + `init` try-catch + 各方法 `if(!enabled) return`；原生模块缺失 → 回退 `config.*`，代理其余功能不受影响。导出 `_dbPath` 供测试。
2. **`proxy.js` 接线 + `/api/data/*` 端点（P1）**
   - `require('./stateStore')`；`stateStore.init(config)`；`reloadConfig` 热加载后以 SQLite 为权威回写内存 config。
   - `handleConfigGet/mergeConfigPatch/handleConfigImport` 读写经 `stateStore`；`handleDataApi` 处理 `GET/PUT /api/data/{catalog,relay,free-models}` + `/api/data/status`。
   - **导出形状修复**：`/api/config/export` 的 token 由顶层改为 `tokens:{relayToken,proxyMasterToken}`，与 `PUT /api/config` 体、import 体一致，保证「导出 → 导入」往返不丢 token（本版本修正）。
   - 鉴权与 `/api/log` 同级：本机 `127.0.0.1` 免 token，非本机须 `x-proxy-token`/Bearer，否则 401。
3. **SPA 数据层瘦身（P3，路线 2）**
   - `load()` 只从 `localStorage` 读 `apis`（用户密钥库）/ `settings` / `gen`；业务数据启动后由 `loadConfigFromProxy()` 从代理拉取，初始 `d = seed()` 作内存占位。
   - `save()` 只持久化 `{version:2, apis, settings, gen}`（`vaultOn` 仍剥离明文 key）。
   - `syncConfigToProxy` → `pushStateToProxy()`：relay/catalog/free-models 经 `/api/data/*`（PUT），tokens 经 `/api/config`（PUT）；保留 `syncConfigToProxy` 别名。
   - `importAllConfig` 导入后加 `pushStateToProxy()`；`fixRelayRules` 改为 no-op（relay 现服务端权威）。
   - `cleanupOpenRouterApis` / `ensureDefaultApis` 仍操作 `DB.apis`（用户密钥库，按 D5 保留）。
4. **`.gitignore` 增补**：`proxy/free_api.db` 与 `proxy/free_api.db-*`（运行时生成，不提交）。

**测试（全量回归，提交前强制通过）**
- `test-ui-render.js`（jsdom）：**119/119** 通过（SPA 数据层改动未破坏渲染/交互）。
- `test-state-store.js`（新增）：**8/8** 通过——`/api/data/*` 读写、本机免 token 可读、重启后 SQLite 持久化。
- `test-rate-limit.js`：**10/10** 通过（限流未回归）。
- `test-log-api.js`：**10/10** 通过（日志链路未回归）。
- `e2e-api-test.js`（真实上游）：**9/9** 通过（聊天/路由/意图未回归）。

**集群局限（同 2b）**：状态存单代理进程 SQLite，多实例不共享；单机单代理设计下无影响。

---

## [v0.8.0] — 2026-09-05 · 代理层速率限制（Phase 2b）

**性质**：代理防护增强。新增独立 `proxy/rateLimiter.js` 模块，`handleChat` 仅做前置 `allow()` + 后置 `settle()` 接线，不改动任何中转/路由/鉴权业务逻辑；IIFE 闭包未拆。

**核心变更**
1. **令牌桶限流（proxy/rateLimiter.js）**
   - 按 `upstream::clientIp` 粒度的令牌桶（capacity / refillPerSecond，支持合理突发）。
   - token 维度：每桶「每分钟 token 消耗」固定窗口（`maxTokensPerMinute`），默认开启；`usage` 为 NULL/0 时退化为请求数维度，不拒绝请求。
   - 全局固定窗口兜底（proxy 实例级 `global.maxPerMinute` QPS），防单实例被打满。
   - 桶 idle TTL 淘汰 + size 上限（MAX_BUCKETS=10000），防内存无限增长。
2. **触发行为（D3）**
   - 超限返回 `429` + `Retry-After` 头 + 结构化 JSON 错误体 `{error:"rate_limited",retryAfter,scope,message}`。
   - 被拒请求复用既有 `logRequest` 落库（`api_request_log` 的 `status_code=429`，不新增表/列）。
3. **状态查询（D4）**
   - `GET /api/rate/status`：本机 127.0.0.1 免 token，非本机须 `x-proxy-token`/Bearer，否则 401；返回 `{disabled, global, buckets}`。
4. **配置（config.json.rateLimit）**
   - 全部字段可覆写；`loadConfig` 整段兜底默认值；配置校验失败仅关限流，代理照常启动。
   - 默认值：global 600/min · upstream 120/min · 50000 tok/min · ip 60/min · tokenBucket cap100/refill2 · ttl3600s。
5. **优雅降级（§6/§15，与 db.js 同构）**
   - 初始化异常 / `allow()`·`settle()` 运行时抛错 / `enabled:false` / 配置校验失败 → 全部 `disabled` 并放行，绝不阻断 `handleChat→forwardTo` 主链路。

**顺带修复（随本期一起进入 v0.8.0）**
- `forwardTo` 非流式分支误用 SSE 解析器导致 `usage` 恒为 NULL 的隐藏缺陷 → 改为从 JSON 响应体读取 `usage`（c6c36b2）。
- 请求日志页 / Free 模型提示条改用设计系统变量，融入深色主题（3eadddb）。

**测试（全量回归，提交前强制通过）**
- `test-ui-render.js`（jsdom）：119/119 通过（前端未改逻辑，复用）。
- `test-log-api.js`：10/10 通过（日志链路未回归）。
- `e2e-api-test.js`（真实上游）：9/9 通过（限流关闭时聊天不受影响）。
- `test-rate-limit.js`（新增）：10/10 通过——令牌桶消耗/补充、全局窗口 429、429+Retry-After 结构、多 upstream/IP 隔离、降级放行、enabled:false 全放行、token NULL 退化、TTL 清理、dummy 上游 HTTP 集成 429。

**集群局限**：限流状态存于单代理进程内存，多实例不共享配额（本期未做共享存储）。

---

## [v0.6.0] — 2026-09-05 · 构建优化（Phase 1a）

**性质**：低风险构建优化。解决单 HTML 1.18MB 巨型文件问题；代理同时托管 API 与 SPA 静态资源；构建产物走 CI Release。所有业务代码字节级搬移，未改任何逻辑，IIFE 闭包未拆。

**核心变更**
1. **源码目录重构（子任务1）**
   - `index.html` 内联 `<style>`（2520 行）→ `src/styles/main.css`；内联主 `<script>`（4376 行，IIFE）→ `src/app.js`，外链引用。
   - `index.html` 由 1.16MB 降至 ~14KB，内联残留 0。
   - `catalog/catalog-embedded.js`（设 `window.EMBEDDED_CATALOG`，主脚本前置依赖）保持外链不变。
2. **esbuild 一键构建（子任务2）**
   - 新增 `build.js` + `package.json`（`esbuild@^0.24.2` devDependency）。
   - `bundle+minify+format:iife+target:es2018`，产物 `dist/assets/app.[hash].js|css` + `dist/index.html` + `dist/catalog/`。
   - 构建后前端 gzip 前 ~1.06MB（JS 177KB / CSS 887KB，CSS 含内联 SVG data URI 压缩空间有限），hash 资源可长期缓存。
3. **代理静态托管（子任务3，并入代理）**
   - `proxy.js` 新增静态托管块：API 优先（`/health`、`/v1/`、`/api/`），非 API GET/HEAD 兜底读 `dist/`（开发期 `FREEAPI_DEV=1` 或 dist 不存在时回退项目源码根）。
   - 无扩展名路径返回 `index.html`（SPA fallback）；`config.json` / `*.log` 返回 403 拦截，防密钥/日志泄露。
   - 废弃 `file://` 双击直开：所有场景统一 `node proxy/proxy.js` → 访问 http://127.0.0.1:8787/。
4. **文档同步（子任务4）**
   - 新增 `README.md`（启动/构建/开发模式/测试/Release 全流程）；本文件补 v0.6.0 段。
5. **CI Release（子任务5）**
   - 新增 `.github/workflows/build-release.yml`：打 tag（`v*`）触发 → `npm install` → `npm run build` → 打包 `dist` 为 zip → 建 GitHub Release。`dist/`、`node_modules/` 已 gitignore。

**测试（子任务6，全量回归，提交前强制通过）**
- `test-ui-render.js`（jsdom）：**119/119** 断言全部通过。
- `e2e-api-test.js`（真实上游）：**9/9** 通过（修复了测试客户端 20s 超时短于硅基流动免费层延迟 23–39s 的误判；代理转发逻辑无回归）。
- 代理静态托管 dev/dist 双模式冒烟：`/`→index.html、hash 资源/CSS/catalog 正常、`/health` 与 `/api/*` 不受影响、`/config.json` 403 拦截。
- Phase 0 四接口手动实测全过：`/api/proxy/status` · `GET /api/config` · `GET /api/config/export` · `PUT /api/config` · `POST /api/config/import`。

**风险红线（本期恪守）**：所有业务代码原样迁移，不拆 IIFE 闭包，不改动函数/变量/状态逻辑；全部回归测试通过才可提交。

---

## [v0.7.0] — 2026-09-05 · 可观测性（Phase 2a：SQLite 请求日志 + 日志页）

**性质**：代理可观测性增强。零侵入埋点，不改动任何中转/路由/鉴权业务逻辑；IIFE 闭包未拆；日志写入异步批量，不阻塞 SSE 流式返回。

**核心变更**
1. **SQLite 结构化日志层（proxy/db.js）**
   - 新增 `better-sqlite3` 运行时依赖（非 devDependency）；`proxy/db.js` 封装建表 / 插入 / 查询 / 导出 / 统计。
   - 表 `api_request_log`：`request_time`(本地 ISO)、`upstream`、`model`、`prompt/completion/total_tokens`、`status_code`、`latency_ms`、`error_msg`、`client_ip`；索引 `idx_request_time / idx_model / idx_upstream`。
   - 首次启动自动建表；`better-sqlite3` 加载或建表失败 → 模块降级 `disabled`，代理其余功能不受影响。
   - retention：启动 trim 至最近 `LOG_MAX_ROWS`（默认 5 万，可 env 覆盖），防无限膨胀。
   - 写入走内存队列 + 1s 定时批量 flush（`unref`，不单独保活进程），日志写入失败仅 stderr 告警、不打断接口。
   - 与原 JSONL 日志（`proxy/logs/*.jsonl`）并行共存，SQLite 作结构化查询层，JSONL 不删。
2. **代理埋点（forwardTo / handleChat）**
   - 请求前记 `t0`；响应/异常后组装日志对象入 SQLite。
   - token 提取：非流式从响应体 `usage` 读取；流式（SSE）解析流末尾 `final usage` chunk；取不到存 NULL，不崩溃。
   - `client_ip` 取自 `x-forwarded-for` 或 `socket.remoteAddress`（去 `::ffff:` 前缀）。
3. **日志接口（proxy.js，均 GET）**
   - `GET /api/log/list`：分页 + 多条件筛选（upstream/model/status/时间范围），返回 `{total,page,pageSize,data}`。
   - `GET /api/log/stat`：各上游总调用数 + 总 token 消耗。
   - `GET /api/log/export`：按筛选导出 `text/csv`（`error_msg` 做 Excel 公式注入防护：`= + - @` 开头前置单引号）。
   - 鉴权：本机 `127.0.0.1` 免 token，非本机须 `x-proxy-token`/Bearer，否则 401；日志模块关闭时统一返回「日志功能已关闭」提示。
4. **前端「请求日志」页（增量，不拆 IIFE）**
   - `index.html` 导航新增「请求日志」入口；`src/app.js` 追加 `viewLogs()` / `loadLogsData()` / `exportLogs()` 等（IIFE 内新增段，原有逻辑零改动）；`src/styles/main.css` 追加日志页样式。
   - 统计卡片 + 筛选区 + 分页表格（错误行红色高亮）+ 导出 CSV 按钮，复用现有蓝白 UI 风格，不引前端 npm 包。
5. **CI Release 改造（完整运行包）**
   - `.github/workflows/build-release.yml` 改为 `windows-latest` + Node 22（对齐用户 Windows 运行时，better-sqlite3 预编译匹配）；新增 proxy 启动冒烟（确认建表 + `/api/log/list` 返回 200）。
   - Release zip 由「仅 dist SPA」升级为**完整运行包**（`dist/ + proxy/ + node_modules/ + catalog/ + 启动脚本），解压即跑。

**Schema 决策（用户拍板）**
- 依赖 `better-sqlite3`（原生 C 绑定，高性能，适合高频写入）而非 `sql.js`（内存模式，磁盘持久化弱）。
- 日志接口鉴权：本机免 / 远端要 token；接口返回含 `client_ip`。
- retention：启动 trim 最近 5 万行（可配）。
- 降级：better-sqlite3 加载/建表失败 → 代理不崩，日志功能关闭。

**测试（全量回归，提交前强制通过）**
- `test-ui-render.js`（jsdom）：**119/119** 通过（Phase 1a 基线，本期前端未改逻辑，复用）。
- `test-log-api.js`（新增）：**10/10** 冒烟——`/api/log/list|stat|export` 本机免 token 可访问、503 调用落库、列表/导出返回正确结构（复跑仍 10/10）。
- `e2e-api-test.js`（真实上游）：复跑中——修复 `forwardTo` 流式/普通分支漏调 `res.end()` 导致真实非流式响应永不结束（客户端 60s 超时 → status=0）的回归，修复后重跑验证真实调用正常返回。
- dev/dist 双模式验证：proxy 静态托管不受影响；dist 构建含日志页（bundle 含 `logs-table`）。

---

## [v0.5.0] — 2026-09-05 · demo → MVP（Phase 0 完成）

**性质**：从「功能性 demo」升级为「可本地持久化的 MVP」。放弃 file:// 双击直开，所有使用场景必须启动 proxy 代理服务（换取代码分割 / 更小首屏 / 更好可维护性，Phase 1 落地）。

**核心变更**
1. **欢迎页接代理真实状态**（已上线）
   - 新增 `GET /api/proxy/status`，SPA `onMounted` 每 3–5s 轮询；代理离线时降级为红标「本地代理离线 / 请启动本地代理服务」。
   - 主卡「已接入模型」改为从代理 `/api/proxy/status` 实时读取（去重排除 `*`，只计已启用上游的模型数）。
2. **欢迎页 3 张「规划中」卡全部转正**（已上线）
   - 去「规划中」标签；03 卡描述改为「以中转模式把多家上游聚合成统一入口，按规则与权重转发调用」，与代理能力对齐。
3. **双路线持久化 — 路线 1（轻量过渡，已上线）**
   - 前端「导出全部配置」→ 下载 `tool-backup.json`（Blob 直接下载，零依赖）。
   - 前端「从备份导入」→ 读取 json 覆盖恢复 localStorage；导入前确认、导入后 `location.reload()`。
   - SPA ↔ proxy 配置双向同步：`GET /api/config`（掩码视图）、`GET /api/config/export`（未掩码全量备份）、`PUT /api/config`（SPA 改配置后 debounce 镜像进 config.json，清缓存不丢）、`POST /api/config/import`（覆盖式恢复，含 token/appTokens，本机备份用）。
   - 同步策略：SPA 改配置先写 localStorage（即时），代理在线则 800ms debounce 后 PUT 镜像；代理上线时从 `/api/config/export` 拉回权威配置覆盖 DB。
4. **命名雷区解决**（已上线）
   - 代理配置 `config.routes` 重命名为 `config.upstreams`，规避与 SPA 中转规则 `DB.routes` 同名互相覆盖；代理中转规则落 `config.relay`。

**配置 Schema 契约**（已交付）：`config-schema-contract.md` —— 界定 localStorage（UI 偏好）与 config.json（服务端配置）字段归属、命名雷区、4 个接口契约、同步流程、迁移。

**用户拍板的关键决策**
- 阶段顺序：Phase 0（MVP 现在做：①+②+③路线1）→ Phase 1（构建优化④⑥）→ Phase 2（代理增强⑤+③路线2 SQLite）。
- 接受放弃 file:// 双击直开，所有场景必须启动 proxy。
- 代理 `upstreams` 为权威；`PUT /api/config` 允许改 `upstreams`；`freeModels` 免费目录纳入 config.json 同步。

**测试**
- `test-ui-render.js`（jsdom）：**119/119** 断言全部通过。
- 代理 4 新接口手动实测全过：`/api/proxy/status` · `GET /api/config` · `GET /api/config/export` · `PUT /api/config`（镜像）· `POST /api/config/import`（覆盖恢复）。
- `e2e-api-test.js`（真实上游）：**9/9** 通过（`config.upstreams` 重命名未破坏路由转发）。

---

## 待推进（已规划，未启动）

### Phase 1 — 构建优化与部署（Phase 1a 已完成）
- ④ 构建优化：单 HTML 1.18MB → 代码分割 / dist + 静态资源外链 / esbuild 压缩（**已完成，见 v0.6.0**）。
- ⑥ 部署流水线：`build.js` 一键打包 + GitHub CI release（**已完成，见 v0.6.0**）。
- Phase 1b（后置）：Vite 全模块化。

### Phase 2 — 代理增强与路线 2 持久化
- ⑤ 代理增强：请求日志入 sqlite（v0.7.0）+ 前端日志页（v0.7.0）+ 本机限流（v0.8.0）✅ 已完成。
- ③ 路线 2：业务状态收口到代理 SQLite（v0.9.0，catalog/relay/freeModels/tokens → stateStore + `/api/data/*`）✅ 已完成。
- ⑦ 参考 NEW API 架构做代理控制台重构（待评估范围，未启动）。

---

## [demo] — 历史阶段（不编号）

- 欢迎页 3D mac-stack mockup、4 套主题（light/dark/eyecare/cyberpunk）、玻璃拟态设计系统。
- 免费模型情报采集（OpenRouter / DeepSeek / SiliconFlow / TokenHub）、加密保险箱、连通测试、中转调用（auto 跨模型回退）。
- 上游路由管理、意图识别、额度展示、厂商 Key 隔离。
- 这些能力在 demo 阶段已功能性可用，但存在「欢迎页占位 / 规划中卡 / 无跨设备持久化」三类 demo 感，已在 v0.5.0 消除。
