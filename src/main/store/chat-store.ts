// src/main/store/chat-store.ts
//
// 对话历史持久化。
// 使用 electron-store 存储对话列表，每个会话一个 key。

import type { ChatMessage } from '../../shared/types';

// electron-store 延迟 require，避免渲染进程报错
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

/** 所有会话的元数据（不含消息内容，用于侧边栏列表） */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** 列出所有会话元数据，按更新时间降序 */
export function listSessions(): ChatSessionMeta[] {
  const store = getStore();
  const index: Record<string, ChatSessionMeta> = store.get('session-index', {});
  return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 获取单个会话的完整数据 */
export function getSession(id: string): ChatSession | null {
  const store = getStore();
  return store.get(`session:${id}`, null);
}

/** 保存/更新会话 */
export function saveSession(session: ChatSession): void {
  const store = getStore();

  // 从前几条消息生成标题
  if (!session.title || session.title === '新对话') {
    session.title = deriveTitle(session.messages);
  }
  session.updatedAt = Date.now();

  // 存完整会话
  store.set(`session:${id(session)}`, session);

  // 更新索引
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

/** 删除会话 */
export function deleteSession(sessionId: string): void {
  const store = getStore();
  store.delete(`session:${sessionId}`);
  const index: Record<string, ChatSessionMeta> = store.get('session-index', {});
  delete index[sessionId];
  store.set('session-index', index);
}

/** 创建新会话 */
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

/** 从消息内容推断标题 */
function deriveTitle(messages: ChatMessage[]): string {
  // 找到第一条用户消息
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '新对话';

  // 截取前 30 个字符
  const text = firstUser.content.trim();
  if (text.length <= 30) return text;
  return text.slice(0, 30) + '…';
}
