const test = require('node:test');
const assert = require('node:assert');
const { pcm16ToUlaw, ulawToPcm16, linearToUlaw } = require('../packages/core/audio');
const { isHallucination, wordsToDigits, extractDigits, countDigits, atWordStart, phoneKey } = require('../packages/core/text');
const { isWithinHours } = require('../packages/core/hours');
const { TYPING_CLIP } = require('../packages/core/typing');

test('µ-law round trip stays close', () => {
  const pcm = Buffer.alloc(2000);
  for (let i = 0; i < 1000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 12000), i * 2);
  const back = ulawToPcm16(pcm16ToUlaw(pcm));
  assert.strictEqual(back.length, pcm.length);
  for (let i = 0; i < 1000; i++) {
    const a = pcm.readInt16LE(i * 2), b = back.readInt16LE(i * 2);
    assert(Math.abs(a - b) <= Math.max(64, Math.abs(a) * 0.07), `sample ${i}: ${a} vs ${b}`);
  }
  assert.strictEqual(linearToUlaw(0), 0xff, 'silence encodes to 0xFF');
});

test('typing clip is µ-law of the expected length', () => {
  assert.strictEqual(TYPING_CLIP.length, 1.6 * 8000);
});

test('hallucination filter', () => {
  assert(isHallucination('Titulky vytvořil JohnyX'));
  assert(isHallucination('Thanks for watching!'));
  assert(!isHallucination('I would like to move my booking'));
  assert(isHallucination('foo bar baz', ['bar']));
});

test('spoken digits', () => {
  assert.strictEqual(wordsToDigits('one two three'), '1 2 3');
  assert.strictEqual(extractDigits('my order is one 0 zero two, three four'), '100234');
  assert.strictEqual(extractDigits('jedna nula nula dva tři čtyři'), '100234');
  assert.strictEqual(countDigits('order 12 three four'), 4);
});

test('atWordStart and phoneKey', () => {
  assert(!atWordStart('a drink please', 'ink'));
  assert(atWordStart('ink art', 'ink'));
  assert.strictEqual(phoneKey('+1 (555) 010-0123'), '550100123');
});

test('isWithinHours', () => {
  const mondayNoonUtc = new Date('2026-11-02T12:00:00Z');
  assert(isWithinHours({ timeZone: 'UTC', days: [1], from: 9, to: 17 }, mondayNoonUtc));
  assert(!isWithinHours({ timeZone: 'UTC', days: [1], from: 13, to: 17 }, mondayNoonUtc));
  assert(!isWithinHours({ timeZone: 'UTC', days: [0, 6], from: 0, to: 24 }, mondayNoonUtc));
});
