// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="auth.js"></script>
//   <script src="sync.js"></script>
//
// Rules this file exists to enforce:
//   1. Nothing touches the database until auth.js has restored the
//      session. RLS only answers to `authenticated`, so a read fired
//      during that gap comes back empty — which is NOT the same as
//      "no data yet", and must never be treated as such.
//   2. A push only ever rewrites the keys this instance owns. Several
//      pages share one row with different key lists; a full-row write
//      from the narrow one would erase the wide one's keys.
//   3. An edit made on this device is never thrown away because the
//      save failed. Every local edit sets a "dirty" marker that only a
//      successful write clears. While it is set, the cloud copy is not
//      allowed to overwrite this device — the edit is pushed instead.
//      Before this, a phone whose save failed (stale login after the
//      app sat in the background, no signal, an edit made in the first
//      second before sync connected) would quietly get its edit
//      reverted by the older cloud copy on the next open.
//   4. A failed save is visible. A pill says "Not saved" and retries.
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  // ---- One status pill per page, shared by every instance on it ----
  const instances = [];
  let pillEl = null, okTimer = null, wasBad = false;
  function drawPill() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', drawPill, { once: true }); return; }
    const bad = instances.some((i) => i.state === 'fail');
    if (!pillEl) {
      pillEl = document.createElement('button');
      pillEl.type = 'button';
      pillEl.id = 'syncPill';
      pillEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);'
        + 'top:calc(env(safe-area-inset-top, 0px) + 58px);z-index:99998;border:none;border-radius:999px;'
        + 'padding:8px 14px;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer;display:none;';
      pillEl.addEventListener('click', function () { instances.forEach((i) => i.retry()); });
      document.body.appendChild(pillEl);
    }
    clearTimeout(okTimer);
    if (bad) {
      wasBad = true;
      pillEl.textContent = 'Not saved yet · tap to retry';
      pillEl.style.background = '#FF3B30'; pillEl.style.color = '#fff';
      pillEl.style.display = 'block';
    } else if (wasBad && instances.every((i) => i.state === 'ok')) {
      wasBad = false;
      pillEl.textContent = 'Saved';
      pillEl.style.background = '#34C759'; pillEl.style.color = '#fff';
      pillEl.style.display = 'block';
      okTimer = setTimeout(function () { pillEl.style.display = 'none'; }, 1800);
    } else if (!wasBad) {
      pillEl.style.display = 'none';
    }
  }

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey) return;
    if (!window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    const DIRTY = 'sync:dirty:' + appKey;
    let supa = null;
    let pushTimer = null, retryTimer = null, initTimer = null;
    let pushing = false, initRunning = false, subscribed = false, authHooked = false;
    let failCount = 0;
    let suppressSync = false;
    let lastMineJson = null;   // our matched subset, as last pushed or applied
    let rowOthers = {};        // keys in the row owned by OTHER pages — preserved verbatim
    let token = null;          // access token, for the unload beacon
    let live = false;          // true only once a read has actually succeeded

    const me = { state: 'ok', retry: function () { failCount = 0; if (live) pushNow(); else init(); } };
    instances.push(me);
    function setState(s) { if (me.state !== s) { me.state = s; drawPill(); } }

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    // The row we would write: everyone else's keys, plus ours as they
    // stand now. Keys we own and have since deleted simply drop out.
    function buildRow(mine) {
      const out = {};
      for (const k of Object.keys(rowOthers)) { if (!matches(k)) out[k] = rowOthers[k]; }
      for (const k of Object.keys(mine)) out[k] = mine[k];
      return out;
    }
    function rememberOthers(remote) {
      rowOthers = {};
      if (!remote || typeof remote !== 'object') return;
      for (const k of Object.keys(remote)) { if (!matches(k)) rowOthers[k] = remote[k]; }
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    function isDirty() { try { return !!localStorage.getItem(DIRTY); } catch (e) { return false; } }
    function markDirty() { try { origSet(DIRTY, String(Date.now())); } catch (e) {} }
    function clearDirty() { try { origRemove(DIRTY); } catch (e) {} }

    function localEdit() { markDirty(); schedulePush(); }
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) localEdit(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) localEdit(); } catch (e) {}
    };

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      rememberOthers(remote);
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) {
            try { origRemove(k); changed = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      lastMineJson = JSON.stringify(collect());
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      return changed;
    }

    function upsert(mine) {
      return supa.from('app_state').upsert(
        { key: appKey, data: buildRow(mine), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }

    async function pushNow() {
      if (!supa || !live) return;            // init() pushes the dirty edit once it connects
      if (pushing) { schedulePush(); return; }
      const mine = collect();
      const json = JSON.stringify(mine);
      if (json === lastMineJson) { clearDirty(); setState('ok'); return; }
      pushing = true;
      let err = null;
      try {
        let r = await upsert(mine);
        /* Most failures on the phone are a login that went stale while
           the app sat in the background. Refresh it once and try again. */
        if (r.error) {
          try { await supa.auth.refreshSession(); } catch (e) {}
          r = await upsert(mine);
        }
        err = r.error || null;
      } catch (e) { err = e || new Error('push failed'); }
      pushing = false;

      if (!err) {
        lastMineJson = json;
        failCount = 0;
        if (JSON.stringify(collect()) === json) clearDirty(); else schedulePush();
        setState('ok');
      } else {
        failCount++;
        setState('fail');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(pushNow, Math.min(60000, 5000 * failCount));
      }
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      if (!supa || !live || !token) return;
      const mine = collect();
      const json = JSON.stringify(mine);
      if (json === lastMineJson) return;
      /* Fire-and-forget. The dirty marker stays set, so if this never
         lands the next open pushes it again. */
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            // The row is RLS-protected: this must be the signed-in
            // user's token, not the publishable key, or it 401s.
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: buildRow(mine), updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
      } catch (e) {}
    }

    async function readRow() {
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) return { ok: false };
        return { ok: true, remote: (data && data.data) || null };
      } catch (e) { return { ok: false }; }
    }

    async function init() {
      if (live || initRunning) return;
      initRunning = true;
      clearTimeout(initTimer);
      try {
        /* auth.js publishes a promise that settles once it knows whether
           there is a session. Reading before that resolves races the token
           restore and comes back empty. */
        if (window.dashAuthReady && typeof window.dashAuthReady.then === 'function') {
          let signedIn = false;
          try { signedIn = await window.dashAuthReady; } catch (e) {}
          if (!signedIn) return;   // gate is up: read nothing, write nothing
        }

        supa = supa || ((window.dashAuth && window.dashAuth.client)
          ? window.dashAuth.client
          : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY));

        try {
          const s = await supa.auth.getSession();
          token = (s && s.data && s.data.session && s.data.session.access_token) || null;
        } catch (e) {}
        if (!authHooked) {
          authHooked = true;
          try {
            supa.auth.onAuthStateChange(function (_e, session) {
              token = (session && session.access_token) || null;
            });
          } catch (e) {}
        }

        let res = await readRow();
        if (!res.ok) {
          try { await supa.auth.refreshSession(); } catch (e) {}
          res = await readRow();
        }
        /* A read that failed tells us nothing about the row. Pushing here
           is what overwrote good phone data with stale desktop data. Try
           again shortly rather than giving up for the whole visit. */
        if (!res.ok) {
          if (isDirty()) setState('fail');
          initTimer = setTimeout(init, 15000);
          return;
        }
        live = true;
        const remote = res.remote;

        if (isDirty()) {
          // This device has an edit the cloud never got. It wins.
          rememberOthers(remote);
          lastMineJson = null;
          schedulePush();
        } else if (remote && Object.keys(remote).length > 0) {
          applyRemote(remote);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();   // genuinely no row yet — seed it from this device
        }

        if (!subscribed) {
          subscribed = true;
          supa.channel('app_state_' + appKey)
            .on('postgres_changes', {
              event: '*',
              schema: 'public',
              table: 'app_state',
              filter: 'key=eq.' + appKey,
            }, (payload) => {
              if (!payload.new || !payload.new.data) return;
              if (isDirty()) { rememberOthers(payload.new.data); schedulePush(); return; }
              applyRemote(payload.new.data);
            })
            .subscribe();
        }
      } finally {
        initRunning = false;
      }
    }

    /* iOS freezes a home-screen app in the background: the login token
       expires and the live channel dies without telling anyone. Coming
       back to the front, push anything unsaved, then re-read the row. */
    async function resume() {
      if (!live) { init(); return; }
      try { await supa.auth.getSession(); } catch (e) {}
      if (isDirty()) { failCount = 0; pushNow(); return; }
      const res = await readRow();
      if (res.ok && !isDirty() && res.remote && Object.keys(res.remote).length > 0) applyRemote(res.remote);
    }

    init();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') resume();
      else flushOnUnload();
    });
    window.addEventListener('online', resume);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
