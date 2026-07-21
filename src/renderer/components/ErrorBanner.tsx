// src/renderer/components/ErrorBanner.tsx
//
// Top-of-window error banner. Surfaces SolidWorks connection loss or LLM API
// errors, with quick-action buttons.

import type { LLMErrorInfo, SWStatus } from '../../shared/types';
import { useT } from '../i18n/LocaleContext';

interface ErrorBannerProps {
  t: any; // theme tokens
  swStatus: SWStatus;
  llmError: LLMErrorInfo | null;
  onReconnectSW: () => void;
  onDismissError: () => void;
  onOpenSettings: () => void;
}

export function ErrorBanner({
  t,
  swStatus,
  llmError,
  onReconnectSW,
  onDismissError,
  onOpenSettings,
}: ErrorBannerProps) {
  const tr = useT();
  // SolidWorks disconnected
  if (!swStatus.connected) {
    return (
      <Banner t={t} type="warning">
        <span>{tr('err.swDown')}</span>
        <BannerButton t={t} onClick={onReconnectSW}>{tr('err.reconnect')}</BannerButton>
      </Banner>
    );
  }

  // LLM error
  if (llmError) {
    const isAuth = llmError.code === 'LLM_AUTH_FAILED';
    const isRate = llmError.code === 'LLM_RATE_LIMIT';
    const isNetwork = llmError.code === 'LLM_NETWORK_ERROR';

    return (
      <Banner t={t} type="error">
        <span style={{ flex: 1 }}>
          {isAuth && tr('err.auth')}
          {isRate && tr('err.rate')}
          {isNetwork && tr('err.network')}
          {!isAuth && !isRate && !isNetwork && tr('err.generic', { message: llmError.message })}
        </span>
        {isAuth && <BannerButton t={t} onClick={onOpenSettings}>{tr('err.openSettings')}</BannerButton>}
        <BannerButton t={t} onClick={onDismissError}>{tr('err.dismiss')}</BannerButton>
      </Banner>
    );
  }

  return null;
}

function Banner({
  t,
  type,
  children,
}: {
  t: any;
  type: 'warning' | 'error';
  children: React.ReactNode;
}) {
  const bg = type === 'warning' ? t.warnBg : t.dangerBg;
  const border = type === 'warning' ? t.warnBorder : t.dangerBorder;
  const color = type === 'warning' ? t.warnText : t.dangerText;

  return (
    <div
      style={{
        padding: '8px 16px',
        background: bg,
        borderBottom: `2px solid ${border}`,
        color,
        fontSize: 12,
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function BannerButton({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  t,
  onClick,
  children,
}: {
  t: any;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: 4,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}
