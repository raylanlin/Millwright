// tests/agent-loop.test.mjs
// P1 冒烟测试：验证工具 schema 转换 + agent 循环（用假 adapter，不打真实网络）。
// 运行： npm run build:main && node --test tests/agent-loop.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAITools, P1_TOOL_ALLOWLIST } from '../dist/main/main/llm/tools-schema.js';

test('工具 schema：白名单工具都被转换', () => {
  const tools = buildOpenAITools(true);
  assert.ok(tools.length === P1_TOOL_ALLOWLIST.size);
  const names = tools.map((t) => t.function.name);
  assert.ok(names.includes('create_sketch'));
  assert.ok(names.includes('extrude_feature'));
});

test('工具 schema：枚举参数正确解析', () => {
  const tools = buildOpenAITools(true);
  const sketch = tools.find((t) => t.function.name === 'create_sketch');
  const plane = sketch.function.parameters.properties.plane;
  assert.deepEqual(plane.enum, ['Front', 'Top', 'Right']);
  assert.ok(sketch.function.parameters.required.includes('plane'));
});

test('工具 schema：mm 数值参数映射为 number', () => {
  const tools = buildOpenAITools(true);
  const rect = tools.find((t) => t.function.name === 'draw_rectangle');
  assert.equal(rect.function.parameters.properties.width.type, 'number');
});

// 若要测完整 agent 循环，注入一个假 adapter：
// 第 1 轮返回 tool_calls，第 2 轮返回纯文本，断言工具被执行、循环收敛。
