// Escalation notifiers and a helper that builds the ones configured in the environment.
const { str, num } = require('../config');
const { webhookNotifier } = require('./webhook');
const { emailNotifier } = require('./email');
const { chatwootNotifier } = require('./chatwoot');

// A notifier that only logs — handy while developing.
const consoleNotifier = () => ({
  name: 'console',
  notify: async (h) => console.log('[ESCALATION:console]', JSON.stringify({ reason: h.reason, callerPhone: h.callerPhone, summary: h.summary })),
});

function notifiersFromEnv({ agentName } = {}) {
  const list = [];
  if (str('ESCALATION_WEBHOOK_URL')) {
    list.push(webhookNotifier({ url: str('ESCALATION_WEBHOOK_URL'), secret: str('ESCALATION_WEBHOOK_SECRET') }));
  }
  if (str('SMTP_HOST') && str('ESCALATION_EMAIL_TO')) {
    list.push(emailNotifier({
      host: str('SMTP_HOST'), port: num('SMTP_PORT', 587), user: str('SMTP_USER'), pass: str('SMTP_PASS'),
      from: str('ESCALATION_EMAIL_FROM'), to: str('ESCALATION_EMAIL_TO'), agentName,
    }));
  }
  if (str('CHATWOOT_URL') && str('CHATWOOT_API_TOKEN') && str('CHATWOOT_INBOX_ID')) {
    list.push(chatwootNotifier({
      url: str('CHATWOOT_URL'), token: str('CHATWOOT_API_TOKEN'),
      accountId: num('CHATWOOT_ACCOUNT_ID', 1), inboxId: num('CHATWOOT_INBOX_ID', 0),
      dedupeInboxIds: str('CHATWOOT_DEDUPE_INBOX_IDS').split(',').map((x) => Number(x.trim())).filter(Boolean),
      agentName,
    }));
  }
  if (!list.length) list.push(consoleNotifier());
  return list;
}

module.exports = { notifiersFromEnv, consoleNotifier, webhookNotifier, emailNotifier, chatwootNotifier };
