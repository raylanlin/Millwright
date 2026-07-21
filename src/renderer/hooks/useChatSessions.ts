// src/renderer/hooks/useChatSessions.ts
//
// Hook for managing chat-history sessions.
// Wraps the main-process `chat-store` (`window.api.chat.*`) into React-friendly state:
//   - `sessions`:   metadata used by the sidebar list (sorted by `updatedAt` desc)
//   - `currentId`:  current session id (`null` for a brand-new session not yet persisted)
//   - `save`:       persist the current session content (auto-creates an id if missing);
//                   only writes when the conversation actually contains user input
//   - `select`:     load a session's full messages (caller feeds them into `setMessages`)
//   - `startNew`:   open a new session (clears `currentId`; caller resets the message list)
//   - `remove`:     delete a session
//
// Design note: `createdAt` is tracked via a ref so repeated saves don't overwrite the original timestamp.

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
      // A failed list load must not block the rest of the app
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Persist the current session content. Auto-creates an id when `currentId` is unset.
   * The session is only persisted when the messages include at least one user turn —
   * this avoids writing empty sessions that only contain the greeting message.
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
        title: '', // the main-process `saveSession` derives the title from the first user message
        messages,
        createdAt: createdAtRef.current,
        updatedAt: Date.now(),
      };

      try {
        await window.api.chat.save(session);
        await refresh();
      } catch {
        // A save failure must not interrupt the current conversation
      }
    },
    [currentId, refresh],
  );

  /** Load a session's full record and return it to the caller for `setMessages`. */
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

  /** Start a new session — clears `currentId`; the caller is responsible for resetting the message list. */
  const startNew = useCallback(() => {
    setCurrentId(null);
    createdAtRef.current = Date.now();
  }, []);

  /** Delete a session. If it was the current one, `currentId` is also cleared. */
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
        // Swallow delete failures silently
      }
    },
    [currentId, refresh],
  );

  return { sessions, currentId, save, select, startNew, remove, refresh };
}
