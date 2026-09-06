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
// stored message (see buildDigestBody); type:'stale-leads' pulls the
// real CRM backlog instead and skips silently when nothing's overdue;
// type:'callout' names the single worst thing today's data says.
//
// Needs the same VAPID_* env vars as /api/send-push. If a
// CRON_SECRET env var is set, requires it as a Bearer token —
// otherwise runs unauthenticated (worst case is an extra nudge).
//
// This runs on the server and uses the SERVICE ROLE key when one is
// set. That key bypasses RLS, which is what keeps this working once
// app_state is locked to `authenticated` only. It falls back to the
// anon key so nothing breaks before the env var exists. The service
// role key must NEVER reach the browser: /api/config serves the anon
// key deliberately.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { mintToken } from './tick.js';

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nowNZ() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    dow: DOW[get('weekday')],
  };
}

// A reminder with no `days` runs every day. With one, it only runs on
// those weekdays (0 = Sunday). Work-shaped nudges — stale leads, QLs —
// are set to Mon-Fri so the weekend stays quiet.
function runsToday(item, dow) {
  if (!Array.isArray(item.days) || !item.days.length) return true;
  return item.days.indexOf(dow) !== -1;
}

// Which NZ day a millisecond timestamp belongs to.
function dayOf(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}

// Most reminders fire once and are done for the day. One with
// `repeatMins` keeps coming back on that interval until `until`,
// which is how the nagging ones work — they only go quiet when the
// thing they are nagging about is actually done (their body builder
// returns null, so nothing is sent).
function isDue(item, today, currentTime, nowMs, dow) {
  if (item.enabled === false) return false;
  if (!runsToday(item, dow)) return false;
  if (!item.time || item.time > currentTime) return false;
  if (!item.repeatMins) return item.lastFiredDate !== today;
  if (item.until && currentTime > item.until) return false;
  const last = item.lastFiredAt ? Date.parse(item.lastFiredAt) : 0;
  /* No timestamp yet — a repeater that was only just added. Fall back
     to the once-a-day rule so it still honours the lastFiredDate the
     UI stamps on creation, instead of firing the moment it appears. */
  if (!last) return item.lastFiredDate !== today;
  if (dayOf(last) !== today) return true;
  return (nowMs - last) >= item.repeatMins * 60000;
}

// A 'digest' reminder ignores its stored .message and gets a fresh
// one built from today's real numbers across the other app_state
// rows — QLs logged, water reminders actually hit vs how many were
// due by now, money spent today, and whether a weight got logged.
async function buildDigestBody(supabase, today, digestTime, allItems, dow) {
  const [{ data: qlRow }, { data: financeRow }, { data: healthRow }] = await Promise.all([
    supabase.from('app_state').select('data').eq('key', 'ql').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'finance').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'apple_health').maybeSingle(),
  ]);

  const qlCount = (qlRow && qlRow.data && qlRow.data['ql:log'] && qlRow.data['ql:log'][today]) || 0;

  const waterItems = allItems.filter((i) => i.enabled !== false && runsToday(i, dow) && /water/i.test(i.label || '') && i.time <= digestTime);
  const waterHit = waterItems.filter((i) => i.lastFiredDate === today).length;

  const txns = (financeRow && financeRow.data && financeRow.data.spend_txns) || [];
  const spentToday = txns.filter((t) => t.date === today).reduce((s, t) => s + (t.amount || 0), 0);

  const days = (healthRow && healthRow.data && healthRow.data.days) || {};
  const weighedIn = days[today] && days[today].weightKg != null;

  // No QL line at the weekend — not a work day, so it is not a miss.
  const isWeekend = dow === 0 || dow === 6;
  const bits = [];
  if (!isWeekend) bits.push(`${qlCount} QL${qlCount === 1 ? '' : 's'}`);
  if (waterItems.length) bits.push(`${waterHit}/${waterItems.length} waters`);
  bits.push(`$${Math.round(spentToday)} spent today`);
  let body = bits.join(' · ');
  if (weighedIn) body += ' · weighed in';
  return body;
}

