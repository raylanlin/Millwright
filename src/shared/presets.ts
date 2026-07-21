// src/shared/presets.ts
// Model presets / default URLs / default parameters.
// P1 update: added DeepSeek / Kimi (Moonshot) / MiniMax presets and URLs.

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
    { label: 'Custom model', value: 'custom' },
  ],
  openai: [
    // —— Major Chinese providers (all use the OpenAI-compatible protocol) ——
    { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
    { label: 'DeepSeek Chat', value: 'deepseek-chat' },
    { label: 'Kimi K3 (Moonshot)', value: 'kimi-k3' },
    { label: 'MiniMax M3', value: 'minimax-m3' },
    // —— OpenAI official ——
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'Custom model', value: 'custom' },
  ],
};

/**
 * Common OpenAI-compatible provider URL hints.
 * P1: added Moonshot (Kimi); updated MiniMax to the new domain `api.minimaxi.com`.
 * Each entry flags whether `tools` / function calling has been verified to work.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: Array<{
  name: string;
  url: string;
  /** Whether the provider supports OpenAI-style `tools` / function calling */
  supportsTools?: boolean;
  /** Recommended agent model for this provider */
  suggestedModel?: string;
}> = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com', supportsTools: true, suggestedModel: 'deepseek-v4-pro' },
  { name: 'Kimi / Moonshot', url: 'https://api.moonshot.cn/v1', supportsTools: true, suggestedModel: 'kimi-k3' },
  { name: 'MiniMax', url: 'https://api.minimaxi.com/v1', supportsTools: true, suggestedModel: 'minimax-m3' },
  { name: 'Alibaba Bailian', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsTools: true },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', supportsTools: true },
  { name: 'Ollama (local)', url: 'http://localhost:11434/v1', supportsTools: false },
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
