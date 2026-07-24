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

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 14,
        paddingLeft: isUser ? 60 : 0,
        paddingRight: isUser ? 0 : 60,
      }}
    >
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
    </div>
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
