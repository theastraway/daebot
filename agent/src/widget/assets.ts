// Static pieces of the public website widget: the embed script (/widget.js) and the chat panel page (/widget).
// Everything is a plain string so the widget needs no build step and no files besides the mascot PNG.

/** The embed script. It reads its own origin from the <script src>, so the same file works for any deployment. */
export const WIDGET_JS = String.raw`(function () {
  "use strict";
  var HOST_ID = "astra-daebot-widget";
  if (document.getElementById(HOST_ID)) return;
  var script = document.currentScript;
  var origin;
  try { origin = new URL(script && script.src).origin; } catch (e) { return; }

  var host = document.createElement("div");
  host.id = HOST_ID;
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box}' +
    '.btn{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;border:2px solid #fff;background:#000;padding:0;cursor:pointer;z-index:2147483000;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .15s ease,box-shadow .15s ease}' +
    '.btn:hover{transform:scale(1.06)}' +
    '.btn:focus-visible,.x:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #000}' +
    '.btn img{width:44px;height:44px;object-fit:contain;display:block;pointer-events:none}' +
    '.panel{position:fixed;right:24px;bottom:calc(96px + env(safe-area-inset-bottom,0px));width:380px;height:min(560px,calc(100vh - 120px));background:#fff;border:1px solid #000;border-radius:16px;overflow:hidden;z-index:2147483001;box-shadow:0 18px 60px rgba(0,0,0,.4);display:none;flex-direction:column;opacity:0;transform:translateY(8px) scale(.98);transition:opacity .16s ease,transform .16s ease}' +
    '.panel.open{display:flex}' +
    '.panel.show{opacity:1;transform:none}' +
    '.bar{flex:none;height:44px;background:#000;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.x{width:36px;height:36px;border:0;border-radius:8px;background:transparent;color:#fff;font:400 24px/1 sans-serif;cursor:pointer}' +
    '.x:hover{background:#222}' +
    'iframe{flex:1;width:100%;border:0;background:#fff}' +
    '@media (max-width:639px){.panel{inset:0;width:100%;height:100%;border:0;border-radius:0;box-shadow:none}.bar{height:52px;padding-top:env(safe-area-inset-top,0px)}}' +
    '@media (prefers-reduced-motion:reduce){.btn,.panel{transition:none}.btn:hover{transform:none}}' +
    '</style>' +
    '<button class="btn" type="button" aria-label="Open chat with Daebot" aria-expanded="false" aria-controls="p"><img alt="" src="' + origin + '/brand/daebot-avatar.png"></button>' +
    '<div class="panel" id="p" role="dialog" aria-label="Chat with Daebot"><div class="bar"><span>Daebot for Astra AI</span><button class="x" type="button" aria-label="Close chat">&times;</button></div></div>';

  var btn = root.querySelector(".btn");
  var panel = root.querySelector(".panel");
  var close = root.querySelector(".x");
  var frame = null;
  var isOpen = false;

  function open() {
    if (isOpen) return;
    isOpen = true;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = "Daebot chat";
      frame.setAttribute("allow", "");
      frame.src = origin + "/widget";
      panel.appendChild(frame);
    }
    panel.classList.add("open");
    requestAnimationFrame(function () { panel.classList.add("show"); });
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close chat with Daebot");
    try { frame.focus(); } catch (e) {}
  }
  function shut() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove("show");
    panel.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open chat with Daebot");
    try { btn.focus(); } catch (e) {}
  }

  btn.addEventListener("click", function () { if (isOpen) shut(); else open(); });
  close.addEventListener("click", shut);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen) shut(); });
  window.addEventListener("message", function (e) {
    if (e.origin === origin && frame && e.source === frame.contentWindow && e.data && e.data.type === "daebot-widget-close") shut();
  });

  document.body.appendChild(host);
})();
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The chat panel page (shown in the iframe). Black and white; text is always inserted with textContent. */
export function panelHtml(nonce: string, personaName: string, maxInput: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(personaName)} for Astra AI</title>
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:#fff;color:#000;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#log{flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:10px}
.m{max-width:88%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.u{align-self:flex-end;background:#000;color:#fff;border-bottom-right-radius:4px}
.b{align-self:flex-start;background:#f2f2f2;color:#000;border-bottom-left-radius:4px}
.b a{color:#000;text-decoration:underline}
.b.err{background:#fff;border:1px solid #000}
.dots::after{content:"...";animation:d 1s steps(4,end) infinite}@keyframes d{0%{content:""}33%{content:"."}66%{content:".."}100%{content:"..."}}
form{flex:none;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid #000;background:#fff}
textarea{flex:1;resize:none;border:1px solid #000;border-radius:12px;padding:9px 11px;font:inherit;max-height:96px;background:#fff;color:#000}
textarea:focus-visible,button:focus-visible{outline:3px solid #000;outline-offset:2px}
button{flex:none;border:0;border-radius:12px;background:#000;color:#fff;padding:0 16px;font:600 14px/1 inherit;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
small{display:block;text-align:center;font-size:11px;color:#555;padding:0 12px 8px}
@media (prefers-reduced-motion:reduce){.dots::after{animation:none;content:"..."}}
</style></head>
<body data-name="${esc(personaName)}" data-max="${maxInput}">
<div id="log" role="log" aria-live="polite"></div>
<form id="f" autocomplete="off"><textarea id="t" rows="1" maxlength="${maxInput}" placeholder="Ask about Astra AI or MIND" aria-label="Your message"></textarea><button id="s" type="submit">Send</button></form>
<small>AI assistant. Answers come from Astra AI's knowledge base.</small>
<script nonce="${nonce}">
(function(){
  var name=document.body.dataset.name, max=+document.body.dataset.max;
  var log=document.getElementById("log"), f=document.getElementById("f"), t=document.getElementById("t"), s=document.getElementById("s");
  var sid="", busy=false, urlRe=/(https?:\\/\\/[^\\s)]+)/g;
  function fill(el,text){
    el.textContent="";
    text.split(urlRe).forEach(function(p,i){
      if(i%2===1){var a=document.createElement("a");a.href=p;a.target="_blank";a.rel="noopener noreferrer";a.textContent=p;el.appendChild(a);}
      else if(p){el.appendChild(document.createTextNode(p));}
    });
  }
  function add(cls,text){var d=document.createElement("div");d.className="m "+cls;fill(d,text);log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
  add("b","Hi, I'm "+name+" for Astra AI. Ask me about Astra AI or MIND.");
  t.addEventListener("input",function(){t.style.height="auto";t.style.height=Math.min(t.scrollHeight,96)+"px";});
  t.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){try{parent.postMessage({type:"daebot-widget-close"},"*");}catch(x){}}});
  f.addEventListener("submit",function(e){
    e.preventDefault();
    var text=t.value.trim();
    if(!text||busy)return;
    if(text.length>max){add("b err","Please keep messages under "+max+" characters.");return;}
    busy=true;s.disabled=true;t.value="";t.style.height="auto";
    add("u",text);
    var bot=add("b dots","");
    var got="";
    fetch("/api/widget/turn",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:text,sessionId:sid||undefined})})
    .then(function(r){
      if(!r.ok){return r.json().catch(function(){return {};}).then(function(j){throw new Error(j.error||"Something went wrong. Please try again.");});}
      var rd=r.body.getReader(),dec=new TextDecoder(),buf="";
      function pump(){
        return rd.read().then(function(x){
          if(x.done)return;
          buf+=dec.decode(x.value,{stream:true});
          var i;
          while((i=buf.indexOf("\\n\\n"))>=0){
            var chunk=buf.slice(0,i);buf=buf.slice(i+2);
            chunk.split("\\n").forEach(function(line){
              if(line.indexOf("data:")!==0)return;
              var ev;try{ev=JSON.parse(line.slice(5));}catch(z){return;}
              if(ev.type==="session")sid=ev.sessionId;
              else if(ev.type==="text"){got+=ev.delta;bot.className="m b";fill(bot,got);log.scrollTop=log.scrollHeight;}
              else if(ev.type==="error"){throw new Error(ev.message);}
            });
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function(err){bot.className="m b err";fill(bot,got||String(err&&err.message||"Something went wrong. Please try again."));})
    .then(function(){if(bot.className.indexOf("dots")>=0){bot.className="m b err";fill(bot,"No answer came back. Please try again.");}busy=false;s.disabled=false;t.focus();});
  });
  t.focus();
})();
</script></body></html>`;
}
