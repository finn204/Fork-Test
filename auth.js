/* =============================================================
   auth.js — signs the dashboard in to Supabase.

   Loaded before sync.js on every page. supabase-js persists the
   session in localStorage under the same storage key, so every
   client created afterwards (sync.js, gym.html photos) picks it
   up automatically and talks to the database as the logged-in
   user rather than as the public anon role.

   While signed out, a full-screen gate covers the page.
   ============================================================= */
(function () {
  'use strict';

  var URL_ = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || '';
  var KEY_ = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || '';
  if (!URL_ || !KEY_ || !window.supabase) return;

  var client = window.supabase.createClient(URL_, KEY_);
  window.dashAuth = { client: client, user: null };

  var CSS = ''
    + '#authGate{position:fixed;inset:0;z-index:99999;background:#050506;display:flex;'
    + 'align-items:center;justify-content:center;padding:24px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;}'
    + '#authGate,#authGate *{box-sizing:border-box;}'
    + '#authGate .ag-box{width:100%;max-width:340px;}'
    + '#authGate h1{font-size:26px;font-weight:700;color:#FAFAFA;margin:0 0 6px;letter-spacing:-0.02em;}'
    + '#authGate p.ag-sub{font-size:14px;color:#76746E;margin:0 0 22px;line-height:1.45;}'
    + '#authGate label{display:block;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;'
    + 'color:#76746E;font-weight:600;margin:0 0 6px;}'
    + '#authGate input{width:100%;background:#0E0E10;border:1px solid #26262C;border-radius:12px;'
    + 'padding:13px 14px;color:#FAFAFA;font-size:16px;font-family:inherit;margin:0 0 14px;}'
    + '#authGate input:focus{outline:none;border-color:#6BE3A4;}'
    + '#authGate button.ag-go{width:100%;background:#6BE3A4;color:#06110B;border:none;border-radius:12px;'
    + 'padding:14px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;}'
    + '#authGate button.ag-go:disabled{opacity:.5;cursor:default;}'
    + '#authGate .ag-alt{background:none;border:none;color:#76746E;font-size:13px;font-family:inherit;'
    + 'cursor:pointer;padding:14px 0 0;width:100%;text-align:center;}'
    + '#authGate .ag-alt b{color:#6BE3A4;font-weight:600;}'
    + '#authGate .ag-msg{font-size:13px;line-height:1.45;margin:14px 0 0;color:#FF9F7A;}'
    + '#authGate .ag-msg.ok{color:#6BE3A4;}';

  var gate, mode = 'in';

  function build() {
    var st = document.createElement('style'); st.textContent = CSS;
    document.head.appendChild(st);

    gate = document.createElement('div');
    gate.id = 'authGate';
    gate.innerHTML =
      '<div class="ag-box">'
      + '<h1>Finn\'s Dashboard</h1>'
      + '<p class="ag-sub" id="agSub">Sign in to load your data.</p>'
      + '<label for="agEmail">Email</label>'
      + '<input id="agEmail" type="email" autocomplete="username" inputmode="email" autocapitalize="none">'
      + '<label for="agPass">Password</label>'
      + '<input id="agPass" type="password" autocomplete="current-password">'
      + '<button class="ag-go" id="agGo" type="button">Sign in</button>'
      + '<button class="ag-alt" id="agAlt" type="button">First time? <b>Create your account</b></button>'
      + '<p class="ag-msg" id="agMsg"></p>'
      + '</div>';
    document.body.appendChild(gate);

    document.getElementById('agGo').addEventListener('click', submit);
    document.getElementById('agPass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
    });
    document.getElementById('agAlt').addEventListener('click', function () {
      mode = (mode === 'in') ? 'up' : 'in';
      document.getElementById('agGo').textContent = mode === 'in' ? 'Sign in' : 'Create account';
      document.getElementById('agSub').textContent = mode === 'in'
        ? 'Sign in to load your data.'
        : 'Pick a password you will remember. There is no reset set up.';
      document.getElementById('agAlt').innerHTML = mode === 'in'
        ? 'First time? <b>Create your account</b>'
        : 'Already set up? <b>Sign in</b>';
      msg('');
    });
  }

  function msg(text, ok) {
    var el = document.getElementById('agMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ag-msg' + (ok ? ' ok' : '');
  }

  async function submit() {
    var email = (document.getElementById('agEmail').value || '').trim();
    var pass = document.getElementById('agPass').value || '';
    if (!email || !pass) { msg('Email and password, both.'); return; }

    var btn = document.getElementById('agGo');
    btn.disabled = true;
    btn.textContent = mode === 'in' ? 'Signing in…' : 'Creating…';
    try {
      var res = mode === 'in'
        ? await client.auth.signInWithPassword({ email: email, password: pass })
        : await client.auth.signUp({ email: email, password: pass });

      if (res.error) {
        msg(res.error.message);
      } else if (mode === 'up' && res.data && res.data.user && !res.data.session) {
        msg('Account made. Check your email to confirm it, then sign in.', true);
      } else if (res.data && res.data.session) {
        location.reload();
        return;
      } else {
        msg('Something went wrong. Try again.');
      }
    } catch (e) {
      msg('Could not reach the server. Check your connection.');
    }
    btn.disabled = false;
    btn.textContent = mode === 'in' ? 'Sign in' : 'Create account';
  }

  window.dashSignOut = function () {
    client.auth.signOut().then(function () { location.reload(); });
  };

  /* Block until we know whether there is a session. */
  var ready = client.auth.getSession().then(function (res) {
    var session = res && res.data && res.data.session;
    if (session) { window.dashAuth.user = session.user; return true; }
    function show() { if (!gate) build(); }
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
    return false;
  });
  window.dashAuthReady = ready;
})();
