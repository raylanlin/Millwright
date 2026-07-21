// src/shared/ipc-channels.ts
// IPC channel constants — shared between main and renderer processes

export const IpcChannels = {
  // SolidWorks
  SW_CONNECT: 'sw:connect',
  SW_DISCONNECT: 'sw:disconnect',
  SW_STATUS: 'sw:status',
  SW_HEARTBEAT: 'sw:heartbeat',
  SW_CONTEXT: 'sw:context',

  // LLM
  LLM_CHAT: 'llm:chat',
  LLM_CHAT_STREAM: 'llm:chat-stream',
  LLM_STREAM_EVENT: 'llm:stream-event',
  LLM_CANCEL: 'llm:cancel',
  LLM_TEST: 'llm:test',

  // Scripts
  SCRIPT_GENERATE: 'script:generate',
  SCRIPT_VALIDATE: 'script:validate',
  SCRIPT_RUN: 'script:run',
  SCRIPT_RESULT: 'script:result',

  // Config
  CONFIG_SAVE: 'config:save',
  CONFIG_LOAD: 'config:load',

  // Agent
  LLM_AGENT: 'llm:agent',
  LLM_AGENT_EVENT: 'llm:agent-event',
  AGENT_CONFIRM_REQUEST: 'agent:confirm-request',
  AGENT_CONFIRM_REPLY: 'agent:confirm-reply',

  // Conversation history
  CHAT_LIST: 'chat:list',
  CHAT_GET: 'chat:get',
  CHAT_SAVE: 'chat:save',
  CHAT_DELETE: 'chat:delete',
  CHAT_CREATE: 'chat:create',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
