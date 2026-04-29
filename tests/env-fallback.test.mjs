// tests/env-fallback.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnv,
  envToConfig,
} from '../dist/main/main/store/env-fallback.js';

// ============ parseEnv ============

test('parseEnv: KEY=VALUE', () => {
  const r = parseEnv('FOO=bar');
  assert.equal(r.FOO, 'bar');
});

test('parseEnv: 注释行被忽略', () => {
  const r = parseEnv('# comment\nFOO=bar');
  assert.equal(r.FOO, 'bar');
  assert.equal(Object.keys(r).length, 1);
});

test('parseEnv: 空行被忽略', () => {
  const r = parseEnv('\n\nFOO=bar\n\n');
  assert.equal(r.FOO, 'bar');
});

test('parseEnv: 双引号值', () => {
  const r = parseEnv('FOO="hello world"');
  assert.equal(r.FOO, 'hello world');
});

test('parseEnv: 单引号值', () => {
  const r = parseEnv("FOO='hello world'");
  assert.equal(r.FOO, 'hello world');
});

test('parseEnv: 行尾注释(无引号值)', () => {
  const r = parseEnv('FOO=bar # comment');
  assert.equal(r.FOO, 'bar');
});

test('parseEnv: 有引号时行尾 # 被视为值的一部分', () => {
  // 这是合理的 —— shell 里引号内的 # 就是字面量
  const r = parseEnv('FOO="bar # not comment"');
  assert.equal(r.FOO, 'bar # not comment');
});

test('parseEnv: 值包含 = 保留', () => {
  const r = parseEnv('FOO=a=b=c');
  assert.equal(r.FOO, 'a=b=c');
});

test('parseEnv: 非法键名被忽略', () => {
  const r = parseEnv('123BAD=x\nALSO BAD=y\nGOOD_KEY=z');
  assert.equal(r.GOOD_KEY, 'z');
  assert.ok(!('123BAD' in r));
  assert.ok(!('ALSO BAD' in r));
});

test('parseEnv: 多个键', () => {
  const r = parseEnv(`
A=1
B=2
# comment
C="three"
`);
  assert.equal(r.A, '1');
  assert.equal(r.B, '2');
  assert.equal(r.C, 'three');
});

test('parseEnv: 值前后空白去除', () => {
  const r = parseEnv('FOO=  bar  ');
  assert.equal(r.FOO, 'bar');
});

// ============ envToConfig ============

test('envToConfig: 空 env 返回 null', () => {
  assert.equal(envToConfig({}), null);
});

test('envToConfig: 只有 KEY 没 MODEL 返回 null', () => {
  assert.equal(envToConfig({ ANTHROPIC_API_KEY: 'sk-ant-xxx' }), null);
});

test('envToConfig: Anthropic 完整配置', () => {
  const r = envToConfig({
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    ANTHROPIC_MODEL: 'claude-sonnet-4',
  });
  assert.ok(r);
  assert.equal(r.protocol, 'anthropic');
  assert.equal(r.apiKey, 'sk-ant-xxx');
  assert.equal(r.model, 'claude-sonnet-4');
  assert.ok(r.baseURL.includes('anthropic.com'));
});

test('envToConfig: OpenAI 完整配置', () => {
  const r = envToConfig({
    OPENAI_API_KEY: 'sk-xxx',
    OPENAI_MODEL: 'gpt-4o',
  });
  assert.ok(r);
  assert.equal(r.protocol, 'openai');
  assert.equal(r.model, 'gpt-4o');
  assert.ok(r.baseURL.includes('openai.com'));
});

test('envToConfig: OpenAI 自定义 baseURL', () => {
  const r = envToConfig({
    OPENAI_API_KEY: 'sk-xxx',
    OPENAI_BASE_URL: 'https://custom.proxy.com/v1',
    OPENAI_MODEL: 'gpt-4o',
  });
  assert.ok(r);
  assert.equal(r.baseURL, 'https://custom.proxy.com/v1');
});

test('envToConfig: DeepSeek 识别为 openai 协议', () => {
  const r = envToConfig({
    DEEPSEEK_API_KEY: 'sk-xxx',
    DEEPSEEK_MODEL: 'deepseek-chat',
  });
  assert.ok(r);
  assert.equal(r.protocol, 'openai');
  assert.equal(r.baseURL, 'https://api.deepseek.com');
  assert.equal(r.model, 'deepseek-chat');
});

test('envToConfig: 百炼识别', () => {
  const r = envToConfig({
    DASHSCOPE_API_KEY: 'sk-xxx',
    DASHSCOPE_MODEL: 'qwen-coder-plus',
  });
  assert.ok(r);
  assert.equal(r.protocol, 'openai');
  assert.ok(r.baseURL.includes('dashscope'));
});

test('envToConfig: 多个都配了用 Anthropic(优先级最高)', () => {
  const r = envToConfig({
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_MODEL: 'claude',
    OPENAI_API_KEY: 'sk-oai',
    OPENAI_MODEL: 'gpt',
  });
  assert.ok(r);
  assert.equal(r.apiKey, 'sk-ant');
  assert.equal(r.protocol, 'anthropic');
});

test('envToConfig: 返回 stream=true 和合理默认', () => {
  const r = envToConfig({
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_MODEL: 'claude',
  });
  assert.ok(r);
  assert.equal(r.stream, true);
  assert.equal(r.temperature, 0.3);
  assert.ok(r.maxTokens > 0);
});
