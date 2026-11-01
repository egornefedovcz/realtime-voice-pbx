// Example agent for a fictional pottery studio. Shows every extension point:
//   instructions + file knowledge base, greeting, caller lookup, transcript hook
//   (inject verified data before the model answers), tools, escalation, onCallEnd.
const path = require('path');
const { defineAgent, fileKnowledge, isWithinHours } = require('../../packages/core');
const { notifiersFromEnv } = require('../../packages/core/escalation');
const { GREETING, VOICE_RULES, BUSINESS } = require('./prompt');
const { lookupCaller, findOrderInTranscript, upcomingClasses } = require('./lookup');

const knowledge = fileKnowledge(process.env.KNOWLEDGE_FILE || path.join(__dirname, 'knowledge.md'));
const HOURS = { timeZone: process.env.BUSINESS_TIMEZONE || 'America/New_York', days: [1, 2, 3, 4, 5], from: 9, to: 17 };

module.exports = defineAgent({
  name: BUSINESS,
  greeting: GREETING,

  instructions: () => {
    let rules = VOICE_RULES;
    if (!isWithinHours(HOURS)) {
      rules += '\n\nOUTSIDE BUSINESS HOURS: colleagues are not available right now. Do not promise a call back today — say they will get back to the caller on the next business day.';
    }
    return `${rules}\n\n${knowledge(rules.length)}`;
  },

  lookupCaller,

  // Runs after every caller sentence, before the model answers. Whatever you
  // return is injected as an internal [SYSTEM] note. Keep it fast (< 300 ms).
  async onTranscript(text, call) {
    const order = await findOrderInTranscript(text);
    if (!order) return [];
    call.facts.orderNumber = order.number; // verified → used by the escalation summary
    return [`Order found: ${JSON.stringify(order)}`];
  },

  tools: [
    {
      name: 'upcoming_classes',
      description: 'Lists upcoming classes with free seats and prices. Optionally filter by class title.',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'Part of the class title, e.g. "wheel"' } }, required: [] },
      handler: async (args) => ({ classes: await upcomingClasses(args), note: 'Next 10 at most, not a complete list.' }),
    },
    {
      name: 'leave_message',
      description: 'Passes a message to the human team (they reply on the next business day). Use when a colleague has to follow up.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          contact: { type: 'string', description: 'E-mail or phone for the reply; "this number" = the caller\'s number' },
          summary: { type: 'string', description: 'Short summary of the request' },
        },
        required: ['summary'],
      },
      async handler(args, call, { handoff }) {
        Object.assign(call.facts, { messageFrom: args.name, replyTo: args.contact, request: args.summary });
        handoff('message left');
        return { status: 'delivered' };
      },
    },
  ],

  escalation: notifiersFromEnv({ agentName: `${BUSINESS} voice assistant` }),
  ownContacts: ['hello@example.com'],

  async onCallEnd(call) {
    // e.g. send an SMS "we got your request" when a transfer was not answered
    if (call.staffMissed) console.log(`[EXAMPLE] call ${call.id}: transfer missed — a follow-up SMS could go out here`);
  },
});
