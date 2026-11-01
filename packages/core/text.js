// Small text helpers for phone transcripts.

// Known speech-to-text hallucinations on silence or line noise. Whisper-family
// models were trained on subtitled video and sometimes "hear" subtitle credits.
// Matching transcripts are ignored (no reply is generated).
const DEFAULT_HALLUCINATIONS = [
  // Czech subtitle credits (very common on silent 8 kHz Czech audio)
  'titulky vytvořil johny',
  'titulky vytvořil',
  'johnyxcz',
  // English
  'thanks for watching',
  'thank you for watching',
  'subtitles by the amara.org community',
  'please subscribe',
];

function isHallucination(transcript, extra = []) {
  const t = String(transcript || '').toLowerCase();
  return [...DEFAULT_HALLUCINATIONS, ...extra].some((g) => t.includes(String(g).toLowerCase()));
}

// Spoken digit words (English + Czech) -> digits. Speech-to-text often writes
// "two four seven" instead of "247" when a caller dictates a number.
const DIGIT_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  nula: '0', jedna: '1', dva: '2', 'dvě': '2', dve: '2', 'tři': '3', tri: '3', 'čtyři': '4', ctyri: '4',
  'pět': '5', pet: '5', 'šest': '6', sest: '6', sedm: '7', osm: '8', 'devět': '9', devet: '9',
};

function wordsToDigits(text) {
  return String(text || '').toLowerCase().split(/[\s,.\-;:!?]+/).map((w) => DIGIT_WORDS[w] || w).join(' ');
}

// All digits in the transcript, with spoken digit words converted first.
const extractDigits = (text) => wordsToDigits(text).replace(/\D/g, '');

// Number of digits (numerals or digit words) — used to decide whether the
// caller is dictating something (order number, phone number).
function countDigits(text) {
  const words = String(text || '').toLowerCase().split(/[\s,.\-;:!?]+/).filter((w) => DIGIT_WORDS[w]).length;
  return (String(text || '').match(/\d/g) || []).length + words;
}

// Keyword match only at the start of a word ('drink' does not contain 'ink').
function atWordStart(text, kw) {
  let i = text.indexOf(kw);
  while (i !== -1) {
    if (i === 0 || !/\p{L}/u.test(text[i - 1])) return true;
    i = text.indexOf(kw, i + 1);
  }
  return false;
}

// Last 9 digits of a phone number — a pragmatic key for matching numbers that
// arrive as +CCNNN…, 00CCNNN… or a national format.
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-9);

module.exports = { DEFAULT_HALLUCINATIONS, isHallucination, wordsToDigits, extractDigits, countDigits, atWordStart, phoneKey };
