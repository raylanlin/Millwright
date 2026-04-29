// src/renderer/components/SettingsModal.tsx
//
// 设置面板:协议 / Base URL / API Key / Model / System Prompt。
// 关键改进:
//   - 测试连接走真 IPC(window.api.llm.test),不再 setTimeout 假装
//   - 保存时持久化到 main 的 electron-store(safeStorage 加密 apiKey)
//   - 自定义模型输入(当 select=custom 时才显示)

import { useEffect, useMemo, useState } from 'react';
import type { LLMConfig, LLMErrorInfo, ThemeName, SWStatus } from '../../shared/types';
import { DEFAULT_URLS, MODEL_PRESETS, OPENAI_COMPATIBLE_PROVIDERS } from '../../shared/presets';
import type { ThemeTokens } from '../themes';
import { StatusDot } from './StatusDot';

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

interface Props {
  t: ThemeTokens;
  config: LLMConfig;
  onConfigChange: (cfg: LLMConfig) => void;
  onClose: () => void;
  swStatus: SWStatus;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
}

export function SettingsModal({
  t, config, onConfigChange, onClose, swStatus, theme, onThemeChange,
}: Props) {
  // 本地草稿,保存时才写回。取消关闭不影响外部状态。
  const [draft, setDraft] = useState<LLMConfig>(config);
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  // 当外部 config 变(比如异步加载完成)同步一次草稿
  useEffect(() => {
    setDraft(config);
  }, [config]);

  // 下拉选项:如果当前 model 不在预设里,显示为 "custom"
  const presets = MODEL_PRESETS[draft.protocol];
  const modelIsPreset = presets.some((p) => p.value === draft.model);
  const selectValue = modelIsPreset ? draft.model : 'custom';
  const customModel = modelIsPreset ? '' : draft.model;

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

  const update = <K extends keyof LLMConfig>(k: K, v: LLMConfig[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setTestStatus({ kind: 'idle' });
  };

  const handleProtocol = (p: 'anthropic' | 'openai') => {
    setDraft((d) => ({
      ...d,
      protocol: p,
      baseURL: DEFAULT_URLS[p],
      model: MODEL_PRESETS[p][0].value,
    }));
    setTestStatus({ kind: 'idle' });
  };

  const handleSelectModel = (value: string) => {
    if (value === 'custom') {
      // 切成自定义,清空 model 让用户填
      setDraft((d) => ({ ...d, model: '' }));
    } else {
      setDraft((d) => ({ ...d, model: value }));
    }
    setTestStatus({ kind: 'idle' });
  };

  const handleTest = async () => {
    setTestStatus({ kind: 'testing' });
    try {
      const res = await window.api.llm.test(draft);
      if (res.ok) {
        setTestStatus({ kind: 'success' });
      } else {
        const err = res.error as LLMErrorInfo;
        setTestStatus({ kind: 'error', message: err.message });
      }
    } catch (err) {
      setTestStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.api.config.save(draft);
      onConfigChange(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 6,
    display: 'block',
    letterSpacing: 0.5,
  };
  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 13px',
    borderRadius: 7,
    border: `1px solid ${t.inputBorder}`,
    background: t.inputBg,
    color: t.text,
    fontSize: 13,
    outline: 'none',
    fontFamily: "'Consolas', 'SF Mono', monospace",
    boxSizing: 'border-box',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // 点击遮罩关闭
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
          width: 520,
          maxHeight: '88vh',
          overflow: 'auto',
          background: t.modalBg,
          borderRadius: 14,
          border: `1px solid ${t.cardBorder}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          padding: '28px 32px',
        }}
      >
        <div
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 24,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 17, color: t.text, fontWeight: 600 }}>设置</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: t.textMuted,
              fontSize: 20, cursor: 'pointer', padding: '2px 6px',
            }}
          >
            ✕
          </button>
        </div>

        {/* 主题 */}
        <label style={labelStyle}>外观主题</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {([
            { k: 'light' as const, l: '浅色' },
            { k: 'dark' as const, l: '深色' },
          ]).map(({ k, l }) => (
            <button
              key={k}
              onClick={() => onThemeChange(k)}
              style={{
                flex: 1, padding: '9px 14px', borderRadius: 7,
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                border: theme === k ? `2px solid ${t.accent}` : `1px solid ${t.inputBorder}`,
                background: theme === k ? t.accentSoft : t.cardAlt,
                color: theme === k ? t.text : t.textSecondary,
                transition: 'all 0.15s',
              }}
            >
              {l}
            </button>
          ))}
        </div>

        {/* SW 状态 */}
        <div
          style={{
            background: t.cardAlt, borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            border: `1px solid ${t.cardBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <span style={{ color: t.textSecondary, fontSize: 13 }}>SolidWorks 连接</span>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <StatusDot connected={swStatus.connected} />
            <span
              style={{
                color: swStatus.connected ? '#4caf72' : '#d45454',
                fontSize: 12, fontWeight: 500,
              }}
            >
              {swStatus.connected
                ? `已连接${swStatus.version ? ' · ' + swStatus.version : ''}`
                : '未检测到'}
            </span>
          </div>
        </div>

        {/* 协议 */}
        <label style={labelStyle}>API 协议</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          {(['anthropic', 'openai'] as const).map((p) => (
            <button
              key={p}
              onClick={() => handleProtocol(p)}
              style={{
                flex: 1, padding: '10px 14px', borderRadius: 7,
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                border: draft.protocol === p ? `2px solid ${t.accent}` : `1px solid ${t.inputBorder}`,
                background: draft.protocol === p ? t.accentSoft : t.cardAlt,
                color: draft.protocol === p ? t.text : t.textSecondary,
                transition: 'all 0.15s',
              }}
            >
              {p === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
            </button>
          ))}
        </div>

        {/* Base URL */}
        <label style={labelStyle}>Base URL</label>
        <input
          value={draft.baseURL}
          onChange={(e) => update('baseURL', e.target.value)}
          placeholder={DEFAULT_URLS[draft.protocol]}
          style={{ ...fieldStyle, marginBottom: 4 }}
        />
        {draft.protocol === 'openai' && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ color: t.textMuted, fontSize: 11, margin: '4px 1px 6px' }}>
              兼容服务商快捷填充:
            </p>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {OPENAI_COMPATIBLE_PROVIDERS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => update('baseURL', p.url)}
                  style={{
                    padding: '3px 8px', borderRadius: 4,
                    border: `1px solid ${t.cardBorder}`,
                    background: t.cardAlt, color: t.textSecondary,
                    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {draft.protocol === 'anthropic' && (
          <p style={{ color: t.textMuted, fontSize: 11, margin: '2px 0 16px 1px' }}>
            默认使用 Anthropic 官方端点
          </p>
        )}

        {/* API Key */}
        <label style={labelStyle}>API Key</label>
        <div style={{ position: 'relative', marginBottom: 16 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            onChange={(e) => update('apiKey', e.target.value)}
            placeholder={draft.protocol === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            style={{ ...fieldStyle, paddingRight: 40 }}
          />
          <button
            onClick={() => setShowKey(!showKey)}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: t.textMuted,
              cursor: 'pointer', fontSize: 14,
            }}
          >
            {showKey ? '🙈' : '👁️'}
          </button>
        </div>

        {/* Model */}
        <label style={labelStyle}>模型</label>
        <select
          value={selectValue}
          onChange={(e) => handleSelectModel(e.target.value)}
          style={{
            ...fieldStyle,
            marginBottom: selectValue === 'custom' ? 8 : 16,
            cursor: 'pointer',
            fontFamily: "'Segoe UI', sans-serif",
          }}
        >
          {presets.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {selectValue === 'custom' && (
          <input
            value={customModel}
            onChange={(e) => update('model', e.target.value)}
            placeholder="如 deepseek-chat, qwen-coder-plus, MiniMax-Text-01"
            style={{ ...fieldStyle, marginBottom: 16 }}
          />
        )}

        {/* System Prompt */}
        <label style={labelStyle}>
          系统提示词 <span style={{ color: t.textMuted, fontWeight: 400 }}>(可选)</span>
        </label>
        <textarea
          value={draft.systemPrompt ?? ''}
          onChange={(e) => update('systemPrompt', e.target.value)}
          placeholder="留空使用内置默认提示词(SolidWorks 自动化专家)"
          rows={3}
          style={{
            ...fieldStyle,
            fontFamily: "'Segoe UI', sans-serif",
            resize: 'vertical',
            lineHeight: 1.5,
            marginBottom: 22,
          }}
        />

        {/* 测试状态信息 */}
        {testStatus.kind === 'error' && (
          <div
            style={{
              padding: '8px 12px', borderRadius: 6, marginBottom: 12,
              background: '#fceaea', color: '#c44040', fontSize: 12,
              border: '1px solid #f3d0d0',
            }}
          >
            {testStatus.message}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleTest}
            disabled={testStatus.kind === 'testing'}
            style={{
              flex: 1, padding: '11px', borderRadius: 8,
              cursor: testStatus.kind === 'testing' ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 500,
              border: `1px solid ${t.cardBorder}`, transition: 'all 0.15s',
              background:
                testStatus.kind === 'success'
                  ? '#e8f5ec'
                  : testStatus.kind === 'error'
                  ? '#fceaea'
                  : t.cardAlt,
              color:
                testStatus.kind === 'success'
                  ? '#2d7a4a'
                  : testStatus.kind === 'error'
                  ? '#c44040'
                  : t.textSecondary,
              fontFamily: 'inherit',
            }}
          >
            {testStatus.kind === 'testing'
              ? '测试中…'
              : testStatus.kind === 'success'
              ? '✓ 连接成功'
              : testStatus.kind === 'error'
              ? '✕ 连接失败'
              : '测试连接'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            style={{
              flex: 1, padding: '11px', borderRadius: 8, border: 'none',
              cursor: saving || !dirty ? 'default' : 'pointer',
              background: dirty ? t.btnPrimary : t.cardAlt,
              color: dirty ? t.btnPrimaryText : t.textMuted,
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
