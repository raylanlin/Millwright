// src/shared/presets.ts
// 模型预设 / 默认 URL / 默认参数
// P1 更新：补齐 DeepSeek / Kimi(Moonshot) / MiniMax 预设与 URL。

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
    // —— 国产重点模型（均为 OpenAI 兼容协议）——
    { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
    { label: 'DeepSeek Chat', value: 'deepseek-chat' },
    { label: 'Kimi K3 (Moonshot)', value: 'kimi-k3' },
    { label: 'MiniMax M3', value: 'minimax-m3' },
    // —— OpenAI 官方 ——
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: '自定义模型', value: 'custom' },
  ],
};

/**
 * 常用 OpenAI 兼容服务商 URL 提示。
 * P1: 新增 Moonshot(Kimi)；MiniMax 更新为新域名 api.minimaxi.com。
 * 每项标注是否已验证支持 function calling（tools）。
 */
export const OPENAI_COMPATIBLE_PROVIDERS: Array<{
  name: string;
  url: string;
  /** 是否支持 OpenAI 风格 tools / function calling */
  supportsTools?: boolean;
  /** 该服务商推荐的 agent 模型 */
  suggestedModel?: string;
}> = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com', supportsTools: true, suggestedModel: 'deepseek-v4-pro' },
  { name: 'Kimi / Moonshot', url: 'https://api.moonshot.cn/v1', supportsTools: true, suggestedModel: 'kimi-k3' },
  { name: 'MiniMax', url: 'https://api.minimaxi.com/v1', supportsTools: true, suggestedModel: 'minimax-m3' },
  { name: '阿里百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsTools: true },
  { name: '硅基流动', url: 'https://api.siliconflow.cn/v1', supportsTools: true },
  { name: 'Ollama 本地', url: 'http://localhost:11434/v1', supportsTools: false },
];

export const DEFAULT_CONFIG: LLMConfig = {
  protocol: 'openai',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-pro',
  systemPrompt: '',
  temperature: 0.3,
  maxTokens: 4096,
  stream: true,
  timeoutMs: 120_000,
};
