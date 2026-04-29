// src/renderer/components/ChatMessage.tsx
//
// 单条消息气泡。
// 职责仅限展示,不管状态更新。执行/复制等动作通过 props 回调。

import type { ChatMessage as ChatMsg, ScriptResult } from '../../shared/types';
import type { ThemeTokens } from '../themes';

interface Props {
  msg: ChatMsg;
  t: ThemeTokens;
  /** 脚本执行结果(成功/失败提示) */
  execResult?: ScriptResult;
  /** 是否正在执行这段代码 */
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
  const isUser = msg.role === 'user';

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
        {/* 工具调用标签 */}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div
            style={{
              background: t.codeBg, borderRadius: 6, padding: '7px 10px',
              marginBottom: 9, border: `1px solid ${t.codeBorder}`,
            }}
          >
            <span style={{ color: t.textSecondary, fontSize: 11, fontWeight: 600 }}>
              调用工具:
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

        {/* 代码块 */}
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
                      复制
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
                      {isExecuting ? '执行中…' : '执行'}
                    </button>
                  )}
                </div>
              </div>
              {msg.code}
            </div>

            {/* 执行结果 */}
            {execResult && (
              <div
                style={{
                  marginTop: 7, padding: '6px 10px', borderRadius: 5, fontSize: 11.5,
                  background: execResult.success ? '#e8f5ec' : '#fceaea',
                  color: execResult.success ? '#2d7a4a' : '#c44040',
                  fontFamily: 'inherit',
                }}
              >
                {execResult.success ? '✓ ' : '✕ '}
                {execResult.success
                  ? `执行完成 (${execResult.duration} ms)`
                  : execResult.error ?? '执行失败'}
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
