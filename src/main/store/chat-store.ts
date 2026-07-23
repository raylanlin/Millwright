// src/main/store/chat-store.ts
//
// 会话历史持久化 v2 (P6)。
//
// 旧版把所有会话塞进一个 electron-store JSON（chat-history.json）：
//   - 每次保存重写整个文件，历史越多越卡（O(全部历史)/次，且每次生成后 600ms 就存一次）
//   - analyze_view 的 base64 截图（数 MB/张）挂在消息 images 上被原样写盘
// 现在：
//   - 每个会话一个独立 JSON 文件（userData/chat-sessions/<id>.json），索引单独存 index.json
//   - 持久化前剥离 images（截图是瞬态上下文，不值得也不应该进历史）
//   - 首次运行自动从旧的 electron-store 迁移，迁移后旧数据保留不动（可回滚）

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { ChatMessage } from '../../shared/types';

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const DIR = () => path.join(app.getPath('userData'), 'chat-sessions');
const INDEX = () => path.join(DIR(), 'index.json');

function ensureDir(): void {
  const d = DIR();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readJson<T>(p: string, fallback: T): T {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* corrupted file → fallback */ }
  return fallback;
}

function writeJson(p: string, data: unknown): void {
  // 原子写：先写临时文件再 rename，避免中途崩溃留下半个 JSON
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, p);
}

function sessionPath(id: string): string {
  // id 只由 createSession 生成（chat_<ts>_<rand>），过滤防御路径穿越
  return path.join(DIR(), `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

/** 持久化前剥离图像 data URL（保留占位说明，模型/用户重开会话时知道有过截图） */
function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.images?.length
      ? { ...m, images: undefined, content: `${m.content}\n[已省略 ${m.images.length} 张截图]`.trim() }
      : m,
  );
}

// ===== 一次性迁移（旧 electron-store → 文件） =====
let migrated = false;
function migrateOnce(): void {
  if (migrated) return;
  migrated = true;
  ensureDir();
  if (fs.existsSync(INDEX())) return; // 已有新格式数据，无需迁移
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Store = require('electron-store');
    const old = new Store({ name: 'chat-history' });
    const oldIndex: Record<string, ChatSessionMeta> = old.get('session-index', {});
    const ids = Object.keys(oldIndex);
    if (ids.length === 0) return;
    const index: Record<string, ChatSessionMeta> = {};
    for (const id of ids) {
      const s: ChatSession | null = old.get(`session:${id}`, null);
      if (!s) continue;
      s.messages = stripImages(s.messages);
      writeJson(sessionPath(id), s);
      index[id] = oldIndex[id];
    }
    writeJson(INDEX(), index);
    console.info(`[Millwright] 已迁移 ${ids.length} 个历史会话到文件存储`);
  } catch { /* 旧库不存在或损坏 — 从空开始 */ }
}

// ===== 公开 API（与旧版签名一致） =====

export function listSessions(): ChatSessionMeta[] {
  migrateOnce();
  const index = readJson<Record<string, ChatSessionMeta>>(INDEX(), {});
  return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): ChatSession | null {
  migrateOnce();
  return readJson<ChatSession | null>(sessionPath(id), null);
}

export function saveSession(session: ChatSession): void {
  migrateOnce();
  if (!session.title || session.title === '新对话') {
    session.title = deriveTitle(session.messages);
  }
  session.updatedAt = Date.now();
  session.messages = stripImages(session.messages);

  writeJson(sessionPath(session.id), session);

  const index = readJson<Record<string, ChatSessionMeta>>(INDEX(), {});
  index[session.id] = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
  writeJson(INDEX(), index);
}

export function deleteSession(sessionId: string): void {
  migrateOnce();
  try { fs.unlinkSync(sessionPath(sessionId)); } catch { /* ignore */ }
  const index = readJson<Record<string, ChatSessionMeta>>(INDEX(), {});
  delete index[sessionId];
  writeJson(INDEX(), index);
}

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

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '新对话';
  const text = firstUser.content.trim();
  if (text.length <= 30) return text;
  return text.slice(0, 30) + '…';
}
