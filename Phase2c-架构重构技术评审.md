# Phase 2c 架构重构技术评审（路线2：SPA 全走代理 API，浏览器仅存 UI 偏好）

> 状态：方案评审稿（report-first）。**未批准前不写实现代码**，先就决策项 D1–D6 拍板。
> 关联：Phase 2a（SQLite 日志，已发 v0.7.0）、Phase 2b（令牌桶限流，已发 v0.8.0）。
> 当前版本基线：v0.8.0（commit 2c28d61）。

---

## 0. 目标（路线2 原文）

> 「升级 SQLite 让 SPA 读写全走代理 API，浏览器仅存 UI 偏好。」

一句话：把"可变业务状态"的单一真相源收到代理侧（SQLite），SPA 退化为"渲染 + 发指令"的瘦客户端；浏览器 localStorage 只保留 UI 偏好（主题、密度、布局等），不再持有 apis/routes/models/catalog/tokens。

---

## 1. 当前架构真实状态（实测，非推测）

### 1.1 前端
- `src/` 仅 2 文件：`app.js`（单 IIFE，约 4500+ 行）、`main.css`。
- `build.js`：esbuild 把 `app.js` 打包成 **单个 iife**（`format:'iife', minify:true`）→ `dist/assets/app.[hash].js`。**Phase 1b（Vite 全模块化）此前已明确后置，本评审默认不自动包含，见 D2。**
- **localStorage schema（`version:2`，key 固定）**：
  ```
  { models, apis, routes,
    catalogUser, catalogEnabled, catalogVendorKey,
    relayToken, proxyMasterToken,
    settings:{ theme,density,brightness,fontScale,fontFamily,startup,intent,vaultOn,showMasked,confirmDelete,... },
    gen:{ stage,scene,goal,custom,collapsed } }
  ```
- **双写/双源模型**：
  - `load()`（app.js:165）：先读 localStorage；有且合法 → 用本地；否则 `seed()`。
  - `save()`（app.js:196）：写 localStorage；若 `vaultOn` 则剥离明文 key；随后 `scheduleCfgSync()` → `syncConfigToProxy()`（app.js:216）debounce 800ms **PUT `/api/config`** 把 patch（relay/catalog/freeModels/tokens）镜像给代理。
  - `loadConfigFromProxy()`（app.js:231）：代理在线时 **GET `/api/config/export`** 回写覆盖 `DB.*` 然后 `save()`。
  - ⇒ 加载时**代理覆盖本地**，但两次同步之间本地仍是业务真相源；**离线时本地为唯一源** → 双源并存、存在漂移窗口。
- **SPA 内业务逻辑**（应服务端化）：`seed()`、`ensureDefaultApis()`、`fixRelayRules()`、`cleanupOpenRouterApis()` 直接 mutate `DB`。
- **`settings` / `gen` 是纯 UI 状态**，正是路线2 允许留在浏览器的部分。

### 1.2 代理
- `config.json`（文件，**含明文密钥，gitignore**）为权威：upstreams / relay / catalog / appTokens / token。
- SQLite `logs.db`（db.js，`enabled` 降级范式）**仅用于请求日志**，不承载业务状态。
- `/v1/*` 管理端点（routes/tokens/logs/classifier/quota/enabled/catalog/admin/token/auto…）读写内存 `config` 并 `saveConfig()` 落盘 `config.json`。
- `/api/*`：config 镜像（GET/PUT/import/export）、log 查询、rate/status。

### 1.3 结论
两套数据源（浏览器 localStorage vs 代理 config.json）并存，加载时单向覆盖、运行期双向漂移、离线不一致。Phase 2c 把可变状态**收口到代理 SQLite 单一真相源**，SPA 不再本地持有业务数据。

---

## 2. 目标架构（路线2）

