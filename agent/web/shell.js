// Daebot touch-shell glue: the iPhone app (a Capacitor WKWebView on https://daebot.live) and mobile Safari.
// A classic script, loaded in <head> right after the viewport meta so it runs before first paint. No dependencies.
// It does four things, each guarded so desktop browsers and the Electron app are left exactly as they were:
//   1. marks the page (html.in-app, html.ios-app) so CSS can tell the app shell from a browser tab;
//   2. inside the iPhone app only, locks page zoom (Safari proper ignores that on purpose, WKWebView honours it);
//   3. on iOS WebKit, keeps the layout on the VISIBLE area when the on-screen keyboard is up (--vvh, --vvt, html.kb),
//      so the composer sits right above the keyboard and the top bar is never shoved out of sight;
//   4. a tap anywhere on the composer card focuses the message box (the box itself is shorter than a thumb).
(function () {
  "use strict";
  var w = window, d = document, root = d.documentElement, ua = navigator.userAgent || "";
  var cap = w.Capacitor;
  var handlers = w.webkit && w.webkit.messageHandlers;
  var iosApp = /DaebotApp\/ios/.test(ua) || !!(handlers && handlers.daebotAuth) ||
    !!(cap && typeof cap.getPlatform === "function" && cap.getPlatform() === "ios");
  var inApp = iosApp || /DaebotApp\//.test(ua);
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Daebot for Windows and Linux: no native title bar, so the page owns the top edge (html.win-overlay) and the OS draws only
  // the minimize / maximize / close buttons over it. --wco-right is the width of that button block.
  var desk = w.mindclawDesktop;
  if (desk && (desk.platform === "win32" || desk.platform === "linux") && desk.titleBar) {
    root.classList.add("win-overlay");
    var wco = navigator.windowControlsOverlay;
    var fitWco = function () {
      var r = wco && wco.getTitlebarAreaRect ? wco.getTitlebarAreaRect() : null;
      if (r && r.width > 0) root.style.setProperty("--wco-right", Math.max(0, Math.round(w.innerWidth - r.x - r.width)) + "px");
    };
    fitWco();
    if (wco && wco.addEventListener) wco.addEventListener("geometrychange", fitWco);
  }

  if (inApp) root.classList.add("in-app");
  if (iosApp) {
    root.classList.add("ios-app");
    var meta = d.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute("content", "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");
    // iOS reports a pinch as gesture events even when the meta tag forbids it; stop them at the source.
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
      d.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
    });
    // Zoom is locked, so the page has no business being scrolled sideways: put it back if anything ever moves it.
    w.addEventListener("scroll", function () { if (w.scrollX) w.scrollTo(0, w.scrollY); }, { passive: true });
  }

  // ---- the visible area (iOS only) ----
  var vv = w.visualViewport;
  if (ios && vv) {
    var idleH = 0; // visible height while no field is focused: what "no keyboard" looks like on this device
    var editing = function () {
      var a = d.activeElement;
      if (!a) return false;
      var t = a.tagName;
      return t === "TEXTAREA" || t === "SELECT" || (t === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(a.type)) || !!a.isContentEditable;
    };
    var last = "";
    var sync = function () {
      if (vv.scale > 1.01) { // pinch-zoomed in a browser tab: the visible box is smaller on purpose, leave the layout alone
        root.style.removeProperty("--vvh"); root.style.removeProperty("--vvt"); root.classList.remove("vv", "kb"); last = "";
        return;
      }
      var h = vv.height, t = Math.max(0, vv.offsetTop);
      if (!editing() || !idleH) idleH = h; // not typing: whatever is visible now is the no-keyboard size
      var kb = editing() && idleH - h > 120;
      var key = h + "|" + t + "|" + kb;
      if (key === last) return;
      last = key;
      root.style.setProperty("--vvh", h + "px");
      root.style.setProperty("--vvt", t + "px");
      root.classList.add("vv");
      root.classList.toggle("kb", kb);
      w.dispatchEvent(new CustomEvent("daebot:viewport", { detail: { keyboard: kb } }));
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    w.addEventListener("orientationchange", function () { idleH = 0; setTimeout(sync, 250); });
    d.addEventListener("focusin", function () { setTimeout(sync, 0); });
    d.addEventListener("focusout", function () { setTimeout(sync, 60); });
    sync();
  }

  // ---- composer: the whole card is the target ----
  d.addEventListener("click", function (e) {
    var c = e.target;
    if (c && c.classList && c.classList.contains("composer")) {
      var ta = c.querySelector("textarea");
      if (ta) ta.focus();
    }
  });
})();
