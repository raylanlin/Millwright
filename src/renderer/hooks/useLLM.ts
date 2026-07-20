// src/renderer/hooks/useLLM.ts
//
// 聊天状态 hook（P1.2：接通 agent 工具循环）。
//
// 关键修复：此前 send() 只调用旧的 chatStream/chat（纯聊天），P1 的
// window.api.llm.agent() 从没被 UI 调用 —— 导致模型不知道有 26 个工具、
// 也不驱动 SolidWorks，只会回答“我看不到你的 SolidWorks”。
//
// 现在：
//   - OpenAI 兼容协议（DeepSeek / Kimi / MiniMax / GPT）→ 走 agent 循环，
//     消费 tool_start / tool_result / confirm_request / text / done / error 事件，
//     把工具调用过程实时渲染进助手消息。
//   - Anthropic 协议 → 暂时仍走 chatStream（agent 目前只实现了 OpenAI 侧）。
//
// 使用方：Chat 组件。

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LLMConfig,
  ChatMessage,
  LLMStreamEvent,
  LLMErrorInfo,
} from '../../shared/types';

export interface UseLLMOptions {
  config: LLMConfig;
  initial?: ChatMessage[];
}

function paramPreview(params?: Record<string, any>): string {
  if (!params || Object.keys(params).length === 0) return '';
  try {
    const s = JSON.stringify(params);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return '';
  }
}

export function useLLM({ config, initial }: UseLLMOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial ?? []);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<LLMErrorInfo | null>(null);
  const currentRequestId = useRef<string | null>(null);

  // 把一段文本追加进最后一条 assistant 消息
  const appendToAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), { ...last, content: last.content + text }];
    });
  }, []);

  const setAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), { ...last, content: text }];
    });
  }, []);

  // ===== 旧的流式事件订阅（anthropic 兜底路径用）=====
  useEffect(() => {
    const off = window.api.llm.onStreamEvent((ev: LLMStreamEvent) => {
      if (ev.requestId !== currentRequestId.current) return;
      switch (ev.type) {
        case 'delta':
          appendToAssistant(ev.chunk);
          break;
        case 'done':
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, content: ev.response.content, code: ev.response.code, codeLanguage: ev.response.codeLanguage },
            ];
          });
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
        case 'error':
          setError(ev.error);
          appendToAssistant(`\n\n⚠️ ${ev.error.message}`);
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
      }
    });
    return off;
  }, [appendToAssistant]);

  // ===== agent 事件订阅（OpenAI 兼容路径用）=====
  useEffect(() => {
    const off = window.api.llm.onAgentEvent((ev: any) => {
      if (ev.requestId !== currentRequestId.current) return;
      switch (ev.type) {
        case 'start':
          // 会话开始（含 backupPath）——可选提示，这里不打扰用户
          break;
        case 'text':
          // 模型在某一轮输出的叙述文本，按到达顺序追加
          if (ev.text) appendToAssistant(ev.text);
          break;
        case 'tool_start': {
          const tc = ev.toolCall;
          const pv = paramPreview(tc?.parameters);
          appendToAssistant(`\n\n🔧 调用 **${tc?.name}**${pv ? ` \`${pv}\`` : ''}`);
          break;
        }
        case 'tool_result': {
          const tc = ev.toolCall;
          appendToAssistant(`\n↳ ${tc?.result ?? ''}`);
          break;
        }
        case 'confirm_request': {
          const tc = ev.toolCall;
          const pv = paramPreview(tc?.parameters);
          const ok = window.confirm(
            `AI 想执行可能修改模型的操作：\n\n${tc?.name} ${pv}\n\n是否允许？`,
          );
          const callId = tc?.id ?? tc?.name;
          window.api.llm.confirmReply(ev.requestId, callId, ok);
          appendToAssistant(`\n\n${ok ? '✅ 已允许' : '⛔ 已拒绝'}：${tc?.name}`);
          break;
        }
        case 'done':
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
        case 'error':
          setError({ code: 'AGENT_ERROR', message: ev.error } as LLMErrorInfo);
          appendToAssistant(`\n\n⚠️ ${ev.error}`);
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
      }
    });
    return off;
  }, [appendToAssistant]);

  const send = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (!trimmed || isGenerating) return;

      setError(null);
      const userMsg: ChatMessage = { role: 'user', content: trimmed, timestamp: Date.now() };
      setMessages([...messages, userMsg, { role: 'assistant', content: '', timestamp: Date.now() }]);
      setIsGenerating(true);
      const payloadMessages = [...messages, userMsg];

      // OpenAI 兼容协议 → agent 工具循环；anthropic → 旧流式兜底
      const useAgent = config.protocol === 'openai';

      if (useAgent) {
        const { requestId, promise } = window.api.llm.agent(config, payloadMessages);
        currentRequestId.current = requestId;
        const res = await promise;
        if (!res.ok) {
          setError(res.error);
          setAssistant(`⚠️ ${res.error.message}`);
          setIsGenerating(false);
          currentRequestId.current = null;
        }
        // ok 分支由 onAgentEvent 的 done 事件收尾
        return;
      }

      // —— anthropic 兜底：流式 ——
      const res = await window.api.llm.chatStream(config, payloadMessages);
      if (!res.ok) {
        setError(res.error);
        setAssistant(`⚠️ ${res.error.message}`);
        setIsGenerating(false);
        return;
      }
      currentRequestId.current = res.requestId;
    },
    [config, messages, isGenerating, setAssistant],
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
