// tests/generators.test.mjs
//
// 覆盖重点:
//   1. 注册表与 SW_TOOLS 一致(覆盖率 100%)
//   2. 每个工具用 exampleParams 能成功生成代码
//   3. 生成的代码都通过 sanitizer(即不含黑名单模式)
//   4. 几个关键工具的 VBA 内容检查(参数正确嵌入)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateScript,
  registeredToolNames,
  checkCoverage,
} from '../dist/main/main/scripts/generators/index.js';
import { SW_TOOLS } from '../dist/main/shared/sw-tools.js';
import { validateScript } from '../dist/main/main/scripts/sanitizer.js';

// —— 完整性 ——

test('generators: 注册表覆盖所有 SW_TOOLS', () => {
  const cov = checkCoverage(SW_TOOLS);
  assert.deepEqual(cov.missing, [], `缺少生成器: ${cov.missing.join(', ')}`);
});

test('generators: 没有多余未声明的工具', () => {
  const cov = checkCoverage(SW_TOOLS);
  assert.deepEqual(cov.extra, [], `注册表多余项: ${cov.extra.join(', ')}`);
});

test('generators: 注册表数量与 SW_TOOLS 一致', () => {
  assert.equal(registeredToolNames().length, SW_TOOLS.length);
});

// —— 每个工具都能生成 ——

test('generators: 每个工具用 exampleParams 可成功生成', () => {
  for (const tool of SW_TOOLS) {
    assert.doesNotThrow(
      () => generateScript(tool.name, tool.exampleParams ?? {}),
      `工具 ${tool.name} 生成失败`,
    );
  }
});

test('generators: 每个工具生成的代码非空且有 Sub main', () => {
  for (const tool of SW_TOOLS) {
    const r = generateScript(tool.name, tool.exampleParams ?? {});
    assert.ok(r.code.length > 50, `${tool.name} 代码过短`);
    assert.ok(r.code.includes('Sub main()'), `${tool.name} 缺少 Sub main`);
    assert.ok(r.code.includes('End Sub'), `${tool.name} 缺少 End Sub`);
    assert.equal(r.language, 'vba');
    assert.equal(r.toolName, tool.name);
  }
});

test('generators: 每个工具生成的代码都通过 sanitizer', () => {
  for (const tool of SW_TOOLS) {
    const r = generateScript(tool.name, tool.exampleParams ?? {});
    const v = validateScript(r.code, 'vba');
    assert.ok(v.safe, `${tool.name} 被 sanitizer 拦截: ${v.issues.join(', ')}`);
  }
});

// —— 错误处理 ——

test('generators: 未知工具名抛错', () => {
  assert.throws(() => generateScript('nonexistent_tool', {}));
});

// —— 单位换算正确性检查 ——

test('generators: create_fillet 正确换算 mm → m', () => {
  const r = generateScript('create_fillet', { radius: 3 });
  // 3mm = 0.003m
  assert.ok(r.code.includes('0.003'), `没找到 0.003: ${r.code}`);
  assert.ok(r.code.includes('3 mm'), '注释里应该有 3 mm');
});

test('generators: extrude_feature 深度正确换算', () => {
  const r = generateScript('extrude_feature', { depth: 20 });
  // 20mm = 0.02m
  assert.ok(r.code.includes('0.02'));
});

test('generators: extrude_feature 双向等距', () => {
  const bothR = generateScript('extrude_feature', { depth: 20, direction: 'both' });
  const singleR = generateScript('extrude_feature', { depth: 20 });
  // 双向会有两个 0.02,并且第三个参数(double-sided)为 True
  // 单向版本第三个参数为 False
  assert.ok(bothR.code.includes('True, False, True'), '双向未启用');
  assert.ok(singleR.code.includes('True, False, False'), '单向应该关双向');
});

