// tests/sse.test.mjs
// 纯 Node 自带 test runner,零额外依赖
// 运行:node --test tests/sse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../dist/main/main/llm/sse.js';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream) {
  const out = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
}

test('SSE: 单事件', async () => {
  const evs = await collect(streamOf(['data: hello\n\n']));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'hello');
});

test('SSE: 跨 chunk 断开的 data', async () => {
  const evs = await collect(streamOf(['data: hel', 'lo\n\n']));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'hello');
});

test('SSE: 注释行被忽略', async () => {
  const evs = await collect(streamOf([': heartbeat\ndata: ok\n\n']));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'ok');
});

test('SSE: 多行 data 按换行拼接', async () => {
  const evs = await collect(streamOf(['data: line1\ndata: line2\n\n']));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'line1\nline2');
});

test('SSE: event 名字段', async () => {
  const evs = await collect(streamOf(['event: message_start\ndata: {}\n\n']));
  assert.equal(evs[0].event, 'message_start');
  assert.equal(evs[0].data, '{}');
});

test('SSE: CRLF 换行', async () => {
  const evs = await collect(streamOf(['data: a\r\n\r\ndata: b\r\n\r\n']));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].data, 'a');
  assert.equal(evs[1].data, 'b');
});

test('SSE: 只有空 data 的事件被跳过', async () => {
  // 没有 data 行的事件应该返回 null(在 parseEventBlock 中),
  // 注意 :comment 本身不构成事件
  const evs = await collect(streamOf([':just comment\n\ndata: real\n\n']));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'real');
});

test('SSE: 冒号后可选空格', async () => {
  // 规范允许 "data:value" 和 "data: value",value 应该一致
  const evs = await collect(streamOf(['data:no-space\n\ndata: with-space\n\n']));
  assert.equal(evs[0].data, 'no-space');
  assert.equal(evs[1].data, 'with-space');
});
