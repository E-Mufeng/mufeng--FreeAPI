'use strict';
/*
 * proxy/failover.js —— 模型映射 / 429 限流自动 failover
 *
 * 设计：
 *   1) 用户可配置 modelMapping：逻辑模型 -> [首选真实模型, 备用1, 备用2...]
 *      请求 "gpt-3.5-turbo" 会按顺序尝试映射链里的真实模型。
 *   2) 未配置映射时，按目录元数据自动推断能力相近的备用模型（同 cap/tier、同对话能力、
 *      优先 free/可用状态）。
 *   3) 仅当上游返回 429 / quota / rate limit 等"可重试"错误时才触发 failover，
 *      401/403/500 等配置/服务端错误不隐藏，避免浪费其他 key。
 */

const FAILOVER_MAX = 4; // 包括原模型在内最多尝试几个模型

// 常见免费/限额模型的能力近似分组（兜底， catalog 元数据缺失时启用）
const DEFAULT_GROUPS = {
  'light-chat': [
    'sf/Qwen2.5-7B-Instruct', 'sf/Qwen2.5-14B-Instruct', 'th/Qwen2.5-7B-Instruct',
    'zhipu/glm-4-flash', 'zhipu/glm-4-9b-chat', 'alibaba/qwen-turbo',
    'bytedance/doubao-lite', 'moonshot/kimi-k2-moonlight', 'baichuan/Baichuan2-Turbo',
    'openrouter/google/gemini-flash-1.5', 'openrouter/meta-llama/llama-3.1-8b-instruct'
  ],
  'heavy-chat': [
    'sf/deepseek-ai/DeepSeek-V3', 'sf/deepseek-ai/DeepSeek-R1',
    'alibaba/qwen-plus', 'alibaba/qwen-max', 'th/DeepSeek-R1',
    'zhipu/glm-4-plus', 'zhipu/glm-4-air', 'bytedance/doubao-pro',
    'openrouter/google/gemini-pro-1.5', 'openrouter/anthropic/claude-3.5-sonnet'
  ],
  'vision': [
    'zhipu/glm-4v-flash', 'zhipu/glm-4v-plus', 'alibaba/qwen-vl-plus',
    'openrouter/google/gemini-flash-1.5-vision'
  ]
};

// 哪些错误码/错误体应触发 failover
function isRetryableError(statusCode, bodyText) {
  if (statusCode === 429) return true;
  if (!bodyText) return false;
  const t = String(bodyText).toLowerCase();
  return /rate.limit|quota|too many requests|insufficient_quota|insufficient quota|exceeded|throttl|limit reached|请求过于频繁/.test(t);
}

// 从目录里取模型元数据；metaFn(modelId) 应返回 { cap, tier, type }
function modelCap(modelId, catalogModels, metaFn) {
  if (typeof metaFn === 'function') {
    try { const m = metaFn(modelId); if (m && m.cap) return m.cap; } catch (e) {}
  }
  const m = (catalogModels || []).find(function (x) { return x.id === modelId; }) || {};
  const type = m.type || 'quota';
  let ctx = 0;
  try { ctx = parseInt(String(m.contextWindow || '0').replace(/[^0-9]/g, ''), 10) || 0; } catch (e) {}
  let cap = 1;
  if (type !== 'free') cap = 2;
  if (ctx >= 64000) cap = 3;
  if ((m.modality || []).indexOf('推理') >= 0) cap = Math.max(cap, 3);
  return cap;
}

function modelStatus(modelId, catalogModels) {
  const m = (catalogModels || []).find(function (x) { return x.id === modelId; }) || {};
  const s = m.status || m.type || 'quota';
  // 可用性排序权重：已验证/可用 > 限额/限免 > 待核实 > 过期/下架
  if (s === '可用' || s === 'available' || m.type === 'free') return 3;
  if (s === '限额' || s === 'quota' || s === '限免' || s === 'trial') return 2;
  if (s === '待核实' || s === 'unverified') return 1;
  return 0;
}

function modelGroupHint(modelId, catalogModels) {
  const m = (catalogModels || []).find(function (x) { return x.id === modelId; }) || {};
  const mods = (m.modality || []);
  if (mods.indexOf('图像理解') >= 0 || mods.indexOf('vision') >= 0) return 'vision';
  return modelCap(modelId, catalogModels) >= 3 ? 'heavy-chat' : 'light-chat';
}

// 去掉 modelId 自身，并去重
function uniqueWithoutSelf(list, self) {
  const out = [];
  const seen = new Set([self]);
  for (const id of list) {
    const key = String(id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

// 自动推断备用链
function autoFallbackChain(modelId, catalogModels, enabledIds, metaFn) {
  const selfCap = modelCap(modelId, catalogModels, metaFn);
  const selfHint = modelGroupHint(modelId, catalogModels);
  const ids = enabledIds && enabledIds.length ? enabledIds : (catalogModels || []).map(function (m) { return m.id; });
  const scored = [];
  ids.forEach(function (id) {
    if (!id || id === modelId) return;
    const cap = modelCap(id, catalogModels, metaFn);
    const status = modelStatus(id, catalogModels);
    if (status <= 0) return; // 跳过已过期/已下架
    const hint = modelGroupHint(id, catalogModels);
    // 评分：能力档差越小越好；同分组加分；状态越高越好
    let score = 1000 - Math.abs(cap - selfCap) * 100;
    if (hint === selfHint) score += 60;
    score += status * 30;
    scored.push({ id: id, score: score, cap: cap, status: status });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, FAILOVER_MAX - 1).map(function (x) { return x.id; });
}

// 计算「当前配置下可服务」的模型集合（至少一个 enabled upstream 列出该模型，或上游 models 含通配符）
// 用于剔除 failover 链里"没有上游"的模型——否则 failover 会 502 而非优雅降级。
function servableModelIds(config) {
  const set = new Set();
  (config.upstreams || []).forEach(function (up) {
    if (!up.enabled) return;
    (up.models || []).forEach(function (m) {
      if (m === '*' || m === 'all' || m === '/*') set.add('*');
      else set.add(String(m).toLowerCase());
    });
  });
  return set;
}
function isServable(id, servable) {
  if (!servable || !servable.size) return true; // 未提供则不过滤（向后兼容 / 单测）
  if (servable.has('*')) return true;
  return servable.has(String(id).toLowerCase());
}

// 公开的 fallback 链生成
function fallbackChain(modelId, opts) {
  opts = opts || {};
  const catalogModels = opts.catalogModels || [];
  const enabledIds = opts.enabledIds || [];
  const metaFn = opts.metaFn;
  const userMapping = opts.userMapping || {};
  const servable = opts.servableIds; // Set/array，可选：仅保留有上游的备用模型

  // 1. 用户映射优先
  const mapped = userMapping[modelId] || userMapping[String(modelId).toLowerCase()];
  if (Array.isArray(mapped) && mapped.length) {
    const fallbacks = uniqueWithoutSelf(mapped, modelId).filter(function (id) { return isServable(id, servable); });
    return [modelId].concat(fallbacks).slice(0, FAILOVER_MAX);
  }

  // 2. 按目录元数据自动推断
  const auto = autoFallbackChain(modelId, catalogModels, enabledIds, metaFn)
    .filter(function (id) { return isServable(id, servable); });
  return [modelId].concat(auto).slice(0, FAILOVER_MAX);
}

module.exports = {
  isRetryableError: isRetryableError,
  fallbackChain: fallbackChain,
  servableModelIds: servableModelIds,
  DEFAULT_GROUPS: DEFAULT_GROUPS,
  FAILOVER_MAX: FAILOVER_MAX
};
