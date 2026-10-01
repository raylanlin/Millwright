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

// P131: P130's pattern matched generic words anywhere (which / 多少 / 几个 / 哪个 / 你想), so
// ordinary plans read as questions (nudge skipped → user must type "继续" again), and
// common parameter requests without a question mark were missed.
test('looksLikeQuestion: plans that mention which/几个/哪个 still proceed', async () => {
  const { looksLikeQuestion } = await import('../dist/main/main/agent/agent-loop-sidecar.js');
  const plans = [
    'Plan: I will sketch an 80×50 rectangle on the Top Plane, which is the XZ plane in SolidWorks, extrude it 10 mm, then cut four Ø6.6 through holes at (±30, ±15). Starting now.',
    '方案：先确定几个关键尺寸——板 80×50×10，四角 M6 通孔距边 10 mm。步骤：1) 上视基准面画矩形并拉伸 10；2) 在顶面画 4 个圆并切除。现在开始执行。',
    '整体方案如下：齿轮模数 2、齿数 20、齿宽 15、内孔 Ø10。先说明一下在哪个基准面建模：用前视基准面，这样齿轮轴线沿 Z。接下来调用 create_spur_gear 生成齿轮，再切键槽。',
    '根据你想要的规格（法兰外径 120、厚 12、6 个 M8 孔均布在 PCD 90 上），方案：1) 前视基准面画 Ø120 圆拉伸 12；2) 顶面画 Ø9 孔，圆周阵列 6 个；3) 中心孔 Ø40。开始建模。',
    '方案：壁厚统一 2 mm，不管外形多少个圆角，最后统一 fillet R1。先画 100×60 轮廓拉伸 30，再 shell 2 mm 开口朝上，最后倒角。现在开始。',
  ];
  for (const p of plans) assert.equal(looksLikeQuestion(p), false, p);
});

test('looksLikeQuestion: parameter requests without a question mark end the turn', async () => {
  const { looksLikeQuestion } = await import('../dist/main/main/agent/agent-loop-sidecar.js');
  const asks = [
    '要生成这个齿轮，我还缺少以下参数：\n1. 模数 m\n2. 齿数 z\n3. 齿宽\n4. 内孔直径\n收到后我会立即建模。',
    '为了准确建模，请补充下列尺寸：法兰外径、厚度、螺栓孔数量与孔径、分布圆直径。拿到这些数值后我会一次性完成建模，不会使用示例值代替。',
    'Before I build the gear I need a few values from you: the module, the number of teeth, the face width and the bore diameter. Once I have them I will create it in one go.',
  ];
  for (const a of asks) assert.equal(looksLikeQuestion(a), true, a);
});
