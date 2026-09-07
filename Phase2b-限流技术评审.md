# Free API 工作台 · Phase 2b 技术评审：代理层速率限制（Rate Limiting）

> 版本：v0.8.0 规划｜状态：**已拍板（方案锁定，待 v0.7.0 本机验收后开发）**｜日期：2026-09-05
> 前置依赖：Phase 2a 已发布（v0.7.0，SQLite 请求日志 + 前端日志页 + 日志接口鉴权）
> 本文仅输出技术评审方案，**不含实现代码**；待评审拍板后再进入开发。

---

## 0. 决策基线（用户已拍板，直接继承）

| # | 决策 | 说明 |
|---|---|---|
| 0.1 | **维持完整运行包** | 不回退源码-only；接受包体积增大；Node 版本不兼容靠文档 + 优雅降级处理（README「原生模块注意」已写明） |
| 0.2 | **2a 本机验收后再开工** | 你先本机验收 v0.7.0：解压运行 / 日志页渲染 / CSV 导出；确认无问题再启动 2b |
| 0.3 | **复用 2a 埋点字段** | 不新增多余字段，限流计数直接消费 `api_request_log` 既有维度 |
| 0.4 | **限流优雅降级** | 限流模块故障**绝不阻断**代理核心聊天链路（forwardTo 始终放行） |
| 0.5 | **单测模拟内存** | 限流逻辑尽量单元化、内存场景自测，减少对真实上游 e2e 的依赖 |
| 0.6 | **2c 架构重构后置** | 优先完成业务能力（2b）；2c 本次不碰 |

---

## 1. 问题定义与范围

### 1.1 为什么需要限流
- **保护上游免费额度**：硅基流动 / 智谱等免费层有每分钟请求数、每日 token 硬上限，超额即 429/计费。代理需在本机前置拦截，避免一冲就爆上游。
- **保护代理自身**：单进程 Node 代理，突发海量请求会拖垮事件循环 / 占满上游连接。
- **多租户公平**：代理常被多个本地客户端（或局域网设备）共用，需按 `client_ip` 防单点刷爆。

### 1.2 In Scope
- 代理入站请求的多维度速率限制（请求数 / token 消耗）
- 限流触发时返回 `429` + `Retry-After`
- 限流配置（`config.json` 的 `rateLimit` 段）+ 校验
- 限流模块独立封装 + 优雅降级
- 限流状态查询接口（可选，见 §8）
- 内存场景单元测试

### 1.3 Out of Scope（本阶段不做）
- 计费 / 配额账本（仅做速率限制，不做额度扣减持久化）
- 分布式限流（多代理实例共享计数）——本机单进程，文档注明局限
- 前端限流配置 UI（仅后端 + 可选 status 接口，前端后置到 2c 或之后）
- 2c 架构重构（模块拆分 / 路由重写等）

---

## 2. 限流维度设计

直接复用 `api_request_log` 既有字段（已核对 db.js 建表 DDL）：

| 维度 | 来源字段 | 用途 | 优先级 |
|---|---|---|---|
| **全局 QPS** | （无字段，进程级计数器） | 保护代理自身不被打爆 | P0 兜底 |
| **按 upstream** | `upstream` | 各厂商免费额度不同（硅基流动 / 智谱分算） | P1 |
| **按 client_ip** | `client_ip` | 多租户公平，防单 IP 刷爆 | P1 |
| **按 token 消耗** | `total_tokens`（= `prompt_tokens + completion_tokens`） | 免费层按 token 限额 | P2（依赖 2a usage 提取） |
| **按 model** | `model` | 精细到大模型级别（可选，低频用） | P3 可选 |

**组合策略（推荐）**：全局 QPS 作兜底闸门 → 命中后按 `upstream` + `client_ip` 双维度桶判断 → token 维度在 usage 可提取时叠加判断，提取失败（NULL）退化为请求数判断。

---

## 3. 算法选型对比

