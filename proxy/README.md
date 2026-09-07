# free-API 本地代理（proxy）

把多个上游 API 聚合成一个 **OpenAI 兼容** 的统一入口。零依赖、不依赖 Docker，只用一个 Node 进程。

参考 `ai-gateway` 的 Governor 路由思想做了本地化精简：权重路由 + 熔断 + failover + 可选精确缓存。

## 为什么需要它

- 前端 `file://` 页面直接调各家 API 会遇到 **CORS** 跨域限制；本地代理在 `127.0.0.1` 上统一收口，并开启 CORS，前端改一个 Base URL 就能走代理。
- 把各家 Key 集中放在本机 `config.json`，**不进浏览器 / 不进前端代码**。
- 多个上游按权重/优先级自动分配、失败自动切换，等于一个轻量「中转站」网关。

## 运行

```bash
cd proxy
cp config.example.json config.json      # 第一次：复制模板
# 编辑 config.json，填入你的 apiKey
node proxy.js                           # 读取同目录 config.json
# 或指定配置文件： node proxy.js /path/your.json
```

要求 Node ≥ 18（用到内置 `fetch` 与 `crypto`；本机为 Node 22）。

启动后：

- 健康检查：`http://127.0.0.1:8787/health`
- 聊天接口：`http://127.0.0.1:8787/v1/chat/completions`
- 模型列表：`http://127.0.0.1:8787/v1/models`

> 想常开：双击目录里的 `start-proxy.bat` 即可一键启动（自动找 node，找不到时回退到本机托管 node 路径）。要登录即后台自启，运行 `install-autostart.bat`（详见下方「开机自启动与桌面启动」）。

## 配置字段

| 字段 | 说明 |
|------|------|
| `port` | 监听端口，默认 `8787` |
| `host` | 监听地址，默认 `127.0.0.1`（仅本机）。如需局域网共享改 `0.0.0.0`（注意安全） |
| `mode` | 路由模式：`balanced`(加权轮询) / `economy`(最省，按 cost 升序) / `strict`(按 priority 升序做 failover 链) |
| `token` | 代理访问令牌（**主控 Key**），留空则不鉴权（本机用足够）。设置后客户端需带 `x-proxy-token` 或 `Authorization: Bearer <token>` |
| `appTokens` | 应用 Key 数组（每个外部 AI 应用一个）：`{ id, name, key, createdAt, lastUsed, enabled }`。任一启用的 `key` 都可用于 `chat/auto` 调用，与管理端点分离 |
| `classifier` | 意图识别用的「分类器」模型 id（免费小模型即可）。留空则意图识别退化为「按难度评分兜底选模型」。设置后 `/v1/auto/chat/completions` 会先调它分类再选模型 |
| `passthroughAuth` | `true` 时把客户端 `Authorization` 透传给上游（代理本身不配 key 的场景），默认 `false` |
| `routes[]` | 上游列表，每条： |
| `routes[].name` | 上游名称（用于健康统计，唯一） |
| `routes[].baseUrl` | 上游 OpenAI 兼容 base，如 `https://api.siliconflow.cn/v1` |
| `routes[].apiKey` | 上游密钥，只存本机 |
| `routes[].models` | 该上游能服务的模型 id；写 `["*"]` 表示兜底承接所有模型 |
| `routes[].weight` | `balanced` 模式下的权重（越大分得越多） |
| `routes[].priority` | `strict`/`economy` 排序用，越小越优先 |
| `routes[].cost` | `economy` 模式排序用，越小越优先 |
| `routes[].enabled` | 是否启用 |

修改 `config.json` 后向进程发 `SIGHUP`（或文件被监听变化）即**热加载**，无需重启。

## 路由模式怎么选

- **balanced（默认）**：多个上游按 `weight` 加权轮询，适合做负载/配额分摊。
- **economy**：按 `cost` 升序优先用便宜的，适合控成本。
- **strict**：按 `priority` 升序排成 failover 链，主线路挂了自动切备用。

请求时可临时覆盖模式：请求头 `x-governor-mode: strict`。

## 熔断与 failover

- 单上游**连续失败 2 次**进入 60s 冷却，期间跳过该上游。
- 一次请求会按候选顺序依次尝试，直到成功；全部失败返回 `502`。
- 注意：**流式（stream:true）响应已开始发送后**无法回退到下一个上游，非流式路径的 failover 是干净的。

## 精确缓存

`temperature=0` 且非流式时，相同请求（model+messages+tools+response_format）直接命中内存缓存，省 token、降延迟。缓存仅存在于进程内存，重启清空。

## 前端怎么接

在「API 管理」新增接口时，平台模板选 **本地代理(统一入口)**，Base URL 会自动填为 `http://127.0.0.1:8787/v1`；或直接把某个接口的 Base URL 改成这个地址。之后该接口的所有调用都走本地代理统一路由。

「中转站模型管理」顶部有「本地代理」状态条，打开页面会自动探测 `http://127.0.0.1:8787/health` 并显示在线/未运行。

## 管理端点（前端 / 中转站调用）

