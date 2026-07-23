// src/main/llm/context-window.ts
//
// Conversation context-window management.
//
// P5 rewrite: truncation is now BLOCK-aware. An assistant(tool_calls) turn and
// everything that answers it (role:'tool' results, legacy system+toolCalls
// results, the follow-up image message from analyze_view) form one atomic
// block that is kept or dropped as a whole. This is the structural fix for the
// OpenAI/DeepSeek 400s caused by orphaned tool results — no more head-stripping
// patches in the agent loops.

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
  'claude-sonnet': 150_000,
  'deepseek-v3': 50_000,
  'deepseek': 50_000,
  'qwen': 100_000,
  'minimax': 100_000,
  'glm': 100_000,
  'kimi': 100_000,
};

/** Default token budget (used when the model is not listed above) */
const DEFAULT_BUDGET = 30_000;

/** Tokens reserved for the model's output */
const OUTPUT_RESERVE = 4_096;

/**
 * Rough token-count estimator.
 * Chinese ≈ 1.5 tokens per character, English ≈ 0.75 tokens per word;
 * mixed text uses a blended approximation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fff]/g, '').split(/\s+/).filter(Boolean).length;
  const codeChars = text.replace(/[\u4e00-\u9fff\s]/g, '').length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.75 + codeChars * 0.5);
}

/** Legacy tool-result encoding (pre-P5 sessions): role:'system' + toolCalls[0].result */
function isLegacyToolResult(m: ChatMessage): boolean {
  return m.role === 'system' && !!m.toolCalls && m.toolCalls[0]?.result != null;
}

function isToolResult(m: ChatMessage): boolean {
  return m.role === 'tool' || isLegacyToolResult(m);
}

function msgTokens(m: ChatMessage): number {
  // images are budgeted flat — vision endpoints charge ~1-2k tokens per image
  return (
    estimateTokens(m.content) +
    estimateTokens(m.code || '') +
    (m.images?.length ?? 0) * 1_500 +
    (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0)
  );
}

/**
 * Group messages into atomic blocks:
 *   - assistant(tool_calls) + its tool results (+ a trailing analyze_view image
 *     message, if any) = one block;
 *   - every other message = its own block.
 */
function toBlocks(messages: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const grp: ChatMessage[] = [m];
      i++;
      while (
        i < messages.length &&
        (isToolResult(messages[i]) ||
          // analyze_view pushes the screenshot as a user message right after the tool result
          (messages[i].role === 'user' && !!messages[i].images?.length))
      ) {
        grp.push(messages[i]);
        i++;
      }
      blocks.push(grp);
    } else {
      blocks.push([m]);
      i++;
    }
  }
  return blocks;
}

/**
 * Truncate a message list so it fits within the token budget.
 * Whole blocks are accumulated from the tail; a block is never split.
 *
 * @param messages - the full message list (without the system prompt)
 * @param systemPrompt - system prompt text
 * @param model - model name (used to look up the token budget)
 * @param contextWindow - P5: explicit user-configured budget override
 */
export function truncateMessages(
  messages: ChatMessage[],
  systemPrompt: string = '',
  model: string = '',
  contextWindow?: number,
): ChatMessage[] {
  const budgetKey = Object.keys(MODEL_TOKEN_BUDGETS).find((k) =>
    model.toLowerCase().includes(k.toLowerCase()),
  );
  const totalBudget =
    (contextWindow && contextWindow > OUTPUT_RESERVE
      ? contextWindow
      : budgetKey
        ? MODEL_TOKEN_BUDGETS[budgetKey]
        : DEFAULT_BUDGET) - OUTPUT_RESERVE;

  let availableTokens = totalBudget - estimateTokens(systemPrompt);
  if (availableTokens <= 0) {
    return messages.slice(-1);
  }

  const blocks = toBlocks(messages);
  const kept: ChatMessage[][] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const tokens = blocks[i].reduce((sum, m) => sum + msgTokens(m), 0);
    if (tokens > availableTokens) break;
    availableTokens -= tokens;
    kept.unshift(blocks[i]);
  }

  // Hard floor: always keep the final block (even over budget) so a request is never empty
  if (kept.length === 0 && blocks.length > 0) {
    kept.push(blocks[blocks.length - 1]);
  }

  const result = kept.flat();
  // Safety net: the sequence must never OPEN with tool results (would 400)
  while (result.length > 0 && isToolResult(result[0])) result.shift();
  return result;
}