```
浏览器(localStorage)          代理(单一真相源)              上游模型
┌─────────────────┐          ┌──────────────────────┐      ┌────────────┐
│ UI 偏好(settings)│  只读/写  │ SQLite:               │ 转发  │ DeepSeek   │
│ theme/density/  │ ←──────→ │  apis, routes,        │←────→│ 硅基流动    │
│ layout/gen      │  GET/POST│  models, catalog,     │      │ 智谱/百炼… │
│ (唯一留存)      │  /v1/*   │  tokens, appTokens    │      └────────────┘
└─────────────────┘          │  (密钥按 D1 策略落地) │
                             │ + logs.db(日志,已有)  │
                             │ + rateLimiter(已有)   │
                             └──────────────────────┘
```

- SPA 加载即 `GET /v1/*`（或新 `/api/data/*`）拉取业务状态渲染；变更走 `POST/PUT /v1/*`。
- 浏览器 localStorage **仅 `settings`/`gen`**（UI 偏好）。
- 代理以 SQLite 为可变状态真相源；密钥落地策略见 D1。

---

## 3. 决策项（待拍板）

### D1 · 代理状态存储形态
- **A（推荐）混合**：密钥仍留 `config.json`（gitignore，不动既有安全模型）；`apis/routes/models/catalog/tokens/appTokens` 等可变状态迁入 SQLite（`free_api.db`）。兼容 `config.json` 启动（首次导入）。
- B 全 SQLite：连密钥也进 SQLite（仍 gitignore）。改动大、密钥管理需重审。
- C 维持 `config.json`：只把"运行时可变状态"在内存+SQLite 做缓存，真相源还是文件。漂移风险未根除，不推荐。

### D2 · 是否顺带 Phase 1b 模块化
- **A（推荐本次只做数据层瘦身）**：SPA 抽薄 `api-client` + `store` 两层、去掉 `DB` 业务字段，但**维持单 IIFE 打包**（不动 build 管线），把风险压到最小、与 Phase 1b 解耦。
- B 一并拆模块（Vite/ESM）：架构更干净，但工作量与回归面翻倍，且与已后置的 Phase 1b 重叠——建议单独排期，不塞进 2c。

### D3 · 离线行为（路线2 的代价）
- **A（推荐）接受纯在线**：瘦客户端，代理不可达则功能不可用，但 UI 偏好仍在、可看静态页。最简、零漂移。
- B 只读 localStorage 缓存兜底：SPA 仍留一份业务数据只读副本供离线查看 → **重新引入漂移风险**，与路线2 精神冲突，不推荐。
- C Service Worker 离线壳：体验最好但工作量最大，超出 2c 范围。

### D4 · 迁移策略（localStorage v2 + config.json → SQLite）
- 首启迁移：代理启动/ SPA 首载时，把 `config.json` + 浏览器 localStorage v2 **合并**写入 SQLite。
- 冲突解决：**代理 config.json 优先**（它经 `loadConfigFromProxy` 已被定义为权威），localStorage 仅作补充；迁移后清空 localStorage 业务字段。
- 保留 `tool-backup.json` 导入导出作为逃生舱（落到 SQLite）。

### D5 · vaultOn 加密密钥
- **A（推荐）维持浏览器加密、服务端只存密文**：`keyEnc` 密文随业务状态进 SQLite，解密仍在浏览器（密钥短语不离开客户端）。服务端不接触明文，安全模型不变。
- B 服务端 vault：代理托管加密，需新增密钥管理面，风险高，不推荐。

### D6 · 端点前缀收敛
- **A（推荐）保留兼容、内部收敛**：`/v1/chat/completions`、`/v1/auto/chat/completions` 维持（外部客户端依赖）；新增/改造的管理读写统一到 `/api/data/*`（GET 列表 / PUT 单条 / POST 动作）。旧的 `/v1/routes`、`/v1/tokens` 等标记 deprecated 但暂保留一个发版周期。
- B 立即全量重命名：clean 但破坏既有外部集成，不推荐。

---

## 4. 分阶段实施计划（骨架，拍板后细化）

