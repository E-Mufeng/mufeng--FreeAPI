# Free API 工作台 · 配置 Schema 契约（Phase 0 路线1）

> 目的：明确「浏览器 localStorage」与「本机 proxy config.json」的字段归属，定义 Phase 0 新增的
> 配置同步接口与导出/导入格式。本文是**技术契约**，开工前需你确认「待你拍板」项。
> 变更基线：当前 `index.html` 用 `localStorage['wb_freeapi_db_v2']`（version 2）；
> `proxy/config.json` 存代理路由与密钥。

---

## 1. 归属原则（铁律）

| 归属 | 存哪 | 清浏览器缓存后 | 说明 |
|------|------|----------------|------|
| **服务端配置** | `proxy/config.json` | ✅ 不丢 | 代理核心、上游凭证、中转规则、目录、令牌 |
| **UI 偏好** | `localStorage` | ❌ 丢（可接受） | 主题/字号/背景/启动页等纯界面项，**任何阶段都只留浏览器** |
| **业务数据（路线1）** | 双向同步 | ✅ 不丢 | 经 `GET/PUT /api/config` 镜像进 config.json |

⚠️ **Phase 2（SQLite）才让 SPA 完全脱离 localStorage**；路线1只是"镜像备份"，localStorage 仍是最新工作副本，config.json 是持久副本。

---

## 2. 字段归属矩阵（基于当前真实结构）

### 2.1 永远留 localStorage（UI 偏好，不进 config.json）
```
settings: {
  theme, themeBg, brightness, fontScale, fontFamily, startup,   // 外观/启动
  density, showMasked, confirmDelete, intent, vaultOn, demoState // 行为开关
}
gen: { stage, scene, goal, custom, collapsed }                  // 向导临时态
```

### 2.2 归属 proxy config.json（服务端，清缓存不丢）
```
port, host, mode, token(主控), classifier, passthroughAuth, appTokens[]   // 代理核心
upstreams: [ { name, vendor, baseUrl, apiKey, models[], weight, priority, cost, enabled } ]  // ⚠️见 §3 重命名
relay:     [ { id, name, upstream, model, enabled, weight, note } ]        // ⚠️见 §3 重命名（原 SPA routes）
catalog:   { user:[], enabled:{}, vendorKey:{} }                           // 用户目录/厂商密钥
relayToken, proxyMasterToken                                            // SPA↔代理 鉴权令牌
```

### 2.3 当前 localStorage 业务字段 → 路线1 去向
| 当前 localStorage 字段 | 路线1 处理 |
|------------------------|-----------|
| `apis[]`（凭证 vault） | 镜像进 config.json `upstreams[].apiKey`（按 vendor/baseUrl 匹配）；SPA 仍保留明文/密文副本 |
| `routes[]`（中转规则） | **改名** `relay[]` 进 config.json（见 §3） |
| `catalogUser / catalogEnabled / catalogVendorKey` | 镜像进 config.json `catalog` |
| `relayToken / proxyMasterToken` | 镜像进 config.json 对应字段 |
| `models[]`（免费目录） | **不进 config.json**：属静态情报，走 `catalog-embedded.js` / 代理 `/catalog/refresh`，保持前端内嵌 |
| `logs[]` | 路线1 仍为前端内存；Phase 2 才入 sqlite |

---

## 3. ⚠️ 命名雷区：`routes` 双重含义（必须处理）

当前两个 `routes` 语义完全不同，直接合并会**互相覆盖**：

- **config.json `routes`** = 代理**上游供应商**定义（含 `apiKey`/`baseUrl`/`models`，是连通大模型的根本）。
- **localStorage `routes`** = SPA **中转路由规则**（上游名→模型映射，是用户编排的调用策略）。

**决策**：config.json 侧 `routes` → 重命名为 **`upstreams`**；SPA 中转规则 → 落 config.json 键 **`relay`**。
代理代码 `config.routes` 全部改为 `config.upstreams`（含 `resolveRoutes`/`maskRoute` 等引用），避免与 `relay` 混淆。

---

## 4. 接口契约

