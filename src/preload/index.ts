// src/preload/index.ts
//
// Preload 脚本:在 contextIsolation 下安全暴露 IPC 接口给渲染进程。
// 渲染进程通过 window.api.xxx(...) 调用,看起来像普通函数,底层走 IPC。

import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type {
  LLMConfig,
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  LLMResponse,
  LLMStreamEvent,
  LLMErrorInfo,
  SWStatus,
  SWDocumentContext,
  ScriptResult,
  ScriptValidation,
  ThemeName,
} from '../shared/types';

const api = {
  config: {
    load: (): Promise<LLMConfig> => ipcRenderer.invoke(IpcChannels.CONFIG_LOAD),
    save: (config: LLMConfig) => ipcRenderer.invoke(IpcChannels.CONFIG_SAVE, config),
  },
  theme: {
    load: (): Promise<ThemeName> => ipcRenderer.invoke('theme:load'),
    save: (theme: ThemeName) => ipcRenderer.invoke('theme:save', theme),
  },
  sw: {
    connect: (): Promise<{ ok: boolean; status: SWStatus }> =>
      ipcRenderer.invoke(IpcChannels.SW_CONNECT),
    disconnect: () => ipcRenderer.invoke(IpcChannels.SW_DISCONNECT),
    status: (): Promise<SWStatus> => ipcRenderer.invoke(IpcChannels.SW_STATUS),
    getContext: (): Promise<{ ok: boolean; context: SWDocumentContext | null; formatted: string }> =>
      ipcRenderer.invoke(IpcChannels.SW_CONTEXT),
    onStatus: (cb: (status: SWStatus) => void) => {
      const handler = (_e: unknown, status: SWStatus) => cb(status);
      ipcRenderer.on(IpcChannels.SW_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.SW_STATUS, handler);
      };
    },
  },
  llm: {
    chat: (
      config: LLMConfig,
      messages: ChatMessage[],
    ): Promise<
      | { ok: true; response: LLMResponse; requestId: string }
      | { ok: false; error: LLMErrorInfo; requestId?: string }
    > => ipcRenderer.invoke(IpcChannels.LLM_CHAT, { config, messages }),

    chatStream: (
      config: LLMConfig,
      messages: ChatMessage[],
    ): Promise<
      { ok: true; requestId: string } | { ok: false; error: LLMErrorInfo }
    > => ipcRenderer.invoke(IpcChannels.LLM_CHAT_STREAM, { config, messages }),

    cancel: (requestId: string) => ipcRenderer.invoke(IpcChannels.LLM_CANCEL, requestId),
    test: (config: LLMConfig) => ipcRenderer.invoke(IpcChannels.LLM_TEST, config),

    onStreamEvent: (cb: (ev: LLMStreamEvent) => void) => {
      const handler = (_e: unknown, ev: LLMStreamEvent) => cb(ev);
      ipcRenderer.on(IpcChannels.LLM_STREAM_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.LLM_STREAM_EVENT, handler);
      };
    },
  },
  script: {
    validate: (code: string, lang: 'vba' | 'python'): Promise<ScriptValidation> =>
      ipcRenderer.invoke(IpcChannels.SCRIPT_VALIDATE, { code, lang }),
    run: (code: string, lang: 'vba' | 'python'): Promise<ScriptResult> =>
      ipcRenderer.invoke(IpcChannels.SCRIPT_RUN, { code, lang }),
    generate: (
      toolName: string,
      params?: Record<string, any>,
    ): Promise<
      | { ok: true; code: string; language: 'vba'; toolName: string }
      | { ok: false; error: string; toolName: string }
    > => ipcRenderer.invoke(IpcChannels.SCRIPT_GENERATE, { toolName, params }),
  },
  chat: {
    list: (): Promise<ChatSessionMeta[]> =>
      ipcRenderer.invoke(IpcChannels.CHAT_LIST),
    get: (sessionId: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke(IpcChannels.CHAT_GET, sessionId),
    save: (session: ChatSession): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IpcChannels.CHAT_SAVE, session),
    delete: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IpcChannels.CHAT_DELETE, sessionId),
    create: (initialMessages?: ChatMessage[]): Promise<ChatSession> =>
      ipcRenderer.invoke(IpcChannels.CHAT_CREATE, initialMessages),
  },
};

export type PreloadAPI = typeof api;

contextBridge.exposeInMainWorld('api', api);