- **P0 代理数据层**：引入 `free_api.db`（better-sqlite3，复用 db.js 降级范式）；加 `stateStore` 适配层，启动从 `config.json` 导入、运行时读写 SQLite；保留 `saveConfig()` 兼容导出。
- **P1 管理 API**：`/api/data/*` 读写端点（`apis/routes/models/catalog/tokens/appTokens`），鉴权与既有 `/api/log` 同级。
- **P2 迁移**：首启合并迁移（D4）；`tool-backup.json` 逃生舱接 SQLite。
- **P3 SPA 瘦身**：抽 `api-client`/`store`；删除 `DB` 业务字段与 `seed/ensureDefaultApis/fixRelayRules` 本地逻辑（改走 API）；`settings/gen` 留本地；`syncConfigToProxy` 改为走 `/api/data/*`。
- **P4 回归**：新增 `test-data-api.js`（内存 SQLite 全场景）、迁移回归、`e2e-api-test` 扩用例；既有 `test-ui-render 119/119`、`test-rate-limit 10/10`、`test-log-api 10/10` 不回退。
- **P5 发版**：打 `v0.9.0` tag → CI 重发完整运行包（含 free_api.db 初始化）。

---

## 5. 风险与回归红线

- **数据丢失风险（最高）**：迁移写错会丢配置。护栏：迁移前自动 `tool-backup.json` 导出 + 保留 `config.json` 原件；迁移幂等、可重跑。
- **密钥泄露**：SQLite 文件同 `logs.db` 一样必须 gitignore；CI 产物不含任何密钥文件（沿用 v0.8.0 的 gitignore + 构建排除）。
- **外部集成破坏**：`/v1/chat/completions` 等端点必须保留（D6-A）。
- **回归红线**：四项既有测试不回退；新增 `test-data-api` 全过；e2e 9/9 不破。
- **降级一致性**：stateStore 异常即降级（参考 db.js `enabled` 范式），绝不阻断代理启动与聊天主链路。

---

## 6. 范围护栏（本次不做）

- 不含 Phase 1b 全模块化（除非 D2 选 B）。
- 不含新功能（仍是"收口既有能力"，不扩产品线）。
- 不含多用户/账号体系（仍是单机本地代理语义）。
- 不含 Service Worker 离线壳（D3 默认 A）。

---

## 7. 待用户拍板后产出

- 决策项 D1–D6 结论 → 锁定 P0–P5 详细设计 → 按"打快照 → 增量 → 门禁回归 → 发版"节奏推进（同 2a/2b）。

## 8. 决策已拍板（2026-09-06）

- **D1 混合存储（采纳推荐）**：密钥（master token / upstreams.apiKey / appTokens.key）仍留 `config.json`（gitignore，不动既有安全模型）；`catalog(user/enabled/vendorKey)`、`relay`(routes)、`freeModels`(models)、`appTokens` 元数据(非密钥字段) 迁入 SQLite `free_api.db`。代理启动从 `config.json` 的对应段导入 SQLite（若空）。
- **D2 只做数据层瘦身（采纳推荐）**：SPA 抽薄 `api-client` + `store` 两层、删 `DB` 业务字段与 `seed/ensureDefaultApis/fixRelayRules` 本地逻辑，但**维持单 IIFE 打包**，不动 `build.js` 管线。
- **D3 纯在线（采纳推荐）**：瘦客户端，代理不可达即功能不可用；UI 偏好(settings/gen)仍留 localStorage；不做离线缓存壳（避免重新引入漂移）。
- **D6 兼容收敛（采纳推荐）**：保留 `/v1/chat/completions`、`/v1/auto/chat/completions`、`/v1/routes`、`/v1/tokens` 等外部依赖端点；新增/改造管理读写统一到 `/api/data/*`（GET 列表 / PUT 单条 / POST 动作）。旧 `/v1/*` 管理端点标记 deprecated，保留一个发版周期。
- **D4（采纳推荐默认）**：迁移冲突以**代理 config.json 优先**（它经 `loadConfigFromProxy` 已被定义为权威）；localStorage 仅作补充；迁移后清空 localStorage 业务字段。保留 `tool-backup.json` 逃生舱。
- **D5（采纳推荐默认）**：`vaultOn` 维持浏览器加密、服务端只存 `keyEnc` 密文；解密在浏览器，服务端不接触明文。

→ 进入实现层（P0–P5）。基线 tag：`phase2c-snapshot`。目标版本：`v0.9.0`。
