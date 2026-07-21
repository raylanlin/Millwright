// src/main/llm/anthropic.ts
//
// Anthropic Messages API adapter.
// Uses raw `fetch` + hand-written SSE parsing (avoids the SDK overhead; the two
// protocols are structurally different enough that a uniform `fetch`-based path
// is easier to read).
//
// Docs: https://docs.claude.com/en/api/messages
//       https://docs.claude.com/en/api/messages-streaming

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

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicTextContent {
  type: 'text';
  text: string;
}
interface AnthropicResponseBody {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicTextContent[];
  model: string;
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicAdapter extends BaseLLMAdapter {
  private buildBody(messages: ChatMessage[], stream: boolean) {
    const { system, rest } = this.splitSystem(messages);
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
    );

    return {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: this.config.temperature ?? 0.3,
      system: systemPrompt,
      stream,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    // Detect whether to use Bearer auth (e.g. MiniMax's Anthropic-compatible endpoint).
    // Heuristic: baseURL contains "/anthropic" OR uses a non-official Anthropic domain.
    const isBearerAuth =
      this.config.baseURL.includes('/anthropic') ||
      (!this.config.baseURL.includes('api.anthropic.com') && !this.config.baseURL.includes('anthropic.com'));
    if (isBearerAuth) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    } else {
      headers['x-api-key'] = this.config.apiKey;
    }
    return headers;
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await fetch(`${this.getBaseURL()}/v1/messages`, {
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
          extractErrorMessage(text, `Anthropic API 错误 (HTTP ${res.status})`),
        );
      }

      let data: AnthropicResponseBody;
      try {
        data = JSON.parse(text);
      } catch {
        throw new LLMHttpError(res.status, text, '无法解析 Anthropic 响应');
      }

      const content = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');

      return this.finalize(content, data.usage, data.stop_reason);
    } catch (err) {
      throw toLLMError(err, 'Anthropic 请求失败');
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
    const usage: { input_tokens?: number; output_tokens?: number } = {};
    let stopReason: string | null = null;

    try {
      yield { type: 'start', requestId };

      const res = await fetch(`${this.getBaseURL()}/v1/messages`, {
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
          extractErrorMessage(text, `Anthropic API 错误 (HTTP ${res.status})`),
        );
      }
      if (!res.body) throw new Error('Anthropic 流式响应缺少 body');

      for await (const ev of parseSSE(res.body)) {
        // Anthropic event types: message_start, content_block_start, content_block_delta,
        //                    content_block_stop, message_delta, message_stop, ping, error
        if (!ev.data || ev.data === '[DONE]') continue;
        let payload: any;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          continue;
        }

        switch (payload.type) {
          case 'content_block_delta': {
            const delta = payload.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              acc += delta.text;
              yield { type: 'delta', requestId, chunk: delta.text };
            }
            break;
          }
          case 'message_delta': {
            if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
            if (payload.usage?.output_tokens != null)
              usage.output_tokens = payload.usage.output_tokens;
            break;
          }
          case 'message_start': {
            if (payload.message?.usage) {
              usage.input_tokens = payload.message.usage.input_tokens;
              usage.output_tokens = payload.message.usage.output_tokens;
            }
            break;
          }
          case 'error': {
            const msg = payload.error?.message ?? 'Anthropic 流式错误';
            throw new Error(msg);
          }
          default:
            break;
        }
      }

      yield {
        type: 'done',
        requestId,
        response: this.finalize(acc, usage, stopReason),
      };
    } catch (err) {
      yield { type: 'error', requestId, error: toLLMError(err, 'Anthropic 流式请求失败') };
    } finally {
      cleanup();
    }
  }

  async test(signal?: AbortSignal): Promise<boolean> {
    // Minimal-cost probe: max_tokens=1 + "hi"
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await fetch(`${this.getBaseURL()}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
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
      throw toLLMError(err, '测试 Anthropic 连接失败');
    } finally {
      cleanup();
    }
  }

  private finalize(
    content: string,
    rawUsage: { input_tokens?: number; output_tokens?: number } | undefined,
    stopReason: string | null,
  ): LLMResponse {
    const usage: LLMUsage | undefined = rawUsage?.input_tokens != null
      ? {
          inputTokens: rawUsage.input_tokens ?? 0,
          outputTokens: rawUsage.output_tokens ?? 0,
        }
      : undefined;

    const code = extractFirstCodeBlock(content);

    let finishReason: LLMResponse['finishReason'];
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = 'stop';
        break;
      case 'max_tokens':
        finishReason = 'length';
        break;
      case 'tool_use':
        finishReason = 'tool_use';
        break;
      default:
        finishReason = 'stop';
    }

    return {
      content,
      usage,
      code: code?.code,
      codeLanguage: code?.language,
      finishReason,
    };
  }
}
