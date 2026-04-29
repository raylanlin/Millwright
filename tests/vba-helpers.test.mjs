// tests/vba-helpers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mmToM,
  degToRad,
  vbaString,
  wrapMain,
  selectPlane,
  selectPlaneAppend,
} from '../dist/main/main/scripts/generators/vba-helpers.js';

// —— 单位换算 ——

test('mmToM: 基本值', () => {
  // 1mm = 0.001m
  assert.equal(mmToM(1), '0.001');
  // 20mm = 0.02m
  assert.equal(mmToM(20), '0.02');
  // 1000mm = 1m
  assert.equal(mmToM(1000), '1.0');
});

test('mmToM: 零处理', () => {
  // 0 必须保留小数点,避免被 VBA 当成 Integer
  assert.equal(mmToM(0), '0.0');
});

test('mmToM: 负数', () => {
  assert.equal(mmToM(-25), '-0.025');
});

test('mmToM: 精度', () => {
  // 0.1mm 要保留
  const r = mmToM(0.1);
  assert.ok(r === '0.0001', `got ${r}`);
});

test('degToRad: 基本值', () => {
  // 180° = π
  const r = parseFloat(degToRad(180));
  assert.ok(Math.abs(r - Math.PI) < 1e-6, `180° → ${r}`);
});

test('degToRad: 零', () => {
  assert.equal(degToRad(0), '0.0');
});

test('degToRad: 360°', () => {
  const r = parseFloat(degToRad(360));
  assert.ok(Math.abs(r - 2 * Math.PI) < 1e-6);
});

// —— vbaString ——

test('vbaString: 无引号', () => {
  assert.equal(vbaString('hello'), '"hello"');
});

test('vbaString: 单引号不转义(VBA 不需要)', () => {
  assert.equal(vbaString("it's"), `"it's"`);
});

test('vbaString: 双引号转义为双双引号', () => {
  assert.equal(vbaString('say "hi"'), '"say ""hi"""');
});

test('vbaString: Windows 路径不转义反斜杠', () => {
  assert.equal(vbaString('C:\\path\\to\\file'), '"C:\\path\\to\\file"');
});

test('vbaString: 空字符串', () => {
  assert.equal(vbaString(''), '""');
});

// —— wrapMain ——

test('wrapMain: 产出包含 Sub main 和 End Sub', () => {
  const out = wrapMain('Dim x As Integer');
  assert.ok(out.includes('Sub main()'));
  assert.ok(out.includes('End Sub'));
});

test('wrapMain: 默认带错误处理器', () => {
  const out = wrapMain('x = 1');
  assert.ok(out.includes('On Error GoTo ErrorHandler'));
  assert.ok(out.includes('ErrorHandler:'));
});

test('wrapMain: 可关闭错误处理器', () => {
  const out = wrapMain('x = 1', { withErrorHandler: false });
  assert.ok(!out.includes('On Error GoTo'));
  assert.ok(!out.includes('ErrorHandler:'));
});

test('wrapMain: body 正确缩进', () => {
  const out = wrapMain('Line1\nLine2');
  // 两行都应该被缩进 4 个空格
  assert.ok(out.includes('    Line1'));
  assert.ok(out.includes('    Line2'));
});

test('wrapMain: 以 Option Explicit 开头', () => {
  const out = wrapMain('x = 1');
  assert.ok(out.trimStart().startsWith('Option Explicit'));
});

// —— selectPlane ——

test('selectPlane: Front → "Front Plane"', () => {
  const out = selectPlane('Front');
  assert.ok(out.includes('"Front Plane"'));
  assert.ok(out.includes('SelectByID2'));
  assert.ok(out.includes('"PLANE"'));
});

test('selectPlane: 三个平面都能选', () => {
  assert.ok(selectPlane('Top').includes('"Top Plane"'));
  assert.ok(selectPlane('Right').includes('"Right Plane"'));
});

test('selectPlane: 包含中文 fallback', () => {
  const out = selectPlane('Front');
  assert.ok(out.includes('"前视基准面"'), '缺少中文 fallback');
  assert.ok(selectPlane('Top').includes('"上视基准面"'));
  assert.ok(selectPlane('Right').includes('"右视基准面"'));
});

test('selectPlane: fallback 用 If 判断选择数量', () => {
  const out = selectPlane('Front');
  assert.ok(out.includes('GetSelectedObjectCount2(-1) = 0'), '缺少选择数量检查');
});

// —— selectPlaneAppend ——

test('selectPlaneAppend: 使用追加选择参数', () => {
  const out = selectPlaneAppend('Front');
  assert.ok(out.includes('"Front Plane"'));
  assert.ok(out.includes(', True, 2,'), '缺少 Append=True, Mark=2');
});

test('selectPlaneAppend: 包含中文 fallback', () => {
  const out = selectPlaneAppend('Top');
  assert.ok(out.includes('"上视基准面"'), '缺少中文 fallback');
});

test('selectPlaneAppend: fallback 检查选择数量 < 2', () => {
  const out = selectPlaneAppend('Front');
  assert.ok(out.includes('< 2'), 'fallback 应检查 count < 2 (特征 + 面)');
});
