// src/main/llm/errors.ts

import type { ErrorCode, LLMErrorInfo } from '../../shared/types';

/**
 * 把 HTTP 状态码映射到内部错误码。
 * 参考 Anthropic 和 OpenAI 的常见错误:
 *  - 401 认证失败
 *  - 403 权限/区域限制(按认证失败处理)
 *  - 408 超时
 *  - 429 限流
 *  - 4xx 其他 → 请求错误
 *  - 5xx    → 服务端错误
 */
export function httpStatusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'LLM_AUTH_FAILED';
  if (status === 408) return 'LLM_TIMEOUT';
  if (status === 429) return 'LLM_RATE_LIMIT';
  if (status >= 400 && status < 500) return 'LLM_BAD_REQUEST';
  if (status >= 500) return 'LLM_SERVER_ERROR';
  return 'LLM_UNKNOWN';
}

/** Node 网络错误码集合,用于识别连接类错误 */
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
 * 把任意异常转成 LLMErrorInfo。永远不抛。
 */
export function toLLMError(err: unknown, context?: string): LLMErrorInfo {
  // 我们自己抛的 LLMHttpError
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

  // Node fetch undici 风格的网络错误
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
 * 包装 HTTP 响应里的错误,方便上层统一处理。
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
 * 从 Anthropic/OpenAI 错误 body 里抽出用户友好的消息。
 * 两家都用类似 { error: { message: "..." } } 的结构,或纯文本。
 */
export function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  } catch {
    // 不是 JSON,返回原文本(截断避免过长)
  }
  const trimmed = body.slice(0, 500);
  return trimmed.length > 0 ? trimmed : fallback;
}
