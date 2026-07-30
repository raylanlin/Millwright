// src/renderer/components/ToolsPanel.tsx
//
// P70: the Tools tab, rebuilt against the LIVE sidecar catalog.
//
// It used to render a hard-coded list of 26 VBS-era tools from sw-tools.ts — a catalog
// that no longer matches what the agent actually calls (it showed `draw_rectangle`
// while the real tool is `sketch_rectangle`), and omitted the ~50 sidecar tools
// entirely. Clicking a tool generated a VBA preview, which was useful when VBS was the
// only engine and is now beside the point.
//
// What the tab is for now: seeing what the AI can actually do, and turning things off.
// The off switch matters more than it sounds:
//   * risk — `run_macro` and `delete_feature` can be withheld outright
//   * accuracy — a shorter tool list measurably improves tool choice, so switching off
//     drawing/assembly while modelling a part is a real quality lever, not tidiness
// Disabled tools are filtered out before the request is built, so the model never sees
// them and cannot ask for them.

import { useEffect, useMemo, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';
import { toolLabel } from '../i18n/tool-labels';

interface LiveTool {
  name: string;
  description: string;
  category: string;
  params: string[];
  required: string[];
}

interface Props {
  t: ThemeTokens;
  /** Names the user has switched OFF (persisted in config) */
  disabled: string[];
  onChange: (disabled: string[]) => void;
}

const L = {
  zh: {
    loading: '正在读取工具清单…',
    unavailable: 'Python 组件未运行，无法读取实时工具清单。当前使用内置 VBS 引擎，可用工具较少。',
    count: (n: number, off: number) => `${n} 个工具可用${off ? `，已关闭 ${off} 个` : ''}`,
    hint: '关掉不需要的工具可以提高 AI 选工具的准确率；高风险工具（运行宏、删除特征）也可以在这里彻底禁用。',
    allOn: '全开',
    allOff: '全关',
    params: '参数',
    required: '必填',
    risky: '高风险',
  },
  en: {
    loading: 'Reading the tool catalog…',
    unavailable: 'The Python component is not running, so the live catalog is unavailable. The built-in VBS engine is in use, which offers fewer tools.',
    count: (n: number, off: number) => `${n} tools available${off ? `, ${off} switched off` : ''}`,
    hint: 'Switching off tools you do not need measurably improves the AI\'s tool choice. High-risk tools (run macro, delete feature) can be disabled outright here.',
    allOn: 'All on',
    allOff: 'All off',
    params: 'params',
    required: 'required',
    risky: 'high risk',
  },
} as const;

const CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  sketch: { zh: '草图', en: 'Sketch' },
  feature: { zh: '特征', en: 'Features' },
  query: { zh: '查询', en: 'Query' },
  document: { zh: '文档', en: 'Documents' },
  assembly: { zh: '装配体', en: 'Assembly' },
  drawing: { zh: '工程图', en: 'Drawings' },
  machine: { zh: '标准机械件', en: 'Machine elements' },
  reference: { zh: '参考几何', en: 'Reference geometry' },
  export: { zh: '导出', en: 'Export' },
  view: { zh: '视图', en: 'View' },
  batch: { zh: '批量建模', en: 'Batch' },
  other: { zh: '其他', en: 'Other' },
};

const RISKY = new Set(['run_macro', 'delete_feature', 'save_as', 'export_file', 'export_stl']);

export function ToolsPanel({ t, disabled, onChange }: Props) {
  const { locale } = useLocale();
  const lc = locale === 'zh' ? 'zh' : 'en';
  const tr = L[lc];
  const [tools, setTools] = useState<LiveTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.tools
      .list()
      .then((r: any) => {
        if (!alive) return;
        if (r?.ok) setTools(r.tools);
        else setError(r?.error || 'unavailable');
      })
      .catch((e: any) => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, []);

  const off = useMemo(() => new Set(disabled), [disabled]);

  const grouped = useMemo(() => {
    const g: Record<string, LiveTool[]> = {};
    for (const tool of tools ?? []) (g[tool.category || 'other'] ||= []).push(tool);
    return g;
  }, [tools]);

  const toggle = (name: string) => {
    const next = new Set(off);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next]);
  };

  const setGroup = (names: string[], enable: boolean) => {
    const next = new Set(off);
    for (const n of names) {
      if (enable) next.delete(n);
      else next.add(n);
    }
    onChange([...next]);
  };

  if (error) {
    return (
      <div style={{ flex: 1, padding: '18px 22px' }}>
        <div
          style={{
            padding: '12px 14px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.65,
            background: t.warnBg, color: t.warnText, border: `1px solid ${t.warnBorder}`,
          }}
        >
          {tr.unavailable}
        </div>
      </div>
    );
  }

  if (!tools) {
    return (
      <div style={{ flex: 1, padding: '18px 22px', color: t.textMuted, fontSize: 13 }}>
        {tr.loading}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      <p style={{ color: t.textSecondary, fontSize: 13, margin: '0 0 4px' }}>
        {tr.count(tools.length - off.size, off.size)}
      </p>
      <p style={{ color: t.textMuted, fontSize: 11.5, lineHeight: 1.6, margin: '0 0 16px' }}>
        {tr.hint}
      </p>

      {Object.entries(grouped).map(([cat, list]) => {
        const names = list.map((x) => x.name);
        const allOff = names.every((n) => off.has(n));
        return (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ color: t.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                {CATEGORY_LABEL[cat]?.[lc] ?? cat}
              </div>
              <div style={{ color: t.textMuted, fontSize: 10.5 }}>{list.length}</div>
              <button
                onClick={() => setGroup(names, allOff)}
                style={{
                  marginLeft: 'auto', padding: '2px 9px', borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${t.cardBorder}`, background: 'transparent',
                  color: t.textMuted, fontSize: 10.5, fontFamily: 'inherit',
                }}
              >
                {allOff ? tr.allOn : tr.allOff}
              </button>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              {list.map((tool) => {
                const isOff = off.has(tool.name);
                const risky = RISKY.has(tool.name);
                return (
                  <label
                    key={tool.name}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      padding: '9px 11px', borderRadius: 7, cursor: 'pointer',
                      background: isOff ? 'transparent' : t.card,
                      border: `1px solid ${isOff ? t.cardBorder : t.toolBorder}`,
                      opacity: isOff ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!isOff}
                      onChange={() => toggle(tool.name)}
                      style={{ cursor: 'pointer', marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
                          {toolLabel(tool.name, lc)}
                        </span>
                        <span style={{ fontFamily: "'Consolas', monospace", fontSize: 10.5, color: t.textMuted }}>
                          {tool.name}
                        </span>
                        {risky && (
                          <span
                            style={{
                              fontSize: 9.5, padding: '1px 6px', borderRadius: 4,
                              background: t.dangerBg, color: t.dangerText, fontWeight: 600,
                            }}
                          >
                            {tr.risky}
                          </span>
                        )}
                      </span>
                      <span style={{ display: 'block', fontSize: 11.5, color: t.textMuted, lineHeight: 1.55, marginTop: 3 }}>
                        {tool.description}
                      </span>
                      {tool.params.length > 0 && (
                        <span
                          style={{
                            display: 'block', marginTop: 4, fontFamily: "'Consolas', monospace",
                            fontSize: 10.5, color: t.textMuted,
                          }}
                        >
                          {tool.params
                            .map((p) => (tool.required.includes(p) ? p + '*' : p))
                            .join('  ')}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
