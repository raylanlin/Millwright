// src/main/llm/context-window.ts
//
// 对话上下文窗口管理。
// 在发送给 LLM 之前，对消息列表做截断，避免超出模型 token 上限。
//
// 策略：
// 1. 始终保留 system prompt
// 2. 始终保留最后一轮用户消息
// 3. 从旧到新保留尽可能多的历史消息
// 4. 超出预算时移除最早的消息对

import type { ChatMessage } from '../../shared/types';

/** 不同模型的 token 上限（保守估计，预留输出空间） */
const MODEL_TOKEN_BUDGETS: Record<string, number> = {
  'claude-sonnet-4': 150_000,
  'claude-opus-4': 150_000,
  'claude-3-5-haiku': 150_000,
  'gpt-4o': 100_000,
  'gpt-4o-mini': 100_000,
  'gpt-4.1': 900_000,
  'deepseek-chat': 50_000,
  'qwen-coder-plus': 100_000,
  // 扩展覆盖更多模型名称
  'claude-sonnet': 150_000,
  'deepseek-v3': 50_000,
  'qwen': 100_000,
  'minimax': 100_000,
  'glm': 100_000,
};

/** 默认 token 预算（如果模型不在上表中） */
const DEFAULT_BUDGET = 30_000;

/** 预留给模型输出的 token 空间 */
const OUTPUT_RESERVE = 4_096;

/**
 * 粗略估算文本的 token 数。
 * 中文约 1.5 token/字，英文约 0.75 token/word，混合文本取折中。
 * 不追求精确，只需要量级正确以避免超限。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // 统计英文单词数（粗略）
  const englishWords = text.replace(/[\u4e00-\u9fff]/g, '').split(/\s+/).filter(Boolean).length;
  // 代码字符数（非中文非空白）—— 代码 token 密度高，按 0.5 计
  const codeChars = text.replace(/[\u4e00-\u9fff\s]/g, '').length;

  return Math.ceil(chineseChars * 1.5 + englishWords * 0.75 + codeChars * 0.5);
}

/**
 * 对消息列表做截断，确保不超出 token 预算。
 *
 * @param messages - 完整消息列表（不含 system prompt）
 * @param systemPrompt - system prompt 文本
 * @param model - 模型名称（用于查找 token 预算）
 * @returns 截断后的消息列表
 */
export function truncateMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  model: string,
): ChatMessage[] {
  // 查找模型预算
  const budgetKey = Object.keys(MODEL_TOKEN_BUDGETS).find((k) =>
    model.toLowerCase().includes(k.toLowerCase()),
  );
  const totalBudget = (budgetKey ? MODEL_TOKEN_BUDGETS[budgetKey] : DEFAULT_BUDGET) - OUTPUT_RESERVE;

  const systemTokens = estimateTokens(systemPrompt);
  let availableTokens = totalBudget - systemTokens;

  if (availableTokens <= 0) {
    // system prompt 本身就超限了，只保留最后一条消息
    return messages.slice(-1);
  }

  // 从后往前累加，直到超出预算
  const result: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content) + estimateTokens(msg.code || '');
    if (tokens > availableTokens) break;
    availableTokens -= tokens;
    result.unshift(msg);
  }

  // 至少保留最后一条用户消息
  if (result.length === 0 && messages.length > 0) {
    result.push(messages[messages.length - 1]);
  }

  return result;
}
