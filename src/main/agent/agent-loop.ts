// src/main/agent/agent-loop.ts
//
// P1 核心：agent 工具调用循环（tool-use loop）。
//
// 这是重启的心脏——把"模型一次性吐整段 VBA"变成
// "模型 → 调用原子工具 → 拿到结构化结果 → 决定下一步 → …"。
//
// 循环协议（OpenAI 兼容，DeepSeek / Kimi / MiniMax 通用）:
//   1. 带 tools 发起 chat
//   2. 若返回 finish_reason='tool_calls'：逐个执行工具，把结果作为
//      role:'tool' 消息追加回历史，回到 1
//   3. 若返回普通文本（finish_reason='stop'）：结束，把文本给用户
//   4. 达到 maxRounds 上限强制停止（防止死循环烧 token）
//
// 工具执行 = generateScript(name, params) → ScriptEngine.run()。
// 每步都过 sanitizer + 执行前备份（复用现有安全设施）。

import type { OpenAIAdapter } from '../llm/openai';
import type { ChatMessage, ToolCall } from '../../shared/types';
import { generateScript } from '../scripts/generators';
import { validateScript } from '../scripts/sanitizer';
import type { ScriptEngine } from '../scripts/engine';

export interface AgentEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface AgentOptions {
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
}

/** 执行单个工具调用：生成脚本 → 安全校验 → 引擎执行 → 返回给模型的文本结果 */
async function executeTool(
  engine: ScriptEngine,
  call: ToolCall,
): Promise<string> {
  let gen;
  try {
    gen = generateScript(call.name, call.parameters);
  } catch (err) {
    return `工具 ${call.name} 生成脚本失败：${err instanceof Error ? err.message : String(err)}`;
  }

  const check = validateScript(gen.code, gen.language);
  if (!check.safe) {
    return `工具 ${call.name} 未通过安全校验：${check.issues.join('; ')}`;
  }

  const result = await engine.run(gen.code, gen.language);
  if (result.success) {
    return `✅ ${call.name} 执行成功。${result.output || ''}`.trim();
  }
  return `❌ ${call.name} 执行失败：${result.error || '未知错误'}`;
}

/**
 * 运行一轮完整的 agent 会话。
 * @returns 最终给用户的助手文本
 */
export async function runAgentLoop(
  adapter: OpenAIAdapter,
  messages: ChatMessage[],
  engine: ScriptEngine,
  opts: AgentOptions = {},
): Promise<string> {
  const maxRounds = opts.maxRounds ?? 8;
  const history: ChatMessage[] = [...messages];
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('已取消');

    // 带 tools 的一次性 chat（agent 循环用非流式更简单可靠；
    // 面向用户的 token 流可在 UI 层单独处理，或后续升级为流式 tool 解析）
    const resp = await adapter.chatWithTools(history, opts.signal);

    if (resp.content) {
      finalText = resp.content;
      opts.onEvent?.({ type: 'text', text: resp.content });
    }

    // 没有工具调用 → 收尾
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      opts.onEvent?.({ type: 'done', text: finalText });
      return finalText;
    }

    // 把助手的这条（含 tool_calls）加入历史
    history.push({
      role: 'assistant',
      content: resp.content ?? '',
      toolCalls: resp.toolCalls,
    });

    // 逐个执行工具，结果作为 tool 消息回填
    for (const call of resp.toolCalls) {
      opts.onEvent?.({ type: 'tool_start', toolCall: call });
      const resultText = await executeTool(engine, call);
      call.result = resultText;
      opts.onEvent?.({ type: 'tool_result', toolCall: call });

      // OpenAI 协议要求 tool 结果用 role:'tool' + tool_call_id 回填。
      // 我们的 ChatMessage 没有独立 tool 角色，用带 toolCalls 的
      // system/user 承载；adapter.chatWithTools 负责序列化成正确的
      // role:'tool' 消息（见 openai.ts 的 buildToolMessages）。
      history.push({
        role: 'system',
        content: resultText,
        toolCalls: [{ ...call, result: resultText }],
      });
    }
  }

  opts.onEvent?.({
    type: 'error',
    error: `达到最大工具调用轮数(${maxRounds})，已停止。请拆分任务或增大 maxRounds。`,
  });
  return finalText || `已执行多步操作但未收敛（达到 ${maxRounds} 轮上限）。`;
}
