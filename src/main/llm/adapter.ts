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
   * Lightweight connectivity test — sends a minimal "ping" request to verify
   * that the URL/key/model are usable.
   * Returns `true` on success; throws an `LLMErrorInfo` on failure.
   */
  test(signal?: AbortSignal): Promise<boolean>;
}

/**
 * Base class for adapters — provides shared utility methods.
 * Concrete protocol implementations only need to override `chat` / `chatStream` / `test`;
 * helpers like `getBaseURL`, `getHeaders`, and `doFetch` can be reused as-is.
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  constructor(protected readonly config: LLMConfig) {}

  abstract chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;

  abstract chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

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
   * Filter out all `role: "system"` messages from the array, concatenate them,
   * and leave the rest for the `messages` field.
   * Anthropic uses a top-level `system` parameter; OpenAI uses the first system message.
   */
  protected splitSystem(messages: ChatMessage[]): {
    system: string;
    rest: ChatMessage[];
  } {
    const systems: string[] = [];
    const rest: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') systems.push(m.content);
      else rest.push(m);
    }
    return { system: systems.join('\n\n'), rest };
  }
}
