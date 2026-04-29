// src/renderer/components/Chat.tsx
//
// 消息列表 + 自动滚动。
// 输入框、执行逻辑由上层 App 传入 —— Chat 不关心业务,只负责展示 + 滚动。

import { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMsg, ScriptResult } from '../../shared/types';
import type { ThemeTokens } from '../themes';
import { ChatMessage } from './ChatMessage';

interface Props {
  t: ThemeTokens;
  messages: ChatMsg[];
  isGenerating: boolean;
  /** 每条消息的执行结果(按消息索引存) */
  execResults: Record<number, ScriptResult>;
  executingIndex: number | null;
  onRunScript: (index: number, code: string, lang: 'vba' | 'python') => void;
  onCopyCode: (code: string) => void;
}

export function Chat({
  t,
  messages,
  isGenerating,
  execResults,
  executingIndex,
  onRunScript,
  onCopyCode,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  // 消息变化时自动滚到底。
  // 用 `messages.length` + 最后一条 content 长度做依赖,避免 "同一个引用不触发" 问题。
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      {messages.map((msg, i) => (
        <ChatMessage
          key={i}
          msg={msg}
          t={t}
          execResult={execResults[i]}
          isExecuting={executingIndex === i}
          onRunScript={
            msg.code ? (code, lang) => onRunScript(i, code, lang) : undefined
          }
          onCopyCode={msg.code ? onCopyCode : undefined}
        />
      ))}
      {isGenerating && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '10px 14px',
            color: t.textMuted,
            fontSize: 13,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: t.dot,
              animation: 'pulse 1.4s infinite',
            }}
          />
          正在生成…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
