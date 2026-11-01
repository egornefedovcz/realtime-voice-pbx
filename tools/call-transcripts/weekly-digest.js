#!/usr/bin/env node
// Weekly digest from call summaries: recurring topics and concrete suggestions
// for the website and the service. Uses only the summaries (no transcripts,
// names or numbers). Nothing changes automatically — a human decides.
//
//   node weekly-digest.js [--days=7] [--preview]
// Writes digest.html next to the data directory; if DIGEST_WEBHOOK_URL is set
// (and not --preview) POSTs { subject, html, digest } there (n8n, Zapier, mailer…).
const fs = require('fs');
const path = require('path');
const { str, OPENAI_API_KEY } = require('../../packages/core/config');

const DATA = path.resolve(str('TRANSCRIPTS_DIR', path.join(__dirname, 'data')));
const DAYS = +((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1] || 7);
const PREVIEW = process.argv.includes('--preview');
const BUSINESS_CONTEXT = str('BUSINESS_CONTEXT', 'a small business');
const SUMMARY_LANGUAGE = str('SUMMARY_LANGUAGE', 'English');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const since = Date.now() - DAYS * 864e5;
  const calls = [];
  for (const d of fs.existsSync(DATA) ? fs.readdirSync(DATA) : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d).getTime() < since - 864e5) continue;
    for (const f of fs.readdirSync(path.join(DATA, d))) {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, d, f), 'utf8'));
      if (j.summary && new Date(j.startedAt).getTime() >= since) calls.push({ day: d, seconds: j.seconds, ...j.summary });
    }
  }
  if (!calls.length) { console.log(`no transcribed calls in the last ${DAYS} days`); return; }

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: str('SUMMARY_MODEL', 'gpt-4o'),
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a customer-experience analyst for ${BUSINESS_CONTEXT}. You get summaries of a week of support calls. Find recurring topics and suggest concrete changes. ` +
            'Return JSON {"topics":[{"topic":"…","count":N}], "website":[{"where":"page or page type","what":"concrete text or change that would prevent these calls — mainly setting the right expectations","why":"…","calls":N}], ' +
            '"service":[{"what":"…","why":"…","calls":N}], "insight":"1-2 sentences"}. Sort by number of calls. Only suggestions backed by calls, invent nothing. ' +
            `Write in ${SUMMARY_LANGUAGE}.`,
        },
        { role: 'user', content: JSON.stringify(calls).slice(0, 60000) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const v = JSON.parse((await r.json()).choices[0].message.content);
  const minutes = Math.round(calls.reduce((a, c) => a + (c.seconds || 0), 0) / 60);
  const resolved = calls.filter((c) => c.resolved).length;
  const li = (a, f) => (a || []).map(f).join('');
  const html = '<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.55;max-width:680px">' +
    '<h2 style="margin:0 0 8px">Support calls — suggestions to review</h2>' +
    `<p style="margin:0 0 16px">Last ${DAYS} days: ${calls.length} calls, ${minutes} min, resolved on the call: ${resolved}. Nothing was changed automatically.</p>` +
    (v.insight ? `<p><strong>Insight:</strong> ${esc(v.insight)}</p>` : '') +
    `<h3>Top topics</h3><ul>${li(v.topics, (t) => `<li>${esc(t.topic)} (${esc(t.count)}×)</li>`)}</ul>` +
    `<h3>Website</h3><ol>${li(v.website, (n) => `<li><strong>${esc(n.where)}:</strong> ${esc(n.what)}<br><small>${esc(n.why)} · ${esc(n.calls)}× in calls</small></li>`)}</ol>` +
    `<h3>Service</h3><ol>${li(v.service, (n) => `<li>${esc(n.what)}<br><small>${esc(n.why)} · ${esc(n.calls)}× in calls</small></li>`)}</ol></div>`;
  const outFile = path.join(path.dirname(DATA), 'digest.html');
  fs.writeFileSync(outFile, html);
  if (PREVIEW || !str('DIGEST_WEBHOOK_URL')) { console.log(JSON.stringify(v, null, 1)); console.log('written', outFile); return; }
  const s = await fetch(str('DIGEST_WEBHOOK_URL'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: `Support calls — suggestions (${calls.length} calls)`, html, digest: v }),
  });
  console.log('webhook', s.status);
})().catch((e) => { console.error(e.message); process.exit(1); });
