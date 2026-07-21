// src/main/store/chat-store.ts
//
// Conversation history persistence.
// Uses `electron-store` to keep the list of conversations, one key per session.

import type { ChatMessage } from '../../shared/types';

// Lazily require electron-store to avoid errors in the renderer process
let storeInstance: any = null;
function getStore(): any {
  if (!storeInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Store = require('electron-store');
    storeInstance = new Store({ name: 'chat-history' });
  }
  return storeInstance;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Metadata for all sessions (message bodies excluded — used by the sidebar list) */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** List metadata for every session, sorted by `updatedAt` descending */
export function listSessions(): ChatSessionMeta[] {
  const store = getStore();
  const index: Record<string, ChatSessionMeta> = store.get('session-index', {});
  return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Fetch the full record of a single session */
export function getSession(id: string): ChatSession | null {
  const store = getStore();
  return store.get(`session:${id}`, null);
}

/** Save or update a session */
export function saveSession(session: ChatSession): void {
  const store = getStore();

  // Derive a title from the first few messages when missing
  if (!session.title || session.title === '新对话') {
    session.title = deriveTitle(session.messages);
  }
  session.updatedAt = Date.now();

  // Persist the full session record
  store.set(`session:${id(session)}`, session);

  // Update the index
  const index: Record<string, ChatSessionMeta> = store.get('session-index', {});
  index[session.id] = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
  store.set('session-index', index);
}

/** Delete a session */
export function deleteSession(sessionId: string): void {
  const store = getStore();
  store.delete(`session:${sessionId}`);
  const index: Record<string, ChatSessionMeta> = store.get('session-index', {});
  delete index[sessionId];
  store.set('session-index', index);
}

/** Create a new (empty) session */
export function createSession(initialMessages?: ChatMessage[]): ChatSession {
  const now = Date.now();
  return {
    id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    messages: initialMessages ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

function id(s: ChatSession): string {
  return s.id;
}

/** Derive a session title from message contents */
function deriveTitle(messages: ChatMessage[]): string {
  // Find the first user message
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '新对话';

  // Truncate to the first 30 characters
  const text = firstUser.content.trim();
  if (text.length <= 30) return text;
  return text.slice(0, 30) + '…';
}
