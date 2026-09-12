// src/renderer/components/UpdateBanner.tsx
//
// P128: one thin bar above the chat. States:
//   available → "v0.2.128 可用 · 查看 · 稍后 · 跳过此版本 · 立即更新"
//   progress  → download bar
//   staged    → "已就绪 · 重启并更新"（apply-on-restart; nothing is touched until the click）
//   error     → message + retry
// Hidden entirely when updates are disabled (dev) or nothing is available.
// Also shows a one-shot "已更新到 vX" toast after a successful swap (--updated argv).

import { useEffect, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useLocale } from '../i18n/LocaleContext';

type Info = { version: string; current: string; url: string; notes: string; asset: { size: number } | null };
type Ev =
  | { type: 'available'; info: Info }
  | { type: 'none'; current: string }
  | { type: 'progress'; received: number; total: number; percent: number }
  | { type: 'staged'; version: string }
  | { type: 'installing' }
  | { type: 'error'; message: string };

const L = {
  zh: {
    available: (v: string) => `新版本 v${v} 可用`,
    size: (mb: string) => `${mb} MB`,
    view: '更新说明', later: '稍后', skip: '跳过此版本', update: '立即更新',
    downloading: (p: number) => `正在下载更新… ${p}%`,
    staged: (v: string) => `v${v} 已下载完成，重启后生效`,
    restart: '重启并更新', installing: '正在应用更新，应用将自动重启…',
    failed: '更新失败：', retry: '重试',
    updated: (v: string) => `已更新到 v${v}`,
    swapFailed: (c: string) => `上次更新未能写入安装目录（robocopy ${c}）。请关闭占用程序后重试，或手动下载。`,
    close: '关闭',
  },
  en: {
    available: (v: string) => `Version v${v} is available`,
    size: (mb: string) => `${mb} MB`,
    view: 'Release notes', later: 'Later', skip: 'Skip this version', update: 'Update now',
    downloading: (p: number) => `Downloading update… ${p}%`,
    staged: (v: string) => `v${v} downloaded — restart to apply`,
    restart: 'Restart & update', installing: 'Applying update, the app will relaunch…',
    failed: 'Update failed: ', retry: 'Retry',
    updated: (v: string) => `Updated to v${v}`,
    swapFailed: (c: string) => `The last update could not write the install folder (robocopy ${c}). Close programs using it and retry, or download manually.`,
    close: 'Close',
  },
} as const;

export function UpdateBanner({ t }: { t: ThemeTokens }) {
  const { locale } = useLocale();
  const tr = L[locale === 'zh' ? 'zh' : 'en'];
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<'idle' | 'available' | 'downloading' | 'staged' | 'installing' | 'error'>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string>('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.api.update.version().then((v) => {
      if (v.justUpdated) setToast(tr.updated(v.version));
      else if (v.updateFailed) setToast(tr.swapFailed(v.updateFailed));
    }).catch(() => void 0);
    const off = window.api.update.onEvent((ev: Ev) => {
      if (ev.type === 'available') { setInfo(ev.info); setState('available'); setDismissed(false); }
      else if (ev.type === 'progress') { setPercent(ev.percent); setState('downloading'); }
      else if (ev.type === 'staged') setState('staged');
      else if (ev.type === 'installing') setState('installing');
      else if (ev.type === 'error') { setError(ev.message); setState('error'); }
    });
    return () => { off?.(); };
    // P129: subscribe once on mount, unsubscribe on unmount. eslint-plugin-react-hooks is not
    // installed in this repo, so an eslint-disable directive would fail rule lookup; the empty
    // deps array is intentional (the IPC subscription is a singleton for the lifetime of the
    // banner) and the cleanup function correctly tears it down.
  }, []);

  const start = async () => {
    setState('downloading'); setPercent(0); setError('');
    const r = await window.api.update.download();
    if (!r.ok) { setError(r.error || 'unknown'); setState('error'); }
  };

  const bar: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', fontSize: 12.5,
    background: t.codeBg, borderBottom: `1px solid ${t.codeBorder}`, color: t.text,
  };
  const btn = (primary = false): React.CSSProperties => ({
    fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${primary ? t.toolText : t.codeBorder}`,
    background: primary ? t.toolText : 'transparent', color: primary ? '#fff' : t.text,
  });
  const link: React.CSSProperties = { fontSize: 12, color: t.toolText, cursor: 'pointer', background: 'none', border: 'none', fontFamily: 'inherit', padding: 0 };

  if (toast) {
    return (
      <div style={bar}>
        <span style={{ flex: 1 }}>{toast}</span>
        <button style={link} onClick={() => setToast('')}>{tr.close}</button>
      </div>
    );
  }
  if (state === 'idle' || dismissed || !info) return null;

  if (state === 'downloading') {
    return (
      <div style={{ ...bar, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <span>{tr.downloading(percent)}</span>
        <div style={{ height: 4, borderRadius: 2, background: t.codeBorder, overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: t.toolText, transition: 'width .2s' }} />
        </div>
      </div>
    );
  }
  if (state === 'installing') return <div style={bar}><span>{tr.installing}</span></div>;
  if (state === 'staged') {
    return (
      <div style={bar}>
        <span style={{ flex: 1 }}>{tr.staged(info.version)}</span>
        <button style={btn()} onClick={() => setDismissed(true)}>{tr.later}</button>
        <button style={btn(true)} onClick={() => window.api.update.install()}>{tr.restart}</button>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ ...bar, color: t.dangerText }}>
        <span style={{ flex: 1 }}>{tr.failed}{error}</span>
        <button style={link} onClick={() => window.api.update.openRelease()}>{tr.view}</button>
        <button style={btn()} onClick={start}>{tr.retry}</button>
        <button style={link} onClick={() => setDismissed(true)}>{tr.close}</button>
      </div>
    );
  }
  const mb = info.asset ? (info.asset.size / 1048576).toFixed(0) : '';
  return (
    <div style={bar}>
      <span style={{ fontWeight: 600 }}>{tr.available(info.version)}</span>
      {mb && <span style={{ color: t.textMuted }}>{tr.size(mb)}</span>}
      <button style={link} onClick={() => window.api.update.openRelease()}>{tr.view}</button>
      <span style={{ flex: 1 }} />
      <button style={link} onClick={() => { window.api.update.skip(info.version); setDismissed(true); }}>{tr.skip}</button>
      <button style={btn()} onClick={() => setDismissed(true)}>{tr.later}</button>
      <button style={btn(true)} onClick={start}>{tr.update}</button>
    </div>
  );
}
