// src/main/llm/adapter.ts (P51 additions marked)
//
// P51: adds an OPTIONAL streaming tool-calling method. Adapters that implement it get
// real token-by-token output; those that don't fall back to chatWithTools untouched.

import type {
  LLMConfig,
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
} from '../../shared/types';

/** P51: one frame of a streaming tool-calling turn. */
export type ToolStreamChunk =
  | { kind: 'text'; chunk: string }
  | { kind: 'reasoning'; chunk: string }
  | { kind: 'tool'; name: string }
  | { kind: 'done'; response: LLMResponse };

export interface LLMAdapter {
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;

  chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

  chatWithTools(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): Promise<LLMResponse>;

  /** P51: streaming variant — optional, so protocols can adopt it independently. */
  chatWithToolsStream?(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: any[],
  ): AsyncIterable<ToolStreamChunk>;

  test(signal?: AbortSignal): Promise<boolean>;
}

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
    const { signal, cleanup, reset } = this.withIdleTimeout(external);
    void reset;  // total-timeout semantics: no reset used
    return { signal, cleanup };
  }

  /**
   * Idle timeout for STREAMING: abort only when NO data has arrived for `idleMs`.
   *
   * P102: the old withTimeout was a fixed 120s TOTAL timeout — a reasoning model
   * (MiniMax M3, DeepSeek) that thinks for 130s before emitting its first token got
   * killed mid-thought with "流式工具调用失败: timeout". Streaming has a natural
   * heartbeat (every SSE chunk), so the correct semantics are: abort only when the
   * stream goes silent for idleMs. Call `reset()` on every received event.
   */
  protected withIdleTimeout(external?: AbortSignal, idleMs?: number): {
    signal: AbortSignal;
    cleanup: () => void;
    reset: () => void;
  } {
    const controller = new AbortController();
    const ms = idleMs ?? this.config.timeoutMs ?? 120_000;
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    };
    arm();

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
      reset: arm,
    };
  }

  /**
   * Filter out all plain `role:"system"` messages, concatenate them, and leave
   * the rest for the `messages` field.
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
