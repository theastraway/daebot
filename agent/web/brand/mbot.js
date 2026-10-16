// <m-bot> — the Daebot avatar: the real M mascot head from the Plug In commercial (rendered with Nano Banana from
// the commercial frame and the MIND logo, /brand/daebot-head.webp, screen unlit) with a live LED screen on top.
// Every LED on the screen is drawn and lit in code, so the face can make any expression.
//
//   <m-bot></m-bot>                       idle: breathes, blinks, glances, eyes follow the pointer
//   <m-bot mood="talk|think|happy|alert|wink|love|sleep|wow|sad|idle">
//   <m-bot still>                         one idle frame, never animates (cheap avatars)
//   <m-bot intro>                         winks hello when it first appears
//   <m-bot playful>                       click or tap it for a random reaction
//   el.say(ms)                            pulse the mouth as if speaking for ms
//   el.flash(mood, ms)                    show a mood briefly, then return to idle
//
// One shared requestAnimationFrame loop drives every live instance; LEDs are only touched when they change.

const NS = "http://www.w3.org/2000/svg";
const HEAD_SRC = "/brand/daebot-head.webp";

// Screen geometry in the head image's own pixel space (2048 x 2048), measured from the render.
const SCREEN = "M578 822H930L1022 888L1115 822H1469V1010L1024 1454L578 1010Z";
const COLS = 35, ROWS = 25, PITCH = 25, X0 = 598, Y0 = 843;
const LED_OFF = "#404043", LED_ON = "#fffaf0", LED_RED = "#ff3d3d", LED_HOT = "#ffffff";

const inScreen = (x, y) => {
  const m = 9; // keep LEDs off the frame edge
  if (x < 578 + m || x > 1469 - m || y < 822 + m) return false;
  if (y < 888 + m && Math.abs(x - 1022) < 93 * (1 - (y - 822) / 66) + m) return false; // the V notch at the top
  if (y > 1010) return Math.abs(x - 1024) <= 446 - (y - 1010) - m * 1.4;
  return true;
};

// --- drawing helpers in LED (col,row) space ---------------------------------------------------------
function disc(set, cx, cy, rx, ry, v = 1) {
  for (let r = Math.floor(cy - ry); r <= Math.ceil(cy + ry); r++)
    for (let c = Math.floor(cx - rx); c <= Math.ceil(cx + rx); c++) {
      const dx = (c - cx) / (rx + .3), dy = (r - cy) / (ry + .3);
      if (dx * dx + dy * dy <= 1) set(c, r, v);
    }
}
function line(set, c0, r0, c1, r1, v = 1) {
  const n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0), 1);
  for (let i = 0; i <= n; i++) set(Math.round(c0 + (c1 - c0) * i / n), Math.round(r0 + (r1 - r0) * i / n), v);
}
const pts = (set, list, v = 1) => list.forEach(([c, r]) => set(c, r, v));

// Face layout, taken from the commercial frame: eyes at cols 10 and 23, smile under them, red blush on the right.
const EL = 10, ER = 23, EY = 7, MC = 16.5, MY = 13;

function eye(set, cx, cy, s, side) {
  cx += Math.round(s.gx * 1.6); cy += Math.round(s.gy * 1.4);
  const shape = side === "R" && s.wink ? "wink" : s.eyeShape;
  if (shape === "wink") { pts(set, [[cx - 1, cy - 1], [cx - 2, cy]]); line(set, cx - 2, cy, cx + 2, cy); return; }
  if (s.open < .25) { line(set, cx - 2, cy + 1, cx + 2, cy + 1); return; }
  if (shape === "happy") { pts(set, [[cx - 2, cy + 1], [cx - 1, cy], [cx, cy - 1], [cx + 1, cy], [cx + 2, cy + 1]]); return; }
  if (shape === "heart") {
    pts(set, [[cx - 2, cy - 2], [cx - 1, cy - 2], [cx + 1, cy - 2], [cx + 2, cy - 2]], 2);
    line(set, cx - 3, cy - 1, cx + 3, cy - 1, 2); line(set, cx - 3, cy, cx + 3, cy, 2);
    line(set, cx - 2, cy + 1, cx + 2, cy + 1, 2); line(set, cx - 1, cy + 2, cx + 1, cy + 2, 2); set(cx, cy + 3, 2); return;
  }
  if (shape === "big") { disc(set, cx, cy, 3.4, 3.4); disc(set, cx, cy, 1.4, 1.4, 0); return; }
  if (shape === "spin") { const a = s.t * 9; disc(set, cx, cy, 2.6, 2.6); set(Math.round(cx + Math.cos(a) * 1.4), Math.round(cy + Math.sin(a) * 1.4), 0); return; }
  disc(set, cx, cy + (1 - s.open) * 1.5, 2.7, 2.7 * s.open);
}

