// ============================================================
// POST /api/health-sync
// Body: { secret, date?, steps?, weightKg?, sleepHours?, workoutMin?, activeKcal? }
//
// Meant to be called by an iOS Shortcuts automation (not a
// logged-in browser session — Shortcuts can't do the Supabase
// Auth dance), so it's guarded by a shared secret instead of a
// user session, same idea as a webhook.
//
// Writes to its OWN app_state row — key 'apple_health', NOT the
// shared 'health' row — because the Water Tracker iframe embedded
// in health.html runs its own independent sync.js instance against
// 'health' with a syncedKeys list that doesn't know about Apple
// Health data, and blindly replaces that row's entire contents on
// every push. Sharing a row with any other independent writer is
// exactly what caused synced steps/sleep to vanish shortly after
// landing. This row is written only here and read directly by
// health.html (no sync.js involved), so nothing else can touch it.
// Does a read-merge-write (not a blind upsert) so multiple days
// accumulate instead of only the latest day surviving.
//
// Body parsing is manual (bodyParser disabled below) because the
// Shortcuts "Text" action, when a variable it's inserting turns out
// to be empty (e.g. no sleep samples that night), just leaves a gap
// rather than substituting null/0 — producing invalid JSON like
// {"steps":7724,"sleepHours":}. Rather than have that silently fail
// the whole day's sync (steps included), we sanitize obviously-empty
// "key": slots out of the raw text before parsing.
// ============================================================
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

function todayNZ() {
  // Shortcuts sends whatever local date the phone is on; this is
  // just the fallback if 'date' is omitted.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); // YYYY-MM-DD
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Strips "key": slots with nothing (or only whitespace) before the
// next , or } — i.e. a variable that came through empty — so the
// rest of the payload still parses instead of the whole request dying.
function sanitizeJson(raw) {
  return raw.replace(/,?\s*"[^"]+"\s*:\s*(?=[,}])/g, '');
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

  const raw = await readRawBody(req);
  let body;
  try { body = JSON.parse(raw); }
  catch { try { body = JSON.parse(sanitizeJson(raw)); } catch { body = {}; } }
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
      .from('app_state').select('data').eq('key', 'apple_health').maybeSingle();
    const current = (row && row.data) || {};
    const days = (current.days && typeof current.days === 'object') ? current.days : {};
    days[date] = Object.assign({}, days[date] || {}, metrics);

    const nextData = Object.assign({}, current, { days });

    const { error: upErr } = await supabase.from('app_state').upsert(
      { key: 'apple_health', data: nextData, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json({ ok: true, date, metrics });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
