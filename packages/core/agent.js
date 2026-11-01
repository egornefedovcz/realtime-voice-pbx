// Agent definition: everything business-specific lives here, the realtime core
// and the transports stay generic. See README "Write your own agent".
//
// @typedef {Object} CallState            (passed to every hook)
// @property {string}  id                 transport call id
// @property {?string} callerPhone        caller id as delivered by the PBX (may be null)
// @property {?string} didNumber          dialled number, when the transport knows it
// @property {?Object} caller             record returned by lookupCaller()
// @property {Object}  facts              verified facts for the escalation summary (tools may add keys)
// @property {Array<{role:'customer'|'agent', text:string}>} conversation
// @property {Object}  data               free scratch space for your hooks
// @property {boolean} canTransfer        transport supports a live transfer right now
// @property {boolean} returnedNoAnswer   call came back after an unanswered transfer
// @property {boolean} staffMissed        a transfer was attempted but nobody answered
// @property {boolean} escalated          a handoff was sent to the escalation notifiers
//
// @typedef {Object} Tool
// @property {string} name
// @property {string} description
// @property {Object} parameters          JSON schema
// @property {(args:Object, call:CallState, ctl:{handoff:(reason:string)=>Promise<void>}) => Promise<Object>|Object} handler
// @property {(call:CallState) => boolean} [enabled]
//
// @typedef {Object} EscalationNotifier
// @property {string} name
// @property {(handoff:Object) => Promise<void>} notify
//   handoff = { callId, callerPhone, didNumber, caller, facts, conversation, summary, reason, at }

const DEFAULT_MESSAGES = {
  transferPrompt: 'LIVE TRANSFER: when the caller wants to talk to a person, an operator or a colleague, do NOT try to talk them out of it. Ask once, briefly, what it is about so you can pass it on (e.g. "I\'ll gladly transfer you. Can you tell me briefly what it\'s about?") and right after their answer (even if they decline to answer) call the tool transfer_to_human. If they insist a second time, are upset, or it is something you cannot solve, call the tool straight away. Do not announce anything before calling the tool. Tool result "transferring" → say only "Let me transfer you to a colleague, one moment please. If nobody is available, we will call you back." (in the caller\'s language). Result "nobody_available" → say right away that no colleague is available at the moment, offer to try to solve it together or to pass the request on so a colleague calls back, and ask which they prefer.',
  transferFailed: 'The transfer did not go through — the colleague did not pick up. Tell the caller right away that the colleague is unfortunately not available now, and offer to try to solve it together, or to pass the request on so a colleague calls back. Do not offer a transfer again.',
  returnedNoAnswer: 'TRANSFER FAILED: the caller already waited for a colleague but nobody picked up. Offer to try to solve it together, or to pass the request on so a colleague calls back. If they want a call back, find out briefly what it is about and say "I\'ll pass it on to my colleagues, they will get back to you." Do not offer a transfer again.',
};

const DEFAULT_RETURN_GREETING = "I'm sorry, my colleague is not available right now. Let's try to solve it together — or I can pass your request on and someone will call you back. Which would you prefer?";

// Sentences the AGENT says that mean "a human will follow up" → escalation is sent.
const DEFAULT_HANDOFF_PHRASES = [
  /\b(i'll|i will|we'll|we will|let me) (pass|forward|hand)\b[^.]*\b(colleague|team|support)/,
  /\b(colleague|colleagues|team|someone) will (call|get back|contact|reach)/,
  // Czech: "předám kolegům", "kolegové se Vám ozvou"
  /^(?=[\s\S]*(předám|předáme|předáv|predam|predame|predav))(?=[\s\S]*(koleg|support|podpor|tým|tym))/,
  /^(?=[\s\S]*(ozve|ozvou|ozveme))(?=[\s\S]*(koleg|support|podpor|tým|tym|vám|vam))/,
];

// Sentences that mean "I am transferring you NOW" — fallback when the model
// says it but forgets to call the tool. Verb BEFORE "you": an announcement for
// later ("then I'll transfer you…") must not trigger.
const DEFAULT_TRANSFER_PHRASES = [
  /\b(let me|i'll|i will) transfer you\b/,
  /(přepojím|prepojim|předám|predam) vás (na )?kolegyn/,
];

function defineAgent(def = {}) {
  if (typeof def.instructions !== 'function' && typeof def.instructions !== 'string') {
    throw new Error('agent.instructions (string or function) is required');
  }
  const asFn = (v) => (typeof v === 'function' ? v : () => v);
  return {
    name: def.name || 'voice-agent',
    instructions: asFn(def.instructions),
    greeting: asFn(def.greeting || 'Hello, how can I help you?'),
    returnGreeting: def.returnGreeting || DEFAULT_RETURN_GREETING,
    lookupCaller: def.lookupCaller || null,
    describeCaller: def.describeCaller || ((rec) =>
      `BACKGROUND: the calling number belongs to "${rec.name || 'unknown'}" in our records. ANYONE could be calling from this phone — do NOT assume the caller is this person and do NOT address them by this name until they identify themselves.`),
    waitForLookupMs: def.waitForLookupMs || 0,
    onTranscript: def.onTranscript || null,
    tools: def.tools || [],
    escalation: def.escalation || [],
    handoffPhrases: def.handoffPhrases || DEFAULT_HANDOFF_PHRASES,
    transferPhrases: def.transferPhrases || DEFAULT_TRANSFER_PHRASES,
    messages: { ...DEFAULT_MESSAGES, ...(def.messages || {}) },
    hallucinations: def.hallucinations || [],
    typingSound: def.typingSound !== false,
    summarize: def.summarize !== false,
    summaryLanguage: def.summaryLanguage || 'English',
    ownContacts: def.ownContacts || [],
    onCallEnd: def.onCallEnd || null,
    session: def.session || {},
  };
}

module.exports = { defineAgent, DEFAULT_MESSAGES, DEFAULT_HANDOFF_PHRASES, DEFAULT_TRANSFER_PHRASES };
