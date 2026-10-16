/* Sign-in screen. Everything it needs is inline (data: URIs / inline SVG) because hosted mode only
   serves /login.*, /style.css and /favicon.svg before a session exists. Tokens come from style.css. */
.login-body { overflow: auto; }
.login { min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, 1fr); }

/* stage: the black plate with the real LED face */
.stage { position: relative; isolation: isolate; overflow: hidden; background: #0c0b0a; color: #f6ead8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 40px 32px 96px; text-align: center; }
.stage::before { content: ""; position: absolute; inset: 0; z-index: -2; background: radial-gradient(60% 50% at 50% 38%, rgba(255,210,90,.16), transparent 70%), radial-gradient(40% 40% at 85% 100%, rgba(244,63,63,.16), transparent 70%); }
.stage-dots { position: absolute; inset: 0; z-index: -1; background: radial-gradient(circle, rgba(255,210,90,.34) 1.3px, transparent 1.8px) 0 0 / 20px 20px; -webkit-mask: linear-gradient(180deg, transparent 0, #000 22%, #000 42%, transparent 66%) 0 -100% / 100% 300%; mask: linear-gradient(180deg, transparent 0, #000 22%, #000 42%, transparent 66%) 0 -100% / 100% 300%; animation: sweep 7s ease-in-out infinite; opacity: .9; }
@keyframes sweep { 0% { -webkit-mask-position: 0 0; mask-position: 0 0; } 100% { -webkit-mask-position: 0 100%; mask-position: 0 100%; } }
.stage-dots::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle, rgba(255,255,255,.07) 1px, transparent 1.4px) 0 0 / 20px 20px; -webkit-mask: radial-gradient(70% 70% at 50% 50%, #000, transparent); mask: radial-gradient(70% 70% at 50% 50%, #000, transparent); }
.face { display: block; width: min(330px, 52vw); aspect-ratio: 1; cursor: pointer; filter: drop-shadow(0 0 46px rgba(255,210,90,.30)) drop-shadow(0 22px 28px rgba(0,0,0,.6)); animation: float 7s ease-in-out infinite; }
.face svg { width: 100%; height: 100%; overflow: visible; transform-origin: 50% 60%; }
@keyframes float { 50% { transform: translateY(-7px); } }
.wm { display: flex; align-items: flex-end; justify-content: center; margin-top: 34px; }
.wm-flame { flex: none; width: clamp(11px, 3.4vw, 16px); aspect-ratio: 112 / 133; margin: 0 0 .35em .3em; background: url("data:image/png;base64,__FLAME__") center / contain no-repeat; }
.wordmark { width: min(300px, 62vw); height: auto; color: #f6ead8; overflow: visible; }
.stage-sub { margin: 18px 0 0; font-size: 15px; color: #b9ad98; max-width: 34ch; text-wrap: balance; }
.ghost-m { position: absolute; z-index: -1; right: -120px; bottom: -120px; width: 420px; height: 420px; background: url("data:image/png;base64,__MGHOST__") center / contain no-repeat; opacity: .045; transform: rotate(-8deg); }
.tile { width: 56px; height: 56px; border-radius: 15px; background: url("data:image/png;base64,__TILE__") center / cover no-repeat; box-shadow: 0 0 0 1px var(--line), 0 12px 24px -12px rgba(0,0,0,.5); margin-bottom: 18px; }
.powered { position: absolute; left: 0; right: 0; bottom: 32px; display: flex; align-items: center; justify-content: center; gap: 12px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #a79c88; }
.mind-logo { display: block; width: 92px; height: 24px; background: url("data:image/png;base64,__MIND__") center / contain no-repeat; }

/* panel: themed */
.panel { border-left: 1px solid var(--line); display: grid; place-content: center; justify-items: center; gap: 22px; padding: 32px 20px; background: var(--bg); }
.login-card { width: min(380px, calc(100vw - 40px)); display: grid; gap: 10px; }
.login-card h1 { margin: 0; font: 700 34px/1.1 var(--sans); letter-spacing: -.035em; }
.login-sub { margin: 0 0 14px; color: var(--ink-2); font-size: 15px; }
.login-label { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
.login-card input { font: 15px var(--mono); padding: 13px 14px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); color: var(--ink); width: 100%; transition: border-color .15s, box-shadow .2s; }
.login-card input:focus-visible { outline: 0; border-color: var(--led-deep); box-shadow: 0 0 0 4px rgba(255,210,90,.25); }
.login-btn { margin-top: 8px; padding: 13px 14px; font-size: 15px; border-radius: 12px; background: #d92d2d; border-color: #d92d2d; color: #fff; font-weight: 650; box-shadow: 0 10px 22px -12px #d92d2d; transition: transform .15s; }
.login-group { display: grid; gap: 10px; }
.login-link { display: block; text-align: center; text-decoration: none; }
.login-alt { background: transparent; color: var(--ink); border-color: var(--line-strong); box-shadow: none; }
.login-hint { margin: 0; color: var(--ink-3); font-size: 12.5px; }
.login-owner { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.login-owner summary { cursor: pointer; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
.login-owner form { display: grid; gap: 10px; margin-top: 10px; }
#key-form { display: grid; gap: 8px; }
.login-btn:hover { transform: translateY(-1px); }
.login-btn[disabled] { opacity: .6; cursor: progress; }
.login-card .err { margin: 2px 0 0; min-height: 0; }
.login-foot { margin: 0; max-width: 380px; text-align: center; color: var(--ink-3); font-size: 12.5px; }

@media (max-width: 860px) {
  .panel { border-left: 0; border-top: 1px solid var(--line); }
  .ghost-m { right: -80px; bottom: -90px; width: 260px; height: 260px; }
  .login { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
  .stage { padding: 30px 20px 64px; }
  .face { width: 150px; }
  .wordmark { width: 190px; margin-top: 18px; }
  .stage-sub { margin-top: 10px; font-size: 14px; }
  .powered { bottom: 20px; }
  .mind-logo { width: 78px; height: 20px; }
  .panel { padding: 28px 20px 40px; align-content: start; }
  .login-card h1 { font-size: 28px; }
}
@media (prefers-reduced-motion: reduce) { .face, .stage-dots { animation: none !important; } .stage-dots { -webkit-mask-position: 0 40%; mask-position: 0 40%; } }
