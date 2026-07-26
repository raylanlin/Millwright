// src/renderer/components/ThinkingBlock.tsx
//
// P51: collapsible reasoning panel. Reasoning models emit thousands of words of
// scratchpad; dumping it into the chat buries the answer, but hiding it entirely
// leaves the user staring at nothing for a minute wondering if the app is stuck.
// So: always visible as a compact one-line strip that streams a live word count,
// click to read it, collapsed again by default on the next turn.

import { useEffect, useRef, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';

const L = {
  zh: { live: '正在思考', done: '思考过程', chars: (n: number) => `${n} 字`, hide: '收起' },
  en: { live: 'Thinking', done: 'Reasoning', chars: (n: number) => `${n} chars`, hide: 'Hide' },
} as const;

export function ThinkingBlock({
  text,
  streaming,
  t,
}: {
  text: string;
  streaming?: boolean;
  t: ThemeTokens;
}) {
  const { locale } = useLocale();
  const tr = L[locale === 'zh' ? 'zh' : 'en'];
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // While streaming and expanded, keep the newest reasoning in view.
  useEffect(() => {
    if (open && streaming && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, open, streaming]);

  const n = text.length;

  return (
    <div
      style={{
        border: `1px solid ${t.codeBorder}`,
        borderRadius: 7,
        background: t.codeBg,
        margin: '6px 0',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%',
          padding: '6px 10px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left', color: t.textSecondary,
          fontSize: 11.5, fontFamily: 'inherit',
        }}
      >
        {streaming ? (
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              border: `2px solid ${t.textMuted}`, borderTopColor: 'transparent',
              animation: 'swcp-spin 0.8s linear infinite',
            }}
          />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
          </svg>
        )}
        <span style={{ fontWeight: 600 }}>{streaming ? tr.live : tr.done}</span>
        <span style={{ color: t.textMuted, fontSize: 10.5 }}>{tr.chars(n)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: t.textMuted }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          ref={body}
          style={{
            padding: '7px 11px 9px', borderTop: `1px solid ${t.codeBorder}`,
            fontSize: 11.5, lineHeight: 1.6, color: t.textMuted,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 260, overflow: 'auto',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
