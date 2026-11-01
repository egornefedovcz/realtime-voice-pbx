#!/usr/bin/env node
// Call-recording transcription (run from cron, e.g. every 15 minutes).
//
// Asterisk records each call with MixMonitor into
//   RECORDINGS_DIR/YYYY/MM/DD/HHMMSS-<caller>-<uniqueid>.wav
// Finished recordings (unchanged for 2 minutes) → ffmpeg (mono 16 kHz mp3) →
// OpenAI transcription → short JSON summary → TRANSCRIPTS_DIR/YYYY-MM-DD/<name>.json.
// Nothing is sent anywhere else. Transcripts older than RETENTION_DAYS are deleted
// (they contain personal data). Requires ffmpeg + ffprobe and Node 18+.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { str, num, OPENAI_API_KEY } = require('../../packages/core/config');

const RECORDINGS = str('RECORDINGS_DIR', '/var/spool/asterisk/monitor');
const DATA = path.resolve(str('TRANSCRIPTS_DIR', path.join(__dirname, 'data')));
const RETENTION_DAYS = num('RETENTION_DAYS', 90);
const MIN_BYTES = num('MIN_RECORDING_BYTES', 40000);      // < ~2 s of audio = empty call
const MODEL = str('TRANSCRIPTION_MODEL', 'gpt-4o-transcribe');
const LANGUAGE = str('TRANSCRIBE_LANGUAGE');
const SUMMARY_MODEL = str('SUMMARY_MODEL', 'gpt-4o');
const SUMMARY_LANGUAGE = str('SUMMARY_LANGUAGE', 'English');
const BUSINESS_CONTEXT = str('BUSINESS_CONTEXT', 'a small business');

if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY is missing'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const walk = (d) => (fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.wav') ? [path.join(d, e.name)] : []))
  : []);

async function transcribe(wav) {
  const mp3 = path.join(os.tmpdir(), `call-transcript-${process.pid}.mp3`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3]);
  const seconds = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString().trim() || 0;
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'call.mp3');
  fd.append('model', MODEL);
  if (LANGUAGE) fd.append('language', LANGUAGE);
  fd.append('response_format', 'text');
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: fd, signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) throw new Error(`transcription ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { text: (await r.text()).trim(), seconds: Math.round(seconds) };
  } finally {
    fs.rmSync(mp3, { force: true });
  }
}

async function summarize(text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a customer-support analyst for ${BUSINESS_CONTEXT}. You get the transcript of a phone call (an AI assistant and possibly a human colleague). ` +
            'Return JSON: {"topic": short topic (max 6 words), "product": product, service or location mentioned or null, ' +
            '"summary": 1-2 sentences without names or phone numbers, "problem": what bothered the caller or what they did not know (null if nothing), ' +
            '"website_suggestion": a concrete website text change that would have prevented the call, or null, ' +
            '"process_suggestion": a change to the service or process, or null, "resolved": true/false}. ' +
            `Write the values in ${SUMMARY_LANGUAGE}. Be factual, invent nothing.`,
        },
        { role: 'user', content: text.slice(0, 30000) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`summary ${r.status}`);
  return JSON.parse((await r.json()).choices[0].message.content);
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  let n = 0;
  for (const wav of walk(RECORDINGS).sort()) {
    const st = fs.statSync(wav);
    const rel = path.relative(RECORDINGS, wav);
    const day = rel.split(path.sep).slice(0, 3).join('-');
    const out = path.join(DATA, day, `${path.basename(wav, '.wav')}.json`);
    if (fs.existsSync(out) || now - st.mtimeMs < 120000 || now - st.mtimeMs > RETENTION_DAYS * 864e5) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (st.size < MIN_BYTES) { fs.writeFileSync(out, JSON.stringify({ file: rel, empty: true })); continue; }
    try {
      const t = await transcribe(wav);
      const s = t.text.length > 40 ? await summarize(t.text) : null;
      fs.writeFileSync(out, JSON.stringify({
        file: rel, startedAt: new Date(st.mtimeMs - t.seconds * 1000).toISOString(), seconds: t.seconds, transcript: t.text, summary: s,
      }, null, 1));
      n++;
      log('OK', rel, `${t.seconds} s`, s ? s.topic : '(short)');
    } catch (e) { log('FAIL', rel, e.message); }
  }
  // retention: delete transcripts older than RETENTION_DAYS
  for (const d of fs.readdirSync(DATA)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && now - new Date(d).getTime() > RETENTION_DAYS * 864e5) fs.rmSync(path.join(DATA, d), { recursive: true });
  }
  if (n) log('transcribed', n);
})().catch((e) => { console.error(e.message); process.exit(1); });
