// tests/sw-tools.test.mjs
//
// sw-tools is pure data; test its invariants:
//   - All tool names are unique (function calling dispatches by name; duplicates will break)
//   - name is a valid snake_case identifier
//   - Every tool has a non-empty description
//   - category is valid
//   - Category grouping covers all tools

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SW_TOOLS,
  CATEGORY_LABELS,
  getToolNames,
  getToolsByCategory,
} from '../dist/main/shared/sw-tools.js';

const VALID_CATEGORIES = new Set([
  'document', 'sketch', 'feature', 'assembly', 'export', 'batch', 'query',
]);

test('sw-tools: 工具名唯一', () => {
  const names = SW_TOOLS.map((t) => t.name);
  const uniq = new Set(names);
  assert.equal(uniq.size, names.length, `出现重复工具名: ${names.length - uniq.size} 个`);
});

test('sw-tools: name 是 snake_case', () => {
  const re = /^[a-z][a-z0-9_]*$/;
  for (const tool of SW_TOOLS) {
    assert.ok(re.test(tool.name), `非法 name: "${tool.name}"`);
  }
});

test('sw-tools: description 非空', () => {
  for (const tool of SW_TOOLS) {
    assert.ok(
      typeof tool.description === 'string' && tool.description.trim().length > 0,
      `空 description: ${tool.name}`,
    );
  }
});

test('sw-tools: category 合法', () => {
  for (const tool of SW_TOOLS) {
    assert.ok(
      VALID_CATEGORIES.has(tool.category),
      `非法 category: ${tool.name} -> ${tool.category}`,
    );
  }
});

test('sw-tools: CATEGORY_LABELS 覆盖所有分类', () => {
  for (const cat of VALID_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[cat], `缺少分类标签: ${cat}`);
  }
});

test('sw-tools: getToolNames 返回正确长度', () => {
  const names = getToolNames();
  assert.equal(names.length, SW_TOOLS.length);
});

test('sw-tools: getToolsByCategory 分组覆盖全部工具', () => {
  const grouped = getToolsByCategory();
  const totalAfterGroup = Object.values(grouped).reduce((acc, arr) => acc + arr.length, 0);
  assert.equal(totalAfterGroup, SW_TOOLS.length);
});

test('sw-tools: getToolsByCategory 的每条都属于正确分类', () => {
  const grouped = getToolsByCategory();
  for (const [cat, tools] of Object.entries(grouped)) {
    for (const tool of tools) {
      assert.equal(tool.category, cat, `${tool.name} 分组到了 ${cat},但自身 category=${tool.category}`);
    }
  }
});

test('sw-tools: 至少包含几个关键工具', () => {
  // These are shown in both the UI prototype and the docs; they should not be accidentally removed
  const required = ['create_part', 'create_fillet', 'extrude_feature', 'export_pdf', 'export_step'];
  const names = new Set(getToolNames());
  for (const r of required) {
    assert.ok(names.has(r), `缺少关键工具: ${r}`);
  }
});
