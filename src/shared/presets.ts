// src/shared/presets.ts
// Model presets / default URLs / default parameters.
// P54/P55: preset IDs and contextWindow/maxTokens aligned with current provider docs (2026-07).
// DeepSeek's old `deepseek-chat` / `deepseek-reasoner` aliases were retired 2026-07-24.

import type { LLMProtocol, ModelPreset, LLMConfig } from './types';

export const DEFAULT_URLS: Record<LLMProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export const MODEL_PRESETS: Record<LLMProtocol, ModelPreset[]> = {
  anthropic: [
    { label: 'Claude Fable 5 (1M ctx, always-on thinking)', value: 'claude-fable-5' },
    { label: 'Claude Opus 4.8', value: 'claude-opus-4-8' },
    { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
    { label: 'Custom model', value: 'custom' },
  ],
  openai: [
    // —— Major Chinese providers (all use the OpenAI-compatible protocol) ——
    { label: 'DeepSeek V4 Pro (强)', value: 'deepseek-v4-pro' },
    { label: 'DeepSeek V4 Flash (快)', value: 'deepseek-v4-flash' },
    { label: 'Kimi K2.5 (Moonshot)', value: 'kimi-k2.5' },
    { label: 'MiniMax M3 (512K ctx)', value: 'minimax-m3' },
    { label: 'Qwen 3.7 Max (阿里百炼)', value: 'qwen3.7-max' },
    { label: 'GLM-4.6 (智谱)', value: 'glm-4.6' },
    // —— OpenAI official ——
    { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'Custom model', value: 'custom' },
  ],
};

/**
 * Common OpenAI-compatible provider URL hints.
 * P54: refreshed IDs and aligned with second-part table in APPLY.md.
 * Each entry flags whether `tools` / function calling has been verified to work.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: Array<{
  name: string;
  url: string;
  /** Whether the provider supports OpenAI-style `tools` / function calling */
  supportsTools?: boolean;
  /** Recommended agent model for this provider */
  suggestedModel?: string;
  /** P54: per-provider recommended context window (tokens). Used as the default in Settings. */
  contextWindow?: number;
  /** P54: per-provider recommended max output (tokens). Used as the default in Settings. */
  maxTokens?: number;
}> = [
  // OpenAI official — GPT-5.x / o series REQUIRE max_completion_tokens (handled in adapter)
  { name: 'OpenAI', url: 'https://api.openai.com/v1', supportsTools: true, suggestedModel: 'gpt-5.6-sol', contextWindow: 1_000_000, maxTokens: 32_768 },
  { name: 'DeepSeek', url: 'https://api.deepseek.com', supportsTools: true, suggestedModel: 'deepseek-v4-pro', contextWindow: 1_048_576, maxTokens: 32_768 },
  { name: 'Kimi / Moonshot', url: 'https://api.moonshot.cn/v1', supportsTools: true, suggestedModel: 'kimi-k2.5', contextWindow: 262_144, maxTokens: 32_768 },
  { name: 'MiniMax', url: 'https://api.minimaxi.com/v1', supportsTools: true, suggestedModel: 'minimax-m3', contextWindow: 512_000, maxTokens: 32_768 },
  { name: 'Zhipu (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', supportsTools: true, suggestedModel: 'glm-4.6', contextWindow: 200_000, maxTokens: 32_768 },
  { name: 'Alibaba Bailian (Qwen)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsTools: true, suggestedModel: 'qwen3.7-max', contextWindow: 262_144, maxTokens: 32_768 },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', supportsTools: true, contextWindow: 128_000, maxTokens: 32_768 },
  { name: 'Ollama (local)', url: 'http://localhost:11434/v1', supportsTools: false, contextWindow: 32_768, maxTokens: 8_192 },
];

export const DEFAULT_CONFIG: LLMConfig = {
  protocol: 'openai',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-pro',
  systemPrompt: '',
  temperature: 0.3,
  maxTokens: 32_768,
  contextWindow: 128_000,
  stream: true,
  timeoutMs: 120_000,
};
