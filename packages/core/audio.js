// G.711 µ-law <-> 16-bit signed little-endian PCM (8 kHz mono).
// OpenAI Realtime speaks µ-law natively ('audio/pcmu'), so transports that
// deliver linear PCM (Yeastar, Asterisk AudioSocket) convert at the edge.

function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const ULAW_TO_LINEAR = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
  const s = (((mant << 3) + 0x84) << exp) - 0x84;
  ULAW_TO_LINEAR[i] = sign ? -s : s;
}

function pcm16ToUlaw(pcm) {
  const out = Buffer.alloc(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = linearToUlaw(pcm.readInt16LE(i * 2));
  return out;
}

function ulawToPcm16(ulaw) {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(ULAW_TO_LINEAR[ulaw[i]], i * 2);
  return out;
}

// Playback duration of a µ-law buffer at 8 kHz (1 byte = 1 sample).
const ulawDurationMs = (buf) => buf.length / 8;

module.exports = { linearToUlaw, pcm16ToUlaw, ulawToPcm16, ulawDurationMs };
