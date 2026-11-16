// ============================================================
// POST /api/hq   Header: Authorization: Bearer <supabase access token>
// Body: { action: 'julia' | 'hl' | 'stripe', ... }
//
// Server side of hq.html (the Master Dashboard). One route instead of
// three so the Hobby plan's function limit stays comfortable.
//
//   julia  → { messages, tools }  proxies one Anthropic Messages call.
//            The tool loop runs in the page, because Julia's tools
//            change the page's own state (cards, chat, snoozes).
//   hl     → { operationId, params }  one HighLevel call, mapped from
//            the operation names the claude.ai version used, so the
//            page code did not have to change.
//   stripe → { parameters }  one page of active subscriptions.
//
// Keys live only in Vercel env vars and never reach the browser:
//   ANTHROPIC_API_KEY, HIGHLEVEL_TOKEN (private integration on the
//   Digital Growth sub-account), STRIPE_READ_KEY (restricted, read).
// Every call needs a signed-in dashboard session, checked against
// Supabase Auth exactly like /api/push-subscribe.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const HL_BASE = 'https://services.leadconnectorhq.com';
const HL_LOCATION = '0MrWzbhZSHi80cXHkvho';
const JULIA_MODEL = 'claude-sonnet-5-5';

// operationId → how to call HighLevel. `path` fills {placeholders}
// from params.path; params.query becomes the query string and
// params.body the JSON body.
const HL_OPS = {
  'get-contact':        { method: 'GET',  path: '/contacts/{contactId}' },
  'add-tags':           { method: 'POST', path: '/contacts/{contactId}/tags' },
  'create-note':        { method: 'POST', path: '/contacts/{contactId}/notes' },
  'get-all-notes':      { method: 'GET',  path: '/contacts/{contactId}/notes' },
  'create-task':        { method: 'POST', path: '/contacts/{contactId}/tasks' },
  'update-opportunity': { method: 'PUT',  path: '/opportunities/{id}' },
  'search-opportunity': { method: 'GET',  path: '/opportunities/search', location: 'location_id' },
};

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

async function julia(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: 503, json: { error: 'Julia needs ANTHROPIC_API_KEY in Vercel' } };
  // The API wants alternating roles; the page can send two user turns
  // in a row (its standing instructions, then the new message).
  const merged = [];
  for (const m of body.messages || []) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n\n' + m.content;
    else merged.push({ role: m.role, content: m.content });
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: JULIA_MODEL, max_tokens: 1500, messages: merged, tools: body.tools || [] }),
  });
  const json = await r.json();
  return { status: r.ok ? 200 : 502, json };
}

async function highlevel(body) {
  const token = process.env.HIGHLEVEL_TOKEN;
  if (!token) return { status: 503, json: { error: 'HighLevel needs HIGHLEVEL_TOKEN in Vercel' } };
  const op = HL_OPS[body.operationId];
  if (!op) return { status: 400, json: { error: 'unsupported HighLevel operation: ' + body.operationId } };
  const params = body.params || {};
  const path = op.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String((params.path || {})[k] || '')));
  const q = new URLSearchParams();
  if (op.location) q.set(op.location, HL_LOCATION);
  for (const [k, v] of Object.entries(params.query || {})) if (v != null) q.set(k, String(v));
  const url = HL_BASE + path + (q.toString() ? '?' + q : '');
  const init = { method: op.method, headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' } };
  if (op.method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(params.body || {}); }
  const r = await fetch(url, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.ok ? 200 : 502, json: r.ok ? json : { error: (json && json.message) || ('HighLevel ' + r.status) } };
}

async function stripe(body) {
  const key = process.env.STRIPE_READ_KEY;
  if (!key) return { status: 503, json: { error: 'Stripe needs STRIPE_READ_KEY in Vercel' } };
  const p = body.parameters || {};
  const q = new URLSearchParams({ status: 'active', limit: String(Math.min(100, Number(p.limit) || 100)) });
  if (p.starting_after) q.set('starting_after', String(p.starting_after));
  const r = await fetch('https://api.stripe.com/v1/subscriptions?' + q, { headers: { Authorization: 'Bearer ' + key } });
  const json = await r.json();
  return { status: r.ok ? 200 : 502, json: r.ok ? json : { error: (json.error && json.error.message) || 'Stripe ' + r.status } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'invalid session' });

  const body = readBody(req);
  try {
    const out = body.action === 'julia' ? await julia(body)
      : body.action === 'hl' ? await highlevel(body)
      : body.action === 'stripe' ? await stripe(body)
      : { status: 400, json: { error: 'unknown action' } };
    return res.status(out.status).json(out.json);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
