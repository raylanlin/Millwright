// tests/llm-request.test.mjs
//
// P131: the request bodies the adapters actually put on the wire, per model.
// Current Claude models (Fable 5 / 5.1, Opus 4.7+, Sonnet 5+) reject `temperature`
// and `budget_tokens` with a 400; GPT-6 Astra rejects `max_tokens`, `temperature`
// and `reasoning_effort` alongside tools. A stubbed global fetch records each body.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../dist/main/main/llm/anthropic.js';
import { OpenAIAdapter } from '../dist/main/main/llm/openai.js';
import {
  claudeCaps,
  isOpenAIReasoningModel,
  isReasoningParamError,
} from '../dist/main/main/llm/thinking.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub fetch: answers each request with the next queued [status, json] pair. */
function stubFetch(...replies) {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const [status, json] = replies.length > 1 ? replies.shift() : replies[0];
    return new Response(JSON.stringify(json), {
      status, headers: { 'content-type': 'application/json' },
    });
  };
  return bodies;
}

const CLAUDE_OK = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const OPENAI_OK = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ type: 'function', function: { name: 'sw_status', description: 'x', parameters: { type: 'object', properties: {} } } }];

const claude = (model, extra = {}) => new AnthropicAdapter({
  protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'k', model, temperature: 0.3, ...extra,
});
const openai = (model, extra = {}) => new OpenAIAdapter({
  protocol: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'k', model, temperature: 0.3, ...extra,
});

test('claudeCaps: model families', () => {
  for (const id of ['claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
    assert.equal(claudeCaps(id).alwaysThinks, true, id);
    assert.equal(claudeCaps(id).noSampling, true, id);
  }
  for (const id of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4.7', 'anthropic.claude-sonnet-5']) {
    assert.equal(claudeCaps(id).noSampling, true, id);
    assert.equal(claudeCaps(id).alwaysThinks, false, id);
  }
  assert.equal(claudeCaps('claude-opus-4-8').thinksByDefault, false);
  assert.equal(claudeCaps('claude-opus-5').thinksByDefault, true);
  assert.deepEqual(claudeCaps('claude-sonnet-4-6'), { noSampling: false, adaptive: true, thinksByDefault: false, alwaysThinks: false });
  for (const id of ['claude-haiku-4-5-20251001', 'claude-3-7-sonnet-20250219', 'claude-sonnet-4-20250514', 'MiniMax-M3', '']) {
    assert.equal(claudeCaps(id).adaptive, false, id);
    assert.equal(claudeCaps(id).noSampling, false, id);
  }
});

test('anthropic: Fable 5.1 / Opus 5.5 never get temperature or budget thinking', async () => {
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5']) {
    for (const reasoningLevel of ['auto', 'off', 'adaptive', 'low', 'medium', 'high']) {
      const bodies = stubFetch([200, CLAUDE_OK]);
      await claude(model, { reasoningLevel }).chatWithTools(MSGS, undefined, TOOLS);
      const b = bodies[0];
      assert.equal('temperature' in b, false, `${model}/${reasoningLevel} sent temperature`);
      assert.notEqual(b.thinking?.type, 'disabled', `${model}/${reasoningLevel} disabled thinking`);
      assert.equal(b.thinking?.budget_tokens, undefined, `${model}/${reasoningLevel} sent budget_tokens`);
      assert.equal('tool_choice' in b, false, 'forced tool_choice is a 400 on these models');
    }
  }
});

