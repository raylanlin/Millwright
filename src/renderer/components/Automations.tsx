// src/renderer/components/Automations.tsx

import type { ThemeTokens } from '../themes';
import { AUTOMATIONS } from './automations-data';

interface Props {
  t: ThemeTokens;
  /** 用户点击某个模板后的处理 —— 通常上层会把 prompt 填入输入框并切回 chat */
  onPick: (prompt: string, label: string) => void;
}

export function Automations({ t, onPick }: Props) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      <p style={{ color: t.textSecondary, fontSize: 13, marginBottom: 16 }}>
        点击模板快速向 AI 提问(内容会填到输入框,按 Enter 发送):
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 10,
        }}
      >
        {AUTOMATIONS.map((a, i) => (
          <button
            key={i}
            onClick={() => onPick(a.prompt, a.label)}
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
              {a.label}
            </div>
            <div style={{ color: t.textMuted, fontSize: 11, lineHeight: 1.5 }}>{a.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
