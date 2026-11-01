// Optional Chatwoot escalation adapter.
//
// * finds or creates the contact (by phone, then e-mail)
// * if the same customer already has an open/pending conversation in one of
//   `dedupeInboxIds` (last 14 days), the call is appended there as a private
//   note instead of opening a duplicate ticket (first listed inbox wins)
// * otherwise opens a new conversation in `inboxId` with the caller's first
//   sentence as the incoming message and the summary + transcript as a private note
// * marks the conversation high priority
const { formatConversation } = require('../summary');

function chatwootNotifier({ url, token, accountId = 1, inboxId, dedupeInboxIds = [], dedupeDays = 14, agentName = 'Voice agent' } = {}) {
  if (!url || !token || !inboxId) throw new Error('chatwootNotifier: url, token and inboxId are required');
  const base = `${url.replace(/\/+$/, '')}/api/v1/accounts/${accountId}`;
  const preferred = dedupeInboxIds.length ? dedupeInboxIds.map(Number) : [Number(inboxId)];

  async function cw(method, path, body) {
    const r = await fetch(base + path, {
      method,
      headers: { api_access_token: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: r.status, data };
  }

  const search = async (q) => ((await cw('GET', `/contacts/search?q=${encodeURIComponent(q)}&include_contacts=true`)).data?.payload) || [];

  return {
    name: 'chatwoot',
    async notify(h) {
      const name = h.caller?.name || (h.callerPhone ? `Caller ${h.callerPhone}` : 'Unknown caller');
      const email = h.caller?.email || null;
      const phone = h.callerPhone || h.caller?.phone || null;

      const contactIds = new Set();
      for (const term of [phone, email].filter(Boolean)) {
        for (const c of (await search(term)).slice(0, 5)) contactIds.add(c.id);
      }
      let contactId = [...contactIds][0] || null;
      if (!contactId) {
        const c = await cw('POST', '/contacts', { name, email, phone_number: phone, inbox_id: Number(inboxId) });
        contactId = c.data?.payload?.contact?.id || c.data?.id || null;
        if (contactId) contactIds.add(contactId);
      }
      if (!contactId) throw new Error('could not find or create the contact');

      const transcript = formatConversation(h.conversation, agentName) || '(empty)';
      const details = [`Phone: ${phone || '—'}`, ...(email ? [`E-mail: ${email}`] : []), `Reason: ${h.reason}`];

      // Repeated call from the same customer → append to the open conversation
      const candidates = [];
      try {
        for (const cid of contactIds) {
          const r = await cw('GET', `/contacts/${cid}/conversations`);
          for (const cv of r.data?.payload || []) {
            const t = (cv.last_activity_at || cv.timestamp || 0) * 1000;
            if (['open', 'pending'].includes(cv.status) && preferred.includes(cv.inbox_id) && Date.now() - t < dedupeDays * 864e5) {
              candidates.push({ id: cv.id, rank: preferred.indexOf(cv.inbox_id), t });
            }
          }
        }
      } catch (e) { console.error('[ESCALATION:chatwoot] dedupe lookup failed:', e.message); }
      candidates.sort((a, b) => a.rank - b.rank || b.t - a.t);

      let convId = candidates[0]?.id;
      const header = convId
        ? `📞 ANOTHER CALL FROM THE SAME CUSTOMER (${agentName}) — appended here, no new ticket`
        : `🎙️ ${agentName.toUpperCase()} — phone request handed over`;
      if (!convId) {
        const firstSentence = (h.conversation.find((e) => e.role === 'customer') || {}).text || 'Phone request';
        const conv = await cw('POST', '/conversations', {
          source_id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          inbox_id: Number(inboxId), contact_id: contactId,
          message: { content: firstSentence, message_type: 'incoming' },
        });
        convId = conv.data?.id;
        if (!convId) throw new Error(`could not create conversation (HTTP ${conv.status})`);
      }
      const note = [header, ...(h.summary ? ['', 'SUMMARY:', h.summary, '', '-'] : []), ...details, '', 'Transcript:', transcript].join('\n');
      await cw('POST', `/conversations/${convId}/messages`, { content: note, message_type: 'outgoing', private: true });
      await cw('POST', `/conversations/${convId}/toggle_priority`, { priority: 'high' }).catch(() => {});
      console.log(`[ESCALATION:chatwoot] conversation ${convId}${candidates.length ? ' (appended)' : ' (new)'}`);
    },
  };
}

module.exports = { chatwootNotifier };
