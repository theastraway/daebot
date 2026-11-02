// Some models (minimax-m3, deepseek, qwen) put reasoning in the content stream as <think>…</think> or
// <mm:think>…</mm:think>, or leak only the closing tag. None of it is answer text: drop the blocks and any
// orphan tag. Tags can be split across stream chunks, so a possible partial tag at the end is held back.
const TAG = /<\/?(?:mm:)?think>/i;
const MAX_TAG = "</mm:think>".length;

export class ThinkFilter {
  private buf = "";
  private inThink = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      const m = TAG.exec(this.buf);
      if (!m) break;
      if (!this.inThink) out += this.buf.slice(0, m.index);
      this.inThink = !m[0].startsWith("</");
      this.buf = this.buf.slice(m.index + m[0].length);
    }
    // Hold back a tail that could be the start of a tag split across chunks.
    const lt = this.buf.lastIndexOf("<");
    const hold = lt >= 0 && this.buf.length - lt < MAX_TAG && /^<\/?(?:m(?:m(?::(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?)?)?|t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i.test(this.buf.slice(lt)) ? lt : this.buf.length;
    if (!this.inThink) out += this.buf.slice(0, hold);
    this.buf = this.buf.slice(hold);
    return out;
  }

  flush(): string {
    const rest = this.inThink ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}
