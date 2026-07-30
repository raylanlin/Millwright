// src/renderer/components/ChatMessage.tsx
//
// Single message bubble.
// P22: assistant tool activity is rendered as collapsible GROUPS — consecutive
// tool steps coalesce into one <ToolCallGroup/>; a text step breaks the group,
// so prose and tool groups interleave in arrival order. Falls back to `content`
// when there are no steps (legacy / restored messages).

import type { ChatMessage as ChatMsg, ScriptResult, AgentStep } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';
import { ToolCallGroup } from './ToolCallGroup';
import { ConfirmCard } from './ConfirmCard';
import { ThinkingBlock } from './ThinkingBlock';
import { PendingTool } from './PendingTool';
import { useState } from 'react';
import { messageToText, copyText } from '../session-export';

interface Props {
  msg: ChatMsg;
  t: ThemeTokens;
  execResult?: ScriptResult;
  isExecuting?: boolean;
  onRunScript?: (code: string, lang: 'vba' | 'python') => void;
  onCopyCode?: (code: string) => void;
}

export function ChatMessage({
  msg,
  t,
  execResult,
  isExecuting,
  onRunScript,
  onCopyCode,
}: Props) {
  const tr = useT();
  const isUser = msg.role === 'user';

  if (msg.role === 'system' || msg.role === 'tool') {
    return (
      <div style={{ textAlign: 'center', fontSize: 11, color: t.textMuted, padding: '4px 0 10px', whiteSpace: 'pre-wrap' }}>
        {msg.content}
      </div>
    );
  }

  const hasSteps = !isUser && !!msg.steps && msg.steps.length > 0;
  // P66: copy affordance per message. Hidden until hover so it never competes with the
  // content, and it copies the READABLE form (prose + tool calls with their arguments
  // and results) rather than the raw object — the tool record is the part worth keeping.
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);

  // P48: an assistant message with nothing in it yet (the placeholder pushed on send,
  // or a round that only ran tools) used to paint an empty grey bubble.
  if (!isUser && !hasSteps && !msg.content && !msg.code) return null;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setCopied(false); }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 14,
        paddingLeft: isUser ? 60 : 0,
        paddingRight: isUser ? 0 : 60,
      }}
    >
      {isUser && (
        <CopyButton t={t} visible={hover} copied={copied} onCopy={async () => {
          if (await copyText(messageToText(msg))) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
        }} />
      )}
      <div
        style={{
          maxWidth: '85%',
          padding: '11px 15px',
          borderRadius: 10,
          background: isUser ? t.userBubble : t.aiBubble,
          color: isUser ? t.userBubbleText : t.text,
          border: isUser ? 'none' : `1px solid ${t.aiBubbleBorder}`,
          fontSize: 13,
          lineHeight: 1.65,
          whiteSpace: hasSteps ? 'normal' : 'pre-wrap',
          fontFamily: 'inherit',
          wordBreak: 'break-word',
        }}
      >
        {/* Code block (run-button flow) */}
        {msg.code && (
          <div style={{ marginBottom: 9 }}>
            <div
              style={{
                background: t.codeBg, borderRadius: 6, padding: '10px 12px',
                border: `1px solid ${t.codeBorder}`, fontFamily: "'Consolas', monospace",
                fontSize: 11.5, color: t.codeText, overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <span style={{ color: t.textMuted, fontSize: 10 }}>{msg.codeLanguage?.toUpperCase() ?? 'CODE'}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {onCopyCode && (
                    <button
                      onClick={() => onCopyCode(msg.code!)}
                      style={{ background: 'none', border: `1px solid ${t.codeBorder}`, color: t.textMuted, fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {tr('msg.copy')}
                    </button>
                  )}
                  {onRunScript && msg.codeLanguage && (
                    <button
                      onClick={() => onRunScript(msg.code!, msg.codeLanguage!)}
                      disabled={isExecuting}
                      style={{ background: t.btnPrimary, border: 'none', color: t.btnPrimaryText, fontSize: 10, padding: '2px 10px', borderRadius: 4, cursor: isExecuting ? 'default' : 'pointer', opacity: isExecuting ? 0.6 : 1, fontFamily: 'inherit' }}
                    >
                      {isExecuting ? tr('msg.running') : tr('msg.run')}
                    </button>
                  )}
                </div>
              </div>
              {msg.code}
            </div>

            {execResult && (
              <div
                style={{
                  marginTop: 7, padding: '6px 10px', borderRadius: 5, fontSize: 11.5,
                  background: execResult.success ? t.successBg : t.dangerBg,
                  color: execResult.success ? t.successText : t.dangerText, fontFamily: 'inherit',
                }}
              >
                {execResult.success ? '✓ ' : '✕ '}
                {execResult.success ? tr('msg.execDone', { ms: execResult.duration }) : execResult.error ?? tr('msg.execFail')}
                {execResult.output && (
                  <pre style={{ margin: '5px 0 0', fontSize: 10.5, whiteSpace: 'pre-wrap', opacity: 0.85 }}>{execResult.output}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* P22: prose interleaved with collapsible tool-call groups */}
        {hasSteps ? renderSteps(msg.steps!, t) : msg.content}
      </div>
      {!isUser && (
        <CopyButton t={t} visible={hover} copied={copied} onCopy={async () => {
          if (await copyText(messageToText(msg))) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
        }} />
      )}
    </div>
  );
}

/** P66: small, quiet copy button — only visible while the message is hovered. */
function CopyButton({
  t, visible, copied, onCopy,
}: { t: ThemeTokens; visible: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      title={copied ? '已复制' : '复制这条消息'}
      style={{
        marginTop: 9, width: 24, height: 24, flexShrink: 0,
        borderRadius: 6, border: 'none', cursor: 'pointer', padding: 0,
        background: 'transparent', color: copied ? t.successText : t.textMuted,
        opacity: visible || copied ? 1 : 0,
        transition: 'opacity 0.12s',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit',
      }}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 012-2h8" />
        </svg>
      )}
    </button>
  );
}

/** Coalesce consecutive tool steps into one <ToolCallGroup/>; text steps render as prose and break the group. */
function renderSteps(steps: AgentStep[], t: ThemeTokens) {
  const els: React.ReactNode[] = [];
  let buf: AgentStep[] = [];
  const flush = (key: string | number) => {
    if (buf.length) {
      els.push(<ToolCallGroup key={`g${key}`} steps={buf} t={t} />);
      buf = [];
    }
  };
  steps.forEach((s, i) => {
    if (s.kind === 'tool') {
      buf.push(s);
    } else if (s.kind === 'pending') {
      flush(i);
      // P52: arguments are still streaming — show what is being called, not silence
      els.push(<PendingTool key={i} name={s.name} t={t} />);
    } else if (s.kind === 'reasoning') {
      flush(i);
      // P51: scratchpad, collapsed by default — visible enough to prove work is happening
      if (s.text) els.push(<ThinkingBlock key={i} text={s.text} streaming={s.streaming} t={t} />);
    } else if (s.kind === 'confirm') {
      flush(i);
      els.push(<ConfirmCard key={i} step={s} t={t} />);
    } else {
      flush(i);
      if (s.text) els.push(<span key={i} style={{ whiteSpace: 'pre-wrap' }}>{s.text}</span>);
    }
  });
  flush('end');
  return els;
}
