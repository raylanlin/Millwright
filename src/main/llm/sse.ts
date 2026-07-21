// src/main/llm/sse.ts
//
// SSE (Server-Sent Events) parser.
// Both Anthropic and OpenAI stream over SSE, with the following wire format:
//   event: xxx\n
//   data: {...}\n
//   \n            ← a blank line terminates one event
//
// This file implements a minimal `ReadableStream`-based async generator.
// It intentionally avoids the `eventsource` package to sidestep cross-platform polyfill issues.

export interface SSEEvent {
  /** Optional event name, taken from the `event:` line */
  event?: string;
  /** Payload taken from the `data:` lines; multiple `data:` lines are joined with newlines */
  data: string;
  /** Optional `id` from the `id:` line */
  id?: string;
}

/**
 * Parse the `ReadableStream<Uint8Array>` body of a fetch response into a stream of SSE events.
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

      // Split events on the "\n\n" boundary. Also tolerates "\r\n\r\n".
      let sepIdx: number;
      // eslint-disable-next-line no-cond-assign
      while ((sepIdx = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + (buffer[sepIdx] === '\r' ? 4 : 2));
        const parsed = parseEventBlock(rawEvent);
        if (parsed) yield parsed;
      }
    }

    // Flush any trailing bytes left in the buffer
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
    if (!line || line.startsWith(':')) continue; // blank line / SSE comment
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // The spec allows an optional space after the colon
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;
  return { event, id, data: dataLines.join('\n') };
}
