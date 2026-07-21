// src/renderer/hooks/useLLM.ts
//
// Chat-state hook (P1.2: wired up the agent tool loop).
//
// Key fix: previously `send()` only called the legacy `chatStream`/`chat` (plain chat),
// so P1's `window.api.llm.agent()` was never actually invoked by the UI —
// the model had no idea 26 tools existed, never drove SolidWorks, and could only
// answer "I can't see your SolidWorks".
//
// Current behaviour:
//   - OpenAI-compatible protocol (DeepSeek / Kimi / MiniMax / GPT) → goes through the
//     agent loop, consumes `tool_start` / `tool_result` / `confirm_request` /
//     `text` / `done` / `error` events, and renders the tool-call flow live
//     inside the assistant message.
//   - Anthropic protocol → still uses `chatStream` for now (the agent loop is
//     currently only implemented on the OpenAI side).
//
// Consumer: the `Chat` component.

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

  // Append a chunk of text to the trailing assistant message
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

  // ===== Legacy streaming-event subscription (used by the Anthropic fallback) =====
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

  // ===== Agent event subscription (used by the OpenAI-compatible path) =====
  useEffect(() => {
    const off = window.api.llm.onAgentEvent((ev: any) => {
      if (ev.requestId !== currentRequestId.current) return;
      switch (ev.type) {
        case 'start':
          // Session start (carries `backupPath`) — optional hint, kept quiet for now
          break;
        case 'text':
          // Narrative text emitted by the model in a given turn; appended in arrival order
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

      // OpenAI-compatible protocol → agent tool loop; Anthropic → legacy streaming fallback
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
        // The `ok` branch is finalized by the `done` event from `onAgentEvent`
        return;
      }

      // —— Anthropic fallback: streaming ——
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
