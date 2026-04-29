// src/renderer/components/ErrorBanner.tsx
//
// 顶部错误横幅，显示连接断开或 API 错误，带操作按钮。

import type { LLMErrorInfo, SWStatus } from '../../shared/types';

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
  // SW 断连
  if (!swStatus.connected) {
    return (
      <Banner t={t} type="warning">
        <span>SolidWorks 未连接 — 请确保 SolidWorks 已启动</span>
        <BannerButton t={t} onClick={onReconnectSW}>重新连接</BannerButton>
      </Banner>
    );
  }

  // LLM 错误
  if (llmError) {
    const isAuth = llmError.code === 'LLM_AUTH_FAILED';
    const isRate = llmError.code === 'LLM_RATE_LIMIT';
    const isNetwork = llmError.code === 'LLM_NETWORK_ERROR';

    return (
      <Banner t={t} type="error">
        <span style={{ flex: 1 }}>
          {isAuth && 'API 认证失败 — 请检查 API Key 是否正确'}
          {isRate && 'API 限流 — 请稍后再试'}
          {isNetwork && '网络连接失败 — 请检查网络或代理设置'}
          {!isAuth && !isRate && !isNetwork && `错误: ${llmError.message}`}
        </span>
        {isAuth && <BannerButton t={t} onClick={onOpenSettings}>打开设置</BannerButton>}
        <BannerButton t={t} onClick={onDismissError}>关闭</BannerButton>
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
  const bg = type === 'warning' ? '#fef3c7' : '#fce4ec';
  const border = type === 'warning' ? '#f59e0b' : '#e57373';
  const color = type === 'warning' ? '#92400e' : '#c62828';

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
