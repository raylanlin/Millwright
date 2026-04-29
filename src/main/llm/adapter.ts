// src/main/llm/adapter.ts

import type {
  LLMConfig,
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
} from '../../shared/types';

/**
 * LLM 适配器接口 —— Anthropic 和 OpenAI 兼容协议都实现它。
 *
 * 设计约定:
 * - chat() 一次性返回完整响应,内部不做流式(即使服务端支持也合并)
 * - chatStream() 流式返回,通过 AsyncIterable 逐块 yield 事件
 * - 所有网络/解析错误都通过抛出 LLMErrorInfo 结构(不抛原始 Error)
 * - 取消通过 AbortSignal 实现
 */
export interface LLMAdapter {
  /**
   * 一次性聊天,等完整响应后返回。
   * @throws LLMErrorInfo
   */
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;

  /**
   * 流式聊天,返回事件异步迭代器。
   * 消费方负责处理 delta/done/error 事件。
   */
  chatStream(
    messages: ChatMessage[],
    requestId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

  /**
   * 轻量测试连接 —— 发一个最短的 "ping" 请求,验证 URL/Key/模型是否可用。
   * 成功返回 true,失败抛 LLMErrorInfo。
   */
  test(signal?: AbortSignal): Promise<boolean>;
}

/**
 * 适配器的基类,提供两端共用的工具方法。
 * 各协议实现只需要重写 chat/chatStream/test,可以复用 getBaseURL/getHeaders/doFetch 等。
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

  /** baseURL 去掉尾部斜杠,拼接路径时更稳定 */
  protected getBaseURL(): string {
    return this.config.baseURL.replace(/\/+$/, '');
  }

  /** 组合 AbortSignal + 超时 */
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
   * 把消息数组中 role=system 的内容过滤出来合并,其余留给 messages 字段。
   * Anthropic 用 system 参数,OpenAI 用首条 system 消息。
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
