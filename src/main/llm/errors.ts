// src/main/llm/errors.ts

import type { ErrorCode, LLMErrorInfo } from '../../shared/types';

/**
 * Map an HTTP status code to an internal error code.
 * Based on the common errors returned by Anthropic and OpenAI:
 *  - 401: authentication failed
 *  - 403: permission / region restriction (treated as authentication failure)
 *  - 408: timeout
 *  - 429: rate limited
 *  - other 4xx: client-side request error
 *  - 5xx:    server-side error
 */
export function httpStatusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'LLM_AUTH_FAILED';
  if (status === 408) return 'LLM_TIMEOUT';
  if (status === 429) return 'LLM_RATE_LIMIT';
  if (status >= 400 && status < 500) return 'LLM_BAD_REQUEST';
  if (status >= 500) return 'LLM_SERVER_ERROR';
  return 'LLM_UNKNOWN';
}

/** Set of Node network error codes used to identify connection-class failures */
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Convert any thrown value into an `LLMErrorInfo`. Never throws.
 */
export function toLLMError(err: unknown, context?: string): LLMErrorInfo {
  // Errors we threw ourselves
  if (err instanceof LLMHttpError) {
    return {
      code: httpStatusToCode(err.status),
      message: err.userMessage,
      raw: err.body,
      status: err.status,
    };
  }

  // AbortError (cancel / timeout)
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as any).name;
    if (name === 'AbortError') {
      return {
        code: 'LLM_CANCELLED',
        message: '请求已取消',
      };
    }
  }

  // Node-fetch / undici style network errors
  if (err && typeof err === 'object') {
    const e = err as any;
    const cause = e.cause;
    const code: string | undefined = cause?.code ?? e.code;

    if (code && NETWORK_ERROR_CODES.has(code)) {
      return {
        code: code === 'ETIMEDOUT' ? 'LLM_TIMEOUT' : 'LLM_NETWORK_ERROR',
        message: `网络连接失败 (${code})`,
        raw: e.message,
      };
    }
  }

  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '未知错误';

  return {
    code: 'LLM_UNKNOWN',
    message: context ? `${context}: ${message}` : message,
    raw: err instanceof Error ? err.stack : undefined,
  };
}

/**
 * Wrap an HTTP response error so upper layers can handle it uniformly.
 */
export class LLMHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'LLMHttpError';
  }
}

/**
 * Extract a user-friendly message from an Anthropic/OpenAI error body.
 * Both providers use a `{ error: { message: "..." } }` shape, or plain text.
 */
export function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  } catch {
    // Not JSON — return the raw text (truncated to avoid bloat)
  }
  const trimmed = body.slice(0, 500);
  return trimmed.length > 0 ? trimmed : fallback;
}
