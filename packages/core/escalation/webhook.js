// Generic webhook escalation: POSTs the handoff as JSON. Point it at n8n, Zapier,
// Make, Slack (via a workflow), your helpdesk or your own API.
//
// Body: { callId, callerPhone, didNumber, caller, facts, conversation, summary, reason, at }
// If a secret is set it is sent as `X-Webhook-Secret`.
function webhookNotifier({ url, secret = '', timeoutMs = 15000, headers = {} } = {}) {
  if (!url) throw new Error('webhookNotifier: url is required');
  return {
    name: 'webhook',
    async notify(handoff) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}), ...headers },
        body: JSON.stringify(handoff),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
      console.log(`[ESCALATION:webhook] delivered (${r.status})`);
    },
  };
}

module.exports = { webhookNotifier };
