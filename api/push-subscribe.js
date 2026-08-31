// ============================================================
// POST /api/push-subscribe
// Body: { subscription: <PushSubscription.toJSON()> }
// Header: Authorization: Bearer <supabase access token>
//
// Verifies the caller is actually signed in to the dashboard
// (via the same Supabase Auth session auth.js sets up), then
// stores the push subscription in the app_state table under
// key 'push_subscriptions' — same table every other page uses,
// so no new Supabase setup is needed.
// ============================================================
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'invalid session' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const subscription = body && body.subscription;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'subscription required' });
  }

  try {
    const { data: row } = await supabase
      .from('app_state').select('data').eq('key', 'push_subscriptions').maybeSingle();
    const current = (row && row.data) || { subs: [] };
    const subs = Array.isArray(current.subs) ? current.subs : [];
    const filtered = subs.filter((s) => s.endpoint !== subscription.endpoint);
    filtered.push({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      addedAt: new Date().toISOString(),
    });
    const { error: upErr } = await supabase.from('app_state').upsert(
      { key: 'push_subscriptions', data: { subs: filtered }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json({ ok: true, count: filtered.length });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
