// The first-run sign-in page, built as a data: URL so no file or server is needed. Its one inline script and one inline style are
// pinned in the page's CSP by sha256 (nothing else can run), and the page can only talk to main through window.daebotSignIn.submit.
import { createHash } from "node:crypto";

const STYLE = (dark) => `
:root{color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:${dark ? "#0c0b0a" : "#fbf6ee"};color:${dark ? "#f6ead8" : "#141211"};font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{width:min(380px,calc(100vw - 48px));display:grid;gap:12px}
h1{margin:0;font-size:30px;line-height:1.1;letter-spacing:-.035em}
.dot{color:#d92d2d}
p{margin:0;color:${dark ? "#bdb2a0" : "#4f4940"}}
form{display:grid;gap:10px}
label{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${dark ? "#8a806f" : "#857c6e"}}
input{font:15px ui-monospace,Menlo,Consolas,monospace;padding:13px 14px;border:1px solid ${dark ? "#38322c" : "#d6c7ab"};border-radius:12px;background:${dark ? "#171513" : "#fffdfa"};color:inherit;width:100%}
input:focus-visible{outline:0;border-color:#e8a900;box-shadow:0 0 0 4px rgba(255,210,90,.25)}
button{padding:13px 14px;font:650 15px inherit;border-radius:12px;border:1px solid #d92d2d;background:#d92d2d;color:#fff;cursor:pointer;box-shadow:0 10px 22px -12px #d92d2d}
button[disabled]{opacity:.6;cursor:progress}
.err{color:${dark ? "#ff5a52" : "#b42318"};font-size:13px}
.hint{font-size:12.5px;color:${dark ? "#8a806f" : "#857c6e"}}
[hidden]{display:none!important}`;

const SCRIPT = `
const f=document.getElementById("f"),i=document.getElementById("k"),b=document.getElementById("b"),e=document.getElementById("e");
f.addEventListener("submit",async(ev)=>{
  ev.preventDefault();
  e.hidden=true;b.disabled=true;b.textContent="Checking...";
  let r;
  try{r=await window.daebotSignIn.submit(i.value)}catch{r={ok:false,error:"Sign-in failed."}}
  if(r&&r.ok){b.textContent="Signed in";i.value="";return}
  e.textContent=(r&&r.error)||"Sign-in failed.";e.hidden=false;b.disabled=false;b.textContent="Continue";i.focus();
});
i.focus();`;

const sha = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export function buildSignInHtml({ dark = false } = {}) {
  const style = STYLE(dark);
  const csp = `default-src 'none'; style-src ${sha(style)}; script-src ${sha(SCRIPT)}; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Sign in to Daebot</title><style>${style}</style></head><body><main>
<h1>Daebot<span class="dot">.</span></h1>
<p>Paste your MIND API key to start. Daebot works inside your own MIND and bills your MIND account.</p>
<form id="f" autocomplete="off" novalidate>
<label for="k">MIND API key</label>
<input id="k" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="mind_...">
<button id="b" type="submit">Continue</button>
<p id="e" class="err" role="alert" hidden></p>
</form>
<p class="hint">Find it at m-i-n-d.ai under Settings, Developer, API Keys. It is stored on this computer only, in a private file.</p>
</main><script>${SCRIPT}</script></body></html>`;
  return html;
}

export const buildSignInPage = (o) => `data:text/html;charset=utf-8,${encodeURIComponent(buildSignInHtml(o))}`;
