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
