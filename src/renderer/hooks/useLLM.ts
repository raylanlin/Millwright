// src/renderer/hooks/useLLM.ts
//
// 聊天状态 hook。
// 职责:
//   - 维护消息列表
//   - 调度主进程的流式 / 非流式 LLM 请求
//   - 处理 delta 事件、错误、取消
//
// 使用方:Chat 组件。

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LLMConfig,
  ChatMessage,
  LLMStreamEvent,
  LLMErrorInfo,
} from '../../shared/types';

export interface UseLLMOptions {
  config: LLMConfig;
  /** 初始消息(如欢迎词),只在 hook 初次 mount 时使用 */
  initial?: ChatMessage[];
}

export interface UseLLMState {
  messages: ChatMessage[];
  isGenerating: boolean;
  error: LLMErrorInfo | null;
}

export function useLLM({ config, initial }: UseLLMOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial ?? []);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<LLMErrorInfo | null>(null);
  const currentRequestId = useRef<string | null>(null);

  // 订阅流式事件。只订一次,handler 根据 currentRequestId 过滤。
  useEffect(() => {
    const off = window.api.llm.onStreamEvent((ev: LLMStreamEvent) => {
      if (ev.requestId !== currentRequestId.current) return;

      switch (ev.type) {
        case 'start':
          // 已经在 send 时预先插入了空 assistant 消息,这里不重复
          break;

        case 'delta':
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            const updated: ChatMessage = { ...last, content: last.content + ev.chunk };
            return [...prev.slice(0, -1), updated];
          });
          break;

        case 'done':
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            const updated: ChatMessage = {
              ...last,
              // 以 done 返回的完整 content 为准,避免边界字符丢失
              content: ev.response.content,
              code: ev.response.code,
              codeLanguage: ev.response.codeLanguage,
            };
            return [...prev.slice(0, -1), updated];
          });
          setIsGenerating(false);
          currentRequestId.current = null;
          break;

        case 'error':
          setError(ev.error);
          setIsGenerating(false);
          // 把错误信息写到最后一条 assistant 消息里
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            const suffix = last.content ? '\n\n' : '';
            const updated: ChatMessage = {
              ...last,
              content: `${last.content}${suffix}⚠️ ${ev.error.message}`,
            };
            return [...prev.slice(0, -1), updated];
          });
          currentRequestId.current = null;
          break;
      }
    });
    return off;
  }, []);

  const send = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (!trimmed || isGenerating) return;

      setError(null);
      const userMsg: ChatMessage = {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };
      // 先插入用户消息 + 占位 assistant
      const next: ChatMessage[] = [
        ...messages,
        userMsg,
        { role: 'assistant', content: '', timestamp: Date.now() },
      ];
      setMessages(next);
      setIsGenerating(true);

      // 发给主进程的消息序列 = 全历史 + 本次用户输入(不含占位)
      const payloadMessages = [...messages, userMsg];

      // ---- 自动采集文档上下文并注入 system prompt ----
      let enrichedConfig = config;
      try {
        const ctxResult = await window.api.sw.getContext();
        if (ctxResult.ok && ctxResult.formatted) {
          const base = config.systemPrompt || '';
          enrichedConfig = {
            ...config,
            systemPrompt: base + '\n\n' + ctxResult.formatted,
          };
        }
      } catch {
        // 上下文采集失败不阻塞对话
      }

      if (config.stream !== false) {
        const res = await window.api.llm.chatStream(enrichedConfig, payloadMessages);
        if (!res.ok) {
          setError(res.error);
          setIsGenerating(false);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, content: `⚠️ ${res.error.message}` },
            ];
          });
          return;
        }
        currentRequestId.current = res.requestId;
      } else {
        const res = await window.api.llm.chat(enrichedConfig, payloadMessages);
        if (!res.ok) {
          const errInfo =
            'error' in res
              ? (res.error as LLMErrorInfo)
              : ({ code: 'LLM_UNKNOWN', message: '未知错误' } as LLMErrorInfo);
          setError(errInfo);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            return [...prev.slice(0, -1), { ...last, content: `⚠️ ${errInfo.message}` }];
          });
          setIsGenerating(false);
          return;
        }
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: res.response.content,
              code: res.response.code,
              codeLanguage: res.response.codeLanguage,
            },
          ];
        });
        setIsGenerating(false);
      }
    },
    [config, messages, isGenerating],
  );

  const cancel = useCallback(async () => {
    if (currentRequestId.current) {
      await window.api.llm.cancel(currentRequestId.current);
      currentRequestId.current = null;
      setIsGenerating(false);
    }
  }, []);

  const reset = useCallback((keepFirst = true) => {
    setMessages((prev) => (keepFirst && prev.length > 0 ? [prev[0]] : []));
    setError(null);
  }, []);

  return { messages, isGenerating, error, send, cancel, reset, setMessages };
}
