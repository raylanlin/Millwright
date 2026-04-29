// tests/factory.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, validateConfig } from '../dist/main/main/llm/factory.js';
import { AnthropicAdapter } from '../dist/main/main/llm/anthropic.js';
import { OpenAIAdapter } from '../dist/main/main/llm/openai.js';

test('validateConfig: 空对象列出所有缺失项', () => {
  const r = validateConfig({});
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.includes('protocol')));
  assert.ok(r.issues.some((i) => i.includes('Base URL')));
  assert.ok(r.issues.some((i) => i.includes('API Key')));
  assert.ok(r.issues.some((i) => i.includes('模型')));
});

test('validateConfig: 正常配置通过', () => {
  const r = validateConfig({
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKey: 'sk-ant-xxx',
    model: 'claude-sonnet-4-20250514',
  });
  assert.equal(r.valid, true);
  assert.equal(r.issues.length, 0);
});

test('validateConfig: http 本地 URL 允许(Ollama)', () => {
  const r = validateConfig({
    protocol: 'openai',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'x',
    model: 'qwen2.5-coder',
  });
  assert.equal(r.valid, true);
});

test('validateConfig: 非法 URL 被拒', () => {
  const r = validateConfig({
    protocol: 'openai',
    baseURL: 'not a url',
    apiKey: 'x',
    model: 'y',
  });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.includes('Base URL')));
});

test('validateConfig: ftp:// 被拒', () => {
  const r = validateConfig({
    protocol: 'openai',
    baseURL: 'ftp://example.com',
    apiKey: 'x',
    model: 'y',
  });
  assert.equal(r.valid, false);
});

test('createAdapter: anthropic → AnthropicAdapter', () => {
  const a = createAdapter({
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKey: 'x',
    model: 'y',
  });
  assert.ok(a instanceof AnthropicAdapter);
});

test('createAdapter: openai → OpenAIAdapter', () => {
  const a = createAdapter({
    protocol: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'x',
    model: 'y',
  });
  assert.ok(a instanceof OpenAIAdapter);
});

test('createAdapter: 未知协议抛错', () => {
  assert.throws(() =>
    createAdapter({
      protocol: 'mystery',
      baseURL: 'https://x',
      apiKey: 'x',
      model: 'y',
    }),
  );
});
