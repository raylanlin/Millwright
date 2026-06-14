// src/renderer/hooks/useChatSessions.ts
//
// 对话历史会话管理 hook。
// 把主进程的 chat-store(window.api.chat.*)封装成 React 友好的状态:
//   - sessions: 侧边栏列表用的会话元数据(按更新时间降序)
//   - currentId: 当前会话 id(null = 尚未落库的新会话)
//   - save:    保存当前会话内容(无 currentId 自动新建);只在有真实用户对话时落库
//   - select:  加载某会话的完整消息(供调用方 setMessages)
//   - startNew: 开新会话(清空 currentId,调用方负责重置消息)
//   - remove:  删除会话
//
// 设计:createdAt 用 ref 跟踪,避免重复保存时把原始创建时间冲掉。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatSession, ChatSessionMeta } from '../../shared/types';

export function useChatSessions() {
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const createdAtRef = useRef<number>(Date.now());

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.api.chat.list());
    } catch {
      // 列表加载失败不阻塞使用
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 保存当前会话内容。无 currentId 时自动创建一个 id。
   * 只有当消息里出现过用户输入才落库 —— 避免只有欢迎语的初始态生成空会话。
   */
  const save = useCallback(
    async (messages: ChatMessage[]) => {
      const hasUserTurn = messages.some((m) => m.role === 'user');
      if (!hasUserTurn) return;

      let id = currentId;
      if (!id) {
        id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        createdAtRef.current = Date.now();
        setCurrentId(id);
      }

      const session: ChatSession = {
        id,
        title: '', // 主进程 saveSession 会从首条用户消息派生标题
        messages,
        createdAt: createdAtRef.current,
        updatedAt: Date.now(),
      };

      try {
        await window.api.chat.save(session);
        await refresh();
      } catch {
        // 保存失败不影响当前对话
      }
    },
    [currentId, refresh],
  );

  /** 加载某会话完整数据,返回给调用方用于 setMessages。 */
  const select = useCallback(async (id: string): Promise<ChatSession | null> => {
    try {
      const s = await window.api.chat.get(id);
      if (s) {
        setCurrentId(s.id);
        createdAtRef.current = s.createdAt;
      }
      return s;
    } catch {
      return null;
    }
  }, []);

  /** 开新会话:清空 currentId,调用方负责重置消息列表。 */
  const startNew = useCallback(() => {
    setCurrentId(null);
    createdAtRef.current = Date.now();
  }, []);

  /** 删除会话。若删的是当前会话,顺带清空 currentId。 */
  const remove = useCallback(
    async (id: string) => {
      try {
        await window.api.chat.delete(id);
        if (id === currentId) {
          setCurrentId(null);
          createdAtRef.current = Date.now();
        }
        await refresh();
      } catch {
        // 删除失败忽略
      }
    },
    [currentId, refresh],
  );

  return { sessions, currentId, save, select, startNew, remove, refresh };
}
