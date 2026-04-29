// tests/errors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  httpStatusToCode,
  toLLMError,
  extractErrorMessage,
  LLMHttpError,
} from '../dist/main/main/llm/errors.js';

test('httpStatusToCode: 401 auth', () => {
  assert.equal(httpStatusToCode(401), 'LLM_AUTH_FAILED');
});

test('httpStatusToCode: 403 auth', () => {
  assert.equal(httpStatusToCode(403), 'LLM_AUTH_FAILED');
});

test('httpStatusToCode: 408 timeout', () => {
  assert.equal(httpStatusToCode(408), 'LLM_TIMEOUT');
});

test('httpStatusToCode: 429 rate limit', () => {
  assert.equal(httpStatusToCode(429), 'LLM_RATE_LIMIT');
});

test('httpStatusToCode: 4xx other → bad request', () => {
  assert.equal(httpStatusToCode(418), 'LLM_BAD_REQUEST');
  assert.equal(httpStatusToCode(400), 'LLM_BAD_REQUEST');
});

test('httpStatusToCode: 5xx → server error', () => {
  assert.equal(httpStatusToCode(500), 'LLM_SERVER_ERROR');
  assert.equal(httpStatusToCode(503), 'LLM_SERVER_ERROR');
});

test('httpStatusToCode: 200 (不该发生) → unknown', () => {
  assert.equal(httpStatusToCode(200), 'LLM_UNKNOWN');
});

test('toLLMError: LLMHttpError 被识别', () => {
  const err = new LLMHttpError(429, '{"error":"rate"}', '请求过于频繁');
  const info = toLLMError(err);
  assert.equal(info.code, 'LLM_RATE_LIMIT');
  assert.equal(info.status, 429);
  assert.equal(info.message, '请求过于频繁');
});

test('toLLMError: AbortError → cancelled', () => {
  const err = new DOMException('aborted', 'AbortError');
  const info = toLLMError(err);
  assert.equal(info.code, 'LLM_CANCELLED');
});

test('toLLMError: ECONNREFUSED → network error', () => {
  const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
  const info = toLLMError(err);
  assert.equal(info.code, 'LLM_NETWORK_ERROR');
  assert.ok(info.message.includes('ECONNREFUSED'));
});

test('toLLMError: ETIMEDOUT → timeout', () => {
  const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const info = toLLMError(err);
  assert.equal(info.code, 'LLM_TIMEOUT');
});

test('toLLMError: 嵌套 cause', () => {
  const inner = Object.assign(new Error('inner'), { code: 'ENOTFOUND' });
  const err = Object.assign(new Error('outer'), { cause: inner });
  const info = toLLMError(err);
  assert.equal(info.code, 'LLM_NETWORK_ERROR');
});

test('toLLMError: 未知错误兜底', () => {
  const info = toLLMError(new Error('???'));
  assert.equal(info.code, 'LLM_UNKNOWN');
  assert.ok(info.message.includes('???'));
});

test('toLLMError: 字符串也能处理', () => {
  const info = toLLMError('plain string');
  assert.equal(info.code, 'LLM_UNKNOWN');
  assert.equal(info.message, 'plain string');
});

test('extractErrorMessage: OpenAI 风格 JSON', () => {
  const body = '{"error":{"message":"Invalid API key","type":"auth"}}';
  assert.equal(extractErrorMessage(body, 'fallback'), 'Invalid API key');
});

test('extractErrorMessage: Anthropic 风格 JSON', () => {
  const body = '{"type":"error","error":{"type":"invalid_request_error","message":"bad model"}}';
  assert.equal(extractErrorMessage(body, 'fallback'), 'bad model');
});

test('extractErrorMessage: 纯文本', () => {
  assert.equal(extractErrorMessage('Internal Server Error', 'fallback'), 'Internal Server Error');
});

test('extractErrorMessage: 空 body 用 fallback', () => {
  assert.equal(extractErrorMessage('', 'my fallback'), 'my fallback');
});
