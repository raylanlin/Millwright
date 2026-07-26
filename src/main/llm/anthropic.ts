// src/main/llm/anthropic.ts
//
// Anthropic Messages API adapter.
// Uses raw `fetch` + hand-written SSE parsing.
//
// P5: implements `chatWithTools` — the Anthropic protocol drives the agent loop
// natively via `tool_use` / `tool_result` content blocks. Tool schemas arrive in the
// OpenAI function format (internal lingua franca, straight from sidecar.list_tools) and
// are converted on the wire.
//
// P53: adds `chatWithToolsStream`. Anthropic's stream is block-structured rather than
// a flat delta feed: content_block_start announces each block (text / thinking /
// tool_use, the latter carrying id + name), content_block_delta carries text_delta,
// thinking_delta or input_json_delta (tool arguments, a few characters at a time), and
// content_block_stop closes it. So tool input is accumulated per block index and only
// parsed at content_block_stop — parsing earlier yields malformed JSON.
//
// Docs: https://docs.claude.com/en/api/messages

import { BaseLLMAdapter, type ToolStreamChunk } from './adapter';
import { resolveSystemPrompt } from './prompts';
import { extractFirstCodeBlock } from './code-extract';
import { LLMHttpError, extractErrorMessage, toLLMError } from './errors';
import { parseSSE } from './sse';
import { splitThinking } from './thinking';
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

/** P53: one in-flight content block during a streamed turn. */
interface StreamBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'other';
  id?: string;
  name?: string;
  json: string;
  announced?: boolean;
}

export class AnthropicAdapter extends BaseLLMAdapter {
  private maxTokens(): number {
    return this.config.maxTokens ?? 8192;
  }

  /**
   * P53: extended thinking. Anthropic takes a budget, not a level, and requires
   * budget_tokens < max_tokens. 'auto' sends nothing (model default).
   */
  private thinkingExtras(): Record<string, any> {
    const lv = this.config.reasoningLevel ?? 'auto';
    if (lv === 'auto') return {};
    if (lv === 'off') return { thinking: { type: 'disabled' } };
    const budgets: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
    const budget = Math.min(budgets[lv] ?? 4096, Math.max(1024, this.maxTokens() - 1024));
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }

  private buildBody(messages: ChatMessage[], stream: boolean) {
    const { system, rest } = this.splitSystem(messages);
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
    );