// A 'stale-leads' reminder pulls the real CRM backlog (business.html's
// stale_tasks) instead of a canned message — names the single most
// overdue lead so it's never just a vague "you have leads" nudge.
function overdueLabel(dueDate, today) {
  const days = Math.floor((new Date(today).getTime() - new Date(dueDate).getTime()) / 86400000);
  if (days < 0) return null;
  if (days < 30) return `${days}d overdue`;
  return `${Math.floor(days / 30)}mo overdue`;
}
async function buildStaleLeadsBody(supabase, today) {
  const { data: bizRow } = await supabase.from('app_state').select('data').eq('key', 'business').maybeSingle();
  const tasks = (bizRow && bizRow.data && bizRow.data.stale_tasks) || [];
  if (!tasks.length) return null; // nothing overdue — skip firing entirely

  const withLabels = tasks
    .map((t) => ({ ...t, overdue: overdueLabel(t.dueDate, today) }))
    .filter((t) => t.overdue)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  if (!withLabels.length) return null;

  const worst = withLabels[0];
  const rest = withLabels.length - 1;
  let body = `${withLabels.length} stale follow-up${withLabels.length === 1 ? '' : 's'} — worst: ${worst.name} (${worst.overdue})`;
  if (rest > 0) body += `, +${rest} more`;
  return body;
}

// ============================================================
// A 'callout' reminder. Late evening, one line, no cushioning.
// It only ever states something the data actually says, and it
// says the single worst thing rather than a list — a list reads
// as wallpaper, one line lands.
//
// GYM_DAYS mirrors habits.js (`gym` is dow [1,2,4,5]). If the gym
// schedule changes there, change it here too; the server has no
// other way to know which days were meant to be training days.
// ============================================================
const GYM_DAYS = [1, 2, 4, 5];
const TARGET_DATE = '2026-12-25';

function daysUntil(today, target) {
  return Math.round((new Date(target).getTime() - new Date(today).getTime()) / 86400000);
}

