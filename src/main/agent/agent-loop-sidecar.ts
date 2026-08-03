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
import { stripThinking } from '../llm/thinking';
import type { LLMResponse } from '../../shared/types';
import { lintMacro, formatLintIssues } from '../scripts/macro-lint';
import { validateScript } from '../scripts/sanitizer';

export interface AgentEvent {
  type: 'start' | 'text' | 'text_delta' | 'reasoning_delta' | 'tool_pending' | 'tool_start'
    | 'tool_result' | 'confirm_request' | 'image' | 'backup' | 'thinking' | 'done' | 'error';
  /** P51: streamed fragment (text_delta / reasoning_delta) or pending tool name */
  chunk?: string;
  name?: string;
  /** P44: 1-based round index, sent with 'thinking' so the UI can show live progress */
  round?: number;
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
  /** P43: approval strictness — 'strict' asks for every tool · 'normal' destructive only
   *  (previous behaviour) · 'permissive' irreversible only · 'auto' never asks. */
  approvalMode?: 'strict' | 'normal' | 'permissive' | 'auto';
  /** P5: lazy session backup — called once, right before the first destructive tool runs */
  backup?: () => Promise<string | null>;
  /** P18: main model can read images directly (preferred, lossless). */
  mainModelVision?: boolean;
  /** Fallback vision model (image-to-text) for when the main model is not multimodal. */
  visionConfig?: VisionConfig;
  /** Convert a local image path returned by the sidecar into a data URL (handlers implement this via Electron's nativeImage) */
  imageToDataUrl: (imagePath: string, format: string) => string;
  /** P54: explicit user-configured context-window override (in tokens) */
  contextWindow?: number;
  /** P70: tool names the user switched off in the Tools tab — filtered out before the
   *  request is built, so the model never sees them and cannot ask for them. */
  disabledTools?: string[];
  /** P58: VBA/VBScript runner for the run_macro escape hatch. Omit to withhold the tool. */
  runMacro?: (code: string) => Promise<{ success: boolean; output?: string; error?: string }>;
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
  {
    type: 'function',
    function: {
      name: 'run_macro',
      description:
        'ESCAPE HATCH — run a raw SolidWorks VBScript macro. Use ONLY for what the dedicated '
        + 'tools do not cover (drawings and detailing, complex swept/lofted surfaces, '
        + 'equation-driven curves, bulk edits across many features). For ordinary modelling the '
        + 'tools are strictly better: they convert mm for you, search the API arity this machine '
        + 'accepts, pick faces and edges by meaning, and report the REAL error instead of '
        + 'silently doing nothing. A static check runs first and REFUSES code that passes '
        + 'millimetres to metre-based APIs or opens with On Error Resume Next. '
        + 'Write the body only — swApp and Part are already bound, no Sub main() wrapper.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'VBScript macro body. Lengths in METRES (40mm = 0.04). No On Error Resume Next.' },
          purpose: { type: 'string', description: 'One line on what this macro does — shown on the approval card' },
        },
        required: ['code'],
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
  let nudged = false;
  let lastHadReasoning = false;
  let finalText = '';
  let backupDone = false;

  // P19: cache the most recent screenshot so a (pure-text or multimodal) model can
  // ask several follow-up questions about the SAME snapshot without re-capturing.
  let lastCapture: string | null = null;

  // P47: the user can attach screenshots ("this fillet is on the wrong edge"). A
  // multimodal main model reads them as-is; for a text-only main model we run each
  // image through the configured vision model and fold its description into the text,
  // so pointing at a picture works on every provider.
  if (!opts.mainModelVision) {
    for (const msg of history) {
      if (msg.role !== 'user' || !msg.images?.length) continue;
      const shots = msg.images;
      delete msg.images;
      if (!opts.visionConfig) {
        msg.content = `${msg.content}\n\n（用户附了 ${shots.length} 张图，但当前主模型不支持读图、也未配置备用视觉模型 —— 请让用户在「设置 → 视觉理解」里配置，或用文字描述问题。）`;
        continue;
      }
      for (let i = 0; i < shots.length; i++) {
        try {
          const desc = await analyzeImage({
            question: msg.content || '请详细描述这张图里的内容与可见问题。',
            imageDataUrl: shots[i],
            config: opts.visionConfig,
            signal: opts.signal,
          });
          msg.content = `${msg.content}\n\n【用户附图 ${i + 1} 的视觉分析】${clip(stripThinking(desc) || desc)}`;
        } catch (e) {
          msg.content = `${msg.content}\n\n（附图 ${i + 1} 分析失败：${errText(e)}）`;
        }
      }
    }
  }

  await sidecar.start();
  const sidecarTools = await sidecar.listTools(false);
  // P70: withhold what the user switched off. Filtering here rather than in the UI means
  // a disabled tool is genuinely unavailable — the model is never told it exists, which
  // enforces the risk decision AND shortens the list it has to choose from (a shorter
  // list measurably improves tool choice).
  const off = new Set(opts.disabledTools ?? []);
  const tools = [
    // P58: only advertise run_macro when a runner exists — a tool the model can call but
    // that cannot execute is worse than no tool at all.
    ...VIRTUAL_TOOLS.filter((t) => t.function.name !== 'run_macro' || !!opts.runMacro),
    ...sidecarTools,
  ].filter((t: any) => !off.has(t?.function?.name));
  const destructive = new Set(
    sidecarTools.filter((t) => t.x_meta?.destructive).map((t) => t.function.name),
  );

  // P43: which calls stop for approval. 'auto' runs unattended — the lazy session backup
  // below is what makes that safe (the whole run stays rollback-able). 'permissive' still
  // gates operations a feature-tree rollback cannot undo (file writes, deletions).
  const mode = opts.approvalMode ?? 'normal';
  const IRREVERSIBLE = new Set([
    'delete_feature', 'save_as', 'save_document', 'export_file', 'export_stl',
  ]);
  const wantsConfirm = (name: string): boolean => {
    if (!opts.confirmTool) return false;
    if (mode === 'auto') return false;
    if (mode === 'strict') return true;
    // P58: a raw macro bypasses every runtime guard the tools provide, so it asks for
    // approval in every mode except AUTO — regardless of strictness.
    if (name === 'run_macro') return true;
    if (mode === 'permissive') return IRREVERSIBLE.has(name);
    return destructive.has(name) || IRREVERSIBLE.has(name);
  };

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
    history = truncateMessages(history, '', opts.requestId ? String(opts.requestId) : '', opts.contextWindow);
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

    // P44: this call blocks for tens of seconds; tell the UI so it can show a live

    // "thinking · round N" indicator instead of freezing after the last tool card.

    opts.onEvent?.({ type: 'thinking', round: round + 1 });

    // P51: stream when the adapter supports it — the model can think for a minute, and a

    // frozen window with no output is indistinguishable from a hang. Reasoning goes to its

    // own channel so it can be collapsed and kept out of the history.

    const resp = await runTurn(adapter, history, tools, opts);

    lastHadReasoning = !!(resp.reasoning ?? '').trim();

    if (resp.content) resp.content = stripThinking(resp.content);
    if (resp.content && !resp.streamed) {
      finalText = resp.content;
      opts.onEvent?.({ type: 'text', text: resp.content });
    }
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      // P80: a reasoning model can spend an entire round thinking and return NO content
      // and NO tool calls. That is a real API outcome, not an error — but the loop had no
      // branch for it, so the turn fell through to "done" with nothing to show, or threw.
      // Nudge once with the reasoning acknowledged, so the model converts its thinking
      // into an action instead of restarting it.
      if (!nudged && !(resp.content ?? '').trim() && (resp.reasoning ?? '').length > 200) {
        nudged = true;
        history.push({
          role: 'user',
          content: '你已经想清楚了方案，现在直接调用工具执行。不要重新分析，也不需要我批准；'
                 + '如果某个工具不可用，就先执行其余步骤，最后如实告诉我哪一步没做成。',
        });
        continue;
      }
      // P46: models habitually write the plan and STOP, waiting for approval that was
      // never asked for — the user then has to type "continue". Nudge once: push the
      // plan into history and tell it to proceed. Only on the first round, and only
      // once, so a genuine "I have a question for you" answer still ends the turn.
      if (round === 0 && !nudged && (resp.content ?? '').length > 80) {
        nudged = true;
        history.push({
          role: 'assistant',
          content: resp.content ?? '',
          reasoning: resp.reasoning,  // P101: keep continuity for DeepSeek/MiniMax
        });
        history.push({
          role: 'user',
          content: '按上述方案继续执行，现在开始调用工具。不需要我批准，遇到需要确认的破坏性操作时系统会自动询问我。',
        });
        continue;
      }
      opts.onEvent?.({ type: 'done', text: finalText });
      return finalText;
    }

