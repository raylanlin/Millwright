// src/main/llm/thinking.ts
//
// P51: reasoning-model support.
//
// Reasoning models deliver their scratchpad in one of two shapes:
//   a) a separate SSE field — `delta.reasoning_content` (DeepSeek, Qwen, MiniMax, GLM)
//   b) inline in the content, wrapped in <think>…</think> (many OSS models)
// Either way it is NOT the answer: it must be shown separately (collapsed), and must
// never be fed back as history — re-sending thousands of "let me reconsider" tokens
// eats the context window and drags the model back into the same loops.
//
// This module owns three things: stripping/splitting reasoning text, an INCREMENTAL
// splitter for streaming, and the per-provider request parameters that turn reasoning
// on/off and set its depth.

const TAGS = ['think', 'thinking', 'reasoning'];

export function stripThinking(text?: string): string {
  if (!text) return '';
  let out = text;
  for (const tag of TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, 'i'), '');   // unclosed tail
    out = out.replace(new RegExp(`^[\\s\\S]*?<\\/${tag}>`, 'i'), ''); // orphan closer
  }
  return out.trim();
}

/** Split a finished message into its reasoning and its answer. */
export function splitThinking(text?: string): { reasoning: string; answer: string } {
  if (!text) return { reasoning: '', answer: '' };
  const parts: string[] = [];
  for (const tag of TAGS) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)(?:<\\/${tag}>|$)`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) parts.push(m[1]);
  }
  return { reasoning: parts.join('\n').trim(), answer: stripThinking(text) };
}

/**
 * Incremental <think> splitter for streaming. Feed each chunk; get back the parts
 * that belong to the answer and to the reasoning. Handles a tag arriving split
 * across two chunks by holding back a short tail.
 */
export class ThinkSplitter {
  private inside = false;
  private hold = '';

  feed(chunk: string): { answer: string; reasoning: string } {
    let buf = this.hold + chunk;
    this.hold = '';
    let answer = '';
    let reasoning = '';

    for (;;) {
      if (!this.inside) {
        const open = buf.search(/<(think|thinking|reasoning)>/i);
        if (open === -1) break;
        answer += buf.slice(0, open);
        const close = buf.indexOf('>', open);
        buf = buf.slice(close + 1);
        this.inside = true;
      } else {
        const end = buf.search(/<\/(think|thinking|reasoning)>/i);
        if (end === -1) break;
        reasoning += buf.slice(0, end);
        const close = buf.indexOf('>', end);
        buf = buf.slice(close + 1);
        this.inside = false;
      }
    }

    // A partial tag may be split across chunks — hold back just enough to re-join.
    const tail = buf.lastIndexOf('<');
    if (tail !== -1 && buf.length - tail < 12) {
      this.hold = buf.slice(tail);
      buf = buf.slice(0, tail);
    }
    if (this.inside) reasoning += buf;
    else answer += buf;
    return { answer, reasoning };
  }

  /** Anything still held back when the stream ends. */
  flush(): { answer: string; reasoning: string } {
    const rest = this.hold;
    this.hold = '';
    return this.inside ? { answer: '', reasoning: rest } : { answer: rest, reasoning: '' };
  }
}

// ===== Reasoning request parameters =====

export type ReasoningLevel = 'auto' | 'off' | 'adaptive' | 'low' | 'medium' | 'high';
export type ReasoningDialect = 'auto' | 'none' | 'effort' | 'qwen' | 'zhipu' | 'deepseek' | 'minimax';

/**
 * Providers spell "think harder" differently, and sending the wrong field is a hard
 * 400 on strict gateways. Infer the dialect from the base URL; the user can override
 * it in Settings when a gateway is proxying something unusual.
 */
export function detectDialect(baseURL?: string): Exclude<ReasoningDialect, 'auto'> {
  const u = (baseURL ?? '').toLowerCase();
  if (u.includes('dashscope')) return 'qwen';            // enable_thinking + thinking_budget
  if (u.includes('bigmodel') || u.includes('zhipu')) return 'zhipu';  // thinking.type
  if (u.includes('deepseek')) return 'deepseek';         // thinking.type
  // P54: MiniMax M3 takes thinking:{type: enabled|adaptive|disabled} — NOT reasoning_effort.
  // Sending the wrong one was silently ignored (the 400 fallback stripped it), so the
  // reasoning setting simply had no effect.
  if (u.includes('minimax')) return 'minimax';
  if (u.includes('openai.com') || u.includes('moonshot')) return 'effort';
  return 'none';                                          // unknown gateway: send nothing
}

const BUDGET: Record<string, number> = { adaptive: 4096, low: 1024, medium: 4096, high: 16384 };

/**
 * Build the extra body fields for the requested reasoning level.
 * 'auto' sends nothing (provider default) — the safest choice for unknown gateways.
 *
 * Verified against each provider's own documentation (2026-07):
 *   OpenAI / Kimi   reasoning_effort: low | medium | high
 *   DeepSeek        thinking:{type} AND reasoning_effort — V4 maps low/medium → high
 *                   and xhigh → max, so only high/max are meaningfully distinct.
 *                   Thinking mode ignores temperature/top_p (no error, no effect).
 *   GLM / Z.ai      thinking:{type: enabled|disabled}   ← NOT enable_thinking
 *   Qwen/DashScope  enable_thinking (binary) + thinking_budget; OSS builds served by
 *                   vLLM/SGLang need it inside chat_template_kwargs instead
 *   MiniMax M3      thinking:{type: enabled|adaptive|disabled}
 */
export function reasoningParams(
  level: ReasoningLevel | undefined,
  dialect: ReasoningDialect | undefined,
  baseURL?: string,
): Record<string, any> {
  const lv = level ?? 'auto';
  if (lv === 'auto') return {};
  const d = !dialect || dialect === 'auto' ? detectDialect(baseURL) : dialect;
  if (d === 'none') return {};
  const on = lv !== 'off';

  switch (d) {
    case 'minimax':
      // enabled = always think · adaptive = model decides · disabled = off
      return { thinking: { type: !on ? 'disabled' : lv === 'adaptive' ? 'adaptive' : 'enabled' } };

    case 'deepseek':
      // Toggle and depth are separate fields, and both are needed: the toggle alone
      // leaves effort at its default (high), the effort alone can't turn thinking off.
      if (!on) return { thinking: { type: 'disabled' } };
      return {
        thinking: { type: 'enabled' },
        // V4 collapses low/medium into high; 'max' is the only step above it.
        reasoning_effort: lv === 'high' ? 'max' : 'high',
      };

    case 'zhipu':
      return { thinking: { type: on ? 'enabled' : 'disabled' } };

    case 'qwen': {
      // Binary toggle, no graded effort. chat_template_kwargs is the form self-hosted
      // vLLM/SGLang builds accept; sending both is harmless — each side ignores the
      // field it doesn't know.
      const budget = BUDGET[lv] ?? 4096;
      return on
        ? {
            enable_thinking: true,
            thinking_budget: budget,
            chat_template_kwargs: { enable_thinking: true },
          }
        : { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
    }

    case 'effort':
      // OpenAI-style. 'off' becomes minimal effort — there is no documented way to
      // disable reasoning on a reasoning-only model. 'adaptive' has no equivalent.
      if (lv === 'adaptive') return {};
      return { reasoning_effort: on ? lv : 'minimal' };

    default:
      return {};
  }
}

// ===== P131: model capability detection =====

/**
 * OpenAI's own reasoning models (o-series, GPT-5.x, GPT-6.x) reject `max_tokens`
 * (they need `max_completion_tokens`) and reject `temperature` / `top_p`. Only on
 * OpenAI's / Azure's own hosts — every other OpenAI-compatible gateway still expects
 * `max_tokens`, and strict gateways reject unknown fields.
 */
export function isOpenAIReasoningModel(baseURL?: string, model?: string): boolean {
  const host = (baseURL ?? '').toLowerCase();
  if (!host.includes('openai.com') && !host.includes('azure.com')) return false;
  return /^(o\d|gpt-([5-9]|\d{2,}))/i.test(model ?? '');
}

/**
 * P131: GPT-6 (Astra and later) on /chat/completions rejects `reasoning_effort` whenever
 * `tools` are present ("Function tools with reasoning_effort are not supported …
 * use /v1/responses"), and rejects the 'none' / 'minimal' efforts outright.
 */
export function isGpt6Family(model?: string): boolean {
  return /^gpt-([6-9]|\d{2,})/i.test(model ?? '');
}

/** What a Claude model's request surface accepts. */
export interface ClaudeCaps {
  /** temperature / top_p / top_k are rejected with a 400 — never send them. */
  noSampling: boolean;
  /** Reasoning depth is `thinking: {type:'adaptive'}` + `output_config.effort`;
   *  `{type:'enabled', budget_tokens}` is removed or deprecated. */
  adaptive: boolean;
  /** Thinking runs even when `thinking` is omitted. */
  thinksByDefault: boolean;
  /** Thinking cannot be switched off — `{type:'disabled'}` is a 400. */
  alwaysThinks: boolean;
}

/**
 * P131: request-surface capabilities by Claude model id. Matches first-party ids
 * (`claude-opus-5-5`), dotted proxy ids (`claude-opus-4.8`) and prefixed ids
 * (`anthropic.claude-fable-5-1`). Unrecognised ids — old dated models, OSS models
 * behind Anthropic-compatible proxies — get the legacy surface.
 *
 *   Fable 5 / 5.1, Mythos   always thinks; sampling + budget_tokens → 400
 *   Opus 5.5                always thinks; sampling + budget_tokens → 400
 *   Sonnet 5.5              disabled → 400; non-default sampling → 400
 *   Opus 5, Sonnet 5        thinks by default; sampling + budget_tokens → 400
 *   Opus 4.7 / 4.8          adaptive only on-mode (off by default); sampling → 400
 *   Opus 4.6 / Sonnet 4.6   adaptive recommended; sampling allowed
 *   older (Haiku 4.5, …)    budget_tokens thinking; sampling allowed
 */
export function claudeCaps(model?: string): ClaudeCaps {
  const legacy: ClaudeCaps = { noSampling: false, adaptive: false, thinksByDefault: false, alwaysThinks: false };
  const id = (model ?? '').toLowerCase();
  if (/fable|mythos/.test(id)) {
    return { noSampling: true, adaptive: true, thinksByDefault: true, alwaysThinks: true };
  }
  const m = /(opus|sonnet|haiku)[-_ ]?(\d{1,2})(?!\d)(?:[-.](\d)(?!\d))?/.exec(id);
  if (!m) return legacy;
  const family = m[1];
  const v = Number(m[2]) + Number(m[3] ?? 0) / 10;
  if (family === 'opus') {
    if (v >= 5.5) return { noSampling: true, adaptive: true, thinksByDefault: true, alwaysThinks: true };
    if (v >= 5) return { noSampling: true, adaptive: true, thinksByDefault: true, alwaysThinks: false };
    if (v >= 4.7) return { noSampling: true, adaptive: true, thinksByDefault: false, alwaysThinks: false };
    if (v >= 4.6) return { noSampling: false, adaptive: true, thinksByDefault: false, alwaysThinks: false };
    return legacy;
  }
  if (family === 'sonnet') {
    if (v >= 5.5) return { noSampling: true, adaptive: true, thinksByDefault: true, alwaysThinks: true };
    if (v >= 5) return { noSampling: true, adaptive: true, thinksByDefault: true, alwaysThinks: false };
    if (v >= 4.6) return { noSampling: false, adaptive: true, thinksByDefault: false, alwaysThinks: false };
    return legacy;
  }
  return legacy;
}

/**
 * P131: Anthropic request fields for reasoning depth + sampling, by model.
 *
 * Before P131 every request carried `temperature: 0.3` — a hard 400 on Fable 5 / 5.1,
 * Opus 4.7+ and Sonnet 5+ (every Claude preset except Sonnet 4.6) — and reasoning
 * levels were sent as `budget_tokens`, which those models also reject.
 *
 * Adaptive-surface models: level → `output_config.effort`; thinking summaries are
 * requested (`display: 'summarized'`) whenever thinking runs, because the default
 * ('omitted') streams empty thinking blocks and the UI would show nothing while the
 * model works. 'off' on a model that cannot stop thinking becomes the lowest effort.
 */
export function anthropicReasoningParams(
  level: ReasoningLevel | undefined,
  model: string | undefined,
  maxTokens: number,
  temperature: number | undefined,
): Record<string, any> {
  const lv = level ?? 'auto';
  const caps = claudeCaps(model);
  const adaptiveOn = { thinking: { type: 'adaptive', display: 'summarized' } };

  if (caps.adaptive) {
    let out: Record<string, any>;
    if (lv === 'off') {
      out = caps.alwaysThinks ? { ...adaptiveOn, output_config: { effort: 'low' } } : { thinking: { type: 'disabled' } };
    } else if (lv === 'low' || lv === 'medium' || lv === 'high') {
      out = { ...adaptiveOn, output_config: { effort: lv } };
    } else if (lv === 'adaptive' || caps.thinksByDefault) {
      // 'auto' on a model that thinks anyway: same behaviour, readable summaries.
      out = { ...adaptiveOn };
    } else {
      out = {};  // 'auto' on Opus 4.6–4.8 / Sonnet 4.6: provider default (no thinking)
    }
    // Sampling is rejected outright on noSampling models, and incompatible with thinking on.
    if (!caps.noSampling && (!out.thinking || out.thinking.type === 'disabled')) {
      out.temperature = temperature ?? 0.3;
    }
    return out;
  }

  // Legacy surface: budget_tokens thinking; temperature only while thinking is off.
  // P55: an unrecognised Mythos-class id is handled above (always thinks).
  if (lv === 'auto' || lv === 'adaptive') return { temperature: temperature ?? 0.3 };
  if (lv === 'off') return { temperature: temperature ?? 0.3, thinking: { type: 'disabled' } };
  const budgets: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
  const budget = Math.min(budgets[lv] ?? 4096, Math.max(1024, maxTokens - 1024));
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/** P54: providers that ignore sampling params while thinking — we drop them to avoid noise. */
export function dropsTemperature(
  level: ReasoningLevel | undefined,
  dialect: ReasoningDialect | undefined,
  baseURL?: string,
): boolean {
  const lv = level ?? 'auto';
  if (lv === 'auto' || lv === 'off') return false;
  const d = !dialect || dialect === 'auto' ? detectDialect(baseURL) : dialect;
  return d === 'deepseek';
}

/** Field names we may have added — used to detect "unknown parameter" 400s. */
export const REASONING_FIELDS = [
  'reasoning_effort', 'enable_thinking', 'thinking_budget', 'thinking', 'reasoning',
  'chat_template_kwargs',
];

/** True when this error text looks like the server rejecting our reasoning fields. */
export function isReasoningParamError(body: string): boolean {
  const b = (body || '').toLowerCase();
  if (!b) return false;
  // P131: 'not supported' — GPT-6 Astra phrases its tools+reasoning_effort 400 as
  // "Function tools with reasoning_effort are not supported …", which fell through.
  const complains = b.includes('unknown') || b.includes('unsupported') || b.includes('invalid')
    || b.includes('not allowed') || b.includes('unrecognized') || b.includes('extra')
    || b.includes('not supported');
  return complains && REASONING_FIELDS.some((f) => b.includes(f));
}
