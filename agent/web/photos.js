// Photos in the composer: drag and drop, paste, and the attach button.
//
// A photo is shrunk in the browser (longest side 1568px, JPEG q0.85, strips EXIF) before it is sent, so a phone photo of 4 MB
// leaves as a few hundred KB. The server validates it again and stores it per chat; Dae reads it with the view_photo tool.
// DOM is built with createElement + textContent only. Pure helpers are exported so they can be tested in node.

export const MAX_PHOTOS = 5;
export const MAX_EDGE = 1568;
export const QUALITY = 0.85;
export const MAX_BYTES = 8 * 1024 * 1024;       // per photo, after shrinking (the server enforces the same)
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // all photos of one message (the server enforces the same)
export const MAX_RAW_BYTES = 40 * 1024 * 1024;  // a file bigger than this is not even decoded
export const QUEUE_PHOTO_BUDGET = 3_000_000;    // characters of photo data a queued message may keep in sessionStorage

const OK_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const EXT_TYPE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export const SAYS = {
  heic: "HEIC photos can't be read here. Convert it to JPEG and attach it again.",
  other: "Only JPEG, PNG, WebP or GIF photos can be attached.",
  limit: `You can attach up to ${MAX_PHOTOS} photos per message.`,
  unreadable: (n) => `"${n}" could not be read as an image.`,
  big: (n) => `"${n}" is still over ${MAX_BYTES / 1048576} MB after shrinking. Try a smaller photo.`,
  huge: (n) => `"${n}" is too large to open here (over ${MAX_RAW_BYTES / 1048576} MB).`,
  total: `These photos are over ${MAX_TOTAL_BYTES / 1048576} MB together. Remove one or attach fewer.`,
  preparing: "Still preparing your photos. Send again in a moment.",
};

const extOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(String(name || "")) || [])[1]?.toLowerCase() || "";

/** "ok" (a type we accept), "heic" (iPhone format we cannot read) or "other". Falls back to the extension when the type is empty. */
export function classifyFile(file) {
  const type = String(file?.type || "").toLowerCase() || EXT_TYPE[extOf(file?.name)] || "";
  if (OK_TYPES.has(type)) return "ok";
  if (/^image\/hei[cf]/.test(type) || /^(heic|heif)$/.test(extOf(file?.name))) return "heic";
  return "other";
}

/** Largest size with the same shape whose longest side is at most `max`. Never scales up. */
export function fitWithin(w, h, max = MAX_EDGE) {
  const long = Math.max(w, h);
  if (!(long > max)) return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Decoded size in bytes of a base64 data URL. */
export function dataUrlBytes(url) {
  const s = String(url || "");
  const i = s.indexOf(",");
  if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

const isPhoto = (p) => p && typeof p === "object" && typeof p.dataUrl === "string" && p.dataUrl.startsWith("data:image/");

/** Reads the queue back from sessionStorage JSON. Older versions stored plain strings. Never throws. */
export function normQueue(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items = [];
    for (const x of list) {
      if (typeof x === "string") { if (x.trim()) items.push({ text: x, photos: [], lost: 0 }); continue; }
      if (!x || typeof x !== "object") continue;
      const photos = Array.isArray(x.photos) ? x.photos.filter(isPhoto).map((p) => ({ name: String(p.name || "photo"), dataUrl: p.dataUrl, width: Number(p.width) || 0, height: Number(p.height) || 0 })) : [];
      const text = typeof x.text === "string" ? x.text : "";
      if (text.trim() || photos.length || x.lost) items.push({ text, photos, lost: Number(x.lost) || 0 });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

/**
 * The queue as sessionStorage JSON. Photo data counts against `budget` characters (the browser allows about 5M in all);
 * a message whose photos do not fit keeps its text and records how many photos were left out. The in-memory queue is untouched.
 */
export function packQueue(queue, budget = QUEUE_PHOTO_BUDGET) {
  let left = budget, dropped = 0;
  const out = {};
  for (const [key, list] of Object.entries(queue || {})) {
    out[key] = list.map((it) => {
      const photos = it.photos || [];
      const size = photos.reduce((n, p) => n + p.dataUrl.length, 0);
      if (!photos.length) return { text: it.text, lost: it.lost || 0 };
      if (size <= left) { left -= size; return { text: it.text, photos: photos.map(({ name, dataUrl, width, height }) => ({ name, dataUrl, width, height })), lost: it.lost || 0 }; }
      dropped += photos.length;
      return { text: it.text, lost: (it.lost || 0) + photos.length };
    });
  }
  return { json: JSON.stringify(out), dropped };
}

/** One line for a queued message: its text, or what it holds when it is only photos. */
export function queueLabel(it) {
  const t = String(it?.text || "").trim();
  const n = (it?.photos || []).length + (it?.lost || 0);
  if (t) return t;
  return n ? `${n} photo${n === 1 ? "" : "s"}` : "";
}

// ---------------------------------------------------------------- browser side

const fileToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error || new Error("read failed"));
  r.readAsDataURL(blob);
});

// The page CSP allows data: images but not blob:, so nothing here goes through an object URL.
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* older engines reject that option */ }
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  const img = new Image();
  img.src = await fileToDataUrl(file);
  await img.decode();
  return img;
}

