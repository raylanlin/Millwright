// src/renderer/components/SettingsModal.tsx
//
// Settings panel: protocol / Base URL / API Key / Model / System Prompt.
// Key improvements:
//   - "Test connection" now uses real IPC (`window.api.llm.test`) — no more `setTimeout` fake-out
//   - Save persists to the main process's `electron-store` (with `safeStorage`-encrypted `apiKey`)
//   - Custom model input (shown only when the select is set to `custom`)

import { useEffect, useMemo, useState } from 'react';
import type { LLMConfig, LLMErrorInfo, ThemeName, SWStatus } from '../../shared/types';
import { DEFAULT_URLS, MODEL_PRESETS, OPENAI_COMPATIBLE_PROVIDERS } from '../../shared/presets';
import type { ThemeTokens } from '../themes';
import { useLocale, useT } from '../i18n/LocaleContext';
import { LOCALE_LABELS } from '../i18n/strings';
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
  const tr = useT();
  const { locale, setLocale } = useLocale();
  // Local draft — only committed back on save. Closing without saving leaves the external state untouched.
  const [draft, setDraft] = useState<LLMConfig>(config);
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  // Re-sync the draft when the external config changes (e.g. after the initial async load).
  useEffect(() => {
    setDraft(config);
  }, [config]);

  // Dropdown options: if the current model is not in the preset list, show it as "custom"
  const presets = MODEL_PRESETS[draft.protocol];
  const modelIsPreset = presets.some((p) => p.value === draft.model);
  const selectValue = modelIsPreset ? draft.model : 'custom';
  const customModel = modelIsPreset ? '' : draft.model;

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

  const update = <K extends keyof LLMConfig>(k: K, v: LLMConfig[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setTestStatus({ kind: 'idle' });
  };

  // P28: update a field of the fallback vision model; all-empty → undefined (feature off)
  const updateVision = (k: 'baseURL' | 'apiKey' | 'model', v: string) => {
    setDraft((d) => {
      const vm = { baseURL: '', apiKey: '', model: '', ...(d.visionModel ?? {}), [k]: v };
      const empty = !vm.baseURL && !vm.apiKey && !vm.model;
      return { ...d, visionModel: empty ? undefined : vm };
    });
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
      // Switching to "custom" — clear `model` so the user can fill it in
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
        // Click on the backdrop to close
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
          <h2 style={{ margin: 0, fontSize: 17, color: t.text, fontWeight: 600 }}>{tr('settings.title')}</h2>
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

        {/* Language */}
        <label style={labelStyle}>{tr('settings.language')}</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['zh', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              style={{
                flex: 1, padding: '9px 14px', borderRadius: 7,
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                border: locale === l ? `2px solid ${t.accent}` : `1px solid ${t.inputBorder}`,
                background: locale === l ? t.accentSoft : t.cardAlt,
                color: locale === l ? t.text : t.textSecondary,
                transition: 'all 0.15s',
              }}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>

        {/* Theme */}
        <label style={labelStyle}>{tr('settings.theme')}</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {([
            { k: 'light' as const, l: tr('settings.light') },
            { k: 'dark' as const, l: tr('settings.dark') },
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

        {/* SolidWorks status */}
        <div
          style={{
            background: t.cardAlt, borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            border: `1px solid ${t.cardBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <span style={{ color: t.textSecondary, fontSize: 13 }}>{tr('settings.swConnection')}</span>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <StatusDot connected={swStatus.connected} />
            <span
              style={{
                color: swStatus.connected ? '#4caf72' : '#d45454',
                fontSize: 12, fontWeight: 500,
              }}
            >
              {swStatus.connected
                ? `${tr('settings.connected')}${swStatus.version ? ' · ' + swStatus.version : ''}`
                : tr('settings.notDetected')}
            </span>
          </div>
        </div>

        {/* Protocol */}
        <label style={labelStyle}>{tr('settings.protocol')}</label>
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
              {p === 'anthropic' ? 'Anthropic' : tr('settings.openaiCompat')}
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
              {tr('settings.quickFill')}
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
            {tr('settings.anthropicDefault')}
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
        <label style={labelStyle}>{tr('settings.model')}</label>
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
            placeholder={tr('settings.customModelPlaceholder')}
            style={{ ...fieldStyle, marginBottom: 16 }}
          />
        )}

        {/* System Prompt */}
        <label style={labelStyle}>
          {tr('settings.systemPrompt')} <span style={{ color: t.textMuted, fontWeight: 400 }}>{tr('settings.optional')}</span>
        </label>
        <textarea
          value={draft.systemPrompt ?? ''}
          onChange={(e) => update('systemPrompt', e.target.value)}
          placeholder={tr('settings.systemPromptPlaceholder')}
          rows={3}
          style={{
            ...fieldStyle,
            fontFamily: "'Segoe UI', sans-serif",
            resize: 'vertical',
            lineHeight: 1.5,
            marginBottom: 22,
          }}
        />

        {/* P28: Vision understanding */}
        <label style={labelStyle}>{tr('settings.vision')}</label>
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
            cursor: 'pointer', color: t.textSecondary, fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={!!draft.mainModelVision}
            onChange={(e) => update('mainModelVision', e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          {tr('settings.mainModelVision')}
        </label>
        <p style={{ color: t.textMuted, fontSize: 11, margin: '0 0 12px 1px' }}>
          {tr('settings.mainModelVisionHint')}
        </p>
        {!draft.mainModelVision && (
          <div
            style={{
              border: `1px solid ${t.cardBorder}`, borderRadius: 8,
              padding: '12px 14px', marginBottom: 22, background: t.cardAlt,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary, marginBottom: 3 }}>
              {tr('settings.visionModel')}
            </div>
            <p style={{ color: t.textMuted, fontSize: 11, margin: '0 0 10px' }}>
              {tr('settings.visionModelHint')}
            </p>
            <input
              value={draft.visionModel?.baseURL ?? ''}
              onChange={(e) => updateVision('baseURL', e.target.value)}
              placeholder="Base URL (OpenAI-compatible)"
              style={{ ...fieldStyle, marginBottom: 8 }}
            />
            <input
              type="password"
              value={draft.visionModel?.apiKey ?? ''}
              onChange={(e) => updateVision('apiKey', e.target.value)}
              placeholder="API Key"
              style={{ ...fieldStyle, marginBottom: 8 }}
            />
            <input
              value={draft.visionModel?.model ?? ''}
              onChange={(e) => updateVision('model', e.target.value)}
              placeholder={tr('settings.visionModelName')}
              style={{ ...fieldStyle, marginBottom: 2 }}
            />
          </div>
        )}

        {/* Test status info */}
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
              ? tr('settings.testing')
              : testStatus.kind === 'success'
              ? tr('settings.testSuccess')
              : testStatus.kind === 'error'
              ? tr('settings.testFail')
              : tr('settings.test')}
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
            {saving ? tr('settings.saving') : tr('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
