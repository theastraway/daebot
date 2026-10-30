// Pure helpers for fast chat switching (app.js owns the DOM and the network).

/** Insert or refresh `id` as the newest entry of a Map used as an LRU; the oldest entries beyond `max` are dropped. */
export function lruPut(map, id, value, max) {
  map.delete(id);
  map.set(id, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
}

/** A promise that follows `p` but rejects with an AbortError the moment `signal` aborts (the work behind `p` is not cancelled: other callers may share it). */
export function raceAbort(p, signal) {
  if (!signal) return p;
  const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  if (signal.aborted) return Promise.reject(abort());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abort());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/**
 * How much of a chat to build now. `total` items exist. Normally the newest `first` are built at once and the window of
 * `win` newest is filled in while idle; a chat that was left scrolled up (`mem` = { pinned, fromBottom, shown }) is rebuilt
 * whole to the size it had, so the reader lands exactly where they were.
 */
export function windowPlan({ total, mem, first, win }) {
  const away = !!(mem && !mem.pinned);
  const want = Math.min(total, Math.max(win, away ? mem.shown : 0));
  const tail = away ? want : Math.min(total, first);
  return { away, want, tailFrom: total - tail, fillTo: Math.max(0, total - want) };
}

/** Where the reader was: pinned to the newest message, or this far above it. */
export function scrollMemory({ scrollHeight, scrollTop, clientHeight, total, from }) {
  const fromBottom = Math.max(0, scrollHeight - scrollTop - clientHeight);
  return { pinned: fromBottom < 80, fromBottom, shown: total - (from || 0) };
}
