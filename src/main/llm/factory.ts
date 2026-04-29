// src/main/llm/factory.ts

import type { LLMConfig } from '../../shared/types';
import type { LLMAdapter } from './adapter';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';

/**
 * 根据配置创建适配器。
 * 这里刻意不缓存 —— 每次 config 可能变,创建成本极低(就是存一下 config 对象)。
 */
export function createAdapter(config: LLMConfig): LLMAdapter {
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'openai':
      return new OpenAIAdapter(config);
    default:
      // 类型系统应该能挡住,但保险起见运行期也报错
      throw new Error(`不支持的协议: ${(config as any).protocol}`);
  }
}

/** 校验配置是否完整到可发请求的程度 */
export function validateConfig(config: Partial<LLMConfig>): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!config.protocol) issues.push('缺少协议 (protocol)');
  if (!config.baseURL) issues.push('缺少 Base URL');
  if (!config.apiKey) issues.push('缺少 API Key');
  if (!config.model) issues.push('缺少模型名');

  if (config.baseURL) {
    try {
      // 允许 http:// 和 https:// (Ollama 本地是 http)
      const u = new URL(config.baseURL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        issues.push(`Base URL 协议不支持: ${u.protocol}`);
      }
    } catch {
      issues.push('Base URL 格式无效');
    }
  }

  return { valid: issues.length === 0, issues };
}
