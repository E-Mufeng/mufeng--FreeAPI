// constants.js — Free API 工作台 · 纯数据常量（无依赖，可被任意模块安全导入）
// 由 src/app.js 原 IIFE 顶层常量抽取而来，便于 Vite 模块化与 tree-shaking。

export const ICON = {
  plus:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  edit:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  trash:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
  refresh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  copy:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/></svg>',
  external:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  alert:   '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
  empty:   '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l2.6 11.2A2 2 0 007.6 20h8.8a2 2 0 001.9-1.8L21 7z"/><path d="M3 7h18l-1.6-2.4A2 2 0 0017.7 3.5H6.3a2 2 0 00-1.7 1.1z"/><path d="M9 11h6"/></svg>',
  spark:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 16l.9 2.3L21 19l-2.1.8L18 22l-.9-2.2L15 19l2.1-.7z"/></svg>',
  search:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  bolt:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  check:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  clock:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  gauge:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 100-18 9 9 0 000 18z"/><path d="M12 12l4-3.5"/></svg>',
  layers:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  key:     '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8a4 4 0 10-3.8 4H7v4H4v-3H2"/><circle cx="14" cy="11" r="1.6"/></svg>',
  close:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  grid:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>',
  list:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  chevronUp:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
  chevronDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  sun:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4 1.4"/></svg>',
  moon:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1112.8 3 7 7 0 0021 12.8z"/></svg>',
  eye:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  monitor: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  type:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>',
  keyboard:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>',
  image:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  broom:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 14M8 20l3-3M14 17l3 3M4 4l3 3 2-2 3 3 2-2"/></svg>'
};

export const STAGES = ['初次接触', '建立信任', '深化合作', '长期维护', '危机修复'];
export const GOALS  = ['配置一个可用接口', '生成调用示例', '排查调用失败', '整理可用模型清单', '自定义目标'];
export const SCOPES = ['语言', '对话', '图像', '多模态', '代码', '音频'];

export const API_TEMPLATES = {
  bailian:    { label: '阿里云百炼',      vendor: '阿里云百炼',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu:      { label: '智谱 AI',         vendor: '智谱 AI',           baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  deepseek:   { label: 'DeepSeek',        vendor: 'DeepSeek',          baseUrl: 'https://api.deepseek.com/v1' },
  openai:     { label: 'OpenAI',          vendor: 'OpenAI',            baseUrl: 'https://api.openai.com/v1' },
  ollama:     { label: '本地 Ollama',     vendor: '本机',              baseUrl: 'http://127.0.0.1:11434/v1' },
  gemini:     { label: 'Google Gemini', vendor: 'Google',            baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openrouter: { label: 'OpenRouter',      vendor: 'OpenRouter',        baseUrl: 'https://openrouter.ai/api/v1' },
  together:   { label: 'Together AI',   vendor: 'Together AI',         baseUrl: 'https://api.together.xyz/v1' },
  fireworks:  { label: 'Fireworks AI',  vendor: 'Fireworks AI',      baseUrl: 'https://api.fireworks.ai/inference/v1' },
  groq:       { label: 'Groq',            vendor: 'Groq',              baseUrl: 'https://api.groq.com/openai/v1' },
  mistral:    { label: 'Mistral AI',    vendor: 'Mistral AI',        baseUrl: 'https://api.mistral.ai/v1' },
  cohere:     { label: 'Cohere',          vendor: 'Cohere',            baseUrl: 'https://api.cohere.com/v1' },
  xai:        { label: 'xAI (Grok)',      vendor: 'xAI',               baseUrl: 'https://api.x.ai/v1' },
  azure:      { label: 'Azure OpenAI',  vendor: 'Azure OpenAI',      baseUrl: 'https://YOUR_RESOURCE.openai.azure.com/openai/deployments/v1' },
  baidu:      { label: '百度智能云千帆',vendor: '百度智能云',         baseUrl: 'https://qianfan.baidubce.com/v2' },
  xinghuo:    { label: '讯飞星火',      vendor: '讯飞星火',           baseUrl: 'https://spark-api-open.xf-yun.com/v1' },
  hunyuan:    { label: '腾讯混元',      vendor: '腾讯混元',           baseUrl: 'https://hunyuan.tencentcloudapi.com/v1' },
  moonshot:   { label: 'Moonshot AI',   vendor: 'Moonshot AI',       baseUrl: 'https://api.moonshot.cn/v1' },
  minimax:    { label: 'MiniMax',       vendor: 'MiniMax',           baseUrl: 'https://api.minimax.chat/v1' },
  siliconflow:{ label: '硅基流动',      vendor: '硅基流动',           baseUrl: 'https://api.siliconflow.cn/v1' },
  doubao:     { label: '火山引擎豆包',vendor: '火山引擎',           baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  ai21:       { label: 'AI21',            vendor: 'AI21',              baseUrl: 'https://api.ai21.com/studio/v1' },
  localai:    { label: 'LocalAI',       vendor: 'LocalAI',           baseUrl: 'http://127.0.0.1:8080/v1' },
  lmstudio:   { label: 'LM Studio',     vendor: 'LM Studio',         baseUrl: 'http://127.0.0.1:1234/v1' },
  proxy:      { label: '本地代理（统一入口）', vendor: '本地代理(统一入口)', baseUrl: 'http://127.0.0.1:8787/v1' }
};
