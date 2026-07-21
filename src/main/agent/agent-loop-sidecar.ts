// src/main/agent/agent-loop-sidecar.ts
//
// 成熟版 agent 循环：工具单一真源 = 边车 list_tools()，执行 = 边车 call()。
// 相比旧 agent-loop（调 generators 生成 VBS）：
//   - 工具 schema 自描述、原生注入主模型（tools 参数）
//   - 每步返回结构化 JSON，模型可观测/自纠
//   - 内置视觉双路径：analyze_view（图生文 / 直喂多模态主模型）
//
// 依赖注入（handlers 提供），便于测试与解耦。

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
  /** 破坏性工具确认 */
  confirmTool?: (call: ToolCall) => Promise<boolean>;
  /** 视觉：独立视觉模型（图生文）。为空则尝试主模型多模态 */
  visionConfig?: VisionConfig;
  mainModelVision?: boolean;
  /** 把边车返回的本地图片路径转 data URL（handlers 用 electron nativeImage 实现） */
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
  // 工具清单：边车工具（过滤 internal）+ 虚拟视觉工具，原生注入主模型
  const sidecarTools = await sidecar.listTools(false);
  const tools = [...VIRTUAL_TOOLS, ...sidecarTools];
  const destructive = new Set(
    sidecarTools.filter((t) => t.x_meta?.destructive).map((t) => t.function.name),
  );

  opts.onEvent?.({ type: 'start', requestId: opts.requestId });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    history = truncateMessages(history);

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

      // 视觉工具单独处理
      if (call.name === 'analyze_view') {
        const resultText = await handleAnalyzeView(call, history, sidecar, opts);
        call.result = resultText;
        opts.onEvent?.({ type: 'tool_result', toolCall: call });
        history.push({ role: 'system', content: resultText, toolCalls: [{ ...call, result: resultText }] });
        continue;
      }

      // 破坏性确认门
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

/** analyze_view：截屏 → 图生文(独立视觉模型) 或 直喂多模态主模型。 */
async function handleAnalyzeView(
  call: ToolCall,
  history: ChatMessage[],
  sidecar: SWSidecar,
  opts: SidecarAgentOptions,
): Promise<string> {
  const question = String(call.parameters?.question ?? '请描述当前零件状态');
  const cap = await sidecar.call('capture_view', {});
  if (!cap.ok) return `截屏失败：${cap.error}`;
  let dataUrl: string;
  try {
    dataUrl = opts.imageToDataUrl(cap.data.image_path, cap.data.format);
  } catch (e) {
    return `图像读取失败：${e instanceof Error ? e.message : String(e)}`;
  }

  // 路径 A：独立视觉模型（图生文，prompt = 主模型自拟的 question）
  if (opts.visionConfig) {
    try {
      const desc = await analyzeImage({ question, imageDataUrl: dataUrl, config: opts.visionConfig, signal: opts.signal });
      opts.onEvent?.({ type: 'image' });
      return `【视觉分析】${clip(desc)}`;
    } catch (e) {
      return `视觉模型分析失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 路径 B：主模型本身多模态 → 把图注入历史，下一轮它直接看图
  if (opts.mainModelVision) {
    history.push({ role: 'user', content: `（视图截图，请据此回答：${question}）`, images: [dataUrl] });
    opts.onEvent?.({ type: 'image' });
    return '已将当前视图图像提供给你，请直接观察后继续。';
  }

  return '未配置视觉模型，且主模型未开启视觉输入。请在「设置 → 视觉模型」中指定一个视觉模型，或勾选“主模型支持视觉”。';
}
