// src/shared/types.ts
// Shared type definitions for the main and renderer processes.

// ===== LLM =====

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
  /** Optional: network proxy */
  proxyURL?: string;
  /** Request timeout in milliseconds (default 120_000) */
  timeoutMs?: number;
  /** P3: dedicated vision-model configuration (image-to-text, decoupled from the main model). When unset, fall back to the main model's multimodal input */
  visionModel?: VisionConfig;
  /** P3: whether the main model itself supports visual input (when `true`, `analyze_view` will feed the screenshot to the main model) */
  mainModelVision?: boolean;
}

/** P3: configuration for a dedicated vision model (OpenAI-compatible multimodal) */
export interface VisionConfig {
  baseURL: string;
  apiKey: string;
  model: string;
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
  /** Optional: unique message id, used as the React `key` in the renderer */
  id?: string;
  /** Optional: unix-ms timestamp */
  timestamp?: number;
  /** Optional: attached image URLs / data URLs (multimodal message, used when the main model supports vision) */
  images?: string[];
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LLMUsage;
  /** Extracted code block (if any) */
  code?: string;
  codeLanguage?: 'vba' | 'python';
  /** Reason the response finished */
  finishReason?: 'stop' | 'length' | 'tool_use' | 'error' | 'cancelled';
}

/** Incremental event emitted by streaming responses */
export type LLMStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; requestId: string; chunk: string }
  | { type: 'tool_call'; requestId: string; toolCall: ToolCall }
  | { type: 'done'; requestId: string; response: LLMResponse }
  | { type: 'error'; requestId: string; error: LLMErrorInfo };

// ===== Error codes =====

export type ErrorCode =
  // SolidWorks-related
  | 'SW_NOT_FOUND'
  | 'SW_NO_DOCUMENT'
  | 'SW_COM_ERROR'
  // LLM-related
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMIT'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_BAD_REQUEST'
  | 'LLM_SERVER_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_CANCELLED'
  | 'LLM_UNKNOWN'
  | 'AGENT_ERROR'
  // Script-related
  | 'SCRIPT_UNSAFE'
  | 'SCRIPT_EXEC_FAILED'
  | 'SCRIPT_TIMEOUT';

export interface LLMErrorInfo {
  code: ErrorCode;
  message: string;
  /** Underlying raw error info, useful for debugging */
  raw?: string;
  /** HTTP status code, if any */
  status?: number;
}

// ===== Script execution =====

export type ScriptLanguage = 'vba' | 'python';

export interface ScriptResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  /** Structured result data (read back from the result file) */
  data?: Record<string, any>;
  /** Path of the pre-execution backup, if any */
  backupPath?: string;
}

export interface ScriptValidation {
  safe: boolean;
  issues: string[];
}

// ===== SolidWorks status =====

export type SWDocumentType = 'part' | 'assembly' | 'drawing' | null;

export interface SWStatus {
  connected: boolean;
  version?: string;
  activeDocumentType?: SWDocumentType;
  activeDocumentPath?: string;
  activeDocumentTitle?: string;
  hasDoc?: boolean;
}

/** Document context (injected into the AI's system prompt) */
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

// ===== Model presets =====

export interface ModelPreset {
  label: string;
  value: string;
}

// ===== Theme =====

export type ThemeName = 'light' | 'dark';

// ===== Chat sessions =====

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
