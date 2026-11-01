// Shared configuration. Loads .env from ENV_FILE or the current working directory.
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.resolve(process.cwd(), '.env') });

const str = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  str,
  num,
  OPENAI_API_KEY: str('OPENAI_API_KEY'),
  REALTIME_MODEL: str('REALTIME_MODEL', 'gpt-realtime'),
  VOICE: str('VOICE', 'ash'),
  VOICE_SPEED: num('VOICE_SPEED', 1.1),
  TRANSCRIBE_MODEL: str('TRANSCRIBE_MODEL', 'gpt-4o-transcribe'),
  // ISO-639-1 hint for the caller transcript, e.g. 'cs'. Empty = auto-detect.
  TRANSCRIBE_LANGUAGE: str('TRANSCRIBE_LANGUAGE'),
  VAD_THRESHOLD: num('VAD_THRESHOLD', 0.5),
  VAD_PREFIX_MS: num('VAD_PREFIX_MS', 300),
  VAD_SILENCE_MS: num('VAD_SILENCE_MS', 900),
  MAX_CALL_SECONDS: num('MAX_CALL_SECONDS', 900),
  SUMMARY_MODEL: str('SUMMARY_MODEL', 'gpt-4o'),
};
