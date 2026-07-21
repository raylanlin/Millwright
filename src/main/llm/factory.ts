// src/main/llm/factory.ts

import type { LLMConfig } from '../../shared/types';
import type { LLMAdapter } from './adapter';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';

/**
 * Create an adapter from configuration.
 * Intentionally NOT cached — config can change between calls, and construction
 * is cheap (it just stores the config object).
 */
export function createAdapter(config: LLMConfig): LLMAdapter {
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'openai':
      return new OpenAIAdapter(config);
    default:
      // The type system should make this unreachable, but guard at runtime too.
      throw new Error(`Unsupported protocol: ${(config as any).protocol}`);
  }
}

/** Validate that a config has everything needed to send a request */
export function validateConfig(config: Partial<LLMConfig>): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!config.protocol) issues.push('Missing `protocol`');
  if (!config.baseURL) issues.push('Missing `baseURL`');
  if (!config.apiKey) issues.push('Missing `apiKey`');
  if (!config.model) issues.push('Missing `model`');

  if (config.baseURL) {
    try {
      // Both `http://` and `https://` are allowed (Ollama on localhost uses `http://`).
      const u = new URL(config.baseURL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        issues.push(`Unsupported base URL protocol: ${u.protocol}`);
      }
    } catch {
      issues.push('`baseURL` is not a valid URL');
    }
  }

  return { valid: issues.length === 0, issues };
}
