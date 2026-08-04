// src/renderer/components/Chat.tsx
//
// Message list + auto-scroll.
// The input box and execution logic are owned by the parent `App` — `Chat` does
// not know about business logic, it just renders the messages and scrolls.

import { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMsg, ScriptResult } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';
import { ChatMessage } from './ChatMessage';

interface Props {
  t: ThemeTokens;
  messages: ChatMsg[];
  isGenerating: boolean;
  /** Execution result for each message (keyed by message index) */
  execResults: Record<number, ScriptResult>;
  executingIndex: number | null;
  onRunScript: (index: number, code: string, lang: 'vba' | 'python') => void;
  onCopyCode: (code: string) => void;
}

export function Chat({
  t,
  messages,
  isGenerating,
  execResults,
  executingIndex,
  onRunScript,
  onCopyCode,
}: Props) {
  const tr = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  // P107: don't yank the scroll position away from the user. If they scrolled UP
  // to read something while a stream is running, auto-scroll would fight them on
  // every token. Only follow when the user is already at (or near) the bottom.
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // Within 48px of the bottom → keep following; otherwise let the user read.
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // When the message list changes, auto-scroll to the bottom ONLY if the user is
  // already there — never interrupt an upward read. (scrollTop assignment avoids
  // whole-page scroll jank caused by per-token scrolling during streaming.)
  useEffect(() => {
    const el = containerRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.content, isGenerating]);

  return (
    <div ref={containerRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      {messages.map((msg, i) => (
        <ChatMessage
          key={i}
          msg={msg}
          t={t}
          execResult={execResults[i]}
          isExecuting={executingIndex === i}
          onRunScript={
            msg.code ? (code, lang) => onRunScript(i, code, lang) : undefined
          }
          onCopyCode={msg.code ? onCopyCode : undefined}
        />
      ))}
      {isGenerating && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '10px 14px',
            color: t.textMuted,
            fontSize: 13,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: t.dot,
              animation: 'pulse 1.4s infinite',
            }}
          />
          {tr('chat.generating')}
        </div>
      )}
    </div>
  );
}
