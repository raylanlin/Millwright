// src/renderer/components/Sidebar.tsx

import { useMemo } from 'react';
import type { ThemeTokens } from '../themes';
import type { LLMConfig, SWStatus, ThemeName, ChatSessionMeta } from '../../shared/types';
import { useT } from '../i18n/LocaleContext';
import { StatusDot } from './StatusDot';
import logoUrl from '../assets/logo.png';

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
  /** Conversation history */
  sessions: ChatSessionMeta[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
}

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
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onNewChat,
}: Props) {
  const tr = useT();

  const TABS = useMemo<{ key: TabKey; icon: string; label: string }[]>(
    () => [
      { key: 'chat', icon: '💬', label: tr('tab.chat') },
      { key: 'automations', icon: '⚡', label: tr('tab.automations') },
      { key: 'tools', icon: '🔧', label: tr('tab.tools') },
    ],
    [tr],
  );

  const isConfigured = !!(config.apiKey && config.apiKey.length > 5);
  // Truncate overly long model names for display
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
      {/* Logo area */}
      <div style={{ padding: '18px 16px 14px', borderBottom: `1px solid ${t.sidebarBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <img src={logoUrl} alt="" style={{ width: 30, height: 30, borderRadius: 7, display: 'block' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Millwright</div>
            <div style={{ fontSize: 10, color: t.textMuted }}>{tr('sidebar.subtitle')}</div>
          </div>
        </div>
      </div>

      {/* Status bar */}
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
                  ? `SolidWorks ${swStatus.version ?? ''} · ${swStatus.activeDocumentType ?? tr('sw.noDoc')}`
                  : tr('sw.notConnected')
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
            {swLoading ? '…' : tr('sidebar.refresh')}
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
            title={isConfigured ? `${config.protocol} · ${config.model}` : tr('sidebar.apiNotConfigured')}
          >
            {isConfigured ? `${config.protocol} · ${modelLabel}` : tr('sidebar.apiNotConfigured')}
          </span>
        </div>
      </div>

      {/* FEATURE: current-document card — automatically reflects the user's document/part switches thanks to the 3-second poll */}
      <div style={{ padding: '0 16px 10px' }}>
        {swStatus.connected && swStatus.hasDoc && swStatus.activeDocumentTitle && (
          <div
            style={{
              marginTop: 9,
              background: t.card,
              border: `1px solid ${t.cardBorder}`,
              borderRadius: 8,
              padding: '9px 11px',
              display: 'flex',
              alignItems: 'center',
              gap: 9,
            }}
          >
            <span style={{ fontSize: 15 }}>
              {({ part: '🔩', assembly: '📦', drawing: '📐' } as Record<string, string>)[
                swStatus.activeDocumentType ?? 'part'
              ] ?? '📄'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: t.text,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={swStatus.activeDocumentTitle}
              >
                {swStatus.activeDocumentTitle}
              </div>
              <div style={{ fontSize: 10, color: t.textMuted, marginTop: 1 }}>
                {({ part: tr('docType.part'), assembly: tr('docType.assembly'), drawing: tr('docType.drawing') } as Record<string, string>)[
                  swStatus.activeDocumentType ?? 'part'
                ] ?? tr('docType.unknown')}
              </div>
            </div>
          </div>
        )}
        {swStatus.connected && !swStatus.hasDoc && (
          <div style={{ marginTop: 9, fontSize: 11, color: t.textMuted }}>
            {tr('sidebar.connectedNoDoc')}
          </div>
        )}
      </div>

      {/* Tab switcher */}
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

      {/* Conversation history (only shown on the chat tab) */}
      {activeTab === 'chat' && (
        <div
          style={{
            flexBasis: 'auto',
            maxHeight: '42%',
            overflowY: 'auto',
            padding: '4px 8px 8px',
            borderTop: `1px solid ${t.sidebarBorder}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 6px 6px',
              position: 'sticky',
              top: 0,
              background: t.sidebar,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: t.textMuted,
                textTransform: 'uppercase',
              }}
            >
              {tr('sidebar.history')}
            </span>
            <button
              onClick={onNewChat}
              title={tr('sidebar.newChatTitle')}
              style={{
                background: 'none',
                border: `1px solid ${t.cardBorder}`,
                color: t.textSecondary,
                fontSize: 11,
                cursor: 'pointer',
                borderRadius: 6,
                padding: '2px 8px',
                fontFamily: 'inherit',
              }}
            >
              {tr('sidebar.newChat')}
            </button>
          </div>
          {sessions.length === 0 ? (
            <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 6px' }}>
              {tr('sidebar.noHistory')}
            </div>
          ) : (
            sessions.map((s) => {
              const active = s.id === currentSessionId;
              return (
                <div
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: active ? t.accentSoft : 'transparent',
                    marginBottom: 1,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      color: active ? t.text : t.textSecondary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={s.title}
                  >
                    {s.title || tr('sidebar.untitled')}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(s.id);
                    }}
                    title={tr('sidebar.deleteChat')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: t.textMuted,
                      fontSize: 15,
                      lineHeight: 1,
                      cursor: 'pointer',
                      padding: '0 2px',
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Bottom actions */}
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
          {theme === 'light' ? '🌙' : '☀️'} {theme === 'light' ? tr('sidebar.darkMode') : tr('sidebar.lightMode')}
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
          ⚙️ {tr('sidebar.settings')}
        </button>
      </div>
    </aside>
  );
}
