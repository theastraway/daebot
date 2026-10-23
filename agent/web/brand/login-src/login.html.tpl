<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sign in · Daebot</title>
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0c0b0a">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/png;base64,__FAV__" type="image/png">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/login.css">
</head>
<body class="login-body">
<main class="login">
  <section class="stage" aria-label="Daebot">
    <div class="stage-dots" aria-hidden="true"></div>
    <div class="ghost-m" aria-hidden="true"></div>
    <m-bot class="face" intro playful></m-bot>
    <div class="wm">__WORDMARK__<i class="wm-flame" aria-hidden="true"></i></div>
    <p class="stage-sub">Private agent. Every claim checked by the kernel.</p>
    <div class="powered"><span>Powered by</span><i class="mind-logo" role="img" aria-label="MIND"></i></div>
  </section>
  <section class="panel">
    <div class="login-card">
      <div class="tile" role="img" aria-label="Daebot"></div>
      <h1>Welcome back</h1>
      <p class="login-sub" id="login-sub">Sign in to continue.</p>
      <div class="login-group" id="mind-sign" hidden>
        <a class="btn-primary login-btn login-link" id="mind-oauth" href="/auth/mind/start" hidden>Sign in with MIND</a>
        <button class="btn-quiet login-btn login-alt" id="mind-switch" type="button" hidden>Use a different MIND account</button>
        <form id="key-form" autocomplete="off" novalidate>
          <label class="login-label" for="mind-key">Use a MIND API key</label>
          <input id="mind-key" name="mind-key" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="mind_...">
          <button class="btn-quiet login-btn login-alt" id="key-btn" type="submit">Continue with key</button>
        </form>
        <p class="login-hint">Daebot then reads and writes your own MIND, not anyone else's.</p>
      </div>
      <details class="login-owner" id="owner-box">
        <summary>Owner code</summary>
        <form id="login-form" autocomplete="off" novalidate>
          <label class="login-label" for="code">Access code</label>
          <input id="code" name="code" type="password" autocomplete="current-password" spellcheck="false" autocapitalize="off" required aria-describedby="login-err">
          <button class="btn-primary login-btn" id="login-btn" type="submit">Continue</button>
        </form>
      </details>
      <p class="err" id="login-err" role="alert" aria-live="polite" hidden></p>
    </div>
    <p class="login-foot">Sessions are private to your account. Sign out from the sidebar when you are done. <a class="login-foot-link" href="/download/">Download the desktop app</a></p>
  </section>
</main>
<script type="module" src="/brand/mbot.js"></script>
<script type="module" src="/login.js"></script>
</body>
</html>
