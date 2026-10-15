// Watches the gateway for `confirm` events without touching web/. The gateway broadcasts every session's events to
// WebSocket subscribers, so main opens one extra socket, resumes each LIVE session by id (resume of a live session
// just subscribes), and listens. Transport is injected: connect() returns an object with send/close/onmessage/onclose.

export class ConfirmWatcher {
  /**
   * @param {object} o
   * @param {() => Promise<{id:string, live:boolean}[]>} o.listSessions
   * @param {() => {send(s:string):void, close():void, onmessage:((s:string)=>void)|null, onclose:(()=>void)|null}} o.connect
   * @param {(event:object, sessionId:string)=>void} o.onConfirm
   * @param {number} [o.pollMs]
   */
  constructor(o) {
    this.o = o;
    this.pollMs = o.pollMs ?? 3000;
    this.subscribed = new Set();
    this.sock = null;
    this.timer = null;
    this.stopped = true;
    this.seenConfirm = new Set();
  }

  start() {
    this.stopped = false;
    this._connect();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock?.close(); } catch { /* ignore */ }
    this.sock = null;
  }

  _connect() {
    if (this.stopped) return;
    let s;
    try { s = this.o.connect(); } catch { this.sock = null; return; }
    this.sock = s;
    this.subscribed.clear();
    s.onmessage = (text) => this._frame(text);
    s.onclose = () => { if (this.sock === s) this.sock = null; this.subscribed.clear(); };
  }

  async tick() {
    if (this.stopped) return;
    if (!this.sock) this._connect();
    if (!this.sock) return;
    let list;
    try { list = await this.o.listSessions(); } catch { return; }
    for (const s of list) {
      if (!s.live || this.subscribed.has(s.id)) continue;
      this.subscribed.add(s.id);
      try { this.sock.send(JSON.stringify({ t: "open", surface: "desktop-watch", resumeId: s.id })); } catch { this.subscribed.delete(s.id); }
    }
  }

  _frame(text) {
    let f;
    try { f = JSON.parse(text); } catch { return; }
    if (!f || f.t !== "event" || !f.event || f.event.type !== "confirm") return;
    const key = `${f.sessionId}:${f.event.id}`;
    if (this.seenConfirm.has(key)) return;
    this.seenConfirm.add(key);
    if (this.seenConfirm.size > 500) this.seenConfirm.delete(this.seenConfirm.values().next().value);
    try { this.o.onConfirm(f.event, String(f.sessionId)); } catch { /* notification failure must not kill the watcher */ }
  }
}
