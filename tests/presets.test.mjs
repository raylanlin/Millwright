// tests/presets.test.mjs
//
// Validate consistency of preset data:
//   - DEFAULT_URLS covers both protocols
//   - DEFAULT_URLS are valid URLs
//   - MODEL_PRESETS covers both protocols, each with a "custom" option
//   - DEFAULT_CONFIG passes validateConfig (except for apiKey)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_URLS,
  MODEL_PRESETS,
  DEFAULT_CONFIG,
  OPENAI_COMPATIBLE_PROVIDERS,
  PROVIDERS,
  providerForURL,
  providersFor,
  modelOptions,
  switchProtocol,
  applyProviderPreset,
} from '../dist/main/shared/presets.js';
import { validateConfig } from '../dist/main/main/llm/factory.js';

test('presets: DEFAULT_URLS 覆盖两个协议', () => {
  assert.ok(DEFAULT_URLS.anthropic);
  assert.ok(DEFAULT_URLS.openai);
});

test('presets: DEFAULT_URLS 是合法 URL', () => {
  for (const url of Object.values(DEFAULT_URLS)) {
    assert.doesNotThrow(() => new URL(url), `非法 URL: ${url}`);
  }
});

test('presets: MODEL_PRESETS 每个协议都有 custom 选项', () => {
  for (const [protocol, presets] of Object.entries(MODEL_PRESETS)) {
    const hasCustom = presets.some((p) => p.value === 'custom');
    assert.ok(hasCustom, `${protocol} 缺少 custom 选项`);
  }
});

test('presets: MODEL_PRESETS 每个预设都有 label 和 value', () => {
  for (const [protocol, presets] of Object.entries(MODEL_PRESETS)) {
    for (const p of presets) {
      assert.ok(p.label, `${protocol} 预设缺少 label`);
      assert.ok(p.value, `${protocol} 预设缺少 value`);
    }
  }
});

test('presets: OPENAI_COMPATIBLE_PROVIDERS 每个都是合法 URL', () => {
  for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
    assert.ok(provider.name, '缺少 name');
    assert.doesNotThrow(
      () => new URL(provider.url),
      `非法 provider URL: ${provider.name} -> ${provider.url}`,
    );
  }
});

test('presets: DEFAULT_CONFIG 除 apiKey 外通过校验', () => {
  const withFakeKey = { ...DEFAULT_CONFIG, apiKey: 'fake-for-test' };
  const r = validateConfig(withFakeKey);
  assert.equal(r.valid, true, `DEFAULT_CONFIG 不通过: ${r.issues.join(', ')}`);
});

test('presets: DEFAULT_CONFIG 默认使用 openai + DeepSeek URL', () => {
  assert.equal(DEFAULT_CONFIG.protocol, 'openai');
  assert.equal(DEFAULT_CONFIG.baseURL, 'https://api.deepseek.com');
});

test('presets: DEFAULT_CONFIG 温度和 maxTokens 在合理范围', () => {
  assert.ok(
    DEFAULT_CONFIG.temperature >= 0 && DEFAULT_CONFIG.temperature <= 1,
    `异常 temperature: ${DEFAULT_CONFIG.temperature}`,
  );
  assert.ok(
    DEFAULT_CONFIG.maxTokens > 0 && DEFAULT_CONFIG.maxTokens <= 200_000,
    `异常 maxTokens: ${DEFAULT_CONFIG.maxTokens}`,
  );
});

// ===== P132: provider-organised presets =====

test('presets: every provider URL is valid and its suggested model is one of its models', () => {
  for (const p of PROVIDERS) {
    for (const url of Object.values(p.urls)) assert.doesNotThrow(() => new URL(url), `${p.id}: ${url}`);
    if (p.suggestedModel) {
      assert.ok(p.models.some((m) => m.value === p.suggestedModel), `${p.id}: ${p.suggestedModel}`);
    }
  }
});

test('presets: retired DeepSeek ids are gone, deepseek-flash is listed', () => {
  const ids = PROVIDERS.flatMap((p) => p.models.map((m) => m.value));
  assert.equal(ids.includes('deepseek-v4-flash'), false);
  assert.ok(ids.includes('deepseek-flash'));
});

test('presets: a URL resolves to its provider, by exact URL or by host', () => {
  assert.equal(providerForURL('https://api.deepseek.com')?.id, 'deepseek');
  assert.equal(providerForURL('https://api.deepseek.com/anthropic/')?.id, 'deepseek');
  assert.equal(providerForURL('https://api.deepseek.com/v1')?.id, 'deepseek');
  assert.equal(providerForURL('https://my-gateway.example.com/v1'), undefined);
});

test('presets: the model list shows only the provider\'s models + custom', () => {
  const ds = modelOptions('openai', 'https://api.deepseek.com').map((m) => m.value);
  assert.deepEqual(ds, ['deepseek-v4-pro', 'deepseek-flash', 'custom']);
  assert.deepEqual(modelOptions('anthropic', 'https://api.deepseek.com/anthropic').map((m) => m.value),
    ['deepseek-v4-pro', 'deepseek-flash', 'custom']);
  assert.deepEqual(modelOptions('openai', 'https://my-gateway.example.com/v1').map((m) => m.value), ['custom']);
  assert.deepEqual(modelOptions('anthropic', 'https://api.openai.com/v1').map((m) => m.value), ['custom']);
});

test('presets: switching protocol keeps the provider and swaps its URL', () => {
  assert.deepEqual(switchProtocol({ baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'anthropic'),
    { baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' });
  assert.deepEqual(switchProtocol({ baseURL: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3' }, 'openai'),
    { baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3' });
  // OpenAI has no Anthropic endpoint → the official Anthropic endpoint + its model
  assert.deepEqual(switchProtocol({ baseURL: 'https://api.openai.com/v1', model: 'gpt-6-astra' }, 'anthropic'),
    { baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5' });
  assert.deepEqual(switchProtocol({ baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5' }, 'openai'),
    { baseURL: 'https://api.openai.com/v1', model: 'gpt-6-astra' });
});

test('presets: quick-fill uses the URL for the selected protocol', () => {
  const ds = PROVIDERS.find((p) => p.id === 'deepseek');
  assert.equal(applyProviderPreset(ds, 'anthropic').baseURL, 'https://api.deepseek.com/anthropic');
  assert.equal(applyProviderPreset(ds, 'openai').baseURL, 'https://api.deepseek.com');
  assert.equal(applyProviderPreset(ds, 'openai', 'deepseek-flash').model, 'deepseek-flash');
  assert.equal(applyProviderPreset(ds, 'openai', 'gpt-6-astra').model, 'deepseek-v4-pro');
  assert.ok(providersFor('anthropic').every((p) => p.urls.anthropic));
  assert.equal(providersFor('anthropic').some((p) => p.id === 'openai'), false);
});
