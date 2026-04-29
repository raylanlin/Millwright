// tests/code-extract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFirstCodeBlock,
  extractAllCodeBlocks,
} from '../dist/main/main/llm/code-extract.js';

test('extract: VBA with fence', () => {
  const text = 'ok\n```vba\nDim x As Integer\n```\ndone';
  const r = extractFirstCodeBlock(text);
  assert.ok(r);
  assert.equal(r.language, 'vba');
  assert.equal(r.code, 'Dim x As Integer');
});

test('extract: Python with fence', () => {
  const text = '```python\nimport win32com.client\n```';
  const r = extractFirstCodeBlock(text);
  assert.ok(r);
  assert.equal(r.language, 'python');
});

test('extract: language alias - py', () => {
  const r = extractFirstCodeBlock('```py\nprint(1)\n```');
  assert.equal(r?.language, 'python');
});

test('extract: language alias - vb', () => {
  const r = extractFirstCodeBlock('```vb\nDim x\n```');
  assert.equal(r?.language, 'vba');
});

test('extract: inferred VBA from Dim ... As', () => {
  const r = extractFirstCodeBlock('```\nDim swApp As SldWorks.SldWorks\n```');
  assert.equal(r?.language, 'vba');
});

test('extract: inferred Python from import win32com', () => {
  const r = extractFirstCodeBlock('```\nimport win32com.client\nsw = win32com.client.Dispatch("SldWorks.Application")\n```');
  assert.equal(r?.language, 'python');
});

test('extract: no code returns null', () => {
  assert.equal(extractFirstCodeBlock('no code here'), null);
});

test('extract: ambiguous untagged block returns null', () => {
  // 没有 VBA/Python 明确信号的无标签代码块应该被忽略
  const r = extractFirstCodeBlock('```\nfoo bar baz\n```');
  assert.equal(r, null);
});

test('extract: unrecognized language tag returns null', () => {
  // 不是 vba/python 的 fence 不应被抽成代码
  const r = extractFirstCodeBlock('```rust\nfn main() {}\n```');
  assert.equal(r, null);
});

test('extract: first of multiple blocks', () => {
  const text = '```vba\nsub A\nend sub\n```\n\n```python\nprint(1)\n```';
  const r = extractFirstCodeBlock(text);
  assert.equal(r?.language, 'vba');
  assert.ok(r?.code.includes('sub A'));
});

test('extract: extractAllCodeBlocks returns both', () => {
  const text = '```vba\nsub A\nend sub\n```\n\n```python\nprint(1)\n```';
  const all = extractAllCodeBlocks(text);
  assert.equal(all.length, 2);
  assert.equal(all[0].language, 'vba');
  assert.equal(all[1].language, 'python');
});

test('extract: empty code block skipped', () => {
  assert.equal(extractFirstCodeBlock('```vba\n```'), null);
});