除聊天外，代理还暴露一组管理端点，供「免费模型目录」与「中转站」前端直接使用：

| 方法 / 路径 | 作用 |
|---|---|
| `POST /v1/catalog/refresh` | 代理在本地 spawn 抓取脚本，重新生成目录，返回 `{ ok, count, models }`。前端「刷新核验」点此实现真抓取 |
| `GET /v1/routes` | 返回各上游（厂商）列表，key 已掩码，含 `hasKey` 状态 |
| `POST /v1/routes` | 增/改厂商路由：`{ vendor, apiKey, baseUrl, models?, enabled? }`，写回 `config.json` |
| `POST /v1/quota` | 接收前端推送的真实剩余额度：`{ quota: { "<modelId>": "<剩余描述>" } }`，意图识别时消费 |
| `GET /v1/enabled` | 返回「已选中（开启）模型文档」`{ count, models:[{id,available,failedAt,lastOk}] }` |
| `POST /v1/enabled` | 前端每次开关模型时同步：`{ models: [已开启的 id…] }`，写入 `proxy/enabled-models.json`；意图识别只读这份文档，**不读 config 全量** |
| `POST /v1/token/generate` | 生成中转站**主控 Key**（写入 `token` 并返回），外部 AI 应用配对用 |
| `GET /v1/tokens` | 列出应用 Key（掩码）。`POST /v1/tokens` 带 `{action:'create'\|'delete'\|'rename'\|'toggle', ...}` 管理应用 Key |
| `GET /v1/classifier` | 返回当前分类器模型 id。`POST /v1/classifier` 带 `{model}` 设置分类器（写入 `config.json`） |
| `GET /v1/logs?limit=N` | 返回最近请求日志（落盘 `logs/proxy-YYYY-MM-DD.jsonl`，保留 30 天） |
| `POST /v1/logs/clear` | 清空全部日志文件 |
| `POST /v1/auto/chat/completions` | 意图识别：请求体带 `models:[已开启的 id…]`（不传则自动取「已选中文档」），代理按「难度 × 能力 × 额度」综合评分选模型（详见下节）再转发 |
| `GET /v1/models` | 模型列表。**意图识别模式下只读「已选中模型文档」**（不暴露未开启模型，外部 AI 应用自动发现的就是真正可用集）；冷启动（前端未同步）退回静态 `config`。每条带 `available` 标记 |

所有端点均带 CORS `*`，`file://` 页面可直接 `fetch`。

## 意图识别（自动选模型）

开启「意图识别」后，前端把**已开启**的模型 id 列表随请求带给 `/v1/auto/chat/completions`，并把 localStorage 里的真实剩余额度 `POST /v1/quota` 推给代理。

### 已选中（开启）模型文档：`enabled-models.json`（零探测、不烧 token）

意图识别模式**不该直接读 `config.json`**——那里混着大量没选中的模型。代理改用一份独立的「已选中模型文档」`proxy/enabled-models.json`：

- 前端每次在目录里**开关模型**，就 `POST /v1/enabled { models: [已开启的 id…] }` 同步这份文档；关掉的模型从文档移除（即你说的「没选中则移除」）。
- `/v1/models` 与 `/v1/auto` 的候选**只来自这份文档**，拿到的全是用户开启、适配的模型。
- **零探测、零 token 消耗**：文档只在真实使用时更新，平时只读文件，不会为「验证路由是否可用」去反复调用上游（那会悄悄消耗 token）。
- **失败容错（某家挂了跳过、不整体报错）**：某模型在一次调用里所有上游都失败，代理把它临时标 `available:false` 并进入冷却（60s），期间不进入候选；冷却后允许重试，成功即恢复。这是**临时跳过**，不会永久删除你开启的模型。
- 冷启动（前端尚未同步）时文档从 `config.json` 派生初始可用集（仅内存，不落盘），保证外部应用仍可用；首次同步后即以文档为准。

### 模型加权路由（难度 × 能力 × 额度 综合评分）

代理启动时加载 `models-catalog.json` 为每个模型推断**能力档**（免费小模型=1 / 限额中档=2 / 大上下文或推理=3）。每次自动选模型按三要素打分：

- **难度匹配**：分类器返回任务难度（1 简单 / 2 中等 / 3 困难），模型能力档与难度越接近分越高；
- **能力**：能力档越高分越高（困难任务倾向大上下文/推理模型）；
- **额度保护**：**简单 / 中等任务使用限额（非免费）模型会重罚**（简单 −6、中等 −3），优先把免费模型分给简单与中等任务；限额模型之间按剩余额度多少做平手排序，避免把额度都耗在一个模型上。

效果：小问题、中等问题不会误用限额高质量模型，防止不必要的额度损耗；只有困难任务才会落到限额/大上下文模型。

> 若未设 `classifier`，难度默认按「简单」处理（最大额度保护），仍由评分选出最合适模型；设了 `classifier` 会让它先判断真实难度，更准。

未开启意图识别时，前端只允许启用**一个**模型，直接走 `/v1/chat/completions` 指定该模型，零歧义。

### 前端「意图识别 · 中转站 Key」面板

