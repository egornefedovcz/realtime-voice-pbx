// Keyboard typing sound (µ-law 8 kHz) played while the agent "looks up" a
// number the caller just dictated. Fully synthetic — no audio file, no licence.
// A click is a short damped noise burst; gaps imitate fast number typing.
const { linearToUlaw } = require('./audio');

const RATE = 8000;

// Deterministic generator so it sounds the same every time
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function buildTypingClip(seconds = 1.6) {
  const rand = rng(42);
  const pcm = new Int16Array(Math.round(seconds * RATE));
  let t = Math.round(0.05 * RATE);
  while (t < pcm.length) {
    const len = Math.round((0.008 + rand() * 0.01) * RATE);   // click 8–18 ms
    const amp = 2500 + rand() * 2500;                          // quiet, must not drown the line
    for (let i = 0; i < len && t + i < pcm.length; i++) {
      const env = Math.exp(-i / (len / 4));                    // fast decay
      pcm[t + i] = Math.round((rand() * 2 - 1) * amp * env);
    }
    // 70–220 ms between keys, occasionally a longer pause
    const gap = rand() < 0.15 ? 0.35 + rand() * 0.25 : 0.07 + rand() * 0.15;
    t += len + Math.round(gap * RATE);
  }
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToUlaw(pcm[i]);
  return out;
}

const TYPING_CLIP = buildTypingClip();

module.exports = { TYPING_CLIP, buildTypingClip };
