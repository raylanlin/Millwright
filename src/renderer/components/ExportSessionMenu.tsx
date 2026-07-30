// src/renderer/components/ExportSessionMenu.tsx
//
// P66: export the whole session — chat plus the tool-call record.
//
// A modelling run's real value is the record of it: which tool ran, with what arguments,
// and what SolidWorks answered. That is what goes into a bug report or a build log for a
// part, and reading it off screen means expanding every collapsed card by hand.
//
// Markdown for people, JSON for tooling. Tool calls are included by default; the
// reasoning scratchpad is opt-in, since it is long and rarely worth keeping.

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';
import {
  sessionToMarkdown,
  sessionToJSON,
  downloadText,
  defaultExportName,
  copyText,
} from '../session-export';

const L = {
  zh: {
    title: '导出会话',
    md: '导出为 Markdown',
    json: '导出为 JSON',
    copy: '复制全部到剪贴板',
    reasoning: '包含思考过程',
    done: '已复制',
    empty: '当前会话还没有内容',
  },
  en: {
    title: 'Export session',
    md: 'Export as Markdown',
    json: 'Export as JSON',
    copy: 'Copy all to clipboard',
    reasoning: 'Include reasoning',
    done: 'Copied',
    empty: 'Nothing in this session yet',
  },
} as const;

export function ExportSessionMenu({ messages, t }: { messages: ChatMessage[]; t: ThemeTokens }) {
  const { locale } = useLocale();
  const lc = locale === 'zh' ? 'zh' : 'en';
  const tr = L[lc];
  const [open, setOpen] = useState(false);
  const [withReasoning, setWithReasoning] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const opts = { locale: lc as 'zh' | 'en', includeReasoning: withReasoning, includeTools: true };
  const usable = messages.filter((m) => m.role !== 'system');

  const item = (label: string, onClick: () => void) => (
    <button
      key={label}
      onClick={() => { onClick(); setOpen(false); }}
      disabled={!usable.length}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
        borderRadius: 6, border: 'none', background: 'transparent', color: t.text,
        fontSize: 12, cursor: usable.length ? 'pointer' : 'default',
        opacity: usable.length ? 1 : 0.45, fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={wrap} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={tr.title}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 9px',
          borderRadius: 7, border: `1px solid ${t.cardBorder}`, background: 'transparent',
          color: t.textSecondary, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
        {tr.title}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40,
            width: 232, padding: 5, borderRadius: 10, background: t.card,
            border: `1px solid ${t.cardBorder}`, boxShadow: '0 10px 30px rgba(0,0,0,0.24)',
          }}
        >
          {!usable.length && (
            <div style={{ padding: '8px 10px', fontSize: 11.5, color: t.textMuted }}>{tr.empty}</div>
          )}
          {!!usable.length && (
            <>
              {item(tr.md, () => downloadText(defaultExportName('md'), sessionToMarkdown(usable, opts), 'text/markdown'))}
              {item(tr.json, () => downloadText(defaultExportName('json'), sessionToJSON(usable), 'application/json'))}
              {item(copied ? tr.done : tr.copy, async () => {
                if (await copyText(sessionToMarkdown(usable, opts))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }
              })}
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px',
                  marginTop: 3, borderTop: `1px solid ${t.cardBorder}`,
                  fontSize: 11.5, color: t.textMuted, cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={withReasoning}
                  onChange={(e) => setWithReasoning(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {tr.reasoning}
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
