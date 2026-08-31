// ============================================================
// POST /api/health-sync
// Body: { secret, date?, steps?, weightKg?, sleepHours?, workoutMin?, activeKcal? }
//
// Meant to be called by an iOS Shortcuts automation (not a
// logged-in browser session — Shortcuts can't do the Supabase
// Auth dance), so it's guarded by a shared secret instead of a
// user session, same idea as a webhook.
//
// Merges into the same 'health' app_state row health.html reads,
// under an 'ah:days' key (date -> metrics), so it rides along
// with the existing sync.js pull on page load. Does a
// read-merge-write rather than a blind upsert so it never clobbers
// the supplement-stack / water data already living in that row.
// ============================================================
import { createClient } from '@supabase/supabase-js';

function todayNZ() {
  // Shortcuts sends whatever local date the phone is on; this is
  // just the fallback if 'date' is omitted.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); // YYYY-MM-DD
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const secret = process.env.HEALTH_SYNC_SECRET;
  if (!supabaseUrl || !supabaseKey || !secret) {
    return res.status(500).json({ error: 'server not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  if (body.secret !== secret) return res.status(401).json({ error: 'bad secret' });

  const date = (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayNZ();

  const metrics = {};
  ['steps', 'weightKg', 'sleepHours', 'workoutMin', 'activeKcal'].forEach((k) => {
    const v = Number(body[k]);
    if (body[k] != null && body[k] !== '' && !isNaN(v)) metrics[k] = v;
  });
  if (Object.keys(metrics).length === 0) {
    return res.status(400).json({ error: 'no metrics provided' });
  }
  metrics.syncedAt = new Date().toISOString();

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: row } = await supabase
      .from('app_state').select('data').eq('key', 'health').maybeSingle();
    const current = (row && row.data) || {};
    const days = (current['ah:days'] && typeof current['ah:days'] === 'object') ? current['ah:days'] : {};
    days[date] = Object.assign({}, days[date] || {}, metrics);

    const nextData = Object.assign({}, current, { 'ah:days': days });

    const { error: upErr } = await supabase.from('app_state').upsert(
      { key: 'health', data: nextData, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json({ ok: true, date, metrics });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
