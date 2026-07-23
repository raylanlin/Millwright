// src/main/llm/openai.ts
//
// OpenAI-compatible protocol adapter.
// Covers OpenAI, DeepSeek, Alibaba Bailian, MiniMax, SiliconFlow, Ollama, and others.
//
// All services implement `/chat/completions` with a near-identical request body,
// and streaming uses the standard SSE format:
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: [DONE]

import { BaseLLMAdapter } from './adapter';
import { resolveSystemPrompt } from './prompts';
import { extractFirstCodeBlock } from './code-extract';
import { LLMHttpError, extractErrorMessage, toLLMError } from './errors';
import { parseSSE } from './sse';
import { buildOpenAITools } from './tools-schema';
import type {
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMUsage,
  ToolCall,
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

    // The first message must be the system prompt; the rest are passed through unchanged
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
        // Some providers (e.g. DeepSeek) include `usage` on the final event
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

  // —— P1: Function Calling / Agent mode ——

  private buildToolBody(openAIMessages: any[], tools: any[]) {
    return {
      model: this.config.model,
      messages: openAIMessages,
      temperature: this.config.temperature ?? 0.3,
      max_tokens: this.config.maxTokens ?? 4096,
      tools,
      tool_choice: 'auto',
      stream: false,
    };
  }

  // Convert internal `ChatMessage[]` to the OpenAI wire format, faithfully preserving `tool_calls` / `role:'tool'`.
  private buildToolMessages(messages: ChatMessage[]): any[] {
    const { system } = this.splitSystem(
      messages.filter((m) => !(m.role === 'system' && m.toolCalls)),
    );
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
    );
    const out: any[] = [{ role: 'system', content: systemPrompt }];

    for (const m of messages) {
      // P5: first-class tool-result message
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
        continue;
      }
      // Message carrying a tool "result" (agent-loop uses role:'system' + toolCalls[0].result for this)
      if (m.role === 'system' && m.toolCalls && m.toolCalls[0]?.result != null) {
        const tc = m.toolCalls[0];
        out.push({
          role: 'tool',
          tool_call_id: tc.id ?? tc.name,
          content: tc.result,
        });
        continue;
      }
      // Message where the assistant initiates tool calls
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id ?? tc.name,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.parameters ?? {}) },
          })),
        });
        continue;
      }
      // Plain `system` messages were already merged into the leading system message; skip
      if (m.role === 'system') continue;
      out.push({ role: m.role, content: this.contentOf(m) });
    }
    return out;
  }

  /** P3: user messages carrying `images` → OpenAI multimodal content (text + image_url list) */
  private contentOf(m: ChatMessage): any {
    if (!m.images?.length) return m.content;
    return [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  }

  async chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      // P3: external `tools` argument (injected from `sidecar.listTools`); fall back to the built-in full set when omitted
      const toolDefs = tools ?? buildOpenAITools(false);
      const body = this.buildToolBody(this.buildToolMessages(messages), toolDefs);
      const res = await fetch(`${this.getBaseURL()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: s,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`));
      }
      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      const content: string = choice?.message?.content ?? '';

      const rawCalls = choice?.message?.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawCalls.map((c: any) => {
        let params: Record<string, any> = {};
        try { params = JSON.parse(c.function?.arguments || '{}'); } catch { params = {}; }
        return { id: c.id, name: c.function?.name, parameters: params };
      });

      return {
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: toolCalls.length ? 'tool_use' : 'stop',
        usage: data.usage
          ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
          : undefined,
      };
    } catch (err) {
      throw toLLMError(err, '工具调用请求失败');
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
