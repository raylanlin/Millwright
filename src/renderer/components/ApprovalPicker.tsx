// src/renderer/components/ApprovalPicker.tsx
//
// P45: approval strictness sits NEXT TO THE COMPOSER, not buried in Settings — it is a
// per-task decision ("let it run unattended this time"), so it belongs where the task is
// typed. Compact trigger showing the current mode; click for a popover of the four modes.

import { useEffect, useRef, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';

export type ApprovalMode = 'strict' | 'normal' | 'permissive' | 'auto';
const MODES: ApprovalMode[] = ['strict', 'normal', 'permissive', 'auto'];
const GLYPH: Record<ApprovalMode, string> = { strict: '◆', normal: '◈', permissive: '◇', auto: '⚡' };

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
        title={tr(`settings.approval.${mode}Hint`)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '5px 9px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${isAuto ? t.warnBorder : t.cardBorder}`,
          background: isAuto ? t.warnBg : 'transparent',
          color: isAuto ? t.warnText : t.textSecondary,
          fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 12 }}>{GLYPH[mode]}</span>
        {tr(`settings.approval.${mode}Short`)}
        <span style={{ fontSize: 8, opacity: 0.7 }}>▲</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40,
            width: 268, padding: 5, borderRadius: 9,
            background: t.card, border: `1px solid ${t.cardBorder}`,
            boxShadow: '0 8px 26px rgba(0,0,0,0.22)',
          }}
        >
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => { onChange(m); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                padding: '7px 8px', borderRadius: 6, border: 'none', textAlign: 'left',
                cursor: 'pointer', fontFamily: 'inherit',
                background: m === mode ? t.accentSoft : 'transparent',
                color: t.text,
              }}
            >
              <span style={{ fontSize: 12, marginTop: 1, color: m === 'auto' ? t.warnText : t.textMuted }}>
                {GLYPH[m]}
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
          <div style={{ padding: '5px 8px 3px', fontSize: 10, color: t.textMuted, borderTop: `1px solid ${t.cardBorder}`, marginTop: 3 }}>
            {tr('settings.approvalNote')}
          </div>
        </div>
      )}
    </div>
  );
}
