// src/main/agent/agent-loop-sidecar.ts
//
// Mature agent loop: the single source of truth for tools is `sidecar.list_tools()`,
// and execution happens via `sidecar.call()`.
//
// P5 changes:
//   - Tool results are pushed as first-class `role:'tool'` messages (toolCallId +
//     content) instead of the role:'system'+toolCalls hack. Adapters map them 1:1
//     to the OpenAI `role:'tool'` / Anthropic `tool_result` wire formats.
//   - Truncation safety moved into truncateMessages (block-aware); the loop only
//     keeps a thin guard against a tool-result-first history.
//   - Adapter-agnostic: accepts any LLMAdapter with chatWithTools (OpenAI AND
//     Anthropic protocols both drive the loop now).
//   - Session backup: `opts.backup` is invoked lazily before the FIRST destructive
//     tool executes, giving the whole session a rollback point (parity with the
//     legacy VBS loop). Surfaced to the UI via a `backup` event.
//   - Convergence nudge: when 3 rounds remain, a system note asks the model to
//     wrap up; on hitting maxRounds a final no-tools turn produces a summary of
//     what was changed instead of a bare "did not converge".
//
// P18 (vision priority reversed): a multimodal MAIN model reads the screenshot
//   DIRECTLY (lossless) — the dedicated vision model is now only the FALLBACK for
//   when the main model can't see images. Old order preferred the vision model even
//   when the main model was multimodal, which threw away detail via image→text.

import type { LLMAdapter } from '../llm/adapter';
import type { ChatMessage, ToolCall, VisionConfig } from '../../shared/types';
import type { SWSidecar } from '../com/sw-sidecar';
import { truncateMessages } from '../llm/context-window';
import { analyzeImage } from '../llm/vision';

export interface AgentEvent {
  type: 'start' | 'text' | 'tool_start' | 'tool_result' | 'confirm_request' | 'image' | 'backup' | 'done' | 'error';
  requestId?: string;
  text?: string;
  toolCall?: ToolCall;
  backupPath?: string | null;
  error?: string;
}

export interface SidecarAgentOptions {
  requestId?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  /** Confirmation gate for destructive tools */
  confirmTool?: (call: ToolCall) => Promise<boolean>;
  /** P5: lazy session backup — called once, right before the first destructive tool runs */
  backup?: () => Promise<string | null>;
  /** P18: main model can read images directly (preferred, lossless). */
  mainModelVision?: boolean;
  /** Fallback vision model (image-to-text) for when the main model is not multimodal. */
  visionConfig?: VisionConfig;
  /** Convert a local image path returned by the sidecar into a data URL (handlers implement this via Electron's nativeImage) */
  imageToDataUrl: (imagePath: string, format: string) => string;
}

const TOOL_RESULT_MAX = 4000;
const VIRTUAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'analyze_view',
      description:
        'Ask a specific question about the current SolidWorks view. It captures a screenshot and '
        + 'answers your question about it — call it repeatedly to ask follow-up questions and drill in. '
        + 'To interrogate the SAME snapshot across several questions (so the view cannot drift between them), '
        + 'pass recapture:false to reuse the last screenshot; to look from a new angle first call '
        + 'set_view_orientation / rotate_view, then analyze_view (recapture defaults to true).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The specific question you want answered about the view' },
          recapture: {
            type: 'boolean',
            description: 'true (default) = screenshot the current view; false = reuse the previous screenshot to ask a follow-up about the same snapshot',
            default: true,
          },
        },
        required: ['question'],
      },
    },
  },
];

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as any;
    return o.message || o.error?.message || JSON.stringify(o);
  }
  return String(e);
}

function clip(s: string): string {
  return s && s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + '…(truncated)' : s;
}

function fmtResult(name: string, r: { ok: boolean; data?: any; error?: string }): string {
  if (r.ok) return `✅ ${name}: ${clip(JSON.stringify(r.data ?? {}, null, 0))}`;
  return `❌ ${name} failed: ${clip(r.error ?? 'unknown error')}`;
}

