// src/renderer/components/PendingTool.tsx
//
// P52: the strip shown between a tool call's head frame (name known) and its
// execution (arguments fully streamed, card rendered). Without it the UI goes quiet
// for the several seconds the arguments take to arrive — indistinguishable from a
// stall, right after text was streaming smoothly.

import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';
import { toolLabel } from '../i18n/tool-labels';

const L = {
  zh: { calling: '正在调用', generic: '正在准备工具调用' },
  en: { calling: 'Calling', generic: 'Preparing a tool call' },
} as const;

export function PendingTool({ name, t }: { name?: string; t: ThemeTokens }) {
  const { locale } = useLocale();
  const lc = locale === 'zh' ? 'zh' : 'en';
  const tr = L[lc];

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        border: `1px solid ${t.codeBorder}`, borderRadius: 7,
        background: t.codeBg, margin: '6px 0', padding: '7px 10px',
        fontSize: 12, color: t.textSecondary,
      }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${t.btnPrimary}`, borderTopColor: 'transparent',
          animation: 'swcp-spin 0.8s linear infinite',
        }}
      />
      {name ? (
        <>
          <span>{tr.calling}</span>
          <span style={{ fontWeight: 600, color: t.text }}>{toolLabel(name, lc)}</span>
          <span style={{ fontFamily: "'Consolas', monospace", fontSize: 10.5, color: t.textMuted }}>
            {name}
          </span>
        </>
      ) : (
        <span>{tr.generic}</span>
      )}
      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: t.textMuted }}>…</span>
    </div>
  );
}
