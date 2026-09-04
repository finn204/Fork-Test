// ============================================================
// GET/POST /api/check-reminders — hit on a timer (every few
// minutes) by a scheduler outside Vercel Cron, since Vercel's
// Hobby-plan cron only fires once a day and these reminders need
// to land at specific times throughout the day (see
// .github/workflows/reminders-cron.yml, which polls this on a
// 5-minute schedule via GitHub Actions instead).
//
// Reads the 'reminders' app_state row (reminders.html is the
// only other writer, and both sides read-merge-write so an edit
// and a fire landing close together won't clobber each other).
// For every enabled reminder whose scheduled time has passed and
// hasn't already fired today, sends a push notification and
// stamps lastFiredDate so it won't fire twice in one day. An item
// with type:'digest' gets a dynamically-built body instead of its
// stored message — see buildDigestBody below.
//
// Needs the same VAPID_* env vars as /api/send-push. If a
// CRON_SECRET env var is set, requires it as a Bearer token —
// otherwise runs unauthenticated (worst case is an extra nudge).
// ============================================================
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

function nowNZ() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// A 'digest' reminder ignores its stored .message and gets a fresh
// one built from today's real numbers across the other app_state
// rows — QLs logged, water reminders actually hit vs how many were
// due by now, money spent today, and whether a weight got logged.
async function buildDigestBody(supabase, today, digestTime, allItems) {
  const [{ data: qlRow }, { data: financeRow }, { data: healthRow }] = await Promise.all([
    supabase.from('app_state').select('data').eq('key', 'ql').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'finance').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'apple_health').maybeSingle(),
  ]);

  const qlCount = (qlRow && qlRow.data && qlRow.data['ql:log'] && qlRow.data['ql:log'][today]) || 0;

  const waterItems = allItems.filter((i) => i.enabled !== false && /water/i.test(i.label || '') && i.time <= digestTime);
  const waterHit = waterItems.filter((i) => i.lastFiredDate === today).length;

  const txns = (financeRow && financeRow.data && financeRow.data.spend_txns) || [];
  const spentToday = txns.filter((t) => t.date === today).reduce((s, t) => s + (t.amount || 0), 0);

  const days = (healthRow && healthRow.data && healthRow.data.days) || {};
  const weighedIn = days[today] && days[today].weightKg != null;

  const bits = [`${qlCount} QL${qlCount === 1 ? '' : 's'}`];
  if (waterItems.length) bits.push(`${waterHit}/${waterItems.length} waters`);
  bits.push(`$${Math.round(spentToday)} spent today`);
  let body = bits.join(' · ');
  if (weighedIn) body += ' · weighed in';
  return body;
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
  const { date: today, time: currentTime } = nowNZ();

  try {
    const { data: remRow } = await supabase.from('app_state').select('data').eq('key', 'reminders').maybeSingle();
    const items = (remRow && remRow.data && remRow.data.items) || [];

    const due = items.filter((item) =>
      item.enabled !== false &&
      item.time && item.time <= currentTime &&
      item.lastFiredDate !== today
    );

    if (!due.length) return res.status(200).json({ ok: true, sent: 0, checked: items.length });

    const { data: pushRow } = await supabase.from('app_state').select('data').eq('key', 'push_subscriptions').maybeSingle();
    const subs = (pushRow && pushRow.data && pushRow.data.subs) || [];

    let sent = 0;
    if (subs.length) {
      webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
      const deadEndpoints = new Set();

      for (const item of due) {
        const body = item.type === 'digest'
          ? await buildDigestBody(supabase, today, currentTime, items)
          : (item.message || (item.label ? item.label + '.' : 'Reminder'));
        const payload = JSON.stringify({
          title: item.label || 'Reminder',
          body,
          url: item.type === 'digest' ? '/index.html' : '/reminders.html'
        });
        const results = await Promise.all(subs.map(async (s) => {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); return true; }
          catch (e) { if (e && (e.statusCode === 410 || e.statusCode === 404)) deadEndpoints.add(s.endpoint); return false; }
        }));
        sent += results.filter(Boolean).length;
      }

      if (deadEndpoints.size) {
        const alive = subs.filter((s) => !deadEndpoints.has(s.endpoint));
        await supabase.from('app_state').upsert(
          { key: 'push_subscriptions', data: { subs: alive }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
        );
      }
    }

    // Read-merge-write the reminders row so an edit made in the UI
    // moments ago (which itself read-merge-writes) isn't clobbered.
    const { data: freshRow } = await supabase.from('app_state').select('data').eq('key', 'reminders').maybeSingle();
    const freshItems = (freshRow && freshRow.data && freshRow.data.items) || items;
    const dueIds = new Set(due.map((d) => d.id));
    const updated = freshItems.map((item) => dueIds.has(item.id) ? { ...item, lastFiredDate: today } : item);
    await supabase.from('app_state').upsert(
      { key: 'reminders', data: { items: updated }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
    );

    return res.status(200).json({ ok: true, due: due.length, sent, subs: subs.length });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
