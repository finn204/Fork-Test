// ============================================================
// GET/POST /api/daily-ql-check — meant to be hit by Vercel Cron,
// once a day, in the evening NZ time.
//
// Checks today's Qualified Leads count (the 'ql' app_state row
// business.html's tracker writes to) and — if it's under the
// 3/day goal — sends a push notification nudging Finn to get a
// few more in before the day's done. Silent no-op if the goal's
// already been hit, and guarded against double-firing the same
// day via a 'lastNudgeDate' stamp on the row.
//
// Needs the same VAPID_* env vars as /api/send-push. If a
// CRON_SECRET env var is set, requires it as a Bearer token
// (Vercel sends this automatically for its own cron calls once
// the env var exists) — otherwise runs unauthenticated, since the
// worst case of someone else triggering it is an extra nudge.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const GOAL = 3;

function todayNZ() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== cronSecret) return res.status(401).json({ error: 'unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!supabaseUrl || !supabaseKey || !vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'server not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const today = todayNZ();

  try {
    const { data: qlRow } = await supabase.from('app_state').select('data').eq('key', 'ql').maybeSingle();
    const log = (qlRow && qlRow.data && qlRow.data['ql:log']) || {};
    const count = log[today] || 0;

    if (count >= GOAL) return res.status(200).json({ ok: true, skipped: 'goal already met', count });

    const nudgeRow = (await supabase.from('app_state').select('data').eq('key', 'ql_nudge').maybeSingle()).data;
    if (nudgeRow && nudgeRow.data && nudgeRow.data.lastNudgeDate === today) {
      return res.status(200).json({ ok: true, skipped: 'already nudged today' });
    }

    const { data: pushRow } = await supabase.from('app_state').select('data').eq('key', 'push_subscriptions').maybeSingle();
    const subs = (pushRow && pushRow.data && pushRow.data.subs) || [];
    if (!subs.length) return res.status(200).json({ ok: true, skipped: 'no push subscriptions' });

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const remaining = GOAL - count;
    const payload = JSON.stringify({
      title: 'Qualified leads today',
      body: count === 0
        ? "No QLs logged yet today — goal's 3, still time to get moving."
        : 'Only ' + count + '/3 QLs today — ' + remaining + ' more to hit the goal.',
      url: '/business.html'
    });

    const results = await Promise.all(subs.map(async (s) => {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); return { ok: true, endpoint: s.endpoint }; }
      catch (e) { return { ok: false, endpoint: s.endpoint, status: e && e.statusCode }; }
    }));

    const dead = new Set(results.filter((r) => !r.ok && (r.status === 410 || r.status === 404)).map((r) => r.endpoint));
    if (dead.size) {
      const alive = subs.filter((s) => !dead.has(s.endpoint));
      await supabase.from('app_state').upsert(
        { key: 'push_subscriptions', data: { subs: alive }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
      );
    }

    await supabase.from('app_state').upsert(
      { key: 'ql_nudge', data: { lastNudgeDate: today }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
    );

    return res.status(200).json({ ok: true, count, sent: results.filter((r) => r.ok).length });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
