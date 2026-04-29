// src/main/ipc/handlers.ts
//
// IPC 处理器注册。集中定义所有 renderer ↔ main 的通信,
// 保证 channel 名字只从 shared/ipc-channels 来,避免拼写漂移。

import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import { IpcChannels } from '../../shared/ipc-channels';
import type { LLMConfig, ChatMessage, ThemeName } from '../../shared/types';
import { createAdapter, validateConfig } from '../llm';
import { truncateMessages } from '../llm/context-window';
import { resolveSystemPrompt } from '../llm/prompts';
import { getBridge } from '../com/sw-bridge';
import { collectDocumentContext, formatContextForPrompt, formatContextForPromptAsync } from '../com/context-collector';
import { ScriptEngine } from '../scripts/engine';
import { validateScript } from '../scripts/sanitizer';
import { generateScript } from '../scripts/generators';
import { backupActiveDocument, removeBackup, cleanOldBackups } from '../scripts/backup';
import { loadConfig, saveConfig, loadTheme, saveTheme } from '../store/config';
import { listSessions, getSession, saveSession, deleteSession, createSession } from '../store/chat-store';
import { toLLMError } from '../llm/errors';

/**
 * 取消令牌表:requestId → AbortController
 * 渲染进程可以通过 requestId 取消正在进行的流式请求
 */
