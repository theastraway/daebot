// Some models (minimax-m3, deepseek, qwen) put reasoning in the content stream as <think>…</think> or
// <mm:think>…</mm:think>, or leak only the closing tag. None of it is answer text: the blocks and any orphan tag are
// kept out of the answer. The text INSIDE a block is the model's inner voice: it goes to onThink (the loop shows it to
// the user as a "thinking" event) and never to the answer. Tags can be split across stream chunks, so a possible
// partial tag at the end is held back.
const TAG = /<\/?(?:mm:)?think>/i;
const MAX_TAG = "</mm:think>".length;

export class ThinkFilter {
  private buf = "";
  private inThink = false;
  private onThink?: (delta: string) => void;

  constructor(onThink?: (delta: string) => void) { this.onThink = onThink; }

  private think(s: string): void { if (s && this.onThink) this.onThink(s); }

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      const m = TAG.exec(this.buf);
      if (!m) break;
      const seg = this.buf.slice(0, m.index);
      if (this.inThink) this.think(seg); else out += seg;
      this.inThink = !m[0].startsWith("</");
      this.buf = this.buf.slice(m.index + m[0].length);
    }
    // Hold back a tail that could be the start of a tag split across chunks.
    const lt = this.buf.lastIndexOf("<");
    const hold = lt >= 0 && this.buf.length - lt < MAX_TAG && /^<\/?(?:m(?:m(?::(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?)?)?|t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i.test(this.buf.slice(lt)) ? lt : this.buf.length;
    const ready = this.buf.slice(0, hold);
    if (this.inThink) this.think(ready); else out += ready;
    this.buf = this.buf.slice(hold);
    return out;
  }

  flush(): string {
    const rest = this.buf;
    this.buf = "";
    if (this.inThink) { this.think(rest); return ""; }
    return rest;
  }
}