| 算法 | 精度 | 内存 | 突发容忍 | 实现复杂度 | 适配度 |
|---|---|---|---|---|---|
| 固定窗口计数器 | 中（窗口边界双倍突发） | 极低 | 差 | 低 | 中（全局兜底可用） |
| 滑动窗口日志 | 高 | 高（随请求增长） | 好 | 中 | 低（内存不可控） |
| **滑动窗口计数器** | 高 | 低 | 好 | 中 | 高 |
| **令牌桶** | 高 | 低（桶态固定） | 好（支持突发） | 中 | **最高（推荐主算法）** |
| 漏桶 | 高 | 低 | 差（强制匀速） | 中 | 低（不适合 LLM 突发） |

**推荐选型**：
- **主算法 = 令牌桶（Token Bucket）**：每 `(upstream, client_ip)` 组合一个桶；支持合理突发（首字延迟敏感场景友好），桶态内存固定不随流量增长。
- **全局兜底 = 固定窗口 QPS**：进程级单计数器，保护代理自身，实现极简。
- **token 维度**：令牌桶的「容量」用 token 数计量（当 usage 可提取时），否则退回请求数计量。

> 令牌桶核心参数：`capacity`（桶容量）、`refillRate`（每秒补充）、`tokens`（当前）。`allow()` 原子扣减，不足返回 `false` 并附 `retryAfter = ceil((needed - tokens) / refillRate)`。

---

## 4. 存储与状态

- **进程内 `Map`**：key = `${upstream}::${clientIp}`，value = 桶态 `{tokens, lastRefill}`。零依赖、最快。
- **TTL 清理防内存泄漏**：后台 `setInterval`（复用 2a 的 `unref` 模式，不保活进程）定期删除「超过 N 分钟无活动」的桶；上限保护（Map size 超过阈值时淘汰最久未用）。
- **不持久化**：代理重启计数归零可接受（免费额度保护是近似防御，非精确账本）；文档注明「重启后重新累计」。
- **集群局限**：单进程内存限流，多实例不共享计数——文档明确「单机单代理场景设计」。

---

## 5. 埋点复用方案（核心）

**不新增数据库字段**。限流检查发生在 `handleChat` 调 `forwardTo` **之前**，直接消费 2a 既有入参：

```
handleChat(req, res, u):
  const ip = clientIpOf(req)              // 2a 已有辅助
  const up = resolveUpstream(...)         // 2a 已解析 upstream 名
  // —— 新增：限流前置检查（在 forwardTo 之前）——
  const decision = rateLimiter.allow({ upstream: up, clientIp: ip, estimatedTokens: 0 })
  if (!decision.allowed) { return send429(res, decision.retryAfter) }   // 优雅：异常时 allow() 返回 allowed=true
  const fr = await forwardTo(...)
  // —— 2a 既有埋点保持不变 ——
  logRequest({ upstream: up, model: ..., usage: fr.usage, clientIp: ip, ... })
  // —— 新增：请求完成后按真实 usage 回填 token 计数（允许为负补偿，桶可超发后慢慢补）——
  rateLimiter.settle({ upstream: up, clientIp: ip, usedTokens: (fr.usage && fr.usage.total_tokens) || 0 })
```

- `estimatedTokens`：请求前未知真实消耗，前置检查按「请求数」维度；`settle()` 用真实 `total_tokens` 修正 token 维度计数。
- token 提取失败（`fr.usage` 为 NULL，2a 已处理）：`usedTokens = 0`，token 维度退化为请求数维度，不崩溃。

---

## 6. 优雅降级设计（强制，对应 0.4）

限流模块独立为 `proxy/rateLimiter.js`，与核心链路**单向解耦**：

- **初始化失败**（配置解析错 / 内存分配异常）：`rateLimiter` 进入 `disabled` 态，`allow()` 恒返回 `allowed:true`，代理其余功能不受影响（与 2a db.js 降级同构）。
- **运行时异常**（Map 操作抛错 / 计算溢出）：`allow()` / `settle()` 内 `try/catch`，异常 → 记 `console.warn` → 放行，**绝不 `throw` 到 `handleChat`**。
- **配置 `enabled:false`**：一键关闭限流，全放行。
- **关键不变量**：`forwardTo` 及其调用链在任何限流异常下都照常执行；限流是「旁路装饰」，不是「前置闸门中的硬依赖」。