function mouth(set, s) {
  const c = MC, r = MY;
  switch (s.mouth) {
    case "talk": {
      const h = 1 + Math.round(s.talk * 4), w = 3 + Math.round(s.talk * 1.5);
      if (h <= 1) { line(set, c - w - .5, r + 1, c + w + .5, r + 1); return; }
      for (let i = 0; i < h; i++) {
        const inset = (i === 0 || i === h - 1) ? 1 : 0;
        line(set, c - w - .5 + inset, r + i, c + w + .5 - inset, r + i);
      }
      if (h >= 3) for (let i = 1; i < h - 1; i++) line(set, c - w + 1.5, r + i, c + w - 1.5, r + i, 0);
      return;
    }
    case "grin":
      pts(set, [[c - 6.5, r - 1], [c + 6.5, r - 1]]);
      line(set, c - 5.5, r, c + 5.5, r); line(set, c - 4.5, r + 1, c + 4.5, r + 1); line(set, c - 3.5, r + 2, c + 3.5, r + 2);
      line(set, c - 2.5, r + 1, c + 2.5, r + 1, 0); return;
    case "o": disc(set, c, r + 1, 2, 2.2); disc(set, c, r + 1, .8, 1, 0); return;
    case "flat": line(set, c - 3.5, r + 1, c + 3.5, r + 1); return;
    case "sad": pts(set, [[c - 4.5, r + 2], [c - 3.5, r + 1], [c + 3.5, r + 1], [c + 4.5, r + 2]]); line(set, c - 2.5, r, c + 2.5, r); return;
    case "think": {
      line(set, c - 2.5, r + 1, c + 2.5, r + 1);
      const k = Math.floor(s.t * 4) % 4;
      for (let i = 0; i < 3; i++) if (i < k) set(c + 6 + i * 2, r - 1 - i);
      return;
    }
    case "zzz": line(set, c - 2.5, r + 1, c + 2.5, r + 1); return;
    default: // the commercial's smile: a single-pixel curve
      pts(set, [[c - 5.5, r - 1], [c - 4.5, r], [c - 3.5, r + 1], [c + 3.5, r + 1], [c + 4.5, r], [c + 5.5, r - 1]]);
      line(set, c - 2.5, r + 2, c + 2.5, r + 2);
  }
}

function blush(set) { // the red cheek from the commercial frame
  pts(set, [[26, 11], [25, 12], [26, 12], [27, 12], [24, 13], [25, 13], [26, 13], [27, 13], [28, 13], [25, 14], [26, 14], [27, 14], [26, 15]], 2);
}

const MOODS = {
  idle:  { mouth: "smile" },
  talk:  { mouth: "talk" },
  think: { mouth: "think", gx: .9, gy: -1, eyeShape: "spin" },
  happy: { mouth: "grin", eyeShape: "happy", blush: true },
  alert: { mouth: "o", eyeShape: "big", red: true },
  wow:   { mouth: "o", eyeShape: "big" },
  wink:  { mouth: "smile", wink: true, blush: true },
  love:  { mouth: "smile", eyeShape: "heart", blush: true },
  sad:   { mouth: "sad", gy: .8 },
  sleep: { mouth: "zzz", closed: true },
};
const PLAY = ["happy", "love", "wow", "wink"];

