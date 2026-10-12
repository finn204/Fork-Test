// =============================================================
// Persistent dashboard top bar.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// Self-injects the top bar (bell + Finance shortcut) and bottom
// tab bar. The bell button doubles as the push-notification
// opt-in: tap once to subscribe, tap again (once subscribed) to
// fire a test notification through /api/send-push.
// =============================================================
(function () {
  'use strict';

  // -------- CSS --------
  const css = `
/* Frosted bars, tinted with the page's colour (theme.css sets --tint). */
/* Full width and flush to the top, whatever padding the page's body has. */
body.has-topbar { padding-top: 0 !important; }
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 10px;
  margin: 0 calc(50% - 50vw) 16px;
  padding: max(10px, env(safe-area-inset-top)) 14px 8px;
  background: rgba(242, 242, 247, 0.78);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 0.5px solid rgba(60, 60, 67, 0.14);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-finance-btn, .topbar-bell-btn {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; padding: 0;
  border: 0; border-radius: 50%;
  background: rgba(var(--tint-rgb, 0, 122, 255), 0.12);
  color: var(--tint, #007AFF);
  text-decoration: none; cursor: pointer; font-family: inherit;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, transform 0.1s;
}
.topbar-finance-btn:hover, .topbar-bell-btn:hover { background: rgba(var(--tint-rgb, 0, 122, 255), 0.18); }
.topbar-finance-btn:active, .topbar-bell-btn:active { transform: scale(0.94); }
.topbar-icon { width: 20px; height: 20px; display: block; fill: currentColor; }
.topbar-bell-dot {
  position: absolute; top: 6px; right: 6px;
  width: 8px; height: 8px; border-radius: 50%;
  background: #34C759;
  box-shadow: 0 0 0 2px #FFFFFF;
  display: none;
}
.topbar-bell-btn.on .topbar-bell-dot { display: block; }
.topbar-bell-btn.busy { opacity: 0.6; pointer-events: none; }

/* Bottom tab bar, iOS style */
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px 0 calc(4px + env(safe-area-inset-bottom));
  background: rgba(249, 249, 249, 0.82);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  border-top: 0.5px solid rgba(60, 60, 67, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px;
  padding: 4px 0 2px;
  text-decoration: none;
  color: #7C7C80;
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.01em;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s;
}
.bottombar-tab-icon {
  width: 26px; height: 26px; display: block; fill: currentColor;
  transition: transform 0.10s;
}
.bottombar-tab.active { color: var(--tint, #007AFF); }
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }

/* Push page content above the fixed bottom bar */
body.has-bottombar {
  padding-bottom: calc(76px + env(safe-area-inset-bottom)) !important;
}

@media (max-width: 480px) {
  .topbar { padding-left: 10px; padding-right: 10px; gap: 8px; }
  .bottombar-tab-icon { width: 25px; height: 25px; }
}

/* === Global mobile lockdown ===
   1) Hide the right-side scrollbar on phones (iOS uses overlay scrollbars anyway).
   2) Stop iOS auto-text-size-adjust.
   3) touch-action: pan-y prevents pinch-zoom while still allowing vertical scroll.
   4) overscroll-behavior on every common modal class stops scroll chaining —
      scrolling inside a settings popup won't drag the page behind it.
   5) When body has .topbar-modal-open, the page can't scroll at all (locked).
*/
html, body {
  -webkit-text-size-adjust: 100%;
}
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer {
  overscroll-behavior: contain;
}
body.topbar-modal-open {
  overflow: hidden;
  touch-action: none;
}
/* On phones, blow the modals up to full screen and let them be the only
   scrolling element. Way less "is this scrolling the page or the modal?"
   confusion. */
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 100vh !important;
    height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
  }
}
`;

  // -------- HTML --------
  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <button class="topbar-bell-btn" id="topbarBell" type="button" aria-label="Notifications">
    <svg class="topbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
    <span class="topbar-bell-dot"></span>
  </button>
  <a href="finance.html" class="topbar-finance-btn" id="topbarFinance" aria-label="Finance">
    <svg class="topbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z"/></svg>
  </a>
</header>
`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="index.html" class="bottombar-tab" data-page="main">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    <span>Main</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.57 14.86 22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>
    <span>Fitness</span>
  </a>
  <a href="health.html" class="bottombar-tab" data-page="health">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 21.35-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
    <span>Health</span>
  </a>
  <a href="reminders.html" class="bottombar-tab" data-page="reminders">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 5.72-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM7.88 3.39 6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
    <span>Remind</span>
  </a>
  <a href="clients.html" class="bottombar-tab" data-page="clients">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
    <span>Clients</span>
  </a>
  <a href="trip.html" class="bottombar-tab" data-page="trip">
    <svg class="bottombar-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>
    <span>Trip</span>
  </a>
</nav>
`;

  // Pages where we suppress the app chrome: finance has its own internal
  // 4-tab bottom nav and self-contained back button.
  function isFinancePage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p.endsWith('/finance.html') || p.endsWith('finance.html');
  }
  // When the water tracker is iframed inside health.html, the embedded
  // page shouldn't render its own chrome again.
  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() {
    return !isFinancePage() && !isEmbedded();
  }
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('health.html')) return 'health';
    if (p.endsWith('gym.html')) return 'fitness';
    if (p.endsWith('reminders.html')) return 'reminders';
    if (p.endsWith('trip.html')) return 'trip';
    if (p.endsWith('clients.html')) return 'clients';
    return 'main'; // index.html, /, or anything else falls back to main
  }

  function injectStyleAndHTML() {
    if (document.getElementById('topbar') || document.getElementById('bottombar')) return;
    if (!shouldShowChrome()) return;

    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = css;
    document.head.appendChild(style);

    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml.trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);

    const bottomWrap = document.createElement('div');
    bottomWrap.innerHTML = bottombarHtml.trim();
    document.body.appendChild(bottomWrap.firstChild);

    // Highlight the active bottom tab.
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });

    // Reserve room above the fixed bottom bar so page content can scroll
    // past it without being hidden.
    document.body.classList.add('has-bottombar', 'has-topbar');
  }

  // -------- Active-date helpers (match the goals page 6 AM rollover) --------
  function activeDateKey() {
    const now = new Date();
    const d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // -------- Read progress from localStorage --------
  function getGoalsProgress() {
    const key = 'goals:' + activeDateKey();
    let goals = [];
    try { goals = JSON.parse(localStorage.getItem(key)) || []; } catch (e) {}
    const total = Array.isArray(goals) ? goals.length : 0;
    const done = total ? goals.filter(g => g && g.done).length : 0;
    return { done, total };
  }

  function getStackProgress() {
    let items = [];
    try { items = JSON.parse(localStorage.getItem('stack:items')) || []; } catch (e) {}
    let taken = {};
    try { taken = JSON.parse(localStorage.getItem('stack:taken:' + activeDateKey())) || {}; } catch (e) {}
    const total = Array.isArray(items) ? items.length : 0;
    const done = total ? items.filter(i => i && taken[i.id]).length : 0;
    return { done, total };
  }

  // -------- Mobile lockdown helpers --------
  // Belt-and-suspenders zoom prevention — iOS Safari sometimes ignores
  // user-scalable=no, so we also kill the gesture events directly.
  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    // Also kill the iOS double-tap-to-zoom on any tap.
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }

  // Watch every known modal-bg / overlay class — when any one of them
  // gets `.show` or `.is-open`, lock the body scroll. When the last
  // one closes, unlock.
  function startModalLock() {
    const MODAL_SELECTORS = [
      '.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam'
    ];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) {
            return true;
          }
        }
      }
      return false;
    }
    function sync() {
      document.body.classList.toggle('topbar-modal-open', anyOpen());
    }
    const observer = new MutationObserver(sync);
    // Observe class changes anywhere in body — modal toggles are rare so
    // a global subtree observer is cheap.
    observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], subtree: true
    });
    sync();
  }

  // -------- Push notifications --------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function getAuthToken() {
    if (window.dashAuthReady) { try { await window.dashAuthReady; } catch (e) {} }
    if (!window.dashAuth || !window.dashAuth.client) return null;
    try {
      const { data } = await window.dashAuth.client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch (e) { return null; }
  }

  async function getExistingSubscription() {
    if (!pushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return null;
      return await reg.pushManager.getSubscription();
    } catch (e) { return null; }
  }

  function setBellUI(on) {
    const btn = document.getElementById('topbarBell');
    if (btn) btn.classList.toggle('on', !!on);
  }

  async function refreshBellUI() {
    setBellUI(!!(await getExistingSubscription()));
  }

  async function subscribeToPush() {
    if (!pushSupported()) { alert("This browser doesn't support push notifications."); return; }
    const vapidKey = window.DASH_VAPID_PUBLIC_KEY;
    if (!vapidKey) { alert('Push notifications are not configured on the server yet.'); return; }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    const token = await getAuthToken();
    if (!token) { alert('Sign in to the dashboard first, then try again.'); return; }

    await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    setBellUI(true);
  }

  async function sendTestPush() {
    const token = await getAuthToken();
    if (!token) { alert('Sign in to the dashboard first, then try again.'); return; }
    const r = await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title: "Finn's Dashboard", body: 'Notifications are working 🎉', url: '/' }),
    });
    try {
      const j = await r.json();
      if (!r.ok) alert('Could not send: ' + (j.error || r.status));
    } catch (e) {}
  }

  function wireBell() {
    const btn = document.getElementById('topbarBell');
    if (!btn) return;
    refreshBellUI();
    btn.addEventListener('click', async () => {
      btn.classList.add('busy');
      try {
        const existing = await getExistingSubscription();
        if (existing) await sendTestPush();
        else await subscribeToPush();
      } finally {
        btn.classList.remove('busy');
      }
    });
  }

  // -------- Boot --------
  function boot() {
    injectStyleAndHTML();
    wireBell();
    lockGestures();
    startModalLock();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