---

## 6.1 限流触发事件落库（复用 `api_request_log`，不新增表结构）

- **约束（用户确认）**：被 429 拒绝的请求**必须写入**既有 SQLite 日志表 `api_request_log`，复用现有全部字段，**不新增任何表 / 列**。
- **字段映射**（前置检查点已知信息，转发前即被拦）：
  - `request_time` = 当前本地时间
  - `upstream` = 命中限流的 upstream 名（全局兜底层记为 `'global'`）
  - `model` = NULL（未转发，模型未知）
  - `prompt_tokens` / `completion_tokens` / `total_tokens` = NULL（未转发，无 usage）
  - `status_code` = **429**
  - `latency_ms` = 限流判定耗时（通常 <5ms，可记 0）
  - `error_msg` = 限流原因，如 `rate_limited: upstream per-minute exceeded` / `rate_limited: global QPS exceeded`（内容以 `r` 开头，不触发 CSV 注入转义，安全）
  - `client_ip` = 客户端 IP
- **实现位置**：在 `allow()` 拒绝分支 `return send429(...)` **之前**调用 2a 既有 `logRequest(...)`（与正常成功链路共用同一落库函数，保证 JSONL 与 SQLite 两套日志并行落盘，不新增代码路径）。
- **降级一致性**：若 `db.js` 自身 `disabled`，落库静默跳过，不影响 429 返回（与 2a 同构）。

## 7. 配置 Schema（config.json 扩展）

```json
{
  "rateLimit": {
    "enabled": true,
    "global": { "maxPerMinute": 600 },
    "perUpstream": {
      "enabled": true,
      "maxPerMinute": 120,
      "maxTokensPerMinute": 50000
    },
    "perClientIp": {
      "enabled": true,
      "maxPerMinute": 60
    },
    "tokenBucket": { "capacity": 100, "refillPerSecond": 2 },
    "bucketIdleTtlSec": 3600
  }
}
```

- `loadConfig` 对 `rateLimit` 整段兜底默认值（不配也安全起代理）。
- 校验失败 → 记警告 + 限流模块 `disabled`（不阻断代理启动）。

---

## 8. 接口设计（D3 / D4 已拍板）

- **限流触发响应（D3）**：`429 Too Many Requests` + 响应头 `Retry-After: <sec>` + **结构化 JSON 响应体**（非纯文本）：
  ```json
  { "error": "rate_limited", "retryAfter": <sec>, "scope": "upstream|clientIp|global", "message": "请求过于频繁，请稍后重试" }
  ```
  前端据此展示友好提示（与 2a 日志接口错误风格一致）。
- **状态查询（D4，实现）**：`GET /api/rate/status`（⚠️ 路径为 `/api/rate/status`，非 `/api/rate-limit/status`）—— 鉴权与 `/api/config` **同级**（本机 `127.0.0.1` 免 token，非本机须 `x-proxy-token`/Bearer 否则 401；返回体含 `client_ip` 与 `disabled` 标志，与 2a 日志接口同构），返回：
  - `disabled`：限流模块是否降级关闭
  - `global`：全局固定窗口当前计数 / 上限 / 窗口剩余秒
  - `buckets`：各 `upstream::clientIp` 桶的 `tokens` 剩余 / `capacity` / `refillRate` / 是否受限（聚合展示，避免泄露过多客户端细节；本机调试足够）
  - 便于你本机解压验收时实时排查「为什么被限」。

---

## 9. 测试策略（重点：内存模拟，对应 0.5）

**新增 `test-rate-limit.js`（单元 + 内存场景，不依赖真实上游）**：

