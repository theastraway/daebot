// iOS Simulator pane. Local only. A screenshot arrives about once a second over SSE.
// The picture is assigned as an image, and every label is textContent. A fixture banner is
// created only when the gateway says fixture: true (the shots harness). A real Simulator never does.

export const PANE_LABEL = "iOS Simulator";
export const FIXTURE_BANNER = "Fixture. This picture is not a live simulator.";

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      data.push(v);
    }
  }
  if (!data.length) return null;
  try { return { event, data: JSON.parse(data.join("\n")) }; } catch { return null; }
}

/**
 * @param {{ json: Function, authHeaders: () => Record<string, string>, currentId: () => string | null,
 *   chip: HTMLElement, pane: HTMLElement, device: HTMLSelectElement, boot: HTMLElement, shutdown: HTMLElement,
 *   record: HTMLElement, status: HTMLElement, stage: HTMLElement, tools: HTMLElement, closeBtn: HTMLElement,
 *   onOpen?: (open: boolean) => void }} opts
 */
export function initSimulatorPane(opts) {
  const nop = { noteTool() {}, sync() {}, close() {} };
  if (!opts || !opts.chip || !opts.pane || !opts.stage) return nop;
  const { chip, pane, stage, status } = opts;
  let gen = 0;
  let streamCtl = null;
  let state = null;
  let recording = false;

  function stopStream() {
    if (streamCtl) { streamCtl.abort(); streamCtl = null; }
  }
  function setOpen(open) {
    const was = !pane.hidden;
    pane.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    if (!open) stopStream();
    else void follow();
    if (open !== was && opts.onOpen) opts.onOpen(open);
  }
  function paintDevices(devices, selected) {
    const sel = opts.device;
    if (!sel) return;
    const keep = sel.value;
    sel.replaceChildren();
    const list = Array.isArray(devices) ? devices : [];
    if (!list.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "No simulator";
      sel.append(o);
      return;
    }
    for (const d of list) {
      const o = document.createElement("option");
      o.value = d.udid;
      o.textContent = `${d.name} · ${d.state}`;
      sel.append(o);
    }
    const want = keep || selected || list[0].udid;
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  }
  // The stage already shows the unavailable or routed sentence, and the fixture banner
  // already labels a harness picture. Repeating that sentence in the status line stacks it twice.
  function setStatus(st) {
    if (!status) return;
    const repeated = !st || st.available === false || st.fixture === true || !!st.routedNote;
    const text = repeated ? "" : (st.note || "");
    status.textContent = text;
    status.hidden = !text;
  }
  function paint(st) {
    state = st;
    recording = !!st.recording;
    setStatus(st);
    paintDevices(st.devices, st.selected);
    if (opts.record) {
      opts.record.textContent = recording ? "Stop recording" : "Record a clip";
      opts.record.setAttribute("aria-pressed", String(recording));
    }
    let banner = pane.querySelector(".sim-banner");
    if (st.fixture === true) {
      if (!banner) {
        banner = document.createElement("p");
        banner.className = "sim-banner";
        banner.textContent = FIXTURE_BANNER;
        status?.insertAdjacentElement("afterend", banner);
      }
    } else if (banner) banner.remove();
    stage.replaceChildren();
    if (!st.available) {
      const p = document.createElement("p");
      p.className = "sim-unavailable";
      p.textContent = st.note || "";
      stage.append(p);
      return;
    }
    if (st.routedNote) {
      const p = document.createElement("p");
      p.className = "sim-unavailable";
      p.textContent = st.routedNote;
      stage.append(p);
      return;
    }
    const phone = document.createElement("div");
    phone.className = "sim-phone";
    const img = document.createElement("img");
    img.alt = st.fixture ? "Fixture iPhone screenshot" : "iOS Simulator";
    img.hidden = true;
    phone.append(img);
    stage.append(phone);
  }
  function showFrame(b64) {
    const img = stage.querySelector("img");
    if (!img || !b64) return;
    img.src = `data:image/jpeg;base64,${b64}`;
    img.hidden = false;
  }
  async function follow() {
    stopStream();
    const id = opts.currentId();
    if (!id || pane.hidden || !state?.available || state.routedNote) return;
    const ctl = streamCtl = new AbortController();
    let res;
    try {
      res = await fetch(`/sessions/${encodeURIComponent(id)}/simulator/stream`, { headers: opts.authHeaders(), signal: ctl.signal });
    } catch { return; }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ctl.signal.aborted) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = parseSseBlock(block);
          if (!ev) continue;
          if (ev.event === "frame") showFrame(ev.data.image);
          if (ev.event === "snapshot" || ev.event === "status") setStatus(ev.data);
        }
      }
    } catch { /* aborted */ }
  }
  async function refresh() {
    const ticket = ++gen;
    const id = opts.currentId();
    if (!id) { chip.hidden = true; setOpen(false); return; }
    let body;
    try { body = await opts.json(`/sessions/${encodeURIComponent(id)}/simulator`); }
    catch { if (ticket !== gen) return; chip.hidden = true; setOpen(false); return; }
    if (ticket !== gen || opts.currentId() !== id) return;
    chip.hidden = false;
    paint(body);
    if (!pane.hidden) void follow();
  }
  async function act(action, extra) {
    const id = opts.currentId();
    if (!id) return;
    const udid = opts.device?.value || undefined;
    try {
      const body = await opts.json(`/sessions/${encodeURIComponent(id)}/simulator`, {
        method: "POST",
        body: JSON.stringify({ action, ...(udid ? { udid } : {}), ...extra }),
      });
      if (body && body.routed) {
        paint({ ...(state || {}), available: false, note: body.note, routedNote: body.note, devices: state?.devices || [] });
        return;
      }
      paint(body.available === undefined ? { ...(state || {}), ...body } : body);
      if (!pane.hidden) void follow();
    } catch (e) {
      if (status) status.textContent = e.message || "That did not work.";
    }
  }

  chip.addEventListener("click", () => { setOpen(pane.hidden); if (!pane.hidden) void refresh(); });
  opts.closeBtn?.addEventListener("click", () => setOpen(false));
  opts.boot?.addEventListener("click", () => { void act("boot"); });
  opts.shutdown?.addEventListener("click", () => { void act("shutdown"); });
  opts.record?.addEventListener("click", () => { void act("record", { op: recording ? "stop" : "start" }); });

  return {
    noteTool() { void refresh(); },
    sync() { void refresh(); },
    close() { setOpen(false); },
  };
}
