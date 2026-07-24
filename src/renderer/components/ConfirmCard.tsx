// src/renderer/components/ConfirmCard.tsx
//
// P28: inline confirmation card for destructive agent tools — replaces the native
// window.confirm dialog (unstyled, main-thread blocking). Shows the friendly tool
// name + full params; Approve / Reject resolve via a window event that useLLM
// forwards to the main process (which still applies its 120s default-deny timeout).

import type { AgentStep } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';
import { toolLabel } from '../i18n/tool-labels';

const L = {
  zh: { title: '需要确认：此操作可能修改模型', approve: '允许', reject: '拒绝', approved: '✓ 已允许', rejected: '⛔ 已拒绝' },
  en: { title: 'Confirmation needed: this may modify the model', approve: 'Approve', reject: 'Reject', approved: '✓ Approved', rejected: '⛔ Rejected' },
} as const;

export function ConfirmCard({ step, t }: { step: AgentStep; t: ThemeTokens }) {
  const { locale } = useLocale();
  const lc = locale === 'zh' ? 'zh' : 'en';
  const tr = L[lc];
  const pending = step.status === 'running';
  const paramStr = step.params && Object.keys(step.params).length ? JSON.stringify(step.params, null, 2) : '';

  const reply = (approved: boolean) => {
    window.dispatchEvent(new CustomEvent('swcp-confirm', {
      detail: { requestId: step.requestId, callId: step.id, approved },
    }));
  };

  return (
    <div
      style={{
        border: `1px solid ${pending ? t.warnBorder : t.cardBorder}`,
        borderRadius: 8, background: pending ? t.warnBg : t.codeBg,
        margin: '7px 0', padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: pending ? t.warnText : t.textMuted, marginBottom: 6 }}>
        {tr.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: paramStr ? 6 : 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>{toolLabel(step.name ?? 'tool', lc)}</span>
        <span style={{ fontFamily: "'Consolas', monospace", fontSize: 10.5, color: t.textMuted }}>{step.name}</span>
      </div>
      {paramStr && (
        <pre
          style={{
            margin: '0 0 8px', fontFamily: "'Consolas', monospace", fontSize: 11, lineHeight: 1.55,
            color: t.codeText, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto',
          }}
        >
          {paramStr}
        </pre>
      )}
      {pending ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => reply(true)}
            style={{
              padding: '6px 18px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: t.btnPrimary, color: t.btnPrimaryText, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {tr.approve}
          </button>
          <button
            onClick={() => reply(false)}
            style={{
              padding: '6px 18px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${t.cardBorder}`, background: 'transparent',
              color: t.textSecondary, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {tr.reject}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 12, fontWeight: 600, color: step.status === 'ok' ? t.successText : t.textMuted }}>
          {step.status === 'ok' ? tr.approved : tr.rejected}
        </div>
      )}
    </div>
  );
}