| # | 用例 | 验证点 | 是否需真实上游 |
|---|---|---|---|
| 1 | 令牌桶消耗 / 补充 | 连续请求耗尽 → 触发拒绝 → 等待补充后恢复 | 否（纯函数） |
| 2 | 固定窗口全局 QPS | 超 `maxPerMinute` → 429 | 否 |
| 3 | 限流触发返回 429 + Retry-After | 响应头 / JSON 结构 | 否（直接调 limiter + 模拟 res） |
| 4 | 多 upstream 隔离 | A 限流不影响 B | 否 |
| 5 | 多 client_ip 隔离 | IP1 限流不影响 IP2 | 否（mock req.socket） |
| 6 | **优雅降级：limiter 抛异常 → 放行** | `allow()` 异常返回 `allowed:true`，聊天链路不中断 | 否（注入坏环境） |
| 7 | 配置 `enabled:false` → 全放行 | 关闭开关 | 否 |
| 8 | token 维度：usage NULL 退化为请求数 | `fr.usage` 为 null 不崩 | 否 |
| 9 | 内存 TTL 清理 | 久未用桶被淘汰，Map size 不无限增长 | 否 |
| 10 | **HTTP 集成（dummy upstream）** | 用 2a 冒烟同款 `dummy` upstream 发 N 请求，验证代理返回 429（不走真实上游，延迟可控） | 否（dummy 上游） |

> 仅用例 10 走 HTTP，且用 `dummy` 上游（2a 冒烟已验证该模式），**不调真实硅基流动/智谱**，避免 2a e2e 那种 30s+ 延迟拖累。真实上游 e2e 仅保留既有 9/9 作为回归冒烟，不在 2b 新增真实上游限流 e2e。

**回归红线（沿用 2a，提交前强制）**：
- `test-ui-render.js` 119/119（前端未改也须过，防回归）
- `e2e-api-test.js` 9/9（真实上游，验证限流关闭时聊天不受影响）
- `test-rate-limit.js` 全过（2b 新增）
- `test-log-api.js` 10/10（2a 日志链路未回归）

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 内存泄漏（桶无限增长） | 代理内存涨 | TTL 淘汰 + size 上限（§4） |
| 误杀正常请求 | 体验降级 | 阈值保守 + `enabled:false` 一键关；Retina-After 给客户端退避 |
| token 计数 NULL 退化 | token 维度失效 | 自动退回请求数维度，不崩溃（§5） |
| 集群不共享 | 多实例限流失效 | 文档注明单机单代理设计（§4） |
| 限流模块自身 bug 阻断聊天 | 严重 | 优雅降级 + try/catch 旁路（§6），单测覆盖用例 6 |
| 配置错误 | 代理启动失败 | 配置整段兜底 + 校验失败仅禁用限流（§7） |

---

## 11. 交付物清单（开发阶段，本文不实现）

- `proxy/rateLimiter.js`（新建）— 令牌桶 + 全局窗口 + 降级 + TTL
- `proxy/proxy.js`（改）— `handleChat` 前置 `allow()` + 后置 `settle()` + 429 返回
- `proxy/config` 校验（改）— `rateLimit` 段兜底 + 校验
- `test-rate-limit.js`（新建）— 10 项内存场景单测
- `README.md`（改）— 限流说明 + 配置示例 + 优雅降级 + 集群局限
- `CHANGELOG.md`（改）— 新增 `[v0.8.0]` 段
- CI 沿用 v0.7.0 完整运行包 workflow（不回退源码-only，对应 0.1）

---

## 12. 工作模式（沿用 Phase 2a，对应 0.2）

1. **打快照**：`git tag phase2b-snapshot`（基于 2a 验收通过的 commit）
2. **增量开发**：按 §11 逐步实现
3. **全量回归**：§9 红线四项全过
4. **提交 + 打 tag**：commit 含 `feat(phase2b)`，打 `v0.8.0` 触发 CI 完整运行包 Release
5. **本机验收**：解压运行 + 限流 429 验证 + status 接口（若实现）

---

## 13. 决策项固化（2026-09-05 用户拍板确认）

> 以下 D1–D6 全部确认，评审方案据此锁定，开发阶段不再二次征求。

