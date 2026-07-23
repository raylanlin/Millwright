// src/renderer/components/ChatMessage.tsx
//
// Single message bubble.
// Its only responsibility is rendering; state changes live elsewhere.
// Run/copy actions are wired through prop callbacks.

import type { ChatMessage as ChatMsg, ScriptResult } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';

interface Props {
  msg: ChatMsg;
  t: ThemeTokens;
  /** Script execution result (success / failure banner) */
  execResult?: ScriptResult;
  /** Whether this code block is currently being executed */
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

  // P5: render system / tool messages as a muted center hint instead of a regular bubble
  if (msg.role === 'system' || msg.role === 'tool') {
    return (
      <div
        style={{
          textAlign: 'center',
          fontSize: 11,
          color: t.textMuted,
          padding: '4px 0 10px',
          whiteSpace: 'pre-wrap',
        }}
      >
        {msg.content}
      </div>
    );
  }

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
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          wordBreak: 'break-word',
        }}
      >
        {/* Tool-call tag */}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div
            style={{
              background: t.codeBg, borderRadius: 6, padding: '7px 10px',
              marginBottom: 9, border: `1px solid ${t.codeBorder}`,
            }}
          >
            <span style={{ color: t.textSecondary, fontSize: 11, fontWeight: 600 }}>
              {tr('msg.toolCalls')}
            </span>
            <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {msg.toolCalls.map((tc, i) => (
                <span
                  key={i}
                  style={{
                    padding: '2px 7px', borderRadius: 4,
                    background: t.toolBg, color: t.toolText,
                    fontSize: 11, fontFamily: "'Consolas', monospace",
                    border: `1px solid ${t.toolBorder}`,
                  }}
                >
                  {tc.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Code block */}
        {msg.code && (
          <div style={{ marginBottom: 9 }}>
            <div
              style={{
                background: t.codeBg, borderRadius: 6,
                padding: '10px 12px',
                border: `1px solid ${t.codeBorder}`,
                fontFamily: "'Consolas', monospace",
                fontSize: 11.5,
                color: t.codeText,
                overflowX: 'auto',
                lineHeight: 1.6,
                whiteSpace: 'pre',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 5,
                }}
              >
                <span style={{ color: t.textMuted, fontSize: 10 }}>
                  {msg.codeLanguage?.toUpperCase() ?? 'CODE'}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {onCopyCode && (
                    <button
                      onClick={() => onCopyCode(msg.code!)}
                      style={{
                        background: 'none',
                        border: `1px solid ${t.codeBorder}`,
                        color: t.textMuted,
                        fontSize: 10,
                        padding: '2px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {tr('msg.copy')}
                    </button>
                  )}
                  {onRunScript && msg.codeLanguage && (
                    <button
                      onClick={() => onRunScript(msg.code!, msg.codeLanguage!)}
                      disabled={isExecuting}
                      style={{
                        background: t.btnPrimary,
                        border: 'none',
                        color: t.btnPrimaryText,
                        fontSize: 10,
                        padding: '2px 10px',
                        borderRadius: 4,
                        cursor: isExecuting ? 'default' : 'pointer',
                        opacity: isExecuting ? 0.6 : 1,
                        fontFamily: 'inherit',
                      }}
                    >
                      {isExecuting ? tr('msg.running') : tr('msg.run')}
                    </button>
                  )}
                </div>
              </div>
              {msg.code}
            </div>

            {/* Execution result */}
            {execResult && (
              <div
                style={{
                  marginTop: 7, padding: '6px 10px', borderRadius: 5, fontSize: 11.5,
                  background: execResult.success ? t.successBg : t.dangerBg,
                  color: execResult.success ? t.successText : t.dangerText,
                  fontFamily: 'inherit',
                }}
              >
                {execResult.success ? '✓ ' : '✕ '}
                {execResult.success
                  ? tr('msg.execDone', { ms: execResult.duration })
                  : execResult.error ?? tr('msg.execFail')}
                {execResult.output && (
                  <pre
                    style={{
                      margin: '5px 0 0',
                      fontSize: 10.5,
                      whiteSpace: 'pre-wrap',
                      opacity: 0.85,
                    }}
                  >
                    {execResult.output}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {msg.content}
      </div>
    </div>
  );
}
