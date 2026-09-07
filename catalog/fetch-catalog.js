/*
 * fetch-catalog.js —— Free API 免费/限额免费大模型目录抓取脚本（多源聚合 v2）
 *
 * 设计目标（v0.12.0）：来源「尽量全面」，按用户要求覆盖四类来源，全部 best-effort 容错：
 *   A) 厂商内部官方直连基线（CN_BASELINE，手工权威，主骨架，带 freeQuota 数值）
 *   B) OpenRouter /api/v1/models 实时聚合（最全的免费模型总目录）
 *   C) 社区维护价目表（LiteLLM model_prices_and_context_window.json，真实大型聚合源，best-effort）
 *   D) 厂商免费模型页 best-effort 抓取（如 SiliconFlow /v1/models 实连校验，用于把基线模型 status 提升为「已核实」）
 *
 * 字段说明：
 *   type: free   = 完全免费（限流）
 *         quota  = 限额免费（每日/每月/体验包额度）
 *         trial  = 限免 / 新用户赠送额度
 *         paid   = 付费（不计入免费余额）
 *         expired= 已过期/已下架（由 diff 流程产生，默认关闭，可手动开启）
 *   freeQuota:        数值，模型公开免费额度（tokens）；null 表示按厂商限流/无限额（不计入余额分母）
 *   freeQuotaPeriod:  额度周期，如 '90天' / '每日' / '每月'
 *   quota:           官方公布的免费额度/限额说明（公开信息，标"以官方为准"）
 *   status: 可用 | 限额 | 限免 | 待核实 | 已过期 | 已下架
 *   verifiedAt:      ISO 日期，最近一次被 live source（OpenRouter/LiteLLM/厂商实连）确认存在的日期
 *   expiresAt:       ISO 日期，已知固定截止日期（活动/限免），null 表示无固定截止日期
 *   source / sourceUrl: 该条记录由哪一类来源产出
 *   stale:           Boolean，由 UI 根据 verifiedAt 与 STALE_DAYS 计算（>7天未核验则 true）
 *
 * 合并优先级（同 id 取更优字段，不覆盖非空）：基线(A) → OpenRouter(B) → 社区(C，仅补充新 id）
 * 过期/下架处理：
 *   - 旧目录有、本次抓取缺失 → 转 expired 类型，status=已下架（保留 enabled 覆盖，可手动开启）
 *   - 已知明确结束日期的活动模型 → type=expired, status=已过期
 *   - 仅基线录入、无 live source 交叉验证 → status=待核实
 * 时效性保障：
 *   - 每次刷新时，对所有来自 live source 的模型更新 verifiedAt=TODAY
 *   - 前端对 verifiedAt > STALE_DAYS 的模型显示「信息较旧」提示
 *   - 每日 2:00（页面开启时）自动刷新，用户也可手动「刷新核验」
 *
 * 运行：本机有网环境 `node fetch-catalog.js`（也可由代理 /v1/catalog/refresh 派生调用）
 * 输出：同目录 models-catalog.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'models-catalog.json');
const OR_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const SF_MODELS_URL = 'https://api.siliconflow.cn/v1/models'; // best-effort 实连校验
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_TS = Date.now();
const FETCH_TIMEOUT = 9000; // 单源网络超时（ms），避免刷新卡死
const STALE_DAYS = 7;       // 超过 N 天未重新核验 → UI 提示「信息较旧」

// 已知已下架/转收费的模型 id（手工维护，用于把基线中残留的老条目直接标为 expired）
const KNOWN_DISCONTINUED = new Set([
  'sf/glm-4-9b-chat' // 硅基流动 2026-09 实连：旧 glm-4-9b-chat 已 403 禁用
]);

// 已知有明确结束日期的活动/限免（ISO 日期；其余 model 的 expiresAt 留空，表示无固定截止日期）
const KNOWN_EXPIRES = {
  // 示例：'some/id': '2026-10-01'
};

// 状态机：status 描述「当前情报状态」，type 描述「免费策略类型」
const STATUS = {
  AVAILABLE: '可用',   // 来源明确且近期存在
  QUOTA:     '限额',   // 限额免费（有额度包）
  TRIAL:     '限免',   // 限免 / 新用户赠送
  UNVERIFIED:'待核实', // 基线录入，但暂无 live source 交叉验证
  EXPIRED:   '已过期', // 已知结束或超过保质期
  DELISTED:  '已下架'  // 本次刷新在所有 live source 中消失
};

// ---------------- A) 国内厂商官方直连基线（手工权威，主骨架） ----------------
// 全部标注 status=待核实（除经厂商页实连校验提升为已核实），需以官网公告为准。模型名可能漂移。
// freeQuota 仅在「厂商公开具体 token 数额」时填数值（如体验包 100万tokens/90天）；纯限流免费填 null。
const CN_BASELINE = [
  // 智谱 AI
  { vendor: '智谱 AI', vendorSite: 'https://open.bigmodel.cn', applyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    list: [
      { id: 'zhipu/glm-4-flash', name: 'GLM-4-Flash', type: 'free', quota: '完全免费（以官方为准）', modality: ['语言', '对话'], note: '智谱开放平台免费模型' },
      { id: 'zhipu/glm-4v-flash', name: 'GLM-4V-Flash', type: 'free', quota: '完全免费（以官方为准）', modality: ['语言', '图像', '对话'], note: '支持图像理解，免费' },
      { id: 'zhipu/glm-4-plus', name: 'GLM-4-Plus', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '高级模型，含免费额度' },
      { id: 'zhipu/glm-z1-flash', name: 'GLM-Z1-Flash', type: 'free', quota: '完全免费（以官方为准）', modality: ['语言', '推理'], note: '推理模型，免费' },
      { id: 'zhipu/glm-4.5-air', name: 'GLM-4.5-Air', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '轻量高速，待核实' },
      { id: 'zhipu/glm-4.6', name: 'GLM-4.6', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '旗舰，待核实' }
    ] },
  // 硅基流动 SiliconFlow（2026-09-04 实连验证：免费层为永久 ¥0，限流 1000RPM/50K TPM，超限 429 不扣费）
  { vendor: '硅基流动', vendorSite: 'https://siliconflow.cn', applyUrl: 'https://cloud.siliconflow.cn/i/llm',
    list: [
      { id: 'sf/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B-Instruct', type: 'free', quota: '永久免费层 ¥0（限流 1000RPM/50K TPM，超限 429 不扣费）', modality: ['语言', '代码'], note: '实连验证 200，上游 Qwen/Qwen2.5-7B-Instruct' },
      { id: 'sf/Qwen3-8B', name: 'Qwen3-8B', type: 'free', quota: '永久免费层 ¥0（限流 1000RPM/50K TPM，超限 429 不扣费）', modality: ['语言', '代码'], note: '实连验证 200，上游 Qwen/Qwen3-8B' },
      { id: 'sf/DeepSeek-R1-0528-Qwen3-8B', name: 'DeepSeek-R1-0528-Qwen3-8B', type: 'free', quota: '永久免费层 ¥0（限流 1000RPM/50K TPM）', modality: ['推理', '语言'], note: '实连验证 200，上游 deepseek-ai/DeepSeek-R1-0528-Qwen3-8B' },
      { id: 'sf/GLM-Z1-9B-0414', name: 'GLM-Z1-9B-0414', type: 'free', quota: '永久免费层 ¥0（限流 1000RPM/50K TPM）', modality: ['推理', '语言'], note: '实连验证 200，上游 THUDM/GLM-Z1-9B-0414' },
      { id: 'sf/GLM-4-9B-0414', name: 'GLM-4-9B-0414', type: 'free', quota: '永久免费层 ¥0（旧 glm-4-9b-chat 免费层已 403 禁用）', modality: ['语言', '对话'], note: '实连验证 200，上游 THUDM/GLM-4-9B-0414' },
      { id: 'sf/Nex-N2-Pro', name: 'Nex-N2-Pro', type: 'free', quota: '限时免费 ¥0（2026-06 起开放，可能调整）', modality: ['语言', '代码', 'Agent'], note: '实连验证 200，MoE 397B/17B 激活，限免可能随时结束' },
      { id: 'sf/tencent-Hunyuan-MT-7B', name: '腾讯混元 Hunyuan-MT-7B', type: 'free', quota: '永久免费层 ¥0（限流 1000RPM/50K TPM）', modality: ['翻译', '语言'], note: '实连验证 200，上游 tencent/Hunyuan-MT-7B' },
      { id: 'sf/DeepSeek-V3', name: 'DeepSeek-V3', type: 'paid', quota: '付费 2/8 元每百万 tokens（非免费层）', modality: ['语言', '代码'], note: '硅基流动上 DeepSeek-V3 为付费；免费蒸馏见 sf/DeepSeek-R1-0528-Qwen3-8B' },
      { id: 'sf/bge-m3', name: 'BGE-M3', type: 'free', quota: '永久免费层 ¥0（嵌入/重排；Pro/ 为付费加速版）', modality: ['嵌入'], note: '嵌入模型免费，勿放入 chat 路由' }
    ] },
  // 腾讯混元 TokenHub（2026-09-04 实连验证：免费体验包 100万tokens/90天）
  { vendor: '腾讯混元 TokenHub', vendorSite: 'https://cloud.tencent.com/product/tokenhub', applyUrl: 'https://console.cloud.tencent.com/tokenhub',
    list: [
      { id: 'th/hy-mt2-lite', name: '混元 HY-MT2-Lite', type: 'quota', quota: '免费体验包 100万tokens/90天', modality: ['翻译', '语言'], note: '实连验证 200，限额免费优先', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/hy-mt2-plus', name: '混元 HY-MT2-Plus', type: 'quota', quota: '免费体验包/超低单价 0.5/2 元每百万', modality: ['翻译', '语言'], note: '实连验证 200，翻译增强', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/deepseek-v4-flash', name: 'DeepSeek-V4-Flash', type: 'quota', quota: '免费体验包 100万tokens/90天 + 极低价 0.05/1.5/3 元每百万', modality: ['语言', '代码'], note: '实连验证 200，1M 长上下文', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/deepseek-v4-pro', name: 'DeepSeek-V4-Pro', type: 'quota', quota: '免费体验包 100万tokens/90天 + 4.5/13.5/27 元每百万', modality: ['语言', '推理'], note: '实连验证 200，旗舰', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/glm-5.3-flash', name: 'GLM-5.3-Flash', type: 'quota', quota: '极低价 0.8/2.8/0.23 元每百万（限时折扣至 2026-09-10 五折）', modality: ['语言', '多模态'], note: '实连验证 200，GLM-5 原生多模态', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/glm-5.3', name: 'GLM-5.3', type: 'quota', quota: '免费体验包 + 8/28/2 元每百万', modality: ['语言', '多模态'], note: '实连验证 200，强多模态', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/hy3', name: '混元 Hy3', type: 'quota', quota: '免费体验包 100万tokens/90天', modality: ['语言', '对话'], note: '实连验证 200，限额免费通用', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'th/kimi-k3', name: 'Kimi-K3', type: 'quota', quota: '免费体验包/20/100 元每百万', modality: ['语言', '长上下文'], note: '实连验证 200，1M 长上下文', freeQuota: 1000000, freeQuotaPeriod: '90天' }
    ] },
  // 阿里百炼
  { vendor: '阿里百炼', vendorSite: 'https://bailian.console.aliyun.com', applyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api',
    list: [
      { id: 'ali/qwen-plus', name: 'Qwen-Plus', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '百炼免费额度模型' },
      { id: 'ali/qwen-max', name: 'Qwen-Max', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '旗舰模型，含免费额度' },
      { id: 'ali/qwen-turbo', name: 'Qwen-Turbo', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '轻量高速，含免费额度' },
      { id: 'ali/qwen-long', name: 'Qwen-Long', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['长文本'], note: '长上下文模型' },
      { id: 'ali/qwen-vl-max', name: 'Qwen-VL-Max', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['图像', '对话'], note: '视觉语言模型' },
      { id: 'ali/qwen-flash', name: 'Qwen-Flash', type: 'quota', quota: '新人免费额度 100万tokens/90天', modality: ['语言', '对话'], note: '轻量模型，百炼新人免费额度', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'ali/qwen3.8-flash', name: 'Qwen3.8-Flash', type: 'quota', quota: '新人免费额度 100万tokens/90天（百万上下文+多模态）', modality: ['语言', '图像', '多模态'], note: '百万上下文多模态，百炼新人免费额度', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'ali/qwen3.7-flash', name: 'Qwen3.7-Flash', type: 'quota', quota: '新人免费额度 100万tokens/90天（多模态）', modality: ['语言', '图像', '多模态'], note: '多模态轻量，百炼新人免费额度', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'ali/qwen3.5-flash', name: 'Qwen3.5-Flash', type: 'quota', quota: '新人免费额度 100万tokens/90天', modality: ['语言', '对话'], note: '轻量模型，百炼新人免费额度', freeQuota: 1000000, freeQuotaPeriod: '90天' },
      { id: 'ali/qwen3-max', name: 'Qwen3-Max', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: 'Qwen3 旗舰，待核实' },
      { id: 'ali/qwen3-plus', name: 'Qwen3-Plus', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: 'Qwen3 增强，待核实' },
      { id: 'ali/qwen-omni', name: 'Qwen-Omni', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '音频', '多模态'], note: '全模态，待核实' }
    ] },
  // DeepSeek 官方
  { vendor: 'DeepSeek', vendorSite: 'https://platform.deepseek.com', applyUrl: 'https://platform.deepseek.com/api_keys',
    list: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek-V3 (官方)', type: 'quota', quota: '价格极低 + 有免费额度（以官方为准）', modality: ['语言', '代码', '对话'], note: '官方直连，需申请 key' },
      { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek-R1 (官方)', type: 'quota', quota: '价格极低 + 有免费额度（以官方为准）', modality: ['语言', '推理'], note: '推理模型，官方直连' }
    ] },
  // 腾讯混元
  { vendor: '腾讯混元', vendorSite: 'https://cloud.tencent.com/product/hunyuan', applyUrl: 'https://console.cloud.tencent.com/hunyuan',
    list: [
      { id: 'tencent/hunyuan-lite', name: 'Hunyuan-Lite', type: 'free', quota: '完全免费（以官方为准）', modality: ['语言', '对话'], note: '混元免费模型' },
      { id: 'tencent/hunyuan-standard', name: 'Hunyuan-Standard', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '标准模型，含免费额度' },
      { id: 'tencent/hunyuan-turbo', name: 'Hunyuan-Turbo', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '高速模型，含免费额度' },
      { id: 'tencent/hunyuan-a13b', name: 'Hunyuan-A13B', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: 'MoE，待核实' }
    ] },
  // 字节豆包
  { vendor: '字节豆包', vendorSite: 'https://console.volcengine.com/ark', applyUrl: 'https://console.volcengine.com/ark/region/ark/cn-beijing/apiKey',
    list: [
      { id: 'bytedance/doubao-pro', name: 'Doubao-Pro', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '火山方舟，含免费额度' },
      { id: 'bytedance/doubao-lite', name: 'Doubao-Lite', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '轻量模型，含免费额度' },
      { id: 'bytedance/doubao-seed-1.6-flash', name: 'Doubao-Seed-1.6-Flash', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '代码'], note: 'Seed 系列，待核实' },
      { id: 'bytedance/doubao-vision', name: 'Doubao-Vision', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['图像', '对话'], note: '视觉，待核实' }
    ] },
  // 百度文心
  { vendor: '百度文心', vendorSite: 'https://cloud.baidu.com/product/wenxinworkshop', applyUrl: 'https://console.bce.baidu.com/ai/#/ai/llm/app/list',
    list: [
      { id: 'baidu/ernie-lite', name: 'ERNIE-Lite', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '文心轻量，含免费额度' },
      { id: 'baidu/ernie-4.0', name: 'ERNIE-4.0', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '旗舰，含免费额度' },
      { id: 'baidu/ernie-4.5', name: 'ERNIE-4.5', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '多模态'], note: '4.5 旗舰，待核实' },
      { id: 'baidu/ernie-speed', name: 'ERNIE-Speed', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '高速，待核实' }
    ] },
  // MiniMax
  { vendor: 'MiniMax', vendorSite: 'https://platform.minimax.io', applyUrl: 'https://platform.minimax.io/user-center/basic-information',
    list: [
      { id: 'minimax/abab6.5s-chat', name: 'ABAB6.5S-Chat', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '含免费额度' },
      { id: 'minimax/abab6.5t-chat', name: 'ABAB6.5T-Chat', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '含免费额度' },
      { id: 'minimax/abab7-chat', name: 'ABAB7-Chat', type: 'trial', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '7 代，待核实' }
    ] },
  // Moonshot / Kimi
  { vendor: 'Moonshot', vendorSite: 'https://platform.moonshot.cn', applyUrl: 'https://platform.moonshot.cn/console/api-keys',
    list: [
      { id: 'moonshot/moonshot-v1-8k', name: 'Moonshot-V1-8K', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '长文本', '对话'], note: 'Kimi，含免费额度' },
      { id: 'moonshot/moonshot-v1-32k', name: 'Moonshot-V1-32K', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '长文本', '对话'], note: '长上下文，待核实' },
      { id: 'moonshot/moonshot-v1-128k', name: 'Moonshot-V1-128K', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '长文本', '对话'], note: '超长上下文，待核实' }
    ] },
  // 阶跃星辰
  { vendor: '阶跃星辰', vendorSite: 'https://www.stepfun.com', applyUrl: 'https://platform.stepfun.com/',
    list: [
      { id: 'stepfun/step-1v', name: 'Step-1V', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['图像', '对话'], note: '多模态，含免费额度' },
      { id: 'stepfun/step-2', name: 'Step-2', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '旗舰，待核实' },
      { id: 'stepfun/step-1.5v', name: 'Step-1.5V', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['图像', '对话'], note: '视觉增强，待核实' }
    ] },
  // 百川
  { vendor: '百川智能', vendorSite: 'https://www.baichuan-ai.com', applyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    list: [
      { id: 'baichuan/Baichuan2-53B', name: 'Baichuan2-53B', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '含免费额度' },
      { id: 'baichuan/Baichuan4', name: 'Baichuan4', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '4 代，待核实' }
    ] },
  // 零一万物
  { vendor: '零一万物', vendorSite: 'https://www.01.ai', applyUrl: 'https://platform.01.ai/',
    list: [
      { id: '01ai/yi-large', name: 'Yi-Large', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '含免费额度' },
      { id: '01ai/yi-large-turbo', name: 'Yi-Large-Turbo', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: 'Turbo，待核实' }
    ] },
  // 商汤 日日新（新增厂商）
  { vendor: '商汤 日日新', vendorSite: 'https://www.sensetime.com', applyUrl: 'https://www.sensetime.com/cn',
    list: [
      { id: 'sensetime/sensechat', name: 'SenseChat', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话'], note: '日日新，待核实' },
      { id: 'sensetime/sensechat-5', name: 'SenseChat-5', type: 'quota', quota: '有免费额度（以官方为准）', modality: ['语言', '对话', '代码'], note: '5 代旗舰，待核实' }
    ] },
  // 面壁 MiniCPM（新增厂商，开源免费）
  { vendor: '面壁 MiniCPM', vendorSite: 'https://github.com/OpenBMB/MiniCPM', applyUrl: 'https://github.com/OpenBMB/MiniCPM',
    list: [
      { id: 'minicpm/minicpm-2.6', name: 'MiniCPM-2.6', type: 'free', quota: '开源免费（自部署，以官方为准）', modality: ['语言', '图像', '多模态'], note: '端侧开源模型，待核实' }
    ] }
];

// ---------------- 网络工具（带超时，best-effort） ----------------
async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: headers || { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------- B) OpenRouter 抓取 ----------------
const VENDOR_MAP = {
  deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google',
  'meta-llama': 'Meta', llama: 'Meta', mistralai: 'Mistral', 'mistral': 'Mistral',
  qwen: '阿里通义', qwenlm: '阿里通义', moonshotai: 'Moonshot', 'x-ai': 'xAI',
  'nousresearch': 'Nous', microsoft: 'Microsoft', cohere: 'Cohere', perplexity: 'Perplexity',
  thudm: '智谱', google: 'Google', 'ai21': 'AI21', 'amazon': 'Amazon', 'nvidia': 'NVIDIA',
  siliconflow: '硅基流动', sf: '硅基流动', zhipu: '智谱', 'zhipuai': '智谱',
  'tencent': '腾讯', 'alibaba': '阿里通义', 'minimax': 'MiniMax', '01ai': '零一万物',
  'stepfun': '阶跃星辰', 'baichuan': '百川智能', 'baidu': '百度文心', 'bytedance': '字节豆包',
  'sensetime': '商汤', 'minicpm': '面壁'
};

function vendorFromId(id) {
  const head = String(id || '').split('/')[0].toLowerCase();
  return VENDOR_MAP[head] || (head ? head.charAt(0).toUpperCase() + head.slice(1) : '未知');
}

function parseOpenRouter(data) {
  const out = [];
  for (const it of (data && data.data) || []) {
    const p = parseFloat(it.pricing && it.pricing.prompt);
    const c = parseFloat(it.pricing && it.pricing.completion);
    const isFree = (p === 0 && c === 0) || /:free$/i.test(it.id || '');
    if (!isFree) continue;
    const mods = (it.architecture && it.architecture.input_modalities) || ['语言'];
    const zhMod = mods.map(function (m) {
      if (/text/i.test(m)) return '语言';
      if (/image/i.test(m)) return '图像';
      if (/audio/i.test(m)) return '音频';
      if (/video/i.test(m)) return '视频';
      return m;
    });
    out.push({
      id: it.id,
      name: it.name || it.id,
      vendor: vendorFromId(it.id),
      vendorSite: 'https://openrouter.ai',
      applyUrl: 'https://openrouter.ai/',
      type: 'free',
      quota: 'OpenRouter 免费层（限流，以官方为准）',
      modality: Array.from(new Set(zhMod)),
      contextWindow: it.context_length ? String(it.context_length) : '',
      freeQuota: null,
      freeQuotaPeriod: null,
      status: STATUS.AVAILABLE,
      verifiedAt: TODAY,
      expiresAt: null,
      source: 'OpenRouter',
      sourceUrl: 'https://openrouter.ai/models',
      note: '经 OpenRouter 实时聚合确认存在，需注册获取 key'
    });
  }
  return out;
}

// ---------------- C) 社区维护价目表（LiteLLM，best-effort） ----------------
// 真实大型聚合源：input_cost_per_token / output_cost_per_token 同时为 0 → 免费。
function parseLiteLLM(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  Object.keys(data).forEach(function (id) {
    const m = data[id];
    if (!m || typeof m !== 'object') return;
    const ip = parseFloat(m.input_cost_per_token);
    const op = parseFloat(m.output_cost_per_token);
    if (!(ip === 0 && op === 0)) return; // 仅收录完全免费
    if (/^sample-|fake|jest|test/i.test(id)) return;
    const ctx = m.max_input_tokens || m.max_tokens || '';
    out.push({
      id: id,
      name: id,
      vendor: vendorFromId(id),
      vendorSite: 'https://openrouter.ai',
      applyUrl: 'https://openrouter.ai/',
      type: 'free',
      quota: 'LiteLLM 价目表收录：免费层（限流，以官方为准）',
      modality: ['语言'],
      contextWindow: ctx ? String(ctx) : '',
      freeQuota: null,
      freeQuotaPeriod: null,
      status: STATUS.AVAILABLE,
      verifiedAt: TODAY,
      expiresAt: null,
      source: 'LiteLLM 社区价目表',
      sourceUrl: 'https://github.com/BerriAI/litellm',
      note: '经 LiteLLM model_prices 社区源确认存在（免费），需注册获取 key'
    });
  });
  return out;
}

// ---------------- D) 厂商免费模型页 best-effort 校验（SiliconFlow /v1/models） ----------------
// 返回「被实连确认存在的基线模型 id」集合，用于把 status 提升为「已核实」。不新增数据。
async function scrapeVendorPages() {
  const confirmed = new Set();
  try {
    const headers = { Accept: 'application/json' };
    if (process.env.SILICONFLOW_API_KEY) headers.Authorization = 'Bearer ' + process.env.SILICONFLOW_API_KEY;
    const j = await fetchJson(SF_MODELS_URL, headers);
    const ids = (j && Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []))
      .map(function (x) { return String((x && x.id) || '').toLowerCase(); })
      .filter(Boolean);
    if (ids.length) {
      // SiliconFlow 模型 id 形如 <model>（无 sf/ 前缀）；基线用 sf/<model>，统一匹配
      ids.forEach(function (i) {
        confirmed.add('sf/' + i);
        confirmed.add(i);
      });
    }
  } catch (e) { /* best-effort，失败忽略 */ }
  return confirmed;
}

