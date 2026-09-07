# Free API 工作台

本地 AI 免费模型 / API 聚合管理与中转调用工作台。把硅基流动、智谱、百炼、Ollama 等多家上游聚合成一个 OpenAI 兼容的统一入口，支持路由策略、意图识别、额度展示、免费模型情报采集，全部数据留在本机。

> **不再支持 `file://` 双击直开。** 所有使用场景必须启动本地代理 `proxy` 服务（换取代码分割、更小首屏、可维护性与后续 SQLite 持久化）。代理同时托管 API 与 SPA 静态资源。

---

## 架构

```
free-API/
├── index.html              # SPA 入口（Vite 模块入口；开发期也可直接读 src/）
├── src/
│   ├── main.js             # Vite 入口：注入 catalog-embedded + 加载 app.js + 样式
│   ├── app.js              # 主逻辑（ESM 模块，从 IIFE 拆分为 import）
│   ├── modules/
│   │   └── constants.js    # 抽离的常量（ICON/STAGES/GOALS/SCOPES/API_TEMPLATES）
│   ├── styles/main.css     # 样式
│   └── assets/             # 外部图片/字体占位（当前素材全内联 data URI，目录为空）
├── catalog/
│   └── catalog-embedded.js # 免费模型目录（自动生成，设 window.EMBEDDED_CATALOG，主脚本前置依赖）
├── proxy/
│   ├── proxy.js            # 零依赖本地代理：API 中转 + SPA 静态托管（端口 8787）+ 账号体系 + 首次启动引导
│   ├── db.js               # SQLite 结构化日志层（better-sqlite3，缺失时自动降级）
│   ├── stateStore.js       # SQLite 业务状态层（catalog/relay/freeModels 键值，缺失时回退 config.*）
│   ├── rateLimiter.js      # 速率限制（令牌桶 + token 维度窗口 + 全局兜底，缺失时自动放行）
│   ├── rateStore.js        # 限流桶 SQLite 持久化（多实例共享，rateLimit.sqlite=true 时启用）
│   ├── logs.db             # 运行时生成的请求日志库（gitignore，不提交；WAL 附属文件 logs.db-*）
│   ├── free_api.db         # 运行时生成的业务状态库（gitignore，不提交；WAL 附属文件 free_api.db-*）
│   └── config.json         # 运行期配置（含密钥，已 gitignore，勿提交）
├── vite.config.js          # Vite 生产构建配置（base './'、outDir dist、cssCodeSplit false）
├── build.js                # 经典（esbuild IIFE）构建：供 jsdom 测试用；生成 dist/ 带 hash 产物
├── Dockerfile              # 容器化部署（多阶段，含 better-sqlite3 原生编译兜底）
├── .dockerignore          # 容器构建排除项（密钥/运行时数据不进镜像）
├── deploy/
│   └── free-api.service    # systemd 单元（生产守护进程）
├── package.json
└── dist/                   # 构建产物（gitignore，走 CI Release；不进 git）
```

---

## 快速开始

### 1. 安装依赖并构建

```bash
npm install        # 安装 esbuild（开发期）+ better-sqlite3（运行时依赖，日志功能需要）
npm run build      # 生成 dist/（压缩混淆 + hash 资源 + SPA index.html）
```

> 不构建也能用：`index.html` 通过外链 `src/` 在开发模式直接打开；但**生产/日常推荐走 dist + 代理**。

### 2. 配置代理密钥

```bash
cp proxy/config.example.json proxy/config.json   # 若不存在
# 编辑 proxy/config.json，填入你的上游 API Key
```

### 3. 启动代理（同时托管 API + SPA）

```bash
node proxy/proxy.js
```

启动后访问：

- **工作台 SPA**：http://127.0.0.1:8787/
- **聊天接口**：http://127.0.0.1:8787/v1/chat/completions
- **健康检查**：http://127.0.0.1:8787/health

代理默认监听 `127.0.0.1:8787`，仅本机可访问。密钥只在本机 `config.json`，绝不下发前端。

> **请求日志**：代理每次中转调用都会写入 `proxy/logs.db`（SQLite 结构化层），工作台「请求日志」页可查看 / 筛选 / 导出。若 `better-sqlite3` 不可用，代理自动降级——日志关闭、其余正常。

### 4. 开发模式（不构建，直接读源码根）

```bash
FREEAPI_DEV=1 node proxy/proxy.js
```

`FREEAPI_DEV=1` 或 `dist/` 尚未构建时，代理回退读项目源码根（`index.html` + `src/`），便于改完即看。

---

