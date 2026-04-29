// src/main/llm/index.ts

export { createAdapter, validateConfig } from './factory';
export { BaseLLMAdapter } from './adapter';
export type { LLMAdapter } from './adapter';
export { AnthropicAdapter } from './anthropic';
export { OpenAIAdapter } from './openai';
export { DEFAULT_SYSTEM_PROMPT, resolveSystemPrompt } from './prompts';
export { extractFirstCodeBlock, extractAllCodeBlocks } from './code-extract';
export type { ExtractedCode } from './code-extract';
export { toLLMError, httpStatusToCode, LLMHttpError } from './errors';
