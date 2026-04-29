// tests/presets.test.mjs
//
// 校验预设数据的一致性:
//   - DEFAULT_URLS 两个协议都有
//   - DEFAULT_URLS 是合法 URL
//   - MODEL_PRESETS 两个协议都有,且都包含 "custom" 选项
//   - DEFAULT_CONFIG 能通过 validateConfig(除了 apiKey 外)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_URLS,
  MODEL_PRESETS,
  DEFAULT_CONFIG,
  OPENAI_COMPATIBLE_PROVIDERS,
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

test('presets: DEFAULT_CONFIG 默认使用 anthropic + 对应 URL', () => {
  assert.equal(DEFAULT_CONFIG.protocol, 'anthropic');
  assert.equal(DEFAULT_CONFIG.baseURL, DEFAULT_URLS.anthropic);
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