## 请求日志（Phase 2a）

代理每次中转调用都会写入 SQLite（`proxy/logs.db`，结构化查询层；原 JSONL 日志 `proxy/logs/*.jsonl` 继续保留）。工作台新增「请求日志」导航页：

- 顶部统计卡片：总调用数、总 Token 消耗、各上游分布
- 筛选：上游 / 模型 / 状态码 / 时间范围
- 表格分页，错误行红色高亮；来源 IP 可见（接口含 `client_ip`）
- 一键导出 CSV（含 Excel 公式注入防护）

接口（均 GET，本机 127.0.0.1 免 token，非本机须 `x-proxy-token`/Bearer，否则 401）：
- `GET /api/log/list?page=&pageSize=&upstream=&model=&status=&startTime=&endTime=`
- `GET /api/log/stat`
- `GET /api/log/export`（text/csv 附件）

> 若 `better-sqlite3` 不可用，代理自动降级：日志功能关闭、`/api/log/*` 返回友好提示，转发与聊天不受影响。

---

## 速率限制（Phase 2b）

代理内置速率限制，防止单实例被上游/客户端打满。算法与维度（D1/D2 拍板）：

- **令牌桶**（按 `upstream::clientIp` 粒度，支持合理突发）：`tokenBucket.capacity` / `refillPerSecond` 控制请求速率。
- **token 维度**（每桶「每分钟 token 消耗」固定窗口，`maxTokensPerMinute`）：默认开启；`usage` 为 NULL/0 时退化为请求数维度，不拒绝请求（D5）。
- **全局固定窗口兜底**（proxy 实例级 `global.maxPerMinute` QPS）：防单实例被打满。

行为（D3）：超限返回 `429 Too Many Requests` + `Retry-After` 头 + 结构化 JSON 错误体 `{error:"rate_limited",retryAfter,scope,message}`；被拒请求**复用既有 SQLite 日志**（`status_code=429`，便于排查）。

状态查询（D4）：`GET /api/rate/status`（本机免 token，非本机须 proxy token，否则 401）返回 `{disabled, global:{count,maxPerMinute,windowRemainSec}, buckets:[...]}`。

配置（`proxy/config.json` 的 `rateLimit` 段，全部字段可覆写；不配则用默认值且安全启动）：

```json
{
  "rateLimit": {
    "enabled": true,
    "sqlite": false,
    "global": { "maxPerMinute": 600 },
    "perUpstream": { "enabled": true, "maxPerMinute": 120, "maxTokensPerMinute": 50000 },
    "perClientIp": { "enabled": true, "maxPerMinute": 60 },
    "tokenBucket": { "capacity": 100, "refillPerSecond": 2 },
    "bucketIdleTtlSec": 3600
  }
}
```

`sqlite`（Task D，默认 `false`）：设为 `true` 时，令牌桶状态落到 `proxy/free_api.db`（与业务状态同库，WAL 模式）。**多个代理实例只要挂载同一份 `free_api.db`（同宿主共享文件系统 / 同一容器卷），即可共享同一套限流计数**，避免「每实例各自计数」导致全局限速被横向放大。`rateStore.js` 用单事务「读-判-写」+ `busy_timeout` 跨进程串行化；`better-sqlite3` 不可用或初始化失败时自动回退内存模式（速率限制是旁路装饰，不阻断主链路）。

优雅降级（§6/§15，与 db.js 同构）：`rateLimiter.js` 初始化异常 / `allow()`·`settle()` 运行时抛错 / `enabled:false` / 配置校验失败 → 全部置 `disabled` 并直接放行，`handleChat→forwardTo` 主链路绝不中断。限流是「旁路装饰」，不是硬依赖。

> **多实例共享前提**：`sqlite:true` 仅在同一份 `free_api.db` 可被多实例访问时有效（共享文件系统 / 容器卷）。跨主机（独立磁盘）仍需外接 Redis 等共享存储——本期 SQLite 方案覆盖「同宿主多进程」，不覆盖「跨主机分布式」。

---

## 状态存储（Phase 2c · 路线 2 收口）

Phase 2c 把「可变业务状态」从浏览器 `localStorage` 收口到代理侧 **SQLite 单一真相源**，浏览器只持久化「用户密钥库 + UI 偏好」。

