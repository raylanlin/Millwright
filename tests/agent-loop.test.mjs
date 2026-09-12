// tests/agent-loop.test.mjs
// P1 smoke test: verify tool schema conversion + agent loop (uses fake adapter, no real network).
// Run: npm run build:main && node --test tests/agent-loop.test.mjs

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

// To test the full agent loop, inject a fake adapter:
// Round 1 returns tool_calls, round 2 returns plain text; assert tools are executed and loop converges.

// P130: looksLikeQuestion — auto-nudge must respect the model's questions.
// A reply that ends with a question mark, contains two or more question marks, or uses
// "please tell me" / "what module" style phrasing must end the turn.
test('looksLikeQuestion: asking for parameters ends the turn', async () => {
  const { looksLikeQuestion } = await import('../dist/main/main/agent/agent-loop-sidecar.js');
  assert.equal(looksLikeQuestion('我需要几个关键参数才能开工。请告诉我:\n1. 模数 m\n2. 齿数 z'), true);
  assert.equal(looksLikeQuestion('What module and tooth count do you want?'), true);
  assert.equal(looksLikeQuestion('Plan: top plane, 80×50 plate, extrude 10 mm, then four M6 holes. Starting now.'), false);
});
