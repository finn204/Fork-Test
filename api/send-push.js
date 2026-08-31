// ============================================================
// POST /api/send-push
// Body: { title?, body?, url? }
// Header: Authorization: Bearer <supabase access token>
//
// Sends a web push notification to every subscription stored
// under app_state.push_subscriptions. Requires a valid signed-in
// session (same check as push-subscribe) so randoms who find the
// URL can't spam notifications to your devices.
//
// Needs these Vercel env vars set:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
// ============================================================
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!supabaseUrl || !supabaseKey || !vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'server not configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Vercel' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'invalid session' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const title = (body && body.title) || "Finn's Dashboard";
  const message = (body && body.body) || '';
  const url = (body && body.url) || '/';

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  try {
    const { data: row } = await supabase
      .from('app_state').select('data').eq('key', 'push_subscriptions').maybeSingle();
    const subs = (row && row.data && row.data.subs) || [];
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, note: 'no subscriptions on file yet' });

    const payload = JSON.stringify({ title, body: message, url });
    const results = await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
        return { endpoint: s.endpoint, ok: true };
      } catch (e) {
        return { endpoint: s.endpoint, ok: false, status: e && e.statusCode };
      }
    }));

    // Prune subscriptions the browser/OS has permanently invalidated.
    const dead = new Set(results.filter((r) => !r.ok && (r.status === 410 || r.status === 404)).map((r) => r.endpoint));
    if (dead.size) {
      const alive = subs.filter((s) => !dead.has(s.endpoint));
      await supabase.from('app_state').upsert(
        { key: 'push_subscriptions', data: { subs: alive }, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }

    return res.status(200).json({
      ok: true,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      pruned: dead.size,
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
