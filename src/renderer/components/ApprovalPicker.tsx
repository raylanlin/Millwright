// src/renderer/components/ApprovalPicker.tsx
//
// P47: restyled as an INLINE composer-toolbar item (borderless, glyph + label +
// chevron) rather than a bordered pill — it now sits on the toolbar row inside the
// input box, next to the attach button. AUTO still tints itself so an unattended run
// is never a surprise. The popover opens upward with the four modes and their notes.

import { useEffect, useRef, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';

export type ApprovalMode = 'strict' | 'normal' | 'permissive' | 'auto';
const MODES: ApprovalMode[] = ['strict', 'normal', 'permissive', 'auto'];

/** Small inline glyph per mode — ⏵⏵ for AUTO reads as "run it through". */
function ModeIcon({ mode }: { mode: ApprovalMode }) {
  if (mode === 'auto') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 5l7 7-7 7V5zM13 5l7 7-7 7V5z" />
      </svg>
    );
  }
  if (mode === 'strict') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="4" y="11" width="16" height="9" rx="2"></rect>
        <path d="M8 11V8a4 4 0 018 0v3"></path>
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M20 6L9 17l-5-5" opacity={mode === 'permissive' ? 0.55 : 1} />
    </svg>
  );
}

export function ApprovalPicker({
  mode,
  onChange,
  t,
  disabled,
}: {
  mode: ApprovalMode;
  onChange: (m: ApprovalMode) => void;
  t: ThemeTokens;
  disabled?: boolean;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const isAuto = mode === 'auto';

  return (
    <div ref={wrap} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={tr(`settings.approval.${mode}Hint`)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          height: 28, padding: '0 8px', borderRadius: 7,
          border: 'none', cursor: disabled ? 'default' : 'pointer',
          background: hover || open ? t.cardAlt : 'transparent',
          color: isAuto ? t.warnText : t.textSecondary,
          fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        }}
      >
        <ModeIcon mode={mode} />
        {tr(`settings.approval.${mode}Short`)}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ opacity: 0.6 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 40,
            width: 274, padding: 5, borderRadius: 10,
            background: t.card, border: `1px solid ${t.cardBorder}`,
            boxShadow: '0 10px 30px rgba(0,0,0,0.24)',
          }}
        >
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => { onChange(m); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                padding: '7px 8px', borderRadius: 7, border: 'none', textAlign: 'left',
                cursor: 'pointer', fontFamily: 'inherit',
                background: m === mode ? t.cardAlt : 'transparent',
                color: t.text,
              }}
            >
              <span style={{ marginTop: 2, color: m === 'auto' ? t.warnText : t.textMuted, display: 'flex' }}>
                <ModeIcon mode={m} />
              </span>
              <span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{tr(`settings.approval.${m}Short`)}</span>
                <br />
                <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>
                  {tr(`settings.approval.${m}Hint`)}
                </span>
              </span>
            </button>
          ))}
          <div
            style={{
              padding: '6px 8px 3px', marginTop: 3, fontSize: 10, lineHeight: 1.45,
              color: t.textMuted, borderTop: `1px solid ${t.cardBorder}`,
            }}
          >
            {tr('settings.approvalNote')}
          </div>
        </div>
      )}
    </div>
  );
}
