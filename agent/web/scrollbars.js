// Scrollbars stay invisible until the user scrolls. Any element that scrolls gets `is-scrolling` for a moment,
// which the stylesheet uses to show a thin thumb; it fades back out shortly after scrolling stops.
const HIDE_AFTER_MS = 900;
const timers = new WeakMap();

export function initScrollbars(doc = document) {
  doc.addEventListener("scroll", (ev) => {
    const el = ev.target === doc ? doc.documentElement : ev.target;
    if (!el || !el.classList) return;
    el.classList.add("is-scrolling");
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove("is-scrolling"), HIDE_AFTER_MS));
  }, { capture: true, passive: true });
}