「中转站模型管理」模块顶部新增一块面板，把上面这套能力直接做成可操作 UI：

- **一键开启/关闭意图识别**：点开关即切换 `DB.settings.intent`，并立即把真实剩余额度 `POST /v1/quota` 推给代理（开启时）。
- **生成 / 复制中转站主控 Key**：点「生成」调 `POST /v1/token/generate`，返回的 Key 展示在框内并可一键复制；同时存到本机 localStorage，供「试用」调用。外部 AI 应用填 `BaseURL = http://127.0.0.1:8787/v1` + 这个 Key 即可配对。
- **应用 Key 管理**：为每个外部 AI 应用（CherryStudio / NextChat …）生成**独立** Key，可单独复制 / 改名 / 停用 / 撤销。应用 Key 仅用于 `chat/auto` 调用，与主控 Key、管理端点分离。代理未运行时此区为空。
- **分类模型设置**：下拉选择用哪个免费模型做意图分类（前端目录里的 `free` 模型）；点「设为分类器」写入 `config.classifier`。下方「测试选模型」输入一句需求，看代理会挑哪个模型。
- **试用（自动选模型）**：在文本框写一句需求，点「发送」会把 `models: [已启用的 id…]` 带给 `/v1/auto/chat/completions`，面板展示代理最终选中的模型与回复，用来验证自动路由是否生效。

> 关掉意图识别时只允许启用一个模型（单选，避免歧义）；开启后由代理从已启用模型里自动挑。

## 开机自启动与桌面启动

代理默认需手动启动。下列脚本让它在你**登录 Windows 时**后台常驻，契合「意图识别 ON = 代理常驻」的设计。

### 文件清单（均在 `proxy/` 目录）

| 文件 | 作用 |
|---|---|
| `start-proxy.bat` | 交互式启动：双击可见日志窗口，`pause` 防误关 |
| `start-proxy-silent.vbs` | 静默启动器：隐藏窗口、脱离终端运行 `node proxy.js`，供自启动调用 |
| `install-autostart.bat` | 一键注册自启（写入「启动」文件夹快捷方式；若无 `config.json` 自动从 example 复制） |
| `uninstall-autostart.bat` | 一键撤销自启（删除该快捷方式） |
| `make-desktop-shortcut.vbs` | 辅助：双击它可在桌面生成真正的 `.lnk` 快捷方式（指向交互式 `start-proxy.bat`） |

### 用法

1. 注册开机自启（只需一次）：

   ```bash
   cd proxy
   install-autostart.bat
   ```

   它会先确保 `config.json` 存在（没有就从 `config.example.json` 复制，避免静默启动因缺配置而失败），然后在「开始菜单 ▸ 程序 ▸ 启动」放一个指向 `start-proxy-silent.vbs` 的快捷方式。下次登录后代理后台静默运行（`http://127.0.0.1:8787`）。

2. 桌面手动启动：双击桌面上的 `free-api-proxy.bat`（即本目录 `start-proxy.bat`，带日志窗口）。

3. 撤销自启：

   ```bash
   cd proxy
   uninstall-autostart.bat
   ```

> 自启方式选的是「启动文件夹」（当前用户级、无需管理员、删快捷方式即撤销）。注册的是**静默**启动器，不弹窗；要看到日志请手动双击 `start-proxy.bat` 或桌面 `free-api-proxy.bat`。
> 自启只解决「登录后自动起代理」；**已运行的代理不会因为撤销而关闭**，需手动结束 `node.exe (proxy.js)`。

### 备注

- 代理读取 `config.json`（缺参默认同目录）。`install-autostart.bat` 已处理「首次无 config」的情况。
- 想局域网共享把 `host` 改 `0.0.0.0` 前务必设 `token`（见「安全提示」）。

## 安全提示

- 默认只监听 `127.0.0.1`，不暴露到公网。改 `0.0.0.0` 前务必设置 `token`。
- Key 全部在本机 `config.json`，**不要**把这个文件提交到任何仓库或当作前端数据。
- 这不是账号体系，代理本身没有加密存储，仅防误用。

## 自测

```bash
node selftest.js
```

会临时拉起一个 mock 上游 + 代理，验证 18 组共 44 项断言：健康检查、chat 透传回显、精确缓存命中、无匹配上游返回 503、`/v1/models` 聚合、CORS 头，以及管理端点——`GET/POST /v1/routes`（掩码、不泄露明文 key、写入厂商路由）、`POST /v1/quota`（额度推送与 `quotaCount`）、`POST /v1/auto/chat/completions` 的**加权路由**（简单任务自动选免费模型、额度保护生效）、`POST /v1/catalog/refresh`（真抓取、测完还原真实目录避免污染）、`POST /v1/token/generate` 与 **token 鉴权**、`/v1/tokens`（应用 Key 增删与调用）、`/v1/classifier`（设置与回传）、`/v1/logs` 与 `/v1/logs/clear`（落盘、30 天保留、清空）、**已选中模型文档**（`POST/GET /v1/enabled`、`/v1/models` 改读文档、auto 从无 `models` 时从文档取候选）。全部通过即代表代理可用。
