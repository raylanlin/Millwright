// src/renderer/components/Automations.tsx

import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';
import { AUTOMATIONS } from './automations-data';

interface Props {
  t: ThemeTokens;
  /** Handler invoked when the user clicks a template — the parent usually fills the prompt into the input box and switches back to the chat tab */
  onPick: (prompt: string, label: string) => void;
}

export function Automations({ t, onPick }: Props) {
  const tr = useT();
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      <p style={{ color: t.textSecondary, fontSize: 13, marginBottom: 16 }}>
        {tr('auto.hint')}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 10,
        }}
      >
        {AUTOMATIONS.map((a, i) => {
          const label = tr(`${a.key}.label`);
          const desc = tr(`${a.key}.desc`);
          return (
            <button
              key={i}
              onClick={() => onPick(tr(`${a.key}.prompt`), label)}
              style={{
                padding: '14px', borderRadius: 10,
                border: `1px solid ${t.cardBorder}`, background: t.card,
                cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.12s', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 6 }}>{a.icon}</div>
              <div
                style={{
                  color: t.text, fontSize: 13, fontWeight: 600, marginBottom: 3,
                }}
              >
                {label}
              </div>
              <div style={{ color: t.textMuted, fontSize: 11, lineHeight: 1.5 }}>{desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