    return {
      model: this.config.model,
      max_tokens: this.maxTokens(),
      temperature: this.config.temperature ?? 0.3,
      system: systemPrompt,
      stream,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      ...this.thinkingExtras(),
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

  /**
   * P53: POST, and if the gateway rejects the `thinking` field with a 400, retry ONCE
   * without it. An Anthropic-compatible proxy that predates extended thinking should
   * degrade to "no reasoning control", never to a dead request.
   */
  private async post(body: any, signal: AbortSignal): Promise<Response> {
    const url = `${this.getBaseURL()}/v1/messages`;
    const send = (b: any) => fetch(url, {
      method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(b), signal,
    });
    const res = await send(body);
    if (res.status !== 400 || !('thinking' in body)) return res;
    const text = await res.clone().text();
    if (!/thinking/i.test(text)) return res;
    const stripped = { ...body };
    delete stripped.thinking;
    return send(stripped);
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await this.post(this.buildBody(messages, false), s);

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

      // P53: drop any inline <think> block (OSS models behind Anthropic-compatible proxies)
      return this.finalize(splitThinking(content).answer, data.usage, data.stop_reason);
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

      const res = await this.post(this.buildBody(messages, true), s);

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

  private buildToolBody(messages: ChatMessage[], tools: any[] | undefined, stream: boolean) {
    const { system, wire } = this.buildToolMessages(messages);
    const systemPrompt = resolveSystemPrompt(
      [this.config.systemPrompt, system].filter(Boolean).join('\n\n'),
    );
    const body: any = {
      model: this.config.model,
      max_tokens: this.maxTokens(),
      temperature: this.config.temperature ?? 0.3,
      system: systemPrompt,
      stream,
      messages: wire,
      ...this.thinkingExtras(),
    };
    if (tools && tools.length > 0) body.tools = this.toAnthropicTools(tools);
    // Extended thinking requires the default temperature
    if (body.thinking?.type === 'enabled') delete body.temperature;
    return body;
  }

  async chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    try {
      const res = await this.post(this.buildToolBody(messages, tools, false), s);
      const text = await res.text();
      if (!res.ok) {
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `Anthropic API 错误 (HTTP ${res.status})`));
      }
      const data = JSON.parse(text);

      let content = '';
      let reasoning = '';
      const toolCalls: ToolCall[] = [];
      for (const block of data.content ?? []) {
        if (block.type === 'text') content += block.text;
        else if (block.type === 'thinking') reasoning += block.thinking ?? '';
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, parameters: block.input ?? {} });
        }
      }
      const split = splitThinking(content);

      return {
        content: split.answer,
        reasoning: [reasoning, split.reasoning].filter(Boolean).join('\n') || undefined,
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

  /**
   * P53: streaming tool-calling.
   *
   * Anthropic's stream is block-structured, not a flat delta feed:
   *   content_block_start  → a new block; for tool_use it carries id + name
   *   content_block_delta  → text_delta | thinking_delta | input_json_delta
   *   content_block_stop   → block finished (only now is tool JSON complete)
   * Tool arguments therefore accumulate per block index and are parsed at stop.
   */
  async *chatWithToolsStream(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): AsyncIterable<ToolStreamChunk> {
    const { signal: s, cleanup } = this.withTimeout(signal);
    const blocks = new Map<number, StreamBlock>();
    const toolCalls: ToolCall[] = [];
    let content = '';
    let reasoning = '';
    let stopReason: string | null = null;
    const usage: { input_tokens?: number; output_tokens?: number } = {};

    try {
      const res = await this.post(this.buildToolBody(messages, tools, true), s);
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(res.status, text,
          extractErrorMessage(text, `Anthropic API 错误 (HTTP ${res.status})`));
      }
      if (!res.body) throw new Error('Anthropic 流式响应缺少 body');

      for await (const ev of parseSSE(res.body)) {
        if (!ev.data || ev.data === '[DONE]') continue;
        let payload: any;
        try { payload = JSON.parse(ev.data); } catch { continue; }

        switch (payload.type) {
          case 'message_start':
            if (payload.message?.usage) {
              usage.input_tokens = payload.message.usage.input_tokens;
              usage.output_tokens = payload.message.usage.output_tokens;
            }
            break;

          case 'content_block_start': {
            const idx = payload.index ?? 0;
            const b = payload.content_block ?? {};
            const kind: StreamBlock['type'] =
              b.type === 'text' ? 'text'
              : b.type === 'thinking' || b.type === 'redacted_thinking' ? 'thinking'
              : b.type === 'tool_use' ? 'tool_use'
              : 'other';
            const block: StreamBlock = { type: kind, id: b.id, name: b.name, json: '' };
            blocks.set(idx, block);
            // Announce the tool as soon as its name is known — arguments still streaming
            if (kind === 'tool_use' && b.name) {
              block.announced = true;
              yield { kind: 'tool', name: b.name };
            }
            break;
          }

          case 'content_block_delta': {
            const idx = payload.index ?? 0;
            const block = blocks.get(idx);
            const d = payload.delta ?? {};
            if (d.type === 'text_delta' && typeof d.text === 'string') {
              content += d.text;
              yield { kind: 'text', chunk: d.text };
            } else if ((d.type === 'thinking_delta' || d.type === 'signature_delta')
                       && typeof d.thinking === 'string') {
              reasoning += d.thinking;
              yield { kind: 'reasoning', chunk: d.thinking };
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              if (block) block.json += d.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            const block = blocks.get(payload.index ?? 0);
            if (block?.type === 'tool_use' && block.name) {
              let params: Record<string, any> = {};
              try { params = JSON.parse(block.json || '{}'); } catch { params = {}; }
              toolCalls.push({ id: block.id, name: block.name, parameters: params });
            }
            break;
          }

          case 'message_delta':
            if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
            if (payload.usage?.output_tokens != null) usage.output_tokens = payload.usage.output_tokens;
            break;

          case 'error':
            throw new Error(payload.error?.message ?? 'Anthropic 流式错误');

          default:
            break;
        }
      }

      const split = splitThinking(content);
      yield {
        kind: 'done',
        response: {
          content: split.answer,
          reasoning: [reasoning, split.reasoning].filter(Boolean).join('\n') || undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          finishReason: toolCalls.length ? 'tool_use'
            : stopReason === 'max_tokens' ? 'length' : 'stop',
          usage: usage.input_tokens != null
            ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens ?? 0 }
            : undefined,
        },
      };
    } catch (err) {
      throw toLLMError(err, 'Anthropic 流式工具调用失败');
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
