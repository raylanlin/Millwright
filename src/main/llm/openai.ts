// src/main/llm/openai.ts
//
// OpenAI 兼容协议适配器
// 覆盖 OpenAI、DeepSeek、阿里百炼、MiniMax、硅基流动、Ollama 等。
//
// 所有服务都实现 /chat/completions,请求体结构基本一致,流式都是标准 SSE:
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: [DONE]

import { BaseLLMAdapter } from './adapter';
import { resolveSystemPrompt } from './prompts';
import { extractFirstCodeBlock } from './code-extract';
import { LLMHttpError, extractErrorMessage, toLLMError } from './errors';
import { parseSSE } from './sse';
import type {
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMUsage,
} from '../../shared/types';

interface OpenAIChoice {
  index: number;
  message?: { role: string; content: string };
  delta?: { role?: string; content?: string };
  finish_reason?: string | null;
}
interface OpenAIResponseBody {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIAdapter extends BaseLLMAdapter {
  private buildBody(messages: ChatMessage[], stream: boolean) {
    const { system: convoSystem, rest } = this.splitSystem(messages);
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, convoSystem].filter(Boolean).join('\n\n'),
    );

    // 首条必须是 system;其余原样透传
    const finalMessages = [
      { role: 'system', content: systemPrompt },
      ...rest.map((m) => ({ role: m.role, content: m.content })),
    ];

    return {
      model: this.config.model,
      messages: finalMessages,
      temperature: this.config.temperature ?? 0.3,
      max_tokens: this.config.maxTokens ?? 4096,
      stream,
    };
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await fetch(`${this.getBaseURL()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(messages, false)),
        signal: s,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(
          res.status,
          text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`),
        );
      }

      let data: OpenAIResponseBody;
      try {
        data = JSON.parse(text);
      } catch {
        throw new LLMHttpError(res.status, text, '无法解析响应');
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      const finishReason = mapFinishReason(choice?.finish_reason ?? null);
      const usage: LLMUsage | undefined = data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined;

      return this.finalize(content, usage, finishReason);
    } catch (err) {
      throw toLLMError(err, '请求失败');
    } finally {
      cleanup();
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    let acc = '';
    let finishReason: LLMResponse['finishReason'];
    let usage: LLMUsage | undefined;

    try {
      yield { type: 'start', requestId };

      const res = await fetch(`${this.getBaseURL()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(messages, true)),
        signal: s,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(
          res.status,
          text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`),
        );
      }
      if (!res.body) throw new Error('流式响应缺少 body');

      for await (const ev of parseSSE(res.body)) {
        if (!ev.data) continue;
        if (ev.data === '[DONE]') break;

        let payload: any;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          continue;
        }

        const choice = payload.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          acc += delta;
          yield { type: 'delta', requestId, chunk: delta };
        }
        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
        // 部分服务商(如 DeepSeek)会在最后一条事件带 usage
        if (payload.usage) {
          usage = {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
          };
        }
      }

      yield {
        type: 'done',
        requestId,
        response: this.finalize(acc, usage, finishReason ?? 'stop'),
      };
    } catch (err) {
      yield { type: 'error', requestId, error: toLLMError(err, '流式请求失败') };
    } finally {
      cleanup();
    }
  }

  async test(signal?: AbortSignal): Promise<boolean> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await fetch(`${this.getBaseURL()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: s,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(
          res.status,
          text,
          extractErrorMessage(text, `测试失败 (HTTP ${res.status})`),
        );
      }
      return true;
    } catch (err) {
      throw toLLMError(err, '测试连接失败');
    } finally {
      cleanup();
    }
  }

  private finalize(
    content: string,
    usage: LLMUsage | undefined,
    finishReason: LLMResponse['finishReason'],
  ): LLMResponse {
    const code = extractFirstCodeBlock(content);
    return {
      content,
      usage,
      code: code?.code,
      codeLanguage: code?.language,
      finishReason,
    };
  }
}

function mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case null:
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}
