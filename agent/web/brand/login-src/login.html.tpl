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
    <div class="face" role="img" aria-label="The M, Daebot's LED face"></div>
    __WORDMARK__
    <p class="stage-sub">Private agent. Every claim checked by the kernel.</p>
    <div class="powered"><span>Powered by</span><i class="mind-logo" role="img" aria-label="MIND"></i></div>
  </section>
  <section class="panel">
    <form class="login-card" id="login-form" autocomplete="off" novalidate>
      <div class="tile" role="img" aria-label="Daebot"></div>
      <h1>Welcome back</h1>
      <p class="login-sub">Enter your access code to continue.</p>
      <label class="login-label" for="code">Access code</label>
      <input id="code" name="code" type="password" autocomplete="current-password" spellcheck="false" autocapitalize="off" required aria-describedby="login-err" autofocus>
      <button class="btn-primary login-btn" id="login-btn" type="submit">Continue</button>
      <p class="err" id="login-err" role="alert" aria-live="polite" hidden></p>
    </form>
    <p class="login-foot">Sessions are private to this browser. Sign out from the sidebar when you are done.</p>
  </section>
</main>
<script type="module" src="/login.js"></script>
</body>
</html>
