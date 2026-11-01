// Short call summary for the human who picks up an escalated request.
// Verified facts (set by your tools / lookups in call.facts) are passed to the
// model separately: numbers in the transcript come from speech recognition and
// are often garbled, verified facts are not.
const { OPENAI_API_KEY, SUMMARY_MODEL } = require('./config');

const formatConversation = (log, agentLabel = 'Agent') =>
  (log || []).map((e) => `${e.role === 'customer' ? 'Caller' : agentLabel}: ${e.text}`).join('\n');

function formatFacts(facts) {
  return Object.entries(facts || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

async function summarizeCall({ conversation, facts, language = 'English', ownContacts = [] }) {
  if (!OPENAI_API_KEY || !conversation || !conversation.length) return '';
  const verified = formatFacts(facts);
  const system = `You are a customer support assistant. From the phone call transcript, write a very short summary in ${language} for the colleague who will handle it. ` +
    'Format: 2-5 bullet points starting with "-". First bullet "Request: <one sentence>". Then key details (order number, status, date, email, phone, location). ' +
    'RULES: copy order numbers, e-mails and phone numbers EXACTLY from VERIFIED FACTS — numbers in the transcript come from speech recognition and are often garbled. ' +
    (ownContacts.length ? `Never list these company contacts as the caller's details: ${ownContacts.join(', ')}. ` : '') +
    'Omit anything that is neither verified nor said — do not write "not provided". No intro, bullets only. Invent nothing.';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: (verified ? `VERIFIED FACTS:\n${verified}\n\n` : '') + `TRANSCRIPT:\n${formatConversation(conversation)}` },
        ],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch (_) {
    return '';
  }
}

module.exports = { summarizeCall, formatConversation, formatFacts };
