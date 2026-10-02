// src/shared/presets.ts
// Model presets / default URLs / default parameters.
// P54/P55: preset IDs and contextWindow/maxTokens aligned with current provider docs (2026-07).
// DeepSeek's old `deepseek-chat` / `deepseek-reasoner` aliases were retired 2026-07-24.
// P131: GPT-6 Astra (2026-09-03), Claude Opus 5.5 and Claude Fable 5.1 become the
// recommended OpenAI / Anthropic models. Saved ids that left the list still load — the
// Settings dropdown shows any non-preset id as "Custom model".
// P132: presets are organised by PROVIDER. Most providers serve both wire protocols, at
// different URLs (DeepSeek: /  vs  /anthropic); Settings picks the URL for the selected
// protocol and lists only that provider's models. DeepSeek V4.1 Flash (2026-09-10) is
// `deepseek-flash` — `deepseek-v4-flash` was retired (requests are only routed over).

import type { LLMProtocol, ModelPreset, LLMConfig } from './types';

export const DEFAULT_URLS: Record<LLMProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export interface ProviderPreset {
  id: string;
  name: string;
  /** Base URL per wire protocol. A protocol the provider does not serve is absent. */
  urls: Partial<Record<LLMProtocol, string>>;
  /** This provider's model ids (the "Custom model" option is added by the UI). */
  models: ModelPreset[];
  /** Model selected when switching to this provider. */
  suggestedModel?: string;
  /** Whether the provider supports `tools` / function calling */
  supportsTools?: boolean;
  /** P54: recommended context window (tokens), applied by the quick-fill button. */
  contextWindow?: number;
  /** P54: recommended max output (tokens), applied by the quick-fill button. */
  maxTokens?: number;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    // GPT-6 / GPT-5.x / o series REQUIRE max_completion_tokens (handled in the adapter)
    id: 'openai',
    name: 'OpenAI',
    urls: { openai: 'https://api.openai.com/v1' },
    models: [
      { label: 'GPT-6 Astra (1M ctx, recommended)', value: 'gpt-6-astra' },
      { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
      { label: 'GPT-4.1', value: 'gpt-4.1' },
      { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    ],
    suggestedModel: 'gpt-6-astra',
    supportsTools: true,
    contextWindow: 1_050_000,
    maxTokens: 32_768,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    urls: { anthropic: 'https://api.anthropic.com' },
    models: [
      { label: 'Claude Opus 5.5 (1M ctx, recommended)', value: 'claude-opus-5-5' },
      { label: 'Claude Fable 5.1 (1M ctx, most capable)', value: 'claude-fable-5-1' },
      { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
    ],
    suggestedModel: 'claude-opus-5-5',
    supportsTools: true,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    urls: { openai: 'https://api.deepseek.com', anthropic: 'https://api.deepseek.com/anthropic' },
    models: [
      { label: 'DeepSeek V4 Pro (强)', value: 'deepseek-v4-pro' },
      { label: 'DeepSeek V4.1 Flash (快，支持图片)', value: 'deepseek-flash' },
    ],
    suggestedModel: 'deepseek-v4-pro',
    supportsTools: true,
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    urls: { openai: 'https://api.moonshot.cn/v1', anthropic: 'https://api.moonshot.cn/anthropic' },
    models: [
      { label: 'Kimi K3', value: 'kimi-k3' },
      { label: 'Kimi K2.5', value: 'kimi-k2.5' },
    ],
    suggestedModel: 'kimi-k3',
    supportsTools: true,
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    urls: { openai: 'https://api.minimax.io/v1', anthropic: 'https://api.minimax.io/anthropic' },
    models: [{ label: 'MiniMax M3 (512K ctx)', value: 'minimax-m3' }],
    suggestedModel: 'minimax-m3',
    supportsTools: true,
    contextWindow: 512_000,
    maxTokens: 32_768,
  },
  {
    id: 'zhipu',
    name: 'Zhipu (GLM)',
    urls: { openai: 'https://open.bigmodel.cn/api/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic' },
    models: [{ label: 'GLM-4.6', value: 'glm-4.6' }],
    suggestedModel: 'glm-4.6',
    supportsTools: true,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    id: 'qwen',
    name: 'Alibaba Bailian (Qwen)',
    urls: {
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    },
    models: [
      { label: 'Qwen 3.8 Max', value: 'qwen3.8-max' },
      { label: 'Qwen 3.7 Max', value: 'qwen3.7-max' },
    ],
    suggestedModel: 'qwen3.8-max',
    supportsTools: true,
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    urls: { openai: 'https://api.siliconflow.cn/v1' },
    models: [],
    supportsTools: true,
    contextWindow: 128_000,
    maxTokens: 32_768,
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    urls: { openai: 'http://localhost:11434/v1', anthropic: 'http://localhost:11434' },
    models: [],
    supportsTools: false,
    contextWindow: 32_768,
    maxTokens: 8_192,
  },
];

const CUSTOM: ModelPreset = { label: 'Custom model', value: 'custom' };

function normURL(url?: string): string {
  return (url ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * P132: the provider a base URL belongs to. An exact URL match wins (either protocol);
 * otherwise the host decides, so a hand-edited path (`https://api.deepseek.com/v1`) still
 * resolves. A gateway we don't know returns undefined.
 */
export function providerForURL(url?: string): ProviderPreset | undefined {
  const u = normURL(url);
  if (!u) return undefined;
  const exact = PROVIDERS.find((p) => Object.values(p.urls).some((x) => normURL(x) === u));
  if (exact) return exact;
  const host = hostOf(u);
  return host ? PROVIDERS.find((p) => Object.values(p.urls).some((x) => hostOf(x!) === host)) : undefined;
}

/** Providers that serve a given protocol (the quick-fill row). */
export function providersFor(protocol: LLMProtocol): ProviderPreset[] {
  return PROVIDERS.filter((p) => !!p.urls[protocol]);
}

/** P132: model dropdown — the base URL's provider's models + "Custom model" only. */
export function modelOptions(protocol: LLMProtocol, baseURL?: string): ModelPreset[] {
  const p = providerForURL(baseURL);
  return p && p.urls[protocol] ? [...p.models, CUSTOM] : [CUSTOM];
}

/** Model to use on `p`: keep the current one if this provider lists it. */
function modelFor(p: ProviderPreset, current?: string): string {
  if (current && p.models.some((m) => m.value === current)) return current;
  return p.suggestedModel ?? p.models[0]?.value ?? '';
}

/**
 * P132: switching protocol keeps the provider when it serves the other protocol too
 * (DeepSeek `https://api.deepseek.com` ⇄ `https://api.deepseek.com/anthropic`), and falls
 * back to the protocol's official endpoint otherwise.
 */
export function switchProtocol(
  cfg: Pick<LLMConfig, 'baseURL' | 'model'>,
  protocol: LLMProtocol,
): Pick<LLMConfig, 'baseURL' | 'model'> {
  const cur = providerForURL(cfg.baseURL);
  const target = cur?.urls[protocol] ? cur : providerForURL(DEFAULT_URLS[protocol])!;
  return { baseURL: target.urls[protocol]!, model: modelFor(target, cfg.model) };
}

/** P132: quick-fill — URL for the current protocol, a model of this provider, its defaults. */
export function applyProviderPreset(
  p: ProviderPreset,
  protocol: LLMProtocol,
  currentModel?: string,
): Partial<LLMConfig> {
  return {
    baseURL: p.urls[protocol] ?? '',
    model: modelFor(p, currentModel),
    ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
    ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}),
  };
}

/** Every preset model per protocol (+ custom) — kept for callers that want a flat list. */
export const MODEL_PRESETS: Record<LLMProtocol, ModelPreset[]> = {
  anthropic: [...providersFor('anthropic').flatMap((p) => p.models), CUSTOM],
  openai: [...providersFor('openai').flatMap((p) => p.models), CUSTOM],
};

/** OpenAI-compatible endpoints, flattened from PROVIDERS. */
export const OPENAI_COMPATIBLE_PROVIDERS = providersFor('openai').map((p) => ({
  name: p.name,
  url: p.urls.openai!,
  supportsTools: p.supportsTools,
  suggestedModel: p.suggestedModel,
  contextWindow: p.contextWindow,
  maxTokens: p.maxTokens,
}));

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
  enableShell: false,  // P107: shell 工具总开关，默认关闭（见设置页说明）
};