/** P5: canonical tool-result message */
function toolMsg(call: ToolCall, resultText: string): ChatMessage {
  return { role: 'tool', toolCallId: call.id ?? call.name, content: resultText };
}

export async function runSidecarAgent(
  adapter: LLMAdapter,
  messages: ChatMessage[],
  sidecar: SWSidecar,
  opts: SidecarAgentOptions,
): Promise<string> {
  const maxRounds = opts.maxRounds ?? 24; // P30: 12 was too tight for real modeling sessions
  let history: ChatMessage[] = [...messages];
  let finalText = '';
  let backupDone = false;

  // P19: cache the most recent screenshot so a (pure-text or multimodal) model can
  // ask several follow-up questions about the SAME snapshot without re-capturing.
  let lastCapture: string | null = null;

  await sidecar.start();
  const sidecarTools = await sidecar.listTools(false);
  const tools = [...VIRTUAL_TOOLS, ...sidecarTools];
  const destructive = new Set(
    sidecarTools.filter((t) => t.x_meta?.destructive).map((t) => t.function.name),
  );

  /** Lazy one-shot backup before anything destructive touches the document */
  const ensureBackup = async () => {
    if (backupDone || !opts.backup) return;
    backupDone = true;
    try {
      const p = await opts.backup();
      opts.onEvent?.({ type: 'backup', backupPath: p });
    } catch {
      opts.onEvent?.({ type: 'backup', backupPath: null });
    }
  };

  opts.onEvent?.({ type: 'start', requestId: opts.requestId });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    history = truncateMessages(history);
    // Thin guard (block-aware truncation should already prevent this)
    while (history.length > 0 && (history[0].role === 'tool' || (history[0].role === 'system' && history[0].toolCalls?.length))) {
      history.shift();
    }

    // Convergence nudge when the budget is nearly spent
    if (round === maxRounds - 3) {
      history.push({
        role: 'system',
        content: `(仅剩 ${maxRounds - round} 轮工具调用预算。请尽快收敛：完成剩余最关键的步骤，或停止调用工具并总结当前进展与模型状态。)`,
      });
    }

    const resp = await adapter.chatWithTools(history, opts.signal, tools);
    if (resp.content) {
      finalText = resp.content;
      opts.onEvent?.({ type: 'text', text: resp.content });
    }
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      opts.onEvent?.({ type: 'done', text: finalText });
      return finalText;
    }

    history.push({ role: 'assistant', content: resp.content ?? '', toolCalls: resp.toolCalls });

    for (const call of resp.toolCalls) {
      if (opts.signal?.aborted) throw new Error('已取消');

      // Vision tool on its own path
      if (call.name === 'analyze_view') {
        const { resultText, imageMessage, capture } = await handleAnalyzeView(call, sidecar, opts, lastCapture);
        if (capture) lastCapture = capture;
        call.result = resultText;
        opts.onEvent?.({ type: 'tool_result', toolCall: call });
        // Tool result must immediately follow assistant.tool_calls; the image goes after as its own user message
        history.push(toolMsg(call, resultText));
        if (imageMessage) history.push(imageMessage);
        continue;
      }

      // Destructive-tool confirmation gate
      if (destructive.has(call.name) && opts.confirmTool) {
        opts.onEvent?.({ type: 'confirm_request', toolCall: call });
        const ok = await opts.confirmTool(call);
        if (!ok) {
          const r = `⛔ 用户拒绝执行 ${call.name}`;
          call.result = r;
          history.push(toolMsg(call, r));
          opts.onEvent?.({ type: 'tool_result', toolCall: call });
          continue;
        }
      }

      // P5: rollback point before the first destructive execution
      if (destructive.has(call.name)) await ensureBackup();

      opts.onEvent?.({ type: 'tool_start', toolCall: call });
      const r = await sidecar.call(call.name, call.parameters);
      const resultText = fmtResult(call.name, r);
      call.result = resultText;
      opts.onEvent?.({ type: 'tool_result', toolCall: call });
      history.push(toolMsg(call, resultText));
    }
  }

  // Out of rounds — force a final no-tools summary turn so the user learns what actually changed
  try {
    history = truncateMessages(history);
    history.push({
      role: 'system',
      content: '(已达到最大工具调用轮数。请不要再调用工具：总结你已完成的操作、当前模型的状态、以及未完成的部分。)',
    });
    const summary = await adapter.chatWithTools(history, opts.signal, undefined);
    if (summary.content) {
      finalText = summary.content;
      opts.onEvent?.({ type: 'text', text: summary.content });
    }
  } catch { /* summary is best-effort */ }

  opts.onEvent?.({ type: 'error', error: `达到最大轮数(${maxRounds})，已停止。` });
  return finalText || `已多步执行但未收敛（${maxRounds} 轮上限）。`;
}

