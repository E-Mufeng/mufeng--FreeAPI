# Free API 工作台

> 把多家大模型厂商的免费 / 限额免费模型，聚合成本地一个 **OpenAI 兼容**的统一入口。自托管、零月费、数据全留在本机。

[![Node](https://img.shields.io/badge/Node-22%2B-3c873a)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Zero Dependency Proxy](https://img.shields.io/badge/proxy-zero--dependency-999999)](#%E6%9E%B6%E6%9E%84)

本地 AI 模型「聚合 + 中转 + 管理」工作台：把硅基流动、阿里云百炼、智谱、DeepSeek、腾讯混元、字节豆包、Moonshot、百川、阶跃星辰、OpenRouter 等多家上游，聚合成单个 `/v1/chat/completions` 端点，支持路由策略、意图识别、429 自动 failover、额度告警与消耗分析。**所有密钥只在本机 `config.json`，所有数据只在本机，不上传任何云端。**

---

## 目录

- [它能做什么](#它能做什么)
- [核心功能](#核心功能)
- [整体架构](#整体架构)
- [快速开始](#快速开始)
- [配置你的上游 API Key](#配置你的上游-api-key)
- [功能详解](#功能详解)
- [隐私与安全](#隐私与安全)
- [项目结构](#项目结构)
- [部署（Docker / systemd）](#部署docker--systemd)
- [常见问题 FAQ](#常见问题-faq)
- [许可证](#许可证)
- [版本路线](#版本路线)

---

## 它能做什么

你手里有好几家厂商的免费 / 限额额度，但每家 base URL、鉴权、模型名都不一样，客户端（ChatBox、OpenWebUI、Cherry Studio、LobsterAI 等任何 OpenAI 兼容客户端）只能填一个地址。

Free API 工作台在本机起一个代理，把这些上游**统一成一个地址** `http://127.0.0.1:8787/v1/chat/completions`。你在客户端里只填这一个地址，剩下的路由、重试、额度都交给工作台。

- 想用哪家模型，就在 `config.json` 里填那家的 key；
- 免费模型 429 / 限流时，自动 failover 到其它可用上游的同类型模型；
- 每模型剩余免费额度、各家厂商账户余额、近 14 天消耗趋势，一眼可见。

---

## 核心功能

- **🔌 统一 OpenAI 兼容入口**：`/v1/chat/completions` 与官方格式一致，主流客户端直接填地址即用。
- **🧭 意图路由 + 权重策略**：按模型能力、权重、优先级把请求转发到最合适的上游；支持 `modelMapping` 把 `gpt-4` 之类名字重定向到你的免费模型。
- **🔁 429 / 限流自动 failover**：某上游限流时，自动切换备用模型；过滤掉「当前配置无可用上游」的模型，避免 502。
- **📡 免费模型情报目录**：内置 200+ 条免费 / 限额免费模型情报（多源聚合 + 实连校验），标注状态（可用 / 限额 / 限免 / 待核实 / 已过期 / 已下架）、免费额度、活动剩余天数。
- **💰 额度可视化**：每模型剩余免费 Token 余额（进度条）；DeepSeek / 硅基流动厂商账户余额；低于阈值的 ⚠ 告警（warn / crit）。
- **📊 额度消耗分析**：基于本地请求日志聚合——总调用 / Token / 成功率 / 429 率 / 平均延迟，按模型 Top8、按厂商、近 14 天趋势。
- **📝 SQLite 请求日志**：每次中转调用落库，工作台内分页查看 / 筛选 / 导出 CSV。
- **🚦 速率限制**：令牌桶 + token 维度窗口 + 全局兜底，超限返回 429 + `Retry-After`；多实例可共享 SQLite 限流计数。
- **🩺 可观测性**：`/health` 端点返回版本 / 在线 / 路由模式 / 限流 / 日志状态；前端侧栏常驻健康徽标。
- **🔐 账号体系**：访问密码 + 会话 token；可设访问密码保护管理与聊天接口。
- **🐳 一键部署**：Docker / systemd 单元齐全；打 tag 自动出 Release 完整运行包（解压即跑）。

---

## 整体架构

```mermaid
flowchart LR
    A[OpenAI 兼容客户端<br/>ChatBox / OpenWebUI / Cherry Studio ...] -->|/v1/chat/completions| B[Free API 本地代理<br/>127.0.0.1:8787]
    B -->|意图路由 / 权重 / failover| C{上游厂商}
    C --> U1[硅基流动]
    C --> U2[阿里云百炼]
    C --> U3[智谱 AI]
    C --> U4[DeepSeek]
    C --> U5[腾讯混元]
    C --> U6[字节豆包]
    C --> U7[Moonshot / KIMI]
    C --> U8[百川 / 阶跃星辰]
    C --> U9[OpenRouter]
    B -->|静态托管| D[工作台 SPA<br/>浏览器界面]
    B -->|请求日志 / 业务状态| E[(SQLite<br/>logs.db / free_api.db)]
    B -. 密钥仅在本机 config.json .-> F[(proxy/config.json<br/>gitignore，不提交)]
```

- **前端（SPA）**：`index.html` + `src/`，纯静态，由代理托管。
- **代理（proxy）**：零依赖 Node 服务（`proxy/proxy.js`），同时承担 API 中转 + 静态资源托管 + SQLite 日志/状态。
- **配置与数据**：密钥在 `proxy/config.json`（gitignore）；运行时数据在 `proxy/*.db`（gitignore）。**两者都不进仓库、不打进 Release。**

---

## 快速开始

### 1. 准备环境

- 安装 **Node.js 22+**（原生模块 `better-sqlite3` 按 Node 22 / ABI 127 预编译；其它大版本见下方「已知限制」）。
- 克隆仓库：

```bash
git clone https://github.com/E-Mufeng/Free-API.git
cd Free-API
```

### 2. 安装依赖并构建

```bash
npm install        # esbuild（构建）+ better-sqlite3（运行时日志/状态）
npm run build      # 生成 dist/（SPA 生产产物）
```

> 不构建也能开发期直跑：`node proxy/proxy.js` 在 `dist/` 缺失时自动回退读 `src/` 源码根。

### 3. 填入你的上游 Key

```bash
cp proxy/config.example.json proxy/config.json   # 首次必做
# 编辑 proxy/config.json，把上游 apiKey 换成你自己的
```

详见下一节 [配置你的上游 API Key](#配置你的上游-api-key)。

### 4. 启动代理

```bash
node proxy/proxy.js
# 或 Windows 双击 start.bat / Linux 运行 start.sh（会自动打开浏览器）
```

启动后访问：

| 用途 | 地址 |
| --- | --- |
| 工作台界面（SPA） | http://127.0.0.1:8787/ |
| 聊天接口 | http://127.0.0.1:8787/v1/chat/completions |
| 健康检查 | http://127.0.0.1:8787/health |

代理默认监听 `127.0.0.1:8787`，**仅本机可访问**。客户端里填 `http://127.0.0.1:8787/v1/chat/completions` 即可。

> **不要直接双击 `index.html`（`file://`）打开**：Vite 模块化后脚本以 `type="module"` 加载，`file://` 下浏览器会拦截 ESM，界面会"毁坏"。必须通过代理访问。误用 `file://` 时页面会显示引导卡片提示正确打开方式。

---

## 配置你的上游 API Key

代理配置在 `proxy/config.json`，核心是一组 `upstreams`（上游厂商）。每个上游包含 `baseUrl`、你的 `apiKey`、该厂商可用的 `models` 列表，以及路由用的 `weight` / `priority` / `cost`。

下面是 `config.example.json` 的片段（占位符，需替换成你的真实 key）：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "mode": "balanced",
  "upstreams": [
    {
      "name": "硅基流动",
      "vendor": "硅基流动 SiliconFlow",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "apiKey": "sk-your-siliconflow-key",
      "models": ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-7B-Instruct"],
      "weight": 3,
      "priority": 1,
      "cost": 0,
      "enabled": true
    },
    {
      "name": "阿里云百炼",
      "vendor": "阿里云百炼",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-your-bailian-key",
      "models": ["qwen-plus", "qwen-max"],
      "weight": 2,
      "priority": 2,
      "cost": 0,
      "enabled": true
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `name` / `vendor` | 展示名 / 厂商名（自定义即可） |
| `baseUrl` | 厂商的 OpenAI 兼容端点（各家不同，见上表示例） |
| `apiKey` | **你自己的**厂商 API Key，从厂商控制台获取 |
| `models` | 该上游可供调用的模型 id 列表（填错会导致路由失败） |
| `weight` | 负载权重，越大越优先被选中 |
| `priority` | 优先级，越小越优先 |
| `cost` | 成本权重（免费模型填 0） |
| `enabled` | 是否启用该上游 |

常用厂商 `baseUrl` 速查：

| 厂商 | baseUrl |
| --- | --- |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 腾讯混元 TokenHub | `https://tokenhub.tencentmaas.com/v1` |
| 字节豆包 | `https://ark.cn-beijing.volces.com/api/v3` |
| Moonshot / KIMI | `https://api.moonshot.cn/v1` |
| 百川智能 | `https://api.baichuan-ai.com/v1` |
| 阶跃星辰 | `https://api.stepfun.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

> `mode` 可选 `balanced`（按权重/优先级均衡）等；`quotaAlert` 可配额度告警阈值（比例 `warnPct`/`critPct` 或绝对 `warnTokens`/`critTokens`、厂商余额 `vendorWarnCny`/`vendorCritCny`）。完整字段契约见 [`config-schema-contract.md`](./config-schema-contract.md)。

首次启动若 `config.json` 不存在，代理会**自动从 `config.example.json` 复制生成默认配置**并启动；默认含占位 Key，实际调用前请填入真实 Key。

---

## 功能详解

### 意图路由与 failover
请求到达后，代理按 `weight` / `priority` / `cost` 选出上游；命中 429 / 配额 / 限流类错误时，自动沿 failover 链切换备用模型。failover 只保留「当前配置确有 enabled 上游」的模型，避免切到无上游模型导致 502。

### 免费模型情报目录
内置 200+ 条免费 / 限额免费模型情报，来源聚合（厂商官方基线 + OpenRouter 实时目录 + LiteLLM 社区价目表 + 厂商免费页校验），每条带状态机（可用 / 限额 / 限免 / 待核实 / 已过期 / 已下架）、`verifiedAt` 核验时间、`expiresAt` 活动结束日、免费额度 `freeQuota`。工作台内可手动「刷新核验」。

### 额度告警与消耗分析（v0.12.x）
- 每模型剩余免费 Token = `freeQuota − 本机日志累计已用`；低于 `warnPct`（默认 20%）标 ⚠ 偏低，低于 `critPct`（默认 5%）或归零标 ⚠ 告急。
- DeepSeek / 硅基流动厂商账户余额低于阈值同样告警。
- 「额度消耗分析」面板：总调用 / Token / 成功率 / 429 率 / 平均延迟，按模型 Top8、按厂商、近 14 天每日趋势（零依赖 CSS 条形图）。

### 请求日志（SQLite）
每次中转落库 `proxy/logs.db`：上游 / 模型 / Token / 状态码 / 延迟 / 来源 IP。工作台「请求日志」页可筛选、分页、导出 CSV。`better-sqlite3` 不可用时自动降级（日志关闭、其余正常）。

### 速率限制
令牌桶（按 `upstream::clientIp`）+ token 维度窗口 + 全局兜底；超限返回 `429` + `Retry-After` + 结构化错误体。`rateLimit.sqlite:true` 时多实例共享 `free_api.db` 限流计数。

### 可观测性
`GET /health` 返回版本 / 在线 / 路由模式 / 限流 / 存储 / 日志状态；前端侧栏常驻健康徽标每 5s 轮询。容器 `Dockerfile` 内置 `HEALTHCHECK` 直连 `/health`。

---

## 隐私与安全

这是本项目最重要的设计原则：**你的数据只属于你。**

- **密钥只在本机**：所有上游 API Key 仅在 `proxy/config.json`，该文件已被 `.gitignore` 排除，**绝不会**被提交到 Git，也**绝不会**打进 Release 包（`.dockerignore` 同样排除）。
- **数据全本地**：请求日志、业务状态存本机 SQLite（`proxy/*.db`，gitignore），不上传任何服务器。
- **密钥不下发前端**：代理对 `/config.json`、`*.log` 等返回 `403` 拦截；SPA 只从代理拉取「已掩码」的配置视图。
- **默认本机监听**：代理默认 `127.0.0.1`，仅本机可访问。若要局域网 / 公网暴露，请自行评估风险并把 `host` 改为 `0.0.0.0`（或 `HOST=0.0.0.0`）。
- **访问密码（可选）**：首次打开工作台可设置「访问密码」，设置后管理与聊天接口需登录会话。默认 `accessPassword` 为空（本地放行模式）。

> ⚠️ 请把 `proxy/config.json` 当作机密文件保管。若曾把仓库推到公开位置，请到对应厂商**轮换 / 重置**相关 Key。

---

## 项目结构

```
free-API/
├── index.html              # SPA 入口
├── src/                    # 前端源码（main.js / app.js / modules / styles）
├── catalog/
│   └── catalog-embedded.js # 免费模型目录（嵌入，前端前置依赖）
├── proxy/
│   ├── proxy.js            # 零依赖本地代理：中转 + 静态托管 + 账号 + 引导
│   ├── db.js               # SQLite 请求日志层（better-sqlite3，缺失降级）
│   ├── stateStore.js       # SQLite 业务状态层（catalog/relay/freeModels）
│   ├── rateLimiter.js      # 速率限制（令牌桶 + 窗口 + 全局兜底）
│   ├── rateStore.js        # 限流桶 SQLite 持久化（多实例共享）
│   ├── quota.js            # 额度计算 / 厂商余额 / 消耗统计
│   ├── failover.js         # 跨模型 failover 链
│   ├── config.example.json # 配置模板（占位 Key，提交入库）
│   ├── config.json         # 运行配置（含真实 Key，gitignore，勿提交）
│   └── *.db / *.log        # 运行时生成，gitignore
├── vite.config.js          # Vite 生产构建
├── build.js                # 经典（esbuild IIFE）构建，供 jsdom 测试
├── Dockerfile / .dockerignore
├── deploy/free-api.service # systemd 单元
└── package.json
```

---

## 部署（Docker / systemd）

### Docker

```bash
docker build -t free-api-workbench .
docker run -d --name free-api -p 8787:8787 \
  -e HOST=0.0.0.0 \
  -v /path/to/your/config.json:/app/proxy/config.json \
  free-api-workbench
```

密钥仅在你挂载的 `config.json`，绝不进镜像。多实例共享限流：把多个容器的 `/app/proxy/free_api.db` 挂同一卷，并设 `rateLimit.sqlite:true`。

### systemd（Linux）

```bash
sudo useradd -m -s /usr/sbin/nologin freeapi
sudo cp deploy/free-api.service /etc/systemd/system/
sudo sed -i 's#/opt/free-api#你的部署目录#' /etc/systemd/system/free-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now free-api
```

### Release 完整运行包

打 `v*` tag 时 GitHub Actions 自动构建并发布**完整运行包**（含 SPA 构建产物 + proxy 运行时 + 原生依赖 `node_modules/` + 启动脚本）。解压后 `node proxy/proxy.js`（Windows 双击 `start.bat`）即可，访问 http://127.0.0.1:8787/。

> **原生模块 ABI 注意（Node 22 / ABI 127）**：`better-sqlite3` 为 C 原生绑定，Release 包内预编译二进制匹配「构建机 Windows + Node 22」。若你本机 Node 大版本不同，预编译 `.node` 无法加载，代理自动降级（日志关闭、转发/聊天正常）；此时在解压目录重跑 `npm install` 即可为本机重新编译。

---

## 常见问题 FAQ

**Q：必须启动代理吗？能直接打开 index.html 吗？**
A：必须启动代理。Vite 模块化后 `index.html` 以 ESM 加载，`file://` 下会被浏览器拦截。代理同时托管前端与 API。

**Q：我的 Key 会泄露吗？**
A：不会。Key 只在本地 `proxy/config.json`（gitignore），不下发前端、不进仓库、不打进 Release。代理对 `/config.json` 返回 403。

**Q：免费模型 429 了怎么办？**
A：代理自动 failover 到其它可用上游的同类型模型；无可用上游时优雅降级而非 502。

**Q：换 Node 大版本后日志功能没了？**
A：这是 `better-sqlite3` 原生模块 ABI 不匹配导致的自动降级，非故障。在目录重跑 `npm install` 重新编译即可恢复。

**Q：如何备份 / 迁移配置？**
A：工作台内「导出全部配置」下载 `tool-backup.json`；或直接复制本机 `proxy/config.json`。

---

## 许可证

[MIT](./LICENSE)。可自由使用、修改、再分发，作者不对使用后果承担责任。

---

## 版本路线

- **v0.12.2**：额度不足阈值告警 + 额度消耗分析面板 + failover 上游可达性过滤。
- **v0.12.1**：过期 / 下架治理（状态机 + 时效性）+ 排序下拉 / 玻璃态修复 + 隐私收敛（上传前）。
- **v0.12.0**：免费情报多源聚合（228 条）+ 每模型 Token 余额 + 厂商余额 + 页面驱动配额刷新。
- **v0.11.x**：可观测性（`/health` + 常驻健康徽标）、容器健康探活、隐私清理、file:// 兜底。
- **v0.10.0**：Vite 全模块化 + 多实例限流 SQLite 共享 + 首次启动引导 + Docker / systemd。
- **v0.9.0**：业务状态收口到代理 SQLite（路线 2）。
- **v0.8.0**：代理层速率限制（令牌桶 + 窗口 + 全局兜底 + 429）。
- **v0.7.0**：SQLite 请求日志 + 日志页。
- **v0.6.0**：构建优化（esbuild / Vite 模块化）+ CI Release 完整运行包。
- **v0.5.0**：demo → MVP（欢迎页接代理真实状态 + 双路线持久化）。

详见 [`CHANGELOG.md`](./CHANGELOG.md) 与 [`config-schema-contract.md`](./config-schema-contract.md)。
