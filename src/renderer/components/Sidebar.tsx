// src/renderer/components/Sidebar.tsx

import type { ThemeTokens } from '../themes';
import type { LLMConfig, SWStatus, ThemeName } from '../../shared/types';
import { StatusDot } from './StatusDot';

export type TabKey = 'chat' | 'automations' | 'tools';

interface Props {
  t: ThemeTokens;
  theme: ThemeName;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  config: LLMConfig;
  swStatus: SWStatus;
  onReconnectSW: () => void;
  swLoading: boolean;
}

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'chat', icon: '💬', label: '对话' },
  { key: 'automations', icon: '⚡', label: '自动化' },
  { key: 'tools', icon: '🔧', label: '工具列表' },
];

export function Sidebar({
  t,
  theme,
  onToggleTheme,
  onOpenSettings,
  activeTab,
  onTabChange,
  config,
  swStatus,
  onReconnectSW,
  swLoading,
}: Props) {
  const isConfigured = !!(config.apiKey && config.apiKey.length > 5);
  // 模型名过长时截断显示
  const modelLabel =
    config.model.length > 22 ? `${config.model.slice(0, 22)}…` : config.model;

  return (
    <aside
      style={{
        width: 240,
        background: t.sidebar,
        borderRight: `1px solid ${t.sidebarBorder}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        transition: 'background 0.25s',
      }}
    >
      {/* Logo 区 */}
      <div style={{ padding: '18px 16px 14px', borderBottom: `1px solid ${t.sidebarBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div
            style={{
              width: 30, height: 30, borderRadius: 7, background: t.btnPrimary,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700, color: t.btnPrimaryText,
            }}
          >
            S
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>SW Copilot</div>
            <div style={{ fontSize: 10, color: t.textMuted }}>SolidWorks AI 助手</div>
          </div>
        </div>
      </div>

      {/* 状态条 */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${t.sidebarBorder}` }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <StatusDot connected={swStatus.connected} />
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={
                swStatus.connected
                  ? `SolidWorks ${swStatus.version ?? ''} · ${swStatus.activeDocumentType ?? '无文档'}`
                  : 'SolidWorks 未连接'
              }
            >
              SolidWorks
              {swStatus.connected && swStatus.activeDocumentType
                ? ` · ${swStatus.activeDocumentType}`
                : ''}
            </span>
          </div>
          <button
            onClick={onReconnectSW}
            disabled={swLoading}
            style={{
              background: 'none', border: 'none', color: t.textMuted,
              fontSize: 10, cursor: swLoading ? 'default' : 'pointer',
            }}
          >
            {swLoading ? '…' : '刷新'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <StatusDot connected={isConfigured} />
          <span
            style={{
              fontSize: 11,
              color: t.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={isConfigured ? `${config.protocol} · ${config.model}` : 'API 未配置'}
          >
            {isConfigured ? `${config.protocol} · ${modelLabel}` : 'API 未配置'}
          </span>
        </div>
      </div>

      {/* 标签切换 */}
      <nav style={{ padding: '10px 10px 0' }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                background: active ? t.accentSoft : 'transparent',
                color: active ? t.text : t.textSecondary,
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                marginBottom: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                transition: 'all 0.12s',
              }}
            >
              <span style={{ fontSize: 14 }}>{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      {/* 底部操作 */}
      <div style={{ padding: '8px 10px 14px', borderTop: `1px solid ${t.sidebarBorder}` }}>
        <button
          onClick={onToggleTheme}
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 7, marginBottom: 6,
            border: `1px solid ${t.cardBorder}`, cursor: 'pointer',
            background: t.cardAlt, color: t.textSecondary, fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 7,
          }}
        >
          {theme === 'light' ? '🌙' : '☀️'} {theme === 'light' ? '深色模式' : '浅色模式'}
        </button>
        <button
          onClick={onOpenSettings}
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 7,
            border: `1px solid ${t.cardBorder}`, cursor: 'pointer',
            background: t.cardAlt, color: t.textSecondary, fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 7,
          }}
        >
          ⚙️ 设置
        </button>
      </div>
    </aside>
  );
}
