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
// Two rules this file exists to enforce:
//   1. Nothing touches the database until auth.js has restored the
//      session. RLS only answers to `authenticated`, so a read fired
//      during that gap comes back empty — which is NOT the same as
//      "no data yet", and must never be treated as such.
//   2. A push only ever rewrites the keys this instance owns. Several
//      pages share one row with different key lists; a full-row write
//      from the narrow one would erase the wide one's keys.
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey) return;
    if (!window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    let lastMineJson = null;   // our matched subset, as last pushed or applied
    let rowOthers = {};        // keys in the row owned by OTHER pages — preserved verbatim
    let token = null;          // access token, for the unload beacon
    let live = false;          // true only once a read has actually succeeded

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
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
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

    async function pushNow() {
      if (!supa || !live) return;
      const mine = collect();
      const json = JSON.stringify(mine);
      if (json === lastMineJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: buildRow(mine), updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastMineJson = json;
      } catch (e) {}
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
        lastMineJson = json;
      } catch (e) {}
    }

    (async function init() {
      /* auth.js publishes a promise that settles once it knows whether
         there is a session. Reading before that resolves races the token
         restore and comes back empty. */
      if (window.dashAuthReady && typeof window.dashAuthReady.then === 'function') {
        let signedIn = false;
        try { signedIn = await window.dashAuthReady; } catch (e) {}
        if (!signedIn) return;   // gate is up: read nothing, write nothing
      }

      supa = (window.dashAuth && window.dashAuth.client)
        ? window.dashAuth.client
        : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

      try {
        const s = await supa.auth.getSession();
        token = (s && s.data && s.data.session && s.data.session.access_token) || null;
      } catch (e) {}
      try {
        supa.auth.onAuthStateChange(function (_e, session) {
          token = (session && session.access_token) || null;
        });
      } catch (e) {}

      let readOk = false, remote = null;
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error) { readOk = true; remote = (data && data.data) || null; }
      } catch (e) {}

      /* A read that failed tells us nothing about the row. Pushing here
         is what overwrote good phone data with stale desktop data. */
      if (!readOk) return;
      live = true;

      if (remote && Object.keys(remote).length > 0) {
        applyRemote(remote);
      } else if (Object.keys(collect()).length > 0) {
        schedulePush();   // genuinely no row yet — seed it from this device
      }

      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
