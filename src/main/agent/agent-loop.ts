// src/main/agent/agent-loop.ts
// P1.1 优化版：修复审查报告中的 HIGH/MED 问题。
//   HIGH-1 备份：runAgentLoop 开始时对活动文档备份一次，路径经 onEvent 通知 UI
//   MED-2  截断：每轮 chatWithTools 前截断 history；单条工具结果限长
//   MED-3  确认门：工具带 requiresConfirmation 时经 onEvent 暂停等待批准
// 覆盖仓库同名文件。依赖：backupActiveDocument(bridge) 与 truncateMessages 已存在。

import type { OpenAIAdapter } from '../llm/openai';
import type { ChatMessage, ToolCall } from '../../shared/types';
import { generateScript } from '../scripts/generators';
import { validateScript } from '../scripts/sanitizer';
import { truncateMessages } from '../llm/context-window';
import type { ScriptEngine } from '../scripts/engine';

export interface AgentEvent {
  type: 'start' | 'text' | 'tool_start' | 'tool_result' | 'confirm_request' | 'done' | 'error';
  requestId?: string;
  backupPath?: string | null;
  text?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface AgentOptions {
  requestId?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  /** 执行前备份：传入现有 backup.ts 的封装，失败不阻塞但会告知 UI */
  backup?: () => Promise<string | null>;
  /** MED-3：需人工确认的工具，返回 Promise<boolean>（UI 批准/拒绝）。不传则直接执行 */
  confirmTool?: (call: ToolCall) => Promise<boolean>;
  /** 需要确认的工具名单（默认含破坏性操作） */
  confirmList?: Set<string>;
}

const DEFAULT_CONFIRM = new Set(['cut_extrude', 'create_fillet', 'modify_dimensions', 'delete_feature']);
const TOOL_RESULT_MAX_CHARS = 4000; // MED-2：单条工具结果限长，防上下文爆炸

function clip(s: string): string {
  return s.length > TOOL_RESULT_MAX_CHARS
    ? s.slice(0, TOOL_RESULT_MAX_CHARS) + `\n…(截断，共 ${s.length} 字符)`
    : s;
}

async function executeTool(engine: ScriptEngine, call: ToolCall): Promise<string> {
  let gen;
  try {
    gen = generateScript(call.name, call.parameters);
  } catch (err) {
    return `工具 ${call.name} 生成脚本失败：${err instanceof Error ? err.message : String(err)}`;
  }
  const check = validateScript(gen.code, gen.language);
  if (!check.safe) return `工具 ${call.name} 未通过安全校验：${check.issues.join('; ')}`;
  const result = await engine.run(gen.code, gen.language);
  return result.success
    ? `✅ ${call.name} 执行成功。${clip(result.output || '')}`.trim()
    : `❌ ${call.name} 执行失败：${clip(result.error || '未知错误')}`;
}

export async function runAgentLoop(
  adapter: OpenAIAdapter,
  messages: ChatMessage[],
  engine: ScriptEngine,
  opts: AgentOptions = {},
): Promise<string> {
  const maxRounds = opts.maxRounds ?? 8;
  const confirmList = opts.confirmList ?? DEFAULT_CONFIRM;
  let history: ChatMessage[] = [...messages];
  let finalText = '';

  // HIGH-1：会话级备份（整轮回滚点）。失败不阻塞，但明确告知 UI。
  let backupPath: string | null = null;
  if (opts.backup) {
    try { backupPath = await opts.backup(); } catch { backupPath = null; }
  }
  opts.onEvent?.({ type: 'start', requestId: opts.requestId, backupPath });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');

    // MED-2：每轮发送前截断（保 system + 最近往返）
    history = truncateMessages(history);

    const resp = await adapter.chatWithTools(history, opts.signal);

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

      // MED-3：破坏性工具确认门
      let resultText: string;
      if (confirmList.has(call.name) && opts.confirmTool) {
        opts.onEvent?.({ type: 'confirm_request', toolCall: call });
        const approved = await opts.confirmTool(call);
        if (!approved) {
          resultText = `⛔ 用户拒绝执行 ${call.name}。请调整方案或询问用户意图。`;
          call.result = resultText;
          opts.onEvent?.({ type: 'tool_result', toolCall: call });
          history.push({ role: 'system', content: resultText, toolCalls: [{ ...call, result: resultText }] });
          continue;
        }
      }

      opts.onEvent?.({ type: 'tool_start', toolCall: call });
      resultText = await executeTool(engine, call);
      call.result = resultText;
      opts.onEvent?.({ type: 'tool_result', toolCall: call });
      history.push({ role: 'system', content: resultText, toolCalls: [{ ...call, result: resultText }] });
    }
  }

  opts.onEvent?.({ type: 'error', error: `达到最大工具调用轮数(${maxRounds})，已停止。` });
  return finalText || `已执行多步操作但未收敛（达到 ${maxRounds} 轮上限）。`;
}
