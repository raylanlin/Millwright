// src/renderer/components/ToolCallGroup.tsx
//
// P22: renders a run of consecutive agent tool calls as ONE collapsible block
// (superseding P20's one-card-per-call). Header = a summarized, de-duplicated
// list of the actions ("列出装配体组件、解除压缩组件 ×2") with a live spinner
// while any call is running; expand to see one row per call, and click a row to
// inspect its params + pretty-printed result. A text step breaks the group, so a
// turn can have several groups interleaved with the model's prose.

import { useState } from 'react';
import type { AgentStep, LocaleName } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';
import { toolLabel } from '../i18n/tool-labels';

if (typeof document !== 'undefined' && !document.getElementById('swcp-spin')) {
  const s = document.createElement('style');
  s.id = 'swcp-spin';
  s.textContent = '@keyframes swcp-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
}

const L = {
  zh: { running: '运行中', ok: '成功', error: '失败', rejected: '已拒绝', params: '参数', result: '结果', empty: '无返回内容', calling: '正在调用工具…', tools: '个工具调用' },
  en: { running: 'running', ok: 'ok', error: 'failed', rejected: 'rejected', params: 'params', result: 'result', empty: 'no output', calling: 'calling tools…', tools: 'tool calls' },
} as const;

const DOT: Record<string, string> = { running: '#f59e0b', ok: '#22c55e', error: '#ef4444', rejected: '#94a3b8' };

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseBody(name: string, result?: string): string {
  if (!result) return '';
  const body = result
    .replace(new RegExp(`^✅\\s*${escapeRe(name)}\\s*:\\s*`), '')
    .replace(new RegExp(`^❌\\s*${escapeRe(name)}\\s*failed\\s*:\\s*`, 'i'), '')
    .replace(/^⛔\s*/, '')
    .replace(/^【[^】]*】\s*/, '');
  const trimmed = body.trim();
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* leave as-is */ }
  }
  return body;
}

/** Short target hint from params: a name/path/value, path basenamed and truncated. */
function targetOf(step: AgentStep): string {
  const p = step.params || {};
  const pick = p.name ?? p.path ?? p.material ?? p.orientation ?? p.plane ?? p.mode ?? p.equation ?? p.type ?? p.value;
  if (pick == null || pick === '') return '';
  let s = String(pick);
  if (s.includes('\\') || s.includes('/')) s = s.split(/[\\/]/).pop() || s;
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

const bolt = (color: string) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={color} style={{ flexShrink: 0 }}>
    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
  </svg>
);

const spinner = () => (
  <span style={{ width: 11, height: 11, flexShrink: 0, borderRadius: '50%', border: `2px solid ${DOT.running}`, borderTopColor: 'transparent', display: 'inline-block', animation: 'swcp-spin 0.8s linear infinite' }} />
);

export function ToolCallGroup({ steps, t }: { steps: AgentStep[]; t: ThemeTokens }) {
  const { locale } = useLocale();
  const lc: LocaleName = locale === 'zh' ? 'zh' : 'en';
  const tr = L[lc];
  const running = steps.some((s) => s.status === 'running');
  const errored = steps.some((s) => s.status === 'error');
  const [open, setOpen] = useState(running);
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());

  // Header summary: distinct friendly labels in first-seen order, with ×count
  const counts: { label: string; n: number }[] = [];
  for (const s of steps) {
    const label = toolLabel(s.name ?? 'tool', lc);
    const found = counts.find((c) => c.label === label);
    if (found) found.n++;
    else counts.push({ label, n: 1 });
  }
  const summary = running
    ? tr.calling
    : counts.slice(0, 3).map((c) => (c.n > 1 ? `${c.label} ×${c.n}` : c.label)).join('、') + (counts.length > 3 ? '…' : '');

  const toggleRow = (i: number) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  const headColor = errored ? t.dangerText : t.text;

  return (
    <div style={{ border: `1px solid ${t.codeBorder}`, borderRadius: 8, background: t.codeBg, margin: '7px 0', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: headColor, fontFamily: 'inherit' }}
      >
        {running ? spinner() : bolt(errored ? t.dangerText : t.toolText)}
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        {steps.length > 1 && (
          <span style={{ fontSize: 11, color: t.textMuted, flexShrink: 0 }}>{steps.length} {tr.tools}</span>
        )}
        <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${t.codeBorder}`, padding: '4px 0' }}>
          {steps.map((s, i) => {
            const name = s.name ?? 'tool';
            const body = parseBody(name, s.result);
            const paramStr = s.params && Object.keys(s.params).length ? JSON.stringify(s.params, null, 2) : '';
            const target = targetOf(s);
            const rowOpen = openRows.has(i);
            const hasDetail = !!body || !!paramStr;
            return (
              <div key={i}>
                <button
                  onClick={() => hasDetail && toggleRow(i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 12px 5px 14px', background: 'none', border: 'none', cursor: hasDetail ? 'pointer' : 'default', textAlign: 'left', color: t.text, fontFamily: 'inherit' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: DOT[s.status ?? 'running'] }} />
                  <span style={{ fontSize: 12 }}>{toolLabel(name, lc)}</span>
                  {target && <span style={{ fontSize: 11.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target}</span>}
                  <span style={{ fontFamily: "'Consolas', monospace", fontSize: 10, color: t.textMuted, marginLeft: 'auto', flexShrink: 0 }}>{name}</span>
                  {hasDetail && <span style={{ fontSize: 9, color: t.textMuted, flexShrink: 0 }}>{rowOpen ? '▲' : '▼'}</span>}
                </button>
                {rowOpen && hasDetail && (
                  <div style={{ padding: '0 12px 8px 28px' }}>
                    {paramStr && (
                      <>
                        <div style={{ fontSize: 10, color: t.textMuted, margin: '4px 0 3px' }}>{tr.params}</div>
                        <pre style={preStyle(t)}>{paramStr}</pre>
                      </>
                    )}
                    <div style={{ fontSize: 10, color: t.textMuted, margin: '6px 0 3px' }}>{tr.result}</div>
                    <pre style={{ ...preStyle(t), color: s.status === 'error' ? t.dangerText : t.codeText }}>{body || tr.empty}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function preStyle(t: ThemeTokens): React.CSSProperties {
  return { margin: 0, fontFamily: "'Consolas', monospace", fontSize: 11, lineHeight: 1.55, color: t.codeText, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' };
}
