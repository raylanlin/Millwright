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

export type ReasoningLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';
export type ReasoningDialect = 'auto' | 'none' | 'effort' | 'qwen' | 'zhipu' | 'deepseek';

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
  if (u.includes('minimax') || u.includes('openai.com') || u.includes('moonshot')) return 'effort';
  return 'none';                                          // unknown gateway: send nothing
}

const BUDGET: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };

/**
 * Build the extra body fields for the requested reasoning level.
 * 'auto' sends nothing (provider default) — the safest choice for unknown gateways.
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
    case 'effort':
      // OpenAI-style: reasoning_effort. 'off' is expressed as minimal effort, since
      // there is no documented way to disable reasoning on a reasoning-only model.
      return { reasoning_effort: on ? lv : 'minimal' };
    case 'qwen':
      return on
        ? { enable_thinking: true, thinking_budget: BUDGET[lv] ?? 4096 }
        : { enable_thinking: false };
    case 'zhipu':
    case 'deepseek':
      return { thinking: { type: on ? 'enabled' : 'disabled' } };
    default:
      return {};
  }
}

/** Field names we may have added — used to detect "unknown parameter" 400s. */
export const REASONING_FIELDS = [
  'reasoning_effort', 'enable_thinking', 'thinking_budget', 'thinking', 'reasoning',
];

/** True when this error text looks like the server rejecting our reasoning fields. */
export function isReasoningParamError(body: string): boolean {
  const b = (body || '').toLowerCase();
  if (!b) return false;
  const complains = b.includes('unknown') || b.includes('unsupported') || b.includes('invalid')
    || b.includes('not allowed') || b.includes('unrecognized') || b.includes('extra');
  return complains && REASONING_FIELDS.some((f) => b.includes(f));
}
