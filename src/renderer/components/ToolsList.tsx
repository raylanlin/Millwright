// src/renderer/components/ToolsList.tsx

import { useState } from 'react';
import type { ThemeTokens } from '../themes';
import type { ScriptResult } from '../../shared/types';
import {
  SW_TOOLS,
  CATEGORY_LABELS,
  getToolsByCategory,
  type SWToolDefinition,
} from '../../shared/sw-tools';

interface Props {
  t: ThemeTokens;
}

interface PreviewState {
  tool: SWToolDefinition;
  code: string;
  executing: boolean;
  result?: ScriptResult;
}

export function ToolsList({ t }: Props) {
  const grouped = getToolsByCategory();
  const total = SW_TOOLS.length;
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const handleGenerate = async (tool: SWToolDefinition) => {
    const res = await window.api.script.generate(tool.name, tool.exampleParams);
    if (res.ok) {
      setPreview({ tool, code: res.code, executing: false });
    } else {
      alert(`生成失败: ${res.error}`);
    }
  };

  const handleRun = async () => {
    if (!preview) return;
    setPreview({ ...preview, executing: true, result: undefined });
    const validation = await window.api.script.validate(preview.code, 'vba');
    if (!validation.safe) {
      const ok = window.confirm(
        `检测到潜在风险:\n\n${validation.issues.join('\n')}\n\n仍要继续吗?`,
      );
      if (!ok) {
        setPreview({ ...preview, executing: false });
        return;
      }
    }
    const result = await window.api.script.run(preview.code, 'vba');
    setPreview({ ...preview, executing: false, result });
  };

  const handleCopy = () => {
    if (preview) {
      navigator.clipboard.writeText(preview.code).catch(() => {});
    }
  };

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
        <p style={{ color: t.textSecondary, fontSize: 13, marginBottom: 14 }}>
          共 {total} 个工具。点击可用示例参数生成 VBA 脚本预览:
        </p>

        {Object.entries(grouped).map(([cat, tools]) => (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div
              style={{
                color: t.textMuted,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.5,
                marginBottom: 7,
                textTransform: 'uppercase',
              }}
            >
              {CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS]}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {tools.map((tool) => (
                <button
                  key={tool.name}
                  title={tool.description}
                  onClick={() => handleGenerate(tool)}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 6,
                    background: t.toolBg,
                    color: t.toolText,
                    fontSize: 12,
                    fontFamily: "'Consolas', monospace",
                    border: `1px solid ${t.toolBorder}`,
                    cursor: 'pointer',
                  }}
                >
                  {tool.name}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div
          style={{
            marginTop: 20, padding: '14px', borderRadius: 8,
            background: t.cardAlt, border: `1px solid ${t.cardBorder}`,
          }}
        >
          <div style={{ color: t.textSecondary, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            工作原理
          </div>
          <div style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.8 }}>
            1. 用自然语言描述操作需求<br />
            2. AI 模型理解意图并选择工具<br />
            3. 生成 SolidWorks VBA 宏或 Python 脚本<br />
            4. 通过 COM 接口注入 SolidWorks 执行<br />
            5. 返回结果并给出后续建议
          </div>
        </div>
      </div>

      {preview && (
        <ScriptPreviewModal
          t={t}
          preview={preview}
          onClose={() => setPreview(null)}
          onRun={handleRun}
          onCopy={handleCopy}
        />
      )}
    </>
  );
}

// —— 预览 modal ——

interface PreviewProps {
  t: ThemeTokens;
  preview: PreviewState;
  onClose: () => void;
  onRun: () => void;
  onCopy: () => void;
}

function ScriptPreviewModal({ t, preview, onClose, onRun, onCopy }: PreviewProps) {
  const { tool, code, executing, result } = preview;
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: t.modalOverlay, backdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: '80%',
          maxWidth: 780,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          background: t.modalBg,
          borderRadius: 14,
          border: `1px solid ${t.cardBorder}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '18px 24px 14px',
            borderBottom: `1px solid ${t.cardBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: t.text }}>
              {tool.name}
            </div>
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 3 }}>
              {tool.description} · VBA 预览
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: t.textMuted,
              fontSize: 20, cursor: 'pointer', padding: '2px 6px',
            }}
          >
            ✕
          </button>
        </header>

        <div
          style={{
            flex: 1, overflowY: 'auto', padding: '14px 24px',
          }}
        >
          {tool.exampleParams && Object.keys(tool.exampleParams).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 4 }}>
                示例参数
              </div>
              <div
                style={{
                  padding: '8px 10px', borderRadius: 5,
                  background: t.codeBg, border: `1px solid ${t.codeBorder}`,
                  fontFamily: "'Consolas', monospace", fontSize: 11.5,
                  color: t.textSecondary,
                }}
              >
                {JSON.stringify(tool.exampleParams, null, 2)}
              </div>
            </div>
          )}

          <pre
            style={{
              margin: 0,
              padding: '12px 14px',
              borderRadius: 6,
              background: t.codeBg,
              border: `1px solid ${t.codeBorder}`,
              fontFamily: "'Consolas', monospace",
              fontSize: 12,
              color: t.codeText,
              lineHeight: 1.55,
              whiteSpace: 'pre',
              overflowX: 'auto',
            }}
          >
            {code}
          </pre>

          {result && (
            <div
              style={{
                marginTop: 10, padding: '8px 12px', borderRadius: 5, fontSize: 12,
                background: result.success ? '#e8f5ec' : '#fceaea',
                color: result.success ? '#2d7a4a' : '#c44040',
              }}
            >
              {result.success ? '✓ 执行完成' : '✕ 执行失败'}
              {` · ${result.duration} ms`}
              {result.error && (
                <pre style={{ margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {result.error}
                </pre>
              )}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: '12px 24px',
            borderTop: `1px solid ${t.cardBorder}`,
            display: 'flex', gap: 8, justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onCopy}
            style={{
              padding: '8px 14px', borderRadius: 6,
              border: `1px solid ${t.cardBorder}`, cursor: 'pointer',
              background: t.cardAlt, color: t.textSecondary,
              fontSize: 12, fontFamily: 'inherit',
            }}
          >
            复制
          </button>
          <button
            onClick={onRun}
            disabled={executing}
            style={{
              padding: '8px 18px', borderRadius: 6, border: 'none',
              cursor: executing ? 'default' : 'pointer',
              background: t.btnPrimary, color: t.btnPrimaryText,
              fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
              opacity: executing ? 0.6 : 1,
            }}
          >
            {executing ? '执行中…' : '在 SolidWorks 中执行'}
          </button>
        </footer>
      </div>
    </div>
  );
}
