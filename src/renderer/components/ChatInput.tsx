// src/renderer/components/ChatInput.tsx

import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ThemeTokens } from '../themes';

interface Props {
  t: ThemeTokens;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel?: () => void;
  isGenerating: boolean;
  placeholder?: string;
  hint?: string;
}

export interface ChatInputHandle {
  focus: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { t, value, onChange, onSend, onCancel, isGenerating, placeholder, hint },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);

  const canSend = value.trim().length > 0 && !isGenerating;

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div style={{ padding: '14px 18px', borderTop: `1px solid ${t.sidebarBorder}`, flexShrink: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          background: t.card,
          borderRadius: 10,
          border: `1px solid ${t.cardBorder}`,
          padding: '3px 3px 3px 14px',
        }}
      >
        <textarea
          ref={ta}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder ?? '描述你想在 SolidWorks 中执行的操作…'}
          rows={1}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            color: t.text,
            fontSize: 13,
            outline: 'none',
            resize: 'none',
            padding: '9px 0',
            lineHeight: 1.5,
            fontFamily: 'inherit',
            maxHeight: 140,
            minHeight: 22,
          }}
        />
        {isGenerating && onCancel ? (
          <button
            onClick={onCancel}
            title="取消生成"
            style={{
              width: 36, height: 36, borderRadius: 8, border: `1px solid ${t.cardBorder}`,
              background: t.cardAlt, color: t.textSecondary,
              cursor: 'pointer', fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontFamily: 'inherit',
            }}
          >
            ⏹
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!canSend}
            title="发送 (Enter)"
            style={{
              width: 36, height: 36, borderRadius: 8, border: 'none',
              background: canSend ? t.btnPrimary : t.cardAlt,
              color: canSend ? t.btnPrimaryText : t.textMuted,
              cursor: canSend ? 'pointer' : 'default',
              fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontFamily: 'inherit',
            }}
          >
            ↑
          </button>
        )}
      </div>
      {hint && (
        <div style={{ textAlign: 'center', marginTop: 6, fontSize: 10, color: t.textMuted }}>
          {hint}
        </div>
      )}
    </div>
  );
});
