// src/main/ipc/handlers.ts
//
// IPC handler registration. All renderer ↔ main communication is centralized here,
// and channel names are taken exclusively from `shared/ipc-channels` to avoid
// channel-name drift.

import { ipcMain, BrowserWindow, nativeImage } from 'electron';
import { readFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { IpcChannels } from '../../shared/ipc-channels';
import type { LLMConfig, ChatMessage, LocaleName, ThemeName, ToolCall } from '../../shared/types';
import { createAdapter, validateConfig } from '../llm';
import { truncateMessages } from '../llm/context-window';
import { resolveSystemPrompt } from '../llm/prompts';
import { getBridge } from '../com/sw-bridge';
import { getSidecar } from '../com/sw-sidecar';
import { collectDocumentContext, formatContextForPrompt, formatContextForPromptAsync } from '../com/context-collector';
import { ScriptEngine } from '../scripts/engine';
import { validateScript } from '../scripts/sanitizer';
import { generateScript } from '../scripts/generators';
import { backupActiveDocument, removeBackup } from '../scripts/backup';
import { loadConfig, saveConfig, loadTheme, saveTheme, loadLocale, saveLocale } from '../store/config';
import { listSessions, getSession, saveSession, deleteSession, createSession } from '../store/chat-store';
import { toLLMError } from '../llm/errors';
import { runAgentLoop } from '../agent/agent-loop';
import { runSidecarAgent, type AgentEvent } from '../agent/agent-loop-sidecar';
import { OpenAIAdapter } from '../llm/openai';

/**
 * Cancellation-token table: `requestId` → `AbortController`.
 * The renderer can cancel an in-flight streaming request via its `requestId`.
 */
const activeRequests = new Map<string, AbortController>();

/** MED-1: only one agent session may be running at a time; a second one is rejected outright */
let agentRunning = false;

/** MED-3: callback table waiting for the renderer to confirm a tool call; key = `${requestId}:${callId}` */
const pendingConfirms = new Map<string, (ok: boolean) => void>();

/** P3: convert a local image path returned by the sidecar into a data URL (used after `sidecar.call('capture_view')`) */
function imageToDataUrl(p: string, format: string): string {
  if (format === 'png') return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
  const png = nativeImage.createFromPath(p).toPNG();
  if (png?.length) return `data:image/png;base64,${png.toString('base64')}`;
  return `data:image/bmp;base64,${readFileSync(p).toString('base64')}`;
}

/** P3: shared tool-confirmation gate — emit a `confirm_request` event and wait for the renderer to reply (default-deny on timeout) */
function requestUserConfirm(
  sender: Electron.WebContents,
  requestId: string,
  call: ToolCall,
  sendEvent: (ev: AgentEvent) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const callId = call.id ?? call.name;
    const key = `${requestId}:${callId}`;
    const timer = setTimeout(() => {
      if (pendingConfirms.has(key)) {
        pendingConfirms.delete(key);
        resolve(false); // default-deny on timeout
      }
    }, 120_000);
    pendingConfirms.set(key, (ok) => {
      clearTimeout(timer);
      pendingConfirms.delete(key);
      resolve(ok);
    });
    sendEvent({ type: 'confirm_request', toolCall: call });
    // `sender` is intentionally retained (avoids an "unused" warning)
    void sender;
  });
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null) {
  const bridge = getBridge();
  const scriptEngine = new ScriptEngine(bridge);

  // ===== Config =====
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
    // FEATURE: return the real current document (for UI polling); bypasses the stale cache
    return await bridge.refresh();
  });

  ipcMain.handle(IpcChannels.SW_CONTEXT, async () => {
    const ctx = await collectDocumentContext(bridge);
    if (!ctx) return { ok: false, context: null, formatted: '' };
    const formatted = formatContextForPrompt(ctx);
    return { ok: true, context: ctx, formatted };
  });

  // ===== LLM =====

  // Non-streaming: return the complete response in one shot
  ipcMain.handle(
    IpcChannels.LLM_CHAT,
    async (_e, payload: { config: LLMConfig; messages: ChatMessage[] }) => {
      const check = validateConfig(payload.config);
      if (!check.valid) {
        return { ok: false, error: toLLMError(new Error(check.issues.join(', ')), 'Invalid configuration') };
      }
      const controller = new AbortController();
      const reqId = uuid();
      activeRequests.set(reqId, controller);
      try {
        // FEATURE: refresh the real current document before each conversation (the user may have switched docs/parts since connecting)
        await bridge.refresh();
        // SolidWorks document context: collected centrally in the main process and injected
        // into the system prompt — the adapter then uses `config.systemPrompt` to build the request.
        const swContext = await formatContextForPromptAsync(bridge);
        const enrichedConfig = swContext
          ? { ...payload.config, systemPrompt: [payload.config.systemPrompt, swContext].filter(Boolean).join('\n\n') }
          : payload.config;
        const adapter = createAdapter(enrichedConfig);
        const fullPrompt = resolveSystemPrompt(enrichedConfig.systemPrompt);
        const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model);
        const response = await adapter.chat(truncated, controller.signal);
        return { ok: true, response, requestId: reqId };
      } catch (err) {
        // Must normalize: a raw `Error` crossing IPC structured-clone loses its `message`/`code`,
        // and the renderer's `ErrorBanner` relies on `error.code` to choose how to render.
        return { ok: false, error: toLLMError(err, 'Request failed'), requestId: reqId };
      } finally {
        activeRequests.delete(reqId);
      }
    },
  );

  // Streaming: push events to the renderer via `webContents.send`
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

      // Run asynchronously without awaiting (returns the `requestId` to the renderer immediately)
      (async () => {
        try {
          // FEATURE: refresh the real current document before each conversation
          await bridge.refresh();
          // SolidWorks document context: collected centrally in the main process and injected into the request
          const swContext = await formatContextForPromptAsync(bridge);
          const enrichedConfig = swContext
            ? { ...payload.config, systemPrompt: [payload.config.systemPrompt, swContext].filter(Boolean).join('\n\n') }
            : payload.config;
          const adapter = createAdapter(enrichedConfig);
          const fullPrompt = resolveSystemPrompt(enrichedConfig.systemPrompt);
          const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model);
          const stream = adapter.chatStream(truncated, reqId, controller.signal);
          for await (const ev of stream) {
            const win = getMainWindow();
            if (!win) {
              controller.abort(new Error('Window closed'));
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
              error: toLLMError(err, 'Streaming request failed'),
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
    return { ok: false, message: 'Request not found or already completed' };
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
      // Same as above: normalize the error so the renderer always receives { code, message }
      return { ok: false, error: toLLMError(err, 'Connectivity test failed') };
    }
  });

  // ===== Agent =====

  ipcMain.handle(IpcChannels.LLM_AGENT, async (e, payload: { config: LLMConfig; messages: ChatMessage[]; requestId: string }) => {
    // MED-1: mutual exclusion — reject the second concurrent request outright
    if (agentRunning) {
      return { ok: false, error: { code: 'AGENT_BUSY', message: 'Another task is already running. Wait for it to complete or stop it first.' } };
    }
    const check = validateConfig(payload.config);
    if (!check.valid) {
      return { ok: false, error: toLLMError(new Error(check.issues.join(', ')), 'Invalid configuration') };
    }
    const { requestId } = payload;
    const controller = new AbortController();
    activeRequests.set(requestId, controller); // reuse the same map as LLM_CANCEL
    agentRunning = true;
    try {
      // FEATURE: refresh the real current document before each agent session
      await bridge.refresh();
      const swContext = await formatContextForPromptAsync(bridge);
      const enrichedConfig = swContext
        ? { ...payload.config, systemPrompt: [payload.config.systemPrompt, swContext].filter(Boolean).join('\n\n') }
        : payload.config;
      // LOW: build the adapter only once (the enriched config is final here)
      const adapter = createAdapter(enrichedConfig) as OpenAIAdapter;
      if (!(adapter instanceof OpenAIAdapter)) {
        return { ok: false, error: { code: 'LLM_AGENT_UNSUPPORTED', message: 'Agent mode currently supports only the OpenAI-compatible protocol' } };
      }

      const send = (ev: AgentEvent) =>
        e.sender.send(IpcChannels.LLM_AGENT_EVENT, { ...ev, requestId });

      // P3: prefer the sidecar; only fall back to VBS when the sidecar fails to *start* (e.g. python/pywin32 missing).
      // Once the sidecar is up, runtime errors (including user cancellation) propagate normally — never silently rerun via the VBS fallback.
      const sidecar = getSidecar({ onLog: (l) => console.log('[sidecar]', l) });
      let sidecarReady = false;
      try {
        await sidecar.start();
        sidecarReady = true;
      } catch (startErr) {
        console.warn('[agent] sidecar failed to start; falling back to VBS agent:', startErr);
      }

      if (sidecarReady) {
        const text = await runSidecarAgent(adapter, payload.messages, sidecar, {
          requestId,
          maxRounds: 12,
          signal: controller.signal,
          onEvent: send,
          confirmTool: (call) => requestUserConfirm(e.sender, requestId, call, send),
          visionConfig: enrichedConfig.visionModel,
          mainModelVision: !!enrichedConfig.mainModelVision,
          imageToDataUrl,
        });
        return { ok: true, text, requestId };
      }

      // Only when the sidecar is unavailable do we take the legacy VBS path
      const text = await runAgentLoop(adapter, payload.messages, scriptEngine, {
        requestId,
        maxRounds: 8,
        signal: controller.signal,
        onEvent: send,
        backup: async () => {
          const r = await backupActiveDocument(bridge);
          return r.backupPath ?? null;
        },
        confirmTool: (call) => requestUserConfirm(e.sender, requestId, call, send),
      });
      return { ok: true, text, requestId };
    } catch (err) {
      return { ok: false, error: toLLMError(err, 'Agent execution failed'), requestId };
    } finally {
      activeRequests.delete(requestId);
      agentRunning = false;
    }
  });

  // MED-3: renderer reply to a confirmation request
  ipcMain.on(IpcChannels.AGENT_CONFIRM_REPLY, (_e, payload: { requestId: string; callId: string; approved: boolean }) => {
    const key = `${payload.requestId}:${payload.callId}`;
    const resolve = pendingConfirms.get(key);
    if (resolve) resolve(!!payload.approved);
    // No-op if the entry was already cleaned up (timeout or duplicate click)
  });

  // ===== Scripts =====

  ipcMain.handle(IpcChannels.SCRIPT_VALIDATE, (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    return validateScript(payload.code, payload.lang);
  });

  ipcMain.handle(IpcChannels.SCRIPT_RUN, async (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    // Auto-backup before execution
    const backup = await backupActiveDocument(bridge);
    const result = await scriptEngine.run(payload.code, payload.lang);

    if (result.success && backup.backupPath) {
      // Execution succeeded → drop the backup
      removeBackup(backup.backupPath);
    } else if (backup.backupPath) {
      // Execution failed → keep the backup so the user can roll back
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

  // ===== Conversation history =====

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

  // ===== Theme (kept independent of the LLM config) =====
  // Reusing the CONFIG_ channel-name convention felt too cramped, so we register
  // two dedicated handlers here. The channel names piggyback on `config:save/load`
  // for now; we can split them out later if needed.
  ipcMain.handle('theme:load', async (): Promise<ThemeName> => {
    return await loadTheme();
  });

  ipcMain.handle('theme:save', async (_e, theme: ThemeName) => {
    await saveTheme(theme);
    return { ok: true };
  });

  ipcMain.handle('locale:load', async (): Promise<LocaleName> => {
    return await loadLocale();
  });

  ipcMain.handle('locale:save', async (_e, locale: LocaleName) => {
    await saveLocale(locale);
    return { ok: true };
  });
}

/** Tear down all in-flight requests — call before app exit to avoid dangling promises */
export function abortAllRequests(): void {
  for (const [, controller] of activeRequests) {
    controller.abort();
  }
  activeRequests.clear();
}
