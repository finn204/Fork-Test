// ============================================================
// POST /api/tick   Body: { token: string }
//
// Lets a notification action write to the dashboard without the
// phone ever opening the app. The service worker calls this when
// Finn taps a button on a push notification.
//
// Auth is a single-use token, not a shared secret. A shared secret
// shipped inside sw.js would be readable by anyone who loads the
// site. Instead /api/check-reminders mints a random token when it
// sends the notification, records what that one token is allowed
// to do, and this endpoint spends it. A token is good for one
// write, expires after 12 hours, and authorises exactly one
// pre-declared action on one date — so intercepting one buys you
// nothing but the thing Finn was already being asked to confirm.
//
// Tokens live in the 'action_tokens' app_state row and are pruned
// on every call, so the row cannot grow without bound.
//
// This runs on the server and uses the SERVICE ROLE key when one is
// set. That key bypasses RLS, which is what keeps this working once
// app_state is locked to `authenticated` only. It falls back to the
// anon key so nothing breaks before the env var exists.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const token = body && body.token;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token required' });

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: tokRow } = await supabase
      .from('app_state').select('data').eq('key', 'action_tokens').maybeSingle();
    const all = (tokRow && tokRow.data && tokRow.data.tokens) || {};

    const now = Date.now();
    const entry = all[token];

    // Prune expired entries whether or not this token is valid, and
    // spend this one, so a replay finds nothing.
    const kept = {};
    for (const [t, v] of Object.entries(all)) {
      if (t !== token && v && v.expiresAt > now) kept[t] = v;
    }
    await supabase.from('app_state').upsert(
      { key: 'action_tokens', data: { tokens: kept }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

    if (!entry) return res.status(401).json({ error: 'unknown or already used' });
    if (entry.expiresAt <= now) return res.status(401).json({ error: 'expired' });

    if (entry.action === 'clean-day') {
      const { data: sRow } = await supabase
        .from('app_state').select('data').eq('key', 'streaks').maybeSingle();
      const rowData = (sRow && sRow.data) || {};
      const streaks = rowData['streaks:v1'] || {};
      streaks.checks = streaks.checks || {};

      // Never overwrite a slip he already recorded for that day.
      const slips = streaks.slips || {};
      const alreadySlipped =
        (slips.alcohol || []).indexOf(entry.date) !== -1 ||
        (slips.nicotine || []).indexOf(entry.date) !== -1;
      if (alreadySlipped) return res.status(409).json({ error: 'a slip is already logged for that day' });

      streaks.checks[entry.date] = true;
      rowData['streaks:v1'] = streaks;
      const { error } = await supabase.from('app_state').upsert(
        { key: 'streaks', data: rowData, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, action: 'clean-day', date: entry.date });
    }

    if (entry.action === 'habit' && entry.habitId) {
      const { data: gRow } = await supabase
        .from('app_state').select('data').eq('key', 'goals').maybeSingle();
      const rowData = (gRow && gRow.data) || {};
      const daily = rowData['goals:daily'] || {};
      daily[entry.date] = daily[entry.date] || {};
      daily[entry.date][entry.habitId] = 1;
      rowData['goals:daily'] = daily;
      const { error } = await supabase.from('app_state').upsert(
        { key: 'goals', data: rowData, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, action: 'habit', habitId: entry.habitId, date: entry.date });
    }

    return res.status(400).json({ error: 'unsupported action' });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}

// Used by /api/check-reminders to mint a token alongside a notification.
export async function mintToken(supabase, action, date, habitId) {
  const token = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(36).slice(2);
  const { data: tokRow } = await supabase
    .from('app_state').select('data').eq('key', 'action_tokens').maybeSingle();
  const all = (tokRow && tokRow.data && tokRow.data.tokens) || {};
  const now = Date.now();
  const kept = {};
  for (const [t, v] of Object.entries(all)) if (v && v.expiresAt > now) kept[t] = v;
  kept[token] = { action, date, habitId: habitId || null, expiresAt: now + TOKEN_TTL_MS };
  await supabase.from('app_state').upsert(
    { key: 'action_tokens', data: { tokens: kept }, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return token;
}