| # | 决策点 | 最终决策（已拍板） |
|---|---|---|
| D1 | 主算法 | **令牌桶**（支持合理突发）+ 全局固定窗口 QPS 兜底 |
| D2 | 限流维度组合 | **双轨并存**：①`upstream + client_ip` 粒度令牌桶（按上游 + 客户端做 token/请求配额）；②proxy 实例**全局固定窗口 QPS** 兜底防单实例被打满；**不做**单纯 client_ip 全局无区分限流 |
| D3 | 限流触发行为 | **返回 429 + Retry-After**，响应体为**结构化 JSON 错误**（非纯文本），便于前端展示 |
| D4 | 限流 status 接口 | **实现 `GET /api/rate/status`**（本机调试排查，路径以此为准） |
| D5 | token 维度默认开关 | **默认开启**；usage 为 NULL 时自动降级为请求计数模式，**不直接拒绝请求** |
| D6 | 默认阈值 | 沿用 §7 参考默认值（全局 600/min · upstream 120/min · 50000 tok/min · ip 60/min；tokenBucket cap100/refill2 · ttl3600s），全部入 `config.json.rateLimit`，允许用户完整覆写 |

---

## 14. 与 Phase 2c 的边界

- 2c（架构重构：模块化拆分 / 路由重写 / SPA 读写全走代理 API）**继续后置**。
- 2b 在现有 `proxy/proxy.js` 单文件内增量改造（新增 `rateLimiter.js` 独立模块，但 `handleChat` 调用点仍在该文件），不动整体架构。
- 2b 验收完毕、业务能力稳定后，再启动 2c 评审。

---

### 评审结论（建议）

方案技术可行、风险可控，核心依赖（2a 埋点字段、降级模式、CI 完整包）均已就位。**建议拍板 D1–D6 后进入开发**；最关键的工程纪律是 §6 优雅降级——限流模块永远是「旁路装饰」，任何异常都放行聊天，这与 2a db.js 降级同构，可复用同一套心智模型。

---

## 15. 补充工程约束（2026-09-05 用户确认，开发阶段强制遵守）

1. **降级范式完全对齐 2a `db.js`**：`rateLimiter.js` 初始化异常 / 运行时 `allow()`·`settle()` 抛异常 → 必须置 `disabled` 并直接放行，**绝对不能**阻断聊天代理主链路（`handleChat` → `forwardTo`）。限流是「旁路装饰」，不是「硬依赖」。
2. **单元测试全内存模拟为主**：`test-rate-limit.js` 用例尽量不依赖真实上游；仅保留 1 个 dummy upstream 的 HTTP 集成用例（2a 冒烟同款，延迟可控），**严禁**新增调用真实硅基流动 / 智谱的限流 e2e，规避网络抖动与 30s+ 上游延迟导致测试不稳定。
3. **严格增量开发，只改 `proxy.js`**：2b 仅在 `proxy/proxy.js` 内调用 `rateLimiter.js`，新增独立模块 `rateLimiter.js`，**不触碰** Phase 2c 架构重构（模块化拆分 / 路由重写 / SPA 读写全代理 API 等），架构重构继续后置。
4. **`config.json` 配置段格式校验**：`loadConfig` 对 `rateLimit` 段做类型 / 取值格式校验；**配置解析错误仅关闭限流模块**（`disabled`），代理整体继续正常启动，绝不因限流配置错而拒绝启动。
5. **限流触发落库**：复用 `api_request_log`，不新增表结构（见 §6.1）。

> 以上约束与 §0 决策基线（0.1–0.6）、§6 优雅降级、§9 测试策略共同构成 2b 开发纪律。

---

## 16. 实现细节参考（NEW API）

- 用户提示可参考开源 AI 网关 **NEW API**（原 One API 社区 fork，GitHub `Calcium-Ion/new-api`）。其限流以「用户 / 令牌」维度的 RPM / TPM 配额为主，在转发前置检查、超限返回 429，配置结构（每 key 的 RPM / TPM）可作为 `rateLimit` 配置表达的对照样本。
- **本项目方案已自洽**（令牌桶 + 全局固定窗口兜底 + 与 2a `db.js` 同构优雅降级），**无需引入 NEW API 代码**。NEW API 仅作实现细节参照（如配额表达、429 响应形态），不改动本评审算法 / 维度 / 降级决策。
- 若开工前希望吸收其具体令牌桶 / 滑动窗口实现细节，可在开发阶段拉取其 `rate-limit` 相关源码做对照（不强制、不阻塞方案锁定）。