- **新增 `proxy/stateStore.js`**：`better-sqlite3` 键值层（`state_kv(key,value,updated_at)`）。`init(cfg)` 首次启动从 `config.json` 导入 `catalog` / `relay` / `freeModels`（INSERT OR IGNORE，不覆盖运行时写入）；对外暴露 `get/setCatalog|Relay|FreeModels`、`exportAll`、`importFrom`、`resetFromConfig`。
- **降级与 db.js 同构**：`better-sqlite3` 不可用 → 模块 `enabled=false`，读写回退 `config.*`，代理其余功能不受影响。
- **SPA 数据层瘦身（路线 2）**：`src/app.js` 的 `load()` 只从 `localStorage` 读 `apis`（用户密钥库，仍留浏览器，因 vaultOn 浏览器加密）/ `settings` / `gen`；`catalog` / `relay` / `freeModels` / `relayToken` / `proxyMasterToken` 等启动后由 `loadConfigFromProxy()` 从代理拉取；`save()` 只持久化 `{version:2, apis, settings, gen}`，业务状态经 `pushStateToProxy()`（relay/catalog/free-models → `PUT /api/data/*`，tokens → `PUT /api/config`）镜像进代理 SQLite。
- **新增数据接口（与 `/api/config` 并存）**：
  - `GET /api/data/status` → `{enabled, keys:["catalog","relay","free-models"]}`
  - `GET /api/data/{catalog,relay,free-models}`
  - `PUT /api/data/{catalog,relay,free-models}`（body 为该类别完整对象/数组）
  - 鉴权与 `/api/log` 同级：本机 `127.0.0.1` 免 token，非本机须 `x-proxy-token`/Bearer，否则 401。
- **向后兼容**：既有 SPA 的 `PUT /api/config`（经 `mergeConfigPatch` 写 `stateStore`）仍可用；`/api/config/export` 返回 `tokens:{relayToken,proxyMasterToken}`（与 `PUT /api/config` 体、`import` 体一致），保证「导出 → 导入」往返不丢 token。

> `proxy/free_api.db`（及 `free_api.db-*` WAL 附属）为运行时生成，已 gitignore，不提交；可手动删除，代理启动自动重建。环境变量 `FREE_API_STATE_DB` 可覆盖该路径（测试隔离常用）。

---

## 首次启动引导（Task D）

代理默认监听 `127.0.0.1:8787`，密钥仅在本机 `config.json`。

- **零配置启动**：若 `proxy/config.json` 不存在，代理会**自动从 `proxy/config.example.json` 复制生成默认配置**并正常启动（控制台打印首次启动提示），无需手动 `cp`。生成的默认配置含示例上游占位 Key，实际调用前请在 `proxy/config.json` 填入你的真实 Key。
- **访问密码**：默认 `accessPassword` 为空（本地体验模式，放行）。首次打开工作台会提示设置「访问密码」；设置后所有管理/聊天接口需登录会话。`GET /api/auth/status` 在未设密码时返回 `firstRun:true`，前端据此展示首次设置引导。
- **端口 / 监听地址覆盖**：可用环境变量 `PORT`、`HOST` 覆盖 `config.json` 中的值（容器暴露、随机端口测试常用）。例如 `PORT=9000 node proxy/proxy.js` 监听 `127.0.0.1:9000`；容器对外暴露需把 `config.json` 的 `host` 改为 `0.0.0.0` 或 `HOST=0.0.0.0`。

> **⚠️ 不要直接双击 `index.html` 打开**：Vite 模块化后，`index.html` 通过 `type="module"` 加载脚本；在 `file://` 协议下浏览器会拦截 ESM，导致 CSS/JS 全不加载、界面"毁坏"、按钮无反应。**必须启动代理后通过 `http://127.0.0.1:8787/` 访问**。若误用 `file://` 打开，页面会自动显示友好引导卡片并提示启动方式。

---

## 可观测性（v0.11.0）

- **健康检查端点**：`GET /health`（与 `GET /api/health` 等价，无需鉴权）返回代理运行态快照：
  `{ ok, version, uptimeSec, startedAt, hasPassword, firstRun, models, upstreams, rateLimit, rateStore, store, logs, stats, routes, cacheSize }`。
  `version` 取自 `package.json`（真实发布版本，不再硬编码）。可用于监控探活、容器 `healthcheck`、外部仪表盘轮询。
- **SPA 常驻状态条**：主界面左侧栏底部「健康徽标」每 5s 轮询 `/health`，实时展示「在线/离线 + 路由模式 + 限流开/关(+SQLite共享) + 状态库✓/✗ + 日志✓/✗ + 版本号」。该徽标由登录后统一探测驱动，**默认概览页也始终可见**（v0.11.0 前仅在 Free/API 面板打开时才刷新，概览页为探测盲区）。