// ---------------- 基线模型 ----------------
function baselineModels() {
  const out = [];
  for (const grp of CN_BASELINE) {
    for (const m of grp.list) {
      const isDiscontinued = KNOWN_DISCONTINUED.has(m.id);
      let type = m.type;
      // 基线仅由手工维护，尚未被 live source（OpenRouter/LiteLLM/厂商实连）交叉验证前统一为「待核实」
      let status = STATUS.UNVERIFIED;
      if (isDiscontinued) { type = 'expired'; status = STATUS.EXPIRED; }
      out.push({
        id: m.id,
        name: m.name,
        vendor: grp.vendor,
        vendorSite: grp.vendorSite,
        applyUrl: grp.applyUrl,
        type: type,
        quota: m.quota,
        modality: m.modality,
        contextWindow: '',
        freeQuota: (typeof m.freeQuota === 'number') ? m.freeQuota : null,
        freeQuotaPeriod: m.freeQuotaPeriod || null,
        status: status,
        verifiedAt: isDiscontinued ? TODAY : TODAY, // 基线本身视为今日录入，后续由 live source 刷新
        expiresAt: KNOWN_EXPIRES[m.id] || null,
        source: '厂商内部基线(手工权威)',
        sourceUrl: grp.vendorSite,
        note: isDiscontinued ? (m.note + '；已标记为已下架/已过期') : m.note
      });
    }
  }
  return out;
}

