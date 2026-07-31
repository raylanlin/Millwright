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
import { collectDocumentContext, formatContextForPromptAsync, invalidateContextCache } from '../com/context-collector';
import { ScriptEngine } from '../scripts/engine';
import { validateScript } from '../scripts/sanitizer';
import { generateScript } from '../scripts/generators';
import { backupActiveDocument, removeBackup } from '../scripts/backup';
import { loadConfig, saveConfig, loadTheme, saveTheme, loadLocale, saveLocale } from '../store/config';
import { listSessions, getSession, saveSession, deleteSession, createSession } from '../store/chat-store';
import { toLLMError } from '../llm/errors';
import { runAgentLoop } from '../agent/agent-loop';
import { runSidecarAgent, type AgentEvent } from '../agent/agent-loop-sidecar';

/** P80: a human-readable description of anything that can be thrown. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause;
    const extra = cause ? ` (cause: ${cause instanceof Error ? cause.message : String(cause)})` : '';
    const where = err.stack?.split('\n')[1]?.trim();
    return `${err.name}: ${err.message || '(empty message)'}${extra}${where ? `\n  at ${where}` : ''}`;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as any;
    // LLMErrorInfo, fetch failures, COM errors — all carry the detail somewhere different
    const msg = o.message || o.error?.message || o.error || o.reason || o.statusText;
    if (msg) return String(msg);
    try {
      return JSON.stringify(o);
    } catch {
      return Object.prototype.toString.call(o);
    }
  }
  return `non-error thrown: ${String(err)}`;
}

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
    // Note: confirm_request is now emitted by agent-loop (single source of truth).
    // See comment in agent-loop.ts around emitConfirmRequest. Sending here caused
    // a double card per destructive call (P43 root-cause fix).
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
    // P73: the sidecar holds the connection the tools actually run through. If it can read
    // ActiveDoc we ARE connected, whatever the separate cscript probe concludes — and it was
    // that probe's wrong verdict (plus a guessed UAC diagnosis) that blocked a working app.
    try {
      const sidecar = getSidecar({ onLog: (l) => console.log('[sidecar]', l) });
      await sidecar.start();
      const r = await sidecar.call('sw_status', {});
      if (r.ok && r.data?.connected) {
        return { ...r.data, source: 'sidecar' as const };
      }
    } catch {
      // fall through to the legacy probe
    }
    return { ...(await bridge.refresh()), source: 'vbs' as const };
  });

  ipcMain.handle(IpcChannels.SW_CONTEXT, async () => {
    const ctx = await collectDocumentContext(bridge);
    if (!ctx) return { ok: false, context: null, formatted: '' };
    const formatted = await formatContextForPromptAsync(bridge, await loadLocale());
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
        const swContext = await formatContextForPromptAsync(bridge, await loadLocale());
        const enrichedConfig = swContext
          ? { ...payload.config, systemPrompt: [payload.config.systemPrompt, swContext].filter(Boolean).join('\n\n') }
          : payload.config;
        const adapter = createAdapter(enrichedConfig);
        const fullPrompt = resolveSystemPrompt(enrichedConfig.systemPrompt);
        const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model, payload.config.contextWindow);
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
          const swContext = await formatContextForPromptAsync(bridge, await loadLocale());
          const enrichedConfig = swContext
            ? { ...payload.config, systemPrompt: [payload.config.systemPrompt, swContext].filter(Boolean).join('\n\n') }
            : payload.config;
          const adapter = createAdapter(enrichedConfig);
          const fullPrompt = resolveSystemPrompt(enrichedConfig.systemPrompt);
          const truncated = truncateMessages(payload.messages, fullPrompt, payload.config.model, payload.config.contextWindow);
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
    // P80: defined OUTSIDE the try so the catch block can also send events (the agent
    // execution error path needs to notify the renderer before returning).
    const send = (ev: AgentEvent) =>
      e.sender.send(IpcChannels.LLM_AGENT_EVENT, { ...ev, requestId });
    try {
      // FEATURE: refresh the real current document before each agent session
      await bridge.refresh();
      const locale = await loadLocale();
      const swContext = await formatContextForPromptAsync(bridge, locale);
      // P7: agent path uses the tool-mode system prompt (user-customized prompts still win)
      const basePrompt = resolveSystemPrompt(payload.config.systemPrompt, 'agent');
      const enrichedConfig = swContext
        ? { ...payload.config, systemPrompt: [basePrompt, swContext].filter(Boolean).join('\n\n') }
        : { ...payload.config, systemPrompt: basePrompt };
      // LOW: build the adapter only once (the enriched config is final here)
      // P5: drop the OpenAIAdapter-only restriction; both protocols now run agent via the sidecar / VBS paths
      const adapter = createAdapter(enrichedConfig);

      // P3: prefer the sidecar; only fall back to VBS when the sidecar fails to *start* (e.g. python/pywin32 missing).
      // Once the sidecar is up, runtime errors (including user cancellation) propagate normally — never silently rerun via the VBS fallback.
      const sidecar = getSidecar({ onLog: (l) => console.log('[sidecar]', l) });
      let sidecarReady = false;
      let sidecarError = '';                                    // P35: capture failure cause so VBS fallback can tell user
      try {
        await sidecar.start();
        sidecarReady = true;
      } catch (startErr) {
        sidecarError = startErr instanceof Error ? startErr.message : String(startErr);
        console.warn('[agent] sidecar failed to start; falling back to VBS agent:', startErr);
      }

      if (sidecarReady) {
        const text = await runSidecarAgent(adapter, payload.messages, sidecar, {
          requestId,
          maxRounds: payload.config.maxRounds ?? 24,
          approvalMode: payload.config.approvalMode ?? 'normal',
          contextWindow: payload.config.contextWindow,
          disabledTools: payload.config.disabledTools ?? [],
          signal: controller.signal,
          onEvent: send,
          confirmTool: (call) => requestUserConfirm(e.sender, requestId, call),
          visionConfig: enrichedConfig.visionModel,
          mainModelVision: !!enrichedConfig.mainModelVision,
          imageToDataUrl,
          backup: async () => {
            const r = await backupActiveDocument(bridge);
            return r.backupPath ?? null;
          },
          runMacro: async (code: string) => {
            const r = await scriptEngine.run(code, 'vba');
            return { success: r.success, output: r.output, error: r.error };
          },
        });
        return { ok: true, text, requestId };
      }

      // Only when the sidecar is unavailable do we take the legacy VBS path
      const text = await runAgentLoop(adapter, payload.messages, scriptEngine, {
        requestId,
        maxRounds: payload.config.maxRounds ?? 12,
        signal: controller.signal,
        onEvent: send,
        // P35: tell user we're on VBS fallback so they know tools are limited + scripts aren't verified
        degradedNotice:
          `⚠️ Python 组件未启动，已降级为内置 VBS 引擎——工具集较少（无视觉分析 analyze_view、无压缩/解压缩组件），且脚本执行结果不做校验，可能“报告成功但实际未生效”。\n原因：${sidecarError}\n`,
        backup: async () => {
          const r = await backupActiveDocument(bridge);
          return r.backupPath ?? null;
        },
        confirmTool: (call) => requestUserConfirm(e.sender, requestId, call),
      });
      return { ok: true, text, requestId };
    } catch (err) {
      // P80: never surface "未知错误". An error with no message is a bug in OUR error
      // handling, not a legitimate outcome — and it leaves the user (and us) with nothing
      // to act on. Dig out whatever the object actually carries.
      const detail = describeError(err);
      console.error('[agent] execution failed:', err);
      send({ type: 'error', error: detail });
      return { ok: false, error: { code: 'AGENT_ERROR', message: detail }, requestId };
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

  // P70: live tool catalog from the running sidecar.
  ipcMain.handle(IpcChannels.TOOLS_LIST, async () => {
    const sidecar = getSidecar({ onLog: (l) => console.log('[sidecar]', l) });
    try {
      await sidecar.start();
      const raw = await sidecar.listTools(false);
      const tools = raw.map((t: any) => {
        const f = t.function ?? {};
        const props = f.parameters?.properties ?? {};
        return {
          name: f.name,
          description: f.description ?? '',
          category: t.x_meta?.category ?? 'other',
          params: Object.keys(props),
          required: f.parameters?.required ?? [],
        };
      });
      return { ok: true, tools };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IpcChannels.SCRIPT_VALIDATE, (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    return validateScript(payload.code, payload.lang);
  });

  ipcMain.handle(IpcChannels.SCRIPT_RUN, async (_e, payload: { code: string; lang: 'vba' | 'python' }) => {
    // Auto-backup before execution
    const backup = await backupActiveDocument(bridge);
    const result = await scriptEngine.run(payload.code, payload.lang);
    if (result.success) invalidateContextCache(); // next turn gets a fresh feature tree

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
