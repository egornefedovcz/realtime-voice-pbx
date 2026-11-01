// Realtime core against a fake OpenAI WebSocket and a fake transport.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { startCallSession } = require('../packages/core/realtime');
const { defineAgent } = require('../packages/core/agent');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); };

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; FakeWs.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  server(event) { this.emit('message', JSON.stringify(event)); }
  types() { return this.sent.map((e) => e.type); }
}

function fakeSession(extra = {}) {
  const cbs = { ready: [], audioIn: [], mark: [], hangup: [] };
  const s = {
    callId: 't1', callerPhone: '+15550100', didNumber: '100',
    audio: [], marks: [], cleared: 0, escalations: [],
    onReady: (f) => cbs.ready.push(f), onAudioIn: (f) => cbs.audioIn.push(f), onMark: (f) => cbs.mark.push(f), onHangup: (f) => cbs.hangup.push(f),
    sendAudio(b) { s.audio.push(b); }, sendMark(n) { s.marks.push(n); }, clearAudio() { s.cleared++; },
    escalate: async (ctx) => { s.escalations.push(ctx); return false; }, hangup() {},
    fire: (k, ...a) => cbs[k].forEach((f) => f(...a)),
    ...extra,
  };
  return s;
}

async function startedCall(agentDef, sessionExtra) {
  const notified = [];
  const agent = defineAgent({ summarize: false, escalation: [{ name: 'test', notify: async (h) => notified.push(h) }], ...agentDef });
  const session = fakeSession(sessionExtra);
  const call = startCallSession(session, agent, { WebSocketImpl: FakeWs, url: 'ws://fake' });
  const ws = FakeWs.last;
  session.fire('ready');
  ws.emit('open');
  await flush();
  return { call, session, ws, notified };
}

async function finishGreeting(ws, session) {
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_audio.delta', delta: Buffer.from([1, 2, 3]).toString('base64') });
  ws.server({ type: 'response.output_audio.done' });
  ws.server({ type: 'response.done' });
  await flush();
  session.fire('mark', 'greeting-done');
}

test('greeting first, VAD only after the greeting', async () => {
  const { ws, session } = await startedCall({ instructions: 'Be nice.', greeting: 'Hello there.' });
  const first = ws.sent[0];
  assert.strictEqual(first.type, 'session.update');
  assert.strictEqual(first.session.audio.input.turn_detection, null, 'no VAD during greeting');
  assert.match(first.session.instructions, /Hello there\./);
  assert.match(first.session.instructions, /\+15550100/, 'caller number in instructions');
  assert.strictEqual(ws.sent[1].type, 'response.create');

  // caller audio before the greeting finished playing is not forwarded
  session.fire('audioIn', Buffer.from([9]));
  assert(!ws.types().includes('input_audio_buffer.append'));

  await finishGreeting(ws, session);
  assert.deepStrictEqual(session.marks, ['greeting-done']);
  const vad = ws.sent.filter((e) => e.type === 'session.update').pop();
  assert.strictEqual(vad.session.audio.input.turn_detection.type, 'server_vad');
  assert.strictEqual(vad.session.audio.input.turn_detection.create_response, false);
  session.fire('audioIn', Buffer.from([9]));
  assert(ws.types().includes('input_audio_buffer.append'));
});