### 4.1 `GET /api/proxy/status`（欢迎页轮询用）
- 路径：`/api/proxy/status`（建议加前缀区分旧 `/v1/*`）
- 成功（代理在线）返回 200：
```json
{
  "online": true,
  "version": "0.5.0",
  "mode": "balanced",
  "models": 12,            // 当前生效模型总数（upstreams 内 models 去重计数）
  "upstreams": 3,          // 已启用上游数
  "relay": 3,              // 中转规则数
  "ts": 1693872000000
}
```
- 不可达（端口关闭/未启动）：**SPA 捕获 fetch 异常 → 渲染离线态**，不抛错、不崩：
  - 状态标签变红，文案「本地代理离线」，提示「请启动本地代理服务」。
- 轮询：`onMounted` 起 3–5s 一次；`onUnmounted` 清定时器；`prefers-reduced-motion` 不影响轮询。

### 4.2 `GET /api/config`
- 返回合并后的完整配置（业务字段），**密钥掩码**：
```json
{
  "proxy":   { port, host, mode, token: "***", appTokens: [{"name":"***"}] },
  "upstreams": [ { "name":"硅基流动", "apiKey":"sk-***", "models":[...], "enabled":true } ],
  "relay":   [ { "id":"...", "name":"对话-主线路", "upstream":"百炼-通用", "model":"qwen-plus", "enabled":true } ],
  "catalog": { "user":[], "enabled":{}, "vendorKey":{} },
  "tokens":  { "relayToken":"***", "proxyMasterToken":"***" }
}
```

### 4.3 `PUT /api/config`
- Body：部分字段补丁（如 `{ "relay": [...] }` 或 `{ "catalog": {...} }`）。
- 代理行为：`deepMerge` 进 `config.json` 并落盘；不接受的字段忽略；返回 `{ ok:true, updated:[...] }`。
- 鉴权：需 `x-proxy-token` 或 Bearer（复用现有 `config.token` / `appTokens`）。
- ⚠️ `proxy.token`/`appTokens` 等**核心鉴权字段禁止经此接口改写**（防锁死），只能改本机 config.json。

### 4.4 导出 / 导入（换机）
- `GET /api/config?export=1`（或 `POST /api/config/export`）：返回 `tool-backup.json` 全量（含未掩码密钥，因为本机备份用途）。
- `POST /api/config/import`（multipart/json）：校验 schema 版本 → 合并写盘 → 返回 `{ ok, imported:["apis","relay","catalog"] }`。
- SPA 侧同时提供纯前端「导出全部配置」按钮（`localStorage` → `tool-backup.json`）与「从备份导入」（读 json 恢复 localStorage），**双通道**：即使代理没起也能备份/恢复浏览器内数据。

---

## 5. 同步流程（路线1）

```
SPA 改配置 → save() 写 localStorage（即时生效）
           → 若代理在线：PUT /api/config（补丁）镜像进 config.json
           → 若代理离线：仅留 localStorage，下次在线重试（队列/标记 dirty）

SPA 启动加载 → 优先 GET /api/config（代理在线则用服务端为权威）
            → 代理离线：回退 localStorage（保证可用）
```

降级铁律：**代理离线绝不让页面崩溃**；任何接口异常 catch 后走 localStorage 兜底。

---

## 6. 迁移（从当前 localStorage 到路线1）
1. 首次启动：若 config.json 无 `relay`/`catalog`/`tokens`，从 localStorage 种子写入（一次性迁移）。
2. `config.routes` → `config.upstreams` 重命名（代理侧，含所有引用）。
3. 保留旧 `wb_freeapi_db_v2` 不动，新增同步层；验证导入/导出往返一致后再视情况收敛。

---

## 7. 待你拍板（开工前确认）
1. **`apis` 与 `upstreams.apiKey` 的权威方**：代理为上游连通权威（推荐），还是 SPA 凭证 vault 为权威？影响 PUT 方向。
2. **`models[]` 免费目录**是否纳入 config.json（我建议不纳，保持前端内嵌）——确认。
3. **`PUT /api/config` 是否允许改 `upstreams`**（上游 baseUrl/apiKey）：允许则用户可在 SPA 直接改上游密钥；若只允许改 `relay`/`catalog` 则上游密钥仍只走本机 config.json。
4. 导出文件命名固定 `tool-backup.json` 是否 OK（你原话即此名，确认即可）。
