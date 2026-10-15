// Minimal Server-Sent-Events reader: yields the payload of each `data:` event.
// Comment lines (": OPENROUTER PROCESSING") are ignored.
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = nextBoundary(buf)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^(\r?\n){1,2}/, "");
        const data = eventData(raw);
        if (data !== undefined) yield data;
      }
    }
    buf += decoder.decode();
    const tail = eventData(buf);
    if (tail !== undefined) yield tail;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

function nextBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function eventData(raw: string): string | undefined {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) parts.push(line.slice(5).replace(/^ /, ""));
  }
  return parts.length ? parts.join("\n") : undefined;
}

export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