// Stable within a day, different between days, so a line he saw
// yesterday isn't the line he sees tonight.
function pick(list, today) {
  let h = 0;
  for (let i = 0; i < today.length; i++) h = (h * 31 + today.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

function streakDays(streaks, which, today) {
  const start = (streaks.start && streaks.start[which]) || '2026-08-29';
  const slips = ((streaks.slips && streaks.slips[which]) || []).slice().sort();
  let from = start;
  if (slips.length) {
    const last = slips[slips.length - 1];
    if (last >= from) {
      const nx = new Date(last);
      nx.setDate(nx.getDate() + 1);
      from = nx.toISOString().slice(0, 10);
    }
  }
  const n = Math.round((new Date(today).getTime() - new Date(from).getTime()) / 86400000) + 1;
  return n > 0 ? n : 0;
}

async function buildCalloutBody(supabase, today, dow) {
  const [{ data: streakRow }, { data: goalsRow }, { data: healthRow }] = await Promise.all([
    supabase.from('app_state').select('data').eq('key', 'streaks').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'goals').maybeSingle(),
    supabase.from('app_state').select('data').eq('key', 'apple_health').maybeSingle(),
  ]);

  /* Only accuse him of something the data can actually show. A missing
     row means "we have not heard from that device", NOT "he skipped it"
     — inventing a miss out of an empty read is exactly how a call-out
     stops being believable. Each branch below is gated on its own row. */
  const hasStreaks = !!(streakRow && streakRow.data && streakRow.data['streaks:v1']);
  const hasGoals   = !!(goalsRow && goalsRow.data && goalsRow.data['goals:daily']);
  const hasHealth  = !!(healthRow && healthRow.data && healthRow.data.days);
  if (!hasStreaks && !hasGoals && !hasHealth) return null;  // nothing known: stay quiet

  const streaks = (hasStreaks && streakRow.data['streaks:v1']) || {};
  const slips = streaks.slips || {};
  const ticks = (hasGoals && goalsRow.data['goals:daily'][today]) || {};
  const healthDays = (hasHealth && healthRow.data.days) || {};

  const left = daysUntil(today, TARGET_DATE);
  const countdown = left > 0 ? `${left} days to Christmas.` : '';

  // 1. Slipped today. Nothing else matters tonight.
  const drank = (slips.alcohol || []).indexOf(today) !== -1;
  const vaped = (slips.nicotine || []).indexOf(today) !== -1;
  if (drank || vaped) {
    const what = drank && vaped ? 'a drink and nicotine' : (drank ? 'a drink' : 'nicotine');
    return pick([
      `You chose ${what} over Christmas. Streak: 0. ${countdown}`,
      `${what[0].toUpperCase() + what.slice(1)} today. Back to zero, by your own hand. ${countdown}`,
      `Streak reset. You went 7 months sugar-free once, so do not pretend this one is hard. ${countdown}`,
    ], today);
  }

  // 2. A training day with no gym ticked.
  if (hasGoals && GYM_DAYS.indexOf(dow) !== -1 && !ticks.gym) {
    return pick([
      'No gym today, and it was a gym day. That is one of four gone this week.',
      'Training day, no training. December is going to look exactly like August at this rate.',
      'You skipped the gym. Nobody is going to care about your excuse in January.',
    ], today);
  }

  // 3. No clean day logged, and the day is nearly over.
  if (hasStreaks && !(streaks.checks || {})[today]) {
    return pick([
      'You have not logged a clean day. Either you slipped or you could not be bothered. Neither is good.',
      'Clean day still unticked. Thirty seconds. Do it.',
      'No clean day logged. The streak only counts what you actually confirm.',
    ], today);
  }

  // 4. No weigh-in.
  if (hasHealth && !(healthDays[today] && healthDays[today].weightKg != null)) {
    return pick([
      'No weigh-in today. You cannot fix what you refuse to look at.',
      'Skipped the scales. That is avoidance, not a rest day.',
    ], today);
  }

  // 5. Nothing to call out. Do not let it feel like a finish line.
  if (!hasStreaks) return null;   // no streak numbers to stand on
  const alc = streakDays(streaks, 'alcohol', today);
  const nic = streakDays(streaks, 'nicotine', today);
  return pick([
    `${alc} days dry, ${nic} without nicotine. Do not get comfortable. ${countdown}`,
    `Clean day ${alc}. Good. Now do it again tomorrow. ${countdown}`,
    `${alc} days. That is the easy part. ${countdown}`,
  ], today).trim();
}

// ============================================================
// A 'food-check' reminder. Repeats through the day and only goes
// quiet once he has actually logged something. Returning null is
// how it shuts up: the engine treats null as "nothing to send".
//
// Nine days of history when this was written: 7 food entries
// across 2 days. Logging is the habit that dies first, so this one
// nags rather than asking once.
// ============================================================
const FOOD_TARGET = 3;   // meals/items that count as "logged today"

async function buildFoodCheckBody(supabase, today, currentTime) {
  const { data: foodRow } = await supabase.from('app_state').select('data').eq('key', 'food').maybeSingle();
  if (!foodRow || !foodRow.data || !foodRow.data['food:logs']) return null;  // no row: say nothing

  const logs = foodRow.data['food:logs'] || [];
  const n = logs.filter((l) => l.ts && dayOf(l.ts) === today).length;
  if (n >= FOOD_TARGET) return null;   // done for today

  const late = currentTime >= '19:00';
  if (n === 0) {
    return late
      ? 'Nothing logged all day. You ate. You just cannot be bothered writing it down.'
      : 'Food log is empty. Two taps. Do it now, not later.';
  }
  return late
    ? `${n} of ${FOOD_TARGET} logged and the day is nearly gone. Finish it.`
    : `Only ${n} logged today. Tap a usual, it takes two seconds.`;
}

// ============================================================
// A 'coffee-cutoff' reminder. Caffeine has roughly a 5-hour half
// life, so a 128 mg flat white at 3:26pm — which is in his log —
// still has about 45 mg working at an 11pm bedtime. He reports
// waking up knackered on 7-8 hours, and that is a live suspect.
// Fires at the cutoff with today's real intake.
// ============================================================
const CAFFEINE_HALF_LIFE_H = 5;
const BEDTIME_H = 23;

async function buildCoffeeCutoffBody(supabase, today, currentTime) {
  const { data: cafRow } = await supabase.from('app_state').select('data').eq('key', 'caffeine').maybeSingle();
  if (!cafRow || !cafRow.data || !cafRow.data['caf:logs']) return null;

  const logs = (cafRow.data['caf:logs'] || []).filter((c) => c.ts && dayOf(c.ts) === today);
  const mg = logs.reduce((sum, c) => sum + (c.mg || 0), 0);

  // What one more standard coffee now would still leave at bedtime.
  const hoursToBed = Math.max(0, BEDTIME_H - Number(currentTime.slice(0, 2)));
  const leftAtBed = Math.round(130 * Math.pow(0.5, hoursToBed / CAFFEINE_HALF_LIFE_H));

  if (!logs.length) {
    return `Coffee cutoff. None logged today. One from here is still ~${leftAtBed} mg in you at 11pm.`;
  }
  return `Coffee cutoff. ${mg} mg in you today. Another one now is still ~${leftAtBed} mg at 11pm, and then you wonder why mornings hurt.`;
}

// ============================================================
// A 'clean-check' reminder. Nine days into the rules he had logged
// four slips and zero clean days — the streak counter had nothing
// to count. Slips he records reliably; confirmations he does not.
//
// So this one ships a "Clean day" button on the notification and
// writes straight through /api/tick. No app, no unlock, one tap.
// It goes silent once the day is settled either way.
// ============================================================
async function buildCleanCheck(supabase, today) {
  const { data: sRow } = await supabase
    .from('app_state').select('data').eq('key', 'streaks').maybeSingle();
  if (!sRow || !sRow.data || !sRow.data['streaks:v1']) return null;

  const streaks = sRow.data['streaks:v1'];
  if ((streaks.checks || {})[today]) return null;   // already confirmed clean

  const slips = streaks.slips || {};
  const drank = (slips.alcohol || []).indexOf(today) !== -1;
  const vaped = (slips.nicotine || []).indexOf(today) !== -1;
  if (drank || vaped) return null;                  // already recorded a slip

  return 'No drink, no nicotine today? Tap it and the streak counts. Leave it and it counts nothing.';
}

// ============================================================
// Auto reminder types are backfilled HERE, on the server, not only
// when reminders.html happens to be opened. The whole point of these
// is that he does not open the app, so a new type that waits for a
// page visit never switches itself on — 'clean-check' sat dormant for
// exactly that reason.
//
// reminders.html mirrors this list for its own first-run seeding.
// Add a type in both places, or it will not appear for someone whose
// row already exists.
// ============================================================
const AUTO_TYPES = [
  { id: 'daily-digest',  time: '20:30', label: 'Daily Recap',   type: 'digest' },
  { id: 'stale-leads',   time: '09:00', label: 'Stale Leads',   type: 'stale-leads', days: [1, 2, 3, 4, 5] },
  { id: 'callout',       time: '21:30', label: 'Straight Up',   type: 'callout' },
  { id: 'food-check',    time: '12:00', label: 'Food Log',      type: 'food-check', repeatMins: 150, until: '21:00' },
  { id: 'coffee-cutoff', time: '14:00', label: 'Coffee Cutoff', type: 'coffee-cutoff' },
  { id: 'clean-check',   time: '21:00', label: 'Clean Day',     type: 'clean-check', repeatMins: 60, until: '23:00' },
];

// A type added now should not fire retroactively for a time that has
// already passed today, so it starts stamped as if it had.
function backfillAutoTypes(items, today, currentTime) {
  const added = [];
  for (const a of AUTO_TYPES) {
    if (items.some((i) => i.type === a.type)) continue;
    added.push({ ...a, enabled: true, lastFiredDate: a.time <= currentTime ? today : null, lastFiredAt: null });
  }
  return added;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== cronSecret) return res.status(401).json({ error: 'unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!supabaseUrl || !supabaseKey || !vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'server not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { date: today, time: currentTime, dow } = nowNZ();

  try {
    const { data: remRow } = await supabase.from('app_state').select('data').eq('key', 'reminders').maybeSingle();
    let items = (remRow && remRow.data && remRow.data.items) || [];

    /* Only backfill into a row that already exists. An empty row means
       reminders.html has never seeded this account, and seeding the
       whole default set from here would fight with that first run. */
    if (items.length) {
      const added = backfillAutoTypes(items, today, currentTime);
      if (added.length) {
        items = items.concat(added);
        await supabase.from('app_state').upsert(
          { key: 'reminders', data: { items }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
        );
      }
    }

    const nowMs = Date.now();
    const due = items.filter((item) => isDue(item, today, currentTime, nowMs, dow));

    if (!due.length) return res.status(200).json({ ok: true, sent: 0, checked: items.length });

    const { data: pushRow } = await supabase.from('app_state').select('data').eq('key', 'push_subscriptions').maybeSingle();
    const subs = (pushRow && pushRow.data && pushRow.data.subs) || [];

    let sent = 0;
    /* Only items that actually went out — or that deliberately chose to
       stay silent — get stamped. Stamping on a failed send marks a
       notification delivered that never was, and it is gone for the day. */
    const handled = new Set();
    if (subs.length) {
      webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
      const deadEndpoints = new Set();

      for (const item of due) {
        let body;
        if (item.type === 'digest') body = await buildDigestBody(supabase, today, currentTime, items, dow);
        else if (item.type === 'stale-leads') body = await buildStaleLeadsBody(supabase, today);
        else if (item.type === 'callout') body = await buildCalloutBody(supabase, today, dow);
        else if (item.type === 'food-check') body = await buildFoodCheckBody(supabase, today, currentTime);
        else if (item.type === 'coffee-cutoff') body = await buildCoffeeCutoffBody(supabase, today, currentTime);
        else if (item.type === 'clean-check') body = await buildCleanCheck(supabase, today);
        else body = item.message || (item.label ? item.label + '.' : 'Reminder');

        // stale-leads returns null when there's nothing overdue — still
        // counts as "checked" for today (stamped below) but sends nothing.
        if (body === null) { handled.add(item.id); continue; }

        /* Only a clean-check carries a button today; the token is
           minted per notification and spent once (see /api/tick). */
        let actions = null, token = null;
        if (item.type === 'clean-check') {
          try {
            token = await mintToken(supabase, 'clean-day', today);
            actions = [{ action: 'clean', title: 'Clean day' }];
          } catch (e) { token = null; actions = null; }
        }

        const payload = JSON.stringify({
          title: item.label || 'Reminder',
          body,
          actions,
          token,
          /* iOS renders no notification action buttons at all, and his
             only push subscription is web.push.apple.com — the button
             alone would never reach him. The token rides in the URL as
             well, so tapping the notification body opens the dashboard
             and it spends the token on load. Still one tap. */
          url: item.type === 'clean-check'
            ? ('/index.html' + (token ? '?tick=' + encodeURIComponent(token) : ''))
            : item.type === 'food-check' ? '/food-log.html'
            : item.type === 'coffee-cutoff' ? '/caffeine.html'
            : item.type === 'stale-leads' ? '/business.html'
            : (item.type === 'digest' || item.type === 'callout') ? '/index.html'
            : '/reminders.html'
        });
        const results = await Promise.all(subs.map(async (s) => {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); return true; }
          catch (e) { if (e && (e.statusCode === 410 || e.statusCode === 404)) deadEndpoints.add(s.endpoint); return false; }
        }));
        const okCount = results.filter(Boolean).length;
        sent += okCount;
        if (okCount > 0) handled.add(item.id);
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
    const stampedAt = new Date().toISOString();
    const updated = freshItems.map((item) =>
      handled.has(item.id) ? { ...item, lastFiredDate: today, lastFiredAt: stampedAt } : item);
    await supabase.from('app_state').upsert(
      { key: 'reminders', data: { items: updated }, updated_at: new Date().toISOString() }, { onConflict: 'key' }
    );

    return res.status(200).json({
      ok: true, due: due.length, sent, stamped: handled.size, subs: subs.length,
      /* No subscription means every reminder today is going nowhere. */
      warning: subs.length ? undefined : 'no push subscriptions — nothing can be delivered',
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