    // P33: guarantee a unique id per tool call. Without it, two same-named calls
    // (e.g. the model retrying cut_extrude) both collapse to callId=name, so the
    // confirm cards collide and clicking one resolves the other.
    resp.toolCalls.forEach((c, i) => {
      if (!c.id) c.id = `${c.name}-r${round}-${i}-${Date.now().toString(36)}`;
    });

    // P101: retain the reasoning on the assistant message — DeepSeek (tool-call turns)
    // and MiniMax M3 (interleaved thinking) require it back in history for continuity.
    // content is already stripped of <think>; reasoning rides along separately and the
    // request builder re-attaches it in the provider's dialect.
    history.push({
      role: 'assistant',
      content: resp.content ?? '',
      reasoning: resp.reasoning,
      toolCalls: resp.toolCalls,
    });

    for (const call of resp.toolCalls) {
      if (opts.signal?.aborted) throw new Error('已取消');

      if (off.has(call.name)) {
        // Not advertised, so this is the model recalling a name from elsewhere. Say so
        // plainly instead of executing it.
        const resultText = `⛔ ${call.name} 已被用户在「工具」页关闭，本次会话不可用。请改用其他工具完成，或告知用户需要开启它。`;
        call.result = resultText;
        opts.onEvent?.({ type: 'tool_result', toolCall: call });
        history.push(toolMsg(call, resultText));
        continue;
      }

      // P58: macro escape hatch — lint, confirm, back up, then run through the VBS engine

      if (call.name === 'run_macro') {

        const resultText = await handleRunMacro(call, opts, ensureBackup);

        call.result = resultText;

        opts.onEvent?.({ type: 'tool_result', toolCall: call });

        history.push(toolMsg(call, resultText));

        continue;

      }


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

      // Confirmation gate (P43: scope depends on the configured approval mode).
      // P44: the ONLY place confirm_request is emitted — handlers.ts emitted it a SECOND
      // time inside requestUserConfirm, which is why one call produced two identical cards.
      if (wantsConfirm(call.name)) {
        opts.onEvent?.({ type: 'confirm_request', toolCall: call });
        // wantsConfirm() guarantees opts.confirmTool is defined when it returns true
        const ok = await opts.confirmTool!(call);
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
    history = truncateMessages(history, '', '', opts.contextWindow);
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
  // P80: distinguish "ran out of rounds while working" from "produced nothing at all" —
  // they need different responses from the user, and lumping them together as one message
  // hid the second case entirely.
  if (!finalText.trim()) {
    const msg = `模型连续 ${maxRounds} 轮没有产出可执行的动作`
      + `（最后一轮${lastHadReasoning ? '只有思考、没有工具调用' : '返回为空'}）。`
      + '可能是任务描述太宽泛，或推理深度设得过高——试着把任务拆小，或在设置里把推理深度调低。';
    opts.onEvent?.({ type: 'error', error: msg });
    return msg;
  }
  return finalText;
}

interface AnalyzeViewResult {
  resultText: string;
  /** Path A: image as a standalone user message; the caller pushes it after the tool result */
  imageMessage?: ChatMessage;
  /** P19: the data URL just captured, so the loop can cache it for follow-up questions */
  capture?: string;
}

/** P58: run_macro — the guarded path for raw VBScript.
 *
 *  Order matters: lint BEFORE the confirmation card, so the user is never asked to
 *  approve a macro that would have silently done nothing (mm-for-metres, or
 *  On Error Resume Next). Then back up, then run, then report the real error. */
async function handleRunMacro(
  call: ToolCall,
  opts: SidecarAgentOptions,
  ensureBackup: () => Promise<void>,
): Promise<string> {
  const code = String(call.parameters?.code ?? '').trim();
  if (!code) return '❌ run_macro failed: no code given.';
  if (!opts.runMacro) return '❌ run_macro failed: the macro engine is unavailable in this build.';

  const lint = lintMacro(code);
  const notes = formatLintIssues(lint.issues);
  if (!lint.ok) {
    return '⛔ 宏未通过静态检查，没有执行（这些问题在 VBA 里不会报错，只会静默产生错误几何）：\n'
      + notes
      + '\n\n修好后重试，或者改用现成工具 —— 它们会替你换算单位、搜索本机可用的 API 参数个数、按语义选面选边。';
  }

  const check = validateScript(code, 'vba');
  if (!check.safe) {
    return `⛔ run_macro blocked by the safety check: ${check.issues.join('; ')}`;
  }

  await ensureBackup();
  try {
    const r = await opts.runMacro(code);
    const tail = notes ? `\n\n静态检查提醒：\n${notes}` : '';
    if (!r.success) {
      return `❌ run_macro failed: ${clip(r.error ?? 'unknown error')}${tail}`;
    }
    return `✅ run_macro: ${clip(r.output || 'macro ran with no output')}${tail}`;
  } catch (e) {
    return `❌ run_macro failed: ${errText(e)}`;
  }
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
      const raw = await analyzeImage({ question, imageDataUrl: dataUrl, config: opts.visionConfig, signal: opts.signal });
      const desc = stripThinking(raw) || raw;  // P50: vision models emit <think> too
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

/**
 * P51: one model turn. Uses `chatWithToolsStream` when the adapter has it, forwarding
 * text and reasoning fragments as they arrive; otherwise falls back to the one-shot
 * call so protocols can adopt streaming independently.
 */
async function runTurn(
  adapter: any,
  history: ChatMessage[],
  tools: any[],
  opts: SidecarAgentOptions,
): Promise<LLMResponse & { streamed?: boolean }> {
  if (typeof adapter.chatWithToolsStream !== 'function') {
    return adapter.chatWithTools(history, opts.signal, tools);
  }
  let final: LLMResponse | undefined;
  for await (const ev of adapter.chatWithToolsStream(history, opts.signal, tools)) {
    switch (ev.kind) {
      case 'text':
        opts.onEvent?.({ type: 'text_delta', chunk: ev.chunk });
        break;
      case 'reasoning':
        opts.onEvent?.({ type: 'reasoning_delta', chunk: ev.chunk });
        break;
      case 'tool':
        opts.onEvent?.({ type: 'tool_pending', name: ev.name });
        break;
      case 'done':
        final = ev.response;
        break;
    }
  }
  if (!final) throw new Error('流式响应未返回结果');
  return { ...final, streamed: true };
}
