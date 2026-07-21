// src/main/llm/context-window.ts
//
// Conversation context-window management.
// Before sending to the LLM, truncate the message list so the request stays
// within the model's token budget.
//
// Strategy:
// 1. Always keep the system prompt.
// 2. Always keep the last user turn.
// 3. Keep as much of the history as possible, oldest-to-newest.
// 4. When the budget is exceeded, drop the oldest message pairs first.

import type { ChatMessage } from '../../shared/types';

/** Per-model token budgets (conservative — leaves room for output) */
const MODEL_TOKEN_BUDGETS: Record<string, number> = {
  'claude-sonnet-4': 150_000,
  'claude-opus-4': 150_000,
  'claude-3-5-haiku': 150_000,
  'gpt-4o': 100_000,
  'gpt-4o-mini': 100_000,
  'gpt-4.1': 900_000,
  'deepseek-chat': 50_000,
  'qwen-coder-plus': 100_000,
  // Extended coverage for more model aliases
  'claude-sonnet': 150_000,
  'deepseek-v3': 50_000,
  'qwen': 100_000,
  'minimax': 100_000,
  'glm': 100_000,
};

/** Default token budget (used when the model is not listed above) */
const DEFAULT_BUDGET = 30_000;

/** Tokens reserved for the model's output */
const OUTPUT_RESERVE = 4_096;

/**
 * Rough token-count estimator.
 * Chinese ≈ 1.5 tokens per character, English ≈ 0.75 tokens per word;
 * mixed text uses a blended approximation.
 * Intentionally imprecise — only the order of magnitude matters.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK characters
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // Count English words (rough)
  const englishWords = text.replace(/[\u4e00-\u9fff]/g, '').split(/\s+/).filter(Boolean).length;
  // Count code-like characters (non-CJK, non-whitespace) — code is token-dense, weight 0.5
  const codeChars = text.replace(/[\u4e00-\u9fff\s]/g, '').length;

  return Math.ceil(chineseChars * 1.5 + englishWords * 0.75 + codeChars * 0.5);
}

/**
 * Truncate a message list so it fits within the token budget.
 *
 * @param messages - the full message list (without the system prompt)
 * @param systemPrompt - system prompt text
 * @param model - model name (used to look up the token budget)
 * @returns the truncated message list
 */
export function truncateMessages(
  messages: ChatMessage[],
  systemPrompt: string = '',
  model: string = '',
): ChatMessage[] {
  // Look up the model's budget
  const budgetKey = Object.keys(MODEL_TOKEN_BUDGETS).find((k) =>
    model.toLowerCase().includes(k.toLowerCase()),
  );
  const totalBudget = (budgetKey ? MODEL_TOKEN_BUDGETS[budgetKey] : DEFAULT_BUDGET) - OUTPUT_RESERVE;

  const systemTokens = estimateTokens(systemPrompt);
  let availableTokens = totalBudget - systemTokens;

  if (availableTokens <= 0) {
    // The system prompt alone exceeds the budget; keep only the most recent message.
    return messages.slice(-1);
  }

  // Accumulate from the tail backwards until we exceed the budget
  const result: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content) + estimateTokens(msg.code || '');
    if (tokens > availableTokens) break;
    availableTokens -= tokens;
    result.unshift(msg);
  }

  // Always retain the most recent user message as a hard floor
  if (result.length === 0 && messages.length > 0) {
    result.push(messages[messages.length - 1]);
  }

  return result;
}
