// src/shared/presets.ts
// 模型预设 / 默认 URL / 默认参数

import type { LLMProtocol, ModelPreset, LLMConfig } from './types';

export const DEFAULT_URLS: Record<LLMProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export const MODEL_PRESETS: Record<LLMProtocol, ModelPreset[]> = {
  anthropic: [
    { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
    { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
    { label: '自定义模型', value: 'custom' },
  ],
  openai: [
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: '自定义模型', value: 'custom' },
  ],
};

/** 常用 OpenAI 兼容服务商 URL 提示 */
export const OPENAI_COMPATIBLE_PROVIDERS = [
  { name: '阿里百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'MiniMax', url: 'https://api.minimax.chat/v1' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com' },
  { name: '硅基流动', url: 'https://api.siliconflow.cn/v1' },
  { name: 'Ollama 本地', url: 'http://localhost:11434/v1' },
];

export const DEFAULT_CONFIG: LLMConfig = {
  protocol: 'anthropic',
  baseURL: DEFAULT_URLS.anthropic,
  apiKey: '',
  model: 'claude-sonnet-4-20250514',
  systemPrompt: '',
  temperature: 0.3,
  maxTokens: 4096,
  stream: true,
  timeoutMs: 60_000,
};