interface AnalyzeViewResult {
  resultText: string;
  /** Path A: image as a standalone user message; the caller pushes it after the tool result */
  imageMessage?: ChatMessage;
  /** P19: the data URL just captured, so the loop can cache it for follow-up questions */
  capture?: string;
}

/** analyze_view: answer a question about the SW view.
 *  P18 priority: multimodal main model reads the screenshot directly (lossless);
 *  otherwise fall back to a dedicated vision model (image→text).
 *  P19: recapture=false reuses `lastCapture` so the model can ask follow-up
 *  questions about the same snapshot (openclaw-style visual Q&A). */
async function handleAnalyzeView(
  call: ToolCall,
  sidecar: SWSidecar,
  opts: SidecarAgentOptions,
  lastCapture: string | null,
): Promise<AnalyzeViewResult> {
  const question = String(call.parameters?.question ?? '请描述当前零件状态');
  const recapture = call.parameters?.recapture !== false; // default true

  // P19: resolve the image — fresh capture, or reuse the cached snapshot for a follow-up question
  let dataUrl: string;
  let reused = false;
  if (!recapture && lastCapture) {
    dataUrl = lastCapture;
    reused = true;
  } else {
    const cap = await sidecar.call('capture_view', {});
    if (!cap.ok) return { resultText: `截屏失败：${cap.error}` };
    try {
      dataUrl = opts.imageToDataUrl(cap.data.image_path, cap.data.format);
    } catch (e) {
      return { resultText: `图像读取失败：${errText(e)}` };
    }
  }

  // Path A (preferred): main model is multimodal → feed the screenshot straight to it (no image→text loss)
  if (opts.mainModelVision) {
    opts.onEvent?.({ type: 'image' });
    if (reused) {
      // The image is already in history from the earlier call — just steer the model to it
      return { resultText: `请参考上一张视图截图回答：${question}`, capture: dataUrl };
    }
    return {
      resultText: '已截取当前视图，图像见下一条消息，请据此继续。',
      imageMessage: { role: 'user', content: `（视图截图，请据此回答：${question}）`, images: [dataUrl] },
      capture: dataUrl,
    };
  }

  // Path B (fallback): main model can't see images → a dedicated vision model answers the question.
  // Each call forwards the main model's specific question, so a pure-text model can interrogate the
  // image (and, with recapture:false, keep asking about the same snapshot).
  if (opts.visionConfig) {
    try {
      const desc = await analyzeImage({ question, imageDataUrl: dataUrl, config: opts.visionConfig, signal: opts.signal });
      opts.onEvent?.({ type: 'image' });
      const tag = reused ? '【视觉分析·同一截图】' : '【视觉分析】';
      return { resultText: `${tag}${clip(desc)}`, capture: dataUrl };
    } catch (e) {
      // P29: e may be an LLMErrorInfo object — String(e) printed "[object Object]" and hid the real cause
      return { resultText: `视觉模型分析失败：${errText(e)}` };
    }
  }

  return {
    resultText: '主模型未开启视觉输入，且未配置备用视觉模型。请在「设置」中勾选“主模型支持视觉理解”（推荐，主模型可直接读图），或配置一个备用视觉模型。',
  };
}