```bash
# 快速查看代理健康
curl -s http://127.0.0.1:8787/health | head -c 400
```

---

## 部署（Task D · Docker / systemd）

### Docker

```bash
# 构建镜像
docker build -t free-api-workbench .

# 运行（挂载你自己的 config.json；缺省时容器会按首次启动引导从 example 生成）
docker run -d --name free-api -p 8787:8787 \
  -e HOST=0.0.0.0 \
  -v /path/to/your/config.json:/app/proxy/config.json \
  free-api-workbench
```

- 密钥仅在本机 `config.json`，绝不进镜像（`.dockerignore` 已排除 `proxy/config.json`）。
- `better-sqlite3` 为原生模块：运行阶段装 `python3/make/g++` 兜底源码编译，确保预编译缺失也能用。
- 健康探活：`Dockerfile` 已内置 `HEALTHCHECK`（直连容器 `http://127.0.0.1:8787/health`），`docker ps` 的 STATUS 列会显示 `healthy/unhealthy`；编排器据此自动回收/告警。
- 多实例共享限流：将多个容器的 `/app/proxy/free_api.db` 挂到同一卷，并在各 `config.json` 设 `rateLimit.sqlite:true`。

### systemd（Linux 生产守护）

`deploy/free-api.service` 已就绪：

```bash
sudo useradd -m -s /usr/sbin/nologin freeapi
sudo cp deploy/free-api.service /etc/systemd/system/
sudo sed -i 's#/opt/free-api#你的部署目录#' /etc/systemd/system/free-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now free-api
```

`Restart=on-failure` 自动拉起；`ReadWritePaths` 限定代理仅可写自身目录。

---

## 构建脚本 `build.js`

- esbuild 压缩混淆 `src/app.js` → `dist/assets/app.[hash].js`
- 压缩 `src/styles/main.css` → `dist/assets/app.[hash].css`
- 拷贝 `catalog/catalog-embedded.js` → `dist/catalog/`（主脚本前置依赖）
- 生成 `dist/index.html`（外链替换为带 hash 的构建产物）

**设计红线**：只做剪切搬运与压缩，不修改任何业务逻辑；IIFE 闭包不拆；`dist` 为产物不进 git。

---

## 测试

```bash
# 前端渲染（jsdom，需 jsdom）
NODE_PATH=<jsdom 所在 node_modules> node test-ui-render.js
# 登录门 → 主界面全链路（jsdom，mock 代理）
NODE_PATH=<jsdom 所在 node_modules> node test-ui-auth-gate.js

# 账号体系（自起代理 → 登录/改密/会话）：19 项
node test-auth.js
# 速率限制单元（内存模式 9 项 + dummy 上游 HTTP 集成 1 项）：10 项
node test-rate-limit.js
# 多实例限流 SQLite 共享（两个实例共享同一 DB，断言跨实例共享配额）：8 项
node test-rate-limit-sqlite.js
# 首次启动引导（缺失 config.json → 自动生成 + firstRun 标记）：3 项
node test-firstrun.js
# 状态存储（catalog/relay/freeModels SQLite 持久化）：8 项
node test-state-store.js
# 请求日志接口：10 项
node test-log-api.js

# 真实上游端到端（自起代理 → 轮询 /health → 真实调用 → 杀代理）：9 项
node e2e-api-test.js
```

`e2e-api-test.js` 仅调用明确免费的模型，密钥运行时从 `config.json` 读取，绝不写死。免费层延迟波动较大（硅基流动可达 30s+），测试客户端超时已设为 60s 以容纳。

> 速率限制测试用随机端口规避 Windows 进程残留污染；状态存储测试在 spawn 前清理残留 `free_api.db`，保证幂等。

---

## 部署 / Release

打 tag 时 GitHub Actions 自动构建并发布 **完整运行包**（含 SPA 构建产物 + proxy 运行时 + 原生依赖）：

Release zip 内容：
```
free-api-workbench-vX.Y.Z/
├── dist/                # SPA 构建产物（前端静态资源）
├── proxy/               # 代理（proxy.js + db.js）
├── node_modules/        # 运行时依赖（含 better-sqlite3 原生模块，按 CI 构建机 OS/Node 预编译）
├── catalog/             # 模型目录（catalog-embedded.js）
├── package.json
├── start.bat / start.sh # 一键启动脚本
└── README 片段
```

使用方式：解压后直接 `node proxy/proxy.js`（Windows 双击 `start.bat`），访问 http://127.0.0.1:8787/。

