// ============================================================
// POST /api/nova-chat
// Body: { messages: [{role:'user'|'assistant', content:string}, ...], context?: object }
// Header: Authorization: Bearer <supabase access token>
//
// Server-side proxy for Nova (nova-lite.html) so the Anthropic API
// key lives only in a Vercel env var, never in the browser. Requires
// a signed-in dashboard session (same check as send-push) so a
// stranger who finds the URL can't run up the API bill.
//
// Needs ANTHROPIC_API_KEY set in Vercel. `context` is whatever
// dashboard data the client wants Nova to see (food/water/gym/
// finance/etc) — it's just data, gets embedded in the system prompt.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const SYS =
  "You are Nova, a personal mentor living inside the user's life-tracking dashboard. " +
  "You can see their saved data (food, water, gym, finance, sleep, goals, etc). " +
  "Give honest, specific, encouraging guidance. " +
  "Answer in short bullet points starting with '- ', few words each, plain language. " +
  "Wrap key words and numbers in **double asterisks**. " +
  "End with one '- Do today:' bullet giving the single action, unless the user is just chatting. ";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server yet' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'invalid session' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'no messages' });

  // Keep the request small and on-topic: last 20 turns, plus the
  // dashboard context snapshot in the system prompt.
  const trimmed = messages.slice(-20).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000),
  }));
  const context = (body && body.context) || {};

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYS + 'Dashboard data as JSON:\n' + JSON.stringify(context).slice(0, 8000),
        messages: trimmed,
      }),
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (json.error && json.error.message) || 'Anthropic API error' });
    const reply = (json.content && json.content[0] && json.content[0].text) || '';
    return res.status(200).json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
