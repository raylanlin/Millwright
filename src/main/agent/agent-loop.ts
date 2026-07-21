// src/main/agent/agent-loop.ts
// P1.1 polish: addresses the HIGH/MED findings from the code review.
//   HIGH-1 Backup: back up the active document once at the start of runAgentLoop and surface the path via onEvent to the UI.
//   MED-2  Truncation: truncate history before each round's chatWithTools call; cap individual tool result length.
//   MED-3  Confirmation gate: tools marked requiresConfirmation pause via onEvent until the user approves.
// Overrides the repo file of the same name. Dependencies: backupActiveDocument(bridge) and truncateMessages already exist.

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
  /** Pre-execution backup: a wrapper around the existing `backup.ts`; failures do not block but are surfaced to the UI */
  backup?: () => Promise<string | null>;
  /** MED-3: tools that require human confirmation; returns Promise<boolean> (UI approve/reject). If omitted, the tool is executed directly */
  confirmTool?: (call: ToolCall) => Promise<boolean>;
  /** Whitelist of tools that need confirmation (defaults to destructive operations) */
  confirmList?: Set<string>;
}

const DEFAULT_CONFIRM = new Set(['cut_extrude', 'create_fillet', 'modify_dimensions', 'delete_feature']);
const TOOL_RESULT_MAX_CHARS = 4000; // MED-2: cap each tool result's length to prevent context explosion

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

  // HIGH-1: session-level backup (rollback point for the whole loop). Failures do not block, but are surfaced to the UI.
  let backupPath: string | null = null;
  if (opts.backup) {
    try { backupPath = await opts.backup(); } catch { backupPath = null; }
  }
  opts.onEvent?.({ type: 'start', requestId: opts.requestId, backupPath });

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');

    // MED-2: truncate before each round (keep system prompt + most recent exchanges)
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

      // MED-3: confirmation gate for destructive tools
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
