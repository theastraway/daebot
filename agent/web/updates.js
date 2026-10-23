// "A newer Daebot is available" for every surface that is not a desktop app (the desktop app updates itself natively).
//   web      : the gateway reports the deploy it is running (/health build). When it changes under an open tab, offer a refresh.
//   Android  : the sideloaded APK reads /download/android-latest.json and, on Update, hands the APK link to the native installer.
//   iPhone   : /download/ios-latest.json names the newest TestFlight or App Store build; if it is ahead of this one, say so.
// No innerHTML; every node is built with createElement / textContent. Pure decision logic is exported for tests.

const CHECK_MS = 5 * 60_000;
const IOS_UA = /DaebotApp\/ios ([\d.]+) \((\d+)\)/;
const IOS_FALLBACK = { version: "1.0.0", build: 3 }; // the first TestFlight build did not report itself

export function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0), pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

export function webUpdate(loadedBuild, nowBuild) {
  return !!loadedBuild && !!nowBuild && loadedBuild !== "dev" && nowBuild !== "dev" && loadedBuild !== nowBuild;
}

export function androidUpdate(installed, feed) {
  if (!installed || !feed || !Number.isInteger(feed.versionCode)) return null;
  return feed.versionCode > Number(installed.versionCode) ? { version: feed.version, url: feed.url, sha256: feed.sha256 } : null;
}

export function parseIosInstalled(ua) {
  const m = IOS_UA.exec(ua || "");
  return m ? { version: m[1], build: Number(m[2]) } : IOS_FALLBACK;
}

export function iosUpdate(installed, feed) {
  if (!installed || !feed || !Number.isInteger(feed.build)) return null;
  const v = cmpVersion(feed.version, installed.version);
  if (v < 0 || (v === 0 && feed.build <= installed.build)) return null;
  const url = typeof feed.url === "string" && /^https:\/\//.test(feed.url) ? feed.url : null;
  return url ? { version: feed.version, build: feed.build, url, channel: feed.channel === "App Store" ? "the App Store" : "TestFlight" } : null;
}

function banner() {
  let b = document.getElementById("update-banner");
  if (b) return b;
  b = document.createElement("div");
  b.id = "update-banner";
  b.className = "update-banner";
  b.setAttribute("role", "status");
  b.hidden = true;
  document.body.append(b);
  return b;
}

function show(text, actionLabel, onAction, href) {
  const b = banner();
  b.replaceChildren();
  const t = document.createElement("span"); t.className = "ub-text"; t.textContent = text; b.append(t);
  if (actionLabel) {
    const a = document.createElement(href ? "a" : "button");
    a.className = "ub-action"; a.textContent = actionLabel;
    if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener"; } else { a.type = "button"; a.addEventListener("click", onAction); }
    b.append(a);
  }
  const x = document.createElement("button"); x.type = "button"; x.className = "ub-dismiss"; x.setAttribute("aria-label", "Dismiss"); x.textContent = "×";
  x.addEventListener("click", () => { b.hidden = true; });
  b.append(x);
  b.hidden = false;
  return t;
}

const seen = new Set();
const once = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };
const getJson = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function initUpdates({ win = window } = {}) {
  let loaded = null;
  const checkWeb = async () => {
    try {
      const h = await getJson("/health");
      if (loaded === null) { loaded = h.build || ""; return; }
      if (webUpdate(loaded, h.build) && once(`web:${h.build}`)) show("Daebot was just updated.", "Refresh", () => win.location.reload());
    } catch { /* offline or mid-deploy: try again later */ }
  };

  const android = win.DaebotAndroid;
  const checkAndroid = async () => {
    try {
      const installed = JSON.parse(android.getVersion());
      const up = androidUpdate(installed, await getJson("/download/android-latest.json"));
      if (!up || !once(`android:${up.version}`)) return;
      const label = show(`Daebot ${up.version} is ready to install.`, "Update", () => {
        label.textContent = "Downloading the update...";
        try { android.downloadAndInstall(up.url, up.sha256); } catch { label.textContent = "Could not start the update. Try again later."; }
      });
    } catch { /* not the Android app, or feed unavailable */ }
  };
  win.addEventListener("daebot-update-progress", (e) => {
    const d = e.detail || {}, t = document.querySelector("#update-banner .ub-text");
    if (!t) return;
    t.textContent = d.state === "downloading" ? `Downloading the update... ${Math.round(d.pct || 0)}%`
      : d.state === "verifying" ? "Checking the download..." : d.state === "installing" ? "Opening the installer..." : d.state === "error" ? (d.message || "The update failed.") : t.textContent;
  });

  const isIos = win.Capacitor?.getPlatform?.() === "ios";
  const checkIos = async () => {
    try {
      const up = iosUpdate(parseIosInstalled(win.navigator.userAgent), await getJson("/download/ios-latest.json"));
      if (up && once(`ios:${up.version}.${up.build}`)) show(`Daebot ${up.version} (${up.build}) is available on ${up.channel}.`, "Open", null, up.url);
    } catch { /* feed unavailable */ }
  };

  const run = () => { checkWeb(); if (android?.getVersion) checkAndroid(); if (isIos) checkIos(); };
  run();
  setInterval(run, CHECK_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") run(); });
}
