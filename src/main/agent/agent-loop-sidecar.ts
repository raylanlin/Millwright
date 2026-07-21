// src/main/agent/agent-loop-sidecar.ts
//
// Mature agent loop: the single source of truth for tools is `sidecar.list_tools()`,
// and execution happens via `sidecar.call()`.
// Compared with the legacy agent-loop (which calls generators to produce VBS):
//   - Tool schema is self-describing and natively injected into the main model (via the `tools` parameter)
//   - Every step returns structured JSON that the model can observe and self-correct from
//   - Built-in dual-path vision: `analyze_view` (image-to-text via a dedicated vision model /
//     direct multimodal input to the main model)
//
// Dependency injection (provided by handlers) keeps it testable and decoupled.

import type { OpenAIAdapter } from '../llm/openai';
import type { ChatMessage, ToolCall, VisionConfig } from '../../shared/types';
import type { SWSidecar } from '../com/sw-sidecar';
import { truncateMessages } from '../llm/context-window';
import { analyzeImage } from '../llm/vision';

export interface AgentEvent {
  type: 'start' | 'text' | 'tool_start' | 'tool_result' | 'confirm_request' | 'image' | 'done' | 'error';
  requestId?: string;
  text?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface SidecarAgentOptions {
  requestId?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  /** Confirmation gate for destructive tools */
  confirmTool?: (call: ToolCall) => Promise<boolean>;
  /** Vision: dedicated vision model (image-to-text). When unset, fall back to main-model multimodal input */
  visionConfig?: VisionConfig;
  mainModelVision?: boolean;
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
        '截取当前 SolidWorks 视图并做视觉分析。带上你想弄清的具体问题；'
        + '需要换角度先调用 set_view_orientation / rotate_view。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '你想通过看图弄清的具体问题' } },
        required: ['question'],
      },
    },
  },
];

function clip(s: string): string {
  return s && s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + '…(截断)' : s;
}

function fmtResult(name: string, r: { ok: boolean; data?: any; error?: string }): string {
  if (r.ok) return `✅ ${name}: ${clip(JSON.stringify(r.data ?? {}, null, 0))}`;
  return `❌ ${name} 失败: ${clip(r.error ?? '未知错误')}`;
}

export async function runSidecarAgent(
  adapter: OpenAIAdapter,
  messages: ChatMessage[],
  sidecar: SWSidecar,
  opts: SidecarAgentOptions,
): Promise<string> {
  const maxRounds = opts.maxRounds ?? 12;
  let history: ChatMessage[] = [...messages];
  let finalText = '';

  await sidecar.start();
  // Tool list: sidecar tools (filtered to exclude `internal`) + virtual vision tool, natively injected into the main model
  const sidecarTools = await sidecar.listTools(false);
  const tools = [...VIRTUAL_TOOLS, ...sidecarTools];
  const destructive = new Set(
    sidecarTools.filter((t) => t.x_meta?.destructive).map((t) => t.function.name),
  );

  opts.onEvent?.({ type: 'start', requestId: opts.requestId });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    history = truncateMessages(history);
    // BUGFIX: `truncateMessages` keeps the latest suffix, which can drop an assistant(tool_calls)
    // turn while leaving its tool results behind → OpenAI/DeepSeek then return 400 because
    // a "role:tool/tool-result" message has no preceding tool_calls.
    // Strip orphaned tool results from the head so the first message is never a dangling tool result.
    while (
      history.length > 0 &&
      history[0].role === 'system' &&
      history[0].toolCalls &&
      history[0].toolCalls.length > 0
    ) {
      history.shift();
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

      // Handle the vision tool on its own path
      if (call.name === 'analyze_view') {
        const { resultText, imageMessage } = await handleAnalyzeView(call, sidecar, opts);
        call.result = resultText;
        opts.onEvent?.({ type: 'tool_result', toolCall: call });
        // Push the tool result first (must immediately follow assistant.tool_calls to satisfy OpenAI pairing),
        // then push the image as a standalone user message — never between tool_calls and its result (would 400).
        history.push({ role: 'system', content: resultText, toolCalls: [{ ...call, result: resultText }] });
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
          history.push({ role: 'system', content: r, toolCalls: [{ ...call, result: r }] });
          opts.onEvent?.({ type: 'tool_result', toolCall: call });
          continue;
        }
      }

      opts.onEvent?.({ type: 'tool_start', toolCall: call });
      const r = await sidecar.call(call.name, call.parameters);
      const resultText = fmtResult(call.name, r);
      call.result = resultText;
      opts.onEvent?.({ type: 'tool_result', toolCall: call });
      history.push({ role: 'system', content: resultText, toolCalls: [{ ...call, result: resultText }] });
    }
  }

  opts.onEvent?.({ type: 'error', error: `达到最大轮数(${maxRounds})，已停止。` });
  return finalText || `已多步执行但未收敛（${maxRounds} 轮上限）。`;
}

interface AnalyzeViewResult {
  resultText: string;
  /** Path B: image as a standalone user message; the caller pushes it after the tool result */
  imageMessage?: ChatMessage;
}

/** analyze_view: capture the screen → image-to-text (dedicated vision model) or direct multimodal main model. */
async function handleAnalyzeView(
  call: ToolCall,
  sidecar: SWSidecar,
  opts: SidecarAgentOptions,
): Promise<AnalyzeViewResult> {
  const question = String(call.parameters?.question ?? '请描述当前零件状态');
  const cap = await sidecar.call('capture_view', {});
  if (!cap.ok) return { resultText: `截屏失败：${cap.error}` };
  let dataUrl: string;
  try {
    dataUrl = opts.imageToDataUrl(cap.data.image_path, cap.data.format);
  } catch (e) {
    return { resultText: `图像读取失败：${e instanceof Error ? e.message : String(e)}` };
  }

  // Path A: dedicated vision model (image-to-text, prompt = the main model's `question`)
  if (opts.visionConfig) {
    try {
      const desc = await analyzeImage({ question, imageDataUrl: dataUrl, config: opts.visionConfig, signal: opts.signal });
      opts.onEvent?.({ type: 'image' });
      return { resultText: `【视觉分析】${clip(desc)}` };
    } catch (e) {
      return { resultText: `视觉模型分析失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Path B: main model is itself multimodal → return image as a standalone user message (caller pushes it after the tool result)
  if (opts.mainModelVision) {
    opts.onEvent?.({ type: 'image' });
    return {
      resultText: '已截取当前视图，图像见下一条消息，请据此继续。',
      imageMessage: { role: 'user', content: `（视图截图，请据此回答：${question}）`, images: [dataUrl] },
    };
  }

  return {
    resultText: '未配置视觉模型，且主模型未开启视觉输入。请在「设置 → 视觉模型」中指定一个视觉模型，或勾选“主模型支持视觉”。',
  };
}
