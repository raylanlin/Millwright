// src/main/llm/openai.ts
//
// OpenAI-compatible protocol adapter.
// Covers OpenAI, DeepSeek, Alibaba Bailian, MiniMax, SiliconFlow, Ollama, and others.
//
// P51 adds three things:
//   1. `chatWithToolsStream` — real token streaming WITH tool calls. Tool-call deltas
//      arrive fragmented (id in one frame, name in another, arguments a character at a
//      time) so they are accumulated per index and only parsed at the end.
//   2. Reasoning separation — providers send the scratchpad either as
//      `delta.reasoning_content` or inline as <think>…</think>; both are routed to a
//      `reasoning` channel so the UI can collapse it and history never carries it.
//   3. Reasoning controls + max_tokens — per-provider fields, with a one-shot retry
//      that drops them if the gateway rejects them (better than a hard 400).

import { BaseLLMAdapter, type ToolStreamChunk } from './adapter';
import { resolveSystemPrompt } from './prompts';
import { extractFirstCodeBlock } from './code-extract';
import { LLMHttpError, extractErrorMessage, toLLMError } from './errors';
import { parseSSE } from './sse';
import { buildOpenAITools } from './tools-schema';
import { ThinkSplitter, reasoningParams, isReasoningParamError, splitThinking } from './thinking';
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Accumulator for a single streamed tool call (fields arrive in fragments). */
interface PartialCall {
  id?: string;
  name?: string;
  args: string;
  announced?: boolean;
}

export class OpenAIAdapter extends BaseLLMAdapter {
  /** P51: extra body fields for reasoning depth — empty when set to 'auto'. */
  private reasoningExtras(): Record<string, any> {
    return reasoningParams(
      this.config.reasoningLevel,
      this.config.reasoningDialect,
      this.config.baseURL,
    );
  }

  private maxTokens(): number {
    return this.config.maxTokens ?? 8192;
  }