const activeRequests = new Map<string, AbortController>();

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null) {
  const bridge = getBridge();
  const scriptEngine = new ScriptEngine(bridge);

  // ===== 配置 =====
  ipcMain.handle(IpcChannels.CONFIG_LOAD, async () => {
    return await loadConfig();
  });

  ipcMain.handle(IpcChannels.CONFIG_SAVE, async (_e, config: LLMConfig) => {
    await saveConfig(config);
    return { ok: true };
  });

  // ===== SolidWorks =====
  ipcMain.handle(IpcChannels.SW_CONNECT, async () => {
    const ok = await bridge.connect();
    return { ok, status: bridge.getStatus() };
  });

  ipcMain.handle(IpcChannels.SW_DISCONNECT, async () => {
    bridge.disconnect();
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.SW_STATUS, async () => {
    return bridge.getStatus();
  });

  ipcMain.handle(IpcChannels.SW_CONTEXT, async () => {
    const ctx = await collectDocumentContext(bridge);
    if (!ctx) return { ok: false, context: null, formatted: '' };
    const formatted = formatContextForPrompt(ctx);
    return { ok: true, context: ctx, formatted };
  });

  // ===== LLM =====

  // 非流式:一次性返回完整响应
  ipcMain.handle(
    IpcChannels.LLM_CHAT,
    async (_e, payload: { config: LLMConfig; messages: ChatMessage[] }) => {
      const check = validateConfig(payload.config);
      if (!check.valid) {
        return { ok: false, error: toLLMError(new Error(check.issues.join(', ')), '配置无效') };
      }
      const controller = new AbortController();
      const reqId = uuid();
      activeRequests.set(reqId, controller);
      try {
        const adapter = createAdapter(payload.config);
        const systemPrompt = resolveSystemPrompt(payload.config.systemPrompt);
        const swContext = await formatContextForPromptAsync(bridge);
        const fullPrompt = swContext ? `${systemPrompt}\n\n${swContext}` : systemPrompt;
        const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model);
        const response = await adapter.chat(truncated, controller.signal);
        return { ok: true, response, requestId: reqId };
      } catch (err) {
        return { ok: false, error: err, requestId: reqId };
      } finally {
        activeRequests.delete(reqId);
      }
    },
  );

  // 流式:通过 webContents.send 把事件推给 renderer
  ipcMain.handle(
    IpcChannels.LLM_CHAT_STREAM,
    async (_e, payload: { config: LLMConfig; messages: ChatMessage[] }) => {
      const check = validateConfig(payload.config);
      if (!check.valid) {
        return { ok: false, error: { code: 'LLM_BAD_REQUEST', message: check.issues.join(', ') } };
      }

      const controller = new AbortController();
      const reqId = uuid();
      activeRequests.set(reqId, controller);

      // 异步运行,不 await(立即把 requestId 返回给 renderer)
      (async () => {
        try {
          const adapter = createAdapter(payload.config);
          const systemPrompt = resolveSystemPrompt(payload.config.systemPrompt);
          const swContext = await formatContextForPromptAsync(bridge);
          const fullPrompt = swContext ? `${systemPrompt}\n\n${swContext}` : systemPrompt;
          const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model);
          const stream = adapter.chatStream(truncated, reqId, controller.signal);
          for await (const ev of stream) {
            const win = getMainWindow();
            if (!win) {
              controller.abort(new Error('窗口已关闭'));
              return;
            }
            win.webContents.send(IpcChannels.LLM_STREAM_EVENT, ev);
          }
        } catch (err) {
          const win = getMainWindow();
          if (win) {
            win.webContents.send(IpcChannels.LLM_STREAM_EVENT, {
              type: 'error',
              requestId: reqId,
              error: toLLMError(err, '流式请求失败'),
            });
          }
        } finally {
          activeRequests.delete(reqId);
        }
      })();

      return { ok: true, requestId: reqId };
    },
  );

  ipcMain.handle(IpcChannels.LLM_CANCEL, (_e, requestId: string) => {
    const controller = activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      activeRequests.delete(requestId);
      return { ok: true };
    }
    return { ok: false, message: '请求不存在或已完成' };
  });

  ipcMain.handle(IpcChannels.LLM_TEST, async (_e, config: LLMConfig) => {
    const check = validateConfig(config);
    if (!check.valid) {
      return { ok: false, error: { code: 'LLM_BAD_REQUEST', message: check.issues.join(', ') } };
    }
    try {
      const adapter = createAdapter(config);
      await adapter.test();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  });

  // ===== 脚本 =====

  ipcMain.handle(IpcChannels.SCRIPT_VALIDATE, (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    return validateScript(payload.code, payload.lang);
  });

  ipcMain.handle(IpcChannels.SCRIPT_RUN, async (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    // 执行前自动备份
    const backup = await backupActiveDocument(bridge);
    const result = await scriptEngine.run(payload.code, payload.lang);

    if (result.success && backup.backupPath) {
      // 执行成功，删除备份
      removeBackup(backup.backupPath);
    } else if (backup.backupPath) {
      // 执行失败，保留备份路径供用户恢复
      result.backupPath = backup.backupPath;
    }

    return result;
  });

  ipcMain.handle(
    IpcChannels.SCRIPT_GENERATE,
    (_e, payload: { toolName: string; params?: Record<string, any> }) => {
      try {
        const result = generateScript(payload.toolName, payload.params);
        return { ok: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: message,
          toolName: payload.toolName,
        };
      }
    },
  );

  // ===== 对话历史 =====

  ipcMain.handle(IpcChannels.CHAT_LIST, async () => {
    return listSessions();
  });

  ipcMain.handle(IpcChannels.CHAT_GET, async (_e, sessionId: string) => {
    return getSession(sessionId);
  });

  ipcMain.handle(IpcChannels.CHAT_SAVE, async (_e, session: any) => {
    saveSession(session);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.CHAT_DELETE, async (_e, sessionId: string) => {
    deleteSession(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.CHAT_CREATE, async (_e, initialMessages?: any[]) => {
    return createSession(initialMessages);
  });

  // ===== 主题(独立于 LLM 配置) =====
  // 复用 CONFIG_ 频道的命名习惯不够干净,这里直接加两个 handler,
  // channel 名复用 config:save/load + 区分参数在后续需要时可以演进。
  ipcMain.handle('theme:load', async (): Promise<ThemeName> => {
    return await loadTheme();
  });

  ipcMain.handle('theme:save', async (_e, theme: ThemeName) => {
    await saveTheme(theme);
    return { ok: true };
  });
}

/** 清理所有在途请求 —— 应用退出前调用,避免 Promise 悬挂 */
export function abortAllRequests(): void {
  for (const [, controller] of activeRequests) {
    controller.abort();
  }
  activeRequests.clear();
}