> **原生模块注意（ABI 127 / Node 22）**：`better-sqlite3` 为 C 原生绑定，Release 包内预编译二进制仅匹配「构建机 Windows + Node 22（ABI 127）」。若你本机 Node 大版本与 Release 不一致（如升级到 Node 24、降级到 Node 20），预编译 `.node` 无法加载，代理解释为不可用并**自动降级**（日志关闭、转发/聊天正常），此时在解压目录重跑 `npm install` 即可为本机重新编译。CI 在该环境成功编译运行 = 冒烟校验「此依赖可在 Node 22 编译运行」，Release 包即含该预编译二进制，属「完整运行包（解压即跑）」而非纯源码分发。

本地发布流程：
1. `npm install && npm run build` 验证
2. `git tag vX.Y.Z && git push --tags`
3. CI 自动构建并发布完整运行包

详见 `.github/workflows/build-release.yml`。

---

## 已知限制与运维提示

- **原生模块 ABI 绑定（Node 22 / ABI 127）**：见上方「部署 / Release → 原生模块注意」。切换 Node 大版本后预编译 `.node` 不兼容 → 代理自动降级 → 解压目录重跑 `npm install` 重新编译。
- **降级逻辑 CI 仅覆盖成功分支**：CI 冒烟只验证了「better-sqlite3 可用、建表成功、`/api/log/list` 返回 `disabled=false`」这一条路径。代理加载失败 / 建表异常的降级分支（`require` 抛错、接口返回「日志功能已关闭」、其余 API 不受影响）CI 无法模拟「原生模块加载失败」场景，需本地手动构造坏环境验证：临时把 `node_modules/better-sqlite3` 改名（或删 `prebuilds/` 且阻断网络让其编译失败），确认代理仍正常启动、`/api/log/list` 返回 `disabled:true`、转发与聊天不受影响。
- **批量异步刷盘与 SIGTERM 数据丢失（设计取舍）**：`proxy/db.js` 用内存队列 + 1s 定时批量 `flush` 写入，不阻塞 SSE 流式返回。若进程被 `SIGTERM`/`SIGKILL` 暴力杀死，内存中尚未落盘的日志条目会丢失。这是为吞吐与流式体验做的取舍，非缺陷；正常 `Ctrl+C` 退出时队列仍会尽量 flush（仍有极短窗口）。
- **`logs.db` 可手动删除**：开发期频繁重启代理会反复生成 `logs.db` 及 WAL 附属 `logs.db-wal` / `logs.db-shm`。可直接删除该文件，代理启动时自动重建表，不会抛异常。
- **retention**：代理启动 trim 至最近 `LOG_MAX_ROWS`（默认 5 万）行，可用环境变量 `LOG_MAX_ROWS` 覆盖。

---

## 版本路线

- **v0.5.0（Phase 0）**：demo → MVP，欢迎页接代理真实状态、双路线持久化（路线1）、命名雷区解决。
- **v0.6.0（Phase 1a）**：esbuild 工程抽离压缩 + 代理静态托管 + CI 构建 Release 包。
- **v0.7.0（Phase 2a）**：SQLite 请求日志（proxy/db.js）+ 前端「请求日志」页（列表/筛选/统计/导出 CSV）+ 日志接口鉴权 + retention + 降级。
- **v0.8.0（Phase 2b）**：代理层速率限制（proxy/rateLimiter.js，令牌桶 + token 维度窗口 + 全局兜底 + 429 + 状态查询 + 优雅降级）。
- **v0.9.0（Phase 2c）**：路线 2 收口——业务状态（catalog/relay/freeModels/tokens）收口到代理 SQLite（proxy/stateStore.js + `/api/data/*`），SPA 数据层瘦身（仅留用户密钥库 + UI 偏好）。
- **v0.10.0（Phase 1b + Task D）**：Vite 全模块化真正落地（ESM + src/modules/constants.js + vite.config.js，build.js 保留经典构建供测试）；登录门在线入口测试（jsdom）；多实例限流 SQLite 共享（proxy/rateStore.js + rateLimit.sqlite）；首次启动引导（缺失 config 自动生成 + firstRun 标记 + PORT/HOST 环境变量）；Dockerfile / .dockerignore / systemd 单元。
- **v0.11.0（可观测性）**：`/health`（+ `/api/health` 别名）扩充 version/startedAt/hasPassword/firstRun/rateLimit/rateStore/store/logs 字段；SPA 侧栏常驻健康徽标（每 5s 轮询，默认概览页也可见，修复探测盲区）；`version` 改为真实包版本。

详见 `CHANGELOG.md` 与 `config-schema-contract.md`。
