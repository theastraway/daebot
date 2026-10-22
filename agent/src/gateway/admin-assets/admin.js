(function () {
  "use strict";
  var page = document.body.getAttribute("data-page");
  var root = document.getElementById("root");
  var NS = "http://www.w3.org/2000/svg";
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else if (k === "text") e.textContent = attrs[k]; else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]); }
    function add(c) { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) { c.forEach(add); return; } e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c); }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return e;
  }
  function sv(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]); return e; }
  function api(path) { return fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (r) { if (r.status === 401 || r.status === 403) throw new Error("Admin sign-in required."); if (!r.ok) throw new Error("Request failed (" + r.status + ")."); return r.json(); }); }
  function day(iso) { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
  function nice(iso) { if (!iso) return "never"; return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }); }
  function ago(iso) { if (!iso) return "never"; var d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; }
  function weekStart(d) { var t = new Date(d + "T12:00:00Z"); return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); }
  function pct(x) { return x === null || x === undefined ? "n/a" : Math.round(x * 100) + "%"; }
  function nav(active) {
    return h("header", { class: "top" },
      h("a", { class: "brand", href: "/" }, h("span", { class: "dot" }), "Daebot admin"),
      h("nav", null, h("a", { href: "/admin/mistakes", class: active === "mistakes" ? "on" : "" }, "Mistake Log"), h("a", { href: "/admin/kpis", class: active === "kpis" ? "on" : "" }, "KPIs")));
  }
  function spark(vals, cls) {
    var w = 96, hh = 28, max = Math.max.apply(null, vals.concat([1])), bw = w / vals.length;
    var s = sv("svg", { viewBox: "0 0 " + w + " " + hh, width: w, height: hh, class: "spark " + (cls || ""), role: "img", "aria-label": "per week: " + vals.join(", ") });
    vals.forEach(function (v, i) { var bh = v ? Math.max(2, (v / max) * (hh - 2)) : 1; s.appendChild(sv("rect", { x: i * bw + 1, y: hh - bh, width: bw - 2, height: bh, rx: 1, class: v ? "bar" : "bar zero" })); });
    return s;
  }
  function fail(e) { root.textContent = ""; root.appendChild(h("div", { class: "err" }, e.message || String(e))); }

  /* ---------------- Mistake Log ---------------- */
  function mistakes() {
    var state = { q: "", product: "", agent: "", from: "", to: "", open: {} };
    var data = null;
    var list = h("div", { class: "types" });
    var stats = h("div", { class: "stats" });
    var fProduct = h("select", { "aria-label": "Product" }), fAgent = h("select", { "aria-label": "Agent" });
    var fQ = h("input", { type: "search", placeholder: "Search what happened, quotes, fixes", "aria-label": "Search" });
    var fFrom = h("input", { type: "date", "aria-label": "From" }), fTo = h("input", { type: "date", "aria-label": "To" });
    var timer = null;
    function pull() { state.q = fQ.value; state.product = fProduct.value; state.agent = fAgent.value; state.from = fFrom.value; state.to = fTo.value; load(); }
    function later() { clearTimeout(timer); timer = setTimeout(pull, 250); }
    fQ.addEventListener("input", later);
    [fProduct, fAgent, fFrom, fTo].forEach(function (e) { e.addEventListener("change", pull); });
    var clear = h("button", { class: "btn", type: "button", onclick: function () { fQ.value = ""; fProduct.value = ""; fAgent.value = ""; fFrom.value = ""; fTo.value = ""; pull(); } }, "Clear");
    function opts(sel, label, vals, cur) { sel.textContent = ""; sel.appendChild(h("option", { value: "" }, label)); vals.forEach(function (v) { sel.appendChild(h("option", { value: v, selected: v === cur ? "selected" : null }, v)); }); }
    function load() {
      var p = new URLSearchParams(); if (state.q) p.set("q", state.q); if (state.product) p.set("product", state.product); if (state.agent) p.set("agent", state.agent); if (state.from) p.set("from", state.from); if (state.to) p.set("to", state.to);
      api("/api/admin/mistakes?" + p.toString()).then(function (d) { data = d; render(); }).catch(fail);
    }
    function occCard(o) {
      return h("article", { class: "occ" },
        h("div", { class: "occ-h" }, h("strong", null, nice(o.when)), h("span", { class: "chip" }, o.agent), h("span", { class: "chip" }, o.product), o.estimated ? h("span", { class: "chip est", title: "Reconstructed from older records" }, "estimated") : null),
        h("p", { class: "what" }, o.what),
        o.quote ? h("blockquote", null, o.quote) : null,
        o.impact ? h("p", { class: "kv" }, h("b", null, "Impact "), o.impact) : null,
        o.fix ? h("p", { class: "kv" }, h("b", null, "Fix "), o.fix) : null,
        h("p", { class: "src" }, "Source: " + o.source, (o.links || []).length ? " | " : "", (o.links || []).map(function (l, i) { return /^https:\/\//.test(l) ? h("a", { href: l, target: "_blank", rel: "noopener noreferrer" }, "link " + (i + 1)) : h("span", null, l + (i < o.links.length - 1 ? ", " : "")); })));
    }
    function render() {
      var active = !!(state.q || state.product || state.agent || state.from || state.to);
      var by = {}; data.occurrences.forEach(function (o) { (by[o.type_id] = by[o.type_id] || []).push(o); });
      var rows = data.types.map(function (t) {
        var os = by[t.id] || [], weeks = data.summary.weeks, w = weeks.map(function () { return 0; });
        os.forEach(function (o) { var i = weeks.indexOf(weekStart(day(o.when))); if (i >= 0) w[i]++; });
        var times = os.map(function (o) { return Date.parse(o.when); });
        return { t: t, os: os, count: active ? os.length : t.count, w: w, last: times.length ? new Date(Math.max.apply(null, times)).toISOString() : t.last_seen };
      }).filter(function (r) { return !active || r.count > 0; }).sort(function (a, b) { return b.count - a.count || a.t.name.localeCompare(b.t.name); });
      var s = data.summary;
      stats.textContent = "";
      stats.appendChild(h("div", { class: "stat" }, h("span", { class: "n" }, s.total), h("span", { class: "l" }, "mistakes logged")));
      stats.appendChild(h("div", { class: "stat" }, h("span", { class: "n" }, s.this_week), h("span", { class: "l" }, "in the last 7 days")));
      stats.appendChild(h("div", { class: "stat wide" }, h("span", { class: "n" }, s.top_repeat ? s.top_repeat.count : 0), h("span", { class: "l" }, "top repeat: " + (s.top_repeat ? s.top_repeat.name : "none"))));
      stats.appendChild(h("div", { class: "stat" }, h("span", { class: "n" }, s.types), h("span", { class: "l" }, "mistake types")));
      opts(fProduct, "All products", data.products, state.product); opts(fAgent, "All agents", data.agents, state.agent);
      list.textContent = "";
      if (!rows.length) list.appendChild(h("p", { class: "empty" }, active ? "Nothing matches those filters." : "No mistakes logged yet."));
      rows.forEach(function (r) {
        var isOpen = !!state.open[r.t.id];
        var head = h("button", { class: "type-h", type: "button", "aria-expanded": isOpen ? "true" : "false", onclick: function () { state.open[r.t.id] = !state.open[r.t.id]; render(); } },
          h("span", { class: "big" }, r.count),
          h("span", { class: "tn" }, h("span", { class: "name" }, r.t.name), r.t.definition ? h("span", { class: "def" }, r.t.definition) : null),
          h("span", { class: "meta" }, h("span", null, "last seen " + ago(r.last)), spark(r.w)));
        var box = h("section", { class: "type" + (isOpen ? " open" : "") }, head);
        if (isOpen) {
          if (r.t.prevention) box.appendChild(h("p", { class: "prev" }, h("b", null, "Rule that should prevent it "), r.t.prevention));
          box.appendChild(h("p", { class: "prev" }, h("b", null, "First seen "), nice(r.os.length ? new Date(Math.min.apply(null, r.os.map(function (o) { return Date.parse(o.when); }))).toISOString() : r.t.first_seen), "  |  newest first, " + r.os.length + " shown"));
          r.os.forEach(function (o) { box.appendChild(occCard(o)); });
        }
        list.appendChild(box);
      });
    }
    root.appendChild(nav("mistakes"));
    root.appendChild(h("main", null, h("h1", null, "Mistake Log"), h("p", { class: "sub" }, "Every mistake, every time it happens. A count that keeps climbing is a rule that is not working."), stats,
      h("div", { class: "filters" }, fQ, fProduct, fAgent, h("label", null, "From", fFrom), h("label", null, "To", fTo), clear), list,
      h("p", { class: "foot" }, h("a", { href: "/admin/kpis" }, "Task KPIs: successes and prompts to satisfaction"))));
    load();
  }

  /* ---------------- KPIs ---------------- */
  function chart(trend) {
    var W = 640, H = 220, pl = 34, pr = 34, pt = 14, pb = 28, n = trend.length, bw = (W - pl - pr) / n;
    var maxV = Math.max.apply(null, trend.map(function (r) { return r.verified + r.failed; }).concat([1]));
    var maxP = Math.max.apply(null, trend.map(function (r) { return r.avg_prompts; }).concat([1]));
    var s = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "img", "aria-label": "Weekly verified tasks and average prompts" });
    for (var g = 0; g <= 4; g++) { var y = pt + (H - pt - pb) * g / 4; s.appendChild(sv("line", { x1: pl, x2: W - pr, y1: y, y2: y, class: "grid" })); var tx = sv("text", { x: pl - 6, y: y + 4, class: "ax", "text-anchor": "end" }); tx.textContent = Math.round(maxV * (1 - g / 4)); s.appendChild(tx); }
    var pts = [];
    trend.forEach(function (r, i) {
      var x = pl + i * bw + bw * 0.18, w = bw * 0.64, ch = H - pt - pb;
      var hv = r.verified / maxV * ch, hf = r.failed / maxV * ch;
      var tip = sv("title", {}); tip.textContent = "Week of " + r.week + ": " + r.verified + " verified, " + r.failed + " failed/abandoned, avg prompts " + r.avg_prompts;
      var grp = sv("g", {}, tip, sv("rect", { x: x, y: H - pb - hv, width: w, height: Math.max(hv, 0), class: "b-ok", rx: 2 }), sv("rect", { x: x, y: H - pb - hv - hf, width: w, height: Math.max(hf, 0), class: "b-bad", rx: 2 }));
      s.appendChild(grp);
      var lx = sv("text", { x: x + w / 2, y: H - 8, class: "ax", "text-anchor": "middle" }); lx.textContent = r.week.slice(5); s.appendChild(lx);
      if (r.verified) pts.push([x + w / 2, pt + (H - pt - pb) * (1 - r.avg_prompts / maxP)]);
    });
    if (pts.length > 1) s.appendChild(sv("polyline", { points: pts.map(function (p) { return p.join(","); }).join(" "), class: "line" }));
    pts.forEach(function (p) { s.appendChild(sv("circle", { cx: p[0], cy: p[1], r: 3, class: "dot-l" })); });
    var rl = sv("text", { x: W - pr + 6, y: pt + 4, class: "ax" }); rl.textContent = maxP.toFixed(1); s.appendChild(rl);
    return s;
  }

  /* ---------------- Anthony's messages: productive vs correcting/chasing ---------------- */
  function angerChart(trend) {
    var W = 640, H = 170, pl = 34, pr = 10, pt = 10, pb = 24, n = trend.length, bw = (W - pl - pr) / n;
    var s = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "img", "aria-label": "Daily share of Anthony's messages that were productive" });
    for (var g = 0; g <= 4; g++) { var y = pt + (H - pt - pb) * g / 4; s.appendChild(sv("line", { x1: pl, x2: W - pr, y1: y, y2: y, class: "grid" })); var tx = sv("text", { x: pl - 6, y: y + 4, class: "ax", "text-anchor": "end" }); tx.textContent = (100 - g * 25) + "%"; s.appendChild(tx); }
    var pts = [];
    trend.forEach(function (r, i) {
      var x = pl + i * bw + bw * 0.15, w = bw * 0.7, ch = H - pt - pb;
      var tip = sv("title", {}); tip.textContent = r.day + ": " + (r.pct === null ? "no messages" : Math.round(r.pct * 100) + "% productive, " + r.productive + " of " + r.total + " messages, " + r.chasers + " chasers, " + r.angry + " angry");
      var grp = sv("g", {}, tip);
      if (r.pct !== null) { var hv = r.pct * ch; grp.appendChild(sv("rect", { x: x, y: H - pb - hv, width: w, height: Math.max(hv, 1), class: "b-ok", rx: 2 })); if (r.pct < 1) grp.appendChild(sv("rect", { x: x, y: pt, width: w, height: ch - hv, class: "b-bad", rx: 2 })); pts.push([x + w / 2, H - pb - hv]); }
      s.appendChild(grp);
      if (i % 5 === 0 || i === n - 1) { var lx = sv("text", { x: x + w / 2, y: H - 7, class: "ax", "text-anchor": "middle" }); lx.textContent = r.day.slice(5); s.appendChild(lx); }
    });
    if (pts.length > 1) s.appendChild(sv("polyline", { points: pts.map(function (p) { return p.join(","); }).join(" "), class: "line" }));
    return s;
  }
  function angerCard(a) {
    var hd = a.headline;
    function cls(p) { return p === null ? "" : p >= 0.8 ? "good" : "bad"; }
    function t(w, label) { return h("div", { class: "tile " + cls(w.pct) }, h("span", { class: "n" }, pct(w.pct)), h("span", { class: "l" }, label), h("span", { class: "s" }, w.productive + " of " + w.total + " messages productive")); }
    var card = h("section", { class: "card", id: "anger" }, h("h2", null, "Anthony's messages: not spent correcting or chasing Dae"),
      h("p", { class: "sub" }, "Share of Anthony's messages that were an instruction or an answer. Chasers (status, go, where is it, did you), repeats, anger and mixed messages all count against it. Higher is better."));
    card.appendChild(h("div", { class: "tiles" }, t(hd.today, "today"), t(hd.d7, "last 7 days"), t(hd.d30, "last 30 days"),
      h("div", { class: "tile " + (hd.d7.chasers ? "bad" : "good") }, h("span", { class: "n" }, hd.d7.chasers), h("span", { class: "l" }, "chasers, last 7 days"), h("span", { class: "s" }, hd.d7.repeats + " repeats of an earlier ask; " + hd.d30.chasers + " in 30 days")),
      h("div", { class: "tile " + (hd.today.chasers ? "bad" : "good") }, h("span", { class: "n" }, hd.today.chasers), h("span", { class: "l" }, "chasers today"), h("span", { class: "s" }, hd.today.counts.anger + " angry, " + hd.today.counts.mixed + " mixed today"))));
    card.appendChild(h("p", { class: "sub" }, "Daily trend, last 30 days. Green is productive, red is correcting or chasing. Line follows the productive share."));
    card.appendChild(angerChart(a.trend));
    card.appendChild(h("h3", { class: "h3" }, "Per session (last 30 days)"));
    var rows = a.sessions.map(function (x) {
      return h("tr", null, h("td", { class: "tt" }, x.title), h("td", null, nice(x.last)), h("td", { class: "num" }, x.total), h("td", { class: "num" }, pct(x.pct)), h("td", { class: "num" }, x.chasers), h("td", { class: "num" }, x.repeats), h("td", { class: "num" }, x.anger), h("td", { class: "num" }, x.mixed));
    });
    card.appendChild(h("div", { class: "scroll" }, h("table", null, h("thead", null, h("tr", null, ["Session", "Last message", "Messages", "Productive", "Chasers", "Repeats", "Anger", "Mixed"].map(function (c) { return h("th", null, c); }))), h("tbody", null, rows))));
    if (!a.sessions.length) card.appendChild(h("p", { class: "empty" }, "No messages uploaded yet."));
    card.appendChild(h("h3", { class: "h3" }, "20 labeled examples (so the classifier can be audited)"));
    a.examples.forEach(function (e) {
      card.appendChild(h("div", { class: "row ex" }, h("span", { class: "chip lab lab-" + e.label }, e.label), h("span", { class: "rt" }, e.text || "(empty)", e.repeat ? h("span", { class: "chip bad" }, "repeat") : null), h("span", { class: "meta" }, nice(e.ts), h("span", null, e.session + (e.reasons.length ? " | " + e.reasons.join(", ") : "")))));
    });
    card.appendChild(h("p", { class: "foot" }, a.method + " Updated " + (a.updated_at ? new Date(a.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET" : "never") + "; " + a.stored + " messages stored."));
    return card;
  }
  function kpis() {
    var state = { status: "", product: "", q: "" }, data = null, anger = null, timer = null;
    var body = h("div", null);
    function load() {
      var p = new URLSearchParams(); if (state.status) p.set("status", state.status); if (state.product) p.set("product", state.product); if (state.q) p.set("q", state.q);
      Promise.all([api("/api/admin/tasks?" + p.toString()), api("/api/admin/anger").catch(function () { return null; })]).then(function (r) { data = r[0]; anger = r[1]; render(); }).catch(fail);
    }
    function tile(n, l, cls, sub) { return h("div", { class: "tile " + (cls || "") }, h("span", { class: "n" }, n), h("span", { class: "l" }, l), sub ? h("span", { class: "s" }, sub) : null); }
    function render() {
      var k = data.kpis, focus = document.activeElement && document.activeElement.id;
      body.textContent = "";
      if (anger) body.appendChild(angerCard(anger));
      body.appendChild(h("div", { class: "tiles" },
        tile(k.verified_today, "verified today"), tile(k.verified_week, "verified, last 7 days"), tile(k.verified_all, "verified, all time"),
        tile(pct(k.success_rate), "success rate", "", k.verified_all + " of " + k.closed + " closed tasks"),
        tile(k.median_prompts, "median prompts to satisfaction", "", "average " + k.avg_prompts),
        tile(k.one_prompt, "done in 1 prompt", "good", k.two_prompts + " took 2"),
        tile(k.three_plus, "took 3 or more prompts", k.three_plus ? "bad" : "good"),
        tile(k.open_over_24h, "open longer than 24h (defects)", k.open_over_24h ? "bad" : "good", k.open_total + " open in total"),
        tile(k.angry, "tasks with an angry message", k.angry ? "bad" : "good")));
      body.appendChild(h("section", { class: "card" }, h("h2", null, "Weekly trend"), h("p", { class: "sub" }, "Bars: tasks closed per week (green verified, red failed or abandoned). Line: average prompts to satisfaction."), chart(data.trend)));
      var re = h("section", { class: "card" }, h("h2", null, "Most re-asked"));
      if (!data.top_reasked.length) re.appendChild(h("p", { class: "empty" }, "No repeats recorded."));
      data.top_reasked.forEach(function (t) { re.appendChild(h("div", { class: "row" }, h("span", { class: "big sm" }, t.repeats), h("span", { class: "rt" }, t.title, h("span", { class: "chip" }, t.product)), h("span", { class: "meta" }, t.prompts + " prompts, " + t.status))); });
      body.appendChild(re);
      var st = h("section", { class: "card" }, h("h2", null, "Open longer than 24 hours"));
      if (!data.stale.length) st.appendChild(h("p", { class: "empty" }, "None. Nothing is sitting open past a day."));
      data.stale.forEach(function (t) { st.appendChild(h("div", { class: "row" }, h("span", { class: "rt" }, t.title, h("span", { class: "chip" }, t.product)), h("span", { class: "meta bad" }, "asked " + ago(t.requested_at)))); });
      body.appendChild(st);
      var fq = h("input", { id: "tq", type: "search", placeholder: "Search tasks", value: state.q, "aria-label": "Search tasks" });
      fq.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { state.q = fq.value; load(); }, 250); });
      var fs = h("select", { "aria-label": "Status" }, h("option", { value: "" }, "All statuses"), ["open", "done-verified", "failed", "abandoned"].map(function (s) { return h("option", { value: s, selected: s === state.status ? "selected" : null }, s); }));
      fs.addEventListener("change", function () { state.status = fs.value; load(); });
      var fp = h("select", { "aria-label": "Product" }, h("option", { value: "" }, "All products"), data.products.map(function (s) { return h("option", { value: s, selected: s === state.product ? "selected" : null }, s); }));
      fp.addEventListener("change", function () { state.product = fp.value; load(); });
      var tbl = h("table", null, h("thead", null, h("tr", null, ["Task", "Product", "Asked", "Status", "Prompts", "Re-asks", "Verified on"].map(function (c) { return h("th", null, c); }))),
        h("tbody", null, data.tasks.map(function (t) {
          return h("tr", { class: t.stale ? "stale" : "" }, h("td", { class: "tt" }, t.title, t.anger_flag ? h("span", { class: "chip bad" }, "angry") : null, t.estimated ? h("span", { class: "chip est", title: "Backfilled from transcripts by heuristic" }, "estimated") : null),
            h("td", null, t.product), h("td", null, nice(t.requested_at)), h("td", null, h("span", { class: "st st-" + t.status }, t.status)), h("td", { class: "num" }, t.prompts_to_satisfaction), h("td", { class: "num" }, t.repeats), h("td", { class: "vo" }, t.verified_on || ""));
        })));
      body.appendChild(h("section", { class: "card" }, h("h2", null, "Tasks"), h("div", { class: "filters" }, fq, fs, fp), h("div", { class: "scroll" }, tbl), data.tasks.length ? null : h("p", { class: "empty" }, "No tasks match."), k.estimated ? h("p", { class: "foot" }, k.estimated + " of " + k.total_tasks + " tasks are estimated (backfilled from session transcripts by heuristic); live rows come from log-task.sh.") : null));
      if (focus === "tq") { var el = document.getElementById("tq"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    }
    root.appendChild(nav("kpis"));
    root.appendChild(h("main", null, h("h1", null, "Task KPIs"), h("p", { class: "sub" }, "Tasks completed and verified, and how many prompts Anthony needed before he was satisfied."), body, h("p", { class: "foot" }, h("a", { href: "/admin/mistakes" }, "Mistake Log"))));
    load();
  }
  if (page === "mistakes") mistakes(); else if (page === "kpis") kpis();
})();