// 合并：同 id 取更优字段，不覆盖非空/非默认
function mergeInto(map, m) {
  if (!m || !m.id) return;
  const ex = map.get(m.id);
  if (!ex) { map.set(m.id, m); return; }
  // 字段优先级：已有非空则保留，否则取新值；freeQuota 取非 null 者
  ['name', 'vendor', 'vendorSite', 'applyUrl', 'quota', 'modality', 'contextWindow', 'note', 'source', 'sourceUrl']
    .forEach(function (k) {
      if (ex[k] == null || ex[k] === '') { if (m[k] != null) ex[k] = m[k]; }
    });
  if (ex.freeQuota == null && m.freeQuota != null) { ex.freeQuota = m.freeQuota; ex.freeQuotaPeriod = m.freeQuotaPeriod || ex.freeQuotaPeriod; }
  if (ex.type === 'free' || ex.type == null) { if (m.type) ex.type = m.type; }
  // live source（OpenRouter/LiteLLM/厂商实连）确认存在 → 刷新 verifiedAt + 提升状态
  if (m.status === STATUS.AVAILABLE) {
    ex.status = STATUS.AVAILABLE;
    ex.verifiedAt = TODAY;
  }
  // 新 source 带 expiresAt 时覆盖旧值（截止日期可能调整）
  if (m.expiresAt) ex.expiresAt = m.expiresAt;
}