  private buildBody(messages: ChatMessage[], stream: boolean) {
    const { system: convoSystem, rest } = this.splitSystem(messages);
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, convoSystem].filter(Boolean).join('\n\n'),
    );

    const finalMessages = [
      { role: 'system', content: systemPrompt },
      ...rest.map((m) => ({ role: m.role, content: m.content })),
    ];

    return {
      model: this.config.model,
      messages: finalMessages,
      temperature: this.config.temperature ?? 0.3,
      max_tokens: this.maxTokens(),
      stream,
      ...this.reasoningExtras(),
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
      const res = await this.postWithReasoningFallback(this.buildBody(messages, false), s);
      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`));
      }

      let data: OpenAIResponseBody;
      try {
        data = JSON.parse(text);
      } catch {
        throw new LLMHttpError(res.status, text, '无法解析响应');
      }

      const choice = data.choices?.[0];
      // P51: drop any inline <think> block from the answer
      const { answer } = splitThinking(choice?.message?.content ?? '');
      const finishReason = mapFinishReason(choice?.finish_reason ?? null);
      const usage: LLMUsage | undefined = data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined;

      return this.finalize(answer, usage, finishReason);
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
    const splitter = new ThinkSplitter();

    try {
      yield { type: 'start', requestId };

      const res = await this.postWithReasoningFallback(this.buildBody(messages, true), s);
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`));
      }
      if (!res.body) throw new Error('流式响应缺少 body');

      for await (const ev of parseSSE(res.body)) {
        if (!ev.data || ev.data === '[DONE]') {
          if (ev.data === '[DONE]') break;
          continue;
        }
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { continue; }

        const choice = payload.choices?.[0];
        const raw = choice?.delta?.content;
        if (typeof raw === 'string' && raw.length > 0) {
          const { answer } = splitter.feed(raw);
          if (answer) {
            acc += answer;
            yield { type: 'delta', requestId, chunk: answer };
          }
        }
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
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
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `测试失败 (HTTP ${res.status})`));
      }
      return true;
    } catch (err) {
      throw toLLMError(err, '测试连接失败');
    } finally {
      cleanup();
    }
  }

  // —— Function Calling / Agent mode ——

  private buildToolBody(openAIMessages: any[], tools: any[], stream: boolean) {
    return {
      model: this.config.model,
      messages: openAIMessages,
      temperature: this.config.temperature ?? 0.3,
      max_tokens: this.maxTokens(),
      tools,
      tool_choice: 'auto',
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...this.reasoningExtras(),
    };
  }

  private buildToolMessages(messages: ChatMessage[]): any[] {
    const { system } = this.splitSystem(
      messages.filter((m) => !(m.role === 'system' && m.toolCalls)),
    );
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
    );
    const out: any[] = [{ role: 'system', content: systemPrompt }];

    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
        continue;
      }
      if (m.role === 'system' && m.toolCalls && m.toolCalls[0]?.result != null) {
        const tc = m.toolCalls[0];
        out.push({ role: 'tool', tool_call_id: tc.id ?? tc.name, content: tc.result });
        continue;
      }
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
      if (m.role === 'system') continue;
      out.push({ role: m.role, content: this.contentOf(m) });
    }
    return out;
  }

  /** User messages carrying `images` → OpenAI multimodal content (text + image_url list) */
  private contentOf(m: ChatMessage): any {
    if (!m.images?.length) return m.content;
    return [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  }

  /**
   * P51: POST, and if the gateway rejects our reasoning fields with a 400, retry ONCE
   * without them. A wrong guess about a provider's reasoning dialect should degrade to
   * "no reasoning control", never to a dead request.
   */
  private async postWithReasoningFallback(body: any, signal: AbortSignal): Promise<Response> {
    const url = `${this.getBaseURL()}/chat/completions`;
    const send = (b: any) => fetch(url, {
      method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(b), signal,
    });

    const extras = this.reasoningExtras();
    const res = await send(body);
    if (res.status !== 400 || Object.keys(extras).length === 0) return res;

    const text = await res.clone().text();
    if (!isReasoningParamError(text)) return res;

    const stripped = { ...body };
    for (const k of Object.keys(extras)) delete stripped[k];
    return send(stripped);
  }

  async chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const toolDefs = tools ?? buildOpenAITools(false);
      const body = this.buildToolBody(this.buildToolMessages(messages), toolDefs, false);
      const res = await this.postWithReasoningFallback(body, s);
      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`));
      }
      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      const { answer, reasoning } = splitThinking(choice?.message?.content ?? '');

      const rawCalls = choice?.message?.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawCalls.map((c: any) => {
        let params: Record<string, any> = {};
        try { params = JSON.parse(c.function?.arguments || '{}'); } catch { params = {}; }
        return { id: c.id, name: c.function?.name, parameters: params };
      });

      return {
        content: answer,
        reasoning: reasoning || choice?.message?.reasoning_content || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: toolCalls.length ? 'tool_use' : mapFinishReason(choice?.finish_reason ?? null),
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

  /**
   * P51: streaming tool-calling. Yields `text` / `reasoning` chunks as they arrive and
   * a final `done` with the assembled response.
   *
   * Tool-call fragments must be accumulated by INDEX: providers send the id in one
   * frame, the function name in another, and the JSON arguments a few characters at a
   * time across many frames. Parsing early yields malformed JSON.
   */
  async *chatWithToolsStream(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): AsyncIterable<ToolStreamChunk> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    const splitter = new ThinkSplitter();
    const partial = new Map<number, PartialCall>();
    let content = '';
    let reasoning = '';
    let finishReason: LLMResponse['finishReason'] = 'stop';
    let usage: LLMUsage | undefined;

    try {
      const toolDefs = tools ?? buildOpenAITools(false);
      const body = this.buildToolBody(this.buildToolMessages(messages), toolDefs, true);
      const res = await this.postWithReasoningFallback(body, s);
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `API 错误 (HTTP ${res.status})`));
      }
      if (!res.body) throw new Error('流式响应缺少 body');

      for await (const ev of parseSSE(res.body)) {
        if (!ev.data) continue;
        if (ev.data === '[DONE]') break;
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { continue; }

        if (payload.usage) {
          usage = {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
          };
        }
        const choice = payload.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // Dedicated reasoning channel (DeepSeek / Qwen / MiniMax / GLM)
        const rc = delta.reasoning_content ?? delta.reasoning;
        if (typeof rc === 'string' && rc) {
          reasoning += rc;
          yield { kind: 'reasoning', chunk: rc };
        }

        // Answer text — may still contain inline <think> for OSS models
        if (typeof delta.content === 'string' && delta.content) {
          const part = splitter.feed(delta.content);
          if (part.reasoning) {
            reasoning += part.reasoning;
            yield { kind: 'reasoning', chunk: part.reasoning };
          }
          if (part.answer) {
            content += part.answer;
            yield { kind: 'text', chunk: part.answer };
          }
        }

        // Tool-call fragments
        for (const tc of delta.tool_calls ?? []) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          const cur = partial.get(idx) ?? { args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = (cur.name ?? '') + tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          partial.set(idx, cur);
          // Announce as soon as the name is known so the UI can show the pending call
          if (cur.name && !cur.announced) {
            cur.announced = true;
            yield { kind: 'tool', name: cur.name };
          }
        }

        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      }

      const tail = splitter.flush();
      if (tail.reasoning) { reasoning += tail.reasoning; yield { kind: 'reasoning', chunk: tail.reasoning }; }
      if (tail.answer) { content += tail.answer; yield { kind: 'text', chunk: tail.answer }; }

      const toolCalls: ToolCall[] = [...partial.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, c]) => !!c.name)
        .map(([, c]) => {
          let params: Record<string, any> = {};
          try { params = JSON.parse(c.args || '{}'); } catch { params = {}; }
          return { id: c.id, name: c.name!, parameters: params };
        });

      yield {
        kind: 'done',
        response: {
          content,
          reasoning: reasoning || undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          finishReason: toolCalls.length ? 'tool_use' : finishReason,
          usage,
        },
      };
    } catch (err) {
      throw toLLMError(err, '流式工具调用失败');
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
    return { content, usage, code: code?.code, codeLanguage: code?.language, finishReason };
  }
}

function mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'stop';
  }
}
