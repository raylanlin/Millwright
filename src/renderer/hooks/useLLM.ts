// src/renderer/hooks/useLLM.ts
//
// Chat-state hook.
//
// P20: agent activity is now recorded as STRUCTURED steps on the trailing
// assistant message (`msg.steps`), not string-concatenated into `msg.content`.
// The old code appended "🔧 调用 X ↳ result" text for every event, so a whole
// multi-tool turn collapsed into one wall-of-text bubble. Now:
//   - `text`  → model prose: appended to `content` AND mirrored as a text step
//   - `tool_start` → push a { kind:'tool', status:'running' } step
//   - `tool_result` → upsert the matching tool step with status + result
//     (upsert so a rejected tool, which never fires tool_start, still shows)
//   - `backup` / `confirm` / `error` → small text steps
// ChatMessage renders steps in order (prose spans + <ToolCallCard/>). `content`
// still carries the model prose for cross-turn context + persistence.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LLMConfig,
  ChatMessage,
  AgentStep,
  LLMStreamEvent,
  LLMErrorInfo,
} from '../../shared/types';

export interface UseLLMOptions {
  config: LLMConfig;
  initial?: ChatMessage[];
}

function statusFromResult(result?: string): AgentStep['status'] {
  const r = (result ?? '').trimStart();
  if (r.startsWith('❌')) return 'error';
  if (r.startsWith('⛔')) return 'rejected';
  return 'ok';
}

export function useLLM({ config, initial }: UseLLMOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial ?? []);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<LLMErrorInfo | null>(null);
  const currentRequestId = useRef<string | null>(null);

  /** Map the trailing assistant message through `mut` (immutably). */
  const updateAssistant = useCallback((mut: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), mut(last)];
    });
  }, []);

  // Append model prose: into content (context/persistence) + mirror as a trailing text step
  const appendText = useCallback((text: string) => {
    updateAssistant((m) => {
      const steps = [...(m.steps ?? [])];
      const last = steps[steps.length - 1];
      if (last && last.kind === 'text') {
        steps[steps.length - 1] = { ...last, text: (last.text ?? '') + text };
      } else {
        steps.push({ kind: 'text', text });
      }
      return { ...m, content: m.content + text, steps };
    });
  }, [updateAssistant]);

  const setAssistantContent = useCallback((text: string) => {
    updateAssistant((m) => ({ ...m, content: text }));
  }, [updateAssistant]);

  const pushToolStep = useCallback((tc: any) => {
    updateAssistant((m) => ({
      ...m,
      steps: [...(m.steps ?? []), {
        kind: 'tool',
        id: tc?.id ?? tc?.name,
        name: tc?.name,
        params: tc?.parameters,
        status: 'running',
      }],
    }));
  }, [updateAssistant]);

  // Upsert: fill the last running step with this name/id; if none, append one (rejected path has no tool_start)
  const resolveToolStep = useCallback((tc: any) => {
    updateAssistant((m) => {
      const steps = [...(m.steps ?? [])];
      const key = tc?.id ?? tc?.name;
      const status = statusFromResult(tc?.result);
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.kind === 'tool' && (s.id === key || s.name === tc?.name) && s.status === 'running') {
          steps[i] = { ...s, status, result: tc?.result, params: s.params ?? tc?.parameters };
          return { ...m, steps };
        }
      }
      steps.push({ kind: 'tool', id: key, name: tc?.name, params: tc?.parameters, status, result: tc?.result });
      return { ...m, steps };
    });
  }, [updateAssistant]);

  const pushNote = useCallback((text: string) => {
    updateAssistant((m) => ({ ...m, steps: [...(m.steps ?? []), { kind: 'text', text }] }));
  }, [updateAssistant]);

  // ===== Legacy streaming-event subscription (Anthropic fallback path) =====
  useEffect(() => {
    const off = window.api.llm.onStreamEvent((ev: LLMStreamEvent) => {
      if (ev.requestId !== currentRequestId.current) return;
      switch (ev.type) {
        case 'delta':
          appendText(ev.chunk);
          break;
        case 'done':
          updateAssistant((m) => ({
            ...m,
            content: ev.response.content,
            code: ev.response.code,
            codeLanguage: ev.response.codeLanguage,
          }));
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
        case 'error':
          setError(ev.error);
          pushNote(`⚠️ ${ev.error.message}`);
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
      }
    });
    return off;
  }, [appendText, updateAssistant, pushNote]);

  // ===== Agent event subscription (main path) =====
  useEffect(() => {
    const off = window.api.llm.onAgentEvent((ev: any) => {
      if (ev.requestId !== currentRequestId.current) return;
      switch (ev.type) {
        case 'start':
          break;
        case 'backup':
          if (ev.backupPath) pushNote(`💾 已自动备份当前文档：${ev.backupPath}`);
          break;
        case 'text':
          if (ev.text) appendText(ev.text);
          break;
        case 'tool_start':
          pushToolStep(ev.toolCall);
          break;
        case 'tool_result':
          resolveToolStep(ev.toolCall);
          break;
        case 'confirm_request': {
          // P28: inline confirm card instead of window.confirm — push a 'confirm'
          // step; ConfirmCard resolves it via the 'swcp-confirm' window event below.
          const tc = ev.toolCall;
          updateAssistant((m) => ({
            ...m,
            steps: [...(m.steps ?? []), {
              kind: 'confirm',
              id: tc?.id ?? tc?.name,
              name: tc?.name,
              params: tc?.parameters,
              status: 'running',
              requestId: ev.requestId,
            }],
          }));
          break;
        }
        case 'done':
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
        case 'error':
          setError({ code: 'AGENT_ERROR', message: ev.error } as LLMErrorInfo);
          pushNote(`⚠️ ${ev.error}`);
          setIsGenerating(false);
          currentRequestId.current = null;
          break;
      }
    });
    return off;
  }, [appendText, pushToolStep, resolveToolStep, pushNote]);

  // P28: resolve inline confirm cards (dispatched by ConfirmCard — avoids prop drilling)
  useEffect(() => {
    const onConfirm = (e: Event) => {
      const { requestId, callId, approved } = (e as CustomEvent).detail;
      window.api.llm.confirmReply(requestId, callId, approved);
      updateAssistant((m) => {
        const steps = [...(m.steps ?? [])];
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i];
          if (s.kind === 'confirm' && s.id === callId && s.status === 'running') {
            steps[i] = { ...s, status: approved ? 'ok' : 'rejected' };
            break;
          }
        }
        return { ...m, steps };
      });
    };
    window.addEventListener('swcp-confirm', onConfirm);
    return () => window.removeEventListener('swcp-confirm', onConfirm);
  }, [updateAssistant]);

  const send = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (!trimmed || isGenerating) return;

      setError(null);
      const userMsg: ChatMessage = { role: 'user', content: trimmed, timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', steps: [], timestamp: Date.now() }]);
      setIsGenerating(true);
      const payloadMessages = [...messages, userMsg];

      // Both protocols run the agent path (P5: Anthropic has native tool_use too)
      const { requestId, promise } = window.api.llm.agent(config, payloadMessages);
      currentRequestId.current = requestId;
      const res = await promise;
      if (!res.ok) {
        setError(res.error);
        setAssistantContent(`⚠️ ${res.error.message}`);
        setIsGenerating(false);
        currentRequestId.current = null;
      }
      // The ok branch is finalized by the `done` agent event
    },
    [config, messages, isGenerating, setAssistantContent],
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