test('anthropic: reasoning level maps to adaptive thinking + effort', async () => {
  let bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-opus-5-5', { reasoningLevel: 'high' }).chat(MSGS);
  assert.deepEqual(bodies[0].thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(bodies[0].output_config, { effort: 'high' });

  bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-opus-5-5', { reasoningLevel: 'off' }).chat(MSGS);
  assert.deepEqual(bodies[0].output_config, { effort: 'low' }, 'off → lowest effort on an always-thinking model');

  bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-opus-4-8', { reasoningLevel: 'off' }).chat(MSGS);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal('temperature' in bodies[0], false);

  bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-opus-4-8').chat(MSGS);
  assert.equal('thinking' in bodies[0], false, 'auto on Opus 4.8 = provider default');
  assert.equal('temperature' in bodies[0], false);
});

test('anthropic: older / proxied models keep temperature and budget thinking', async () => {
  let bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-sonnet-4-6').chat(MSGS);
  assert.equal(bodies[0].temperature, 0.3);

  bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-haiku-4-5', { reasoningLevel: 'medium' }).chatWithTools(MSGS, undefined, TOOLS);
  assert.deepEqual(bodies[0].thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.equal('temperature' in bodies[0], false, 'budget thinking requires the default temperature');

  bodies = stubFetch([200, CLAUDE_OK]);
  await claude('MiniMax-M3', { baseURL: 'https://api.minimax.io/anthropic' }).chat(MSGS);
  assert.equal(bodies[0].temperature, 0.3);
});

test('anthropic: a 400 naming temperature is retried once without it', async () => {
  const bodies = stubFetch(
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: is not supported for this model' } }],
    [200, CLAUDE_OK],
  );
  const r = await claude('claude-unknown-9').chat(MSGS);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0.3);
  assert.equal('temperature' in bodies[1], false);
  assert.equal(r.content, 'ok');
});

test('anthropic: an unrelated 400 is not retried', async () => {
  const bodies = stubFetch([400, { type: 'error', error: { message: 'messages: roles must alternate' } }]);
  await assert.rejects(claude('claude-sonnet-4-6').chat(MSGS));
  assert.equal(bodies.length, 1);
});

test('anthropic: refusal stop_reason surfaces a notice instead of an empty reply', async () => {
  stubFetch([200, { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }]);
  const r = await claude('claude-fable-5-1').chatWithTools(MSGS, undefined, TOOLS);
  assert.match(r.content, /拒绝/);
  assert.match(r.content, /cyber/);
});

test('openai: GPT-6 Astra is a reasoning model on OpenAI hosts only', () => {
  assert.equal(isOpenAIReasoningModel('https://api.openai.com/v1', 'gpt-6-astra'), true);
  assert.equal(isOpenAIReasoningModel('https://api.openai.com/v1', 'gpt-5.6-sol'), true);
  assert.equal(isOpenAIReasoningModel('https://api.openai.com/v1', 'o4-mini'), true);
  assert.equal(isOpenAIReasoningModel('https://api.openai.com/v1', 'gpt-4.1'), false);
  assert.equal(isOpenAIReasoningModel('https://api.siliconflow.cn/v1', 'gpt-6-astra'), false);
});

test('openai: GPT-6 Astra gets max_completion_tokens and no temperature', async () => {
  const bodies = stubFetch([200, OPENAI_OK]);
  await openai('gpt-6-astra').chatWithTools(MSGS, undefined, TOOLS);
  const b = bodies[0];
  assert.ok(b.max_completion_tokens > 0);
  assert.equal('max_tokens' in b, false);
  assert.equal('temperature' in b, false);
});

test('openai: GPT-6 Astra drops reasoning_effort when tools are present', async () => {
  let bodies = stubFetch([200, OPENAI_OK]);
  await openai('gpt-6-astra', { reasoningLevel: 'high' }).chatWithTools(MSGS, undefined, TOOLS);
  assert.equal('reasoning_effort' in bodies[0], false);

  bodies = stubFetch([200, OPENAI_OK]);
  await openai('gpt-6-astra', { reasoningLevel: 'off' }).chat(MSGS);
  assert.equal(bodies[0].reasoning_effort, 'low', "'minimal' is rejected by GPT-6");

  bodies = stubFetch([200, OPENAI_OK]);
  await openai('gpt-5.6-sol', { reasoningLevel: 'high' }).chatWithTools(MSGS, undefined, TOOLS);
  assert.equal(bodies[0].reasoning_effort, 'high', 'GPT-5.x keeps its effort with tools');
});

test('openai: test() uses max_completion_tokens for reasoning models', async () => {
  let bodies = stubFetch([200, OPENAI_OK]);
  await openai('gpt-6-astra').test();
  assert.equal('max_tokens' in bodies[0], false);
  assert.ok(bodies[0].max_completion_tokens > 0);

  bodies = stubFetch([200, OPENAI_OK]);
  await openai('deepseek-v4-pro', { baseURL: 'https://api.deepseek.com' }).test();
  assert.equal(bodies[0].max_tokens, 1);
});

test('isReasoningParamError: GPT-6 tools + reasoning_effort rejection is recognised', () => {
  assert.equal(isReasoningParamError(JSON.stringify({ error: { message:
    "Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } })), true);
  assert.equal(isReasoningParamError('{"error":{"message":"Incorrect API key provided"}}'), false);
});

test('truncateMessages: an overhead larger than the budget keeps the last whole block', async () => {
  const { truncateMessages } = await import('../dist/main/main/llm/context-window.js');
  const history = [
    { role: 'user', content: 'make a plate' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'new_part', parameters: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
  ];
  const kept = truncateMessages(history, 'x '.repeat(200_000), 'claude-opus-5-5', 8192);
  assert.notEqual(kept[0]?.role, 'tool', 'a lone tool result is a 400');
  assert.equal(kept[0]?.role, 'assistant');
  assert.equal(kept.length, 2);
});

test('llmFetch: connectMs 0 lets a slow non-streaming answer finish', async () => {
  const { llmFetch } = await import('../dist/main/main/llm/net.js');
  let calls = 0;
  globalThis.fetch = (_u, init) => new Promise((resolve, reject) => {
    calls++;
    const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 80);
    init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
  });
  await assert.rejects(llmFetch('https://x.test', {}, 0, { connectMs: 20 }), /connect timeout/);
  calls = 0;
  const res = await llmFetch('https://x.test', {}, 2, { connectMs: 0 });
  assert.equal(res.status, 200);
  assert.equal(calls, 1, 'a finished-but-slow request must not be re-sent');
});

test('anthropic: Sonnet 4.6 keeps temperature when thinking is switched off', async () => {
  const bodies = stubFetch([200, CLAUDE_OK]);
  await claude('claude-sonnet-4-6', { reasoningLevel: 'off' }).chat(MSGS);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[0].temperature, 0.3);
});
