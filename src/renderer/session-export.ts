// src/renderer/session-export.ts
//
// P66: turn a conversation into text — for the copy button on each message, and for
// exporting the whole session.
//
// The reason this is worth having: a modelling session's value is the RECORD of it.
// Which tool ran, with which arguments, and what SolidWorks said back — that is what
// you paste into a bug report, hand to a colleague, or keep as a build log for a part.
// Reading it off the screen means expanding every collapsed card by hand.
//
// Two formats, on purpose:
//   - Markdown for humans (readable, pasteable into an issue or a doc)
//   - JSON for machines (the full AgentStep structure, nothing flattened away)

import type { ChatMessage, AgentStep } from '../shared/types';

const ROLE_LABEL: Record<string, { zh: string; en: string }> = {
  user: { zh: '用户', en: 'You' },
  assistant: { zh: 'Millwright', en: 'Millwright' },
  system: { zh: '系统', en: 'System' },
  tool: { zh: '工具', en: 'Tool' },
};

export interface ExportOptions {
  locale?: 'zh' | 'en';
  /** Include the model's reasoning scratchpad. Off by default — it is long and rarely useful later. */
  includeReasoning?: boolean;
  /** Include tool arguments and results. On by default: this is the part worth keeping. */
  includeTools?: boolean;
}

function stamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusMark(status?: string): string {
  switch (status) {
    case 'ok': return '✓';
    case 'error': return '✕';
    case 'rejected': return '⛔';
    case 'running': return '…';
    default: return '·';
  }
}

/** One tool step as an indented Markdown block. */
function toolToMarkdown(s: AgentStep): string {
  const lines = [`- ${statusMark(s.status)} \`${s.name ?? 'tool'}\``];
  if (s.params && Object.keys(s.params).length) {
    lines.push('  ```json', ...JSON.stringify(s.params, null, 2).split('\n').map((l) => '  ' + l), '  ```');
  }
  if (s.result) {
    const body = s.result.trim();
    lines.push('  ```', ...body.split('\n').map((l) => '  ' + l), '  ```');
  }
  return lines.join('\n');
}

/** Plain-text form of ONE message — what the per-message copy button puts on the clipboard. */
export function messageToText(msg: ChatMessage, opts: ExportOptions = {}): string {
  const { includeReasoning = false, includeTools = true } = opts;
  const out: string[] = [];

  if (msg.images?.length) out.push(`[${msg.images.length} image(s) attached]`);
  if (msg.code) out.push('```' + (msg.codeLanguage ?? ''), msg.code, '```');

  if (msg.steps?.length) {
    for (const s of msg.steps) {
      if (s.kind === 'text') {
        if (s.text) out.push(s.text);
      } else if (s.kind === 'reasoning') {
        if (includeReasoning && s.text) out.push('<reasoning>', s.text, '</reasoning>');
      } else if (s.kind === 'tool') {
        if (includeTools) out.push(toolToMarkdown(s));
      } else if (s.kind === 'confirm') {
        if (includeTools) out.push(`- ${statusMark(s.status)} [confirm] \`${s.name ?? ''}\``);
      }
    }
  } else if (msg.content) {
    out.push(msg.content);
  }
  // P66: prose steps mirror `content`, so only fall back to it when there were no steps.
  return out.join('\n\n').trim();
}

/** The whole session as Markdown. */
export function sessionToMarkdown(messages: ChatMessage[], opts: ExportOptions = {}): string {
  const lc = opts.locale === 'en' ? 'en' : 'zh';
  const head = lc === 'zh'
    ? [`# Millwright 会话记录`, '', `导出时间：${stamp(Date.now())}`, `消息数：${messages.length}`, '', '---', '']
    : [`# Millwright session`, '', `Exported: ${stamp(Date.now())}`, `Messages: ${messages.length}`, '', '---', ''];

  const body = messages
    .filter((m) => m.role !== 'tool')  // tool results already live inside the assistant steps
    .map((m) => {
      const who = ROLE_LABEL[m.role]?.[lc] ?? m.role;
      const when = stamp(m.timestamp);
      const text = messageToText(m, opts);
      if (!text) return '';
      return `## ${who}${when ? `  ·  ${when}` : ''}\n\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return head.join('\n') + body + '\n';
}

/** The whole session as JSON — full structure, for tooling or a bug report. */
export function sessionToJSON(messages: ChatMessage[]): string {
  return JSON.stringify(
    {
      app: 'Millwright',
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map((m) => ({
        role: m.role,
        timestamp: m.timestamp,
        content: m.content,
        ...(m.code ? { code: m.code, codeLanguage: m.codeLanguage } : {}),
        ...(m.images?.length ? { imageCount: m.images.length } : {}),
        ...(m.steps?.length
          ? {
              steps: m.steps.map((s) => ({
                kind: s.kind,
                ...(s.text ? { text: s.text } : {}),
                ...(s.name ? { name: s.name } : {}),
                ...(s.params ? { params: s.params } : {}),
                ...(s.status ? { status: s.status } : {}),
                ...(s.result ? { result: s.result } : {}),
              })),
            }
          : {}),
      })),
    },
    null,
    2,
  );
}

/** Copy text to the clipboard, with a fallback for older Electron webviews. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Save a string as a file via a temporary object URL (no main-process round trip needed). */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function defaultExportName(ext: 'md' | 'json'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `millwright-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}