const live = new Set();
let pointer = null;
addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY, at: performance.now() }; }, { passive: true });
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
function tick(now) {
  for (const b of live) b._paint(now, false);
  if (live.size) requestAnimationFrame(tick);
}

class MBot extends HTMLElement {
  static get observedAttributes() { return ["mood"]; }

  connectedCallback() {
    if (!this._svg) {
      this._build();
      if (this.hasAttribute("intro")) setTimeout(() => this.flash("wink", 1100), 400);
      if (this.hasAttribute("playful")) this.addEventListener("click", () => this.flash(PLAY[(Math.random() * PLAY.length) | 0], 1500));
    }
    this._paint(performance.now(), true);
    if (!this.hasAttribute("still") && !reduce) {
      const first = !live.size;
      live.add(this);
      if (first) requestAnimationFrame(tick);
    }
  }
  disconnectedCallback() { live.delete(this); }
  attributeChangedCallback() { if (this._svg) this._paint(performance.now(), true); }

  get mood() { return this.getAttribute("mood") || "idle"; }
  set mood(m) { if (m !== this.getAttribute("mood")) this.setAttribute("mood", m); }
  say(ms = 260) { this._sayUntil = performance.now() + ms; }
  flash(mood, ms = 1600, then = "idle") {
    this.mood = mood; clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { if (this.mood === mood) this.mood = then; }, ms);
  }

  _build() {
    const uid = Math.random().toString(36).slice(2, 8);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "100 60 1848 1900");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Daebot");
    svg.innerHTML = `
      <defs>
        <clipPath id="k${uid}"><path d="${SCREEN}"/></clipPath>
        <filter id="f${uid}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <linearGradient id="s${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".06"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
      </defs>
      <image href="${HEAD_SRC}" x="0" y="0" width="2048" height="2048"/>
      <path d="${SCREEN}" fill="#0c0c0d"/>
      <g class="off" clip-path="url(#k${uid})"></g>
      <g class="on" clip-path="url(#k${uid})" filter="url(#f${uid})"></g>
      <path d="${SCREEN}" fill="url(#s${uid})" pointer-events="none"/>`;
    const off = svg.querySelector(".off"), on = svg.querySelector(".on");
    this._dots = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const x = X0 + c * PITCH, y = Y0 + r * PITCH;
        if (!inScreen(x, y)) { row.push(null); continue; }
        const d = document.createElementNS(NS, "rect");
        d.setAttribute("x", x - 8); d.setAttribute("y", y - 8); d.setAttribute("width", 16); d.setAttribute("height", 16);
        d.setAttribute("rx", 3.5); d.setAttribute("fill", LED_OFF);
        off.append(d);
        const l = document.createElementNS(NS, "rect");
        l.setAttribute("x", x - 10); l.setAttribute("y", y - 10); l.setAttribute("width", 20); l.setAttribute("height", 20);
        l.setAttribute("rx", 4); l.setAttribute("fill", LED_ON); l.setAttribute("visibility", "hidden");
        on.append(l); l._v = 0;
        row.push(l);
      }
      this._dots.push(row);
    }
    this._svg = svg;
    this._t0 = performance.now() - Math.random() * 4000;
    this._nextBlink = this._t0 + 1800 + Math.random() * 2500;
    this._blinkAt = -1e9;
    this._glance = { gx: 0, gy: 0, until: 0 };
    this._g = { gx: 0, gy: 0 };
    this._talk = 0;
    this.append(svg);
  }

  _paint(now, force) {
    const m = MOODS[this.mood] || MOODS.idle;
    const t = (now - this._t0) / 1000;
    const still = this.hasAttribute("still") || reduce;

    // gaze: the pointer when it moved recently, else the mood's gaze, else an occasional idle glance
    let tgx = m.gx ?? 0, tgy = m.gy ?? 0;
    if (!still && m.gx == null && m.gy == null) {
      if (pointer && now - pointer.at < 4000) {
        const b = this.getBoundingClientRect();
        const dx = pointer.x - (b.left + b.width / 2), dy = pointer.y - (b.top + b.height * .55);
        const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 240);
        tgx = dx / d * k; tgy = dy / d * k;
      } else {
        if (now > this._glance.until) {
          const look = Math.random() < .5;
          this._glance = { gx: look ? Math.random() * 2 - 1 : 0, gy: look ? (Math.random() - .6) * .8 : 0, until: now + 1300 + Math.random() * 2600 };
        }
        tgx = this._glance.gx; tgy = this._glance.gy;
      }
    }
    const ease = still ? 1 : .2;
    this._g.gx += (tgx - this._g.gx) * ease; this._g.gy += (tgy - this._g.gy) * ease;

    let open = 1;
    if (m.closed) open = 0;
    else if (!still) {
      if (now > this._nextBlink) { this._blinkAt = now; this._nextBlink = now + (2400 + Math.random() * 3600) * (Math.random() < .15 ? .1 : 1); }
      const b = (now - this._blinkAt) / 140;
      if (b >= 0 && b < 1) open = Math.abs(1 - b * 2);
    }

    const talking = m.mouth === "talk" || (this._sayUntil && now < this._sayUntil);
    if (talking && !still) this._talk += (Math.abs(Math.sin(t * 15) * Math.sin(t * 6.1 + 1.3)) - this._talk) * .55;

    const s = { open, t, gx: this._g.gx, gy: this._g.gy, eyeShape: m.eyeShape, wink: m.wink, mouth: talking ? "talk" : m.mouth, talk: this._talk };
    const next = new Uint8Array(ROWS * COLS);
    const set = (c, r, v = 1) => { c = Math.round(c); r = Math.round(r); if (c >= 0 && c < COLS && r >= 0 && r < ROWS) next[r * COLS + c] = v; };
    eye(set, EL, EY, s, "L");
    eye(set, ER, EY, s, "R");
    mouth(set, s);
    if (m.blush) blush(set);
    if (this.mood === "sleep") { const k = Math.floor(t * 1.4) % 4; for (let i = 0; i < k; i++) line(set, 26 + i * 2, 4 - i * 2, 27 + i * 2, 4 - i * 2); }

    const twinkle = !still && Math.random() < .03 ? (Math.random() * ROWS * COLS) | 0 : -1;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const d = this._dots[r][c]; if (!d) continue;
      const i = r * COLS + c;
      let v = next[i];
      if (v === 1 && m.red) v = 2;
      if (i === twinkle && v === 1) v = 3;
      if (force || d._v !== v) {
        d._v = v;
        if (v === 0) d.setAttribute("visibility", "hidden");
        else { d.setAttribute("visibility", "visible"); d.setAttribute("fill", v === 2 ? LED_RED : v === 3 ? LED_HOT : LED_ON); }
      }
    }

    // body language: breathe, lean toward the gaze, bounce when happy, shake on alert
    if (!still) {
      const bob = Math.sin(t * 1.7) + (this.mood === "happy" ? -Math.abs(Math.sin(t * 9)) * 3 : 0);
      const shake = this.mood === "alert" ? Math.sin(t * 40) * 1.2 : 0;
      this._svg.style.transform = `translate(${shake.toFixed(2)}%, ${bob.toFixed(2)}%) perspective(700px) rotateY(${(this._g.gx * 8).toFixed(2)}deg) rotateX(${(-this._g.gy * 6).toFixed(2)}deg) rotate(${(this._g.gx * 2 + (this.mood === "think" ? Math.sin(t * 1.4) * 2 : 0)).toFixed(2)}deg)`;
    }
  }
}

if (!customElements.get("m-bot")) customElements.define("m-bot", MBot);
export { MBot, MOODS };
