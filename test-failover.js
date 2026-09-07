'use strict';
const failover = require('./proxy/failover');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

// 1. isRetryableError
assert(failover.isRetryableError(429, '') === true, '429 should be retryable');
assert(failover.isRetryableError(429, '{"error":"rate limit"}') === true, '429 body');
assert(failover.isRetryableError(400, 'insufficient_quota') === true, 'quota keyword');
assert(failover.isRetryableError(400, 'Rate limit exceeded') === true, 'rate limit exceeded');
assert(failover.isRetryableError(401, '') === false, '401 should not be retryable');
assert(failover.isRetryableError(500, 'internal error') === false, '500 should not be retryable');

// 2. user mapping
const chain = failover.fallbackChain('gpt-3.5-turbo', {
  userMapping: { 'gpt-3.5-turbo': ['sf/Qwen2.5-7B-Instruct', 'zhipu/glm-4-flash'] }
});
assert(chain[0] === 'gpt-3.5-turbo', 'chain starts with original model');
assert(chain[1] === 'sf/Qwen2.5-7B-Instruct', 'user mapping first fallback');
assert(chain.length <= failover.FAILOVER_MAX, 'chain within max');

// 3. auto fallback from catalog
const catalog = [
  { id: 'sf/Qwen2.5-7B-Instruct', type: 'free', contextWindow: '32k', modality: ['对话'] },
  { id: 'sf/deepseek-ai/DeepSeek-V3', type: 'quota', contextWindow: '64k', modality: ['对话'] },
  { id: 'zhipu/glm-4-flash', type: 'free', contextWindow: '8k', modality: ['对话'] },
  { id: 'zhipu/glm-4-plus', type: 'quota', contextWindow: '128k', modality: ['对话', '推理'] },
  { id: 'expired-model', type: 'expired', status: '已过期' }
];
const auto = failover.fallbackChain('sf/Qwen2.5-7B-Instruct', {
  catalogModels: catalog,
  enabledIds: catalog.map(m => m.id)
});
assert(auto[0] === 'sf/Qwen2.5-7B-Instruct', 'auto chain starts original');
assert(auto.indexOf('expired-model') === -1, 'expired model excluded');
assert(auto.length >= 2, 'auto chain has fallbacks');

// 4. servableIds 过滤：剔除没有上游的备用模型（否则 failover 会 502 而非优雅降级）
const autoUnservable = failover.fallbackChain('sf/Qwen2.5-7B-Instruct', {
  catalogModels: catalog,
  enabledIds: catalog.map(m => m.id),
  servableIds: new Set(['sf/qwen2.5-7b-instruct']) // 仅原模型本身有上游
});
assert(autoUnservable.length === 1 && autoUnservable[0] === 'sf/Qwen2.5-7B-Instruct',
  'servableIds 仅含原模型时，备用链为空（不被无上游模型污染） real=' + JSON.stringify(autoUnservable));
// 用户映射也受 servableIds 约束
const mappedUnservable = failover.fallbackChain('gpt-3.5-turbo', {
  userMapping: { 'gpt-3.5-turbo': ['sf/Qwen2.5-7B-Instruct', 'zhipu/glm-4-flash'] },
  servableIds: new Set(['gpt-3.5-turbo'])
});
assert(mappedUnservable.length === 1, '用户映射中无上游的备用模型被剔除 real=' + JSON.stringify(mappedUnservable));

console.log('failover unit tests passed. sample chain:', auto.join(' -> '));
