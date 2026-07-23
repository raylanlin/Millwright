// src/main/llm/adapter.ts

import type {
  LLMConfig,
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
} from '../../shared/types';

/**
 * LLM adapter interface — implemented by both the Anthropic and OpenAI-compatible protocols.
 *
 * Design conventions:
 * - `chat()` returns the full response in one shot; no internal streaming (even when the server supports it).
 * - `chatStream()` streams events back via an `AsyncIterable`.
 * - `chatWithTools()` (P5: now part of the base contract) sends the tool schema and
 *   returns content + structured toolCalls — the agent loop's single entry point.
 * - All network/parsing errors are surfaced by throwing an `LLMErrorInfo` (never a raw `Error`).
 * - Cancellation is implemented via `AbortSignal`.
 */
export interface LLMAdapter {
  /**
   * One-shot chat; waits for the complete response before returning.
   * @throws LLMErrorInfo
   */
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;

  /**
   * Streaming chat; returns an async iterator of events.
   * Consumers are responsible for handling `delta` / `done` / `error` events.
   */
  chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

  /**
   * P5: tool-calling chat. `tools` uses the OpenAI function-schema format
   * ({type:'function',function:{name,description,parameters}}) as the internal
   * lingua franca; the Anthropic adapter converts it on the wire.
   */
  chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse>;

  /**
   * Lightweight connectivity test — sends a minimal "ping" request to verify
   * that the URL/key/model are usable.
   * Returns `true` on success; throws an `LLMErrorInfo` on failure.
   */
  test(signal?: AbortSignal): Promise<boolean>;
}

/**
 * Base class for adapters — provides shared utility methods.
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  constructor(protected readonly config: LLMConfig) {}

  abstract chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;

  abstract chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

  abstract chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse>;

  abstract test(signal?: AbortSignal): Promise<boolean>;

  /** Strip trailing slashes from `baseURL` for stable path concatenation */
  protected getBaseURL(): string {
    return this.config.baseURL.replace(/\/+$/, '');
  }

  /** Combine an external `AbortSignal` with an internal timeout */
  protected withTimeout(external?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    const onAbort = () => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onAbort, { once: true });
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      },
    };
  }

  /**
   * Filter out all plain `role:"system"` messages, concatenate them, and leave
   * the rest for the `messages` field. Tool-result messages (role:'tool', or the
   * legacy system+toolCalls encoding) are NOT system text and stay in `rest`.
   */
  protected splitSystem(messages: ChatMessage[]): {
    system: string;
    rest: ChatMessage[];
  } {
    const systems: string[] = [];
    const rest: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system' && !m.toolCalls) systems.push(m.content);
      else rest.push(m);
    }
    return { system: systems.join('\n\n'), rest };
  }
}
