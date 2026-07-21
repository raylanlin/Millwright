// src/preload/index.ts
//
// Preload script: safely exposes IPC interfaces to the renderer under `contextIsolation`.
// The renderer invokes them via `window.api.xxx(...)` — they look like plain function
// calls but are wired through IPC under the hood.

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
  LocaleName,
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
  locale: {
    load: (): Promise<LocaleName> => ipcRenderer.invoke('locale:load'),
    save: (locale: LocaleName) => ipcRenderer.invoke('locale:save', locale),
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

    agent: (
      config: LLMConfig,
      messages: ChatMessage[],
    ): {
      requestId: string;
      promise: Promise<
        | { ok: true; text: string; requestId: string }
        | { ok: false; error: LLMErrorInfo; requestId?: string }
      >;
    } => {
      const requestId = crypto.randomUUID();
      const promise = ipcRenderer.invoke(IpcChannels.LLM_AGENT, { config, messages, requestId }) as Promise<
        | { ok: true; text: string; requestId: string }
        | { ok: false; error: LLMErrorInfo; requestId?: string }
      >;
      return { requestId, promise };
    },

    confirmReply: (requestId: string, callId: string, approved: boolean) => {
      ipcRenderer.send(IpcChannels.AGENT_CONFIRM_REPLY, { requestId, callId, approved });
    },

    onAgentEvent: (cb: (ev: any) => void) => {
      const handler = (_e: unknown, ev: any) => cb(ev);
      ipcRenderer.on(IpcChannels.LLM_AGENT_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.LLM_AGENT_EVENT, handler);
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
