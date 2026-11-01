// Transport adapters (without a PBX) and the example agents.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createYeastarSession, authorize } = require('../transports/yeastar');
const { frame, uuidStr } = require('../transports/asterisk-audiosocket');
const { normalizePhone, operatorDialTarget } = require('../transports/asterisk-ari/routing');
const { pcm16ToUlaw } = require('../packages/core/audio');

class FakeSock extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close'); }
}

test('yeastar: auth, call setup, PCM16 <-> µ-law, emulated marks', async () => {
  process.env.YEASTAR_SECRET = 's3cret';
  assert(authorize({ headers: { authorization: 'Bearer s3cret' } }).ok);
  assert(!authorize({ headers: { secret: 'nope' } }).ok);

  const ws = new FakeSock();
  const s = createYeastarSession(ws);
  const got = { ready: 0, audio: [], marks: [], hangup: 0 };
  s.onReady(() => got.ready++);
  s.onAudioIn((b) => got.audio.push(b));
  s.onMark((n) => got.marks.push(n));
  s.onHangup(() => got.hangup++);

  const pcm = Buffer.alloc(320, 0);
  ws.emit('message', Buffer.from(JSON.stringify({ callid: 'abc', channelid: 'ch1', number: '+15550100', status: 'process', audio: pcm.toString('base64') })));
  ws.emit('message', Buffer.from(JSON.stringify({ callid: 'abc', channelid: 'ch2', status: 'process', audio: pcm.toString('base64') })));
  assert.strictEqual(got.ready, 1);
  assert.strictEqual(s.callerPhone, '+15550100');
  assert.strictEqual(got.audio.length, 1, 'only the locked channel is forwarded');
  assert.deepStrictEqual(got.audio[0], pcm16ToUlaw(pcm));

  s.sendAudio(Buffer.alloc(400, 0xff)); // 50 ms of µ-law
  assert.strictEqual(ws.sent.length, 1);
  assert.strictEqual(Buffer.from(ws.sent[0].audio, 'base64').length, 800, 'sent as PCM16');
  s.sendMark('greeting-done');
  assert.deepStrictEqual(got.marks, []);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(got.marks, ['greeting-done'], 'mark fires after playback time');

  ws.emit('message', Buffer.from(JSON.stringify({ callid: 'abc', status: 'end' })));
  ws.close();
  assert.strictEqual(got.hangup, 1, 'hangup emitted once');
});

test('audiosocket framing helpers', () => {
  const f = frame(0x10, Buffer.from([1, 2]));
  assert.deepStrictEqual([...f], [0x10, 0, 2, 1, 2]);
  assert.deepStrictEqual([...frame(0x00)], [0, 0, 0]);
  assert.strictEqual(uuidStr(Buffer.from('0123456789abcdef0123456789abcdef', 'hex')), '01234567-89ab-cdef-0123-456789abcdef');
});

test('ari routing helpers', () => {
  process.env.DEFAULT_COUNTRY_CODE = '1';
  process.env.NATIONAL_NUMBER_LENGTH = '10';
  assert.strictEqual(normalizePhone('+1 555 010 0100'), '15550100100');
  assert.strictEqual(normalizePhone('0015550100100'), '15550100100');
  assert.strictEqual(normalizePhone('555 010 0100'), '15550100100');
  assert.strictEqual(operatorDialTarget({ sipExtension: '201' }), 'Local/201@internal');
  assert.strictEqual(operatorDialTarget({ externalPhone: '+1 555 010 0100' }), 'Local/15550100100@outbound');
  assert.strictEqual(operatorDialTarget({}), null);
});

test('example agents load and build instructions', async () => {
  for (const p of ['../examples/pottery-studio', '../examples/minimal', '../examples/http-backend']) {
    const agent = require(p);
    assert.strictEqual(typeof agent.instructions, 'function', p);
  }
  const pottery = require('../examples/pottery-studio');
  const text = await pottery.instructions({});
  assert.match(text, /Maple Street Pottery/);
  assert(text.length < 45000);
  assert.deepStrictEqual(await pottery.lookupCaller('+1 (555) 0100'), { name: 'Jane Example', email: 'jane@example.com', phone: '+1 555 0100' });
  assert.strictEqual(await pottery.lookupCaller('+1 555 9999'), null);
  const call = { facts: {} };
  const notes = await pottery.onTranscript('it is one zero zero two three four', call);
  assert.strictEqual(call.facts.orderNumber, '100234');
  assert.match(notes[0], /Order found/);
  assert.deepStrictEqual(await pottery.onTranscript('hello', { facts: {} }), []);
});