/** Shrinks one image file to a JPEG data URL. Transparency is flattened onto white (JPEG has none). */
export async function shrink(file) {
  const src = await decode(file);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const { width, height } = fitWithin(w, h);
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, width, height);
  g.drawImage(src, 0, 0, width, height);
  if (typeof src.close === "function") src.close();
  return { dataUrl: c.toDataURL("image/jpeg", QUALITY), width, height };
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const editable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function initPhotos({ els, h, icon, api, onChange }) {
  const items = [];            // ready to send: { name, dataUrl, width, height }
  let preparing = 0;           // files still being shrunk
  let noteTimer = 0;
  const cache = new Map();     // "sessionId/photoId" -> data URL fetched from the server
  let active = 0;
  const waiting = [];

  // ---- messages next to the composer
  function say(text) {
    els.note.textContent = text;
    els.note.hidden = !text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => say(""), 7000);
  }

  // ---- the strip of thumbnails above the composer
  function render() {
    els.strip.replaceChildren();
    items.forEach((p, i) => {
      const t = h("div", "attach-thumb");
      const img = document.createElement("img");
      img.src = p.dataUrl; img.alt = p.name; img.draggable = false;
      const x = h("button", "attach-x"); x.type = "button";
      x.setAttribute("aria-label", `Remove photo ${p.name}`); x.title = "Remove";
      x.append(icon("i-x"));
      x.addEventListener("click", () => { items.splice(i, 1); render(); onChange?.(); els.input.focus(); });
      t.append(img, x);
      t.title = p.name;
      els.strip.append(t);
    });
    for (let i = 0; i < preparing; i++) { const t = h("div", "attach-thumb loading"); t.setAttribute("aria-label", "Preparing photo"); els.strip.append(t); }
    els.strip.hidden = items.length + preparing === 0;
  }

  async function add(fileList) {
    let notes = "";
    for (const file of [...fileList]) {
      const kind = classifyFile(file);
      if (kind === "heic") { notes = SAYS.heic; continue; }
      if (kind !== "ok") { notes = SAYS.other; continue; }
      if (items.length + preparing >= MAX_PHOTOS) { notes = SAYS.limit; break; }
      const name = (file.name && !/^image\.(png|jpe?g)$/i.test(file.name) ? file.name : "") || `pasted-${Date.now().toString(36)}.jpg`;
      if (file.size > MAX_RAW_BYTES) { notes = SAYS.huge(name); continue; }
      preparing++; render();
      try {
        const r = await shrink(file);
        const size = dataUrlBytes(r.dataUrl);
        if (size > MAX_BYTES) notes = SAYS.big(name);
        else if (items.reduce((n, p) => n + dataUrlBytes(p.dataUrl), size) > MAX_TOTAL_BYTES) notes = SAYS.total;
        else items.push({ name: name.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", ...r });
      } catch { notes = SAYS.unreadable(name); }
      finally { preparing--; render(); onChange?.(); }
    }
    say(notes);
  }

  // ---- drop, paste, picker
  // preventDefault on every dragover and file drop at the document: a missed drop must never navigate the app to the file.
  let overlayTimer = 0;
  const hideOverlay = () => { clearTimeout(overlayTimer); els.overlay.hidden = true; };
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!hasFiles(e)) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    els.overlay.hidden = false;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(hideOverlay, 300); // dragover repeats while a file is over the page; silence means it left
  });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) hideOverlay(); });
  document.addEventListener("dragend", hideOverlay);
  document.addEventListener("drop", (e) => {
    hideOverlay();
    if (hasFiles(e)) { e.preventDefault(); add(e.dataTransfer.files); return; }
    if (!editable(e.target)) e.preventDefault(); // a dropped link or text must not navigate; dropping text into a field still works
  });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // plain text paste is left alone
    if (editable(e.target) && e.target !== els.input) return;
    e.preventDefault();
    add(files);
  });
  els.btn.addEventListener("click", () => els.picker.click());
  els.picker.addEventListener("change", () => { add(els.picker.files); els.picker.value = ""; });

  // ---- showing photos that were already sent
  function fetchPhoto(sid, id) {
    const key = `${sid}/${id}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return new Promise((resolve) => { waiting.push({ sid, id, key, resolve }); pump(); });
  }
  function pump() {
    while (active < 3 && waiting.length) {
      const job = waiting.shift();
      active++;
      (async () => {
        try {
          const res = await api(`/sessions/${encodeURIComponent(job.sid)}/photos/${encodeURIComponent(job.id)}`);
          if (!res.ok) return job.resolve("");
          const url = await fileToDataUrl(await res.blob());
          cache.set(job.key, url);
          job.resolve(url);
        } catch { job.resolve(""); }
        finally { active--; pump(); }
      })();
    }
  }

  // ---- full size view
  let viewer = null;
  function openViewer(src, name) {
    closeViewer();
    viewer = h("div", "photo-view");
    viewer.setAttribute("role", "dialog"); viewer.setAttribute("aria-modal", "true"); viewer.setAttribute("aria-label", name || "Photo");
    const img = document.createElement("img"); img.src = src; img.alt = name || "";
    const x = h("button", "photo-view-x"); x.type = "button"; x.setAttribute("aria-label", "Close photo"); x.append(icon("i-x"));
    viewer.append(img, x);
    viewer.addEventListener("click", closeViewer);
    document.body.append(viewer);
    x.focus();
  }
  function closeViewer() { if (viewer) { viewer.remove(); viewer = null; } }
  // Capture phase and stopImmediatePropagation: Escape closes the photo and must not also stop a running turn.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && viewer) { e.preventDefault(); e.stopImmediatePropagation(); closeViewer(); } }, true);

  /** The thumbnails of a sent message. Photos carry a dataUrl (just sent) or an id (loaded from the server for sessionId). */
  function thumbs(list, sessionId) {
    const box = h("div", "msg-photos");
    for (const p of list || []) {
      const b = h("button", "msg-photo"); b.type = "button";
      b.setAttribute("aria-label", `Open photo ${p.name || ""}`.trim());
      const img = document.createElement("img"); img.alt = p.name || "photo"; img.draggable = false;
      b.append(img);
      const show = (src) => { if (src) { img.src = src; b.addEventListener("click", () => openViewer(src, p.name)); } else { b.classList.add("gone"); b.title = "This photo is no longer stored"; b.disabled = true; } };
      if (p.dataUrl) show(p.dataUrl);
      else if (p.id && sessionId) { b.classList.add("loading"); fetchPhoto(sessionId, p.id).then((u) => { b.classList.remove("loading"); show(u); }); }
      else show("");
      box.append(b);
    }
    return box;
  }

  /** Small previews for the queued-message row. */
  function mini(list) {
    const box = h("span", "queue-photos");
    for (const p of list || []) { const img = document.createElement("img"); img.src = p.dataUrl; img.alt = p.name || "photo"; img.draggable = false; box.append(img); }
    return box;
  }

  render();
  return {
    count: () => items.length,
    preparing: () => preparing,
    /** The photos ready to send. Leaves them in the composer. */
    list: () => items.slice(),
    /** Takes them out of the composer (the message is being sent or queued). */
    take() { const out = items.splice(0); render(); onChange?.(); return out; },
    /** Puts photos back (a send failed before it left). */
    set(list) { items.splice(0, items.length, ...(list || []).slice(0, MAX_PHOTOS)); render(); onChange?.(); },
    add, say, thumbs, mini, fetchPhoto,
  };
}
