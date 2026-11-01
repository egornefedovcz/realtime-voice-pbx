// Agent whose knowledge, caller lookup and tools live in YOUR backend.
// The voice service stays generic; your app (shop, CRM, booking system) exposes
// three endpoints protected by a shared secret header:
//
//   GET  {BACKEND_URL}/voice/context                 -> text/plain knowledge for the prompt (cached 10 min)
//   GET  {BACKEND_URL}/voice/caller?phone=+1555...   -> { "customer": {...} | null, "orders": [...] }
//   POST {BACKEND_URL}/voice/tool  { name, input, caller } -> JSON result for the model
//
//   AGENT=./examples/http-backend BACKEND_URL=https://shop.example.com/api BACKEND_SECRET=... npm start
const { defineAgent } = require('../../packages/core');
const { notifiersFromEnv } = require('../../packages/core/escalation');

const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const headers = { 'x-voice-secret': process.env.BACKEND_SECRET || '' };

let cache = { at: 0, text: '' };
async function context() {
  if (Date.now() - cache.at < 10 * 60e3 && cache.text) return cache.text;
  try {
    const r = await fetch(`${BACKEND_URL}/voice/context`, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) cache = { at: Date.now(), text: await r.text() };
  } catch (e) { console.error('[BACKEND] context:', e.message); }
  return cache.text;
}

async function tool(name, input, call) {
  const r = await fetch(`${BACKEND_URL}/voice/tool`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, input, caller: call.callerPhone || '' }), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`backend HTTP ${r.status}`);
  return r.json();
}

const RULES = `You are a phone assistant. Speak briefly and naturally: one to three sentences, then let the caller talk.
No links, bullets or markdown. Never make up numbers or e-mails; let the caller dictate and repeat them.
For order status use the tool order_status. If you cannot help, or the caller wants a human, call leave_message.
Reply in the caller's language.`;

module.exports = defineAgent({
  name: 'http-backend',
  // Wait briefly for the caller lookup so the greeting can mention their latest order
  waitForLookupMs: 1500,
  async lookupCaller(phone) {
    const r = await fetch(`${BACKEND_URL}/voice/caller?phone=${encodeURIComponent(phone)}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.orders?.length || j.customer ? { name: j.customer?.name, email: j.customer?.email, orders: j.orders || [] } : null;
  },
  describeCaller: (rec) => `CALLER'S ORDERS (looked up by the calling number — this is sufficient verification): ${JSON.stringify(rec.orders)}. Newest first. Do not read out the address or other personal data.`,
  greeting: (call) => {
    const o = call.caller?.orders?.[0];
    return o ? `Hello, this is the AI assistant. I can see your order from ${o.date}. Are you calling about it?` : 'Hello, this is the AI assistant. How can I help you?';
  },
  instructions: async () => `${RULES}\n\n${await context()}`,
  tools: [
    {
      name: 'order_status',
      description: 'Order status by order number (or its last 6 digits) plus one verification detail: e-mail, phone or surname.',
      parameters: { type: 'object', properties: { order_number: { type: 'string' }, verify: { type: 'string' } }, required: ['order_number', 'verify'] },
      handler: (args, call) => tool('order_status', args, call),
    },
    {
      name: 'leave_message',
      description: 'Leaves a message for the team (they reply on business days).',
      parameters: { type: 'object', properties: { name: { type: 'string' }, contact: { type: 'string' }, order_number: { type: 'string' }, summary: { type: 'string' } }, required: ['summary'] },
      handler: (args, call) => tool('leave_message', args, call),
    },
  ],
  escalation: notifiersFromEnv({ agentName: 'Voice assistant' }),
  typingSound: false,
});