async function run() {
  let orOk = false, commOk = false, scrapeOk = false;
  const tasks = await Promise.allSettled([
    fetchJson(OR_URL).then(parseOpenRouter).then(function (a) { return a; }).catch(function () { return []; }),
    fetchJson(LITELLM_URL).then(parseLiteLLM).catch(function () { return []; }),
    scrapeVendorPages().catch(function () { return new Set(); })
  ]);
  let orModels = (tasks[0].status === 'fulfilled') ? tasks[0].value : [];
  if (orModels.length) orOk = true;
  let commModels = (tasks[1].status === 'fulfilled') ? tasks[1].value : [];
  if (commModels.length) commOk = true;
  const confirmed = (tasks[2].status === 'fulfilled') ? tasks[2].value : new Set();
  if (confirmed.size) scrapeOk = true;

  if (orOk) console.log('[OpenRouter] 抓取成功，免费模型 ' + orModels.length + ' 条');
  else console.log('[OpenRouter] 抓取失败（best-effort），仅用基线');
  if (commOk) console.log('[LiteLLM] 社区价目表收录免费模型 ' + commModels.length + ' 条');
  else console.log('[LiteLLM] 社区源未可达（best-effort），跳过');
  if (scrapeOk) console.log('[厂商页] SiliconFlow 实连校验确认 ' + confirmed.size + ' 个模型 id');

  const base = baselineModels();
  const map = new Map();
  base.forEach(function (m) { map.set(m.id, m); });      // A 主骨架优先
  orModels.forEach(function (m) { mergeInto(map, m); });  // B 实时覆盖同 id
  commModels.forEach(function (m) {                       // C 仅补充新 id（不覆盖权威基线）
    if (!map.has(m.id)) map.set(m.id, m);
  });
  const all = Array.from(map.values());

  // D 实连校验：基线/合并模型中 id 被厂商页确认 → status 提升为可用，并刷新 verifiedAt
  all.forEach(function (m) {
    if (confirmed.has(m.id) || confirmed.has(m.id.toLowerCase())) {
      m.status = STATUS.AVAILABLE;
      m.verifiedAt = TODAY;
    }
  });

  // diff -> 下架/过期：旧目录有、本次抓取没有的模型，移入「过期」类型（保留信息、默认关闭、可手动开启）
  let oldMap = {};
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    (old.models || []).forEach(function (m) { if (m && m.id) oldMap[m.id] = m; });
  } catch (e) { /* 首次运行无旧文件 */ }
  const newIds = new Set(all.map(function (m) { return m.id; }));
  const expiredAdds = [];
  for (const id in oldMap) {
    if (!newIds.has(id)) {
      const old = oldMap[id];
      if (old.type === 'expired') { expiredAdds.push(old); continue; } // 已过期且仍缺失：保留原记录（含用户手动开启）
      const ex = Object.assign({}, old);
      ex.type = 'expired';
      ex.enabled = false;
      ex.status = STATUS.DELISTED;
      ex.verifiedAt = TODAY;
      ex.note = (old.note ? old.note + '；' : '') + '已于 ' + TODAY + ' 在来源中消失或转为收费，已移入「过期/下架」（可手动开启）';
      expiredAdds.push(ex);
    }
  }

  // 已知固定截止日期的活动模型：若 today > expiresAt，则标记为已过期
  all.forEach(function (m) {
    if (m.expiresAt && m.expiresAt < TODAY && m.type !== 'expired') {
      m.type = 'expired';
      m.status = STATUS.EXPIRED;
      m.enabled = false;
      m.note = (m.note ? m.note + '；' : '') + '已知免费活动已于 ' + m.expiresAt + ' 结束，已标记为已过期';
    }
  });

  all.push.apply(all, expiredAdds);

  // 默认启用：非过期模型默认开启，过期默认关闭（前端可按 id 覆盖）
  all.forEach(function (m) { if (m.enabled === undefined) m.enabled = (m.type !== 'expired'); });

  // 按 vendor 排序，稳定输出
  all.sort(function (a, b) { return (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0); });

  const sources = ['厂商内部基线(手工权威)'];
  if (orOk) sources.push('OpenRouter /api/v1/models');
  if (commOk) sources.push('LiteLLM 社区价目表');
  if (scrapeOk) sources.push('SiliconFlow /v1/models 实连校验');

  const catalog = {
    version: 2,
    updatedAt: TODAY,
    sources: sources,
    note: '本目录为情报数据：标记「免费/限额/限免」指厂商提供免费层或免费额度，模型名与额度会漂移，请以官网公告为准。实际调用需自行申请 API key。带 freeQuota 数值的模型支持「每模型 token 余额」统计。',
    models: all
  };

  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2), 'utf8');
  console.log('[输出] ' + OUT);
  console.log('[总计] ' + all.length + ' 条模型（基线 ' + base.length +
    ' / OpenRouter ' + orModels.length + ' / 社区 ' + commModels.length +
    ' / 过期 ' + expiredAdds.length + '）');

  // 同步回写内嵌目录（提交进仓库，作为默认离线视图的数据源；proxy 在线刷新会覆盖）
  // 修复：此前 fetch-catalog.js 只写 models-catalog.json，未回写 embedded，导致默认视图停留在旧快照。
  const EMBED_FILE = path.join(__dirname, 'catalog-embedded.js');
  const embedModels = all.map(function (m) {
    return {
      id: m.id, name: m.name, vendor: m.vendor, vendorSite: m.vendorSite,
      applyUrl: m.applyUrl, type: m.type, quota: m.quota, modality: m.modality,
      contextWindow: m.contextWindow || '', status: m.status, verifiedAt: m.verifiedAt,
      expiresAt: m.expiresAt || null,
      source: m.source, sourceUrl: m.sourceUrl, note: m.note,
      enabled: m.enabled !== false,
      freeQuota: m.freeQuota != null ? m.freeQuota : null,
      freeQuotaPeriod: m.freeQuotaPeriod || null
    };
  });
  const embedCode = '// 自动生成：由 models-catalog.json 生成，请勿手改。重新生成请跑 fetch-catalog.js\n' +
    'window.EMBEDDED_CATALOG=' + JSON.stringify(embedModels) + ';\n';
  fs.writeFileSync(EMBED_FILE, embedCode, 'utf8');
  console.log('[内嵌] 已同步 ' + embedModels.length + ' 条到 catalog-embedded.js（默认离线视图数据源）');
}

run().catch(function (e) { console.error('FATAL', e); process.exit(1); });
