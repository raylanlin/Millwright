// src/main/llm/sse.ts
//
// SSE (Server-Sent Events) 解析器
// Anthropic 和 OpenAI 流式都用 SSE:
//   event: xxx\n
//   data: {...}\n
//   \n            ← 空行结束一条事件
//
// 这里用一个简单的基于 ReadableStream 的异步生成器。
// 不依赖 eventsource 包,避免跨平台 polyfill 问题。

export interface SSEEvent {
  /** 事件名(可选),出现在 `event:` 行 */
  event?: string;
  /** 数据,出现在 `data:` 行,多个 data 会按换行拼接 */
  data: string;
  /** id(可选) */
  id?: string;
}

/**
 * 把 fetch 响应的 body(ReadableStream<Uint8Array>)解析成 SSE 事件流。
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按 "\n\n" 切分事件。兼容 "\r\n\r\n"。
      let sepIdx: number;
      // eslint-disable-next-line no-cond-assign
      while ((sepIdx = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + (buffer[sepIdx] === '\r' ? 4 : 2));
        const parsed = parseEventBlock(rawEvent);
        if (parsed) yield parsed;
      }
    }

    // 处理残余
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseEventBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseEventBlock(block: string): SSEEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // 空行 / 注释
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // 规范允许冒号后跟一个可选空格
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;
  return { event, id, data: dataLines.join('\n') };
}
