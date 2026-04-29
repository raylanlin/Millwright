// src/shared/types.ts
// 主进程与渲染进程共享的类型定义

// ===== LLM 相关 =====

export type LLMProtocol = 'anthropic' | 'openai';

export interface LLMConfig {
  protocol: LLMProtocol;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** 可选:网络代理 */
  proxyURL?: string;
  /** 请求超时(毫秒),默认 60_000 */
  timeoutMs?: number;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id?: string;
  name: string;
  parameters: Record<string, any>;
  result?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  code?: string;
  codeLanguage?: 'vba' | 'python';
  /** 可选:消息唯一 id,渲染侧用作 React key */
  id?: string;
  /** 可选:unix ms 时间戳 */
  timestamp?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LLMUsage;
  /** 提取出的代码块(如果有) */
  code?: string;
  codeLanguage?: 'vba' | 'python';
  /** 结束原因 */
  finishReason?: 'stop' | 'length' | 'tool_use' | 'error' | 'cancelled';
}

/** 流式输出的增量事件 */
export type LLMStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; requestId: string; chunk: string }
  | { type: 'tool_call'; requestId: string; toolCall: ToolCall }
  | { type: 'done'; requestId: string; response: LLMResponse }
  | { type: 'error'; requestId: string; error: LLMErrorInfo };

// ===== 错误码 =====

export type ErrorCode =
  // SolidWorks 相关
  | 'SW_NOT_FOUND'
  | 'SW_NO_DOCUMENT'
  | 'SW_COM_ERROR'
  // LLM 相关
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMIT'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_BAD_REQUEST'
  | 'LLM_SERVER_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_CANCELLED'
  | 'LLM_UNKNOWN'
  // 脚本相关
  | 'SCRIPT_UNSAFE'
  | 'SCRIPT_EXEC_FAILED'
  | 'SCRIPT_TIMEOUT';

export interface LLMErrorInfo {
  code: ErrorCode;
  message: string;
  /** 底层原始错误信息,便于调试 */
  raw?: string;
  /** HTTP 状态码(如果有) */
  status?: number;
}

// ===== 脚本执行 =====

export type ScriptLanguage = 'vba' | 'python';

export interface ScriptResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  /** 结构化结果数据（从结果文件回传） */
  data?: Record<string, any>;
  /** 执行前备份的文件路径（如果有） */
  backupPath?: string;
}

export interface ScriptValidation {
  safe: boolean;
  issues: string[];
}

// ===== SolidWorks 状态 =====

export type SWDocumentType = 'part' | 'assembly' | 'drawing' | null;

export interface SWStatus {
  connected: boolean;
  version?: string;
  activeDocumentType?: SWDocumentType;
  activeDocumentPath?: string;
}

/** 文档上下文（用于注入 AI system prompt） */
export interface SWDocumentContext {
  fileName: string;
  filePath: string;
  docType: 'part' | 'assembly' | 'drawing';
  swVersion?: string;
  activeConfiguration?: string;
  features: Array<{ name: string; type: string; suppressed: boolean }>;
  dimensions: Array<{ fullName: string; value: number }>;
  customProperties: Record<string, string>;
  components?: Array<{ name: string; fileName: string; suppressed: boolean }>;
  material?: string;
}

// ===== 模型预设 =====

export interface ModelPreset {
  label: string;
  value: string;
}

// ===== 主题 =====

export type ThemeName = 'light' | 'dark';

// ===== 对话会话 =====

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