test('generators: create_revolve 度→弧度', () => {
  const r = generateScript('create_revolve', { angle: 180 });
  // 180° = π
  const piStr = (Math.PI).toFixed(8).replace(/\.?0+$/, '');
  assert.ok(r.code.includes(piStr), `没找到 π 值 ${piStr}`);
});

// —— 特殊输入处理 ——

test('generators: draw_rectangle 两对角点计算正确', () => {
  const r = generateScript('draw_rectangle', { x: 10, y: 20, width: 50, height: 30 });
  // 左下 (10, 20) → 右上 (60, 50),都转成 m
  assert.ok(r.code.includes('0.01'));
  assert.ok(r.code.includes('0.02'));
  assert.ok(r.code.includes('0.06'));
  assert.ok(r.code.includes('0.05'));
});

test('generators: draw_circle 圆心 + 边缘点', () => {
  const r = generateScript('draw_circle', { x: 0, y: 0, radius: 15 });
  assert.ok(r.code.includes('CreateCircle'));
  assert.ok(r.code.includes('0.015')); // 15mm radius
});

test('generators: export_pdf 路径正确嵌入 + 双引号转义', () => {
  const r = generateScript('export_pdf', {
    outputPath: 'C:\\my "special" dir\\out.pdf',
  });
  // 双引号要被转成 ""
  assert.ok(r.code.includes('""special""'), `没转义双引号: ${r.code}`);
});

test('generators: add_mate 未知类型不抛异常(只在脚本里提示)', () => {
  // 容错设计:生成器不挂,让运行时用户看到对话框
  const r = generateScript('add_mate', { type: 'hot-glue' });
  assert.ok(r.code.includes('未知配合类型'));
});

test('generators: add_mate 已知类型正确映射', () => {
  const r = generateScript('add_mate', { type: 'concentric' });
  // concentric → MateType=1
  assert.ok(r.code.includes('AddMate5 1,'));
});

test('generators: batch_rename 字符串嵌入双引号转义', () => {
  const r = generateScript('batch_rename', {
    pattern: 'old"name',
    replacement: 'new',
  });
  assert.ok(r.code.includes('"old""name"'));
});

test('generators: modify_dimensions 尺寸名拼接格式', () => {
  const r = generateScript('modify_dimensions', {
    featureName: 'Boss-Extrude1',
    dimName: 'D1',
    value: 30,
  });
  // "D1@Boss-Extrude1" 应该出现
  assert.ok(r.code.includes('"D1@Boss-Extrude1"'));
  // 30mm → 0.03m
  assert.ok(r.code.includes('0.03'));
});

test('generators: bom_export xlsx 格式提醒改 CSV', () => {
  const r = generateScript('bom_export', {
    outputPath: 'C:\\out\\bom.xlsx',
    format: 'xlsx',
  });
  // 应该有说明,并且路径还是原样写入(让用户知道后续用 Excel 打开)
  assert.ok(r.code.includes('CSV') || r.code.includes('csv'));
});

test('generators: mirror_feature 用追加选择(Mark=2)选镜像面', () => {
  // mirror 依赖"先选特征,再追加选镜像面"的语义。
  // selectPlaneAppend 用 Append=True, Mark=2,并自动 fallback 中文基准面名
  const r = generateScript('mirror_feature', { plane: 'Front' });
  assert.ok(r.code.includes('"Front Plane"'), '缺少英文基准面名');
  assert.ok(r.code.includes(', True, 2,'), '追加选择的 Append=True / Mark=2 丢失');
  // 验证中文 fallback
  assert.ok(r.code.includes('"前视基准面"'), '缺少中文 fallback 基准面名');
});

test('generators: create_sketch 中文 fallback 基准面', () => {
  const r = generateScript('create_sketch', { plane: 'Top' });
  assert.ok(r.code.includes('"Top Plane"'), '缺少英文基准面名');
  assert.ok(r.code.includes('"上视基准面"'), '缺少中文 fallback 基准面名');
});