test('transcript hook injects a [SYSTEM] note before the answer; hallucinations ignored', async () => {
  const { ws, session, call } = await startedCall({
    instructions: 'x',
    onTranscript: async (text) => (text.includes('100234') ? ['Order found: {"number":"100234"}'] : []),
  });
  await finishGreeting(ws, session);
  ws.sent.length = 0;

  ws.server({ type: 'input_audio_buffer.committed' });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Titulky vytvořil JohnyX' });
  await flush();
  assert.deepStrictEqual(ws.types(), [], 'no reply to a hallucination');

  ws.server({ type: 'input_audio_buffer.committed' });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'my order is 100234' });
  await flush();
  assert.deepStrictEqual(ws.types(), ['conversation.item.create'], 'note first, response waits for confirmation');
  assert.match(ws.sent[0].item.content[0].text, /^\[SYSTEM: Order found/);
  assert(session.audio.length >= 2, 'typing sound queued for a dictated number');
  ws.server({ type: 'conversation.item.added' });
  assert.deepStrictEqual(ws.types(), ['conversation.item.create', 'response.create']);

  ws.server({ type: 'input_audio_buffer.committed' });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'thanks' });
  await flush();
  assert.strictEqual(ws.types().at(-1), 'response.create', 'plain turn → immediate response');
  assert.deepStrictEqual(call.conversation.map((e) => e.role), ['customer', 'customer']);
});

test('barge-in cancels the response and flushes transport audio', async () => {
  const { ws, session } = await startedCall({ instructions: 'x' });
  await finishGreeting(ws, session);
  ws.server({ type: 'response.created' });
  ws.server({ type: 'input_audio_buffer.speech_started' });
  assert(ws.types().includes('response.cancel'));
  assert.strictEqual(session.cleared, 1);
});

test('tools run and outputs are flushed at response.done', async () => {
  const seen = [];
  const { ws, session } = await startedCall({
    instructions: 'x',
    tools: [{ name: 'echo', description: 'd', parameters: { type: 'object', properties: {} }, handler: async (a) => { seen.push(a); return { ok: a.v }; } }],
  });
  await finishGreeting(ws, session);
  const upd = ws.sent.filter((e) => e.type === 'session.update').pop();
  assert.deepStrictEqual(upd.session.tools.map((t) => t.name), ['echo']);
  ws.sent.length = 0;
  ws.server({ type: 'response.function_call_arguments.done', name: 'echo', call_id: 'c1', arguments: '{"v":7}' });
  ws.server({ type: 'response.done' });
  await flush();
  assert.deepStrictEqual(seen, [{ v: 7 }]);
  assert.deepStrictEqual(ws.types(), ['conversation.item.create', 'response.create']);
  assert.strictEqual(ws.sent[0].item.type, 'function_call_output');
  assert.deepStrictEqual(JSON.parse(ws.sent[0].item.output), { ok: 7 });
});

test('handoff phrase escalates once', async () => {
  const { ws, session, notified } = await startedCall({ instructions: 'x' });
  await finishGreeting(ws, session);
  ws.server({ type: 'response.output_audio_transcript.done', transcript: "I'll pass it on to my colleagues, they will get back to you." });
  ws.server({ type: 'response.output_audio_transcript.done', transcript: 'Colleagues will call you back.' });
  await flush();
  assert.strictEqual(notified.length, 1);
  assert.strictEqual(notified[0].callerPhone, '+15550100');
  assert.strictEqual(notified[0].conversation.length, 1);
});

test('live transfer: tool → sentence plays → escalate; failure continues with the AI', async () => {
  const { ws, session, call, notified } = await startedCall(
    { instructions: 'x' },
    { canTransfer: true, transferAvailable: async () => true },
  );
  await finishGreeting(ws, session);
  const upd = ws.sent.filter((e) => e.type === 'session.update').pop();
  assert(upd.session.tools.some((t) => t.name === 'transfer_to_human'));
  ws.server({ type: 'response.function_call_arguments.done', name: 'transfer_to_human', call_id: 'c2', arguments: '{}' });
  ws.server({ type: 'response.done' });
  await flush();
  assert.strictEqual(notified.length, 1, 'handoff sent when the transfer starts');
  ws.sent.length = 0;
  session.fire('mark', 'response-done');
  await flush();
  assert.strictEqual(session.escalations.length, 1);
  assert(call.staffMissed, 'escalate() returned false → staffMissed');
  assert.deepStrictEqual(ws.types(), ['conversation.item.create', 'response.create']);
  assert.match(ws.sent[0].item.content[0].text, /did not go through/);
});
