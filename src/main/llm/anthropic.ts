// src/main/llm/anthropic.ts
//
// Anthropic Messages API adapter.
// Uses raw `fetch` + hand-written SSE parsing.
//
// P5: implements `chatWithTools` — the Anthropic protocol now drives the agent
// loop natively via `tool_use` / `tool_result` content blocks. Tool schemas
// arrive in the OpenAI function format (internal lingua franca, straight from
// sidecar.list_tools) and are converted on the wire.
//
// Docs: https://docs.claude.com/en/api/messages

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
  ToolCall,
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

  // —— P5: Agent mode (native tool_use) ——

  /** OpenAI function schema → Anthropic tool schema. Already-Anthropic entries pass through. */
  private toAnthropicTools(tools: any[]): any[] {
    return tools.map((t) =>
      t?.function
        ? { name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }
        : t,
    );
  }

  /** data URL → Anthropic image source block */
  private imageBlock(dataUrl: string): any | null {
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
    if (!m) return null;
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }

  /**
   * Convert internal ChatMessage[] into Anthropic wire messages.
   * - assistant(toolCalls) → assistant content [text?, tool_use…]
   * - role:'tool' (or legacy system+toolCalls result) → user content [tool_result]
   *   (consecutive results are merged into ONE user turn, as the API requires)
   * - user with images → [text?, image…]
   * Consecutive same-role turns are merged (Anthropic requires strict alternation).
   */
  private buildToolMessages(messages: ChatMessage[]): { system: string; wire: any[] } {
    const { system, rest } = this.splitSystem(messages);
    const wire: any[] = [];

    const pushTurn = (role: 'user' | 'assistant', blocks: any[]) => {
      const last = wire[wire.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else wire.push({ role, content: blocks });
    };

    for (const m of rest) {
      // Tool result (new first-class encoding, or legacy system+toolCalls)
      if (m.role === 'tool' || (m.toolCalls && m.toolCalls[0]?.result != null && m.role !== 'assistant')) {
        const id = m.role === 'tool' ? (m.toolCallId ?? '') : (m.toolCalls![0].id ?? m.toolCalls![0].name);
        const content = m.role === 'tool' ? m.content : m.toolCalls![0].result ?? '';
        pushTurn('user', [{ type: 'tool_result', tool_use_id: id, content }]);
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id ?? tc.name, name: tc.name, input: tc.parameters ?? {} });
        }
        pushTurn('assistant', blocks);
        continue;
      }
      if (m.role === 'user' && m.images?.length) {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const url of m.images) {
          const b = this.imageBlock(url);
          if (b) blocks.push(b);
        }
        pushTurn('user', blocks);
        continue;
      }
      pushTurn(m.role === 'assistant' ? 'assistant' : 'user', [{ type: 'text', text: m.content }]);
    }
    return { system, wire };
  }

  async chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const { system, wire } = this.buildToolMessages(messages);
      const systemPrompt = resolveSystemPrompt(
        [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
      );
      const body: any = {
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 4096,
        temperature: this.config.temperature ?? 0.3,
        system: systemPrompt,
        stream: false,
        messages: wire,
      };
      if (tools && tools.length > 0) body.tools = this.toAnthropicTools(tools);

      const res = await fetch(`${this.getBaseURL()}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: s,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `Anthropic API 错误 (HTTP ${res.status})`));
      }
      const data = JSON.parse(text);

      let content = '';
      const toolCalls: ToolCall[] = [];
      for (const block of data.content ?? []) {
        if (block.type === 'text') content += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, parameters: block.input ?? {} });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: toolCalls.length ? 'tool_use' : 'stop',
        usage: data.usage
          ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
          : undefined,
      };
    } catch (err) {
      throw toLLMError(err, '工具调用请求失败');
    } finally {
      cleanup();
    }
  }

  async test(signal?: AbortSignal): Promise<boolean> {
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
